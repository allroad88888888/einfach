import type { CellRange, SheetRef } from '../shared'
import type {
  ProjectionRequestId,
  ProjectionRevision,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
} from '../backend/types'

export type SortDirection = 'asc' | 'desc'

export type ColumnFilterRule =
  | { kind: 'equals'; colIndex: number; value: string; caseSensitive?: boolean }
  | { kind: 'contains'; colIndex: number; value: string; caseSensitive?: boolean }
  | { kind: 'range'; colIndex: number; min?: number; max?: number }
  | { kind: 'list'; colIndex: number; values: readonly string[] }

/**
 * Column filter visibility only. Sort is NOT part of this state: the display
 * permutation was retired with #29/#24 — sorting is a physical engine DATA
 * mutation dispatched through `runPhysicalSortAtom` / the `sortRange` port,
 * never a view directive.
 */
export interface FilterSortState {
  rules: readonly ColumnFilterRule[]
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
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  /**
   * When `true`, the backend records an UNDOABLE transaction iff this apply /
   * clear actually changes the sheet's committed filter (Excel parity). The
   * backend is the sole judge of "changed" and reports its verdict back in
   * `SetFilterSortResult.historyRecorded`, which UI core mirrors with exactly
   * one paired history entry so the two undo stacks stay aligned entry-for-
   * entry. Absent / `false` keeps the legacy non-undoable behaviour (Reapply
   * passes `false`; a no-op apply records on neither side regardless).
   */
  recordHistory?: boolean
}

export interface FilterSortMutationResult extends SheetRef {
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  /**
   * Exact backend transaction verdict for Apply / Clear. `true` pairs with
   * one UI-core `filter.set` descriptor; explicit `false` proves that the
   * adapter recorded no undo step. Current mutation commands reject absence as
   * an uncertain outcome so the UI and backend undo stacks cannot silently
   * skew.
   */
  historyRecorded?: boolean
  /**
   * 0-based SOURCE rows the applied rules filtered out, for the WHOLE scanned
   * extent — never a window-bounded subset (`design-filter-hidden-rows` §4.2).
   * UI core stores this verbatim in `viewportFilterHiddenAtom`, which is the
   * canonical answer to "is this row painted?" from then on; nothing re-derives
   * it from the projection.
   *
   * Apply / Clear requires this explicit whole-column snapshot. Reapply keeps
   * the compatibility behaviour that ABSENT clears the old set when a host
   * cannot recompute visibility. An empty array explicitly says the rules hid
   * nothing.
   */
  hiddenRowIndices?: readonly number[]
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

/**
 * `Data → Reapply` (Excel `Ctrl+Alt+L`). Re-runs the sheet's ALREADY COMMITTED
 * rules through the host's whole-column scan and re-commits the answer, which
 * is the escape hatch snapshot semantics requires: filter visibility is taken
 * once when the rules are applied and does NOT follow later cell edits, so
 * without this the only refresh path is re-opening the column dropdown.
 *
 * It carries no rules of its own — that is the point. The rules are read from
 * `filterSortStateAtom`, so Reapply can never change what is filtered, only
 * which rows currently satisfy it.
 */
export interface ReapplyFilterInput {
  readonly source: FilterSortControllerPort
  readonly entrypoint: FilterSortEntrypoint
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Core-owned deadline for each transport / refresh phase. Defaults to 15s. */
  readonly timeoutMs?: number
}

export interface RetryFilterSortRefreshInput {
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Core-owned deadline for this refresh attempt. Defaults to 15s. */
  readonly timeoutMs?: number
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
  | { readonly kind: 'clear-filter' }
  | { readonly kind: 'clear-column' }
  | { readonly kind: 'apply-draft' }

export interface RunFilterSortMutationInput {
  readonly source: FilterSortControllerPort
  readonly sessionId: number
  readonly intent: FilterSortMutationIntent
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Core-owned deadline for each transport / refresh phase. Defaults to 15s. */
  readonly timeoutMs?: number
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

// --- engine physical sort (design-engine-sort S5 / S6, #29) -----------------
//
// The toolbar / menu / filter-dropdown sort entrypoints dispatch ONE command
// (`runPhysicalSortAtom`). Physical reorder through the host `sortRange` port
// is the ONLY sort mechanism: the display permutation was retired with #24.
// A host that does not expose `sortRange` (e.g. the fail-closed TS worker
// development backend) has NO sort at all — the command reports an unsupported
// diagnostic and the sort entrypoints hide behind `sortRangeSupportedAtom`.

/**
 * Framework-neutral transport for the physical-sort command. A host backend
 * that reorders engine data exposes `sortRange`; without it sorting is
 * unavailable (fail-closed). The command never retains the source.
 */
export interface PhysicalSortControllerPort {
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
   * which makes the sort inapplicable — the command rejects with an
   * `invalid-range` diagnostic instead of writing anything.
   */
  readonly range: CellRange | null
  /**
   * Explicit sort target. The toolbar / menu omit it so the command derives
   * the key column from the active selection; the filter dropdown supplies
   * its own `{ sheetId, colIndex }` because clicking the header chevron does
   * not move the selection onto that column.
   */
  readonly target?: FilterSortEntrypointTarget
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Core-owned deadline for each transport / refresh phase. Defaults to 15s. */
  readonly timeoutMs?: number
}

/**
 * Every reason a physical sort can refuse to write. `'unsupported'` is the
 * UI-core-only code raised when the host exposes no `sortRange` port at all
 * (fail-closed, #24); the rest mirror the engine's structured rejections.
 */
export type PhysicalSortDiagnosticCode = SortRangeRejectionCode | 'unsupported'

/**
 * User-readable evidence that a physical sort was rejected before it wrote
 * any data. Surfaced as a UI-core view fact so a host can render a toast /
 * inline prompt; cleared on the next dispatch and on a successful sort.
 */
export interface PhysicalSortDiagnostic {
  readonly code: PhysicalSortDiagnosticCode
  readonly message: string
  /** Present only for `spill-in-range` — the intersecting anchor (A1). */
  readonly anchor?: string
}
