import type { CellRange } from '../shared'
import type {
  SpreadsheetBorderSpec,
  SpreadsheetBorderStyle,
  SpreadsheetCellFormat,
  SpreadsheetNumberFormat,
} from '../backend'

/**
 * The 12 number-format categories defined by Excel / Luckysheet. The dialog
 * always renders all 12 entries in the category radio list so users can see
 * the full surface. Wave 6.3 widens `SpreadsheetNumberFormat` to cover the
 * full set; unsupported categories (in particular `'special'`) still surface
 * a "coming soon" notice when the engine hasn't wired them through.
 */
export type FormatCellsNumberCategory =
  | 'general'
  | 'number'
  | 'currency'
  | 'accounting'
  | 'date'
  | 'time'
  | 'percentage'
  | 'fraction'
  | 'scientific'
  | 'text'
  | 'special'
  | 'custom'

/** Identifier for a tab inside the Format Cells modal. */
export type FormatCellsTabId = 'number' | 'alignment' | 'font' | 'border' | 'fill'

/**
 * Editor-only draft fields not (yet) part of `SpreadsheetCellFormat`.
 *
 * Wave 6.1 expands the formatting surface beyond what 6.2 and 6.3 land on the
 * core type. The fields below are stored on the editor draft only; backends
 * that don't know about them ignore them when echoing the format back through
 * the projection. They are kept in `FormatCellsDraft` rather than the core
 * type to avoid breaking package-boundary tests on adapters that have not yet
 * widened.
 */
export interface FormatCellsDraftExtras {
  /** Cell-padding indent in increments (>= 0). Mirrors `SpreadsheetCellFormat.indent`. */
  textDirection?: 'context' | 'ltr' | 'rtl'
  /** Underline-style detail (`underline` flag remains canonical). */
  underlineStyle?: 'single' | 'double' | 'accounting'
  /** Vertical-script offset for the text run. */
  verticalScript?: 'superscript' | 'subscript'
  /** Font family stack for the cell. */
  fontFamily?: string
  /** Fill pattern when the cell renders with a non-solid pattern. */
  fillPattern?: 'solid' | 'lined' | 'dotted' | 'crosshatch'
  /** Two-stop linear gradient fill. */
  fillGradient?: FormatCellsGradient
}

export interface FormatCellsGradient {
  from: string
  to: string
  angle: 0 | 45 | 90 | 180
}

/** Forward-compatible cell-format draft used inside the editor. */
export type FormatCellsDraft = SpreadsheetCellFormat & FormatCellsDraftExtras

/** Open-state seed for `openFormatCellsAtom`. */
export interface OpenFormatCellsInput {
  range: CellRange
  sheetId: string
  initialFormat?: SpreadsheetCellFormat | null
  initialTab?: FormatCellsTabId
}

export interface FormatCellsEditorOpenState {
  status: 'open'
  sheetId: string
  range: CellRange
  activeTab: FormatCellsTabId
  draft: FormatCellsDraft
  dirty: boolean
}

export interface FormatCellsEditorClosedState {
  status: 'closed'
}

export type FormatCellsEditorState =
  | FormatCellsEditorOpenState
  | FormatCellsEditorClosedState

/** Re-exports for callers that import draft helpers. */
export type {
  SpreadsheetCellFormat,
  SpreadsheetNumberFormat,
  SpreadsheetBorderSpec,
  SpreadsheetBorderStyle,
}
