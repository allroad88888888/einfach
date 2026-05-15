# comments-notes

Cell-anchored notes (single plain text) and threaded comments with author and resolved state.

## Goal

Two distinct annotation primitives on cells:

- **Note** — a single plain-text string anchored to one cell, owned entirely by the backend. No threading, no author, no resolved state. Equivalent to a traditional spreadsheet cell comment.
- **Comment thread** — a threaded conversation anchored to one cell. Each thread holds an ordered list of comments, each with an author identity, body text, and creation timestamp. A thread can be resolved or reopened by any participant.

The UI core owns only the active session state (which cell's thread is open, the draft reply body). All thread content and note text live in the backend.

## Scope

### In scope

- Note CRUD: set note text on a cell, clear note from a cell, read note text for the active cell.
- Comment thread CRUD: post a new comment on a cell, delete an individual comment, delete an entire thread.
- Resolve / reopen a comment thread.
- Per-cell indicator flags in the visible-window projection: `noteIndicator` and `commentThreadId` on `DisplayCell`.
- Active session state: which cell's thread panel is open, the draft reply string.

### Out of scope

- Rich-media attachments (images, files inside a comment body).
- Mentions and notifications (at-mention rendering, email/push delivery).
- Presence (who is currently viewing or typing in a thread — see presence doc).

## State (UI core)

Atoms live in `src/comments/index.ts`. All bodies and thread data are fetched through backend ports and are not cached in UI atoms.

```ts
// which cell's comment thread panel is open, null when closed
export const commentSessionAtom = atom<CommentSession | null>(null)
commentSessionAtom.debugLabel = 'spreadsheet.comments.session'

// draft text for the pending reply or new thread post
export const commentEditorDraftAtom = atom<string>('')
commentEditorDraftAtom.debugLabel = 'spreadsheet.comments.editorDraft'

// last dispatched comment intent for host adapter consumption
export const commentIntentAtom = atom<CommentIntent | null>(null)
commentIntentAtom.debugLabel = 'spreadsheet.comments.intent'
```

`CommentSession` holds the open cell coordinate, the active sheet id, and the known `threadId` (null when opening a cell with no existing thread).

State decision summary:

- Source atoms: `commentSessionAtom`, `commentEditorDraftAtom`, `commentIntentAtom`.
- Derived atoms: none — thread data is not projected into atoms.
- Commands: `openCommentSessionAtom`, `closeCommentSessionAtom`, `dispatchCommentIntentAtom`.
- Scale bound: one session, one draft string — never per-cell atom families.
- Backend reads: host adapter fetches thread body on session open.
- Per-cell/per-row/per-col atom risk: not applicable.
- Tests: `test/comments-notes.test.ts`.

## Types

```ts
// note — single plain-text string, no threading
export interface CellNote {
  text: string
}

// a single comment inside a thread
export interface Comment {
  id: string
  author: string          // display name or opaque identifier; backend resolves
  body: string
  createdAt: string       // ISO 8601
}

// a full thread; contents fetched by host adapter, not stored in UI atoms
export interface CommentThread {
  id: string
  comments: Comment[]
  resolved: boolean
}

// active session descriptor held in commentSessionAtom
export interface CommentSession {
  sheetId: string
  row: number
  col: number
  threadId: string | null  // null → cell has no thread yet
}

// backend request shapes (all extend SheetRef implicitly via sheetId)
export interface SetNoteRequest {
  kind: 'set-note'
  sheetId: string
  row: number
  col: number
  text: string
  requestId?: number
  revision?: ProjectionRevision
}

export interface ClearNoteRequest {
  kind: 'clear-note'
  sheetId: string
  row: number
  col: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface PostCommentRequest {
  kind: 'post-comment'
  sheetId: string
  row: number
  col: number
  threadId: string | null  // null → create new thread
  body: string
  requestId?: number
  revision?: ProjectionRevision
}

export interface ResolveCommentThreadRequest {
  kind: 'resolve-comment-thread'
  sheetId: string
  threadId: string
  resolved: boolean        // true = resolve, false = reopen
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

// intent union for commentIntentAtom
export type CommentIntent =
  | { type: 'comment.set-note'; request: SetNoteRequest }
  | { type: 'comment.clear-note'; request: ClearNoteRequest }
  | { type: 'comment.post'; request: PostCommentRequest }
  | { type: 'comment.resolve-thread'; request: ResolveCommentThreadRequest }
  | { type: 'comment.delete-comment'; request: DeleteCommentRequest }
```

## Backend port

All methods are optional. Host adapters that do not implement comments/notes simply omit them and the UI falls back to hiding the relevant menu items.

```ts
// additions to SpreadsheetBackend
setNote?(request: SetNoteRequest): Promise<BackendMutationResult>
clearNote?(request: ClearNoteRequest): Promise<BackendMutationResult>
postComment?(request: PostCommentRequest): Promise<BackendMutationResult & { threadId: string }>
resolveCommentThread?(request: ResolveCommentThreadRequest): Promise<BackendMutationResult>
deleteComment?(request: DeleteCommentRequest): Promise<BackendMutationResult>
```

`DisplayCell` gains two optional indicator fields populated by the visible-window projection result:

```ts
export interface DisplayCell {
  // ... existing fields ...
  noteIndicator?: boolean       // true when the cell has a note
  commentThreadId?: string      // present when the cell has at least one comment thread
}
```

The projection backend fills these from sparse metadata; it must not materialise thread bodies in the projection result.

## Integration points

- **Menu** (`src/menu/`): right-click on a cell surface dispatches `MenuCommandKind` entries `'note.insert'`, `'note.clear'`, `'comment.insert'`. `isCommandAllowedForTarget` allows these for `'cell'` and `'range'` targets. Host adapters gate visibility on whether `setNote` / `postComment` are present on the backend.
- **Pointer** (`src/pointer/`): clicking a `noteIndicator` cell opens a note tooltip (no session atom needed — tooltip is stateless). Clicking a `commentThreadId` cell dispatches `openCommentSessionAtom` with the cell coordinate and known thread id.
- **Projection** (`src/backend/types.ts`): `noteIndicator` and `commentThreadId` on `DisplayCell` flow through `VisibleProjectionResult.cells`. No additional projection request kind is added.
- **Keyboard**: `Shift+F2` opens the note editor for the active cell (matches Excel/Sheets convention). The keyboard module maps this key to a `'note.edit'` keyboard intent consumed by the host UI layer.
- **Editing**: comment and note editors are independent panels managed by the host UI. They do not share state with `editingDraftAtom` or the formula bar. The cell editor is not used.
- **Workspace** (`src/workspace/`): `BackendMutationResult.revision` from note/comment mutations updates the workspace revision atom, keeping the visible projection in sync.

## Risks & open questions

- **Deleting cells with comments**: row/column delete operations (`deleteRows`, `deleteColumns`) may orphan comment threads. The backend must define whether threads move with shifted cells, are deleted, or persist at the original coordinate. UI core has no policy here — the host adapter is responsible.
- **Comment thread pagination**: `CommentThread.comments` is returned in full by the host adapter on session open. For threads with many replies the adapter may need to paginate; the UI core type does not currently model a cursor. A `nextCursor` field on a future `ReadCommentThreadResult` can be added without breaking existing ports.
- **Bounded UI cache vs paginated backend reads**: the UI core must not cache thread bodies in an atom family keyed by cell coordinate. If the host needs a read-through cache, that belongs in the adapter layer, not here.
- **Anonymous vs identified authors**: `Comment.author` is an opaque string supplied by the backend. The UI core makes no assumption about identity resolution, avatars, or whether the current user can edit others' comments. Host adapters enforce edit permissions before calling `deleteComment`.
- **Presence avatars on threads**: showing who is currently viewing or typing in a thread is deferred to the presence doc. `commentSessionAtom` does not carry presence metadata.
- **Note vs comment coexistence**: a cell can have both a note and a comment thread simultaneously. The projection carries both `noteIndicator` and `commentThreadId` independently; the host UI decides how to render overlapping indicators.

## Test surface

Tests live in `test/comments-notes.test.ts`.

Coverage targets:

- `commentSessionAtom`: open, close, reopen with different cell coordinates.
- `commentEditorDraftAtom`: set draft, clear on session close.
- `commentIntentAtom`: each intent variant is dispatched with correct shape.
- Backend port shapes: verify `SetNoteRequest`, `PostCommentRequest`, `ResolveCommentThreadRequest`, and `DeleteCommentRequest` serialise correctly (no runtime, pure type-level fixtures).
- `DisplayCell` indicator fields: assert `noteIndicator` and `commentThreadId` pass through a mock `VisibleProjectionResult` without mutation.
- Guard: no import of DOM, Solid, React, worker, or WASM in `src/comments/`.
