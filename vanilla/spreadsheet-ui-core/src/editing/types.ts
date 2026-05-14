import type { CellCoord, SpreadsheetError } from '../shared'

export type EditingInputSource = 'cell' | 'formula-bar' | 'keyboard' | 'paste'

export type EditingSessionStatus = 'idle' | 'drafting' | 'committing' | 'cancelled'

export type EditingCommitMove = 'none' | 'up' | 'down' | 'left' | 'right'

export interface EditingSourceCell {
  sheetId: string
  cell: CellCoord
  source: EditingInputSource
}

export interface EditingSessionState {
  status: EditingSessionStatus
  source: EditingSourceCell | null
  draft: string
  diagnostic: SpreadsheetError | null
}

export interface EditingStartInput {
  sheetId: string
  cell: CellCoord
  draft: string
  source: EditingInputSource
}

export interface EditingDraftInput {
  draft: string
  source?: EditingInputSource
}

export interface EditingCommitInput {
  input: string
  move?: EditingCommitMove
  source?: EditingInputSource
}

export interface EditingCommitIntent {
  type: 'editing.commit'
  sheetId: string
  cell: CellCoord
  source: EditingInputSource
  input: string
  move: EditingCommitMove
}

export interface EditingCancelIntent {
  type: 'editing.cancel'
  sheetId: string
  cell: CellCoord
  source: EditingInputSource
}

export interface EditingStartIntent {
  type: 'editing.start'
  sheetId: string
  cell: CellCoord
  source: EditingInputSource
}

export type EditingIntent = EditingStartIntent | EditingCommitIntent | EditingCancelIntent
