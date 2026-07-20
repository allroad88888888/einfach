//! #32 Excel Table — T5: totals-row engine semantics (design doc
//! `design-excel-table.md` §7 / I5).
//!
//! Asserts the engine half of the totals row:
//!   - toggle ON grows the Table range one row and writes a default
//!     `=SUBTOTAL(109, Table[LastCol])` (SUM) in the last column only,
//!   - toggle OFF clears the totals cells and shrinks the range,
//!   - occupied target row is rejected (`TotalsRowBlocked`, no implicit
//!     row push),
//!   - per-column function selection writes/clears `=SUBTOTAL(1xx, …)`,
//!   - totals formulas participate in the recompute graph (data change,
//!     hidden-row exclusion via the 101-111 band) and follow the Table
//!     through rename / column-rename / structural edits.

use einfach_core::Value;
use einfach_excel_core::{CellAddress, CellRange, TableError, TotalsFunction, Workbook};

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

fn num(wb: &Workbook, a1: &str) -> f64 {
    match wb.get_cell("Sheet1", a1) {
        Value::Number(n) => n,
        other => panic!("expected number at {a1}, got {other:?}"),
    }
}

fn formula(wb: &mut Workbook, a1: &str) -> String {
    wb.sheet_mut(0)
        .unwrap()
        .get_formula(a1)
        .unwrap_or_else(|| panic!("expected a formula at {a1}"))
}

// ============================ toggle ON =============================

#[test]
fn toggle_on_grows_range_and_writes_default_sum_last_column() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");

    let entry = wb.get_table("Inventory").unwrap();
    assert!(entry.has_totals(), "has_totals flag set");
    // Range grew one row: A1:C4 → A1:C5.
    assert_eq!(entry.range(), rng(0, 0, 4, 2), "range grew one row");

    // Default SUM in the LAST column only (Price / column C, row 5).
    assert_eq!(num(&wb, "C5"), 60.0, "default SUM(Price) totals value");
    let f = formula(&mut wb, "C5");
    assert_eq!(
        f, "=SUBTOTAL(109,Inventory[Price])",
        "canonical generated totals formula"
    );
    // Other totals cells stay empty (Excel default touches only last column).
    assert_eq!(wb.get_cell("Sheet1", "A5"), Value::Null);
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Null);
}

#[test]
fn toggle_on_case_insensitive_name() {
    let mut wb = inventory();
    wb.set_table_totals_row("inVENTory", true).expect("enable");
    assert!(wb.get_table("Inventory").unwrap().has_totals());
}

#[test]
fn toggle_on_occupied_row_is_rejected_without_mutation() {
    let mut wb = inventory();
    // Occupy a cell in the row directly below the table (row 5, column B).
    wb.set_cell(0, "B5", Value::Text("busy".into()));
    let err = wb.set_table_totals_row("Inventory", true).unwrap_err();
    assert_eq!(err, TableError::TotalsRowBlocked);
    // Nothing changed: no totals flag, range unchanged, cell intact.
    let entry = wb.get_table("Inventory").unwrap();
    assert!(!entry.has_totals());
    assert_eq!(entry.range(), rng(0, 0, 3, 2));
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Text("busy".into()));
}

#[test]
fn toggle_on_is_idempotent() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    // Second enable is a no-op success — must NOT grow the range again or
    // trip the occupancy guard on its own totals cell.
    wb.set_table_totals_row("Inventory", true)
        .expect("second enable is a no-op");
    let entry = wb.get_table("Inventory").unwrap();
    assert_eq!(entry.range(), rng(0, 0, 4, 2));
    assert_eq!(num(&wb, "C5"), 60.0);
}

#[test]
fn toggle_unknown_table_is_not_found() {
    let mut wb = inventory();
    assert_eq!(
        wb.set_table_totals_row("Nope", true).unwrap_err(),
        TableError::NotFound
    );
}

// ============================ toggle OFF ============================

#[test]
fn toggle_off_clears_cells_and_shrinks_range() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    // Give another column a total too, so we can assert it is also cleared.
    wb.set_table_total_function("Inventory", "Qty", TotalsFunction::Sum)
        .expect("qty sum");
    assert_eq!(num(&wb, "B5"), 6.0);

    wb.set_table_totals_row("Inventory", false).expect("disable");
    let entry = wb.get_table("Inventory").unwrap();
    assert!(!entry.has_totals());
    assert_eq!(entry.range(), rng(0, 0, 3, 2), "range shrank one row");
    // Both totals cells cleared.
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Null);
    assert_eq!(wb.get_cell("Sheet1", "C5"), Value::Null);
}

#[test]
fn toggle_off_clears_hand_edited_totals_cell() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    // User overwrites a totals cell with an arbitrary formula.
    assert!(wb.set_formula(0, "A5", "=1+2"));
    assert_eq!(num(&wb, "A5"), 3.0);
    wb.set_table_totals_row("Inventory", false).expect("disable");
    // Toggle off clears the whole totals row within the column span.
    assert_eq!(wb.get_cell("Sheet1", "A5"), Value::Null);
}

#[test]
fn toggle_off_when_absent_is_idempotent() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", false)
        .expect("disable when absent is a no-op");
    assert!(!wb.get_table("Inventory").unwrap().has_totals());
}

// ===================== per-column function select ====================

#[test]
fn set_total_function_average_then_sum_then_none() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");

    wb.set_table_total_function("Inventory", "Qty", TotalsFunction::Average)
        .expect("avg");
    assert_eq!(num(&wb, "B5"), 2.0, "AVERAGE(Qty) = (1+2+3)/3");
    assert_eq!(formula(&mut wb, "B5"), "=SUBTOTAL(101,Inventory[Qty])");

    wb.set_table_total_function("Inventory", "Qty", TotalsFunction::Sum)
        .expect("sum");
    assert_eq!(num(&wb, "B5"), 6.0, "SUM(Qty)");
    assert_eq!(formula(&mut wb, "B5"), "=SUBTOTAL(109,Inventory[Qty])");

    wb.set_table_total_function("Inventory", "Qty", TotalsFunction::None)
        .expect("none clears");
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Null, "none clears cell");
}

#[test]
fn count_and_countnums_diverge() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    // Name column is all text.
    wb.set_table_total_function("Inventory", "Name", TotalsFunction::Count)
        .expect("count");
    assert_eq!(num(&wb, "A5"), 3.0, "COUNTA(Name) = 3 non-empty");
    assert_eq!(formula(&mut wb, "A5"), "=SUBTOTAL(103,Inventory[Name])");

    wb.set_table_total_function("Inventory", "Name", TotalsFunction::CountNums)
        .expect("countNums");
    assert_eq!(num(&wb, "A5"), 0.0, "COUNT(Name) = 0 numbers");
    assert_eq!(formula(&mut wb, "A5"), "=SUBTOTAL(102,Inventory[Name])");
}

#[test]
fn set_total_function_requires_totals_row() {
    let mut wb = inventory();
    assert_eq!(
        wb.set_table_total_function("Inventory", "Qty", TotalsFunction::Sum)
            .unwrap_err(),
        TableError::NoTotalsRow
    );
}

#[test]
fn set_total_function_unknown_column() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    assert_eq!(
        wb.set_table_total_function("Inventory", "Ghost", TotalsFunction::Sum)
            .unwrap_err(),
        TableError::ColumnNotFound
    );
}

#[test]
fn total_function_column_match_is_case_insensitive() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    wb.set_table_total_function("Inventory", "qTy", TotalsFunction::Sum)
        .expect("case-insensitive column");
    assert_eq!(num(&wb, "B5"), 6.0);
}

// ===================== recompute / invalidation ======================

#[test]
fn column_data_change_recomputes_total() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    assert_eq!(num(&wb, "C5"), 60.0);
    wb.set_cell(0, "C2", Value::Number(100.0)); // price 10 → 100
    assert_eq!(num(&wb, "C5"), 150.0, "totals re-derives on data change");
}

#[test]
fn hidden_row_excluded_from_total() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    assert_eq!(num(&wb, "C5"), 60.0);
    // Hide the "z" data row (0-based row index 3). SUBTOTAL(109) excludes it.
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(
        num(&wb, "C5"),
        30.0,
        "SUBTOTAL(109) totals exclude host-hidden rows (101-111 band)"
    );
    // Unhide restores.
    wb.set_eval_hidden_rows(0, &[]);
    assert_eq!(num(&wb, "C5"), 60.0);
}

// ===================== rename / structural follow ====================

#[test]
fn rename_table_rewrites_totals_formula() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    wb.rename_table("Inventory", "Stock").expect("rename");
    // Totals formula text follows the rename; value unchanged.
    assert_eq!(formula(&mut wb, "C5"), "=SUBTOTAL(109,Stock[Price])");
    assert_eq!(num(&wb, "C5"), 60.0);
}

#[test]
fn rename_column_rewrites_totals_formula() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    wb.rename_table_column("Inventory", "Price", "Cost")
        .expect("rename column");
    assert_eq!(formula(&mut wb, "C5"), "=SUBTOTAL(109,Inventory[Cost])");
    assert_eq!(num(&wb, "C5"), 60.0);
}

#[test]
fn insert_row_inside_data_moves_totals_and_recomputes() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    // Insert a blank row inside the data area (0-based row 2). Table grows to
    // A1:C6; the totals formula cell shifts from C5 to C6.
    wb.insert_rows(0, 2, 1);
    assert_eq!(wb.get_table("Inventory").unwrap().range(), rng(0, 0, 5, 2));
    assert_eq!(num(&wb, "C6"), 60.0, "blank inserted row contributes 0");
    // Fill the new Price cell (C3) → total picks it up.
    wb.set_cell(0, "C3", Value::Number(100.0));
    assert_eq!(num(&wb, "C6"), 160.0);
}

#[test]
fn delete_data_row_shrinks_and_totals_follow() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("enable");
    // Delete the first data row (0-based row 1: x/price 10). Table shrinks to
    // A1:C4; totals formula cell shifts from C5 to C4.
    wb.delete_rows(0, 1, 1);
    assert_eq!(wb.get_table("Inventory").unwrap().range(), rng(0, 0, 3, 2));
    assert_eq!(num(&wb, "C4"), 50.0, "SUM(Price) after row delete = 20+30");
}

// ===================== TotalsFunction id round-trip ==================

#[test]
fn totals_function_id_round_trip() {
    for f in [
        TotalsFunction::None,
        TotalsFunction::Average,
        TotalsFunction::Count,
        TotalsFunction::CountNums,
        TotalsFunction::Max,
        TotalsFunction::Min,
        TotalsFunction::Sum,
        TotalsFunction::StdDev,
        TotalsFunction::Var,
    ] {
        assert_eq!(TotalsFunction::from_id(f.id()), Some(f), "{}", f.id());
    }
    assert_eq!(TotalsFunction::from_id("bogus"), None);
    // None clears; every other variant maps into the 101-111 hidden band.
    assert_eq!(TotalsFunction::None.subtotal_code(), None);
    for f in [
        TotalsFunction::Average,
        TotalsFunction::Max,
        TotalsFunction::Var,
    ] {
        let code = f.subtotal_code().unwrap();
        assert!((101..=111).contains(&code), "{} → {code}", f.id());
    }
}
