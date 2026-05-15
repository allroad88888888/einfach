import type { CellCoord, CellRange, SheetRef, SpreadsheetError } from '../shared'
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

export type {
  ClearNoteRequest,
  DeleteCommentRequest,
  PostCommentRequest,
  ResolveCommentThreadRequest,
  SetNoteRequest,
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
  formula?: string
  error?: SpreadsheetError
  formatKey?: string
  format?: SpreadsheetCellFormat
  mergedSpan?: MergeSpan
  mergeAnchor?: CellCoord
  noteIndicator?: boolean
  commentThreadId?: string
}

export type SpreadsheetAlignment = 'default' | 'left' | 'center' | 'right'

export type SpreadsheetNumberFormat =
  | { kind: 'general' }
  | { kind: 'decimal'; digits?: number; thousands?: boolean }
  | { kind: 'percent'; digits?: number }
  | { kind: 'currency'; symbol?: string; digits?: number }
  | { kind: 'date'; pattern?: string }

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
  fgColor?: string
  bgColor?: string
  borders?: SpreadsheetBorders
  underline?: boolean
  strikethrough?: boolean
  wrap?: boolean
  indent?: number
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

export interface ImportCellInput {
  row: number
  col: number
  input: string
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

export interface BackendMutationResult extends SheetRef {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  affectedRange?: CellRange
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
}

export interface SpreadsheetBackend {
  listSheets?(): Promise<SheetListResult>
  readVisibleProjection(request: VisibleProjectionRequest): Promise<VisibleProjectionResult>
  readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult>
  exportRangeTsv?(request: RangeTsvExportRequest): Promise<RangeTsvExportResult>
  consumeExportRangeTsvChunks?(
    request: RangeTsvExportRequest,
    onChunk: RangeTsvChunkConsumer,
  ): Promise<RangeTsvChunkExportResult>
  readViewportSizeProjection?(
    request: ViewportSizeProjectionRequest,
  ): Promise<ViewportSizeProjectionResult>
  setCellInput(request: SetCellInputRequest): Promise<BackendMutationResult>
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
