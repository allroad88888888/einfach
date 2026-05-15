# history

Owns undo/redo stack state and backend transaction dispatch contracts.

## State Decision Template

- Source atoms:
  - `historyStackAtom`: bounded stack of `HistoryEntry` descriptors, cursor position, and in-flight flag.
- Derived atoms:
  - `historyInFlightAtom`: boolean shortcut for `inFlight`.
  - `canUndoAtom`: `true` when cursor > 0 and not in flight.
  - `canRedoAtom`: `true` when entries exist above cursor and not in flight.
- Commands:
  - `pushHistoryAtom` — appends entry, truncates redo tail, evicts oldest when over cap.
  - `undoHistoryAtom` — moves cursor back, sets inFlight, returns the entry.
  - `redoHistoryAtom` — moves cursor forward, sets inFlight, returns the entry.
  - `resolveHistoryAtom` — clears inFlight; on failure clears the full stack.
  - `clearHistoryAtom` — resets stack and cursor.
- Scale bound: `DEFAULT_HISTORY_CAP = 100` entries; each entry is a small descriptor (~100 bytes). No cell content stored.
- Backend reads: optional `undoTransaction` / `redoTransaction` methods on `SpreadsheetBackend`.
- Per-cell/per-row/per-col atom risk: entries must never carry cell content or row/column snapshots.
- Tests: `test/history.test.ts`.
