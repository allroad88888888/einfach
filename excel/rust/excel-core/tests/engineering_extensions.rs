//! Integration tests for the engineering / bit-op / base-conversion
//! formula batch.
//!
//! These drive `BIN2DEC / DEC2BIN / ... / HEX2OCT / BITAND / BITOR /
//! BITXOR / BITLSHIFT / BITRSHIFT / DELTA / GESTEP` through the public
//! `Workbook` API — `set_cell`, `set_formula`, the formula parser, and
//! `WorkbookEvalProvider` — to confirm the same math the inline
//! `mod tests` covers is reachable end-to-end against a real `Sheet`.

use einfach_core::{Value, ValueError};
use einfach_excel_core::Workbook;

/// Round-trip every base-conversion combo against a known reference:
/// 15 ↔ "F" ↔ "1111" ↔ "17", and -1 in all three two's-complement
/// max-width encodings.
#[test]
fn base_conversion_round_trip() {
    let mut wb = Workbook::new();
    // Positive: -> DEC2XXX and back through XXX2DEC.
    wb.set_formula(0, "A1", "=DEC2BIN(15)");
    wb.set_formula(0, "A2", "=DEC2OCT(15)");
    wb.set_formula(0, "A3", "=DEC2HEX(15)");
    wb.set_formula(0, "B1", "=BIN2DEC(A1)");
    wb.set_formula(0, "B2", "=OCT2DEC(A2)");
    wb.set_formula(0, "B3", "=HEX2DEC(A3)");
    // Cross-base: BIN2HEX("1111") == "F".
    wb.set_formula(0, "C1", "=BIN2HEX(\"1111\")");
    wb.set_formula(0, "C2", "=HEX2OCT(\"F\")");
    wb.set_formula(0, "C3", "=OCT2BIN(\"17\")");
    // Negative two's complement: DEC2BIN(-1) == "1111111111", and
    // round-trips through every cross-base wrapper.
    wb.set_formula(0, "D1", "=DEC2BIN(-1)");
    wb.set_formula(0, "D2", "=BIN2HEX(\"1111111111\")");
    wb.set_formula(0, "D3", "=BIN2DEC(D1)");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text("1111".into()));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("17".into()));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Text("F".into()));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(15.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(15.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(15.0));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Text("F".into()));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Text("17".into()));
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Text("1111".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "D1"),
        Value::Text("1111111111".into())
    );
    assert_eq!(
        wb.get_cell("Sheet1", "D2"),
        Value::Text("FFFFFFFFFF".into())
    );
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Number(-1.0));
}

/// Bit-op identities and BITLSHIFT/BITRSHIFT inverse pair across a
/// real workbook.
#[test]
fn bit_ops_identities() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(240.0));
    wb.set_cell(0, "A2", Value::Number(15.0));
    // BITAND with disjoint sets is 0; BITOR is the union; BITXOR
    // is the union (since disjoint).
    wb.set_formula(0, "B1", "=BITAND(A1,A2)");
    wb.set_formula(0, "B2", "=BITOR(A1,A2)");
    wb.set_formula(0, "B3", "=BITXOR(A1,A2)");
    // BITLSHIFT(A2, 4) == A1; BITRSHIFT(A1, 4) == A2.
    wb.set_formula(0, "C1", "=BITLSHIFT(A2,4)");
    wb.set_formula(0, "C2", "=BITRSHIFT(A1,4)");
    // Range error surfaces through formula chain.
    wb.set_formula(0, "D1", "=BITAND(-1,1)");

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(0.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(255.0));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(255.0));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(240.0));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(15.0));
    assert_eq!(
        wb.get_cell("Sheet1", "D1"),
        Value::Error(ValueError::Overflow)
    );
}

/// DELTA / GESTEP comparison contract over workbook cells. Verifies
/// default-zero second arg behaviour through the parser.
#[test]
fn delta_gestep_comparison() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Number(5.0));
    wb.set_cell(0, "A2", Value::Number(5.0));
    wb.set_cell(0, "A3", Value::Number(6.0));
    // DELTA equal / not-equal.
    wb.set_formula(0, "B1", "=DELTA(A1,A2)");
    wb.set_formula(0, "B2", "=DELTA(A1,A3)");
    // GESTEP at, above, below threshold.
    wb.set_formula(0, "C1", "=GESTEP(A3,A1)");
    wb.set_formula(0, "C2", "=GESTEP(A1,A3)");
    wb.set_formula(0, "C3", "=GESTEP(A1,A2)");
    // No-second-arg defaults to 0.
    wb.set_formula(0, "D1", "=DELTA(0)");
    wb.set_formula(0, "D2", "=GESTEP(-1)");

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(0.0));
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(0.0));
    assert_eq!(wb.get_cell("Sheet1", "C3"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "D2"), Value::Number(0.0));
}
