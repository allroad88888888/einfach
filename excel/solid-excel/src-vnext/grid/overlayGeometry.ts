import type { CellRange } from '@einfach/spreadsheet-ui-core'

export interface OverlayRect {
  x: number
  y: number
  w: number
  h: number
}

export interface OverlayRectForRangeInput {
  range: CellRange
  getCellRect: (row: number, col: number) => OverlayRect | null
  getVisibleRows?: () => readonly number[]
  getVisibleCols?: () => readonly number[]
}

/**
 * Compute the pixel rectangle for a cell range, optionally clipped to a
 * visible-rows / visible-cols window. Returns `null` when the range falls
 * entirely outside the visible window or when either endpoint cell rect is
 * unknown.
 *
 * This is the single source of truth for the canvas and SVG overlay; both
 * must produce the exact same coordinates for the migration to stay
 * pixel-perfect. Do not inline a copy elsewhere.
 */
export function computeOverlayRectForRange(input: OverlayRectForRangeInput): OverlayRect | null {
  const { range } = input
  let rowStart = range.rowStart
  let rowEnd = range.rowEnd
  let colStart = range.colStart
  let colEnd = range.colEnd

  const visibleRows = input.getVisibleRows?.()
  if (visibleRows) {
    const rowsInRange = visibleRows.filter((row) => row >= range.rowStart && row <= range.rowEnd)
    if (rowsInRange.length === 0) return null
    rowStart = rowsInRange[0]
    rowEnd = rowsInRange[rowsInRange.length - 1]
  }

  const visibleCols = input.getVisibleCols?.()
  if (visibleCols) {
    const colsInRange = visibleCols.filter((col) => col >= range.colStart && col <= range.colEnd)
    if (colsInRange.length === 0) return null
    colStart = colsInRange[0]
    colEnd = colsInRange[colsInRange.length - 1]
  }

  const start = input.getCellRect(rowStart, colStart)
  const end = input.getCellRect(rowEnd, colEnd)
  if (!start || !end) return null
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const w = Math.max(start.x + start.w, end.x + end.w) - x
  const h = Math.max(start.y + start.h, end.y + end.h) - y
  return { x, y, w, h }
}
