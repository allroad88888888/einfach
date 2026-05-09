use std::cell::RefCell;
use std::collections::HashMap;

use einfach_core::{AtomId, Value, ValueError};

use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr};
use crate::shift::{REF_INVALID_COL, REF_INVALID_ROW};

/// Resolves cross-sheet references during eval. The Workbook layer
/// installs an implementation around eval_expr calls so `Sheet1!A1`
/// resolves to a value on another sheet.
pub trait CrossSheetResolver {
    fn resolve(&self, sheet: &str, addr: CellAddress) -> Value;
}

thread_local! {
    /// Active cross-sheet resolver during eval. Set by `with_cross_resolver`,
    /// read by the SheetRef arm. Raw pointer because the resolver's lifetime
    /// is bound to the calling stack frame, not 'static — the guard's Drop
    /// clears it before the frame returns.
    static CROSS_RESOLVER: RefCell<Option<*const dyn CrossSheetResolver>> =
        RefCell::new(None);
}

/// Run `f` with `resolver` installed as the active cross-sheet resolver.
/// Restores the previous resolver on return (panic-safe via Drop).
///
/// Workbook eval typically does:
/// ```ignore
/// with_cross_resolver(&workbook_ctx, || sheet.get_cell("A1"));
/// ```
///
/// SAFETY note: the implementation transmutes the borrowed resolver to a
/// `'static` trait object so it can sit in a thread_local. The Drop guard
/// clears the slot before this function returns, so the dangling pointer
/// is never observable outside `f`'s execution.
pub fn with_cross_resolver<R>(resolver: &dyn CrossSheetResolver, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<*const (dyn CrossSheetResolver + 'static)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CROSS_RESOLVER.with(|c| *c.borrow_mut() = self.0);
        }
    }
    // Erase the resolver's lifetime to 'static. Sound because the guard
    // below pops the TLS entry before this stack frame returns.
    let resolver_static: &'static dyn CrossSheetResolver =
        unsafe { std::mem::transmute(resolver) };
    let prev = CROSS_RESOLVER.with(|c| {
        let p = *c.borrow();
        *c.borrow_mut() = Some(resolver_static as *const _);
        p
    });
    let _restore = Restore(prev);
    f()
}

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
        Expr::Bool(b) => Value::Boolean(*b),

        Expr::CellRef(addr) => {
            if addr.row == REF_INVALID_ROW || addr.col == REF_INVALID_COL {
                return Value::Error(ValueError::InvalidRef);
            }
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

        Expr::SheetRef { sheet, addr } => {
            // If a Workbook context installed a resolver via
            // `with_cross_resolver`, dispatch to it. Otherwise standalone
            // Sheet eval has no cross-sheet scope and we return #REF!.
            CROSS_RESOLVER.with(|c| {
                if let Some(ptr) = *c.borrow() {
                    // SAFETY: the guard in with_cross_resolver clears this
                    // pointer before the resolver's stack frame returns,
                    // so the deref happens during the resolver's lifetime.
                    unsafe { (*ptr).resolve(sheet, *addr) }
                } else {
                    Value::Error(ValueError::InvalidRef)
                }
            })
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

/// Collect a range as a row-major 2D grid (rows × cols).
fn collect_range_2d(
    start: &CellAddress,
    end: &CellAddress,
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Vec<Vec<Value>> {
    let min_row = start.row.min(end.row);
    let max_row = start.row.max(end.row);
    let min_col = start.col.min(end.col);
    let max_col = start.col.max(end.col);
    (min_row..=max_row)
        .map(|row| {
            (min_col..=max_col)
                .map(|col| {
                    let addr = CellAddress::new(row, col);
                    cell_map
                        .get(&addr)
                        .map(|&id| get(id))
                        .unwrap_or(Value::Null)
                })
                .collect()
        })
        .collect()
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
        grid.iter().map(|r| r.first().cloned().unwrap_or(Value::Null)).collect()
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
    cell.cloned().unwrap_or(Value::Error(ValueError::InvalidRef))
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
        Expr::Range { start, end } => Some((start, end)),
        _ => None,
    }
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
            // Empty set: Excel returns 0 if there are no numeric arguments
            // at all — but #NUM! in some versions. We prefer #VALUE! over a
            // misleading 0 (B.6). Callers wanting "0 default" should pass it.
            min.map_or(Value::Error(ValueError::InvalidValue), Value::Number)
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

        // === Phase 5: lookup / stats / dates ===

        "VLOOKUP" => {
            // VLOOKUP(lookup_value, table_range, col_index, [range_lookup])
            // range_lookup: TRUE/omitted = approximate (range must be sorted
            // ascending in col 1; finds largest value ≤ needle), FALSE = exact.
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::InvalidValue);
            }
            let needle = eval_expr(&args[0], get, cell_map);
            let (start, end) = match arg_as_range(&args[1]) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let col_idx = match coerce_to_number(&eval_expr(&args[2], get, cell_map)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let approximate = if args.len() == 4 {
                coerce_to_bool(&eval_expr(&args[3], get, cell_map)).unwrap_or(true)
            } else {
                true
            };
            let grid = collect_range_2d(start, end, get, cell_map);
            lookup_2d(&grid, &needle, col_idx, approximate, /* horizontal = */ false)
        }

        "HLOOKUP" => {
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::InvalidValue);
            }
            let needle = eval_expr(&args[0], get, cell_map);
            let (start, end) = match arg_as_range(&args[1]) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let row_idx = match coerce_to_number(&eval_expr(&args[2], get, cell_map)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let approximate = if args.len() == 4 {
                coerce_to_bool(&eval_expr(&args[3], get, cell_map)).unwrap_or(true)
            } else {
                true
            };
            let grid = collect_range_2d(start, end, get, cell_map);
            lookup_2d(&grid, &needle, row_idx, approximate, /* horizontal = */ true)
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
            let r = match coerce_to_number(&eval_expr(&args[1], get, cell_map)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let c = match coerce_to_number(&eval_expr(&args[2], get, cell_map)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let grid = collect_range_2d(start, end, get, cell_map);
            grid.get(r - 1)
                .and_then(|row| row.get(c - 1).cloned())
                .unwrap_or(Value::Error(ValueError::InvalidRef))
        }

        "MATCH" => {
            // MATCH(value, range, [type=0 exact])
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let needle = eval_expr(&args[0], get, cell_map);
            let values = collect_arg_values(&args[1], get, cell_map);
            for (i, v) in values.iter().enumerate() {
                if values_equal(v, &needle) {
                    return Value::Number((i + 1) as f64);
                }
            }
            Value::Error(ValueError::InvalidValue)
        }

        // Stats
        "MEDIAN" => {
            let mut nums: Vec<f64> = Vec::new();
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    if let Value::Number(n) = v {
                        nums.push(n);
                    } else if let Value::Error(e) = v {
                        return Value::Error(e);
                    }
                }
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
            let mut nums: Vec<i64> = Vec::new();
            for arg in args {
                for v in collect_arg_values(arg, get, cell_map) {
                    if let Value::Number(n) = v {
                        // Multiply to preserve some decimals; mode for floats
                        // is rare and we want bit-stable hashing.
                        nums.push((n * 1e9).round() as i64);
                    }
                }
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
            let nums = collect_numbers(args, get, cell_map);
            if nums.len() < 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>()
                / (nums.len() as f64 - 1.0);
            Value::Number(var.sqrt())
        }

        "VAR" => {
            let nums = collect_numbers(args, get, cell_map);
            if nums.len() < 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>()
                / (nums.len() as f64 - 1.0);
            Value::Number(var)
        }

        "LARGE" => {
            // LARGE(range, k) — kth largest, 1-based
            if args.len() != 2 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut nums = collect_numbers(&args[..1], get, cell_map);
            let k = match coerce_to_number(&eval_expr(&args[1], get, cell_map)) {
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
            let mut nums = collect_numbers(&args[..1], get, cell_map);
            let k = match coerce_to_number(&eval_expr(&args[1], get, cell_map)) {
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
            Value::Number(date_serial(
                today.year(),
                today.month(),
                today.day(),
            ))
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
            let y = coerce_to_number(&eval_expr(&args[0], get, cell_map));
            let m = coerce_to_number(&eval_expr(&args[1], get, cell_map));
            let d = coerce_to_number(&eval_expr(&args[2], get, cell_map));
            match (y, m, d) {
                (Some(y), Some(m), Some(d)) => Value::Number(date_serial(
                    y as i32, m as u32, d as u32,
                )),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        "YEAR" => date_part(args, get, cell_map, |y, _, _| y as f64),
        "MONTH" => date_part(args, get, cell_map, |_, m, _| m as f64),
        "DAY" => date_part(args, get, cell_map, |_, _, d| d as f64),

        _ => Value::Error(ValueError::InvalidName),
    }
}

fn collect_numbers(
    args: &[Expr],
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
) -> Vec<f64> {
    let mut out = Vec::new();
    for arg in args {
        for v in collect_arg_values(arg, get, cell_map) {
            if let Value::Number(n) = v {
                out.push(n);
            }
        }
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
        let dm = DOM[(month - 1) as usize] as i64
            + if month == 2 && is_leap(year) { 1 } else { 0 };
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
    get: &dyn Fn(AtomId) -> Value,
    cell_map: &HashMap<CellAddress, AtomId>,
    f: impl Fn(i32, u32, u32) -> f64,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::InvalidValue);
    }
    let v = eval_expr(&args[0], get, cell_map);
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
        assert_eq!(
            eval_str("=INDEX(A1:B3,2,2)", &cm, &vs),
            Value::Number(20.0)
        );
        // MATCH(2, A1:A3, 0) → 2 (1-based)
        assert_eq!(
            eval_str("=MATCH(2,A1:A3,0)", &cm, &vs),
            Value::Number(2.0)
        );
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
        assert_eq!(
            eval_str("=MEDIAN(A1,B1,A2)", &cm, &vs),
            Value::Number(10.0)
        );
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
        assert_eq!(
            eval_str("=LARGE(A1:B2,1)", &cm, &vs),
            Value::Number(20.0)
        );
        assert_eq!(
            eval_str("=SMALL(A1:B2,1)", &cm, &vs),
            Value::Number(5.0)
        );
    }

    #[test]
    fn eval_vlookup_approximate_match() {
        // Tax bracket lookup: thresholds 0/100/1000/10000 -> rates
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        for (i, (threshold, rate)) in
            [(0.0, 5.0), (100.0, 10.0), (1000.0, 20.0), (10000.0, 30.0)].iter().enumerate()
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
}
