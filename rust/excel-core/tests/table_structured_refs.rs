//! #32 Excel Table — T2 structured-reference EVALUATION conformance
//! (design doc `design-excel-table.md` §5.3 / §5.4).
//!
//! Drives structured references end-to-end through the public `Workbook`
//! API so the parser, the eval-time `TableRef → SheetRange` resolver, and
//! the reactive formula-inner provider (`AtomFormulaProvider`) all
//! cooperate against real cells. Covered:
//!   - aggregate context `SUM(Table[Col])` (same-sheet + cross-sheet),
//!   - value/range context via `INDEX(Table[Col], n)` and bare-ref spill,
//!   - `#special` bands (#All / #Data / #Headers / #Totals),
//!   - multi-column `[ColA]:[ColB]` segments,
//!   - `[@Col]` / `Table[@Col]` this-row resolution (in and out of range),
//!   - error surfaces: unknown table `#NAME?`, unknown column / `#Totals`
//!     without a totals row `#REF!`, this-row outside data `#VALUE!`,
//!   - cell-content dependency tracking (edit a Table cell → dependent
//!     structured-reference formula recomputes).
//!
//! Table geometry-change reactive invalidation (rename / totals toggle /
//! structural follow re-derive) is the T3 seam and is not asserted here.

use einfach_core::{Value, ValueError};
use einfach_excel_core::{CellAddress, CellRange, Workbook};

fn rng(sr: u32, sc: u32, er: u32, ec: u32) -> CellRange {
    CellRange::new(CellAddress::new(sr, sc), CellAddress::new(er, ec))
}

/// Inventory table at A1:C4 on Sheet1: headers Name/Qty/Price + 3 data rows.
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

fn eval(wb: &mut Workbook, addr: &str, formula: &str) -> Value {
    assert!(wb.set_formula(0, addr, formula), "set_formula failed: {formula}");
    wb.get_cell("Sheet1", addr)
}

fn num(wb: &mut Workbook, addr: &str, formula: &str) -> f64 {
    match eval(wb, addr, formula) {
        Value::Number(n) => n,
        other => panic!("expected number from {formula}, got {other:?}"),
    }
}

// ===================== aggregate context =====================

#[test]
fn sum_single_column() {
    let mut wb = inventory();
    assert_eq!(num(&mut wb, "E1", "=SUM(Inventory[Qty])"), 6.0);
    assert_eq!(num(&mut wb, "E2", "=SUM(Inventory[Price])"), 60.0);
    assert_eq!(num(&mut wb, "E3", "=AVERAGE(Inventory[Price])"), 20.0);
    assert_eq!(num(&mut wb, "E4", "=COUNT(Inventory[Qty])"), 3.0);
    assert_eq!(num(&mut wb, "E5", "=MAX(Inventory[Price])"), 30.0);
    assert_eq!(num(&mut wb, "E6", "=MIN(Inventory[Qty])"), 1.0);
}

#[test]
fn sum_multi_column_segment() {
    let mut wb = inventory();
    // Qty (1+2+3) + Price (10+20+30) = 66.
    assert_eq!(num(&mut wb, "E1", "=SUM(Inventory[[Qty]:[Price]])"), 66.0);
}

// ===================== #special bands =====================

#[test]
fn special_bands() {
    let mut wb = inventory();
    // #All = 4 rows x 3 cols = 12 non-empty cells.
    assert_eq!(num(&mut wb, "E1", "=COUNTA(Inventory[#All])"), 12.0);
    // #Headers = the 3 header cells.
    assert_eq!(num(&mut wb, "E2", "=COUNTA(Inventory[#Headers])"), 3.0);
    // #Data = 3 rows x 3 cols; only Qty + Price columns are numeric = 6.
    assert_eq!(num(&mut wb, "E3", "=COUNT(Inventory[#Data])"), 6.0);
    // Bare `Inventory[Col]` defaults to the data band.
    assert_eq!(num(&mut wb, "E4", "=SUM(Inventory[#Data])"), 66.0);
}

#[test]
fn totals_band_without_totals_row_is_ref_error() {
    let mut wb = inventory();
    // has_totals = false → #Totals resolves to #REF! (design §5.3 point 3).
    assert_eq!(
        eval(&mut wb, "E1", "=Inventory[#Totals]"),
        Value::Error(ValueError::InvalidRef)
    );
}

// ===================== value / range context =====================

#[test]
fn index_into_resolved_column() {
    let mut wb = inventory();
    assert_eq!(num(&mut wb, "E1", "=INDEX(Inventory[Price],2)"), 20.0);
    assert_eq!(num(&mut wb, "E2", "=INDEX(Inventory[Price],3)"), 30.0);
}

#[test]
fn bare_reference_spills_column() {
    let mut wb = inventory();
    // `=Inventory[Price]` in value context materializes a 3x1 array and
    // spills down (design §5.3 value-context arm).
    assert!(wb.set_formula(0, "E1", "=Inventory[Price]"));
    assert!(matches!(wb.get_cell("Sheet1", "E1"), Value::Array(_) | Value::Number(_)));
    assert_eq!(wb.get_cell("Sheet1", "E2"), Value::Number(20.0));
    assert_eq!(wb.get_cell("Sheet1", "E3"), Value::Number(30.0));
}

// ===================== this-row (@) =====================

#[test]
fn this_row_qualified_outside_table_body() {
    let mut wb = inventory();
    // A `Table[@Col]` in column E (outside the table) picks the E-row's
    // intersection with the table's data column. Row 2 (the first data
    // row) → Price = C2 = 10; row 3 → Qty = B3 = 2; row 4 → Price = C4 = 30.
    assert_eq!(num(&mut wb, "E2", "=Inventory[@Price]"), 10.0);
    assert_eq!(num(&mut wb, "E3", "=Inventory[@Qty]"), 2.0);
    assert_eq!(num(&mut wb, "E4", "=Inventory[@Price]"), 30.0);
}

#[test]
fn this_row_outside_data_area_is_value_error() {
    let mut wb = inventory();
    // Row 1 is the header row — no data intersection → #VALUE!.
    assert_eq!(
        eval(&mut wb, "E1", "=Inventory[@Price]"),
        Value::Error(ValueError::InvalidValue)
    );
    // Row 9 is below the table → #VALUE!.
    assert_eq!(
        eval(&mut wb, "E9", "=Inventory[@Price]"),
        Value::Error(ValueError::InvalidValue)
    );
}

#[test]
fn table_less_this_row_inside_calculated_column() {
    // A small table with an in-body calculated column exercising the
    // table-less `[@Col]` form (table located from the current cell).
    let mut wb = Workbook::new();
    wb.set_cell(0, "A10", Value::Text("In".into()));
    wb.set_cell(0, "B10", Value::Text("Out".into()));
    wb.set_cell(0, "A11", Value::Number(5.0));
    wb.set_cell(0, "A12", Value::Number(7.0));
    wb.define_table(Some("Calc"), 0, rng(9, 0, 11, 1), true)
        .expect("define Calc");
    // B11/B12 sit inside the table; `[@In]` resolves via the containing
    // table to the same row's In column.
    assert!(wb.set_formula(0, "B11", "=[@In]*2"));
    assert!(wb.set_formula(0, "B12", "=[@In]*2"));
    assert_eq!(wb.get_cell("Sheet1", "B11"), Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B12"), Value::Number(14.0));
}

// ===================== cross-sheet =====================

#[test]
fn cross_sheet_structured_reference() {
    let mut wb = inventory();
    wb.add_sheet("Sheet2");
    // Table names are workbook-global — no sheet qualifier needed.
    assert!(wb.set_formula(1, "A1", "=SUM(Inventory[Qty])"));
    assert_eq!(wb.get_cell("Sheet2", "A1"), Value::Number(6.0));
}

// ===================== error surfaces =====================

#[test]
fn unknown_table_is_name_error() {
    let mut wb = inventory();
    assert_eq!(
        eval(&mut wb, "E1", "=SUM(Nope[Qty])"),
        Value::Error(ValueError::InvalidName)
    );
}

#[test]
fn unknown_column_is_ref_error() {
    let mut wb = inventory();
    assert_eq!(
        eval(&mut wb, "E1", "=SUM(Inventory[Missing])"),
        Value::Error(ValueError::InvalidRef)
    );
}

#[test]
fn column_match_is_case_insensitive() {
    let mut wb = inventory();
    assert_eq!(num(&mut wb, "E1", "=SUM(Inventory[qTy])"), 6.0);
}

// ===================== dependency tracking (cell content) =====================

#[test]
fn editing_a_table_cell_recomputes_dependent_reference() {
    let mut wb = inventory();
    assert!(wb.set_formula(0, "E1", "=SUM(Inventory[Qty])"));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(6.0));
    // Edit a cell inside the resolved range; the structured-reference
    // formula must re-derive because its range read registered a facade
    // edge on B3 (design §8: cell-content edges are free).
    wb.set_cell(0, "B3", Value::Number(20.0));
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(24.0));
}

// ===================== no regression on ordinary formulas =====================

#[test]
fn ordinary_formulas_still_work() {
    let mut wb = inventory();
    assert_eq!(num(&mut wb, "E1", "=B2+C2"), 11.0);
    assert_eq!(num(&mut wb, "E2", "=SUM(B2:C4)"), 66.0);
}
