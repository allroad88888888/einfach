# frozen-panes

Frozen rows and columns (frozen panes) feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Pin N top rows and/or M left columns so they remain visible while the rest of the
sheet scrolls. The frozen header region renders on top of (or adjacent to) the
scrolling body without moving when `scrollTop` / `scrollLeft` changes.

---

## Scope

- Freeze top N rows per sheet (N ≥ 0).
- Freeze left M columns per sheet (M ≥ 0).
- Freeze-at-cell: freeze the rows above and columns to the left of a given cell
  (combined row + column freeze set from a single input).
- Per-sheet state stored in a single atom following the same
  `Record<sheetId, number>` map shape as `viewportSizeOverridesAtom`.

**Out of scope**

- Split panes (two independent scrollbars in a quadrant — Excel "window split").
- Frozen rows on the bottom edge or frozen columns on the right edge.
- Per-view (non-sheet) freeze overrides.
- Freeze animations or transitions.

---

## State (UI core)

Add a dedicated source atom rather than extending `ViewportMetrics`. Freeze
counts are sheet-level persistent state, not derived from scroll geometry, so
embedding them inside `ViewportMetrics` would conflate two orthogonal concerns
and make normalization more complex.

### Source atom

**`viewportFreezeAtom`** — `atom<ViewportFreezeState>`

```ts
viewportFreezeAtom.debugLabel = 'spreadsheet.viewport.freeze'
```

Default value:

```ts
export const DEFAULT_VIEWPORT_FREEZE: ViewportFreezeState = {
  rowsBySheet: {},
  colsBySheet: {},
}
```

### Derived atom

**`frozenWindowsAtom`** — `atom<FrozenWindows>` derived from
`viewportFreezeAtom`, `viewportMetricsAtom`, and the active sheet id.

Returns all four quadrant `VisibleWindow` values for the current sheet.
Consumers (renderer, projection layer) read this single derived value; they do
not re-derive quadrants independently.

```ts
frozenWindowsAtom.debugLabel = 'spreadsheet.viewport.frozenWindows'
```

### Command atoms

**`setFreezeAtom`** — `atom(null, (get, set, input: SetFreezeInput) => void)`

```ts
setFreezeAtom.debugLabel = 'spreadsheet.viewport.setFreeze'
```

**`clearFreezeAtom`** — `atom(null, (get, set, sheetId: string) => void)`

```ts
clearFreezeAtom.debugLabel = 'spreadsheet.viewport.clearFreeze'
```

### Scale bound

Two sparse `Record<string, number>` maps — one entry per sheet that has a
non-zero freeze. Cost is negligible regardless of sheet count.

---

## Types

```ts
export interface ViewportFreezeState {
  rowsBySheet: Record<string, number>
  colsBySheet: Record<string, number>
}

export interface SetFreezeInput {
  sheetId: string
  /** Number of rows to freeze from the top. 0 = unfreeze rows. */
  frozenRows: number
  /** Number of columns to freeze from the left. 0 = unfreeze cols. */
  frozenCols: number
}

export interface FreezeAtCellInput {
  sheetId: string
  /** Freeze all rows above this row index and all cols left of this col index. */
  row: number
  col: number
}

/**
 * Four-quadrant visible window produced when freeze counts are non-zero.
 *
 * Quadrant layout (R = frozen rows, C = frozen cols):
 *
 *   topLeft    topRight
 *   bottomLeft bottomRight
 *
 * topLeft    — rows [0, R), cols [0, C)       — frozen in both axes
 * topRight   — rows [0, R), cols [C, colEnd]  — frozen rows, scrolling cols
 * bottomLeft — rows [R, rowEnd], cols [0, C)  — scrolling rows, frozen cols
 * bottomRight— rows [R, rowEnd], cols [C, colEnd] — fully scrolling body
 *
 * Any quadrant with rowStart > rowEnd or colStart > colEnd is empty and must
 * be skipped by projection callers.
 */
export interface FrozenWindows {
  frozenRows: number
  frozenCols: number
  topLeft: VisibleWindow
  topRight: VisibleWindow
  bottomLeft: VisibleWindow
  bottomRight: VisibleWindow
}
```

`VisibleWindow` remains `CellRange` (unchanged). The four-quadrant split is
expressed as four `VisibleWindow` values, not a new range type.

`getFrozenWindows(metrics: ViewportMetrics, frozenRows: number, frozenCols: number): FrozenWindows`
is a pure function that lives in `viewport/window.ts` alongside `getVisibleWindow`.
Existing callers of `getVisibleWindow` are unaffected; they receive the full
union range as before when freeze counts are zero (bottom-right quadrant equals
the current visible window).

---

## Backend port

Workbook files (XLSX, ODS) encode freeze configuration in sheet view XML. The
backend must be able to surface that on load and persist changes.

Two optional methods added to `SpreadsheetBackend`:

```ts
readFreezeConfig?(sheetId: string): Promise<ReadFreezeConfigResult>
setFreezeConfig?(request: SetFreezeConfigRequest): Promise<BackendMutationResult>
```

New types:

```ts
export interface ReadFreezeConfigResult {
  sheetId: string
  frozenRows: number
  frozenCols: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface SetFreezeConfigRequest extends SheetRef {
  kind: 'set-freeze-config'
  frozenRows: number
  frozenCols: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
```

Both ports are **optional**. A backend that omits them treats freeze as UI-only
state (persisted in `viewportFreezeAtom` only, not written back to the file).
The host adapter calls `readFreezeConfig` after a sheet load and seeds
`viewportFreezeAtom` via `setFreezeAtom`. `setFreezeConfig` is called
optimistically after `setFreezeAtom` writes local state.

---

## Integration points

**Viewport** — `frozenWindowsAtom` replaces direct reads of `visibleWindowAtom`
in the renderer. When `frozenRows === 0 && frozenCols === 0` the bottom-right
quadrant equals the current `visibleWindowAtom` result; no branch is needed in
the happy path.

**Projection** — Each non-empty quadrant produces one `VisibleProjectionRequest`
with `kind: 'visible-window'` and the quadrant's `CellRange` as `window`. Four
parallel requests are issued at most; in practice two (when only rows or only
cols are frozen) or one (no freeze). Rationale for separate requests over a
union: the backend can return results independently as each quadrant resolves,
avoiding a single large blocking request when the frozen header is small but the
scrolling body is large. The `reason` field is `'viewport'` on all four.

**Keyboard** — Page-up / page-down skip frozen rows: the scrollable body height
is `viewportHeight - frozenRowPx` and the page step uses this reduced height.
Ctrl+Home scrolls to the first non-frozen cell `(frozenRows, frozenCols)` unless
the intent is to reach the true origin. Both behaviors are pure adjustments
inside the keyboard intent handler; no new atoms required.

**Pointer** — Resize handles on frozen rows/columns use the same
`setViewportRowHeightAtom` / `setViewportColumnWidthAtom` path. The renderer
must translate hit-test coordinates to the correct row/col index accounting for
frozen offsets; that translation lives in the host adapter, not UI core.

**Clipboard** — Selections that span the freeze boundary (e.g., selecting from a
frozen row into the scrolling body) produce a single `CellRange` and use the
existing `range` projection path. No special clipboard handling is needed in UI
core; the range covers frozen and non-frozen cells uniformly.

**Scroll clamping** — `normalizeViewportMetrics` must clamp `scrollTop` to
`max(0, rowCount * rowHeight - frozenRowPx - viewportBodyHeight)` and similarly
for `scrollLeft` once freeze is applied, so the frozen header does not scroll
off-screen. This requires passing freeze counts into `normalizeViewportMetrics`
or computing scroll limits separately in the host adapter.

---

## Risks & open questions

- **Scroll restoration.** On sheet switch the scroll position is reset; frozen
  counts must be loaded before the first viewport projection fires, otherwise a
  frame renders without the correct quadrant split. Load order: `readFreezeConfig`
  → `setFreezeAtom` → `setViewportMetricsAtom` → projection. Define whether the
  host adapter enforces this sequence or whether `frozenWindowsAtom` lazily waits
  for freeze state.

- **Overscan in frozen quadrants.** The top-left and top-right quadrants are
  small and fully visible; applying the standard overscan to them wastes
  projection bandwidth. Consider setting `overscanRows = 0` and `overscanCols = 0`
  for frozen quadrants and applying overscan only to the bottom-right.

- **Freeze + hidden rows/columns.** A hidden row inside the frozen region has
  zero pixel height but still occupies a row index slot. The pixel-to-index math
  in `getCellViewportRect` must account for variable row heights (via
  `ViewportSizeOverrideState`) when computing frozen band pixel size. Confirm
  that `getViewportRowHeight` is called per row in the frozen band, not using
  the default uniform `rowHeight`.

- **Performance of 4 parallel projection requests.** Each scroll event could
  trigger up to 4 `readVisibleProjection` calls. Where the backend is a WASM
  worker, 4 concurrent messages per frame may saturate the message channel.
  Mitigate by coalescing bottom-right + top-right (same column range) and
  bottom-left + top-left (same column range) into two range-union requests, or
  by skipping re-requests for frozen quadrants when scroll position changes only
  on one axis.

- **Freeze count validation.** `frozenRows` must be `< rowCount` and
  `frozenCols` must be `< colCount`; freezing the entire grid is a no-op.
  `setFreezeAtom` should clamp to `[0, max(0, count - 1)]` and discard invalid
  inputs (non-integer, negative, NaN).

- **Sheet deletion.** When a sheet is deleted, its entry in `rowsBySheet` and
  `colsBySheet` must be pruned to avoid unbounded map growth. Wire into the
  `deleteSheet` result path in the host adapter.

---

## Test surface

All tests live in `test/frozen-panes.test.ts`.

- `getFrozenWindows` with `frozenRows=0, frozenCols=0` returns a single
  non-empty bottom-right quadrant equal to `getVisibleWindow(metrics)`.
- `getFrozenWindows` with `frozenRows=2, frozenCols=0` returns empty top-left
  and bottom-left, and top-right rows `[0, 1]`.
- `getFrozenWindows` with `frozenRows=0, frozenCols=3` returns empty top-left
  and top-right, and bottom-left cols `[0, 2]`.
- `getFrozenWindows` with `frozenRows=2, frozenCols=3` returns all four
  non-empty quadrants; verify row/col boundaries on each.
- Frozen row count equal to `rowCount` is clamped so bottom quadrants remain
  valid (rowStart ≤ rowEnd or quadrant is empty).
- `setFreezeAtom` persists per-sheet and does not overwrite sibling sheets.
- `clearFreezeAtom` removes a sheet entry from both maps without touching others.
- `setFreezeAtom` with `frozenRows=0, frozenCols=0` is equivalent to
  `clearFreezeAtom` for that sheet.
- Freeze-at-cell input `{ row: 2, col: 3 }` produces `frozenRows=2, frozenCols=3`.
- `frozenWindowsAtom` reacts when `viewportFreezeAtom` changes (derived
  invalidation test).
