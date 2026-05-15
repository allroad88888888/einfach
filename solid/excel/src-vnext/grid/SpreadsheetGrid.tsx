import {
  cancelEditingAtom,
  cancelPointerAtom,
  commitPointerAtom,
  commitEditingAtom,
  createFillHandlePreview,
  createVisibleProjectionRequest,
  dispatchKeyboardInputAtom,
  editingDraftAtom,
  editingSessionAtom,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  getAdjacentSheetId,
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  getViewportColumnWidth,
  getViewportRowHeight,
  getSelectionRange,
  addSelectionRegionAtom,
  clearNonPrimaryRegionsAtom,
  isMergeCovered,
  openMenuAtom,
  pointerSessionAtom,
  MAX_VIEWPORT_COL_WIDTH,
  MAX_VIEWPORT_ROW_HEIGHT,
  MIN_VIEWPORT_COL_WIDTH,
  MIN_VIEWPORT_ROW_HEIGHT,
  selectionSnapshotAtom,
  selectionRegionsAtom,
  selectAllAtom,
  selectCellAtom,
  selectColumnsAtom,
  selectRowsAtom,
  setSelectionAtom,
  setViewportHiddenAtom,
  setViewportColumnWidthAtom,
  setSelectionBoundsAtom,
  setWorkspaceActiveSheetAtom,
  setViewportRowHeightAtom,
  setViewportMetricsAtom,
  sheetTabsSheetsAtom,
  startPointerAtom,
  startEditingAtom,
  updatePointerAtom,
  type CellCoord,
  type CellRange,
  type DisplayCell,
  type PointerFillHandleCommitIntent,
  type SelectionRegion,
  type SelectionState,
  type SpreadsheetCellFormat,
  type ViewportMetrics,
  viewportHiddenAtom,
  viewportSizeOverridesAtom,
  visibleWindowAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  advanceSpreadsheetProjectionRequestIdAtom,
  spreadsheetProjectionSnapshotAtom,
} from '../provider'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetGridProps {
  sheetId: string
  viewport: ViewportMetrics
  class?: string
  'data-testid'?: string
}

function makeCellKey(row: number, col: number) {
  return `${row}:${col}`
}

function getWindowIndexes(start: number, end: number) {
  if (end < start) {
    return []
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function getColumnLabel(index: number): string {
  let n = index + 1
  let label = ''

  while (n > 0) {
    const remainder = (n - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    n = Math.floor((n - 1) / 26)
  }

  return label
}

function getCellAddress(row: number, col: number): string {
  return `${getColumnLabel(col)}${row + 1}`
}

function getCellFormatStyle(format: SpreadsheetCellFormat | undefined): Record<string, string> {
  if (!format) return {}

  const style: Record<string, string> = {}
  if (format.bgColor) style['background'] = format.bgColor
  if (format.fgColor) style['color'] = format.fgColor
  if (format.bold) style['font-weight'] = '700'
  if (format.italic) style['font-style'] = 'italic'
  if (format.align && format.align !== 'default') style['text-align'] = format.align
  if (format.fontSize) style['font-size'] = `${format.fontSize}px`
  return style
}

function getDisplayCellFormat(cell: DisplayCell | undefined): SpreadsheetCellFormat | undefined {
  if (!cell?.format && !cell?.conditionalFormat) return undefined
  return {
    ...(cell.format ?? {}),
    ...(cell.conditionalFormat ?? {}),
    numberFormat: cell.conditionalFormat?.numberFormat ?? cell.format?.numberFormat,
  }
}

function getCellValidationSeverity(cell: DisplayCell | undefined): string | undefined {
  return cell?.validation?.severity
}

function getCellValidationMessage(cell: DisplayCell | undefined): string | undefined {
  return cell?.validation?.message
}

function getRangeCellCount(range: CellRange): number {
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

function isCoordInRange(row: number, col: number, range: CellRange): boolean {
  return (
    row >= range.rowStart &&
    row <= range.rowEnd &&
    col >= range.colStart &&
    col <= range.colEnd
  )
}

function getCellInputForFill(cell: DisplayCell | undefined): string {
  return cell?.formula ?? cell?.displayValue ?? ''
}

const MAX_UI_FILL_FALLBACK_CELLS = 200
const AUTO_FIT_CELL_PADDING_PX = 16
const AUTO_FIT_ROW_PADDING_PX = 4

function clampDimension(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.max(min, Math.min(max, Math.round(value)))
}

function parseCssPx(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function textUnitCount(text: string): number {
  return Math.max(1, Array.from(text).length)
}

function fallbackTextWidth(text: string, style: CSSStyleDeclaration): number {
  const fontSize = parseCssPx(style.fontSize) || 12
  return textUnitCount(text) * fontSize * 0.62
}

function measureTextBox(
  source: HTMLElement,
  text: string,
): { width: number; height: number; style: CSSStyleDeclaration } {
  const style = window.getComputedStyle(source)
  const probe = document.createElement('span')
  probe.textContent = text.length > 0 ? text : ' '
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.whiteSpace = 'pre'
  probe.style.font = style.font
  probe.style.fontSize = style.fontSize
  probe.style.fontFamily = style.fontFamily
  probe.style.fontWeight = style.fontWeight
  probe.style.fontStyle = style.fontStyle
  probe.style.letterSpacing = style.letterSpacing
  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()

  const fontSize = parseCssPx(style.fontSize) || 12
  const lineHeight = parseCssPx(style.lineHeight)
  return {
    width: rect.width > 0 ? rect.width : fallbackTextWidth(text, style),
    height: rect.height > 0 ? rect.height : Math.max(lineHeight, fontSize * 1.25),
    style,
  }
}

function measureAutoFitWidth(source: HTMLElement): number {
  const { width, style } = measureTextBox(source, source.textContent ?? '')
  return (
    width +
    parseCssPx(style.paddingLeft) +
    parseCssPx(style.paddingRight) +
    AUTO_FIT_CELL_PADDING_PX
  )
}

function measureAutoFitHeight(source: HTMLElement): number {
  const { height, style } = measureTextBox(source, source.textContent ?? '')
  return (
    height +
    parseCssPx(style.paddingTop) +
    parseCssPx(style.paddingBottom) +
    AUTO_FIT_ROW_PADDING_PX
  )
}

export function SpreadsheetGrid(props: SpreadsheetGridProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const [renderTick, setRenderTick] = createSignal(0)
  let gridRoot: HTMLDivElement | undefined
  let activeResizeCleanup: (() => void) | null = null
  let activeFillCleanup: (() => void) | null = null
  let unsubscribeProjection: (() => void) | null = null
  let unsubscribeSizes: (() => void) | null = null
  let unsubscribeHidden: (() => void) | null = null
  let unsubscribePointer: (() => void) | null = null

  function bumpRender() {
    setRenderTick((value) => value + 1)
  }

  function visibleWindow() {
    renderTick()
    return store.getter(visibleWindowAtom)
  }

  function projectionSnapshot() {
    renderTick()
    return store.getter(spreadsheetProjectionSnapshotAtom)
  }

  function selectionSnapshot() {
    renderTick()
    return store.getter(selectionSnapshotAtom)
  }

  function selectionRegions() {
    renderTick()
    return store.getter(selectionRegionsAtom)
  }

  function editingSession() {
    renderTick()
    return store.getter(editingSessionAtom)
  }

  function editingDraft() {
    renderTick()
    return store.getter(editingDraftAtom)
  }

  function sizeOverrides() {
    renderTick()
    return store.getter(viewportSizeOverridesAtom)
  }

  function hiddenState() {
    renderTick()
    return store.getter(viewportHiddenAtom)
  }

  function requestProjection() {
    const window = store.getter(visibleWindowAtom)
    if (window.rowEnd < window.rowStart || window.colEnd < window.colStart) {
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'idle',
        request: undefined,
        result: undefined,
        error: undefined,
      })
      bumpRender()
      return undefined
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = createVisibleProjectionRequest({
      sheetId: props.sheetId,
      window,
      requestId,
      reason: 'viewport',
    })

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'loading',
      request,
      result: undefined,
      error: undefined,
    })
    bumpRender()

    return { request, requestId }
  }

  async function loadProjection(requestInfo: ReturnType<typeof requestProjection>) {
    if (!requestInfo) {
      return
    }

    const { request, requestId } = requestInfo
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
    bumpRender()
  }

  async function hydrateViewportSizeProjection() {
    if (!backend.readViewportSizeProjection) {
      return
    }

    const window = store.getter(visibleWindowAtom)
    if (window.rowEnd < window.rowStart || window.colEnd < window.colStart) {
      return
    }

    const result = await backend.readViewportSizeProjection({
      kind: 'viewport-size',
      sheetId: props.sheetId,
      window,
    })

    for (const row of result.rowHeights) {
      store.setter(setViewportRowHeightAtom, {
        sheetId: props.sheetId,
        rowIndex: row.rowIndex,
        heightPx: row.heightPx,
      })
    }
    for (const col of result.colWidths) {
      store.setter(setViewportColumnWidthAtom, {
        sheetId: props.sheetId,
        colIndex: col.colIndex,
        widthPx: col.widthPx,
      })
    }
    if (result.hiddenRowIndices !== undefined || result.hiddenColIndices !== undefined) {
      store.setter(setViewportHiddenAtom, {
        sheetId: props.sheetId,
        rows: result.hiddenRowIndices,
        cols: result.hiddenColIndices,
      })
    }
    bumpRender()
  }

  async function persistColumnWidth(colIndex: number, widthPx: number) {
    if (!backend.setColumnWidth) {
      return
    }

    await backend.setColumnWidth({
      kind: 'set-column-width',
      sheetId: props.sheetId,
      colIndex,
      widthPx,
    })
  }

  async function persistRowHeight(rowIndex: number, heightPx: number) {
    if (!backend.setRowHeight) {
      return
    }

    await backend.setRowHeight({
      kind: 'set-row-height',
      sheetId: props.sheetId,
      rowIndex,
      heightPx,
    })
  }

  function getAutoFitColumnWidth(col: number): number {
    const headerLabel = gridRoot?.querySelector(
      `.spreadsheet-grid-col-header[data-col="${col}"] .spreadsheet-grid-header-label`,
    ) as HTMLElement | null
    let width = headerLabel ? measureAutoFitWidth(headerLabel) : props.viewport.colWidth

    const cells = gridRoot?.querySelectorAll(
      `td.spreadsheet-grid-cell[data-col="${col}"] .cell-display`,
    )
    cells?.forEach((cell) => {
      width = Math.max(width, measureAutoFitWidth(cell as HTMLElement))
    })

    return clampDimension(width, MIN_VIEWPORT_COL_WIDTH, MAX_VIEWPORT_COL_WIDTH)
  }

  function getAutoFitRowHeight(row: number): number {
    const rowLabel = gridRoot?.querySelector(
      `.spreadsheet-grid-row-header[data-row="${row}"] .spreadsheet-grid-header-label`,
    ) as HTMLElement | null
    let height = rowLabel ? measureAutoFitHeight(rowLabel) : props.viewport.rowHeight

    const cells = gridRoot?.querySelectorAll(
      `td.spreadsheet-grid-cell[data-row="${row}"] .cell-display`,
    )
    cells?.forEach((cell) => {
      height = Math.max(height, measureAutoFitHeight(cell as HTMLElement))
    })

    return clampDimension(height, MIN_VIEWPORT_ROW_HEIGHT, MAX_VIEWPORT_ROW_HEIGHT)
  }

  async function autoFitColumn(col: number) {
    activeResizeCleanup?.()
    activeFillCleanup?.()
    const widthPx = getAutoFitColumnWidth(col)
    store.setter(setViewportColumnWidthAtom, {
      sheetId: props.sheetId,
      colIndex: col,
      widthPx,
    })
    bumpRender()
    await persistColumnWidth(col, widthPx)
  }

  async function autoFitRow(row: number) {
    activeResizeCleanup?.()
    activeFillCleanup?.()
    const heightPx = getAutoFitRowHeight(row)
    store.setter(setViewportRowHeightAtom, {
      sheetId: props.sheetId,
      rowIndex: row,
      heightPx,
    })
    bumpRender()
    await persistRowHeight(row, heightPx)
  }

  onMount(() => {
    unsubscribeProjection = store.sub(spreadsheetProjectionSnapshotAtom, bumpRender)
    unsubscribeSizes = store.sub(viewportSizeOverridesAtom, bumpRender)
    unsubscribeHidden = store.sub(viewportHiddenAtom, bumpRender)
    unsubscribePointer = store.sub(pointerSessionAtom, bumpRender)
    store.setter(setViewportMetricsAtom, props.viewport)
    store.setter(setSelectionBoundsAtom, {
      rowCount: props.viewport.rowCount,
      colCount: props.viewport.colCount,
    })
    bumpRender()
    void loadProjection(requestProjection())
    void hydrateViewportSizeProjection()
  })

  onCleanup(() => {
    unsubscribeProjection?.()
    unsubscribeSizes?.()
    unsubscribeHidden?.()
    unsubscribePointer?.()
    activeResizeCleanup?.()
    activeFillCleanup?.()
    store.setter(cancelPointerAtom)
  })

  async function commitCellEdit() {
    const intent = store.setter(commitEditingAtom, {
      input: store.getter(editingDraftAtom),
      source: 'cell',
      move: 'none',
    })

    if (!intent) {
      return
    }

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: intent.sheetId,
      row: intent.cell.row,
      col: intent.cell.col,
      input: intent.input,
    })
    await loadProjection(requestProjection())
  }

  async function clearActiveCell() {
    const selection = selectionSnapshot()
    if (selection.selection.sheetId !== props.sheetId) {
      return
    }

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: props.sheetId,
      row: selection.activeCell.row,
      col: selection.activeCell.col,
      input: '',
    })
    await loadProjection(requestProjection())
  }

  function getCellMap() {
    const map = new Map<string, DisplayCell>()
    for (const cell of projectionSnapshot().result?.cells ?? []) {
      map.set(makeCellKey(cell.row, cell.col), cell)
    }
    return map
  }

  function getRows() {
    const window = visibleWindow()
    const hiddenRows = new Set(getHiddenRowsForSheet(hiddenState(), props.sheetId))
    return getWindowIndexes(window.rowStart, window.rowEnd).filter((row) => !hiddenRows.has(row))
  }

  function getCols() {
    const window = visibleWindow()
    const hiddenCols = new Set(getHiddenColumnsForSheet(hiddenState(), props.sheetId))
    return getWindowIndexes(window.colStart, window.colEnd).filter((col) => !hiddenCols.has(col))
  }

  function getSelectionBounds() {
    return {
      rowCount: props.viewport.rowCount,
      colCount: props.viewport.colCount,
    }
  }

  function getSelectionStateRange(selection: SelectionState): CellRange {
    return getSelectionRange(selection, getSelectionBounds())
  }

  function getSelectionRegionsForSheet() {
    return selectionRegions().filter((selection) => selection.sheetId === props.sheetId)
  }

  function getSelectionRangeContaining(row: number, col: number): CellRange | null {
    for (const region of getSelectionRegionsForSheet()) {
      const range = getSelectionStateRange(region)
      if (isCoordInRange(row, col, range)) {
        return range
      }
    }
    return null
  }

  function isSelected(row: number, col: number) {
    return getSelectionRangeContaining(row, col) !== null
  }

  function isRowSelected(row: number) {
    return getSelectionRegionsForSheet().some((region) => {
      if (region.kind !== 'row' && region.kind !== 'all') {
        return false
      }
      const range = getSelectionStateRange(region)
      return row >= range.rowStart && row <= range.rowEnd
    })
  }

  function isColumnSelected(col: number) {
    return getSelectionRegionsForSheet().some((region) => {
      if (region.kind !== 'column' && region.kind !== 'all') {
        return false
      }
      const range = getSelectionStateRange(region)
      return col >= range.colStart && col <= range.colEnd
    })
  }

  function isAllSelected() {
    return getSelectionRegionsForSheet().some((region) => region.kind === 'all')
  }

  function appendCellSelection(row: number, col: number) {
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'cell',
        sheetId: props.sheetId,
        anchor: { row, col },
        focus: { row, col },
      },
    })
  }

  function createSelectionForRange(range: CellRange): SelectionRegion {
    if (range.rowStart === range.rowEnd && range.colStart === range.colEnd) {
      return {
        kind: 'cell',
        sheetId: props.sheetId,
        anchor: { row: range.rowStart, col: range.colStart },
        focus: { row: range.rowStart, col: range.colStart },
      }
    }

    return {
      kind: 'range',
      sheetId: props.sheetId,
      anchor: { row: range.rowEnd, col: range.colEnd },
      focus: { row: range.rowStart, col: range.colStart },
    }
  }

  function selectCellRange(range: CellRange) {
    store.setter(setSelectionAtom, createSelectionForRange(range))
  }

  function appendCellRangeSelection(range: CellRange) {
    store.setter(addSelectionRegionAtom, {
      region: createSelectionForRange(range),
    })
  }

  function appendRangeSelection(row: number, col: number) {
    const snapshot = selectionSnapshot()
    const anchor =
      snapshot.selection.sheetId === props.sheetId ? snapshot.activeCell : { row, col }
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'range',
        sheetId: props.sheetId,
        anchor,
        focus: { row, col },
      },
    })
  }

  function selectCellFromEvent(row: number, col: number, event: MouseEvent) {
    const mergeRange = getMergeRangeForCoord(row, col)
    if (event.ctrlKey || event.metaKey) {
      if (event.shiftKey) {
        appendRangeSelection(row, col)
      } else if (mergeRange) {
        appendCellRangeSelection(mergeRange)
      } else {
        appendCellSelection(row, col)
      }
      bumpRender()
      focusGrid()
      return
    }

    if (!event.shiftKey && mergeRange) {
      selectCellRange(mergeRange)
      bumpRender()
      focusGrid()
      return
    }

    store.setter(selectCellAtom, {
      sheetId: props.sheetId,
      coord: { row, col },
      extend: event.shiftKey,
    })
    bumpRender()
    focusGrid()
  }

  function isActive(row: number, col: number) {
    const selection = selectionSnapshot()
    return (
      selection.selection.sheetId === props.sheetId &&
      selection.activeCell.row === row &&
      selection.activeCell.col === col
    )
  }

  function isEditing(row: number, col: number) {
    const editing = editingSession()
    return (
      editing.status === 'drafting' &&
      editing.source?.sheetId === props.sheetId &&
      editing.source.cell.row === row &&
      editing.source.cell.col === col
    )
  }

  function focusGrid() {
    gridRoot?.focus()
  }

  function openContextMenu(
    event: MouseEvent,
    target:
      | { kind: 'cell'; row: number; col: number }
      | { kind: 'range'; row: number; col: number; range: CellRange }
      | { kind: 'row'; row: number }
      | { kind: 'column'; col: number }
      | { kind: 'all' },
  ) {
    event.preventDefault()

    if (target.kind === 'cell') {
      store.setter(selectCellAtom, {
        sheetId: props.sheetId,
        coord: { row: target.row, col: target.col },
      })
    } else if (target.kind === 'row') {
      store.setter(selectRowsAtom, {
        sheetId: props.sheetId,
        rowAnchor: target.row,
        rowFocus: target.row,
      })
    } else if (target.kind === 'column') {
      store.setter(selectColumnsAtom, {
        sheetId: props.sheetId,
        colAnchor: target.col,
        colFocus: target.col,
      })
    } else {
      store.setter(selectAllAtom, props.sheetId)
    }

    store.setter(openMenuAtom, {
      surface: target.kind === 'cell' || target.kind === 'range' ? 'cell' : 'header',
      target:
        target.kind === 'cell'
          ? {
              kind: 'cell',
              sheetId: props.sheetId,
              cell: { row: target.row, col: target.col },
            }
          : target.kind === 'range'
            ? {
                kind: 'range',
                sheetId: props.sheetId,
                range: target.range,
              }
          : target.kind === 'row'
            ? {
                kind: 'row',
                sheetId: props.sheetId,
                rowIndex: target.row,
              }
            : target.kind === 'column'
              ? {
                  kind: 'column',
                  sheetId: props.sheetId,
                  colIndex: target.col,
                }
              : {
                  kind: 'all',
                  sheetId: props.sheetId,
                },
      position: {
        x: event.clientX,
        y: event.clientY,
      },
      source: 'pointer',
    })
    bumpRender()
    focusGrid()
  }

  function getCellContextTarget(
    row: number,
    col: number,
  ): { kind: 'cell'; row: number; col: number } | { kind: 'range'; row: number; col: number; range: CellRange } {
    const range = getSelectionRangeContaining(row, col)
    if (range) {
      return { kind: 'range', row, col, range }
    }

    return { kind: 'cell', row, col }
  }

  function getCellCoordFromPoint(event: PointerEvent): CellCoord | null {
    const element = document.elementFromPoint(event.clientX, event.clientY)
    const cell = element?.closest?.('td.spreadsheet-grid-cell') as HTMLElement | null
    if (!cell || !gridRoot?.contains(cell)) {
      return null
    }

    const row = Number(cell.dataset.row)
    const col = Number(cell.dataset.col)
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      return null
    }

    return { row, col }
  }

  function getFillPreviewRange(): CellRange | null {
    const session = store.getter(pointerSessionAtom)
    if (
      session.status !== 'active' ||
      session.interaction?.kind !== 'fill-handle' ||
      session.interaction.sheetId !== props.sheetId
    ) {
      return null
    }

    return session.interaction.previewRange
  }

  function isFillPreviewCell(row: number, col: number) {
    const previewRange = getFillPreviewRange()
    return previewRange ? isCoordInRange(row, col, previewRange) : false
  }

  async function fallbackFillHandle(intent: PointerFillHandleCommitIntent, writeRange: CellRange) {
    if (getRangeCellCount(writeRange) > MAX_UI_FILL_FALLBACK_CELLS) {
      return
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const sourceProjection = await backend.readRangeProjection({
      kind: 'range',
      sheetId: intent.sheetId,
      requestId,
      reason: 'fill-handle',
      range: intent.sourceRange,
    })
    const sourceCells = new Map<string, DisplayCell>()
    for (const cell of sourceProjection.cells) {
      sourceCells.set(makeCellKey(cell.row, cell.col), cell)
    }

    for (let row = writeRange.rowStart; row <= writeRange.rowEnd; row += 1) {
      for (let col = writeRange.colStart; col <= writeRange.colEnd; col += 1) {
        const sourceCoord = getFillHandleSourceCoord(intent.sourceRange, { row, col })
        const sourceCell = sourceCells.get(makeCellKey(sourceCoord.row, sourceCoord.col))
        await backend.setCellInput({
          kind: 'set-cell-input',
          sheetId: intent.sheetId,
          row,
          col,
          input: getCellInputForFill(sourceCell),
        })
      }
    }
  }

  async function executeFillHandle(intent: PointerFillHandleCommitIntent) {
    if (intent.direction === null) {
      return
    }

    const writeRange = getFillHandleWriteRange(
      intent.sourceRange,
      intent.targetRange,
      intent.direction,
    )
    if (writeRange === null) {
      return
    }

    if (backend.fillRange) {
      await backend.fillRange({
        kind: 'fill-range',
        sheetId: intent.sheetId,
        sourceRange: intent.sourceRange,
        targetRange: intent.targetRange,
        direction: intent.direction,
      })
    } else {
      await fallbackFillHandle(intent, writeRange)
    }

    await loadProjection(requestProjection())
  }

  function selectRow(row: number, extend: boolean, append: boolean) {
    if (append) {
      store.setter(addSelectionRegionAtom, {
        region: {
          kind: 'row',
          sheetId: props.sheetId,
          rowAnchor: row,
          rowFocus: row,
        },
      })
      bumpRender()
      focusGrid()
      return
    }

    const selection = selectionSnapshot().selection
    const rowAnchor =
      extend && selection.sheetId === props.sheetId && selection.kind === 'row'
        ? selection.rowAnchor
        : row

    store.setter(selectRowsAtom, {
      sheetId: props.sheetId,
      rowAnchor,
      rowFocus: row,
    })
    bumpRender()
    focusGrid()
  }

  function selectColumn(col: number, extend: boolean, append: boolean) {
    if (append) {
      store.setter(addSelectionRegionAtom, {
        region: {
          kind: 'column',
          sheetId: props.sheetId,
          colAnchor: col,
          colFocus: col,
        },
      })
      bumpRender()
      focusGrid()
      return
    }

    const selection = selectionSnapshot().selection
    const colAnchor =
      extend && selection.sheetId === props.sheetId && selection.kind === 'column'
        ? selection.colAnchor
        : col

    store.setter(selectColumnsAtom, {
      sheetId: props.sheetId,
      colAnchor,
      colFocus: col,
    })
    bumpRender()
    focusGrid()
  }

  function startEditingCell(row: number, col: number, source: 'keyboard' | 'cell') {
    const cell = getCell(row, col)
    store.setter(startEditingAtom, {
      sheetId: props.sheetId,
      cell: { row, col },
      draft: cell?.formula ?? cell?.displayValue ?? '',
      source,
    })
    bumpRender()
  }

  function getDataEdgeDirection(key: string): 'up' | 'down' | 'left' | 'right' | null {
    switch (key) {
      case 'ArrowUp':
        return 'up'
      case 'ArrowDown':
        return 'down'
      case 'ArrowLeft':
        return 'left'
      case 'ArrowRight':
        return 'right'
      default:
        return null
    }
  }

  async function moveSelectionToDataEdge(
    event: KeyboardEvent,
    direction: 'up' | 'down' | 'left' | 'right',
  ): Promise<boolean> {
    const snapshot = selectionSnapshot()
    if (snapshot.selection.sheetId !== props.sheetId) {
      return false
    }

    event.preventDefault()
    const result = await backend.resolveDataEdge!({
      kind: 'resolve-data-edge',
      sheetId: props.sheetId,
      from: {
        row: snapshot.activeCell.row,
        col: snapshot.activeCell.col,
      },
      direction,
      bounds: {
        rowCount: props.viewport.rowCount,
        colCount: props.viewport.colCount,
      },
    })

    store.setter(selectCellAtom, {
      sheetId: props.sheetId,
      coord: result.target,
      extend: event.shiftKey,
    })
    bumpRender()
    return true
  }

  async function handleGridKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) {
      return
    }

    if (event.key === 'Escape' && selectionRegions().length > 1) {
      event.preventDefault()
      store.setter(clearNonPrimaryRegionsAtom, { keepPrimary: true })
      bumpRender()
      return
    }

    const dataEdgeDirection = getDataEdgeDirection(event.key)
    if (
      dataEdgeDirection &&
      !event.altKey &&
      (event.ctrlKey || event.metaKey) &&
      backend.resolveDataEdge
    ) {
      if (await moveSelectionToDataEdge(event, dataEdgeDirection)) {
        return
      }
    }

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.isComposing,
      pageRowDelta: Math.max(1, getRows().length),
      pageColDelta: Math.max(1, getCols().length),
    })

    switch (intent.type) {
      case 'selection.move':
      case 'selection.selectAll':
        event.preventDefault()
        bumpRender()
        return
      case 'editing.start': {
        event.preventDefault()
        const active = selectionSnapshot().activeCell
        startEditingCell(active.row, active.col, 'keyboard')
        return
      }
      case 'cell.clear':
        event.preventDefault()
        await clearActiveCell()
        return
      case 'sheet.activate-adjacent': {
        event.preventDefault()
        const nextSheetId = getAdjacentSheetId(
          store.getter(sheetTabsSheetsAtom),
          store.getter(workspaceSessionAtom).activeSheetId,
          intent.direction,
        )
        if (nextSheetId) {
          store.setter(setWorkspaceActiveSheetAtom, { sheetId: nextSheetId })
        }
        return
      }
      default:
        return
    }
  }

  function getCell(row: number, col: number) {
    return getCellMap().get(makeCellKey(row, col))
  }

  function getMergeRangeForCell(cell: DisplayCell | undefined): CellRange | null {
    if (!cell?.mergedSpan) {
      return null
    }

    const rows = Math.max(1, Math.trunc(cell.mergedSpan.rows))
    const cols = Math.max(1, Math.trunc(cell.mergedSpan.cols))
    return {
      rowStart: cell.row,
      rowEnd: cell.row + rows - 1,
      colStart: cell.col,
      colEnd: cell.col + cols - 1,
    }
  }

  function getMergeRangeForCoord(row: number, col: number): CellRange | null {
    const cell = getCell(row, col)
    const directRange = getMergeRangeForCell(cell)
    if (directRange) return directRange

    if (cell?.mergeAnchor) {
      const anchorCell = getCell(cell.mergeAnchor.row, cell.mergeAnchor.col)
      return getMergeRangeForCell(anchorCell)
    }

    for (const candidate of projectionSnapshot().result?.cells ?? []) {
      const range = getMergeRangeForCell(candidate)
      if (!range) continue
      if (isCoordInRange(row, col, range)) {
        return range
      }
    }

    return null
  }

  function isCellCoveredByMerge(row: number, col: number) {
    const cell = getCell(row, col)
    if (cell && isMergeCovered(cell)) return true

    const range = getMergeRangeForCoord(row, col)
    return range !== null && (range.rowStart !== row || range.colStart !== col)
  }

  function isCellMergeAnchor(row: number, col: number) {
    const range = getMergeRangeForCoord(row, col)
    return range !== null && range.rowStart === row && range.colStart === col
  }

  function getRenderedRowHeight(row: number) {
    return getViewportRowHeight(sizeOverrides(), props.sheetId, row, props.viewport.rowHeight)
  }

  function getRenderedColumnWidth(col: number) {
    return getViewportColumnWidth(sizeOverrides(), props.sheetId, col, props.viewport.colWidth)
  }

  function getColumnStyle(col: number): Record<string, string> {
    return {
      width: `${getRenderedColumnWidth(col)}px`,
    }
  }

  function getCellBoxStyle(row: number, col: number): Record<string, string> {
    const mergeRange = getMergeRangeForCoord(row, col)
    if (mergeRange && mergeRange.rowStart === row && mergeRange.colStart === col) {
      const rows = getRows().filter((index) => index >= row && index <= mergeRange.rowEnd)
      const cols = getCols().filter((index) => index >= col && index <= mergeRange.colEnd)
      const height = rows.reduce(
        (sum, index) => sum + getRenderedRowHeight(index),
        0,
      )
      const width = cols.reduce(
        (sum, index) => sum + getRenderedColumnWidth(index),
        0,
      )
      return {
        height: `${Math.max(getRenderedRowHeight(row), height)}px`,
        width: `${Math.max(getRenderedColumnWidth(col), width)}px`,
      }
    }

    return {
      height: `${getRenderedRowHeight(row)}px`,
      width: `${getRenderedColumnWidth(col)}px`,
    }
  }

  function getCellRowSpan(row: number, col: number) {
    const mergeRange = getMergeRangeForCoord(row, col)
    if (!mergeRange || mergeRange.rowStart !== row || mergeRange.colStart !== col) {
      return 1
    }

    return Math.max(1, getRows().filter((index) => index >= row && index <= mergeRange.rowEnd).length)
  }

  function getCellColSpan(row: number, col: number) {
    const mergeRange = getMergeRangeForCoord(row, col)
    if (!mergeRange || mergeRange.rowStart !== row || mergeRange.colStart !== col) {
      return 1
    }

    return Math.max(1, getCols().filter((index) => index >= col && index <= mergeRange.colEnd).length)
  }

  function getRowHeaderStyle(row: number): Record<string, string> {
    return {
      height: `${getRenderedRowHeight(row)}px`,
    }
  }

  function startFillHandle(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    activeFillCleanup?.()
    activeResizeCleanup?.()

    const selection = selectionSnapshot()
    if (selection.selection.sheetId !== props.sheetId) {
      return
    }

    const sourceRange = selection.range
    const preview = createFillHandlePreview(sourceRange, selection.activeCell)
    store.setter(startPointerAtom, {
      kind: 'fill-handle',
      sheetId: props.sheetId,
      sourceRange,
      focus: selection.activeCell,
      previewRange: preview.previewRange,
      direction: preview.direction,
      source: 'pointer',
    })

    const onPointerMove = (moveEvent: PointerEvent) => {
      const focus = getCellCoordFromPoint(moveEvent)
      if (!focus) {
        return
      }

      const nextPreview = createFillHandlePreview(sourceRange, focus)
      store.setter(updatePointerAtom, {
        kind: 'fill-handle',
        focus,
        previewRange: nextPreview.previewRange,
        direction: nextPreview.direction,
      })
      bumpRender()
    }

    const onPointerUp = () => {
      const intent = store.setter(commitPointerAtom)
      cleanupFill()
      if (intent?.type === 'pointer.fill-handle.commit') {
        void executeFillHandle(intent)
      }
      bumpRender()
    }

    const cleanupFill = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      store.setter(cancelPointerAtom)
      activeFillCleanup = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    activeFillCleanup = cleanupFill
    bumpRender()
  }

  function startColumnResize(event: PointerEvent, col: number) {
    event.preventDefault()
    event.stopPropagation()
    activeResizeCleanup?.()
    activeFillCleanup?.()

    const startClientX = event.clientX
    const startSize = getRenderedColumnWidth(col)
    let previewSize = startSize
    store.setter(startPointerAtom, {
      kind: 'column-resize',
      sheetId: props.sheetId,
      colIndex: col,
      startSizePx: startSize,
      previewSizePx: startSize,
      source: 'pointer',
    })

    const onPointerMove = (moveEvent: PointerEvent) => {
      previewSize = startSize + moveEvent.clientX - startClientX
      store.setter(updatePointerAtom, {
        kind: 'column-resize',
        previewSizePx: previewSize,
      })
      store.setter(setViewportColumnWidthAtom, {
        sheetId: props.sheetId,
        colIndex: col,
        widthPx: previewSize,
      })
      bumpRender()
    }

    const onPointerUp = () => {
      const intent = store.setter(commitPointerAtom)
      if (intent?.type === 'pointer.column-resize.commit') {
        store.setter(setViewportColumnWidthAtom, {
          sheetId: props.sheetId,
          colIndex: intent.colIndex,
          widthPx: intent.previewSizePx,
        })
        void persistColumnWidth(intent.colIndex, intent.previewSizePx).catch(() => undefined)
      }
      cleanupResize()
      bumpRender()
    }

    const cleanupResize = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      store.setter(cancelPointerAtom)
      activeResizeCleanup = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    activeResizeCleanup = cleanupResize
    bumpRender()
  }

  function startRowResize(event: PointerEvent, row: number) {
    event.preventDefault()
    event.stopPropagation()
    activeResizeCleanup?.()
    activeFillCleanup?.()

    const startClientY = event.clientY
    const startSize = getRenderedRowHeight(row)
    let previewSize = startSize
    store.setter(startPointerAtom, {
      kind: 'row-resize',
      sheetId: props.sheetId,
      rowIndex: row,
      startSizePx: startSize,
      previewSizePx: startSize,
      source: 'pointer',
    })

    const onPointerMove = (moveEvent: PointerEvent) => {
      previewSize = startSize + moveEvent.clientY - startClientY
      store.setter(updatePointerAtom, {
        kind: 'row-resize',
        previewSizePx: previewSize,
      })
      store.setter(setViewportRowHeightAtom, {
        sheetId: props.sheetId,
        rowIndex: row,
        heightPx: previewSize,
      })
      bumpRender()
    }

    const onPointerUp = () => {
      const intent = store.setter(commitPointerAtom)
      if (intent?.type === 'pointer.row-resize.commit') {
        store.setter(setViewportRowHeightAtom, {
          sheetId: props.sheetId,
          rowIndex: intent.rowIndex,
          heightPx: intent.previewSizePx,
        })
        void persistRowHeight(intent.rowIndex, intent.previewSizePx).catch(() => undefined)
      }
      cleanupResize()
      bumpRender()
    }

    const cleanupResize = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      store.setter(cancelPointerAtom)
      activeResizeCleanup = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    activeResizeCleanup = cleanupResize
    bumpRender()
  }

  return (
    <div
      ref={gridRoot}
      class={`spreadsheet-grid ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'spreadsheet-grid'}
      tabIndex={0}
      onKeyDown={(event) => {
        void handleGridKeyDown(event)
      }}
    >
      <table class="spreadsheet-grid-table">
        <tbody>
          <Show when={getRows().length > 0 && getCols().length > 0}>
            <tr>
              <th
                class="spreadsheet-grid-corner"
                data-selected={isAllSelected() ? 'true' : 'false'}
                onClick={() => {
                  store.setter(selectAllAtom, props.sheetId)
                  bumpRender()
                  focusGrid()
                }}
                onContextMenu={(event) => {
                  openContextMenu(event, { kind: 'all' })
                }}
              />
              <For each={getCols()}>
                {(col) => {
                  const selected = () => isColumnSelected(col)

                  return (
                    <th
                      class={`spreadsheet-grid-col-header ${selected() ? 'is-selected' : ''}`.trim()}
                      data-col={col}
                      data-selected={selected() ? 'true' : 'false'}
                      style={getColumnStyle(col)}
                      onClick={(event) => {
                        selectColumn(col, event.shiftKey, event.ctrlKey || event.metaKey)
                      }}
                      onContextMenu={(event) => {
                        openContextMenu(event, { kind: 'column', col })
                      }}
                    >
                      <span class="spreadsheet-grid-header-label">{getColumnLabel(col)}</span>
                      <button
                        type="button"
                        class="spreadsheet-grid-col-resize-handle"
                        data-testid={`col-resize-${col}`}
                        aria-label={`Resize column ${getColumnLabel(col)}`}
                        onPointerDown={(event) => startColumnResize(event, col)}
                        onDblClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void autoFitColumn(col)
                        }}
                      />
                    </th>
                  )
                }}
              </For>
            </tr>
            <For each={getRows()}>
              {(row) => (
                <tr class="spreadsheet-grid-row">
                  <th
                    class={`spreadsheet-grid-row-header ${
                      isRowSelected(row) ? 'is-selected' : ''
                    }`.trim()}
                    data-row={row}
                    data-selected={isRowSelected(row) ? 'true' : 'false'}
                    style={getRowHeaderStyle(row)}
                    onClick={(event) => {
                      selectRow(row, event.shiftKey, event.ctrlKey || event.metaKey)
                    }}
                    onContextMenu={(event) => {
                      openContextMenu(event, { kind: 'row', row })
                    }}
                  >
                    <span class="spreadsheet-grid-header-label">{row + 1}</span>
                    <button
                      type="button"
                      class="spreadsheet-grid-row-resize-handle"
                      data-testid={`row-resize-${row}`}
                      aria-label={`Resize row ${row + 1}`}
                      onPointerDown={(event) => startRowResize(event, row)}
                      onDblClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void autoFitRow(row)
                      }}
                    />
                  </th>
                  <For each={getCols()}>
                    {(col) => {
                      const addr = getCellAddress(row, col)
                      const cell = () => getCell(row, col)
                      const selected = () => isSelected(row, col)
                      const active = () => isActive(row, col)
                      const editing = () => isEditing(row, col)
                      const mergeAnchor = () => isCellMergeAnchor(row, col)
                      const validationSeverity = () => getCellValidationSeverity(cell())
                      return (
                        <Show when={!isCellCoveredByMerge(row, col)}>
                          <td
                            class={`spreadsheet-grid-cell cell ${
                              selected() ? 'is-selected cell-in-range' : ''
                            } ${
                              active() ? 'cell-active' : ''
                            } ${
                              isFillPreviewCell(row, col) ? 'cell-fill-preview' : ''
                            } ${
                              mergeAnchor() ? 'cell-merge-anchor' : ''
                            } ${
                              validationSeverity()
                                ? `cell-validation-${validationSeverity()}`
                                : ''
                            } ${cell()?.valueKind ? `kind-${cell()?.valueKind}` : ''}`.trim()}
                            data-row={row}
                            data-col={col}
                            data-cell-addr={addr}
                            data-selected={selected() ? 'true' : 'false'}
                            data-active={active() ? 'true' : 'false'}
                            data-merge-anchor={mergeAnchor() ? 'true' : 'false'}
                            data-validation-code={cell()?.validation?.code}
                            data-validation-severity={validationSeverity()}
                            data-has-conditional-format={
                              cell()?.conditionalFormat ? 'true' : 'false'
                            }
                            aria-selected={selected() ? 'true' : 'false'}
                            title={getCellValidationMessage(cell())}
                            rowSpan={getCellRowSpan(row, col)}
                            colSpan={getCellColSpan(row, col)}
                            style={getCellBoxStyle(row, col)}
                            onClick={(event) => {
                              selectCellFromEvent(row, col, event)
                            }}
                            onMouseDown={(event) => {
                              if (!event.shiftKey || event.ctrlKey || event.metaKey) {
                                return
                              }

                              event.preventDefault()
                              store.setter(selectCellAtom, {
                                sheetId: props.sheetId,
                                coord: { row, col },
                                extend: true,
                              })
                              bumpRender()
                              focusGrid()
                            }}
                            onDblClick={() => {
                              startEditingCell(row, col, 'cell')
                            }}
                            onContextMenu={(event) => {
                              openContextMenu(event, getCellContextTarget(row, col))
                            }}
                          >
                            <Show
                              when={editing()}
                              fallback={
                                <button type="button" class="spreadsheet-grid-cell-button">
                                  <span
                                    class="cell-display"
                                    style={getCellFormatStyle(getDisplayCellFormat(cell()))}
                                  >
                                    {cell()?.displayValue ?? ''}
                                  </span>
                                </button>
                              }
                            >
                              <input
                                class="cell-input"
                                value={editingDraft()}
                                autofocus
                                onInput={(event) => {
                                  store.setter(editingDraftAtom, {
                                    draft: event.currentTarget.value,
                                  })
                                  bumpRender()
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void commitCellEdit()
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    store.setter(cancelEditingAtom)
                                    bumpRender()
                                  }
                                }}
                                onBlur={() => {
                                  if (store.getter(editingSessionAtom).status === 'drafting') {
                                    void commitCellEdit()
                                  }
                                }}
                              />
                            </Show>
                            <Show when={active() && !editing()}>
                              <button
                                type="button"
                                class="spreadsheet-grid-fill-handle"
                                data-testid={`fill-handle-${addr}`}
                                aria-label={`Fill from ${addr}`}
                                onPointerDown={startFillHandle}
                              />
                            </Show>
                          </td>
                        </Show>
                      )
                    }}
                  </For>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  )
}
