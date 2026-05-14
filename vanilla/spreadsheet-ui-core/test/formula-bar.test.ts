import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  focusFormulaBarAtom,
  formulaBarStateAtom,
  setFormulaBarDiagnosticAtom,
  setFormulaBarErrorAtom,
  syncFormulaBarAtom,
  updateFormulaBarDraftState,
  type FormulaBarState,
} from '../src/formula-bar'

describe('formula bar core', () => {
  test('focuses and syncs the current draft without storing workbook facts', () => {
    const store = createStore()

    store.setter(focusFormulaBarAtom, true)
    store.setter(syncFormulaBarAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      draft: '=A1+1',
      source: 'selection',
      revision: 'rev-1',
    })

    expect(store.getter(formulaBarStateAtom)).toEqual({
      status: 'focused',
      focused: true,
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      draft: '=A1+1',
      syncedDraft: '=A1+1',
      syncSource: 'selection',
      revision: 'rev-1',
      diagnostic: null,
      error: null,
    })
  })

  test('marks draft edits and diagnostics independently', () => {
    const state = updateFormulaBarDraftState(
      {
        status: 'focused',
        focused: true,
        sheetId: 'sheet-1',
        cell: { row: 0, col: 0 },
        draft: '=A1',
        syncedDraft: '=A1',
        syncSource: 'selection',
        revision: null,
        diagnostic: null,
        error: null,
      },
      '=A1+2',
    )

    expect(state.status).toBe('editing')
    expect(state.draft).toBe('=A1+2')
  })

  test('stores diagnostic and error status without widening the state', () => {
    const store = createStore()

    store.setter(setFormulaBarDiagnosticAtom, {
      code: 'invalid-formula',
      message: 'bad formula',
      level: 'warning',
    })
    const state = store.getter(formulaBarStateAtom) as FormulaBarState

    expect(state.diagnostic).toEqual({
      code: 'invalid-formula',
      message: 'bad formula',
      level: 'warning',
    })
    expect(state.status).toBe('idle')

    store.setter(setFormulaBarErrorAtom, {
      code: 'INVALID_FORMULA',
      message: 'parse error',
    })
    const erroredState = store.getter(formulaBarStateAtom) as FormulaBarState
    expect(erroredState.status).toBe('error')
    expect(erroredState.error).toEqual({
      code: 'INVALID_FORMULA',
      message: 'parse error',
    })

    store.setter(setFormulaBarErrorAtom, null)
    expect((store.getter(formulaBarStateAtom) as FormulaBarState).status).toBe('idle')
  })
})
