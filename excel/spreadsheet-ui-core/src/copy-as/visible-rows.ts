import type { CopyAsRect } from './types'

// Filter-hidden rows are excluded from every clipboard flavour (§8.2 of
// excel/solid-excel/docs/online-excel-parity/design-filter-hidden-rows.md).
//
// Excel's copy semantics are ASYMMETRIC and that asymmetry is the whole
// reason the design keeps two hidden-row sets instead of one:
//
//   - FILTER-hidden rows are skipped automatically when you copy a filtered
//     region. No modifier, no `Go To Special`, it is just what copy does.
//   - MANUALLY hidden rows are copied like any other row. Skipping them
//     requires the explicit `Go To Special → Visible cells only` (Alt+;)
//     path, which this codebase deliberately does not implement.
//
// So `hiddenRows` here is populated from `viewportFilterHiddenAtom` ONLY,
// never from `effectiveHiddenAtom` (the manual ∪ filter union). Feeding the
// union would silently drop manually hidden rows out of the clipboard and
// manufacture a divergence from Excel — the exact opposite of this arc's
// purpose. Same rule as the `remove-duplicates` / `text-to-columns` guards
// landed in S3: anything that MOVES DATA reads the filter subset, only
// navigation and rendering read the union.
//
// Why this is a no-op today: under the current display-compaction filter a
// filtered-out row has no display slot at all, so it is never inside the
// copied rect to begin with — the encoders were accidentally correct. After
// the S5 adapter flip the row keeps its index and sits INSIDE the rect while
// contributing no cells to the sparse projection, at which point every
// encoder below would emit it as a fully blank line/row. This module is the
// guard that stops that, landed ahead of the flip.

const EMPTY_HIDDEN_ROWS: readonly number[] = Object.freeze([])

/** Accept either shape the host has on hand without copying a `Set`. */
export function normalizeCopyAsHiddenRows(
  hiddenRows: ReadonlySet<number> | readonly number[] | undefined,
): ReadonlySet<number> {
  if (hiddenRows instanceof Set) return hiddenRows
  return new Set(hiddenRows ?? EMPTY_HIDDEN_ROWS)
}

/**
 * Rows of `rect` the encoders must emit, ascending: every row in the
 * inclusive span minus the filter-hidden ones.
 *
 * An inverted rect (`endRow < startRow`) yields `[]`, which matches what the
 * encoders' original `for (let row = startRow; row <= endRow; …)` loops did.
 */
export function copyAsVisibleRows(
  rect: CopyAsRect,
  hiddenRows: ReadonlySet<number> | readonly number[] | undefined,
): number[] {
  const hidden = normalizeCopyAsHiddenRows(hiddenRows)
  const rows: number[] = []
  for (let row = rect.startRow; row <= rect.endRow; row += 1) {
    if (hidden.has(row)) continue
    rows.push(row)
  }
  return rows
}
