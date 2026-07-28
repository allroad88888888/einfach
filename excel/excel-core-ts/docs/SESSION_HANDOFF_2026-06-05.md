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

npx jest excel/excel-core-ts --no-coverage 2>&1 | grep "Tests:"
# Expected: 28 suites / 1675 passed

npx jest excel/spreadsheet-ui-core --no-coverage 2>&1 | grep "Tests:"
# Expected: 52 suites / 769 passed

npx jest excel/solid-excel --no-coverage 2>&1 | grep "Tests:"
# Expected: 56 suites / 840 passed

cd excel/rust/excel-core && cargo test --lib 2>&1 | tail -1
# Expected: 1396 passed; 0 failed; 3 ignored

cd ../wasm && cargo test --lib 2>&1 | tail -1
# Expected: 29+ passed; 0 failed
```

If any of these don't match, stop and investigate before proceeding.

## 2. Project context

**einfach** = atom-based state management library (Jotai-inspired). Monorepo. Current focus: **dual excel-core implementations** (Rust/WASM at `excel/rust/excel-core` + `excel/rust/wasm`, TS port at `excel/excel-core-ts`) feeding a Solid spreadsheet UI (`excel/solid-excel/src-vnext`).

Both backends ship and coexist. URL `?backend=ts|wasm` selects at runtime. **Never delete rust/, wasm-pkg/, build:wasm, or wasm-pack toolchain** — user explicitly mandated they stay forever.

## 3. Current state (after the 2026-05-28 → 2026-06-05 arc)

### Function parity

- TS `listBuiltinNames()`: **500**
- Rust `eval_func` top-level dispatch: **500**
- Missing TS names: **0** · Extra TS-only names: **0**

### TS engine (excel/excel-core-ts)

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

### Rust engine (excel/rust/excel-core + excel/rust/wasm)

Ported the same wave. `eval.rs` grew +3487 lines; new `format.rs` (+348). Integration tests added for higher-order arrays, reference lookup, text/info edges, financial extensions.

### Solid/excel adapter

- `worker-runtime-ts.ts` `snapshotPersistenceV1.sizes` payload + row/column dimension Maps with rename/remove propagation — closes the last known TS-only e2e parity gap.
- New TS-port runtime tests for size persistence + custom formulas.

### UI core (excel/spreadsheet-ui-core)

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

## 4. Verification numbers (after the 2026-06-12 audit + fix waves)

| Surface | Suites | Tests | Status |
|---|---:|---:|---|
| Total monorepo jest | 193 | **3734** | ✅ |
| `cargo test --lib + --tests` (excel/rust/excel-core) | — | **1801** + ignored benches | ✅ |
| `cargo test --lib` (excel/rust/wasm) | — | 31 | ✅ |
| `tsc -b` | — | — | ✅ clean |
| e2e (last full dual run) | 515 | **480 / 0 / 37** each | ✅ Δ=0 |
| Mega (1M) bulkWrite | — | WASM **578 ms** / TS ~714 ms | ✅ parity |
| insert_row @500k lazy formulas | — | **130 ms** (was 2.09 s), sheet stays lazy | ✅ |
| setCell @1M cells (TS) | — | **0.004 ms** (was 107.6 ms) | ✅ |
| setCell w/ 100k cached formulas (TS) | — | re-evals == true dependents (was: all) | ✅ |
| full-column clearRange | — | **0.1 ms** (was ≥1.2 s) | ✅ |
| restore_persistence_v1 @100k cells | — | **29.4 ms** (was 67.5, zero eager parse) | ✅ |

### Pattern-family audit + fix waves (2026-06-12)

`excel/rust/excel-core/docs/AUDIT_PATTERN_FAMILY_2026-06-12.md` — 4 parallel
audits hunted the four anti-patterns (eager fan-out / per-item ceremony /
bypassed propagation / incomplete teardown) across both engines:
**9 P1 / 15 P2 / 13 P3** found, with measured repros.

- **Wave 1 (correctness)** — `1414f1b` spill-aware bulk writes + spill
  relocation (Delete over a dynamic array no longer aborts WASM);
  `08c1d86` remove/rename_sheet rebuild + named-ref cross-sheet edge
  resolution (LAMBDA-via-name stale values fixed; define_name now
  rebuilds edges); `a62927d` withBatch throw rolls back registries.
- **Wave 2 (scaling)** — `0ca3a16` lazy retarget: structural edits
  rewrite parked source text token-level instead of hydrating
  (insert_row @500k: 2.09 s → 130 ms, ZERO forced hydrations);
  `d98409c` TS key-granular invalidation: per-formula epoch atoms +
  lazily-built DepGraph (TS mirror of Rust cell_dependents), in-place
  sheet maps + revisionAtom, formula-atom eviction (setCell @1M:
  107.6 ms → 0.004 ms; core/core ZERO diff); `1d71ecf` restores via
  storage-primary install (restore_sparse stays additive-legacy by
  contract evidence); `e507222` sparse clearRange primitive.
- **Codex reviews** caught 3 P1 stale-cache bugs post-Wave-2; fixed in
  `7ed4217` (Rust BFS roots) + `f8e6d8c`/`95ef444` (TS eviction
  wiring + cycle reverse-deps).
- **Wave 3 (P2 hygiene) — CLOSED 2026-06-12**: `f303275` lazy
  primitive-cell atomization (`CellSlot::Plain|Atom`, promotion at
  subscribe/spill; 1M install 512→398 ms, −22%); `ebc7c7a`+`4e7522b`
  adapter hygiene (deleteSheet clears all 5 per-sheet overlay tables;
  sheet ops reset session/probe state; filter/sort permutation cached
  by content-generation; viewport reads O(window ∩ existing); banded
  removeRows RPCs; typed bulkApply wires — '00123' stays text);
  `e9b92c9` static-backend history via reverse deltas (108× → O(change));
  `bdf19a0` replace-all surfaces the 500-match cap; `38e731e` C-3
  batch-guidance docs. Audit arc COMPLETE — all 9 P1 + 15 P2 closed;
  P3s remain catalogued in the audit doc sections.

### Scale test suites — the regression fence (2026-06-13)

`excel/rust/excel-core/docs/SCALE_TEST_SUITE_PLAN.md` (status LANDED, see its
Outcome table). Three commits, each through the full pre-commit sweep:

- `1860701` — `excel/rust/excel-core/tests/scale_suite.rs`: S1–S11, 12
  always-on + 2 `#[ignore]` heavy twins, 2.9 s debug (≤5 s budget);
  read-only `#[doc(hidden)]` counter probes in sheet.rs. cargo
  --lib --tests with suite: **1818/0**.
- `a338b58` — `excel/excel-core-ts/test/scale-suite.test.ts`: S1–S12,
  18 tests, 4.25 s; probe accessors in deps/propagation/sheet/workbook.
  **Plus a real P1 the suite caught before it was committed**: sparse
  whole-column aggregates were O(N² log N) — every uncached cell's
  refLookup threw NeedsDep under the trampoline shim, restarting the
  whole scan (`SUM(A:A)` 1.83 s @2k, ~hours @100k). Fixed in
  `src/eval/evaluate.ts`: literal cells resolve directly from storage;
  formula-cell NeedsDep faults accumulate and rethrow as ONE batch. S3
  pins single-edit→1-re-eval so the bypass can't break invalidation.
- `ced77ca` — `excel/solid-excel/test/scale-parity.test.ts`: P1–P5, one
  seeded ~75k workload through BOTH worker runtimes. **Gated behind
  `EINFACH_SCALE=1`** (deviation from always-on: measured ~4.5 min;
  under coverage it pegged a pre-commit worker 80+ min). Skips in
  0.48 s otherwise. Run before engine-equivalence-sensitive merges.

Codex adversarial review of all three (base `0b65b5b`): **clean** —
first zero-issue round after four rounds that each found real bugs.

A scale-suite failure is a P1 by definition: it means an O(N)
regression or stale-cache bug re-entered.

### P3 close-out + solid-js resolution — audit arc 37/37 (2026-06-13)

The audit's last open items, all landed; the pattern-family arc is now
fully closed (9 P1 + 15 P2 + 13 P3 dispositioned, zero open):

- `712ffbc` / `952da8b` — P3 triage: 6 fixed (A-8 spill reverse index,
  A-9 typed ClearCell, B-5 bulk-notify early-out + S12, D-6 session
  invalidation, D-9 read-tracking Map, D-11 sort hoist), 3 wont-fix,
  3 superseded; table in the audit doc.
- `89dc033` — codex P2 on D-6: `remove_sheet` now remaps wasm
  subscription tokens (mirrors `move_sheet`); real-wasm pin
  `wasm-subscription-remap.test.ts` (verified red pre-fix). NOTE:
  `JsCallbackListener` queues JS callbacks as MICROTASKS — tests must
  flush before asserting fires.
- `4a21dc3` — C-7, owner-approved `core/core` change:
  `store.clear()` also clears `pendingMap`. Defensive — at the current
  public API the stale entries are unobservable (sub() pre-flushes,
  reads cache-first); see the audit doc's honesty note.
- `1b70eff` — follow-ups: `spill_anchor_addr` index
  (`anchor_address_for` O(cells) scan → probe; insert_row @100k+500
  anchors 265–584 ms → ~10 ms) + typed `SetCell`/`SetFormula` ops
  (parse-once at the string boundary; wins are wasm32-allocator-side).
- `6ddc071` — solid-js "1.9.12 Provider interaction" was STALE DOCS:
  root cause = two solid-js copies in one process, already fixed by
  `2b7d65e` (pnpm.overrides). Invariant: ONE `solid-js@` resolution in
  the lockfile, guarded by the two provider-remount contract tests.
  CLAUDE.md rewritten; never work around it in components.
- `fbdddd7` — D-11 residual: conditional-format rules pre-filtered by
  window bounds before the per-cell loop. The window unions display
  rows with the filter/sort source-row band (`originalRow` lives
  outside the display window under permutation) — display range alone
  is NOT a correct superset.

Verification at close: cargo 1819/0 + wasm 31/0, excel/solid-excel jest
59 suites / 882, tsc clean, dual-backend e2e 960/0/74 (Δ=0),
core/core consumers 202/202. Codex review of the P3 wave found
exactly one real P2 (the D-6 token remap above) — fixed same-day.

### Lazy formula indexing — Rust core philosophy realignment (2026-06-11)

einfach is a lazy atom-based state library, but `Sheet::bulk_load`
eagerly parsed every formula, extracted point + range deps, and built
`cell_dependents` / `range_dependents` / `FormulaRecord` at import.
Codex's 2026-06-11 review attributed the Mega-tier 470× gap
(TS 908ms vs WASM 428s) to "eager Rust formula/dependency installation"
— not host chunking, not the 750k cap. The cap was a symptom.

**Result**: 5-phase refactor restoring `bulk_load` to the lazy contract
the runtime already documents. Single-call Ultra (5M cells) now works.

| Phase | Commits | Outcome |
|---|---|---|
| RFC | `d246c53` | Plan doc |
| 1 — instrument + edge-count | `ffe4feb` `5744175` `54d42cd` `5766333` | 500k formulas = 103M point edges, dep_register 58% of flush |
| 2+3 — lazy `bulk_load` + read-path hydrate | `40bc473` | 500k flush 13834→340ms (40×); Mega 428→11.7s (36×) |
| Codex review fixups | `7d0e380` | 2 P1 + 2 P2 + 1 bonus range-dep edge case |
| 5 — Ultra bench + cap removal | `8a2f7f3` `d0eb0da` `3948b27` | 5M single-call works (2.9 GB peak); 750k cap deleted |

The `MAX_BULK_IMPORT_CELLS_PER_CALL = 750_000` constant, the
`check_bulk_import_payload_size` function, and all 4 call sites
(`bulk_import_cells`, `bulk_import_cells_instrumented`, `restore_sparse`,
`restore_persistence_v1`) are gone. Engine self-consistent now:
**lazy build matches lazy eval**.

Phase 1 trace + Ultra measurements live at
`excel/rust/excel-core/docs/MEGA_TRACE_2026-06-11.md` and
`excel/rust/excel-core/docs/CAP_REMOVAL_2026-06-11.md`. Architecture decisions
live at `excel/rust/excel-core/docs/LAZY_FORMULA_INDEXING_PLAN.md`.

### Storage-primary bulk_import — Phase 6 proper (2026-06-11)

After lazy indexing, the residual 9.2× bulkWrite gap traced to
`WorkbookLoader::set_formula` ceremony: 500k per-cell calls each doing
parse + cross-sheet cycle BFS + edge install + a SetFormula op. User
directive set the contract straight: **storage is primary** — sheet state
is a map keyed by cell id (per sheet); bulk init hands the engine
pre-built maps in one call; per-cell set APIs exist only for interactive
edits; reads (atoms) pull from the map and hydrate lazily. Exactly the
TS port's `sheetAtom` model.

| Phase | Commit | Outcome |
|---|---|---|
| RFC | `08025e8` | `STORAGE_PRIMARY_PLAN.md` |
| 6.1 engine | `3c0574a` | `install_sheet_bulk` / `install_workbook_bulk`; full-sheet replace; `!`-prefilter (same-sheet formulas skip parse entirely) |
| 6.2 wire | `5d0ad42` | `bulk_install_workbook` — pair arrays deserialize straight into engine maps |
| bench | `c814b62` | 1M: legacy 8652ms → **771ms**. **WASM bulkWrite at TS parity** (TS=785ms) |
| 6.3 routing | `812fdad` | Fresh-import paths (file import, million-demo) use ONE install call at commit; additive paths (paste-TSV, direct chunks) stay legacy |
| codex P2 fixup | `db6ba64` | install fires cross-sheet dirty fanout (O(edges), subscriber dedup); post-fix bench 578ms |

Legacy `bulk_import_cells` retained as the additive-merge path only — no
longer hot. Final: cargo 1740, jest 3695, playwright wasm 480/0/37.

### Wave 8 + locale infrastructure (2026-06-11)

- **Workbook locale** `9cde891`: `Workbook.setLocale(bcp47)` / `getLocale()`,
  defaults to `'en-US'`. `EvalContext.locale` threaded through cross-sheet
  contexts. TEXT / DOLLAR / FIXED consume via new `_locale.ts` Intl-based
  helpers (number / currency parts). LCID `[$-XXX]` format tags stripped
  silently. `setLocale` invalidates atoms (respects `withBatch`).
- **Wave 8 PNG export**: 7-commit closure of the feature from design
  through e2e.
  - `5e95b93` design doc
  - `84986d9` UI core port + `encodeSelectionAsImage`
  - `c6babae` Solid host PoC (SVG `<foreignObject>` + rasterizer)
  - `d078e9f` `Ctrl+Shift+P` keybind intent + `MAX_EXPORT_PIXELS` cap +
    `'image-too-large'` error variant
  - `d51b5ea` `navigator.clipboard.write` of `ClipboardItem({'image/png': blob})`
    with mirror-only fallback when system clipboard rejects
  - `5ef8482` viewport-projected per-cell sizes
  - `d355961` canvas-direct paint fallback (headless Chromium can't
    decode SVG/foreignObject blobs; `paintCellsToCanvasPng` draws via
    Canvas 2D primitives) + Playwright e2e on both backends
  All 7 design-doc items closed. Backend port `exportRangeAsImage` stays
  OPTIONAL; host wraps via `withHostImageRenderer` when omitted.

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
3. **NEVER delete** `excel/rust/excel-core/`, `excel/rust/wasm/`, `excel/solid-excel/wasm-pkg/`, `build:wasm` script, wasm-pack toolchain — Rust stays as long-term fallback + reference.
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
excel/excel-core-ts/
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

excel/rust/excel-core/src/
├── sheet.rs                             — would_create_cycle reverse BFS, prewarm, batch ops
├── workbook.rs                          — force_formula_recompute scoped, names canonical
├── eval.rs                              — 500-fn dispatch + evaluator-aware paths
├── format.rs                            — custom number-format engine (new)
├── formula.rs                           — Expr types (incl multiArea/lambdaCall)
└── bulk_import_trace.rs                 — instrumented variant for profiling

excel/rust/wasm/src/lib.rs                     — wasm-bindgen boundary + 750k cap

excel/solid-excel/
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

excel/spreadsheet-ui-core/             — framework-agnostic UI atoms + types
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

Reports auto-write to `excel/solid-excel/test/perf-*-report.md`.

## 10. How to run e2e

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  cd excel/solid-excel && \
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
