import type { ProjectionRequestId, ProjectionRevision } from '../backend/types'

export type HistoryTransactionId = string
export type HistoryAction = 'undo' | 'redo'

export type HistoryEntryKind =
  | 'cell.set-input'
  | 'cells.import'
  | 'range.clear'
  | 'range.fill'
  | 'range.merge'
  | 'range.unmerge'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'sheet.add'
  | 'sheet.delete'
  | 'sheet.rename'
  | 'sheet.reorder'
  | 'format.set'

export interface HistoryAffectedRange {
  readonly rowStart: number
  readonly rowEnd: number
  readonly colStart: number
  readonly colEnd: number
}

export interface HistoryEntry {
  readonly transactionId: HistoryTransactionId
  readonly kind: HistoryEntryKind
  readonly sheetId: string | null
  readonly projectionRevision: ProjectionRevision
  readonly affectedRange?: Readonly<HistoryAffectedRange>
}

export interface HistoryStackState {
  readonly entries: readonly HistoryEntry[]
  readonly cursor: number
  /** Transport activity only. Terminal uncertainty is exposed by `historyLifecycleAtom`. */
  readonly inFlight: boolean
}

export type HistoryLifecycleStatus =
  | 'ready'
  | 'blocked'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'refresh-failed'
  | 'outcome-unknown'

export interface HistoryLifecycleState {
  readonly status: HistoryLifecycleStatus
  readonly sessionId: number
  readonly action: HistoryAction | null
  readonly transactionId: HistoryTransactionId | null
  readonly requestId: ProjectionRequestId | null
  /** Revision witness sent with the frozen mutation request. */
  readonly revision: ProjectionRevision | null
  /** Backend revision accepted only after strict acknowledgement correlation. */
  readonly acknowledgedRevision: ProjectionRevision | null
  readonly error: string
}

export interface HistoryUndoRequest {
  readonly kind: 'undo-transaction'
  readonly transactionId: HistoryTransactionId
  readonly requestId: ProjectionRequestId
  readonly revision: ProjectionRevision
}

export interface HistoryRedoRequest {
  readonly kind: 'redo-transaction'
  readonly transactionId: HistoryTransactionId
  readonly requestId: ProjectionRequestId
  readonly revision: ProjectionRevision
}

/** Runtime correlation remains strict even though backend result fields are optional. */
export interface HistoryMutationResult {
  readonly transactionId: HistoryTransactionId
  readonly requestId?: ProjectionRequestId
  readonly revision?: ProjectionRevision
}

/** Framework-neutral history transport port. Core never retains this object. */
export interface HistoryControllerPort {
  undoTransaction?: (request: HistoryUndoRequest) => Promise<HistoryMutationResult>
  redoTransaction?: (request: HistoryRedoRequest) => Promise<HistoryMutationResult>
}

export type HistoryCommandOutcome = 'completed' | 'blocked' | 'refresh-failed' | 'outcome-unknown'

export interface RunHistoryCommandInput {
  readonly source: HistoryControllerPort
  readonly refreshProjection: () => Promise<void>
  /** Mutation acknowledgement timeout. Defaults to `DEFAULT_HISTORY_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

export interface RetryHistoryRefreshInput {
  readonly refreshProjection: () => Promise<void>
  /** Refresh-only retry timeout. Defaults to `DEFAULT_HISTORY_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}
