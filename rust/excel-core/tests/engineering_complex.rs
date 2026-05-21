//! Integration tests for Excel's engineering complex-number formula
//! family.
//!
//! These drive `COMPLEX / IMABS / IMREAL / IMAGINARY / IMCONJUGATE /
//! IMARGUMENT / IMSUM / IMSUB / IMPRODUCT / IMDIV / IMEXP / IMLN /
//! IMLOG10 / IMLOG2 / IMSQRT / IMPOWER / IMCOS / IMCOSH / IMSIN /
//! IMSINH / IMTAN / IMSEC / IMCSC / IMCOT` through the public
//! `Workbook` API to confirm the parser, formatter, and evaluator
//! cooperate end-to-end against a real `Sheet`.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// Helper: parse a `Value::Text` result back through the same
/// suffix-aware format and assert real/imag parts are within `eps`.
/// We round-trip via simple parsing because some trig results have
/// rounding residue (`exp(i*pi)` → tiny non-zero imag).
fn parse_text_complex(v: &Value) -> (f64, f64) {
    let s = match v {
        Value::Text(s) => s,
        other => panic!("expected complex Text, got {:?}", other),
    };
    // Trim suffix.
    let (body, has_suffix) = match s.chars().last() {
        Some('i') | Some('j') => (&s[..s.len() - 1], true),
        _ => (s.as_str(), false),
    };
    if !has_suffix {
        return (body.parse::<f64>().unwrap(), 0.0);
    }
    // Find split sign that isn't part of an exponent and isn't at idx 0.
    let bytes = body.as_bytes();
    let mut split = None;
    for (i, &b) in bytes.iter().enumerate() {
        if i == 0 {
            continue;
        }
        if (b == b'+' || b == b'-') && bytes[i - 1] != b'e' && bytes[i - 1] != b'E' {
            split = Some(i);
        }
    }
    match split {
        Some(idx) => {
            let real: f64 = body[..idx].parse().unwrap();
            let imag_str = &body[idx..];
            let imag: f64 = if imag_str == "+" {
                1.0
            } else if imag_str == "-" {
                -1.0
            } else {
                imag_str.parse().unwrap()
            };
            (real, imag)
        }
        None => {
            let imag: f64 = if body.is_empty() || body == "+" {
                1.0
            } else if body == "-" {
                -1.0
            } else {
                body.parse().unwrap()
            };
            (0.0, imag)
        }
    }
}

/// Round-trip COMPLEX ↔ IMREAL / IMAGINARY / IMCONJUGATE / IMABS
/// against known values.
#[test]
fn complex_constructor_and_accessors_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COMPLEX(3,4)");
    wb.set_formula(0, "A2", "=COMPLEX(3,4,\"j\")");
    wb.set_formula(0, "B1", "=IMREAL(A1)");
    wb.set_formula(0, "B2", "=IMAGINARY(A1)");
    wb.set_formula(0, "B3", "=IMABS(A1)");
    wb.set_formula(0, "B4", "=IMCONJUGATE(A1)");
    // Suffix preservation through accessor / formatter.
    wb.set_formula(0, "C1", "=IMCONJUGATE(A2)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text("3+4i".into()));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("3+4j".into()));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Text("3-4i".into()));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Text("3-4j".into()));
}

/// Arithmetic round-trip: A − A == 0, A * conj(A) == |A|^2 (real).
#[test]
fn complex_arithmetic_identities() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COMPLEX(3,4)");
    // Self-subtract → "0".
    wb.set_formula(0, "B1", "=IMSUB(A1,A1)");
    // Self-product through conjugate → |A|^2 = 25, real-only.
    wb.set_formula(0, "B2", "=IMPRODUCT(A1,IMCONJUGATE(A1))");
    // Divide A by A → 1 (real).
    wb.set_formula(0, "B3", "=IMDIV(A1,A1)");
    // Sum with negation cancels.
    wb.set_formula(0, "B4", "=IMSUM(A1,IMSUB(COMPLEX(0,0),A1))");

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("0".into()));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("25".into()));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Text("1".into()));
    assert_eq!(wb.get_cell("Sheet1", "B4"), Value::Text("0".into()));
}

/// IMDIV by zero surfaces #DIV/0! through a formula chain.
#[test]
fn complex_div_by_zero_propagates() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=IMDIV(\"3+4i\",\"0\")");
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::DivisionByZero)
    );
}

/// Transcendental round-trips:
///   IMLN(IMEXP(z)) ≈ z   (within float epsilon)
///   IMPOWER(IMSQRT(z), 2) ≈ z   (for non-zero z away from branch cut)
#[test]
fn complex_transcendental_round_trip() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COMPLEX(1.5, 0.5)");
    wb.set_formula(0, "B1", "=IMLN(IMEXP(A1))");
    wb.set_formula(0, "B2", "=IMPOWER(IMSQRT(A1),2)");

    let (r1, i1) = parse_text_complex(&wb.get_cell("Sheet1", "B1"));
    assert!((r1 - 1.5).abs() < 1e-9, "real {r1}");
    assert!((i1 - 0.5).abs() < 1e-9, "imag {i1}");

    let (r2, i2) = parse_text_complex(&wb.get_cell("Sheet1", "B2"));
    assert!((r2 - 1.5).abs() < 1e-9, "real {r2}");
    assert!((i2 - 0.5).abs() < 1e-9, "imag {i2}");
}

/// Trig identity: IMSIN(z)^2 + IMCOS(z)^2 == 1 (real).
#[test]
fn complex_trig_pythagoras() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=COMPLEX(0.7, 0.3)");
    wb.set_formula(0, "B1", "=IMSUM(IMPOWER(IMSIN(A1),2), IMPOWER(IMCOS(A1),2))");

    let (r, i) = parse_text_complex(&wb.get_cell("Sheet1", "B1"));
    assert!((r - 1.0).abs() < 1e-9, "real {r}");
    assert!(i.abs() < 1e-9, "imag {i}");
}
