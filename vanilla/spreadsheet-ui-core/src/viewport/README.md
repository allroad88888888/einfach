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

## State Decision Template

- Source atoms: `viewportMetricsAtom`, `viewportSizeOverridesAtom`,
  `spreadsheet.viewport.freezeBacking` (private; per-sheet freeze counts),
  `spreadsheet.viewport.freezeSeededSheets` (private; one-shot hydration ownership),
  `spreadsheet.viewport.freezeDiagnosticBacking` (private; last persistence failure).
- Derived atoms: `visibleWindowAtom`, `viewportFreezeAtom` (read-only projection —
  name and shape unchanged across the canonical flip), `viewportFreezeDiagnosticAtom`.
- Commands: `setViewportMetricsAtom`, `scrollToCellAtom`, `setViewportRowHeightAtom`,
  `setViewportColumnWidthAtom`, `setFreezeConfigAtom` (synchronous local commit +
  history + optional persist), `hydrateViewportFreezeAtom` (one-shot seed),
  `applyViewportFreezeStructuralShiftAtom` (structural remap, no history).
- Scale bound: visible window and sparse dimension metadata only; freeze state is two
  integers per sheet plus a per-sheet ownership set.
- Backend reads: none required; the freeze persistence hook is optional and one-shot.
- Per-cell/per-row/per-col atom risk: no unbounded row/col atoms or dense dimension arrays;
  row/column size overrides are sparse records keyed only by user-adjusted rows/columns per sheet.
- Tests: `test/viewport.test.ts`, `test/frozen-panes.test.ts`.
