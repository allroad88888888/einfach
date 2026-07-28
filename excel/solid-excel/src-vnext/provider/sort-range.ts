import type { Store } from '@einfach/core'
import {
  selectionBoundsAtom,
  type CellCoord,
  type CellRange,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

/**
 * Resolve the data region the toolbar / menu sort should physically reorder
 * (design-engine-sort §8 — "整数据区 rows 1..end × used cols"). v1 heuristic:
 * anchor the block at A1 and grow to the used extent through `resolveDataEdge`
 * (Ctrl+Arrow semantics), keep the active column / row inside it, then drop
 * the header (row 0) by starting the sort range at row 1 — matching the
 * display-permutation convention (`headerRow: 0, startRow: 1`).
 *
 * Returns `null` when the host exposes no `resolveDataEdge` port or the sheet
 * carries no data past the header; `runPhysicalSortAtom` then rejects the sort
 * with an `invalid-range` diagnostic (there is no display fallback — #24).
 */
export async function resolveSortRange(
  store: Store,
  backend: SpreadsheetBackend,
  sheetId: string,
  active: CellCoord,
): Promise<CellRange | null> {
  const resolve = backend.resolveDataEdge
  if (typeof resolve !== 'function') return null

  const bounds = store.getter(selectionBoundsAtom)
  const origin: CellCoord = { row: 0, col: 0 }
  const [down, right] = await Promise.all([
    resolve.call(backend, {
      kind: 'resolve-data-edge',
      sheetId,
      from: origin,
      direction: 'down',
      bounds,
    }),
    resolve.call(backend, {
      kind: 'resolve-data-edge',
      sheetId,
      from: origin,
      direction: 'right',
      bounds,
    }),
  ])

  const lastRow = Math.max(down.target.row, active.row)
  const lastCol = Math.max(right.target.col, active.col)
  // Header row 0 excluded by starting at row 1; nothing to sort otherwise.
  if (lastRow < 1) return null
  return { rowStart: 1, rowEnd: lastRow, colStart: 0, colEnd: lastCol }
}
