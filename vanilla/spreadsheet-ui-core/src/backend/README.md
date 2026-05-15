# backend

Defines framework-agnostic ports that host adapters implement.

This folder must not import worker, WASM, DOM, Solid, or React code. It only
defines request/response contracts used by commands in the UI core.

Backend ports are range based. A host adapter can read a visible window or an
explicit user range, and can execute compact range commands such as clear,
format, structural row/column edits, and fill handle copy. The UI core must not
ask for a workbook snapshot, formula cache, dependency graph, or sparse sheet
dump.

Clipboard-style TSV export is also range based. `exportRangeTsv` returns a TSV
body plus origin metadata for the requested range; the body must not include any
clipboard marker line. Host adapters may implement this with worker-side row
chunks or sparse snapshot chunks, but the UI core still sees only the bounded
range command result.

Clipboard paste uses `importCells` when a host adapter supports bulk import.
The UI core still owns only the parsed target coordinates and text/formula
inputs; worker-backed hosts should map those cells into chunked workbook import
sessions instead of issuing one mutation RPC per cell.

Data-navigation ports return a single coordinate, not a row/column projection.
For example, `resolveDataEdge` lets a host adapter answer Ctrl+Arrow movement
from sparse facts without materializing a full row or column in the UI layer.

Sheet metadata ports return bounded sheet lists only. `reorderSheet` changes the
displayed sheet metadata order and must not imply any cell snapshot or sheet
content materialization.

Viewport size metadata ports are window based. `readViewportSizeProjection`
returns only sparse row heights and column widths for the visible window; resize
mutations write one row or one column at a time. UI-level autofit must measure
only the current visible DOM or an explicit finite range, then persist through
the same one-row/one-column resize mutations.

## State Decision Template

- Source atoms: none.
- Derived atoms: none.
- Commands: port calls only.
- Scale bound: request/response contracts must be window/range based.
- Backend reads: implemented by host adapters.
- Per-cell/per-row/per-col atom risk: not applicable.
- Tests: `test/backend*.test.ts`, `test/projection*.test.ts`.
