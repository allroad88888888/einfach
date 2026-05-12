//! Criterion smoke benchmarks for Phase 1 scale acceptance.
//!
//! These benches do NOT gate a perf number; they prove the lazy / sparse
//! contracts at the order-of-magnitude scale called out in
//! `rust/docs/ONLINE_SPREADSHEET_PLAN.md` Phase 1:
//!
//! 1. `bulk_load_100k_formulas` — 100 000 formulas imported via `bulk_load`
//!    must complete in bounded wall time. If import were eager, runtime
//!    would explode well past any reasonable per-iter budget. The bench
//!    is therefore an implicit laziness check on the import path.
//!
//! 2. `sparse_1m_grid_read_window` — 1 000 000-cell coordinate space with
//!    only 10 000 materialized cells. Reading a 50×27 viewport rectangle
//!    must be O(visible), not O(total cells in the coordinate space).
//!
//! Run with `cargo bench --bench scale_bench`. Use `--no-run` to verify
//! compilation only; full execution takes real minutes.

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};

use einfach_excel_core::Sheet;
use einfach_core::Value;

// === Sizing knobs ===========================================================
//
// Both benches are smoke-level Phase 1 acceptance checks, not perf gates.
// The constants below can be raised in CI hot-path / regression runs once
// `cargo bench` is wired into a slower job; they are sized here so a single
// criterion iteration completes in well under 3s on a developer laptop.

/// Formula count for `bulk_load_100k_formulas`.
/// scaled to keep one iteration <= 3s; raise for CI hot-path checks
const N_FORMULAS: usize = 100_000;

/// Total coordinate-space size for `sparse_1m_grid_read_window`.
/// scaled to keep one iteration <= 3s; raise for CI hot-path checks
const TOTAL_CELLS: usize = 1_000_000;

/// Materialized cells inside the 1M coord space. Picked so density is
/// `NON_EMPTY / TOTAL_CELLS = 1%`, exercising the sparse read path.
/// scaled to keep one iteration <= 3s; raise for CI hot-path checks
const NON_EMPTY: usize = 10_000;

/// Viewport window read per timed iteration.
/// scaled to keep one iteration <= 3s; raise for CI hot-path checks
const WINDOW_ROWS: usize = 50;
const WINDOW_COLS: usize = 27;

// === Helpers ================================================================

/// Cell address helper: turn a (row, col) into the canonical "A1" form
/// that the public `Sheet` API accepts. Matches the helper in
/// `sheet_bench.rs` so address formatting is consistent across benches.
fn addr_of(row: u32, col: u32) -> String {
    let mut letters = String::new();
    let mut c = col as i64 + 1;
    while c > 0 {
        c -= 1;
        letters.insert(0, (b'A' + (c % 26) as u8) as char);
        c /= 26;
    }
    format!("{}{}", letters, row + 1)
}

// === Bench 1: bulk_load_100k_formulas =======================================

/// Import 100 000 formulas through `Sheet::bulk_load` and measure wall time.
///
/// The payload (destination addresses + formula strings) is pre-built once
/// outside the timed section; `iter_batched` also builds the seed sheet
/// outside the timed closure. Only the `bulk_load` call itself is timed.
///
/// Each formula is a tiny `=A{n}*2` referencing a single primitive cell in
/// column A. The point of the bench is import throughput / laziness, not
/// dependency-graph fan-out, so the formulas are intentionally simple.
///
/// No `get_cell` calls happen during the timed section: if `bulk_load`
/// were eagerly evaluating, the 100 000 derivations would dwarf any
/// reasonable per-iter budget and the bench would obviously regress.
fn bench_bulk_load_100k_formulas(c: &mut Criterion) {
    // Pre-compute every (dest, formula) pair once. We do NOT want to
    // measure address/string formatting inside the bench.
    let dest_addrs: Vec<String> = (0..N_FORMULAS)
        .map(|i| addr_of((i as u32) + 1, 1)) // column B, rows 2..N+1
        .collect();
    let formulas: Vec<String> = (0..N_FORMULAS)
        .map(|i| format!("=A{}*2", i + 1))
        .collect();
    // Seed values for the A column the formulas reference. Building this
    // list once and replaying it inside the per-iter setup keeps the timed
    // section honest while still giving each iteration a fresh sheet.
    let a_seeds: Vec<(String, f64)> = (0..N_FORMULAS)
        .map(|i| (addr_of(i as u32, 0), i as f64))
        .collect();

    let mut group = c.benchmark_group("scale/bulk_load_100k_formulas");
    group.throughput(Throughput::Elements(N_FORMULAS as u64));
    // 100k inserts per iter is heavy; cap sample count so the suite stays
    // under a couple of minutes wall time.
    group.sample_size(10);

    group.bench_function("import_100k", |b| {
        b.iter_batched(
            // Setup: fresh sheet with the A column already seeded so the
            // formulas have something to reference. This setup is NOT
            // included in the timing budget.
            || {
                let mut sheet = Sheet::new();
                sheet.bulk_load(|loader| {
                    for (addr, v) in a_seeds.iter() {
                        loader.set_cell(addr, Value::Number(*v));
                    }
                });
                sheet
            },
            // Timed: the import itself.
            |mut sheet| {
                sheet.bulk_load(|loader| {
                    for (dest, formula) in dest_addrs.iter().zip(formulas.iter()) {
                        loader.set_formula(dest, formula);
                    }
                });
                black_box(&sheet);
            },
            criterion::BatchSize::PerIteration,
        );
    });

    group.finish();
}

// === Bench 2: sparse_1m_grid_read_window ====================================

/// Read a 50×27 viewport window from a sparse 1 000 000-cell grid.
///
/// Grid shape: 1000 rows × 1000 columns = 1 000 000 coordinates. Only
/// `NON_EMPTY` (10 000) of those coordinates have a value; the remaining
/// 990 000 stay empty and must not have backing atoms. The materialized
/// addresses are scattered deterministically across the coordinate space
/// using a coprime stride so they don't all land inside the window.
///
/// Sheet construction (seeding 10k non-empty cells) happens once outside
/// the timed section. The timed work is 50 × 27 = 1350 `get_cell` calls
/// across a small rectangle anchored near the origin — the typical
/// "first viewport after open" workload.
fn bench_sparse_1m_grid_read_window(c: &mut Criterion) {
    // 1000 × 1000 == 1 000 000 coord space.
    let side: u32 = (TOTAL_CELLS as f64).sqrt() as u32;
    debug_assert_eq!((side as usize) * (side as usize), TOTAL_CELLS);

    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        // Deterministic scatter: stride by a prime coprime with `TOTAL_CELLS`
        // so the 10k filled cells spread across the entire coordinate space
        // rather than clustering in one corner.
        let stride: usize = 97;
        for i in 0..NON_EMPTY {
            let flat = (i * stride) % TOTAL_CELLS;
            let row = (flat / side as usize) as u32;
            let col = (flat % side as usize) as u32;
            loader.set_cell(&addr_of(row, col), Value::Number(i as f64));
        }
    });

    // Window addresses, also pre-built so the timed section is pure reads.
    // Anchor at (0, 0) — this is the "open workbook, first viewport" case.
    let window: Vec<String> = (0..WINDOW_ROWS as u32)
        .flat_map(|r| (0..WINDOW_COLS as u32).map(move |c| addr_of(r, c)))
        .collect();

    let mut group = c.benchmark_group("scale/sparse_1m_grid_read_window");
    // Throughput is per cell read, not per iteration.
    group.throughput(Throughput::Elements((WINDOW_ROWS * WINDOW_COLS) as u64));
    group.sample_size(30);

    group.bench_function("read_50x27_window", |b| {
        b.iter(|| {
            for a in window.iter() {
                black_box(sheet.get_cell(a));
            }
        });
    });

    group.finish();
}

// === Bench 3: dirty_lookup_100k_ranges ======================================

/// Phase 2 acceptance probe — measure the wall time of a SINGLE
/// `set_cell` write on a sheet that has 100 000 registered range-formula
/// dependents.
///
/// Setup (NOT timed): import 100 000 formulas of the form
/// `=SUM(A{r}:A{r+5})` for r in 1..=100 000, anchored in column A so
/// each range is 6 rows tall. The ranges overlap heavily near rows
/// 10..=99 995. `bulk_load.set_formula` populates `range_dependents`
/// statically from `Expr::Range` corners at import time, so all 100k
/// entries are in the index even though every formula's
/// `FormulaCache` stays `Dirty` (no eval). This is the explicit Phase 1
/// laziness contract — we do NOT warm the full formula set. We do one
/// `get_cell` on a single formula to force its first eval (proving the
/// index survives sparse-narrowing, mirroring `range_sparse_then_write`
/// in tests/scale.rs).
///
/// Timed section: one `sheet.set_cell("A50000", Value::Number(_))`.
///
/// Without Track E's interval index, `dependents_of(A50000)` does
/// 100k `CellRange::contains` calls before any dirty-mark work begins,
/// so the per-write cost is O(N). With Track E, the cost should be
/// O(matches + log) — A50000 sits inside the ~6 ranges starting at
/// rows 49 995..=50 000.
///
/// `iter_batched` rebuilds the sheet for each iteration so the write
/// always hits a fresh state (no pre-existing primitive scaffold at
/// A50000 between iterations). `sample_size(20)` to keep the 100k
/// per-iter setup from dominating wall-clock.
fn bench_dirty_lookup_100k_ranges(c: &mut Criterion) {
    const N_RANGE_FORMULAS: usize = 100_000;

    // Pre-build the (dest, formula) payload once so the per-iter setup
    // is just the bulk_load replay, not string formatting.
    let dest_addrs: Vec<String> = (1..=N_RANGE_FORMULAS)
        .map(|r| format!("B{}", r))
        .collect();
    let formulas: Vec<String> = (1..=N_RANGE_FORMULAS)
        .map(|r| format!("=SUM(A{}:A{})", r, r + 5))
        .collect();

    let mut group = c.benchmark_group("scale/dirty_lookup_100k_ranges");
    // Throughput is per registered range-formula, so the bench reports
    // "writes per second normalized by N". Phase 1 = O(N); Phase 2's
    // Track E should make this scale far better.
    group.throughput(Throughput::Elements(N_RANGE_FORMULAS as u64));
    // 100k formulas in setup → keep sample count modest so the suite
    // doesn't dominate `cargo bench` wall time.
    group.sample_size(20);

    group.bench_function("single_set_cell_after_100k_ranges", |b| {
        b.iter_batched(
            // Setup: fresh sheet with 100k range formulas imported. We
            // explicitly do NOT warm the full formula set — the Phase 1
            // contract guarantees `bulk_load.set_formula` registers
            // `range_dependents` from AST corners without computing the
            // formula. One `get_cell` on a single neighboring formula
            // exercises the sparse-eval path (the P0 contract from
            // tests/scale.rs::range_sparse_then_write) so the index
            // looks like a realistic post-open state.
            || {
                let mut sheet = Sheet::new();
                sheet.bulk_load(|loader| {
                    for (dest, formula) in dest_addrs.iter().zip(formulas.iter()) {
                        loader.set_formula(dest, formula);
                    }
                });
                // Optional one-formula warm — does not warm the rest;
                // remaining 99 999 records stay Dirty.
                let _ = sheet.get_cell("B49997");
                sheet
            },
            // Timed: a single primitive write inside a known number of
            // overlapping ranges. dependents_of must scan
            // range_dependents — Phase 1 = O(N), Phase 2 = O(matches).
            |mut sheet| {
                sheet.set_cell("A50000", Value::Number(42.0));
                black_box(&sheet);
            },
            criterion::BatchSize::PerIteration,
        );
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_bulk_load_100k_formulas,
    bench_sparse_1m_grid_read_window,
    bench_dirty_lookup_100k_ranges,
);
criterion_main!(benches);
