use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

use einfach_core::{Value, ValueError};

use crate::cell::CellReference;
use crate::formula::{BinOperator, Expr};

type CellResolver<'a> = dyn Fn(&CellReference) -> Value + 'a;
type RangeResolver<'a> = dyn Fn(&CellReference, &CellReference) -> Vec<Value> + 'a;
type FunctionHandler = for<'a> fn(&[Expr], &'a CellResolver<'a>, &'a RangeResolver<'a>) -> Value;

pub(super) fn eval_binop(op: BinOperator, left: &Value, right: &Value) -> Value {
    if let Value::Error(e) = left {
        return Value::Error(e.clone());
    }
    if let Value::Error(e) = right {
        return Value::Error(e.clone());
    }

    match op {
        BinOperator::Add | BinOperator::Sub | BinOperator::Mul | BinOperator::Div | BinOperator::Power => {
            let Some(left_num) = coerce_to_number(left) else {
                return Value::Error(ValueError::InvalidValue);
            };
            let Some(right_num) = coerce_to_number(right) else {
                return Value::Error(ValueError::InvalidValue);
            };

            match op {
                BinOperator::Add => Value::Number(left_num + right_num),
                BinOperator::Sub => Value::Number(left_num - right_num),
                BinOperator::Mul => Value::Number(left_num * right_num),
                BinOperator::Div => {
                    if right_num == 0.0 {
                        Value::Error(ValueError::DivisionByZero)
                    } else {
                        Value::Number(left_num / right_num)
                    }
                }
                BinOperator::Power => Value::Number(left_num.powf(right_num)),
                _ => unreachable!(),
            }
        }
        BinOperator::Concat => match (value_to_text(left), value_to_text(right)) {
            (Ok(left_text), Ok(right_text)) => Value::Text(format!("{left_text}{right_text}")),
            (Err(e), _) | (_, Err(e)) => Value::Error(e),
        },
        BinOperator::Equal
        | BinOperator::NotEqual
        | BinOperator::Less
        | BinOperator::LessOrEqual
        | BinOperator::Greater
        | BinOperator::GreaterOrEqual => {
            let Ok(ordering) = compare_values(left, right) else {
                return Value::Error(ValueError::InvalidValue);
            };

            let matched = match op {
                BinOperator::Equal => ordering == Ordering::Equal,
                BinOperator::NotEqual => ordering != Ordering::Equal,
                BinOperator::Less => ordering == Ordering::Less,
                BinOperator::LessOrEqual => ordering != Ordering::Greater,
                BinOperator::Greater => ordering == Ordering::Greater,
                BinOperator::GreaterOrEqual => ordering != Ordering::Less,
                _ => unreachable!(),
            };
            Value::Boolean(matched)
        }
    }
}

pub(super) fn eval_func(
    name: &str,
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let registry = function_registry();
    if let Some(handler) = registry.get(name) {
        handler(args, resolve_cell, resolve_range)
    } else {
        Value::Error(ValueError::InvalidName)
    }
}

pub(super) fn coerce_to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => Some(*n),
        Value::Null => Some(0.0),
        Value::Boolean(true) => Some(1.0),
        Value::Boolean(false) => Some(0.0),
        _ => None,
    }
}

fn coerce_to_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Boolean(b) => Some(*b),
        Value::Number(n) => Some(*n != 0.0),
        Value::Null => Some(false),
        _ => None,
    }
}

fn value_to_text(value: &Value) -> Result<String, ValueError> {
    match value {
        Value::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                Ok(format!("{}", *n as i64))
            } else {
                Ok(format!("{}", n))
            }
        }
        Value::Text(text) => Ok(text.clone()),
        Value::Boolean(true) => Ok("TRUE".into()),
        Value::Boolean(false) => Ok("FALSE".into()),
        Value::Null => Ok(String::new()),
        Value::Error(e) => Err(e.clone()),
    }
}

fn compare_values(left: &Value, right: &Value) -> Result<Ordering, ValueError> {
    match (left, right) {
        (Value::Text(left_text), Value::Text(right_text)) => Ok(left_text.cmp(right_text)),
        (Value::Boolean(left_bool), Value::Boolean(right_bool)) => Ok(left_bool.cmp(right_bool)),
        _ => {
            let Some(left_num) = coerce_to_number(left) else {
                return Err(ValueError::InvalidValue);
            };
            let Some(right_num) = coerce_to_number(right) else {
                return Err(ValueError::InvalidValue);
            };

            left_num
                .partial_cmp(&right_num)
                .ok_or(ValueError::InvalidValue)
        }
    }
}

fn collect_range_values(
    start: &CellReference,
    end: &CellReference,
    resolve_range: &RangeResolver<'_>,
) -> Vec<Value> {
    if start.is_invalid() || end.is_invalid() {
        return vec![Value::Error(ValueError::InvalidRef)];
    }
    resolve_range(start, end)
}

fn collect_arg_values(
    arg: &Expr,
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Vec<Value> {
    match arg {
        Expr::Range { start, end } => collect_range_values(start, end, resolve_range),
        _ => vec![super::eval_expr(arg, resolve_cell, resolve_range)],
    }
}

fn collect_first_arg_values(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Result<Vec<Value>, ValueError> {
    let Some(first) = args.first() else {
        return Err(ValueError::InvalidValue);
    };
    Ok(collect_arg_values(first, resolve_cell, resolve_range))
}

fn expect_arg_count(args: &[Expr], min: usize, max: usize) -> Result<(), ValueError> {
    if args.len() < min || args.len() > max {
        Err(ValueError::InvalidValue)
    } else {
        Ok(())
    }
}

fn eval_single_value(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Result<Value, ValueError> {
    expect_arg_count(args, 1, 1)?;
    let value = super::eval_expr(&args[0], resolve_cell, resolve_range);
    if let Value::Error(e) = &value {
        return Err(e.clone());
    }
    Ok(value)
}

fn eval_number_arg(
    expr: &Expr,
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Result<f64, ValueError> {
    let value = super::eval_expr(expr, resolve_cell, resolve_range);
    if let Value::Error(e) = &value {
        return Err(e.clone());
    }
    coerce_to_number(&value).ok_or(ValueError::InvalidValue)
}

fn eval_text_arg(
    expr: &Expr,
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Result<String, ValueError> {
    let value = super::eval_expr(expr, resolve_cell, resolve_range);
    value_to_text(&value)
}

fn eval_bool_arg(
    expr: &Expr,
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Result<bool, ValueError> {
    let value = super::eval_expr(expr, resolve_cell, resolve_range);
    if let Value::Error(e) = &value {
        return Err(e.clone());
    }
    coerce_to_bool(&value).ok_or(ValueError::InvalidValue)
}

fn function_registry() -> &'static HashMap<&'static str, FunctionHandler> {
    static REGISTRY: OnceLock<HashMap<&'static str, FunctionHandler>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        HashMap::from([
            ("SUM", sum_fn as FunctionHandler),
            ("AVERAGE", average_fn as FunctionHandler),
            ("COUNT", count_fn as FunctionHandler),
            ("IF", if_fn as FunctionHandler),
            ("MIN", min_fn as FunctionHandler),
            ("MAX", max_fn as FunctionHandler),
            ("AND", and_fn as FunctionHandler),
            ("OR", or_fn as FunctionHandler),
            ("NOT", not_fn as FunctionHandler),
            ("ABS", abs_fn as FunctionHandler),
            ("ROUND", round_fn as FunctionHandler),
            ("CEILING", ceiling_fn as FunctionHandler),
            ("FLOOR", floor_fn as FunctionHandler),
            ("SQRT", sqrt_fn as FunctionHandler),
            ("POWER", power_fn as FunctionHandler),
            ("MOD", mod_fn as FunctionHandler),
            ("CONCATENATE", concatenate_fn as FunctionHandler),
            ("LEN", len_fn as FunctionHandler),
            ("LEFT", left_fn as FunctionHandler),
            ("RIGHT", right_fn as FunctionHandler),
            ("MID", mid_fn as FunctionHandler),
            ("UPPER", upper_fn as FunctionHandler),
            ("LOWER", lower_fn as FunctionHandler),
            ("TRIM", trim_fn as FunctionHandler),
            ("TEXT", text_fn as FunctionHandler),
            ("COUNTIF", countif_fn as FunctionHandler),
            ("SUMIF", sumif_fn as FunctionHandler),
        ])
    })
}

fn sum_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let mut total = 0.0;
    for arg in args {
        for value in collect_arg_values(arg, resolve_cell, resolve_range) {
            match value {
                Value::Error(e) => return Value::Error(e),
                Value::Number(n) => total += n,
                Value::Boolean(true) => total += 1.0,
                Value::Boolean(false) | Value::Null | Value::Text(_) => {}
            }
        }
    }
    Value::Number(total)
}

fn average_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let mut total = 0.0;
    let mut count = 0u64;
    for arg in args {
        for value in collect_arg_values(arg, resolve_cell, resolve_range) {
            match value {
                Value::Error(e) => return Value::Error(e),
                Value::Number(n) => {
                    total += n;
                    count += 1;
                }
                _ => {}
            }
        }
    }

    if count == 0 {
        Value::Error(ValueError::DivisionByZero)
    } else {
        Value::Number(total / count as f64)
    }
}

fn count_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let mut count = 0u64;
    for arg in args {
        for value in collect_arg_values(arg, resolve_cell, resolve_range) {
            if matches!(value, Value::Number(_)) {
                count += 1;
            }
        }
    }
    Value::Number(count as f64)
}

fn if_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 2, 3).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let condition = super::eval_expr(&args[0], resolve_cell, resolve_range);
    let is_true = match condition {
        Value::Boolean(value) => value,
        Value::Number(value) => value != 0.0,
        Value::Null => false,
        Value::Error(e) => return Value::Error(e),
        Value::Text(_) => false,
    };

    if is_true {
        super::eval_expr(&args[1], resolve_cell, resolve_range)
    } else if args.len() == 3 {
        super::eval_expr(&args[2], resolve_cell, resolve_range)
    } else {
        Value::Boolean(false)
    }
}

fn min_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let mut min_value: Option<f64> = None;
    for arg in args {
        for value in collect_arg_values(arg, resolve_cell, resolve_range) {
            match value {
                Value::Error(e) => return Value::Error(e),
                Value::Number(n) => {
                    min_value = Some(min_value.map_or(n, |current| current.min(n)));
                }
                _ => {}
            }
        }
    }
    min_value.map_or(Value::Number(0.0), Value::Number)
}

fn max_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let mut max_value: Option<f64> = None;
    for arg in args {
        for value in collect_arg_values(arg, resolve_cell, resolve_range) {
            match value {
                Value::Error(e) => return Value::Error(e),
                Value::Number(n) => {
                    max_value = Some(max_value.map_or(n, |current| current.max(n)));
                }
                _ => {}
            }
        }
    }
    max_value.map_or(Value::Number(0.0), Value::Number)
}

fn and_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.is_empty() {
        return Value::Error(ValueError::InvalidValue);
    }

    for arg in args {
        let Ok(value) = eval_bool_arg(arg, resolve_cell, resolve_range) else {
            return Value::Error(ValueError::InvalidValue);
        };
        if !value {
            return Value::Boolean(false);
        }
    }

    Value::Boolean(true)
}

fn or_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.is_empty() {
        return Value::Error(ValueError::InvalidValue);
    }

    for arg in args {
        let Ok(value) = eval_bool_arg(arg, resolve_cell, resolve_range) else {
            return Value::Error(ValueError::InvalidValue);
        };
        if value {
            return Value::Boolean(true);
        }
    }

    Value::Boolean(false)
}

fn not_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match coerce_to_bool(&value) {
            Some(boolean) => Value::Boolean(!boolean),
            None => Value::Error(ValueError::InvalidValue),
        },
        Err(e) => Value::Error(e),
    }
}

fn abs_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match coerce_to_number(&value) {
            Some(number) => Value::Number(number.abs()),
            None => Value::Error(ValueError::InvalidValue),
        },
        Err(e) => Value::Error(e),
    }
}

fn round_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 2, 2).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(number) = eval_number_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let Ok(digits) = eval_number_arg(&args[1], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };

    Value::Number(round_with_digits(number, digits as i32))
}

fn ceiling_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(number) = eval_number_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let significance = if args.len() == 2 {
        match eval_number_arg(&args[1], resolve_cell, resolve_range) {
            Ok(value) => value.abs(),
            Err(e) => return Value::Error(e),
        }
    } else {
        1.0
    };

    if significance == 0.0 {
        Value::Number(0.0)
    } else {
        Value::Number((number / significance).ceil() * significance)
    }
}

fn floor_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(number) = eval_number_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let significance = if args.len() == 2 {
        match eval_number_arg(&args[1], resolve_cell, resolve_range) {
            Ok(value) => value.abs(),
            Err(e) => return Value::Error(e),
        }
    } else {
        1.0
    };

    if significance == 0.0 {
        Value::Number(0.0)
    } else {
        Value::Number((number / significance).floor() * significance)
    }
}

fn sqrt_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match coerce_to_number(&value) {
            Some(number) if number >= 0.0 => Value::Number(number.sqrt()),
            Some(_) => Value::Error(ValueError::InvalidValue),
            None => Value::Error(ValueError::InvalidValue),
        },
        Err(e) => Value::Error(e),
    }
}

fn power_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 2, 2).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(number) = eval_number_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let Ok(power) = eval_number_arg(&args[1], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };

    Value::Number(number.powf(power))
}

fn mod_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 2, 2).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(number) = eval_number_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let Ok(divisor) = eval_number_arg(&args[1], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };

    if divisor == 0.0 {
        Value::Error(ValueError::DivisionByZero)
    } else {
        Value::Number(number - divisor * (number / divisor).floor())
    }
}

fn concatenate_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    let mut output = String::new();
    for arg in args {
        for value in collect_arg_values(arg, resolve_cell, resolve_range) {
            match value_to_text(&value) {
                Ok(text) => output.push_str(&text),
                Err(e) => return Value::Error(e),
            }
        }
    }
    Value::Text(output)
}

fn len_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match value_to_text(&value) {
            Ok(text) => Value::Number(text.chars().count() as f64),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

fn left_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(text) = eval_text_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let count = if args.len() == 2 {
        match eval_number_arg(&args[1], resolve_cell, resolve_range) {
            Ok(value) if value >= 0.0 => value as usize,
            Ok(_) => return Value::Error(ValueError::InvalidValue),
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };

    Value::Text(text.chars().take(count).collect())
}

fn right_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(text) = eval_text_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let count = if args.len() == 2 {
        match eval_number_arg(&args[1], resolve_cell, resolve_range) {
            Ok(value) if value >= 0.0 => value as usize,
            Ok(_) => return Value::Error(ValueError::InvalidValue),
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };

    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(count);
    Value::Text(chars[start..].iter().collect())
}

fn mid_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 3, 3).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(text) = eval_text_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let Ok(start) = eval_number_arg(&args[1], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let Ok(length) = eval_number_arg(&args[2], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };

    if start < 1.0 || length < 0.0 {
        return Value::Error(ValueError::InvalidValue);
    }

    let chars: Vec<char> = text.chars().collect();
    let start_index = (start as usize).saturating_sub(1);
    let length = length as usize;
    Value::Text(chars.into_iter().skip(start_index).take(length).collect())
}

fn upper_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match value_to_text(&value) {
            Ok(text) => Value::Text(text.to_uppercase()),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

fn lower_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match value_to_text(&value) {
            Ok(text) => Value::Text(text.to_lowercase()),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

fn trim_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    match eval_single_value(args, resolve_cell, resolve_range) {
        Ok(value) => match value_to_text(&value) {
            Ok(text) => Value::Text(text.split_whitespace().collect::<Vec<_>>().join(" ")),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

fn text_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 2, 2).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let Ok(number) = eval_number_arg(&args[0], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };
    let Ok(format_text) = eval_text_arg(&args[1], resolve_cell, resolve_range) else {
        return Value::Error(ValueError::InvalidValue);
    };

    match apply_text_format(number, &format_text) {
        Some(text) => Value::Text(text),
        None => Value::Error(ValueError::InvalidValue),
    }
}

fn countif_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if expect_arg_count(args, 2, 2).is_err() {
        return Value::Error(ValueError::InvalidValue);
    }

    let range_values = match collect_first_arg_values(args, resolve_cell, resolve_range) {
        Ok(values) => values,
        Err(e) => return Value::Error(e),
    };

    let criterion = match build_criterion(&args[1], resolve_cell, resolve_range) {
        Ok(criterion) => criterion,
        Err(e) => return Value::Error(e),
    };

    let mut count = 0usize;
    for value in range_values {
        match value {
            Value::Error(e) => return Value::Error(e),
            _ if criterion_matches(&value, &criterion) => count += 1,
            _ => {}
        }
    }

    Value::Number(count as f64)
}

fn sumif_fn(
    args: &[Expr],
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ValueError::InvalidValue);
    }

    let criteria_range = match collect_arg_values(&args[0], resolve_cell, resolve_range) {
        values => values,
    };
    let sum_range = if args.len() == 3 {
        collect_arg_values(&args[2], resolve_cell, resolve_range)
    } else {
        criteria_range.clone()
    };

    let criterion = match build_criterion(&args[1], resolve_cell, resolve_range) {
        Ok(criterion) => criterion,
        Err(e) => return Value::Error(e),
    };

    let mut total = 0.0;
    for (criteria_value, sum_value) in criteria_range.iter().zip(sum_range.iter()) {
        if let Value::Error(e) = criteria_value {
            return Value::Error(e.clone());
        }
        if let Value::Error(e) = sum_value {
            return Value::Error(e.clone());
        }

        if criterion_matches(criteria_value, &criterion) {
            let Some(number) = coerce_to_number(sum_value) else {
                return Value::Error(ValueError::InvalidValue);
            };
            total += number;
        }
    }

    Value::Number(total)
}

#[derive(Clone)]
struct Criterion {
    op: BinOperator,
    value: Value,
}

fn build_criterion(
    expr: &Expr,
    resolve_cell: &CellResolver<'_>,
    resolve_range: &RangeResolver<'_>,
) -> Result<Criterion, ValueError> {
    let raw = super::eval_expr(expr, resolve_cell, resolve_range);
    if let Value::Error(e) = &raw {
        return Err(e.clone());
    }

    match raw {
        Value::Text(text) => parse_text_criterion(&text),
        value => Ok(Criterion {
            op: BinOperator::Equal,
            value,
        }),
    }
}

fn parse_text_criterion(text: &str) -> Result<Criterion, ValueError> {
    let trimmed = text.trim();
    let (op, remainder) = if let Some(rest) = trimmed.strip_prefix("<=") {
        (BinOperator::LessOrEqual, rest)
    } else if let Some(rest) = trimmed.strip_prefix(">=") {
        (BinOperator::GreaterOrEqual, rest)
    } else if let Some(rest) = trimmed.strip_prefix("<>") {
        (BinOperator::NotEqual, rest)
    } else if let Some(rest) = trimmed.strip_prefix('<') {
        (BinOperator::Less, rest)
    } else if let Some(rest) = trimmed.strip_prefix('>') {
        (BinOperator::Greater, rest)
    } else if let Some(rest) = trimmed.strip_prefix('=') {
        (BinOperator::Equal, rest)
    } else {
        (BinOperator::Equal, trimmed)
    };

    let operand = parse_criterion_operand(remainder.trim());
    Ok(Criterion { op, value: operand })
}

fn parse_criterion_operand(text: &str) -> Value {
    if text.is_empty() {
        return Value::Text(String::new());
    }

    if text.eq_ignore_ascii_case("TRUE") {
        return Value::Boolean(true);
    }
    if text.eq_ignore_ascii_case("FALSE") {
        return Value::Boolean(false);
    }

    if let Ok(number) = text.parse::<f64>() {
        return Value::Number(number);
    }

    Value::Text(text.to_string())
}

fn criterion_matches(value: &Value, criterion: &Criterion) -> bool {
    let comparison = compare_values(value, &criterion.value);
    let Ok(ordering) = comparison else {
        return false;
    };

    match criterion.op {
        BinOperator::Equal => ordering == Ordering::Equal,
        BinOperator::NotEqual => ordering != Ordering::Equal,
        BinOperator::Less => ordering == Ordering::Less,
        BinOperator::LessOrEqual => ordering != Ordering::Greater,
        BinOperator::Greater => ordering == Ordering::Greater,
        BinOperator::GreaterOrEqual => ordering != Ordering::Less,
        _ => false,
    }
}

fn round_with_digits(number: f64, digits: i32) -> f64 {
    if digits >= 0 {
        let factor = 10f64.powi(digits);
        (number * factor).round() / factor
    } else {
        let factor = 10f64.powi(-digits);
        (number / factor).round() * factor
    }
}

fn apply_text_format(number: f64, format_text: &str) -> Option<String> {
    if format_text.is_empty() {
        return Some(String::new());
    }

    let percent = format_text.contains('%');
    let decimal_digits = format_text
        .split('.')
        .nth(1)
        .map(|fraction| {
            fraction
                .chars()
                .take_while(|ch| matches!(ch, '0' | '#' | '%'))
                .filter(|ch| *ch == '0' || *ch == '#')
                .count()
        })
        .unwrap_or(0);
    let use_grouping = format_text.contains(',');

    let mut value = if percent { number * 100.0 } else { number };
    value = round_with_digits(value, decimal_digits as i32);

    let core_pattern: String = format_text
        .chars()
        .filter(|ch| matches!(ch, '0' | '#' | '.' | ','))
        .collect();
    if core_pattern.is_empty() {
        return None;
    }

    let prefix = format_text
        .chars()
        .take_while(|ch| !matches!(ch, '0' | '#' | '.' | ','))
        .collect::<String>();
    let suffix = format_text
        .chars()
        .rev()
        .take_while(|ch| !matches!(ch, '0' | '#' | '.' | ','))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();

    let sign = if value.is_sign_negative() { "-" } else { "" };
    let abs_value = value.abs();
    let base = if use_grouping {
        format_with_grouping(abs_value, decimal_digits)
    } else {
        format!("{abs_value:.decimal_digits$}")
    };

    Some(format!("{sign}{prefix}{base}{suffix}"))
}

fn format_with_grouping(number: f64, decimal_digits: usize) -> String {
    let base = format!("{number:.decimal_digits$}");
    let mut parts = base.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();

    let mut grouped = String::new();
    for (index, ch) in integer.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let integer_grouped: String = grouped.chars().rev().collect();

    match fraction {
        Some(value) if decimal_digits > 0 => format!("{integer_grouped}.{value}"),
        _ => integer_grouped,
    }
}
