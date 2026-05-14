import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  cancelEditingAtom,
  commitEditingAtom,
  editingIntentAtom,
  editingSessionAtom,
  startEditingAtom,
  updateEditingDraftState,
  type EditingSessionState,
  type EditingStartInput,
} from '../src/editing'

describe('editing core', () => {
  test('starts from a cell source and keeps a bounded session only', () => {
    const store = createStore()
    const input: EditingStartInput = {
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      draft: '=A1+1',
      source: 'cell',
    }

    store.setter(startEditingAtom, input)

    expect(store.getter(editingSessionAtom)).toEqual({
      status: 'drafting',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 2, col: 3 },
        source: 'cell',
      },
      draft: '=A1+1',
      diagnostic: null,
    })
    expect(store.getter(editingIntentAtom)).toEqual({
      type: 'editing.start',
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      source: 'cell',
    })
  })

  test('updates draft from formula bar and paste without widening the session', () => {
    const state: EditingSessionState = {
      status: 'drafting',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 1, col: 1 },
        source: 'formula-bar',
      },
      draft: '=SUM(A1:A3)',
      diagnostic: null,
    }

    const afterFormulaBar = updateEditingDraftState(state, {
      draft: '=SUM(A1:A3)+1',
      source: 'formula-bar',
    })
    const afterPaste = updateEditingDraftState(afterFormulaBar, {
      draft: '42',
      source: 'paste',
    })

    expect(afterFormulaBar).toMatchObject({
      status: 'drafting',
      draft: '=SUM(A1:A3)+1',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 1, col: 1 },
        source: 'formula-bar',
      },
    })
    expect(afterPaste).toMatchObject({
      draft: '42',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 1, col: 1 },
        source: 'paste',
      },
    })
  })

  test('commits and cancels as intents, then clears the session', () => {
    const store = createStore()

    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      draft: '=B2+1',
      source: 'cell',
    })

    const commitIntent = store.setter(commitEditingAtom, {
      input: '=B2+2',
      move: 'down',
      source: 'cell',
    })

    expect(commitIntent).toEqual({
      type: 'editing.commit',
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      source: 'cell',
      input: '=B2+2',
      move: 'down',
    })
    expect(store.getter(editingSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      draft: '',
      diagnostic: null,
    })

    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      draft: 'text',
      source: 'paste',
    })

    const cancelIntent = store.setter(cancelEditingAtom)

    expect(cancelIntent).toEqual({
      type: 'editing.cancel',
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      source: 'paste',
    })
    expect(store.getter(editingSessionAtom)).toEqual({
      status: 'cancelled',
      source: null,
      draft: '',
      diagnostic: null,
    })
  })

  test('ignores commit when no edit session is active', () => {
    const store = createStore()

    expect(store.setter(commitEditingAtom, { input: 'noop', source: 'cell' })).toBeNull()
    expect(store.getter(editingIntentAtom)).toBeNull()
  })
})
