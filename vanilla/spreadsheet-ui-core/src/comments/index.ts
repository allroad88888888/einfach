import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  CommentIntent,
  CommentMutationAcknowledgement,
  CommentMutationAction,
  CommentMutationPortSource,
  CommentMutationState,
  CommentOperationAttempt,
  CommentOperationAttemptStatus,
  CommentRuntimeStatus,
  CommentSessionState,
  PostCommentRequest,
  ResolveCommentThreadRequest,
  RunCommentMutationInput,
} from './types'

export * from './types'

export const COMMENT_MUTATION_LEDGER_MAX = 32
export const COMMENT_MUTATION_TIMEOUT_MS = 15_000

const COMMENT_BODY_MAX = 32_768
const COMMENT_ID_MAX = 1_024

const INITIAL_MUTATION_STATE: CommentMutationState = Object.freeze({
  phase: 'Idle',
  action: null,
  requestId: null,
  error: null,
})

interface CommentEditorAuthorityState {
  readonly sessionId: number
  readonly session: Readonly<CommentSessionState> | null
  readonly draft: string
  readonly intent: CommentIntent | null
  readonly mutation: CommentMutationState
}

interface CommentMutationInputSnapshot {
  readonly action: CommentMutationAction
  readonly receiver: CommentMutationPortSource | null
  readonly execute:
    | CommentMutationPortSource['postComment']
    | CommentMutationPortSource['resolveCommentThread']
}

interface CommentMutationCapture {
  readonly kind: 'capture'
  readonly editor: CommentEditorAuthorityState
}

interface CommentMutationTicket {
  readonly sessionId: number
  readonly requestId: number
  readonly operationId: string
  readonly deadlineAt: number
  readonly action: CommentMutationAction
  readonly sheetId: string
  readonly cell: Readonly<{ row: number; col: number }>
  readonly threadId?: string
}

interface CommentMutationReservation {
  readonly kind: 'reservation'
  readonly editor: CommentEditorAuthorityState
  readonly ledger: readonly CommentOperationAttempt[]
  readonly expectedSequence: number
  readonly input: CommentMutationInputSnapshot
  readonly ticket: CommentMutationTicket
  readonly request: Readonly<PostCommentRequest | ResolveCommentThreadRequest>
  readonly attempt: CommentOperationAttempt
}

interface CommentAcknowledgementCapture {
  readonly kind: 'acknowledgement-capture'
  readonly ticket: CommentMutationTicket
}

type CommentMutationLaunchState =
  | CommentMutationCapture
  | CommentMutationReservation
  | CommentAcknowledgementCapture
  | null

type CommentTransportOutcome =
  | { readonly kind: 'fulfilled'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'deadline-exceeded' }

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
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
    return 'Unknown comment transport failure'
  }
}

function freezeMutationState(state: CommentMutationState): CommentMutationState {
  return Object.freeze({ ...state })
}

function freezeCell(cell: Readonly<{ row: number; col: number }>): Readonly<{
  row: number
  col: number
}> {
  return Object.freeze({ row: cell.row, col: cell.col })
}

function freezeSession(session: CommentSessionState): Readonly<CommentSessionState> {
  return Object.freeze({
    sheetId: session.sheetId,
    cell: freezeCell(session.cell),
    threadId: session.threadId,
  })
}

function freezeEditorState(state: CommentEditorAuthorityState): CommentEditorAuthorityState {
  return Object.freeze({
    sessionId: state.sessionId,
    session: state.session === null ? null : freezeSession(state.session),
    draft: state.draft,
    intent: state.intent,
    mutation: freezeMutationState(state.mutation),
  })
}

function freezeAttempt(attempt: CommentOperationAttempt): CommentOperationAttempt {
  return Object.freeze({ ...attempt, cell: freezeCell(attempt.cell) })
}

function freezeLedger(
  ledger: readonly CommentOperationAttempt[],
): readonly CommentOperationAttempt[] {
  return Object.freeze(ledger.map(freezeAttempt))
}

function snapshotSession(value: unknown): CommentSessionState | null {
  if (!isObjectRecord(value)) return null
  try {
    const sheetId = value.sheetId
    const cellValue = value.cell
    const threadId = value.threadId
    if (
      typeof sheetId !== 'string' ||
      sheetId.length === 0 ||
      sheetId.length > COMMENT_ID_MAX ||
      !isObjectRecord(cellValue)
    ) {
      return null
    }
    const row = cellValue.row
    const col = cellValue.col
    if (
      typeof row !== 'number' ||
      !Number.isSafeInteger(row) ||
      row < 0 ||
      typeof col !== 'number' ||
      !Number.isSafeInteger(col) ||
      col < 0 ||
      (threadId !== undefined &&
        (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > COMMENT_ID_MAX))
    ) {
      return null
    }
    return {
      sheetId,
      cell: { row, col },
      threadId: threadId as string | undefined,
    }
  } catch {
    return null
  }
}

function sameCell(
  left: Readonly<{ row: number; col: number }>,
  right: Readonly<{ row: number; col: number }>,
): boolean {
  return left.row === right.row && left.col === right.col
}

function sameSessionTarget(
  session: Readonly<CommentSessionState> | null,
  ticket: CommentMutationTicket,
): boolean {
  return (
    session !== null &&
    session.sheetId === ticket.sheetId &&
    sameCell(session.cell, ticket.cell) &&
    session.threadId === ticket.threadId
  )
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

export function nextCommentSessionId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextCommentRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

function reserveAttemptSlot(
  ledger: readonly CommentOperationAttempt[],
): CommentOperationAttempt[] | null {
  const next = [...ledger]
  while (next.length >= COMMENT_MUTATION_LEDGER_MAX) {
    const acknowledgedIndex = next.findIndex((attempt) => attempt.status === 'local-acknowledged')
    if (acknowledgedIndex < 0) return null
    next.splice(acknowledgedIndex, 1)
  }
  return next
}

function settleAttempt(
  ledger: readonly CommentOperationAttempt[],
  operationId: string,
  status: Exclude<CommentOperationAttemptStatus, 'pending'>,
  detail: { readonly error?: string; readonly resultRevision?: string | number },
): readonly CommentOperationAttempt[] {
  return freezeLedger(
    ledger.map((attempt) => {
      if (attempt.operationId !== operationId || attempt.status !== 'pending') return attempt
      return {
        ...attempt,
        status,
        ...(detail.error === undefined ? {} : { error: detail.error }),
        ...(detail.resultRevision === undefined ? {} : { resultRevision: detail.resultRevision }),
      }
    }),
  )
}

function snapshotMutationInput(value: unknown): CommentMutationInputSnapshot | null {
  if (!isObjectRecord(value)) return null
  try {
    const action = value.action
    const sourceValue = value.source
    if (action !== 'post' && action !== 'resolve') return null
    if (sourceValue === undefined) {
      return Object.freeze({ action, receiver: null, execute: undefined })
    }
    if (!isObjectLike(sourceValue)) return null
    const execute = action === 'post' ? sourceValue.postComment : sourceValue.resolveCommentThread
    if (execute !== undefined && typeof execute !== 'function') return null
    return Object.freeze({
      action,
      receiver: sourceValue as unknown as CommentMutationPortSource,
      execute: execute as CommentMutationInputSnapshot['execute'],
    })
  } catch {
    return null
  }
}

function snapshotAffectedRange(
  value: unknown,
  cell: Readonly<{ row: number; col: number }>,
): CommentMutationAcknowledgement['affectedRange'] | null {
  if (!isObjectRecord(value)) return null
  try {
    const rowStart = value.rowStart
    const rowEnd = value.rowEnd
    const colStart = value.colStart
    const colEnd = value.colEnd
    if (
      typeof rowStart !== 'number' ||
      !Number.isSafeInteger(rowStart) ||
      typeof rowEnd !== 'number' ||
      !Number.isSafeInteger(rowEnd) ||
      typeof colStart !== 'number' ||
      !Number.isSafeInteger(colStart) ||
      typeof colEnd !== 'number' ||
      !Number.isSafeInteger(colEnd) ||
      rowStart !== cell.row ||
      rowEnd !== cell.row ||
      colStart !== cell.col ||
      colEnd !== cell.col
    ) {
      return null
    }
    return Object.freeze({ rowStart, rowEnd, colStart, colEnd })
  } catch {
    return null
  }
}

function snapshotAcknowledgement(
  value: unknown,
  ticket: CommentMutationTicket,
): { acknowledgement: CommentMutationAcknowledgement | null; error: string | null } {
  if (!isObjectRecord(value)) {
    return { acknowledgement: null, error: 'Comment acknowledgement must be an object' }
  }
  try {
    const sheetId = value.sheetId
    const requestId = value.requestId
    const revision = value.revision
    const affectedRangeValue = value.affectedRange
    if (typeof sheetId !== 'string' || sheetId !== ticket.sheetId) {
      return {
        acknowledgement: null,
        error: 'Comment acknowledgement targeted a different sheet',
      }
    }
    if (
      typeof requestId !== 'number' ||
      !Number.isSafeInteger(requestId) ||
      requestId !== ticket.requestId
    ) {
      return {
        acknowledgement: null,
        error: 'Comment acknowledgement returned a missing, unsafe, or different request id',
      }
    }
    if (
      revision !== undefined &&
      typeof revision !== 'string' &&
      (typeof revision !== 'number' || !Number.isFinite(revision))
    ) {
      return {
        acknowledgement: null,
        error: 'Comment acknowledgement returned an invalid revision',
      }
    }
    let affectedRange: CommentMutationAcknowledgement['affectedRange']
    if (affectedRangeValue !== undefined) {
      const range = snapshotAffectedRange(affectedRangeValue, ticket.cell)
      if (range === null) {
        return {
          acknowledgement: null,
          error: 'Comment acknowledgement targeted a different cell',
        }
      }
      affectedRange = range
    }
    return {
      acknowledgement: Object.freeze({
        sheetId,
        requestId,
        ...(revision === undefined ? {} : { revision }),
        ...(affectedRange === undefined ? {} : { affectedRange }),
      }),
      error: null,
    }
  } catch {
    return {
      acknowledgement: null,
      error: 'Comment acknowledgement could not be read safely',
    }
  }
}

const INITIAL_EDITOR_STATE: CommentEditorAuthorityState = freezeEditorState({
  sessionId: 0,
  session: null,
  draft: '',
  intent: null,
  mutation: INITIAL_MUTATION_STATE,
})

const commentEditorStateAtom = atom<CommentEditorAuthorityState>(INITIAL_EDITOR_STATE)
commentEditorStateAtom.debugLabel = 'spreadsheet.comments.editorState'

const commentRequestSequenceAtom = atom(0)

const commentMutationLaunchStateAtom = atom<CommentMutationLaunchState>(null)

const commentPendingTicketAtom = atom<CommentMutationTicket | null>(null)

const commentOperationAttemptLedgerStateAtom = atom<readonly CommentOperationAttempt[]>(
  Object.freeze([]),
)
commentOperationAttemptLedgerStateAtom.debugLabel =
  'spreadsheet.comments.operationAttemptLedgerState'

export const commentOperationAttemptLedgerAtom: Atom<readonly CommentOperationAttempt[]> = atom(
  (get) => freezeLedger(get(commentOperationAttemptLedgerStateAtom)),
)
commentOperationAttemptLedgerAtom.debugLabel = 'spreadsheet.comments.operationAttemptLedger'

export const commentMutationStateAtom: Atom<CommentMutationState> = atom((get) =>
  freezeMutationState(get(commentEditorStateAtom).mutation),
)
commentMutationStateAtom.debugLabel = 'spreadsheet.comments.mutationState'

export const commentMutationPendingAtom = atom((get): boolean =>
  get(commentOperationAttemptLedgerStateAtom).some((attempt) => attempt.status === 'pending'),
)
commentMutationPendingAtom.debugLabel = 'spreadsheet.comments.mutationPending'

export const commentMutationBlockedAtom = atom((get): boolean =>
  get(commentOperationAttemptLedgerStateAtom).some(
    (attempt) => attempt.status === 'outcome-unknown',
  ),
)
commentMutationBlockedAtom.debugLabel = 'spreadsheet.comments.mutationBlocked'

export const commentMutationSubmissionBlockedAtom = atom(
  (get): boolean =>
    get(commentMutationLaunchStateAtom) !== null ||
    get(commentOperationAttemptLedgerStateAtom).some(
      (attempt) => attempt.status === 'pending' || attempt.status === 'outcome-unknown',
    ),
)
commentMutationSubmissionBlockedAtom.debugLabel = 'spreadsheet.comments.submissionBlocked'

export const commentRuntimeStatusAtom: Atom<CommentRuntimeStatus> = atom((get) => {
  const editor = get(commentEditorStateAtom)
  if (editor.mutation.phase !== 'Idle') return editor.mutation.phase
  if (editor.session === null) return 'Closed'
  return editor.draft.length === 0 ? 'OpenClean' : 'OpenDirty'
})
commentRuntimeStatusAtom.debugLabel = 'spreadsheet.comments.runtimeStatus'

function invalidateCommentCapture(get: Getter, set: Setter): void {
  const launch = get(commentMutationLaunchStateAtom)
  if (launch !== null) set(commentMutationLaunchStateAtom, null)
}

const replaceCommentSessionAtom = atom(
  null,
  (get, set, value: CommentSessionState | null): void => {
    invalidateCommentCapture(get, set)
    const previous = get(commentEditorStateAtom)
    const sessionId = nextCommentSessionId(previous.sessionId)
    if (sessionId === null) {
      set(
        commentEditorStateAtom,
        freezeEditorState({
          ...previous,
          mutation: {
            phase: 'ErrorOpen',
            action: null,
            requestId: null,
            error: 'Comment session identity space is exhausted or corrupt',
          },
        }),
      )
      return
    }
    const session = value === null ? null : snapshotSession(value)
    if ((value !== null && session === null) || get(commentEditorStateAtom) !== previous) return
    set(
      commentEditorStateAtom,
      freezeEditorState({
        sessionId,
        session: session === null ? null : freezeSession(session),
        draft: '',
        intent: null,
        mutation: INITIAL_MUTATION_STATE,
      }),
    )
  },
)

export const commentSessionAtom = atom(
  (get): Readonly<CommentSessionState> | null => get(commentEditorStateAtom).session,
  (_get, set, value: CommentSessionState | null): void => {
    set(replaceCommentSessionAtom, value)
  },
)
commentSessionAtom.debugLabel = 'spreadsheet.comments.session'

export const commentEditorDraftAtom: Atom<string> = atom(
  (get): string => get(commentEditorStateAtom).draft,
)
commentEditorDraftAtom.debugLabel = 'spreadsheet.comments.draft'

export const commentIntentAtom = atom(
  (get): CommentIntent | null => get(commentEditorStateAtom).intent,
  (get, set, intent: CommentIntent | null): void => {
    invalidateCommentCapture(get, set)
    const editor = get(commentEditorStateAtom)
    if (editor.mutation.phase === 'PendingPublished') return
    set(commentEditorStateAtom, freezeEditorState({ ...editor, intent }))
  },
)
commentIntentAtom.debugLabel = 'spreadsheet.comments.intent'

export const openCommentSessionAtom = atom(null, (_get, set, input: CommentSessionState): void => {
  set(replaceCommentSessionAtom, input)
})
openCommentSessionAtom.debugLabel = 'spreadsheet.comments.openSession'

export const closeCommentSessionAtom = atom(null, (_get, set): void => {
  set(replaceCommentSessionAtom, null)
})
closeCommentSessionAtom.debugLabel = 'spreadsheet.comments.closeSession'

export const setCommentDraftAtom = atom(null, (get, set, draft: string): void => {
  invalidateCommentCapture(get, set)
  const editor = get(commentEditorStateAtom)
  if (
    typeof draft !== 'string' ||
    editor.mutation.phase === 'PendingPublished' ||
    editor.mutation.phase === 'OutcomeUnknownBlocked'
  ) {
    return
  }
  set(
    commentEditorStateAtom,
    freezeEditorState({
      ...editor,
      draft,
      mutation: INITIAL_MUTATION_STATE,
    }),
  )
})
setCommentDraftAtom.debugLabel = 'spreadsheet.comments.setDraft'

function releaseCapture(
  get: Getter,
  set: Setter,
  capture: CommentMutationCapture,
  detail: { readonly phase: 'ErrorOpen' | 'OutcomeUnknownBlocked'; readonly error: string } | null,
): null {
  if (get(commentMutationLaunchStateAtom) !== capture) return null
  const editor = get(commentEditorStateAtom)
  if (detail !== null && editor === capture.editor) {
    set(
      commentEditorStateAtom,
      freezeEditorState({
        ...editor,
        mutation: {
          phase: detail.phase,
          action: null,
          requestId: null,
          error: detail.error,
        },
      }),
    )
  }
  if (get(commentMutationLaunchStateAtom) === capture) {
    set(commentMutationLaunchStateAtom, null)
  }
  return null
}

const reserveCommentMutationLaunchAtom = atom(
  null,
  (get, set, input: RunCommentMutationInput): CommentMutationReservation | null => {
    const existingLaunch = get(commentMutationLaunchStateAtom)
    if (existingLaunch !== null) {
      if (existingLaunch.kind === 'capture' || existingLaunch.kind === 'acknowledgement-capture') {
        // A nested mutation call invalidates the caller-owned getter capture.
        set(commentMutationLaunchStateAtom, null)
      }
      return null
    }

    const editor = get(commentEditorStateAtom)
    if (
      editor.session === null ||
      editor.mutation.phase === 'PendingPublished' ||
      editor.mutation.phase === 'OutcomeUnknownBlocked'
    ) {
      return null
    }

    const capture: CommentMutationCapture = Object.freeze({ kind: 'capture', editor })
    set(commentMutationLaunchStateAtom, capture)

    const ledger = get(commentOperationAttemptLedgerStateAtom)
    if (ledger.some((attempt) => attempt.status === 'outcome-unknown')) {
      return releaseCapture(get, set, capture, {
        phase: 'OutcomeUnknownBlocked',
        error: 'Comments are blocked by an operation with an unknown outcome',
      })
    }
    if (ledger.some((attempt) => attempt.status === 'pending')) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: 'A comment operation is already pending',
      })
    }
    if (reserveAttemptSlot(ledger) === null) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: 'Comment operation journal is full of unresolved attempts',
      })
    }

    const inputSnapshot = snapshotMutationInput(input)
    if (get(commentMutationLaunchStateAtom) !== capture || get(commentEditorStateAtom) !== editor) {
      return releaseCapture(get, set, capture, null)
    }
    if (inputSnapshot === null) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: 'Comment mutation input could not be read safely',
      })
    }
    if (inputSnapshot.execute === undefined || inputSnapshot.receiver === null) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: `Comment ${inputSnapshot.action} is unavailable`,
      })
    }

    const session = editor.session
    if (
      inputSnapshot.action === 'post' &&
      (editor.draft.trim().length === 0 || editor.draft.length > COMMENT_BODY_MAX)
    ) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: 'A non-empty comment body within the supported size is required',
      })
    }
    if (inputSnapshot.action === 'resolve' && session.threadId === undefined) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: 'Resolving a comment requires an exact thread id',
      })
    }

    const expectedSequence = get(commentRequestSequenceAtom)
    const requestId = nextCommentRequestId(expectedSequence)
    if (requestId === null) {
      return releaseCapture(get, set, capture, {
        phase: 'ErrorOpen',
        error: 'Comment request ticket space is exhausted or corrupt',
      })
    }
    if (ledger.some((attempt) => attempt.requestId === requestId)) {
      return releaseCapture(get, set, capture, {
        phase: 'OutcomeUnknownBlocked',
        error: 'Comment request ticket reuse was detected',
      })
    }

    const cell = freezeCell(session.cell)
    const operationId = `comment-${requestId}`
    const deadlineAt = Date.now() + COMMENT_MUTATION_TIMEOUT_MS
    const ticket: CommentMutationTicket = Object.freeze({
      sessionId: editor.sessionId,
      requestId,
      operationId,
      deadlineAt,
      action: inputSnapshot.action,
      sheetId: session.sheetId,
      cell,
      threadId: session.threadId,
    })
    const request: Readonly<PostCommentRequest | ResolveCommentThreadRequest> =
      inputSnapshot.action === 'post'
        ? Object.freeze({
            kind: 'post-comment',
            sheetId: ticket.sheetId,
            cell,
            threadId: ticket.threadId,
            body: editor.draft,
            requestId,
          })
        : Object.freeze({
            kind: 'resolve-comment-thread',
            sheetId: ticket.sheetId,
            threadId: ticket.threadId!,
            requestId,
          })
    const attempt = freezeAttempt({
      operationId,
      requestId,
      sessionId: editor.sessionId,
      deadlineAt,
      action: inputSnapshot.action,
      sheetId: ticket.sheetId,
      cell,
      threadId: ticket.threadId,
      status: 'pending',
    })
    const reservation: CommentMutationReservation = Object.freeze({
      kind: 'reservation',
      editor,
      ledger,
      expectedSequence,
      input: inputSnapshot,
      ticket,
      request,
      attempt,
    })
    if (
      get(commentMutationLaunchStateAtom) !== capture ||
      get(commentEditorStateAtom) !== editor ||
      get(commentRequestSequenceAtom) !== expectedSequence ||
      get(commentOperationAttemptLedgerStateAtom) !== ledger
    ) {
      return releaseCapture(get, set, capture, null)
    }
    set(commentMutationLaunchStateAtom, reservation)
    return reservation
  },
)

function matchesOwnedEditor(
  editor: CommentEditorAuthorityState,
  ticket: CommentMutationTicket,
): boolean {
  return (
    editor.sessionId === ticket.sessionId &&
    sameSessionTarget(editor.session, ticket) &&
    editor.mutation.phase === 'PendingPublished' &&
    editor.mutation.action === ticket.action &&
    editor.mutation.requestId === ticket.requestId
  )
}

const beginCommentMutationLaunchAtom = atom(
  null,
  (get, set, reservation: CommentMutationReservation): boolean => {
    if (
      get(commentMutationLaunchStateAtom) !== reservation ||
      get(commentEditorStateAtom) !== reservation.editor ||
      get(commentRequestSequenceAtom) !== reservation.expectedSequence ||
      get(commentOperationAttemptLedgerStateAtom) !== reservation.ledger ||
      get(commentMutationLaunchStateAtom) !== reservation
    ) {
      return false
    }
    const reservedLedger = reserveAttemptSlot(reservation.ledger)
    if (reservedLedger === null) return false

    const intent: CommentIntent =
      reservation.request.kind === 'post-comment'
        ? { type: 'comment.post', request: reservation.request as PostCommentRequest }
        : {
            type: 'comment.resolve-thread',
            request: reservation.request as ResolveCommentThreadRequest,
          }
    set(commentRequestSequenceAtom, reservation.ticket.requestId)
    set(
      commentOperationAttemptLedgerStateAtom,
      freezeLedger([...reservedLedger, reservation.attempt]),
    )
    set(commentPendingTicketAtom, reservation.ticket)
    set(
      commentEditorStateAtom,
      freezeEditorState({
        ...reservation.editor,
        intent,
        mutation: {
          phase: 'PendingPublished',
          action: reservation.ticket.action,
          requestId: reservation.ticket.requestId,
          error: null,
        },
      }),
    )
    return true
  },
)

const revokeUnlaunchedCommentMutationAtom = atom(
  null,
  (get, set, reservation: CommentMutationReservation): void => {
    const ledger = get(commentOperationAttemptLedgerStateAtom)
    const nextLedger = ledger.filter(
      (attempt) =>
        attempt.operationId !== reservation.ticket.operationId || attempt.status !== 'pending',
    )
    if (nextLedger.length !== ledger.length) {
      set(commentOperationAttemptLedgerStateAtom, freezeLedger(nextLedger))
    }
    if (get(commentPendingTicketAtom) === reservation.ticket) {
      set(commentPendingTicketAtom, null)
    }
    const editor = get(commentEditorStateAtom)
    if (matchesOwnedEditor(editor, reservation.ticket)) {
      set(
        commentEditorStateAtom,
        freezeEditorState({
          ...editor,
          intent: null,
          mutation: {
            phase: 'ErrorOpen',
            action: reservation.ticket.action,
            requestId: reservation.ticket.requestId,
            error: 'Comment target changed before transport dispatch',
          },
        }),
      )
    }
  },
)

const guardCommentTransportLaunchAtom = atom(
  null,
  (get, set, reservation: CommentMutationReservation): boolean => {
    const ledger = get(commentOperationAttemptLedgerStateAtom)
    if (
      get(commentMutationLaunchStateAtom) === reservation &&
      get(commentPendingTicketAtom) === reservation.ticket &&
      get(commentRequestSequenceAtom) === reservation.ticket.requestId &&
      matchesOwnedEditor(get(commentEditorStateAtom), reservation.ticket) &&
      ledger.some(
        (attempt) =>
          attempt.operationId === reservation.ticket.operationId && attempt.status === 'pending',
      ) &&
      get(commentMutationLaunchStateAtom) === reservation
    ) {
      return true
    }
    set(revokeUnlaunchedCommentMutationAtom, reservation)
    return false
  },
)

const releaseCommentMutationLaunchAtom = atom(
  null,
  (get, set, reservation: CommentMutationReservation): void => {
    if (get(commentMutationLaunchStateAtom) === reservation) {
      set(commentMutationLaunchStateAtom, null)
    }
  },
)

const settleCommentAttemptAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: CommentMutationTicket
      readonly status: Exclude<CommentOperationAttemptStatus, 'pending'>
      readonly error?: string
      readonly resultRevision?: string | number
    },
  ): void => {
    set(
      commentOperationAttemptLedgerStateAtom,
      settleAttempt(
        get(commentOperationAttemptLedgerStateAtom),
        input.ticket.operationId,
        input.status,
        { error: input.error, resultRevision: input.resultRevision },
      ),
    )
    if (get(commentPendingTicketAtom) === input.ticket) set(commentPendingTicketAtom, null)
  },
)

const updateOwnedCommentMutationAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: CommentMutationTicket
      readonly phase: 'OutcomeUnknownBlocked' | 'LocalAcknowledged'
      readonly error: string | null
    },
  ): void => {
    const editor = get(commentEditorStateAtom)
    if (!matchesOwnedEditor(editor, input.ticket)) return
    set(
      commentEditorStateAtom,
      freezeEditorState({
        ...editor,
        session: input.phase === 'LocalAcknowledged' ? null : editor.session,
        draft: input.phase === 'LocalAcknowledged' ? '' : editor.draft,
        intent: null,
        mutation: {
          phase: input.phase,
          action: input.ticket.action,
          requestId: input.ticket.requestId,
          error: input.error,
        },
      }),
    )
  },
)

const beginCommentAcknowledgementCaptureAtom = atom(
  null,
  (get, set, ticket: CommentMutationTicket): CommentAcknowledgementCapture | null => {
    if (get(commentMutationLaunchStateAtom) !== null) return null
    const ledger = get(commentOperationAttemptLedgerStateAtom)
    if (
      !ledger.some(
        (attempt) => attempt.operationId === ticket.operationId && attempt.status === 'pending',
      )
    ) {
      return null
    }
    const capture: CommentAcknowledgementCapture = Object.freeze({
      kind: 'acknowledgement-capture',
      ticket,
    })
    set(commentMutationLaunchStateAtom, capture)
    return capture
  },
)

const finishCommentAcknowledgementCaptureAtom = atom(
  null,
  (get, set, capture: CommentAcknowledgementCapture): boolean => {
    if (get(commentMutationLaunchStateAtom) !== capture) return false
    set(commentMutationLaunchStateAtom, null)
    return true
  },
)

function copyMutationRequest(
  request: Readonly<PostCommentRequest | ResolveCommentThreadRequest>,
): PostCommentRequest | ResolveCommentThreadRequest {
  return request.kind === 'post-comment'
    ? {
        kind: request.kind,
        sheetId: request.sheetId,
        cell: { row: request.cell.row, col: request.cell.col },
        threadId: request.threadId,
        body: request.body,
        requestId: request.requestId,
      }
    : {
        kind: request.kind,
        sheetId: request.sheetId,
        threadId: request.threadId,
        requestId: request.requestId,
      }
}

async function executeReservedCommentMutation(
  set: Setter,
  reservation: CommentMutationReservation,
): Promise<void> {
  const started = set(beginCommentMutationLaunchAtom, reservation)
  if (!started) {
    set(releaseCommentMutationLaunchAtom, reservation)
    return
  }

  // Pending editor state and ledger evidence are subscriber-visible first.
  const launchCurrent = set(guardCommentTransportLaunchAtom, reservation)
  set(releaseCommentMutationLaunchAtom, reservation)
  if (!launchCurrent) return

  let deadlineHandle: ReturnType<typeof setTimeout> | null = null
  const deadlineOutcome = new Promise<CommentTransportOutcome>((resolve) => {
    deadlineHandle = setTimeout(
      () => resolve({ kind: 'deadline-exceeded' }),
      Math.max(0, reservation.ticket.deadlineAt - Date.now()),
    )
  })
  let transportOutcome: Promise<CommentTransportOutcome>
  try {
    transportOutcome = Promise.resolve(
      Reflect.apply(reservation.input.execute!, reservation.input.receiver, [
        copyMutationRequest(reservation.request),
      ]),
    ).then<CommentTransportOutcome, CommentTransportOutcome>(
      (value) => ({ kind: 'fulfilled', value }),
      (error) => ({ kind: 'rejected', error }),
    )
  } catch (error) {
    transportOutcome = Promise.resolve({ kind: 'rejected', error })
  }

  const outcome = await Promise.race([transportOutcome, deadlineOutcome])
  if (deadlineHandle !== null) clearTimeout(deadlineHandle)

  if (outcome.kind === 'deadline-exceeded') {
    const message =
      `Comment ${reservation.ticket.action} exceeded the Core deadline; outcome is unknown`
    set(settleCommentAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedCommentMutationAtom, {
      ticket: reservation.ticket,
      phase: 'OutcomeUnknownBlocked',
      error: message,
    })
    return
  }

  if (outcome.kind === 'rejected') {
    const message = errorMessage(outcome.error)
    set(settleCommentAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedCommentMutationAtom, {
      ticket: reservation.ticket,
      phase: 'OutcomeUnknownBlocked',
      error: message,
    })
    return
  }

  const acknowledgementValue = outcome.value

  const capture = set(beginCommentAcknowledgementCaptureAtom, reservation.ticket)
  if (capture === null) {
    const message = 'Comment acknowledgement capture lost local authority'
    set(settleCommentAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedCommentMutationAtom, {
      ticket: reservation.ticket,
      phase: 'OutcomeUnknownBlocked',
      error: message,
    })
    return
  }

  const acknowledgementSnapshot = snapshotAcknowledgement(acknowledgementValue, reservation.ticket)
  const captureStayedCurrent = set(finishCommentAcknowledgementCaptureAtom, capture)
  if (!captureStayedCurrent) {
    const message = 'Comment acknowledgement getters changed Core authority re-entrantly'
    set(settleCommentAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedCommentMutationAtom, {
      ticket: reservation.ticket,
      phase: 'OutcomeUnknownBlocked',
      error: message,
    })
    return
  }

  if (acknowledgementSnapshot.acknowledgement === null) {
    const message =
      acknowledgementSnapshot.error ?? 'Comment acknowledgement was invalid or mismatched'
    set(settleCommentAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedCommentMutationAtom, {
      ticket: reservation.ticket,
      phase: 'OutcomeUnknownBlocked',
      error: message,
    })
    return
  }

  const acknowledgement = acknowledgementSnapshot.acknowledgement
  set(settleCommentAttemptAtom, {
    ticket: reservation.ticket,
    status: 'local-acknowledged',
    resultRevision: acknowledgement.revision,
  })
  set(updateOwnedCommentMutationAtom, {
    ticket: reservation.ticket,
    phase: 'LocalAcknowledged',
    error: null,
  })
}

/**
 * Captures a Core-owned immutable request, publishes pending state, then invokes
 * exactly one selected optional backend port. Fulfillment is local evidence,
 * never a canonical posted/resolved claim.
 */
export const runCommentMutationAtom = atom(
  null,
  (_get, set, input: RunCommentMutationInput): Promise<void> => {
    const reservation = set(reserveCommentMutationLaunchAtom, input)
    if (reservation === null) return Promise.resolve()
    return Promise.resolve().then(() => executeReservedCommentMutation(set, reservation))
  },
)
runCommentMutationAtom.debugLabel = 'spreadsheet.comments.runMutation'
