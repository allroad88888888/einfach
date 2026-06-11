# Phase 5 — `MAX_BULK_IMPORT_CELLS_PER_CALL` removal

*Date: 2026-06-11*
*Branch: `claude/rust-core-state-plan-Auzcj`*
*Scope: Phase 5 of `rust/excel-core/docs/LAZY_FORMULA_INDEXING_PLAN.md`.*

## TL;DR

After Phase 2/3 (commits `40bc473` and `7d0e380`) made
`Workbook::bulk_load` purely lazy — it now stores only formula source text and
defers parse + dep-graph install to first read — the WASM linear-memory
allocator pressure that motivated the original 750k cap has disappeared.

Single-call `bulk_import_cells` payloads of **5 000 000 cells** complete
cleanly. Peak RSS at 5M cells is ~2.9 GB (well under the 4 GB WASM linear-memory
ceiling). The cap is removed in this phase.

## Method

- Temporarily raised `MAX_BULK_IMPORT_CELLS_PER_CALL` to `10_000_000` in
  `rust/wasm/src/lib.rs`.
- Built wasm-pkg via `npm --prefix solid/excel run build:wasm`.
- Added `solid/excel/test/perf-rust-bulk-import-ultra.bench.ts`. Each tier:
  1. Builds an `ImportCellWire[]` of `seeds + formulas` (mix matches the
     existing `perf-rust-bulk-import-trace.bench.ts` Mega shape — 50%
     `=A+B` point refs, 30% `=IF(A>10,A*2,0)`, 20% `=SUM(A1:An)` ranges
     capped at 1024).
  2. Calls `wb.bulk_import_cells(cells)` **once** (production path).
  3. Measures wall-clock + RSS.
  4. Runs three post-import sanity calls — `get_display(0,'A1')`,
     `set_formula(0,'Z1','=1+1')`, `get_display(0,'Z1')` (forces eval to
     `'2'`). If the `WasmRefCell` had been poisoned the way the old eager
     path used to poison it, any of these three would have thrown the
     `"attempted to take ownership of Rust value while it was borrowed"`
     error.
- Bench harness invocation:
  ```
  EINFACH_PERF=1 NODE_OPTIONS="--max-old-space-size=24576 --expose-gc" \
    npx jest --testMatch="**/perf-rust-bulk-import-ultra.bench.ts" \
    --no-coverage --testTimeout=1800000
  ```

All four tiers ran in **one** node process; rerunning each tier in its own
process (separate `npx jest` invocations) gave identical wall times so the
shared-process numbers are reported below.

## Results

Single `bulk_import_cells` call, fresh `WasmWorkbook` per tier:

| Tier | cells     | seeds   | formulas | import wall (ms) | peak RSS (MB) | post-import read / mutate / recalc |
|------|-----------|---------|----------|------------------|---------------|------------------------------------|
| 1M   | 1 000 000 |   500 k |   500 k  |          10 111  |           946 | ok / ok / ok                       |
| 2M   | 2 000 000 |   1.0M  |   1.0M   |          17 802  |         1 424 | ok / ok / ok                       |
| 3M   | 3 000 000 |   1.5M  |   1.5M   |          32 259  |         2 029 | ok / ok / ok                       |
| 5M   | 5 000 000 |   2.5M  |   2.5M   |          54 590  |         2 894 | ok / ok / ok                       |

- Wall-clock scales roughly linearly with cell count
  (10 / 18 / 32 / 55 ms per 1M cells implies ~10-11 µs / cell — most of which is
  `serde_wasm_bindgen::from_value` deserialize on the WASM side, not engine
  work).
- Peak RSS is dominated by the JS-side `ImportCell[]` (each entry ~80-120 bytes
  in V8) plus the wasm-pkg `Vec<WorkbookImportCellJSON>`. The lazy `bulk_load`
  itself adds only `formula_source` (`Rc<str>` per formula) and a
  `HashSet<CellAddress>` (`needs_parse`).
- All twelve post-import sanity calls (4 tiers × 3 calls) returned without
  throwing — the workbook stays usable after a 5M-cell import.

## Comparison to the old eager path

| Path                                    | 1M cells | 5M cells |
|-----------------------------------------|----------|----------|
| Eager (pre-Phase 2)                     | panic    | panic    |
| Lazy (Phase 3 onward, this measurement) |   10 s   |   55 s   |

The old eager path panicked the linear-memory allocator at ~1M formula
records because per-formula `FormulaRecord` + `cell_dependents` +
`range_dependents` allocations consumed the 4 GB WASM heap. The new path
holds only the source text, so allocator pressure scales as O(total
formula source bytes) instead of O(formula count × AST + dep-graph
edges).

## Decision

**Removed** the cap entirely:

- `MAX_BULK_IMPORT_CELLS_PER_CALL` constant — deleted.
- `check_bulk_import_payload_size` function — deleted.
- 4 call-sites — removed (`bulk_import_cells`, `bulk_import_cells_instrumented`,
  `restore_sparse`, `restore_persistence_v1`).
- 2 wasm-bindgen-test cases (`wasm_workbook_bulk_import_cells_refuses_oversized_payload`
  + the `_accepts_under_cap_payload` companion) — removed since they assert
  cap behavior that no longer exists.

No new evidence-backed cap was introduced. The next constraint is the WASM
linear-memory ceiling (~4 GB after wasm-bindgen overhead), which is a
platform limit, not a contract limit. Hosts that hit it will see a clean
allocator failure from the WASM runtime rather than the cryptic borrow
error chain we used to guard against — the lazy bulk_load no longer leaves
the `WasmRefCell` in a borrowed state when allocation fails.

## What the doc comment on the original constant said vs reality

The doc claimed:

> Ultra (1M seeds + 1M formulas, two calls of 1M each) reliably panics on
> the formula-install pass.

Confirmed in the pre-Phase-2 era. After Phase 2/3, single-call 1M, 2M, 3M,
and 5M all succeed. The cap was a symptom; Phase 2/3 fixed the disease.

## Follow-up

- The bench file `solid/excel/test/perf-rust-bulk-import-ultra.bench.ts`
  is kept so a future regression in `bulk_load` allocator pressure shows up
  as a tier failing.
- The bench is gated on `EINFACH_PERF=1` and adds ~2 minutes of wall-clock
  when enabled — same gating as the existing perf benches.

## Commit chain (in order)

1. `bench(rust): Ultra (1M+) tier through bulk_import_cells in a single call`
2. `feat(rust): remove MAX_BULK_IMPORT_CELLS_PER_CALL cap — lazy bulk_load makes it unnecessary`
3. `docs(rust): CAP_REMOVAL_2026-06-11.md — Ultra tier measurements`
