//! Codex P2 #1 regression: `rebuild_cross_sheet_deps` must observe
//! lazy (unhydrated) cross-sheet formulas, not just the hydrated AST
//! cache. Otherwise sheet moves silently drop cross-sheet edges for
//! anything still parked in `formula_source` / `needs_parse`.

use std::cell::RefCell;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::Workbook;

#[test]
fn move_sheet_after_bulk_load_preserves_lazy_cross_sheet_edges() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");

    wb.bulk_load(|loader| {
        loader.set_cell(s2, "A1", Value::Number(1.0));
        loader.set_formula(0, "B1", "=Sheet2!A1+1");
    });

    // Move Sheet2 to slot 0. The cross-sheet rebuild must walk
    // `formula_source` / `needs_parse` so the lazy `=Sheet2!A1+1`
    // edge survives the rebuild.
    assert!(wb.move_sheet(s2, 0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));

    let counter = Rc::new(RefCell::new(0usize));
    let counter_clone = counter.clone();
    let sheet1_idx = wb.index_of("Sheet1").unwrap();
    let _sub = wb
        .sheet_mut(sheet1_idx)
        .unwrap()
        .subscribe_cell("B1", move || {
            *counter_clone.borrow_mut() += 1;
        });

    // Mutate the source of the cross-sheet edge.
    let data_idx = wb.index_of("Sheet2").unwrap();
    wb.set_cell(data_idx, "A1", Value::Number(5.0));

    assert_eq!(
        *counter.borrow(),
        1,
        "cross-sheet subscriber must fire when source mutates"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));
}

/// Range-dep variant: a lazy cross-sheet RANGE reference (`=SUM(...)`)
/// must also be observed by the rebuild.
#[test]
fn move_sheet_after_bulk_load_preserves_lazy_cross_sheet_range_edges() {
    let mut wb = Workbook::new();
    let data_idx = wb.add_sheet("Data");

    wb.bulk_load(|loader| {
        loader.set_cell(data_idx, "A1", Value::Number(1.0));
        loader.set_cell(data_idx, "A2", Value::Number(2.0));
        loader.set_formula(0, "B1", "=SUM(Data!A1:A2)");
    });

    assert!(wb.move_sheet(data_idx, 0));
    let data_idx = wb.index_of("Data").unwrap();
    let sheet1_idx = wb.index_of("Sheet1").unwrap();

    // Mutate inside the range; cache should dirty cross-sheet.
    wb.set_cell(data_idx, "A1", Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
    assert_eq!(
        wb.debug_formula_cache_state(sheet1_idx, "B1"),
        "clean",
        "post-read cache should be clean"
    );

    wb.set_cell(data_idx, "A2", Value::Number(20.0));
    assert_eq!(
        wb.debug_formula_cache_state(sheet1_idx, "B1"),
        "dirty",
        "cross-sheet range edge must invalidate downstream formula"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(30.0));
}
