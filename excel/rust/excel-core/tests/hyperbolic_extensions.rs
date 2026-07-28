//! Integration tests for the hyperbolic + reciprocal-trig extension
//! batch.
//!
//! These exercise the formulas added in
//! `feat(excel-core): add hyperbolic + reciprocal trig` through the
//! public `Workbook` API — i.e. they go all the way through `set_cell`,
//! `set_formula`, the formula parser, and `WorkbookEvalProvider` to
//! verify the same arithmetic the inline `mod tests` covers also works
//! end-to-end against a real `Sheet`.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// SINH / COSH / TANH round-trip through the workbook.
///
/// Layout: A1 = 0, A2 = 1.
#[test]
fn hyperbolic_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(0.0));
    wb.set_cell(0, "A2", Value::Number(1.0));

    wb.set_formula(0, "B1", "=SINH(A1)"); // sinh(0)=0
    wb.set_formula(0, "B2", "=COSH(A1)"); // cosh(0)=1
    wb.set_formula(0, "B3", "=TANH(A2)"); // tanh(1)
    wb.set_formula(0, "B4", "=ASINH(SINH(A2))"); // identity → 1
    wb.set_formula(0, "B5", "=ACOSH(1)"); // 0

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(0.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(1.0));
    match wb.get_cell("Sheet1", "B3") {
        Value::Number(n) => {
            assert!(approx_eq(n, 1.0f64.tanh(), 1e-12), "TANH(1) = {n}")
        }
        other => panic!("expected number for B3, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "B4") {
        Value::Number(n) => assert!(approx_eq(n, 1.0, 1e-12), "ASINH(SINH(1)) = {n}"),
        other => panic!("expected number for B4, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Number(0.0));
}

/// CSC / SEC / COT and their reciprocal-hyperbolic siblings through the
/// workbook, including a `#DIV/0!` propagation at COT(0).
#[test]
fn reciprocal_trig_round_trip_through_workbook() {
    let mut wb = Workbook::new();

    wb.set_formula(0, "A1", "=CSC(PI()/2)"); // 1
    wb.set_formula(0, "A2", "=SEC(0)"); // 1
    wb.set_formula(0, "A3", "=COT(PI()/4)"); // 1
    wb.set_formula(0, "A4", "=COT(0)"); // #DIV/0!
    wb.set_formula(0, "A5", "=SECH(0)"); // 1
    wb.set_formula(0, "A6", "=CSCH(0)"); // #DIV/0!

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(approx_eq(n, 1.0, 1e-12), "CSC(PI/2) = {n}"),
        other => panic!("expected number for A1, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 1.0, 1e-12), "SEC(0) = {n}"),
        other => panic!("expected number for A2, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => assert!(approx_eq(n, 1.0, 1e-12), "COT(PI/4) = {n}"),
        other => panic!("expected number for A3, got {:?}", other),
    }
    assert_eq!(
        wb.get_cell("Sheet1", "A4"),
        Value::Error(ValueError::DivisionByZero)
    );
    assert_eq!(wb.get_cell("Sheet1", "A5"), Value::Number(1.0));
    assert_eq!(
        wb.get_cell("Sheet1", "A6"),
        Value::Error(ValueError::DivisionByZero)
    );
}

/// Inverse reciprocal-trig and ACOT-of-zero through the workbook.
/// Verifies domain errors surface as `#NUM!` and that ACOT picks the
/// (0, PI) branch.
#[test]
fn inverse_reciprocal_trig_round_trip_through_workbook() {
    let mut wb = Workbook::new();

    wb.set_formula(0, "A1", "=ACSC(2)"); // PI/6
    wb.set_formula(0, "A2", "=ASEC(2)"); // PI/3
    wb.set_formula(0, "A3", "=ACOT(0)"); // PI/2
    wb.set_formula(0, "A4", "=ACOT(-1)"); // 3*PI/4
    wb.set_formula(0, "A5", "=ACSC(0.5)"); // #NUM!
    wb.set_formula(0, "A6", "=ATANH(2)"); // #NUM!

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(
            approx_eq(n, std::f64::consts::FRAC_PI_6, 1e-12),
            "ACSC(2) = {n}"
        ),
        other => panic!("expected number for A1, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(
            approx_eq(n, std::f64::consts::FRAC_PI_3, 1e-12),
            "ASEC(2) = {n}"
        ),
        other => panic!("expected number for A2, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => assert!(
            approx_eq(n, std::f64::consts::FRAC_PI_2, 1e-12),
            "ACOT(0) = {n}"
        ),
        other => panic!("expected number for A3, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "A4") {
        Value::Number(n) => assert!(
            approx_eq(n, 3.0 * std::f64::consts::FRAC_PI_4, 1e-12),
            "ACOT(-1) = {n}"
        ),
        other => panic!("expected number for A4, got {:?}", other),
    }
    assert_eq!(
        wb.get_cell("Sheet1", "A5"),
        Value::Error(ValueError::Overflow)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "A6"),
        Value::Error(ValueError::Overflow)
    );
}
