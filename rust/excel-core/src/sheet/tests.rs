use einfach_core::{Value, ValueError};

use super::Sheet;

#[test]
fn new_cell_is_null() {
    let mut sheet = Sheet::new();
    assert_eq!(sheet.get_cell("A1"), Value::Null);
}

#[test]
fn set_and_get_number() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(42.0));
    assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
}

#[test]
fn set_and_get_text() {
    let mut sheet = Sheet::new();
    sheet.set_cell("B2", Value::Text("hello".into()));
    assert_eq!(sheet.get_cell("B2"), Value::Text("hello".into()));
}

#[test]
fn multiple_cells_independent() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("A2", Value::Text("hi".into()));

    assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("A2"), Value::Text("hi".into()));
}

#[test]
fn overwrite_cell() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A1", Value::Number(99.0));
    assert_eq!(sheet.get_cell("A1"), Value::Number(99.0));
}

#[test]
fn cell_atom_returns_same_id() {
    let mut sheet = Sheet::new();
    let id1 = sheet.cell_atom("A1");
    let id2 = sheet.cell_atom("A1");
    assert_eq!(id1, id2);
}

#[test]
fn different_cells_different_ids() {
    let mut sheet = Sheet::new();
    let id1 = sheet.cell_atom("A1");
    let id2 = sheet.cell_atom("B1");
    assert_ne!(id1, id2);
}

#[test]
fn set_boolean_cell() {
    let mut sheet = Sheet::new();
    sheet.set_cell("C3", Value::Boolean(true));
    assert_eq!(sheet.get_cell("C3"), Value::Boolean(true));
}

#[test]
#[should_panic(expected = "invalid cell address")]
fn invalid_address_panics() {
    let mut sheet = Sheet::new();
    sheet.set_cell("", Value::Number(1.0));
}

#[test]
fn formula_basic_addition() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("B1", Value::Number(20.0));
    sheet.set_formula("C1", "=A1+B1");
    assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));
}

#[test]
fn formula_auto_updates() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("B1", Value::Number(20.0));
    sheet.set_formula("C1", "=A1+B1");
    assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));

    sheet.set_cell("A1", Value::Number(100.0));
    assert_eq!(sheet.get_cell("C1"), Value::Number(120.0));
}

#[test]
fn formula_chain() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(5.0));
    sheet.set_formula("B1", "=A1*2");
    sheet.set_formula("C1", "=B1+10");

    assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
    assert_eq!(sheet.get_cell("C1"), Value::Number(20.0));

    sheet.set_cell("A1", Value::Number(10.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));
    assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));
}

#[test]
fn formula_with_literal() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=42");
    assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
    assert_eq!(sheet.get_input("A1"), "=42");
}

#[test]
fn formula_division_by_zero() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_cell("B1", Value::Number(0.0));
    sheet.set_formula("C1", "=A1/B1");
    assert_eq!(
        sheet.get_cell("C1"),
        Value::Error(ValueError::DivisionByZero)
    );
}

#[test]
fn formula_sum_function() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("B1", Value::Number(2.0));
    sheet.set_cell("C1", Value::Number(3.0));
    sheet.set_formula("D1", "=SUM(A1,B1,C1)");
    assert_eq!(sheet.get_cell("D1"), Value::Number(6.0));
}

#[test]
fn formula_cleared_by_set_cell() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_formula("B1", "=A1*2");
    assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));

    sheet.set_cell("B1", Value::Number(99.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));

    sheet.set_cell("A1", Value::Number(1.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));
    assert_eq!(sheet.get_input("B1"), "99");
}

#[test]
fn formula_references_unset_cell() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(5.0));
    sheet.set_formula("C1", "=A1+B1");
    assert_eq!(sheet.get_cell("C1"), Value::Number(5.0));
}

#[test]
fn invalid_formula_becomes_error_cell() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=SUM(");
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::InvalidValue));
    assert_eq!(sheet.get_input("A1"), "=SUM(");
}

#[test]
fn batch_set_clears_formula_cells() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_formula("B1", "=A1*2");
    assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));

    sheet.batch_set(&[("B1", Value::Number(7.0))]);
    assert_eq!(sheet.get_cell("B1"), Value::Number(7.0));
    assert_eq!(sheet.get_input("B1"), "7");

    sheet.set_cell("A1", Value::Number(99.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(7.0));
}

#[test]
fn get_input_returns_display_like_value_for_non_formula_cells() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(42.0));
    sheet.set_cell("B1", Value::Text("hello".into()));
    sheet.set_cell("C1", Value::Boolean(true));

    assert_eq!(sheet.get_input("A1"), "42");
    assert_eq!(sheet.get_input("B1"), "hello");
    assert_eq!(sheet.get_input("C1"), "TRUE");
    assert_eq!(sheet.get_input("D1"), "");
}

#[test]
fn comparison_formula_returns_boolean() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_formula("B1", "=A1>=10");
    assert_eq!(sheet.get_cell("B1"), Value::Boolean(true));
}

#[test]
fn concatenate_and_power_formulas_work() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Text("Hello".into()));
    sheet.set_formula("B1", "=A1&\" World\"");
    sheet.set_formula("C1", "=2^3");

    assert_eq!(sheet.get_cell("B1"), Value::Text("Hello World".into()));
    assert_eq!(sheet.get_cell("C1"), Value::Number(8.0));
}

#[test]
fn countif_and_sumif_formulas_work() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(3.0));
    sheet.set_cell("A2", Value::Number(8.0));
    sheet.set_cell("A3", Value::Number(12.0));

    sheet.set_formula("B1", "=COUNTIF(A1:A3,\">5\")");
    sheet.set_formula("B2", "=SUMIF(A1:A3,\">5\")");

    assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("B2"), Value::Number(20.0));
}

#[test]
fn clear_cell_resets_value_and_input() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=1+1");
    assert_eq!(sheet.get_input("A1"), "=1+1");

    sheet.clear_cell("A1");
    assert_eq!(sheet.get_cell("A1"), Value::Null);
    assert_eq!(sheet.get_input("A1"), "");
}

#[test]
fn batch_set_inputs_supports_mixed_inputs() {
    let mut sheet = Sheet::new();
    sheet.batch_set_inputs(&[
        ("A1", "42"),
        ("B1", "hello"),
        ("C1", "=A1*2"),
        ("D1", ""),
    ]);

    assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
    assert_eq!(sheet.get_cell("B1"), Value::Text("hello".into()));
    assert_eq!(sheet.get_cell("C1"), Value::Number(84.0));
    assert_eq!(sheet.get_cell("D1"), Value::Null);
}

#[test]
fn batch_set_inputs_applies_updates_in_sequence() {
    let mut sheet = Sheet::new();
    sheet.batch_set_inputs(&[("A1", "1"), ("A1", "2"), ("B1", "=A1*3")]);

    assert_eq!(sheet.get_cell("A1"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(6.0));
    assert_eq!(sheet.get_input("A1"), "2");
    assert_eq!(sheet.get_input("B1"), "=A1*3");
}

#[test]
fn batch_set_inputs_updates_existing_formula_dependencies_and_clears_inputs() {
    let mut sheet = Sheet::new();
    sheet.set_formula("C1", "=A1+B1");

    sheet.batch_set_inputs(&[("A1", "10"), ("B1", "20")]);
    assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));

    sheet.batch_set_inputs(&[("B1", "")]);
    assert_eq!(sheet.get_cell("B1"), Value::Null);
    assert_eq!(sheet.get_input("B1"), "");
    assert_eq!(sheet.get_cell("C1"), Value::Number(10.0));
}

#[test]
fn formula_with_invalid_shifted_ref_returns_ref_error() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=#REF!+1");

    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::InvalidRef));
    assert_eq!(sheet.get_input("A1"), "=#REF!+1");
}
