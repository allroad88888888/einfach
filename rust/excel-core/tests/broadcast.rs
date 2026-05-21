//! End-to-end tests for implicit arithmetic broadcast in formulas.
//!
//! When a `BinOp` operand is a multi-cell range (or a `Value::Array`
//! result), the evaluator lifts the operation across the array — `=A1:A5*2`
//! becomes a 5x1 spill, `=A1:A3+B1:B3` becomes a 3x1 element-wise sum,
//! etc. The broadcast machinery itself is unit-tested inside
//! `rust/excel-core/src/eval.rs`; this file drives it through the real
//! `Sheet` / `Workbook` API so we exercise the full spill plumbing
//! (`expr_may_produce_array` gate, anchor write, derived-atom install,
//! per-cell reads).
//!
//! See `rust/excel-core/src/eval.rs` § `broadcast_binop` for the
//! per-cell semantics and `rust/excel-core/src/sheet.rs` §
//! "Spill (dynamic-array) infrastructure" for the spill installation
//! contract.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Sheet;

/// `=A1:A5*2` at C1 with A1..A5 = 10, 20, 30, 40, 50 spills 20, 40, 60,
/// 80, 100 into C1..C5.
#[test]
fn range_times_scalar_spills_column() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("A2", Value::Number(20.0));
    sheet.set_cell("A3", Value::Number(30.0));
    sheet.set_cell("A4", Value::Number(40.0));
    sheet.set_cell("A5", Value::Number(50.0));

    assert!(sheet.set_formula("C1", "=A1:A5*2"));

    // C1 anchor: Sheet-level read surfaces the Array.
    match sheet.get_cell("C1") {
        Value::Array(a) => {
            assert_eq!(a.shape(), (5, 1));
            assert_eq!(a.get(0, 0), Some(&Value::Number(20.0)));
        }
        other => panic!("expected Array at C1, got {:?}", other),
    }
    // Spilled cells return their scalar elements.
    assert_eq!(sheet.get_cell("C2"), Value::Number(40.0));
    assert_eq!(sheet.get_cell("C3"), Value::Number(60.0));
    assert_eq!(sheet.get_cell("C4"), Value::Number(80.0));
    assert_eq!(sheet.get_cell("C5"), Value::Number(100.0));
}

/// `=A1:A3+B1:B3` spills element-wise. With A=10,20,30 and B=1,2,3 the
/// result column is 11, 22, 33 at C1..C3.
#[test]
fn range_plus_range_spills_elementwise() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("A2", Value::Number(20.0));
    sheet.set_cell("A3", Value::Number(30.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));

    assert!(sheet.set_formula("C1", "=A1:A3+B1:B3"));

    match sheet.get_cell("C1") {
        Value::Array(a) => assert_eq!(a.shape(), (3, 1)),
        other => panic!("expected Array at C1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("C2"), Value::Number(22.0));
    assert_eq!(sheet.get_cell("C3"), Value::Number(33.0));
}

/// Row × column outer product. `A1:A3` is 3x1 and `B1:D1` is 1x3
/// → 3x3 output. With A=10,20,30 and B1=1, C1=2, D1=3 the multiplication
/// table spills into a 3x3 block anchored at E1.
#[test]
fn row_times_col_spills_outer_product() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("A2", Value::Number(20.0));
    sheet.set_cell("A3", Value::Number(30.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("C1", Value::Number(2.0));
    sheet.set_cell("D1", Value::Number(3.0));

    assert!(sheet.set_formula("E1", "=A1:A3*B1:D1"));

    // Anchor E1 returns the raw Array (sheet-level read); we verify
    // shape + top-left, then check the spilled neighbours individually.
    match sheet.get_cell("E1") {
        Value::Array(a) => {
            assert_eq!(a.shape(), (3, 3));
            assert_eq!(a.get(0, 0), Some(&Value::Number(10.0)));
        }
        other => panic!("expected 3x3 Array at E1, got {:?}", other),
    }
    // Row 0: 10*1, 10*2, 10*3 → 10, 20, 30 (F1, G1 are spilled scalars).
    assert_eq!(sheet.get_cell("F1"), Value::Number(20.0));
    assert_eq!(sheet.get_cell("G1"), Value::Number(30.0));
    // Row 1: 20*1, 20*2, 20*3
    assert_eq!(sheet.get_cell("E2"), Value::Number(20.0));
    assert_eq!(sheet.get_cell("F2"), Value::Number(40.0));
    assert_eq!(sheet.get_cell("G2"), Value::Number(60.0));
    // Row 2: 30*1, 30*2, 30*3
    assert_eq!(sheet.get_cell("E3"), Value::Number(30.0));
    assert_eq!(sheet.get_cell("F3"), Value::Number(60.0));
    assert_eq!(sheet.get_cell("G3"), Value::Number(90.0));
}

/// Comparison broadcasts return Boolean arrays. `=A1:A5>15` returns
/// FALSE, TRUE, TRUE, TRUE, TRUE.
#[test]
fn comparison_spills_boolean_array() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("A2", Value::Number(20.0));
    sheet.set_cell("A3", Value::Number(30.0));
    sheet.set_cell("A4", Value::Number(40.0));
    sheet.set_cell("A5", Value::Number(50.0));

    assert!(sheet.set_formula("C1", "=A1:A5>15"));

    match sheet.get_cell("C1") {
        Value::Array(a) => assert_eq!(a.shape(), (5, 1)),
        other => panic!("expected Array at C1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("C2"), Value::Boolean(true));
    assert_eq!(sheet.get_cell("C3"), Value::Boolean(true));
    assert_eq!(sheet.get_cell("C4"), Value::Boolean(true));
    assert_eq!(sheet.get_cell("C5"), Value::Boolean(true));
}

/// Shape mismatch → `#VALUE!` at the anchor; no spill installed, no
/// other cells touched.
#[test]
fn shape_mismatch_returns_value_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("A2", Value::Number(20.0));
    sheet.set_cell("A3", Value::Number(30.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    sheet.set_cell("B4", Value::Number(4.0));
    sheet.set_cell("B5", Value::Number(5.0));

    assert!(sheet.set_formula("C1", "=A1:A3+B1:B5"));
    assert_eq!(
        sheet.get_cell("C1"),
        Value::Error(ValueError::InvalidValue)
    );
    // No spill — C2, C3 untouched (still Null).
    assert_eq!(sheet.get_cell("C2"), Value::Null);
    assert_eq!(sheet.get_cell("C3"), Value::Null);
}
