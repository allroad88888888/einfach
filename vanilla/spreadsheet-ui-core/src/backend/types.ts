import type { CellRange, SheetRef, SpreadsheetError } from '../shared'

export type ProjectionRequestId = number
export type ProjectionRevision = number | string
export type ProjectionRequestKind = 'visible-window' | 'range'

export type ProjectionRequestReason =
  | 'viewport'
  | 'selection'
  | 'keyboard'
  | 'formula-bar'
  | 'clipboard'
  | 'toolbar'
  | 'diagnostics'
  | 'test'

export interface ProjectionCancelToken {
  readonly cancelled: boolean
}

export interface DisplayCell {
  row: number
  col: number
  displayValue: string
  valueKind?: 'blank' | 'number' | 'string' | 'boolean' | 'error'
  formula?: string
  error?: SpreadsheetError
  formatKey?: string
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

export interface SetCellInputRequest extends SheetRef {
  kind: 'set-cell-input'
  row: number
  col: number
  input: string
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface BackendMutationResult extends SheetRef {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  affectedRange?: CellRange
}

export interface SpreadsheetBackend {
  readVisibleProjection(request: VisibleProjectionRequest): Promise<VisibleProjectionResult>
  readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult>
  setCellInput(request: SetCellInputRequest): Promise<BackendMutationResult>
}
