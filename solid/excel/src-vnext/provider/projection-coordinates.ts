import type { Store } from '@einfach/core'
import type {
  CellCoord,
  CellRange,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { isVisibleProjectionResult, spreadsheetProjectionSnapshotAtom } from './atoms'

function visibleResultForSheet(
  store: Store,
  sheetId: string,
): VisibleProjectionResult | undefined {
  const result = store.getter(spreadsheetProjectionSnapshotAtom).result
  if (!isVisibleProjectionResult(result) || result.sheetId !== sheetId) return undefined
  return result
}

function originalRowForVisibleRow(
  result: VisibleProjectionResult,
  row: number,
  preferredCol?: number,
): number | undefined {
  if (preferredCol !== undefined) {
    const direct = result.cells.find((cell) => cell.row === row && cell.col === preferredCol)
    if (typeof direct?.originalRow === 'number') return direct.originalRow
  }

  const rowCell = result.cells.find(
    (cell) => cell.row === row && typeof cell.originalRow === 'number',
  )
  return rowCell?.originalRow
}

export function resolveProjectionSourceCell(
  store: Store,
  sheetId: string,
  cell: CellCoord,
): CellCoord {
  const result = visibleResultForSheet(store, sheetId)
  if (!result) return cell
  const originalRow = originalRowForVisibleRow(result, cell.row, cell.col)
  return originalRow === undefined ? cell : { row: originalRow, col: cell.col }
}

/**
 * Translate visible projection coordinates back to source rows for mutations.
 *
 * Filtering/sorting keeps `DisplayCell.row` as the visible layout row and
 * stores the backing source row on `originalRow`. Single-row ranges can be
 * safely translated. Multi-row ranges are split by visible row when the whole
 * selection is inside the current projection window; huge selections such as
 * whole columns intentionally fall back to the source range shape.
 *
 * NOTE: content mutations (set-cell-input / clear-range / fill / paste) no
 * longer use these lenient helpers — they resolve through UI-core's
 * fail-closed `resolveContentMutationAtom` gateway (`editing/mutation-gateway`),
 * which also enforces the protection gate. These helpers remain for
 * format-path translation (e.g. toolbar format toggles), which is outside
 * the content-mutation gating scope.
 */
export function resolveProjectionSourceRanges(
  store: Store,
  sheetId: string,
  range: CellRange,
): CellRange[] {
  const result = visibleResultForSheet(store, sheetId)
  if (!result) return [range]
  if (!result.cells.some((cell) => typeof cell.originalRow === 'number')) return [range]
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) return [range]

  const rowCount = range.rowEnd - range.rowStart + 1
  const visibleRowCount = result.window.rowEnd - result.window.rowStart + 1
  if (rowCount > visibleRowCount) return [range]

  const ranges: CellRange[] = []
  let mapped = false
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    const sourceRow = originalRowForVisibleRow(result, row, range.colStart) ?? row
    mapped ||= sourceRow !== row
    const previous = ranges[ranges.length - 1]
    if (
      previous &&
      previous.colStart === range.colStart &&
      previous.colEnd === range.colEnd &&
      previous.rowEnd + 1 === sourceRow
    ) {
      previous.rowEnd = sourceRow
    } else {
      ranges.push({
        rowStart: sourceRow,
        rowEnd: sourceRow,
        colStart: range.colStart,
        colEnd: range.colEnd,
      })
    }
  }

  return mapped ? ranges : [range]
}

export function resolveProjectionSourceRange(
  store: Store,
  sheetId: string,
  range: CellRange,
): CellRange {
  const ranges = resolveProjectionSourceRanges(store, sheetId, range)
  return ranges.length === 1 ? ranges[0] : range
}
