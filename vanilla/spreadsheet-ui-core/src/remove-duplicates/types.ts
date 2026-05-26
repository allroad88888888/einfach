import type { DisplayCell } from '../backend/types'

/**
 * Rectangular range scanned by Remove Duplicates. All bounds are
 * sheet-absolute and inclusive. An empty range is signalled with
 * `startRow > endRow` (or `startCol > endCol`); the algorithm treats
 * such a range as zero scanned rows and never throws.
 */
export interface RemoveDuplicatesRange {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
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
export type RemoveDuplicatesComparison =
  | 'exact'
  | 'caseInsensitive'
  | 'trim'
  | 'trimAndIgnoreCase'

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
}

export interface RemoveDuplicatesScanResult {
  /**
   * Source-row indices marked for removal — i.e. the rows
   * `backend.removeRows` should target. Sorted ascending.
   *
   * When the input projection carries `DisplayCell.originalRow` (filter
   * or sort active), the value reported here is that `originalRow`, NOT
   * the visual iteration index. When the projection lacks `originalRow`
   * (no filter/sort), source row and visual row coincide and the value
   * is the plain `cell.row`. Either way, callers can hand
   * `duplicateRows` straight to `backend.removeRows({ rows })` without
   * remapping.
   */
  duplicateRows: number[]
  /** Total rows scanned (excluding the header row when
   *  `excludeHeader=true`). */
  scannedRows: number
  /** Unique rows surviving the scan (= `scannedRows -
   *  duplicateRows.length`). */
  uniqueRows: number
  /** Sheet-absolute column indices that were passed in `keyColumns` but
   *  fall outside `[startCol .. endCol]`. Dialogs can surface this as a
   *  validation hint. Sorted ascending. */
  ignoredColumns: number[]
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
