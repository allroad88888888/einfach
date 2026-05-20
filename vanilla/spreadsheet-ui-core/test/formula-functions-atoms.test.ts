import { createStore } from '@einfach/core'
import { describe, expect, it } from '@jest/globals'
import {
  editingDraftAtom,
  formulaFunctionSignatureAtom,
  formulaFunctionSuggestionsAtom,
  formulaReferenceCaretAtom,
  renderActiveSignatureSlots,
  renderFormulaFunctionSignature,
  startEditingAtom,
} from '../src'

function setup(draft: string, caret: number) {
  const store = createStore()
  store.setter(startEditingAtom, {
    sheetId: 'sheet-1',
    cell: { row: 0, col: 0 },
    draft,
    source: 'cell',
  })
  store.setter(editingDraftAtom, { draft })
  store.setter(formulaReferenceCaretAtom, caret)
  return store
}

describe('formulaFunctionSuggestionsAtom', () => {
  it('returns startsWith matches ranked above contains matches', () => {
    const store = setup('=SU', 3)
    const suggestions = store.getter(formulaFunctionSuggestionsAtom)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0].spec.name).toBe('SUM')
    expect(suggestions[1].spec.name).toBe('SUMIF')
  })

  it('puts exact-name match first', () => {
    const store = setup('=SUM', 4)
    const suggestions = store.getter(formulaFunctionSuggestionsAtom)
    expect(suggestions[0].spec.name).toBe('SUM')
    expect(suggestions[1].spec.name).toBe('SUMIF')
  })

  it('returns empty when draft does not start with =', () => {
    const store = setup('SU', 2)
    expect(store.getter(formulaFunctionSuggestionsAtom)).toEqual([])
  })

  it('returns empty when caret has no fragment to its left', () => {
    const store = setup('=', 1)
    expect(store.getter(formulaFunctionSuggestionsAtom)).toEqual([])
  })

  it('does not suggest when the fragment is followed by `(`', () => {
    // `=SUM(` with caret at 4 (between M and ( — boundary) — autocomplete
    // should not fire because the function already opened.
    const store = setup('=SUM(', 4)
    expect(store.getter(formulaFunctionSuggestionsAtom)).toEqual([])
  })

  it('matches case-insensitively', () => {
    const store = setup('=su', 3)
    const suggestions = store.getter(formulaFunctionSuggestionsAtom)
    expect(suggestions[0].spec.name).toBe('SUM')
  })

  it('emits the fragment range for splicing on accept', () => {
    const store = setup('=B2+SU', 6)
    const [first] = store.getter(formulaFunctionSuggestionsAtom)
    expect(first.fragmentStart).toBe(4)
    expect(first.fragmentEnd).toBe(6)
    expect(first.fragment).toBe('SU')
  })
})

describe('formulaFunctionSignatureAtom', () => {
  it('returns the spec + active arg when caret is inside the open paren', () => {
    const store = setup('=SUM(', 5)
    const state = store.getter(formulaFunctionSignatureAtom)
    expect(state?.spec.name).toBe('SUM')
    expect(state?.activeArgIndex).toBe(0)
  })

  it('bumps active arg on each top-level comma', () => {
    const store = setup('=IF(A1>0, "yes", ', 17)
    const state = store.getter(formulaFunctionSignatureAtom)
    expect(state?.spec.name).toBe('IF')
    expect(state?.activeArgIndex).toBe(2)
  })

  it('clamps to the last arg when user types past the formal count', () => {
    // SUM has 2 args formally; after 5 commas we should still report
    // index 1 (the repeating tail).
    const store = setup('=SUM(1, 2, 3, 4, 5, ', 20)
    const state = store.getter(formulaFunctionSignatureAtom)
    expect(state?.spec.name).toBe('SUM')
    expect(state?.activeArgIndex).toBe(1)
  })

  it('returns null when the function name is not in the registry', () => {
    const store = setup('=UNKNOWN(', 9)
    expect(store.getter(formulaFunctionSignatureAtom)).toBeNull()
  })

  it('returns null when the caret is outside any open paren', () => {
    const store = setup('=SUM(B2)', 8)
    expect(store.getter(formulaFunctionSignatureAtom)).toBeNull()
  })
})

describe('renderFormulaFunctionSignature', () => {
  it('renders required + optional + repeating args', () => {
    const store = setup('=SUM(', 5)
    const state = store.getter(formulaFunctionSignatureAtom)
    expect(renderFormulaFunctionSignature(state!.spec)).toBe('SUM(number1, [number2, ...])')
  })

  it('per-slot rendering marks the active arg', () => {
    const store = setup('=IF(A1, ', 8)
    const state = store.getter(formulaFunctionSignatureAtom)
    const slots = renderActiveSignatureSlots(state!)
    expect(slots).toEqual([
      { text: 'logical_test', active: false },
      { text: 'value_if_true', active: true },
      { text: '[value_if_false]', active: false },
    ])
  })
})
