import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  dispatchKeyboardInputAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
} from '../src'
import {
  openPasteSpecialAtom,
  pasteSpecialOpenAtom,
} from '../src/paste-special'

/**
 * Wave 7.3 wiring smoke: the Ctrl+Alt+V → `clipboard.pasteSpecial` intent
 * the host wires to `openPasteSpecialAtom` should flip the dialog open.
 * This test mimics the host's intent → atom routing without involving
 * Solid / the actual grid component.
 */
describe('paste-special keyboard wiring', () => {
  test('Ctrl+Alt+V emits clipboard.pasteSpecial intent that opens the dialog atom', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.pasteSpecial' })

    // The host's grid keyboard handler routes this intent type to
    // openPasteSpecialAtom. Asserting the atom path here keeps the
    // smoke independent of the Solid component layer.
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    if (intent.type === 'clipboard.pasteSpecial') {
      store.setter(openPasteSpecialAtom)
    }
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
  })

  test('plain Ctrl+V does not trigger paste-special', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'v',
      ctrlKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.paste' })
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })
})
