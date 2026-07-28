import type {
  DisplayCell,
  ProjectionRequestId,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../backend/types'
import type { SelectionAuthorityWitness } from '../selection'
import type { CellRange } from '../shared'
import type { WorkspaceActiveSheetAuthorityWitness } from '../workspace'

/**
 * Rectangular range scanned by Remove Duplicates. All bounds are
 * sheet-absolute and inclusive. An empty range is signalled with
 * `startRow > endRow` (or `startCol > endCol`); the algorithm treats
 * such a range as zero scanned rows and never throws.
 */
export interface RemoveDuplicatesRange {
  readonly startRow: number
  readonly startCol: number
  readonly endRow: number
  readonly endCol: number
}

export interface RemoveRowsAffectedRange {
  readonly startRow: number
  readonly endRow: number
  readonly startCol: number
  readonly endCol: number
}

/** Feature-local exact mutation transport; shared backend adoption is optional. */
export interface RemoveRowsExactRequest {
  readonly kind: 'remove-rows'
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly targetRange: Readonly<CellRange>
  readonly rows: ReadonlyArray<number>
  readonly revision?: ProjectionRevision
}

export interface RemoveRowsExactResult {
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly targetRange: Readonly<CellRange>
  readonly removedRowIndices: ReadonlyArray<number>
  readonly removedRows: number
  readonly affectedRange: RemoveRowsAffectedRange | null
  readonly revision: ProjectionRevision
  /**
   * Compatibility verdict for adapters migrating to the shared history lane.
   *
   * Omitted currently preserves legacy adapter behaviour and is treated as
   * `true`; adapters should return an explicit boolean so this can become
   * required after the compatibility window.
   */
  readonly historyRecorded?: boolean
}

/**
 * String-equality normalisation applied per-cell before tuples are
 * hashed.
 *
 * - `'exact'`             — binary string compare (Excel default).
 * - `'caseInsensitive'`   — `String#toLowerCase()` before compare.
 *                           Latin-only is acceptable; full Unicode
 *                           case-folding is intentionally out of scope.
 * - `'trim'`              — `String#trim()` before compare.
 * - `'trimAndIgnoreCase'` — both, applied in `trim → lowercase` order.
 */
export type RemoveDuplicatesComparison = 'exact' | 'caseInsensitive' | 'trim' | 'trimAndIgnoreCase'

export interface RemoveDuplicatesScanInput {
  /** Sparse projection of cells visible in the scanned range. Cells
   *  outside the range are tolerated and ignored. */
  cells: ReadonlyArray<DisplayCell>
  range: RemoveDuplicatesRange
  /** Sheet-absolute column indices to include in the tuple key. Should
   *  be a subset of `[range.startCol .. range.endCol]`; entries outside
   *  the range are dropped and surfaced in `result.ignoredColumns`. */
  keyColumns: ReadonlySet<number>
  /**
   * When true (default), the header row (`range.startRow`) is excluded
   * from the scan and reported back via `result.headerRow`. The caller
   * decides whether to remove it — typically no, since headers are
   * unique by design.
   */
  excludeHeader?: boolean
  /** See {@link RemoveDuplicatesComparison}. Default `'exact'`. */
  comparison?: RemoveDuplicatesComparison
  /**
   * Sheet-absolute row indices the scan must skip outright — neither
   * compared, nor counted in `scannedRows`, nor eligible to become the
   * first-seen occupant of a tuple.
   *
   * This exists because the dense `[startRow..endRow]` walk cannot tell
   * "row present in the projection and genuinely blank" apart from "row
   * absent from the projection because it is not rendered". The former is
   * a real duplicate candidate (Excel treats all-blank rows as duplicates
   * of each other); the latter is invisible data that must never be handed
   * to `removeRows`.
   *
   * Populate with FILTER-hidden rows only. Manually hidden rows still carry
   * their real values in the projection and, per Excel, still take part in
   * Remove Duplicates — passing them here would silently shrink the
   * operation. Omitted / empty means "scan everything", the pre-hardening
   * behaviour.
   */
  hiddenRows?: ReadonlySet<number> | readonly number[]
}

export interface RemoveDuplicatesScanResult {
  /**
   * Source-row indices marked for removal — i.e. the rows
   * `backend.removeRows` should target. Sorted ascending.
   *
   * Filtering hides rows instead of compacting them (#27), so the
   * projected row IS the source row and the scan index needs no
   * translation. Callers hand `duplicateRows` straight to
   * `backend.removeRows({ rows })`. Rows listed in `input.hiddenRows`
   * never appear here at all — see `hiddenRows` above.
   */
  duplicateRows: readonly number[]
  /** Total rows scanned (excluding the header row when
   *  `excludeHeader=true`). */
  scannedRows: number
  /** Unique rows surviving the scan (= `scannedRows -
   *  duplicateRows.length`). */
  uniqueRows: number
  /** Sheet-absolute column indices that were passed in `keyColumns` but
   *  fall outside `[startCol .. endCol]`. Dialogs can surface this as a
   *  validation hint. Sorted ascending. */
  ignoredColumns: readonly number[]
  /** Sheet-absolute header row index when `excludeHeader=true`, else
   *  `null`. */
  headerRow: number | null
  /**
   * True iff `keyColumns` is empty AFTER ignoredColumns are dropped.
   * Both the pure {@link findDuplicateRows} function and the derived
   * atom return a synthetic zero-result with this flag set rather
   * than throwing — dialogs use the flag to disable OK and prompt the
   * user to pick a column.
   */
  noKeyColumns: boolean
}

export type RemoveDuplicatesLifecycleStatus =
  | 'closed'
  | 'read-pending'
  | 'read-stale'
  | 'read-failed'
  | 'editing'
  | 'mutation-pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'refresh-failed'
  | 'outcome-unknown'

/** Core-owned lifecycle projection for one immutable dialog session. */
export interface RemoveDuplicatesLifecycleState {
  readonly status: RemoveDuplicatesLifecycleStatus
  readonly sessionId: number
  readonly readRequestId: ProjectionRequestId | null
  readonly mutationRequestId: ProjectionRequestId | null
  readonly sheetId: string | null
}

export interface RemoveDuplicatesCapabilityState {
  readonly canRead: boolean
  readonly canRemove: boolean
}

/**
 * Immutable projection accepted by Core after a complete, exact range read.
 * Authority witnesses are intentionally opaque and compared only by identity.
 */
export interface RemoveDuplicatesSessionSnapshot {
  readonly sessionId: number
  readonly sheetId: string
  readonly range: RemoveDuplicatesRange
  readonly selectionWitness: SelectionAuthorityWitness
  readonly workspaceActiveSheetWitness: WorkspaceActiveSheetAuthorityWitness
  readonly projectionRevision: ProjectionRevision
  readonly cells: readonly DisplayCell[]
}

/** Every editable form transition exposed to framework adapters. */
export type RemoveDuplicatesIntent =
  | { readonly kind: 'toggle-key-column'; readonly column: number }
  | { readonly kind: 'select-all-key-columns' }
  | { readonly kind: 'deselect-all-key-columns' }
  | {
      readonly kind: 'set-comparison'
      readonly comparison: RemoveDuplicatesComparison
    }
  | { readonly kind: 'set-exclude-header'; readonly excludeHeader: boolean }

/** Minimum effect port consumed by the framework-neutral Core commands. */
export interface RemoveDuplicatesControllerPort {
  readRangeProjection?(request: RangeProjectionRequest): Promise<RangeProjectionResult>
  removeRowsExact?(request: RemoveRowsExactRequest): Promise<RemoveRowsExactResult>
}

export interface OpenRemoveDuplicatesInput {
  readonly source: RemoveDuplicatesControllerPort
  /** Per-attempt transport deadline. Defaults to 15 seconds. */
  readonly timeoutMs?: number
  /**
   * Optional compatibility witness for legacy callers. Core derives the
   * authoritative sheet from selection/workspace state and only validates
   * this value when a caller still provides it.
   */
  readonly sheetId?: string
}

export interface RunRemoveDuplicatesConfirmInput {
  readonly source: RemoveDuplicatesControllerPort
  readonly sessionId: number
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Per-attempt mutation/refresh deadline. Defaults to 15 seconds. */
  readonly timeoutMs?: number
}

export type RemoveDuplicatesReadOutcome = 'editing' | 'failed' | 'stale' | 'blocked'

export type RemoveDuplicatesMutationOutcome =
  | 'completed'
  | 'blocked'
  | 'refresh-failed'
  | 'outcome-unknown'
  | 'stale'

/** Frozen exact mutation target, exposed only for diagnostics and tests. */
export interface RemoveDuplicatesMutationTarget {
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly targetRange: Readonly<CellRange>
  readonly removedRowIndices: readonly number[]
  readonly projectionRevision: ProjectionRevision
  readonly targetKey: string
}
