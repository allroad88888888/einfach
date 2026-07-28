# keyboard

Owns framework-agnostic keyboard navigation/edit/reference-picking command state.

## State Decision Template

- Source atoms:
  - `keyboardModeAtom`: `navigation`, `editing`, or `formula-reference`.
  - `lastKeyboardIntentAtom`: last framework-agnostic command intent for adapter consumption.
- Derived atoms:
  - none in the initial core. Keyboard derives from `selectionAtom` and `selectionBoundsAtom` at
    dispatch time instead of storing duplicate selection state.
- Commands:
  - `dispatchKeyboardInputAtom`: converts normalized key input into movement/edit/clipboard/history
    intents and applies selection movement when the intent is selection-owned.
  - `clearKeyboardIntentAtom`: clears the consumed intent.
- Scale bound: stores current mode and one compact intent only. Movement stores target boundaries,
  never a list of cells. `PageUp/PageDown` uses adapter-provided visible row delta;
  `Alt+PageUp/PageDown` uses adapter-provided visible column delta for horizontal paging.
  `Ctrl/Meta+PageUp/PageDown` emits adjacent sheet activation intent, leaving sheet list lookup to
  the sheet-tab/workspace layer.
- Backend reads: none. Ctrl+arrow data-edge scanning is intentionally not implemented here because it
  needs backend facts; this layer can only express UI intents.
- DOM reads: none. Adapters normalize DOM events into `KeyboardInput`.
- Per-cell/per-row/per-col atom risk: forbidden.
- Tests:
  - arrow/tab/enter/home/page movement intent
  - horizontal `Alt+PageUp/PageDown` movement from `pageColDelta`
  - shift movement extends selection by boundary
  - editing mode returns commit/cancel intents without moving selection
  - command shortcuts return clipboard/history/select-all/sheet-navigation intents
