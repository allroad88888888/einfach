use super::{parse_formula, BinOperator, Expr};

fn precedence(op: BinOperator) -> u8 {
    match op {
        BinOperator::Equal
        | BinOperator::NotEqual
        | BinOperator::Less
        | BinOperator::LessOrEqual
        | BinOperator::Greater
        | BinOperator::GreaterOrEqual => 1,
        BinOperator::Concat => 2,
        BinOperator::Add | BinOperator::Sub => 3,
        BinOperator::Mul | BinOperator::Div => 4,
        BinOperator::Power => 5,
    }
}

fn format_number(value: f64) -> String {
    if value == value.floor() && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{}", value)
    }
}

fn op_text(op: BinOperator) -> &'static str {
    match op {
        BinOperator::Add => "+",
        BinOperator::Sub => "-",
        BinOperator::Mul => "*",
        BinOperator::Div => "/",
        BinOperator::Power => "^",
        BinOperator::Concat => "&",
        BinOperator::Equal => "=",
        BinOperator::NotEqual => "<>",
        BinOperator::Less => "<",
        BinOperator::LessOrEqual => "<=",
        BinOperator::Greater => ">",
        BinOperator::GreaterOrEqual => ">=",
    }
}

fn serialize_expr(expr: &Expr, parent_precedence: u8) -> String {
    match expr {
        Expr::Number(value) => format_number(*value),
        Expr::Text(value) => format!("\"{}\"", value),
        Expr::Boolean(true) => "TRUE".into(),
        Expr::Boolean(false) => "FALSE".into(),
        Expr::Error(error) => error.to_string(),
        Expr::CellRef(reference) => reference.to_string_repr(),
        Expr::Range { start, end } => {
            if start.sheet_name.is_some() && start.sheet_name == end.sheet_name {
                let mut end_only = end.clone();
                end_only.sheet_name = None;
                format!("{}:{}", start.to_string_repr(), end_only.to_string_repr())
            } else {
                format!("{}:{}", start.to_string_repr(), end.to_string_repr())
            }
        }
        Expr::Negate(inner) => {
            let rendered = serialize_expr(inner, 6);
            if matches!(**inner, Expr::BinOp { .. }) {
                format!("-({rendered})")
            } else {
                format!("-{rendered}")
            }
        }
        Expr::FuncCall { name, args } => {
            let args = args
                .iter()
                .map(|arg| serialize_expr(arg, 0))
                .collect::<Vec<_>>()
                .join(",");
            format!("{name}({args})")
        }
        Expr::BinOp { op, left, right } => {
            let current = precedence(*op);
            let left_rendered = serialize_expr(left, current);
            let right_rendered = serialize_expr(right, current + u8::from(matches!(op, BinOperator::Power)));
            let rendered = format!("{left_rendered}{}{right_rendered}", op_text(*op));
            if current < parent_precedence {
                format!("({rendered})")
            } else {
                rendered
            }
        }
    }
}

fn shift_expr(expr: &Expr, row_delta: i32, col_delta: i32) -> Expr {
    match expr {
        Expr::Number(value) => Expr::Number(*value),
        Expr::Text(value) => Expr::Text(value.clone()),
        Expr::Boolean(value) => Expr::Boolean(*value),
        Expr::Error(error) => Expr::Error(error.clone()),
        Expr::CellRef(reference) => Expr::CellRef(reference.shift(row_delta, col_delta)),
        Expr::Range { start, end } => Expr::Range {
            start: start.shift(row_delta, col_delta),
            end: end.shift(row_delta, col_delta),
        },
        Expr::Negate(inner) => Expr::Negate(Box::new(shift_expr(inner, row_delta, col_delta))),
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|arg| shift_expr(arg, row_delta, col_delta))
                .collect(),
        },
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(shift_expr(left, row_delta, col_delta)),
            right: Box::new(shift_expr(right, row_delta, col_delta)),
        },
    }
}

pub fn serialize_formula(expr: &Expr) -> String {
    format!("={}", serialize_expr(expr, 0))
}

pub fn shift_formula_input(input: &str, row_delta: i32, col_delta: i32) -> Option<String> {
    let expr = parse_formula(input)?;
    Some(serialize_formula(&shift_expr(&expr, row_delta, col_delta)))
}
