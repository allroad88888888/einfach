# presence

Remote collaborator cursors and edit attribution for `@einfach/spreadsheet-ui-core`.

## State Decision Template

- Source atoms: `presenceStateAtom`, `lastRemoteEditEventAtom`.
- Derived atoms: `remoteCursorsAtom`.
- Commands: `applyPresenceUpdateAtom`, `applyRemoteEditEventAtom`, `clearPresenceAtom`.
- Scale bound: capped at `MAX_PARTICIPANTS` (32); no per-cell atoms.
- Backend reads: `subscribePresence` / `publishLocalPresence` (both optional).
- Per-cell/per-row/per-col atom risk: none; cursor stored as SelectionState, not expanded to cell grid.
- Tests: `test/presence.test.ts`.
