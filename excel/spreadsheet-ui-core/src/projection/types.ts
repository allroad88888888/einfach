import type {
  ProjectionCancelToken,
  ProjectionRequestReason,
  ProjectionRevision,
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
  readonly status: ProjectionStatus
  readonly request?: ProjectionRequest
  readonly result?: ProjectionResult
  readonly error?: SpreadsheetError
}

export interface ProjectionLimitOptions {
  readonly maxCells?: number
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
  readonly code: ProjectionValidationCode
  readonly message: string
  readonly range?: CellRange
  readonly cellCount?: number
  readonly maxCells?: number
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

interface BeginProjectionBaseInput {
  readonly sheetId: string
  readonly reason?: ProjectionRequestReason
  readonly revision?: ProjectionRevision
  readonly cancelToken?: ProjectionCancelToken
  /** Keeps the last visible result painted while a visible refresh is pending. */
  readonly retainResult?: boolean
  readonly maxCells?: number
}

export interface BeginVisibleProjectionInput extends BeginProjectionBaseInput {
  readonly kind: 'visible-window'
  readonly window: CellRange
}

export interface BeginRangeProjectionInput extends BeginProjectionBaseInput {
  readonly kind: 'range'
  readonly range: CellRange
  readonly reason: ProjectionRequestReason
}

export type BeginProjectionInput = BeginVisibleProjectionInput | BeginRangeProjectionInput

export type ProjectionBeginOutcome =
  | {
      readonly status: 'started'
      readonly request: ProjectionRequest
    }
  | {
      /** A visible request coalesced behind the one active transport. */
      readonly status: 'queued'
      readonly request: VisibleProjectionRequest
    }
  | {
      readonly status: 'busy'
    }
  | {
      readonly status: 'invalid'
      readonly error: ProjectionValidationError
    }
  | {
      readonly status: 'exhausted'
      readonly error: SpreadsheetError
    }

export interface ResolveProjectionInput {
  readonly request: ProjectionRequest
  readonly result: ProjectionResult
}

export type ProjectionResolveOutcome =
  | {
      readonly status: 'accepted'
      readonly result: ProjectionResult
      /** The latest visible request atomically promoted after this settlement. */
      readonly nextRequest?: VisibleProjectionRequest
    }
  | {
      readonly status: 'ignored'
      readonly reason: 'stale' | 'mismatch'
      /** Present only for an exact active mismatch that promoted a successor. */
      readonly nextRequest?: VisibleProjectionRequest
    }

export interface RejectProjectionInput {
  readonly request: ProjectionRequest
  readonly error: unknown
  readonly fallbackMessage?: string
}

export type ProjectionRejectOutcome =
  | {
      readonly status: 'rejected'
      readonly error: SpreadsheetError
      /** The latest visible request atomically promoted after this settlement. */
      readonly nextRequest?: VisibleProjectionRequest
    }
  | {
      readonly status: 'ignored'
      readonly reason: 'stale'
    }

export interface ReportProjectionErrorInput {
  readonly error: unknown
  readonly fallbackMessage?: string
  readonly code?: string
}
