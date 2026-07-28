# history

Undo/redo (history) feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Expose bounded undo/redo state as atoms and forward `history.undo` / `history.redo`
intents to the backend, which owns inverse payloads and applies or reverts
transactions. UI core tracks only the stack cursor, capacity metadata, and
in-flight status.

---

## Scope

- Declare `HistoryStackState` atom (depth, canUndo, canRedo, inFlight).
- Declare `historyUndoAtom` and `historyRedoAtom` command atoms.
- Declare `pushHistoryEntryAtom` for modules that emit mutations.
- Define `UndoRequest` / `RedoRequest` backend port methods (optional).
- Define `HistoryEntry` type carrying a transaction id reconcilable with
  `workspace.projectionRequestRevision`.
- Specify default stack cap (100) and eviction policy (drop oldest).
- Wire `HistoryIntent` (already declared in keyboard) to the command atoms.

**Out of scope**

- Storing inverse cell payloads in the UI core.
- Per-cell, per-row, or per-column atoms.
- Collaborative / multi-client conflict resolution.
- Persistent history across page reload.
- Format-only undo as a separate stack.
- Partial undo within a multi-range paste (treat paste as one entry).

---

## State (UI core)

### Source atoms

**`historyStackAtom`** — `atom<HistoryStackState>`  
Stores the bounded stack cursor, entry count, and in-flight flag. Never stores
cell content.

```ts
historyStackAtom.debugLabel = 'spreadsheet.history.stack'
```

### Derived atoms

**`canUndoAtom`** — `atom<boolean>`  
`true` when `stackDepth > 0 && cursor > 0 && !inFlight`.

```ts
canUndoAtom.debugLabel = 'spreadsheet.history.canUndo'
```

**`canRedoAtom`** — `atom<boolean>`  
`true` when entries exist above the cursor and `!inFlight`.

```ts
canRedoAtom.debugLabel = 'spreadsheet.history.canRedo'
```

### Command atoms

**`pushHistoryEntryAtom`** — `atom(null, (get, set, entry: HistoryEntry) => void)`  
Appends a new entry, truncates the redo tail, evicts the oldest entry when
`stackDepth >= MAX_HISTORY_DEPTH`. Called by operations, clipboard, and
editing modules after a successful backend mutation result.

```ts
pushHistoryEntryAtom.debugLabel = 'spreadsheet.history.pushEntry'
```

**`historyUndoAtom`** — `atom(null, (get, set) => HistoryEntry | null)`  
Moves cursor back one step, sets `inFlight`, returns the entry to send to the
backend. No-op when `!canUndo`.

```ts
historyUndoAtom.debugLabel = 'spreadsheet.history.undo'
```

**`historyRedoAtom`** — `atom(null, (get, set) => HistoryEntry | null)`  
Moves cursor forward one step, sets `inFlight`, returns the entry to send to
the backend. No-op when `!canRedo`.

```ts
historyRedoAtom.debugLabel = 'spreadsheet.history.redo'
```

**`resolveHistoryAtom`** — `atom(null, (get, set, result: HistoryResolveResult) => void)`  
Clears `inFlight`. On failure, reverts cursor to previous position.

```ts
resolveHistoryAtom.debugLabel = 'spreadsheet.history.resolve'
```

### Scale bound

- Default cap: `MAX_HISTORY_DEPTH = 100` entries.
- Eviction policy: drop the oldest entry (index 0) when the cap is reached.
- Each entry is a fixed-size descriptor (transaction id + kind + sheetId +
  optional compact range). No cell content stored.

---

## Types

```ts
export type HistoryTransactionId = string

export type HistoryEntryKind =
  | 'cell.set-input'
  | 'cells.import'
  | 'range.clear'
  | 'range.fill'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'sheet.add'
  | 'sheet.delete'
  | 'sheet.rename'
  | 'sheet.reorder'
  | 'format.set'

export interface HistoryEntry {
  transactionId: HistoryTransactionId
  kind: HistoryEntryKind
  sheetId: string | null
  projectionRevision: number
  affectedRange?: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }
}

export interface HistoryStackState {
  entries: readonly HistoryEntry[]
  cursor: number
  inFlight: boolean
}

export interface HistoryResolveResult {
  transactionId: HistoryTransactionId
  ok: boolean
  revision?: number | string
}

export interface UndoRequest {
  kind: 'history.undo'
  transactionId: HistoryTransactionId
  requestId?: number
  revision?: number | string
}

export interface RedoRequest {
  kind: 'history.redo'
  transactionId: HistoryTransactionId
  requestId?: number
  revision?: number | string
}

export interface HistoryMutationResult {
  transactionId: HistoryTransactionId
  requestId?: number
  revision?: number | string
  ok: boolean
}
```

---

## Backend port

Two optional methods added to `SpreadsheetBackend`:

```ts
undoTransaction?(request: UndoRequest): Promise<HistoryMutationResult>
redoTransaction?(request: RedoRequest): Promise<HistoryMutationResult>
```

Both are **optional**. A backend that does not implement them causes the UI
core to treat the feature as unavailable (`canUndo` / `canRedo` remain `false`
regardless of stack depth).

`UndoRequest` and `RedoRequest` carry only `transactionId` — no cell content,
no range snapshot. The backend resolves the inverse operation from its own
transaction log. `HistoryMutationResult.revision` is the new backend revision
after applying the inverse; the host adapter passes this back via
`commitWorkspaceProjectionAtom` to re-trigger visible-window projection.

Range context in `HistoryEntry.affectedRange` is informational for the backend
(e.g., to scope a re-projection request) but must not be treated as an inverse
payload.

---

## Integration points

**Emit `pushHistoryEntry`** (after a successful `BackendMutationResult`):

- `operations` — `setCellInput`, `insertRows`, `deleteRows`, `insertColumns`,
  `deleteColumns` all produce a mutation result; the host adapter or command
  layer calls `pushHistoryEntryAtom` with the transaction id from the result.
- `editing` — commit path calls `setCellInput`; entry pushed post-commit.
- `clipboard` — paste (`importCells` / `importCellChunks`) and cut-clear both
  push entries after the backend confirms.
- `toolbar` — format-range mutations push an entry.

**Read history state** (to enable/disable controls):

- `keyboard` — `HistoryIntent` (`history.undo`, `history.redo`) already
  declared; the keyboard handler reads the resulting intent and dispatches
  `historyUndoAtom` or `historyRedoAtom`.
- `toolbar` — reads `canUndoAtom` / `canRedoAtom` to render button state.
- `operations` — no read; push only.
- `workspace` — `projectionRevision` from `HistoryEntry` lets the host adapter
  detect staleness after an undo/redo round-trip.

**Not wired** in the first wave: formula-bar, sheet-tabs, viewport (they
observe projection refreshes triggered by the backend after undo/redo, not the
history stack directly).

---

## Risks & open questions

- **Memory bound on the stack.** Each `HistoryEntry` is a small descriptor
  (~100 bytes), so 100 entries costs roughly 10 KB — acceptable. Risk is host
  adapters appending duplicate or redundant entries (e.g., one per keystroke in
  rapid input); callers must debounce or batch before pushing.

- **Ordering with `workspace.revision`.** `HistoryEntry.projectionRevision`
  captures the `projectionRequestRevision` at push time. After an undo, the
  backend returns a new revision; if it does not match the next
  `requestWorkspaceProjectionRevision` tick, the visible-window projection will
  be re-requested automatically. Verify the host adapter always increments the
  workspace revision on undo/redo results, not only on forward mutations.

- **Undo lives in backend, not UI core.** UI core holds no inverse payload.
  This avoids duplicating workbook state in the UI layer and keeps the UI core
  below the no-workbook-facts constraint. The trade-off is that backends without
  a transaction log cannot support undo; they must leave `undoTransaction` /
  `redoTransaction` unimplemented.

- **Recovery on backend revision drift.** If the backend's transaction log
  loses an entry (e.g., worker restart, WASM reload), `undoTransaction` should
  return `ok: false`. `resolveHistoryAtom` will revert the cursor; the host
  adapter should also call `advanceWorkspaceViewportAtom` to force a fresh
  projection. Define whether the stack is fully cleared or only the failed entry
  is removed — recommend full clear on any `ok: false` to avoid a corrupted
  cursor state.

- **Multi-region edits (clipboard paste).** A large paste or
  `importCellChunks` call covers many cells but must push exactly one
  `HistoryEntry`. Confirm that the backend transaction log groups the entire
  chunked import under a single transaction id before the entry is pushed.
  Partial-chunk failures need a rollback protocol on the backend side before
  `HistoryMutationResult` is returned.

- **`inFlight` serialisation.** While `inFlight` is `true`, keyboard and
  toolbar must suppress further undo/redo intents. The current atom model is
  synchronous; the host adapter must call `resolveHistoryAtom` from its async
  callback, not inside an atom write. Document this contract explicitly to
  prevent adapter authors from writing into the store during a pending promise.

---

## Test surface

All tests live in `test/history.test.ts`.

- Push entries up to `MAX_HISTORY_DEPTH`; verify oldest entry is evicted and
  `entries.length` stays at cap.
- Push beyond cap and verify `cursor` tracks correctly after eviction.
- `canUndoAtom` is `false` on empty stack and `true` after one push.
- `canRedoAtom` is `false` after push, `true` after undo, `false` after redo.
- Redo tail is truncated when a new entry is pushed mid-stack.
- `historyUndoAtom` returns `null` and leaves cursor unchanged when
  `!canUndo`.
- `historyRedoAtom` returns `null` and leaves cursor unchanged when
  `!canRedo`.
- `inFlight` is set during undo/redo and cleared by `resolveHistoryAtom`.
- `resolveHistoryAtom` with `ok: false` reverts cursor to pre-undo position.
- Multiple sequential undos decrement cursor each time.
- Multiple sequential redos increment cursor each time.
- Undo entry carries the correct `transactionId` and `projectionRevision`.
- Stack resets cleanly when `resetWorkspaceSessionAtom` is called (verify
  coupling contract, not implementation).
