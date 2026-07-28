import { atom } from '@einfach/core'
import type { Getter, Setter } from '@einfach/core'
import type { SpreadsheetCellFormat } from '../backend'
import {
  selectionAuthorityWitnessAtom,
  selectionSnapshotAtom,
  type SelectionAuthorityWitness,
} from '../selection'
import type { CellRange, SpreadsheetError, SpreadsheetErrorSource } from '../shared'
import {
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  type WorkspaceActiveSheetAuthorityWitness,
} from '../workspace'
import type {
  ApplyFormatPainterInput,
  CapturedFormat,
  FormatPainterApplyResult,
  FormatPainterBackendCapabilities,
  FormatPainterBackendCapabilitySource,
  FormatPainterControllerState,
  FormatPainterLateEvidence,
  FormatPainterMutationAttempt,
  FormatPainterMutationTicket,
  FormatPainterOperationPhase,
  FormatPainterRangeRef,
  FormatPainterReadVisibleProjectionPort,
  FormatPainterSetFormatRangePort,
  FormatPainterState,
} from './types'

export * from './types'

export const FORMAT_PAINTER_LEDGER_MAX = 32

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const MAX_SHEET_ID_LENGTH = 512
const MAX_SNAPSHOT_DEPTH = 24
const MAX_SNAPSHOT_NODES = 2_048
const INTRINSIC_REFLECT_APPLY = Reflect.apply
const INTRINSIC_REFLECT_GET = Reflect.get

interface FormatPainterInternalController extends FormatPainterControllerState {
  readonly sourceSelectionWitness: SelectionAuthorityWitness | null
  readonly sourceWorkspaceWitness: WorkspaceActiveSheetAuthorityWitness | null
}

interface FormatPainterReservation {
  readonly token: object
  readonly kind: 'arm' | 'preflight' | 'dispatch' | 'acknowledgement' | 'refresh'
  readonly reentered: boolean
}

interface SnapshotBudget {
  nodes: number
}

type TransportObservation =
  | { readonly kind: 'fulfilled'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timed-out' }

const EMPTY_CONTROLLER: FormatPainterInternalController = Object.freeze({
  state: 'idle',
  phase: 'idle',
  clipboard: null,
  sessionId: null,
  source: null,
  lastTarget: null,
  pendingTicket: null,
  error: null,
  blocked: false,
  sourceSelectionWitness: null,
  sourceWorkspaceWitness: null,
})

const EMPTY_CAPABILITIES: Readonly<FormatPainterBackendCapabilities> = Object.freeze({})

const formatPainterControllerSourceAtom = atom<FormatPainterInternalController>(EMPTY_CONTROLLER)
const formatPainterSessionSequenceAtom = atom(0)
const formatPainterRequestSequenceAtom = atom(0)
const formatPainterLedgerSourceAtom = atom<readonly FormatPainterMutationAttempt[]>(
  Object.freeze([]),
)
const formatPainterReservationAtom = atom<FormatPainterReservation | null>(null)
const formatPainterCapabilityReservationAtom = atom<FormatPainterReservation | null>(null)

function nextSafeIdentity(current: number): number | null {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    return null
  }
  return current + 1
}

function validSheetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SHEET_ID_LENGTH
}

function validRange(range: CellRange): boolean {
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.rowEnd >= range.rowStart &&
    range.colEnd >= range.colStart
  )
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function sameRangeRef(left: FormatPainterRangeRef | null, right: FormatPainterRangeRef): boolean {
  return left !== null && left.sheetId === right.sheetId && sameRange(left.range, right.range)
}

function freezeRange(range: CellRange): Readonly<CellRange> {
  return Object.freeze({
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  })
}

function freezeRangeRef(sheetId: string, range: CellRange): FormatPainterRangeRef {
  return Object.freeze({ sheetId, range: freezeRange(range) })
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined || !('value' in descriptor)) throw new Error('invalid data property')
  return descriptor.value
}

/** Clone only finite, accessor-free JSON-like data without executing user code. */
function snapshotPlainData(
  value: unknown,
  seen: Set<object>,
  budget: SnapshotBudget,
  depth = 0,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'undefined') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number')
    return value
  }
  if (typeof value !== 'object') throw new Error('unsupported value')
  if (depth > MAX_SNAPSHOT_DEPTH || budget.nodes >= MAX_SNAPSHOT_NODES || seen.has(value)) {
    throw new Error('snapshot limit')
  }
  budget.nodes += 1
  seen.add(value)
  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new Error('unsupported array prototype')
      const length = ownDataValue(value, 'length')
      if (
        !Number.isSafeInteger(length) ||
        (length as number) < 0 ||
        (length as number) > MAX_SNAPSHOT_NODES
      ) {
        throw new Error('invalid array length')
      }
      const clone: unknown[] = []
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('sparse or accessor array')
        }
        clone.push(snapshotPlainData(descriptor.value, seen, budget, depth + 1))
      }
      const keys = Reflect.ownKeys(value)
      if (
        keys.some(
          (key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
        )
      ) {
        throw new Error('unsupported array property')
      }
      return Object.freeze(clone)
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('unsupported object prototype')
    }
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'prototype') {
        throw new Error('unsupported object property')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('accessor or hidden property')
      }
      clone[key] = snapshotPlainData(descriptor.value, seen, budget, depth + 1)
    }
    return Object.freeze(clone)
  } finally {
    seen.delete(value)
  }
}

function snapshotCapturedFormat(value: unknown): Readonly<CapturedFormat> | null {
  try {
    const snapshot = snapshotPlainData(value, new Set(), { nodes: 0 })
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, 'format')
    if (descriptor === undefined || !('value' in descriptor)) return null
    const format = descriptor.value
    if (format === null || typeof format !== 'object' || Array.isArray(format)) return null
    const conditionalDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'conditionalFormat')
    return Object.freeze({
      format: format as Readonly<SpreadsheetCellFormat>,
      ...(conditionalDescriptor === undefined
        ? {}
        : { conditionalFormat: conditionalDescriptor.value as SpreadsheetCellFormat | undefined }),
    })
  } catch {
    return null
  }
}

function snapshotRange(value: unknown): Readonly<CellRange> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const range: CellRange = {
      rowStart: ownDataValue(value, 'rowStart') as number,
      rowEnd: ownDataValue(value, 'rowEnd') as number,
      colStart: ownDataValue(value, 'colStart') as number,
      colEnd: ownDataValue(value, 'colEnd') as number,
    }
    return validRange(range) ? freezeRange(range) : null
  } catch {
    return null
  }
}

/** W0 permits exactly one contiguous physical target; zero/many fail before mutation. */
function snapshotSingleTargetRange(value: unknown): Readonly<CellRange> | null {
  if (!Array.isArray(value)) return null
  try {
    if (ownDataValue(value, 'length') !== 1) return null
    const candidate = ownDataValue(value, '0')
    return snapshotRange(candidate)
  } catch {
    return null
  }
}

function createError(
  code: string,
  message: string,
  source: SpreadsheetErrorSource,
): Readonly<SpreadsheetError> {
  return Object.freeze({ code, message, source, severity: 'error' as const })
}

function publicController(
  controller: FormatPainterInternalController,
  ledger: readonly FormatPainterMutationAttempt[],
): Readonly<FormatPainterControllerState> {
  const unresolved = ledger.some(
    (attempt) => attempt.status === 'pending' || attempt.status === 'outcome-unknown',
  )
  return Object.freeze({
    state: controller.state,
    phase: controller.phase,
    clipboard: controller.clipboard,
    sessionId: controller.sessionId,
    source: controller.source,
    lastTarget: controller.lastTarget,
    pendingTicket: controller.pendingTicket,
    error: controller.error,
    blocked: controller.blocked || unresolved,
  })
}

function controllerPatch(
  controller: FormatPainterInternalController,
  patch: Partial<FormatPainterInternalController>,
): FormatPainterInternalController {
  return Object.freeze({ ...controller, ...patch })
}

function idleController(
  controller: FormatPainterInternalController,
  phase: FormatPainterOperationPhase = 'idle',
  error: Readonly<SpreadsheetError> | null = null,
): FormatPainterInternalController {
  return controllerPatch(controller, {
    state: 'idle',
    phase,
    clipboard: null,
    sessionId: null,
    source: null,
    lastTarget: null,
    pendingTicket: null,
    error,
    blocked: false,
    sourceSelectionWitness: null,
    sourceWorkspaceWitness: null,
  })
}

function markReservationReentered(
  get: Getter,
  set: Setter,
  target = formatPainterReservationAtom,
): boolean {
  const current = get(target)
  if (current === null) return false
  if (!current.reentered) set(target, Object.freeze({ ...current, reentered: true }))
  return true
}

function reserveLedgerSlot(
  ledger: readonly FormatPainterMutationAttempt[],
): FormatPainterMutationAttempt[] | null {
  const next = [...ledger]
  while (next.length >= FORMAT_PAINTER_LEDGER_MAX) {
    const disposable = next.findIndex(
      (attempt) =>
        attempt.status === 'local-acknowledged' ||
        attempt.status === 'honest-local-projection-unknown',
    )
    if (disposable < 0) return null
    next.splice(disposable, 1)
  }
  return next
}

function settleLedger(
  ledger: readonly FormatPainterMutationAttempt[],
  operationId: string,
  status: FormatPainterMutationAttempt['status'],
  error?: string,
): readonly FormatPainterMutationAttempt[] {
  return Object.freeze(
    ledger.map((attempt) =>
      attempt.operationId === operationId
        ? Object.freeze({
            ...attempt,
            status,
            ...(error === undefined ? {} : { error }),
          })
        : attempt,
    ),
  )
}

function recordLateEvidence(
  ledger: readonly FormatPainterMutationAttempt[],
  operationId: string,
  evidence: FormatPainterLateEvidence,
): readonly FormatPainterMutationAttempt[] {
  return Object.freeze(
    ledger.map((attempt) =>
      attempt.operationId === operationId
        ? Object.freeze({ ...attempt, lateEvidence: evidence })
        : attempt,
    ),
  )
}

function exactAcknowledgement(value: unknown, ticket: FormatPainterMutationTicket): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    if (ownDataValue(value, 'sheetId') !== ticket.target.sheetId) return false
    if (ownDataValue(value, 'requestId') !== ticket.requestId) return false
    const affectedRange = snapshotRange(ownDataValue(value, 'affectedRange'))
    return affectedRange !== null && sameRange(affectedRange, ticket.target.range)
  } catch {
    return false
  }
}

function captureCapability<TArgs extends unknown[], TResult>(
  source: FormatPainterBackendCapabilitySource,
  key: 'setFormatRange' | 'readVisibleProjection',
): ((...args: TArgs) => TResult) | undefined {
  let capability: unknown
  try {
    capability = INTRINSIC_REFLECT_GET(source, key)
  } catch {
    return undefined
  }
  if (typeof capability !== 'function') return undefined
  return Object.freeze(
    (...args: TArgs): TResult => INTRINSIC_REFLECT_APPLY(capability, source, args) as TResult,
  )
}

function currentOwnsTicket(
  controller: FormatPainterInternalController,
  ticket: FormatPainterMutationTicket,
): boolean {
  return (
    controller.pendingTicket?.operationId === ticket.operationId &&
    (controller.sessionId === ticket.sessionId ||
      (controller.state === 'idle' && controller.sessionId === null))
  )
}

function validTimeout(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_TIMEOUT_MS
    ? value
    : DEFAULT_TIMEOUT_MS
}

export const formatPainterControllerAtom = atom((get) =>
  publicController(get(formatPainterControllerSourceAtom), get(formatPainterLedgerSourceAtom)),
)
formatPainterControllerAtom.debugLabel = 'spreadsheet.formatPainter.controller'

export const formatPainterStateAtom = atom(
  (get): FormatPainterState => get(formatPainterControllerSourceAtom).state,
)
formatPainterStateAtom.debugLabel = 'spreadsheet.formatPainter.state'

export const formatPainterClipboardAtom = atom(
  (get) => get(formatPainterControllerSourceAtom).clipboard,
)
formatPainterClipboardAtom.debugLabel = 'spreadsheet.formatPainter.clipboard'

export const formatPainterPhaseAtom = atom((get) => get(formatPainterControllerSourceAtom).phase)
formatPainterPhaseAtom.debugLabel = 'spreadsheet.formatPainter.phase'

export const formatPainterSessionAtom = atom(
  (get) => get(formatPainterControllerSourceAtom).sessionId,
)
formatPainterSessionAtom.debugLabel = 'spreadsheet.formatPainter.session'

export const formatPainterSourceAtom = atom((get) => get(formatPainterControllerSourceAtom).source)
formatPainterSourceAtom.debugLabel = 'spreadsheet.formatPainter.source'

export const formatPainterLastTargetAtom = atom(
  (get) => get(formatPainterControllerSourceAtom).lastTarget,
)
formatPainterLastTargetAtom.debugLabel = 'spreadsheet.formatPainter.lastTarget'

export const formatPainterPendingTicketAtom = atom(
  (get) => get(formatPainterControllerSourceAtom).pendingTicket,
)
formatPainterPendingTicketAtom.debugLabel = 'spreadsheet.formatPainter.pendingTicket'

export const formatPainterPendingAtom = atom(
  (get) => get(formatPainterControllerSourceAtom).pendingTicket !== null,
)
formatPainterPendingAtom.debugLabel = 'spreadsheet.formatPainter.pending'

export const formatPainterErrorAtom = atom((get) => get(formatPainterControllerSourceAtom).error)
formatPainterErrorAtom.debugLabel = 'spreadsheet.formatPainter.error'

export const formatPainterLedgerAtom = atom((get) => get(formatPainterLedgerSourceAtom))
formatPainterLedgerAtom.debugLabel = 'spreadsheet.formatPainter.ledger'

export const formatPainterBlockedAtom = atom((get) => get(formatPainterControllerAtom).blocked)
formatPainterBlockedAtom.debugLabel = 'spreadsheet.formatPainter.blocked'

export const captureFormatPainterBackendCapabilitiesAtom = atom(
  null,
  (
    get,
    set,
    source: FormatPainterBackendCapabilitySource,
  ): Readonly<FormatPainterBackendCapabilities> => {
    if (markReservationReentered(get, set, formatPainterCapabilityReservationAtom)) {
      return EMPTY_CAPABILITIES
    }
    const reservation: FormatPainterReservation = Object.freeze({
      token: Object.freeze({}),
      kind: 'preflight',
      reentered: false,
    })
    set(formatPainterCapabilityReservationAtom, reservation)
    try {
      const setFormatRange = captureCapability<
        Parameters<FormatPainterSetFormatRangePort>,
        ReturnType<FormatPainterSetFormatRangePort>
      >(source, 'setFormatRange')
      const readVisibleProjection = captureCapability<
        Parameters<FormatPainterReadVisibleProjectionPort>,
        ReturnType<FormatPainterReadVisibleProjectionPort>
      >(source, 'readVisibleProjection')
      const live = get(formatPainterCapabilityReservationAtom)
      if (live?.token !== reservation.token || live.reentered) return EMPTY_CAPABILITIES
      return Object.freeze({ setFormatRange, readVisibleProjection })
    } finally {
      const live = get(formatPainterCapabilityReservationAtom)
      if (live?.token === reservation.token) set(formatPainterCapabilityReservationAtom, null)
    }
  },
)
captureFormatPainterBackendCapabilitiesAtom.debugLabel =
  'spreadsheet.formatPainter.captureBackendCapabilities'

function createArmCommand(mode: Exclude<FormatPainterState, 'idle'>) {
  return atom(null, (get, set, captured: CapturedFormat): boolean => {
    if (markReservationReentered(get, set)) return false
    const reservation: FormatPainterReservation = Object.freeze({
      token: Object.freeze({}),
      kind: 'arm',
      reentered: false,
    })
    set(formatPainterReservationAtom, reservation)
    try {
      const selectionWitness = get(selectionAuthorityWitnessAtom)
      const workspaceWitness = get(workspaceActiveSheetAuthorityWitnessAtom)
      const selection = get(selectionSnapshotAtom)
      const workspace = get(workspaceSessionAtom)
      const clipboard = snapshotCapturedFormat(captured)
      const liveReservation = get(formatPainterReservationAtom)
      if (
        liveReservation?.token !== reservation.token ||
        liveReservation.reentered ||
        get(selectionAuthorityWitnessAtom) !== selectionWitness ||
        get(workspaceActiveSheetAuthorityWitnessAtom) !== workspaceWitness ||
        clipboard === null
      ) {
        return false
      }
      const sheetId = selection.selection.sheetId
      const range = selection.range
      if (!validSheetId(sheetId) || workspace.activeSheetId !== sheetId || !validRange(range)) {
        return false
      }
      const sessionId = nextSafeIdentity(get(formatPainterSessionSequenceAtom))
      if (sessionId === null) return false
      const source = freezeRangeRef(sheetId, range)
      set(formatPainterSessionSequenceAtom, sessionId)
      set(
        formatPainterControllerSourceAtom,
        Object.freeze({
          state: mode,
          phase: 'ready',
          clipboard,
          sessionId,
          source,
          lastTarget: null,
          pendingTicket: null,
          error: null,
          blocked: false,
          sourceSelectionWitness: selectionWitness,
          sourceWorkspaceWitness: workspaceWitness,
        }),
      )
      return true
    } finally {
      const live = get(formatPainterReservationAtom)
      if (live?.token === reservation.token) set(formatPainterReservationAtom, null)
    }
  })
}

export const armFormatPainterAtom = createArmCommand('armed')
armFormatPainterAtom.debugLabel = 'spreadsheet.formatPainter.arm'

export const armFormatPainterStickyAtom = createArmCommand('sticky')
armFormatPainterStickyAtom.debugLabel = 'spreadsheet.formatPainter.armSticky'

export const exitFormatPainterAtom = atom(null, (get, set): void => {
  markReservationReentered(get, set)
  set(formatPainterControllerSourceAtom, idleController(get(formatPainterControllerSourceAtom)))
})
exitFormatPainterAtom.debugLabel = 'spreadsheet.formatPainter.exit'

/** Tombstone current-session authority when the workbook active sheet changes. */
export const syncFormatPainterContextAtom = atom(null, (get, set): boolean => {
  const controller = get(formatPainterControllerSourceAtom)
  if (controller.state === 'idle') return false
  const workspace = get(workspaceSessionAtom)
  if (
    workspace.activeSheetId === controller.source?.sheetId &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === controller.sourceWorkspaceWitness
  ) {
    return false
  }
  markReservationReentered(get, set)
  set(formatPainterControllerSourceAtom, idleController(controller))
  return true
})
syncFormatPainterContextAtom.debugLabel = 'spreadsheet.formatPainter.syncContext'

function preflightFailure(
  get: Getter,
  set: Setter,
  owner: FormatPainterInternalController,
  code: string,
  message: string,
): FormatPainterApplyResult {
  if (get(formatPainterControllerSourceAtom) !== owner) return 'stale'
  set(
    formatPainterControllerSourceAtom,
    controllerPatch(owner, {
      phase: 'ready',
      pendingTicket: null,
      error: createError(code, message, 'validation'),
      blocked: false,
    }),
  )
  return 'preflight-failed'
}

function observeTransport(
  promise: Promise<unknown>,
  timeoutMs: number,
  onLate: (observation: Exclude<TransportObservation, { readonly kind: 'timed-out' }>) => void,
): Promise<TransportObservation> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      resolve(Object.freeze({ kind: 'timed-out' as const }))
    }, timeoutMs)
    promise.then(
      (value) => {
        settled = true
        clearTimeout(timer)
        const observation = Object.freeze({ kind: 'fulfilled' as const, value })
        if (timedOut) onLate(observation)
        else resolve(observation)
      },
      (error: unknown) => {
        settled = true
        clearTimeout(timer)
        const observation = Object.freeze({ kind: 'rejected' as const, error })
        if (timedOut) onLate(observation)
        else resolve(observation)
      },
    )
  })
}

function ownsLiveWorkspace(
  get: Getter,
  controller: FormatPainterInternalController,
  ticket: FormatPainterMutationTicket,
): boolean {
  return (
    get(workspaceSessionAtom).activeSheetId === ticket.source.sheetId &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === controller.sourceWorkspaceWitness
  )
}

export const applyFormatPainterAtom = atom(
  (get) => get(formatPainterClipboardAtom),
  async (get, set, input?: ApplyFormatPainterInput): Promise<FormatPainterApplyResult> => {
    if (markReservationReentered(get, set)) return 'blocked'
    if (get(formatPainterCapabilityReservationAtom) !== null) return 'blocked'
    const owner = get(formatPainterControllerSourceAtom)
    const ledger = get(formatPainterLedgerSourceAtom)
    if (
      owner.state === 'idle' ||
      owner.clipboard === null ||
      owner.source === null ||
      owner.sessionId === null ||
      owner.pendingTicket !== null ||
      owner.blocked ||
      ledger.some((attempt) => attempt.status === 'pending' || attempt.status === 'outcome-unknown')
    ) {
      return 'blocked'
    }
    const workspace = get(workspaceSessionAtom)
    if (
      workspace.activeSheetId !== owner.source.sheetId ||
      get(workspaceActiveSheetAuthorityWitnessAtom) !== owner.sourceWorkspaceWitness
    ) {
      set(formatPainterControllerSourceAtom, idleController(owner))
      return 'stale'
    }
    const selectionWitness = get(selectionAuthorityWitnessAtom)
    const selection = get(selectionSnapshotAtom)
    const logicalSheetId = selection.selection.sheetId
    if (
      !validSheetId(logicalSheetId) ||
      logicalSheetId !== workspace.activeSheetId ||
      !validRange(selection.range)
    ) {
      return preflightFailure(
        get,
        set,
        owner,
        'FORMAT_PAINTER_INVALID_TARGET',
        'Format painter target is invalid',
      )
    }
    const logicalTarget = freezeRangeRef(logicalSheetId, selection.range)
    if (
      sameRangeRef(owner.source, logicalTarget) ||
      sameRangeRef(owner.lastTarget, logicalTarget)
    ) {
      return 'blocked'
    }

    const reservation: FormatPainterReservation = Object.freeze({
      token: Object.freeze({}),
      kind: 'preflight',
      reentered: false,
    })
    set(formatPainterReservationAtom, reservation)
    let resolveTargetRanges: unknown
    let setFormatRange: unknown
    let refreshProjection: unknown
    let timeoutValue: unknown
    let physicalTarget: Readonly<CellRange> | null = null
    try {
      try {
        resolveTargetRanges = INTRINSIC_REFLECT_GET(
          input ?? EMPTY_CAPABILITIES,
          'resolveTargetRanges',
        )
        setFormatRange = INTRINSIC_REFLECT_GET(input ?? EMPTY_CAPABILITIES, 'setFormatRange')
        refreshProjection = INTRINSIC_REFLECT_GET(input ?? EMPTY_CAPABILITIES, 'refreshProjection')
        timeoutValue = INTRINSIC_REFLECT_GET(input ?? EMPTY_CAPABILITIES, 'timeoutMs')
      } catch {
        resolveTargetRanges = null
        setFormatRange = null
        refreshProjection = null
        timeoutValue = null
      }
      if (
        typeof resolveTargetRanges !== 'function' ||
        typeof setFormatRange !== 'function' ||
        typeof refreshProjection !== 'function'
      ) {
        return preflightFailure(
          get,
          set,
          owner,
          'FORMAT_PAINTER_PORT_UNAVAILABLE',
          'Format painter mutation and refresh ports are unavailable',
        )
      }
      let resolved: unknown
      try {
        resolved = INTRINSIC_REFLECT_APPLY(resolveTargetRanges, undefined, [
          logicalTarget.sheetId,
          logicalTarget.range,
        ])
      } catch {
        resolved = null
      }
      physicalTarget = snapshotSingleTargetRange(resolved)
      const liveReservation = get(formatPainterReservationAtom)
      if (
        liveReservation?.token !== reservation.token ||
        liveReservation.reentered ||
        get(formatPainterControllerSourceAtom) !== owner ||
        get(selectionAuthorityWitnessAtom) !== selectionWitness ||
        get(workspaceActiveSheetAuthorityWitnessAtom) !== owner.sourceWorkspaceWitness
      ) {
        return preflightFailure(
          get,
          set,
          owner,
          'FORMAT_PAINTER_REENTRANT_PREFLIGHT',
          'Format painter preflight lost its authority',
        )
      }
      if (physicalTarget === null) {
        return preflightFailure(
          get,
          set,
          owner,
          'FORMAT_PAINTER_NON_CONTIGUOUS_TARGET',
          'Format painter requires exactly one contiguous physical target',
        )
      }
    } finally {
      const live = get(formatPainterReservationAtom)
      if (live?.token === reservation.token) set(formatPainterReservationAtom, null)
    }

    if (
      physicalTarget === null ||
      typeof setFormatRange !== 'function' ||
      typeof refreshProjection !== 'function' ||
      get(formatPainterControllerSourceAtom) !== owner
    ) {
      return 'stale'
    }
    const nextLedger = reserveLedgerSlot(get(formatPainterLedgerSourceAtom))
    const requestId = nextSafeIdentity(get(formatPainterRequestSequenceAtom))
    if (nextLedger === null || requestId === null) {
      return preflightFailure(
        get,
        set,
        owner,
        nextLedger === null ? 'FORMAT_PAINTER_LEDGER_FULL' : 'FORMAT_PAINTER_IDENTITY_EXHAUSTED',
        nextLedger === null
          ? 'Format painter journal is full of unresolved attempts'
          : 'Format painter request identity space is exhausted',
      )
    }
    const target = freezeRangeRef(logicalTarget.sheetId, physicalTarget)
    const operationId = `format-painter-${owner.sessionId}-${requestId}`
    const ticket: FormatPainterMutationTicket = Object.freeze({
      operationId,
      sessionId: owner.sessionId,
      requestId,
      mode: owner.state,
      source: owner.source,
      logicalTarget,
      target,
      format: owner.clipboard.format,
    })
    const attempt: FormatPainterMutationAttempt = Object.freeze({ ...ticket, status: 'pending' })
    const pendingController = controllerPatch(owner, {
      phase: 'pending',
      pendingTicket: ticket,
      error: null,
      blocked: false,
    })
    set(formatPainterRequestSequenceAtom, requestId)
    set(formatPainterLedgerSourceAtom, Object.freeze([...nextLedger, attempt]))
    set(formatPainterControllerSourceAtom, pendingController)

    const backendRequest = Object.freeze({
      kind: 'set-format-range' as const,
      sheetId: target.sheetId,
      range: target.range,
      format: ticket.format,
      requestId: ticket.requestId,
    })
    const dispatchReservation: FormatPainterReservation = Object.freeze({
      token: Object.freeze({}),
      kind: 'dispatch',
      reentered: false,
    })
    set(formatPainterReservationAtom, dispatchReservation)
    let mutationPromise: Promise<unknown>
    let dispatchReentered = false
    try {
      let transportValue: unknown
      try {
        // This invocation is the W0 uncertainty boundary. Every failure from
        // this point is outcome-unknown until an exact receipt is observed.
        transportValue = INTRINSIC_REFLECT_APPLY(setFormatRange, undefined, [backendRequest])
      } catch (error) {
        transportValue = Promise.reject(error)
      }
      mutationPromise = Promise.resolve(transportValue)
      const live = get(formatPainterReservationAtom)
      dispatchReentered =
        live?.token !== dispatchReservation.token ||
        live.reentered ||
        get(formatPainterControllerSourceAtom) !== pendingController
    } finally {
      const live = get(formatPainterReservationAtom)
      if (live?.token === dispatchReservation.token) set(formatPainterReservationAtom, null)
    }

    const timeoutMs = validTimeout(timeoutValue)
    const observation = await observeTransport(mutationPromise, timeoutMs, (late) => {
      const evidence: FormatPainterLateEvidence =
        late.kind === 'rejected'
          ? 'late-rejection'
          : exactAcknowledgement(late.value, ticket)
            ? 'late-exact-acknowledgement'
            : 'late-mismatched-acknowledgement'
      set(
        formatPainterLedgerSourceAtom,
        recordLateEvidence(get(formatPainterLedgerSourceAtom), operationId, evidence),
      )
    })

    let acknowledgementExact = false
    let acknowledgementReentered = dispatchReentered
    if (!dispatchReentered && observation.kind === 'fulfilled') {
      const acknowledgementReservation: FormatPainterReservation = Object.freeze({
        token: Object.freeze({}),
        kind: 'acknowledgement',
        reentered: false,
      })
      set(formatPainterReservationAtom, acknowledgementReservation)
      try {
        acknowledgementExact = exactAcknowledgement(observation.value, ticket)
        const live = get(formatPainterReservationAtom)
        acknowledgementReentered =
          live?.token !== acknowledgementReservation.token || live.reentered
      } finally {
        const live = get(formatPainterReservationAtom)
        if (live?.token === acknowledgementReservation.token) {
          set(formatPainterReservationAtom, null)
        }
      }
    }

    if (observation.kind !== 'fulfilled' || !acknowledgementExact || acknowledgementReentered) {
      const message =
        observation.kind === 'timed-out'
          ? 'Format painter mutation timed out; its outcome is unknown'
          : observation.kind === 'rejected'
            ? 'Format painter mutation rejected after dispatch; its outcome is unknown'
            : acknowledgementReentered
              ? 'Format painter acknowledgement was reentrant; its outcome is unknown'
              : 'Format painter acknowledgement did not exactly match the mutation ticket'
      set(
        formatPainterLedgerSourceAtom,
        settleLedger(get(formatPainterLedgerSourceAtom), operationId, 'outcome-unknown', message),
      )
      const live = get(formatPainterControllerSourceAtom)
      if (currentOwnsTicket(live, ticket)) {
        set(
          formatPainterControllerSourceAtom,
          controllerPatch(live, {
            phase: 'outcome-unknown-blocked',
            pendingTicket: null,
            error: createError('FORMAT_PAINTER_OUTCOME_UNKNOWN', message, 'transport'),
            blocked: true,
          }),
        )
      }
      return 'outcome-unknown'
    }

    set(
      formatPainterLedgerSourceAtom,
      settleLedger(get(formatPainterLedgerSourceAtom), operationId, 'local-acknowledged'),
    )
    const acknowledgedOwner = get(formatPainterControllerSourceAtom)
    if (!currentOwnsTicket(acknowledgedOwner, ticket) || !ownsLiveWorkspace(get, owner, ticket)) {
      return 'stale'
    }
    const locallyAcknowledged =
      ticket.mode === 'armed'
        ? idleController(acknowledgedOwner, 'local-acknowledged')
        : controllerPatch(acknowledgedOwner, {
            phase: 'local-acknowledged',
            lastTarget: ticket.logicalTarget,
            error: null,
            blocked: false,
          })
    // Keep the immutable ticket until refresh settles so a selection drift
    // cannot launch a second mutation against a stale visible projection.
    const refreshing = controllerPatch(locallyAcknowledged, { pendingTicket: ticket })
    set(formatPainterControllerSourceAtom, refreshing)

    const refreshReservation: FormatPainterReservation = Object.freeze({
      token: Object.freeze({}),
      kind: 'refresh',
      reentered: false,
    })
    set(formatPainterReservationAtom, refreshReservation)
    let refreshPromise: Promise<unknown>
    let refreshReentered = false
    try {
      let refreshValue: unknown
      try {
        refreshValue = INTRINSIC_REFLECT_APPLY(refreshProjection, undefined, [
          ticket.target.sheetId,
        ])
      } catch (error) {
        refreshValue = Promise.reject(error)
      }
      refreshPromise = Promise.resolve(refreshValue)
      const live = get(formatPainterReservationAtom)
      refreshReentered = live?.token !== refreshReservation.token || live.reentered
    } finally {
      const live = get(formatPainterReservationAtom)
      if (live?.token === refreshReservation.token) set(formatPainterReservationAtom, null)
    }
    const refreshObservation = await observeTransport(refreshPromise, timeoutMs, () => undefined)
    const refreshSucceeded = refreshObservation.kind === 'fulfilled' && !refreshReentered
    if (!refreshSucceeded) {
      const message =
        'Format painter mutation was acknowledged, but local projection refresh is unknown'
      set(
        formatPainterLedgerSourceAtom,
        settleLedger(
          get(formatPainterLedgerSourceAtom),
          operationId,
          'honest-local-projection-unknown',
          message,
        ),
      )
      const live = get(formatPainterControllerSourceAtom)
      if (currentOwnsTicket(live, ticket)) {
        set(
          formatPainterControllerSourceAtom,
          controllerPatch(live, {
            phase: 'honest-local-projection-unknown',
            pendingTicket: null,
            error: createError('FORMAT_PAINTER_LOCAL_PROJECTION_UNKNOWN', message, 'projection'),
            blocked: true,
          }),
        )
      }
      return 'honest-local-projection-unknown'
    }

    const live = get(formatPainterControllerSourceAtom)
    if (currentOwnsTicket(live, ticket)) {
      set(
        formatPainterControllerSourceAtom,
        controllerPatch(live, { pendingTicket: null, error: null, blocked: false }),
      )
      return 'local-acknowledged'
    }
    return 'stale'
  },
)
applyFormatPainterAtom.debugLabel = 'spreadsheet.formatPainter.apply'
