export interface CellCoord {
  row: number
  col: number
}

export interface CellRange {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

export interface SheetRef {
  sheetId: string
}

export type SpreadsheetErrorCode =
  | 'BACKEND_ERROR'
  | 'CANCELLED'
  | 'INVALID_FORMULA'
  | 'FORMULA_CYCLE'
  | 'OUT_OF_BOUNDS'

export interface SpreadsheetError {
  code: SpreadsheetErrorCode
  message: string
}
