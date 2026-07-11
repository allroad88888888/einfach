//! Integration tests for the bond-depth + dollar-fraction formula batch.
//!
//! Covers: PRICE / YIELD / DURATION / MDURATION (coupon-bearing bonds),
//! PRICEDISC / YIELDDISC / PRICEMAT / YIELDMAT (non-coupon pricing),
//! DOLLARDE / DOLLARFR (fractional-notation conversion),
//! COUPDAYBS / COUPDAYS / COUPNUM (coupon-date arithmetic),
//! AMORDEGRC / AMORLINC (French depreciation).
//!
//! Each test drives the formula through the public `Workbook` API so we
//! confirm the same math the inline `mod tests` covers reaches end-to-end
//! against a real `Sheet` + `WorkbookEvalProvider`.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// PRICE/YIELD round-trip: feeding the price PRICE returns into YIELD
/// must recover the original yield (within the solver's tolerance).
#[test]
fn price_yield_round_trip_recovers_input_yield() {
    let mut wb = Workbook::new();
    // 5-year, semi-annual, 5% coupon, 6% market yield.
    wb.set_formula(
        0,
        "A1",
        "=PRICE(DATE(2020,1,1),DATE(2025,1,1),0.05,0.06,100,2,0)",
    );
    wb.set_formula(
        0,
        "A2",
        "=YIELD(DATE(2020,1,1),DATE(2025,1,1),0.05,A1,100,2,0)",
    );

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(p) => assert!(p > 90.0 && p < 100.0, "PRICE = {}", p),
        other => panic!("PRICE: {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(y) => assert!(approx_eq(y, 0.06, 1e-5), "YIELD = {}", y),
        other => panic!("YIELD: {:?}", other),
    }
}

/// MDURATION = DURATION / (1 + yld/freq). Verify the algebraic identity
/// holds end-to-end through the workbook.
#[test]
fn duration_mduration_identity() {
    let mut wb = Workbook::new();
    wb.set_formula(
        0,
        "A1",
        "=DURATION(DATE(2020,1,1),DATE(2025,1,1),0.05,0.06,2,0)",
    );
    wb.set_formula(
        0,
        "A2",
        "=MDURATION(DATE(2020,1,1),DATE(2025,1,1),0.05,0.06,2,0)",
    );
    wb.set_formula(0, "A3", "=A1/(1+0.06/2)");

    let mdur = match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => n,
        other => panic!("MDURATION: {:?}", other),
    };
    let predicted = match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => n,
        other => panic!("MDURATION predicted: {:?}", other),
    };
    assert!(
        approx_eq(mdur, predicted, 1e-9),
        "MDUR {} != DUR/(1+y/f) {}",
        mdur,
        predicted
    );
}

/// PRICEDISC / YIELDDISC are inverses for a discount bond.
#[test]
fn pricedisc_yielddisc_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(
        0,
        "A1",
        "=PRICEDISC(DATE(2020,1,1),DATE(2020,7,1),0.05,100,0)",
    );
    wb.set_formula(
        0,
        "A2",
        "=YIELDDISC(DATE(2020,1,1),DATE(2020,7,1),A1,100,0)",
    );

    let p = match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => n,
        other => panic!("PRICEDISC: {:?}", other),
    };
    let y = match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => n,
        other => panic!("YIELDDISC: {:?}", other),
    };
    // PRICEDISC: 100 * (1 - 0.05 * 0.5) = 97.5.
    assert!(approx_eq(p, 97.5, 1e-2), "PRICEDISC = {}", p);
    // YIELDDISC of 97.5 → 100 over 0.5y = (2.5 / 97.5) / 0.5 ≈ 0.05128.
    let expected = (100.0 - 97.5) / 97.5 / 0.5;
    assert!(approx_eq(y, expected, 1e-7), "YIELDDISC = {}", y);
}

/// PRICEMAT / YIELDMAT round-trip via closed-form inverse.
#[test]
fn pricemat_yieldmat_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(
        0,
        "A1",
        "=PRICEMAT(DATE(2020,1,1),DATE(2021,1,1),DATE(2019,1,1),0.05,0.06,0)",
    );
    wb.set_formula(
        0,
        "A2",
        "=YIELDMAT(DATE(2020,1,1),DATE(2021,1,1),DATE(2019,1,1),0.05,A1,0)",
    );

    match wb.get_cell("Sheet1", "A2") {
        Value::Number(y) => assert!(approx_eq(y, 0.06, 1e-7), "YIELDMAT round-trip = {}", y),
        other => panic!("YIELDMAT: {:?}", other),
    }
}

/// DOLLARDE / DOLLARFR are exact inverses. Use a fractional price of
/// 1.10 with 16ths: DOLLARDE = 1.625, DOLLARFR back to 1.10.
#[test]
fn dollarde_dollarfr_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=DOLLARDE(1.1,16)");
    wb.set_formula(0, "A2", "=DOLLARFR(A1,16)");

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(approx_eq(n, 1.625, 1e-9), "DOLLARDE = {}", n),
        other => panic!("DOLLARDE: {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 1.1, 1e-9), "DOLLARFR = {}", n),
        other => panic!("DOLLARFR: {:?}", other),
    }
}

/// COUPNUM + COUPDAYS + COUPDAYBS sanity: a 5-year semi-annual bond
/// settled on the coupon boundary has 10 coupons, 180-day basis-0
/// period, and 0 days since previous coupon.
#[test]
fn coupon_date_arithmetic_at_coupon_boundary() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COUPNUM(DATE(2020,1,1),DATE(2025,1,1),2,0)");
    wb.set_formula(0, "A2", "=COUPDAYS(DATE(2020,1,1),DATE(2025,1,1),2,0)");
    wb.set_formula(0, "A3", "=COUPDAYBS(DATE(2020,1,1),DATE(2025,1,1),2,0)");

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(approx_eq(n, 10.0, 1e-9), "COUPNUM = {}", n),
        other => panic!("COUPNUM: {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 180.0, 1e-9), "COUPDAYS = {}", n),
        other => panic!("COUPDAYS: {:?}", other),
    }
    match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => assert!(approx_eq(n, 0.0, 1e-9), "COUPDAYBS = {}", n),
        other => panic!("COUPDAYBS: {:?}", other),
    }
}

/// AMORLINC vs AMORDEGRC: degressive depreciation should write off
/// more in the first period than the linear variant on a long-life
/// asset (where the coefficient is 2.5).
#[test]
fn amordegrc_more_aggressive_than_amorlinc_in_first_period() {
    let mut wb = Workbook::new();
    // Life = 1/0.10 = 10 → coef 2.5.
    wb.set_formula(
        0,
        "A1",
        "=AMORDEGRC(10000,DATE(2020,1,1),DATE(2020,12,31),1000,0,0.1,1)",
    );
    wb.set_formula(
        0,
        "A2",
        "=AMORLINC(10000,DATE(2020,1,1),DATE(2020,12,31),1000,0,0.1,1)",
    );

    let degrc = match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => n,
        other => panic!("AMORDEGRC: {:?}", other),
    };
    let linc = match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => n,
        other => panic!("AMORLINC: {:?}", other),
    };
    assert!(degrc > linc, "AMORDEGRC ({}) <= AMORLINC ({})", degrc, linc);
    // Both should be positive and bounded by cost.
    assert!(degrc > 0.0 && degrc <= 10000.0);
    assert!(linc > 0.0 && linc <= 10000.0);
}
