//! Round-trip tests for the D* database functions through a real Workbook.
//!
//! Builds an in-sheet "database" (header row + N data rows) plus a small
//! criteria region, then writes D*(database, field, criteria) formulas
//! into separate cells and verifies the evaluated results via
//! `Workbook::get_cell`. This exercises the parse → AST → eval (with the
//! workbook's sparse provider) → cached-value path end-to-end.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// Seed the canonical four-row database into a fresh Workbook plus a
/// Dept="Eng" / Age>28 criteria region. Mirrors `make_db_env` in
/// eval.rs's unit suite so the round-trip expectations stay aligned.
///
/// Layout:
///   A1:D1  Name | Age | Dept | Salary
///   A2:D2  Alice |  30 | Eng   | 80000
///   A3:D3  Bob   |  25 | Sales | 60000
///   A4:D4  Carol |  35 | Eng   | 95000
///   A5:D5  Dave  |  28 | Sales | 70000
///
///   F1:G1  Dept | Age
///   F2:G2  Eng  | >28
fn seed_db(wb: &mut Workbook) {
    // Header.
    wb.set_cell(0, "A1", Value::Text("Name".into()));
    wb.set_cell(0, "B1", Value::Text("Age".into()));
    wb.set_cell(0, "C1", Value::Text("Dept".into()));
    wb.set_cell(0, "D1", Value::Text("Salary".into()));

    let rows: [(&str, f64, &str, f64); 4] = [
        ("Alice", 30.0, "Eng", 80000.0),
        ("Bob", 25.0, "Sales", 60000.0),
        ("Carol", 35.0, "Eng", 95000.0),
        ("Dave", 28.0, "Sales", 70000.0),
    ];
    for (i, (name, age, dept, salary)) in rows.iter().enumerate() {
        let r = i + 2;
        wb.set_cell(0, &format!("A{}", r), Value::Text((*name).into()));
        wb.set_cell(0, &format!("B{}", r), Value::Number(*age));
        wb.set_cell(0, &format!("C{}", r), Value::Text((*dept).into()));
        wb.set_cell(0, &format!("D{}", r), Value::Number(*salary));
    }

    // Criteria.
    wb.set_cell(0, "F1", Value::Text("Dept".into()));
    wb.set_cell(0, "G1", Value::Text("Age".into()));
    wb.set_cell(0, "F2", Value::Text("Eng".into()));
    wb.set_cell(0, "G2", Value::Text(">28".into()));
}

#[test]
fn dsum_and_daverage_round_trip() {
    let mut wb = Workbook::new();
    seed_db(&mut wb);

    // DSUM Salary over Eng/Age>28 → 80000 + 95000 = 175000.
    wb.set_formula(0, "I1", "=DSUM(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I1"), Value::Number(175000.0));

    // DAVERAGE Salary over Eng/Age>28 → 87500.
    wb.set_formula(0, "I2", "=DAVERAGE(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I2"), Value::Number(87500.0));

    // Field as 1-based number (Salary is column 4) matches the text form.
    wb.set_formula(0, "I3", "=DSUM(A1:D5,4,F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I3"), Value::Number(175000.0));
}

#[test]
fn dcount_dcounta_dmax_dmin_dproduct_round_trip() {
    let mut wb = Workbook::new();
    seed_db(&mut wb);

    // 2 matches (Alice, Carol).
    wb.set_formula(0, "I1", "=DCOUNT(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I1"), Value::Number(2.0));

    // DCOUNTA Name column: 2 non-empty.
    wb.set_formula(0, "I2", "=DCOUNTA(A1:D5,\"Name\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I2"), Value::Number(2.0));

    // DMAX / DMIN of {80000, 95000}.
    wb.set_formula(0, "I3", "=DMAX(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I3"), Value::Number(95000.0));
    wb.set_formula(0, "I4", "=DMIN(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I4"), Value::Number(80000.0));

    // DPRODUCT 80000 * 95000.
    wb.set_formula(0, "I5", "=DPRODUCT(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I5"), Value::Number(7_600_000_000.0));
}

#[test]
fn dget_dstdev_dvar_round_trip() {
    let mut wb = Workbook::new();
    seed_db(&mut wb);

    // DGET with the default (2-match) filter → Overflow (#NUM!).
    wb.set_formula(0, "I1", "=DGET(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(
        wb.get_cell("Sheet1", "I1"),
        Value::Error(ValueError::Overflow)
    );

    // Tighten criteria so DGET resolves uniquely: Dept=Sales, Age>26 →
    // only Dave matches.
    wb.set_cell(0, "F2", Value::Text("Sales".into()));
    wb.set_cell(0, "G2", Value::Text(">26".into()));
    wb.set_formula(0, "I2", "=DGET(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I2"), Value::Number(70000.0));

    // Restore the default 2-match criteria for DSTDEV / DVAR.
    wb.set_cell(0, "F2", Value::Text("Eng".into()));
    wb.set_cell(0, "G2", Value::Text(">28".into()));

    // DSTDEVP / DVARP over {80000, 95000}: stddev=7500, var=56_250_000.
    wb.set_formula(0, "I3", "=DSTDEVP(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I3"), Value::Number(7500.0));
    wb.set_formula(0, "I4", "=DVARP(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I4"), Value::Number(56_250_000.0));

    // DVAR (sample) = 112_500_000.
    wb.set_formula(0, "I5", "=DVAR(A1:D5,\"Salary\",F1:G2)");
    assert_eq!(wb.get_cell("Sheet1", "I5"), Value::Number(112_500_000.0));
}
