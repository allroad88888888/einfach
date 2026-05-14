# editing

Owns cell editor draft, source, commit, and cancel UI state.

## State Decision Template

- Source atoms:
  - `editingSessionAtom`: one active edit session, including address, source, draft, and diagnostic.
  - `editingIntentAtom`: last edit intent for the host adapter to consume.
- Derived atoms:
  - `editingIsActiveAtom`: derived from `editingSessionAtom.status`.
  - `editingDraftAtom`: writable draft view over `editingSessionAtom`.
- Commands:
  - `startEditingAtom`
  - `commitEditingAtom`
  - `cancelEditingAtom`
- Scale bound: one active edit session.
- Backend reads: none directly. Adapter may read source/formula text when starting an explicit edit.
- Per-cell/per-row/per-col atom risk: none; editing state stores one active cell coordinate only.
- Tests: `test/editing.test.ts`.
