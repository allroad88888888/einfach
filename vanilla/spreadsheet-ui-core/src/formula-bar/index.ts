import { atom } from '@einfach/core'
import type { FormulaBarDiagnostic, FormulaBarState, FormulaBarSyncInput } from './types'

export * from './types'

export function createFormulaBarState(): FormulaBarState {
  return {
    status: 'idle',
    focused: false,
    sheetId: null,
    cell: null,
    draft: '',
    syncedDraft: '',
    syncSource: null,
    revision: null,
    diagnostic: null,
    error: null,
  }
}

export function focusFormulaBarState(
  state: FormulaBarState,
  focused: boolean,
): FormulaBarState {
  return {
    ...state,
    focused,
    status: focused ? (state.draft !== state.syncedDraft ? 'editing' : 'focused') : 'idle',
  }
}

export function syncFormulaBarState(
  state: FormulaBarState,
  input: FormulaBarSyncInput,
): FormulaBarState {
  return {
    status: state.focused ? 'focused' : 'idle',
    focused: state.focused,
    sheetId: input.sheetId,
    cell: {
      row: input.cell.row,
      col: input.cell.col,
    },
    draft: input.draft,
    syncedDraft: input.draft,
    syncSource: input.source,
    revision: input.revision ?? null,
    diagnostic: input.diagnostic ?? null,
    error: input.error ?? null,
  }
}

export function updateFormulaBarDraftState(
  state: FormulaBarState,
  draft: string,
): FormulaBarState {
  return {
    ...state,
    draft,
    status: state.focused ? 'editing' : state.status,
  }
}

export function setFormulaBarDiagnosticState(
  state: FormulaBarState,
  diagnostic: FormulaBarDiagnostic | null,
): FormulaBarState {
  return {
    ...state,
    diagnostic,
    status: diagnostic?.level === 'error' ? 'error' : state.status,
  }
}

export function setFormulaBarErrorState(
  state: FormulaBarState,
  error: FormulaBarState['error'],
): FormulaBarState {
  return {
    ...state,
    error,
    status: error === null ? (state.focused ? 'focused' : 'idle') : 'error',
  }
}

export const formulaBarStateAtom = atom<FormulaBarState>(createFormulaBarState())
formulaBarStateAtom.debugLabel = 'spreadsheet.formulaBar.state'

export const formulaBarFocusedAtom = atom((get) => get(formulaBarStateAtom).focused)
formulaBarFocusedAtom.debugLabel = 'spreadsheet.formulaBar.focused'

export const formulaBarDraftAtom = atom(
  (get) => get(formulaBarStateAtom).draft,
  (get, set, draft: string) => {
    set(formulaBarStateAtom, updateFormulaBarDraftState(get(formulaBarStateAtom), draft))
  },
)
formulaBarDraftAtom.debugLabel = 'spreadsheet.formulaBar.draft'

export const focusFormulaBarAtom = atom(
  (get) => get(formulaBarStateAtom),
  (get, set, focused: boolean = true) => {
    set(formulaBarStateAtom, focusFormulaBarState(get(formulaBarStateAtom), focused))
  },
)
focusFormulaBarAtom.debugLabel = 'spreadsheet.formulaBar.focus'

export const syncFormulaBarAtom = atom(
  (get) => get(formulaBarStateAtom),
  (get, set, input: FormulaBarSyncInput) => {
    set(formulaBarStateAtom, syncFormulaBarState(get(formulaBarStateAtom), input))
  },
)
syncFormulaBarAtom.debugLabel = 'spreadsheet.formulaBar.sync'

export const setFormulaBarDiagnosticAtom = atom(
  (get) => get(formulaBarStateAtom),
  (get, set, diagnostic: FormulaBarDiagnostic | null) => {
    set(formulaBarStateAtom, setFormulaBarDiagnosticState(get(formulaBarStateAtom), diagnostic))
  },
)
setFormulaBarDiagnosticAtom.debugLabel = 'spreadsheet.formulaBar.diagnostic'

export const setFormulaBarErrorAtom = atom(
  (get) => get(formulaBarStateAtom),
  (get, set, error: FormulaBarState['error']) => {
    set(formulaBarStateAtom, setFormulaBarErrorState(get(formulaBarStateAtom), error))
  },
)
setFormulaBarErrorAtom.debugLabel = 'spreadsheet.formulaBar.error'
