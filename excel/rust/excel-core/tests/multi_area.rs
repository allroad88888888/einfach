//! End-to-end tests for Excel's multi-area reference syntax
//! `(A1:B2, D5:E6)` and the `AREAS` function.
//!
//! The multi-area form parses as `Expr::MultiArea(Vec<Expr>)` — see
//! `formula::Expr::MultiArea` — and only `AREAS` consumes the AST
//! directly. Other functions that receive a multi-area argument
//! surface `#VALUE!` (their per-argument range walker doesn't
//! understand the union form). These tests pin both behaviours through
//! a `Workbook` so the AST descents in shift/sheet/workbook all stay
//! consistent end-to-end.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

#[test]
fn areas_counts_two_part_multi_area() {
    let mut wb = Workbook::new();
    // Anchor the formula well outside any of the referenced ranges so
    // the cycle pre-check doesn't see a self-reference.
    assert!(wb.set_formula(0, "Z1", "=AREAS((A1:B2, D5:E6))"));
    assert_eq!(wb.get_cell("Sheet1", "Z1"), Value::Number(2.0));
}

#[test]
fn areas_counts_three_part_multi_area() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "Z1", "=AREAS((A1:B2, D5:E6, F1))"));
    assert_eq!(wb.get_cell("Sheet1", "Z1"), Value::Number(3.0));
}

#[test]
fn areas_single_ref_is_one() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=AREAS(B5)"));
    assert!(wb.set_formula(0, "A2", "=AREAS(B5:D10)"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(1.0));
}

/// SUM doesn't walk a multi-area — Excel surfaces #VALUE! and so do
/// we. This pins the "AREAS is the only consumer in this version"
/// contract.
#[test]
fn sum_of_multi_area_is_value_error() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "Z1", "=SUM((B1:B3, C1:C3))"));
    assert_eq!(
        wb.get_cell("Sheet1", "Z1"),
        Value::Error(ValueError::InvalidValue)
    );
}
