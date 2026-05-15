//! Regression tests for three Codex-identified engine bugs.
//!
//! Bug 1 — missing sheet reference returns #REF! not Null/0
//! Bug 2 — unbounded range (A:A) in VLOOKUP returns an error, not overflow
//! Bug 3 — cross-sheet range in VLOOKUP resolves correctly

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// Bug 1: `=Missing!A1+1` should produce `#REF!`, not `1`.
///
/// Before the fix `sheet_cell` returned `Value::Null` for an unknown sheet
/// name, which coerced to `0` in arithmetic — so `Missing!A1+1` evaluated to
/// `1`. After the fix it returns `Value::Error(ValueError::InvalidRef)`, which
/// propagates through the `+1` as a `#REF!` error.
#[test]
fn missing_sheet_ref_is_invalid_ref_not_null() {
    let mut wb = Workbook::new();
    // Sheet1 exists; "Missing" does not.
    wb.set_formula(0, "A1", "=Missing!A1+1");
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::InvalidRef),
        "a reference to a non-existent sheet must propagate #REF!, not evaluate to 1"
    );
}

/// Bug 2: VLOOKUP with an unbounded full-column range `A:A` must not
/// overflow or hang. It should return an error value rather than attempting
/// to allocate a multi-billion-cell grid.
#[test]
fn vlookup_unbounded_column_range_returns_error() {
    let mut wb = Workbook::new();
    // Put a value in A1 so the sheet is non-empty.
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "B1", Value::Number(42.0));
    // A:A is a full-column sentinel range (start.row=0, end.row=u32::MAX).
    // collect_range_2d must detect the sentinel and return [] → lookup_2d
    // returns #REF!.  Previously this would overflow (debug) or hang (release).
    wb.set_formula(0, "C1", "=VLOOKUP(1,A:B,2,FALSE)");
    let result = wb.get_cell("Sheet1", "C1");
    match result {
        Value::Error(_) => {} // any error is acceptable — the key is no panic/hang
        other => panic!(
            "expected an error value for unbounded VLOOKUP range, got {:?}",
            other
        ),
    }
}

/// Bug 3: VLOOKUP with a cross-sheet range `Sheet2!A1:B5` must resolve
/// correctly. Before the fix `arg_as_range` only matched `Expr::Range`,
/// so cross-sheet ranges fell through to the `None` arm and returned
/// `#VALUE!`.
#[test]
fn vlookup_cross_sheet_range_resolves_correctly() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");

    // Populate Sheet2!A1:B3 with a lookup table:
    //   A1=1 B1=100
    //   A2=2 B2=200
    //   A3=3 B3=300
    wb.sheet_mut(s2).unwrap().set_cell("A1", Value::Number(1.0));
    wb.sheet_mut(s2).unwrap().set_cell("B1", Value::Number(100.0));
    wb.sheet_mut(s2).unwrap().set_cell("A2", Value::Number(2.0));
    wb.sheet_mut(s2).unwrap().set_cell("B2", Value::Number(200.0));
    wb.sheet_mut(s2).unwrap().set_cell("A3", Value::Number(3.0));
    wb.sheet_mut(s2).unwrap().set_cell("B3", Value::Number(300.0));

    // VLOOKUP on Sheet1 referencing Sheet2's table.
    wb.set_formula(0, "A1", "=VLOOKUP(2,Sheet2!A1:B3,2,FALSE)");
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Number(200.0),
        "VLOOKUP over a cross-sheet range must return the value from the matched row"
    );
}
