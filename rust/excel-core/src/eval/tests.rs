use std::collections::HashMap;

use einfach_core::{AtomId, Value, ValueError};

use crate::cell::{CellAddress, CellReference};
use crate::formula::parse_formula;

use super::eval_expr;

fn make_test_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
    let mut cell_map = HashMap::new();
    let mut values = HashMap::new();

    let a1 = AtomId::from_raw(0);
    let b1 = AtomId::from_raw(1);
    let c1 = AtomId::from_raw(2);
    let a2 = AtomId::from_raw(3);
    let b2 = AtomId::from_raw(4);

    cell_map.insert(CellAddress::new(0, 0), a1);
    cell_map.insert(CellAddress::new(0, 1), b1);
    cell_map.insert(CellAddress::new(0, 2), c1);
    cell_map.insert(CellAddress::new(1, 0), a2);
    cell_map.insert(CellAddress::new(1, 1), b2);

    values.insert(a1, Value::Number(10.0));
    values.insert(b1, Value::Number(20.0));
    values.insert(c1, Value::Number(0.0));
    values.insert(a2, Value::Number(5.0));
    values.insert(b2, Value::Text("text".into()));

    (cell_map, values)
}

fn eval_str(
    formula: &str,
    cell_map: &HashMap<CellAddress, AtomId>,
    values: &HashMap<AtomId, Value>,
) -> Value {
    let expr = parse_formula(formula).expect("parse failed");
    let resolve_cell = |reference: &CellReference| -> Value {
        if reference.is_invalid() || reference.sheet_name.is_some() {
            return Value::Error(ValueError::InvalidRef);
        }

        cell_map
            .get(&reference.addr)
            .and_then(|id| values.get(id))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let resolve_range = |start: &CellReference, end: &CellReference| -> Vec<Value> {
        if start.is_invalid()
            || end.is_invalid()
            || start.sheet_name.is_some()
            || end.sheet_name.is_some()
        {
            return vec![Value::Error(ValueError::InvalidRef)];
        }

        let min_row = start.addr.row.min(end.addr.row);
        let max_row = start.addr.row.max(end.addr.row);
        let min_col = start.addr.col.min(end.addr.col);
        let max_col = start.addr.col.max(end.addr.col);
        let mut range = Vec::new();

        for row in min_row..=max_row {
            for col in min_col..=max_col {
                let addr = CellAddress::new(row, col);
                range.push(
                    cell_map
                        .get(&addr)
                        .and_then(|id| values.get(id))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
        }

        range
    };
    eval_expr(&expr, &resolve_cell, &resolve_range)
}

#[test]
fn eval_number_literal() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=42", &cm, &vs), Value::Number(42.0));
}

#[test]
fn eval_cell_ref() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=A1", &cm, &vs), Value::Number(10.0));
}

#[test]
fn eval_addition() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=A1+B1", &cm, &vs), Value::Number(30.0));
}

#[test]
fn eval_complex_expr() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=(A1+B1)*2", &cm, &vs), Value::Number(60.0));
}

#[test]
fn eval_division_by_zero() {
    let (cm, vs) = make_test_env();
    assert_eq!(
        eval_str("=A1/C1", &cm, &vs),
        Value::Error(ValueError::DivisionByZero)
    );
}

#[test]
fn eval_negation() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=-A1", &cm, &vs), Value::Number(-10.0));
}

#[test]
fn eval_text_arithmetic_is_error() {
    let (cm, vs) = make_test_env();
    assert_eq!(
        eval_str("=B2+1", &cm, &vs),
        Value::Error(ValueError::InvalidValue)
    );
}

#[test]
fn eval_sum_cells() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=SUM(A1,B1)", &cm, &vs), Value::Number(30.0));
}

#[test]
fn eval_sum_range() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=SUM(A1:B1)", &cm, &vs), Value::Number(30.0));
}

#[test]
fn eval_average() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=AVERAGE(A1,B1)", &cm, &vs), Value::Number(15.0));
}

#[test]
fn eval_count() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=COUNT(A1:B2)", &cm, &vs), Value::Number(3.0));
}

#[test]
fn eval_if_true() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=IF(A1,100,200)", &cm, &vs), Value::Number(100.0));
}

#[test]
fn eval_if_false() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=IF(C1,100,200)", &cm, &vs), Value::Number(200.0));
}

#[test]
fn eval_min() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=MIN(A1,B1,A2)", &cm, &vs), Value::Number(5.0));
}

#[test]
fn eval_max() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=MAX(A1,B1,A2)", &cm, &vs), Value::Number(20.0));
}

#[test]
fn eval_unknown_func() {
    let (cm, vs) = make_test_env();
    assert_eq!(
        eval_str("=FOO(A1)", &cm, &vs),
        Value::Error(ValueError::InvalidName)
    );
}

#[test]
fn eval_null_coerces_to_zero() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=D1+5", &cm, &vs), Value::Number(5.0));
}

#[test]
fn eval_comparison_operators() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=A1>B1", &cm, &vs), Value::Boolean(false));
    assert_eq!(eval_str("=A1<=10", &cm, &vs), Value::Boolean(true));
    assert_eq!(eval_str("=B2<>\"other\"", &cm, &vs), Value::Boolean(true));
}

#[test]
fn eval_power_and_concat_operators() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=2^3^2", &cm, &vs), Value::Number(512.0));
    assert_eq!(
        eval_str("=\"Hi \"&B2", &cm, &vs),
        Value::Text("Hi text".into())
    );
}

#[test]
fn eval_boolean_literals_and_logic_functions() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=TRUE", &cm, &vs), Value::Boolean(true));
    assert_eq!(eval_str("=AND(A1>5,B1>10)", &cm, &vs), Value::Boolean(true));
    assert_eq!(eval_str("=OR(C1,B2=\"text\")", &cm, &vs), Value::Boolean(true));
    assert_eq!(eval_str("=NOT(A1>5)", &cm, &vs), Value::Boolean(false));
}

#[test]
fn eval_math_functions() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=ABS(-10)", &cm, &vs), Value::Number(10.0));
    assert_eq!(eval_str("=ROUND(12.345,2)", &cm, &vs), Value::Number(12.35));
    assert_eq!(eval_str("=CEILING(12.1)", &cm, &vs), Value::Number(13.0));
    assert_eq!(eval_str("=FLOOR(12.9)", &cm, &vs), Value::Number(12.0));
    assert_eq!(eval_str("=SQRT(81)", &cm, &vs), Value::Number(9.0));
    assert_eq!(eval_str("=POWER(2,5)", &cm, &vs), Value::Number(32.0));
    assert_eq!(eval_str("=MOD(10,3)", &cm, &vs), Value::Number(1.0));
}

#[test]
fn eval_text_functions() {
    let (cm, vs) = make_test_env();
    assert_eq!(
        eval_str("=CONCATENATE(\"Hi \",B2)", &cm, &vs),
        Value::Text("Hi text".into())
    );
    assert_eq!(eval_str("=LEN(B2)", &cm, &vs), Value::Number(4.0));
    assert_eq!(eval_str("=LEFT(\"hello\",2)", &cm, &vs), Value::Text("he".into()));
    assert_eq!(eval_str("=RIGHT(\"hello\",3)", &cm, &vs), Value::Text("llo".into()));
    assert_eq!(eval_str("=MID(\"hello\",2,3)", &cm, &vs), Value::Text("ell".into()));
    assert_eq!(eval_str("=UPPER(\"Hello\")", &cm, &vs), Value::Text("HELLO".into()));
    assert_eq!(eval_str("=LOWER(\"Hello\")", &cm, &vs), Value::Text("hello".into()));
    assert_eq!(
        eval_str("=TRIM(\"  hello   world  \")", &cm, &vs),
        Value::Text("hello world".into())
    );
    assert_eq!(
        eval_str("=TEXT(1234.56,\"#,##0.00\")", &cm, &vs),
        Value::Text("1,234.56".into())
    );
}

#[test]
fn eval_conditional_aggregate_functions() {
    let (cm, vs) = make_test_env();
    assert_eq!(eval_str("=COUNTIF(A1:B1,\">10\")", &cm, &vs), Value::Number(1.0));
    assert_eq!(eval_str("=COUNTIF(B2,\"text\")", &cm, &vs), Value::Number(1.0));
    assert_eq!(eval_str("=SUMIF(A1:B1,\">10\")", &cm, &vs), Value::Number(20.0));
}

#[test]
fn eval_if_with_comparison() {
    let (cm, vs) = make_test_env();
    assert_eq!(
        eval_str("=IF(A1>10,\"大\",\"小\")", &cm, &vs),
        Value::Text("小".into())
    );
}
