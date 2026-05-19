import { createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import type {
  CellCoord,
  SetCellInputRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  createVisibleProjectionRequest,
  focusFormulaBarAtom,
  formulaBarDraftAtom,
  formulaBarStateAtom,
  syncFormulaBarAtom,
  selectionSnapshotAtom,
  type FormulaBarSyncInput,
} from '@einfach/spreadsheet-ui-core'
import { isVisibleProjectionResult } from '../provider'
import {
  advanceSpreadsheetProjectionRequestIdAtom,
  spreadsheetProjectionSnapshotAtom,
} from '../provider/atoms'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

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

function getDraftFromProjection(
  result: VisibleProjectionResult | undefined,
  cell: CellCoord,
  activeSheetId: string,
): string {
  if (!result || result.sheetId !== activeSheetId) {
    return ''
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
  const formulaBarDraft = useAtomValue(formulaBarDraftAtom)
  const formulaBarState = useAtomValue(formulaBarStateAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)
  let inputRef: HTMLInputElement | undefined

  function resolveActiveSheetId() {
    const selection = selectionSnapshot()
    const visible = isVisibleProjectionResult(projectionSnapshot().result)
      ? projectionSnapshot().result
      : undefined

    return visible?.sheetId || selection.activeCell.sheetId || ''
  }

  createEffect(() => {
    const selection = selectionSnapshot()
    const snapshot = projectionSnapshot()
    const visibleResult = isVisibleProjectionResult(snapshot.result)
      ? snapshot.result
      : undefined
    const activeSheetId = visibleResult?.sheetId || selection.activeCell.sheetId || ''
    const input: FormulaBarSyncInput = {
      sheetId: activeSheetId,
      cell: selection.activeCell,
      draft: getDraftFromProjection(
        visibleResult,
        selection.activeCell,
        activeSheetId,
      ),
      source: 'selection',
      revision: visibleResult?.revision,
    }

    store.setter(syncFormulaBarAtom, input)
  })

  function getCurrentWindow() {
    const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
    if (isVisibleProjectionResult(snapshot.result)) {
      return snapshot.result.window
    }
    if (snapshot.request?.kind === 'visible-window') {
      return snapshot.request.window
    }
    return null
  }

  async function refreshProjection(sheetId: string) {
    const window = getCurrentWindow()
    if (!window) {
      return
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = createVisibleProjectionRequest({
      sheetId,
      window,
      requestId,
      reason: 'formula-bar',
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'loading',
      request,
      result: undefined,
      error: undefined,
    })

    try {
      const result = await backend.readVisibleProjection(request)
      const current = store.getter(spreadsheetProjectionSnapshotAtom)
      if (current.request?.requestId !== requestId) {
        return
      }
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'ready',
        request,
        result,
        error: undefined,
      })
    } catch (error: unknown) {
      const current = store.getter(spreadsheetProjectionSnapshotAtom)
      if (current.request?.requestId !== requestId) {
        return
      }
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'error',
        request,
        result: undefined,
        error:
          error instanceof Error
            ? { code: 'BACKEND_ERROR', message: error.message }
            : { code: 'BACKEND_ERROR', message: 'Spreadsheet projection failed.' },
      })
    }
  }

  async function commitDraft() {
    const selection = selectionSnapshot()
    const activeSheetId = resolveActiveSheetId()
    const draft = formulaBarDraft()
    const { sheetId, row, col } = selection.activeCell

    const targetSheetId = activeSheetId || sheetId
    if (!targetSheetId) {
      return
    }

    const request: SetCellInputRequest = {
      kind: 'set-cell-input',
      sheetId: targetSheetId,
      row,
      col,
      input: draft,
    }
    await backend.setCellInput(request)
    await refreshProjection(targetSheetId)
  }

  function restoreDraft(target?: HTMLInputElement) {
    const draft = formulaBarState().syncedDraft
    store.setter(formulaBarDraftAtom, draft)
    if (target) {
      target.value = draft
    }
  }

  function onInput(event: InputEvent) {
    const target = event.target as HTMLInputElement | null
    if (!target) {
      return
    }

    store.setter(formulaBarDraftAtom, target.value)
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
    if (isCommitKey(event)) {
      event.preventDefault()
      void commitDraft()
      return
    }

    if (isEscapeKey(event)) {
      event.preventDefault()
      const target = event.currentTarget instanceof HTMLInputElement
        ? event.currentTarget
        : inputRef
      restoreDraft(target)
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
      <span class="formula-bar-addr spreadsheet-formula-bar-addr" data-testid="formula-bar-addr">
        {cellAddress()}
      </span>
      <input
        class="formula-bar-input spreadsheet-formula-bar-input"
        data-testid="formula-bar-input"
        type="text"
        value={formulaBarDraft()}
        onInput={onInput}
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
