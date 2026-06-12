//! W1.2 / W1.3 fix-arc acceptance — cross-sheet propagation across
//! structural sheet ops and defined-name indirection (audit findings
//! A-6, A-7, B-4 in `docs/AUDIT_PATTERN_FAMILY_2026-06-12.md`).
//!
//! Contract under test:
//!   - `remove_sheet` REBUILDS the cross-sheet dep graph (it used to
//!     clear it permanently) and dirties + notifies formulas that
//!     referenced the removed sheet (A-6).
//!   - `rename_sheet` rebuilds the graph against the new name → index
//!     map and dirties + notifies formulas whose resolution changed —
//!     both "old name broke" and "new name now resolves" (A-7). The
//!     name-resolution contract itself is unchanged: ASTs keep the
//!     typed sheet name; references to the old name surface a
//!     `#REF!`-class value.
//!   - Cross-sheet refs hidden behind defined names (`READDATA =
//!     LAMBDA(Data!A1)`, cell `=READDATA()`) register real edges and
//!     stay fresh + notify, including nested named lambdas and
//!     name cycles (B-4).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::{CellAddress, Workbook};

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).expect("test address must parse")
}

fn counter(wb: &mut Workbook, sheet_idx: usize, cell: &str) -> (Rc<RefCell<u32>>, impl Sized) {
    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let sub = wb
        .sheet_mut(sheet_idx)
        .unwrap()
        .subscribe_cell(cell, move || *ff.borrow_mut() += 1);
    (fires, sub)
}

// ===================================================================
// A-6: remove_sheet
// ===================================================================

/// Removing an UNRELATED sheet must not sever the dirty/notify fanout
/// of existing cross-sheet formulas.
#[test]
fn remove_unrelated_sheet_keeps_cross_sheet_notify_alive() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data"); // idx 1
    let scratch = wb.add_sheet("Scratch"); // idx 2
    assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    wb.set_cell(1, "A1", Value::Number(1.0));
    let baseline = *fires.borrow();
    assert!(baseline >= 1, "baseline cross-sheet notify works");

    assert!(wb.remove_sheet(scratch).is_some());

    wb.set_cell(1, "A1", Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(4.0));
    assert!(
        *fires.borrow() > baseline,
        "subscriber must keep firing after removing an unrelated sheet"
    );
}

/// Removing a sheet BEFORE the referenced one shifts indices; the
/// rebuilt graph must re-key the edge so fanout targets the shifted
/// index.
#[test]
fn remove_sheet_before_source_remaps_edge_indices() {
    let mut wb = Workbook::new();
    let scratch = wb.add_sheet("Scratch"); // idx 1
    wb.add_sheet("Data"); // idx 2
    wb.set_cell(2, "A1", Value::Number(5.0));
    assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    assert!(wb.remove_sheet(scratch).is_some());
    assert_eq!(wb.index_of("Data"), Some(1), "Data shifted down");

    // Write through the SHIFTED index; the rebuilt edge must route the
    // notify to Sheet1!B1.
    wb.set_cell(1, "A1", Value::Number(7.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
    assert!(
        *fires.borrow() >= 1,
        "subscriber must fire through the remapped edge"
    );
}

/// Removing the REFERENCED sheet changes the dependent's value (its
/// source is gone — `#REF!`-class at next read), so the dependent must
/// be dirtied and its subscriber notified.
#[test]
fn remove_referenced_sheet_notifies_dependents() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    wb.set_cell(data, "A1", Value::Number(5.0));
    assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    assert!(wb.remove_sheet(data).is_some());

    assert!(
        *fires.borrow() >= 1,
        "dependent of the removed sheet must be notified"
    );
    let after = wb.get_cell("Sheet1", "B1");
    assert_ne!(
        after,
        Value::Number(10.0),
        "value must not silently serve the pre-removal cache, got {after:?}"
    );
}

/// Chained cross-sheet dependents of a formula that referenced the
/// removed sheet propagate through the shared dirty BFS.
#[test]
fn remove_referenced_sheet_propagates_to_chained_dependents() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data"); // idx 1
    wb.add_sheet("Mid"); // idx 2
    wb.set_cell(data, "A1", Value::Number(5.0));
    assert!(wb.set_formula(2, "C1", "=Data!A1*2")); // Mid!C1
    assert!(wb.set_formula(0, "B1", "=Mid!C1+1")); // Sheet1!B1 (chained)
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(11.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    assert!(wb.remove_sheet(data).is_some());

    assert!(
        *fires.borrow() >= 1,
        "chained dependent must be notified through the BFS"
    );
}

// ===================================================================
// A-7: rename_sheet
// ===================================================================

/// Renaming the referenced sheet breaks `=Data!A1` (AST keeps the old
/// name) — the dependent's value changes, so it must dirty + notify.
#[test]
fn rename_sheet_notifies_dependents_of_old_name() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    wb.set_cell(data, "A1", Value::Number(5.0));
    assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    assert!(wb.rename_sheet(data, "Numbers"));

    assert!(
        *fires.borrow() >= 1,
        "dependent must be notified when the rename breaks its reference"
    );
    assert_ne!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
}

/// The inverse: a formula referencing a name that did NOT resolve
/// springs to life when a sheet is renamed TO that name. Its value
/// changes too, so it must dirty + notify.
#[test]
fn rename_sheet_notifies_dependents_of_new_name() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    wb.set_cell(data, "A1", Value::Number(5.0));
    // `Numbers` does not exist yet — B1 reads as a #REF!-class value.
    assert!(wb.set_formula(0, "B1", "=Numbers!A1*2"));
    let before = wb.get_cell("Sheet1", "B1");
    assert_ne!(before, Value::Number(10.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    assert!(wb.rename_sheet(data, "Numbers"));

    assert!(
        *fires.borrow() >= 1,
        "dependent must be notified when the rename makes its reference \
         resolve"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));

    // And the rebuilt edge must be live: upstream writes propagate.
    let after_rename_fires = *fires.borrow();
    wb.set_cell(data, "A1", Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
    assert!(*fires.borrow() > after_rename_fires);
}

// ===================================================================
// B-4: defined-name indirection
// ===================================================================

/// The audit's confirmed stale-value repro, now expected fresh AND
/// notified: `READDATA = LAMBDA(Data!A1)`, `B1 = =READDATA()`.
#[test]
fn named_lambda_cross_sheet_stays_fresh_and_notifies() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(1.0));
    wb.define_name("READDATA", "=LAMBDA(Data!A1)")
        .expect("define named lambda");
    assert!(wb.set_formula(0, "B1", "=READDATA()"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    wb.set_cell(1, "A1", Value::Number(2.0));
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Number(2.0),
        "B-4: named-lambda cross-sheet read must be fresh"
    );
    assert!(
        *fires.borrow() >= 1,
        "B-4: subscriber must fire on the upstream write"
    );
}

/// Nested named lambdas: the walker resolves names recursively
/// (`OUTER` body calls `INNER`, whose body holds the sheet ref).
#[test]
fn nested_named_lambda_cross_sheet_propagates() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(3.0));
    wb.define_name("INNER", "=LAMBDA(Data!A1)")
        .expect("define INNER");
    wb.define_name("OUTER", "=LAMBDA(INNER()*10)")
        .expect("define OUTER");
    assert!(wb.set_formula(0, "B1", "=OUTER()"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(30.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    wb.set_cell(1, "A1", Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(40.0));
    assert!(*fires.borrow() >= 1);
}

/// Mutually-recursive named lambdas must not hang the edge walker —
/// the visited-name set cuts the cycle. (`FNA` is defined before `FNB`
/// exists; `define_name` only evaluates the LAMBDA literal, not its
/// body, so the forward reference is legal.)
#[test]
fn named_lambda_name_cycle_terminates_and_propagates() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(5.0));
    wb.define_name("FNA", "=LAMBDA(IF(TRUE, Data!A1, FNB()))")
        .expect("define FNA");
    wb.define_name("FNB", "=LAMBDA(FNA())").expect("define FNB");

    // The walker descends FNA -> FNB -> FNA and must stop at the
    // visited name instead of recursing forever.
    assert!(wb.set_formula(0, "B1", "=FNA()"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(5.0));

    wb.set_cell(1, "A1", Value::Number(6.0));
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Number(6.0),
        "edge through the cyclic name pair must still register"
    );
}

/// Raw `Sheet::set_formula` install (bypasses workbook edge
/// registration): the workbook-level named-value latch must keep the
/// read-time force-recompute armed so reads stay fresh.
#[test]
fn raw_sheet_install_of_named_lambda_formula_reads_fresh() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(1.0));
    wb.define_name("READDATA", "=LAMBDA(Data!A1)")
        .expect("define named lambda");
    // Raw path: no cross-sheet edge, no per-sheet latch (the AST has
    // no SheetRef node).
    assert!(wb.sheet_mut(0).unwrap().set_formula("B1", "=READDATA()"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));

    wb.set_cell(1, "A1", Value::Number(2.0));
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Number(2.0),
        "workbook-level named-value latch must keep the cache honest"
    );
}

/// A formula installed BEFORE the name it references is defined must
/// still end up with a live edge — `define_name` rebuilds the
/// cross-sheet graph (TS-port parity: defineName recalcs all sheets).
#[test]
fn define_name_after_formula_install_registers_edges() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(1.0));
    // Formula first: `READDATA` is unbound, B1 reads #NAME?.
    assert!(wb.set_formula(0, "B1", "=READDATA()"));
    assert_ne!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));

    wb.define_name("READDATA", "=LAMBDA(Data!A1)")
        .expect("define named lambda");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    // The late-registered edge must carry dirty + notify fanout.
    wb.set_cell(1, "A1", Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
    assert!(
        *fires.borrow() >= 1,
        "edge registered by the define-time rebuild must notify"
    );
}

/// Bulk-installed (parked, `!`-free) `=READDATA()` formulas must still
/// get their cross-sheet edge — the `!`-prefilter is bypassed when a
/// registered named value carries a live sheet ref.
#[test]
fn bulk_installed_named_lambda_formula_gets_edge_and_notifies() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(1.0));
    wb.define_name("READDATA", "=LAMBDA(Data!A1)")
        .expect("define named lambda");

    let mut formulas: HashMap<CellAddress, String> = HashMap::new();
    formulas.insert(addr("B1"), "=READDATA()".to_string());
    wb.install_sheet_bulk(0, HashMap::new(), formulas)
        .expect("bulk install");
    let (fires, _sub) = counter(&mut wb, 0, "B1");

    wb.set_cell(1, "A1", Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
    assert!(
        *fires.borrow() >= 1,
        "parked named-lambda formula must be reachable by the fanout"
    );
}
