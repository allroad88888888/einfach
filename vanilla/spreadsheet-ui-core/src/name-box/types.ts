import type { CellCoord, CellRange } from '../shared'
import type { NamedRangeControllerPort } from '../named-ranges'

export type NameBoxMode = 'idle' | 'typing' | 'committing'

export type NameBoxCommitKind = 'cell' | 'range' | 'named-range' | 'define-name' | 'invalid'

export interface NameBoxCellTarget {
  kind: 'cell'
  sheetId: string
  coord: CellCoord
}

export interface NameBoxRangeTarget {
  kind: 'range'
  sheetId: string
  range: CellRange
}

export interface NameBoxNamedRangeTarget {
  kind: 'named-range'
  sheetId: string
  name: string
  range?: CellRange
  coord?: CellCoord
}

export interface NameBoxDefineNameTarget {
  kind: 'define-name'
  sheetId: string
  name: string
  range: CellRange
}

export interface NameBoxInvalidTarget {
  kind: 'invalid'
  reason: string
}

export type NameBoxCommitTarget =
  | NameBoxCellTarget
  | NameBoxRangeTarget
  | NameBoxNamedRangeTarget
  | NameBoxDefineNameTarget
  | NameBoxInvalidTarget

export interface NameBoxCommitInput {
  /** Raw text typed by the user. */
  input: string
  /** Override sheetId when the box is bound to a non-active sheet. Optional. */
  sheetId?: string
  /** Workbook port used only when a new workbook-scoped range name is defined. */
  source?: NamedRangeControllerPort
  /** Guards DOM events from a previous focus/edit session. */
  sessionId?: number
}

export interface NameBoxSessionInput {
  sessionId?: number
}

export interface UpdateNameBoxInput extends NameBoxSessionInput {
  input: string
}
