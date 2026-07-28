# selection

Owns active cell, anchor/focus range, row/column/all selection, and name-box anchors.

## State Decision Template

- Source atoms:
  - `selectionAtom`: current sheet id, selection kind, and anchor/focus boundaries only.
  - `selectionBoundsAtom`: current sheet row/column count used for clamping.
- Derived atoms:
  - `activeCellAtom`: active cell for edit focus and keyboard movement.
  - `selectionRangeAtom`: normalized display range boundaries.
  - `selectionSnapshotAtom`: compact snapshot for adapters that need all derived values at once.
- Commands:
  - `setSelectionAtom`
  - `setSelectionBoundsAtom`
  - `selectCellAtom`
  - `selectRowsAtom`
  - `selectColumnsAtom`
  - `selectAllAtom`
- Scale bound: selection stores boundaries and modes only. It never expands a range into addresses.
- Backend reads: none. Sheet dimensions are passed in by the adapter through `selectionBoundsAtom`.
- Per-cell/per-row/per-col atom risk: forbidden. Row/column/all selection derive bounded ranges from
  counts, not from enumerated ids.
- Tests:
  - boundary clamping
  - range extension without cell enumeration
  - row/column/all derived range contracts
  - active-cell derivation
