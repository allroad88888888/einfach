# formula-bar

Owns formula bar draft, focus, diagnostics, and reference-picking wiring.

## State Decision Template

- Source atoms:
  - `formulaBarStateAtom`: focus, selected cell address, draft, synced draft, revision, diagnostic, and error.
- Derived atoms:
  - `formulaBarFocusedAtom`: focus flag derived from `formulaBarStateAtom`.
  - `formulaBarDraftAtom`: writable draft view over `formulaBarStateAtom`.
- Commands:
  - `focusFormulaBarAtom`
  - `syncFormulaBarAtom`
  - `setFormulaBarDiagnosticAtom`
  - `setFormulaBarErrorAtom`
- Scale bound: one active formula bar session.
- Backend reads: source/formula text only; do not force formula result evaluation.
- Per-cell/per-row/per-col atom risk: none; state stores one selected cell coordinate and current draft.
- Tests: `test/formula-bar.test.ts`.
