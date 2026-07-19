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

## Mutation gateway (`mutation-gateway.ts`)

Single choke point for content mutations (`set-cell-input`, `clear-range`,
`fill-range`, `fill-series`, `paste-range`, `import-cell-chunks`) and format
writes (`set-format-range`): remaps display rows to source rows via the
visible projection's `DisplayCell.originalRow` (identity when filter/sort is
inactive; fail-closed when a row cannot be mapped) and enforces the UI-side
protection gate (`isRangeFullyUnlocked` over the mapped source ranges) before
any transport. `set-format-range` gates like content (Excel semantics: locked
cells on a protected sheet cannot be reformatted); consumers are the toolbar
format commands, the borders/clear-format/decimal paths, and the
format-painter apply port.

`requireIdentityMapping: true` serves transports whose frozen request shape
can only express the original contiguous display range (paste-special
`pasteRange` sessions, text-to-columns `importCellChunks` commit plans): an
otherwise-allowed resolution that would move or split any row fails closed as
`unmapped-row` instead of returning ranges the caller cannot forward.

- Source atoms:
  - `contentMutationLastBlockBackingAtom` (private) —
    `spreadsheet.mutationGateway.lastBlockBacking`.
- Derived atoms:
  - `contentMutationLastBlockAtom` — `spreadsheet.mutationGateway.lastBlock`;
    latest blocked resolution for UI hints, null when none.
- Commands:
  - `resolveContentMutationAtom` — `spreadsheet.mutationGateway.resolve`;
    returns `allowed` (source coords) or `blocked` (structured diagnostic,
    recorded on lastBlock + appended to diagnostics).
  - `clearContentMutationBlockAtom` — `spreadsheet.mutationGateway.clearBlock`.
- Scale bound: one recorded block; resolution work is bounded by the visible
  window row count.
- `protectionGate: false` skips the lock gate but still remaps rows (fill
  sources, format-only clears).
- Tests: `test/mutation-gateway.test.ts`.
