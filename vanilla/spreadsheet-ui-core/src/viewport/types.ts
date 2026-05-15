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

export interface ViewportSizeOverrideState {
  rowHeightsBySheet: Record<string, Record<string, number>>
  colWidthsBySheet: Record<string, Record<string, number>>
}

export interface SetViewportRowHeightInput {
  sheetId: string
  rowIndex: number
  heightPx: number
}

export interface SetViewportColumnWidthInput {
  sheetId: string
  colIndex: number
  widthPx: number
}

export interface ViewportFreezeState {
  rowsBySheet: Record<string, number>
  colsBySheet: Record<string, number>
}

export interface SetViewportFreezeInput {
  sheetId: string
  rows?: number
  cols?: number
}

export interface FrozenWindows {
  topLeft: VisibleWindow
  topRight: VisibleWindow
  bottomLeft: VisibleWindow
  bottomRight: VisibleWindow
}

export interface ViewportHiddenState {
  rowsBySheet: Record<string, number[]>
  colsBySheet: Record<string, number[]>
}

export interface SetViewportHiddenInput {
  sheetId: string
  rows?: number[]
  cols?: number[]
}
