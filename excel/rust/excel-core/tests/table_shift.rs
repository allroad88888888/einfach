//! #32 Excel Table — T3 reactive invalidation, structural-follow re-eval,
//! and rename/column-rename formula-text rewrite (design doc
//! `design-excel-table.md` §5.3 / §5.4 / §8 / §4.3).
//!
//! T1 (`table_lifecycle.rs`) already asserts the registry-level geometry
//! matrix (how a Table RANGE follows a structural edit) and the `tables_epoch`
//! COUNTER. This suite asserts the T3 half those tests deferred:
//!   - a Table geometry change re-derives dependent structured-reference
//!     formulas to the correct new VALUE (functional),
//!   - the change propagates REACTIVELY to subscribers, and only to the
//!     formulas that resolved a Table (precision), cross-sheet included,
//!   - a Table rename rewrites referencing formula TEXT (`Old[…]` → `New[…]`)
//!     through BOTH the hydrated-AST and parked-source channels,
//!   - a column rename rewrites `Table[Old]` and table-less `[Old]`.

use std::cell::RefCell;
use std::rc::Rc;

use einfach_core::{Value, ValueError};
use einfach_excel_core::{CellAddress, CellRange, Workbook};

fn rng(sr: u32, sc: u32, er: u32, ec: u32) -> CellRange {
    CellRange::new(CellAddress::new(sr, sc), CellAddress::new(er, ec))
}

/// Inventory table at A1:C4 on Sheet1: headers Name/Qty/Price + 3 data rows
/// (qty 1/2/3, price 10/20/30).
fn inventory() -> Workbook {
    let mut wb = Workbook::new();
    for (a1, v) in [("A1", "Name"), ("B1", "Qty"), ("C1", "Price")] {
        wb.set_cell(0, a1, Value::Text(v.into()));
    }
    let rows = [("x", 1.0, 10.0), ("y", 2.0, 20.0), ("z", 3.0, 30.0)];
    for (i, (name, qty, price)) in rows.iter().enumerate() {
        let r = i + 2;
        wb.set_cell(0, &format!("A{r}"), Value::Text((*name).into()));
        wb.set_cell(0, &format!("B{r}"), Value::Number(*qty));
        wb.set_cell(0, &format!("C{r}"), Value::Number(*price));
    }
    wb.define_table(Some("Inventory"), 0, rng(0, 0, 3, 2), true)
        .expect("define Inventory");
    wb
}

fn formula(wb: &mut Workbook, sheet: usize, a1: &str) -> Option<String> {
    wb.sheet_mut(sheet).unwrap().get_formula(a1)
}

// ===================== structural-follow re-eval =====================

#[test]
fn delete_data_row_recomputes_dependent_reference() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
    // Delete the last data row (row index 3 = "z"/qty 3). The Table shrinks
    // to A1:C3 and the dependent aggregate re-derives.
    wb.delete_rows(0, 3, 1);
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(3.0));
}

#[test]
fn insert_row_inside_data_then_fill_recomputes() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
    // Insert a blank row inside the data area — the Table grows to A1:C5 but
    // the blank Qty contributes 0, so the sum is unchanged…
    wb.insert_rows(0, 2, 1);
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
    // …until the new data cell is filled, when the grown Table picks it up.
    wb.set_cell(0, "B3", Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(16.0));
}

#[test]
fn insert_column_inside_shifts_referenced_column() {
    let mut wb = inventory();
    // Anchor the check formula in column A (index 0) so the column insert at
    // index 1 does not relocate the formula cell itself.
    assert!(wb.set_formula(0, "A6", "=SUM(Inventory[Price])"));
    assert_eq!(wb.get_cell("Sheet1", "A6"), Value::Number(60.0));
    // Insert a column inside the Table (before Price). Price shifts right one
    // column; the structured reference resolves it by NAME, so the sum holds.
    wb.insert_columns(0, 1, 1);
    assert_eq!(wb.get_cell("Sheet1", "A6"), Value::Number(60.0));
}

// ===================== reactive epoch invalidation =====================

/// `delete_table` touches NO cell facade — only the registry + epoch. So a
/// subscriber on a dependent structured-reference formula firing on delete
/// isolates the reactive `tables_epoch` seam (design §8). Without it the
/// materialized formula would keep its stale value until a forced re-read.
#[test]
fn delete_table_reactively_invalidates_dependent_subscriber() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    // Materialize + read so the formula-inner atom exists and holds a
    // `depend_tables` edge.
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));

    let fires = Rc::new(RefCell::new(0u32));
    let f = fires.clone();
    wb.sheet_mut(0)
        .unwrap()
        .subscribe_cell("E1", move || *f.borrow_mut() += 1);

    wb.delete_table("Inventory").expect("delete");

    assert!(
        *fires.borrow() >= 1,
        "delete_table must reactively wake the dependent structured-reference \
         formula; got {} fires",
        *fires.borrow()
    );
    assert_eq!(
        wb.get_cell("Sheet1", "E1"),
        Value::Error(ValueError::InvalidName),
        "the reference to the removed Table now surfaces #NAME?"
    );
}

/// Precision: a formula with NO structured reference holds no `tables_epoch`
/// edge, so a Table mutation must not wake it.
#[test]
fn table_mutation_does_not_wake_unrelated_formula() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    assert!(wb.set_formula(0, "F1", "=1+2"));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "F1"), Value::Number(3.0));

    let e_fires = Rc::new(RefCell::new(0u32));
    let f_fires = Rc::new(RefCell::new(0u32));
    let e = e_fires.clone();
    let f = f_fires.clone();
    wb.sheet_mut(0)
        .unwrap()
        .subscribe_cell("E1", move || *e.borrow_mut() += 1);
    wb.sheet_mut(0)
        .unwrap()
        .subscribe_cell("F1", move || *f.borrow_mut() += 1);

    // Rename the Table (name change only, no value change). E1's value is
    // stable, so it need not fire; F1 must not fire either way.
    wb.rename_table("Inventory", "Stock").expect("rename");

    assert_eq!(
        *f_fires.borrow(),
        0,
        "an unrelated formula must never wake on a Table mutation"
    );
    // E1 still resolves (its text was rewritten to the new name).
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
}

/// A formula that references a Table that does not exist YET registers the
/// epoch edge on its `#NAME?` miss, so defining the Table later re-derives it.
#[test]
fn reference_before_define_resolves_after_define() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("Qty".into()));
    wb.set_cell(0, "A2", Value::Number(4.0));
    wb.set_cell(0, "A3", Value::Number(6.0));
    assert!(wb.set_formula(0, "C1", "=SUM(Ledger[Qty])"));
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Error(ValueError::InvalidName),
        "no Table yet → #NAME?"
    );

    let fires = Rc::new(RefCell::new(0u32));
    let f = fires.clone();
    wb.sheet_mut(0)
        .unwrap()
        .subscribe_cell("C1", move || *f.borrow_mut() += 1);

    wb.define_table(Some("Ledger"), 0, rng(0, 0, 2, 0), true)
        .expect("define Ledger");

    assert!(
        *fires.borrow() >= 1,
        "defining the referenced Table must reactively re-derive the formula"
    );
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(10.0));
}

// ===================== cross-sheet invalidation =====================

/// A formula on Sheet2 referencing a Table on Sheet1 re-derives when that
/// Table's geometry changes — the shared workbook Store carries the single
/// `tables_epoch` edge across sheets (design §8 cross-sheet smoke).
#[test]
fn cross_sheet_reference_recomputes_on_table_geometry_change() {
    let mut wb = inventory();
    wb.add_sheet("Sheet2");
    let s2 = wb.index_of("Sheet2").unwrap();
    assert!(wb.set_formula(s2, "A1", "=SUM(Inventory[Qty])"));
    assert_eq!(wb.get_cell("Sheet2", "A1"), Value::Number(6.0));

    let fires = Rc::new(RefCell::new(0u32));
    let f = fires.clone();
    wb.sheet_mut(s2)
        .unwrap()
        .subscribe_cell("A1", move || *f.borrow_mut() += 1);

    // Shrink the Table on Sheet1; the Sheet2 formula must follow.
    wb.delete_rows(0, 3, 1);

    assert!(
        *fires.borrow() >= 1,
        "cross-sheet structured reference must wake on the anchor Table's change"
    );
    assert_eq!(wb.get_cell("Sheet2", "A1"), Value::Number(3.0));
}

// ===================== rename → formula-text rewrite =====================

#[test]
fn rename_rewrites_hydrated_formula_text_and_value() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    // Read BEFORE rename → the formula hydrates (exercises the AST channel).
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));

    wb.rename_table("Inventory", "Stock").expect("rename");

    assert_eq!(
        formula(&mut wb, 0, "E1").as_deref(),
        Some("=SUM(Stock[Qty])"),
        "the hydrated formula's text is rewritten to the new Table name"
    );
    assert_eq!(
        wb.get_cell("Sheet1", "E1"),
        Value::Number(6.0),
        "and it still resolves against the renamed Table"
    );
    // The old name no longer resolves.
    assert!(wb.set_formula(0, "E2", "=SUM(Inventory[Qty])"));
    assert_eq!(
        wb.get_cell("Sheet1", "E2"),
        Value::Error(ValueError::InvalidName)
    );
}

#[test]
fn rename_rewrites_parked_formula_text() {
    let mut wb = inventory();
    // Set but NEVER read before the rename → the source stays parked, so the
    // parked-source rewrite channel is exercised (not the AST channel).
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Price])*2"));
    wb.rename_table("Inventory", "Stock").expect("rename");

    // `render_formula` parenthesizes the top-level BinOp on re-render — the
    // AST (and value) is unchanged; only the text is normalized.
    assert_eq!(
        formula(&mut wb, 0, "E1").as_deref(),
        Some("=(SUM(Stock[Price])*2)"),
        "the still-parked source is rewritten before its first hydration"
    );
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(120.0));
}

#[test]
fn rename_leaves_unrelated_and_bare_references_untouched() {
    let mut wb = inventory();
    // A plain arithmetic formula and a same-name-substring reference that is
    // NOT this Table must not be rewritten.
    assert!(wb.set_formula(0, "E1", "=B2+C2"));
    assert!(wb.set_formula(0, "E2", "=SUM(Inventory[Qty])"));
    wb.rename_table("Inventory", "Stock").expect("rename");
    assert_eq!(formula(&mut wb, 0, "E1").as_deref(), Some("=B2+C2"));
    assert_eq!(formula(&mut wb, 0, "E2").as_deref(), Some("=SUM(Stock[Qty])"));
}

// ===================== column rename → formula-text rewrite =========

#[test]
fn column_rename_rewrites_qualified_reference() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));

    wb.rename_table_column("Inventory", "Qty", "Quantity")
        .expect("rename column");

    assert_eq!(
        formula(&mut wb, 0, "E1").as_deref(),
        Some("=SUM(Inventory[Quantity])")
    );
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
    // The old column name no longer resolves (design §4.3: eval-time #REF!).
    assert!(wb.set_formula(0, "E2", "=SUM(Inventory[Qty])"));
    assert_eq!(
        wb.get_cell("Sheet1", "E2"),
        Value::Error(ValueError::InvalidRef)
    );
}

#[test]
fn column_rename_rewrites_bare_reference_inside_table() {
    // A calculated column using the table-less `[@Col]` form. Renaming that
    // column must rewrite the in-body reference too (anchor-sheet bare form).
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("In".into()));
    wb.set_cell(0, "B1", Value::Text("Out".into()));
    wb.set_cell(0, "A2", Value::Number(5.0));
    wb.set_cell(0, "A3", Value::Number(7.0));
    wb.define_table(Some("Calc"), 0, rng(0, 0, 2, 1), true)
        .expect("define Calc");
    assert!(wb.set_formula(0, "B2", "=[@In]*2"));
    assert!(wb.set_formula(0, "B3", "=[@In]*2"));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(10.0));

    wb.rename_table_column("Calc", "In", "Input")
        .expect("rename column");

    // Re-render parenthesizes the top-level BinOp; the reference itself is
    // rewritten `[@In]` → `[@Input]`.
    assert_eq!(formula(&mut wb, 0, "B2").as_deref(), Some("=([@Input]*2)"));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(14.0));
}

#[test]
fn column_rename_error_surfaces() {
    use einfach_excel_core::TableError;
    let mut wb = inventory();
    assert_eq!(
        wb.rename_table_column("Inventory", "Nope", "X"),
        Err(TableError::ColumnNotFound)
    );
    assert_eq!(
        wb.rename_table_column("Inventory", "Qty", "Price"),
        Err(TableError::DuplicateColumn),
        "collision with a different existing column is rejected"
    );
    assert_eq!(
        wb.rename_table_column("Inventory", "Qty", "  "),
        Err(TableError::InvalidColumnName)
    );
    // A case-only rename of the same column is allowed.
    wb.rename_table_column("Inventory", "Qty", "QTY")
        .expect("case-only column rename");
}
