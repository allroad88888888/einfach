# viewport

Owns scroll/size metrics and derives the visible row/column window.

## State Decision Template

- Source atoms: `viewportMetricsAtom`.
- Derived atoms: `visibleWindowAtom`.
- Commands: `setViewportMetricsAtom`, `scrollToCellAtom`.
- Scale bound: visible window and sparse dimension metadata only.
- Backend reads: none directly; projection consumes the derived window.
- Per-cell/per-row/per-col atom risk: no unbounded row/col atoms or dense dimension arrays.
- Tests: `test/viewport.test.ts`.
