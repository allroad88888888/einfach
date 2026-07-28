//! Round-trip tests for multi-criteria aggregates through a real Workbook.
//!
//! Each test seeds raw cell values, writes a formula in another cell, and
//! reads the formula's evaluated result through `Workbook::get_cell`. This
//! exercises the full path: parse → AST → eval (with the workbook's sparse
//! provider) → cached value.

use einfach_core::Value;
use einfach_excel_core::Workbook;

#[test]
fn countifs_and_sumifs_with_two_criteria_round_trip() {
    let mut wb = Workbook::new();
    // Seed A1:C5 with (name, amount, color).
    let rows: [(&str, f64, &str); 5] = [
        ("apple", 10.0, "red"),
        ("banana", 20.0, "yellow"),
        ("apricot", 30.0, "red"),
        ("cherry", 40.0, "red"),
        ("apple", 50.0, "green"),
    ];
    for (i, (name, n, color)) in rows.iter().enumerate() {
        let r = i + 1;
        wb.set_cell(0, &format!("A{}", r), Value::Text((*name).into()));
        wb.set_cell(0, &format!("B{}", r), Value::Number(*n));
        wb.set_cell(0, &format!("C{}", r), Value::Text((*color).into()));
    }

    // COUNTIFS: color=red AND amount >= 30  → rows 3, 4 → 2.
    wb.set_formula(0, "E1", "=COUNTIFS(C1:C5,\"red\",B1:B5,\">=30\")");
    assert_eq!(wb.get_cell("Sheet1", "E1"), Value::Number(2.0));

    // SUMIFS: sum amounts where color=red AND amount >= 30 → 30+40 = 70.
    wb.set_formula(0, "E2", "=SUMIFS(B1:B5,C1:C5,\"red\",B1:B5,\">=30\")");
    assert_eq!(wb.get_cell("Sheet1", "E2"), Value::Number(70.0));
}

#[test]
fn averageifs_maxifs_minifs_wildcard_round_trip() {
    let mut wb = Workbook::new();
    // A1:B5 — names + amounts, exercising the wildcard pattern "ap*".
    let rows: [(&str, f64); 5] = [
        ("apple", 10.0),
        ("banana", 20.0),
        ("apricot", 30.0),
        ("cherry", 40.0),
        ("apple", 50.0),
    ];
    for (i, (name, n)) in rows.iter().enumerate() {
        let r = i + 1;
        wb.set_cell(0, &format!("A{}", r), Value::Text((*name).into()));
        wb.set_cell(0, &format!("B{}", r), Value::Number(*n));
    }

    // AVERAGEIFS with wildcard: avg amount where name matches "ap*" →
    // (10+30+50)/3 = 30.
    wb.set_formula(0, "D1", "=AVERAGEIFS(B1:B5,A1:A5,\"ap*\")");
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(30.0));

    // MAXIFS with wildcard: max amount where name matches "ap*" → 50.
    wb.set_formula(0, "D2", "=MAXIFS(B1:B5,A1:A5,\"ap*\")");
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(50.0));

    // MINIFS with wildcard: min amount where name matches "ap*" → 10.
    wb.set_formula(0, "D3", "=MINIFS(B1:B5,A1:A5,\"ap*\")");
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Number(10.0));
}

#[test]
fn averageif_two_and_three_arg_forms_round_trip() {
    let mut wb = Workbook::new();
    // A1:A5 = 10, 20, 30, 40, 50.
    for i in 1..=5 {
        wb.set_cell(0, &format!("A{}", i), Value::Number((i as f64) * 10.0));
    }
    // B1:B5 = 1, 2, 3, 4, 5 — the "average_range" form.
    for i in 1..=5 {
        wb.set_cell(0, &format!("B{}", i), Value::Number(i as f64));
    }

    // Two-arg form: average A where A>=30 → (30+40+50)/3 = 40.
    wb.set_formula(0, "D1", "=AVERAGEIF(A1:A5,\">=30\")");
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(40.0));

    // Three-arg form: average B where A>=30 → (3+4+5)/3 = 4.
    wb.set_formula(0, "D2", "=AVERAGEIF(A1:A5,\">=30\",B1:B5)");
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(4.0));
}
