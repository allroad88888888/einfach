import type {
  BackendMutationResult,
  ProjectionRequestId,
  ProjectionRevision,
  SetCellInputRequest,
} from '../backend/types'
import type { CellCoord, SpreadsheetError } from '../shared'

export type EditingInputSource = 'cell' | 'formula-bar' | 'keyboard' | 'paste'

export type EditingSessionStatus = 'idle' | 'drafting' | 'committing' | 'cancelled'

export type EditingCommitMove = 'none' | 'up' | 'down' | 'left' | 'right'

export interface EditingSourceCell {
  readonly sheetId: string
  readonly cell: Readonly<CellCoord>
  readonly source: EditingInputSource
}

export interface EditingSessionState {
  readonly status: EditingSessionStatus
  readonly source: EditingSourceCell | null
  readonly draft: string
  readonly diagnostic: SpreadsheetError | null
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

/**
 * Frozen set-cell-input request owned by the editing command. Runtime
 * acknowledgement is strict even though the shared backend fields remain
 * optional for compatibility with non-editing callers.
 */
export interface EditingCommitRequest extends SetCellInputRequest {
  readonly requestId: ProjectionRequestId
}

export interface EditingCommitAcknowledgement extends BackendMutationResult {
  readonly requestId: ProjectionRequestId
  readonly revision: ProjectionRevision
}

/** Framework-neutral mutation port. Core never retains this object. */
export interface EditingControllerPort {
  setCellInput?: (request: EditingCommitRequest) => Promise<BackendMutationResult>
}

export type EditingCommitLifecycleStatus =
  | 'ready'
  | 'blocked'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'refresh-failed'
  | 'outcome-unknown'
  | 'rejected'

export interface EditingCommitLifecycleState {
  readonly status: EditingCommitLifecycleStatus
  readonly sessionId: number
  readonly requestId: ProjectionRequestId | null
  readonly sheetId: string | null
  readonly cell: Readonly<CellCoord> | null
  readonly acknowledgedRevision: ProjectionRevision | null
  readonly error: string
}

export type EditingCommitOutcome =
  | 'completed'
  | 'blocked'
  | 'rejected'
  | 'refresh-failed'
  | 'outcome-unknown'

export interface RunEditingCommitInput {
  readonly source: EditingControllerPort
  readonly commitSource?: EditingInputSource
  readonly move?: EditingCommitMove
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export interface RetryEditingRefreshInput {
  readonly refreshProjection: (sheetId: string) => Promise<void>
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
