//! AUDIT A-1 fix arc (W2.1) — structural edits must preserve the lazy
//! contract (`docs/LAZY_FORMULA_INDEXING_PLAN.md`): parked formulas are
//! retargeted by token-level SOURCE TEXT rewrite
//! (`shift::rewrite_parked_source`), never hydrated; hydrated formulas
//! get a direct mapped-AST install (no render→re-parse).
//!
//! Scanner-level unit tests (token classification, AST-parity corpus)
//! live in `src/shift.rs`; this file covers the engine-visible
//! contract: laziness preserved, values correct after edits, deleted
//! bands surfacing `#REF!`, and hydrated-cache invalidation rules.

use einfach_core::{Value, ValueError};
use einfach_excel_core::{CellAddress, Sheet, Workbook};
use std::collections::HashMap;

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).expect("test address must parse")
}

// =====================================================================
// Laziness preserved
// =====================================================================

/// Acceptance pin #1: bulk-load N formulas + one insert_row ⇒ the dep
/// graph stays EMPTY (zero hydrations forced by the edit), and the
/// formulas still read correct, retargeted values afterwards.
#[test]
fn insert_row_preserves_lazy_contract() {
    const N: u32 = 2_000;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{r}"), Value::Number(r as f64));
            loader.set_formula(&format!("B{r}"), &format!("=A{r}*2"));
        }
    });
    assert_eq!(sheet.debug_point_dependency_key_count(), 0);
    assert_eq!(sheet.debug_dep_graph_stats().formula_count, 0);

    sheet.insert_row(0, 1);

    let stats = sheet.debug_dep_graph_stats();
    assert_eq!(
        sheet.debug_point_dependency_key_count(),
        0,
        "insert_row must not hydrate any parked formula"
    );
    assert_eq!(
        stats.formula_count, 0,
        "no FormulaRecord may materialize from the edit"
    );

    // Reads hydrate on demand and see retargeted refs: row r's formula
    // now lives at B{r+1} and reads A{r+1} (the shifted datum).
    assert_eq!(sheet.get_cell("B2"), Value::Number(2.0));
    assert_eq!(
        sheet.get_cell(&format!("B{}", N + 1)),
        Value::Number(2.0 * N as f64)
    );
    // Only the two reads hydrated.
    assert_eq!(sheet.debug_dep_graph_stats().formula_count, 2);
}

/// Same contract for the other three ops.
#[test]
fn all_structural_ops_preserve_lazy_contract() {
    for op in 0..4u8 {
        let mut sheet = Sheet::new();
        sheet.bulk_load(|loader| {
            for r in 10..20u32 {
                loader.set_cell(&format!("C{r}"), Value::Number(r as f64));
                loader.set_formula(&format!("D{r}"), &format!("=C{r}+1"));
            }
        });
        match op {
            0 => sheet.insert_row(0, 2),
            1 => sheet.delete_row(0, 2),
            2 => sheet.insert_col(0, 2),
            _ => sheet.delete_col(0, 1),
        }
        assert_eq!(
            sheet.debug_point_dependency_key_count(),
            0,
            "op {op} must not hydrate parked formulas"
        );
        assert_eq!(sheet.debug_dep_graph_stats().formula_count, 0, "op {op}");
    }
}

// =====================================================================
// Textual retarget correctness (engine-visible)
// =====================================================================

/// Bounded range refs in parked sources shift like the hydrated path.
#[test]
fn parked_range_ref_shifts_and_evaluates() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A2", Value::Number(1.0));
        loader.set_cell("A3", Value::Number(2.0));
        loader.set_cell("A4", Value::Number(3.0));
        loader.set_formula("B1", "=SUM(A2:A4)");
    });
    sheet.insert_row(0, 1);
    assert_eq!(sheet.get_formula("B2").as_deref(), Some("=SUM(A3:A5)"));
    assert_eq!(sheet.get_cell("B2"), Value::Number(6.0));
}

/// Quoted strings must never be rewritten; refs outside strings must.
#[test]
fn parked_quoted_string_false_positive_survives() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A2", Value::Number(5.0));
        loader.set_formula("B1", "=IF(A2>0,\"A2 ok\",\"B9 nope\")");
    });
    sheet.insert_row(0, 1);
    assert_eq!(
        sheet.get_formula("B2").as_deref(),
        Some("=IF(A3>0,\"A2 ok\",\"B9 nope\")")
    );
    assert_eq!(sheet.get_cell("B2"), Value::Text("A2 ok".into()));
}

/// Function names with trailing digits (LOG10) are not refs.
#[test]
fn parked_function_name_with_digits_not_shifted() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A2", Value::Number(100.0));
        loader.set_formula("B1", "=LOG10(A2)");
    });
    sheet.insert_row(0, 1);
    assert_eq!(sheet.get_formula("B2").as_deref(), Some("=LOG10(A3)"));
    assert_eq!(sheet.get_cell("B2"), Value::Number(2.0));
}

/// Cross-sheet refs in parked sources are NOT shifted by within-sheet
/// edits — exactly the hydrated `map_addrs` scope — while same-sheet
/// refs in the same formula are.
#[test]
fn parked_cross_sheet_ref_untouched_same_sheet_ref_shifts() {
    let mut wb = Workbook::new();
    let data = wb.add_sheet("Data");
    wb.set_cell(data, "A1", Value::Number(10.0));

    let mut formulas: HashMap<CellAddress, String> = HashMap::new();
    formulas.insert(addr("B1"), "=Data!A1+A2".to_string());
    let mut primitives: HashMap<CellAddress, Value> = HashMap::new();
    primitives.insert(addr("A2"), Value::Number(5.0));
    wb.install_sheet_bulk(0, primitives, formulas)
        .expect("install");

    wb.sheet_mut(0).unwrap().insert_row(0, 1);

    let sheet = wb.sheet(0).unwrap();
    assert_eq!(sheet.get_formula("B2").as_deref(), Some("=Data!A1+A3"));
    assert_eq!(sheet.debug_point_dependency_key_count(), 0, "still parked");
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(15.0));
}

/// A sheet NAME that looks like a cell ref (`B2!A1`) is a sheet name,
/// not a reference — the text must survive untouched.
#[test]
fn parked_sheet_name_lookalike_untouched() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_formula("C1", "=B2!A1");
    });
    sheet.insert_row(0, 1);
    assert_eq!(sheet.get_formula("C2").as_deref(), Some("=B2!A1"));
}

/// Whole-row / whole-column ranges shift only on their bounded axis.
#[test]
fn parked_unbounded_ranges_shift_on_bounded_axis_only() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("B2", Value::Number(3.0));
        loader.set_formula("F1", "=SUM(2:3)");
        loader.set_formula("G1", "=SUM(B:C)");
    });
    sheet.insert_row(0, 1);
    assert_eq!(sheet.get_formula("F2").as_deref(), Some("=SUM(3:4)"));
    assert_eq!(sheet.get_formula("G2").as_deref(), Some("=SUM(B:C)"));
    assert_eq!(sheet.get_cell("F2"), Value::Number(3.0), "B3 in rows 3:4");
    assert_eq!(sheet.get_cell("G2"), Value::Number(3.0));
}

/// Delete-band semantics: a parked formula whose ref dies becomes a
/// plain `#REF!` error cell (hydrated-path parity: the formula record
/// is gone, the value is the error).
#[test]
fn parked_ref_into_deleted_band_becomes_ref_error() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("B5", Value::Number(9.0));
        loader.set_formula("C1", "=B5*2");
        loader.set_formula("D1", "=A1+1"); // untouched bystander
    });
    sheet.delete_row(4, 1); // deletes row 5 (B5)
    assert_eq!(
        sheet.get_cell("C1"),
        Value::Error(ValueError::InvalidRef),
        "ref into deleted band must surface #REF!"
    );
    assert!(
        sheet.get_formula("C1").is_none(),
        "hydrated-path parity: the #REF! cell is no longer a formula"
    );
    // The bystander stayed parked.
    assert_eq!(sheet.get_formula("D1").as_deref(), Some("=A1+1"));
}

/// Stacked edits compose: each edit rewrites the parked text against
/// the current coordinate system, so N edits then one read agree with
/// the eager path.
#[test]
fn stacked_edits_then_read_is_correct() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A5", Value::Number(42.0));
        loader.set_formula("B1", "=A5+1");
    });
    sheet.insert_row(0, 2); // B1->B3, =A7; datum A5->A7
    sheet.delete_row(0, 1); // B3->B2, =A6; datum A7->A6
    sheet.insert_col(0, 1); // B2->C2, =B6; datum A6->B6
    assert_eq!(sheet.debug_point_dependency_key_count(), 0, "still parked");
    assert_eq!(sheet.get_formula("C2").as_deref(), Some("=B6+1"));
    assert_eq!(sheet.get_cell("C2"), Value::Number(43.0));
    assert_eq!(sheet.get_cell("B6"), Value::Number(42.0));
}

/// Spill-anchor refs (`=B1#`) shift their anchor token.
#[test]
fn parked_spill_ref_shifts() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("B1", "=SEQUENCE(2)")); // eager anchor
    sheet.bulk_load(|loader| {
        loader.set_formula("D1", "=SUM(B1#)");
    });
    sheet.insert_row(0, 1);
    assert_eq!(sheet.get_formula("D2").as_deref(), Some("=SUM(B2#)"));
    assert_eq!(sheet.get_cell("D2"), Value::Number(3.0));
}

// =====================================================================
// Hydrated-path cache rules (the AST-unchanged fast path must not
// serve stale values)
// =====================================================================

/// AST-unchanged formula with an UNBOUNDED range dep must re-evaluate
/// after a row edit (the range can see shifted cells even though no
/// static ref moved).
#[test]
fn hydrated_unbounded_range_redirties_on_row_edit() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(7.0));
    assert!(sheet.set_formula("B1", "=INDEX(A:A,1)"));
    assert_eq!(sheet.get_cell("B1"), Value::Number(7.0)); // cache Clean

    sheet.insert_row(0, 1); // B1 -> B2; INDEX(A:A,1) now reads the NEW (empty) A1

    let got = sheet.get_cell("B2");
    assert_ne!(
        got,
        Value::Number(7.0),
        "stale cache served after insert_row: {got:?}"
    );
}

/// AST-unchanged dependent of a CHANGED formula must re-evaluate (the
/// changed formula's value can differ after a delete shrinks its range).
#[test]
fn hydrated_dependent_of_changed_formula_redirties() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A2", Value::Number(2.0));
    sheet.set_cell("A3", Value::Number(4.0));
    assert!(sheet.set_formula("B1", "=SUM(A1:A3)"));
    assert!(sheet.set_formula("C1", "=B1*10"));
    assert_eq!(sheet.get_cell("C1"), Value::Number(70.0)); // both Clean

    // Delete the MIDDLE row of the range (a corner death would #REF!
    // the whole formula — the engine's pinned semantics). B1 becomes
    // =SUM(A1:A2) over the surviving values 1 and 4.
    sheet.delete_row(1, 1);

    assert_eq!(sheet.get_cell("B1"), Value::Number(5.0));
    assert_eq!(
        sheet.get_cell("C1"),
        Value::Number(50.0),
        "C1 (AST unchanged) must observe B1's new value"
    );
}

/// codex P1: AST-UNCHANGED formula dirtied via its range dep
/// (`range_touched`) must propagate to AST-unchanged dependents. Here
/// B1's AST never changes (unbounded `A:A`), so it is NOT reinstalled —
/// it must still seed the silent BFS, or C1 serves its stale cache.
#[test]
fn hydrated_dependent_of_range_touched_formula_redirties_on_delete() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A2", Value::Number(1.0));
    sheet.set_cell("A3", Value::Number(2.0));
    sheet.set_cell("A4", Value::Number(4.0));
    assert!(sheet.set_formula("B1", "=SUM(A:A)"));
    assert!(sheet.set_formula("C1", "=B1*10"));
    assert_eq!(sheet.get_cell("C1"), Value::Number(70.0)); // B1 and C1 Clean

    // Delete A3's row: B1/C1 (row 0) don't move, B1's AST is unchanged
    // (A:A survives), C1's AST and tracked dep (B1) are unchanged.
    sheet.delete_row(2, 1);

    assert_eq!(
        sheet.get_cell("C1"),
        Value::Number(50.0),
        "C1 must observe B1's recomputed SUM, not its pre-edit cache"
    );
    assert_eq!(sheet.get_cell("B1"), Value::Number(5.0));
}

/// insert_row variant: inserting inside the range shifts the datum that
/// `INDEX(A:A,3)` reads, without changing any AST above the edit.
#[test]
fn hydrated_dependent_of_range_touched_formula_redirties_on_insert() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A3", Value::Number(5.0));
    assert!(sheet.set_formula("B1", "=INDEX(A:A,3)"));
    assert!(sheet.set_formula("C1", "=B1*10"));
    assert_eq!(sheet.get_cell("C1"), Value::Number(50.0)); // B1 and C1 Clean

    // Insert above A3's row: the 5 moves to A4, INDEX(A:A,3) now reads
    // the new (empty) A3. B1/C1 sit in row 0 — no AST changes anywhere.
    sheet.insert_row(1, 1);

    // B1 now reads the empty new A3 (Null), which coerces to 0 in `*10`.
    assert_eq!(
        sheet.get_cell("C1"),
        Value::Number(0.0),
        "C1 must observe B1's recomputed INDEX, not its pre-edit cache"
    );
    assert_eq!(sheet.get_cell("B1"), Value::Null);
}

/// Transitive chain: the silent BFS must dirty B1's dependents
/// TRANSITIVELY (C1 and D1), not just the first hop.
#[test]
fn transitive_dependents_of_range_touched_formula_redirty() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A2", Value::Number(1.0));
    sheet.set_cell("A3", Value::Number(2.0));
    sheet.set_cell("A4", Value::Number(4.0));
    assert!(sheet.set_formula("B1", "=SUM(A:A)"));
    assert!(sheet.set_formula("C1", "=B1*10"));
    assert!(sheet.set_formula("D1", "=C1+1"));
    assert_eq!(sheet.get_cell("D1"), Value::Number(71.0)); // whole chain Clean

    sheet.delete_row(2, 1); // drop the 2 — SUM becomes 5

    assert_eq!(
        sheet.get_cell("D1"),
        Value::Number(51.0),
        "D1 must observe the recomputed chain B1=5 -> C1=50 -> D1=51"
    );
}

/// Mixed sheet: one hydrated (read) formula + parked rest. The edit
/// retargets both worlds; hydrated count stays at exactly the formulas
/// the host actually read.
#[test]
fn mixed_hydrated_and_parked_retarget_consistently() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=10u32 {
            loader.set_cell(&format!("A{r}"), Value::Number(r as f64));
            loader.set_formula(&format!("B{r}"), &format!("=A{r}*2"));
        }
    });
    assert_eq!(sheet.get_cell("B5"), Value::Number(10.0)); // hydrates B5 only
    assert_eq!(sheet.debug_dep_graph_stats().formula_count, 1);

    sheet.insert_row(0, 1);

    assert_eq!(
        sheet.debug_dep_graph_stats().formula_count,
        1,
        "edit must not change the hydrated count"
    );
    // Hydrated formula followed the shift (AST install; the text is
    // re-rendered, which parenthesizes binops — same as the old path).
    assert_eq!(sheet.get_formula("B6").as_deref(), Some("=(A6*2)"));
    assert_eq!(sheet.get_cell("B6"), Value::Number(10.0));
    // Parked neighbor followed the shift textually.
    assert_eq!(sheet.get_formula("B7").as_deref(), Some("=A7*2"));
    assert_eq!(sheet.get_cell("B7"), Value::Number(12.0));
}

/// Hydrated formulas whose refs DON'T cross the boundary keep working
/// (and keep their record identity — no churn).
#[test]
fn hydrated_untouched_formula_survives_edit_below() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(3.0));
    assert!(sheet.set_formula("B1", "=A1*2"));
    assert_eq!(sheet.get_cell("B1"), Value::Number(6.0));

    sheet.insert_row(5, 2); // far below — nothing about B1 changes

    assert_eq!(sheet.get_formula("B1").as_deref(), Some("=A1*2"));
    assert_eq!(sheet.get_cell("B1"), Value::Number(6.0));
    // Mutation still propagates (dep indexes were rebuilt coherently).
    sheet.set_cell("A1", Value::Number(4.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(8.0));
}
