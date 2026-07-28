//! Integration tests for Excel 2010+ dotted-name function aliases.
//!
//! The formula parser was extended to allow `.` inside function
//! identifiers; these tests exercise the full pipeline (Workbook +
//! parser + evaluator) for the new dispatcher arms.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// RANK.EQ / RANK.AVG / PERCENTILE.INC / QUARTILE.INC are pure aliases
/// of RANK / RANKAVG / PERCENTILE / QUARTILE. Verify they reach the
/// same answers through `set_formula`.
#[test]
fn dotted_names_pure_aliases_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    // Ties for RANK.AVG.
    wb.set_cell(0, "B1", Value::Number(10.0));
    wb.set_cell(0, "B2", Value::Number(10.0));
    wb.set_cell(0, "B3", Value::Number(5.0));

    wb.set_formula(0, "F1", "=RANK.EQ(6,A1:A5)"); // rank(6) desc → 3
    wb.set_formula(0, "F2", "=RANK.AVG(10,B1:B3)"); // ties → 1.5
    wb.set_formula(0, "F3", "=PERCENTILE.INC(A1:A5,0.5)"); // median → 6
    wb.set_formula(0, "F4", "=QUARTILE.INC(A1:A5,2)"); // Q2 → 6

    assert_eq!(wb.get_cell("Sheet1", "F1"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "F2"), Value::Number(1.5));
    assert_eq!(wb.get_cell("Sheet1", "F3"), Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "F4"), Value::Number(6.0));
}

/// STDEV.P / VAR.P (population) must differ from STDEV.S / VAR.S
/// (sample) over the same data. Canonical Wikipedia example.
#[test]
fn dotted_names_population_vs_sample_through_workbook() {
    let mut wb = Workbook::new();
    // {2, 4, 4, 4, 5, 5, 7, 9} → mean=5, sum sq devs=32.
    // Pop var = 4, pop SD = 2; sample var = 32/7, sample SD = √(32/7).
    for (i, n) in [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }

    wb.set_formula(0, "B1", "=STDEV.P(A1:A8)");
    wb.set_formula(0, "B2", "=STDEV.S(A1:A8)");
    wb.set_formula(0, "B3", "=VAR.P(A1:A8)");
    wb.set_formula(0, "B4", "=VAR.S(A1:A8)");

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
    match wb.get_cell("Sheet1", "B2") {
        Value::Number(n) => assert!(approx_eq(n, (32.0_f64 / 7.0).sqrt(), 1e-12), "B2 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(4.0));
    match wb.get_cell("Sheet1", "B4") {
        Value::Number(n) => assert!(approx_eq(n, 32.0 / 7.0, 1e-12), "B4 = {n}"),
        other => panic!("expected number, got {other:?}"),
    }
}

/// PERCENTILE.EXC / QUARTILE.EXC / COVAR / COVAR.P / COVAR.S through
/// the Workbook + parser pipeline.
#[test]
fn dotted_names_exclusive_and_covar_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    // B = 2A (perfect positive linear).
    for (i, n) in [4.0, 8.0, 12.0, 16.0, 20.0].iter().enumerate() {
        wb.set_cell(0, &format!("B{}", i + 1), Value::Number(*n));
    }

    // PERCENTILE.EXC(A1:A5, 0.5) = 6 (median, n=5 → pos = 3).
    wb.set_formula(0, "C1", "=PERCENTILE.EXC(A1:A5,0.5)");
    // k=0 → InvalidValue.
    wb.set_formula(0, "C2", "=PERCENTILE.EXC(A1:A5,0)");
    // QUARTILE.EXC(A1:A5, 2) = 6.
    wb.set_formula(0, "C3", "=QUARTILE.EXC(A1:A5,2)");
    // QUARTILE.EXC quart=0 not valid in exclusive mode.
    wb.set_formula(0, "C4", "=QUARTILE.EXC(A1:A5,0)");

    // COVAR (= COVAR.P) over (A, B) = 16. COVAR.S = 20.
    wb.set_formula(0, "C5", "=COVAR(A1:A5,B1:B5)");
    wb.set_formula(0, "C6", "=COVAR.P(A1:A5,B1:B5)");
    wb.set_formula(0, "C7", "=COVAR.S(A1:A5,B1:B5)");

    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(6.0));
    match wb.get_cell("Sheet1", "C2") {
        Value::Error(_) => {} // Excel returns #NUM!; we surface InvalidValue.
        other => panic!("C2 should be Error, got {other:?}"),
    }
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(6.0));
    match wb.get_cell("Sheet1", "C4") {
        Value::Error(_) => {}
        other => panic!("C4 should be Error, got {other:?}"),
    }
    assert_eq!(wb.get_cell("Sheet1", "C5"), Value::Number(16.0));
    assert_eq!(wb.get_cell("Sheet1", "C6"), Value::Number(16.0));
    assert_eq!(wb.get_cell("Sheet1", "C7"), Value::Number(20.0));
}
