# sheet-tabs

Owns sheet tab menu, rename, delete, and tab interaction flow.

## State Decision Template

- Source atoms:
  - `sheetTabsAtom`: context menu, rename, reorder, and last sheet-tab intent.
- Derived atoms: none in the first wave; state transitions are pure intent reducers.
- Commands:
  - `dispatchSheetTabIntentAtom`
  - pure intent creators for context menu, rename, reorder, commit, and cancel.
- Scale bound: tab interaction state only.
- Backend reads: none. Persistent sheet mutation is represented as an operation/backend intent elsewhere.
- Per-cell/per-row/per-col atom risk: none; no sheet content or dependency graph is stored.
- Tests: `test/sheet-tabs.test.ts`.
