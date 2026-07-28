# clear-cells-endpoint

Planning doc for the `cell.clear` intent and its backend port.

## Goal

Pin the semantics of the three user-facing clear actions so every layer
(keyboard, toolbar, clipboard, backend) agrees on what is erased:

| Trigger              | Erases values | Erases formats |
| -------------------- | ------------- | -------------- |
| Del / Backspace      | yes           | no             |
| Ctrl/Cmd+Del         | yes           | yes            |
| Edit > Clear Values  | yes           | no             |
| Edit > Clear Formats | no            | yes            |
| Edit > Clear All     | yes           | yes            |

"Values" includes raw input, formula text, and computed result. "Formats"
includes `SpreadsheetCellFormat` fields (bold, italic, numberFormat, color,
align, fontSize). A blank cell with a format is still a formatted cell.

## Scope

- Del / Backspace in navigation mode fires `cell.clear` with `target: 'values'`.
- Ctrl/Cmd+Del fires `cell.clear` with `target: 'all'` (values + formats).
- Edit > Clear menu items fire the matching `target` variant.

**Out of scope:**

- Clearing structural concerns (deleting rows or columns).
- Unmerging merged cells on clear.
- Clearing validation rules attached to a range.
- Clearing named ranges or defined names.
- Clearing conditional-format rules.

## State (UI core)

No new source atoms are required. The `cell.clear` intent is a fire-and-forget
command that reads the current selection and calls the backend port. The keyboard
handler emits `ClearCellsIntent`; a toolbar split-button menu emits the same
intent shape.

Optional: a `clearCellsStatusAtom` (bounded, one-slot) to surface in-flight /
error state for the toolbar split-button. `debugLabel` prefix if added:
`spreadsheet.clearCells.status`.

The intent type is already declared in `src/keyboard/types.ts`; extend it with
a `target` discriminant rather than adding a new intent type.

## Types

Extend `ClearCellsIntent` with an explicit target:

```ts
export interface ClearCellsIntent {
  type: 'cell.clear'
  target: 'values' | 'formats' | 'all'
}
```

`target` defaults to `'values'` when emitted by Del / Backspace. The toolbar
Clear All action sets `'all'`; Clear Formats sets `'formats'`.

For the backend request, add a `target` field to `ClearRangeRequest`:

```ts
export interface ClearRangeRequest extends SheetRef {
  kind: 'clear-range'
  range: CellRange
  target?: 'values' | 'formats' | 'all'   // defaults to 'all' when absent
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
```

`ClearRangeRequest` keeps mixed semantics via the `target` field. No split into
`ClearCellValuesRequest` / `ClearCellFormatsRequest`.

## Backend port

**Chosen variant: (a) extend `ClearRangeRequest` with `target`.**

Rationale: the backend method `clearRange` already exists on `SpreadsheetBackend`
and all host adapters implement it. Adding a `target` field with a safe default
(`'all'` when absent preserves the pre-existing implied semantics) is a
backward-compatible, non-breaking change. Two separate methods would split the
backend surface for what is a single workbook mutation that differs only by
scope, and would force every adapter to add a second optional method. One method
with one discriminant is easier to implement, test, and route on the worker side.

## Integration points

- **Keyboard** (`src/keyboard/`): map Del and Backspace to `ClearCellsIntent`
  with `target: 'values'`; map Ctrl/Cmd+Del to `target: 'all'`. Guard: only in
  `navigation` mode and only when selection is non-empty.
- **Toolbar** (`src/toolbar/`): split-button with items Values / Formats / All.
  Each item dispatches `ClearCellsIntent` with the matching `target`.
- **Selection** (`src/selection/`): the command reads the active selection range
  and passes it directly to `clearRange`. Multi-range selections should issue one
  `clearRange` call per range in the selection set.
- **Clipboard** (`src/clipboard/`): cut is implemented as copy followed by a
  deferred clear. That deferred clear should use `target: 'values'` (not `'all'`);
  formats are preserved after a cut so a paste-then-undo cycle does not lose
  cell styling. Document this explicitly in the clipboard command.

## Risks & open questions

- **Formula references**: cells that formula-reference a cleared cell should
  receive an empty string input (`''`), not a `#REF?` error. Confirm the backend
  treats a clear as writing an empty input rather than deleting the cell address.
- **Validation rules**: if a cell has a validation rule, clearing its value
  should not remove the rule. The `target: 'values'` path must not touch
  validation metadata; clarify with the backend implementor.
- **Merged cells**: clearing a merged cell range where the merge anchor is inside
  but the tail is outside the selection is ambiguous. Current scope excludes
  unmerging, but the backend must decide whether to reject the request or clear
  only the anchor value.
- **Undo composition**: Del pressed five times on the same range should ideally
  compact into one undo step. Whether this is handled by the backend or the UI
  history layer is unresolved.
- **`target: 'formats'` and blank values**: after clearing formats only, should
  `DisplayCell.formatKey` be `undefined` or an explicit `'general'` sentinel?
  The projection result contract needs a decision before the backend adapter is
  written.
- **Cut + undo**: if the user cuts, pastes elsewhere, then undoes the paste, the
  source range should reappear with its original values. If the backend undo stack
  is per-mutation, the cut-clear undo must be linked to the paste undo as a unit.

## Test surface

`test/clear-cells.test.ts` should cover:

- Del in navigation mode emits `ClearCellsIntent` with `target: 'values'`.
- Ctrl+Del emits `ClearCellsIntent` with `target: 'all'`.
- Del in editing mode does not emit `ClearCellsIntent`.
- Command dispatches `clearRange` with the current selection range and correct
  `target` value.
- Toolbar Clear Values / Formats / All items each emit the right `target`.
- Cut command calls `clearRange` with `target: 'values'` (not `'all'`).
- `clearRange` with absent `target` keeps existing `'all'` semantics (adapter
  contract regression guard).
