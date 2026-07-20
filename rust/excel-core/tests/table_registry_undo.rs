//! #32 Excel Table — registry snapshot / restore, the undo primitive for
//! Table DEFINITION changes (design doc `design-excel-table.md` §11/§12,
//! CANONICAL_OWNERSHIP §4-3 "注册态重放").
//!
//! Until this landed, everything a Table op wrote into CELLS was covered by
//! the host's sparse-cell + format snapshots, but the registry itself
//! (name / sheet anchor / range / header+totals flags / column names) had no
//! before-image, so `createTable`, `renameTable`, `deleteTable`, and the
//! totals toggle were simply not undoable. `snapshot_tables` /
//! `restore_tables` close that gap with **REPLACE** semantics.
//!
//! Coverage:
//!   - exact round-trip through create / rename / rename-column / delete /
//!     totals toggle, asserting every field (range, columns, has_totals);
//!   - restore re-derives referencing formulas via the tables epoch;
//!   - empty snapshot CLEARS the registry (REPLACE, not additive);
//!   - the cap and the name mutex still hold after a restore, and a
//!     rejection leaves the live registry untouched;
//!   - sheet-anchor semantics (rename/remove) across a snapshot boundary.

use einfach_core::Value;
use einfach_excel_core::{
    CellAddress, CellRange, TableEntry, TableError, TableRegistrySnapshot, TotalsFunction, Workbook,
};

fn rng(sr: u32, sc: u32, er: u32, ec: u32) -> CellRange {
    CellRange::new(CellAddress::new(sr, sc), CellAddress::new(er, ec))
}

/// Inventory table at A1:C4 on Sheet1: headers Name/Qty/Price + 3 data rows
/// (qty 1/2/3, price 10/20/30).
fn inventory() -> Workbook {
    let mut wb = Workbook::new();
    for (a1, v) in [("A1", "Name"), ("B1", "Qty"), ("C1", "Price")] {
        wb.set_cell(0, a1, Value::Text(v.into()));
    }
    let rows = [("x", 1.0, 10.0), ("y", 2.0, 20.0), ("z", 3.0, 30.0)];
    for (i, (name, qty, price)) in rows.iter().enumerate() {
        let r = i + 2;
        wb.set_cell(0, &format!("A{r}"), Value::Text((*name).into()));
        wb.set_cell(0, &format!("B{r}"), Value::Number(*qty));
        wb.set_cell(0, &format!("C{r}"), Value::Number(*price));
    }
    wb.define_table(Some("Inventory"), 0, rng(0, 0, 3, 2), true)
        .expect("define Inventory");
    wb
}

/// Compact, comparable description of the whole registry: one tuple per
/// Table with EVERY field the snapshot is supposed to preserve.
fn describe(wb: &Workbook) -> Vec<(String, String, CellRange, bool, bool, Vec<String>)> {
    wb.list_tables()
        .into_iter()
        .map(|t| {
            (
                t.name().to_string(),
                t.sheet_name().to_string(),
                t.range(),
                t.has_headers(),
                t.has_totals(),
                t.columns().to_vec(),
            )
        })
        .collect()
}

fn num(wb: &Workbook, a1: &str) -> f64 {
    match wb.get_cell("Sheet1", a1) {
        Value::Number(n) => n,
        other => panic!("expected number at {a1}, got {other:?}"),
    }
}

// ===================== exact round-trip per mutation =====================

#[test]
fn snapshot_restore_undoes_create_table() {
    let mut wb = inventory();
    let before = wb.snapshot_tables();
    let before_desc = describe(&wb);
    assert_eq!(before.len(), 1);

    wb.define_table(Some("Extra"), 0, rng(10, 0, 12, 1), true)
        .expect("define Extra");
    assert_eq!(wb.table_count(), 2);

    let restored = wb.restore_tables(before).expect("restore");
    assert_eq!(restored, 1);
    assert_eq!(describe(&wb), before_desc);
    assert!(wb.get_table("Extra").is_none());
}

#[test]
fn snapshot_restore_undoes_rename_table() {
    let mut wb = inventory();
    let before = wb.snapshot_tables();

    wb.rename_table("Inventory", "Stock").expect("rename");
    assert!(wb.get_table("Stock").is_some());

    wb.restore_tables(before).expect("restore");
    assert!(wb.get_table("Inventory").is_some());
    assert!(wb.get_table("Stock").is_none());
    // Display casing survives the round-trip, not just the uppercased key.
    assert_eq!(wb.get_table("INVENTORY").unwrap().name(), "Inventory");
}

#[test]
fn snapshot_restore_undoes_column_rename_preserving_display_casing() {
    let mut wb = inventory();
    let before = wb.snapshot_tables();
    assert_eq!(
        wb.get_table("Inventory").unwrap().columns(),
        ["Name", "Qty", "Price"]
    );

    wb.rename_table_column("Inventory", "Qty", "Quantity")
        .expect("rename column");
    assert_eq!(
        wb.get_table("Inventory").unwrap().columns(),
        ["Name", "Quantity", "Price"]
    );

    wb.restore_tables(before).expect("restore");
    assert_eq!(
        wb.get_table("Inventory").unwrap().columns(),
        ["Name", "Qty", "Price"]
    );
}

#[test]
fn snapshot_restore_undoes_delete_table() {
    let mut wb = inventory();
    let before_desc = describe(&wb);
    let before = wb.snapshot_tables();

    wb.delete_table("Inventory").expect("delete");
    assert_eq!(wb.table_count(), 0);

    wb.restore_tables(before).expect("restore");
    assert_eq!(describe(&wb), before_desc);
}

#[test]
fn snapshot_restore_undoes_totals_toggle_range_and_flag() {
    let mut wb = inventory();
    let before_desc = describe(&wb);
    let before = wb.snapshot_tables();
    assert!(!wb.get_table("Inventory").unwrap().has_totals());
    assert_eq!(wb.get_table("Inventory").unwrap().range(), rng(0, 0, 3, 2));

    wb.set_table_totals_row("Inventory", true).expect("enable");
    let after = wb.get_table("Inventory").unwrap();
    assert!(after.has_totals());
    assert_eq!(after.range(), rng(0, 0, 4, 2), "range grew one row");

    wb.restore_tables(before).expect("restore");
    assert_eq!(
        describe(&wb),
        before_desc,
        "has_totals AND the grown range both roll back"
    );
}

#[test]
fn snapshot_restore_undoes_a_multi_step_edit_session() {
    let mut wb = inventory();
    let before_desc = describe(&wb);
    let before = wb.snapshot_tables();

    // A whole dialog session's worth of registry churn.
    wb.set_table_totals_row("Inventory", true).expect("totals on");
    wb.set_table_total_function("Inventory", "Qty", TotalsFunction::Average)
        .expect("avg");
    wb.rename_table("Inventory", "Stock").expect("rename");
    wb.rename_table_column("Stock", "Price", "UnitPrice")
        .expect("rename column");
    wb.define_table(Some("Sidecar"), 0, rng(20, 0, 22, 0), true)
        .expect("second table");
    assert_eq!(wb.table_count(), 2);

    wb.restore_tables(before).expect("restore");
    assert_eq!(describe(&wb), before_desc);
}

// ===================== REPLACE (not additive) semantics ==================

#[test]
fn restoring_an_empty_snapshot_clears_the_registry() {
    let mut wb = Workbook::new();
    let empty = wb.snapshot_tables();
    assert!(empty.is_empty());

    wb.set_cell(0, "A1", Value::Text("Col".into()));
    wb.set_cell(0, "A2", Value::Number(7.0));
    wb.define_table(Some("Tally"), 0, rng(0, 0, 1, 0), true)
        .expect("define");
    assert_eq!(wb.table_count(), 1);

    let restored = wb.restore_tables(empty).expect("restore empty");
    assert_eq!(restored, 0);
    assert_eq!(
        wb.table_count(),
        0,
        "REPLACE: an empty snapshot clears, it does not no-op"
    );
}

#[test]
fn restore_drops_tables_created_after_capture_and_revives_deleted_ones() {
    let mut wb = inventory();
    wb.define_table(Some("Alpha"), 0, rng(10, 0, 11, 0), true)
        .expect("alpha");
    let before = wb.snapshot_tables();

    // Delete one, add another — an additive restore would get both wrong.
    wb.delete_table("Alpha").expect("delete alpha");
    wb.define_table(Some("Beta"), 0, rng(30, 0, 31, 0), true)
        .expect("beta");

    wb.restore_tables(before).expect("restore");
    assert!(wb.get_table("Alpha").is_some(), "deleted table revived");
    assert!(wb.get_table("Beta").is_none(), "created table dropped");
    assert_eq!(wb.table_count(), 2);
}

#[test]
fn restore_does_not_touch_cell_values_or_formulas() {
    let mut wb = inventory();
    let before = wb.snapshot_tables();
    wb.delete_table("Inventory").expect("delete");
    wb.set_cell(0, "B2", Value::Number(99.0));

    wb.restore_tables(before).expect("restore");
    // The registry is a VIEW over cells: restoring it must not rewrite them.
    assert_eq!(num(&wb, "B2"), 99.0);
    assert_eq!(num(&wb, "B3"), 2.0);
}

// ===================== epoch / invalidation ==============================

#[test]
fn restore_bumps_the_epoch_and_recomputes_structured_references() {
    let mut wb = inventory();
    wb.set_formula(0, "E1", "=SUM(Inventory[Qty])");
    assert_eq!(num(&wb, "E1"), 6.0, "1+2+3");

    let before = wb.snapshot_tables();

    // Delete the Table: the structured reference loses its target.
    wb.delete_table("Inventory").expect("delete");
    assert!(
        matches!(wb.get_cell("Sheet1", "E1"), Value::Error(_)),
        "no Inventory table ⇒ #NAME?, got {:?}",
        wb.get_cell("Sheet1", "E1")
    );

    let epoch_before_restore = wb.tables_epoch();
    wb.restore_tables(before).expect("restore");
    assert!(
        wb.tables_epoch() > epoch_before_restore,
        "restore broadcasts a tables-epoch bump"
    );
    assert_eq!(
        num(&wb, "E1"),
        6.0,
        "the referencing formula re-derived against the restored registry"
    );
}

#[test]
fn restore_of_a_grown_range_recomputes_the_reference_geometry() {
    let mut wb = inventory();
    wb.set_formula(0, "E1", "=SUM(Inventory[Qty])");
    assert_eq!(num(&wb, "E1"), 6.0);

    // Shrink the Table to two data rows, snapshot THAT, then restore the
    // wider original: the reference must widen back.
    let wide = wb.snapshot_tables();
    wb.restore_tables(TableRegistrySnapshot::from_entries(vec![
        TableEntry::from_parts(
            "Inventory",
            "Sheet1",
            rng(0, 0, 2, 2),
            true,
            false,
            vec!["Name".into(), "Qty".into(), "Price".into()],
        ),
    ]))
    .expect("narrow restore");
    assert_eq!(num(&wb, "E1"), 3.0, "1+2 — third data row is outside now");

    wb.restore_tables(wide).expect("wide restore");
    assert_eq!(num(&wb, "E1"), 6.0, "geometry restored ⇒ 1+2+3 again");
}

#[test]
fn restoring_an_identical_registry_skips_the_epoch_bump() {
    let mut wb = inventory();
    let snapshot = wb.snapshot_tables();
    let epoch = wb.tables_epoch();

    wb.restore_tables(snapshot).expect("restore identical");
    assert_eq!(
        wb.tables_epoch(),
        epoch,
        "a no-change restore must not force a workbook-wide recompute"
    );
}

#[test]
fn restore_invalidates_a_cross_sheet_structured_reference() {
    let mut wb = inventory();
    wb.add_sheet("Report");
    let report = wb.index_of("Report").expect("Report sheet");
    wb.set_formula(report, "A1", "=SUM(Inventory[Qty])");
    assert!(
        matches!(wb.get_cell("Report", "A1"), Value::Number(n) if n == 6.0),
        "cross-sheet reference resolves, got {:?}",
        wb.get_cell("Report", "A1")
    );

    let before = wb.snapshot_tables();
    wb.delete_table("Inventory").expect("delete");
    assert!(matches!(wb.get_cell("Report", "A1"), Value::Error(_)));

    wb.restore_tables(before).expect("restore");
    assert!(
        matches!(wb.get_cell("Report", "A1"), Value::Number(n) if n == 6.0),
        "the epoch broadcast reaches other sheets, got {:?}",
        wb.get_cell("Report", "A1")
    );
}

// ===================== validation survives restore =======================

#[test]
fn restore_rejects_more_than_the_cap_without_mutating() {
    let mut wb = inventory();
    let live = describe(&wb);

    let entries: Vec<TableEntry> = (0..257)
        .map(|i| {
            TableEntry::from_parts(
                format!("Bulk{i}"),
                "Sheet1",
                rng(i * 2, 0, i * 2 + 1, 0),
                true,
                false,
                vec!["Col".into()],
            )
        })
        .collect();

    assert_eq!(
        wb.restore_tables(TableRegistrySnapshot::from_entries(entries)),
        Err(TableError::TooManyTables)
    );
    assert_eq!(describe(&wb), live, "rejection left the registry untouched");
}

#[test]
fn restore_accepts_exactly_the_cap() {
    let mut wb = Workbook::new();
    let entries: Vec<TableEntry> = (0..256)
        .map(|i| {
            TableEntry::from_parts(
                format!("Bulk{i}"),
                "Sheet1",
                rng(i * 2, 0, i * 2 + 1, 0),
                true,
                false,
                vec!["Col".into()],
            )
        })
        .collect();
    assert_eq!(
        wb.restore_tables(TableRegistrySnapshot::from_entries(entries)),
        Ok(256)
    );
    assert_eq!(wb.table_count(), 256);
}

#[test]
fn restore_rejects_a_name_that_became_a_defined_name_after_capture() {
    let mut wb = inventory();
    let before = wb.snapshot_tables();
    wb.delete_table("Inventory").expect("delete");
    // The freed name is claimed by a defined name before undo runs.
    wb.define_name_value("Inventory", Value::Number(1.0))
        .expect("define name");

    assert_eq!(
        wb.restore_tables(before),
        Err(TableError::NameConflict),
        "the §4.2 shared namespace mutex is re-checked against CURRENT names"
    );
    assert_eq!(wb.table_count(), 0, "rejection did not partially restore");
}

#[test]
fn restore_rejects_duplicate_names_within_the_snapshot() {
    let mut wb = inventory();
    let live = describe(&wb);
    let dup = TableRegistrySnapshot::from_entries(vec![
        TableEntry::from_parts(
            "Dup",
            "Sheet1",
            rng(0, 0, 1, 0),
            true,
            false,
            vec!["A".into()],
        ),
        // Same key, different casing — the registry is case-insensitive.
        TableEntry::from_parts(
            "DUP",
            "Sheet1",
            rng(10, 0, 11, 0),
            true,
            false,
            vec!["A".into()],
        ),
    ]);
    assert_eq!(wb.restore_tables(dup), Err(TableError::NameConflict));
    assert_eq!(describe(&wb), live);
}

#[test]
fn restore_rejects_reserved_invalid_and_cell_ref_like_names() {
    let mut wb = Workbook::new();
    let one = |name: &str| {
        TableRegistrySnapshot::from_entries(vec![TableEntry::from_parts(
            name,
            "Sheet1",
            rng(0, 0, 1, 0),
            true,
            false,
            vec!["A".into()],
        )])
    };
    assert_eq!(wb.restore_tables(one("SUM")), Err(TableError::ReservedName));
    assert_eq!(wb.restore_tables(one("1bad")), Err(TableError::InvalidName));
    assert_eq!(
        wb.restore_tables(one("AB12")),
        Err(TableError::NameLikeCellRef)
    );
    assert_eq!(wb.table_count(), 0);
}

#[test]
fn restore_rejects_overlapping_ranges_on_one_sheet_but_allows_them_across_sheets() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");

    let overlapping = TableRegistrySnapshot::from_entries(vec![
        TableEntry::from_parts(
            "A",
            "Sheet1",
            rng(0, 0, 5, 2),
            true,
            false,
            vec!["a".into(), "b".into(), "c".into()],
        ),
        TableEntry::from_parts(
            "B",
            "Sheet1",
            rng(3, 1, 8, 3),
            true,
            false,
            vec!["a".into(), "b".into(), "c".into()],
        ),
    ]);
    assert_eq!(
        wb.restore_tables(overlapping),
        Err(TableError::RangeOverlap)
    );

    // Same rectangles, different sheets — legal, as with `define_table`.
    let cross_sheet = TableRegistrySnapshot::from_entries(vec![
        TableEntry::from_parts(
            "A",
            "Sheet1",
            rng(0, 0, 5, 2),
            true,
            false,
            vec!["a".into(), "b".into(), "c".into()],
        ),
        TableEntry::from_parts(
            "B",
            "Sheet2",
            rng(0, 0, 5, 2),
            true,
            false,
            vec!["a".into(), "b".into(), "c".into()],
        ),
    ]);
    assert_eq!(wb.restore_tables(cross_sheet), Ok(2));
}

#[test]
fn restore_rejects_a_column_count_that_disagrees_with_the_range_width() {
    let mut wb = inventory();
    let live = describe(&wb);
    let malformed = TableRegistrySnapshot::from_entries(vec![TableEntry::from_parts(
        "Broken",
        "Sheet1",
        rng(0, 0, 3, 2), // 3 columns wide …
        true,
        false,
        vec!["only-one".into()], // … but one column name
    )]);
    assert_eq!(
        wb.restore_tables(malformed),
        Err(TableError::MalformedSnapshot)
    );
    assert_eq!(describe(&wb), live);
}

// ===================== sheet anchoring across a snapshot =================

#[test]
fn snapshot_anchors_by_sheet_name_so_a_rename_between_capture_and_restore_shows_through() {
    let mut wb = inventory();
    let before = wb.snapshot_tables();
    assert_eq!(wb.get_table("Inventory").unwrap().sheet_name(), "Sheet1");

    wb.rename_sheet(0, "Data");
    assert_eq!(
        wb.get_table("Inventory").unwrap().sheet_name(),
        "Data",
        "the live registry followed the rename (§4.4)"
    );

    // Restoring the pre-rename snapshot re-asserts the OLD anchor verbatim —
    // REPLACE is faithful, so the host must order sheet-undo and
    // registry-undo consistently.
    wb.restore_tables(before).expect("restore");
    assert_eq!(wb.get_table("Inventory").unwrap().sheet_name(), "Sheet1");
}

#[test]
fn restore_keeps_entries_anchored_to_a_missing_sheet_and_they_resolve_once_it_returns() {
    let mut wb = inventory();
    wb.add_sheet("Scratch");
    let scratch = wb.index_of("Scratch").expect("Scratch");
    wb.set_cell(scratch, "A1", Value::Text("Col".into()));
    wb.set_cell(scratch, "A2", Value::Number(5.0));
    wb.define_table(Some("Scratchpad"), scratch, rng(0, 0, 1, 0), true)
        .expect("define");

    let before = wb.snapshot_tables();
    assert_eq!(before.len(), 2);

    // `remove_sheet` prunes the anchored Table (§4.4) …
    wb.remove_sheet(scratch);
    assert!(wb.get_table("Scratchpad").is_none());

    // … and the snapshot still restores it, orphaned but intact, so a host
    // replaying "undo deleteSheet" may restore in either order.
    wb.restore_tables(before).expect("restore");
    let entry = wb.get_table("Scratchpad").expect("orphan kept");
    assert_eq!(entry.sheet_name(), "Scratch");

    // Unresolvable while the sheet is gone — an error, never a panic.
    wb.set_formula(0, "E1", "=SUM(Scratchpad[Col])");
    assert!(
        matches!(wb.get_cell("Sheet1", "E1"), Value::Error(_)),
        "orphan anchor ⇒ #NAME?, got {:?}",
        wb.get_cell("Sheet1", "E1")
    );

    // Recreate the sheet and the reference lights up.
    wb.add_sheet("Scratch");
    let scratch = wb.index_of("Scratch").expect("Scratch again");
    wb.set_cell(scratch, "A1", Value::Text("Col".into()));
    wb.set_cell(scratch, "A2", Value::Number(5.0));
    assert_eq!(num(&wb, "E1"), 5.0);
}

// ===================== snapshot is a pure read ===========================

#[test]
fn snapshot_does_not_bump_the_epoch_or_mutate() {
    let mut wb = inventory();
    let epoch = wb.tables_epoch();
    let live = describe(&wb);

    let a = wb.snapshot_tables();
    let b = wb.snapshot_tables();

    assert_eq!(wb.tables_epoch(), epoch);
    assert_eq!(describe(&wb), live);
    assert_eq!(a, b, "two snapshots of one registry compare equal");
}

#[test]
fn snapshot_entries_expose_every_field_for_host_serialization() {
    let mut wb = inventory();
    wb.set_table_totals_row("Inventory", true).expect("totals");
    let snapshot = wb.snapshot_tables();

    let entry = snapshot.entries().first().expect("one entry");
    assert_eq!(entry.name(), "Inventory");
    assert_eq!(entry.sheet_name(), "Sheet1");
    assert_eq!(entry.range(), rng(0, 0, 4, 2));
    assert!(entry.has_headers());
    assert!(entry.has_totals());
    assert_eq!(entry.columns(), ["Name", "Qty", "Price"]);

    // …and a round-trip through the public constructor reproduces it.
    let rebuilt = TableRegistrySnapshot::from_entries(
        snapshot
            .entries()
            .iter()
            .map(|e| {
                TableEntry::from_parts(
                    e.name(),
                    e.sheet_name(),
                    e.range(),
                    e.has_headers(),
                    e.has_totals(),
                    e.columns().to_vec(),
                )
            })
            .collect(),
    );
    assert_eq!(rebuilt, snapshot);
}
