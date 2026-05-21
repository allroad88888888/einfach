//! Phase 3 end-to-end tests: dynamic-array (spill) functions
//! SEQUENCE / UNIQUE / SORT / FILTER drive the spill machinery
//! through real formulas, not the `Sheet::set_array` debug entry
//! point.
//!
//! See `vanilla/spreadsheet-ui-core/docs/ROADMAP.md` for the Phase 3
//! scope, `rust/core/src/atom.rs` § `ArrayData` for the value variant,
//! and `rust/excel-core/src/sheet.rs` § "Spill (dynamic-array)
//! infrastructure" for the design that lets a formula installed at an
//! anchor cell spill into derived atoms at the non-(0,0) targets.

use einfach_core::{Value, ValueError};
use einfach_excel_core::{CellAddress, Sheet, Workbook};

// === SEQUENCE — basic spill round-trip ===

/// `=SEQUENCE(5)` at A1 spills into A2..A5. A1's raw value is a
/// `Value::Array(5x1)`; A2..A5 return the scalar elements through
/// their derived atoms.
#[test]
fn sequence_spills_through_real_formula() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=SEQUENCE(5)"));

    // Anchor: an Array (sheet-level read; the WASM boundary collapses).
    match sheet.get_cell("A1") {
        Value::Array(a) => {
            assert_eq!(a.shape(), (5, 1));
            assert_eq!(a.get(0, 0), Some(&Value::Number(1.0)));
        }
        other => panic!("expected Array at anchor, got {:?}", other),
    }

    // Spilled cells: derived atoms returning their indexed scalars.
    assert_eq!(sheet.get_cell("A2"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("A3"), Value::Number(3.0));
    assert_eq!(sheet.get_cell("A4"), Value::Number(4.0));
    assert_eq!(sheet.get_cell("A5"), Value::Number(5.0));

    // A6 is outside the spill range — empty.
    assert_eq!(sheet.get_cell("A6"), Value::Null);

    // spill_info / is_spilled report the topology correctly.
    let parse = |s: &str| CellAddress::parse(s).unwrap();
    assert_eq!(sheet.spill_info(parse("A1")), Some((5, 1)));
    assert_eq!(sheet.spill_info(parse("A2")), None);
    assert!(!sheet.is_spilled(parse("A1")));
    assert!(sheet.is_spilled(parse("A2")));
    assert!(sheet.is_spilled(parse("A5")));
    assert!(!sheet.is_spilled(parse("A6")));
}

// === Recompute on dependency change ===

/// `=SEQUENCE(B1)` at A1, where B1 starts at 5. Changing B1 to 3
/// must shrink the spill: A1..A3 keep values, A4..A5 revert to empty.
#[test]
fn sequence_recomputes_on_dependency_change() {
    let mut sheet = Sheet::new();
    sheet.set_cell("B1", Value::Number(5.0));
    assert!(sheet.set_formula("A1", "=SEQUENCE(B1)"));

    // Initial: 5×1.
    assert!(matches!(sheet.get_cell("A1"), Value::Array(_)));
    assert_eq!(sheet.get_cell("A5"), Value::Number(5.0));

    // Shrink to 3 rows.
    sheet.set_cell("B1", Value::Number(3.0));

    match sheet.get_cell("A1") {
        Value::Array(a) => assert_eq!(a.shape(), (3, 1)),
        other => panic!("expected shrunken Array at anchor, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("A2"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("A3"), Value::Number(3.0));
    // A4 and A5 should revert to empty after the spill shrinks.
    assert_eq!(sheet.get_cell("A4"), Value::Null);
    assert_eq!(sheet.get_cell("A5"), Value::Null);
}

// === #SPILL! collision through real formula ===

/// Pre-existing primitive in the spill target rectangle blocks the
/// spill. The anchor surfaces `#SPILL!`; the obstructing cell keeps
/// its value.
#[test]
fn sequence_spill_collision_surfaces_spill_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A3", Value::Number(99.0));
    assert!(sheet.set_formula("A1", "=SEQUENCE(5)"));

    // A1: #SPILL!
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::Spill));
    // A3 untouched.
    assert_eq!(sheet.get_cell("A3"), Value::Number(99.0));
    // No spilled atoms installed at A2 / A4 / A5.
    assert_eq!(sheet.get_cell("A2"), Value::Null);
    assert_eq!(sheet.get_cell("A4"), Value::Null);
    assert_eq!(sheet.get_cell("A5"), Value::Null);
    // The anchor has no spill shape.
    let parsed = CellAddress::parse("A1").unwrap();
    assert_eq!(sheet.spill_info(parsed), None);
}

// === UNIQUE round-trip ===

/// `=UNIQUE(A1:A5)` over [1, 2, 2, 3, 1] spills to [1, 2, 3] at the
/// anchor. Drives both the eval function and the spill registration
/// end-to-end through the formula path.
#[test]
fn unique_spills_through_real_formula() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("A3", Value::Number(2.0));
    sheet.set_cell("A4", Value::Number(3.0));
    sheet.set_cell("A5", Value::Number(1.0));

    assert!(sheet.set_formula("C1", "=UNIQUE(A1:A5)"));

    match sheet.get_cell("C1") {
        Value::Array(a) => assert_eq!(a.shape(), (3, 1)),
        other => panic!("expected Array at C1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("C2"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("C3"), Value::Number(3.0));
    // No row 4 — only 3 unique values.
    assert_eq!(sheet.get_cell("C4"), Value::Null);
}

// === SORT round-trip ===

/// `=SORT(A1:A3)` over [3, 1, 2] spills to [1, 2, 3].
#[test]
fn sort_spills_through_real_formula() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(3.0));
    sheet.set_cell("A2", Value::Number(1.0));
    sheet.set_cell("A3", Value::Number(2.0));

    assert!(sheet.set_formula("C1", "=SORT(A1:A3)"));

    assert!(matches!(sheet.get_cell("C1"), Value::Array(_)));
    assert_eq!(sheet.get_cell("C2"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("C3"), Value::Number(3.0));
}

// === FILTER round-trip ===

/// `=FILTER(A1:A4, B1:B4)` keeps rows where include's matching
/// element is truthy.
#[test]
fn filter_spills_through_real_formula() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("A2", Value::Number(20.0));
    sheet.set_cell("A3", Value::Number(30.0));
    sheet.set_cell("A4", Value::Number(40.0));
    sheet.set_cell("B1", Value::Boolean(true));
    sheet.set_cell("B2", Value::Boolean(false));
    sheet.set_cell("B3", Value::Boolean(true));
    sheet.set_cell("B4", Value::Boolean(false));

    assert!(sheet.set_formula("D1", "=FILTER(A1:A4, B1:B4)"));

    match sheet.get_cell("D1") {
        Value::Array(a) => assert_eq!(a.shape(), (2, 1)),
        other => panic!("expected Array at D1, got {:?}", other),
    }
    assert_eq!(sheet.get_cell("D2"), Value::Number(30.0));
    // D3 is past the 2-element result.
    assert_eq!(sheet.get_cell("D3"), Value::Null);
}

// === Workbook-level smoke test ===

/// Drive a SEQUENCE through the Workbook API end-to-end.
#[test]
fn workbook_sequence_round_trip() {
    let mut wb = Workbook::new();
    let idx = wb.add_sheet("Main");
    assert!(wb.set_formula(idx, "A1", "=SEQUENCE(3)"));

    // The workbook-level read goes through `peek_value_with_provider`
    // which DOES surface the raw `Value::Array` at the anchor (the
    // WASM-boundary collapse lives in `rust/wasm`, not in
    // `Workbook::get_cell` itself).
    match wb.get_cell("Main", "A1") {
        Value::Array(a) => assert_eq!(a.shape(), (3, 1)),
        other => panic!("expected Array at A1, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Main", "A2"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Main", "A3"), Value::Number(3.0));
}

// === Replacing the formula tears down the spill ===

/// Replacing an array formula with a scalar formula must release the
/// previously spilled targets back to empty.
#[test]
fn replacing_array_formula_with_scalar_clears_spill() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("A1", "=SEQUENCE(5)"));
    assert_eq!(sheet.get_cell("A5"), Value::Number(5.0));

    // Swap to a scalar formula. A2..A5 should revert to empty.
    assert!(sheet.set_formula("A1", "=42"));
    assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
    for addr in ["A2", "A3", "A4", "A5"] {
        assert_eq!(
            sheet.get_cell(addr),
            Value::Null,
            "{} should be empty after array formula replacement",
            addr
        );
    }
}
