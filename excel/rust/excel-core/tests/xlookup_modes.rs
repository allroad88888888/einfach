//! Integration tests for XLOOKUP's full match_mode / search_mode matrix.
//! Mirrors the unit tests in `eval.rs` but routes through a real `Workbook`
//! so we cover parse + dependency tracking + eval + cache.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Approximate-smaller (match_mode=-1) and approximate-larger (match_mode=1)
/// both work on an unsorted lookup array (modern XLOOKUP — unlike VLOOKUP's
/// approximate which requires a sorted array).
#[test]
fn xlookup_approximate_modes_round_trip() {
    let mut wb = Workbook::new();
    // Unsorted lookup row: A1=20 B1=10 C1=40 D1=30
    wb.set_cell(0, "A1", Value::Number(20.0));
    wb.set_cell(0, "B1", Value::Number(10.0));
    wb.set_cell(0, "C1", Value::Number(40.0));
    wb.set_cell(0, "D1", Value::Number(30.0));
    // Return row carries labels.
    wb.set_cell(0, "A2", Value::Text("twenty".into()));
    wb.set_cell(0, "B2", Value::Text("ten".into()));
    wb.set_cell(0, "C2", Value::Text("forty".into()));
    wb.set_cell(0, "D2", Value::Text("thirty".into()));

    // needle=25, exact-or-next-smaller → 20 → "twenty".
    wb.set_formula(0, "E1", "=XLOOKUP(25,A1:D1,A2:D2,\"none\",-1)");
    // needle=25, exact-or-next-larger → 30 → "thirty".
    wb.set_formula(0, "E2", "=XLOOKUP(25,A1:D1,A2:D2,\"none\",1)");
    // needle=5, next-smaller → nothing → fallback.
    wb.set_formula(0, "E3", "=XLOOKUP(5,A1:D1,A2:D2,\"none\",-1)");

    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Text("twenty".into()));
    assert_eq!(wb.get_cell("Sheet1", "E2"), Value::Text("thirty".into()));
    assert_eq!(wb.get_cell("Sheet1", "E3"), Value::Text("none".into()));
}

/// Wildcard (match_mode=2) walks lookup_array and returns the first text
/// cell whose representation matches the wildcard needle.
#[test]
fn xlookup_wildcard_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("apple".into()));
    wb.set_cell(0, "B1", Value::Text("banana".into()));
    wb.set_cell(0, "C1", Value::Text("blueberry".into()));
    wb.set_cell(0, "D1", Value::Text("cherry".into()));
    wb.set_cell(0, "A2", Value::Number(1.0));
    wb.set_cell(0, "B2", Value::Number(2.0));
    wb.set_cell(0, "C2", Value::Number(3.0));
    wb.set_cell(0, "D2", Value::Number(4.0));

    // "b*" matches "banana" first (forward) → 2.
    wb.set_formula(0, "E1", "=XLOOKUP(\"b*\",A1:D1,A2:D2,\"none\",2)");
    // "b*" reverse → matches "blueberry" → 3.
    wb.set_formula(0, "E2", "=XLOOKUP(\"b*\",A1:D1,A2:D2,\"none\",2,-1)");
    // "?pple" matches "apple".
    wb.set_formula(0, "E3", "=XLOOKUP(\"?pple\",A1:D1,A2:D2,\"none\",2)");
    // No match → fallback.
    wb.set_formula(0, "E4", "=XLOOKUP(\"z*\",A1:D1,A2:D2,\"none\",2)");

    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "E2"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "E3"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "E4"), Value::Text("none".into()));
}

/// Binary search ascending and descending both work, and compose with
/// approximate (next-smaller / next-larger).
#[test]
fn xlookup_binary_search_round_trip() {
    let mut wb = Workbook::new();
    // Ascending lookup row: A1=1 B1=5 C1=10 D1=20 E1=40
    for (col, v) in ["A1", "B1", "C1", "D1", "E1"]
        .iter()
        .zip([1, 5, 10, 20, 40])
    {
        wb.set_cell(0, col, Value::Number(v as f64));
    }
    // Return labels row 2.
    for (col, v) in ["A2", "B2", "C2", "D2", "E2"]
        .iter()
        .zip(["a", "b", "c", "d", "e"])
    {
        wb.set_cell(0, col, Value::Text(v.into()));
    }
    // Descending lookup row: A4=40 B4=20 C4=10 D4=5 E4=1, returns same a..e.
    for (col, v) in ["A4", "B4", "C4", "D4", "E4"]
        .iter()
        .zip([40, 20, 10, 5, 1])
    {
        wb.set_cell(0, col, Value::Number(v as f64));
    }
    for (col, v) in ["A5", "B5", "C5", "D5", "E5"]
        .iter()
        .zip(["a", "b", "c", "d", "e"])
    {
        wb.set_cell(0, col, Value::Text(v.into()));
    }

    // Ascending binary, exact 10 → "c".
    wb.set_formula(0, "G1", "=XLOOKUP(10,A1:E1,A2:E2,\"none\",0,2)");
    // Ascending binary, approximate next-smaller, needle 7 → 5 → "b".
    wb.set_formula(0, "G2", "=XLOOKUP(7,A1:E1,A2:E2,\"none\",-1,2)");
    // Ascending binary, approximate next-larger, needle 7 → 10 → "c".
    wb.set_formula(0, "G3", "=XLOOKUP(7,A1:E1,A2:E2,\"none\",1,2)");
    // Descending binary, exact 10 → "c".
    wb.set_formula(0, "G4", "=XLOOKUP(10,A4:E4,A5:E5,\"none\",0,-2)");
    // Descending binary, approximate next-smaller, needle 7 → 5 → "d".
    wb.set_formula(0, "G5", "=XLOOKUP(7,A4:E4,A5:E5,\"none\",-1,-2)");
    // Descending binary, approximate next-larger, needle 7 → 10 → "c".
    wb.set_formula(0, "G6", "=XLOOKUP(7,A4:E4,A5:E5,\"none\",1,-2)");

    assert_eq!(wb.get_cell("Sheet1", "G1"), Value::Text("c".into()));
    assert_eq!(wb.get_cell("Sheet1", "G2"), Value::Text("b".into()));
    assert_eq!(wb.get_cell("Sheet1", "G3"), Value::Text("c".into()));
    assert_eq!(wb.get_cell("Sheet1", "G4"), Value::Text("c".into()));
    assert_eq!(wb.get_cell("Sheet1", "G5"), Value::Text("d".into()));
    assert_eq!(wb.get_cell("Sheet1", "G6"), Value::Text("c".into()));
}
