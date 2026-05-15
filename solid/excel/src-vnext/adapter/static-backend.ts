import type {
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  FillRangeRequest,
  ImportCellChunksRequest,
  ImportCellsRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  CellRange,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  ClearRangeRequest,
  ReorderSheetRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
  SetColumnWidthRequest,
  SetFormatRangeRequest,
  SetRowHeightRequest,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  reorderSheetMetadata,
} from '@einfach/spreadsheet-ui-core'
import type {
  StaticProjectionRequest,
  StaticProjectionResult,
  StaticSeedCells,
  StaticSeedMatrix,
  StaticSeedValue,
  StaticSpreadsheetSeedInput,
  StaticSpreadsheetSheetInput,
} from './types'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSeedCell(value: unknown): value is DisplayCell {
  return (
    isObject(value) &&
    typeof value.row === 'number' &&
    typeof value.col === 'number' &&
    typeof value.displayValue === 'string'
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
  if (cell.error) clone.error = cell.error
  if (cell.formatKey !== undefined) clone.formatKey = cell.formatKey
  if (cell.format) clone.format = cloneFormat(cell.format)
  if (cell.mergedSpan) clone.mergedSpan = { ...cell.mergedSpan }
  if (cell.mergeAnchor) clone.mergeAnchor = { ...cell.mergeAnchor }

  return clone
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
    (format.fgColor === undefined || format.fgColor.length === 0) &&
    (format.bgColor === undefined || format.bgColor.length === 0) &&
    numberFormatIsDefault
  )
}

function stripCellFormat(cell: DisplayCell): DisplayCell {
  const clone = cloneCell(cell)
  delete clone.format
  delete clone.mergedSpan
  delete clone.mergeAnchor
  return clone
}

function keyFor(row: number, col: number): string {
  return `${row}:${col}`
}

function parseKey(key: string): { row: number; col: number } | null {
  const [rowPart, colPart] = key.split(':')
  const row = Number(rowPart)
  const col = Number(colPart)
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null
  return { row, col }
}

function compareCells(left: DisplayCell, right: DisplayCell): number {
  return left.row === right.row ? left.col - right.col : left.row - right.row
}

function normalizeRange(range: CellRange): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

function cloneRange(range: CellRange): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
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

function extractMergeRanges(cells: readonly DisplayCell[], sheetId: string): Map<string, CellRange[]> {
  const ranges: CellRange[] = []
  for (const cell of cells) {
    if (!cell.mergedSpan) continue
    const rows = Math.max(1, Math.trunc(cell.mergedSpan.rows))
    const cols = Math.max(1, Math.trunc(cell.mergedSpan.cols))
    if (rows === 1 && cols === 1) continue
    ranges.push({
      rowStart: cell.row,
      rowEnd: cell.row + rows - 1,
      colStart: cell.col,
      colEnd: cell.col + cols - 1,
    })
  }

  return ranges.length > 0 ? new Map([[sheetId, ranges]]) : new Map()
}

function getMergeRanges(state: StaticBackendState, sheetId: string): CellRange[] {
  let ranges = state.mergeRangesBySheetId.get(sheetId)
  if (!ranges) {
    ranges = []
    state.mergeRangesBySheetId.set(sheetId, ranges)
  }
  return ranges
}

function upsertBlankCell(cells: Map<string, DisplayCell>, row: number, col: number): DisplayCell {
  const key = keyFor(row, col)
  let cell = cells.get(key)
  if (!cell) {
    cell = {
      row,
      col,
      displayValue: '',
      valueKind: 'blank',
    }
    cells.set(key, cell)
  }
  return cell
}

function applyMergeMetadata(
  cells: Map<string, DisplayCell>,
  projectionRange: CellRange,
  mergeRanges: readonly CellRange[],
) {
  for (const mergeRange of mergeRanges) {
    if (!rangesIntersect(mergeRange, projectionRange)) continue

    if (isCoordInsideRange(mergeRange.rowStart, mergeRange.colStart, projectionRange)) {
      const anchor = upsertBlankCell(cells, mergeRange.rowStart, mergeRange.colStart)
      delete anchor.mergeAnchor
      anchor.mergedSpan = {
        rows: mergeRange.rowEnd - mergeRange.rowStart + 1,
        cols: mergeRange.colEnd - mergeRange.colStart + 1,
      }
    }

    const rowStart = Math.max(mergeRange.rowStart, projectionRange.rowStart)
    const rowEnd = Math.min(mergeRange.rowEnd, projectionRange.rowEnd)
    const colStart = Math.max(mergeRange.colStart, projectionRange.colStart)
    const colEnd = Math.min(mergeRange.colEnd, projectionRange.colEnd)

    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        if (row === mergeRange.rowStart && col === mergeRange.colStart) continue
        const covered = upsertBlankCell(cells, row, col)
        delete covered.mergedSpan
        covered.mergeAnchor = { row: mergeRange.rowStart, col: mergeRange.colStart }
      }
    }
  }
}

type SparseTsvCell = {
  row: number
  col: number
  kind: 'number' | 'text' | 'boolean' | 'error' | 'formula'
  value: string | number | boolean
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

function sparseTsvCellField(cell: SparseTsvCell): string {
  if (cell.kind === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
  return String(cell.value)
}

function sparseCellsToTsv(cells: SparseTsvCell[], range: CellRange): string {
  const fields = new Map<string, string>()
  for (const cell of cells) {
    if (!isCoordInsideRange(cell.row, cell.col, range)) continue
    fields.set(keyFor(cell.row, cell.col), sparseTsvCellField(cell))
  }

  const rows: string[] = []
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    const fieldsInRow: string[] = []
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      fieldsInRow.push(fields.get(keyFor(row, col)) ?? '')
    }
    rows.push(fieldsInRow.join('\t'))
  }
  return rows.join('\n')
}

interface RangeFormatLayer {
  range: {
    rowStart: number
    rowEnd: number
    colStart: number
    colEnd: number
  }
  format: SpreadsheetCellFormat
}

interface StaticBackendState {
  cells: Map<string, DisplayCell>
  cellFormats: Map<string, SpreadsheetCellFormat>
  rangeFormats: RangeFormatLayer[]
  mergeRangesBySheetId: Map<string, CellRange[]>
  rowHeightsBySheetId: Map<string, Map<number, number>>
  colWidthsBySheetId: Map<string, Map<number, number>>
  sheets: SpreadsheetSheetMetadata[]
  revision: ProjectionRevision
}

function valueToDisplayCell(row: number, col: number, value: StaticSeedValue): DisplayCell | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    return { row, col, displayValue: value, valueKind: 'string' }
  }
  if (typeof value === 'number') {
    return {
      row,
      col,
      displayValue: Number.isFinite(value) ? String(value) : String(value),
      valueKind: 'number',
    }
  }
  if (typeof value === 'boolean') {
    return { row, col, displayValue: value ? 'TRUE' : 'FALSE', valueKind: 'boolean' }
  }
  return null
}

function matrixToCells(matrix: StaticSeedMatrix): DisplayCell[] {
  const cells: DisplayCell[] = []

  matrix.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const cell = valueToDisplayCell(rowIndex, colIndex, value)
      if (cell) cells.push(cell)
    })
  })

  return cells
}

function sparseCellsToCells(cells: StaticSeedCells): DisplayCell[] {
  return cells
    .filter(isSeedCell)
    .map(cloneCell)
    .sort(compareCells)
}

function buildState(
  cells: DisplayCell[],
  revision: ProjectionRevision,
  sheets: SpreadsheetSheetMetadata[] = normalizeStaticSheets(),
): StaticBackendState {
  const cellMap = new Map<string, DisplayCell>()
  const cellFormats = new Map<string, SpreadsheetCellFormat>()
  const mergeRangesBySheetId = extractMergeRanges(cells, sheets[0]?.id ?? 'sheet-1')

  for (const cell of cells) {
    const key = keyFor(cell.row, cell.col)
    const format = normalizeFormat(cell.format)
    if (format) cellFormats.set(key, format)
    cellMap.set(key, stripCellFormat(cell))
  }

  return {
    cells: cellMap,
    cellFormats,
    rangeFormats: [],
    mergeRangesBySheetId,
    rowHeightsBySheetId: new Map(),
    colWidthsBySheetId: new Map(),
    sheets,
    revision,
  }
}

function toA1(row: number, col: number): string {
  let current = col + 1
  let label = ''

  while (current > 0) {
    const remainder = (current - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    current = Math.floor((current - 1) / 26)
  }

  return `${label}${row + 1}`
}

function displayCellToSparseTsvCell(cell: DisplayCell): SparseTsvCell {
  if (cell.formula !== undefined) {
    return {
      row: cell.row,
      col: cell.col,
      kind: 'formula',
      value: cell.formula,
    }
  }

  switch (cell.valueKind) {
    case 'number':
      return {
        row: cell.row,
        col: cell.col,
        kind: 'number',
        value: Number(cell.displayValue),
      }
    case 'boolean':
      return {
        row: cell.row,
        col: cell.col,
        kind: 'boolean',
        value: cell.displayValue === 'TRUE',
      }
    case 'error':
      return {
        row: cell.row,
        col: cell.col,
        kind: 'error',
        value: cell.displayValue,
      }
    default:
      return {
        row: cell.row,
        col: cell.col,
        kind: 'text',
        value: cell.displayValue,
      }
  }
}

function exportRangeTsvFromState(
  state: StaticBackendState,
  request: RangeTsvExportRequest,
): RangeTsvExportResult {
  const cells = [...state.cells.values()]
    .filter((cell) => isCellInsideRange(cell, request.range))
    .sort(compareCells)
    .map(displayCellToSparseTsvCell)
  const text = sparseCellsToTsv(cells, request.range)

  return {
    kind: 'range-tsv',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? state.revision,
    range: {
      rowStart: request.range.rowStart,
      rowEnd: request.range.rowEnd,
      colStart: request.range.colStart,
      colEnd: request.range.colEnd,
    },
    originAddr: toA1(request.range.rowStart, request.range.colStart),
    text,
    estimatedBytes: estimateUtf8Bytes(text),
  }
}

function normalizeSeed(input: StaticSpreadsheetSeedInput): StaticBackendState {
  if (Array.isArray(input)) {
    const cells = input.length > 0 && input.some((item) => Array.isArray(item))
      ? matrixToCells(input as StaticSeedMatrix)
      : sparseCellsToCells(input as StaticSeedCells)

    return buildState(cells, 0)
  }

  const seed = input as StaticSpreadsheetSeedInput & {
    cells?: StaticSeedCells
    matrix?: StaticSeedMatrix
    revision?: ProjectionRevision
    sheets?: readonly (string | StaticSpreadsheetSheetInput)[]
  }
  const cells = [
    ...(seed.matrix ? matrixToCells(seed.matrix) : []),
    ...(seed.cells ? sparseCellsToCells(seed.cells) : []),
  ]

  return buildState(cells, seed.revision ?? 0, normalizeStaticSheets(seed.sheets))
}

function normalizeStaticSheets(
  sheets: readonly (string | StaticSpreadsheetSheetInput)[] | undefined = undefined,
): SpreadsheetSheetMetadata[] {
  const input = sheets && sheets.length > 0 ? sheets : ['Sheet1']
  const normalized: SpreadsheetSheetMetadata[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()

  input.forEach((sheet, index) => {
    const id = typeof sheet === 'string' ? `sheet-${index + 1}` : sheet.id ?? `sheet-${index + 1}`
    const name = typeof sheet === 'string' ? sheet : sheet.name
    const normalizedId = id.trim()
    const normalizedName = name.trim()

    if (
      normalizedId.length === 0 ||
      normalizedName.length === 0 ||
      seenIds.has(normalizedId) ||
      seenNames.has(normalizedName)
    ) {
      return
    }

    seenIds.add(normalizedId)
    seenNames.add(normalizedName)
    normalized.push({
      id: normalizedId,
      name: normalizedName,
      index: normalized.length,
    })
  })

  return normalized.length > 0 ? normalized : [{ id: 'sheet-1', name: 'Sheet1', index: 0 }]
}

function cloneSheets(sheets: readonly SpreadsheetSheetMetadata[]): SpreadsheetSheetMetadata[] {
  return sheets.map((sheet, index) => ({
    id: sheet.id,
    name: sheet.name,
    index,
  }))
}

function createNextSheetId(sheets: readonly SpreadsheetSheetMetadata[]): string {
  const used = new Set(sheets.map((sheet) => sheet.id))
  let index = sheets.length + 1
  let id = `sheet-${index}`

  while (used.has(id)) {
    index += 1
    id = `sheet-${index}`
  }

  return id
}

function createNextSheetName(sheets: readonly SpreadsheetSheetMetadata[]): string {
  const used = new Set(sheets.map((sheet) => sheet.name))
  let index = sheets.length + 1
  let name = `Sheet${index}`

  while (used.has(name)) {
    index += 1
    name = `Sheet${index}`
  }

  return name
}

function normalizeSheetMutationName(
  name: string | undefined,
  fallback: string,
): string {
  const normalized = name?.trim() ?? ''
  return normalized.length > 0 ? normalized : fallback
}

function assertUniqueSheetName(
  sheets: readonly SpreadsheetSheetMetadata[],
  name: string,
  exceptSheetId?: string,
) {
  const exists = sheets.some((sheet) => sheet.id !== exceptSheetId && sheet.name === name)
  if (exists) {
    throw new Error(`sheet name already exists: ${name}`)
  }
}

function reindexSheets(sheets: readonly SpreadsheetSheetMetadata[]): SpreadsheetSheetMetadata[] {
  return sheets.map((sheet, index) => ({ ...sheet, index }))
}

function hasSameSheetOrder(
  left: readonly SpreadsheetSheetMetadata[],
  right: readonly SpreadsheetSheetMetadata[],
): boolean {
  return left.length === right.length && left.every((sheet, index) => sheet.id === right[index]?.id)
}

function normalizeDimensionSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.round(value))
}

function shiftDimensionMap(
  sizes: Map<number, number>,
  index: number,
  count: number,
  direction: 1 | -1,
) {
  const next = new Map<number, number>()
  const deleteEnd = index + count - 1

  for (const [sizeIndex, size] of sizes) {
    if (direction === -1 && sizeIndex >= index && sizeIndex <= deleteEnd) {
      continue
    }

    const nextIndex =
      sizeIndex >= (direction === 1 ? index : deleteEnd + 1)
        ? sizeIndex + count * direction
        : sizeIndex
    if (nextIndex >= 0) {
      next.set(nextIndex, size)
    }
  }

  sizes.clear()
  for (const [sizeIndex, size] of next) sizes.set(sizeIndex, size)
}

function getDimensionMap(
  sizesBySheetId: Map<string, Map<number, number>>,
  sheetId: string,
): Map<number, number> {
  let sizes = sizesBySheetId.get(sheetId)
  if (!sizes) {
    sizes = new Map()
    sizesBySheetId.set(sheetId, sizes)
  }
  return sizes
}

function sheetMutationResult(
  state: StaticBackendState,
  requestId: number | undefined,
  extra: Partial<SheetMutationResult> = {},
): SheetMutationResult {
  const { revision: resultRevision, ...rest } = extra
  return {
    ...rest,
    requestId,
    revision: resultRevision ?? state.revision,
    sheets: cloneSheets(state.sheets),
  }
}

function isCellInsideRange(cell: DisplayCell, range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }): boolean {
  return (
    cell.row >= range.rowStart &&
    cell.row <= range.rowEnd &&
    cell.col >= range.colStart &&
    cell.col <= range.colEnd
  )
}

function isCoordInsideRange(
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

function getEffectiveFormat(
  row: number,
  col: number,
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
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

function addFormatOnlyCells(
  resultCells: Map<string, DisplayCell>,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
) {
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(row, col)
      const existing = resultCells.get(key)
      const format = getEffectiveFormat(row, col, cellFormats, rangeFormats)

      if (existing) {
        if (format) existing.format = format
      } else if (format) {
        resultCells.set(key, {
          row,
          col,
          displayValue: '',
          valueKind: 'blank',
          format,
        })
      }
    }
  }
}

function buildProjectionResult(
  request: StaticProjectionRequest,
  state: StaticBackendState,
): StaticProjectionResult {
  const range = request.kind === 'visible-window' ? request.window : request.range
  const resultCellMap = new Map<string, DisplayCell>()

  for (const cell of state.cells.values()) {
    if (!isCellInsideRange(cell, range)) continue
    const clone = cloneCell(cell)
    const format = getEffectiveFormat(cell.row, cell.col, state.cellFormats, state.rangeFormats)
    if (format) clone.format = format
    resultCellMap.set(keyFor(clone.row, clone.col), clone)
  }

  addFormatOnlyCells(resultCellMap, range, state.cellFormats, state.rangeFormats)
  applyMergeMetadata(
    resultCellMap,
    range,
    state.mergeRangesBySheetId.get(request.sheetId) ?? [],
  )
  const resultCells = [...resultCellMap.values()].sort(compareCells)

  if (request.kind === 'visible-window') {
    const result: VisibleProjectionResult = {
      kind: 'visible-window',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? state.revision,
      window: {
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        colStart: range.colStart,
        colEnd: range.colEnd,
      },
      cells: resultCells,
    }
    return result
  }

  const result: RangeProjectionResult = {
    kind: 'range',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? state.revision,
    range: {
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      colStart: range.colStart,
      colEnd: range.colEnd,
    },
    cells: resultCells,
  }
  return result
}

function buildViewportSizeProjectionResult(
  request: ViewportSizeProjectionRequest,
  state: StaticBackendState,
): ViewportSizeProjectionResult {
  const rowHeights = [...(state.rowHeightsBySheetId.get(request.sheetId) ?? new Map()).entries()]
    .filter(([rowIndex]) => rowIndex >= request.window.rowStart && rowIndex <= request.window.rowEnd)
    .map(([rowIndex, heightPx]) => ({ rowIndex, heightPx }))
    .sort((left, right) => left.rowIndex - right.rowIndex)
  const colWidths = [...(state.colWidthsBySheetId.get(request.sheetId) ?? new Map()).entries()]
    .filter(([colIndex]) => colIndex >= request.window.colStart && colIndex <= request.window.colEnd)
    .map(([colIndex, widthPx]) => ({ colIndex, widthPx }))
    .sort((left, right) => left.colIndex - right.colIndex)

  return {
    kind: 'viewport-size',
    sheetId: request.sheetId,
    window: { ...request.window },
    requestId: request.requestId,
    revision: request.revision ?? state.revision,
    rowHeights,
    colWidths,
  }
}

function bumpRevision(revision: ProjectionRevision): ProjectionRevision {
  if (typeof revision === 'number' && Number.isFinite(revision)) {
    return revision + 1
  }
  return revision
}

function updateCell(
  cells: Map<string, DisplayCell>,
  request: SetCellInputRequest,
): DisplayCell | null {
  if (request.input.length === 0) {
    cells.delete(keyFor(request.row, request.col))
    return null
  }

  const cell: DisplayCell = {
    row: request.row,
    col: request.col,
    displayValue: request.input,
    valueKind: 'string',
  }

  cells.set(keyFor(request.row, request.col), cell)
  return cell
}

function clearRange(cells: Map<string, DisplayCell>, request: ClearRangeRequest): number {
  let cleared = 0

  for (const [key, cell] of [...cells.entries()]) {
    if (isCellInsideRange(cell, request.range)) {
      cells.delete(key)
      cleared += 1
    }
  }

  return cleared
}

function applyFillRange(state: StaticBackendState, request: FillRangeRequest): number {
  const writeRange = getFillHandleWriteRange(
    request.sourceRange,
    request.targetRange,
    request.direction,
  )
  if (writeRange === null) {
    return 0
  }

  const sourceCells = new Map<string, DisplayCell>()
  for (const cell of state.cells.values()) {
    if (isCellInsideRange(cell, request.sourceRange)) {
      sourceCells.set(keyFor(cell.row, cell.col), cloneCell(cell))
    }
  }

  let changed = 0
  for (let row = writeRange.rowStart; row <= writeRange.rowEnd; row += 1) {
    for (let col = writeRange.colStart; col <= writeRange.colEnd; col += 1) {
      const sourceCoord = getFillHandleSourceCoord(request.sourceRange, { row, col })
      const sourceKey = keyFor(sourceCoord.row, sourceCoord.col)
      const sourceCell = sourceCells.get(sourceKey)
      const targetKey = keyFor(row, col)

      if (sourceCell) {
        state.cells.set(targetKey, {
          ...cloneCell(sourceCell),
          row,
          col,
        })
      } else {
        state.cells.delete(targetKey)
      }

      const sourceFormat = getEffectiveFormat(
        sourceCoord.row,
        sourceCoord.col,
        state.cellFormats,
        state.rangeFormats,
      )
      if (sourceFormat) {
        state.cellFormats.set(targetKey, sourceFormat)
      } else {
        state.cellFormats.delete(targetKey)
      }

      changed += 1
    }
  }

  return changed
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

function isNonBlankCell(cell: DisplayCell): boolean {
  return cell.formula !== undefined || cell.displayValue.length > 0
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

function resolveStaticDataEdge(
  state: StaticBackendState,
  request: ResolveDataEdgeRequest,
): ResolveDataEdgeResult {
  const rowCount = normalizeCount(request.bounds.rowCount)
  const colCount = normalizeCount(request.bounds.colCount)
  const from = {
    row: clampIndex(request.from.row, rowCount),
    col: clampIndex(request.from.col, colCount),
  }

  if (request.direction === 'left' || request.direction === 'right') {
    const occupiedCols = [...state.cells.values()]
      .filter((cell) => cell.row === from.row && isNonBlankCell(cell))
      .map((cell) => clampIndex(cell.col, colCount))
      .sort((left, right) => left - right)
    return {
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? state.revision,
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

  const occupiedRows = [...state.cells.values()]
    .filter((cell) => cell.col === from.col && isNonBlankCell(cell))
    .map((cell) => clampIndex(cell.row, rowCount))
    .sort((left, right) => left - right)

  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? state.revision,
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

function clearCellFormatsInRange(
  cellFormats: Map<string, SpreadsheetCellFormat>,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
) {
  for (const [key] of [...cellFormats.entries()]) {
    const coord = parseKey(key)
    if (coord && isCoordInsideRange(coord.row, coord.col, range)) {
      cellFormats.delete(key)
    }
  }
}

function shiftRows(
  cells: Map<string, DisplayCell>,
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
  rowIndex: number,
  count: number,
  direction: 1 | -1,
) {
  const next = new Map<string, DisplayCell>()
  const nextFormats = new Map<string, SpreadsheetCellFormat>()
  const deleteEnd = rowIndex + count - 1

  for (const cell of cells.values()) {
    if (direction === -1 && cell.row >= rowIndex && cell.row <= deleteEnd) {
      continue
    }
    const row =
      cell.row >= (direction === 1 ? rowIndex : deleteEnd + 1)
        ? cell.row + count * direction
        : cell.row
    const shifted = { ...cloneCell(cell), row }
    next.set(keyFor(shifted.row, shifted.col), shifted)
  }

  cells.clear()
  for (const [key, cell] of next) cells.set(key, cell)

  for (const [key, format] of cellFormats) {
    const coord = parseKey(key)
    if (!coord) continue
    if (direction === -1 && coord.row >= rowIndex && coord.row <= deleteEnd) {
      continue
    }
    const row =
      coord.row >= (direction === 1 ? rowIndex : deleteEnd + 1)
        ? coord.row + count * direction
        : coord.row
    nextFormats.set(keyFor(row, coord.col), cloneFormat(format))
  }

  cellFormats.clear()
  for (const [key, format] of nextFormats) cellFormats.set(key, format)

  shiftRangeFormats(rangeFormats, 'row', rowIndex, count, direction)
}

function shiftColumns(
  cells: Map<string, DisplayCell>,
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
  colIndex: number,
  count: number,
  direction: 1 | -1,
) {
  const next = new Map<string, DisplayCell>()
  const nextFormats = new Map<string, SpreadsheetCellFormat>()
  const deleteEnd = colIndex + count - 1

  for (const cell of cells.values()) {
    if (direction === -1 && cell.col >= colIndex && cell.col <= deleteEnd) {
      continue
    }
    const col =
      cell.col >= (direction === 1 ? colIndex : deleteEnd + 1)
        ? cell.col + count * direction
        : cell.col
    const shifted = { ...cloneCell(cell), col }
    next.set(keyFor(shifted.row, shifted.col), shifted)
  }

  cells.clear()
  for (const [key, cell] of next) cells.set(key, cell)

  for (const [key, format] of cellFormats) {
    const coord = parseKey(key)
    if (!coord) continue
    if (direction === -1 && coord.col >= colIndex && coord.col <= deleteEnd) {
      continue
    }
    const col =
      coord.col >= (direction === 1 ? colIndex : deleteEnd + 1)
        ? coord.col + count * direction
        : coord.col
    nextFormats.set(keyFor(coord.row, col), cloneFormat(format))
  }

  cellFormats.clear()
  for (const [key, format] of nextFormats) cellFormats.set(key, format)

  shiftRangeFormats(rangeFormats, 'column', colIndex, count, direction)
}

function shiftRangeFormats(
  rangeFormats: RangeFormatLayer[],
  axis: 'row' | 'column',
  index: number,
  count: number,
  direction: 1 | -1,
) {
  const startKey = axis === 'row' ? 'rowStart' : 'colStart'
  const endKey = axis === 'row' ? 'rowEnd' : 'colEnd'
  const deleteEnd = index + count - 1

  for (const layer of rangeFormats) {
    const start = layer.range[startKey]
    const end = layer.range[endKey]

    if (direction === 1) {
      if (start >= index) {
        layer.range[startKey] = start + count
        layer.range[endKey] = end + count
      } else if (end >= index) {
        layer.range[endKey] = end + count
      }
      continue
    }

    if (end < index) {
      continue
    }
    if (start > deleteEnd) {
      layer.range[startKey] = start - count
      layer.range[endKey] = end - count
      continue
    }

    const removed = Math.min(end, deleteEnd) - Math.max(start, index) + 1
    layer.range[startKey] = start >= index ? index : start
    layer.range[endKey] = Math.max(layer.range[startKey], end - removed)
  }
}

function structuralMutationResult(
  request:
    | InsertRowsRequest
    | DeleteRowsRequest
    | InsertColumnsRequest
    | DeleteColumnsRequest,
  revision: ProjectionRevision,
) {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
  }
}

function mergeMutationResult(
  request: { sheetId: string; requestId?: number; revision?: ProjectionRevision; range: CellRange },
  revision: ProjectionRevision,
) {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
    affectedRange: cloneRange(normalizeRange(request.range)),
  }
}

export function matrixToDisplayCells(matrix: StaticSeedMatrix): DisplayCell[] {
  return matrixToCells(matrix)
}

export function sparseCellsToDisplayCells(cells: StaticSeedCells): DisplayCell[] {
  return sparseCellsToCells(cells)
}

export function matrixToVisibleProjectionResult(
  matrix: StaticSeedMatrix,
  request: VisibleProjectionRequest,
  revision?: ProjectionRevision,
): VisibleProjectionResult {
  return buildProjectionResult(request, buildState(matrixToCells(matrix), revision ?? 0)) as VisibleProjectionResult
}

export function matrixToRangeProjectionResult(
  matrix: StaticSeedMatrix,
  request: RangeProjectionRequest,
  revision?: ProjectionRevision,
): RangeProjectionResult {
  return buildProjectionResult(request, buildState(matrixToCells(matrix), revision ?? 0)) as RangeProjectionResult
}

export function sparseCellsToVisibleProjectionResult(
  cells: StaticSeedCells,
  request: VisibleProjectionRequest,
  revision?: ProjectionRevision,
): VisibleProjectionResult {
  return buildProjectionResult(request, buildState(sparseCellsToCells(cells), revision ?? 0)) as VisibleProjectionResult
}

export function sparseCellsToRangeProjectionResult(
  cells: StaticSeedCells,
  request: RangeProjectionRequest,
  revision?: ProjectionRevision,
): RangeProjectionResult {
  return buildProjectionResult(request, buildState(sparseCellsToCells(cells), revision ?? 0)) as RangeProjectionResult
}

export function createStaticSpreadsheetBackend(
  seed: StaticSpreadsheetSeedInput = [],
): SpreadsheetBackend {
  const state = normalizeSeed(seed)

  return {
    async listSheets() {
      return {
        revision: state.revision,
        sheets: cloneSheets(state.sheets),
      }
    },
    async exportRangeTsv(request) {
      return exportRangeTsvFromState(state, request)
    },
    async readVisibleProjection(request) {
      return buildProjectionResult(request, state) as VisibleProjectionResult
    },
    async readRangeProjection(request) {
      return buildProjectionResult(request, state) as RangeProjectionResult
    },
    async readViewportSizeProjection(request) {
      return buildViewportSizeProjectionResult(request, state)
    },
    async setCellInput(request) {
      updateCell(state.cells, request)
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    },
    async importCells(request: ImportCellsRequest) {
      for (const cell of request.cells) {
        updateCell(state.cells, {
          kind: 'set-cell-input',
          sheetId: request.sheetId,
          row: cell.row,
          col: cell.col,
          input: cell.input,
        })
      }
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: request.range,
      }
    },
    async importCellChunks(request: ImportCellChunksRequest) {
      for await (const chunk of request.chunks) {
        for (const cell of chunk) {
          updateCell(state.cells, {
            kind: 'set-cell-input',
            sheetId: request.sheetId,
            row: cell.row,
            col: cell.col,
            input: cell.input,
          })
        }
      }
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: request.range,
      }
    },
    async clearRange(request) {
      clearRange(state.cells, request)
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },
    async insertRows(request) {
      shiftRows(
        state.cells,
        state.cellFormats,
        state.rangeFormats,
        request.rowIndex,
        request.count,
        1,
      )
      shiftDimensionMap(
        getDimensionMap(state.rowHeightsBySheetId, request.sheetId),
        request.rowIndex,
        request.count,
        1,
      )
      state.revision = bumpRevision(state.revision)
      return structuralMutationResult(request, state.revision)
    },
    async deleteRows(request) {
      shiftRows(
        state.cells,
        state.cellFormats,
        state.rangeFormats,
        request.rowIndex,
        request.count,
        -1,
      )
      shiftDimensionMap(
        getDimensionMap(state.rowHeightsBySheetId, request.sheetId),
        request.rowIndex,
        request.count,
        -1,
      )
      state.revision = bumpRevision(state.revision)
      return structuralMutationResult(request, state.revision)
    },
    async insertColumns(request) {
      shiftColumns(
        state.cells,
        state.cellFormats,
        state.rangeFormats,
        request.colIndex,
        request.count,
        1,
      )
      shiftDimensionMap(
        getDimensionMap(state.colWidthsBySheetId, request.sheetId),
        request.colIndex,
        request.count,
        1,
      )
      state.revision = bumpRevision(state.revision)
      return structuralMutationResult(request, state.revision)
    },
    async deleteColumns(request) {
      shiftColumns(
        state.cells,
        state.cellFormats,
        state.rangeFormats,
        request.colIndex,
        request.count,
        -1,
      )
      shiftDimensionMap(
        getDimensionMap(state.colWidthsBySheetId, request.sheetId),
        request.colIndex,
        request.count,
        -1,
      )
      state.revision = bumpRevision(state.revision)
      return structuralMutationResult(request, state.revision)
    },
    async setFormatRange(request: SetFormatRangeRequest) {
      clearCellFormatsInRange(state.cellFormats, request.range)
      state.rangeFormats.push({
        range: { ...request.range },
        format: normalizeFormat(request.format) ?? {},
      })
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },
    async setRowHeight(request: SetRowHeightRequest) {
      getDimensionMap(state.rowHeightsBySheetId, request.sheetId).set(
        request.rowIndex,
        normalizeDimensionSize(request.heightPx),
      )
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async setColumnWidth(request: SetColumnWidthRequest) {
      getDimensionMap(state.colWidthsBySheetId, request.sheetId).set(
        request.colIndex,
        normalizeDimensionSize(request.widthPx),
      )
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async mergeRange(request) {
      const range = normalizeRange(request.range)
      const ranges = getMergeRanges(state, request.sheetId)
      const nextRanges = ranges.filter((candidate) => !rangesIntersect(candidate, range))
      if (range.rowEnd > range.rowStart || range.colEnd > range.colStart) {
        nextRanges.push(cloneRange(range))
      }
      state.mergeRangesBySheetId.set(request.sheetId, nextRanges)
      state.revision = bumpRevision(state.revision)

      return mergeMutationResult(request, state.revision)
    },
    async unmergeRange(request) {
      const range = normalizeRange(request.range)
      const ranges = getMergeRanges(state, request.sheetId)
      state.mergeRangesBySheetId.set(
        request.sheetId,
        ranges.filter((candidate) => !rangesIntersect(candidate, range)),
      )
      state.revision = bumpRevision(state.revision)

      return mergeMutationResult(request, state.revision)
    },
    async fillRange(request) {
      applyFillRange(state, request)
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: request.targetRange.rowStart,
          rowEnd: request.targetRange.rowEnd,
          colStart: request.targetRange.colStart,
          colEnd: request.targetRange.colEnd,
        },
      }
    },
    async resolveDataEdge(request) {
      return resolveStaticDataEdge(state, request)
    },
    async addSheet(request) {
      const name = normalizeSheetMutationName(request.name, createNextSheetName(state.sheets))
      assertUniqueSheetName(state.sheets, name)

      const createdSheet: SpreadsheetSheetMetadata = {
        id: createNextSheetId(state.sheets),
        name,
        index: state.sheets.length,
      }
      state.sheets = [...state.sheets, createdSheet]
      state.revision = bumpRevision(state.revision)

      return sheetMutationResult(state, request.requestId, {
        sheetId: createdSheet.id,
        activeSheetId: createdSheet.id,
        createdSheet,
      })
    },
    async renameSheet(request) {
      const name = normalizeSheetMutationName(request.name, '')
      if (name.length === 0) {
        throw new Error('sheet name cannot be empty')
      }

      const sheet = state.sheets.find((item) => item.id === request.sheetId)
      if (!sheet) {
        throw new Error(`unknown sheet: ${request.sheetId}`)
      }
      assertUniqueSheetName(state.sheets, name, request.sheetId)

      state.sheets = state.sheets.map((item) =>
        item.id === request.sheetId ? { ...item, name } : item,
      )
      state.revision = bumpRevision(state.revision)

      return sheetMutationResult(state, request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
      })
    },
    async deleteSheet(request) {
      if (state.sheets.length <= 1) {
        throw new Error('cannot delete the last sheet')
      }

      const deleteIndex = state.sheets.findIndex((sheet) => sheet.id === request.sheetId)
      if (deleteIndex < 0) {
        throw new Error(`unknown sheet: ${request.sheetId}`)
      }

      const nextSheets = state.sheets.filter((sheet) => sheet.id !== request.sheetId)
      state.sheets = reindexSheets(nextSheets)
      state.rowHeightsBySheetId.delete(request.sheetId)
      state.colWidthsBySheetId.delete(request.sheetId)
      state.revision = bumpRevision(state.revision)
      const activeSheetId = state.sheets[Math.min(deleteIndex, state.sheets.length - 1)]?.id ?? null

      return sheetMutationResult(state, request.requestId, {
        sheetId: request.sheetId,
        activeSheetId,
      })
    },
    async reorderSheet(request: ReorderSheetRequest) {
      const sheet = state.sheets.find((item) => item.id === request.sheetId)
      if (!sheet) {
        throw new Error(`unknown sheet: ${request.sheetId}`)
      }

      const nextSheets = reorderSheetMetadata(state.sheets, request)
      if (!hasSameSheetOrder(state.sheets, nextSheets)) {
        state.sheets = nextSheets
        state.revision = bumpRevision(state.revision)
      }

      return sheetMutationResult(state, request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
      })
    },
  }
}
