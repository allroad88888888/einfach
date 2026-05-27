# Rust bulk-import phase-decomposition

*Last run: 2026-05-27T09:18:26.899Z*

## Per-tier phase breakdown

| Tier | total cells | JS wall (ms) | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 100000 | 10523 | 110 | 34.0 | 17.0 | 798 | 9552 | 10367 | 46.2 |
| 250k | 250000 | 20703 | 414 | 197 | 109 | 2843 | 17112 | 20064 | 225 |
| 500k | 500000 | 40602 | 457 | 117 | 49.0 | 3223 | 36734 | 40006 | 139 |

## Phase share (% of JS wall)

| Tier | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 1.0% | 0.3% | 0.2% | 7.6% | 90.8% | 98.5% | 0.4% |
| 250k | 2.0% | 1.0% | 0.5% | 13.7% | 82.7% | 96.9% | 1.1% |
| 500k | 1.1% | 0.3% | 0.1% | 7.9% | 90.5% | 98.5% | 0.3% |

## Super-linearity (ratio of `500k` to `100k` phase ms)

Cell-count ratio = 5.00×. A linear phase grows at the same ratio; >cellRatio = super-linear.

| Phase | 100k (ms) | 500k (ms) | Ratio | Verdict |
| --- | --- | --- | --- | --- |
| deserialize | 110 | 457 | 4.15× | sub-linear |
| parse-only | 34.0 | 117 | 3.44× | sub-linear |
| set_cell loop | 17.0 | 49.0 | 2.88× | sub-linear |
| set_formula loop | 798 | 3223 | 4.04× | sub-linear |
| flush | 9552 | 36734 | 3.85× | sub-linear |
| engine total | 10367 | 40006 | 3.86× | sub-linear |
| JS wall | 10523 | 40602 | 3.86× | sub-linear |

## Notes

- `deserialize` is `serde_wasm_bindgen::from_value` (JS → Rust).
- `parse-only` is an ISOLATED parse pass run before the engine — same parser, AST discarded.
- `set_cell loop` writes primitives only (no parsing).
- `set_formula loop` writes formulas only — INCLUDES the engine re-running the parser, cycle check, and dep wiring.
- `flush` = `engineTotal − (set_cell + set_formula)`. This is `WorkbookLoader::flush` + per-sheet `BulkLoader::flush`.
- `unaccounted` = `jsWall − (deserialize + engineTotal)`. Approximates wasm-bindgen boundary + JS-side V8 work building the input array.
- Write order in the instrumented variant differs from production (primitives first, then formulas). For the disjoint-column workload here it does not affect engine cost.
