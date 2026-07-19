import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type { ProjectionRequestId, ProjectionRevision } from '../backend/types'
import type {
  HistoryAction,
  HistoryCommandOutcome,
  HistoryEntry,
  HistoryLifecycleState,
  HistoryMutationResult,
  HistoryRedoRequest,
  HistoryStackState,
  HistoryUndoRequest,
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
}

const EMPTY_HISTORY_ENTRIES: readonly HistoryEntry[] = Object.freeze([])
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

function snapshotEntry(entry: HistoryEntry): HistoryEntry {
  const affectedRange = entry.affectedRange ? Object.freeze({ ...entry.affectedRange }) : undefined
  const localReplay = entry.localReplay
    ? Object.freeze({
        applyKey: entry.localReplay.applyKey,
        sheetId: entry.localReplay.sheetId,
        before: entry.localReplay.before,
        after: entry.localReplay.after,
      })
    : undefined
  return Object.freeze({
    transactionId: entry.transactionId,
    kind: entry.kind,
    sheetId: entry.sheetId,
    projectionRevision: entry.projectionRevision,
    ...(affectedRange ? { affectedRange } : {}),
    ...(localReplay ? { localReplay } : {}),
  })
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

function acknowledgementRevision(
  acknowledgement: unknown,
  ticket: HistoryMutationTicket,
): ProjectionRevision | null {
  try {
    if (typeof acknowledgement !== 'object' || acknowledgement === null) return null
    const result = acknowledgement as Partial<HistoryMutationResult>
    if (
      result.transactionId !== ticket.transactionId ||
      result.requestId !== ticket.requestId ||
      !isProjectionRevision(result.revision)
    ) {
      return null
    }
    return result.revision
  } catch {
    return null
  }
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
  return entries.length > 0 && cursor > 0 && get(activeHistoryTicketAtom) === null
})
canUndoAtom.debugLabel = 'spreadsheet.history.canUndo'

export const canRedoAtom = atom((get) => {
  const { entries, cursor } = get(historyStackBackingAtom)
  return cursor < entries.length && get(activeHistoryTicketAtom) === null
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

export const pushHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set, entry: HistoryEntry): boolean => {
    if (get(activeHistoryTicketAtom) !== null) return false
    if (!isProjectionRevision(entry.projectionRevision)) return false
    const state = get(historyStackBackingAtom)
    const base = state.entries.slice(0, state.cursor)
    const snapshot = snapshotEntry(entry)
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
  },
)
pushHistoryAtom.debugLabel = 'spreadsheet.history.pushEntry'

async function runHistoryAction(
  action: HistoryAction,
  get: Getter,
  set: Setter,
  input: RunHistoryCommandInput,
): Promise<HistoryCommandOutcome> {
  if (get(activeHistoryTicketAtom) !== null) return 'blocked'

  const historyWitness = get(historyStackBackingAtom)
  const entry =
    action === 'undo'
      ? historyWitness.entries[historyWitness.cursor - 1]
      : historyWitness.entries[historyWitness.cursor]
  if (!entry) return 'blocked'

  // Local-replay entries close their loop inside UI-core: no backend
  // transport, no revision witness, no ticket — the applier writes the
  // recorded payload synchronously, so nothing can drift mid-flight.
  if (entry.localReplay) {
    const applier = getHistoryLocalReplayApplier(entry.localReplay.applyKey)
    const applied =
      applier !== null && applier(get, set, entry.localReplay, action, input?.source)
    if (!applied) {
      set(
        historyLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: get(historySessionSequenceAtom),
          action,
          transactionId: entry.transactionId,
          error: HISTORY_LOCAL_REPLAY_ERROR,
        }),
      )
      return 'blocked'
    }
    set(
      historyStackBackingAtom,
      stackState(historyWitness.entries, historyWitness.cursor + (action === 'undo' ? -1 : 1)),
    )
    set(
      historyLifecycleBackingAtom,
      lifecycleFor('ready', { sessionId: get(historySessionSequenceAtom) }),
    )
    return 'completed'
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

  let execute:
    | ((request: HistoryUndoRequest | HistoryRedoRequest) => Promise<HistoryMutationResult>)
    | undefined
  try {
    execute = (
      action === 'undo' ? input.source?.undoTransaction : input.source?.redoTransaction
    ) as typeof execute
  } catch {
    execute = undefined
  }
  if (typeof execute !== 'function' || typeof input.refreshProjection !== 'function') {
    set(
      historyLifecycleBackingAtom,
      lifecycleFor('blocked', {
        sessionId: get(historySessionSequenceAtom),
        action,
        error: HISTORY_CAPABILITY_ERROR,
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

  const request = Object.freeze({
    kind: action === 'undo' ? ('undo-transaction' as const) : ('redo-transaction' as const),
    transactionId: entry.transactionId,
    requestId,
    revision,
  }) as HistoryUndoRequest | HistoryRedoRequest
  const ticket: HistoryMutationTicket = Object.freeze({
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
  })
  set(historySessionSequenceAtom, sessionId)
  set(historyRequestSequenceAtom, requestId)
  set(activeHistoryTicketAtom, ticket)
  set(historyLifecycleBackingAtom, lifecycleForTicket('pending', ticket))

  const ownsTicket = (): boolean => {
    const lifecycle = get(historyLifecycleAtom)
    return (
      get(activeHistoryTicketAtom) === ticket &&
      lifecycle.sessionId === ticket.sessionId &&
      lifecycle.requestId === ticket.requestId &&
      lifecycle.action === ticket.action &&
      lifecycle.transactionId === ticket.transactionId &&
      lifecycle.revision === ticket.revision
    )
  }

  // Publish the immutable reservation before transport launch. Same-tick re-entry is inert.
  await Promise.resolve()
  if (!ownsTicket()) return 'blocked'
  // Einfach publishes the first async-write flush on a post-await setter.
  set(historyLifecycleBackingAtom, get(historyLifecycleAtom))

  let acknowledgement: unknown
  try {
    acknowledgement = await withTimeout(
      execute.call(input.source, ticket.request),
      normalizeTimeout(input.timeoutMs),
      `History ${action}`,
    )
  } catch (error) {
    if (!ownsTicket()) return 'blocked'
    set(
      historyLifecycleBackingAtom,
      lifecycleForTicket('outcome-unknown', ticket, null, outcomeUnknownError(errorMessage(error))),
    )
    return 'outcome-unknown'
  }

  if (!ownsTicket()) return 'blocked'
  const acknowledgedRevision = acknowledgementRevision(acknowledgement, ticket)
  if (acknowledgedRevision === null) {
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

  const currentStack = get(historyStackBackingAtom)
  const expectedEntry =
    ticket.action === 'undo'
      ? currentStack.entries[ticket.cursorBefore - 1]
      : currentStack.entries[ticket.cursorBefore]
  if (
    currentStack !== ticket.historyWitness ||
    currentStack.cursor !== ticket.cursorBefore ||
    expectedEntry !== ticket.entry
  ) {
    set(
      historyLifecycleBackingAtom,
      lifecycleForTicket(
        'outcome-unknown',
        ticket,
        acknowledgedRevision,
        outcomeUnknownError('History stack witness changed before acknowledgement.'),
      ),
    )
    return 'outcome-unknown'
  }

  set(historyStackBackingAtom, stackState(ticket.historyWitness.entries, ticket.cursorAfter))
  set(historyProjectionRevisionBackingAtom, acknowledgedRevision)
  set(
    historyLifecycleBackingAtom,
    lifecycleForTicket('local-acknowledged', ticket, acknowledgedRevision),
  )

  await Promise.resolve()
  if (!ownsTicket()) return 'blocked'
  set(historyLifecycleBackingAtom, lifecycleForTicket('refreshing', ticket, acknowledgedRevision))
  try {
    await withTimeout(
      Promise.resolve().then(input.refreshProjection),
      normalizeTimeout(input.timeoutMs),
      'History refresh',
    )
  } catch (error) {
    if (!ownsTicket()) return 'blocked'
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

  if (!ownsTicket()) return 'blocked'
  set(activeHistoryTicketAtom, null)
  set(historyLifecycleBackingAtom, lifecycleFor('ready', { sessionId: ticket.sessionId }))
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
    if (typeof input.refreshProjection !== 'function') return 'blocked'
    const ticket = get(activeHistoryTicketAtom)
    const lifecycle = get(historyLifecycleAtom)
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
    set(historyLifecycleBackingAtom, lifecycleForTicket('refreshing', ticket, acknowledgedRevision))
    try {
      await withTimeout(
        Promise.resolve().then(input.refreshProjection),
        normalizeTimeout(input.timeoutMs),
        'History refresh',
      )
    } catch (error) {
      if (get(activeHistoryTicketAtom) !== ticket) return 'blocked'
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
    if (get(activeHistoryTicketAtom) !== ticket) return 'blocked'
    set(activeHistoryTicketAtom, null)
    set(historyLifecycleBackingAtom, lifecycleFor('ready', { sessionId: ticket.sessionId }))
    return 'completed'
  },
)
retryHistoryRefreshAtom.debugLabel = 'spreadsheet.history.retryRefresh'

export const clearHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set): boolean => {
    if (get(activeHistoryTicketAtom) !== null) return false
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
