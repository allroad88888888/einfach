import type { CellRange, SpreadsheetErrorSeverity } from '../shared'
import type { ColumnFilterRule, FilterSortState, SortDirective } from '../filter-sort/types'
import type {
  ConditionalFormatRule,
  ConditionalFormatRuleEntry,
} from '../conditional-formatting/types'
import type { ValidationMode, ValidationRule } from '../data-validation/types'
import type { NamedRange } from '../named-ranges/types'
import type { DisplayCellRichValue } from '../rich-types/types'
import type { DisplayCell, SpreadsheetCellFormat } from './types'

export type CellValueOperator = Extract<
  ConditionalFormatRule,
  { kind: 'cell-value' }
>['operator']

export interface RangeFormatLayer {
  range: CellRange
  format: SpreadsheetCellFormat
}

export function cloneFormat(format: SpreadsheetCellFormat): SpreadsheetCellFormat {
  const clone: SpreadsheetCellFormat = { ...format }
  if (format.numberFormat) clone.numberFormat = { ...format.numberFormat }
  return clone
}

export function cloneRange(range: CellRange): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

export function normalizeRange(range: CellRange): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

export function cloneNamedRange(range: NamedRange): NamedRange {
  return {
    name: range.name,
    scope: range.scope === 'workbook' ? 'workbook' : { sheetId: range.scope.sheetId },
    refersTo: { ...range.refersTo },
  }
}

export function cloneFilterSortRule(rule: ColumnFilterRule): ColumnFilterRule {
  switch (rule.kind) {
    case 'list':
      return { ...rule, values: [...rule.values] }
    default:
      return { ...rule }
  }
}

export function cloneFilterSortState(state: FilterSortState): FilterSortState {
  return {
    rules: state.rules.map(cloneFilterSortRule),
    directives: state.directives.map((directive) => ({ ...directive })),
  }
}

export function filterSortHasEffect(state: FilterSortState | undefined): boolean {
  return !!state && (state.rules.length > 0 || state.directives.length > 0)
}

export function keyFor(row: number, col: number): string {
  return `${row}:${col}`
}

export function isCoordInsideRange(
  row: number,
  col: number,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
): boolean {
  return (
    row >= range.rowStart &&
    row <= range.rowEnd &&
    col >= range.colStart &&
    col <= range.colEnd
  )
}

export function numericValue(text: string): number | null {
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

export function normalizeFilterText(value: string, caseSensitive: boolean | undefined): string {
  return caseSensitive ? value : value.toLocaleLowerCase()
}

export function filterRuleMatchesValue(rule: ColumnFilterRule, value: string): boolean {
  switch (rule.kind) {
    case 'equals':
      return (
        normalizeFilterText(value, rule.caseSensitive) ===
        normalizeFilterText(rule.value, rule.caseSensitive)
      )
    case 'contains':
      return normalizeFilterText(value, rule.caseSensitive).includes(
        normalizeFilterText(rule.value, rule.caseSensitive),
      )
    case 'range': {
      const numeric = numericValue(value)
      if (numeric === null) return false
      if (rule.min !== undefined && numeric < rule.min) return false
      if (rule.max !== undefined && numeric > rule.max) return false
      return true
    }
    case 'list':
      return rule.values.includes(value)
  }
}

export function nextConditionalFormatRuleId(rules: readonly ConditionalFormatRuleEntry[]): string {
  const used = new Set(rules.map((rule) => rule.id))
  let index = rules.length + 1
  let id = `cf-${index}`
  while (used.has(id)) {
    index += 1
    id = `cf-${index}`
  }
  return id
}

export function normalizeDimensionSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.round(value))
}

export function estimateUtf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length
  }
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
  }
  return bytes
}

export function isDefaultFormat(format: SpreadsheetCellFormat): boolean {
  const numberFormat = format.numberFormat
  const numberFormatIsDefault = !numberFormat || numberFormat.kind === 'general'
  const borders = format.borders
  const bordersAreDefault =
    !borders || (!borders.top && !borders.right && !borders.bottom && !borders.left)

  return (
    !format.bold &&
    !format.italic &&
    !format.underline &&
    !format.strikethrough &&
    !format.wrap &&
    (format.align === undefined || format.align === 'default') &&
    (format.verticalAlign === undefined) &&
    format.fontSize === undefined &&
    (format.fontFamily === undefined || format.fontFamily.length === 0) &&
    (format.fgColor === undefined || format.fgColor.length === 0) &&
    (format.bgColor === undefined || format.bgColor.length === 0) &&
    (format.indent === undefined || format.indent === 0) &&
    (format.rotation === undefined || format.rotation === 0) &&
    numberFormatIsDefault &&
    bordersAreDefault
  )
}

export function normalizeFormat(
  format: SpreadsheetCellFormat | null | undefined,
): SpreadsheetCellFormat | undefined {
  if (!format || isDefaultFormat(format)) return undefined
  return cloneFormat(format)
}

export function cloneRichValue(value: DisplayCellRichValue): DisplayCellRichValue {
  switch (value.kind) {
    case 'rich-text':
      return {
        kind: value.kind,
        runs: value.runs.map((run) =>
          run.format ? { text: run.text, format: { ...run.format } } : { text: run.text },
        ),
      }
    default:
      return { ...value }
  }
}

export function cloneCell(cell: DisplayCell): DisplayCell {
  const clone: DisplayCell = {
    row: cell.row,
    col: cell.col,
    displayValue: cell.displayValue,
  }
  if (cell.valueKind) clone.valueKind = cell.valueKind
  if (cell.formula !== undefined) clone.formula = cell.formula
  if (cell.error) clone.error = { ...cell.error }
  if (cell.formatKey !== undefined) clone.formatKey = cell.formatKey
  if (cell.format) clone.format = cloneFormat(cell.format)
  if (cell.conditionalFormat) clone.conditionalFormat = cloneFormat(cell.conditionalFormat)
  if (cell.validation) clone.validation = { ...cell.validation }
  if (cell.richValue) clone.richValue = cloneRichValue(cell.richValue)
  if (cell.mergedSpan) clone.mergedSpan = { ...cell.mergedSpan }
  if (cell.mergeAnchor) clone.mergeAnchor = { ...cell.mergeAnchor }
  if (cell.originalRow !== undefined) clone.originalRow = cell.originalRow
  return clone
}

export function compareCellValue(
  leftText: string,
  operator: CellValueOperator,
  rightText: string,
  secondRightText?: string,
): boolean {
  const leftNumber = numericValue(leftText)
  const rightNumber = numericValue(rightText)
  const secondRightNumber = secondRightText !== undefined ? numericValue(secondRightText) : null
  const hasNumberPair = leftNumber !== null && rightNumber !== null

  switch (operator) {
    case 'eq':
      return hasNumberPair ? leftNumber === rightNumber : leftText === rightText
    case 'ne':
      return hasNumberPair ? leftNumber !== rightNumber : leftText !== rightText
    case 'gt':
      return hasNumberPair && leftNumber > rightNumber
    case 'gte':
      return hasNumberPair && leftNumber >= rightNumber
    case 'lt':
      return hasNumberPair && leftNumber < rightNumber
    case 'lte':
      return hasNumberPair && leftNumber <= rightNumber
    case 'between':
      return leftNumber !== null && rightNumber !== null && secondRightNumber !== null
        ? leftNumber >= rightNumber && leftNumber <= secondRightNumber
        : false
    case 'not-between':
      return leftNumber !== null && rightNumber !== null && secondRightNumber !== null
        ? leftNumber < rightNumber || leftNumber > secondRightNumber
        : false
    default:
      return false
  }
}

export function compareFilterSortValues(left: string, right: string): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const leftNumber = numericValue(left)
  const rightNumber = numericValue(right)
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

export function cloneConditionalFormatRule(rule: ConditionalFormatRule): ConditionalFormatRule {
  switch (rule.kind) {
    case 'cell-value':
      return { ...rule, format: cloneFormat(rule.format) }
    case 'formula':
      return { ...rule, format: cloneFormat(rule.format) }
    case 'top-bottom':
      return { ...rule, format: cloneFormat(rule.format) }
    default:
      return { ...rule }
  }
}

export function cloneConditionalFormatRuleEntry(
  entry: ConditionalFormatRuleEntry,
): ConditionalFormatRuleEntry {
  return {
    id: entry.id,
    priority: entry.priority,
    scope: { range: cloneRange(entry.scope.range) },
    rule: cloneConditionalFormatRule(entry.rule),
  }
}

export function getColumnLabel(index: number): string {
  let value = index + 1
  let label = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }

  return label
}

export function toA1(row: number, col: number): string {
  return `${getColumnLabel(col)}${row + 1}`
}

export function conditionalRuleFormat(
  rule: ConditionalFormatRule,
): SpreadsheetCellFormat | undefined {
  switch (rule.kind) {
    case 'cell-value':
    case 'formula':
    case 'top-bottom':
      return normalizeFormat(rule.format)
    case 'data-bar':
      return normalizeFormat({ bgColor: rule.maxColor ?? '#bfdbfe' })
    case 'color-scale':
      return normalizeFormat({ bgColor: rule.maxColor })
  }
}

export function validationSeverityForMode(mode: ValidationMode): SpreadsheetErrorSeverity {
  return mode === 'reject' ? 'error' : 'warning'
}

export function getEffectiveFormat(
  row: number,
  col: number,
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: readonly RangeFormatLayer[],
): SpreadsheetCellFormat | undefined {
  const cellFormat = cellFormats.get(keyFor(row, col))
  if (cellFormat) return cloneFormat(cellFormat)

  for (let index = rangeFormats.length - 1; index >= 0; index -= 1) {
    const layer = rangeFormats[index]
    if (!isCoordInsideRange(row, col, layer.range)) continue
    return isDefaultFormat(layer.format) ? undefined : cloneFormat(layer.format)
  }

  return undefined
}

export interface FilterSortOptions {
  /**
   * Row index that holds the header. When provided, the output array sets
   * `rows[headerRow] = headerRow` so callers that include the header row in
   * their projection see it as a pass-through. Omit to skip header marking
   * (e.g. when the projection range does not include the header).
   */
  headerRow?: number
  /** Inclusive lower bound for data rows scanned. */
  startRow: number
  /** Exclusive upper bound for data rows scanned (summary row, if any, is `endRow - 1`). */
  endRow: number
}

export function isFilterSortSummaryRow(
  readValue: (row: number, col: number) => string,
  row: number,
): boolean {
  const label = readValue(row, 0).trim().toLocaleLowerCase()
  return row > 1 && (label === 'total' || label === 'summary')
}

export function rowMatchesFilterSortRules(
  readValue: (row: number, col: number) => string,
  row: number,
  rules: readonly ColumnFilterRule[],
): boolean {
  for (const rule of rules) {
    if (!filterRuleMatchesValue(rule, readValue(row, rule.colIndex))) return false
  }
  return true
}

export function compareFilterSortRowsWith(
  readValue: (row: number, col: number) => string,
  directives: readonly SortDirective[],
  leftRow: number,
  rightRow: number,
): number {
  for (const directive of directives) {
    const valueCompare = compareFilterSortValues(
      readValue(leftRow, directive.colIndex),
      readValue(rightRow, directive.colIndex),
    )
    if (valueCompare !== 0) {
      return directive.direction === 'asc' ? valueCompare : -valueCompare
    }
  }
  return 0
}

export function buildFilterSortDisplayRows(
  state: FilterSortState | undefined,
  options: FilterSortOptions,
  readValue: (row: number, col: number) => string,
): number[] | null {
  if (!filterSortHasEffect(state)) return null

  const maxRow = options.endRow - 1
  if (maxRow < options.startRow) {
    if (options.headerRow === undefined || maxRow < options.headerRow) return []
  }

  const rows: number[] = []
  if (options.headerRow !== undefined) rows[options.headerRow] = options.headerRow

  const hasSummary = maxRow >= options.startRow && isFilterSortSummaryRow(readValue, maxRow)
  const summaryRows = hasSummary ? [maxRow] : []
  const dataRowStart = options.startRow
  const dataRowEnd = hasSummary ? maxRow - 1 : maxRow

  const dataRows: Array<{ row: number; index: number }> = []
  for (let row = dataRowStart; row <= dataRowEnd; row += 1) {
    if (rowMatchesFilterSortRules(readValue, row, state!.rules)) {
      dataRows.push({ row, index: dataRows.length })
    }
  }

  if (state!.directives.length > 0) {
    dataRows.sort((left, right) => {
      const valueCompare = compareFilterSortRowsWith(
        readValue,
        state!.directives,
        left.row,
        right.row,
      )
      return valueCompare === 0 ? left.index - right.index : valueCompare
    })
  }

  dataRows.forEach((item, index) => {
    rows[dataRowStart + index] = item.row
  })
  for (const row of summaryRows) rows[row] = row
  return rows
}

export function validationMessageForRule(rule: ValidationRule): string {
  switch (rule.kind) {
    case 'list':
      return rule.values.length > 0
        ? `Value must be one of: ${rule.values.join(', ')}`
        : 'Value must match the configured list'
    case 'range':
      if (rule.min !== undefined && rule.max !== undefined) {
        return `Value must be between ${rule.min} and ${rule.max}`
      }
      if (rule.min !== undefined) return `Value must be >= ${rule.min}`
      if (rule.max !== undefined) return `Value must be <= ${rule.max}`
      return 'Value must be a number'
    case 'regex':
      return `Value must match pattern /${rule.pattern}/${rule.flags ?? ''}`
    case 'formula':
      return rule.formula.trim().length > 0
        ? `Value must satisfy ${rule.formula}`
        : 'Value must satisfy the configured formula'
  }
}
