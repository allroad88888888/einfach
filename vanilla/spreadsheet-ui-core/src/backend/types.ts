import type { CellCoord, CellRange, SheetRef, SpreadsheetError } from '../shared'
import type { SetFilterSortRequest } from '../filter-sort/types'
import type { ReadPrintConfigRequest, ReadPrintConfigResult, SetPrintConfigRequest } from '../print/types'
import type { PresenceUpdate } from '../presence/types'
import type { DisplayCellRichValue } from '../rich-types/types'
import type { ValidationOutcome, SetValidationRuleRequest, ClearValidationRuleRequest } from '../data-validation/types'
import type {
  ConditionalFormatRulesResult,
  ListConditionalFormatRulesRequest,
  RemoveConditionalFormatRuleRequest,
  SetConditionalFormatRuleRequest,
} from '../conditional-formatting/types'
import type {
  DeleteNamedRangeRequest,
  ListNamedRangesRequest,
  NamedRangeListResult,
  NamedRangeMutationResult,
  SetNamedRangeRequest,
} from '../named-ranges/types'
import type { FillSeriesRequest } from '../auto-fill/types'
import type {
  ClearNoteRequest,
  DeleteCommentRequest,
  PostCommentRequest,
  ResolveCommentThreadRequest,
  SetNoteRequest,
} from '../comments/types'
import type {
  FindRangeRequest,
  FindRangeResult,
  SearchRangeRequest,
  SearchRangeResult,
  ReplaceMatchesRequest,
  ReplaceMatchesResponse,
  ReplaceMatchesResult,
} from '../find-replace/types'
import type {
  ReadSheetProtectionRequest,
  ReadSheetProtectionResult,
  SetRangeLockRequest,
  SetSheetProtectionRequest,
} from '../protection/types'
import type { PasteRangeRequest, PasteRangeResult, PasteSpecialKind } from '../paste-special/types'

export type {
  ClearNoteRequest,
  DeleteCommentRequest,
  PostCommentRequest,
  ResolveCommentThreadRequest,
  SetNoteRequest,
}

export type { ValidationOutcome, SetValidationRuleRequest, ClearValidationRuleRequest }

export type {
  ConditionalFormatRulesResult,
  ListConditionalFormatRulesRequest,
  RemoveConditionalFormatRuleRequest,
  SetConditionalFormatRuleRequest,
}

// --- find-replace ---
export type {
  FindRangeRequest,
  FindRangeResult,
  SearchRangeRequest,
  SearchRangeResult,
  ReplaceMatchesRequest,
  ReplaceMatchesResult,
}

// --- print ---
export type { ReadPrintConfigRequest, ReadPrintConfigResult, SetPrintConfigRequest }

// --- protection ---
export type {
  ReadSheetProtectionRequest,
  ReadSheetProtectionResult,
  SetRangeLockRequest,
  SetSheetProtectionRequest,
}

// --- paste-special ---
export type { PasteRangeRequest, PasteRangeResult }

// --- remove-duplicates (Wave 7.5) ---

/**
 * Request body for the Remove Duplicates command. The dialog computes a
 * sorted set of duplicate row indices via `findDuplicateRows` and the host
 * adapter dispatches that list through this port. The adapter is expected
 * to sort + de-dupe the input internally (rows are NOT required to arrive
 * sorted) and treat an empty array as a no-op rather than an error.
 */
export interface RemoveRowsRequest {
  kind: 'remove-rows'
  sheetId: string
  /**
   * Sheet-absolute row indices to remove. NOT required sorted; adapter
   * sorts and de-dupes internally. Empty array is a no-op (does NOT error).
   */
  rows: ReadonlyArray<number>
  requestId?: number
  revision?: number | string
}

export interface RemoveRowsResult {
  sheetId: string
  removedRows: number
  affectedRange?: { startRow: number; endRow: number; startCol: number; endCol: number }
  revision: number | string
}

export type ProjectionRequestId = number
export type ProjectionRevision = number | string
export type ProjectionRequestKind = 'visible-window' | 'range'

export type ProjectionRequestReason =
  | 'viewport'
  | 'selection'
  | 'keyboard'
  | 'formula-bar'
  | 'clipboard'
  | 'fill-handle'
  | 'toolbar'
  | 'diagnostics'
  | 'test'

export interface ProjectionCancelToken {
  readonly cancelled: boolean
}

export interface MergeSpan {
  rows: number
  cols: number
}

export interface MergeRegion extends SheetRef {
  range: CellRange
}

export interface DisplayCell {
  row: number
  col: number
  displayValue: string
  valueKind?: 'blank' | 'number' | 'string' | 'boolean' | 'error'
  /** Read-only projection fact: the canonical finite number before display formatting. */
  numericValue?: number
  formula?: string
  error?: SpreadsheetError
  formatKey?: string
  format?: SpreadsheetCellFormat
  mergedSpan?: MergeSpan
  mergeAnchor?: CellCoord
  noteIndicator?: boolean
  commentThreadId?: string
  validation?: ValidationOutcome
  conditionalFormat?: SpreadsheetCellFormat
  richValue?: DisplayCellRichValue
  /** Backend sets this when filter or sort is active; the renderer keeps using `row` for layout
   *  while edit round-trips use originalRow. */
  originalRow?: number
  /** Locked indicator from a protected sheet; gating logic uses unlockedRanges on the UI side. */
  locked?: boolean
}

export type SpreadsheetAlignment =
  | 'default'
  | 'left'
  | 'center'
  | 'right'
  | 'fill'
  | 'justify'
  | 'distributed'

export type SpreadsheetVerticalAlignment =
  | 'top'
  | 'center'
  | 'bottom'
  | 'justify'
  | 'distributed'

/**
 * Overflow strategy for a cell whose text exceeds its box.
 *
 * - `'overflow'` — default Excel behaviour for non-numeric text: the rendered
 *   string spills into adjacent empty cells. Adapters that cannot detect
 *   neighbour blankness may fall back to `'clip'`.
 * - `'clip'` — truncate at the cell edge. Adapters typically draw a trailing
 *   ellipsis via `text-overflow: ellipsis`.
 * - `'ellipsis'` — synonym for `'clip'` that some adapters use to signal an
 *   explicit ellipsis glyph; kept distinct for round-trip fidelity.
 * - `'wrap'` — wrap text onto multiple lines. The renderer may also bump the
 *   row height through the existing viewport-size projection / override path.
 * - `'shrink-to-fit'` — scale the rendered text down to fit. Mutually
 *   exclusive with `'wrap'` at the UI level; the editor decides precedence.
 */
export type SpreadsheetOverflow =
  | 'overflow'
  | 'clip'
  | 'ellipsis'
  | 'wrap'
  | 'shrink-to-fit'

/**
 * Cell text rotation.
 *
 * - A number in `[-90, 90]` is degrees of baseline rotation.
 * - The string literal `'vertical'` is character-stacked vertical text
 *   (Excel's "Text" alignment angle 255 / `writing-mode: vertical-rl`).
 */
export type SpreadsheetRotation = number | 'vertical'

/**
 * How negative numeric values display for `number`, `currency` and `percent`
 * variants. `'minus'` is the default (`-1234`); `'red'` paints the rendered
 * string red and emits a color hint on `DisplayCell.format.fgColor`;
 * `'parens'` wraps the absolute value in parentheses (`(1234)`); `'red-parens'`
 * combines both.
 */
export type SpreadsheetNumberFormatNegative = 'minus' | 'red' | 'parens' | 'red-parens'

/**
 * Denominator hint for the `fraction` variant. `'one-digit'` allows up to
 * `9` (`# ?/?`), `'two-digit'` up to `99`, `'three-digit'` up to `999`. A
 * numeric value forces a fixed denominator (e.g. `2` for halves, `4` for
 * quarters).
 */
export type SpreadsheetNumberFormatFractionDenominator =
  | 'one-digit'
  | 'two-digit'
  | 'three-digit'
  | number

/**
 * Twelve Excel-style number-format categories.
 *
 * Wave 6.3 widens this type. The historical `'decimal'` variant is retained
 * as a deprecated alias for `'number'`; the projection layer treats them as
 * identical for one wave.
 */
export type SpreadsheetNumberFormat =
  | { kind: 'general' }
  | {
      kind: 'number'
      digits?: number
      thousands?: boolean
      negative?: SpreadsheetNumberFormatNegative
    }
  | {
      /** Deprecated alias for `'number'`. Slated for removal one wave after 6.3. */
      kind: 'decimal'
      digits?: number
      thousands?: boolean
      negative?: SpreadsheetNumberFormatNegative
    }
  | {
      kind: 'currency'
      symbol?: string
      digits?: number
      negative?: SpreadsheetNumberFormatNegative
    }
  | { kind: 'accounting'; symbol?: string; digits?: number }
  | { kind: 'date'; pattern?: string }
  | { kind: 'time'; pattern?: string }
  | {
      kind: 'percent'
      digits?: number
      negative?: SpreadsheetNumberFormatNegative
    }
  | {
      /** Synonym for `'percent'` used by the Format Cells dialog. */
      kind: 'percentage'
      digits?: number
      negative?: SpreadsheetNumberFormatNegative
    }
  | { kind: 'fraction'; denominator?: SpreadsheetNumberFormatFractionDenominator }
  | { kind: 'scientific'; digits?: number }
  | { kind: 'text' }
  | { kind: 'special'; preset: string; locale?: string }
  | { kind: 'custom'; pattern: string }

export type SpreadsheetBorderSide = 'top' | 'right' | 'bottom' | 'left'

export type SpreadsheetBorderStyle = 'none' | 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double'

export interface SpreadsheetBorderSpec {
  style: SpreadsheetBorderStyle
  color?: string
}

export type SpreadsheetBorders = Partial<Record<SpreadsheetBorderSide, SpreadsheetBorderSpec>>

export interface SpreadsheetCellFormat {
  numberFormat?: SpreadsheetNumberFormat
  bold?: boolean
  italic?: boolean
  align?: SpreadsheetAlignment
  fontSize?: number
  fontFamily?: string
  fgColor?: string
  bgColor?: string
  borders?: SpreadsheetBorders
  underline?: boolean
  strikethrough?: boolean
  wrap?: boolean
  indent?: number
  /**
   * Vertical alignment inside the cell box.
   *
   * Default (when omitted) is `'bottom'`, matching Excel for non-numeric text.
   */
  verticalAlign?: SpreadsheetVerticalAlignment
  /**
   * Text rotation in degrees (`-90` to `90`), or `'vertical'` for stacked
   * vertical text.
   */
  rotation?: SpreadsheetRotation
  /**
   * Overflow strategy when the rendered text exceeds the cell box.
   *
   * Default (when omitted) is `'overflow'` for text and `'clip'` for numbers;
   * the renderer applies that fallback because it knows the value kind.
   */
  overflow?: SpreadsheetOverflow
  /**
   * Scale the rendered text down to fit the cell. Mutually exclusive with
   * `wrap` at the editor level (the editor picks a winner before save).
   */
  shrinkToFit?: boolean
  /**
   * Per-cell BCP-47 locale override. The projection formatter falls back to
   * the workbook locale (`workbookLocaleAtom`, default `'en-US'`) when this
   * field is omitted. Affects thousands / decimal separators and the default
   * currency symbol.
   */
  locale?: string
}

export interface VisibleProjectionRequest extends SheetRef {
  kind: 'visible-window'
  window: CellRange
  requestId: ProjectionRequestId
  reason?: ProjectionRequestReason
  revision?: ProjectionRevision
  cancelToken?: ProjectionCancelToken
}

export interface RangeProjectionRequest extends SheetRef {
  kind: 'range'
  range: CellRange
  requestId: ProjectionRequestId
  reason: ProjectionRequestReason
  revision?: ProjectionRevision
  cancelToken?: ProjectionCancelToken
}

export interface VisibleProjectionResult extends SheetRef {
  kind: 'visible-window'
  window: CellRange
  requestId: ProjectionRequestId
  revision?: ProjectionRevision
  cells: DisplayCell[]
  truncated?: boolean
}

export interface RangeProjectionResult extends SheetRef {
  kind: 'range'
  range: CellRange
  requestId: ProjectionRequestId
  revision?: ProjectionRevision
  cells: DisplayCell[]
  truncated?: boolean
}

export interface RangeTsvExportRequest extends SheetRef {
  kind: 'export-range-tsv'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  rowsPerChunk?: number
}

/**
 * Wave 8.4 — range screenshot. Host renders the rectangle to a raster
 * image and returns the encoded bytes. PoC only emits PNG; future hosts
 * may advertise additional `format` values.
 *
 * The port is OPTIONAL — UI core treats a missing implementation as
 * "feature absent" and hides the trigger surfaces (`copyAs.png` menu
 * entry, `Ctrl+Shift+P` accelerator) accordingly.
 */
export interface RangeImageExportRequest extends SheetRef {
  kind: 'export-range-image'
  range: CellRange
  /** Defaults to `'png'`; PoC only emits PNG. */
  format?: 'png'
  /** Defaults to `1` (CSS px). Set to `2` for retina output. */
  scale?: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RangeImageExportResult extends SheetRef {
  kind: 'range-image'
  range: CellRange
  /**
   * Encoded image bytes. UI core wraps in a `Blob` for clipboard write;
   * `Uint8Array` keeps the result postMessage-friendly so a future host
   * can render in a worker without changing the contract.
   */
  bytes: Uint8Array
  width: number
  height: number
  mimeType: 'image/png'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RangeTsvExportResult extends SheetRef {
  kind: 'range-tsv'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  originAddr: string
  text: string
  estimatedBytes?: number
}

export interface RangeTsvExportChunk {
  startRow: number
  endRow: number
  text: string
}

export type RangeTsvChunkConsumer = (
  chunk: RangeTsvExportChunk,
) => void | Promise<void>

export interface RangeTsvChunkExportResult extends SheetRef {
  kind: 'range-tsv-chunks'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  originAddr: string
  estimatedBytes?: number
}

export interface SetCellInputRequest extends SheetRef {
  kind: 'set-cell-input'
  row: number
  col: number
  input: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SetCellRichValueRequest extends SheetRef {
  kind: 'set-cell-rich-value'
  row: number
  col: number
  value: DisplayCellRichValue
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ImportCellInput {
  row: number
  col: number
  input: string
  /**
   * When true, the adapter MUST insert `input` as a literal string without
   * numeric inference or formula parsing. A leading `=` is preserved as
   * literal text and digit-only strings like `00123` keep their leading
   * zeros. Used by Text to Columns when the user picks the `text` column
   * format.
   */
  preserveAsText?: boolean
}

export type ImportCellChunkSource =
  | Iterable<readonly ImportCellInput[]>
  | AsyncIterable<readonly ImportCellInput[]>

export interface ImportCellsRequest extends SheetRef {
  kind: 'import-cells'
  cells: ImportCellInput[]
  range?: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  cellsPerChunk?: number
}

export interface ImportCellChunksRequest extends SheetRef {
  kind: 'import-cell-chunks'
  chunks: ImportCellChunkSource
  range?: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  cellsPerChunk?: number
}

export type ClearRangeTarget = 'values' | 'formats' | 'all'

export interface ClearRangeRequest extends SheetRef {
  kind: 'clear-range'
  range: CellRange
  /** Defaults to 'all' when omitted. */
  target?: ClearRangeTarget
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface InsertRowsRequest extends SheetRef {
  kind: 'insert-rows'
  rowIndex: number
  count: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface DeleteRowsRequest extends SheetRef {
  kind: 'delete-rows'
  rowIndex: number
  count: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface InsertColumnsRequest extends SheetRef {
  kind: 'insert-columns'
  colIndex: number
  count: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface DeleteColumnsRequest extends SheetRef {
  kind: 'delete-columns'
  colIndex: number
  count: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SetFormatRangeRequest extends SheetRef {
  kind: 'set-format-range'
  range: CellRange
  format: SpreadsheetCellFormat | null
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ViewportSizeProjectionRequest extends SheetRef {
  kind: 'viewport-size'
  window: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ViewportRowHeight {
  rowIndex: number
  heightPx: number
}

export interface ViewportColumnWidth {
  colIndex: number
  widthPx: number
}

export interface ViewportSizeProjectionResult extends SheetRef {
  kind: 'viewport-size'
  window: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  rowHeights: ViewportRowHeight[]
  colWidths: ViewportColumnWidth[]
  hiddenRowIndices?: number[]
  hiddenColIndices?: number[]
}

export interface HideRowsRequest extends SheetRef {
  kind: 'hide-rows'
  rowIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface UnhideRowsRequest extends SheetRef {
  kind: 'unhide-rows'
  rowIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface HideColumnsRequest extends SheetRef {
  kind: 'hide-columns'
  colIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface UnhideColumnsRequest extends SheetRef {
  kind: 'unhide-columns'
  colIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SetRowHeightRequest extends SheetRef {
  kind: 'set-row-height'
  rowIndex: number
  heightPx: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SetColumnWidthRequest extends SheetRef {
  kind: 'set-column-width'
  colIndex: number
  widthPx: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export type SpreadsheetFillDirection = 'up' | 'down' | 'left' | 'right'

export interface FillRangeRequest extends SheetRef {
  kind: 'fill-range'
  sourceRange: CellRange
  targetRange: CellRange
  direction: SpreadsheetFillDirection
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export type SpreadsheetDataEdgeDirection = 'up' | 'down' | 'left' | 'right'

export interface ResolveDataEdgeRequest extends SheetRef {
  kind: 'resolve-data-edge'
  from: CellCoord
  direction: SpreadsheetDataEdgeDirection
  bounds: {
    rowCount: number
    colCount: number
  }
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ResolveDataEdgeResult extends SheetRef {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  target: CellCoord
}

export interface MergeRangeRequest extends SheetRef {
  kind: 'merge-range'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface UnmergeRangeRequest extends SheetRef {
  kind: 'unmerge-range'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

/**
 * Index-space displacement produced by a structural mutation
 * (insert/delete rows or columns). Hosts use it to remap any view
 * metadata they index by absolute row/column number (hidden sets,
 * merge ranges, freeze counts, row heights / column widths) without
 * refetching the whole sheet.
 *
 * Semantics (all indices are zero-based, pre-mutation coordinates):
 * - `index` is the first affected row/column index on `axis`.
 * - `kind: 'insert'` — `count` new indices now occupy
 *   `[index, index + count)`; every pre-mutation index `>= index`
 *   moved up by `count`.
 * - `kind: 'delete'` — the pre-mutation indices `[index, index + count)`
 *   were removed; every pre-mutation index `>= index + count` moved
 *   down by `count`.
 */
export interface BackendStructuralShift {
  axis: 'row' | 'column'
  kind: 'insert' | 'delete'
  index: number
  count: number
}

export interface BackendMutationResult extends SheetRef {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  affectedRange?: CellRange
  /**
   * Present only when the mutation structurally displaced index space
   * (insert/delete rows/columns). Optional and backward compatible:
   * absence means "no displacement happened"; consumers must not
   * infer anything else from a missing field.
   */
  structuralShift?: BackendStructuralShift
}

export interface SpreadsheetSheetMetadata {
  id: string
  name: string
  index: number
}

export interface SheetListResult {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  sheets: SpreadsheetSheetMetadata[]
}

export interface AddSheetRequest {
  kind: 'add-sheet'
  name?: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RenameSheetRequest extends SheetRef {
  kind: 'rename-sheet'
  name: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface DeleteSheetRequest extends SheetRef {
  kind: 'delete-sheet'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ReorderSheetRequest extends SheetRef {
  kind: 'reorder-sheet'
  beforeSheetId?: string | null
  afterSheetId?: string | null
  targetIndex?: number | null
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SheetMutationResult {
  sheetId?: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  sheets?: SpreadsheetSheetMetadata[]
  activeSheetId?: string | null
  createdSheet?: SpreadsheetSheetMetadata
}

export interface UndoTransactionRequest {
  kind: 'undo-transaction'
  transactionId: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RedoTransactionRequest {
  kind: 'redo-transaction'
  transactionId: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface HistoryTransactionResult {
  transactionId: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  affectedRange?: CellRange
  /**
   * Structured not-applied witness (host-orchestrated undo). `false`
   * means the backend positively confirmed nothing was replayed —
   * unknown transactionId, missing snapshot, or an entry degraded to
   * not-undoable at record time. UI core routes it through the
   * outcome-unknown convention (re-read canonical state); the revision
   * accompanying a not-applied result is informational only. Absent or
   * `true` means the transaction was applied.
   */
  applied?: boolean
  /** Human-readable reason accompanying `applied: false`. */
  notAppliedReason?: string
}

// --- filter-sort ---
export type { SetFilterSortRequest } from '../filter-sort/types'

export interface SpreadsheetBackend {
  listSheets?(): Promise<SheetListResult>
  readVisibleProjection(request: VisibleProjectionRequest): Promise<VisibleProjectionResult>
  readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult>
  exportRangeTsv?(request: RangeTsvExportRequest): Promise<RangeTsvExportResult>
  /**
   * Wave 8.4 — range screenshot. Optional capability; UI core hides the
   * Copy-as-PNG surfaces and `encodeSelectionAsImage` returns `null`
   * when this method is omitted.
   */
  exportRangeAsImage?(request: RangeImageExportRequest): Promise<RangeImageExportResult>
  consumeExportRangeTsvChunks?(
    request: RangeTsvExportRequest,
    onChunk: RangeTsvChunkConsumer,
  ): Promise<RangeTsvChunkExportResult>
  readViewportSizeProjection?(
    request: ViewportSizeProjectionRequest,
  ): Promise<ViewportSizeProjectionResult>
  setCellInput(request: SetCellInputRequest): Promise<BackendMutationResult>
  setCellRichValue?(request: SetCellRichValueRequest): Promise<BackendMutationResult>
  importCells?(request: ImportCellsRequest): Promise<BackendMutationResult>
  importCellChunks?(request: ImportCellChunksRequest): Promise<BackendMutationResult>
  clearRange?(request: ClearRangeRequest): Promise<BackendMutationResult>
  insertRows?(request: InsertRowsRequest): Promise<BackendMutationResult>
  deleteRows?(request: DeleteRowsRequest): Promise<BackendMutationResult>
  insertColumns?(request: InsertColumnsRequest): Promise<BackendMutationResult>
  deleteColumns?(request: DeleteColumnsRequest): Promise<BackendMutationResult>
  setFormatRange?(request: SetFormatRangeRequest): Promise<BackendMutationResult>
  setRowHeight?(request: SetRowHeightRequest): Promise<BackendMutationResult>
  setColumnWidth?(request: SetColumnWidthRequest): Promise<BackendMutationResult>
  fillRange?(request: FillRangeRequest): Promise<BackendMutationResult>
  resolveDataEdge?(request: ResolveDataEdgeRequest): Promise<ResolveDataEdgeResult>
  addSheet?(request: AddSheetRequest): Promise<SheetMutationResult>
  renameSheet?(request: RenameSheetRequest): Promise<SheetMutationResult>
  deleteSheet?(request: DeleteSheetRequest): Promise<SheetMutationResult>
  reorderSheet?(request: ReorderSheetRequest): Promise<SheetMutationResult>
  undoTransaction?(request: UndoTransactionRequest): Promise<HistoryTransactionResult>
  redoTransaction?(request: RedoTransactionRequest): Promise<HistoryTransactionResult>
  listNamedRanges?(request: ListNamedRangesRequest): Promise<NamedRangeListResult>
  setNamedRange?(request: SetNamedRangeRequest): Promise<NamedRangeMutationResult>
  deleteNamedRange?(request: DeleteNamedRangeRequest): Promise<NamedRangeMutationResult>
  mergeRange?(request: MergeRangeRequest): Promise<BackendMutationResult>
  unmergeRange?(request: UnmergeRangeRequest): Promise<BackendMutationResult>
  readFreezeConfig?(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult>
  setFreezeConfig?(request: SetFreezeConfigRequest): Promise<BackendMutationResult>
  hideRows?(request: HideRowsRequest): Promise<BackendMutationResult>
  unhideRows?(request: UnhideRowsRequest): Promise<BackendMutationResult>
  hideColumns?(request: HideColumnsRequest): Promise<BackendMutationResult>
  unhideColumns?(request: UnhideColumnsRequest): Promise<BackendMutationResult>
  fillSeries?(request: FillSeriesRequest): Promise<BackendMutationResult>
  // comments & notes
  setNote?(request: SetNoteRequest): Promise<BackendMutationResult>
  clearNote?(request: ClearNoteRequest): Promise<BackendMutationResult>
  postComment?(request: PostCommentRequest): Promise<BackendMutationResult>
  resolveCommentThread?(request: ResolveCommentThreadRequest): Promise<BackendMutationResult>
  deleteComment?(request: DeleteCommentRequest): Promise<BackendMutationResult>
  // data validation
  setValidationRule?(request: SetValidationRuleRequest): Promise<BackendMutationResult>
  clearValidationRule?(request: ClearValidationRuleRequest): Promise<BackendMutationResult>
  // conditional formatting
  setConditionalFormatRule?(request: SetConditionalFormatRuleRequest): Promise<BackendMutationResult>
  removeConditionalFormatRule?(request: RemoveConditionalFormatRuleRequest): Promise<BackendMutationResult>
  listConditionalFormatRules?(request: ListConditionalFormatRulesRequest): Promise<ConditionalFormatRulesResult>
  // print config
  readPrintConfig?(request: ReadPrintConfigRequest): Promise<ReadPrintConfigResult>
  setPrintConfig?(request: SetPrintConfigRequest): Promise<BackendMutationResult>
  // find-replace
  /**
   * Match offsets are UTF-16 code-unit indexes into the selected target and use half-open
   * `[matchStart, matchEnd)` intervals. Every emitted span satisfies
   * `0 <= matchStart < matchEnd`; zero-width regex results are omitted.
   */
  searchRange?(request: SearchRangeRequest): Promise<SearchRangeResult>
  /**
   * Replacement spans use the same UTF-16 code-unit, half-open, non-empty contract as search
   * results. Zero-width and reversed spans are rejected before any mutation.
   */
  replaceMatches?(request: ReplaceMatchesRequest): Promise<ReplaceMatchesResponse>
  // presence
  subscribePresence?(handler: (update: PresenceUpdate) => void): SubscribePresenceUnsubscribe
  publishLocalPresence?(request: PublishLocalPresenceRequest): Promise<void>
  // filter-sort
  setFilterSort?(request: SetFilterSortRequest): Promise<BackendMutationResult>
  // protection — UI-core canonical (#40). These ports are an optional
  // persistence hook: `setSheetProtection` / `setRangeLock` receive a
  // fire-and-forget mirror of local commits and `readSheetProtection`
  // seeds a one-shot hydration. Backends that omit them keep the full
  // protection feature; enforcement runs in the UI-core mutation gateway.
  setSheetProtection?(request: SetSheetProtectionRequest): Promise<BackendMutationResult>
  setRangeLock?(request: SetRangeLockRequest): Promise<BackendMutationResult>
  readSheetProtection?(request: ReadSheetProtectionRequest): Promise<ReadSheetProtectionResult>
  // paste-special — Wave 7.3. Optional capability: host adapters that
  // omit this method cause the menu entry + dialog to hide via
  // `pasteSpecialSupportedAtom` so the surface degrades cleanly.
  pasteRange?(request: PasteRangeRequest): Promise<PasteRangeResult>
  // Optional fail-closed subdivision of the pasteRange capability (see
  // `PasteSpecialControllerPort.pasteRangeSupportedKinds`): a backend
  // that cannot apply the format leg declares only the value-leg kinds
  // and Core blocks the rest pre-dispatch. Absent → full trust.
  readonly pasteRangeSupportedKinds?: readonly PasteSpecialKind[]
  // remove-duplicates — Wave 7.5. Optional capability; host adapters that
  // omit this method cause the Data > Remove Duplicates menu entry to hide
  // via `removeDuplicatesSupportedAtom` so the surface degrades cleanly.
  removeRows?(request: RemoveRowsRequest): Promise<RemoveRowsResult>
  // custom-formulas — Wave 8. Optional capability; host adapters that
  // omit these methods make the `customFormulaRegistryAtom` inert
  // (writes succeed but no worker side-effect runs). `source` is the
  // body of a function whose argument is bound to `args` (Array) — the
  // adapter is expected to `new Function('args', source)` it inside
  // whichever runtime owns the formula engine. Errors thrown during
  // evaluation surface as `#ERROR!` cells. Wave 8.2: pass
  // `options.isAsync` to compile through the AsyncFunction constructor —
  // the cell holds `#BUSY!` until the returned Promise settles, and the
  // result is memoized per (name, args) until the next registry change.
  registerCustomFormula?(
    name: string,
    source: string,
    options?: { isAsync?: boolean },
  ): Promise<void>
  unregisterCustomFormula?(name: string): Promise<void>
  // content-change push — Wave 8.2. Optional capability: backends whose
  // engine can change cell content OUTSIDE a UI-initiated mutation
  // (async custom-formula settles, collaborative edits) invoke the
  // handler after such a change so the host refetches the visible
  // projection. Coarse signal, no payload — hosts must tolerate
  // spurious invocations. Backends whose content only ever changes in
  // response to their own mutation methods may omit it.
  subscribeContentChanges?(handler: () => void): () => void
}

export interface ViewportFreezeConfig {
  rows: number
  cols: number
}

export interface ReadFreezeConfigRequest extends SheetRef {
  kind: 'read-freeze-config'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ReadFreezeConfigResult extends SheetRef {
  kind: 'freeze-config'
  freeze: ViewportFreezeConfig
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SetFreezeConfigRequest extends SheetRef {
  kind: 'set-freeze-config'
  freeze: ViewportFreezeConfig
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

// --- presence ---

export interface PublishLocalPresenceRequest extends SheetRef {
  kind: 'publish-presence'
  selection: import('../selection/types').SelectionState
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export type SubscribePresenceUnsubscribe = () => void
