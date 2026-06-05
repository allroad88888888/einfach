# Rust bulk-import phase-decomposition

*Last run: 2026-06-05T09:46:09.147Z*

## Per-tier phase breakdown

| Tier | total cells | JS wall (ms) | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 100000 | 16101 | 158 | 37.0 | 17.0 | 1571 | 14303 | 15891 | 51.6 |
| 250k | 250000 | 9605 | 221 | 57.0 | 26.0 | 1671 | 7620 | 9317 | 66.8 |
| 500k | 500000 | 25120 | 446 | 119 | 54.0 | 3384 | 21096 | 24534 | 140 |

## Phase share (% of JS wall)

| Tier | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 1.0% | 0.2% | 0.1% | 9.8% | 88.8% | 98.7% | 0.3% |
| 250k | 2.3% | 0.6% | 0.3% | 17.4% | 79.3% | 97.0% | 0.7% |
| 500k | 1.8% | 0.5% | 0.2% | 13.5% | 84.0% | 97.7% | 0.6% |

## Super-linearity (ratio of `500k` to `100k` phase ms)

Cell-count ratio = 5.00×. A linear phase grows at the same ratio; >cellRatio = super-linear.

| Phase | 100k (ms) | 500k (ms) | Ratio | Verdict |
| --- | --- | --- | --- | --- |
| deserialize | 158 | 446 | 2.82× | sub-linear |
| parse-only | 37.0 | 119 | 3.22× | sub-linear |
| set_cell loop | 17.0 | 54.0 | 3.18× | sub-linear |
| set_formula loop | 1571 | 3384 | 2.15× | sub-linear |
| flush | 14303 | 21096 | 1.47× | sub-linear |
| engine total | 15891 | 24534 | 1.54× | sub-linear |
| JS wall | 16101 | 25120 | 1.56× | sub-linear |

## Notes

- `deserialize` is `serde_wasm_bindgen::from_value` (JS → Rust).
- `parse-only` is an ISOLATED parse pass run before the engine — same parser, AST discarded.
- `set_cell loop` writes primitives only (no parsing).
- `set_formula loop` writes formulas only — INCLUDES the engine re-running the parser, cycle check, and dep wiring.
- `flush` = `engineTotal − (set_cell + set_formula)`. This is `WorkbookLoader::flush` + per-sheet `BulkLoader::flush`.
- `unaccounted` = `jsWall − (deserialize + engineTotal)`. Approximates wasm-bindgen boundary + JS-side V8 work building the input array.
- Write order in the instrumented variant differs from production (primitives first, then formulas). For the disjoint-column workload here it does not affect engine cost.
