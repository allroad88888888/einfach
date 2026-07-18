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
`fill-range`, `fill-series`, `paste-range`, `import-cell-chunks`): remaps
display rows to source rows via the visible projection's
`DisplayCell.originalRow` (identity when filter/sort is inactive; fail-closed
when a row cannot be mapped) and enforces the UI-side protection gate
(`isRangeFullyUnlocked` over the mapped source ranges) before any transport.

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
- Format-only mutations are exempt (`protectionGate: false` skips the lock
  gate but still remaps rows).
- Tests: `test/mutation-gateway.test.ts`.
