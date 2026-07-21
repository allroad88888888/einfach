import {
  activateSheetTabAtom,
  CLIPBOARD_ORIGIN_MARKER_PREFIX,
  beginProjectionAtom,
  cancelPointerAtom,
  clipboardStateAtom,
  collapseOutlineToLevelAtom,
  commitPointerAtom,
  copyClipboardAtom,
  createClipboardTsvPastePlan,
  cutClipboardAtom,
  createFillHandlePreview,
  detectFillSeries,
  dispatchKeyboardInputAtom,
  dismissFormulaSuggestionsAtom,
  editingDraftAtom,
  editingSessionAtom,
  exitFormulaReferenceAtom,
  formulaFunctionSuggestionCursorAtom,
  formulaFunctionSuggestionsAtom,
  formulaReferenceSessionAtom,
  pickFormulaReferenceAtom,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  getOutlineLeveledGroupsForSheet,
  getOutlineMaxLevelForSheet,
  getAdjacentSheetId,
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  getRichValueText,
  getViewportColumnWidth,
  getViewportRowHeight,
  getSelectionRange,
  hydrateSheetProtectionAtom,
  hydrateViewportFreezeAtom,
  hydrateViewportHiddenAtom,
  hydrateViewportSizeProjectionAtom,
  addSelectionRegionAtom,
  isMergeCovered,
  markClipboardReadyAtom,
  nextHistoryTransactionId,
  openMenuAtom,
  openPasteSpecialAtom,
  pasteSpecialCapabilityAtom,
  pasteClipboardAtom,
  pointerSessionAtom,
  pushHistoryAtom,
  scrollToCellAtom,
  serializeClipboardTsv,
  setClipboardErrorAtom,
  shiftFormulaRefs,
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
  setViewportColumnWidthAtom,
  setSelectionBoundsAtom,
  setViewportRowHeightAtom,
  setViewportMetricsAtom,
  sheetTabsSheetsAtom,
  startPointerAtom,
  startEditingAtom,
  toggleOutlineGroupCollapsedAtom,
  updatePointerAtom,
  activeCellLockedAtom,
  issueProjectionRequestIdAtom,
  openFindReplaceAtom,
  openGoToAtom,
  filterSortStateAtom,
  fillSeriesLocaleAtom,
  openFilterDropdownAtom,
  openFormatCellsAtom,
  notifyActiveSheetChangedAtom,
  outlineAtom,
  remoteCursorsAtom,
  rejectProjectionAtom,
  resetProjectionAtom,
  resolveContentMutationAtom,
  resolveProjectionAtom,
  presenceStateAtom,
  type CellCoord,
  type CellRange,
  type ClipboardTransferInput,
  type DisplayCell,
  type DisplayCellRichValue,
  type FormatToggleField,
  type MenuOpenInput,
  type OutlineAxis,
  type OutlineGroupWithLevel,
  type PointerFillHandleCommitIntent,
  type RangeProjectionResult,
  type RichTextRunFormat,
  type SelectionRegion,
  type SelectionState,
  type SpreadsheetCellFormat,
  type ViewportMetrics,
  getFilterHiddenRowsForSheet,
  effectiveHiddenAtom,
  viewportFilterHiddenAtom,
  viewportFreezeAtom,
  viewportHiddenAtom,
  viewportMetricsAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  viewportSizeOverridesAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  acceptFormulaSuggestion,
  dispatchCopyAs,
  dispatchCopyAsImage,
  dispatchEditingCancel,
  dispatchEditingCommit,
  dispatchRedo,
  dispatchUndo,
  notifyDraftTypedChar,
  readActiveFormulaSuggestion,
  runVisibleProjectionTransport,
  spreadsheetProjectionSnapshotAtom,
  syncFormulaReferenceCaret,
} from '../provider'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'
import { SpreadsheetCellBorders } from './SpreadsheetCellBorders'
import { SpreadsheetGridOverlay } from './SpreadsheetGridOverlay'
import { SpreadsheetGridOverlaySvg } from './SpreadsheetGridOverlaySvg'

function useSvgOverlayEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('svgOverlay') === '1'
  } catch {
    return false
  }
}

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

const GRID_ROW_HEADER_WIDTH = 44

// Outline (grouping) gutter geometry: one fixed-size slot per nesting
// level. The gutter renders only when the sheet has groups on that axis,
// so sheets without outlines keep their exact pre-outline layout.
const OUTLINE_GUTTER_SLOT_PX = 14
const OUTLINE_GUTTER_PADDING_PX = 6

// Hidden rows/columns are UI-core canonical zero-size entries in the axis
// math: a hidden index contributes 0px to offsets and spans, mirroring
// the ui-core getVisibleWindowWithHidden semantics (the same pixel span
// covers more indices when some of them are hidden).
function getAxisOffsetForIndex(
  index: number,
  count: number,
  fallbackSize: number,
  overrides: Record<string, number> | undefined,
  hidden?: ReadonlySet<number>,
) {
  const clampedIndex = Math.max(0, Math.min(count, Math.trunc(index)))
  let offset = clampedIndex * fallbackSize

  for (const [key, size] of Object.entries(overrides ?? {})) {
    const overrideIndex = Number(key)
    if (!Number.isInteger(overrideIndex)) continue
    if (overrideIndex < 0 || overrideIndex >= clampedIndex) continue
    if (hidden?.has(overrideIndex)) continue
    offset += size - fallbackSize
  }

  if (hidden) {
    for (const hiddenIndex of hidden) {
      if (Number.isInteger(hiddenIndex) && hiddenIndex >= 0 && hiddenIndex < clampedIndex) {
        offset -= fallbackSize
      }
    }
  }

  return Math.max(0, offset)
}

function getAxisSpanSize(
  start: number,
  end: number,
  count: number,
  fallbackSize: number,
  overrides: Record<string, number> | undefined,
  hidden?: ReadonlySet<number>,
) {
  if (count <= 0 || end < start) return 0
  const clampedStart = Math.max(0, Math.min(count, Math.trunc(start)))
  const clampedEnd = Math.max(0, Math.min(count - 1, Math.trunc(end)))
  if (clampedEnd < clampedStart) return 0
  return (
    getAxisOffsetForIndex(clampedEnd + 1, count, fallbackSize, overrides, hidden) -
    getAxisOffsetForIndex(clampedStart, count, fallbackSize, overrides, hidden)
  )
}

function getAxisStartIndexAtOffset(
  offset: number,
  count: number,
  fallbackSize: number,
  overrides: Record<string, number> | undefined,
  hidden?: ReadonlySet<number>,
) {
  if (count <= 0) return 0

  const target = Math.max(0, offset)
  let low = 0
  let high = count - 1
  let result = count - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const cellEnd = getAxisOffsetForIndex(mid + 1, count, fallbackSize, overrides, hidden)
    if (cellEnd > target) {
      result = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return result
}

function getAxisEndIndexAtOffset(
  offset: number,
  count: number,
  fallbackSize: number,
  overrides: Record<string, number> | undefined,
  hidden?: ReadonlySet<number>,
) {
  if (count <= 0) return -1

  const target = Math.max(0, offset)
  let low = 0
  let high = count - 1
  let result = 0

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const cellStart = getAxisOffsetForIndex(mid, count, fallbackSize, overrides, hidden)
    if (cellStart < target) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
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
  if (format.fontFamily) style['font-family'] = format.fontFamily

  if (format.verticalAlign) {
    // Two complementary mechanisms run together so the v-align toolbar lights
    // up regardless of whether the parent .spreadsheet-grid-cell-button is
    // laying out as a flex column or as plain block content:
    //
    //  1. `vertical-align: <value>` is the canonical CSS property — when the
    //     parent .cell <td> is table-cell display, the browser normalises
    //     `center` to `middle` and uses it to anchor inline content. The e2e
    //     assertions read this exact property.
    //  2. `margin-block: auto` keeps the flex-column anchor logic from prior
    //     waves so visual rendering still moves the text up/down when the
    //     parent renders as a flex column.
    //
    // The legacy --cell-vertical-align var stays for canvas-overlay adapters
    // that read the anchor directly.
    //
    // `SpreadsheetVerticalAlignment` uses `'center'` as its midline keyword,
    // but the CSS `vertical-align` keyword is `'middle'`. Map the engine
    // value through so the inline style matches the spec for the parent
    // table-cell context.
    const cssVerticalAlign = format.verticalAlign === 'center' ? 'middle' : format.verticalAlign
    style['vertical-align'] = cssVerticalAlign
    style['--cell-vertical-align'] = format.verticalAlign
    style['height'] = 'auto'
    if (format.verticalAlign === 'top') {
      style['margin-top'] = '0'
      style['margin-bottom'] = 'auto'
    } else if (format.verticalAlign === 'center') {
      style['margin-top'] = 'auto'
      style['margin-bottom'] = 'auto'
    } else if (format.verticalAlign === 'bottom') {
      style['margin-top'] = 'auto'
      style['margin-bottom'] = '0'
    }
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

function getCellBackgroundStyle(format: SpreadsheetCellFormat | undefined): Record<string, string> {
  return format?.bgColor ? { background: format.bgColor } : {}
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

/**
 * Stringified borders sides so e2e specs can verify the borders toolbar
 * applied the right per-cell patch without touching the projection atom.
 * Format: `"top right bottom left"` (sorted, sides that are present only).
 * Returns `undefined` when no borders are set so the DOM attribute is absent
 * — keeps the typical render footprint identical to before.
 */
function getCellBordersAttr(cell: DisplayCell | undefined): string | undefined {
  const borders = cell?.format?.borders
  if (!borders) return undefined
  const sides: string[] = []
  if (borders.top && borders.top.style !== 'none') sides.push('top')
  if (borders.right && borders.right.style !== 'none') sides.push('right')
  if (borders.bottom && borders.bottom.style !== 'none') sides.push('bottom')
  if (borders.left && borders.left.style !== 'none') sides.push('left')
  if (sides.length === 0) return undefined
  return sides.join(' ')
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
    row >= range.rowStart && row <= range.rowEnd && col >= range.colStart && col <= range.colEnd
  )
}

function getCellInputForFill(
  cell: DisplayCell | undefined,
  source: CellCoord,
  target: CellCoord,
): string {
  if (cell?.formula) {
    return shiftFormulaRefs(cell.formula, target.row - source.row, target.col - source.col)
  }
  return cell?.displayValue ?? ''
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
  let scrollRoot: HTMLDivElement | undefined
  let activeResizeCleanup: (() => void) | null = null
  let activeFillCleanup: (() => void) | null = null
  let unsubscribeProjection: (() => void) | null = null
  let unsubscribeContentChanges: (() => void) | null = null
  let unsubscribeViewport: (() => void) | null = null
  let unsubscribeSizes: (() => void) | null = null
  let unsubscribeHidden: (() => void) | null = null
  let unsubscribeFilterHidden: (() => void) | null = null
  let unsubscribeOutline: (() => void) | null = null
  let unsubscribeFreeze: (() => void) | null = null
  let unsubscribePointer: (() => void) | null = null
  let unsubscribePresence: (() => void) | null = null
  let unsubscribeFilterSort: (() => void) | null = null
  let unsubscribeWorkspace: (() => void) | null = null
  let unsubscribeShowGridlines: (() => void) | null = null
  let unsubscribeShowHeadings: (() => void) | null = null
  let unsubscribeSelection: (() => void) | null = null
  let unsubscribeEditing: (() => void) | null = null
  let lastActiveSheetId: string | null = null
  let lastEffectiveFreezeRows = 0
  let lastEffectiveFreezeCols = 0
  let resizeObserver: ResizeObserver | null = null

  function bumpRender() {
    setRenderTick((value) => value + 1)
  }

  function visibleWindow() {
    renderTick()
    return getRenderedVisibleWindow()
  }

  function viewportMetrics() {
    renderTick()
    return store.getter(viewportMetricsAtom)
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

  function getEffectiveFreezeProjection() {
    // Freeze is UI-core canonical: read the local view fact directly.
    // No authority gate — the projection is always valid.
    const freezeState = store.getter(viewportFreezeAtom)
    return {
      rows: freezeState.rowsBySheet[props.sheetId] ?? 0,
      cols: freezeState.colsBySheet[props.sheetId] ?? 0,
    }
  }

  // Rendering asks only "is this row painted?", and both hidden sets answer
  // yes — so this reads the UNION (`effectiveHiddenAtom`), never either source
  // set. Consumers that must tell a manual hide from a filtered-away row (copy,
  // SUBTOTAL, the dense scans) read the two atoms separately and deliberately.
  //
  // Row numbering needs no change at all: the header has always rendered
  // `row + 1` for whatever rows survive this filter, so Excel's 1, 4, 5 skip
  // falls out of hiding rows instead of compacting them.
  function getHiddenRowSet(): ReadonlySet<number> {
    return new Set(getHiddenRowsForSheet(store.getter(effectiveHiddenAtom), props.sheetId))
  }

  function getHiddenColSet(): ReadonlySet<number> {
    return new Set(getHiddenColumnsForSheet(store.getter(viewportHiddenAtom), props.sheetId))
  }

  function getRenderedVisibleWindow(): CellRange {
    const metrics = store.getter(viewportMetricsAtom)
    const overrides = store.getter(viewportSizeOverridesAtom)
    const rowOverrides = overrides.rowHeightsBySheet[props.sheetId]
    const colOverrides = overrides.colWidthsBySheet[props.sheetId]
    const hiddenRows = getHiddenRowSet()
    const hiddenCols = getHiddenColSet()

    if (metrics.rowCount === 0 || metrics.colCount === 0) {
      return {
        rowStart: 0,
        rowEnd: -1,
        colStart: 0,
        colEnd: -1,
      }
    }

    const rawRowStart = getAxisStartIndexAtOffset(
      metrics.scrollTop,
      metrics.rowCount,
      metrics.rowHeight,
      rowOverrides,
      hiddenRows,
    )
    const rawColStart = getAxisStartIndexAtOffset(
      metrics.scrollLeft,
      metrics.colCount,
      metrics.colWidth,
      colOverrides,
      hiddenCols,
    )
    const rawRowEnd =
      metrics.viewportHeight <= 0
        ? rawRowStart
        : getAxisEndIndexAtOffset(
            metrics.scrollTop + metrics.viewportHeight,
            metrics.rowCount,
            metrics.rowHeight,
            rowOverrides,
            hiddenRows,
          )
    const rawColEnd =
      metrics.viewportWidth <= 0
        ? rawColStart
        : getAxisEndIndexAtOffset(
            metrics.scrollLeft + metrics.viewportWidth,
            metrics.colCount,
            metrics.colWidth,
            colOverrides,
            hiddenCols,
          )

    // When freeze is active for this sheet, expand the projection window so the
    // backend returns the frozen rows/cols even if the viewport has scrolled
    // past them — they need to stay in DOM for `position: sticky` to keep
    // pinning them. readSparseRange returns only cells that exist, so the
    // wider window costs nothing for sparse sheets.
    const freeze = getEffectiveFreezeProjection()
    const frozenRows = freeze.rows
    const frozenCols = freeze.cols

    const expandedRowStart = frozenRows > 0 ? 0 : Math.max(0, rawRowStart - metrics.overscanRows)
    const expandedColStart = frozenCols > 0 ? 0 : Math.max(0, rawColStart - metrics.overscanCols)

    return {
      rowStart: expandedRowStart,
      rowEnd: Math.min(metrics.rowCount - 1, rawRowEnd + metrics.overscanRows),
      colStart: expandedColStart,
      colEnd: Math.min(metrics.colCount - 1, rawColEnd + metrics.overscanCols),
    }
  }

  function hiddenState() {
    renderTick()
    // Union: `effectiveHiddenAtom` returns the manual state object itself while
    // no filter hides anything, so the common case keeps referential stability.
    return store.getter(effectiveHiddenAtom)
  }

  // ── Outline (grouping) gutter ─────────────────────────────────────────
  // Outline metadata is UI-core canonical; the gutter only renders when
  // the sheet has groups on the axis, so group-free sheets keep their
  // exact layout. Collapse toggles route through the UI-core command,
  // which syncs the hidden canonical sets (grid rows/cols react via the
  // existing hidden subscription).

  function outlineState() {
    renderTick()
    return store.getter(outlineAtom)
  }

  function getOutlineGroups(axis: OutlineAxis): readonly OutlineGroupWithLevel[] {
    return getOutlineLeveledGroupsForSheet(outlineState(), props.sheetId, axis)
  }

  function hasRowOutline(): boolean {
    return getOutlineGroups('row').length > 0
  }

  function hasColOutline(): boolean {
    return getOutlineGroups('column').length > 0
  }

  function getOutlineMaxLevel(axis: OutlineAxis): number {
    return getOutlineMaxLevelForSheet(outlineState(), props.sheetId, axis)
  }

  function getRowOutlineGutterWidth(): number {
    return hasRowOutline()
      ? getOutlineMaxLevel('row') * OUTLINE_GUTTER_SLOT_PX + OUTLINE_GUTTER_PADDING_PX
      : 0
  }

  function getColOutlineBandHeight(): number {
    return hasColOutline()
      ? getOutlineMaxLevel('column') * OUTLINE_GUTTER_SLOT_PX + OUTLINE_GUTTER_PADDING_PX
      : 0
  }

  function getOutlineLevelSlots(axis: OutlineAxis): number[] {
    return Array.from({ length: getOutlineMaxLevel(axis) }, (_, index) => index + 1)
  }

  function getOutlineLevelButtons(axis: OutlineAxis): number[] {
    return Array.from({ length: getOutlineMaxLevel(axis) + 1 }, (_, index) => index + 1)
  }

  /** Excel places the +/− toggle on the summary index right after the group. */
  function getOutlineToggleAt(
    axis: OutlineAxis,
    index: number,
    level: number,
  ): OutlineGroupWithLevel | undefined {
    return getOutlineGroups(axis).find((group) => group.end + 1 === index && group.level === level)
  }

  function outlineSlotHasLine(axis: OutlineAxis, index: number, level: number): boolean {
    return getOutlineGroups(axis).some(
      (group) =>
        !group.collapsed && group.level === level && index >= group.start && index <= group.end,
    )
  }

  function toggleOutlineGroup(axis: OutlineAxis, group: OutlineGroupWithLevel) {
    store.setter(toggleOutlineGroupCollapsedAtom, {
      sheetId: props.sheetId,
      axis,
      start: group.start,
      end: group.end,
      level: group.level,
      source: backend,
    })
    bumpRender()
    focusGrid()
  }

  function collapseOutlineLevel(axis: OutlineAxis, level: number) {
    store.setter(collapseOutlineToLevelAtom, {
      sheetId: props.sheetId,
      axis,
      level,
      source: backend,
    })
    bumpRender()
    focusGrid()
  }

  function freezeRowCount(): number {
    renderTick()
    return store.getter(viewportFreezeAtom).rowsBySheet[props.sheetId] ?? 0
  }

  function freezeColCount(): number {
    renderTick()
    return store.getter(viewportFreezeAtom).colsBySheet[props.sheetId] ?? 0
  }

  function getFreezeBoundaryY(): number {
    const rows = freezeRowCount()
    if (rows <= 0) return 0
    // Prefer DOM measurement: the rendered cell height in the grid
    // (border-collapse + line-height + cell padding) does not match
    // `metrics.rowHeight` exactly, so cumulative math drifts a few pixels
    // off the actual seam. Reading the last frozen row's getBoundingClientRect
    // pins the line on the real pixel edge regardless of override / styling.
    if (gridRoot && scrollRoot) {
      const rootRect = scrollRoot.getBoundingClientRect()
      // jsdom returns all-zero rects (no layout). Math fallback is more
      // useful there for the unit-test asserts.
      if (rootRect.height > 0) {
        const lastFrozen = gridRoot.querySelector(
          `td.spreadsheet-grid-cell[data-row="${rows - 1}"]`,
        ) as HTMLElement | null
        if (lastFrozen) {
          return lastFrozen.getBoundingClientRect().bottom - rootRect.top
        }
      }
    }
    const headingHeight = showHeadings() ? viewportMetrics().rowHeight : 0
    return headingHeight + getRowSpanHeight(0, rows - 1)
  }

  function getFreezeBoundaryX(): number {
    const cols = freezeColCount()
    if (cols <= 0) return 0
    if (gridRoot && scrollRoot) {
      const rootRect = scrollRoot.getBoundingClientRect()
      if (rootRect.width > 0) {
        const lastFrozen = gridRoot.querySelector(
          `td.spreadsheet-grid-cell[data-col="${cols - 1}"]`,
        ) as HTMLElement | null
        if (lastFrozen) {
          return lastFrozen.getBoundingClientRect().right - rootRect.left
        }
      }
    }
    const headingWidth = showHeadings() ? GRID_ROW_HEADER_WIDTH : 0
    return headingWidth + getColumnSpanWidth(0, cols - 1)
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
    const window = getRenderedVisibleWindow()
    if (window.rowEnd < window.rowStart || window.colEnd < window.colStart) {
      store.setter(resetProjectionAtom)
      bumpRender()
      return undefined
    }

    const begin = store.setter(beginProjectionAtom, {
      kind: 'visible-window',
      sheetId: props.sheetId,
      window,
      reason: 'viewport',
    })
    if (
      (begin.status !== 'started' && begin.status !== 'queued') ||
      begin.request.kind !== 'visible-window'
    ) {
      return undefined
    }
    bumpRender()

    return begin.status === 'started' ? { request: begin.request } : undefined
  }

  async function loadProjection(requestInfo: ReturnType<typeof requestProjection>) {
    if (!requestInfo) {
      return
    }

    const { request } = requestInfo
    try {
      await runVisibleProjectionTransport(store, backend, request)
    } catch {
      // The shared transport loop already published the terminal error.
    }
    bumpRender()
  }

  async function readRangeProjection(
    sheetId: string,
    range: CellRange,
    reason: 'clipboard' | 'fill-handle',
  ): Promise<RangeProjectionResult | null> {
    const begin = store.setter(beginProjectionAtom, {
      kind: 'range',
      sheetId,
      range,
      reason,
    })
    if (begin.status !== 'started' || begin.request.kind !== 'range') return null

    const request = begin.request
    try {
      const result = await backend.readRangeProjection(request)
      const outcome = store.setter(resolveProjectionAtom, { request, result })
      return outcome.status === 'accepted' && outcome.result.kind === 'range'
        ? outcome.result
        : null
    } catch (error) {
      store.setter(rejectProjectionAtom, { request, error })
      throw error
    }
  }

  async function hydrateViewportSizeProjection() {
    const window = getRenderedVisibleWindow()
    if (window.rowEnd < window.rowStart || window.colEnd < window.colStart) {
      return
    }

    const outcome = await store.setter(hydrateViewportSizeProjectionAtom, {
      source: backend,
      sheetId: props.sheetId,
      window,
    })
    if (outcome === 'ready') bumpRender()
  }

  function syncScrollElementToViewport() {
    if (!scrollRoot) {
      return
    }

    const metrics = store.getter(viewportMetricsAtom)
    if (Math.abs(scrollRoot.scrollTop - metrics.scrollTop) > 0.5) {
      scrollRoot.scrollTop = metrics.scrollTop
    }
    if (Math.abs(scrollRoot.scrollLeft - metrics.scrollLeft) > 0.5) {
      scrollRoot.scrollLeft = metrics.scrollLeft
    }
  }

  function syncViewportSizeFromElement() {
    if (!scrollRoot) {
      return
    }

    const metrics = store.getter(viewportMetricsAtom)
    const headingWidth = store.getter(viewportShowHeadingsAtom) ? GRID_ROW_HEADER_WIDTH : 0
    const headingHeight = store.getter(viewportShowHeadingsAtom) ? metrics.rowHeight : 0
    const measuredWidth = scrollRoot.clientWidth - headingWidth
    const measuredHeight = scrollRoot.clientHeight - headingHeight
    const viewportWidth = measuredWidth > 0 ? measuredWidth : metrics.viewportWidth
    const viewportHeight = measuredHeight > 0 ? measuredHeight : metrics.viewportHeight
    if (metrics.viewportWidth === viewportWidth && metrics.viewportHeight === viewportHeight) {
      return
    }

    store.setter(viewportMetricsAtom, {
      ...metrics,
      viewportWidth,
      viewportHeight,
    })
  }

  function refreshViewportProjection() {
    syncViewportSizeFromElement()
    syncScrollElementToViewport()
    bumpRender()
    void loadProjection(requestProjection())
    void hydrateViewportSizeProjection()
  }

  function refreshEffectiveFreezeProjection() {
    const next = getEffectiveFreezeProjection()
    const changed = next.rows !== lastEffectiveFreezeRows || next.cols !== lastEffectiveFreezeCols
    lastEffectiveFreezeRows = next.rows
    lastEffectiveFreezeCols = next.cols
    bumpRender()
    if (changed) {
      void loadProjection(requestProjection())
    }
  }

  function handleViewportScroll(event: Event & { currentTarget: HTMLDivElement }) {
    const target = event.currentTarget
    const metrics = store.getter(viewportMetricsAtom)
    if (metrics.scrollTop === target.scrollTop && metrics.scrollLeft === target.scrollLeft) {
      return
    }

    store.setter(viewportMetricsAtom, {
      ...metrics,
      scrollTop: target.scrollTop,
      scrollLeft: target.scrollLeft,
    })
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

  createEffect(() => {
    // One-shot hydration seed from the optional persistence hook. Freeze
    // itself is UI-core canonical and does not wait for this to resolve.
    void store.setter(hydrateViewportFreezeAtom, {
      source: backend,
      sheetId: props.sheetId,
    })
    // Same seeded-sheets pattern for hidden rows/columns: the local sets
    // are canonical; the backend mirror only seeds a sheet once.
    const metrics = store.getter(viewportMetricsAtom)
    void store.setter(hydrateViewportHiddenAtom, {
      source: backend,
      sheetId: props.sheetId,
      rowCount: metrics.rowCount > 0 ? metrics.rowCount : props.viewport.rowCount,
      colCount: metrics.colCount > 0 ? metrics.colCount : props.viewport.colCount,
    })
    // Same pattern for sheet protection (#40): the local canonical map is
    // authoritative; `readSheetProtection` only seeds a sheet once.
    void store.setter(hydrateSheetProtectionAtom, {
      source: backend,
      sheetId: props.sheetId,
    })
  })

  onMount(() => {
    const initialFreeze = getEffectiveFreezeProjection()
    lastEffectiveFreezeRows = initialFreeze.rows
    lastEffectiveFreezeCols = initialFreeze.cols
    unsubscribeProjection = store.sub(spreadsheetProjectionSnapshotAtom, bumpRender)
    unsubscribeViewport = store.sub(viewportMetricsAtom, refreshViewportProjection)
    unsubscribeSizes = store.sub(viewportSizeOverridesAtom, bumpRender)
    unsubscribeHidden = store.sub(viewportHiddenAtom, bumpRender)
    // The filter half of the union needs its own subscription: applying or
    // clearing a filter changes which rows are painted without touching the
    // manual set, and would otherwise not repaint until some other atom fired.
    unsubscribeFilterHidden = store.sub(viewportFilterHiddenAtom, bumpRender)
    unsubscribeOutline = store.sub(outlineAtom, bumpRender)
    unsubscribeFreeze = store.sub(viewportFreezeAtom, refreshEffectiveFreezeProjection)
    unsubscribePointer = store.sub(pointerSessionAtom, bumpRender)
    unsubscribePresence = store.sub(presenceStateAtom, bumpRender)
    unsubscribeFilterSort = store.sub(filterSortStateAtom, bumpRender)
    unsubscribeShowGridlines = store.sub(viewportShowGridlinesAtom, bumpRender)
    unsubscribeShowHeadings = store.sub(viewportShowHeadingsAtom, bumpRender)
    unsubscribeSelection = store.sub(selectionAtom, bumpRender)
    unsubscribeEditing = store.sub(editingSessionAtom, bumpRender)
    // Wave 8.2 — engine-initiated content changes (async custom-formula
    // settles, collaborative edits) have no UI command to piggyback on;
    // the backend pushes a coarse ping and we refetch the window.
    unsubscribeContentChanges =
      backend.subscribeContentChanges?.(() => {
        void loadProjection(requestProjection())
      }) ?? null

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
    syncViewportSizeFromElement()
    syncScrollElementToViewport()
    if (typeof ResizeObserver !== 'undefined' && scrollRoot) {
      resizeObserver = new ResizeObserver(() => {
        syncViewportSizeFromElement()
      })
      resizeObserver.observe(scrollRoot)
    }
  })

  onCleanup(() => {
    resizeObserver?.disconnect()
    unsubscribeProjection?.()
    unsubscribeContentChanges?.()
    unsubscribeViewport?.()
    unsubscribeSizes?.()
    unsubscribeHidden?.()
    unsubscribeFilterHidden?.()
    unsubscribeOutline?.()
    unsubscribeFreeze?.()
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

  async function commitCellEdit(move: 'none' | 'down' | 'up' | 'left' | 'right' = 'none') {
    const session = store.getter(editingSessionAtom)
    if (session.status !== 'drafting' || session.source === null) return
    const source = session.source
    const outcome = await dispatchEditingCommit(store, backend, { move, source: 'cell' })
    if (outcome !== 'completed') return

    if (move !== 'none') {
      const bounds = getSelectionBounds()
      const next = { row: source.cell.row, col: source.cell.col }
      if (move === 'down') next.row = Math.min(bounds.rowCount - 1, next.row + 1)
      else if (move === 'up') next.row = Math.max(0, next.row - 1)
      else if (move === 'right') next.col = Math.min(bounds.colCount - 1, next.col + 1)
      else if (move === 'left') next.col = Math.max(0, next.col - 1)
      store.setter(selectCellAtom, {
        sheetId: source.sheetId,
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

    // Mutation gateway: remap display rows to source rows (filter/sort) and
    // enforce the protection gate. Any blocked region aborts the whole
    // command before the first transport (fail-closed). Format-only clears
    // skip the lock gate — format gating is outside the content-mutation scope.
    const resolvedRanges: CellRange[][] = []
    for (const range of ranges) {
      const resolution = store.setter(resolveContentMutationAtom, {
        kind: 'clear-range',
        sheetId: props.sheetId,
        range,
        protectionGate: target !== 'formats',
      })
      if (resolution.status === 'blocked') {
        return
      }
      resolvedRanges.push((resolution.ranges ?? [range]).map((sourceRange) => ({ ...sourceRange })))
    }

    if (regions.length === 1 && target === 'values') {
      const range = ranges[0]
      const isSingleCell = range.rowStart === range.rowEnd && range.colStart === range.colEnd
      if (isSingleCell) {
        const sourceRange = resolvedRanges[0][0]
        const result = await backend.setCellInput({
          kind: 'set-cell-input',
          sheetId: props.sheetId,
          row: sourceRange.rowStart,
          col: sourceRange.colStart,
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
          affectedRange: result?.affectedRange ?? sourceRange,
        })
        await loadProjection(requestProjection())
        return
      }
    }

    if (!backend.clearRange) {
      return
    }

    // One UI history entry PER clearRange transport (N:N). Both reference
    // adapters record one undo transaction per clearRange call, so a single
    // entry over N region clears would leave the adapter stack N-1 records
    // deeper than the UI stack and every later undo would replay the wrong
    // snapshot. Sequential on purpose: entry order must match the adapter's
    // record order (positional alignment).
    for (const range of resolvedRanges.flat()) {
      const result = await backend.clearRange({
        kind: 'clear-range',
        sheetId: props.sheetId,
        range,
        target,
      })
      const revision =
        typeof result?.revision === 'number' ? result.revision : Number(result?.revision ?? 0) || 0
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'range.clear',
        sheetId: props.sheetId,
        projectionRevision: revision,
        affectedRange: result?.affectedRange ? { ...result.affectedRange } : { ...range },
      })
    }
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

    // Anchor at the top-left, focus at the bottom-right: the natural user
    // mental model for "I clicked this cell and the selection grew to cover
    // the merged region". A subsequent Shift+click extends from the top-left
    // anchor (not the bottom-right), so clicking a merge-anchor A1 (which
    // expands to A1:B2) and then Shift+clicking C3 lands on the rect A1:C3,
    // letting the copy-as HTML encoder emit `rowspan="2" colspan="2"` for
    // the merge anchor. Pinned by `copy-as.spec.ts:210` 'emits
    // rowspan/colspan on the anchor of a merged A1:B2 region'.
    return {
      kind: 'range',
      sheetId: props.sheetId,
      anchor: { row: range.rowStart, col: range.colStart },
      focus: { row: range.rowEnd, col: range.colEnd },
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
    const anchor = snapshot.selection.sheetId === props.sheetId ? snapshot.activeCell : { row, col }
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

  function startFormulaReferenceDragPick(event: PointerEvent, row: number, col: number) {
    // Capture the editing input up-front so pointerup can restore focus to
    // it (a stray blur during the drag would otherwise commit the draft).
    const activeInput = document.activeElement as HTMLInputElement | null
    const anchor: CellCoord = { row, col }

    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: anchor,
      pickFocus: anchor,
      sheetId: props.sheetId,
      dragging: true,
    })
    bumpRender()

    let lastFocus = anchor

    const onPointerMove = (moveEvent: PointerEvent) => {
      const focus = getCellCoordFromPoint(moveEvent)
      if (!focus) return
      if (focus.row === lastFocus.row && focus.col === lastFocus.col) return
      lastFocus = focus
      store.setter(pickFormulaReferenceAtom, {
        pickAnchor: anchor,
        pickFocus: focus,
        sheetId: props.sheetId,
        dragging: true,
      })
      bumpRender()
    }

    const onPointerUp = () => {
      store.setter(pickFormulaReferenceAtom, {
        pickAnchor: anchor,
        pickFocus: lastFocus,
        sheetId: props.sheetId,
        dragging: false,
      })
      cleanup()
      bumpRender()
      if (
        activeInput &&
        (activeInput.classList.contains('cell-input') ||
          activeInput.classList.contains('formula-bar-input'))
      ) {
        queueMicrotask(() => {
          activeInput.focus()
          const len = activeInput.value.length
          activeInput.setSelectionRange(len, len)
        })
      }
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

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

  function getKeyboardContextMenuInput(): MenuOpenInput | null {
    const snapshot = store.getter(selectionSnapshotAtom)
    if (!gridRoot || snapshot.selection.sheetId !== props.sheetId) {
      return null
    }

    const activeCellElement =
      gridRoot.querySelector<HTMLElement>(
        `td.spreadsheet-grid-cell[data-row="${snapshot.activeCell.row}"][data-col="${snapshot.activeCell.col}"]`,
      ) ??
      findMergeAnchorCovering(snapshot.activeCell.row, snapshot.activeCell.col)?.el ??
      null
    let anchorElement: HTMLElement | null = activeCellElement
    let input: Pick<MenuOpenInput, 'surface' | 'target'>

    switch (snapshot.selection.kind) {
      case 'cell':
        input = {
          surface: 'cell',
          target: {
            kind: 'cell',
            sheetId: props.sheetId,
            cell: { row: snapshot.activeCell.row, col: snapshot.activeCell.col },
          },
        }
        break
      case 'range': {
        const isSingleCell =
          snapshot.range.rowStart === snapshot.range.rowEnd &&
          snapshot.range.colStart === snapshot.range.colEnd
        input = {
          surface: 'cell',
          target: isSingleCell
            ? {
                kind: 'cell',
                sheetId: props.sheetId,
                cell: { row: snapshot.activeCell.row, col: snapshot.activeCell.col },
              }
            : {
                kind: 'range',
                sheetId: props.sheetId,
                range: snapshot.range,
              },
        }
        break
      }
      case 'row':
        anchorElement =
          gridRoot.querySelector<HTMLElement>(
            `.spreadsheet-grid-row-header[data-row="${snapshot.selection.rowFocus}"]`,
          ) ?? activeCellElement
        input = {
          surface: 'header',
          target: {
            kind: 'row',
            sheetId: props.sheetId,
            rowIndex: snapshot.selection.rowFocus,
          },
        }
        break
      case 'column':
        anchorElement =
          gridRoot.querySelector<HTMLElement>(
            `.spreadsheet-grid-col-header[data-col="${snapshot.selection.colFocus}"]`,
          ) ?? activeCellElement
        input = {
          surface: 'header',
          target: {
            kind: 'column',
            sheetId: props.sheetId,
            colIndex: snapshot.selection.colFocus,
          },
        }
        break
      case 'all':
        anchorElement =
          gridRoot.querySelector<HTMLElement>('.spreadsheet-grid-corner') ?? activeCellElement
        input = {
          surface: 'header',
          target: {
            kind: 'all',
            sheetId: props.sheetId,
          },
        }
        break
    }

    if (!anchorElement) {
      return null
    }

    const rect = anchorElement.getBoundingClientRect()
    return {
      ...input,
      position: { x: rect.left, y: rect.bottom },
      source: 'keyboard',
    }
  }

  function targetFallsWithinSingleAxisSelection(
    target: { kind: 'row'; row: number } | { kind: 'column'; col: number },
  ): boolean {
    const regions = store.getter(selectionRegionsAtom)
    if (regions.length !== 1) return false

    const region = regions[0]
    if (region?.sheetId !== props.sheetId || region.kind !== target.kind) return false

    if (target.kind === 'row' && region.kind === 'row') {
      const start = Math.min(region.rowAnchor, region.rowFocus)
      const end = Math.max(region.rowAnchor, region.rowFocus)
      return target.row >= start && target.row <= end
    }

    if (target.kind === 'column' && region.kind === 'column') {
      const start = Math.min(region.colAnchor, region.colFocus)
      const end = Math.max(region.colAnchor, region.colFocus)
      return target.col >= start && target.col <= end
    }

    return false
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
    } else if (target.kind === 'row' && !targetFallsWithinSingleAxisSelection(target)) {
      store.setter(selectRowsAtom, {
        sheetId: props.sheetId,
        rowAnchor: target.row,
        rowFocus: target.row,
      })
    } else if (target.kind === 'column' && !targetFallsWithinSingleAxisSelection(target)) {
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
  ):
    | { kind: 'cell'; row: number; col: number }
    | { kind: 'range'; row: number; col: number; range: CellRange } {
    const range = getSelectionRangeContaining(row, col)
    if (range) {
      // A single-cell "range" (rowStart===rowEnd && colStart===colEnd) is
      // semantically a cell target — the menu surface treats `kind: 'cell'`
      // vs `kind: 'range'` as the "single cell vs multi-cell selection"
      // distinction, so collapsing 1x1 ranges keeps the context menu's
      // `data-menu-target-kind="cell"` invariant for the default A1 cursor
      // (vnext-smoke.spec.ts 'toolbar and context menu use vNext interaction
      // atoms') without losing the multi-cell range path used by adjacent
      // tests ('range context menu clear preserves selection...').
      const isSingleCell = range.rowStart === range.rowEnd && range.colStart === range.colEnd
      if (!isSingleCell) {
        return { kind: 'range', row, col, range }
      }
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

    const sourceProjection = await readRangeProjection(
      intent.sheetId,
      intent.sourceRange,
      'fill-handle',
    )
    if (sourceProjection === null) return
    const sourceCells = new Map<string, DisplayCell>()
    for (const cell of sourceProjection.cells) {
      sourceCells.set(makeCellKey(cell.row, cell.col), cell)
    }

    // Mutation gateway: pre-resolve every write cell (display→source remap
    // plus protection gate); one unmappable or locked cell aborts the whole
    // fill before the first transport (fail-closed).
    const writes: Array<{ row: number; col: number; input: string }> = []
    for (let row = writeRange.rowStart; row <= writeRange.rowEnd; row += 1) {
      for (let col = writeRange.colStart; col <= writeRange.colEnd; col += 1) {
        const resolution = store.setter(resolveContentMutationAtom, {
          kind: 'fill-range',
          sheetId: intent.sheetId,
          cell: { row, col },
        })
        if (resolution.status === 'blocked' || resolution.cell === undefined) {
          return
        }
        const sourceCoord = getFillHandleSourceCoord(intent.sourceRange, { row, col })
        const sourceCell = sourceCells.get(makeCellKey(sourceCoord.row, sourceCoord.col))
        writes.push({
          row: resolution.cell.row,
          col: resolution.cell.col,
          input: getCellInputForFill(sourceCell, sourceCoord, { row, col }),
        })
      }
    }

    if (writes.length === 0) {
      return
    }

    const affectedRange = writes.reduce(
      (acc, write) => ({
        rowStart: Math.min(acc.rowStart, write.row),
        rowEnd: Math.max(acc.rowEnd, write.row),
        colStart: Math.min(acc.colStart, write.col),
        colEnd: Math.max(acc.colEnd, write.col),
      }),
      {
        rowStart: writes[0].row,
        rowEnd: writes[0].row,
        colStart: writes[0].col,
        colEnd: writes[0].col,
      },
    )

    if (backend.importCells) {
      // Batch port: ONE transport = ONE adapter transaction record = ONE
      // UI history entry, so undoing the entry reverts the whole fill and
      // the two undo stacks stay positionally aligned (same contract as
      // the batch paste path).
      const result = await backend.importCells({
        kind: 'import-cells',
        sheetId: intent.sheetId,
        cells: writes,
        range: affectedRange,
      })
      const revision =
        typeof result?.revision === 'number' ? result.revision : Number(result?.revision ?? 0) || 0
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'range.fill',
        sheetId: intent.sheetId,
        projectionRevision: revision,
        affectedRange: result?.affectedRange ? { ...result.affectedRange } : affectedRange,
      })
      return
    }

    // Fallback host without the batch port: keep the per-cell transport but
    // record one UI entry PER acknowledged write (N:N). Zero entries over N
    // per-cell mutations would leave the adapter transaction stack N records
    // deeper than the UI stack and bind later undos to the wrong snapshots.
    for (const write of writes) {
      const result = await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: intent.sheetId,
        row: write.row,
        col: write.col,
        input: write.input,
      })
      const revision =
        typeof result?.revision === 'number' ? result.revision : Number(result?.revision ?? 0) || 0
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'cell.set-input',
        sheetId: intent.sheetId,
        projectionRevision: revision,
        affectedRange: result?.affectedRange
          ? { ...result.affectedRange }
          : { rowStart: write.row, rowEnd: write.row, colStart: write.col, colEnd: write.col },
      })
    }
  }

  function isBoundedNumericSeriesSource(
    sourceRange: CellRange,
    direction: Exclude<PointerFillHandleCommitIntent['direction'], null>,
  ): boolean {
    if (sourceRange.rowStart > sourceRange.rowEnd || sourceRange.colStart > sourceRange.colEnd) {
      return false
    }

    if (direction === 'down' || direction === 'up') {
      return (
        sourceRange.colStart === sourceRange.colEnd &&
        sourceRange.rowEnd - sourceRange.rowStart + 1 >= 2
      )
    }

    return (
      sourceRange.rowStart === sourceRange.rowEnd &&
      sourceRange.colEnd - sourceRange.colStart + 1 >= 2
    )
  }

  function getOrderedSeriesSourceCells(
    projection: RangeProjectionResult,
    sourceRange: CellRange,
    direction: Exclude<PointerFillHandleCommitIntent['direction'], null>,
  ): DisplayCell[] | null {
    const expectedCellCount =
      direction === 'down' || direction === 'up'
        ? sourceRange.rowEnd - sourceRange.rowStart + 1
        : sourceRange.colEnd - sourceRange.colStart + 1
    if (projection.truncated === true || projection.cells.length !== expectedCellCount) {
      return null
    }

    const cellsByCoord = new Map<string, DisplayCell>()
    for (const cell of projection.cells) {
      if (
        !Number.isSafeInteger(cell.row) ||
        !Number.isSafeInteger(cell.col) ||
        !isCoordInRange(cell.row, cell.col, sourceRange)
      ) {
        return null
      }
      const key = makeCellKey(cell.row, cell.col)
      if (cellsByCoord.has(key)) return null
      cellsByCoord.set(key, cell)
    }

    const ordered: DisplayCell[] = []
    if (direction === 'down' || direction === 'up') {
      for (let row = sourceRange.rowStart; row <= sourceRange.rowEnd; row += 1) {
        const cell = cellsByCoord.get(makeCellKey(row, sourceRange.colStart))
        if (!cell) return null
        ordered.push(cell)
      }
    } else {
      for (let col = sourceRange.colStart; col <= sourceRange.colEnd; col += 1) {
        const cell = cellsByCoord.get(makeCellKey(sourceRange.rowStart, col))
        if (!cell) return null
        ordered.push(cell)
      }
    }

    return ordered
  }

  async function tryNumericFillSeries(
    intent: PointerFillHandleCommitIntent & {
      direction: Exclude<PointerFillHandleCommitIntent['direction'], null>
    },
  ): Promise<boolean> {
    if (
      intent.copyOnly === true ||
      !backend.fillSeries ||
      !isBoundedNumericSeriesSource(intent.sourceRange, intent.direction)
    ) {
      return false
    }

    let sourceProjection: RangeProjectionResult | null
    try {
      sourceProjection = await readRangeProjection(
        intent.sheetId,
        intent.sourceRange,
        'fill-handle',
      )
    } catch {
      return false
    }
    if (sourceProjection === null || sourceProjection.revision === undefined) return false

    const sourceCells = getOrderedSeriesSourceCells(
      sourceProjection,
      intent.sourceRange,
      intent.direction,
    )
    if (sourceCells === null) return false

    const detected = detectFillSeries(sourceCells, store.getter(fillSeriesLocaleAtom))
    if (
      (detected.kind !== 'integer-step' && detected.kind !== 'decimal-step') ||
      typeof detected.step !== 'number' ||
      !Number.isFinite(detected.step) ||
      detected.step === 0
    ) {
      return false
    }

    await backend.fillSeries({
      kind: 'fill-series',
      sheetId: intent.sheetId,
      sourceRange: intent.sourceRange,
      targetRange: intent.targetRange,
      direction: intent.direction,
      series: detected.kind,
      step: detected.step,
      requestId: sourceProjection.requestId,
      revision: sourceProjection.revision,
    })
    return true
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

    // Mutation gateway: the write range must clear the protection gate and
    // resolve to source rows before any transport (fail-closed). The fill
    // source only needs the remap answer — copying FROM locked cells is
    // allowed, so the lock gate is skipped for it.
    const writeResolution = store.setter(resolveContentMutationAtom, {
      kind: 'fill-range',
      sheetId: intent.sheetId,
      range: writeRange,
    })
    if (writeResolution.status === 'blocked') {
      return
    }
    const sourceResolution = store.setter(resolveContentMutationAtom, {
      kind: 'fill-range',
      sheetId: intent.sheetId,
      range: intent.sourceRange,
      protectionGate: false,
    })
    if (sourceResolution.status === 'blocked') {
      return
    }

    if (writeResolution.remapped || sourceResolution.remapped) {
      // Filter/sort permutes the affected rows: the contiguous
      // fillSeries/fillRange transports cannot express the write, so use
      // gateway-mapped per-cell writes instead.
      await fallbackFillHandle(intent, writeRange)
    } else {
      const filledSeries = await tryNumericFillSeries({ ...intent, direction: intent.direction })

      if (filledSeries) {
        // Numeric series is a single compact backend mutation.
      } else if (backend.fillRange) {
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
        ? (options.initialDraft ?? '')
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
    const cellCount = (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)

    // FILTER-hidden rows, read once and honoured by BOTH branches below.
    //
    // S7 hardened the context menu's copy and the `copy-as/` encoders, but
    // this function — the Ctrl+C / Ctrl+X path — was never wired, so its
    // small-range branch still expanded the raw row span. Guarding only the
    // large-range branch would have inverted the size-dependent fork rather
    // than removing it, so both are guarded here.
    const filterHiddenRows = new Set(
      getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), props.sheetId),
    )
    const originAddr = `${getColumnLabel(range.colStart)}${range.rowStart + 1}`

    let text: string
    let transferInput: ClipboardTransferInput

    if (cellCount > CLIPBOARD_CELL_LIMIT) {
      const requestId = store.setter(issueProjectionRequestIdAtom)
      if (requestId === null) {
        store.setter(setClipboardErrorAtom, {
          code: 'BACKEND_ERROR',
          message: 'Clipboard request identity space is exhausted.',
        })
        return
      }
      const streamRequest = {
        kind: 'export-range-tsv' as const,
        sheetId: props.sheetId,
        range,
        requestId,
        // FILTER subset only (§8.2) — the same set the small-range branch
        // below hands the encoders, so Ctrl+C produces the same rows either
        // side of CLIPBOARD_CELL_LIMIT.
        hiddenRows: filterHiddenRows,
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
      const result = await readRangeProjection(props.sheetId, range, 'clipboard')
      if (result === null) return

      const cells: string[][] = []
      const cellsByKey = new Map<string, (typeof result.cells)[number]>()
      for (const cell of result.cells) {
        cellsByKey.set(`${cell.row}:${cell.col}`, cell)
      }
      let firstEmittedRow = -1
      for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
        if (filterHiddenRows.has(row)) continue
        if (firstEmittedRow === -1) firstEmittedRow = row
        const fields: string[] = []
        for (let col = range.colStart; col <= range.colEnd; col += 1) {
          const cell = cellsByKey.get(`${row}:${col}`)
          fields.push(cell?.formula ?? cell?.displayValue ?? '')
        }
        cells.push(fields)
      }

      text = serializeClipboardTsv({
        // The marker anchors relative-formula shifting on paste, so it names
        // the first EMITTED row. Identical to `originAddr` whenever nothing
        // is filter-hidden.
        originAddr:
          firstEmittedRow === -1
            ? originAddr
            : `${getColumnLabel(range.colStart)}${firstEmittedRow + 1}`,
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
      store.setter(setClipboardErrorAtom, {
        code: 'BACKEND_ERROR',
        message: 'Clipboard write failed.',
      })
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
      store.setter(setClipboardErrorAtom, {
        code: 'BACKEND_ERROR',
        message: 'Clipboard read failed.',
      })
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

    // Mutation gateway: fail-closed remap + protection gate over the whole
    // paste target before any transport or clipboard-state change.
    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'paste-range',
      sheetId: props.sheetId,
      range: pasteRange,
    })
    if (resolution.status === 'blocked') {
      store.setter(setClipboardErrorAtom, {
        code: resolution.diagnostic.code,
        message: resolution.diagnostic.message,
      })
      return
    }

    store.setter(pasteClipboardAtom, {
      source: { sheetId: props.sheetId, range: sourceRange },
      target: { sheetId: props.sheetId, range: pasteRange },
      serialization: 'tab-separated',
      includesFormulas: plan.includesFormulas,
      estimatedBytes: plan.estimatedBytes,
    })

    // Pre-resolve each write cell so a mid-paste block can never leave a
    // partial write behind; the range resolution above makes this loop
    // deterministic (every cell is inside the allowed range).
    const writes: Array<{ row: number; col: number; input: string }> = []
    for (const chunk of plan.chunks()) {
      for (const cell of chunk.cells) {
        const cellResolution = store.setter(resolveContentMutationAtom, {
          kind: 'paste-range',
          sheetId: props.sheetId,
          cell: { row: cell.row, col: cell.col },
        })
        if (cellResolution.status === 'blocked' || cellResolution.cell === undefined) {
          store.setter(setClipboardErrorAtom, {
            code:
              cellResolution.status === 'blocked'
                ? cellResolution.diagnostic.code
                : 'MUTATION_INVALID_TARGET',
            message:
              cellResolution.status === 'blocked'
                ? cellResolution.diagnostic.message
                : 'Paste target cell could not be resolved.',
          })
          return
        }
        writes.push({
          row: cellResolution.cell.row,
          col: cellResolution.cell.col,
          input: cell.input,
        })
      }
    }

    const affectedRanges = resolution.ranges ?? [pasteRange]
    const affectedRange = affectedRanges.reduce(
      (acc, range) => ({
        rowStart: Math.min(acc.rowStart, range.rowStart),
        rowEnd: Math.max(acc.rowEnd, range.rowEnd),
        colStart: Math.min(acc.colStart, range.colStart),
        colEnd: Math.max(acc.colEnd, range.colEnd),
      }),
      { ...affectedRanges[0] },
    )

    if (writes.length > 0 && backend.importCells) {
      // Batch port: ONE transport = ONE adapter transaction record = ONE
      // UI history entry, so undoing the entry reverts the whole paste and
      // the two undo stacks stay positionally aligned.
      const result = await backend.importCells({
        kind: 'import-cells',
        sheetId: props.sheetId,
        cells: writes,
        range: affectedRange,
      })
      const revision =
        typeof result?.revision === 'number' ? result.revision : Number(result?.revision ?? 0) || 0
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'cells.import',
        sheetId: props.sheetId,
        projectionRevision: revision,
        affectedRange: result?.affectedRange ? { ...result.affectedRange } : affectedRange,
      })
    } else if (writes.length > 0) {
      // Fallback host without the batch port: keep the per-cell transport
      // but record one UI entry PER acknowledged write (N:N). A single
      // 'cells.import' entry over N per-cell mutations would leave the
      // adapter transaction stack N-1 records deeper than the UI stack.
      for (const write of writes) {
        const r = await backend.setCellInput({
          kind: 'set-cell-input',
          sheetId: props.sheetId,
          row: write.row,
          col: write.col,
          input: write.input,
        })
        const rev = typeof r?.revision === 'number' ? r.revision : Number(r?.revision ?? 0) || 0
        store.setter(pushHistoryAtom, {
          transactionId: nextHistoryTransactionId(),
          kind: 'cell.set-input',
          sheetId: props.sheetId,
          projectionRevision: rev,
          affectedRange: r?.affectedRange
            ? { ...r.affectedRange }
            : { rowStart: write.row, rowEnd: write.row, colStart: write.col, colEnd: write.col },
        })
      }
    }

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
    // Mutation gateway: display→source row remap (filter/sort) plus the
    // protection gate — locked cells on a protected sheet cannot be
    // reformatted. Blocked resolutions launch zero transport (fail-closed);
    // the gateway already recorded the diagnostic + lastBlock.
    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-format-range',
      sheetId,
      range,
    })
    if (resolution.status === 'blocked') {
      return
    }
    const sourceRanges = resolution.ranges ?? [range]
    const current = activeCellFormat()
    const nextFormat: SpreadsheetCellFormat = { ...current, [field]: !current[field] }

    // One UI history entry per setFormatRange transport (N:N): both
    // reference adapters record one undo transaction per call, so a single
    // entry over a split remap would leave the stacks positionally offset.
    for (const sourceRange of sourceRanges) {
      const result = await backend.setFormatRange({
        kind: 'set-format-range',
        sheetId,
        range: { ...sourceRange },
        format: nextFormat,
      })
      const revision =
        typeof result?.revision === 'number' ? result.revision : Number(result?.revision ?? 0) || 0
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'format.set',
        sheetId,
        projectionRevision: revision,
        affectedRange: { ...(result?.affectedRange ?? sourceRange) },
      })
    }

    await loadProjection(requestProjection())
  }

  async function handleGridKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) {
      return
    }
    // Skip when the keystroke is targetted at an input element (cell editor,
    // formula bar, name box). Those own their key handling; the grid only
    // intervenes for keystrokes that bubble from the grid root itself.
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'f' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      store.setter(openFindReplaceAtom)
      return
    }

    // Ctrl/Cmd+H opens the Find/Replace dialog (Excel parity). The dialog
    // remembers its last-active tab so users who want Replace will click
    // it once and subsequent Ctrl+H invocations land there.
    if ((event.ctrlKey || event.metaKey) && event.key === 'h' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      store.setter(openFindReplaceAtom)
      return
    }

    // Ctrl/Cmd+1 opens the Format Cells dialog on the active selection —
    // Excel's classic shortcut. Note: on macOS Chrome, Cmd+1 is intercepted
    // by the browser as "switch tab 1" so users have to use Ctrl+1 (which
    // works on Windows + Mac alike inside a non-fullscreen window).
    if ((event.ctrlKey || event.metaKey) && event.key === '1' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      const snapshot = store.getter(selectionSnapshotAtom)
      const sheetId = snapshot.selection.sheetId
      if (sheetId) {
        store.setter(openFormatCellsAtom, {
          sheetId,
          range: snapshot.range,
        })
      }
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

    // PageUp/PageDown (and Alt+PageUp/PageDown for horizontal paging) move by
    // the host-declared viewport window — `props.viewport.viewportWidth /
    // colWidth` rather than the measured rendered count. The grid's
    // `syncViewportSizeFromElement` will widen `metrics.viewportWidth` to the
    // browser-measured `clientWidth`, which would make `getCols().length`
    // depend on the actual browser size and break deterministic paging across
    // environments. The host's viewport prop is the contract for "one page";
    // the unit test (`vnext-grid.test.tsx` 'passes visible column count into
    // horizontal page keyboard movement') and the e2e
    // (`vnext-smoke.spec.ts:208` 'alt page keys move horizontally by the
    // visible column window') both rely on this prop-derived semantic.
    const pageRows = Math.max(
      1,
      Math.floor(props.viewport.viewportHeight / Math.max(1, props.viewport.rowHeight)),
    )
    const pageCols = Math.max(
      1,
      Math.floor(props.viewport.viewportWidth / Math.max(1, props.viewport.colWidth)),
    )
    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.isComposing,
      pageRowDelta: pageRows,
      pageColDelta: pageCols,
    })

    switch (intent.type) {
      case 'context-menu.open': {
        const input = getKeyboardContextMenuInput()
        if (!input) {
          return
        }
        const menu = store.setter(openMenuAtom, input)
        if (menu.status !== 'open') {
          return
        }
        event.preventDefault()
        bumpRender()
        return
      }
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
      case 'go-to.open':
        event.preventDefault()
        store.setter(openGoToAtom)
        return
      case 'clipboard.copy':
        event.preventDefault()
        await copySelectionToClipboard('copy')
        return
      case 'clipboard.copyAs': {
        event.preventDefault()
        const snap = selectionSnapshot()
        if (snap.selection.sheetId !== props.sheetId) {
          return
        }
        await dispatchCopyAs(store, backend, {
          sheetId: props.sheetId,
          range: snap.range,
        })
        return
      }
      case 'clipboard.copyAsImage': {
        // Ctrl+Shift+P → render the selection as a PNG and write to the
        // system clipboard. The dispatch installs a host-side SVG renderer
        // when the backend lacks `exportRangeAsImage`, falls back to
        // `lastCopyAsAtom` mirroring when `navigator.clipboard.write`
        // isn't available (Playwright headless without `clipboard-write`).
        event.preventDefault()
        const snap = selectionSnapshot()
        if (snap.selection.sheetId !== props.sheetId) {
          return
        }
        await dispatchCopyAsImage(store, backend, {
          sheetId: props.sheetId,
          range: snap.range,
        })
        return
      }
      case 'clipboard.cut':
        event.preventDefault()
        await copySelectionToClipboard('cut')
        return
      case 'clipboard.paste':
        event.preventDefault()
        await pasteFromClipboard()
        return
      case 'clipboard.pasteSpecial': {
        // Ctrl+Alt+V — open the Paste Special dialog. The keyboard
        // dispatcher in `spreadsheet-ui-core/src/keyboard` remains a
        // pure intent translator; capability + clipboard-readiness
        // gating belongs here at the host wiring layer. We skip
        // (without `preventDefault`) when:
        //   (a) the backend doesn't implement `pasteRange` — the menu
        //       entry is already hidden in that case, but the shortcut
        //       fires globally; opening an empty/broken dialog is worse
        //       than no-op.
        //   (b) the clipboard has no copyable payload — nothing to
        //       paste-special, so don't surface the dialog. Mirrors
        //       how Ctrl+V's `pasteFromClipboard` early-returns when
        //       the system clipboard is empty.
        if (!store.getter(pasteSpecialCapabilityAtom)) {
          return
        }
        const clipboard = store.getter(clipboardStateAtom)
        if (!clipboard.source || !clipboard.payload) {
          return
        }
        event.preventDefault()
        store.setter(openPasteSpecialAtom)
        return
      }
      case 'sheet.activate-adjacent': {
        event.preventDefault()
        const nextSheetId = getAdjacentSheetId(
          store.getter(sheetTabsSheetsAtom),
          store.getter(workspaceSessionAtom).activeSheetId,
          intent.direction,
        )
        if (nextSheetId) {
          store.setter(activateSheetTabAtom, { sheetId: nextSheetId })
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
        store.setter(exitFormulaReferenceAtom, intent.reason)
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
    const style: Record<string, string> = {
      width: `${getRenderedColumnWidth(col)}px`,
    }
    if (hasColOutline()) {
      // Keep the sticky column headers below the outline band.
      style.top = `${getColOutlineBandHeight()}px`
    }
    if (col < freezeColCount()) {
      const headingWidth = showHeadings() ? GRID_ROW_HEADER_WIDTH : 0
      const stackedLeft = col === 0 ? 0 : getColumnSpanWidth(0, col - 1)
      style.left = `${getRowOutlineGutterWidth() + headingWidth + stackedLeft}px`
    }
    return style
  }

  function getFrozenStickyStyle(row: number, col: number): Record<string, string> {
    const style: Record<string, string> = {}
    const frozenRows = freezeRowCount()
    const frozenCols = freezeColCount()
    if (frozenRows > 0 && row < frozenRows) {
      // Stack each frozen row below the column-header band so they line up
      // visually rather than overlapping the header (z-index 2 vs cell 1).
      const headingHeight = showHeadings() ? viewportMetrics().rowHeight : 0
      const stackedAbove = row === 0 ? 0 : getRowSpanHeight(0, row - 1)
      style.top = `${getColOutlineBandHeight() + headingHeight + stackedAbove}px`
    }
    if (frozenCols > 0 && col < frozenCols) {
      const headingWidth = showHeadings() ? GRID_ROW_HEADER_WIDTH : 0
      const stackedLeft = col === 0 ? 0 : getColumnSpanWidth(0, col - 1)
      style.left = `${getRowOutlineGutterWidth() + headingWidth + stackedLeft}px`
    }
    return style
  }

  function getCellBoxStyle(row: number, col: number): Record<string, string> {
    const backgroundStyle = getCellBackgroundStyle(getDisplayCellFormat(getCell(row, col)))
    const stickyStyle = getFrozenStickyStyle(row, col)
    const mergeRange = getMergeRangeForCoord(row, col)
    if (mergeRange && mergeRange.rowStart === row && mergeRange.colStart === col) {
      const rows = getRows().filter((index) => index >= row && index <= mergeRange.rowEnd)
      const cols = getCols().filter((index) => index >= col && index <= mergeRange.colEnd)
      const height = rows.reduce((sum, index) => sum + getRenderedRowHeight(index), 0)
      const width = cols.reduce((sum, index) => sum + getRenderedColumnWidth(index), 0)
      return {
        ...backgroundStyle,
        ...stickyStyle,
        height: `${Math.max(getRenderedRowHeight(row), height)}px`,
        width: `${Math.max(getRenderedColumnWidth(col), width)}px`,
      }
    }

    return {
      ...backgroundStyle,
      ...stickyStyle,
      height: `${getRenderedRowHeight(row)}px`,
      width: `${getRenderedColumnWidth(col)}px`,
    }
  }

  function getCellRowSpan(row: number, col: number) {
    const mergeRange = getMergeRangeForCoord(row, col)
    if (!mergeRange || mergeRange.rowStart !== row || mergeRange.colStart !== col) {
      return 1
    }

    return Math.max(
      1,
      getRows().filter((index) => index >= row && index <= mergeRange.rowEnd).length,
    )
  }

  function getCellColSpan(row: number, col: number) {
    const mergeRange = getMergeRangeForCoord(row, col)
    if (!mergeRange || mergeRange.rowStart !== row || mergeRange.colStart !== col) {
      return 1
    }

    return Math.max(
      1,
      getCols().filter((index) => index >= col && index <= mergeRange.colEnd).length,
    )
  }

  function getRowHeaderStyle(row: number): Record<string, string> {
    const style: Record<string, string> = {
      height: `${getRenderedRowHeight(row)}px`,
    }
    if (hasRowOutline()) {
      // Keep the sticky row headers to the right of the outline gutter.
      style.left = `${getRowOutlineGutterWidth()}px`
    }
    if (row < freezeRowCount()) {
      const headingHeight = showHeadings() ? viewportMetrics().rowHeight : 0
      const stackedAbove = row === 0 ? 0 : getRowSpanHeight(0, row - 1)
      style.top = `${getColOutlineBandHeight() + headingHeight + stackedAbove}px`
    }
    return style
  }

  function getCornerStyle(): Record<string, string> {
    const style: Record<string, string> = {}
    if (hasRowOutline()) style.left = `${getRowOutlineGutterWidth()}px`
    if (hasColOutline()) style.top = `${getColOutlineBandHeight()}px`
    return style
  }

  function getScrollViewportStyle(): Record<string, string> {
    const metrics = viewportMetrics()
    const headingHeight = showHeadings() ? metrics.rowHeight : 0
    return {
      width: '100%',
      height: `${metrics.viewportHeight + headingHeight + getColOutlineBandHeight()}px`,
    }
  }

  function getRowOverridesForSheet() {
    return store.getter(viewportSizeOverridesAtom).rowHeightsBySheet[props.sheetId]
  }

  function getColOverridesForSheet() {
    return store.getter(viewportSizeOverridesAtom).colWidthsBySheet[props.sheetId]
  }

  function getRowSpanHeight(start: number, end: number) {
    const metrics = viewportMetrics()
    return getAxisSpanSize(
      start,
      end,
      metrics.rowCount,
      metrics.rowHeight,
      getRowOverridesForSheet(),
      getHiddenRowSet(),
    )
  }

  function getColumnSpanWidth(start: number, end: number) {
    const metrics = viewportMetrics()
    return getAxisSpanSize(
      start,
      end,
      metrics.colCount,
      metrics.colWidth,
      getColOverridesForSheet(),
      getHiddenColSet(),
    )
  }

  function getTotalTableWidth() {
    const metrics = viewportMetrics()
    const headingWidth = showHeadings() ? GRID_ROW_HEADER_WIDTH : 0
    return getRowOutlineGutterWidth() + headingWidth + getColumnSpanWidth(0, metrics.colCount - 1)
  }

  function getTopSpacerHeight() {
    const window = visibleWindow()
    return getRowSpanHeight(0, window.rowStart - 1)
  }

  function getBottomSpacerHeight() {
    const window = visibleWindow()
    const metrics = viewportMetrics()
    return getRowSpanHeight(window.rowEnd + 1, metrics.rowCount - 1)
  }

  function getLeftSpacerWidth() {
    const window = visibleWindow()
    return getColumnSpanWidth(0, window.colStart - 1)
  }

  function getRightSpacerWidth() {
    const window = visibleWindow()
    const metrics = viewportMetrics()
    return getColumnSpanWidth(window.colEnd + 1, metrics.colCount - 1)
  }

  function getVirtualColumnSpan() {
    return (
      (hasRowOutline() ? 1 : 0) +
      (showHeadings() ? 1 : 0) +
      getCols().length +
      (getLeftSpacerWidth() > 0 ? 1 : 0) +
      (getRightSpacerWidth() > 0 ? 1 : 0)
    )
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
      copyOnly: event.ctrlKey || event.metaKey,
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
        copyOnly: moveEvent.ctrlKey || moveEvent.metaKey,
      })
      bumpRender()
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      store.setter(updatePointerAtom, {
        kind: 'fill-handle',
        copyOnly: upEvent.ctrlKey || upEvent.metaKey,
      })
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
    return store.getter(presenceStateAtom).participants.find((p) => p.id === participantId)
      ?.colorHint
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

  function getOverlayCellRect(
    row: number,
    col: number,
  ): { x: number; y: number; w: number; h: number } | null {
    if (!gridRoot || !scrollRoot) return null
    const td = gridRoot.querySelector(
      `td.spreadsheet-grid-cell[data-row="${row}"][data-col="${col}"]`,
    ) as HTMLElement | null
    if (td) {
      const rootRect = scrollRoot.getBoundingClientRect()
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
      const rootRect = scrollRoot.getBoundingClientRect()
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
    if (!rows.includes(row) || !cols.includes(col)) return null
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
    if (!scrollRoot) return { width: 0, height: 0 }
    const rect = scrollRoot.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  function getOverlayCells(): readonly DisplayCell[] {
    return projectionSnapshot().result?.cells ?? []
  }

  function getOverlayFreezeOrigin(): { x: number; y: number } {
    if (!gridRoot || !scrollRoot) return { x: 0, y: 0 }
    const corner = gridRoot.querySelector('.spreadsheet-grid-corner') as HTMLElement | null
    if (!corner) return { x: 0, y: 0 }
    const cornerRect = corner.getBoundingClientRect()
    const rootRect = scrollRoot.getBoundingClientRect()
    return {
      x: cornerRect.right - rootRect.left,
      y: cornerRect.bottom - rootRect.top,
    }
  }

  function getRemoteCursorStyle(
    cursor: ReturnType<typeof getRemoteCursorsForSheet>[number],
  ): Record<string, string> {
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

  function renderOutlineSlots(axis: OutlineAxis, index: number) {
    return (
      <span class="spreadsheet-outline-slots" data-axis={axis}>
        <For each={getOutlineLevelSlots(axis)}>
          {(level) => {
            const toggle = () => getOutlineToggleAt(axis, index, level)
            return (
              <span class="spreadsheet-outline-slot">
                <Show
                  when={toggle()}
                  fallback={
                    <Show when={outlineSlotHasLine(axis, index, level)}>
                      <span class="spreadsheet-outline-line" aria-hidden="true" />
                    </Show>
                  }
                >
                  {(group) => (
                    <button
                      type="button"
                      class="spreadsheet-outline-toggle"
                      data-testid={`outline-${axis === 'row' ? 'row' : 'col'}-toggle-${
                        group().start
                      }-${group().end}`}
                      data-collapsed={group().collapsed ? 'true' : 'false'}
                      aria-expanded={group().collapsed ? 'false' : 'true'}
                      aria-label={`${group().collapsed ? 'Expand' : 'Collapse'} ${
                        axis === 'row' ? 'rows' : 'columns'
                      } ${group().start + 1}-${group().end + 1}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleOutlineGroup(axis, group())
                      }}
                    >
                      {group().collapsed ? '+' : '−'}
                    </button>
                  )}
                </Show>
              </span>
            )
          }}
        </For>
      </span>
    )
  }

  function renderOutlineLevelButtons(axis: OutlineAxis) {
    return (
      <For each={getOutlineLevelButtons(axis)}>
        {(level) => (
          <button
            type="button"
            class="spreadsheet-outline-level-button"
            data-testid={`outline-${axis === 'row' ? 'row' : 'col'}-level-${level}`}
            aria-label={`Show ${axis === 'row' ? 'row' : 'column'} outline level ${level}`}
            onClick={(event) => {
              event.stopPropagation()
              collapseOutlineLevel(axis, level)
            }}
          >
            {level}
          </button>
        )}
      </For>
    )
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
      <div
        ref={scrollRoot}
        class="spreadsheet-grid-scroll-viewport"
        style={getScrollViewportStyle()}
        onScroll={handleViewportScroll}
      >
        <table
          class="spreadsheet-grid-table"
          style={{
            width: `${getTotalTableWidth()}px`,
            'min-width': `${getTotalTableWidth()}px`,
          }}
        >
          <tbody>
            <Show when={getRows().length > 0 && getCols().length > 0}>
              <Show when={hasColOutline()}>
                <tr class="spreadsheet-grid-outline-col-row" data-testid="outline-col-band">
                  <Show when={hasRowOutline() || showHeadings()}>
                    <th
                      class="spreadsheet-grid-outline-corner"
                      data-testid="outline-col-levels"
                      colSpan={(hasRowOutline() ? 1 : 0) + (showHeadings() ? 1 : 0)}
                      style={{ height: `${getColOutlineBandHeight()}px` }}
                    >
                      {renderOutlineLevelButtons('column')}
                    </th>
                  </Show>
                  <Show when={getLeftSpacerWidth() > 0}>
                    <th
                      class="spreadsheet-grid-virtual-spacer"
                      aria-hidden="true"
                      style={{ width: `${getLeftSpacerWidth()}px` }}
                    />
                  </Show>
                  <For each={getCols()}>
                    {(col) => (
                      <th
                        class="spreadsheet-grid-outline-col-cell"
                        data-outline-col={col}
                        style={{ height: `${getColOutlineBandHeight()}px` }}
                      >
                        {renderOutlineSlots('column', col)}
                      </th>
                    )}
                  </For>
                  <Show when={getRightSpacerWidth() > 0}>
                    <th
                      class="spreadsheet-grid-virtual-spacer"
                      aria-hidden="true"
                      style={{ width: `${getRightSpacerWidth()}px` }}
                    />
                  </Show>
                </tr>
              </Show>
              <Show when={showHeadings()}>
                <tr>
                  <Show when={hasRowOutline()}>
                    <th
                      class="spreadsheet-grid-outline-header"
                      data-testid="outline-row-levels"
                      style={{
                        width: `${getRowOutlineGutterWidth()}px`,
                        ...(hasColOutline() ? { top: `${getColOutlineBandHeight()}px` } : {}),
                      }}
                    >
                      {renderOutlineLevelButtons('row')}
                    </th>
                  </Show>
                  <th
                    class="spreadsheet-grid-corner"
                    style={getCornerStyle()}
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
                  <Show when={getLeftSpacerWidth() > 0}>
                    <th
                      class="spreadsheet-grid-virtual-spacer"
                      aria-hidden="true"
                      style={{ width: `${getLeftSpacerWidth()}px` }}
                    />
                  </Show>
                  <For each={getCols()}>
                    {(col) => {
                      const selected = () => isColumnSelected(col)

                      return (
                        <th
                          class={`spreadsheet-grid-col-header ${selected() ? 'is-selected' : ''}`.trim()}
                          data-col={col}
                          data-selected={selected() ? 'true' : 'false'}
                          data-frozen-col={col < freezeColCount() ? 'true' : undefined}
                          data-freeze-boundary-right={
                            freezeColCount() > 0 && col === freezeColCount() - 1
                              ? 'true'
                              : undefined
                          }
                          style={getColumnStyle(col)}
                          onClick={(event) => {
                            selectColumn(col, event.shiftKey, event.ctrlKey || event.metaKey)
                          }}
                          onContextMenu={(event) => {
                            openContextMenu(event, { kind: 'column', col })
                          }}
                        >
                          <span class="spreadsheet-grid-header-label">{getColumnLabel(col)}</span>
                          {/* Filter is the only persistent column view fact — a
                          physical sort (#29/#24) leaves no per-column state. */}
                          <Show when={colHasFilterRule(col)}>
                            <button
                              type="button"
                              class="spreadsheet-grid-filter-chevron"
                              data-testid={`filter-chevron-${col}`}
                              aria-label={`Filter column ${getColumnLabel(col)}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                store.setter(openFilterDropdownAtom, {
                                  sheetId: props.sheetId,
                                  colIndex: col,
                                })
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
                  <Show when={getRightSpacerWidth() > 0}>
                    <th
                      class="spreadsheet-grid-virtual-spacer"
                      aria-hidden="true"
                      style={{ width: `${getRightSpacerWidth()}px` }}
                    />
                  </Show>
                </tr>
              </Show>
              <Show when={getTopSpacerHeight() > 0}>
                <tr class="spreadsheet-grid-virtual-spacer-row" aria-hidden="true">
                  <td
                    class="spreadsheet-grid-virtual-spacer"
                    colSpan={getVirtualColumnSpan()}
                    style={{ height: `${getTopSpacerHeight()}px` }}
                  />
                </tr>
              </Show>
              <For each={getRows()}>
                {(row) => (
                  <tr class="spreadsheet-grid-row">
                    <Show when={hasRowOutline()}>
                      <th
                        class="spreadsheet-grid-outline-row-cell"
                        data-outline-row={row}
                        style={{
                          width: `${getRowOutlineGutterWidth()}px`,
                          height: `${getRenderedRowHeight(row)}px`,
                        }}
                      >
                        {renderOutlineSlots('row', row)}
                      </th>
                    </Show>
                    <Show when={showHeadings()}>
                      <th
                        class={`spreadsheet-grid-row-header ${
                          isRowSelected(row) ? 'is-selected' : ''
                        }`.trim()}
                        data-row={row}
                        data-selected={isRowSelected(row) ? 'true' : 'false'}
                        data-frozen-row={row < freezeRowCount() ? 'true' : undefined}
                        data-freeze-boundary-bottom={
                          freezeRowCount() > 0 && row === freezeRowCount() - 1 ? 'true' : undefined
                        }
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
                    <Show when={getLeftSpacerWidth() > 0}>
                      <td
                        class="spreadsheet-grid-virtual-spacer"
                        aria-hidden="true"
                        style={{ width: `${getLeftSpacerWidth()}px` }}
                      />
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
                              } ${active() ? 'cell-active' : ''} ${
                                isFillPreviewCell(row, col) ? 'cell-fill-preview' : ''
                              } ${mergeAnchor() ? 'cell-merge-anchor' : ''} ${
                                validationSeverity()
                                  ? `cell-validation-${validationSeverity()}`
                                  : ''
                              } ${cell()?.valueKind ? `kind-${cell()?.valueKind}` : ''}`.trim()}
                              data-row={row}
                              data-col={col}
                              data-cell-addr={addr}
                              data-frozen-row={row < freezeRowCount() ? 'true' : undefined}
                              data-frozen-col={col < freezeColCount() ? 'true' : undefined}
                              data-freeze-boundary-bottom={
                                freezeRowCount() > 0 && row === freezeRowCount() - 1
                                  ? 'true'
                                  : undefined
                              }
                              data-freeze-boundary-right={
                                freezeColCount() > 0 && col === freezeColCount() - 1
                                  ? 'true'
                                  : undefined
                              }
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
                              data-borders={getCellBordersAttr(cell())}
                              // a11y: a bare <td> maps to role="cell", which
                              // does not support aria-selected (axe
                              // `aria-allowed-attr`, critical — one node per
                              // visible cell). role="gridcell" is both the
                              // semantically correct role for a spreadsheet
                              // cell and the role that legitimises
                              // aria-selected. Parent chain already supplies
                              // row (<tr>) / rowgroup (<tbody>) / table.
                              role="gridcell"
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
                                // inserts an A1 ref into the current draft; a
                                // drag expands the pick to a range like B2:E2.
                                // Selection is NOT mutated — pick re-focuses
                                // the editing input on release.
                                if (store.getter(formulaReferenceSessionAtom)) {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  startFormulaReferenceDragPick(event, row, col)
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
                              <SpreadsheetCellBorders borders={cell()?.format?.borders} />
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
                                    //
                                    // Skip when the editing session is owned by
                                    // the formula bar — otherwise the cell-input
                                    // mount on every draft change would steal
                                    // focus away from the formula bar input.
                                    if (el) {
                                      queueMicrotask(() => {
                                        const session = store.getter(editingSessionAtom)
                                        const ownedByFormulaBar =
                                          session.status === 'drafting' &&
                                          session.source?.source === 'formula-bar'
                                        if (ownedByFormulaBar) return
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
                                    notifyDraftTypedChar(
                                      store,
                                      event.currentTarget.selectionStart ??
                                        event.currentTarget.value.length,
                                    )
                                    bumpRender()
                                  }}
                                  onSelect={(event) => {
                                    syncFormulaReferenceCaret(
                                      store,
                                      event.currentTarget.selectionStart ?? 0,
                                    )
                                  }}
                                  onKeyUp={(event) => {
                                    // ArrowLeft/Right/Home/End move the caret
                                    // without firing onSelect. Re-sync so the
                                    // signature tooltip + autocomplete fragment
                                    // recompute against the new caret position.
                                    if (
                                      event.key === 'ArrowLeft' ||
                                      event.key === 'ArrowRight' ||
                                      event.key === 'Home' ||
                                      event.key === 'End'
                                    ) {
                                      syncFormulaReferenceCaret(
                                        store,
                                        event.currentTarget.selectionStart ?? 0,
                                      )
                                    }
                                  }}
                                  onKeyDown={(event) => {
                                    // Autocomplete first: ArrowUp/Down move
                                    // the dropdown cursor, Tab/Enter accept,
                                    // Esc dismisses without ending editing.
                                    const suggestionsOpen =
                                      store.getter(formulaFunctionSuggestionsAtom).length > 0
                                    if (suggestionsOpen) {
                                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                        event.preventDefault()
                                        const list = store.getter(formulaFunctionSuggestionsAtom)
                                        const current = store.getter(
                                          formulaFunctionSuggestionCursorAtom,
                                        )
                                        const next =
                                          event.key === 'ArrowDown'
                                            ? (current + 1) % list.length
                                            : (current - 1 + list.length) % list.length
                                        store.setter(formulaFunctionSuggestionCursorAtom, next)
                                        bumpRender()
                                        return
                                      }
                                      if (event.key === 'Tab' || event.key === 'Enter') {
                                        const suggestion = readActiveFormulaSuggestion(store)
                                        if (suggestion) {
                                          event.preventDefault()
                                          const inputEl = event.currentTarget
                                          const { caret } = acceptFormulaSuggestion(
                                            store,
                                            suggestion,
                                          )
                                          // Solid swaps the input's value on the
                                          // next reactive tick; defer caret
                                          // placement so it lands on the post-
                                          // splice value. Capture the input
                                          // synchronously — event.currentTarget
                                          // is reset to null once the handler
                                          // returns.
                                          queueMicrotask(() => {
                                            inputEl.focus()
                                            inputEl.setSelectionRange(caret, caret)
                                          })
                                          bumpRender()
                                          return
                                        }
                                      }
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        store.setter(dismissFormulaSuggestionsAtom)
                                        store.setter(formulaFunctionSuggestionCursorAtom, 0)
                                        bumpRender()
                                        return
                                      }
                                    }
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
                    <Show when={getRightSpacerWidth() > 0}>
                      <td
                        class="spreadsheet-grid-virtual-spacer"
                        aria-hidden="true"
                        style={{ width: `${getRightSpacerWidth()}px` }}
                      />
                    </Show>
                  </tr>
                )}
              </For>
              <Show when={getBottomSpacerHeight() > 0}>
                <tr class="spreadsheet-grid-virtual-spacer-row" aria-hidden="true">
                  <td
                    class="spreadsheet-grid-virtual-spacer"
                    colSpan={getVirtualColumnSpan()}
                    style={{ height: `${getBottomSpacerHeight()}px` }}
                  />
                </tr>
              </Show>
            </Show>
          </tbody>
        </table>
      </div>
      <Show when={freezeRowCount() > 0 || freezeColCount() > 0}>
        <svg
          class="spreadsheet-grid-freeze-boundary"
          aria-hidden="true"
          data-testid="freeze-boundary"
          width="100%"
          height="100%"
        >
          <Show when={freezeRowCount() > 0}>
            <line
              data-testid="freeze-boundary-horizontal"
              x1={0}
              x2="100%"
              y1={getFreezeBoundaryY()}
              y2={getFreezeBoundaryY()}
            />
          </Show>
          <Show when={freezeColCount() > 0}>
            <line
              data-testid="freeze-boundary-vertical"
              x1={getFreezeBoundaryX()}
              x2={getFreezeBoundaryX()}
              y1={0}
              y2="100%"
            />
          </Show>
        </svg>
      </Show>
      <div class="spreadsheet-grid-overlay-layer" aria-hidden="true">
        <Show
          when={useSvgOverlayEnabled()}
          fallback={
            <SpreadsheetGridOverlay
              sheetId={props.sheetId}
              getCellRect={getOverlayCellRect}
              getSurfaceSize={getOverlaySurfaceSize}
              getCells={getOverlayCells}
              getFreezeOrigin={getOverlayFreezeOrigin}
              getVisibleRows={getRows}
              getVisibleCols={getCols}
            />
          }
        >
          <SpreadsheetGridOverlaySvg
            sheetId={props.sheetId}
            getCellRect={getOverlayCellRect}
            getSurfaceSize={getOverlaySurfaceSize}
            getCells={getOverlayCells}
            getFreezeOrigin={getOverlayFreezeOrigin}
            getVisibleRows={getRows}
            getVisibleCols={getCols}
          />
        </Show>
      </div>
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
