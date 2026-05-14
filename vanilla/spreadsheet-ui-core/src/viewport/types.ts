import type { CellCoord, CellRange } from '../shared'

export interface ViewportMetrics {
  scrollTop: number
  scrollLeft: number
  viewportHeight: number
  viewportWidth: number
  rowHeight: number
  colWidth: number
  rowCount: number
  colCount: number
  overscanRows: number
  overscanCols: number
}

export type VisibleWindow = CellRange

export interface CellViewportRect {
  row: number
  col: number
  top: number
  left: number
  height: number
  width: number
}

export type ViewportCellAlign = 'nearest' | 'start' | 'center' | 'end'

export interface ViewportScrollPosition {
  scrollTop: number
  scrollLeft: number
}

export interface ScrollToCellInput {
  coord: CellCoord
  rowAlign?: ViewportCellAlign
  colAlign?: ViewportCellAlign
}
