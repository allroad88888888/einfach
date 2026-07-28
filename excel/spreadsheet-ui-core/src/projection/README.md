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
  - `activeCellFormatAtom`: active cell's cell-level format, read off the
    current visible-window result (joins `selectionSnapshotAtom` from
    `../selection` against `projectionSnapshotAtom`); `{}` when the
    projection isn't showing the selected sheet or the cell has no format
    overrides. Every "open Format Cells for the active selection" entry
    point must seed its dialog draft from this atom — an unseeded draft
    defaults to `'general'` and a no-op save wipes the real format.
- Commands: create/validate projection requests and call backend ports.
- Scale bound: current window plus a small bounded cache only if justified.
- Backend reads: visible-window display projection only.
- Per-cell/per-row/per-col atom risk: no offscreen cell cache or workbook snapshot.
- Tests: `test/projection*.test.ts`.
