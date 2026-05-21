//! Integration tests for LAMBDA + the array higher-order functions —
//! L2 + L3 of the LAMBDA arc.
//!
//! These drive the full pipeline (parse → eval → store → atomic
//! spill → read) through `Workbook` so cross-cutting concerns (spill
//! installation, dependency tracking, recompute on input change) are
//! exercised together with the new lambda machinery.
//!
//! Implementation lives in:
//! - `rust/core/src/atom.rs` — `LambdaValue` trait + `Value::Lambda` variant
//! - `rust/excel-core/src/formula.rs` — `Expr::Call` parser support
//! - `rust/excel-core/src/eval.rs` — `ExcelLambda`, `apply_lambda`,
//!   `LAMBDA` / `MAP` / `REDUCE` / `SCAN` / `BYROW` / `BYCOL` /
//!   `MAKEARRAY` / `ISOMITTED` arms

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// `=MAP(A1:A5, LAMBDA(x, x*x))` at B1 should spill the squares of
/// A1:A5 across B1:B5. Verifies that:
///   1. The lambda is constructed from an inline LAMBDA literal,
///   2. The range argument materializes correctly into a 2D buffer,
///   3. The 5×1 result spills via the existing dynamic-array path so
///      reads against the spilled targets (B2..B5) hit the correct
///      scalar elements.
///
/// At the anchor B1, the workbook returns the raw `Value::Array` —
/// the WASM boundary handles collapsing for UI consumers. Spilled
/// targets B2..B5 each hold a derived atom that indexes back into the
/// anchor's Array, so their reads are scalars.
#[test]
fn map_over_range_spills_squares() {
    let mut wb = Workbook::new();
    for (i, v) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*v));
    }
    assert!(wb.set_formula(0, "B1", "=MAP(A1:A5, LAMBDA(x, x*x))"));
    // Anchor returns the Array (5×1).
    match wb.get_cell("Sheet1", "B1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (5, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(1.0)));
            assert_eq!(arr.get(4, 0), Some(&Value::Number(25.0)));
        }
        other => panic!("expected Array at B1 anchor, got {:?}", other),
    }
    // Spilled targets return scalars via their derived atoms.
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(9.0));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Number(16.0));
    assert_eq!(wb.get_cell("Sheet1", "B5"), Value::Number(25.0));
}

/// Stored lambda via LET: name the lambda `square`, then pass it
/// through MAP. Exercises the `Name → Value(Lambda)` resolution path —
/// `square` is an Expr::Name that resolves to a Value::Lambda through
/// the LET frame stack, which then becomes a normal lambda arg to MAP.
#[test]
fn let_named_lambda_then_map() {
    let mut wb = Workbook::new();
    for (i, v) in [10.0, 20.0, 30.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*v));
    }
    assert!(wb.set_formula(
        0,
        "B1",
        "=LET(square, LAMBDA(x, x*x), MAP(A1:A3, square))"
    ));
    // Anchor is the Array; targets are scalars.
    match wb.get_cell("Sheet1", "B1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (3, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(100.0)));
        }
        other => panic!("expected Array at B1 anchor, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(400.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(900.0));
}

/// Closure capture across LET + LAMBDA + MAP. The lambda body
/// references `mult` from the enclosing LET scope; that binding is
/// captured at lambda-literal-eval time and survives through MAP's
/// per-cell invocations (where the live LET stack already contains
/// the outer LET frame too — but the captured snapshot is the
/// canonical contract).
///
/// `=LET(mult, 3, MAP(A1:A4, LAMBDA(x, x*mult)))` triples each cell.
#[test]
fn closure_captures_outer_let_through_map() {
    let mut wb = Workbook::new();
    for (i, v) in [1.0, 2.0, 3.0, 4.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*v));
    }
    assert!(wb.set_formula(
        0,
        "B1",
        "=LET(mult, 3, MAP(A1:A4, LAMBDA(x, x*mult)))"
    ));
    // Anchor returns the Array; spilled targets B2..B4 each return
    // their scalar element.
    match wb.get_cell("Sheet1", "B1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (4, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(3.0)));
        }
        other => panic!("expected Array at B1 anchor, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(9.0));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Number(12.0));
}

/// Immediate-call form via Expr::Call: `=LAMBDA(x, x*x)(5)` at B1
/// returns the scalar 25 (no spill). Verifies the parser correctly
/// chains the trailing `(5)` onto the LAMBDA(...) FuncCall.
#[test]
fn lambda_immediate_invocation_round_trip() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "B1", "=LAMBDA(x, x*x)(5)"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(25.0));
}

/// REDUCE returns a scalar (sum of A1:A5). Verifies that:
///   1. The lambda body sees the accumulator + current value,
///   2. The final accumulator is returned without being wrapped in
///      an Array (REDUCE is intentionally NOT a dynamic-array func).
///
/// SCAN over the same input emits the running totals — different
/// shape contract (5×1 spill) which is exercised in the assertions
/// below the REDUCE call.
#[test]
fn reduce_and_scan_complement() {
    let mut wb = Workbook::new();
    for (i, v) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*v));
    }
    // REDUCE: scalar final sum = 15.
    assert!(wb.set_formula(
        0,
        "C1",
        "=REDUCE(0, A1:A5, LAMBDA(acc, x, acc+x))"
    ));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(15.0));

    // SCAN: 5×1 array of running sums. Anchor D1 returns the Array;
    // D2..D5 return their scalar elements.
    assert!(wb.set_formula(
        0,
        "D1",
        "=SCAN(0, A1:A5, LAMBDA(acc, x, acc+x))"
    ));
    match wb.get_cell("Sheet1", "D1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (5, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(1.0)));
            assert_eq!(arr.get(4, 0), Some(&Value::Number(15.0)));
        }
        other => panic!("expected Array at D1 anchor, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "D4"), Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "D5"), Value::Number(15.0));
}

/// MAP recomputes when an input cell changes. Exercises the dep-chain
/// integration: MAP's range arg registers A1:A3 as deps; mutating one
/// cell must trigger re-eval at the anchor + re-spill at the targets.
#[test]
fn map_recomputes_on_input_change() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(2.0));
    wb.set_cell(0, "A2", Value::Number(3.0));
    wb.set_cell(0, "A3", Value::Number(4.0));
    assert!(wb.set_formula(0, "B1", "=MAP(A1:A3, LAMBDA(x, x*10))"));
    // Anchor returns the Array; spilled cells return scalars.
    match wb.get_cell("Sheet1", "B1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (3, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(20.0)));
        }
        other => panic!("expected Array at B1 anchor, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(30.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(40.0));

    // Mutate the middle input — the MAP output at B2 must update.
    wb.set_cell(0, "A2", Value::Number(99.0));
    match wb.get_cell("Sheet1", "B1") {
        Value::Array(arr) => {
            assert_eq!(arr.get(0, 0), Some(&Value::Number(20.0)));
            assert_eq!(arr.get(1, 0), Some(&Value::Number(990.0)));
        }
        other => panic!("expected Array at B1 anchor, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(990.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(40.0));
}
