//! Row-index maintenance for the host-pushed hidden-row side stores.
//!
//! Companion to `sheet_index_shift_hidden_rows.rs`, on the OTHER axis. That
//! suite covers the *keys* of `eval_hidden_rows` / `eval_filter_hidden_rows`
//! (sheet indices, remapped by `remove_sheet` / `move_sheet`). This suite
//! covers the *values*: the `u32` ROW numbers inside each set, which must
//! follow `insert_rows` / `delete_rows` on their own sheet.
//!
//! Before the fix `apply_structural_shift_with_table_follow` retargeted every
//! other row-indexed fact on the sheet — cells, formulas, spills, formats,
//! dimensions, and (since T1) Tables — and then stopped. The two hidden-row
//! sets kept their PRE-shift row numbers, so after an insert above a hidden
//! row SUBTOTAL 1-11 / 101-111 excluded a row the host never hid and
//! aggregated one it did.
//!
//! Why this is engine business even though the host also re-pushes: every host
//! push is a whole-set REPLACE of absolute post-shift row indices
//! (`Workbook::set_eval_hidden_rows` / `set_eval_filter_hidden_rows` insert a
//! fresh set, they never merge a delta), so an engine-side shift followed by a
//! host re-push converges on the host's set rather than compounding into a
//! double shift. The engine shift is what makes the engine self-consistent in
//! the window before — or without — a re-push.
//!
//! Coverage: insert and delete; the shift point before / at / after the hidden
//! row; a delete band that SWALLOWS the hidden row (drop, not shift);
//! multi-row batches; the two sets moving independently; other sheets left
//! alone; column ops leaving row sets alone.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Seed `sheet_idx` with A1..A5 = 1..5 and park the two SUBTOTAL layers far
/// below the data, at C10 / D10 (row 9).
///
/// Row 9 is deliberately clear of every edit these tests make (all confined to
/// rows 0..=5), so a formula cell only ever RIDES the shift — it is never
/// deleted out from under the assertion. Each test therefore reads the pair at
/// its post-shift address, stated inline.
///
///   C10 `=SUBTOTAL(109, A1:A5)` — excludes MANUAL-hidden and FILTER-hidden.
///   D10 `=SUBTOTAL(9,   A1:A5)` — excludes FILTER-hidden only.
fn seed(wb: &mut Workbook, sheet_idx: usize) {
    for i in 0..5 {
        wb.set_cell(sheet_idx, &format!("A{}", i + 1), Value::Number((i + 1) as f64));
    }
    assert!(wb.set_formula(sheet_idx, "C10", "=SUBTOTAL(109, A1:A5)"));
    assert!(wb.set_formula(sheet_idx, "D10", "=SUBTOTAL(9, A1:A5)"));
}

fn one_sheet() -> Workbook {
    let mut wb = Workbook::new();
    seed(&mut wb, 0);
    wb
}

fn num(wb: &Workbook, sheet: &str, addr: &str) -> f64 {
    match wb.get_cell(sheet, addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {sheet}!{addr}, got {other:?}"),
    }
}

// ===================== insert_rows =====================

/// THE COUNTEREXAMPLE. Hide 0-based row 3 (`A4` = 4), then insert one row at
/// the TOP. Every value slides down one, so the hidden set must become {4} to
/// keep pointing at the 4.
///
/// Unfixed the set still reads {3}, which now indexes `A4` = 3: SUBTOTAL 109
/// returns 12 instead of 11 — it excludes a row the host never hid.
#[test]
fn insert_above_a_hidden_row_shifts_the_manual_set() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 11.0, "precondition: 15 - 4");

    wb.insert_rows(0, 0, 1);

    // C10 rode the insert down to C11; the range A1:A5 followed to A2:A6.
    assert_eq!(
        num(&wb, "Sheet1", "C11"),
        11.0,
        "hidden row must still be the 4 (set {{3}} -> {{4}}); 12 means the set never shifted"
    );
}

/// Insert exactly AT the hidden row: `index >= at` shifts, so {3} -> {4}. The
/// blank row the insert created lands where the stale index pointed, which is
/// why the unfixed value is a clean 15 — a stale set can also excludes NOTHING.
#[test]
fn insert_at_the_hidden_row_shifts_it() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 11.0, "precondition: 15 - 4");

    wb.insert_rows(0, 3, 1);

    // Range A1:A5 grew to A1:A6 (insert strictly inside); C10 -> C11.
    assert_eq!(
        num(&wb, "Sheet1", "C11"),
        11.0,
        "hidden row must follow to 4; 15 means the set points at the new blank row"
    );
}

/// Guard against an OVER-EAGER shift: an insert strictly below the hidden row
/// displaces nothing in the set.
#[test]
fn insert_below_the_hidden_row_leaves_the_set_alone() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 13.0, "precondition: 15 - 2");

    wb.insert_rows(0, 5, 1);

    assert_eq!(num(&wb, "Sheet1", "C11"), 13.0, "row 1 is above the insert point");
}

/// A multi-row insert shifts by the full `count`, not by one.
#[test]
fn multi_row_insert_shifts_by_the_full_count() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 11.0, "precondition: 15 - 4");

    wb.insert_rows(0, 1, 3);

    // Range A1:A5 grew to A1:A8; C10 -> C13. Hidden 3 -> 6.
    assert_eq!(
        num(&wb, "Sheet1", "C13"),
        11.0,
        "hidden row must move by 3 (to 6); 15 means it stayed on a blank row"
    );
}

// ===================== delete_rows =====================

/// Delete above the hidden row: the set must move BACK by the deleted count.
///
/// The band is row 1, not row 0, on purpose: deleting a range's FIRST row
/// makes the A1-style reference surface a `#REF!` corner (pre-existing engine
/// behaviour, and the very thing `remap_table_geometry` clamps for Tables).
/// That is a separate concern from the hidden set, and putting the band at
/// row 0 would replace this assertion with an `InvalidRef` panic instead of
/// the wrong-row-excluded number the test is here to catch.
#[test]
fn delete_above_a_hidden_row_shifts_the_manual_set_back() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 11.0, "precondition: 15 - 4");

    wb.delete_rows(0, 1, 1);

    // The 2 is gone; rows are now 1,3,4,5. Range A1:A4; C10 -> C9.
    // Hidden 3 -> 2, which is the 4. 13 - 4 = 9.
    assert_eq!(
        num(&wb, "Sheet1", "C9"),
        9.0,
        "hidden row must move back to 2; 8 means the stale {{3}} excluded the 5"
    );
}

/// The deleted row IS the hidden row: it must be DROPPED from the set, not
/// shifted. Unfixed, the stale {3} now indexes the row that slid up into the
/// vacancy and wrongly excludes it.
#[test]
fn deleting_the_hidden_row_drops_it_from_the_set() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 11.0, "precondition: 15 - 4");

    wb.delete_rows(0, 3, 1);

    // Rows are now 1,2,3,5 (the 4 is gone); range A1:A4; C10 -> C9.
    // Nothing is hidden any more, so the whole 11 aggregates.
    assert_eq!(
        num(&wb, "Sheet1", "C9"),
        11.0,
        "the hidden row was deleted, so nothing is excluded; 6 means {{3}} now hides the 5"
    );
}

/// Guard against an over-eager shift on the delete side.
#[test]
fn delete_below_the_hidden_row_leaves_the_set_alone() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 13.0, "precondition: 15 - 2");

    wb.delete_rows(0, 5, 1);

    assert_eq!(num(&wb, "Sheet1", "C9"), 13.0, "row 1 is above the deleted band");
}

/// A multi-row delete band that COVERS one hidden row and sits above another:
/// the covered one is dropped, the survivor shifts back by the full count.
#[test]
fn multi_row_delete_drops_covered_rows_and_shifts_the_survivors() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[1, 4]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 8.0, "precondition: 15 - 2 - 5");

    wb.delete_rows(0, 1, 2);

    // Rows 1 and 2 (the 2 and the 3) are gone; rows are now 1,4,5.
    // Range A1:A3; C10 -> C8. Hidden {1,4}: 1 is covered -> dropped,
    // 4 -> 2, which is the 5. 10 - 5 = 5.
    assert_eq!(
        num(&wb, "Sheet1", "C8"),
        5.0,
        "covered row drops, survivor moves to 2; 6 means the stale {{1,4}} hid the 4"
    );
}

// ===================== the two sets are independent =====================

/// Both stores must shift, and each must stay in its own lane: SUBTOTAL 9
/// reads only the FILTER set, SUBTOTAL 109 reads both.
#[test]
fn manual_and_filter_sets_shift_independently() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[1]); // the 2, manual
    wb.set_eval_filter_hidden_rows(0, &[3]); // the 4, filter
    assert_eq!(num(&wb, "Sheet1", "C10"), 9.0, "precondition 109: 15 - 2 - 4");
    assert_eq!(num(&wb, "Sheet1", "D10"), 11.0, "precondition 9: 15 - 4");

    wb.insert_rows(0, 0, 1);

    // Manual 1 -> 2 (the 2), filter 3 -> 4 (the 4). C10/D10 -> C11/D11.
    assert_eq!(
        num(&wb, "Sheet1", "D11"),
        11.0,
        "filter set must shift; 12 means it still points at the 3"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C11"),
        9.0,
        "both sets must shift; 11 means neither did"
    );
}

/// A filter-only workbook must shift too — the manual store being empty must
/// not short-circuit the filter store's remap.
#[test]
fn filter_set_shifts_with_no_manual_set_present() {
    let mut wb = one_sheet();
    wb.set_eval_filter_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "D10"), 11.0, "precondition: 15 - 4");

    wb.insert_rows(0, 0, 1);

    assert_eq!(num(&wb, "Sheet1", "D11"), 11.0, "filter set must follow to 4");
}

// ===================== cross-sheet isolation =====================

/// A structural edit on one sheet must not disturb another sheet's set.
#[test]
fn structural_shift_on_one_sheet_leaves_another_sheets_set_alone() {
    let mut wb = Workbook::new();
    assert_eq!(wb.add_sheet("Sheet2"), 1);
    seed(&mut wb, 0);
    seed(&mut wb, 1);
    wb.set_eval_hidden_rows(0, &[3]);
    wb.set_eval_hidden_rows(1, &[3]);
    assert_eq!(num(&wb, "Sheet2", "C10"), 11.0, "precondition: 15 - 4");

    wb.insert_rows(0, 0, 1);

    assert_eq!(num(&wb, "Sheet1", "C11"), 11.0, "the edited sheet's set follows");
    assert_eq!(
        num(&wb, "Sheet2", "C10"),
        11.0,
        "untouched sheet keeps both its rows and its hidden set"
    );
}

// ===================== axis isolation =====================

/// Column inserts/deletes displace nothing in a ROW set.
#[test]
fn column_shifts_leave_the_row_sets_alone() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[3]);
    wb.set_eval_filter_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 9.0, "precondition: 15 - 4 - 2");

    wb.insert_columns(0, 0, 2);
    // C10 rode two columns right to E10; A1:A5 followed to C1:C5.
    assert_eq!(num(&wb, "Sheet1", "E10"), 9.0, "row sets are untouched by a column insert");

    wb.delete_columns(0, 0, 2);
    assert_eq!(num(&wb, "Sheet1", "C10"), 9.0, "row sets are untouched by a column delete");
}

// ===================== clearing =====================

/// A delete that swallows EVERY hidden row must clear the entry, not leave an
/// empty set behind that still reports as "filtering".
#[test]
fn delete_covering_every_hidden_row_clears_the_set() {
    let mut wb = one_sheet();
    wb.set_eval_hidden_rows(0, &[1, 2]);
    assert_eq!(num(&wb, "Sheet1", "C10"), 10.0, "precondition: 15 - 2 - 3");

    wb.delete_rows(0, 1, 2);

    // Rows are now 1,4,5; range A1:A3; C10 -> C8. Nothing hidden.
    assert_eq!(num(&wb, "Sheet1", "C8"), 10.0, "both hidden rows were deleted; 1 + 4 + 5");
}
