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

## 4. Verification numbers (after 2026-06-05/11 follow-up arc)

| Surface | Suites | Tests | Status |
|---|---:|---:|---|
| `vanilla/excel-core-ts` | 30 | **1791** | ✅ |
| `vanilla/spreadsheet-ui-core` | 53 | **774** | ✅ |
| `solid/excel` | 58 | **843** | ✅ |
| Total monorepo jest | — | **3681** | ✅ |
| `cargo test --lib` (rust/excel-core) | — | **1396** + 3 ignored | ✅ |
| `cargo test --tests` (integration suites) | — | all green (15+ suites) | ✅ |
| `cargo test --lib` (rust/wasm) | — | 29+ | ✅ |
| `tsc -b` | — | — | ✅ clean |
| e2e WASM | 515 | **478 / 0 / 37** | ✅ all green |
| e2e TS | 515 | **478 / 0 / 37** | ✅ Δ=0 vs WASM, all green |

### Wave 8 + locale infrastructure (2026-06-11)

- **Workbook locale** `9cde891`: `Workbook.setLocale(bcp47)` / `getLocale()`,
  defaults to `'en-US'`. `EvalContext.locale` threaded through cross-sheet
  contexts. TEXT / DOLLAR / FIXED consume via new `_locale.ts` Intl-based
  helpers (number / currency parts). LCID `[$-XXX]` format tags stripped
  silently. `setLocale` invalidates atoms (respects `withBatch`).
- **Wave 8 PNG export PoC**: `5e95b93` design doc → `84986d9` UI core
  port + `encodeSelectionAsImage` → `c6babae` Solid host PoC rasterizing
  via SVG `<foreignObject>` + canvas. Backend port `exportRangeAsImage`
  is OPTIONAL; UI core returns null when host omits. TODO documented in
  the design doc: worker-backend advertising, `Ctrl+Shift+P` keybind,
  `ClipboardItem({'image/png': blob})` write, MAX_EXPORT_PIXELS cap, per-
  cell sizing from viewport projection, canvas-first paint, Playwright e2e.

### Function quality hardening (after `a1abdec`)

Catalogued via `FUNCTION_QUALITY_2026-06-05.md`. Initial pass landed
`10924eb` + `f42cb88` (5 S-fixes + 18 cataloged). Three follow-up agents
attacked the M-difficulty layer:

- **ERF/ERFC** `d7830d9`: Abramowitz polynomial (~1.5e-7) → Cody Chebyshev
  rational (~1 ULP). ERF.PRECISE / ERFC.PRECISE alias intact.
- **lookup binary search** `f5bc362`: VLOOKUP / HLOOKUP / MATCH approximate
  match + XLOOKUP `search_mode = ±2` use shared `binarySearchSorted` with
  exact / lte / gte modes; fall back to linear on unsortable input.
- **Text** `4efc3f1`: ROMAN(0) → "" (was `#VALUE!`); DOLLAR / FIXED
  regression coverage. Locale-aware separators remain L-difficulty.
- **Stats** `dfafe73`: BETA.INV / GAMMA.INV Newton-Raphson seeded at mean
  with bisection fallback. T.INV df=1 closed form (Cauchy); T.INV df>1 and
  F.INV use Wilson-Hilferty seeds. STDEV/VAR family (12 variants) routed
  through Welford's online algorithm for cancellation-resistant variance.
- **Math** `f677e6d`: SUMPRODUCT uses Kahan-Babuška-Neumaier compensated
  summation (recovers 1e20 + 1 − 1e20 → 1); SERIESSUM uses plain Kahan.

**Net test growth from quality arc: 1702 → 1767 (+65 new tests).**

### Follow-up arc (2026-06-05) — landed since the v2 doc was written

- **Fermat (refs)** `bfaee8c`: `SUM/COUNTIF/SUMIF/COUNTA/COUNT((A:A,C:C))` multi-area sparse aggregation. CHOOSE array-index broadcasting and INDEX(...):INDEX(...) parser were already in HEAD — regression tests added.
- **Harvey (financial)** `86ff484`: RATE/IRR/XIRR residual tolerance floored at 1; NASD 30/360 February EOM adjustment; 25 bond/depreciation functions reject invalid `basis` with `#NUM!` (was `#VALUE!`).
- **Hume (dynamic arrays)** `b14a817` (mixed with parity doc): MAP/FILTER/TOCOL whole-column sparse iteration; REDUCE/BYROW/BYCOL input cap; MAKEARRAY/SEQUENCE/RANDARRAY/EXPAND 16384-column guard; TAKE/DROP/EXPAND/WRAPROWS/WRAPCOLS reject array-typed pad_with.
- **Worker runtime parity** `173120f` + `77731bf`: TS worker `debugFormulaCacheState` reports 'dirty' for never-read formula cells; `snapshotRangeSparseChunks` respects the chunk-size cap; bulk-import collapses per-chunk writes into one `bulkApply` per sheet. Closes the 3 TS-only `vnext-worker-backend.spec.ts` failures (lines 100/165/217). **TS = WASM at 465/21/29.**

### Wave 5/6/7 UI cluster closure (2026-06-05 final batch — `d7f3017`)

After backend parity, 21 remaining e2e fails were UI bugs identical on both
projects. Closed in two parallel batches:

- **audit-format cluster (9 fails)** `9433285` + `77c7e26`: format-cells
  dialog (Save/Cancel/custom row), v-align dropdown (top/middle/round-trip),
  fill color popover (`.cell-display` background inheritance), merge dropdown
  1×1 enabled, Print Preview toolbar button removed (Wave 5 pruning).
- **Wave 7 dialogs (5 fails)** `ee34233` + `65114f1` + `ead1d6c`: name-box
  scroll on cell jump (paste-special navigation), remove-duplicates EN-locale
  message assertions, text-to-columns preview cap counts the `…` marker.
- **Misc UI (6 fails)** `39757a0` + `09560ad` + `b4341da` + `7b69dac` +
  `c9f41df`: toolbar mousedown preventDefault preserves grid focus for
  Ctrl+Z/Y; Alt+PageDown/Up uses host viewport delta; context menu collapses
  1×1 range to cell target-kind; copy-as HTML emits rowspan/colspan on merge
  anchor; Go To Special row-differences uses selection top-left as anchor.

**Final state: both backends at 478 / 0 / 37 across 515 spec runs.**

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

The 2026-06-05 follow-up arc closed the previous P1 (e2e re-audit) and the
three P2 compat tails (Fermat / Hume / Harvey). The Wave 5/6/7 UI cluster
that was P1 has also been fully closed (see §3). Remaining work below.

### P1 — No open P1

Both backends are at 478/0/37 with Δ=0. The previous P1 cluster (21 UI
fails) is fully closed. Next priorities are P2 / P3 — perf and quality.

### P2 — Engine compat edges still open

**Refs (still TODO from Fermat scope):**
- Verify the new multi-area sparse path covers every aggregate the user
  might hit (current pass: SUM/COUNTIF/SUMIF/COUNTA/COUNT).

**Higher-order arrays (still TODO from Hume scope):**
- Empty-input semantics for FILTER (`if_empty`) and MAP/REDUCE; current
  pass handles input cap and shape guards, but the empty-array branch
  needs Excel-exact `#CALC!` vs `if_empty` evaluation.

**Bulk-import caveat (introduced by 2026-06-05 worker-runtime fix):**
- The `bulkApply` fast path in `worker-runtime-ts.ts` can mis-classify
  text values that look numeric / boolean / error / formula
  (e.g. `text="00123"` → number 123). Single-cell `setCell` RPC still
  preserves type via `setCellValue`. Documented inline in the runtime.

### P3 — Perf reference numbers (still on the table)
- `bulk_import_cells` 750k cap is engineering tourniquet — streaming-deserialize / wasm64 / panic=unwind.
- Chain10k→Chain100k step still 9.3× (target 10×).
- Range-dep coalescing path gated off (`use_coalesced = false`); pinned equivalence test prevents bit-rot.

### P3 — Wave 7.4 / Wave 8 features
- Wave 7.4 (Copy as HTML/Markdown) shipped earlier.
- Wave 8 PNG export + remote formulas + array enhancements pending the UI shell.

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
