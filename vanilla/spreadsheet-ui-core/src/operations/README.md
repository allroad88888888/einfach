# operations

Owns framework-agnostic spreadsheet operation intents.

## State Decision Template

- Source atoms: none in the first wave.
- Derived atoms: none.
- Commands: pure intent factories for cell input, row/column insert/delete, and sheet add/delete/rename/reorder.
- Scale bound: one operation intent at a time; large data movement remains backend/session-owned.
- Backend reads: none directly. Host adapters translate intents to worker/Rust commands.
- Per-cell/per-row/per-col atom risk: none; intents store coordinates/range hints, not expanded cells.
- Tests: `test/operations.test.ts`.
