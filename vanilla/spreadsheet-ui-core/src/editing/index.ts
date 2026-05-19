import { atom } from '@einfach/core'
import { keyboardModeAtom } from '../keyboard'
import type { EditingCancelIntent, EditingCommitInput, EditingCommitIntent, EditingDraftInput, EditingIntent, EditingSessionState, EditingStartInput, EditingStartIntent } from './types'

export * from './types'

export function createEditingSessionState(): EditingSessionState {
  return {
    status: 'idle',
    source: null,
    draft: '',
    diagnostic: null,
  }
}

export function startEditingSessionState(
  _state: EditingSessionState,
  input: EditingStartInput,
): EditingSessionState {
  return {
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
  }
}

export function updateEditingDraftState(
  state: EditingSessionState,
  input: EditingDraftInput,
): EditingSessionState {
  if (state.status === 'idle' && state.source === null) {
    return state
  }

  return {
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
  }
}

export function commitEditingSessionState(
  state: EditingSessionState,
  input: EditingCommitInput,
): EditingSessionState {
  if (state.source === null) {
    return state
  }

  return {
    status: 'idle',
    source: null,
    draft: '',
    diagnostic: null,
  }
}

export function cancelEditingSessionState(
  state: EditingSessionState,
): EditingSessionState {
  if (state.source === null && state.status === 'idle') {
    return state
  }

  return {
    status: 'cancelled',
    source: null,
    draft: '',
    diagnostic: null,
  }
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

export function createEditingCancelIntent(
  state: EditingSessionState,
): EditingCancelIntent | null {
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

export const editingSessionAtom = atom<EditingSessionState>(createEditingSessionState())
editingSessionAtom.debugLabel = 'spreadsheet.editing.session'

export const editingIntentAtom = atom<EditingIntent | null>(null)
editingIntentAtom.debugLabel = 'spreadsheet.editing.intent'

export const editingIsActiveAtom = atom((get) => get(editingSessionAtom).status === 'drafting')
editingIsActiveAtom.debugLabel = 'spreadsheet.editing.isActive'

export const editingDraftAtom = atom(
  (get) => get(editingSessionAtom).draft,
  (get, set, input: EditingDraftInput) => {
    set(editingSessionAtom, updateEditingDraftState(get(editingSessionAtom), input))
  },
)
editingDraftAtom.debugLabel = 'spreadsheet.editing.draft'

export const startEditingAtom = atom(
  (get) => get(editingSessionAtom),
  (get, set, input: EditingStartInput) => {
    set(editingSessionAtom, startEditingSessionState(get(editingSessionAtom), input))
    set(editingIntentAtom, createEditingStartIntent(input))
    set(keyboardModeAtom, 'editing')
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

    set(editingIntentAtom, intent)
    set(editingSessionAtom, commitEditingSessionState(state, input))
    set(keyboardModeAtom, 'navigation')
    return intent
  },
)
commitEditingAtom.debugLabel = 'spreadsheet.editing.commit'

export const cancelEditingAtom = atom(
  (get) => get(editingSessionAtom),
  (get, set) => {
    const state = get(editingSessionAtom)
    const intent = createEditingCancelIntent(state)
    if (intent === null) {
      return null
    }

    set(editingIntentAtom, intent)
    set(editingSessionAtom, cancelEditingSessionState(state))
    set(keyboardModeAtom, 'navigation')
    return intent
  },
)
cancelEditingAtom.debugLabel = 'spreadsheet.editing.cancel'
