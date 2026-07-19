import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  BackendStructuralShift,
  ReadFreezeConfigRequest,
  ReadFreezeConfigResult,
  SetFreezeConfigRequest,
  BackendMutationResult,
  ViewportFreezeConfig,
} from '../backend/types'
import {
  nextHistoryTransactionId,
  pushHistoryAtom,
  registerHistoryLocalReplayApplier,
} from '../history'
import type { SetViewportFreezeInput, ViewportFreezeState } from './types'

// Freeze panes are UI-core canonical (CANONICAL_OWNERSHIP flip step 1).
// The local per-sheet state below is the source of truth; the backend
// `readFreezeConfig` / `setFreezeConfig` ports degrade to an optional
// persistence hook (one-shot hydration seed + fire-and-forget write
// mirror). No ACK lifecycle, no authority ticket: a freeze command
// commits synchronously and works with backends that expose no freeze
// port at all.

export const DEFAULT_VIEWPORT_FREEZE_STATE: ViewportFreezeState = {
  rowsBySheet: {},
  colsBySheet: {},
}

/** History local-replay applier key for freeze entries. */
export const VIEWPORT_FREEZE_REPLAY_KEY = 'viewport.freeze'

/** Session-local revision label for local-replay freeze history entries. */
const VIEWPORT_FREEZE_LOCAL_REVISION = 'local'

const viewportFreezeBackingAtom = atom<ViewportFreezeState>(DEFAULT_VIEWPORT_FREEZE_STATE)
viewportFreezeBackingAtom.debugLabel = 'spreadsheet.viewport.freezeBacking'

/** Read-only projection of the UI-core canonical freeze state. Mutate via `setFreezeConfigAtom`. */
export const viewportFreezeAtom: Atom<ViewportFreezeState> = atom((get) =>
  get(viewportFreezeBackingAtom),
)
viewportFreezeAtom.debugLabel = 'spreadsheet.viewport.freeze'

// Sheets that are locally owned: either seeded once from the persistence
// hook or written by a local command. A late hydration result must never
// clobber a locally owned sheet. Bounded by the sheet count, same as the
// freeze maps themselves.
const viewportFreezeSeededSheetsAtom = atom<ReadonlySet<string>>(new Set<string>())
viewportFreezeSeededSheetsAtom.debugLabel = 'spreadsheet.viewport.freezeSeededSheets'

export interface ViewportFreezeDiagnostic {
  readonly kind: 'persist-failed' | 'hydrate-failed'
  readonly sheetId: string
  readonly message: string
}

const viewportFreezeDiagnosticBackingAtom = atom<ViewportFreezeDiagnostic | null>(null)
viewportFreezeDiagnosticBackingAtom.debugLabel = 'spreadsheet.viewport.freezeDiagnosticBacking'

/** Read-only projection of the last persistence-hook failure. Local state is never rolled back. */
export const viewportFreezeDiagnosticAtom: Atom<ViewportFreezeDiagnostic | null> = atom((get) =>
  get(viewportFreezeDiagnosticBackingAtom),
)
viewportFreezeDiagnosticAtom.debugLabel = 'spreadsheet.viewport.freezeDiagnostic'

/** Optional persistence hook. Absence of either method never degrades the feature. */
export interface ViewportFreezePersistencePort {
  readFreezeConfig?: (request: ReadFreezeConfigRequest) => Promise<ReadFreezeConfigResult>
  setFreezeConfig?: (request: SetFreezeConfigRequest) => Promise<BackendMutationResult>
}

export interface SetFreezeConfigCommandInput extends SetViewportFreezeInput {
  /**
   * Optional persistence hook. When present, the committed config is
   * mirrored fire-and-forget; a failure records a diagnostic and never
   * rolls back the local canonical state.
   */
  readonly source?: ViewportFreezePersistencePort
}

export type SetFreezeConfigOutcome = 'committed' | 'unchanged' | 'invalid'

export interface HydrateViewportFreezeInput {
  readonly sheetId: string
  readonly source: ViewportFreezePersistencePort
}

export type HydrateViewportFreezeOutcome = 'hydrated' | 'skipped' | 'unsupported' | 'error'

export interface ApplyViewportFreezeStructuralShiftInput {
  readonly sheetId: string
  readonly shift: BackendStructuralShift
}

function isFreezeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function snapshotFreezeConfig(value: unknown): Readonly<ViewportFreezeConfig> | null {
  if (typeof value !== 'object' || value === null) return null
  const freeze = value as Partial<ViewportFreezeConfig>
  return isFreezeCount(freeze.rows) && isFreezeCount(freeze.cols)
    ? Object.freeze({ rows: freeze.rows, cols: freeze.cols })
    : null
}

function sheetFreeze(
  state: ViewportFreezeState,
  sheetId: string,
): Readonly<ViewportFreezeConfig> | null {
  const rows = state.rowsBySheet[sheetId]
  const cols = state.colsBySheet[sheetId]
  if (rows === undefined && cols === undefined) return null
  return Object.freeze({ rows: rows ?? 0, cols: cols ?? 0 })
}

function writeSheetFreeze(
  set: Setter,
  state: ViewportFreezeState,
  sheetId: string,
  freeze: Readonly<ViewportFreezeConfig>,
) {
  set(viewportFreezeBackingAtom, {
    rowsBySheet: { ...state.rowsBySheet, [sheetId]: freeze.rows },
    colsBySheet: { ...state.colsBySheet, [sheetId]: freeze.cols },
  })
}

function removeSheetFreeze(set: Setter, state: ViewportFreezeState, sheetId: string) {
  const rowsBySheet = { ...state.rowsBySheet }
  const colsBySheet = { ...state.colsBySheet }
  delete rowsBySheet[sheetId]
  delete colsBySheet[sheetId]
  set(viewportFreezeBackingAtom, { rowsBySheet, colsBySheet })
}

function markViewportFreezeSeeded(get: Getter, set: Setter, sheetId: string) {
  const seeded = get(viewportFreezeSeededSheetsAtom)
  if (seeded.has(sheetId)) return
  const next = new Set(seeded)
  next.add(sheetId)
  set(viewportFreezeSeededSheetsAtom, next)
}

function freezeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown transport failure.'
}

function persistFreezeConfig(
  set: Setter,
  source: unknown,
  sheetId: string,
  freeze: Readonly<ViewportFreezeConfig>,
) {
  if (typeof source !== 'object' || source === null) return
  const persist = (source as ViewportFreezePersistencePort).setFreezeConfig
  if (typeof persist !== 'function') return
  const recordFailure = (error: unknown) => {
    set(viewportFreezeDiagnosticBackingAtom, {
      kind: 'persist-failed',
      sheetId,
      message: freezeErrorMessage(error),
    })
  }
  try {
    void persist
      .call(source, {
        kind: 'set-freeze-config',
        sheetId,
        freeze: { rows: freeze.rows, cols: freeze.cols },
      } satisfies SetFreezeConfigRequest)
      .catch(recordFailure)
  } catch (error) {
    recordFailure(error)
  }
}

/**
 * Command: set the canonical freeze config for a sheet. Writes local
 * state synchronously, records a local-replay history entry, and mirrors
 * the result into the optional persistence hook. Invalid and no-op
 * inputs never create history.
 */
export const setFreezeConfigAtom = atom(
  null,
  (get, set, input: SetFreezeConfigCommandInput): SetFreezeConfigOutcome => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    const hasRows = input?.rows !== undefined
    const hasCols = input?.cols !== undefined
    if (
      !sheetId ||
      (!hasRows && !hasCols) ||
      (hasRows && !isFreezeCount(input.rows)) ||
      (hasCols && !isFreezeCount(input.cols))
    ) {
      return 'invalid'
    }

    const state = get(viewportFreezeBackingAtom)
    const before = sheetFreeze(state, sheetId)
    const after: Readonly<ViewportFreezeConfig> = Object.freeze({
      rows: hasRows ? input.rows! : (before?.rows ?? 0),
      cols: hasCols ? input.cols! : (before?.cols ?? 0),
    })
    // Any local command claims the sheet — a late hydration seed must not clobber it.
    markViewportFreezeSeeded(get, set, sheetId)
    if (
      (before !== null && before.rows === after.rows && before.cols === after.cols) ||
      (before === null && after.rows === 0 && after.cols === 0)
    ) {
      return 'unchanged'
    }

    writeSheetFreeze(set, state, sheetId, after)
    set(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId('freeze'),
      kind: 'viewport.freeze',
      sheetId,
      projectionRevision: VIEWPORT_FREEZE_LOCAL_REVISION,
      localReplay: {
        applyKey: VIEWPORT_FREEZE_REPLAY_KEY,
        sheetId,
        before,
        after,
      },
    })
    persistFreezeConfig(set, input.source, sheetId, after)
    return 'committed'
  },
)
setFreezeConfigAtom.debugLabel = 'spreadsheet.viewport.setFreezeConfig'

/**
 * One-shot seed from the optional persistence hook. Applies at most once
 * per sheet and never overwrites a sheet a local command already owns —
 * this is hydration, not authority.
 */
export const hydrateViewportFreezeAtom = atom(
  null,
  async (get, set, input: HydrateViewportFreezeInput): Promise<HydrateViewportFreezeOutcome> => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId) return 'error'
    const read = input.source?.readFreezeConfig
    if (typeof read !== 'function') return 'unsupported'
    if (get(viewportFreezeSeededSheetsAtom).has(sheetId)) return 'skipped'

    let result: unknown
    try {
      result = await read.call(input.source, {
        kind: 'read-freeze-config',
        sheetId,
      } satisfies ReadFreezeConfigRequest)
    } catch (error) {
      if (get(viewportFreezeSeededSheetsAtom).has(sheetId)) return 'skipped'
      set(viewportFreezeDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: freezeErrorMessage(error),
      })
      return 'error'
    }
    // A local write while the read was in flight owns the sheet; discard the seed.
    if (get(viewportFreezeSeededSheetsAtom).has(sheetId)) return 'skipped'

    const payload = result as Partial<ReadFreezeConfigResult> | null | undefined
    const freeze = snapshotFreezeConfig(payload?.freeze)
    if (!freeze || payload?.sheetId !== sheetId) {
      set(viewportFreezeDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: 'Persistence hook returned an invalid freeze payload.',
      })
      return 'error'
    }

    markViewportFreezeSeeded(get, set, sheetId)
    writeSheetFreeze(set, get(viewportFreezeBackingAtom), sheetId, freeze)
    return 'hydrated'
  },
)
hydrateViewportFreezeAtom.debugLabel = 'spreadsheet.viewport.hydrateFreeze'

/**
 * Remaps the frozen leading band `[0, frozen)` across a structural shift
 * on the same axis. Mirrors the persistence-hook remap: inserting
 * strictly above/left of the freeze line grows the band, deleting
 * indices inside it shrinks it by the overlap, and operations at or past
 * the freeze line leave it untouched.
 */
export function remapFrozenLeadingBand(frozen: number, shift: BackendStructuralShift): number {
  if (!isFreezeCount(frozen) || frozen <= 0) return isFreezeCount(frozen) ? frozen : 0
  if (
    !Number.isSafeInteger(shift.index) ||
    shift.index < 0 ||
    !Number.isSafeInteger(shift.count) ||
    shift.count <= 0 ||
    shift.index >= frozen
  ) {
    return frozen
  }
  return shift.kind === 'insert'
    ? frozen + shift.count
    : frozen - (Math.min(shift.index + shift.count, frozen) - shift.index)
}

/**
 * Command: consume a `BackendMutationResult.structuralShift` so the
 * local canonical freeze band moves with inserted/deleted rows/columns.
 * Part of the enclosing structural operation — records no history entry
 * of its own. Returns true when the freeze band actually moved.
 */
export const applyViewportFreezeStructuralShiftAtom = atom(
  null,
  (get, set, input: ApplyViewportFreezeStructuralShiftInput): boolean => {
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
    const state = get(viewportFreezeBackingAtom)
    const before = sheetFreeze(state, sheetId)
    if (!before) return false
    const frozen = shift.axis === 'row' ? before.rows : before.cols
    const remapped = remapFrozenLeadingBand(frozen, shift)
    if (remapped === frozen) return false
    const after: Readonly<ViewportFreezeConfig> =
      shift.axis === 'row'
        ? Object.freeze({ rows: remapped, cols: before.cols })
        : Object.freeze({ rows: before.rows, cols: remapped })
    writeSheetFreeze(set, state, sheetId, after)
    return true
  },
)
applyViewportFreezeStructuralShiftAtom.debugLabel = 'spreadsheet.viewport.applyFreezeShift'

registerHistoryLocalReplayApplier(
  VIEWPORT_FREEZE_REPLAY_KEY,
  (get, set, payload, direction, source) => {
    const sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : ''
    if (!sheetId) return false
    const target = direction === 'undo' ? payload.before : payload.after
    const config = target === null ? null : snapshotFreezeConfig(target)
    if (target !== null && config === null) return false

    markViewportFreezeSeeded(get, set, sheetId)
    const state = get(viewportFreezeBackingAtom)
    if (config === null) {
      removeSheetFreeze(set, state, sheetId)
    } else {
      writeSheetFreeze(set, state, sheetId, config)
    }
    persistFreezeConfig(set, source, sheetId, config ?? Object.freeze({ rows: 0, cols: 0 }))
    return true
  },
)
