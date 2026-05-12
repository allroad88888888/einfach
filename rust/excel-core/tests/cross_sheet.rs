//! Phase 3 — Cross-sheet scale acceptance suite.
//!
//! Three integration tests pinning the workbook-level laziness contract
//! from `rust/docs/PHASE3_PARALLEL.md` § "Phase 3 Acceptance Roll-Up":
//!
//!   - Subscriber on cross-sheet formula fires on source write
//!     (`write_propagates_to_cross_sheet_subscriber`).
//!   - Cross-sheet chain stays dirty without eager eval
//!     (`cross_sheet_chain_no_eager_eval`).
//!   - Cross-sheet range dep survives sparse eval
//!     (`cross_sheet_range_dirty`).
//!
//! All three are `#[ignore = "phase-3 — un-ignore after Track I merge"]`'d
//! at landing. Track I (workbook.rs: `CrossSheetDeps`, `set_cell`,
//! `clear_cell`, plus dirty-propagation BFS that fires cross-sheet
//! subscribers) is the structural change these tests turn green.
//!
//! Removal protocol: once Track I merges on
//! `claude/rust-core-state-plan-Auzcj` (the inherent methods
//! `Workbook::set_cell`/`clear_cell` become available; `set_formula`
//! already exists), delete the `#[ignore = ...]` attributes on each test
//! below AND delete the `WorkbookMutatorStubs` extension trait at the
//! bottom of this file. Rust's inherent-before-trait method resolution
//! silently shadows the stubs while they coexist, so the file compiles
//! against the current branch and turns green automatically once the
//! real methods land.

use std::cell::RefCell;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Phase 3 验收 (Roll-Up bullet 1): "Subscriber on cross-sheet formula
/// fires on source write" — the inverse of the current
/// `workbook_get_cell_refreshes_cross_sheet_cache_without_notifying`
/// test in `workbook.rs`. The pre-existing test pins the WRONG behavior
/// (subscriber count stays at 0 across cross-sheet writes); after Track
/// I, this test pins the right one.
///
/// SAFETY/contract: a subscriber attached to `Sheet1!B1` BEFORE the
/// cross-sheet formula `=Data!A1*2` is installed must fire when the
/// upstream cell `Data!A1` is mutated via `Workbook::set_cell`. The
/// workbook is the only mutation surface that holds the cross-sheet
/// dep graph — direct `Sheet::set_cell` paths still won't notify
/// across sheet boundaries (that's by design; the workbook tests
/// migrate first).
#[test]
#[ignore = "phase-3 — un-ignore after Track I merge"]
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

    // Install the cross-sheet formula. `Workbook::set_formula` already
    // exists; the per-sheet path here also wires up the static
    // dep registration that Track I's `CrossSheetDeps` rides on top of.
    wb.set_formula(0, "B1", "=Data!A1*2");

    // Cross-sheet write — Track I's new inherent method. Before Track I
    // lands, the `WorkbookMutatorStubs` trait stub below provides a
    // panicking `set_cell` so this file still compiles; the `#[ignore]`
    // keeps the test from running. After Track I lands and we un-ignore,
    // the inherent method shadows the stub and the assertions become
    // meaningful.
    wb.set_cell(1, "A1", Value::Number(5.0));

    // Phase 3 contract: the cross-sheet dependent's subscriber must
    // fire. "≥ 1" rather than "== 1" because Track I has BFS latitude
    // to coalesce or fan out — the contract is "at least once", not
    // "exactly once".
    assert!(
        *fires.borrow() >= 1,
        "cross-sheet subscriber didn't fire on Workbook::set_cell"
    );
    // And the value chain must resolve through the workbook.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
}

/// Phase 3 验收 (Roll-Up bullet 2): "Cross-sheet chain stays dirty
/// without eager eval". Three-sheet chain
/// `Sheet1!C1 → Sheet2!B1 → Sheet3!A1`. A write at the root must dirty
/// the entire chain WITHOUT triggering any formula evaluation; the
/// dirty propagation is structural (BFS through `CrossSheetDeps`), not
/// observational.
///
/// SAFETY/contract:
///   1. After reading each formula cell once to populate the chain
///      caches, baseline `debug_formula_eval_count()` on Sheet1 and
///      Sheet2 is captured.
///   2. Subscribers on all three formula cells exist.
///   3. A write at the root (`Sheet3!A1`) must:
///      - Fire ALL three subscribers (the BFS traverses both
///        cross-sheet hops). "≥ 1" each because Track I's BFS may
///        coalesce duplicates.
///      - Leave eval counters UNCHANGED on both downstream sheets —
///        dirty-mark only, no eager eval (the same contract as Phase 1's
///        `dirty_notify_no_eager_compute` but across sheets).
///   4. A subsequent read at `Sheet1!C1` recomputes EXACTLY the two
///      cross-sheet formulas on its dep chain (Sheet1!C1 +
///      Sheet2!B1), so the combined eval counter for those two sheets
///      bumps by 2 — not by the full workbook formula count.
#[test]
#[ignore = "phase-3 — un-ignore after Track I merge"]
fn cross_sheet_chain_no_eager_eval() {
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

    // Initial reads populate the caches up the chain so subsequent
    // dirty-only assertions have a meaningful baseline.
    assert_eq!(wb.get_cell("Sheet3", "A1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet2", "B1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(1.0));

    // Baseline eval counters: only Sheet1 + Sheet2 carry formulas on
    // this chain. Sheet3 holds a primitive — it has no formulas to
    // evaluate, so its counter is excluded from the comparison.
    let eval_s1_before = wb.sheet(s1).unwrap().debug_formula_eval_count();
    let eval_s2_before = wb.sheet(s2).unwrap().debug_formula_eval_count();

    // Subscribers on each formula cell. Each gets its own counter so
    // we can verify the BFS reached every layer of the chain.
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

    // Root write — must dirty the entire chain via Track I's
    // cross-sheet BFS without eager eval anywhere.
    wb.set_cell(s3, "A1", Value::Number(99.0));

    // All three subscribers fired at least once. "≥ 1" because Track
    // I's BFS may coalesce; "== 1" would over-specify the coalescing
    // contract.
    assert!(
        *fires_s3.borrow() >= 1,
        "Sheet3!A1 subscriber (root) must fire on its own write"
    );
    assert!(
        *fires_s2.borrow() >= 1,
        "Sheet2!B1 subscriber (mid) must fire via cross-sheet dirty BFS"
    );
    assert!(
        *fires_s1.borrow() >= 1,
        "Sheet1!C1 subscriber (tip) must fire via transitive cross-sheet BFS"
    );

    // Phase 3's key bullet: no eager eval anywhere on the chain.
    assert_eq!(
        wb.sheet(s1).unwrap().debug_formula_eval_count(),
        eval_s1_before,
        "Sheet1 formula eval counter must not change on root write — dirty only"
    );
    assert_eq!(
        wb.sheet(s2).unwrap().debug_formula_eval_count(),
        eval_s2_before,
        "Sheet2 formula eval counter must not change on root write — dirty only"
    );

    // Now an explicit read at the tip pulls the chain. Sheet1!C1
    // recomputes once; Sheet2!B1 (its cross-sheet dependency)
    // recomputes once. Combined bump = 2.
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(99.0));
    let eval_s1_after = wb.sheet(s1).unwrap().debug_formula_eval_count();
    let eval_s2_after = wb.sheet(s2).unwrap().debug_formula_eval_count();
    assert_eq!(
        (eval_s1_after - eval_s1_before) + (eval_s2_after - eval_s2_before),
        2,
        "tip read must recompute exactly Sheet1!C1 + Sheet2!B1 (2 evals total)"
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
/// 1 + 10 + 2 = 13. Pre-Phase 3, the cross-sheet range dep doesn't even
/// reach the workbook's cross-sheet dependents index — Sheet2's local
/// range_dependents knows about the formula but has no way to notify
/// Sheet1.
#[test]
#[ignore = "phase-3 — un-ignore after Track I merge"]
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
    // up. Phase 3 + Phase 1's range-dep-from-AST contract say D1 must
    // dirty.
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

// =============================================================================
// Extension trait stubs — Track I shadowing target
// =============================================================================
//
// Track I (PHASE3_PARALLEL.md § Track I) adds inherent methods
// `Workbook::set_cell` and `Workbook::clear_cell` (plus the dirty-prop
// BFS that backs them). `Workbook::set_formula` already exists on the
// current branch and is unmodified by this stub.
//
// Why a stub trait at all: the tests above reference `wb.set_cell(...)`
// and (potentially future) `wb.clear_cell(...)`. Without these stubs,
// `cargo test -p einfach-excel-core --test cross_sheet` would not
// COMPILE on the current branch — and the per-test `#[ignore]`
// attribute only skips RUNTIME, not compilation. The stub trait gives
// the compiler a method-name resolution path that panics if anyone
// actually invokes it (which they won't, because of `#[ignore]`).
//
// Once Track I merges, inherent-method-before-trait-method resolution
// in Rust silently shadows the stubs. At that point this `impl` block
// becomes dead code; remove the `#[ignore]` attributes on the three
// tests above AND delete this trait block in the same commit.

#[allow(dead_code)]
trait WorkbookMutatorStubs {
    fn set_cell(&mut self, sheet_idx: usize, addr: &str, value: Value);
    fn clear_cell(&mut self, sheet_idx: usize, addr: &str);
}

impl WorkbookMutatorStubs for Workbook {
    fn set_cell(&mut self, _sheet_idx: usize, _addr: &str, _value: Value) {
        panic!(
            "Workbook::set_cell stub invoked — Track I hasn't merged yet. \
             Tests calling this must be #[ignore]'d."
        );
    }
    fn clear_cell(&mut self, _sheet_idx: usize, _addr: &str) {
        panic!(
            "Workbook::clear_cell stub invoked — Track I hasn't merged yet. \
             Tests calling this must be #[ignore]'d."
        );
    }
}
