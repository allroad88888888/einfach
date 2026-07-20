//! #32 Excel Table — T2 structured-reference PARSING + render round-trip
//! (design doc `design-excel-table.md` §5.1 / §5.2).
//!
//! Scope of THIS suite: the lexer/grammar for `Table1[Col]`, `[@Col]`,
//! `#special` bands, and `[ColA]:[ColB]` segments, plus the `render_formula`
//! round-trip (parse → render → parse is a fixed point at the AST level).
//! Evaluation lives in `table_structured_refs.rs`.
//!
//! MVP subset (§3.2 out-of-scope, asserted as parse failures below):
//! combined qualifiers `Table1[[#Headers],[Col]]`, `'`-escaped column
//! names, and empty `Table1[]` are deliberately NOT accepted.

use einfach_excel_core::{parse_formula, render_formula, Expr, TableArea};

fn table_ref(s: &str) -> (Option<String>, TableArea, Option<(String, String)>) {
    match parse_formula(s).unwrap_or_else(|| panic!("parse failed: {s}")) {
        Expr::TableRef {
            table,
            area,
            columns,
        } => (table, area, columns),
        other => panic!("expected TableRef for {s}, got {other:?}"),
    }
}

fn col(a: &str) -> Option<(String, String)> {
    Some((a.to_string(), a.to_string()))
}

// ===================== positive grammar matrix =====================

#[test]
fn named_single_column_bare() {
    let (t, a, c) = table_ref("=Table1[Column]");
    assert_eq!(t.as_deref(), Some("Table1"));
    assert_eq!(a, TableArea::Data);
    assert_eq!(c, col("Column"));
}

#[test]
fn named_single_column_bracketed() {
    // Bracketed inner form resolves to the same AST as the bare form.
    assert_eq!(table_ref("=Table1[[Column]]"), table_ref("=Table1[Column]"));
}

#[test]
fn column_name_keeps_internal_spaces() {
    let (_, _, c) = table_ref("=Table1[Unit Price]");
    assert_eq!(c, col("Unit Price"));
    // Bracketed spelling of a spaced name is identical.
    assert_eq!(table_ref("=Table1[[Unit Price]]"), table_ref("=Table1[Unit Price]"));
}

#[test]
fn special_bands() {
    assert_eq!(table_ref("=Table1[#All]"), (Some("Table1".into()), TableArea::All, None));
    assert_eq!(table_ref("=Table1[#Data]"), (Some("Table1".into()), TableArea::Data, None));
    assert_eq!(
        table_ref("=Table1[#Headers]"),
        (Some("Table1".into()), TableArea::Headers, None)
    );
    assert_eq!(
        table_ref("=Table1[#Totals]"),
        (Some("Table1".into()), TableArea::Totals, None)
    );
    assert_eq!(
        table_ref("=Table1[#This Row]"),
        (Some("Table1".into()), TableArea::ThisRow, None)
    );
}

#[test]
fn special_keywords_are_case_insensitive() {
    assert_eq!(table_ref("=Table1[#headers]").1, TableArea::Headers);
    assert_eq!(table_ref("=Table1[#ALL]").1, TableArea::All);
    assert_eq!(table_ref("=Table1[#this row]").1, TableArea::ThisRow);
}

#[test]
fn this_row_forms() {
    // Table-less `[@Col]` — table resolved from the current cell at eval.
    assert_eq!(table_ref("=[@Column]"), (None, TableArea::ThisRow, col("Column")));
    // Bracketed variant.
    assert_eq!(table_ref("=[@[Column]]"), (None, TableArea::ThisRow, col("Column")));
    // Table-qualified `@`.
    assert_eq!(
        table_ref("=Table1[@Column]"),
        (Some("Table1".into()), TableArea::ThisRow, col("Column"))
    );
    // Bare `[@]` — the whole current row.
    assert_eq!(table_ref("=[@]"), (None, TableArea::ThisRow, None));
}

#[test]
fn table_less_bare_column() {
    assert_eq!(table_ref("=[Column]"), (None, TableArea::Data, col("Column")));
}

#[test]
fn multi_column_segment() {
    assert_eq!(
        table_ref("=Table1[[Col1]:[Col2]]"),
        (Some("Table1".into()), TableArea::Data, Some(("Col1".into(), "Col2".into())))
    );
}

#[test]
fn structured_ref_as_function_argument() {
    match parse_formula("=SUM(Table1[Amount])").unwrap() {
        Expr::FuncCall { name, args } => {
            assert_eq!(name, "SUM");
            assert_eq!(args.len(), 1);
            assert!(matches!(&args[0], Expr::TableRef { .. }));
        }
        other => panic!("expected FuncCall, got {other:?}"),
    }
}

#[test]
fn table_name_that_looks_like_a_cell_address() {
    // `Table1` also parses as the bare cell address (column "TABLE", row
    // 1); the trailing `[` must still route it to a structured reference.
    let (t, _, _) = table_ref("=Table1[Qty]");
    assert_eq!(t.as_deref(), Some("Table1"));
    // And a plainer table name works too.
    assert_eq!(table_ref("=Sales[Qty]").0.as_deref(), Some("Sales"));
}

// ===================== negative matrix =====================

#[test]
fn rejects_unclosed_bracket() {
    assert_eq!(parse_formula("=Table1[Column"), None);
}

#[test]
fn rejects_empty_reference() {
    // `Table1[]` (empty column ref) is a deferred syntax (§3.2).
    assert_eq!(parse_formula("=Table1[]"), None);
    assert_eq!(parse_formula("=[]"), None);
}

#[test]
fn rejects_unknown_special_keyword() {
    assert_eq!(parse_formula("=Table1[#Bogus]"), None);
    assert_eq!(parse_formula("=Table1[#]"), None);
}

#[test]
fn rejects_combined_qualifier() {
    // `Table1[[#Headers],[Col]]` — combined qualifier is deferred (§3.2),
    // so the MVP grammar rejects it rather than half-parsing it.
    assert_eq!(parse_formula("=Table1[[#Headers],[Col]]"), None);
}

#[test]
fn rejects_unclosed_segment() {
    assert_eq!(parse_formula("=Table1[[Col1]:[Col2]"), None);
    assert_eq!(parse_formula("=Table1[[Col1]:Col2]"), None);
}

// ===================== no regression on ordinary formulas =====================

#[test]
fn ordinary_formulas_unaffected() {
    assert!(matches!(parse_formula("=A1"), Some(Expr::CellRef(_))));
    assert!(matches!(parse_formula("=SUM(A1:B2)"), Some(Expr::FuncCall { .. })));
    assert!(matches!(parse_formula("=Sheet1!A1"), Some(Expr::SheetRef { .. })));
    assert!(matches!(parse_formula("=A1#"), Some(Expr::SpillRef(_))));
    assert!(matches!(parse_formula("=x"), Some(Expr::Name(_))));
    assert!(matches!(parse_formula("=1+2*3"), Some(Expr::BinOp { .. })));
}

// ===================== render round-trip (fixed point) =====================

fn round_trips(s: &str) {
    let first = parse_formula(s).unwrap_or_else(|| panic!("parse failed: {s}"));
    let rendered = render_formula(&first);
    let second = parse_formula(&rendered)
        .unwrap_or_else(|| panic!("re-parse failed for render {rendered:?} of {s}"));
    assert_eq!(first, second, "round-trip changed AST: {s} -> {rendered}");
}

#[test]
fn render_round_trip_fixed_point() {
    for s in [
        "=Table1[Column]",
        "=Table1[[Column]]",
        "=Table1[Unit Price]",
        "=Table1[#All]",
        "=Table1[#Data]",
        "=Table1[#Headers]",
        "=Table1[#Totals]",
        "=Table1[#This Row]",
        "=[@Column]",
        "=[@[Column]]",
        "=Table1[@Column]",
        "=[@]",
        "=[Column]",
        "=Table1[[Col1]:[Col2]]",
        "=SUM(Table1[Amount])",
        "=Table1[Amount]+1",
    ] {
        round_trips(s);
    }
}

#[test]
fn this_row_special_and_at_are_aliases_after_render() {
    // `[#This Row]` and `[@]` both denote (ThisRow, whole row); render
    // normalizes to the `@` spelling, and both re-parse to the same AST.
    let a = parse_formula("=Table1[#This Row]").unwrap();
    let b = parse_formula("=Table1[@]").unwrap();
    assert_eq!(a, b);
    assert_eq!(render_formula(&a), "=Table1[@]");
}
