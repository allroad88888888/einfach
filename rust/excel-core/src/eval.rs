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
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
        for addr in range.iter() {
            let v = self.cell(addr);
            f(addr, v);
        }
    }

    /// Iterate a range on another sheet. Workbook providers override this
    /// with sparse sheet-aware traversal; single-sheet shims surface #REF!
    /// without walking the nominal rectangle.
    fn for_each_sheet_range_cell(
        &self,
        _sheet: &str,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        f(
            range.normalize().start,
            Value::Error(ValueError::InvalidRef),
        );
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
                _ => Value::Error(ValueError::WrongType),
            }
        }

        Expr::FuncCall { name, args } => eval_func(name, args, provider),

        Expr::Range { start, end, .. } | Expr::SheetRange { start, end, .. } => {
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
                    Value::Error(ValueError::Overflow)
                }
            }
            // Concat / comparisons handled above
            _ => Value::Error(ValueError::InvalidValue),
        },
        // Arithmetic op with a non-numeric (non-coercible) operand.
        _ => Value::Error(ValueError::WrongType),
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
/// Excel maximum dimensions. Full-column (`A:A`) and full-row (`1:1`)
/// ranges use `u32::MAX` as a sentinel on the unbounded axis. Allocating
/// a grid of that size would overflow in debug builds and attempt a
/// multi-billion-cell allocation in release. We reject such ranges with
/// `#REF!` before any allocation; callers that need streaming over
/// unbounded ranges should use `for_each_arg_value` / `for_each_range_cell`
/// instead of `collect_range_2d`.
const EXCEL_MAX_ROWS: u32 = 1_048_576;
const EXCEL_MAX_COLS: u32 = 16_384;

fn collect_range_2d(
    start: &CellAddress,
    end: &CellAddress,
    provider: &dyn EvalProvider,
) -> Vec<Vec<Value>> {
    let min_row = start.row.min(end.row);
    let max_row = start.row.max(end.row);
    let min_col = start.col.min(end.col);
    let max_col = start.col.max(end.col);
    // Guard against unbounded sentinel coordinates (u32::MAX on either axis
    // produced by full-column `A:A` or full-row `1:1` range syntax). Such
    // ranges cannot be materialised as a 2D grid; return an empty sentinel
    // that lookup_2d will turn into #REF!.
    if max_row > EXCEL_MAX_ROWS || max_col > EXCEL_MAX_COLS {
        return vec![];
    }
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

/// Extract the start/end addresses and optional sheet name from a range
/// argument. Handles both `Expr::Range` (same-sheet) and `Expr::SheetRange`
/// (cross-sheet) so that VLOOKUP / HLOOKUP / INDEX can accept either form.
fn arg_as_range<'a>(arg: &'a Expr) -> Option<(Option<&'a str>, &'a CellAddress, &'a CellAddress)> {
    match arg {
        Expr::Range { start, end, .. } => Some((None, start, end)),
        Expr::SheetRange {
            sheet, start, end, ..
        } => Some((Some(sheet.as_str()), start, end)),
        _ => None,
    }
}

/// Build a 2D grid from an argument expression that is either a same-sheet
/// or cross-sheet range. Routes through `for_each_sheet_range_cell` for
/// cross-sheet ranges so the provider resolves cells against the correct
/// sheet rather than the formula's own sheet.
///
/// Also handles dynamic range expressions: if the argument is `OFFSET(...)`,
/// it is evaluated to a runtime `CellRange` which is then materialised as a
/// 2D grid — so `VLOOKUP(x, OFFSET(A1,0,0,10,2), 2, FALSE)` works correctly.
fn collect_range_2d_for_arg(
    arg: &Expr,
    provider: &dyn EvalProvider,
) -> Option<Vec<Vec<Value>>> {
    // Dynamic range via OFFSET.
    if let Expr::FuncCall { name, args: fn_args } = arg {
        if name == "OFFSET" {
            let range = eval_offset_as_range(fn_args, provider)?;
            return Some(collect_range_2d(&range.start, &range.end, provider));
        }
    }
    match arg_as_range(arg)? {
        (None, start, end) => Some(collect_range_2d(start, end, provider)),
        (Some(sheet), start, end) => {
            let min_row = start.row.min(end.row);
            let max_row = start.row.max(end.row);
            let min_col = start.col.min(end.col);
            let max_col = start.col.max(end.col);
            if max_row > EXCEL_MAX_ROWS || max_col > EXCEL_MAX_COLS {
                return Some(vec![]);
            }
            let rows = (max_row - min_row + 1) as usize;
            let cols = (max_col - min_col + 1) as usize;
            let mut grid: Vec<Vec<Value>> = (0..rows).map(|_| vec![Value::Null; cols]).collect();
            let range = CellRange::new(*start, *end);
            provider.for_each_sheet_range_cell(sheet, range, &mut |addr, value| {
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
            Some(grid)
        }
    }
}

/// Evaluate an `OFFSET(ref, row_off, col_off[, height[, width]])` call and
/// return the resolved `CellRange`, or `None` if arguments are invalid.
/// `ref` must be a `CellRef` (single-cell anchor); row/col offsets are
/// applied to produce the top-left corner; height/width (default 1×1) give
/// the extent. All numeric args must be coercible; otherwise returns `None`.
fn eval_offset_as_range(args: &[Expr], provider: &dyn EvalProvider) -> Option<CellRange> {
    if args.len() < 3 || args.len() > 5 {
        return None;
    }
    // First arg must be a cell reference (the anchor).
    let anchor = match &args[0] {
        Expr::CellRef(addr) => *addr,
        _ => return None,
    };
    let row_off = coerce_to_number(&eval_expr_with_provider(&args[1], provider))? as i64;
    let col_off = coerce_to_number(&eval_expr_with_provider(&args[2], provider))? as i64;
    let height = if args.len() >= 4 {
        let h = coerce_to_number(&eval_expr_with_provider(&args[3], provider))?;
        if h < 1.0 {
            return None;
        }
        h as u32
    } else {
        1
    };
    let width = if args.len() == 5 {
        let w = coerce_to_number(&eval_expr_with_provider(&args[4], provider))?;
        if w < 1.0 {
            return None;
        }
        w as u32
    } else {
        1
    };
    let start_row = anchor.row as i64 + row_off;
    let start_col = anchor.col as i64 + col_off;
    if start_row < 0 || start_col < 0 {
        return None;
    }
    let start = CellAddress::new(start_row as u32, start_col as u32);
    let end = CellAddress::new(start_row as u32 + height - 1, start_col as u32 + width - 1);
    Some(CellRange::new(start, end))
}

/// Normalized rectangle resolved from a range-shaped argument expression.
/// Used by the multi-criteria aggregates (COUNTIFS / SUMIFS / AVERAGEIF /
/// AVERAGEIFS / MAXIFS / MINIFS) where every range has to share the same
/// (rows, cols) shape. `sheet` is `Some` only for cross-sheet ranges.
#[derive(Clone)]
struct ResolvedRange {
    sheet: Option<String>,
    start_row: u32,
    start_col: u32,
    rows: u32,
    cols: u32,
}

/// Resolve a function-argument expression to a normalized range. Accepts
/// `Expr::Range`, `Expr::SheetRange`, and `OFFSET(...)`. Anything else
/// returns `None` — the caller surfaces `InvalidValue` to keep parity with
/// Excel's `#VALUE!`.
fn resolve_range_arg(arg: &Expr, provider: &dyn EvalProvider) -> Option<ResolvedRange> {
    // OFFSET(...) → runtime range.
    if let Expr::FuncCall { name, args: fn_args } = arg {
        if name == "OFFSET" {
            let r = eval_offset_as_range(fn_args, provider)?;
            let n = r.normalize();
            return Some(ResolvedRange {
                sheet: None,
                start_row: n.start.row,
                start_col: n.start.col,
                rows: n.end.row - n.start.row + 1,
                cols: n.end.col - n.start.col + 1,
            });
        }
    }
    match arg_as_range(arg)? {
        (sheet, start, end) => {
            let r = CellRange::new(*start, *end).normalize();
            // Guard: full-column / full-row sentinel ranges would balloon
            // the (rows, cols) loop. Reject them — the caller surfaces
            // InvalidValue, consistent with VLOOKUP's full-column guard.
            if r.end.row > EXCEL_MAX_ROWS || r.end.col > EXCEL_MAX_COLS {
                return None;
            }
            Some(ResolvedRange {
                sheet: sheet.map(|s| s.to_string()),
                start_row: r.start.row,
                start_col: r.start.col,
                rows: r.end.row - r.start.row + 1,
                cols: r.end.col - r.start.col + 1,
            })
        }
    }
}

/// Look up a single cell within a `ResolvedRange` by (dr, dc) offset.
fn fetch_range_cell(
    range: &ResolvedRange,
    dr: u32,
    dc: u32,
    provider: &dyn EvalProvider,
) -> Value {
    let addr = CellAddress::new(range.start_row + dr, range.start_col + dc);
    match &range.sheet {
        Some(s) => provider.sheet_cell(s, addr),
        None => provider.cell(addr),
    }
}

/// Walk pairs of `(range_arg, criterion_arg)` from a slice of function
/// arguments. The slice's length must be even and ≥ 2 — callers should
/// arg-count check first. All ranges must share the shape of `args[0]`,
/// otherwise `InvalidValue` is returned. Criteria expressions are
/// evaluated once per call (outside the per-cell loop).
fn collect_criteria_pairs(
    args: &[Expr],
    provider: &dyn EvalProvider,
) -> Result<Vec<(ResolvedRange, Value)>, ValueError> {
    if args.is_empty() || args.len() % 2 != 0 {
        return Err(ValueError::WrongArgCount);
    }
    let mut pairs: Vec<(ResolvedRange, Value)> = Vec::with_capacity(args.len() / 2);
    let mut shape: Option<(u32, u32)> = None;
    let mut i = 0;
    while i < args.len() {
        let range = match resolve_range_arg(&args[i], provider) {
            Some(r) => r,
            None => return Err(ValueError::InvalidValue),
        };
        if let Some((rows, cols)) = shape {
            if range.rows != rows || range.cols != cols {
                return Err(ValueError::InvalidValue);
            }
        } else {
            shape = Some((range.rows, range.cols));
        }
        let criterion = eval_expr_with_provider(&args[i + 1], provider);
        pairs.push((range, criterion));
        i += 2;
    }
    Ok(pairs)
}

/// Stream values produced by a function argument. For `Range` args this
/// goes through `provider.for_each_range_cell` (sparse-aware); for any
/// other expression it evaluates once and yields the single value. The
/// closure sees `(Option<addr>, value)` — `Some` for range cells, `None`
/// for evaluated sub-expressions — so callers like `SUMIF` can still
/// align `range`/`sum_range` by relative position when both are ranges.
///
/// Dynamic range expressions: if the argument is `OFFSET(...)`, it is
/// evaluated to a runtime `CellRange` and iterated cell-by-cell via the
/// provider — so `SUM(OFFSET(A1,0,0,5,1))` works like `SUM(A1:A5)`.
fn for_each_arg_value(
    arg: &Expr,
    provider: &dyn EvalProvider,
    f: &mut dyn FnMut(Option<CellAddress>, Value),
) {
    match arg {
        Expr::Range { start, end, .. } => {
            stream_range(start, end, provider, &mut |addr, v| f(Some(addr), v));
        }
        Expr::SheetRange {
            sheet, start, end, ..
        } => {
            let range = CellRange::new(*start, *end);
            provider.for_each_sheet_range_cell(sheet, range, &mut |addr, v| f(Some(addr), v));
        }
        // Dynamic range: OFFSET(...) used in place of a literal range arg.
        Expr::FuncCall { name, args: fn_args } if name == "OFFSET" => {
            match eval_offset_as_range(fn_args, provider) {
                Some(range) => {
                    provider.for_each_range_cell(range, &mut |addr, v| f(Some(addr), v));
                }
                None => f(None, Value::Error(ValueError::InvalidRef)),
            }
        }
        _ => f(None, eval_expr_with_provider(arg, provider)),
    }
}

fn eval_func(name: &str, args: &[Expr], provider: &dyn EvalProvider) -> Value {
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
                return Value::Error(ValueError::WrongArgCount);
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
                            None => err = Some(ValueError::WrongType),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if !saw_any {
                Value::Error(ValueError::WrongArgCount)
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
                            None => err = Some(ValueError::WrongType),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if !saw_any {
                Value::Error(ValueError::WrongArgCount)
            } else {
                Value::Boolean(result)
            }
        }
        "NOT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match coerce_to_bool(&v) {
                Some(b) => Value::Boolean(!b),
                None => match v {
                    Value::Error(e) => Value::Error(e),
                    _ => Value::Error(ValueError::WrongType),
                },
            }
        }

        // === Math ===
        "ABS" => unary_number(args, provider, |n| n.abs()),
        "SQRT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if n < 0.0 => Value::Error(ValueError::Overflow),
                Some(n) => Value::Number(n.sqrt()),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "ROUND" => {
            // ROUND(value, digits)
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let n = eval_expr_with_provider(&args[0], provider);
            let d = eval_expr_with_provider(&args[1], provider);
            match (coerce_to_number(&n), coerce_to_number(&d)) {
                (Some(value), Some(digits)) => {
                    let factor = 10f64.powi(digits as i32);
                    Value::Number((value * factor).round() / factor)
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "CEILING" => unary_number(args, provider, f64::ceil),
        "FLOOR" => unary_number(args, provider, f64::floor),
        "POWER" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let b = eval_expr_with_provider(&args[0], provider);
            let e = eval_expr_with_provider(&args[1], provider);
            match (coerce_to_number(&b), coerce_to_number(&e)) {
                (Some(base), Some(exp)) => {
                    let r = base.powf(exp);
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "MOD" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let a = eval_expr_with_provider(&args[0], provider);
            let b = eval_expr_with_provider(&args[1], provider);
            match (coerce_to_number(&a), coerce_to_number(&b)) {
                (Some(_), Some(0.0)) => Value::Error(ValueError::DivisionByZero),
                (Some(va), Some(vb)) => Value::Number(va.rem_euclid(vb)),
                _ => Value::Error(ValueError::WrongType),
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
                return Value::Error(ValueError::WrongArgCount);
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
                return Value::Error(ValueError::WrongArgCount);
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
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "UPPER" => text_unary(args, provider, |s| s.to_uppercase()),
        "LOWER" => text_unary(args, provider, |s| s.to_lowercase()),
        "TRIM" => text_unary(args, provider, |s| s.trim().to_string()),
        "TEXT" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let n = eval_expr_with_provider(&args[0], provider);
            let fmt = coerce_to_text(&eval_expr_with_provider(&args[1], provider));
            let n = match coerce_to_number(&n) {
                Some(v) if v.is_finite() => v,
                Some(_) => return Value::Error(ValueError::Overflow),
                None => return Value::Error(ValueError::WrongType),
            };
            match format_with_text_pattern(n, &fmt) {
                Some(formatted) => Value::Text(formatted),
                None => Value::Error(ValueError::InvalidValue),
            }
        }

        // === Conditional aggregates ===
        "COUNTIF" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
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
                return Value::Error(ValueError::WrongArgCount);
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
                                let target = provider.cell(CellAddress::new(r as u32, c as u32));
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

        // === Multi-criteria aggregates (COUNTIFS/SUMIFS/AVERAGEIF/AVERAGEIFS/MAXIFS/MINIFS) ===
        //
        // Shape rules: all criteria ranges AND the value range (sum_range /
        // average_range / max_range / min_range) share the same (rows, cols)
        // shape. Shape mismatch → InvalidValue (Excel maps this to #VALUE!).
        //
        // Range arg accepted: literal `Range` / `SheetRange`, or `OFFSET(...)`.
        // Anything else → InvalidValue.
        //
        // Error propagation: if any criteria-range cell or value-range cell
        // evaluates to `Value::Error(e)`, the aggregate returns `Error(e)`.
        //
        // For COUNTIFS, "match" is reported on any non-Null criteria cell
        // where the criterion passes — including Text and Boolean — matching
        // Excel's COUNTIFS (which counts on criteria match, not numeric-ness).
        // Sums/averages/min/max only accept `Value::Number(_)`.
        "AVERAGEIF" => {
            // AVERAGEIF(range, criterion[, average_range])
            if args.len() != 2 && args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let crit_range = match resolve_range_arg(&args[0], provider) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let value_range = if args.len() == 3 {
                match resolve_range_arg(&args[2], provider) {
                    Some(r) => r,
                    None => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                crit_range.clone()
            };
            if crit_range.rows != value_range.rows || crit_range.cols != value_range.cols {
                return Value::Error(ValueError::InvalidValue);
            }
            let criterion = eval_expr_with_provider(&args[1], provider);
            let mut sum = 0.0_f64;
            let mut count = 0u64;
            for dr in 0..crit_range.rows {
                for dc in 0..crit_range.cols {
                    let cv = fetch_range_cell(&crit_range, dr, dc, provider);
                    if let Value::Error(e) = cv {
                        return Value::Error(e);
                    }
                    if matches_criterion(&cv, &criterion) {
                        let tv = fetch_range_cell(&value_range, dr, dc, provider);
                        if let Value::Error(e) = tv {
                            return Value::Error(e);
                        }
                        if let Value::Number(n) = tv {
                            sum += n;
                            count += 1;
                        }
                    }
                }
            }
            if count == 0 {
                return Value::Error(ValueError::DivisionByZero);
            }
            Value::Number(sum / count as f64)
        }
        "COUNTIFS" => {
            // COUNTIFS(range1, criterion1, [range2, criterion2, ...])
            if args.is_empty() || args.len() % 2 != 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let pairs = match collect_criteria_pairs(args, provider) {
                Ok(p) => p,
                Err(e) => return Value::Error(e),
            };
            // pairs[0] is the shape-defining range.
            let (shape_range, _) = &pairs[0];
            let rows = shape_range.rows;
            let cols = shape_range.cols;
            let mut count = 0u64;
            for dr in 0..rows {
                for dc in 0..cols {
                    let mut all_match = true;
                    let mut has_value = false;
                    for (range, criterion) in &pairs {
                        let cv = fetch_range_cell(range, dr, dc, provider);
                        if let Value::Error(e) = cv {
                            return Value::Error(e);
                        }
                        if !matches!(cv, Value::Null) {
                            has_value = true;
                        }
                        if !matches_criterion(&cv, criterion) {
                            all_match = false;
                            break;
                        }
                    }
                    if all_match && has_value {
                        count += 1;
                    }
                }
            }
            Value::Number(count as f64)
        }
        "SUMIFS" => {
            // SUMIFS(sum_range, range1, criterion1, [range2, criterion2, ...])
            if args.len() < 3 || args.len() % 2 == 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let sum_range = match resolve_range_arg(&args[0], provider) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let pairs = match collect_criteria_pairs(&args[1..], provider) {
                Ok(p) => p,
                Err(e) => return Value::Error(e),
            };
            for (range, _) in &pairs {
                if range.rows != sum_range.rows || range.cols != sum_range.cols {
                    return Value::Error(ValueError::InvalidValue);
                }
            }
            let mut total = 0.0_f64;
            for dr in 0..sum_range.rows {
                for dc in 0..sum_range.cols {
                    let mut all_match = true;
                    for (range, criterion) in &pairs {
                        let cv = fetch_range_cell(range, dr, dc, provider);
                        if let Value::Error(e) = cv {
                            return Value::Error(e);
                        }
                        if !matches_criterion(&cv, criterion) {
                            all_match = false;
                            break;
                        }
                    }
                    if all_match {
                        let tv = fetch_range_cell(&sum_range, dr, dc, provider);
                        if let Value::Error(e) = tv {
                            return Value::Error(e);
                        }
                        if let Value::Number(n) = tv {
                            total += n;
                        }
                    }
                }
            }
            Value::Number(total)
        }
        "AVERAGEIFS" => {
            // AVERAGEIFS(average_range, range1, criterion1, ...)
            if args.len() < 3 || args.len() % 2 == 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let avg_range = match resolve_range_arg(&args[0], provider) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let pairs = match collect_criteria_pairs(&args[1..], provider) {
                Ok(p) => p,
                Err(e) => return Value::Error(e),
            };
            for (range, _) in &pairs {
                if range.rows != avg_range.rows || range.cols != avg_range.cols {
                    return Value::Error(ValueError::InvalidValue);
                }
            }
            let mut sum = 0.0_f64;
            let mut count = 0u64;
            for dr in 0..avg_range.rows {
                for dc in 0..avg_range.cols {
                    let mut all_match = true;
                    for (range, criterion) in &pairs {
                        let cv = fetch_range_cell(range, dr, dc, provider);
                        if let Value::Error(e) = cv {
                            return Value::Error(e);
                        }
                        if !matches_criterion(&cv, criterion) {
                            all_match = false;
                            break;
                        }
                    }
                    if all_match {
                        let tv = fetch_range_cell(&avg_range, dr, dc, provider);
                        if let Value::Error(e) = tv {
                            return Value::Error(e);
                        }
                        if let Value::Number(n) = tv {
                            sum += n;
                            count += 1;
                        }
                    }
                }
            }
            if count == 0 {
                return Value::Error(ValueError::DivisionByZero);
            }
            Value::Number(sum / count as f64)
        }
        "MAXIFS" => {
            // MAXIFS(max_range, range1, criterion1, ...)
            if args.len() < 3 || args.len() % 2 == 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let max_range = match resolve_range_arg(&args[0], provider) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let pairs = match collect_criteria_pairs(&args[1..], provider) {
                Ok(p) => p,
                Err(e) => return Value::Error(e),
            };
            for (range, _) in &pairs {
                if range.rows != max_range.rows || range.cols != max_range.cols {
                    return Value::Error(ValueError::InvalidValue);
                }
            }
            let mut best: Option<f64> = None;
            for dr in 0..max_range.rows {
                for dc in 0..max_range.cols {
                    let mut all_match = true;
                    for (range, criterion) in &pairs {
                        let cv = fetch_range_cell(range, dr, dc, provider);
                        if let Value::Error(e) = cv {
                            return Value::Error(e);
                        }
                        if !matches_criterion(&cv, criterion) {
                            all_match = false;
                            break;
                        }
                    }
                    if all_match {
                        let tv = fetch_range_cell(&max_range, dr, dc, provider);
                        if let Value::Error(e) = tv {
                            return Value::Error(e);
                        }
                        if let Value::Number(n) = tv {
                            best = Some(match best {
                                Some(b) => b.max(n),
                                None => n,
                            });
                        }
                    }
                }
            }
            Value::Number(best.unwrap_or(0.0))
        }
        "MINIFS" => {
            // MINIFS(min_range, range1, criterion1, ...)
            if args.len() < 3 || args.len() % 2 == 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let min_range = match resolve_range_arg(&args[0], provider) {
                Some(r) => r,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let pairs = match collect_criteria_pairs(&args[1..], provider) {
                Ok(p) => p,
                Err(e) => return Value::Error(e),
            };
            for (range, _) in &pairs {
                if range.rows != min_range.rows || range.cols != min_range.cols {
                    return Value::Error(ValueError::InvalidValue);
                }
            }
            let mut best: Option<f64> = None;
            for dr in 0..min_range.rows {
                for dc in 0..min_range.cols {
                    let mut all_match = true;
                    for (range, criterion) in &pairs {
                        let cv = fetch_range_cell(range, dr, dc, provider);
                        if let Value::Error(e) = cv {
                            return Value::Error(e);
                        }
                        if !matches_criterion(&cv, criterion) {
                            all_match = false;
                            break;
                        }
                    }
                    if all_match {
                        let tv = fetch_range_cell(&min_range, dr, dc, provider);
                        if let Value::Error(e) = tv {
                            return Value::Error(e);
                        }
                        if let Value::Number(n) = tv {
                            best = Some(match best {
                                Some(b) => b.min(n),
                                None => n,
                            });
                        }
                    }
                }
            }
            Value::Number(best.unwrap_or(0.0))
        }

        // === Phase 5: lookup / stats / dates ===
        "VLOOKUP" => {
            // VLOOKUP(lookup_value, table_range, col_index, [range_lookup])
            // range_lookup: TRUE/omitted = approximate (range must be sorted
            // ascending in col 1; finds largest value ≤ needle), FALSE = exact.
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            let grid = match collect_range_2d_for_arg(&args[1], provider) {
                Some(g) => g,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let col_idx = match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::WrongType),
            };
            let approximate = if args.len() == 4 {
                coerce_to_bool(&eval_expr_with_provider(&args[3], provider)).unwrap_or(true)
            } else {
                true
            };
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
                return Value::Error(ValueError::WrongArgCount);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            let grid = match collect_range_2d_for_arg(&args[1], provider) {
                Some(g) => g,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let row_idx = match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::WrongType),
            };
            let approximate = if args.len() == 4 {
                coerce_to_bool(&eval_expr_with_provider(&args[3], provider)).unwrap_or(true)
            } else {
                true
            };
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
                return Value::Error(ValueError::WrongArgCount);
            }
            let grid = match collect_range_2d_for_arg(&args[0], provider) {
                Some(g) => g,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let r = match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::WrongType),
            };
            let c = match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::WrongType),
            };
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
                return Value::Error(ValueError::WrongArgCount);
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
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut nums = collect_numbers(&args[..1], provider);
            let k = match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::WrongType),
            };
            if k > nums.len() {
                return Value::Error(ValueError::InvalidValue);
            }
            nums.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            Value::Number(nums[k - 1])
        }

        "SMALL" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut nums = collect_numbers(&args[..1], provider);
            let k = match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::WrongType),
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
                return Value::Error(ValueError::WrongArgCount);
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

        // === Dynamic range ===
        // OFFSET(ref, row_offset, col_offset[, height[, width]])
        //
        // When used directly (not as an argument to an aggregate), OFFSET
        // returns the *value* of the top-left cell of the computed range —
        // matching Excel's behaviour when the result is a 1×1 region.
        // When used as a range argument to SUM / COUNT / AVERAGE / VLOOKUP
        // / etc., `for_each_arg_value` and `collect_range_2d_for_arg` detect
        // the OFFSET call and iterate the full computed range instead.
        "OFFSET" => {
            if args.len() < 3 || args.len() > 5 {
                return Value::Error(ValueError::WrongArgCount);
            }
            match eval_offset_as_range(args, provider) {
                Some(range) => provider.cell(range.start),
                None => Value::Error(ValueError::InvalidRef),
            }
        }

        // === B2: extended math ===
        // INT(n) truncates toward -∞ (i.e. floor), so INT(-2.5) = -3.
        "INT" => unary_number(args, provider, f64::floor),
        // TRUNC(n[, digits]) truncates toward zero. Default digits = 0.
        // Negative digits truncate to the left of the decimal point
        // (e.g. TRUNC(123.45, -1) = 120).
        "TRUNC" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let digits = if args.len() == 2 {
                let dv = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = dv {
                    return Value::Error(e);
                }
                match coerce_to_number(&dv) {
                    Some(d) => d.trunc() as i32,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0
            };
            match coerce_to_number(&nv) {
                Some(n) => {
                    let factor = 10f64.powi(digits);
                    let r = (n * factor).trunc() / factor;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "SIGN" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let s = if n > 0.0 {
                        1.0
                    } else if n < 0.0 {
                        -1.0
                    } else {
                        0.0
                    };
                    Value::Number(s)
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "EXP" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let r = n.exp();
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "LN" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if n > 0.0 => {
                    let r = n.ln();
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                Some(_) => Value::Error(ValueError::Overflow),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "LOG" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let base = if args.len() == 2 {
                let bv = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = bv {
                    return Value::Error(e);
                }
                match coerce_to_number(&bv) {
                    Some(b) => b,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                10.0
            };
            match coerce_to_number(&nv) {
                Some(n) if n > 0.0 && base > 0.0 && base != 1.0 => {
                    let r = n.log(base);
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                Some(_) => Value::Error(ValueError::Overflow),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "LOG10" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if n > 0.0 => {
                    let r = n.log10();
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                Some(_) => Value::Error(ValueError::Overflow),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "PI" => {
            if !args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            Value::Number(std::f64::consts::PI)
        }
        "ROUNDUP" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let dv = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = dv {
                return Value::Error(e);
            }
            match (coerce_to_number(&nv), coerce_to_number(&dv)) {
                (Some(n), Some(d)) => {
                    let factor = 10f64.powi(d.trunc() as i32);
                    let sign = if n < 0.0 { -1.0 } else { 1.0 };
                    let r = (n.abs() * factor).ceil() / factor * sign;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "ROUNDDOWN" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let dv = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = dv {
                return Value::Error(e);
            }
            match (coerce_to_number(&nv), coerce_to_number(&dv)) {
                (Some(n), Some(d)) => {
                    let factor = 10f64.powi(d.trunc() as i32);
                    let sign = if n < 0.0 { -1.0 } else { 1.0 };
                    let r = (n.abs() * factor).floor() / factor * sign;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "MROUND" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let mv = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = mv {
                return Value::Error(e);
            }
            match (coerce_to_number(&nv), coerce_to_number(&mv)) {
                (Some(_), Some(0.0)) => Value::Number(0.0),
                (Some(n), Some(m)) => {
                    // Excel: sign(n) must match sign(multiple) for both
                    // non-zero, otherwise #NUM!.
                    if n != 0.0 && ((n > 0.0) != (m > 0.0)) {
                        return Value::Error(ValueError::Overflow);
                    }
                    let r = (n / m).round() * m;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "PRODUCT" => {
            // Variadic: walk every arg via for_each_arg_value so range
            // args stream sparsely. Skip Null/Text/Boolean(false); treat
            // Boolean(true) as 1. Errors propagate. With zero numeric
            // contributors, return 0 to match Excel's "empty product → 0"
            // convention for PRODUCT specifically.
            let mut product = 1.0_f64;
            let mut saw_number = false;
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
                            product *= n;
                            saw_number = true;
                        }
                        Value::Boolean(true) => {
                            product *= 1.0;
                            saw_number = true;
                        }
                        Value::Null | Value::Text(_) | Value::Boolean(false) => {}
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if !saw_number {
                Value::Number(0.0)
            } else {
                Value::Number(product)
            }
        }
        "QUOTIENT" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let dv = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = dv {
                return Value::Error(e);
            }
            match (coerce_to_number(&nv), coerce_to_number(&dv)) {
                (Some(_), Some(0.0)) => Value::Error(ValueError::DivisionByZero),
                (Some(num), Some(den)) => Value::Number((num / den).trunc()),
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "FACT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let trimmed = n.trunc();
                    if trimmed < 0.0 {
                        return Value::Error(ValueError::Overflow);
                    }
                    // 170! ≈ 7.26e306, 171! overflows f64.
                    if trimmed > 170.0 {
                        return Value::Error(ValueError::Overflow);
                    }
                    let k = trimmed as u64;
                    let mut acc = 1.0_f64;
                    for i in 2..=k {
                        acc *= i as f64;
                    }
                    if acc.is_finite() {
                        Value::Number(acc)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "COMBIN" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let nv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = nv {
                return Value::Error(e);
            }
            let kv = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = kv {
                return Value::Error(e);
            }
            match (coerce_to_number(&nv), coerce_to_number(&kv)) {
                (Some(n_raw), Some(k_raw)) => {
                    let n = n_raw.trunc();
                    let k = k_raw.trunc();
                    if n < 0.0 || k < 0.0 || k > n {
                        return Value::Error(ValueError::Overflow);
                    }
                    // Symmetry: C(n,k) = C(n, n-k) — pick the smaller k
                    // to keep the loop short and the product bounded.
                    let n_i = n as u64;
                    let mut k_i = k as u64;
                    if k_i > n_i - k_i {
                        k_i = n_i - k_i;
                    }
                    let mut acc = 1.0_f64;
                    for i in 1..=k_i {
                        acc = acc * (n_i - i + 1) as f64 / i as f64;
                        if !acc.is_finite() {
                            return Value::Error(ValueError::Overflow);
                        }
                    }
                    Value::Number(acc.round())
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "GCD" => {
            // Variadic; require ≥ 1 numeric arg. Coerce to non-negative
            // integer; any negative or non-numeric → WrongType.
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut acc: Option<u64> = None;
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
                        Value::Null => {} // skip empties from ranges
                        other => match coerce_to_number(&other) {
                            Some(n) if n >= 0.0 && n.is_finite() => {
                                let x = n.trunc() as u64;
                                acc = Some(match acc {
                                    None => x,
                                    Some(a) => gcd_u64(a, x),
                                });
                            }
                            _ => err = Some(ValueError::WrongType),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else {
                match acc {
                    Some(g) => Value::Number(g as f64),
                    None => Value::Error(ValueError::WrongArgCount),
                }
            }
        }
        "LCM" => {
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut acc: Option<u64> = None;
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
                        other => match coerce_to_number(&other) {
                            Some(n) if n >= 0.0 && n.is_finite() => {
                                let x = n.trunc() as u64;
                                acc = Some(match acc {
                                    None => x,
                                    Some(a) => {
                                        if a == 0 || x == 0 {
                                            0
                                        } else {
                                            // (a / gcd(a,x)) * x with checked mul.
                                            let g = gcd_u64(a, x);
                                            match (a / g).checked_mul(x) {
                                                Some(l) => l,
                                                None => {
                                                    err = Some(ValueError::Overflow);
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                });
                            }
                            _ => err = Some(ValueError::WrongType),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else {
                match acc {
                    Some(l) => Value::Number(l as f64),
                    None => Value::Error(ValueError::WrongArgCount),
                }
            }
        }
        "COUNTA" => {
            // Count of args that come back as anything other than Null.
            // Errors and booleans both count (Excel semantics).
            let mut count = 0u64;
            for arg in args {
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if !matches!(v, Value::Null) {
                        count += 1;
                    }
                });
            }
            Value::Number(count as f64)
        }
        "COUNTBLANK" => {
            // Exactly 1 arg, ideally a range. Counts cells that come back
            // as Value::Null. Note: this walks the values yielded by
            // for_each_arg_value, which for sparse providers may visit
            // only populated cells — fine for the small test ranges, but
            // worth flagging if extended to full-column refs.
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut count = 0u64;
            for_each_arg_value(&args[0], provider, &mut |_addr, v| {
                if matches!(v, Value::Null) {
                    count += 1;
                }
            });
            Value::Number(count as f64)
        }

        // === B3: trig (radians) ===
        "SIN" => unary_number(args, provider, f64::sin),
        "COS" => unary_number(args, provider, f64::cos),
        "TAN" => unary_number(args, provider, f64::tan),
        "ASIN" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if (-1.0..=1.0).contains(&n) => Value::Number(n.asin()),
                Some(_) => Value::Error(ValueError::Overflow),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "ACOS" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if (-1.0..=1.0).contains(&n) => Value::Number(n.acos()),
                Some(_) => Value::Error(ValueError::Overflow),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "ATAN" => unary_number(args, provider, f64::atan),
        "ATAN2" => {
            // Note: Excel order is ATAN2(x_num, y_num) — but our spec
            // calls for (y, x) matching libm/JS Math.atan2. Per the task
            // description we follow the (y, x) order.
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let yv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = yv {
                return Value::Error(e);
            }
            let xv = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = xv {
                return Value::Error(e);
            }
            match (coerce_to_number(&yv), coerce_to_number(&xv)) {
                (Some(y), Some(x)) => {
                    let r = y.atan2(x);
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        "RADIANS" => unary_number(args, provider, |d| d * std::f64::consts::PI / 180.0),
        "DEGREES" => unary_number(args, provider, |r| r * 180.0 / std::f64::consts::PI),

        // === Error / type guards (Batch B1) ===
        //
        // IFERROR / IFNA: ValueError has no dedicated NA variant. Excel's
        // #N/A surfaces here as `InvalidValue` (lookup misses) or
        // `InvalidRef` (broken refs). IFNA catches those two; IFERROR
        // catches every error.
        "IFERROR" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match v {
                Value::Error(_) => eval_expr_with_provider(&args[1], provider),
                other => other,
            }
        }
        "IFNA" => {
            // Our enum has no dedicated NA — treat InvalidValue / InvalidRef
            // as the closest NA-equivalents (lookup misses, broken refs).
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match v {
                Value::Error(ValueError::InvalidValue) | Value::Error(ValueError::InvalidRef) => {
                    eval_expr_with_provider(&args[1], provider)
                }
                other => other,
            }
        }
        "IFS" => {
            // IFS(cond1, val1, cond2, val2, ...) — variadic; pairs only.
            if args.is_empty() || args.len() % 2 != 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut i = 0;
            while i < args.len() {
                let cond = eval_expr_with_provider(&args[i], provider);
                if let Value::Error(e) = cond {
                    return Value::Error(e);
                }
                let is_true = match cond {
                    Value::Boolean(b) => b,
                    Value::Number(n) => n != 0.0,
                    _ => false,
                };
                if is_true {
                    return eval_expr_with_provider(&args[i + 1], provider);
                }
                i += 2;
            }
            Value::Error(ValueError::InvalidValue)
        }
        "SWITCH" => {
            // SWITCH(expr, case1, val1, [case2, val2, ...], [default]).
            // Need at least expr + one (case, val) pair = 3 args.
            if args.len() < 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let expr_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = expr_v {
                return Value::Error(e);
            }
            // After the leading expr we walk (case, val) pairs. An odd
            // remainder after the leading arg is the default.
            let rest = &args[1..];
            let mut i = 0;
            while i + 1 < rest.len() {
                let case_v = eval_expr_with_provider(&rest[i], provider);
                if values_equal(&expr_v, &case_v) {
                    return eval_expr_with_provider(&rest[i + 1], provider);
                }
                i += 2;
            }
            // Trailing default?
            if i < rest.len() {
                return eval_expr_with_provider(&rest[i], provider);
            }
            Value::Error(ValueError::InvalidValue)
        }
        "XOR" => {
            // Variadic; result = (count of TRUE is odd). Errors propagate;
            // non-coercible values surface as WrongType.
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut true_count = 0u64;
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
                                if b {
                                    true_count += 1;
                                }
                            }
                            None => err = Some(ValueError::WrongType),
                        },
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else if !saw_any {
                Value::Error(ValueError::WrongArgCount)
            } else {
                Value::Boolean(true_count % 2 == 1)
            }
        }

        // === IS* family — never propagate errors, they classify them. ===
        "ISNUMBER" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(v, Value::Number(_)))
        }
        "ISTEXT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(v, Value::Text(_)))
        }
        "ISBLANK" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(v, Value::Null))
        }
        "ISERROR" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(v, Value::Error(_)))
        }
        "ISERR" => {
            // Excel: ISERR = ISERROR and not #N/A. With our mapping treat
            // InvalidValue as the NA-equivalent (same caveat as IFNA/ISNA).
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(
                v,
                Value::Error(e) if !matches!(e, ValueError::InvalidValue)
            ))
        }
        "ISNA" => {
            // No dedicated NA in our enum — closest equivalent is
            // InvalidValue (same caveat as IFNA).
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(v, Value::Error(ValueError::InvalidValue)))
        }
        "ISLOGICAL" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(matches!(v, Value::Boolean(_)))
        }
        "ISNONTEXT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            Value::Boolean(!matches!(v, Value::Text(_)))
        }
        "ISEVEN" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => Value::Boolean((n.trunc() as i64) % 2 == 0),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "ISODD" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => Value::Boolean((n.trunc() as i64) % 2 != 0),
                None => Value::Error(ValueError::WrongType),
            }
        }
        "N" => {
            // Excel quirk: N("anything") = 0; bool → 1/0; null → 0; error
            // propagates.
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match v {
                Value::Number(n) => Value::Number(n),
                Value::Boolean(true) => Value::Number(1.0),
                Value::Boolean(false) => Value::Number(0.0),
                Value::Null => Value::Number(0.0),
                Value::Text(_) => Value::Number(0.0),
                Value::Error(e) => Value::Error(e),
            }
        }
        "TYPE" => {
            // 1=Number, 2=Text, 4=Boolean, 16=Error. Null coerces to 0
            // (Excel returns 1 for empty cells).
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            let code = match v {
                Value::Number(_) => 1.0,
                Value::Text(_) => 2.0,
                Value::Boolean(_) => 4.0,
                Value::Error(_) => 16.0,
                Value::Null => 1.0,
            };
            Value::Number(code)
        }

        // === Text expansion (Batch B4) ===
        // FIND(find_text, within_text[, start_num]) — case-sensitive, 1-based.
        // Char-based indexing (never byte offsets on &str).
        "FIND" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let find_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = find_v {
                return Value::Error(e);
            }
            let within_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = within_v {
                return Value::Error(e);
            }
            let start_num = if args.len() == 3 {
                let s = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = s {
                    return Value::Error(e);
                }
                match coerce_to_number(&s) {
                    Some(n) if n >= 1.0 => n as usize,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1
            };
            let find_text = coerce_to_text(&find_v);
            let within_text = coerce_to_text(&within_v);
            // Empty needle: Excel returns start_num itself.
            if find_text.is_empty() {
                if start_num > within_text.chars().count() + 1 {
                    return Value::Error(ValueError::InvalidValue);
                }
                return Value::Number(start_num as f64);
            }
            let needle_chars: Vec<char> = find_text.chars().collect();
            let haystack_chars: Vec<char> = within_text.chars().collect();
            if start_num > haystack_chars.len() {
                return Value::Error(ValueError::InvalidValue);
            }
            let start_idx = start_num - 1;
            // Walk char-by-char starting at start_idx.
            let mut i = start_idx;
            while i + needle_chars.len() <= haystack_chars.len() {
                if haystack_chars[i..i + needle_chars.len()] == needle_chars[..] {
                    return Value::Number((i + 1) as f64);
                }
                i += 1;
            }
            Value::Error(ValueError::InvalidValue)
        }

        // SEARCH(find_text, within_text[, start_num]) — case-insensitive, 1-based.
        // no wildcard support yet
        "SEARCH" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let find_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = find_v {
                return Value::Error(e);
            }
            let within_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = within_v {
                return Value::Error(e);
            }
            let start_num = if args.len() == 3 {
                let s = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = s {
                    return Value::Error(e);
                }
                match coerce_to_number(&s) {
                    Some(n) if n >= 1.0 => n as usize,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1
            };
            let find_text = coerce_to_text(&find_v).to_lowercase();
            let within_text = coerce_to_text(&within_v).to_lowercase();
            if find_text.is_empty() {
                if start_num > within_text.chars().count() + 1 {
                    return Value::Error(ValueError::InvalidValue);
                }
                return Value::Number(start_num as f64);
            }
            let needle_chars: Vec<char> = find_text.chars().collect();
            let haystack_chars: Vec<char> = within_text.chars().collect();
            if start_num > haystack_chars.len() {
                return Value::Error(ValueError::InvalidValue);
            }
            let start_idx = start_num - 1;
            let mut i = start_idx;
            while i + needle_chars.len() <= haystack_chars.len() {
                if haystack_chars[i..i + needle_chars.len()] == needle_chars[..] {
                    return Value::Number((i + 1) as f64);
                }
                i += 1;
            }
            Value::Error(ValueError::InvalidValue)
        }

        // SUBSTITUTE(text, old, new[, instance_num]).
        // Char-based to avoid byte-offset bugs on multi-byte strings.
        "SUBSTITUTE" => {
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let text_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = text_v {
                return Value::Error(e);
            }
            let old_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = old_v {
                return Value::Error(e);
            }
            let new_v = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(e) = new_v {
                return Value::Error(e);
            }
            let instance: Option<usize> = if args.len() == 4 {
                let i = eval_expr_with_provider(&args[3], provider);
                if let Value::Error(e) = i {
                    return Value::Error(e);
                }
                match coerce_to_number(&i) {
                    Some(n) if n >= 1.0 => Some(n as usize),
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                None
            };
            let text = coerce_to_text(&text_v);
            let old = coerce_to_text(&old_v);
            let new_s = coerce_to_text(&new_v);
            if old.is_empty() {
                return Value::Text(text);
            }
            let text_chars: Vec<char> = text.chars().collect();
            let old_chars: Vec<char> = old.chars().collect();
            let mut out = String::new();
            let mut i = 0;
            let mut hit = 0usize;
            while i < text_chars.len() {
                if i + old_chars.len() <= text_chars.len()
                    && text_chars[i..i + old_chars.len()] == old_chars[..]
                {
                    hit += 1;
                    let replace_here = match instance {
                        Some(n) => hit == n,
                        None => true,
                    };
                    if replace_here {
                        out.push_str(&new_s);
                    } else {
                        for c in &old_chars {
                            out.push(*c);
                        }
                    }
                    i += old_chars.len();
                } else {
                    out.push(text_chars[i]);
                    i += 1;
                }
            }
            Value::Text(out)
        }

        // REPLACE(text, start_num, num_chars, new_text). 1-based char position.
        "REPLACE" => {
            if args.len() != 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let text_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = text_v {
                return Value::Error(e);
            }
            let start_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = start_v {
                return Value::Error(e);
            }
            let num_v = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(e) = num_v {
                return Value::Error(e);
            }
            let new_v = eval_expr_with_provider(&args[3], provider);
            if let Value::Error(e) = new_v {
                return Value::Error(e);
            }
            let start = match coerce_to_number(&start_v) {
                Some(n) if n >= 1.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let num = match coerce_to_number(&num_v) {
                Some(n) if n >= 0.0 => n as usize,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let text = coerce_to_text(&text_v);
            let new_s = coerce_to_text(&new_v);
            let text_chars: Vec<char> = text.chars().collect();
            let len = text_chars.len();
            let start_idx = start - 1; // 1-based -> 0-based
            // start past end → append.
            let prefix_end = start_idx.min(len);
            let cut_end = (start_idx + num).min(len);
            let mut out = String::new();
            for c in &text_chars[..prefix_end] {
                out.push(*c);
            }
            out.push_str(&new_s);
            for c in &text_chars[cut_end..] {
                out.push(*c);
            }
            Value::Text(out)
        }

        // REPT(text, n) — char-count limit 32767 per Excel.
        "REPT" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let text_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = text_v {
                return Value::Error(e);
            }
            let n_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = n_v {
                return Value::Error(e);
            }
            let n_f = match coerce_to_number(&n_v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            // trunc, reject negative
            let n_trunc = n_f.trunc();
            if n_trunc < 0.0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let n = n_trunc as usize;
            if n == 0 {
                return Value::Text(String::new());
            }
            let text = coerce_to_text(&text_v);
            let char_count = text.chars().count();
            // Char-count cap (Excel: 32767).
            let total = char_count.checked_mul(n);
            match total {
                Some(t) if t <= 32767 => {
                    let mut out = String::with_capacity(text.len() * n);
                    for _ in 0..n {
                        out.push_str(&text);
                    }
                    Value::Text(out)
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }

        // EXACT(a, b) — case-sensitive text equality.
        "EXACT" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let a = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = a {
                return Value::Error(e);
            }
            let b = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = b {
                return Value::Error(e);
            }
            Value::Boolean(coerce_to_text(&a) == coerce_to_text(&b))
        }

        // VALUE(text) — coerce text to number.
        "VALUE" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match v {
                Value::Error(e) => Value::Error(e),
                Value::Number(n) => Value::Number(n),
                Value::Boolean(true) => Value::Number(1.0),
                Value::Boolean(false) => Value::Number(0.0),
                Value::Null => Value::Number(0.0),
                Value::Text(s) => match s.trim().parse::<f64>() {
                    Ok(n) => Value::Number(n),
                    Err(_) => Value::Error(ValueError::InvalidValue),
                },
            }
        }

        // T(v) — return Text if v is text, otherwise empty text.
        "T" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            match v {
                Value::Error(e) => Value::Error(e),
                Value::Text(s) => Value::Text(s),
                _ => Value::Text(String::new()),
            }
        }

        // CHAR(n) — full Unicode 1..=1_114_111 (broader than Excel's 1..=255).
        "CHAR" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let n_f = match coerce_to_number(&v) {
                Some(n) => n.trunc(),
                None => return Value::Error(ValueError::WrongType),
            };
            if !(1.0..=1_114_111.0).contains(&n_f) {
                return Value::Error(ValueError::InvalidValue);
            }
            match char::from_u32(n_f as u32) {
                Some(c) => Value::Text(c.to_string()),
                None => Value::Error(ValueError::InvalidValue),
            }
        }

        // CODE(text) — first char code point.
        "CODE" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let s = coerce_to_text(&v);
            match s.chars().next() {
                Some(c) => Value::Number(c as u32 as f64),
                None => Value::Error(ValueError::InvalidValue),
            }
        }

        // CLEAN(text) — strip ASCII control chars (0..=31).
        "CLEAN" => text_unary(args, provider, |s| {
            s.chars().filter(|c| (*c as u32) > 31).collect()
        }),

        // PROPER(text) — capitalize first alpha of each word.
        "PROPER" => text_unary(args, provider, |s| {
            let mut out = String::with_capacity(s.len());
            let mut start_of_word = true;
            for c in s.chars() {
                if c.is_alphabetic() {
                    if start_of_word {
                        for u in c.to_uppercase() {
                            out.push(u);
                        }
                    } else {
                        for u in c.to_lowercase() {
                            out.push(u);
                        }
                    }
                    start_of_word = false;
                } else {
                    out.push(c);
                    start_of_word = true;
                }
            }
            out
        }),

        // TEXTJOIN(delim, ignore_empty, ...). Range args streamed via for_each_arg_value.
        "TEXTJOIN" => {
            if args.len() < 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let delim_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = delim_v {
                return Value::Error(e);
            }
            let ignore_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = ignore_v {
                return Value::Error(e);
            }
            let delim = coerce_to_text(&delim_v);
            let ignore_empty = match coerce_to_bool(&ignore_v) {
                Some(b) => b,
                None => return Value::Error(ValueError::WrongType),
            };
            let mut out = String::new();
            let mut first = true;
            let mut err: Option<ValueError> = None;
            for arg in &args[2..] {
                if err.is_some() {
                    break;
                }
                for_each_arg_value(arg, provider, &mut |_addr, v| {
                    if err.is_some() {
                        return;
                    }
                    match v {
                        Value::Error(e) => {
                            err = Some(e);
                            return;
                        }
                        Value::Null if ignore_empty => return,
                        _ => {}
                    }
                    let piece = coerce_to_text(&v);
                    if ignore_empty && piece.is_empty() {
                        return;
                    }
                    if !first {
                        out.push_str(&delim);
                    }
                    out.push_str(&piece);
                    first = false;
                    if out.chars().count() > 32767 {
                        err = Some(ValueError::InvalidValue);
                    }
                });
            }
            if let Some(e) = err {
                Value::Error(e)
            } else {
                Value::Text(out)
            }
        }

        _ => Value::Error(ValueError::InvalidName),
    }
}

/// Streams every arg's numeric values into a local Vec. The Vec is an
/// algorithmic requirement of the callers (MEDIAN sorts, MODE counts,
/// STDEV/VAR need two passes, LARGE/SMALL select by rank) — but going
/// through `for_each_arg_value` means the underlying provider can stay
/// sparse, so we never allocate Null entries for empty cells in
/// `SUM(A:A)`-shaped ranges.
fn collect_numbers(args: &[Expr], provider: &dyn EvalProvider) -> Vec<f64> {
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

/// Iterative Euclidean GCD on u64. `gcd(a, 0) = a`. Used by GCD / LCM.
fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
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
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    match coerce_to_number(&v) {
        Some(n) => {
            let (y, m, d) = date_from_serial(n);
            Value::Number(f(y, m, d))
        }
        None => Value::Error(ValueError::WrongType),
    }
}

fn coerce_to_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Boolean(b) => Some(*b),
        Value::Number(n) => Some(*n != 0.0),
        _ => None,
    }
}

fn unary_number(args: &[Expr], provider: &dyn EvalProvider, f: impl Fn(f64) -> f64) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
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
                Value::Error(ValueError::Overflow)
            }
        }
        None => Value::Error(ValueError::WrongType),
    }
}

fn text_unary(args: &[Expr], provider: &dyn EvalProvider, f: impl Fn(&str) -> String) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
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
        return Value::Error(ValueError::WrongArgCount);
    }
    let s = coerce_to_text(&eval_expr_with_provider(&args[0], provider));
    let n = if args.len() == 2 {
        match coerce_to_number(&eval_expr_with_provider(&args[1], provider)) {
            Some(n) if n >= 0.0 => n as usize,
            _ => return Value::Error(ValueError::WrongType),
        }
    } else {
        1
    };
    Value::Text(take(&s, n))
}

fn format_with_text_pattern(value: f64, pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return None;
    }

    if pattern == "0.00" {
        return Some(format!("{:.2}", value));
    }

    if pattern.chars().all(|c| c == '0') {
        let width = pattern.len();
        let rounded = format!("{:.0}", value);
        let (sign, digits) = rounded
            .strip_prefix('-')
            .map_or(("", rounded.as_str()), |digits| ("-", digits));
        return Some(format!("{sign}{}", format!("{:0>width$}", digits)));
    }

    if pattern.contains('.') {
        let (left, right) = pattern.split_once('.')?;
        if left.is_empty()
            || right.is_empty()
            || !left.chars().all(|c| c == '0')
            || !right.chars().all(|c| c == '0')
        {
            return None;
        }
        let decimals = right.len();
        return Some(format!("{:.*}", decimals, value));
    }

    None
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
    // Excel wildcard semantics: ? = 1 char, * = 0+ chars, ~ escapes the next char.
    // Wildcards apply only to the "rest" (after any operator prefix). `=` and
    // `<>` honor wildcards (match / not-match); comparison operators (`>`,
    // `<`, `>=`, `<=`) fall through to text equality (existing legacy
    // behavior — those forms don't apply meaningfully to text patterns).
    if pattern_has_wildcard(rest) {
        let text = coerce_to_text(v);
        let matched = wildcard_match(rest, &text);
        return match op {
            "<>" => !matched,
            "=" => matched,
            // Comparison operators against a wildcard pattern fall back to
            // equality semantics (Excel does the same).
            _ => matched,
        };
    }
    // Fallback: text equality (Excel-compatible default). Preserves the
    // pre-wildcard behavior: any `op` other than the numeric branches above
    // reduces to a string compare against `rest`.
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

/// Detect whether a pattern is "wildcard-style". A pattern is wildcard-style
/// if it contains an unescaped `?`/`*` OR any `~` escape sequence — the
/// escape sequence itself needs the wildcard matcher to decode it (e.g.
/// `~*` is a literal `*` only after escape resolution; a plain string
/// compare against the raw pattern would still see the `~`).
fn pattern_has_wildcard(pattern: &str) -> bool {
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c == '~' {
            // A `~` always triggers the wildcard matcher so escapes are
            // decoded uniformly. Consume the escaped char and continue.
            let _ = chars.next();
            return true;
        }
        if c == '?' || c == '*' {
            return true;
        }
    }
    false
}

/// Excel wildcard semantics: `?` = exactly one char, `*` = zero-or-more
/// chars, `~` escapes the next char (`~?`, `~*`, `~~`). Match is
/// case-insensitive (Excel convention; same as SEARCH).
///
/// Implementation: iterative two-pointer matcher with `*` backtracking. The
/// pattern is pre-decoded into a token vector (`Lit(c) | Q | Star`) so the
/// matcher itself only deals with three cases. Time complexity is O(p·t)
/// in the worst case (multiple `*`s with backtracking); criteria patterns
/// are short in practice so this is fine.
fn wildcard_match(pattern: &str, text: &str) -> bool {
    enum Tok {
        Lit(char),
        Q,
        Star,
    }
    // Decode pattern → tokens, honoring `~` escape. Case-folded to lower.
    let mut toks: Vec<Tok> = Vec::with_capacity(pattern.len());
    let mut it = pattern.chars();
    while let Some(c) = it.next() {
        if c == '~' {
            // Escape: the next char is a literal (any char; `~` at end is
            // treated as a literal `~`, matching Excel parity).
            match it.next() {
                Some(next) => toks.push(Tok::Lit(next.to_lowercase().next().unwrap_or(next))),
                None => toks.push(Tok::Lit('~')),
            }
        } else if c == '?' {
            toks.push(Tok::Q);
        } else if c == '*' {
            toks.push(Tok::Star);
        } else {
            toks.push(Tok::Lit(c.to_lowercase().next().unwrap_or(c)));
        }
    }
    // Case-fold the text too.
    let text_chars: Vec<char> = text.chars().flat_map(|c| c.to_lowercase()).collect();

    // Two-pointer matcher with `*` backtracking. `star_p` is the index of
    // the most recent `*` in the pattern (or None); `star_t` is the text
    // index where that `*` last attempted to "start eating".
    let mut p = 0usize;
    let mut t = 0usize;
    let mut star_p: Option<usize> = None;
    let mut star_t: usize = 0;
    while t < text_chars.len() {
        match toks.get(p) {
            Some(Tok::Lit(c)) if text_chars[t] == *c => {
                p += 1;
                t += 1;
            }
            Some(Tok::Q) => {
                p += 1;
                t += 1;
            }
            Some(Tok::Star) => {
                star_p = Some(p);
                star_t = t;
                p += 1;
            }
            _ => {
                // Mismatch or end-of-pattern with text remaining. Try to
                // backtrack to the last `*` and let it consume one more char.
                if let Some(sp) = star_p {
                    p = sp + 1;
                    star_t += 1;
                    t = star_t;
                } else {
                    return false;
                }
            }
        }
    }
    // Consume any trailing `*`s; anything else means leftover required
    // tokens that have no text to match against.
    while let Some(Tok::Star) = toks.get(p) {
        p += 1;
    }
    p == toks.len()
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
        // B2 holds a text value; adding 1 to it cannot coerce → WrongType
        // (previously InvalidValue, now finer-grained).
        assert_eq!(
            eval_str("=B2+1", &cm, &vs),
            Value::Error(ValueError::WrongType)
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

        assert_eq!(
            eval_str("=TEXT(1234.5,\"0.00\")", &cm, &vs),
            Value::Text("1234.50".into())
        );
        assert_eq!(
            eval_str("=TEXT(7,\"000\")", &cm, &vs),
            Value::Text("007".into())
        );
        assert_eq!(
            eval_str("=TEXT(\"7\",\"0.00\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
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
            self.cells.insert(CellAddress::parse(addr).unwrap(), v);
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
        fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
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

        fn for_each_sheet_range_cell(
            &self,
            _sheet: &str,
            range: CellRange,
            f: &mut dyn FnMut(CellAddress, Value),
        ) {
            self.for_each_range_cell(range, f);
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
    fn sum_cross_sheet_range_streams_only_real_cells() {
        let mut p = SparseProvider::new();
        p.set("A1", Value::Number(5.0));
        p.set("A100000", Value::Number(10.0));
        let v = run_with(&p, "=SUM(Sheet2!A1:A100000)");
        assert_eq!(v, Value::Number(15.0));
        assert_eq!(
            p.visits(),
            2,
            "cross-sheet SUM should stream only present cells, got {}",
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
        assert_eq!(run_with(&p, "=SUMIF(A1:A1000,\">5\")"), Value::Number(30.0));
    }

    // === B2 + B3: math + trig formulas ===
    //
    // Each test follows the same shape: happy path; WrongArgCount;
    // WrongType; numeric/domain edge; error propagation. Variadic
    // function tests additionally exercise a range argument.

    // ---- B2: math ----

    #[test]
    fn eval_int() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=INT(4.7)", &cm, &vs), Value::Number(4.0));
        // floor toward -∞: INT(-2.5) = -3, NOT -2.
        assert_eq!(eval_str("=INT(-2.5)", &cm, &vs), Value::Number(-3.0));
        assert_eq!(eval_str("=INT(A1)", &cm, &vs), Value::Number(10.0));
        assert_eq!(
            eval_str("=INT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=INT(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation through a sub-expression.
        assert_eq!(
            eval_str("=INT(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_trunc() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=TRUNC(8.9)", &cm, &vs), Value::Number(8.0));
        // Negative: trunc toward zero, not floor: -2.5 → -2.
        assert_eq!(eval_str("=TRUNC(-2.5)", &cm, &vs), Value::Number(-2.0));
        assert_eq!(eval_str("=TRUNC(3.14159,2)", &cm, &vs), Value::Number(3.14));
        // Negative digits truncate to the left of the decimal point.
        assert_eq!(eval_str("=TRUNC(123.45,-1)", &cm, &vs), Value::Number(120.0));
        assert_eq!(
            eval_str("=TRUNC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=TRUNC(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=TRUNC(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_sign() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=SIGN(7)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=SIGN(-3)", &cm, &vs), Value::Number(-1.0));
        assert_eq!(eval_str("=SIGN(0)", &cm, &vs), Value::Number(0.0));
        assert_eq!(eval_str("=SIGN(A1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(
            eval_str("=SIGN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=SIGN(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=SIGN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_exp() {
        let (cm, vs) = make_test_env();
        // EXP(0) = 1, EXP(1) ≈ e.
        assert_eq!(eval_str("=EXP(0)", &cm, &vs), Value::Number(1.0));
        match eval_str("=EXP(1)", &cm, &vs) {
            Value::Number(n) => {
                assert!((n - std::f64::consts::E).abs() < 1e-12, "EXP(1)={}", n)
            }
            other => panic!("expected number, got {:?}", other),
        }
        // Huge → +inf → Overflow.
        assert_eq!(
            eval_str("=EXP(1000)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=EXP()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=EXP(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=EXP(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_ln() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=LN(1)", &cm, &vs), Value::Number(0.0));
        match eval_str("=LN(2.718281828459045)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "LN(e)={}", n),
            other => panic!("expected number, got {:?}", other),
        }
        // LN(0) and LN(-1) are domain errors → Overflow.
        assert_eq!(
            eval_str("=LN(0)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LN(-1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=LN(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=LN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_log() {
        let (cm, vs) = make_test_env();
        // Default base = 10.
        assert_eq!(eval_str("=LOG(100)", &cm, &vs), Value::Number(2.0));
        assert_eq!(eval_str("=LOG(8,2)", &cm, &vs), Value::Number(3.0));
        // Domain violations → Overflow.
        assert_eq!(
            eval_str("=LOG(0)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LOG(-5)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LOG(10,1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LOG(10,-2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LOG()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=LOG(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=LOG(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_log10() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=LOG10(1000)", &cm, &vs), Value::Number(3.0));
        assert_eq!(eval_str("=LOG10(1)", &cm, &vs), Value::Number(0.0));
        assert_eq!(
            eval_str("=LOG10(0)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LOG10(-2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=LOG10()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=LOG10(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=LOG10(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_pi() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=PI()", &cm, &vs), Value::Number(std::f64::consts::PI));
        // PI takes no args.
        assert_eq!(
            eval_str("=PI(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Round-trip in arithmetic.
        match eval_str("=PI()*2", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - 2.0 * std::f64::consts::PI).abs() < 1e-12,
                "PI()*2 = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
    }

    #[test]
    fn eval_roundup() {
        let (cm, vs) = make_test_env();
        // Away from zero on both signs.
        assert_eq!(eval_str("=ROUNDUP(3.2,0)", &cm, &vs), Value::Number(4.0));
        assert_eq!(eval_str("=ROUNDUP(-3.2,0)", &cm, &vs), Value::Number(-4.0));
        assert_eq!(eval_str("=ROUNDUP(3.14159,2)", &cm, &vs), Value::Number(3.15));
        // Negative digits round to multiples of 10/100/...
        assert_eq!(eval_str("=ROUNDUP(123,-1)", &cm, &vs), Value::Number(130.0));
        assert_eq!(
            eval_str("=ROUNDUP(3.2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ROUNDUP(B2,0)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ROUNDUP(A1/C1,0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_rounddown() {
        let (cm, vs) = make_test_env();
        // Toward zero on both signs.
        assert_eq!(eval_str("=ROUNDDOWN(3.7,0)", &cm, &vs), Value::Number(3.0));
        assert_eq!(eval_str("=ROUNDDOWN(-3.7,0)", &cm, &vs), Value::Number(-3.0));
        assert_eq!(
            eval_str("=ROUNDDOWN(3.14159,2)", &cm, &vs),
            Value::Number(3.14)
        );
        assert_eq!(
            eval_str("=ROUNDDOWN(189,-1)", &cm, &vs),
            Value::Number(180.0)
        );
        assert_eq!(
            eval_str("=ROUNDDOWN(3.7)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ROUNDDOWN(B2,0)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ROUNDDOWN(A1/C1,0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_mround() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=MROUND(10,3)", &cm, &vs), Value::Number(9.0));
        // 1.3 / 0.2 hits binary-float imprecision; assert "close enough".
        match eval_str("=MROUND(1.3,0.2)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.4).abs() < 1e-9, "MROUND(1.3,0.2) = {}", n),
            other => panic!("expected number, got {:?}", other),
        }
        // multiple == 0 → 0.
        assert_eq!(eval_str("=MROUND(5,0)", &cm, &vs), Value::Number(0.0));
        // Sign mismatch → Overflow.
        assert_eq!(
            eval_str("=MROUND(5,-3)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=MROUND(-5,3)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Both negative is fine, same sign.
        assert_eq!(eval_str("=MROUND(-10,-3)", &cm, &vs), Value::Number(-9.0));
        assert_eq!(
            eval_str("=MROUND(5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=MROUND(B2,2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=MROUND(A1/C1,2)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_product() {
        let (cm, vs) = make_test_env();
        // A1=10, B1=20, A2=5 → 1000.
        assert_eq!(
            eval_str("=PRODUCT(A1,B1,A2)", &cm, &vs),
            Value::Number(1000.0)
        );
        // Range arg over A1:B1 → 200.
        assert_eq!(eval_str("=PRODUCT(A1:B1)", &cm, &vs), Value::Number(200.0));
        // Mixed range + scalar.
        assert_eq!(
            eval_str("=PRODUCT(A1:B1,A2)", &cm, &vs),
            Value::Number(1000.0)
        );
        // Text values are skipped (B2 is text); 10*20 = 200.
        assert_eq!(eval_str("=PRODUCT(A1,B1,B2)", &cm, &vs), Value::Number(200.0));
        // No numeric args → 0 (Excel convention for PRODUCT).
        assert_eq!(eval_str("=PRODUCT(B2)", &cm, &vs), Value::Number(0.0));
        // Variadic accepts >= 0 args, but supplying nothing returns 0.
        assert_eq!(eval_str("=PRODUCT()", &cm, &vs), Value::Number(0.0));
        // Error propagation.
        assert_eq!(
            eval_str("=PRODUCT(A1,A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_quotient() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=QUOTIENT(7,2)", &cm, &vs), Value::Number(3.0));
        assert_eq!(eval_str("=QUOTIENT(-7,2)", &cm, &vs), Value::Number(-3.0));
        assert_eq!(eval_str("=QUOTIENT(A1,A2)", &cm, &vs), Value::Number(2.0));
        assert_eq!(
            eval_str("=QUOTIENT(5,0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=QUOTIENT(5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=QUOTIENT(B2,2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=QUOTIENT(A1,A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_fact() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=FACT(0)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=FACT(1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=FACT(5)", &cm, &vs), Value::Number(120.0));
        // Trunc the fractional part first.
        assert_eq!(eval_str("=FACT(5.9)", &cm, &vs), Value::Number(120.0));
        // Negative → Overflow.
        assert_eq!(
            eval_str("=FACT(-1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // 171! overflows f64.
        assert_eq!(
            eval_str("=FACT(171)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=FACT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=FACT(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=FACT(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_combin() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=COMBIN(5,2)", &cm, &vs), Value::Number(10.0));
        assert_eq!(eval_str("=COMBIN(8,3)", &cm, &vs), Value::Number(56.0));
        assert_eq!(eval_str("=COMBIN(10,0)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=COMBIN(10,10)", &cm, &vs), Value::Number(1.0));
        // k > n is a domain error.
        assert_eq!(
            eval_str("=COMBIN(3,5)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Negative inputs.
        assert_eq!(
            eval_str("=COMBIN(-1,1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=COMBIN(5,-1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=COMBIN(5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COMBIN(B2,2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=COMBIN(A1,A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_gcd() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=GCD(12,18)", &cm, &vs), Value::Number(6.0));
        assert_eq!(eval_str("=GCD(12,18,24)", &cm, &vs), Value::Number(6.0));
        assert_eq!(eval_str("=GCD(7,13)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=GCD(0,5)", &cm, &vs), Value::Number(5.0));
        // Range arg (A1=10, B1=20) and a scalar mix.
        assert_eq!(eval_str("=GCD(A1:B1)", &cm, &vs), Value::Number(10.0));
        assert_eq!(eval_str("=GCD(A1:B1,A2)", &cm, &vs), Value::Number(5.0));
        assert_eq!(
            eval_str("=GCD()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Negative argument → WrongType per spec.
        assert_eq!(
            eval_str("=GCD(-4,8)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Non-numeric.
        assert_eq!(
            eval_str("=GCD(B2,8)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=GCD(A1,A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_lcm() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=LCM(4,6)", &cm, &vs), Value::Number(12.0));
        assert_eq!(eval_str("=LCM(2,3,5)", &cm, &vs), Value::Number(30.0));
        assert_eq!(eval_str("=LCM(0,5)", &cm, &vs), Value::Number(0.0));
        // Range arg + scalar (A1=10, B1=20) → lcm(10,20) = 20; with A2=5 → 20.
        assert_eq!(eval_str("=LCM(A1:B1)", &cm, &vs), Value::Number(20.0));
        assert_eq!(eval_str("=LCM(A1:B1,A2)", &cm, &vs), Value::Number(20.0));
        assert_eq!(
            eval_str("=LCM()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=LCM(-4,6)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=LCM(B2,6)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=LCM(A1,A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_counta() {
        let (cm, vs) = make_test_env();
        // A1, B1, A2, B2 are all present in A1:B2 (C1 outside the range).
        assert_eq!(eval_str("=COUNTA(A1:B2)", &cm, &vs), Value::Number(4.0));
        // Scalar args: 3 args yield 3.
        assert_eq!(eval_str("=COUNTA(1,2,3)", &cm, &vs), Value::Number(3.0));
        // Mix range + scalar (A1:B1 = 2 cells, +A2 = 3).
        assert_eq!(eval_str("=COUNTA(A1:B1,A2)", &cm, &vs), Value::Number(3.0));
        // Text and booleans count.
        assert_eq!(
            eval_str("=COUNTA(B2,TRUE,\"x\")", &cm, &vs),
            Value::Number(3.0)
        );
        // No args → 0.
        assert_eq!(eval_str("=COUNTA()", &cm, &vs), Value::Number(0.0));
        // Per spec: COUNTA counts errors too — they're "not blank".
        assert_eq!(
            eval_str("=COUNTA(A1/C1,A1)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_countblank() {
        let (cm, vs) = make_test_env();
        // A1:B2 has 4 populated cells; no Null hits.
        assert_eq!(eval_str("=COUNTBLANK(A1:B2)", &cm, &vs), Value::Number(0.0));
        // A range with two missing cells (C2 and C3 are not in cell_map).
        assert_eq!(eval_str("=COUNTBLANK(C2:C3)", &cm, &vs), Value::Number(2.0));
        // WrongArgCount.
        assert_eq!(
            eval_str("=COUNTBLANK(A1:B1,C1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COUNTBLANK()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation through a sub-expression — error is not Null.
        assert_eq!(eval_str("=COUNTBLANK(A1/C1)", &cm, &vs), Value::Number(0.0));
    }

    // ---- B3: trig (radians) ----

    #[test]
    fn eval_sin() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=SIN(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=SIN(PI()/2)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "SIN(PI/2)={}", n),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=SIN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=SIN(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=SIN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_cos() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=COS(0)", &cm, &vs), Value::Number(1.0));
        match eval_str("=COS(PI())", &cm, &vs) {
            Value::Number(n) => assert!((n + 1.0).abs() < 1e-12, "COS(PI)={}", n),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=COS()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COS(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=COS(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_tan() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=TAN(0)", &cm, &vs), Value::Number(0.0));
        // Near PI/4 → ~1.
        match eval_str("=TAN(PI()/4)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "TAN(PI/4)={}", n),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=TAN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=TAN(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=TAN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_asin() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ASIN(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=ASIN(1)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_2).abs() < 1e-12,
                "ASIN(1) = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
        // Out of domain.
        assert_eq!(
            eval_str("=ASIN(2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ASIN(-1.5)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ASIN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ASIN(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ASIN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_acos() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ACOS(1)", &cm, &vs), Value::Number(0.0));
        match eval_str("=ACOS(0)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_2).abs() < 1e-12,
                "ACOS(0) = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=ACOS(2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ACOS(-1.5)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ACOS()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ACOS(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ACOS(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_atan() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ATAN(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=ATAN(1)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_4).abs() < 1e-12,
                "ATAN(1) = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=ATAN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ATAN(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ATAN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_atan2() {
        let (cm, vs) = make_test_env();
        // ATAN2(y, x) — y=1, x=1 → PI/4.
        match eval_str("=ATAN2(1,1)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_4).abs() < 1e-12,
                "ATAN2(1,1) = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
        // y=0, x=1 → 0.
        assert_eq!(eval_str("=ATAN2(0,1)", &cm, &vs), Value::Number(0.0));
        // y=1, x=0 → PI/2.
        match eval_str("=ATAN2(1,0)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_2).abs() < 1e-12,
                "ATAN2(1,0) = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=ATAN2(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ATAN2(B2,1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ATAN2(A1/C1,1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_radians() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=RADIANS(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=RADIANS(180)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::PI).abs() < 1e-12,
                "RADIANS(180) = {}",
                n
            ),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=RADIANS()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=RADIANS(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=RADIANS(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_degrees() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=DEGREES(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=DEGREES(PI())", &cm, &vs) {
            Value::Number(n) => assert!((n - 180.0).abs() < 1e-12, "DEGREES(PI) = {}", n),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=DEGREES()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=DEGREES(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=DEGREES(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // === Batch B1: error/type-guard formulas ===

    #[test]
    fn eval_iferror() {
        let (cm, vs) = make_test_env();
        // Happy path: errored expression replaced.
        assert_eq!(eval_str("=IFERROR(1/0,99)", &cm, &vs), Value::Number(99.0));
        // Non-error passes through unchanged.
        assert_eq!(eval_str("=IFERROR(A1,99)", &cm, &vs), Value::Number(10.0));
        // Text fallback works too.
        assert_eq!(
            eval_str("=IFERROR(1/0,\"nope\")", &cm, &vs),
            Value::Text("nope".into())
        );
        // Wrong-arg-count.
        assert_eq!(
            eval_str("=IFERROR(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_ifna() {
        let (cm, vs) = make_test_env();
        // VLOOKUP miss surfaces as InvalidValue → caught by IFNA.
        assert_eq!(
            eval_str("=IFNA(VLOOKUP(999,A1:B2,2,FALSE),0)", &cm, &vs),
            Value::Number(0.0)
        );
        // DivisionByZero is NOT N/A-like → propagates.
        assert_eq!(
            eval_str("=IFNA(1/0,0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // Non-error passes through.
        assert_eq!(eval_str("=IFNA(A1,0)", &cm, &vs), Value::Number(10.0));
        // Wrong arity.
        assert_eq!(
            eval_str("=IFNA(A1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_ifs() {
        let (cm, vs) = make_test_env();
        // First truthy condition wins. A1=10 so A1>5 → "big".
        assert_eq!(
            eval_str("=IFS(A1>100,\"huge\",A1>5,\"big\",TRUE,\"x\")", &cm, &vs),
            Value::Text("big".into())
        );
        // No condition matches → InvalidValue.
        assert_eq!(
            eval_str("=IFS(A1>100,1,A1<0,2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Odd arg count → WrongArgCount.
        assert_eq!(
            eval_str("=IFS(A1>0,1,A1>0)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error in a condition propagates.
        assert_eq!(
            eval_str("=IFS(1/0,1,TRUE,2)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_switch() {
        let (cm, vs) = make_test_env();
        // Match case → returns matching val. A1=10 matches second pair.
        assert_eq!(
            eval_str("=SWITCH(A1,5,\"five\",10,\"ten\",\"def\")", &cm, &vs),
            Value::Text("ten".into())
        );
        // No match, trailing default returned.
        assert_eq!(
            eval_str("=SWITCH(A1,1,\"a\",2,\"b\",\"default\")", &cm, &vs),
            Value::Text("default".into())
        );
        // No match and no default → InvalidValue.
        assert_eq!(
            eval_str("=SWITCH(A1,1,\"a\",2,\"b\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Min 3 args.
        assert_eq!(
            eval_str("=SWITCH(A1,1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error in expr propagates.
        assert_eq!(
            eval_str("=SWITCH(1/0,1,\"a\",\"def\")", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_xor() {
        let (cm, vs) = make_test_env();
        // Odd count of TRUE → true.
        assert_eq!(
            eval_str("=XOR(TRUE,FALSE,FALSE)", &cm, &vs),
            Value::Boolean(true)
        );
        // Even count of TRUE → false.
        assert_eq!(eval_str("=XOR(TRUE,TRUE)", &cm, &vs), Value::Boolean(false));
        // Numeric coercion (non-zero is true).
        assert_eq!(eval_str("=XOR(1,0,2)", &cm, &vs), Value::Boolean(false));
        // No args → WrongArgCount.
        assert_eq!(
            eval_str("=XOR()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Text → WrongType.
        assert_eq!(
            eval_str("=XOR(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagates.
        assert_eq!(
            eval_str("=XOR(1/0,TRUE)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_isnumber() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ISNUMBER(A1)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISNUMBER(B2)", &cm, &vs), Value::Boolean(false));
        // Boolean is not a number.
        assert_eq!(eval_str("=ISNUMBER(TRUE)", &cm, &vs), Value::Boolean(false));
        // Errors are classified, not propagated.
        assert_eq!(eval_str("=ISNUMBER(1/0)", &cm, &vs), Value::Boolean(false));
        // Wrong arity.
        assert_eq!(
            eval_str("=ISNUMBER(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_istext() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ISTEXT(B2)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISTEXT(A1)", &cm, &vs), Value::Boolean(false));
        // Null is not text.
        assert_eq!(eval_str("=ISTEXT(Z99)", &cm, &vs), Value::Boolean(false));
        // Error is not text — classified, not propagated.
        assert_eq!(eval_str("=ISTEXT(1/0)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISTEXT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_isblank() {
        let (cm, vs) = make_test_env();
        // Z99 is missing → Null.
        assert_eq!(eval_str("=ISBLANK(Z99)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISBLANK(A1)", &cm, &vs), Value::Boolean(false));
        assert_eq!(eval_str("=ISBLANK(B2)", &cm, &vs), Value::Boolean(false));
        // Error is not blank — classified, not propagated.
        assert_eq!(eval_str("=ISBLANK(1/0)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISBLANK(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_iserror() {
        let (cm, vs) = make_test_env();
        // Any error variant is detected.
        assert_eq!(eval_str("=ISERROR(1/0)", &cm, &vs), Value::Boolean(true));
        assert_eq!(
            eval_str("=ISERROR(VLOOKUP(999,A1:B2,2,FALSE))", &cm, &vs),
            Value::Boolean(true)
        );
        // Non-errors are false.
        assert_eq!(eval_str("=ISERROR(A1)", &cm, &vs), Value::Boolean(false));
        assert_eq!(eval_str("=ISERROR(B2)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISERROR()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_iserr() {
        let (cm, vs) = make_test_env();
        // DivisionByZero is an error but not NA-like → true.
        assert_eq!(eval_str("=ISERR(1/0)", &cm, &vs), Value::Boolean(true));
        // VLOOKUP miss → InvalidValue (our NA-equivalent) → false.
        assert_eq!(
            eval_str("=ISERR(VLOOKUP(999,A1:B2,2,FALSE))", &cm, &vs),
            Value::Boolean(false)
        );
        // Non-errors are false.
        assert_eq!(eval_str("=ISERR(A1)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISERR(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_isna() {
        let (cm, vs) = make_test_env();
        // VLOOKUP miss surfaces as InvalidValue → ISNA true.
        assert_eq!(
            eval_str("=ISNA(VLOOKUP(999,A1:B2,2,FALSE))", &cm, &vs),
            Value::Boolean(true)
        );
        // DivisionByZero is an error, but not NA-like.
        assert_eq!(eval_str("=ISNA(1/0)", &cm, &vs), Value::Boolean(false));
        // Non-error → false.
        assert_eq!(eval_str("=ISNA(A1)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISNA()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_islogical() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ISLOGICAL(TRUE)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISLOGICAL(A1>0)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISLOGICAL(A1)", &cm, &vs), Value::Boolean(false));
        assert_eq!(eval_str("=ISLOGICAL(B2)", &cm, &vs), Value::Boolean(false));
        // Error classified, not propagated.
        assert_eq!(eval_str("=ISLOGICAL(1/0)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISLOGICAL(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_isnontext() {
        let (cm, vs) = make_test_env();
        // Number, Boolean, Null, Error all count as non-text.
        assert_eq!(eval_str("=ISNONTEXT(A1)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISNONTEXT(TRUE)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISNONTEXT(Z99)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISNONTEXT(1/0)", &cm, &vs), Value::Boolean(true));
        // Text → false.
        assert_eq!(eval_str("=ISNONTEXT(B2)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISNONTEXT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_iseven() {
        let (cm, vs) = make_test_env();
        // A1=10 → even.
        assert_eq!(eval_str("=ISEVEN(A1)", &cm, &vs), Value::Boolean(true));
        // A2=5 → odd.
        assert_eq!(eval_str("=ISEVEN(A2)", &cm, &vs), Value::Boolean(false));
        // Truncation toward zero: 4.7 → 4 → even.
        assert_eq!(eval_str("=ISEVEN(4.7)", &cm, &vs), Value::Boolean(true));
        // Boolean TRUE coerces to 1 → odd.
        assert_eq!(eval_str("=ISEVEN(TRUE)", &cm, &vs), Value::Boolean(false));
        // Text → WrongType.
        assert_eq!(
            eval_str("=ISEVEN(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagates.
        assert_eq!(
            eval_str("=ISEVEN(1/0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=ISEVEN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_isodd() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ISODD(A2)", &cm, &vs), Value::Boolean(true));
        assert_eq!(eval_str("=ISODD(A1)", &cm, &vs), Value::Boolean(false));
        // Truncation toward zero: 3.9 → 3 → odd.
        assert_eq!(eval_str("=ISODD(3.9)", &cm, &vs), Value::Boolean(true));
        // Text → WrongType.
        assert_eq!(
            eval_str("=ISODD(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagates.
        assert_eq!(
            eval_str("=ISODD(1/0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=ISODD(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_n() {
        let (cm, vs) = make_test_env();
        // Number passes through.
        assert_eq!(eval_str("=N(A1)", &cm, &vs), Value::Number(10.0));
        // Boolean true → 1, false → 0.
        assert_eq!(eval_str("=N(TRUE)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=N(FALSE)", &cm, &vs), Value::Number(0.0));
        // Text → 0 (Excel quirk).
        assert_eq!(eval_str("=N(B2)", &cm, &vs), Value::Number(0.0));
        // Null → 0.
        assert_eq!(eval_str("=N(Z99)", &cm, &vs), Value::Number(0.0));
        // Error propagates.
        assert_eq!(
            eval_str("=N(1/0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=N()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_type() {
        let (cm, vs) = make_test_env();
        // Number → 1.
        assert_eq!(eval_str("=TYPE(A1)", &cm, &vs), Value::Number(1.0));
        // Text → 2.
        assert_eq!(eval_str("=TYPE(B2)", &cm, &vs), Value::Number(2.0));
        // Boolean → 4.
        assert_eq!(eval_str("=TYPE(TRUE)", &cm, &vs), Value::Number(4.0));
        // Error → 16 (not propagated).
        assert_eq!(eval_str("=TYPE(1/0)", &cm, &vs), Value::Number(16.0));
        // Null → 1 (Excel quirk).
        assert_eq!(eval_str("=TYPE(Z99)", &cm, &vs), Value::Number(1.0));
        assert_eq!(
            eval_str("=TYPE(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    // === Batch B4: text expansion ===

    #[test]
    fn eval_find() {
        let (cm, vs) = make_test_env();
        // Case-sensitive: 'a' in "ABCabc" is at position 4 (1-based).
        assert_eq!(
            eval_str("=FIND(\"a\",\"ABCabc\")", &cm, &vs),
            Value::Number(4.0)
        );
        // With start_num beyond first occurrence.
        assert_eq!(
            eval_str("=FIND(\"o\",\"hello world\",6)", &cm, &vs),
            Value::Number(8.0)
        );
        // Not found.
        assert_eq!(
            eval_str("=FIND(\"z\",\"ABCabc\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Empty needle returns start_num.
        assert_eq!(
            eval_str("=FIND(\"\",\"hello\")", &cm, &vs),
            Value::Number(1.0)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=FIND(\"a\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation from arg.
        assert_eq!(
            eval_str("=FIND(\"a\",A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // start_num < 1.
        assert_eq!(
            eval_str("=FIND(\"a\",\"abc\",0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_search() {
        let (cm, vs) = make_test_env();
        // Case-insensitive: 'a' in "ABCabc" finds position 1.
        assert_eq!(
            eval_str("=SEARCH(\"a\",\"ABCabc\")", &cm, &vs),
            Value::Number(1.0)
        );
        // Explicitly contrast case sensitivity with FIND.
        assert_eq!(
            eval_str("=FIND(\"a\",\"ABCabc\")", &cm, &vs),
            Value::Number(4.0)
        );
        // start_num argument.
        assert_eq!(
            eval_str("=SEARCH(\"A\",\"ABCabc\",2)", &cm, &vs),
            Value::Number(4.0)
        );
        // Not found.
        assert_eq!(
            eval_str("=SEARCH(\"z\",\"ABCabc\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Empty needle.
        assert_eq!(
            eval_str("=SEARCH(\"\",\"abc\")", &cm, &vs),
            Value::Number(1.0)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=SEARCH(\"a\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=SEARCH(\"a\",A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_substitute() {
        let (cm, vs) = make_test_env();
        // Replace ALL occurrences.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"banana\",\"a\",\"o\")", &cm, &vs),
            Value::Text("bonono".into())
        );
        // Replace single occurrence by instance_num.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"banana\",\"a\",\"o\",2)", &cm, &vs),
            Value::Text("banona".into())
        );
        // instance_num beyond count → unchanged.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"banana\",\"a\",\"o\",10)", &cm, &vs),
            Value::Text("banana".into())
        );
        // Empty old → unchanged.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"abc\",\"\",\"x\")", &cm, &vs),
            Value::Text("abc".into())
        );
        // Empty text edge.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"\",\"a\",\"b\")", &cm, &vs),
            Value::Text("".into())
        );
        // instance_num < 1.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"a\",\"a\",\"b\",0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=SUBSTITUTE(\"a\",\"b\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=SUBSTITUTE(A1/C1,\"a\",\"b\")", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_replace() {
        let (cm, vs) = make_test_env();
        // Replace 3 chars starting at position 2 with "XYZ".
        assert_eq!(
            eval_str("=REPLACE(\"abcdef\",2,3,\"XYZ\")", &cm, &vs),
            Value::Text("aXYZef".into())
        );
        // num_chars 0 → insert.
        assert_eq!(
            eval_str("=REPLACE(\"abc\",2,0,\"--\")", &cm, &vs),
            Value::Text("a--bc".into())
        );
        // start past end → append.
        assert_eq!(
            eval_str("=REPLACE(\"abc\",10,5,\"XX\")", &cm, &vs),
            Value::Text("abcXX".into())
        );
        // Empty text edge.
        assert_eq!(
            eval_str("=REPLACE(\"\",1,0,\"hi\")", &cm, &vs),
            Value::Text("hi".into())
        );
        // start_num < 1.
        assert_eq!(
            eval_str("=REPLACE(\"abc\",0,1,\"x\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // num_chars < 0.
        assert_eq!(
            eval_str("=REPLACE(\"abc\",1,-1,\"x\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=REPLACE(\"abc\",1,1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=REPLACE(A1/C1,1,1,\"x\")", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_rept() {
        let (cm, vs) = make_test_env();
        // Happy path.
        assert_eq!(
            eval_str("=REPT(\"ab\",3)", &cm, &vs),
            Value::Text("ababab".into())
        );
        // n == 0 → empty.
        assert_eq!(
            eval_str("=REPT(\"abc\",0)", &cm, &vs),
            Value::Text("".into())
        );
        // n is truncated.
        assert_eq!(
            eval_str("=REPT(\"a\",3.9)", &cm, &vs),
            Value::Text("aaa".into())
        );
        // Empty text edge.
        assert_eq!(
            eval_str("=REPT(\"\",5)", &cm, &vs),
            Value::Text("".into())
        );
        // n < 0 → InvalidValue.
        assert_eq!(
            eval_str("=REPT(\"a\",-1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // length limit: 1 char * 32768 > 32767.
        assert_eq!(
            eval_str("=REPT(\"a\",32768)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // length limit boundary: 1 char * 32767 is OK.
        match eval_str("=REPT(\"a\",32767)", &cm, &vs) {
            Value::Text(s) => assert_eq!(s.len(), 32767),
            other => panic!("expected Text, got {:?}", other),
        }
        // Wrong arg count.
        assert_eq!(
            eval_str("=REPT(\"a\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=REPT(A1/C1,1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_exact() {
        let (cm, vs) = make_test_env();
        // Equal case.
        assert_eq!(
            eval_str("=EXACT(\"abc\",\"abc\")", &cm, &vs),
            Value::Boolean(true)
        );
        // Case-sensitive: different.
        assert_eq!(
            eval_str("=EXACT(\"abc\",\"ABC\")", &cm, &vs),
            Value::Boolean(false)
        );
        // Number coercion: 10 -> "10" equals "10".
        assert_eq!(
            eval_str("=EXACT(A1,\"10\")", &cm, &vs),
            Value::Boolean(true)
        );
        // Empty-string edge.
        assert_eq!(
            eval_str("=EXACT(\"\",\"\")", &cm, &vs),
            Value::Boolean(true)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=EXACT(\"a\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=EXACT(A1/C1,\"x\")", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_value() {
        let (cm, vs) = make_test_env();
        // Text with surrounding spaces parses.
        assert_eq!(
            eval_str("=VALUE(\"  42  \")", &cm, &vs),
            Value::Number(42.0)
        );
        // Number passes through.
        assert_eq!(eval_str("=VALUE(A1)", &cm, &vs), Value::Number(10.0));
        // Boolean.
        assert_eq!(eval_str("=VALUE(TRUE)", &cm, &vs), Value::Number(1.0));
        // Empty text → InvalidValue.
        assert_eq!(
            eval_str("=VALUE(\"\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Unparseable → InvalidValue.
        assert_eq!(
            eval_str("=VALUE(\"abc\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=VALUE(\"1\",\"2\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=VALUE(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_t() {
        let (cm, vs) = make_test_env();
        // B2 = "text"
        assert_eq!(eval_str("=T(B2)", &cm, &vs), Value::Text("text".into()));
        // Number → empty text.
        assert_eq!(eval_str("=T(A1)", &cm, &vs), Value::Text("".into()));
        // Boolean → empty text.
        assert_eq!(eval_str("=T(TRUE)", &cm, &vs), Value::Text("".into()));
        // Empty text → empty text.
        assert_eq!(eval_str("=T(\"\")", &cm, &vs), Value::Text("".into()));
        // Wrong arg count.
        assert_eq!(
            eval_str("=T(\"a\",\"b\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=T(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_char() {
        let (cm, vs) = make_test_env();
        // ASCII.
        assert_eq!(eval_str("=CHAR(65)", &cm, &vs), Value::Text("A".into()));
        // Unicode round-trip: 20013 → "中".
        assert_eq!(
            eval_str("=CHAR(20013)", &cm, &vs),
            Value::Text("中".into())
        );
        // Truncation: 65.9 → 'A'.
        assert_eq!(eval_str("=CHAR(65.9)", &cm, &vs), Value::Text("A".into()));
        // Out of range low.
        assert_eq!(
            eval_str("=CHAR(0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Out of range high.
        assert_eq!(
            eval_str("=CHAR(2000000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Surrogate (invalid Unicode scalar): 0xD800 = 55296.
        assert_eq!(
            eval_str("=CHAR(55296)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=CHAR(1,2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=CHAR(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_code() {
        let (cm, vs) = make_test_env();
        // ASCII.
        assert_eq!(eval_str("=CODE(\"A\")", &cm, &vs), Value::Number(65.0));
        // First char only.
        assert_eq!(eval_str("=CODE(\"ABC\")", &cm, &vs), Value::Number(65.0));
        // Unicode round-trip: "中" → 20013.
        assert_eq!(
            eval_str("=CODE(\"中\")", &cm, &vs),
            Value::Number(20013.0)
        );
        // Empty text → InvalidValue.
        assert_eq!(
            eval_str("=CODE(\"\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=CODE()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=CODE(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_clean() {
        let (cm, vs) = make_test_env();
        // Strip embedded TAB (9) and BEL (7).
        assert_eq!(
            eval_str(
                "=CLEAN(CONCATENATE(\"a\",CHAR(9),\"b\",CHAR(7),\"c\"))",
                &cm,
                &vs
            ),
            Value::Text("abc".into())
        );
        // No-op on clean text.
        assert_eq!(
            eval_str("=CLEAN(\"hello\")", &cm, &vs),
            Value::Text("hello".into())
        );
        // Strip newline (10) and CR (13).
        assert_eq!(
            eval_str(
                "=CLEAN(CONCATENATE(\"x\",CHAR(10),CHAR(13),\"y\"))",
                &cm,
                &vs
            ),
            Value::Text("xy".into())
        );
        // Empty text edge.
        assert_eq!(
            eval_str("=CLEAN(\"\")", &cm, &vs),
            Value::Text("".into())
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=CLEAN(\"a\",\"b\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=CLEAN(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_proper() {
        let (cm, vs) = make_test_env();
        // Basic two-word.
        assert_eq!(
            eval_str("=PROPER(\"hello world\")", &cm, &vs),
            Value::Text("Hello World".into())
        );
        // Apostrophe resets the word boundary.
        assert_eq!(
            eval_str("=PROPER(\"o'reilly\")", &cm, &vs),
            Value::Text("O'Reilly".into())
        );
        // Mixed case is normalized.
        assert_eq!(
            eval_str("=PROPER(\"HELLO wOrLd\")", &cm, &vs),
            Value::Text("Hello World".into())
        );
        // Numbers and punctuation pass through.
        assert_eq!(
            eval_str("=PROPER(\"abc 123 def\")", &cm, &vs),
            Value::Text("Abc 123 Def".into())
        );
        // Empty text edge.
        assert_eq!(
            eval_str("=PROPER(\"\")", &cm, &vs),
            Value::Text("".into())
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=PROPER(\"a\",\"b\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=PROPER(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_textjoin() {
        let (cm, vs) = make_test_env();
        // Basic join, ignore_empty=TRUE skips empty.
        assert_eq!(
            eval_str("=TEXTJOIN(\",\",TRUE,\"a\",\"\",\"b\",\"c\")", &cm, &vs),
            Value::Text("a,b,c".into())
        );
        // ignore_empty=FALSE keeps empty.
        assert_eq!(
            eval_str("=TEXTJOIN(\",\",FALSE,\"a\",\"\",\"b\")", &cm, &vs),
            Value::Text("a,,b".into())
        );
        // Numbers coerce; A1=10 B1=20.
        assert_eq!(
            eval_str("=TEXTJOIN(\"-\",TRUE,A1,B1)", &cm, &vs),
            Value::Text("10-20".into())
        );
        // Range arg streams: A1:B1 = 10,20.
        assert_eq!(
            eval_str("=TEXTJOIN(\":\",TRUE,A1:B1)", &cm, &vs),
            Value::Text("10:20".into())
        );
        // Empty text edge: delim="" and all empty inputs.
        assert_eq!(
            eval_str("=TEXTJOIN(\"\",TRUE,\"\",\"\")", &cm, &vs),
            Value::Text("".into())
        );
        // Wrong arg count: less than 3.
        assert_eq!(
            eval_str("=TEXTJOIN(\",\",TRUE)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // ignore_empty not coercible → WrongType.
        assert_eq!(
            eval_str("=TEXTJOIN(\",\",\"yes\",\"a\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=TEXTJOIN(\",\",TRUE,A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // === Wildcard matching tests ===

    #[test]
    fn wildcard_match_bare_and_case_insensitive() {
        assert!(wildcard_match("apple", "apple"));
        assert!(wildcard_match("apple", "Apple"));
        assert!(wildcard_match("APPLE", "apple"));
        assert!(!wildcard_match("apple", "banana"));
        assert!(wildcard_match("", ""));
        assert!(!wildcard_match("", "x"));
        assert!(!wildcard_match("x", ""));
    }

    #[test]
    fn wildcard_match_star_positions() {
        // `*` at start / middle / end.
        assert!(wildcard_match("*pple", "apple"));
        assert!(wildcard_match("*pple", "pineapple")); // matches "pineap" + "ple"
        assert!(wildcard_match("a*e", "apple"));
        assert!(wildcard_match("a*e", "ae"));
        assert!(wildcard_match("app*", "apple"));
        assert!(wildcard_match("app*", "app"));
        assert!(!wildcard_match("app*", "ap"));
        // Bare `*` matches anything.
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("*", ""));
    }

    #[test]
    fn wildcard_match_question_mark_exact_one_char() {
        assert!(wildcard_match("?pple", "apple"));
        assert!(!wildcard_match("?pple", "pple"));
        assert!(!wildcard_match("?pple", "aapple"));
        assert!(wildcard_match("a?", "ab"));
        assert!(!wildcard_match("a?", "a"));
    }

    #[test]
    fn wildcard_match_mixed_patterns() {
        // a?p* — a, any-1, p, then anything.
        // apple: a-p-p-l-e → pattern wants a + ? + p + …; '?' eats 'p',
        // then literal 'p' matches 'p', `*` eats 'le'. ✓
        assert!(wildcard_match("a?p*", "apple"));
        assert!(wildcard_match("a?p*", "apply"));
        // apricot: a-p-r-… — pattern needs a + ? + p, but char[2] is 'r',
        // not 'p'. So a?p* does NOT match apricot.
        assert!(!wildcard_match("a?p*", "apricot"));
        // a*p* DOES match apricot (a + anything + p + anything).
        assert!(wildcard_match("a*p*", "apricot"));
        // ap?* matches all three: apple, apply, apricot.
        assert!(wildcard_match("ap?*", "apple"));
        assert!(wildcard_match("ap?*", "apply"));
        assert!(wildcard_match("ap?*", "apricot"));
    }

    #[test]
    fn wildcard_match_escaped_specials() {
        // `~*` is a literal asterisk.
        assert!(wildcard_match("a~*b", "a*b"));
        assert!(!wildcard_match("a~*b", "axb"));
        // `~?` is a literal question mark.
        assert!(wildcard_match("a~?b", "a?b"));
        assert!(!wildcard_match("a~?b", "axb"));
        // `~~` is a literal tilde.
        assert!(wildcard_match("a~~b", "a~b"));
        // Escape applies once; subsequent `*` is still wildcard.
        assert!(wildcard_match("~*a*", "*apple"));
    }

    #[test]
    fn matches_criterion_wildcards_against_text() {
        // `*` and `?` honored on text inputs (no operator prefix).
        assert!(matches_criterion(
            &Value::Text("apple".into()),
            &Value::Text("a*e".into())
        ));
        // Wildcard matching is case-insensitive (Excel parity).
        assert!(matches_criterion(
            &Value::Text("Apple".into()),
            &Value::Text("a*e".into())
        ));
        // With explicit `=` and wildcard.
        assert!(matches_criterion(
            &Value::Text("Apple".into()),
            &Value::Text("=ap*".into())
        ));
        // `<>` with wildcard pattern: negation.
        assert!(matches_criterion(
            &Value::Text("banana".into()),
            &Value::Text("<>a*".into())
        ));
        assert!(!matches_criterion(
            &Value::Text("apple".into()),
            &Value::Text("<>a*".into())
        ));
        // Escaped wildcard: criterion `~*` matches literal "*".
        assert!(matches_criterion(
            &Value::Text("*".into()),
            &Value::Text("~*".into())
        ));
        // `?` for one-char.
        assert!(matches_criterion(
            &Value::Text("cat".into()),
            &Value::Text("?at".into())
        ));
        assert!(!matches_criterion(
            &Value::Text("cat".into()),
            &Value::Text("?att".into())
        ));
    }

    #[test]
    fn matches_criterion_regression_operators_still_work() {
        // Numeric ops still resolve correctly (no wildcard branch taken).
        assert!(matches_criterion(
            &Value::Number(10.0),
            &Value::Text(">5".into())
        ));
        assert!(!matches_criterion(
            &Value::Number(3.0),
            &Value::Text(">5".into())
        ));
        assert!(matches_criterion(
            &Value::Number(5.0),
            &Value::Text(">=5".into())
        ));
        // `<>"x"` non-wildcard: legacy fallback (text eq) — preserved.
        assert!(!matches_criterion(
            &Value::Text("x".into()),
            &Value::Text("<>y".into())
        )); // legacy: "x" != "y" → false (existing quirk; not a wildcard case)
        // Bare equality on numbers.
        assert!(matches_criterion(
            &Value::Number(7.0),
            &Value::Number(7.0)
        ));
    }

    // === Multi-criteria aggregate tests ===

    fn make_multi_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // Layout:
        //   A1=apple   B1=10   C1=red
        //   A2=banana  B2=20   C2=yellow
        //   A3=apricot B3=30   C3=red
        //   A4=cherry  B4=40   C4=red
        //   A5=apple   B5=50   C5=green
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let rows: [(&str, f64, &str); 5] = [
            ("apple", 10.0, "red"),
            ("banana", 20.0, "yellow"),
            ("apricot", 30.0, "red"),
            ("cherry", 40.0, "red"),
            ("apple", 50.0, "green"),
        ];
        let mut next_id: u64 = 0;
        for (row, (name, n, color)) in rows.iter().enumerate() {
            let r = row as u32;
            let a = AtomId::from_raw(next_id);
            next_id += 1;
            let b = AtomId::from_raw(next_id);
            next_id += 1;
            let c = AtomId::from_raw(next_id);
            next_id += 1;
            cell_map.insert(CellAddress::new(r, 0), a);
            cell_map.insert(CellAddress::new(r, 1), b);
            cell_map.insert(CellAddress::new(r, 2), c);
            values.insert(a, Value::Text((*name).into()));
            values.insert(b, Value::Number(*n));
            values.insert(c, Value::Text((*color).into()));
        }
        (cell_map, values)
    }

    // ---- AVERAGEIF ----

    #[test]
    fn averageif_two_args_average_over_range_itself() {
        let (cm, vs) = make_multi_env();
        // B1:B5 = 10,20,30,40,50; criterion ">=30" → (30+40+50)/3 = 40.
        assert_eq!(
            eval_str("=AVERAGEIF(B1:B5,\">=30\")", &cm, &vs),
            Value::Number(40.0)
        );
    }

    #[test]
    fn averageif_three_args_uses_average_range() {
        let (cm, vs) = make_multi_env();
        // Find rows where A is "apple" (rows 1, 5), average B → (10+50)/2 = 30.
        assert_eq!(
            eval_str("=AVERAGEIF(A1:A5,\"apple\",B1:B5)", &cm, &vs),
            Value::Number(30.0)
        );
    }

    #[test]
    fn averageif_wildcard_question_mark() {
        let (cm, vs) = make_multi_env();
        // `?pple` matches "apple" (rows 1 and 5), not "apricot". → (10+50)/2 = 30.
        assert_eq!(
            eval_str("=AVERAGEIF(A1:A5,\"?pple\",B1:B5)", &cm, &vs),
            Value::Number(30.0)
        );
    }

    #[test]
    fn averageif_wrong_arg_count() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=AVERAGEIF(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=AVERAGEIF(A1:A5,\"apple\",B1:B5,\"extra\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn averageif_shape_mismatch() {
        let (cm, vs) = make_multi_env();
        // A1:A5 is 5×1, B1:B3 is 3×1 → shape mismatch.
        assert_eq!(
            eval_str("=AVERAGEIF(A1:A5,\"apple\",B1:B3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn averageif_empty_match_set_returns_div_zero() {
        let (cm, vs) = make_multi_env();
        // Nothing matches "zzz" → no numbers averaged → #DIV/0!.
        assert_eq!(
            eval_str("=AVERAGEIF(A1:A5,\"zzz\",B1:B5)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn averageif_error_propagation_from_criteria_cell() {
        let (cm, vs) = make_multi_env();
        // Force a cell to produce an error during eval.
        // B1/C1 (text/0) coerces text → error. Use formula via temp eval.
        // Simpler: pass an OFFSET that produces an invalid ref isn't easy
        // through criteria; instead pre-populate one cell as Error.
        let mut cm = cm;
        let mut vs = vs;
        let err_id = AtomId::from_raw(99);
        cm.insert(CellAddress::new(10, 0), err_id);
        cm.insert(CellAddress::new(10, 1), AtomId::from_raw(100));
        vs.insert(err_id, Value::Error(ValueError::WrongType));
        vs.insert(AtomId::from_raw(100), Value::Number(5.0));
        assert_eq!(
            eval_str("=AVERAGEIF(A11:A11,\"x\",B11:B11)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    // ---- COUNTIFS ----

    #[test]
    fn countifs_single_pair_matches_countif() {
        let (cm, vs) = make_multi_env();
        // Same as COUNTIF(B1:B5, ">=30") → 3.
        assert_eq!(
            eval_str("=COUNTIFS(B1:B5,\">=30\")", &cm, &vs),
            Value::Number(3.0)
        );
    }

    #[test]
    fn countifs_two_pairs_intersect() {
        let (cm, vs) = make_multi_env();
        // Color=red AND amount>=30: rows 3 (apricot/30) and 4 (cherry/40) → 2.
        assert_eq!(
            eval_str("=COUNTIFS(C1:C5,\"red\",B1:B5,\">=30\")", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn countifs_wildcard_star() {
        let (cm, vs) = make_multi_env();
        // Names starting with "ap*": "apple", "apricot", "apple" → 3.
        assert_eq!(
            eval_str("=COUNTIFS(A1:A5,\"ap*\")", &cm, &vs),
            Value::Number(3.0)
        );
    }

    #[test]
    fn countifs_wildcard_escaped_star() {
        // Build a small env with literal "*" in a cell.
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        let a2 = AtomId::from_raw(1);
        cell_map.insert(CellAddress::new(0, 0), a1);
        cell_map.insert(CellAddress::new(1, 0), a2);
        values.insert(a1, Value::Text("*".into()));
        values.insert(a2, Value::Text("anything".into()));
        // `~*` matches only the literal "*" cell.
        assert_eq!(
            eval_str("=COUNTIFS(A1:A2,\"~*\")", &cell_map, &values),
            Value::Number(1.0)
        );
        // Plain `*` matches both (it's a wildcard).
        assert_eq!(
            eval_str("=COUNTIFS(A1:A2,\"*\")", &cell_map, &values),
            Value::Number(2.0)
        );
    }

    #[test]
    fn countifs_wrong_arg_count() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=COUNTIFS(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COUNTIFS(A1:A5,\"x\",B1:B5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn countifs_shape_mismatch() {
        let (cm, vs) = make_multi_env();
        // A1:A5 (5×1) vs B1:B3 (3×1).
        assert_eq!(
            eval_str("=COUNTIFS(A1:A5,\"x\",B1:B3,\">0\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn countifs_empty_match_returns_zero() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=COUNTIFS(A1:A5,\"zzz\")", &cm, &vs),
            Value::Number(0.0)
        );
    }

    #[test]
    fn countifs_error_propagation() {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        cell_map.insert(CellAddress::new(0, 0), a1);
        values.insert(a1, Value::Error(ValueError::WrongType));
        assert_eq!(
            eval_str("=COUNTIFS(A1:A1,\"x\")", &cell_map, &values),
            Value::Error(ValueError::WrongType)
        );
    }

    // ---- SUMIFS ----

    #[test]
    fn sumifs_single_pair_matches_sumif() {
        let (cm, vs) = make_multi_env();
        // SUMIFS(B, B, ">=30") → 30+40+50 = 120.
        assert_eq!(
            eval_str("=SUMIFS(B1:B5,B1:B5,\">=30\")", &cm, &vs),
            Value::Number(120.0)
        );
    }

    #[test]
    fn sumifs_two_pairs_intersect() {
        let (cm, vs) = make_multi_env();
        // Sum B where color=red AND B>=30 → 30+40 = 70.
        assert_eq!(
            eval_str(
                "=SUMIFS(B1:B5,C1:C5,\"red\",B1:B5,\">=30\")",
                &cm,
                &vs
            ),
            Value::Number(70.0)
        );
    }

    #[test]
    fn sumifs_wildcard() {
        let (cm, vs) = make_multi_env();
        // SUMIFS(B, A, "ap*") → 10+30+50 = 90 (apple, apricot, apple).
        assert_eq!(
            eval_str("=SUMIFS(B1:B5,A1:A5,\"ap*\")", &cm, &vs),
            Value::Number(90.0)
        );
    }

    #[test]
    fn sumifs_wrong_arg_count() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=SUMIFS(B1:B5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Even number of args after sum_range → invalid (each criterion needs
        // a paired range).
        assert_eq!(
            eval_str("=SUMIFS(B1:B5,A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn sumifs_shape_mismatch() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=SUMIFS(B1:B5,A1:A3,\"apple\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn sumifs_empty_match_returns_zero() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=SUMIFS(B1:B5,A1:A5,\"zzz\")", &cm, &vs),
            Value::Number(0.0)
        );
    }

    #[test]
    fn sumifs_error_propagation() {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        let b1 = AtomId::from_raw(1);
        cell_map.insert(CellAddress::new(0, 0), a1);
        cell_map.insert(CellAddress::new(0, 1), b1);
        values.insert(a1, Value::Error(ValueError::DivisionByZero));
        values.insert(b1, Value::Number(7.0));
        // Criteria-range error propagates.
        assert_eq!(
            eval_str("=SUMIFS(B1:B1,A1:A1,\"x\")", &cell_map, &values),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // ---- AVERAGEIFS ----

    #[test]
    fn averageifs_happy_path() {
        let (cm, vs) = make_multi_env();
        // Avg B where color=red AND B>=30 → (30+40)/2 = 35.
        assert_eq!(
            eval_str(
                "=AVERAGEIFS(B1:B5,C1:C5,\"red\",B1:B5,\">=30\")",
                &cm,
                &vs
            ),
            Value::Number(35.0)
        );
    }

    #[test]
    fn averageifs_wildcard() {
        let (cm, vs) = make_multi_env();
        // Avg B where name matches "?pple" → (10+50)/2 = 30.
        assert_eq!(
            eval_str("=AVERAGEIFS(B1:B5,A1:A5,\"?pple\")", &cm, &vs),
            Value::Number(30.0)
        );
    }

    #[test]
    fn averageifs_wrong_arg_count() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=AVERAGEIFS(B1:B5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=AVERAGEIFS(B1:B5,A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn averageifs_shape_mismatch() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=AVERAGEIFS(B1:B5,A1:A3,\"apple\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn averageifs_empty_match_returns_div_zero() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=AVERAGEIFS(B1:B5,A1:A5,\"zzz\")", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn averageifs_error_propagation() {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        let b1 = AtomId::from_raw(1);
        cell_map.insert(CellAddress::new(0, 0), a1);
        cell_map.insert(CellAddress::new(0, 1), b1);
        values.insert(a1, Value::Text("x".into()));
        values.insert(b1, Value::Error(ValueError::WrongType));
        // Value-range error propagates when a matching row's value is an error.
        assert_eq!(
            eval_str("=AVERAGEIFS(B1:B1,A1:A1,\"x\")", &cell_map, &values),
            Value::Error(ValueError::WrongType)
        );
    }

    // ---- MAXIFS ----

    #[test]
    fn maxifs_happy_path() {
        let (cm, vs) = make_multi_env();
        // Max B where color=red → max(10, 30, 40) = 40.
        assert_eq!(
            eval_str("=MAXIFS(B1:B5,C1:C5,\"red\")", &cm, &vs),
            Value::Number(40.0)
        );
    }

    #[test]
    fn maxifs_wildcard() {
        let (cm, vs) = make_multi_env();
        // Max B where name matches "ap*" → max(10, 30, 50) = 50.
        assert_eq!(
            eval_str("=MAXIFS(B1:B5,A1:A5,\"ap*\")", &cm, &vs),
            Value::Number(50.0)
        );
    }

    #[test]
    fn maxifs_wrong_arg_count() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=MAXIFS(B1:B5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=MAXIFS(B1:B5,A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn maxifs_shape_mismatch() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=MAXIFS(B1:B5,A1:A3,\"apple\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn maxifs_empty_match_returns_zero() {
        let (cm, vs) = make_multi_env();
        // Per Excel: zero matches → 0.
        assert_eq!(
            eval_str("=MAXIFS(B1:B5,A1:A5,\"zzz\")", &cm, &vs),
            Value::Number(0.0)
        );
    }

    #[test]
    fn maxifs_error_propagation() {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        cell_map.insert(CellAddress::new(0, 0), a1);
        values.insert(a1, Value::Error(ValueError::CyclicRef));
        assert_eq!(
            eval_str("=MAXIFS(A1:A1,A1:A1,\">0\")", &cell_map, &values),
            Value::Error(ValueError::CyclicRef)
        );
    }

    // ---- MINIFS ----

    #[test]
    fn minifs_happy_path() {
        let (cm, vs) = make_multi_env();
        // Min B where color=red → min(10, 30, 40) = 10.
        assert_eq!(
            eval_str("=MINIFS(B1:B5,C1:C5,\"red\")", &cm, &vs),
            Value::Number(10.0)
        );
    }

    #[test]
    fn minifs_wildcard() {
        let (cm, vs) = make_multi_env();
        // Min B where name matches "ap*" → min(10, 30, 50) = 10.
        assert_eq!(
            eval_str("=MINIFS(B1:B5,A1:A5,\"ap*\")", &cm, &vs),
            Value::Number(10.0)
        );
    }

    #[test]
    fn minifs_wrong_arg_count() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=MINIFS(B1:B5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn minifs_shape_mismatch() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=MINIFS(B1:B5,A1:A3,\"apple\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn minifs_empty_match_returns_zero() {
        let (cm, vs) = make_multi_env();
        assert_eq!(
            eval_str("=MINIFS(B1:B5,A1:A5,\"zzz\")", &cm, &vs),
            Value::Number(0.0)
        );
    }

    #[test]
    fn minifs_error_propagation() {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        cell_map.insert(CellAddress::new(0, 0), a1);
        values.insert(a1, Value::Error(ValueError::Overflow));
        assert_eq!(
            eval_str("=MINIFS(A1:A1,A1:A1,\">0\")", &cell_map, &values),
            Value::Error(ValueError::Overflow)
        );
    }
}
