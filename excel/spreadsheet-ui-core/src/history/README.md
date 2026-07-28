# history

Owns undo/redo stack state and backend transaction dispatch contracts.

Two entry families share one bounded stack:

- **Backend entries** (default): descriptor + `transactionId` only; undo/redo round-trips
  through the backend `undoTransaction` / `redoTransaction` ports with strict revision
  witnessing.
- **Local-replay entries** (`entry.localReplay` present): UI-core canonical view facts
  (freeze, hidden rows/columns) whose undo/redo closes inside UI-core. The entry carries
  the exact `before` / `after` payloads plus an `applyKey`; the applier registered via
  `registerHistoryLocalReplayApplier` re-applies the payload synchronously. No backend
  port, no revision witness, no transport lane — and local entries never advance the
  backend projection-revision witness (`spreadsheet.history.projectionRevisionBacking`),
  keeping local labels out of the strict backend counter.

## Revision witness semantics (host-orchestrated undo, design point C)

Backend undo/redo requests carry the last revision UI-core witnessed
(`spreadsheet.history.projectionRevisionBacking`), but backends MUST NOT enforce a strict
"request revision == current revision" precondition: engine-initiated bumps are legal
between a push and the matching undo (async custom-formula settles bump the backend
revision unconditionally — see CANONICAL_OWNERSHIP §4-2). The witness separation is:

- The history witness advances only on `pushHistoryAtom` (backend entries) and on a
  strictly-correlated acknowledgement; local-replay entries never touch it.
- The acknowledgement's `revision` is accepted as authoritative and becomes the next
  witness — whatever engine-initiated bumps happened in between.
- A backend that cannot replay the transaction (unknown `transactionId`, snapshot
  missing, entry degraded to not-undoable at record time) returns a **structured
  not-applied** acknowledgement (`applied: false` + `notAppliedReason`) instead of a
  fake success or a bare throw. UI-core then keeps the cursor, does NOT commit the
  acknowledged revision, and surfaces `HISTORY_NOT_APPLIED_ERROR` through the existing
  outcome-unknown convention — hosts recover by re-reading canonical state.

## Sheet lifecycle exclusion (design point D)

`addSheet` / `deleteSheet` / `renameSheet` / `reorderSheet` are NOT recorded as history
entries and MUST NOT be replayed through `undoTransaction` / `redoTransaction`.
Persistence-v1 restore drops the custom-formula registry, named values, and
subscriptions, so a snapshot-based sheet-level undo would resurrect a maimed workbook;
the registration-replay protocol is separate future work (CANONICAL_OWNERSHIP §4-3).
Worker adapters additionally drop their recorded transaction log when sheet indices
shift (`deleteSheet` / `reorderSheet`) — replaying a stale sheet index would target the
wrong sheet, and a not-applied answer is the truthful degradation.

Backend entries may additionally carry **local side payloads**
(`entry.localSidePayloads`): when a structural backend mutation displaces UI-core
canonical view facts (freeze band, hidden index sets), the operation snapshots them as
before/after payloads at acknowledgement time. After the backend acknowledges the
transaction's undo/redo, each payload replays through the same applier registry —
inverting the structural shift cannot restore them (a delete erases hidden index
membership). Side payloads never run without a backend acknowledgement and are dropped
from entries that also carry `localReplay`.

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
- Scale bound: `DEFAULT_HISTORY_CAP = 100` entries; each entry is a small descriptor (~100 bytes). No cell content stored; local-replay and side payloads are bounded view facts (freeze: two integers per side; hidden: the sheet's actually-hidden sorted indices per side).
- Backend reads: optional `undoTransaction` / `redoTransaction` methods on `SpreadsheetBackend` (backend entries only).
- Per-cell/per-row/per-col atom risk: entries must never carry cell content or dense row/column snapshots.
- Tests: `test/history.test.ts`, `test/frozen-panes.test.ts`, `test/hidden-rows-columns.test.ts` (local replay + side payloads).
