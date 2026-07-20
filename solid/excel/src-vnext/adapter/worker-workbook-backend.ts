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
  FilterSortState,
  HistoryEntryKind,
  HistoryTransactionResult,
  ImportCellChunksRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  ImportCellsRequest,
  ProjectionRevision,
  RangeTsvChunkConsumer,
  RangeTsvChunkExportResult,
  ListConditionalFormatRulesRequest,
  ListNamedRangesRequest,
  MergeRangeRequest,
  UnmergeRangeRequest,
  NamedRange,
  NamedRangeListResult,
  NamedRangeMutationResult,
  PasteRangeRequest,
  PasteRangeResult,
  PasteSpecialKind,
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
  SetEvalHiddenRowsRequest,
  SetFilterSortRequest,
  SetFormatRangeRequest,
  SetNamedRangeRequest,
  SetRowHeightRequest,
  SetValidationRuleRequest,
  SheetMutationResult,
  SortRangeRejectedResult,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
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
  TableMutationRejectedResult,
  TableMutationRejectionCode,
  TableMutationResult,
  SpreadsheetBackend,
  RedoTransactionRequest,
  UndoTransactionRequest,
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
  buildFilterSortDisplayRows,
  cloneCell,
  cloneConditionalFormatRule,
  cloneConditionalFormatRuleEntry,
  cloneFilterSortState,
  cloneFormat,
  cloneNamedRange,
  cloneRange,
  compareCellValue,
  conditionalRuleFormat,
  DEFAULT_WORKBOOK_LOCALE,
  estimateUtf8Bytes,
  evaluateValidationLocal,
  filterSortHasEffect,
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
  SUPPORTED_PASTE_SPECIAL_KINDS,
  toA1,
  validationMessageForRule,
  validationSeverityForMode,
  type RangeFormatLayer,
  getEffectiveFormat,
} from '@einfach/spreadsheet-ui-core'

import {
  createWorkerWorkbook,
  type CellFormatJSON,
  type CellFormatSnapshot,
  type CellRefWire,
  type CellSnapshotWire,
  type CellWire,
  type FormatRangeSnapshot,
  type ImportCellWire,
  type SortRangeBoundsWire,
  type SortRangePayloadWire,
  type SortRangeReportWire,
  type SparseCellWire,
  type TableJSONWire,
  type SparseRangeWire,
  type WorkerLike,
  type WorkerRuntimeCapabilitiesWire,
  type WorkerWorkbookClient,
  type WorkbookImportStatsWire,
  type WorkbookSheetMeta,
} from './worker-protocol'
import {
  applyPasteArithmetic,
  isPasteSourceBlank,
  pasteRangeGeometry,
  pasteSourceCoord,
} from './paste-range-plan'

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

/**
 * Bounded predicate scan for filter/sort visibility (parity item #29).
 *
 * The shared pure helper `buildFilterSortDisplayRows` needs the display
 * value of every data row in each predicate column (column 0 for the
 * summary-row probe, plus every filter-rule column). On the worker
 * path those values live behind RPC, so the scan must be explicitly
 * bounded: `dataRowCount x predicateColumnCount` may not exceed this cap
 * (same 50k-cell budget as `DEFAULT_MAX_PROJECTION_CELLS` and
 * `STATUS_BAR_AGGREGATE_MEMBERSHIP_CHECKS_MAX` in ui-core). Crossing it
 * is a structured rejection (`FILTER_SORT_SOURCE_TOO_LARGE`) — the
 * filter does NOT activate and nothing is silently truncated.
 */
export const MAX_FILTER_SORT_PREDICATE_CELLS = 50_000
export const FILTER_SORT_SOURCE_TOO_LARGE = 'FILTER_SORT_SOURCE_TOO_LARGE'

/**
 * Fail-closed source-size cap for engine physical sort (design-engine-sort
 * §7). The range AREA (rows × cols) upper-bounds the undo before/after
 * snapshot, so a sort whose range spans more than this many cells is
 * rejected BEFORE any read, RPC, undo record, or revision bump — silently
 * dropping undo on a high-frequency reversible op is worse than refusing
 * (contrast the structural mutation's not-undoable degradation, where the
 * op still runs). Computed geometrically from the request range so the
 * gate costs no RPC, matching the pre-dispatch geometry convention of
 * `pasteRange` and the 50k budget of `MAX_FILTER_SORT_PREDICATE_CELLS`.
 * The area is a conservative upper bound on the doc's non-empty measure:
 * it may refuse a large-but-sparse range, never admit one over budget.
 */
export const MAX_SORT_SOURCE_CELLS = 50_000

/**
 * Parity #11 paste-special fail-closed lane (defense in depth). UI-core
 * blocks format-leg kinds pre-dispatch when the adapter's
 * `pasteRangeSupportedKinds` excludes them; a request that arrives
 * anyway is rejected with this structured code BEFORE any read or
 * write — the format leg is never silently dropped.
 */
export const PASTE_RANGE_FORMATS_UNSUPPORTED = 'PASTE_RANGE_FORMATS_UNSUPPORTED'

/** Value-leg-only paste kinds offered when the runtime models no formats. */
const WORKER_PASTE_VALUE_KINDS: readonly PasteSpecialKind[] = Object.freeze(['values', 'transpose'])

/**
 * Host-orchestrated undo/redo (parity #15/#36, CANONICAL_OWNERSHIP §4).
 *
 * The adapter records one bounded transaction per undoable mutation:
 * before/after sparse images assembled from the snapshot primitives that
 * are already on the worker protocol (`snapshotRangeSparse`,
 * `snapshotFormatRange`); `undoTransaction` / `redoTransaction` replay
 * them clear-then-restore because `restoreSparse` is an ADDITIVE merge
 * (rust/wasm/src/lib.rs `restore_sparse` contract — design point A).
 *
 * Stack cap mirrors UI-core history (`DEFAULT_HISTORY_CAP = 100`):
 * UI-core evicts oldest entries at 100, so deeper adapter records are
 * unreachable anyway.
 */
export const WORKER_UNDO_STACK_CAP = 100
/**
 * Structural before-images must be FULL-SHEET non-empty snapshots —
 * shift.rs rewrites formulas that referenced a deleted band into
 * irreversible `#REF!` sentinels, so a band-scoped delta cannot restore
 * them (design point B). Threshold carried over from the legacy
 * sheet-store precedent (`STRUCTURAL_SNAPSHOT_MAX = 2000`,
 * solid/excel/src/sheet-store.ts): each structural op serializes the
 * before AND after image across the RPC boundary and up to 100 records
 * stay resident, so the cap bounds worst-case memory at
 * 100 × 2 × 2000 cells. Above the threshold the structural mutation
 * still executes but its record degrades to not-undoable — the snapshot
 * is never truncated.
 */
export const WORKER_STRUCTURAL_SNAPSHOT_MAX = 2000
/** u32 max — full-sheet sparse bound accepted by both worker runtimes. */
const FULL_SHEET_INDEX_BOUND = 0xffffffff

interface WorkerUndoImage {
  /** Sparse cells to restore; null when the mutation cannot touch values. */
  cells: SparseCellWire[] | null
  /** Format snapshot to restore; null when the mutation cannot touch formats. */
  format: FormatRangeSnapshot | null
}

/**
 * Parity #04 merge-overlay transaction payload: before/after images of
 * ONE sheet's merge-range set. Replay is a pure adapter-memory swap —
 * no engine RPC, and clear-then-restore does not apply (the record set
 * is replaced wholesale).
 */
interface WorkerMergeOverlayImage {
  sheetId: string
  before: CellRange[]
  after: CellRange[]
}

interface WorkerTransactionRecord {
  kind: HistoryEntryKind
  sheetIdx: number
  /**
   * The UI transaction id is minted AFTER the mutation acknowledges
   * (`nextHistoryTransactionId()` at push time), so the adapter cannot
   * key records by it up front. Records align positionally with UI-core
   * backend entries (static-backend precedent) and the id binds lazily
   * on the first successful undo; later undo/redo of the same record
   * must present the bound id or the request answers not-applied.
   */
  boundTransactionId: string | null
  affectedRange: CellRange | null
  /** Region cleared before restoring `cells` (clear-then-restore, design point A). */
  clearRange: SparseRangeWire | null
  /** null before/after → the record is not undoable; see `diagnostic`. */
  before: WorkerUndoImage | null
  after: WorkerUndoImage | null
  /**
   * Present when the mutation touched the #04 merge overlay. Merge /
   * unmerge records carry ONLY this payload (before/after stay null);
   * structural records carry it as a side payload next to their sparse
   * engine images so undo restores the pre-shift merge set too.
   */
  mergeOverlay?: WorkerMergeOverlayImage
  diagnostic?: string
}
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

/** CellRange → the 0-based bounds object the `sortRange` payload accepts. */
function toSortRangeBounds(range: CellRange): SortRangeBoundsWire {
  return {
    startRow: range.rowStart,
    startCol: range.colStart,
    endRow: range.rowEnd,
    endCol: range.colEnd,
  }
}

const SORT_REJECTION_CODES: readonly SortRangeRejectionCode[] = [
  'invalid-range',
  'empty-keys',
  'key-out-of-range',
  'spill-in-range',
  'invalid-payload',
  'source-too-large',
  'merge-in-range',
]

/** Guard an engine `detail.code` back onto the port's reject union. */
function normalizeSortRejectionCode(code: unknown): SortRangeRejectionCode {
  return typeof code === 'string' && (SORT_REJECTION_CODES as readonly string[]).includes(code)
    ? (code as SortRangeRejectionCode)
    : 'invalid-payload'
}

function structuralMutationResult(
  request: InsertRowsRequest | DeleteRowsRequest | InsertColumnsRequest | DeleteColumnsRequest,
  revision: ProjectionRevision,
): BackendMutationResult {
  // W3 structural-shift contract: the worker engine really displaced
  // index space, so the ACK must say so — UI-core uses it to remap its
  // canonical view facts (freeze band, hidden index sets) and to record
  // history side payloads for the displaced facts.
  const structuralShift: BackendMutationResult['structuralShift'] =
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

function rangesIntersect(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart <= right.rowEnd &&
    left.rowEnd >= right.rowStart &&
    left.colStart <= right.colEnd &&
    left.colEnd >= right.colStart
  )
}

/**
 * Parity #04 — merge metadata joins the projection last, in SOURCE
 * coordinates. Mirrors the static backend's `applyMergeMetadata`: the
 * anchor cell (when inside the window) carries `mergedSpan`, and every
 * other covered coordinate inside the window materializes (as a blank
 * cell if needed) carrying `mergeAnchor`. Cells are per-read objects on
 * this adapter, so in-place mutation cannot leak into caches.
 */
function applyMergeOverlay(
  cells: DisplayCell[],
  projectionRange: CellRange,
  mergeRanges: readonly CellRange[],
): DisplayCell[] {
  if (mergeRanges.length === 0) return cells
  const byCoord = new Map<string, DisplayCell>()
  for (const cell of cells) byCoord.set(keyFor(cell.row, cell.col), cell)

  const upsert = (row: number, col: number): DisplayCell => {
    const key = keyFor(row, col)
    let cell = byCoord.get(key)
    if (!cell) {
      cell = { row, col, displayValue: '', valueKind: 'blank' }
      byCoord.set(key, cell)
    }
    return cell
  }

  let touched = false
  for (const mergeRange of mergeRanges) {
    if (!rangesIntersect(mergeRange, projectionRange)) continue
    touched = true

    if (isCoordInsideRange(mergeRange.rowStart, mergeRange.colStart, projectionRange)) {
      const anchor = upsert(mergeRange.rowStart, mergeRange.colStart)
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
        const covered = upsert(row, col)
        delete covered.mergedSpan
        covered.mergeAnchor = { row: mergeRange.rowStart, col: mergeRange.colStart }
      }
    }
  }
  return touched ? [...byCoord.values()] : cells
}

/**
 * W3 structural displacement for the #04 merge overlay — Excel
 * semantics, ported from the static backend's `shiftMergeRanges`: an
 * insert before a merge shifts it whole, an insert strictly inside
 * extends it; a delete before it shifts it back, a partial overlap
 * shrinks it, and a delete covering the whole merge removes it. A merge
 * that shrinks to a single cell stops being a merge (a 1x1 "merge" is
 * meaningless in Excel). Mutates `ranges` in place.
 */
function shiftMergeRangeList(
  ranges: CellRange[],
  axis: 'row' | 'column',
  index: number,
  count: number,
  direction: 1 | -1,
): void {
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

function namedRangeMatches(entry: NamedRange, name: string, scope: NamedRange['scope']): boolean {
  const targetIdentity = namedRangeIdentity(name, scope)
  return targetIdentity !== null && namedRangeIdentity(entry.name, entry.scope) === targetIdentity
}

function namedRangeAddressEndpoints(address: string): { start: string; end: string } | null {
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

/** One projected row while filter/sort is active: where it renders and where it lives. */
type MappedDisplayRow = { displayRow: number; sourceRow: number }

/**
 * `range` is the coordinate space the rule ranges are compared against —
 * the display window on the plain path, the SOURCE bounding range when
 * filter/sort is active (rule scopes are source facts). `mappedRows`
 * switches the blank-cell fill from the identity row walk to the
 * display→source mapping so synthesized cells land on projected rows and
 * carry `originalRow` like every other filtered cell.
 */
function applyValidationOverlay(
  cells: DisplayCell[],
  range: CellRange,
  rules: readonly WorkerValidationRuleLayer[],
  mappedRows?: readonly MappedDisplayRow[],
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

    const colStart = Math.max(range.colStart, layer.range.colStart)
    const colEnd = Math.min(range.colEnd, layer.range.colEnd)
    const blankValidation = () => ({
      code: `validation.${layer.rule.kind}`,
      severity: validationSeverityForMode(layer.mode),
      message: validationMessageForRule(layer.rule),
    })

    if (mappedRows) {
      for (const { displayRow, sourceRow } of mappedRows) {
        if (sourceRow < layer.range.rowStart || sourceRow > layer.range.rowEnd) continue
        for (let col = colStart; col <= colEnd; col += 1) {
          const key = keyFor(displayRow, col)
          if (byDisplay.has(key)) continue
          byDisplay.set(key, {
            row: displayRow,
            col,
            displayValue: '',
            valueKind: 'blank',
            originalRow: sourceRow,
            validation: blankValidation(),
          })
        }
      }
      continue
    }

    const rowStart = Math.max(range.rowStart, layer.range.rowStart)
    const rowEnd = Math.min(range.rowEnd, layer.range.rowEnd)
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const key = keyFor(row, col)
        if (byDisplay.has(key)) continue
        byDisplay.set(key, {
          row,
          col,
          displayValue: '',
          valueKind: 'blank',
          validation: blankValidation(),
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

/** Truthful overlay for runtimes that model no formats (`formatSnapshots: false`). */
function emptyFormatRangeSnapshot(range: SparseRangeWire): FormatRangeSnapshot {
  return {
    sheet: range.sheet,
    startRow: range.startRow,
    startCol: range.startCol,
    endRow: range.endRow,
    endCol: range.endCol,
    cellFormats: [],
    rangeFormats: [],
  }
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

function boundingRangeOfImportCells(
  cells: readonly { row: number; col: number }[],
): CellRange | null {
  let range: CellRange | null = null
  for (const cell of cells) {
    if (!Number.isInteger(cell.row) || !Number.isInteger(cell.col)) continue
    if (cell.row < 0 || cell.col < 0) continue
    if (range === null) {
      range = { rowStart: cell.row, rowEnd: cell.row, colStart: cell.col, colEnd: cell.col }
    } else {
      range.rowStart = Math.min(range.rowStart, cell.row)
      range.rowEnd = Math.max(range.rowEnd, cell.row)
      range.colStart = Math.min(range.colStart, cell.col)
      range.colEnd = Math.max(range.colEnd, cell.col)
    }
  }
  return range
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
  // Adapter host-overlay metadata (data validation, conditional format, merge,
  // named ranges) lives on the main thread: neither engine models these facts.
  // CANONICAL_OWNERSHIP (2026-07-19) transposed this pattern from "temporary
  // until the Rust workbook grows native support" to the sanctioned final form
  // for the overlay-class items (#04 merge, #21 conditional format, #22
  // validation rule storage) — the contract shape stays backend-canonical
  // while the facts live here.
  const validationRulesBySheetId = new Map<string, WorkerValidationRuleLayer[]>()
  const conditionalFormatRulesBySheetId = new Map<string, ConditionalFormatRuleEntry[]>()
  /**
   * Parity #04 — merge/unmerge on the worker path (adapter host-overlay).
   * The contract shape stays backend canonical (`DisplayCell.mergedSpan`
   * / `mergeAnchor` in projections, `mergeRange` / `unmergeRange` ports
   * with exact ACKs) while the merge facts live in this main-thread Map;
   * neither engine models merges and, per CANONICAL_OWNERSHIP, this
   * overlay is the sanctioned landing shape — not a stopgap.
   *
   * SESSION-ONLY boundary: persistence v1 snapshots do not carry merge
   * ranges, so workbook save/restore drops them by design (consistent
   * with the overlay definition — same boundary as the validation and
   * conditional-format overlays above). Bounded by sheet count × merges
   * per sheet; structural insert/delete remaps entries in place via
   * `shiftMergeRangeList` (W3 semantics) and undo/redo replays the
   * per-mutation before/after images recorded on the transaction log.
   */
  const mergeRangesBySheetId = new Map<string, CellRange[]>()
  /**
   * Parity item #29 (filter visibility = UI-core view fact). UI-core's
   * `filterSortStateAtom` is the canonical rule store; this Map is the
   * adapter's projection-side MIRROR of the last ACKed `setFilterSort`
   * payload — never read back by the UI, never a second truth source.
   * Bounded by the workbook's sheet count; rule payload size is bounded
   * upstream by ui-core normalization (`MAX_FILTER_LIST_VALUES`).
   */
  const filterSortStateBySheetId = new Map<string, FilterSortState>()
  /**
   * Computed display-row permutations (one entry per sheet with an
   * active filter, array length <= data extent, itself bounded by
   * MAX_FILTER_SORT_PREDICATE_CELLS / predicate columns). Invalidated
   * wholesale by `bumpRevision()` — every acknowledged mutation and
   * every worker `cellsDirty` push routes through it — so the next
   * projection read recomputes from fresh engine values.
   */
  const filterSortDisplayRowsBySheetId = new Map<string, number[]>()
  /**
   * Bounded host-orchestrated undo/redo transaction log (cap
   * `WORKER_UNDO_STACK_CAP`, oldest dropped). One record per undoable
   * mutation, aligned positionally with the UI-core history stack's
   * backend entries. Cleared wholesale when sheet indices shift
   * (deleteSheet / reorderSheet — design point D): records address
   * sheets by positional index and a stale index would replay into the
   * wrong sheet.
   */
  const undoRecords: WorkerTransactionRecord[] = []
  const redoRecords: WorkerTransactionRecord[] = []
  let namedRanges: NamedRange[] = []
  let namedRangeMutationTail: Promise<void> = Promise.resolve()
  /**
   * Fail-closed capability witness declared by the worker runtime itself
   * (see `WorkerRuntimeCapabilitiesWire`). `null` means the runtime made
   * no claims — either it predates the `describeCapabilities` handshake
   * (the WASM runtime answers UNKNOWN_COMMAND) or the client double does
   * not implement the method — and the adapter keeps the legacy
   * full-trust contract so the WASM path is behaviorally unchanged.
   * Until the handshake resolves the value stays `null` (full trust);
   * capability-gated ports are getters, so post-`ready()` reads see the
   * declared witness.
   */
  let runtimeCapabilities: WorkerRuntimeCapabilitiesWire | null = null
  const readyPromise = client
    .initWorkbook(sheetInputs.map((sheet) => sheet.name))
    .then(async (metas) => {
      lookup = buildSheetLookup(sheetInputs, metas)
      runtimeCapabilities = (await client.describeCapabilities?.()) ?? null
      await options.afterInit?.(client, lookup.sheets)
      return lookup.sheets
    })

  /**
   * `null` witness → legacy full trust. A declared witness gates each
   * family, and undeclared keys on a declared witness read as
   * unsupported (fail-closed).
   */
  function runtimeSupports(key: keyof WorkerRuntimeCapabilitiesWire): boolean {
    return runtimeCapabilities === null || runtimeCapabilities[key] === true
  }

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
    // Conservative filter/sort invalidation: any acknowledged mutation
    // (and any worker-initiated cellsDirty push — the onCellsDirty
    // handler calls bumpRevision) may change predicate values, so drop
    // every cached display-row permutation. The rule mirror survives;
    // the permutation is recomputed on the next projection read.
    filterSortDisplayRowsBySheetId.clear()
    if (typeof revision === 'number' && Number.isFinite(revision)) {
      revision += 1
    }
    return revision
  }

  // --- host-orchestrated undo/redo helpers -------------------------------

  function pushTransactionRecord(record: WorkerTransactionRecord): void {
    undoRecords.push(record)
    if (undoRecords.length > WORKER_UNDO_STACK_CAP) {
      undoRecords.shift()
    }
    // A new mutation invalidates all forward history, mirroring
    // pushHistoryAtom truncating the UI-core redo tail.
    redoRecords.length = 0
  }

  function dropTransactionRecords(): void {
    undoRecords.length = 0
    redoRecords.length = 0
  }

  function notUndoableRecord(
    kind: HistoryEntryKind,
    sheetIdx: number,
    affectedRange: CellRange | null,
    diagnostic: string,
  ): WorkerTransactionRecord {
    return {
      kind,
      sheetIdx,
      boundTransactionId: null,
      affectedRange: affectedRange ? { ...affectedRange } : null,
      clearRange: null,
      before: null,
      after: null,
      diagnostic,
    }
  }

  async function captureUndoImage(
    range: SparseRangeWire,
    capture: { values: boolean; formats: boolean },
  ): Promise<WorkerUndoImage> {
    const cells = capture.values ? await client.snapshotRangeSparse(range) : null
    const format = capture.formats ? await client.snapshotFormatRange(range) : null
    return { cells, format }
  }

  /**
   * Record one undoable cell-scoped mutation: capture the before-image,
   * run the mutation, capture the after-image, push the bounded record.
   * Snapshot failures NEVER block the mutation — the record degrades to
   * not-undoable with a diagnostic instead. A mutation that throws
   * records nothing (the UI dispatcher does not push an entry either, so
   * the two stacks stay aligned).
   */
  async function recordCellMutation<T>(spec: {
    kind: HistoryEntryKind
    sheet: WorkerWorkbookBackendSheet
    range: CellRange | null
    captureValues: boolean
    captureFormats: boolean
    missingRangeDiagnostic?: string
    execute: () => Promise<T>
    /**
     * Post-execute predicate: return false to record NOTHING (the mutation
     * turned out to be an identity no-op, so an undo entry here would skew
     * the host↔worker stack alignment — UI-core pushes no history entry for
     * a no-op either). Nothing was mutated, so there is no cleanup to do.
     */
    shouldRecord?: (result: T) => boolean
  }): Promise<T> {
    if (spec.range === null) {
      const result = await spec.execute()
      pushTransactionRecord(
        notUndoableRecord(
          spec.kind,
          spec.sheet.idx,
          null,
          spec.missingRangeDiagnostic ?? 'mutation carried no affected range for the undo snapshot',
        ),
      )
      return result
    }
    if (spec.captureFormats && !runtimeSupports('formatSnapshots')) {
      // The mutation WILL change formats but the runtime cannot snapshot
      // them — recording values only would make undo lie about formats.
      const result = await spec.execute()
      pushTransactionRecord(
        notUndoableRecord(
          spec.kind,
          spec.sheet.idx,
          spec.range,
          'runtime does not implement format snapshots; format-touching mutation is not undoable',
        ),
      )
      return result
    }

    const sparse = toSparseRange(spec.sheet.idx, spec.range)
    const capture = { values: spec.captureValues, formats: spec.captureFormats }
    let before: WorkerUndoImage | null = null
    let diagnostic = ''
    try {
      before = await captureUndoImage(sparse, capture)
    } catch (error) {
      diagnostic = `undo before-image snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
    const result = await spec.execute()
    if (spec.shouldRecord && !spec.shouldRecord(result)) {
      // Identity no-op: nothing changed, so record nothing (regardless of
      // whether the before-image was captured — there is nothing to undo).
      return result
    }
    if (before === null) {
      pushTransactionRecord(notUndoableRecord(spec.kind, spec.sheet.idx, spec.range, diagnostic))
      return result
    }
    let after: WorkerUndoImage | null = null
    try {
      after = await captureUndoImage(sparse, capture)
    } catch (error) {
      diagnostic = `redo after-image snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
    pushTransactionRecord(
      after !== null
        ? {
            kind: spec.kind,
            sheetIdx: spec.sheet.idx,
            boundTransactionId: null,
            affectedRange: { ...spec.range },
            clearRange: spec.captureValues ? sparse : null,
            before,
            after,
          }
        : notUndoableRecord(spec.kind, spec.sheet.idx, spec.range, diagnostic),
    )
    return result
  }

  /**
   * Record one structural mutation (insert/delete rows/columns,
   * removeRows). Design point B: the before-image must be the FULL-SHEET
   * non-empty snapshot — `#REF!` sentinel rewrites are irreversible — and
   * a sheet whose non-empty count exceeds `WORKER_STRUCTURAL_SNAPSHOT_MAX`
   * degrades the record to not-undoable (never a truncated snapshot).
   * Engine structural shifts move cells and formulas only (formats and
   * dimension maps are not part of the sparse image; formats are not
   * shifted by the engine, and sizes are UI-core canonical view facts),
   * so the image is values/formulas only.
   */
  async function recordStructuralMutation<T>(spec: {
    kind: HistoryEntryKind
    sheet: WorkerWorkbookBackendSheet
    /** Host-overlay key: the #04 merge before/after images ride along the record. */
    sheetId: string
    execute: () => Promise<T>
  }): Promise<T> {
    const fullRange: SparseRangeWire = {
      sheet: spec.sheet.idx,
      startRow: 0,
      startCol: 0,
      endRow: FULL_SHEET_INDEX_BOUND,
      endCol: FULL_SHEET_INDEX_BOUND,
    }
    let before: SparseCellWire[] | null = null
    let diagnostic = ''
    try {
      const nonEmpty = await client.listNonEmpty()
      let count = 0
      for (const ref of nonEmpty) {
        if (ref.sheet === spec.sheet.idx) count += 1
      }
      if (count > WORKER_STRUCTURAL_SNAPSHOT_MAX) {
        diagnostic =
          `structural before-image needs ${count} non-empty cells but the cap is ` +
          `${WORKER_STRUCTURAL_SNAPSHOT_MAX}; the operation is not undoable`
      } else {
        before = await client.snapshotRangeSparse(fullRange)
        if (before.length > WORKER_STRUCTURAL_SNAPSHOT_MAX) {
          diagnostic =
            `structural before-image produced ${before.length} cells over the cap ` +
            `${WORKER_STRUCTURAL_SNAPSHOT_MAX}; the operation is not undoable`
          before = null
        }
      }
    } catch (error) {
      diagnostic = `structural undo snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`
      before = null
    }
    // #04 side payload: `execute` remaps the merge overlay right after
    // the engine shift ACKs, so the before-image is captured here and
    // the after-image post-execute. Pure adapter memory — no RPC, never
    // a reason to degrade the record.
    const mergeBefore = (mergeRangesBySheetId.get(spec.sheetId) ?? []).map(cloneRange)
    const result = await spec.execute()
    const mergeAfter = (mergeRangesBySheetId.get(spec.sheetId) ?? []).map(cloneRange)
    const mergeOverlay =
      mergeBefore.length > 0 || mergeAfter.length > 0
        ? { sheetId: spec.sheetId, before: mergeBefore, after: mergeAfter }
        : undefined
    if (before === null) {
      pushTransactionRecord(notUndoableRecord(spec.kind, spec.sheet.idx, null, diagnostic))
      return result
    }
    let after: SparseCellWire[] | null = null
    try {
      after = await client.snapshotRangeSparse(fullRange)
      if (after.length > WORKER_STRUCTURAL_SNAPSHOT_MAX) {
        diagnostic =
          `structural after-image produced ${after.length} cells over the cap ` +
          `${WORKER_STRUCTURAL_SNAPSHOT_MAX}; the operation degraded to not-undoable`
        after = null
      }
    } catch (error) {
      diagnostic = `structural redo snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
    pushTransactionRecord(
      after !== null
        ? {
            kind: spec.kind,
            sheetIdx: spec.sheet.idx,
            boundTransactionId: null,
            affectedRange: null,
            clearRange: fullRange,
            before: { cells: before, format: null },
            after: { cells: after, format: null },
            ...(mergeOverlay ? { mergeOverlay } : {}),
          }
        : notUndoableRecord(spec.kind, spec.sheet.idx, null, diagnostic),
    )
    return result
  }

  function historyNotApplied(
    request: UndoTransactionRequest | RedoTransactionRequest,
    reason: string,
  ): HistoryTransactionResult {
    return {
      transactionId: request.transactionId,
      requestId: request.requestId,
      revision,
      applied: false,
      notAppliedReason: reason,
    }
  }

  async function replayUndoImage(
    record: WorkerTransactionRecord,
    image: WorkerUndoImage,
  ): Promise<void> {
    // Design point A: restoreSparse is an ADDITIVE merge, so the
    // affected region must be cleared first or a delete/overwrite undo
    // leaves residue behind.
    if (image.cells !== null && record.clearRange !== null) {
      await client.clearRange(record.clearRange)
      if (image.cells.length > 0) {
        await client.restoreSparse(image.cells)
      }
    }
    // restore_format_range_snapshot REPLACES per-cell formats inside the
    // snapshot range and the whole range-layer list — self-clearing, no
    // pre-clear needed.
    if (image.format !== null) {
      await client.restoreFormatSnapshot(image.format)
    }
  }

  /**
   * Design point C: no strict revision precondition — engine-initiated
   * revision bumps (async custom-formula settles) between the recorded
   * mutation and its undo are legal, so `request.revision` is never
   * compared against the adapter's counter. The acknowledgement carries
   * the ACTUAL post-replay revision, which UI-core commits as the new
   * witness. Unknown transactionId / missing snapshot answer a
   * structured not-applied instead of a fake success or a bare throw.
   */
  async function runHistoryTransaction(
    action: 'undo' | 'redo',
    request: UndoTransactionRequest | RedoTransactionRequest,
  ): Promise<HistoryTransactionResult> {
    await readyPromise
    const source = action === 'undo' ? undoRecords : redoRecords
    const target = action === 'undo' ? redoRecords : undoRecords
    const record = source[source.length - 1]
    if (!record) {
      return historyNotApplied(request, `no recorded backend transaction to ${action}`)
    }
    if (record.boundTransactionId !== null && record.boundTransactionId !== request.transactionId) {
      return historyNotApplied(request, `unknown transactionId: ${request.transactionId}`)
    }
    if ((record.before === null || record.after === null) && !record.mergeOverlay) {
      return historyNotApplied(
        request,
        record.diagnostic ?? 'transaction was recorded as not undoable',
      )
    }
    if (record.before !== null && record.after !== null) {
      const image = action === 'undo' ? record.before : record.after
      // Replay failures propagate as thrown errors: the workbook may be
      // half-restored, which is exactly the outcome-unknown lane.
      await replayUndoImage(record, image)
    }
    if (record.mergeOverlay) {
      // #04 merge overlay: pure adapter-memory swap of the sheet's merge
      // set (whole-set restore — clear-then-restore does not apply). For
      // structural records this runs AFTER the engine image replay so a
      // failed engine replay never half-applies the overlay side.
      const ranges = action === 'undo' ? record.mergeOverlay.before : record.mergeOverlay.after
      mergeRangesBySheetId.set(record.mergeOverlay.sheetId, ranges.map(cloneRange))
    }
    record.boundTransactionId = request.transactionId
    source.pop()
    target.push(record)
    const nextRevision = bumpRevision()
    return {
      transactionId: request.transactionId,
      requestId: request.requestId,
      revision: nextRevision,
      ...(record.affectedRange ? { affectedRange: { ...record.affectedRange } } : {}),
    }
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
   * `mergeRangesBySheetId`, `filterSortStateBySheetId`,
   * `filterSortDisplayRowsBySheetId`, and the sheet-scoped entries of
   * `namedRanges`.
   */
  function dropSheetOverlayState(sheetId: string): void {
    validationRulesBySheetId.delete(sheetId)
    conditionalFormatRulesBySheetId.delete(sheetId)
    mergeRangesBySheetId.delete(sheetId)
    filterSortStateBySheetId.delete(sheetId)
    filterSortDisplayRowsBySheetId.delete(sheetId)
    namedRanges = namedRanges.filter(
      (item) => item.scope === 'workbook' || item.scope.sheetId !== sheetId,
    )
  }

  /**
   * W3 remap of the #04 merge overlay after an ACKed structural shift.
   * The engine has already displaced index space; the overlay's source
   * coordinates must follow or every merge south/east of the band would
   * render one band off.
   */
  function shiftMergeOverlay(
    sheetId: string,
    axis: 'row' | 'column',
    index: number,
    count: number,
    direction: 1 | -1,
  ): void {
    const ranges = mergeRangesBySheetId.get(sheetId)
    if (!ranges || ranges.length === 0) return
    shiftMergeRangeList(ranges, axis, index, count, direction)
  }

  /**
   * Parity #04 — shared core of the `mergeRange` / `unmergeRange` ports.
   * Excel semantics mirror the static backend exactly: both ops first
   * drop every merge intersecting the requested range; merge then adds
   * the normalized range back when it spans more than one cell (a 1x1
   * "merge" is meaningless). The transaction record carries before/after
   * images of the sheet's merge set — pure adapter memory, no engine RPC
   * — and the exact ACK echoes kind/requestId/affectedRange so the
   * UI-core strict validator can walk local-ack → refresh → ready.
   */
  function applyMergeOverlayMutation(
    request: MergeRangeRequest | UnmergeRangeRequest,
    sheet: WorkerWorkbookBackendSheet,
  ): ToolbarBackendMutationResult {
    const range = normalizeRange(request.range)
    const current = mergeRangesBySheetId.get(request.sheetId) ?? []
    const before = current.map(cloneRange)
    const next = current.filter((candidate) => !rangesIntersect(candidate, range))
    if (
      request.kind === 'merge-range' &&
      (range.rowEnd > range.rowStart || range.colEnd > range.colStart)
    ) {
      next.push(cloneRange(range))
    }
    mergeRangesBySheetId.set(request.sheetId, next)
    pushTransactionRecord({
      kind: request.kind === 'merge-range' ? 'range.merge' : 'range.unmerge',
      sheetIdx: sheet.idx,
      boundTransactionId: null,
      affectedRange: cloneRange(range),
      clearRange: null,
      before: null,
      after: null,
      mergeOverlay: {
        sheetId: request.sheetId,
        before,
        after: next.map(cloneRange),
      },
    })
    const nextRevision = bumpRevision()
    return {
      kind: request.kind,
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? nextRevision,
      affectedRange: cloneRange(range),
    }
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

  /** Column 0 (summary-row probe) plus every filter-rule column. */
  function filterSortPredicateColumns(state: FilterSortState): number[] {
    const cols = new Set<number>([0])
    for (const rule of state.rules) cols.add(rule.colIndex)
    return [...cols]
  }

  /**
   * Bounded predicate scan + shared pure permutation. Mirrors the static
   * backend exactly (headerRow 0, data rows 1..maxRow, summary-row
   * pass-through) but reads engine display values over existing RPCs:
   * `listNonEmpty` as the exact per-sheet extent probe, then ONE
   * `readSparseRange` per predicate column, all inside the declared
   * MAX_FILTER_SORT_PREDICATE_CELLS budget. Over-budget sources reject
   * with a structured error instead of truncating.
   */
  async function computeFilterSortDisplayRows(
    sheet: WorkerWorkbookBackendSheet,
    state: FilterSortState,
  ): Promise<number[]> {
    const cols = filterSortPredicateColumns(state)
    const refs = await client.listNonEmpty()
    let maxRow = -1
    for (const ref of refs) {
      if (ref.sheet !== sheet.idx) continue
      const coord = parseA1(ref.addr)
      if (coord && coord.row > maxRow) maxRow = coord.row
    }
    const rowCount = maxRow + 1
    const predicateCells = rowCount * cols.length
    if (predicateCells > MAX_FILTER_SORT_PREDICATE_CELLS) {
      throw createBackendError(
        FILTER_SORT_SOURCE_TOO_LARGE,
        `filter/sort predicate scan needs ${predicateCells} cells (${rowCount} rows x ` +
          `${cols.length} columns) but the adapter cap is ${MAX_FILTER_SORT_PREDICATE_CELLS}; ` +
          'filter and sort were not applied',
      )
    }

    const values = new Map<string, string>()
    if (rowCount > 0) {
      await Promise.all(
        cols.map(async (col) => {
          const snapshots = await client.readSparseRange({
            sheet: sheet.idx,
            startRow: 0,
            endRow: maxRow,
            startCol: col,
            endCol: col,
          })
          for (const snapshot of snapshots) {
            const coord = parseA1(snapshot.addr)
            if (coord) values.set(keyFor(coord.row, coord.col), snapshot.display)
          }
        }),
      )
    }

    return (
      buildFilterSortDisplayRows(
        state,
        { headerRow: 0, startRow: 1, endRow: rowCount },
        (row, col) => values.get(keyFor(row, col)) ?? '',
      ) ?? []
    )
  }

  /** `null` when no filter/sort is active for the sheet; cached permutation otherwise. */
  async function activeFilterSortDisplayRows(
    sheetId: string,
    sheet: WorkerWorkbookBackendSheet,
  ): Promise<number[] | null> {
    const state = filterSortStateBySheetId.get(sheetId)
    if (!state) return null
    const cached = filterSortDisplayRowsBySheetId.get(sheetId)
    if (cached) return cached
    const displayRows = await computeFilterSortDisplayRows(sheet, state)
    filterSortDisplayRowsBySheetId.set(sheetId, displayRows)
    return displayRows
  }

  /**
   * Projection read while filter/sort is active. Display rows in the
   * requested window remap through the permutation to source rows; the
   * cell fetch is a `readCells` batch bounded by the window itself
   * (window rows x window cols refs), formats/validation/conditional
   * overlays resolve against SOURCE coordinates, and every emitted cell
   * carries `originalRow` so the ui-core mutation gateway can map edits
   * back to source rows.
   */
  async function readFilteredRange(
    sheetId: string,
    sheet: WorkerWorkbookBackendSheet,
    range: CellRange,
    displayRows: readonly number[],
    requestRevision?: ProjectionRevision,
  ): Promise<{ cells: DisplayCell[]; revision?: ProjectionRevision }> {
    const mapped: MappedDisplayRow[] = []
    for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
      const sourceRow = displayRows[row]
      if (sourceRow !== undefined) mapped.push({ displayRow: row, sourceRow })
    }
    if (mapped.length === 0) {
      return { cells: [], revision: requestRevision ?? revision }
    }

    let minSourceRow = mapped[0].sourceRow
    let maxSourceRow = mapped[0].sourceRow
    for (const { sourceRow } of mapped) {
      if (sourceRow < minSourceRow) minSourceRow = sourceRow
      if (sourceRow > maxSourceRow) maxSourceRow = sourceRow
    }
    const sourceRange: CellRange = {
      rowStart: minSourceRow,
      rowEnd: maxSourceRow,
      colStart: range.colStart,
      colEnd: range.colEnd,
    }

    const refs: CellRefWire[] = []
    for (const { sourceRow } of mapped) {
      for (let col = range.colStart; col <= range.colEnd; col += 1) {
        refs.push({ sheet: sheet.idx, addr: toA1(sourceRow, col) })
      }
    }

    const sparseSourceRange = toSparseRange(sheet.idx, sourceRange)
    const [snapshots, formatSnapshot] = await Promise.all([
      client.readCells(refs),
      runtimeSupports('formatSnapshots')
        ? client.snapshotFormatRange(sparseSourceRange)
        : Promise.resolve(emptyFormatRangeSnapshot(sparseSourceRange)),
    ])

    const sourceCells = new Map<string, DisplayCell>()
    for (const snapshot of snapshots) {
      const cell = snapshotToDisplayCell(snapshot)
      if (cell) sourceCells.set(keyFor(cell.row, cell.col), cell)
    }

    const { cellFormats, rangeFormats } = preprocessFormatSnapshot(formatSnapshot)
    const cells: DisplayCell[] = []
    for (const { displayRow, sourceRow } of mapped) {
      for (let col = range.colStart; col <= range.colEnd; col += 1) {
        const source = sourceCells.get(keyFor(sourceRow, col))
        const format = getEffectiveFormat(sourceRow, col, cellFormats, rangeFormats)
        if (source) {
          const cell = cloneCell(source)
          cell.row = displayRow
          cell.originalRow = sourceRow
          if (format) cell.format = format
          cells.push(cell)
        } else if (format) {
          cells.push({
            row: displayRow,
            col,
            displayValue: '',
            valueKind: 'blank',
            format,
            originalRow: sourceRow,
          })
        }
      }
    }

    const numberFormattedCells = applyNumberFormatsToCells(cells)
    const validatedCells = applyValidationOverlay(
      numberFormattedCells,
      sourceRange,
      validationRulesBySheetId.get(sheetId) ?? [],
      mapped,
    )

    // Parity #04 × #29: merge metadata is intentionally ABSENT while
    // filter/sort is active. Merge coordinates are SOURCE facts but the
    // filtered projection emits a permuted row space — a span drawn
    // across non-adjacent surviving rows would be a lie. The static
    // backend disables merge projection under an active filter
    // (`filterSortActive ? [] : mergeRanges`); this path matches it.
    return {
      cells: applyConditionalFormatOverlay(
        validatedCells,
        conditionalFormatRulesBySheetId.get(sheetId) ?? [],
        sourceRange,
      ).sort((left, right) =>
        left.row === right.row ? left.col - right.col : left.row - right.row,
      ),
      revision: requestRevision ?? revision,
    }
  }

  async function readRange(
    sheetId: string,
    range: CellRange,
    requestRevision?: ProjectionRevision,
  ): Promise<{ cells: DisplayCell[]; revision?: ProjectionRevision }> {
    const sheet = await resolveSheet(sheetId)
    const filterSortDisplayRows = await activeFilterSortDisplayRows(sheetId, sheet)
    if (filterSortDisplayRows !== null) {
      return readFilteredRange(sheetId, sheet, range, filterSortDisplayRows, requestRevision)
    }
    const sparseRange = toSparseRange(sheet.idx, range)
    const [snapshots, formatSnapshot] = await Promise.all([
      client.readSparseRange(sparseRange),
      // Runtimes that declare `formatSnapshots: false` model no formats
      // at all, so the truthful overlay is empty — never ask them to
      // fake a snapshot success shape.
      runtimeSupports('formatSnapshots')
        ? client.snapshotFormatRange(sparseRange)
        : Promise.resolve(emptyFormatRangeSnapshot(sparseRange)),
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

    const conditionalCells = applyConditionalFormatOverlay(
      validatedCells,
      conditionalFormatRulesBySheetId.get(sheetId) ?? [],
      range,
    )
    // #04 merge overlay joins last (source coordinates == display
    // coordinates on this plain path; the filtered path above skips
    // merges entirely, mirroring the static backend).
    return {
      cells: applyMergeOverlay(
        conditionalCells,
        range,
        mergeRangesBySheetId.get(sheetId) ?? [],
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

    // Chunked sessions are only used when the runtime really streams
    // them (`tsvChunkExport`); otherwise fall back to the single-shot
    // 'exportRangeTsv' command, which honest runtimes DO implement —
    // the old TS-runtime chunk stub silently exported empty strings.
    if (
      typeof client.consumeExportRangeTsvChunks === 'function' &&
      runtimeSupports('tsvChunkExport')
    ) {
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

    return recordCellMutation({
      kind: 'cells.import',
      sheet,
      range: request.range ? { ...request.range } : null,
      captureValues: true,
      captureFormats: false,
      missingRangeDiagnostic:
        'import request carried no affected range; the undo snapshot cannot be bounded',
      execute: async () => {
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
      },
    })
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

    // Partial failure throws out of `execute`, so no transaction record
    // is pushed — mirroring the remove-duplicates dispatcher, which does
    // not push a history entry on the failure path either. The lifecycle
    // there lands on outcome-unknown and the user reconciles.
    return recordStructuralMutation({
      kind: 'row.delete',
      sheet,
      sheetId: request.sheetId,
      execute: () => removeRowsBands(request, sheet, unique),
    })
  }

  async function removeRowsBands(
    request: RemoveRowsRequest,
    sheet: WorkerWorkbookBackendSheet,
    unique: number[],
  ): Promise<RemoveRowsResult> {
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
        // Bands run bottom-up, so shifting the #04 merge overlay per
        // accepted band composes exactly like the static backend's
        // per-row descending remap: lower bands keep their original
        // coordinates until their own turn. On partial failure the
        // overlay matches the bands the engine really deleted.
        shiftMergeOverlay(request.sheetId, 'row', band.startRow, band.count, -1)
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

  // Capability-gated port implementations. Exposed through getters below
  // so a runtime that declares `structuralEdits: false` / `formats: false`
  // in the `describeCapabilities` handshake makes the optional port read
  // as `undefined` — UI core then hides the matching entries (the same
  // fail-closed degradation the removeRowsExact witness uses).
  async function insertRowsThroughWorker(
    request: InsertRowsRequest,
  ): Promise<BackendMutationResult> {
    const sheet = await resolveSheet(request.sheetId)
    return recordStructuralMutation({
      kind: 'row.insert',
      sheet,
      sheetId: request.sheetId,
      execute: async () => {
        await client.insertRows(sheet.idx, request.rowIndex, request.count)
        shiftMergeOverlay(request.sheetId, 'row', request.rowIndex, request.count, 1)
        return structuralMutationResult(request, bumpRevision())
      },
    })
  }

  async function deleteRowsThroughWorker(
    request: DeleteRowsRequest,
  ): Promise<BackendMutationResult> {
    const sheet = await resolveSheet(request.sheetId)
    return recordStructuralMutation({
      kind: 'row.delete',
      sheet,
      sheetId: request.sheetId,
      execute: async () => {
        await client.deleteRows(sheet.idx, request.rowIndex, request.count)
        shiftMergeOverlay(request.sheetId, 'row', request.rowIndex, request.count, -1)
        return structuralMutationResult(request, bumpRevision())
      },
    })
  }

  async function insertColumnsThroughWorker(
    request: InsertColumnsRequest,
  ): Promise<BackendMutationResult> {
    const sheet = await resolveSheet(request.sheetId)
    return recordStructuralMutation({
      kind: 'column.insert',
      sheet,
      sheetId: request.sheetId,
      execute: async () => {
        await client.insertColumns(sheet.idx, request.colIndex, request.count)
        shiftMergeOverlay(request.sheetId, 'column', request.colIndex, request.count, 1)
        return structuralMutationResult(request, bumpRevision())
      },
    })
  }

  async function deleteColumnsThroughWorker(
    request: DeleteColumnsRequest,
  ): Promise<BackendMutationResult> {
    const sheet = await resolveSheet(request.sheetId)
    return recordStructuralMutation({
      kind: 'column.delete',
      sheet,
      sheetId: request.sheetId,
      execute: async () => {
        await client.deleteColumns(sheet.idx, request.colIndex, request.count)
        shiftMergeOverlay(request.sheetId, 'column', request.colIndex, request.count, -1)
        return structuralMutationResult(request, bumpRevision())
      },
    })
  }

  async function setFormatRangeThroughWorker(
    request: SetFormatRangeRequest,
  ): Promise<ToolbarBackendMutationResult> {
    const sheet = await resolveSheet(request.sheetId)
    return recordCellMutation({
      kind: 'format.set',
      sheet,
      range: { ...request.range },
      captureValues: false,
      captureFormats: true,
      execute: async () => {
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
    })
  }

  /**
   * Parity #11 — Paste Special on the worker path, adapter composition
   * (no new engine primitive). Source values/formats are read over
   * existing RPCs, the shared pure helpers in `paste-range-plan.ts`
   * (the same module the static reference implementation runs) compute
   * the patch, then values land through ONE direct import session and
   * formats through a target-rectangle format-snapshot restore.
   */
  function workerPasteRangeSupportedKinds(): readonly PasteSpecialKind[] {
    // The format leg needs BOTH families: `formats` to persist writes
    // and `formatSnapshots` to read source effective formats and to
    // capture the undo images. The TS runtime declares both false, so
    // it only offers the value-leg kinds.
    return runtimeSupports('formats') && runtimeSupports('formatSnapshots')
      ? SUPPORTED_PASTE_SPECIAL_KINDS
      : WORKER_PASTE_VALUE_KINDS
  }

  async function pasteRangeThroughWorker(request: PasteRangeRequest): Promise<PasteRangeResult> {
    const targetSheet = await resolveSheet(request.sheetId)
    const sourceSheet = await resolveSheet(request.source.sheetId)
    const geometry = pasteRangeGeometry(request)

    if (geometry.writeFormats && !workerPasteRangeSupportedKinds().includes(request.pasteKind)) {
      throw createBackendError(
        PASTE_RANGE_FORMATS_UNSUPPORTED,
        `paste-range kind "${request.pasteKind}" carries a format leg, but the worker ` +
          'runtime declares no format support; the request was rejected before any write',
      )
    }

    return recordCellMutation({
      // UI-core's confirm command records the paste as a 'cells.import'
      // history entry; the adapter record aligns positionally with it.
      kind: 'cells.import',
      sheet: targetSheet,
      range: geometry.affectedRange,
      captureValues: geometry.writeValues,
      captureFormats: geometry.writeFormats,
      execute: async () => {
        const src = request.source.range
        const tgt = request.target
        const sourceSparse = toSparseRange(sourceSheet.idx, src)
        const targetSparse = toSparseRange(targetSheet.idx, geometry.affectedRange)

        const [sourceSnapshots, targetSnapshots, sourceFormatSnapshot, targetFormatSnapshot] =
          await Promise.all([
            client.readSparseRange(sourceSparse),
            // Existing target inputs are only consulted by the
            // arithmetic ops; plain writes never read the target.
            geometry.writeValues && request.op !== 'none'
              ? client.readSparseRange(targetSparse)
              : Promise.resolve([] as CellSnapshotWire[]),
            geometry.writeFormats
              ? client.snapshotFormatRange(sourceSparse)
              : Promise.resolve(null),
            geometry.writeFormats
              ? client.snapshotFormatRange(targetSparse)
              : Promise.resolve(null),
          ])

        const sourceByKey = new Map<string, CellSnapshotWire>()
        for (const snapshot of sourceSnapshots) {
          const coord = parseA1(snapshot.addr)
          if (coord) sourceByKey.set(keyFor(coord.row, coord.col), snapshot)
        }
        const targetDisplayByKey = new Map<string, string>()
        for (const snapshot of targetSnapshots) {
          const coord = parseA1(snapshot.addr)
          if (coord) targetDisplayByKey.set(keyFor(coord.row, coord.col), snapshot.display)
        }
        const sourceFormats = sourceFormatSnapshot
          ? preprocessFormatSnapshot(sourceFormatSnapshot)
          : null
        const existingTargetFormats = new Map<string, CellFormatSnapshot>()
        if (targetFormatSnapshot) {
          for (const entry of targetFormatSnapshot.cellFormats) {
            const coord = parseA1(entry.addr)
            if (coord) existingTargetFormats.set(keyFor(coord.row, coord.col), entry)
          }
        }

        const wires: ImportCellWire[] = []
        const targetCellFormats: CellFormatSnapshot[] = []
        for (let dr = 0; dr < geometry.patchRows; dr += 1) {
          for (let dc = 0; dc < geometry.patchCols; dc += 1) {
            const srcCoord = pasteSourceCoord(src, geometry.transpose, dr, dc)
            const tgtRow = tgt.rowStart + dr
            const tgtCol = tgt.colStart + dc
            const srcSnapshot = sourceByKey.get(keyFor(srcCoord.row, srcCoord.col))
            const srcDisplay = srcSnapshot?.display ?? ''
            const srcFormula =
              srcSnapshot && srcSnapshot.formula !== '' ? srcSnapshot.formula : undefined

            if (request.skipBlanks && isPasteSourceBlank(srcDisplay, srcFormula)) {
              // The format restore below REPLACES per-cell formats in
              // the whole target rectangle, so skipped cells must carry
              // their CURRENT per-cell format through it (static parity:
              // skip-blanks leaves both legs of the target untouched).
              const existing = existingTargetFormats.get(keyFor(tgtRow, tgtCol))
              if (existing) targetCellFormats.push(existing)
              continue
            }

            if (geometry.writeValues) {
              // Reference semantics: formulas paste VERBATIM (no ref
              // translation on Paste Special; the plain-paste path
              // shifts refs UI-side before import).
              const baseInput = srcFormula ?? srcDisplay
              const finalInput = applyPasteArithmetic(
                request.op,
                baseInput,
                targetDisplayByKey.get(keyFor(tgtRow, tgtCol)),
              )
              if (finalInput !== null) {
                wires.push(toImportCellWire(targetSheet.idx, tgtRow, tgtCol, finalInput))
              }
            }

            if (sourceFormats) {
              const effectiveFormat = getEffectiveFormat(
                srcCoord.row,
                srcCoord.col,
                sourceFormats.cellFormats,
                sourceFormats.rangeFormats,
              )
              if (effectiveFormat) {
                targetCellFormats.push({
                  addr: toA1(tgtRow, tgtCol),
                  format: effectiveFormat as CellFormatJSON,
                })
              }
              // No effective source format → no entry: the restore
              // clears the per-cell override so the target falls back
              // to its own range layers (static parity: map delete).
            }
          }
        }

        if (wires.length > 0) {
          const sessionId = await client.beginImport({ mode: 'direct' })
          let committed = false
          try {
            for (let index = 0; index < wires.length; index += DEFAULT_IMPORT_CELLS_PER_CHUNK) {
              await client.importChunk(
                sessionId,
                wires.slice(index, index + DEFAULT_IMPORT_CELLS_PER_CHUNK),
              )
            }
            const stats = await client.commitImport(sessionId)
            committed = true
            assertImportStatsOk(stats)
          } finally {
            if (!committed) await client.cancelImport(sessionId).catch(() => {})
          }
        }

        if (targetFormatSnapshot) {
          // restore_format_range_snapshot REPLACES per-cell formats
          // inside the rectangle (with the entries computed above) and
          // restores the CURRENT range-layer list unchanged — an exact
          // per-cell format write with no layer-list growth. Mirrors the
          // static backend's per-cell map writes; target-range layers
          // survive on both paths.
          await client.restoreFormatSnapshot({
            sheet: targetSparse.sheet,
            startRow: targetSparse.startRow,
            startCol: targetSparse.startCol,
            endRow: targetSparse.endRow,
            endCol: targetSparse.endCol,
            cellFormats: targetCellFormats,
            rangeFormats: targetFormatSnapshot.rangeFormats,
          })
        }

        const nextRevision = bumpRevision()
        return {
          kind: 'paste-range',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: request.revision ?? nextRevision,
          affectedRange: { ...geometry.affectedRange },
        }
      },
    })
  }

  /**
   * Engine physical sort (design-engine-sort S4, parity #29). The engine
   * owns the reorder (`client.sortRange`); the adapter contributes the two
   * authority gates the engine cannot enforce, wraps the RPC in ONE
   * host-orchestrated undo transaction, and converts a structured engine
   * reject into a not-applied result instead of rejecting the promise.
   *
   * Flow:
   *  1. Source-size cap (fail-closed, NO RPC): reject before any read /
   *     RPC / undo record / revision bump if the range area exceeds
   *     `MAX_SORT_SOURCE_CELLS`.
   *  2. Merge authority gate (design §5.2): the engine has no merge model,
   *     so the adapter — sole holder of the registry — rejects a sort
   *     intersecting any merged range before dispatch.
   *  3. `recordCellMutation('range.sort')` wraps the RPC: range sparse +
   *     format before-image → `client.sortRange` → after-image for redo,
   *     ONE record. `bumpRevision` runs only after a successful sort.
   *  4. A `SORT_REJECTED` throws inside `execute`, so `recordCellMutation`
   *     pushes NO record and never bumps; the throw is caught here and the
   *     engine's `detail` becomes the structured not-applied result.
   */
  function sortRejectedResult(
    request: SortRangeRequest,
    code: SortRangeRejectionCode,
    message: string,
    anchor?: string,
  ): SortRangeRejectedResult {
    return {
      kind: 'sort-range-not-applied',
      sheetId: request.sheetId,
      applied: false,
      code,
      ...(anchor === undefined ? {} : { anchor }),
      message,
      requestId: request.requestId,
      // A rejected sort never bumps: echo the current (un-bumped) witness.
      revision: request.revision ?? revision,
    }
  }

  function sortRejectionFromError(
    request: SortRangeRequest,
    error: unknown,
  ): SortRangeRejectedResult | null {
    const err = error as Error & { code?: string; detail?: unknown }
    if (err?.code !== 'SORT_REJECTED') return null
    const detail = (err.detail ?? {}) as { code?: unknown; anchor?: unknown; message?: unknown }
    return sortRejectedResult(
      request,
      normalizeSortRejectionCode(detail.code),
      typeof detail.message === 'string' ? detail.message : err.message,
      typeof detail.anchor === 'string' ? detail.anchor : undefined,
    )
  }

  async function sortRangeThroughWorker(request: SortRangeRequest): Promise<SortRangeResult> {
    const sheet = await resolveSheet(request.sheetId)
    const range = normalizeRange(request.range)

    const rangeArea = (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
    if (rangeArea > MAX_SORT_SOURCE_CELLS) {
      return sortRejectedResult(
        request,
        'source-too-large',
        `sort range spans ${rangeArea} cells but the cap is ${MAX_SORT_SOURCE_CELLS}`,
      )
    }

    const merges = mergeRangesBySheetId.get(request.sheetId) ?? []
    if (merges.some((merge) => rangesIntersect(merge, range))) {
      return sortRejectedResult(
        request,
        'merge-in-range',
        'the sort range intersects a merged range; unmerge before sorting',
      )
    }

    const payload: SortRangePayloadWire = {
      range: toSortRangeBounds(range),
      keys: request.keys.map((key) => ({
        col: key.col,
        ...(key.direction === undefined ? {} : { direction: key.direction }),
        ...(key.caseSensitive === undefined ? {} : { caseSensitive: key.caseSensitive }),
      })),
      ...(request.excludedRows === undefined ? {} : { excludedRows: [...request.excludedRows] }),
    }

    let appliedRevision: ProjectionRevision = revision
    try {
      const report = await recordCellMutation<SortRangeReportWire>({
        kind: 'range.sort',
        sheet,
        range,
        captureValues: true,
        captureFormats: true,
        // A no-op sort (movedRows 0) writes nothing and pushes no undo
        // record — UI-core pushes no history entry for it either, so
        // recording here would skew the host↔worker stack (design §7).
        shouldRecord: (report) => report.movedRows > 0,
        execute: async () => {
          const result = await client.sortRange(sheet.idx, payload)
          appliedRevision = bumpRevision()
          return result
        },
      })
      return {
        kind: 'sort-range',
        sheetId: request.sheetId,
        applied: true,
        movedRows: report.movedRows,
        movedCells: report.movedCells,
        affectedRange: { ...range },
        rowPermutation: report.rowPermutation,
        requestId: request.requestId,
        revision: request.revision ?? appliedRevision,
      }
    } catch (error) {
      const rejection = sortRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
    }
  }

  /**
   * Engine hidden-row eval input (parity #23). Whole-set REPLACE of the
   * hidden-row set the SUBTOTAL 101-111 variants exclude for the request's
   * sheet. NOT a mutation — no exact ACK, no undo record, no revision bump
   * of its own: the engine's paired `hidden_epoch` bump marks the affected
   * 101-111 formulas dirty, and the worker forwards the resulting recompute
   * as `cellsDirty` (the standard content-change path). The push is
   * idempotent (repeated identical sets are safe) and resolves once the
   * worker ACKs so the provider can order a follow-up projection read after
   * the epoch bump has applied.
   */
  async function setEvalHiddenRowsThroughWorker(request: SetEvalHiddenRowsRequest): Promise<void> {
    const sheet = await resolveSheet(request.sheetId)
    const rows: number[] = []
    for (const value of request.rows) {
      if (Number.isSafeInteger(value) && value >= 0) rows.push(value)
    }
    await client.setEvalHiddenRows(sheet.idx, rows)
  }

  // --- Excel Table CRUD (design-excel-table.md §10, parity #32) ---------
  //
  // The engine registry is canonical (CANONICAL_OWNERSHIP §3 #32): these
  // ports are the only path UI core reads a table's geometry, and the
  // adapter keeps no second copy. Capability-gated by `structuredTables`.
  //
  // TODO(#32 undo, design §11/§12): table-definition mutations are NOT
  // wrapped in a host-orchestrated undo transaction. The snapshot
  // primitive and persistence v1 do not carry the table registry, so a
  // Ctrl+Z cannot replay a create/rename/delete of the table itself.
  // The cell-level fallout of a totals-row toggle (formula writes) is
  // still covered by the existing recordCellMutation cell snapshots; the
  // registry entry is not. Wire this once the registry replay protocol
  // lands (§4-3). Create / rename / delete bump the revision so the next
  // projection read reflects any referencing-formula recalc (engine epoch
  // handles the recompute; worker cellsDirty pushes drive reprojection).

  const TABLE_REJECTION_CODES = new Set<TableMutationRejectionCode>([
    'too-many-tables',
    'invalid-name',
    'reserved-name',
    'name-like-cell-ref',
    'name-conflict',
    'range-overlap',
    'sheet-not-found',
    'not-found',
    'column-not-found',
    'duplicate-column',
    'invalid-column-name',
    'mutation-during-custom-call',
    'totals-row-blocked',
    'no-totals-row',
    'invalid-totals-function',
  ])

  function normalizeTableRejectionCode(code: unknown): TableMutationRejectionCode {
    return typeof code === 'string' && TABLE_REJECTION_CODES.has(code as TableMutationRejectionCode)
      ? (code as TableMutationRejectionCode)
      : 'invalid-payload'
  }

  type TableClientMethod =
    | 'createTable'
    | 'renameTable'
    | 'renameTableColumn'
    | 'deleteTable'
    | 'listTables'
    | 'getTable'
    | 'setTableTotalsRow'
    | 'setTableTotalFunction'

  function requireTableClient<K extends TableClientMethod>(
    method: K,
  ): NonNullable<WorkerWorkbookClient[K]> {
    const fn = client[method]
    if (typeof fn !== 'function') {
      throw createBackendError('UNSUPPORTED', `worker runtime does not implement ${method}`)
    }
    return fn.bind(client) as NonNullable<WorkerWorkbookClient[K]>
  }

  function toTableDescriptor(wire: TableJSONWire): SpreadsheetTableDescriptor {
    const sheet = lookup.sheets.find((entry) => entry.idx === wire.sheetIndex)
    return {
      name: wire.name,
      sheetId: sheet?.id ?? '',
      sheetName: wire.sheet,
      sheetIndex: wire.sheetIndex,
      range: wire.range,
      hasHeaders: wire.hasHeaders,
      hasTotals: wire.hasTotals,
      columns: wire.columns,
    }
  }

  function tableRejectionFromError(
    request: { requestId?: number; revision?: number | string },
    error: unknown,
  ): TableMutationRejectedResult | null {
    const err = error as Error & { code?: string; detail?: unknown }
    if (err?.code !== 'TABLE_REJECTED') return null
    const detail = (err.detail ?? {}) as { code?: unknown; message?: unknown }
    return {
      kind: 'table-mutation-not-applied',
      applied: false,
      code: normalizeTableRejectionCode(detail.code),
      message: typeof detail.message === 'string' ? detail.message : err.message,
      requestId: request.requestId,
      // A rejected mutation never bumps: echo the current (un-bumped) witness.
      revision: request.revision ?? revision,
    }
  }

  async function createTableThroughWorker(request: CreateTableRequest): Promise<CreateTableResult> {
    const sheet = await resolveSheet(request.sheetId)
    const range = normalizeRange(request.range)
    try {
      const name = await requireTableClient('createTable')(
        sheet.idx,
        toSortRangeBounds(range),
        request.name,
      )
      const nextRevision = bumpRevision()
      return {
        kind: 'create-table',
        applied: true,
        name,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    } catch (error) {
      const rejection = tableRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
    }
  }

  async function renameTableThroughWorker(
    request: RenameTableRequest,
  ): Promise<TableMutationResult> {
    await readyPromise
    try {
      await requireTableClient('renameTable')(request.name, request.newName)
      const nextRevision = bumpRevision()
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.newName,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    } catch (error) {
      const rejection = tableRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
    }
  }

  async function renameTableColumnThroughWorker(
    request: RenameTableColumnRequest,
  ): Promise<TableMutationResult> {
    await readyPromise
    try {
      await requireTableClient('renameTableColumn')(
        request.name,
        request.oldColumn,
        request.newColumn,
      )
      const nextRevision = bumpRevision()
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    } catch (error) {
      const rejection = tableRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
    }
  }

  async function deleteTableThroughWorker(
    request: DeleteTableRequest,
  ): Promise<TableMutationResult> {
    await readyPromise
    try {
      await requireTableClient('deleteTable')(request.name)
      const nextRevision = bumpRevision()
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    } catch (error) {
      const rejection = tableRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
    }
  }

  async function listTablesThroughWorker(request: ListTablesRequest): Promise<ListTablesResult> {
    await readyPromise
    const wires = await requireTableClient('listTables')()
    return {
      requestId: request.requestId,
      revision,
      tables: wires.map(toTableDescriptor),
    }
  }

  async function getTableThroughWorker(request: GetTableRequest): Promise<GetTableResult> {
    await readyPromise
    const wire = await requireTableClient('getTable')(request.name)
    return {
      requestId: request.requestId,
      revision,
      table: wire ? toTableDescriptor(wire) : null,
    }
  }

  async function setTableTotalsRowThroughWorker(
    request: SetTableTotalsRowRequest,
  ): Promise<TableMutationResult> {
    await readyPromise
    try {
      await requireTableClient('setTableTotalsRow')(request.name, request.enabled)
      const nextRevision = bumpRevision()
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    } catch (error) {
      const rejection = tableRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
    }
  }

  async function setTableTotalFunctionThroughWorker(
    request: SetTableTotalFunctionRequest,
  ): Promise<TableMutationResult> {
    await readyPromise
    try {
      await requireTableClient('setTableTotalFunction')(request.name, request.column, request.func)
      const nextRevision = bumpRevision()
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    } catch (error) {
      const rejection = tableRejectionFromError(request, error)
      if (rejection !== null) return rejection
      throw error
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
      const cellRange: CellRange = {
        rowStart: request.row,
        rowEnd: request.row,
        colStart: request.col,
        colEnd: request.col,
      }

      return recordCellMutation({
        kind: 'cell.set-input',
        sheet,
        range: cellRange,
        captureValues: true,
        captureFormats: false,
        execute: async () => {
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
            affectedRange: { ...cellRange },
          }
        },
      })
    },

    async importCells(request: ImportCellsRequest): Promise<BackendMutationResult> {
      return importChunks({
        ...request,
        // The concrete cell list is in hand, so a missing range can be
        // derived instead of degrading the undo record to not-undoable.
        range: request.range ?? boundingRangeOfImportCells(request.cells) ?? undefined,
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
      const touchesValues = target === 'values' || target === 'all'
      // Runtimes that declare `formats: false` model no formats, so the
      // clear is vacuously complete and the mutation never touches them.
      const touchesFormats =
        (target === 'formats' || target === 'all') && runtimeSupports('formats')

      return recordCellMutation({
        kind: 'range.clear',
        sheet,
        range: { ...request.range },
        captureValues: touchesValues,
        captureFormats: touchesFormats,
        execute: async () => {
          if (touchesValues) {
            await client.clearRange(sparseRange)
          }
          if (touchesFormats) {
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
      })
    },

    get insertRows() {
      return runtimeSupports('structuralEdits') ? insertRowsThroughWorker : undefined
    },

    get deleteRows() {
      return runtimeSupports('structuralEdits') ? deleteRowsThroughWorker : undefined
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
    get removeRows() {
      return runtimeSupports('structuralEdits') ? removeRowsThroughWorker : undefined
    },

    get removeRowsExact() {
      // Two witnesses must agree: the host's explicit opt-in AND the
      // runtime's own structural-edit declaration.
      return options.removeRowsExactCapability === 'worker-engine-delete-rows' &&
        runtimeSupports('structuralEdits')
        ? removeRowsExact
        : undefined
    },

    get insertColumns() {
      return runtimeSupports('structuralEdits') ? insertColumnsThroughWorker : undefined
    },

    get deleteColumns() {
      return runtimeSupports('structuralEdits') ? deleteColumnsThroughWorker : undefined
    },

    get setFormatRange() {
      return runtimeSupports('formats') ? setFormatRangeThroughWorker : undefined
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
      // Design point D: sheet lifecycle is not undoable, and the delete
      // shifts positional sheet indices — recorded transactions would
      // replay into the wrong sheet, so the log is dropped wholesale.
      dropTransactionRecords()
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
          // Design point D: the reorder shifted positional sheet indices;
          // recorded transactions would replay into the wrong sheet.
          dropTransactionRecords()
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

    async undoTransaction(request: UndoTransactionRequest): Promise<HistoryTransactionResult> {
      return runHistoryTransaction('undo', request)
    },

    async redoTransaction(request: RedoTransactionRequest): Promise<HistoryTransactionResult> {
      return runHistoryTransaction('redo', request)
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

        namedRanges = namedRanges.filter((item) => !namedRangeMatches(item, name, request.scope))
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

    async clearValidationRule(request: ClearValidationRuleRequest): Promise<BackendMutationResult> {
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
            : (request.ruleId ?? nextConditionalFormatRuleId(current)),
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
     * Parity item #29 — filter VISIBILITY on the worker path. The rules
     * stay ui-core canonical (this ACK is what lets ui-core commit
     * them); the adapter mirrors the payload and computes the visibility
     * permutation with the shared pure helper at projection time, so the
     * engine data is never reordered. Sorting is NOT part of this path
     * at all: the display-permutation sort was retired with #24, and a
     * physical sort goes through `sortRange` (which the TS runtime
     * withholds — that host simply has no sort). The permutation is
     * computed BEFORE acknowledging: an over-cap source rejects with
     * FILTER_SORT_SOURCE_TOO_LARGE and the filter never activates —
     * fail-closed, no silent truncation. Clearing (a no-effect payload)
     * never scans and therefore always succeeds, so an over-cap state
     * can always be exited.
     */
    async setFilterSort(request: SetFilterSortRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const next = cloneFilterSortState({ rules: request.rules })

      if (!filterSortHasEffect(next)) {
        filterSortStateBySheetId.delete(request.sheetId)
        const nextRevision = bumpRevision()
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: request.revision ?? nextRevision,
        }
      }

      const displayRows = await computeFilterSortDisplayRows(sheet, next)
      filterSortStateBySheetId.set(request.sheetId, next)
      // bumpRevision clears the whole display-row cache; store the fresh
      // permutation after it so the first projection read reuses it.
      const nextRevision = bumpRevision()
      filterSortDisplayRowsBySheetId.set(request.sheetId, displayRows)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    /**
     * Parity #04 — merge/unmerge (adapter host-overlay, see
     * `mergeRangesBySheetId`). Session-only, never an engine RPC; the
     * exact ACK (kind/requestId/revision/affectedRange) satisfies the
     * UI-core toolbar's strict validator, and each call records a
     * before/after overlay image on the host-orchestrated transaction
     * log so Ctrl+Z round-trips.
     */
    async mergeRange(request: MergeRangeRequest): Promise<ToolbarBackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      return applyMergeOverlayMutation(request, sheet)
    },

    async unmergeRange(request: UnmergeRangeRequest): Promise<ToolbarBackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      return applyMergeOverlayMutation(request, sheet)
    },

    /**
     * Parity #11 — Paste Special (see `pasteRangeThroughWorker`). The
     * exact ACK echoes kind/sheetId/requestId plus revision and the
     * clamped affectedRange so UI-core's strict acknowledgement chain
     * (`acknowledgementMatches` → history → refresh) can complete, and
     * each call records ONE before/after transaction on the
     * host-orchestrated undo log (values and, on format-capable
     * runtimes, formats).
     */
    async pasteRange(request: PasteRangeRequest): Promise<PasteRangeResult> {
      return pasteRangeThroughWorker(request)
    },

    get pasteRangeSupportedKinds() {
      return workerPasteRangeSupportedKinds()
    },

    /**
     * Engine physical sort (design-engine-sort S4). Capability-gated: a
     * runtime that declares `sortRange: false` (the TS worker, which has
     * no physical sort) makes this port read `undefined` so UI-core hides
     * the physical-sort entry; the WASM runtime's null witness keeps it
     * exposed (full trust). See `sortRangeThroughWorker` for the cap +
     * merge gates and the host-orchestrated undo wrapping.
     */
    get sortRange() {
      return runtimeSupports('sortRange') ? sortRangeThroughWorker : undefined
    },

    /**
     * Engine hidden-row eval input (parity #23). Capability-gated by
     * `evalHiddenRows`: the TS worker declares it `false` so this port
     * reads `undefined` and the provider silently skips the push (SUBTOTAL
     * 101-111 degrades to "does not exclude"); the WASM runtime's null
     * witness keeps it exposed (full trust). See
     * `setEvalHiddenRowsThroughWorker` for the whole-set-replace semantics.
     */
    get setEvalHiddenRows() {
      return runtimeSupports('evalHiddenRows') ? setEvalHiddenRowsThroughWorker : undefined
    },

    /**
     * Excel Table CRUD (design-excel-table.md §10, parity #32).
     * Capability-gated by `structuredTables`: the TS worker declares it
     * `false` so every port reads `undefined` and UI-core hides the Table
     * entries; the WASM runtime's null witness keeps them exposed (full
     * trust). See the `*ThroughWorker` functions above for the reject
     * mapping and the (deferred) undo note.
     */
    get createTable() {
      return runtimeSupports('structuredTables') ? createTableThroughWorker : undefined
    },
    get renameTable() {
      return runtimeSupports('structuredTables') ? renameTableThroughWorker : undefined
    },
    get renameTableColumn() {
      return runtimeSupports('structuredTables') ? renameTableColumnThroughWorker : undefined
    },
    get deleteTable() {
      return runtimeSupports('structuredTables') ? deleteTableThroughWorker : undefined
    },
    get listTables() {
      return runtimeSupports('structuredTables') ? listTablesThroughWorker : undefined
    },
    get getTable() {
      return runtimeSupports('structuredTables') ? getTableThroughWorker : undefined
    },
    get setTableTotalsRow() {
      return runtimeSupports('structuredTables') ? setTableTotalsRowThroughWorker : undefined
    },
    get setTableTotalFunction() {
      return runtimeSupports('structuredTables') ? setTableTotalFunctionThroughWorker : undefined
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
