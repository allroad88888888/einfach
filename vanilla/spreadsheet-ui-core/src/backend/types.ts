import type { CellCoord, CellRange, SheetRef, SpreadsheetError } from '../shared'
import type { SetFilterSortRequest, SortDirection } from '../filter-sort/types'
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
import type {
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
  TableMutationResult,
  TableTotalsFunction,
} from '../tables/types'

// --- tables (Excel Table CRUD — parity #32) ---
export type {
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
  TableMutationResult,
  TableTotalsFunction,
}

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
  /**
   * FILTER-hidden source rows the export must NOT emit (§8.2 of
   * `solid/excel/docs/online-excel-parity/design-filter-hidden-rows.md`).
   *
   * Why this is an INPUT rather than something the adapter looks up:
   * filter visibility is a UI-core view fact (CANONICAL_OWNERSHIP §2 —
   * "UI-core 是唯一权威；backend 端口降级为可选持久化钩子"). The port is an
   * executor, never the authority. An adapter that consulted its own
   * `setFilterSort` snapshot would become a second source of truth and
   * could disagree with the live atom the small-range copy path reads —
   * which is precisely the size-dependent divergence this parameter
   * exists to remove.
   *
   * Contract for implementors:
   *   - Omitted / empty means "emit every row in the range", which is the
   *     pre-hardening behaviour and the only behaviour reachable until the
   *     S5 adapter flip stops compacting filtered rows out of the range.
   *   - Rows are 0-based SOURCE rows in the same coordinate space as
   *     `range`. Rows outside `range` are simply irrelevant.
   *   - `originAddr` in the result must name the first EMITTED row, not
   *     `range.rowStart` — it anchors relative-formula shifting on paste.
   *   - Chunked implementations must not emit a chunk that filters down to
   *     zero rows; the caller joins chunk texts with `\n` and an empty
   *     chunk would inject a blank line.
   *
   * This carries the FILTER subset only, never the manual ∪ filter union:
   * Excel skips filtered-out rows on copy but copies manually hidden rows
   * normally.
   */
  hiddenRows?: ReadonlySet<number> | readonly number[]
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
  /**
   * FILTER-hidden source rows the render must skip — same ownership
   * contract and same coordinate space as `RangeTsvExportRequest.hiddenRows`.
   *
   * An image renderer has one obligation the text encoders do not: the
   * output GEOMETRY must shrink too. Skipping the paint while still summing
   * every row height into the canvas size yields a PNG with a blank band at
   * the bottom exactly as tall as the hidden rows. Implementors must drop
   * hidden rows from the height sum as well as from the paint.
   */
  hiddenRows?: ReadonlySet<number> | readonly number[]
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

/**
 * Engine evaluation-input push for the hidden-row set (parity #23 —
 * SUBTOTAL 101-111 exclude manually hidden rows). Hidden rows are a
 * UI-core canonical VIEW fact (`viewportHiddenAtom`); this port mirrors
 * the per-sheet set into the formula engine so the 101-111 SUBTOTAL
 * variants can drop hidden data rows at eval time. Unlike a mutation it
 * carries NO exact ACK / undo — it is a whole-set REPLACE (idempotent;
 * repeated identical pushes are safe, an empty `rows` clears the set) and
 * fire-and-forget. Optional capability: a backend whose engine models no
 * hidden-row eval input omits the port and UI core silently skips the
 * push — SUBTOTAL 101-111 then degrades to "does not exclude" (the same
 * result as SUBTOTAL 1-11), never breaking any other feature.
 */
export interface SetEvalHiddenRowsRequest extends SheetRef {
  kind: 'set-eval-hidden-rows'
  /** 0-based hidden row indices; whole-set replace. Empty clears the sheet's set. */
  rows: readonly number[]
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

/**
 * ACK for `setFilterSort`, carrying the visibility answer back to UI core
 * (`design-filter-hidden-rows` §4.2, slice S5).
 *
 * The rules are applied by a WHOLE-COLUMN predicate scan the host already
 * runs; `hiddenRowIndices` is that scan's other projection. It must be the
 * complete answer for the scanned extent — never a window-bounded subset —
 * because UI core stores it as canonical view truth and never re-derives it.
 */
export interface SetFilterSortResult extends BackendMutationResult {
  /**
   * 0-based SOURCE rows the rules filtered out. ABSENT means the host cannot
   * compute visibility at all: UI core then clears its filter-hidden set
   * rather than guessing, so the feature degrades to "rules recorded, nothing
   * hidden" instead of hiding the wrong rows. An empty array is the distinct
   * (and normal) statement "the rules hid nothing".
   */
  hiddenRowIndices?: readonly number[]
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

// --- engine physical sort (sortRange) — design-engine-sort ---

/**
 * One physical-sort key. `col` is a 0-based ABSOLUTE column index that
 * MUST fall inside the sort range's column span. `direction` defaults to
 * `'asc'` and `caseSensitive` to `false` (Excel defaults) when omitted.
 */
export interface SortRangeKey {
  col: number
  direction?: SortDirection
  caseSensitive?: boolean
}

/**
 * Engine physical sort request (parity #29 — sort execution is an engine
 * DATA fact, not a UI display permutation). The visible rows inside
 * `range` are stably reordered by `keys` while `excludedRows` (0-based
 * SOURCE rows the host assembles from hidden ∪ filtered-out ∪ summary
 * rows) stay in place. The adapter de-dupes `excludedRows` and clips
 * them to the range; entries outside it are ignored.
 */
export interface SortRangeRequest extends SheetRef {
  kind: 'sort-range'
  range: CellRange
  keys: readonly SortRangeKey[]
  excludedRows?: readonly number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

/**
 * Applied witness for a physical sort. `movedRows` / `movedCells` count
 * the change (`0` on a no-op sort, which still resolves applied and bumps
 * the revision). `affectedRange` echoes the sorted range. `rowPermutation`
 * is `[[slotRow, sourceRow], …]` over the CHANGED slots only — reserved
 * for overlay remap / parity; v1 consumers may ignore it.
 */
export interface SortRangeAppliedResult extends SheetRef {
  kind: 'sort-range'
  applied: true
  movedRows: number
  movedCells: number
  affectedRange: CellRange
  rowPermutation?: ReadonlyArray<readonly [number, number]>
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

/**
 * Structured reject reasons a physical sort surfaces BEFORE writing any
 * data. The first five mirror the engine gates; `source-too-large` and
 * `merge-in-range` are the adapter's own pre-dispatch authority gates
 * (source-size cap and merge registry — the engine models neither).
 */
export type SortRangeRejectionCode =
  | 'invalid-range'
  | 'empty-keys'
  | 'key-out-of-range'
  | 'spill-in-range'
  | 'invalid-payload'
  | 'source-too-large'
  | 'merge-in-range'

/**
 * Contract-level evidence that a physical sort was rejected before
 * application — nothing was written, no undo entry recorded, and
 * `revision` is the current (un-bumped) witness. Generic promise
 * rejection is deliberately NOT equivalent to this result.
 */
export interface SortRangeRejectedResult extends SheetRef {
  kind: 'sort-range-not-applied'
  applied: false
  code: SortRangeRejectionCode
  /** Present only for `spill-in-range` — the intersecting anchor (A1). */
  anchor?: string
  message?: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export type SortRangeResult = SortRangeAppliedResult | SortRangeRejectedResult

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
  // engine hidden-row eval input (parity #23). Optional, fire-and-forget
  // whole-set REPLACE (no exact ACK / undo): mirrors the UI-core canonical
  // hidden-row VIEW fact into the engine so SUBTOTAL 101-111 can exclude
  // manually hidden data rows. A backend whose engine models no such input
  // omits the port; UI core silently skips the push and SUBTOTAL 101-111
  // degrades to "does not exclude" without disturbing any other feature.
  setEvalHiddenRows?(request: SetEvalHiddenRowsRequest): Promise<void> | void
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
  // Resolves the ordinary mutation ACK PLUS the filter-hidden row set the
  // rule scan produced (`SetFilterSortResult.hiddenRowIndices`). Widening the
  // result is backward compatible: a host that returns a bare
  // `BackendMutationResult` still satisfies this signature, and UI core reads
  // the missing field as "cannot compute visibility" and hides nothing.
  setFilterSort?(request: SetFilterSortRequest): Promise<SetFilterSortResult>
  // engine physical sort — design-engine-sort. Optional capability: host
  // adapters whose runtime cannot physically reorder workbook data omit
  // this port (the TS worker declares `sortRange: false`), which hides
  // the physical-sort entry through the standard degradation contract.
  // Unlike `setFilterSort` (a UI-core VIEW fact / display permutation),
  // this reorders engine DATA; undo is host-orchestrated (one bounded
  // range-snapshot transaction). Resolves an applied report OR a
  // structured not-applied result — a gated request does NOT reject the
  // promise.
  sortRange?(request: SortRangeRequest): Promise<SortRangeResult>
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
  // tables — Excel Table CRUD (parity #32, design-excel-table.md §10).
  // Optional capability family: host adapters whose engine has no Table
  // model omit these ports (the TS worker declares `structuredTables:
  // false`, the static backend implements none), which hides every Table
  // entry through the standard method-presence degradation contract. The
  // engine registry is canonical (CANONICAL_OWNERSHIP §3 #32) — these are
  // the only path UI core reads a table's geometry; it stores no second
  // copy. `createTable` resolves the engine-assigned canonical name OR a
  // structured `TableMutationRejectedResult` (name conflict / range
  // overlap / cap 256 / …) rather than rejecting the promise; rename and
  // delete follow the same applied-or-structured-reject convention.
  // Table-definition undo is NOT wired in this slice (design §11/§12
  // known gap — persistence and the snapshot primitive do not carry the
  // table registry).
  createTable?(request: CreateTableRequest): Promise<CreateTableResult>
  renameTable?(request: RenameTableRequest): Promise<TableMutationResult>
  renameTableColumn?(request: RenameTableColumnRequest): Promise<TableMutationResult>
  deleteTable?(request: DeleteTableRequest): Promise<TableMutationResult>
  listTables?(request: ListTablesRequest): Promise<ListTablesResult>
  getTable?(request: GetTableRequest): Promise<GetTableResult>
  // Totals row (parity #32 T6, design-excel-table.md §7). Optional
  // subdivision of the Table capability family — the same
  // `structuredTables` witness gates them, so a backend whose engine has no
  // Table model omits them alongside the CRUD ports and UI core hides the
  // totals toggle through the standard method-presence contract. Both
  // resolve the shared applied-or-structured-reject convention: a gated
  // request (row-below occupied → `totals-row-blocked`, function before the
  // row is enabled → `no-totals-row`, unknown aggregate id →
  // `invalid-totals-function`) resolves a `TableMutationRejectedResult`
  // rather than rejecting the promise. Not undoable in this slice (design
  // §11/§12 known gap; the SUBTOTAL cell writes are covered by the existing
  // cell snapshots, the registry geometry change is not).
  setTableTotalsRow?(request: SetTableTotalsRowRequest): Promise<TableMutationResult>
  setTableTotalFunction?(request: SetTableTotalFunctionRequest): Promise<TableMutationResult>
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
