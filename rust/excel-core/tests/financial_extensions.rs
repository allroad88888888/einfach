//! Integration tests for the financial-formula batch.
//!
//! These drive `PMT / PV / FV / NPER / NPV / IRR / RATE / IPMT / PPMT`
//! through the public `Workbook` API — `set_cell`, `set_formula`, the
//! formula parser, and `WorkbookEvalProvider` — to confirm the same
//! math the inline `mod tests` covers is reachable end-to-end against a
//! real `Sheet`.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// 30-year-loan PMT / PV / FV cross-check.
///
/// rate = 0.005/month, nper = 360 months, pv = 200000 →
///   PMT ≈ -1199.10
///   PV (from PMT)    ≈ 200000
///   FV (after 360 payments at PMT) ≈ 0
#[test]
fn loan_pmt_pv_fv_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=PMT(0.005,360,200000)");
    wb.set_formula(0, "A2", "=PV(0.005,360,A1)");
    wb.set_formula(0, "A3", "=FV(0.005,360,A1,200000)");

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(approx_eq(n, -1199.10, 1e-2), "PMT = {}", n),
        other => panic!("PMT: {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 200000.0, 1e-4), "PV = {}", n),
        other => panic!("PV: {:?}", other),
    }
    match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => assert!(approx_eq(n, 0.0, 1e-4), "FV = {}", n),
        other => panic!("FV: {:?}", other),
    }
}

/// NPV / IRR over a column of cash flows in the workbook.
///
/// Flows column A: [-1000, 300, 400, 500] starting at A1.
/// NPV(0.1, A1:A4) discounts each flow by (1+r)^i with i starting at 1 →
///   -1000/1.1 + 300/1.21 + 400/1.331 + 500/1.4641 ≈ -19.124.
/// IRR(A1:A4) ≈ 8.896% — the rate that drives Σ value_i / (1+r)^i to 0
/// when the first flow is treated as i=0.
#[test]
fn npv_irr_over_cash_flow_column() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(-1000.0));
    wb.set_cell(0, "A2", Value::Number(300.0));
    wb.set_cell(0, "A3", Value::Number(400.0));
    wb.set_cell(0, "A4", Value::Number(500.0));
    wb.set_formula(0, "B1", "=NPV(0.1,A1:A4)");
    wb.set_formula(0, "B2", "=IRR(A1:A4)");

    match wb.get_cell("Sheet1", "B1") {
        Value::Number(n) => assert!(approx_eq(n, -19.124, 1e-2), "NPV = {}", n),
        other => panic!("NPV: {:?}", other),
    }
    match wb.get_cell("Sheet1", "B2") {
        Value::Number(n) => assert!(approx_eq(n, 0.08896, 1e-4), "IRR = {}", n),
        other => panic!("IRR: {:?}", other),
    }
}

/// IPMT + PPMT = PMT identity, period-by-period across a small loan.
///
/// rate = 0.05/year, nper = 5, pv = 10000. We verify IPMT + PPMT == PMT
/// for every period.
#[test]
fn ipmt_plus_ppmt_equals_pmt() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=PMT(0.05,5,10000)");
    for per in 1..=5u32 {
        let cell_i = format!("B{}", per);
        let cell_p = format!("C{}", per);
        let cell_s = format!("D{}", per);
        wb.set_formula(0, &cell_i, &format!("=IPMT(0.05,{},5,10000)", per));
        wb.set_formula(0, &cell_p, &format!("=PPMT(0.05,{},5,10000)", per));
        wb.set_formula(0, &cell_s, &format!("=B{}+C{}", per, per));
    }

    let pmt = match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => n,
        other => panic!("PMT: {:?}", other),
    };
    // PMT(0.05, 5, 10000) ≈ -2309.75.
    assert!(approx_eq(pmt, -2309.75, 1e-2), "PMT = {}", pmt);

    for per in 1..=5u32 {
        let cell_s = format!("D{}", per);
        match wb.get_cell("Sheet1", &cell_s) {
            Value::Number(n) => assert!(
                approx_eq(n, pmt, 1e-6),
                "IPMT({0}) + PPMT({0}) = {1}, expected PMT = {2}",
                per,
                n,
                pmt
            ),
            other => panic!("IPMT+PPMT at per={}: {:?}", per, other),
        }
    }
}
