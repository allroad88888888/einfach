use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr};

/// Shift every cell reference in an AST by the given (drow, dcol) delta.
/// Returns Err when a shift would push a reference out of bounds (negative).
/// Used by copy-paste so `=A1` copied from B1 to B2 becomes `=A2` (drow=1).
///
/// Range references shift both corners by the same delta.
pub fn shift_refs(expr: &Expr, drow: i32, dcol: i32) -> Result<Expr, ()> {
    Ok(match expr {
        Expr::Number(_) | Expr::Text(_) => expr.clone(),
        Expr::CellRef(addr) => Expr::CellRef(shift_addr(*addr, drow, dcol)?),
        Expr::Range { start, end } => Expr::Range {
            start: shift_addr(*start, drow, dcol)?,
            end: shift_addr(*end, drow, dcol)?,
        },
        Expr::Negate(inner) => Expr::Negate(Box::new(shift_refs(inner, drow, dcol)?)),
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(shift_refs(left, drow, dcol)?),
            right: Box::new(shift_refs(right, drow, dcol)?),
        },
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| shift_refs(a, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        },
    })
}

fn shift_addr(addr: CellAddress, drow: i32, dcol: i32) -> Result<CellAddress, ()> {
    let row = (addr.row as i32) + drow;
    let col = (addr.col as i32) + dcol;
    if row < 0 || col < 0 {
        return Err(());
    }
    Ok(CellAddress::new(row as u32, col as u32))
}

/// Render an AST back to a formula string (for paste-and-store flows that
/// need text representation). Round-trip: parse(render(parse(s))) == parse(s).
pub fn render_formula(expr: &Expr) -> String {
    let mut out = String::from("=");
    render_into(expr, &mut out);
    out
}

fn render_into(expr: &Expr, out: &mut String) {
    match expr {
        Expr::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                out.push_str(&format!("{}", *n as i64));
            } else {
                out.push_str(&format!("{}", n));
            }
        }
        Expr::Text(s) => {
            out.push('"');
            out.push_str(s);
            out.push('"');
        }
        Expr::CellRef(addr) => out.push_str(&addr.to_string_repr()),
        Expr::Range { start, end } => {
            out.push_str(&start.to_string_repr());
            out.push(':');
            out.push_str(&end.to_string_repr());
        }
        Expr::Negate(inner) => {
            out.push('-');
            render_into(inner, out);
        }
        Expr::BinOp { op, left, right } => {
            // Always parenthesize binops to avoid having to track precedence
            // on the way back. Parser handles redundant parens fine.
            out.push('(');
            render_into(left, out);
            out.push_str(match op {
                BinOperator::Add => "+",
                BinOperator::Sub => "-",
                BinOperator::Mul => "*",
                BinOperator::Div => "/",
                BinOperator::Pow => "^",
                BinOperator::Concat => "&",
                BinOperator::Eq => "=",
                BinOperator::NotEq => "<>",
                BinOperator::Lt => "<",
                BinOperator::LtEq => "<=",
                BinOperator::Gt => ">",
                BinOperator::GtEq => ">=",
            });
            render_into(right, out);
            out.push(')');
        }
        Expr::FuncCall { name, args } => {
            out.push_str(name);
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_into(a, out);
            }
            out.push(')');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formula::parse_formula;

    fn shifted(input: &str, drow: i32, dcol: i32) -> String {
        let expr = parse_formula(input).expect("parse");
        let shifted = shift_refs(&expr, drow, dcol).expect("shift");
        render_formula(&shifted)
    }

    #[test]
    fn shift_simple_ref_down() {
        assert_eq!(shifted("=A1", 1, 0), "=A2");
    }

    #[test]
    fn shift_simple_ref_right() {
        assert_eq!(shifted("=A1", 0, 1), "=B1");
    }

    #[test]
    fn shift_range() {
        assert_eq!(shifted("=SUM(A1:B2)", 1, 1), "=SUM(B2:C3)");
    }

    #[test]
    fn shift_function_call() {
        assert_eq!(shifted("=IF(A1>0,A1,B1)", 0, 1), "=IF((B1>0),B1,C1)");
    }

    #[test]
    fn shift_negative_oob_errors() {
        let expr = parse_formula("=A1").unwrap();
        assert!(shift_refs(&expr, -1, 0).is_err());
    }

    #[test]
    fn render_roundtrip() {
        let original = "=SUM(A1:A10)+IF(B1>0,B1*2,0)";
        let parsed = parse_formula(original).unwrap();
        let rendered = render_formula(&parsed);
        // Re-parsing the rendered output produces the same AST.
        let reparsed = parse_formula(&rendered).unwrap();
        assert_eq!(parsed, reparsed);
    }
}
