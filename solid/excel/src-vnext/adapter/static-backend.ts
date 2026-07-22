import type {
  BackendMutationResult,
  BackendStructuralShift,
  ClearValidationRuleRequest,
  ConditionalFormatRule,
  ConditionalFormatRuleEntry,
  ConditionalFormatRulesResult,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  DisplayCellRichValue,
  FillRangeRequest,
  FillSeriesRequest,
  HideColumnsRequest,
  HideRowsRequest,
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
  CreateTableRequest,
  CreateTableResult,
  DeleteTableRequest,
  GetTableRequest,
  GetTableResult,
  ListTablesRequest,
  ListTablesResult,
  RenameTableColumnRequest,
  RenameTableRequest,
  SetTableTotalFunctionRequest,
  SetTableTotalsRowRequest,
  SpreadsheetTableDescriptor,
  TableTotalsFunction,
  TableMutationRejectedResult,
  TableMutationRejectionCode,
  TableMutationResult,
  ReorderSheetRequest,
  RemoveConditionalFormatRuleRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  PasteRangeRequest,
  PasteRangeResult,
  RemoveRowsExactRequest,
  RemoveRowsExactResult,
  RemoveRowsRequest,
  RemoveRowsResult,
  SetCellInputRequest,
  SetCellRichValueRequest,
  SetColumnWidthRequest,
  SetConditionalFormatRuleRequest,
  SetFilterSortRequest,
  SetFilterSortResult,
  SetEvalHiddenRowsRequest,
  SetFormatRangeRequest,
  SetNamedRangeRequest,
  SetRowHeightRequest,
  SetValidationRuleRequest,
  SheetHiddenStateRequest,
  SheetHiddenStateResult,
  SheetMutationResult,
  ColumnFilterRule,
  SortRangeKey,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  NamedRange,
  NamedRangeListResult,
  NamedRangeMutationResult,
  DeleteNamedRangeRequest,
  ListNamedRangesRequest,
  ListConditionalFormatRulesRequest,
  MergeRangeRequest,
  UnmergeRangeRequest,
  UnhideColumnsRequest,
  UnhideRowsRequest,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
  FilterSortState,
  FindReplaceTarget,
  ReplaceMatchInput,
  ReplaceMatchesResponse,
  ViewportFreezeConfig,
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
  FILL_SERIES_NUMBER_EPSILON,
  filterSortHasEffect,
  formatNumberValue,
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  getRichValueText,
  isCoordInsideRange,
  isFillSeriesInteger,
  keyFor,
  nextConditionalFormatRuleId,
  namedRangeIdentity,
  normalizeCopyAsHiddenRows,
  normalizeDimensionSize,
  normalizeFormat,
  normalizeNamedRangeName,
  normalizeRange,
  numericValue,
  rangesIntersect,
  reorderSheetMetadata,
  shiftFormulaRefs,
  toA1,
  validationMessageForRule,
  validationSeverityForMode,
  type RangeFormatLayer,
  getEffectiveFormat,
  ENGINE_BUILTIN_FORMULA_NAMES,
} from '@einfach/spreadsheet-ui-core'
import { buildFilterSortDisplayRows as buildFilterSortDisplayRowsShared } from './filter-predicate'
import type {
  StaticProjectionRequest,
  StaticProjectionResult,
  StaticSeedCells,
  StaticSeedMatrix,
  StaticSeedValue,
  StaticSpreadsheetSeedInput,
  StaticSpreadsheetSheetInput,
} from './types'
import {
  evaluateFormula,
  formatEvalResult,
  rewriteStructuredRefsInFormula,
  type EvalCellLookup,
  type EvalOrigin,
  type StructuredRefResolution,
  type StructuredRefResolver,
  type StructuredRefRewriteSpec,
} from './static-formula-eval'
import {
  applyPasteArithmetic,
  isPasteSourceBlank,
  pasteRangeGeometry,
  pasteSourceCoord,
} from './paste-range-plan'
import {
  MAX_SORT_SOURCE_CELLS,
  planPhysicalSort,
  type ResolvedSortKey,
  type SortValue,
} from './sort-order'
import { filterHiddenRowsFromDisplayRows, filterTsvBandRows } from './filter-hidden-rows'

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

function extractMergeRanges(
  cells: readonly DisplayCell[],
  sheetId: string,
): Map<string, CellRange[]> {
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

/**
 * Bounded per-workbook Table cap (#32). Mirrors the engine `MAX_TABLES`
 * and the UI-core `MAX_TABLE_CATALOG_ENTRIES` so all three layers agree on
 * the ceiling.
 */
const MAX_STATIC_TABLES = 256

/** One registered Excel Table in the static backend (mirror of the engine `TableEntry`). */
interface StaticTableEntry {
  /** Display-cased name the user supplied / the engine auto-generated. */
  canonicalName: string
  /** UI-core stable sheet id the Table is anchored to. */
  sheetId: string
  /** Normalized rectangle: header row + data rows (+ totals row when shown). */
  range: CellRange
  /** MVP invariant: always `true` (row 0 of the range is the header). */
  hasHeaders: boolean
  /** Whether a totals row is currently shown (MVP: always `false`). */
  hasTotals: boolean
  /** Column display names, left→right (index 0 == `range.colStart`). */
  columns: string[]
}

interface StaticBackendState {
  cellsBySheet: Map<string, Map<string, DisplayCell>>
  cellFormatsBySheetId: Map<string, Map<string, SpreadsheetCellFormat>>
  rangeFormatsBySheetId: Map<string, RangeFormatLayer[]>
  conditionalFormatRulesBySheetId: Map<string, ConditionalFormatRuleEntry[]>
  filterSortBySheetId: Map<string, FilterSortState>
  namedRanges: NamedRange[]
  /**
   * Excel Table registry (#32, design-excel-table §4). Workbook-level,
   * keyed by the uppercased Table name (case-insensitive lookup;
   * `canonicalName` keeps the display casing). The registry is the single
   * source of truth for a Table's geometry — structured references resolve
   * against it at eval time and `listTables` / `getTable` project it. Bounded
   * to {@link MAX_STATIC_TABLES}. NOT captured by the undo delta (parity with
   * the worker/engine: table-definition mutations are out of the undo
   * timeline — design §11/§12).
   */
  tablesByKey: Map<string, StaticTableEntry>
  mergeRangesBySheetId: Map<string, CellRange[]>
  rowHeightsBySheetId: Map<string, Map<number, number>>
  colWidthsBySheetId: Map<string, Map<number, number>>
  hiddenRowsBySheetId: Map<string, Set<number>>
  hiddenColsBySheetId: Map<string, Set<number>>
  /**
   * FILTER-hidden rows derived by THIS backend when `setFilterSort` applied
   * the rules (`design-filter-hidden-rows` §4.2, slice S4) — the static
   * counterpart of what the worker adapter pushes into the engine through
   * `setEvalFilterHiddenRows`.
   *
   * Independent of `hiddenRowsBySheetId` on purpose, and NEVER merged with
   * it: Excel's `SUBTOTAL(1-11)` excludes filter-hidden rows while INCLUDING
   * manually hidden ones, a rule one merged set cannot express (design §3
   * constraint 1). Snapshot semantics — computed when the rules are applied,
   * not re-derived on every read, matching Excel's `Data → Reapply` model and
   * the worker's push point exactly.
   */
  filterHiddenRowsBySheetId: Map<string, Set<number>>
  freezeBySheetId: Map<string, ViewportFreezeConfig>
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
  hiddenRows: Set<number>
  hiddenCols: Set<number>
  /**
   * FILTER-hidden rows (S5a). Captured alongside the manual set because a
   * structural mutation now REMAPS it: undoing an insert/delete has to put
   * the pre-shift snapshot back, exactly as it does for `hiddenRows`. The
   * filter RULES are not part of the capture — they are not displaced.
   */
  filterHiddenRows: Set<number>
  /** null preserves an absent map entry; `{ rows: 0, cols: 0 }` is canonical data. */
  freeze: ViewportFreezeConfig | null
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
  /** Before-membership per touched index; false means the index was visible. */
  hiddenRows?: Map<number, boolean>
  hiddenCols?: Map<number, boolean>
  /** null means the canonical entry was absent; undefined means this delta did not touch freeze. */
  freeze?: ViewportFreezeConfig | null
  /** Labeled O(one-sheet) fallback for structural ops. Supersedes the granular fields. */
  fullSheet?: FullSheetCapture
}

interface StateDelta {
  // Revisions are monotonic projection witnesses, not historical workbook
  // facts. Undo/redo swaps only captured state and advances the live witness.
  sheetDeltas: Map<string, SheetDelta>
  namedRanges?: NamedRange[]
  sheetsMeta?: SpreadsheetSheetMetadata[]
}

const STATIC_BACKEND_UNDO_CAP = 200

function cloneRangeFormatLayers(layers: readonly RangeFormatLayer[]): RangeFormatLayer[] {
  return layers.map((layer) => ({ range: { ...layer.range }, format: cloneFormat(layer.format) }))
}

function beginUndoableMutation(state: StaticBackendState): void {
  // Every history-producing mutation must be able to publish a distinct
  // projection witness before it records history or changes workbook facts.
  // The mutation itself remains responsible for assigning the next revision
  // after its facts have been applied.
  nextRevisionOrThrow(state.revision)
  const delta: StateDelta = { sheetDeltas: new Map() }
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
  sheet.conditionalFormatRules = (state.conditionalFormatRulesBySheetId.get(sheetId) ?? []).map(
    cloneConditionalFormatRuleEntry,
  )
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

function recordHiddenIndexBefore(
  state: StaticBackendState,
  sheetId: string,
  axis: 'row' | 'column',
  index: number,
): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet) return
  const recorded =
    axis === 'row'
      ? (sheet.hiddenRows ?? (sheet.hiddenRows = new Map()))
      : (sheet.hiddenCols ?? (sheet.hiddenCols = new Map()))
  if (recorded.has(index)) return
  const live =
    axis === 'row' ? state.hiddenRowsBySheetId.get(sheetId) : state.hiddenColsBySheetId.get(sheetId)
  recorded.set(index, live?.has(index) ?? false)
}

function recordFreezeBefore(state: StaticBackendState, sheetId: string): void {
  const sheet = pendingSheetDelta(state, sheetId)
  if (!sheet || sheet.freeze !== undefined) return
  const freeze = state.freezeBySheetId.get(sheetId)
  sheet.freeze = freeze ? { ...freeze } : null
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
    conditionalFormatRules: (state.conditionalFormatRulesBySheetId.get(sheetId) ?? []).map(
      cloneConditionalFormatRuleEntry,
    ),
    mergeRanges: (state.mergeRangesBySheetId.get(sheetId) ?? []).map((r) => ({ ...r })),
    rowHeights: new Map(state.rowHeightsBySheetId.get(sheetId) ?? []),
    colWidths: new Map(state.colWidthsBySheetId.get(sheetId) ?? []),
    hiddenRows: new Set(state.hiddenRowsBySheetId.get(sheetId) ?? []),
    hiddenCols: new Set(state.hiddenColsBySheetId.get(sheetId) ?? []),
    filterHiddenRows: new Set(state.filterHiddenRowsBySheetId.get(sheetId) ?? []),
    freeze: state.freezeBySheetId.has(sheetId) ? { ...state.freezeBySheetId.get(sheetId)! } : null,
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
  if (capture.hiddenRows.size === 0) {
    state.hiddenRowsBySheetId.delete(sheetId)
  } else {
    state.hiddenRowsBySheetId.set(sheetId, new Set(capture.hiddenRows))
  }
  if (capture.hiddenCols.size === 0) {
    state.hiddenColsBySheetId.delete(sheetId)
  } else {
    state.hiddenColsBySheetId.set(sheetId, new Set(capture.hiddenCols))
  }
  if (capture.filterHiddenRows.size === 0) {
    state.filterHiddenRowsBySheetId.delete(sheetId)
  } else {
    state.filterHiddenRowsBySheetId.set(sheetId, new Set(capture.filterHiddenRows))
  }
  if (capture.freeze === null) {
    state.freezeBySheetId.delete(sheetId)
  } else {
    state.freezeBySheetId.set(sheetId, { ...capture.freeze })
  }
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
  delete sheet.hiddenRows
  delete sheet.hiddenCols
  delete sheet.freeze
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

function applyHiddenIndexDelta(
  hiddenBySheetId: Map<string, Set<number>>,
  sheetId: string,
  recorded: Map<number, boolean>,
): Map<number, boolean> {
  const live = hiddenBySheetId.get(sheetId) ?? new Set<number>()
  const inverse = new Map<number, boolean>()
  for (const [index, wasHidden] of recorded) {
    inverse.set(index, live.has(index))
    if (wasHidden) {
      live.add(index)
    } else {
      live.delete(index)
    }
  }
  if (live.size === 0) {
    hiddenBySheetId.delete(sheetId)
  } else {
    hiddenBySheetId.set(sheetId, live)
  }
  return inverse
}

/**
 * Apply a delta (restore its before-values) and return the symmetric
 * inverse delta capturing the values being overwritten — undo produces
 * the redo entry and vice versa.
 */
function applyStateDelta(state: StaticBackendState, delta: StateDelta): StateDelta {
  const inverse: StateDelta = { sheetDeltas: new Map() }

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
      if (sheet.hiddenRows) {
        inverseSheet.hiddenRows = applyHiddenIndexDelta(
          state.hiddenRowsBySheetId,
          sheetId,
          sheet.hiddenRows,
        )
      }
      if (sheet.hiddenCols) {
        inverseSheet.hiddenCols = applyHiddenIndexDelta(
          state.hiddenColsBySheetId,
          sheetId,
          sheet.hiddenCols,
        )
      }
      if (sheet.freeze !== undefined) {
        const current = state.freezeBySheetId.get(sheetId)
        inverseSheet.freeze = current ? { ...current } : null
        if (sheet.freeze === null) {
          state.freezeBySheetId.delete(sheetId)
        } else {
          state.freezeBySheetId.set(sheetId, { ...sheet.freeze })
        }
      }
    }

    inverse.sheetDeltas.set(sheetId, inverseSheet)
  }

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

function getOrCreateRangeFormats(state: StaticBackendState, sheetId: string): RangeFormatLayer[] {
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
  return cells.filter(isSeedCell).map(cloneCell).sort(compareCells)
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
    tablesByKey: new Map(),
    mergeRangesBySheetId,
    rowHeightsBySheetId: new Map(),
    colWidthsBySheetId: new Map(),
    hiddenRowsBySheetId: new Map(),
    hiddenColsBySheetId: new Map(),
    filterHiddenRowsBySheetId: new Map(),
    freezeBySheetId: new Map(sheets.map((sheet) => [sheet.id, { rows: 0, cols: 0 }])),
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

  // Filter-hidden rows never reach the clipboard (§8.2). The set is an INPUT
  // from UI-core, not something this backend looks up — it holds a
  // `setFilterSort` snapshot of its own, and consulting that would make the
  // large-range copy answer from a staler authority than the small-range one.
  const band = filterTsvBandRows(
    sparseCellsToTsv(cells, request.range),
    request.range.rowStart,
    request.range.rowEnd,
    normalizeCopyAsHiddenRows(request.hiddenRows),
  )
  const text = band.text

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
    // The marker names the first EMITTED row — it is the anchor paste uses to
    // shift relative references, so pointing it at a row that was filtered
    // away would offset every formula in the paste. Falls back to the raw
    // start when nothing survived (the text is empty, so it anchors nothing).
    originAddr: toA1(band.firstVisibleRow ?? request.range.rowStart, request.range.colStart),
    text,
    estimatedBytes: estimateUtf8Bytes(text),
  }
}

function normalizeSeed(input: StaticSpreadsheetSeedInput): StaticBackendState {
  if (Array.isArray(input)) {
    const cells =
      input.length > 0 && input.some((item) => Array.isArray(item))
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
    const id = typeof sheet === 'string' ? `sheet-${index + 1}` : (sheet.id ?? `sheet-${index + 1}`)
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

function normalizeSheetMutationName(name: string | undefined, fallback: string): string {
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

function shiftHiddenIndexSet(
  hiddenIndices: Set<number>,
  index: number,
  count: number,
  direction: 1 | -1,
): void {
  const next = new Set<number>()
  const deleteEnd = index + count - 1

  for (const hiddenIndex of hiddenIndices) {
    if (direction === -1 && hiddenIndex >= index && hiddenIndex <= deleteEnd) {
      continue
    }
    const nextIndex =
      hiddenIndex >= (direction === 1 ? index : deleteEnd + 1)
        ? hiddenIndex + count * direction
        : hiddenIndex
    if (nextIndex >= 0) next.add(nextIndex)
  }

  hiddenIndices.clear()
  for (const hiddenIndex of next) hiddenIndices.add(hiddenIndex)
}

/**
 * The row set SUBTOTAL 101-111 excludes on `sheetId` — this backend's manually
 * hidden rows (design-excel-table §6.1).
 *
 * SINGLE lane since the hidden-row sink-down (design-engine-hidden-rows §7.1,
 * E7): the eval-input `setEvalHiddenRows` no longer feeds a SEPARATE
 * `evalHiddenRowsBySheetId` map that was UNIONED in here. The host's
 * `eval-hidden-rows-bridge` was retired with E7 (the engine owns the manual
 * set through the `hideRows` / `unhideRows` ports and UI core reconciles from
 * the ACK), so the pushed lane had no production driver left; `setEvalHiddenRows`
 * now whole-set-REPLACES `hiddenRowsBySheetId` directly — the same store its
 * `hideRows` port mutates — exactly as the WASM engine's `set_eval_hidden_rows`
 * writes the one owned `Sheet::hidden_rows`. The static-only union that could
 * hold `hideRows` and a divergent push at once is gone with it.
 *
 * Filter-hidden rows are deliberately NOT merged in. Excel's rule
 * (`design-filter-hidden-rows` §2/§3) is that `SUBTOTAL(1-11)` excludes
 * FILTER-hidden rows but INCLUDES manually hidden ones, while 101-111 excludes
 * both — merging the two destroys the source information that rule is stated
 * in. The filter side lives in `filterHiddenRowsForSheet` below and the engine
 * keeps them apart the same way (`eval_hidden_rows` vs `eval_filter_hidden_rows`).
 */
function evalHiddenRowsForSheet(
  state: StaticBackendState,
  sheetId: string,
): ReadonlySet<number> | undefined {
  return state.hiddenRowsBySheetId.get(sheetId)
}

/**
 * The row set an ACTIVE FILTER hides on `sheetId` — excluded by BOTH SUBTOTAL
 * bands (`design-filter-hidden-rows` §6.3), which is what distinguishes it
 * from `evalHiddenRowsForSheet` above.
 *
 * Single lane by construction: this backend computes the set itself in
 * `setFilterSort` (it owns the cell values the predicate reads), so there is
 * no host-pushed second source to union with. The worker adapter reaches the
 * same engine state by pushing `setEvalFilterHiddenRows` instead — same fact,
 * same snapshot point, different transport.
 */
function filterHiddenRowsForSheet(
  state: StaticBackendState,
  sheetId: string,
): ReadonlySet<number> | undefined {
  const rows = state.filterHiddenRowsBySheetId.get(sheetId)
  return rows?.size ? rows : undefined
}

/**
 * W3 remap of the FILTER-hidden snapshot after a ROW insert/delete (S5a).
 *
 * Same displacement as the manual twin two call sites up (`shiftHiddenIndexSet`
 * on `hiddenRowsBySheetId`) and for the same reason: since the S5 flip this set
 * is a SNAPSHOT, not a per-revision rederivation, so an unshifted index would
 * withhold a row the filter never judged — and, because this backend also feeds
 * the set to its evaluator as `filterHiddenRows`, make SUBTOTAL exclude it too.
 *
 * ROWS ONLY: a column insert/delete displaces nothing in a row set.
 */
function shiftFilterHiddenRows(
  state: StaticBackendState,
  sheetId: string,
  rowIndex: number,
  count: number,
  direction: 1 | -1,
): void {
  const rows = state.filterHiddenRowsBySheetId.get(sheetId)
  if (!rows || rows.size === 0) return
  shiftHiddenIndexSet(rows, rowIndex, count, direction)
  if (rows.size === 0) state.filterHiddenRowsBySheetId.delete(sheetId)
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

function isCellInsideRange(
  cell: DisplayCell,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
): boolean {
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
  filterHiddenRows: ReadonlySet<number> | undefined,
) {
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    // A filter-hidden row must contribute NOTHING to the projection, not even a
    // format-only blank: "in range but with no cells" is exactly the property
    // downstream visible-cell consumers (status-bar aggregates, the hardened
    // dense scans) rely on to tell filtered-away rows from empty ones.
    if (filterHiddenRows?.has(row)) continue

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

function applyNumberFormatToCell(cell: DisplayCell, workbookLocale: string): void {
  const numberFormat = cell.format?.numberFormat
  if (!numberFormat) return
  if (cell.valueKind === 'error') return
  if (
    cell.valueKind !== 'number' &&
    numberFormat.kind !== 'text' &&
    numberFormat.kind !== 'custom'
  ) {
    return
  }
  if (cell.valueKind === 'number' && !Number.isFinite(cell.numericValue)) return
  const value = cell.valueKind === 'number' ? cell.numericValue! : cell.displayValue
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

  const evaluated = evaluateFormula(cell.formula, lookup, new Set(), { row, col })
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
  // Filter VISIBILITY only. Physical sort (`sortRange`, #29) is the sole sort
  // authority for the static backend; the display-permutation sort branch was
  // retired entirely with #24, so this permutation can never reorder rows.
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
    lookup: EvalCellLookup
    cellFormats: Map<string, SpreadsheetCellFormat>
    rangeFormats: RangeFormatLayer[]
    workbookLocale: string
  },
): DisplayCell {
  const clone = cloneCell(cell)
  clone.row = options.displayRow
  clone.col = options.displayCol

  if (clone.formula) {
    delete clone.numericValue
    // Display row IS the source row now, so the old "anchor the formula on the
    // source row while the cell reports a display row" split is gone, and with
    // it the whole class of `[@Col]` mis-anchoring it existed to work around.
    const result = evaluateFormula(clone.formula, options.lookup, new Set(), {
      row: options.displayRow,
      col: cell.col,
    })
    const formatted = formatEvalResult(result)
    clone.displayValue = formatted.display
    clone.valueKind = formatted.isError ? 'error' : typeof result === 'number' ? 'number' : 'string'
    if (typeof result === 'number' && Number.isFinite(result)) {
      clone.numericValue = result
    }
    if (formatted.isError) {
      clone.error = {
        code: formatted.display.replace(/^#|!$/g, '').toUpperCase(),
        message: formatted.display,
      }
    }
  } else if (clone.valueKind === 'number') {
    if (!Number.isFinite(clone.numericValue)) {
      delete clone.numericValue
      const value = numericValue(clone.displayValue)
      if (value !== null) clone.numericValue = value
    }
  } else {
    delete clone.numericValue
  }

  const format = getEffectiveFormat(
    options.displayRow,
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
        : (request.ruleId ?? nextConditionalFormatRuleId(current)),
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

function namedRangeMatches(entry: NamedRange, name: string, scope: NamedRange['scope']): boolean {
  const targetIdentity = namedRangeIdentity(name, scope)
  return targetIdentity !== null && namedRangeIdentity(entry.name, entry.scope) === targetIdentity
}

function setNamedRangeInState(state: StaticBackendState, request: SetNamedRangeRequest): void {
  const name = normalizeNamedRangeName(request.name)
  if (!name) throw new Error('invalid named range name')
  const entry: NamedRange = {
    name,
    scope: request.scope === 'workbook' ? 'workbook' : { sheetId: request.scope.sheetId },
    refersTo: { ...request.refersTo },
  }
  const existingIndex = state.namedRanges.findIndex((item) =>
    namedRangeMatches(item, name, request.scope),
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
    (item) => !namedRangeMatches(item, request.name, request.scope),
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
    authority: 'static-session-registry',
    definitionReadback: 'full',
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
  const workbookLocale = state.workbookLocale ?? DEFAULT_WORKBOOK_LOCALE

  const filterHiddenRows = filterHiddenRowsForSheet(state, request.sheetId)
  const lookup: EvalCellLookup = {
    get(row: number, col: number) {
      return sheetCells.get(keyFor(row, col))
    },
    resolveStructuredRef: makeStructuredRefResolver(state, request.sheetId),
    hiddenRows: evalHiddenRowsForSheet(state, request.sheetId),
    filterHiddenRows,
  }

  // Excel hidden-row semantics: display row IS source row. A filter no longer
  // compacts survivors into consecutive slots; it withholds the hidden rows and
  // leaves every other row at its own index, which is what makes the row header
  // skip (1, 4, 5) and what removed the second coordinate system the retired
  // per-cell source-row echo existed to translate between.
  for (const cell of sheetCells.values()) {
    if (!isCellInsideRange(cell, range)) continue
    if (filterHiddenRows?.has(cell.row)) continue
    const clone = projectSourceCell(cell, {
      displayRow: cell.row,
      displayCol: cell.col,
      lookup,
      cellFormats,
      rangeFormats,
      workbookLocale,
    })
    resultCellMap.set(keyFor(clone.row, clone.col), clone)
  }

  addFormatOnlyCells(resultCellMap, range, cellFormats, rangeFormats, filterHiddenRows)
  for (const [cellKey, cell] of resultCellMap) {
    const conditionalFormat = getConditionalFormatForCell(
      cell.row,
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
  // #04 x #29: merge metadata used to be suppressed WHOLESALE under an active
  // filter, because merge coordinates are source facts and the projection emitted
  // a permuted row space — a span drawn across non-adjacent surviving rows was a
  // lie, so the honest answer was to draw nothing. Identity mapping removes the
  // permutation, so the suppression goes with it and merged cells stay visible
  // inside a filtered region, as Excel draws them.
  applyMergeMetadata(resultCellMap, range, state.mergeRangesBySheetId.get(request.sheetId) ?? [])
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
  if (request.revision !== undefined && !Object.is(request.revision, state.revision)) {
    throw new Error(
      `viewport size revision conflict: expected ${String(request.revision)}, current ${String(state.revision)}`,
    )
  }
  const rowHeights = [...(state.rowHeightsBySheetId.get(request.sheetId) ?? new Map()).entries()]
    .filter(
      ([rowIndex]) => rowIndex >= request.window.rowStart && rowIndex <= request.window.rowEnd,
    )
    .map(([rowIndex, heightPx]) => ({ rowIndex, heightPx }))
    .sort((left, right) => left.rowIndex - right.rowIndex)
  const colWidths = [...(state.colWidthsBySheetId.get(request.sheetId) ?? new Map()).entries()]
    .filter(
      ([colIndex]) => colIndex >= request.window.colStart && colIndex <= request.window.colEnd,
    )
    .map(([colIndex, widthPx]) => ({ colIndex, widthPx }))
    .sort((left, right) => left.colIndex - right.colIndex)
  const hiddenRowIndices = [...(state.hiddenRowsBySheetId.get(request.sheetId) ?? new Set())]
    .filter((rowIndex) => rowIndex >= request.window.rowStart && rowIndex <= request.window.rowEnd)
    .sort((left, right) => left - right)
  const hiddenColIndices = [...(state.hiddenColsBySheetId.get(request.sheetId) ?? new Set())]
    .filter((colIndex) => colIndex >= request.window.colStart && colIndex <= request.window.colEnd)
    .sort((left, right) => left - right)

  return {
    kind: 'viewport-size',
    sheetId: request.sheetId,
    window: { ...request.window },
    requestId: request.requestId,
    revision: state.revision,
    rowHeights,
    colWidths,
    hiddenRowIndices,
    hiddenColIndices,
  }
}

function bumpRevision(revision: ProjectionRevision): ProjectionRevision {
  if (typeof revision === 'number' && Number.isFinite(revision)) {
    return revision + 1
  }
  return revision
}

function nextRevisionOrThrow(revision: ProjectionRevision): ProjectionRevision {
  const nextRevision = bumpRevision(revision)
  if (Object.is(nextRevision, revision)) {
    throw new Error(`cannot advance projection revision ${String(revision)}`)
  }
  return nextRevision
}

type HiddenIndexMutationRequest =
  | HideRowsRequest
  | UnhideRowsRequest
  | HideColumnsRequest
  | UnhideColumnsRequest

type StaticHiddenIndexMutationPlan =
  | {
      status: 'noop'
      axis: 'row' | 'column'
      hide: boolean
      changedIndices: number[]
    }
  | {
      status: 'apply'
      axis: 'row' | 'column'
      hide: boolean
      changedIndices: number[]
      nextRevision: ProjectionRevision
    }

function invalidHiddenIndexMutation(message: string): never {
  throw new Error(`invalid hidden index mutation: ${message}`)
}

function preflightHiddenIndexMutation(
  state: StaticBackendState,
  request: HiddenIndexMutationRequest,
): StaticHiddenIndexMutationPlan {
  if (!request || typeof request !== 'object') {
    return invalidHiddenIndexMutation('request must be an object')
  }
  if (typeof request.sheetId !== 'string' || request.sheetId.length === 0) {
    return invalidHiddenIndexMutation('sheetId must be a non-empty string')
  }
  if (!state.sheets.some((sheet) => sheet.id === request.sheetId)) {
    return invalidHiddenIndexMutation(`unknown sheet: ${request.sheetId}`)
  }
  if (request.revision !== undefined && request.revision !== state.revision) {
    return invalidHiddenIndexMutation(
      `revision conflict: expected ${String(request.revision)}, current ${String(state.revision)}`,
    )
  }

  let axis: 'row' | 'column'
  let hide: boolean
  let rawIndices: unknown
  switch (request.kind) {
    case 'hide-rows':
      axis = 'row'
      hide = true
      rawIndices = request.rowIndices
      break
    case 'unhide-rows':
      axis = 'row'
      hide = false
      rawIndices = request.rowIndices
      break
    case 'hide-columns':
      axis = 'column'
      hide = true
      rawIndices = request.colIndices
      break
    case 'unhide-columns':
      axis = 'column'
      hide = false
      rawIndices = request.colIndices
      break
    default:
      return invalidHiddenIndexMutation('unknown mutation kind')
  }

  if (!Array.isArray(rawIndices)) {
    return invalidHiddenIndexMutation(
      `${axis === 'row' ? 'rowIndices' : 'colIndices'} must be an array`,
    )
  }
  const normalized = new Set<number>()
  for (const index of rawIndices) {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return invalidHiddenIndexMutation('indices must be non-negative safe integers')
    }
    normalized.add(index)
  }

  const canonical = [...normalized].sort((left, right) => left - right)
  const live =
    axis === 'row'
      ? state.hiddenRowsBySheetId.get(request.sheetId)
      : state.hiddenColsBySheetId.get(request.sheetId)
  const changedIndices = canonical.filter((index) => (live?.has(index) ?? false) !== hide)
  if (changedIndices.length === 0) {
    return { status: 'noop', axis, hide, changedIndices }
  }

  return {
    status: 'apply',
    axis,
    hide,
    changedIndices,
    // Preflight the revision witness before history or canonical state is touched.
    nextRevision: nextRevisionOrThrow(state.revision),
  }
}

function applyHiddenIndexMutationPlan(
  state: StaticBackendState,
  sheetId: string,
  plan: Extract<StaticHiddenIndexMutationPlan, { status: 'apply' }>,
): void {
  beginUndoableMutation(state)
  for (const index of plan.changedIndices) {
    recordHiddenIndexBefore(state, sheetId, plan.axis, index)
  }

  const hiddenBySheetId =
    plan.axis === 'row' ? state.hiddenRowsBySheetId : state.hiddenColsBySheetId
  const live = hiddenBySheetId.get(sheetId) ?? new Set<number>()
  for (const index of plan.changedIndices) {
    if (plan.hide) {
      live.add(index)
    } else {
      live.delete(index)
    }
  }
  if (live.size === 0) {
    hiddenBySheetId.delete(sheetId)
  } else {
    hiddenBySheetId.set(sheetId, live)
  }
  state.revision = plan.nextRevision
}

interface StaticFindSpan {
  readonly start: number
  readonly end: number
}

interface StaticReplacementCellPlan {
  readonly sheetId: string
  readonly key: string
  readonly row: number
  readonly col: number
  readonly nextInput: string
}

type StaticReplacementPlanResult =
  | {
      readonly status: 'ready'
      readonly cells: readonly StaticReplacementCellPlan[]
      readonly replacedCount: number
    }
  | {
      readonly status: 'invalid'
      readonly message: string
    }

function replaceMatchesNotApplied(
  requestId: number,
  code: string,
  message: string,
): ReplaceMatchesResponse {
  return {
    kind: 'replace-matches-not-applied',
    applied: false,
    requestId,
    error: { code, message, source: 'validation' },
  }
}

function invalidReplaceMatchesRequest(message: string): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: 'FIND_REPLACE_REQUEST_ID_REQUIRED',
  })
}

function buildStaticReplacementPlan(
  state: StaticBackendState,
  coords: readonly ReplaceMatchInput[],
  replacement: string,
): StaticReplacementPlanResult {
  const bySheet = new Map<string, Map<string, ReplaceMatchInput[]>>()

  for (const match of coords) {
    if (
      typeof match.sheetId !== 'string' ||
      match.sheetId.length === 0 ||
      !Number.isSafeInteger(match.coord.row) ||
      match.coord.row < 0 ||
      !Number.isSafeInteger(match.coord.col) ||
      match.coord.col < 0 ||
      !Number.isSafeInteger(match.matchStart) ||
      !Number.isSafeInteger(match.matchEnd) ||
      match.matchStart < 0 ||
      match.matchEnd <= match.matchStart ||
      (match.target !== 'displayValue' && match.target !== 'formula')
    ) {
      return { status: 'invalid', message: 'Replace coordinates are malformed' }
    }

    const key = keyFor(match.coord.row, match.coord.col)
    const byKey = bySheet.get(match.sheetId) ?? new Map<string, ReplaceMatchInput[]>()
    const matches = byKey.get(key) ?? []
    matches.push(match)
    byKey.set(key, matches)
    bySheet.set(match.sheetId, byKey)
  }

  const cells: StaticReplacementCellPlan[] = []
  let replacedCount = 0

  for (const [sheetId, byKey] of bySheet) {
    const sheetCells = state.cellsBySheet.get(sheetId)
    if (!sheetCells) {
      return { status: 'invalid', message: `Unknown replacement sheet: ${sheetId}` }
    }

    for (const [key, cellMatches] of byKey) {
      const cell = sheetCells.get(key)
      if (!cell) {
        return { status: 'invalid', message: `Replacement cell does not exist: ${key}` }
      }

      const target = cellMatches[0]?.target
      if (!target || cellMatches.some((match) => match.target !== target)) {
        return { status: 'invalid', message: `Replacement targets disagree: ${key}` }
      }

      const haystack = target === 'formula' ? cell.formula : cell.displayValue
      if (haystack === undefined) {
        return { status: 'invalid', message: `Replacement target does not exist: ${key}` }
      }

      const sorted = cellMatches
        .slice()
        .sort((left, right) => left.matchStart - right.matchStart || left.matchEnd - right.matchEnd)
      let previousEnd = -1
      for (const match of sorted) {
        if (match.matchEnd > haystack.length) {
          return { status: 'invalid', message: `Replacement span is out of bounds: ${key}` }
        }
        if (match.matchStart < previousEnd) {
          return { status: 'invalid', message: `Replacement spans overlap: ${key}` }
        }
        previousEnd = match.matchEnd
      }

      const effective = sorted.filter(
        (match) => haystack.slice(match.matchStart, match.matchEnd) !== replacement,
      )
      if (effective.length === 0) continue

      let nextInput = haystack
      for (const match of effective.slice().reverse()) {
        nextInput =
          nextInput.slice(0, match.matchStart) + replacement + nextInput.slice(match.matchEnd)
      }
      cells.push({
        sheetId,
        key,
        row: cell.row,
        col: cell.col,
        nextInput,
      })
      replacedCount += effective.length
    }
  }

  return { status: 'ready', cells, replacedCount }
}

function collectRegexFindSpans(matcher: RegExp, haystack: string): StaticFindSpan[] {
  const spans: StaticFindSpan[] = []
  matcher.lastIndex = 0

  for (;;) {
    const match = matcher.exec(haystack)
    if (!match) break

    if (match[0].length === 0) {
      // FindMatch requires a non-empty interval. Advance explicitly so a
      // zero-width global match cannot pin RegExp.lastIndex forever.
      matcher.lastIndex = match.index + 1
      continue
    }

    spans.push({ start: match.index, end: match.index + match[0].length })
  }

  matcher.lastIndex = 0
  return spans
}

function collectLiteralFindSpans(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
  wholeMatch: boolean,
): StaticFindSpan[] {
  const normalize = caseSensitive
    ? (value: string) => value
    : (value: string) => value.toLowerCase()
  const normalizedHaystack = normalize(haystack)
  const normalizedNeedle = normalize(needle)

  if (wholeMatch) {
    return normalizedHaystack === normalizedNeedle ? [{ start: 0, end: haystack.length }] : []
  }

  const start = normalizedHaystack.indexOf(normalizedNeedle)
  return start < 0 ? [] : [{ start, end: start + needle.length }]
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
        const nextCell = cloneCell(sourceCell)
        if (nextCell.formula) {
          nextCell.formula = shiftFormulaRefs(
            nextCell.formula,
            row - sourceCoord.row,
            col - sourceCoord.col,
          )
        }
        sheetCells.set(targetKey, {
          ...nextCell,
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

interface StaticFillSeriesCellPlan {
  readonly row: number
  readonly col: number
  readonly value: number
  readonly format?: SpreadsheetCellFormat
}

type StaticFillSeriesPlan =
  | { readonly status: 'noop' }
  | {
      readonly status: 'ready'
      readonly writeRange: CellRange
      readonly cells: readonly StaticFillSeriesCellPlan[]
      readonly nextRevision: ProjectionRevision
    }

function invalidFillSeries(message: string): never {
  throw new Error(`invalid fill series: ${message}`)
}

function isFillSeriesDirection(value: unknown): value is FillSeriesRequest['direction'] {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right'
}

function fillSeriesStepsMatch(actual: number, requested: number): boolean {
  if (!Number.isFinite(actual)) return false
  if (Math.abs(requested) >= FILL_SERIES_NUMBER_EPSILON) {
    return Math.abs(actual - requested) < FILL_SERIES_NUMBER_EPSILON
  }

  // The detector intentionally treats near-zero deltas as copy. The backend
  // protocol still accepts any strictly non-zero finite step, so direct tiny
  // steps use a floating-point-relative comparison instead of that UI cutoff.
  const magnitude = Math.max(Math.abs(actual), Math.abs(requested), Number.MIN_VALUE)
  return Math.abs(actual - requested) <= Number.EPSILON * magnitude * 8
}

function isCanonicalFillSeriesRange(range: CellRange): boolean {
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.rowStart <= range.rowEnd &&
    range.colStart <= range.colEnd
  )
}

function validateFillSeriesGeometry(request: FillSeriesRequest): void {
  const source = request.sourceRange
  const target = request.targetRange
  if (!isCanonicalFillSeriesRange(source) || !isCanonicalFillSeriesRange(target)) {
    invalidFillSeries('ranges must use canonical non-negative safe-integer bounds')
  }

  if (request.direction === 'down' || request.direction === 'up') {
    if (source.colStart !== source.colEnd || source.rowEnd - source.rowStart + 1 < 2) {
      invalidFillSeries('vertical series require at least two source cells in one column')
    }
    if (target.colStart !== source.colStart || target.colEnd !== source.colEnd) {
      invalidFillSeries('vertical target must stay in the source column')
    }
    if (
      request.direction === 'down'
        ? target.rowStart !== source.rowStart || target.rowEnd < source.rowEnd
        : target.rowEnd !== source.rowEnd || target.rowStart > source.rowStart
    ) {
      invalidFillSeries('target does not extend the source in the requested direction')
    }
    return
  }

  if (source.rowStart !== source.rowEnd || source.colEnd - source.colStart + 1 < 2) {
    invalidFillSeries('horizontal series require at least two source cells in one row')
  }
  if (target.rowStart !== source.rowStart || target.rowEnd !== source.rowEnd) {
    invalidFillSeries('horizontal target must stay in the source row')
  }
  if (
    request.direction === 'right'
      ? target.colStart !== source.colStart || target.colEnd < source.colEnd
      : target.colEnd !== source.colEnd || target.colStart > source.colStart
  ) {
    invalidFillSeries('target does not extend the source in the requested direction')
  }
}

function readCanonicalFillSeriesValue(cell: DisplayCell | undefined): number {
  if (!cell || cell.formula !== undefined || cell.valueKind !== 'number') {
    invalidFillSeries('source cells must be canonical non-formula numbers')
  }

  if (typeof cell.numericValue === 'number' && Number.isFinite(cell.numericValue)) {
    return cell.numericValue
  }
  if (cell.displayValue.trim().length === 0) {
    invalidFillSeries('source cells must contain finite numbers')
  }
  const value = numericValue(cell.displayValue)
  if (value === null) invalidFillSeries('source cells must contain finite numbers')
  return value
}

function preflightFillSeries(
  state: StaticBackendState,
  request: FillSeriesRequest,
): StaticFillSeriesPlan {
  const runtimeRequest = request as { readonly kind?: unknown; readonly direction?: unknown }
  if (runtimeRequest.kind !== 'fill-series') {
    invalidFillSeries('request kind must be fill-series')
  }
  if (!isFillSeriesDirection(runtimeRequest.direction)) {
    invalidFillSeries('direction must be up, down, left, or right')
  }
  if (!state.sheets.some((sheet) => sheet.id === request.sheetId)) {
    invalidFillSeries(`unknown sheet: ${request.sheetId}`)
  }
  if (request.revision !== undefined && request.revision !== state.revision) {
    invalidFillSeries(
      `stale revision ${String(request.revision)}; current revision is ${String(state.revision)}`,
    )
  }
  validateFillSeriesGeometry(request)

  if (request.series !== 'integer-step' && request.series !== 'decimal-step') {
    invalidFillSeries('static backend only accepts numeric step series')
  }
  if (typeof request.step !== 'number' || !Number.isFinite(request.step) || request.step === 0) {
    invalidFillSeries('step must be finite and non-zero')
  }

  const sheetCells = state.cellsBySheet.get(request.sheetId)
  if (!sheetCells) invalidFillSeries('source sheet has no canonical cell store')

  const sourceValues: number[] = []
  if (request.direction === 'down' || request.direction === 'up') {
    for (let row = request.sourceRange.rowStart; row <= request.sourceRange.rowEnd; row += 1) {
      sourceValues.push(
        readCanonicalFillSeriesValue(sheetCells.get(keyFor(row, request.sourceRange.colStart))),
      )
    }
  } else {
    for (let col = request.sourceRange.colStart; col <= request.sourceRange.colEnd; col += 1) {
      sourceValues.push(
        readCanonicalFillSeriesValue(sheetCells.get(keyFor(request.sourceRange.rowStart, col))),
      )
    }
  }

  for (let index = 1; index < sourceValues.length; index += 1) {
    const delta = sourceValues[index] - sourceValues[index - 1]
    if (!fillSeriesStepsMatch(delta, request.step)) {
      invalidFillSeries('source values do not match the requested step')
    }
  }

  const isIntegerSeries =
    Math.abs(request.step) >= FILL_SERIES_NUMBER_EPSILON &&
    isFillSeriesInteger(request.step) &&
    sourceValues.every(isFillSeriesInteger)
  if (
    (request.series === 'integer-step' && !isIntegerSeries) ||
    (request.series === 'decimal-step' && isIntegerSeries)
  ) {
    invalidFillSeries('series kind does not match the canonical source values')
  }

  const writeRange = getFillHandleWriteRange(
    request.sourceRange,
    request.targetRange,
    request.direction,
  )
  if (writeRange === null) return { status: 'noop' }

  const cellFormats = state.cellFormatsBySheetId.get(request.sheetId) ?? new Map()
  const rangeFormats = state.rangeFormatsBySheetId.get(request.sheetId) ?? []
  const firstValue = sourceValues[0]
  const lastValue = sourceValues[sourceValues.length - 1]
  const cells: StaticFillSeriesCellPlan[] = []

  for (let row = writeRange.rowStart; row <= writeRange.rowEnd; row += 1) {
    for (let col = writeRange.colStart; col <= writeRange.colEnd; col += 1) {
      let value: number
      if (request.direction === 'down') {
        value = lastValue + request.step * (row - request.sourceRange.rowEnd)
      } else if (request.direction === 'up') {
        value = firstValue - request.step * (request.sourceRange.rowStart - row)
      } else if (request.direction === 'right') {
        value = lastValue + request.step * (col - request.sourceRange.colEnd)
      } else {
        value = firstValue - request.step * (request.sourceRange.colStart - col)
      }
      if (!Number.isFinite(value)) {
        invalidFillSeries('generated series contains a non-finite value')
      }

      const sourceCoord = getFillHandleSourceCoord(request.sourceRange, { row, col })
      const format = getEffectiveFormat(sourceCoord.row, sourceCoord.col, cellFormats, rangeFormats)
      cells.push({
        row,
        col,
        value,
        ...(format ? { format: cloneFormat(format) } : {}),
      })
    }
  }

  const nextRevision = bumpRevision(state.revision)
  if (Object.is(nextRevision, state.revision)) {
    invalidFillSeries(`cannot advance projection revision ${String(state.revision)}`)
  }
  return { status: 'ready', writeRange: cloneRange(writeRange), cells, nextRevision }
}

function applyFillSeriesPlan(
  state: StaticBackendState,
  sheetId: string,
  plan: Extract<StaticFillSeriesPlan, { status: 'ready' }>,
): void {
  beginUndoableMutation(state)
  const sheetCells = state.cellsBySheet.get(sheetId)!
  const cellFormats = getOrCreateCellFormats(state, sheetId)
  for (const cellPlan of plan.cells) {
    const key = keyFor(cellPlan.row, cellPlan.col)
    recordCellBefore(state, sheetId, key)
    recordCellFormatBefore(state, sheetId, key)
    sheetCells.set(key, {
      row: cellPlan.row,
      col: cellPlan.col,
      displayValue: String(cellPlan.value),
      valueKind: 'number',
      numericValue: cellPlan.value,
    })
    if (cellPlan.format) {
      cellFormats.set(key, cloneFormat(cellPlan.format))
    } else {
      cellFormats.delete(key)
    }
  }
  state.revision = plan.nextRevision
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

interface StaticRowsRemovalMutation {
  readonly cells: Map<string, DisplayCell>
  readonly revision: ProjectionRevision
}

function applyStaticRowsRemoval(
  state: StaticBackendState,
  sheetId: string,
  descendingRows: readonly number[],
  nextRevision: ProjectionRevision,
): StaticRowsRemovalMutation {
  const expectedRevision = nextRevisionOrThrow(state.revision)
  if (!Object.is(nextRevision, expectedRevision)) {
    throw new Error('static row removal revision plan is stale')
  }

  beginUndoableMutation(state)
  recordFullSheetBefore(state, sheetId)

  const cells = getOrCreateSheetCells(state, sheetId)
  const cellFormats = getOrCreateCellFormats(state, sheetId)
  const rangeFormats = getOrCreateRangeFormats(state, sheetId)
  const rowHeights = getDimensionMap(state.rowHeightsBySheetId, sheetId)
  const hiddenRows = state.hiddenRowsBySheetId.get(sheetId)

  // Each descending row is a single-row delete band. Applying the W3
  // delete-shift semantics (shiftMergeRanges / shiftFreezeConfig) once
  // per row, bottom-up, composes to exactly the same result as applying
  // one shift per contiguous band: indices below the current band are
  // untouched, so earlier (lower) bands keep their original coordinates.
  for (const rowIndex of descendingRows) {
    shiftRows(cells, cellFormats, rangeFormats, rowIndex, 1, -1)
    shiftDimensionMap(rowHeights, rowIndex, 1, -1)
    if (hiddenRows) shiftHiddenIndexSet(hiddenRows, rowIndex, 1, -1)
    shiftFilterHiddenRows(state, sheetId, rowIndex, 1, -1)
    shiftMergeRanges(state, sheetId, 'row', rowIndex, 1, -1)
    shiftFreezeConfig(state, sheetId, 'row', rowIndex, 1, -1)
    applyTableShift(state, sheetId, 'row', rowIndex, 1, -1)
  }
  if (hiddenRows?.size === 0) state.hiddenRowsBySheetId.delete(sheetId)

  state.revision = nextRevision
  return { cells, revision: nextRevision }
}

interface StaticRemoveRowsExactPlan {
  readonly requestId: number
  readonly sheetId: string
  readonly targetRange: CellRange
  readonly ascendingRows: number[]
  readonly descendingRows: number[]
  readonly nextRevision: number
}

function rejectStaticRemoveRowsExact(reason: string): never {
  throw Object.assign(new Error(`invalid removeRowsExact request: ${reason}`), {
    code: 'INVALID_REMOVE_ROWS_EXACT_REQUEST',
  })
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function planStaticRemoveRowsExact(
  state: StaticBackendState,
  request: unknown,
): StaticRemoveRowsExactPlan {
  if (!isObject(request)) rejectStaticRemoveRowsExact('request must be an object')
  if (request.kind !== 'remove-rows') {
    rejectStaticRemoveRowsExact('kind must be remove-rows')
  }
  if (!isSafeInteger(request.requestId) || request.requestId < 0) {
    rejectStaticRemoveRowsExact('requestId must be a non-negative safe integer')
  }
  if (typeof request.sheetId !== 'string' || request.sheetId.length === 0) {
    rejectStaticRemoveRowsExact('sheetId must be a non-empty string')
  }
  if (!state.sheets.some((sheet) => sheet.id === request.sheetId)) {
    rejectStaticRemoveRowsExact(`unknown sheet ${request.sheetId}`)
  }

  const range = request.targetRange
  if (!isObject(range)) rejectStaticRemoveRowsExact('targetRange must be an object')
  const { rowStart, rowEnd, colStart, colEnd } = range
  if (
    !isSafeInteger(rowStart) ||
    !isSafeInteger(rowEnd) ||
    !isSafeInteger(colStart) ||
    !isSafeInteger(colEnd) ||
    rowStart < 0 ||
    colStart < 0 ||
    rowStart > rowEnd ||
    colStart > colEnd
  ) {
    rejectStaticRemoveRowsExact('targetRange must contain ordered non-negative safe integers')
  }

  const rows = request.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    rejectStaticRemoveRowsExact('rows must be a non-empty array')
  }
  const ascendingRows: number[] = []
  for (const row of rows) {
    if (
      !isSafeInteger(row) ||
      row < rowStart ||
      row > rowEnd ||
      (ascendingRows.length > 0 && ascendingRows[ascendingRows.length - 1] >= row)
    ) {
      rejectStaticRemoveRowsExact('rows must be canonical, strictly ascending, and in range')
    }
    ascendingRows.push(row)
  }

  const currentRevision = state.revision
  if (
    !isFiniteNumber(request.revision) ||
    !isFiniteNumber(currentRevision) ||
    request.revision !== currentRevision
  ) {
    rejectStaticRemoveRowsExact('revision must equal the current finite numeric revision')
  }
  const nextRevision = currentRevision + 1
  if (!Number.isFinite(nextRevision) || Object.is(nextRevision, currentRevision)) {
    rejectStaticRemoveRowsExact('current revision cannot advance to a distinct finite number')
  }

  return {
    requestId: request.requestId,
    sheetId: request.sheetId,
    targetRange: { rowStart, rowEnd, colStart, colEnd },
    ascendingRows,
    descendingRows: [...ascendingRows].reverse(),
    nextRevision,
  }
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

  for (let layerIndex = rangeFormats.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = rangeFormats[layerIndex]
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

    const beforeEnd = Math.min(end, index - 1)
    const afterStart = Math.max(start, deleteEnd + 1)
    const hasBefore = start <= beforeEnd
    const hasAfter = afterStart <= end
    if (!hasBefore && !hasAfter) {
      rangeFormats.splice(layerIndex, 1)
      continue
    }

    layer.range[startKey] = hasBefore ? start : afterStart - count
    layer.range[endKey] = hasAfter ? end - count : beforeEnd
  }
}

// Excel merge semantics for structural displacement: an insert before a
// merge shifts it whole, an insert strictly inside extends it; a delete
// before it shifts it back, a partial overlap shrinks it, and a delete
// covering the whole merge removes it. A merge that shrinks to a single
// cell stops being a merge (a 1x1 "merge" is meaningless in Excel).
function shiftMergeRanges(
  state: StaticBackendState,
  sheetId: string,
  axis: 'row' | 'column',
  index: number,
  count: number,
  direction: 1 | -1,
) {
  const ranges = state.mergeRangesBySheetId.get(sheetId)
  if (!ranges || ranges.length === 0) return
  const startKey = axis === 'row' ? 'rowStart' : 'colStart'
  const endKey = axis === 'row' ? 'rowEnd' : 'colEnd'
  const deleteEnd = index + count - 1

  for (let rangeIndex = ranges.length - 1; rangeIndex >= 0; rangeIndex -= 1) {
    const range = ranges[rangeIndex]
    const start = range[startKey]
    const end = range[endKey]

    if (direction === 1) {
      if (start >= index) {
        range[startKey] = start + count
        range[endKey] = end + count
      } else if (end >= index) {
        range[endKey] = end + count
      }
      continue
    }

    if (end < index) continue
    if (start > deleteEnd) {
      range[startKey] = start - count
      range[endKey] = end - count
      continue
    }

    const hasBefore = start < index
    const hasAfter = end > deleteEnd
    if (!hasBefore && !hasAfter) {
      ranges.splice(rangeIndex, 1)
      continue
    }

    range[startKey] = hasBefore ? start : index
    range[endKey] = hasAfter ? end - count : index - 1
    if (range.rowStart === range.rowEnd && range.colStart === range.colEnd) {
      ranges.splice(rangeIndex, 1)
    }
  }
}

// Freeze counts describe the frozen leading band [0, rows) / [0, cols).
// Inserting strictly above/left of the freeze line (index < frozen)
// grows the band; deleting indices inside the band shrinks it by the
// overlap. Operations at or past the freeze line leave it untouched.
function shiftFreezeConfig(
  state: StaticBackendState,
  sheetId: string,
  axis: 'row' | 'column',
  index: number,
  count: number,
  direction: 1 | -1,
) {
  const freeze = state.freezeBySheetId.get(sheetId)
  if (!freeze) return
  const key = axis === 'row' ? 'rows' : 'cols'
  const frozen = freeze[key]
  if (frozen <= 0 || index >= frozen) return
  freeze[key] =
    direction === 1 ? frozen + count : frozen - (Math.min(index + count, frozen) - index)
}

function structuralMutationResult(
  request: InsertRowsRequest | DeleteRowsRequest | InsertColumnsRequest | DeleteColumnsRequest,
  revision: ProjectionRevision,
): BackendMutationResult {
  const structuralShift: BackendStructuralShift =
    request.kind === 'insert-rows'
      ? { axis: 'row', kind: 'insert', index: request.rowIndex, count: request.count }
      : request.kind === 'delete-rows'
        ? { axis: 'row', kind: 'delete', index: request.rowIndex, count: request.count }
        : request.kind === 'insert-columns'
          ? { axis: 'column', kind: 'insert', index: request.colIndex, count: request.count }
          : { axis: 'column', kind: 'delete', index: request.colIndex, count: request.count }
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
    structuralShift,
  }
}

function mergeMutationResult(
  request: MergeRangeRequest | UnmergeRangeRequest,
  revision: ProjectionRevision,
) {
  return {
    kind: request.kind,
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
  return buildProjectionResult(
    request,
    buildState(matrixToCells(matrix), revision ?? 0),
  ) as VisibleProjectionResult
}

export function matrixToRangeProjectionResult(
  matrix: StaticSeedMatrix,
  request: RangeProjectionRequest,
  revision?: ProjectionRevision,
): RangeProjectionResult {
  return buildProjectionResult(
    request,
    buildState(matrixToCells(matrix), revision ?? 0),
  ) as RangeProjectionResult
}

// === Engine physical sort (design-engine-sort §3-§6, parity #29) ============
//
// The static backend is an in-memory reference engine, so it implements the
// `sortRange` port by PHYSICALLY reordering its cells (values / formula text
// verbatim, per-cell formats riding along) through the shared comparator in
// `sort-order.ts` — the exact TS mirror of the Rust `sort_cmp` / slot machine.
// Structured rejections and the applied ACK match the worker adapter so the
// two backends are interchangeable behind the same UI-core command.

const SORT_EXCEL_MAX_ROWS = 1_048_576
const SORT_EXCEL_MAX_COLS = 16_384

function isMalformedSortRange(range: CellRange | undefined): boolean {
  return (
    !range ||
    typeof range !== 'object' ||
    !Number.isInteger(range.rowStart) ||
    !Number.isInteger(range.rowEnd) ||
    !Number.isInteger(range.colStart) ||
    !Number.isInteger(range.colEnd)
  )
}

function toResolvedSortKeys(keys: readonly SortRangeKey[]): ResolvedSortKey[] {
  return keys.map((key) => ({
    col: key.col,
    direction: key.direction ?? 'asc',
    caseSensitive: key.caseSensitive ?? false,
  }))
}

/**
 * Project a static `DisplayCell` onto the five Excel sort classes, matching the
 * engine `Value` the WASM path sees (parity golden fixture): formulas sort by
 * their evaluated result, `#…` results are the error class, a missing / blank
 * cell is empty. This keeps a static-host sort cell-for-cell identical with the
 * engine sort for the same data.
 */
function cellToSortValue(cell: DisplayCell | undefined, lookup: EvalCellLookup): SortValue {
  if (!cell) return { kind: 'empty' }
  if (cell.formula) {
    const result = evaluateFormula(cell.formula, lookup, new Set(), {
      row: cell.row,
      col: cell.col,
    })
    if (typeof result === 'number') return { kind: 'number', value: result }
    // A string result beginning with '#' is an error code; anything else is text.
    return result.startsWith('#') ? { kind: 'error' } : { kind: 'text', value: result }
  }
  switch (cell.valueKind) {
    case 'number': {
      const value = Number.isFinite(cell.numericValue)
        ? cell.numericValue!
        : Number(cell.displayValue)
      return { kind: 'number', value }
    }
    case 'boolean':
      return { kind: 'boolean', value: cell.displayValue === 'TRUE' }
    case 'error':
      return { kind: 'error' }
    case 'blank':
      return { kind: 'empty' }
    default:
      return cell.displayValue === ''
        ? { kind: 'empty' }
        : { kind: 'text', value: cell.displayValue }
  }
}

/** Intersection of two normalized, intersecting rectangles. */
function intersectSortRange(a: CellRange, b: CellRange): CellRange {
  return {
    rowStart: Math.max(a.rowStart, b.rowStart),
    rowEnd: Math.min(a.rowEnd, b.rowEnd),
    colStart: Math.max(a.colStart, b.colStart),
    colEnd: Math.min(a.colEnd, b.colEnd),
  }
}

/**
 * Geometric subtraction `a \ b` for normalized, intersecting rectangles: up to
 * four disjoint pieces (top band, bottom band, left/middle, right/middle) that
 * tile `a` minus `b` exactly. Mirrors Rust `subtract_range` (design §5.3).
 */
function subtractSortRange(a: CellRange, b: CellRange): CellRange[] {
  const out: CellRange[] = []
  if (a.rowStart < b.rowStart) {
    out.push({
      rowStart: a.rowStart,
      rowEnd: b.rowStart - 1,
      colStart: a.colStart,
      colEnd: a.colEnd,
    })
  }
  if (a.rowEnd > b.rowEnd) {
    out.push({ rowStart: b.rowEnd + 1, rowEnd: a.rowEnd, colStart: a.colStart, colEnd: a.colEnd })
  }
  const midR0 = Math.max(a.rowStart, b.rowStart)
  const midR1 = Math.min(a.rowEnd, b.rowEnd)
  if (midR0 <= midR1) {
    if (a.colStart < b.colStart) {
      out.push({ rowStart: midR0, rowEnd: midR1, colStart: a.colStart, colEnd: b.colStart - 1 })
    }
    if (a.colEnd > b.colEnd) {
      out.push({ rowStart: midR0, rowEnd: midR1, colStart: b.colEnd + 1, colEnd: a.colEnd })
    }
  }
  return out
}

/**
 * Format-layer preprocessing (design §5.3): materialize the effective format of
 * every layer-covered cell inside `range` as a per-cell entry, then cut every
 * intersecting layer so no layer overlaps `range`. Afterwards "default = no
 * entry" holds inside the range and moving per-cell formats with their rows is
 * the complete, correct format-follows-row semantics.
 */
function materializeAndCutSortFormatLayers(
  cellFormats: Map<string, SpreadsheetCellFormat>,
  rangeFormats: RangeFormatLayer[],
  range: CellRange,
): void {
  const intersecting = rangeFormats.filter((layer) => rangesIntersect(layer.range, range))
  if (intersecting.length === 0) return

  const seen = new Set<string>()
  for (const layer of intersecting) {
    const region = intersectSortRange(normalizeRange(layer.range), range)
    for (let row = region.rowStart; row <= region.rowEnd; row += 1) {
      for (let col = region.colStart; col <= region.colEnd; col += 1) {
        const key = keyFor(row, col)
        if (seen.has(key)) continue
        seen.add(key)
        if (cellFormats.has(key)) continue
        // `getEffectiveFormat` resolves per-cell > topmost covering layer and
        // returns undefined for a default effective format (which stays absent).
        const effective = getEffectiveFormat(row, col, cellFormats, rangeFormats)
        if (effective) cellFormats.set(key, effective)
      }
    }
  }

  const next: RangeFormatLayer[] = []
  for (const layer of rangeFormats) {
    if (!rangesIntersect(layer.range, range)) {
      next.push(layer)
      continue
    }
    for (const piece of subtractSortRange(normalizeRange(layer.range), range)) {
      next.push({ range: piece, format: cloneFormat(layer.format) })
    }
  }
  rangeFormats.length = 0
  for (const layer of next) rangeFormats.push(layer)
}

/**
 * Physically relocate cells and per-cell formats under the row permutation
 * (`rowMap`: source row → slot row, changed rows only), restricted to the
 * range's columns. The map is a bijection on the changed rows, so snapshotting
 * every source position, clearing them, then writing them at their slot rows
 * cannot collide. Returns the count of non-empty cells that moved.
 */
function relocateSortedCells(
  cells: Map<string, DisplayCell>,
  cellFormats: Map<string, SpreadsheetCellFormat>,
  range: CellRange,
  rowMap: ReadonlyMap<number, number>,
): number {
  const movingCells: Array<{ cell: DisplayCell; col: number; slot: number }> = []
  const movingFormats: Array<{ format: SpreadsheetCellFormat; col: number; slot: number }> = []

  for (const [sourceRow, slotRow] of rowMap) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(sourceRow, col)
      const cell = cells.get(key)
      if (cell) movingCells.push({ cell, col, slot: slotRow })
      const format = cellFormats.get(key)
      if (format) movingFormats.push({ format, col, slot: slotRow })
    }
  }

  // Clear all source positions before writing slots (bijection → no residue).
  for (const [sourceRow] of rowMap) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(sourceRow, col)
      cells.delete(key)
      cellFormats.delete(key)
    }
  }

  for (const { cell, col, slot } of movingCells) {
    cells.set(keyFor(slot, col), { ...cell, row: slot })
  }
  for (const { format, col, slot } of movingFormats) {
    cellFormats.set(keyFor(slot, col), format)
  }
  return movingCells.length
}

function sortRejectedResult(
  request: SortRangeRequest,
  revision: ProjectionRevision,
  code: SortRangeRejectionCode,
  message: string,
): SortRangeResult {
  return {
    kind: 'sort-range-not-applied',
    sheetId: request.sheetId,
    applied: false,
    code,
    message,
    requestId: request.requestId,
    // A rejected sort never bumps: echo the current (un-bumped) witness.
    revision: request.revision ?? revision,
  }
}

/**
 * Static reference implementation of the engine physical sort. Runs the same
 * gate order as the worker adapter (payload → source-size → key-in-range →
 * merge authority), reorders the cells through the shared slot algorithm, and
 * records ONE backend-side undo entry (range cells + formats) so the sort is
 * reversible exactly like the worker path (design §7).
 */
function applyStaticSortRange(
  state: StaticBackendState,
  request: SortRangeRequest,
): SortRangeResult {
  const revisionBefore = state.revision

  if (isMalformedSortRange(request.range)) {
    return sortRejectedResult(
      request,
      revisionBefore,
      'invalid-payload',
      'the sort request is missing a valid range',
    )
  }
  if (!Array.isArray(request.keys) || request.keys.length === 0) {
    return sortRejectedResult(request, revisionBefore, 'empty-keys', 'no sort key was provided')
  }

  const range = normalizeRange(request.range)
  if (
    range.rowStart < 0 ||
    range.colStart < 0 ||
    range.rowEnd >= SORT_EXCEL_MAX_ROWS ||
    range.colEnd >= SORT_EXCEL_MAX_COLS
  ) {
    return sortRejectedResult(request, revisionBefore, 'invalid-range', 'the sort range is invalid')
  }

  const rangeArea = (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
  if (rangeArea > MAX_SORT_SOURCE_CELLS) {
    return sortRejectedResult(
      request,
      revisionBefore,
      'source-too-large',
      `sort range spans ${rangeArea} cells but the cap is ${MAX_SORT_SOURCE_CELLS}`,
    )
  }

  if (request.keys.some((key) => key.col < range.colStart || key.col > range.colEnd)) {
    return sortRejectedResult(
      request,
      revisionBefore,
      'key-out-of-range',
      'a sort key column is outside the sorted range',
    )
  }

  // Merge authority gate (design §5.2): the engine models no merge, so the
  // adapter — sole holder of the registry — rejects a sort touching a merge.
  const merges = state.mergeRangesBySheetId.get(request.sheetId) ?? []
  if (merges.some((merge) => rangesIntersect(merge, range))) {
    return sortRejectedResult(
      request,
      revisionBefore,
      'merge-in-range',
      'the sort range intersects a merged range; unmerge before sorting',
    )
  }
  // Spill gate (design §5.1): the static engine models no dynamic-array spill,
  // so there is nothing to intersect. TODO: add a spill gate here if the static
  // backend ever grows a spill model.

  const sheetCells = getOrCreateSheetCells(state, request.sheetId)
  const lookup: EvalCellLookup = {
    get(row, col) {
      return sheetCells.get(keyFor(row, col))
    },
    resolveStructuredRef: makeStructuredRefResolver(state, request.sheetId),
    hiddenRows: evalHiddenRowsForSheet(state, request.sheetId),
    filterHiddenRows: filterHiddenRowsForSheet(state, request.sheetId),
  }
  const keys = toResolvedSortKeys(request.keys)
  const plan = planPhysicalSort(
    range.rowStart,
    range.rowEnd,
    request.excludedRows ?? [],
    keys,
    (row, col) => cellToSortValue(sheetCells.get(keyFor(row, col)), lookup),
  )

  // No-op sort (identity permutation): resolves applied with movedRows 0, writes
  // nothing, records no undo entry, and does NOT bump the revision (design §7).
  if (plan.rowMap.size === 0) {
    return {
      kind: 'sort-range',
      sheetId: request.sheetId,
      applied: true,
      movedRows: 0,
      movedCells: 0,
      affectedRange: cloneRange(range),
      rowPermutation: [],
      requestId: request.requestId,
      revision: request.revision ?? revisionBefore,
    }
  }

  // A physical sort permutes the range's occupied/blank footprint (blanks and
  // non-blanks swap rows), so a granular before-image scoped to pre-existing
  // cells cannot clear positions that GAIN content on undo. Use the labeled
  // O(one-sheet) capture — the same fallback static's structural ops
  // (insert/delete rows, removeRows) use for whole-sheet rewrites.
  beginUndoableMutation(state)
  recordFullSheetBefore(state, request.sheetId)

  const cellFormats = getOrCreateCellFormats(state, request.sheetId)
  const rangeFormats = getOrCreateRangeFormats(state, request.sheetId)
  materializeAndCutSortFormatLayers(cellFormats, rangeFormats, range)
  const movedCells = relocateSortedCells(sheetCells, cellFormats, range, plan.rowMap)
  state.revision = bumpRevision(state.revision)

  return {
    kind: 'sort-range',
    sheetId: request.sheetId,
    applied: true,
    movedRows: plan.rowPermutation.length,
    movedCells,
    affectedRange: cloneRange(range),
    rowPermutation: plan.rowPermutation,
    requestId: request.requestId,
    revision: request.revision ?? state.revision,
  }
}

export function sparseCellsToVisibleProjectionResult(
  cells: StaticSeedCells,
  request: VisibleProjectionRequest,
  revision?: ProjectionRevision,
): VisibleProjectionResult {
  return buildProjectionResult(
    request,
    buildState(sparseCellsToCells(cells), revision ?? 0),
  ) as VisibleProjectionResult
}

export function sparseCellsToRangeProjectionResult(
  cells: StaticSeedCells,
  request: RangeProjectionRequest,
  revision?: ProjectionRevision,
): RangeProjectionResult {
  return buildProjectionResult(
    request,
    buildState(sparseCellsToCells(cells), revision ?? 0),
  ) as RangeProjectionResult
}

// === Excel Table registry (design-excel-table.md §4-§5, parity #32) =========
//
// The static backend is an in-memory reference engine, so it owns the Table
// registry directly (workbook-level, name-unique, structural-follow) and
// resolves structured references at eval time. Cross-layer parity with the
// engine `TableEntry` / `TableError` keeps the two backends interchangeable
// behind the same UI-core command + capability contract.
//
// Structured-reference SUPPORT LEVEL (honest boundary — no faked values):
//   - Resolved (as function args, e.g. `=SUM(Table1[Q1])`): `Table1[Col]`,
//     `Table1[[ColA]:[ColB]]`, `Table1[#All|#Data|#Headers|#Totals]`,
//     `Table1[#This Row]`, `Table1[@Col]`, `Table1[@]`, and the table-less
//     `[Col]` / `[@Col]` / `[@]` forms written inside the Table's own cells
//     (the containing Table is resolved from the anchoring cell).
//   - Resolved in VALUE context too when the reference is 1×1 — so
//     `=[@Price]*[@Qty]` works. A wider range in value context needs spill,
//     which the static engine does not model → `#ERROR!`.
//   - Unknown table → `#NAME?`; unknown column / missing header-or-totals band
//     / empty data region → `#REF!`; a this-row form whose anchor sits outside
//     the data body, or a table-less form outside any Table → `#VALUE!`.
//   - A bare `Table1` (no brackets) is NOT a structured reference in either
//     engine: both formula parsers read an A1-shaped token as a cell reference
//     even past `XFD`, so it evaluates as an empty off-grid cell (`=SUM(Table1)`
//     → 0). Pinned against WASM in
//     vnext-table-totals-static-wasm-parity.test.ts.
//   - NOT supported (fall to `#ERROR!`, never a faked value): combined
//     qualifiers `[[#Data],[Col]]` (the engine grammar defers them too) and
//     cross-sheet Table refs (the static evaluator reads a single sheet).
//     See TODO(einfach-static-structured-refs).
//
//     TODO(einfach-static-unsupported-ref-axis): both hosts refuse these forms,
//     but on different axes — the engine's parser rejects them at WRITE time
//     (`setCellInput` throws "formula could not be parsed or installed"),
//     while this backend accepts the write and reports `#ERROR!` at EVAL time.
//     Neither invents a value, so no wrong number can reach a user; aligning
//     them means adding a write-path rejection here, which changes the mutation
//     contract (callers must handle a thrown/rejected input) rather than the
//     evaluator, so it is deliberately deferred. Both behaviours are pinned by
//     the "unsupported structured-reference forms" test in
//     vnext-table-totals-static-wasm-parity.test.ts, so the boundary cannot
//     drift silently. Combined qualifiers should stay deferred on BOTH sides
//     until the engine grammar grows them (keeping one host ahead of the other
//     is what creates dialects).

const TABLE_RESERVED_NAMES: ReadonlySet<string> = new Set(ENGINE_BUILTIN_FORMULA_NAMES)

const GRID_MAX_COL = 16_383
const GRID_MAX_ROW = 1_048_575

function tableColumnLabelToIndex(label: string): number {
  let result = 0
  for (let i = 0; i < label.length; i += 1) {
    result = result * 26 + (label.charCodeAt(i) - 64)
  }
  return result - 1
}

/**
 * Is `name` an in-grid A1 cell reference (`AB12`)? Grid-bounded so an
 * out-of-grid pseudo-ref like `Table1` (column `TABLE`, past `XFD`) is NOT
 * treated as a cell reference — mirrors the engine `name_is_cell_ref_like`.
 */
function looksLikeCellRef(name: string): boolean {
  const match = /^([A-Za-z]+)([0-9]+)$/.exec(name)
  if (!match) return false
  const col = tableColumnLabelToIndex(match[1].toUpperCase())
  const row = Number(match[2]) - 1
  return col >= 0 && col <= GRID_MAX_COL && row >= 0 && row <= GRID_MAX_ROW
}

function namedRangeKeyExists(state: StaticBackendState, key: string): boolean {
  return state.namedRanges.some((entry) => entry.name.toUpperCase() === key)
}

/**
 * Full Table name mutex (design §4.2). Returns a structured rejection code or
 * `null` when the name is admissible. `excludeKey` is the uppercased key of a
 * Table being renamed (so a case-only rename never collides with itself).
 */
function validateTableName(
  state: StaticBackendState,
  name: string,
  excludeKey: string | null,
): TableMutationRejectionCode | null {
  if (name.length < 1 || name.length > 255 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return 'invalid-name'
  }
  const key = name.toUpperCase()
  if (TABLE_RESERVED_NAMES.has(key)) return 'reserved-name'
  if (looksLikeCellRef(name)) return 'name-like-cell-ref'
  const collidesTable = excludeKey
    ? key !== excludeKey && state.tablesByKey.has(key)
    : state.tablesByKey.has(key)
  if (collidesTable) return 'name-conflict'
  // Shared workbook namespace with defined names (design §4.2).
  if (namedRangeKeyExists(state, key)) return 'name-conflict'
  return null
}

/** First free `Table1`, `Table2`, … not used by a Table or a defined name. */
function nextAutoTableName(state: StaticBackendState): string {
  let n = 1
  for (;;) {
    const candidate = `Table${n}`
    const key = candidate.toUpperCase()
    if (!state.tablesByKey.has(key) && !namedRangeKeyExists(state, key)) return candidate
    n += 1
  }
}

/** Next `ColumnN` not already present in `used` (uppercased keys). */
function nextAutoColumnName(used: ReadonlySet<string>): string {
  let n = 1
  for (;;) {
    const candidate = `Column${n}`
    if (!used.has(candidate.toUpperCase())) return candidate
    n += 1
  }
}

function tableHeaderText(
  state: StaticBackendState,
  sheetId: string,
  row: number,
  col: number,
): string {
  const sheetCells = state.cellsBySheet.get(sheetId)
  const cell = sheetCells?.get(keyFor(row, col))
  if (!cell) return ''
  if (cell.formula) {
    const result = evaluateFormula(
      cell.formula,
      {
        get: (r, c) => sheetCells?.get(keyFor(r, c)),
        resolveStructuredRef: makeStructuredRefResolver(state, sheetId),
        hiddenRows: evalHiddenRowsForSheet(state, sheetId),
        filterHiddenRows: filterHiddenRowsForSheet(state, sheetId),
      },
      new Set(),
      { row, col },
    )
    const formatted = formatEvalResult(result)
    return formatted.isError ? '' : formatted.display
  }
  return cell.displayValue
}

/** Read the header row's cell text into column names, disambiguating blanks / duplicates. */
function deriveTableColumnNames(
  state: StaticBackendState,
  sheetId: string,
  range: CellRange,
): string[] {
  const headerRow = range.rowStart
  const names: string[] = []
  const used = new Set<string>()
  for (let col = range.colStart; col <= range.colEnd; col += 1) {
    const raw = tableHeaderText(state, sheetId, headerRow, col).trim()
    const name = raw === '' || used.has(raw.toUpperCase()) ? nextAutoColumnName(used) : raw
    used.add(name.toUpperCase())
    names.push(name)
  }
  return names
}

function tableDescriptor(
  state: StaticBackendState,
  entry: StaticTableEntry,
): SpreadsheetTableDescriptor {
  const sheetIndex = state.sheets.findIndex((sheet) => sheet.id === entry.sheetId)
  const sheet = sheetIndex >= 0 ? state.sheets[sheetIndex] : undefined
  return {
    name: entry.canonicalName,
    sheetId: entry.sheetId,
    sheetName: sheet?.name ?? '',
    sheetIndex,
    range: `${toA1(entry.range.rowStart, entry.range.colStart)}:${toA1(
      entry.range.rowEnd,
      entry.range.colEnd,
    )}`,
    hasHeaders: entry.hasHeaders,
    hasTotals: entry.hasTotals,
    columns: [...entry.columns],
  }
}

function tableRejected(
  state: StaticBackendState,
  request: { requestId?: number; revision?: ProjectionRevision },
  code: TableMutationRejectionCode,
  message?: string,
): TableMutationRejectedResult {
  return {
    kind: 'table-mutation-not-applied',
    applied: false,
    code,
    ...(message ? { message } : {}),
    requestId: request.requestId,
    // A rejected mutation never bumps: echo the current (un-bumped) witness.
    revision: request.revision ?? state.revision,
  }
}

/** Horizontal band of a structured reference — mirrors the engine `TableArea`. */
type StructuredArea = 'all' | 'data' | 'headers' | 'totals' | 'thisRow'

/**
 * Parsed `Table[inner]` body: which band, and which column span (`null` = the
 * Table's whole width). Shaped as the engine's `(area, columns)` pair so the
 * resolution order below can be compared line-for-line with `resolve_table_ref`.
 */
interface StructuredInnerSpec {
  readonly area: StructuredArea
  readonly columns: { readonly from: string; readonly to: string } | null
}

/** Column span covering a single name. */
function oneColumn(name: string): StructuredInnerSpec['columns'] {
  return { from: name, to: name }
}

/** Parse the inner text of a `Table[inner]` reference, or `null` when unsupported. */
function parseStructuredInner(inner: string): StructuredInnerSpec | null {
  const trimmed = inner.trim()
  // Empty `[]` is deferred by the engine grammar too (design §3.2).
  if (trimmed === '') return null
  if (trimmed.startsWith('#')) {
    switch (trimmed.toUpperCase().replace(/\s+/g, ' ')) {
      case '#ALL':
        return { area: 'all', columns: null }
      case '#DATA':
        return { area: 'data', columns: null }
      case '#HEADERS':
        return { area: 'headers', columns: null }
      case '#TOTALS':
        return { area: 'totals', columns: null }
      case '#THIS ROW':
        return { area: 'thisRow', columns: null }
      default:
        return null
    }
  }
  // `[@]` (whole current row), `[@Col]`, `[@[Col]]`.
  if (trimmed.startsWith('@')) {
    const rest = trimmed.slice(1).trim()
    if (rest === '') return { area: 'thisRow', columns: null }
    const bracketed = /^\[([^[\]]*)\]$/.exec(rest)
    if (bracketed) {
      const col = bracketed[1].trim()
      return col === '' ? null : { area: 'thisRow', columns: oneColumn(col) }
    }
    if (rest.includes('[') || rest.includes(']') || rest.includes(',')) return null
    return { area: 'thisRow', columns: oneColumn(rest) }
  }
  // Combined qualifiers (`[[#Data],[Col]]`) are deferred by the engine
  // grammar as well (design §3.2) — kept unsupported so both engines agree.
  if (trimmed.includes(',')) return null
  if (trimmed.includes('[')) {
    const multi = /^\[([^[\]]*)\]\s*:\s*\[([^[\]]*)\]$/.exec(trimmed)
    if (multi) {
      return { area: 'data', columns: { from: multi[1].trim(), to: multi[2].trim() } }
    }
    const single = /^\[([^[\]]*)\]$/.exec(trimmed)
    if (single) {
      const col = single[1].trim()
      return col === '' ? null : { area: 'data', columns: oneColumn(col) }
    }
    return null
  }
  // Bare, unqualified column: the whole DATA column (engine parity — the
  // engine's `parse_bare_colref` yields `TableArea::Data`, not this-row).
  return { area: 'data', columns: oneColumn(trimmed) }
}

/**
 * The Table anchored to `sheetId` whose range contains `origin` — how a
 * table-less `[Col]` / `[@Col]` finds its Table (engine
 * `lookup_table_containing`).
 */
function tableContaining(
  state: StaticBackendState,
  sheetId: string,
  origin: EvalOrigin,
): StaticTableEntry | undefined {
  for (const entry of state.tablesByKey.values()) {
    if (entry.sheetId !== sheetId) continue
    const { range } = entry
    if (
      origin.row >= range.rowStart &&
      origin.row <= range.rowEnd &&
      origin.col >= range.colStart &&
      origin.col <= range.colEnd
    ) {
      return entry
    }
  }
  return undefined
}

function resolveStructuredRefForTable(
  state: StaticBackendState,
  sheetId: string,
  tableName: string | null,
  inner: string,
  origin: EvalOrigin | null,
): StructuredRefResolution {
  const refError = (code: string): StructuredRefResolution => ({ kind: 'error', code })

  let entry: StaticTableEntry | undefined
  if (tableName) {
    entry = state.tablesByKey.get(tableName.toUpperCase())
    // Unknown NAMED table → `#NAME?` (engine `InvalidName`).
    if (!entry) return refError('#NAME?')
    // The static evaluator reads a single sheet, so a cross-sheet Table ref is
    // an honest "not supported here" (→ `#ERROR!`), not a wrong value.
    // TODO(einfach-static-structured-refs): needs a multi-sheet cell lookup.
    if (entry.sheetId !== sheetId) return null
  } else {
    // Table-less `[Col]` / `[@Col]`: resolve from the anchoring cell. Outside
    // any Table (or with no anchor at all) → `#VALUE!`, engine parity.
    if (!origin) return refError('#VALUE!')
    entry = tableContaining(state, sheetId, origin)
    if (!entry) return refError('#VALUE!')
  }

  const spec = parseStructuredInner(inner)
  if (!spec) return null

  const { range } = entry
  const dataStart = range.rowStart + (entry.hasHeaders ? 1 : 0)
  const dataEnd = range.rowEnd - (entry.hasTotals ? 1 : 0)

  // Rows first, then columns — the engine's order, so the surfaced error code
  // matches when a reference is bad on both axes at once.
  let rowStart: number
  let rowEnd: number
  switch (spec.area) {
    case 'all':
      rowStart = range.rowStart
      rowEnd = range.rowEnd
      break
    case 'headers':
      if (!entry.hasHeaders) return refError('#REF!')
      rowStart = range.rowStart
      rowEnd = range.rowStart
      break
    case 'totals':
      if (!entry.hasTotals) return refError('#REF!')
      rowStart = range.rowEnd
      rowEnd = range.rowEnd
      break
    case 'data':
      // Zero data rows → `#REF!` (design §4.1 known divergence from Excel's
      // "keep one empty data row").
      if (dataEnd < dataStart) return refError('#REF!')
      rowStart = dataStart
      rowEnd = dataEnd
      break
    case 'thisRow': {
      if (!origin || dataEnd < dataStart || origin.row < dataStart || origin.row > dataEnd) {
        // Current row outside the data body → `#VALUE!` (design §5.3 point 2).
        return refError('#VALUE!')
      }
      rowStart = origin.row
      rowEnd = origin.row
      break
    }
  }

  if (!spec.columns) {
    return {
      kind: 'range',
      ref: { rowStart, rowEnd, colStart: range.colStart, colEnd: range.colEnd },
    }
  }
  const fromIdx = entry.columns.findIndex(
    (c) => c.toLowerCase() === spec.columns!.from.toLowerCase(),
  )
  const toIdx = entry.columns.findIndex((c) => c.toLowerCase() === spec.columns!.to.toLowerCase())
  if (fromIdx < 0 || toIdx < 0) return refError('#REF!')
  return {
    kind: 'range',
    ref: {
      rowStart,
      rowEnd,
      colStart: range.colStart + Math.min(fromIdx, toIdx),
      colEnd: range.colStart + Math.max(fromIdx, toIdx),
    },
  }
}

function makeStructuredRefResolver(
  state: StaticBackendState,
  sheetId: string,
): StructuredRefResolver {
  return (tableName, inner, origin) =>
    resolveStructuredRefForTable(state, sheetId, tableName, inner, origin)
}

/** Shrink `[lo, hi]` by the deletion of `[d0, d1]`; `null` when fully deleted. */
function shrinkTableInterval(
  lo: number,
  hi: number,
  d0: number,
  d1: number,
): [number, number] | null {
  if (d0 <= lo && hi <= d1) return null
  const count = d1 - d0 + 1
  const newLo = lo < d0 ? lo : lo > d1 ? lo - count : d0
  const ovLo = Math.max(d0, lo)
  const ovHi = Math.min(d1, hi)
  const deleted = ovHi >= ovLo ? ovHi - ovLo + 1 : 0
  const len = hi - lo + 1 - deleted
  return [newLo, newLo + len - 1]
}

type TableRemap = 'keep' | 'delete' | { readonly range: CellRange; readonly columns: string[] }

/**
 * Follow one Table through a structural edit — the TS mirror of the engine
 * `remap_table_geometry` §4.3 follow matrix. `direction` is `1` (insert) /
 * `-1` (delete); `at` is the first affected row/column index.
 */
function remapTableGeometry(
  range: CellRange,
  columns: readonly string[],
  axis: 'row' | 'column',
  at: number,
  count: number,
  direction: 1 | -1,
): TableRemap {
  const { rowStart: sR, rowEnd: eR, colStart: sC, colEnd: eC } = range

  if (axis === 'row') {
    if (direction === 1) {
      const nsR = sR >= at ? sR + count : sR
      const neR = eR >= at ? eR + count : eR
      if (nsR === sR && neR === eR) return 'keep'
      return {
        range: { rowStart: nsR, rowEnd: neR, colStart: sC, colEnd: eC },
        columns: [...columns],
      }
    }
    const d0 = at
    const d1 = at + count - 1
    if (d0 <= sR && sR <= d1) return 'delete' // header row swallowed → drop the Table
    const shrunk = shrinkTableInterval(sR, eR, d0, d1)
    if (!shrunk) return 'delete'
    const [nsR, neR] = shrunk
    if (nsR === sR && neR === eR) return 'keep'
    return {
      range: { rowStart: nsR, rowEnd: neR, colStart: sC, colEnd: eC },
      columns: [...columns],
    }
  }

  if (direction === 1) {
    const nsC = sC >= at ? sC + count : sC
    const neC = eC >= at ? eC + count : eC
    const cols = [...columns]
    // Widening (insert strictly inside the column span): splice auto-named columns.
    if (sC < at && at <= eC) {
      const idx = at - sC
      const used = new Set(cols.map((c) => c.toUpperCase()))
      for (let offset = 0; offset < count; offset += 1) {
        const name = nextAutoColumnName(used)
        used.add(name.toUpperCase())
        cols.splice(idx + offset, 0, name)
      }
    }
    if (nsC === sC && neC === eC && cols.length === columns.length) return 'keep'
    return { range: { rowStart: sR, rowEnd: eR, colStart: nsC, colEnd: neC }, columns: cols }
  }

  const d0 = at
  const d1 = at + count - 1
  const shrunk = shrinkTableInterval(sC, eC, d0, d1)
  if (!shrunk) return 'delete' // every column deleted
  const [nsC, neC] = shrunk
  const cols = [...columns]
  const ovLo = Math.max(d0, sC)
  const ovHi = Math.min(d1, eC)
  if (ovHi >= ovLo) {
    cols.splice(ovLo - sC, ovHi - ovLo + 1)
  }
  if (nsC === sC && neC === eC && cols.length === columns.length) return 'keep'
  return { range: { rowStart: sR, rowEnd: eR, colStart: nsC, colEnd: neC }, columns: cols }
}

/**
 * Follow every Table anchored to `sheetId` through a structural edit. Runs
 * inside the existing structural-op handlers, after the cell/format/dimension
 * shifts. NOT recorded in the undo delta — the same known gap as the worker
 * (design §11/§12): undoing a structural op restores cells but not the Table
 * geometry drift.
 */
function applyTableShift(
  state: StaticBackendState,
  sheetId: string,
  axis: 'row' | 'column',
  at: number,
  count: number,
  direction: 1 | -1,
): void {
  if (state.tablesByKey.size === 0) return
  for (const [key, entry] of [...state.tablesByKey]) {
    if (entry.sheetId !== sheetId) continue
    const outcome = remapTableGeometry(entry.range, entry.columns, axis, at, count, direction)
    if (outcome === 'keep') continue
    if (outcome === 'delete') {
      state.tablesByKey.delete(key)
      continue
    }
    entry.range = outcome.range
    entry.columns = outcome.columns
  }
}

// --- Totals row (design-excel-table.md §7, parity #32 T6) -------------------
//
// The totals row is a Table-INTERNAL behaviour, not a sheet structural op:
// toggling it grows/shrinks the Table's own range by one row and writes/clears
// `=SUBTOTAL(1xx, Table[Col])` formulas through the ordinary cell path, so the
// cell formula IS the fact — there is no second per-column source of truth and
// a UI reconstructs its dropdown by reading the cell formula back.

/**
 * Totals aggregate id → SUBTOTAL function number, mirroring the engine
 * `TotalsFunction::subtotal_code`. Every code sits in the **101-111** band so
 * a totals aggregate excludes host-hidden rows. `null` means "clear the cell".
 */
const TOTALS_SUBTOTAL_CODES: Readonly<Record<TableTotalsFunction, number | null>> = {
  none: null,
  average: 101,
  countNums: 102,
  count: 103,
  max: 104,
  min: 105,
  stdDev: 107,
  sum: 109,
  var: 110,
}

/** Excel's default aggregate for a freshly enabled totals row: SUM. */
const TOTALS_DEFAULT_SUBTOTAL_CODE = 109

/**
 * Canonical totals-cell formula text. Matches the engine's `render_formula`
 * output byte-for-byte (no space after the comma, bare single-column spec) so
 * the two backends store the SAME formula string and the rename walkers in
 * `rewriteStructuredRefsInFormula` match it identically.
 */
function totalsSubtotalFormula(table: string, column: string, code: number): string {
  return `=SUBTOTAL(${code},${table}[${column}])`
}

/**
 * Does any cell in `range` hold a formula or a non-empty primitive? The
 * totals-row occupancy guard — the engine never pushes existing content down
 * to make room (`range_has_content` / `TableError::TotalsRowBlocked`).
 */
function rangeHasContent(state: StaticBackendState, sheetId: string, range: CellRange): boolean {
  const cells = state.cellsBySheet.get(sheetId)
  if (!cells) return false
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const cell = cells.get(keyFor(row, col))
      if (!cell) continue
      if (cell.formula !== undefined || cell.displayValue !== '') return true
    }
  }
  return false
}

/** Write (or clear, when `code` is `null`) one totals-row cell. */
function writeTotalsCell(
  state: StaticBackendState,
  entry: StaticTableEntry,
  columnIndex: number,
  code: number | null,
): void {
  const cells = getOrCreateSheetCells(state, entry.sheetId)
  const row = entry.range.rowEnd
  const col = entry.range.colStart + columnIndex
  recordCellBefore(state, entry.sheetId, keyFor(row, col))
  if (code === null) {
    cells.delete(keyFor(row, col))
    return
  }
  updateCell(cells, {
    kind: 'set-cell-input',
    sheetId: entry.sheetId,
    row,
    col,
    input: totalsSubtotalFormula(entry.canonicalName, entry.columns[columnIndex], code),
  })
}

/** Rewrite `Table[...]` structured references across every sheet's formulas. */
function rewriteTableRefsAcrossWorkbook(
  state: StaticBackendState,
  spec: StructuredRefRewriteSpec,
): void {
  for (const cells of state.cellsBySheet.values()) {
    for (const cell of cells.values()) {
      if (cell.formula === undefined) continue
      const next = rewriteStructuredRefsInFormula(cell.formula, spec)
      if (next !== cell.formula) {
        cell.formula = next
        // The projection re-derives the display at read time; keep the parked
        // placeholder in sync so a pre-projection read shows the new text.
        cell.displayValue = next
      }
    }
  }
}

export interface StaticSpreadsheetBackend extends SpreadsheetBackend {
  removeRowsExact(request: RemoveRowsExactRequest): Promise<RemoveRowsExactResult>
}

export function createStaticSpreadsheetBackend(
  seed: StaticSpreadsheetSeedInput = [],
): StaticSpreadsheetBackend {
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
    async readFreezeConfig(request) {
      if (!state.sheets.some((sheet) => sheet.id === request.sheetId)) {
        throw new Error(`unknown sheet: ${request.sheetId}`)
      }
      const freeze = state.freezeBySheetId.get(request.sheetId) ?? { rows: 0, cols: 0 }
      return {
        kind: 'freeze-config',
        sheetId: request.sheetId,
        freeze: { ...freeze },
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    async setFreezeConfig(request) {
      if (!state.sheets.some((sheet) => sheet.id === request.sheetId)) {
        throw new Error(`unknown sheet: ${request.sheetId}`)
      }
      if (
        !Number.isSafeInteger(request.freeze.rows) ||
        request.freeze.rows < 0 ||
        !Number.isSafeInteger(request.freeze.cols) ||
        request.freeze.cols < 0
      ) {
        throw new Error('freeze rows and columns must be non-negative safe integers')
      }
      if (request.revision !== undefined && request.revision !== state.revision) {
        throw new Error(
          `freeze revision conflict: expected ${String(request.revision)}, current ${String(state.revision)}`,
        )
      }
      beginUndoableMutation(state)
      recordFreezeBefore(state, request.sheetId)
      state.freezeBySheetId.set(request.sheetId, {
        rows: request.freeze.rows,
        cols: request.freeze.cols,
      })
      state.revision = bumpRevision(state.revision)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: state.revision,
      }
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
      if (request.cells.length === 0) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: state.revision,
          affectedRange: request.range,
        }
      }

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
      const revisionBefore = state.revision
      const undoStackBefore = [...state.undoStack]
      const redoStackBefore = [...state.redoStack]
      const pendingDeltaBefore = state.pendingDelta
      let transactionStarted = false

      try {
        for await (const chunk of request.chunks) {
          for (const cell of chunk) {
            if (!transactionStarted) {
              // Keep the import streaming: defer history allocation until the
              // first actual cell instead of materializing the whole source.
              beginUndoableMutation(state)
              transactionStarted = true
            }

            recordCellBefore(state, request.sheetId, keyFor(cell.row, cell.col))
            updateCell(
              getOrCreateSheetCells(state, request.sheetId),
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
      } catch (error) {
        if (transactionStarted) {
          const rollbackDelta = state.pendingDelta
          try {
            if (rollbackDelta) applyStateDelta(state, rollbackDelta)
          } finally {
            state.undoStack = undoStackBefore
            state.redoStack = redoStackBefore
            state.pendingDelta = pendingDeltaBefore
            state.revision = revisionBefore
          }
        }
        throw error
      }

      if (!transactionStarted) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: state.revision,
          affectedRange: request.range,
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
      const hiddenRows = state.hiddenRowsBySheetId.get(request.sheetId)
      if (hiddenRows) shiftHiddenIndexSet(hiddenRows, request.rowIndex, request.count, 1)
      shiftFilterHiddenRows(state, request.sheetId, request.rowIndex, request.count, 1)
      shiftMergeRanges(state, request.sheetId, 'row', request.rowIndex, request.count, 1)
      shiftFreezeConfig(state, request.sheetId, 'row', request.rowIndex, request.count, 1)
      applyTableShift(state, request.sheetId, 'row', request.rowIndex, request.count, 1)
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
      const hiddenRows = state.hiddenRowsBySheetId.get(request.sheetId)
      if (hiddenRows) {
        shiftHiddenIndexSet(hiddenRows, request.rowIndex, request.count, -1)
        if (hiddenRows.size === 0) state.hiddenRowsBySheetId.delete(request.sheetId)
      }
      shiftFilterHiddenRows(state, request.sheetId, request.rowIndex, request.count, -1)
      shiftMergeRanges(state, request.sheetId, 'row', request.rowIndex, request.count, -1)
      shiftFreezeConfig(state, request.sheetId, 'row', request.rowIndex, request.count, -1)
      applyTableShift(state, request.sheetId, 'row', request.rowIndex, request.count, -1)
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
      const hiddenCols = state.hiddenColsBySheetId.get(request.sheetId)
      if (hiddenCols) shiftHiddenIndexSet(hiddenCols, request.colIndex, request.count, 1)
      shiftMergeRanges(state, request.sheetId, 'column', request.colIndex, request.count, 1)
      shiftFreezeConfig(state, request.sheetId, 'column', request.colIndex, request.count, 1)
      applyTableShift(state, request.sheetId, 'column', request.colIndex, request.count, 1)
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
      const hiddenCols = state.hiddenColsBySheetId.get(request.sheetId)
      if (hiddenCols) {
        shiftHiddenIndexSet(hiddenCols, request.colIndex, request.count, -1)
        if (hiddenCols.size === 0) state.hiddenColsBySheetId.delete(request.sheetId)
      }
      shiftMergeRanges(state, request.sheetId, 'column', request.colIndex, request.count, -1)
      shiftFreezeConfig(state, request.sheetId, 'column', request.colIndex, request.count, -1)
      applyTableShift(state, request.sheetId, 'column', request.colIndex, request.count, -1)
      state.revision = bumpRevision(state.revision)
      return structuralMutationResult(request, state.revision)
    },
    async hideRows(request) {
      const plan = preflightHiddenIndexMutation(state, request)
      if (plan.status === 'apply') {
        applyHiddenIndexMutationPlan(state, request.sheetId, plan)
      }
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    async unhideRows(request) {
      const plan = preflightHiddenIndexMutation(state, request)
      if (plan.status === 'apply') {
        applyHiddenIndexMutationPlan(state, request.sheetId, plan)
      }
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    async hideColumns(request) {
      const plan = preflightHiddenIndexMutation(state, request)
      if (plan.status === 'apply') {
        applyHiddenIndexMutationPlan(state, request.sheetId, plan)
      }
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    async unhideColumns(request) {
      const plan = preflightHiddenIndexMutation(state, request)
      if (plan.status === 'apply') {
        applyHiddenIndexMutationPlan(state, request.sheetId, plan)
      }
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    /**
     * SUBTOTAL 101-111 hidden-row evaluation input (parity #23,
     * design-excel-table §6.1). Retained as a port for surface parity with the
     * WASM engine (which cannot drop the export — INV-4 fingerprints it as
     * permanent baggage), but since the hidden-row sink-down (E7) it writes the
     * ONE `hiddenRowsBySheetId` store, exactly as the WASM engine's
     * `set_eval_hidden_rows` writes the one owned `Sheet::hidden_rows`. There is
     * no longer a separate eval lane to union in.
     *
     * Whole-set REPLACE: an empty set clears the sheet. Out-of-range and
     * duplicate rows are harmless — the evaluator only tests membership. Not
     * undoable and does not bump the revision.
     */
    setEvalHiddenRows(request: SetEvalHiddenRowsRequest): void {
      const rows = request.rows.filter((row) => Number.isSafeInteger(row) && row >= 0)
      if (rows.length === 0) {
        state.hiddenRowsBySheetId.delete(request.sheetId)
        return
      }
      state.hiddenRowsBySheetId.set(request.sheetId, new Set(rows))
    },
    /**
     * Whole-sheet hidden-state hydration read (design-engine-hidden-rows §4.2),
     * the twin of the worker's `readSheetHiddenStateThroughWorker`. UI core
     * re-hydrates its render caches from this after an undo/redo: this backend's
     * own `restoreFullSheet` already put the manual-hidden and FILTER-hidden
     * sets (and the filter rules) back on the structural transaction, so this
     * read reports the restored authoritative sets. Manual COLUMNS are omitted —
     * this backend, like the WASM engine, has nothing authoritative to say about
     * hidden columns (§8), which stay UI-core canonical.
     */
    async readSheetHiddenState(
      request: SheetHiddenStateRequest,
    ): Promise<SheetHiddenStateResult> {
      const manualRows = [...(state.hiddenRowsBySheetId.get(request.sheetId) ?? [])].sort(
        (left, right) => left - right,
      )
      const filterRows = [...(state.filterHiddenRowsBySheetId.get(request.sheetId) ?? [])].sort(
        (left, right) => left - right,
      )
      const filterRules = (state.filterSortBySheetId.get(request.sheetId)?.rules ??
        []) as readonly ColumnFilterRule[]
      return {
        kind: 'sheet-hidden-state',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        manualRows,
        filterRows,
        filterRules,
      }
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
        kind: request.kind,
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
      // applies the requested kind/op/transpose/skipBlanks flags via the
      // shared pure helpers in `paste-range-plan.ts` (one semantic shared
      // with the worker adapter), and writes back via the same maps that
      // `setCellInput` / `setFormatRange` mutate. Designed to be easy to
      // reason about, not to handle every Excel edge case.
      beginUndoableMutation(state)

      const sourceSheetCells = getOrCreateSheetCells(state, request.source.sheetId)
      const sourceCellFormats = getOrCreateCellFormats(state, request.source.sheetId)
      const sourceRangeFormats = getOrCreateRangeFormats(state, request.source.sheetId)
      const targetSheetCells = getOrCreateSheetCells(state, request.sheetId)
      const targetCellFormats = getOrCreateCellFormats(state, request.sheetId)

      const src = request.source.range
      const tgt = request.target
      const geometry = pasteRangeGeometry(request)

      for (let dr = 0; dr < geometry.patchRows; dr += 1) {
        for (let dc = 0; dc < geometry.patchCols; dc += 1) {
          const srcCoord = pasteSourceCoord(src, geometry.transpose, dr, dc)
          const tgtRow = tgt.rowStart + dr
          const tgtCol = tgt.colStart + dc
          const srcKey = keyFor(srcCoord.row, srcCoord.col)
          const tgtKey = keyFor(tgtRow, tgtCol)
          const srcCell = sourceSheetCells.get(srcKey)
          const srcDisplay = srcCell?.displayValue ?? ''

          // Skip-blanks: if the source cell is empty, leave the target alone.
          if (request.skipBlanks && isPasteSourceBlank(srcDisplay, srcCell?.formula)) {
            continue
          }

          if (geometry.writeValues) {
            const baseInput = srcCell?.formula ?? srcDisplay
            const targetCell = targetSheetCells.get(tgtKey)
            const finalInput = applyPasteArithmetic(request.op, baseInput, targetCell?.displayValue)
            // `applyPasteArithmetic` returns `null` when arithmetic
            // coercion would be ill-defined (text/error sides) — preserve
            // the target verbatim. Otherwise reuse the in-place
            // setCellInput helper so revision/value-kind invariants stay
            // consistent.
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

          if (geometry.writeFormats) {
            recordCellFormatBefore(state, request.sheetId, tgtKey)
            const effectiveFormat = getEffectiveFormat(
              srcCoord.row,
              srcCoord.col,
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
        affectedRange: { ...geometry.affectedRange },
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
      const unique = Array.from(new Set(request.rows)).filter((r) => Number.isInteger(r) && r >= 0)
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
      const mutation = applyStaticRowsRemoval(
        state,
        request.sheetId,
        unique,
        bumpRevision(state.revision),
      )

      // Span of touched rows for callers that want to invalidate a
      // contiguous projection window. We don't know the workbook's true
      // column extent, so report the union of any existing column range:
      // `findDuplicateRows` only ever ran across the dialog's range, so
      // every column in the spreadsheet is potentially affected by the
      // upward shift of rows below `minRow`.
      let maxCol = -1
      for (const cell of mutation.cells.values()) {
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
        revision: request.revision ?? mutation.revision,
      }
    },
    async removeRowsExact(request: RemoveRowsExactRequest): Promise<RemoveRowsExactResult> {
      const plan = planStaticRemoveRowsExact(state, request)
      const mutation = applyStaticRowsRemoval(
        state,
        plan.sheetId,
        plan.descendingRows,
        plan.nextRevision,
      )

      return {
        requestId: plan.requestId,
        sheetId: plan.sheetId,
        targetRange: { ...plan.targetRange },
        removedRowIndices: [...plan.ascendingRows],
        removedRows: plan.ascendingRows.length,
        affectedRange: {
          startRow: plan.ascendingRows[0],
          endRow: plan.targetRange.rowEnd,
          startCol: plan.targetRange.colStart,
          endCol: plan.targetRange.colEnd,
        },
        revision: mutation.revision,
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
        outcome: 'w0-acknowledged',
        authority: 'static-session-registry',
      }
    },
    async deleteNamedRange(request: DeleteNamedRangeRequest): Promise<NamedRangeMutationResult> {
      const exists = state.namedRanges.some((item) =>
        namedRangeMatches(item, request.name, request.scope),
      )
      if (!exists) {
        return {
          requestId: request.requestId,
          revision: request.revision ?? state.revision,
          outcome: 'confirmed-not-applied',
          authority: 'static-session-registry',
        }
      }
      beginUndoableMutation(state)
      recordNamedRangesBefore(state)
      deleteNamedRangeFromState(state, request)
      state.revision = bumpRevision(state.revision)
      return {
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        outcome: 'w0-acknowledged',
        authority: 'static-session-registry',
      }
    },
    async setValidationRule(request: SetValidationRuleRequest): Promise<BackendMutationResult> {
      beginUndoableMutation(state)
      applyValidationRule(state, request)
      state.revision = bumpRevision(state.revision)
      return mutationResult(request, state.revision, request.range)
    },
    async clearValidationRule(request: ClearValidationRuleRequest): Promise<BackendMutationResult> {
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
    /**
     * Applying the rules also SNAPSHOTS the filter-hidden row set
     * (`design-filter-hidden-rows` §4.2, slice S4). That set is what makes
     * `SUBTOTAL(1-11)` and `SUBTOTAL(101-111)` stop counting filtered-out rows
     * — Excel's behaviour, and previously impossible here because the
     * evaluator had no idea a filter existed.
     *
     * The scan is the SAME one the projection already runs
     * (`buildFilterSortDisplayRows` over the full sheet extent); the hidden
     * set is its complement, so the two can never disagree about which rows a
     * rule removed. Snapshot, not live: taken here and not re-derived per
     * read, which is both Excel's model (`Data → Reapply`) and the worker
     * adapter's push point, so the two hosts stay observationally identical.
     */
    async setFilterSort(request: SetFilterSortRequest): Promise<SetFilterSortResult> {
      const nextRevision = nextRevisionOrThrow(state.revision)
      const next = cloneFilterSortState({ rules: request.rules })
      let hiddenRowIndices: readonly number[] = []
      if (filterSortHasEffect(next)) {
        state.filterSortBySheetId.set(request.sheetId, next)
        const sheetCells = getOrCreateSheetCells(state, request.sheetId)
        const lookup: EvalCellLookup = {
          get(row: number, col: number) {
            return sheetCells.get(keyFor(row, col))
          },
          resolveStructuredRef: makeStructuredRefResolver(state, request.sheetId),
          hiddenRows: evalHiddenRowsForSheet(state, request.sheetId),
          // Deliberately the PREVIOUS filter set, exactly like the worker
          // (whose engine still holds the old set while the new scan runs):
          // a predicate column holding a SUBTOTAL reads the pre-apply value,
          // which keeps the derivation non-circular on both hosts.
          filterHiddenRows: filterHiddenRowsForSheet(state, request.sheetId),
        }
        const displayRows = buildFilterSortDisplayRows(sheetCells, lookup, next)
        const hidden = filterHiddenRowsFromDisplayRows(
          displayRows,
          getMaxSourceRow(sheetCells) + 1,
        )
        hiddenRowIndices = hidden
        if (hidden.length > 0) {
          state.filterHiddenRowsBySheetId.set(request.sheetId, new Set(hidden))
        } else {
          state.filterHiddenRowsBySheetId.delete(request.sheetId)
        }
      } else {
        state.filterSortBySheetId.delete(request.sheetId)
        // Clearing the rules must clear the derived set too, or SUBTOTAL would
        // keep excluding rows that are visible again.
        state.filterHiddenRowsBySheetId.delete(request.sheetId)
      }
      state.revision = nextRevision
      // The set travels back to UI core on the ACK, where it becomes the
      // canonical answer for rendering, navigation and sort exclusion — one
      // scan, three consumers, no second derivation to drift from this one.
      return { ...mutationResult(request, state.revision), hiddenRowIndices }
    },
    async sortRange(request: SortRangeRequest): Promise<SortRangeResult> {
      return applyStaticSortRange(state, request)
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
      const pageStart = Math.max(0, request.pageStart)
      let regexMatcher: RegExp | null = null

      if (needle.length > 0 && options.regex) {
        try {
          const source = options.wholeMatch ? `^(?:${needle})$` : needle
          regexMatcher = new RegExp(source, options.caseSensitive ? 'g' : 'gi')
        } catch {
          return {
            kind: 'search-range',
            sheetId: request.sheetId,
            matches: [],
            pageStart,
            totalCount: 0,
            requestId: request.requestId,
            revision: request.revision ?? state.revision,
          }
        }
      }

      const matches: {
        coord: { row: number; col: number }
        sheetId: string
        matchStart: number
        matchEnd: number
        target: FindReplaceTarget
      }[] = []
      for (const cell of cells.values()) {
        if (cell.row < range.rowStart || cell.row > range.rowEnd) continue
        if (cell.col < range.colStart || cell.col > range.colEnd) continue
        const target: FindReplaceTarget =
          options.searchFormulas && cell.formula !== undefined ? 'formula' : 'displayValue'
        const haystack = target === 'formula' ? cell.formula! : cell.displayValue
        if (needle.length === 0 || haystack.length === 0) continue

        const spans = regexMatcher
          ? collectRegexFindSpans(regexMatcher, haystack)
          : collectLiteralFindSpans(
              haystack,
              needle,
              Boolean(options.caseSensitive),
              Boolean(options.wholeMatch),
            )
        for (const span of spans) {
          matches.push({
            coord: { row: cell.row, col: cell.col },
            sheetId: request.sheetId,
            matchStart: span.start,
            matchEnd: span.end,
            target,
          })
        }
      }
      matches.sort(
        (a, b) =>
          a.coord.row - b.coord.row || a.coord.col - b.coord.col || a.matchStart - b.matchStart,
      )
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
      if (
        request.requestId === undefined ||
        !Number.isSafeInteger(request.requestId) ||
        request.requestId < 0
      ) {
        throw invalidReplaceMatchesRequest('Replace requires an exact safe request id')
      }

      if (request.revision === undefined) {
        return replaceMatchesNotApplied(
          request.requestId,
          'FIND_REPLACE_REVISION_REQUIRED',
          'Replace requires an exact projection revision',
        )
      }
      if (request.revision !== state.revision) {
        return replaceMatchesNotApplied(
          request.requestId,
          'FIND_REPLACE_REVISION_CONFLICT',
          `Replace revision conflict: expected ${String(request.revision)}, ` +
            `current ${String(state.revision)}`,
        )
      }

      const plan = buildStaticReplacementPlan(state, request.coords, request.replacement)
      if (plan.status === 'invalid') {
        return replaceMatchesNotApplied(
          request.requestId,
          'FIND_REPLACE_REPLACEMENT_PLAN_INVALID',
          plan.message,
        )
      }
      if (plan.replacedCount === 0) {
        return {
          replacedCount: 0,
          requestId: request.requestId,
          revision: state.revision,
        }
      }

      const nextRevision = bumpRevision(state.revision)
      if (Object.is(nextRevision, state.revision)) {
        return replaceMatchesNotApplied(
          request.requestId,
          'FIND_REPLACE_REVISION_UNADVANCEABLE',
          `Replace cannot advance projection revision: ${String(state.revision)}`,
        )
      }

      beginUndoableMutation(state)
      for (const cellPlan of plan.cells) {
        const cells = state.cellsBySheet.get(cellPlan.sheetId)!
        recordCellBefore(state, cellPlan.sheetId, cellPlan.key)
        updateCell(cells, {
          kind: 'set-cell-input',
          sheetId: cellPlan.sheetId,
          row: cellPlan.row,
          col: cellPlan.col,
          input: cellPlan.nextInput,
        })
      }
      state.revision = nextRevision
      return {
        replacedCount: plan.replacedCount,
        requestId: request.requestId,
        revision: state.revision,
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
    async fillSeries(request) {
      const plan = preflightFillSeries(state, request)
      if (plan.status === 'noop') {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: state.revision,
        }
      }

      applyFillSeriesPlan(state, request.sheetId, plan)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: state.revision,
        affectedRange: cloneRange(plan.writeRange),
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

      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
      state.sheets = [...state.sheets, createdSheet]
      state.cellsBySheet.set(createdSheet.id, new Map())
      state.cellFormatsBySheetId.set(createdSheet.id, new Map())
      state.rangeFormatsBySheetId.set(createdSheet.id, [])
      state.hiddenRowsBySheetId.set(createdSheet.id, new Set())
      state.hiddenColsBySheetId.set(createdSheet.id, new Set())
      state.freezeBySheetId.set(createdSheet.id, { rows: 0, cols: 0 })
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
      if (sheet.name === name) {
        return sheetMutationResult(state, request.requestId, {
          sheetId: request.sheetId,
          activeSheetId: request.sheetId,
        })
      }

      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
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

      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
      recordNamedRangesBefore(state)
      recordFullSheetBefore(state, request.sheetId)

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
      state.hiddenRowsBySheetId.delete(request.sheetId)
      state.hiddenColsBySheetId.delete(request.sheetId)
      state.freezeBySheetId.delete(request.sheetId)
      // Drop every Table anchored to the deleted sheet (design §4.4). Not
      // captured by the undo delta — the registry is outside the timeline.
      for (const [tableKey, tableEntry] of [...state.tablesByKey]) {
        if (tableEntry.sheetId === request.sheetId) state.tablesByKey.delete(tableKey)
      }
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
      if (hasSameSheetOrder(state.sheets, nextSheets)) {
        return sheetMutationResult(state, request.requestId, {
          sheetId: request.sheetId,
          activeSheetId: request.sheetId,
        })
      }

      beginUndoableMutation(state)
      recordSheetsMetaBefore(state)
      state.sheets = nextSheets
      state.revision = bumpRevision(state.revision)

      return sheetMutationResult(state, request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
      })
    },
    async undoTransaction(request) {
      const delta = state.undoStack[state.undoStack.length - 1]
      if (!delta) {
        throw new Error('nothing to undo')
      }
      const nextRevision = nextRevisionOrThrow(state.revision)
      state.pendingDelta = null
      const forward = applyStateDelta(state, delta)
      state.undoStack.pop()
      state.redoStack.push(forward)
      state.revision = nextRevision
      return {
        transactionId: request.transactionId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    async redoTransaction(request) {
      const delta = state.redoStack[state.redoStack.length - 1]
      if (!delta) {
        throw new Error('nothing to redo')
      }
      const nextRevision = nextRevisionOrThrow(state.revision)
      state.pendingDelta = null
      const reverse = applyStateDelta(state, delta)
      state.redoStack.pop()
      state.undoStack.push(reverse)
      state.revision = nextRevision
      return {
        transactionId: request.transactionId,
        requestId: request.requestId,
        revision: state.revision,
      }
    },
    // --- Excel Table CRUD (design-excel-table.md §4/§10, parity #32) -------
    //
    // The static backend owns the Table registry directly. These six ports
    // present the Table geometry canonically; UI core stores no second copy.
    // Structured rejections (name conflict / range overlap / cap 256 / …)
    // resolve as `TableMutationRejectedResult` rather than throwing.
    //
    // TODO(#32 undo, design §11/§12): table-definition mutations are NOT
    // wrapped in an undo transaction — the undo delta does not carry the
    // registry, so a Ctrl+Z cannot replay create / rename / delete of the
    // Table itself. Create / rename / delete bump the revision so the next
    // projection reflects any referencing-formula recompute.
    async createTable(request: CreateTableRequest): Promise<CreateTableResult> {
      if (!state.sheets.some((sheet) => sheet.id === request.sheetId)) {
        return tableRejected(state, request, 'sheet-not-found')
      }
      const range = normalizeRange(request.range)
      for (const entry of state.tablesByKey.values()) {
        if (entry.sheetId === request.sheetId && rangesIntersect(entry.range, range)) {
          return tableRejected(state, request, 'range-overlap')
        }
      }
      // Cap check before name resolution so a rejected 257th table never
      // perturbs the auto-name counter (design §4.1).
      if (state.tablesByKey.size >= MAX_STATIC_TABLES) {
        return tableRejected(state, request, 'too-many-tables')
      }

      let canonicalName: string
      if (typeof request.name === 'string' && request.name.trim().length > 0) {
        const proposed = request.name.trim()
        const code = validateTableName(state, proposed, null)
        if (code) return tableRejected(state, request, code)
        canonicalName = proposed
      } else {
        canonicalName = nextAutoTableName(state)
      }

      const columns = deriveTableColumnNames(state, request.sheetId, range)
      state.tablesByKey.set(canonicalName.toUpperCase(), {
        canonicalName,
        sheetId: request.sheetId,
        range: cloneRange(range),
        hasHeaders: true,
        hasTotals: false,
        columns,
      })
      state.revision = bumpRevision(state.revision)
      return {
        kind: 'create-table',
        applied: true,
        name: canonicalName,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async renameTable(request: RenameTableRequest): Promise<TableMutationResult> {
      const oldKey = request.name.toUpperCase()
      const entry = state.tablesByKey.get(oldKey)
      if (!entry) return tableRejected(state, request, 'not-found')
      const newName = request.newName.trim()
      const code = validateTableName(state, newName, oldKey)
      if (code) return tableRejected(state, request, code)

      entry.canonicalName = newName
      state.tablesByKey.delete(oldKey)
      state.tablesByKey.set(newName.toUpperCase(), entry)
      // Rewrite `OldName[...]` → `NewName[...]` across every sheet so existing
      // structured references keep resolving (design §4.3).
      rewriteTableRefsAcrossWorkbook(state, {
        kind: 'rename-table',
        fromUpper: oldKey,
        to: newName,
      })
      state.revision = bumpRevision(state.revision)
      return {
        kind: 'table-mutation',
        applied: true,
        name: newName,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async renameTableColumn(request: RenameTableColumnRequest): Promise<TableMutationResult> {
      if (request.newColumn.trim().length === 0) {
        return tableRejected(state, request, 'invalid-column-name')
      }
      const key = request.name.toUpperCase()
      const entry = state.tablesByKey.get(key)
      if (!entry) return tableRejected(state, request, 'not-found')
      const idx = entry.columns.findIndex(
        (c) => c.toLowerCase() === request.oldColumn.toLowerCase(),
      )
      if (idx < 0) return tableRejected(state, request, 'column-not-found')
      if (
        entry.columns.some(
          (c, i) => i !== idx && c.toLowerCase() === request.newColumn.toLowerCase(),
        )
      ) {
        return tableRejected(state, request, 'duplicate-column')
      }
      const oldColumn = entry.columns[idx]
      entry.columns[idx] = request.newColumn
      rewriteTableRefsAcrossWorkbook(state, {
        kind: 'rename-column',
        tableUpper: key,
        fromUpper: oldColumn.toUpperCase(),
        to: request.newColumn,
      })
      state.revision = bumpRevision(state.revision)
      return {
        kind: 'table-mutation',
        applied: true,
        name: entry.canonicalName,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async deleteTable(request: DeleteTableRequest): Promise<TableMutationResult> {
      // "Convert to range": remove the registry entry only; cell values,
      // formulas, and formats are left in place (design §4.1).
      if (!state.tablesByKey.delete(request.name.toUpperCase())) {
        return tableRejected(state, request, 'not-found')
      }
      state.revision = bumpRevision(state.revision)
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
    async listTables(request: ListTablesRequest): Promise<ListTablesResult> {
      const tables = [...state.tablesByKey.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, entry]) => tableDescriptor(state, entry))
      return {
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        tables,
      }
    },
    async getTable(request: GetTableRequest): Promise<GetTableResult> {
      const entry = state.tablesByKey.get(request.name.toUpperCase())
      return {
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        table: entry ? tableDescriptor(state, entry) : null,
      }
    },
    // --- Totals row (design-excel-table.md §7, parity #32 T6) -------------
    //
    // Semantics are the engine's, method for method: enabling grows the range
    // one row and seeds the LAST column with `=SUBTOTAL(109, Table[Col])`;
    // the row below must be empty or the call rejects `totals-row-blocked`
    // with nothing changed; disabling clears every totals cell (including
    // hand-edited ones) and shrinks back. Both are idempotent per state.
    //
    // Unlike the registry CRUD above, the CELL writes here do participate in
    // the undo timeline (the engine routes them through `set_formula` /
    // `clear_cell` for the same reason) — but the geometry/`hasTotals` flip
    // rides on the registry, which the undo delta still does not carry, so an
    // undo restores the totals cells without restoring the range. Same known
    // gap as the worker (design §11/§12).
    async setTableTotalsRow(request: SetTableTotalsRowRequest): Promise<TableMutationResult> {
      const entry = state.tablesByKey.get(request.name.toUpperCase())
      if (!entry) return tableRejected(state, request, 'not-found')

      const applied = (): TableMutationResult => ({
        kind: 'table-mutation',
        applied: true,
        name: entry.canonicalName,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      })
      // Idempotent no-op: nothing written, no revision bump.
      if (entry.hasTotals === request.enabled) return applied()

      if (request.enabled) {
        const totalsRow = entry.range.rowEnd + 1
        if (
          rangeHasContent(state, entry.sheetId, {
            rowStart: totalsRow,
            rowEnd: totalsRow,
            colStart: entry.range.colStart,
            colEnd: entry.range.colEnd,
          })
        ) {
          return tableRejected(state, request, 'totals-row-blocked')
        }
        beginUndoableMutation(state)
        // Publish the new geometry BEFORE writing the SUBTOTAL so its
        // `Table[Col]` (the `#Data` band, which now EXCLUDES the totals row)
        // resolves against current geometry on first evaluation.
        entry.range = { ...entry.range, rowEnd: totalsRow }
        entry.hasTotals = true
        if (entry.columns.length > 0) {
          writeTotalsCell(state, entry, entry.columns.length - 1, TOTALS_DEFAULT_SUBTOTAL_CODE)
        }
      } else {
        beginUndoableMutation(state)
        const cells = getOrCreateSheetCells(state, entry.sheetId)
        const totalsRow = entry.range.rowEnd
        for (let col = entry.range.colStart; col <= entry.range.colEnd; col += 1) {
          recordCellBefore(state, entry.sheetId, keyFor(totalsRow, col))
          cells.delete(keyFor(totalsRow, col))
        }
        entry.range = { ...entry.range, rowEnd: totalsRow - 1 }
        entry.hasTotals = false
      }
      state.revision = bumpRevision(state.revision)
      return applied()
    },
    async setTableTotalFunction(
      request: SetTableTotalFunctionRequest,
    ): Promise<TableMutationResult> {
      // Gate order mirrors the WASM binding: the aggregate id is parsed before
      // the engine call, so an unknown id outranks every other rejection.
      const code = TOTALS_SUBTOTAL_CODES[request.func]
      if (code === undefined) return tableRejected(state, request, 'invalid-totals-function')
      const entry = state.tablesByKey.get(request.name.toUpperCase())
      if (!entry) return tableRejected(state, request, 'not-found')
      if (!entry.hasTotals) return tableRejected(state, request, 'no-totals-row')
      const columnIndex = entry.columns.findIndex(
        (c) => c.toLowerCase() === request.column.toLowerCase(),
      )
      if (columnIndex < 0) return tableRejected(state, request, 'column-not-found')

      beginUndoableMutation(state)
      writeTotalsCell(state, entry, columnIndex, code)
      state.revision = bumpRevision(state.revision)
      return {
        kind: 'table-mutation',
        applied: true,
        name: entry.canonicalName,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
      }
    },
  }
}
