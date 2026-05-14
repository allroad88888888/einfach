import type {
  RangeProjectionRequest,
  RangeProjectionResult,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '../backend'
import type { CellRange, SpreadsheetError } from '../shared'

export type ProjectionRequest = VisibleProjectionRequest | RangeProjectionRequest
export type ProjectionResult = VisibleProjectionResult | RangeProjectionResult

export type ProjectionStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ProjectionSnapshot {
  status: ProjectionStatus
  request?: ProjectionRequest
  result?: ProjectionResult
  error?: SpreadsheetError
}

export interface ProjectionLimitOptions {
  maxCells?: number
}

export type ProjectionValidationCode =
  | 'INVALID_SHEET'
  | 'INVALID_REQUEST_ID'
  | 'INVALID_RANGE'
  | 'EMPTY_RANGE'
  | 'RANGE_TOO_LARGE'
  | 'RESULT_TOO_LARGE'
  | 'CELL_OUT_OF_RANGE'
  | 'STALE_RESULT'

export interface ProjectionValidationError {
  code: ProjectionValidationCode
  message: string
  range?: CellRange
  cellCount?: number
  maxCells?: number
}

export type ProjectionValidationResult =
  | {
      ok: true
      cellCount: number
    }
  | {
      ok: false
      error: ProjectionValidationError
    }
