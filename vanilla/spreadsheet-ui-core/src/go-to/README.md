# go-to

Atom layer behind the **Go To** / **Go To Special** dialog (Wave 7.4).

## Atom classification

| Atom | Class | Notes |
|---|---|---|
| `goToOpenAtom` | source | open boolean for the dialog |
| `goToModeAtom` | source | `'simple' \| 'special'` tab toggle |
| `goToInputAtom` | source | text input for the simple Go To field |
| `goToLocatorAtom` | source | active radio in the special pane |
| `goToHistoryAtom` | source | recent-jumps list, bounded at `GO_TO_HISTORY_MAX = 10` |
| `goToErrorAtom` | source | inline error code (or `null`) for the dialog |
| `openGoToAtom` / `closeGoToAtom` | command | open/close, reset error |
| `setGoToModeAtom` / `setGoToInputAtom` / `setGoToLocatorAtom` | command | controlled-input setters |
| `pushGoToHistoryAtom` | command | dedup + trim at 10 |
| `applyGoToTargetAtom` | command | route parsed target through `setSelectionAtom` |
| `applyGoToSpecialResultAtom` | command | route locator scan through `setMultiRegionSelectionAtom` |
| `confirmGoToAtom` | command | top-level commit, branches on result kind |

All atoms set `debugLabel = 'spreadsheet.goTo.<name>'`. No per-cell families.

## Bounded caches

- `goToHistoryAtom` — 10 entries.
- `runGoToSpecialScan` —
  - Search rect is capped at `GO_TO_SCAN_MAX_CELLS = 100_000` cells by the
    host before invocation. The truncation banner surfaces the cap with a
    "narrow your range" hint when it fires.
  - After predicate evaluation, matched coords are coalesced horizontally
    into rectangles (per row). The output region count is then capped at
    `GO_TO_REGION_CAP = 500`; if more regions remain we truncate and set
    `result.truncated = true`. The cap protects the grid renderer, which
    pays O(regions × viewport-cells) per paint.
  - `totalMatchCount` is reported separately so the dialog can show
    "matched N, showing first M" wording without re-scanning.

## Sparse-projection contract for blanks / visible-cells-only

The host backend's `readRangeProjection` returns a **sparse** projection —
blank cells are NOT included. The blanks locator therefore CANNOT walk
`context.cells`; instead it walks `context.searchRect` and emits every
coord that is NOT in the projection's occupied set.

The visible-cells-only locator likewise walks `context.searchRect` and
emits every coord whose row is not in `context.hiddenRows` and whose col
is not in `context.hiddenCols`. Blank visible cells are included — Excel's
"visible cells only" returns the rect minus hidden rows/columns, not "the
non-blank visible cells".

The host MUST supply `searchRect` when invoking either locator. When the
rect is absent the engine returns an empty result.

## Selection-scoped locators (row/column differences)

Row differences and column differences scope to the **current selection
rect** (`context.selectionRect`), not the used range. Each cell in the
rect is compared against the active-column anchor (row differences) or
active-row anchor (column differences); differing cells match. Blank vs
blank counts as equal.

When `selectionRect` is omitted the engine falls back to `searchRect` so
callers without selection context still get a defined result.

## Used-range scan strategy (host-side)

The host adapter reads the workbook's "used range" by calling
`backend.readRangeProjection`. For now we derive the range from
`viewportMetricsAtom.rowCount × colCount` — i.e. the full addressable space
the metrics expose — then call `clipRectToCellBudget` to bring the cell
count under `GO_TO_SCAN_MAX_CELLS` (100 000). The clipped rect preserves
the full column span and trims rows; the dialog surfaces a
"scan truncated" banner when clipping fires. A future `usedRangeAtom` /
port on `SpreadsheetBackend` can replace that approximation without
rewriting the locator engine.

For 1M-row workbooks this approach is slow: the host should chunk the read,
or expose a dedicated `readUsedRange` port. Until then we cap the scan and
flag truncation.

## Pure submodules

`reference-parser.ts` and `locator-engine.ts` are pure — no atom access, no
backend reads. They run inside `confirmGoToAtom`'s consumer (the Solid
adapter) which gathers `selectionSnapshotAtom`, the named-ranges registry,
the sheet metadata, and the projection cells, then invokes the pure
functions with that snapshot.

## Capability gating

- Plain Go To always works — only `setSelectionAtom` is required.
- Go To Special is always available because `readRangeProjection` is a
  required backend method.
- `precedents` / `dependents` radios are surfaced for layout completeness
  but inert in the engine; the dialog disables them with a tooltip that
  points at the future Wave 9 dependency-graph port.

## Why `setMultiRegionSelectionAtom`?

Looping over `addSelectionRegionAtom` would emit N atom-change
notifications and force N rendering passes when a Go To Special scan
returns hundreds of matches. The Tier 0.2 batched setter writes the entire
region list in one go.

## R1C1 reference parsing

Both absolute and relative R1C1 references are supported:

- `R3C5`           — absolute (1-based). Anchor-independent.
- `R[2]C[-1]`      — relative offset from `context.activeCell`.
- `RC`             — same row, same column (zero offset).
- `R[3]C`          — relative row, same column.
- `RC[2]`          — same row, relative column.
- Ranges combine the two sides: `R[-1]C:R[1]C[2]`, `R1C1:R3C2`.

Relative refs resolve against `context.activeCell` (defaults to `A1` when
the host omits it). Negative resolved coordinates fail with
`invalid-address`.

## Non-goals (deferred)

- Vertical coalescing of contiguous regions (currently coalesce is
  row-at-a-time horizontal only — a column-wide blank selection emits one
  region per row). Acceptable because the renderer treats single-row
  ranges as cheaply as single-cell selections.
- Cross-sheet navigation that switches the active sheet — currently the
  parser resolves sheet-qualified addresses to a sheet id, but the dialog
  consumer is responsible for setting `workspaceSessionAtom.activeSheetId`
  when the resolved sheet differs from the current one.
