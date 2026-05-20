//! Integration tests for the second wave of date/time formulas
//! (NETWORKDAYS, NETWORKDAYS.INTL, WORKDAY, WORKDAY.INTL, ISOWEEKNUM)
//! round-tripping through a real `Workbook` instance — so parse, eval,
//! and the value cache are all exercised, not just the inline match
//! arms in `eval.rs`.
//!
//! Epoch reminder: serials here are 1970-01-01 = 0 (Unix-style), not
//! Excel's 1900 epoch (see TODO(excel-1900-epoch) on `date_serial`).
//! Tests therefore build expected serials with `DATE()` formulas
//! rather than hard-coding numbers.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// NETWORKDAYS counts Mon..Fri (default weekend) inclusive on both
/// ends and subtracts holidays that fall on workdays.
#[test]
fn networkdays_with_holidays_round_trip() {
    let mut wb = Workbook::new();
    // Mon 2024-01-01 .. Fri 2024-01-12 = 10 weekdays.
    wb.set_formula(0, "A1", "=DATE(2024,1,1)");
    wb.set_formula(0, "A2", "=DATE(2024,1,12)");
    // Three holidays: Wed 2024-01-03 (workday), Thu 2024-01-04 (workday),
    // Sat 2024-01-06 (already weekend, should not double-count).
    wb.set_formula(0, "C1", "=DATE(2024,1,3)");
    wb.set_formula(0, "C2", "=DATE(2024,1,4)");
    wb.set_formula(0, "C3", "=DATE(2024,1,6)");
    wb.set_formula(0, "B1", "=NETWORKDAYS(A1,A2)");
    wb.set_formula(0, "B2", "=NETWORKDAYS(A1,A2,C1:C3)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
    // 10 - 2 workday-holidays = 8 (Sat 2024-01-06 collapses).
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(8.0));
}

/// WORKDAY and WORKDAY.INTL respect both weekend and holidays when
/// advancing. With Fri+Sat weekend (code 7), Sunday becomes a
/// workday — verify directly against a DATE() target.
#[test]
fn workday_intl_skips_holiday_on_landing_day() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=DATE(2024,1,1)"); // Mon
    // Default weekend: Mon + 5 → next Mon.
    wb.set_formula(0, "B1", "=WORKDAY(A1,5)");
    wb.set_formula(0, "B2", "=DATE(2024,1,8)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), wb.get_cell("Sheet1", "B2"));

    // Code 7 (Fri+Sat) + holiday on Sun 2024-01-07 — step lands on
    // Sun originally, must advance to Mon 2024-01-08.
    wb.set_formula(0, "C1", "=DATE(2024,1,7)");
    wb.set_formula(0, "D1", "=WORKDAY.INTL(A1,4,7,C1)");
    wb.set_formula(0, "D2", "=DATE(2024,1,8)");
    assert_eq!(wb.get_cell("Sheet1", "D1"), wb.get_cell("Sheet1", "D2"));
}

/// ISOWEEKNUM resolves year-boundary cases correctly when round-tripped
/// through DATE().
#[test]
fn isoweeknum_year_boundary_round_trip() {
    let mut wb = Workbook::new();
    // 2021-01-01 (Fri) is in ISO 2020-W53.
    wb.set_formula(0, "A1", "=ISOWEEKNUM(DATE(2021,1,1))");
    // 2024-12-31 (Tue) is in ISO 2025-W01.
    wb.set_formula(0, "A2", "=ISOWEEKNUM(DATE(2024,12,31))");
    // 2024-01-01 (Mon) is in ISO 2024-W01.
    wb.set_formula(0, "A3", "=ISOWEEKNUM(DATE(2024,1,1))");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(53.0));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(1.0));
}
