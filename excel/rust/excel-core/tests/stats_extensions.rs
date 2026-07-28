//! Integration tests for the statistical extension batch
//! (AVERAGEA / RANK / RANKEQ / RANKAVG / PERCENTILE / QUARTILE /
//! CORREL / SLOPE / INTERCEPT).
//!
//! These exercise the formulas through the public `Workbook` API — i.e.
//! they go all the way through `set_cell`, `set_formula`, the formula
//! parser, and `WorkbookEvalProvider` to verify the same arithmetic the
//! inline `mod tests` covers also works end-to-end against a real
//! `Sheet`.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// Build a small dataset and verify the rank family / averagea via the
/// Workbook + formula pipeline.
///
/// Layout:
///   A1..A5 = 2, 4, 6, 8, 10
///   B1..B3 = 10, 10, 5     (ties for RANK.AVG)
///   D1=TRUE, D2=FALSE, D3="hello", D4 unset (blank), D5=5
#[test]
fn stats_rank_and_averagea_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    wb.set_cell(0, "B1", Value::Number(10.0));
    wb.set_cell(0, "B2", Value::Number(10.0));
    wb.set_cell(0, "B3", Value::Number(5.0));

    wb.set_cell(0, "D1", Value::Boolean(true));
    wb.set_cell(0, "D2", Value::Boolean(false));
    wb.set_cell(0, "D3", Value::Text("hello".into()));
    // D4 left blank.
    wb.set_cell(0, "D5", Value::Number(5.0));

    // RANK(6, A1:A5) desc → 2 values > 6 → rank 3.
    wb.set_formula(0, "F1", "=RANK(6,A1:A5)");
    // RANKEQ alias.
    wb.set_formula(0, "F2", "=RANKEQ(6,A1:A5)");
    // RANKAVG on ties: 10 in (10,10,5) desc → average(1,2) = 1.5.
    wb.set_formula(0, "F3", "=RANKAVG(10,B1:B3)");
    // AVERAGEA across mixed types: 1 + 0 + 0 + 5 over 4 counted → 1.5.
    wb.set_formula(0, "F4", "=AVERAGEA(D1:D5)");

    assert_eq!(wb.get_cell("Sheet1", "F1"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "F2"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "F3"), Value::Number(1.5));
    assert_eq!(wb.get_cell("Sheet1", "F4"), Value::Number(1.5));
}

/// PERCENTILE / QUARTILE over an evenly spaced dataset.
///
/// A1..A5 = 2, 4, 6, 8, 10 sorted ascending:
///   PERCENTILE(.,0)    = 2
///   PERCENTILE(.,1)    = 10
///   PERCENTILE(.,0.5)  = 6
///   PERCENTILE(.,0.1)  = 2.8
///   QUARTILE(.,0)      = 2
///   QUARTILE(.,2)      = 6 (== PERCENTILE k=0.5)
///   QUARTILE(.,4)      = 10
#[test]
fn stats_percentile_and_quartile_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }

    wb.set_formula(0, "B1", "=PERCENTILE(A1:A5,0)");
    wb.set_formula(0, "B2", "=PERCENTILE(A1:A5,1)");
    wb.set_formula(0, "B3", "=PERCENTILE(A1:A5,0.5)");
    wb.set_formula(0, "B4", "=PERCENTILE(A1:A5,0.1)");
    wb.set_formula(0, "B5", "=QUARTILE(A1:A5,0)");
    wb.set_formula(0, "B6", "=QUARTILE(A1:A5,2)");
    wb.set_formula(0, "B7", "=QUARTILE(A1:A5,4)");

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(6.0));
    match wb.get_cell("Sheet1", "B4") {
        Value::Number(n) => assert!(approx_eq(n, 2.8, 1e-12), "B4 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B6"), Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "B7"), Value::Number(10.0));
}

/// CORREL / SLOPE / INTERCEPT over a perfectly linear dataset (y = 2x).
///
/// A1..A5 = 2, 4, 6, 8, 10    (x)
/// B1..B5 = 4, 8, 12, 16, 20  (y = 2x)
/// C1..C5 = 10, 8, 6, 4, 2    (inverse → CORREL = -1)
#[test]
fn stats_correl_slope_intercept_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    for (i, n) in [4.0, 8.0, 12.0, 16.0, 20.0].iter().enumerate() {
        wb.set_cell(0, &format!("B{}", i + 1), Value::Number(*n));
    }
    for (i, n) in [10.0, 8.0, 6.0, 4.0, 2.0].iter().enumerate() {
        wb.set_cell(0, &format!("C{}", i + 1), Value::Number(*n));
    }

    wb.set_formula(0, "E1", "=CORREL(A1:A5,B1:B5)"); // 1.0
    wb.set_formula(0, "E2", "=CORREL(A1:A5,C1:C5)"); // -1.0
    wb.set_formula(0, "E3", "=SLOPE(B1:B5,A1:A5)"); // 2
    wb.set_formula(0, "E4", "=INTERCEPT(B1:B5,A1:A5)"); // 0

    match wb.get_cell("Sheet1", "E1") {
        Value::Number(n) => assert!(approx_eq(n, 1.0, 1e-12), "E1 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
    match wb.get_cell("Sheet1", "E2") {
        Value::Number(n) => assert!(approx_eq(n, -1.0, 1e-12), "E2 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
    match wb.get_cell("Sheet1", "E3") {
        Value::Number(n) => assert!(approx_eq(n, 2.0, 1e-12), "E3 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
    match wb.get_cell("Sheet1", "E4") {
        Value::Number(n) => assert!(approx_eq(n, 0.0, 1e-12), "E4 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
}
