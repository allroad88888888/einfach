//! End-to-end tests for Excel array literals: `={a,b;c,d}` syntax.
//!
//! Constant-array form: `,` separates columns within a row, `;` starts
//! a new row, row-major. Cell contents are restricted to literal values
//! (Number / Text / Bool / negated Number) by the parser — see
//! `formula::is_valid_array_lit_element` for the contract.
//!
//! These tests drive the parser → eval → spill pipeline end-to-end:
//! a top-level `=ArrayLit` evaluates to `Value::Array`, which the
//! existing spill machinery (`excel/rust/excel-core/src/sheet.rs` § "Spill
//! infrastructure") fans out into the anchor + derived atoms.

use einfach_core::Value;
use einfach_excel_core::{Sheet, Workbook};

/// `=SUM({10, 20, 30})` flows through `for_each_arg_value`'s
/// `Value::Array` branch and returns the sum.
#[test]
fn sum_of_constant_array_returns_60() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=SUM({10,20,30})"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(60.0));
}

/// A 2×2 constant array `={1,2;3,4}` placed at B5 spills into B5..C6.
/// B5 (anchor) holds the underlying `Value::Array`; B6/C5/C6 read
/// through derived atoms that index the anchor.
#[test]
fn array_literal_2x2_spills_at_b5() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("B5", "={1,2;3,4}"));

    // Anchor surfaces the Array directly.
    match sheet.get_cell("B5") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (2, 2));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(1.0)));
            assert_eq!(arr.get(0, 1), Some(&Value::Number(2.0)));
            assert_eq!(arr.get(1, 0), Some(&Value::Number(3.0)));
            assert_eq!(arr.get(1, 1), Some(&Value::Number(4.0)));
        }
        other => panic!("expected Value::Array at B5 anchor, got {:?}", other),
    }

    // Spilled cells — derived atoms expose the indexed scalars.
    assert_eq!(sheet.get_cell("C5"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("B6"), Value::Number(3.0));
    assert_eq!(sheet.get_cell("C6"), Value::Number(4.0));

    // Outside the spill rectangle stays empty.
    assert_eq!(sheet.get_cell("D5"), Value::Null);
    assert_eq!(sheet.get_cell("B7"), Value::Null);
}

/// `={1,2,3,4,5}` at A1 spills to A1..E1 — single-row literal across
/// columns. Mirror of the SEQUENCE test in `dynamic_arrays.rs`.
#[test]
fn array_literal_1x5_spills_across_columns() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "={1,2,3,4,5}"));

    match sheet.get_cell("A1") {
        Value::Array(arr) => assert_eq!(arr.shape(), (1, 5)),
        other => panic!("expected Array at A1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("C1"), Value::Number(3.0));
    assert_eq!(sheet.get_cell("D1"), Value::Number(4.0));
    assert_eq!(sheet.get_cell("E1"), Value::Number(5.0));
    assert_eq!(sheet.get_cell("F1"), Value::Null);
}
