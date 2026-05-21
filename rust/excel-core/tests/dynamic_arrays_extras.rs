//! Phase 4 end-to-end tests: dynamic-array functions added in this batch
//! (SORTBY / RANDARRAY / TAKE / DROP / VSTACK / HSTACK / CHOOSEROWS /
//! CHOOSECOLS / TOROW / TOCOL) routed through the real spill path —
//! `Sheet::set_formula` + `try_set_formula` + `install_formula_spill`.
//!
//! The auto-spill scanner in `sheet.rs` (`expr_may_produce_array`) lists
//! all of these explicitly, so installing one of these formulas at an
//! anchor cell must spill into the surrounding cells without any
//! additional debug API.

use einfach_core::{Value, ValueError};
use einfach_excel_core::{Sheet, Workbook};

// === SORTBY end-to-end ===

/// `=SORTBY(A1:A4, B1:B4, 1, C1:C4, 1)` at D1 spills the sorted data
/// column into D1..D4. Verifies multi-key stable sort surfaces through
/// the spill anchor + derived atoms.
#[test]
fn sortby_multi_key_round_trip() {
    let mut sheet = Sheet::new();
    // A: data column.
    sheet.set_cell("A1", Value::Text("w".into()));
    sheet.set_cell("A2", Value::Text("x".into()));
    sheet.set_cell("A3", Value::Text("y".into()));
    sheet.set_cell("A4", Value::Text("z".into()));
    // B: primary key.
    for (r, n) in [1.0, 1.0, 2.0, 2.0].iter().enumerate() {
        sheet.set_cell(&format!("B{}", r + 1), Value::Number(*n));
    }
    // C: secondary key.
    for (r, n) in [20.0, 10.0, 20.0, 10.0].iter().enumerate() {
        sheet.set_cell(&format!("C{}", r + 1), Value::Number(*n));
    }
    assert!(sheet.set_formula("D1", "=SORTBY(A1:A4, B1:B4, 1, C1:C4, 1)"));
    // Expected order: x, w, z, y (see eval_sortby_multi_key_stable_tiebreak).
    match sheet.get_cell("D1") {
        Value::Array(a) => assert_eq!(a.shape(), (4, 1)),
        other => panic!("expected Array at D1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("D2"), Value::Text("w".into()));
    assert_eq!(sheet.get_cell("D3"), Value::Text("z".into()));
    assert_eq!(sheet.get_cell("D4"), Value::Text("y".into()));
}

// === TAKE / DROP end-to-end ===

/// `=TAKE(SEQUENCE(5), -2)` at A1 spills [4, 5] into A1..A2.
#[test]
fn take_negative_round_trip() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=TAKE(SEQUENCE(5), -2)"));
    match sheet.get_cell("A1") {
        Value::Array(a) => assert_eq!(a.shape(), (2, 1)),
        other => panic!("expected Array, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("A2"), Value::Number(5.0));
    // A3 should not be in the spill.
    assert_eq!(sheet.get_cell("A3"), Value::Null);
}

/// `=DROP(SEQUENCE(5), 2)` at A1 spills [3, 4, 5] into A1..A3.
#[test]
fn drop_round_trip() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=DROP(SEQUENCE(5), 2)"));
    match sheet.get_cell("A1") {
        Value::Array(a) => assert_eq!(a.shape(), (3, 1)),
        other => panic!("expected Array, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("A2"), Value::Number(4.0));
    assert_eq!(sheet.get_cell("A3"), Value::Number(5.0));
}

// === VSTACK / HSTACK end-to-end ===

/// `=VSTACK(SEQUENCE(1, 3), SEQUENCE(1, 1, 99))` at A1 spills into a
/// 2×3 rectangle with the missing cells padded as #VALUE!.
#[test]
fn vstack_pads_with_value_error() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula(
        "A1",
        "=VSTACK(SEQUENCE(1, 3), SEQUENCE(1, 1, 99))",
    ));
    match sheet.get_cell("A1") {
        Value::Array(a) => assert_eq!(a.shape(), (2, 3)),
        other => panic!("expected Array, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("C1"), Value::Number(3.0));
    assert_eq!(sheet.get_cell("A2"), Value::Number(99.0));
    assert_eq!(sheet.get_cell("B2"), Value::Error(ValueError::InvalidValue));
    assert_eq!(sheet.get_cell("C2"), Value::Error(ValueError::InvalidValue));
}

// === CHOOSEROWS end-to-end via Workbook ===

/// Drive CHOOSEROWS through the workbook to ensure the spill path
/// wires up the same as for any other dynamic-array function.
#[test]
fn workbook_chooserows_round_trip() {
    let mut wb = Workbook::new();
    let idx = wb.add_sheet("Main");
    assert!(wb.set_formula(idx, "A1", "=CHOOSEROWS(SEQUENCE(5), 5, 1, 3)"));
    match wb.get_cell("Main", "A1") {
        Value::Array(a) => assert_eq!(a.shape(), (3, 1)),
        other => panic!("expected Array, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Main", "A2"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Main", "A3"), Value::Number(3.0));
}

// === TOROW / TOCOL end-to-end ===

/// `=TOCOL(SEQUENCE(2, 3))` at A1 spills [1..6] into A1..A6.
#[test]
fn tocol_round_trip() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=TOCOL(SEQUENCE(2, 3))"));
    match sheet.get_cell("A1") {
        Value::Array(a) => assert_eq!(a.shape(), (6, 1)),
        other => panic!("expected Array, got {:?}", other),
    }
    // A1 returns the Array (anchor); A2..A6 return scalars via derived atoms.
    for (r, n) in [2.0, 3.0, 4.0, 5.0, 6.0].iter().enumerate() {
        let cell = format!("A{}", r + 2);
        assert_eq!(sheet.get_cell(&cell), Value::Number(*n), "at {}", cell);
    }
}
