import type { CellCoord } from '../shared'

export interface FormulaReferenceSession {
  /** Cell being edited (anchor of the editing session). */
  anchorCell: CellCoord
  sheetId: string
  /** Caret position in the draft at the moment the session was entered. */
  insertionCaret: number
  /**
   * Character range [start, end) of the last inserted reference token.
   * Null until the first pick resolves.
   */
  tokenRange: FormulaReferenceTokenRange | null
  /** Whether the pointer is currently being dragged (range pick in progress). */
  dragging: boolean
}

export interface FormulaReferenceTokenRange {
  start: number
  end: number
}

export interface FormulaReferenceInsertionPoint {
  caretIndex: number
  draft: string
}

export interface EnterFormulaReferenceInput {
  anchorCell: CellCoord
  sheetId: string
  insertionCaret: number
  draft: string
}

export interface FormulaReferencePickInput {
  /** Single cell or rectangular range being picked. */
  pickAnchor: CellCoord
  pickFocus: CellCoord
  sheetId: string
  /** True while a pointer drag is still in progress. */
  dragging: boolean
}

export type FormulaReferenceExitReason =
  | 'commit'
  | 'cancel'
  | 'operator-typed'
  | 'separator-typed'
  | 'close-paren-typed'

export interface FormulaReferenceInsertIntent {
  type: 'formulaReference.insert'
  draft: string
  caretAfter: number
}
