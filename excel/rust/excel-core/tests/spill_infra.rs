//! Phase 1 regression tests for the dynamic-array (spill) infrastructure.
//!
//! These exercise the foundation that lets a sheet *spill* a
//! `Value::Array` written to an anchor cell into derived atoms at the
//! non-(0,0) targets. No user-facing array-producing function exists in
//! Phase 1 — tests drive the system via `Sheet::set_array`, the
//! debug/test entry point.
//!
//! See `excel/rust/core/src/atom.rs` § `ArrayData` and
//! `excel/rust/excel-core/src/sheet.rs` § "Spill (dynamic-array) infrastructure"
//! for the design rationale.

use std::sync::Arc;

use einfach_core::{ArrayData, Value, ValueError};
use einfach_excel_core::{Sheet, SheetError};

/// Build a column array `data.len() x 1`.
fn col_array(data: Vec<Value>) -> Arc<ArrayData> {
    let rows = data.len() as u32;
    Arc::new(ArrayData::new(rows, 1, data))
}

/// Build a `rows x cols` row-major array.
fn array_2d(rows: u32, cols: u32, data: Vec<Value>) -> Arc<ArrayData> {
    Arc::new(ArrayData::new(rows, cols, data))
}

// === Happy paths ===

/// 3x1 array at A1 spills into A2/A3. The anchor still reports the
/// raw Array value at the sheet level (boundary collapse is the WASM
/// layer's concern). A2/A3 are now derived atoms returning element
/// [1][0] and [2][0] respectively.
#[test]
fn spill_3x1_at_a1() {
    let mut sheet = Sheet::new();
    let arr = col_array(vec![
        Value::Number(10.0),
        Value::Number(20.0),
        Value::Number(30.0),
    ]);
    sheet.set_array("A1", arr).expect("spill should succeed");

    // Anchor: returns the underlying Array. (UI / WASM boundary collapses
    // to top-left; sheet-level peek keeps the Array for spill_info.)
    match sheet.get_cell("A1") {
        Value::Array(a) => {
            assert_eq!(a.shape(), (3, 1));
            assert_eq!(a.get(0, 0), Some(&Value::Number(10.0)));
        }
        other => panic!("expected Array at anchor, got {:?}", other),
    }

    // Spilled cells: derived atoms returning their indexed scalars.
    assert_eq!(sheet.get_cell("A2"), Value::Number(20.0));
    assert_eq!(sheet.get_cell("A3"), Value::Number(30.0));
}

/// 2x3 array at B2 — fills B2..D3.
#[test]
fn spill_2x3_at_b2() {
    let mut sheet = Sheet::new();
    let arr = array_2d(
        2,
        3,
        vec![
            Value::Number(1.0),
            Value::Number(2.0),
            Value::Number(3.0),
            Value::Number(4.0),
            Value::Number(5.0),
            Value::Number(6.0),
        ],
    );
    sheet.set_array("B2", arr).expect("spill should succeed");

    // Anchor — Array, with [0][0] = 1.
    match sheet.get_cell("B2") {
        Value::Array(a) => assert_eq!(a.get(0, 0), Some(&Value::Number(1.0))),
        other => panic!("expected Array at anchor, got {:?}", other),
    }
    // Row 0, cols 1-2: C2 = 2, D2 = 3.
    assert_eq!(sheet.get_cell("C2"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("D2"), Value::Number(3.0));
    // Row 1: B3 = 4, C3 = 5, D3 = 6.
    assert_eq!(sheet.get_cell("B3"), Value::Number(4.0));
    assert_eq!(sheet.get_cell("C3"), Value::Number(5.0));
    assert_eq!(sheet.get_cell("D3"), Value::Number(6.0));
}

// === Collision behavior ===

/// Pre-existing primitive in the spill target rectangle should block
/// the spill. The anchor receives `#SPILL!`; the obstructing cell is
/// untouched and no derived atoms are installed.
#[test]
fn collision_blocks_spill_anchor_gets_spill_error() {
    let mut sheet = Sheet::new();
    sheet.set_cell("C5", Value::Number(42.0));
    let arr = array_2d(
        3,
        3,
        vec![
            Value::Number(1.0),
            Value::Number(2.0),
            Value::Number(3.0),
            Value::Number(4.0),
            Value::Number(5.0),
            Value::Number(6.0),
            Value::Number(7.0),
            Value::Number(8.0),
            Value::Number(9.0),
        ],
    );
    sheet
        .set_array("A5", arr)
        .expect("set_array should not error on collision; anchor reflects #SPILL!");

    // Anchor: #SPILL! error.
    assert_eq!(
        sheet.get_cell("A5"),
        Value::Error(ValueError::Spill),
        "anchor should hold #SPILL! after collision"
    );
    // Obstructing cell preserved.
    assert_eq!(sheet.get_cell("C5"), Value::Number(42.0));
    // No spilled atoms — other target slots are still empty.
    assert_eq!(sheet.get_cell("B5"), Value::Null);
    assert_eq!(sheet.get_cell("B6"), Value::Null);
    // And the anchor no longer reports spill shape (it has no Array).
    let parsed = einfach_excel_core::CellAddress::parse("A5").unwrap();
    assert_eq!(sheet.spill_info(parsed), None);
}

/// Phase 1 limitation: clearing the obstructing cell does NOT
/// auto-retry the spill. The user has to call `set_array` again.
/// This test documents that limitation.
#[test]
fn collision_does_not_auto_retry_on_clear() {
    let mut sheet = Sheet::new();
    sheet.set_cell("C5", Value::Number(42.0));
    let arr = || {
        array_2d(
            3,
            3,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
                Value::Number(7.0),
                Value::Number(8.0),
                Value::Number(9.0),
            ],
        )
    };
    sheet.set_array("A5", arr()).unwrap();
    assert_eq!(sheet.get_cell("A5"), Value::Error(ValueError::Spill));

    // Clear C5; the anchor stays #SPILL! — no auto-retry.
    sheet.clear_cell("C5");
    assert_eq!(
        sheet.get_cell("A5"),
        Value::Error(ValueError::Spill),
        "Phase 1 limitation: cleared obstruction does not auto-revive spill"
    );

    // Caller must explicitly re-trigger the spill.
    sheet.set_array("A5", arr()).unwrap();
    match sheet.get_cell("A5") {
        Value::Array(_) => {}
        other => panic!("expected Array after re-trigger, got {:?}", other),
    }
    // C5 is now spilled into: row 0, col 2 of the 3x3 array → element 3.
    assert_eq!(sheet.get_cell("C5"), Value::Number(3.0));
    // Bottom-right is row 2, col 2 → element 9.
    assert_eq!(sheet.get_cell("C7"), Value::Number(9.0));
}

// === Shape changes ===

/// Replacing a 5x1 anchor with a 3x1 should revert A4/A5 to empty
/// while leaving A2/A3 populated with the new values.
#[test]
fn shape_change_releases_old_targets() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
            ]),
        )
        .unwrap();
    assert_eq!(sheet.get_cell("A5"), Value::Number(5.0));
    assert_eq!(sheet.get_cell("A4"), Value::Number(4.0));

    // Re-spill smaller.
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(100.0),
                Value::Number(200.0),
                Value::Number(300.0),
            ]),
        )
        .unwrap();
    assert_eq!(sheet.get_cell("A2"), Value::Number(200.0));
    assert_eq!(sheet.get_cell("A3"), Value::Number(300.0));
    // A4 and A5 reverted to empty.
    assert_eq!(sheet.get_cell("A4"), Value::Null);
    assert_eq!(sheet.get_cell("A5"), Value::Null);
}

/// Clearing the anchor should tear the whole spill down — A2..A5
/// revert to Null.
#[test]
fn clear_anchor_collapses_spill() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
            ]),
        )
        .unwrap();
    assert_eq!(sheet.get_cell("A5"), Value::Number(5.0));

    sheet.clear_cell("A1");
    assert_eq!(sheet.get_cell("A1"), Value::Null);
    for addr in ["A2", "A3", "A4", "A5"] {
        assert_eq!(
            sheet.get_cell(addr),
            Value::Null,
            "{} should be empty after anchor clear",
            addr
        );
    }
}

// === Write rejection ===

/// Writing a value to a spilled (non-anchor) cell must fail.
#[test]
fn write_to_spilled_cell_rejected() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(10.0),
                Value::Number(20.0),
                Value::Number(30.0),
            ]),
        )
        .unwrap();
    // A2 is now spilled.
    let result = sheet.try_set_cell("A2", Value::Number(99.0));
    match result {
        Err(SheetError::SpillCellWrite { anchor }) => {
            assert_eq!(anchor.to_string_repr(), "A1");
        }
        other => panic!("expected SpillCellWrite, got {:?}", other),
    }
    // A2's value unchanged — still the spill element.
    assert_eq!(sheet.get_cell("A2"), Value::Number(20.0));
}

/// Same rejection for `try_set_formula`.
#[test]
fn write_formula_to_spilled_cell_rejected() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![Value::Number(10.0), Value::Number(20.0)]),
        )
        .unwrap();
    let result = sheet.try_set_formula("A2", "=1+1");
    match result {
        Err(SheetError::SpillCellWrite { anchor }) => {
            assert_eq!(anchor.to_string_repr(), "A1");
        }
        other => panic!("expected SpillCellWrite, got {:?}", other),
    }
    // A2 still the spill element.
    assert_eq!(sheet.get_cell("A2"), Value::Number(20.0));
}

// === Subscription / atom-graph propagation ===

/// A formula reading a spilled cell must auto-recompute when the spill
/// changes. Specifically: place a 3x1 array at A1, then put `=A2+10`
/// at B1; replace the array — B1 should reflect the new A2 element.
#[test]
fn formula_on_spilled_cell_recomputes_on_anchor_change() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
            ]),
        )
        .unwrap();
    sheet.set_formula("B1", "=A2+10");
    assert_eq!(sheet.get_cell("B1"), Value::Number(12.0));

    // Replace the array — different values, same shape.
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(100.0),
                Value::Number(200.0),
                Value::Number(300.0),
            ]),
        )
        .unwrap();
    assert_eq!(
        sheet.get_cell("B1"),
        Value::Number(210.0),
        "B1 must recompute after the anchor's array changed"
    );
}

// === UI helper: spill_info ===

#[test]
fn spill_info_reports_anchor_shape_only() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "B2",
            array_2d(
                2,
                3,
                vec![
                    Value::Number(1.0),
                    Value::Number(2.0),
                    Value::Number(3.0),
                    Value::Number(4.0),
                    Value::Number(5.0),
                    Value::Number(6.0),
                ],
            ),
        )
        .unwrap();
    let parse = |s: &str| einfach_excel_core::CellAddress::parse(s).unwrap();

    // Anchor: returns shape.
    assert_eq!(sheet.spill_info(parse("B2")), Some((2, 3)));
    // Spilled-into cells: None.
    assert_eq!(sheet.spill_info(parse("C2")), None);
    assert_eq!(sheet.spill_info(parse("D3")), None);
    // Cell with a plain primitive: None.
    sheet.set_cell("Z1", Value::Number(99.0));
    assert_eq!(sheet.spill_info(parse("Z1")), None);
    // Empty cell: None.
    assert_eq!(sheet.spill_info(parse("M10")), None);
}

#[test]
fn is_spilled_distinguishes_anchor_from_targets() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
            ]),
        )
        .unwrap();
    let parse = |s: &str| einfach_excel_core::CellAddress::parse(s).unwrap();
    // Anchor: not spilled-into.
    assert!(!sheet.is_spilled(parse("A1")));
    // Targets: yes.
    assert!(sheet.is_spilled(parse("A2")));
    assert!(sheet.is_spilled(parse("A3")));
    // Outside the range: no.
    assert!(!sheet.is_spilled(parse("A4")));
    assert!(!sheet.is_spilled(parse("B1")));
}

// === Boundary collapse (sheet-level marker for WASM contract) ===
//
// The WASM boundary (`excel/rust/wasm/src/lib.rs` § `collapse_array_for_js`)
// collapses `Value::Array` to its top-left scalar before crossing into
// JS. We can't import `collapse_array_for_js` directly here — it's
// crate-private to `einfach-wasm` — but the contract is enforced
// across every wasm cell-read entry point:
//
//   * `WasmSheet::get_display`  → `value_to_display` (collapsed)
//   * `WasmSheet::get_number`   → `collapse_array_for_js` then match
//   * `WasmSheet::get_type`     → `value_to_cell_type` (collapsed)
//   * `WasmSheet::is_error`     → reads through `get_cell`; `Value::Array`
//                                 is `is_error == false`, JS sees false
//                                 unless the anchor holds `Value::Error`.
//   * `sparse_cell_from_value`  → `collapse_array_for_js` before match
//
// This test documents the contract at the sheet level: anchor reads
// at the SHEET layer DO return `Value::Array`, but the WASM-bound
// `value_to_display` / `value_to_cell_type` family collapses to the
// top-left element. The actual JS-visible boundary is covered by the
// `wasm` crate's tests; here we just assert the in-process collapse
// behavior used by `Sheet::formatted_display`.
#[test]
fn formatted_display_collapses_array_anchor_to_top_left() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![
                Value::Number(42.0),
                Value::Number(7.0),
                Value::Number(13.0),
            ]),
        )
        .unwrap();
    // `formatted_display` is the sheet-side analog of the wasm display
    // path. Returns "42" not the debug rendering of an Array.
    assert_eq!(sheet.formatted_display("A1"), "42");
    // Spilled cells: their derived atom returns the indexed scalar
    // directly, no collapse needed.
    assert_eq!(sheet.formatted_display("A2"), "7");
    assert_eq!(sheet.formatted_display("A3"), "13");
}

// === Anchor scalar-context behavior ===

/// `=A1 + 1` where A1 is an anchor with `[42, 7, 13]` should collapse
/// to 42 in the scalar binop context (Excel "implicit intersection").
#[test]
fn anchor_in_scalar_context_collapses_to_top_left() {
    let mut sheet = Sheet::new();
    sheet
        .set_array(
            "A1",
            col_array(vec![Value::Number(42.0), Value::Number(7.0)]),
        )
        .unwrap();
    sheet.set_formula("B1", "=A1+1");
    assert_eq!(sheet.get_cell("B1"), Value::Number(43.0));
}

// === Empty array edge case ===

/// A 0-element array (shape 0x0) should still install cleanly — the
/// anchor holds the Array and no targets exist. Mostly a sanity check
/// that `register_spill` doesn't panic on the empty case.
#[test]
fn empty_array_installs_without_targets() {
    let mut sheet = Sheet::new();
    let arr = Arc::new(ArrayData::new(0, 0, vec![]));
    sheet.set_array("A1", arr).unwrap();
    match sheet.get_cell("A1") {
        Value::Array(a) => assert_eq!(a.shape(), (0, 0)),
        other => panic!("expected empty Array at anchor, got {:?}", other),
    }
}
