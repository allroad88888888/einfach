# sheet-tabs

Owns sheet tab menu, rename, delete, and tab interaction flow.

## State Decision Template

- Source atoms:
  - `sheetTabsAtom`: context menu, rename, reorder, and last sheet-tab intent.
  - `sheetTabsSheetStateAtom`: bounded workbook sheet metadata list for tab UI and keyboard
    navigation.
- Derived atoms:
  - `sheetTabsSheetsAtom`: current metadata list projection.
- Commands:
  - `dispatchSheetTabIntentAtom`
  - `setSheetTabsSheetsAtom`
  - pure intent creators for context menu, rename, reorder, commit, and cancel.
- Helpers:
  - `getAdjacentSheetId`: resolves previous/next sheet id from the displayed sheet metadata list.
- Scale bound: tab interaction state and sheet metadata only; no sheet cell content.
- Backend reads: none. Persistent sheet mutation is represented as an operation/backend intent elsewhere.
- Per-cell/per-row/per-col atom risk: none; no sheet content or dependency graph is stored.
- Tests: `test/sheet-tabs.test.ts`.
