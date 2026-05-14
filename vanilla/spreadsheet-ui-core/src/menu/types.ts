import type { CellCoord, CellRange } from '../shared'

export type MenuSurface = 'cell' | 'header' | 'context'

export type MenuInteractionSource = 'pointer' | 'keyboard' | 'programmatic'

export type MenuStatus = 'closed' | 'open'

export type MenuTargetKind = 'cell' | 'range' | 'row' | 'column' | 'all' | 'sheet-tab'

export type MenuCommandKind =
  | 'clipboard.copy'
  | 'clipboard.cut'
  | 'clipboard.paste'
  | 'cell.clear'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'formatting.open'

export interface MenuPosition {
  x: number
  y: number
}

export interface MenuCellTarget {
  kind: 'cell'
  sheetId: string
  cell: CellCoord
}

export interface MenuRangeTarget {
  kind: 'range'
  sheetId: string
  range: CellRange
}

export interface MenuRowTarget {
  kind: 'row'
  sheetId: string
  rowIndex: number
}

export interface MenuColumnTarget {
  kind: 'column'
  sheetId: string
  colIndex: number
}

export interface MenuAllTarget {
  kind: 'all'
  sheetId: string
}

export interface MenuSheetTabTarget {
  kind: 'sheet-tab'
  sheetId: string
}

export type MenuTarget =
  | MenuCellTarget
  | MenuRangeTarget
  | MenuRowTarget
  | MenuColumnTarget
  | MenuAllTarget
  | MenuSheetTabTarget

export interface MenuState {
  status: MenuStatus
  surface: MenuSurface | null
  target: MenuTarget | null
  position: MenuPosition | null
  highlightedCommand: MenuCommandKind | null
}

export interface MenuOpenInput {
  surface: MenuSurface
  target: MenuTarget
  position: MenuPosition
  source?: MenuInteractionSource
}

export type MenuCloseReason = 'dismissed' | 'committed' | 'cancelled' | 'target-changed'

export interface MenuOpenIntent {
  type: 'menu.open'
  surface: MenuSurface
  target: MenuTarget
  position: MenuPosition
  source: MenuInteractionSource
}

export interface MenuCloseIntent {
  type: 'menu.close'
  reason: MenuCloseReason
}

export interface MenuHighlightIntent {
  type: 'menu.highlight'
  command: MenuCommandKind | null
}

export interface MenuCommandIntent {
  type: 'menu.command'
  command: MenuCommandKind
  surface: MenuSurface
  target: MenuTarget
}

export type MenuIntent = MenuOpenIntent | MenuCloseIntent | MenuHighlightIntent | MenuCommandIntent
