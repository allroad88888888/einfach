//! Integration tests for the text + information formulas added in the
//! "text + info formulas" arc:
//!
//!   - UNICHAR / UNICODE
//!   - NUMBERVALUE
//!   - ARRAYTOTEXT / VALUETOTEXT
//!   - REGEXTEST / REGEXEXTRACT / REGEXREPLACE
//!   - ISFORMULA / SHEET / SHEETS / INFO
//!
//! These round-trip through a real `Workbook` so the workbook-context
//! paths get exercised — in particular ISFORMULA's `cell_has_formula`
//! hook on `WorkbookEvalProvider`, and SHEET/SHEETS' cross-sheet index
//! lookups.

use einfach_core::{Value, ValueError};
use einfach_excel_core::{Sheet, Workbook};

/// ISFORMULA TRUE on a real formula cell and FALSE on a primitive cell.
/// Mirrors the contract Excel ships: ISFORMULA(A1) is TRUE iff A1's
/// stored content begins with `=`, irrespective of what value that
/// formula evaluates to.
#[test]
fn isformula_distinguishes_formula_and_primitive_cells() {
    let mut wb = Workbook::new();
    // A1: primitive number.
    wb.set_cell(0, "A1", Value::Number(42.0));
    // B1: formula referencing A1.
    assert!(wb.set_formula(0, "B1", "=A1*2"));

    // ISFORMULA in another cell pointing at A1 / B1.
    assert!(wb.set_formula(0, "C1", "=ISFORMULA(A1)"));
    assert!(wb.set_formula(0, "C2", "=ISFORMULA(B1)"));

    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Boolean(false));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Boolean(true));
}

/// ISFORMULA on a cross-sheet ref. The formula sits on Sheet1 but
/// references `Data!A1` — the workbook's `sheet_cell_has_formula` hook
/// needs to route through the right sheet's formula table.
#[test]
fn isformula_cross_sheet_reference() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(1.0));
    assert!(wb.set_formula(1, "B1", "=A1+1"));

    assert!(wb.set_formula(0, "C1", "=ISFORMULA(Data!A1)"));
    assert!(wb.set_formula(0, "C2", "=ISFORMULA(Data!B1)"));
    assert!(wb.set_formula(0, "C3", "=ISFORMULA(Missing!B1)"));

    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Boolean(false));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Boolean(true));
    assert_eq!(
        wb.get_cell("Sheet1", "C3"),
        Value::Error(ValueError::InvalidRef)
    );
}

#[test]
fn standalone_isformula_cross_sheet_ref_needs_workbook_context() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("B1", "=1+1"));
    assert!(sheet.set_formula("C1", "=ISFORMULA(Data!B1)"));

    assert_eq!(sheet.get_cell("C1"), Value::Error(ValueError::InvalidRef));
}

/// SHEET with a cross-sheet reference returns the 1-based index of the
/// target sheet. SHEET with no argument returns the formula's own sheet.
/// SHEETS with no argument returns the total sheet count.
#[test]
fn sheet_and_sheets_report_correct_indexes() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.add_sheet("Notes");
    assert_eq!(wb.sheet_count(), 3);

    // SHEET(Sheet2-style ref) → 2 (Data is index 1 → 2 in 1-based).
    assert!(wb.set_formula(0, "A1", "=SHEET(Data!A1)"));
    // SHEET(Notes!A1) → 3.
    assert!(wb.set_formula(0, "A2", "=SHEET(Notes!A1)"));
    // SHEET() with no arg on Sheet1 (index 0) → 1.
    assert!(wb.set_formula(0, "A3", "=SHEET()"));
    // SHEET() on the third sheet (Notes) → 3.
    assert!(wb.set_formula(2, "A1", "=SHEET()"));
    // SHEETS() → 3.
    assert!(wb.set_formula(0, "A4", "=SHEETS()"));
    // SHEET(unknown!A1) → #REF!.
    assert!(wb.set_formula(0, "A5", "=SHEET(Missing!A1)"));

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Notes", "A1"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "A4"), Value::Number(3.0));
    assert_eq!(
        wb.get_cell("Sheet1", "A5"),
        Value::Error(ValueError::InvalidRef)
    );
}

/// End-to-end NUMBERVALUE / VALUETOTEXT round-trip through a cell.
#[test]
fn numbervalue_valuetotext_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("1,234.56".into()));
    assert!(wb.set_formula(0, "B1", "=NUMBERVALUE(A1)"));
    assert!(wb.set_formula(0, "C1", "=VALUETOTEXT(B1, 1)"));

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1234.56));
    // Strict mode on a number leaves it un-quoted.
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Text("1234.56".into()));
}

/// REGEXREPLACE in the workbook context. Picks the 2nd `\d` occurrence
/// and replaces it with `Z`; everything else stays intact.
#[test]
fn regexreplace_nth_occurrence_in_cell() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("a1 b2 c3".into()));
    assert!(wb.set_formula(0, "B1", "=REGEXREPLACE(A1, \"[0-9]\", \"Z\", 2)"));

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("a1 bZ c3".into()));
}

/// INFO("system") returns "mac" on macOS, "pc" on Windows, "other"
/// elsewhere. Test pins the host's expected value so the same suite
/// runs everywhere.
#[test]
fn info_system_matches_host_os() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=INFO(\"system\")"));

    let expected = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "pc"
    } else {
        "other"
    };
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text(expected.into()));
}
