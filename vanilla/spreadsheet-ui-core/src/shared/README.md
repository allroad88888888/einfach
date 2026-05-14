# shared

Shared framework-agnostic types and helpers.

This folder may contain coordinate and range helpers, but not product state.

## State Decision Template

- Source atoms: none.
- Derived atoms: none.
- Commands: none.
- Scale bound: helpers must operate on boundaries, not materialized full ranges.
- Backend reads: none.
- Per-cell/per-row/per-col atom risk:
- Tests:
