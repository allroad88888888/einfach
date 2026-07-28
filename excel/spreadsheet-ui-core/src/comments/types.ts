import type { ProjectionRequestId, ProjectionRevision } from '../backend/types'

export interface CellNote {
  text: string
}

export interface Comment {
  id: string
  author?: string
  body: string
  createdAt: number
}

export interface CommentThread {
  id: string
  comments: Comment[]
  resolved: boolean
}

export interface CommentSessionState {
  sheetId: string
  cell: { row: number; col: number }
  threadId?: string
}

export type CommentMutationAction = 'post' | 'resolve'

/**
 * UI-visible local mutation state. `LocalAcknowledged` is transport evidence
 * only; it is deliberately not named "applied", "posted", or "resolved".
 */
export type CommentMutationPhase =
  | 'Idle'
  | 'ErrorOpen'
  | 'PendingPublished'
  | 'LocalAcknowledged'
  | 'OutcomeUnknownBlocked'

export interface CommentMutationState {
  readonly phase: CommentMutationPhase
  readonly action: CommentMutationAction | null
  readonly requestId: ProjectionRequestId | null
  readonly error: string | null
}

export type CommentRuntimeStatus =
  | 'Closed'
  | 'OpenClean'
  | 'OpenDirty'
  | Exclude<CommentMutationPhase, 'Idle'>

export type CommentOperationAttemptStatus = 'pending' | 'local-acknowledged' | 'outcome-unknown'

/** Bounded local evidence. Pending and unknown attempts are never evicted. */
export interface CommentOperationAttempt {
  readonly operationId: string
  readonly requestId: ProjectionRequestId
  readonly sessionId: number
  readonly deadlineAt: number
  readonly action: CommentMutationAction
  readonly sheetId: string
  readonly cell: Readonly<{ row: number; col: number }>
  readonly threadId?: string
  readonly status: CommentOperationAttemptStatus
  readonly resultRevision?: ProjectionRevision
  readonly error?: string
}

/**
 * Existing backend ports return this evidence shape. Cell/thread authority is
 * bound to the immutable Core ticket; an optional affectedRange is checked
 * when a backend supplies it.
 */
export interface CommentMutationAcknowledgement {
  readonly sheetId: string
  readonly requestId: ProjectionRequestId
  readonly revision?: ProjectionRevision
  readonly affectedRange?: Readonly<{
    rowStart: number
    rowEnd: number
    colStart: number
    colEnd: number
  }>
}

export interface CommentMutationPortSource {
  readonly postComment?: (request: PostCommentRequest) => unknown | Promise<unknown>
  readonly resolveCommentThread?: (
    request: ResolveCommentThreadRequest,
  ) => unknown | Promise<unknown>
}

/** Core reads the selected optional port exactly once under a launch capture. */
export interface RunCommentMutationInput {
  readonly action: CommentMutationAction
  readonly source?: CommentMutationPortSource
}

export interface SetNoteRequest {
  kind: 'set-note'
  sheetId: string
  cell: { row: number; col: number }
  note: CellNote
  requestId?: number
  revision?: ProjectionRevision
}

export interface ClearNoteRequest {
  kind: 'clear-note'
  sheetId: string
  cell: { row: number; col: number }
  requestId?: number
  revision?: ProjectionRevision
}

export interface PostCommentRequest {
  kind: 'post-comment'
  sheetId: string
  cell: { row: number; col: number }
  threadId?: string
  body: string
  author?: string
  requestId?: number
  revision?: ProjectionRevision
}

export interface ResolveCommentThreadRequest {
  kind: 'resolve-comment-thread'
  sheetId: string
  threadId: string
  requestId?: number
  revision?: ProjectionRevision
}

export interface DeleteCommentRequest {
  kind: 'delete-comment'
  sheetId: string
  threadId: string
  commentId: string
  requestId?: number
  revision?: ProjectionRevision
}

export type CommentIntent =
  | { type: 'comment.set-note'; request: SetNoteRequest }
  | { type: 'comment.clear-note'; request: ClearNoteRequest }
  | { type: 'comment.post'; request: PostCommentRequest }
  | { type: 'comment.resolve-thread'; request: ResolveCommentThreadRequest }
  | { type: 'comment.delete-comment'; request: DeleteCommentRequest }
