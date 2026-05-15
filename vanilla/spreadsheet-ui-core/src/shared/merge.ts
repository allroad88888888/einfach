import type { CellCoord } from './types'
import type { DisplayCell } from '../backend/types'

export function isMergeAnchor(cell: DisplayCell): boolean {
  return cell.mergedSpan !== undefined
}

export function isMergeCovered(cell: DisplayCell): boolean {
  return cell.mergeAnchor !== undefined
}

export function getMergeAnchorCoord(cell: DisplayCell): CellCoord | null {
  if (cell.mergeAnchor !== undefined) return cell.mergeAnchor
  if (cell.mergedSpan !== undefined) return { row: cell.row, col: cell.col }
  return null
}
