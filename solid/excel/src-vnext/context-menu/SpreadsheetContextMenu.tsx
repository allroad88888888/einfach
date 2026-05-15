import { onCleanup, onMount, For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  CLIPBOARD_ORIGIN_MARKER_PREFIX,
  closeMenuAtom,
  copyClipboardAtom,
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
  cutClipboardAtom,
  dispatchMenuCommandAtom,
  markClipboardReadyAtom,
  menuStateAtom,
  parseClipboardTsv,
  pasteClipboardAtom,
  serializeClipboardTsv,
  setClipboardErrorAtom,
  shiftFormulaRefs,
  type CellCoord,
  type CellRange,
  type ClipboardTextData,
  type ClipboardTransferInput,
  type ImportCellInput,
  type MenuCommandIntent,
  type MenuCommandKind,
  type MenuTarget,
  type MenuTargetKind,
  type RangeProjectionResult,
  type RangeTsvExportResult,
  type SpreadsheetError,
} from '@einfach/spreadsheet-ui-core'

import {
  advanceSpreadsheetProjectionRequestIdAtom,
  isVisibleProjectionResult,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetContextMenuProps {
  class?: string
  'data-testid'?: string
}

const commandLabels: Record<MenuCommandKind, string> = {
  'clipboard.copy': 'Copy',
  'clipboard.cut': 'Cut',
  'clipboard.paste': 'Paste',
  'cell.clear': 'Delete',
  'row.insert': 'Insert row',
  'row.delete': 'Delete row',
  'column.insert': 'Insert column',
  'column.delete': 'Delete column',
  'formatting.open': 'Formatting',
}

const commandsByTargetKind: Record<MenuTargetKind, MenuCommandKind[]> = {
  cell: ['clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'cell.clear'],
  range: ['clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'cell.clear'],
  row: ['row.insert', 'row.delete'],
  column: ['column.insert', 'column.delete'],
  all: ['row.insert', 'row.delete', 'column.insert', 'column.delete'],
  'sheet-tab': [],
}

const CLIPBOARD_CELL_LIMIT = 10_000

function toInt(value: number) {
  return Math.trunc(value)
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

function toA1(coord: CellCoord): string {
  return `${getColumnLabel(coord.col)}${coord.row + 1}`
}

function parseA1(addr: string): CellCoord | null {
  const match = addr.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!match) return null

  let col = 0
  for (let index = 0; index < match[1].length; index += 1) {
    col = col * 26 + (match[1].charCodeAt(index) - 64)
  }

  const row = Number(match[2]) - 1
  if (!Number.isInteger(row) || row < 0) return null
  return { row, col: col - 1 }
}

function rangeCellCount(range: CellRange): number {
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) return 0
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

function clipboardTextCellCount(data: ClipboardTextData): number {
  return data.cells.reduce((count, row) => count + row.length, 0)
}

function addClipboardOriginMarker(text: string, originAddr: string): string {
  return `${CLIPBOARD_ORIGIN_MARKER_PREFIX}${originAddr}\n${text}`
}

function targetToRange(target: MenuTarget): CellRange | null {
  switch (target.kind) {
    case 'cell':
      return {
        rowStart: target.cell.row,
        rowEnd: target.cell.row,
        colStart: target.cell.col,
        colEnd: target.cell.col,
      }
    case 'range':
      return { ...target.range }
    default:
      return null
  }
}

function dataRangeFromOrigin(origin: CellCoord, data: ClipboardTextData): CellRange {
  const rowCount = Math.max(1, data.cells.length)
  const colCount = Math.max(1, ...data.cells.map((row) => row.length))
  return {
    rowStart: origin.row,
    rowEnd: origin.row + rowCount - 1,
    colStart: origin.col,
    colEnd: origin.col + colCount - 1,
  }
}

function resultToClipboardText(result: RangeProjectionResult, range: CellRange): ClipboardTextData {
  const cellsByKey = new Map<string, RangeProjectionResult['cells'][number]>()
  for (const cell of result.cells) {
    cellsByKey.set(`${cell.row}:${cell.col}`, cell)
  }

  const cells: string[][] = []
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    const fields: string[] = []
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const cell = cellsByKey.get(`${row}:${col}`)
      fields.push(cell?.formula ?? cell?.displayValue ?? '')
    }
    cells.push(fields)
  }

  return {
    originAddr: toA1({ row: range.rowStart, col: range.colStart }),
    cells,
  }
}

function clipboardDataToImportCells(
  data: ClipboardTextData,
  targetOrigin: CellCoord,
  drow: number,
  dcol: number,
): ImportCellInput[] {
  const cells: ImportCellInput[] = []
  for (const [rowOffset, row] of data.cells.entries()) {
    for (const [colOffset, field] of row.entries()) {
      cells.push({
        row: targetOrigin.row + rowOffset,
        col: targetOrigin.col + colOffset,
        input: field.startsWith('=') ? shiftFormulaRefs(field, drow, dcol) : field,
      })
    }
  }
  return cells
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

async function readClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

function clipboardError(message: string): SpreadsheetError {
  return {
    code: 'BACKEND_ERROR',
    message,
  }
}

export function SpreadsheetContextMenu(props: SpreadsheetContextMenuProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const menuState = useAtomValue(menuStateAtom)
  let menuRoot: HTMLDivElement | undefined

  function closeMenu(reason: 'dismissed' | 'committed' = 'dismissed') {
    store.setter(closeMenuAtom, reason)
  }

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
      reason: 'selection',
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

  async function readClipboardSource(sheetId: string, range: CellRange) {
    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = createRangeProjectionRequest({
      sheetId,
      requestId,
      reason: 'clipboard',
      range,
    })

    return backend.readRangeProjection(request)
  }

  async function exportClipboardSource(
    sheetId: string,
    range: CellRange,
  ): Promise<RangeTsvExportResult | null> {
    if (!backend.exportRangeTsv) {
      const cellCount = rangeCellCount(range)
      store.setter(
        setClipboardErrorAtom,
        clipboardError(
          `Clipboard range is too large: ${cellCount} cells. Backend streaming export unavailable.`,
        ),
      )
      return null
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    return backend.exportRangeTsv({
      kind: 'export-range-tsv',
      sheetId,
      range,
      requestId,
    })
  }

  async function copyRangeToClipboard(
    sheetId: string,
    range: CellRange,
    operation: 'copy' | 'cut' = 'copy',
  ): Promise<boolean> {
    const cellCount = rangeCellCount(range)
    let text: string
    let transferInput: ClipboardTransferInput
    if (cellCount > CLIPBOARD_CELL_LIMIT) {
      const result = await exportClipboardSource(sheetId, range)
      if (!result) return false

      text = addClipboardOriginMarker(result.text, result.originAddr)
      const data = parseClipboardTsv(text, result.originAddr)
      transferInput = {
        source: { sheetId, range },
        serialization: 'tab-separated' as const,
        includesFormulas: data.cells.some((row) => row.some((field) => field.startsWith('='))),
        includesErrors: false,
        estimatedBytes: result.estimatedBytes ?? text.length,
        revision: result.revision ?? undefined,
      }
    } else {
      const result = await readClipboardSource(sheetId, range)
      if (!result) return false

      const data = resultToClipboardText(result, range)
      text = serializeClipboardTsv(data)
      transferInput = {
        source: { sheetId, range },
        serialization: 'tab-separated' as const,
        includesFormulas: data.cells.some((row) => row.some((field) => field.startsWith('='))),
        includesErrors: result.cells.some((cell) => cell.valueKind === 'error' || !!cell.error),
        estimatedBytes: text.length,
        revision: result.revision ?? undefined,
      }
    }
    store.setter(operation === 'cut' ? cutClipboardAtom : copyClipboardAtom, transferInput)

    if (!(await writeClipboardText(text))) {
      store.setter(setClipboardErrorAtom, clipboardError('Clipboard write failed.'))
      return false
    }

    store.setter(markClipboardReadyAtom)
    return true
  }

  async function clearClipboardSource(sheetId: string, range: CellRange) {
    if (rangeCellCount(range) === 1) {
      await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId,
        row: range.rowStart,
        col: range.colStart,
        input: '',
      })
      return
    }

    if (!backend.clearRange) {
      throw new Error('Range clear is not supported by this spreadsheet backend.')
    }
    await backend.clearRange({
      kind: 'clear-range',
      sheetId,
      range,
    })
  }

  async function pasteClipboardText(sheetId: string, targetRange: CellRange) {
    const text = await readClipboardText()
    if (text === null || text.length === 0) {
      store.setter(setClipboardErrorAtom, clipboardError('Clipboard read failed.'))
      return
    }

    const targetOrigin = { row: targetRange.rowStart, col: targetRange.colStart }
    const targetAddr = toA1(targetOrigin)
    const data = parseClipboardTsv(text, targetAddr)
    const cellCount = clipboardTextCellCount(data)
    const origin = parseA1(data.originAddr) ?? targetOrigin
    const drow = targetOrigin.row - origin.row
    const dcol = targetOrigin.col - origin.col
    const sourceRange = dataRangeFromOrigin(origin, data)
    const pasteRange = dataRangeFromOrigin(targetOrigin, data)

    if (cellCount > CLIPBOARD_CELL_LIMIT && !backend.importCells) {
      store.setter(
        setClipboardErrorAtom,
        clipboardError(
          `Clipboard paste is too large: ${cellCount} cells. Backend streaming import unavailable.`,
        ),
      )
      return
    }

    store.setter(pasteClipboardAtom, {
      source: { sheetId, range: sourceRange },
      target: { sheetId, range: pasteRange },
      serialization: 'tab-separated',
      includesFormulas: data.cells.some((row) => row.some((field) => field.startsWith('='))),
      estimatedBytes: text.length,
    })

    if (cellCount > CLIPBOARD_CELL_LIMIT && backend.importCells) {
      await backend.importCells({
        kind: 'import-cells',
        sheetId,
        cells: clipboardDataToImportCells(data, targetOrigin, drow, dcol),
        range: pasteRange,
      })
    } else {
      for (const cell of clipboardDataToImportCells(data, targetOrigin, drow, dcol)) {
        await backend.setCellInput({
          kind: 'set-cell-input',
          sheetId,
          row: cell.row,
          col: cell.col,
          input: cell.input,
        })
      }
    }

    store.setter(markClipboardReadyAtom)
    await refreshProjection(sheetId)
  }

  async function executeClipboardCommand(intent: MenuCommandIntent) {
    const range = targetToRange(intent.target)
    if (!range) return

    switch (intent.command) {
      case 'clipboard.copy':
        await copyRangeToClipboard(intent.target.sheetId, range)
        return
      case 'clipboard.cut':
        if (await copyRangeToClipboard(intent.target.sheetId, range, 'cut')) {
          await clearClipboardSource(intent.target.sheetId, range)
          store.setter(markClipboardReadyAtom)
          await refreshProjection(intent.target.sheetId)
        }
        return
      case 'clipboard.paste':
        await pasteClipboardText(intent.target.sheetId, range)
        return
      default:
        return
    }
  }

  async function executeCommand(intent: MenuCommandIntent) {
    const target = intent.target
    switch (intent.command) {
      case 'clipboard.copy':
      case 'clipboard.cut':
      case 'clipboard.paste':
        await executeClipboardCommand(intent)
        return
      case 'cell.clear':
        if (target.kind === 'cell') {
          await backend.setCellInput({
            kind: 'set-cell-input',
            sheetId: target.sheetId,
            row: target.cell.row,
            col: target.cell.col,
            input: '',
          })
        } else if (target.kind === 'range') {
          if (!backend.clearRange) {
            throw new Error('Range clear is not supported by this spreadsheet backend.')
          }
          await backend.clearRange({
            kind: 'clear-range',
            sheetId: target.sheetId,
            range: target.range,
          })
        } else {
          return
        }
        break
      case 'row.insert':
        if (target.kind !== 'row') return
        if (!backend.insertRows) {
          throw new Error('Row insert is not supported by this spreadsheet backend.')
        }
        await backend.insertRows({
          kind: 'insert-rows',
          sheetId: target.sheetId,
          rowIndex: target.rowIndex,
          count: 1,
        })
        break
      case 'row.delete':
        if (target.kind !== 'row') return
        if (!backend.deleteRows) {
          throw new Error('Row delete is not supported by this spreadsheet backend.')
        }
        await backend.deleteRows({
          kind: 'delete-rows',
          sheetId: target.sheetId,
          rowIndex: target.rowIndex,
          count: 1,
        })
        break
      case 'column.insert':
        if (target.kind !== 'column') return
        if (!backend.insertColumns) {
          throw new Error('Column insert is not supported by this spreadsheet backend.')
        }
        await backend.insertColumns({
          kind: 'insert-columns',
          sheetId: target.sheetId,
          colIndex: target.colIndex,
          count: 1,
        })
        break
      case 'column.delete':
        if (target.kind !== 'column') return
        if (!backend.deleteColumns) {
          throw new Error('Column delete is not supported by this spreadsheet backend.')
        }
        await backend.deleteColumns({
          kind: 'delete-columns',
          sheetId: target.sheetId,
          colIndex: target.colIndex,
          count: 1,
        })
        break
      default:
        return
    }
    await refreshProjection(target.sheetId)
  }

  function reportCommandError(error: unknown) {
    const current = store.getter(spreadsheetProjectionSnapshotAtom)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      ...current,
      status: 'error',
      error:
        error instanceof Error
          ? { code: 'BACKEND_ERROR', message: error.message }
          : { code: 'BACKEND_ERROR', message: 'Spreadsheet command failed.' },
    })
  }

  function dispatchCommand(command: MenuCommandKind) {
    const intent = store.setter(dispatchMenuCommandAtom, command)
    if (intent) {
      void executeCommand(intent)
        .catch(reportCommandError)
        .finally(() => {
          setTimeout(() => {
            closeMenu('committed')
          }, 0)
        })
    }
  }

  function onDocumentMouseDown(event: MouseEvent) {
    if (menuState().status !== 'open' || !menuRoot) {
      return
    }

    if (!menuRoot.contains(event.target as Node)) {
      closeMenu()
    }
  }

  function onDocumentKeyDown(event: KeyboardEvent) {
    if (menuState().status !== 'open') {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)

    onCleanup(() => {
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      document.removeEventListener('keydown', onDocumentKeyDown, true)
    })
  })

  const canRender = () =>
    menuState().status === 'open' && menuState().target !== null && menuState().position !== null
  const commandList = () => {
    const target = menuState().target
    return target ? commandsByTargetKind[target.kind] : []
  }
  const targetRow = () => {
    const target = menuState().target
    return target?.kind === 'row' ? `${target.rowIndex}` : ''
  }
  const targetCol = () => {
    const target = menuState().target
    return target?.kind === 'column' ? `${target.colIndex}` : ''
  }

  return (
    <Show when={canRender()}>
      <div
        class={`context-menu spreadsheet-context-menu ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'spreadsheet-context-menu'}
        data-menu-status={menuState().status}
        data-menu-surface={menuState().surface ?? ''}
        data-menu-target-kind={menuState().target?.kind ?? ''}
        data-menu-target-sheet-id={menuState().target?.sheetId ?? ''}
        data-menu-target-row={targetRow()}
        data-menu-target-col={targetCol()}
        role="menu"
        style={{
          position: 'absolute',
          left: `${toInt(menuState().position?.x ?? 0)}px`,
          top: `${toInt(menuState().position?.y ?? 0)}px`,
          'z-index': 1000,
        }}
        onContextMenu={(event) => {
          event.preventDefault()
        }}
        ref={(node) => {
          menuRoot = node
        }}
      >
        <For each={commandList()}>
          {(command) => (
            <button
              type="button"
              role="menuitem"
              class="context-menu-item spreadsheet-context-menu-item"
              data-menu-command={command}
              data-testid={`context-menu-command-${command}`}
              onClick={() => {
                dispatchCommand(command)
              }}
            >
              {commandLabels[command]}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
