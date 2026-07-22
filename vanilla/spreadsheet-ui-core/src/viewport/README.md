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

## Hidden rows — engine-owned (cached here); hidden columns — UI-core canonical

Since the hidden-row **sink-down**
(`solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md`, slices E2/E7,
2026-07-22) the two axes have **different owners**, because only rows affect
calculation. See CANONICAL_OWNERSHIP #03.

- **Hidden ROWS are an engine data fact.** They change what `SUBTOTAL(101-111)`
  evaluates, so the engine (`Sheet.hidden_rows`) is their authoritative store and
  `sheetHiddenRowsAtom` is UI core's render-time PROJECTION — written on the backend
  ACK, never canonical. `hideRowsAtom` / `unhideRowsAtom` are
  **optimistic-then-reconciled** (`feedAndReconcileHiddenRows`): the command writes the
  projection synchronously for an instant repaint, feeds the engine a whole-set
  `setEvalHiddenRows` push, then UNCONDITIONALLY overwrites the cache with the engine's
  authoritative set read back through `readSheetHiddenState` — even when the values
  already match, so a bounded optimistic window can never decay into a permanent silent
  divergence. A per-sheet reconcile generation drops a stale out-of-order ACK. Backends
  exposing neither `setEvalHiddenRows` nor `readSheetHiddenState` degrade to a
  fire-and-forget `hideRows` / `unhideRows` delta mirror. Manual-row undo stays a
  UI-core local-replay entry (`VIEWPORT_HIDDEN_REPLAY_KEY`) whose applier re-feeds the
  restored set to the engine.
- **Hidden COLUMNS stay UI-core canonical.** The engine models no hidden columns
  (`SUBTOTAL` filters on `addr.row` only), so `viewportHiddenColsAtom` is their source
  of truth; column commits stay synchronous and mirror into the optional `hideColumns`
  / `unhideColumns` ports fire-and-forget.

The two axes are separate backing atoms precisely because their ownership differs —
merging them would let a future refactor push hidden columns at the engine, which has
nowhere to put them. `viewportHiddenAtom` is a **compat derived** that synthesises the
historic `{ rowsBySheet, colsBySheet }` shape from the two so the read consumers migrate
unchanged; new code must not write it. Structural shifts remap the sets in place via
`remapIndexSetAfterStructuralShift` — a delete drops in-band membership, which is why
structural backend history entries snapshot the manual hidden/freeze side payloads (see
`../history/README.md`). The sizes hydration in `window.ts`
(`hydrateViewportSizeProjectionAtom`) is sizes-only and ignores hidden slices entirely.

## State Decision Template

- Source atoms: `viewportMetricsAtom`, `viewportSizeOverridesAtom`,
  `spreadsheet.viewport.freezeBacking` (private; per-sheet freeze counts),
  `spreadsheet.viewport.freezeSeededSheets` (private; one-shot hydration ownership),
  `spreadsheet.viewport.freezeDiagnosticBacking` (private; last persistence failure),
  `spreadsheet.viewport.hiddenBacking` (private; per-sheet sorted hidden index sets),
  `spreadsheet.viewport.hiddenSeededSheets` / `hiddenDiagnosticBacking` (private),
  `spreadsheet.viewport.filterHiddenBacking` (private; per-sheet sorted FILTER-hidden
  row sets — see "Two hidden-row sets" below).
- Derived atoms: `visibleWindowAtom`, `viewportFreezeAtom`; `sheetHiddenRowsAtom`
  (engine-projection cache for manually hidden ROWS, written on ACK) and
  `viewportHiddenColsAtom` (UI-core canonical hidden COLUMNS) — the per-axis split of
  the old single hidden atom (E7); `viewportHiddenAtom` is now a **compat derived**
  synthesising `{ rowsBySheet, colsBySheet }` from the two so the read consumers migrate
  unchanged; `viewportFilterHiddenAtom` (read-only projection of the filter-hidden
  sets), `effectiveHiddenAtom` (manual ∪ filter, `ViewportHiddenState`-shaped),
  `viewportFreezeDiagnosticAtom`, `viewportHiddenDiagnosticAtom`.
- Commands: `setViewportMetricsAtom`, `scrollToCellAtom`, `setViewportRowHeightAtom`,
  `setViewportColumnWidthAtom`, `setFreezeConfigAtom` (synchronous local commit +
  history + optional persist), `hydrateViewportFreezeAtom` (one-shot seed),
  `applyViewportFreezeStructuralShiftAtom` (structural remap, no history);
  `hideRowsAtom` / `unhideRowsAtom` / `hideColumnsAtom` / `unhideColumnsAtom`,
  `unhideViewportSelectionAtom` (selection∩hidden), `hydrateViewportHiddenAtom`,
  `applyViewportHiddenStructuralShiftAtom` (structural remap, no history);
  `setViewportFilterHiddenRowsAtom` (whole-set replace per sheet, no history —
  the filter rules are the authority) / `clearViewportFilterHiddenRowsAtom`.
- Scale bound: visible window and sparse dimension metadata only; freeze state is two
  integers per sheet plus a per-sheet ownership set; hidden state is bounded by the
  user's actually-hidden indices per sheet (sorted `number[]`, no dense arrays).
- Backend reads: none required; the freeze/hidden persistence hooks are optional and
  the hidden seed is one-shot per sheet.
- Per-cell/per-row/per-col atom risk: no unbounded row/col atoms or dense dimension arrays;
  row/column size overrides are sparse records keyed only by user-adjusted rows/columns per sheet.
- Tests: `test/viewport.test.ts`, `test/frozen-panes.test.ts`,
  `test/hidden-rows-columns.test.ts`, `test/menu-hidden-context.test.ts`,
  `test/effective-hidden.test.ts`.

## Two hidden-row sets

`viewportHiddenAtom` holds MANUAL hide/unhide — a user command, with its own history
entries. `viewportFilterHiddenAtom` holds FILTER-hidden rows — a derived consequence of
the active filter rules, whole-set replaced when those rules change, with no history
entry of its own (its undo is the filter rules' undo).

They are deliberately not merged, because three rules cannot be expressed on one set:

1. `SUBTOTAL(1-11)` excludes filter-hidden rows but INCLUDES manually hidden ones
   (`101-111` excludes both).
2. Copy skips filter-hidden rows but copies manually hidden ones.
3. `Unhide Rows` over a filtered region must not cancel the filter.

`effectiveHiddenAtom` is the union and answers exactly one question: *is this row
painted?* Use it for rendering, window expansion, and `Go To Special → Visible cells
only`. Anything that must tell the two origins apart (SUBTOTAL pushes, copy, and the
`remove-duplicates` / `text-to-columns` dense scans, which must keep splitting and
de-duplicating manually hidden rows for Excel parity) reads the two source atoms.

The population path is live as of #27 slice S5 and was extended by the hidden-row
sink-down: `runFilterSortMutationAtom` writes `SetFilterSortResult.hiddenRowIndices`
into the filter set on a matched ACK. The set is a SNAPSHOT — it is not recomputed
when cells change (Excel's model), and inserts/deletes shift it via
`applyViewportFilterHiddenStructuralShiftAtom` rather than triggering a rescan.
That command is **row-axis only**: a filter set is a set of rows, so a column shift
is a no-op for it, unlike the manual set which carries both axes.

The filter set is a **pure projection with no write path of its own**, so since
sink-down slice E8 its structural **forward** shift is KEPT but its UI-core
local-replay side payload (`VIEWPORT_FILTER_HIDDEN_REPLAY_KEY`) is **deleted**:
structural undo/redo now restores the engine's owned filter (rules + derived hidden
set) from the engine's own snapshot (`snapshotFilters` / `restoreFilters` on the
worker; the full-sheet capture on static), and the provider re-hydrates this cache
from `readSheetHiddenState.filterRows` (`reconcileFilterHiddenFromEngine` in
`solid/excel/src-vnext/provider/history-dispatch.ts`). See
`solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md` §6.3 and
`../../docs/filter-sort.md` for the whole-feature contract.
