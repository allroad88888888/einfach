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

// ---------------------------------------------------------------------------
// Export-path row suppression (design §8.2, slice S7 proper)
// ---------------------------------------------------------------------------
//
// S7's prep slice taught the three clipboard ENCODERS to skip filter-hidden
// rows, but the two paths where the ADAPTER produces the content itself were
// left open, and they are the paths a large selection takes:
//
//   - `exportRangeTsv` / `consumeExportRangeTsvChunks` — the >10k-cell copy.
//   - `exportRangeAsImage` — Copy as PNG.
//
// Left unclosed, a single "copy" would fork on SIZE after the S5 flip: a small
// rect goes through the guarded encoders and drops filtered rows, a large one
// goes through these ports and keeps them. Same gesture, same data, different
// clipboard, no error shown. The helpers below are the TSV half; the image
// half lives in `../copy-as/renderRangeAsImage.ts` because it also has to
// shrink the canvas geometry, which has no textual analogue.
//
// The hidden set arrives as a REQUEST PARAMETER from UI-core. These functions
// deliberately have no access to any adapter state — filter visibility is a
// UI-core view fact (CANONICAL_OWNERSHIP §2) and an adapter that consulted its
// own `setFilterSort` snapshot would be a second, staler authority.

/** First row of `[startRow, endRow]` that survives `hidden`, or `null`. */
export function firstVisibleRowInBand(
  startRow: number,
  endRow: number,
  hidden: ReadonlySet<number>,
): number | null {
  for (let row = startRow; row <= endRow; row += 1) {
    if (!hidden.has(row)) return row
  }
  return null
}

export interface FilteredTsvBand {
  /** The surviving lines, re-joined with `\n`. */
  text: string
  /** How many rows survived. `0` means the caller must emit nothing at all. */
  rowCount: number
  /** First surviving source row, or `null` when every row was hidden. */
  firstVisibleRow: number | null
}

/**
 * Drop filter-hidden rows from one band of already-serialised TSV.
 *
 * `text` is what `sparseRangeToTSV` produced for the inclusive row band
 * `[startRow, endRow]`: exactly one line per row, dense, `\n`-joined. The
 * whole clipboard TSV contract in this codebase is unquoted and line-per-row
 * on BOTH sides — `serializeClipboardTsv` joins with `\n` and
 * `parseClipboardTsv` splits on `\n` with no quote handling — so filtering by
 * line index is exactly as faithful as the format itself. (A cell value
 * containing a literal newline already corrupts paste today, independently of
 * this function; see the shape guard below.)
 *
 * Why filter the serialised text at the adapter boundary rather than push the
 * hidden set through `postMessage` into the worker runtime: the hidden set is
 * a VIEW fact, and the worker owns DATA facts. Keeping it main-thread-side
 * also means the fix works identically on the WASM runtime, the TS runtime
 * (which declares `tsvChunkExport: false` and takes the single-shot fallback)
 * and the static backend, with no capability gate and no wasm-pkg version
 * skew — an older `wasm-pkg` cannot silently reintroduce the bug.
 */
export function filterTsvBandRows(
  text: string,
  startRow: number,
  endRow: number,
  hidden: ReadonlySet<number>,
): FilteredTsvBand {
  const bandRowCount = endRow - startRow + 1

  // Fast path AND the mechanical identity guarantee: with no hidden rows the
  // input string is returned by reference, so today's bytes cannot change.
  if (hidden.size === 0 || bandRowCount <= 0) {
    return {
      text,
      rowCount: Math.max(0, bandRowCount),
      firstVisibleRow: bandRowCount > 0 ? startRow : null,
    }
  }

  const lines = text.split('\n')

  // Shape guard. `sparseRangeToTSV` guarantees one line per band row, so a
  // mismatch means a cell value carried an embedded newline. Filtering by
  // index would then drop the WRONG row — silently deleting a VISIBLE row
  // from the user's clipboard. Exporting a filtered row is the strictly
  // lesser evil, so fail open and leave the band untouched.
  if (lines.length !== bandRowCount) {
    return { text, rowCount: bandRowCount, firstVisibleRow: startRow }
  }

  const kept: string[] = []
  let firstVisibleRow: number | null = null
  for (let offset = 0; offset < bandRowCount; offset += 1) {
    const row = startRow + offset
    if (hidden.has(row)) continue
    if (firstVisibleRow === null) firstVisibleRow = row
    kept.push(lines[offset])
  }

  return { text: kept.join('\n'), rowCount: kept.length, firstVisibleRow }
}
