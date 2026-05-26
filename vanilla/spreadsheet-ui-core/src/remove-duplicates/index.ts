import { atom } from '@einfach/core'
import type { DisplayCell } from '../backend/types'
import { findDuplicateRows } from './algorithm'
import type {
  RemoveDuplicatesComparison,
  RemoveDuplicatesRange,
  RemoveDuplicatesScanResult,
} from './types'

export * from './types'
export { findDuplicateRows } from './algorithm'

// ---------------------------------------------------------------------------
// source atoms
// ---------------------------------------------------------------------------

/** Dialog visibility. */
export const removeDuplicatesOpenAtom = atom<boolean>(false)
removeDuplicatesOpenAtom.debugLabel = 'spreadsheet.removeDuplicates.open'

/** The rectangular selection the user invoked Remove Duplicates against.
 *  Null when the dialog is closed. */
export const removeDuplicatesRangeAtom = atom<RemoveDuplicatesRange | null>(null)
removeDuplicatesRangeAtom.debugLabel = 'spreadsheet.removeDuplicates.range'

/** Sheet-absolute column indices the user has checked. Empty set means
 *  "no columns selected" (preview returns null with `noKeyColumns:true`);
 *  the open command seeds this with every column in the range. */
export const removeDuplicatesKeyColumnsAtom = atom<ReadonlySet<number>>(
  new Set<number>(),
)
removeDuplicatesKeyColumnsAtom.debugLabel = 'spreadsheet.removeDuplicates.keyColumns'

/** Per-cell string comparison policy applied before tuple hashing. */
export const removeDuplicatesComparisonAtom = atom<RemoveDuplicatesComparison>(
  'exact',
)
removeDuplicatesComparisonAtom.debugLabel = 'spreadsheet.removeDuplicates.comparison'

/** Whether to treat the first row as a header (excluded from the scan). */
export const removeDuplicatesExcludeHeaderAtom = atom<boolean>(true)
removeDuplicatesExcludeHeaderAtom.debugLabel =
  'spreadsheet.removeDuplicates.excludeHeader'

/** Cells projection pushed in by the Solid layer when the dialog opens.
 *  Stored in an atom (rather than dialog-local state) so the Solid
 *  1.9.12 Provider remount hazard does not strand it. */
export const removeDuplicatesScanInputCellsAtom = atom<ReadonlyArray<DisplayCell>>([])
removeDuplicatesScanInputCellsAtom.debugLabel =
  'spreadsheet.removeDuplicates.scanInputCells'

// ---------------------------------------------------------------------------
// derived atoms
// ---------------------------------------------------------------------------

/**
 * Live preview of the scan result. `null` whenever:
 * - the dialog is closed, or
 * - no range is set.
 *
 * When the user deselects every column the derived atom returns a
 * synthetic result with `noKeyColumns:true`, `duplicateRows:[]`,
 * `scannedRows:0` and `uniqueRows:0` — the dialog uses that flag to
 * disable the OK button and show a "select at least one column" hint.
 */
export const removeDuplicatesPreviewAtom = atom(
  (get): RemoveDuplicatesScanResult | null => {
    const open = get(removeDuplicatesOpenAtom)
    if (!open) return null
    const range = get(removeDuplicatesRangeAtom)
    if (!range) return null
    const cells = get(removeDuplicatesScanInputCellsAtom)
    const keyColumns = get(removeDuplicatesKeyColumnsAtom)
    const comparison = get(removeDuplicatesComparisonAtom)
    const excludeHeader = get(removeDuplicatesExcludeHeaderAtom)

    // Partition by in-range so we can detect "no usable key columns"
    // without calling into findDuplicateRows (which throws by spec).
    let inRangeCount = 0
    const ignoredColumns: number[] = []
    for (const col of keyColumns) {
      if (col >= range.startCol && col <= range.endCol) {
        inRangeCount += 1
      } else {
        ignoredColumns.push(col)
      }
    }
    ignoredColumns.sort((a, b) => a - b)

    if (inRangeCount === 0) {
      return {
        duplicateRows: [],
        scannedRows: 0,
        uniqueRows: 0,
        ignoredColumns,
        headerRow:
          excludeHeader && range.startRow <= range.endRow ? range.startRow : null,
        noKeyColumns: true,
      }
    }

    return findDuplicateRows({
      cells,
      range,
      keyColumns,
      comparison,
      excludeHeader,
    })
  },
)
removeDuplicatesPreviewAtom.debugLabel = 'spreadsheet.removeDuplicates.preview'

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function allColumnsInRange(range: RemoveDuplicatesRange): Set<number> {
  const out = new Set<number>()
  if (range.startCol > range.endCol) return out
  for (let col = range.startCol; col <= range.endCol; col += 1) {
    out.add(col)
  }
  return out
}

/**
 * Open command. Seeds the range + cells, defaults `keyColumns` to every
 * column in the range, and flips the dialog open. Does not reset the
 * `comparison` / `excludeHeader` atoms — those carry their last-used
 * value within a session by design, matching Excel's "remember dialog
 * settings" behaviour.
 */
export const openRemoveDuplicatesAtom = atom(
  null,
  (
    _get,
    set,
    range: RemoveDuplicatesRange,
    cells: ReadonlyArray<DisplayCell>,
  ): void => {
    set(removeDuplicatesRangeAtom, range)
    set(removeDuplicatesScanInputCellsAtom, cells)
    set(removeDuplicatesKeyColumnsAtom, allColumnsInRange(range))
    set(removeDuplicatesOpenAtom, true)
  },
)
openRemoveDuplicatesAtom.debugLabel = 'spreadsheet.removeDuplicates.openCommand'

/** Close + clear all per-instance state. */
export const closeRemoveDuplicatesAtom = atom(null, (_get, set): void => {
  set(removeDuplicatesOpenAtom, false)
  set(removeDuplicatesRangeAtom, null)
  set(removeDuplicatesScanInputCellsAtom, [])
  set(removeDuplicatesKeyColumnsAtom, new Set<number>())
})
closeRemoveDuplicatesAtom.debugLabel = 'spreadsheet.removeDuplicates.closeCommand'

/** Flip a single column's membership in the key set. Immutable rewrite
 *  so subscribers see a fresh reference. */
export const toggleKeyColumnAtom = atom(null, (get, set, col: number): void => {
  const current = get(removeDuplicatesKeyColumnsAtom)
  const next = new Set(current)
  if (next.has(col)) {
    next.delete(col)
  } else {
    next.add(col)
  }
  set(removeDuplicatesKeyColumnsAtom, next)
})
toggleKeyColumnAtom.debugLabel = 'spreadsheet.removeDuplicates.toggleKeyColumn'

/** Check every column in the active range. No-op when no range is set. */
export const selectAllKeyColumnsAtom = atom(null, (get, set): void => {
  const range = get(removeDuplicatesRangeAtom)
  if (!range) return
  set(removeDuplicatesKeyColumnsAtom, allColumnsInRange(range))
})
selectAllKeyColumnsAtom.debugLabel = 'spreadsheet.removeDuplicates.selectAllKeyColumns'

/** Uncheck every column. Preview will emit `noKeyColumns:true` until the
 *  user toggles at least one column back on. */
export const deselectAllKeyColumnsAtom = atom(null, (_get, set): void => {
  set(removeDuplicatesKeyColumnsAtom, new Set<number>())
})
deselectAllKeyColumnsAtom.debugLabel =
  'spreadsheet.removeDuplicates.deselectAllKeyColumns'
