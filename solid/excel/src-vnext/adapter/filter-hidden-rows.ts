/**
 * Filter-hidden row derivation shared by both adapters (design
 * `design-filter-hidden-rows.md` §4.2, slice S4).
 *
 * Excel's two SUBTOTAL layers need the engine to know which rows an ACTIVE
 * FILTER hid: `SUBTOTAL(1-11)` excludes filter-hidden rows (while still
 * including manually hidden ones) and `SUBTOTAL(101-111)` excludes both.
 * Until this landed the engine had no idea a filter existed, so 1-11 summed
 * filtered-out rows — a divergence from Excel, not a missing feature.
 *
 * The set is derived as the COMPLEMENT of the visibility permutation both
 * adapters already compute in `setFilterSort` (`buildFilterSortDisplayRows`),
 * rather than by re-running the predicate:
 *
 *  - it cannot drift from what the projection shows, because "hidden" is
 *    defined as "scanned but not displayed" by construction;
 *  - the header row and the summary row are pinned into the permutation by
 *    the shared helper, so they can never leak into the hidden set;
 *  - it adds ZERO scanning. The whole-column read already happens (design
 *    §4.2 point 2) — this is the same scan projected a second way.
 */

/**
 * Source rows an active filter hides, given the display permutation and the
 * row extent the predicate scan covered.
 *
 * `displayRows` is the sparse `display -> source` array returned by
 * `buildFilterSortDisplayRows` (`null` when no filter is active — then nothing
 * is hidden). `scannedRowCount` is the EXCLUSIVE upper bound of the scan,
 * i.e. `maxRow + 1` for the same extent that was fed to the builder; rows at
 * or beyond it were never judged and are therefore never reported hidden.
 *
 * Result is ascending and duplicate-free — the whole-set-replace payload
 * `Workbook::set_eval_filter_hidden_rows` expects.
 */
export function filterHiddenRowsFromDisplayRows(
  displayRows: readonly number[] | null | undefined,
  scannedRowCount: number,
): number[] {
  if (!displayRows || scannedRowCount <= 0) return []

  // The permutation is a SPARSE array: unmatched display slots are holes, so
  // index-wise iteration with an explicit hole check is required (`for…of`
  // would yield `undefined` for holes and `filter` would skip them silently).
  const visible = new Set<number>()
  for (let display = 0; display < displayRows.length; display += 1) {
    const source = displayRows[display]
    if (source !== undefined) visible.add(source)
  }

  const hidden: number[] = []
  for (let row = 0; row < scannedRowCount; row += 1) {
    if (!visible.has(row)) hidden.push(row)
  }
  return hidden
}
