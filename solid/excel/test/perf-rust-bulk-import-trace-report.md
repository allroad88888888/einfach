# Rust bulk-import phase-decomposition

*Last run: 2026-06-11T04:15:17.895Z*

## Per-tier phase breakdown

| Tier | total cells | JS wall (ms) | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 100000 | 3006 | 87.0 | 24.0 | 9.0 | 658 | 2223 | 2890 | 29.5 |
| 250k | 250000 | 7809 | 217 | 60.0 | 24.0 | 1636 | 5862 | 7522 | 70.3 |
| 500k | 500000 | 17679 | 425 | 120 | 50.0 | 3227 | 13834 | 17111 | 143 |

## Phase share (% of JS wall)

| Tier | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 2.9% | 0.8% | 0.3% | 21.9% | 73.9% | 96.1% | 1.0% |
| 250k | 2.8% | 0.8% | 0.3% | 20.9% | 75.1% | 96.3% | 0.9% |
| 500k | 2.4% | 0.7% | 0.3% | 18.3% | 78.3% | 96.8% | 0.8% |

## Super-linearity (ratio of `500k` to `100k` phase ms)

Cell-count ratio = 5.00×. A linear phase grows at the same ratio; >cellRatio = super-linear.

| Phase | 100k (ms) | 500k (ms) | Ratio | Verdict |
| --- | --- | --- | --- | --- |
| deserialize | 87.0 | 425 | 4.89× | linear-ish |
| parse-only | 24.0 | 120 | 5.00× | linear-ish |
| set_cell loop | 9.0 | 50.0 | 5.56× | linear-ish |
| set_formula loop | 658 | 3227 | 4.90× | linear-ish |
| flush | 2223 | 13834 | 6.22× | linear-ish |
| engine total | 2890 | 17111 | 5.92× | linear-ish |
| JS wall | 3006 | 17679 | 5.88× | linear-ish |

## flush_ms sub-phase decomposition (Phase 1A)

| Tier | flush total | parse | dep_extract | dep_register | formula_record | sub-phase sum | residual (BFS + notify) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 2223 | 0.00 | 258 | 1108 | 19.0 | 1385 | 838 |
| 250k | 5862 | 0.00 | 536 | 3135 | 71.0 | 3742 | 2120 |
| 500k | 13834 | 0.00 | 1189 | 8029 | 127 | 9345 | 4489 |

## flush_ms sub-phase share (% of flush_ms)

| Tier | parse | dep_extract | dep_register | formula_record | residual |
| --- | --- | --- | --- | --- | --- |
| 100k | 0.0% | 11.6% | 49.8% | 0.9% | 37.7% |
| 250k | 0.0% | 9.1% | 53.5% | 1.2% | 36.2% |
| 500k | 0.0% | 8.6% | 58.0% | 0.9% | 32.4% |

## Dep-graph stats after import (Phase 1B)

| Tier | formulas | point_dep_edges | range_dep_entries | range_formula_count | max_fanout | avg_fanout |
| --- | --- | --- | --- | --- | --- | --- |
| Mega | 500000 | 103347736 | 179 | 100393 | 100396 | 284.01 |
| 100k | 50000 | 10193739 | 195 | 10001 | 10004 | 277.37 |
| 250k | 125000 | 25373318 | 189 | 24723 | 24727 | 278.07 |
| 500k | 250000 | 51726545 | 179 | 50285 | 50288 | 284.43 |

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
