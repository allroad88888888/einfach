use std::collections::HashMap;

use einfach_core::{AtomId, Value, ValueError};

use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr};

/// Evaluate an AST expression using a getter function for cell values.
/// `cell_map` maps CellAddress to AtomId so the evaluator can look up cells.
pub fn eval_expr(
    expr: &Expr,
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Value {
    match expr {
        Expr::Number(n) => Value::Number(*n),
        Expr::Text(s) => Value::Text(s.clone()),

        Expr::CellRef(addr) => {
            if let Some(&id) = cell_map.get(addr) {
                get(id)
            } else {
                Value::Null // unset cell
            }
        }

        Expr::BinOp { op, left, right } => {
            let lv = eval_expr(left, get, cell_map);
            let rv = eval_expr(right, get, cell_map);
            eval_binop(*op, &lv, &rv)
        }

        Expr::Negate(inner) => {
            let v = eval_expr(inner, get, cell_map);
            match v {
                Value::Number(n) => Value::Number(-n),
                Value::Error(e) => Value::Error(e),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }

        Expr::FuncCall { name, args } => {
            eval_func(name, args, get, cell_map)
        }

        Expr::Range { start, end } => {
            // Ranges should be handled by function evaluators, not standalone
            // If we get here, collect all values into... just return an error
            let _ = (start, end);
            Value::Error(ValueError::InvalidValue)
        }
    }
}

fn eval_binop(op: BinOperator, left: &Value, right: &Value) -> Value {
    // Propagate errors
    if let Value::Error(e) = left {
        return Value::Error(e.clone());
    }
    if let Value::Error(e) = right {
        return Value::Error(e.clone());
    }

    let ln = coerce_to_number(left);
    let rn = coerce_to_number(right);

    match (ln, rn) {
        (Some(l), Some(r)) => match op {
            BinOperator::Add => Value::Number(l + r),
            BinOperator::Sub => Value::Number(l - r),
            BinOperator::Mul => Value::Number(l * r),
            BinOperator::Div => {
                if r == 0.0 {
                    Value::Error(ValueError::DivisionByZero)
                } else {
                    Value::Number(l / r)
                }
            }
        },
        _ => Value::Error(ValueError::InvalidValue),
    }
}

/// Coerce a value to a number for arithmetic.
/// Null → 0, Boolean true → 1, false → 0, Number → itself.
fn coerce_to_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => Some(*n),
        Value::Null => Some(0.0),
        Value::Boolean(true) => Some(1.0),
        Value::Boolean(false) => Some(0.0),
        _ => None,
    }
}

/// Collect all cell values from a range.
fn collect_range_values(
    start: &CellAddress,
    end: &CellAddress,
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Vec<Value> {
    let min_row = start.row.min(end.row);
    let max_row = start.row.max(end.row);
    let min_col = start.col.min(end.col);
    let max_col = start.col.max(end.col);

    let mut values = Vec::new();
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            let addr = CellAddress::new(row, col);
            if let Some(&id) = cell_map.get(&addr) {
                values.push(get(id));
            } else {
                values.push(Value::Null);
            }
        }
    }
    values
}

/// Collect values from a function argument, expanding ranges.
fn collect_arg_values(
    arg: &Expr,
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Vec<Value> {
    match arg {
        Expr::Range { start, end } => collect_range_values(start, end, get, cell_map),
        _ => vec![eval_expr(arg, get, cell_map)],
    }
}

fn eval_func(
    name: &str,
    args: &[Expr],
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Value {
    match name {
        "SUM" => {
            let mut total = 0.0;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    match v {
                        Value::Error(e) => return Value::Error(e),
                        Value::Number(n) => total += n,
                        Value::Null => {} // skip nulls
                        Value::Boolean(true) => total += 1.0,
                        Value::Boolean(false) => {}
                        Value::Text(_) => {} // skip text in SUM
                    }
                }
            }
            Value::Number(total)
        }

        "AVERAGE" => {
            let mut total = 0.0;
            let mut count = 0u64;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    match v {
                        Value::Error(e) => return Value::Error(e),
                        Value::Number(n) => {
                            total += n;
                            count += 1;
                        }
                        _ => {} // skip non-numbers
                    }
                }
            }
            if count == 0 {
                Value::Error(ValueError::DivisionByZero)
            } else {
                Value::Number(total / count as f64)
            }
        }

        "COUNT" => {
            let mut count = 0u64;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    if matches!(v, Value::Number(_)) {
                        count += 1;
                    }
                }
            }
            Value::Number(count as f64)
        }

        "IF" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let cond = eval_expr(&args[0], get, cell_map);
            let is_true = match cond {
                Value::Boolean(b) => b,
                Value::Number(n) => n != 0.0,
                Value::Error(e) => return Value::Error(e),
                _ => false,
            };
            if is_true {
                eval_expr(&args[1], get, cell_map)
            } else if args.len() == 3 {
                eval_expr(&args[2], get, cell_map)
            } else {
                Value::Boolean(false)
            }
        }

        "MIN" => {
            let mut min: Option<f64> = None;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    match v {
                        Value::Error(e) => return Value::Error(e),
                        Value::Number(n) => {
                            min = Some(min.map_or(n, |m: f64| m.min(n)));
                        }
                        _ => {}
                    }
                }
            }
            min.map_or(Value::Number(0.0), Value::Number)
        }

        "MAX" => {
            let mut max: Option<f64> = None;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    match v {
                        Value::Error(e) => return Value::Error(e),
                        Value::Number(n) => {
                            max = Some(max.map_or(n, |m: f64| m.max(n)));
                        }
                        _ => {}
                    }
                }
            }
            max.map_or(Value::Number(0.0), Value::Number)
        }

        _ => Value::Error(ValueError::InvalidName),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formula::parse_formula;

    fn make_test_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // Simulate: A1=10, B1=20, C1=0, A2=5, B2="text"
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();

        let a1 = AtomId::from_raw(0);
        let b1 = AtomId::from_raw(1);
        let c1 = AtomId::from_raw(2);
        let a2 = AtomId::from_raw(3);
        let b2 = AtomId::from_raw(4);

        cell_map.insert(CellAddress::new(0, 0), a1); // A1
        cell_map.insert(CellAddress::new(0, 1), b1); // B1
        cell_map.insert(CellAddress::new(0, 2), c1); // C1
        cell_map.insert(CellAddress::new(1, 0), a2); // A2
        cell_map.insert(CellAddress::new(1, 1), b2); // B2

        values.insert(a1, Value::Number(10.0));
        values.insert(b1, Value::Number(20.0));
        values.insert(c1, Value::Number(0.0));
        values.insert(a2, Value::Number(5.0));
        values.insert(b2, Value::Text("text".into()));

        (cell_map, values)
    }

    fn eval_str(formula: &str, cell_map: &HashMap<CellAddress, AtomId>, values: &HashMap<AtomId, Value>) -> Value {
        let expr = parse_formula(formula).expect("parse failed");
        let get = |id: AtomId| -> Value {
            values.get(&id).cloned().unwrap_or(Value::Null)
        };
        eval_expr(&expr, &get, cell_map)
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
        // (A1+B1)*2 = 60
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
        // SUM(A1:B1) = 10 + 20 = 30
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
        // COUNT(A1:B2) = A1(num), B1(num), A2(num), B2(text) → 3
        assert_eq!(eval_str("=COUNT(A1:B2)", &cm, &vs), Value::Number(3.0));
    }

    #[test]
    fn eval_if_true() {
        let (cm, vs) = make_test_env();
        // IF(A1, 100, 200) → A1=10 (truthy) → 100
        assert_eq!(eval_str("=IF(A1,100,200)", &cm, &vs), Value::Number(100.0));
    }

    #[test]
    fn eval_if_false() {
        let (cm, vs) = make_test_env();
        // IF(C1, 100, 200) → C1=0 (falsy) → 200
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
        // D1 doesn't exist → Null → 0
        assert_eq!(eval_str("=D1+5", &cm, &vs), Value::Number(5.0));
    }
}
