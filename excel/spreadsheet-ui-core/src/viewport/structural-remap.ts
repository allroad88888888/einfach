import type { BackendStructuralShift } from '../backend/types'
import type { CellRange } from '../shared'

// Pure remap helpers for BackendStructuralShift (see backend/types.ts).
// They translate pre-mutation axis indices / ranges into post-mutation
// coordinates. Nothing here touches atoms or lifecycles — wiring the
// helpers into viewport state is a later stage.

function isActionableShift(shift: BackendStructuralShift): boolean {
  return (
    Number.isSafeInteger(shift.index) &&
    shift.index >= 0 &&
    Number.isSafeInteger(shift.count) &&
    shift.count > 0
  )
}

/**
 * Remaps one axis index across a structural shift.
 *
 * - insert at or before the index → index moves up by `count`
 * - delete strictly before the index → index moves down by `count`
 * - delete covering the index → `null` (the indexed entity is gone)
 * - otherwise the index is untouched
 *
 * The caller is responsible for applying the shift to the matching
 * axis; the `axis` field does not change the arithmetic. A shift with
 * non-positive or non-integer `count`/`index` is treated as "no
 * displacement" and returns the input index unchanged.
 */
export function remapIndexAfterStructuralShift(
  index: number,
  shift: BackendStructuralShift,
): number | null {
  if (!isActionableShift(shift)) return index
  if (shift.kind === 'insert') {
    return index >= shift.index ? index + shift.count : index
  }
  if (index >= shift.index + shift.count) return index - shift.count
  if (index >= shift.index) return null
  return index
}

/**
 * Remaps a set of axis indices across a structural shift. Indices that
 * fall inside a deleted band are dropped. Always returns a new Set;
 * the input set is never mutated.
 */
export function remapIndexSetAfterStructuralShift(
  indices: ReadonlySet<number>,
  shift: BackendStructuralShift,
): Set<number> {
  const next = new Set<number>()
  for (const index of indices) {
    const remapped = remapIndexAfterStructuralShift(index, shift)
    if (remapped !== null) next.add(remapped)
  }
  return next
}

/**
 * Remaps a cell range across a structural shift applied to the range's
 * row axis (`shift.axis === 'row'`) or column axis (`'column'`). The
 * other axis is untouched.
 *
 * - insert at or before the start → whole range shifts
 * - insert strictly inside (start < index <= end) → the range extends
 * - delete entirely before → whole range shifts back
 * - delete overlapping → the range shrinks by the overlap
 * - delete covering the whole extent on that axis → `null`
 *
 * A range that shrinks to a single row/column (or a single cell) is
 * still returned — collapsing 1x1 merges is backend merge policy, not
 * generic range remapping. Always returns a new object (or `null`);
 * the input range is never mutated.
 */
export function remapRangeAfterStructuralShift(
  range: CellRange,
  shift: BackendStructuralShift,
): CellRange | null {
  const next: CellRange = { ...range }
  if (!isActionableShift(shift)) return next

  const startKey = shift.axis === 'row' ? 'rowStart' : 'colStart'
  const endKey = shift.axis === 'row' ? 'rowEnd' : 'colEnd'
  const start = range[startKey]
  const end = range[endKey]
  const { index, count } = shift

  if (shift.kind === 'insert') {
    if (start >= index) {
      next[startKey] = start + count
      next[endKey] = end + count
    } else if (end >= index) {
      next[endKey] = end + count
    }
    return next
  }

  const deleteEnd = index + count - 1
  if (end < index) return next
  if (start > deleteEnd) {
    next[startKey] = start - count
    next[endKey] = end - count
    return next
  }

  const hasBefore = start < index
  const hasAfter = end > deleteEnd
  if (!hasBefore && !hasAfter) return null

  next[startKey] = hasBefore ? start : index
  next[endKey] = hasAfter ? end - count : index - 1
  return next
}
