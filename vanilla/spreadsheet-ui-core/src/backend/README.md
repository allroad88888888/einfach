# backend

Defines framework-agnostic ports that host adapters implement.

This folder must not import worker, WASM, DOM, Solid, or React code. It only
defines request/response contracts used by commands in the UI core.

Backend ports are range based. A host adapter can read a visible window or an
explicit user range, and can execute compact range commands such as clear,
format, structural row/column edits, and fill handle copy. The UI core must not
ask for a workbook snapshot, formula cache, dependency graph, or sparse sheet
dump.

Data-navigation ports return a single coordinate, not a row/column projection.
For example, `resolveDataEdge` lets a host adapter answer Ctrl+Arrow movement
from sparse facts without materializing a full row or column in the UI layer.

Sheet metadata ports return bounded sheet lists only. `reorderSheet` changes the
displayed sheet metadata order and must not imply any cell snapshot or sheet
content materialization.

Viewport size metadata ports are window based. `readViewportSizeProjection`
returns only sparse row heights and column widths for the visible window; resize
mutations write one row or one column at a time.

## State Decision Template

- Source atoms: none.
- Derived atoms: none.
- Commands: port calls only.
- Scale bound: request/response contracts must be window/range based.
- Backend reads: implemented by host adapters.
- Per-cell/per-row/per-col atom risk: not applicable.
- Tests: `test/backend*.test.ts`, `test/projection*.test.ts`.
