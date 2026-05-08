use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr};

/// What to do with a CellRef whose target was deleted by a structural edit.
///
/// `Invalid` becomes `#REF!` at eval time. We mark it via a sentinel
/// (row=u32::MAX, col=u32::MAX) so the AST shape is preserved — the eval
/// layer knows to short-circuit when it sees that address.
pub const REF_INVALID_ROW: u32 = u32::MAX;
pub const REF_INVALID_COL: u32 = u32::MAX;

fn is_invalid(addr: CellAddress) -> bool {
    addr.row == REF_INVALID_ROW || addr.col == REF_INVALID_COL
}

/// Returns true if the AST contains any invalid (#REF!) cell reference,
/// e.g. left over from a row/column delete that took out a cell the
/// formula was reading.
pub fn contains_invalid_ref(expr: &Expr) -> bool {
    match expr {
        Expr::CellRef(addr) => is_invalid(*addr),
        Expr::Range { start, end } => is_invalid(*start) || is_invalid(*end),
        Expr::Negate(inner) => contains_invalid_ref(inner),
        Expr::BinOp { left, right, .. } => {
            contains_invalid_ref(left) || contains_invalid_ref(right)
        }
        Expr::FuncCall { args, .. } => args.iter().any(contains_invalid_ref),
        _ => false,
    }
}

/// Adjust a single address for a row insertion at `at` (0-based) of `count`
/// rows. References at or below `at` shift down by `count`. References
/// above `at` are unchanged.
pub fn shift_addr_row_insert(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) || addr.row < at {
        return addr;
    }
    CellAddress::new(addr.row + count, addr.col)
}

/// Adjust a single address for a row deletion of `count` rows starting at
/// `at`. Returns the invalid sentinel when the row was inside the deleted
/// range so eval can produce #REF!.
pub fn shift_addr_row_delete(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) {
        return addr;
    }
    if addr.row < at {
        addr
    } else if addr.row < at + count {
        CellAddress::new(REF_INVALID_ROW, REF_INVALID_COL)
    } else {
        CellAddress::new(addr.row - count, addr.col)
    }
}

pub fn shift_addr_col_insert(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) || addr.col < at {
        return addr;
    }
    CellAddress::new(addr.row, addr.col + count)
}

pub fn shift_addr_col_delete(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) {
        return addr;
    }
    if addr.col < at {
        addr
    } else if addr.col < at + count {
        CellAddress::new(REF_INVALID_ROW, REF_INVALID_COL)
    } else {
        CellAddress::new(addr.row, addr.col - count)
    }
}

/// Walk an AST applying `f` to every CellRef / Range corner address.
/// Returns a new AST. Used by row/col insert/delete to retarget formulas.
pub fn map_addrs(expr: &Expr, f: &dyn Fn(CellAddress) -> CellAddress) -> Expr {
    match expr {
        Expr::Number(_) | Expr::Text(_) => expr.clone(),
        Expr::CellRef(addr) => Expr::CellRef(f(*addr)),
        Expr::Range { start, end } => Expr::Range {
            start: f(*start),
            end: f(*end),
        },
        Expr::Negate(inner) => Expr::Negate(Box::new(map_addrs(inner, f))),
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(map_addrs(left, f)),
            right: Box::new(map_addrs(right, f)),
        },
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args.iter().map(|a| map_addrs(a, f)).collect(),
        },
    }
}

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
        Expr::CellRef(addr) => {
            if is_invalid(*addr) {
                out.push_str("#REF!");
            } else {
                out.push_str(&addr.to_string_repr());
            }
        }
        Expr::Range { start, end } => {
            if is_invalid(*start) || is_invalid(*end) {
                out.push_str("#REF!");
            } else {
                out.push_str(&start.to_string_repr());
                out.push(':');
                out.push_str(&end.to_string_repr());
            }
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
