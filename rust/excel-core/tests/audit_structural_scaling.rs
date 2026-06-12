//! AUDIT 2026-06-12 — pattern-family repros for structural + range
//! mutations (`docs/AUDIT_PATTERN_FAMILY_2026-06-12.md` § A).
//!
//! These tests PIN CURRENT BEHAVIOR (including behavior the audit
//! classifies as a bug) so the suite stays green until a fix arc
//! lands. Each test's doc comment states what the CORRECT behavior
//! would be; when a fix lands, flip the assertion.
//!
//! Status: A-4 / A-5 pins FLIPPED to the fixed behavior (W1.1 fix arc,
//! see tests/spill_structural.rs). A-6 / A-7 pins FLIPPED to the fixed
//! behavior (W1.2 fix arc, see tests/cross_sheet_propagation.rs).
//!
//! Timing benches are `#[ignore]`d — run with:
//!   cargo test --release --test audit_structural_scaling -- --ignored --nocapture

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use einfach_core::Value;
use einfach_excel_core::{CellAddress, CellRange, Sheet, Workbook};

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).expect("test address must parse")
}

fn range(spec_start: &str, spec_end: &str) -> CellRange {
    CellRange::new(addr(spec_start), addr(spec_end)).normalize()
}

/// Sheet with `n` lazy (parked, unhydrated) formulas in column B,
/// each referencing a distinct empty cell in column A.
fn lazy_sheet(n: u32) -> Sheet {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=n {
            loader.set_formula(&format!("B{r}"), &format!("=A{r}+1"));
        }
    });
    sheet
}

// =====================================================================
// Finding A1 (P-A): one insert_row hydrates EVERY lazy formula.
// =====================================================================

/// Structural proof (no timing): after `bulk_load` of N formulas the
/// dep graph is empty (lazy contract); ONE `insert_row` at the top
/// hydrates all N — `cell_dependents` jumps from 0 keys to N keys.
/// The work eliminated from import (LAZY_FORMULA_INDEXING) is paid
/// back in full by the first structural edit, and the sheet stays
/// eager forever after.
#[test]
fn audit_insert_row_hydrates_every_lazy_formula() {
    const N: u32 = 5_000;
    let mut sheet = lazy_sheet(N);
    assert_eq!(
        sheet.debug_cell_dependents_key_count(),
        0,
        "lazy bulk_load must install zero dep edges"
    );

    sheet.insert_row(0, 1);

    // CURRENT (audited) behavior: full hydration. Each formula has a
    // distinct single dep, so key count == N proves O(total formulas)
    // work for a 1-row insert.
    assert_eq!(
        sheet.debug_cell_dependents_key_count(),
        N as usize,
        "insert_row(0,1) hydrated every lazy formula (pattern P-A)"
    );
}

/// Timing bench for the same path. Measures one `insert_row(0,1)` on
/// 1k / 10k / 100k lazy-formula sheets, plus a SECOND insert on the
/// (now fully hydrated) sheet to split hydration cost from the
/// relocate + retarget + rebuild_all_formula_dependents cost.
#[test]
#[ignore]
fn bench_insert_row_scales_with_total_formula_count() {
    for n in [1_000u32, 10_000, 100_000, 500_000] {
        let mut sheet = lazy_sheet(n);
        let t0 = Instant::now();
        sheet.insert_row(0, 1);
        let first = t0.elapsed();
        let t1 = Instant::now();
        sheet.insert_row(0, 1);
        let second = t1.elapsed();
        eprintln!(
            "insert_row(0,1) on {n} lazy formulas: first {:?} (hydrate+relocate+retarget), second {:?} (already hydrated)",
            first, second
        );
    }
}

// =====================================================================
// Finding A2 (P-A): move_sheet re-parses every lazy formula on every
// sheet (rebuild_cross_sheet_deps), with NO `!`-prefilter — unlike
// install_sheet_bulk_inner which skips parse for `!`-free sources.
// =====================================================================

#[test]
#[ignore]
fn bench_move_sheet_parses_all_lazy_formulas() {
    for n in [1_000u32, 10_000, 100_000] {
        let mut wb = Workbook::new();
        wb.add_sheet("Other");
        let mut formulas: HashMap<CellAddress, String> = HashMap::new();
        for r in 1..=n {
            // Same-sheet formulas, zero cross-sheet refs, no '!'.
            formulas.insert(addr(&format!("B{r}")), format!("=A{r}+1"));
        }
        wb.install_sheet_bulk(0, HashMap::new(), formulas)
            .expect("install");
        let t0 = Instant::now();
        assert!(wb.move_sheet(0, 1));
        let moved = t0.elapsed();
        eprintln!(
            "move_sheet on workbook with {n} lazy same-sheet formulas (zero cross-sheet refs): {:?}",
            moved
        );
    }
}

// =====================================================================
// Finding A3 (P-A): clear_range of ONE cell builds a HashSet over the
// ENTIRE sheet's formula key space (`for_each_non_empty_in_range`
// formula_keys snapshot) — O(total formulas) for a 1-cell clear.
// =====================================================================

#[test]
#[ignore]
fn bench_clear_range_one_cell_scales_with_sheet_size() {
    for n in [1_000u32, 10_000, 100_000, 500_000] {
        let mut sheet = lazy_sheet(n);
        let t0 = Instant::now();
        let cleared = sheet.clear_range(range("B1", "B1"));
        let took = t0.elapsed();
        eprintln!(
            "clear_range(B1:B1) on {n}-formula sheet: cleared {cleared} cell in {:?}",
            took
        );
    }
}

// =====================================================================
// Finding A4 (P-D, P1) — FIXED. clear_range routes through
// BulkLoader::set_cell, which is now spill-aware: a non-anchor spill
// TARGET write is skipped (array intact, single-cell parity with
// try_set_cell's SpillCellWrite rejection) and an ANCHOR write tears
// the spill down first. Pin flipped from the panic to the fixed
// behavior; the full semantics matrix lives in
// tests/spill_structural.rs.
// =====================================================================

#[test]
fn audit_clear_range_over_spill_region_clears_cleanly() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=SEQUENCE(3)"));
    assert_eq!(sheet.get_cell("A2"), Value::Number(2.0), "spill landed");
    // Clear the whole spill region through the range path. Pre-fix this
    // panicked in Store::set (read-only derived spill-target atom).
    let cleared = sheet.clear_range(range("A1", "A3"));
    assert_eq!(cleared, 3, "anchor + both targets visited");
    for a in ["A1", "A2", "A3"] {
        assert_eq!(sheet.get_cell(a), Value::Null, "{a} must be empty");
    }
    // Region is writable again.
    assert!(sheet.try_set_cell("A2", Value::Number(5.0)).is_ok());
}

// =====================================================================
// Finding A5 (P-D, P1) — FIXED. Structural edits now tear every spill
// down before the address shift and re-derive surviving anchors
// afterwards, so the spill bookkeeping always matches the post-shift
// addresses. Pin flipped from the stale-bookkeeping behavior (anchor
// overwrite wrongly rejected; target write panicked in Store::set) to
// the fixed behavior; the full insert/delete row/col matrix lives in
// tests/spill_structural.rs.
// =====================================================================

#[test]
fn audit_insert_row_relocates_spill_targets() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=SEQUENCE(3)"));
    assert_eq!(sheet.get_cell("A3"), Value::Number(3.0), "spill landed");

    sheet.insert_row(0, 1); // spill now occupies A2:A4 (anchor A2)

    // Write to the real (shifted) bottom target: clean SpillCellWrite
    // rejection at the NEW anchor address — pre-fix this panicked on
    // the read-only derived atom.
    let target_write = sheet.try_set_cell("A4", Value::Number(7.0));
    assert!(
        matches!(
            target_write,
            Err(einfach_excel_core::SheetError::SpillCellWrite { anchor })
                if anchor == addr("A2")
        ),
        "target write must be rejected against the shifted anchor, got {target_write:?}"
    );

    // Overwriting the shifted anchor is legal — replaces the array.
    // Pre-fix this was wrongly rejected (stale target list named A2 a
    // target).
    assert!(sheet.try_set_cell("A2", Value::Number(9.0)).is_ok());
    assert_eq!(sheet.get_cell("A2"), Value::Number(9.0));
    assert_eq!(sheet.get_cell("A3"), Value::Null);
    assert_eq!(sheet.get_cell("A4"), Value::Null);
}

// =====================================================================
// Finding A6 (P-C) — FIXED (W1.2). remove_sheet now rebuilds the
// cross-sheet dep graph via `rebuild_cross_sheet_deps` (same path as
// move_sheet) instead of clearing it, so dirty/notify fanout for
// UNRELATED cross-sheet formulas survives sheet removal. Pin flipped
// to the fixed behavior; the wider matrix (index remap, removed-
// source notify) lives in tests/cross_sheet_propagation.rs.
// =====================================================================

#[test]
fn audit_remove_unrelated_sheet_kills_cross_sheet_notify() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    let scratch = wb.add_sheet("Scratch");

    assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(0)
        .unwrap()
        .subscribe_cell("B1", move || *ff.borrow_mut() += 1);

    // Baseline: cross-sheet write notifies the subscriber.
    wb.set_cell(1, "A1", Value::Number(1.0));
    let baseline = *fires.borrow();
    assert!(baseline >= 1, "baseline cross-sheet notify works");

    // Remove the UNRELATED Scratch sheet.
    assert!(wb.remove_sheet(scratch).is_some());
    assert!(
        wb.debug_cross_sheet_reverse_edge_count() > 0,
        "A-6 FIXED: the surviving Data!A1 -> Sheet1!B1 edge must still \
         be registered after the rebuild"
    );

    // Same write again: value observable AND the subscriber fires.
    wb.set_cell(1, "A1", Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(4.0));
    assert!(
        *fires.borrow() > baseline,
        "A-6 FIXED: cross-sheet subscriber keeps firing after removing \
         an unrelated sheet"
    );
}

// =====================================================================
// Finding A7 (P-C) — FIXED (W1.2). rename_sheet still does NOT rewrite
// formula ASTs/texts (the name-resolution contract is unchanged:
// `=Data!A1` keeps saying `Data` and stops resolving), but dependents
// are now dirtied and their subscribers notified, and the cross-sheet
// edge graph is rebuilt against the new name → index map. Pin flipped
// to the fixed behavior; the new-name-resolves case lives in
// tests/cross_sheet_propagation.rs.
// =====================================================================

#[test]
fn audit_rename_sheet_dependents_not_retargeted_or_notified() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    wb.set_cell(data, "A1", Value::Number(5.0));
    assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));

    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(0)
        .unwrap()
        .subscribe_cell("B1", move || *ff.borrow_mut() += 1);

    assert!(wb.rename_sheet(data, "Numbers"));

    let after = wb.get_cell("Sheet1", "B1");
    eprintln!("B1 after renaming Data -> Numbers: {after:?}");
    // Name-resolution contract (unchanged): the AST still says
    // `Data!A1`, which no longer resolves — the observable value
    // changed away from 10 (#REF!-class).
    assert_ne!(
        after,
        Value::Number(10.0),
        "dependent value changed after rename (references break, Excel-\
         style rewrite is a separate follow-up)"
    );
    // A-7 FIXED: the subscriber is told about the change.
    assert!(
        *fires.borrow() >= 1,
        "A-7 FIXED: rename_sheet must notify dependents whose value \
         changed"
    );
}
