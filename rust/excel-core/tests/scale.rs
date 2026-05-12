//! Phase 1 — Scale acceptance suite.
//!
//! Six integration tests that pin the engine's "百万 cell" contract from
//! `rust/docs/ONLINE_SPREADSHEET_PLAN.md` § Phase 1 验收 and the per-case
//! table in `rust/docs/PHASE1_PARALLEL.md` § Track C. Each test asserts a
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

/// Phase 1 验收: "formula dirty notify 不触发 eager compute".
///
/// SAFETY/contract: `set_formula` must register the formula as Dirty
/// without computing it, even when a subscriber is attached. The
/// subscriber fires (so views can mark themselves dirty), but no eval
/// happens until the next `get_cell`.
#[test]
fn dirty_notify_no_eager_compute() {
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
        before,
        "set_formula must not eagerly evaluate to satisfy a subscriber"
    );
    assert_eq!(
        sheet.debug_dirty_count(),
        1,
        "the newly-registered formula must be Dirty"
    );

    // Only an explicit read should bump the eval counter.
    assert_eq!(sheet.get_cell("B1"), Value::Number(0.0));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        before + 1,
        "exactly one eval on the first read"
    );

    // Dirtying A1 must dirty B1 (subscriber fires) without recomputing.
    let eval_after_first_read = sheet.debug_formula_eval_count();
    sheet.set_cell("A1", Value::Number(3.0));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        eval_after_first_read,
        "dependency change must not eagerly recompute the formula"
    );
    assert!(
        *fires.borrow() >= 1,
        "subscriber must have fired at least once across the formula lifetime"
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
