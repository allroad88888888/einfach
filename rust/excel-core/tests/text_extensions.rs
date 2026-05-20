//! Integration tests for the Batch B4 text expansion formulas, round-tripping
//! through a real `Workbook` instance so we exercise the parse + eval + cache
//! pipeline (not just the inline match arms).

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// FIND/SEARCH case-sensitivity contrast, with a real workbook.
#[test]
fn find_and_search_case_sensitivity_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("ABCabc".into()));
    wb.set_formula(0, "B1", "=FIND(\"a\",A1)");
    wb.set_formula(0, "B2", "=SEARCH(\"a\",A1)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(4.0));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(1.0));
}

/// SUBSTITUTE with and without instance_num, and REPLACE with explicit
/// positional surgery — round-tripped through `set_formula` / `get_cell`.
#[test]
fn substitute_and_replace_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("banana".into()));
    wb.set_formula(0, "B1", "=SUBSTITUTE(A1,\"a\",\"o\")");
    wb.set_formula(0, "B2", "=SUBSTITUTE(A1,\"a\",\"o\",2)");
    wb.set_formula(0, "B3", "=REPLACE(A1,2,3,\"XYZ\")");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("bonono".into()));
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("banona".into()));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Text("bXYZna".into()));
}

/// PROPER + TEXTJOIN composing over a range, with a Unicode CHAR/CODE pair —
/// confirms the helpers tolerate non-ASCII code points end-to-end.
#[test]
fn proper_textjoin_and_unicode_char_code_round_trip() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("hello".into()));
    wb.set_cell(0, "A2", Value::Text("world".into()));
    wb.set_formula(0, "B1", "=TEXTJOIN(\" \",TRUE,PROPER(A1),PROPER(A2))");
    wb.set_formula(0, "B2", "=CHAR(20013)");
    wb.set_formula(0, "B3", "=CODE(B2)");
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Text("Hello World".into())
    );
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Text("中".into()));
    assert_eq!(wb.get_cell("Sheet1", "B3"), Value::Number(20013.0));
}
