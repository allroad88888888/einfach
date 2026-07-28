# find-replace

Find and replace feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Ctrl/Cmd+F opens a search dialog. The user types a query; matches are
highlighted in the visible window and navigated with prev/next (F3 / Shift+F3).
An optional replace field lets the user substitute one match or all matches in
the selected scope. The UI core owns query state, cursor position, and status.
The backend owns the search index and replacement mutations.

---

## Scope

- Case-sensitive and case-insensitive matching.
- Whole-cell match option (match only when the full cell text equals the query).
- Regular expression mode (the query is treated as a `RegExp` pattern).
- Scope: current sheet, all sheets in the workbook, or the current selection.
- Search target: displayed value (default) or raw formula text.
- Navigate matches: next / previous with wrap-around.
- Replace current match or replace all in scope.
- Bounded highlight: store only current-page match coordinates, not the full
  match list.

**Out of scope**

- Cross-workbook search (across multiple open workbooks).
- Find-by-format (color, bold, number format, etc.).
- Incremental streaming of all matches into a results panel.
- Search inside the clipboard source buffer.
- Regular expression replacement back-references (initial implementation).

---

## State (UI core)

New module: `src/find-replace/`.

### Source atoms

**`findReplaceQueryAtom`** — `atom<FindReplaceQuery | null>`  
Holds the active query string and options. `null` means the dialog is closed.

```ts
findReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.query'
```

**`findReplaceCursorAtom`** — `atom<FindCursorState>`  
Current match index within the bounded window result and total match count
reported by the backend. Resets to `{ index: 0, total: 0, pageMatches: [] }`
when the query changes.

```ts
findReplaceCursorAtom.debugLabel = 'spreadsheet.findReplace.cursor'
```

**`findReplaceStatusAtom`** — `atom<FindReplaceStatus>`  
Lifecycle status: `'idle' | 'searching' | 'ready' | 'error'`.

```ts
findReplaceStatusAtom.debugLabel = 'spreadsheet.findReplace.status'
```

### Derived atoms

None in the first wave. `currentMatchCoord` is read directly from
`findReplaceCursorAtom.pageMatches[index]` by the host adapter.

### Command atoms

**`openFindReplaceAtom`** — `atom(null, (get, set, query?: string) => void)`  
Sets `findReplaceQueryAtom` to defaults (or the passed-in prefill), transitions
status to `'idle'`.

```ts
openFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.open'
```

**`closeFindReplaceAtom`** — `atom(null, (get, set) => void)`  
Clears query, cursor, and status. Returns selection to pre-search state.

```ts
closeFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.close'
```

**`commitFindReplaceQueryAtom`** — `atom(null, (get, set, query: FindReplaceQuery) => void)`  
Updates the query atom and resets the cursor. Sets status to `'searching'`.
The host adapter observes `findReplaceQueryAtom` changes and calls
`searchRange` on the backend.

```ts
commitFindReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.commitQuery'
```

**`advanceFindReplaceCursorAtom`** — `atom(null, (get, set, direction: 'next' | 'prev') => void)`  
Increments or decrements the index with wrap-around inside `pageMatches`. When
the index crosses a page boundary the host adapter must request the next chunk
from `searchRange`.

```ts
advanceFindReplaceCursorAtom.debugLabel = 'spreadsheet.findReplace.advance'
```

**`resolveFindReplaceAtom`** — `atom(null, (get, set, result: FindRangeResult) => void)`  
Called by the host adapter with a page of matches. Stores up to `MAX_FIND_PAGE`
coords, sets total, transitions status to `'ready'` or `'error'`.

```ts
resolveFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.resolve'
```

**`replaceCurrentMatchAtom`** — `atom(null, (get, set, replacement: string) => void)`  
Emits a `ReplaceTransactionInput` for the current match coord. Host adapter
calls `replaceMatches` on the backend, then advances the cursor.

```ts
replaceCurrentMatchAtom.debugLabel = 'spreadsheet.findReplace.replaceCurrent'
```

**`replaceAllMatchesAtom`** — `atom(null, (get, set, replacement: string) => void)`  
Emits a `ReplaceTransactionInput` covering the full match scope. Host adapter
calls `replaceMatches` in batch; may iterate chunks like `importCellChunks`.

```ts
replaceAllMatchesAtom.debugLabel = 'spreadsheet.findReplace.replaceAll'
```

### Scale bound

`MAX_FIND_PAGE = 500` match coords stored in `findReplaceCursorAtom.pageMatches`
at any time. Full match lists are never materialised in the UI core.

---

## Types

```ts
export type FindReplaceStatus = 'idle' | 'searching' | 'ready' | 'error'

export type FindReplaceScope = 'sheet' | 'workbook' | 'selection'

export type FindReplaceTarget = 'displayValue' | 'formula'

export interface FindReplaceOptions {
  caseSensitive: boolean
  wholeCell: boolean
  regex: boolean
  scope: FindReplaceScope
  target: FindReplaceTarget
}

export interface FindReplaceQuery {
  text: string
  options: FindReplaceOptions
  scopeRange?: { sheetId: string; range: CellRange }
}

export interface FindMatch {
  coord: CellCoord
  sheetId: string
  matchStart: number
  matchEnd: number
}

export interface FindCursorState {
  index: number
  total: number
  pageMatches: readonly FindMatch[]
}

export interface FindRangeRequest extends SheetRef {
  kind: 'find-range'
  query: FindReplaceQuery
  pageSize: number
  pageOffset: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface FindRangeResult extends SheetRef {
  kind: 'find-range'
  requestId?: number
  revision?: ProjectionRevision
  matches: FindMatch[]
  total: number
  pageOffset: number
  truncated?: boolean
}

export interface ReplaceMatchInput {
  match: FindMatch
  replacement: string
}

export interface ReplaceTransactionInput extends SheetRef {
  kind: 'replace-matches'
  matches: ReplaceMatchInput[]
  requestId?: number
  revision?: ProjectionRevision
}
```

---

## Backend port

Two optional methods added to `SpreadsheetBackend`:

```ts
searchRange?(request: FindRangeRequest): Promise<FindRangeResult>
replaceMatches?(request: ReplaceTransactionInput): Promise<BackendMutationResult>
```

Both are **optional**. When absent the UI core keeps the status as `'idle'` and
disables the find dialog.

**Chunked semantics** follow the same pattern as `importCellChunks`:

- `FindRangeRequest` carries `pageSize` (≤ `MAX_FIND_PAGE`) and `pageOffset`.
- The backend returns `matches` for that window plus a `total` count.
- The host adapter iterates pages on demand as the user navigates past the
  current page boundary, issuing a new `searchRange` call per page.
- `total` may be an estimate on the first page if the backend streams lazily;
  it should be exact once the last page is returned (`truncated` is `false`).
- `replaceMatches` receives only the coords of cells to rewrite — no cell
  content snapshot. The backend resolves match context from its own index.
  For replace-all, the host adapter may chunk the `matches` array if the set
  exceeds a practical RPC size, analogously to chunked paste.

---

## Integration points

**Keyboard** — `Ctrl/Cmd+F` dispatches `openFindReplaceAtom`. `F3` dispatches
`advanceFindReplaceCursorAtom('next')`. `Shift+F3` dispatches
`advanceFindReplaceCursorAtom('prev')`. `Escape` dispatches
`closeFindReplaceAtom`. Keyboard intents must be declared in `keyboard/intents`.

**Selection** — match highlights are rendered per `pageMatches` coords in the
visible window only; the host adapter overlays highlights from the projection
layer. The current match moves the selection anchor via the existing
`selectCellAtom` / `moveSelectionAtom` contracts so the formula bar and editing
module see the correct active cell.

**Viewport** — after a cursor advance the host adapter calls `scrollToCellAtom`
with the current match coord so the cell scrolls into view. No new viewport atom
is needed.

**Editing** — replace must not fire while an active edit session is open
(`editingStateAtom.status === 'editing'`). `replaceCurrentMatchAtom` and
`replaceAllMatchesAtom` must check editing status and either block (return
early) or queue the replace intent for dispatch after commit/cancel.

**Clipboard** — no interaction. Search inside a paste source buffer is out of
scope.

**Diagnostics** — on `FindRangeResult` error or `replaceMatches` rejection the
host adapter calls `resolveFindReplaceAtom` with an empty `matches` array and
sets status to `'error'`. The diagnostics module records the error via the
existing `pushDiagnosticAtom` contract.

---

## Risks & open questions

- **Huge match counts (>10⁵).** The paged protocol caps UI memory, but the
  backend must still scan the full sheet. A backend without an index will
  degrade linearly. Define a `maxMatches` cap in `FindRangeRequest` so the
  backend can short-circuit and return `truncated: true` at a safe limit.

- **Regex pathological input.** Client-side regex parsing (for validation
  feedback) must run with a timeout guard or in a worker to avoid blocking the
  main thread on catastrophic backtracking. Decide whether validation happens in
  the UI core (pure, no DOM) or is delegated to the host adapter.

- **Replace-all under merged cells.** If a matched range spans a merged region,
  a write to a non-origin cell of the merge may silently fail or corrupt the
  merge. The backend must document whether `replaceMatches` unmerges cells, skips
  them, or returns a partial error. The UI core should surface `truncated` or an
  error status when the backend reports a partial write.

- **Search in formulas vs displayed values.** Switching `target` between
  `'formula'` and `'displayValue'` mid-session produces a different match set.
  The cursor must reset on every option change, not only on text changes.
  Confirm the atom model resets `findReplaceCursorAtom` whenever any field of
  `FindReplaceOptions` changes, not just `query.text`.

- **Ordering with workspace revisions.** A `searchRange` call captures a
  `revision`. If a concurrent mutation (paste, undo) advances the workspace
  revision before the result arrives, the returned match coords may be stale.
  Define whether the host adapter re-issues the search on revision advance or
  surfaces a staleness warning via `findReplaceStatusAtom`.

- **Replace-all chunk failure.** If a multi-chunk replace-all partially
  succeeds before a network or worker error, the UI core may show an incorrect
  total-replaced count. The backend should return a single transaction id for the
  entire replace-all so the operation can be fully undone as one history entry.

---

## Test surface

All tests live in `test/find-replace.test.ts`.

- `findReplaceQueryAtom` is `null` on init; `openFindReplaceAtom` sets defaults.
- `closeFindReplaceAtom` resets query, cursor, and status to initial values.
- `commitFindReplaceQueryAtom` updates query and resets cursor to index 0.
- `resolveFindReplaceAtom` stores up to `MAX_FIND_PAGE` matches; excess is
  truncated.
- Status transitions: `idle → searching → ready` on success, `→ error` on
  failure.
- `advanceFindReplaceCursorAtom('next')` wraps from last to first index.
- `advanceFindReplaceCursorAtom('prev')` wraps from first to last index.
- `replaceCurrentMatchAtom` no-ops when status is not `'ready'`.
- `replaceCurrentMatchAtom` no-ops when editing status is `'editing'`.
- Changing any `FindReplaceOptions` field resets cursor state.
- `replaceAllMatchesAtom` emits a `ReplaceTransactionInput` covering all
  `pageMatches` coords.
- Backend absent (`searchRange` undefined): status stays `'idle'`, commands
  are no-ops.
