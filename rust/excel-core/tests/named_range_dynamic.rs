//! Tests for Goal B — dynamic range resolution via OFFSET.
//!
//! The `OFFSET(ref, row_off, col_off[, height[, width]])` function computes a
//! runtime range when used as an argument to aggregate functions (SUM, COUNT,
//! AVERAGE, VLOOKUP, INDEX, etc.), or returns the value of the top-left cell
//! when used as a scalar expression. This allows "named-range" patterns where
//! the range is derived programmatically rather than hard-coded as `A1:B5`.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

// ── Scalar OFFSET ───────────────────────────────────────────────────────────

/// `=OFFSET(A1, 0, 0)` — zero offset, returns value of A1 itself.
#[test]
fn offset_zero_offset_returns_anchor_value() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(42.0));
    wb.set_formula(0, "B1", "=OFFSET(A1,0,0)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(42.0));
}

/// `=OFFSET(A1, 1, 0)` — one row down from A1 → reads A2.
#[test]
fn offset_row_offset_reads_correct_cell() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Number(99.0));
    wb.set_formula(0, "B1", "=OFFSET(A1,1,0)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(99.0));
}

/// `=OFFSET(A1, 0, 2)` — two columns right from A1 → reads C1.
#[test]
fn offset_col_offset_reads_correct_cell() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "C1", Value::Number(7.0));
    wb.set_formula(0, "D1", "=OFFSET(A1,0,2)");
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(7.0));
}

/// Negative row offset: `=OFFSET(B2, -1, 0)` → reads B1.
#[test]
fn offset_negative_row_offset() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "B1", Value::Number(55.0));
    wb.set_formula(0, "C3", "=OFFSET(B2,-1,0)");
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(55.0));
}

/// Out-of-bounds (row goes negative) → InvalidRef.
#[test]
fn offset_out_of_bounds_is_invalid_ref() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "B1", "=OFFSET(A1,-1,0)");
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Error(ValueError::InvalidRef)
    );
}

/// Wrong argument count → WrongArgCount.
#[test]
fn offset_wrong_arg_count_is_error() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=OFFSET(B1)");
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ── OFFSET as a range argument to SUM ──────────────────────────────────────

/// `=SUM(OFFSET(A1,0,0,5,1))` sums A1:A5 dynamically.
#[test]
fn sum_offset_5x1_range() {
    let mut wb = Workbook::new();
    for i in 0u32..5 {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number((i + 1) as f64));
    }
    // A1..A5 = 1+2+3+4+5 = 15
    wb.set_formula(0, "B1", "=SUM(OFFSET(A1,0,0,5,1))");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(15.0));
}

/// `=SUM(OFFSET(A1,1,0,3,1))` sums A2:A4 (row offset 1, height 3).
#[test]
fn sum_offset_with_row_skip() {
    let mut wb = Workbook::new();
    for i in 0u32..5 {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number((i + 1) as f64));
    }
    // A2=2, A3=3, A4=4 → 9
    wb.set_formula(0, "B1", "=SUM(OFFSET(A1,1,0,3,1))");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(9.0));
}

/// Default height/width (3-arg OFFSET = 1×1): SUM over a single cell.
#[test]
fn sum_offset_3arg_single_cell() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A3", Value::Number(77.0));
    wb.set_formula(0, "B1", "=SUM(OFFSET(A1,2,0))");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(77.0));
}

// ── OFFSET as a range argument to COUNT ────────────────────────────────────

/// `=COUNT(OFFSET(A1,0,0,3,1))` counts numbers in A1:A3.
#[test]
fn count_offset_range() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Text("text".into())); // not counted
    wb.set_cell(0, "A3", Value::Number(3.0));
    wb.set_formula(0, "B1", "=COUNT(OFFSET(A1,0,0,3,1))");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
}

// ── OFFSET as a range argument to AVERAGE ──────────────────────────────────

/// `=AVERAGE(OFFSET(A1,0,0,4,1))` averages A1:A4.
#[test]
fn average_offset_range() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(10.0));
    wb.set_cell(0, "A2", Value::Number(20.0));
    wb.set_cell(0, "A3", Value::Number(30.0));
    wb.set_cell(0, "A4", Value::Number(40.0));
    wb.set_formula(0, "B1", "=AVERAGE(OFFSET(A1,0,0,4,1))");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(25.0));
}

// ── OFFSET as a range argument to VLOOKUP ──────────────────────────────────

/// VLOOKUP using an OFFSET-derived table range.
/// Table is at A1:B3 (key, value). OFFSET(A1,0,0,3,2) computes A1:B3
/// at runtime; VLOOKUP should find the correct row.
#[test]
fn vlookup_with_offset_range() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "B1", Value::Number(100.0));
    wb.set_cell(0, "A2", Value::Number(2.0));
    wb.set_cell(0, "B2", Value::Number(200.0));
    wb.set_cell(0, "A3", Value::Number(3.0));
    wb.set_cell(0, "B3", Value::Number(300.0));

    // VLOOKUP(2, OFFSET(A1,0,0,3,2), 2, FALSE) → 200
    wb.set_formula(0, "C1", "=VLOOKUP(2,OFFSET(A1,0,0,3,2),2,FALSE)");
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(200.0));
}

// ── Reactive update: OFFSET re-evaluates when source changes ───────────────

/// When A1 changes, `=OFFSET(A1,0,0)` must reflect the new value.
#[test]
fn offset_scalar_updates_on_dependency_change() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(10.0));
    wb.set_formula(0, "B1", "=OFFSET(A1,0,0)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));

    wb.set_cell(0, "A1", Value::Number(99.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(99.0));
}

/// When a cell within the OFFSET range changes, SUM must recompute.
#[test]
fn sum_offset_updates_when_range_cell_changes() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Number(2.0));
    wb.set_formula(0, "B1", "=SUM(OFFSET(A1,0,0,2,1))");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(3.0));

    wb.set_cell(0, "A2", Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(11.0));
}
