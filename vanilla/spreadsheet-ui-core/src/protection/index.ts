import { atom, type Getter, type Setter } from '@einfach/core'
import type { CellCoord, CellRange } from '../shared'
import { selectionAtom, getActiveCell, getSelectionRange } from '../selection'
import type {
  ReadSheetProtectionRequest,
  ReadSheetProtectionResult,
  SetRangeLockPortError,
  SetRangeLockRequest,
  SheetProtectionBySheet,
  SheetProtectionLoadPhase,
  SheetProtectionLoadState,
  SheetProtectionState,
} from './types'

export * from './types'

export const MAX_UNLOCKED_RANGES = 256

const DEFAULT_OPERATION_TIMEOUT_MS = 10_000
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

function snapshotProtectionState(state: SheetProtectionState): SheetProtectionState {
  if (state.unlockedRanges.length > MAX_UNLOCKED_RANGES) {
    throw new RangeError(
      `Sheet protection cannot contain more than ${MAX_UNLOCKED_RANGES} unlocked ranges.`,
    )
  }
  const unlockedRanges = state.unlockedRanges.map((range) => snapshotRange(range))
  return Object.freeze({
    mode: state.mode,
    unlockedRanges: Object.freeze(unlockedRanges),
  })
}

function setCanonicalProtection(
  get: Getter,
  set: Setter,
  input: { readonly sheetId: string; readonly state: SheetProtectionState },
): void {
  const previous = get(sheetProtectionSourceAtom)
  set(
    sheetProtectionSourceAtom,
    Object.freeze({
      ...previous,
      [input.sheetId]: snapshotProtectionState(input.state),
    }),
  )
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

// --- canonical source and commands ---

const sheetProtectionSourceAtom = atom<SheetProtectionBySheet>(EMPTY_SHEET_PROTECTION)
sheetProtectionSourceAtom.debugLabel = 'spreadsheet.protection.source'

export const sheetProtectionAtom = atom(
  (get): SheetProtectionBySheet => get(sheetProtectionSourceAtom),
)
sheetProtectionAtom.debugLabel = 'spreadsheet.protection.state'

export const setSheetProtectionAtom = atom(
  (get) => get(sheetProtectionAtom),
  (get, set, input: { readonly sheetId: string; readonly state: SheetProtectionState }) => {
    setCanonicalProtection(get, set, input)
  },
)
setSheetProtectionAtom.debugLabel = 'spreadsheet.protection.set'

export const clearSheetProtectionAtom = atom(
  (get) => get(sheetProtectionAtom),
  (get, set, sheetId: string) => {
    const next = { ...get(sheetProtectionSourceAtom) }
    delete next[sheetId]
    set(sheetProtectionSourceAtom, Object.freeze(next))
  },
)
clearSheetProtectionAtom.debugLabel = 'spreadsheet.protection.clear'

// --- canonical protection load lifecycle ---

export type ReadSheetProtectionPort = (
  request: ReadSheetProtectionRequest,
) => Promise<ReadSheetProtectionResult>

export interface LoadSheetProtectionInput {
  readonly sheetId: string
  readonly readSheetProtection?: ReadSheetProtectionPort
}

/** Feature-local restore notification; adapters may map their backend event to this shape. */
export interface ProtectionWorkbookRestoredEvent {
  readonly kind: 'workbook-restored'
  readonly sheetIds: readonly string[]
}

export interface ApplyWorkbookRestoredProtectionInput {
  readonly restored: ProtectionWorkbookRestoredEvent
  readonly readSheetProtection?: ReadSheetProtectionPort
}

interface SheetProtectionLoadMachine {
  readonly nextRequestId: number
  readonly phase: SheetProtectionLoadPhase
  readonly sheetId: string | null
  readonly requestId: number | null
  readonly revision: ReadSheetProtectionResult['revision'] | null
  readonly error: string | null
}

const INITIAL_SHEET_PROTECTION_LOAD_MACHINE: SheetProtectionLoadMachine = Object.freeze({
  nextRequestId: 1,
  phase: 'idle',
  sheetId: null,
  requestId: null,
  revision: null,
  error: null,
})

export const DEFAULT_SHEET_PROTECTION_LOAD_STATE: SheetProtectionLoadState = Object.freeze({
  phase: 'idle',
  sheetId: null,
  requestId: null,
  revision: null,
  pending: false,
  error: null,
})

const sheetProtectionLoadMachineAtom = atom<SheetProtectionLoadMachine>(
  INITIAL_SHEET_PROTECTION_LOAD_MACHINE,
)
sheetProtectionLoadMachineAtom.debugLabel = 'spreadsheet.protection.loadMachine'

export const sheetProtectionLoadStateAtom = atom((get): SheetProtectionLoadState => {
  const machine = get(sheetProtectionLoadMachineAtom)
  if (machine === INITIAL_SHEET_PROTECTION_LOAD_MACHINE) {
    return DEFAULT_SHEET_PROTECTION_LOAD_STATE
  }
  return Object.freeze({
    phase: machine.phase,
    sheetId: machine.sheetId,
    requestId: machine.requestId,
    revision: machine.revision,
    pending: machine.phase === 'loading',
    error: machine.error,
  })
})
sheetProtectionLoadStateAtom.debugLabel = 'spreadsheet.protection.loadState'

function protectionLoadMatches(
  machine: SheetProtectionLoadMachine,
  request: ReadSheetProtectionRequest,
): boolean {
  return (
    machine.phase === 'loading' &&
    machine.sheetId === request.sheetId &&
    machine.requestId === request.requestId
  )
}

function finishProtectionLoadFailure(
  set: Setter,
  request: ReadSheetProtectionRequest,
  error: string,
): void {
  set(sheetProtectionLoadMachineAtom, (machine) => {
    if (!protectionLoadMatches(machine, request)) return machine
    return Object.freeze({
      ...machine,
      phase: 'error' as const,
      revision: null,
      error,
    })
  })
}

async function runSheetProtectionLoad(
  get: Getter,
  set: Setter,
  request: ReadSheetProtectionRequest,
  readSheetProtection: ReadSheetProtectionPort,
): Promise<void> {
  let result: ReadSheetProtectionResult
  try {
    result = await readSheetProtection(request)
  } catch (error) {
    finishProtectionLoadFailure(
      set,
      request,
      errorMessage(error, 'Could not load protection status.'),
    )
    return
  }

  if (!protectionLoadMatches(get(sheetProtectionLoadMachineAtom), request)) return
  if (!readResultMatches(result, request)) {
    finishProtectionLoadFailure(
      set,
      request,
      'Protection status response did not match the request.',
    )
    return
  }

  const protection = snapshotProtectionState(result.protection)
  if (!protectionLoadMatches(get(sheetProtectionLoadMachineAtom), request)) return
  setCanonicalProtection(get, set, { sheetId: request.sheetId, state: protection })
  set(sheetProtectionLoadMachineAtom, (machine) => {
    if (!protectionLoadMatches(machine, request)) return machine
    return Object.freeze({
      ...machine,
      phase: 'ready' as const,
      revision: result.revision,
      error: null,
    })
  })
}

export const loadSheetProtectionAtom = atom(null, (get, set, input: LoadSheetProtectionInput) => {
  const machine = get(sheetProtectionLoadMachineAtom)
  if (!input.readSheetProtection) {
    set(
      sheetProtectionLoadMachineAtom,
      Object.freeze({
        ...machine,
        phase: 'unsupported' as const,
        sheetId: input.sheetId,
        requestId: null,
        revision: null,
        error: 'Protection status loading is unavailable.',
      }),
    )
    return
  }

  const request: ReadSheetProtectionRequest = Object.freeze({
    kind: 'read-sheet-protection',
    sheetId: input.sheetId,
    requestId: machine.nextRequestId,
  })
  set(
    sheetProtectionLoadMachineAtom,
    Object.freeze({
      nextRequestId: request.requestId + 1,
      phase: 'loading' as const,
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: null,
      error: null,
    }),
  )
  void runSheetProtectionLoad(get, set, request, input.readSheetProtection)
})
loadSheetProtectionAtom.debugLabel = 'spreadsheet.protection.load'

export const applyWorkbookRestoredProtectionAtom = atom(
  null,
  (get, set, input: ApplyWorkbookRestoredProtectionInput) => {
    const machine = get(sheetProtectionLoadMachineAtom)
    set(sheetProtectionSourceAtom, EMPTY_SHEET_PROTECTION)
    set(
      sheetProtectionLoadMachineAtom,
      Object.freeze({
        nextRequestId: machine.nextRequestId,
        phase: 'idle' as const,
        sheetId: null,
        requestId: null,
        revision: null,
        error: null,
      }),
    )

    const sheetId = get(selectionAtom).sheetId
    if (!input.restored.sheetIds.includes(sheetId)) return
    set(loadSheetProtectionAtom, {
      sheetId,
      readSheetProtection: input.readSheetProtection,
    })
  },
)
applyWorkbookRestoredProtectionAtom.debugLabel = 'spreadsheet.protection.applyWorkbookRestored'

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

// --- unlock lifecycle ---

export type ProtectionUnlockPhase =
  | 'closed'
  | 'editing'
  | 'verifying'
  | 'mutation-pending'
  | 'canonical-refreshing'
  | 'recovery-required'

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

export type CorrelatedSetRangeLockRequest = SetRangeLockRequest & {
  readonly requestId: number
}

export type SetRangeLockPort = (request: CorrelatedSetRangeLockRequest) => Promise<unknown>

export interface SubmitProtectionUnlockInput {
  readonly verifySheetProtection?: VerifySheetProtectionPort
  readonly setRangeLock?: SetRangeLockPort
  readonly readSheetProtection?: ReadSheetProtectionPort
  readonly verifyTimeoutMs?: number
  readonly mutationTimeoutMs?: number
  readonly refreshTimeoutMs?: number
}

export interface RefreshProtectionUnlockInput {
  readonly readSheetProtection: ReadSheetProtectionPort
  readonly refreshTimeoutMs?: number
}

type ActiveProtectionPhase = Exclude<ProtectionUnlockPhase, 'closed' | 'editing'>

interface ProtectionUnlockDialogState {
  readonly sessionId: number
  readonly phase: ProtectionUnlockPhase
  readonly target: ProtectionUnlockTarget | null
  readonly password: string
  readonly error: string | null
}

interface ProtectionUnlockOperation {
  readonly requestId: number
  readonly sessionId: number
  readonly target: ProtectionUnlockTarget & { readonly range: Readonly<CellRange> }
  readonly stage: ActiveProtectionPhase
  readonly expectedRevision?: ReadSheetProtectionResult['revision']
}

interface ProtectionUnlockMachine {
  readonly nextSessionId: number
  readonly nextRequestId: number
  readonly dialog: ProtectionUnlockDialogState
  readonly operation: ProtectionUnlockOperation | null
}

const INITIAL_PROTECTION_UNLOCK_MACHINE: ProtectionUnlockMachine = {
  nextSessionId: 1,
  nextRequestId: 1,
  dialog: {
    sessionId: 0,
    phase: 'closed',
    target: null,
    password: '',
    error: null,
  },
  operation: null,
}

const protectionUnlockMachineAtom = atom<ProtectionUnlockMachine>(INITIAL_PROTECTION_UNLOCK_MACHINE)
protectionUnlockMachineAtom.debugLabel = 'spreadsheet.protection.unlockMachine'

function snapshotTarget(target: ProtectionUnlockTarget): ProtectionUnlockTarget {
  return Object.freeze({
    sheetId: target.sheetId,
    range: target.range ? snapshotRange(target.range) : undefined,
  })
}

function targetsMatch(
  first: ProtectionUnlockTarget | null,
  second: ProtectionUnlockTarget | null,
): boolean {
  if (first === null || second === null) return first === second
  if (first.sheetId !== second.sheetId) return false
  if (first.range === undefined || second.range === undefined) {
    return first.range === second.range
  }
  return rangesEqual(first.range, second.range)
}

function rangesEqual(first: Readonly<CellRange>, second: Readonly<CellRange>): boolean {
  return (
    first.rowStart === second.rowStart &&
    first.rowEnd === second.rowEnd &&
    first.colStart === second.colStart &&
    first.colEnd === second.colEnd
  )
}

function operationMatches(
  operation: ProtectionUnlockOperation | null,
  expected: ProtectionUnlockOperation,
): boolean {
  return (
    operation?.requestId === expected.requestId &&
    operation.sessionId === expected.sessionId &&
    operation.stage === expected.stage &&
    operation.expectedRevision === expected.expectedRevision &&
    targetsMatch(operation.target, expected.target)
  )
}

function operationOwnsDialog(
  machine: ProtectionUnlockMachine,
  operation: ProtectionUnlockOperation,
): boolean {
  return (
    machine.dialog.sessionId === operation.sessionId &&
    targetsMatch(machine.dialog.target, operation.target)
  )
}

function activePhasePending(phase: ProtectionUnlockPhase): boolean {
  return phase === 'verifying' || phase === 'mutation-pending' || phase === 'canonical-refreshing'
}

export const protectionUnlockStateAtom = atom((get): ProtectionUnlockState => {
  const dialog = get(protectionUnlockMachineAtom).dialog
  return Object.freeze({
    phase: dialog.phase,
    isOpen: dialog.phase !== 'closed',
    target: dialog.target,
    pending: activePhasePending(dialog.phase),
    error: dialog.error,
    recoveryRequired: dialog.phase === 'recovery-required',
  })
})
protectionUnlockStateAtom.debugLabel = 'spreadsheet.protection.unlockState'

export const protectionUnlockPasswordAtom = atom(
  (get): string => get(protectionUnlockMachineAtom).dialog.password,
)
protectionUnlockPasswordAtom.debugLabel = 'spreadsheet.protection.unlockPassword'

export const protectionUnlockPhaseAtom = atom(
  (get): ProtectionUnlockPhase => get(protectionUnlockMachineAtom).dialog.phase,
)
protectionUnlockPhaseAtom.debugLabel = 'spreadsheet.protection.unlockPhase'

export const protectionUnlockOpenAtom = atom(
  (get): boolean => get(protectionUnlockMachineAtom).dialog.phase !== 'closed',
)
protectionUnlockOpenAtom.debugLabel = 'spreadsheet.protection.unlockOpen'

export const protectionUnlockMutationBlockedAtom = atom(
  (get): boolean => get(protectionUnlockMachineAtom).operation !== null,
)
protectionUnlockMutationBlockedAtom.debugLabel = 'spreadsheet.protection.unlockMutationBlocked'

export const protectionUnlockRecoveryRequiredAtom = atom(
  (get): boolean => get(protectionUnlockMachineAtom).operation?.stage === 'recovery-required',
)
protectionUnlockRecoveryRequiredAtom.debugLabel = 'spreadsheet.protection.unlockRecoveryRequired'

export const setProtectionUnlockPasswordAtom = atom(null, (get, set, password: string) => {
  const machine = get(protectionUnlockMachineAtom)
  if (machine.dialog.phase !== 'editing') return
  set(protectionUnlockMachineAtom, {
    ...machine,
    dialog: { ...machine.dialog, password },
  })
})
setProtectionUnlockPasswordAtom.debugLabel = 'spreadsheet.protection.setUnlockPassword'

export const openProtectionUnlockAtom = atom(null, (get, set, input: ProtectionUnlockTarget) => {
  const machine = get(protectionUnlockMachineAtom)
  const sessionId = machine.nextSessionId

  if (machine.operation !== null && machine.operation.stage !== 'verifying') {
    const recoveryOperation: ProtectionUnlockOperation = {
      ...machine.operation,
      sessionId,
      stage: 'recovery-required',
    }
    set(protectionUnlockMachineAtom, {
      ...machine,
      nextSessionId: sessionId + 1,
      dialog: {
        sessionId,
        phase: 'recovery-required',
        target: recoveryOperation.target,
        password: '',
        error: 'Refresh protection status before retrying.',
      },
      operation: recoveryOperation,
    })
    return
  }

  const target = snapshotTarget(input)
  set(protectionUnlockMachineAtom, {
    ...machine,
    nextSessionId: sessionId + 1,
    dialog: {
      sessionId,
      phase: 'editing',
      target,
      password: '',
      error: null,
    },
    operation: null,
  })
})
openProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.openUnlock'

export const closeProtectionUnlockAtom = atom(null, (get, set) => {
  const machine = get(protectionUnlockMachineAtom)
  const sessionId = machine.nextSessionId
  const operation =
    machine.operation === null || machine.operation.stage === 'verifying'
      ? null
      : { ...machine.operation, stage: 'recovery-required' as const }
  set(protectionUnlockMachineAtom, {
    ...machine,
    nextSessionId: sessionId + 1,
    dialog: {
      sessionId,
      phase: 'closed',
      target: null,
      password: '',
      error: null,
    },
    operation,
  })
})
closeProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.closeUnlock'

function setEditingError(set: Setter, error: string): void {
  set(protectionUnlockMachineAtom, (machine) => {
    if (machine.dialog.phase === 'closed') return machine
    return {
      ...machine,
      dialog: { ...machine.dialog, phase: 'editing', error },
    }
  })
}

function finishKnownNotApplied(
  set: Setter,
  operation: ProtectionUnlockOperation,
  message: string,
): void {
  set(protectionUnlockMachineAtom, (machine) => {
    if (!operationMatches(machine.operation, operation)) return machine
    return {
      ...machine,
      operation: null,
      dialog: operationOwnsDialog(machine, operation)
        ? { ...machine.dialog, phase: 'editing', error: message }
        : machine.dialog,
    }
  })
}

function requireRecovery(set: Setter, operation: ProtectionUnlockOperation, message: string): void {
  set(protectionUnlockMachineAtom, (machine) => {
    if (!operationMatches(machine.operation, operation)) return machine
    const recoveryOperation: ProtectionUnlockOperation = {
      ...operation,
      stage: 'recovery-required',
    }
    return {
      ...machine,
      operation: recoveryOperation,
      dialog: operationOwnsDialog(machine, operation)
        ? { ...machine.dialog, phase: 'recovery-required', error: message }
        : machine.dialog,
    }
  })
}

function transitionOperation(
  set: Setter,
  operation: ProtectionUnlockOperation,
  stage: ActiveProtectionPhase,
  expectedRevision = operation.expectedRevision,
): ProtectionUnlockOperation {
  const nextOperation: ProtectionUnlockOperation = { ...operation, stage, expectedRevision }
  set(protectionUnlockMachineAtom, (machine) => {
    if (!operationMatches(machine.operation, operation)) return machine
    return {
      ...machine,
      operation: nextOperation,
      dialog: operationOwnsDialog(machine, operation)
        ? { ...machine.dialog, phase: stage, error: null }
        : machine.dialog,
    }
  })
  return nextOperation
}

function isOperationCurrent(get: Getter, operation: ProtectionUnlockOperation): boolean {
  return operationMatches(get(protectionUnlockMachineAtom).operation, operation)
}

function cancelStaleVerification(set: Setter, operation: ProtectionUnlockOperation): void {
  set(protectionUnlockMachineAtom, (machine) => {
    if (!operationMatches(machine.operation, operation)) return machine
    if (operationOwnsDialog(machine, operation)) return machine
    return { ...machine, operation: null }
  })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function operationTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_OPERATION_TIMEOUT_MS
}

async function waitWithTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number | undefined,
): Promise<Value | typeof OPERATION_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof OPERATION_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(OPERATION_TIMEOUT), operationTimeout(timeoutMs))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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

function mutationCorrelationMatches(value: unknown, operation: ProtectionUnlockOperation): boolean {
  if (typeof value !== 'object' || value === null) return false
  const result = value as {
    readonly requestId?: unknown
    readonly sheetId?: unknown
    readonly affectedRange?: unknown
  }
  return (
    result.requestId === operation.requestId &&
    result.sheetId === operation.target.sheetId &&
    isCellRange(result.affectedRange) &&
    rangesEqual(result.affectedRange, operation.target.range)
  )
}

type ClassifiedSetRangeLockResult =
  | {
      readonly outcome: 'acknowledged'
      readonly revision: unknown
    }
  | {
      readonly outcome: 'confirmed-not-applied'
      readonly message?: string
    }
  | {
      readonly outcome: 'outcome-unknown'
      readonly message?: string
    }

function classifyMutationResult(
  value: unknown,
  operation: ProtectionUnlockOperation,
): ClassifiedSetRangeLockResult | null {
  if (typeof value !== 'object' || value === null) return null
  const result = value as {
    readonly kind?: unknown
    readonly outcome?: unknown
    readonly code?: unknown
    readonly message?: unknown
    readonly revision?: unknown
  }
  if (result.kind !== 'set-range-lock' || !mutationCorrelationMatches(value, operation)) {
    return null
  }
  if (result.message !== undefined && typeof result.message !== 'string') return null

  if (result.outcome === 'acknowledged') {
    return { outcome: result.outcome, revision: result.revision }
  }
  if (result.outcome === 'confirmed-not-applied') {
    if (result.code !== 'PERMISSION_DENIED' && result.code !== 'CONFIRMED_NOT_APPLIED') {
      return null
    }
    return { outcome: result.outcome, message: result.message }
  }
  if (result.outcome === 'outcome-unknown') {
    return { outcome: result.outcome, message: result.message }
  }
  return null
}

function typedPortError(value: unknown): SetRangeLockPortError | null {
  if (!(value instanceof Error)) return null
  const error = value as Partial<SetRangeLockPortError>
  if (error.kind !== 'set-range-lock-error') return null
  if (error.outcome === 'confirmed-not-applied') {
    return error.code === 'PERMISSION_DENIED' || error.code === 'CONFIRMED_NOT_APPLIED'
      ? (error as SetRangeLockPortError)
      : null
  }
  return error.outcome === 'outcome-unknown' && error.code === 'OUTCOME_UNKNOWN'
    ? (error as SetRangeLockPortError)
    : null
}

function isSheetProtectionState(value: unknown): value is SheetProtectionState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<SheetProtectionState>
  if (state.mode !== 'open' && state.mode !== 'protected') return false
  return (
    Array.isArray(state.unlockedRanges) &&
    state.unlockedRanges.length <= MAX_UNLOCKED_RANGES &&
    state.unlockedRanges.every(isCellRange)
  )
}

function isProjectionRevision(value: unknown): value is ReadSheetProtectionResult['revision'] {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && value.trim().length > 0)
  )
}

function readResultMatches(
  value: unknown,
  request: ReadSheetProtectionRequest,
  expectedRevision?: ReadSheetProtectionResult['revision'],
): value is ReadSheetProtectionResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Partial<ReadSheetProtectionResult>
  return (
    result.kind === 'read-sheet-protection' &&
    result.requestId === request.requestId &&
    result.sheetId === request.sheetId &&
    isProjectionRevision(result.revision) &&
    (expectedRevision === undefined || result.revision === expectedRevision) &&
    isSheetProtectionState(result.protection)
  )
}

function completeCanonicalRefresh(
  get: Getter,
  set: Setter,
  operation: ProtectionUnlockOperation,
  result: ReadSheetProtectionResult,
): void {
  const machine = get(protectionUnlockMachineAtom)
  if (!operationMatches(machine.operation, operation) || !operationOwnsDialog(machine, operation)) {
    return
  }
  const protection = snapshotProtectionState(result.protection)
  setCanonicalProtection(get, set, { sheetId: operation.target.sheetId, state: protection })
  const canonical = Object.freeze({ [operation.target.sheetId]: protection })
  const unlocked = isRangeFullyUnlocked(canonical, operation.target.sheetId, operation.target.range)
  set(protectionUnlockMachineAtom, (machine) => {
    if (!operationMatches(machine.operation, operation)) return machine
    if (!operationOwnsDialog(machine, operation)) return { ...machine, operation: null }
    return {
      ...machine,
      operation: null,
      dialog: unlocked
        ? {
            ...machine.dialog,
            phase: 'closed',
            target: null,
            password: '',
            error: null,
          }
        : {
            ...machine.dialog,
            phase: 'editing',
            error: 'The range is still locked. Try again.',
          },
    }
  })
}

async function runCanonicalRefresh(
  get: Getter,
  set: Setter,
  operation: ProtectionUnlockOperation,
  readSheetProtection: ReadSheetProtectionPort,
  timeoutMs: number | undefined,
): Promise<void> {
  if (!isOperationCurrent(get, operation)) return
  let readPromise: Promise<ReadSheetProtectionResult>
  try {
    readPromise = readSheetProtection({
      kind: 'read-sheet-protection',
      sheetId: operation.target.sheetId,
      requestId: operation.requestId,
    })
  } catch (error) {
    requireRecovery(set, operation, errorMessage(error, 'Could not refresh protection status.'))
    return
  }

  let result: ReadSheetProtectionResult | typeof OPERATION_TIMEOUT
  try {
    result = await waitWithTimeout(readPromise, timeoutMs)
  } catch (error) {
    requireRecovery(set, operation, errorMessage(error, 'Could not refresh protection status.'))
    return
  }
  if (result === OPERATION_TIMEOUT) {
    requireRecovery(set, operation, 'Protection status refresh timed out. Try refresh again.')
    return
  }
  const request: ReadSheetProtectionRequest = {
    kind: 'read-sheet-protection',
    sheetId: operation.target.sheetId,
    requestId: operation.requestId,
  }
  if (!readResultMatches(result, request, operation.expectedRevision)) {
    requireRecovery(set, operation, 'Protection status response did not match the request.')
    return
  }
  completeCanonicalRefresh(get, set, operation, result)
}

async function runProtectionUnlock(
  get: Getter,
  set: Setter,
  operation: ProtectionUnlockOperation,
  password: string,
  input: SubmitProtectionUnlockInput & {
    readonly setRangeLock: SetRangeLockPort
    readonly readSheetProtection: ReadSheetProtectionPort
  },
): Promise<void> {
  if (input.verifySheetProtection) {
    let verification: VerifySheetProtectionResult | typeof OPERATION_TIMEOUT
    try {
      verification = await waitWithTimeout(
        input.verifySheetProtection({
          sheetId: operation.target.sheetId,
          range: operation.target.range,
          password,
        }),
        input.verifyTimeoutMs,
      )
    } catch (error) {
      finishKnownNotApplied(
        set,
        operation,
        errorMessage(error, 'Could not verify the protection password.'),
      )
      return
    }
    if (verification === OPERATION_TIMEOUT) {
      finishKnownNotApplied(set, operation, 'Password verification timed out. Try again.')
      return
    }
    if (!isOperationCurrent(get, operation)) return
    if (!operationOwnsDialog(get(protectionUnlockMachineAtom), operation)) {
      cancelStaleVerification(set, operation)
      return
    }
    if (typeof verification !== 'object' || verification === null || !verification.ok) {
      finishKnownNotApplied(
        set,
        operation,
        typeof verification === 'object' && verification !== null && verification.message
          ? verification.message
          : 'Incorrect password.',
      )
      return
    }
  }

  if (!isOperationCurrent(get, operation)) return
  if (!operationOwnsDialog(get(protectionUnlockMachineAtom), operation)) {
    cancelStaleVerification(set, operation)
    return
  }
  const pendingOperation = transitionOperation(set, operation, 'mutation-pending')
  const request: CorrelatedSetRangeLockRequest = {
    kind: 'set-range-lock',
    sheetId: pendingOperation.target.sheetId,
    range: {
      rowStart: pendingOperation.target.range.rowStart,
      rowEnd: pendingOperation.target.range.rowEnd,
      colStart: pendingOperation.target.range.colStart,
      colEnd: pendingOperation.target.range.colEnd,
    },
    locked: false,
    requestId: pendingOperation.requestId,
  }

  let mutationPromise: Promise<unknown>
  try {
    mutationPromise = input.setRangeLock(request)
  } catch (error) {
    const typed = typedPortError(error)
    if (
      typed?.outcome === 'confirmed-not-applied' &&
      mutationCorrelationMatches(typed, pendingOperation)
    ) {
      finishKnownNotApplied(set, pendingOperation, typed.message)
      return
    }
    requireRecovery(
      set,
      pendingOperation,
      typed?.message ?? 'The protection change outcome is unknown. Refresh before retrying.',
    )
    return
  }

  let result: unknown
  try {
    result = await waitWithTimeout(mutationPromise, input.mutationTimeoutMs)
  } catch (error) {
    const typed = typedPortError(error)
    if (
      typed?.outcome === 'confirmed-not-applied' &&
      mutationCorrelationMatches(typed, pendingOperation)
    ) {
      finishKnownNotApplied(set, pendingOperation, typed.message)
      return
    }
    requireRecovery(
      set,
      pendingOperation,
      typed?.message ?? 'The protection change outcome is unknown. Refresh before retrying.',
    )
    return
  }
  if (result === OPERATION_TIMEOUT) {
    requireRecovery(
      set,
      pendingOperation,
      'The protection change timed out. Refresh before retrying.',
    )
    return
  }
  if (!isOperationCurrent(get, pendingOperation)) return
  const classifiedResult = classifyMutationResult(result, pendingOperation)
  if (classifiedResult === null) {
    requireRecovery(
      set,
      pendingOperation,
      'The protection response did not match the request. Refresh before retrying.',
    )
    return
  }
  if (classifiedResult.outcome === 'confirmed-not-applied') {
    finishKnownNotApplied(
      set,
      pendingOperation,
      classifiedResult.message ?? 'The protection change was not applied.',
    )
    return
  }
  if (classifiedResult.outcome === 'outcome-unknown') {
    requireRecovery(
      set,
      pendingOperation,
      classifiedResult.message ??
        'The protection change outcome is unknown. Refresh before retrying.',
    )
    return
  }
  if (!isProjectionRevision(classifiedResult.revision)) {
    requireRecovery(
      set,
      pendingOperation,
      'The protection response did not include a valid canonical revision.',
    )
    return
  }
  const refreshingOperation = transitionOperation(
    set,
    pendingOperation,
    'canonical-refreshing',
    classifiedResult.revision,
  )
  await runCanonicalRefresh(
    get,
    set,
    refreshingOperation,
    input.readSheetProtection,
    input.refreshTimeoutMs,
  )
}

export const submitProtectionUnlockAtom = atom(
  null,
  (get, set, input: SubmitProtectionUnlockInput) => {
    const machine = get(protectionUnlockMachineAtom)
    if (machine.dialog.phase !== 'editing' || machine.dialog.target === null) return
    if (machine.operation !== null) {
      setEditingError(set, 'Refresh protection status before retrying.')
      return
    }
    if (machine.dialog.target.range === undefined) {
      setEditingError(set, 'Select a range to unlock.')
      return
    }
    if (!isCellRange(machine.dialog.target.range)) {
      setEditingError(set, 'Select a valid range to unlock.')
      return
    }
    if (!input.setRangeLock || !input.readSheetProtection) {
      setEditingError(set, 'Protection editing and status refresh are unavailable.')
      return
    }

    const requestId = machine.nextRequestId
    const operation: ProtectionUnlockOperation = {
      requestId,
      sessionId: machine.dialog.sessionId,
      target: {
        sheetId: machine.dialog.target.sheetId,
        range: machine.dialog.target.range,
      },
      stage: 'verifying',
    }
    set(protectionUnlockMachineAtom, {
      ...machine,
      nextRequestId: requestId + 1,
      dialog: { ...machine.dialog, phase: 'verifying', error: null },
      operation,
    })
    void runProtectionUnlock(get, set, operation, machine.dialog.password, {
      ...input,
      setRangeLock: input.setRangeLock,
      readSheetProtection: input.readSheetProtection,
    })
  },
)
submitProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.submitUnlock'

export const refreshProtectionUnlockAtom = atom(
  null,
  (get, set, input: RefreshProtectionUnlockInput) => {
    const machine = get(protectionUnlockMachineAtom)
    if (machine.operation?.stage !== 'recovery-required') return
    if (
      machine.dialog.phase !== 'recovery-required' ||
      !targetsMatch(machine.dialog.target, machine.operation.target)
    ) {
      return
    }
    const attachedOperation: ProtectionUnlockOperation = {
      ...machine.operation,
      sessionId: machine.dialog.sessionId,
    }
    set(protectionUnlockMachineAtom, {
      ...machine,
      operation: attachedOperation,
    })
    const refreshingOperation = transitionOperation(set, attachedOperation, 'canonical-refreshing')
    void runCanonicalRefresh(
      get,
      set,
      refreshingOperation,
      input.readSheetProtection,
      input.refreshTimeoutMs,
    )
  },
)
refreshProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.refreshUnlock'
