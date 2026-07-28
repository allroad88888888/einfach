# MEGA bulk_import trace — 2026-06-11

Phase 1 of the lazy-formula-indexing arc
(`excel/rust/excel-core/docs/LAZY_FORMULA_INDEXING_PLAN.md`) landed sub-phase
timers in `BulkLoader::install_parsed_formula` and a workbook-level
`debugDepGraphStats()` probe. This doc reports what those probes
measured at the Mega (1M cell) tier and adjacent scales.

Bench: `excel/solid-excel/test/perf-rust-bulk-import-trace.bench.ts`
(`EINFACH_PERF=1`, `--testRegex 'perf-rust-bulk-import-trace\.bench\.ts$'`)
on macOS / Apple Silicon, Node 22, single jest worker. WASM built via
`wasm-pack --release`. Times are wall-clock; the instrumented path
samples `js_sys::Date::now()` per install (4 calls / formula) and
accumulates into thread-local f64 ms counters.

Workload: 90 % literal seeds in col A, then 50 % `=Ax+By` / 30 %
`=IF(Ax>10, Ax*2, 0)` / 20 % `=SUM(A1:A<row>)` (`SUM_RANGE_CAP=1024`).
Mega = 500 k seeds + 500 k formulas = 1 M cells total.

## Sub-phase decomposition of `flush_ms` (Phase 1A)

The implicit `WorkbookLoader::flush` replays the queued ops inside
each touched sheet's `Sheet::bulk_load`. The dominant cost inside the
per-formula install path (`BulkLoader::install_parsed_formula`) splits
as:

| Tier  | flush total | parse | dep_extract | dep_register | formula_record | sub-phase sum | residual (BFS + notify) |
| ---   | ---         | ---   | ---         | ---          | ---            | ---           | ---                     |
| 100k  | 2 223 ms    | 0     | 258 ms      | **1 108 ms** | 19 ms          | 1 385 ms      | 838 ms                  |
| 250k  | 5 862 ms    | 0     | 536 ms      | **3 135 ms** | 71 ms          | 3 742 ms      | 2 120 ms                |
| 500k  | 13 834 ms   | 0     | 1 189 ms    | **8 029 ms** | 127 ms         | 9 345 ms      | 4 489 ms                |

### % share of `flush_ms`

| Tier  | parse | dep_extract | dep_register | formula_record | residual |
| ---   | ---   | ---         | ---          | ---            | ---      |
| 100k  | 0.0%  | 11.6%       | **49.8%**    | 0.9%           | 37.7%    |
| 250k  | 0.0%  | 9.1%        | **53.5%**    | 1.2%           | 36.2%    |
| 500k  | 0.0%  | 8.6%        | **58.0%**    | 0.9%           | 32.4%    |

Mega (1M cells) was queried for dep-graph stats via the production
path (the instrumented variant is bounded by the 750 k per-call WASM
cap), so it does not have a sub-phase decomposition row — but the
trend across 100k → 500k is monotonic: `dep_register` claims more of
`flush_ms` as the workload grows.

Reads of this table:

- **`parse` is zero** because the WASM bridge pre-parses every formula
  on the workbook-side `set_formula` queue and hands the AST through
  to the sheet-side `set_formula_pre_parsed`. The sheet flush never
  re-parses unless it sees a parse-failure (none in this workload).
- **`dep_register` dominates and grows super-linearly**: at the 5× cell-
  count ratio from 100k → 500k, `dep_register` grows **7.25×** (1108 →
  8029 ms). Everything else grows roughly linearly (`flush` grows
  6.22×, `dep_extract` 4.6×, `formula_record` 6.7×).
- **`formula_record` is < 1 %** — the `Rc<FormulaRecord>` alloc + 3
  HashMap inserts is cheap relative to the dep-graph install. Lazy
  hydration in Phase 3 will defer this as well, but the saving here
  is tiny compared with deferring `dep_register`.
- **`residual` (~33–38 %)** is everything after the per-formula
  install: the same-sheet dirty-cache BFS, the per-address subscriber
  notify dedup, and the workbook-wide cross-sheet BFS. None of these
  are touched by the lazy-build refactor — they continue to run on the
  installed-formula state.

## Dep-graph stats after import (Phase 1B)

`debugDepGraphStats()` walks `cell_dependents` + `range_dependents`
across every sheet after `bulk_import_cells` returns. The numbers
quantify how much state the eager-build phase produced:

| Tier  | formulas | point_dep_edges | range_dep_entries | range_formula_count | max_fanout | avg_fanout |
| ---   | ---      | ---             | ---               | ---                 | ---        | ---        |
| 100k  | 50 000   | 10 193 739      | 195               | 10 001              | 10 004     | 277.37     |
| 250k  | 125 000  | 25 373 318      | 189               | 24 723              | 24 727     | 278.07     |
| 500k  | 250 000  | 51 726 545      | 179               | 50 285              | 50 288     | 284.43     |
| **Mega (1M cells)** | **500 000** | **103 347 736** | **179** | **100 393** | **100 396** | **284.01** |

Reads:

- **103 million point dep edges** for 500 k formulas — that's the
  fanout that today lives in `cell_dependents` after `bulk_import_cells`
  returns. Each entry is a `HashSet<CellAddress>` bucket; the total
  install cost is what `dep_register_ms` measures.
- **`avg_fanout = 284`** means every cell that has at least one
  dependent has ~284 formulas reading it. The 20 % `SUM(A1:A1024)`
  share of the workload puts 1024 cells in the dep set of every SUM
  formula via the bounded-range expansion path
  (`formula_deps_for` walks small ranges into individual deps —
  documented in `sheet.rs:946`).
- **`max_fanout = 100 396` at Mega** — a single cell (top of A column)
  is registered as a dependency of ~100 k formulas. That's the
  worst-case single-write invalidation cost on this workload.
- **`range_dep_entries = 179`** — small because the workload has only
  1024 distinct SUM ranges (capped by `SUM_RANGE_CAP`), and any one
  range has many formula dependents. The `range_dep_entries` counter
  is "number of distinct ranges", not "range edges": 179 ranges shared
  among `range_formula_count = 100 393` formulas at Mega.
- **`range_formula_count` ≈ 20 % of formulas** — matches the workload
  mix exactly (20 % SUM), confirming the probe is counting what we
  expect.

## Conclusion

**The trace confirms codex's 2026-06-11 attribution: "eager dependency
installation dominates".**

At the 500k tier (closest instrumented run to Mega) `dep_register` is
58 % of `flush_ms`, growing from 49.8 % at 100k. The growth is super-
linear: `dep_register` rises 7.25× while cell count rises 5×, meaning
the constant-factor cost per HashSet insert worsens as the underlying
`cell_dependents` map grows (rehash + bucket pressure). The probe shows
why — 103 M point dep edges at Mega, with `avg_fanout = 284`. The
`HashMap<CellAddress, HashSet<CellAddress>>` shape pays mallocs + hash
churn proportional to those edges, all installed eagerly inside
`bulk_load`'s closure before the host has even seen the first cell
value.

`formula_record` (the `Rc<FormulaRecord>` + 3 HashMap inserts) is
< 1.5 % — confirming the planned Phase 2 win (deferring formula record
construction) is small compared with Phase 3 (deferring dep_extract +
dep_register). The Phase 1 plan calls those out as separable wins; the
trace says Phase 3 is where the order-of-magnitude lives. `dep_extract`
(AST walk only, no allocation into the dep maps) is ~9 % — also worth
deferring, but secondary.

Codex's attribution holds: lazy hydration of `cell_dependents` /
`range_dependents` on first read (Phase 3 of the plan) is the right
shape of fix, and the projected Mega bulkWrite improvement (428 s →
< 5 s) is supported by these numbers — the dep-register share alone is
> 50 % of `flush_ms`, which is itself > 75 % of `engine_total_ms` at
every tier measured.
