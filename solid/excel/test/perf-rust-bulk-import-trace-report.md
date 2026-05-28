# Rust bulk-import phase-decomposition

*Last run: 2026-05-27T09:46:13.540Z*

## Per-tier phase breakdown

| Tier | total cells | JS wall (ms) | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 100000 | 6512 | 99.0 | 30.0 | 14.0 | 765 | 5595 | 6374 | 39.4 |
| 250k | 250000 | 10527 | 239 | 66.0 | 27.0 | 1658 | 8518 | 10203 | 84.6 |

## Phase share (% of JS wall)

| Tier | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100k | 1.5% | 0.5% | 0.2% | 11.7% | 85.9% | 97.9% | 0.6% |
| 250k | 2.3% | 0.6% | 0.3% | 15.8% | 80.9% | 96.9% | 0.8% |

## Super-linearity (ratio of `250k` to `100k` phase ms)

Cell-count ratio = 2.50×. A linear phase grows at the same ratio; >cellRatio = super-linear.

| Phase | 100k (ms) | 250k (ms) | Ratio | Verdict |
| --- | --- | --- | --- | --- |
| deserialize | 99.0 | 239 | 2.41× | linear-ish |
| parse-only | 30.0 | 66.0 | 2.20× | sub-linear |
| set_cell loop | 14.0 | 27.0 | 1.93× | sub-linear |
| set_formula loop | 765 | 1658 | 2.17× | sub-linear |
| flush | 5595 | 8518 | 1.52× | sub-linear |
| engine total | 6374 | 10203 | 1.60× | sub-linear |
| JS wall | 6512 | 10527 | 1.62× | sub-linear |

## Notes

- `deserialize` is `serde_wasm_bindgen::from_value` (JS → Rust).
- `parse-only` is an ISOLATED parse pass run before the engine — same parser, AST discarded.
- `set_cell loop` writes primitives only (no parsing).
- `set_formula loop` writes formulas only — INCLUDES the engine re-running the parser, cycle check, and dep wiring.
- `flush` = `engineTotal − (set_cell + set_formula)`. This is `WorkbookLoader::flush` + per-sheet `BulkLoader::flush`.
- `unaccounted` = `jsWall − (deserialize + engineTotal)`. Approximates wasm-bindgen boundary + JS-side V8 work building the input array.
- Write order in the instrumented variant differs from production (primitives first, then formulas). For the disjoint-column workload here it does not affect engine cost.
