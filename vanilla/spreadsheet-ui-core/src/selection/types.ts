import type { CellCoord, CellRange } from '../shared'

export type SelectionKind = 'cell' | 'range' | 'row' | 'column' | 'all'

export interface SelectionBounds {
  rowCount: number
  colCount: number
}

export interface CellSelection {
  kind: 'cell'
  sheetId: string
  anchor: CellCoord
  focus: CellCoord
}

export interface RangeSelection {
  kind: 'range'
  sheetId: string
  anchor: CellCoord
  focus: CellCoord
}

export interface RowSelection {
  kind: 'row'
  sheetId: string
  rowAnchor: number
  rowFocus: number
}

export interface ColumnSelection {
  kind: 'column'
  sheetId: string
  colAnchor: number
  colFocus: number
}

export interface AllSelection {
  kind: 'all'
  sheetId: string
}

export type SelectionState =
  | CellSelection
  | RangeSelection
  | RowSelection
  | ColumnSelection
  | AllSelection

export interface ActiveSelectionCell extends CellCoord {
  sheetId: string
}

export interface SelectCellInput {
  coord: CellCoord
  sheetId?: string
  extend?: boolean
}

export interface SelectRowsInput {
  rowAnchor: number
  rowFocus?: number
  sheetId?: string
}

export interface SelectColumnsInput {
  colAnchor: number
  colFocus?: number
  sheetId?: string
}

export interface MoveSelectionInput {
  rowDelta?: number
  colDelta?: number
  row?: number
  col?: number
  extend?: boolean
}

export interface SelectionSnapshot {
  selection: SelectionState
  activeCell: ActiveSelectionCell
  range: CellRange
}
