# menu

Owns menu open/close state, compact targets, highlight, and command intent.

## State Decision Template

- Source atoms: `menuStateAtom`, `menuIntentAtom`
- Derived atoms: `menuOpenAtom`, `menuTargetAtom`, `menuPositionAtom`, `menuHighlightAtom`, `menuCommandIntentAtom`
- Commands: `openMenuAtom`, `updateMenuHighlightAtom`, `dispatchMenuCommandAtom`, `closeMenuAtom`, `clearMenuIntentAtom`
- Scale bound: one open menu and one last emitted intent
- Backend reads: none in the core module; execution stays in the adapter/backend layer
- Per-cell/per-row/per-col atom risk: low, because targets stay compact and never expand to per-cell state
- Tests: open, highlight, command dispatch, close, and invalid-target rejection

## Contract Notes

- `menuStateAtom` stores only the current menu descriptor, not workbook facts.
- `menuIntentAtom` stores the last emitted menu intent for adapter consumption.
- `MenuTarget` remains compact: cell/range/row/column/all/sheet-tab are represented by sheet-local references and bounded ranges only.
- `MenuCommandIntent` is intentionally declarative. Copy, cut, paste, clear, row/column insert/delete, and formatting-open commands are handed off to the higher-level adapter or operations layer.
- The menu core must not create per-cell atoms or cache full workbook facts.
