import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  BackendMutationResult,
  BackendStructuralShift,
  HideColumnsRequest,
  HideRowsRequest,
  SetEvalHiddenRowsRequest,
  SheetHiddenStateRequest,
  SheetHiddenStateResult,
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

// Hidden ROWS are an ENGINE-owned fact since the hidden-row sink-down
// (design-engine-hidden-rows §4.2/§8): they change what SUBTOTAL 101-111
// evaluate, so the engine is their authoritative STORE. `sheetHiddenRowsAtom`
// below is UI core's render-time PROJECTION of that store — written
// optimistically for an instant visual, then UNCONDITIONALLY reconciled from
// the backend ACK (`readSheetHiddenState`) so a bounded optimistic window never
// decays into a silent permanent divergence (§4.3 disciplines).
//
// Hidden COLUMNS stay UI-core canonical (§8 — the engine models no hidden
// columns; SUBTOTAL filters on `addr.row` only). `viewportHiddenColsAtom` is
// the source of truth for them; the column commits stay synchronous and mirror
// into the optional `hideColumns` / `unhideColumns` ports fire-and-forget.
//
// The two axes are separate atoms precisely because their ownership differs:
// merging them would let a future refactor push hidden columns at the engine,
// which has nowhere to put them. `viewportHiddenAtom` is a COMPAT derived that
// synthesises the historic `{ rowsBySheet, colsBySheet }` shape from the two so
// the 15 unmigrated consumers keep reading it verbatim; new code must not
// write it.

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

// --- Split backing atoms (design-engine-hidden-rows §8) ---------------------

/** Engine-projection cache for manually hidden ROWS. Written on ACK, never canonical. */
const sheetHiddenRowsBackingAtom = atom<Record<string, number[]>>({})
sheetHiddenRowsBackingAtom.debugLabel = 'spreadsheet.viewport.hiddenRowsBacking'

/** UI-core canonical hidden COLUMNS. */
const viewportHiddenColsBackingAtom = atom<Record<string, number[]>>({})
viewportHiddenColsBackingAtom.debugLabel = 'spreadsheet.viewport.hiddenColsBacking'

/**
 * Per-sheet monotonic generation for the row reconcile. Bumped by every
 * optimistic write (command, structural shift, replay, hydrate); the async
 * reconcile records the generation it launched under and discards its
 * `readSheetHiddenState` answer if a newer write has since advanced it — the
 * existing `requestId`-style staleness guard (§4.3 discipline 2) so two rapid
 * hides, or a structural edit between a hide and its ACK, cannot flash the
 * view back to a stale engine snapshot.
 */
const hiddenRowsReconcileGenAtom = atom<Record<string, number>>({})
hiddenRowsReconcileGenAtom.debugLabel = 'spreadsheet.viewport.hiddenRowsReconcileGen'

function bumpRowReconcileGen(get: Getter, set: Setter, sheetId: string): number {
  const gens = get(hiddenRowsReconcileGenAtom)
  const next = (gens[sheetId] ?? 0) + 1
  set(hiddenRowsReconcileGenAtom, { ...gens, [sheetId]: next })
  return next
}

function currentRowReconcileGen(get: Getter, sheetId: string): number {
  return get(hiddenRowsReconcileGenAtom)[sheetId] ?? 0
}

/** Read-only projection of the engine-owned hidden ROW sets. Mutate via the row commands. */
export const sheetHiddenRowsAtom: Atom<Record<string, number[]>> = atom((get) =>
  get(sheetHiddenRowsBackingAtom),
)
sheetHiddenRowsAtom.debugLabel = 'spreadsheet.viewport.hiddenRows'

/** Read-only projection of the UI-core canonical hidden COLUMN sets. Mutate via column commands. */
export const viewportHiddenColsAtom: Atom<Record<string, number[]>> = atom((get) =>
  get(viewportHiddenColsBackingAtom),
)
viewportHiddenColsAtom.debugLabel = 'spreadsheet.viewport.hiddenCols'

/**
 * COMPAT derived: synthesises the historic `{ rowsBySheet, colsBySheet }`
 * shape from the two axis atoms so unmigrated consumers read it unchanged.
 * Every sheet touched on either axis appears in BOTH maps (an absent axis is
 * an empty array), which reproduces the pre-split state object byte-for-byte.
 * Read-only — mutate via the hide/unhide commands. New code must not write it.
 */
export const viewportHiddenAtom: Atom<ViewportHiddenState> = atom((get) => {
  const rows = get(sheetHiddenRowsBackingAtom)
  const cols = get(viewportHiddenColsBackingAtom)
  const sheetIds = new Set<string>([...Object.keys(rows), ...Object.keys(cols)])
  const rowsBySheet: Record<string, number[]> = {}
  const colsBySheet: Record<string, number[]> = {}
  for (const sheetId of sheetIds) {
    rowsBySheet[sheetId] = rows[sheetId] ?? []
    colsBySheet[sheetId] = cols[sheetId] ?? []
  }
  return { rowsBySheet, colsBySheet }
})
viewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hidden'

// Sheets that are locally owned: either seeded once from the persistence
// hook or written by a local command. A late hydration seed must never
// clobber a locally owned sheet. Bounded by the sheet count.
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

/**
 * Optional persistence / engine hook. Absence of any method never degrades the
 * feature.
 *
 * Manually hidden ROWS reach the engine, which owns the set, through whichever
 * of three feeds the backend supports — see `feedAndReconcileHiddenRows` for
 * the dispatch. `hideRows` / `unhideRows` send only the delta and are the
 * preferred pair; `setEvalHiddenRows` whole-set-replaces and stands in for
 * backends predating those ports; a backend with none of the three degrades to
 * a fire-and-forget mirror with no engine round-trip.
 *
 * `readSheetHiddenState` is the reconcile read-back and is orthogonal to which
 * feed ran: with it the row commands are optimistic-then-reconciled and the
 * engine's answer always wins, without it the feed alone keeps the engine in
 * step.
 */
export interface ViewportHiddenPersistencePort {
  readViewportSizeProjection?: (
    request: ViewportSizeProjectionRequest,
  ) => Promise<ViewportSizeProjectionResult>
  readSheetHiddenState?: (request: SheetHiddenStateRequest) => Promise<SheetHiddenStateResult>
  setEvalHiddenRows?: (request: SetEvalHiddenRowsRequest) => Promise<void> | void
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
   * Optional persistence / engine hook. When it exposes `readSheetHiddenState`
   * the committed row delta is reconciled against the engine's authoritative
   * set; otherwise the committed delta is mirrored fire-and-forget. A failure
   * records a diagnostic and never rolls back the local projection.
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

function getSheetRows(get: Getter, sheetId: string): number[] {
  return get(sheetHiddenRowsBackingAtom)[sheetId] ?? []
}

function getSheetCols(get: Getter, sheetId: string): number[] {
  return get(viewportHiddenColsBackingAtom)[sheetId] ?? []
}

/** Optimistic ROW write: replaces the sheet's row set and bumps the reconcile generation. */
function writeSheetRowsOptimistic(
  get: Getter,
  set: Setter,
  sheetId: string,
  rows: readonly number[],
) {
  const state = get(sheetHiddenRowsBackingAtom)
  set(sheetHiddenRowsBackingAtom, { ...state, [sheetId]: [...rows] })
  bumpRowReconcileGen(get, set, sheetId)
}

/**
 * Reconcile ROW write: replaces the sheet's row set with the engine's
 * authoritative answer. UNCONDITIONAL (§4.3 discipline 1) — it always writes,
 * even when the value equals the optimistic one, so the projection can never
 * silently drift from the store; it deliberately does NOT bump the reconcile
 * generation (it is the settle, not a new intent).
 */
function writeSheetRowsReconcile(
  get: Getter,
  set: Setter,
  sheetId: string,
  rows: readonly number[],
) {
  const state = get(sheetHiddenRowsBackingAtom)
  set(sheetHiddenRowsBackingAtom, { ...state, [sheetId]: [...rows] })
}

/** Column write (UI-core canonical). */
function writeSheetCols(get: Getter, set: Setter, sheetId: string, cols: readonly number[]) {
  const state = get(viewportHiddenColsBackingAtom)
  set(viewportHiddenColsBackingAtom, { ...state, [sheetId]: [...cols] })
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

/**
 * Feed the engine's owned manual hidden-ROW set and reconcile the projection
 * (design-engine-hidden-rows §4.2/§4.3, followup P1 three-tier upgrade).
 *
 * Three-tier dispatch, tried in order:
 *
 * 1. **Incremental ACK** — when the backend exposes `hideRows` / `unhideRows`
 *    (both backends after followup P1), only the delta rows are sent.
 *    `readSheetHiddenState` is still called unconditionally to reconcile the
 *    engine's authoritative set into the UI-core projection.
 *
 * 2. **Whole-set push** — fallback when only `setEvalHiddenRows` is available
 *    (the pre-P1 worker had this but not `hideRows`). The entire set is
 *    pushed, then reconciled through `readSheetHiddenState` when present.
 *
 * 3. **Fire-and-forget mirror** — backends that expose neither engine feed
 *    (`hideRows` / `unhideRows` nor `setEvalHiddenRows`) degrade to a
 *    fire-and-forget delta mirror with no engine round-trip.
 *
 * A stale reconcile answer (a newer write advanced the generation) is dropped
 * rather than rolled back — the engine self-corrects through the same write
 * path on the next ACK.
 */
function feedAndReconcileHiddenRows(
  get: Getter,
  set: Setter,
  source: unknown,
  sheetId: string,
  wholeSet: readonly number[],
  added: readonly number[],
  removed: readonly number[],
  gen: number,
) {
  if (typeof source !== 'object' || source === null) return
  const port = source as ViewportHiddenPersistencePort
  const recordFailure = (error: unknown) => {
    set(viewportHiddenDiagnosticBackingAtom, {
      kind: 'persist-failed',
      sheetId,
      message: hiddenErrorMessage(error),
    })
  }

  // Tier 1: incremental ACK write through hideRows / unhideRows ports
  // (the "zero push" endgame — design-engine-hidden-rows followup P1).
  // When both backends expose these, the engine receives only the delta
  // rows instead of a whole-set replacement; the unconditional reconcile
  // through readSheetHiddenState is STILL run to guarantee agreement.
  if (typeof port.hideRows === 'function' && typeof port.unhideRows === 'function') {
    void (async () => {
      try {
        if (added.length > 0) {
          await port.hideRows!({ kind: 'hide-rows', sheetId, rowIndices: [...added], requestId: gen })
        }
        if (removed.length > 0) {
          await port.unhideRows!({ kind: 'unhide-rows', sheetId, rowIndices: [...removed], requestId: gen })
        }
        if (typeof port.readSheetHiddenState !== 'function') return
        const result = await port.readSheetHiddenState({
          kind: 'sheet-hidden-state',
          sheetId,
          requestId: gen,
        })
        if (currentRowReconcileGen(get, sheetId) !== gen) return
        if (
          typeof result !== 'object' ||
          result === null ||
          result.sheetId !== sheetId ||
          !Array.isArray(result.manualRows)
        ) {
          return
        }
        writeSheetRowsReconcile(get, set, sheetId, sanitizeIndices(result.manualRows))
      } catch (error) {
        recordFailure(error)
      }
    })()
    return
  }

  // Tier 2: whole-set push via setEvalHiddenRows (fallback when the
  // incremental ACK ports above are not available — e.g. a pre-P1 backend
  // that has the eval input but not the owning hideRows/unhideRows ports).
  if (typeof port.setEvalHiddenRows !== 'function') {
    // Tier 3: fire-and-forget delta mirror — no engine feed at all.
    persistHiddenMutation(set, port, sheetId, 'hide-rows', added)
    persistHiddenMutation(set, port, sheetId, 'unhide-rows', removed)
    return
  }
  const pushEval = port.setEvalHiddenRows
  const readback = port.readSheetHiddenState
  void (async () => {
    try {
      await pushEval.call(port, { kind: 'set-eval-hidden-rows', sheetId, rows: [...wholeSet] })
      if (typeof readback !== 'function') return
      const result = await readback.call(port, {
        kind: 'sheet-hidden-state',
        sheetId,
        requestId: gen,
      })
      // Discard a stale ACK: a newer write (another hide, a structural shift, a
      // replay) has advanced the generation, so its own reconcile owns the set.
      if (currentRowReconcileGen(get, sheetId) !== gen) return
      if (
        typeof result !== 'object' ||
        result === null ||
        result.sheetId !== sheetId ||
        !Array.isArray(result.manualRows)
      ) {
        return
      }
      writeSheetRowsReconcile(get, set, sheetId, sanitizeIndices(result.manualRows))
    } catch (error) {
      recordFailure(error)
    }
  })()
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
  const current = axis === 'row' ? getSheetRows(get, sheetId) : getSheetCols(get, sheetId)
  // Any local command claims the sheet — a late hydration seed must not clobber it.
  markViewportHiddenSeeded(get, set, sheetId)

  const next =
    operation === 'hide'
      ? sanitizeIndices([...current, ...indices])
      : current.filter((index) => !indices.includes(index))
  if (sameIndices(current, next)) return 'unchanged'

  // Optimistic write — synchronous, so the grid repaints this tick.
  if (axis === 'row') writeSheetRowsOptimistic(get, set, sheetId, next)
  else writeSheetCols(get, set, sheetId, next)

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
  const delta = operation === 'hide' ? mutated : cleared

  if (axis === 'row') {
    // Feed the engine the whole optimistic set (§4.2) and reconcile from the
    // ACK. The generation was bumped by the optimistic write above.
    feedAndReconcileHiddenRows(
      get,
      set,
      input.source,
      sheetId,
      next,
      mutated,
      cleared,
      currentRowReconcileGen(get, sheetId),
    )
  } else {
    // Columns stay UI-core canonical (§8): mirror the delta fire-and-forget.
    persistHiddenMutation(
      set,
      input.source,
      sheetId,
      operation === 'hide' ? 'hide-columns' : 'unhide-columns',
      delta,
    )
  }
  return 'committed'
}

/** Command: hide rows (engine-owned projection). Optimistic commit; reconciles on ACK. */
export const hideRowsAtom = atom(
  null,
  (get, set, input: ViewportHiddenAxisCommandInput): ViewportHiddenCommandOutcome =>
    runViewportHiddenAxisCommand(get, set, 'row', 'hide', input),
)
hideRowsAtom.debugLabel = 'spreadsheet.viewport.hideRows'

/** Command: unhide rows (engine-owned projection). Optimistic commit; reconciles on ACK. */
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
 * selection against the local hidden state and returns the exact hidden
 * indices the selection covers on the requested axis, or null when the
 * selection cannot host the command at all.
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

  const canonical = selectsRows ? getSheetRows(get, sheetId) : getSheetCols(get, sheetId)
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
    writeSheetRowsOptimistic(get, set, sheetId, sanitizeIndices(payload.hiddenRowIndices))
    writeSheetCols(get, set, sheetId, sanitizeIndices(payload.hiddenColIndices))
    return 'hydrated'
  },
)
hydrateViewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hydrateHidden'

/**
 * Command: consume a `BackendMutationResult.structuralShift` so the local
 * hidden sets move with inserted/deleted rows/columns. Indices inside a
 * deleted band drop out. Part of the enclosing structural operation — records
 * no history entry of its own. Returns true when a set actually changed.
 *
 * The engine self-displaces its OWNED row set on the same shift, so this keeps
 * the render projection in step without a re-read; the bumped reconcile
 * generation drops any hide-ACK still in flight from before the shift.
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
    const current = shift.axis === 'row' ? getSheetRows(get, sheetId) : getSheetCols(get, sheetId)
    if (current.length === 0) return false
    const remapped = sanitizeIndices([
      ...remapIndexSetAfterStructuralShift(new Set(current), shift),
    ])
    if (sameIndices(current, remapped)) return false
    if (shift.axis === 'row') writeSheetRowsOptimistic(get, set, sheetId, remapped)
    else writeSheetCols(get, set, sheetId, remapped)
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

/**
 * Writes one absolute per-sheet hidden snapshot: validates the payload,
 * claims the sheet against a late hydration seed, replaces the canonical
 * set, and mirrors the resulting per-axis delta into the optional
 * persistence hook. Absent axes keep their current indices. Returns false
 * (writing nothing) when the sheet id or the payload is unusable.
 *
 * Records NO history entry — the CALLER owns the entry that replays this.
 *
 * This is the hidden module's write primitive for features that hide rows
 * or columns as a side effect of their own single-entry gesture (`outline`
 * collapse/expand) and for the manual-hide undo replay. When present, the
 * row axis mirrors its delta through the `hideRows` / `unhideRows` engine
 * ports (as before); the reconcile generation is bumped so a hide-ACK still
 * in flight cannot clobber the replayed set.
 */
export function applyViewportHiddenReplaySnapshot(
  get: Getter,
  set: Setter,
  sheetId: string,
  value: unknown,
  source?: unknown,
): boolean {
  if (!sheetId) return false
  const target = snapshotHiddenReplayTarget(value)
  if (target === null) return false

  markViewportHiddenSeeded(get, set, sheetId)
  const prevRows = getSheetRows(get, sheetId)
  const prevCols = getSheetCols(get, sheetId)
  const nextRows = target.rows ?? prevRows
  const nextCols = target.cols ?? prevCols
  if (target.rows !== undefined) {
    writeSheetRowsOptimistic(get, set, sheetId, nextRows)
    const prevRowSet = new Set(prevRows)
    const nextRowSet = new Set(nextRows)
    // Same engine feed + reconcile path the hide/unhide commands take, so an
    // outline collapse or a manual-hide undo replays into the engine (and its
    // SUBTOTAL 101-111) identically — not only into the local projection.
    feedAndReconcileHiddenRows(
      get,
      set,
      source,
      sheetId,
      nextRows,
      nextRows.filter((index) => !prevRowSet.has(index)),
      prevRows.filter((index) => !nextRowSet.has(index)),
      currentRowReconcileGen(get, sheetId),
    )
  }
  if (target.cols !== undefined) {
    writeSheetCols(get, set, sheetId, nextCols)
    persistHiddenAxisDelta(set, source, sheetId, 'column', prevCols, nextCols)
  }
  return true
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

registerHistoryLocalReplayApplier(
  VIEWPORT_HIDDEN_REPLAY_KEY,
  (get, set, payload, direction, source) =>
    applyViewportHiddenReplaySnapshot(
      get,
      set,
      typeof payload.sheetId === 'string' ? payload.sheetId : '',
      direction === 'undo' ? payload.before : payload.after,
      source,
    ),
)
