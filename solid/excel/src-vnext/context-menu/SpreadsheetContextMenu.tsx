import { createEffect, onCleanup, onMount, For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  CLIPBOARD_ORIGIN_MARKER_PREFIX,
  beginProjectionAtom,
  closeMenuAtom,
  copyClipboardAtom,
  createClipboardTsvPastePlan,
  createDeleteColumnsOperation,
  createDeleteRowsOperation,
  createInsertColumnsOperation,
  createInsertRowsOperation,
  cutClipboardAtom,
  dispatchMenuCommandAtom,
  markClipboardReadyAtom,
  menuIntentAtom,
  menuStateAtom,
  openPasteSpecialAtom,
  pasteClipboardAtom,
  pasteSpecialCapabilityAtom,
  issueProjectionRequestIdAtom,
  isViewportHiddenContextMenuCommand,
  rejectProjectionAtom,
  reportProjectionErrorAtom,
  resolveProjectionAtom,
  runViewportHiddenContextMenuCommandAtom,
  runStructureOperationAtom,
  serializeClipboardTsv,
  setClipboardErrorAtom,
  setFreezeConfigAtom,
  viewportFreezeAtom,
  viewportHiddenContextMenuCommandAvailabilityAtom,
  type CellCoord,
  type CellRange,
  type ClipboardTextData,
  type ClipboardTransferInput,
  type MenuCommandIntent,
  type MenuCommandKind,
  type MenuCloseReason,
  type MenuTarget,
  type MenuTargetKind,
  type RangeProjectionResult,
  type RangeTsvChunkExportResult,
  type RangeTsvExportResult,
  type SpreadsheetError,
  type StructureOperationIntent,
} from '@einfach/spreadsheet-ui-core'
import { useT } from '../../src/i18n'

import { refreshVisibleProjection, useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetContextMenuProps {
  class?: string
  'data-testid'?: string
}

type ContextMenuCommandKind = MenuCommandKind | 'clipboard.pasteSpecial'

const commandLabelKeys: Record<ContextMenuCommandKind, string> = {
  'clipboard.copy': 'contextMenu.command.copy',
  'clipboard.cut': 'contextMenu.command.cut',
  'clipboard.paste': 'contextMenu.command.paste',
  'clipboard.pasteSpecial': 'menuBar.edit.pasteSpecial',
  'cell.clear': 'contextMenu.command.delete',
  'row.insert': 'contextMenu.command.insertRow',
  'row.delete': 'contextMenu.command.deleteRow',
  'row.hide': 'menuBar.format.hideRow',
  'row.unhide': 'menuBar.format.unhideRow',
  'column.insert': 'contextMenu.command.insertColumn',
  'column.delete': 'contextMenu.command.deleteColumn',
  'column.hide': 'menuBar.format.hideCol',
  'column.unhide': 'menuBar.format.unhideCol',
  'formatting.open': 'contextMenu.command.formatting',
  'view.freezeRowsHere': 'contextMenu.command.freezeRowsHere',
  'view.freezeColsHere': 'contextMenu.command.freezeColsHere',
  'view.freezePanes': 'contextMenu.command.freezePanes',
  'view.unfreeze': 'contextMenu.command.unfreeze',
}

const commandsByTargetKind: Record<MenuTargetKind, ContextMenuCommandKind[]> = {
  cell: [
    'clipboard.copy',
    'clipboard.cut',
    'clipboard.paste',
    'clipboard.pasteSpecial',
    'cell.clear',
    'view.freezePanes',
    'view.freezeRowsHere',
    'view.freezeColsHere',
    'view.unfreeze',
  ],
  range: [
    'clipboard.copy',
    'clipboard.cut',
    'clipboard.paste',
    'clipboard.pasteSpecial',
    'cell.clear',
    'view.freezePanes',
    'view.freezeRowsHere',
    'view.freezeColsHere',
    'view.unfreeze',
  ],
  row: [
    'row.insert',
    'row.delete',
    'row.hide',
    'row.unhide',
    'view.freezeRowsHere',
    'view.unfreeze',
  ],
  column: [
    'column.insert',
    'column.delete',
    'column.hide',
    'column.unhide',
    'view.freezeColsHere',
    'view.unfreeze',
  ],
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

function rangeCellCount(range: CellRange): number {
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) return 0
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
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

function dataRangeFromOrigin(origin: CellCoord, rowCount: number, colCount: number): CellRange {
  const rows = Math.max(1, rowCount)
  const cols = Math.max(1, colCount)
  return {
    rowStart: origin.row,
    rowEnd: origin.row + rows - 1,
    colStart: origin.col,
    colEnd: origin.col + cols - 1,
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
  const menuIntent = useAtomValue(menuIntentAtom)
  const menuState = useAtomValue(menuStateAtom)
  const pasteSpecialCapability = useAtomValue(pasteSpecialCapabilityAtom)
  const viewportHiddenCommandAvailable = useAtomValue(
    viewportHiddenContextMenuCommandAvailabilityAtom,
  )
  let menuRoot: HTMLDivElement | undefined
  let keyboardFocusReturnTarget: HTMLElement | null = null

  function closeMenu(reason: MenuCloseReason = 'dismissed') {
    store.setter(closeMenuAtom, reason)
  }

  async function readClipboardSource(sheetId: string, range: CellRange) {
    const begin = store.setter(beginProjectionAtom, {
      kind: 'range',
      sheetId,
      reason: 'clipboard',
      range,
    })
    if (begin.status !== 'started' || begin.request.kind !== 'range') return null

    const request = begin.request
    try {
      const result = await backend.readRangeProjection(request)
      const outcome = store.setter(resolveProjectionAtom, { request, result })
      return outcome.status === 'accepted' && outcome.result.kind === 'range'
        ? outcome.result
        : null
    } catch (error: unknown) {
      store.setter(rejectProjectionAtom, { request, error })
      throw error
    }
  }

  async function consumeClipboardSource(
    sheetId: string,
    range: CellRange,
    onChunk: (chunk: string) => void | Promise<void>,
  ): Promise<RangeTsvChunkExportResult | RangeTsvExportResult | null> {
    const requestId = store.setter(issueProjectionRequestIdAtom)
    if (requestId === null) {
      store.setter(
        setClipboardErrorAtom,
        clipboardError('Clipboard export could not allocate a request id.'),
      )
      return null
    }
    const request = {
      kind: 'export-range-tsv' as const,
      sheetId,
      range,
      requestId,
    }

    if (backend.consumeExportRangeTsvChunks) {
      return backend.consumeExportRangeTsvChunks(request, (chunk) => onChunk(chunk.text))
    }

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

    const result = await backend.exportRangeTsv(request)
    await onChunk(result.text)
    return result
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
      const clipboardChunks: string[] = []
      const result = await consumeClipboardSource(sheetId, range, (chunk) => {
        clipboardChunks.push(chunk)
      })
      if (!result) return false

      text = addClipboardOriginMarker(clipboardChunks.join('\n'), result.originAddr)
      const plan = createClipboardTsvPastePlan({
        text,
        fallbackOriginAddr: result.originAddr,
        targetOrigin: { row: range.rowStart, col: range.colStart },
      })
      transferInput = {
        source: { sheetId, range },
        serialization: 'tab-separated' as const,
        includesFormulas: plan.includesFormulas,
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
    const plan = createClipboardTsvPastePlan({
      text,
      fallbackOriginAddr: targetAddr,
      targetOrigin,
    })
    const cellCount = plan.cellCount
    const sourceRange = dataRangeFromOrigin(plan.sourceOrigin, plan.rowCount, plan.colCount)
    const pasteRange = plan.estimatedRange

    if (cellCount > CLIPBOARD_CELL_LIMIT && !backend.importCellChunks) {
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
      includesFormulas: plan.includesFormulas,
      estimatedBytes: plan.estimatedBytes,
    })

    if (cellCount > CLIPBOARD_CELL_LIMIT && backend.importCellChunks) {
      await backend.importCellChunks({
        kind: 'import-cell-chunks',
        sheetId,
        chunks: (function* () {
          for (const chunk of plan.chunks()) yield chunk.cells
        })(),
        range: pasteRange,
      })
    } else {
      for (const chunk of plan.chunks()) {
        for (const cell of chunk.cells) {
          await backend.setCellInput({
            kind: 'set-cell-input',
            sheetId,
            row: cell.row,
            col: cell.col,
            input: cell.input,
          })
        }
      }
    }

    store.setter(markClipboardReadyAtom)
    await refreshVisibleProjection(store, backend, sheetId, 'selection')
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
          await refreshVisibleProjection(store, backend, intent.target.sheetId, 'selection')
        }
        return
      case 'clipboard.paste':
        await pasteClipboardText(intent.target.sheetId, range)
        return
      default:
        return
    }
  }

  async function dispatchStructureOperation(intent: StructureOperationIntent) {
    await store.setter(runStructureOperationAtom, {
      intent,
      source: backend,
      refreshProjection: (sheetId) =>
        refreshVisibleProjection(store, backend, sheetId, 'selection'),
    })
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
        await dispatchStructureOperation(
          createInsertRowsOperation({
            sheetId: target.sheetId,
            rowIndex: target.rowIndex,
            count: 1,
            source: 'selection',
          }),
        )
        return
      case 'row.delete':
        if (target.kind !== 'row') return
        await dispatchStructureOperation(
          createDeleteRowsOperation({
            sheetId: target.sheetId,
            rowIndex: target.rowIndex,
            count: 1,
            source: 'selection',
          }),
        )
        return
      case 'column.insert':
        if (target.kind !== 'column') return
        await dispatchStructureOperation(
          createInsertColumnsOperation({
            sheetId: target.sheetId,
            colIndex: target.colIndex,
            count: 1,
            source: 'selection',
          }),
        )
        return
      case 'column.delete':
        if (target.kind !== 'column') return
        await dispatchStructureOperation(
          createDeleteColumnsOperation({
            sheetId: target.sheetId,
            colIndex: target.colIndex,
            count: 1,
            source: 'selection',
          }),
        )
        return
      case 'row.hide':
      case 'row.unhide':
      case 'column.hide':
      case 'column.unhide':
        await store.setter(runViewportHiddenContextMenuCommandAtom, {
          source: backend,
          command: intent.command,
        })
        return
      case 'view.freezeRowsHere': {
        const rowIndex =
          target.kind === 'row'
            ? target.rowIndex
            : target.kind === 'cell'
              ? target.cell.row
              : target.kind === 'range'
                ? target.range.rowStart
                : null
        if (rowIndex === null) return
        store.setter(setFreezeConfigAtom, {
          source: backend,
          sheetId: target.sheetId,
          rows: rowIndex,
        })
        return
      }
      case 'view.freezeColsHere': {
        const colIndex =
          target.kind === 'column'
            ? target.colIndex
            : target.kind === 'cell'
              ? target.cell.col
              : target.kind === 'range'
                ? target.range.colStart
                : null
        if (colIndex === null) return
        store.setter(setFreezeConfigAtom, {
          source: backend,
          sheetId: target.sheetId,
          cols: colIndex,
        })
        return
      }
      case 'view.freezePanes':
        if (target.kind !== 'cell' && target.kind !== 'range') return
        {
          const anchor =
            target.kind === 'cell'
              ? { row: target.cell.row, col: target.cell.col }
              : { row: target.range.rowStart, col: target.range.colStart }
          store.setter(setFreezeConfigAtom, {
            source: backend,
            sheetId: target.sheetId,
            rows: anchor.row,
            cols: anchor.col,
          })
        }
        return
      case 'view.unfreeze':
        store.setter(setFreezeConfigAtom, {
          source: backend,
          sheetId: target.sheetId,
          rows: 0,
          cols: 0,
        })
        return
      default:
        return
    }
    await refreshVisibleProjection(store, backend, target.sheetId, 'selection')
  }

  function reportCommandError(error: unknown) {
    store.setter(reportProjectionErrorAtom, {
      error,
      fallbackMessage: 'Spreadsheet command failed.',
      code: 'BACKEND_ERROR',
    })
  }

  function dispatchCommand(command: ContextMenuCommandKind) {
    if (command === 'clipboard.pasteSpecial') {
      if (!store.getter(pasteSpecialCapabilityAtom)) return
      store.setter(openPasteSpecialAtom)
      closeMenu('committed')
      return
    }
    if (isViewportHiddenContextMenuCommand(command) && !viewportHiddenCommandAvailable()(command)) {
      return
    }
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
      keyboardFocusReturnTarget = null
      closeMenu()
    }
  }

  function onDocumentKeyDown(event: KeyboardEvent) {
    if (menuState().status !== 'open') {
      return
    }

    if (event.key === 'Escape') {
      const focusReturnTarget = keyboardFocusReturnTarget
      keyboardFocusReturnTarget = null
      event.preventDefault()
      closeMenu('cancelled')
      queueMicrotask(() => {
        if (focusReturnTarget?.isConnected) {
          focusReturnTarget.focus()
        }
      })
    }
  }

  createEffect(() => {
    const intent = menuIntent()
    if (intent?.type !== 'menu.open') {
      return
    }
    if (intent.source !== 'keyboard') {
      keyboardFocusReturnTarget = null
      return
    }

    const activeElement = document.activeElement
    keyboardFocusReturnTarget = activeElement instanceof HTMLElement ? activeElement : null
    queueMicrotask(() => {
      const latestIntent = store.getter(menuIntentAtom)
      if (
        store.getter(menuStateAtom).status !== 'open' ||
        latestIntent?.type !== 'menu.open' ||
        latestIntent.source !== 'keyboard'
      ) {
        return
      }
      menuRoot
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([hidden]):not([disabled])')
        ?.focus()
    })
  })

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

  const t = useT()
  const freezeState = useAtomValue(viewportFreezeAtom)

  function labelFor(command: ContextMenuCommandKind): string {
    return t(commandLabelKeys[command])
  }

  function tooltipFor(command: ContextMenuCommandKind, target: MenuTarget): string | undefined {
    switch (command) {
      case 'view.freezeRowsHere': {
        const count =
          target.kind === 'row'
            ? target.rowIndex
            : target.kind === 'cell'
              ? target.cell.row
              : target.kind === 'range'
                ? target.range.rowStart
                : 0
        return t('contextMenu.command.freezeRowsHere.tooltip', { count })
      }
      case 'view.freezeColsHere': {
        const count =
          target.kind === 'column'
            ? target.colIndex
            : target.kind === 'cell'
              ? target.cell.col
              : target.kind === 'range'
                ? target.range.colStart
                : 0
        return t('contextMenu.command.freezeColsHere.tooltip', { count })
      }
      case 'view.freezePanes':
        return t('contextMenu.command.freezePanes.tooltip')
      default:
        return undefined
    }
  }

  function isCommandVisibleForTarget(command: ContextMenuCommandKind, target: MenuTarget): boolean {
    if (command === 'clipboard.pasteSpecial') return pasteSpecialCapability()
    // Hidden rows/columns are UI-core canonical: entry visibility reads
    // the local view fact and selection only — never backend hidden ports.
    if (isViewportHiddenContextMenuCommand(command)) {
      return viewportHiddenCommandAvailable()(command)
    }
    // Freeze is UI-core canonical: entry visibility reads the local view
    // fact directly and never depends on backend freeze ports.
    const freeze = freezeState()
    const rows = freeze.rowsBySheet[target.sheetId] ?? 0
    const cols = freeze.colsBySheet[target.sheetId] ?? 0
    const frozen = rows > 0 || cols > 0
    switch (command) {
      case 'view.freezeRowsHere':
        if (target.kind === 'row') return target.rowIndex > 0
        if (target.kind === 'cell') return target.cell.row > 0
        if (target.kind === 'range') return target.range.rowStart > 0
        return false
      case 'view.freezeColsHere':
        if (target.kind === 'column') return target.colIndex > 0
        if (target.kind === 'cell') return target.cell.col > 0
        if (target.kind === 'range') return target.range.colStart > 0
        return false
      case 'view.freezePanes':
        // Freezing both at (0,0) would clear; hide the affirmative item there.
        if (target.kind === 'cell') return target.cell.row > 0 || target.cell.col > 0
        if (target.kind === 'range') {
          return target.range.rowStart > 0 || target.range.colStart > 0
        }
        return false
      case 'view.unfreeze':
        return frozen
      default:
        return true
    }
  }

  const commandList = () => {
    const target = menuState().target
    if (!target) return [] as ContextMenuCommandKind[]
    return commandsByTargetKind[target.kind].filter((command) =>
      isCommandVisibleForTarget(command, target),
    )
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
              title={tooltipFor(command, menuState().target!)}
              onClick={() => {
                dispatchCommand(command)
              }}
            >
              {labelFor(command)}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
