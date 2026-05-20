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
