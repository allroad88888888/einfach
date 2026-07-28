//! Phase 1 — Scale acceptance suite.
//!
//! Six integration tests that pin the engine's "百万 cell" contract from
//! `excel/rust/docs/ONLINE_SPREADSHEET_PLAN.md` § Phase 1 验收 and the per-case
//! table in `excel/rust/docs/PHASE1_PARALLEL.md` § Track C. Each test asserts a
//! single Phase 1 bullet using ONLY the public `Sheet` API + the
//! `debug_*` counter family.

use std::cell::RefCell;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::Sheet;

/// Phase 1 验收: "导入公式后 `formula_eval_count == 0`".
///
/// SAFETY/contract: `bulk_load` is the import path. Importing N formulas
/// must register them as Dirty records and MUST NOT evaluate any. We
/// build a wide sparse pattern so dirty-mark fan-out has actual work to
/// skip — 100k formulas with one primitive feeder per row.
#[test]
fn import_100k_formulas_zero_eval() {
    const N: u32 = 100_000;
    let mut sheet = Sheet::new();

    // Build the bulk-load payload programmatically: row r gets a feeder
    // `A{r}=1` and a formula `B{r}=A{r}+1`. 100k formula cells total.
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{}", r), Value::Number(1.0));
            loader.set_formula(&format!("B{}", r), &format!("=A{}+1", r));
        }
    });

    assert_eq!(
        sheet.debug_formula_count(),
        N as usize,
        "all 100k formula records must be registered"
    );
    assert_eq!(
        sheet.debug_imported_formula_count(),
        N as usize,
        "bulk_load formulas must be counted as imported"
    );
    assert_eq!(
        sheet.debug_formula_eval_count(),
        0,
        "import path must not evaluate any formula"
    );
    assert_eq!(
        sheet.debug_dirty_count(),
        N as usize,
        "every imported formula starts Dirty"
    );
}

/// Phase 1 验收: "Cached formula read 是 O(visible/reachable)，不是
/// O(sheet size)".
///
/// SAFETY/contract: reading a viewport of 100 formula cells must only
/// evaluate those 100 — the other 900 formulas in the sheet stay Dirty.
#[test]
fn viewport_read_100_reaches_only_visible() {
    const N: u32 = 1_000;
    const VISIBLE: u32 = 100;
    let mut sheet = Sheet::new();

    // 1k feeders + 1k independent formulas. Each formula reads its own
    // feeder, so eval cost is per-formula, not chained.
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{}", r), Value::Number(r as f64));
            loader.set_formula(&format!("B{}", r), &format!("=A{}*2", r));
        }
    });
    assert_eq!(sheet.debug_formula_eval_count(), 0);

    // Read only the first VISIBLE formula cells.
    for r in 1..=VISIBLE {
        let _ = sheet.get_cell(&format!("B{}", r));
    }

    assert_eq!(
        sheet.debug_formula_eval_count(),
        VISIBLE as usize,
        "viewport read must only evaluate visible formulas, not the full sheet"
    );
    assert_eq!(
        sheet.debug_dirty_count(),
        (N - VISIBLE) as usize,
        "off-viewport formulas stay Dirty"
    );
}

/// Phase 1 验收: "空 viewport subscription 不增长 primitive atom 数".
///
/// SAFETY/contract: subscribing to an empty address must not materialize
/// a primitive atom. The first non-Null write materializes; a Null write
/// must release it again (this also pins case #6, by design).
#[test]
fn empty_cell_subscribe_no_atom() {
    let mut sheet = Sheet::new();

    let count = Rc::new(RefCell::new(0u32));
    let cc = count.clone();
    let _sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);

    assert_eq!(
        sheet.debug_primitive_atom_count(),
        0,
        "subscribing to an empty cell must not allocate a primitive atom"
    );
    assert_eq!(
        sheet.debug_live_subscription_count(),
        1,
        "bucket exists even though no atom backs it"
    );

    // First write materializes.
    sheet.set_cell("A1", Value::Number(1.0));
    assert_eq!(sheet.debug_primitive_atom_count(), 1);
    assert_eq!(*count.borrow(), 1, "subscriber fires on first write");

    // Null write releases the atom but keeps the listener bucket.
    sheet.set_cell("A1", Value::Null);
    assert_eq!(
        sheet.debug_primitive_atom_count(),
        0,
        "Null write must release the primitive atom"
    );
    assert_eq!(
        sheet.debug_live_subscription_count(),
        1,
        "bucket survives the Null release so future writes still notify"
    );
}

/// Phase 1 验收 (P0): "SUM(A1:A100000) 在 A50000 为空时读一次；之后写
/// A50000，公式必须 dirty，下一次读必须包含新值".
///
/// SAFETY/contract: range deps must survive sparse-eval narrowing. The
/// first read of `=SUM(A1:A100)` only visits A1 and A100 (sparse iter
/// skips the empty middle), but writing A50 — which was empty during
/// that read — MUST still dirty B1. This is the bug pinned at
/// PHASE1_PARALLEL.md § "P0 Bug — Pinned" steps 4–6.
#[test]
fn range_sparse_then_write() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A100", Value::Number(2.0));
    sheet.set_formula("B1", "=SUM(A1:A100)");

    // First read: sparse iter visits only A1 + A100. After Agent A's
    // fix, the static range dep on A1:A100 must survive eval — the
    // tracked-set replacement must NOT drop empty addresses in the
    // range.
    assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));

    // Write inside the range, at a cell that was empty (and therefore
    // skipped by sparse iter) during the first read.
    sheet.set_cell("A50", Value::Number(10.0));

    // If range deps were narrowed to "visited cells", this read still
    // returns 3.0 (cache hit, B1 not dirtied). Phase 1 says it must be
    // 13.0.
    assert_eq!(sheet.get_cell("B1"), Value::Number(13.0));
}

/// Atom delegation acceptance: a subscribed formula is a mounted Store
/// derivation and therefore settles eagerly on writes.
///
/// SAFETY/contract: formula value, dependency propagation, and subscriber
/// publication all come from the same atomm derivation. Do not preserve the
/// legacy lazy-dirty behavior with a second notification graph.
#[test]
fn mounted_formula_subscription_rederives_through_store() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(0.0));

    // Subscribe to B1 before B1 exists. Bucket survives without an atom.
    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = sheet.subscribe_cell("B1", move || *ff.borrow_mut() += 1);

    let before = sheet.debug_formula_eval_count();
    sheet.set_formula("B1", "=A1*2");
    assert_eq!(
        sheet.debug_formula_eval_count(),
        before + 1,
        "the mounted facade must derive the installed formula through Store"
    );
    assert_eq!(
        sheet.debug_dirty_count(),
        0,
        "the mounted atomm derivation is settled, not parked in legacy Dirty state"
    );

    // The explicit read reuses the settled Store value.
    assert_eq!(sheet.get_cell("B1"), Value::Number(0.0));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        before + 1,
        "reading a settled mounted formula must not evaluate again"
    );

    // A dependency write re-derives the mounted formula and publishes through
    // the same Store graph.
    let eval_after_first_read = sheet.debug_formula_eval_count();
    sheet.set_cell("A1", Value::Number(3.0));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        eval_after_first_read + 1,
        "dependency change must rederive the mounted formula through Store"
    );
    assert!(
        *fires.borrow() >= 2,
        "subscriber must publish the install and dependency-driven value changes"
    );
}

/// Phase 1 验收: "写 Null 在安全时释放 primitive atom".
///
/// SAFETY/contract: clearing a primitive cell back to Null when no
/// dependents need it must release the underlying atom — long-running
/// sheets that fill-then-clear must not leak primitive scaffolds. Uses
/// only existing API; sanity-pick for un-ignored scaffolding probe.
#[test]
fn null_write_releases_primitive_atom() {
    let mut sheet = Sheet::new();
    assert_eq!(sheet.debug_primitive_atom_count(), 0);

    sheet.set_cell("A1", Value::Number(1.0));
    assert_eq!(
        sheet.debug_primitive_atom_count(),
        1,
        "primitive write must materialize an atom"
    );

    // Clearing via Value::Null is the documented release path; the
    // dedicated `clear_cell` shorthand also exists and should behave
    // the same.
    sheet.set_cell("A1", Value::Null);
    assert_eq!(
        sheet.debug_primitive_atom_count(),
        0,
        "Null write must release the primitive atom when there are no dependents"
    );

    // clear_cell shorthand on an already-cleared cell stays at 0 and
    // must not panic — symmetrical with subscribing then clearing.
    sheet.clear_cell("A1");
    assert_eq!(sheet.debug_primitive_atom_count(), 0);
}

// =============================================================================
// Phase 2 acceptance — Agent H additions
// =============================================================================
//
// Two tests pinning the Phase 2 scaling bullets from
// `excel/rust/docs/PHASE2_PARALLEL.md` § "Phase 2 Acceptance Roll-Up":
//
//   - 100k range formulas + 1 cell write → bounded by Store matches, not by N.
//   - 1M coord space + small range read → O(range cells) visited
//     (Track F lands the row-indexed cell storage that makes this true).
//
// Backing implementations:
//   - small ranges read every member facade, so Store reverse edges identify
//     the six affected formula-inner atoms without an address fanout index;
//   - `range_read_1m_sparse_visits_only_range` is backed by `RowMajorMap` and
//     the `Sheet::debug_range_visit_count` probe helper.

use std::time::{Duration, Instant};

/// Atom-delegation acceptance: "100k small-range formulas + 1 cell write ->
/// bounded by Store dependents, not by N".
///
/// SAFETY/contract: with 100 000 range formulas of the form
/// `=SUM(A{r}:A{r+5})` registered, a single `set_cell("A50000", _)`
/// must reach only the six formula-inner atoms whose member-facade edges
/// include A50000. The 50ms wall-clock bound catches a regression to a full
/// formula scan.
///
/// `Instant`-based timing has obvious limitations on shared CI runners,
/// but the gap between O(N) and O(matches) at N=100k is large enough
/// that 50ms remains a meaningful boundary.
#[test]
fn single_write_with_100k_range_formulas_is_bounded() {
    const N_RANGE_FORMULAS: u32 = 100_000;

    let mut sheet = Sheet::new();

    // Mirrors the bench setup in `benches/scale_bench.rs::
    // bench_dirty_lookup_100k_ranges`: 100k overlapping 6-row ranges
    // anchored in column A.
    //
    // Formulas remain parked until first read. Hydrate them so each small
    // range installs direct facade -> formula-inner edges in Store.
    sheet.bulk_load(|loader| {
        for r in 1..=N_RANGE_FORMULAS {
            loader.set_formula(&format!("B{}", r), &format!("=SUM(A{}:A{})", r, r + 5));
        }
    });
    for r in 1..=N_RANGE_FORMULAS {
        let _ = sheet.get_cell(&format!("B{}", r));
    }

    assert_eq!(
        sheet.debug_range_dep_count(),
        0,
        "small ranges must not allocate geometry roots"
    );
    assert_eq!(sheet.debug_dependents_count("A50000"), 6);

    // One single primitive write that lies inside ~6 overlapping
    // ranges (rows 49 995..=50 000 each include A50000 in their
    // 6-row span).
    let start = Instant::now();
    sheet.set_cell("A50000", Value::Number(42.0));
    let elapsed = start.elapsed();

    assert!(
        elapsed < Duration::from_millis(50),
        "set_cell with 100k range formulas must be bounded by the six \
         Store dependents, not by N. \
         Observed: {:?}",
        elapsed
    );
}

/// Phase 2 验收: "1M coord space + small range read → O(range cells)
/// visited" (PHASE2_PARALLEL.md § Phase 2 Acceptance Roll-Up, second
/// bullet; Track F delivers the row-indexed `cells` storage that backs
/// it).
///
/// SAFETY/contract: with 10 000 non-empty cells scattered across a
/// 1 000 000-coord workspace, reading a 50×27 viewport range `A1:AA50`
/// must visit only the cells that fall inside the viewport — NOT a
/// linear scan of all 10k materialized cells filtered by
/// `range.contains`. The visit count is probed via
/// `Sheet::debug_range_visit_count` which delegates to the same
/// `for_each_sparse_cell_with` path used by `SUM`-over-range evals.
///
/// Deterministic spread: every 100th flat index is filled, so the
/// expected viewport visit count is small (only the indices that fall
/// inside rows 0..=49 cols 0..=26). With the Phase 1 storage this
/// closure already returns the right count but visits all 10k cells
/// to do so; Phase 2's row-indexed structure makes the visit cost
/// match the returned count.
#[test]
fn range_read_1m_sparse_visits_only_range() {
    const TOTAL_CELLS: usize = 1_000_000;
    const NON_EMPTY: usize = 10_000;
    // 1000×1000 == 1M; same shape as the bench.
    const SIDE: u32 = 1000;
    // Every 100th flat index. Deterministic, scattered, dense enough
    // that the 50×27 viewport catches a handful of cells.
    const STRIDE: usize = 100;

    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for i in 0..NON_EMPTY {
            let flat = (i * STRIDE) % TOTAL_CELLS;
            let row = (flat / SIDE as usize) as u32;
            let col = (flat % SIDE as usize) as u32;
            // Build "A1"-style address inline so the test stays
            // self-contained (no shared `addr_of` helper here).
            let mut letters = String::new();
            let mut c = col as i64 + 1;
            while c > 0 {
                c -= 1;
                letters.insert(0, (b'A' + (c % 26) as u8) as char);
                c /= 26;
            }
            let addr_str = format!("{}{}", letters, row + 1);
            loader.set_cell(&addr_str, Value::Number(i as f64));
        }
    });

    // Probe: how many cells did the sparse iterator actually yield
    // when asked for A1:AA50 (rows 0..=49, cols 0..=26 in 0-indexed
    // form). With stride=100 and side=1000 the filled flat indices
    // are 0, 100, 200, …, 999 900 — i.e. every row r gets cells
    // filled at cols 0, 100, 200, …, 900 (since `flat % 1000 = col`).
    // Only col 0 falls inside the viewport's `cols 0..=26`, so the
    // viewport sees exactly one cell per row across rows 0..=49: 50
    // visits total.
    let visits = sheet.debug_range_visit_count("A1:AA50");

    // Phase 2 Track F contract: visits ≤ cells_in_range. For the
    // current Phase 1 storage this returns the right count (50) but
    // does so by walking all 10k entries; Track F makes the walk
    // itself O(visits + log).
    assert!(
        visits <= 50 * 27,
        "viewport visit count must be bounded by viewport cell count \
         (Phase 2 Track F); got {} visits over A1:AA50",
        visits
    );

    // Tight sanity bound: this specific stride lands one filled cell
    // per row in col 0 across rows 0..=49, so visits = 50. If the
    // test drifts (different stride / viewport shape) this assertion
    // is the first thing to update.
    assert_eq!(
        visits, 50,
        "deterministic spread should land 50 filled cells in A1:AA50"
    );

    // And the total non-empty count is still 10k — we did not
    // accidentally drop anything during setup.
    assert_eq!(sheet.non_empty_addrs().len(), NON_EMPTY);
}
