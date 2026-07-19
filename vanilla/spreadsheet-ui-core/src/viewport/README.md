# viewport

Owns scroll/size metrics and derives the visible row/column window.

## Freeze panes — UI-core canonical (flip step 1)

Freeze is a pure viewport fact ({rows, cols} per sheet) and is UI-core canonical per
`solid/excel/docs/online-excel-parity/CANONICAL_OWNERSHIP.md`. The backend
`readFreezeConfig` / `setFreezeConfig` ports are an **optional persistence hook**: a
one-shot hydration seed on first sheet load plus a fire-and-forget write mirror. Port
absence never degrades the feature; persistence failures record a diagnostic and never
roll back local state. Freeze mutations record local-replay history entries (see
`../history/README.md`) and structural shifts from `BackendMutationResult.structuralShift`
remap the frozen band in place without history.

## Hidden rows/columns — UI-core canonical (flip step 2)

Hidden rows/columns are per-sheet sorted index sets and are UI-core canonical per
`solid/excel/docs/online-excel-parity/CANONICAL_OWNERSHIP.md`. The backend `hideRows` /
`unhideRows` / `hideColumns` / `unhideColumns` ports are an **optional persistence
mirror** (fire-and-forget deltas), and the `hiddenRowIndices` / `hiddenColIndices`
slices of `readViewportSizeProjection` degrade to a **one-shot full-sheet hydration
seed** (`hydrateViewportHiddenAtom`; seeded-sheets ownership guards late clobber). Port
absence never degrades the feature. Hide/unhide commands commit synchronously
('committed' | 'unchanged' | 'invalid'), record local-replay history entries, and
structural shifts remap the local sets in place via `remapIndexSetAfterStructuralShift`
— a delete drops in-band membership, which is why structural backend history entries
snapshot hidden/freeze side payloads (see `../history/README.md`). The sizes hydration
in `window.ts` (`hydrateViewportSizeProjectionAtom`) is sizes-only and ignores hidden
slices entirely.

## State Decision Template

- Source atoms: `viewportMetricsAtom`, `viewportSizeOverridesAtom`,
  `spreadsheet.viewport.freezeBacking` (private; per-sheet freeze counts),
  `spreadsheet.viewport.freezeSeededSheets` (private; one-shot hydration ownership),
  `spreadsheet.viewport.freezeDiagnosticBacking` (private; last persistence failure),
  `spreadsheet.viewport.hiddenBacking` (private; per-sheet sorted hidden index sets),
  `spreadsheet.viewport.hiddenSeededSheets` / `hiddenDiagnosticBacking` (private).
- Derived atoms: `visibleWindowAtom`, `viewportFreezeAtom` and `viewportHiddenAtom`
  (read-only projections — names and shapes unchanged across the canonical flips;
  `viewportHiddenAtom` now serves the FULL per-sheet truth, not a windowed mirror),
  `viewportFreezeDiagnosticAtom`, `viewportHiddenDiagnosticAtom`.
- Commands: `setViewportMetricsAtom`, `scrollToCellAtom`, `setViewportRowHeightAtom`,
  `setViewportColumnWidthAtom`, `setFreezeConfigAtom` (synchronous local commit +
  history + optional persist), `hydrateViewportFreezeAtom` (one-shot seed),
  `applyViewportFreezeStructuralShiftAtom` (structural remap, no history);
  `hideRowsAtom` / `unhideRowsAtom` / `hideColumnsAtom` / `unhideColumnsAtom`,
  `unhideViewportSelectionAtom` (selection∩hidden), `hydrateViewportHiddenAtom`,
  `applyViewportHiddenStructuralShiftAtom` (structural remap, no history).
- Scale bound: visible window and sparse dimension metadata only; freeze state is two
  integers per sheet plus a per-sheet ownership set; hidden state is bounded by the
  user's actually-hidden indices per sheet (sorted `number[]`, no dense arrays).
- Backend reads: none required; the freeze/hidden persistence hooks are optional and
  the hidden seed is one-shot per sheet.
- Per-cell/per-row/per-col atom risk: no unbounded row/col atoms or dense dimension arrays;
  row/column size overrides are sparse records keyed only by user-adjusted rows/columns per sheet.
- Tests: `test/viewport.test.ts`, `test/frozen-panes.test.ts`,
  `test/hidden-rows-columns.test.ts`, `test/menu-hidden-context.test.ts`.
