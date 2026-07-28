import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type { ProjectionRequestId, ProjectionRevision } from '../backend/types'
import type {
  HistoryAction,
  HistoryCommandOutcome,
  HistoryEntry,
  HistoryEntryKind,
  HistoryLifecycleState,
  HistoryMutationResult,
  HistoryProducerReservation,
  HistoryRedoRequest,
  HistoryStackState,
  HistoryUndoRequest,
  PushReservedHistoryInput,
  RetryHistoryRefreshInput,
  RunHistoryCommandInput,
} from './types'

export * from './types'
export * from './local-replay'

import { getHistoryLocalReplayApplier } from './local-replay'

export const DEFAULT_HISTORY_CAP = 100
export const DEFAULT_HISTORY_TIMEOUT_MS = 15_000

export const HISTORY_CAPABILITY_ERROR =
  'History action is unavailable because this workbook does not provide the required transport.'
export const HISTORY_LOCAL_REPLAY_ERROR =
  'History local replay failed: no applier accepted the entry payload.'
export const HISTORY_REVISION_ERROR =
  'History action is unavailable because the current projection revision is invalid.'
export const HISTORY_PENDING_ERROR = 'Another history action already owns the transport lane.'
export const HISTORY_ACKNOWLEDGEMENT_ERROR =
  'History acknowledgement did not match the active request.'
export const HISTORY_OUTCOME_UNKNOWN_ERROR =
  'History result is unknown. Reload or reconcile workbook data before another history action.'
export const HISTORY_NOT_APPLIED_ERROR =
  'Backend confirmed the history transaction was not applied.'

let historyTransactionCounter = 0

/**
 * Generate a unique, monotonic transaction id for a history entry. Hosts that
 * record a mutation should call this once and reuse the id for the backend
 * mutation and the bounded history descriptor.
 */
export function nextHistoryTransactionId(prefix = 'tx'): string {
  historyTransactionCounter += 1
  return `${prefix}-${historyTransactionCounter}`
}

interface HistoryStackBackingState {
  readonly entries: readonly HistoryEntry[]
  readonly cursor: number
}

interface HistoryMutationTicket {
  readonly sessionId: number
  readonly action: HistoryAction
  readonly transactionId: string
  readonly requestId: ProjectionRequestId
  readonly revision: ProjectionRevision
  readonly cursorBefore: number
  readonly cursorAfter: number
  /** Opaque identity proving that the bounded stack did not drift before ACK. */
  readonly historyWitness: HistoryStackBackingState
  readonly entry: HistoryEntry
  readonly request: HistoryUndoRequest | HistoryRedoRequest
  readonly source: object
  readonly execute: (
    request: HistoryUndoRequest | HistoryRedoRequest,
  ) => Promise<HistoryMutationResult>
  readonly refreshProjection: () => Promise<void>
  readonly timeoutMs: number
}

const EMPTY_HISTORY_ENTRIES: readonly HistoryEntry[] = Object.freeze([])
const MAX_HISTORY_SIDE_PAYLOADS = 64
const HISTORY_ENTRY_KINDS: readonly HistoryEntryKind[] = Object.freeze([
  'cell.set-input',
  'cells.import',
  'range.clear',
  'range.fill',
  'range.merge',
  'range.unmerge',
  'range.sort',
  'row.insert',
  'row.delete',
  'column.insert',
  'column.delete',
  'sheet.add',
  'sheet.delete',
  'sheet.rename',
  'sheet.reorder',
  'format.set',
  'viewport.freeze',
  'viewport.hidden',
  'outline',
  'table.define',
  'filter.set',
])
const INITIAL_HISTORY_STACK: HistoryStackBackingState = Object.freeze({
  entries: EMPTY_HISTORY_ENTRIES,
  cursor: 0,
})

const INITIAL_HISTORY_LIFECYCLE: HistoryLifecycleState = Object.freeze({
  status: 'ready',
  sessionId: 0,
  action: null,
  transactionId: null,
  requestId: null,
  revision: null,
  acknowledgedRevision: null,
  error: '',
})

function snapshotAffectedRange(value: unknown): HistoryEntry['affectedRange'] | null {
  if (typeof value !== 'object' || value === null) return null
  const range = value as Record<string, unknown>
  const rowStart = range.rowStart
  const rowEnd = range.rowEnd
  const colStart = range.colStart
  const colEnd = range.colEnd
  if (
    !Number.isSafeInteger(rowStart) ||
    !Number.isSafeInteger(rowEnd) ||
    !Number.isSafeInteger(colStart) ||
    !Number.isSafeInteger(colEnd) ||
    (rowStart as number) < 0 ||
    (rowEnd as number) < (rowStart as number) ||
    (colStart as number) < 0 ||
    (colEnd as number) < (colStart as number)
  ) {
    return null
  }
  return Object.freeze({
    rowStart: rowStart as number,
    rowEnd: rowEnd as number,
    colStart: colStart as number,
    colEnd: colEnd as number,
  })
}

function snapshotLocalReplayPayload(
  value: unknown,
): NonNullable<HistoryEntry['localReplay']> | null {
  if (typeof value !== 'object' || value === null) return null
  const payload = value as Record<string, unknown>
  const applyKey = payload.applyKey
  const sheetId = payload.sheetId
  const before = payload.before
  const after = payload.after
  if (
    typeof applyKey !== 'string' ||
    applyKey.length === 0 ||
    typeof sheetId !== 'string' ||
    sheetId.length === 0
  ) {
    return null
  }
  return Object.freeze({ applyKey, sheetId, before, after })
}

function isHistoryEntryKind(value: unknown): value is HistoryEntryKind {
  return typeof value === 'string' && HISTORY_ENTRY_KINDS.includes(value as HistoryEntryKind)
}

/**
 * Snapshot the public descriptor boundary once. Every supported caller field
 * is read exactly once; malformed or throwing objects fail closed without
 * leaking a partial descriptor into the bounded stack.
 */
function snapshotEntry(entry: HistoryEntry): HistoryEntry | null {
  try {
    const transactionId = entry.transactionId
    const kind = entry.kind
    const sheetId = entry.sheetId
    const projectionRevision = entry.projectionRevision
    const affectedRangeValue = entry.affectedRange
    const localReplayValue = entry.localReplay
    const localSidePayloadsValue = entry.localSidePayloads

    if (
      typeof transactionId !== 'string' ||
      transactionId.length === 0 ||
      !isHistoryEntryKind(kind) ||
      (sheetId !== null && (typeof sheetId !== 'string' || sheetId.length === 0)) ||
      !isProjectionRevision(projectionRevision)
    ) {
      return null
    }

    let affectedRange: HistoryEntry['affectedRange']
    if (affectedRangeValue !== undefined) {
      affectedRange = snapshotAffectedRange(affectedRangeValue) ?? undefined
      if (affectedRange === undefined) return null
    }

    let localReplay: HistoryEntry['localReplay']
    if (localReplayValue !== undefined) {
      localReplay = snapshotLocalReplayPayload(localReplayValue) ?? undefined
      if (localReplay === undefined) return null
    }

    let localSidePayloads: HistoryEntry['localSidePayloads']
    if (!localReplay && localSidePayloadsValue !== undefined) {
      if (!Array.isArray(localSidePayloadsValue)) return null
      const length = localSidePayloadsValue.length
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HISTORY_SIDE_PAYLOADS) {
        return null
      }
      if (length > 0) {
        const snapshots: NonNullable<HistoryEntry['localReplay']>[] = []
        for (let index = 0; index < length; index += 1) {
          const payloadValue = localSidePayloadsValue[index]
          const payload = snapshotLocalReplayPayload(payloadValue)
          if (payload === null) return null
          snapshots.push(payload)
        }
        localSidePayloads = Object.freeze(snapshots)
      }
    }

    return Object.freeze({
      transactionId,
      kind,
      sheetId,
      projectionRevision,
      ...(affectedRange ? { affectedRange } : {}),
      ...(localReplay ? { localReplay } : {}),
      ...(localSidePayloads ? { localSidePayloads } : {}),
    })
  } catch {
    return null
  }
}

function stackState(entries: readonly HistoryEntry[], cursor: number): HistoryStackBackingState {
  return Object.freeze({ entries: Object.freeze([...entries]), cursor })
}

function lifecycleFor(
  status: HistoryLifecycleState['status'],
  input: {
    readonly sessionId?: number
    readonly action?: HistoryAction | null
    readonly transactionId?: string | null
    readonly requestId?: ProjectionRequestId | null
    readonly revision?: ProjectionRevision | null
    readonly acknowledgedRevision?: ProjectionRevision | null
    readonly error?: string
  } = {},
): HistoryLifecycleState {
  return Object.freeze({
    status,
    sessionId: input.sessionId ?? 0,
    action: input.action ?? null,
    transactionId: input.transactionId ?? null,
    requestId: input.requestId ?? null,
    revision: input.revision ?? null,
    acknowledgedRevision: input.acknowledgedRevision ?? null,
    error: input.error ?? '',
  })
}

function lifecycleForTicket(
  status: HistoryLifecycleState['status'],
  ticket: HistoryMutationTicket,
  acknowledgedRevision: ProjectionRevision | null = null,
  error = '',
): HistoryLifecycleState {
  return lifecycleFor(status, {
    sessionId: ticket.sessionId,
    action: ticket.action,
    transactionId: ticket.transactionId,
    requestId: ticket.requestId,
    revision: ticket.revision,
    acknowledgedRevision,
    error,
  })
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown history transport failure.'
  }
}

function outcomeUnknownError(detail: string): string {
  return `${HISTORY_OUTCOME_UNKNOWN_ERROR} ${detail}`
}

function refreshFailureError(error: unknown): string {
  return `History action was acknowledged, but refresh failed: ${errorMessage(error)}`
}

function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_HISTORY_TIMEOUT_MS
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

function isProjectionRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

type HistoryAcknowledgementSnapshot =
  | {
      readonly kind: 'applied'
      readonly revision: ProjectionRevision
    }
  | {
      readonly kind: 'not-applied'
      readonly reason: string
    }
  | {
      readonly kind: 'malformed'
    }

/**
 * Read the entire caller-owned acknowledgement boundary exactly once before
 * making any decision. `applied: false` is accepted only when it is correlated
 * to the exact request; it is positive proof that the backend did not mutate.
 */
function snapshotAcknowledgement(
  acknowledgement: unknown,
  ticket: HistoryMutationTicket,
): HistoryAcknowledgementSnapshot {
  if (typeof acknowledgement !== 'object' || acknowledgement === null) {
    return Object.freeze({ kind: 'malformed' })
  }
  const result = acknowledgement as Record<string, unknown>
  let malformed = false
  const readOnce = (key: string): unknown => {
    try {
      return result[key]
    } catch {
      malformed = true
      return undefined
    }
  }
  // Do not short-circuit this boundary: even a throwing field must not make
  // another field observable twice on a subsequent classification path.
  const transactionId = readOnce('transactionId')
  const requestId = readOnce('requestId')
  const revision = readOnce('revision')
  const applied = readOnce('applied')
  const notAppliedReason = readOnce('notAppliedReason')

  if (
    malformed ||
    transactionId !== ticket.transactionId ||
    requestId !== ticket.requestId ||
    (applied !== undefined && typeof applied !== 'boolean') ||
    (notAppliedReason !== undefined && typeof notAppliedReason !== 'string')
  ) {
    return Object.freeze({ kind: 'malformed' })
  }
  if (applied === false) {
    return Object.freeze({
      kind: 'not-applied',
      reason: typeof notAppliedReason === 'string' ? notAppliedReason : '',
    })
  }
  if (!isProjectionRevision(revision)) {
    return Object.freeze({ kind: 'malformed' })
  }
  return Object.freeze({ kind: 'applied', revision })
}

function isTransportBusy(status: HistoryLifecycleState['status']): boolean {
  return status === 'pending' || status === 'local-acknowledged' || status === 'refreshing'
}

const historyStackBackingAtom = atom<HistoryStackBackingState>(INITIAL_HISTORY_STACK)
historyStackBackingAtom.debugLabel = 'spreadsheet.history.stackBacking'

const historyLifecycleBackingAtom = atom<HistoryLifecycleState>(INITIAL_HISTORY_LIFECYCLE)
historyLifecycleBackingAtom.debugLabel = 'spreadsheet.history.lifecycleBacking'

const historyProjectionRevisionBackingAtom = atom<ProjectionRevision | null>(null)
historyProjectionRevisionBackingAtom.debugLabel = 'spreadsheet.history.projectionRevisionBacking'

const activeHistoryTicketAtom = atom<HistoryMutationTicket | null>(null)
activeHistoryTicketAtom.debugLabel = 'spreadsheet.history.activeTicket'

const activeHistoryProducerReservationAtom = atom<HistoryProducerReservation | null>(null)
activeHistoryProducerReservationAtom.debugLabel = 'spreadsheet.history.activeProducerReservation'

const historySessionSequenceAtom = atom<number>(0)
historySessionSequenceAtom.debugLabel = 'spreadsheet.history.sessionSequence'

const historyRequestSequenceAtom = atom<number>(0)
historyRequestSequenceAtom.debugLabel = 'spreadsheet.history.requestSequence'

/** Read-only bounded history projection. Commands own all mutations. */
export const historyStackAtom: Atom<HistoryStackState> = atom((get) => {
  const stack = get(historyStackBackingAtom)
  return Object.freeze({
    entries: stack.entries,
    cursor: stack.cursor,
    inFlight: isTransportBusy(get(historyLifecycleBackingAtom).status),
  })
})
historyStackAtom.debugLabel = 'spreadsheet.history.stack'

/** Read-only lifecycle projection. The active ticket itself remains private to Core. */
export const historyLifecycleAtom: Atom<HistoryLifecycleState> = atom((get) =>
  get(historyLifecycleBackingAtom),
)
historyLifecycleAtom.debugLabel = 'spreadsheet.history.lifecycle'

export const historyInFlightAtom = atom((get) => get(historyStackAtom).inFlight)
historyInFlightAtom.debugLabel = 'spreadsheet.history.inFlight'

export const canUndoAtom = atom((get) => {
  const { entries, cursor } = get(historyStackBackingAtom)
  return (
    entries.length > 0 &&
    cursor > 0 &&
    get(activeHistoryTicketAtom) === null &&
    get(activeHistoryProducerReservationAtom) === null
  )
})
canUndoAtom.debugLabel = 'spreadsheet.history.canUndo'

export const canRedoAtom = atom((get) => {
  const { entries, cursor } = get(historyStackBackingAtom)
  return (
    cursor < entries.length &&
    get(activeHistoryTicketAtom) === null &&
    get(activeHistoryProducerReservationAtom) === null
  )
})
canRedoAtom.debugLabel = 'spreadsheet.history.canRedo'

export const historyCanRetryRefreshAtom = atom((get) => {
  const lifecycle = get(historyLifecycleAtom)
  const ticket = get(activeHistoryTicketAtom)
  return (
    ticket !== null &&
    lifecycle.status === 'refresh-failed' &&
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.requestId === ticket.requestId &&
    lifecycle.acknowledgedRevision !== null
  )
})
historyCanRetryRefreshAtom.debugLabel = 'spreadsheet.history.canRetryRefresh'

function appendHistoryEntry(
  get: Getter,
  set: Setter,
  entry: HistoryEntry,
  ownsProducerLane: () => boolean,
): boolean {
  if (!ownsProducerLane()) return false
  const snapshot = snapshotEntry(entry)
  // Snapshotting reads caller-owned input. Re-check the exact lane owner
  // afterwards so a re-entrant getter cannot release or replace the token and
  // still commit an entry.
  if (snapshot === null || !ownsProducerLane()) return false
  const state = get(historyStackBackingAtom)
  const base = state.entries.slice(0, state.cursor)
  const next = [...base, snapshot]
  const capped =
    next.length > DEFAULT_HISTORY_CAP ? next.slice(next.length - DEFAULT_HISTORY_CAP) : next
  set(historyStackBackingAtom, stackState(capped, capped.length))
  // Local-replay entries never advance the backend revision witness —
  // their revisions are session-local labels and mixing them into the
  // strict backend witness would poison later transactional undo.
  if (!snapshot.localReplay) {
    set(historyProjectionRevisionBackingAtom, snapshot.projectionRevision)
  }
  set(
    historyLifecycleBackingAtom,
    lifecycleFor('ready', { sessionId: get(historySessionSequenceAtom) }),
  )
  return true
}

/**
 * Acquire the shared producer lane synchronously, before launching transport.
 * A retained terminal history ticket is still an owner even when `inFlight`
 * projects false, so it blocks producer acquisition until its own workflow
 * explicitly reconciles.
 */
export const acquireHistoryProducerReservationAtom = atom(
  null,
  (get, set): HistoryProducerReservation | null => {
    if (
      get(activeHistoryTicketAtom) !== null ||
      get(activeHistoryProducerReservationAtom) !== null
    ) {
      return null
    }
    const reservation = Object.freeze(
      Object.create(null) as Record<PropertyKey, never>,
    ) as unknown as HistoryProducerReservation
    set(activeHistoryProducerReservationAtom, reservation)
    return reservation
  },
)
acquireHistoryProducerReservationAtom.debugLabel = 'spreadsheet.history.acquireProducerReservation'

/**
 * Append one descriptor for the current producer owner. A producer may call
 * this once per backend transaction while retaining the same reservation.
 */
export const pushReservedHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set, input: PushReservedHistoryInput): boolean => {
    let reservation: HistoryProducerReservation
    let entry: HistoryEntry
    try {
      reservation = input.reservation
      entry = input.entry
    } catch {
      return false
    }
    const ownsProducerLane = (): boolean =>
      get(activeHistoryProducerReservationAtom) === reservation &&
      get(activeHistoryTicketAtom) === null
    if (!ownsProducerLane()) return false
    return appendHistoryEntry(get, set, entry, ownsProducerLane)
  },
)
pushReservedHistoryAtom.debugLabel = 'spreadsheet.history.pushReservedEntry'

/** Release the producer lane only when the exact current owner asks. */
export const releaseHistoryProducerReservationAtom = atom(
  null,
  (get, set, reservation: HistoryProducerReservation): boolean => {
    if (get(activeHistoryProducerReservationAtom) !== reservation) return false
    set(activeHistoryProducerReservationAtom, null)
    return true
  },
)
releaseHistoryProducerReservationAtom.debugLabel = 'spreadsheet.history.releaseProducerReservation'

export const pushHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set, entry: HistoryEntry): boolean => {
    const reservation = set(acquireHistoryProducerReservationAtom)
    if (reservation === null) return false
    const ownsProducerLane = (): boolean =>
      get(activeHistoryProducerReservationAtom) === reservation &&
      get(activeHistoryTicketAtom) === null
    try {
      return appendHistoryEntry(get, set, entry, ownsProducerLane)
    } finally {
      // Exact release is the last write by the legacy push. A synchronous
      // subscriber may start a replacement producer from this notification.
      set(releaseHistoryProducerReservationAtom, reservation)
    }
  },
)
pushHistoryAtom.debugLabel = 'spreadsheet.history.pushEntry'

function historyWitnessOwnsEntry(
  get: Getter,
  action: HistoryAction,
  historyWitness: HistoryStackBackingState,
  entry: HistoryEntry,
): boolean {
  const currentStack = get(historyStackBackingAtom)
  if (currentStack !== historyWitness || currentStack.cursor !== historyWitness.cursor) return false
  const expectedEntry =
    action === 'undo'
      ? currentStack.entries[historyWitness.cursor - 1]
      : currentStack.entries[historyWitness.cursor]
  return expectedEntry === entry
}

async function runHistoryAction(
  action: HistoryAction,
  get: Getter,
  set: Setter,
  input: RunHistoryCommandInput,
): Promise<HistoryCommandOutcome> {
  if (get(activeHistoryTicketAtom) !== null || get(activeHistoryProducerReservationAtom) !== null) {
    return 'blocked'
  }

  const historyWitness = get(historyStackBackingAtom)
  const entry =
    action === 'undo'
      ? historyWitness.entries[historyWitness.cursor - 1]
      : historyWitness.entries[historyWitness.cursor]
  if (!entry) return 'blocked'

  // Local-replay entries close their loop inside UI-core: no backend
  // transport, no revision witness, no ticket. The shared producer lane
  // still guards the full synchronous apply -> cursor/lifecycle commit
  // window: persistence hooks invoked by an applier are caller-owned code
  // and may otherwise re-enter a producer or another history action.
  const localReplay = entry.localReplay
  if (localReplay) {
    const reservation = set(acquireHistoryProducerReservationAtom)
    if (reservation === null) return 'blocked'
    const ownsReservation = (): boolean =>
      get(activeHistoryProducerReservationAtom) === reservation &&
      get(activeHistoryTicketAtom) === null
    const ownsHistoryWitness = (): boolean =>
      historyWitnessOwnsEntry(get, action, historyWitness, entry)
    try {
      if (!ownsReservation() || !ownsHistoryWitness()) return 'blocked'
      let source: RunHistoryCommandInput['source']
      try {
        // Caller-owned command input is read once, while the exact producer
        // reservation makes synchronous re-entry inert.
        source = input.source
      } catch {
        if (ownsReservation() && ownsHistoryWitness()) {
          set(
            historyLifecycleBackingAtom,
            lifecycleFor('blocked', {
              sessionId: get(historySessionSequenceAtom),
              action,
              transactionId: entry.transactionId,
              error: HISTORY_LOCAL_REPLAY_ERROR,
            }),
          )
        }
        return 'blocked'
      }
      if (!ownsReservation() || !ownsHistoryWitness()) return 'blocked'
      const applier = getHistoryLocalReplayApplier(localReplay.applyKey)
      const applied = applier !== null && applier(get, set, localReplay, action, source)
      if (!applied || !ownsReservation()) {
        if (ownsReservation() && ownsHistoryWitness()) {
          set(
            historyLifecycleBackingAtom,
            lifecycleFor('blocked', {
              sessionId: get(historySessionSequenceAtom),
              action,
              transactionId: entry.transactionId,
              error: HISTORY_LOCAL_REPLAY_ERROR,
            }),
          )
        }
        return 'blocked'
      }

      if (!ownsHistoryWitness()) return 'blocked'

      set(
        historyStackBackingAtom,
        stackState(historyWitness.entries, historyWitness.cursor + (action === 'undo' ? -1 : 1)),
      )
      set(
        historyLifecycleBackingAtom,
        lifecycleFor('ready', { sessionId: get(historySessionSequenceAtom) }),
      )
      return 'completed'
    } catch {
      if (ownsReservation() && ownsHistoryWitness()) {
        set(
          historyLifecycleBackingAtom,
          lifecycleFor('blocked', {
            sessionId: get(historySessionSequenceAtom),
            action,
            transactionId: entry.transactionId,
            error: HISTORY_LOCAL_REPLAY_ERROR,
          }),
        )
      }
      return 'blocked'
    } finally {
      set(releaseHistoryProducerReservationAtom, reservation)
    }
  }

  const revision = get(historyProjectionRevisionBackingAtom)
  if (!isProjectionRevision(revision)) {
    set(
      historyLifecycleBackingAtom,
      lifecycleFor('blocked', {
        sessionId: get(historySessionSequenceAtom),
        action,
        transactionId: entry.transactionId,
        error: HISTORY_REVISION_ERROR,
      }),
    )
    return 'blocked'
  }

  const sessionId = nextSafeMonotonicIdentity(get(historySessionSequenceAtom))
  const requestId = nextSafeMonotonicIdentity(get(historyRequestSequenceAtom))
  if (sessionId === null || requestId === null) {
    set(
      historyLifecycleBackingAtom,
      lifecycleFor('blocked', {
        sessionId: get(historySessionSequenceAtom),
        action,
        transactionId: entry.transactionId,
        revision,
        error: 'History identity space is exhausted.',
      }),
    )
    return 'blocked'
  }

  // Use the shared producer reservation as an atomic preparation guard. It is
  // acquired before any caller-owned getter, then handed off to the immutable
  // history ticket without ever opening the lane between the two owners.
  const preparationReservation = set(acquireHistoryProducerReservationAtom)
  if (preparationReservation === null) return 'blocked'
  const ownsPreparation = (): boolean =>
    get(activeHistoryProducerReservationAtom) === preparationReservation &&
    get(activeHistoryTicketAtom) === null &&
    get(historyProjectionRevisionBackingAtom) === revision &&
    historyWitnessOwnsEntry(get, action, historyWitness, entry)

  let preparedTicket: HistoryMutationTicket | null = null
  try {
    if (!ownsPreparation()) return 'blocked'

    let source: RunHistoryCommandInput['source']
    let execute:
      | ((request: HistoryUndoRequest | HistoryRedoRequest) => Promise<HistoryMutationResult>)
      | undefined
    let refreshProjection: RunHistoryCommandInput['refreshProjection']
    let timeoutMs: number
    try {
      source = input.source
      if (!ownsPreparation()) return 'blocked'
      execute = (
        action === 'undo' ? source?.undoTransaction : source?.redoTransaction
      ) as typeof execute
      if (!ownsPreparation()) return 'blocked'
      refreshProjection = input.refreshProjection
      if (!ownsPreparation()) return 'blocked'
      const timeoutValue = input.timeoutMs
      if (!ownsPreparation()) return 'blocked'
      timeoutMs = normalizeTimeout(timeoutValue)
    } catch {
      if (ownsPreparation()) {
        set(
          historyLifecycleBackingAtom,
          lifecycleFor('blocked', {
            sessionId: get(historySessionSequenceAtom),
            action,
            transactionId: entry.transactionId,
            revision,
            error: HISTORY_CAPABILITY_ERROR,
          }),
        )
      }
      return 'blocked'
    }

    if (
      (typeof source !== 'object' && typeof source !== 'function') ||
      source === null ||
      typeof execute !== 'function' ||
      typeof refreshProjection !== 'function' ||
      !ownsPreparation()
    ) {
      if (ownsPreparation()) {
        set(
          historyLifecycleBackingAtom,
          lifecycleFor('blocked', {
            sessionId: get(historySessionSequenceAtom),
            action,
            transactionId: entry.transactionId,
            revision,
            error: HISTORY_CAPABILITY_ERROR,
          }),
        )
      }
      return 'blocked'
    }

    const request = Object.freeze({
      kind: action === 'undo' ? ('undo-transaction' as const) : ('redo-transaction' as const),
      transactionId: entry.transactionId,
      requestId,
      revision,
    }) as HistoryUndoRequest | HistoryRedoRequest
    preparedTicket = Object.freeze({
      sessionId,
      action,
      transactionId: entry.transactionId,
      requestId,
      revision,
      cursorBefore: historyWitness.cursor,
      cursorAfter: historyWitness.cursor + (action === 'undo' ? -1 : 1),
      historyWitness,
      entry,
      request,
      source,
      execute,
      refreshProjection,
      timeoutMs,
    })
    set(historySessionSequenceAtom, sessionId)
    set(historyRequestSequenceAtom, requestId)
    set(activeHistoryTicketAtom, preparedTicket)
    set(historyLifecycleBackingAtom, lifecycleForTicket('pending', preparedTicket))
  } finally {
    // The active ticket (when preparation succeeded) already blocks re-entry.
    // Exact reservation release is the final preparation write.
    set(releaseHistoryProducerReservationAtom, preparationReservation)
  }

  const ticket = preparedTicket
  if (ticket === null) return 'blocked'

  const ownsTicket = (): boolean => {
    const lifecycle = get(historyLifecycleBackingAtom)
    return (
      get(activeHistoryTicketAtom) === ticket &&
      lifecycle.sessionId === ticket.sessionId &&
      lifecycle.requestId === ticket.requestId &&
      lifecycle.action === ticket.action &&
      lifecycle.transactionId === ticket.transactionId &&
      lifecycle.revision === ticket.revision
    )
  }
  const ownsOriginalAuthority = (): boolean =>
    ownsTicket() &&
    get(historyProjectionRevisionBackingAtom) === ticket.revision &&
    historyWitnessOwnsEntry(get, ticket.action, ticket.historyWitness, ticket.entry)

  // Publish the immutable reservation before transport launch. Same-tick re-entry is inert.
  await Promise.resolve()
  if (!ownsOriginalAuthority()) return 'blocked'
  // Einfach publishes the first async-write flush on a post-await setter.
  set(historyLifecycleBackingAtom, get(historyLifecycleBackingAtom))

  let acknowledgement: unknown
  try {
    acknowledgement = await withTimeout(
      Promise.resolve().then(() => ticket.execute.call(ticket.source, ticket.request)),
      ticket.timeoutMs,
      `History ${action}`,
    )
  } catch (error) {
    if (!ownsOriginalAuthority()) return 'blocked'
    set(
      historyLifecycleBackingAtom,
      lifecycleForTicket('outcome-unknown', ticket, null, outcomeUnknownError(errorMessage(error))),
    )
    return 'outcome-unknown'
  }

  if (!ownsOriginalAuthority()) return 'blocked'
  const acknowledgementSnapshot = snapshotAcknowledgement(acknowledgement, ticket)
  // Snapshot getters are caller-owned and may synchronously re-enter Core.
  // Correlation is acted upon only while the exact ticket and pre-ACK stack
  // witness still own the lane.
  if (!ownsOriginalAuthority()) return 'blocked'
  // Structured not-applied detection (design point C). `applied: false`,
  // once correlated to the exact ticket, is a POSITIVE backend statement
  // that nothing was replayed — the cursor must not move and the
  // acknowledged revision must not be committed as the new witness. The
  // lifecycle still lands on the outcome-unknown convention (rather than a
  // releasing 'blocked') because the UI-visible history stack now disagrees
  // with what the backend can replay: re-sending the same undo/redo risks a
  // double-apply if the backend's "not applied" was itself stale or racy.
  // The lane stays locked; hosts recover by reloading or reconciling
  // workbook data before another history action, never by an automatic retry.
  if (acknowledgementSnapshot.kind === 'not-applied') {
    const detail =
      acknowledgementSnapshot.reason.length > 0
        ? `${HISTORY_NOT_APPLIED_ERROR} ${acknowledgementSnapshot.reason}`
        : HISTORY_NOT_APPLIED_ERROR
    set(
      historyLifecycleBackingAtom,
      lifecycleForTicket('outcome-unknown', ticket, null, outcomeUnknownError(detail)),
    )
    return 'outcome-unknown'
  }
  if (acknowledgementSnapshot.kind === 'malformed') {
    set(
      historyLifecycleBackingAtom,
      lifecycleForTicket(
        'outcome-unknown',
        ticket,
        null,
        outcomeUnknownError(HISTORY_ACKNOWLEDGEMENT_ERROR),
      ),
    )
    return 'outcome-unknown'
  }
  const acknowledgedRevision = acknowledgementSnapshot.revision
  const committedStack = stackState(ticket.historyWitness.entries, ticket.cursorAfter)
  set(historyStackBackingAtom, committedStack)
  set(historyProjectionRevisionBackingAtom, acknowledgedRevision)
  const ownsCommittedAuthority = (): boolean =>
    ownsTicket() &&
    get(historyStackBackingAtom) === committedStack &&
    get(historyProjectionRevisionBackingAtom) === acknowledgedRevision
  // Backend-transaction entries may carry side payloads for UI-core
  // canonical view facts the transaction displaced (freeze band, hidden
  // sets). The backend has already replayed its own facts; restore the
  // local ones through the same stateless applier registry. The backend
  // outcome is committed, so an applier miss cannot roll it back — the
  // local restore is best-effort by construction.
  const localSidePayloads = ticket.entry.localSidePayloads
  if (localSidePayloads) {
    for (const payload of localSidePayloads) {
      if (!ownsCommittedAuthority()) return 'blocked'
      const applier = getHistoryLocalReplayApplier(payload.applyKey)
      if (applier !== null) {
        try {
          applier(get, set, payload, ticket.action, ticket.source)
        } catch {
          // The backend transaction is already committed. A local side
          // projection is best-effort and cannot roll the backend back.
        }
        if (!ownsCommittedAuthority()) return 'blocked'
      }
    }
  }
  if (!ownsCommittedAuthority()) return 'blocked'
  set(
    historyLifecycleBackingAtom,
    lifecycleForTicket('local-acknowledged', ticket, acknowledgedRevision),
  )

  await Promise.resolve()
  if (!ownsCommittedAuthority()) return 'blocked'
  set(historyLifecycleBackingAtom, lifecycleForTicket('refreshing', ticket, acknowledgedRevision))
  try {
    await withTimeout(
      Promise.resolve().then(ticket.refreshProjection),
      ticket.timeoutMs,
      'History refresh',
    )
  } catch (error) {
    if (!ownsCommittedAuthority()) return 'blocked'
    set(
      historyLifecycleBackingAtom,
      lifecycleForTicket(
        'refresh-failed',
        ticket,
        acknowledgedRevision,
        refreshFailureError(error),
      ),
    )
    return 'refresh-failed'
  }

  if (!ownsCommittedAuthority()) return 'blocked'
  set(historyLifecycleBackingAtom, lifecycleFor('ready', { sessionId: ticket.sessionId }))
  if (get(activeHistoryTicketAtom) !== ticket) return 'blocked'
  // Clearing is the last write. A synchronous subscriber may start the next
  // history command from this notification and the completed call is inert.
  set(activeHistoryTicketAtom, null)
  return 'completed'
}

export const runUndoHistoryAtom = atom(
  null,
  (get, set, input: RunHistoryCommandInput): Promise<HistoryCommandOutcome> =>
    runHistoryAction('undo', get, set, input),
)
runUndoHistoryAtom.debugLabel = 'spreadsheet.history.runUndo'

export const runRedoHistoryAtom = atom(
  null,
  (get, set, input: RunHistoryCommandInput): Promise<HistoryCommandOutcome> =>
    runHistoryAction('redo', get, set, input),
)
runRedoHistoryAtom.debugLabel = 'spreadsheet.history.runRedo'

export const retryHistoryRefreshAtom = atom(
  null,
  async (get, set, input: RetryHistoryRefreshInput): Promise<HistoryCommandOutcome> => {
    const ticket = get(activeHistoryTicketAtom)
    const lifecycle = get(historyLifecycleBackingAtom)
    if (
      ticket === null ||
      lifecycle.status !== 'refresh-failed' ||
      lifecycle.sessionId !== ticket.sessionId ||
      lifecycle.requestId !== ticket.requestId ||
      lifecycle.acknowledgedRevision === null
    ) {
      return 'blocked'
    }
    const acknowledgedRevision = lifecycle.acknowledgedRevision
    const historyWitness = get(historyStackBackingAtom)
    const projectionRevisionWitness = get(historyProjectionRevisionBackingAtom)
    const ownsRetryWitness = (): boolean =>
      get(activeHistoryTicketAtom) === ticket &&
      get(historyLifecycleBackingAtom) === lifecycle &&
      get(historyStackBackingAtom) === historyWitness &&
      get(historyProjectionRevisionBackingAtom) === projectionRevisionWitness

    let refreshProjection: RetryHistoryRefreshInput['refreshProjection']
    let timeoutMs: number
    try {
      refreshProjection = input.refreshProjection
      if (!ownsRetryWitness()) return 'blocked'
      const timeoutValue = input.timeoutMs
      if (!ownsRetryWitness()) return 'blocked'
      timeoutMs = normalizeTimeout(timeoutValue)
    } catch {
      return 'blocked'
    }
    if (typeof refreshProjection !== 'function' || !ownsRetryWitness()) return 'blocked'

    const attempt = Object.freeze({
      ticket,
      lifecycle,
      acknowledgedRevision,
      historyWitness,
      projectionRevisionWitness,
      refreshProjection,
      timeoutMs,
    })
    set(historyLifecycleBackingAtom, lifecycleForTicket('refreshing', ticket, acknowledgedRevision))
    const ownsAttempt = (): boolean => {
      const currentLifecycle = get(historyLifecycleBackingAtom)
      return (
        get(activeHistoryTicketAtom) === attempt.ticket &&
        get(historyStackBackingAtom) === attempt.historyWitness &&
        get(historyProjectionRevisionBackingAtom) === attempt.projectionRevisionWitness &&
        currentLifecycle.status === 'refreshing' &&
        currentLifecycle.sessionId === attempt.ticket.sessionId &&
        currentLifecycle.requestId === attempt.ticket.requestId &&
        currentLifecycle.acknowledgedRevision === attempt.acknowledgedRevision
      )
    }
    if (!ownsAttempt()) return 'blocked'
    try {
      await withTimeout(
        Promise.resolve().then(attempt.refreshProjection),
        attempt.timeoutMs,
        'History refresh',
      )
    } catch (error) {
      if (!ownsAttempt()) return 'blocked'
      set(
        historyLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          acknowledgedRevision,
          refreshFailureError(error),
        ),
      )
      return 'refresh-failed'
    }
    if (!ownsAttempt()) return 'blocked'
    set(historyLifecycleBackingAtom, lifecycleFor('ready', { sessionId: ticket.sessionId }))
    if (get(activeHistoryTicketAtom) !== ticket) return 'blocked'
    // Final projection/lifecycle is committed before the exact ticket is
    // cleared. No write from this retry occurs after replacement can start.
    set(activeHistoryTicketAtom, null)
    return 'completed'
  },
)
retryHistoryRefreshAtom.debugLabel = 'spreadsheet.history.retryRefresh'

export const clearHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set): boolean => {
    if (
      get(activeHistoryTicketAtom) !== null ||
      get(activeHistoryProducerReservationAtom) !== null
    ) {
      return false
    }
    set(historyStackBackingAtom, INITIAL_HISTORY_STACK)
    set(historyProjectionRevisionBackingAtom, null)
    set(
      historyLifecycleBackingAtom,
      lifecycleFor('ready', { sessionId: get(historySessionSequenceAtom) }),
    )
    return true
  },
)
clearHistoryAtom.debugLabel = 'spreadsheet.history.clear'
