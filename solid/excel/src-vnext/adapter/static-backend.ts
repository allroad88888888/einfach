import type {
  BackendMutationResult,
  ClearValidationRuleRequest,
  ConditionalFormatRule,
  ConditionalFormatRuleEntry,
  ConditionalFormatRulesResult,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  DisplayCellRichValue,
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
  RemoveConditionalFormatRuleRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  PasteRangeRequest,
  PasteRangeResult,
  RemoveRowsRequest,
  RemoveRowsResult,
  SetCellInputRequest,
  SetCellRichValueRequest,
  SetColumnWidthRequest,
  SetConditionalFormatRuleRequest,
  SetFilterSortRequest,
  SetFormatRangeRequest,
  SetNamedRangeRequest,
  SetRowHeightRequest,
  SetValidationRuleRequest,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  NamedRange,
  NamedRangeListResult,
  NamedRangeMutationResult,
  DeleteNamedRangeRequest,
  ListNamedRangesRequest,
  ListConditionalFormatRulesRequest,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
  FilterSortState,
} from '@einfach/spreadsheet-ui-core'
import {
  cloneCell,
  cloneConditionalFormatRule,
  cloneConditionalFormatRuleEntry,
  cloneFilterSortState,
  cloneFormat,
  cloneNamedRange,
  cloneRange,
  cloneRichValue,
  compareCellValue,
  conditionalRuleFormat,
  DEFAULT_WORKBOOK_LOCALE,
  estimateUtf8Bytes,
  filterSortHasEffect,
  formatNumberValue,
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  getRichValueText,
  isCoordInsideRange,
  keyFor,
  nextConditionalFormatRuleId,
  normalizeDimensionSize,
  normalizeFormat,
  normalizeRange,
  numericValue,
  rangesIntersect,
  reorderSheetMetadata,
  toA1,
  validationMessageForRule,
  validationSeverityForMode,
  type RangeFormatLayer,
  getEffectiveFormat,
  buildFilterSortDisplayRows as buildFilterSortDisplayRowsShared,
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
import { evaluateFormula, formatEvalResult, type EvalCellLookup } from './static-formula-eval'

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

function stripCellFormat(cell: DisplayCell): DisplayCell {
  const clone = cloneCell(cell)
  delete clone.format
  delete clone.mergedSpan
  delete clone.mergeAnchor
  return clone
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

interface StaticBackendState {
  cellsBySheet: Map<string, Map<string, DisplayCell>>
  cellFormatsBySheetId: Map<string, Map<string, SpreadsheetCellFormat>>
  rangeFormatsBySheetId: Map<string, RangeFormatLayer[]>
  conditionalFormatRulesBySheetId: Map<string, ConditionalFormatRuleEntry[]>
  filterSortBySheetId: Map<string, FilterSortState>
  namedRanges: NamedRange[]
  mergeRangesBySheetId: Map<string, CellRange[]>
  rowHeightsBySheetId: Map<string, Map<number, number>>
  colWidthsBySheetId: Map<string, Map<number, number>>
  sheets: SpreadsheetSheetMetadata[]
  revision: ProjectionRevision
  /** BCP-47 workbook locale used by the projection-layer number-format pipeline. */
  workbookLocale?: string
  /** LIFO reverse deltas (state-before-mutation) for backend-side undo. */
  undoStack: StateDelta[]
  /** LIFO forward deltas populated when undoing so redo can roll forward. */
  redoStack: StateDelta[]
  /**
   * The delta the in-flight mutation records into. Set by
   * `beginUndoableMutation`; every record* helper writes here. Null
   * outside mutations (recorders then no-op).
   */
  pendingDelta: StateDelta | null
}

/**
 * Reverse-delta history (audit D-2).
 *
 * `beginUndoableMutation` used to deep-clone EVERY cell of EVERY sheet
 * (plus all format/merge/dimension tables) per undoable mutation —
 * measured 108× slowdown per keystroke at 20k cells vs 50, and a
 * steady-state memory of 200 × workbook. History entries are now
 * before-value deltas scoped to exactly what the mutation touches
 * (mirroring ui-core history's small-descriptor contract): undo applies
 * the reverse delta and symmetrically captures a forward delta for redo.
 *
 * Cost is O(change) per mutation. Structural ops that genuinely rewrite
 * a whole sheet (row/column shifts, removeRows, deleteSheet) use the
 * labeled `fullSheet` fallback — O(one sheet), never O(workbook).
 *
 * All captured values are CLONES: some mutations (validation rules)
 * mutate live cell objects in place, so a recorded before-value must
 * not alias live state.
 */
interface FullSheetCapture {
  cells: Map<string, DisplayCell>
  cellFormats: Map<string, SpreadsheetCellFormat>
  rangeFormats: RangeFormatLayer[]
  conditionalFormatRules: ConditionalFormatRuleEntry[]
  mergeRanges: CellRange[]
  rowHeights: Map<number, number>
  colWidths: Map<number, number>
}

interface SheetDelta {
  /** Before-values per touched cell key; null = key was absent. */
  cells?: Map<string, DisplayCell | null>
  cellFormats?: Map<string, SpreadsheetCellFormat | null>
  /** Whole-table before-clones for small per-sheet tables (bounded by op count, not cell count). */
  rangeFormats?: RangeFormatLayer[]
  conditionalFormatRules?: ConditionalFormatRuleEntry[]
  mergeRanges?: CellRange[]
  rowHeights?: Map<number, number | null>
  colWidths?: Map<number, number | null>
  /** Labeled O(one-sheet) fallback for structural ops. Supersedes the granular fields. */
  fullSheet?: FullSheetCapture
}

interface StateDelta {
  sheetDeltas: Map<string, SheetDelta>
  namedRanges?: NamedRange[]
  sheetsMeta?: SpreadsheetSheetMetadata[]
  revision: ProjectionRevision
}

const STATIC_BACKEND_UNDO_CAP = 200

function cloneRangeFormatLayers(layers: readonly RangeFormatLayer[]): RangeFormatLayer[] {
  return layers.map((layer) => ({ range: { ...layer.range }, format: cloneFormat(layer.format) }))
}

function beginUndoableMutation(state: StaticBackendState): void {
  const delta: StateDelta = { sheetDeltas: new Map(), revision: state.revision }
  state.pendingDelta = delta
  state.undoStack.push(delta)
  if (state.undoStack.length > STATIC_BACKEND_UNDO_CAP) {
    state.undoStack.shift()
  }
  // Any forward-history is invalidated by a new mutation.
  state.redoStack = []
}

function pendingSheetDelta(state: StaticBackendState, sheetId: string): SheetDelta | null {
  const delta = state.pendingDelta
  if (!delta) return null
  let sheet = delta.sheetDeltas.get(sheetId)
  if (!sheet) {
    sheet = {}
    delta.sheetDeltas.set(sheetId, sheet)
  }
  // A full-sheet capture already covers every granular field.
  return sheet.fullSheet ? null : sheet
}

function recordCellBefore(state: StaticBackendState, sheetId: string, key: string): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const cells = sheet.cells ?? (sheet.cells = new Map())
  if (cells.has(key)) return // first touch wins
  const cell = state.cellsBySheet.get(sheetId)?.get(key)
  cells.set(key, cell ? cloneCell(cell) : null)
}

function recordCellsBeforeInRange(
  state: StaticBackendState,
  sheetId: string,
  range: CellRange,
): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const live = state.cellsBySheet.get(sheetId)
  if (!live) return
  const cells = sheet.cells ?? (sheet.cells = new Map())
  for (const [key, cell] of live) {
    if (!isCellInsideRange(cell, range)) continue
    if (!cells.has(key)) cells.set(key, cloneCell(cell))
  }
}

function recordCellFormatBefore(state: StaticBackendState, sheetId: string, key: string): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const formats = sheet.cellFormats ?? (sheet.cellFormats = new Map())
  if (formats.has(key)) return
  const format = state.cellFormatsBySheetId.get(sheetId)?.get(key)
  formats.set(key, format ? cloneFormat(format) : null)
}

function recordCellFormatsBeforeInRange(
  state: StaticBackendState,
  sheetId: string,
  range: CellRange,
): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const live = state.cellFormatsBySheetId.get(sheetId)
  if (!live) return
  const formats = sheet.cellFormats ?? (sheet.cellFormats = new Map())
  for (const [key, format] of live) {
    const coord = parseKey(key)
    if (!coord || !isCoordInsideRange(coord.row, coord.col, range)) continue
    if (!formats.has(key)) formats.set(key, cloneFormat(format))
  }
}

function recordRangeFormatsBefore(state: StaticBackendState, sheetId: string): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet || sheet.rangeFormats) return
  sheet.rangeFormats = cloneRangeFormatLayers(state.rangeFormatsBySheetId.get(sheetId) ?? [])
}

function recordConditionalRulesBefore(state: StaticBackendState, sheetId: string): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet || sheet.conditionalFormatRules) return
  sheet.conditionalFormatRules = (
    state.conditionalFormatRulesBySheetId.get(sheetId) ?? []
  ).map(cloneConditionalFormatRuleEntry)
}

function recordMergeRangesBefore(state: StaticBackendState, sheetId: string): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet || sheet.mergeRanges) return
  sheet.mergeRanges = (state.mergeRangesBySheetId.get(sheetId) ?? []).map((r) => ({ ...r }))
}

function recordRowHeightBefore(state: StaticBackendState, sheetId: string, rowIndex: number): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const heights = sheet.rowHeights ?? (sheet.rowHeights = new Map())
  if (heights.has(rowIndex)) return
  heights.set(rowIndex, state.rowHeightsBySheetId.get(sheetId)?.get(rowIndex) ?? null)
}

function recordColWidthBefore(state: StaticBackendState, sheetId: string, colIndex: number): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const widths = sheet.colWidths ?? (sheet.colWidths = new Map())
  if (widths.has(colIndex)) return
  widths.set(colIndex, state.colWidthsBySheetId.get(sheetId)?.get(colIndex) ?? null)
}

function recordNamedRangesBefore(state: StaticBackendState): void {
  const delta = state.pendingDelta
  if (!delta || delta.namedRanges) return
  delta.namedRanges = state.namedRanges.map(cloneNamedRange)
}

function recordSheetsMetaBefore(state: StaticBackendState): void {
  const delta = state.pendingDelta
  if (!delta || delta.sheetsMeta) return
  delta.sheetsMeta = state.sheets.map((s) => ({ ...s }))
}

function captureFullSheet(state: StaticBackendState, sheetId: string): FullSheetCapture {
  return {
    cells: new Map(
      Array.from(state.cellsBySheet.get(sheetId) ?? [], ([key, cell]) => [key, cloneCell(cell)]),
    ),
    cellFormats: new Map(
      Array.from(state.cellFormatsBySheetId.get(sheetId) ?? [], ([key, format]) => [
        key,
        cloneFormat(format),
      ]),
    ),
    rangeFormats: cloneRangeFormatLayers(state.rangeFormatsBySheetId.get(sheetId) ?? []),
    conditionalFormatRules: (
      state.conditionalFormatRulesBySheetId.get(sheetId) ?? []
    ).map(cloneConditionalFormatRuleEntry),
    mergeRanges: (state.mergeRangesBySheetId.get(sheetId) ?? []).map((r) => ({ ...r })),
    rowHeights: new Map(state.rowHeightsBySheetId.get(sheetId) ?? []),
    colWidths: new Map(state.colWidthsBySheetId.get(sheetId) ?? []),
  }
}

function restoreFullSheet(
  state: StaticBackendState,
  sheetId: string,
  capture: FullSheetCapture,
): void {
  // Ownership transfer is safe: a delta is applied at most once (popped
  // from its stack) and the symmetric inverse is captured separately.
  state.cellsBySheet.set(sheetId, capture.cells)
  state.cellFormatsBySheetId.set(sheetId, capture.cellFormats)
  state.rangeFormatsBySheetId.set(sheetId, capture.rangeFormats)
  state.conditionalFormatRulesBySheetId.set(sheetId, capture.conditionalFormatRules)
  state.mergeRangesBySheetId.set(sheetId, capture.mergeRanges)
  state.rowHeightsBySheetId.set(sheetId, capture.rowHeights)
  state.colWidthsBySheetId.set(sheetId, capture.colWidths)
}

function recordFullSheetBefore(state: StaticBackendState, sheetId: string): void {
  const delta = state.pendingDelta
  if (!delta) return
  let sheet = delta.sheetDeltas.get(sheetId)
  if (!sheet) {
    sheet = {}
    delta.sheetDeltas.set(sheetId, sheet)
  }
  if (sheet.fullSheet) return
  sheet.fullSheet = captureFullSheet(state, sheetId)
  // Full capture supersedes any granular records taken earlier.
  delete sheet.cells
  delete sheet.cellFormats
  delete sheet.rangeFormats
  delete sheet.conditionalFormatRules
  delete sheet.mergeRanges
  delete sheet.rowHeights
  delete sheet.colWidths
}

function applyEntryDelta<V>(
  live: Map<string, V>,
  recorded: Map<string, V | null>,
  cloneValue: (value: V) => V,
): Map<string, V | null> {
  const inverse = new Map<string, V | null>()
  for (const [key, before] of recorded) {
    const current = live.get(key)
    inverse.set(key, current === undefined ? null : cloneValue(current))
    if (before === null) {
      live.delete(key)
    } else {
      live.set(key, before)
    }
  }
  return inverse
}

function applyDimensionDelta(
  live: Map<number, number>,
  recorded: Map<number, number | null>,
): Map<number, number | null> {
  const inverse = new Map<number, number | null>()
  for (const [index, before] of recorded) {
    inverse.set(index, live.get(index) ?? null)
    if (before === null) {
      live.delete(index)
    } else {
      live.set(index, before)
    }
  }
  return inverse
}

/**
 * Apply a delta (restore its before-values) and return the symmetric
 * inverse delta capturing the values being overwritten — undo produces
 * the redo entry and vice versa.
 */
function applyStateDelta(state: StaticBackendState, delta: StateDelta): StateDelta {
  const inverse: StateDelta = { sheetDeltas: new Map(), revision: state.revision }

  if (delta.sheetsMeta) {
    inverse.sheetsMeta = state.sheets.map((s) => ({ ...s }))
    state.sheets = delta.sheetsMeta.map((s) => ({ ...s }))
  }
  if (delta.namedRanges) {
    inverse.namedRanges = state.namedRanges.map(cloneNamedRange)
    state.namedRanges = delta.namedRanges.map(cloneNamedRange)
  }

  for (const [sheetId, sheet] of delta.sheetDeltas) {
    const inverseSheet: SheetDelta = {}

    if (sheet.fullSheet) {
      inverseSheet.fullSheet = captureFullSheet(state, sheetId)
      restoreFullSheet(state, sheetId, sheet.fullSheet)
    } else {
      if (sheet.cells) {
        inverseSheet.cells = applyEntryDelta(
          getOrCreateSheetCells(state, sheetId),
          sheet.cells,
          cloneCell,
        )
      }
      if (sheet.cellFormats) {
        inverseSheet.cellFormats = applyEntryDelta(
          getOrCreateCellFormats(state, sheetId),
          sheet.cellFormats,
          cloneFormat,
        )
      }
      if (sheet.rangeFormats) {
        inverseSheet.rangeFormats = cloneRangeFormatLayers(
          state.rangeFormatsBySheetId.get(sheetId) ?? [],
        )
        state.rangeFormatsBySheetId.set(sheetId, cloneRangeFormatLayers(sheet.rangeFormats))
      }
      if (sheet.conditionalFormatRules) {
        inverseSheet.conditionalFormatRules = (
          state.conditionalFormatRulesBySheetId.get(sheetId) ?? []
        ).map(cloneConditionalFormatRuleEntry)
        state.conditionalFormatRulesBySheetId.set(
          sheetId,
          sheet.conditionalFormatRules.map(cloneConditionalFormatRuleEntry),
        )
      }
      if (sheet.mergeRanges) {
        inverseSheet.mergeRanges = (state.mergeRangesBySheetId.get(sheetId) ?? []).map((r) => ({
          ...r,
        }))
        state.mergeRangesBySheetId.set(
          sheetId,
          sheet.mergeRanges.map((r) => ({ ...r })),
        )
      }
      if (sheet.rowHeights) {
        inverseSheet.rowHeights = applyDimensionDelta(
          getDimensionMap(state.rowHeightsBySheetId, sheetId),
          sheet.rowHeights,
        )
      }
      if (sheet.colWidths) {
        inverseSheet.colWidths = applyDimensionDelta(
          getDimensionMap(state.colWidthsBySheetId, sheetId),
          sheet.colWidths,
        )
      }
    }

    inverse.sheetDeltas.set(sheetId, inverseSheet)
  }

  state.revision = delta.revision
  return inverse
}

function getOrCreateSheetCells(
  state: StaticBackendState,
  sheetId: string,
): Map<string, DisplayCell> {
  let cells = state.cellsBySheet.get(sheetId)
  if (!cells) {
    cells = new Map()
    state.cellsBySheet.set(sheetId, cells)
  }
  return cells
}

function getOrCreateCellFormats(
  state: StaticBackendState,
  sheetId: string,
): Map<string, SpreadsheetCellFormat> {
  let formats = state.cellFormatsBySheetId.get(sheetId)
  if (!formats) {
    formats = new Map()
    state.cellFormatsBySheetId.set(sheetId, formats)
  }
  return formats
}

function getOrCreateRangeFormats(
  state: StaticBackendState,
  sheetId: string,
): RangeFormatLayer[] {
  let layers = state.rangeFormatsBySheetId.get(sheetId)
  if (!layers) {
    layers = []
    state.rangeFormatsBySheetId.set(sheetId, layers)
  }
  return layers
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
  const defaultSheetId = sheets[0]?.id ?? 'sheet-1'
  const cellMap = new Map<string, DisplayCell>()
  const cellFormats = new Map<string, SpreadsheetCellFormat>()
  const mergeRangesBySheetId = extractMergeRanges(cells, defaultSheetId)

  for (const cell of cells) {
    const key = keyFor(cell.row, cell.col)
    const format = normalizeFormat(cell.format)
    if (format) cellFormats.set(key, format)
    cellMap.set(key, stripCellFormat(cell))
  }

  const cellsBySheet = new Map<string, Map<string, DisplayCell>>()
  cellsBySheet.set(defaultSheetId, cellMap)
  const cellFormatsBySheetId = new Map<string, Map<string, SpreadsheetCellFormat>>()
  cellFormatsBySheetId.set(defaultSheetId, cellFormats)

  return {
    cellsBySheet,
    cellFormatsBySheetId,
    rangeFormatsBySheetId: new Map(),
    conditionalFormatRulesBySheetId: new Map(),
    filterSortBySheetId: new Map(),
    namedRanges: [],
    mergeRangesBySheetId,
    rowHeightsBySheetId: new Map(),
    colWidthsBySheetId: new Map(),
    sheets,
    revision,
    undoStack: [],
    redoStack: [],
    pendingDelta: null,
  }
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
  const sheetCells = getOrCreateSheetCells(state, request.sheetId)
  const cells = [...sheetCells.values()]
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

function addFormatOnlyCells(
  resultCells: Map<string, DisplayCell>,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
  displayRows: readonly number[] | null = null,
) {
  const filterSortActive = displayRows !== null
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    const sourceRow = filterSortActive ? displayRows[row] : row
    if (sourceRow === undefined) continue

    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(row, col)
      const existing = resultCells.get(key)
      const format = getEffectiveFormat(sourceRow, col, cellFormats, rangeFormats)

      if (existing) {
        if (format) existing.format = format
      } else if (format) {
        resultCells.set(key, {
          row,
          col,
          displayValue: '',
          valueKind: 'blank',
          format,
          ...(filterSortActive ? { originalRow: sourceRow } : {}),
        })
      }
    }
  }
}

function applyNumberFormatToCell(cell: DisplayCell, workbookLocale: string): void {
  const numberFormat = cell.format?.numberFormat
  if (!numberFormat) return
  if (cell.valueKind === 'error') return
  if (cell.valueKind !== 'number' && numberFormat.kind !== 'text' && numberFormat.kind !== 'custom') {
    return
  }
  const raw = cell.displayValue
  const numeric = Number(raw)
  const value =
    cell.valueKind === 'number' && Number.isFinite(numeric)
      ? numeric
      : raw
  const locale = cell.format?.locale ?? workbookLocale
  const result = formatNumberValue(numberFormat, value, { locale })
  cell.displayValue = result.text
  if (result.color && !cell.format!.fgColor) {
    cell.format = { ...cell.format!, fgColor: result.color }
  }
}

function readFilterSortValue(
  sheetCells: Map<string, DisplayCell>,
  lookup: EvalCellLookup,
  row: number,
  col: number,
): string {
  const cell = sheetCells.get(keyFor(row, col))
  if (!cell) return ''
  if (!cell.formula) return cell.displayValue

  const evaluated = evaluateFormula(cell.formula, lookup)
  return formatEvalResult(evaluated).display
}

function getMaxSourceRow(sheetCells: Map<string, DisplayCell>): number {
  let maxRow = -1
  for (const cell of sheetCells.values()) {
    if (cell.row > maxRow) maxRow = cell.row
  }
  return maxRow
}

function buildFilterSortDisplayRows(
  sheetCells: Map<string, DisplayCell>,
  lookup: EvalCellLookup,
  state: FilterSortState | undefined,
): number[] | null {
  const maxRow = getMaxSourceRow(sheetCells)
  return buildFilterSortDisplayRowsShared(
    state,
    { headerRow: 0, startRow: 1, endRow: maxRow + 1 },
    (row, col) => readFilterSortValue(sheetCells, lookup, row, col),
  )
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

function projectSourceCell(
  cell: DisplayCell,
  options: {
    displayRow: number
    displayCol: number
    sourceRow: number
    lookup: EvalCellLookup
    cellFormats: Map<string, SpreadsheetCellFormat>
    rangeFormats: RangeFormatLayer[]
    workbookLocale: string
    filterSortActive: boolean
  },
): DisplayCell {
  const clone = cloneCell(cell)
  clone.row = options.displayRow
  clone.col = options.displayCol
  if (options.filterSortActive) {
    clone.originalRow = options.sourceRow
  }

  if (clone.formula) {
    const result = evaluateFormula(clone.formula, options.lookup)
    const formatted = formatEvalResult(result)
    clone.displayValue = formatted.display
    clone.valueKind = formatted.isError ? 'error' : 'number'
    if (formatted.isError) {
      clone.error = {
        code: formatted.display.replace(/^#|!$/g, '').toUpperCase(),
        message: formatted.display,
      }
    }
  }

  const format = getEffectiveFormat(
    options.sourceRow,
    options.displayCol,
    options.cellFormats,
    options.rangeFormats,
  )
  if (format) clone.format = format

  applyNumberFormatToCell(clone, options.workbookLocale)
  return clone
}

function applyValidationRule(state: StaticBackendState, request: SetValidationRuleRequest): number {
  const cells = getOrCreateSheetCells(state, request.sheetId)
  const range = normalizeRange(request.range)
  const validation = {
    code: `validation.${request.rule.kind}`,
    severity: validationSeverityForMode(request.mode),
    message: validationMessageForRule(request.rule),
  }
  let changed = 0

  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      // upsertBlankCell mutates the LIVE cell object in place — record
      // the before-clone first (audit D-2).
      recordCellBefore(state, request.sheetId, keyFor(row, col))
      const cell = upsertBlankCell(cells, row, col)
      cell.validation = { ...validation }
      changed += 1
    }
  }

  return changed
}

function clearValidationRule(
  state: StaticBackendState,
  request: ClearValidationRuleRequest,
): number {
  const cells = getOrCreateSheetCells(state, request.sheetId)
  const range = normalizeRange(request.range)
  let changed = 0

  for (const cell of cells.values()) {
    if (!isCellInsideRange(cell, range) || !cell.validation) continue
    recordCellBefore(state, request.sheetId, keyFor(cell.row, cell.col))
    delete cell.validation
    changed += 1
  }

  return changed
}

function mutationResult(
  request: {
    sheetId: string
    requestId?: number
    revision?: ProjectionRevision
  },
  revision: ProjectionRevision,
  affectedRange?: CellRange,
): BackendMutationResult {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
    ...(affectedRange ? { affectedRange: cloneRange(normalizeRange(affectedRange)) } : {}),
  }
}

function listConditionalFormatRulesForSheet(
  state: StaticBackendState,
  sheetId: string,
): ConditionalFormatRuleEntry[] {
  return (state.conditionalFormatRulesBySheetId.get(sheetId) ?? [])
    .map(cloneConditionalFormatRuleEntry)
    .sort((left, right) => left.priority - right.priority)
}

function setConditionalFormatRuleInState(
  state: StaticBackendState,
  request: SetConditionalFormatRuleRequest,
): ConditionalFormatRuleEntry {
  const current = state.conditionalFormatRulesBySheetId.get(request.sheetId) ?? []
  const existingIndex = request.ruleId
    ? current.findIndex((entry) => entry.id === request.ruleId)
    : -1
  const entry: ConditionalFormatRuleEntry = {
    id:
      existingIndex >= 0
        ? current[existingIndex].id
        : request.ruleId ?? nextConditionalFormatRuleId(current),
    scope: { range: cloneRange(normalizeRange(request.scope.range)) },
    priority:
      request.priority ?? (existingIndex >= 0 ? current[existingIndex].priority : current.length),
    rule: cloneConditionalFormatRule(request.rule),
  }
  const next =
    existingIndex >= 0
      ? current.map((item, index) => (index === existingIndex ? entry : item))
      : [...current, entry]
  state.conditionalFormatRulesBySheetId.set(
    request.sheetId,
    next.map((item, index) => ({ ...item, priority: item.priority ?? index })),
  )
  return cloneConditionalFormatRuleEntry(entry)
}

function removeConditionalFormatRuleFromState(
  state: StaticBackendState,
  request: RemoveConditionalFormatRuleRequest,
): boolean {
  const current = state.conditionalFormatRulesBySheetId.get(request.sheetId) ?? []
  const next = current.filter((entry) => entry.id !== request.ruleId)
  state.conditionalFormatRulesBySheetId.set(request.sheetId, next)
  return next.length !== current.length
}

function namedRangeScopeEquals(left: NamedRange['scope'], right: NamedRange['scope']): boolean {
  if (left === 'workbook' || right === 'workbook') return left === right
  return left.sheetId === right.sheetId
}

function setNamedRangeInState(state: StaticBackendState, request: SetNamedRangeRequest): void {
  const name = request.name.trim()
  if (name.length === 0) throw new Error('name cannot be empty')
  const entry: NamedRange = {
    name,
    scope: request.scope === 'workbook' ? 'workbook' : { sheetId: request.scope.sheetId },
    refersTo: { ...request.refersTo },
  }
  const existingIndex = state.namedRanges.findIndex(
    (item) => item.name === name && namedRangeScopeEquals(item.scope, request.scope),
  )
  state.namedRanges =
    existingIndex >= 0
      ? state.namedRanges.map((item, index) => (index === existingIndex ? entry : item))
      : [...state.namedRanges, entry]
}

function deleteNamedRangeFromState(
  state: StaticBackendState,
  request: DeleteNamedRangeRequest,
): boolean {
  const next = state.namedRanges.filter(
    (item) => !(item.name === request.name && namedRangeScopeEquals(item.scope, request.scope)),
  )
  const changed = next.length !== state.namedRanges.length
  state.namedRanges = next
  return changed
}

function listNamedRangesFromState(
  state: StaticBackendState,
  request?: ListNamedRangesRequest,
): NamedRangeListResult {
  return {
    requestId: request?.requestId,
    revision: request?.revision ?? state.revision,
    names: state.namedRanges.map(cloneNamedRange),
  }
}

function buildProjectionResult(
  request: StaticProjectionRequest,
  state: StaticBackendState,
): StaticProjectionResult {
  const range = request.kind === 'visible-window' ? request.window : request.range
  const resultCellMap = new Map<string, DisplayCell>()
  const sheetCells = getOrCreateSheetCells(state, request.sheetId)
  const cellFormats = getOrCreateCellFormats(state, request.sheetId)
  const rangeFormats = getOrCreateRangeFormats(state, request.sheetId)
  const conditionalRules = state.conditionalFormatRulesBySheetId.get(request.sheetId) ?? []
  const filterSortState = state.filterSortBySheetId.get(request.sheetId)
  const workbookLocale = state.workbookLocale ?? DEFAULT_WORKBOOK_LOCALE

  const lookup: EvalCellLookup = {
    get(row: number, col: number) {
      return sheetCells.get(keyFor(row, col))
    },
  }
  const displayRows = buildFilterSortDisplayRows(sheetCells, lookup, filterSortState)
  const filterSortActive = displayRows !== null

  if (filterSortActive) {
    for (let displayRow = range.rowStart; displayRow <= range.rowEnd; displayRow += 1) {
      const sourceRow = displayRows[displayRow]
      if (sourceRow === undefined) continue

      for (let col = range.colStart; col <= range.colEnd; col += 1) {
        const cell = sheetCells.get(keyFor(sourceRow, col))
        if (!cell) continue
        const clone = projectSourceCell(cell, {
          displayRow,
          displayCol: col,
          sourceRow,
          lookup,
          cellFormats,
          rangeFormats,
          workbookLocale,
          filterSortActive,
        })
        resultCellMap.set(keyFor(clone.row, clone.col), clone)
      }
    }
  } else {
    for (const cell of sheetCells.values()) {
      if (!isCellInsideRange(cell, range)) continue
      const clone = projectSourceCell(cell, {
        displayRow: cell.row,
        displayCol: cell.col,
        sourceRow: cell.row,
        lookup,
        cellFormats,
        rangeFormats,
        workbookLocale,
        filterSortActive,
      })
      resultCellMap.set(keyFor(clone.row, clone.col), clone)
    }
  }

  addFormatOnlyCells(resultCellMap, range, cellFormats, rangeFormats, displayRows)
  for (const [cellKey, cell] of resultCellMap) {
    const sourceRow = cell.originalRow ?? cell.row
    const conditionalFormat = getConditionalFormatForCell(
      sourceRow,
      cell.col,
      cell,
      conditionalRules,
    )
    if (conditionalFormat) {
      resultCellMap.set(cellKey, {
        ...cell,
        conditionalFormat: {
          ...(cell.conditionalFormat ? cloneFormat(cell.conditionalFormat) : {}),
          ...conditionalFormat,
        },
      })
    }
  }
  applyMergeMetadata(
    resultCellMap,
    range,
    filterSortActive ? [] : state.mergeRangesBySheetId.get(request.sheetId) ?? [],
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
  options?: { preserveAsText?: boolean },
): DisplayCell | null {
  if (request.input.length === 0) {
    cells.delete(keyFor(request.row, request.col))
    return null
  }

  // preserveAsText: bypass numeric inference and formula detection. The
  // input lands verbatim as a string cell — `=A1` stays literal `=A1`,
  // `00123` keeps its leading zeros.
  if (options?.preserveAsText) {
    const cell: DisplayCell = {
      row: request.row,
      col: request.col,
      displayValue: request.input,
      valueKind: 'string',
    }
    cells.set(keyFor(request.row, request.col), cell)
    return cell
  }

  const trimmed = request.input.trimStart()
  const isFormula = trimmed.startsWith('=')

  let displayValue = request.input
  let valueKind: DisplayCell['valueKind'] = 'string'
  let formula: string | undefined

  if (isFormula) {
    formula = trimmed
    // Initial pass — display will be replaced at projection-read time once we
    // have the full sheet to resolve references against. Store a placeholder
    // so downstream consumers (formula bar) see *something* before the next
    // projection refresh.
    displayValue = trimmed
    valueKind = 'string'
  } else {
    const numeric = Number(request.input)
    if (Number.isFinite(numeric) && request.input.trim().length > 0) {
      valueKind = 'number'
    }
  }

  const cell: DisplayCell = {
    row: request.row,
    col: request.col,
    displayValue,
    valueKind,
    ...(formula ? { formula } : {}),
  }

  cells.set(keyFor(request.row, request.col), cell)
  return cell
}

function valueKindForRichValue(value: DisplayCellRichValue): DisplayCell['valueKind'] {
  switch (value.kind) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'error':
      return 'error'
    default:
      return 'string'
  }
}

function updateCellRichValue(
  cells: Map<string, DisplayCell>,
  request: SetCellRichValueRequest,
): DisplayCell {
  const richValue = cloneRichValue(request.value)
  const cell: DisplayCell = {
    row: request.row,
    col: request.col,
    displayValue: getRichValueText(richValue),
    valueKind: valueKindForRichValue(richValue),
    richValue,
  }

  cells.set(keyFor(request.row, request.col), cell)
  return cell
}

function clearRangeValues(cells: Map<string, DisplayCell>, range: CellRange): number {
  let cleared = 0

  for (const [key, cell] of [...cells.entries()]) {
    if (isCellInsideRange(cell, range)) {
      cells.delete(key)
      cleared += 1
    }
  }

  return cleared
}

function clearRangeFormats(
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
  range: CellRange,
): number {
  let cleared = 0

  for (const [key] of [...cellFormats.entries()]) {
    const coord = parseKey(key)
    if (coord && isCoordInsideRange(coord.row, coord.col, range)) {
      cellFormats.delete(key)
      cleared += 1
    }
  }

  // Mirror Rust set_format_range(null): drop per-cell overrides inside the
  // range (above) and push a default-format layer that supersedes underlying
  // range layers only within the cleared rectangle. Removing layers outright
  // would also strip formatting from cells outside the requested range when a
  // layer spans both.
  const intersects = rangeFormats.some((layer) => rangesIntersect(layer.range, range))
  if (intersects) {
    rangeFormats.push({ range: cloneRange(normalizeRange(range)), format: {} })
    cleared += 1
  }

  return cleared
}

function applyClearRange(state: StaticBackendState, request: ClearRangeRequest): number {
  const target = request.target ?? 'all'
  let cleared = 0

  if (target === 'values' || target === 'all') {
    recordCellsBeforeInRange(state, request.sheetId, request.range)
    cleared += clearRangeValues(getOrCreateSheetCells(state, request.sheetId), request.range)
  }

  if (target === 'formats' || target === 'all') {
    recordCellFormatsBeforeInRange(state, request.sheetId, request.range)
    recordRangeFormatsBefore(state, request.sheetId)
    cleared += clearRangeFormats(
      getOrCreateCellFormats(state, request.sheetId),
      getOrCreateRangeFormats(state, request.sheetId),
      request.range,
    )
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

  const sheetCells = getOrCreateSheetCells(state, request.sheetId)
  const cellFormats = getOrCreateCellFormats(state, request.sheetId)
  const rangeFormats = getOrCreateRangeFormats(state, request.sheetId)
  const sourceCells = new Map<string, DisplayCell>()
  for (const cell of sheetCells.values()) {
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
      recordCellBefore(state, request.sheetId, targetKey)
      recordCellFormatBefore(state, request.sheetId, targetKey)

      if (sourceCell) {
        sheetCells.set(targetKey, {
          ...cloneCell(sourceCell),
          row,
          col,
        })
      } else {
        sheetCells.delete(targetKey)
      }

      const sourceFormat = getEffectiveFormat(
        sourceCoord.row,
        sourceCoord.col,
        cellFormats,
        rangeFormats,
      )
      if (sourceFormat) {
        cellFormats.set(targetKey, sourceFormat)
      } else {
        cellFormats.delete(targetKey)
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
  const sheetCells = getOrCreateSheetCells(state, request.sheetId)

  if (request.direction === 'left' || request.direction === 'right') {
    const occupiedCols = [...sheetCells.values()]
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

  const occupiedRows = [...sheetCells.values()]
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
      beginUndoableMutation(state)
      recordCellBefore(state, request.sheetId, keyFor(request.row, request.col))
      updateCell(getOrCreateSheetCells(state, request.sheetId), request)
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
    async setCellRichValue(request) {
      beginUndoableMutation(state)
      recordCellBefore(state, request.sheetId, keyFor(request.row, request.col))
      updateCellRichValue(getOrCreateSheetCells(state, request.sheetId), request)
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
      beginUndoableMutation(state)
      const cells = getOrCreateSheetCells(state, request.sheetId)
      for (const cell of request.cells) {
        recordCellBefore(state, request.sheetId, keyFor(cell.row, cell.col))
        updateCell(
          cells,
          {
            kind: 'set-cell-input',
            sheetId: request.sheetId,
            row: cell.row,
            col: cell.col,
            input: cell.input,
          },
          { preserveAsText: cell.preserveAsText },
        )
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
      beginUndoableMutation(state)
      const cells = getOrCreateSheetCells(state, request.sheetId)
      for await (const chunk of request.chunks) {
        for (const cell of chunk) {
          recordCellBefore(state, request.sheetId, keyFor(cell.row, cell.col))
          updateCell(
            cells,
            {
              kind: 'set-cell-input',
              sheetId: request.sheetId,
              row: cell.row,
              col: cell.col,
              input: cell.input,
            },
            { preserveAsText: cell.preserveAsText },
          )
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
      beginUndoableMutation(state)
      applyClearRange(state, request)
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
      beginUndoableMutation(state)
      recordFullSheetBefore(state, request.sheetId)
      shiftRows(
        getOrCreateSheetCells(state, request.sheetId),
        getOrCreateCellFormats(state, request.sheetId),
        getOrCreateRangeFormats(state, request.sheetId),
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
      beginUndoableMutation(state)
      recordFullSheetBefore(state, request.sheetId)
      shiftRows(
        getOrCreateSheetCells(state, request.sheetId),
        getOrCreateCellFormats(state, request.sheetId),
        getOrCreateRangeFormats(state, request.sheetId),
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
      beginUndoableMutation(state)
      recordFullSheetBefore(state, request.sheetId)
      shiftColumns(
        getOrCreateSheetCells(state, request.sheetId),
        getOrCreateCellFormats(state, request.sheetId),
        getOrCreateRangeFormats(state, request.sheetId),
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
      beginUndoableMutation(state)
      recordFullSheetBefore(state, request.sheetId)
      shiftColumns(
        getOrCreateSheetCells(state, request.sheetId),
        getOrCreateCellFormats(state, request.sheetId),
        getOrCreateRangeFormats(state, request.sheetId),
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
      beginUndoableMutation(state)
      recordCellFormatsBeforeInRange(state, request.sheetId, request.range)
      recordRangeFormatsBefore(state, request.sheetId)
      const cellFormats = getOrCreateCellFormats(state, request.sheetId)
      const rangeFormats = getOrCreateRangeFormats(state, request.sheetId)
      clearCellFormatsInRange(cellFormats, request.range)
      rangeFormats.push({
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
    async pasteRange(request: PasteRangeRequest): Promise<PasteRangeResult> {
      // Reference implementation for Wave 7.3 Paste Special. Walks the
      // source range (read straight from this backend's in-memory state),
      // applies the requested kind/op/transpose/skipBlanks flags, and
      // writes back via the same maps that `setCellInput` /
      // `setFormatRange` mutate. Designed to be easy to reason about, not
      // to handle every Excel edge case — the host's worker backend can
      // bring its own optimised version.
      beginUndoableMutation(state)

      const sourceSheetCells = getOrCreateSheetCells(state, request.source.sheetId)
      const sourceCellFormats = getOrCreateCellFormats(state, request.source.sheetId)
      const sourceRangeFormats = getOrCreateRangeFormats(state, request.source.sheetId)
      const targetSheetCells = getOrCreateSheetCells(state, request.sheetId)
      const targetCellFormats = getOrCreateCellFormats(state, request.sheetId)

      const src = request.source.range
      const tgt = request.target
      const transpose = request.transpose || request.pasteKind === 'transpose'

      const srcRows = src.rowEnd - src.rowStart + 1
      const srcCols = src.colEnd - src.colStart + 1
      // Effective height/width of the patch we write at the target,
      // accounting for transpose. The target is clamped to the source
      // shape — Excel's classic Paste Special behaviour.
      const patchRows = transpose ? srcCols : srcRows
      const patchCols = transpose ? srcRows : srcCols

      const writeValues =
        request.pasteKind === 'values' ||
        request.pasteKind === 'values-and-formats' ||
        request.pasteKind === 'all' ||
        request.pasteKind === 'transpose'

      const writeFormats =
        request.pasteKind === 'formats' ||
        request.pasteKind === 'values-and-formats' ||
        request.pasteKind === 'all'

      // 'column-widths' and 'comments' are accepted as no-ops by this
      // reference backend; a future revision can wire them through the
      // dimension-map / comments stores.

      function numericInput(input: string | undefined): number | null {
        if (input === undefined) return null
        const trimmed = input.trim()
        if (trimmed === '') return null
        const n = Number(trimmed)
        return Number.isFinite(n) ? n : null
      }

      // Excel error literals follow `#NAME!` / `#DIV/0!` / `#VALUE!` /
      // `#REF!` / `#NUM!` / `#N/A` shapes. Pre-paste arithmetic must
      // pass an error source/target straight through rather than try to
      // coerce a `#...` string to a number.
      function isErrorLiteral(input: string | undefined): boolean {
        if (input === undefined) return false
        const trimmed = input.trim()
        return trimmed.startsWith('#') && trimmed.length > 1
      }

      /**
       * Arithmetic coercion for paste-special op != 'none'. Semantics
       * (documented in `vanilla/spreadsheet-ui-core/src/paste-special/README.md`):
       *
       *   - error source OR error target → preserve the existing target
       *     (returns `null` to signal the caller to skip the write).
       *   - non-numeric source → preserve the existing target (skip).
       *   - non-numeric target → treated as 0 (Excel behaviour).
       *   - divide-by-zero → emit the `#DIV/0!` error literal.
       *
       * `null` return = skip the write entirely. A returned string is the
       * new cell input.
       */
      function applyOp(
        sourceInput: string,
        targetInput: string | undefined,
      ): string | null {
        if (request.op === 'none') return sourceInput

        if (isErrorLiteral(sourceInput) || isErrorLiteral(targetInput)) {
          // Pass-through: leave the target untouched.
          return null
        }

        const b = numericInput(sourceInput)
        if (b === null) {
          // Text source — operation undefined for non-numerics; skip
          // rather than overwrite the target with the literal text.
          return null
        }
        const a = numericInput(targetInput) ?? 0

        switch (request.op) {
          case 'add':
            return String(a + b)
          case 'subtract':
            return String(a - b)
          case 'multiply':
            return String(a * b)
          case 'divide':
            if (b === 0) return '#DIV/0!'
            return String(a / b)
          default:
            return sourceInput
        }
      }

      for (let dr = 0; dr < patchRows; dr += 1) {
        for (let dc = 0; dc < patchCols; dc += 1) {
          // Map (dr, dc) inside the patch back to a source coordinate,
          // accounting for transpose.
          const srcRow = transpose ? src.rowStart + dc : src.rowStart + dr
          const srcCol = transpose ? src.colStart + dr : src.colStart + dc
          const tgtRow = tgt.rowStart + dr
          const tgtCol = tgt.colStart + dc
          const srcKey = keyFor(srcRow, srcCol)
          const tgtKey = keyFor(tgtRow, tgtCol)
          const srcCell = sourceSheetCells.get(srcKey)
          const srcDisplay = srcCell?.displayValue ?? ''

          // Skip-blanks: if the source cell is empty, leave the target alone.
          if (request.skipBlanks && srcDisplay.length === 0 && !srcCell?.formula) {
            continue
          }

          if (writeValues) {
            const baseInput = srcCell?.formula ?? srcDisplay
            const targetCell = targetSheetCells.get(tgtKey)
            const finalInput =
              request.op === 'none'
                ? baseInput
                : applyOp(baseInput, targetCell?.displayValue)
            // `applyOp` returns `null` when arithmetic coercion would be
            // ill-defined (text/error sides) — preserve the target
            // verbatim. Otherwise reuse the in-place setCellInput
            // helper so revision/value-kind invariants stay consistent.
            if (finalInput !== null) {
              recordCellBefore(state, request.sheetId, tgtKey)
              updateCell(targetSheetCells, {
                kind: 'set-cell-input',
                sheetId: request.sheetId,
                row: tgtRow,
                col: tgtCol,
                input: finalInput,
              })
            }
          }

          if (writeFormats) {
            recordCellFormatBefore(state, request.sheetId, tgtKey)
            const effectiveFormat = getEffectiveFormat(
              srcRow,
              srcCol,
              sourceCellFormats,
              sourceRangeFormats,
            )
            if (effectiveFormat) {
              targetCellFormats.set(tgtKey, { ...effectiveFormat })
            } else {
              targetCellFormats.delete(tgtKey)
            }
          }
        }
      }

      state.revision = bumpRevision(state.revision)
      return {
        kind: 'paste-range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: tgt.rowStart,
          rowEnd: tgt.rowStart + patchRows - 1,
          colStart: tgt.colStart,
          colEnd: tgt.colStart + patchCols - 1,
        },
      }
    },
    async removeRows(request: RemoveRowsRequest): Promise<RemoveRowsResult> {
      // Reference implementation for Wave 7.5 Remove Duplicates. The dialog
      // computes `request.rows` from `findDuplicateRows`; we accept an
      // arbitrarily ordered (possibly empty, possibly duplicated) list and
      // apply each row deletion from the bottom up so earlier deletions do
      // not shift the indices of later ones.
      //
      // Empty input is a no-op (no snapshot recorded, no revision bump) so
      // that an accidental "no duplicates found → confirm" round-trip does
      // not pollute the undo stack.
      const unique = Array.from(new Set(request.rows)).filter(
        (r) => Number.isInteger(r) && r >= 0,
      )
      if (unique.length === 0) {
        return {
          sheetId: request.sheetId,
          removedRows: 0,
          revision: request.revision ?? state.revision,
        }
      }

      // Descending so each shift step keeps remaining row indices valid.
      unique.sort((a, b) => b - a)
      const minRow = unique[unique.length - 1]
      const maxRow = unique[0]

      beginUndoableMutation(state)
      recordFullSheetBefore(state, request.sheetId)

      const cells = getOrCreateSheetCells(state, request.sheetId)
      const cellFormats = getOrCreateCellFormats(state, request.sheetId)
      const rangeFormats = getOrCreateRangeFormats(state, request.sheetId)
      const rowHeights = getDimensionMap(state.rowHeightsBySheetId, request.sheetId)

      for (const rowIdx of unique) {
        shiftRows(cells, cellFormats, rangeFormats, rowIdx, 1, -1)
        shiftDimensionMap(rowHeights, rowIdx, 1, -1)
      }

      state.revision = bumpRevision(state.revision)

      // Span of touched rows for callers that want to invalidate a
      // contiguous projection window. We don't know the workbook's true
      // column extent, so report the union of any existing column range:
      // `findDuplicateRows` only ever ran across the dialog's range, so
      // every column in the spreadsheet is potentially affected by the
      // upward shift of rows below `minRow`.
      let maxCol = -1
      for (const cell of cells.values()) {
        if (cell.col > maxCol) maxCol = cell.col
      }
      const affectedRange =
        maxCol >= 0
          ? {
              startRow: minRow,
              // Bottom shifts up — cells previously at maxRow.. now at
              // `maxRow - removed`. Report up to the prior bottom so the
              // host invalidates a generous slice.
              endRow: Math.max(minRow, maxRow),
              startCol: 0,
              endCol: maxCol,
            }
          : undefined

      return {
        sheetId: request.sheetId,
        removedRows: unique.length,
        affectedRange,
        revision: request.revision ?? state.revision,
      }
    },
    async setRowHeight(request: SetRowHeightRequest) {
      beginUndoableMutation(state)
      recordRowHeightBefore(state, request.sheetId, request.rowIndex)
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
      beginUndoableMutation(state)
      recordColWidthBefore(state, request.sheetId, request.colIndex)
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
    async listNamedRanges(request: ListNamedRangesRequest): Promise<NamedRangeListResult> {
      return listNamedRangesFromState(state, request)
    },
    async setNamedRange(request: SetNamedRangeRequest): Promise<NamedRangeMutationResult> {
      beginUndoableMutation(state)
      recordNamedRangesBefore(state)
      setNamedRangeInState(state, request)
      state.revision = bumpRevision(state.revision)
      return {
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async deleteNamedRange(
      request: DeleteNamedRangeRequest,
    ): Promise<NamedRangeMutationResult> {
      beginUndoableMutation(state)
      recordNamedRangesBefore(state)
      deleteNamedRangeFromState(state, request)
      state.revision = bumpRevision(state.revision)
      return {
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async setValidationRule(
      request: SetValidationRuleRequest,
    ): Promise<BackendMutationResult> {
      beginUndoableMutation(state)
      applyValidationRule(state, request)
      state.revision = bumpRevision(state.revision)
      return mutationResult(request, state.revision, request.range)
    },
    async clearValidationRule(
      request: ClearValidationRuleRequest,
    ): Promise<BackendMutationResult> {
      beginUndoableMutation(state)
      clearValidationRule(state, request)
      state.revision = bumpRevision(state.revision)
      return mutationResult(request, state.revision, request.range)
    },
    async listConditionalFormatRules(
      request: ListConditionalFormatRulesRequest,
    ): Promise<ConditionalFormatRulesResult> {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        rules: listConditionalFormatRulesForSheet(state, request.sheetId),
      }
    },
    async setConditionalFormatRule(
      request: SetConditionalFormatRuleRequest,
    ): Promise<BackendMutationResult> {
      beginUndoableMutation(state)
      recordConditionalRulesBefore(state, request.sheetId)
      setConditionalFormatRuleInState(state, request)
      state.revision = bumpRevision(state.revision)
      return mutationResult(request, state.revision, request.scope.range)
    },
    async removeConditionalFormatRule(
      request: RemoveConditionalFormatRuleRequest,
    ): Promise<BackendMutationResult> {
      beginUndoableMutation(state)
      recordConditionalRulesBefore(state, request.sheetId)
      removeConditionalFormatRuleFromState(state, request)
      state.revision = bumpRevision(state.revision)
      return mutationResult(request, state.revision)
    },
    async setFilterSort(request: SetFilterSortRequest): Promise<BackendMutationResult> {
      const next = cloneFilterSortState({
        rules: request.rules,
        directives: request.directives,
      })
      if (filterSortHasEffect(next)) {
        state.filterSortBySheetId.set(request.sheetId, next)
      } else {
        state.filterSortBySheetId.delete(request.sheetId)
      }
      state.revision = bumpRevision(state.revision)
      return mutationResult(request, state.revision)
    },
    async mergeRange(request) {
      beginUndoableMutation(state)
      recordMergeRangesBefore(state, request.sheetId)
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
      beginUndoableMutation(state)
      recordMergeRangesBefore(state, request.sheetId)
      const range = normalizeRange(request.range)
      const ranges = getMergeRanges(state, request.sheetId)
      state.mergeRangesBySheetId.set(
        request.sheetId,
        ranges.filter((candidate) => !rangesIntersect(candidate, range)),
      )
      state.revision = bumpRevision(state.revision)

      return mergeMutationResult(request, state.revision)
    },
    async searchRange(request) {
      const range = normalizeRange(request.range)
      const cells = state.cellsBySheet.get(request.sheetId) ?? new Map()
      const { needle, options } = request.query
      const haystackTransform = options.caseSensitive ? (s: string) => s : (s: string) => s.toLowerCase()
      const target = haystackTransform(needle)

      const matchPredicate = (() => {
        if (target.length === 0) return () => false
        if (options.regex) {
          try {
            const re = new RegExp(needle, options.caseSensitive ? '' : 'i')
            return (s: string) => re.test(s)
          } catch {
            return () => false
          }
        }
        if (options.wholeMatch) {
          return (s: string) => haystackTransform(s) === target
        }
        return (s: string) => haystackTransform(s).includes(target)
      })()

      const matches: { coord: { row: number; col: number }; sheetId: string; matchStart: number; matchEnd: number }[] = []
      for (const cell of cells.values()) {
        if (cell.row < range.rowStart || cell.row > range.rowEnd) continue
        if (cell.col < range.colStart || cell.col > range.colEnd) continue
        const haystack = options.searchFormulas ? cell.formula ?? cell.displayValue : cell.displayValue
        if (!haystack) continue
        if (!matchPredicate(haystack)) continue
        const lower = haystackTransform(haystack)
        const start = options.regex ? 0 : lower.indexOf(target)
        matches.push({
          coord: { row: cell.row, col: cell.col },
          sheetId: request.sheetId,
          matchStart: Math.max(0, start),
          matchEnd: Math.max(0, start) + needle.length,
        })
      }
      matches.sort((a, b) => (a.coord.row - b.coord.row) || (a.coord.col - b.coord.col))
      const pageStart = Math.max(0, request.pageStart)
      const page = matches.slice(pageStart, pageStart + request.pageSize)
      return {
        kind: 'search-range',
        sheetId: request.sheetId,
        matches: page,
        pageStart,
        totalCount: matches.length,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async replaceMatches(request) {
      beginUndoableMutation(state)
      // Group coords by sheet so each sheet's cell map is fetched once. We
      // sort coords within a cell by matchStart DESC so earlier replacements
      // don't shift later indices — defensive only; searchRange currently
      // emits one match per cell.
      const bySheet = new Map<string, typeof request.coords>()
      for (const c of request.coords) {
        const list = bySheet.get(c.sheetId) ?? []
        list.push(c)
        bySheet.set(c.sheetId, list)
      }
      let replacedCount = 0
      for (const [sheetId, coords] of bySheet) {
        const cells = getOrCreateSheetCells(state, sheetId)
        // Bucket by cell key, descending by matchStart.
        const byKey = new Map<string, typeof coords>()
        for (const c of coords) {
          const key = keyFor(c.coord.row, c.coord.col)
          const list = byKey.get(key) ?? []
          list.push(c)
          byKey.set(key, list)
        }
        for (const [key, list] of byKey) {
          const cell = cells.get(key)
          if (!cell) continue
          recordCellBefore(state, sheetId, key)
          // Decide which string to splice — formula text takes precedence
          // when present (mirroring `searchRange`'s `searchFormulas` path).
          const useFormula = cell.formula !== undefined
          const haystack = useFormula ? (cell.formula as string) : cell.displayValue
          list.sort((a, b) => b.matchStart - a.matchStart)
          let next = haystack
          for (const m of list) {
            const start = Math.max(0, Math.min(m.matchStart, next.length))
            const end = Math.max(start, Math.min(m.matchEnd, next.length))
            next = next.slice(0, start) + request.replacement + next.slice(end)
            replacedCount += 1
          }
          // Re-route through updateCell so formula detection / numeric
          // inference / blank-on-empty all behave like a fresh edit.
          updateCell(cells, {
            kind: 'set-cell-input',
            sheetId,
            row: cell.row,
            col: cell.col,
            input: next,
          })
        }
      }
      state.revision = bumpRevision(state.revision)
      return {
        replacedCount,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async fillRange(request) {
      beginUndoableMutation(state)
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
      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
      const name = normalizeSheetMutationName(request.name, createNextSheetName(state.sheets))
      assertUniqueSheetName(state.sheets, name)

      const createdSheet: SpreadsheetSheetMetadata = {
        id: createNextSheetId(state.sheets),
        name,
        index: state.sheets.length,
      }
      state.sheets = [...state.sheets, createdSheet]
      state.cellsBySheet.set(createdSheet.id, new Map())
      state.cellFormatsBySheetId.set(createdSheet.id, new Map())
      state.rangeFormatsBySheetId.set(createdSheet.id, [])
      state.revision = bumpRevision(state.revision)

      return sheetMutationResult(state, request.requestId, {
        sheetId: createdSheet.id,
        activeSheetId: createdSheet.id,
        createdSheet,
      })
    },
    async renameSheet(request) {
      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
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
      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
      recordNamedRangesBefore(state)
      recordFullSheetBefore(state, request.sheetId)
      if (state.sheets.length <= 1) {
        throw new Error('cannot delete the last sheet')
      }

      const deleteIndex = state.sheets.findIndex((sheet) => sheet.id === request.sheetId)
      if (deleteIndex < 0) {
        throw new Error(`unknown sheet: ${request.sheetId}`)
      }

      const nextSheets = state.sheets.filter((sheet) => sheet.id !== request.sheetId)
      state.sheets = reindexSheets(nextSheets)
      state.cellsBySheet.delete(request.sheetId)
      state.cellFormatsBySheetId.delete(request.sheetId)
      state.rangeFormatsBySheetId.delete(request.sheetId)
      state.conditionalFormatRulesBySheetId.delete(request.sheetId)
      state.namedRanges = state.namedRanges.filter((range) => {
        const scopedToDeletedSheet =
          range.scope !== 'workbook' && range.scope.sheetId === request.sheetId
        const refersToDeletedSheet =
          range.refersTo.kind === 'range' && range.refersTo.sheetId === request.sheetId
        return !scopedToDeletedSheet && !refersToDeletedSheet
      })
      state.mergeRangesBySheetId.delete(request.sheetId)
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
      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
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
    async undoTransaction(request) {
      const delta = state.undoStack.pop()
      if (!delta) {
        throw new Error('nothing to undo')
      }
      state.pendingDelta = null
      const forward = applyStateDelta(state, delta)
      state.redoStack.push(forward)
      state.revision = bumpRevision(state.revision)
      return {
        transactionId: request.transactionId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    async redoTransaction(request) {
      const delta = state.redoStack.pop()
      if (!delta) {
        throw new Error('nothing to redo')
      }
      state.pendingDelta = null
      const reverse = applyStateDelta(state, delta)
      state.undoStack.push(reverse)
      state.revision = bumpRevision(state.revision)
      return {
        transactionId: request.transactionId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
  }
}
