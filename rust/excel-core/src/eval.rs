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

    // Concat is the only string-yielding op; handle separately so we don't
    // require both sides to be numeric.
    if let BinOperator::Concat = op {
        return Value::Text(format!("{}{}", coerce_to_text(left), coerce_to_text(right)));
    }

    // Comparisons accept mixed types and return Boolean. Numeric comparison
    // when both sides are numeric, otherwise lexicographic on display text.
    let is_cmp = matches!(
        op,
        BinOperator::Eq
            | BinOperator::NotEq
            | BinOperator::Lt
            | BinOperator::LtEq
            | BinOperator::Gt
            | BinOperator::GtEq
    );
    if is_cmp {
        return Value::Boolean(eval_compare(op, left, right));
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
            BinOperator::Pow => {
                let result = l.powf(r);
                if result.is_finite() {
                    Value::Number(result)
                } else if l == 0.0 && r < 0.0 {
                    Value::Error(ValueError::DivisionByZero) // 0^negative
                } else {
                    Value::Error(ValueError::InvalidValue)
                }
            }
            // Concat / comparisons handled above
            _ => Value::Error(ValueError::InvalidValue),
        },
        _ => Value::Error(ValueError::InvalidValue),
    }
}

fn coerce_to_text(v: &Value) -> String {
    match v {
        Value::Text(s) => s.clone(),
        Value::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Value::Boolean(true) => "TRUE".into(),
        Value::Boolean(false) => "FALSE".into(),
        Value::Null => String::new(),
        Value::Error(e) => format!("{}", e),
    }
}

fn eval_compare(op: BinOperator, l: &Value, r: &Value) -> bool {
    let cmp = if let (Some(ln), Some(rn)) = (coerce_to_number(l), coerce_to_number(r)) {
        ln.partial_cmp(&rn)
    } else {
        coerce_to_text(l).partial_cmp(&coerce_to_text(r))
    };
    let cmp = match cmp {
        Some(c) => c,
        // NaN-vs-anything: only Eq compares true if both are NaN values; we
        // already covered numeric NaN via partial_cmp returning None — treat
        // as not-equal for inequality ops.
        None => return matches!(op, BinOperator::NotEq),
    };
    use std::cmp::Ordering::*;
    match (op, cmp) {
        (BinOperator::Eq, Equal) => true,
        (BinOperator::NotEq, Equal) => false,
        (BinOperator::NotEq, _) => true,
        (BinOperator::Lt, Less) => true,
        (BinOperator::LtEq, Less | Equal) => true,
        (BinOperator::Gt, Greater) => true,
        (BinOperator::GtEq, Greater | Equal) => true,
        _ => false,
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

        // === Logical ===
        "AND" => {
            let mut result = true;
            let mut saw_any = false;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    match v {
                        Value::Error(e) => return Value::Error(e),
                        Value::Null => {}
                        other => {
                            if let Some(b) = coerce_to_bool(&other) {
                                saw_any = true;
                                result = result && b;
                            } else {
                                return Value::Error(ValueError::InvalidValue);
                            }
                        }
                    }
                }
            }
            if !saw_any {
                Value::Error(ValueError::InvalidValue)
            } else {
                Value::Boolean(result)
            }
        }
        "OR" => {
            let mut result = false;
            let mut saw_any = false;
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    match v {
                        Value::Error(e) => return Value::Error(e),
                        Value::Null => {}
                        other => {
                            if let Some(b) = coerce_to_bool(&other) {
                                saw_any = true;
                                result = result || b;
                            } else {
                                return Value::Error(ValueError::InvalidValue);
                            }
                        }
                    }
                }
            }
            if !saw_any {
                Value::Error(ValueError::InvalidValue)
            } else {
                Value::Boolean(result)
            }
        }
        "NOT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::InvalidValue);
            }
            let v = eval_expr(&args[0], get, cell_map);
            match coerce_to_bool(&v) {
                Some(b) => Value::Boolean(!b),
                None => match v {
                    Value::Error(e) => Value::Error(e),
                    _ => Value::Error(ValueError::InvalidValue),
                },
            }
        }

        // === Math ===
        "ABS" => unary_number(args, get, cell_map, |n| n.abs()),
        "SQRT" => unary_number(args, get, cell_map, |n| {
            if n < 0.0 {
                f64::NAN
            } else {
                n.sqrt()
            }
        }),
        "ROUND" => {
            // ROUND(value, digits)
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let n = eval_expr(&args[0], get, cell_map);
            let d = eval_expr(&args[1], get, cell_map);
            match (coerce_to_number(&n), coerce_to_number(&d)) {
                (Some(value), Some(digits)) => {
                    let factor = 10f64.powi(digits as i32);
                    Value::Number((value * factor).round() / factor)
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "CEILING" => unary_number(args, get, cell_map, f64::ceil),
        "FLOOR" => unary_number(args, get, cell_map, f64::floor),
        "POWER" => {
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let b = eval_expr(&args[0], get, cell_map);
            let e = eval_expr(&args[1], get, cell_map);
            match (coerce_to_number(&b), coerce_to_number(&e)) {
                (Some(base), Some(exp)) => {
                    let r = base.powf(exp);
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::InvalidValue)
                    }
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "MOD" => {
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let a = eval_expr(&args[0], get, cell_map);
            let b = eval_expr(&args[1], get, cell_map);
            match (coerce_to_number(&a), coerce_to_number(&b)) {
                (Some(_), Some(0.0)) => Value::Error(ValueError::DivisionByZero),
                (Some(va), Some(vb)) => Value::Number(va.rem_euclid(vb)),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }

        // === Text ===
        "CONCATENATE" => {
            let mut out = String::new();
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    if let Value::Error(e) = v {
                        return Value::Error(e);
                    }
                    out.push_str(&coerce_to_text(&v));
                }
            }
            Value::Text(out)
        }
        "LEN" => {
            if args.len() != 1 {
                return Value::Error(ValueError::InvalidValue);
            }
            let v = eval_expr(&args[0], get, cell_map);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            Value::Number(coerce_to_text(&v).chars().count() as f64)
        }
        "LEFT" => text_slice(args, get, cell_map, |s, n| s.chars().take(n).collect()),
        "RIGHT" => text_slice(args, get, cell_map, |s, n| {
            let len = s.chars().count();
            s.chars().skip(len.saturating_sub(n)).collect()
        }),
        "MID" => {
            // MID(text, start, length) — start is 1-based
            if args.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let s = coerce_to_text(&eval_expr(&args[0], get, cell_map));
            let start_v = eval_expr(&args[1], get, cell_map);
            let len_v = eval_expr(&args[2], get, cell_map);
            match (coerce_to_number(&start_v), coerce_to_number(&len_v)) {
                (Some(start), Some(len)) if start >= 1.0 && len >= 0.0 => {
                    let skip = (start as usize).saturating_sub(1);
                    let take = len as usize;
                    Value::Text(s.chars().skip(skip).take(take).collect())
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "UPPER" => text_unary(args, get, cell_map, |s| s.to_uppercase()),
        "LOWER" => text_unary(args, get, cell_map, |s| s.to_lowercase()),
        "TRIM" => text_unary(args, get, cell_map, |s| s.trim().to_string()),

        // === Conditional aggregates ===
        "COUNTIF" => {
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let criterion = eval_expr(&args[1], get, cell_map);
            let values = collect_arg_values(&args[0], get, cell_map);
            let mut count = 0u64;
            for v in values {
                if matches_criterion(&v, &criterion) {
                    count += 1;
                }
            }
            Value::Number(count as f64)
        }
        "SUMIF" => {
            // SUMIF(range, criterion[, sum_range])
            if args.len() != 2 && args.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let criterion = eval_expr(&args[1], get, cell_map);
            let range_values = collect_arg_values(&args[0], get, cell_map);
            let sum_values = if args.len() == 3 {
                collect_arg_values(&args[2], get, cell_map)
            } else {
                range_values.clone()
            };
            let mut total = 0.0;
            for (i, v) in range_values.iter().enumerate() {
                if matches_criterion(v, &criterion) {
                    if let Some(target) = sum_values.get(i) {
                        if let Some(n) = coerce_to_number(target) {
                            total += n;
                        }
                    }
                }
            }
            Value::Number(total)
        }

        _ => Value::Error(ValueError::InvalidName),
    }
}

fn coerce_to_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Boolean(b) => Some(*b),
        Value::Number(n) => Some(*n != 0.0),
        _ => None,
    }
}

fn unary_number(
    args: &[Expr],
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
    f: impl Fn(f64) -> f64,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::InvalidValue);
    }
    let v = eval_expr(&args[0], get, cell_map);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    match coerce_to_number(&v) {
        Some(n) => {
            let r = f(n);
            if r.is_finite() {
                Value::Number(r)
            } else {
                Value::Error(ValueError::InvalidValue)
            }
        }
        None => Value::Error(ValueError::InvalidValue),
    }
}

fn text_unary(
    args: &[Expr],
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
    f: impl Fn(&str) -> String,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::InvalidValue);
    }
    let v = eval_expr(&args[0], get, cell_map);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    Value::Text(f(&coerce_to_text(&v)))
}

fn text_slice(
    args: &[Expr],
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
    take: impl Fn(&str, usize) -> String,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::InvalidValue);
    }
    let s = coerce_to_text(&eval_expr(&args[0], get, cell_map));
    let n = if args.len() == 2 {
        match coerce_to_number(&eval_expr(&args[1], get, cell_map)) {
            Some(n) if n >= 0.0 => n as usize,
            _ => return Value::Error(ValueError::InvalidValue),
        }
    } else {
        1
    };
    Value::Text(take(&s, n))
}

/// Match a value against a SUMIF/COUNTIF criterion. Supports:
/// - Bare values: equality
/// - Text starting with `>`, `<`, `>=`, `<=`, `<>`, `=` followed by a number
fn matches_criterion(v: &Value, criterion: &Value) -> bool {
    let crit_text = coerce_to_text(criterion);
    // Try operator prefix forms first.
    let (op, rest) = parse_criterion_op(&crit_text);
    if let Some(target_n) = rest.parse::<f64>().ok() {
        if let Some(vn) = coerce_to_number(v) {
            return match op {
                ">" => vn > target_n,
                ">=" => vn >= target_n,
                "<" => vn < target_n,
                "<=" => vn <= target_n,
                "<>" => vn != target_n,
                _ => vn == target_n,
            };
        }
    }
    // Fallback: text equality (Excel-compatible default).
    coerce_to_text(v) == rest
}

fn parse_criterion_op(s: &str) -> (&str, &str) {
    for op in ["<>", ">=", "<=", ">", "<", "="] {
        if let Some(rest) = s.strip_prefix(op) {
            return (op, rest);
        }
    }
    ("=", s)
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

    // === Phase 2 tests ===

    #[test]
    fn eval_pow() {
        let (cm, vs) = make_test_env();
        // 2^3 = 8
        assert_eq!(eval_str("=2^3", &cm, &vs), Value::Number(8.0));
        // right-associative: 2^3^2 = 2^(3^2) = 2^9 = 512
        assert_eq!(eval_str("=2^3^2", &cm, &vs), Value::Number(512.0));
    }

    #[test]
    fn eval_concat_string() {
        let (cm, vs) = make_test_env();
        // B2 = "text"; A1 = 10
        assert_eq!(
            eval_str("=B2&A1", &cm, &vs),
            Value::Text("text10".into())
        );
    }

    #[test]
    fn eval_comparison_returns_boolean() {
        let (cm, vs) = make_test_env();
        // A1=10, B1=20
        assert_eq!(eval_str("=A1<B1", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=A1>B1", &cm, &vs), Value::Boolean(false));
        assert_eq!(eval_str("=A1=10", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=A1<>10", &cm, &vs), Value::Boolean(false));
        assert_eq!(eval_str("=A1<=10", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=A1>=10", &cm, &vs), Value::Boolean(true));
    }

    #[test]
    fn eval_if_with_comparison() {
        let (cm, vs) = make_test_env();
        // IF(A1>5, "big", "small") — A1=10 → "big"
        assert_eq!(
            eval_str("=IF(A1>5,\"big\",\"small\")", &cm, &vs),
            Value::Text("big".into())
        );
    }

    #[test]
    fn eval_logical_and() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=AND(A1>0,B1>0)", &cm, &vs),
            Value::Boolean(true)
        );
        assert_eq!(
            eval_str("=AND(A1>100,B1>0)", &cm, &vs),
            Value::Boolean(false)
        );
    }

    #[test]
    fn eval_logical_or_not() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=OR(A1>100,B1>0)", &cm, &vs),
            Value::Boolean(true)
        );
        assert_eq!(eval_str("=NOT(A1>5)", &cm, &vs), Value::Boolean(false));
    }

    #[test]
    fn eval_math_funcs() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ABS(-7)", &cm, &vs), Value::Number(7.0));
        assert_eq!(eval_str("=SQRT(16)", &cm, &vs), Value::Number(4.0));
        assert_eq!(eval_str("=ROUND(3.14159,2)", &cm, &vs), Value::Number(3.14));
        assert_eq!(eval_str("=CEILING(3.2)", &cm, &vs), Value::Number(4.0));
        assert_eq!(eval_str("=FLOOR(3.9)", &cm, &vs), Value::Number(3.0));
        assert_eq!(eval_str("=POWER(2,10)", &cm, &vs), Value::Number(1024.0));
        assert_eq!(eval_str("=MOD(10,3)", &cm, &vs), Value::Number(1.0));
    }

    #[test]
    fn eval_text_funcs() {
        let (cm, vs) = make_test_env();
        // B2 = "text"
        assert_eq!(
            eval_str("=CONCATENATE(B2,\" \",A1)", &cm, &vs),
            Value::Text("text 10".into())
        );
        assert_eq!(eval_str("=LEN(B2)", &cm, &vs), Value::Number(4.0));
        assert_eq!(
            eval_str("=LEFT(B2,2)", &cm, &vs),
            Value::Text("te".into())
        );
        assert_eq!(
            eval_str("=RIGHT(B2,2)", &cm, &vs),
            Value::Text("xt".into())
        );
        assert_eq!(
            eval_str("=MID(B2,2,2)", &cm, &vs),
            Value::Text("ex".into())
        );
        assert_eq!(
            eval_str("=UPPER(B2)", &cm, &vs),
            Value::Text("TEXT".into())
        );
        assert_eq!(
            eval_str("=LOWER(\"HELLO\")", &cm, &vs),
            Value::Text("hello".into())
        );
        assert_eq!(
            eval_str("=TRIM(\"  hi  \")", &cm, &vs),
            Value::Text("hi".into())
        );
    }

    #[test]
    fn eval_countif_sumif() {
        let (cm, vs) = make_test_env();
        // A1=10, B1=20, C1=0, A2=5, B2="text"
        // COUNTIF range A1:B1, value > 5 → A1=10, B1=20 → 2
        assert_eq!(
            eval_str("=COUNTIF(A1:B1,\">5\")", &cm, &vs),
            Value::Number(2.0)
        );
        // SUMIF: same range, > 5 → 10 + 20 = 30
        assert_eq!(
            eval_str("=SUMIF(A1:B1,\">5\")", &cm, &vs),
            Value::Number(30.0)
        );
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
