//! #32 Excel Table — T1 engine registry (design doc `design-excel-table.md`
//! §4.1 / §4.2 / §4.3 / §4.4 / §8 broadcast seam).
//!
//! Scope of THIS slice (and thus of this suite):
//!   - workbook-level Table registry: create / rename / delete / get / list,
//!     bounded to 256;
//!   - the shared defined-name / built-in / cell-ref / Table name mutex, in
//!     both directions;
//!   - structural-follow of Table ranges through row/col insert/delete
//!     (§4.3 matrix), including column-name insert/remove;
//!   - the sheet lifecycle hooks (rename/remove/move) that maintain the
//!     Table's sheet anchor;
//!   - the `tables_epoch` broadcast counter (§8 seam).
//!
//! Structured-reference PARSING (T2) and EVALUATION / real per-sheet epoch
//! atoms (T3/T4) are out of scope — nothing here exercises `=Table1[Col]`.

use einfach_core::Value;
use einfach_excel_core::{CellAddress, CellRange, TableError, Workbook, WorkbookError};

fn addr(row: u32, col: u32) -> CellAddress {
    CellAddress::new(row, col)
}

fn rng(sr: u32, sc: u32, er: u32, ec: u32) -> CellRange {
    CellRange::new(addr(sr, sc), addr(er, ec))
}

fn text(wb: &mut Workbook, a1: &str, s: &str) {
    wb.set_cell(0, a1, Value::Text(s.to_string()));
}

/// A 3×3 Table anchored at A2:C4 on Sheet1 with headers Name/Qty/Price and
/// two data rows. Room above (row 1) and left (there is none left of col A,
/// so left-shift tests use a right-anchored variant).
fn wb_with_table() -> Workbook {
    let mut wb = Workbook::new();
    text(&mut wb, "A2", "Name");
    text(&mut wb, "B2", "Qty");
    text(&mut wb, "C2", "Price");
    text(&mut wb, "A3", "x");
    wb.set_cell(0, "B3", Value::Number(1.0));
    wb.set_cell(0, "C3", Value::Number(10.0));
    text(&mut wb, "A4", "y");
    wb.set_cell(0, "B4", Value::Number(2.0));
    wb.set_cell(0, "C4", Value::Number(20.0));
    let name = wb
        .define_table(Some("Inventory"), 0, rng(1, 0, 3, 2), true)
        .unwrap();
    assert_eq!(name, "Inventory");
    wb
}

// ===================== CRUD =====================

#[test]
fn create_get_list_delete() {
    let mut wb = wb_with_table();
    let t = wb.get_table("Inventory").expect("table registered");
    assert_eq!(t.name(), "Inventory");
    assert_eq!(t.sheet_name(), "Sheet1");
    assert_eq!(t.range(), rng(1, 0, 3, 2));
    assert!(t.has_headers());
    assert!(!t.has_totals());
    assert_eq!(t.columns(), &["Name", "Qty", "Price"]);

    assert_eq!(wb.list_tables().len(), 1);
    assert_eq!(wb.table_count(), 1);

    // Case-insensitive lookup.
    assert!(wb.get_table("inVENTory").is_some());

    wb.delete_table("Inventory").unwrap();
    assert!(wb.get_table("Inventory").is_none());
    assert_eq!(wb.table_count(), 0);
}

#[test]
fn delete_preserves_cell_values() {
    let mut wb = wb_with_table();
    wb.delete_table("Inventory").unwrap();
    // Only the registry metadata is gone; cells are untouched.
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("Name".into()));
    assert_eq!(wb.get_cell("Sheet1", "C4"), Value::Number(20.0));
}

#[test]
fn delete_unknown_is_not_found() {
    let mut wb = Workbook::new();
    assert_eq!(wb.delete_table("Nope"), Err(TableError::NotFound));
}

#[test]
fn rename_changes_key_and_display_name() {
    let mut wb = wb_with_table();
    wb.rename_table("Inventory", "Stock").unwrap();
    assert!(wb.get_table("Inventory").is_none());
    let t = wb.get_table("Stock").unwrap();
    assert_eq!(t.name(), "Stock");
    // Range/columns/sheet survive the rename.
    assert_eq!(t.range(), rng(1, 0, 3, 2));
    assert_eq!(t.columns(), &["Name", "Qty", "Price"]);
}

#[test]
fn rename_case_only_is_allowed() {
    let mut wb = wb_with_table();
    // Self-exclusion: renaming to a case variant of the same name is fine.
    wb.rename_table("Inventory", "INVENTORY").unwrap();
    assert_eq!(wb.get_table("inventory").unwrap().name(), "INVENTORY");
}

#[test]
fn rename_unknown_is_not_found() {
    let mut wb = Workbook::new();
    assert_eq!(wb.rename_table("Nope", "Other"), Err(TableError::NotFound));
}

// ===================== auto-naming & column derivation =====================

#[test]
fn auto_names_are_sequential_and_skip_taken() {
    let mut wb = Workbook::new();
    let a = wb.define_table(None, 0, rng(0, 0, 0, 0), true).unwrap();
    let b = wb.define_table(None, 0, rng(1, 0, 1, 0), true).unwrap();
    assert_eq!(a, "Table1");
    assert_eq!(b, "Table2");

    // With an explicit "Table3" taken, the next auto-name jumps to Table4.
    wb.define_table(Some("Table3"), 0, rng(2, 0, 2, 0), true).unwrap();
    let c = wb.define_table(None, 0, rng(3, 0, 3, 0), true).unwrap();
    assert_eq!(c, "Table4");
}

#[test]
fn blank_and_duplicate_headers_are_disambiguated() {
    let mut wb = Workbook::new();
    text(&mut wb, "A1", "First");
    // B1 intentionally blank.
    text(&mut wb, "C1", "First"); // duplicate of A1
    wb.define_table(Some("Tbl"), 0, rng(0, 0, 0, 2), true).unwrap();
    assert_eq!(
        wb.get_table("Tbl").unwrap().columns(),
        &["First", "Column1", "Column2"]
    );
}

#[test]
fn columns_count_matches_range_width() {
    let wb = wb_with_table();
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.columns().len() as u32, t.range().cols());
}

// ===================== name mutex (all directions) =====================

#[test]
fn rejects_invalid_names() {
    let mut wb = Workbook::new();
    assert_eq!(
        wb.define_table(Some("1bad"), 0, rng(0, 0, 0, 0), true),
        Err(TableError::InvalidName)
    );
    assert_eq!(
        wb.define_table(Some("bad-name"), 0, rng(0, 0, 0, 0), true),
        Err(TableError::InvalidName)
    );
}

#[test]
fn rejects_builtin_function_names() {
    let mut wb = Workbook::new();
    assert_eq!(
        wb.define_table(Some("SUM"), 0, rng(0, 0, 0, 0), true),
        Err(TableError::ReservedName)
    );
}

#[test]
fn rejects_in_grid_cell_ref_names_but_allows_table1() {
    let mut wb = Workbook::new();
    // In-grid A1 references are unreachable as bare Table refs → refused.
    assert_eq!(
        wb.define_table(Some("AB12"), 0, rng(0, 0, 0, 0), true),
        Err(TableError::NameLikeCellRef)
    );
    assert_eq!(
        wb.define_table(Some("Q1"), 0, rng(1, 0, 1, 0), true),
        Err(TableError::NameLikeCellRef)
    );
    // "Table1" parses to column TABLE (far past XFD) so it is NOT a cell
    // reference and is accepted — the default auto-name must be usable.
    assert!(wb
        .define_table(Some("Table1"), 0, rng(2, 0, 2, 0), true)
        .is_ok());
    // A bare single letter is reachable as a Name (grid-bounded guard) and
    // is allowed — a documented deviation from the design doc's "reject A".
    assert!(wb
        .define_table(Some("A"), 0, rng(3, 0, 3, 0), true)
        .is_ok());
}

#[test]
fn rejects_duplicate_table_name_case_insensitively() {
    let mut wb = Workbook::new();
    wb.define_table(Some("Sales"), 0, rng(0, 0, 0, 0), true).unwrap();
    assert_eq!(
        wb.define_table(Some("sales"), 0, rng(1, 0, 1, 0), true),
        Err(TableError::NameConflict)
    );
}

#[test]
fn table_and_defined_name_share_one_namespace_both_directions() {
    // Forward: a Table refuses an existing defined name.
    let mut wb = Workbook::new();
    wb.define_name("Markup", "=0.2").unwrap();
    assert_eq!(
        wb.define_table(Some("markup"), 0, rng(0, 0, 0, 0), true),
        Err(TableError::NameConflict)
    );

    // Reverse: a defined name refuses an existing Table name.
    let mut wb2 = Workbook::new();
    wb2.define_table(Some("Inventory"), 0, rng(0, 0, 0, 0), true).unwrap();
    assert_eq!(
        wb2.define_name("inventory", "=1"),
        Err(WorkbookError::NameConflict)
    );
    assert_eq!(
        wb2.define_name_value("INVENTORY", Value::Number(1.0)),
        Err(WorkbookError::NameConflict)
    );
}

#[test]
fn rename_enforces_the_mutex() {
    let mut wb = Workbook::new();
    wb.define_table(Some("Alpha"), 0, rng(0, 0, 0, 0), true).unwrap();
    wb.define_table(Some("Beta"), 0, rng(1, 0, 1, 0), true).unwrap();
    // Rename onto a taken name (case-insensitive).
    assert_eq!(
        wb.rename_table("Beta", "alpha"),
        Err(TableError::NameConflict)
    );
    // Rename onto a built-in / cell-ref form.
    assert_eq!(wb.rename_table("Beta", "IF"), Err(TableError::ReservedName));
    assert_eq!(
        wb.rename_table("Beta", "C3"),
        Err(TableError::NameLikeCellRef)
    );
}

// ===================== range overlap =====================

#[test]
fn overlapping_range_rejected_same_sheet() {
    let mut wb = Workbook::new();
    wb.define_table(Some("A"), 0, rng(0, 0, 1, 1), true).unwrap();
    assert_eq!(
        wb.define_table(Some("B"), 0, rng(1, 1, 2, 2), true),
        Err(TableError::RangeOverlap)
    );
    // Adjacent (touching but not overlapping) is fine.
    assert!(wb.define_table(Some("C"), 0, rng(2, 2, 3, 3), true).is_ok());
}

#[test]
fn same_range_on_different_sheet_is_allowed() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    wb.define_table(Some("A"), 0, rng(0, 0, 1, 1), true).unwrap();
    // Same rectangle, different sheet → no overlap.
    assert!(wb.define_table(Some("B"), 1, rng(0, 0, 1, 1), true).is_ok());
}

#[test]
fn bad_sheet_index_rejected() {
    let mut wb = Workbook::new();
    assert_eq!(
        wb.define_table(Some("A"), 9, rng(0, 0, 0, 0), true),
        Err(TableError::SheetNotFound)
    );
}

// ===================== cap 256 =====================

#[test]
fn cap_256_tables_per_workbook() {
    let mut wb = Workbook::new();
    for i in 0..256u32 {
        let name = wb
            .define_table(None, 0, rng(i, 0, i, 0), true)
            .expect("under cap");
        assert_eq!(name, format!("Table{}", i + 1));
    }
    assert_eq!(wb.table_count(), 256);
    assert_eq!(
        wb.define_table(None, 0, rng(256, 0, 256, 0), true),
        Err(TableError::TooManyTables)
    );
    // Deleting one frees a slot.
    wb.delete_table("Table1").unwrap();
    assert!(wb.define_table(None, 0, rng(256, 0, 256, 0), true).is_ok());
}

// ===================== structural follow (§4.3) =====================

#[test]
fn insert_row_above_shifts_table_down() {
    let mut wb = wb_with_table();
    wb.insert_rows(0, 0, 1);
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.range(), rng(2, 0, 4, 2));
    // Cells follow: the "Name" header moved A2 → A3.
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Text("Name".into()));
    assert_eq!(t.columns(), &["Name", "Qty", "Price"]);
}

#[test]
fn insert_row_inside_data_grows_table() {
    let mut wb = wb_with_table();
    // Insert at the first data row (row index 2) → range grows one row.
    wb.insert_rows(0, 2, 1);
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.range(), rng(1, 0, 4, 2));
    // Header stays put; a blank data row appears; data pushed down.
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("Name".into()));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Null);
    assert_eq!(wb.get_cell("Sheet1", "A4"), Value::Text("x".into()));
}

#[test]
fn delete_partial_data_rows_shrinks_table() {
    let mut wb = wb_with_table();
    // Delete the first data row (row index 2).
    wb.delete_rows(0, 2, 1);
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.range(), rng(1, 0, 2, 2));
    // "y" shifted up from row 4 to row 3.
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Text("y".into()));
}

#[test]
fn delete_all_data_rows_keeps_zero_row_table() {
    let mut wb = wb_with_table();
    // Delete both data rows (indices 2 and 3).
    wb.delete_rows(0, 2, 2);
    let t = wb.get_table("Inventory").unwrap();
    // Header-only table survives (design doc §4.1 / §4.3 known divergence).
    assert_eq!(t.range(), rng(1, 0, 1, 2));
    assert_eq!(t.columns(), &["Name", "Qty", "Price"]);
}

#[test]
fn delete_header_row_drops_table() {
    let mut wb = wb_with_table();
    // Delete the header row (index 1).
    wb.delete_rows(0, 1, 1);
    assert!(wb.get_table("Inventory").is_none());
    assert_eq!(wb.table_count(), 0);
}

#[test]
fn insert_column_inside_widens_and_auto_names() {
    let mut wb = wb_with_table();
    // Insert one column between A and B (index 1).
    wb.insert_columns(0, 1, 1);
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.range(), rng(1, 0, 3, 3));
    assert_eq!(t.columns(), &["Name", "Column1", "Qty", "Price"]);
    // "Qty" header moved B2 → C2; the inserted column B2 is blank.
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Text("Qty".into()));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Null);
}

#[test]
fn insert_column_left_shifts_table_right() {
    let mut wb = wb_with_table();
    wb.insert_columns(0, 0, 1);
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.range(), rng(1, 1, 3, 3));
    // Columns unchanged (a whole-table shift, not an in-table insert).
    assert_eq!(t.columns(), &["Name", "Qty", "Price"]);
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("Name".into()));
}

#[test]
fn delete_partial_columns_shrinks_and_drops_names() {
    let mut wb = wb_with_table();
    // Delete column B (index 1, "Qty").
    wb.delete_columns(0, 1, 1);
    let t = wb.get_table("Inventory").unwrap();
    assert_eq!(t.range(), rng(1, 0, 3, 1));
    assert_eq!(t.columns(), &["Name", "Price"]);
    // "Price" shifted C → B.
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("Price".into()));
}

#[test]
fn delete_all_columns_drops_table() {
    let mut wb = wb_with_table();
    wb.delete_columns(0, 0, 3);
    assert!(wb.get_table("Inventory").is_none());
}

#[test]
fn structural_edit_on_other_sheet_leaves_table_untouched() {
    let mut wb = wb_with_table();
    wb.add_sheet("Sheet2");
    let before = wb.get_table("Inventory").unwrap().range();
    let epoch = wb.tables_epoch();
    wb.insert_rows(1, 0, 5); // edit Sheet2
    assert_eq!(wb.get_table("Inventory").unwrap().range(), before);
    assert_eq!(wb.tables_epoch(), epoch, "unrelated sheet edit must not bump");
}

// ===================== epoch broadcast (§8 seam) =====================

#[test]
fn epoch_advances_on_mutations_only() {
    let mut wb = Workbook::new();
    let e0 = wb.tables_epoch();
    wb.define_table(Some("Ledger"), 0, rng(1, 0, 3, 2), true).unwrap();
    let e1 = wb.tables_epoch();
    assert!(e1 > e0, "create bumps epoch");

    // A structural edit fully below the table changes nothing → no bump.
    wb.insert_rows(0, 100, 1);
    assert_eq!(wb.tables_epoch(), e1, "no-op follow must not bump");

    // A structural edit that moves the table bumps.
    wb.insert_rows(0, 0, 1);
    let e2 = wb.tables_epoch();
    assert!(e2 > e1, "table-moving edit bumps epoch");

    wb.rename_table("Ledger", "Ledger2").unwrap();
    assert!(wb.tables_epoch() > e2, "rename bumps epoch");
    let e3 = wb.tables_epoch();

    wb.delete_table("Ledger2").unwrap();
    assert!(wb.tables_epoch() > e3, "delete bumps epoch");
}

// ===================== sheet lifecycle hooks (§4.4) =====================

#[test]
fn rename_sheet_reanchors_tables() {
    let mut wb = wb_with_table();
    let epoch = wb.tables_epoch();
    assert!(wb.rename_sheet(0, "Data"));
    assert_eq!(wb.get_table("Inventory").unwrap().sheet_name(), "Data");
    assert!(wb.tables_epoch() > epoch);
    // The table still follows structural edits under the new sheet name.
    assert_eq!(wb.get_cell("Data", "A2"), Value::Text("Name".into()));
}

#[test]
fn remove_sheet_drops_anchored_tables() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    wb.define_table(Some("OnOne"), 0, rng(0, 0, 0, 0), true).unwrap();
    wb.define_table(Some("OnTwo"), 1, rng(0, 0, 0, 0), true).unwrap();
    let epoch = wb.tables_epoch();
    wb.remove_sheet(1); // remove Sheet2
    assert!(wb.get_table("OnTwo").is_none());
    assert!(wb.get_table("OnOne").is_some());
    assert!(wb.tables_epoch() > epoch);
}

#[test]
fn move_sheet_leaves_name_anchor_intact() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet2");
    wb.define_table(Some("OnTwo"), 1, rng(0, 0, 0, 0), true).unwrap();
    assert!(wb.move_sheet(1, 0));
    // Anchored by name, so the table is unaffected by reordering.
    assert_eq!(wb.get_table("OnTwo").unwrap().sheet_name(), "Sheet2");
}
