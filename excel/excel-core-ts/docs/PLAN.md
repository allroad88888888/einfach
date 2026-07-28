# Excel Core (TS) — Port Plan

> **Status**: planning draft, no code yet.
> **Owner**: TBD. **Target package**: `@einfach/excel-core` (final name TBD — see Open Decisions §1).

## 1. Goal

Replace `excel/rust/excel-core` with a TypeScript implementation that runs in the **same web worker** as today, exposed through the **same `SpreadsheetBackend` port**. UI, demos, and e2e suites must not need to change.

The reactive layer (cell dependency tracking, invalidation, recompute scheduling) is delegated to `@einfach/core` (`core/core`). The new package is essentially a **formula parser + evaluator + workbook state**; the dep graph is not reinvented.

## 2. Why

What the TS backend gives us **in addition to** the Rust backend (both stay; user toggles via `?backend=` URL flag):

- **Iteration speed.** No `cargo build` + `wasm-pack` cycle. Hot-reload in vite is instant.
- **AI / agent friendliness.** Rust files like `eval.rs` (~38k lines) are heavy on context budget; TS function bodies are easier for a model to edit, and the type system is closer to the rest of the repo.
- **Stack traces.** Errors crossing `postMessage` today surface as wasm panic strings. TS throws keep filenames + line numbers all the way up.
- **Reactive layer unified at the UI side.** The TS path delegates dep tracking to `@einfach/core`, the same atom engine the UI already uses. The Rust path still owns its own internal dep graph in `sheet.rs` — that's fine, but on the TS side we get a single reactive model end-to-end.
- **Custom formulas land naturally on TS.** The Wave 8.1 re-entrancy guard exists because Rust can't safely call a JS host that may call back. In TS, host=core; the guard collapses to a normal evaluator-side `currentlyEvaluating` set.

What the Rust backend keeps doing better — and why we **don't** remove it:

- ~~**Throughput on large recalc storms.** Rust eval is ~3–10× faster per call than JIT'd TS. For 100k+ formula recalc the Rust path is the right choice.~~ **REVISED 2026-05-27 — the perf bench (`excel/solid-excel/test/perf-ts-vs-wasm-report.md`) shows TS is *faster* than WASM at every measured workload (Tiny / Medium / Large, all 4 phases), ratio 0.01–1.05×. The TS broad-invalidation model (one sheetAtom per sheet) skips the per-cell dep-graph maintenance Rust performs at bulk-install time, and the wasm-bindgen string-marshalling per RPC eats the per-call advantage on read paths. The original 3-10× estimate did NOT survive contact with the bench. Rust still wins on memory layout for true 1M-cell sheets — not validated by the bench (Large = 100k cells / 50k formulas).**
- **Memory layout discipline.** Contiguous numeric buffers, no boxed numbers. Matters at the 1M-cell scale we did not benchmark.
- **Coverage maturity.** 400-function evaluator hardened by years of fixture tests; TS at 82 functions.
- **Reference implementation.** When the TS engine produces an unexpected result, diffing against the Rust output isolates whether it's a porting bug or a shared misreading of Excel semantics.

The two paths coexist permanently. `?backend=ts` is the developer-default; `?backend=wasm` is the perf / parity-check default.

## 3. Non-Goals (any phase)

- Replace the worker boundary. Worker stays.
- Change UI atom topology. `vnext` UI atoms are untouched.
- Ship a new xlsx I/O layer. Import / export ports stay TBD or stub.
- Match every one of the 400+ functions in `eval.rs` on day one. See §6 for v1 function set.
- Replace the existing `static-backend.ts` (which is the static-data demo backend, not formula-capable). The new core sits behind the **worker** backend, like the WASM one does today.
- **Retire the Rust backend.** `excel/rust/excel-core/`, `excel/rust/wasm/`, `excel/solid-excel/wasm-pkg/`, `build:wasm` and the wasm-pack toolchain step all stay. The TS core is **additive**.

## 4. Architectural decisions

These come out of the discussion that preceded this doc. Recorded here so future-us doesn't re-derive them.

### 4.1 One `sheetAtom` per sheet (broad invalidation)

A single primitive atom per sheet, holding `Map<CellKey, Cell>`. Every cell mutation = `set(sheetAtom, newMap)`. Every formula derive depends on `sheetAtom` (one broad dep).

When a cell changes:

- `core/core` marks every formula derive dirty (cheap — just walks `backDependenciesMap`).
- Only formulas that are **`sub`'d** (visible window, dependent of another visible formula, etc.) actually recompute.
- Off-screen formulas stay dirty until something reads them. No 1M-row recompute storm.

This avoids the range-dep problem (`=SUM(A:A)` doesn't know about a new A50): every cell write bumps `sheetAtom`, so every range formula naturally re-runs next time it's read.

### 4.2 Per-cell atoms are **not** used

Tempting but wrong. Per-cell atoms would give finer invalidation but:

- New cells outside the current dep set wouldn't trigger range refs (`SUM(A:A)`).
- Would require an extra range-dep index — exactly the kind of complexity §4.1 sidesteps.

### 4.3 Formula atoms are derived

```ts
const formulaAtom = (key: CellKey) =>
  atom((get) => {
    const sheet = get(sheetAtom)
    const cell = sheet.get(key)
    if (!cell?.formula) return cell?.value
    return evaluate(cell.formula, (ref) => sheet.get(ref)?.value)
  })
```

The `evaluate` closure is pure: AST walk + table-lookup of built-ins + recursive ref resolution. No I/O, no side effects.

### 4.4 Volatile functions (`NOW`, `RAND`, `TODAY`) — manual F9

A workbook-level `recalc()` call bumps `sheetAtom` to a fresh `Map` reference (same contents, new identity). All derives invalidate; volatile values come out fresh from inside `evaluate`. No special "volatility" flag needed.

For live `NOW()` (rare in spreadsheets), a `setInterval` driving `recalc()` is opt-in.

### 4.5 Cycle detection lives in the evaluator, not in core/core

`core/core` has no built-in cycle guard; re-entrant `get` on an atom mid-derive will stack-overflow. The evaluator wraps recursion with a `currentlyEvaluating: Set<CellKey>` and returns `#CIRCULAR!` on re-entry. ~30 lines.

### 4.6 Spill is a renderer concern, not a data concern

When a formula evaluates to `Value::Array`, the anchor cell's stored value IS the 2D array. Target cells (offset != [0, 0]) are not separate atoms — the grid renderer indexes into the anchor's array at projection time. Far simpler than Rust's "derived spill atom per target" pattern. WASM-boundary array collapsing also goes away (no boundary).

### 4.7 Custom formulas: host functions live in-process

No re-entrancy guard, no source-string evaluation via `new Function`, no Wave 8.1 worker-side trust boundary. Registered callbacks are plain JS closures. The evaluator's `currentlyEvaluating` set already protects against custom-formula re-entry on the same cell.

The `registerCustomFormulaAtom` host API in `excel/spreadsheet-ui-core` stays unchanged — only the worker-side implementation changes.

## 5. Package layout

```
excel/excel-core-ts/                         ← @einfach/excel-core (final name TBD)
  src/
    workbook.ts        — Workbook = { sheets: Map<id, SheetAtom>, names, ... }
    sheet.ts           — sheetAtom factory + CellKey helpers
    parser/
      tokenizer.ts     — Excel formula lexer (refs, ranges, ops, fn calls, strings)
      ast.ts           — Expr discriminated union
      parser.ts        — Pratt parser for operator precedence
    eval/
      evaluate.ts      — top-level dispatcher (ref → cell, call → fn)
      coerce.ts        — Value ↔ number/string/bool/error coercion
      functions/
        math.ts        — SUM, AVERAGE, ROUND, ...
        logical.ts     — IF, AND, OR, IFS, ...
        lookup.ts      — VLOOKUP, INDEX, MATCH, XLOOKUP, ...
        text.ts        — CONCAT, LEFT, MID, TEXT, ...
        date.ts        — TODAY, NOW, DATE, YEAR, ...
        stats.ts       — COUNTIF, SUMIF, COUNTIFS, ...
        index.ts       — name → impl table
    refs/
      a1.ts            — A1 ↔ (row, col); $A$1 absolute parsing
      ranges.ts        — A1:B10 normalization, intersection, expansion
      crossSheet.ts    — Sheet2!A1 resolution
    names.ts           — named ranges, LAMBDA scope
    custom.ts          — registry + dispatch for host-registered formulas
    errors.ts          — #VALUE!, #REF!, #DIV/0!, #N/A, #NAME?, #CIRCULAR!, ...
    volatile.ts        — recalc tick helper
    index.ts           — public re-exports
  test/
    parser.test.ts
    evaluate.test.ts
    workbook.test.ts
    cross-sheet.test.ts
  docs/
    PLAN.md            ← this file
    ARCHITECTURE.md    ← detailed design (sibling doc)
  package.json
  tsconfig.json
```

The worker (`excel/solid-excel/src-vnext/adapter/worker-runtime.ts` and friends) imports `@einfach/excel-core` directly. The `SpreadsheetBackend` shim that converts port requests into `workbook.setCell` / `workbook.readProjection` lives in the **adapter layer** (`excel/solid-excel/src-vnext/adapter/`), not inside the core package — the core stays framework-agnostic.

## 6. Phases

Phases are ordered for **shippable-at-the-end-of-each** delivery — every phase leaves main green with the new core covering more ground.

| Phase | Deliverable | Approx LOC | Acceptance |
|---|---|---|---|
| 0 | Package skeleton + workspace wiring + jest config | < 500 | `npm test` runs an empty suite green |
| 1 | Tokenizer + AST + Pratt parser | ~2k | Parses every formula in `excel/rust/excel-core/tests/parser.rs` fixtures |
| 2 | Workbook + sheetAtom + minimal evaluator (arithmetic only: `=1+2`, `=A1*B2`) | ~1.5k | jest covers 50+ scalar-arithmetic fixtures |
| 3 | v1 function set (~40 functions) | ~5k | See §6.1 — passes a curated subset of `excel/rust/excel-core/tests/` |
| 4 | Worker shim implementing `SpreadsheetBackend` (subset: readProjection, setCell, setFormula) | ~800 | New demo (`vNextWorkerTSDemo`) renders alongside the wasm one, opt-in via URL param |
| 5 | Spill arrays + range refs (`SUM(A:A)`, `INDEX(arr, n)`) | ~1k | TRANSPOSE, SEQUENCE, SUMPRODUCT pass |
| 6 | Cross-sheet refs + named ranges | ~800 | All e2e specs that exercise `Sheet2!A1` pass on the TS worker |
| 7 | Custom formulas port (host callbacks) | ~400 | `custom-formulas.spec.ts` passes against the TS worker |
| 8 | Function fill-out: target 200 functions (matches typical "office-grade" coverage) | ~10k | Curated e2e + jest |
| 9 | TS worker reachable via `?backend=ts` on `VNextWorkerDemo`; WASM stays default. Probe parity + dual-project e2e shipped (2026-05-27). | — | DONE |

> **Phase 9 — landed 2026-05-27.** Did both unblock paths from the earlier blocked draft:
> - (a) `Workbook.debugFormulaCacheState` / `EvalCount` / `Count` implemented in `excel/excel-core-ts/src/{sheet,workbook}.ts`; wired through `worker-runtime-ts.ts`. Probe state machine = per-cell `lastEvalRevision` vs workbook-scope `revisionCounter`. Verified by 22 jest cases in `excel/solid-excel/test/excel-core-ts-debug-probes.test.ts`.
> - (b) Dual-project Playwright: `wasm` / `ts` projects in `playwright.config.ts` map to `?backend=wasm` / `?backend=ts` baseURLs. `helpers.ts` `gotoRoot` preserves the project query through nav. `BACKEND_PARITY.md` is the live matrix.
>
> Codex caught one more issue post-implementation: vite was resolving `@einfach/excel-core-ts` to the published `esm/` build, which lagged source and was missing the new probe methods. Fix: alias `@einfach/excel-core-ts` → `excel/excel-core-ts/src` in `excel/solid-excel/vite.config.ts` (mirrors how `@einfach/spreadsheet-ui-core` is already aliased). Worker bundle now ships fresh source.
>
> The earlier "flip default to TS" framing was abandoned — with dual-project e2e, the default no longer matters functionally. WASM stays default; TS reachable via `?backend=ts`. Both backends coexist per §3.

> **Note** — earlier drafts of this plan included a Phase 10 "excel/rust/excel-core archived" step. That step has been **removed**: the Rust core is a long-term asset (perf headroom for million-row recalc storms, mature 400-function evaluator, hardened against malformed input). Phase 9 is the terminal phase — both backends coexist permanently, and either can be promoted to default per `?backend=` URL toggle / config. If the TS path ever hits a performance wall the Rust path is the fallback.

Phases 0–4 are the minimum for "we have a TS core that can render a non-trivial sheet." Phases 5–7 close functional parity. Phases 8–9 are the cutover.

### 6.1 v1 function set (Phase 3)

Top-40 by Excel usage. The line between "v1" and "v2" is: if `demo-sales`, `demo-grades`, `demo-budget` all render correctly, v1 is done.

```
Math:    SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN,
         INT, MOD, ABS, POWER, SQRT, SIGN
Logical: IF, IFERROR, IFNA, AND, OR, NOT, IFS, SWITCH, TRUE, FALSE
Lookup:  VLOOKUP, HLOOKUP, INDEX, MATCH, XLOOKUP
Text:    CONCATENATE, CONCAT, LEFT, RIGHT, MID, LEN, LOWER, UPPER, TRIM,
         TEXT, VALUE
Date:    TODAY, NOW
Stats:   COUNTIF, SUMIF, COUNTIFS, SUMIFS
```

The function table is data-driven (`Map<string, FunctionImpl>`), so adding more is mechanical, not architectural.

## 7. Risks

- **Throughput on big recalc** — see §2. Mitigation: profile early on `demo-budget` (1k formulas) and `million-demo` (1M cells, mostly empty). If unacceptable, batch-evaluate with a workerized SAB before considering rust resurrection.
- **Float precision drift** — JS Number ≠ Rust f64 in some edge cases (NaN payloads, denormals, integer/float coercion). Mitigation: pin precision tests to the Rust eval outputs and diff.
- **Date arithmetic edge cases** — 1900 leap-year quirk, 1904 epoch toggle. Mitigation: port `eval.rs` date helpers byte-for-byte; add comparison tests vs. Rust on Phase 3 entry.
- **Parser parity** — Excel's formula grammar has corner cases (implicit intersection `@`, structured table refs `Table[col]`). Mitigation: scope explicitly — v1 covers A1, named ranges, range ops, cross-sheet, no `@`/no structured refs. Document in `PARSER_LIMITS.md`.
- **Custom formula contract drift** — UI host API stays, but worker-side semantics change subtly (no postMessage = synchronous call). Mitigation: keep `CUSTOM_FORMULAS.md` updated as the contract spec, run `custom-formulas.spec.ts` end-to-end on the TS worker before Phase 9.

## 8. Out of scope (explicit)

- Replacing the worker. Worker stays.
- Replacing `excel/spreadsheet-ui-core`. Untouched.
- Replacing UI atoms. Untouched.
- xlsx import/export. Not in v1.
- Pivot tables, charts, conditional-format custom expressions beyond what `excel/rust/excel-core` already exposes.

## 9. Open decisions (block start)

These must be answered before Phase 0:

1. **Package name.** `@einfach/excel-core` (collides with Rust crate name `einfach-excel-core`; needs Rust rename) **vs** `@einfach/excel-core-ts` (explicit, no rename). I lean toward the second — clearer for the cutover window, and renaming the Rust crate later is mechanical.
2. **Replacement strategy.** Two options:
   - **Hard cutover at Phase 9.** Less maintenance overhead, but binary risk window.
   - **Side-by-side with `?backend=ts` opt-in (recommended).** Both workers live in `excel/solid-excel`; user toggles via URL or settings. Lets us soak-test against real demos before cutover.
3. **Custom formula source-string vs closure.** Wave 8.1 stores formulas as **strings** to survive `postMessage`. In a TS-only worker we no longer need string serialization — host can pass a real closure. Do we keep the string contract for backward compat or simplify? Recommend: keep string for the host-registration atom contract (UI side), unwrap to closure at the worker boundary inside the TS core. Zero UI changes.
4. **xlsx I/O.** Not in scope for v1, but the contract has to be stable enough that a v2 importer can call into the core. Recommend: defer; revisit after Phase 6.
5. **Should the new package ship to npm?** Not until after Phase 9 soak — internal package only, no externally-stable surface yet.

## 10. Success criteria for "done with the port"

- All e2e suites in `excel/solid-excel/e2e/` pass against the TS worker.
- All jest suites under `excel/solid-excel/test/` pass.
- `million-demo` renders within 2× the wasm-backed time.
- `demo-budget`, `demo-grades`, `demo-sales` are visually and behaviorally identical.
- `?backend=ts` is the default URL state for vnext demos; `?backend=wasm` is still reachable and rendering the same demos correctly.

**Explicit non-goal**: removing `excel/rust/excel-core/`, `excel/rust/wasm/`, `excel/solid-excel/wasm-pkg/`, the `build:wasm` script, or the wasm-pack toolchain step. All of these stay — the Rust path is the permanent fallback for perf-sensitive scenarios and the reference implementation against which TS-core diffs are diagnosed.

## 11. What this plan deliberately does **not** answer

- Estimated calendar time. Phases 0–4 are ~3–4 weeks of focused work for one engineer; phases 5–8 add another 2–3 months. But the user (whoever picks this up) sets pace; the plan is structured so each phase is independently shippable.
- Specific test fixture migration. Most `excel/rust/excel-core/tests/*.rs` fixtures translate mechanically; the harness migration is its own Phase-0.5 task.
- Performance benchmarks. Define after Phase 4 once we have a worker shim to measure.
