import type { CellRange, SheetRef } from '../shared'
import type {
  ProjectionRequestId,
  ProjectionRevision,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
} from '../backend/types'

export type SortDirection = 'asc' | 'desc'

export interface SortDirective {
  colIndex: number
  direction: SortDirection
}

export type ColumnFilterRule =
  | { kind: 'equals'; colIndex: number; value: string; caseSensitive?: boolean }
  | { kind: 'contains'; colIndex: number; value: string; caseSensitive?: boolean }
  | { kind: 'range'; colIndex: number; min?: number; max?: number }
  | { kind: 'list'; colIndex: number; values: readonly string[] }

export interface FilterSortState {
  rules: readonly ColumnFilterRule[]
  directives: readonly SortDirective[]
}

export type FilterSortStateBySheet = Record<string, FilterSortState>

export interface FilterDropdownState {
  status: 'closed' | 'open'
  sheetId?: string
  colIndex?: number
}

export interface SetFilterSortRequest extends SheetRef {
  kind: 'set-filter-sort'
  rules: readonly ColumnFilterRule[]
  directives: readonly SortDirective[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface FilterSortMutationResult extends SheetRef {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

/** Framework-neutral command port. The source is passed to commands and is never retained. */
export interface FilterSortControllerPort {
  setFilterSort?: (request: SetFilterSortRequest) => Promise<FilterSortMutationResult>
}

export type FilterSortEntrypoint = 'toolbar' | 'menu-bar'

export interface FilterSortEntrypointTarget {
  readonly sheetId: string
  readonly colIndex: number
}

export type FilterSortEntrypointStatus =
  | 'idle'
  | 'blocked'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'refresh-failed'
  | 'outcome-unknown'
  | 'error'
  | 'stale'

export interface FilterSortEntrypointState {
  readonly status: FilterSortEntrypointStatus
  readonly operationId: number | null
  readonly requestId: ProjectionRequestId | null
  readonly entrypoint: FilterSortEntrypoint | null
  readonly target: FilterSortEntrypointTarget | null
  readonly direction: SortDirection | null
  readonly attempt: number
  readonly error: string
}

export interface FilterSortEntrypointProjection extends FilterSortEntrypointState {
  readonly capabilityAvailable: boolean
  readonly disabled: boolean
  readonly disabledReason: string | null
  readonly pending: boolean
}

export interface RunFilterSortEntrypointInput {
  readonly source: FilterSortControllerPort
  readonly entrypoint: FilterSortEntrypoint
  readonly direction: SortDirection
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export interface RetryFilterSortRefreshInput {
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export type FilterConditionKind = 'none' | 'equals' | 'contains' | 'range'

export interface FilterSortDraftState {
  readonly sessionId: number
  readonly sheetId: string | null
  readonly colIndex: number | null
  readonly searchInput: string
  readonly selectedValues: readonly string[]
  readonly selectionMode: 'all' | 'explicit'
  readonly conditionKind: FilterConditionKind
  readonly equalsInput: string
  readonly containsInput: string
  readonly rangeMinInput: string
  readonly rangeMaxInput: string
  readonly availableValues: readonly string[]
}

export type FilterSortDraftPatch = Partial<
  Pick<
    FilterSortDraftState,
    | 'searchInput'
    | 'selectedValues'
    | 'selectionMode'
    | 'conditionKind'
    | 'equalsInput'
    | 'containsInput'
    | 'rangeMinInput'
    | 'rangeMaxInput'
  >
>

export type FilterSortLifecycleStatus =
  | 'closed'
  | 'editing'
  | 'blocked'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'refresh-failed'
  | 'outcome-unknown'
  | 'error'

export interface FilterSortLifecycleState {
  readonly status: FilterSortLifecycleStatus
  readonly sessionId: number
  readonly requestId: ProjectionRequestId | null
  readonly sheetId: string | null
  readonly colIndex: number | null
}

export type FilterSortMutationIntent =
  | { readonly kind: 'sort'; readonly direction: SortDirection }
  | { readonly kind: 'clear-sort' }
  | { readonly kind: 'clear-filter' }
  | { readonly kind: 'clear-column' }
  | { readonly kind: 'apply-draft' }

export interface RunFilterSortMutationInput {
  readonly source: FilterSortControllerPort
  readonly sessionId: number
  readonly intent: FilterSortMutationIntent
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export interface UpdateFilterSortDraftInput {
  readonly sessionId: number
  readonly patch: FilterSortDraftPatch
}

export interface UpdateFilterSortAvailableValuesInput {
  readonly sessionId: number
  readonly sheetId: string
  readonly colIndex: number
  readonly values: readonly string[]
}

// --- engine physical sort (design-engine-sort S5) ---------------------------
//
// The toolbar / menu sort entrypoints dispatch ONE command
// (`runPhysicalSortAtom`). When the host backend exposes the `sortRange`
// port the command physically reorders workbook data through it (engine
// DATA fact, #29); otherwise — and whenever a physical sort is not
// applicable (no resolved range, or an active column filter the engine
// cannot yet honour) — it delegates to the existing display-permutation
// entrypoint (`runFilterSortEntrypointAtom`). The split is capability
// driven and transparent to the caller; wholesale removal of the display
// permutation path is deferred (design-engine-sort #19).

/**
 * Framework-neutral transport for the physical-sort command. A host
 * backend that reorders engine data exposes `sortRange`; the optional
 * `setFilterSort` inherited from `FilterSortControllerPort` is the
 * display-permutation fallback. The command retains neither.
 */
export interface PhysicalSortControllerPort extends FilterSortControllerPort {
  sortRange?: (request: SortRangeRequest) => Promise<SortRangeResult>
}

export interface RunPhysicalSortInput {
  readonly source: PhysicalSortControllerPort
  readonly entrypoint: FilterSortEntrypoint
  readonly direction: SortDirection
  /**
   * The data region to physically reorder, header row already excluded by
   * the caller (its first row is a data row). `null` means the caller could
   * not resolve a region (e.g. the backend exposes no `resolveDataEdge`),
   * which routes the command to the display-permutation fallback.
   */
  readonly range: CellRange | null
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

/**
 * User-readable evidence that a physical sort was rejected before it wrote
 * any data. Surfaced as a UI-core view fact so a host can render a toast /
 * inline prompt; cleared on the next dispatch and on a successful sort.
 */
export interface PhysicalSortDiagnostic {
  readonly code: SortRangeRejectionCode
  readonly message: string
  /** Present only for `spill-in-range` — the intersecting anchor (A1). */
  readonly anchor?: string
}
