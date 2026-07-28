import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  setSelectionAtom,
  setSelectionBoundsAtom,
} from '../src/selection'
import { dispatchKeyboardInputAtom } from '../src/keyboard'

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

describe('copy-as keyboard intent (Ctrl+Shift+C)', () => {
  test('Ctrl+Shift+C dispatches clipboard.copyAs', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.copyAs' })
  })

  test('Cmd+Shift+C (macOS) dispatches clipboard.copyAs', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'c',
      metaKey: true,
      shiftKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.copyAs' })
  })

  test('Ctrl+C (no shift) still dispatches clipboard.copy', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'c',
      ctrlKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.copy' })
  })

  test('Cmd+C (macOS, no shift) still dispatches clipboard.copy', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'c',
      metaKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.copy' })
  })

  test('plain Shift+C without Ctrl/Cmd does not emit a clipboard intent', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'C',
      shiftKey: true,
    })
    // Plain shift+letter goes through the printable-key path (start editing).
    expect(intent.type).toBe('editing.start')
  })
})

describe('copy-as-image keyboard intent (Ctrl+Shift+P)', () => {
  test('Ctrl+Shift+P dispatches clipboard.copyAsImage', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'p',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.copyAsImage' })
  })

  test('Cmd+Shift+P (macOS) dispatches clipboard.copyAsImage', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'p',
      metaKey: true,
      shiftKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.copyAsImage' })
  })

  test('Ctrl+P without Shift does NOT dispatch copyAsImage (reserved for Print)', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'p',
      ctrlKey: true,
    })
    // Plain Ctrl+P stays unhandled at the spreadsheet layer — the host
    // (browser / shell) gets the keystroke for its own Print binding.
    expect(intent.type).toBe('none')
  })

  test('plain Shift+P without modifier does not emit a clipboard intent', () => {
    const store = makeStore()
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'P',
      shiftKey: true,
    })
    expect(intent.type).toBe('editing.start')
  })
})
