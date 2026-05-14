import { atom } from '@einfach/core'
import type { CellCoord } from '../shared'
import type {
  CellViewportRect,
  ScrollToCellInput,
  ViewportCellAlign,
  ViewportMetrics,
  ViewportScrollPosition,
  VisibleWindow,
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

export const viewportMetricsAtom = atom<ViewportMetrics>(DEFAULT_VIEWPORT_METRICS)
viewportMetricsAtom.debugLabel = 'spreadsheet.viewport.metrics'

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
