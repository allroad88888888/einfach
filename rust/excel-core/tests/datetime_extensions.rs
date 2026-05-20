//! Integration tests for the new date/time formula expansion, round-tripping
//! through a real `Workbook` instance so the parse + eval + cache pipeline is
//! exercised (not just the inline match arms in `eval.rs`).
//!
//! Epoch reminder: this codebase uses 1970-01-01 = serial 0 (Unix-style), not
//! Excel's 1900 epoch. Tests that need a known serial therefore build the
//! expected value via a DATE() formula on the workbook itself.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// HOUR / MINUTE / SECOND round-trip through TIME() in a real workbook.
#[test]
fn hour_minute_second_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=TIME(13,30,45)");
    wb.set_formula(0, "B1", "=HOUR(A1)");
    wb.set_formula(0, "B2", "=MINUTE(A1)");
    wb.set_formula(0, "B3", "=SECOND(A1)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(13.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(30.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(45.0));
}

/// EDATE clamp + EOMONTH chain — Jan 31 + 1 month must clamp to Feb 29 in
/// leap year 2020, and EOMONTH on the original Jan 31 must agree.
#[test]
fn edate_eomonth_leap_year_clamp_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=DATE(2020,1,31)");
    wb.set_formula(0, "B1", "=EDATE(A1,1)");
    wb.set_formula(0, "B2", "=EOMONTH(A1,1)");
    // Both should land on 2020-02-29 (serial-wise equal).
    let expected = wb.get_cell("Sheet1", "B2");
    assert_eq!(wb.get_cell("Sheet1", "B1"), expected);
    // Sanity: that expected matches a manually-built DATE(2020,2,29).
    wb.set_formula(0, "C1", "=DATE(2020,2,29)");
    assert_eq!(expected, wb.get_cell("Sheet1", "C1"));
}

/// DATEVALUE + DAYS + DATEDIF compose to count a known leap year.
#[test]
fn datevalue_days_datedif_year_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=DATEVALUE(\"2020-01-01\")");
    wb.set_formula(0, "A2", "=DATEVALUE(\"2021-01-01\")");
    wb.set_formula(0, "B1", "=DAYS(A2,A1)");
    wb.set_formula(0, "B2", "=DATEDIF(A1,A2,\"D\")");
    wb.set_formula(0, "B3", "=DATEDIF(A1,A2,\"Y\")");
    // 2020 is a leap year — 366 days.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(366.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(366.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(1.0));
}
