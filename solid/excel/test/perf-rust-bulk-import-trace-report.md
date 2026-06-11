# Rust bulk-import phase-decomposition

*Last run: 2026-06-11T04:51:00.950Z*

## Per-tier phase breakdown

| Tier | total cells | JS wall (ms) | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 100000 | 801 | 83.0 | 23.0 | 9.0 | 623 | 57.0 | 689 | 28.6 |
| 250k | 250000 | 2015 | 202 | 59.0 | 23.0 | 1556 | 163 | 1742 | 70.5 |
| 500k | 500000 | 4111 | 407 | 117 | 46.0 | 3180 | 340 | 3566 | 138 |

## Phase share (% of JS wall)

| Tier | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 10.4% | 2.9% | 1.1% | 77.8% | 7.1% | 86.1% | 3.6% |
| 250k | 10.0% | 2.9% | 1.1% | 77.2% | 8.1% | 86.5% | 3.5% |
| 500k | 9.9% | 2.8% | 1.1% | 77.3% | 8.3% | 86.7% | 3.4% |

## Super-linearity (ratio of `500k` to `100k` phase ms)

Cell-count ratio = 5.00×. A linear phase grows at the same ratio; >cellRatio = super-linear.

| Phase | 100k (ms) | 500k (ms) | Ratio | Verdict |
| --- | --- | --- | --- | --- |
| deserialize | 83.0 | 407 | 4.90× | linear-ish |
| parse-only | 23.0 | 117 | 5.09× | linear-ish |
| set_cell loop | 9.0 | 46.0 | 5.11× | linear-ish |
| set_formula loop | 623 | 3180 | 5.10× | linear-ish |
| flush | 57.0 | 340 | 5.96× | linear-ish |
| engine total | 689 | 3566 | 5.18× | linear-ish |
| JS wall | 801 | 4111 | 5.14× | linear-ish |

## flush_ms sub-phase decomposition (Phase 1A)

| Tier | flush total | parse | dep_extract | dep_register | formula_record | sub-phase sum | residual (BFS + notify) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 57.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 57.0 |
| 250k | 163 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 163 |
| 500k | 340 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 340 |

## flush_ms sub-phase share (% of flush_ms)

| Tier | parse | dep_extract | dep_register | formula_record | residual |
| --- | --- | --- | --- | --- | --- |
| 100k | 0.0% | 0.0% | 0.0% | 0.0% | 100.0% |
| 250k | 0.0% | 0.0% | 0.0% | 0.0% | 100.0% |
| 500k | 0.0% | 0.0% | 0.0% | 0.0% | 100.0% |

## Dep-graph stats after import (Phase 1B)

| Tier | formulas | point_dep_edges | range_dep_entries | range_formula_count | max_fanout | avg_fanout |
| --- | --- | --- | --- | --- | --- | --- |
| Mega | 0 | 0 | 0 | 0 | 0 | 0.00 |
| 100k | 0 | 0 | 0 | 0 | 0 | 0.00 |
| 250k | 0 | 0 | 0 | 0 | 0 | 0.00 |
| 500k | 0 | 0 | 0 | 0 | 0 | 0.00 |

## Notes

- `deserialize` is `serde_wasm_bindgen::from_value` (JS → Rust).
- `parse-only` is an ISOLATED parse pass run before the engine — same parser, AST discarded.
- `set_cell loop` writes primitives only (no parsing).
- `set_formula loop` writes formulas only — INCLUDES the engine re-running the parser, cycle check, and dep wiring.
- `flush` = `engineTotal − (set_cell + set_formula)`. This is `WorkbookLoader::flush` + per-sheet `BulkLoader::flush`.
- `unaccounted` = `jsWall − (deserialize + engineTotal)`. Approximates wasm-bindgen boundary + JS-side V8 work building the input array.
- Write order in the instrumented variant differs from production (primitives first, then formulas). For the disjoint-column workload here it does not affect engine cost.

### Sub-phase split (Phase 1A — lazy-formula-indexing)

- `parse` is the formula-source → AST share (≈ 0 for the bulk path — workbook side pre-parses; only the parse-failure arm runs here).
- `dep_extract` is `formula_deps_for` + `collect_range_refs` — AST walk only.
- `dep_register` is `cell_dependents.insert` + `range_dependents.insert`. Codex flagged this as the dominant Mega-tier cost.
- `formula_record` is `Rc<FormulaRecord>::new` + the 3 map inserts (`formula_cells` / `formula_exprs` / `formula_texts`).
- `residual` = `flush − (parse + dep_extract + dep_register + formula_record)`. Includes BFS dirty propagation + subscriber notify dedup + cross-sheet BFS.
