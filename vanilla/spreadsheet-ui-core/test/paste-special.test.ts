import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DEFAULT_PASTE_SPECIAL_OPTIONS,
  closePasteSpecialAtom,
  confirmPasteSpecialAtom,
  openPasteSpecialAtom,
  patchPasteSpecialOptionsAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
} from '../src/paste-special'

describe('paste-special', () => {
  test('initial state: dialog closed and options at defaults', () => {
    const store = createStore()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual(DEFAULT_PASTE_SPECIAL_OPTIONS)
  })

  test('openPasteSpecialAtom flips open to true and resets options', () => {
    const store = createStore()
    // Mutate options first to make sure open resets them.
    store.setter(pasteSpecialOptionsAtom, {
      kind: 'all',
      op: 'multiply',
      transpose: true,
      skipBlanks: true,
    })
    store.setter(openPasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual(DEFAULT_PASTE_SPECIAL_OPTIONS)
  })

  test('closePasteSpecialAtom closes and resets options', () => {
    const store = createStore()
    store.setter(openPasteSpecialAtom)
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'formats' })
    expect(store.getter(pasteSpecialOptionsAtom).kind).toBe('formats')

    store.setter(closePasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual(DEFAULT_PASTE_SPECIAL_OPTIONS)
  })

  test('patchPasteSpecialOptionsAtom shallow-merges a partial options patch', () => {
    const store = createStore()
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'values' })
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual({
      ...DEFAULT_PASTE_SPECIAL_OPTIONS,
      kind: 'values',
    })
    store.setter(patchPasteSpecialOptionsAtom, { op: 'add', transpose: true })
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual({
      ...DEFAULT_PASTE_SPECIAL_OPTIONS,
      kind: 'values',
      op: 'add',
      transpose: true,
    })
  })

  test('confirmPasteSpecialAtom closes the dialog and resolves to void', async () => {
    const store = createStore()
    store.setter(openPasteSpecialAtom)
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'all', skipBlanks: true })

    const result = await store.setter(confirmPasteSpecialAtom)

    expect(result).toBeUndefined()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual(DEFAULT_PASTE_SPECIAL_OPTIONS)
  })

  test('debug labels follow the spreadsheet.pasteSpecial.<name> convention', () => {
    expect(pasteSpecialOpenAtom.debugLabel).toBe('spreadsheet.pasteSpecial.open')
    expect(pasteSpecialOptionsAtom.debugLabel).toBe('spreadsheet.pasteSpecial.options')
    expect(openPasteSpecialAtom.debugLabel).toBe('spreadsheet.pasteSpecial.openCommand')
    expect(closePasteSpecialAtom.debugLabel).toBe('spreadsheet.pasteSpecial.closeCommand')
    expect(patchPasteSpecialOptionsAtom.debugLabel).toBe(
      'spreadsheet.pasteSpecial.patchOptions',
    )
    expect(confirmPasteSpecialAtom.debugLabel).toBe('spreadsheet.pasteSpecial.confirm')
  })
})
