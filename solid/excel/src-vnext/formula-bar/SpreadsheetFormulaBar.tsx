import { createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import type {
  CellCoord,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  dismissFormulaSuggestionsAtom,
  editingDraftAtom,
  editingSessionAtom,
  focusFormulaBarAtom,
  formulaBarStateAtom,
  formulaFunctionSuggestionCursorAtom,
  formulaFunctionSuggestionsAtom,
  startEditingAtom,
  syncFormulaBarAtom,
  selectionSnapshotAtom,
  workspaceSessionAtom,
  type FormulaBarSyncInput,
} from '@einfach/spreadsheet-ui-core'
import { isVisibleProjectionResult } from '../provider'
import {
  dispatchEditingCancel,
  dispatchEditingCommit,
  acceptFormulaSuggestion,
  notifyDraftTypedChar,
  readActiveFormulaSuggestion,
  syncFormulaReferenceCaret,
} from '../provider/edit-dispatch'
import { spreadsheetProjectionSnapshotAtom } from '../provider/atoms'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'
import { SpreadsheetNameBox } from '../name-box'

export interface SpreadsheetFormulaBarProps {
  class?: string
  'data-testid'?: string
}

function getColumnLabel(index: number): string {
  let value = index + 1
  let label = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }

  return label
}

function toA1(cell: CellCoord): string {
  return `${getColumnLabel(cell.col)}${cell.row + 1}`
}

function getSourceTextFromProjection(
  result: VisibleProjectionResult | undefined,
  cell: CellCoord,
  activeSheetId: string,
): string | undefined {
  if (!result || result.sheetId !== activeSheetId) return undefined
  if (
    cell.row < result.window.rowStart ||
    cell.row > result.window.rowEnd ||
    cell.col < result.window.colStart ||
    cell.col > result.window.colEnd
  ) {
    return undefined
  }

  const draftCell = result.cells.find(
    (projectionCell) => projectionCell.row === cell.row && projectionCell.col === cell.col,
  )
  return draftCell ? (draftCell.formula ?? draftCell.displayValue ?? '') : ''
}

export function SpreadsheetFormulaBar(props: SpreadsheetFormulaBarProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom)
  const formulaBarState = useAtomValue(formulaBarStateAtom)
  const editingSession = useAtomValue(editingSessionAtom)
  const editingDraft = useAtomValue(editingDraftAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)
  const workspace = useAtomValue(workspaceSessionAtom)
  let inputRef: HTMLInputElement | undefined

  function resolveActiveSheetId() {
    const selection = selectionSnapshot()
    if (selection.selection.sheetId) return selection.selection.sheetId
    const visible = isVisibleProjectionResult(projectionSnapshot().result)
      ? projectionSnapshot().result
      : undefined
    return visible?.sheetId || workspace().activeSheetId || ''
  }

  // Sync the formula-bar's "synced draft" from projection when not actively
  // editing. While editing, the value reflects the live editingDraftAtom so
  // typing in the formula bar mirrors the in-cell editor.
  createEffect(() => {
    if (editingSession().status === 'drafting') return
    const selection = selectionSnapshot()
    const snapshot = projectionSnapshot()
    const visibleResult = isVisibleProjectionResult(snapshot.result)
      ? snapshot.result
      : undefined
    const activeSheetId = resolveActiveSheetId()
    const draft = getSourceTextFromProjection(visibleResult, selection.activeCell, activeSheetId)
    if (draft === undefined) {
      const current = store.getter(formulaBarStateAtom)
      const sameCell =
        current.sheetId === activeSheetId &&
        current.cell?.row === selection.activeCell.row &&
        current.cell?.col === selection.activeCell.col
      if (sameCell) return
    }

    const input: FormulaBarSyncInput = {
      sheetId: activeSheetId,
      cell: selection.activeCell,
      draft: draft ?? '',
      source: 'selection',
      revision: visibleResult?.revision,
    }
    store.setter(syncFormulaBarAtom, input)
  })

  // The input element's value: editingDraft while drafting, otherwise the
  // formula-bar synced draft (which reflects the projection source text).
  const displayValue = createMemo(() => {
    if (editingSession().status === 'drafting') return editingDraft()
    return formulaBarState().draft
  })

  function ensureEditingSession(initialDraft: string) {
    if (editingSession().status === 'drafting') return
    const selection = selectionSnapshot()
    const sheetId = resolveActiveSheetId()
    if (!sheetId) return
    store.setter(startEditingAtom, {
      sheetId,
      cell: selection.activeCell,
      draft: initialDraft,
      source: 'formula-bar',
    })
  }

  function onInput(event: InputEvent) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    const next = target.value
    if (editingSession().status !== 'drafting') {
      // First keystroke in the formula bar opens an editing session for the
      // currently-selected cell. The draft becomes the typed value.
      ensureEditingSession(next)
    } else {
      store.setter(editingDraftAtom, { draft: next, source: 'formula-bar' })
    }
    notifyDraftTypedChar(store, target.selectionStart ?? next.length)
  }

  function onSelectionChange(event: Event) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    if (editingSession().status !== 'drafting') return
    syncFormulaReferenceCaret(store, target.selectionStart ?? 0)
  }

  async function commitDraft() {
    if (editingSession().status !== 'drafting') return
    await dispatchEditingCommit(store, backend, { source: 'formula-bar', move: 'none' })
  }

  function cancelDraft() {
    dispatchEditingCancel(store)
  }

  function isCommitKey(event: KeyboardEvent) {
    return event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13
  }

  function isEscapeKey(event: KeyboardEvent) {
    return (
      event.key === 'Escape' ||
      event.key === 'Esc' ||
      event.code === 'Escape' ||
      event.code === 'Esc' ||
      event.keyCode === 27
    )
  }

  async function handleKeyDown(event: KeyboardEvent) {
    // Autocomplete first: when the dropdown has rows, ArrowUp/Down move
    // the cursor and Tab/Enter accept the highlighted suggestion (open
    // the function paren without committing the cell). Esc dismisses.
    const suggestionsOpen = store.getter(formulaFunctionSuggestionsAtom).length > 0
    if (suggestionsOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const list = store.getter(formulaFunctionSuggestionsAtom)
        const current = store.getter(formulaFunctionSuggestionCursorAtom)
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % list.length
            : (current - 1 + list.length) % list.length
        store.setter(formulaFunctionSuggestionCursorAtom, next)
        return
      }
      if (event.key === 'Tab' || isCommitKey(event)) {
        const suggestion = readActiveFormulaSuggestion(store)
        if (suggestion) {
          event.preventDefault()
          const { caret } = acceptFormulaSuggestion(store, suggestion)
          queueMicrotask(() => {
            inputRef?.focus()
            inputRef?.setSelectionRange(caret, caret)
          })
          return
        }
      }
    }

    if (isCommitKey(event)) {
      event.preventDefault()
      await commitDraft()
      inputRef?.blur()
      return
    }

    if (isEscapeKey(event)) {
      // Autocomplete-first: if the popup is open, Esc dismisses it but
      // keeps the editing session active so the user can keep typing.
      // Only the second Esc (or Esc with no popup) cancels editing.
      if (suggestionsOpen) {
        event.preventDefault()
        store.setter(dismissFormulaSuggestionsAtom)
        store.setter(formulaFunctionSuggestionCursorAtom, 0)
        return
      }
      event.preventDefault()
      cancelDraft()
      inputRef?.blur()
    }
  }

  function bindInputRef(node: HTMLInputElement | undefined | null) {
    if (!node || inputRef === node) {
      return
    }

    const listener = (event: KeyboardEvent) => {
      void handleKeyDown(event)
    }

    inputRef = node
    node.addEventListener('keydown', listener)

    onCleanup(() => {
      node.removeEventListener('keydown', listener)
    })
  }

  const cellAddress = () => toA1(selectionSnapshot().activeCell)

  return (
    <div
      class={`formula-bar spreadsheet-formula-bar ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'formula-bar'}
    >
      <SpreadsheetNameBox />
      <span
        class="formula-bar-addr spreadsheet-formula-bar-addr"
        data-testid="formula-bar-addr"
        aria-hidden="true"
        style={{ display: 'none' }}
      >
        {cellAddress()}
      </span>
      <input
        class="formula-bar-input spreadsheet-formula-bar-input"
        data-testid="formula-bar-input"
        type="text"
        value={displayValue()}
        onInput={onInput}
        onSelect={onSelectionChange}
        onClick={onSelectionChange}
        onKeyUp={(event) => {
          // Caret-only key events (ArrowLeft/Right/Home/End) don't fire
          // onSelect — sync explicitly so signature + autocomplete
          // recompute against the new caret position.
          if (
            event.key === 'ArrowLeft' ||
            event.key === 'ArrowRight' ||
            event.key === 'Home' ||
            event.key === 'End'
          ) {
            onSelectionChange(event)
          }
        }}
        onFocus={() => {
          store.setter(focusFormulaBarAtom, true)
        }}
        onBlur={() => {
          store.setter(focusFormulaBarAtom, false)
        }}
        ref={(node) => {
          bindInputRef(node)
        }}
      />
    </div>
  )
}
