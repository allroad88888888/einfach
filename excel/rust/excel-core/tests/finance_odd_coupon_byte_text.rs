//! Integration tests for the R batch — odd-coupon bond pricing/yield
//! (ODDFPRICE / ODDFYIELD / ODDLPRICE / ODDLYIELD), coupon-date utilities
//! (COUPNCD / COUPPCD / COUPDAYSNC), misc finance (PDURATION / RRI /
//! FVSCHEDULE), and CJK byte-aware text (LENB / LEFTB / RIGHTB / MIDB /
//! FINDB / SEARCHB / REPLACEB).
//!
//! These exercise the same code paths as the inline `mod tests` block in
//! `eval.rs`, but through the `Workbook` API so we cover the parser +
//! cache + provider pipeline end-to-end.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// ODDFPRICE / ODDFYIELD round-trip through a Workbook. Short odd first
/// period (issue exactly one period before first_coupon) at par yield
/// returns ~100 from PRICE, then YIELD inverts back to the par yield.
#[test]
fn oddf_price_yield_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(
        0,
        "A1",
        "=ODDFPRICE(DATE(2020,7,1),DATE(2025,7,1),DATE(2020,1,1),DATE(2021,1,1),0.05,0.07,100,2,0)",
    );
    wb.set_formula(
        0,
        "A2",
        "=ODDFYIELD(DATE(2020,7,1),DATE(2025,7,1),DATE(2020,1,1),DATE(2021,1,1),0.05,A1,100,2,0)",
    );
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 0.07, 1e-3), "ODDFYIELD inversion = {}", n),
        other => panic!("ODDFYIELD: {:?}", other),
    }
}

/// ODDLPRICE / ODDLYIELD round-trip. ODDLYIELD has a closed-form
/// solution (no iteration) so the round-trip should be tighter than the
/// odd-first-period case.
#[test]
fn oddl_price_yield_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(
        0,
        "A1",
        "=ODDLPRICE(DATE(2024,7,1),DATE(2025,1,1),DATE(2024,1,1),0.05,0.06,100,2,0)",
    );
    wb.set_formula(
        0,
        "A2",
        "=ODDLYIELD(DATE(2024,7,1),DATE(2025,1,1),DATE(2024,1,1),0.05,A1,100,2,0)",
    );
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 0.06, 1e-4), "ODDLYIELD inversion = {}", n),
        other => panic!("ODDLYIELD: {:?}", other),
    }
}

/// COUPNCD / COUPPCD bracket the settlement date: PCD ≤ settlement < NCD.
#[test]
fn coupncd_couppcd_bracket_settlement() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COUPPCD(DATE(2024,4,1),DATE(2025,1,1),2,0)");
    wb.set_formula(0, "A2", "=COUPNCD(DATE(2024,4,1),DATE(2025,1,1),2,0)");
    wb.set_formula(0, "A3", "=DATE(2024,4,1)");
    let pcd = match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => n,
        other => panic!("COUPPCD: {:?}", other),
    };
    let ncd = match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => n,
        other => panic!("COUPNCD: {:?}", other),
    };
    let settle = match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => n,
        other => panic!("DATE: {:?}", other),
    };
    assert!(pcd <= settle, "PCD {} should be ≤ settle {}", pcd, settle);
    assert!(ncd > settle, "NCD {} should be > settle {}", ncd, settle);
}

/// COUPDAYSNC + COUPDAYBS should approximately equal COUPDAYS for the
/// same settlement / maturity / frequency / basis tuple. The relation
/// is exact for basis 1 (actual/actual); for canonical bases (0/2/4)
/// the engine uses a real day count for COUPDAYBS and a canonical
/// half-period for COUPDAYSNC at basis 0, so the sum may overshoot E
/// by a day or two. We allow ±2 days of slack.
#[test]
fn coupdaysnc_plus_coupdaybs_close_to_coupdays() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COUPDAYBS(DATE(2024,4,1),DATE(2025,1,1),2,1)");
    wb.set_formula(0, "A2", "=COUPDAYSNC(DATE(2024,4,1),DATE(2025,1,1),2,1)");
    wb.set_formula(0, "A3", "=COUPDAYS(DATE(2024,4,1),DATE(2025,1,1),2,1)");
    let a = match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => n,
        other => panic!("COUPDAYBS: {:?}", other),
    };
    let dsc = match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => n,
        other => panic!("COUPDAYSNC: {:?}", other),
    };
    let e = match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => n,
        other => panic!("COUPDAYS: {:?}", other),
    };
    // basis 1 (actual/actual): COUPDAYBS + COUPDAYSNC == COUPDAYS exactly
    // because both sides use real day counts.
    assert!((a + dsc - e).abs() < 1e-6, "{} + {} != {}", a, dsc, e);
}

/// PDURATION and RRI round-trip: RRI(PDURATION(rate, pv, fv), pv, fv) ≈ rate.
#[test]
fn pduration_rri_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=PDURATION(0.05,1000,2000)");
    wb.set_formula(0, "A2", "=RRI(A1,1000,2000)");
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 0.05, 1e-6), "RRI round-trip = {}", n),
        other => panic!("RRI: {:?}", other),
    }
}

/// FVSCHEDULE over a column of rates in the workbook.
#[test]
fn fvschedule_over_rates_column() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(0.05));
    wb.set_cell(0, "A2", Value::Number(0.06));
    wb.set_cell(0, "A3", Value::Number(0.07));
    wb.set_formula(0, "B1", "=FVSCHEDULE(1000,A1:A3)");
    // 1000 * 1.05 * 1.06 * 1.07 = 1190.91.
    match wb.get_cell("Sheet1", "B1") {
        Value::Number(n) => assert!(approx_eq(n, 1190.91, 1e-2), "FVSCHEDULE = {}", n),
        other => panic!("FVSCHEDULE: {:?}", other),
    }
}

/// LENB / LEFTB / RIGHTB / MIDB on a mixed ASCII + Japanese string.
/// "abcあいう" → 3 ASCII bytes + 3 CJK chars × 2 bytes = 9 bytes total.
#[test]
fn dbcs_length_slice_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("abcあいう".into()));
    wb.set_formula(0, "B1", "=LENB(A1)");
    wb.set_formula(0, "B2", "=LEFTB(A1, 4)"); // "abc" + half of あ → "abc "
    wb.set_formula(0, "B3", "=RIGHTB(A1, 4)"); // 2 full CJK chars: "いう"
    wb.set_formula(0, "B4", "=MIDB(A1, 4, 4)"); // bytes 4..=7 → "あい"

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(9.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("abc ".into()));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Text("いう".into()));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Text("あい".into()));
}

/// FINDB / SEARCHB byte positions. "abcあい": "あ" starts at byte 4; "ABC"
/// case-insensitive match starts at byte 1.
#[test]
fn dbcs_findb_searchb_byte_positions() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("abcあい".into()));
    wb.set_formula(0, "B1", "=FINDB(\"あ\", A1)");
    wb.set_formula(0, "B2", "=SEARCHB(\"ABC\", A1)");
    wb.set_formula(0, "B3", "=FINDB(\"X\", A1)");

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(1.0));
    // FINDB returns #VALUE! when not found.
    match wb.get_cell("Sheet1", "B3") {
        Value::Error(_) => {} // expected
        other => panic!("FINDB miss expected #VALUE!, got {:?}", other),
    }
}

/// REPLACEB byte-aware replace; "abcあい", replace bytes 2..=3 ("bc")
/// with "XY" → "aXYあい".
#[test]
fn dbcs_replaceb_clean() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("abcあい".into()));
    wb.set_formula(0, "B1", "=REPLACEB(A1, 2, 2, \"XY\")");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("aXYあい".into()));
}
