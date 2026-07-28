//! Integration tests for the reference/lookup batch (ROW / COLUMN / ROWS /
//! COLUMNS / CHOOSE / ADDRESS / INDIRECT / XLOOKUP). These round-trip through
//! a real `Workbook` so we cover parse + dependency tracking + eval + cache.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// ROW / COLUMN / ROWS / COLUMNS used inside cells, exercising parse + eval.
#[test]
fn row_column_dimensions_round_trip() {
    let mut wb = Workbook::new();
    // Targets are intentionally outside any range/ref arg below — even though
    // ROW/ROWS read only the address, the dep tracker still registers the
    // arg cells, so a target inside its own range arg would loop back.
    wb.set_formula(0, "H1", "=ROW(B5)");
    wb.set_formula(0, "H2", "=COLUMN(D7)");
    wb.set_formula(0, "H3", "=ROWS(A1:A10)");
    wb.set_formula(0, "H4", "=COLUMNS(B2:F4)");
    assert_eq!(wb.get_cell("Sheet1", "H1"), Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "H2"), Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "H3"), Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "H4"), Value::Number(5.0));
}

/// `=ROW()` / `=COLUMN()` with no args resolve to the formula's own row /
/// column once the provider exposes `current_cell()`. The legacy single-sheet
/// `AtomEvalProvider` returns `#REF!` for the no-arg form (covered by the
/// inline `eval_row` / `eval_column` unit tests); this exercise covers the
/// production `WorkbookEvalProvider` path.
#[test]
fn row_column_no_args_uses_current_cell() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "B3", "=ROW()");
    wb.set_formula(0, "C5", "=COLUMN()");
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "C5"), Value::Number(3.0));
}

/// CHOOSE + ADDRESS + INDIRECT chain: build an address string with ADDRESS,
/// then deref it with INDIRECT, using CHOOSE to pick the source. This was a
/// motivator for landing all four together — they compose nicely.
#[test]
fn choose_address_indirect_compose() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "B2", Value::Number(99.0));
    wb.set_cell(0, "C3", Value::Number(7.0));
    // CHOOSE picks index 2 → ADDRESS(3,3,4) → "C3" → INDIRECT → 7.
    wb.set_formula(
        0,
        "A1",
        "=INDIRECT(CHOOSE(2,ADDRESS(2,2,4),ADDRESS(3,3,4)))",
    );
    // Also exercise ADDRESS abs_num=1 default.
    wb.set_formula(0, "A2", "=ADDRESS(2,2)");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(7.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("$B$2".into()));
}

#[test]
fn indirect_supports_absolute_whole_axis_refs() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A3", Value::Number(3.0));
    wb.set_cell(0, "B1", Value::Number(10.0));

    wb.set_formula(0, "D2", "=SUM(INDIRECT(\"$A:$A\"))");
    wb.set_formula(0, "D3", "=SUM(INDIRECT(\"$1:$1\"))");

    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Number(11.0));
}

#[test]
fn spill_refs_round_trip_through_reference_functions() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=SEQUENCE(2,2)"));
    wb.set_formula(0, "D1", "=SUM(A1#)");
    wb.set_formula(0, "D2", "=ROWS(A1#)");
    wb.set_formula(0, "D3", "=COLUMNS(A1#)");
    wb.set_formula(0, "D4", "=INDEX(A1#,2,2)");

    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "D4"), Value::Number(4.0));
}

#[test]
fn spill_ref_tracks_anchor_shape_changes() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=SEQUENCE(2,1)"));
    wb.set_formula(0, "D1", "=SUM(A1#)");
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(3.0));

    assert!(wb.set_formula(0, "A1", "=SEQUENCE(3,1)"));
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(6.0));
}

#[test]
fn cross_sheet_spill_ref_is_materialized() {
    let mut wb = Workbook::new();
    let data_idx = wb.add_sheet("Data");
    assert!(wb.set_formula(data_idx, "A1", "=SEQUENCE(2,2)"));
    wb.set_formula(0, "D1", "=SUM(Data!A1#)");

    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(10.0));
}

#[test]
fn scalar_spill_anchor_returns_ref_error() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_formula(0, "D1", "=SUM(A1#)");

    assert_eq!(
        wb.get_cell("Sheet1", "D1"),
        Value::Error(ValueError::InvalidRef)
    );
}

#[test]
fn dynamic_range_endpoint_uses_reference_returning_index() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Number(2.0));
    wb.set_cell(0, "A3", Value::Number(3.0));
    wb.set_cell(0, "A4", Value::Number(4.0));

    wb.set_formula(0, "D1", "=SUM(A1:INDEX(A:A,3))");
    wb.set_formula(0, "D2", "=ROWS(A1:INDEX(A:A,3))");
    wb.set_formula(0, "D3", "=ROWS(INDEX(A1:A3,0))");

    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(6.0));
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Number(3.0));
}

#[test]
fn index_rejects_out_of_bounds_indices_before_u32_cast() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(123.0));

    wb.set_formula(0, "D1", "=INDEX(A:A,4294967297)");
    wb.set_formula(0, "D2", "=INDEX(1:1,1,4294967297)");

    assert_eq!(
        wb.get_cell("Sheet1", "D1"),
        Value::Error(ValueError::InvalidRef)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "D2"),
        Value::Error(ValueError::InvalidRef)
    );
}

/// XLOOKUP round-trip: build a lookup table, query exact matches, then
/// confirm the not-found-default path.
#[test]
fn xlookup_round_trip() {
    let mut wb = Workbook::new();
    // Lookup row: A1=apple B1=banana C1=cherry
    wb.set_cell(0, "A1", Value::Text("apple".into()));
    wb.set_cell(0, "B1", Value::Text("banana".into()));
    wb.set_cell(0, "C1", Value::Text("cherry".into()));
    // Return row: A2=10 B2=20 C2=30
    wb.set_cell(0, "A2", Value::Number(10.0));
    wb.set_cell(0, "B2", Value::Number(20.0));
    wb.set_cell(0, "C2", Value::Number(30.0));

    wb.set_formula(0, "D1", "=XLOOKUP(\"banana\",A1:C1,A2:C2)");
    wb.set_formula(0, "D2", "=XLOOKUP(\"durian\",A1:C1,A2:C2,-1)");
    wb.set_formula(0, "D3", "=XLOOKUP(\"durian\",A1:C1,A2:C2)");

    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(20.0));
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(-1.0));
    assert_eq!(
        wb.get_cell("Sheet1", "D3"),
        Value::Error(ValueError::NotAvailable)
    );
}
