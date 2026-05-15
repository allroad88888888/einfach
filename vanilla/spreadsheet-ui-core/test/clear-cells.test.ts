import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  setSelectionAtom,
  setSelectionBoundsAtom,
} from '../src/selection'
import {
  dispatchKeyboardInputAtom,
  keyboardModeAtom,
} from '../src/keyboard'

describe('clear-cells keyboard dispatch', () => {
  function makeStore() {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    return store
  }

  test('Delete in navigation mode targets values only', () => {
    const store = makeStore()

    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Delete' })

    expect(intent).toEqual({ type: 'cell.clear', target: 'values' })
  })

  test('Backspace in navigation mode targets values only', () => {
    const store = makeStore()

    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Backspace' })

    expect(intent).toEqual({ type: 'cell.clear', target: 'values' })
  })

  test('Ctrl+Delete targets values and formats', () => {
    const store = makeStore()

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'Delete',
      ctrlKey: true,
    })

    expect(intent).toEqual({ type: 'cell.clear', target: 'all' })
  })

  test('Cmd+Delete targets values and formats', () => {
    const store = makeStore()

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'Delete',
      metaKey: true,
    })

    expect(intent).toEqual({ type: 'cell.clear', target: 'all' })
  })

  test('Ctrl+Backspace targets values and formats', () => {
    const store = makeStore()

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'Backspace',
      ctrlKey: true,
    })

    expect(intent).toEqual({ type: 'cell.clear', target: 'all' })
  })

  test('Delete in editing mode does not emit cell.clear', () => {
    const store = makeStore()
    store.setter(keyboardModeAtom, 'editing')

    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Delete' })

    expect(intent.type).not.toBe('cell.clear')
  })
})
