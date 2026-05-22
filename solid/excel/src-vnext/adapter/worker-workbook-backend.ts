import type {
  BackendMutationResult,
  CellRange,
  ClearRangeRequest,
  ClearValidationRuleRequest,
  ColumnFilterRule,
  ConditionalFormatRule,
  ConditionalFormatRuleEntry,
  ConditionalFormatRulesResult,
  DeleteColumnsRequest,
  DeleteNamedRangeRequest,
  DeleteRowsRequest,
  DisplayCell,
  ImportCellChunksRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  ImportCellsRequest,
  ProjectionRevision,
  RangeTsvChunkConsumer,
  RangeTsvChunkExportResult,
  ListConditionalFormatRulesRequest,
  ListNamedRangesRequest,
  NamedRange,
  NamedRangeListResult,
  NamedRangeMutationResult,
  RangeProjectionRequest,
  RangeProjectionResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  ReorderSheetRequest,
  RemoveConditionalFormatRuleRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
  SetColumnWidthRequest,
  SetConditionalFormatRuleRequest,
  SetFilterSortRequest,
  SetFormatRangeRequest,
  SetNamedRangeRequest,
  SetRowHeightRequest,
  SetValidationRuleRequest,
  SheetMutationResult,
  SortDirective,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  FilterSortState,
  ValidationMode,
  ValidationRule,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { evaluateValidationLocal, reorderSheetMetadata } from '@einfach/spreadsheet-ui-core'

import {
  createWorkerWorkbook,
  type CellFormatJSON,
  type CellSnapshotWire,
  type CellWire,
  type FormatRangeSnapshot,
  type ImportCellWire,
  type SparseCellWire,
  type SparseRangeWire,
  type WorkerLike,
  type WorkerWorkbookClient,
  type WorkbookImportStatsWire,
  type WorkbookSheetMeta,
} from './worker-protocol'

export interface WorkerWorkbookBackendSheetInput {
  id?: string
  name: string
}

export interface WorkerWorkbookSpreadsheetBackendOptions {
  client?: WorkerWorkbookClient
  workerFactory?: () => WorkerLike
  sheets?: readonly (string | WorkerWorkbookBackendSheetInput)[]
  revision?: ProjectionRevision
  afterInit?: (
    client: WorkerWorkbookClient,
    sheets: WorkerWorkbookBackendSheet[],
  ) => Promise<void> | void
}

export interface WorkerWorkbookSpreadsheetBackend extends SpreadsheetBackend {
  ready(): Promise<WorkerWorkbookBackendSheet[]>
  sheets(): WorkerWorkbookBackendSheet[]
  dispose(): void
}

export interface WorkerWorkbookBackendSheet {
  id: string
  idx: number
  name: string
}

type SheetLookup = {
  sheets: WorkerWorkbookBackendSheet[]
  byId: Map<string, WorkerWorkbookBackendSheet>
}

const DEFAULT_SHEETS = ['Sheet1']
const DEFAULT_IMPORT_CELLS_PER_CHUNK = 10_000
const MIN_IMPORT_CELLS_PER_CHUNK = 1
const MAX_IMPORT_CELLS_PER_CHUNK = 10_000

function normalizeSheetInputs(
  sheets: readonly (string | WorkerWorkbookBackendSheetInput)[] | undefined,
): WorkerWorkbookBackendSheetInput[] {
  const input = sheets && sheets.length > 0 ? sheets : DEFAULT_SHEETS
  return input.map((sheet, index) =>
    typeof sheet === 'string'
      ? {
          id: `sheet-${index + 1}`,
          name: sheet,
        }
      : {
          id: sheet.id ?? `sheet-${index + 1}`,
          name: sheet.name,
        },
  )
}

function buildSheetLookup(
  inputs: WorkerWorkbookBackendSheetInput[],
  metas: WorkbookSheetMeta[],
): SheetLookup {
  const sheets = metas.map((meta, index) => {
    const input = inputs[index]
    return {
      id: input?.id ?? `sheet-${meta.idx + 1}`,
      idx: meta.idx,
      name: meta.name,
    }
  })
  const byId = new Map<string, WorkerWorkbookBackendSheet>()

  for (const sheet of sheets) {
    byId.set(sheet.id, sheet)
    byId.set(sheet.name, sheet)
  }

  for (const sheet of sheets) {
    if (!byId.has(String(sheet.idx))) byId.set(String(sheet.idx), sheet)
    if (!byId.has(`sheet-${sheet.idx + 1}`)) byId.set(`sheet-${sheet.idx + 1}`, sheet)
  }

  return { sheets, byId }
}

function buildSheetLookupFromSheets(sheets: WorkerWorkbookBackendSheet[]): SheetLookup {
  const byId = new Map<string, WorkerWorkbookBackendSheet>()

  for (const sheet of sheets) {
    byId.set(sheet.id, sheet)
    byId.set(sheet.name, sheet)
  }

  for (const sheet of sheets) {
    if (!byId.has(String(sheet.idx))) byId.set(String(sheet.idx), sheet)
    if (!byId.has(`sheet-${sheet.idx + 1}`)) byId.set(`sheet-${sheet.idx + 1}`, sheet)
  }

  return { sheets, byId }
}

function syncSheetLookup(
  metas: WorkbookSheetMeta[],
  existingSheets: readonly WorkerWorkbookBackendSheet[],
): SheetLookup {
  const usedIds = new Set<string>()
  const sheets = metas.map((meta, index) => {
    const existing =
      existingSheets.find((sheet) => sheet.name === meta.name) ??
      existingSheets[index] ??
      existingSheets.find((sheet) => sheet.idx === meta.idx)
    let id = existing?.id ?? `sheet-${meta.idx + 1}`

    if (usedIds.has(id)) {
      let nextIdIndex = meta.idx + 1
      do {
        nextIdIndex += 1
        id = `sheet-${nextIdIndex}`
      } while (usedIds.has(id))
    }

    usedIds.add(id)
    return {
      id,
      idx: meta.idx,
      name: meta.name,
    }
  })

  return buildSheetLookupFromSheets(sheets)
}

function toSheetMetadata(
  sheets: readonly WorkerWorkbookBackendSheet[],
): SpreadsheetSheetMetadata[] {
  return sheets.map((sheet, index) => ({
    id: sheet.id,
    name: sheet.name,
    index,
  }))
}

function normalizeDimensionSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.round(value))
}

function getColumnLabel(index: number): string {
  let value = index + 1
  let label = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }

  return label
}

function toA1(row: number, col: number): string {
  return `${getColumnLabel(col)}${row + 1}`
}

function parseA1(addr: string): { row: number; col: number } | null {
  const match = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!match) {
    return null
  }

  let col = 0
  for (let index = 0; index < match[1].length; index += 1) {
    col = col * 26 + (match[1].charCodeAt(index) - 64)
  }

  const row = Number(match[2]) - 1
  if (!Number.isInteger(row) || row < 0) {
    return null
  }

  return {
    row,
    col: col - 1,
  }
}

function toSparseRange(sheet: number, range: CellRange): SparseRangeWire {
  return {
    sheet,
    startRow: range.rowStart,
    startCol: range.colStart,
    endRow: range.rowEnd,
    endCol: range.colEnd,
  }
}

function structuralMutationResult(
  request: InsertRowsRequest | DeleteRowsRequest | InsertColumnsRequest | DeleteColumnsRequest,
  revision: ProjectionRevision,
): BackendMutationResult {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
  }
}

function cloneFormat(format: SpreadsheetCellFormat): SpreadsheetCellFormat {
  const clone: SpreadsheetCellFormat = { ...format }
  if (format.numberFormat) clone.numberFormat = { ...format.numberFormat }
  return clone
}

function normalizeFormat(
  format: SpreadsheetCellFormat | null | undefined,
): SpreadsheetCellFormat | undefined {
  if (!format || isDefaultFormat(format)) return undefined
  return cloneFormat(format)
}

function isDefaultFormat(format: SpreadsheetCellFormat): boolean {
  const numberFormat = format.numberFormat
  const numberFormatIsDefault = !numberFormat || numberFormat.kind === 'general'

  return (
    !format.bold &&
    !format.italic &&
    (format.align === undefined || format.align === 'default') &&
    format.fontSize === undefined &&
    (format.fontFamily === undefined || format.fontFamily.length === 0) &&
    (format.fgColor === undefined || format.fgColor.length === 0) &&
    (format.bgColor === undefined || format.bgColor.length === 0) &&
    numberFormatIsDefault
  )
}

function cloneCell(cell: DisplayCell): DisplayCell {
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
  if (cell.richValue) clone.richValue = { ...cell.richValue } as DisplayCell['richValue']
  if (cell.mergedSpan) clone.mergedSpan = { ...cell.mergedSpan }
  if (cell.mergeAnchor) clone.mergeAnchor = { ...cell.mergeAnchor }
  if (cell.originalRow !== undefined) clone.originalRow = cell.originalRow
  return clone
}

function cloneRange(range: CellRange): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function normalizeRange(range: CellRange): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

function rangesIntersect(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart <= right.rowEnd &&
    left.rowEnd >= right.rowStart &&
    left.colStart <= right.colEnd &&
    left.colEnd >= right.colStart
  )
}

function cloneConditionalFormatRule(rule: ConditionalFormatRule): ConditionalFormatRule {
  switch (rule.kind) {
    case 'cell-value':
    case 'formula':
    case 'top-bottom':
      return { ...rule, format: cloneFormat(rule.format) }
    default:
      return { ...rule }
  }
}

function cloneConditionalFormatRuleEntry(
  entry: ConditionalFormatRuleEntry,
): ConditionalFormatRuleEntry {
  return {
    id: entry.id,
    priority: entry.priority,
    scope: { range: cloneRange(entry.scope.range) },
    rule: cloneConditionalFormatRule(entry.rule),
  }
}

function cloneNamedRange(range: NamedRange): NamedRange {
  return {
    name: range.name,
    scope: range.scope === 'workbook' ? 'workbook' : { sheetId: range.scope.sheetId },
    refersTo: { ...range.refersTo },
  }
}

function namedRangeScopeEquals(left: NamedRange['scope'], right: NamedRange['scope']): boolean {
  if (left === 'workbook' || right === 'workbook') return left === right
  return left.sheetId === right.sheetId
}

function cloneFilterSortRule(rule: ColumnFilterRule): ColumnFilterRule {
  switch (rule.kind) {
    case 'list':
      return { ...rule, values: [...rule.values] }
    default:
      return { ...rule }
  }
}

function cloneFilterSortState(state: FilterSortState): FilterSortState {
  return {
    rules: state.rules.map(cloneFilterSortRule),
    directives: state.directives.map((directive) => ({ ...directive })),
  }
}

function filterSortHasEffect(state: FilterSortState | undefined): boolean {
  return !!state && (state.rules.length > 0 || state.directives.length > 0)
}

function keyFor(row: number, col: number): string {
  return `${row}:${col}`
}

function isCoordInsideRange(
  row: number,
  col: number,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
): boolean {
  return (
    row >= range.rowStart && row <= range.rowEnd && col >= range.colStart && col <= range.colEnd
  )
}

function numericValue(text: string): number | null {
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function readCellValue(cells: Map<string, DisplayCell>, row: number, col: number): string {
  return cells.get(keyFor(row, col))?.displayValue ?? ''
}

function normalizeFilterText(value: string, caseSensitive: boolean | undefined): string {
  return caseSensitive ? value : value.toLocaleLowerCase()
}

function filterRuleMatchesValue(rule: ColumnFilterRule, value: string): boolean {
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

function rowMatchesFilterRules(
  cells: Map<string, DisplayCell>,
  row: number,
  rules: readonly ColumnFilterRule[],
): boolean {
  for (const rule of rules) {
    if (!filterRuleMatchesValue(rule, readCellValue(cells, row, rule.colIndex))) return false
  }
  return true
}

function compareFilterSortValues(left: string, right: string): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const leftNumber = numericValue(left)
  const rightNumber = numericValue(right)
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

function compareFilterSortRows(
  cells: Map<string, DisplayCell>,
  directives: readonly SortDirective[],
  leftRow: number,
  rightRow: number,
): number {
  for (const directive of directives) {
    const valueCompare = compareFilterSortValues(
      readCellValue(cells, leftRow, directive.colIndex),
      readCellValue(cells, rightRow, directive.colIndex),
    )
    if (valueCompare !== 0) {
      return directive.direction === 'asc' ? valueCompare : -valueCompare
    }
  }
  return 0
}

function isSummaryRow(cells: Map<string, DisplayCell>, row: number): boolean {
  const label = readCellValue(cells, row, 0).trim().toLocaleLowerCase()
  return row > 1 && (label === 'total' || label === 'summary')
}

function buildFilterSortDisplayRows(
  cells: Map<string, DisplayCell>,
  range: CellRange,
  state: FilterSortState | undefined,
): number[] | null {
  if (!filterSortHasEffect(state)) return null

  let maxRow = range.rowStart - 1
  for (const cell of cells.values()) {
    if (cell.row > maxRow) maxRow = cell.row
  }
  if (maxRow < range.rowStart) return []

  const rows: number[] = []
  if (range.rowStart === 0) rows[0] = 0
  const summaryRows = isSummaryRow(cells, maxRow) ? [maxRow] : []
  const dataRowStart = Math.max(1, range.rowStart)
  const dataRowEnd = summaryRows.length > 0 ? maxRow - 1 : maxRow
  const dataRows: Array<{ row: number; index: number }> = []

  for (let row = dataRowStart; row <= dataRowEnd; row += 1) {
    if (rowMatchesFilterRules(cells, row, state!.rules)) {
      dataRows.push({ row, index: dataRows.length })
    }
  }
  if (state!.directives.length > 0) {
    dataRows.sort((left, right) => {
      const valueCompare = compareFilterSortRows(cells, state!.directives, left.row, right.row)
      return valueCompare === 0 ? left.index - right.index : valueCompare
    })
  }
  dataRows.forEach((item, index) => {
    rows[dataRowStart + index] = item.row
  })
  for (const row of summaryRows) rows[row] = row
  return rows
}

function applyFilterSortOverlay(
  cells: DisplayCell[],
  range: CellRange,
  state: FilterSortState | undefined,
): DisplayCell[] {
  const bySource = new Map(cells.map((cell) => [keyFor(cell.row, cell.col), cell]))
  const displayRows = buildFilterSortDisplayRows(bySource, range, state)
  if (displayRows === null) return cells

  const projected: DisplayCell[] = []
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    const sourceRow = displayRows[row]
    if (sourceRow === undefined) continue
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const cell = bySource.get(keyFor(sourceRow, col))
      if (!cell) continue
      projected.push({
        ...cloneCell(cell),
        row,
        col,
        originalRow: sourceRow,
      })
    }
  }
  return projected
}

function validationSeverityForMode(mode: ValidationMode): 'error' | 'warning' {
  return mode === 'reject' ? 'error' : 'warning'
}

function validationMessageForRule(rule: ValidationRule): string {
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

function cloneValidationRule(rule: ValidationRule): ValidationRule {
  return rule.kind === 'list' ? { ...rule, values: [...rule.values] } : { ...rule }
}

type WorkerValidationRuleLayer = {
  range: CellRange
  rule: ValidationRule
  mode: ValidationMode
}

function applyValidationOverlay(
  cells: DisplayCell[],
  range: CellRange,
  rules: readonly WorkerValidationRuleLayer[],
): DisplayCell[] {
  if (rules.length === 0) return cells
  const byDisplay = new Map(cells.map((cell) => [keyFor(cell.row, cell.col), cloneCell(cell)]))

  for (const layer of rules) {
    if (!rangesIntersect(layer.range, range)) continue

    for (const cell of byDisplay.values()) {
      const sourceRow = cell.originalRow ?? cell.row
      if (!isCoordInsideRange(sourceRow, cell.col, layer.range)) continue
      const outcome = evaluateValidationLocal(layer.rule, cell.displayValue)
      const severity = validationSeverityForMode(layer.mode)
      cell.validation = outcome
        ? { ...outcome, severity }
        : {
            code: `validation.${layer.rule.kind}`,
            severity,
            message: validationMessageForRule(layer.rule),
          }
    }

    const rowStart = Math.max(range.rowStart, layer.range.rowStart)
    const rowEnd = Math.min(range.rowEnd, layer.range.rowEnd)
    const colStart = Math.max(range.colStart, layer.range.colStart)
    const colEnd = Math.min(range.colEnd, layer.range.colEnd)
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const key = keyFor(row, col)
        if (byDisplay.has(key)) continue
        byDisplay.set(key, {
          row,
          col,
          displayValue: '',
          valueKind: 'blank',
          validation: {
            code: `validation.${layer.rule.kind}`,
            severity: validationSeverityForMode(layer.mode),
            message: validationMessageForRule(layer.rule),
          },
        })
      }
    }
  }
  return [...byDisplay.values()]
}

type CellValueOperator = Extract<ConditionalFormatRule, { kind: 'cell-value' }>['operator']

function compareCellValue(
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
  }
}

function conditionalRuleAppliesToCell(
  rule: ConditionalFormatRule,
  cell: DisplayCell | undefined,
): boolean {
  const value = cell?.displayValue ?? ''
  switch (rule.kind) {
    case 'cell-value':
      return compareCellValue(value, rule.operator, rule.value, rule.value2)
    case 'formula':
      return rule.formula.trim().length > 0
    case 'data-bar':
    case 'color-scale':
    case 'top-bottom':
      return numericValue(value) !== null
  }
}

function conditionalRuleFormat(rule: ConditionalFormatRule): SpreadsheetCellFormat | undefined {
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

function getConditionalFormatForCell(
  row: number,
  col: number,
  cell: DisplayCell | undefined,
  rules: readonly ConditionalFormatRuleEntry[],
): SpreadsheetCellFormat | undefined {
  const ordered = [...rules].sort((left, right) => left.priority - right.priority)
  for (const entry of ordered) {
    if (!isCoordInsideRange(row, col, entry.scope.range)) continue
    if (!conditionalRuleAppliesToCell(entry.rule, cell)) continue
    const format = conditionalRuleFormat(entry.rule)
    if (format) return format
  }
  return undefined
}

function applyConditionalFormatOverlay(
  cells: DisplayCell[],
  rules: readonly ConditionalFormatRuleEntry[],
): DisplayCell[] {
  if (rules.length === 0) return cells
  return cells.map((cell) => {
    const sourceRow = cell.originalRow ?? cell.row
    const conditionalFormat = getConditionalFormatForCell(sourceRow, cell.col, cell, rules)
    if (!conditionalFormat) return cell
    return {
      ...cell,
      conditionalFormat: {
        ...(cell.conditionalFormat ? cloneFormat(cell.conditionalFormat) : {}),
        ...conditionalFormat,
      },
    }
  })
}

function nextConditionalFormatRuleId(rules: readonly ConditionalFormatRuleEntry[]): string {
  const used = new Set(rules.map((rule) => rule.id))
  let index = rules.length + 1
  let id = `cf-${index}`
  while (used.has(id)) {
    index += 1
    id = `cf-${index}`
  }
  return id
}

function snapshotCellFormatKey(
  snapshot: FormatRangeSnapshot['cellFormats'][number],
): string | null {
  const coord = parseA1(snapshot.addr)
  if (!coord) return null
  return keyFor(coord.row, coord.col)
}

function getEffectiveFormat(
  row: number,
  col: number,
  snapshot: FormatRangeSnapshot,
): SpreadsheetCellFormat | undefined {
  for (const cellFormat of snapshot.cellFormats) {
    const key = snapshotCellFormatKey(cellFormat)
    if (key === keyFor(row, col)) {
      return normalizeFormat(cellFormat.format)
    }
  }

  for (let index = snapshot.rangeFormats.length - 1; index >= 0; index -= 1) {
    const layer = snapshot.rangeFormats[index]
    const layerRange = {
      rowStart: layer.startRow,
      rowEnd: layer.endRow,
      colStart: layer.startCol,
      colEnd: layer.endCol,
    }
    if (!isCoordInsideRange(row, col, layerRange)) continue
    return isDefaultFormat(layer.format) ? undefined : cloneFormat(layer.format)
  }

  return undefined
}

function mergeFormatsIntoCells(
  cells: DisplayCell[],
  range: CellRange,
  snapshot: FormatRangeSnapshot,
): DisplayCell[] {
  const cellMap = new Map<string, DisplayCell>()

  for (const cell of cells) {
    const format = getEffectiveFormat(cell.row, cell.col, snapshot)
    cellMap.set(keyFor(cell.row, cell.col), format ? { ...cell, format } : cell)
  }

  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(row, col)
      if (cellMap.has(key)) continue
      const format = getEffectiveFormat(row, col, snapshot)
      if (!format) continue
      cellMap.set(key, {
        row,
        col,
        displayValue: '',
        valueKind: 'blank',
        format,
      })
    }
  }

  return [...cellMap.values()].sort((left, right) =>
    left.row === right.row ? left.col - right.col : left.row - right.row,
  )
}

function snapshotToDisplayCell(snapshot: CellSnapshotWire): DisplayCell | null {
  const coord = parseA1(snapshot.addr)
  if (!coord) {
    return null
  }

  if (snapshot.type === 'null' && snapshot.formula === '' && snapshot.display === '') {
    return null
  }

  const valueKind = snapshot.isError
    ? 'error'
    : snapshot.type === 'text'
      ? 'string'
      : snapshot.type === 'null'
        ? 'blank'
        : snapshot.type

  const cell: DisplayCell = {
    row: coord.row,
    col: coord.col,
    displayValue: snapshot.display,
    valueKind,
  }

  if (snapshot.formula !== '') {
    cell.formula = snapshot.formula
  }
  if (snapshot.isError) {
    cell.error = {
      code: 'BACKEND_ERROR',
      message: snapshot.display,
    }
  }

  return cell
}

function toCellWire(input: string): CellWire {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { type: 'null' }
  }

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return { type: 'number', value: numeric }
  }

  return { type: 'text', value: trimmed }
}

function toImportCellWire(sheet: number, row: number, col: number, input: string): ImportCellWire {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { sheet, row, col, kind: 'null' }
  }
  if (trimmed.startsWith('=')) {
    return { sheet, row, col, kind: 'formula', value: trimmed }
  }

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return { sheet, row, col, kind: 'number', value: numeric }
  }

  return { sheet, row, col, kind: 'text', value: trimmed }
}

function normalizeImportCellsPerChunk(value: number | undefined): number {
  const normalized = Math.floor(Number(value))
  if (!Number.isFinite(normalized)) return DEFAULT_IMPORT_CELLS_PER_CHUNK
  if (normalized < MIN_IMPORT_CELLS_PER_CHUNK) return MIN_IMPORT_CELLS_PER_CHUNK
  if (normalized > MAX_IMPORT_CELLS_PER_CHUNK) return MAX_IMPORT_CELLS_PER_CHUNK
  return normalized
}

function assertImportStatsOk(stats: WorkbookImportStatsWire) {
  if (stats.errors === 0 && stats.rejectedFormulas === 0) return

  const issue = stats.issues?.[0]
  const suffix = issue ? `: ${issue.message}` : ''
  throw createBackendError(
    issue?.code ?? (stats.rejectedFormulas > 0 ? 'FORMULA_REJECTED' : 'IMPORT_FAILED'),
    `Workbook import failed${suffix}`,
  )
}

function createBackendError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.trunc(value))
}

function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(Math.trunc(value), normalizeCount(count) - 1))
}

function resolveLineDataEdge(
  fromIndex: number,
  occupiedIndexes: readonly number[],
  maxIndex: number,
  direction: -1 | 1,
): number {
  const occupied = new Set(occupiedIndexes)
  const currentIsNonBlank = occupied.has(fromIndex)

  if (direction > 0) {
    if (currentIsNonBlank && occupied.has(fromIndex + 1)) {
      let index = fromIndex + 1
      while (index < maxIndex && occupied.has(index + 1)) {
        index += 1
      }
      return index
    }

    const next = occupiedIndexes.find((index) => index > fromIndex)
    return next ?? maxIndex
  }

  if (currentIsNonBlank && occupied.has(fromIndex - 1)) {
    let index = fromIndex - 1
    while (index > 0 && occupied.has(index - 1)) {
      index -= 1
    }
    return index
  }

  for (let index = occupiedIndexes.length - 1; index >= 0; index -= 1) {
    const occupiedIndex = occupiedIndexes[index]
    if (occupiedIndex < fromIndex) {
      return occupiedIndex
    }
  }

  return 0
}

function uniqueSortedIndexes(indexes: readonly number[]): number[] {
  return [...new Set(indexes)].sort((left, right) => left - right)
}

function estimateUtf8Bytes(text: string): number {
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

export function createWorkerWorkbookSpreadsheetBackend(
  options: WorkerWorkbookSpreadsheetBackendOptions,
): WorkerWorkbookSpreadsheetBackend {
  const resolvedClient =
    options.client ??
    (options.workerFactory ? createWorkerWorkbook({ workerFactory: options.workerFactory }) : null)

  if (!resolvedClient) {
    throw new Error('createWorkerWorkbookSpreadsheetBackend requires client or workerFactory')
  }

  const sheetInputs = normalizeSheetInputs(options.sheets)
  let lookup: SheetLookup = { sheets: [], byId: new Map() }
  let revision = options.revision ?? 0
  let disposed = false
  const client: WorkerWorkbookClient = resolvedClient
  // Toolbar-overlay metadata (data validation, conditional format, filter/sort, named ranges) is
  // intentionally kept on the main thread for now: the WASM Workbook does not yet model these and
  // would not round-trip them through undo/redo or formula evaluation. The host applies them on
  // top of the worker's projection. Move into the Rust workbook once it grows native support; at
  // that point these Maps should disappear (not be extended).
  const validationRulesBySheetId = new Map<string, WorkerValidationRuleLayer[]>()
  const conditionalFormatRulesBySheetId = new Map<string, ConditionalFormatRuleEntry[]>()
  const filterSortBySheetId = new Map<string, FilterSortState>()
  let namedRanges: NamedRange[] = []
  const readyPromise = client
    .initWorkbook(sheetInputs.map((sheet) => sheet.name))
    .then(async (metas) => {
      lookup = buildSheetLookup(sheetInputs, metas)
      await options.afterInit?.(client, lookup.sheets)
      return lookup.sheets
    })

  const offDirty = client.onCellsDirty(() => {
    bumpRevision()
  })

  function bumpRevision(): ProjectionRevision {
    if (typeof revision === 'number' && Number.isFinite(revision)) {
      revision += 1
    }
    return revision
  }

  async function refreshSheetLookup(
    existingSheets: readonly WorkerWorkbookBackendSheet[] = lookup.sheets,
  ): Promise<WorkerWorkbookBackendSheet[]> {
    await readyPromise
    const metas = await client.sheetList()
    const synced = syncSheetLookup(metas, existingSheets)
    lookup = synced
    return lookup.sheets
  }

  function sheetMutationResult(
    requestId: number | undefined,
    extra: Partial<SheetMutationResult> = {},
  ): SheetMutationResult {
    const { revision: resultRevision, ...rest } = extra
    return {
      ...rest,
      requestId,
      revision: resultRevision ?? revision,
      sheets: toSheetMetadata(lookup.sheets),
    }
  }

  function normalizeSheetName(name: string | undefined, fallback: string): string {
    const normalized = name?.trim() ?? ''
    return normalized.length > 0 ? normalized : fallback
  }

  async function readViewportSizeProjection(
    request: ViewportSizeProjectionRequest,
  ): Promise<ViewportSizeProjectionResult> {
    const sheet = await resolveSheet(request.sheetId)
    const snapshot = await client.snapshotViewportSizes(toSparseRange(sheet.idx, request.window))
    const rowHeights = [...(snapshot.rowHeights ?? [])].sort(
      (left, right) => left.rowIndex - right.rowIndex,
    )
    const colWidths = [...(snapshot.colWidths ?? [])].sort(
      (left, right) => left.colIndex - right.colIndex,
    )

    return {
      kind: 'viewport-size',
      sheetId: request.sheetId,
      window: { ...request.window },
      requestId: request.requestId,
      revision: request.revision ?? revision,
      rowHeights,
      colWidths,
    }
  }

  function nextSheetName(): string {
    const used = new Set(lookup.sheets.map((sheet) => sheet.name))
    let index = lookup.sheets.length + 1
    let name = `Sheet${index}`

    while (used.has(name)) {
      index += 1
      name = `Sheet${index}`
    }

    return name
  }

  async function resolveSheet(sheetId: string): Promise<WorkerWorkbookBackendSheet> {
    await readyPromise
    const sheet = lookup.byId.get(sheetId)
    if (!sheet) {
      throw createBackendError('INVALID_SHEET', `unknown worker workbook sheet: ${sheetId}`)
    }
    return sheet
  }

  async function readRange(
    sheetId: string,
    range: CellRange,
    requestRevision?: ProjectionRevision,
  ): Promise<{ cells: DisplayCell[]; revision?: ProjectionRevision }> {
    const sheet = await resolveSheet(sheetId)
    const sparseRange = toSparseRange(sheet.idx, range)
    const [snapshots, formatSnapshot] = await Promise.all([
      client.readSparseRange(sparseRange),
      client.snapshotFormatRange(sparseRange),
    ])
    const cells = snapshots
      .map(snapshotToDisplayCell)
      .filter((cell): cell is DisplayCell => cell !== null)
      .sort((left, right) => (left.row === right.row ? left.col - right.col : left.row - right.row))

    const formattedCells = mergeFormatsIntoCells(cells, range, formatSnapshot)
    const filteredCells = applyFilterSortOverlay(
      formattedCells,
      range,
      filterSortBySheetId.get(sheetId),
    )
    const validatedCells = applyValidationOverlay(
      filteredCells,
      range,
      validationRulesBySheetId.get(sheetId) ?? [],
    )

    return {
      cells: applyConditionalFormatOverlay(
        validatedCells,
        conditionalFormatRulesBySheetId.get(sheetId) ?? [],
      ).sort((left, right) =>
        left.row === right.row ? left.col - right.col : left.row - right.row,
      ),
      revision: requestRevision ?? revision,
    }
  }

  async function consumeExportRangeTsvChunks(
    request: RangeTsvExportRequest,
    onChunk: RangeTsvChunkConsumer,
  ): Promise<RangeTsvChunkExportResult> {
    const sheet = await resolveSheet(request.sheetId)
    const sparseRange = toSparseRange(sheet.idx, request.range)
    let chunkCount = 0
    let estimatedBytes = 0

    if (typeof client.consumeExportRangeTsvChunks === 'function') {
      await client.consumeExportRangeTsvChunks(
        sparseRange,
        async (chunk) => {
          if (chunkCount > 0) estimatedBytes += 1
          estimatedBytes += estimateUtf8Bytes(chunk.chunk)
          chunkCount += 1
          await onChunk({
            startRow: chunk.startRow,
            endRow: chunk.endRow,
            text: chunk.chunk,
          })
        },
        request.rowsPerChunk,
      )
    } else {
      const text = await client.exportRangeTsv(sparseRange)
      estimatedBytes = estimateUtf8Bytes(text)
      await onChunk({
        startRow: request.range.rowStart,
        endRow: request.range.rowEnd,
        text,
      })
    }

    return {
      kind: 'range-tsv-chunks',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? revision,
      range: { ...request.range },
      originAddr: toA1(request.range.rowStart, request.range.colStart),
      estimatedBytes,
    }
  }

  async function exportRangeTsv(request: RangeTsvExportRequest): Promise<RangeTsvExportResult> {
    const chunks: string[] = []
    const result = await consumeExportRangeTsvChunks(request, (chunk) => {
      chunks.push(chunk.text)
    })
    const text = chunks.join('\n')

    return {
      kind: 'range-tsv',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: result.revision,
      range: result.range,
      originAddr: result.originAddr,
      text,
      estimatedBytes: result.estimatedBytes ?? estimateUtf8Bytes(text),
    }
  }

  async function importChunks(request: ImportCellChunksRequest): Promise<BackendMutationResult> {
    const sheet = await resolveSheet(request.sheetId)
    const cellsPerChunk = normalizeImportCellsPerChunk(request.cellsPerChunk)
    const sessionId = await client.beginImport({ mode: 'direct' })
    const wireChunk: ImportCellWire[] = []
    let committed = false

    async function flush() {
      if (wireChunk.length === 0) return
      await client.importChunk(sessionId, wireChunk.splice(0, wireChunk.length))
    }

    try {
      for await (const sourceChunk of request.chunks) {
        for (const cell of sourceChunk) {
          wireChunk.push(toImportCellWire(sheet.idx, cell.row, cell.col, cell.input))
          if (wireChunk.length >= cellsPerChunk) await flush()
        }
      }
      await flush()
      const stats = await client.commitImport(sessionId)
      committed = true
      assertImportStatsOk(stats)
    } finally {
      if (!committed) await client.cancelImport(sessionId).catch(() => {})
    }

    const nextRevision = bumpRevision()
    return {
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? nextRevision,
      affectedRange: request.range,
    }
  }

  async function resolveWorkerDataEdge(
    request: ResolveDataEdgeRequest,
  ): Promise<ResolveDataEdgeResult> {
    const sheet = await resolveSheet(request.sheetId)
    const rowCount = normalizeCount(request.bounds.rowCount)
    const colCount = normalizeCount(request.bounds.colCount)
    const from = {
      row: clampIndex(request.from.row, rowCount),
      col: clampIndex(request.from.col, colCount),
    }

    if (request.direction === 'left' || request.direction === 'right') {
      const cells = await client.snapshotRangeSparse({
        sheet: sheet.idx,
        startRow: from.row,
        endRow: from.row,
        startCol: 0,
        endCol: colCount - 1,
      })
      const occupiedCols = uniqueSortedIndexes(
        cells.map((cell: SparseCellWire) => clampIndex(cell.col, colCount)),
      )
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? revision,
        target: {
          row: from.row,
          col: resolveLineDataEdge(
            from.col,
            occupiedCols,
            colCount - 1,
            request.direction === 'right' ? 1 : -1,
          ),
        },
      }
    }

    const cells = await client.snapshotRangeSparse({
      sheet: sheet.idx,
      startRow: 0,
      endRow: rowCount - 1,
      startCol: from.col,
      endCol: from.col,
    })
    const occupiedRows = uniqueSortedIndexes(
      cells.map((cell: SparseCellWire) => clampIndex(cell.row, rowCount)),
    )
    return {
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? revision,
      target: {
        row: resolveLineDataEdge(
          from.row,
          occupiedRows,
          rowCount - 1,
          request.direction === 'down' ? 1 : -1,
        ),
        col: from.col,
      },
    }
  }

  return {
    async listSheets() {
      await refreshSheetLookup()
      return {
        revision,
        sheets: toSheetMetadata(lookup.sheets),
      }
    },

    async readVisibleProjection(
      request: VisibleProjectionRequest,
    ): Promise<VisibleProjectionResult> {
      const result = await readRange(request.sheetId, request.window, request.revision)

      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: result.revision,
        window: { ...request.window },
        cells: result.cells,
      }
    },

    async readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult> {
      const result = await readRange(request.sheetId, request.range, request.revision)

      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: result.revision,
        range: { ...request.range },
        cells: result.cells,
      }
    },

    async exportRangeTsv(request: RangeTsvExportRequest): Promise<RangeTsvExportResult> {
      return exportRangeTsv(request)
    },

    async consumeExportRangeTsvChunks(
      request: RangeTsvExportRequest,
      onChunk: RangeTsvChunkConsumer,
    ): Promise<RangeTsvChunkExportResult> {
      return consumeExportRangeTsvChunks(request, onChunk)
    },

    async readViewportSizeProjection(
      request: ViewportSizeProjectionRequest,
    ): Promise<ViewportSizeProjectionResult> {
      return readViewportSizeProjection(request)
    },

    async setCellInput(request: SetCellInputRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const addr = toA1(request.row, request.col)
      const trimmed = request.input.trim()

      if (trimmed === '') {
        await client.clearCell(sheet.idx, addr)
      } else if (trimmed.startsWith('=')) {
        const result = await client.setFormulaDetailed(sheet.idx, addr, trimmed)
        if (!result.ok) throw createBackendError(result.code, result.message)
      } else {
        await client.setCell(sheet.idx, addr, toCellWire(request.input))
      }

      const nextRevision = bumpRevision()
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    },

    async importCells(request: ImportCellsRequest): Promise<BackendMutationResult> {
      return importChunks({
        ...request,
        kind: 'import-cell-chunks',
        chunks: [request.cells],
      })
    },

    async importCellChunks(request: ImportCellChunksRequest): Promise<BackendMutationResult> {
      return importChunks(request)
    },

    async clearRange(request: ClearRangeRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const target = request.target ?? 'all'
      const sparseRange = toSparseRange(sheet.idx, request.range)

      if (target === 'values' || target === 'all') {
        await client.clearRange(sparseRange)
      }
      if (target === 'formats' || target === 'all') {
        // Rust set_format_range drops per-cell overrides inside the range and a
        // null/default layer makes the rectangle read back as unformatted,
        // which is the contract for 'formats'/'all' clearing.
        await client.setFormatRange(sparseRange, null)
      }
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },

    async insertRows(request: InsertRowsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.insertRows(sheet.idx, request.rowIndex, request.count)
      return structuralMutationResult(request, bumpRevision())
    },

    async deleteRows(request: DeleteRowsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.deleteRows(sheet.idx, request.rowIndex, request.count)
      return structuralMutationResult(request, bumpRevision())
    },

    async insertColumns(request: InsertColumnsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.insertColumns(sheet.idx, request.colIndex, request.count)
      return structuralMutationResult(request, bumpRevision())
    },

    async deleteColumns(request: DeleteColumnsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.deleteColumns(sheet.idx, request.colIndex, request.count)
      return structuralMutationResult(request, bumpRevision())
    },

    async setFormatRange(request: SetFormatRangeRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.setFormatRange(
        toSparseRange(sheet.idx, request.range),
        request.format as CellFormatJSON | null | undefined,
      )
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },

    async setRowHeight(request: SetRowHeightRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.setRowHeight(
        sheet.idx,
        request.rowIndex,
        normalizeDimensionSize(request.heightPx),
      )
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    async setColumnWidth(request: SetColumnWidthRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.setColumnWidth(
        sheet.idx,
        request.colIndex,
        normalizeDimensionSize(request.widthPx),
      )
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    async resolveDataEdge(request: ResolveDataEdgeRequest): Promise<ResolveDataEdgeResult> {
      return resolveWorkerDataEdge(request)
    },

    async addSheet(request): Promise<SheetMutationResult> {
      await readyPromise
      const name = normalizeSheetName(request.name, nextSheetName())
      const addedIdx = await client.addSheet(name)
      const nextRevision = bumpRevision()
      await refreshSheetLookup(lookup.sheets)
      const createdSheet =
        lookup.sheets.find((sheet) => sheet.idx === addedIdx) ?? lookup.sheets.at(-1)
      const createdIndex = createdSheet
        ? lookup.sheets.findIndex((sheet) => sheet.id === createdSheet.id)
        : -1
      const createdMetadata = createdSheet
        ? { id: createdSheet.id, name: createdSheet.name, index: Math.max(createdIndex, 0) }
        : undefined

      return sheetMutationResult(request.requestId, {
        sheetId: createdMetadata?.id,
        activeSheetId: createdMetadata?.id ?? null,
        revision: request.revision ?? nextRevision,
        createdSheet: createdMetadata,
      })
    },

    async renameSheet(request): Promise<SheetMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const name = normalizeSheetName(request.name, '')

      if (name.length === 0) {
        throw createBackendError('INVALID_SHEET_NAME', 'sheet name cannot be empty')
      }

      const ok = await client.renameSheet(sheet.idx, name)
      if (!ok) {
        throw createBackendError('SHEET_RENAME_FAILED', `cannot rename sheet to: ${name}`)
      }

      const nextRevision = bumpRevision()
      const optimisticSheets = lookup.sheets.map((item) =>
        item.id === request.sheetId ? { ...item, name } : item,
      )
      await refreshSheetLookup(optimisticSheets)

      return sheetMutationResult(request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
        revision: request.revision ?? nextRevision,
      })
    },

    async deleteSheet(request): Promise<SheetMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const deleteDisplayIndex = lookup.sheets.findIndex((item) => item.id === request.sheetId)

      if (lookup.sheets.length <= 1) {
        throw createBackendError('SHEET_DELETE_FAILED', 'cannot delete the last sheet')
      }

      const ok = await client.removeSheet(sheet.idx)
      if (!ok) {
        throw createBackendError('SHEET_DELETE_FAILED', `cannot delete sheet: ${request.sheetId}`)
      }

      const nextRevision = bumpRevision()
      const remainingSheets = lookup.sheets.filter((item) => item.id !== request.sheetId)
      await refreshSheetLookup(remainingSheets)
      const activeSheetId =
        lookup.sheets[Math.min(Math.max(deleteDisplayIndex, 0), lookup.sheets.length - 1)]?.id ??
        null

      return sheetMutationResult(request.requestId, {
        sheetId: request.sheetId,
        activeSheetId,
        revision: request.revision ?? nextRevision,
      })
    },

    async reorderSheet(request: ReorderSheetRequest): Promise<SheetMutationResult> {
      await resolveSheet(request.sheetId)
      const nextSheets = reorderSheetMetadata(toSheetMetadata(lookup.sheets), request)
      const fromIndex = lookup.sheets.findIndex((sheet) => sheet.id === request.sheetId)
      const toIndex = nextSheets.findIndex((sheet) => sheet.id === request.sheetId)
      const changed = fromIndex !== toIndex

      if (fromIndex < 0 || toIndex < 0) {
        throw createBackendError('SHEET_REORDER_FAILED', `cannot reorder sheet: ${request.sheetId}`)
      }

      let nextRevision = revision
      if (changed) {
        const ok = await client.moveSheet(lookup.sheets[fromIndex].idx, toIndex)
        if (!ok) {
          throw createBackendError(
            'SHEET_REORDER_FAILED',
            `cannot reorder sheet: ${request.sheetId}`,
          )
        }
        nextRevision = bumpRevision()
        await refreshSheetLookup(lookup.sheets)
      }

      return sheetMutationResult(request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
        revision: request.revision ?? nextRevision,
      })
    },

    async listNamedRanges(request: ListNamedRangesRequest): Promise<NamedRangeListResult> {
      return {
        requestId: request.requestId,
        revision: request.revision ?? revision,
        names: namedRanges.map(cloneNamedRange),
      }
    },

    async setNamedRange(request: SetNamedRangeRequest): Promise<NamedRangeMutationResult> {
      const name = request.name.trim()
      if (name.length === 0) throw createBackendError('INVALID_NAME', 'name cannot be empty')
      const entry: NamedRange = {
        name,
        scope: request.scope === 'workbook' ? 'workbook' : { sheetId: request.scope.sheetId },
        refersTo: { ...request.refersTo },
      }
      const existingIndex = namedRanges.findIndex(
        (item) => item.name === name && namedRangeScopeEquals(item.scope, request.scope),
      )
      namedRanges =
        existingIndex >= 0
          ? namedRanges.map((item, index) => (index === existingIndex ? entry : item))
          : [...namedRanges, entry]
      const nextRevision = bumpRevision()
      return {
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    async deleteNamedRange(request: DeleteNamedRangeRequest): Promise<NamedRangeMutationResult> {
      const next = namedRanges.filter(
        (item) => !(item.name === request.name && namedRangeScopeEquals(item.scope, request.scope)),
      )
      namedRanges = next
      const nextRevision = bumpRevision()
      return {
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    async setValidationRule(request: SetValidationRuleRequest): Promise<BackendMutationResult> {
      const range = normalizeRange(request.range)
      const current = validationRulesBySheetId.get(request.sheetId) ?? []
      const next = current
        .filter((rule) => !rangesIntersect(rule.range, range))
        .concat({ range, rule: cloneValidationRule(request.rule), mode: request.mode })
      validationRulesBySheetId.set(request.sheetId, next)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? bumpRevision(),
        affectedRange: cloneRange(range),
      }
    },

    async clearValidationRule(
      request: ClearValidationRuleRequest,
    ): Promise<BackendMutationResult> {
      const range = normalizeRange(request.range)
      const current = validationRulesBySheetId.get(request.sheetId) ?? []
      validationRulesBySheetId.set(
        request.sheetId,
        current.filter((rule) => !rangesIntersect(rule.range, range)),
      )
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? bumpRevision(),
        affectedRange: cloneRange(range),
      }
    },

    async listConditionalFormatRules(
      request: ListConditionalFormatRulesRequest,
    ): Promise<ConditionalFormatRulesResult> {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? revision,
        rules: (conditionalFormatRulesBySheetId.get(request.sheetId) ?? [])
          .map(cloneConditionalFormatRuleEntry)
          .sort((left, right) => left.priority - right.priority),
      }
    },

    async setConditionalFormatRule(
      request: SetConditionalFormatRuleRequest,
    ): Promise<BackendMutationResult> {
      const current = conditionalFormatRulesBySheetId.get(request.sheetId) ?? []
      const existingIndex = request.ruleId
        ? current.findIndex((entry) => entry.id === request.ruleId)
        : -1
      const entry: ConditionalFormatRuleEntry = {
        id:
          existingIndex >= 0
            ? current[existingIndex].id
            : request.ruleId ?? nextConditionalFormatRuleId(current),
        scope: { range: normalizeRange(request.scope.range) },
        priority:
          request.priority ??
          (existingIndex >= 0 ? current[existingIndex].priority : current.length),
        rule: cloneConditionalFormatRule(request.rule),
      }
      const next =
        existingIndex >= 0
          ? current.map((item, index) => (index === existingIndex ? entry : item))
          : [...current, entry]
      conditionalFormatRulesBySheetId.set(
        request.sheetId,
        next.map((item, index) => ({ ...item, priority: item.priority ?? index })),
      )
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? bumpRevision(),
        affectedRange: cloneRange(entry.scope.range),
      }
    },

    async removeConditionalFormatRule(
      request: RemoveConditionalFormatRuleRequest,
    ): Promise<BackendMutationResult> {
      const current = conditionalFormatRulesBySheetId.get(request.sheetId) ?? []
      conditionalFormatRulesBySheetId.set(
        request.sheetId,
        current.filter((entry) => entry.id !== request.ruleId),
      )
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? bumpRevision(),
      }
    },

    async setFilterSort(request: SetFilterSortRequest): Promise<BackendMutationResult> {
      const next = cloneFilterSortState({
        rules: request.rules,
        directives: request.directives,
      })
      if (filterSortHasEffect(next)) {
        filterSortBySheetId.set(request.sheetId, next)
      } else {
        filterSortBySheetId.delete(request.sheetId)
      }
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? bumpRevision(),
      }
    },

    ready() {
      return readyPromise
    },

    sheets() {
      return lookup.sheets.map((sheet) => ({ ...sheet }))
    },

    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      offDirty()
      client.dispose()
    },
  }
}
