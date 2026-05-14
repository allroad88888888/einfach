# diagnostics

Owns toast/status/debug panel UI state.

## State Decision Template

- Source atoms:
  - `diagnosticsAtom`: bounded visible diagnostics list.
- Derived atoms: none in the first wave; mapping helpers are pure functions.
- Commands:
  - `appendDiagnosticsAtom`
  - `replaceDiagnosticsAtom`
  - `clearDiagnosticsAtom`
- Scale bound: bounded UI messages and current debug view.
- Backend reads: explicit debug counters only.
- Per-cell/per-row/per-col atom risk: do not keep full error-cell indexes.
- Tests: `test/diagnostics.test.ts`.
