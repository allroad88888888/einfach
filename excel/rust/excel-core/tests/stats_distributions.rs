//! Integration tests for the statistical-distribution family.
//!
//! Each function is also exercised by the inline `mod tests` in
//! `src/eval.rs`; here we drive a representative subset through the
//! `Workbook` → formula parser → `WorkbookEvalProvider` pipeline so the
//! full eval-by-name path stays in working order.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

fn num(wb: &Workbook, addr: &str) -> f64 {
    match wb.get_cell("Sheet1", addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {}, got {:?}", addr, other),
    }
}

/// NORM.DIST/INV round-trip through the Workbook.
#[test]
fn stats_norm_dist_inv_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=NORM.DIST(0, 0, 1, TRUE)"); // CDF(0) of N(0,1) = 0.5
    wb.set_formula(0, "A2", "=NORM.S.DIST(0, TRUE)"); // same
    wb.set_formula(0, "A3", "=NORM.S.INV(0.5)"); // 0
    wb.set_formula(0, "A4", "=NORM.INV(0.5, 5, 2)"); // 5

    assert!(approx_eq(num(&wb, "A1"), 0.5, 1e-9));
    assert!(approx_eq(num(&wb, "A2"), 0.5, 1e-9));
    assert!(approx_eq(num(&wb, "A3"), 0.0, 1e-6));
    assert!(approx_eq(num(&wb, "A4"), 5.0, 1e-6));
}

/// Binomial PMF and CDF.
#[test]
fn stats_binom_dist_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=BINOM.DIST(2, 10, 0.5, FALSE)"); // C(10,2)/2^10
    wb.set_formula(0, "A2", "=BINOM.DIST(10, 10, 0.5, TRUE)"); // 1
    wb.set_formula(0, "A3", "=BINOM.INV(10, 0.5, 0.5)"); // 5

    assert!(approx_eq(num(&wb, "A1"), 45.0 / 1024.0, 1e-9));
    assert!(approx_eq(num(&wb, "A2"), 1.0, 1e-9));
    assert!(approx_eq(num(&wb, "A3"), 5.0, 1e-9));
}

/// Poisson, hypergeometric and chi-squared in one shot.
#[test]
fn stats_poisson_hypgeom_chisq_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=POISSON.DIST(0, 2, FALSE)"); // e^-2
    wb.set_formula(0, "A2", "=HYPGEOM.DIST(2, 5, 6, 20, FALSE)"); // C(6,2)*C(14,3)/C(20,5)
    wb.set_formula(0, "A3", "=CHISQ.DIST.RT(3, 5)");
    wb.set_formula(0, "A4", "=CHISQ.DIST(3, 5, TRUE)");

    assert!(approx_eq(num(&wb, "A1"), (-2.0_f64).exp(), 1e-9));
    assert!(approx_eq(num(&wb, "A2"), 15.0 * 364.0 / 15504.0, 1e-9));
    // CDF + RT = 1.
    assert!(approx_eq(num(&wb, "A3") + num(&wb, "A4"), 1.0, 1e-9));
}

/// Domain-violation propagation: argument is bad → `#NUM!` lands in the
/// cell exactly the same way as any other formula error.
#[test]
fn stats_domain_violations_become_num_in_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=NORM.DIST(0, 0, 0, TRUE)"); // sd=0
    wb.set_formula(0, "A2", "=T.DIST(0, 0, TRUE)"); // df=0
    wb.set_formula(0, "A3", "=GEOMEAN(1, -1, 2)"); // negative input

    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::Overflow)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "A2"),
        Value::Error(ValueError::Overflow)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "A3"),
        Value::Error(ValueError::Overflow)
    );
}

/// Special functions: GAMMA / GAMMALN / ERF / ERFC.
#[test]
fn stats_special_functions_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=GAMMA(5)"); // 24
    wb.set_formula(0, "A2", "=GAMMA(0.5)"); // sqrt(π)
    wb.set_formula(0, "A3", "=GAMMALN(5)"); // ln(24)
    wb.set_formula(0, "A4", "=ERF(1)"); // 0.8427...
    wb.set_formula(0, "A5", "=ERFC(1)"); // 1 - erf(1)

    assert!(approx_eq(num(&wb, "A1"), 24.0, 1e-9));
    assert!(approx_eq(num(&wb, "A2"), std::f64::consts::PI.sqrt(), 1e-9));
    assert!(approx_eq(num(&wb, "A3"), 24.0_f64.ln(), 1e-9));
    assert!(approx_eq(num(&wb, "A4"), 0.842_700_792_949_715, 1e-6));
    assert!(approx_eq(num(&wb, "A5"), 1.0 - 0.842_700_792_949_715, 1e-6));
}

/// Sample-stat helpers driven by a real range.
#[test]
fn stats_sample_helpers_over_range_through_workbook() {
    let mut wb = Workbook::new();
    // A1..A5 = 1, 2, 3, 4, 5 — symmetric, mean=3, var=2.5, sd=sqrt(2.5).
    for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    wb.set_formula(0, "B1", "=AVEDEV(A1:A5)"); // mean abs dev = 1.2
    wb.set_formula(0, "B2", "=DEVSQ(A1:A5)"); // sum sq dev = 10
    wb.set_formula(0, "B3", "=GEOMEAN(A1:A5)"); // (1*2*3*4*5)^(1/5) = 120^(1/5)
    wb.set_formula(0, "B4", "=HARMEAN(A1:A5)"); // 5 / (1 + 1/2 + 1/3 + 1/4 + 1/5)
    wb.set_formula(0, "B5", "=SKEW(A1:A5)"); // 0 (symmetric)
    wb.set_formula(0, "B6", "=KURT(A1:A5)"); // -1.2 (uniform/triangular-ish)
    wb.set_formula(0, "B7", "=STANDARDIZE(4, 3, 2)"); // 0.5
    wb.set_formula(0, "B8", "=FISHER(0)"); // 0

    assert!(approx_eq(num(&wb, "B1"), 1.2, 1e-9));
    assert!(approx_eq(num(&wb, "B2"), 10.0, 1e-9));
    assert!(approx_eq(num(&wb, "B3"), 120.0_f64.powf(0.2), 1e-9));
    assert!(approx_eq(
        num(&wb, "B4"),
        5.0 / (1.0 + 1.0 / 2.0 + 1.0 / 3.0 + 1.0 / 4.0 + 1.0 / 5.0),
        1e-9
    ));
    assert!(approx_eq(num(&wb, "B5"), 0.0, 1e-9));
    assert!(approx_eq(num(&wb, "B6"), -1.2, 1e-9));
    assert!(approx_eq(num(&wb, "B7"), 0.5, 1e-9));
    assert!(approx_eq(num(&wb, "B8"), 0.0, 1e-9));
}

/// TRIMMEAN against a real range.
#[test]
fn stats_trimmean_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in (1..=10).enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(n as f64));
    }
    // n=10, percent=0.2 → trim_total=2 → trim_each=1 → mean of 2..9 = 5.5.
    wb.set_formula(0, "B1", "=TRIMMEAN(A1:A10, 0.2)");
    // n=10, percent=0.0 → no trimming → mean = 5.5.
    wb.set_formula(0, "B2", "=TRIMMEAN(A1:A10, 0)");

    assert!(approx_eq(num(&wb, "B1"), 5.5, 1e-9));
    assert!(approx_eq(num(&wb, "B2"), 5.5, 1e-9));
}

/// Fisher / FisherInv round-trip via cells.
#[test]
fn stats_fisher_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(0.5));
    wb.set_formula(0, "B1", "=FISHER(A1)");
    wb.set_formula(0, "C1", "=FISHERINV(B1)");

    let original = num(&wb, "A1");
    let round = num(&wb, "C1");
    assert!(approx_eq(original, round, 1e-9));
}

/// Error propagation through statistical functions: if the input cell
/// holds `#DIV/0!`, that error must bubble through into the dependent.
#[test]
fn stats_error_propagation_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=1/0"); // DivisionByZero
    wb.set_formula(0, "B1", "=NORM.DIST(A1, 0, 1, TRUE)");

    assert!(matches!(
        wb.get_cell("Sheet1", "B1"),
        Value::Error(ValueError::DivisionByZero)
    ));
}
