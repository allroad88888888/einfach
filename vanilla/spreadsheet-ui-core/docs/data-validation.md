# data-validation

Per-range data validation feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Define per-range validation rules (list dropdown, numeric range, regex, formula)
and surface them during edit. The UI core owns the rule editor modal atom and
in-edit diagnostic state. Rule storage and evaluation live in the backend.

---

## Scope

- Rule CRUD commands: set and clear validation rules on a range.
- In-edit validation diagnostic: evaluate the draft against the active cell's
  rule and report `ValidationOutcome` before commit.
- Warn vs reject modes: `warn` surfaces a diagnostic but allows commit; `reject`
  blocks commit and cancels the editor.
- Dropdown UI for list rules: keyboard-accessible picker from projection values.

**Out of scope**

- Conditional formatting linkage (separate doc).
- Cross-sheet list sources (e.g. `=Sheet2!A1:A10` as dropdown origin).
- Formula-driven rule evaluation in the UI core (backend eval pass required).

---

## State (UI core)

Editor session gains `validationStatus` derived from the current draft.
A toolbar or menu entry opens the rule editor modal.

**`validationRuleEditorAtom`** — `atom<ValidationRuleEditorState>`  
Controls the rule editor modal: open state, target range, draft rule, saving flag.

```ts
validationRuleEditorAtom.debugLabel = 'spreadsheet.validation.ruleEditor'
```

**`validationStatusAtom`** — `atom<ValidationOutcome | null>` (derived)  
Re-evaluates draft against `activeValidationRuleAtom` on each keystroke for
`list` and `range` rules. For `formula` rules carries the outcome from the
projection result.

```ts
validationStatusAtom.debugLabel = 'spreadsheet.validation.status'
```

**`validationDropdownAtom`** — `atom<ValidationDropdownState>`  
Tracks open state, list values, and anchor cell for the floating picker.

```ts
validationDropdownAtom.debugLabel = 'spreadsheet.validation.dropdown'
```

No per-cell atoms. Rule data arrives through `DisplayCell.validation` in the
existing visible-window projection.

---

## Types

```ts
export type ValidationRuleMode = 'warn' | 'reject'

export type ValidationRule =
  | { kind: 'list'; values: string[]; mode: ValidationRuleMode }
  | { kind: 'range'; min?: number; max?: number; mode: ValidationRuleMode }
  | { kind: 'regex'; pattern: string; mode: ValidationRuleMode }
  | { kind: 'formula'; expression: string; mode: ValidationRuleMode }

export interface ValidationOutcome {
  code: 'valid' | 'invalid' | 'warning'
  message?: string
}

export interface SetValidationRuleRequest extends SheetRef {
  kind: 'set-validation-rule'
  range: CellRange
  rule: ValidationRule
  requestId?: number
  revision?: number | string
}

export interface ClearValidationRuleRequest extends SheetRef {
  kind: 'clear-validation-rule'
  range: CellRange
  requestId?: number
  revision?: number | string
}
```

Extend `DisplayCell` with an optional field (in `backend/types.ts`):

```ts
validation?: ValidationOutcome
```

---

## Backend port

Two optional methods added to `SpreadsheetBackend`:

```ts
setValidationRule?(request: SetValidationRuleRequest): Promise<BackendMutationResult>
clearValidationRule?(request: ClearValidationRuleRequest): Promise<BackendMutationResult>
```

When absent the UI core hides the validation menu entry.

Projection results carry validation outcomes per visible cell. The backend
evaluates each visible cell's value against any attached rule and populates
`DisplayCell.validation`. For `list` rules the backend also inlines the allowed
values so the UI can populate the dropdown without an extra round-trip.

---

## Integration points

- **Editing** — `commitEditingAtom` reads `validationStatusAtom` before
  forwarding: `valid` → proceed; `warn` mode → emit diagnostic, proceed;
  `reject` mode + `invalid` → call `cancelEditingAtom`, set diagnostic.
- **Formula-bar** — mirrors `validationStatusAtom.message` as a transient
  diagnostic when `code === 'warning' || code === 'invalid'`.
- **Keyboard** — `Alt+Down` on a list-rule cell calls `openValidationDropdown`.
  Escape closes without selecting; Enter / click fills the draft and commits.
- **Clipboard** — paste submits without pre-validation. Refreshed projection
  surfaces outcomes for visible cells. Auto-rejecting pasted values is out of
  scope.
- **Menu** — right-click → "Data validation…" calls `openValidationRuleEditor`
  with the current selection. Entry hidden when `setValidationRule` is absent.

---

## Risks & open questions

- **Formula rules require a backend eval pass.** The UI core cannot evaluate
  expressions like `=ISNUMBER(A1)`. Backends may need to cache rule eval results
  keyed by cell value + expression to keep projection latency acceptable.
- **Perf of per-cell validation on large pastes.** Define whether
  `BackendMutationResult` should carry a failure count for a summary diagnostic
  without waiting for the next projection refresh.
- **Rule conflicts on overlapping ranges.** Define a priority order (last-set
  wins or most-specific range wins) as a backend contract; the UI core only
  consumes one `ValidationOutcome` per cell.
- **Undo on rule change.** `setValidationRule` / `clearValidationRule` should
  push a `HistoryEntry` (kind `validation.set` / `validation.clear`) after a
  successful `BackendMutationResult` so the change is undoable.
- **Dropdown anchor.** `ValidationDropdownState` stores anchor row/col only;
  pixel layout is resolved by the framework adapter from viewport size atoms.

---

## Test surface

All tests live in `test/data-validation.test.ts`.

- `validationRuleEditorAtom` opens with correct range and closes after save.
- `saveValidationRuleAtom` calls `setValidationRule`; null calls `clearValidationRule`.
- `saveValidationRuleAtom` is a no-op when backend does not expose the method.
- `validationStatusAtom` is `null` when no rule is attached to the active cell.
- `validationStatusAtom` returns `valid` when draft matches a list value.
- `validationStatusAtom` returns `invalid` when draft is outside a numeric range.
- `validationStatusAtom` returns `warning` for a `warn`-mode mismatch.
- `commitEditingAtom` proceeds when status is `valid` or no rule present.
- `commitEditingAtom` emits diagnostic and proceeds when mode is `warn`.
- `commitEditingAtom` cancels and sets diagnostic when mode is `reject` and invalid.
- `openValidationDropdownAtom` is a no-op when active rule is not `list`.
- Dropdown closes without committing on Escape intent.
- Selecting a dropdown value fills the draft and triggers commit.
