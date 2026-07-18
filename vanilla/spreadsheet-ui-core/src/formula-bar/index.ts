import { atom, type Atom } from '@einfach/core'
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

const formulaBarStateBackingAtom = atom<FormulaBarState>(createFormulaBarState())
formulaBarStateBackingAtom.debugLabel = 'spreadsheet.formulaBar.stateBacking'

export const formulaBarStateAtom: Atom<FormulaBarState> = atom((get) =>
  get(formulaBarStateBackingAtom),
)
formulaBarStateAtom.debugLabel = 'spreadsheet.formulaBar.state'

export const formulaBarFocusedAtom = atom((get) => get(formulaBarStateBackingAtom).focused)
formulaBarFocusedAtom.debugLabel = 'spreadsheet.formulaBar.focused'

export const formulaBarDraftAtom = atom(
  (get) => get(formulaBarStateBackingAtom).draft,
  (get, set, draft: string) => {
    set(
      formulaBarStateBackingAtom,
      updateFormulaBarDraftState(get(formulaBarStateBackingAtom), draft),
    )
  },
)
formulaBarDraftAtom.debugLabel = 'spreadsheet.formulaBar.draft'

export const focusFormulaBarAtom = atom(
  (get) => get(formulaBarStateBackingAtom),
  (get, set, focused: boolean = true) => {
    set(
      formulaBarStateBackingAtom,
      focusFormulaBarState(get(formulaBarStateBackingAtom), focused),
    )
  },
)
focusFormulaBarAtom.debugLabel = 'spreadsheet.formulaBar.focus'

export const syncFormulaBarAtom = atom(
  (get) => get(formulaBarStateBackingAtom),
  (get, set, input: FormulaBarSyncInput) => {
    set(
      formulaBarStateBackingAtom,
      syncFormulaBarState(get(formulaBarStateBackingAtom), input),
    )
  },
)
syncFormulaBarAtom.debugLabel = 'spreadsheet.formulaBar.sync'

export const setFormulaBarDiagnosticAtom = atom(
  (get) => get(formulaBarStateBackingAtom),
  (get, set, diagnostic: FormulaBarDiagnostic | null) => {
    set(
      formulaBarStateBackingAtom,
      setFormulaBarDiagnosticState(get(formulaBarStateBackingAtom), diagnostic),
    )
  },
)
setFormulaBarDiagnosticAtom.debugLabel = 'spreadsheet.formulaBar.diagnostic'

export const setFormulaBarErrorAtom = atom(
  (get) => get(formulaBarStateBackingAtom),
  (get, set, error: FormulaBarState['error']) => {
    set(
      formulaBarStateBackingAtom,
      setFormulaBarErrorState(get(formulaBarStateBackingAtom), error),
    )
  },
)
setFormulaBarErrorAtom.debugLabel = 'spreadsheet.formulaBar.error'
