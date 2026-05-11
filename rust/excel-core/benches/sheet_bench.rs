//! Criterion benchmarks for `einfach-excel-core::Sheet` hot paths.
//!
//! Run with `cargo bench` from this crate (or `cargo bench --bench sheet_bench`).
//! See `rust/docs/PERF.md` for what each benchmark gates and how to compare
//! baselines across LAZY refactor steps.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use einfach_excel_core::Sheet;
use einfach_core::Value;

/// Cell address helper: turn a (row, col) into the canonical "A1" form
/// that the public `Sheet` API accepts.
fn addr_of(row: u32, col: u32) -> String {
    // Reverse-engineer the column letters (0 -> "A", 1 -> "B", 26 -> "AA", ...).
    let mut letters = String::new();
    let mut c = col as i64 + 1;
    while c > 0 {
        c -= 1;
        letters.insert(0, (b'A' + (c % 26) as u8) as char);
        c /= 26;
    }
    format!("{}{}", letters, row + 1)
}

/// `bench_bulk_set_cell` — primitive write throughput across the sheet facade.
///
/// 10_000 plain values (no formulas, no subscribers). Measures the overhead
/// of `set_cell` (parse address, ensure_cell, store.set) versus the raw
/// `Store::set` floor from `store_bench`.
fn bench_bulk_set_cell(c: &mut Criterion) {
    const N: u32 = 10_000;

    // Pre-compute address strings once; we don't want to measure
    // the formatting cost on every iteration.
    let addrs: Vec<String> = (0..N).map(|i| addr_of(i, 0)).collect();

    let mut group = c.benchmark_group("sheet/bulk_set_cell");
    group.throughput(Throughput::Elements(N as u64));

    group.bench_function("set_10k_numbers", |b| {
        b.iter_batched(
            Sheet::new,
            |mut sheet| {
                for (i, a) in addrs.iter().enumerate() {
                    sheet.set_cell(a, Value::Number(i as f64));
                }
                black_box(&sheet);
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// `bench_sum_range_eval` — the canonical "big range" benchmark.
///
/// Seed A1..A10000 with numbers, set B1 = SUM(A1:A10000), then time
/// `get_cell("B1")` per call. Today the sum walks all 10k cells every read;
/// LAZY Step 4 (range streaming / lazy aggregator) is what this benchmark
/// is meant to gate. Save a baseline before that work and compare after.
fn bench_sum_range_eval(c: &mut Criterion) {
    const N: u32 = 10_000;

    let mut group = c.benchmark_group("sheet/sum_range_eval");
    // Each iteration evaluates one SUM over N cells.
    group.throughput(Throughput::Elements(N as u64));
    // The sum eval is heavy; reduce the sample target so this completes
    // in reasonable wall time on slower machines.
    group.sample_size(20);

    group.bench_function("sum_a1_a10000", |b| {
        // Build the sheet once and re-use it. We're measuring eval cost on
        // a stable graph; B1's value is cached internally by the derived atom,
        // but `get_cell` still walks the read path.
        let mut sheet = Sheet::new();
        for i in 0..N {
            sheet.set_cell(&addr_of(i, 0), Value::Number(i as f64));
        }
        sheet.set_formula("B1", &format!("=SUM(A1:A{})", N));

        b.iter(|| {
            black_box(sheet.get_cell("B1"));
        });
    });

    group.finish();
}

/// `bench_lazy_import_no_eval` — formula import throughput.
///
/// Imports N formulas WITHOUT reading any of them, then measures throughput.
///
/// Once LAZY Step 2 lands (deferred-eval formulas + `Store::debug_recompute_count`
/// accessor), this benchmark also asserts that the recompute counter is exactly 0
/// after import — i.e. zero evaluation happened. Today the formulas evaluate
/// eagerly in `create_derived`, so the counter would not be 0 even if the
/// accessor existed. The intent of the bench (throughput of the import path) is
/// still measurable today; the lazy-property assertion is the success criterion
/// added when LAZY Step 2 ships.
fn bench_lazy_import_no_eval(c: &mut Criterion) {
    const N: u32 = 10_000;

    let mut group = c.benchmark_group("sheet/lazy_import_no_eval");
    group.throughput(Throughput::Elements(N as u64));
    // Each import touches the parser + builds N derived atoms; cap samples
    // so the suite stays under a couple of minutes.
    group.sample_size(10);

    // Pre-compute the formula strings once so we don't measure format cost.
    // Each formula references a small range so parsing + ensure_refs is the
    // dominant import work, not the AST node count.
    let formulas: Vec<String> = (0..N).map(|_| "=SUM(B1:B10)".to_string()).collect();
    let dest_addrs: Vec<String> = (0..N).map(|i| addr_of(i, 2)).collect(); // column C

    group.bench_function("import_10k_formulas", |b| {
        b.iter_batched(
            || {
                // Seed the B-column range the formulas reference so ensure_refs
                // doesn't grow the cell map mid-loop in a way that's outside the
                // scope of "import path cost".
                let mut sheet = Sheet::new();
                for r in 0..10 {
                    sheet.set_cell(&addr_of(r, 1), Value::Number(r as f64));
                }
                sheet
            },
            |mut sheet| {
                for (formula, dest) in formulas.iter().zip(dest_addrs.iter()) {
                    sheet.set_formula(dest, formula);
                }

                // === LAZY Step 2 success criterion (re-enable once landed) ===
                //
                // Once `Store::debug_recompute_count` is exposed, the import
                // path should perform zero formula evaluations:
                //
                //     assert_eq!(
                //         sheet.debug_recompute_count(),
                //         0,
                //         "lazy import must not eagerly evaluate formulas",
                //     );
                //
                // Until then we just measure throughput; failing-loud comes when
                // the accessor exists. See rust/docs/PERF.md.

                black_box(&sheet);
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// `bench_range_dep_registration` — cost of registering many range-formula
/// dependencies. Gates LAZY Step 5 (range dependency interval index).
///
/// Today `set_formula` calls `collect_refs`, which expands every `Range` node
/// into one `CellAddress` per cell inside the rectangle. Each expanded address
/// then becomes a key in `cell_dependents`. For N formulas × R range size that
/// is O(N·R) HashMap inserts + O(N·R) hash-set entries; memory grows the same
/// way. Step 5's interval-tree variant should make this O(N) registration with
/// per-row interval lookups at dirty time.
///
/// Parameters sweep N ∈ {10, 100, 1000} formulas each over a 1000-wide range.
/// At N = 1000 today this is 1M dep entries — the elbow we want to flatten.
fn bench_range_dep_registration(c: &mut Criterion) {
    let mut group = c.benchmark_group("sheet/range_dep_registration");
    // Each registration writes `n` formulas; throughput is reported per formula.
    group.sample_size(20);

    for n in [10u32, 100, 1000].iter().copied() {
        // Pre-format destination addresses and the formula text so we measure
        // dep registration, not string work.
        let dests: Vec<String> = (0..n).map(|i| addr_of(i, 25)).collect(); // col Z
        let formula = "=SUM(A1:A1000)";

        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter_batched(
                Sheet::new,
                |mut sheet| {
                    for dest in dests.iter() {
                        sheet.set_formula(dest, formula);
                    }
                    black_box(&sheet);
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

/// `bench_range_dirty_lookup` — single-cell write dirty cascade when many
/// range formulas already depend on that cell.
///
/// Setup: N formulas each `=SUM(A1:A1000)` so they all transitively depend
/// on A1. Then measure one `set_cell("A1", …)`. The fan-out lookup must hit
/// `cell_dependents[A1]` (HashSet of N entries) and BFS mark each formula
/// dirty. Both the lookup and the BFS are O(N) today; Step 5's interval
/// tree should keep this bounded by the number of *intervals containing A1*
/// not the total range-formula count.
fn bench_range_dirty_lookup(c: &mut Criterion) {
    let mut group = c.benchmark_group("sheet/range_dirty_lookup");
    group.sample_size(30);

    for n in [10u32, 100, 1000].iter().copied() {
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            // Build the sheet once per bench; only the write step is timed.
            let mut sheet = Sheet::new();
            for r in 0..1000 {
                sheet.set_cell(&addr_of(r, 0), Value::Number(r as f64));
            }
            for i in 0..n {
                sheet.set_formula(&addr_of(i, 25), "=SUM(A1:A1000)");
            }
            // Touch each formula once so caches are Clean — subsequent dirty
            // marks have to actually transition Clean → Dirty (the realistic
            // workload after a user has rendered the viewport).
            for i in 0..n {
                let _ = sheet.get_cell(&addr_of(i, 25));
            }

            let mut toggle = 0.0f64;
            b.iter(|| {
                // Alternate values so subscribers don't short-circuit on
                // "same value" no-op paths (none today, but future-proof).
                toggle += 1.0;
                sheet.set_cell("A1", Value::Number(toggle));
                black_box(&sheet);
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_bulk_set_cell,
    bench_sum_range_eval,
    bench_lazy_import_no_eval,
    bench_range_dep_registration,
    bench_range_dirty_lookup,
);
criterion_main!(benches);
