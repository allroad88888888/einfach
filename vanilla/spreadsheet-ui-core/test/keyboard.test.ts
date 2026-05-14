import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  activeCellAtom,
  selectionAtom,
  selectionRangeAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
} from '../src/selection'
import {
  dispatchKeyboardInputAtom,
  keyboardModeAtom,
  lastKeyboardIntentAtom,
  type KeyboardCommandIntent,
} from '../src/keyboard'

describe('keyboard core', () => {
  test('moves selection and emits scroll-to-cell intent for arrow keys', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'ArrowRight' })

    expectMoveIntent(intent, { row: 0, col: 1 })
    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 0,
      col: 1,
    })
    expect(store.getter(lastKeyboardIntentAtom)).toEqual(intent)
  })

  test('shift arrow extends selection by boundary only', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 2 },
      focus: { row: 2, col: 2 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'ArrowDown',
      shiftKey: true,
    })

    expectMoveIntent(intent, { row: 3, col: 2 })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 2 },
      focus: { row: 3, col: 2 },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 3,
      colStart: 2,
      colEnd: 2,
    })
  })

  test('home and page movement clamp to sheet bounds', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 5, col: 3 },
      focus: { row: 5, col: 3 },
    })

    expectMoveIntent(store.setter(dispatchKeyboardInputAtom, { key: 'Home' }), {
      row: 5,
      col: 0,
    })
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'PageDown',
        pageRowDelta: 20,
      }),
      {
        row: 9,
        col: 0,
      },
    )
  })

  test('alt page movement uses pageColDelta for horizontal paging', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 8 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 5, col: 1 },
      focus: { row: 5, col: 1 },
    })

    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'PageDown',
        altKey: true,
        pageColDelta: 4,
      }),
      {
        row: 5,
        col: 5,
      },
    )
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'PageUp',
        altKey: true,
        pageColDelta: 10,
      }),
      {
        row: 5,
        col: 0,
      },
    )
  })

  test('shift alt page extends selection horizontally without expanding cells', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 8 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 2 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'PageDown',
      altKey: true,
      shiftKey: true,
      pageColDelta: 3,
    })

    expectMoveIntent(intent, { row: 3, col: 5 })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 5 },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 3,
      rowEnd: 3,
      colStart: 2,
      colEnd: 5,
    })
  })

  test('ctrl arrow and ctrl end jump to sheet boundaries without reading cells', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 4, col: 2 },
      focus: { row: 4, col: 2 },
    })

    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'ArrowDown',
        ctrlKey: true,
      }),
      {
        row: 9,
        col: 2,
      },
    )
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'ArrowRight',
        metaKey: true,
      }),
      {
        row: 9,
        col: 4,
      },
    )
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'End',
        ctrlKey: true,
      }),
      {
        row: 9,
        col: 4,
      },
    )
  })

  test('shift ctrl arrow extends selection to boundaries', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 4, col: 2 },
      focus: { row: 4, col: 2 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'ArrowUp',
      ctrlKey: true,
      shiftKey: true,
    })

    expectMoveIntent(intent, { row: 0, col: 2 })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 4, col: 2 },
      focus: { row: 0, col: 2 },
    })
  })

  test('editing mode returns edit intents without moving selection', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    store.setter(keyboardModeAtom, 'editing')

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'Enter',
      shiftKey: true,
    })

    expect(intent).toEqual({
      type: 'editing.commit',
      move: 'up',
    })
    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 1,
      col: 1,
    })
  })

  test('command shortcuts emit compact intents', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })

    expect(store.setter(dispatchKeyboardInputAtom, { key: 'c', ctrlKey: true })).toEqual({
      type: 'clipboard.copy',
    })
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'PageDown', ctrlKey: true })).toEqual({
      type: 'sheet.activate-adjacent',
      direction: 'next',
    })
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'PageUp', metaKey: true })).toEqual({
      type: 'sheet.activate-adjacent',
      direction: 'previous',
    })
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'z', metaKey: true })).toEqual({
      type: 'history.undo',
    })

    const selectAllIntent = store.setter(dispatchKeyboardInputAtom, {
      key: 'a',
      ctrlKey: true,
    })

    expect(selectAllIntent).toEqual({
      type: 'selection.selectAll',
      selection: {
        kind: 'all',
        sheetId: 'Sheet1',
      },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 4,
    })
  })
})

function expectMoveIntent(intent: KeyboardCommandIntent, to: { row: number; col: number }) {
  if (intent.type !== 'selection.move') {
    throw new Error(`Expected selection.move intent, received ${intent.type}`)
  }

  expect(intent.to).toEqual(to)
  expect(intent.scroll).toEqual({
    type: 'viewport.scrollToCell',
    target: to,
  })
}
