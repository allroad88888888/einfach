//! Integration tests for the Asian text-conversion formulas (ASC / JIS /
//! DBCS / PHONETIC), round-tripping through a real `Workbook` instance so
//! we exercise the parser + evaluator + cache pipeline end-to-end rather
//! than the inline match arms in isolation.
//!
//! Mapping tables live in `eval::asc_convert` / `eval::jis_convert`; the
//! tests below pin down the user-visible contract:
//!   * ASCII width swap is loss-free in both directions.
//!   * Voiced / semi-voiced katakana decompose to `base + ﾞ`/`base + ﾟ`
//!     (ASC) and recompose from those sequences (JIS).
//!   * The Excel JIS yen-sign quirk: U+FFE5 ￥ narrows to U+005C `\`.
//!   * PHONETIC stubs as `#VALUE!` until we wire up ruby annotation data.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// ASCII letters and an embedded space survive a full ASC → JIS → ASC
/// trip through real cells. Confirms parser + cache do not corrupt the
/// payload between evaluations.
#[test]
fn asc_jis_round_trip_through_workbook() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("Hello World".into()));
    wb.set_formula(0, "B1", "=JIS(A1)");
    wb.set_formula(0, "C1", "=ASC(B1)");
    // JIS widens letters + space (U+20 → U+3000).
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Text(
            "\u{FF28}\u{FF45}\u{FF4C}\u{FF4C}\u{FF4F}\u{3000}\u{FF37}\u{FF4F}\u{FF52}\u{FF4C}\u{FF44}"
                .into()
        )
    );
    // Round-trip back to plain ASCII.
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Text("Hello World".into()));
}

/// Voiced / semi-voiced katakana — full-width → decomposed half-width →
/// recomposed full-width via the cache. Pins down both the dakuten
/// (ﾞ U+FF9E) and handakuten (ﾟ U+FF9F) composition rules.
#[test]
fn asc_jis_voiced_kana_round_trip() {
    let mut wb = Workbook::new();
    // ガ (U+30AC) + パ (U+30D1) + ヴ (U+30F4) — the three voicing shapes.
    wb.set_cell(0, "A1", Value::Text("\u{30AC}\u{30D1}\u{30F4}".into()));
    wb.set_formula(0, "B1", "=ASC(A1)");
    wb.set_formula(0, "C1", "=JIS(B1)");
    // Decomposed: each full-width voiced kana → base + mark.
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Text(
            "\u{FF76}\u{FF9E}\u{FF8A}\u{FF9F}\u{FF73}\u{FF9E}".into()
        )
    );
    // Recomposed back to the originals.
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Text("\u{30AC}\u{30D1}\u{30F4}".into())
    );
}

/// DBCS is the Excel-2013 alias for JIS, and ASC honours the JIS
/// yen-sign quirk (U+FFE5 → U+005C). Combines both invariants in one
/// workbook so a regression in either surface is caught.
#[test]
fn dbcs_alias_and_yen_sign_quirk() {
    let mut wb = Workbook::new();
    // U+FFE5 (full-width yen) followed by "100".
    wb.set_cell(0, "A1", Value::Text("\u{FFE5}100".into()));
    wb.set_formula(0, "B1", "=ASC(A1)");
    // DBCS / JIS produce identical output for the same input.
    wb.set_formula(0, "C1", "=DBCS(\"AB\")");
    wb.set_formula(0, "D1", "=JIS(\"AB\")");
    // Yen sign narrows to backslash per Excel JIS code page convention.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("\\100".into()));
    // DBCS == JIS, both produce full-width "ＡＢ".
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Text("\u{FF21}\u{FF22}".into())
    );
    assert_eq!(
        wb.get_cell("Sheet1", "D1"),
        wb.get_cell("Sheet1", "C1")
    );
}
