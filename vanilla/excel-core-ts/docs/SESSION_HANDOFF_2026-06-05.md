# Session Handoff — 2026-06-05

Successor agent: read this once (~5 min), run the verification block, then pick a task from §6 "Open work". Historical detail for the 2026-05-28 → 2026-06-05 arc lives in `SESSION_HANDOFF_2026-05-28.md` (2139 lines, 41 continuations) — read it only if you need archaeology.

## 1. Quick verify

```bash
cd /Volumes/work/self/einfach
git log --oneline -3
# Expected top: 40c5567 feat(solid-excel + ui-core): ...
#               d65f839 feat(excel-core-ts): 192→500 fn parity + ...
#               5a1db51 feat(rust): port TS evaluator-aware features + ...

git status -s              # Expected: only this doc, if uncommitted
npx tsc -b 2>&1 | tail -3  # Expected: silent (clean)

npx jest vanilla/excel-core-ts --no-coverage 2>&1 | grep "Tests:"
# Expected: 28 suites / 1675 passed

npx jest vanilla/spreadsheet-ui-core --no-coverage 2>&1 | grep "Tests:"
# Expected: 52 suites / 769 passed

npx jest solid/excel --no-coverage 2>&1 | grep "Tests:"
# Expected: 56 suites / 840 passed

cd rust/excel-core && cargo test --lib 2>&1 | tail -1
# Expected: 1396 passed; 0 failed; 3 ignored

cd ../wasm && cargo test --lib 2>&1 | tail -1
# Expected: 29+ passed; 0 failed
```

If any of these don't match, stop and investigate before proceeding.

## 2. Project context

**einfach** = atom-based state management library (Jotai-inspired). Monorepo. Current focus: **dual excel-core implementations** (Rust/WASM at `rust/excel-core` + `rust/wasm`, TS port at `vanilla/excel-core-ts`) feeding a Solid spreadsheet UI (`solid/excel/src-vnext`).

Both backends ship and coexist. URL `?backend=ts|wasm` selects at runtime. **Never delete rust/, wasm-pkg/, build:wasm, or wasm-pack toolchain** — user explicitly mandated they stay forever.

## 3. Current state (after the 2026-05-28 → 2026-06-05 arc)

### Function parity

- TS `listBuiltinNames()`: **500**
- Rust `eval_func` top-level dispatch: **500**
- Missing TS names: **0** · Extra TS-only names: **0**

### TS engine (vanilla/excel-core-ts)

Major capabilities landed in the arc:
- Evaluator-aware ref forms: `LET`, `LAMBDA`, `ISOMITTED`, `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL`, `MAKEARRAY`, `SHEET`/`SHEETS`, `AREAS`, `FORMULATEXT`, `CELL`, `INDIRECT` (A1 + R1C1 + whole-col/row + cross-sheet), `OFFSET`.
- Lazy branch selectors: `IF`, `IFS`, `SWITCH`, `CHOOSE`, `XLOOKUP`, `INDEX`, `FILTER`, `IFERROR`, `IFNA` evaluate only the chosen branch.
- Internal LAMBDA value channel (no public `Value` widening) — selector → lambda → invocation works through `CHOOSE`, `SWITCH`, `IFS`, `IF`, `IFERROR`, `IFNA`, lazy `XLOOKUP`.
- Per-cell errors preserved in higher-order arrays (`MAP({1,-1}, LAMBDA(x, SQRT(x)))` → `{1, #NUM!}` not `#NUM!`).
- Nested-array lambda results surface `#CALC!`.
- Immediate inline LAMBDA invocation: `=LAMBDA(x, x+1)(4)` → `5`; chained: `=LAMBDA(x, LAMBDA(y, x+y))(2)(3)` → `5`.
- Multi-area references: parsed as `multiArea` Expr, materialized for aggregate args (`SUM((A:A,C:C))`).
- Sparse whole-column aggregation for `SUM`/`COUNTIF`/`SUMIF` (no longer materializes `A:A`).
- Custom number-format engine in `TEXT()`: sections, currency tags, text placeholder `@`, elapsed `[ss].00`, SSN/phone/ZIP+4 masks, accounting.
- Reference-aware `ROW()` / `COLUMN()` / `ROWS` / `COLUMNS` use AST before arg pre-evaluation.

Workbook:
- `withBatch(fn)` defers `recalculateAllSheets()` until the outermost batch exits — one recalc instead of N×sheets for batched `defineName` / `registerCustomFormula`.
- `defineName` / `registerCustomFormula` and their inverses invalidate formula atoms via sheetAtom bump.

Parser:
- `multiArea` Expr (parenthesized union), `lambdaCall` postfix (`expr(args)`), absolute whole-row `$1:$1`.

### Rust engine (rust/excel-core + rust/wasm)

Ported the same wave. `eval.rs` grew +3487 lines; new `format.rs` (+348). Integration tests added for higher-order arrays, reference lookup, text/info edges, financial extensions.

### Solid/excel adapter

- `worker-runtime-ts.ts` `snapshotPersistenceV1.sizes` payload + row/column dimension Maps with rename/remove propagation — closes the last known TS-only e2e parity gap.
- New TS-port runtime tests for size persistence + custom formulas.

### UI core (vanilla/spreadsheet-ui-core)

- `numberFormatParser`: new `text-placeholder` token for `@`; locale/currency `[$..]` tags explicitly stripped.

### Multi-agent review fixes landed in the arc

8 P1 + several P2 from peer review (Cicero/Fermat/Hume/Harvey + me):
- AGGREGATE option-mask bit (was inverted).
- ACCRINT honors `calc_method` 8th arg.
- YEARFRAC basis 1 ISDA actual/actual distinct from basis 3.
- LET-bound LAMBDA self-recursion (closure backpatching).
- MAP/SCAN/BYROW/BYCOL/MAKEARRAY per-cell error preservation.
- CELL("address") cross-sheet preserves sheet name.
- TEXT half-away-from-zero rounding.
- CONVERT 'Wh' → 3600 J.
- FILTER empty → `#CALC!`.
- IMSUM/IMPRODUCT j-suffix propagation.
- DATE 0..1899 year offset rule; TIME bounds; GCD/LCM negatives; STANDARDIZE zero stddev; POISSON.DIST non-integer truncation.
- TRANSLATE / PHONETIC implementations (were stubs).

## 4. Verification numbers (post-arc)

| Surface | Suites | Tests | Status |
|---|---:|---:|---|
| `vanilla/excel-core-ts` | 28 | **1675** | ✅ |
| `vanilla/spreadsheet-ui-core` | 52 | **769** | ✅ |
| `solid/excel` | 56 | **840** | ✅ |
| Total monorepo jest | 186 | **3557** | ✅ |
| `cargo test --lib` (rust/excel-core) | — | **1396** + 3 ignored | ✅ |
| `cargo test --lib` (rust/wasm) | — | 29+ | ✅ |
| `tsc -b` | — | — | ✅ clean |
| e2e BACKEND_PARITY | 59 specs × 2 | last full audit 2026-05-28 | ⚠️ pending re-audit |

## 5. Hard rules (project memory)

1. **NEVER push to origin**. User pushes manually.
2. **NEVER edit `.github/workflows/`** mid-stream.
3. **NEVER delete** `rust/excel-core/`, `rust/wasm/`, `solid/excel/wasm-pkg/`, `build:wasm` script, wasm-pack toolchain — Rust stays as long-term fallback + reference.
4. **Solid 1.9.12 Provider remount hazard**: dialog state must live in atoms, not `let` locals.
5. **UI smoke after every visible change** — MCP playwright walkthrough; unit/e2e alone not enough.
6. **Codex CLI for peer review at real decision points** — not casual second opinions.
7. **Save absolute dates** in memory.
8. **Never amend commits** — always new commit. Pre-commit hook failure → fix + new commit.
9. **Never `--no-verify`** — fix the underlying hook failure.

## 6. Open work (prioritized)

### P1 — Re-audit e2e parity
The last full 59-spec × 2-project audit was 2026-05-28. Since then: TS port grew 192→500 functions, evaluator-aware paths added, Rust ported parallel. The targeted size-fix landed (2 tests now green on both backends), but the wide audit hasn't been re-run. Likely a few specs moved from red to green; some may have moved the other way.

```bash
cd solid/excel
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  npx playwright test --project=wasm
npx playwright test --project=ts
```

Update `solid/excel/e2e/BACKEND_PARITY.md` matrix.

### P2 — Compat tail (open from §41 of the historical doc)

**Fermat (reference semantics):**
- `CHOOSE({1,2}, A1:A2, C1:C2)` should block-concatenate refs (currently picks scalar).
- `SUM((A:A,C:C))` whole-column multi-area still bypasses sparse aggregation.
- `INDEX(...):INDEX(...)` dynamic ranges need parser support.

**Hume (dynamic arrays / higher-order):**
- Whole-column/lazy-grid behavior for `MAP`/`FILTER`/`TOCOL` (currently materializes).
- Input-vs-output cap semantics for `REDUCE`/`BYROW`/`BYCOL` — needs planned pass.
- Shape guards should respect Excel 16,384-column limit.
- Ordinary array literals and `pad` arguments can still leak nested arrays in edge cases.

**Harvey (financial / date):**
- RATE/IRR/XIRR tiny-cashflow residual scaling (premature convergence on flat tangent).
- US NASD 30/360 February month-end handling — basic adjustment works but Feb-EOM edge differs.
- Invalid basis values should return `#NUM!` consistently (currently mixed).

### P3 — Perf reference numbers (still on the table)
- `bulk_import_cells` 750k cap is engineering tourniquet — streaming-deserialize / wasm64 / panic=unwind.
- Chain10k→Chain100k step still 9.3× (target 10×).
- Range-dep coalescing path gated off (`use_coalesced = false`); pinned equivalence test prevents bit-rot.

### P3 — Wave 5/6/7/8 (UI features)
24 e2e fails identical on both backends — pre-existing UI bugs, not parity issues. Cluster in `audit-format.spec.ts` (9), `paste-special.spec.ts` (2), `remove-duplicates.spec.ts` (2), `text-to-columns.spec.ts` (1), `vnext-smoke.spec.ts` (2).

ROADMAP.md sequences Wave 5 (shell + canvas overlay) → Wave 6 (cell-format complete) → Wave 7 (data-ops + nav) → Wave 8 (formula extension + export).

## 7. Critical gotcha — wasm-bindgen "attempted to take ownership while borrowed"

**This error message is generic, NOT a `RefCell` conflict.** It surfaces from `wasm-bindgen::FromWasmAbi::from_abi` when the workbook `Rc` is stale because **a prior Rust panic = abort** never unwound the borrow guard.

Three different root causes seen historically, all produce the same JS-side symptom:
1. wasm32 linear memory exhaustion at 1M+ cell formulas → allocator panic
2. WASM stack overflow at 1000-deep cross-cell recursion → stack guard panic
3. Any other Rust panic in the worker

**Future debugging rule**: when this error shows up, **try a native `cargo test` repro first**. Native panics surface clear messages. Don't waste hours auditing borrows.

## 8. Where things live

```
vanilla/excel-core-ts/
├── docs/
│   ├── PLAN.md
│   ├── AGENT_COLLABORATION.md
│   ├── ARCHITECTURE.md
│   ├── PERF_BULK_IMPORT.md
│   ├── STASH_AUDIT.md
│   ├── SESSION_HANDOFF_2026-05-28.md   — historical (2139 lines, 41 sections)
│   └── SESSION_HANDOFF_2026-06-05.md   — this file
├── src/
│   ├── eval/
│   │   ├── evaluate.ts                  — trampoline + lazy IF + LAMBDA + evaluator-aware refs
│   │   └── functions/                   — 500 fns; database.ts is the newest category
│   ├── sheet.ts
│   ├── workbook.ts                      — incl withBatch()
│   ├── types.ts                         — Value/Expr unions; MultiAreaExpr/LambdaCallExpr/LambdaBinding
│   └── parser/                          — Pratt parser (multi-area, lambdaCall postfix, $1:$1)
└── test/                                — 28 suites / 1675 tests

rust/excel-core/src/
├── sheet.rs                             — would_create_cycle reverse BFS, prewarm, batch ops
├── workbook.rs                          — force_formula_recompute scoped, names canonical
├── eval.rs                              — 500-fn dispatch + evaluator-aware paths
├── format.rs                            — custom number-format engine (new)
├── formula.rs                           — Expr types (incl multiArea/lambdaCall)
└── bulk_import_trace.rs                 — instrumented variant for profiling

rust/wasm/src/lib.rs                     — wasm-bindgen boundary + 750k cap

solid/excel/
├── src-vnext/adapter/
│   ├── worker-runtime.ts                — WASM worker shim
│   ├── worker-runtime-ts.ts             — TS worker shim (incl snapshotPersistenceV1.sizes)
│   └── worker-protocol.ts               — RPC contract
├── e2e/
│   ├── BACKEND_PARITY.md                — 59-spec matrix (pending re-audit)
│   ├── helpers.ts                       — gotoRoot preserves project query
│   └── *.spec.ts                        — 59 spec files
├── test/                                — 56 suites / 840 tests
├── playwright.config.ts                 — wasm + ts dual project
└── wasm-pkg/                            — generated by build:wasm (do not edit)

vanilla/spreadsheet-ui-core/             — framework-agnostic UI atoms + types
├── docs/                                — 20+ feature design docs + ROADMAP.md
├── src/operations/format/numberFormatParser.ts  — incl @ text-placeholder
└── test/                                — 52 suites / 769 tests
```

## 9. How to run perf benches

```bash
# Main TS-vs-WASM bench
unset http_proxy https_proxy all_proxy && NO_PROXY=localhost,127.0.0.1 \
  EINFACH_PERF=1 npx jest perf-ts-vs-wasm.bench.ts --no-coverage \
  --testTimeout=1800000

# Filter to one workload family
EINFACH_PERF=1 npx jest perf-ts-vs-wasm.bench.ts -t "Chain"   # or "Range" or "Mega"

# bulk_import sub-phase breakdown
EINFACH_PERF=1 npx jest perf-rust-bulk-import-trace.bench.ts --no-coverage \
  --testTimeout=1800000
```

Reports auto-write to `solid/excel/test/perf-*-report.md`.

## 10. How to run e2e

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  cd solid/excel && \
  npx playwright test --project=wasm    # or --project=ts
```

The proxy unset is required because Playwright's webServer health probe goes through `http_proxy` and gets a misleading 502 → skips its own server start.

## 11. Codex review cheatsheet

```bash
codex review --base <SHA_OR_REF> --title "..." < /tmp/prompt.txt 2>&1 | tail -200
codex review --uncommitted --title "..." < /tmp/prompt.txt 2>&1 | tail -200
# Cannot combine --uncommitted with prompt args — pipe via stdin
```

## 12. Stash policy

`git stash list` should stay empty. The historical 16 dropped SHAs are in `STASH_AUDIT.md` for 90-day reflog recovery. Don't use stash for "checkpoint" — use real commits or worktrees.

## 13. Final state at handoff

- jest monorepo: **186 suites / 3557 tests** ✓
- cargo excel-core: 1396 ✓
- cargo wasm: 29+ ✓
- tsc -b clean ✓
- e2e: last full audit 2026-05-28, pending re-run (P1 above)
- working tree: clean
- 448 commits ahead of origin, never pushed

Your move.
