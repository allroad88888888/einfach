# merge-cells

Planning doc for merged-cell support in `@einfach/spreadsheet-ui-core`.

---

## Goal

Merge a rectangular range so the anchor cell visually spans it; selection and
navigation treat the entire merged region as one unit. Unmerge restores
independent cells.

---

## Scope

**In scope:**

- `mergeRange` / `unmergeRange` backend port calls
- Merge anchor display: anchor cell paints with a `rowSpan` / `colSpan`-equivalent
  extent; non-anchor cells inside the region are suppressed in the visible projection
- Selection skip-over: clicking any cell inside a merge selects the full merge
  range; arrow navigation exits on the far boundary of the merge, not the clicked
  cell
- Fill-handle and clear interactions with merged regions (explicit handling, see
  Risks)

**Out of scope:**

- Merged regions that partially overlap hidden rows or columns (separate doc)
- Conditional formatting applied specifically to merge anchors (separate doc)

---

## State (UI core)

The UI core does **not** own the merge registry. Merges are workbook facts
maintained by the backend.

The visible-window projection result already carries `cells: DisplayCell[]`.
The contract is extended so the backend echoes merge metadata for every cell
in the current visible window:

- Anchor cells include `mergedSpan: { rows, cols }` — the renderer uses this
  to paint the cell with the correct span extent.
- Non-anchor cells that are covered by a merge include `mergeAnchor: CellCoord`
  — the UI core uses this to suppress rendering and to snap selection.

No new top-level atom is introduced. The merge echo lives inside the projection
result and is consumed transiently by viewport paint and selection normalisation.
If the host adapter does not populate merge fields the UI core behaves as if no
merges exist (graceful degradation).

**State Decision Template:**

- Source atoms: none (merge facts are not stored in UI core atoms)
- Derived atoms: none; merge metadata is carried in projection result objects
- Commands: `mergeRangeAtom`, `unmergeRangeAtom` (write-only command atoms,
  same pattern as `clearRangeAtom`)
- Scale bound: merge metadata is window-scoped, included only for cells in
  the visible window or the requested range — never a full sheet dump
- Backend reads: optional port methods on `SpreadsheetBackend`
- Per-cell/per-row/per-col atom risk: none; no merge atom families

---

## Types

### Shared / projection extensions

```ts
// extend DisplayCell in backend/types.ts
export interface DisplayCell {
  row: number
  col: number
  displayValue: string
  valueKind?: 'blank' | 'number' | 'string' | 'boolean' | 'error'
  formula?: string
  error?: SpreadsheetError
  formatKey?: string
  format?: SpreadsheetCellFormat
  // merge additions
  mergedSpan?: { rows: number; cols: number }  // anchor cell only
  mergeAnchor?: CellCoord                       // non-anchor covered cell only
}
```

### New request types (backend/types.ts)

```ts
export interface MergeRegion {
  range: CellRange
}

export interface MergeRangeRequest extends SheetRef {
  kind: 'merge-range'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface UnmergeRangeRequest extends SheetRef {
  kind: 'unmerge-range'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
```

`MergeRegion` is a lightweight value type for callers that need to pass merge
descriptors between helpers (e.g. clipboard span preservation).

---

## Backend port

Add two optional methods to `SpreadsheetBackend`:

```ts
mergeRange?(request: MergeRangeRequest): Promise<BackendMutationResult>
unmergeRange?(request: UnmergeRangeRequest): Promise<BackendMutationResult>
```

Both are optional — hosts that do not implement merges simply omit them; the
UI disables the merge toolbar action when neither method is present.

`BackendMutationResult` already carries `revision` and `affectedRange`, so
callers can invalidate the visible projection at the affected window after a
merge or unmerge. The UI core triggers a fresh `readVisibleProjection` with
the new revision after each mutation, identical to the pattern used by
`clearRange` and `setFormatRange`.

Projection results from `readVisibleProjection` and `readRangeProjection` carry
merge metadata only for cells inside the requested window or range. The backend
is responsible for intersecting the merge registry with the window; the UI core
never requests a full list of merges.

---

## Integration points

**Selection** (`src/selection/`)

- Pointer down on a non-anchor cell whose `DisplayCell` carries `mergeAnchor`:
  resolve the selection to the full merge range (`rowStart`/`colStart` of the
  anchor, `rowEnd`/`colEnd` = anchor + span − 1).
- Arrow movement that would land inside a merge snaps to the anchor and exits
  on the far side of the merge in the direction of travel.
- `MoveSelectionInput` does not change shape; snap logic is applied after the
  delta is resolved, using the current visible-projection merge echo.

**Viewport** (`src/viewport/`)

- The renderer receives `mergedSpan` from `DisplayCell`; it paints the anchor
  cell with `height = span.rows * rowHeight` (adjusted for per-row overrides)
  and `width = span.cols * colWidth`.
- Non-anchor cells with `mergeAnchor` set are skipped in the render loop —
  they occupy no DOM node.
- `CellViewportRect` may grow a `span?: { rows: number; cols: number }` field
  so the renderer can compute paint extents without re-reading the projection.

**Clipboard** (`src/clipboard/`)

- Copy of a range that contains a merge: recommended behaviour is to expand the
  anchor value across all covered cells in the TSV output (each covered cell
  emits the anchor's `displayValue`). No custom marker in the TSV body — this
  keeps the TSV compatible with external paste targets.
- Paste into a merged region: the target range is unmerged first (host adapter
  responsibility), then cells are imported normally via `importCells`.
- Cut of a merged range: treat as copy + clear; the clear request covers the
  full merge range.

**Operations** (`src/operations/`)

- Insert row inside a merge: the backend must decide whether to split or extend
  the merge. The UI core fires `insertRows` as normal; merge adjustment is a
  backend concern.
- Delete row inside a merge: same delegation — `deleteRows` request, backend
  resolves merge side-effects and returns a new revision.

**Formula bar** (`src/formula-bar/`)

- The active cell address displayed in the formula bar always shows the merge
  anchor coordinate (e.g. `A1`) regardless of which covered cell was clicked.
  The formula bar reads from `activeCell` which is already snapped to the anchor
  by the selection integration above.

---

## Risks & open questions

- **Partial-overlap operations**: a `mergeRange` request whose rectangle
  overlaps an existing merge is ambiguous — should the host auto-extend,
  auto-split, or reject? The port does not prescribe this; host adapters should
  document their behaviour and surface an error via `BackendMutationResult`.
- **Paste into a merged region**: if the paste target overlaps a merge the host
  must unmerge first. The UI core cannot enforce ordering across two separate
  port calls atomically; a failed `importCells` after a successful `unmergeRange`
  leaves the sheet in an inconsistent state. A combined `pasteIntoMerge`
  operation may be needed.
- **Undo behaviour**: undo of a merge or unmerge requires the host to decrement
  its revision counter and re-emit projection results. The UI core has no undo
  stack; this is entirely a host concern, but the revision echo in
  `BackendMutationResult` must be reliable.
- **Fill-handle into or across merges**: `fillRange` source or target may
  overlap a merge. The UI core does not pre-validate; host adapters should
  return an error or clamp the fill, and the UI core should surface it via the
  diagnostics atom.
- **Performance of merge lookup for visible window**: if a sheet has thousands
  of merges the backend must index them spatially to intersect with the visible
  window in O(log n) or better. The UI core imposes no constraint, but the
  projection contract assumes the result arrives within the same latency budget
  as a normal visible-window projection.
- **Merged cells spanning a scroll boundary**: when the anchor is above or to
  the left of the visible window the non-anchor cells are visible but the anchor
  is not. The backend must still emit `mergeAnchor` on those covered cells so
  the renderer can suppress them correctly; the anchor `mergedSpan` may be
  omitted since the anchor itself is outside the window.

---

## Test surface

`test/merge-cells.test.ts`

Covers:

- `MergeRangeRequest` / `UnmergeRangeRequest` round-trip shape assertions
- `DisplayCell` with `mergedSpan` and with `mergeAnchor` — type narrowing helpers
- Selection snap: clicking a covered cell normalises to the full merge range
- Arrow navigation exits the merge on the far side
- Clipboard copy expands anchor value across TSV rows/cols
- Graceful degradation: backend omits merge fields → UI behaves as if no merges
- Projection result with a merge anchor outside the visible window: covered
  cells carry `mergeAnchor`, anchor cell is absent, renderer skips covered cells
