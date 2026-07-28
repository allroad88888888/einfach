import { createStore } from '@einfach/core'
import { describe, expect, it } from '@jest/globals'
import {
  formulaReferenceCaretAtom,
  formulaReferenceSessionAtom,
  keyboardModeAtom,
  startEditingAtom,
} from '@einfach/spreadsheet-ui-core'
import { syncFormulaReferenceCaret } from '../src-vnext/provider/edit-dispatch'

describe('vNext formula-reference state bridge', () => {
  it('routes a DOM caret update through UI-core and enters reference mode', () => {
    const store = createStore()
    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      draft: '=',
      source: 'formula-bar',
    })

    syncFormulaReferenceCaret(store, 1)

    expect(store.getter(formulaReferenceCaretAtom)).toBe(1)
    expect(store.getter(formulaReferenceSessionAtom)).toMatchObject({
      anchorCell: { row: 2, col: 3 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
    })
    expect(store.getter(keyboardModeAtom)).toBe('formula-reference')
  })

  it('updates the UI-core caret without creating a host-local state surface', () => {
    const store = createStore()
    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      draft: '=A',
      source: 'cell',
    })

    syncFormulaReferenceCaret(store, 2)

    expect(store.getter(formulaReferenceCaretAtom)).toBe(2)
    expect(store.getter(formulaReferenceSessionAtom)).toBeNull()
    expect(store.getter(keyboardModeAtom)).toBe('editing')
  })
})
