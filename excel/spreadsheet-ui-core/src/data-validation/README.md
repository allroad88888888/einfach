# data-validation

Per-range data validation rules and in-edit diagnostic state.

## State Decision Template

- Source atoms:
  - `validationRuleEditorAtom`: rule editor modal state (open/closed, target range, draft rule, mode).
- Derived atoms:
  - `validationStatusAtom`: evaluates draft against the active editing session for list/range/regex rules.
- Commands:
  - `openValidationRuleEditorAtom`
  - `closeValidationRuleEditorAtom`
  - `setValidationDraftAtom`
- Pure helpers:
  - `evaluateValidationLocal(rule, input)`: synchronous local evaluation for list, range, and regex rules. Formula rules return null (backend eval required).
- Scale bound: one editor state; no per-cell atoms.
- Backend reads: none — validation outcomes arrive via `DisplayCell.validation` in the projection result.
- Tests: `test/data-validation.test.ts`.
