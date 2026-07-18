import type {
  BackendMutationResult,
  CellRange,
  ClearRangeRequest,
  ClearValidationRuleRequest,
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
  RemoveRowsExactRequest,
  RemoveRowsExactResult,
  RemoveRowsRequest,
  RemoveRowsResult,
  ReorderSheetRequest,
  RemoveConditionalFormatRuleRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
  SetColumnWidthRequest,
  SetConditionalFormatRuleRequest,
  SetFormatRangeRequest,
  SetNamedRangeRequest,
  SetRowHeightRequest,
  SetValidationRuleRequest,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  ToolbarBackendMutationResult,
  ValidationMode,
  ValidationRule,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  cloneCell,
  cloneConditionalFormatRule,
  cloneConditionalFormatRuleEntry,
  cloneFormat,
  cloneNamedRange,
  cloneRange,
  compareCellValue,
  conditionalRuleFormat,
  DEFAULT_WORKBOOK_LOCALE,
  estimateUtf8Bytes,
  evaluateValidationLocal,
  formatNumberValue,
  isCoordInsideRange,
  keyFor,
  namedRangeIdentity,
  nextConditionalFormatRuleId,
  normalizeDimensionSize,
  normalizeFormat,
  normalizeNamedRangeName,
  normalizeRange,
  numericValue,
  reorderSheetMetadata,
  toA1,
  validationMessageForRule,
  validationSeverityForMode,
  type RangeFormatLayer,
  getEffectiveFormat,
} from '@einfach/spreadsheet-ui-core'

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
  /**
   * Explicit host witness that this worker runtime really applies deleteRows.
   * Omitted/false by default because the current TS runtime ACKs structural
   * commands without mutating its workbook. Only the WASM demo may opt in.
   */
  removeRowsExactCapability?: false | 'worker-engine-delete-rows'
  afterInit?: (
    client: WorkerWorkbookClient,
    sheets: WorkerWorkbookBackendSheet[],
  ) => Promise<void> | void
}

export interface WorkerWorkbookSpreadsheetBackend extends SpreadsheetBackend {
  removeRowsExact?(request: RemoveRowsExactRequest): Promise<RemoveRowsExactResult>
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

function rangesIntersect(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart <= right.rowEnd &&
    left.rowEnd >= right.rowStart &&
    left.colStart <= right.colEnd &&
    left.colEnd >= right.colStart
  )
}

function namedRangeMatches(
  entry: NamedRange,
  name: string,
  scope: NamedRange['scope'],
): boolean {
  const targetIdentity = namedRangeIdentity(name, scope)
  return targetIdentity !== null && namedRangeIdentity(entry.name, entry.scope) === targetIdentity
}

function namedRangeAddressEndpoints(
  address: string,
): { start: string; end: string } | null {
  const parts = address
    .trim()
    .split(':')
    .map((part) => part.trim())
  if (parts.length === 1 && parts[0]) {
    return { start: parts[0], end: parts[0] }
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { start: parts[0], end: parts[1] }
  }
  return null
}

function isNamedRangeEngineUnsupported(error: unknown): boolean {
  const code = (error as Error & { code?: string })?.code
  return code === 'NAME_BINDING_UNSUPPORTED' || code === 'UNKNOWN_COMMAND'
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

// Expects `orderedRules` already sorted by priority — the sort is
// hoisted into `applyConditionalFormatOverlay` so a window read pays it
// once per overlay, not once per projected cell (audit D-11).
function getConditionalFormatForCell(
  row: number,
  col: number,
  cell: DisplayCell | undefined,
  orderedRules: readonly ConditionalFormatRuleEntry[],
): SpreadsheetCellFormat | undefined {
  for (const entry of orderedRules) {
    if (!isCoordInsideRange(row, col, entry.scope.range)) continue
    if (!conditionalRuleAppliesToCell(entry.rule, cell)) continue
    const format = conditionalRuleFormat(entry.rule)
    if (format) return format
  }
  return undefined
}

// Exported for the audit D-11 pin in test/audit-adapter-scaling.test.ts.
//
// `window` is the canonical requested range and bounds every (row, col)
// coordinate the per-cell loop can test. Rules scoped entirely
// outside it can never match, so they are dropped BEFORE the per-cell
// loop (audit D-11, second half). The pre-filter is a pure superset
// test: per-cell `isCoordInsideRange` still decides membership for the
// surviving rules, and unbounded scopes (whole-column / whole-sheet)
// intersect any window in their band, so they always survive.
export function applyConditionalFormatOverlay(
  cells: DisplayCell[],
  rules: readonly ConditionalFormatRuleEntry[],
  window: CellRange,
): DisplayCell[] {
  if (rules.length === 0) return cells
  const ordered = rules
    .filter((entry) => rangesIntersect(entry.scope.range, window))
    .sort((left, right) => left.priority - right.priority)
  if (ordered.length === 0) return cells
  return cells.map((cell) => {
    const sourceRow = cell.originalRow ?? cell.row
    const conditionalFormat = getConditionalFormatForCell(sourceRow, cell.col, cell, ordered)
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

function preprocessFormatSnapshot(snapshot: FormatRangeSnapshot): {
  cellFormats: Map<string, SpreadsheetCellFormat>
  rangeFormats: RangeFormatLayer[]
} {
  // Skip default-looking cell-format entries so they cannot mask an underlying
  // range layer in getEffectiveFormat. This preserves the semantics of the
  // pre-refactor worker which ran normalizeFormat on each entry.
  const cellFormats = new Map<string, SpreadsheetCellFormat>()
  for (const entry of snapshot.cellFormats) {
    const coord = parseA1(entry.addr)
    if (!coord) continue
    const normalized = normalizeFormat(entry.format)
    if (!normalized) continue
    cellFormats.set(keyFor(coord.row, coord.col), normalized)
  }

  const rangeFormats: RangeFormatLayer[] = snapshot.rangeFormats.map((layer) => ({
    range: {
      rowStart: layer.startRow,
      rowEnd: layer.endRow,
      colStart: layer.startCol,
      colEnd: layer.endCol,
    },
    format: layer.format,
  }))

  return { cellFormats, rangeFormats }
}

function attachFormatsToCells(
  cells: DisplayCell[],
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: readonly RangeFormatLayer[],
): DisplayCell[] {
  return cells.map((cell) => {
    const sourceRow = cell.originalRow ?? cell.row
    const format = getEffectiveFormat(sourceRow, cell.col, cellFormats, rangeFormats)
    return format ? { ...cell, format } : cell
  })
}

function fillBlankFormatOnlyCells(
  cellMap: Map<string, DisplayCell>,
  range: CellRange,
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: readonly RangeFormatLayer[],
): void {
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(row, col)
      if (cellMap.has(key)) continue
      const format = getEffectiveFormat(row, col, cellFormats, rangeFormats)
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
}

function mergeFormatsIntoCells(
  cells: DisplayCell[],
  range: CellRange,
  snapshot: FormatRangeSnapshot,
): DisplayCell[] {
  const { cellFormats, rangeFormats } = preprocessFormatSnapshot(snapshot)
  const formatted = attachFormatsToCells(cells, cellFormats, rangeFormats)
  const cellMap = new Map<string, DisplayCell>()
  for (const cell of formatted) cellMap.set(keyFor(cell.row, cell.col), cell)
  fillBlankFormatOnlyCells(cellMap, range, cellFormats, rangeFormats)
  return [...cellMap.values()].sort((left, right) =>
    left.row === right.row ? left.col - right.col : left.row - right.row,
  )
}

function applyNumberFormatToCell(cell: DisplayCell, workbookLocale: string): DisplayCell {
  const numberFormat = cell.format?.numberFormat
  if (!numberFormat) return cell
  if (cell.valueKind === 'error') return cell
  if (
    cell.valueKind !== 'number' &&
    numberFormat.kind !== 'text' &&
    numberFormat.kind !== 'custom'
  ) {
    return cell
  }

  if (cell.valueKind === 'number' && !Number.isFinite(cell.numericValue)) return cell
  const value = cell.valueKind === 'number' ? cell.numericValue! : cell.displayValue
  const locale = cell.format?.locale ?? workbookLocale
  const result = formatNumberValue(numberFormat, value, { locale })

  if (result.text === cell.displayValue && (!result.color || cell.format?.fgColor)) {
    return cell
  }

  const next: DisplayCell = { ...cell, displayValue: result.text }
  if (result.color && !next.format?.fgColor) {
    next.format = { ...next.format!, fgColor: result.color }
  }
  return next
}

function applyNumberFormatsToCells(
  cells: DisplayCell[],
  workbookLocale: string = DEFAULT_WORKBOOK_LOCALE,
): DisplayCell[] {
  return cells.map((cell) => applyNumberFormatToCell(cell, workbookLocale))
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

  if (snapshot.type === 'number' && valueKind === 'number') {
    const value = numericValue(snapshot.display)
    if (value !== null) cell.numericValue = value
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

function toImportCellWire(
  sheet: number,
  row: number,
  col: number,
  input: string,
  preserveAsText?: boolean,
): ImportCellWire {
  // preserveAsText: bypass numeric inference and formula detection. The
  // input is forwarded verbatim as a text cell so `=A1` stays literal and
  // `00123` keeps its leading zeros. An empty string still clears the
  // cell.
  if (preserveAsText) {
    if (input.length === 0) {
      return { sheet, row, col, kind: 'null' }
    }
    return { sheet, row, col, kind: 'text', value: input }
  }

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
  // Toolbar-overlay metadata (data validation, conditional format, named ranges) is
  // intentionally kept on the main thread for now: the WASM Workbook does not yet model these and
  // would not round-trip them through undo/redo or formula evaluation. The host applies them on
  // top of the worker's projection. Move into the Rust workbook once it grows native support; at
  // that point these Maps should disappear (not be extended).
  const validationRulesBySheetId = new Map<string, WorkerValidationRuleLayer[]>()
  const conditionalFormatRulesBySheetId = new Map<string, ConditionalFormatRuleEntry[]>()
  let namedRanges: NamedRange[] = []
  let namedRangeMutationTail: Promise<void> = Promise.resolve()
  const readyPromise = client
    .initWorkbook(sheetInputs.map((sheet) => sheet.name))
    .then(async (metas) => {
      lookup = buildSheetLookup(sheetInputs, metas)
      await options.afterInit?.(client, lookup.sheets)
      return lookup.sheets
    })

  // Wave 8.2 — content-change push for worker-initiated recomputes
  // (async custom-formula settles). The worker posts a cellsDirty event
  // after every settle; forwarding it lets the grid refetch the visible
  // projection without a user interaction.
  const contentChangeHandlers = new Set<() => void>()
  let sheetIndexRemapDepth = 0
  let deferredContentChange = false

  function notifyContentChangeHandlers(): void {
    for (const handler of contentChangeHandlers) handler()
  }

  function beginSheetIndexRemap(): void {
    sheetIndexRemapDepth += 1
  }

  function finishSheetIndexRemap(): void {
    sheetIndexRemapDepth = Math.max(0, sheetIndexRemapDepth - 1)
    if (sheetIndexRemapDepth > 0 || !deferredContentChange) return
    deferredContentChange = false
    notifyContentChangeHandlers()
  }

  const offDirty = client.onCellsDirty(() => {
    bumpRevision()
    if (sheetIndexRemapDepth > 0) {
      deferredContentChange = true
      return
    }
    notifyContentChangeHandlers()
  })

  function bumpRevision(): ProjectionRevision {
    if (typeof revision === 'number' && Number.isFinite(revision)) {
      revision += 1
    }
    return revision
  }

  function assertNamedRangeBackendActive(): void {
    if (disposed) {
      throw createBackendError(
        'BACKEND_DISPOSED',
        'named range mutation completed after the worker backend was disposed',
      )
    }
  }

  function enqueueNamedRangeMutation(
    mutation: () => Promise<NamedRangeMutationResult>,
  ): Promise<NamedRangeMutationResult> {
    const result = namedRangeMutationTail.then(mutation, mutation)
    namedRangeMutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function workerNamedRangeMutationResult(
    request: SetNamedRangeRequest | DeleteNamedRangeRequest,
    outcome: NamedRangeMutationResult['outcome'],
    resultRevision: ProjectionRevision = revision,
  ): NamedRangeMutationResult {
    return {
      requestId: request.requestId,
      revision: request.revision ?? resultRevision,
      outcome,
      authority: 'worker-engine-ack',
      canonical: false,
    }
  }

  /**
   * Audit D-4: drop every per-sheet host overlay keyed by `sheetId`.
   * `syncSheetLookup` re-issues `sheet-${idx+1}` ids, so a deleted
   * sheet's id IS reused by the next added sheet — stale entries are not
   * just leaks, they get inherited. Per-sheet-keyed state in this
   * backend: `validationRulesBySheetId`, `conditionalFormatRulesBySheetId`,
   * and the sheet-scoped entries of `namedRanges`.
   */
  function dropSheetOverlayState(sheetId: string): void {
    validationRulesBySheetId.delete(sheetId)
    conditionalFormatRulesBySheetId.delete(sheetId)
    namedRanges = namedRanges.filter(
      (item) => item.scope === 'workbook' || item.scope.sheetId !== sheetId,
    )
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
    const numberFormattedCells = applyNumberFormatsToCells(formattedCells)
    const validatedCells = applyValidationOverlay(
      numberFormattedCells,
      range,
      validationRulesBySheetId.get(sheetId) ?? [],
    )

    return {
      cells: applyConditionalFormatOverlay(
        validatedCells,
        conditionalFormatRulesBySheetId.get(sheetId) ?? [],
        range,
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
          wireChunk.push(
            toImportCellWire(sheet.idx, cell.row, cell.col, cell.input, cell.preserveAsText),
          )
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

  async function removeRowsThroughWorker(request: RemoveRowsRequest): Promise<RemoveRowsResult> {
    if (request.rows.length === 0) {
      return {
        sheetId: request.sheetId,
        removedRows: 0,
        revision: request.revision ?? revision,
      }
    }

    const unique = Array.from(new Set(request.rows)).filter(
      (row) => Number.isInteger(row) && row >= 0,
    )
    if (unique.length === 0) {
      return {
        sheetId: request.sheetId,
        removedRows: 0,
        revision: request.revision ?? revision,
      }
    }

    const sheet = await resolveSheet(request.sheetId)
    unique.sort((left, right) => right - left)

    const bands: Array<{ startRow: number; count: number }> = []
    for (const rowIndex of unique) {
      const last = bands[bands.length - 1]
      if (last && last.startRow === rowIndex + 1) {
        last.startRow = rowIndex
        last.count += 1
      } else {
        bands.push({ startRow: rowIndex, count: 1 })
      }
    }

    const successfullyRemoved: number[] = []
    let failureCause: unknown = null
    for (const band of bands) {
      try {
        const accepted = await client.deleteRows(sheet.idx, band.startRow, band.count)
        if (accepted !== true) {
          failureCause = createBackendError(
            'DELETE_ROWS_NOT_ACCEPTED',
            `worker did not accept deleteRows(${band.startRow}, ${band.count})`,
          )
          break
        }
        for (let offset = band.count - 1; offset >= 0; offset -= 1) {
          successfullyRemoved.push(band.startRow + offset)
        }
      } catch (error) {
        failureCause = error
        break
      }
    }

    if (failureCause !== null) {
      const nextRevision = bumpRevision()
      const partialMinRow =
        successfullyRemoved.length > 0 ? successfullyRemoved[successfullyRemoved.length - 1] : 0
      const partialMaxRow = successfullyRemoved.length > 0 ? successfullyRemoved[0] : 0
      const error = new Error(
        'removeRows partially failed: deleted ' +
          String(successfullyRemoved.length) +
          ' of ' +
          String(unique.length) +
          ' rows before the worker rejected — ' +
          (failureCause instanceof Error ? failureCause.message : String(failureCause)),
      ) as Error & {
        cause?: unknown
        removedRows: number
        partial: true
        affectedRange?: RemoveRowsResult['affectedRange']
        revision: number | string
      }
      error.cause = failureCause
      error.removedRows = successfullyRemoved.length
      error.partial = true
      error.revision = request.revision ?? nextRevision
      if (successfullyRemoved.length > 0) {
        error.affectedRange = {
          startRow: partialMinRow,
          endRow: partialMaxRow,
          startCol: 0,
          endCol: Number.MAX_SAFE_INTEGER,
        }
      }
      throw error
    }

    const minRow = unique[unique.length - 1]
    const maxRow = unique[0]
    const nextRevision = bumpRevision()
    return {
      sheetId: request.sheetId,
      removedRows: unique.length,
      affectedRange: {
        startRow: minRow,
        endRow: maxRow,
        startCol: 0,
        endCol: Number.MAX_SAFE_INTEGER,
      },
      revision: request.revision ?? nextRevision,
    }
  }

  function assertExactRemoveRowsRequest(request: RemoveRowsExactRequest): void {
    const range = request.targetRange
    const validRange =
      Number.isSafeInteger(range.rowStart) &&
      Number.isSafeInteger(range.rowEnd) &&
      Number.isSafeInteger(range.colStart) &&
      Number.isSafeInteger(range.colEnd) &&
      range.rowStart >= 0 &&
      range.colStart >= 0 &&
      range.rowStart <= range.rowEnd &&
      range.colStart <= range.colEnd
    const validRows =
      request.rows.length > 0 &&
      request.rows.every(
        (row, index) =>
          Number.isSafeInteger(row) &&
          row >= range.rowStart &&
          row <= range.rowEnd &&
          (index === 0 || request.rows[index - 1] < row),
      )
    const validRevision =
      typeof request.revision === 'number' &&
      Number.isFinite(request.revision) &&
      request.revision === revision

    if (!validRange || !validRows || !validRevision) {
      throw createBackendError(
        'INVALID_REMOVE_ROWS_EXACT_REQUEST',
        'removeRowsExact requires a canonical in-range row list and the current numeric revision',
      )
    }
  }

  async function removeRowsExact(request: RemoveRowsExactRequest): Promise<RemoveRowsExactResult> {
    assertExactRemoveRowsRequest(request)
    const mutation = await removeRowsThroughWorker({
      kind: 'remove-rows',
      sheetId: request.sheetId,
      rows: [...request.rows],
    })
    if (
      typeof mutation.revision !== 'number' ||
      !Number.isFinite(mutation.revision) ||
      mutation.revision === request.revision
    ) {
      throw createBackendError(
        'INVALID_REMOVE_ROWS_EXACT_ACK',
        'worker row deletion completed without a distinct numeric revision',
      )
    }

    return {
      requestId: request.requestId,
      sheetId: request.sheetId,
      targetRange: { ...request.targetRange },
      removedRowIndices: [...request.rows],
      removedRows: request.rows.length,
      affectedRange: {
        startRow: request.rows[0],
        endRow: request.targetRange.rowEnd,
        startCol: request.targetRange.colStart,
        endCol: request.targetRange.colEnd,
      },
      revision: mutation.revision,
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

    /**
     * Wave 7.5 Remove Duplicates port. The worker protocol does not have
     * a dedicated batched `removeRows` / `deleteRowsBatch` RPC — the Rust
     * `Workbook` only exposes contiguous-band `delete_row(at, count)`.
     * Audit D-10 (FIXED at the band level): we group the descending row
     * list into contiguous bands and issue ONE `deleteRows(start, count)`
     * RPC per band — the common remove-duplicates shape (clustered rows)
     * collapses to a handful of round-trips instead of one per row.
     * Fully scattered rows still cost one RPC per (single-row) band.
     *
     * TODO(einfach-excel-core#batch-delete-rows): when the Rust side
     * grows a batched primitive (`delete_rows_batch(indices: &[u32])`),
     * switch to a single RPC so the band loop below can become atomic.
     * The surface contract here will not change.
     *
     * Atomicity caveat (HIGH #5): because each band is its own RPC, a
     * mid-loop failure leaves the workbook with a partial deletion that
     * we cannot roll back from this side. Each band RPC is assumed
     * atomic engine-side (one `delete_row(at, count)` call). We surface
     * partial failure by counting committed deletes and re-throwing an
     * Error that wraps the underlying rejection AND carries
     * `removedRows` so the caller can record an accurate (partial)
     * history entry before re-prompting the user. The revision is still
     * bumped because the workbook IS dirty.
     *
     * Empty input is a no-op: no RPC, no revision bump, no history-side
     * effect, so accidentally confirming with zero duplicates leaves the
     * workbook entirely untouched.
     */
    async removeRows(request: RemoveRowsRequest): Promise<RemoveRowsResult> {
      return removeRowsThroughWorker(request)
    },

    get removeRowsExact() {
      return options.removeRowsExactCapability === 'worker-engine-delete-rows'
        ? removeRowsExact
        : undefined
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

    async setFormatRange(request: SetFormatRangeRequest): Promise<ToolbarBackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.setFormatRange(
        toSparseRange(sheet.idx, request.range),
        request.format as CellFormatJSON | null | undefined,
      )
      const nextRevision = bumpRevision()

      return {
        kind: request.kind,
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

      // Audit D-4 (FIXED): the deleted sheet's id will be reused by the
      // next added sheet — drop every host-side overlay keyed by it so
      // the new sheet starts clean instead of inheriting dead state.
      dropSheetOverlayState(request.sheetId)
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
        // A real worker may publish cellsDirty before the moveSheet ACK. Hold
        // that coarse refresh ping until sheetList has rebuilt the canonical
        // stable-id -> positional-index lookup, otherwise an active stable id
        // can briefly read the sheet that moved into its old index.
        beginSheetIndexRemap()
        try {
          const ok = await client.moveSheet(lookup.sheets[fromIndex].idx, toIndex)
          if (!ok) {
            throw createBackendError(
              'SHEET_REORDER_FAILED',
              `cannot reorder sheet: ${request.sheetId}`,
            )
          }
          nextRevision = bumpRevision()
          await refreshSheetLookup(lookup.sheets)
        } finally {
          // Never leave worker content notifications suppressed when the
          // command rejects. The successful path flushes only after the
          // canonical sheet-list refresh above.
          finishSheetIndexRemap()
        }
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
        authority: 'adapter-post-ack-overlay',
        definitionReadback: 'full',
        canonical: false,
      }
    },

    async setNamedRange(request: SetNamedRangeRequest): Promise<NamedRangeMutationResult> {
      return enqueueNamedRangeMutation(async () => {
        assertNamedRangeBackendActive()
        const name = normalizeNamedRangeName(request.name)
        if (!name) throw createBackendError('INVALID_NAME', 'invalid named range name')
        if (request.scope !== 'workbook') {
          return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
        }

        await readyPromise
        assertNamedRangeBackendActive()
        try {
          const refersTo = request.refersTo
          let accepted: boolean
          if (refersTo.kind === 'lambda') {
            accepted = await client.defineName(name, {
              kind: 'lambda',
              params: refersTo.params,
              body: refersTo.body,
            })
          } else if (refersTo.kind === 'range') {
            // The engine owns workbook names and resolves range bindings by
            // human-readable sheet name plus separate start/end addresses.
            const sheet = lookup.sheets.find((candidate) => candidate.id === refersTo.sheetId)
            const endpoints = namedRangeAddressEndpoints(refersTo.address)
            if (!sheet || !endpoints) {
              return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
            }
            accepted = await client.defineName(name, {
              kind: 'range',
              sheetName: sheet.name,
              ...endpoints,
            })
          } else {
            accepted = await client.defineName(name, {
              kind: 'value',
              literal: refersTo.value,
            })
          }

          assertNamedRangeBackendActive()
          if (!accepted) {
            return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
          }
        } catch (error) {
          assertNamedRangeBackendActive()
          if (isNamedRangeEngineUnsupported(error)) {
            return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
          }
          throw error
        }

        const entry: NamedRange = {
          name,
          scope: 'workbook',
          refersTo: { ...request.refersTo },
        }
        const existingIndex = namedRanges.findIndex((item) =>
          namedRangeMatches(item, name, request.scope),
        )
        namedRanges =
          existingIndex >= 0
            ? namedRanges.map((item, index) => (index === existingIndex ? entry : item))
            : [...namedRanges, entry]
        return workerNamedRangeMutationResult(request, 'w0-acknowledged', bumpRevision())
      })
    },

    async deleteNamedRange(request: DeleteNamedRangeRequest): Promise<NamedRangeMutationResult> {
      return enqueueNamedRangeMutation(async () => {
        assertNamedRangeBackendActive()
        const name = normalizeNamedRangeName(request.name)
        if (!name) throw createBackendError('INVALID_NAME', 'invalid named range name')
        if (request.scope !== 'workbook') {
          return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
        }

        await readyPromise
        assertNamedRangeBackendActive()
        try {
          const accepted = await client.undefineName(name)
          assertNamedRangeBackendActive()
          if (!accepted) {
            return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
          }
        } catch (error) {
          assertNamedRangeBackendActive()
          if (isNamedRangeEngineUnsupported(error)) {
            return workerNamedRangeMutationResult(request, 'confirmed-not-applied')
          }
          throw error
        }

        namedRanges = namedRanges.filter(
          (item) => !namedRangeMatches(item, name, request.scope),
        )
        return workerNamedRangeMutationResult(request, 'w0-acknowledged', bumpRevision())
      })
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

    /**
     * Wave 8 custom-formulas port. The Solid host subscribes to
     * `customFormulaRegistryAtom` and forwards add/remove edges here;
     * the worker compiles the source via `new Function('args', source)`
     * and registers the resulting callable with the WASM Workbook (or
     * stubs gracefully when the WASM bridge is missing).
     *
     * NOT undoable, NOT history-tracked, NOT revision-bumping — the
     * registry is a workbook-wide capability registration, not a cell
     * mutation, so a re-evaluation cascade happens on the WASM side
     * when registered names appear inside existing formulas. No
     * `affectedRange` exists.
     */
    async registerCustomFormula(
      name: string,
      source: string,
      options?: { isAsync?: boolean },
    ): Promise<void> {
      await readyPromise
      await client.registerCustomFormula(name, source, options)
    },

    async unregisterCustomFormula(name: string): Promise<void> {
      await readyPromise
      await client.unregisterCustomFormula(name)
    },

    subscribeContentChanges(handler: () => void): () => void {
      contentChangeHandlers.add(handler)
      return () => {
        contentChangeHandlers.delete(handler)
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
