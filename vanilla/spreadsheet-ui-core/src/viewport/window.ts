import { atom } from '@einfach/core'
import type { CellCoord } from '../shared'
import type {
  CellViewportRect,
  FrozenWindows,
  ScrollToCellInput,
  SetViewportFreezeInput,
  SetViewportHiddenInput,
  ViewportCellAlign,
  ViewportFreezeState,
  ViewportHiddenState,
  ViewportMetrics,
  ViewportScrollPosition,
  ViewportSizeOverrideState,
  VisibleWindow,
  SetViewportColumnWidthInput,
  SetViewportRowHeightInput,
} from './types'

export const DEFAULT_VIEWPORT_METRICS: ViewportMetrics = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 0,
  viewportWidth: 0,
  rowHeight: 24,
  colWidth: 96,
  rowCount: 0,
  colCount: 0,
  overscanRows: 2,
  overscanCols: 2,
}

export const MIN_VIEWPORT_ROW_HEIGHT = 16
export const MAX_VIEWPORT_ROW_HEIGHT = 512
export const MIN_VIEWPORT_COL_WIDTH = 40
export const MAX_VIEWPORT_COL_WIDTH = 1024

export const DEFAULT_VIEWPORT_SIZE_OVERRIDES: ViewportSizeOverrideState = {
  rowHeightsBySheet: {},
  colWidthsBySheet: {},
}

function clampIndex(value: number, maxExclusive: number) {
  if (maxExclusive <= 0) {
    return 0
  }
  if (value < 0) {
    return 0
  }
  if (value >= maxExclusive) {
    return maxExclusive - 1
  }
  return value
}

function normalizeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return value
}

function normalizeCount(value: number): number {
  return Math.max(0, Math.trunc(normalizeNumber(value, 0)))
}

function normalizePositive(value: number, fallback: number): number {
  return Math.max(1, normalizeNumber(value, fallback))
}

function normalizeDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.max(min, Math.min(max, Math.round(value)))
}

function normalizeRowHeight(value: number): number {
  return normalizeDimension(value, MIN_VIEWPORT_ROW_HEIGHT, MAX_VIEWPORT_ROW_HEIGHT)
}

function normalizeColWidth(value: number): number {
  return normalizeDimension(value, MIN_VIEWPORT_COL_WIDTH, MAX_VIEWPORT_COL_WIDTH)
}

function normalizeFallbackDimension(value: number, fallback: number): number {
  return Math.max(1, Math.round(normalizeNumber(value, fallback)))
}

function normalizeFallbackRowHeight(value: number): number {
  return normalizeFallbackDimension(value, DEFAULT_VIEWPORT_METRICS.rowHeight)
}

function normalizeFallbackColWidth(value: number): number {
  return normalizeFallbackDimension(value, DEFAULT_VIEWPORT_METRICS.colWidth)
}

function normalizeSparseIndex(value: number): number | null {
  if (!Number.isInteger(value) || value < 0) {
    return null
  }

  return value
}

function normalizeOverscan(value: number): number {
  return Math.max(0, Math.trunc(normalizeNumber(value, 0)))
}

function clampOffset(value: number, max: number): number {
  return Math.max(0, Math.min(normalizeNumber(value, 0), Math.max(0, max)))
}

export function normalizeViewportMetrics(metrics: ViewportMetrics): ViewportMetrics {
  const rowHeight = normalizePositive(metrics.rowHeight, DEFAULT_VIEWPORT_METRICS.rowHeight)
  const colWidth = normalizePositive(metrics.colWidth, DEFAULT_VIEWPORT_METRICS.colWidth)
  const rowCount = normalizeCount(metrics.rowCount)
  const colCount = normalizeCount(metrics.colCount)
  const viewportHeight = Math.max(0, normalizeNumber(metrics.viewportHeight, 0))
  const viewportWidth = Math.max(0, normalizeNumber(metrics.viewportWidth, 0))

  return {
    scrollTop: clampOffset(metrics.scrollTop, rowCount * rowHeight - viewportHeight),
    scrollLeft: clampOffset(metrics.scrollLeft, colCount * colWidth - viewportWidth),
    viewportHeight,
    viewportWidth,
    rowHeight,
    colWidth,
    rowCount,
    colCount,
    overscanRows: normalizeOverscan(metrics.overscanRows),
    overscanCols: normalizeOverscan(metrics.overscanCols),
  }
}

export function getVisibleWindow(metrics: ViewportMetrics): VisibleWindow {
  const normalizedMetrics = normalizeViewportMetrics(metrics)
  const rowHeight = normalizedMetrics.rowHeight
  const colWidth = normalizedMetrics.colWidth
  const rowCount = normalizedMetrics.rowCount
  const colCount = normalizedMetrics.colCount

  if (rowCount === 0 || colCount === 0) {
    return {
      rowStart: 0,
      rowEnd: -1,
      colStart: 0,
      colEnd: -1,
    }
  }

  const rawRowStart = Math.floor(normalizedMetrics.scrollTop / rowHeight)
  const rawColStart = Math.floor(normalizedMetrics.scrollLeft / colWidth)
  const visibleRows = Math.ceil(normalizedMetrics.viewportHeight / rowHeight)
  const visibleCols = Math.ceil(normalizedMetrics.viewportWidth / colWidth)

  const rowStart = clampIndex(rawRowStart - normalizedMetrics.overscanRows, rowCount)
  const colStart = clampIndex(rawColStart - normalizedMetrics.overscanCols, colCount)
  const rowEnd = clampIndex(
    rawRowStart + Math.max(1, visibleRows) + normalizedMetrics.overscanRows - 1,
    rowCount,
  )
  const colEnd = clampIndex(
    rawColStart + Math.max(1, visibleCols) + normalizedMetrics.overscanCols - 1,
    colCount,
  )

  return {
    rowStart,
    rowEnd,
    colStart,
    colEnd,
  }
}

export function isCellInVisibleWindow(coord: CellCoord, visibleWindow: VisibleWindow): boolean {
  return (
    visibleWindow.rowStart <= visibleWindow.rowEnd &&
    visibleWindow.colStart <= visibleWindow.colEnd &&
    coord.row >= visibleWindow.rowStart &&
    coord.row <= visibleWindow.rowEnd &&
    coord.col >= visibleWindow.colStart &&
    coord.col <= visibleWindow.colEnd
  )
}

export function getCellViewportRect(
  coord: CellCoord,
  metrics: ViewportMetrics,
): CellViewportRect {
  const normalizedMetrics = normalizeViewportMetrics(metrics)
  const row = clampIndex(coord.row, normalizedMetrics.rowCount)
  const col = clampIndex(coord.col, normalizedMetrics.colCount)

  return {
    row,
    col,
    top: row * normalizedMetrics.rowHeight - normalizedMetrics.scrollTop,
    left: col * normalizedMetrics.colWidth - normalizedMetrics.scrollLeft,
    height: normalizedMetrics.rowHeight,
    width: normalizedMetrics.colWidth,
  }
}

export function getViewportScrollForCell(
  metrics: ViewportMetrics,
  input: ScrollToCellInput,
): ViewportScrollPosition {
  const normalizedMetrics = normalizeViewportMetrics(metrics)
  const row = clampIndex(input.coord.row, normalizedMetrics.rowCount)
  const col = clampIndex(input.coord.col, normalizedMetrics.colCount)
  const cellTop = row * normalizedMetrics.rowHeight
  const cellLeft = col * normalizedMetrics.colWidth
  const maxScrollTop = normalizedMetrics.rowCount * normalizedMetrics.rowHeight
  const maxScrollLeft = normalizedMetrics.colCount * normalizedMetrics.colWidth

  return {
    scrollTop: getAlignedScrollOffset({
      align: input.rowAlign ?? 'nearest',
      current: normalizedMetrics.scrollTop,
      viewportSize: normalizedMetrics.viewportHeight,
      cellStart: cellTop,
      cellSize: normalizedMetrics.rowHeight,
      totalSize: maxScrollTop,
    }),
    scrollLeft: getAlignedScrollOffset({
      align: input.colAlign ?? 'nearest',
      current: normalizedMetrics.scrollLeft,
      viewportSize: normalizedMetrics.viewportWidth,
      cellStart: cellLeft,
      cellSize: normalizedMetrics.colWidth,
      totalSize: maxScrollLeft,
    }),
  }
}

export function getViewportRowHeight(
  state: ViewportSizeOverrideState,
  sheetId: string,
  rowIndex: number,
  fallback: number,
): number {
  const row = normalizeSparseIndex(rowIndex)
  if (row === null) {
    return normalizeFallbackRowHeight(fallback)
  }

  return state.rowHeightsBySheet[sheetId]?.[String(row)] ?? normalizeFallbackRowHeight(fallback)
}

export function getViewportColumnWidth(
  state: ViewportSizeOverrideState,
  sheetId: string,
  colIndex: number,
  fallback: number,
): number {
  const col = normalizeSparseIndex(colIndex)
  if (col === null) {
    return normalizeFallbackColWidth(fallback)
  }

  return state.colWidthsBySheet[sheetId]?.[String(col)] ?? normalizeFallbackColWidth(fallback)
}

export function setViewportRowHeight(
  state: ViewportSizeOverrideState,
  input: SetViewportRowHeightInput,
): ViewportSizeOverrideState {
  const row = normalizeSparseIndex(input.rowIndex)
  if (row === null || input.sheetId.length === 0) {
    return state
  }

  const sheetRows = state.rowHeightsBySheet[input.sheetId] ?? {}
  return {
    ...state,
    rowHeightsBySheet: {
      ...state.rowHeightsBySheet,
      [input.sheetId]: {
        ...sheetRows,
        [String(row)]: normalizeRowHeight(input.heightPx),
      },
    },
  }
}

export function setViewportColumnWidth(
  state: ViewportSizeOverrideState,
  input: SetViewportColumnWidthInput,
): ViewportSizeOverrideState {
  const col = normalizeSparseIndex(input.colIndex)
  if (col === null || input.sheetId.length === 0) {
    return state
  }

  const sheetCols = state.colWidthsBySheet[input.sheetId] ?? {}
  return {
    ...state,
    colWidthsBySheet: {
      ...state.colWidthsBySheet,
      [input.sheetId]: {
        ...sheetCols,
        [String(col)]: normalizeColWidth(input.widthPx),
      },
    },
  }
}

export const viewportMetricsAtom = atom<ViewportMetrics>(DEFAULT_VIEWPORT_METRICS)
viewportMetricsAtom.debugLabel = 'spreadsheet.viewport.metrics'

export const viewportSizeOverridesAtom = atom<ViewportSizeOverrideState>(
  DEFAULT_VIEWPORT_SIZE_OVERRIDES,
)
viewportSizeOverridesAtom.debugLabel = 'spreadsheet.viewport.sizeOverrides'

export const visibleWindowAtom = atom((get): VisibleWindow => {
  return getVisibleWindow(get(viewportMetricsAtom))
})
visibleWindowAtom.debugLabel = 'spreadsheet.viewport.visibleWindow'

export const setViewportMetricsAtom = atom(
  (get) => get(viewportMetricsAtom),
  (_get, set, metrics: ViewportMetrics) => {
    set(viewportMetricsAtom, normalizeViewportMetrics(metrics))
  },
)
setViewportMetricsAtom.debugLabel = 'spreadsheet.viewport.setMetrics'

export const scrollToCellAtom = atom(
  (get) => get(viewportMetricsAtom),
  (get, set, input: ScrollToCellInput): ViewportScrollPosition => {
    const metrics = get(viewportMetricsAtom)
    const scrollPosition = getViewportScrollForCell(metrics, input)

    set(viewportMetricsAtom, {
      ...metrics,
      ...scrollPosition,
    })

    return scrollPosition
  },
)
scrollToCellAtom.debugLabel = 'spreadsheet.viewport.scrollToCell'

export const setViewportRowHeightAtom = atom(
  (get) => get(viewportSizeOverridesAtom),
  (get, set, input: SetViewportRowHeightInput): ViewportSizeOverrideState => {
    const nextState = setViewportRowHeight(get(viewportSizeOverridesAtom), input)
    set(viewportSizeOverridesAtom, nextState)
    return nextState
  },
)
setViewportRowHeightAtom.debugLabel = 'spreadsheet.viewport.setRowHeight'

export const setViewportColumnWidthAtom = atom(
  (get) => get(viewportSizeOverridesAtom),
  (get, set, input: SetViewportColumnWidthInput): ViewportSizeOverrideState => {
    const nextState = setViewportColumnWidth(get(viewportSizeOverridesAtom), input)
    set(viewportSizeOverridesAtom, nextState)
    return nextState
  },
)
setViewportColumnWidthAtom.debugLabel = 'spreadsheet.viewport.setColumnWidth'

export const DEFAULT_VIEWPORT_FREEZE_STATE: ViewportFreezeState = {
  rowsBySheet: {},
  colsBySheet: {},
}

export const viewportFreezeAtom = atom<ViewportFreezeState>(DEFAULT_VIEWPORT_FREEZE_STATE)
viewportFreezeAtom.debugLabel = 'spreadsheet.viewport.freeze'

export const setViewportFreezeAtom = atom(
  (get) => get(viewportFreezeAtom),
  (get, set, input: SetViewportFreezeInput) => {
    if (!input.sheetId || input.sheetId.length === 0) return
    const state = get(viewportFreezeAtom)
    const rows =
      input.rows !== undefined
        ? Math.max(0, Math.trunc(normalizeNumber(input.rows, 0)))
        : (state.rowsBySheet[input.sheetId] ?? 0)
    const cols =
      input.cols !== undefined
        ? Math.max(0, Math.trunc(normalizeNumber(input.cols, 0)))
        : (state.colsBySheet[input.sheetId] ?? 0)
    set(viewportFreezeAtom, {
      rowsBySheet: { ...state.rowsBySheet, [input.sheetId]: rows },
      colsBySheet: { ...state.colsBySheet, [input.sheetId]: cols },
    })
  },
)
setViewportFreezeAtom.debugLabel = 'spreadsheet.viewport.setFreeze'

export const DEFAULT_VIEWPORT_HIDDEN_STATE: ViewportHiddenState = {
  rowsBySheet: {},
  colsBySheet: {},
}

function sanitizeIndices(indices: number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const v of indices) {
    if (Number.isInteger(v) && v >= 0 && !seen.has(v)) {
      seen.add(v)
      result.push(v)
    }
  }
  result.sort((a, b) => a - b)
  return result
}

export function isRowHidden(state: ViewportHiddenState, sheetId: string, rowIndex: number): boolean {
  return (state.rowsBySheet[sheetId] ?? []).includes(rowIndex)
}

export function isColumnHidden(state: ViewportHiddenState, sheetId: string, colIndex: number): boolean {
  return (state.colsBySheet[sheetId] ?? []).includes(colIndex)
}

export function getHiddenRowsForSheet(state: ViewportHiddenState, sheetId: string): number[] {
  return state.rowsBySheet[sheetId] ?? []
}

export function getHiddenColumnsForSheet(state: ViewportHiddenState, sheetId: string): number[] {
  return state.colsBySheet[sheetId] ?? []
}

export const viewportHiddenAtom = atom<ViewportHiddenState>(DEFAULT_VIEWPORT_HIDDEN_STATE)
viewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hidden'

export const setViewportHiddenAtom = atom(
  (get) => get(viewportHiddenAtom),
  (get, set, input: SetViewportHiddenInput) => {
    if (!input.sheetId || input.sheetId.length === 0) return
    const state = get(viewportHiddenAtom)
    const rows =
      input.rows !== undefined
        ? sanitizeIndices(input.rows)
        : (state.rowsBySheet[input.sheetId] ?? [])
    const cols =
      input.cols !== undefined
        ? sanitizeIndices(input.cols)
        : (state.colsBySheet[input.sheetId] ?? [])
    set(viewportHiddenAtom, {
      rowsBySheet: { ...state.rowsBySheet, [input.sheetId]: rows },
      colsBySheet: { ...state.colsBySheet, [input.sheetId]: cols },
    })
  },
)
setViewportHiddenAtom.debugLabel = 'spreadsheet.viewport.setHidden'

const EMPTY_WINDOW: VisibleWindow = { rowStart: 0, rowEnd: -1, colStart: 0, colEnd: -1 }

export function getFrozenWindows(
  metrics: ViewportMetrics,
  freeze: { rows: number; cols: number },
): FrozenWindows {
  const m = normalizeViewportMetrics(metrics)
  const frozenRows = Math.max(0, Math.min(Math.trunc(freeze.rows), m.rowCount))
  const frozenCols = Math.max(0, Math.min(Math.trunc(freeze.cols), m.colCount))

  const full = getVisibleWindow(metrics)

  const scrollRowStart = Math.max(frozenRows, full.rowStart)
  const scrollRowEnd = full.rowEnd
  const scrollColStart = Math.max(frozenCols, full.colStart)
  const scrollColEnd = full.colEnd

  const hasTopRows = frozenRows > 0
  const hasLeftCols = frozenCols > 0
  const hasScrollRows = scrollRowStart <= scrollRowEnd
  const hasScrollCols = scrollColStart <= scrollColEnd

  const topLeft: VisibleWindow =
    hasTopRows && hasLeftCols
      ? { rowStart: 0, rowEnd: frozenRows - 1, colStart: 0, colEnd: frozenCols - 1 }
      : { ...EMPTY_WINDOW }

  const topRight: VisibleWindow =
    hasTopRows && hasScrollCols
      ? { rowStart: 0, rowEnd: frozenRows - 1, colStart: scrollColStart, colEnd: scrollColEnd }
      : { ...EMPTY_WINDOW }

  const bottomLeft: VisibleWindow =
    hasScrollRows && hasLeftCols
      ? { rowStart: scrollRowStart, rowEnd: scrollRowEnd, colStart: 0, colEnd: frozenCols - 1 }
      : { ...EMPTY_WINDOW }

  const bottomRight: VisibleWindow =
    hasScrollRows && hasScrollCols
      ? { rowStart: scrollRowStart, rowEnd: scrollRowEnd, colStart: scrollColStart, colEnd: scrollColEnd }
      : { ...EMPTY_WINDOW }

  return { topLeft, topRight, bottomLeft, bottomRight }
}

function getAlignedScrollOffset(input: {
  align: ViewportCellAlign
  current: number
  viewportSize: number
  cellStart: number
  cellSize: number
  totalSize: number
}): number {
  const cellEnd = input.cellStart + input.cellSize
  const viewportEnd = input.current + input.viewportSize
  let next = input.current

  switch (input.align) {
    case 'start':
      next = input.cellStart
      break
    case 'center':
      next = input.cellStart - (input.viewportSize - input.cellSize) / 2
      break
    case 'end':
      next = cellEnd - input.viewportSize
      break
    case 'nearest':
      if (input.cellStart < input.current) {
        next = input.cellStart
      } else if (cellEnd > viewportEnd) {
        next = cellEnd - input.viewportSize
      }
      break
    default:
      assertNever(input.align)
  }

  return clampOffset(next, input.totalSize - input.viewportSize)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled viewport alignment: ${value}`)
}
