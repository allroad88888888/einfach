# workspace

Owns the UI view lifecycle around the active workbook/sheet.

## State Decision Template

- Source atoms:
  - `workspaceSessionAtom`: active sheet id and UI/projection revision counters.
- Derived atoms: none in the first wave; stale checks are pure helpers.
- Commands:
  - `setWorkspaceActiveSheetAtom`
  - `advanceWorkspaceViewportAtom`
  - `requestWorkspaceProjectionAtom`
  - `commitWorkspaceProjectionAtom`
  - `resetWorkspaceSessionAtom`
- Scale bound: one workbook/view session; no sheet data or snapshot state.
- Backend reads: none directly. Projection/backend modules consume revisions and visible windows.
- Per-cell/per-row/per-col atom risk: none; this module stores only session metadata.
- Tests: `test/workspace.test.ts`.
