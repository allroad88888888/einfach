//! Integration tests for the Batch B1 error/type-guard formulas
//! (IFERROR / IFNA / IFS / SWITCH / XOR / IS* / N / TYPE).
//!
//! These exercise the formulas through the full `Workbook` set/get cycle so
//! we know they survive the formula store, dependency tracker, and
//! `WorkbookEvalProvider` — not just the in-file `mod tests` shim.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// IFERROR catches a runtime DivisionByZero from a referenced cell and
/// substitutes the fallback. Confirms the guard works through the workbook
/// formula chain, not just inline literals.
#[test]
fn iferror_catches_division_by_zero_through_cell_chain() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Number(0.0));
    // B1 computes a #DIV/0! error via the cell chain.
    wb.set_formula(0, "B1", "=A1/A2");
    // C1 wraps it in IFERROR with a numeric fallback.
    wb.set_formula(0, "C1", "=IFERROR(B1,-1)");
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Number(-1.0),
        "IFERROR must catch the propagated #DIV/0! and return -1"
    );
}

/// IS* classification combined with IFS produces a type-tag for any cell
/// shape. Confirms the guards round-trip through the workbook and that
/// IS* never propagates the error.
#[test]
fn is_family_and_ifs_classify_cell_values_end_to_end() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(42.0));
    wb.set_cell(0, "A2", Value::Text("hi".into()));
    wb.set_cell(0, "A3", Value::Boolean(true));
    wb.set_formula(0, "A4", "=1/0"); // #DIV/0!

    // Build a tag column that uses IFS + the IS* classifiers. The IFS
    // walks predicates in order: error → "err", number → "num", text →
    // "txt", logical → "log", else "?".
    for (row, _label) in ["A1", "A2", "A3", "A4"].iter().enumerate() {
        let target = format!("B{}", row + 1);
        let src = format!("A{}", row + 1);
        let formula = format!(
            "=IFS(ISERROR({0}),\"err\",ISNUMBER({0}),\"num\",ISTEXT({0}),\"txt\",ISLOGICAL({0}),\"log\",TRUE,\"?\")",
            src
        );
        wb.set_formula(0, &target, &formula);
    }

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("num".into()));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("txt".into()));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Text("log".into()));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Text("err".into()));

    // TYPE reports the numeric tag for the error cell — 16.
    wb.set_formula(0, "C4", "=TYPE(A4)");
    assert_eq!(wb.get_cell("Sheet1", "C4"), Value::Number(16.0));

    // ISERR catches the DIV/0 (not NA-like) → true.
    wb.set_formula(0, "D4", "=ISERR(A4)");
    assert_eq!(wb.get_cell("Sheet1", "D4"), Value::Boolean(true));

    // IFNA does NOT catch a DIV/0 → it propagates.
    wb.set_formula(0, "E4", "=IFNA(A4,0)");
    assert_eq!(
        wb.get_cell("Sheet1", "E4"),
        Value::Error(ValueError::DivisionByZero)
    );
}
