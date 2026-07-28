//! Integration tests for the math-extras batch:
//! SUMSQ / SUMX2MY2 / SUMX2PY2 / SUMXMY2 / SQRTPI / SUMPRODUCT +
//! FLOOR.MATH / CEILING.MATH / FLOOR.PRECISE / CEILING.PRECISE +
//! ROMAN / ARABIC / DECIMAL / BASE + MDETERM.
//!
//! Drives the formulas through the full `Workbook` API so the parser
//! (incl. dotted-name function support) and `WorkbookEvalProvider`
//! both stay covered.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// SUMPRODUCT/SUMSQ/SUMX2MY2/SUMX2PY2/SUMXMY2 over a populated range.
///
/// Layout:
///   A1=1, A2=2, A3=3, A4=4, A5=5     (x)
///   B1=2, B2=4, B3=6, B4=8, B5=10    (y = 2x)
#[test]
fn pair_aggregates_round_trip() {
    let mut wb = Workbook::new();
    for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("B{}", i + 1), Value::Number(*n));
    }

    wb.set_formula(0, "C1", "=SUMSQ(A1:A5)"); // 55
    wb.set_formula(0, "C2", "=SUMX2MY2(A1:A5,B1:B5)"); // 55 - 220 = -165
    wb.set_formula(0, "C3", "=SUMX2PY2(A1:A5,B1:B5)"); // 55 + 220 = 275
    wb.set_formula(0, "C4", "=SUMXMY2(A1:A5,B1:B5)"); // Σx² = 55
    wb.set_formula(0, "C5", "=SUMPRODUCT(A1:A5,B1:B5)"); // 2Σx² = 110
    wb.set_formula(0, "C6", "=SUMPRODUCT(A1:A5)"); // = SUM(A1:A5) = 15

    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(55.0));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(-165.0));
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(275.0));
    assert_eq!(wb.get_cell("Sheet1", "C4"), Value::Number(55.0));
    assert_eq!(wb.get_cell("Sheet1", "C5"), Value::Number(110.0));
    assert_eq!(wb.get_cell("Sheet1", "C6"), Value::Number(15.0));
}

/// FLOOR.MATH / CEILING.MATH / FLOOR.PRECISE / CEILING.PRECISE +
/// ROMAN / ARABIC / DECIMAL / BASE round-trip through formula cells.
#[test]
fn rounding_and_base_round_trip() {
    let mut wb = Workbook::new();

    // FLOOR.MATH vs FLOOR.PRECISE divergence for negatives + mode!=0.
    wb.set_formula(0, "A1", "=FLOOR.MATH(-2.5,1,1)"); // -2 (toward zero)
    wb.set_formula(0, "A2", "=FLOOR.PRECISE(-2.5)"); // -3 (toward -inf)
    wb.set_formula(0, "A3", "=CEILING.MATH(-2.5,1,1)"); // -3 (away from zero)
    wb.set_formula(0, "A4", "=CEILING.PRECISE(-2.5)"); // -2 (toward +inf)

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(-2.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(-3.0));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(-3.0));
    assert_eq!(wb.get_cell("Sheet1", "A4"), Value::Number(-2.0));

    // ROMAN / ARABIC round-trip.
    wb.set_formula(0, "B1", "=ROMAN(1994)");
    wb.set_formula(0, "B2", "=ARABIC(\"MCMXCIV\")");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("MCMXCIV".into()));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(1994.0));

    // BASE / DECIMAL round-trip.
    wb.set_formula(0, "C1", "=BASE(255,16)");
    wb.set_formula(0, "C2", "=DECIMAL(BASE(255,16),16)");
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Text("FF".into()));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(255.0));
}

/// MDETERM through a workbook: 2×2 known, 3×3 with non-trivial values.
#[test]
fn mdeterm_round_trip() {
    let mut wb = Workbook::new();

    // 2×2: [[1,2],[3,4]] → det = -2.
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "B1", Value::Number(2.0));
    wb.set_cell(0, "A2", Value::Number(3.0));
    wb.set_cell(0, "B2", Value::Number(4.0));
    wb.set_formula(0, "D1", "=MDETERM(A1:B2)");
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(-2.0));

    // 3×3: [[2,0,0],[0,3,0],[0,0,4]] → det = 24.
    wb.set_cell(0, "E1", Value::Number(2.0));
    wb.set_cell(0, "F2", Value::Number(3.0));
    wb.set_cell(0, "G3", Value::Number(4.0));
    wb.set_formula(0, "H1", "=MDETERM(E1:G3)");
    match wb.get_cell("Sheet1", "H1") {
        Value::Number(n) => assert!((n - 24.0).abs() < 1e-12, "got {n}"),
        other => panic!("expected number, got {other:?}"),
    }
}
