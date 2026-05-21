//! Integration tests for the `LET` function — L1 of the LAMBDA arc.
//!
//! `LET(name1, value1, name2, value2, ..., expression)` introduces
//! lexical, sequential bindings into a single expression. These tests
//! drive LET through `Workbook` so the parser → eval → store → read
//! round-trip is exercised (rather than the unit tests in `eval.rs`
//! which call `eval_expr` directly).
//!
//! Implementation lives in:
//! - `rust/excel-core/src/formula.rs` — `Expr::Name` AST node + parser fallback
//! - `rust/excel-core/src/eval.rs` — `LET_FRAMES` TLS stack + `LET` arm

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// `=LET(x, 5, x*x)` at B1 computes 25 and the workbook surfaces it.
#[test]
fn let_simple_round_trip() {
    let mut wb = Workbook::new();
    // Default sheet at idx 0 is named "Sheet1" — same convention used by
    // the other workbook integration tests (see `cross_sheet.rs`).
    assert!(wb.set_formula(0, "B1", "=LET(x, 5, x*x)"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(25.0));
}

/// `=LET(t, A1+1, t*2)` reads from a normal cell, binds, then uses the
/// binding twice. Changing A1 must re-flow through the formula.
#[test]
fn let_binding_uses_cell_and_recomputes() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(10.0));
    assert!(wb.set_formula(0, "B1", "=LET(t, A1+1, t*2)"));
    // t = 10+1 = 11; body = 22.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(22.0));

    // Mutate A1; the LET formula picks up the new value automatically.
    wb.set_cell(0, "A1", Value::Number(20.0));
    // t = 20+1 = 21; body = 42.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(42.0));
}

/// Nested LETs: inner sees outer through the frame chain, AND shadows
/// take precedence. `=LET(x, 5, LET(x, 10, x*2))` → 20.
#[test]
fn let_nested_with_shadowing() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=LET(x, 5, LET(x, 10, x*2))"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(20.0));

    // And the outer x is still visible in the inner body when the
    // inner LET binds a different name.
    assert!(wb.set_formula(0, "A2", "=LET(x, 5, LET(y, x*2, x+y))"));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(15.0));
}

/// Wrong arity surfaces #N/A (WrongArgCount). 4 args = even total →
/// invalid; 1 arg = body alone, no bindings → invalid.
#[test]
fn let_wrong_arity_surfaces_error() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=LET(x, 5, x*2, x*3)"));
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::WrongArgCount)
    );

    assert!(wb.set_formula(0, "A2", "=LET(5)"));
    assert_eq!(
        wb.get_cell("Sheet1", "A2"),
        Value::Error(ValueError::WrongArgCount)
    );
}
