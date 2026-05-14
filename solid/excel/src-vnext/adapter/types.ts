import type {
  BackendMutationResult,
  DisplayCell,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

export type StaticSeedValue = string | number | boolean | null | undefined

export type StaticSeedMatrix = readonly (readonly StaticSeedValue[])[]

export type StaticSeedCells = readonly DisplayCell[]

export interface StaticSpreadsheetSeed {
  revision?: ProjectionRevision
  matrix?: StaticSeedMatrix
  cells?: StaticSeedCells
}

export type StaticSpreadsheetSeedInput = StaticSeedMatrix | StaticSeedCells | StaticSpreadsheetSeed

export type StaticProjectionRequest =
  | VisibleProjectionRequest
  | RangeProjectionRequest

export type StaticProjectionResult =
  | VisibleProjectionResult
  | RangeProjectionResult

export type StaticSpreadsheetMutationResult = BackendMutationResult

export type {
  BackendMutationResult,
  DisplayCell,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
}
