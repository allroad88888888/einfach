# comments

Cell-anchored notes (single plain text) and threaded comments with author and resolved state.

## State Decision Template

- Source atoms:
  - `commentSessionAtom`: which cell's comment thread panel is open, null when closed.
  - `commentEditorDraftAtom`: draft text for the pending reply or new thread post.
  - `commentIntentAtom`: last dispatched comment intent for host adapter consumption.
- Derived atoms: none — thread data is not projected into atoms.
- Commands:
  - `openCommentSessionAtom`
  - `closeCommentSessionAtom`
  - `setCommentDraftAtom`
- Scale bound: one session, one draft string — never per-cell atom families.
- Backend reads: host adapter fetches thread body on session open.
- Per-cell/per-row/per-col atom risk: not applicable.
- Tests: `test/comments-notes.test.ts`.
