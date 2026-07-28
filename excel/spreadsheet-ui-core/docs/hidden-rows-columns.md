# hidden-rows-columns

Hide and unhide arbitrary rows or columns per sheet, with navigation, selection,
fill, and clipboard all respecting the hidden set.

## Goal

Let users hide rows and columns. Navigation (arrow, Tab, Enter), selection
extension, and fill skip hidden indices visually. Insert/delete operations
preserve stable absolute indices — hiding does not renumber. Backend owns the
canonical hidden set; UI core caches the per-window projection.

## Scope

- Hide and unhide arbitrary contiguous or sparse row and column index sets,
  per sheet.
- Row header and column header display collapses hidden indices (no gap; double
  border marker between adjacent visible indices straddling a hidden range).
- Context-menu items: **Hide rows**, **Hide columns**, **Unhide rows**,
  **Unhide columns** (pointer integration).
- Keyboard navigation skips hidden rows/cols.
- Selection across a hidden range includes the hidden indices in the logical
  selection but the display renders them compressed.
- Fill-handle drag skips hidden rows/cols as fill targets.
- Clipboard copy includes hidden cells (Excel-compatible); paste always writes
  to visible indices only.

**Out of scope**

- Outline/group bars (collapse/expand hierarchy UI) — deferred.
- Conditional hide (hide row if formula evaluates to true) — deferred.
- Per-cell hide (not a spreadsheet primitive).
- Animated collapse transitions.

## State (UI core)

Backend owns the canonical hidden set. UI core caches it via projection results
and does not track workbook facts independently.

```ts
// src/viewport/hidden.ts

export const DEFAULT_VIEWPORT_HIDDEN: ViewportHiddenState = {
  rowsBySheet: {},
  colsBySheet: {},
}

export const viewportHiddenAtom = atom<ViewportHiddenState>(DEFAULT_VIEWPORT_HIDDEN)
viewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hidden'
```

Scale bound: number of hidden index ranges per sheet, not number of cells.
The atom stores sorted sparse index arrays; lookup during window derivation is
O(k) where k is the number of hidden indices in the visible window — negligible
for realistic hide counts.

State is refreshed whenever `readViewportSizeProjection` returns hidden indices.
It is not persisted independently; it is a cached projection from the backend.

## Types

```ts
// src/viewport/types.ts additions

export interface ViewportHiddenState {
  rowsBySheet: Record<string, number[]>   // sorted sparse index arrays
  colsBySheet: Record<string, number[]>
}
```

```ts
// src/backend/types.ts additions

export interface HideRowsRequest extends SheetRef {
  kind: 'hide-rows'
  rowIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface UnhideRowsRequest extends SheetRef {
  kind: 'unhide-rows'
  rowIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface HideColumnsRequest extends SheetRef {
  kind: 'hide-columns'
  colIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface UnhideColumnsRequest extends SheetRef {
  kind: 'unhide-columns'
  colIndices: number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
```

`ViewportSizeProjectionResult` gains two optional fields:

```ts
export interface ViewportSizeProjectionResult extends SheetRef {
  // ... existing fields ...
  hiddenRowIndices?: number[]   // sorted; only indices within the window
  hiddenColIndices?: number[]
}
```

## Backend port

Four optional methods added to `SpreadsheetBackend`:

```ts
hideRows?(request: HideRowsRequest): Promise<BackendMutationResult>
unhideRows?(request: UnhideRowsRequest): Promise<BackendMutationResult>
hideColumns?(request: HideColumnsRequest): Promise<BackendMutationResult>
unhideColumns?(request: UnhideColumnsRequest): Promise<BackendMutationResult>
```

`readViewportSizeProjection` already returns per-window row/col metadata; it
returns `hiddenRowIndices` and `hiddenColIndices` restricted to the requested
window. UI core merges the result into `viewportHiddenAtom` by sheet.

Backends that do not implement the hide methods leave them undefined; UI core
disables the corresponding menu items.

## Integration points

**Viewport / `getVisibleWindow`**

The existing `getVisibleWindow` computes a contiguous `CellRange`. With hidden
rows/cols, the visible range must expand to cover hidden indices so the backend
projection window includes them, but the renderer skips rendering hidden rows.
`getVisibleWindow` receives the hidden set (from `viewportHiddenAtom`) and
inflates `rowEnd`/`colEnd` to account for holes — visible cell count stays the
same but index span widens.

**Keyboard navigation**

Arrow key and Tab/Enter movement already resolves the next coord. The resolver
gains a `skipHidden(coord, direction, hiddenState)` step that advances past any
hidden index in the movement direction. Shift-arrow selection extension similarly
skips hidden boundary indices when computing the range edge.

**Selection**

Logical selection includes hidden indices (range is contiguous by index). The
display layer compresses them — renders no row/col segment for hidden indices.
`SelectionRange` type is unchanged; compression is a render concern only.

**Clipboard**

Copy includes hidden cells in the TSV export (Excel-compatible default). Paste
writes to visible indices only — the paste target range maps to visible rows/cols
sequentially, skipping hidden indices. A caveat note should surface in the UI
("Hidden rows/columns are included in copied data").

**Operations (insert/delete near hidden range)**

Insert before or after a hidden row/col is permitted. The hidden set is a set of
absolute indices; after insert, the backend shifts all indices at or above the
insertion point. UI core invalidates `viewportHiddenAtom` for the affected sheet
after any structural mutation result arrives.

**Pointer / context menu**

Right-click on a row header with row(s) selected appends **Hide rows** /
**Unhide rows** items (enabled only when backend implements the methods). Same
pattern for column headers. Menu items dispatch `hideRows` / `unhideRows`
operation intents, following the existing `SpreadsheetOperationKind` extension
pattern.

## Risks & open questions

- **Hidden + frozen interaction**: a frozen row that is also hidden is ambiguous
  — does it still occupy frozen space? Decision needed: hidden takes precedence
  (frozen row collapses to zero height).
- **Performance of hidden set lookup during `getVisibleWindow`**: inflating the
  window by iterating sorted hidden arrays is O(k). Pathological case: 10 000
  individually hidden rows. Consider run-length encoding in the projection result
  if k exceeds a threshold (e.g. 1 000).
- **Unhide when both neighbours are hidden**: selecting the double-border marker
  between two visible rows is straightforward, but when an entire leading block is
  hidden (rows 0–N all hidden), there is no visible header to right-click.
  Unhide via toolbar or Format menu may be needed as escape hatch.
- **Hidden cells in formula references**: UI core does not own formula
  evaluation. Backend must include hidden cells in formula range results
  unchanged — hiding is a display attribute only.
- **Scroll offset accounting**: `scrollTop` is measured in pixels. Hidden rows
  have zero rendered height, so the pixel-to-index mapping in `getVisibleWindow`
  must skip them. The mapping becomes non-linear; a helper
  `pixelOffsetToRowIndex(scrollTop, rowHeights, hiddenRows)` is needed.
- **Operation kind union growth**: adding `row.hide`, `row.unhide`, `column.hide`,
  `column.unhide` to `SpreadsheetOperationKind` is a breaking change for
  exhaustive switches in consumer code. Version bump required.

## Test surface

`test/hidden-rows-cols.test.ts`

Scenarios to cover:

- `viewportHiddenAtom` merges projection results per sheet without duplicating
  indices.
- `getVisibleWindow` with a hidden set inflates the window span correctly and
  produces the right visible count.
- Keyboard navigation skips a single hidden row; skips a contiguous block; wraps
  at sheet boundary when last visible row precedes hidden trailing rows.
- Selection across a hidden range has the correct logical `rowStart`/`rowEnd`.
- `HideRowsRequest` / `UnhideRowsRequest` factory helpers (mirrors
  `createInsertRowsOperation` pattern) normalise and validate indices.
- Backend capability guard: menu items absent when `hideRows` is undefined on
  backend.
- Clipboard TSV export includes hidden row data; paste skips hidden target rows.
