# viewport

Owns scroll/size metrics and derives the visible row/column window.

## State Decision Template

- Source atoms: `viewportMetricsAtom`, `viewportSizeOverridesAtom`.
- Derived atoms: `visibleWindowAtom`.
- Commands: `setViewportMetricsAtom`, `scrollToCellAtom`, `setViewportRowHeightAtom`,
  `setViewportColumnWidthAtom`.
- Scale bound: visible window and sparse dimension metadata only.
- Backend reads: none directly; projection consumes the derived window.
- Per-cell/per-row/per-col atom risk: no unbounded row/col atoms or dense dimension arrays;
  row/column size overrides are sparse records keyed only by user-adjusted rows/columns per sheet.
- Tests: `test/viewport.test.ts`.
