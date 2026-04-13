use einfach_core::{Value, ValueError};

use crate::cell::CellReference;
use crate::formula::Expr;

mod helpers;

#[cfg(test)]
mod tests;

use helpers::{eval_binop, eval_func};

/// Evaluate an AST expression using a getter function for cell values.
pub fn eval_expr(
    expr: &Expr,
    resolve_cell: &dyn Fn(&CellReference) -> Value,
    resolve_range: &dyn Fn(&CellReference, &CellReference) -> Vec<Value>,
) -> Value {
    match expr {
        Expr::Number(n) => Value::Number(*n),
        Expr::Text(s) => Value::Text(s.clone()),
        Expr::Boolean(b) => Value::Boolean(*b),
        Expr::Error(error) => Value::Error(error.clone()),
        Expr::CellRef(reference) => resolve_cell(reference),
        Expr::BinOp { op, left, right } => {
            let lv = eval_expr(left, resolve_cell, resolve_range);
            let rv = eval_expr(right, resolve_cell, resolve_range);
            eval_binop(*op, &lv, &rv)
        }
        Expr::Negate(inner) => {
            let v = eval_expr(inner, resolve_cell, resolve_range);
            match v {
                Value::Number(n) => Value::Number(-n),
                Value::Error(e) => Value::Error(e),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        Expr::FuncCall { name, args } => eval_func(name, args, resolve_cell, resolve_range),
        Expr::Range { start, end } => {
            let values = resolve_range(start, end);
            if values.len() == 1 {
                return values[0].clone();
            }
            Value::Error(ValueError::InvalidValue)
        }
    }
}
