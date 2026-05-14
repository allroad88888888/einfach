import type { CellCoord } from '../shared'
import type { SelectionState } from '../selection'

export type KeyboardMode = 'navigation' | 'editing' | 'formula-reference'

export interface KeyboardInput {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  pageRowDelta?: number
  pageColDelta?: number
}

export type KeyboardMoveReason = 'arrow' | 'tab' | 'enter' | 'home' | 'end' | 'page'

export interface ScrollToCellIntent {
  type: 'viewport.scrollToCell'
  target: CellCoord
}

export interface MoveSelectionIntent {
  type: 'selection.move'
  reason: KeyboardMoveReason
  key: string
  extend: boolean
  from: CellCoord
  to: CellCoord
  scroll: ScrollToCellIntent
  selection: SelectionState
}

export interface SelectAllIntent {
  type: 'selection.selectAll'
  selection: SelectionState
}

export interface KeyboardEditingStartIntent {
  type: 'editing.start'
  source: 'keyboard'
}

export interface KeyboardEditingCommitIntent {
  type: 'editing.commit'
  move: 'none' | 'up' | 'down' | 'left' | 'right'
}

export interface KeyboardEditingCancelIntent {
  type: 'editing.cancel'
}

export interface KeyboardClipboardIntent {
  type: 'clipboard.copy' | 'clipboard.cut' | 'clipboard.paste'
}

export interface HistoryIntent {
  type: 'history.undo' | 'history.redo'
}

export interface ClearCellsIntent {
  type: 'cell.clear'
}

export interface NoneKeyboardIntent {
  type: 'none'
  reason: 'unhandled' | 'composing' | 'editing-text-navigation'
}

export type KeyboardCommandIntent =
  | MoveSelectionIntent
  | SelectAllIntent
  | KeyboardEditingStartIntent
  | KeyboardEditingCommitIntent
  | KeyboardEditingCancelIntent
  | KeyboardClipboardIntent
  | HistoryIntent
  | ClearCellsIntent
  | NoneKeyboardIntent
