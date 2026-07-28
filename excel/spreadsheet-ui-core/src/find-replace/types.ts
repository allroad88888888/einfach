import type { CellCoord, CellRange, SheetRef, SpreadsheetError } from '../shared'
import type { ProjectionRevision } from '../backend/types'

export type FindReplaceStatus = 'idle' | 'searching' | 'ready' | 'error'

export type FindReplaceCapability = 'unknown' | 'unsupported' | 'find-only' | 'find-and-replace'

export type FindReplaceScope = 'sheet' | 'workbook' | 'current-selection'

export type FindReplaceTab = 'find' | 'replace'

export type FindReplaceTarget = 'displayValue' | 'formula'

export interface FindReplaceOptions {
  readonly caseSensitive?: boolean
  readonly wholeMatch?: boolean
  readonly regex?: boolean
  readonly searchFormulas?: boolean
  readonly scope: FindReplaceScope
}

export interface FindReplaceQuery {
  readonly needle: string
  readonly replacement?: string
  readonly options: Readonly<FindReplaceOptions>
}

export interface FindReplaceFormState {
  readonly activeTab: FindReplaceTab
  readonly needle: string
  readonly replacement: string
  readonly caseSensitive: boolean
  readonly wholeMatch: boolean
  readonly regex: boolean
  readonly searchFormulas: boolean
  readonly scope: FindReplaceScope
}

export interface FindMatch {
  readonly coord: Readonly<CellCoord>
  readonly sheetId: string
  readonly matchStart: number
  readonly matchEnd: number
  /**
   * Canonical backend-owned haystack selector for this span. Legacy search
   * transports may omit it so Find can remain navigable, but guarded Replace
   * requires a valid target captured by the private result ticket.
   */
  readonly target?: FindReplaceTarget
}

export interface FindCursorState {
  readonly status: FindReplaceStatus
  readonly currentIndex: number
  readonly totalCount: number
  readonly pageMatches: readonly FindMatch[]
  readonly error?: Readonly<SpreadsheetError>
}

/**
 * Honest local projection cap surface (audit D-12). `pageMatches` is bounded
 * at `MAX_FIND_PAGE` (500), so a replace-all command can acknowledge at most
 * the current local page. This status reports only how many acknowledged
 * entries the local projection accepted; it never claims canonical workbook
 * state or durable replacement of any prefix.
 */
export interface ReplaceAllCapInfo {
  readonly acknowledgedProjectionCount: number
  readonly totalCount: number
}

export interface FindRangeRequest extends SheetRef {
  kind: 'find-range'
  query: FindReplaceQuery
  pageSize: number
  pageOffset: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface FindRangeResult extends SheetRef {
  kind: 'find-range'
  requestId?: number
  revision?: ProjectionRevision
  matches: FindMatch[]
  total: number
  pageOffset: number
  truncated?: boolean
}

export interface SearchRangeRequest extends SheetRef {
  kind: 'search-range'
  range: CellRange
  query: FindReplaceQuery
  pageStart: number
  pageSize: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface SearchRangeResult extends SheetRef {
  kind: 'search-range'
  matches: FindMatch[]
  pageStart: number
  totalCount: number
  /** Legacy transports may omit this; guarded core commands require the exact safe request id. */
  requestId?: number
  revision?: ProjectionRevision
}

export interface ReplaceMatchInput {
  sheetId: string
  coord: CellCoord
  matchStart: number
  matchEnd: number
  /** Required canonical haystack selector copied from the private accepted-search ticket. */
  target: FindReplaceTarget
}

export interface ReplaceMatchesRequest {
  kind: 'replace-matches'
  coords: ReplaceMatchInput[]
  replacement: string
  requestId?: number
  revision?: ProjectionRevision
}

export interface ReplaceMatchesResult {
  replacedCount: number
  /** Legacy transports may omit this; guarded core commands require the exact safe request id. */
  requestId?: number
  revision?: ProjectionRevision
}

/**
 * Contract-level evidence that a mutation was rejected before application.
 * Generic promise rejection is deliberately not equivalent to this result.
 */
export interface ReplaceMatchesNotAppliedResult {
  readonly kind: 'replace-matches-not-applied'
  readonly applied: false
  readonly requestId: number
  readonly error: Readonly<SpreadsheetError>
}

export type ReplaceMatchesResponse = ReplaceMatchesResult | ReplaceMatchesNotAppliedResult

/** Framework-neutral capability witness. The source is inspected and never retained. */
export interface FindReplaceControllerPort {
  searchRange?: (request: SearchRangeRequest) => Promise<SearchRangeResult>
  replaceMatches?: (request: ReplaceMatchesRequest) => Promise<ReplaceMatchesResponse>
}

/** Read-only capability projection used to gate Find/Replace entrypoints. */
export interface FindReplaceCapabilityProjection {
  readonly capability: FindReplaceCapability
  readonly findEnabled: boolean
  readonly replaceEnabled: boolean
}

/** Public read-only lifecycle view; transport tickets remain core-private. */
export interface FindReplaceLifecycleState {
  readonly open: boolean
  readonly sessionId: number
  readonly searchPending: boolean
  readonly mutationPending: boolean
  readonly refreshPending: boolean
  readonly refreshRecoveryRequired: boolean
  readonly hasTicketedResult: boolean
}

export type FindReplaceOperationAction = 'replace-current' | 'replace-all'

/** Read-only, bounded diagnostic view of mutation transport evidence. */
export type FindReplaceOperationDiagnosticStatus = 'pending' | 'acknowledged' | 'outcome-unknown'

export interface FindReplaceOperationDiagnostic {
  readonly operationId: string
  readonly requestedCount: number
  readonly status: FindReplaceOperationDiagnosticStatus
  /** A later canonical search has reconciled this outcome-unknown entry. */
  readonly reconciled: boolean
}

export interface FindReplaceOperationDiagnostics {
  readonly count: number
  readonly pendingCount: number
  readonly acknowledgedCount: number
  readonly outcomeUnknownCount: number
  readonly unreconciledOutcomeUnknownCount: number
  readonly entries: readonly FindReplaceOperationDiagnostic[]
}

export type FindReplaceRefreshRecoveryStatus = 'idle' | 'required' | 'refreshing'

export type FindReplaceRefreshRecoveryPhase = 'projection' | 'search'

/**
 * Explicit read-only recovery surface after an acknowledged mutation needs a
 * refresh, or after a dispatched mutation has an unknown outcome. Recovery
 * never contains or authorizes a mutation transport.
 */
export interface FindReplaceRefreshRecoveryState {
  readonly status: FindReplaceRefreshRecoveryStatus
  readonly operationId: string | null
  readonly phase: FindReplaceRefreshRecoveryPhase | null
  readonly error?: Readonly<SpreadsheetError>
}

export interface RunFindReplaceSearchInput {
  readonly searchRange?: (request: SearchRangeRequest) => Promise<SearchRangeResult>
  readonly revision?: ProjectionRevision
  /** Positive safe integer <= 2_147_483_647; invalid values use the core default. */
  readonly timeoutMs?: number
}

export interface RunFindReplaceMutationInput {
  readonly action: FindReplaceOperationAction
  readonly replaceMatches?: (request: ReplaceMatchesRequest) => Promise<ReplaceMatchesResponse>
  /** Required for the guarded post-acknowledgement re-search. */
  readonly searchRange?: (request: SearchRangeRequest) => Promise<SearchRangeResult>
  /**
   * Optional expected witness for the current Find result. Core rejects a
   * mismatch; this value can never replace the response-owned revision.
   */
  readonly revision?: ProjectionRevision
  /** Positive safe integer <= 2_147_483_647; invalid values use the core default. */
  readonly timeoutMs?: number
  /** Accepts a fulfilled response without claiming it is canonical. */
  readonly acceptAcknowledgedResult?: (
    result: ReplaceMatchesResult,
    request: ReplaceMatchesRequest,
  ) => Promise<void> | void
}

/**
 * Runs only projection acceptance (when an exact acknowledgement exists) and
 * canonical search reconciliation. There is deliberately no `replaceMatches`
 * port on this command.
 */
export interface RunFindReplaceRefreshRecoveryInput {
  readonly searchRange?: (request: SearchRangeRequest) => Promise<SearchRangeResult>
  /** Positive safe integer <= 2_147_483_647; invalid values use the core default. */
  readonly timeoutMs?: number
  readonly acceptAcknowledgedResult?: (
    result: ReplaceMatchesResult,
    request: ReplaceMatchesRequest,
  ) => Promise<void> | void
}
