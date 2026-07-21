//! Sheet-index maintenance for the host-pushed hidden-row side stores.
//!
//! `WorkbookAtomContext::eval_hidden_rows` / `eval_filter_hidden_rows` are keyed
//! by 0-based SHEET INDEX (sheet.rs §"Host-pushed per-sheet ... row sets"). Any
//! workbook operation that shifts sheet indices must therefore remap those keys,
//! exactly as `remove_sheet` / `move_sheet` already remap the wasm layer's
//! subscription tokens (`remap_sheet_index_after_move`).
//!
//! Before the fix neither `remove_sheet` nor `move_sheet` touched the two maps,
//! so a hidden set silently re-attached to whichever sheet slid into its old
//! index. That is invisible to the host: the JS bridge subscribes to
//! `viewportHiddenAtom`, which a sheet deletion never touches, so there is no
//! re-push to self-heal the drift.
//!
//! Two failure shapes are covered for each entry point:
//!   - ORPHAN — the set's owner moved away, so its SUBTOTAL 101-111 stops
//!     excluding rows it must still exclude,
//!   - MIS-ATTRIBUTION — an unrelated sheet slid into the vacated index and
//!     inherited a hidden set it never had.
//!
//! `add_sheet` is deliberately covered too: it pushes at the end and therefore
//! must NOT perturb existing keys (a guard against an over-eager remap).

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Fill A1..A5 on `sheet_idx` with 1..=5 and park `=SUBTOTAL(109, A1:A5)` in C1
/// plus `=SUBTOTAL(9, A1:A5)` in C2 (the 1-11 twin, which never reads the
/// MANUAL store).
fn seed(wb: &mut Workbook, sheet_idx: usize) {
    for i in 0..5 {
        wb.set_cell(sheet_idx, &format!("A{}", i + 1), Value::Number((i + 1) as f64));
    }
    assert!(wb.set_formula(sheet_idx, "C1", "=SUBTOTAL(109, A1:A5)"));
    assert!(wb.set_formula(sheet_idx, "C2", "=SUBTOTAL(9, A1:A5)"));
}

fn num(wb: &Workbook, sheet: &str, addr: &str) -> f64 {
    match wb.get_cell(sheet, addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {sheet}!{addr}, got {other:?}"),
    }
}

/// A workbook with `Sheet1..SheetN`, every sheet seeded with the same data and
/// the same pair of SUBTOTAL formulas.
fn workbook_with_sheets(n: usize) -> Workbook {
    let mut wb = Workbook::new();
    for i in 1..n {
        assert_eq!(wb.add_sheet(&format!("Sheet{}", i + 1)), i);
    }
    for i in 0..n {
        seed(&mut wb, i);
    }
    wb
}

// ===================== remove_sheet =====================

/// THE COUNTEREXAMPLE. Hidden rows pushed to the third sheet must keep
/// excluding after an EARLIER sheet is deleted and every later index shifts
/// down by one.
#[test]
fn remove_sheet_keeps_manual_hidden_rows_with_their_sheet() {
    let mut wb = workbook_with_sheets(3);

    // Hide rows 1 and 3 (0-based) on Sheet3 → 1 + 3 + 5 = 9.
    wb.set_eval_hidden_rows(2, &[1, 3]);
    assert_eq!(num(&wb, "Sheet3", "C1"), 9.0, "precondition: 109 excludes on Sheet3");
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0, "precondition: Sheet1 has no hidden rows");

    // Delete Sheet2 → Sheet3 slides from index 2 to index 1.
    assert!(wb.remove_sheet(1).is_some());

    // Unfixed: the set is still filed under key 2, Sheet3 now probes key 1,
    // misses, and silently stops excluding → 15.0.
    assert_eq!(
        num(&wb, "Sheet3", "C1"),
        9.0,
        "SUBTOTAL(109) on Sheet3 must still exclude its hidden rows after an \
         earlier sheet is removed"
    );
    assert_eq!(num(&wb, "Sheet3", "C2"), 15.0, "SUBTOTAL(9) stays unaffected");
}

/// The mis-attribution half: a sheet that slides INTO the vacated index must
/// not inherit the departed sheet's hidden set.
#[test]
fn remove_sheet_does_not_leak_hidden_rows_onto_the_shifted_in_sheet() {
    let mut wb = workbook_with_sheets(4);

    wb.set_eval_hidden_rows(2, &[1, 3]); // Sheet3
    assert_eq!(num(&wb, "Sheet4", "C1"), 15.0, "precondition: Sheet4 has no hidden rows");

    // Delete Sheet1 → Sheet3 lands on 1, Sheet4 lands on 2 (Sheet3's old key).
    assert!(wb.remove_sheet(0).is_some());

    assert_eq!(num(&wb, "Sheet3", "C1"), 9.0, "Sheet3 keeps its own hidden set");
    assert_eq!(
        num(&wb, "Sheet4", "C1"),
        15.0,
        "Sheet4 must NOT inherit Sheet3's hidden set by sliding into index 2"
    );
}

/// Deleting the sheet that OWNS a hidden set drops the entry outright — it must
/// not survive to be re-attached to a later sheet.
#[test]
fn remove_sheet_drops_the_removed_sheets_own_hidden_set() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_hidden_rows(1, &[1, 3]); // Sheet2
    assert_eq!(num(&wb, "Sheet2", "C1"), 9.0);

    assert!(wb.remove_sheet(1).is_some()); // Sheet3 slides into index 1

    assert_eq!(
        num(&wb, "Sheet3", "C1"),
        15.0,
        "the removed Sheet2's hidden set must die with it, not adopt Sheet3"
    );
}

/// The FILTER store is an independent map with the same keying, so it needs the
/// same maintenance. Probed through SUBTOTAL(9) — the 1-11 layer reads the
/// filter store but never the manual one.
#[test]
fn remove_sheet_keeps_filter_hidden_rows_with_their_sheet() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_filter_hidden_rows(2, &[1, 3]); // Sheet3
    assert_eq!(num(&wb, "Sheet3", "C2"), 9.0, "precondition: 9 excludes filter-hidden");

    assert!(wb.remove_sheet(1).is_some());

    assert_eq!(
        num(&wb, "Sheet3", "C2"),
        9.0,
        "SUBTOTAL(9) on Sheet3 must still exclude its filter-hidden rows"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        15.0,
        "Sheet1 must not inherit a filter-hidden set"
    );
}

// ===================== move_sheet =====================

/// Dragging a sheet backwards (`from > to`) shifts every sheet in `[to, from)`
/// up by one; the hidden sets must ride along.
#[test]
fn move_sheet_backwards_carries_hidden_rows() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_hidden_rows(2, &[1, 3]); // Sheet3

    // Sheet3 to the front: order becomes Sheet3, Sheet1, Sheet2.
    assert!(wb.move_sheet(2, 0));

    assert_eq!(num(&wb, "Sheet3", "C1"), 9.0, "Sheet3 keeps its hidden set at its new index");
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0, "Sheet1 stays clean");
    assert_eq!(
        num(&wb, "Sheet2", "C1"),
        15.0,
        "Sheet2 must not inherit the set by sliding into index 2"
    );
}

/// Dragging a sheet forwards (`from < to`) shifts every sheet in `(from, to]`
/// down by one — the opposite rotation.
#[test]
fn move_sheet_forwards_carries_hidden_rows() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_hidden_rows(0, &[1, 3]); // Sheet1

    // Sheet1 to the back: order becomes Sheet2, Sheet3, Sheet1.
    assert!(wb.move_sheet(0, 2));

    assert_eq!(num(&wb, "Sheet1", "C1"), 9.0, "Sheet1 keeps its hidden set at index 2");
    assert_eq!(
        num(&wb, "Sheet2", "C1"),
        15.0,
        "Sheet2 must not inherit the set by sliding into index 0"
    );
    assert_eq!(num(&wb, "Sheet3", "C1"), 15.0, "Sheet3 stays clean");
}

/// Sets on sheets OUTSIDE the moved span are untouched by the rotation.
#[test]
fn move_sheet_leaves_untouched_sheets_alone() {
    let mut wb = workbook_with_sheets(4);

    wb.set_eval_hidden_rows(3, &[1, 3]); // Sheet4, outside the (0..=1) span

    assert!(wb.move_sheet(0, 1)); // swap Sheet1/Sheet2 only

    assert_eq!(num(&wb, "Sheet4", "C1"), 9.0, "Sheet4 is outside the rotation");
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet2", "C1"), 15.0);
}

/// The filter store rides the same rotation.
#[test]
fn move_sheet_carries_filter_hidden_rows() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_filter_hidden_rows(2, &[1, 3]); // Sheet3
    assert!(wb.move_sheet(2, 0));

    assert_eq!(num(&wb, "Sheet3", "C2"), 9.0, "filter set follows Sheet3");
    assert_eq!(num(&wb, "Sheet2", "C2"), 15.0, "Sheet2 must not inherit it");
}

/// Both stores are remapped independently in one move — a sanity check that the
/// two maps do not shadow or overwrite each other.
#[test]
fn move_sheet_carries_both_stores_at_once() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_hidden_rows(2, &[1]); // Sheet3: manual, row 1 (=2)
    wb.set_eval_filter_hidden_rows(2, &[3]); // Sheet3: filter, row 3 (=4)

    // 109 excludes both layers → 1 + 3 + 5 = 9; 9 excludes only filter → 11.
    assert_eq!(num(&wb, "Sheet3", "C1"), 9.0);
    assert_eq!(num(&wb, "Sheet3", "C2"), 11.0);

    assert!(wb.move_sheet(2, 0));

    assert_eq!(num(&wb, "Sheet3", "C1"), 9.0, "manual + filter both follow Sheet3");
    assert_eq!(num(&wb, "Sheet3", "C2"), 11.0, "filter-only layer follows too");
}

/// A no-op move must not disturb anything.
#[test]
fn move_sheet_to_same_index_is_inert() {
    let mut wb = workbook_with_sheets(3);

    wb.set_eval_hidden_rows(1, &[1, 3]);
    assert!(wb.move_sheet(1, 1));

    assert_eq!(num(&wb, "Sheet2", "C1"), 9.0);
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet3", "C1"), 15.0);
}

// ===================== add_sheet (must NOT remap) =====================

/// `add_sheet` appends, so no existing index moves and no key may be touched.
#[test]
fn add_sheet_leaves_hidden_rows_in_place() {
    let mut wb = workbook_with_sheets(2);

    wb.set_eval_hidden_rows(1, &[1, 3]); // Sheet2
    assert_eq!(wb.add_sheet("Sheet3"), 2);
    seed(&mut wb, 2);

    assert_eq!(num(&wb, "Sheet2", "C1"), 9.0, "Sheet2 keeps its set across an append");
    assert_eq!(num(&wb, "Sheet3", "C1"), 15.0, "the new sheet starts clean");
}

/// `rename_sheet` changes no index, so the index-keyed sets must survive it
/// untouched (the Table registry, keyed by NAME, needs the opposite care —
/// documenting that the two identities are genuinely different).
#[test]
fn rename_sheet_leaves_hidden_rows_in_place() {
    let mut wb = workbook_with_sheets(2);

    wb.set_eval_hidden_rows(1, &[1, 3]);
    assert!(wb.rename_sheet(1, "Renamed"));

    assert_eq!(num(&wb, "Renamed", "C1"), 9.0, "a rename must not move the hidden set");
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
}
