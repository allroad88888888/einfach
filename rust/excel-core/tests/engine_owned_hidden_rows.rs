//! E2 of `design-engine-hidden-rows.md` — the engine OWNS the MANUALLY hidden
//! row set.
//!
//! Before this slice the only hidden-row storage was
//! `WorkbookAtomContext::eval_hidden_rows`, a read-only EVALUATION MIRROR the
//! host pushed into wholesale (`Workbook::set_eval_hidden_rows`). The engine
//! modelled nothing: it could not answer "which rows are hidden on sheet 2",
//! nothing survived a persistence round trip, and every re-push — including
//! the byte-identical ones a host emits after a structural edit — dirtied
//! every SUBTOTAL 101-111 formula in the workbook.
//!
//! E2 gives `Sheet` an owned `hidden_rows` set and demotes the context map to
//! a mirror that exactly one private publisher (`republish_hidden`) writes.
//! `set_eval_hidden_rows` keeps its signature verbatim (INV-4) but now writes
//! the owned state, so the host stays the authoritative WRITER for this slice
//! while the engine becomes the authoritative STORE. Nothing in the live
//! product changes behaviour: push the same rows, evaluate the same numbers.
//!
//! Counterexample discipline: every case below that could fail on a NUMBER
//! rather than on a missing symbol does. `debug_formula_eval_count` is the
//! epoch observable — an epoch bump re-derives the formulas holding that
//! layer's edge, so "the count did not move" is how "no epoch fired" is
//! asserted without exposing the revision counters.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Fill A1.. down one column on `sheet_idx` (0-based row 0 = "A1").
fn load_column(wb: &mut Workbook, sheet_idx: usize, values: &[f64]) {
    for (i, v) in values.iter().enumerate() {
        wb.set_cell(sheet_idx, &format!("A{}", i + 1), Value::Number(*v));
    }
}

fn num(wb: &Workbook, sheet: &str, addr: &str) -> f64 {
    match wb.get_cell(sheet, addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {sheet}!{addr}, got {other:?}"),
    }
}

/// A1:A5 = 1..5 with `C1 = SUBTOTAL(9, …)` (filter layer only) and
/// `C2 = SUBTOTAL(109, …)` (both layers) on sheet 0.
fn two_layer_sheet() -> Workbook {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)"));
    wb
}

// ===================== idempotent republish =====================

/// **Counterexample.** A byte-identical re-push must not re-derive anything.
///
/// The de-duplication ledger used to live in the host
/// (`eval-hidden-rows-bridge.ts`'s `lastPushed` string compare); the context
/// setter bumped `manual_hidden_epoch` unconditionally. Once the engine owns
/// the set, `republish_hidden` runs on hot paths (every structural edit), so
/// the ledger has to move into Rust or a plain `insert_rows` dirties every
/// 101-111 formula in the workbook.
///
/// Fails on the UNFIXED engine with a WRONG COUNT (one extra evaluation),
/// not with an error.
#[test]
fn a_byte_identical_manual_re_push_re_derives_nothing() {
    let mut wb = two_layer_sheet();

    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0); // 15 - 2

    let before = wb.debug_formula_eval_count(0);
    wb.set_eval_hidden_rows(0, &[1]); // same set, again
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0);
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before,
        "an identical re-push must not dirty SUBTOTAL 101-111"
    );
}

/// The de-duplication must not swallow a REAL change — the guard that keeps
/// the case above from passing vacuously.
#[test]
fn a_changed_manual_push_still_re_derives() {
    let mut wb = two_layer_sheet();

    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0);

    let before = wb.debug_formula_eval_count(0);
    wb.set_eval_hidden_rows(0, &[1, 3]); // genuinely different
    assert_eq!(num(&wb, "Sheet1", "C2"), 9.0); // 15 - 2 - 4
    assert!(
        wb.debug_formula_eval_count(0) > before,
        "a changed push MUST dirty SUBTOTAL 101-111"
    );
}

// ===================== the §3 epoch gate =====================

/// **The gate `design-engine-hidden-rows.md` §3 names by hand**: inserting a
/// row on a sheet with NO hidden rows must bump NEITHER epoch.
///
/// This is what protects the #27 two-epoch split. The naive shape of
/// "structural edit → republish" republishes unconditionally, and because
/// both SUBTOTAL layers read the filter epoch, an unconditional bump makes
/// every row insert in the workbook re-derive every `SUBTOTAL(1-11)` — a pure
/// recomputation tax on the most common structural edit there is.
///
/// The insert is placed at row 100, far below A1:A5 and C1/C2, so the
/// reference retarget cannot move a formula: any evaluation observed here is
/// attributable to a hidden-row epoch.
#[test]
fn inserting_a_row_with_no_hidden_rows_bumps_neither_epoch() {
    let mut wb = two_layer_sheet();
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);

    let before = wb.debug_formula_eval_count(0);
    wb.insert_rows(0, 100, 1);
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before,
        "an insert on an unhidden sheet must dirty neither SUBTOTAL layer"
    );

    // Same for a delete, and for the column axis (which displaces nothing in
    // a row set at all).
    let before = wb.debug_formula_eval_count(0);
    wb.delete_rows(0, 100, 1);
    wb.insert_columns(0, 100, 1);
    wb.delete_columns(0, 100, 1);
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
    assert_eq!(wb.debug_formula_eval_count(0), before);
}

/// Non-vacuity guard for the case above: an insert that ACTUALLY displaces a
/// hidden row does re-derive 101-111.
#[test]
fn inserting_above_a_hidden_row_does_bump_the_manual_epoch() {
    let mut wb = two_layer_sheet();
    wb.hide_rows(0, &[3]); // A4 = 4
    assert_eq!(num(&wb, "Sheet1", "C2"), 11.0);

    let before = wb.debug_formula_eval_count(0);
    wb.insert_rows(0, 0, 1); // pushes A1:A5 down to A2:A6, hidden 3 → 4
    assert!(
        wb.debug_formula_eval_count(0) > before,
        "displacing a hidden row MUST dirty SUBTOTAL 101-111"
    );
}

// ===================== hide / unhide / list =====================

/// The owning API. `hide_rows` is additive, `unhide_rows` subtractive,
/// `list_hidden_rows` reads back in ascending order, and both mutators report
/// whether they changed anything.
#[test]
fn hide_unhide_list_round_trip() {
    let mut wb = two_layer_sheet();
    assert!(wb.list_hidden_rows(0).is_empty());

    assert!(wb.hide_rows(0, &[3, 1]));
    assert_eq!(wb.list_hidden_rows(0), vec![1, 3], "sorted, deduplicated");
    assert_eq!(num(&wb, "Sheet1", "C2"), 9.0); // 15 - 2 - 4
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0, "1-11 ignore the manual set");

    assert!(!wb.hide_rows(0, &[1]), "already hidden → no change");
    assert!(!wb.hide_rows(0, &[]), "empty request → no change");

    assert!(wb.unhide_rows(0, &[1]));
    assert_eq!(wb.list_hidden_rows(0), vec![3]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 11.0);

    assert!(!wb.unhide_rows(0, &[1]), "not hidden → no change");
    assert!(wb.unhide_rows(0, &[3]));
    assert!(wb.list_hidden_rows(0).is_empty());
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
}

/// Out-of-range sheet indices stay the silent no-ops they are on every other
/// hidden-row entry point.
#[test]
fn out_of_range_sheet_is_a_silent_no_op() {
    let mut wb = two_layer_sheet();
    assert!(!wb.hide_rows(99, &[0]));
    assert!(!wb.unhide_rows(99, &[0]));
    assert!(wb.list_hidden_rows(99).is_empty());
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
}

/// **The E2 zero-behaviour-change invariant.** The host port keeps its exact
/// signature (INV-4 treats a parameter change as a removal) but now writes
/// the owned state — whole-set REPLACE, empty clears — so the host remains
/// the writer while the engine becomes the store.
#[test]
fn set_eval_hidden_rows_writes_the_owned_state() {
    let mut wb = two_layer_sheet();

    wb.set_eval_hidden_rows(0, &[3, 1, 1]);
    assert_eq!(wb.list_hidden_rows(0), vec![1, 3]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 9.0);

    wb.set_eval_hidden_rows(0, &[4]); // REPLACE, not a union
    assert_eq!(wb.list_hidden_rows(0), vec![4]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 10.0);

    wb.set_eval_hidden_rows(0, &[]); // empty clears
    assert!(wb.list_hidden_rows(0).is_empty());
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
}

// ===================== structural follow =====================

/// The owned set rides row inserts/deletes on its own sheet, with the same
/// arithmetic the mirror already used (82f4283): insert at-or-before moves a
/// row down, delete strictly before moves it up, a delete COVERING it drops
/// it, and a column edit displaces nothing.
#[test]
fn the_owned_set_follows_row_edits() {
    let mut wb = two_layer_sheet();

    wb.hide_rows(0, &[3]);
    wb.insert_rows(0, 0, 2);
    assert_eq!(wb.list_hidden_rows(0), vec![5], "insert above → +2");

    wb.delete_rows(0, 0, 1);
    assert_eq!(wb.list_hidden_rows(0), vec![4], "delete above → -1");

    wb.insert_columns(0, 0, 3);
    wb.delete_columns(0, 0, 3);
    assert_eq!(wb.list_hidden_rows(0), vec![4], "column edits are a no-op");

    wb.delete_rows(0, 4, 1);
    assert!(
        wb.list_hidden_rows(0).is_empty(),
        "a delete covering the hidden row drops it"
    );
}

/// The owned set and the evaluation mirror stay in lockstep across a
/// structural edit — the number, not just the list, has to survive.
#[test]
fn subtotal_tracks_the_owned_set_across_a_row_insert() {
    let mut wb = two_layer_sheet();

    wb.hide_rows(0, &[3]); // A4 = 4
    assert_eq!(num(&wb, "Sheet1", "C2"), 11.0);

    // A1:A5 slides to A2:A6 and the formula itself slides C2 → C3; the
    // SUBTOTAL range retargets with the data and the hidden row must follow,
    // so the SAME value (4) stays excluded.
    wb.insert_rows(0, 0, 1);
    assert_eq!(wb.list_hidden_rows(0), vec![4]);
    assert_eq!(num(&wb, "Sheet1", "C3"), 11.0);
}

/// Edits on one sheet leave another sheet's owned set alone.
#[test]
fn a_row_edit_on_one_sheet_leaves_another_sheets_set_alone() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    wb.hide_rows(0, &[3]);
    wb.hide_rows(s2, &[3]);

    wb.insert_rows(0, 0, 1);
    assert_eq!(wb.list_hidden_rows(0), vec![4]);
    assert_eq!(wb.list_hidden_rows(s2), vec![3]);
}

// ===================== sheet lifecycle =====================

/// The owned set travels with its `Sheet` across `remove_sheet` /
/// `move_sheet` — the D1 defect class (`sheet.rs`'s index-keyed mirror needed
/// an explicit re-key, commit 2fd3cc5) is structurally unrepresentable once
/// the set is a `Sheet` field.
#[test]
fn the_owned_set_travels_with_its_sheet() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    wb.add_sheet("Sheet3");
    wb.hide_rows(1, &[1]);
    wb.hide_rows(2, &[2]);

    wb.remove_sheet(0);
    assert_eq!(wb.list_hidden_rows(0), vec![1], "old Sheet2 is now index 0");
    assert_eq!(wb.list_hidden_rows(1), vec![2], "old Sheet3 is now index 1");

    wb.move_sheet(0, 1);
    assert_eq!(wb.list_hidden_rows(0), vec![2]);
    assert_eq!(wb.list_hidden_rows(1), vec![1]);
}

/// …and the EVALUATION mirror follows the same rotation, so a cross-sheet
/// 101-111 keeps reading its own sheet's rows. The number is the assertion.
#[test]
fn subtotal_reads_the_right_sheet_after_a_remove() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    load_column(&mut wb, 1, &[1.0, 2.0, 3.0]);
    assert!(wb.set_formula(1, "C1", "=SUBTOTAL(109, A1:A3)"));
    wb.hide_rows(1, &[1]); // A2 = 2
    assert_eq!(num(&wb, "Sheet2", "C1"), 4.0);

    wb.remove_sheet(0);
    assert_eq!(num(&wb, "Sheet2", "C1"), 4.0, "Sheet2 kept its own set");
}

// ===================== snapshot / restore =====================

/// The undo primitive, shaped after `snapshot_tables` / `restore_tables`:
/// pure read on capture, whole-workbook REPLACE on restore.
#[test]
fn snapshot_and_restore_round_trip() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)"));

    wb.hide_rows(0, &[1]);
    wb.hide_rows(1, &[4]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0);

    let before = wb.snapshot_hidden();

    wb.hide_rows(0, &[3]);
    wb.unhide_rows(1, &[4]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 9.0);

    assert_eq!(wb.restore_hidden(before), Ok(2));
    assert_eq!(wb.list_hidden_rows(0), vec![1]);
    assert_eq!(wb.list_hidden_rows(1), vec![4]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0, "the number came back too");
}

/// REPLACE, not merge: restoring an empty snapshot clears every sheet.
#[test]
fn restoring_an_empty_snapshot_clears_everything() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    let empty = wb.snapshot_hidden();

    wb.hide_rows(0, &[1]);
    wb.hide_rows(1, &[2]);
    assert_eq!(wb.restore_hidden(empty), Ok(0));
    assert!(wb.list_hidden_rows(0).is_empty());
    assert!(wb.list_hidden_rows(1).is_empty());
}

/// A snapshot captured against a wider workbook restores what still fits and
/// silently drops the rest (`design-engine-hidden-rows.md` §6.2: "越界 sheet
/// 静默丢弃"), rather than rejecting a whole undo transaction.
#[test]
fn restore_drops_entries_for_sheets_that_no_longer_exist() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    wb.hide_rows(0, &[1]);
    wb.hide_rows(1, &[2]);
    let wide = wb.snapshot_hidden();

    wb.remove_sheet(1);
    assert_eq!(wb.restore_hidden(wide), Ok(1));
    assert_eq!(wb.list_hidden_rows(0), vec![1]);
}

/// A restore that reproduces the current state exactly costs no recompute —
/// the same de-duplication the push path gets, so a host that snapshots
/// hidden state inside every undo transaction pays nothing for the
/// transactions that never touched it.
#[test]
fn an_identical_restore_re_derives_nothing() {
    let mut wb = two_layer_sheet();
    wb.hide_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0);

    let snapshot = wb.snapshot_hidden();
    let before = wb.debug_formula_eval_count(0);
    assert_eq!(wb.restore_hidden(snapshot), Ok(1));
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0);
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before,
        "a no-op restore must not dirty SUBTOTAL 101-111"
    );
}
