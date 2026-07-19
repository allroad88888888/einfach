# history

Owns undo/redo stack state and backend transaction dispatch contracts.

Two entry families share one bounded stack:

- **Backend entries** (default): descriptor + `transactionId` only; undo/redo round-trips
  through the backend `undoTransaction` / `redoTransaction` ports with strict revision
  witnessing.
- **Local-replay entries** (`entry.localReplay` present): UI-core canonical view facts
  (freeze today) whose undo/redo closes inside UI-core. The entry carries the exact
  `before` / `after` payloads plus an `applyKey`; the applier registered via
  `registerHistoryLocalReplayApplier` re-applies the payload synchronously. No backend
  port, no revision witness, no transport lane — and local entries never advance the
  backend projection-revision witness (`spreadsheet.history.projectionRevisionBacking`),
  keeping local labels out of the strict backend counter.

## State Decision Template

- Source atoms:
  - `historyStackAtom`: bounded stack of `HistoryEntry` descriptors, cursor position, and in-flight flag.
- Derived atoms:
  - `historyInFlightAtom`: boolean shortcut for `inFlight`.
  - `canUndoAtom`: `true` when cursor > 0 and not in flight.
  - `canRedoAtom`: `true` when entries exist above cursor and not in flight.
- Commands:
  - `pushHistoryAtom` — appends entry, truncates redo tail, evicts oldest when over cap.
  - `runUndoHistoryAtom` / `runRedoHistoryAtom` — backend entries dispatch a transaction
    and refresh; local-replay entries apply their payload in-process and complete
    synchronously.
  - `retryHistoryRefreshAtom` — retries a failed post-acknowledgement refresh.
  - `clearHistoryAtom` — resets stack and cursor.
- Scale bound: `DEFAULT_HISTORY_CAP = 100` entries; each entry is a small descriptor (~100 bytes). No cell content stored; local-replay payloads are tiny scalar view facts (freeze: two integers per side).
- Backend reads: optional `undoTransaction` / `redoTransaction` methods on `SpreadsheetBackend` (backend entries only).
- Per-cell/per-row/per-col atom risk: entries must never carry cell content or row/column snapshots.
- Tests: `test/history.test.ts`, `test/frozen-panes.test.ts` (local replay).
