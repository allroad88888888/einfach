use std::collections::HashMap;

use einfach_core::{AtomId, Value, ValueError};

use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr};
use crate::range::CellRange;
use crate::shift::{REF_INVALID_COL, REF_INVALID_ROW};

/// Address-based evaluation source. Both production (Workbook) and the
/// legacy `eval_expr(get, cell_map)` shim route through this trait.
///
/// `Sheet`/`Workbook` use their own implementations (`SheetEvalProvider`,
/// `WorkbookEvalProvider`) to handle cross-sheet refs without ever
/// touching a thread-local. The legacy `AtomEvalProvider` below treats
/// any `SheetRef` as `#REF!` — it's a single-sheet shim used only by the
/// in-file eval tests + `eval_expr` callers that don't carry workbook
/// context.
pub trait EvalProvider {
    fn cell(&self, addr: CellAddress) -> Value;
    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value;
    fn force_formula_recompute(&self) -> bool {
        false
    }

    /// Iterate every cell address in `range`, yielding `(addr, value)` to
    /// the closure. Used by `SUM` / `COUNT` / `AVERAGE` / `MIN` / `MAX` /
    /// `COUNTIF` / `SUMIF` for O(1)-memory streaming, and by the stateful
    /// aggregates (`MEDIAN`, `MODE`, `STDEV`, `VAR`, `LARGE`, `SMALL`,
    /// `VLOOKUP`, `HLOOKUP`, `INDEX`, `MATCH`) so they can build their
    /// local temp `Vec` without creating cell atoms.
    ///
    /// "Streaming" here means **no cell atom materialization**, not "O(1)
    /// memory" — the trait contract permits the callee body to keep a
    /// `Vec` if its algorithm demands one. Providers that know which
    /// addresses are sparse (e.g. `SheetEvalProvider` reads only
    /// `cells ∪ formula_cells`) should override this method so
    /// `SUM(A:A)` walks the dozen real cells instead of the column's
    /// nominal extent.
    ///
    /// The default impl iterates the rectangle densely via `range.iter()`
    /// and calls `self.cell(addr)` per cell — fine for small ranges and
    /// for shim providers that don't have sparse-index data.
    fn for_each_range_cell(
        &self,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        for addr in range.iter() {
            let v = self.cell(addr);
            f(addr, v);
        }
    }
}

struct AtomEvalProvider<'a> {
    get: &'a dyn Fn(AtomId) -> Value,
    cell_map: &'a HashMap<CellAddress, AtomId>,
}

impl<'a> EvalProvider for AtomEvalProvider<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        self.cell_map
            .get(&addr)
            .map(|&id| (self.get)(id))
            .unwrap_or(Value::Null)
    }

    fn sheet_cell(&self, _sheet: &str, _addr: CellAddress) -> Value {
        // Legacy shim has no workbook context — cross-sheet refs are
        // out of scope. Production cross-sheet eval lives on
        // `WorkbookEvalProvider`.
        Value::Error(ValueError::InvalidRef)
    }
}

/// Evaluate an AST expression using a getter function for cell values.
/// `cell_map` maps CellAddress to AtomId so the evaluator can look up cells.
pub fn eval_expr(
    expr: &Expr,
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Value {
    let provider = AtomEvalProvider { get, cell_map };
    eval_expr_with_provider(expr, &provider)
}

pub fn eval_expr_with_provider(expr: &Expr, provider: &dyn EvalProvider) -> Value {
    match expr {
        Expr::Number(n) => Value::Number(*n),
        Expr::Text(s) => Value::Text(s.clone()),
        Expr::Bool(b) => Value::Boolean(*b),

        Expr::CellRef(addr) => {
            if addr.row == REF_INVALID_ROW || addr.col == REF_INVALID_COL {
                return Value::Error(ValueError::InvalidRef);
            }
            provider.cell(*addr)
        }

        Expr::BinOp { op, left, right } => {
            let lv = eval_expr_with_provider(left, provider);
            let rv = eval_expr_with_provider(right, provider);
            eval_binop(*op, &lv, &rv)
        }

        Expr::Negate(inner) => {
            let v = eval_expr_with_provider(inner, provider);
            match v {
                Value::Number(n) => Value::Number(-n),
                Value::Error(e) => Value::Error(e),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }

        Expr::FuncCall { name, args } => eval_func(name, args, provider),

        Expr::Range { start, end, .. } => {
            // Ranges should be handled by function evaluators, not standalone
            // If we get here, collect all values into... just return an error
            let _ = (start, end);
            Value::Error(ValueError::InvalidValue)
        }

        Expr::SheetRef { sheet, addr } => {
            if addr.row == REF_INVALID_ROW || addr.col == REF_INVALID_COL {
                return Value::Error(ValueError::InvalidRef);
            }
            // Lazy formula's FormulaCache::Computing state already protects
            // against cross-sheet cycles at runtime — recursing back into a
            // cell already on the eval stack returns CyclicRef. No TLS
            // guard needed; provider dispatch is the canonical path.
            provider.sheet_cell(sheet, *addr)
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

/// Stream a range through `provider.for_each_range_cell`. Used by the
/// stateful aggregates (MEDIAN / MODE / VLOOKUP / INDEX / ...) so they
/// can build their algorithm-required Vec without going through the
/// "collect every cell in the rectangle" path that materialized Nulls
/// for full-column refs. Real-streaming aggregates (SUM / COUNT / ...)
/// drive `for_each_range_cell` directly.
fn stream_range(
    start: &CellAddress,
    end: &CellAddress,
    provider: &dyn EvalProvider,
    f: &mut dyn FnMut(CellAddress, Value),
) {
    let range = CellRange::new(*start, *end);
    provider.for_each_range_cell(range, f);
}

/// Collect a range as a row-major 2D grid (rows × cols). Used by
/// VLOOKUP / HLOOKUP / INDEX where the algorithm itself requires random
/// access by (row, col). The grid is sized by the range's nominal
/// rectangle and pre-filled with `Null`; only addresses that the
/// provider actually visits get populated. For sparse providers this
/// skips visiting empty cells; for dense ones every cell is visited and
/// behavior matches the pre-streaming implementation.
fn collect_range_2d(
    start: &CellAddress,
    end: &CellAddress,
    provider: &dyn EvalProvider,
) -> Vec<Vec<Value>> {
    let min_row = start.row.min(end.row);
    let max_row = start.row.max(end.row);
    let min_col = start.col.min(end.col);
    let max_col = start.col.max(end.col);
    let rows = (max_row - min_row + 1) as usize;
    let cols = (max_col - min_col + 1) as usize;
    let mut grid: Vec<Vec<Value>> = (0..rows).map(|_| vec![Value::Null; cols]).collect();
    let range = CellRange::new(*start, *end);
    provider.for_each_range_cell(range, &mut |addr, value| {
        if addr.row < min_row || addr.row > max_row {
            return;
        }
        if addr.col < min_col || addr.col > max_col {
            return;
        }
        let r = (addr.row - min_row) as usize;
        let c = (addr.col - min_col) as usize;
        grid[r][c] = value;
    });
    grid
}

/// Shared inner loop for VLOOKUP / HLOOKUP. `index` is 1-based; for
/// horizontal=false it picks the column to return from a matched row,
/// for horizontal=true it picks the row to return from a matched column.
///
/// In approximate mode (range_lookup=TRUE) the lookup column/row must
/// be ascending; we find the largest value <= needle. Numeric needles
/// use numeric ordering; otherwise text ordering.
fn lookup_2d(
    grid: &[Vec<Value>],
    needle: &Value,
    index: usize,
    approximate: bool,
    horizontal: bool,
) -> Value {
    if grid.is_empty() {
        return Value::Error(ValueError::InvalidValue);
    }

    // Build the key sequence we search through.
    let keys: Vec<Value> = if horizontal {
        grid[0].clone()
    } else {
        grid.iter()
            .map(|r| r.first().cloned().unwrap_or(Value::Null))
            .collect()
    };

    // Find match position.
    let pos: Option<usize> = if approximate {
        // Linear scan picking largest key <= needle. (binary search is an
        // optimization; correctness is identical.)
        let mut best: Option<usize> = None;
        for (i, k) in keys.iter().enumerate() {
            if compare_lookup(k, needle).is_le() {
                best = Some(i);
            } else {
                break; // input is supposed to be sorted; first overshoot ends scan
            }
        }
        best
    } else {
        keys.iter().position(|k| values_equal(k, needle))
    };

    let p = match pos {
        Some(p) => p,
        None => return Value::Error(ValueError::InvalidValue),
    };

    // Return the cell at the requested row/column from the matched line.
    let cell = if horizontal {
        grid.get(index - 1).and_then(|r| r.get(p))
    } else {
        grid.get(p).and_then(|r| r.get(index - 1))
    };
    cell.cloned()
        .unwrap_or(Value::Error(ValueError::InvalidRef))
}

fn compare_lookup(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if let (Some(an), Some(bn)) = (coerce_to_number(a), coerce_to_number(b)) {
        an.partial_cmp(&bn).unwrap_or(Ordering::Equal)
    } else {
        coerce_to_text(a).cmp(&coerce_to_text(b))
    }
}

fn arg_as_range<'a>(arg: &'a Expr) -> Option<(&'a CellAddress, &'a CellAddress)> {
    match arg {
        Expr::Range { start, end, .. } => Some((start, end)),
        _ => None,
    }
}

/// Stream values produced by a function argument. For `Range` args this
/// goes through `provider.for_each_range_cell` (sparse-aware); for any
/// other expression it evaluates once and yields the single value. The
/// closure sees `(Option<addr>, value)` — `Some` for range cells, `None`
/// for evaluated sub-expressions — so callers like `SUMIF` can still
/// align `range`/`sum_range` by relative position when both are ranges.
fn for_each_arg_value(
    arg: &Expr,
    provider: &dyn EvalProvider,
    f: &mut dyn FnMut(Option<CellAddress>, Value),
) {
    match arg {
        Expr::Range { start, end, .. } => {
            stream_range(start, end, provider, &mut |addr, v| f(Some(addr), v));
        }
        _ => f(None, eval_expr_with_provider(arg, provider)),
    }
}

fn eval_func(
    name: &str,
    args: &[Expr],
    provider: &dyn EvalProvider,
) -> Value {
    match name {
        "SUM" => {
            // Real streaming: O(1) accumulator, no Vec allocation. Errors
            // short-circuit through `err`.
            let mut total = 0.0_f64;
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => err = Some(e),
                        Value::Number(n) => total += n,
                        Value::Null => {}
                        Value::Boolean(true) => total += 1.0,
                        Value::Boolean(false) => {}
                        Value::Text(_) => {}
                    }
                });
            }
            match err {
                Some(e) => Value::Error(e),
                None => Value::Number(total),
            }
        }

        "AVERAGE" => {
            let mut total = 0.0_f64;
            let mut count = 0u64;
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => err = Some(e),
                        Value::Number(n) => {
                            total += n;
                            count += 1;
                        }
                        _ => {}
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if count == 0 {
                Value::Error(ValueError::DivisionByZero)
            } else {
                Value::Number(total / count as f64)
            }
        }

        "COUNT" => {
            let mut count = 0u64;
            for arg in args {
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if matches!(v, Value::Number(_)) {
                        count += 1;
                    }
                });
            }
            Value::Number(count as f64)
        }

        "IF" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let cond = eval_expr_with_provider(&args[0], provider);
            let is_true = match cond {
                Value::Boolean(b) => b,
                Value::Number(n) => n != 0.0,
                Value::Error(e) => return Value::Error(e),
                _ => false,
            };
            if is_true {
                eval_expr_with_provider(&args[1], provider)
            } else if args.len() == 3 {
                eval_expr_with_provider(&args[2], provider)
            } else {
                Value::Boolean(false)
            }
        }

        "MIN" => {
            let mut min: Option<f64> = None;
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => err = Some(e),
                        Value::Number(n) => {
                            min = Some(min.map_or(n, |m: f64| m.min(n)));
                        }
                        _ => {}
                    }
                });
            }
            if let Some(e) = err {
                return Value::Error(e);
            }
            // Empty set: Excel returns 0 if there are no numeric arguments
            // at all — but #NUM! in some versions. We prefer #VALUE! over a
            // misleading 0 (B.6). Callers wanting "0 default" should pass it.
            min.map_or(Value::Error(ValueError::InvalidValue), Value::Number)
        }

        "MAX" => {
            let mut max: Option<f64> = None;
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => err = Some(e),
                        Value::Number(n) => {
                            max = Some(max.map_or(n, |m: f64| m.max(n)));
                        }
                        _ => {}
                    }
                });
            }
            if let Some(e) = err {
                return Value::Error(e);
            }
            max.map_or(Value::Number(0.0), Value::Number)
        }

        // === Logical ===
        "AND" => {
            let mut result = true;
            let mut saw_any = false;
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => err = Some(e),
                        Value::Null => {}
                        other => match coerce_to_bool(&other) {
                            Some(b) => {
                                saw_any = true;
                                result = result && b;
                            }
                            None => err = Some(ValueError::InvalidValue),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if !saw_any {
                Value::Error(ValueError::InvalidValue)
            } else {
                Value::Boolean(result)
            }
        }
        "OR" => {
            let mut result = false;
            let mut saw_any = false;
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => err = Some(e),
                        Value::Null => {}
                        other => match coerce_to_bool(&other) {
                            Some(b) => {
                                saw_any = true;
                                result = result || b;
                            }
                            None => err = Some(ValueError::InvalidValue),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if !saw_any {
                Value::Error(ValueError::InvalidValue)
            } else {
                Value::Boolean(result)
            }
        }
        "NOT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::InvalidValue);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match coerce_to_bool(&v) {
                Some(b) => Value::Boolean(!b),
                None => match v {
                    Value::Error(e) => Value::Error(e),
                    _ => Value::Error(ValueError::InvalidValue),
                },
            }
        }

        // === Math ===
        "ABS" => unary_number(args, provider, |n| n.abs()),
        "SQRT" => unary_number(args, provider, |n| {
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
            let n = eval_expr_with_provider(&args[0], provider);
            let d = eval_expr_with_provider(&args[1], provider);
            match (coerce_to_number(&n), coerce_to_number(&d)) {
                (Some(value), Some(digits)) => {
                    let factor = 10f64.powi(digits as i32);
                    Value::Number((value * factor).round() / factor)
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "CEILING" => unary_number(args, provider, f64::ceil),
        "FLOOR" => unary_number(args, provider, f64::floor),
        "POWER" => {
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let b = eval_expr_with_provider(&args[0], provider);
            let e = eval_expr_with_provider(&args[1], provider);
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
            let a = eval_expr_with_provider(&args[0], provider);
            let b = eval_expr_with_provider(&args[1], provider);
            match (coerce_to_number(&a), coerce_to_number(&b)) {
                (Some(_), Some(0.0)) => Value::Error(ValueError::DivisionByZero),
                (Some(va), Some(vb)) => Value::Number(va.rem_euclid(vb)),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }

        // === Text ===
        "CONCATENATE" => {
            let mut out = String::new();
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    if let Value::Error(e) = &v {
                        err = Some(e.clone());
                        return;
                    }
                    out.push_str(&coerce_to_text(&v));
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else {
                Value::Text(out)
            }
        }
        "LEN" => {
            if args.len() != 1 {
                return Value::Error(ValueError::InvalidValue);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            Value::Number(coerce_to_text(&v).chars().count() as f64)
        }
        "LEFT" => text_slice(args, provider, |s, n| s.chars().take(n).collect()),
        "RIGHT" => text_slice(args, provider, |s, n| {
            let len = s.chars().count();
            s.chars().skip(len.saturating_sub(n)).collect()
        }),
        "MID" => {
            // MID(text, start, length) — start is 1-based
            if args.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let s = coerce_to_text(&eval_expr_with_provider(&args[0], provider));
            let start_v = eval_expr_with_provider(&args[1], provider);
            let len_v = eval_expr_with_provider(&args[2], provider);
            match (coerce_to_number(&start_v), coerce_to_number(&len_v)) {
                (Some(start), Some(len)) if start >= 1.0 && len >= 0.0 => {
                    let skip = (start as usize).saturating_sub(1);
                    let take = len as usize;
                    Value::Text(s.chars().skip(skip).take(take).collect())
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "UPPER" => text_unary(args, provider, |s| s.to_uppercase()),
        "LOWER" => text_unary(args, provider, |s| s.to_lowercase()),
        "TRIM" => text_unary(args, provider, |s| s.trim().to_string()),

        // === Conditional aggregates ===
        "COUNTIF" => {
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Eval the criterion once outside the streaming loop.
            let criterion = eval_expr_with_provider(&args[1], provider);
            let mut count = 0u64;
            for_each_arg_value(&args[0], provider, &mut |_addr, v| {
                if matches_criterion(&v, &criterion) {
                    count += 1;
                }
            });
            Value::Number(count as f64)
        }
        "SUMIF" => {
            // SUMIF(range, criterion[, sum_range])
            //
            // Two-arg form: stream the single range; sum hits that coerce
            // to a number. O(1) memory.
            //
            // Three-arg form: stream `range`; on each hit, translate the
            // `addr` into the matching cell in `sum_range` by relative
            // offset and call `provider.cell` for the target. Still O(1)
            // memory (no Vec of either range) — at the cost of an extra
            // HashMap lookup per hit, which is cheap.
            if args.len() != 2 && args.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let criterion = eval_expr_with_provider(&args[1], provider);
            let mut total = 0.0_f64;
            if args.len() == 2 {
                for_each_arg_value(&args[0], provider, &mut |_addr, v| {
                    if matches_criterion(&v, &criterion) {
                        if let Some(n) = coerce_to_number(&v) {
                            total += n;
                        }
                    }
                });
            } else {
                // Three-arg with offset translation needs both args to be
                // ranges; otherwise fall back to the two-arg behavior
                // (Excel actually broadcasts a single sum_range cell, but
                // the legacy tests here matched index-equality only when
                // both were ranges).
                let range = match &args[0] {
                    Expr::Range { start, end, .. } => Some((*start, *end)),
                    _ => None,
                };
                let sum_range = match &args[2] {
                    Expr::Range { start, end, .. } => Some((*start, *end)),
                    _ => None,
                };
                match (range, sum_range) {
                    (Some((rs, re)), Some((ss, _se))) => {
                        let rs_n = CellRange::new(rs, re).normalize();
                        let ss_n = CellRange::new(ss, ss).normalize();
                        let dr = ss_n.start.row as i64 - rs_n.start.row as i64;
                        let dc = ss_n.start.col as i64 - rs_n.start.col as i64;
                        for_each_arg_value(&args[0], provider, &mut |addr, v| {
                            let Some(addr) = addr else { return };
                            if matches_criterion(&v, &criterion) {
                                let r = addr.row as i64 + dr;
                                let c = addr.col as i64 + dc;
                                if r < 0 || c < 0 {
                                    return;
                                }
                                let target =
                                    provider.cell(CellAddress::new(r as u32, c as u32));
                                if let Some(n) = coerce_to_number(&target) {
                                    total += n;
                                }
                            }
                        });
                    }
                    _ => {
                        // Non-range args fall back to "broadcast same eval"
                        for_each_arg_value(&args[0], provider, &mut |_addr, v| {
                            if matches_criterion(&v, &criterion) {
                                if let Some(n) = coerce_to_number(&v) {
                                    total += n;
                                }
                            }
                        });
                    }
                }
            }
            Value::Number(total)
        }

        // === Phase 5: lookup / stats / dates ===
        "VLOOKUP" => {
            // VLOOKUP(lookup_value, table_range, col_index, [range_lookup])
            // range_lookup: TRUE/omitted = approximate (range must be sorted
            // ascending in col 1; finds largest value ≤ needle), FALSE = exact.
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::InvalidValue);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            let (start, end) = match arg_as_range(&args[1]) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let col_idx = match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let approximate = if args.len() == 4 {
                coerce_to_bool(&eval_expr_with_provider(&args[3], provider)).unwrap_or(true)
            } else {
                true
            };
            let grid = collect_range_2d(start, end, provider);
            lookup_2d(
                &grid,
                &needle,
                col_idx,
                approximate,
                /* horizontal = */ false,
            )
        }

        "HLOOKUP" => {
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::InvalidValue);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            let (start, end) = match arg_as_range(&args[1]) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let row_idx = match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let approximate = if args.len() == 4 {
                coerce_to_bool(&eval_expr_with_provider(&args[3], provider)).unwrap_or(true)
            } else {
                true
            };
            let grid = collect_range_2d(start, end, provider);
            lookup_2d(
                &grid,
                &needle,
                row_idx,
                approximate,
                /* horizontal = */ true,
            )
        }

        "INDEX" => {
            // INDEX(range, row, col) — 1-based
            if args.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let (start, end) = match arg_as_range(&args[0]) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let r = match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let c = match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let grid = collect_range_2d(start, end, provider);
            grid.get(r - 1)
                .and_then(|row| row.get(c - 1).cloned())
                .unwrap_or(Value::Error(ValueError::InvalidRef))
        }

        "MATCH" => {
            // MATCH(value, range, [type=0 exact])
            //
            // Streaming early-exit: walk the range, return on first hit.
            // The position is by visit order, which for a dense provider
            // matches the legacy `(i + 1)` 1-based result. (Sparse
            // providers skip holes — position counts only present cells,
            // a deliberate behavior change for full-column refs.)
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            let mut position: u64 = 0;
            let mut found: Option<u64> = None;
            for_each_arg_value(&args[1], provider, &mut |_addr, v| {
                if found.is_some() {
                    return;
                }
                position += 1;
                if values_equal(&v, &needle) {
                    found = Some(position);
                }
            });
            match found {
                Some(p) => Value::Number(p as f64),
                None => Value::Error(ValueError::InvalidValue),
            }
        }

        // Stats
        "MEDIAN" => {
            // Stateful: needs a sorted Vec. Stream through
            // for_each_arg_value so we never create atoms for empty
            // cells in `=MEDIAN(A:A)`-shaped ranges.
            let mut nums: Vec<f64> = Vec::new();
            let mut err: Option<ValueError> = None;
            for arg in args {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Number(n) => nums.push(n),
                        Value::Error(e) => err = Some(e),
                        _ => {}
                    }
                });
            }
            if let Some(e) = err {
                return Value::Error(e);
            }
            if nums.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let n = nums.len();
            let med = if n % 2 == 1 {
                nums[n / 2]
            } else {
                (nums[n / 2 - 1] + nums[n / 2]) / 2.0
            };
            Value::Number(med)
        }

        "MODE" => {
            // Stateful: bucket-count requires a HashMap. Stream so we
            // skip empty cells; algorithm needs the full list anyway.
            let mut nums: Vec<i64> = Vec::new();
            for arg in args {
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if let Value::Number(n) = v {
                        // Multiply to preserve some decimals; mode for floats
                        // is rare and we want bit-stable hashing.
                        nums.push((n * 1e9).round() as i64);
                    }
                });
            }
            if nums.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut counts: HashMap<i64, usize> = HashMap::new();
            for n in &nums {
                *counts.entry(*n).or_insert(0) += 1;
            }
            let (best, max_count) = counts
                .iter()
                .max_by_key(|(_, c)| *c)
                .map(|(k, c)| (*k, *c))
                .unwrap();
            if max_count <= 1 {
                return Value::Error(ValueError::InvalidValue);
            }
            Value::Number(best as f64 / 1e9)
        }

        "STDEV" => {
            // Stateful (two-pass: mean then variance). Vec still here but
            // it's sparse-driven via collect_numbers → for_each_arg_value.
            let nums = collect_numbers(args, provider);
            if nums.len() < 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let var =
                nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (nums.len() as f64 - 1.0);
            Value::Number(var.sqrt())
        }

        "VAR" => {
            let nums = collect_numbers(args, provider);
            if nums.len() < 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let var =
                nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (nums.len() as f64 - 1.0);
            Value::Number(var)
        }

        "LARGE" => {
            // LARGE(range, k) — kth largest, 1-based. Stateful: needs a
            // sorted Vec to pick by rank.
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut nums = collect_numbers(&args[..1], provider);
            let k = match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            if k > nums.len() {
                return Value::Error(ValueError::InvalidValue);
            }
            nums.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            Value::Number(nums[k - 1])
        }

        "SMALL" => {
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut nums = collect_numbers(&args[..1], provider);
            let k = match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            if k > nums.len() {
                return Value::Error(ValueError::InvalidValue);
            }
            nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            Value::Number(nums[k - 1])
        }

        // Dates: stored as f64 day numbers, epoch = 1970-01-01 → 0.
        "TODAY" => {
            use chrono::{Datelike, Local};
            let today = Local::now().date_naive();
            Value::Number(date_serial(today.year(), today.month(), today.day()))
        }
        "NOW" => {
            // Whole+fractional day count. Fractional part = time-of-day / 86400.
            use chrono::{Datelike, Local, Timelike};
            let now = Local::now();
            let date = now.date_naive();
            let day_serial = date_serial(date.year(), date.month(), date.day());
            let secs_in_day = (now.hour() * 3600 + now.minute() * 60 + now.second()) as f64;
            Value::Number(day_serial + secs_in_day / 86_400.0)
        }
        "DATE" => {
            // DATE(year, month, day) — naive day-count via days-from-epoch.
            // Doesn't handle leap rules of pre-1582 Julian; accurate enough
            // for the demo's range.
            if args.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let y = coerce_to_number(&eval_expr_with_provider(&args[0], provider));
            let m = coerce_to_number(&eval_expr_with_provider(&args[1], provider));
            let d = coerce_to_number(&eval_expr_with_provider(&args[2], provider));
            match (y, m, d) {
                (Some(y), Some(m), Some(d)) => {
                    Value::Number(date_serial(y as i32, m as u32, d as u32))
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "YEAR" => date_part(args, provider, |y, _, _| y as f64),
        "MONTH" => date_part(args, provider, |_, m, _| m as f64),
        "DAY" => date_part(args, provider, |_, _, d| d as f64),

        _ => Value::Error(ValueError::InvalidName),
    }
}

/// Streams every arg's numeric values into a local Vec. The Vec is an
/// algorithmic requirement of the callers (MEDIAN sorts, MODE counts,
/// STDEV/VAR need two passes, LARGE/SMALL select by rank) — but going
/// through `for_each_arg_value` means the underlying provider can stay
/// sparse, so we never allocate Null entries for empty cells in
/// `SUM(A:A)`-shaped ranges.
fn collect_numbers(
    args: &[Expr],
    provider: &dyn EvalProvider,
) -> Vec<f64> {
    let mut out = Vec::new();
    for arg in args {
        for_each_arg_value(arg, provider, &mut |_addr, v| {
            if let Value::Number(n) = v {
                out.push(n);
            }
        });
    }
    out
}

fn values_equal(a: &Value, b: &Value) -> bool {
    if let (Some(an), Some(bn)) = (coerce_to_number(a), coerce_to_number(b)) {
        an == bn
    } else {
        coerce_to_text(a) == coerce_to_text(b)
    }
}

/// Naive Gregorian-only days-from-epoch. Epoch: 1970-01-01 = 0.
fn date_serial(year: i32, month: u32, day: u32) -> f64 {
    if month == 0 || month > 12 || day == 0 || day > 31 {
        return f64::NAN;
    }
    // Days in each month for non-leap years.
    const DOM: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    fn is_leap(y: i32) -> bool {
        (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    }
    let mut days: i64 = 0;
    if year >= 1970 {
        for y in 1970..year {
            days += if is_leap(y) { 366 } else { 365 };
        }
    } else {
        for y in year..1970 {
            days -= if is_leap(y) { 366 } else { 365 };
        }
    }
    for m in 1..month {
        days += DOM[(m - 1) as usize] as i64;
        if m == 2 && is_leap(year) {
            days += 1;
        }
    }
    days += (day - 1) as i64;
    days as f64
}

fn date_from_serial(serial: f64) -> (i32, u32, u32) {
    let days = serial as i64;
    let mut year = 1970i32;
    let mut remaining = days;
    fn is_leap(y: i32) -> bool {
        (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    }
    if remaining >= 0 {
        loop {
            let dy = if is_leap(year) { 366 } else { 365 };
            if remaining < dy {
                break;
            }
            remaining -= dy;
            year += 1;
        }
    } else {
        while remaining < 0 {
            year -= 1;
            let dy = if is_leap(year) { 366 } else { 365 };
            remaining += dy;
        }
    }
    const DOM: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    while month <= 12 {
        let dm = DOM[(month - 1) as usize] as i64 + if month == 2 && is_leap(year) { 1 } else { 0 };
        if remaining < dm {
            break;
        }
        remaining -= dm;
        month += 1;
    }
    let day = remaining as u32 + 1;
    (year, month, day)
}

fn date_part(
    args: &[Expr],
    provider: &dyn EvalProvider,
    f: impl Fn(i32, u32, u32) -> f64,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::InvalidValue);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    match coerce_to_number(&v) {
        Some(n) => {
            let (y, m, d) = date_from_serial(n);
            Value::Number(f(y, m, d))
        }
        None => Value::Error(ValueError::InvalidValue),
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
    provider: &dyn EvalProvider,
    f: impl Fn(f64) -> f64,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::InvalidValue);
    }
    let v = eval_expr_with_provider(&args[0], provider);
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
    provider: &dyn EvalProvider,
    f: impl Fn(&str) -> String,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::InvalidValue);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    Value::Text(f(&coerce_to_text(&v)))
}

fn text_slice(
    args: &[Expr],
    provider: &dyn EvalProvider,
    take: impl Fn(&str, usize) -> String,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::InvalidValue);
    }
    let s = coerce_to_text(&eval_expr_with_provider(&args[0], provider));
    let n = if args.len() == 2 {
        match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
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
    use std::cell::Cell;

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

    fn eval_str(
        formula: &str,
        cell_map: &HashMap<CellAddress, AtomId>,
        values: &HashMap<AtomId, Value>,
    ) -> Value {
        let expr = parse_formula(formula).expect("parse failed");
        let get = |id: AtomId| -> Value { values.get(&id).cloned().unwrap_or(Value::Null) };
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
        assert_eq!(eval_str("=B2&A1", &cm, &vs), Value::Text("text10".into()));
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
        assert_eq!(eval_str("=AND(A1>0,B1>0)", &cm, &vs), Value::Boolean(true));
        assert_eq!(
            eval_str("=AND(A1>100,B1>0)", &cm, &vs),
            Value::Boolean(false)
        );
    }

    #[test]
    fn eval_logical_or_not() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=OR(A1>100,B1>0)", &cm, &vs), Value::Boolean(true));
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
        assert_eq!(eval_str("=LEFT(B2,2)", &cm, &vs), Value::Text("te".into()));
        assert_eq!(eval_str("=RIGHT(B2,2)", &cm, &vs), Value::Text("xt".into()));
        assert_eq!(eval_str("=MID(B2,2,2)", &cm, &vs), Value::Text("ex".into()));
        assert_eq!(eval_str("=UPPER(B2)", &cm, &vs), Value::Text("TEXT".into()));
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

    // === Phase 5 tests ===

    fn make_lookup_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // Three rows of (id, price): (1, 10), (2, 20), (3, 30) at A1:B3.
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        for (i, (id, price)) in [(1, 10), (2, 20), (3, 30)].iter().enumerate() {
            let row = i as u32;
            let id_atom = AtomId::from_raw((row * 2) as u64);
            let price_atom = AtomId::from_raw((row * 2 + 1) as u64);
            cell_map.insert(CellAddress::new(row, 0), id_atom);
            cell_map.insert(CellAddress::new(row, 1), price_atom);
            values.insert(id_atom, Value::Number(*id as f64));
            values.insert(price_atom, Value::Number(*price as f64));
        }
        (cell_map, values)
    }

    #[test]
    fn eval_vlookup_finds_row() {
        let (cm, vs) = make_lookup_env();
        // VLOOKUP(2, A1:B3, 2) → 20
        assert_eq!(
            eval_str("=VLOOKUP(2,A1:B3,2)", &cm, &vs),
            Value::Number(20.0)
        );
        // VLOOKUP(99, ..., FALSE) → #N/A in exact mode (default became
        // approximate after C.3, matching Excel; old test expected exact).
        assert!(matches!(
            eval_str("=VLOOKUP(99,A1:B3,2,FALSE)", &cm, &vs),
            Value::Error(_)
        ));
    }

    #[test]
    fn eval_index_match() {
        let (cm, vs) = make_lookup_env();
        // INDEX(A1:B3, 2, 2) → 20 (row 2 col 2 = price for id 2)
        assert_eq!(eval_str("=INDEX(A1:B3,2,2)", &cm, &vs), Value::Number(20.0));
        // MATCH(2, A1:A3, 0) → 2 (1-based)
        assert_eq!(eval_str("=MATCH(2,A1:A3,0)", &cm, &vs), Value::Number(2.0));
    }

    #[test]
    fn eval_hlookup_finds_col() {
        // Build a horizontal table: row 0 = headers, row 1 = values.
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        for (i, (h, v)) in [("a", 1), ("b", 2), ("c", 3)].iter().enumerate() {
            let col = i as u32;
            let h_atom = AtomId::from_raw((col * 2) as u64);
            let v_atom = AtomId::from_raw((col * 2 + 1) as u64);
            cm.insert(CellAddress::new(0, col), h_atom);
            cm.insert(CellAddress::new(1, col), v_atom);
            vs.insert(h_atom, Value::Text((*h).into()));
            vs.insert(v_atom, Value::Number(*v as f64));
        }
        // HLOOKUP("b", A1:C2, 2) → 2
        assert_eq!(
            eval_str("=HLOOKUP(\"b\",A1:C2,2)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_stats() {
        let (cm, vs) = make_test_env();
        // A1=10, B1=20, A2=5
        assert_eq!(eval_str("=MEDIAN(A1,B1,A2)", &cm, &vs), Value::Number(10.0));
        // STDEV / VAR for {10, 20, 5}: mean=11.66… so they should be > 0
        let stdev = eval_str("=STDEV(A1,B1,A2)", &cm, &vs);
        assert!(matches!(stdev, Value::Number(n) if n > 0.0));
        let var = eval_str("=VAR(A1,B1,A2)", &cm, &vs);
        assert!(matches!(var, Value::Number(n) if n > 0.0));
    }

    #[test]
    fn eval_large_small() {
        let (cm, vs) = make_test_env();
        // {10, 20, 5} → LARGE k=1 → 20, SMALL k=1 → 5
        assert_eq!(eval_str("=LARGE(A1:B2,1)", &cm, &vs), Value::Number(20.0));
        assert_eq!(eval_str("=SMALL(A1:B2,1)", &cm, &vs), Value::Number(5.0));
    }

    #[test]
    fn eval_vlookup_approximate_match() {
        // Tax bracket lookup: thresholds 0/100/1000/10000 -> rates
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        for (i, (threshold, rate)) in [(0.0, 5.0), (100.0, 10.0), (1000.0, 20.0), (10000.0, 30.0)]
            .iter()
            .enumerate()
        {
            let row = i as u32;
            let t = AtomId::from_raw((row * 2) as u64);
            let r = AtomId::from_raw((row * 2 + 1) as u64);
            cm.insert(CellAddress::new(row, 0), t);
            cm.insert(CellAddress::new(row, 1), r);
            vs.insert(t, Value::Number(*threshold));
            vs.insert(r, Value::Number(*rate));
        }
        // Approximate (4th arg = TRUE / omitted): largest threshold <= 500 is 100 -> 10
        assert_eq!(
            eval_str("=VLOOKUP(500,A1:B4,2)", &cm, &vs),
            Value::Number(10.0)
        );
        assert_eq!(
            eval_str("=VLOOKUP(500,A1:B4,2,TRUE)", &cm, &vs),
            Value::Number(10.0)
        );
        // 12000 -> 10000 bracket -> 30
        assert_eq!(
            eval_str("=VLOOKUP(12000,A1:B4,2)", &cm, &vs),
            Value::Number(30.0)
        );
        // Below smallest -> #N/A (returned as InvalidValue)
        assert!(matches!(
            eval_str("=VLOOKUP(-1,A1:B4,2)", &cm, &vs),
            Value::Error(_)
        ));
        // Exact mode (FALSE) on 500 -> #N/A because 500 isn't in the column
        assert!(matches!(
            eval_str("=VLOOKUP(500,A1:B4,2,FALSE)", &cm, &vs),
            Value::Error(_)
        ));
        // Exact match on 100 -> 10
        assert_eq!(
            eval_str("=VLOOKUP(100,A1:B4,2,FALSE)", &cm, &vs),
            Value::Number(10.0)
        );
    }

    #[test]
    fn eval_today_is_valid_date_serial() {
        let (cm, vs) = make_test_env();
        // TODAY returns a Number. Round-tripping through YEAR yields a
        // sensible year (>= 2026 since this test runs after that).
        let r = eval_str("=TODAY()", &cm, &vs);
        match r {
            Value::Number(n) => {
                let (y, m, d) = date_from_serial(n);
                assert!(y >= 2026, "year should be at least 2026, got {}", y);
                assert!((1..=12).contains(&m), "month {} out of range", m);
                assert!((1..=31).contains(&d), "day {} out of range", d);
            }
            other => panic!("TODAY didn't return a Number: {:?}", other),
        }
    }

    #[test]
    fn eval_now_includes_fractional_day() {
        let (cm, vs) = make_test_env();
        // NOW() ≥ TODAY() and < TODAY()+1
        let now_v = eval_str("=NOW()", &cm, &vs);
        let today_v = eval_str("=TODAY()", &cm, &vs);
        if let (Value::Number(now), Value::Number(today)) = (now_v, today_v) {
            assert!(now >= today, "NOW {} should be >= TODAY {}", now, today);
            assert!(now < today + 1.0, "NOW should be on the same day");
        } else {
            panic!("NOW or TODAY didn't return a Number");
        }
    }

    #[test]
    fn eval_date_round_trip() {
        let (cm, vs) = make_test_env();
        // DATE(2026, 5, 8) → some serial; YEAR/MONTH/DAY of that serial
        // round-trips back to the input.
        let serial = eval_str("=DATE(2026,5,8)", &cm, &vs);
        assert!(matches!(serial, Value::Number(_)));
        // The expression is wrapped in YEAR(DATE(...)) so we can compose.
        assert_eq!(
            eval_str("=YEAR(DATE(2026,5,8))", &cm, &vs),
            Value::Number(2026.0)
        );
        assert_eq!(
            eval_str("=MONTH(DATE(2026,5,8))", &cm, &vs),
            Value::Number(5.0)
        );
        assert_eq!(
            eval_str("=DAY(DATE(2026,5,8))", &cm, &vs),
            Value::Number(8.0)
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

    // === LAZY Step 4: range streaming tests ===
    //
    // The four tests below exercise the streaming/stateful split via a
    // synthetic SparseProvider that exposes a visit counter. SheetEval-
    // Provider's sparse override is exercised separately in
    // `sheet::tests::*` and `workbook::tests::*`.

    /// Provider backed by a sparse HashMap. Counts every `cell()` /
    /// `for_each_range_cell` visit so tests can assert "we walked the
    /// real cells, not the full rectangle."
    struct SparseProvider {
        cells: HashMap<CellAddress, Value>,
        visits: Cell<u64>,
    }

    impl SparseProvider {
        fn new() -> Self {
            SparseProvider {
                cells: HashMap::new(),
                visits: Cell::new(0),
            }
        }
        fn set(&mut self, addr: &str, v: Value) {
            self.cells
                .insert(CellAddress::parse(addr).unwrap(), v);
        }
        fn visits(&self) -> u64 {
            self.visits.get()
        }
    }

    impl EvalProvider for SparseProvider {
        fn cell(&self, addr: CellAddress) -> Value {
            self.visits.set(self.visits.get() + 1);
            self.cells.get(&addr).cloned().unwrap_or(Value::Null)
        }
        fn sheet_cell(&self, _sheet: &str, _addr: CellAddress) -> Value {
            Value::Error(ValueError::InvalidRef)
        }
        fn for_each_range_cell(
            &self,
            range: CellRange,
            f: &mut dyn FnMut(CellAddress, Value),
        ) {
            // Walk only addresses we actually have, intersected with the
            // requested range. Sparse traversal — the visit count equals
            // the number of present cells inside `range`, NOT the
            // rectangle's `cell_count`.
            let n = range.normalize();
            for (addr, value) in &self.cells {
                if addr.row >= n.start.row
                    && addr.row <= n.end.row
                    && addr.col >= n.start.col
                    && addr.col <= n.end.col
                {
                    self.visits.set(self.visits.get() + 1);
                    f(*addr, value.clone());
                }
            }
        }
    }

    fn run_with(provider: &SparseProvider, formula: &str) -> Value {
        let expr = parse_formula(formula).expect("parse failed");
        eval_expr_with_provider(&expr, provider)
    }

    #[test]
    fn sum_walks_only_real_cells_in_huge_range() {
        // A1=5, A100000=10. SUM(A1:A100000) over the synthetic sparse
        // provider must visit exactly 2 cells, not 100_000.
        let mut p = SparseProvider::new();
        p.set("A1", Value::Number(5.0));
        p.set("A100000", Value::Number(10.0));
        let v = run_with(&p, "=SUM(A1:A100000)");
        assert_eq!(v, Value::Number(15.0));
        assert_eq!(
            p.visits(),
            2,
            "SUM should stream only the 2 real cells (got {})",
            p.visits()
        );
    }

    #[test]
    fn count_range_with_holes() {
        // A1=1, A3=2, A5=3 (A2/A4 empty). COUNT(A1:A5) = 3 since COUNT
        // counts numeric values and skips empty/non-numeric — matches
        // Excel.
        let mut p = SparseProvider::new();
        p.set("A1", Value::Number(1.0));
        p.set("A3", Value::Number(2.0));
        p.set("A5", Value::Number(3.0));
        let v = run_with(&p, "=COUNT(A1:A5)");
        assert_eq!(v, Value::Number(3.0));
    }

    #[test]
    fn average_streaming_matches_eager() {
        // Build a small range and compare =AVERAGE(...) against manual
        // sum/count to confirm result equivalence with the old eager
        // collect_range_values path.
        let mut p = SparseProvider::new();
        let nums = [3.0, 7.5, 11.0, -2.0, 0.5, 100.0, 42.0, 8.0];
        let mut row = 0u32;
        for n in nums.iter() {
            let addr = CellAddress::new(row, 0).to_string_repr();
            p.set(&addr, Value::Number(*n));
            row += 1;
        }
        let v = run_with(&p, "=AVERAGE(A1:A8)");
        let expected = nums.iter().sum::<f64>() / nums.len() as f64;
        assert_eq!(v, Value::Number(expected));
    }

    #[test]
    fn min_max_stream_sparse_range() {
        // MIN / MAX on a sparse range visit each non-empty cell exactly
        // once, with no Vec materialization.
        let mut p = SparseProvider::new();
        p.set("A1", Value::Number(5.0));
        p.set("A50", Value::Number(-2.5));
        p.set("A1000", Value::Number(100.0));
        assert_eq!(run_with(&p, "=MIN(A1:A1000)"), Value::Number(-2.5));
        assert_eq!(run_with(&p, "=MAX(A1:A1000)"), Value::Number(100.0));
    }

    #[test]
    fn median_stateful_still_works_over_streaming() {
        // MEDIAN keeps its temp Vec, but goes through for_each_arg_value
        // so no atoms get created. Result equivalence with eager path
        // is the contract.
        let mut p = SparseProvider::new();
        for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            let addr = CellAddress::new(i as u32, 0).to_string_repr();
            p.set(&addr, Value::Number(*n));
        }
        let v = run_with(&p, "=MEDIAN(A1:A5)");
        assert_eq!(v, Value::Number(3.0));
    }

    #[test]
    fn countif_sumif_stream_sparse_range() {
        // Sparse range; criteria filter is applied during streaming.
        let mut p = SparseProvider::new();
        p.set("A1", Value::Number(10.0));
        p.set("A500", Value::Number(20.0));
        p.set("A999", Value::Number(2.0));
        assert_eq!(
            run_with(&p, "=COUNTIF(A1:A1000,\">5\")"),
            Value::Number(2.0)
        );
        assert_eq!(
            run_with(&p, "=SUMIF(A1:A1000,\">5\")"),
            Value::Number(30.0)
        );
    }
}
