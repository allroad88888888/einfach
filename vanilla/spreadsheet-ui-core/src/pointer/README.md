# pointer

Owns drag selection, fill handle, row/column resize, and autoscroll in-progress state.

## State Decision Template

- Source atoms:
  - `pointerSessionAtom`: one active pointer session with only the current interaction, anchor/focus
    boundaries, resize preview, and autoscroll hint.
  - `pointerIntentAtom`: last commit intent for the host adapter to consume.
- Derived atoms:
  - `pointerIsActiveAtom`: session activity flag for toolbars, overlays, and host gates.
- Commands:
  - `startPointerAtom`
  - `updatePointerAtom`
  - `commitPointerAtom`
  - `cancelPointerAtom`
- Scale bound: one active pointer interaction.
- Backend reads: none directly. The adapter can read workbook facts when it starts a pointer session,
  but this core never reads backend data itself.
- Per-cell/per-row/per-col atom risk: forbidden. The session stores only one range boundary, one
  resize target, and one autoscroll hint. It never expands a range into cell addresses or keeps full
  row/column size arrays.
- Tests:
  - drag selection boundaries and autoscroll state
  - fill handle preview/write-range/source-coordinate helpers without range expansion
  - row/column resize commit intents
  - cancel/commit convergence back to idle
