import type {
  BackendMutationResult,
  ClearRangeRequest,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  FillRangeRequest,
  ImportCellInput,
  ImportCellsRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  ReorderSheetRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
  SetColumnWidthRequest,
  SetFormatRangeRequest,
  SetRowHeightRequest,
  SheetListResult,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  SpreadsheetNumberFormat,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

export type StaticSeedValue = string | number | boolean | null | undefined

export type StaticSeedMatrix = readonly (readonly StaticSeedValue[])[]

export type StaticSeedCells = readonly DisplayCell[]

export interface StaticSpreadsheetSeed {
  revision?: ProjectionRevision
  sheets?: readonly (string | StaticSpreadsheetSheetInput)[]
  matrix?: StaticSeedMatrix
  cells?: StaticSeedCells
}

export interface StaticSpreadsheetSheetInput {
  id?: string
  name: string
}

export type StaticSpreadsheetSeedInput = StaticSeedMatrix | StaticSeedCells | StaticSpreadsheetSeed

export type StaticProjectionRequest =
  | VisibleProjectionRequest
  | RangeProjectionRequest

export type StaticProjectionResult =
  | VisibleProjectionResult
  | RangeProjectionResult

export type StaticSpreadsheetMutationResult = BackendMutationResult
export type StaticSpreadsheetSheetMutationResult = SheetMutationResult

export type {
  BackendMutationResult,
  ClearRangeRequest,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  FillRangeRequest,
  ImportCellInput,
  ImportCellsRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  ReorderSheetRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
  SetColumnWidthRequest,
  SetFormatRangeRequest,
  SetRowHeightRequest,
  SheetListResult,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  SpreadsheetNumberFormat,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
}
