import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type { BackendMutationResult } from '../backend/types'
import type { CellCoord, CellRange } from '../shared'
import { selectionAtom, getActiveCell, getSelectionRange } from '../selection'
import type {
  ReadSheetProtectionRequest,
  ReadSheetProtectionResult,
  SetRangeLockRequest,
  SetSheetProtectionRequest,
  SheetProtectionBySheet,
  SheetProtectionState,
} from './types'

export * from './types'

// Sheet protection is UI-core canonical (CANONICAL_OWNERSHIP flip step 4,
// #40). Enforcement always lived on the UI side — the W2 mutation gateway
// (`editing/mutation-gateway.ts`) gates every content mutation through
// `isRangeFullyUnlocked` — and this module now also owns the protection
// configuration itself. The backend `setSheetProtection` / `setRangeLock`
// ports degrade to a fire-and-forget persistence mirror and
// `readSheetProtection` degrades to a one-shot hydration seed. No ACK
// lifecycle, no authority ticket, no revision witness: protect /
// unprotect / unlock commands commit synchronously and work with backends
// that expose no protection port at all.
//
// Protection changes are intentionally NOT recorded in undo history:
// Excel does not undo protect/unprotect or allow-edit-range changes, and
// an undoable unlock would re-lock cells behind the user's back. See
// README.md in this directory.
//
// Password semantics are unchanged from the pre-flip implementation:
// UI-core never stores or hashes a protection password. The unlock dialog
// holds the typed password transiently and hands it to the OPTIONAL host
// `verifySheetProtection` callback; when no verifier is supplied the
// unlock commits without a password check.

export const MAX_UNLOCKED_RANGES = 256

const DEFAULT_VERIFY_TIMEOUT_MS = 10_000
const OPERATION_TIMEOUT = Symbol('protection-operation-timeout')

const EMPTY_UNLOCKED_RANGES: readonly Readonly<CellRange>[] = Object.freeze([])

export const DEFAULT_SHEET_PROTECTION: SheetProtectionState = Object.freeze({
  mode: 'open',
  unlockedRanges: EMPTY_UNLOCKED_RANGES,
})

const EMPTY_SHEET_PROTECTION: SheetProtectionBySheet = Object.freeze({})

function snapshotRange(range: Readonly<CellRange>): Readonly<CellRange> {
  return Object.freeze({
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  })
}

/** Freeze a pre-validated protection state without retaining caller arrays. */
function snapshotProtectionState(state: SheetProtectionState): SheetProtectionState {
  return Object.freeze({
    mode: state.mode,
    unlockedRanges: Object.freeze(state.unlockedRanges.map((range) => snapshotRange(range))),
  })
}

// --- pure helpers ---

export function getSheetProtection(
  state: SheetProtectionBySheet,
  sheetId: string,
): SheetProtectionState {
  return Object.prototype.hasOwnProperty.call(state, sheetId)
    ? state[sheetId]
    : DEFAULT_SHEET_PROTECTION
}

export function rangesIntersect(a: Readonly<CellRange>, b: Readonly<CellRange>): boolean {
  return (
    a.rowStart <= b.rowEnd &&
    a.rowEnd >= b.rowStart &&
    a.colStart <= b.colEnd &&
    a.colEnd >= b.colStart
  )
}

export function isCoordUnlocked(
  state: SheetProtectionBySheet,
  sheetId: string,
  coord: CellCoord,
): boolean {
  const protection = getSheetProtection(state, sheetId)
  if (protection.mode === 'open') return true
  return protection.unlockedRanges.some(
    (range) =>
      coord.row >= range.rowStart &&
      coord.row <= range.rowEnd &&
      coord.col >= range.colStart &&
      coord.col <= range.colEnd,
  )
}

function intersectUnlockedRanges(
  unlockedRanges: readonly Readonly<CellRange>[],
  target: Readonly<CellRange>,
): readonly Readonly<CellRange>[] {
  const intersections: Readonly<CellRange>[] = []
  for (const candidate of unlockedRanges) {
    if (!isCellRange(candidate) || !rangesIntersect(candidate, target)) continue
    intersections.push({
      rowStart: Math.max(candidate.rowStart, target.rowStart),
      rowEnd: Math.min(candidate.rowEnd, target.rowEnd),
      colStart: Math.max(candidate.colStart, target.colStart),
      colEnd: Math.min(candidate.colEnd, target.colEnd),
    })
  }
  return intersections
}

function rowBandColumnsAreCovered(
  intersections: readonly Readonly<CellRange>[],
  target: Readonly<CellRange>,
  rowStart: number,
  rowEnd: number,
): boolean {
  const intervals = intersections
    .filter((candidate) => candidate.rowStart <= rowStart && candidate.rowEnd >= rowEnd)
    .map((candidate) => [candidate.colStart, candidate.colEnd] as const)
    .sort((first, second) => first[0] - second[0] || first[1] - second[1])

  let coveredThrough = target.colStart - 1
  for (const [colStart, colEnd] of intervals) {
    if (colStart > coveredThrough + 1) return false
    coveredThrough = Math.max(coveredThrough, colEnd)
    if (coveredThrough >= target.colEnd) return true
  }
  return false
}

/** True when every cell in range is covered by the union of unlockedRanges. */
export function isRangeFullyUnlocked(
  state: SheetProtectionBySheet,
  sheetId: string,
  range: Readonly<CellRange>,
): boolean {
  if (!isCellRange(range)) return false
  const protection = getSheetProtection(state, sheetId)
  if (protection.mode === 'open') return true
  if (protection.unlockedRanges.length === 0) return false

  const intersections = intersectUnlockedRanges(protection.unlockedRanges, range)
  if (intersections.length === 0) return false

  const rowBandStarts = new Set<number>([range.rowStart])
  for (const intersection of intersections) {
    rowBandStarts.add(intersection.rowStart)
    if (intersection.rowEnd < range.rowEnd) {
      rowBandStarts.add(intersection.rowEnd + 1)
    }
  }
  const sortedBandStarts = [...rowBandStarts].sort((first, second) => first - second)
  for (let index = 0; index < sortedBandStarts.length; index++) {
    const rowStart = sortedBandStarts[index]
    const nextBandStart = sortedBandStarts[index + 1]
    const rowEnd = nextBandStart === undefined ? range.rowEnd : nextBandStart - 1
    if (!rowBandColumnsAreCovered(intersections, range, rowStart, rowEnd)) return false
  }
  return true
}

/** True when a protected range contains both locked and unlocked cells. */
export function isRangePartiallyUnlocked(
  state: SheetProtectionBySheet,
  sheetId: string,
  range: Readonly<CellRange>,
): boolean {
  if (!isCellRange(range)) return false
  const protection = getSheetProtection(state, sheetId)
  if (protection.mode === 'open') return false
  const intersectsUnlockedRange = protection.unlockedRanges.some(
    (candidate) => isCellRange(candidate) && rangesIntersect(candidate, range),
  )
  return intersectsUnlockedRange && !isRangeFullyUnlocked(state, sheetId, range)
}

function isCellRange(value: unknown): value is CellRange {
  if (typeof value !== 'object' || value === null) return false
  const range = value as Partial<CellRange>
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    (range.rowStart ?? -1) >= 0 &&
    (range.colStart ?? -1) >= 0 &&
    (range.rowEnd ?? -1) >= (range.rowStart ?? 0) &&
    (range.colEnd ?? -1) >= (range.colStart ?? 0)
  )
}

function rangesEqual(first: Readonly<CellRange>, second: Readonly<CellRange>): boolean {
  return (
    first.rowStart === second.rowStart &&
    first.rowEnd === second.rowEnd &&
    first.colStart === second.colStart &&
    first.colEnd === second.colEnd
  )
}

function isValidProtectionState(value: unknown): value is SheetProtectionState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<SheetProtectionState>
  if (state.mode !== 'open' && state.mode !== 'protected') return false
  return (
    Array.isArray(state.unlockedRanges) &&
    state.unlockedRanges.length <= MAX_UNLOCKED_RANGES &&
    state.unlockedRanges.every(isCellRange)
  )
}

function protectionStatesEqual(first: SheetProtectionState, second: SheetProtectionState): boolean {
  return (
    first.mode === second.mode &&
    first.unlockedRanges.length === second.unlockedRanges.length &&
    first.unlockedRanges.every((range, index) => rangesEqual(range, second.unlockedRanges[index]))
  )
}

// --- canonical source state ---

const sheetProtectionSourceAtom = atom<SheetProtectionBySheet>(EMPTY_SHEET_PROTECTION)
sheetProtectionSourceAtom.debugLabel = 'spreadsheet.protection.source'

/** Read-only projection of the UI-core canonical protection state. Mutate via commands. */
export const sheetProtectionAtom: Atom<SheetProtectionBySheet> = atom((get) =>
  get(sheetProtectionSourceAtom),
)
sheetProtectionAtom.debugLabel = 'spreadsheet.protection.state'

// Sheets that are locally owned: either seeded once from the persistence
// hook or written by a local command. A late hydration result must never
// clobber a locally owned sheet. Bounded by the sheet count, same as the
// protection map itself.
const sheetProtectionSeededSheetsAtom = atom<ReadonlySet<string>>(new Set<string>())
sheetProtectionSeededSheetsAtom.debugLabel = 'spreadsheet.protection.seededSheets'

export interface SheetProtectionDiagnostic {
  readonly kind: 'persist-failed' | 'hydrate-failed'
  readonly sheetId: string
  readonly message: string
}

const sheetProtectionDiagnosticBackingAtom = atom<SheetProtectionDiagnostic | null>(null)
sheetProtectionDiagnosticBackingAtom.debugLabel = 'spreadsheet.protection.diagnosticBacking'

/** Read-only projection of the last persistence-hook failure. Local state is never rolled back. */
export const sheetProtectionDiagnosticAtom: Atom<SheetProtectionDiagnostic | null> = atom((get) =>
  get(sheetProtectionDiagnosticBackingAtom),
)
sheetProtectionDiagnosticAtom.debugLabel = 'spreadsheet.protection.diagnostic'

// --- persistence hook (optional; absence never degrades the feature) ---

export interface SheetProtectionPersistencePort {
  setSheetProtection?: (request: SetSheetProtectionRequest) => Promise<BackendMutationResult>
  setRangeLock?: (request: SetRangeLockRequest) => Promise<BackendMutationResult>
  readSheetProtection?: (request: ReadSheetProtectionRequest) => Promise<ReadSheetProtectionResult>
}

export type SheetProtectionCommandOutcome = 'committed' | 'unchanged' | 'invalid'

function markSheetProtectionSeeded(get: Getter, set: Setter, sheetId: string) {
  const seeded = get(sheetProtectionSeededSheetsAtom)
  if (seeded.has(sheetId)) return
  const next = new Set(seeded)
  next.add(sheetId)
  set(sheetProtectionSeededSheetsAtom, next)
}

function protectionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown transport failure.'
}

function writeSheetProtection(
  get: Getter,
  set: Setter,
  sheetId: string,
  state: SheetProtectionState,
): SheetProtectionState {
  const snapshot = snapshotProtectionState(state)
  set(
    sheetProtectionSourceAtom,
    Object.freeze({ ...get(sheetProtectionSourceAtom), [sheetId]: snapshot }),
  )
  return snapshot
}

/** Fire-and-forget full-state mirror into `setSheetProtection` when present. */
function persistProtectionState(
  set: Setter,
  source: unknown,
  sheetId: string,
  state: SheetProtectionState,
) {
  if (typeof source !== 'object' || source === null) return
  const persist = (source as SheetProtectionPersistencePort).setSheetProtection
  if (typeof persist !== 'function') return
  const recordFailure = (error: unknown) => {
    set(sheetProtectionDiagnosticBackingAtom, {
      kind: 'persist-failed',
      sheetId,
      message: protectionErrorMessage(error),
    })
  }
  try {
    void persist
      .call(source, {
        kind: 'set-sheet-protection',
        sheetId,
        mode: state.mode,
        unlockedRanges: state.unlockedRanges.map((range) => ({ ...range })),
      } satisfies SetSheetProtectionRequest)
      .catch(recordFailure)
  } catch (error) {
    recordFailure(error)
  }
}

/**
 * Fire-and-forget range-lock mirror. Prefers the granular `setRangeLock`
 * port; falls back to a full-state `setSheetProtection` mirror; silently
 * no-ops when the source exposes neither.
 */
function persistRangeLock(
  set: Setter,
  source: unknown,
  sheetId: string,
  range: Readonly<CellRange>,
  locked: boolean,
  fullState: SheetProtectionState,
) {
  if (typeof source !== 'object' || source === null) return
  const port = source as SheetProtectionPersistencePort
  if (typeof port.setRangeLock !== 'function') {
    persistProtectionState(set, source, sheetId, fullState)
    return
  }
  const recordFailure = (error: unknown) => {
    set(sheetProtectionDiagnosticBackingAtom, {
      kind: 'persist-failed',
      sheetId,
      message: protectionErrorMessage(error),
    })
  }
  try {
    void port.setRangeLock
      .call(source, {
        kind: 'set-range-lock',
        sheetId,
        range: { ...range },
        locked,
      } satisfies SetRangeLockRequest)
      .catch(recordFailure)
  } catch (error) {
    recordFailure(error)
  }
}

// --- commands (synchronous local commit; no undo history by design) ---

export interface SetSheetProtectionCommandInput {
  readonly sheetId: string
  readonly state: SheetProtectionState
  /** Optional persistence hook; a failure records a diagnostic and never rolls back. */
  readonly source?: SheetProtectionPersistencePort
}

export interface ClearSheetProtectionCommandInput {
  readonly sheetId: string
  readonly source?: SheetProtectionPersistencePort
}

export interface ProtectSheetCommandInput {
  readonly sheetId: string
  /** Replaces the sheet's unlocked ranges; existing ranges are preserved when omitted. */
  readonly unlockedRanges?: readonly Readonly<CellRange>[]
  readonly source?: SheetProtectionPersistencePort
}

export interface UnprotectSheetCommandInput {
  readonly sheetId: string
  readonly source?: SheetProtectionPersistencePort
}

export interface UnlockedRangeCommandInput {
  readonly sheetId: string
  readonly range: Readonly<CellRange>
  readonly source?: SheetProtectionPersistencePort
}

/** Command: replace the canonical protection state for a sheet. */
export const setSheetProtectionAtom = atom(
  null,
  (get, set, input: SetSheetProtectionCommandInput): SheetProtectionCommandOutcome => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId || !isValidProtectionState(input?.state)) return 'invalid'
    markSheetProtectionSeeded(get, set, sheetId)
    const state = get(sheetProtectionSourceAtom)
    const hasEntry = Object.prototype.hasOwnProperty.call(state, sheetId)
    const current = getSheetProtection(state, sheetId)
    if (protectionStatesEqual(current, input.state) && (hasEntry || input.state.mode === 'open')) {
      return 'unchanged'
    }
    const next = writeSheetProtection(get, set, sheetId, input.state)
    persistProtectionState(set, input.source, sheetId, next)
    return 'committed'
  },
)
setSheetProtectionAtom.debugLabel = 'spreadsheet.protection.set'

/** Command: remove the canonical protection entry for a sheet. */
export const clearSheetProtectionAtom = atom(
  null,
  (
    get,
    set,
    input: string | ClearSheetProtectionCommandInput,
  ): SheetProtectionCommandOutcome => {
    const sheetId =
      typeof input === 'string' ? input : typeof input?.sheetId === 'string' ? input.sheetId : ''
    const source = typeof input === 'string' ? undefined : input?.source
    if (!sheetId) return 'invalid'
    markSheetProtectionSeeded(get, set, sheetId)
    const state = get(sheetProtectionSourceAtom)
    if (!Object.prototype.hasOwnProperty.call(state, sheetId)) return 'unchanged'
    const next = { ...state }
    delete next[sheetId]
    set(sheetProtectionSourceAtom, Object.freeze(next))
    persistProtectionState(set, source, sheetId, DEFAULT_SHEET_PROTECTION)
    return 'committed'
  },
)
clearSheetProtectionAtom.debugLabel = 'spreadsheet.protection.clear'

/** Command: protect a sheet, preserving its unlocked ranges unless replaced. */
export const protectSheetAtom = atom(
  null,
  (get, set, input: ProtectSheetCommandInput): SheetProtectionCommandOutcome => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId) return 'invalid'
    const replacement = input?.unlockedRanges
    if (
      replacement !== undefined &&
      (!Array.isArray(replacement) ||
        replacement.length > MAX_UNLOCKED_RANGES ||
        !replacement.every(isCellRange))
    ) {
      return 'invalid'
    }
    markSheetProtectionSeeded(get, set, sheetId)
    const current = getSheetProtection(get(sheetProtectionSourceAtom), sheetId)
    const nextState: SheetProtectionState = {
      mode: 'protected',
      unlockedRanges: replacement ?? current.unlockedRanges,
    }
    if (current.mode === 'protected' && protectionStatesEqual(current, nextState)) {
      return 'unchanged'
    }
    const next = writeSheetProtection(get, set, sheetId, nextState)
    persistProtectionState(set, input.source, sheetId, next)
    return 'committed'
  },
)
protectSheetAtom.debugLabel = 'spreadsheet.protection.protectSheet'

/** Command: unprotect a sheet. Unlocked ranges are preserved for a later re-protect. */
export const unprotectSheetAtom = atom(
  null,
  (get, set, input: UnprotectSheetCommandInput): SheetProtectionCommandOutcome => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId) return 'invalid'
    markSheetProtectionSeeded(get, set, sheetId)
    const current = getSheetProtection(get(sheetProtectionSourceAtom), sheetId)
    if (current.mode === 'open') return 'unchanged'
    const next = writeSheetProtection(get, set, sheetId, {
      mode: 'open',
      unlockedRanges: current.unlockedRanges,
    })
    persistProtectionState(set, input.source, sheetId, next)
    return 'committed'
  },
)
unprotectSheetAtom.debugLabel = 'spreadsheet.protection.unprotectSheet'

function addUnlockedRange(
  get: Getter,
  set: Setter,
  input: UnlockedRangeCommandInput,
): SheetProtectionCommandOutcome {
  const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
  if (!sheetId || !isCellRange(input?.range)) return 'invalid'
  markSheetProtectionSeeded(get, set, sheetId)
  const state = get(sheetProtectionSourceAtom)
  // Already editable (open sheet or fully covered by existing ranges).
  if (isRangeFullyUnlocked(state, sheetId, input.range)) return 'unchanged'
  const current = getSheetProtection(state, sheetId)
  if (current.unlockedRanges.length >= MAX_UNLOCKED_RANGES) return 'invalid'
  const nextState: SheetProtectionState = {
    mode: current.mode,
    unlockedRanges: [...current.unlockedRanges, snapshotRange(input.range)],
  }
  const next = writeSheetProtection(get, set, sheetId, nextState)
  persistRangeLock(set, input.source, sheetId, input.range, false, next)
  return 'committed'
}

/**
 * Command: add an unlocked (allow-edit) range on a protected sheet.
 * 'unchanged' when the range is already editable; 'invalid' when the
 * 256-range cap is reached.
 */
export const addUnlockedRangeAtom = atom(
  null,
  (get, set, input: UnlockedRangeCommandInput): SheetProtectionCommandOutcome =>
    addUnlockedRange(get, set, input),
)
addUnlockedRangeAtom.debugLabel = 'spreadsheet.protection.addUnlockedRange'

/** Command: remove an exactly matching unlocked range. 'unchanged' when absent. */
export const removeUnlockedRangeAtom = atom(
  null,
  (get, set, input: UnlockedRangeCommandInput): SheetProtectionCommandOutcome => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId || !isCellRange(input?.range)) return 'invalid'
    markSheetProtectionSeeded(get, set, sheetId)
    const current = getSheetProtection(get(sheetProtectionSourceAtom), sheetId)
    const remaining = current.unlockedRanges.filter((range) => !rangesEqual(range, input.range))
    if (remaining.length === current.unlockedRanges.length) return 'unchanged'
    const next = writeSheetProtection(get, set, sheetId, {
      mode: current.mode,
      unlockedRanges: remaining,
    })
    persistRangeLock(set, input.source, sheetId, input.range, true, next)
    return 'committed'
  },
)
removeUnlockedRangeAtom.debugLabel = 'spreadsheet.protection.removeUnlockedRange'

// --- one-shot hydration seed ---

export interface HydrateSheetProtectionInput {
  readonly sheetId: string
  readonly source: SheetProtectionPersistencePort
}

export type HydrateSheetProtectionOutcome = 'hydrated' | 'skipped' | 'unsupported' | 'error'

let nextHydrateRequestId = 1

/**
 * One-shot seed from the optional persistence hook. Applies at most once
 * per sheet and never overwrites a sheet a local command already owns —
 * this is hydration, not authority.
 */
export const hydrateSheetProtectionAtom = atom(
  null,
  async (get, set, input: HydrateSheetProtectionInput): Promise<HydrateSheetProtectionOutcome> => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId) return 'error'
    const read = input.source?.readSheetProtection
    if (typeof read !== 'function') return 'unsupported'
    if (get(sheetProtectionSeededSheetsAtom).has(sheetId)) return 'skipped'

    let result: unknown
    try {
      result = await read.call(input.source, {
        kind: 'read-sheet-protection',
        sheetId,
        requestId: nextHydrateRequestId++,
      } satisfies ReadSheetProtectionRequest)
    } catch (error) {
      if (get(sheetProtectionSeededSheetsAtom).has(sheetId)) return 'skipped'
      set(sheetProtectionDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: protectionErrorMessage(error),
      })
      return 'error'
    }
    // A local write while the read was in flight owns the sheet; discard the seed.
    if (get(sheetProtectionSeededSheetsAtom).has(sheetId)) return 'skipped'

    const payload = result as Partial<ReadSheetProtectionResult> | null | undefined
    if (
      typeof payload !== 'object' ||
      payload === null ||
      payload.sheetId !== sheetId ||
      !isValidProtectionState(payload.protection)
    ) {
      set(sheetProtectionDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: 'Persistence hook returned an invalid protection payload.',
      })
      return 'error'
    }

    markSheetProtectionSeeded(get, set, sheetId)
    writeSheetProtection(get, set, sheetId, payload.protection)
    return 'hydrated'
  },
)
hydrateSheetProtectionAtom.debugLabel = 'spreadsheet.protection.hydrate'

// --- protection-derived selection state ---

export const activeCellLockedAtom = atom((get): boolean => {
  const selection = get(selectionAtom)
  const protection = get(sheetProtectionAtom)
  const sheetId = selection.sheetId
  if (getSheetProtection(protection, sheetId).mode === 'open') return false
  return !isCoordUnlocked(protection, sheetId, getActiveCell(selection))
})
activeCellLockedAtom.debugLabel = 'spreadsheet.protection.activeCellLocked'

export const selectionLockedAtom = atom((get): 'open' | 'locked' | 'partial' => {
  const selection = get(selectionAtom)
  const protection = get(sheetProtectionAtom)
  const sheetId = selection.sheetId
  if (getSheetProtection(protection, sheetId).mode === 'open') return 'open'
  const range = getSelectionRange(selection)
  if (isRangeFullyUnlocked(protection, sheetId, range)) return 'open'
  if (isRangePartiallyUnlocked(protection, sheetId, range)) return 'partial'
  return 'locked'
})
selectionLockedAtom.debugLabel = 'spreadsheet.protection.selectionLocked'

// --- unlock dialog session ---
//
// The unlock flow is a local session: open → (optional host password
// verification) → synchronous local commit of the target range as an
// unlocked range → close. There is no mutation ACK, no canonical
// refresh, and no recovery phase — the only asynchronous step is the
// optional host verifier, guarded by a session id so a verification that
// settles after close/reopen can never commit against a stale target.

export type ProtectionUnlockPhase = 'closed' | 'editing' | 'verifying'

export interface ProtectionUnlockTarget {
  readonly sheetId: string
  readonly range?: Readonly<CellRange>
}

export interface ProtectionUnlockState {
  readonly phase: ProtectionUnlockPhase
  readonly isOpen: boolean
  readonly target: ProtectionUnlockTarget | null
  readonly pending: boolean
  readonly error: string | null
  /** Always false since the UI-core canonical flip; kept for shape compatibility. */
  readonly recoveryRequired: boolean
}

export const DEFAULT_PROTECTION_UNLOCK_STATE: ProtectionUnlockState = Object.freeze({
  phase: 'closed',
  isOpen: false,
  target: null,
  pending: false,
  error: null,
  recoveryRequired: false,
})

export interface VerifySheetProtectionInput {
  readonly sheetId: string
  readonly range: Readonly<CellRange>
  readonly password: string
}

export interface VerifySheetProtectionResult {
  readonly ok: boolean
  readonly message?: string
}

export type VerifySheetProtectionPort = (
  input: VerifySheetProtectionInput,
) => Promise<VerifySheetProtectionResult>

export interface SubmitProtectionUnlockInput {
  /** Optional host password verifier. A rejection prevents the local commit. */
  readonly verifySheetProtection?: VerifySheetProtectionPort
  readonly verifyTimeoutMs?: number
  /** Optional persistence hook mirroring the committed unlock. */
  readonly source?: SheetProtectionPersistencePort
}

interface ProtectionUnlockMachine {
  readonly nextSessionId: number
  readonly sessionId: number
  readonly phase: ProtectionUnlockPhase
  readonly target: ProtectionUnlockTarget | null
  readonly password: string
  readonly error: string | null
}

const INITIAL_PROTECTION_UNLOCK_MACHINE: ProtectionUnlockMachine = {
  nextSessionId: 1,
  sessionId: 0,
  phase: 'closed',
  target: null,
  password: '',
  error: null,
}

const protectionUnlockMachineAtom = atom<ProtectionUnlockMachine>(INITIAL_PROTECTION_UNLOCK_MACHINE)
protectionUnlockMachineAtom.debugLabel = 'spreadsheet.protection.unlockMachine'

function snapshotTarget(target: ProtectionUnlockTarget): ProtectionUnlockTarget {
  return Object.freeze({
    sheetId: target.sheetId,
    range: target.range ? snapshotRange(target.range) : undefined,
  })
}

export const protectionUnlockStateAtom = atom((get): ProtectionUnlockState => {
  const machine = get(protectionUnlockMachineAtom)
  if (machine === INITIAL_PROTECTION_UNLOCK_MACHINE) return DEFAULT_PROTECTION_UNLOCK_STATE
  return Object.freeze({
    phase: machine.phase,
    isOpen: machine.phase !== 'closed',
    target: machine.target,
    pending: machine.phase === 'verifying',
    error: machine.error,
    recoveryRequired: false,
  })
})
protectionUnlockStateAtom.debugLabel = 'spreadsheet.protection.unlockState'

export const protectionUnlockPasswordAtom = atom(
  (get): string => get(protectionUnlockMachineAtom).password,
)
protectionUnlockPasswordAtom.debugLabel = 'spreadsheet.protection.unlockPassword'

export const protectionUnlockPhaseAtom = atom(
  (get): ProtectionUnlockPhase => get(protectionUnlockMachineAtom).phase,
)
protectionUnlockPhaseAtom.debugLabel = 'spreadsheet.protection.unlockPhase'

export const protectionUnlockOpenAtom = atom(
  (get): boolean => get(protectionUnlockMachineAtom).phase !== 'closed',
)
protectionUnlockOpenAtom.debugLabel = 'spreadsheet.protection.unlockOpen'

export const setProtectionUnlockPasswordAtom = atom(null, (get, set, password: string) => {
  const machine = get(protectionUnlockMachineAtom)
  if (machine.phase !== 'editing') return
  set(protectionUnlockMachineAtom, { ...machine, password })
})
setProtectionUnlockPasswordAtom.debugLabel = 'spreadsheet.protection.setUnlockPassword'

export const openProtectionUnlockAtom = atom(null, (get, set, input: ProtectionUnlockTarget) => {
  const machine = get(protectionUnlockMachineAtom)
  const sessionId = machine.nextSessionId
  set(protectionUnlockMachineAtom, {
    nextSessionId: sessionId + 1,
    sessionId,
    phase: 'editing',
    target: snapshotTarget(input),
    password: '',
    error: null,
  })
})
openProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.openUnlock'

export const closeProtectionUnlockAtom = atom(null, (get, set) => {
  const machine = get(protectionUnlockMachineAtom)
  const sessionId = machine.nextSessionId
  set(protectionUnlockMachineAtom, {
    nextSessionId: sessionId + 1,
    sessionId,
    phase: 'closed',
    target: null,
    password: '',
    error: null,
  })
})
closeProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.closeUnlock'

function setUnlockEditingError(set: Setter, error: string): void {
  set(protectionUnlockMachineAtom, (machine) => {
    if (machine.phase === 'closed') return machine
    return { ...machine, phase: 'editing', error }
  })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function verifyTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_VERIFY_TIMEOUT_MS
}

async function waitWithTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number | undefined,
): Promise<Value | typeof OPERATION_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof OPERATION_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(OPERATION_TIMEOUT), verifyTimeout(timeoutMs))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface ProtectionUnlockSession {
  readonly sessionId: number
  readonly target: ProtectionUnlockTarget & { readonly range: Readonly<CellRange> }
}

function unlockSessionIsCurrent(get: Getter, session: ProtectionUnlockSession): boolean {
  const machine = get(protectionUnlockMachineAtom)
  return machine.sessionId === session.sessionId && machine.phase === 'verifying'
}

function failUnlockVerification(
  get: Getter,
  set: Setter,
  session: ProtectionUnlockSession,
  error: string,
): void {
  if (!unlockSessionIsCurrent(get, session)) return
  set(protectionUnlockMachineAtom, (machine) => {
    if (machine.sessionId !== session.sessionId || machine.phase !== 'verifying') return machine
    return { ...machine, phase: 'editing', error }
  })
}

/**
 * Commit the unlock locally: add the target range to the sheet's unlocked
 * ranges and close the dialog. A cap violation keeps the dialog editing
 * with an error; 'unchanged' (already editable) still closes.
 */
function commitProtectionUnlock(
  get: Getter,
  set: Setter,
  target: ProtectionUnlockSession['target'],
  source: SheetProtectionPersistencePort | undefined,
): void {
  const outcome = addUnlockedRange(get, set, {
    sheetId: target.sheetId,
    range: target.range,
    source,
  })
  if (outcome === 'invalid') {
    setUnlockEditingError(
      set,
      `Cannot unlock more than ${MAX_UNLOCKED_RANGES} ranges on one sheet.`,
    )
    return
  }
  set(closeProtectionUnlockAtom)
}

async function runProtectionUnlockVerification(
  get: Getter,
  set: Setter,
  session: ProtectionUnlockSession,
  password: string,
  verify: VerifySheetProtectionPort,
  timeoutMs: number | undefined,
  source: SheetProtectionPersistencePort | undefined,
): Promise<void> {
  let verification: VerifySheetProtectionResult | typeof OPERATION_TIMEOUT
  try {
    verification = await waitWithTimeout(
      verify({
        sheetId: session.target.sheetId,
        range: session.target.range,
        password,
      }),
      timeoutMs,
    )
  } catch (error) {
    failUnlockVerification(
      get,
      set,
      session,
      errorMessage(error, 'Could not verify the protection password.'),
    )
    return
  }
  if (verification === OPERATION_TIMEOUT) {
    failUnlockVerification(get, set, session, 'Password verification timed out. Try again.')
    return
  }
  // The dialog closed or reopened for another target while verifying —
  // a late verification result must never commit against a stale target.
  if (!unlockSessionIsCurrent(get, session)) return
  if (typeof verification !== 'object' || verification === null || verification.ok !== true) {
    failUnlockVerification(
      get,
      set,
      session,
      typeof verification === 'object' && verification !== null && verification.message
        ? verification.message
        : 'Incorrect password.',
    )
    return
  }
  commitProtectionUnlock(get, set, session.target, source)
}

export const submitProtectionUnlockAtom = atom(
  null,
  (get, set, input?: SubmitProtectionUnlockInput) => {
    const machine = get(protectionUnlockMachineAtom)
    // Single-flight: a submit while verification is pending is ignored.
    if (machine.phase !== 'editing' || machine.target === null) return
    if (machine.target.range === undefined) {
      setUnlockEditingError(set, 'Select a range to unlock.')
      return
    }
    if (!isCellRange(machine.target.range)) {
      setUnlockEditingError(set, 'Select a valid range to unlock.')
      return
    }
    const session: ProtectionUnlockSession = {
      sessionId: machine.sessionId,
      target: { sheetId: machine.target.sheetId, range: machine.target.range },
    }
    const verify = input?.verifySheetProtection
    if (typeof verify !== 'function') {
      commitProtectionUnlock(get, set, session.target, input?.source)
      return
    }
    set(protectionUnlockMachineAtom, { ...machine, phase: 'verifying', error: null })
    void runProtectionUnlockVerification(
      get,
      set,
      session,
      machine.password,
      verify,
      input?.verifyTimeoutMs,
      input?.source,
    )
  },
)
submitProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.submitUnlock'
