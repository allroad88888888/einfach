# projection

Owns bounded display projection contracts for the current visible window or an
explicit user range.

Projection data is display data only. It may include display text, lightweight
format keys, formula source for visible cells, and cell-level errors. It must
not become a workbook fact store, formula cache, dependency graph, or sparse
snapshot.

## State Decision Template

- Source atoms: decided by the projection agent; expected to be one bounded
  current-window request/result atom or equivalent.
- Derived atoms: visible cell lookup and request freshness only.
- Commands: create/validate projection requests and call backend ports.
- Scale bound: current window plus a small bounded cache only if justified.
- Backend reads: visible-window display projection only.
- Per-cell/per-row/per-col atom risk: no offscreen cell cache or workbook snapshot.
- Tests: `test/projection*.test.ts`.
