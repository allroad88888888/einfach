# Performance Benchmarks

Criterion-based benchmarks for the Rust core. They exist so the LAZY refactor
(`docs/LAZY_FORMULA_EVAL.md`, Steps 1–5) has a stable baseline to measure
against — not to prove absolute thresholds, which vary by machine.

## Running

Each crate owns its own bench suite. From the crate directory:

```bash
# Full suite (slow — full criterion sampling)
cd excel/rust/core         && cargo bench
cd excel/rust/excel-core   && cargo bench

# A single bench
cargo bench --bench store_bench
cargo bench --bench sheet_bench

# Fast smoke check (smaller sample count — useful in CI / pre-commit)
cargo bench -- --quick

# Compile-only (verify the harness still builds without running)
cargo bench --no-run
```

Criterion writes HTML reports to `target/criterion/<group>/<bench>/report/index.html`.
The terminal output shows `time`, `thrpt` (throughput) and any % change vs the
previous baseline.

## Comparing baselines

Before making a perf-sensitive change:

```bash
cargo bench -- --save-baseline before
```

Then, after the change:

```bash
cargo bench -- --baseline before
```

Criterion will annotate each row with the delta and flag statistically
significant regressions. Use this for any LAZY step that claims a perf win.

## What each benchmark measures

### `excel/rust/core/benches/store_bench.rs`

| Bench | What it measures | Gates / motivation |
|---|---|---|
| `store/atom_write_throughput/set_10k_primitives` | Bare `Store::set` cost on primitive atoms with no subscribers. The floor for every other write path. | Any LAZY step that touches `Store::set` (e.g. Step 3's dirty-marking restructure) must not regress this beyond noise. |
| `store/formula_chain_propagation/chain_100_propagate` | One full top-down recompute over a 100-deep linear chain after a single set at the head. Worst case for the eager dependency walker. | Step 3 (lazy invalidation) should leave this roughly flat when readers exist on the tail; Step 4 (range streaming) shouldn't touch it at all. A regression here means the propagator itself got slower. |

### `excel/rust/excel-core/benches/sheet_bench.rs`

| Bench | What it measures | Gates / motivation |
|---|---|---|
| `sheet/bulk_set_cell/set_10k_numbers` | Throughput of `Sheet::set_cell` for 10k primitive values, no formulas, no subscribers. Captures the cost of address parsing + `ensure_cell` + `store.set`. | Floor for the sheet write path. Any LAZY step that restructures `Sheet` internals (e.g. adding lazy flags per cell) must not regress this. |
| `sheet/sum_range_eval/sum_a1_a10000` | Per-call cost of `get_cell("B1")` where `B1 = SUM(A1:A10000)`. Today the derived atom value is cached after the first eval, so this measures the cached-read path — not the SUM walk itself. | LAZY Step 4 (range streaming / lazy SUM aggregator) lives here. Once Step 4 lands, this bench should be expanded to also measure the *cold* path (first read after invalidation), since the cached-read number alone won't tell you whether the streaming aggregator works. |
| `sheet/lazy_import_no_eval/import_10k_formulas` | Throughput of importing 10k formulas via `set_formula` without reading any of them. | LAZY Step 2 (deferred formula eval). When Step 2 lands, the bench should also assert `Store::debug_recompute_count() == 0` after import — failing loudly if any formula evaluated eagerly. The `assert_eq!` is staged as a comment in the bench source; un-comment it once the `#[doc(hidden)] debug_recompute_count` accessor exists. |
| `sheet/range_dep_registration/{10,100,1000}` | `set_formula(=SUM(A1:A1000))` N times, measure time. Each call expands the range into 1000 `cell_dependents` entries; total work is O(N × range size). | LAZY Step 5 (range dependency interval index). Today registration is roughly constant per-formula (~100 µs) since each expansion is 1000 HashMap inserts; Step 5 should make this O(1) per formula and rely on interval lookup at dirty time. |
| `sheet/range_dirty_lookup/{10,100,1000}` | After registering N range formulas that all contain A1, time `set_cell("A1", …)`. Measures the fan-out cost when a hotspot cell wakes many range deps. | Same Step 5 gate. Today this scales linearly with N (≈ 50 µs at N = 1000); Step 5's interval tree should keep cost bounded by *intervals-containing-A1*, not total range-formula count. |

#### Step 5 deferral note

The two `range_*` benches above are the empirical justification for *not*
landing Step 5 yet:

- **Registration**: ~100 µs / formula. Even 1000 range formulas (a heavy
  dashboard) costs ~100 ms once on load.
- **Dirty lookup**: 50 µs / cell-write at N = 1000. Imperceptible for
  interactive editing.

Step 5 becomes urgent if a future workload pushes N range formulas past
~10k (the doc's stated "10 万" gate from `LAZY_FORMULA_EVAL.md` Step 5).
The benches will catch the regression — re-run them when adding any
demo or feature that bulk-creates range formulas.

## Workflow for LAZY refactor steps

1. Check out the pre-refactor commit.
2. `cargo bench -- --save-baseline pre-step-N`.
3. Apply the refactor.
4. `cargo bench -- --baseline pre-step-N`.
5. Record the deltas + the criterion report path in the step's PR description.
   Do NOT promise specific wall-clock numbers in the doc — only deltas vs a
   named baseline on the same hardware are meaningful.

## What's intentionally NOT here

- **WASM bench harness.** `wasm-pack bench` is a different ecosystem and out
  of scope for the LAZY work, which is all native-Rust.
- **Absolute thresholds (e.g. "must be < 50 ms").** Hardware-dependent; we
  rely on relative deltas instead.
- **`debug_recompute_count` assertions.** Staged in the bench source as
  comments. They go live the moment the LAZY Step 2 accessor lands; they're
  inert today because no such counter exists in `Store` yet.
