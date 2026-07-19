import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  BackendMutationResult,
  BackendStructuralShift,
  HideColumnsRequest,
  HideRowsRequest,
  UnhideColumnsRequest,
  UnhideRowsRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
} from '../backend/types'
import {
  nextHistoryTransactionId,
  pushHistoryAtom,
  registerHistoryLocalReplayApplier,
} from '../history'
import { selectionRegionsAtom, selectionSnapshotAtom } from '../selection'
import { remapIndexSetAfterStructuralShift } from './structural-remap'
import type { ViewportHiddenState } from './types'

// Hidden rows and columns are UI-core canonical (CANONICAL_OWNERSHIP flip
// step 2). The per-sheet full index sets below are the source of truth;
// the backend `hideRows` / `unhideRows` / `hideColumns` / `unhideColumns`
// ports degrade to a fire-and-forget persistence mirror, and the hidden
// slices of `readViewportSizeProjection` degrade to a one-shot hydration
// seed. No ACK lifecycle, no authority ticket, no windowed reconcile: a
// hide/unhide command commits synchronously and works with backends that
// expose no hidden port at all.

export const DEFAULT_VIEWPORT_HIDDEN_STATE: ViewportHiddenState = {
  rowsBySheet: {},
  colsBySheet: {},
}

/** History local-replay applier key for hidden rows/columns entries. */
export const VIEWPORT_HIDDEN_REPLAY_KEY = 'viewport.hidden'

/** Session-local revision label for local-replay hidden history entries. */
const VIEWPORT_HIDDEN_LOCAL_REVISION = 'local'

function sanitizeIndices(indices: readonly number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const value of indices) {
    if (Number.isSafeInteger(value) && value >= 0 && !seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  result.sort((a, b) => a - b)
  return result
}

function sameIndices(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, offset) => value === right[offset])
}

export function isRowHidden(
  state: ViewportHiddenState,
  sheetId: string,
  rowIndex: number,
): boolean {
  return (state.rowsBySheet[sheetId] ?? []).includes(rowIndex)
}

export function isColumnHidden(
  state: ViewportHiddenState,
  sheetId: string,
  colIndex: number,
): boolean {
  return (state.colsBySheet[sheetId] ?? []).includes(colIndex)
}

export function getHiddenRowsForSheet(state: ViewportHiddenState, sheetId: string): number[] {
  return state.rowsBySheet[sheetId] ?? []
}

export function getHiddenColumnsForSheet(state: ViewportHiddenState, sheetId: string): number[] {
  return state.colsBySheet[sheetId] ?? []
}

const viewportHiddenBackingAtom = atom<ViewportHiddenState>(DEFAULT_VIEWPORT_HIDDEN_STATE)
viewportHiddenBackingAtom.debugLabel = 'spreadsheet.viewport.hiddenBacking'

/** Read-only projection of the UI-core canonical hidden state. Mutate via hide/unhide commands. */
export const viewportHiddenAtom: Atom<ViewportHiddenState> = atom((get) =>
  get(viewportHiddenBackingAtom),
)
viewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hidden'

// Sheets that are locally owned: either seeded once from the persistence
// hook or written by a local command. A late hydration result must never
// clobber a locally owned sheet. Bounded by the sheet count, same as the
// hidden maps themselves.
const viewportHiddenSeededSheetsAtom = atom<ReadonlySet<string>>(new Set<string>())
viewportHiddenSeededSheetsAtom.debugLabel = 'spreadsheet.viewport.hiddenSeededSheets'

export interface ViewportHiddenDiagnostic {
  readonly kind: 'persist-failed' | 'hydrate-failed'
  readonly sheetId: string
  readonly message: string
}

const viewportHiddenDiagnosticBackingAtom = atom<ViewportHiddenDiagnostic | null>(null)
viewportHiddenDiagnosticBackingAtom.debugLabel = 'spreadsheet.viewport.hiddenDiagnosticBacking'

/** Read-only projection of the last persistence-hook failure. Local state is never rolled back. */
export const viewportHiddenDiagnosticAtom: Atom<ViewportHiddenDiagnostic | null> = atom((get) =>
  get(viewportHiddenDiagnosticBackingAtom),
)
viewportHiddenDiagnosticAtom.debugLabel = 'spreadsheet.viewport.hiddenDiagnostic'

/** Optional persistence hook. Absence of any method never degrades the feature. */
export interface ViewportHiddenPersistencePort {
  readViewportSizeProjection?: (
    request: ViewportSizeProjectionRequest,
  ) => Promise<ViewportSizeProjectionResult>
  hideRows?: (request: HideRowsRequest) => Promise<BackendMutationResult>
  unhideRows?: (request: UnhideRowsRequest) => Promise<BackendMutationResult>
  hideColumns?: (request: HideColumnsRequest) => Promise<BackendMutationResult>
  unhideColumns?: (request: UnhideColumnsRequest) => Promise<BackendMutationResult>
}

export type ViewportHiddenMutationAction =
  | 'hide-rows'
  | 'unhide-rows'
  | 'hide-columns'
  | 'unhide-columns'

export type ViewportHiddenCommandOutcome = 'committed' | 'unchanged' | 'invalid'

export interface ViewportHiddenAxisCommandInput {
  readonly sheetId: string
  readonly indices: readonly number[]
  /**
   * Optional persistence hook. When present, the committed delta is
   * mirrored fire-and-forget; a failure records a diagnostic and never
   * rolls back the local canonical state.
   */
  readonly source?: ViewportHiddenPersistencePort
}

export type ViewportHiddenSelectionAction = 'unhide-rows' | 'unhide-columns'

export interface UnhideViewportSelectionInput {
  readonly action: ViewportHiddenSelectionAction
  readonly source?: ViewportHiddenPersistencePort
}

export interface HydrateViewportHiddenInput {
  readonly sheetId: string
  readonly rowCount: number
  readonly colCount: number
  readonly source: ViewportHiddenPersistencePort
}

export type HydrateViewportHiddenOutcome = 'hydrated' | 'skipped' | 'unsupported' | 'error'

export interface ApplyViewportHiddenStructuralShiftInput {
  readonly sheetId: string
  readonly shift: BackendStructuralShift
}

/** Snapshot shape carried by hidden local-replay and structural side payloads. */
export interface ViewportHiddenReplaySnapshot {
  readonly rows?: readonly number[]
  readonly cols?: readonly number[]
}

function markViewportHiddenSeeded(get: Getter, set: Setter, sheetId: string) {
  const seeded = get(viewportHiddenSeededSheetsAtom)
  if (seeded.has(sheetId)) return
  const next = new Set(seeded)
  next.add(sheetId)
  set(viewportHiddenSeededSheetsAtom, next)
}

function hiddenErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown transport failure.'
}

function writeSheetHidden(
  set: Setter,
  state: ViewportHiddenState,
  sheetId: string,
  rows: readonly number[],
  cols: readonly number[],
) {
  set(viewportHiddenBackingAtom, {
    rowsBySheet: { ...state.rowsBySheet, [sheetId]: [...rows] },
    colsBySheet: { ...state.colsBySheet, [sheetId]: [...cols] },
  })
}

function persistHiddenMutation(
  set: Setter,
  source: unknown,
  sheetId: string,
  action: ViewportHiddenMutationAction,
  indices: readonly number[],
) {
  if (indices.length === 0 || typeof source !== 'object' || source === null) return
  const port = source as ViewportHiddenPersistencePort
  const recordFailure = (error: unknown) => {
    set(viewportHiddenDiagnosticBackingAtom, {
      kind: 'persist-failed',
      sheetId,
      message: hiddenErrorMessage(error),
    })
  }
  try {
    switch (action) {
      case 'hide-rows':
        if (typeof port.hideRows !== 'function') return
        void port.hideRows({ kind: 'hide-rows', sheetId, rowIndices: [...indices] }).catch(
          recordFailure,
        )
        return
      case 'unhide-rows':
        if (typeof port.unhideRows !== 'function') return
        void port.unhideRows({ kind: 'unhide-rows', sheetId, rowIndices: [...indices] }).catch(
          recordFailure,
        )
        return
      case 'hide-columns':
        if (typeof port.hideColumns !== 'function') return
        void port.hideColumns({ kind: 'hide-columns', sheetId, colIndices: [...indices] }).catch(
          recordFailure,
        )
        return
      case 'unhide-columns':
        if (typeof port.unhideColumns !== 'function') return
        void port
          .unhideColumns({ kind: 'unhide-columns', sheetId, colIndices: [...indices] })
          .catch(recordFailure)
        return
    }
  } catch (error) {
    recordFailure(error)
  }
}

/** Mirrors an absolute per-axis transition as hide/unhide deltas into the optional hook. */
function persistHiddenAxisDelta(
  set: Setter,
  source: unknown,
  sheetId: string,
  axis: 'row' | 'column',
  before: readonly number[],
  after: readonly number[],
) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter((index) => !beforeSet.has(index))
  const removed = before.filter((index) => !afterSet.has(index))
  persistHiddenMutation(set, source, sheetId, axis === 'row' ? 'hide-rows' : 'hide-columns', added)
  persistHiddenMutation(
    set,
    source,
    sheetId,
    axis === 'row' ? 'unhide-rows' : 'unhide-columns',
    removed,
  )
}

function runViewportHiddenAxisCommand(
  get: Getter,
  set: Setter,
  axis: 'row' | 'column',
  operation: 'hide' | 'unhide',
  input: ViewportHiddenAxisCommandInput,
): ViewportHiddenCommandOutcome {
  const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
  const rawIndices = input?.indices
  if (
    !sheetId ||
    !Array.isArray(rawIndices) ||
    rawIndices.length === 0 ||
    rawIndices.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    return 'invalid'
  }

  const indices = sanitizeIndices(rawIndices)
  const state = get(viewportHiddenBackingAtom)
  const rows = state.rowsBySheet[sheetId] ?? []
  const cols = state.colsBySheet[sheetId] ?? []
  const current = axis === 'row' ? rows : cols
  // Any local command claims the sheet — a late hydration seed must not clobber it.
  markViewportHiddenSeeded(get, set, sheetId)

  const next =
    operation === 'hide'
      ? sanitizeIndices([...current, ...indices])
      : current.filter((index) => !indices.includes(index))
  if (sameIndices(current, next)) return 'unchanged'

  const nextRows = axis === 'row' ? next : rows
  const nextCols = axis === 'column' ? next : cols
  writeSheetHidden(set, state, sheetId, nextRows, nextCols)
  const snapshotBefore: ViewportHiddenReplaySnapshot =
    axis === 'row' ? { rows: Object.freeze([...current]) } : { cols: Object.freeze([...current]) }
  const snapshotAfter: ViewportHiddenReplaySnapshot =
    axis === 'row' ? { rows: Object.freeze([...next]) } : { cols: Object.freeze([...next]) }
  set(pushHistoryAtom, {
    transactionId: nextHistoryTransactionId('hidden'),
    kind: 'viewport.hidden',
    sheetId,
    projectionRevision: VIEWPORT_HIDDEN_LOCAL_REVISION,
    localReplay: {
      applyKey: VIEWPORT_HIDDEN_REPLAY_KEY,
      sheetId,
      before: Object.freeze(snapshotBefore),
      after: Object.freeze(snapshotAfter),
    },
  })
  const mutated = operation === 'hide' ? indices.filter((index) => !current.includes(index)) : []
  const cleared = operation === 'unhide' ? current.filter((index) => !next.includes(index)) : []
  persistHiddenMutation(
    set,
    input.source,
    sheetId,
    axis === 'row'
      ? operation === 'hide'
        ? 'hide-rows'
        : 'unhide-rows'
      : operation === 'hide'
        ? 'hide-columns'
        : 'unhide-columns',
    operation === 'hide' ? mutated : cleared,
  )
  return 'committed'
}

/** Command: hide rows locally (UI-core canonical). Synchronous; records local-replay history. */
export const hideRowsAtom = atom(
  null,
  (get, set, input: ViewportHiddenAxisCommandInput): ViewportHiddenCommandOutcome =>
    runViewportHiddenAxisCommand(get, set, 'row', 'hide', input),
)
hideRowsAtom.debugLabel = 'spreadsheet.viewport.hideRows'

/** Command: unhide rows locally (UI-core canonical). Synchronous; records local-replay history. */
export const unhideRowsAtom = atom(
  null,
  (get, set, input: ViewportHiddenAxisCommandInput): ViewportHiddenCommandOutcome =>
    runViewportHiddenAxisCommand(get, set, 'row', 'unhide', input),
)
unhideRowsAtom.debugLabel = 'spreadsheet.viewport.unhideRows'

/** Command: hide columns locally (UI-core canonical). Synchronous; records local-replay history. */
export const hideColumnsAtom = atom(
  null,
  (get, set, input: ViewportHiddenAxisCommandInput): ViewportHiddenCommandOutcome =>
    runViewportHiddenAxisCommand(get, set, 'column', 'hide', input),
)
hideColumnsAtom.debugLabel = 'spreadsheet.viewport.hideColumns'

/** Command: unhide columns locally (UI-core canonical). Records local-replay history. */
export const unhideColumnsAtom = atom(
  null,
  (get, set, input: ViewportHiddenAxisCommandInput): ViewportHiddenCommandOutcome =>
    runViewportHiddenAxisCommand(get, set, 'column', 'unhide', input),
)
unhideColumnsAtom.debugLabel = 'spreadsheet.viewport.unhideColumns'

/**
 * Pure precheck shared by menu entries: resolves the current single-region
 * selection against the local canonical hidden state and returns the exact
 * hidden indices the selection covers on the requested axis, or null when
 * the selection cannot host the command at all.
 */
export function resolveViewportHiddenSelectionUnhide(
  get: Getter,
  action: ViewportHiddenSelectionAction,
): { sheetId: string; indices: number[] } | null {
  if (action !== 'unhide-rows' && action !== 'unhide-columns') return null
  const regions = get(selectionRegionsAtom)
  const snapshot = get(selectionSnapshotAtom)
  const sheetId = snapshot.selection.sheetId
  if (regions.length !== 1 || !sheetId || regions[0]?.sheetId !== sheetId) return null

  const selectsRows = action === 'unhide-rows'
  const start = selectsRows ? snapshot.range.rowStart : snapshot.range.colStart
  const end = selectsRows ? snapshot.range.rowEnd : snapshot.range.colEnd
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null
  }

  const hidden = get(viewportHiddenBackingAtom)
  const canonical = selectsRows
    ? (hidden.rowsBySheet[sheetId] ?? [])
    : (hidden.colsBySheet[sheetId] ?? [])
  return {
    sheetId,
    indices: canonical.filter((index) => index >= start && index <= end),
  }
}

/**
 * Command: unhide the selection∩hidden intersection on one axis. Local
 * view fact — always available; 'unchanged' when the selection covers no
 * hidden index, 'invalid' when the selection cannot host the command.
 */
export const unhideViewportSelectionAtom = atom(
  null,
  (get, set, input: UnhideViewportSelectionInput): ViewportHiddenCommandOutcome => {
    const resolution = resolveViewportHiddenSelectionUnhide(get, input?.action)
    if (resolution === null) return 'invalid'
    if (resolution.indices.length === 0) return 'unchanged'
    const axisInput: ViewportHiddenAxisCommandInput = {
      sheetId: resolution.sheetId,
      indices: resolution.indices,
      source: input.source,
    }
    return input.action === 'unhide-rows'
      ? set(unhideRowsAtom, axisInput)
      : set(unhideColumnsAtom, axisInput)
  },
)
unhideViewportSelectionAtom.debugLabel = 'spreadsheet.viewport.unhideSelection'

function isIndexArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((index) => Number.isSafeInteger(index) && index >= 0)
}

/**
 * One-shot seed from the optional persistence hook. Reads the full-sheet
 * hidden slices of `readViewportSizeProjection` at most once per sheet
 * and never overwrites a sheet a local command already owns — this is
 * hydration, not authority. Backends that omit the hidden slices report
 * 'unsupported' and the feature runs fully local.
 */
export const hydrateViewportHiddenAtom = atom(
  null,
  async (get, set, input: HydrateViewportHiddenInput): Promise<HydrateViewportHiddenOutcome> => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId) return 'error'
    const read = input.source?.readViewportSizeProjection
    if (typeof read !== 'function') return 'unsupported'
    if (get(viewportHiddenSeededSheetsAtom).has(sheetId)) return 'skipped'

    const rowCount = Math.max(1, Math.trunc(input.rowCount) || 1)
    const colCount = Math.max(1, Math.trunc(input.colCount) || 1)
    let result: unknown
    try {
      result = await read.call(input.source, {
        kind: 'viewport-size',
        sheetId,
        window: { rowStart: 0, rowEnd: rowCount - 1, colStart: 0, colEnd: colCount - 1 },
      } satisfies ViewportSizeProjectionRequest)
    } catch (error) {
      if (get(viewportHiddenSeededSheetsAtom).has(sheetId)) return 'skipped'
      set(viewportHiddenDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: hiddenErrorMessage(error),
      })
      return 'error'
    }
    // A local write while the read was in flight owns the sheet; discard the seed.
    if (get(viewportHiddenSeededSheetsAtom).has(sheetId)) return 'skipped'

    const payload = result as Partial<ViewportSizeProjectionResult> | null | undefined
    if (typeof payload !== 'object' || payload === null || payload.sheetId !== sheetId) {
      set(viewportHiddenDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: 'Persistence hook returned a mismatched viewport-size payload.',
      })
      return 'error'
    }
    const rowsAbsent = payload.hiddenRowIndices === undefined
    const colsAbsent = payload.hiddenColIndices === undefined
    if (rowsAbsent && colsAbsent) return 'unsupported'
    if (
      rowsAbsent !== colsAbsent ||
      !isIndexArray(payload.hiddenRowIndices) ||
      !isIndexArray(payload.hiddenColIndices)
    ) {
      set(viewportHiddenDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: 'Persistence hook returned invalid hidden index payloads.',
      })
      return 'error'
    }

    markViewportHiddenSeeded(get, set, sheetId)
    writeSheetHidden(
      set,
      get(viewportHiddenBackingAtom),
      sheetId,
      sanitizeIndices(payload.hiddenRowIndices),
      sanitizeIndices(payload.hiddenColIndices),
    )
    return 'hydrated'
  },
)
hydrateViewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hydrateHidden'

/**
 * Command: consume a `BackendMutationResult.structuralShift` so the local
 * canonical hidden sets move with inserted/deleted rows/columns. Indices
 * inside a deleted band drop out. Part of the enclosing structural
 * operation — records no history entry of its own. Returns true when a
 * set actually changed.
 */
export const applyViewportHiddenStructuralShiftAtom = atom(
  null,
  (get, set, input: ApplyViewportHiddenStructuralShiftInput): boolean => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    const shift = input?.shift
    if (
      !sheetId ||
      typeof shift !== 'object' ||
      shift === null ||
      (shift.axis !== 'row' && shift.axis !== 'column') ||
      (shift.kind !== 'insert' && shift.kind !== 'delete')
    ) {
      return false
    }
    const state = get(viewportHiddenBackingAtom)
    const rows = state.rowsBySheet[sheetId] ?? []
    const cols = state.colsBySheet[sheetId] ?? []
    const current = shift.axis === 'row' ? rows : cols
    if (current.length === 0) return false
    const remapped = sanitizeIndices([
      ...remapIndexSetAfterStructuralShift(new Set(current), shift),
    ])
    if (sameIndices(current, remapped)) return false
    writeSheetHidden(
      set,
      state,
      sheetId,
      shift.axis === 'row' ? remapped : rows,
      shift.axis === 'column' ? remapped : cols,
    )
    return true
  },
)
applyViewportHiddenStructuralShiftAtom.debugLabel = 'spreadsheet.viewport.applyHiddenShift'

function snapshotHiddenReplayTarget(value: unknown): ViewportHiddenReplaySnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const { rows, cols } = value as { rows?: unknown; cols?: unknown }
  if (rows === undefined && cols === undefined) return null
  if (rows !== undefined && !isIndexArray(rows)) return null
  if (cols !== undefined && !isIndexArray(cols)) return null
  return {
    ...(rows !== undefined ? { rows: sanitizeIndices(rows) } : {}),
    ...(cols !== undefined ? { cols: sanitizeIndices(cols) } : {}),
  }
}

registerHistoryLocalReplayApplier(
  VIEWPORT_HIDDEN_REPLAY_KEY,
  (get, set, payload, direction, source) => {
    const sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : ''
    if (!sheetId) return false
    const target = snapshotHiddenReplayTarget(direction === 'undo' ? payload.before : payload.after)
    if (target === null) return false

    markViewportHiddenSeeded(get, set, sheetId)
    const state = get(viewportHiddenBackingAtom)
    const prevRows = state.rowsBySheet[sheetId] ?? []
    const prevCols = state.colsBySheet[sheetId] ?? []
    const nextRows = target.rows ?? prevRows
    const nextCols = target.cols ?? prevCols
    writeSheetHidden(set, state, sheetId, nextRows, nextCols)
    persistHiddenAxisDelta(set, source, sheetId, 'row', prevRows, nextRows)
    persistHiddenAxisDelta(set, source, sheetId, 'column', prevCols, nextCols)
    return true
  },
)
