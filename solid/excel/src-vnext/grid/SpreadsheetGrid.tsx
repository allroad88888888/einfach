import {
  CLIPBOARD_ORIGIN_MARKER_PREFIX,
  cancelPointerAtom,
  commitPointerAtom,
  commitEditingAtom,
  copyClipboardAtom,
  createClipboardTsvPastePlan,
  cutClipboardAtom,
  createFillHandlePreview,
  createVisibleProjectionRequest,
  dispatchKeyboardInputAtom,
  editingDraftAtom,
  editingSessionAtom,
  formulaReferenceSessionAtom,
  pickFormulaReferenceAtom,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  getAdjacentSheetId,
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  getRichValueText,
  getViewportColumnWidth,
  getViewportRowHeight,
  getSelectionRange,
  addSelectionRegionAtom,
  isMergeCovered,
  markClipboardReadyAtom,
  nextHistoryTransactionId,
  openMenuAtom,
  pasteClipboardAtom,
  pointerSessionAtom,
  pushHistoryAtom,
  scrollToCellAtom,
  serializeClipboardTsv,
  setClipboardErrorAtom,
  MAX_VIEWPORT_COL_WIDTH,
  MAX_VIEWPORT_ROW_HEIGHT,
  MIN_VIEWPORT_COL_WIDTH,
  MIN_VIEWPORT_ROW_HEIGHT,
  selectionAtom,
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
  activeCellLockedAtom,
  findReplaceOpenAtom,
  filterSortStateAtom,
  openFilterDropdownAtom,
  notifyActiveSheetChangedAtom,
  remoteCursorsAtom,
  presenceStateAtom,
  type CellCoord,
  type CellRange,
  type ClipboardTransferInput,
  type DisplayCell,
  type DisplayCellRichValue,
  type FormatToggleField,
  type PointerFillHandleCommitIntent,
  type RichTextRunFormat,
  type SelectionRegion,
  type SelectionState,
  type SpreadsheetCellFormat,
  type ViewportMetrics,
  viewportHiddenAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  viewportSizeOverridesAtom,
  visibleWindowAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  advanceSpreadsheetProjectionRequestIdAtom,
  dispatchEditingCancel,
  dispatchRedo,
  dispatchUndo,
  spreadsheetProjectionSnapshotAtom,
  syncFormulaReferenceCaret,
} from '../provider'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'
import { SpreadsheetGridOverlay } from './SpreadsheetGridOverlay'

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
  const decorations: string[] = []
  if (format.underline) decorations.push('underline')
  if (format.strikethrough) decorations.push('line-through')
  if (decorations.length > 0) style['text-decoration'] = decorations.join(' ')
  if (format.align && format.align !== 'default') {
    if (format.align === 'distributed') {
      style['text-align'] = 'justify'
      style['text-align-last'] = 'justify'
    } else if (format.align === 'fill') {
      // Fill repeats the rendered text; without a measure pass we still left-align
      // the existing string. Adapters that implement the repetition layer in a
      // canvas overlay can read `align === 'fill'` directly from the format.
      style['text-align'] = 'left'
    } else {
      style['text-align'] = format.align
    }
  }
  if (format.fontSize) style['font-size'] = `${format.fontSize}px`

  if (format.verticalAlign) {
    // Used by the cell box (display: flex) — leave a hint on the inner span so
    // adapters that wrap the cell-display in their own flex container can map it.
    style['--cell-vertical-align'] = format.verticalAlign
  }

  // Rotation. Numeric values rotate around the centre; `'vertical'` uses
  // CSS writing-mode for character-stacked text.
  if (format.rotation !== undefined && format.rotation !== 0) {
    if (format.rotation === 'vertical') {
      style['writing-mode'] = 'vertical-rl'
      style['text-orientation'] = 'mixed'
    } else if (typeof format.rotation === 'number') {
      style['transform'] = `rotate(${format.rotation}deg)`
      style['transform-origin'] = 'center center'
      style['display'] = 'inline-block'
    }
  }

  // Overflow handling. Legacy `format.wrap` maps to wrap; the new `overflow`
  // field is preferred when both are present.
  const overflow = format.overflow ?? (format.wrap ? 'wrap' : undefined)
  if (overflow === 'wrap') {
    style['white-space'] = 'normal'
    style['word-break'] = 'break-word'
    style['overflow-wrap'] = 'anywhere'
  } else if (overflow === 'clip' || overflow === 'ellipsis') {
    style['white-space'] = 'nowrap'
    style['overflow'] = 'hidden'
    style['text-overflow'] = 'ellipsis'
  } else if (overflow === 'shrink-to-fit' || format.shrinkToFit) {
    style['white-space'] = 'nowrap'
    style['overflow'] = 'hidden'
    // Best-effort: a CSS-only shrink cannot measure font metrics, so we mark
    // the cell. A future measurement pass (or the canvas overlay) reads
    // `--cell-shrink-to-fit` and sets `transform: scale(...)` from there.
    style['--cell-shrink-to-fit'] = '1'
  } else if (overflow === 'overflow') {
    // Excel default for text: spill into empty neighbours. Without a layout
    // measurement pass the DOM renderer leaves text intact and lets the
    // neighbouring `<td>` clip it — same visible result for blank neighbours.
    style['white-space'] = 'nowrap'
    style['overflow'] = 'visible'
  }

  if (format.indent && format.indent > 0) {
    // Indent is in level units; renderers translate to pixels. 8px per level
    // matches Excel's default. Direction-aware adapters can swap to padding-right.
    style['padding-left'] = `${format.indent * 8}px`
  }

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

function getCellRichUrl(cell: DisplayCell | undefined): string | undefined {
  return cell?.richValue?.kind === 'hyperlink' ? cell.richValue.url : undefined
}

function getRichRunStyle(format: RichTextRunFormat | undefined): Record<string, string> {
  if (!format) return {}

  const style: Record<string, string> = {}
  const textDecoration: string[] = []
  if (format.bold) style['font-weight'] = '700'
  if (format.italic) style['font-style'] = 'italic'
  if (format.underline) textDecoration.push('underline')
  if (format.strikethrough) textDecoration.push('line-through')
  if (textDecoration.length > 0) style['text-decoration'] = textDecoration.join(' ')
  if (format.color) style['color'] = format.color
  return style
}

function SpreadsheetCellDisplayValue(props: { cell: DisplayCell | undefined }) {
  const richValue = () => props.cell?.richValue

  return (
    <Show when={richValue()} fallback={props.cell?.displayValue ?? ''}>
      {(value) => {
        const rich = value() as DisplayCellRichValue

        if (rich.kind === 'hyperlink') {
          return (
            <span class="cell-rich-link" data-rich-url={rich.url}>
              {rich.label}
            </span>
          )
        }

        if (rich.kind === 'rich-text') {
          return (
            <span class="cell-rich-text">
              <For each={rich.runs}>
                {(run) => <span style={getRichRunStyle(run.format)}>{run.text}</span>}
              </For>
            </span>
          )
        }

        return getRichValueText(rich)
      }}
    </Show>
  )
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
const CLIPBOARD_CELL_LIMIT = 10_000

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
  let unsubscribePresence: (() => void) | null = null
  let unsubscribeFilterSort: (() => void) | null = null
  let unsubscribeWorkspace: (() => void) | null = null
  let unsubscribeShowGridlines: (() => void) | null = null
  let unsubscribeShowHeadings: (() => void) | null = null
  let unsubscribeSelection: (() => void) | null = null
  let unsubscribeEditing: (() => void) | null = null
  let lastActiveSheetId: string | null = null

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

  function showGridlines() {
    renderTick()
    return store.getter(viewportShowGridlinesAtom)
  }

  function showHeadings() {
    renderTick()
    return store.getter(viewportShowHeadingsAtom)
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
    unsubscribePresence = store.sub(presenceStateAtom, bumpRender)
    unsubscribeFilterSort = store.sub(filterSortStateAtom, bumpRender)
    unsubscribeShowGridlines = store.sub(viewportShowGridlinesAtom, bumpRender)
    unsubscribeShowHeadings = store.sub(viewportShowHeadingsAtom, bumpRender)
    unsubscribeSelection = store.sub(selectionAtom, bumpRender)
    unsubscribeEditing = store.sub(editingSessionAtom, bumpRender)

    lastActiveSheetId = store.getter(workspaceSessionAtom).activeSheetId
    unsubscribeWorkspace = store.sub(workspaceSessionAtom, () => {
      const nextSheetId = store.getter(workspaceSessionAtom).activeSheetId
      if (nextSheetId !== lastActiveSheetId) {
        lastActiveSheetId = nextSheetId
        store.setter(notifyActiveSheetChangedAtom, nextSheetId)
      }
    })

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
    unsubscribePresence?.()
    unsubscribeFilterSort?.()
    unsubscribeWorkspace?.()
    unsubscribeShowGridlines?.()
    unsubscribeShowHeadings?.()
    unsubscribeSelection?.()
    unsubscribeEditing?.()
    activeDragSelectCleanup?.()
    activeResizeCleanup?.()
    activeFillCleanup?.()
    store.setter(cancelPointerAtom)
  })

  async function commitCellEdit(
    move: 'none' | 'down' | 'up' | 'left' | 'right' = 'none',
  ) {
    const intent = store.setter(commitEditingAtom, {
      input: store.getter(editingDraftAtom),
      source: 'cell',
      move,
    })

    if (!intent) {
      return
    }

    const result = await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: intent.sheetId,
      row: intent.cell.row,
      col: intent.cell.col,
      input: intent.input,
    })
    const cellRevision =
      typeof result?.revision === 'number'
        ? result.revision
        : Number(result?.revision ?? 0) || 0
    store.setter(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId(),
      kind: 'cell.set-input',
      sheetId: intent.sheetId,
      projectionRevision: cellRevision,
      affectedRange: result?.affectedRange ?? {
        rowStart: intent.cell.row,
        rowEnd: intent.cell.row,
        colStart: intent.cell.col,
        colEnd: intent.cell.col,
      },
    })
    await loadProjection(requestProjection())

    if (move !== 'none') {
      const bounds = getSelectionBounds()
      const next = { row: intent.cell.row, col: intent.cell.col }
      if (move === 'down') next.row = Math.min(bounds.rowCount - 1, next.row + 1)
      else if (move === 'up') next.row = Math.max(0, next.row - 1)
      else if (move === 'right') next.col = Math.min(bounds.colCount - 1, next.col + 1)
      else if (move === 'left') next.col = Math.max(0, next.col - 1)
      store.setter(selectCellAtom, {
        sheetId: intent.sheetId,
        coord: next,
        extend: false,
      })
      bumpRender()
      focusGrid()
    }
  }

  async function clearSelectionRange(target: 'values' | 'formats' | 'all' = 'all') {
    const regions = selectionRegions().filter((r) => r.sheetId === props.sheetId)
    if (regions.length === 0) {
      return
    }

    const bounds = getSelectionBounds()
    const ranges = regions.map((r) => getSelectionRange(r, bounds))

    if (regions.length === 1 && target === 'values') {
      const range = ranges[0]
      const isSingleCell = range.rowStart === range.rowEnd && range.colStart === range.colEnd
      if (isSingleCell) {
        const result = await backend.setCellInput({
          kind: 'set-cell-input',
          sheetId: props.sheetId,
          row: range.rowStart,
          col: range.colStart,
          input: '',
        })
        const rev =
          typeof result?.revision === 'number'
            ? result.revision
            : Number(result?.revision ?? 0) || 0
        store.setter(pushHistoryAtom, {
          transactionId: nextHistoryTransactionId(),
          kind: 'cell.set-input',
          sheetId: props.sheetId,
          projectionRevision: rev,
          affectedRange: result?.affectedRange ?? range,
        })
        await loadProjection(requestProjection())
        return
      }
    }

    if (!backend.clearRange) {
      return
    }

    const clearResults = await Promise.all(
      ranges.map((range) =>
        backend.clearRange!({
          kind: 'clear-range',
          sheetId: props.sheetId,
          range,
          target,
        }),
      ),
    )
    const lastRev = clearResults
      .map((r) => (typeof r?.revision === 'number' ? r.revision : Number(r?.revision ?? 0) || 0))
      .reduce((a, b) => Math.max(a, b), 0)
    store.setter(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId(),
      kind: 'range.clear',
      sheetId: props.sheetId,
      projectionRevision: lastRev,
      affectedRange: ranges[0],
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

  let activeDragSelectCleanup: (() => void) | null = null

  function startDragSelection(event: PointerEvent, row: number, col: number) {
    if (event.button !== 0) return
    if (event.shiftKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    activeDragSelectCleanup?.()
    activeFillCleanup?.()
    activeResizeCleanup?.()

    const anchor: CellCoord = { row, col }
    store.setter(selectCellAtom, {
      sheetId: props.sheetId,
      coord: anchor,
      extend: false,
    })
    store.setter(startPointerAtom, {
      kind: 'drag-selection',
      sheetId: props.sheetId,
      anchor,
      focus: anchor,
      source: 'pointer',
    })
    bumpRender()
    focusGrid()

    let lastFocus = anchor

    const onPointerMove = (moveEvent: PointerEvent) => {
      const focus = getCellCoordFromPoint(moveEvent)
      if (!focus) return
      if (focus.row === lastFocus.row && focus.col === lastFocus.col) return
      lastFocus = focus
      store.setter(selectCellAtom, {
        sheetId: props.sheetId,
        coord: focus,
        extend: true,
      })
      store.setter(updatePointerAtom, { kind: 'drag-selection', focus })
      bumpRender()
    }

    const onPointerUp = () => {
      store.setter(commitPointerAtom)
      cleanup()
      bumpRender()
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      activeDragSelectCleanup = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    activeDragSelectCleanup = cleanup
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
    } else if (target.kind === 'all') {
      store.setter(selectAllAtom, props.sheetId)
    }
    // target.kind === 'range': keep current range selection as-is

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

  function startEditingCell(
    row: number,
    col: number,
    source: 'keyboard' | 'cell',
    options?: { initialDraft?: string; clearOnStart?: boolean },
  ) {
    if (store.getter(activeCellLockedAtom)) {
      return
    }
    const cell = getCell(row, col)
    const existingDraft = cell?.formula ?? cell?.displayValue ?? ''
    const draft =
      options?.clearOnStart === true
        ? options.initialDraft ?? ''
        : options?.initialDraft !== undefined
          ? `${existingDraft}${options.initialDraft}`
          : existingDraft
    store.setter(startEditingAtom, {
      sheetId: props.sheetId,
      cell: { row, col },
      draft,
      source,
    })
    // Trigger formula-reference auto-enter when the initial draft (e.g. from
    // typing '=' in navigation mode) already qualifies.
    syncFormulaReferenceCaret(store, draft.length)
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

  async function copySelectionToClipboard(operation: 'copy' | 'cut' = 'copy') {
    const selection = selectionSnapshot()
    if (selection.selection.sheetId !== props.sheetId) {
      return
    }

    const range = selection.range
    const cellCount =
      (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
    const originAddr = `${getColumnLabel(range.colStart)}${range.rowStart + 1}`

    let text: string
    let transferInput: ClipboardTransferInput

    if (cellCount > CLIPBOARD_CELL_LIMIT) {
      const streamRequest = {
        kind: 'export-range-tsv' as const,
        sheetId: props.sheetId,
        range,
        requestId: store.setter(advanceSpreadsheetProjectionRequestIdAtom),
      }
      const chunks: string[] = []
      let streamResult:
        | Awaited<ReturnType<NonNullable<typeof backend.consumeExportRangeTsvChunks>>>
        | Awaited<ReturnType<NonNullable<typeof backend.exportRangeTsv>>>
        | null = null
      if (backend.consumeExportRangeTsvChunks) {
        streamResult = await backend.consumeExportRangeTsvChunks(streamRequest, (chunk) => {
          chunks.push(chunk.text)
        })
      } else if (backend.exportRangeTsv) {
        streamResult = await backend.exportRangeTsv(streamRequest)
        chunks.push(streamResult.text)
      } else {
        store.setter(setClipboardErrorAtom, {
          code: 'BACKEND_ERROR',
          message: `Clipboard range is too large: ${cellCount} cells. Backend streaming export unavailable.`,
        })
        return
      }
      const resolvedOrigin = streamResult?.originAddr ?? originAddr
      text = `${CLIPBOARD_ORIGIN_MARKER_PREFIX}${resolvedOrigin}\n${chunks.join('\n')}`
      const plan = createClipboardTsvPastePlan({
        text,
        fallbackOriginAddr: resolvedOrigin,
        targetOrigin: { row: range.rowStart, col: range.colStart },
      })
      transferInput = {
        source: { sheetId: props.sheetId, range },
        serialization: 'tab-separated',
        includesFormulas: plan.includesFormulas,
        includesErrors: false,
        estimatedBytes: streamResult?.estimatedBytes ?? text.length,
        revision: streamResult?.revision ?? undefined,
      }
    } else {
      const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
      const result = await backend.readRangeProjection({
        kind: 'range',
        sheetId: props.sheetId,
        requestId,
        reason: 'clipboard',
        range,
      })

      const cells: string[][] = []
      const cellsByKey = new Map<string, (typeof result.cells)[number]>()
      for (const cell of result.cells) {
        cellsByKey.set(`${cell.row}:${cell.col}`, cell)
      }
      for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
        const fields: string[] = []
        for (let col = range.colStart; col <= range.colEnd; col += 1) {
          const cell = cellsByKey.get(`${row}:${col}`)
          fields.push(cell?.formula ?? cell?.displayValue ?? '')
        }
        cells.push(fields)
      }

      text = serializeClipboardTsv({
        originAddr,
        cells,
      })

      transferInput = {
        source: { sheetId: props.sheetId, range },
        serialization: 'tab-separated',
        includesFormulas: cells.some((row) => row.some((f) => f.startsWith('='))),
        includesErrors: result.cells.some((c) => c.valueKind === 'error' || !!c.error),
        estimatedBytes: text.length,
        revision: result.revision ?? undefined,
      }
    }

    store.setter(operation === 'cut' ? cutClipboardAtom : copyClipboardAtom, transferInput)

    if (!(await writeClipboardText(text))) {
      store.setter(setClipboardErrorAtom, { code: 'BACKEND_ERROR', message: 'Clipboard write failed.' })
      return
    }
    store.setter(markClipboardReadyAtom)

    if (operation === 'cut') {
      await clearSelectionRange()
    }
  }

  async function pasteFromClipboard() {
    const selection = selectionSnapshot()
    if (selection.selection.sheetId !== props.sheetId) {
      return
    }

    const text = await readClipboardText()
    if (text === null || text.length === 0) {
      store.setter(setClipboardErrorAtom, { code: 'BACKEND_ERROR', message: 'Clipboard read failed.' })
      return
    }

    const targetOrigin = { row: selection.activeCell.row, col: selection.activeCell.col }
    const plan = createClipboardTsvPastePlan({
      text,
      fallbackOriginAddr: `${getColumnLabel(targetOrigin.col)}${targetOrigin.row + 1}`,
      targetOrigin,
    })
    const pasteRange = plan.estimatedRange
    const sourceRange = {
      rowStart: plan.sourceOrigin.row,
      rowEnd: plan.sourceOrigin.row + plan.rowCount - 1,
      colStart: plan.sourceOrigin.col,
      colEnd: plan.sourceOrigin.col + plan.colCount - 1,
    }

    store.setter(pasteClipboardAtom, {
      source: { sheetId: props.sheetId, range: sourceRange },
      target: { sheetId: props.sheetId, range: pasteRange },
      serialization: 'tab-separated',
      includesFormulas: plan.includesFormulas,
      estimatedBytes: plan.estimatedBytes,
    })

    let lastRevision = 0
    for (const chunk of plan.chunks()) {
      for (const cell of chunk.cells) {
        const r = await backend.setCellInput({
          kind: 'set-cell-input',
          sheetId: props.sheetId,
          row: cell.row,
          col: cell.col,
          input: cell.input,
        })
        const rev =
          typeof r?.revision === 'number'
            ? r.revision
            : Number(r?.revision ?? 0) || 0
        if (rev > lastRevision) lastRevision = rev
      }
    }

    store.setter(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId(),
      kind: 'cells.import',
      sheetId: props.sheetId,
      projectionRevision: lastRevision,
      affectedRange: pasteRange,
    })

    store.setter(markClipboardReadyAtom)
    await loadProjection(requestProjection())
  }

  function activeCellFormat(): SpreadsheetCellFormat {
    const selection = selectionSnapshot()
    const result = projectionSnapshot().result
    if (!result || result.sheetId !== selection.selection.sheetId) {
      return {}
    }
    const active = selection.activeCell
    const cell = result.cells.find(
      (candidate) => candidate.row === active.row && candidate.col === active.col,
    )
    return { ...(cell?.format ?? {}) }
  }

  async function toggleActiveFormatField(field: FormatToggleField) {
    if (!backend.setFormatRange) {
      return
    }

    const snapshot = selectionSnapshot()
    const sheetId = snapshot.selection.sheetId
    if (!sheetId) {
      return
    }

    const range = snapshot.range
    const current = activeCellFormat()
    const nextFormat: SpreadsheetCellFormat = { ...current, [field]: !current[field] }

    const result = await backend.setFormatRange({
      kind: 'set-format-range',
      sheetId,
      range,
      format: nextFormat,
    })

    const revision =
      typeof result?.revision === 'number'
        ? result.revision
        : Number(result?.revision ?? 0) || 0
    store.setter(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId(),
      kind: 'format.set',
      sheetId,
      projectionRevision: revision,
      affectedRange: { ...(result?.affectedRange ?? range) },
    })

    await loadProjection(requestProjection())
  }

  async function handleGridKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) {
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'f' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      store.setter(findReplaceOpenAtom, true)
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
        event.preventDefault()
        if (intent.scroll) {
          store.setter(scrollToCellAtom, { coord: intent.scroll.target })
        }
        bumpRender()
        return
      case 'selection.selectAll':
        event.preventDefault()
        bumpRender()
        return
      case 'selection.clearNonPrimary':
        event.preventDefault()
        bumpRender()
        return
      case 'editing.start': {
        event.preventDefault()
        const active = selectionSnapshot().activeCell
        startEditingCell(active.row, active.col, 'keyboard', {
          initialDraft: intent.initialDraft,
          clearOnStart: intent.clearOnStart,
        })
        return
      }
      case 'cell.clear':
        event.preventDefault()
        await clearSelectionRange(intent.target)
        return
      case 'clipboard.copy':
        event.preventDefault()
        await copySelectionToClipboard('copy')
        return
      case 'clipboard.cut':
        event.preventDefault()
        await copySelectionToClipboard('cut')
        return
      case 'clipboard.paste':
        event.preventDefault()
        await pasteFromClipboard()
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
      case 'history.undo':
        event.preventDefault()
        await dispatchUndo(store, backend)
        bumpRender()
        return
      case 'history.redo':
        event.preventDefault()
        await dispatchRedo(store, backend)
        bumpRender()
        return
      case 'format.toggle':
        event.preventDefault()
        await toggleActiveFormatField(intent.field)
        return
      case 'formulaReference.arrowPick': {
        event.preventDefault()
        const session = store.getter(formulaReferenceSessionAtom)
        if (!session) return
        const prev = session.tokenRange
          ? // After a previous pick, advance from the existing pick focus.
            // We don't store it explicitly, so reuse the session anchor as
            // the starting point; arrow keys move from anchor by delta.
            { row: session.anchorCell.row, col: session.anchorCell.col }
          : { row: session.anchorCell.row, col: session.anchorCell.col }
        const next = {
          row: Math.max(0, prev.row + intent.rowDelta),
          col: Math.max(0, prev.col + intent.colDelta),
        }
        store.setter(pickFormulaReferenceAtom, {
          pickAnchor: next,
          pickFocus: next,
          sheetId: session.sheetId,
          dragging: false,
        })
        bumpRender()
        return
      }
      case 'formulaReference.exit': {
        event.preventDefault()
        // The keyboard dispatcher emits this for operator/separator typed, or
        // for commit/cancel keys. The host clears the session here; if the
        // reason is commit/cancel the cell editor's keydown will follow.
        store.setter(formulaReferenceSessionAtom, null)
        bumpRender()
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

  function getFilterRulesForSheet() {
    renderTick()
    const state = store.getter(filterSortStateAtom)
    return state[props.sheetId]?.rules ?? []
  }

  function colHasFilterRule(col: number): boolean {
    return getFilterRulesForSheet().some((r) => r.colIndex === col)
  }

  function getRemoteCursorsForSheet() {
    renderTick()
    return store.getter(remoteCursorsAtom).filter((c) => c.sheetId === props.sheetId)
  }

  function getParticipantColorHint(participantId: string): string | undefined {
    return store.getter(presenceStateAtom).participants.find((p) => p.id === participantId)?.colorHint
  }

  function findMergeAnchorCovering(
    row: number,
    col: number,
  ): { el: HTMLElement; row: number; col: number; rowspan: number; colspan: number } | null {
    if (!gridRoot) return null
    const anchors = gridRoot.querySelectorAll<HTMLElement>(
      'td.spreadsheet-grid-cell[data-merge-anchor="true"]',
    )
    for (const el of anchors) {
      const ar = Number(el.dataset.row)
      const ac = Number(el.dataset.col)
      const rs = Number(el.getAttribute('rowspan') ?? 1) || 1
      const cs = Number(el.getAttribute('colspan') ?? 1) || 1
      if (row >= ar && row < ar + rs && col >= ac && col < ac + cs) {
        return { el, row: ar, col: ac, rowspan: rs, colspan: cs }
      }
    }
    return null
  }

  function getOverlayCellRect(row: number, col: number): { x: number; y: number; w: number; h: number } | null {
    if (!gridRoot) return null
    const td = gridRoot.querySelector(
      `td.spreadsheet-grid-cell[data-row="${row}"][data-col="${col}"]`,
    ) as HTMLElement | null
    if (td) {
      const rootRect = gridRoot.getBoundingClientRect()
      const cellRect = td.getBoundingClientRect()
      return {
        x: cellRect.left - rootRect.left,
        y: cellRect.top - rootRect.top,
        w: cellRect.width,
        h: cellRect.height,
      }
    }

    // Covered by a merge: return the anchor's full rendered rect so overlays
    // (selection outline, active-cell highlight) snap to the visible merge
    // boundary instead of a phantom sub-cell position.
    const anchor = findMergeAnchorCovering(row, col)
    if (anchor) {
      const rootRect = gridRoot.getBoundingClientRect()
      const anchorRect = anchor.el.getBoundingClientRect()
      return {
        x: anchorRect.left - rootRect.left,
        y: anchorRect.top - rootRect.top,
        w: anchorRect.width,
        h: anchorRect.height,
      }
    }

    // Fall back to layout math when the cell is covered by a merge or not
    // present in the DOM. We sum sized rows/cols up to the target.
    const rows = getRows()
    const cols = getCols()
    if (rows.length === 0 || cols.length === 0) return null
    const rowsBefore = rows.filter((r) => r < row)
    const colsBefore = cols.filter((c) => c < col)
    let y = 0
    for (const r of rowsBefore) y += getRenderedRowHeight(r)
    let x = 0
    for (const c of colsBefore) x += getRenderedColumnWidth(c)
    const cornerEl = gridRoot.querySelector('.spreadsheet-grid-corner') as HTMLElement | null
    const headerCol = gridRoot.querySelector(
      `.spreadsheet-grid-col-header[data-col="${cols[0]}"]`,
    ) as HTMLElement | null
    const rowHeader = gridRoot.querySelector(
      `.spreadsheet-grid-row-header[data-row="${rows[0]}"]`,
    ) as HTMLElement | null
    const offsetX =
      (cornerEl?.getBoundingClientRect().width ?? 0) ||
      (rowHeader?.getBoundingClientRect().width ?? 0)
    const offsetY =
      (cornerEl?.getBoundingClientRect().height ?? 0) ||
      (headerCol?.getBoundingClientRect().height ?? 0)
    return {
      x: offsetX + x,
      y: offsetY + y,
      w: getRenderedColumnWidth(col),
      h: getRenderedRowHeight(row),
    }
  }

  function getOverlaySurfaceSize(): { width: number; height: number } {
    if (!gridRoot) return { width: 0, height: 0 }
    const rect = gridRoot.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  function getOverlayCells(): readonly DisplayCell[] {
    return projectionSnapshot().result?.cells ?? []
  }

  function getOverlayFreezeOrigin(): { x: number; y: number } {
    if (!gridRoot) return { x: 0, y: 0 }
    const corner = gridRoot.querySelector('.spreadsheet-grid-corner') as HTMLElement | null
    if (!corner) return { x: 0, y: 0 }
    const cornerRect = corner.getBoundingClientRect()
    const rootRect = gridRoot.getBoundingClientRect()
    return {
      x: cornerRect.right - rootRect.left,
      y: cornerRect.bottom - rootRect.top,
    }
  }

  function getRemoteCursorStyle(cursor: ReturnType<typeof getRemoteCursorsForSheet>[number]): Record<string, string> {
    const bounds = getSelectionBounds()
    const range = getSelectionRange(cursor.selection, bounds)
    const rows = getRows()
    const cols = getCols()

    let top = 0
    for (const r of rows) {
      if (r >= range.rowStart) break
      top += getRenderedRowHeight(r)
    }
    let left = 0
    for (const c of cols) {
      if (c >= range.colStart) break
      left += getRenderedColumnWidth(c)
    }
    let height = 0
    for (const r of rows) {
      if (r > range.rowEnd) break
      if (r >= range.rowStart) height += getRenderedRowHeight(r)
    }
    let width = 0
    for (const c of cols) {
      if (c > range.colEnd) break
      if (c >= range.colStart) width += getRenderedColumnWidth(c)
    }

    const color = getParticipantColorHint(cursor.participantId) ?? '#4f90f0'
    return {
      position: 'absolute',
      top: `${top}px`,
      left: `${left}px`,
      height: `${Math.max(height, 1)}px`,
      width: `${Math.max(width, 1)}px`,
      border: `2px solid ${color}`,
      'pointer-events': 'none',
      'box-sizing': 'border-box',
    }
  }

  return (
    <div
      ref={gridRoot}
      class={`spreadsheet-grid ${props.class ?? ''} ${
        showGridlines() ? '' : 'spreadsheet-grid--no-gridlines'
      } ${showHeadings() ? '' : 'spreadsheet-grid--no-headings'}`
        .replace(/\s+/g, ' ')
        .trim()}
      data-show-gridlines={showGridlines() ? 'true' : 'false'}
      data-show-headings={showHeadings() ? 'true' : 'false'}
      data-testid={props['data-testid'] ?? 'spreadsheet-grid'}
      tabIndex={0}
      style={{ position: 'relative' }}
      onKeyDown={(event) => {
        void handleGridKeyDown(event)
      }}
    >
      <table class="spreadsheet-grid-table">
        <tbody>
          <Show when={getRows().length > 0 && getCols().length > 0}>
            <Show when={showHeadings()}>
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
                      <Show when={colHasFilterRule(col)}>
                        <button
                          type="button"
                          class="spreadsheet-grid-filter-chevron"
                          data-testid={`filter-chevron-${col}`}
                          aria-label={`Filter column ${getColumnLabel(col)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            store.setter(openFilterDropdownAtom, { sheetId: props.sheetId, colIndex: col })
                            bumpRender()
                          }}
                        >
                          ▾
                        </button>
                      </Show>
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
            </Show>
            <For each={getRows()}>
              {(row) => (
                <tr class="spreadsheet-grid-row">
                  <Show when={showHeadings()}>
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
                  </Show>
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
                            data-rich-kind={cell()?.richValue?.kind}
                            data-rich-url={getCellRichUrl(cell())}
                            aria-selected={selected() ? 'true' : 'false'}
                            title={getCellValidationMessage(cell())}
                            rowSpan={getCellRowSpan(row, col)}
                            colSpan={getCellColSpan(row, col)}
                            style={getCellBoxStyle(row, col)}
                            onClick={(event) => {
                              // Suppress selection mutation during formula-
                              // reference pick mode (handled by onPointerDown).
                              if (store.getter(formulaReferenceSessionAtom)) return
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
                            onPointerDown={(event) => {
                              if (event.pointerType === 'mouse' && event.button !== 0) return
                              // Formula-reference pick mode: clicking a cell
                              // inserts an A1 ref into the current draft and
                              // does NOT change the editing-anchor selection.
                              if (store.getter(formulaReferenceSessionAtom)) {
                                event.preventDefault()
                                event.stopPropagation()
                                const activeInput = document.activeElement as HTMLInputElement | null
                                store.setter(pickFormulaReferenceAtom, {
                                  pickAnchor: { row, col },
                                  pickFocus: { row, col },
                                  sheetId: props.sheetId,
                                  dragging: false,
                                })
                                bumpRender()
                                // Re-focus the editing input so blur does not
                                // fire and commit the draft prematurely.
                                if (activeInput && (activeInput.classList.contains('cell-input') ||
                                  activeInput.classList.contains('formula-bar-input'))) {
                                  queueMicrotask(() => {
                                    activeInput.focus()
                                    const len = activeInput.value.length
                                    activeInput.setSelectionRange(len, len)
                                  })
                                }
                                return
                              }
                              if (event.shiftKey || event.ctrlKey || event.metaKey) return
                              startDragSelection(event, row, col)
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
                                <div class="spreadsheet-grid-cell-button">
                                  <span
                                    class="cell-display"
                                    style={getCellFormatStyle(getDisplayCellFormat(cell()))}
                                  >
                                    <SpreadsheetCellDisplayValue cell={cell()} />
                                  </span>
                                </div>
                              }
                            >
                              <input
                                class="cell-input"
                                value={editingDraft()}
                                ref={(el) => {
                                  // autofocus is blocked when grid root already
                                  // has focus; queue an explicit focus + caret
                                  // placement so subsequent keystrokes land on
                                  // the input, not on the grid keydown handler.
                                  if (el) {
                                    queueMicrotask(() => {
                                      el.focus()
                                      const len = el.value.length
                                      el.setSelectionRange(len, len)
                                    })
                                  }
                                }}
                                onInput={(event) => {
                                  store.setter(editingDraftAtom, {
                                    draft: event.currentTarget.value,
                                  })
                                  syncFormulaReferenceCaret(
                                    store,
                                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                  )
                                  bumpRender()
                                }}
                                onSelect={(event) => {
                                  syncFormulaReferenceCaret(
                                    store,
                                    event.currentTarget.selectionStart ?? 0,
                                  )
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void commitCellEdit(event.shiftKey ? 'up' : 'down')
                                  } else if (event.key === 'Tab') {
                                    event.preventDefault()
                                    void commitCellEdit(event.shiftKey ? 'left' : 'right')
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    dispatchEditingCancel(store)
                                    bumpRender()
                                  }
                                }}
                                onBlur={() => {
                                  // Do not commit if the blur was caused by
                                  // a formula-reference pick — focus will be
                                  // restored in the next microtask.
                                  if (store.getter(formulaReferenceSessionAtom)) return
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
      <SpreadsheetGridOverlay
        sheetId={props.sheetId}
        getCellRect={getOverlayCellRect}
        getSurfaceSize={getOverlaySurfaceSize}
        getCells={getOverlayCells}
        getFreezeOrigin={getOverlayFreezeOrigin}
      />
      <For each={getRemoteCursorsForSheet()}>
        {(cursor) => (
          <div
            class="spreadsheet-remote-cursor"
            data-testid={`remote-cursor-${cursor.participantId}`}
            style={getRemoteCursorStyle(cursor)}
          />
        )}
      </For>
    </div>
  )
}
