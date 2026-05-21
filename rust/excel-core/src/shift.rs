use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr, RangeBounds};

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

fn range_has_invalid_ref(start: CellAddress, end: CellAddress, unbounded: RangeBounds) -> bool {
    let row_invalid = if unbounded.rows_unbounded() {
        false
    } else {
        start.row == REF_INVALID_ROW || end.row == REF_INVALID_ROW
    };
    let col_invalid = if unbounded.cols_unbounded() {
        false
    } else {
        start.col == REF_INVALID_COL || end.col == REF_INVALID_COL
    };
    row_invalid || col_invalid
}

/// Returns true if the AST contains any invalid (#REF!) cell reference,
/// e.g. left over from a row/column delete that took out a cell the
/// formula was reading.
pub fn contains_invalid_ref(expr: &Expr) -> bool {
    match expr {
        Expr::CellRef(addr) => is_invalid(*addr),
        Expr::Range {
            start,
            end,
            unbounded,
        } => range_has_invalid_ref(*start, *end, *unbounded),
        Expr::SheetRef { addr, .. } => is_invalid(*addr),
        Expr::SheetRange {
            start,
            end,
            unbounded,
            ..
        } => range_has_invalid_ref(*start, *end, *unbounded),
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
///
/// Whole-column / whole-row ranges are INVARIANT on their unbounded axis:
/// inserting a row above column A's `A:A` reference doesn't move the
/// column corner. We apply `f` to a synthesized address that keeps the
/// unbounded axis at its sentinel, then restore the sentinel after the
/// shift so any per-axis mutation in `f` (e.g. a `col_insert` shift) is
/// still seen by the bounded axis.
pub fn map_addrs(expr: &Expr, f: &dyn Fn(CellAddress) -> CellAddress) -> Expr {
    match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => expr.clone(),
        Expr::CellRef(addr) => Expr::CellRef(f(*addr)),
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            let (new_start, new_end) = shift_range_corners(*start, *end, *unbounded, &|a| f(a));
            Expr::Range {
                start: new_start,
                end: new_end,
                unbounded: *unbounded,
            }
        }
        // Cross-sheet refs aren't shifted by within-sheet structural edits.
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => expr.clone(),
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
        // LET / future-LAMBDA bindings carry no cell address; copy as-is.
        Expr::Name(_) => expr.clone(),
    }
}

/// Apply `f` only to the bounded axis of a Range corner, leaving the
/// unbounded axis pinned to its sentinel (`0` on start, `u32::MAX` on
/// end). Used by `map_addrs` so a row-insert never tries to shift the
/// sentinel into `u32::MAX + count` (which would overflow).
fn shift_range_corners(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    f: &dyn Fn(CellAddress) -> CellAddress,
) -> (CellAddress, CellAddress) {
    if matches!(unbounded, RangeBounds::None) {
        return (f(start), f(end));
    }
    // Build a synthetic "shiftable" CellAddress where the unbounded axis
    // is replaced by a benign value (row 0 / col 0), apply f, then put
    // back the sentinel on the unbounded axis.
    let rows_un = unbounded.rows_unbounded();
    let cols_un = unbounded.cols_unbounded();
    let synth_start = CellAddress::new(
        if rows_un { 0 } else { start.row },
        if cols_un { 0 } else { start.col },
    );
    let synth_end = CellAddress::new(
        if rows_un { 0 } else { end.row },
        if cols_un { 0 } else { end.col },
    );
    let shifted_start = f(synth_start);
    let shifted_end = f(synth_end);
    // If the bounded axis got shifted to the #REF! sentinel, leave it
    // there (eval will produce #REF!). Otherwise pin the unbounded axis
    // back to its sentinel.
    let new_start = CellAddress::new(
        if rows_un { 0 } else { shifted_start.row },
        if cols_un { 0 } else { shifted_start.col },
    );
    let new_end = CellAddress::new(
        if rows_un { u32::MAX } else { shifted_end.row },
        if cols_un { u32::MAX } else { shifted_end.col },
    );
    // Propagate #REF! invalidity from the bounded axis: if the shifted
    // bounded corner came back as REF_INVALID_* (column deletion ate the
    // referenced column), surface that sentinel on the whole corner so
    // `contains_invalid_ref` can detect it on the bounded axis.
    let new_start = if !rows_un && shifted_start.row == REF_INVALID_ROW {
        CellAddress::new(REF_INVALID_ROW, new_start.col)
    } else if !cols_un && shifted_start.col == REF_INVALID_COL {
        CellAddress::new(new_start.row, REF_INVALID_COL)
    } else {
        new_start
    };
    let new_end = if !rows_un && shifted_end.row == REF_INVALID_ROW {
        CellAddress::new(REF_INVALID_ROW, new_end.col)
    } else if !cols_un && shifted_end.col == REF_INVALID_COL {
        CellAddress::new(new_end.row, REF_INVALID_COL)
    } else {
        new_end
    };
    (new_start, new_end)
}

/// Shift every cell reference in an AST by the given (drow, dcol) delta.
/// Returns Err when a shift would push a reference out of bounds (negative).
/// Used by copy-paste so `=A1` copied from B1 to B2 becomes `=A2` (drow=1).
///
/// Range references shift both corners by the same delta. For whole-col /
/// whole-row ranges, only the bounded axis shifts (an `A:A` copied right
/// becomes `B:B`; shifted down it stays `A:A`).
pub fn shift_refs(expr: &Expr, drow: i32, dcol: i32) -> Result<Expr, ()> {
    Ok(match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => expr.clone(),
        Expr::CellRef(addr) => Expr::CellRef(shift_addr(*addr, drow, dcol)?),
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            let (s, e) = shift_range_corners_delta(*start, *end, *unbounded, drow, dcol)?;
            Expr::Range {
                start: s,
                end: e,
                unbounded: *unbounded,
            }
        }
        // Cross-sheet refs aren't shifted on copy/paste — they point to a
        // fixed location on a different sheet regardless of paste target.
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => expr.clone(),
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
        // LET binding names carry no cell address; copy as-is.
        Expr::Name(_) => expr.clone(),
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

/// Delta-shift the two corners of a Range, honoring the unbounded axes
/// (those stay pinned at sentinel values; no overflow on `u32::MAX +
/// drow`).
fn shift_range_corners_delta(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    drow: i32,
    dcol: i32,
) -> Result<(CellAddress, CellAddress), ()> {
    if matches!(unbounded, RangeBounds::None) {
        return Ok((shift_addr(start, drow, dcol)?, shift_addr(end, drow, dcol)?));
    }
    let rows_un = unbounded.rows_unbounded();
    let cols_un = unbounded.cols_unbounded();
    // Only shift the bounded axis.
    let new_start_row = if rows_un {
        0
    } else {
        let r = (start.row as i32) + drow;
        if r < 0 {
            return Err(());
        }
        r as u32
    };
    let new_end_row = if rows_un {
        u32::MAX
    } else {
        let r = (end.row as i32) + drow;
        if r < 0 {
            return Err(());
        }
        r as u32
    };
    let new_start_col = if cols_un {
        0
    } else {
        let c = (start.col as i32) + dcol;
        if c < 0 {
            return Err(());
        }
        c as u32
    };
    let new_end_col = if cols_un {
        u32::MAX
    } else {
        let c = (end.col as i32) + dcol;
        if c < 0 {
            return Err(());
        }
        c as u32
    };
    Ok((
        CellAddress::new(new_start_row, new_start_col),
        CellAddress::new(new_end_row, new_end_col),
    ))
}

/// Render an AST back to a formula string (for paste-and-store flows that
/// need text representation). Round-trip: parse(render(parse(s))) == parse(s).
pub fn render_formula(expr: &Expr) -> String {
    let mut out = String::from("=");
    render_into(expr, &mut out);
    out
}

/// Render a 0-based column index as letters ("A", "B", ..., "AA", ...).
/// Mirrors the private helper in `cell.rs`; duplicated here so render_into
/// doesn't have to instantiate a CellAddress + parse its repr just to drop
/// the row part.
fn col_only(mut col: u32) -> String {
    let mut result = String::new();
    loop {
        result.push((b'A' + (col % 26) as u8) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    result.chars().rev().collect()
}

fn render_range_body(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    out: &mut String,
) {
    match unbounded {
        RangeBounds::None => {
            out.push_str(&start.to_string_repr());
            out.push(':');
            out.push_str(&end.to_string_repr());
        }
        RangeBounds::Rows => {
            out.push_str(&col_only(start.col));
            out.push(':');
            out.push_str(&col_only(end.col));
        }
        RangeBounds::Cols => {
            out.push_str(&format!("{}", start.row + 1));
            out.push(':');
            out.push_str(&format!("{}", end.row + 1));
        }
        RangeBounds::Both => {
            out.push_str(&start.to_string_repr());
            out.push(':');
            out.push_str(&end.to_string_repr());
        }
    }
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
        Expr::Bool(b) => out.push_str(if *b { "TRUE" } else { "FALSE" }),
        Expr::CellRef(addr) => {
            if is_invalid(*addr) {
                out.push_str("#REF!");
            } else {
                out.push_str(&addr.to_string_repr());
            }
        }
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            // For whole-col / whole-row ranges, only the bounded axis can
            // carry a #REF! sentinel. is_invalid() checks BOTH axes, so
            // we'd false-positive on the u32::MAX sentinel. Check the
            // bounded axes explicitly.
            if range_has_invalid_ref(*start, *end, *unbounded) {
                out.push_str("#REF!");
            } else {
                render_range_body(*start, *end, *unbounded, out);
            }
        }
        Expr::SheetRef { sheet, addr } => {
            if is_invalid(*addr) {
                out.push_str("#REF!");
            } else {
                out.push_str(sheet);
                out.push('!');
                out.push_str(&addr.to_string_repr());
            }
        }
        Expr::SheetRange {
            sheet,
            start,
            end,
            unbounded,
        } => {
            if range_has_invalid_ref(*start, *end, *unbounded) {
                out.push_str("#REF!");
            } else {
                out.push_str(sheet);
                out.push('!');
                render_range_body(*start, *end, *unbounded, out);
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
        // LET-style bound name (or future LAMBDA parameter). Round-trips
        // verbatim — the parser will rebuild the same `Expr::Name`.
        Expr::Name(n) => out.push_str(n),
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

    // === Phase 2 Track G — whole-col / whole-row round-trips ===

    #[test]
    fn render_whole_col_roundtrip() {
        for syntax in ["=SUM(A:A)", "=SUM(A:C)", "=A:A", "=SUM(AA:AC)"] {
            let parsed = parse_formula(syntax).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "round-trip {} -> {}", syntax, rendered);
        }
    }

    #[test]
    fn render_whole_row_roundtrip() {
        for syntax in ["=SUM(1:1)", "=SUM(1:3)", "=SUM(100:200)"] {
            let parsed = parse_formula(syntax).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "round-trip {} -> {}", syntax, rendered);
        }
    }

    #[test]
    fn shift_whole_col_invariant_under_row_shift() {
        // Whole-column ref stays put when shifted down — the column
        // corner is invariant on the row axis.
        assert_eq!(shifted("=SUM(A:A)", 5, 0), "=SUM(A:A)");
        // But shifting right moves the bounded column.
        assert_eq!(shifted("=SUM(A:A)", 0, 1), "=SUM(B:B)");
    }

    #[test]
    fn shift_whole_row_invariant_under_col_shift() {
        // Whole-row ref stays put when shifted right.
        assert_eq!(shifted("=SUM(1:1)", 0, 5), "=SUM(1:1)");
        // But shifting down moves the bounded row.
        assert_eq!(shifted("=SUM(1:1)", 2, 0), "=SUM(3:3)");
    }
}
