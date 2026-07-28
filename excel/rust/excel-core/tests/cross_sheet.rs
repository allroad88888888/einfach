//! Cross-sheet Store-delegation acceptance suite.
//!
//! Integration tests pinning the workbook-scoped atom contract:
//!
//!   - Subscriber on cross-sheet formula fires on source write
//!     (`write_propagates_to_cross_sheet_subscriber`).
//!   - A materialized cross-sheet chain re-derives synchronously with Store
//!     change pruning (`cross_sheet_chain_rederives_during_store_flush`).
//!   - Cross-sheet range dep survives sparse eval
//!     (`cross_sheet_range_dirty`).

use std::cell::RefCell;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// A subscriber attached before the cross-sheet formula is installed must be
/// retargeted to the formula facade and fire when the Store observes a source
/// write.
#[test]
fn write_propagates_to_cross_sheet_subscriber() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");

    // Subscriber on Sheet1!B1 BEFORE the formula exists. The empty-cell
    // subscribe path (Phase 1 contract) holds the bucket without
    // materializing a primitive atom.
    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(0)
        .unwrap()
        .subscribe_cell("B1", move || *ff.borrow_mut() += 1);

    // Install the cross-sheet formula through the workbook-scoped Store.
    wb.set_formula(0, "B1", "=Data!A1*2");

    // Cross-sheet write through the workbook mutation surface.
    wb.set_cell(1, "A1", Value::Number(5.0));

    // The formula facade publishes when its derived value changes.
    assert!(
        *fires.borrow() >= 1,
        "cross-sheet subscriber didn't fire on Workbook::set_cell"
    );
    // And the value chain must resolve through the workbook.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
}

/// A formula that needs workbook context also tracks its local point refs.
/// Both references are facade dependencies in the same shared Store.
#[test]
fn workbook_context_formula_tracks_local_point_write() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    let sheet1 = wb.index_of("Sheet1").unwrap();

    wb.set_cell(sheet1, "A1", Value::Number(2.0));
    wb.set_cell(data, "A1", Value::Number(10.0));
    assert!(wb.set_formula(sheet1, "B1", "=A1+Data!A1"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));

    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(sheet1)
        .unwrap()
        .subscribe_cell("B1", move || *ff.borrow_mut() += 1);

    wb.set_cell(sheet1, "A1", Value::Number(7.0));

    assert_eq!(
        *fires.borrow(),
        1,
        "a local point write must notify the mixed-context formula once"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(17.0));
}

/// Same boundary as the point-ref case, but for a previously empty member of
/// a local range. Static range membership must wake the workbook-context
/// formula even though the first sparse read never visited A2.
#[test]
fn workbook_context_formula_tracks_local_range_write() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    let sheet1 = wb.index_of("Sheet1").unwrap();

    wb.set_cell(sheet1, "A1", Value::Number(1.0));
    wb.set_cell(sheet1, "A3", Value::Number(3.0));
    wb.set_cell(data, "A1", Value::Number(10.0));
    assert!(wb.set_formula(sheet1, "B1", "=SUM(A1:A3)+Data!A1"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));

    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(sheet1)
        .unwrap()
        .subscribe_cell("B1", move || *ff.borrow_mut() += 1);

    wb.set_cell(sheet1, "A2", Value::Number(2.0));

    assert_eq!(
        *fires.borrow(),
        1,
        "a local range-member write must notify the mixed-context formula once"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(16.0));
}

/// Three-sheet chain `Sheet1!C1 -> Sheet2!B1 -> Sheet3!A1`.
///
/// Once the formulas are materialized, a root write follows vanilla Store
/// semantics: both derived formulas re-run during `flush_pending`, all changed
/// facades publish, and a later read performs no additional evaluation.
#[test]
fn cross_sheet_chain_rederives_during_store_flush() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    let s3 = wb.add_sheet("Sheet3");
    let s1 = wb.index_of("Sheet1").unwrap();

    // Build the chain bottom-up: Sheet3!A1 = 1; Sheet2!B1 = Sheet3!A1;
    // Sheet1!C1 = Sheet2!B1. Use the existing Sheet::set_cell on the
    // primitive (no cross-sheet propagation needed at setup time).
    wb.sheet_mut(s3).unwrap().set_cell("A1", Value::Number(1.0));
    assert!(wb.set_formula(s2, "B1", "=Sheet3!A1"));
    assert!(wb.set_formula(s1, "C1", "=Sheet2!B1"));

    // Initial reads materialize the formula-inner atoms and dependency chain.
    assert_eq!(wb.get_cell("Sheet3", "A1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet2", "B1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(1.0));

    // Baseline eval counters: only Sheet1 + Sheet2 carry formulas on
    // this chain. Sheet3 holds a primitive — it has no formulas to
    // evaluate, so its counter is excluded from the comparison.
    let eval_s1_before = wb.sheet(s1).unwrap().debug_formula_eval_count();
    let eval_s2_before = wb.sheet(s2).unwrap().debug_formula_eval_count();

    // Subscribers on each cell observe Store publication at every layer.
    let fires_s1 = Rc::new(RefCell::new(0u32));
    let fires_s2 = Rc::new(RefCell::new(0u32));
    let fires_s3 = Rc::new(RefCell::new(0u32));
    let f1 = fires_s1.clone();
    let f2 = fires_s2.clone();
    let f3 = fires_s3.clone();
    let _sub1 = wb
        .sheet_mut(s1)
        .unwrap()
        .subscribe_cell("C1", move || *f1.borrow_mut() += 1);
    let _sub2 = wb
        .sheet_mut(s2)
        .unwrap()
        .subscribe_cell("B1", move || *f2.borrow_mut() += 1);
    let _sub3 = wb
        .sheet_mut(s3)
        .unwrap()
        .subscribe_cell("A1", move || *f3.borrow_mut() += 1);

    // Root write synchronously flushes the workbook-scoped Store.
    wb.set_cell(s3, "A1", Value::Number(99.0));

    // All three values changed and therefore all three facades publish.
    assert!(
        *fires_s3.borrow() >= 1,
        "Sheet3!A1 subscriber (root) must fire on its own write"
    );
    assert!(
        *fires_s2.borrow() >= 1,
        "Sheet2!B1 subscriber (mid) must fire via Store propagation"
    );
    assert!(
        *fires_s1.borrow() >= 1,
        "Sheet1!C1 subscriber (tip) must fire via transitive Store propagation"
    );

    // INV-7: already-materialized formulas re-derive during the write flush.
    assert_eq!(
        wb.sheet(s1).unwrap().debug_formula_eval_count(),
        eval_s1_before + 1,
        "Sheet1!C1 must re-derive once during the root write"
    );
    assert_eq!(
        wb.sheet(s2).unwrap().debug_formula_eval_count(),
        eval_s2_before + 1,
        "Sheet2!B1 must re-derive once during the root write"
    );

    // The write settled the chain; a subsequent read is cache-only.
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(99.0));
    let eval_s1_after = wb.sheet(s1).unwrap().debug_formula_eval_count();
    let eval_s2_after = wb.sheet(s2).unwrap().debug_formula_eval_count();
    assert_eq!(
        (eval_s1_after - eval_s1_before) + (eval_s2_after - eval_s2_before),
        2,
        "post-write read must not add evaluations beyond the two flush re-derivations"
    );
}

/// Phase 3 验收 (Roll-Up bullet 3): "Cross-sheet range dep survives
/// sparse eval" — the cross-sheet equivalent of Phase 1's
/// `range_sparse_then_write` (P0 bug pin).
///
/// SAFETY/contract: `Sheet1!D1 = =SUM(Sheet2!A1:A100)` with only
/// `Sheet2!A1` and `Sheet2!A100` materialized. First read goes through
/// the sparse iterator and visits only those two cells (the middle 98
/// stay empty). Writing `Sheet2!A50` — which the sparse iter DID NOT
/// visit during the first read — MUST still dirty `Sheet1!D1`. The
/// subscriber on D1 fires, and re-reading produces the correct sum
/// 1 + 10 + 2 = 13. The workbook-scoped range-family atom owns this wake-up.
///
#[test]
fn cross_sheet_range_dirty() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    let s1 = wb.index_of("Sheet1").unwrap();

    // Seed Sheet2 sparsely (A1, A100 only — A2..A99 stay empty).
    wb.sheet_mut(s2).unwrap().set_cell("A1", Value::Number(1.0));
    wb.sheet_mut(s2)
        .unwrap()
        .set_cell("A100", Value::Number(2.0));
    // Cross-sheet SUM over the range.
    assert!(wb.set_formula(s1, "D1", "=SUM(Sheet2!A1:A100)"));

    // First read: triggers sparse eval. After Phase 1 + 2, the range
    // dep on Sheet2!A1:A100 is statically registered from the AST
    // corners (not narrowed to "cells visited"), so a later write
    // inside the range must dirty D1 even when it landed on an empty
    // address during the sparse pass. The cross-sheet wiring is the
    // Phase 3 addition.
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(3.0));

    // Subscribe AFTER the initial read so we observe only the
    // cross-sheet write's notification.
    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(s1)
        .unwrap()
        .subscribe_cell("D1", move || *ff.borrow_mut() += 1);

    // The killer write: A50 was empty during the sparse first read,
    // so a "tracked addresses only" implementation would never wake D1
    // up. The range-family atom must invalidate D1.
    wb.set_cell(s2, "A50", Value::Number(10.0));

    assert!(
        *fires.borrow() >= 1,
        "cross-sheet range-dep subscriber must fire on a write to a \
         previously-empty cell inside the range"
    );
    assert_eq!(
        wb.get_cell("Sheet1", "D1"),
        Value::Number(13.0),
        "re-read must include the new A50 value: 1 + 10 + 2 = 13"
    );
}
