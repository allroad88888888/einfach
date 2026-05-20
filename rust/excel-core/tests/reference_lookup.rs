//! Integration tests for the reference/lookup batch (ROW / COLUMN / ROWS /
//! COLUMNS / CHOOSE / ADDRESS / INDIRECT / XLOOKUP). These round-trip through
//! a real `Workbook` so we cover parse + dependency tracking + eval + cache.

use einfach_core::Value;
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
    // Not found, no default → InvalidValue (#VALUE!-shaped error).
    match wb.get_cell("Sheet1", "D3") {
        Value::Error(_) => {}
        v => panic!("expected error, got {:?}", v),
    }
}
