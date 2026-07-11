//! Integration tests for the legacy (Excel pre-2010) statistical
//! function aliases.
//!
//! Each alias is also covered by inline tests in `src/eval.rs`. This
//! file drives a representative slice through the full
//! `Workbook` → formula parser → `WorkbookEvalProvider` pipeline so the
//! legacy names stay wired up end-to-end (no parser regression hides
//! the new arms from real workbooks).

use einfach_core::Value;
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

/// Each legacy alias agrees with its canonical Excel-365 sibling.
#[test]
fn legacy_aliases_match_canonical_through_workbook() {
    let mut wb = Workbook::new();
    // Each row pairs a legacy name with the canonical equivalent (and we
    // assert the difference is ≈ 0 in the test).
    wb.set_formula(0, "A1", "=NORMDIST(0, 0, 1, TRUE)");
    wb.set_formula(0, "B1", "=NORM.DIST(0, 0, 1, TRUE)");
    wb.set_formula(0, "A2", "=NORMINV(0.5, 5, 2)");
    wb.set_formula(0, "B2", "=NORM.INV(0.5, 5, 2)");
    wb.set_formula(0, "A3", "=NORMSDIST(0)");
    wb.set_formula(0, "B3", "=NORM.S.DIST(0, TRUE)");
    wb.set_formula(0, "A4", "=NORMSINV(0.5)");
    wb.set_formula(0, "B4", "=NORM.S.INV(0.5)");
    wb.set_formula(0, "A5", "=BINOMDIST(2, 10, 0.5, FALSE)");
    wb.set_formula(0, "B5", "=BINOM.DIST(2, 10, 0.5, FALSE)");
    wb.set_formula(0, "A6", "=CRITBINOM(10, 0.5, 0.5)");
    wb.set_formula(0, "B6", "=BINOM.INV(10, 0.5, 0.5)");
    wb.set_formula(0, "A7", "=POISSON(0, 2, FALSE)");
    wb.set_formula(0, "B7", "=POISSON.DIST(0, 2, FALSE)");
    wb.set_formula(0, "A8", "=EXPONDIST(1, 1, TRUE)");
    wb.set_formula(0, "B8", "=EXPON.DIST(1, 1, TRUE)");
    wb.set_formula(0, "A9", "=WEIBULL(2, 3, 2, TRUE)");
    wb.set_formula(0, "B9", "=WEIBULL.DIST(2, 3, 2, TRUE)");
    wb.set_formula(0, "A10", "=GAMMADIST(1, 1, 1, TRUE)");
    wb.set_formula(0, "B10", "=GAMMA.DIST(1, 1, 1, TRUE)");
    wb.set_formula(0, "A11", "=GAMMAINV(0.5, 1, 1)");
    wb.set_formula(0, "B11", "=GAMMA.INV(0.5, 1, 1)");
    wb.set_formula(0, "A12", "=FDIST(2, 5, 10)");
    wb.set_formula(0, "B12", "=F.DIST.RT(2, 5, 10)");
    wb.set_formula(0, "A13", "=FINV(0.5, 5, 10)");
    wb.set_formula(0, "B13", "=F.INV.RT(0.5, 5, 10)");
    wb.set_formula(0, "A14", "=CHIDIST(3, 5)");
    wb.set_formula(0, "B14", "=CHISQ.DIST.RT(3, 5)");
    wb.set_formula(0, "A15", "=CHIINV(0.5, 5)");
    wb.set_formula(0, "B15", "=CHISQ.INV.RT(0.5, 5)");
    wb.set_formula(0, "A16", "=TINV(0.5, 10)");
    wb.set_formula(0, "B16", "=T.INV.2T(0.5, 10)");
    wb.set_formula(0, "A17", "=BETADIST(0.25, 1, 1)");
    wb.set_formula(0, "B17", "=BETA.DIST(0.25, 1, 1, TRUE)");
    wb.set_formula(0, "A18", "=BETAINV(0.5, 1, 1)");
    wb.set_formula(0, "B18", "=BETA.INV(0.5, 1, 1)");

    for row in 1..=18 {
        let a = num(&wb, &format!("A{}", row));
        let b = num(&wb, &format!("B{}", row));
        assert!(
            approx_eq(a, b, 1e-9),
            "row {}: legacy {} vs canonical {}",
            row,
            a,
            b
        );
    }
}

/// Functions with non-trivial wrappers (different signature shape than
/// the canonical version) still produce sensible numbers.
#[test]
fn legacy_wrappers_with_signature_drift_through_workbook() {
    let mut wb = Workbook::new();
    // TDIST takes a `tails` switch (1 or 2) instead of cumulative.
    wb.set_formula(0, "A1", "=TDIST(0, 10, 1)"); // right tail at 0 = 0.5
    wb.set_formula(0, "A2", "=TDIST(0, 10, 2)"); // two tail at 0 = 1.0
                                                 // NORMSDIST is single-arg (always cumulative).
    wb.set_formula(0, "A3", "=NORMSDIST(0)"); // 0.5
                                              // HYPGEOMDIST is 4-arg (no cumulative, always PMF).
    wb.set_formula(0, "A4", "=HYPGEOMDIST(2, 5, 6, 20)");
    // NEGBINOMDIST is 3-arg (no cumulative).
    wb.set_formula(0, "A5", "=NEGBINOMDIST(0, 1, 0.5)"); // 0.5
                                                         // LOGNORMDIST is 3-arg cumulative-only.
    wb.set_formula(0, "A6", "=LOGNORMDIST(EXP(1), 1, 0.5)"); // 0.5

    assert!(approx_eq(num(&wb, "A1"), 0.5, 1e-9));
    assert!(approx_eq(num(&wb, "A2"), 1.0, 1e-9));
    assert!(approx_eq(num(&wb, "A3"), 0.5, 1e-9));
    assert!(approx_eq(num(&wb, "A4"), 15.0 * 364.0 / 15504.0, 1e-9));
    assert!(approx_eq(num(&wb, "A5"), 0.5, 1e-9));
    assert!(approx_eq(num(&wb, "A6"), 0.5, 1e-6));
}

/// CONFIDENCE / CONFIDENCE.NORM share a single arm and route the same
/// computation `z * stdev / sqrt(n)`.
#[test]
fn confidence_and_norm_alias_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=CONFIDENCE(0.05, 2.5, 50)");
    wb.set_formula(0, "A2", "=CONFIDENCE.NORM(0.05, 2.5, 50)");

    let a = num(&wb, "A1");
    let b = num(&wb, "A2");
    assert!(approx_eq(a, b, 1e-12));
    assert!(approx_eq(a, 0.692_952, 1e-4));
}

/// The four hypothesis tests work over real ranges through the
/// workbook. We don't pin the exact P-values (they're verified inline);
/// just confirm the eval path reaches the new arms.
#[test]
fn hypothesis_tests_through_workbook() {
    let mut wb = Workbook::new();
    // Two columns of paired-ish data.
    wb.set_formula(0, "A1", "=1"); // dummy formula path
    wb.set_formula(0, "A2", "=2");
    wb.set_formula(0, "A3", "=3");
    wb.set_formula(0, "A4", "=4");
    wb.set_formula(0, "A5", "=5");
    wb.set_formula(0, "B1", "=2");
    wb.set_formula(0, "B2", "=4");
    wb.set_formula(0, "B3", "=5");
    wb.set_formula(0, "B4", "=7");
    wb.set_formula(0, "B5", "=9");

    // T.TEST (paired) and TTEST alias.
    wb.set_formula(0, "C1", "=T.TEST(A1:A5, B1:B5, 2, 1)");
    wb.set_formula(0, "C2", "=TTEST(A1:A5, B1:B5, 2, 1)");
    // F.TEST and FTEST alias.
    wb.set_formula(0, "C3", "=F.TEST(A1:A5, B1:B5)");
    wb.set_formula(0, "C4", "=FTEST(A1:A5, B1:B5)");
    // Z.TEST and ZTEST alias.
    wb.set_formula(0, "C5", "=Z.TEST(A1:A5, 3)");
    wb.set_formula(0, "C6", "=ZTEST(A1:A5, 3)");

    // Each pair must agree.
    assert!(approx_eq(num(&wb, "C1"), num(&wb, "C2"), 1e-12));
    assert!(approx_eq(num(&wb, "C3"), num(&wb, "C4"), 1e-12));
    assert!(approx_eq(num(&wb, "C5"), num(&wb, "C6"), 1e-12));

    // Each output should be a valid probability in (0, 1].
    for cell in ["C1", "C2", "C3", "C4", "C5", "C6"] {
        let p = num(&wb, cell);
        assert!(
            p > 0.0 && p <= 1.0,
            "expected probability at {}, got {}",
            cell,
            p
        );
    }
}

/// CHISQ.TEST / CHITEST over a 2x4 contingency table.
#[test]
fn chisq_test_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=10");
    wb.set_formula(0, "B1", "=20");
    wb.set_formula(0, "C1", "=30");
    wb.set_formula(0, "D1", "=40");
    wb.set_formula(0, "A2", "=15");
    wb.set_formula(0, "B2", "=15");
    wb.set_formula(0, "C2", "=35");
    wb.set_formula(0, "D2", "=35");

    wb.set_formula(0, "E1", "=CHISQ.TEST(A1:D1, A2:D2)");
    wb.set_formula(0, "E2", "=CHITEST(A1:D1, A2:D2)");

    let a = num(&wb, "E1");
    let b = num(&wb, "E2");
    assert!(approx_eq(a, b, 1e-12));
    assert!(a > 0.0 && a < 1.0);
}

/// LOGNORM.DIST/INV round-trip through the workbook (also exercises
/// LOGINV / LOGNORMDIST legacy spellings).
#[test]
fn lognormal_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=LOGNORM.DIST(3, 1, 0.5, TRUE)");
    wb.set_formula(0, "A2", "=LOGNORM.INV(A1, 1, 0.5)");
    // Legacy aliases.
    wb.set_formula(0, "A3", "=LOGNORMDIST(3, 1, 0.5)");
    wb.set_formula(0, "A4", "=LOGINV(A1, 1, 0.5)");

    assert!(approx_eq(num(&wb, "A2"), 3.0, 1e-3));
    // LOGNORMDIST is cumulative-only, must match the 4-arg form.
    assert!(approx_eq(num(&wb, "A1"), num(&wb, "A3"), 1e-12));
    assert!(approx_eq(num(&wb, "A2"), num(&wb, "A4"), 1e-12));
}

/// COVAR / COVAR.P / COVARIANCE.P / COVARIANCE.S / COVAR.S all wire up.
#[test]
fn covariance_aliases_through_workbook() {
    let mut wb = Workbook::new();
    // Two 2-cell ranges with covariance(pop)=1, covariance(sample)=2.
    wb.set_formula(0, "A1", "=1");
    wb.set_formula(0, "B1", "=3");
    wb.set_formula(0, "A2", "=2");
    wb.set_formula(0, "B2", "=4");

    wb.set_formula(0, "C1", "=COVAR(A1:B1, A2:B2)");
    wb.set_formula(0, "C2", "=COVAR.P(A1:B1, A2:B2)");
    wb.set_formula(0, "C3", "=COVARIANCE.P(A1:B1, A2:B2)");
    wb.set_formula(0, "C4", "=COVARIANCE.S(A1:B1, A2:B2)");
    wb.set_formula(0, "C5", "=COVAR.S(A1:B1, A2:B2)");

    assert!(approx_eq(num(&wb, "C1"), 1.0, 1e-9));
    assert!(approx_eq(num(&wb, "C2"), 1.0, 1e-9));
    assert!(approx_eq(num(&wb, "C3"), 1.0, 1e-9));
    assert!(approx_eq(num(&wb, "C4"), 2.0, 1e-9));
    assert!(approx_eq(num(&wb, "C5"), 2.0, 1e-9));
}
