import { atom } from '@einfach/core'
import type { Atom } from '@einfach/core'
import type { ProjectionRevision } from '../backend/types'
import { nextHistoryTransactionId, pushHistoryAtom } from '../history'
import { keyboardModeAtom } from '../keyboard'
import { resolveContentMutationAtom } from './mutation-gateway'
import type {
  EditingCancelIntent,
  EditingCommitAcknowledgement,
  EditingCommitInput,
  EditingCommitIntent,
  EditingCommitLifecycleState,
  EditingCommitOutcome,
  EditingCommitRequest,
  EditingControllerPort,
  EditingDraftInput,
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
  readonly sessionId: number
  readonly requestId: number
  readonly sessionWitness: EditingSessionState
  readonly intent: EditingCommitIntent
  readonly request: EditingCommitRequest
}

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

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
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
    if (
      result.sheetId !== ticket.request.sheetId ||
      result.requestId !== ticket.requestId ||
      !Number.isSafeInteger(result.requestId) ||
      !isValidMutationRevision(result.revision)
    ) {
      return null
    }

    let affectedRange: EditingCommitAcknowledgement['affectedRange']
    if (result.affectedRange !== undefined) {
      const range = result.affectedRange
      if (
        !isSafeCoord(range.rowStart) ||
        !isSafeCoord(range.rowEnd) ||
        !isSafeCoord(range.colStart) ||
        !isSafeCoord(range.colEnd) ||
        range.rowStart > ticket.intent.cell.row ||
        range.rowEnd < ticket.intent.cell.row ||
        range.colStart > ticket.intent.cell.col ||
        range.colEnd < ticket.intent.cell.col
      ) {
        return null
      }
      affectedRange = Object.freeze({ ...range })
    }

    return Object.freeze({
      sheetId: result.sheetId,
      requestId: result.requestId,
      revision: result.revision,
      ...(affectedRange === undefined ? {} : { affectedRange }),
    })
  } catch {
    return null
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
    const state = get(editingSessionAtom)
    if (state.status !== 'drafting' || state.source === null) return 'blocked'

    let execute: EditingControllerPort['setCellInput']
    try {
      execute = input.source.setCellInput
    } catch {
      execute = undefined
    }
    if (typeof execute !== 'function' || typeof input.refreshProjection !== 'function') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: get(editingSessionSequenceAtom),
          sheetId: state.source.sheetId,
          cell: state.source.cell,
          error: 'Editing commit transport or projection refresh is unavailable.',
        }),
      )
      return 'blocked'
    }

    const requestId = nextSafeIdentity(get(editingRequestSequenceAtom))
    if (requestId === null) {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: get(editingSessionSequenceAtom),
          sheetId: state.source.sheetId,
          cell: state.source.cell,
          error: 'Editing commit request identity space is exhausted.',
        }),
      )
      return 'blocked'
    }

    const stagedSession = commitEditingSessionState(state, {
      input: state.draft,
      move: input.move,
      source: input.commitSource,
    })
    const intent = createEditingCommitIntent(stagedSession, {
      input: stagedSession.draft,
      move: input.move,
      source: input.commitSource,
    })
    if (intent === null) return 'blocked'

    // Mutation gateway: remap the display-coordinate session cell to its
    // source row (filter/sort) and enforce the protection gate. A blocked
    // resolution never reaches the transport (fail-closed).
    const resolution = set(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: intent.sheetId,
      cell: intent.cell,
    })
    if (resolution.status === 'blocked') {
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: get(editingSessionSequenceAtom),
          sheetId: intent.sheetId,
          cell: intent.cell,
          error: resolution.diagnostic.message,
        }),
      )
      return 'blocked'
    }
    const targetCell = resolution.cell ?? intent.cell

    const request: EditingCommitRequest = Object.freeze({
      kind: 'set-cell-input',
      sheetId: intent.sheetId,
      row: targetCell.row,
      col: targetCell.col,
      input: intent.input,
      requestId,
    })
    const ticket: EditingCommitTicket = Object.freeze({
      sessionId: get(editingSessionSequenceAtom),
      requestId,
      sessionWitness: stagedSession,
      intent: Object.freeze({ ...intent, cell: Object.freeze({ ...targetCell }) }),
      request,
    })
    set(editingRequestSequenceAtom, requestId)
    set(editingSessionBackingAtom, stagedSession)
    set(editingIntentBackingAtom, ticket.intent)
    set(activeEditingCommitTicketAtom, ticket)
    set(editingCommitLifecycleBackingAtom, lifecycleForTicket('pending', ticket))

    const ownsTicket = (): boolean => {
      const lifecycle = get(editingCommitLifecycleAtom)
      return (
        get(activeEditingCommitTicketAtom) === ticket &&
        get(editingSessionBackingAtom) === ticket.sessionWitness &&
        get(editingSessionSequenceAtom) === ticket.sessionId &&
        lifecycle.sessionId === ticket.sessionId &&
        lifecycle.requestId === ticket.requestId
      )
    }

    // Publish the immutable reservation before transport launch. Same-tick
    // re-entry observes the active ticket and remains inert.
    await Promise.resolve()
    if (!ownsTicket()) return 'blocked'
    set(editingCommitLifecycleBackingAtom, get(editingCommitLifecycleAtom))

    let acknowledgementValue: unknown
    try {
      acknowledgementValue = await execute.call(input.source, ticket.request)
    } catch (error) {
      if (!ownsTicket()) return 'blocked'
      set(activeEditingCommitTicketAtom, null)
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'rejected',
          ticket,
          null,
          `Editing commit was rejected and may be retried: ${errorMessage(error)}`,
        ),
      )
      return 'rejected'
    }

    if (!ownsTicket()) return 'blocked'
    const acknowledgement = snapshotAcknowledgement(acknowledgementValue, ticket)
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

    const historyRecorded = set(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId('edit'),
      kind: 'cell.set-input',
      sheetId: ticket.request.sheetId,
      projectionRevision: acknowledgement.revision,
      affectedRange: acknowledgement.affectedRange ?? {
        rowStart: ticket.request.row,
        rowEnd: ticket.request.row,
        colStart: ticket.request.col,
        colEnd: ticket.request.col,
      },
    })
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
    set(
      editingCommitLifecycleBackingAtom,
      lifecycleForTicket('local-acknowledged', ticket, acknowledgement.revision),
    )

    await Promise.resolve()
    if (!ownsTicket()) return 'blocked'
    set(
      editingCommitLifecycleBackingAtom,
      lifecycleForTicket('refreshing', ticket, acknowledgement.revision),
    )
    try {
      await input.refreshProjection(ticket.request.sheetId)
    } catch (error) {
      if (!ownsTicket()) return 'blocked'
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          acknowledgement.revision,
          `Editing mutation was acknowledged, but refresh failed: ${errorMessage(error)}`,
        ),
      )
      return 'refresh-failed'
    }

    if (!ownsTicket()) return 'blocked'
    set(activeEditingCommitTicketAtom, null)
    set(editingSessionBackingAtom, createEditingSessionState())
    set(editingCommitLifecycleBackingAtom, lifecycleFor('ready', { sessionId: ticket.sessionId }))
    set(keyboardModeAtom, 'navigation')
    return 'completed'
  },
)
runEditingCommitAtom.debugLabel = 'spreadsheet.editing.runCommit'

export const retryEditingRefreshAtom = atom(
  null,
  async (get, set, input: RetryEditingRefreshInput): Promise<EditingCommitOutcome> => {
    if (typeof input.refreshProjection !== 'function') return 'blocked'
    const ticket = get(activeEditingCommitTicketAtom)
    const lifecycle = get(editingCommitLifecycleAtom)
    if (
      ticket === null ||
      lifecycle.status !== 'refresh-failed' ||
      lifecycle.sessionId !== ticket.sessionId ||
      lifecycle.requestId !== ticket.requestId ||
      lifecycle.acknowledgedRevision === null
    ) {
      return 'blocked'
    }
    const revision = lifecycle.acknowledgedRevision
    set(editingCommitLifecycleBackingAtom, lifecycleForTicket('refreshing', ticket, revision))
    try {
      await input.refreshProjection(ticket.request.sheetId)
    } catch (error) {
      if (get(activeEditingCommitTicketAtom) !== ticket) return 'blocked'
      set(
        editingCommitLifecycleBackingAtom,
        lifecycleForTicket(
          'refresh-failed',
          ticket,
          revision,
          `Editing mutation was acknowledged, but refresh failed: ${errorMessage(error)}`,
        ),
      )
      return 'refresh-failed'
    }
    if (
      get(activeEditingCommitTicketAtom) !== ticket ||
      get(editingSessionBackingAtom) !== ticket.sessionWitness
    ) {
      return 'blocked'
    }
    set(activeEditingCommitTicketAtom, null)
    set(editingSessionBackingAtom, createEditingSessionState())
    set(editingCommitLifecycleBackingAtom, lifecycleFor('ready', { sessionId: ticket.sessionId }))
    set(keyboardModeAtom, 'navigation')
    return 'completed'
  },
)
retryEditingRefreshAtom.debugLabel = 'spreadsheet.editing.retryRefresh'

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
