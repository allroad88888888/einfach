import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type { ProjectionRevision } from '../backend/types'
import {
  acquireHistoryProducerReservationAtom,
  nextHistoryTransactionId,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
  type HistoryProducerReservation,
} from '../history'
import { keyboardModeAtom } from '../keyboard'
import { resolveContentMutationAtom } from './mutation-gateway'
import type {
  EditingCancelIntent,
  EditingCommitAcknowledgement,
  EditingCommitInput,
  EditingCommitIntent,
  EditingCommitLifecycleState,
  EditingCommitMove,
  EditingCommitOutcome,
  EditingCommitRequest,
  EditingControllerPort,
  EditingDraftInput,
  EditingInputSource,
  EditingIntent,
  EditingSessionState,
  EditingSourceCell,
  EditingStartInput,
  EditingStartIntent,
  RetryEditingRefreshInput,
  RunEditingCommitInput,
} from './types'

export * from './types'
export * from './mutation-gateway'

interface EditingCommitTicket {
  readonly operationId: number
  readonly sessionId: number
  readonly requestId: number
  /** Authority captured before caller getters, gateway resolution and acquire. */
  readonly authorityWitness: EditingSessionAuthorityWitness
  readonly sessionWitness: EditingSessionState
  readonly intent: EditingCommitIntent
  readonly request: EditingCommitRequest
  readonly source: EditingControllerPort
  readonly execute: NonNullable<EditingControllerPort['setCellInput']>
  readonly refreshProjection: RunEditingCommitInput['refreshProjection']
  readonly timeoutMs: number
  readonly historyReservation: HistoryProducerReservation
}

interface EditingRawTransportState {
  readonly operationId: number
  readonly settled: boolean
}

interface EditingSessionAuthorityWitness {
  readonly session: EditingSessionState
  readonly sequence: number
  readonly lifecycle: EditingCommitLifecycleState
}

type BoundedEditingOperationResult<T> =
  | { readonly kind: 'fulfilled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }

export const DEFAULT_EDITING_COMMIT_TIMEOUT_MS = 15_000

const INITIAL_EDITING_LIFECYCLE: EditingCommitLifecycleState = Object.freeze({
  status: 'ready',
  sessionId: 0,
  requestId: null,
  sheetId: null,
  cell: null,
  acknowledgedRevision: null,
  error: '',
})

function snapshotSource(source: EditingSourceCell): EditingSourceCell {
  return Object.freeze({
    sheetId: source.sheetId,
    cell: Object.freeze({ row: source.cell.row, col: source.cell.col }),
    source: source.source,
  })
}

function snapshotSession(state: EditingSessionState): EditingSessionState {
  return Object.freeze({
    status: state.status,
    source: state.source === null ? null : snapshotSource(state.source),
    draft: state.draft,
    diagnostic: state.diagnostic === null ? null : Object.freeze({ ...state.diagnostic }),
  })
}

function lifecycleFor(
  status: EditingCommitLifecycleState['status'],
  input: {
    readonly sessionId?: number
    readonly requestId?: number | null
    readonly sheetId?: string | null
    readonly cell?: Readonly<{ row: number; col: number }> | null
    readonly acknowledgedRevision?: ProjectionRevision | null
    readonly error?: string
  } = {},
): EditingCommitLifecycleState {
  return Object.freeze({
    status,
    sessionId: input.sessionId ?? 0,
    requestId: input.requestId ?? null,
    sheetId: input.sheetId ?? null,
    cell:
      input.cell === null || input.cell === undefined
        ? null
        : Object.freeze({ row: input.cell.row, col: input.cell.col }),
    acknowledgedRevision: input.acknowledgedRevision ?? null,
    error: input.error ?? '',
  })
}

function lifecycleForTicket(
  status: EditingCommitLifecycleState['status'],
  ticket: EditingCommitTicket,
  acknowledgedRevision: ProjectionRevision | null = null,
  error = '',
): EditingCommitLifecycleState {
  return lifecycleFor(status, {
    sessionId: ticket.sessionId,
    requestId: ticket.requestId,
    sheetId: ticket.request.sheetId,
    cell: ticket.intent.cell,
    acknowledgedRevision,
    error,
  })
}

function nextSafeIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null
  return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : null
}

function normalizeEditingTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_EDITING_COMMIT_TIMEOUT_MS
}

/**
 * Own both continuations of the host promise. Once the finite timer wins,
 * later fulfilment and rejection are observed but cannot affect Core state.
 */
function runBoundedEditingOperation<T>(
  launch: () => Promise<T>,
  timeoutMs: number,
): Promise<BoundedEditingOperationResult<T>> {
  return new Promise((resolve) => {
    let active = true
    const finish = (result: BoundedEditingOperationResult<T>): void => {
      if (!active) return
      active = false
      clearTimeout(timer)
      resolve(Object.freeze(result))
    }
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' })
    }, timeoutMs)

    let pending: Promise<T>
    try {
      pending = Promise.resolve(launch())
    } catch (error) {
      finish({ kind: 'rejected', error })
      return
    }
    pending.then(
      (value) => {
        finish({ kind: 'fulfilled', value })
      },
      (error) => {
        finish({ kind: 'rejected', error })
      },
    )
  })
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message
      if (typeof message === 'string') return message
    }
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown editing transport failure.'
  }
}

function isValidMutationRevision(value: unknown): value is ProjectionRevision {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0
  }
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== '0'
}

function isSafeCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function snapshotAcknowledgement(
  value: unknown,
  ticket: EditingCommitTicket,
): EditingCommitAcknowledgement | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const result = value as Partial<EditingCommitAcknowledgement>
    // Every untrusted ACK field is detached exactly once. In particular, do
    // not spread affectedRange: accessors may be stateful or synchronously
    // re-enter Core.
    const sheetId = result.sheetId
    const requestId = result.requestId
    const revision = result.revision
    const rangeValue = result.affectedRange
    if (
      sheetId !== ticket.request.sheetId ||
      requestId !== ticket.requestId ||
      !Number.isSafeInteger(requestId) ||
      !isValidMutationRevision(revision)
    ) {
      return null
    }

    let affectedRange: EditingCommitAcknowledgement['affectedRange']
    if (rangeValue !== undefined) {
      if (typeof rangeValue !== 'object' || rangeValue === null) return null
      const rowStart = rangeValue.rowStart
      const rowEnd = rangeValue.rowEnd
      const colStart = rangeValue.colStart
      const colEnd = rangeValue.colEnd
      if (
        !isSafeCoord(rowStart) ||
        !isSafeCoord(rowEnd) ||
        !isSafeCoord(colStart) ||
        !isSafeCoord(colEnd) ||
        rowStart > ticket.request.row ||
        rowEnd < ticket.request.row ||
        colStart > ticket.request.col ||
        colEnd < ticket.request.col
      ) {
        return null
      }
      affectedRange = Object.freeze({ rowStart, rowEnd, colStart, colEnd })
    }

    return Object.freeze({
      sheetId,
      requestId,
      revision,
      ...(affectedRange === undefined ? {} : { affectedRange }),
    })
  } catch {
    return null
  }
}

type CapturedEditingCommitInput =
  | {
      readonly kind: 'captured'
      readonly source: EditingControllerPort
      readonly execute: NonNullable<EditingControllerPort['setCellInput']>
      readonly commitSource: EditingInputSource | undefined
      readonly move: EditingCommitMove | undefined
      readonly refreshProjection: RunEditingCommitInput['refreshProjection']
      readonly timeoutMs: number
    }
  | { readonly kind: 'invalid' }

function isEditingInputSource(value: unknown): value is EditingInputSource {
  return value === 'cell' || value === 'formula-bar' || value === 'keyboard' || value === 'paste'
}

function isEditingCommitMove(value: unknown): value is EditingCommitMove {
  return (
    value === 'none' || value === 'up' || value === 'down' || value === 'left' || value === 'right'
  )
}

function captureEditingCommitInput(input: RunEditingCommitInput): CapturedEditingCommitInput {
  try {
    const source = input.source
    const execute = source?.setCellInput
    const commitSource = input.commitSource
    const move = input.move
    const refreshProjection = input.refreshProjection
    const timeoutValue = input.timeoutMs
    const timeoutMs = normalizeEditingTimeout(timeoutValue)
    if (
      source === null ||
      (typeof source !== 'object' && typeof source !== 'function') ||
      typeof execute !== 'function' ||
      (commitSource !== undefined && !isEditingInputSource(commitSource)) ||
      (move !== undefined && !isEditingCommitMove(move)) ||
      typeof refreshProjection !== 'function'
    ) {
      return Object.freeze({ kind: 'invalid' })
    }
    return Object.freeze({
      kind: 'captured',
      source,
      execute,
      commitSource,
      move,
      refreshProjection,
      timeoutMs,
    })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

type CapturedEditingRetryInput =
  | {
      readonly kind: 'captured'
      readonly refreshProjection: RetryEditingRefreshInput['refreshProjection']
      readonly timeoutMs: number
    }
  | { readonly kind: 'invalid' }

function captureEditingRetryInput(input: RetryEditingRefreshInput): CapturedEditingRetryInput {
  try {
    const refreshProjection = input.refreshProjection
    const timeoutValue = input.timeoutMs
    const timeoutMs = normalizeEditingTimeout(timeoutValue)
    if (typeof refreshProjection !== 'function') {
      return Object.freeze({ kind: 'invalid' })
    }
    return Object.freeze({ kind: 'captured', refreshProjection, timeoutMs })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

export function createEditingSessionState(): EditingSessionState {
  return Object.freeze({
    status: 'idle',
    source: null,
    draft: '',
    diagnostic: null,
  })
}

export function startEditingSessionState(
  _state: EditingSessionState,
  input: EditingStartInput,
): EditingSessionState {
  return snapshotSession({
    status: 'drafting',
    source: {
      sheetId: input.sheetId,
      cell: {
        row: input.cell.row,
        col: input.cell.col,
      },
      source: input.source,
    },
    draft: input.draft,
    diagnostic: null,
  })
}

export function updateEditingDraftState(
  state: EditingSessionState,
  input: EditingDraftInput,
): EditingSessionState {
  if (state.status === 'idle' && state.source === null) {
    return state
  }

  return snapshotSession({
    ...state,
    status: 'drafting',
    draft: input.draft,
    source: state.source
      ? {
          sheetId: state.source.sheetId,
          cell: {
            row: state.source.cell.row,
            col: state.source.cell.col,
          },
          source: input.source ?? state.source.source,
        }
      : null,
  })
}

export function commitEditingSessionState(
  state: EditingSessionState,
  input: EditingCommitInput,
): EditingSessionState {
  if (state.source === null) {
    return state
  }

  return snapshotSession({
    status: 'drafting',
    source: {
      ...state.source,
      source: input.source ?? state.source.source,
    },
    draft: input.input,
    diagnostic: null,
  })
}

export function cancelEditingSessionState(state: EditingSessionState): EditingSessionState {
  if (state.source === null && state.status === 'idle') {
    return state
  }

  return Object.freeze({
    status: 'cancelled',
    source: null,
    draft: '',
    diagnostic: null,
  })
}

export function createEditingStartIntent(input: EditingStartInput): EditingStartIntent {
  return {
    type: 'editing.start',
    sheetId: input.sheetId,
    cell: {
      row: input.cell.row,
      col: input.cell.col,
    },
    source: input.source,
  }
}

export function createEditingCommitIntent(
  state: EditingSessionState,
  input: EditingCommitInput,
): EditingCommitIntent | null {
  if (state.source === null) {
    return null
  }

  return {
    type: 'editing.commit',
    sheetId: state.source.sheetId,
    cell: {
      row: state.source.cell.row,
      col: state.source.cell.col,
    },
    source: input.source ?? state.source.source,
    input: input.input,
    move: input.move ?? 'none',
  }
}

export function createEditingCancelIntent(state: EditingSessionState): EditingCancelIntent | null {
  if (state.source === null) {
    return null
  }

  return {
    type: 'editing.cancel',
    sheetId: state.source.sheetId,
    cell: {
      row: state.source.cell.row,
      col: state.source.cell.col,
    },
    source: state.source.source,
  }
}

const editingSessionBackingAtom = atom<EditingSessionState>(createEditingSessionState())
editingSessionBackingAtom.debugLabel = 'spreadsheet.editing.sessionBacking'

const editingIntentBackingAtom = atom<EditingIntent | null>(null)
editingIntentBackingAtom.debugLabel = 'spreadsheet.editing.intentBacking'

const editingCommitLifecycleBackingAtom =
  atom<EditingCommitLifecycleState>(INITIAL_EDITING_LIFECYCLE)
editingCommitLifecycleBackingAtom.debugLabel = 'spreadsheet.editing.commitLifecycleBacking'

const activeEditingCommitTicketAtom = atom<EditingCommitTicket | null>(null)
activeEditingCommitTicketAtom.debugLabel = 'spreadsheet.editing.activeCommitTicket'

const editingSessionSequenceAtom = atom(0)
editingSessionSequenceAtom.debugLabel = 'spreadsheet.editing.sessionSequence'

const editingRequestSequenceAtom = atom(0)
editingRequestSequenceAtom.debugLabel = 'spreadsheet.editing.requestSequence'

const editingOperationSequenceAtom = atom(0)
editingOperationSequenceAtom.debugLabel = 'spreadsheet.editing.operationSequence'

const editingRawTransportStateAtom = atom<EditingRawTransportState | null>(null)
editingRawTransportStateAtom.debugLabel = 'spreadsheet.editing.rawTransportState'

function captureEditingSessionAuthority(get: Getter): EditingSessionAuthorityWitness {
  return Object.freeze({
    session: get(editingSessionBackingAtom),
    sequence: get(editingSessionSequenceAtom),
    lifecycle: get(editingCommitLifecycleBackingAtom),
  })
}

function editingSessionAuthorityIsCurrent(
  get: Getter,
  witness: EditingSessionAuthorityWitness,
): boolean {
  return (
    get(activeEditingCommitTicketAtom) === null &&
    get(editingSessionBackingAtom) === witness.session &&
    get(editingSessionSequenceAtom) === witness.sequence &&
    get(editingCommitLifecycleBackingAtom) === witness.lifecycle
  )
}

function editingSessionAuthorityIsCurrentAfterTicket(
  get: Getter,
  witness: EditingSessionAuthorityWitness,
  ticket: EditingCommitTicket,
): boolean {
  return (
    get(activeEditingCommitTicketAtom) === ticket &&
    get(editingSessionBackingAtom) === witness.session &&
    get(editingSessionSequenceAtom) === witness.sequence &&
    get(editingCommitLifecycleBackingAtom) === witness.lifecycle
  )
}

function editingLifecycleBelongsToTicket(
  lifecycle: EditingCommitLifecycleState,
  ticket: EditingCommitTicket,
): boolean {
  return (
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.requestId === ticket.requestId &&
    lifecycle.sheetId === ticket.request.sheetId &&
    lifecycle.cell?.row === ticket.intent.cell.row &&
    lifecycle.cell.col === ticket.intent.cell.col
  )
}

function editingTicketAuthorityIsCurrent(
  get: Getter,
  ticket: EditingCommitTicket,
  lifecycleWitness?: EditingCommitLifecycleState,
): boolean {
  const lifecycle = get(editingCommitLifecycleBackingAtom)
  return (
    get(activeEditingCommitTicketAtom) === ticket &&
    get(editingSessionBackingAtom) === ticket.sessionWitness &&
    get(editingSessionSequenceAtom) === ticket.sessionId &&
    (lifecycleWitness === undefined || lifecycle === lifecycleWitness) &&
    editingLifecycleBelongsToTicket(lifecycle, ticket)
  )
}

function editingTicketStateIsCurrent(
  get: Getter,
  ticket: EditingCommitTicket,
  sessionWitness: EditingSessionState,
  lifecycleWitness: EditingCommitLifecycleState,
): boolean {
  return (
    get(activeEditingCommitTicketAtom) === ticket &&
    get(editingSessionBackingAtom) === sessionWitness &&
    get(editingSessionSequenceAtom) === ticket.sessionId &&
    get(editingCommitLifecycleBackingAtom) === lifecycleWitness
  )
}

function editingRawTransportIsSettled(get: Getter, ticket: EditingCommitTicket): boolean {
  const raw = get(editingRawTransportStateAtom)
  return raw?.operationId === ticket.operationId && raw.settled
}

function markEditingRawTransportSettled(set: Setter, ticket: EditingCommitTicket): void {
  set(editingRawTransportStateAtom, (raw) =>
    raw?.operationId === ticket.operationId && !raw.settled
      ? Object.freeze({ operationId: ticket.operationId, settled: true })
      : raw,
  )
}

/**
 * Release is observable. Keep the old ticket published while committing the
 * terminal session/lifecycle/keyboard state so subscribers cannot start a
 * replacement that this invocation could then overwrite. Clearing the ticket
 * is deliberately the final write.
 */
function finalizeReleasedEditingTicket(
  get: Getter,
  set: Setter,
  ticket: EditingCommitTicket,
  lifecycleWitness: EditingCommitLifecycleState,
): boolean {
  if (!editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness)) return false
  set(editingRawTransportStateAtom, (raw) => (raw?.operationId === ticket.operationId ? null : raw))
  if (
    !editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness) ||
    get(editingRawTransportStateAtom) !== null
  ) {
    return false
  }
  const idleSession = createEditingSessionState()
  const readyLifecycle = lifecycleFor('ready', { sessionId: ticket.sessionId })
  set(editingSessionBackingAtom, idleSession)
  if (!editingTicketStateIsCurrent(get, ticket, idleSession, lifecycleWitness)) return false
  set(editingCommitLifecycleBackingAtom, readyLifecycle)
  if (!editingTicketStateIsCurrent(get, ticket, idleSession, readyLifecycle)) return false
  set(keyboardModeAtom, 'navigation')
  if (!editingTicketStateIsCurrent(get, ticket, idleSession, readyLifecycle)) return false
  set(activeEditingCommitTicketAtom, null)
  return true
}

function completeEditingTicket(
  get: Getter,
  set: Setter,
  ticket: EditingCommitTicket,
  revision: ProjectionRevision,
  lifecycleWitness: EditingCommitLifecycleState,
): EditingCommitOutcome {
  if (
    !editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness) ||
    !editingRawTransportIsSettled(get, ticket)
  ) {
    return 'blocked'
  }
  const released = set(releaseHistoryProducerReservationAtom, ticket.historyReservation)
  if (!editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness)) return 'blocked'
  if (!released) {
    set(
      editingCommitLifecycleBackingAtom,
      lifecycleForTicket(
        'outcome-unknown',
        ticket,
        revision,
        'Editing mutation was refreshed, but history ownership could not be reconciled.',
      ),
    )
    return 'outcome-unknown'
  }

  if (!finalizeReleasedEditingTicket(get, set, ticket, lifecycleWitness)) return 'blocked'
  return 'completed'
}

/**
 * A transport rejection (thrown synchronously or as a rejected promise)
 * before any acknowledgement is observed is a KNOWN failure: the backend
 * never received or never processed the mutation. Unlike an outcome-unknown
 * ACK, nothing here is ambiguous, so the lane and history reservation are
 * released and the frozen draft session is left in place — an explicit
 * retry (or cancel) is safe and expected, not a dead end.
 */
function rejectEditingTicket(
  get: Getter,
  set: Setter,
  ticket: EditingCommitTicket,
  lifecycleWitness: EditingCommitLifecycleState,
  detail: string,
): EditingCommitOutcome {
  if (
    !editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness) ||
    !editingRawTransportIsSettled(get, ticket)
  ) {
    return 'blocked'
  }
  const released = set(releaseHistoryProducerReservationAtom, ticket.historyReservation)
  if (!editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness)) return 'blocked'
  if (!released) {
    set(
      editingCommitLifecycleBackingAtom,
      lifecycleForTicket(
        'outcome-unknown',
        ticket,
        null,
        'Editing commit was rejected, but history ownership could not be reconciled.',
      ),
    )
    return 'outcome-unknown'
  }

  set(editingRawTransportStateAtom, (raw) => (raw?.operationId === ticket.operationId ? null : raw))
  if (
    !editingTicketAuthorityIsCurrent(get, ticket, lifecycleWitness) ||
    get(editingRawTransportStateAtom) !== null
  ) {
    return 'blocked'
  }
  // The frozen draft session is deliberately left untouched: the caller can
  // retry (re-running the commit from the same drafting session) or cancel.
  const rejectedLifecycle = lifecycleForTicket('rejected', ticket, null, detail)
  set(editingCommitLifecycleBackingAtom, rejectedLifecycle)
  if (!editingTicketStateIsCurrent(get, ticket, ticket.sessionWitness, rejectedLifecycle)) {
    return 'blocked'
  }
  // Clearing the ticket last releases the lane for an explicit retry or
  // cancel; a synchronous subscriber may start either from this notification.
  set(activeEditingCommitTicketAtom, null)
  return 'rejected'
}

export const editingSessionAtom: Atom<EditingSessionState> = atom((get) =>
  get(editingSessionBackingAtom),
)
editingSessionAtom.debugLabel = 'spreadsheet.editing.session'

export const editingIntentAtom: Atom<EditingIntent | null> = atom((get) =>
  get(editingIntentBackingAtom),
)
editingIntentAtom.debugLabel = 'spreadsheet.editing.intent'

export const editingCommitLifecycleAtom: Atom<EditingCommitLifecycleState> = atom((get) =>
  get(editingCommitLifecycleBackingAtom),
)
editingCommitLifecycleAtom.debugLabel = 'spreadsheet.editing.commitLifecycle'

/** Exposes reset safety without retaining or revealing the host promise. */
export const editingCommitRawTransportSettledAtom: Atom<boolean> = atom((get) => {
  const ticket = get(activeEditingCommitTicketAtom)
  return ticket !== null && editingRawTransportIsSettled(get, ticket)
})
editingCommitRawTransportSettledAtom.debugLabel = 'spreadsheet.editing.rawTransportSettled'

export const editingIsActiveAtom = atom((get) => get(editingSessionAtom).status === 'drafting')
editingIsActiveAtom.debugLabel = 'spreadsheet.editing.isActive'

export const editingDraftAtom = atom(
  (get) => get(editingSessionAtom).draft,
  (get, set, input: EditingDraftInput) => {
    if (get(activeEditingCommitTicketAtom) !== null) return
    set(editingSessionBackingAtom, updateEditingDraftState(get(editingSessionAtom), input))
  },
)
editingDraftAtom.debugLabel = 'spreadsheet.editing.draft'

export const startEditingAtom = atom(
  (get) => get(editingSessionAtom),
  (get, set, input: EditingStartInput) => {
    if (get(activeEditingCommitTicketAtom) !== null) return get(editingSessionAtom)
    const sessionId = nextSafeIdentity(get(editingSessionSequenceAtom))
    if (sessionId === null) return get(editingSessionAtom)
    const session = startEditingSessionState(get(editingSessionAtom), input)
    set(editingSessionSequenceAtom, sessionId)
    set(editingSessionBackingAtom, session)
    set(editingIntentBackingAtom, createEditingStartIntent(input))
    set(editingCommitLifecycleBackingAtom, lifecycleFor('ready', { sessionId }))
    set(keyboardModeAtom, 'editing')
    return session
  },
)
startEditingAtom.debugLabel = 'spreadsheet.editing.start'

export const commitEditingAtom = atom(
  (get) => get(editingSessionAtom),
  (get, set, input: EditingCommitInput) => {
    const state = get(editingSessionAtom)
    const intent = createEditingCommitIntent(state, input)
    if (intent === null) {
      return null
    }
    if (get(activeEditingCommitTicketAtom) !== null) return null

    // Legacy intent command: it stages the frozen draft but deliberately does
    // not clear the session. Only the acknowledged async command may finish it.
    set(editingIntentBackingAtom, intent)
    set(editingSessionBackingAtom, commitEditingSessionState(state, input))
    return intent
  },
)
commitEditingAtom.debugLabel = 'spreadsheet.editing.commit'

export const runEditingCommitAtom = atom(
  null,
  async (get, set, input: RunEditingCommitInput): Promise<EditingCommitOutcome> => {
    if (get(activeEditingCommitTicketAtom) !== null) return 'blocked'
    // Witness the exact editable session before touching caller-owned getters.
    // A getter may synchronously run another command, so every later boundary
    // is allowed to proceed only while this same authority is still current.
    const authority = captureEditingSessionAuthority(get)
    const state = authority.session
    if (state.status !== 'drafting' || state.source === null) return 'blocked'

    const captured = captureEditingCommitInput(input)
    if (!editingSessionAuthorityIsCurrent(get, authority)) return 'blocked'
    if (captured.kind === 'invalid') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: authority.sequence,
          sheetId: state.source.sheetId,
          cell: state.source.cell,
          error: 'Editing commit transport or projection refresh is unavailable.',
        }),
      )
      return 'blocked'
    }

    const stagedSession = commitEditingSessionState(state, {
      input: state.draft,
      move: captured.move,
      source: captured.commitSource,
    })
    const derivedIntent = createEditingCommitIntent(stagedSession, {
      input: stagedSession.draft,
      move: captured.move,
      source: captured.commitSource,
    })
    if (derivedIntent === null || !editingSessionAuthorityIsCurrent(get, authority)) {
      return 'blocked'
    }

    // The gateway is a synchronous external boundary: it may publish
    // diagnostics and synchronously notify subscribers. Never adopt a session
    // a notification installed while this call was resolving its target.
    const resolution = set(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: derivedIntent.sheetId,
      cell: derivedIntent.cell,
    })
    if (!editingSessionAuthorityIsCurrent(get, authority)) return 'blocked'
    if (resolution.status === 'blocked') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: authority.sequence,
          sheetId: derivedIntent.sheetId,
          cell: derivedIntent.cell,
          error: resolution.diagnostic.message,
        }),
      )
      return 'blocked'
    }
    const targetCell = resolution.cell ?? derivedIntent.cell

    const requestId = nextSafeIdentity(get(editingRequestSequenceAtom))
    const operationId = nextSafeIdentity(get(editingOperationSequenceAtom))
    if (requestId === null || operationId === null) {
      if (!editingSessionAuthorityIsCurrent(get, authority)) return 'blocked'
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: authority.sequence,
          sheetId: derivedIntent.sheetId,
          cell: targetCell,
          error: 'Editing commit request identity space is exhausted.',
        }),
      )
      return 'blocked'
    }
    const request: EditingCommitRequest = Object.freeze({
      kind: 'set-cell-input',
      sheetId: derivedIntent.sheetId,
      row: targetCell.row,
      col: targetCell.col,
      input: derivedIntent.input,
      requestId,
    })

    // Reserve synchronously before publishing a ticket or crossing the first
    // await. A null reservation leaves the editable session untouched and
    // launches no transport.
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) return 'blocked'
    // Finish the async write's synchronous acquisition phase before adopting
    // the reservation into a ticket. Einfach flushes reservation observers at
    // this boundary, so a subscriber-created replacement session remains the
    // authority instead of being overwritten below.
    await Promise.resolve()
    if (!editingSessionAuthorityIsCurrent(get, authority)) {
      set(releaseHistoryProducerReservationAtom, historyReservation)
      return 'blocked'
    }
    set(editingCommitLifecycleBackingAtom, authority.lifecycle)
    if (!editingSessionAuthorityIsCurrent(get, authority)) {
      // Acquisition itself is observable. Relinquish only the token we just
      // received and perform no editing write against a notification-created
      // replacement session.
      set(releaseHistoryProducerReservationAtom, historyReservation)
      return 'blocked'
    }

    const intent: EditingCommitIntent = Object.freeze({
      type: 'editing.commit',
      sheetId: derivedIntent.sheetId,
      cell: Object.freeze({ row: targetCell.row, col: targetCell.col }),
      source: derivedIntent.source,
      input: derivedIntent.input,
      move: derivedIntent.move,
    })
    const ticket: EditingCommitTicket = Object.freeze({
      operationId,
      sessionId: authority.sequence,
      requestId,
      authorityWitness: authority,
      sessionWitness: stagedSession,
      intent,
      request,
      source: captured.source,
      execute: captured.execute,
      refreshProjection: captured.refreshProjection,
      timeoutMs: captured.timeoutMs,
      historyReservation,
    })

    // The private ticket is the serialization gate. Publish it before any
    // observable editing projection changes, then install the frozen command
    // state while every public re-entry sees the lane as busy.
    set(activeEditingCommitTicketAtom, ticket)
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      !editingSessionAuthorityIsCurrentAfterTicket(get, authority, ticket)
    ) {
      return 'blocked'
    }
    set(editingRequestSequenceAtom, requestId)
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      !editingSessionAuthorityIsCurrentAfterTicket(get, authority, ticket)
    ) {
      return 'blocked'
    }
    set(editingOperationSequenceAtom, operationId)
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      !editingSessionAuthorityIsCurrentAfterTicket(get, authority, ticket)
    ) {
      return 'blocked'
    }
    set(editingRawTransportStateAtom, null)
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      !editingSessionAuthorityIsCurrentAfterTicket(get, authority, ticket)
    ) {
      return 'blocked'
    }
    set(editingSessionBackingAtom, stagedSession)
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      get(editingSessionBackingAtom) !== stagedSession ||
      get(editingSessionSequenceAtom) !== ticket.sessionId ||
      get(editingCommitLifecycleBackingAtom) !== authority.lifecycle
    ) {
      return 'blocked'
    }
    set(editingIntentBackingAtom, ticket.intent)
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      get(editingSessionBackingAtom) !== stagedSession ||
      get(editingSessionSequenceAtom) !== ticket.sessionId ||
      get(editingCommitLifecycleBackingAtom) !== authority.lifecycle
    ) {
      return 'blocked'
    }
    const pendingLifecycle = lifecycleForTicket('pending', ticket)
    set(editingCommitLifecycleBackingAtom, pendingLifecycle)
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'

    // Expose the immutable reservation before transport launch. Same-tick
    // re-entry observes the active ticket and remains inert.
    await Promise.resolve()
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'
    // Einfach defers the initial async write flush until a post-await setter.
    set(editingCommitLifecycleBackingAtom, pendingLifecycle)
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'

    set(
      editingRawTransportStateAtom,
      Object.freeze({ operationId: ticket.operationId, settled: false }),
    )
    // This publication may flush pending/ticket subscribers. Do not cross the
    // irreversible host boundary unless the exact ticket still owns authority.
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'

    let rawTransport: Promise<Awaited<ReturnType<EditingCommitTicket['execute']>>>
    try {
      rawTransport = Promise.resolve(ticket.execute.call(ticket.source, ticket.request))
    } catch (error) {
      const detail = errorMessage(error)
      // A synchronous throw is a KNOWN failure: the transport never returned
      // a pending promise, so nothing was applied. `settled:true` is written
      // before the terminal decision so this path releases the lane exactly
      // like an async rejection does.
      markEditingRawTransportSettled(set, ticket)
      if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'
      return rejectEditingTicket(
        get,
        set,
        ticket,
        pendingLifecycle,
        `Editing commit was rejected and may be retried: ${detail}`,
      )
    }
    const observedTransport = rawTransport.then(
      (value) => {
        markEditingRawTransportSettled(set, ticket)
        return value
      },
      (error: unknown) => {
        markEditingRawTransportSettled(set, ticket)
        throw error
      },
    )

    const transportResult = await runBoundedEditingOperation(
      () => observedTransport,
      ticket.timeoutMs,
    )
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'
    if (transportResult.kind === 'timeout') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'outcome-unknown',
          ticket,
          null,
          'Editing commit timed out; its backend outcome is unknown.',
        ),
      )
      return 'outcome-unknown'
    }
    if (transportResult.kind === 'rejected') {
      const detail = errorMessage(transportResult.error)
      // An async rejection before any acknowledgement is also a KNOWN
      // failure — see rejectEditingTicket.
      if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'
      return rejectEditingTicket(
        get,
        set,
        ticket,
        pendingLifecycle,
        `Editing commit was rejected and may be retried: ${detail}`,
      )
    }

    const acknowledgement = snapshotAcknowledgement(transportResult.value, ticket)
    // ACK fields are untrusted getters and may synchronously re-enter Core.
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'
    if (acknowledgement === null) {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'outcome-unknown',
          ticket,
          null,
          'Editing acknowledgement did not exactly match the active request.',
        ),
      )
      return 'outcome-unknown'
    }

    const affectedRange =
      acknowledgement.affectedRange ??
      Object.freeze({
        rowStart: ticket.request.row,
        rowEnd: ticket.request.row,
        colStart: ticket.request.col,
        colEnd: ticket.request.col,
      })
    const historyRecorded = set(pushReservedHistoryAtom, {
      reservation: ticket.historyReservation,
      entry: Object.freeze({
        transactionId: nextHistoryTransactionId('edit'),
        kind: 'cell.set-input',
        sheetId: ticket.request.sheetId,
        projectionRevision: acknowledgement.revision,
        affectedRange,
      }),
    })
    // Reserved push is observable and may execute hostile subscribers.
    if (!editingTicketAuthorityIsCurrent(get, ticket, pendingLifecycle)) return 'blocked'
    if (!historyRecorded) {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'outcome-unknown',
          ticket,
          acknowledgement.revision,
          'Editing mutation was acknowledged, but history ownership was unavailable.',
        ),
      )
      return 'outcome-unknown'
    }

    const acknowledgedLifecycle = lifecycleForTicket(
      'local-acknowledged',
      ticket,
      acknowledgement.revision,
    )
    set(editingCommitLifecycleBackingAtom, acknowledgedLifecycle)
    if (!editingTicketAuthorityIsCurrent(get, ticket, acknowledgedLifecycle)) return 'blocked'

    await Promise.resolve()
    if (!editingTicketAuthorityIsCurrent(get, ticket, acknowledgedLifecycle)) return 'blocked'
    const refreshingLifecycle = lifecycleForTicket('refreshing', ticket, acknowledgement.revision)
    set(editingCommitLifecycleBackingAtom, refreshingLifecycle)
    if (!editingTicketAuthorityIsCurrent(get, ticket, refreshingLifecycle)) return 'blocked'

    const refreshResult = await runBoundedEditingOperation(
      () => ticket.refreshProjection(ticket.request.sheetId),
      ticket.timeoutMs,
    )
    if (!editingTicketAuthorityIsCurrent(get, ticket, refreshingLifecycle)) return 'blocked'
    if (refreshResult.kind === 'timeout') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          acknowledgement.revision,
          'Editing mutation was acknowledged, but projection refresh timed out.',
        ),
      )
      return 'refresh-failed'
    }
    if (refreshResult.kind === 'rejected') {
      const detail = errorMessage(refreshResult.error)
      if (!editingTicketAuthorityIsCurrent(get, ticket, refreshingLifecycle)) return 'blocked'
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          acknowledgement.revision,
          `Editing mutation was acknowledged, but refresh failed: ${detail}`,
        ),
      )
      return 'refresh-failed'
    }

    return completeEditingTicket(get, set, ticket, acknowledgement.revision, refreshingLifecycle)
  },
)
runEditingCommitAtom.debugLabel = 'spreadsheet.editing.runCommit'

export const retryEditingRefreshAtom = atom(
  null,
  async (get, set, input: RetryEditingRefreshInput): Promise<EditingCommitOutcome> => {
    // Select and witness the exact failed ticket before touching retry input.
    // A retry getter may re-enter and advance the lifecycle to `refreshing`;
    // this superseded invocation must not attach its callback to that attempt.
    const ticket = get(activeEditingCommitTicketAtom)
    const lifecycle = get(editingCommitLifecycleBackingAtom)
    if (
      ticket === null ||
      lifecycle.status !== 'refresh-failed' ||
      lifecycle.acknowledgedRevision === null ||
      !editingTicketAuthorityIsCurrent(get, ticket, lifecycle)
    ) {
      return 'blocked'
    }
    const revision = lifecycle.acknowledgedRevision
    const captured = captureEditingRetryInput(input)
    if (!editingTicketAuthorityIsCurrent(get, ticket, lifecycle)) return 'blocked'
    if (captured.kind === 'invalid') return 'blocked'

    const attempt = Object.freeze({
      ticket,
      lifecycle,
      revision,
      refreshProjection: captured.refreshProjection,
      timeoutMs: captured.timeoutMs,
    })
    const refreshingLifecycle = lifecycleForTicket('refreshing', ticket, revision)
    set(editingCommitLifecycleBackingAtom, refreshingLifecycle)
    if (!editingTicketAuthorityIsCurrent(get, ticket, refreshingLifecycle)) return 'blocked'

    const refreshResult = await runBoundedEditingOperation(
      () => attempt.refreshProjection(attempt.ticket.request.sheetId),
      attempt.timeoutMs,
    )
    if (!editingTicketAuthorityIsCurrent(get, ticket, refreshingLifecycle)) return 'blocked'
    if (refreshResult.kind === 'timeout') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          revision,
          'Editing mutation was acknowledged, but projection refresh retry timed out.',
        ),
      )
      return 'refresh-failed'
    }
    if (refreshResult.kind === 'rejected') {
      const detail = errorMessage(refreshResult.error)
      if (!editingTicketAuthorityIsCurrent(get, ticket, refreshingLifecycle)) return 'blocked'
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          revision,
          `Editing mutation was acknowledged, but refresh retry failed: ${detail}`,
        ),
      )
      return 'refresh-failed'
    }

    return completeEditingTicket(get, set, ticket, revision, refreshingLifecycle)
  },
)
retryEditingRefreshAtom.debugLabel = 'spreadsheet.editing.retryRefresh'

/**
 * Explicitly abandon a retained commit only after both continuations of its
 * raw mutation promise have observed settlement. A timed-out but still-pending
 * host promise cannot be guessed through this boundary.
 */
export const reconcileEditingCommitAtom = atom(null, (get, set): boolean => {
  const ticket = get(activeEditingCommitTicketAtom)
  const lifecycle = get(editingCommitLifecycleBackingAtom)
  const raw = get(editingRawTransportStateAtom)
  if (
    ticket === null ||
    raw?.operationId !== ticket.operationId ||
    raw.settled !== true ||
    !editingTicketAuthorityIsCurrent(get, ticket, lifecycle)
  ) {
    return false
  }

  const released = set(releaseHistoryProducerReservationAtom, ticket.historyReservation)
  if (
    !released ||
    !editingTicketAuthorityIsCurrent(get, ticket, lifecycle) ||
    !editingRawTransportIsSettled(get, ticket)
  ) {
    return false
  }
  return finalizeReleasedEditingTicket(get, set, ticket, lifecycle)
})
reconcileEditingCommitAtom.debugLabel = 'spreadsheet.editing.reconcileCommit'

/** Alias for hosts that present explicit reconciliation as a reset action. */
export const resetEditingCommitAtom = reconcileEditingCommitAtom

export const cancelEditingAtom = atom(
  (get) => get(editingSessionAtom),
  (get, set) => {
    if (get(activeEditingCommitTicketAtom) !== null) return null
    const state = get(editingSessionAtom)
    const intent = createEditingCancelIntent(state)
    if (intent === null) {
      return null
    }

    set(editingIntentBackingAtom, intent)
    set(editingSessionBackingAtom, cancelEditingSessionState(state))
    set(
      editingCommitLifecycleBackingAtom,
      lifecycleFor('ready', { sessionId: get(editingSessionSequenceAtom) }),
    )
    set(keyboardModeAtom, 'navigation')
    return intent
  },
)
cancelEditingAtom.debugLabel = 'spreadsheet.editing.cancel'
