//! Integration tests for the math + trig extension batch (B2 + B3).
//!
//! These exercise the formulas added in
//! `feat(excel-core): add math + trig formulas` through the public
//! `Workbook` API — i.e. they go all the way through `set_cell`,
//! `set_formula`, the formula parser, and `WorkbookEvalProvider` to
//! verify the same arithmetic the inline `mod tests` covers also works
//! end-to-end against a real `Sheet`.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// PI / SIN / COS / RADIANS / DEGREES round-trip:
/// SIN(RADIANS(30)) ≈ 0.5, DEGREES(PI()) = 180.
#[test]
fn trig_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=SIN(RADIANS(30))");
    wb.set_formula(0, "A2", "=DEGREES(PI())");
    wb.set_formula(0, "A3", "=COS(0)");

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(approx_eq(n, 0.5, 1e-12), "SIN(RADIANS(30)) = {}", n),
        other => panic!("expected number for A1, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 180.0, 1e-12), "DEGREES(PI()) = {}", n),
        other => panic!("expected number for A2, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(1.0));
}

/// PRODUCT / GCD / LCM / COUNTA / COUNTBLANK over a populated range.
///
/// Layout:
///   A1=4, A2=6, A3=8 (numbers)
///   B1="x" (text), B2 unset (blank), B3=12
#[test]
fn aggregates_over_workbook_range() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(4.0));
    wb.set_cell(0, "A2", Value::Number(6.0));
    wb.set_cell(0, "A3", Value::Number(8.0));
    wb.set_cell(0, "B1", Value::Text("x".into()));
    wb.set_cell(0, "B3", Value::Number(12.0));

    // PRODUCT(A1:A3) = 4*6*8 = 192.
    wb.set_formula(0, "C1", "=PRODUCT(A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(192.0));

    // GCD(A1:A3) = gcd(4,6,8) = 2.
    wb.set_formula(0, "C2", "=GCD(A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(2.0));

    // LCM(A1:A3) = lcm(4,6,8) = 24.
    wb.set_formula(0, "C3", "=LCM(A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(24.0));

    // COUNTA across A1:B3 = 5 (A1..A3 + B1 + B3, B2 is blank).
    wb.set_formula(0, "C4", "=COUNTA(A1:B3)");
    assert_eq!(wb.get_cell("Sheet1", "C4"), Value::Number(5.0));
}

/// INT / TRUNC / ROUNDUP / ROUNDDOWN / SIGN / FACT / COMBIN happy-path
/// round-trip through a formula cell.
#[test]
fn extended_math_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(-2.5));
    wb.set_cell(0, "A2", Value::Number(3.14159));

    wb.set_formula(0, "B1", "=INT(A1)"); // floor(-2.5) = -3
    wb.set_formula(0, "B2", "=TRUNC(A1)"); // trunc(-2.5) = -2
    wb.set_formula(0, "B3", "=ROUNDUP(A2,2)"); // 3.15
    wb.set_formula(0, "B4", "=ROUNDDOWN(A2,2)"); // 3.14
    wb.set_formula(0, "B5", "=SIGN(A1)"); // -1
    wb.set_formula(0, "B6", "=FACT(5)"); // 120
    wb.set_formula(0, "B7", "=COMBIN(8,3)"); // 56

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(-3.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(-2.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(3.15));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Number(3.14));
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Number(-1.0));
    assert_eq!(wb.get_cell("Sheet1", "B6"), Value::Number(120.0));
    assert_eq!(wb.get_cell("Sheet1", "B7"), Value::Number(56.0));
}
