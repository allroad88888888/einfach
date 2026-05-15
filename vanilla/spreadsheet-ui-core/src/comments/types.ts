import type { ProjectionRevision } from '../backend/types'

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
