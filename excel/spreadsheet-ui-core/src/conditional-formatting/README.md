# conditional-formatting

Conditional format rule editor state and backend port declarations.

## State Decision Template

- Source atoms:
  - `conditionalFormatRulesCacheAtom`: bounded list of rules for the active sheet (max 200); reset on sheet change.
  - `conditionalFormatEditorAtom`: open/closed panel state plus in-progress draft rule entry.
- Derived atoms: none in the first wave; rule evaluation is backend-owned and delivered per cell via `DisplayCell.conditionalFormat`.
- Commands:
  - `setConditionalFormatRulesAtom` — replace cache wholesale, truncates to cap.
  - `openConditionalFormatEditorAtom` — open panel with existing entry or blank draft.
  - `closeConditionalFormatEditorAtom` — discard draft, close panel.
- Scale bound: rule list bounded to `CONDITIONAL_FORMAT_RULES_MAX = 200`; draft is a single descriptor.
- Backend reads: `DisplayCell.conditionalFormat` overlay delivered per cell in existing projection responses; no new projection kind.
- Per-cell/per-row atom risk: none — overlay is consumed directly from `DisplayCell[]`.
- Tests: `test/conditional-formatting.test.ts`.
