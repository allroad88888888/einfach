import type { DisplayCell, SpreadsheetCellFormat } from '../backend'
import type { CellRange } from '../shared'

export type FormatPainterState = 'idle' | 'armed' | 'sticky'

/**
 * Captured format payload held in the painter clipboard while the painter is
 * armed or sticky. Format painter copies *format only* - not values, formulas,
 * or data validation. Conditional format is captured opportunistically so the
 * applied region matches the source's visual presentation.
 */
export interface CapturedFormat {
  format: SpreadsheetCellFormat
  conditionalFormat?: DisplayCell['conditionalFormat']
}

export interface ApplyFormatPainterInput {
  sheetId: string
  range: CellRange
}
