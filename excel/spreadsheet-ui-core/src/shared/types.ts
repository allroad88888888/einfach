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

export type SpreadsheetErrorSeverity = 'warning' | 'error' | 'fatal'

export type SpreadsheetErrorSource =
  | 'parse'
  | 'runtime'
  | 'permission'
  | 'transport'
  | 'validation'
  | 'projection'
  | 'unknown'

/** @deprecated Use `string` — open-string codes replace the union for one release cycle. */
export type LegacySpreadsheetErrorCode =
  | 'BACKEND_ERROR'
  | 'CANCELLED'
  | 'INVALID_FORMULA'
  | 'FORMULA_CYCLE'
  | 'OUT_OF_BOUNDS'

/** @deprecated Use `string` directly; kept for one release cycle. */
export type SpreadsheetErrorCode = string

export interface SpreadsheetError {
  code: string
  message: string
  severity?: SpreadsheetErrorSeverity
  source?: SpreadsheetErrorSource
  hint?: string
}
