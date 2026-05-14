import type {
  BackendMutationResult,
  ClearRangeRequest,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  InsertColumnsRequest,
  InsertRowsRequest,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  SetCellInputRequest,
  SetFormatRangeRequest,
  SheetListResult,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  SpreadsheetNumberFormat,
  VisibleProjectionRequest,
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
  InsertColumnsRequest,
  InsertRowsRequest,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  SetCellInputRequest,
  SetFormatRangeRequest,
  SheetListResult,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  SpreadsheetNumberFormat,
  VisibleProjectionRequest,
  VisibleProjectionResult,
}
