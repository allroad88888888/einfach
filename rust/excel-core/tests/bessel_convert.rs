//! Integration tests for the Bessel + CONVERT batch.
//!
//! These drive `BESSELJ / BESSELY / BESSELI / BESSELK / CONVERT`
//! end-to-end through the public `Workbook` API — `set_cell`,
//! `set_formula`, the formula parser, and `WorkbookEvalProvider` — to
//! confirm the same math the inline `mod tests` covers also works
//! against a real `Sheet`.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

fn expect_num(wb: &Workbook, addr: &str, expected: f64, tol: f64) {
    match wb.get_cell("Sheet1", addr) {
        Value::Number(n) => assert!(
            approx_eq(n, expected, tol),
            "{}: expected ≈ {} (tol={}), got {}",
            addr,
            expected,
            tol,
            n
        ),
        other => panic!("expected number at {}, got {:?}", addr, other),
    }
}

/// BESSELJ values feed into BESSELY identities through a real sheet.
/// Wronskian-style sanity check: J_0(1)*Y_1(1) - J_1(1)*Y_0(1) =
/// -2/(pi*1) = -0.6366197723 (Wronskian of J/Y).
#[test]
fn bessel_jy_wronskian_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=BESSELJ(1, 0)");
    wb.set_formula(0, "A2", "=BESSELJ(1, 1)");
    wb.set_formula(0, "B1", "=BESSELY(1, 0)");
    wb.set_formula(0, "B2", "=BESSELY(1, 1)");
    wb.set_formula(0, "C1", "=A1*B2 - A2*B1");

    expect_num(&wb, "A1", 0.7651976866, 1e-5);
    expect_num(&wb, "A2", 0.4400505857, 1e-5);
    expect_num(&wb, "B1", 0.0882569642, 1e-4);
    expect_num(&wb, "B2", -0.7812128213, 1e-4);
    // -2/pi.
    expect_num(&wb, "C1", -2.0 / std::f64::consts::PI, 1e-4);
}

/// BESSELI / BESSELK round-trip with the modified Wronskian:
/// I_0(x)*K_1(x) + I_1(x)*K_0(x) = 1/x. At x = 2, that is 0.5.
#[test]
fn bessel_ik_modified_wronskian() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=BESSELI(2, 0)");
    wb.set_formula(0, "A2", "=BESSELI(2, 1)");
    wb.set_formula(0, "B1", "=BESSELK(2, 0)");
    wb.set_formula(0, "B2", "=BESSELK(2, 1)");
    wb.set_formula(0, "C1", "=A1*B2 + A2*B1");

    expect_num(&wb, "C1", 0.5, 1e-4);
}

/// Negative order / singular-x both surface `#NUM!` through the chain.
#[test]
fn bessel_error_propagation() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=BESSELJ(1, -1)");
    wb.set_formula(0, "A2", "=BESSELY(0, 0)");
    wb.set_formula(0, "A3", "=BESSELK(-1, 1)");
    // A4 references an error cell; the error must propagate.
    wb.set_formula(0, "A4", "=A1 + 1");

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
    assert_eq!(
        wb.get_cell("Sheet1", "A4"),
        Value::Error(ValueError::Overflow)
    );
}

/// CONVERT end-to-end: a length chain (yd -> m -> cm), a temperature
/// chain (C -> F -> K), and a category mismatch surfaces #VALUE!.
#[test]
fn convert_chains_through_workbook() {
    let mut wb = Workbook::new();
    // Length chain: 10 yards -> metres -> centimetres -> back to inches.
    wb.set_formula(0, "A1", "=CONVERT(10, \"yd\", \"m\")");
    wb.set_formula(0, "A2", "=CONVERT(A1, \"m\", \"cm\")");
    wb.set_formula(0, "A3", "=CONVERT(A2, \"cm\", \"in\")");

    expect_num(&wb, "A1", 9.144, 1e-9);
    expect_num(&wb, "A2", 914.4, 1e-6);
    // 10 yards = 360 inches.
    expect_num(&wb, "A3", 360.0, 1e-6);

    // Temperature chain: 0C -> F -> K. (32F == 273.15K.)
    wb.set_formula(0, "B1", "=CONVERT(0, \"C\", \"F\")");
    wb.set_formula(0, "B2", "=CONVERT(B1, \"F\", \"K\")");
    expect_num(&wb, "B1", 32.0, 1e-9);
    expect_num(&wb, "B2", 273.15, 1e-9);

    // Category mismatch -> #VALUE! propagates through reference.
    wb.set_formula(0, "C1", "=CONVERT(1, \"kg\", \"sec\")");
    wb.set_formula(0, "C2", "=C1 + 1");
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Error(ValueError::InvalidValue)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "C2"),
        Value::Error(ValueError::InvalidValue)
    );
}

/// CONVERT works with a unit symbol pulled from another cell (text
/// arg coercion path goes through the same `coerce_to_text` used by
/// other formula functions).
#[test]
fn convert_unit_symbol_from_cell() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(100.0));
    wb.set_cell(0, "B1", Value::Text("cm".into()));
    wb.set_cell(0, "C1", Value::Text("m".into()));
    wb.set_formula(0, "D1", "=CONVERT(A1, B1, C1)");

    expect_num(&wb, "D1", 1.0, 1e-9);
}
