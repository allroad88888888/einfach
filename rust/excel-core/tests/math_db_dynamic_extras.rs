//! End-to-end integration tests for the S batch of formula additions
//! (SUBTOTAL / AGGREGATE / ODD / EVEN / FACTDOUBLE / COMBINA / MULTINOMIAL
//! / SERIESSUM / ISO.CEILING / ERROR.TYPE / DOLLAR / FIXED / IMCSCH /
//! IMSECH / DSTDEV / DSTDEVP / DVAR / DVARP / EXPAND / XMATCH).
//!
//! These exercise the parse → AST → eval → cached-value path through a
//! real Workbook so the wiring (builtin-name registry + dispatch + helpers
//! + sheet-level spill detector) is covered together. The eval.rs inline
//! suite handles the per-function unit semantics; this file is a thin
//! "does it survive the workbook plumbing" smoke layer.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

// ---- SUBTOTAL / AGGREGATE round-trip ----

#[test]
fn subtotal_round_trip_sum_and_average() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Number(2.0));
    wb.set_cell(0, "A3", Value::Number(3.0));

    wb.set_formula(0, "B1", "=SUBTOTAL(9, A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));

    wb.set_formula(0, "B2", "=SUBTOTAL(1, A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(2.0));

    // 109 is the "ignore hidden rows" alias of 9 — same result here.
    wb.set_formula(0, "B3", "=SUBTOTAL(109, A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(6.0));
}

#[test]
fn aggregate_round_trip_with_ignore_errors() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(10.0));
    wb.set_cell(0, "A2", Value::Number(20.0));
    // Embed a #DIV/0! in A3.
    wb.set_formula(0, "A3", "=1/0");

    // Without ignore_errors (options=0): #DIV/0! propagates.
    wb.set_formula(0, "B1", "=AGGREGATE(9, 0, A1:A3)");
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Error(ValueError::DivisionByZero)
    );

    // With options=4 (ignore errors): A3 is skipped, sum = 30.
    wb.set_formula(0, "B2", "=AGGREGATE(9, 4, A1:A3)");
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(30.0));

    // LARGE (14) with k=1 on a range: max value.
    wb.set_formula(0, "B3", "=AGGREGATE(14, 4, A1:A3, 1)");
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(20.0));
}

// ---- ODD / EVEN ----

#[test]
fn odd_even_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=ODD(1.5)");
    wb.set_formula(0, "A2", "=EVEN(1)");
    wb.set_formula(0, "A3", "=ODD(-1.5)");
    wb.set_formula(0, "A4", "=EVEN(0)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(-3.0));
    assert_eq!(wb.get_cell("Sheet1", "A4"), Value::Number(0.0));
}

// ---- FACTDOUBLE / COMBINA / MULTINOMIAL / SERIESSUM ----

#[test]
fn combinatorics_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=FACTDOUBLE(7)");
    wb.set_formula(0, "A2", "=COMBINA(5, 3)");
    wb.set_formula(0, "A3", "=MULTINOMIAL(2, 3, 4)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(105.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(35.0));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(1260.0));
}

#[test]
fn seriessum_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "B1", Value::Number(1.0));
    wb.set_cell(0, "B2", Value::Number(1.0));
    wb.set_cell(0, "B3", Value::Number(1.0));

    // Σ b_i · 2^i = 1 + 2 + 4 = 7
    wb.set_formula(0, "A1", "=SERIESSUM(2, 0, 1, B1:B3)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(7.0));
}

// ---- ISO.CEILING / ERROR.TYPE ----

#[test]
fn iso_ceiling_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=ISO.CEILING(4.3)");
    wb.set_formula(0, "A2", "=ISO.CEILING(4.3, 2)");
    wb.set_formula(0, "A3", "=ISO.CEILING(-4.3, 1)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(6.0));
    // Negative → rounds toward zero (toward +inf in ISO semantics).
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(-4.0));
}

#[test]
fn error_type_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=ERROR.TYPE(1/0)");
    wb.set_formula(0, "A2", "=ERROR.TYPE(MATCH(99, {1,2,3}, 0))");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(7.0));
}

// ---- DOLLAR / FIXED ----

#[test]
fn dollar_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=DOLLAR(1234.567)");
    wb.set_formula(0, "A2", "=DOLLAR(-1234.5)");
    wb.set_formula(0, "A3", "=DOLLAR(1234.567, 0)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text("$1,234.57".into()));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("($1,234.50)".into()));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Text("$1,235".into()));
}

#[test]
fn fixed_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=FIXED(1234.567)");
    wb.set_formula(0, "A2", "=FIXED(-1234.5)");
    wb.set_formula(0, "A3", "=FIXED(1234.567, 2, TRUE)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text("1,234.57".into()));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("-1,234.50".into()));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Text("1234.57".into()));
}

// ---- IMCSCH / IMSECH ----

#[test]
fn imsech_imcsch_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=IMSECH(\"0\")");
    wb.set_formula(0, "A2", "=IMSECH(\"1\")");
    wb.set_formula(0, "A3", "=IMCSCH(\"1\")");

    // sech(0) = 1, returns as text "1".
    let v = wb.get_cell("Sheet1", "A1");
    match v {
        Value::Text(s) => {
            let n: f64 = s.parse().expect("real");
            assert!((n - 1.0).abs() < 1e-9, "sech(0) = {}", n);
        }
        other => panic!("expected text, got {:?}", other),
    }
    // sech(1) = 1/cosh(1) ≈ 0.6480542736...
    let v = wb.get_cell("Sheet1", "A2");
    match v {
        Value::Text(s) => {
            let n: f64 = s.parse().expect("real");
            assert!((n - 1.0_f64.cosh().recip()).abs() < 1e-9, "got {}", n);
        }
        other => panic!("expected text, got {:?}", other),
    }
    // csch(1) = 1/sinh(1)
    let v = wb.get_cell("Sheet1", "A3");
    match v {
        Value::Text(s) => {
            let n: f64 = s.parse().expect("real");
            assert!((n - 1.0_f64.sinh().recip()).abs() < 1e-9, "got {}", n);
        }
        other => panic!("expected text, got {:?}", other),
    }
}

// ---- Database variance / stddev (round-trip through workbook) ----

#[test]
fn dstdev_dvar_round_trip() {
    let mut wb = Workbook::new();
    // Header.
    wb.set_cell(0, "A1", Value::Text("Name".into()));
    wb.set_cell(0, "B1", Value::Text("Age".into()));
    wb.set_cell(0, "C1", Value::Text("Dept".into()));
    wb.set_cell(0, "D1", Value::Text("Salary".into()));
    // Rows: Eng entries get aggregated; Sales entries are filtered out.
    wb.set_cell(0, "A2", Value::Text("Alice".into()));
    wb.set_cell(0, "B2", Value::Number(30.0));
    wb.set_cell(0, "C2", Value::Text("Eng".into()));
    wb.set_cell(0, "D2", Value::Number(80000.0));
    wb.set_cell(0, "A3", Value::Text("Bob".into()));
    wb.set_cell(0, "B3", Value::Number(25.0));
    wb.set_cell(0, "C3", Value::Text("Sales".into()));
    wb.set_cell(0, "D3", Value::Number(60000.0));
    wb.set_cell(0, "A4", Value::Text("Carol".into()));
    wb.set_cell(0, "B4", Value::Number(35.0));
    wb.set_cell(0, "C4", Value::Text("Eng".into()));
    wb.set_cell(0, "D4", Value::Number(95000.0));
    // Criteria: Dept=Eng.
    wb.set_cell(0, "F1", Value::Text("Dept".into()));
    wb.set_cell(0, "F2", Value::Text("Eng".into()));

    wb.set_formula(0, "G1", "=DSTDEV(A1:D4, \"Salary\", F1:F2)");
    wb.set_formula(0, "G2", "=DSTDEVP(A1:D4, \"Salary\", F1:F2)");
    wb.set_formula(0, "G3", "=DVAR(A1:D4, \"Salary\", F1:F2)");
    wb.set_formula(0, "G4", "=DVARP(A1:D4, \"Salary\", F1:F2)");

    // sample stddev = 7500·sqrt(2); pop stddev = 7500.
    match wb.get_cell("Sheet1", "G1") {
        Value::Number(n) => assert!((n - 7500.0 * 2_f64.sqrt()).abs() < 1e-6, "got {}", n),
        other => panic!("expected number, got {:?}", other),
    }
    match wb.get_cell("Sheet1", "G2") {
        Value::Number(n) => assert!((n - 7500.0).abs() < 1e-6, "got {}", n),
        other => panic!("expected number, got {:?}", other),
    }
    // sample var = 2·7500² / 1 = 112_500_000; pop var = 2·7500² / 2 = 56_250_000.
    assert_eq!(
        wb.get_cell("Sheet1", "G3"),
        Value::Number(112_500_000.0)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "G4"),
        Value::Number(56_250_000.0)
    );
}

// ---- EXPAND (spilled into surrounding cells) ----

#[test]
fn expand_round_trip_spill() {
    use einfach_excel_core::Sheet;
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    // EXPAND a 2-row column into 4 rows with explicit pad value.
    assert!(sheet.set_formula("B1", "=EXPAND(A1:A2, 4, 1, 99)"));

    // The anchor cell holds the Array; spilled cells hold scalars.
    match sheet.get_cell("B1") {
        Value::Array(a) => assert_eq!(a.shape(), (4, 1)),
        other => panic!("expected Array at B1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("B2"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("B3"), Value::Number(99.0));
    assert_eq!(sheet.get_cell("B4"), Value::Number(99.0));
}

// ---- XMATCH ----

#[test]
fn xmatch_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(10.0));
    wb.set_cell(0, "A2", Value::Number(20.0));
    wb.set_cell(0, "A3", Value::Number(30.0));
    wb.set_cell(0, "A4", Value::Number(40.0));

    // Exact (default).
    wb.set_formula(0, "B1", "=XMATCH(20, A1:A4)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));

    // Not found.
    wb.set_formula(0, "B2", "=XMATCH(99, A1:A4)");
    assert_eq!(
        wb.get_cell("Sheet1", "B2"),
        Value::Error(ValueError::InvalidValue)
    );

    // Exact-or-next-larger: 25 in {10,20,30,40} → 3 (value 30).
    wb.set_formula(0, "B3", "=XMATCH(25, A1:A4, 1)");
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(3.0));

    // Reverse search on duplicates.
    wb.set_cell(0, "C1", Value::Number(5.0));
    wb.set_cell(0, "C2", Value::Number(5.0));
    wb.set_cell(0, "C3", Value::Number(9.0));
    wb.set_formula(0, "D1", "=XMATCH(5, C1:C3, 0, -1)");
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(2.0));

    // Binary search on ascending data.
    wb.set_formula(0, "B4", "=XMATCH(30, A1:A4, 0, 2)");
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Number(3.0));
}
