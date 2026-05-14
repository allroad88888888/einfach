# backend

Defines framework-agnostic ports that host adapters implement.

This folder must not import worker, WASM, DOM, Solid, or React code. It only
defines request/response contracts used by commands in the UI core.

Backend ports are range based. A host adapter can read a visible window or an
explicit user range, but the UI core must not ask for a workbook snapshot,
formula cache, dependency graph, or sparse sheet dump.

## State Decision Template

- Source atoms: none.
- Derived atoms: none.
- Commands: port calls only.
- Scale bound: request/response contracts must be window/range based.
- Backend reads: implemented by host adapters.
- Per-cell/per-row/per-col atom risk: not applicable.
- Tests: `test/backend*.test.ts`, `test/projection*.test.ts`.
