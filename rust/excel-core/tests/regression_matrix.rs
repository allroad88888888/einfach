//! Integration tests for the P-batch: regression + matrix algebra
//! functions added in `rust/excel-core/src/eval.rs`.
//!
//! Covers:
//!   * LINEST / LOGEST — least-squares fit, optional diagnostic block.
//!   * TREND / GROWTH — predicted values at training / new x's.
//!   * FORECAST / FORECAST.LINEAR — scalar single-point forecast.
//!   * STEYX / RSQ / PEARSON — single-pair regression statistics.
//!   * MMULT / MINVERSE / MUNIT / TRANSPOSE — matrix-algebra spillers.
//!
//! Cell topology is constructed via `Sheet::set_cell` for inputs and
//! `Sheet::set_formula` for the function under test. All array-
//! producing arms route through `expr_may_produce_array`, so the
//! anchor is a `Value::Array` and adjacent cells receive the spilled
//! scalars.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Sheet;

fn approx_eq(a: f64, b: f64, eps: f64) -> bool {
    (a - b).abs() <= eps
}

fn assert_num(v: Value, expected: f64, eps: f64) {
    match v {
        Value::Number(n) => assert!(
            approx_eq(n, expected, eps),
            "expected ≈ {} (eps {}), got {}",
            expected,
            eps,
            n
        ),
        other => panic!("expected Number ≈ {}, got {:?}", expected, other),
    }
}

fn shape_of(sheet: &Sheet, anchor: &str) -> (u32, u32) {
    match sheet.get_cell(anchor) {
        Value::Array(a) => a.shape(),
        other => panic!("expected Array at {}, got {:?}", anchor, other),
    }
}

fn array_at(sheet: &Sheet, anchor: &str, row: u32, col: u32) -> Value {
    match sheet.get_cell(anchor) {
        Value::Array(a) => a.get(row, col).cloned().unwrap_or(Value::Null),
        other => panic!("expected Array at {}, got {:?}", anchor, other),
    }
}

// ============================================================
//  MMULT
// ============================================================

#[test]
fn mmult_2x2_times_2x2_correctness() {
    let mut sheet = Sheet::new();
    // A = [[1,2],[3,4]] at A1:B2.
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(3.0));
    sheet.set_cell("B2", Value::Number(4.0));
    // B = [[5,6],[7,8]] at D1:E2.
    sheet.set_cell("D1", Value::Number(5.0));
    sheet.set_cell("E1", Value::Number(6.0));
    sheet.set_cell("D2", Value::Number(7.0));
    sheet.set_cell("E2", Value::Number(8.0));
    assert!(sheet.set_formula("G1", "=MMULT(A1:B2, D1:E2)"));
    // Expected: [[19,22],[43,50]].
    assert_eq!(shape_of(&sheet, "G1"), (2, 2));
    assert_num(array_at(&sheet, "G1", 0, 0), 19.0, 1e-12);
    assert_num(array_at(&sheet, "G1", 0, 1), 22.0, 1e-12);
    assert_num(array_at(&sheet, "G1", 1, 0), 43.0, 1e-12);
    assert_num(array_at(&sheet, "G1", 1, 1), 50.0, 1e-12);
    // Spilled neighbour at H1 = top-row, second col.
    assert_num(sheet.get_cell("H1"), 22.0, 1e-12);
    assert_num(sheet.get_cell("G2"), 43.0, 1e-12);
    assert_num(sheet.get_cell("H2"), 50.0, 1e-12);
}

#[test]
fn mmult_dim_mismatch_returns_value_error() {
    let mut sheet = Sheet::new();
    // A is 2×3, B is 2×2 → inner mismatch.
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("C1", Value::Number(3.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("B2", Value::Number(5.0));
    sheet.set_cell("C2", Value::Number(6.0));
    sheet.set_cell("D1", Value::Number(1.0));
    sheet.set_cell("E1", Value::Number(0.0));
    sheet.set_cell("D2", Value::Number(0.0));
    sheet.set_cell("E2", Value::Number(1.0));
    assert!(sheet.set_formula("G1", "=MMULT(A1:C2, D1:E2)"));
    assert_eq!(sheet.get_cell("G1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn mmult_rectangular_3x2_times_2x3() {
    let mut sheet = Sheet::new();
    // A is 3×2.
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(3.0));
    sheet.set_cell("B2", Value::Number(4.0));
    sheet.set_cell("A3", Value::Number(5.0));
    sheet.set_cell("B3", Value::Number(6.0));
    // B is 2×3 — identity-like.
    sheet.set_cell("D1", Value::Number(1.0));
    sheet.set_cell("E1", Value::Number(0.0));
    sheet.set_cell("F1", Value::Number(1.0));
    sheet.set_cell("D2", Value::Number(0.0));
    sheet.set_cell("E2", Value::Number(1.0));
    sheet.set_cell("F2", Value::Number(1.0));
    assert!(sheet.set_formula("H1", "=MMULT(A1:B3, D1:F2)"));
    assert_eq!(shape_of(&sheet, "H1"), (3, 3));
    // Row 0: [1, 2, 3]
    assert_num(array_at(&sheet, "H1", 0, 0), 1.0, 1e-12);
    assert_num(array_at(&sheet, "H1", 0, 1), 2.0, 1e-12);
    assert_num(array_at(&sheet, "H1", 0, 2), 3.0, 1e-12);
    // Row 2: [5, 6, 11]
    assert_num(array_at(&sheet, "H1", 2, 0), 5.0, 1e-12);
    assert_num(array_at(&sheet, "H1", 2, 1), 6.0, 1e-12);
    assert_num(array_at(&sheet, "H1", 2, 2), 11.0, 1e-12);
}

#[test]
fn mmult_arg_count_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    assert!(sheet.set_formula("B1", "=MMULT(A1)"));
    assert_eq!(
        sheet.get_cell("B1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ============================================================
//  MINVERSE
// ============================================================

#[test]
fn minverse_2x2_correctness() {
    let mut sheet = Sheet::new();
    // [[4,7],[2,6]] → inverse [[0.6,-0.7],[-0.2,0.4]].
    sheet.set_cell("A1", Value::Number(4.0));
    sheet.set_cell("B1", Value::Number(7.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("B2", Value::Number(6.0));
    assert!(sheet.set_formula("D1", "=MINVERSE(A1:B2)"));
    assert_eq!(shape_of(&sheet, "D1"), (2, 2));
    assert_num(array_at(&sheet, "D1", 0, 0), 0.6, 1e-9);
    assert_num(array_at(&sheet, "D1", 0, 1), -0.7, 1e-9);
    assert_num(array_at(&sheet, "D1", 1, 0), -0.2, 1e-9);
    assert_num(array_at(&sheet, "D1", 1, 1), 0.4, 1e-9);
}

#[test]
fn minverse_singular_returns_num_error() {
    let mut sheet = Sheet::new();
    // [[1,2],[2,4]] is rank-deficient.
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("B2", Value::Number(4.0));
    assert!(sheet.set_formula("D1", "=MINVERSE(A1:B2)"));
    assert_eq!(sheet.get_cell("D1"), Value::Error(ValueError::Overflow));
}

#[test]
fn minverse_non_square_returns_value_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("C1", Value::Number(3.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("B2", Value::Number(5.0));
    sheet.set_cell("C2", Value::Number(6.0));
    assert!(sheet.set_formula("E1", "=MINVERSE(A1:C2)"));
    assert_eq!(sheet.get_cell("E1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn minverse_times_original_is_identity() {
    let mut sheet = Sheet::new();
    // A = [[2,1,0],[1,3,1],[0,1,2]].
    sheet.set_cell("A1", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("C1", Value::Number(0.0));
    sheet.set_cell("A2", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(3.0));
    sheet.set_cell("C2", Value::Number(1.0));
    sheet.set_cell("A3", Value::Number(0.0));
    sheet.set_cell("B3", Value::Number(1.0));
    sheet.set_cell("C3", Value::Number(2.0));
    assert!(sheet.set_formula("E1", "=MMULT(A1:C3, MINVERSE(A1:C3))"));
    assert_eq!(shape_of(&sheet, "E1"), (3, 3));
    for r in 0..3 {
        for c in 0..3 {
            let expected = if r == c { 1.0 } else { 0.0 };
            assert_num(array_at(&sheet, "E1", r, c), expected, 1e-9);
        }
    }
}

// ============================================================
//  MUNIT
// ============================================================

#[test]
fn munit_3_returns_3x3_identity() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=MUNIT(3)"));
    assert_eq!(shape_of(&sheet, "A1"), (3, 3));
    for r in 0..3 {
        for c in 0..3 {
            let expected = if r == c { 1.0 } else { 0.0 };
            assert_num(array_at(&sheet, "A1", r, c), expected, 1e-12);
        }
    }
    // Spilled cells.
    assert_num(sheet.get_cell("B2"), 1.0, 1e-12);
    assert_num(sheet.get_cell("A2"), 0.0, 1e-12);
}

#[test]
fn munit_zero_returns_value_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=MUNIT(0)"));
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn munit_negative_returns_value_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=MUNIT(-2)"));
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn munit_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=MUNIT()"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ============================================================
//  TRANSPOSE
// ============================================================

#[test]
fn transpose_2x3_yields_3x2() {
    let mut sheet = Sheet::new();
    // A1:C2 = [[1,2,3],[4,5,6]].
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("C1", Value::Number(3.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("B2", Value::Number(5.0));
    sheet.set_cell("C2", Value::Number(6.0));
    assert!(sheet.set_formula("E1", "=TRANSPOSE(A1:C2)"));
    assert_eq!(shape_of(&sheet, "E1"), (3, 2));
    // Anchor (0,0) = original (0,0) = 1.
    assert_num(array_at(&sheet, "E1", 0, 0), 1.0, 1e-12);
    // (0,1) = original (1,0) = 4.
    assert_num(array_at(&sheet, "E1", 0, 1), 4.0, 1e-12);
    // (2,1) = original (1,2) = 6.
    assert_num(array_at(&sheet, "E1", 2, 1), 6.0, 1e-12);
    // Spilled F2 (col 1, row 1) → original (1,1) = 5.
    assert_num(sheet.get_cell("F2"), 5.0, 1e-12);
}

#[test]
fn transpose_preserves_text_cells() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Text("hello".into()));
    sheet.set_cell("B1", Value::Number(42.0));
    assert!(sheet.set_formula("D1", "=TRANSPOSE(A1:B1)"));
    assert_eq!(shape_of(&sheet, "D1"), (2, 1));
    // (0,0) = "hello", (1,0) = 42.
    assert_eq!(array_at(&sheet, "D1", 0, 0), Value::Text("hello".into()));
    assert_num(array_at(&sheet, "D1", 1, 0), 42.0, 1e-12);
}

#[test]
fn transpose_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=TRANSPOSE()"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

#[test]
fn transpose_roundtrip_is_identity() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(3.0));
    sheet.set_cell("B2", Value::Number(4.0));
    assert!(sheet.set_formula("D1", "=TRANSPOSE(TRANSPOSE(A1:B2))"));
    assert_eq!(shape_of(&sheet, "D1"), (2, 2));
    assert_num(array_at(&sheet, "D1", 0, 0), 1.0, 1e-12);
    assert_num(array_at(&sheet, "D1", 0, 1), 2.0, 1e-12);
    assert_num(array_at(&sheet, "D1", 1, 0), 3.0, 1e-12);
    assert_num(array_at(&sheet, "D1", 1, 1), 4.0, 1e-12);
}

// ============================================================
//  LINEST (single-var, no stats)
// ============================================================

#[test]
fn linest_single_var_no_stats_returns_slope_intercept() {
    let mut sheet = Sheet::new();
    // y = 2x + 3 at x = 1..5 → y = 5, 7, 9, 11, 13.
    for (i, y) in [5.0, 7.0, 9.0, 11.0, 13.0].iter().enumerate() {
        sheet.set_cell(&format!("A{}", i + 1), Value::Number(*y));
        sheet.set_cell(&format!("B{}", i + 1), Value::Number((i + 1) as f64));
    }
    assert!(sheet.set_formula("D1", "=LINEST(A1:A5, B1:B5)"));
    // 1×2 array: [slope, intercept] = [2, 3].
    assert_eq!(shape_of(&sheet, "D1"), (1, 2));
    assert_num(array_at(&sheet, "D1", 0, 0), 2.0, 1e-9);
    assert_num(array_at(&sheet, "D1", 0, 1), 3.0, 1e-9);
    // Spilled scalar at E1 = intercept.
    assert_num(sheet.get_cell("E1"), 3.0, 1e-9);
}

#[test]
fn linest_default_x_uses_implicit_index() {
    let mut sheet = Sheet::new();
    // y = 5, 10, 15 — slope 5 against implicit x = 1, 2, 3.
    sheet.set_cell("A1", Value::Number(5.0));
    sheet.set_cell("A2", Value::Number(10.0));
    sheet.set_cell("A3", Value::Number(15.0));
    assert!(sheet.set_formula("C1", "=LINEST(A1:A3)"));
    assert_eq!(shape_of(&sheet, "C1"), (1, 2));
    assert_num(array_at(&sheet, "C1", 0, 0), 5.0, 1e-9);
    assert_num(array_at(&sheet, "C1", 0, 1), 0.0, 1e-9);
}

#[test]
fn linest_stats_emits_5_row_diagnostic_block() {
    let mut sheet = Sheet::new();
    for (i, y) in [5.0, 7.0, 9.0, 11.0, 13.0].iter().enumerate() {
        sheet.set_cell(&format!("A{}", i + 1), Value::Number(*y));
        sheet.set_cell(&format!("B{}", i + 1), Value::Number((i + 1) as f64));
    }
    assert!(sheet.set_formula("D1", "=LINEST(A1:A5, B1:B5, TRUE, TRUE)"));
    assert_eq!(shape_of(&sheet, "D1"), (5, 2));
    // Row 0: [slope=2, intercept=3].
    assert_num(array_at(&sheet, "D1", 0, 0), 2.0, 1e-9);
    assert_num(array_at(&sheet, "D1", 0, 1), 3.0, 1e-9);
    // Row 2 col 0: R² = 1.0 (perfect fit).
    assert_num(array_at(&sheet, "D1", 2, 0), 1.0, 1e-9);
    // Row 2 col 1: SE_y = 0.0 (perfect fit).
    assert_num(array_at(&sheet, "D1", 2, 1), 0.0, 1e-9);
    // Row 3 col 1: df = n - p = 5 - 2 = 3.
    assert_num(array_at(&sheet, "D1", 3, 1), 3.0, 1e-9);
    // Row 4 col 1: SS_resid = 0.0 for a perfect fit.
    assert_num(array_at(&sheet, "D1", 4, 1), 0.0, 1e-9);
}

#[test]
fn linest_no_intercept_drives_through_origin() {
    let mut sheet = Sheet::new();
    // y = 3x: at x = 1,2,3 → y = 3, 6, 9.
    sheet.set_cell("A1", Value::Number(3.0));
    sheet.set_cell("A2", Value::Number(6.0));
    sheet.set_cell("A3", Value::Number(9.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=LINEST(A1:A3, B1:B3, FALSE)"));
    assert_eq!(shape_of(&sheet, "D1"), (1, 2));
    assert_num(array_at(&sheet, "D1", 0, 0), 3.0, 1e-9);
    // Intercept slot still present, equals 0 when const = FALSE.
    assert_num(array_at(&sheet, "D1", 0, 1), 0.0, 1e-12);
}

#[test]
fn linest_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=LINEST()"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ============================================================
//  LOGEST (exponential fit)
// ============================================================

#[test]
fn logest_pure_exponential_recovers_base() {
    let mut sheet = Sheet::new();
    // y = 2 * 3^x: at x = 1..4 → 6, 18, 54, 162.
    sheet.set_cell("A1", Value::Number(6.0));
    sheet.set_cell("A2", Value::Number(18.0));
    sheet.set_cell("A3", Value::Number(54.0));
    sheet.set_cell("A4", Value::Number(162.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    sheet.set_cell("B4", Value::Number(4.0));
    assert!(sheet.set_formula("D1", "=LOGEST(A1:A4, B1:B4)"));
    assert_eq!(shape_of(&sheet, "D1"), (1, 2));
    // Slope = m = 3, intercept = b = 2.
    assert_num(array_at(&sheet, "D1", 0, 0), 3.0, 1e-9);
    assert_num(array_at(&sheet, "D1", 0, 1), 2.0, 1e-9);
}

#[test]
fn logest_negative_y_returns_num_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(-2.0));
    sheet.set_cell("A3", Value::Number(3.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=LOGEST(A1:A3, B1:B3)"));
    assert_eq!(sheet.get_cell("D1"), Value::Error(ValueError::Overflow));
}

// ============================================================
//  TREND (predicted values)
// ============================================================

#[test]
fn trend_predicts_at_training_points_when_new_x_omitted() {
    let mut sheet = Sheet::new();
    // y = 2x + 3 at x = 1..5.
    for (i, y) in [5.0, 7.0, 9.0, 11.0, 13.0].iter().enumerate() {
        sheet.set_cell(&format!("A{}", i + 1), Value::Number(*y));
        sheet.set_cell(&format!("B{}", i + 1), Value::Number((i + 1) as f64));
    }
    assert!(sheet.set_formula("D1", "=TREND(A1:A5, B1:B5)"));
    assert_eq!(shape_of(&sheet, "D1"), (5, 1));
    for (i, expected) in [5.0, 7.0, 9.0, 11.0, 13.0].iter().enumerate() {
        assert_num(array_at(&sheet, "D1", i as u32, 0), *expected, 1e-9);
    }
}

#[test]
fn trend_predicts_at_new_x_values() {
    let mut sheet = Sheet::new();
    // y = 4x at x = 1..4.
    sheet.set_cell("A1", Value::Number(4.0));
    sheet.set_cell("A2", Value::Number(8.0));
    sheet.set_cell("A3", Value::Number(12.0));
    sheet.set_cell("A4", Value::Number(16.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    sheet.set_cell("B4", Value::Number(4.0));
    // Predict at new_x = 10, 20.
    sheet.set_cell("C1", Value::Number(10.0));
    sheet.set_cell("C2", Value::Number(20.0));
    assert!(sheet.set_formula("D1", "=TREND(A1:A4, B1:B4, C1:C2)"));
    assert_eq!(shape_of(&sheet, "D1"), (2, 1));
    assert_num(array_at(&sheet, "D1", 0, 0), 40.0, 1e-9);
    assert_num(array_at(&sheet, "D1", 1, 0), 80.0, 1e-9);
}

#[test]
fn trend_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=TREND()"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ============================================================
//  GROWTH
// ============================================================

#[test]
fn growth_predicts_at_training_points() {
    let mut sheet = Sheet::new();
    // y = 2 * 3^x at x = 1..3 → 6, 18, 54.
    sheet.set_cell("A1", Value::Number(6.0));
    sheet.set_cell("A2", Value::Number(18.0));
    sheet.set_cell("A3", Value::Number(54.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=GROWTH(A1:A3, B1:B3)"));
    assert_eq!(shape_of(&sheet, "D1"), (3, 1));
    assert_num(array_at(&sheet, "D1", 0, 0), 6.0, 1e-7);
    assert_num(array_at(&sheet, "D1", 1, 0), 18.0, 1e-7);
    assert_num(array_at(&sheet, "D1", 2, 0), 54.0, 1e-7);
}

#[test]
fn growth_predicts_at_new_x_values() {
    let mut sheet = Sheet::new();
    // y = 2^x at x = 1..4 → 2, 4, 8, 16.
    sheet.set_cell("A1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("A3", Value::Number(8.0));
    sheet.set_cell("A4", Value::Number(16.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    sheet.set_cell("B4", Value::Number(4.0));
    // new_x = 5 → 32.
    sheet.set_cell("C1", Value::Number(5.0));
    assert!(sheet.set_formula("D1", "=GROWTH(A1:A4, B1:B4, C1:C1)"));
    assert_eq!(shape_of(&sheet, "D1"), (1, 1));
    assert_num(array_at(&sheet, "D1", 0, 0), 32.0, 1e-7);
}

// ============================================================
//  FORECAST / FORECAST.LINEAR
// ============================================================

#[test]
fn forecast_linear_extrapolates_correctly() {
    let mut sheet = Sheet::new();
    // y = 2x + 3 at x = 1..3 → 5, 7, 9.
    sheet.set_cell("A1", Value::Number(5.0));
    sheet.set_cell("A2", Value::Number(7.0));
    sheet.set_cell("A3", Value::Number(9.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    // Predict at x = 10 → 23.
    assert!(sheet.set_formula("D1", "=FORECAST(10, A1:A3, B1:B3)"));
    assert_num(sheet.get_cell("D1"), 23.0, 1e-9);
}

#[test]
fn forecast_linear_alias_matches_forecast() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(5.0));
    sheet.set_cell("A2", Value::Number(7.0));
    sheet.set_cell("A3", Value::Number(9.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=FORECAST.LINEAR(10, A1:A3, B1:B3)"));
    assert_num(sheet.get_cell("D1"), 23.0, 1e-9);
}

#[test]
fn forecast_shape_mismatch_returns_value_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=FORECAST(5, A1:A2, B1:B3)"));
    assert_eq!(sheet.get_cell("D1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn forecast_wrong_arg_count() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    assert!(sheet.set_formula("B1", "=FORECAST(5, A1)"));
    assert_eq!(
        sheet.get_cell("B1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ============================================================
//  STEYX
// ============================================================

#[test]
fn steyx_perfect_fit_returns_zero() {
    let mut sheet = Sheet::new();
    // Perfect linear fit → SE = 0.
    sheet.set_cell("A1", Value::Number(5.0));
    sheet.set_cell("A2", Value::Number(7.0));
    sheet.set_cell("A3", Value::Number(9.0));
    sheet.set_cell("A4", Value::Number(11.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    sheet.set_cell("B4", Value::Number(4.0));
    assert!(sheet.set_formula("D1", "=STEYX(A1:A4, B1:B4)"));
    assert_num(sheet.get_cell("D1"), 0.0, 1e-9);
}

#[test]
fn steyx_noisy_data_returns_positive_se() {
    let mut sheet = Sheet::new();
    // y values deviate from the line y = 2x + 3.
    sheet.set_cell("A1", Value::Number(6.0)); // expected 5
    sheet.set_cell("A2", Value::Number(7.0)); // expected 7
    sheet.set_cell("A3", Value::Number(8.0)); // expected 9
    sheet.set_cell("A4", Value::Number(12.0)); // expected 11
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    sheet.set_cell("B4", Value::Number(4.0));
    assert!(sheet.set_formula("D1", "=STEYX(A1:A4, B1:B4)"));
    match sheet.get_cell("D1") {
        Value::Number(n) => assert!(n > 0.0 && n < 5.0, "got {}", n),
        other => panic!("expected positive SE, got {:?}", other),
    }
}

#[test]
fn steyx_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=STEYX(B1:B3)"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

#[test]
fn steyx_too_few_points_returns_div_by_zero() {
    let mut sheet = Sheet::new();
    // Only 2 points → n - 2 = 0 in the denominator.
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    assert!(sheet.set_formula("D1", "=STEYX(A1:A2, B1:B2)"));
    assert_eq!(
        sheet.get_cell("D1"),
        Value::Error(ValueError::DivisionByZero)
    );
}

// ============================================================
//  RSQ
// ============================================================

#[test]
fn rsq_perfect_fit_returns_one() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("A3", Value::Number(6.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=RSQ(A1:A3, B1:B3)"));
    assert_num(sheet.get_cell("D1"), 1.0, 1e-9);
}

#[test]
fn rsq_inverted_data_still_returns_one() {
    let mut sheet = Sheet::new();
    // Negative correlation but perfect → R² = 1.
    sheet.set_cell("A1", Value::Number(6.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("A3", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=RSQ(A1:A3, B1:B3)"));
    assert_num(sheet.get_cell("D1"), 1.0, 1e-9);
}

#[test]
fn rsq_shape_mismatch_returns_value_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=RSQ(A1:A2, B1:B3)"));
    assert_eq!(sheet.get_cell("D1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn rsq_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=RSQ()"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}

// ============================================================
//  PEARSON (aliased to CORREL)
// ============================================================

#[test]
fn pearson_matches_correl_perfect_positive() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("A3", Value::Number(6.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=PEARSON(A1:A3, B1:B3)"));
    assert!(sheet.set_formula("D2", "=CORREL(A1:A3, B1:B3)"));
    let p = sheet.get_cell("D1");
    let c = sheet.get_cell("D2");
    match (p, c) {
        (Value::Number(pp), Value::Number(cc)) => {
            assert!((pp - cc).abs() < 1e-12);
            assert!((pp - 1.0).abs() < 1e-9);
        }
        other => panic!("expected matching numbers, got {:?}", other),
    }
}

#[test]
fn pearson_inverted_returns_minus_one() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(6.0));
    sheet.set_cell("A2", Value::Number(4.0));
    sheet.set_cell("A3", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=PEARSON(A1:A3, B1:B3)"));
    assert_num(sheet.get_cell("D1"), -1.0, 1e-9);
}

#[test]
fn pearson_shape_mismatch_returns_value_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("B1", Value::Number(1.0));
    sheet.set_cell("B2", Value::Number(2.0));
    sheet.set_cell("B3", Value::Number(3.0));
    assert!(sheet.set_formula("D1", "=PEARSON(A1:A2, B1:B3)"));
    assert_eq!(sheet.get_cell("D1"), Value::Error(ValueError::InvalidValue));
}

#[test]
fn pearson_arg_count_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=PEARSON()"));
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::WrongArgCount)
    );
}
