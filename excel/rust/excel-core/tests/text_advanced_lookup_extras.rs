//! Workbook round-trip tests for the Excel-365 text-advanced and
//! lookup-family extras: TEXTSPLIT / TEXTBEFORE / TEXTAFTER /
//! LOOKUP / FORMULATEXT / AREAS / ENCODEURL.
//!
//! These mirror the unit tests in `eval.rs` but route through a real
//! `Workbook` so we exercise the WorkbookEvalProvider overrides
//! (particularly `cell_formula_text` for FORMULATEXT and the spill
//! detection in `expr_may_produce_array` for TEXTSPLIT).

use einfach_core::{Value, ValueError};
use einfach_excel_core::{Sheet, Workbook};

/// TEXTSPLIT spills horizontally: a single source cell holding the
/// formula populates the cells to its right via the dynamic-array spill
/// infrastructure. We verify both the anchor (which still holds the
/// full Array value at the sheet level — the WASM boundary collapses
/// it for JS consumers) and the spilled cells.
#[test]
fn textsplit_spills_horizontally() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("alpha,beta,gamma".into()));
    assert!(wb.set_formula(0, "B1", "=TEXTSPLIT(A1, \",\")"));

    // Anchor (B1) holds the full Array.
    match wb.get_cell("Sheet1", "B1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (1, 3));
            assert_eq!(arr.get(0, 0), Some(&Value::Text("alpha".into())));
            assert_eq!(arr.get(0, 1), Some(&Value::Text("beta".into())));
            assert_eq!(arr.get(0, 2), Some(&Value::Text("gamma".into())));
        }
        other => panic!("expected Array anchor at B1, got {:?}", other),
    }
    // Spilled cells (C1, D1) read back scalars via the derived atoms.
    assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Text("beta".into()));
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Text("gamma".into()));
}

/// TEXTBEFORE / TEXTAFTER as ordinary formulas — they're scalar so no
/// spill machinery is involved.
#[test]
fn text_before_after_split_a_path() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("/usr/local/bin/cargo".into()));
    // Last path segment via TEXTAFTER with negative instance.
    assert!(wb.set_formula(0, "B1", "=TEXTAFTER(A1, \"/\", -1)"));
    // Path up to last segment via TEXTBEFORE with negative instance.
    assert!(wb.set_formula(0, "C1", "=TEXTBEFORE(A1, \"/\", -1)"));

    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("cargo".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Text("/usr/local/bin".into())
    );
}

#[test]
fn text_before_after_empty_delimiter_and_match_end() {
    let mut wb = Workbook::new();
    wb.set_formula(0, "A1", "=TEXTBEFORE(\"abc\", \"\")");
    wb.set_formula(0, "A2", "=TEXTAFTER(\"abc\", \"\")");
    wb.set_formula(0, "A3", "=TEXTBEFORE(\"abc\", \"\", -1)");
    wb.set_formula(0, "A4", "=TEXTAFTER(\"abc\", \"\", -1)");
    wb.set_formula(0, "A5", "=TEXTBEFORE(\"Socrates\", \" \", 1, 0, 1)");
    wb.set_formula(0, "A6", "=TEXTBEFORE(\"abc\", \"-\", 1, 0, 2)");
    wb.set_formula(0, "A7", "=TEXTBEFORE(\"abc\", \"-\")");

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text(String::new()));
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("abc".into()));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Text("abc".into()));
    assert_eq!(wb.get_cell("Sheet1", "A4"), Value::Text(String::new()));
    assert_eq!(wb.get_cell("Sheet1", "A5"), Value::Text("Socrates".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "A6"),
        Value::Error(ValueError::InvalidValue)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "A7"),
        Value::Error(ValueError::NotAvailable)
    );
}

#[test]
fn regex_extract_and_replace_excel_edges() {
    let mut wb = Workbook::new();
    wb.set_formula(
        0,
        "A1",
        "=REGEXEXTRACT(\"SoniaBrown\", \"([A-Z][a-z]+)([A-Z][a-z]+)\", 2)",
    );
    wb.set_formula(0, "A2", "=REGEXREPLACE(\"a1 b2 c3\", \"[0-9]\", \"X\", -1)");
    wb.set_formula(
        0,
        "A3",
        "=REGEXREPLACE(\"John Smith\", \"(\\w+) (\\w+)\", \"$2, $1\", 1)",
    );

    match wb.get_cell("Sheet1", "A1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (1, 2));
            assert_eq!(arr.get(0, 0), Some(&Value::Text("Sonia".into())));
            assert_eq!(arr.get(0, 1), Some(&Value::Text("Brown".into())));
        }
        other => panic!("expected REGEXEXTRACT capture array, got {:?}", other),
    }
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("a1 b2 cX".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "A3"),
        Value::Text("Smith, John".into())
    );
}

/// LOOKUP vector form with 3 arguments. The keys vector is sorted and
/// the result vector parallels it; LOOKUP picks the largest key ≤
/// needle.
#[test]
fn lookup_vector_form_in_workbook() {
    let mut wb = Workbook::new();
    // Keys in column A, results in column B.
    wb.set_cell(0, "A1", Value::Number(1.0));
    wb.set_cell(0, "A2", Value::Number(5.0));
    wb.set_cell(0, "A3", Value::Number(10.0));
    wb.set_cell(0, "B1", Value::Text("low".into()));
    wb.set_cell(0, "B2", Value::Text("mid".into()));
    wb.set_cell(0, "B3", Value::Text("high".into()));

    assert!(wb.set_formula(0, "D1", "=LOOKUP(7, A1:A3, B1:B3)"));
    // 7 → largest key ≤ 7 is 5 → "mid".
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Text("mid".into()));
}

/// FORMULATEXT round-trips through the workbook: a formula cell returns
/// the literal source; a primitive cell surfaces `#N/A`; a cross-sheet
/// reference resolves through `sheet_cell_formula_text`.
#[test]
fn formulatext_in_workbook_and_cross_sheet() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(0, "A1", Value::Number(2.0));
    assert!(wb.set_formula(0, "B1", "=A1*3"));
    // Cross-sheet reference holding a formula.
    assert!(wb.set_formula(1, "C1", "=42+1"));

    // FORMULATEXT(B1) → "=A1*3"
    assert!(wb.set_formula(0, "D1", "=FORMULATEXT(B1)"));
    // FORMULATEXT(A1) → #N/A (primitive cell).
    assert!(wb.set_formula(0, "D2", "=FORMULATEXT(A1)"));
    // Cross-sheet: FORMULATEXT(Data!C1) → "=42+1".
    assert!(wb.set_formula(0, "D3", "=FORMULATEXT(Data!C1)"));
    // Missing sheet is an invalid reference, not a primitive/no-formula cell.
    assert!(wb.set_formula(0, "D4", "=FORMULATEXT(Missing!C1)"));

    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Text("=A1*3".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "D2"),
        Value::Error(ValueError::NotAvailable)
    );
    assert_eq!(wb.get_cell("Sheet1", "D3"), Value::Text("=42+1".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "D4"),
        Value::Error(ValueError::InvalidRef)
    );
}

#[test]
fn formulatext_cross_sheet_ref_needs_workbook_context() {
    let mut sheet = Sheet::new();
    assert!(sheet.set_formula("C1", "=1+1"));
    assert!(sheet.set_formula("A1", "=FORMULATEXT(Data!C1)"));

    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::InvalidRef));
}

#[test]
fn textsplit_default_pad_is_not_available() {
    let mut wb = Workbook::new();
    assert!(wb.set_formula(0, "A1", "=TEXTSPLIT(\"a,b;c\", \",\", \";\")"));

    match wb.get_cell("Sheet1", "A1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (2, 2));
            assert_eq!(arr.get(0, 0), Some(&Value::Text("a".into())));
            assert_eq!(arr.get(0, 1), Some(&Value::Text("b".into())));
            assert_eq!(arr.get(1, 0), Some(&Value::Text("c".into())));
            assert_eq!(arr.get(1, 1), Some(&Value::Error(ValueError::NotAvailable)));
        }
        other => panic!("expected Array anchor at A1, got {:?}", other),
    }
    assert_eq!(
        wb.get_cell("Sheet1", "B2"),
        Value::Error(ValueError::NotAvailable)
    );
}

/// AREAS / ENCODEURL exercised end-to-end. AREAS always returns 1 for
/// the single-reference forms we support; ENCODEURL percent-encodes
/// reserved characters and passes unreserved ones through.
///
/// We deliberately place the AREAS formula OUTSIDE the range being
/// counted (`F1` for the formula, `A1:B5` for the reference) so static
/// cycle detection doesn't reject the write.
#[test]
fn areas_and_encodeurl_in_workbook() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("name with spaces?".into()));
    assert!(wb.set_formula(0, "F1", "=AREAS(A1:B5)"));
    assert!(wb.set_formula(0, "C1", "=ENCODEURL(A1)"));

    assert_eq!(wb.get_cell("Sheet1", "F1"), Value::Number(1.0));
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        Value::Text("name%20with%20spaces%3F".into())
    );
}
