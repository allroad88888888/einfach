# Session Handoff — 2026-05-28

Successor agent: this doc is your starting point. Read it once (~5 min), run the verification block, then pick a task from §7 "Open work".

## 1. Quick verify (run before doing anything)

```bash
cd /Volumes/work/self/einfach
git log --oneline -3
# Expected top: 8eb692e feat+fix: phase 8 functions (82→192) + e2e full audit + codex P1 cycle range fix

git status -s
# Expected: empty (working tree clean)

git stash list | wc -l
# Expected: 0

npx tsc -b 2>&1 | tail -3
# Expected: silent (clean)

npx jest excel-core-ts --no-coverage 2>&1 | grep -E "Suites|Tests"
# Expected: 30 passed / 1122 passed

cd rust/excel-core && cargo test --lib 2>&1 | tail -1
# Expected: 1371 passed; 0 failed; 3 ignored

cd ../wasm && cargo test --lib 2>&1 | tail -1
# Expected: 29 passed; 0 failed
```

If any of these don't match, stop and investigate before proceeding.

## 2. Project context

**einfach** = atom-based state management library (Jotai-inspired). Monorepo. Current focus: **dual excel-core implementations** (Rust/WASM at `rust/excel-core` + `rust/wasm`, TS port at `vanilla/excel-core-ts`) feeding a Solid spreadsheet UI (`solid/excel/src-vnext`).

Both backends ship and coexist. URL `?backend=ts|wasm` selects at runtime. **Never delete rust/, wasm-pkg/, build:wasm, or wasm-pack toolchain** — user explicitly mandated they stay forever.

## 3. This session's commits (most recent first)

```
8eb692e  feat+fix  phase 8 functions (82→192) + e2e full audit + codex P1 cycle range
c3181c1  docs      清 15 stash（reflog 可恢复）
324206e  docs      drop stash@{2}
49c467f  perf      Chain 14× step + Range workloads + flush scratch
eb5f11c  perf      Chain100k 715s → 501ms (1428×)
bbf5c03  fix       codex P1×2 + P2
13680f9  fix       WASM Chain1k+ stack overflow（iterative prewarm）
8af71b4  perf      chain trifecta（TS trampoline + WASM cache + flush dedup）
b607654  perf      chain bench + WASM 2M fix + bulk_import profile
04f1878  feat      #CALC! + 递归 LAMBDA + 1M perf + status-bar e2e
de5cca6  feat      probe parity + dual-backend e2e
22acb8d  feat      LAMBDA UI + perf bench
```

**main is 458 commits behind**. Never pushed. User decides when/if to push.

## 4. Current state — three pillars

### TS engine (vanilla/excel-core-ts)

- 192 functions across math/stats/text/date/info/logical/lookup/financial/array/engineering
- Recursive LAMBDA via lazy IF (FACT(20) = 2.4×10¹⁸)
- `#CALC!` error code
- Bottom-up trampoline replaces recursive resolveCell — Chain100k completes in 160ms
- Probe API (`debugFormulaCacheState` / `EvalCount` / `Count`) matches Rust shape

### Rust engine (rust/excel-core + rust/wasm)

5 real bugs fixed in this session:
1. WASM 2M cells allocator exhaustion → `MAX_BULK_IMPORT_CELLS_PER_CALL = 750_000` guard
2. WASM Chain1k+ stack overflow → `prewarm_formula_chain` iterative post-order DFS
3. Chain steady-state re-eval bug → `force_formula_recompute()` scoped to `has_any_cross_sheet_edges()` (the latch covers raw-path + post-remove-sheet too)
4. flush BFS HashSet realloc per visited cell → `dependents_of_into` takes &mut Vec, scratch buffer reuse across walk
5. `would_create_cycle` O(n²) forward BFS → reverse BFS over both `cell_dependents` AND `range_dependents` (codex P1 caught the range omission)

### Dual-backend e2e

- `playwright.config.ts` two projects: `wasm` (default) + `ts`
- `solid/excel/e2e/helpers.ts::gotoRoot` preserves `?backend=` from project name
- Full audit complete: 59 specs × 2 projects
  - wasm: 462 pass / 24 fail / 29 skip
  - ts: 460 pass / 26 fail / 29 skip
  - Δ = 2 TS-only fails (`snapshotPersistenceV1.sizes` RPC gap)
- Matrix in `solid/excel/e2e/BACKEND_PARITY.md`

## 5. Perf reference numbers (post-session)

| Workload | Phase | TS | WASM | Verdict |
|---|---|---:|---:|---|
| Chain100k | firstRecalc | 143 ms | **82.9 ms** | WASM 1.72× |
| Chain100k | mutateThenRecalc | 159 ms | **136 ms** | WASM 1.17× |
| Chain100k | bulkWrite | **75 ms** | 278 ms | TS 3.7× |
| Chain100k | steadyState | 0.01 ms | 0.02 ms | tied |
| FanOut100k | bulkWrite | **90 ms** | 227 ms | TS 2.5× |
| FanIn100k | bulkWrite | **38 ms** | 50 ms | TS 1.3× |
| Stripe100k | bulkWrite | **52 ms** | 815 ms | TS 16× |
| Mega (1M) | recalc | **24.6 s** | 63.6 s | TS 2.6× |
| Ultra (2M) | all phases | **49.8 s** | refused (750k cap) | TS only |

**WASM strengths**: per-cell precise dep tracking → wins chain re-eval
**TS strengths**: broad-invalidation skips dep wiring → wins bulk install

## 6. Hard rules (from project memory)

1. **NEVER push to origin**. User pushes manually if/when.
2. **NEVER edit `.github/workflows/`** mid-stream.
3. **NEVER delete** `rust/excel-core/`, `rust/wasm/`, `solid/excel/wasm-pkg/`, `build:wasm` script, wasm-pack toolchain — Rust stays as long-term fallback + reference.
4. **Solid 1.9.12 Provider remount hazard**: dialog state must live in atoms, not `let` locals.
5. **UI smoke after every visible change** — MCP playwright walkthrough; unit/e2e alone not enough.
6. **Codex CLI for peer review at real decision points** — not casual second opinions.
7. **Save absolute dates** in memory (today = 2026-05-28).
8. **Never amend commits** — always new commit. If pre-commit hook fails, fix + create NEW commit, don't `--amend`.
9. **Hooks failure ≠ skip hook** — never `--no-verify`. Diagnose + fix the underlying issue.

## 7. Open work (prioritized)

### P1 — Real correctness/RPC gap
- **`snapshotPersistenceV1.sizes` TS gap**. Currently TS worker omits the `sizes` payload (rowHeights/colWidths) from persistence snapshots. Causes 2 e2e failures in `vnext-worker-backend.spec.ts`. Look at `solid/excel/src-vnext/adapter/worker-runtime-ts.ts` `snapshotPersistenceV1` handler — needs to read row/col size metadata and emit them.

### P2 — Real perf wins still on the table
- **`bulk_import_cells` real refactor**. Current 750k cap is engineering tourniquet, not solution. Options:
  - streaming-deserialize (don't materialize full payload at once)
  - panic = unwind profile (borrows release on panic, no Rc leak)
  - wasm64 target (lift 4 GB linear memory ceiling)
  Worth doing if someone really needs > 750k cell bulk write.

- **Chain10k → Chain100k step is 9.3×** post-optimization (was 14.6×). Still slightly worse than ideal 10×. The `chain_install_scaling_trace_phases` `#[ignore]`'d test in sheet.rs gives sub-phase breakdown — chase if motivated.

- **Range-dep coalescing path in sheet.rs is gated off** (`use_coalesced = false`). Test pins equivalence so it doesn't bit-rot. If a future workload is dominated by wide ranges + the bucket index degenerates, flip it on.

### P3 — Function fill 192 → ~250
Skipped because each took >15min:
- OFFSET/INDIRECT — need evaluator-level ctx integration
- MAP/REDUCE/SCAN/BYROW/BYCOL/MAKEARRAY — LAMBDA-callback functions need evaluator-aware impl
- D-functions (DSUM/DAVERAGE/...) — criteria header + table semantics
- MDETERM/MMULT — matrix ops, numerical care
- Statistical distributions (NORM.DIST, T.DIST, F.DIST, BETA.DIST, CHISQ.*, BINOM.*) — need CDF/PDF routines
- CELL/INFO — workbook-level metadata access

### P3 — Wave5 UI bugs (24 e2e fails, identical on both backends)
Cluster in:
- `audit-format.spec.ts` (9 fails) — toolbar v-align, Format Cells dialog, color popovers, merge dropdown
- `paste-special.spec.ts` (2)
- `remove-duplicates.spec.ts` (2)
- `text-to-columns.spec.ts` (1)
- `vnext-smoke.spec.ts` (2) — formula-bar addr `G7 vs N7` for Alt+PageDown, context-menu `data-menu-target-kind`
- Others scattered

NOT backend issues. Touch `solid/excel/src-vnext/` if you go after these.

## 8. Critical gotcha — wasm-bindgen "attempted to take ownership while borrowed"

**This error message is generic, NOT a `RefCell` conflict.** It surfaces from `wasm-bindgen::FromWasmAbi::from_abi` when the workbook `Rc` is stale because **a prior Rust panic = abort** never unwound the borrow guard.

Three different root causes seen this session, all produce the same JS-side symptom:
1. wasm32 linear memory exhaustion at 1M+ cell formulas → allocator panic
2. WASM stack overflow at 1000-deep cross-cell recursion → stack guard panic
3. Any other Rust panic in the worker

**Future debugging rule**: when this error shows up, **try a native `cargo test` repro first**. Native panics surface clear messages. Don't waste hours auditing borrows.

## 9. Where things live

```
vanilla/excel-core-ts/
├── docs/
│   ├── PLAN.md                    — 9-phase plan; phase 8 done, phase 9 done
│   ├── AGENT_COLLABORATION.md     — multi-agent waves history
│   ├── ARCHITECTURE.md            — atom-based engine design
│   ├── PERF_BULK_IMPORT.md        — bulk_import profile + recommendations
│   ├── STASH_AUDIT.md             — 16 stashes audited, cleared 2026-05-28
│   └── SESSION_HANDOFF_2026-05-28.md  — this file
├── src/
│   ├── eval/
│   │   ├── evaluate.ts            — trampoline + lazy IF + LAMBDA dispatch
│   │   └── functions/             — 192 fns across math/stats/text/date/...
│   ├── sheet.ts                   — per-sheet atom + formulaCellAtom factory
│   ├── workbook.ts                — Workbook root + debug probes
│   ├── types.ts                   — Value/Expr/ErrorCode unions, includes #CALC!
│   └── parser/                    — Pratt parser
└── test/                          — 30 jest suites / 1122 tests

rust/excel-core/src/
├── sheet.rs                       — Sheet engine (would_create_cycle reverse BFS, prewarm)
├── workbook.rs                    — Workbook root (force_formula_recompute scoped)
├── eval.rs                        — 400+ function dispatch
└── bulk_import_trace.rs           — instrumented variant for profiling

rust/wasm/src/lib.rs               — wasm-bindgen boundary + 750k cap

solid/excel/
├── src-vnext/
│   ├── adapter/
│   │   ├── worker-runtime.ts      — WASM worker shim
│   │   ├── worker-runtime-ts.ts   — TS worker shim
│   │   └── worker-protocol.ts     — RPC contract
│   └── demos/
│       └── VNextWorkerDemo.tsx    — reads ?backend= URL, picks factory
├── e2e/
│   ├── BACKEND_PARITY.md          — 59-spec matrix
│   ├── helpers.ts                 — gotoRoot preserves project query
│   └── *.spec.ts                  — 59 spec files
├── test/
│   ├── perf-ts-vs-wasm.bench.ts   — main TS-vs-WASM bench
│   ├── perf-ts-vs-wasm-report.md  — auto-generated numbers
│   ├── perf-rust-bulk-import-trace.bench.ts  — bulk_import sub-phase profile
│   └── excel-core-ts-debug-probes.test.ts    — probe state machine tests
├── playwright.config.ts           — wasm + ts dual project
├── vite.config.ts                 — aliases @einfach/excel-core-ts to src/
└── wasm-pkg/                      — generated by build:wasm (do not edit)
```

## 10. How to run perf benches

```bash
# Main TS-vs-WASM bench (chain, range, size tiers)
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

## 11. How to run e2e

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  cd solid/excel && \
  npx playwright test --project=wasm    # or --project=ts
```

The proxy unset is required because Playwright's webServer health probe goes through `http_proxy` and gets a misleading 502 → skips its own server start.

## 12. Codex review cheatsheet

```bash
# Review last N commits
codex review --base <SHA_OR_REF> --title "..." < /tmp/prompt.txt 2>&1 | tail -200

# Review uncommitted
codex review --uncommitted --title "..." < /tmp/prompt.txt 2>&1 | tail -200

# Cannot combine --uncommitted with prompt args — pipe via stdin
```

Codex review on this session caught:
- 5 findings in `7bd644b` (all P1/P2)
- 3 findings post-trifecta `bbf5c03` (P1×2, P2×1)
- 1 finding post-chain-trifecta `8eb692e` (P1)

All addressed.

## 13. Stash policy

`git stash list` is empty. The audit in `STASH_AUDIT.md` records all 16 dropped SHAs for 90-day reflog recovery. **Don't re-create stashes for "checkpoint" purposes** — use real commits or worktrees.

## 14. Final state at handoff

- jest: 30 suites / **1122 tests** ✓
- cargo excel-core: **1371 / 0** (+3 ignored perf traces) ✓
- cargo wasm: **29 / 0** ✓
- tsc -b clean
- e2e wasm: 462/24/29 ; ts: 460/26/29
- git stash: empty
- working tree: clean
- 458 commits ahead of origin, never pushed

Your move.

## 15. 2026-06-22 TS formula review P2 closeout

Context:

- macOS external-volume permission was restored for `/Volumes/work/self/einfach`.
- Continued the previous multi-agent TS formula parity pass and closed the four
  review P2s left open after the 2026-05-29 run.

Changes landed:

- `RATE` now checks the zero-rate closed-form residual before Newton iteration.
  This preserves tiny-cashflow residual scaling while allowing exact zero-rate
  roots such as `RATE(360, 2.0833333333333335, -1000, 250)` to return `0`
  instead of `#NUM!`.
- The `RATE` happy-path test was corrected to a true non-zero inverse-PMT
  fixture: `PMT(0.05, 10, 1000) = -129.50457496545661`, so `RATE(...)`
  should return `0.05`.
- Financial invalid basis coverage now includes `AMORDEGRC(..., basis=5)`;
  `parseBasis` was already aligned to Excel `#NUM!` semantics.
- Parser range construction now rejects chained range operators whose endpoint
  is already a range, so malformed formulas such as `A1:B2:C3`,
  `A1:INDEX(A:A,2):A3`, and `A1:(B1:C1)` return `#VALUE!` instead of silently
  widening the range.
- Direct spill refs now reuse `runtimeRefFromSpillRef`, so `A1048576#` rejects
  an anchor array that would spill past the sheet bounds with `#REF!`.
- Added a TS worker UI e2e regression in
  `solid/excel/e2e/vnext-worker-ts.spec.ts` covering the `RATE` zero-root path,
  chained range parse failure display, and the current over-wide `MAKEARRAY`
  cap result through a real Worker.

Verification:

```bash
npx jest --runTestsByPath vanilla/excel-core-ts/test/financial.test.ts \
  --no-coverage --runInBand -t "RATE|invalid basis"
npx jest --runTestsByPath \
  vanilla/excel-core-ts/test/parser.test.ts \
  vanilla/excel-core-ts/test/reference-functions.test.ts \
  --no-coverage --runInBand -t "dynamic references|spill references|dynamic-range endpoints"
npx tsc -p vanilla/excel-core-ts/tsconfig.json --noEmit
npx jest vanilla/excel-core-ts --no-coverage --runInBand
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  npx playwright test e2e/vnext-worker-ts.spec.ts --project=ts \
    -g "formula compatibility regressions" # from solid/excel
git diff --check
```

Results:

- Financial focused run: **34 selected tests passed**.
- Parser/reference focused run: **2 suites / 11 selected tests passed**.
- Latest combined targeted unit run: **3 suites / 45 selected tests passed**.
- TS worker e2e regression: **1 passed**.
- Full `excel-core-ts` Jest: **33 suites / 1844 tests passed**.
- Typecheck passed.
- `git diff --check` clean.

Rust/WASM note:

- No Rust or WASM files were touched in this continuation.

## 16. 2026-06-22 multi-agent formula parity sweep

Context:

- Spawned four read-only review/repro agents:
  - Agent A: `evaluate.ts` reference/LAMBDA metadata.
  - Agent B: `text.ts` Excel text compatibility.
  - Agent C: dynamic array cap/error-code behavior.
  - Agent D: engineering/financial isolated compat.
- Main agent integrated only bounded fixes with direct repros and tests.

Changes landed:

- `RATE` now uses a RATE-specific residual convergence check so tiny cash-flow
  inputs remain scale-invariant. The zero-rate fast path is skipped when the
  caller supplies an explicit `guess`, so multi-root cases can still converge
  to the root selected by the guess.
- `CONVERT` gained documented Excel aliases for pressure and energy units:
  `p`, `at`, `e`, `c`, `HPh`, `hh`, `flb`, plus explicit coverage for `wh`.
- `TEXT` fixed decimal rounding paths to round halves away from zero despite
  binary float noise (`1.005`, `2.675`, percent, grouped, custom, scientific).
- `DOLLAR` / `FIXED` negative `decimals` now round negative halves away from
  zero.
- `SEARCH("~~", ...)` now treats escaped tilde as a literal tilde even when no
  `*` or `?` wildcard is present.
- `CLEAN` now strips ASCII 0-31 only and preserves DEL 127.
- `TEXTBEFORE` / `TEXTAFTER` / `TEXTSPLIT` case-insensitive match mode now
  handles non-ASCII casing such as `Ä`/`ä`.
- `SHEET`, `SHEETS`, `AREAS`, and `ISREF` now validate missing sheets inside
  reference metadata paths, including multi-area references.
- Direct `A1#` spill refs now preserve 1x1 array identity instead of collapsing
  to a scalar, so chained spill refs like `B1#` still work.
- Added a missing `SCAN` nested-array callback regression test.

Verification:

```bash
npx jest --runTestsByPath \
  vanilla/excel-core-ts/test/financial.test.ts \
  vanilla/excel-core-ts/test/phase8-engineering.test.ts \
  vanilla/excel-core-ts/test/text.test.ts \
  vanilla/excel-core-ts/test/phase8-text.test.ts \
  vanilla/excel-core-ts/test/reference-functions.test.ts \
  vanilla/excel-core-ts/test/lambda-higher-order.test.ts \
  --no-coverage --runInBand \
  -t "RATE|CONVERT|TEXT|SEARCH|CLEAN|TEXTBEFORE|TEXTAFTER|TEXTSPLIT|DOLLAR|FIXED|SHEET|SHEETS|ISREF|AREAS|spill|nested array"
npx tsc -p vanilla/excel-core-ts/tsconfig.json --noEmit
npx jest vanilla/excel-core-ts --no-coverage --runInBand
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  npx playwright test e2e/vnext-worker-ts.spec.ts --project=ts \
    -g "formula compatibility regressions" # from solid/excel
```

Results:

- Focused run: **6 suites / 147 selected tests passed**.
- Full `excel-core-ts` Jest: **33 suites / 1851 tests passed**.
- Typecheck passed.
- TS worker e2e regression: **1 passed**.
- `codex review --uncommitted` caught three P2s during this sweep:
  explicit-guess `RATE` multi-root selection, 1x1 direct-spill identity, and
  large-number text rounding epsilon. All three were fixed and covered by
  targeted tests.
- Claude Code adversarial review then caught two more P2s:
  `RATE(..., 0, 0.1)` was not equivalent to omitted default guess, and
  `ROUND(0.145, 2)` disagreed with the newly corrected `TEXT(0.145, "0.00")`.
  Both are fixed. `RATE` now allows the zero-root fast path for the explicit
  default guess, while explicit non-default guesses can still select a
  non-zero root. `ROUND` now uses the same bounded half-tie correction style
  as `TEXT`, with tests for `0.145` and `-0.145`.
- Post-Claude verification:
  - `npx jest --runTestsByPath vanilla/excel-core-ts/test/financial.test.ts vanilla/excel-core-ts/test/math.test.ts vanilla/excel-core-ts/test/text.test.ts --no-coverage --runInBand -t "RATE|ROUND|TEXT"`:
    **3 suites / 93 selected tests passed**.
  - Full `excel-core-ts` Jest remains **33 suites / 1851 tests passed**.
  - Typecheck passed.
  - TS worker e2e regression remains **1 passed**.

Deferred next:

- Agent A also flagged full worksheet spill collision / `#SPILL!` parity
  (`SEQUENCE` over grid bounds, occupied targets). Current repo policy still
  pins axis overflow to `#NUM!`; changing that should be a separate parity
  decision because existing tests and TS-worker e2e assert it.

## 17. 2026-06-23 LET/LAMBDA reference identity closeout

Follow-up to the deferred Agent A finding above. Implemented the deliberate
carrier design without widening public `Value`:

- Added evaluator-internal `LambdaReferenceBinding` and `EvalContext.lambdaRefScope`.
  Public cell/function values remain scalar/array/error only.
- `LET` bindings and LAMBDA call arguments now capture `runtimeRefFromExpr(...)`
  before falling back to ordinary value evaluation. The three local namespaces
  are mutually exclusive: scalar value, function-valued LAMBDA, or reference.
- `runtimeRefFromExpr(name)` now resolves scoped reference names, so
  `CELL`, `FORMULATEXT`, `INDEX`, `ROW(S)`, `COLUMN(S)`, and dynamic ranges can
  see reference identity through LET/LAMBDA.
- Ordinary `NameExpr` evaluation materializes scoped references through
  `evaluateRuntimeRef(...)`, so `LET(r, Data!C3, r+1)` still behaves like a
  scalar value expression.
- LAMBDA closures now capture `closureRefScope`; trampoline contexts pass the
  reference scope through inside the same formula evaluation.

New workbook-backed regression coverage in `reference-functions.test.ts`:

- `LET(r,Data!C3,CELL("address",r))` -> `Data!$C$3`
- `LAMBDA(r,CELL("address",r))(Data!C3)` -> `Data!$C$3`
- `LAMBDA(r,FORMULATEXT(r))(Data!A5)` -> source formula text
- `LAMBDA(r,SUM(INDEX(r,1):INDEX(r,3)))(Data!A:A)` -> `6`
- `LET(r,Data!C3,r+1)` -> `8`

Verification:

```bash
npx jest --runTestsByPath \
  vanilla/excel-core-ts/test/reference-functions.test.ts \
  vanilla/excel-core-ts/test/lambda-higher-order.test.ts \
  vanilla/excel-core-ts/test/lambda.test.ts \
  --no-coverage --runInBand
npx jest vanilla/excel-core-ts --no-coverage --runInBand
npx tsc -p vanilla/excel-core-ts/tsconfig.json --noEmit
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  npx playwright test e2e/vnext-worker-ts.spec.ts --project=ts \
    -g "formula compatibility regressions" # from solid/excel
```

Results:

- Focused reference/LAMBDA run: **3 suites / 84 tests passed**.
- Full `excel-core-ts` Jest: **33 suites / 1852 tests passed**.
- Typecheck passed.
- TS worker e2e regression: **1 passed**.

## 18. 2026-06-23 spill #SPILL! unit-test-first closeout

Followed the unit-test-first path for the remaining spill parity item:

- Added failing workbook tests first for:
  - an array formula whose spill target is occupied -> anchor `#SPILL!`;
  - an array formula whose spill extent exceeds sheet bounds -> anchor `#SPILL!`;
  - writing into an already-cached spill range revalidates the anchor to
    `#SPILL!`, and clearing the blocker lets it spill again.
- Initial red run confirmed the old behavior: anchors returned `array` and
  blocker writes did not dirty cached anchors.

Changes landed:

- `evaluateCellTrampolined` now validates final array values against the
  formula anchor's worksheet coordinates. It ignores the anchor itself, treats
  real formula/literal cells as blockers, and leaves format-only blank cells
  non-blocking.
- The evaluator hook can now carry `EvalRuntimeDeps`; array anchors pass their
  current spill range to the workbook.
- Propagation merges runtime spill ranges into the existing dep graph as range
  deps. Writes inside a cached spill range therefore rederive the anchor, and
  clearing the blocker removes `#SPILL!` on the next synchronous rederive.
- Reference-function fixtures that accidentally overlapped their own spilled
  outputs were moved to blank coordinates. `A1048576#` now propagates the
  anchor's `#SPILL!` for an out-of-bounds anchor.

Verification:

```bash
npx jest --runTestsByPath vanilla/excel-core-ts/test/workbook.test.ts \
  --no-coverage --runInBand -t "array formula returns #SPILL|writing into a cached spill range"
npx jest --runTestsByPath \
  vanilla/excel-core-ts/test/workbook.test.ts \
  vanilla/excel-core-ts/test/reference-functions.test.ts \
  vanilla/excel-core-ts/test/scale-suite.test.ts \
  vanilla/excel-core-ts/test/audit-mutation-scaling.test.ts \
  --no-coverage --runInBand
npx tsc -p vanilla/excel-core-ts/tsconfig.json --noEmit
npx jest vanilla/excel-core-ts --no-coverage --runInBand
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  npx playwright test e2e/vnext-worker-ts.spec.ts --project=ts \
    -g "formula compatibility regressions|SEQUENCE spill projects" # from solid/excel
```

Results:

- Focused spill tests passed.
- Related workbook/reference/scale/audit run: **4 suites / 96 tests passed**.
- Full `excel-core-ts` Jest: **33 suites / 1855 tests passed**.
- Typecheck passed.
- TS worker e2e selected run: **2 passed**.
