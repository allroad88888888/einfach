// Physical sort × cross-sheet formula references. A vNext Worker demo smoke
// surfaced a #TYPE! after sorting that looked like a relocation bug; these
// controlled repros proved the engine is correct on both counts:
//  1. A relocated formula carrying a cross-sheet reference re-evaluates
//     correctly at its new slot (=Sheet2!C2+1 stays 13).
//  2. When the sort physically moves a NUMBER cell that a far, un-retargeted
//     absolute reference depends on (the demo's 3-hop chain through
//     Sheet1!B4), that reference correctly sees the new occupant and yields a
//     type error — Excel-identical propagation, not a sort defect.

use einfach_core::Value;
use einfach_excel_core::cell::CellAddress;
use einfach_excel_core::range::CellRange;
use einfach_excel_core::sort::{SortDirection, SortKey};
use einfach_excel_core::workbook::Workbook;

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).unwrap()
}
fn rng(a: &str, b: &str) -> CellRange {
    CellRange::new(addr(a), addr(b))
}
fn asc(col: u32) -> SortKey {
    SortKey {
        col,
        direction: SortDirection::Ascending,
        case_sensitive: false,
    }
}

#[test]
fn physical_sort_relocates_cross_sheet_formula_and_reevaluates() {
    let mut wb = Workbook::new();
    let s0 = wb.add_sheet("Sheet1");
    let s1 = wb.add_sheet("Sheet2");

    // Sheet2!C2 = 12 (the cross-sheet dependency the sorted formula reads).
    wb.set_cell(s1, "C2", Value::Number(12.0));

    // Sheet1 sortable column A (row 1 header) + a cross-sheet formula in C2.
    wb.set_cell(s0, "A1", Value::Text("hdr".into()));
    wb.set_cell(s0, "A2", Value::Number(3.0));
    wb.set_cell(s0, "A3", Value::Number(1.0));
    wb.set_cell(s0, "A4", Value::Number(2.0));
    assert!(wb.set_formula(s0, "C2", "=Sheet2!C2+1"));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(13.0), "seed C2");

    // Sort data rows (2..4) by column A ascending; row 1 is the header.
    let report = wb.sort_range(s0, rng("A2", "C4"), &[asc(0)], &[]).unwrap();
    // 3,1,2 ascending is a 3-cycle (row3→2, row4→3, row2→4): all move.
    assert_eq!(report.moved_rows, 3, "3,1,2 ascending is a 3-cycle");

    // Column A physically reordered 3,1,2 -> 1,2,3.
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(1.0), "A2");
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(2.0), "A3");
    assert_eq!(wb.get_cell("Sheet1", "A4"), Value::Number(3.0), "A4");

    // The A=3 row (which held C2's =Sheet2!C2+1) moved to row 4, so the
    // formula now lives at C4 and must STILL evaluate to 13.
    assert_eq!(
        wb.get_cell("Sheet1", "C4"),
        Value::Number(13.0),
        "relocated cross-sheet formula must re-evaluate to 13, not error",
    );
    // C2 (now the A=1 row) had no formula.
    assert_eq!(
        wb.get_cell("Sheet1", "C2"),
        Value::Null,
        "C2 empty after move"
    );
}

// The vNext Worker demo's actual seed is a 3-hop chain where a FAR formula
// (Sheet3!C2) holds an absolute reference to Sheet1!B4 — a cell INSIDE the
// sort range. Sorting physically swaps B4's number for text, so the far
// (un-retargeted, by design) reference correctly sees the new text occupant
// and yields #TYPE!, which propagates back. This documents that the demo's
// observed #TYPE! is CORRECT propagation, not a sort bug (task #20).
#[test]
fn physical_sort_moving_a_referenced_number_cell_propagates_type_error() {
    let mut wb = Workbook::new();
    let s0 = wb.add_sheet("Sheet1");
    let s1 = wb.add_sheet("Sheet2");
    let s2 = wb.add_sheet("Sheet3");

    // Chain: Sheet1!C2 -> Sheet2!C2 -> Sheet3!C2 -> Sheet1!B4 (=10).
    assert!(wb.set_formula(s0, "C2", "=Sheet2!C2+1"));
    assert!(wb.set_formula(s1, "C2", "=Sheet3!C2+1"));
    assert!(wb.set_formula(s2, "C2", "=Sheet1!B4+1"));

    wb.set_cell(s0, "A1", Value::Text("hdr".into()));
    wb.set_cell(s0, "A2", Value::Number(3.0));
    wb.set_cell(s0, "B2", Value::Text("result".into()));
    wb.set_cell(s0, "A3", Value::Number(1.0));
    wb.set_cell(s0, "A4", Value::Number(2.0));
    wb.set_cell(s0, "B4", Value::Number(10.0));
    wb.set_cell(s0, "C4", Value::Text("source".into()));

    // Seed: 10 -> 11 -> 12 -> 13.
    assert_eq!(
        wb.get_cell("Sheet1", "C2"),
        Value::Number(13.0),
        "seed chain = 13"
    );

    wb.sort_range(s0, rng("A2", "C4"), &[asc(0)], &[]).unwrap();

    // After the 3-cycle sort, Sheet1!B4 now holds the text "result" (moved
    // from B2). Sheet3!C2 = =Sheet1!B4+1 reads text+1 → #TYPE!, and the
    // whole chain (Sheet2!C2, then the relocated formula at Sheet1!C4)
    // resolves to the same type error. This is correct — the sort moved the
    // number out of B4 and the absolute reference was not retargeted.
    assert_eq!(
        wb.get_cell("Sheet1", "B4"),
        Value::Text("result".into()),
        "B4 now text"
    );
    assert!(
        matches!(wb.get_cell("Sheet3", "C2"), Value::Error(_)),
        "Sheet3!C2 = text+1 is a type error, got {:?}",
        wb.get_cell("Sheet3", "C2"),
    );
    assert!(
        matches!(wb.get_cell("Sheet1", "C4"), Value::Error(_)),
        "relocated Sheet1!C4 inherits the chain's type error, got {:?}",
        wb.get_cell("Sheet1", "C4"),
    );
}
