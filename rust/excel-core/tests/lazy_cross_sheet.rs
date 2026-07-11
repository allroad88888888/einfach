//! Lazy cross-sheet formulas must survive sheet moves without requiring a
//! workbook-owned dependency graph. Once read, their shared Store edges must
//! continue to propagate source changes.

use std::cell::RefCell;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::Workbook;

#[test]
fn move_sheet_after_bulk_load_preserves_lazy_cross_sheet_store_path() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");

    wb.bulk_load(|loader| {
        loader.set_cell(s2, "A1", Value::Number(1.0));
        loader.set_formula(0, "B1", "=Sheet2!A1+1");
    });

    // Move Sheet2 to slot 0 before the lazy formula has been read.
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

    // Mutate the source after the Store path has been materialized.
    let data_idx = wb.index_of("Sheet2").unwrap();
    wb.set_cell(data_idx, "A1", Value::Number(5.0));

    assert_eq!(
        *counter.borrow(),
        1,
        "cross-sheet subscriber must fire when source mutates"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));
}

/// Range-dep variant of the same lazy materialization contract.
#[test]
fn move_sheet_after_bulk_load_preserves_lazy_cross_sheet_range_store_path() {
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

    // The first read materializes the range's Store dependencies.
    wb.set_cell(data_idx, "A1", Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
    assert_eq!(
        wb.debug_formula_cache_state(sheet1_idx, "B1"),
        "clean",
        "post-read cache should be clean"
    );

    let evals_before = wb.debug_formula_eval_count(sheet1_idx);
    wb.set_cell(data_idx, "A2", Value::Number(20.0));
    assert_eq!(
        wb.debug_formula_cache_state(sheet1_idx, "B1"),
        "clean",
        "the materialized range formula must settle through Store"
    );
    assert_eq!(
        wb.debug_formula_eval_count(sheet1_idx),
        evals_before + 1,
        "the Store write must rederive the dependent exactly once"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(30.0));
}
