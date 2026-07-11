//! Integration tests for the Q-batch statistical fill-out:
//! RAND / RANDBETWEEN / RANK* / PERCENTILE* / QUARTILE* / PERCENTRANK* /
//! MODE.SNGL / MODE.MULT / MAXA / MINA / STDEVA / STDEVPA / VARA / VARPA /
//! SKEW.P / FREQUENCY / PROB / GAUSS / PHI / TRIMMEAN.
//!
//! These run through the public `Workbook` surface — formulas are set via
//! `set_formula`, evaluated through `WorkbookEvalProvider`, and the
//! results are read back via `get_cell`. The inline `mod tests` in
//! `eval.rs` already covers happy paths and edge cases against the legacy
//! shim provider; this file verifies the same behaviour holds end-to-end.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

#[test]
fn rand_and_randbetween_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=RAND()");
    wb.set_formula(0, "A2", "=RANDBETWEEN(1, 10)");
    wb.set_formula(0, "A3", "=RANDBETWEEN(7, 7)");
    // Bounds-checked, not exact-value.
    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!((0.0..1.0).contains(&n), "RAND out of [0,1): {}", n),
        other => panic!("RAND -> {:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => {
            assert!(n.fract() == 0.0);
            let i = n as i64;
            assert!((1..=10).contains(&i), "RANDBETWEEN out of range: {}", i);
        }
        other => panic!("RANDBETWEEN -> {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(7.0));
}

#[test]
fn percentile_inc_and_quartile_inc_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    // PERCENTILE.INC(A1:A5, 0.5) → median = 3.
    wb.set_formula(0, "C1", "=PERCENTILE.INC(A1:A5, 0.5)");
    // PERCENTILE.INC alias.
    wb.set_formula(0, "C2", "=PERCENTILE(A1:A5, 0.25)");
    // QUARTILE.INC(A1:A5, 4) = max.
    wb.set_formula(0, "C3", "=QUARTILE.INC(A1:A5, 4)");
    // QUARTILE alias.
    wb.set_formula(0, "C4", "=QUARTILE(A1:A5, 0)");

    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(3.0));
    match wb.get_cell("Sheet1", "C2") {
        Value::Number(n) => assert!(approx_eq(n, 2.0, 1e-9)),
        other => panic!("{:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "C4"), Value::Number(1.0));
}

#[test]
fn percentrank_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [10.0, 20.0, 30.0, 40.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    // INC: x=25 → 0.5. EXC: x=20 → (1+1)/(4+1) = 0.4.
    wb.set_formula(0, "C1", "=PERCENTRANK.INC(A1:A4, 25)");
    wb.set_formula(0, "C2", "=PERCENTRANK.EXC(A1:A4, 20)");
    // Alias PERCENTRANK -> PERCENTRANK.INC.
    wb.set_formula(0, "C3", "=PERCENTRANK(A1:A4, 30)");

    match wb.get_cell("Sheet1", "C1") {
        Value::Number(n) => assert!(approx_eq(n, 0.5, 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "C2") {
        Value::Number(n) => assert!(approx_eq(n, 0.4, 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "C3") {
        // pos=2, rank = 2/3 ≈ 0.6666... truncated to 3 digits = 0.666.
        Value::Number(n) => assert!(approx_eq(n, 0.666, 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
}

#[test]
fn mode_sngl_and_mult_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [1.0, 2.0, 2.0, 3.0, 3.0, 4.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    // MODE.SNGL aliases MODE — with ties, the legacy MODE arm picks one
    // of the tied modes (the existing implementation uses HashMap-order
    // tie-breaking; both 2 and 3 are valid mode answers here).
    wb.set_formula(0, "C1", "=MODE.SNGL(A1:A6)");
    // MODE.MULT spills 2 and 3 down a column.
    wb.set_formula(0, "C2", "=MODE.MULT(A1:A6)");

    match wb.get_cell("Sheet1", "C1") {
        Value::Number(n) => assert!(
            n == 2.0 || n == 3.0,
            "MODE.SNGL should return one of the tied modes, got {}",
            n
        ),
        other => panic!("MODE.SNGL -> {:?}", other),
    }
    // Anchor (C2) returns the full Array; the spilled target (C3) carries
    // the second mode as a scalar through the derived-atom path.
    match wb.get_cell("Sheet1", "C2") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (2, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(2.0)));
            assert_eq!(arr.get(1, 0), Some(&Value::Number(3.0)));
        }
        other => panic!("expected Array at C2, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(3.0));
}

#[test]
fn maxa_mina_and_a_variants_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(5.0));
    wb.set_cell(0, "A2", Value::Boolean(true));
    wb.set_cell(0, "A3", Value::Text("hello".into()));
    wb.set_cell(0, "A4", Value::Number(-2.0));
    // MAXA over (5, 1, 0, -2) → 5.
    wb.set_formula(0, "C1", "=MAXA(A1:A4)");
    // MINA over (5, 1, 0, -2) → -2.
    wb.set_formula(0, "C2", "=MINA(A1:A4)");
    // STDEVA: sample s.d. of (5, 1, 0, -2). Mean = 4/4 = 1; var =
    //   ((5-1)^2 + (1-1)^2 + (0-1)^2 + (-2-1)^2) / 3
    // = (16 + 0 + 1 + 9) / 3 = 26/3 ≈ 8.6667; s = sqrt(26/3).
    wb.set_formula(0, "C3", "=STDEVA(A1:A4)");
    // STDEVPA: population s.d. = sqrt(26/4) = sqrt(6.5).
    wb.set_formula(0, "C4", "=STDEVPA(A1:A4)");
    // VARA: 26/3 ≈ 8.6667. VARPA: 26/4 = 6.5.
    wb.set_formula(0, "C5", "=VARA(A1:A4)");
    wb.set_formula(0, "C6", "=VARPA(A1:A4)");

    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(-2.0));
    match wb.get_cell("Sheet1", "C3") {
        Value::Number(n) => assert!(approx_eq(n, (26.0_f64 / 3.0).sqrt(), 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "C4") {
        Value::Number(n) => assert!(approx_eq(n, 6.5_f64.sqrt(), 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "C5") {
        Value::Number(n) => assert!(approx_eq(n, 26.0 / 3.0, 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "C6") {
        Value::Number(n) => assert!(approx_eq(n, 6.5, 1e-9), "got {}", n),
        other => panic!("{:?}", other),
    }
}

#[test]
fn skew_p_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [1.0, 1.0, 1.0, 2.0, 10.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    wb.set_formula(0, "C1", "=SKEW.P(A1:A5)");
    wb.set_formula(0, "C2", "=SKEW.P(1,2,3,4,5)");
    match wb.get_cell("Sheet1", "C1") {
        Value::Number(n) => assert!(n > 0.5, "expected positive skew, got {}", n),
        other => panic!("{:?}", other),
    }
    // Symmetric distribution → 0.
    match wb.get_cell("Sheet1", "C2") {
        Value::Number(n) => assert!(n.abs() < 1e-12, "got {}", n),
        other => panic!("{:?}", other),
    }
}

#[test]
fn frequency_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    wb.set_cell(0, "B1", Value::Number(2.0));
    wb.set_cell(0, "B2", Value::Number(4.0));
    // Spilled column starting at C1: bucket counts for bins {2, 4}.
    wb.set_formula(0, "C1", "=FREQUENCY(A1:A5, B1:B2)");
    // bucket (-inf, 2] → 2; (2, 4] → 2; (4, inf) → 1.
    match wb.get_cell("Sheet1", "C1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (3, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(2.0)));
            assert_eq!(arr.get(1, 0), Some(&Value::Number(2.0)));
            assert_eq!(arr.get(2, 0), Some(&Value::Number(1.0)));
        }
        other => panic!("expected Array at C1, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(1.0));
}

#[test]
fn prob_through_workbook() {
    let mut wb = Workbook::new();
    for (i, n) in [1.0, 2.0, 3.0].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*n));
    }
    for (i, n) in [0.2, 0.5, 0.3].iter().enumerate() {
        wb.set_cell(0, &format!("B{}", i + 1), Value::Number(*n));
    }
    // PROB(x, p, 2) = 0.5 (probability mass at exactly x=2).
    wb.set_formula(0, "C1", "=PROB(A1:A3, B1:B3, 2)");
    // PROB(x, p, 2, 3) = 0.5 + 0.3 = 0.8.
    wb.set_formula(0, "C2", "=PROB(A1:A3, B1:B3, 2, 3)");
    // Unnormalized probs → #NUM!.
    wb.set_cell(0, "D1", Value::Number(0.3));
    wb.set_cell(0, "D2", Value::Number(0.4));
    wb.set_formula(0, "C3", "=PROB(A1:A2, D1:D2, 1, 2)");

    match wb.get_cell("Sheet1", "C1") {
        Value::Number(n) => assert!(approx_eq(n, 0.5, 1e-9)),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "C2") {
        Value::Number(n) => assert!(approx_eq(n, 0.8, 1e-9)),
        other => panic!("{:?}", other),
    }
    assert!(matches!(wb.get_cell("Sheet1", "C3"), Value::Error(_)));
}

#[test]
fn gauss_and_phi_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=GAUSS(0)");
    wb.set_formula(0, "A2", "=GAUSS(1)");
    wb.set_formula(0, "A3", "=PHI(0)");
    wb.set_formula(0, "A4", "=PHI(1)");
    wb.set_formula(0, "A5", "=PHI(-1)");

    match wb.get_cell("Sheet1", "A1") {
        Value::Number(n) => assert!(n.abs() < 1e-12),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "A2") {
        Value::Number(n) => assert!(approx_eq(n, 0.3413447461, 1e-6)),
        other => panic!("{:?}", other),
    }
    match wb.get_cell("Sheet1", "A3") {
        Value::Number(n) => assert!(approx_eq(n, 0.3989422804, 1e-6)),
        other => panic!("{:?}", other),
    }
    // PHI is even: PHI(1) == PHI(-1).
    let p1 = wb.get_cell("Sheet1", "A4");
    let pn1 = wb.get_cell("Sheet1", "A5");
    assert_eq!(p1, pn1);
}

#[test]
fn rank_eq_avg_through_workbook() {
    // Existing RANK / RANKEQ / RANKAVG arms already covered in
    // stats_extensions.rs. Here we additionally verify the dotted-name
    // RANK.EQ and RANK.AVG aliases that the Q batch registered.
    let mut wb = Workbook::new();
    for (i, n) in [10.0, 10.0, 5.0].iter().enumerate() {
        wb.set_cell(0, &format!("B{}", i + 1), Value::Number(*n));
    }
    // RANK.EQ(10, B1:B3) desc → no values greater than 10 → rank 1.
    wb.set_formula(0, "C1", "=RANK.EQ(10, B1:B3)");
    // RANK.AVG(10, B1:B3) desc → two 10s tie at base rank 1 → average(1,2)=1.5.
    wb.set_formula(0, "C2", "=RANK.AVG(10, B1:B3)");
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(1.0));
    match wb.get_cell("Sheet1", "C2") {
        Value::Number(n) => assert!(approx_eq(n, 1.5, 1e-9)),
        other => panic!("{:?}", other),
    }
}
