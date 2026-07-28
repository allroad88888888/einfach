//! Integration tests for the `CELL(info_type[, reference])` function. The
//! inline unit tests in `eval::tests` cover every info_type with an explicit
//! reference; this file exercises the no-arg branch that needs a real
//! `WorkbookEvalProvider` so `provider.current_cell()` resolves.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// `=CELL("row")` with no reference must resolve to the host cell's 1-based
/// row via the workbook provider's `current_cell()`. Placing it in C7
/// asserts both that the current cell is wired through correctly and that
/// the row is 1-based (not 0-based).
#[test]
fn cell_no_ref_returns_current_row() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "C7", "=CELL(\"row\")");
    assert_eq!(wb.get_cell("Sheet1", "C7"), Value::Number(7.0));
}

/// A column with NO explicit width reports Excel's default column width of 8
/// characters. This is the `provider.col_width(col) == None` fallback path.
#[test]
fn cell_width_default_column_is_8() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=CELL(\"width\", Z1)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(8.0));
}

/// A column with an EXPLICIT pixel width converts via the standard Excel
/// metric `round((px − 5) / 7)`. 100 px → (100−5)/7 = 13.57 → 14. Under the
/// old hard-coded `Value::Number(8.0)` this returned 8, so the assertion is
/// red on the pre-change constant and green on the conversion. Runs through
/// the reactive `AtomFormulaProvider` path (a formula cell read via
/// `get_cell` routes through the store facade → formula-inner atom).
#[test]
fn cell_width_explicit_column_converts_px_to_chars() {
    let mut wb = Workbook::new();
    // Column C is index 2 (0-based).
    wb.sheet_mut(0).expect("sheet 0").set_col_width(2, 100);
    wb.set_formula(0, "A1", "=CELL(\"width\", C1)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(14.0));
}

/// A column explicitly set to Excel's own default pixel width (64 px) round-
/// trips to the default 8 characters — the calibration point that proves the
/// conversion, not just a constant, is running: (64−5)/7 = 8.43 → 8.
#[test]
fn cell_width_64px_matches_excel_default_chars() {
    let mut wb = Workbook::new();
    wb.sheet_mut(0).expect("sheet 0").set_col_width(3, 64); // column D
    wb.set_formula(0, "A1", "=CELL(\"width\", D1)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(8.0));
}

/// Boundary: the UI's minimum (40 px) and maximum (1024 px) column widths.
/// 40 px → (40−5)/7 = 5.0 → 5; 1024 px → (1024−5)/7 = 145.57 → 146.
#[test]
fn cell_width_narrow_and_wide_boundaries() {
    let mut wb = Workbook::new();
    wb.sheet_mut(0).expect("sheet 0").set_col_width(1, 40); // column B → 5
    wb.sheet_mut(0).expect("sheet 0").set_col_width(4, 1024); // column E → 146
    wb.set_formula(0, "A1", "=CELL(\"width\", B1)");
    wb.set_formula(0, "A2", "=CELL(\"width\", E1)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(146.0));
}

/// Boundary: a sub-padding pixel width can't produce a negative character
/// count. 1 px → (1−5)/7 = −0.57 → round −1 → clamped to 0; 5 px → 0.
#[test]
fn cell_width_below_padding_clamps_to_zero() {
    let mut wb = Workbook::new();
    wb.sheet_mut(0).expect("sheet 0").set_col_width(1, 1); // column B
    wb.sheet_mut(0).expect("sheet 0").set_col_width(2, 5); // column C
    wb.set_formula(0, "A1", "=CELL(\"width\", B1)");
    wb.set_formula(0, "A2", "=CELL(\"width\", C1)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(0.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(0.0));
}

/// The eager `WorkbookEvalProvider` path (used by `define_name`, not the
/// store facade) resolves the same conversion. Proves the second provider
/// implementation, independent of the reactive formula-inner path.
#[test]
fn cell_width_via_workbook_eval_provider_in_define_name() {
    let mut wb = Workbook::new();
    wb.sheet_mut(0).expect("sheet 0").set_col_width(2, 100); // column C
    wb.define_name("WID", "=CELL(\"width\", C1)")
        .expect("define name");
    assert_eq!(wb.get_named("WID"), Some(Value::Number(14.0)));
}
