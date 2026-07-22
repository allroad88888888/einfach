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
  | 'range.sort'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'sheet.add'
  | 'sheet.delete'
  | 'sheet.rename'
  | 'sheet.reorder'
  | 'format.set'
  | 'viewport.freeze'
  | 'viewport.hidden'
  | 'outline'
  /**
   * Any Excel Table definition change (create / rename / rename column /
   * delete / totals-row toggle). One kind for the whole family: the adapter
   * records one transaction per definition change and these entries align
   * with it positionally, so the distinction is cosmetic here.
   */
  | 'table.define'
  /**
   * A filter APPLY or CLEAR that actually changed a sheet's committed filter
   * (Excel parity: applying/clearing an AutoFilter is undoable). One entry per
   * changed `setFilterSort`, aligned positionally with the adapter's
   * `filtersSnapshot` transaction record; a no-op apply/clear records neither
   * side. Undo/redo restores the engine's owned filter from its own
   * `snapshotFilters`/`restoreFilters` primitive (worker) or delta (static),
   * after which the provider re-hydrates the rules + hidden render caches from
   * the engine — no UI-core local-replay payload rides the entry.
   */
  | 'filter.set'

export interface HistoryAffectedRange {
  readonly rowStart: number
  readonly rowEnd: number
  readonly colStart: number
  readonly colEnd: number
}

export type HistoryLocalReplayDirection = 'undo' | 'redo'

/**
 * Payload for entries that replay inside UI-core instead of through a
 * backend transaction. `applyKey` names an applier registered via
 * `registerHistoryLocalReplayApplier`; `before` / `after` are the exact
 * state snapshots the applier writes on undo / redo respectively.
 */
export interface HistoryLocalReplayPayload {
  readonly applyKey: string
  readonly sheetId: string
  readonly before: unknown
  readonly after: unknown
}

export interface HistoryEntry {
  readonly transactionId: HistoryTransactionId
  readonly kind: HistoryEntryKind
  readonly sheetId: string | null
  readonly projectionRevision: ProjectionRevision
  readonly affectedRange?: Readonly<HistoryAffectedRange>
  /**
   * Present only on local-replay entries (UI-core canonical view facts,
   * e.g. freeze). Undo/redo of such entries never touches the backend
   * `undoTransaction` / `redoTransaction` ports and does not consume the
   * backend projection-revision witness.
   */
  readonly localReplay?: Readonly<HistoryLocalReplayPayload>
  /**
   * Optional side payloads on backend-transaction entries. A structural
   * backend mutation can displace UI-core canonical view facts (freeze
   * band, hidden index sets); inverting the structural shift cannot
   * restore them (a delete erases index membership), so the operation
   * snapshots the affected view facts as before/after payloads. After the
   * backend acknowledges the transaction's undo/redo, each payload
   * replays through the same local-replay applier registry to restore the
   * local view facts. Mutually exclusive with `localReplay`.
   */
  readonly localSidePayloads?: readonly Readonly<HistoryLocalReplayPayload>[]
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
  /**
   * Structured not-applied witness (host-orchestrated undo, design point
   * C). `false` means the backend POSITIVELY confirmed it did not replay
   * the transaction (unknown transactionId, missing/degraded snapshot).
   * The stack cursor does not move and the acknowledged revision is not
   * committed; the lifecycle surfaces the outcome-unknown convention so
   * hosts re-read canonical state. Absent or `true` means applied.
   */
  readonly applied?: boolean
  /** Human-readable reason accompanying `applied: false`. */
  readonly notAppliedReason?: string
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
