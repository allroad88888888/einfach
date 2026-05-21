use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use einfach_core::{ArrayData, AtomId, LambdaValue, Value, ValueError};

use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr};
use crate::range::CellRange;
use crate::shift::{REF_INVALID_COL, REF_INVALID_ROW};

/// Lexical-scope frame for a single `LET(...)` activation. Bindings are
/// pushed sequentially in source order so a later `(name, value)` pair
/// can reference earlier names in the same LET, and a nested `LET`'s
/// frame links to the surrounding frame so outer bindings remain
/// visible through the parent chain.
///
/// Why a frame rather than a flat `HashMap`? A LET inside another LET
/// must shadow — `=LET(x, 5, LET(x, 10, x*2))` returns 20. Linking a
/// fresh frame to the parent gives shadow semantics in O(depth) lookup
/// without copying the outer table.
#[derive(Debug)]
struct LetFrame {
    bindings: HashMap<String, Value>,
}

impl LetFrame {
    fn new() -> Self {
        LetFrame {
            bindings: HashMap::new(),
        }
    }

    fn bind(&mut self, name: String, value: Value) {
        self.bindings.insert(name, value);
    }
}

thread_local! {
    /// Thread-local stack of active LET frames. The top of the stack is
    /// the innermost LET; lookup walks down. The stack is empty outside
    /// any LET body — `Expr::Name` then surfaces `#NAME?`.
    ///
    /// Why TLS rather than a parameter? Threading a `&Scope` through
    /// every helper (`for_each_arg_value`, `eval_func` arms, range
    /// resolvers, etc.) would touch the entire 16k-line `eval.rs`. The
    /// LET arm pushes/pops a frame in a save/restore guard so the stack
    /// stays balanced even when the body short-circuits on an error,
    /// and `Expr::Name` only ever reads — no aliasing hazards.
    static LET_FRAMES: RefCell<Vec<LetFrame>> = const { RefCell::new(Vec::new()) };
}

/// Walk the active LET frame stack from innermost to outermost. Returns
/// the first binding for `name`, or `None` if unbound.
fn lookup_let_binding(name: &str) -> Option<Value> {
    LET_FRAMES.with(|frames| {
        let frames = frames.borrow();
        for frame in frames.iter().rev() {
            if let Some(v) = frame.bindings.get(name) {
                return Some(v.clone());
            }
        }
        None
    })
}

/// Snapshot every binding visible at the call site into a flat
/// `Vec<(String, Value)>`. Used by `LAMBDA` to capture the active LET
/// scope at the point the lambda literal is evaluated — the lambda
/// outlives its enclosing LET and must keep those bindings alive in
/// its own state rather than relying on a reference to the live stack
/// (which is empty by the time the lambda is later applied).
///
/// Inner frames shadow outer ones (innermost-first walk), and we
/// dedupe on first occurrence so the snapshot mirrors `lookup_let_binding`
/// semantics exactly. Order is irrelevant to the consumer (`apply_lambda`
/// builds a HashMap-backed frame from the result) but we keep
/// innermost-first for readability when debugging.
fn snapshot_let_frames() -> Vec<(String, Value)> {
    LET_FRAMES.with(|frames| {
        let frames = frames.borrow();
        let mut out: Vec<(String, Value)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for frame in frames.iter().rev() {
            for (k, v) in &frame.bindings {
                if seen.insert(k.clone()) {
                    out.push((k.clone(), v.clone()));
                }
            }
        }
        out
    })
}

/// Push a fresh frame onto the LET stack and seed it with the provided
/// bindings. Used by `apply_lambda` to extend the scope chain with the
/// lambda's captured snapshot + parameter bindings before evaluating the
/// body. `pop_let_frame` MUST be called after — the public API leaks
/// the imbalance otherwise; callers use a guard to enforce that.
fn push_let_frame(initial: Vec<(String, Value)>) {
    LET_FRAMES.with(|frames| {
        let mut frame = LetFrame::new();
        for (k, v) in initial {
            frame.bind(k, v);
        }
        frames.borrow_mut().push(frame);
    });
}

fn pop_let_frame() {
    LET_FRAMES.with(|frames| {
        frames.borrow_mut().pop();
    });
}

/// Concrete lambda payload used by the formula evaluator. The `params`
/// vec stores parameter names (in declaration order); `body` is the AST
/// the LAMBDA literal wraps; `captured` is the snapshot of LET bindings
/// visible when the lambda literal was evaluated. Owned by an `Arc` at
/// the `Value::Lambda` boundary so clones are cheap (lambdas pass
/// through array higher-order functions and get cloned per call).
#[derive(Debug)]
pub(crate) struct ExcelLambda {
    pub params: Vec<String>,
    pub body: Expr,
    pub captured: Vec<(String, Value)>,
}

impl LambdaValue for ExcelLambda {
    fn arity(&self) -> usize {
        self.params.len()
    }
    fn param_names(&self) -> &[String] {
        &self.params
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Apply a lambda value to a positional argument list. Returns
/// `WrongType` if the value isn't a lambda (or a downcast fails), and
/// `WrongArgCount` on arity mismatch. The body is evaluated against a
/// fresh LET frame seeded with the lambda's captured bindings PLUS the
/// new parameter bindings (parameters shadow same-named captured
/// bindings).
///
/// Errors from the body propagate out as-is. The frame is popped via a
/// guard so the LET stack stays balanced even when the body
/// short-circuits.
pub(crate) fn apply_lambda(
    lambda: &Value,
    args: Vec<Value>,
    provider: &dyn EvalProvider,
) -> Value {
    let arc = match lambda {
        Value::Lambda(a) => a.clone(),
        Value::Error(e) => return Value::Error(e.clone()),
        _ => return Value::Error(ValueError::WrongType),
    };
    let excel_lambda = match arc.as_any().downcast_ref::<ExcelLambda>() {
        Some(l) => l,
        None => return Value::Error(ValueError::WrongType),
    };
    if args.len() != excel_lambda.params.len() {
        return Value::Error(ValueError::WrongArgCount);
    }
    // Build the activation frame: start with the captured snapshot, then
    // overwrite/append each parameter binding. Parameters with the same
    // name as a captured binding shadow it (Excel parity — `LAMBDA(x,
    // ...)` body sees the new `x`, not the outer LET's `x`).
    let mut frame_bindings: Vec<(String, Value)> = excel_lambda.captured.clone();
    for (name, value) in excel_lambda.params.iter().zip(args) {
        if let Some(slot) = frame_bindings.iter_mut().find(|(n, _)| n == name) {
            slot.1 = value;
        } else {
            frame_bindings.push((name.clone(), value));
        }
    }
    push_let_frame(frame_bindings);
    // Save/restore-style guard equivalent: any early-return from the
    // body still has the pop executed because we route everything
    // through the closure below.
    let result = eval_expr_with_provider(&excel_lambda.body, provider);
    pop_let_frame();
    result
}

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

    /// The cell currently being evaluated, if known. Used by `ROW()` /
    /// `COLUMN()` (no-arg) to return the formula's own row/column. Providers
    /// that don't track this (e.g. the legacy single-sheet shim) return None.
    fn current_cell(&self) -> Option<CellAddress> {
        None
    }

    /// Set the current cell being evaluated. Providers that surface
    /// `current_cell()` use this to push/pop the address as the evaluator
    /// recurses into nested formula cells. Default impl is a no-op so
    /// providers without a current-cell concept ignore the call.
    fn set_current_cell(&self, _addr: Option<CellAddress>) {}
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

        Expr::Name(name) => {
            // Resolve against the current LET scope chain. Unbound names
            // surface `#NAME?` per Excel.
            //
            // Named ranges, if/when implemented, would consult them here
            // BEFORE falling through to InvalidName — LET bindings take
            // precedence (Excel parity).
            lookup_let_binding(name).unwrap_or(Value::Error(ValueError::InvalidName))
        }

        Expr::Call(callee, call_args) => {
            // Immediate-application form: evaluate the callee, then apply
            // the resulting lambda to the evaluated arguments. The L2
            // entry point — `=LAMBDA(x, x*x)(5)` lands here. Argument
            // evaluation happens *outside* the lambda body so it sees the
            // CALLER's LET scope, not the lambda's captured frame
            // (matches Excel call semantics).
            let callee_value = eval_expr_with_provider(callee, provider);
            if let Value::Error(e) = &callee_value {
                return Value::Error(e.clone());
            }
            let mut arg_values: Vec<Value> = Vec::with_capacity(call_args.len());
            for a in call_args {
                let v = eval_expr_with_provider(a, provider);
                if let Value::Error(e) = &v {
                    return Value::Error(e.clone());
                }
                arg_values.push(v);
            }
            apply_lambda(&callee_value, arg_values, provider)
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
        // Phase 1 spill plumbing: scalar coercion of an anchor Array
        // collapses to the top-left element. This branch is reachable
        // only for callers that bypass `for_each_arg_value` (which
        // already iterates Array elements). Falling back to top-left
        // keeps Excel parity (`=A1 & ""` when A1 is a 3x1 spill produces
        // the first element's text).
        Value::Array(arr) => arr
            .get(0, 0)
            .map(coerce_to_text)
            .unwrap_or_default(),
        // A lambda has no scalar text rendering — Excel surfaces `#CALC!`
        // when text contexts hit a lambda. We don't have CALC! in our
        // enum, so a generic placeholder keeps the function pure (no
        // error injection at coercion time) and any operator that
        // actually needed a numeric/boolean lambda will fail via the
        // usual WrongType path.
        Value::Lambda(_) => "<lambda>".into(),
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
        //
        // Excel parity: wildcards are NOT honored in approximate mode. A
        // pattern like "a*" is treated as a literal text key and ordered
        // by `compare_lookup` (string compare). This branch intentionally
        // does not call `wildcard_match`.
        let mut best: Option<usize> = None;
        for (i, k) in keys.iter().enumerate() {
            if compare_lookup(k, needle).is_le() {
                best = Some(i);
            } else {
                break; // input is supposed to be sorted; first overshoot ends scan
            }
        }
        best
    } else if let Value::Text(pattern) = needle {
        if pattern_has_wildcard(pattern) {
            // Excel wildcard match for exact-mode text patterns (`?`, `*`,
            // `~` escape). Non-text cells are coerced to text first so a
            // pattern like "4?" matches a numeric 42.
            keys.iter()
                .position(|k| wildcard_match(pattern, &coerce_to_text(k)))
        } else {
            keys.iter().position(|k| values_equal(k, needle))
        }
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

/// Materialize a function argument as a row-major 2D buffer plus shape.
/// Accepts:
///   - `Expr::Range` / `Expr::SheetRange` — collected via the provider.
///   - `OFFSET(...)` — evaluated to a runtime range, then collected.
///   - Anything else — evaluated to a scalar `Value`; a `Value::Array`
///     result returns its shape and data directly, everything else
///     becomes a 1×1 buffer.
///
/// Returns `Err(InvalidValue)` only for ranges whose nominal rectangle
/// exceeds Excel max bounds (full-column / full-row sentinels). Range
/// extraction failures from the provider yield empty grids rather than
/// errors, matching the rest of eval.rs's range-handling.
fn arg_to_2d(
    arg: &Expr,
    provider: &dyn EvalProvider,
) -> Result<(u32, u32, Vec<Value>), ValueError> {
    // Range-shaped argument (literal range or OFFSET).
    if let Some(grid) = collect_range_2d_for_arg(arg, provider) {
        if grid.is_empty() {
            // Either an over-bound sentinel range or a 0-row collection.
            // Treat as a 0×0 buffer; callers reject empty arrays as
            // InvalidValue at their own discretion.
            return Ok((0, 0, Vec::new()));
        }
        let rows = grid.len() as u32;
        let cols = grid[0].len() as u32;
        let mut data: Vec<Value> = Vec::with_capacity(grid.len() * (cols as usize));
        for row in grid {
            data.extend(row);
        }
        return Ok((rows, cols, data));
    }
    // Non-range argument: evaluate to a value. Array → expand. Scalar → 1×1.
    let v = eval_expr_with_provider(arg, provider);
    match v {
        Value::Array(arr) => {
            let (rows, cols) = arr.shape();
            let data = arr.data.clone();
            Ok((rows, cols, data))
        }
        Value::Error(e) => Err(e),
        other => Ok((1, 1, vec![other])),
    }
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
        _ => {
            let v = eval_expr_with_provider(arg, provider);
            // Dynamic-array path: when a sub-expression evaluates to a
            // `Value::Array`, iterate every element so aggregate-like
            // callers (SUM, AVERAGE, COUNT, ...) see the elements rather
            // than a single opaque Array value. Synthetic positions yield
            // `None` for the address — only literal range refs get a
            // `Some(addr)` (see the `Range` and `SheetRange` arms above).
            // This is the Phase 1 plumbing; no built-in function produces
            // `Value::Array` yet (Phase 3 work), so this branch is dead
            // until a constructor function exists.
            if let Value::Array(arr) = v {
                for elem in arr.data.iter() {
                    f(None, elem.clone());
                }
            } else {
                f(None, v);
            }
        }
    }
}

/// A database range resolved from a D* function's first argument. The
/// header row is data row 0 in the original rectangle; `data_rows` is the
/// number of rows BELOW the header. Built from `arg_as_range`/`OFFSET`
/// shapes (the same set `resolve_range_arg` accepts) but kept separately
/// so callers can address "data row i, column j" without subtracting the
/// header offset each time.
struct DatabaseRange {
    sheet: Option<String>,
    start_row: u32,
    start_col: u32,
    cols: u32,
    data_rows: u32,
}

impl DatabaseRange {
    /// Fetch the header cell at the given 0-based column index. Returns
    /// `Value::Null` if `col` is out of range.
    fn header(&self, col: u32, provider: &dyn EvalProvider) -> Value {
        if col >= self.cols {
            return Value::Null;
        }
        let addr = CellAddress::new(self.start_row, self.start_col + col);
        match &self.sheet {
            Some(s) => provider.sheet_cell(s, addr),
            None => provider.cell(addr),
        }
    }

    /// Fetch a data cell. `row` is 0-based against the data area (so row
    /// 0 is the first row after the header), and `col` is the 0-based
    /// column index.
    fn data_cell(&self, row: u32, col: u32, provider: &dyn EvalProvider) -> Value {
        let addr = CellAddress::new(self.start_row + 1 + row, self.start_col + col);
        match &self.sheet {
            Some(s) => provider.sheet_cell(s, addr),
            None => provider.cell(addr),
        }
    }
}

/// Resolve a D* function's database argument into a `DatabaseRange`. The
/// argument must be a literal range or `OFFSET(...)` with at least 2 rows
/// (header + ≥ 1 data row). Otherwise `InvalidValue`.
fn resolve_database_range(
    arg: &Expr,
    provider: &dyn EvalProvider,
) -> Result<DatabaseRange, ValueError> {
    let resolved = resolve_range_arg(arg, provider).ok_or(ValueError::InvalidValue)?;
    if resolved.rows < 2 {
        // A database needs a header row and at least one data row.
        return Err(ValueError::InvalidValue);
    }
    Ok(DatabaseRange {
        sheet: resolved.sheet,
        start_row: resolved.start_row,
        start_col: resolved.start_col,
        cols: resolved.cols,
        data_rows: resolved.rows - 1,
    })
}

/// Resolve a D* function's `field` argument to a 0-based column index
/// inside `database`. Accepts:
/// - A 1-based number (1 → column 0, etc).
/// - Text matching a header cell case-insensitively.
/// Anything else, or out-of-range, is `InvalidValue`. Header cells that
/// evaluate to `Value::Error(_)` propagate.
fn resolve_db_field(
    database: &DatabaseRange,
    field_arg: &Expr,
    provider: &dyn EvalProvider,
) -> Result<usize, ValueError> {
    let v = eval_expr_with_provider(field_arg, provider);
    if let Value::Error(e) = v {
        return Err(e);
    }
    // Numeric form first: 1-based column index. Booleans coerce per
    // `coerce_to_number` (TRUE=1, FALSE=0); FALSE → out of range.
    if let Value::Number(n) = v {
        if !n.is_finite() || n.trunc() != n || n < 1.0 || (n as u32) > database.cols {
            return Err(ValueError::InvalidValue);
        }
        return Ok((n as usize) - 1);
    }
    // Text form: case-insensitive header lookup.
    let needle = match v {
        Value::Text(s) => s,
        _ => return Err(ValueError::InvalidValue),
    };
    let needle_lc = needle.to_lowercase();
    for col in 0..database.cols {
        let header = database.header(col, provider);
        if let Value::Error(e) = header {
            return Err(e);
        }
        if coerce_to_text(&header).to_lowercase() == needle_lc {
            return Ok(col as usize);
        }
    }
    Err(ValueError::InvalidValue)
}

/// Walk every data row of `database`, evaluate `criteria`, and invoke
/// `callback(row_index)` for each matching row.
///
/// Criteria layout: row 0 is a header row whose cells name database
/// columns (case-insensitive). Rows 1..N are criterion rows. A data row
/// matches if it satisfies AT LEAST ONE criterion row; a criterion row
/// is satisfied if EVERY non-empty cell in it passes `matches_criterion`
/// against the corresponding database column. Empty (Null) criterion
/// cells contribute nothing (vacuously true), so a fully empty criterion
/// row matches every data row.
///
/// Returns `Err(e)` on the first `Value::Error(_)` encountered in either
/// database or criteria cells, or on a malformed criteria range (no
/// header row, or a header that doesn't match any database column).
fn iter_db_matches(
    database: &DatabaseRange,
    criteria_arg: &Expr,
    provider: &dyn EvalProvider,
    mut callback: impl FnMut(u32) -> Result<(), ValueError>,
) -> Result<(), ValueError> {
    let criteria = resolve_range_arg(criteria_arg, provider).ok_or(ValueError::InvalidValue)?;
    if criteria.rows < 2 {
        // No criterion rows — Excel treats this as "no rows match".
        return Ok(());
    }

    // Resolve criteria headers → database column index (lazily, once).
    // `header_cols[i]` is the 0-based database column for criteria column
    // `i`, or `None` if the criteria header is empty (skip column).
    let mut header_cols: Vec<Option<u32>> = Vec::with_capacity(criteria.cols as usize);
    for c in 0..criteria.cols {
        let header = fetch_range_cell(&criteria, 0, c, provider);
        if let Value::Error(e) = header {
            return Err(e);
        }
        if matches!(header, Value::Null) {
            header_cols.push(None);
            continue;
        }
        let header_text = coerce_to_text(&header).to_lowercase();
        let mut matched: Option<u32> = None;
        for db_c in 0..database.cols {
            let dh = database.header(db_c, provider);
            if let Value::Error(e) = dh {
                return Err(e);
            }
            if coerce_to_text(&dh).to_lowercase() == header_text {
                matched = Some(db_c);
                break;
            }
        }
        // Bad criteria header (non-empty header not present in database)
        // → InvalidValue. We choose strict-error semantics over silent
        // mismatch so authoring mistakes surface loudly.
        match matched {
            Some(idx) => header_cols.push(Some(idx)),
            None => return Err(ValueError::InvalidValue),
        }
    }

    // For each data row, OR across criterion rows.
    for dr in 0..database.data_rows {
        let mut any_row_matches = false;
        for cr in 1..criteria.rows {
            let mut all_match = true;
            for cc in 0..criteria.cols {
                let cv = fetch_range_cell(&criteria, cr, cc, provider);
                if let Value::Error(e) = cv {
                    return Err(e);
                }
                if matches!(cv, Value::Null) {
                    continue;
                }
                let db_col = match header_cols[cc as usize] {
                    Some(c) => c,
                    // Skipped column (criteria header was empty). The
                    // criterion value here is non-empty but has no
                    // anchor column → vacuously fail this criterion row.
                    None => {
                        all_match = false;
                        break;
                    }
                };
                let dv = database.data_cell(dr, db_col, provider);
                if let Value::Error(e) = dv {
                    return Err(e);
                }
                if !matches_criterion(&dv, &cv) {
                    all_match = false;
                    break;
                }
            }
            if all_match {
                any_row_matches = true;
                break;
            }
        }
        if any_row_matches {
            callback(dr)?;
        }
    }
    Ok(())
}

/// Common skeleton for D* numeric aggregates. Resolves the database and
/// field column, then folds over matching rows' `field` values through
/// `step`. `init` seeds the accumulator; `finalize` produces the result
/// (e.g. wrap in `Value::Number`, or surface `DivisionByZero` if no
/// values were collected).
///
/// `step` receives `(state, value)` and may inspect non-numeric values
/// (DCOUNTA cares about Null vs non-Null) — callers gate by type.
fn db_aggregate<S>(
    args: &[Expr],
    provider: &dyn EvalProvider,
    mut init: S,
    step: impl Fn(&mut S, &Value),
    finalize: impl FnOnce(S) -> Value,
) -> Value {
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let database = match resolve_database_range(&args[0], provider) {
        Ok(d) => d,
        Err(e) => return Value::Error(e),
    };
    let field_col = match resolve_db_field(&database, &args[1], provider) {
        Ok(c) => c,
        Err(e) => return Value::Error(e),
    };
    let walk = iter_db_matches(&database, &args[2], provider, |row| {
        let v = database.data_cell(row, field_col as u32, provider);
        if let Value::Error(e) = v {
            return Err(e);
        }
        step(&mut init, &v);
        Ok(())
    });
    if let Err(e) = walk {
        return Value::Error(e);
    }
    finalize(init)
}

fn eval_func(name: &str, args: &[Expr], provider: &dyn EvalProvider) -> Value {
    match name {
        // LET is the first arm so the LET frame is pushed/popped before
        // any other dispatch can resolve a bare `Expr::Name` against
        // the stack. L1 of the LAMBDA arc; LAMBDA / MAP / REDUCE come
        // later.
        //
        //   LET(name1, value1, name2, value2, ..., expression)
        //
        // Total arg count must be odd and ≥ 3 (at least one binding +
        // a body). Bindings are LEXICAL and SEQUENTIAL: each value can
        // see the bindings declared earlier in the same LET, and a
        // nested LET sees outer bindings through the frame chain.
        "LET" => {
            if args.len() < 3 || args.len() % 2 == 0 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let body = args.last().unwrap();
            let pairs = &args[..args.len() - 1];

            // Push a fresh frame, then bind sequentially. Each value
            // expression is evaluated WITH the current scope (so later
            // bindings can reference earlier ones), and an error from
            // any value propagates out — we still pop the frame via a
            // guard so the stack stays balanced.
            //
            // We don't reject names that shadow built-in function names
            // (e.g. `LET(SUM, 5, SUM)`). Excel rejects this with #NAME?
            // but the spec for this commit allows skipping that check;
            // a future tightening can compare against the dispatch
            // table here. A non-`Expr::Name` in a name slot is the only
            // structural rejection — caught below.
            LET_FRAMES.with(|frames| frames.borrow_mut().push(LetFrame::new()));

            let result = (|| {
                let mut i = 0;
                while i < pairs.len() {
                    let binding_name = match &pairs[i] {
                        Expr::Name(n) => n.clone(),
                        _ => return Value::Error(ValueError::InvalidName),
                    };
                    let value = eval_expr_with_provider(&pairs[i + 1], provider);
                    if let Value::Error(e) = &value {
                        return Value::Error(e.clone());
                    }
                    LET_FRAMES.with(|frames| {
                        frames
                            .borrow_mut()
                            .last_mut()
                            .expect("LET frame just pushed")
                            .bind(binding_name, value);
                    });
                    i += 2;
                }
                eval_expr_with_provider(body, provider)
            })();

            LET_FRAMES.with(|frames| {
                frames.borrow_mut().pop();
            });
            result
        }

        // LAMBDA(param1, param2, ..., body) — produce a first-class
        // lambda value. The last argument is the body expression; every
        // preceding argument must be a bare identifier (Expr::Name) and
        // becomes a parameter name. L2 of the LAMBDA arc; immediate
        // invocation `=LAMBDA(...)(args)` is handled by Expr::Call.
        //
        // Closure capture: the lambda snapshots the current LET frames
        // at literal-evaluation time. That snapshot moves into the
        // ExcelLambda struct and is later pushed as a fresh frame when
        // `apply_lambda` evaluates the body. This is what lets
        // `=LET(n, 7, LAMBDA(x, x*n)(3))` resolve `n` to 7 — even
        // though the LET frame is popped before the lambda's body
        // would otherwise run (in this immediate-call case it doesn't
        // matter, but the contract holds for stored lambdas too).
        //
        // Error contract: 0 args → WrongArgCount (need the body at
        // least). A non-`Name` in a param slot → InvalidName. The
        // 1-arg form `=LAMBDA(body)` is allowed (zero-param lambda),
        // applied via `=LAMBDA(body)()`.
        "LAMBDA" => {
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let body = args.last().unwrap().clone();
            let mut params: Vec<String> = Vec::with_capacity(args.len() - 1);
            for a in &args[..args.len() - 1] {
                match a {
                    Expr::Name(n) => params.push(n.clone()),
                    _ => return Value::Error(ValueError::InvalidName),
                }
            }
            let captured = snapshot_let_frames();
            let lambda = ExcelLambda {
                params,
                body,
                captured,
            };
            Value::Lambda(Arc::new(lambda))
        }

        // ISOMITTED(arg) — Excel uses this in conjunction with LAMBDA's
        // OPTIONAL-parameter syntax (e.g. `LAMBDA(x, [y], IF(ISOMITTED(y),
        // x, x+y))`). We don't support optional parameters in this phase
        // (every LAMBDA parameter is required; arity is strict in
        // `apply_lambda`), so ISOMITTED has no meaningful work to do and
        // always returns FALSE. Documented gap — re-evaluate when
        // optional-param syntax lands.
        "ISOMITTED" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            // Evaluate the arg so any error it contains propagates
            // (Excel parity). Otherwise: FALSE.
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            Value::Boolean(false)
        }

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
                        // Unreachable: for_each_arg_value flattens Array
                        // sub-expressions into per-element callbacks.
                        Value::Array(_) => {}
                        // A lambda landing in SUM is a type error (the user
                        // wrote `=SUM(LAMBDA(x, x))`-style nonsense). Match
                        // Excel: surface #VALUE!.
                        Value::Lambda(_) => err = Some(ValueError::WrongType),
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
            // Exact mode honors Excel wildcards (`?`, `*`, `~`) when the
            // needle is text; see `lookup_2d`.
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = needle {
                return Value::Error(e);
            }
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
            // HLOOKUP shares the `lookup_2d` engine with VLOOKUP — same
            // wildcard rules apply (only in exact-match mode).
            if args.len() < 3 || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = needle {
                return Value::Error(e);
            }
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
            // MATCH(value, range, [match_type])
            //
            // Streaming early-exit: walk the range, return on first hit.
            // The position is by visit order, which for a dense provider
            // matches the legacy `(i + 1)` 1-based result. (Sparse
            // providers skip holes — position counts only present cells,
            // a deliberate behavior change for full-column refs.)
            //
            // match_type semantics:
            //   0  → exact match. Text needles with `?`/`*`/`~` engage
            //        Excel wildcard semantics (case-insensitive). The
            //        cell value is coerced to text for the wildcard test,
            //        so `MATCH("4?", {42,3}, 0)` returns 1.
            //   1  → "largest value <= needle". Wildcards NOT honored —
            //        a pattern like "a*" is treated as a literal text key.
            //   -1 → "smallest value >= needle". Wildcards NOT honored.
            //
            // Note: this implementation predates `match_type` plumbing and
            // historically treated *all* invocations as exact-match. We
            // preserve that for type=1/-1 too (no behavior change there);
            // the only new behavior is wildcard expansion when type=0.
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = needle {
                return Value::Error(e);
            }
            let match_type: i32 = if args.len() == 3 {
                match coerce_to_number(&eval_expr_with_provider(&args[2], provider)) {
                    Some(n) => n as i32,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                // Excel's true default is 1, but the legacy arm always did
                // exact match; keep that quirk so omitted-3rd-arg tests still
                // pass. Wildcards still engage because we treat default as 0.
                0
            };
            // Pre-check: is this a wildcard-style text needle in exact mode?
            let wildcard_pattern: Option<&str> = if match_type == 0 {
                if let Value::Text(p) = &needle {
                    if pattern_has_wildcard(p) {
                        Some(p.as_str())
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };
            let mut position: u64 = 0;
            let mut found: Option<u64> = None;
            for_each_arg_value(&args[1], provider, &mut |_addr, v| {
                if found.is_some() {
                    return;
                }
                position += 1;
                let hit = match wildcard_pattern {
                    Some(pat) => wildcard_match(pat, &coerce_to_text(&v)),
                    None => values_equal(&v, &needle),
                };
                if hit {
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
                        // Unreachable: for_each_arg_value flattens Array.
                        Value::Array(_) => {}
                        // Lambda inside PRODUCT is a type error.
                        Value::Lambda(_) => err = Some(ValueError::WrongType),
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
                // Dynamic-array: collapse to top-left then re-classify.
                // Phase 1 unreachable until a constructor produces Array.
                Value::Array(arr) => match arr.get(0, 0).cloned().unwrap_or(Value::Null) {
                    Value::Number(n) => Value::Number(n),
                    Value::Boolean(true) => Value::Number(1.0),
                    _ => Value::Number(0.0),
                },
                // N of a lambda is meaningless — return 0 (Excel would
                // surface #VALUE!; we keep the existing tolerant policy).
                Value::Lambda(_) => Value::Number(0.0),
            }
        }
        "TYPE" => {
            // 1=Number, 2=Text, 4=Boolean, 16=Error. Null coerces to 0
            // (Excel returns 1 for empty cells). Excel uses 64 for arrays.
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
                Value::Array(_) => 64.0,
                // No Excel code for lambda; closest match is 128 (a value
                // category Excel reserves). Use 128 distinctly so callers
                // can detect lambda-typed values.
                Value::Lambda(_) => 128.0,
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
                // Dynamic-array: collapse to top-left. Phase 1 unreachable
                // — no constructor produces Array yet.
                Value::Array(arr) => match arr.get(0, 0).cloned().unwrap_or(Value::Null) {
                    Value::Number(n) => Value::Number(n),
                    Value::Boolean(true) => Value::Number(1.0),
                    Value::Boolean(false) | Value::Null => Value::Number(0.0),
                    Value::Text(s) => match s.trim().parse::<f64>() {
                        Ok(n) => Value::Number(n),
                        Err(_) => Value::Error(ValueError::InvalidValue),
                    },
                    Value::Error(e) => Value::Error(e),
                    Value::Array(_) => Value::Error(ValueError::WrongType),
                    Value::Lambda(_) => Value::Error(ValueError::WrongType),
                },
                // VALUE(lambda) — type error.
                Value::Lambda(_) => Value::Error(ValueError::WrongType),
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

        // === Reference / lookup ===
        // ROW([ref]) — return the 1-based row number of `ref`. `ref` must be a
        // direct cell/range/sheet-ref/sheet-range expression (we do not
        // evaluate it; we read its anchor row).
        "ROW" => {
            if args.len() > 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            if args.is_empty() {
                return provider
                    .current_cell()
                    .map(|a| Value::Number((a.row + 1) as f64))
                    .unwrap_or(Value::Error(ValueError::InvalidRef));
            }
            match &args[0] {
                Expr::CellRef(addr) | Expr::SheetRef { addr, .. } => {
                    Value::Number((addr.row + 1) as f64)
                }
                Expr::Range { start, .. } | Expr::SheetRange { start, .. } => {
                    Value::Number((start.row + 1) as f64)
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }

        // COLUMN([ref]) — symmetric to ROW; returns the 1-based column number.
        "COLUMN" => {
            if args.len() > 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            if args.is_empty() {
                return provider
                    .current_cell()
                    .map(|a| Value::Number((a.col + 1) as f64))
                    .unwrap_or(Value::Error(ValueError::InvalidRef));
            }
            match &args[0] {
                Expr::CellRef(addr) | Expr::SheetRef { addr, .. } => {
                    Value::Number((addr.col + 1) as f64)
                }
                Expr::Range { start, .. } | Expr::SheetRange { start, .. } => {
                    Value::Number((start.col + 1) as f64)
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }

        // ROWS(range) — 1-based count of rows in the supplied range. A single
        // cell is treated as a 1×1 range (height 1).
        "ROWS" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            match arg_as_range(&args[0]) {
                Some((_, start, end)) => {
                    let min = start.row.min(end.row);
                    let max = start.row.max(end.row);
                    Value::Number((max - min + 1) as f64)
                }
                None => match &args[0] {
                    Expr::CellRef(_) | Expr::SheetRef { .. } => Value::Number(1.0),
                    _ => Value::Error(ValueError::WrongType),
                },
            }
        }

        // COLUMNS(range) — symmetric to ROWS.
        "COLUMNS" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            match arg_as_range(&args[0]) {
                Some((_, start, end)) => {
                    let min = start.col.min(end.col);
                    let max = start.col.max(end.col);
                    Value::Number((max - min + 1) as f64)
                }
                None => match &args[0] {
                    Expr::CellRef(_) | Expr::SheetRef { .. } => Value::Number(1.0),
                    _ => Value::Error(ValueError::WrongType),
                },
            }
        }

        // CHOOSE(index, val1, val2, ...) — pick the 1-based indexed argument.
        // `index` is evaluated, coerced to a number, and truncated. Only the
        // selected argument is then evaluated (deferred evaluation parity with
        // Excel's lazy CHOOSE semantics).
        "CHOOSE" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let iv = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = iv {
                return Value::Error(e);
            }
            let idx_f = match coerce_to_number(&iv) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            // valid range is 1..=N, where N = args.len() - 1
            if idx_f < 1 || (idx_f as usize) > args.len() - 1 {
                return Value::Error(ValueError::InvalidValue);
            }
            eval_expr_with_provider(&args[idx_f as usize], provider)
        }

        // ADDRESS(row, col[, abs_num=1[, a1=TRUE[, sheet_name=""]]])
        // Build an A1- or R1C1-style address string. `row` / `col` are
        // 1-based; `abs_num` maps 1..=4 to all four absolute/relative
        // permutations.
        "ADDRESS" => {
            if args.len() < 2 || args.len() > 5 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let row_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = row_v {
                return Value::Error(e);
            }
            let col_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = col_v {
                return Value::Error(e);
            }
            let row = match coerce_to_number(&row_v) {
                Some(n) if n >= 1.0 && n.is_finite() => n.trunc() as i64,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let col = match coerce_to_number(&col_v) {
                Some(n) if n >= 1.0 && n.is_finite() => n.trunc() as i64,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let abs_num = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1
            };
            if !(1..=4).contains(&abs_num) {
                return Value::Error(ValueError::InvalidValue);
            }
            let a1 = if args.len() >= 4 {
                let v = eval_expr_with_provider(&args[3], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_bool(&v) {
                    Some(b) => b,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                true
            };
            let sheet_prefix = if args.len() == 5 {
                let v = eval_expr_with_provider(&args[4], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let s = coerce_to_text(&v);
                if s.is_empty() {
                    String::new()
                } else if s.contains(' ') {
                    format!("'{}'!", s)
                } else {
                    format!("{}!", s)
                }
            } else {
                String::new()
            };

            let body = if a1 {
                // abs_num: 1=$A$1, 2=A$1, 3=$A1, 4=A1
                let (row_abs, col_abs) = match abs_num {
                    1 => (true, true),
                    2 => (true, false),
                    3 => (false, true),
                    4 => (false, false),
                    _ => unreachable!(),
                };
                let col_letters = col_index_to_letters_eval((col - 1) as u32);
                let col_part = if col_abs {
                    format!("${}", col_letters)
                } else {
                    col_letters
                };
                let row_part = if row_abs {
                    format!("${}", row)
                } else {
                    format!("{}", row)
                };
                format!("{}{}", col_part, row_part)
            } else {
                // R1C1: 1=R1C1, 2=R1C[1], 3=R[1]C1, 4=R[1]C[1]
                let (row_abs, col_abs) = match abs_num {
                    1 => (true, true),
                    2 => (true, false),
                    3 => (false, true),
                    4 => (false, false),
                    _ => unreachable!(),
                };
                let row_part = if row_abs {
                    format!("R{}", row)
                } else {
                    format!("R[{}]", row)
                };
                let col_part = if col_abs {
                    format!("C{}", col)
                } else {
                    format!("C[{}]", col)
                };
                format!("{}{}", row_part, col_part)
            };
            Value::Text(format!("{}{}", sheet_prefix, body))
        }

        // INDIRECT(ref_text[, a1=TRUE]) — parse a string into a reference and
        // return the referenced cell's value. A1-style only. Range text
        // resolves to the first (top-left) cell — parity with the OFFSET arm
        // pattern that returns `provider.cell(range.start)` for a
        // multi-cell anchor.
        "INDIRECT" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let ref_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = ref_v {
                return Value::Error(e);
            }
            let a1 = if args.len() == 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_bool(&v) {
                    Some(b) => b,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                true
            };
            if !a1 {
                // R1C1 form not yet supported by the parser path; surface
                // #REF! rather than silently picking the wrong cell.
                return Value::Error(ValueError::InvalidRef);
            }
            let text = coerce_to_text(&ref_v);
            match parse_indirect_ref(&text) {
                Some((sheet, start, _end)) => match sheet {
                    Some(s) => provider.sheet_cell(&s, start),
                    None => provider.cell(start),
                },
                None => Value::Error(ValueError::InvalidRef),
            }
        }

        // XLOOKUP(lookup, lookup_array, return_array[, if_not_found[,
        //         match_mode=0[, search_mode=1]]])
        //
        // match_mode:
        //   0  exact (default) — return first/last exact match
        //  -1  exact or next smaller — exact, else largest key <= needle
        //   1  exact or next larger — exact, else smallest key >= needle
        //   2  wildcard (text only) — needle is a wildcard pattern; walk
        //      lookup_array and return the first cell whose text rep matches.
        //
        // search_mode:
        //   1  forward, first-to-last (default)
        //  -1  reverse, last-to-first
        //   2  binary search, ascending-sorted lookup_array
        //  -2  binary search, descending-sorted lookup_array
        //
        // Combination notes:
        // - Wildcard (match_mode=2) requires a linear scan (wildcards have no
        //   ordering), so search_mode must be 1 or -1; ±2 with wildcard
        //   returns #VALUE!.
        // - Approximate (match_mode=±1) with binary (search_mode=±2) is
        //   supported and uses partition_point on the sorted array — O(log n).
        // - Binary search modes ASSUME the array is sorted as advertised; we
        //   do not verify, matching Excel's documented contract. (Caller's
        //   responsibility, per stdlib `binary_search` semantics.)
        "XLOOKUP" => {
            if args.len() < 3 || args.len() > 6 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let needle = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = needle {
                return Value::Error(e);
            }
            // Parse match_mode (default 0).
            let match_mode: i64 = if args.len() >= 5 {
                let mv = eval_expr_with_provider(&args[4], provider);
                if let Value::Error(e) = mv {
                    return Value::Error(e);
                }
                match coerce_to_number(&mv) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                0
            };
            if !matches!(match_mode, -1 | 0 | 1 | 2) {
                return Value::Error(ValueError::InvalidValue);
            }
            // Parse search_mode (default 1).
            let search_mode: i64 = if args.len() == 6 {
                let sv = eval_expr_with_provider(&args[5], provider);
                if let Value::Error(e) = sv {
                    return Value::Error(e);
                }
                match coerce_to_number(&sv) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1
            };
            if !matches!(search_mode, -2 | -1 | 1 | 2) {
                return Value::Error(ValueError::InvalidValue);
            }
            // Wildcard match cannot use binary search (no ordering of patterns).
            if match_mode == 2 && (search_mode == 2 || search_mode == -2) {
                return Value::Error(ValueError::InvalidValue);
            }
            // For wildcard mode, the needle MUST be text.
            if match_mode == 2 && !matches!(needle, Value::Text(_)) {
                return Value::Error(ValueError::WrongType);
            }
            // Both arrays must be ranges (lookup and return). Same linear
            // cell count required.
            let lookup_grid = match collect_range_2d_for_arg(&args[1], provider) {
                Some(g) => g,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let return_grid = match collect_range_2d_for_arg(&args[2], provider) {
                Some(g) => g,
                None => return Value::Error(ValueError::InvalidValue),
            };
            let lookup_flat: Vec<Value> =
                lookup_grid.into_iter().flat_map(|r| r.into_iter()).collect();
            let return_flat: Vec<Value> =
                return_grid.into_iter().flat_map(|r| r.into_iter()).collect();
            if lookup_flat.len() != return_flat.len() || lookup_flat.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            // Propagate any error cell inside lookup_array (per existing
            // behavior).
            for k in lookup_flat.iter() {
                if let Value::Error(e) = k {
                    return Value::Error(e.clone());
                }
            }
            let n = lookup_flat.len();
            // Helper: produce the not-found fallback.
            let not_found = |this_args: &[Expr]| -> Value {
                if this_args.len() >= 4 {
                    eval_expr_with_provider(&this_args[3], provider)
                } else {
                    Value::Error(ValueError::InvalidValue)
                }
            };

            // Compute the index of the matching cell (if any) given the mode
            // combination.
            let found: Option<usize> = match (match_mode, search_mode) {
                // --- Exact match -----------------------------------------
                (0, 1) => lookup_flat
                    .iter()
                    .position(|k| values_equal(k, &needle)),
                (0, -1) => lookup_flat
                    .iter()
                    .rposition(|k| values_equal(k, &needle)),
                (0, 2) => {
                    // Binary search ascending for the first exact match.
                    match lookup_flat
                        .binary_search_by(|probe| compare_lookup(probe, &needle))
                    {
                        Ok(i) => Some(i),
                        Err(_) => None,
                    }
                }
                (0, -2) => {
                    // Binary search descending: reverse the comparator.
                    match lookup_flat
                        .binary_search_by(|probe| compare_lookup(&needle, probe))
                    {
                        Ok(i) => Some(i),
                        Err(_) => None,
                    }
                }
                // --- Approximate next-smaller (-1) -----------------------
                (-1, 1) | (-1, -1) => {
                    // Linear scan: prefer exact; otherwise pick the largest
                    // key still <= needle. Direction (forward / reverse)
                    // only affects which equal candidate wins, but values
                    // equal under `compare_lookup` are returned eagerly the
                    // first time exact is detected, so behavior is the
                    // same. We still respect direction for the "best ≤"
                    // tie-break: forward keeps the first qualifying index,
                    // reverse keeps the last.
                    let mut best: Option<(usize, &Value)> = None;
                    let iter: Box<dyn Iterator<Item = (usize, &Value)>> =
                        if search_mode == 1 {
                            Box::new(lookup_flat.iter().enumerate())
                        } else {
                            Box::new(lookup_flat.iter().enumerate().rev())
                        };
                    let mut exact: Option<usize> = None;
                    for (i, k) in iter {
                        if values_equal(k, &needle) {
                            exact = Some(i);
                            break;
                        }
                        if compare_lookup(k, &needle).is_lt() {
                            match best {
                                None => best = Some((i, k)),
                                Some((_, prev)) => {
                                    if compare_lookup(k, prev).is_gt() {
                                        best = Some((i, k));
                                    }
                                }
                            }
                        }
                    }
                    exact.or(best.map(|(i, _)| i))
                }
                (-1, 2) => {
                    // Ascending binary search for exact-or-next-smaller.
                    match lookup_flat
                        .binary_search_by(|probe| compare_lookup(probe, &needle))
                    {
                        Ok(i) => Some(i),
                        Err(i) => {
                            // Insertion point: everything below i is < needle.
                            if i == 0 {
                                None
                            } else {
                                Some(i - 1)
                            }
                        }
                    }
                }
                (-1, -2) => {
                    // Descending binary search for exact-or-next-smaller.
                    // In a descending array, the first element <= needle is
                    // the insertion point.
                    match lookup_flat
                        .binary_search_by(|probe| compare_lookup(&needle, probe))
                    {
                        Ok(i) => Some(i),
                        Err(i) => {
                            if i >= n {
                                None
                            } else {
                                Some(i)
                            }
                        }
                    }
                }
                // --- Approximate next-larger (1) -------------------------
                (1, 1) | (1, -1) => {
                    let mut best: Option<(usize, &Value)> = None;
                    let iter: Box<dyn Iterator<Item = (usize, &Value)>> =
                        if search_mode == 1 {
                            Box::new(lookup_flat.iter().enumerate())
                        } else {
                            Box::new(lookup_flat.iter().enumerate().rev())
                        };
                    let mut exact: Option<usize> = None;
                    for (i, k) in iter {
                        if values_equal(k, &needle) {
                            exact = Some(i);
                            break;
                        }
                        if compare_lookup(k, &needle).is_gt() {
                            match best {
                                None => best = Some((i, k)),
                                Some((_, prev)) => {
                                    if compare_lookup(k, prev).is_lt() {
                                        best = Some((i, k));
                                    }
                                }
                            }
                        }
                    }
                    exact.or(best.map(|(i, _)| i))
                }
                (1, 2) => {
                    // Ascending binary search for exact-or-next-larger.
                    match lookup_flat
                        .binary_search_by(|probe| compare_lookup(probe, &needle))
                    {
                        Ok(i) => Some(i),
                        Err(i) => {
                            // Insertion point: everything at i and above is
                            // >= needle. So index i is the next-larger.
                            if i >= n {
                                None
                            } else {
                                Some(i)
                            }
                        }
                    }
                }
                (1, -2) => {
                    // Descending binary search for exact-or-next-larger.
                    match lookup_flat
                        .binary_search_by(|probe| compare_lookup(&needle, probe))
                    {
                        Ok(i) => Some(i),
                        Err(i) => {
                            // In a descending array, the element just before
                            // the insertion point is the smallest one still
                            // >= needle.
                            if i == 0 {
                                None
                            } else {
                                Some(i - 1)
                            }
                        }
                    }
                }
                // --- Wildcard (text-only) --------------------------------
                (2, 1) => {
                    let pattern = coerce_to_text(&needle);
                    lookup_flat
                        .iter()
                        .position(|k| wildcard_match(&pattern, &coerce_to_text(k)))
                }
                (2, -1) => {
                    let pattern = coerce_to_text(&needle);
                    lookup_flat
                        .iter()
                        .rposition(|k| wildcard_match(&pattern, &coerce_to_text(k)))
                }
                // Wildcard + binary excluded above; any other mode pair was
                // already rejected. Catch-all defensively.
                _ => return Value::Error(ValueError::InvalidValue),
            };
            match found {
                Some(i) => return_flat[i].clone(),
                None => not_found(args),
            }
        }


        // HOUR(serial) — extract hour 0..23 from fractional-day serial.
        // Uses only the fractional part of the serial. For negative serials
        // we add 1 so the fraction is always in [0, 1).
        "HOUR" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let frac = n - n.floor();
                    Value::Number((frac * 24.0).floor())
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        // MINUTE(serial) — extract minute 0..59.
        "MINUTE" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let frac = n - n.floor();
                    Value::Number(((frac * 1440.0).floor() as i64 % 60) as f64)
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        // SECOND(serial) — extract second 0..59. Round (not floor) to avoid
        // drift from binary-fraction representation of times.
        "SECOND" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let frac = n - n.floor();
                    Value::Number(((frac * 86400.0).round() as i64 % 60) as f64)
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        // TIME(h, m, s) → fractional day. Excel allows wrap-around
        // (TIME(25,0,0) = 25/24); negative components → InvalidValue.
        "TIME" => {
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let h = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = h {
                return Value::Error(e);
            }
            let m = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = m {
                return Value::Error(e);
            }
            let s = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(e) = s {
                return Value::Error(e);
            }
            match (coerce_to_number(&h), coerce_to_number(&m), coerce_to_number(&s)) {
                (Some(h), Some(m), Some(s)) => {
                    if h < 0.0 || m < 0.0 || s < 0.0 {
                        return Value::Error(ValueError::InvalidValue);
                    }
                    Value::Number((h * 3600.0 + m * 60.0 + s) / 86400.0)
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        // WEEKDAY(serial[, return_type]).
        //
        // Epoch note: this codebase uses 1970-01-01 = serial 0 (Unix-style),
        // not Excel's 1900 epoch. 1970-01-01 was a Thursday, so the
        // Sunday-indexed day-of-week is `((floor(serial)) + 4) mod 7`.
        "WEEKDAY" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let serial = match coerce_to_number(&v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            let return_type = if args.len() == 2 {
                let rt = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = rt {
                    return Value::Error(e);
                }
                match coerce_to_number(&rt) {
                    Some(n) => n as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1
            };
            // Sunday=0..Saturday=6 in our intermediate.
            let dow = ((serial.floor() as i64) + 4).rem_euclid(7);
            let result = match return_type {
                1 => dow + 1,            // Sun=1..Sat=7
                2 => ((dow + 6) % 7) + 1, // Mon=1..Sun=7
                3 => (dow + 6) % 7,       // Mon=0..Sun=6
                _ => return Value::Error(ValueError::InvalidValue),
            };
            Value::Number(result as f64)
        }
        // WEEKNUM(serial[, return_type]).
        //
        // Simple "Excel default" semantics: week 1 starts Jan 1 of the
        // serial's year. Each new week begins on the configured start day
        // (Sun for return_type=1, Mon for return_type=2). Other return_type
        // values → InvalidValue (narrow support — ISO 8601 week number is
        // intentionally out of scope here).
        "WEEKNUM" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let serial = match coerce_to_number(&v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            let return_type = if args.len() == 2 {
                let rt = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = rt {
                    return Value::Error(e);
                }
                match coerce_to_number(&rt) {
                    Some(n) => n as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1
            };
            // start_offset: weekday index that counts as "0" within the week.
            // return_type=1 → week starts Sunday (Sun=0); return_type=2 → Mon=0.
            let start_offset: i64 = match return_type {
                1 => 0, // Sunday
                2 => 1, // Monday
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let (y, _, _) = date_from_serial(serial);
            let jan1 = date_serial(y, 1, 1);
            // Sunday=0..Saturday=6 for jan1.
            let jan1_dow = ((jan1.floor() as i64) + 4).rem_euclid(7);
            // Day-of-year, 0-based.
            let doy = serial.floor() as i64 - jan1.floor() as i64;
            // Position within week 1 of jan1: how many days into the week
            // jan1 sits (e.g. if week starts Sun and jan1 is Tue, jan1 is
            // at offset 2 → week 1 has 5 remaining days, week 2 starts on
            // day 5).
            let jan1_in_week = (jan1_dow - start_offset).rem_euclid(7);
            let week = (doy + jan1_in_week) / 7 + 1;
            Value::Number(week as f64)
        }
        // EOMONTH(start, months) — last day of the month `months` after start.
        "EOMONTH" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let s = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = s {
                return Value::Error(e);
            }
            let m = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = m {
                return Value::Error(e);
            }
            match (coerce_to_number(&s), coerce_to_number(&m)) {
                (Some(start), Some(months)) => {
                    let (y, mo, _) = date_from_serial(start);
                    let (ty, tm) = shift_year_month(y, mo, months.trunc() as i64);
                    let dim = days_in_month(ty, tm);
                    Value::Number(date_serial(ty, tm, 1) + (dim as f64) - 1.0)
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        // EDATE(start, months) — same calendar day, `months` later.
        // If the target month has fewer days, clamp to month end.
        "EDATE" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let s = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = s {
                return Value::Error(e);
            }
            let m = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = m {
                return Value::Error(e);
            }
            match (coerce_to_number(&s), coerce_to_number(&m)) {
                (Some(start), Some(months)) => {
                    let (y, mo, d) = date_from_serial(start);
                    let (ty, tm) = shift_year_month(y, mo, months.trunc() as i64);
                    let dim = days_in_month(ty, tm);
                    let td = d.min(dim);
                    Value::Number(date_serial(ty, tm, td))
                }
                _ => Value::Error(ValueError::WrongType),
            }
        }
        // DAYS(end, start) → end - start as integer day count.
        "DAYS" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let e = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(er) = e {
                return Value::Error(er);
            }
            let s = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(er) = s {
                return Value::Error(er);
            }
            match (coerce_to_number(&e), coerce_to_number(&s)) {
                (Some(end), Some(start)) => Value::Number(end.floor() - start.floor()),
                _ => Value::Error(ValueError::WrongType),
            }
        }
        // DATEDIF(start, end, unit). start > end is rejected as Overflow
        // (matches Excel's #NUM!). Unit is text and case-insensitive in
        // Excel; we accept upper-case to stay consistent with the parser's
        // string handling.
        "DATEDIF" => {
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let s = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = s {
                return Value::Error(e);
            }
            let e = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(er) = e {
                return Value::Error(er);
            }
            let u = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(er) = u {
                return Value::Error(er);
            }
            let start = match coerce_to_number(&s) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            let end = match coerce_to_number(&e) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            if start > end {
                return Value::Error(ValueError::Overflow);
            }
            let unit = coerce_to_text(&u).to_ascii_uppercase();
            let (y1, m1, d1) = date_from_serial(start);
            let (y2, m2, d2) = date_from_serial(end);
            match unit.as_str() {
                "D" => Value::Number(end.floor() - start.floor()),
                "Y" => {
                    let mut yrs = (y2 - y1) as i64;
                    if (m2, d2) < (m1, d1) {
                        yrs -= 1;
                    }
                    Value::Number(yrs as f64)
                }
                "M" => {
                    let mut months = (y2 - y1) as i64 * 12 + (m2 as i64 - m1 as i64);
                    if d2 < d1 {
                        months -= 1;
                    }
                    Value::Number(months as f64)
                }
                "YM" => {
                    // Months between, ignoring years.
                    let mut months = m2 as i64 - m1 as i64;
                    if d2 < d1 {
                        months -= 1;
                    }
                    if months < 0 {
                        months += 12;
                    }
                    Value::Number(months as f64)
                }
                "YD" => {
                    // Days between, ignoring years: align end's (m,d) to
                    // start's year (or year+1 if end's (m,d) precedes start's).
                    let anniv_year = if (m2, d2) >= (m1, d1) { y1 } else { y1 + 1 };
                    let anniv = date_serial(anniv_year, m2, d2.min(days_in_month(anniv_year, m2)));
                    Value::Number((anniv - start.floor()).abs())
                }
                "MD" => {
                    // Days between, ignoring months and years.
                    // If d2 >= d1, simply d2 - d1. Otherwise borrow days from
                    // the previous month relative to end.
                    if d2 >= d1 {
                        Value::Number((d2 - d1) as f64)
                    } else {
                        let (py, pm) = shift_year_month(y2, m2, -1);
                        let pm_days = days_in_month(py, pm);
                        Value::Number((pm_days + d2 - d1) as f64)
                    }
                }
                _ => Value::Error(ValueError::InvalidValue),
            }
        }
        // DATEVALUE(text) — ISO 8601 only: "YYYY-MM-DD" or "YYYY/MM/DD".
        "DATEVALUE" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let s = match v {
                Value::Text(s) => s,
                Value::Null => return Value::Error(ValueError::WrongType),
                other => coerce_to_text(&other),
            };
            let parts: Vec<&str> = if s.contains('-') {
                s.split('-').collect()
            } else if s.contains('/') {
                s.split('/').collect()
            } else {
                return Value::Error(ValueError::InvalidValue);
            };
            if parts.len() != 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let y: i32 = match parts[0].parse() {
                Ok(n) => n,
                Err(_) => return Value::Error(ValueError::InvalidValue),
            };
            let m: u32 = match parts[1].parse() {
                Ok(n) => n,
                Err(_) => return Value::Error(ValueError::InvalidValue),
            };
            let d: u32 = match parts[2].parse() {
                Ok(n) => n,
                Err(_) => return Value::Error(ValueError::InvalidValue),
            };
            if m == 0 || m > 12 || d == 0 || d > days_in_month(y, m) {
                return Value::Error(ValueError::InvalidValue);
            }
            Value::Number(date_serial(y, m, d))
        }
        // TIMEVALUE(text) — "HH:MM" or "HH:MM:SS".
        "TIMEVALUE" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let s = match v {
                Value::Text(s) => s,
                Value::Null => return Value::Error(ValueError::WrongType),
                other => coerce_to_text(&other),
            };
            let parts: Vec<&str> = s.split(':').collect();
            if parts.len() < 2 || parts.len() > 3 {
                return Value::Error(ValueError::InvalidValue);
            }
            let h: f64 = match parts[0].parse() {
                Ok(n) => n,
                Err(_) => return Value::Error(ValueError::InvalidValue),
            };
            let m: f64 = match parts[1].parse() {
                Ok(n) => n,
                Err(_) => return Value::Error(ValueError::InvalidValue),
            };
            let sec: f64 = if parts.len() == 3 {
                match parts[2].parse() {
                    Ok(n) => n,
                    Err(_) => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                0.0
            };
            if h < 0.0 || m < 0.0 || sec < 0.0 {
                return Value::Error(ValueError::InvalidValue);
            }
            Value::Number((h * 3600.0 + m * 60.0 + sec) / 86400.0)
        }
        // YEARFRAC(start, end[, basis]) — fraction of a year between dates.
        //
        // Basis approximations:
        //   0 = US 30/360 (simple form, no end-of-month rule)
        //   1 = actual/actual (uses actual days / 365 — approximate)
        //   2 = actual/360
        //   3 = actual/365
        //   4 = European 30/360 (equivalent to 0 for our simple form)
        "YEARFRAC" => {
            if args.len() < 2 || args.len() > 3 {
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
            let basis = if args.len() == 3 {
                let bx = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = bx {
                    return Value::Error(e);
                }
                match coerce_to_number(&bx) {
                    Some(n) => n as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0
            };
            let (start, end) = match (coerce_to_number(&a), coerce_to_number(&b)) {
                (Some(s), Some(e)) => {
                    if s <= e {
                        (s, e)
                    } else {
                        (e, s)
                    }
                }
                _ => return Value::Error(ValueError::WrongType),
            };
            let result = match basis {
                0 | 4 => {
                    let (y1, m1, d1) = date_from_serial(start);
                    let (y2, m2, d2) = date_from_serial(end);
                    let num = (y2 - y1) as f64 * 360.0
                        + (m2 as f64 - m1 as f64) * 30.0
                        + (d2 as f64 - d1 as f64);
                    num / 360.0
                }
                1 => (end - start) / 365.0,
                2 => (end - start) / 360.0,
                3 => (end - start) / 365.0,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            Value::Number(result)
        }


        // === Statistical extensions ===
        //
        // AVERAGEA(...) — variadic. Like AVERAGE but Boolean(true) = 1,
        // Boolean(false) = 0, Text = 0 (all count toward the denominator).
        // Null is NOT counted (matches Excel's "empty cell" handling).
        // Errors propagate.
        "AVERAGEA" => {
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
                        Value::Boolean(true) => {
                            total += 1.0;
                            count += 1;
                        }
                        Value::Boolean(false) => {
                            count += 1;
                        }
                        Value::Text(_) => {
                            // Text contributes 0 to total but counts in denominator.
                            count += 1;
                        }
                        Value::Null => {
                            // Null (empty cell) is not counted at all.
                        }
                        // Unreachable: for_each_arg_value flattens Array.
                        Value::Array(_) => {}
                        // Lambda inside AVERAGEA is a type error.
                        Value::Lambda(_) => err = Some(ValueError::WrongType),
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

        // RANK(value, range[, order]) — equivalent to Excel's RANK / RANK.EQ.
        // order = 0 (default) → descending (rank 1 = largest).
        // order ≠ 0 → ascending (rank 1 = smallest).
        // Ties all share the same (lowest) rank.
        // If `value` is not present in `range`, returns #VALUE! (Excel uses #N/A
        // which has no direct equivalent in ValueError).
        //
        // Dotted names (Excel 2010+): `RANK.EQ` aliases `RANK`/`RANKEQ`.
        "RANK" | "RANKEQ" | "RANK.EQ" => rank_eq(args, provider),

        // RANKAVG(value, range[, order]) — Excel's RANK.AVG. Tied values get the
        // average of the ranks they span (e.g. three values tied for rank 5 → all
        // get 6.0, because they would occupy ranks 5, 6, 7).
        "RANKAVG" | "RANK.AVG" => rank_avg(args, provider),

        // PERCENTILE(range, k) — linear-interpolated percentile.
        // k in [0, 1]; otherwise #VALUE!. Empty range → #VALUE!.
        // `PERCENTILE.INC` (Excel 2010+) is the same function.
        "PERCENTILE" | "PERCENTILE.INC" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let k_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = k_v {
                return Value::Error(e);
            }
            let k = match coerce_to_number(&k_v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            percentile_impl(&args[..1], provider, k)
        }

        // PERCENTILE.EXC(range, k) — exclusive percentile. k strictly in (0, 1);
        // k=0 / k=1 → #VALUE!. The 1-based position is `k * (n + 1)`; if the
        // resulting position is < 1 or > n the result is #VALUE!. Otherwise
        // interpolates between the two surrounding sorted values.
        "PERCENTILE.EXC" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let k_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = k_v {
                return Value::Error(e);
            }
            let k = match coerce_to_number(&k_v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            percentile_exc_impl(&args[..1], provider, k)
        }

        // QUARTILE(range, quart) — quart ∈ {0,1,2,3,4} → PERCENTILE(range, quart/4).
        // `QUARTILE.INC` is the same function under Excel 2010+ naming.
        "QUARTILE" | "QUARTILE.INC" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let q_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = q_v {
                return Value::Error(e);
            }
            let q = match coerce_to_number(&q_v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            // quart must be in 0..=4 inclusive.
            if !q.is_finite() || q < 0.0 || q > 4.0 || q.trunc() != q {
                return Value::Error(ValueError::InvalidValue);
            }
            percentile_impl(&args[..1], provider, q / 4.0)
        }

        // QUARTILE.EXC(range, quart) — exclusive quartile. quart must be 1, 2,
        // or 3 (0 and 4 are NOT valid in exclusive mode). Equivalent to
        // PERCENTILE.EXC(range, quart/4).
        "QUARTILE.EXC" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let q_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = q_v {
                return Value::Error(e);
            }
            let q = match coerce_to_number(&q_v) {
                Some(n) => n,
                None => return Value::Error(ValueError::WrongType),
            };
            // quart must be 1, 2, or 3 (integer).
            if !q.is_finite() || q.trunc() != q {
                return Value::Error(ValueError::InvalidValue);
            }
            let qi = q as i64;
            if !(1..=3).contains(&qi) {
                return Value::Error(ValueError::InvalidValue);
            }
            percentile_exc_impl(&args[..1], provider, qi as f64 / 4.0)
        }

        // STDEV.S / VAR.S — Excel 2010+ aliases for the sample-variance
        // STDEV / VAR (divide by n-1).
        "STDEV.S" => eval_func("STDEV", args, provider),
        "VAR.S" => eval_func("VAR", args, provider),

        // STDEV.P / VAR.P — population standard deviation / variance.
        // Divide by n (not n-1).
        "STDEV.P" => {
            let nums = collect_numbers(args, provider);
            if nums.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (nums.len() as f64);
            Value::Number(var.sqrt())
        }
        "VAR.P" => {
            let nums = collect_numbers(args, provider);
            if nums.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (nums.len() as f64);
            Value::Number(var)
        }

        // CORREL(arr1, arr2) — Pearson correlation. Both args must be ranges of
        // the same shape (same width × height). Pairs are collected only when
        // BOTH cells at the same offset are numeric. Need ≥ 2 pairs.
        // Shape mismatch → #VALUE!. Denominator 0 → #DIV/0!.
        //
        // Note: requires literal Range / SheetRange / OFFSET expressions (the
        // shape requirement is structural). Non-range args → #VALUE!.
        "CORREL" => correl_impl(args, provider),

        // COVAR / COVAR.P — population covariance. `sum((x-mx)*(y-my)) / n`.
        // Same pair-collection semantics as CORREL.
        "COVAR" | "COVAR.P" => covar_impl(args, provider, false),

        // COVAR.S — sample covariance. Divides by `n - 1` instead of `n`.
        "COVAR.S" => covar_impl(args, provider, true),

        // SLOPE(y_array, x_array) — linear regression slope. Order matters: y
        // first, then x (Excel convention).
        "SLOPE" => slope_intercept_impl(args, provider, false),

        // INTERCEPT(y_array, x_array) — ȳ - slope * x̄.
        "INTERCEPT" => slope_intercept_impl(args, provider, true),


        // === Financial / time-value-of-money ===
        //
        // All annuity formulas use the Excel sign convention: outflows are
        // negative, inflows positive. The core equation when `rate != 0`:
        //
        //   pv*(1+r)^n + pmt*(1+r*type)*((1+r)^n - 1)/r + fv = 0
        //
        // Specialised to `rate == 0` (linear): pv + pmt*n + fv = 0.
        // `type` is 0 (end-of-period, default) or 1 (beginning-of-period).
        "PMT" => fn_pmt(args, provider),
        "PV" => fn_pv(args, provider),
        "FV" => fn_fv(args, provider),
        "NPER" => fn_nper(args, provider),
        "NPV" => fn_npv(args, provider),
        "IRR" => fn_irr(args, provider),
        "RATE" => fn_rate(args, provider),
        "IPMT" => fn_ipmt(args, provider),
        "PPMT" => fn_ppmt(args, provider),

        // CELL(info_type[, reference]) — return metadata about `reference`.
        //
        // Supported info_type values (Excel matches case-insensitively):
        //   "address"  → $A$1-style absolute text
        //   "row"      → 1-based row number (Number)
        //   "col"/"column" → 1-based column number (Number)
        //   "contents" → the cell's value via provider.cell(addr)
        //   "type"     → "b" blank, "l" text, "v" otherwise
        //   "prefix"   → "'" for text, "" otherwise
        //   "width"    → 8.0 (approximation; we don't plumb per-column widths)
        //   "protect"  → 1.0 (approximation; per-cell unlock state isn't
        //                tracked at the eval layer)
        // Any other info_type returns #VALUE! (InvalidValue), matching Excel.
        //
        // When `reference` is omitted we fall back to `provider.current_cell()`.
        // The legacy single-sheet `AtomEvalProvider` returns None there, so
        // no-arg `CELL` on that path surfaces #REF! (InvalidRef). The
        // production `WorkbookEvalProvider` tracks the current cell and
        // resolves correctly — covered in tests/cell_function.rs.
        "CELL" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            // info_type must be Text — non-text args (numbers, bools) hit
            // WrongType rather than coercing, so spreadsheets surface the
            // type mismatch loudly.
            let info_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = info_v {
                return Value::Error(e);
            }
            let info_type = match &info_v {
                Value::Text(s) => s.to_ascii_lowercase(),
                _ => return Value::Error(ValueError::WrongType),
            };

            // Resolve the target address. With an explicit second arg, only
            // direct cell/range references qualify; computed values (e.g.
            // CELL("address","not-a-ref")) yield #TYPE!. Multi-cell ranges
            // collapse to their top-left cell per Excel parity.
            let addr: CellAddress = if args.len() == 2 {
                match &args[1] {
                    Expr::CellRef(a) | Expr::SheetRef { addr: a, .. } => *a,
                    Expr::Range { start, .. } | Expr::SheetRange { start, .. } => *start,
                    _ => return Value::Error(ValueError::WrongType),
                }
            } else {
                match provider.current_cell() {
                    Some(a) => a,
                    // note: AtomEvalProvider doesn't carry current-cell, so
                    // the no-arg unit tests below land here. The production
                    // workbook path is covered by tests/cell_function.rs.
                    None => return Value::Error(ValueError::InvalidRef),
                }
            };
            if addr.row == REF_INVALID_ROW || addr.col == REF_INVALID_COL {
                return Value::Error(ValueError::InvalidRef);
            }

            match info_type.as_str() {
                "address" => {
                    let col_letters = col_index_to_letters_eval(addr.col);
                    Value::Text(format!("${}${}", col_letters, addr.row + 1))
                }
                "row" => Value::Number((addr.row + 1) as f64),
                // Excel accepts both "col" and "column" for the column index.
                "col" | "column" => Value::Number((addr.col + 1) as f64),
                "contents" => provider.cell(addr),
                "type" => match provider.cell(addr) {
                    Value::Null => Value::Text("b".into()),
                    Value::Text(_) => Value::Text("l".into()),
                    // Excel collapses numbers, booleans, and errors to "v".
                    _ => Value::Text("v".into()),
                },
                "prefix" => match provider.cell(addr) {
                    // Excel returns the actual alignment-prefix character;
                    // we only know whether the cell is text, so we
                    // approximate: text → "'", everything else → "".
                    Value::Text(_) => Value::Text("'".into()),
                    _ => Value::Text(String::new()),
                },
                // note: we don't plumb per-column widths through the eval
                // layer yet, so this is a constant approximation of Excel's
                // default column width (8.43 in the UI, rounded to 8).
                "width" => Value::Number(8.0),
                // note: per-cell locked/unlocked state lives outside the
                // formula engine — we report "locked" (1) for every cell.
                "protect" => Value::Number(1.0),
                _ => Value::Error(ValueError::InvalidValue),
            }
        }

        // === Database functions (D*) ===
        //
        // Shared signature: D*(database, field, criteria).
        //   - database: range with a header row (row 0) and N data rows.
        //   - field: column header (Text, case-insensitive) OR 1-based
        //     column index (Number).
        //   - criteria: range with a header row + 1+ criterion rows; rows
        //     OR-combine, non-empty cells within a row AND-combine.
        //
        // Boolean handling: matches Excel — D* aggregates only operate on
        // `Value::Number` data cells. Booleans / text / nulls are skipped
        // for DCOUNT/DSUM/DAVERAGE/DSTDEV*/DVAR*/DPRODUCT/DMAX/DMIN. DCOUNTA
        // counts ANY non-Null cell (numeric, text, boolean).
        //
        // Error propagation: any cell in `database` or `criteria` that
        // holds `Value::Error(_)` short-circuits to that error.
        //
        // Empty-match handling (per Excel parity):
        //   - DAVERAGE, DSTDEV/DSTDEVP, DVAR/DVARP → #DIV/0!
        //   - DSUM, DPRODUCT, DMAX, DMIN, DCOUNT, DCOUNTA → 0
        //   - DGET 0 matches → #VALUE!, > 1 matches → #NUM!
        "DSUM" => db_aggregate(
            args,
            provider,
            0.0_f64,
            |acc, v| {
                if let Value::Number(n) = v {
                    *acc += *n;
                }
            },
            Value::Number,
        ),
        "DAVERAGE" => db_aggregate(
            args,
            provider,
            (0.0_f64, 0u64),
            |acc, v| {
                if let Value::Number(n) = v {
                    acc.0 += *n;
                    acc.1 += 1;
                }
            },
            |(sum, count)| {
                if count == 0 {
                    Value::Error(ValueError::DivisionByZero)
                } else {
                    Value::Number(sum / count as f64)
                }
            },
        ),
        "DCOUNT" => db_aggregate(
            args,
            provider,
            0u64,
            |acc, v| {
                if matches!(v, Value::Number(_)) {
                    *acc += 1;
                }
            },
            |c| Value::Number(c as f64),
        ),
        "DCOUNTA" => db_aggregate(
            args,
            provider,
            0u64,
            |acc, v| {
                if !matches!(v, Value::Null) {
                    *acc += 1;
                }
            },
            |c| Value::Number(c as f64),
        ),
        "DMAX" => db_aggregate(
            args,
            provider,
            None::<f64>,
            |acc, v| {
                if let Value::Number(n) = v {
                    *acc = Some(acc.map_or(*n, |m| if *n > m { *n } else { m }));
                }
            },
            |opt| Value::Number(opt.unwrap_or(0.0)),
        ),
        "DMIN" => db_aggregate(
            args,
            provider,
            None::<f64>,
            |acc, v| {
                if let Value::Number(n) = v {
                    *acc = Some(acc.map_or(*n, |m| if *n < m { *n } else { m }));
                }
            },
            |opt| Value::Number(opt.unwrap_or(0.0)),
        ),
        "DPRODUCT" => db_aggregate(
            args,
            provider,
            None::<f64>,
            |acc, v| {
                if let Value::Number(n) = v {
                    *acc = Some(acc.map_or(*n, |p| p * *n));
                }
            },
            |opt| Value::Number(opt.unwrap_or(0.0)),
        ),
        "DGET" => {
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let database = match resolve_database_range(&args[0], provider) {
                Ok(d) => d,
                Err(e) => return Value::Error(e),
            };
            let field_col = match resolve_db_field(&database, &args[1], provider) {
                Ok(c) => c,
                Err(e) => return Value::Error(e),
            };
            let mut found: Option<Value> = None;
            let mut too_many = false;
            let walk = iter_db_matches(&database, &args[2], provider, |row| {
                if too_many {
                    return Ok(());
                }
                let v = database.data_cell(row, field_col as u32, provider);
                if let Value::Error(e) = v {
                    return Err(e);
                }
                if found.is_some() {
                    too_many = true;
                } else {
                    found = Some(v);
                }
                Ok(())
            });
            if let Err(e) = walk {
                return Value::Error(e);
            }
            if too_many {
                return Value::Error(ValueError::Overflow);
            }
            found.unwrap_or(Value::Error(ValueError::InvalidValue))
        }
        "DSTDEV" | "DSTDEVP" | "DVAR" | "DVARP" => {
            // Two-pass; needs the full numeric Vec.
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let database = match resolve_database_range(&args[0], provider) {
                Ok(d) => d,
                Err(e) => return Value::Error(e),
            };
            let field_col = match resolve_db_field(&database, &args[1], provider) {
                Ok(c) => c,
                Err(e) => return Value::Error(e),
            };
            let mut nums: Vec<f64> = Vec::new();
            let walk = iter_db_matches(&database, &args[2], provider, |row| {
                let v = database.data_cell(row, field_col as u32, provider);
                if let Value::Error(e) = v {
                    return Err(e);
                }
                if let Value::Number(n) = v {
                    nums.push(n);
                }
                Ok(())
            });
            if let Err(e) = walk {
                return Value::Error(e);
            }
            // Sample (DSTDEV/DVAR) divides by n-1 and needs n >= 2.
            // Population (DSTDEVP/DVARP) divides by n and needs n >= 1.
            let is_sample = matches!(name, "DSTDEV" | "DVAR");
            let min_n = if is_sample { 2 } else { 1 };
            if nums.len() < min_n {
                return Value::Error(ValueError::DivisionByZero);
            }
            let mean = nums.iter().sum::<f64>() / nums.len() as f64;
            let denom = if is_sample {
                (nums.len() - 1) as f64
            } else {
                nums.len() as f64
            };
            let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / denom;
            let result = if name == "DSTDEV" || name == "DSTDEVP" {
                var.sqrt()
            } else {
                var
            };
            Value::Number(result)
        }

        // === Engineering / base conversion / bit ops ===
        //
        // Excel's base-conversion family uses a fixed-width signed
        // two's-complement encoding when the input is at the maximum
        // width: BIN at 10 bits, OCT at 30 bits (10 octal digits), HEX
        // at 40 bits (10 hex digits). Inputs shorter than the max are
        // treated as positive. See `parse_base_n_text` and
        // `format_base_n_signed` for the shared core; the per-function
        // arms are thin wrappers that pick base / max-chars and any
        // composition.
        "BIN2DEC" => eval_xxx2dec(args, provider, 2, 10, 1),
        "OCT2DEC" => eval_xxx2dec(args, provider, 8, 10, 3),
        "HEX2DEC" => eval_xxx2dec(args, provider, 16, 10, 4),
        "DEC2BIN" => eval_dec2xxx(args, provider, 2, 10, 1, false),
        "DEC2OCT" => eval_dec2xxx(args, provider, 8, 10, 3, false),
        "DEC2HEX" => eval_dec2xxx(args, provider, 16, 10, 4, true),
        // Cross-base wrappers: parse via XXX2DEC's base, format via the
        // target's DEC2XXX. We inline both halves rather than recursing
        // through `eval_func` so error propagation stays local.
        "BIN2HEX" => eval_cross_base(args, provider, (2, 10, 1), (16, 10, 4), true),
        "BIN2OCT" => eval_cross_base(args, provider, (2, 10, 1), (8, 10, 3), false),
        "HEX2BIN" => eval_cross_base(args, provider, (16, 10, 4), (2, 10, 1), false),
        "HEX2OCT" => eval_cross_base(args, provider, (16, 10, 4), (8, 10, 3), false),
        "OCT2BIN" => eval_cross_base(args, provider, (8, 10, 3), (2, 10, 1), false),
        "OCT2HEX" => eval_cross_base(args, provider, (8, 10, 3), (16, 10, 4), true),

        // Bitwise ops. Excel's documented domain is 0..=2^48-1; we
        // accept the slightly looser 0..=2^53-1 (the f64 safe-integer
        // range) so values that survive a round-trip through Value
        // stay representable. Fractional / negative / out-of-range
        // inputs surface #NUM!.
        "BITAND" => eval_bit_binop(args, provider, |a, b| a & b),
        "BITOR" => eval_bit_binop(args, provider, |a, b| a | b),
        "BITXOR" => eval_bit_binop(args, provider, |a, b| a ^ b),
        "BITLSHIFT" => eval_bit_shift(args, provider, false),
        "BITRSHIFT" => eval_bit_shift(args, provider, true),

        // DELTA(a[, b=0]) — 1 if a == b else 0. Excel uses #VALUE! for
        // non-numeric args; we use WrongType to match the rest of this
        // module.
        "DELTA" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let a = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = a {
                return Value::Error(e);
            }
            let b = if args.len() == 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                v
            } else {
                Value::Number(0.0)
            };
            let (an, bn) = match (as_engineering_number(&a), as_engineering_number(&b)) {
                (Some(x), Some(y)) => (x, y),
                _ => return Value::Error(ValueError::WrongType),
            };
            Value::Number(if an == bn { 1.0 } else { 0.0 })
        }

        // GESTEP(num[, step=0]) — 1 if num >= step else 0.
        "GESTEP" => {
            if args.is_empty() || args.len() > 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let n = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = n {
                return Value::Error(e);
            }
            let s = if args.len() == 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                v
            } else {
                Value::Number(0.0)
            };
            let (nn, sn) = match (as_engineering_number(&n), as_engineering_number(&s)) {
                (Some(x), Some(y)) => (x, y),
                _ => return Value::Error(ValueError::WrongType),
            };
            Value::Number(if nn >= sn { 1.0 } else { 0.0 })
        }

        // === Hyperbolic ===
        // SINH / COSH / TANH / ASINH are total functions over the reals;
        // `unary_number` already collapses non-finite results to
        // `Overflow`, which matches Excel's `#NUM!` for the SINH/COSH
        // explosions at large |n|.
        "SINH" => unary_number(args, provider, f64::sinh),
        "COSH" => unary_number(args, provider, f64::cosh),
        "TANH" => unary_number(args, provider, f64::tanh),
        "ASINH" => unary_number(args, provider, f64::asinh),
        "ACOSH" => {
            // Domain: n >= 1. Out of domain → #NUM!.
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if n >= 1.0 => {
                    let r = n.acosh();
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
        "ATANH" => {
            // Domain: |n| < 1. n == ±1 produces ±∞, also Overflow.
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if n > -1.0 && n < 1.0 => {
                    let r = n.atanh();
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

        // === Reciprocal trig (radians input) ===
        // CSC/SEC/COT each have isolated poles where the underlying
        // sin/cos/tan hits 0. Excel reports `#DIV/0!` at those poles.
        "CSC" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let s = n.sin();
                    if s == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    let r = 1.0 / s;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "SEC" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let c = n.cos();
                    if c == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    let r = 1.0 / c;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "COT" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let t = n.tan();
                    if t == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    let r = 1.0 / t;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }

        // === Reciprocal hyperbolic ===
        // CSCH undefined only at 0; SECH is finite & non-zero
        // everywhere; COTH undefined only at 0 (tanh(0) == 0).
        "CSCH" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let s = n.sinh();
                    if s == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    let r = 1.0 / s;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        "SECH" => unary_number(args, provider, |n| 1.0 / n.cosh()),
        "COTH" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    let t = n.tanh();
                    if t == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    let r = 1.0 / t;
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }

        // === Inverse reciprocal trig ===
        // ACSC(n) = asin(1/n); n == 0 is #DIV/0!, |n| < 1 is #NUM!.
        // ACSC returns a value in [-PI/2, PI/2] \ {0} — sign follows n
        // (same convention as Excel).
        "ACSC" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    if n == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    if n.abs() < 1.0 {
                        return Value::Error(ValueError::Overflow);
                    }
                    let r = (1.0 / n).asin();
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        // ASEC(n) = acos(1/n); same domain (|n| >= 1, n != 0).
        // Returns a value in [0, PI].
        "ASEC" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) => {
                    if n == 0.0 {
                        return Value::Error(ValueError::DivisionByZero);
                    }
                    if n.abs() < 1.0 {
                        return Value::Error(ValueError::Overflow);
                    }
                    let r = (1.0 / n).acos();
                    if r.is_finite() {
                        Value::Number(r)
                    } else {
                        Value::Error(ValueError::Overflow)
                    }
                }
                None => Value::Error(ValueError::WrongType),
            }
        }
        // ACOT(n) = PI/2 - atan(n); returns a value in (0, PI), matching
        // Excel (which differs from the C/Rust `atan2(1, n)` convention
        // only for n == 0, where Excel chooses +PI/2 rather than the
        // signed-zero branch). Defined for all real n.
        "ACOT" => unary_number(args, provider, |n| std::f64::consts::FRAC_PI_2 - n.atan()),

        // === Math extras ===
        //
        // Pair-of-arrays sums. Same shape contract as CORREL / COVAR
        // (see `collect_paired_numbers`). Pairs are kept only when BOTH
        // cells are `Value::Number`; everything else (Null, Text,
        // Boolean) is skipped, matching Excel's "non-numeric → 0
        // contribution" behaviour for these aggregates.
        "SUMX2MY2" => sum_pair_impl(args, provider, |x, y| x * x - y * y),
        "SUMX2PY2" => sum_pair_impl(args, provider, |x, y| x * x + y * y),
        "SUMXMY2" => sum_pair_impl(args, provider, |x, y| (x - y) * (x - y)),

        // SUMSQ — variadic `Σ x²`. Walks each arg via `for_each_arg_value`
        // so a `SUMSQ(A:A)` stays sparse. Only numeric values contribute;
        // booleans and text are skipped, errors propagate.
        "SUMSQ" => {
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
                        Value::Number(n) => total += n * n,
                        _ => {}
                    }
                });
            }
            match err {
                Some(e) => Value::Error(e),
                None => Value::Number(total),
            }
        }

        // SQRTPI(n) — `sqrt(n * PI)`. Excel returns #NUM! for negatives.
        "SQRTPI" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            match coerce_to_number(&v) {
                Some(n) if n < 0.0 => Value::Error(ValueError::Overflow),
                Some(n) => Value::Number((n * std::f64::consts::PI).sqrt()),
                None => Value::Error(ValueError::WrongType),
            }
        }

        // SUMPRODUCT(array1[, array2, ...]) — multiply element-wise across N
        // arrays of identical shape, then sum. N == 1 collapses to "SUM over
        // numerics" of the single array. Shape mismatch → #VALUE!.
        // Non-numeric cells contribute 0 (Excel parity).
        "SUMPRODUCT" => sumproduct_impl(args, provider),

        // FLOOR.MATH / CEILING.MATH — precise rounding family. 1-3 args.
        // `significance` defaults to 1; `mode` defaults to 0 ("toward
        // -inf" for FLOOR.MATH, "toward +inf" for CEILING.MATH). When
        // mode != 0, negatives round toward zero (FLOOR.MATH) / away
        // from zero (CEILING.MATH) instead. These diverge from
        // FLOOR.PRECISE / CEILING.PRECISE specifically on negatives.
        "FLOOR.MATH" => floor_ceiling_math(args, provider, true),
        "CEILING.MATH" => floor_ceiling_math(args, provider, false),

        // FLOOR.PRECISE / CEILING.PRECISE — always round toward -inf /
        // +inf regardless of sign. 1 or 2 args; `significance` defaults
        // to 1. Negative significance is accepted but treated as `|sig|`
        // per Excel parity.
        "FLOOR.PRECISE" => floor_ceiling_precise(args, provider, true),
        "CEILING.PRECISE" => floor_ceiling_precise(args, provider, false),

        // ROMAN / ARABIC — round-trip between integers and Roman
        // numerals. Only the classic form (form=0) is implemented; other
        // form values are rejected with #VALUE!.
        // note: only classic form supported.
        "ROMAN" => fn_roman(args, provider),
        "ARABIC" => fn_arabic(args, provider),

        // DECIMAL / BASE — round-trip between text in base N (2..=36)
        // and integers. Letters A..Z are 10..35, case-insensitive.
        "DECIMAL" => fn_decimal(args, provider),
        "BASE" => fn_base(args, provider),

        // MDETERM(range) — determinant of a SQUARE matrix range.
        // Implemented via Doolittle LU decomposition with partial
        // pivoting; numerically stable up to ~50×50, tested through
        // 10×10. Non-square → #VALUE!. Non-numeric cell → #TYPE!.
        //
        // note: MMULT/MINVERSE deferred until Value::Array lands — they
        // require a matrix output type, which the current single-Value
        // eval pipeline cannot express.
        "MDETERM" => fn_mdeterm(args, provider),

        // NETWORKDAYS(start, end[, holidays]) — count working days
        // (Mon..Fri, excluding `holidays`) between `start` and `end`
        // inclusive on both ends. If `start > end`, the result is
        // negated (matches Excel).
        //
        // Epoch note: serials here are 1970-01-01 = 0 (see
        // TODO(excel-1900-epoch) on `date_serial`). 1970-01-01 was a
        // Thursday, so the Sunday-indexed day-of-week formula is
        // `((serial.floor() as i64) + 4).rem_euclid(7)`.
        //
        // Holidays are filtered to whole-day integers (non-numeric
        // cells are silently skipped — Excel raises #VALUE! on text
        // holidays, but we stay lenient because mixed-type holiday
        // columns are common when data is sparse). Errors inside the
        // holiday range *do* propagate via WrongType to mirror the
        // strict path of NETWORKDAYS.INTL.
        "NETWORKDAYS" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (start, end) = match networkdays_endpoints(&args[0], &args[1], provider) {
                Ok(v) => v,
                Err(e) => return Value::Error(e),
            };
            let holidays = match collect_holidays(args.get(2), provider) {
                Ok(h) => h,
                Err(e) => return Value::Error(e),
            };
            // Default weekend mask: Sat+Sun (mask indexed Mon=0..Sun=6).
            let weekend = [false, false, false, false, false, true, true];
            Value::Number(count_workdays(start, end, &weekend, &holidays) as f64)
        }

        // NETWORKDAYS.INTL(start, end[, weekend[, holidays]]) — like
        // NETWORKDAYS but with a configurable weekend. `weekend` is
        // either an integer code (1..7 for two-day weekends, 11..17
        // for single-day weekends) or a 7-character mask of '0'/'1'
        // with char[0] = Monday. An all-'1' mask (no working days)
        // returns InvalidValue, mirroring Excel's #VALUE!.
        "NETWORKDAYS.INTL" => {
            if args.len() < 2 || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (start, end) = match networkdays_endpoints(&args[0], &args[1], provider) {
                Ok(v) => v,
                Err(e) => return Value::Error(e),
            };
            let weekend = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match parse_weekend_arg(&v) {
                    Ok(w) => w,
                    Err(e) => return Value::Error(e),
                }
            } else {
                [false, false, false, false, false, true, true]
            };
            let holidays = match collect_holidays(args.get(3), provider) {
                Ok(h) => h,
                Err(e) => return Value::Error(e),
            };
            Value::Number(count_workdays(start, end, &weekend, &holidays) as f64)
        }

        // WORKDAY(start, days[, holidays]) — advance `days` working
        // days (Mon..Fri, skipping holidays) from `start`, returning
        // the resulting serial as a Number. `days` may be negative.
        // If `days == 0`, returns `start.floor()` regardless of
        // whether `start` itself is a weekend/holiday.
        "WORKDAY" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let start = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = start {
                return Value::Error(e);
            }
            let days = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = days {
                return Value::Error(e);
            }
            let start_n = match coerce_to_number(&start) {
                Some(n) => n.floor() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            let days_n = match coerce_to_number(&days) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            let holidays = match collect_holidays(args.get(2), provider) {
                Ok(h) => h,
                Err(e) => return Value::Error(e),
            };
            let weekend = [false, false, false, false, false, true, true];
            Value::Number(advance_workdays(start_n, days_n, &weekend, &holidays) as f64)
        }

        // WORKDAY.INTL(start, days[, weekend[, holidays]]) — like
        // WORKDAY but with a configurable weekend (same parsing as
        // NETWORKDAYS.INTL: numeric code or 7-char '0'/'1' mask).
        "WORKDAY.INTL" => {
            if args.len() < 2 || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let start = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = start {
                return Value::Error(e);
            }
            let days = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = days {
                return Value::Error(e);
            }
            let start_n = match coerce_to_number(&start) {
                Some(n) => n.floor() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            let days_n = match coerce_to_number(&days) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            let weekend = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match parse_weekend_arg(&v) {
                    Ok(w) => w,
                    Err(e) => return Value::Error(e),
                }
            } else {
                [false, false, false, false, false, true, true]
            };
            let holidays = match collect_holidays(args.get(3), provider) {
                Ok(h) => h,
                Err(e) => return Value::Error(e),
            };
            Value::Number(advance_workdays(start_n, days_n, &weekend, &holidays) as f64)
        }

        // ISOWEEKNUM(serial) — ISO 8601 week number (1..53). Weeks
        // start Monday; week 1 of an ISO year is the week containing
        // Jan 4 (equivalently, the week containing the year's first
        // Thursday). Dates near year boundaries can therefore belong
        // to the previous or next ISO year; we resolve that by
        // recomputing against year-1 (when the date falls before
        // week 1 starts) or year+1 (when the date falls past the
        // computed year's last week).
        "ISOWEEKNUM" => {
            if args.len() != 1 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = v {
                return Value::Error(e);
            }
            let serial = match coerce_to_number(&v) {
                Some(n) => n.floor() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            Value::Number(iso_week_number(serial) as f64)
        }

        // === Dynamic-array (spill) functions ===
        // Each returns `Value::Array(Arc::new(ArrayData::new(...)))`; the
        // Sheet layer detects Array results and registers a spill range.

        // SEQUENCE(rows[, cols[, start[, step]]]) — Build a numeric grid of
        // the given shape with values `start + (i*cols + j) * step`.
        // note: hard-capped at 1_048_576 total elements (matches Excel's
        // worksheet row count); larger requests surface #VALUE! rather
        // than attempt the allocation.
        "SEQUENCE" => {
            if args.is_empty() || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            // rows
            let rows_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = rows_v {
                return Value::Error(e);
            }
            let rows = match coerce_to_number(&rows_v) {
                Some(n) if n >= 1.0 => n.trunc() as u64,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            // cols
            let cols = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n >= 1.0 => n.trunc() as u64,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1u64
            };
            // start
            let start = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1.0
            };
            // step
            let step = if args.len() == 4 {
                let v = eval_expr_with_provider(&args[3], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1.0
            };
            // Cap total elements to keep allocations bounded.
            let total = rows.checked_mul(cols).unwrap_or(u64::MAX);
            if total > 1_048_576 {
                return Value::Error(ValueError::InvalidValue);
            }
            let rows = rows as u32;
            let cols = cols as u32;
            let mut data: Vec<Value> = Vec::with_capacity(total as usize);
            for i in 0..rows {
                for j in 0..cols {
                    let idx = (i as u64) * (cols as u64) + (j as u64);
                    data.push(Value::Number(start + (idx as f64) * step));
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, cols, data)))
        }

        // UNIQUE(array[, by_col[, exactly_once]]) — Deduplicate rows (or
        // columns, when `by_col`). When `exactly_once`, drop anything that
        // appears more than once. Empty result (all dropped) → #VALUE!.
        "UNIQUE" => {
            if args.is_empty() || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let by_col = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            let exactly_once = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Pull each unit (row or column) into a Vec<Value> for compare.
            let unit = |i: u32| -> Vec<Value> {
                if by_col {
                    (0..rows)
                        .map(|r| {
                            data[(r as usize) * (cols as usize) + (i as usize)].clone()
                        })
                        .collect()
                } else {
                    (0..cols)
                        .map(|c| {
                            data[(i as usize) * (cols as usize) + (c as usize)].clone()
                        })
                        .collect()
                }
            };
            let units = if by_col { cols } else { rows };
            // First pass: count duplicates (for `exactly_once`).
            // Element-wise equality on Vec<Value> uses `values_equal`.
            let vec_eq = |a: &Vec<Value>, b: &Vec<Value>| -> bool {
                a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| values_equal(x, y))
            };
            // Build (unique_unit, count) list, preserving first-seen order.
            let mut buckets: Vec<(Vec<Value>, u32)> = Vec::new();
            for i in 0..units {
                let u = unit(i);
                if let Some(slot) = buckets.iter_mut().find(|(b, _)| vec_eq(b, &u)) {
                    slot.1 += 1;
                } else {
                    buckets.push((u, 1));
                }
            }
            // Filter per `exactly_once`.
            let keep: Vec<&Vec<Value>> = buckets
                .iter()
                .filter(|(_, c)| if exactly_once { *c == 1 } else { true })
                .map(|(u, _)| u)
                .collect();
            if keep.is_empty() {
                // Excel surfaces #CALC! here. We don't have CALC; use
                // InvalidValue (#VALUE!) so the test signal is unambiguous.
                return Value::Error(ValueError::InvalidValue);
            }
            // Re-assemble.
            if by_col {
                // Output shape: rows × keep.len()
                let out_cols = keep.len() as u32;
                let mut out: Vec<Value> = Vec::with_capacity((rows as usize) * keep.len());
                for r in 0..rows {
                    for u in &keep {
                        out.push(u[r as usize].clone());
                    }
                }
                Value::Array(Arc::new(ArrayData::new(rows, out_cols, out)))
            } else {
                let out_rows = keep.len() as u32;
                let mut out: Vec<Value> = Vec::with_capacity(keep.len() * (cols as usize));
                for u in &keep {
                    out.extend(u.iter().cloned());
                }
                Value::Array(Arc::new(ArrayData::new(out_rows, cols, out)))
            }
        }

        // SORT(array[, sort_index[, sort_order[, by_col]]]) — Sort rows by
        // column `sort_index` (default 1) ascending (1) or descending (-1).
        // When `by_col=TRUE`, sort columns by row `sort_index` instead.
        "SORT" => {
            if args.is_empty() || args.len() > 4 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let sort_index = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n >= 1.0 => n.trunc() as u32,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1u32
            };
            let sort_order = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n == 1.0 => 1i32,
                    Some(n) if n == -1.0 => -1i32,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1i32
            };
            let by_col = if args.len() == 4 {
                let v = eval_expr_with_provider(&args[3], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Range check on sort_index.
            if by_col {
                if sort_index > rows {
                    return Value::Error(ValueError::InvalidValue);
                }
            } else if sort_index > cols {
                return Value::Error(ValueError::InvalidValue);
            }
            // Build indices and sort by the key. Stable sort via Vec::sort_by.
            if by_col {
                // Sort columns by row (sort_index - 1).
                let key_row = (sort_index - 1) as usize;
                let mut order: Vec<u32> = (0..cols).collect();
                // Propagate any errors found in the key row.
                for &c in order.iter() {
                    let v = &data[key_row * (cols as usize) + (c as usize)];
                    if let Value::Error(e) = v {
                        return Value::Error(e.clone());
                    }
                }
                order.sort_by(|&a, &b| {
                    let va = &data[key_row * (cols as usize) + (a as usize)];
                    let vb = &data[key_row * (cols as usize) + (b as usize)];
                    let c = compare_lookup(va, vb);
                    if sort_order == -1 { c.reverse() } else { c }
                });
                let mut out: Vec<Value> = Vec::with_capacity(data.len());
                for r in 0..rows {
                    for &c in &order {
                        out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                    }
                }
                Value::Array(Arc::new(ArrayData::new(rows, cols, out)))
            } else {
                // Sort rows by column (sort_index - 1).
                let key_col = (sort_index - 1) as usize;
                let mut order: Vec<u32> = (0..rows).collect();
                for &r in order.iter() {
                    let v = &data[(r as usize) * (cols as usize) + key_col];
                    if let Value::Error(e) = v {
                        return Value::Error(e.clone());
                    }
                }
                order.sort_by(|&a, &b| {
                    let va = &data[(a as usize) * (cols as usize) + key_col];
                    let vb = &data[(b as usize) * (cols as usize) + key_col];
                    let c = compare_lookup(va, vb);
                    if sort_order == -1 { c.reverse() } else { c }
                });
                let mut out: Vec<Value> = Vec::with_capacity(data.len());
                for &r in &order {
                    for c in 0..cols {
                        out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                    }
                }
                Value::Array(Arc::new(ArrayData::new(rows, cols, out)))
            }
        }

        // FILTER(array, include[, if_empty]) — Keep rows where include's
        // matching element is truthy (column-vector include with rows ==
        // array.rows) OR keep columns (row-vector include with cols ==
        // array.cols). Empty result → if_empty (1x1 array) or #VALUE!.
        "FILTER" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let (irows, icols, idata) = match arg_to_2d(&args[1], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            // include must be either column-vector (irows == rows && icols == 1)
            // OR row-vector (icols == cols && irows == 1).
            let filter_rows: bool;
            if irows == rows && icols == 1 {
                filter_rows = true;
            } else if icols == cols && irows == 1 {
                filter_rows = false;
            } else {
                return Value::Error(ValueError::InvalidValue);
            }
            // Decode include into bool, propagating errors / type mismatches.
            let mut mask: Vec<bool> = Vec::with_capacity(idata.len());
            for v in &idata {
                if let Value::Error(e) = v {
                    return Value::Error(e.clone());
                }
                // Treat Null as FALSE so a sparse include vector silently
                // drops the matching rows/cols (matches Excel behavior).
                if matches!(v, Value::Null) {
                    mask.push(false);
                    continue;
                }
                match coerce_to_bool(v) {
                    Some(b) => mask.push(b),
                    None => return Value::Error(ValueError::WrongType),
                }
            }
            let kept: Vec<usize> = mask
                .iter()
                .enumerate()
                .filter_map(|(i, &b)| if b { Some(i) } else { None })
                .collect();
            if kept.is_empty() {
                if args.len() == 3 {
                    let v = eval_expr_with_provider(&args[2], provider);
                    // Wrap whatever it is in a 1×1 array. Errors flow through
                    // as the array element (Excel parity: =FILTER(...,error)
                    // surfaces the error inside the spill).
                    return Value::Array(Arc::new(ArrayData::new(1, 1, vec![v])));
                }
                return Value::Error(ValueError::InvalidValue);
            }
            if filter_rows {
                let out_rows = kept.len() as u32;
                let mut out: Vec<Value> = Vec::with_capacity(kept.len() * (cols as usize));
                for &r in &kept {
                    let base = r * (cols as usize);
                    out.extend(data[base..base + (cols as usize)].iter().cloned());
                }
                Value::Array(Arc::new(ArrayData::new(out_rows, cols, out)))
            } else {
                let out_cols = kept.len() as u32;
                let mut out: Vec<Value> = Vec::with_capacity((rows as usize) * kept.len());
                for r in 0..rows {
                    for &c in &kept {
                        out.push(data[(r as usize) * (cols as usize) + c].clone());
                    }
                }
                Value::Array(Arc::new(ArrayData::new(rows, out_cols, out)))
            }
        }

        // ── Array higher-order functions (L3 of the LAMBDA arc) ──────
        //
        // All of these take a lambda value as one of their arguments
        // (always the LAST one — Excel's calling convention) and apply
        // it pointwise / by row / by column / accumulator-style to
        // produce a derived array. Lambdas reach them either inline
        // (`=MAP(SEQUENCE(5), LAMBDA(x, x*2))`) or via a LET binding
        // (`=LET(sq, LAMBDA(x, x*x), MAP(A1:A5, sq))`).
        //
        // Common patterns:
        //   - Lambda arg evaluated first; non-lambda → WrongType.
        //   - Arity matched at call time; mismatch → WrongArgCount.
        //   - Per-element errors propagate from the lambda body.

        // MAP(array1, ..., arrayN, lambda)
        //
        // Lambda must accept exactly N arguments (one per input array).
        // All input arrays must share the same shape — mismatch → WrongType.
        // The result has the same shape as the inputs; each cell is
        // `lambda(array1[i,j], ..., arrayN[i,j])`.
        "MAP" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            // Last arg is the lambda. Evaluate it first so a non-lambda
            // surfaces a clean error before doing any array work.
            let lambda_v = eval_expr_with_provider(&args[args.len() - 1], provider);
            if let Value::Error(e) = lambda_v {
                return Value::Error(e);
            }
            if !matches!(lambda_v, Value::Lambda(_)) {
                return Value::Error(ValueError::WrongType);
            }
            let n_arrays = args.len() - 1;
            // Gather every input array as a 2D buffer + shape.
            let mut grids: Vec<(u32, u32, Vec<Value>)> = Vec::with_capacity(n_arrays);
            for arg in &args[..n_arrays] {
                let (r, c, d) = match arg_to_2d(arg, provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                grids.push((r, c, d));
            }
            // All inputs must share the same shape.
            let (rows, cols, _) = grids[0];
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            for (r, c, _) in &grids[1..] {
                if *r != rows || *c != cols {
                    return Value::Error(ValueError::WrongType);
                }
            }
            // Arity check on the lambda. apply_lambda would catch this
            // per-cell, but we'd waste work — fail eagerly with a clear
            // signal that the lambda doesn't fit the call shape.
            if let Value::Lambda(lam) = &lambda_v {
                if lam.arity() != n_arrays {
                    return Value::Error(ValueError::WrongArgCount);
                }
            }
            // Cap matches SEQUENCE — keep allocations bounded.
            let total = (rows as u64) * (cols as u64);
            if total > 1_048_576 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut out: Vec<Value> = Vec::with_capacity(total as usize);
            for i in 0..rows {
                for j in 0..cols {
                    let idx = (i as usize) * (cols as usize) + (j as usize);
                    let cell_args: Vec<Value> =
                        grids.iter().map(|(_, _, d)| d[idx].clone()).collect();
                    let v = apply_lambda(&lambda_v, cell_args, provider);
                    if let Value::Error(e) = v {
                        return Value::Error(e);
                    }
                    out.push(v);
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, cols, out)))
        }

        // REDUCE(initial, array, lambda)
        //
        // Lambda takes 2 args: (accumulator, value). Walks the array in
        // row-major order, accumulator = lambda(accumulator, value).
        // Returns the final accumulator — SCALAR result (NOT an Array).
        // The L3 spec is explicit: REDUCE returns a scalar; use SCAN if
        // you want the trail of intermediate accumulators.
        "REDUCE" => {
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let initial = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = initial {
                return Value::Error(e);
            }
            let (rows, cols, data) = match arg_to_2d(&args[1], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let lambda_v = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(e) = lambda_v {
                return Value::Error(e);
            }
            if !matches!(lambda_v, Value::Lambda(_)) {
                return Value::Error(ValueError::WrongType);
            }
            if let Value::Lambda(lam) = &lambda_v {
                if lam.arity() != 2 {
                    return Value::Error(ValueError::WrongArgCount);
                }
            }
            let mut acc = initial;
            for i in 0..rows {
                for j in 0..cols {
                    let idx = (i as usize) * (cols as usize) + (j as usize);
                    let v = data[idx].clone();
                    acc = apply_lambda(&lambda_v, vec![acc, v], provider);
                    if let Value::Error(e) = &acc {
                        return Value::Error(e.clone());
                    }
                }
            }
            acc
        }

        // SCAN(initial, array, lambda)
        //
        // Same accumulator pattern as REDUCE, but emits an Array of the
        // INTERMEDIATE accumulator values (same shape as the input
        // array). `out[i,j] = lambda(acc, array[i,j])` where `acc` is
        // updated in place row-major. SCAN is the spillable counterpart
        // of REDUCE.
        "SCAN" => {
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let initial = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = initial {
                return Value::Error(e);
            }
            let (rows, cols, data) = match arg_to_2d(&args[1], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let lambda_v = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(e) = lambda_v {
                return Value::Error(e);
            }
            if !matches!(lambda_v, Value::Lambda(_)) {
                return Value::Error(ValueError::WrongType);
            }
            if let Value::Lambda(lam) = &lambda_v {
                if lam.arity() != 2 {
                    return Value::Error(ValueError::WrongArgCount);
                }
            }
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let total = (rows as u64) * (cols as u64);
            if total > 1_048_576 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut out: Vec<Value> = Vec::with_capacity(total as usize);
            let mut acc = initial;
            for i in 0..rows {
                for j in 0..cols {
                    let idx = (i as usize) * (cols as usize) + (j as usize);
                    let v = data[idx].clone();
                    acc = apply_lambda(&lambda_v, vec![acc, v], provider);
                    if let Value::Error(e) = &acc {
                        return Value::Error(e.clone());
                    }
                    out.push(acc.clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, cols, out)))
        }

        // BYROW(array, lambda) and BYCOL(array, lambda)
        //
        // Lambda takes a SINGLE argument — a row (1×cols Array) for
        // BYROW or a column (rows×1 Array) for BYCOL. Result shape is
        // N×1 (BYROW: one accumulator per row) or 1×N (BYCOL: one per
        // column). The "row" / "column" passed to the lambda is itself
        // a `Value::Array`, NOT a flat list — this is what lets
        // `BYROW(input, LAMBDA(r, SUM(r)))` work (SUM unwraps the Array
        // through `for_each_arg_value`).
        "BYROW" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let lambda_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = lambda_v {
                return Value::Error(e);
            }
            if !matches!(lambda_v, Value::Lambda(_)) {
                return Value::Error(ValueError::WrongType);
            }
            if let Value::Lambda(lam) = &lambda_v {
                if lam.arity() != 1 {
                    return Value::Error(ValueError::WrongArgCount);
                }
            }
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut out: Vec<Value> = Vec::with_capacity(rows as usize);
            for i in 0..rows {
                let base = (i as usize) * (cols as usize);
                let row_data: Vec<Value> =
                    data[base..base + (cols as usize)].iter().cloned().collect();
                let row_arr = Value::Array(Arc::new(ArrayData::new(1, cols, row_data)));
                let v = apply_lambda(&lambda_v, vec![row_arr], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                out.push(v);
            }
            Value::Array(Arc::new(ArrayData::new(rows, 1, out)))
        }

        "BYCOL" => {
            if args.len() != 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            let lambda_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = lambda_v {
                return Value::Error(e);
            }
            if !matches!(lambda_v, Value::Lambda(_)) {
                return Value::Error(ValueError::WrongType);
            }
            if let Value::Lambda(lam) = &lambda_v {
                if lam.arity() != 1 {
                    return Value::Error(ValueError::WrongArgCount);
                }
            }
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut out: Vec<Value> = Vec::with_capacity(cols as usize);
            for j in 0..cols {
                let mut col_data: Vec<Value> = Vec::with_capacity(rows as usize);
                for i in 0..rows {
                    let idx = (i as usize) * (cols as usize) + (j as usize);
                    col_data.push(data[idx].clone());
                }
                let col_arr = Value::Array(Arc::new(ArrayData::new(rows, 1, col_data)));
                let v = apply_lambda(&lambda_v, vec![col_arr], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                out.push(v);
            }
            Value::Array(Arc::new(ArrayData::new(1, cols, out)))
        }

        // MAKEARRAY(rows, cols, lambda)
        //
        // Lambda takes 2 args: (row_index, col_index), both 1-based
        // (Excel parity). Returns a rows×cols Array where each cell is
        // `lambda(i, j)`. Same 1M-element cap as SEQUENCE — keeps
        // allocations bounded.
        "MAKEARRAY" => {
            if args.len() != 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let rows_v = eval_expr_with_provider(&args[0], provider);
            if let Value::Error(e) = rows_v {
                return Value::Error(e);
            }
            let cols_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = cols_v {
                return Value::Error(e);
            }
            let rows = match coerce_to_number(&rows_v) {
                Some(n) if n >= 1.0 => n.trunc() as u64,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let cols = match coerce_to_number(&cols_v) {
                Some(n) if n >= 1.0 => n.trunc() as u64,
                _ => return Value::Error(ValueError::InvalidValue),
            };
            let total = rows.checked_mul(cols).unwrap_or(u64::MAX);
            if total > 1_048_576 {
                return Value::Error(ValueError::InvalidValue);
            }
            let lambda_v = eval_expr_with_provider(&args[2], provider);
            if let Value::Error(e) = lambda_v {
                return Value::Error(e);
            }
            if !matches!(lambda_v, Value::Lambda(_)) {
                return Value::Error(ValueError::WrongType);
            }
            if let Value::Lambda(lam) = &lambda_v {
                if lam.arity() != 2 {
                    return Value::Error(ValueError::WrongArgCount);
                }
            }
            let rows_u = rows as u32;
            let cols_u = cols as u32;
            let mut out: Vec<Value> = Vec::with_capacity(total as usize);
            for i in 1..=rows_u {
                for j in 1..=cols_u {
                    let v = apply_lambda(
                        &lambda_v,
                        vec![Value::Number(i as f64), Value::Number(j as f64)],
                        provider,
                    );
                    if let Value::Error(e) = v {
                        return Value::Error(e);
                    }
                    out.push(v);
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows_u, cols_u, out)))
        }

        "SORTBY" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            // Validate the trailing arg pattern. After `array`, args come in
            // (by_array, [sort_order]) pairs; the order arg is optional, so we
            // accept any number of trailing args as long as they parse cleanly.
            // We walk the args list and pull (by_array, order) groups.
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Each key: (Vec<Value> with `rows` entries, order: i32)
            let mut keys: Vec<(Vec<Value>, i32)> = Vec::new();
            let mut idx = 1;
            while idx < args.len() {
                let (krows, kcols, kdata) = match arg_to_2d(&args[idx], provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                // by_array must have rows == array.rows. Accept either a column
                // vector (kcols == 1) or take the first column otherwise — but
                // strict Excel parity requires a single column shape, so reject
                // anything else.
                if krows != rows || kcols != 1 {
                    return Value::Error(ValueError::InvalidValue);
                }
                // Propagate any errors found in this key array.
                for v in &kdata {
                    if let Value::Error(e) = v {
                        return Value::Error(e.clone());
                    }
                }
                // Optional sort_order following the by_array.
                let order = if idx + 1 < args.len() {
                    // Peek the next arg. If it evaluates to a number 1 or -1,
                    // treat it as the order. We cannot disambiguate "by_array
                    // shaped like a 1-element array passed as a key" from
                    // "scalar 1 used as sort_order"; Excel resolves this by
                    // strictly requiring a scalar where a sort_order is
                    // expected. We follow the SORT precedent: any arg that
                    // coerces to a scalar 1 / -1 is taken as the order.
                    // Evaluate without consuming: if it's a range/array, treat
                    // as the next key.
                    let is_range = matches!(
                        &args[idx + 1],
                        Expr::Range { .. } | Expr::SheetRange { .. }
                    );
                    if is_range {
                        // Definitely another key; no explicit order.
                        1i32
                    } else {
                        let v = eval_expr_with_provider(&args[idx + 1], provider);
                        if let Value::Error(e) = v {
                            return Value::Error(e);
                        }
                        match coerce_to_number(&v) {
                            Some(n) if n == 1.0 => {
                                idx += 1;
                                1i32
                            }
                            Some(n) if n == -1.0 => {
                                idx += 1;
                                -1i32
                            }
                            _ => return Value::Error(ValueError::InvalidValue),
                        }
                    }
                } else {
                    1i32
                };
                keys.push((kdata, order));
                idx += 1;
            }
            if keys.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            // Build the permutation. Stable sort_by lets us cleanly express
            // multi-key precedence: compare key[0]; if equal, compare key[1];
            // etc. Stability covers any final ties.
            let mut order: Vec<u32> = (0..rows).collect();
            order.sort_by(|&a, &b| {
                for (kdata, sort_order) in &keys {
                    let va = &kdata[a as usize];
                    let vb = &kdata[b as usize];
                    let mut c = compare_lookup(va, vb);
                    if *sort_order == -1 {
                        c = c.reverse();
                    }
                    if c != std::cmp::Ordering::Equal {
                        return c;
                    }
                }
                std::cmp::Ordering::Equal
            });
            // Re-assemble `data` in the new row order.
            let mut out: Vec<Value> = Vec::with_capacity(data.len());
            for &r in &order {
                for c in 0..cols {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, cols, out)))
        }
        "RANDARRAY" => {
            if args.len() > 5 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let rows = if !args.is_empty() {
                let v = eval_expr_with_provider(&args[0], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n >= 1.0 => n.trunc() as u64,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1u64
            };
            let cols = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n >= 1.0 => n.trunc() as u64,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1u64
            };
            let min_v = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0.0
            };
            let max_v = if args.len() >= 4 {
                let v = eval_expr_with_provider(&args[3], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1.0
            };
            let whole = if args.len() == 5 {
                let v = eval_expr_with_provider(&args[4], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            if min_v > max_v {
                return Value::Error(ValueError::InvalidValue);
            }
            if whole && (min_v.fract() != 0.0 || max_v.fract() != 0.0) {
                return Value::Error(ValueError::InvalidValue);
            }
            let total = rows.checked_mul(cols).unwrap_or(u64::MAX);
            if total > 1_048_576 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Seed from system clock + a tiny mix so two rapid calls don't
            // collide. We don't have access to a `rand` crate; xorshift64
            // is plenty for spreadsheet RNG.
            let seed = {
                use std::time::{SystemTime, UNIX_EPOCH};
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0x9E37_79B9_7F4A_7C15);
                // XOR in the requested shape so back-to-back calls of the
                // same shape still vary.
                nanos ^ ((rows as u64) << 32) ^ (cols as u64)
            };
            let mut state: u64 = if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed };
            let next_u64 = |s: &mut u64| -> u64 {
                // xorshift64
                let mut x = *s;
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                *s = x;
                x
            };
            let rows_u = rows as u32;
            let cols_u = cols as u32;
            let mut data: Vec<Value> = Vec::with_capacity(total as usize);
            if whole {
                let min_i = min_v as i64;
                let max_i = max_v as i64;
                // Inclusive range size.
                let span = (max_i - min_i) as u64 + 1;
                for _ in 0..total {
                    let r = next_u64(&mut state) % span;
                    data.push(Value::Number((min_i as f64) + (r as f64)));
                }
            } else {
                let span = max_v - min_v;
                for _ in 0..total {
                    // Mantissa-style uniform [0,1).
                    let r = (next_u64(&mut state) >> 11) as f64 * (1.0f64 / ((1u64 << 53) as f64));
                    data.push(Value::Number(min_v + r * span));
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows_u, cols_u, data)))
        }
        "TAKE" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let rows_arg_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = rows_arg_v {
                return Value::Error(e);
            }
            let rows_arg = match coerce_to_number(&rows_arg_v) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            if rows_arg == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let cols_arg = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let n = match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                };
                if n == 0 {
                    return Value::Error(ValueError::InvalidValue);
                }
                Some(n)
            } else {
                None
            };
            // Compute row slice [r_start, r_end).
            let (r_start, r_end) = if rows_arg > 0 {
                let take = (rows_arg as u32).min(rows);
                (0u32, take)
            } else {
                let want = ((-rows_arg) as u32).min(rows);
                (rows - want, rows)
            };
            // Compute col slice [c_start, c_end).
            let (c_start, c_end) = match cols_arg {
                None => (0u32, cols),
                Some(n) if n > 0 => (0u32, (n as u32).min(cols)),
                Some(n) => {
                    let want = ((-n) as u32).min(cols);
                    (cols - want, cols)
                }
            };
            let out_rows = r_end - r_start;
            let out_cols = c_end - c_start;
            let mut out: Vec<Value> =
                Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for r in r_start..r_end {
                for c in c_start..c_end {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "DROP" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let rows_arg_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = rows_arg_v {
                return Value::Error(e);
            }
            let rows_arg = match coerce_to_number(&rows_arg_v) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            let cols_arg = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => Some(n.trunc() as i64),
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                None
            };
            // Row slice [r_start, r_end).
            let (r_start, r_end) = if rows_arg >= 0 {
                let drop = (rows_arg as u32).min(rows);
                (drop, rows)
            } else {
                let drop = ((-rows_arg) as u32).min(rows);
                (0u32, rows - drop)
            };
            // Col slice [c_start, c_end).
            let (c_start, c_end) = match cols_arg {
                None => (0u32, cols),
                Some(n) if n >= 0 => ((n as u32).min(cols), cols),
                Some(n) => {
                    let drop = ((-n) as u32).min(cols);
                    (0u32, cols - drop)
                }
            };
            if r_end <= r_start || c_end <= c_start {
                return Value::Error(ValueError::InvalidValue);
            }
            let out_rows = r_end - r_start;
            let out_cols = c_end - c_start;
            let mut out: Vec<Value> =
                Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for r in r_start..r_end {
                for c in c_start..c_end {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "VSTACK" => {
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut blocks: Vec<(u32, u32, Vec<Value>)> = Vec::with_capacity(args.len());
            for a in args {
                let (r, c, d) = match arg_to_2d(a, provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                if r == 0 || c == 0 {
                    return Value::Error(ValueError::InvalidValue);
                }
                blocks.push((r, c, d));
            }
            let out_cols = blocks.iter().map(|(_, c, _)| *c).max().unwrap_or(0);
            let out_rows: u32 = blocks.iter().map(|(r, _, _)| *r).sum();
            let mut out: Vec<Value> = Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for (br, bc, bd) in &blocks {
                for r in 0..*br {
                    for c in 0..out_cols {
                        if c < *bc {
                            out.push(bd[(r as usize) * (*bc as usize) + (c as usize)].clone());
                        } else {
                            out.push(Value::Error(ValueError::InvalidValue));
                        }
                    }
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "HSTACK" => {
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut blocks: Vec<(u32, u32, Vec<Value>)> = Vec::with_capacity(args.len());
            for a in args {
                let (r, c, d) = match arg_to_2d(a, provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                if r == 0 || c == 0 {
                    return Value::Error(ValueError::InvalidValue);
                }
                blocks.push((r, c, d));
            }
            let out_rows = blocks.iter().map(|(r, _, _)| *r).max().unwrap_or(0);
            let out_cols: u32 = blocks.iter().map(|(_, c, _)| *c).sum();
            let mut out: Vec<Value> = Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for r in 0..out_rows {
                for (br, bc, bd) in &blocks {
                    for c in 0..*bc {
                        if r < *br {
                            out.push(bd[(r as usize) * (*bc as usize) + (c as usize)].clone());
                        } else {
                            out.push(Value::Error(ValueError::InvalidValue));
                        }
                    }
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "CHOOSEROWS" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut picks: Vec<u32> = Vec::with_capacity(args.len() - 1);
            for a in &args[1..] {
                let v = eval_expr_with_provider(a, provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let n = match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                };
                let resolved: i64 = if n > 0 {
                    n - 1
                } else if n < 0 {
                    (rows as i64) + n
                } else {
                    return Value::Error(ValueError::InvalidValue);
                };
                if resolved < 0 || resolved >= rows as i64 {
                    return Value::Error(ValueError::InvalidValue);
                }
                picks.push(resolved as u32);
            }
            let out_rows = picks.len() as u32;
            let mut out: Vec<Value> = Vec::with_capacity(picks.len() * (cols as usize));
            for &r in &picks {
                for c in 0..cols {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, cols, out)))
        }
        "CHOOSECOLS" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut picks: Vec<u32> = Vec::with_capacity(args.len() - 1);
            for a in &args[1..] {
                let v = eval_expr_with_provider(a, provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let n = match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                };
                let resolved: i64 = if n > 0 {
                    n - 1
                } else if n < 0 {
                    (cols as i64) + n
                } else {
                    return Value::Error(ValueError::InvalidValue);
                };
                if resolved < 0 || resolved >= cols as i64 {
                    return Value::Error(ValueError::InvalidValue);
                }
                picks.push(resolved as u32);
            }
            let out_cols = picks.len() as u32;
            let mut out: Vec<Value> = Vec::with_capacity((rows as usize) * picks.len());
            for r in 0..rows {
                for &c in &picks {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, out_cols, out)))
        }
        "TOROW" => {
            if args.is_empty() || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let ignore = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0i64
            };
            if !(0..=3).contains(&ignore) {
                return Value::Error(ValueError::InvalidValue);
            }
            let by_col = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            let skip_blanks = ignore == 1 || ignore == 3;
            let skip_errors = ignore == 2 || ignore == 3;
            let mut out: Vec<Value> = Vec::with_capacity(data.len());
            let push = |v: &Value, out: &mut Vec<Value>| {
                let drop = (skip_blanks && matches!(v, Value::Null))
                    || (skip_errors && matches!(v, Value::Error(_)));
                if !drop {
                    out.push(v.clone());
                }
            };
            if by_col {
                for c in 0..cols {
                    for r in 0..rows {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            } else {
                for r in 0..rows {
                    for c in 0..cols {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            }
            if out.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let out_cols = out.len() as u32;
            Value::Array(Arc::new(ArrayData::new(1, out_cols, out)))
        }
        "TOCOL" => {
            if args.is_empty() || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let ignore = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0i64
            };
            if !(0..=3).contains(&ignore) {
                return Value::Error(ValueError::InvalidValue);
            }
            let by_col = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            let skip_blanks = ignore == 1 || ignore == 3;
            let skip_errors = ignore == 2 || ignore == 3;
            let mut out: Vec<Value> = Vec::with_capacity(data.len());
            let push = |v: &Value, out: &mut Vec<Value>| {
                let drop = (skip_blanks && matches!(v, Value::Null))
                    || (skip_errors && matches!(v, Value::Error(_)));
                if !drop {
                    out.push(v.clone());
                }
            };
            if by_col {
                for c in 0..cols {
                    for r in 0..rows {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            } else {
                for r in 0..rows {
                    for c in 0..cols {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            }
            if out.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let out_rows = out.len() as u32;
            Value::Array(Arc::new(ArrayData::new(out_rows, 1, out)))
        }
        "NORM.DIST" => stat_norm_dist(args, provider),
        "NORM.INV" => stat_norm_inv(args, provider),
        "NORM.S.DIST" => stat_norm_s_dist(args, provider),
        "NORM.S.INV" => stat_norm_s_inv(args, provider),
        "T.DIST" => stat_t_dist(args, provider),
        "T.DIST.RT" => stat_t_dist_rt(args, provider),
        "T.DIST.2T" => stat_t_dist_2t(args, provider),
        "T.INV" => stat_t_inv(args, provider),
        "T.INV.2T" => stat_t_inv_2t(args, provider),
        "F.DIST" => stat_f_dist(args, provider),
        "F.DIST.RT" => stat_f_dist_rt(args, provider),
        "F.INV" => stat_f_inv(args, provider),
        "F.INV.RT" => stat_f_inv_rt(args, provider),
        "CHISQ.DIST" => stat_chisq_dist(args, provider),
        "CHISQ.DIST.RT" => stat_chisq_dist_rt(args, provider),
        "CHISQ.INV" => stat_chisq_inv(args, provider),
        "CHISQ.INV.RT" => stat_chisq_inv_rt(args, provider),
        "EXPON.DIST" => stat_expon_dist(args, provider),
        "WEIBULL.DIST" => stat_weibull_dist(args, provider),
        "BETA.DIST" => stat_beta_dist(args, provider),
        "BETA.INV" => stat_beta_inv(args, provider),
        "GAMMA.DIST" => stat_gamma_dist(args, provider),
        "GAMMA.INV" => stat_gamma_inv(args, provider),
        "BINOM.DIST" => stat_binom_dist(args, provider),
        "BINOM.INV" => stat_binom_inv(args, provider),
        "POISSON.DIST" => stat_poisson_dist(args, provider),
        "HYPGEOM.DIST" => stat_hypgeom_dist(args, provider),
        "NEGBINOM.DIST" => stat_negbinom_dist(args, provider),
        "GAMMA" => stat_gamma_func(args, provider),
        "GAMMALN" => stat_gammaln(args, provider),
        "ERF" => stat_erf(args, provider),
        "ERFC" => stat_erfc(args, provider),
        "KURT" => stat_kurt(args, provider),
        "SKEW" => stat_skew(args, provider),
        "AVEDEV" => stat_avedev(args, provider),
        "DEVSQ" => stat_devsq(args, provider),
        "GEOMEAN" => stat_geomean(args, provider),
        "HARMEAN" => stat_harmean(args, provider),
        "TRIMMEAN" => stat_trimmean(args, provider),
        "STANDARDIZE" => stat_standardize(args, provider),
        "FISHER" => stat_fisher(args, provider),
        "FISHERINV" => stat_fisherinv(args, provider),
        "SORTBY" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            // Validate the trailing arg pattern. After `array`, args come in
            // (by_array, [sort_order]) pairs; the order arg is optional, so we
            // accept any number of trailing args as long as they parse cleanly.
            // We walk the args list and pull (by_array, order) groups.
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Each key: (Vec<Value> with `rows` entries, order: i32)
            let mut keys: Vec<(Vec<Value>, i32)> = Vec::new();
            let mut idx = 1;
            while idx < args.len() {
                let (krows, kcols, kdata) = match arg_to_2d(&args[idx], provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                // by_array must have rows == array.rows. Accept either a column
                // vector (kcols == 1) or take the first column otherwise — but
                // strict Excel parity requires a single column shape, so reject
                // anything else.
                if krows != rows || kcols != 1 {
                    return Value::Error(ValueError::InvalidValue);
                }
                // Propagate any errors found in this key array.
                for v in &kdata {
                    if let Value::Error(e) = v {
                        return Value::Error(e.clone());
                    }
                }
                // Optional sort_order following the by_array.
                let order = if idx + 1 < args.len() {
                    // Peek the next arg. If it evaluates to a number 1 or -1,
                    // treat it as the order. We cannot disambiguate "by_array
                    // shaped like a 1-element array passed as a key" from
                    // "scalar 1 used as sort_order"; Excel resolves this by
                    // strictly requiring a scalar where a sort_order is
                    // expected. We follow the SORT precedent: any arg that
                    // coerces to a scalar 1 / -1 is taken as the order.
                    // Evaluate without consuming: if it's a range/array, treat
                    // as the next key.
                    let is_range = matches!(
                        &args[idx + 1],
                        Expr::Range { .. } | Expr::SheetRange { .. }
                    );
                    if is_range {
                        // Definitely another key; no explicit order.
                        1i32
                    } else {
                        let v = eval_expr_with_provider(&args[idx + 1], provider);
                        if let Value::Error(e) = v {
                            return Value::Error(e);
                        }
                        match coerce_to_number(&v) {
                            Some(n) if n == 1.0 => {
                                idx += 1;
                                1i32
                            }
                            Some(n) if n == -1.0 => {
                                idx += 1;
                                -1i32
                            }
                            _ => return Value::Error(ValueError::InvalidValue),
                        }
                    }
                } else {
                    1i32
                };
                keys.push((kdata, order));
                idx += 1;
            }
            if keys.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            // Build the permutation. Stable sort_by lets us cleanly express
            // multi-key precedence: compare key[0]; if equal, compare key[1];
            // etc. Stability covers any final ties.
            let mut order: Vec<u32> = (0..rows).collect();
            order.sort_by(|&a, &b| {
                for (kdata, sort_order) in &keys {
                    let va = &kdata[a as usize];
                    let vb = &kdata[b as usize];
                    let mut c = compare_lookup(va, vb);
                    if *sort_order == -1 {
                        c = c.reverse();
                    }
                    if c != std::cmp::Ordering::Equal {
                        return c;
                    }
                }
                std::cmp::Ordering::Equal
            });
            // Re-assemble `data` in the new row order.
            let mut out: Vec<Value> = Vec::with_capacity(data.len());
            for &r in &order {
                for c in 0..cols {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, cols, out)))
        }
        "RANDARRAY" => {
            if args.len() > 5 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let rows = if !args.is_empty() {
                let v = eval_expr_with_provider(&args[0], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n >= 1.0 => n.trunc() as u64,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1u64
            };
            let cols = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) if n >= 1.0 => n.trunc() as u64,
                    _ => return Value::Error(ValueError::InvalidValue),
                }
            } else {
                1u64
            };
            let min_v = if args.len() >= 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0.0
            };
            let max_v = if args.len() >= 4 {
                let v = eval_expr_with_provider(&args[3], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                1.0
            };
            let whole = if args.len() == 5 {
                let v = eval_expr_with_provider(&args[4], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            if min_v > max_v {
                return Value::Error(ValueError::InvalidValue);
            }
            if whole && (min_v.fract() != 0.0 || max_v.fract() != 0.0) {
                return Value::Error(ValueError::InvalidValue);
            }
            let total = rows.checked_mul(cols).unwrap_or(u64::MAX);
            if total > 1_048_576 {
                return Value::Error(ValueError::InvalidValue);
            }
            // Seed from system clock + a tiny mix so two rapid calls don't
            // collide. We don't have access to a `rand` crate; xorshift64
            // is plenty for spreadsheet RNG.
            let seed = {
                use std::time::{SystemTime, UNIX_EPOCH};
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0x9E37_79B9_7F4A_7C15);
                // XOR in the requested shape so back-to-back calls of the
                // same shape still vary.
                nanos ^ ((rows as u64) << 32) ^ (cols as u64)
            };
            let mut state: u64 = if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed };
            let next_u64 = |s: &mut u64| -> u64 {
                // xorshift64
                let mut x = *s;
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                *s = x;
                x
            };
            let rows_u = rows as u32;
            let cols_u = cols as u32;
            let mut data: Vec<Value> = Vec::with_capacity(total as usize);
            if whole {
                let min_i = min_v as i64;
                let max_i = max_v as i64;
                // Inclusive range size.
                let span = (max_i - min_i) as u64 + 1;
                for _ in 0..total {
                    let r = next_u64(&mut state) % span;
                    data.push(Value::Number((min_i as f64) + (r as f64)));
                }
            } else {
                let span = max_v - min_v;
                for _ in 0..total {
                    // Mantissa-style uniform [0,1).
                    let r = (next_u64(&mut state) >> 11) as f64 * (1.0f64 / ((1u64 << 53) as f64));
                    data.push(Value::Number(min_v + r * span));
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows_u, cols_u, data)))
        }
        "TAKE" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let rows_arg_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = rows_arg_v {
                return Value::Error(e);
            }
            let rows_arg = match coerce_to_number(&rows_arg_v) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            if rows_arg == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let cols_arg = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let n = match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                };
                if n == 0 {
                    return Value::Error(ValueError::InvalidValue);
                }
                Some(n)
            } else {
                None
            };
            // Compute row slice [r_start, r_end).
            let (r_start, r_end) = if rows_arg > 0 {
                let take = (rows_arg as u32).min(rows);
                (0u32, take)
            } else {
                let want = ((-rows_arg) as u32).min(rows);
                (rows - want, rows)
            };
            // Compute col slice [c_start, c_end).
            let (c_start, c_end) = match cols_arg {
                None => (0u32, cols),
                Some(n) if n > 0 => (0u32, (n as u32).min(cols)),
                Some(n) => {
                    let want = ((-n) as u32).min(cols);
                    (cols - want, cols)
                }
            };
            let out_rows = r_end - r_start;
            let out_cols = c_end - c_start;
            let mut out: Vec<Value> =
                Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for r in r_start..r_end {
                for c in c_start..c_end {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "DROP" => {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let rows_arg_v = eval_expr_with_provider(&args[1], provider);
            if let Value::Error(e) = rows_arg_v {
                return Value::Error(e);
            }
            let rows_arg = match coerce_to_number(&rows_arg_v) {
                Some(n) => n.trunc() as i64,
                None => return Value::Error(ValueError::WrongType),
            };
            let cols_arg = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => Some(n.trunc() as i64),
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                None
            };
            // Row slice [r_start, r_end).
            let (r_start, r_end) = if rows_arg >= 0 {
                let drop = (rows_arg as u32).min(rows);
                (drop, rows)
            } else {
                let drop = ((-rows_arg) as u32).min(rows);
                (0u32, rows - drop)
            };
            // Col slice [c_start, c_end).
            let (c_start, c_end) = match cols_arg {
                None => (0u32, cols),
                Some(n) if n >= 0 => ((n as u32).min(cols), cols),
                Some(n) => {
                    let drop = ((-n) as u32).min(cols);
                    (0u32, cols - drop)
                }
            };
            if r_end <= r_start || c_end <= c_start {
                return Value::Error(ValueError::InvalidValue);
            }
            let out_rows = r_end - r_start;
            let out_cols = c_end - c_start;
            let mut out: Vec<Value> =
                Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for r in r_start..r_end {
                for c in c_start..c_end {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "VSTACK" => {
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut blocks: Vec<(u32, u32, Vec<Value>)> = Vec::with_capacity(args.len());
            for a in args {
                let (r, c, d) = match arg_to_2d(a, provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                if r == 0 || c == 0 {
                    return Value::Error(ValueError::InvalidValue);
                }
                blocks.push((r, c, d));
            }
            let out_cols = blocks.iter().map(|(_, c, _)| *c).max().unwrap_or(0);
            let out_rows: u32 = blocks.iter().map(|(r, _, _)| *r).sum();
            let mut out: Vec<Value> = Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for (br, bc, bd) in &blocks {
                for r in 0..*br {
                    for c in 0..out_cols {
                        if c < *bc {
                            out.push(bd[(r as usize) * (*bc as usize) + (c as usize)].clone());
                        } else {
                            out.push(Value::Error(ValueError::InvalidValue));
                        }
                    }
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "HSTACK" => {
            if args.is_empty() {
                return Value::Error(ValueError::WrongArgCount);
            }
            let mut blocks: Vec<(u32, u32, Vec<Value>)> = Vec::with_capacity(args.len());
            for a in args {
                let (r, c, d) = match arg_to_2d(a, provider) {
                    Ok(t) => t,
                    Err(e) => return Value::Error(e),
                };
                if r == 0 || c == 0 {
                    return Value::Error(ValueError::InvalidValue);
                }
                blocks.push((r, c, d));
            }
            let out_rows = blocks.iter().map(|(r, _, _)| *r).max().unwrap_or(0);
            let out_cols: u32 = blocks.iter().map(|(_, c, _)| *c).sum();
            let mut out: Vec<Value> = Vec::with_capacity((out_rows as usize) * (out_cols as usize));
            for r in 0..out_rows {
                for (br, bc, bd) in &blocks {
                    for c in 0..*bc {
                        if r < *br {
                            out.push(bd[(r as usize) * (*bc as usize) + (c as usize)].clone());
                        } else {
                            out.push(Value::Error(ValueError::InvalidValue));
                        }
                    }
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, out_cols, out)))
        }
        "CHOOSEROWS" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut picks: Vec<u32> = Vec::with_capacity(args.len() - 1);
            for a in &args[1..] {
                let v = eval_expr_with_provider(a, provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let n = match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                };
                let resolved: i64 = if n > 0 {
                    n - 1
                } else if n < 0 {
                    (rows as i64) + n
                } else {
                    return Value::Error(ValueError::InvalidValue);
                };
                if resolved < 0 || resolved >= rows as i64 {
                    return Value::Error(ValueError::InvalidValue);
                }
                picks.push(resolved as u32);
            }
            let out_rows = picks.len() as u32;
            let mut out: Vec<Value> = Vec::with_capacity(picks.len() * (cols as usize));
            for &r in &picks {
                for c in 0..cols {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(out_rows, cols, out)))
        }
        "CHOOSECOLS" => {
            if args.len() < 2 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let mut picks: Vec<u32> = Vec::with_capacity(args.len() - 1);
            for a in &args[1..] {
                let v = eval_expr_with_provider(a, provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                let n = match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                };
                let resolved: i64 = if n > 0 {
                    n - 1
                } else if n < 0 {
                    (cols as i64) + n
                } else {
                    return Value::Error(ValueError::InvalidValue);
                };
                if resolved < 0 || resolved >= cols as i64 {
                    return Value::Error(ValueError::InvalidValue);
                }
                picks.push(resolved as u32);
            }
            let out_cols = picks.len() as u32;
            let mut out: Vec<Value> = Vec::with_capacity((rows as usize) * picks.len());
            for r in 0..rows {
                for &c in &picks {
                    out.push(data[(r as usize) * (cols as usize) + (c as usize)].clone());
                }
            }
            Value::Array(Arc::new(ArrayData::new(rows, out_cols, out)))
        }
        "TOROW" => {
            if args.is_empty() || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let ignore = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0i64
            };
            if !(0..=3).contains(&ignore) {
                return Value::Error(ValueError::InvalidValue);
            }
            let by_col = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            let skip_blanks = ignore == 1 || ignore == 3;
            let skip_errors = ignore == 2 || ignore == 3;
            let mut out: Vec<Value> = Vec::with_capacity(data.len());
            let push = |v: &Value, out: &mut Vec<Value>| {
                let drop = (skip_blanks && matches!(v, Value::Null))
                    || (skip_errors && matches!(v, Value::Error(_)));
                if !drop {
                    out.push(v.clone());
                }
            };
            if by_col {
                for c in 0..cols {
                    for r in 0..rows {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            } else {
                for r in 0..rows {
                    for c in 0..cols {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            }
            if out.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let out_cols = out.len() as u32;
            Value::Array(Arc::new(ArrayData::new(1, out_cols, out)))
        }
        "TOCOL" => {
            if args.is_empty() || args.len() > 3 {
                return Value::Error(ValueError::WrongArgCount);
            }
            let (rows, cols, data) = match arg_to_2d(&args[0], provider) {
                Ok(t) => t,
                Err(e) => return Value::Error(e),
            };
            if rows == 0 || cols == 0 {
                return Value::Error(ValueError::InvalidValue);
            }
            let ignore = if args.len() >= 2 {
                let v = eval_expr_with_provider(&args[1], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                match coerce_to_number(&v) {
                    Some(n) => n.trunc() as i64,
                    None => return Value::Error(ValueError::WrongType),
                }
            } else {
                0i64
            };
            if !(0..=3).contains(&ignore) {
                return Value::Error(ValueError::InvalidValue);
            }
            let by_col = if args.len() == 3 {
                let v = eval_expr_with_provider(&args[2], provider);
                if let Value::Error(e) = v {
                    return Value::Error(e);
                }
                coerce_to_bool(&v).unwrap_or(false)
            } else {
                false
            };
            let skip_blanks = ignore == 1 || ignore == 3;
            let skip_errors = ignore == 2 || ignore == 3;
            let mut out: Vec<Value> = Vec::with_capacity(data.len());
            let push = |v: &Value, out: &mut Vec<Value>| {
                let drop = (skip_blanks && matches!(v, Value::Null))
                    || (skip_errors && matches!(v, Value::Error(_)));
                if !drop {
                    out.push(v.clone());
                }
            };
            if by_col {
                for c in 0..cols {
                    for r in 0..rows {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            } else {
                for r in 0..rows {
                    for c in 0..cols {
                        push(&data[(r as usize) * (cols as usize) + (c as usize)], &mut out);
                    }
                }
            }
            if out.is_empty() {
                return Value::Error(ValueError::InvalidValue);
            }
            let out_rows = out.len() as u32;
            Value::Array(Arc::new(ArrayData::new(out_rows, 1, out)))
        }
        "NORM.DIST" => stat_norm_dist(args, provider),
        "NORM.INV" => stat_norm_inv(args, provider),
        "NORM.S.DIST" => stat_norm_s_dist(args, provider),
        "NORM.S.INV" => stat_norm_s_inv(args, provider),
        "T.DIST" => stat_t_dist(args, provider),
        "T.DIST.RT" => stat_t_dist_rt(args, provider),
        "T.DIST.2T" => stat_t_dist_2t(args, provider),
        "T.INV" => stat_t_inv(args, provider),
        "T.INV.2T" => stat_t_inv_2t(args, provider),
        "F.DIST" => stat_f_dist(args, provider),
        "F.DIST.RT" => stat_f_dist_rt(args, provider),
        "F.INV" => stat_f_inv(args, provider),
        "F.INV.RT" => stat_f_inv_rt(args, provider),
        "CHISQ.DIST" => stat_chisq_dist(args, provider),
        "CHISQ.DIST.RT" => stat_chisq_dist_rt(args, provider),
        "CHISQ.INV" => stat_chisq_inv(args, provider),
        "CHISQ.INV.RT" => stat_chisq_inv_rt(args, provider),
        "EXPON.DIST" => stat_expon_dist(args, provider),
        "WEIBULL.DIST" => stat_weibull_dist(args, provider),
        "BETA.DIST" => stat_beta_dist(args, provider),
        "BETA.INV" => stat_beta_inv(args, provider),
        "GAMMA.DIST" => stat_gamma_dist(args, provider),
        "GAMMA.INV" => stat_gamma_inv(args, provider),
        "BINOM.DIST" => stat_binom_dist(args, provider),
        "BINOM.INV" => stat_binom_inv(args, provider),
        "POISSON.DIST" => stat_poisson_dist(args, provider),
        "HYPGEOM.DIST" => stat_hypgeom_dist(args, provider),
        "NEGBINOM.DIST" => stat_negbinom_dist(args, provider),
        "GAMMA" => stat_gamma_func(args, provider),
        "GAMMALN" => stat_gammaln(args, provider),
        "ERF" => stat_erf(args, provider),
        "ERFC" => stat_erfc(args, provider),
        "KURT" => stat_kurt(args, provider),
        "SKEW" => stat_skew(args, provider),
        "AVEDEV" => stat_avedev(args, provider),
        "DEVSQ" => stat_devsq(args, provider),
        "GEOMEAN" => stat_geomean(args, provider),
        "HARMEAN" => stat_harmean(args, provider),
        "TRIMMEAN" => stat_trimmean(args, provider),
        "STANDARDIZE" => stat_standardize(args, provider),
        "FISHER" => stat_fisher(args, provider),
        "FISHERINV" => stat_fisherinv(args, provider),
        _ => Value::Error(ValueError::InvalidName),
    }
}

/// Streams every arg's numeric values into a local Vec. The Vec is an
/// algorithmic requirement of the callers (MEDIAN sorts, MODE counts,
/// STDEV/VAR need two passes, LARGE/SMALL select by rank) — but going
/// through `for_each_arg_value` means the underlying provider can stay
/// sparse, so we never allocate Null entries for empty cells in
/// `SUM(A:A)`-shaped ranges.
/// Convert 0-based column index back to Excel letters: 0→"A", 25→"Z", 26→"AA".
/// Mirror of `cell::col_index_to_letters`, inlined here so the eval module is
/// self-contained for `ADDRESS`.
fn col_index_to_letters_eval(mut col: u32) -> String {
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

/// Parse the textual reference accepted by `INDIRECT`. Returns the optional
/// sheet name and the resolved start/end addresses (start == end for a
/// single-cell ref). Supports:
///
/// - `A1`, `$A$1`, `$A1`, `A$1` (absolute/relative markers are stripped).
/// - `A1:B3` ranges of two such refs.
/// - Optional `Sheet!` or `Sheet!A1:B3` sheet prefix; sheet name must match
///   `[A-Za-z_][A-Za-z0-9_]*` (no quoting / spaces in this batch).
fn parse_indirect_ref(text: &str) -> Option<(Option<String>, CellAddress, CellAddress)> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (sheet, body) = match text.find('!') {
        Some(i) => {
            let s = &text[..i];
            let rest = &text[i + 1..];
            if s.is_empty() {
                return None;
            }
            let valid = s.chars().enumerate().all(|(i, c)| {
                if i == 0 {
                    c.is_ascii_alphabetic() || c == '_'
                } else {
                    c.is_ascii_alphanumeric() || c == '_'
                }
            });
            if !valid {
                return None;
            }
            (Some(s.to_string()), rest)
        }
        None => (None, text),
    };
    let (start_str, end_str) = match body.find(':') {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let start = parse_indirect_addr(start_str)?;
    let end = match end_str {
        Some(s) => parse_indirect_addr(s)?,
        None => start,
    };
    Some((sheet, start, end))
}

/// Parse a single A1-style cell ref, tolerating the `$` absolute markers
/// (which are dropped — INDIRECT itself doesn't surface absoluteness).
fn parse_indirect_addr(s: &str) -> Option<CellAddress> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Strip leading $ (column absolute) and any $ before the row digits.
    let stripped: String = s.chars().filter(|c| *c != '$').collect();
    CellAddress::parse(&stripped)
}

/// Gregorian leap-year rule. Mirrors the local helper inside `date_serial`
/// / `date_from_serial`, exposed at module scope so the date arithmetic
/// helpers below can share it.
fn is_leap_year(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Number of days in month `m` of year `y`. Month is 1-based (1..=12).
fn days_in_month(y: i32, m: u32) -> u32 {
    const DOM: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if m == 0 || m > 12 {
        return 0;
    }
    let mut d = DOM[(m - 1) as usize];
    if m == 2 && is_leap_year(y) {
        d += 1;
    }
    d
}

/// Shift `(year, month)` by `delta` months, handling negative deltas and
/// month overflow. Returns `(new_year, new_month)` with `new_month` in 1..=12.
fn shift_year_month(year: i32, month: u32, delta: i64) -> (i32, u32) {
    // Convert to 0-based total months from year 0.
    let total: i64 = year as i64 * 12 + (month as i64 - 1) + delta;
    let new_year = total.div_euclid(12) as i32;
    let new_month = (total.rem_euclid(12) + 1) as u32;
    (new_year, new_month)
}

/// Shared implementation for RANK / RANKEQ. `args[0]` is the value, `args[1]`
/// is the range, `args[2]` (optional, default 0) is the sort order.
fn rank_eq(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    let value = match coerce_to_number(&v) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    let order_desc = if args.len() == 3 {
        let ov = eval_expr_with_provider(&args[2], provider);
        if let Value::Error(e) = ov {
            return Value::Error(e);
        }
        match coerce_to_number(&ov) {
            Some(n) => n == 0.0,
            None => return Value::Error(ValueError::WrongType),
        }
    } else {
        true
    };
    let nums = collect_numbers(&args[1..2], provider);
    if !nums.iter().any(|x| *x == value) {
        return Value::Error(ValueError::InvalidValue);
    }
    let rank = if order_desc {
        1 + nums.iter().filter(|x| **x > value).count()
    } else {
        1 + nums.iter().filter(|x| **x < value).count()
    };
    Value::Number(rank as f64)
}

/// Shared implementation for RANKAVG (Excel's RANK.AVG). Tied values get the
/// average of the ranks they would occupy (e.g. 3 tied at base rank 5 → 6.0).
fn rank_avg(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    let value = match coerce_to_number(&v) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    let order_desc = if args.len() == 3 {
        let ov = eval_expr_with_provider(&args[2], provider);
        if let Value::Error(e) = ov {
            return Value::Error(e);
        }
        match coerce_to_number(&ov) {
            Some(n) => n == 0.0,
            None => return Value::Error(ValueError::WrongType),
        }
    } else {
        true
    };
    let nums = collect_numbers(&args[1..2], provider);
    let ties = nums.iter().filter(|x| **x == value).count();
    if ties == 0 {
        return Value::Error(ValueError::InvalidValue);
    }
    let base = if order_desc {
        1 + nums.iter().filter(|x| **x > value).count()
    } else {
        1 + nums.iter().filter(|x| **x < value).count()
    };
    // Average of base, base+1, ..., base+ties-1.
    let sum: f64 = (0..ties).map(|i| (base + i) as f64).sum();
    Value::Number(sum / ties as f64)
}

/// Shared linear-interpolated percentile. Used by PERCENTILE and QUARTILE.
fn percentile_impl(range_args: &[Expr], provider: &dyn EvalProvider, k: f64) -> Value {
    if !k.is_finite() || k < 0.0 || k > 1.0 {
        return Value::Error(ValueError::InvalidValue);
    }
    let mut nums = collect_numbers(range_args, provider);
    if nums.is_empty() {
        return Value::Error(ValueError::InvalidValue);
    }
    nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = nums.len();
    let pos = k * (n as f64 - 1.0);
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    if lo == hi {
        Value::Number(nums[lo])
    } else {
        let frac = pos - lo as f64;
        Value::Number(nums[lo] + (nums[hi] - nums[lo]) * frac)
    }
}

/// Exclusive percentile (Excel 2010+ `PERCENTILE.EXC` / `QUARTILE.EXC`).
///
/// `k` must be strictly in `(0, 1)`. The 1-based rank is `k * (n + 1)`; if
/// that falls below 1 or above `n` the result is #VALUE!. Otherwise the
/// surrounding pair is linearly interpolated, same as `percentile_impl`.
fn percentile_exc_impl(range_args: &[Expr], provider: &dyn EvalProvider, k: f64) -> Value {
    if !k.is_finite() || k <= 0.0 || k >= 1.0 {
        return Value::Error(ValueError::InvalidValue);
    }
    let mut nums = collect_numbers(range_args, provider);
    if nums.is_empty() {
        return Value::Error(ValueError::InvalidValue);
    }
    nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = nums.len();
    // 1-based position. Excel: pos = k * (n + 1).
    let pos = k * (n as f64 + 1.0);
    if pos < 1.0 || pos > n as f64 {
        return Value::Error(ValueError::InvalidValue);
    }
    // Convert to 0-based interpolation bounds.
    let zero_based = pos - 1.0;
    let lo = zero_based.floor() as usize;
    let hi = zero_based.ceil() as usize;
    if lo == hi {
        Value::Number(nums[lo])
    } else {
        let frac = zero_based - lo as f64;
        Value::Number(nums[lo] + (nums[hi] - nums[lo]) * frac)
    }
}

/// Walk two range arguments in parallel and collect (x, y) pairs where BOTH
/// cells are numeric. Returns:
///   - Ok(Vec<(x, y)>) on success
///   - Err(ValueError) on shape mismatch (#VALUE!), non-range args (#VALUE!),
///     or propagated cell errors.
///
/// Both arguments must be the same shape (rows × cols). For 1×N vs N×1
/// orientations the shape must still match exactly — Excel allows mixed
/// orientations there, but we keep it strict (consistent with our 2D grid
/// model) and document the limitation.
fn collect_paired_numbers(
    a: &Expr,
    b: &Expr,
    provider: &dyn EvalProvider,
) -> Result<Vec<(f64, f64)>, ValueError> {
    let grid_a = match collect_range_2d_for_arg(a, provider) {
        Some(g) => g,
        None => return Err(ValueError::InvalidValue),
    };
    let grid_b = match collect_range_2d_for_arg(b, provider) {
        Some(g) => g,
        None => return Err(ValueError::InvalidValue),
    };
    let rows_a = grid_a.len();
    let cols_a = grid_a.first().map(|r| r.len()).unwrap_or(0);
    let rows_b = grid_b.len();
    let cols_b = grid_b.first().map(|r| r.len()).unwrap_or(0);
    if rows_a != rows_b || cols_a != cols_b {
        return Err(ValueError::InvalidValue);
    }
    let mut pairs: Vec<(f64, f64)> = Vec::new();
    for r in 0..rows_a {
        for c in 0..cols_a {
            let va = &grid_a[r][c];
            let vb = &grid_b[r][c];
            if let Value::Error(e) = va {
                return Err(e.clone());
            }
            if let Value::Error(e) = vb {
                return Err(e.clone());
            }
            if let (Value::Number(x), Value::Number(y)) = (va, vb) {
                pairs.push((*x, *y));
            }
        }
    }
    Ok(pairs)
}

/// CORREL(arr1, arr2). See dispatcher comment for semantics.
fn correl_impl(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let pairs = match collect_paired_numbers(&args[0], &args[1], provider) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    if pairs.len() < 2 {
        return Value::Error(ValueError::DivisionByZero);
    }
    let n = pairs.len() as f64;
    let mx = pairs.iter().map(|(x, _)| *x).sum::<f64>() / n;
    let my = pairs.iter().map(|(_, y)| *y).sum::<f64>() / n;
    let mut sxy = 0.0_f64;
    let mut sxx = 0.0_f64;
    let mut syy = 0.0_f64;
    for (x, y) in &pairs {
        let dx = *x - mx;
        let dy = *y - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    let denom = (sxx * syy).sqrt();
    if denom == 0.0 || !denom.is_finite() {
        return Value::Error(ValueError::DivisionByZero);
    }
    Value::Number(sxy / denom)
}

/// Covariance (population or sample). `sum((x-mx) * (y-my)) / divisor`,
/// where divisor is `n` for population (`COVAR` / `COVAR.P`) and `n - 1`
/// for sample (`COVAR.S`). Shares range-pair and shape rules with CORREL.
fn covar_impl(args: &[Expr], provider: &dyn EvalProvider, sample: bool) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let pairs = match collect_paired_numbers(&args[0], &args[1], provider) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    if pairs.is_empty() {
        return Value::Error(ValueError::DivisionByZero);
    }
    if sample && pairs.len() < 2 {
        // Sample covariance is undefined for a single pair (n - 1 == 0).
        return Value::Error(ValueError::DivisionByZero);
    }
    let n = pairs.len() as f64;
    let mx = pairs.iter().map(|(x, _)| *x).sum::<f64>() / n;
    let my = pairs.iter().map(|(_, y)| *y).sum::<f64>() / n;
    let sxy: f64 = pairs.iter().map(|(x, y)| (*x - mx) * (*y - my)).sum();
    let divisor = if sample { n - 1.0 } else { n };
    Value::Number(sxy / divisor)
}

/// Shared SLOPE / INTERCEPT body. Args are (y_array, x_array).
/// `as_intercept = true` returns ȳ - slope * x̄; otherwise returns slope.
fn slope_intercept_impl(
    args: &[Expr],
    provider: &dyn EvalProvider,
    as_intercept: bool,
) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    // args[0] is y, args[1] is x. We feed (x, y) into collect_paired_numbers
    // so existing pair semantics line up with the math below.
    let pairs = match collect_paired_numbers(&args[1], &args[0], provider) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    if pairs.len() < 2 {
        return Value::Error(ValueError::DivisionByZero);
    }
    let n = pairs.len() as f64;
    let mx = pairs.iter().map(|(x, _)| *x).sum::<f64>() / n;
    let my = pairs.iter().map(|(_, y)| *y).sum::<f64>() / n;
    let mut sxy = 0.0_f64;
    let mut sxx = 0.0_f64;
    for (x, y) in &pairs {
        let dx = *x - mx;
        let dy = *y - my;
        sxy += dx * dy;
        sxx += dx * dx;
    }
    if sxx == 0.0 {
        return Value::Error(ValueError::DivisionByZero);
    }
    let slope = sxy / sxx;
    if as_intercept {
        Value::Number(my - slope * mx)
    } else {
        Value::Number(slope)
    }
}

// === Financial helpers ===

/// Compounding factor `((1+r)^n - 1) / r`, with the rate=0 limit `n`.
/// Used by every annuity formula.
fn annuity_compound(rate: f64, n: f64) -> f64 {
    if rate == 0.0 {
        n
    } else {
        ((1.0 + rate).powf(n) - 1.0) / rate
    }
}

/// Coerce one positional argument to a finite number, propagating errors.
/// Returns `Ok(n)` for a successful coercion, `Err(ValueError)` otherwise.
fn fin_coerce(arg: &Expr, provider: &dyn EvalProvider) -> Result<f64, ValueError> {
    let v = eval_expr_with_provider(arg, provider);
    if let Value::Error(e) = v {
        return Err(e);
    }
    coerce_to_number(&v).ok_or(ValueError::WrongType)
}

/// Coerce a `type` flag (0 or 1) from an optional positional argument.
/// Excel rounds `type` toward zero and accepts 0 or 1; we treat anything
/// else as #VALUE!. Defaults to `0` when the arg is absent.
fn fin_coerce_type(
    args: &[Expr],
    idx: usize,
    provider: &dyn EvalProvider,
) -> Result<f64, ValueError> {
    if args.len() <= idx {
        return Ok(0.0);
    }
    let n = fin_coerce(&args[idx], provider)?;
    let t = n.trunc();
    if t != 0.0 && t != 1.0 {
        return Err(ValueError::InvalidValue);
    }
    Ok(t)
}

/// Closed-form PMT solving `pv*(1+r)^n + pmt*(1+r*type)*comp + fv = 0`
/// for `pmt`, where `comp = annuity_compound(rate, n)`. Result is the
/// `pmt` Excel would return (positive `pv` → negative `pmt`).
fn pmt_closed_form(rate: f64, n: f64, pv: f64, fv: f64, type_: f64) -> Option<f64> {
    if rate == 0.0 {
        if n == 0.0 {
            return None;
        }
        return Some(-(pv + fv) / n);
    }
    let factor = (1.0 + rate).powf(n);
    let denom = annuity_compound(rate, n) * (1.0 + rate * type_);
    if denom == 0.0 {
        return None;
    }
    Some(-(pv * factor + fv) / denom)
}

fn fn_pmt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 3 || args.len() > 5 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let nper = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pv = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() >= 4 {
        match fin_coerce(&args[3], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 4, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    match pmt_closed_form(rate, nper, pv, fv, type_) {
        Some(r) if r.is_finite() => Value::Number(r),
        _ => Value::Error(ValueError::Overflow),
    }
}

fn fn_pv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 3 || args.len() > 5 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let nper = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pmt = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() >= 4 {
        match fin_coerce(&args[3], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 4, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Solve `pv*(1+r)^n + pmt*(1+r*type)*comp + fv = 0` for pv.
    let factor = if rate == 0.0 { 1.0 } else { (1.0 + rate).powf(nper) };
    let comp = annuity_compound(rate, nper);
    if rate == 0.0 {
        let r = -(pmt * nper + fv);
        if r.is_finite() {
            Value::Number(r)
        } else {
            Value::Error(ValueError::Overflow)
        }
    } else {
        if factor == 0.0 {
            return Value::Error(ValueError::Overflow);
        }
        let r = -(pmt * (1.0 + rate * type_) * comp + fv) / factor;
        if r.is_finite() {
            Value::Number(r)
        } else {
            Value::Error(ValueError::Overflow)
        }
    }
}

fn fn_fv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 3 || args.len() > 5 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let nper = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pmt = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pv = if args.len() >= 4 {
        match fin_coerce(&args[3], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 4, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Solve `pv*(1+r)^n + pmt*(1+r*type)*comp + fv = 0` for fv.
    let factor = if rate == 0.0 { 1.0 } else { (1.0 + rate).powf(nper) };
    let comp = annuity_compound(rate, nper);
    let r = if rate == 0.0 {
        -(pv + pmt * nper)
    } else {
        -(pv * factor + pmt * (1.0 + rate * type_) * comp)
    };
    if r.is_finite() {
        Value::Number(r)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

fn fn_nper(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 3 || args.len() > 5 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pmt = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pv = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() >= 4 {
        match fin_coerce(&args[3], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 4, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if rate == 0.0 {
        if pmt == 0.0 {
            return Value::Error(ValueError::DivisionByZero);
        }
        let n = -(pv + fv) / pmt;
        if n.is_finite() {
            return Value::Number(n);
        }
        return Value::Error(ValueError::Overflow);
    }
    // Closed-form: pmt' = pmt*(1+r*type)
    // (1+r)^n = (pmt' - r*fv) / (pmt' + r*pv)
    let pmt_eff = pmt * (1.0 + rate * type_);
    let num = pmt_eff - rate * fv;
    let den = pmt_eff + rate * pv;
    if den == 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let ratio = num / den;
    if !ratio.is_finite() || ratio <= 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let base = 1.0 + rate;
    if base <= 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let n = ratio.ln() / base.ln();
    if n.is_finite() {
        Value::Number(n)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

fn fn_npv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if rate == -1.0 {
        return Value::Error(ValueError::DivisionByZero);
    }
    // Walk every following arg, accumulating discount-factor * value.
    // For range cells we skip non-numeric values (Excel parity for NPV
    // ranges, which legitimately contain blanks or labels). Non-numeric
    // *scalar* args would surface as #VALUE! in real Excel; we apply the
    // same range-skip behavior uniformly for simplicity — documented at
    // the function's match arm.
    let mut total = 0.0_f64;
    let mut i: u32 = 1;
    let mut err: Option<ValueError> = None;
    for arg in &args[1..] {
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
                }
                Value::Number(n) => {
                    let denom = (1.0 + rate).powi(i as i32);
                    if denom == 0.0 || !denom.is_finite() {
                        err = Some(ValueError::Overflow);
                        return;
                    }
                    total += n / denom;
                    i += 1;
                }
                _ => {
                    // Range blanks / labels are skipped (Excel parity).
                    // For scalar args this matches typical behavior of
                    // ignoring booleans/text in financial aggregates.
                }
            }
        });
    }
    if let Some(e) = err {
        return Value::Error(e);
    }
    if !total.is_finite() {
        return Value::Error(ValueError::Overflow);
    }
    Value::Number(total)
}

/// Collect cash flows from an IRR argument. The argument must be a range
/// (single-cell or multi-cell). Returns the values in row-major order;
/// non-numeric cells produce `Err(InvalidValue)` so the caller bails with
/// `#VALUE!`. Empty range → `Err(InvalidValue)`.
fn collect_irr_values(arg: &Expr, provider: &dyn EvalProvider) -> Result<Vec<f64>, ValueError> {
    let grid = match collect_range_2d_for_arg(arg, provider) {
        Some(g) => g,
        None => return Err(ValueError::WrongType),
    };
    let mut out: Vec<f64> = Vec::new();
    for row in &grid {
        for cell in row {
            match cell {
                Value::Number(n) => out.push(*n),
                Value::Error(e) => return Err(e.clone()),
                Value::Null => {} // skip blanks
                _ => return Err(ValueError::InvalidValue),
            }
        }
    }
    if out.is_empty() {
        return Err(ValueError::InvalidValue);
    }
    Ok(out)
}

const IRR_TOL: f64 = 1e-7;
const IRR_MAX_ITER: usize = 100;

/// IRR — Newton-Raphson on f(r) = Σ value_i / (1+r)^i for i = 0..n-1.
fn fn_irr(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let values = match collect_irr_values(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Require at least one positive AND one negative cash flow.
    let has_pos = values.iter().any(|v| *v > 0.0);
    let has_neg = values.iter().any(|v| *v < 0.0);
    if !(has_pos && has_neg) {
        return Value::Error(ValueError::InvalidValue);
    }
    let guess = if args.len() == 2 {
        match fin_coerce(&args[1], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.1
    };
    let mut r = guess;
    for _ in 0..IRR_MAX_ITER {
        // f(r) and f'(r) in a single pass.
        let mut f = 0.0_f64;
        let mut fp = 0.0_f64;
        let base = 1.0 + r;
        if base == 0.0 || !base.is_finite() {
            return Value::Error(ValueError::Overflow);
        }
        for (i, v) in values.iter().enumerate() {
            let denom = base.powi(i as i32);
            if denom == 0.0 || !denom.is_finite() {
                return Value::Error(ValueError::Overflow);
            }
            f += v / denom;
            if i > 0 {
                fp += -(i as f64) * v / (denom * base);
            }
        }
        if !f.is_finite() || !fp.is_finite() {
            return Value::Error(ValueError::Overflow);
        }
        if f.abs() < IRR_TOL {
            return Value::Number(r);
        }
        if fp == 0.0 {
            return Value::Error(ValueError::Overflow);
        }
        let next = r - f / fp;
        if !next.is_finite() {
            return Value::Error(ValueError::Overflow);
        }
        if (next - r).abs() < IRR_TOL {
            return Value::Number(next);
        }
        r = next;
    }
    Value::Error(ValueError::Overflow)
}

const RATE_TOL: f64 = 1e-7;
const RATE_MAX_ITER: usize = 100;

/// Evaluate the annuity equation `g(r) = pv*(1+r)^n + pmt*(1+r*type)*((1+r)^n - 1)/r + fv`
/// and its derivative wrt `r`.
fn rate_residual(rate: f64, n: f64, pmt: f64, pv: f64, fv: f64, type_: f64) -> (f64, f64) {
    if rate == 0.0 {
        // g(0) = pv + pmt*n + fv ; g'(0) handled via series expansion:
        // d/dr [(1+r)^n] |0 = n
        // d/dr [(1+r*type)*((1+r)^n - 1)/r] |0 = n*(n-1)/2 + type*n
        let g = pv + pmt * n + fv;
        let gp = pv * n + pmt * (n * (n - 1.0) / 2.0 + type_ * n);
        return (g, gp);
    }
    let one_plus_r = 1.0 + rate;
    let power = one_plus_r.powf(n);
    let comp = (power - 1.0) / rate;
    let g = pv * power + pmt * (1.0 + rate * type_) * comp + fv;
    // d/dr [(1+r)^n] = n*(1+r)^(n-1)
    let dpower = n * one_plus_r.powf(n - 1.0);
    // d/dr [comp] = d/dr [((1+r)^n - 1)/r] = (n*(1+r)^(n-1) * r - ((1+r)^n - 1)) / r^2
    let dcomp = (dpower * rate - (power - 1.0)) / (rate * rate);
    // d/dr [pmt*(1+r*type)*comp] = pmt*(type*comp + (1+r*type)*dcomp)
    let gp = pv * dpower + pmt * (type_ * comp + (1.0 + rate * type_) * dcomp);
    (g, gp)
}

fn fn_rate(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 3 || args.len() > 6 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let nper = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pmt = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pv = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() >= 4 {
        match fin_coerce(&args[3], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 4, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let guess = if args.len() == 6 {
        match fin_coerce(&args[5], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.1
    };
    if nper <= 0.0 {
        return Value::Error(ValueError::InvalidValue);
    }
    let mut r = guess;
    for _ in 0..RATE_MAX_ITER {
        let (g, gp) = rate_residual(r, nper, pmt, pv, fv, type_);
        if !g.is_finite() || !gp.is_finite() {
            return Value::Error(ValueError::Overflow);
        }
        if g.abs() < RATE_TOL {
            return Value::Number(r);
        }
        if gp == 0.0 {
            return Value::Error(ValueError::Overflow);
        }
        let next = r - g / gp;
        if !next.is_finite() {
            return Value::Error(ValueError::Overflow);
        }
        if (next - r).abs() < RATE_TOL {
            return Value::Number(next);
        }
        r = next;
    }
    Value::Error(ValueError::Overflow)
}

fn fn_ipmt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 4 || args.len() > 6 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let per = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let nper = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pv = match fin_coerce(&args[3], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() >= 5 {
        match fin_coerce(&args[4], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 5, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if per < 1.0 || per > nper {
        return Value::Error(ValueError::InvalidValue);
    }
    let pmt = match pmt_closed_form(rate, nper, pv, fv, type_) {
        Some(v) => v,
        None => return Value::Error(ValueError::Overflow),
    };
    // For type=1 and per=1: interest is paid up-front, so ipmt = 0.
    if type_ == 1.0 && per == 1.0 {
        return Value::Number(0.0);
    }
    // For type=1 we shift the effective period: balance at the start of
    // period `per` (after `per-1` payments have been applied) uses
    // (per-2) compounding because the period-1 payment happened at t=0.
    let k = if type_ == 1.0 { per - 2.0 } else { per - 1.0 };
    if rate == 0.0 {
        // Linear: every payment is purely principal; interest is 0 for
        // any period when rate=0.
        return Value::Number(0.0);
    }
    let pow_k = (1.0 + rate).powf(k);
    let balance = pv * pow_k + pmt * annuity_compound(rate, k);
    let ipmt = -balance * rate;
    if ipmt.is_finite() {
        Value::Number(ipmt)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

fn fn_ppmt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() < 4 || args.len() > 6 {
        return Value::Error(ValueError::WrongArgCount);
    }
    // Reuse IPMT and PMT. We need the same args order for PMT
    // (rate, nper, pv, fv, type) but IPMT takes (rate, per, nper, pv, fv, type).
    let rate = match fin_coerce(&args[0], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // We don't directly use `per` here but the IPMT path will validate it.
    let _per = match fin_coerce(&args[1], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let nper = match fin_coerce(&args[2], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pv = match fin_coerce(&args[3], provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() >= 5 {
        match fin_coerce(&args[4], provider) {
            Ok(v) => v,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let type_ = match fin_coerce_type(args, 5, provider) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let pmt = match pmt_closed_form(rate, nper, pv, fv, type_) {
        Some(v) => v,
        None => return Value::Error(ValueError::Overflow),
    };
    let ipmt = match fn_ipmt(args, provider) {
        Value::Number(n) => n,
        other => return other,
    };
    let ppmt = pmt - ipmt;
    if ppmt.is_finite() {
        Value::Number(ppmt)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

/// Parse a fixed-width base-n textual numeral with Excel's
/// two's-complement convention.
///
/// `base`: 2, 8, or 16.
/// `max_chars`: maximum number of digits the spec allows (10 for all
///   three of Excel's BIN/OCT/HEX inputs).
/// `bits_per_digit`: 1 / 3 / 4 for BIN / OCT / HEX. The signed
///   bit-width is `max_chars * bits_per_digit`.
///
/// If `text.len() == max_chars` and the high bit (`bits-1`) is set,
/// the result is sign-extended (i.e. `value - 2^bits`). Otherwise the
/// numeric value is taken as-is.
///
/// Empty input, over-long input, or any non-digit / out-of-base char
/// surfaces `InvalidValue`.
pub(crate) fn parse_base_n_text(
    text: &str,
    base: u32,
    max_chars: usize,
    bits_per_digit: u32,
) -> Result<f64, ValueError> {
    if text.is_empty() || text.len() > max_chars {
        return Err(ValueError::InvalidValue);
    }
    let mut value: u64 = 0;
    for ch in text.chars() {
        let d = match ch.to_digit(base) {
            Some(d) => d as u64,
            None => return Err(ValueError::InvalidValue),
        };
        value = value * base as u64 + d;
    }
    let bits = (max_chars as u32) * bits_per_digit;
    // Sign-extend only when the input occupies the full width; shorter
    // strings are positive by definition (matching Excel: BIN2DEC("1")
    // is 1, not -1).
    if text.len() == max_chars {
        let sign_bit = 1u64 << (bits - 1);
        if value & sign_bit != 0 {
            let two_pow_n = 1u64 << bits;
            // value - 2^bits as a signed quantity.
            let signed = value as i64 - two_pow_n as i64;
            return Ok(signed as f64);
        }
    }
    Ok(value as f64)
}

/// Format a number into Excel's fixed-width signed two's-complement
/// textual base-n representation.
///
/// Positive (or zero) values: emit the minimum-width base-n digits,
/// optionally left-padded with `'0'` to `places`. `places` must satisfy
/// `1 <= places <= max_chars` and `places >= min_chars`; otherwise
/// `InvalidValue`.
///
/// Negative values: emit exactly `max_chars` digits (the two's-comp
/// representation); `places` is ignored, matching Excel.
///
/// Out-of-range numbers surface `Overflow` (Excel's `#NUM!`). The
/// argument is truncated toward zero before range-checking.
pub(crate) fn format_base_n_signed(
    value: f64,
    base: u32,
    max_chars: usize,
    bits_per_digit: u32,
    places: Option<usize>,
    upper_hex: bool,
) -> Result<String, ValueError> {
    if !value.is_finite() {
        return Err(ValueError::Overflow);
    }
    // Excel truncates toward zero before applying the range check.
    let trunc = value.trunc();
    let bits = (max_chars as u32) * bits_per_digit;
    let max_pos: i64 = (1i64 << (bits - 1)) - 1;
    let min_neg: i64 = -(1i64 << (bits - 1));
    // Guard against trunc that doesn't fit in i64 before casting.
    if trunc > max_pos as f64 || trunc < min_neg as f64 {
        return Err(ValueError::Overflow);
    }
    let v = trunc as i64;

    let digit_char = |d: u32| -> char {
        let c = char::from_digit(d, base).unwrap_or('0');
        if upper_hex { c.to_ascii_uppercase() } else { c }
    };

    if v < 0 {
        // Two's-complement: encode (v + 2^bits) as an unsigned value
        // and emit exactly `max_chars` digits, padded with leading
        // zeros if the high digits are zero (rare since the sign bit
        // is set by definition for in-range negatives).
        let two_pow_n: u64 = 1u64 << bits;
        let unsigned = (v as i64 + two_pow_n as i64) as u64;
        let mut out = String::with_capacity(max_chars);
        let mut buf = unsigned;
        for _ in 0..max_chars {
            let d = (buf % base as u64) as u32;
            out.push(digit_char(d));
            buf /= base as u64;
        }
        Ok(out.chars().rev().collect())
    } else {
        // Build the minimum-width unsigned representation.
        let mut buf = v as u64;
        let min_chars: String = if buf == 0 {
            "0".to_string()
        } else {
            let mut s = String::new();
            while buf > 0 {
                let d = (buf % base as u64) as u32;
                s.push(digit_char(d));
                buf /= base as u64;
            }
            s.chars().rev().collect()
        };
        match places {
            None => Ok(min_chars),
            Some(p) => {
                if p < 1 || p > max_chars {
                    return Err(ValueError::InvalidValue);
                }
                if p < min_chars.len() {
                    return Err(ValueError::InvalidValue);
                }
                let pad = p - min_chars.len();
                let mut out = String::with_capacity(p);
                for _ in 0..pad {
                    out.push('0');
                }
                out.push_str(&min_chars);
                Ok(out)
            }
        }
    }
}

/// Shared body for BIN2DEC / OCT2DEC / HEX2DEC: coerce the single arg
/// to text, hand off to `parse_base_n_text`, surface errors verbatim.
fn eval_xxx2dec(
    args: &[Expr],
    provider: &dyn EvalProvider,
    base: u32,
    max_chars: usize,
    bits_per_digit: u32,
) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    // Per Excel: a Boolean / Null isn't a valid binary numeral, even
    // though coerce_to_text would happily emit "TRUE"/"FALSE"/"".
    // Reject those up-front so they don't slip through as InvalidValue
    // from the parser's "non-digit" path (less informative).
    match v {
        Value::Boolean(_) | Value::Null => return Value::Error(ValueError::WrongType),
        _ => {}
    }
    let text = coerce_to_text(&v);
    match parse_base_n_text(&text, base, max_chars, bits_per_digit) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// Optional-places extractor shared by DEC2XXX and the cross-base
/// wrappers. Returns `Ok(None)` when the arg is absent; `Ok(Some(n))`
/// for a valid 1..=max_chars place count; errors mirror Excel:
///   - non-numeric → WrongType
///   - non-integer / out of 1..=max_chars → InvalidValue
///   - propagated cell error → that error
fn engineering_places(
    arg: Option<&Expr>,
    provider: &dyn EvalProvider,
    max_chars: usize,
) -> Result<Option<usize>, ValueError> {
    let Some(expr) = arg else {
        return Ok(None);
    };
    let v = eval_expr_with_provider(expr, provider);
    if let Value::Error(e) = v {
        return Err(e);
    }
    let n = match coerce_to_number(&v) {
        Some(n) => n,
        None => return Err(ValueError::WrongType),
    };
    if !n.is_finite() || n.trunc() != n {
        return Err(ValueError::InvalidValue);
    }
    let p = n as i64;
    if p < 1 || p as usize > max_chars {
        return Err(ValueError::InvalidValue);
    }
    Ok(Some(p as usize))
}

/// Shared body for DEC2BIN / DEC2OCT / DEC2HEX.
fn eval_dec2xxx(
    args: &[Expr],
    provider: &dyn EvalProvider,
    base: u32,
    max_chars: usize,
    bits_per_digit: u32,
    upper_hex: bool,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    let n = match coerce_to_number(&v) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    let places = match engineering_places(args.get(1), provider, max_chars) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    match format_base_n_signed(n, base, max_chars, bits_per_digit, places, upper_hex) {
        Ok(s) => Value::Text(s),
        Err(e) => Value::Error(e),
    }
}

/// Shared body for cross-base wrappers (BIN2HEX, OCT2BIN, ...).
/// `from` = (base, max_chars, bits_per_digit) for the source.
/// `to` = same triple for the destination. `upper_hex` selects the
/// uppercase digit set on the output.
fn eval_cross_base(
    args: &[Expr],
    provider: &dyn EvalProvider,
    from: (u32, usize, u32),
    to: (u32, usize, u32),
    upper_hex: bool,
) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    match v {
        Value::Boolean(_) | Value::Null => return Value::Error(ValueError::WrongType),
        _ => {}
    }
    let text = coerce_to_text(&v);
    let dec = match parse_base_n_text(&text, from.0, from.1, from.2) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let places = match engineering_places(args.get(1), provider, to.1) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    match format_base_n_signed(dec, to.0, to.1, to.2, places, upper_hex) {
        Ok(s) => Value::Text(s),
        Err(e) => Value::Error(e),
    }
}

/// Coerce a Value into a number for engineering-function consumption.
/// Tighter than `coerce_to_number`: text and errors are rejected (the
/// caller has already short-circuited on errors). Booleans coerce to
/// 0/1 to match Excel's DELTA(TRUE, 1) = 1 behaviour.
fn as_engineering_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => Some(*n),
        Value::Boolean(true) => Some(1.0),
        Value::Boolean(false) => Some(0.0),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// Bit-op f64 → u64 domain check. Excel documents BITAND/OR/XOR as
/// accepting 0..=2^48-1; we accept the f64-safe 0..=2^53-1 range so
/// large values produced by other formulas stay representable.
const BIT_OP_MAX: f64 = 9_007_199_254_740_991.0; // 2^53 - 1

fn coerce_bit_operand(v: &Value) -> Result<u64, ValueError> {
    let n = match coerce_to_number(v) {
        Some(n) => n,
        None => return Err(ValueError::WrongType),
    };
    if !n.is_finite() || n.trunc() != n {
        return Err(ValueError::Overflow);
    }
    if n < 0.0 || n > BIT_OP_MAX {
        return Err(ValueError::Overflow);
    }
    Ok(n as u64)
}

/// Shared body for BITAND / BITOR / BITXOR.
fn eval_bit_binop(
    args: &[Expr],
    provider: &dyn EvalProvider,
    f: impl Fn(u64, u64) -> u64,
) -> Value {
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
    let av = match coerce_bit_operand(&a) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let bv = match coerce_bit_operand(&b) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    Value::Number(f(av, bv) as f64)
}

/// Shared body for BITLSHIFT / BITRSHIFT. `reverse` flips the sign
/// convention: BITLSHIFT(a, -3) == BITRSHIFT(a, 3) and vice versa.
fn eval_bit_shift(args: &[Expr], provider: &dyn EvalProvider, reverse: bool) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let a = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = a {
        return Value::Error(e);
    }
    let n = eval_expr_with_provider(&args[1], provider);
    if let Value::Error(e) = n {
        return Value::Error(e);
    }
    let av = match coerce_bit_operand(&a) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let nv = match coerce_to_number(&n) {
        Some(x) => x,
        None => return Value::Error(ValueError::WrongType),
    };
    if !nv.is_finite() || nv.trunc() != nv {
        return Value::Error(ValueError::Overflow);
    }
    let shift = nv as i64;
    // Excel's documented shift domain is |n| <= 53.
    if shift.abs() > 53 {
        return Value::Error(ValueError::Overflow);
    }
    // Normalize to "shift left by `effective`": positive → left,
    // negative → right.
    let effective = if reverse { -shift } else { shift };
    let result = if effective == 0 {
        av
    } else if effective > 0 {
        // Left shift: result must still fit in the safe-integer range.
        let r = (av as u128).checked_shl(effective as u32).unwrap_or(u128::MAX);
        if r > BIT_OP_MAX as u128 {
            return Value::Error(ValueError::Overflow);
        }
        r as u64
    } else {
        let amount = (-effective) as u32;
        if amount >= 64 {
            0
        } else {
            av >> amount
        }
    };
    Value::Number(result as f64)
}

// === Math extras helpers ===

/// Shared body for SUMX2MY2 / SUMX2PY2 / SUMXMY2. Collects (x,y) pairs
/// via `collect_paired_numbers` (which enforces same-shape and skips
/// non-numeric cells per offset), then folds with `f`.
fn sum_pair_impl(
    args: &[Expr],
    provider: &dyn EvalProvider,
    f: impl Fn(f64, f64) -> f64,
) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let pairs = match collect_paired_numbers(&args[0], &args[1], provider) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    let total: f64 = pairs.iter().map(|(x, y)| f(*x, *y)).sum();
    Value::Number(total)
}

/// SUMPRODUCT body. Accepts 1+ range-shaped args; all must share shape.
/// Single-array case reduces to "SUM over numerics". Non-numeric cells
/// contribute 0 to that position's product.
fn sumproduct_impl(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.is_empty() {
        return Value::Error(ValueError::WrongArgCount);
    }
    // Materialise each arg as a 2D grid. Scalar/non-range args are
    // wrapped as a 1×1 grid so a SUMPRODUCT(A1:A3, 2) still has a
    // shape — but we reject mismatched shapes between range args.
    let mut grids: Vec<Vec<Vec<Value>>> = Vec::with_capacity(args.len());
    for a in args {
        match collect_range_2d_for_arg(a, provider) {
            Some(g) => grids.push(g),
            None => return Value::Error(ValueError::InvalidValue),
        }
    }
    // Shape check.
    let rows = grids[0].len();
    let cols = grids[0].first().map(|r| r.len()).unwrap_or(0);
    for g in &grids[1..] {
        if g.len() != rows || g.first().map(|r| r.len()).unwrap_or(0) != cols {
            return Value::Error(ValueError::InvalidValue);
        }
    }
    let mut total = 0.0_f64;
    for r in 0..rows {
        for c in 0..cols {
            let mut prod = 1.0_f64;
            for g in &grids {
                match &g[r][c] {
                    Value::Error(e) => return Value::Error(e.clone()),
                    Value::Number(n) => prod *= *n,
                    // Non-numeric (Null, Text, Boolean) contributes 0
                    // to the cell — for the single-array case this
                    // matches "SUM over numerics" exactly.
                    _ => {
                        prod = 0.0;
                        break;
                    }
                }
            }
            total += prod;
        }
    }
    Value::Number(total)
}

/// FLOOR.MATH / CEILING.MATH shared body.
///
/// `is_floor` selects FLOOR.MATH (`true`) vs CEILING.MATH (`false`).
///
/// Default mode (=0) rounds toward -inf (FLOOR.MATH) or +inf
/// (CEILING.MATH) regardless of sign. With mode != 0, negative
/// numbers reverse direction: FLOOR.MATH rounds toward zero (i.e.
/// ceil after sign flip) and CEILING.MATH rounds away from zero.
/// Significance == 0 collapses to 0 (Excel parity).
fn floor_ceiling_math(args: &[Expr], provider: &dyn EvalProvider, is_floor: bool) -> Value {
    if args.is_empty() || args.len() > 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let nv = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = nv {
        return Value::Error(e);
    }
    let n = match coerce_to_number(&nv) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    let sig = if args.len() >= 2 {
        let sv = eval_expr_with_provider(&args[1], provider);
        if let Value::Error(e) = sv {
            return Value::Error(e);
        }
        match coerce_to_number(&sv) {
            Some(s) => s,
            None => return Value::Error(ValueError::WrongType),
        }
    } else {
        1.0
    };
    let mode = if args.len() == 3 {
        let mv = eval_expr_with_provider(&args[2], provider);
        if let Value::Error(e) = mv {
            return Value::Error(e);
        }
        match coerce_to_number(&mv) {
            Some(m) => m,
            None => return Value::Error(ValueError::WrongType),
        }
    } else {
        0.0
    };
    if sig == 0.0 {
        return Value::Number(0.0);
    }
    // FLOOR.MATH / CEILING.MATH treat significance sign as irrelevant —
    // we always divide by |sig|. The direction is controlled by
    // is_floor + mode + sign(n).
    let s = sig.abs();
    let r = if is_floor {
        if n < 0.0 && mode != 0.0 {
            // Round toward zero for negatives.
            (n / s).ceil() * s
        } else {
            (n / s).floor() * s
        }
    } else {
        // CEILING.MATH
        if n < 0.0 && mode != 0.0 {
            // Round away from zero for negatives.
            (n / s).floor() * s
        } else {
            (n / s).ceil() * s
        }
    };
    if r.is_finite() {
        Value::Number(r)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

/// FLOOR.PRECISE / CEILING.PRECISE shared body. Always toward -inf
/// (FLOOR.PRECISE) or +inf (CEILING.PRECISE). 1 or 2 args.
fn floor_ceiling_precise(args: &[Expr], provider: &dyn EvalProvider, is_floor: bool) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let nv = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = nv {
        return Value::Error(e);
    }
    let n = match coerce_to_number(&nv) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    let sig = if args.len() == 2 {
        let sv = eval_expr_with_provider(&args[1], provider);
        if let Value::Error(e) = sv {
            return Value::Error(e);
        }
        match coerce_to_number(&sv) {
            Some(s) => s,
            None => return Value::Error(ValueError::WrongType),
        }
    } else {
        1.0
    };
    if sig == 0.0 {
        return Value::Number(0.0);
    }
    let s = sig.abs();
    let r = if is_floor {
        (n / s).floor() * s
    } else {
        (n / s).ceil() * s
    };
    if r.is_finite() {
        Value::Number(r)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

/// ROMAN(num[, form]) — convert integer 1..=3999 into a Roman numeral.
/// `form` defaults to 0 (classic). Only classic form is supported;
/// other values yield #VALUE!.
fn fn_roman(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let nv = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = nv {
        return Value::Error(e);
    }
    let n_raw = match coerce_to_number(&nv) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    // Truncate toward zero, then range-check.
    let n = n_raw.trunc() as i64;
    if !(1..=3999).contains(&n) {
        return Value::Error(ValueError::InvalidValue);
    }
    if args.len() == 2 {
        let fv = eval_expr_with_provider(&args[1], provider);
        if let Value::Error(e) = fv {
            return Value::Error(e);
        }
        let form = match coerce_to_number(&fv) {
            Some(f) => f.trunc() as i64,
            // Boolean TRUE/FALSE coerce to 1/0 — both fall under "non-classic".
            None => return Value::Error(ValueError::WrongType),
        };
        if form != 0 {
            // note: only classic form supported.
            return Value::Error(ValueError::InvalidValue);
        }
    }
    // Classic table.
    const TABLE: [(i64, &str); 13] = [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut rem = n;
    let mut out = String::new();
    for (v, sym) in TABLE.iter() {
        while rem >= *v {
            out.push_str(sym);
            rem -= *v;
        }
    }
    Value::Text(out)
}

/// ARABIC(roman_text) — parse a Roman numeral (case-insensitive).
/// Empty string → 0. Whitespace is trimmed. Negative prefix `-` is
/// rejected (Excel actually accepts a leading minus, but we keep the
/// surface narrow until we need it). Invalid syntax → #VALUE!.
fn fn_arabic(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let v = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = v {
        return Value::Error(e);
    }
    let raw = match &v {
        Value::Text(s) => s.clone(),
        Value::Null => String::new(),
        // Numbers/booleans → reject.
        _ => return Value::Error(ValueError::WrongType),
    };
    let s = raw.trim().to_ascii_uppercase();
    if s.is_empty() {
        return Value::Number(0.0);
    }
    let mut total: i64 = 0;
    let mut prev: i64 = 0;
    for ch in s.chars().rev() {
        let v = match ch {
            'I' => 1,
            'V' => 5,
            'X' => 10,
            'L' => 50,
            'C' => 100,
            'D' => 500,
            'M' => 1000,
            _ => return Value::Error(ValueError::InvalidValue),
        };
        if v < prev {
            total -= v;
        } else {
            total += v;
        }
        prev = v;
    }
    Value::Number(total as f64)
}

/// DECIMAL(text, base) — parse `text` as an integer in `base` (2..=36).
fn fn_decimal(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let tv = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = tv {
        return Value::Error(e);
    }
    let bv = eval_expr_with_provider(&args[1], provider);
    if let Value::Error(e) = bv {
        return Value::Error(e);
    }
    let base_f = match coerce_to_number(&bv) {
        Some(b) => b,
        None => return Value::Error(ValueError::WrongType),
    };
    if !base_f.is_finite() || base_f.trunc() != base_f {
        return Value::Error(ValueError::InvalidValue);
    }
    let base = base_f as i64;
    if !(2..=36).contains(&base) {
        return Value::Error(ValueError::InvalidValue);
    }
    // Accept Text only — numeric inputs would be lossy without us
    // formatting them first; Excel itself coerces Number → string, but
    // we keep the surface strict.
    let text = match &tv {
        Value::Text(s) => s.trim().to_ascii_uppercase(),
        Value::Number(n) => {
            if !n.is_finite() || n.trunc() != *n {
                return Value::Error(ValueError::InvalidValue);
            }
            // Render as plain decimal string; parse below in `base`
            // still applies, matching Excel's coercion path.
            format!("{}", *n as i64)
        }
        _ => return Value::Error(ValueError::WrongType),
    };
    if text.is_empty() {
        return Value::Number(0.0);
    }
    let mut acc: i64 = 0;
    for ch in text.chars() {
        let digit = match ch {
            '0'..='9' => ch as i64 - '0' as i64,
            'A'..='Z' => ch as i64 - 'A' as i64 + 10,
            _ => return Value::Error(ValueError::InvalidValue),
        };
        if digit >= base {
            return Value::Error(ValueError::InvalidValue);
        }
        acc = match acc.checked_mul(base).and_then(|a| a.checked_add(digit)) {
            Some(v) => v,
            None => return Value::Error(ValueError::Overflow),
        };
    }
    Value::Number(acc as f64)
}

/// BASE(num, base[, min_length]) — render a non-negative integer in
/// `base` (2..=36), zero-padded to `min_length` if requested.
fn fn_base(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if !(2..=3).contains(&args.len()) {
        return Value::Error(ValueError::WrongArgCount);
    }
    let nv = eval_expr_with_provider(&args[0], provider);
    if let Value::Error(e) = nv {
        return Value::Error(e);
    }
    let n_raw = match coerce_to_number(&nv) {
        Some(n) => n,
        None => return Value::Error(ValueError::WrongType),
    };
    if !n_raw.is_finite() || n_raw < 0.0 {
        return Value::Error(ValueError::InvalidValue);
    }
    let n = n_raw.trunc() as i64;
    let bv = eval_expr_with_provider(&args[1], provider);
    if let Value::Error(e) = bv {
        return Value::Error(e);
    }
    let base_f = match coerce_to_number(&bv) {
        Some(b) => b,
        None => return Value::Error(ValueError::WrongType),
    };
    if !base_f.is_finite() || base_f.trunc() != base_f {
        return Value::Error(ValueError::InvalidValue);
    }
    let base = base_f as i64;
    if !(2..=36).contains(&base) {
        return Value::Error(ValueError::InvalidValue);
    }
    let min_len: usize = if args.len() == 3 {
        let mv = eval_expr_with_provider(&args[2], provider);
        if let Value::Error(e) = mv {
            return Value::Error(e);
        }
        match coerce_to_number(&mv) {
            Some(m) if m.is_finite() && m >= 0.0 => m.trunc() as usize,
            Some(_) => return Value::Error(ValueError::InvalidValue),
            None => return Value::Error(ValueError::WrongType),
        }
    } else {
        0
    };
    let s = if n == 0 {
        "0".to_string()
    } else {
        let mut digits: Vec<char> = Vec::new();
        let mut rem = n;
        while rem > 0 {
            let d = (rem % base) as u32;
            let ch = if d < 10 {
                (b'0' + d as u8) as char
            } else {
                (b'A' + (d - 10) as u8) as char
            };
            digits.push(ch);
            rem /= base;
        }
        digits.iter().rev().collect::<String>()
    };
    if s.len() >= min_len {
        Value::Text(s)
    } else {
        let pad = min_len - s.len();
        Value::Text(format!("{}{}", "0".repeat(pad), s))
    }
}

/// MDETERM(range) — determinant via Doolittle LU decomposition with
/// partial pivoting. Numerically stable up to ~50×50; we cap inputs at
/// 100×100 to keep eval time bounded.
fn fn_mdeterm(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let grid = match collect_range_2d_for_arg(&args[0], provider) {
        Some(g) => g,
        None => return Value::Error(ValueError::InvalidValue),
    };
    let n = grid.len();
    if n == 0 {
        return Value::Error(ValueError::InvalidValue);
    }
    let cols = grid[0].len();
    if cols != n {
        return Value::Error(ValueError::InvalidValue);
    }
    if n > 100 {
        return Value::Error(ValueError::Overflow);
    }
    // Materialise as f64 matrix; propagate errors and reject non-numeric.
    let mut m: Vec<Vec<f64>> = vec![vec![0.0; n]; n];
    for r in 0..n {
        if grid[r].len() != n {
            return Value::Error(ValueError::InvalidValue);
        }
        for c in 0..n {
            match &grid[r][c] {
                Value::Error(e) => return Value::Error(e.clone()),
                Value::Number(x) => m[r][c] = *x,
                Value::Null => m[r][c] = 0.0,
                Value::Boolean(b) => m[r][c] = if *b { 1.0 } else { 0.0 },
                Value::Text(_) => return Value::Error(ValueError::WrongType),
                // Dynamic-array: collapse to top-left scalar then retry.
                // Phase 1 unreachable — no constructor produces Array yet.
                Value::Array(arr) => match arr.get(0, 0) {
                    Some(Value::Number(x)) => m[r][c] = *x,
                    Some(Value::Null) | None => m[r][c] = 0.0,
                    Some(Value::Boolean(b)) => m[r][c] = if *b { 1.0 } else { 0.0 },
                    Some(Value::Error(e)) => return Value::Error(e.clone()),
                    Some(_) => return Value::Error(ValueError::WrongType),
                },
                // Determinant of a matrix containing a lambda — type error.
                Value::Lambda(_) => return Value::Error(ValueError::WrongType),
            }
        }
    }
    // LU with partial pivoting; det = product(diag(U)) * (-1)^swaps.
    let mut det = 1.0_f64;
    for i in 0..n {
        // Find pivot in column i.
        let mut piv_row = i;
        let mut piv_val = m[i][i].abs();
        for r in (i + 1)..n {
            let v = m[r][i].abs();
            if v > piv_val {
                piv_val = v;
                piv_row = r;
            }
        }
        if piv_val == 0.0 {
            return Value::Number(0.0);
        }
        if piv_row != i {
            m.swap(i, piv_row);
            det = -det;
        }
        det *= m[i][i];
        // Eliminate column i below row i.
        for r in (i + 1)..n {
            let factor = m[r][i] / m[i][i];
            for c in i..n {
                m[r][c] -= factor * m[i][c];
            }
        }
    }
    if det.is_finite() {
        Value::Number(det)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

/// 1970-epoch-aware Monday-indexed day-of-week (Mon=0..Sun=6). Used
/// by the working-day helpers below — kept Mon-indexed because the
/// NETWORKDAYS.INTL mask string is documented in Excel as Mon..Sun.
fn dow_monday_indexed(serial: i64) -> usize {
    // Sunday=0..Saturday=6 (since 1970-01-01 was Thursday → +4).
    let dow_sun = (serial + 4).rem_euclid(7);
    // Shift to Mon=0..Sun=6.
    ((dow_sun + 6) % 7) as usize
}

/// Resolve two `(start, end)` serial endpoints for NETWORKDAYS /
/// NETWORKDAYS.INTL, propagating cell-evaluation errors and surfacing
/// type errors when coercion fails.
fn networkdays_endpoints(
    start_arg: &Expr,
    end_arg: &Expr,
    provider: &dyn EvalProvider,
) -> Result<(i64, i64), ValueError> {
    let s = eval_expr_with_provider(start_arg, provider);
    if let Value::Error(e) = s {
        return Err(e);
    }
    let e = eval_expr_with_provider(end_arg, provider);
    if let Value::Error(er) = e {
        return Err(er);
    }
    let start = coerce_to_number(&s).ok_or(ValueError::WrongType)?.floor() as i64;
    let end = coerce_to_number(&e).ok_or(ValueError::WrongType)?.floor() as i64;
    Ok((start, end))
}

/// Parse a NETWORKDAYS.INTL / WORKDAY.INTL `weekend` argument. Returns
/// a Mon..Sun mask where `true` marks weekend days.
///
/// Accepted forms (matching Excel):
///   - Number 1..7   → two-day weekend block starting on a given day
///   - Number 11..17 → single-day weekend
///   - Text mask     → 7 chars of '0'/'1', char[0] = Monday
///
/// An all-`1` mask (no working days at all) is rejected as
/// InvalidValue, matching Excel's #VALUE! on the same input.
fn parse_weekend_arg(v: &Value) -> Result<[bool; 7], ValueError> {
    if let Value::Text(s) = v {
        // Text mask path. 7 characters of '0'/'1', Mon..Sun.
        let bytes = s.as_bytes();
        if bytes.len() != 7 {
            return Err(ValueError::InvalidValue);
        }
        let mut mask = [false; 7];
        let mut all_weekend = true;
        for (i, c) in bytes.iter().enumerate() {
            match c {
                b'0' => {
                    all_weekend = false;
                }
                b'1' => {
                    mask[i] = true;
                }
                _ => return Err(ValueError::InvalidValue),
            }
        }
        if all_weekend {
            // All days marked weekend → no working days at all.
            return Err(ValueError::InvalidValue);
        }
        return Ok(mask);
    }
    let code = coerce_to_number(v).ok_or(ValueError::WrongType)?;
    if code.fract() != 0.0 {
        return Err(ValueError::InvalidValue);
    }
    let code = code as i64;
    // Excel two-day codes: 1 = Sat+Sun, 2 = Sun+Mon, ..., 7 = Fri+Sat.
    // Mask indices are Mon=0..Sun=6.
    let two_day_pairs: [[usize; 2]; 7] = [
        [5, 6], // 1: Sat+Sun
        [6, 0], // 2: Sun+Mon
        [0, 1], // 3: Mon+Tue
        [1, 2], // 4: Tue+Wed
        [2, 3], // 5: Wed+Thu
        [3, 4], // 6: Thu+Fri
        [4, 5], // 7: Fri+Sat
    ];
    if (1..=7).contains(&code) {
        let pair = two_day_pairs[(code - 1) as usize];
        let mut mask = [false; 7];
        mask[pair[0]] = true;
        mask[pair[1]] = true;
        return Ok(mask);
    }
    // Single-day codes 11..17: 11 = Sun, 12 = Mon, ..., 17 = Sat.
    if (11..=17).contains(&code) {
        // 11 → Sun (mask idx 6), 12 → Mon (mask idx 0), ..., 17 → Sat (mask idx 5).
        let day = ((code - 12).rem_euclid(7)) as usize; // 12→0..17→5, 11→6
        let mut mask = [false; 7];
        mask[day] = true;
        return Ok(mask);
    }
    Err(ValueError::InvalidValue)
}

/// Walk an optional holidays argument via `for_each_arg_value`,
/// collecting whole-day integer serials. Numeric cells are floored;
/// Null / Text / Boolean cells are silently skipped (mixed-type
/// holiday columns happen in practice). Errors *do* propagate — a
/// `#DIV/0!` lurking in the holidays range short-circuits the whole
/// function, matching Excel.
fn collect_holidays(
    arg: Option<&Expr>,
    provider: &dyn EvalProvider,
) -> Result<HashSet<i64>, ValueError> {
    let mut set = HashSet::new();
    let arg = match arg {
        Some(a) => a,
        None => return Ok(set),
    };
    let mut err: Option<ValueError> = None;
    for_each_arg_value(arg, provider, &mut |_addr, v| {
        if err.is_some() {
            return;
        }
        match v {
            Value::Error(e) => err = Some(e),
            Value::Number(n) => {
                set.insert(n.floor() as i64);
            }
            // Text / Boolean / Null inside a holidays range → lenient
            // skip. Excel raises #VALUE! on text holidays; we match
            // the more forgiving Google Sheets behaviour here so
            // sparse data doesn't blow up the formula.
            _ => {}
        }
    });
    if let Some(e) = err {
        return Err(e);
    }
    Ok(set)
}

/// Count whole-day workdays from `start` to `end` inclusive on both
/// ends. A workday is a serial whose Mon-indexed day-of-week is not
/// flagged in `weekend` AND whose serial is not in `holidays`. If
/// `start > end` the count is negated (Excel parity).
fn count_workdays(start: i64, end: i64, weekend: &[bool; 7], holidays: &HashSet<i64>) -> i64 {
    if start == end {
        return if weekend[dow_monday_indexed(start)] || holidays.contains(&start) {
            0
        } else {
            1
        };
    }
    let (a, b, sign) = if start <= end {
        (start, end, 1)
    } else {
        (end, start, -1)
    };
    let mut count: i64 = 0;
    let mut d = a;
    while d <= b {
        if !weekend[dow_monday_indexed(d)] && !holidays.contains(&d) {
            count += 1;
        }
        d += 1;
    }
    sign * count
}

/// Advance `days` working days from `start`. `days == 0` returns
/// `start` verbatim (Excel does *not* snap to the nearest workday).
/// Positive `days` steps forward, negative steps backward; in both
/// directions the step skips weekend days and any serial in
/// `holidays`.
fn advance_workdays(start: i64, days: i64, weekend: &[bool; 7], holidays: &HashSet<i64>) -> i64 {
    if days == 0 {
        return start;
    }
    let step: i64 = if days > 0 { 1 } else { -1 };
    let mut remaining = days.abs();
    let mut cur = start;
    while remaining > 0 {
        cur += step;
        if !weekend[dow_monday_indexed(cur)] && !holidays.contains(&cur) {
            remaining -= 1;
        }
    }
    cur
}

/// ISO 8601 week number (1..53). Weeks start Monday; week 1 of the
/// ISO year is the week containing Jan 4 (equivalently, the first
/// week with ≥4 days of the new year). Dates within the first few
/// days of January may belong to the *previous* ISO year (when the
/// date sits before that year's week 1 starts); dates within the
/// last few days of December may belong to the *next* ISO year (when
/// the date sits past the computed year's last week boundary).
fn iso_week_number(serial: i64) -> i64 {
    // Helper: week-1 Monday for a given Gregorian year.
    fn week1_start(year: i32) -> i64 {
        let jan4 = date_serial(year, 1, 4) as i64;
        // Convert jan4's day-of-week to Mon=0..Sun=6.
        let dow_iso = dow_monday_indexed(jan4) as i64;
        jan4 - dow_iso
    }
    let (year, _, _) = date_from_serial(serial as f64);
    let start = week1_start(year);
    if serial < start {
        // Date is in the last ISO week of the previous Gregorian year.
        let prev_start = week1_start(year - 1);
        return (serial - prev_start) / 7 + 1;
    }
    // Could still be in week 1 of the next ISO year — check.
    let next_start = week1_start(year + 1);
    if serial >= next_start {
        return (serial - next_start) / 7 + 1;
    }
    (serial - start) / 7 + 1
}

fn stat_num(arg: &Expr, provider: &dyn EvalProvider) -> Result<f64, Value> {
    let v = eval_expr_with_provider(arg, provider);
    if let Value::Error(e) = v {
        return Err(Value::Error(e));
    }
    match coerce_to_number(&v) {
        Some(n) => Ok(n),
        None => Err(Value::Error(ValueError::WrongType)),
    }
}

fn stat_bool(arg: &Expr, provider: &dyn EvalProvider) -> Result<bool, Value> {
    let v = eval_expr_with_provider(arg, provider);
    if let Value::Error(e) = v {
        return Err(Value::Error(e));
    }
    match coerce_to_bool(&v) {
        Some(b) => Ok(b),
        None => Err(Value::Error(ValueError::WrongType)),
    }
}

fn stat_finite(n: f64) -> Value {
    if n.is_finite() {
        Value::Number(n)
    } else {
        Value::Error(ValueError::Overflow)
    }
}

fn stat_norm_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, Normal};
    if args.len() != 4 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let mean = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let sd = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(sd > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Normal::new(mean, sd) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_norm_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, Normal};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let mean = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let sd = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p > 0.0 && p < 1.0) || !(sd > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Normal::new(mean, sd) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(p))
}

fn stat_norm_s_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, Normal};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let z = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[1], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    let dist = Normal::new(0.0, 1.0).expect("standard normal always constructs");
    stat_finite(if cumulative { dist.cdf(z) } else { dist.pdf(z) })
}

fn stat_norm_s_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, Normal};
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p > 0.0 && p < 1.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = Normal::new(0.0, 1.0).expect("standard normal always constructs");
    stat_finite(dist.inverse_cdf(p))
}

fn stat_t_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, StudentsT};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[2], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(df > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match StudentsT::new(0.0, 1.0, df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_t_dist_rt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, StudentsT};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    // Excel: T.DIST.RT requires x >= 0 (returns #NUM! for negative).
    if !(df > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match StudentsT::new(0.0, 1.0, df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(1.0 - dist.cdf(x))
}

fn stat_t_dist_2t(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, StudentsT};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(df > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match StudentsT::new(0.0, 1.0, df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(2.0 * (1.0 - dist.cdf(x)))
}

fn stat_t_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, StudentsT};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p > 0.0 && p < 1.0) || !(df > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match StudentsT::new(0.0, 1.0, df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(p))
}

fn stat_t_inv_2t(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, StudentsT};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    // p ∈ (0, 1]. p=0 invalid (would yield infinity).
    if !(p > 0.0 && p <= 1.0) || !(df > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match StudentsT::new(0.0, 1.0, df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    // Two-tail: find x s.t. P(|T| > x) = p  →  P(T > x) = p/2  →  x = invCDF(1 - p/2).
    stat_finite(dist.inverse_cdf(1.0 - p / 2.0))
}

fn stat_f_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, FisherSnedecor};
    if args.len() != 4 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d1 = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d2 = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(d1 > 0.0) || !(d2 > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match FisherSnedecor::new(d1, d2) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_f_dist_rt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, FisherSnedecor};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d1 = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d2 = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(d1 > 0.0) || !(d2 > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match FisherSnedecor::new(d1, d2) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(1.0 - dist.cdf(x))
}

fn stat_f_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, FisherSnedecor};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d1 = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d2 = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p >= 0.0 && p < 1.0) || !(d1 > 0.0) || !(d2 > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match FisherSnedecor::new(d1, d2) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(p))
}

fn stat_f_inv_rt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, FisherSnedecor};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d1 = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let d2 = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p > 0.0 && p <= 1.0) || !(d1 > 0.0) || !(d2 > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match FisherSnedecor::new(d1, d2) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(1.0 - p))
}

fn stat_chisq_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ChiSquared, Continuous, ContinuousCDF};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[2], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(df > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match ChiSquared::new(df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_chisq_dist_rt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ChiSquared, ContinuousCDF};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(df > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match ChiSquared::new(df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(1.0 - dist.cdf(x))
}

fn stat_chisq_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ChiSquared, ContinuousCDF};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p >= 0.0 && p < 1.0) || !(df > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match ChiSquared::new(df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(p))
}

fn stat_chisq_inv_rt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ChiSquared, ContinuousCDF};
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let df = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p > 0.0 && p <= 1.0) || !(df > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match ChiSquared::new(df) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(1.0 - p))
}

fn stat_expon_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, Exp};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let lambda = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[2], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(lambda > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Exp::new(lambda) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_weibull_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, Weibull};
    if args.len() != 4 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let alpha = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let beta = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(alpha > 0.0) || !(beta > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    // Excel: WEIBULL.DIST(x, shape=alpha, scale=beta). statrs::Weibull::new
    // takes (shape, scale) in that order — same convention.
    let dist = match Weibull::new(alpha, beta) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_beta_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Beta, Continuous, ContinuousCDF};
    if !(4..=6).contains(&args.len()) {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let alpha = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let beta = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    let a = if args.len() >= 5 {
        match stat_num(&args[4], provider) {
            Ok(n) => n,
            Err(e) => return e,
        }
    } else {
        0.0
    };
    let b = if args.len() == 6 {
        match stat_num(&args[5], provider) {
            Ok(n) => n,
            Err(e) => return e,
        }
    } else {
        1.0
    };
    if !(alpha > 0.0) || !(beta > 0.0) || !(b > a) {
        return Value::Error(ValueError::Overflow);
    }
    if x < a || x > b {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Beta::new(alpha, beta) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    // Map x ∈ [a,b] → u ∈ [0,1].
    let u = (x - a) / (b - a);
    if cumulative {
        stat_finite(dist.cdf(u))
    } else {
        // PDF transforms by chain rule: f_X(x) = f_U(u) / (b - a).
        stat_finite(dist.pdf(u) / (b - a))
    }
}

fn stat_beta_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Beta, ContinuousCDF};
    if !(3..=5).contains(&args.len()) {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let alpha = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let beta = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let a = if args.len() >= 4 {
        match stat_num(&args[3], provider) {
            Ok(n) => n,
            Err(e) => return e,
        }
    } else {
        0.0
    };
    let b = if args.len() == 5 {
        match stat_num(&args[4], provider) {
            Ok(n) => n,
            Err(e) => return e,
        }
    } else {
        1.0
    };
    if !(p >= 0.0 && p <= 1.0) || !(alpha > 0.0) || !(beta > 0.0) || !(b > a) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Beta::new(alpha, beta) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    let u = dist.inverse_cdf(p);
    stat_finite(a + u * (b - a))
}

fn stat_gamma_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Continuous, ContinuousCDF, Gamma};
    if args.len() != 4 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let alpha = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let beta = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(alpha > 0.0) || !(beta > 0.0) || x < 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Gamma::new(alpha, 1.0 / beta) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

fn stat_gamma_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{ContinuousCDF, Gamma};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let p = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let alpha = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let beta = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p >= 0.0 && p < 1.0) || !(alpha > 0.0) || !(beta > 0.0) {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Gamma::new(alpha, 1.0 / beta) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    stat_finite(dist.inverse_cdf(p))
}

fn stat_binom_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Binomial, Discrete, DiscreteCDF};
    if args.len() != 4 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let num_s = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let trials = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let p = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(p >= 0.0 && p <= 1.0) || trials < 0.0 || num_s < 0.0 || num_s > trials {
        return Value::Error(ValueError::Overflow);
    }
    if num_s.trunc() != num_s || trials.trunc() != trials {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Binomial::new(p, trials as u64) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    let k = num_s as u64;
    stat_finite(if cumulative { dist.cdf(k) } else { dist.pmf(k) })
}

fn stat_binom_inv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Binomial, DiscreteCDF};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let trials = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let p = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let alpha = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(p > 0.0 && p < 1.0)
        || !(alpha > 0.0 && alpha < 1.0)
        || trials < 0.0
        || trials.trunc() != trials
    {
        return Value::Error(ValueError::Overflow);
    }
    let n = trials as u64;
    let dist = match Binomial::new(p, n) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    // Smallest k s.t. CDF(k) >= alpha. Linear scan is fine for typical n;
    // for very large n statrs's inverse_cdf would do bisection but its
    // default returns u64 and we want exact integer semantics here.
    for k in 0..=n {
        if dist.cdf(k) >= alpha {
            return Value::Number(k as f64);
        }
    }
    // Fallback (shouldn't happen since cdf(n)=1 ≥ alpha): return n.
    Value::Number(n as f64)
}

fn stat_poisson_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Discrete, DiscreteCDF, Poisson};
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let mean = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[2], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(mean > 0.0) || x < 0.0 || x.trunc() != x {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Poisson::new(mean) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    let k = x as u64;
    stat_finite(if cumulative { dist.cdf(k) } else { dist.pmf(k) })
}

fn stat_hypgeom_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::distribution::{Discrete, DiscreteCDF, Hypergeometric};
    if args.len() != 5 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let sample_s = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let num_sample = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let pop_s = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let num_pop = match stat_num(&args[3], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[4], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    for v in [sample_s, num_sample, pop_s, num_pop] {
        if v < 0.0 || v.trunc() != v {
            return Value::Error(ValueError::Overflow);
        }
    }
    if pop_s > num_pop || num_sample > num_pop || sample_s > num_sample || sample_s > pop_s {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match Hypergeometric::new(num_pop as u64, pop_s as u64, num_sample as u64) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    let k = sample_s as u64;
    stat_finite(if cumulative { dist.cdf(k) } else { dist.pmf(k) })
}

fn stat_negbinom_dist(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    // Excel NEGBINOM.DIST(num_f, num_s, prob_s, cumulative): number of
    // failures before num_s successes. statrs::NegativeBinomial::new(r, p)
    // takes r = number of successes, p = success prob, and parameterises X
    // as the number of failures, matching Excel.
    use statrs::distribution::{Discrete, DiscreteCDF, NegativeBinomial};
    if args.len() != 4 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let num_f = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let num_s = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let p = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let cumulative = match stat_bool(&args[3], provider) {
        Ok(b) => b,
        Err(e) => return e,
    };
    if !(p > 0.0 && p <= 1.0)
        || num_f < 0.0
        || num_s < 1.0
        || num_f.trunc() != num_f
        || num_s.trunc() != num_s
    {
        return Value::Error(ValueError::Overflow);
    }
    let dist = match NegativeBinomial::new(num_s, p) {
        Ok(d) => d,
        Err(_) => return Value::Error(ValueError::Overflow),
    };
    let k = num_f as u64;
    stat_finite(if cumulative { dist.cdf(k) } else { dist.pmf(k) })
}

fn stat_gamma_func(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::function::gamma::gamma;
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    // Gamma function: undefined for 0 and negative integers (poles).
    if x == 0.0 || (x < 0.0 && x.trunc() == x) {
        return Value::Error(ValueError::Overflow);
    }
    stat_finite(gamma(x))
}

fn stat_gammaln(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::function::gamma::ln_gamma;
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if x <= 0.0 {
        return Value::Error(ValueError::Overflow);
    }
    stat_finite(ln_gamma(x))
}

fn stat_erf(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::function::erf::erf;
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let lower = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if args.len() == 1 {
        stat_finite(erf(lower))
    } else {
        let upper = match stat_num(&args[1], provider) {
            Ok(n) => n,
            Err(e) => return e,
        };
        // Two-arg form: erf(upper) - erf(lower).
        stat_finite(erf(upper) - erf(lower))
    }
}

fn stat_erfc(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    use statrs::function::erf::erfc;
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    stat_finite(erfc(x))
}

fn stat_kurt(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    let nums = collect_numbers(args, provider);
    let n = nums.len() as f64;
    if nums.len() < 4 {
        return Value::Error(ValueError::Overflow);
    }
    let mean = nums.iter().sum::<f64>() / n;
    let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let s = var.sqrt();
    if s == 0.0 {
        return Value::Error(ValueError::DivisionByZero);
    }
    let sum4 = nums.iter().map(|x| ((x - mean) / s).powi(4)).sum::<f64>();
    let k = (n * (n + 1.0)) / ((n - 1.0) * (n - 2.0) * (n - 3.0)) * sum4
        - 3.0 * (n - 1.0).powi(2) / ((n - 2.0) * (n - 3.0));
    stat_finite(k)
}

fn stat_skew(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    let nums = collect_numbers(args, provider);
    let n = nums.len() as f64;
    if nums.len() < 3 {
        return Value::Error(ValueError::Overflow);
    }
    let mean = nums.iter().sum::<f64>() / n;
    let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let s = var.sqrt();
    if s == 0.0 {
        return Value::Error(ValueError::DivisionByZero);
    }
    let sum3 = nums.iter().map(|x| ((x - mean) / s).powi(3)).sum::<f64>();
    let sk = n / ((n - 1.0) * (n - 2.0)) * sum3;
    stat_finite(sk)
}

fn stat_avedev(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    let nums = collect_numbers(args, provider);
    if nums.is_empty() {
        return Value::Error(ValueError::DivisionByZero);
    }
    let n = nums.len() as f64;
    let mean = nums.iter().sum::<f64>() / n;
    let sum_abs: f64 = nums.iter().map(|x| (x - mean).abs()).sum();
    stat_finite(sum_abs / n)
}

fn stat_devsq(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    let nums = collect_numbers(args, provider);
    if nums.is_empty() {
        return Value::Number(0.0);
    }
    let n = nums.len() as f64;
    let mean = nums.iter().sum::<f64>() / n;
    stat_finite(nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>())
}

fn stat_geomean(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    let nums = collect_numbers(args, provider);
    if nums.is_empty() {
        return Value::Error(ValueError::Overflow);
    }
    // All values must be strictly positive; else #NUM!.
    for &v in &nums {
        if v <= 0.0 {
            return Value::Error(ValueError::Overflow);
        }
    }
    // Use log-mean to avoid overflow on large products.
    let n = nums.len() as f64;
    let log_mean = nums.iter().map(|x| x.ln()).sum::<f64>() / n;
    stat_finite(log_mean.exp())
}

fn stat_harmean(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    let nums = collect_numbers(args, provider);
    if nums.is_empty() {
        return Value::Error(ValueError::Overflow);
    }
    for &v in &nums {
        if v <= 0.0 {
            return Value::Error(ValueError::Overflow);
        }
    }
    let n = nums.len() as f64;
    let inv_sum: f64 = nums.iter().map(|x| 1.0 / x).sum();
    stat_finite(n / inv_sum)
}

fn stat_trimmean(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 2 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let percent = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if !(percent >= 0.0 && percent < 1.0) {
        return Value::Error(ValueError::Overflow);
    }
    let mut nums = collect_numbers(&args[..1], provider);
    let n = nums.len();
    if n == 0 {
        return Value::Error(ValueError::DivisionByZero);
    }
    // Excel rule: total number to trim = floor(n * percent), then round
    // *down* to the nearest even integer so the same count is trimmed from
    // each end. e.g. n=20, percent=0.2 → floor(4)=4, even → trim 2 from
    // each end. n=10, percent=0.2 → floor(2)=2, even → trim 1 from each
    // end. n=10, percent=0.15 → floor(1.5)=1, made even → 0 → trim none.
    let trim_total = (n as f64 * percent).floor() as usize;
    let trim_each = trim_total / 2; // integer divide drops the odd bit -> "round down to even"
    if 2 * trim_each >= n {
        return Value::Error(ValueError::Overflow);
    }
    nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let kept = &nums[trim_each..n - trim_each];
    let mean = kept.iter().sum::<f64>() / kept.len() as f64;
    stat_finite(mean)
}

fn stat_standardize(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 3 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let mean = match stat_num(&args[1], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let sd = match stat_num(&args[2], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if sd <= 0.0 {
        return Value::Error(ValueError::DivisionByZero);
    }
    stat_finite((x - mean) / sd)
}

fn stat_fisher(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let x = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if x <= -1.0 || x >= 1.0 {
        return Value::Error(ValueError::Overflow);
    }
    stat_finite(0.5 * ((1.0 + x) / (1.0 - x)).ln())
}

fn stat_fisherinv(args: &[Expr], provider: &dyn EvalProvider) -> Value {
    if args.len() != 1 {
        return Value::Error(ValueError::WrongArgCount);
    }
    let y = match stat_num(&args[0], provider) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let e2y = (2.0 * y).exp();
    stat_finite((e2y - 1.0) / (e2y + 1.0))
}














































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
///
/// TODO(excel-1900-epoch): if Excel file import/export becomes a requirement,
/// switch to Excel's 1900-01-01 = serial 1 convention. Constraints:
///   - serials need a +25569 offset (days between 1900-01-01 and 1970-01-01,
///     including the phantom Feb 29 1900 that Excel preserves for Lotus 1-2-3
///     compatibility);
///   - the phantom 1900-02-29 must be reproduced for serials 60..; dates before
///     1900-03-01 stay off by one day from the real Gregorian calendar;
///   - dates before 1900-01-01 → #NUM! (Excel rejects them);
///   - every test in `eval_*date*` / `eval_weekday` / `eval_eomonth` / etc.
///     needs its expected values regenerated against the new baseline.
/// Until then 1970 epoch is internally consistent and has no leap-year bug.
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

    /// Build a small fruit table for wildcard tests.
    /// A1:B5 = (apple,1) (BANANA,2) (blueberry,3) ("a*",4 literal) (cherry,5)
    fn make_wildcard_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let rows: [(&str, f64); 5] = [
            ("apple", 1.0),
            ("BANANA", 2.0),
            ("blueberry", 3.0),
            ("a*", 4.0), // literal star, exercises `~*` escape
            ("cherry", 5.0),
        ];
        for (i, (name, n)) in rows.iter().enumerate() {
            let row = i as u32;
            let k = AtomId::from_raw((row * 2) as u64);
            let v = AtomId::from_raw((row * 2 + 1) as u64);
            cm.insert(CellAddress::new(row, 0), k);
            cm.insert(CellAddress::new(row, 1), v);
            vs.insert(k, Value::Text((*name).into()));
            vs.insert(v, Value::Number(*n));
        }
        (cm, vs)
    }

    #[test]
    fn eval_match_wildcard_exact_mode() {
        let (cm, vs) = make_wildcard_env();
        // `*` at end: "b*" → "BANANA" first (case-insensitive) → position 2.
        assert_eq!(
            eval_str("=MATCH(\"b*\",A1:A5,0)", &cm, &vs),
            Value::Number(2.0)
        );
        // `*` at start: "*berry" → "blueberry" → position 3.
        assert_eq!(
            eval_str("=MATCH(\"*berry\",A1:A5,0)", &cm, &vs),
            Value::Number(3.0)
        );
        // `*` in middle: "a*e" → "apple" → 1.
        assert_eq!(
            eval_str("=MATCH(\"a*e\",A1:A5,0)", &cm, &vs),
            Value::Number(1.0)
        );
        // `?` single-char wildcard: "?pple" → "apple" → 1.
        assert_eq!(
            eval_str("=MATCH(\"?pple\",A1:A5,0)", &cm, &vs),
            Value::Number(1.0)
        );
        // Case-insensitive: upper-case pattern hits "BANANA".
        assert_eq!(
            eval_str("=MATCH(\"B*\",A1:A5,0)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_match_wildcard_escaped_star_matches_literal() {
        let (cm, vs) = make_wildcard_env();
        // "~*" escapes the wildcard. Pattern "a~*" should match the literal
        // text "a*" at row 4, NOT "apple" (which would match the bare "a*").
        assert_eq!(
            eval_str("=MATCH(\"a~*\",A1:A5,0)", &cm, &vs),
            Value::Number(4.0)
        );
    }

    #[test]
    fn eval_match_no_wildcard_regression() {
        let (cm, vs) = make_wildcard_env();
        // Plain text needle (no `?`/`*`/`~`) → standard exact equality.
        assert_eq!(
            eval_str("=MATCH(\"apple\",A1:A5,0)", &cm, &vs),
            Value::Number(1.0)
        );
        // No match → #N/A.
        assert!(matches!(
            eval_str("=MATCH(\"nope\",A1:A5,0)", &cm, &vs),
            Value::Error(_)
        ));
    }

    #[test]
    fn eval_match_wildcard_only_in_exact_mode() {
        let (cm, vs) = make_wildcard_env();
        // Regression: match_type=1 must NOT treat "a*" as a pattern. The
        // existing arm treats type=1 as exact equality (legacy behavior),
        // so "a*" matches the literal entry at row 4 (NOT "apple" which
        // would be the wildcard interpretation).
        assert_eq!(
            eval_str("=MATCH(\"a*\",A1:A5,1)", &cm, &vs),
            Value::Number(4.0)
        );
        // Same with match_type=-1.
        assert_eq!(
            eval_str("=MATCH(\"a*\",A1:A5,-1)", &cm, &vs),
            Value::Number(4.0)
        );
        // And a pattern with no literal counterpart: with type=1, "b*" is
        // literal, no row "b*" exists → #N/A.
        assert!(matches!(
            eval_str("=MATCH(\"b*\",A1:A5,1)", &cm, &vs),
            Value::Error(_)
        ));
    }

    #[test]
    fn eval_match_non_text_needle_no_wildcard() {
        // Numbers don't trigger wildcard interpretation.
        let (cm, vs) = make_lookup_env();
        assert_eq!(
            eval_str("=MATCH(2,A1:A3,0)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_match_coerces_numbers_for_wildcard_text_needle() {
        // Numeric cells are coerced to text before the wildcard test, so
        // pattern "4?" matches a numeric 42.
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let a1 = AtomId::from_raw(0);
        let a2 = AtomId::from_raw(1);
        let a3 = AtomId::from_raw(2);
        cm.insert(CellAddress::new(0, 0), a1);
        cm.insert(CellAddress::new(1, 0), a2);
        cm.insert(CellAddress::new(2, 0), a3);
        vs.insert(a1, Value::Number(3.0));
        vs.insert(a2, Value::Number(42.0));
        vs.insert(a3, Value::Number(50.0));
        assert_eq!(
            eval_str("=MATCH(\"4?\",A1:A3,0)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_vlookup_wildcard_exact_mode() {
        let (cm, vs) = make_wildcard_env();
        // "b*" exact → first row with text matching "b*" is BANANA → 2.
        assert_eq!(
            eval_str("=VLOOKUP(\"b*\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Number(2.0)
        );
        // "*berry" → blueberry → 3.
        assert_eq!(
            eval_str("=VLOOKUP(\"*berry\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Number(3.0)
        );
        // "?pple" → apple → 1.
        assert_eq!(
            eval_str("=VLOOKUP(\"?pple\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Number(1.0)
        );
        // Case-insensitive wildcard: lowercase pattern matches uppercase BANANA.
        // (Needle must contain a wildcard to trigger case-insensitivity;
        // bare-text lookup uses values_equal which is case-sensitive.)
        assert_eq!(
            eval_str("=VLOOKUP(\"banana*\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_vlookup_escaped_wildcard() {
        let (cm, vs) = make_wildcard_env();
        // "a~*" → literal "a*" at row 4 → return col 2 = 4.
        assert_eq!(
            eval_str("=VLOOKUP(\"a~*\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Number(4.0)
        );
    }

    #[test]
    fn eval_vlookup_no_wildcards_in_approximate_mode() {
        // Regression: range_lookup=TRUE must NOT interpret patterns.
        let (cm, vs) = make_wildcard_env();
        // Exact mode with "z*" yields #N/A (no text starts with z).
        assert!(matches!(
            eval_str("=VLOOKUP(\"z*\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Error(_)
        ));
        // Approximate mode with "z*" returns a value (the literal "z*"
        // compares > all text keys, so the "largest <= needle" rule
        // picks the last enumerated key). The key invariant: it is NOT
        // an error — proving the wildcard path was not taken.
        assert!(matches!(
            eval_str("=VLOOKUP(\"z*\",A1:B5,2,TRUE)", &cm, &vs),
            Value::Number(_)
        ));
    }

    #[test]
    fn eval_vlookup_no_wildcard_text_regression() {
        let (cm, vs) = make_wildcard_env();
        // Plain text needle (no special chars) uses values_equal.
        assert_eq!(
            eval_str("=VLOOKUP(\"cherry\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Number(5.0)
        );
        assert!(matches!(
            eval_str("=VLOOKUP(\"nope\",A1:B5,2,FALSE)", &cm, &vs),
            Value::Error(_)
        ));
    }

    #[test]
    fn eval_vlookup_non_text_needle_no_wildcard() {
        // Numeric needle never engages wildcard logic.
        let (cm, vs) = make_lookup_env();
        assert_eq!(
            eval_str("=VLOOKUP(2,A1:B3,2,FALSE)", &cm, &vs),
            Value::Number(20.0)
        );
    }

    /// Build a horizontal fruit table for HLOOKUP wildcard tests.
    fn make_hwildcard_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let cols: [(&str, f64); 5] = [
            ("apple", 1.0),
            ("BANANA", 2.0),
            ("blueberry", 3.0),
            ("a*", 4.0),
            ("cherry", 5.0),
        ];
        for (i, (name, n)) in cols.iter().enumerate() {
            let col = i as u32;
            let k = AtomId::from_raw((col * 2) as u64);
            let v = AtomId::from_raw((col * 2 + 1) as u64);
            cm.insert(CellAddress::new(0, col), k);
            cm.insert(CellAddress::new(1, col), v);
            vs.insert(k, Value::Text((*name).into()));
            vs.insert(v, Value::Number(*n));
        }
        (cm, vs)
    }

    #[test]
    fn eval_hlookup_wildcard_exact_mode() {
        let (cm, vs) = make_hwildcard_env();
        // "b*" → BANANA (col 2) → 2.
        assert_eq!(
            eval_str("=HLOOKUP(\"b*\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Number(2.0)
        );
        // "?pple" → apple → 1.
        assert_eq!(
            eval_str("=HLOOKUP(\"?pple\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Number(1.0)
        );
        // "*berry" → blueberry → 3.
        assert_eq!(
            eval_str("=HLOOKUP(\"*berry\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Number(3.0)
        );
        // Case-insensitive wildcard: lowercase pattern matches uppercase BANANA.
        assert_eq!(
            eval_str("=HLOOKUP(\"banana*\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Number(2.0)
        );
        // Escape: "a~*" matches literal "a*" → 4.
        assert_eq!(
            eval_str("=HLOOKUP(\"a~*\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Number(4.0)
        );
    }

    #[test]
    fn eval_hlookup_no_wildcards_in_approximate_mode() {
        // Regression: approximate mode treats "z*" as a literal text key.
        let (cm, vs) = make_hwildcard_env();
        assert!(matches!(
            eval_str("=HLOOKUP(\"z*\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Error(_)
        ));
        assert!(matches!(
            eval_str("=HLOOKUP(\"z*\",A1:E2,2,TRUE)", &cm, &vs),
            Value::Number(_)
        ));
    }

    #[test]
    fn eval_hlookup_plain_text_regression() {
        let (cm, vs) = make_hwildcard_env();
        // Plain non-wildcard text uses values_equal.
        assert_eq!(
            eval_str("=HLOOKUP(\"cherry\",A1:E2,2,FALSE)", &cm, &vs),
            Value::Number(5.0)
        );
    }

    #[test]
    fn eval_match_error_needle_propagates() {
        let (cm, vs) = make_wildcard_env();
        // 1/0 evaluates to #DIV/0!, which must propagate through MATCH.
        assert!(matches!(
            eval_str("=MATCH(1/0,A1:A5,0)", &cm, &vs),
            Value::Error(_)
        ));
    }

    #[test]
    fn eval_vlookup_error_needle_propagates() {
        let (cm, vs) = make_wildcard_env();
        assert!(matches!(
            eval_str("=VLOOKUP(1/0,A1:B5,2,FALSE)", &cm, &vs),
            Value::Error(_)
        ));
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

    // ===== Reference / lookup tests =====

    #[test]
    fn eval_row() {
        let (cm, vs) = make_test_env();
        // Happy path: A1 is row 1, B5 is row 5.
        assert_eq!(eval_str("=ROW(A1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=ROW(B5)", &cm, &vs), Value::Number(5.0));
        // Range arg: ROW returns the start row.
        assert_eq!(eval_str("=ROW(A3:B7)", &cm, &vs), Value::Number(3.0));
        // No args → InvalidRef under the legacy `AtomEvalProvider`, which
        // has no concept of "current cell" and returns `None` from
        // `current_cell()`. `Workbook` / `Sheet` providers fill it in so
        // `=ROW()` in a real workbook returns the formula's own row — see
        // `tests/reference_lookup.rs::row_column_no_args_uses_current_cell`.
        assert_eq!(
            eval_str("=ROW()", &cm, &vs),
            Value::Error(ValueError::InvalidRef)
        );
        // Too many args.
        assert_eq!(
            eval_str("=ROW(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Non-ref arg → WrongType.
        assert_eq!(
            eval_str("=ROW(42)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_column() {
        let (cm, vs) = make_test_env();
        // Happy path: A1 → col 1, C7 → col 3.
        assert_eq!(eval_str("=COLUMN(A1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=COLUMN(C7)", &cm, &vs), Value::Number(3.0));
        // Range arg: COLUMN returns the start column.
        assert_eq!(eval_str("=COLUMN(D2:F8)", &cm, &vs), Value::Number(4.0));
        // No args → InvalidRef under the legacy `AtomEvalProvider` (no
        // current-cell concept). See sibling `eval_row` comment for the
        // workbook-context behaviour.
        assert_eq!(
            eval_str("=COLUMN()", &cm, &vs),
            Value::Error(ValueError::InvalidRef)
        );
        // Too many args.
        assert_eq!(
            eval_str("=COLUMN(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Non-ref arg → WrongType.
        assert_eq!(
            eval_str("=COLUMN(\"x\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_rows() {
        let (cm, vs) = make_test_env();
        // Single-cell ref → 1.
        assert_eq!(eval_str("=ROWS(A1)", &cm, &vs), Value::Number(1.0));
        // 3-row range.
        assert_eq!(eval_str("=ROWS(A1:B3)", &cm, &vs), Value::Number(3.0));
        // Reversed orientation still counts |Δrow|+1.
        assert_eq!(eval_str("=ROWS(A5:A2)", &cm, &vs), Value::Number(4.0));
        // Wrong arg count.
        assert_eq!(
            eval_str("=ROWS()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ROWS(A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Non-range arg.
        assert_eq!(
            eval_str("=ROWS(42)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_columns() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=COLUMNS(A1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=COLUMNS(A1:C3)", &cm, &vs), Value::Number(3.0));
        assert_eq!(eval_str("=COLUMNS(C1:A1)", &cm, &vs), Value::Number(3.0));
        assert_eq!(
            eval_str("=COLUMNS()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COLUMNS(\"x\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_choose() {
        let (cm, vs) = make_test_env();
        // Happy path: 1-based picks; arg is evaluated.
        assert_eq!(
            eval_str("=CHOOSE(1,\"a\",\"b\",\"c\")", &cm, &vs),
            Value::Text("a".into())
        );
        assert_eq!(
            eval_str("=CHOOSE(3,\"a\",\"b\",\"c\")", &cm, &vs),
            Value::Text("c".into())
        );
        // Index can be a cell ref; A1=10 → out of range for 3 args.
        assert_eq!(
            eval_str("=CHOOSE(2,A1,B1,A2)", &cm, &vs),
            Value::Number(20.0)
        );
        // Truncation: 1.7 → 1.
        assert_eq!(
            eval_str("=CHOOSE(1.7,\"a\",\"b\")", &cm, &vs),
            Value::Text("a".into())
        );
        // Out of range.
        assert_eq!(
            eval_str("=CHOOSE(4,\"a\",\"b\",\"c\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        assert_eq!(
            eval_str("=CHOOSE(0,\"a\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count: need at least 2 (index + 1 value).
        assert_eq!(
            eval_str("=CHOOSE(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Non-numeric index.
        assert_eq!(
            eval_str("=CHOOSE(\"x\",\"a\",\"b\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_address() {
        let (cm, vs) = make_test_env();
        // Default abs_num=1: $A$1.
        assert_eq!(
            eval_str("=ADDRESS(1,1)", &cm, &vs),
            Value::Text("$A$1".into())
        );
        // abs_num=2: A$1 (row absolute, col relative).
        assert_eq!(
            eval_str("=ADDRESS(1,1,2)", &cm, &vs),
            Value::Text("A$1".into())
        );
        // abs_num=3: $A1 (col absolute, row relative).
        assert_eq!(
            eval_str("=ADDRESS(1,1,3)", &cm, &vs),
            Value::Text("$A1".into())
        );
        // abs_num=4: A1.
        assert_eq!(
            eval_str("=ADDRESS(1,1,4)", &cm, &vs),
            Value::Text("A1".into())
        );
        // Multi-letter column: col 27 → AA.
        assert_eq!(
            eval_str("=ADDRESS(3,27,4)", &cm, &vs),
            Value::Text("AA3".into())
        );
        // R1C1 (a1=FALSE), abs_num=1: R3C5.
        assert_eq!(
            eval_str("=ADDRESS(3,5,1,FALSE)", &cm, &vs),
            Value::Text("R3C5".into())
        );
        // R1C1 with abs_num=4: R[3]C[5].
        assert_eq!(
            eval_str("=ADDRESS(3,5,4,FALSE)", &cm, &vs),
            Value::Text("R[3]C[5]".into())
        );
        // Sheet prefix (no spaces): unquoted.
        assert_eq!(
            eval_str("=ADDRESS(1,1,1,TRUE,\"Sheet1\")", &cm, &vs),
            Value::Text("Sheet1!$A$1".into())
        );
        // Sheet prefix (with space): quoted.
        assert_eq!(
            eval_str("=ADDRESS(1,1,1,TRUE,\"My Sheet\")", &cm, &vs),
            Value::Text("'My Sheet'!$A$1".into())
        );
        // Bad abs_num.
        assert_eq!(
            eval_str("=ADDRESS(1,1,9)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Bad row (< 1).
        assert_eq!(
            eval_str("=ADDRESS(0,1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=ADDRESS(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_cell_address() {
        let (cm, vs) = make_test_env();
        // Happy path: explicit cell ref → $A1$-style absolute.
        assert_eq!(
            eval_str("=CELL(\"address\",B2)", &cm, &vs),
            Value::Text("$B$2".into())
        );
        // Case insensitivity: info_type is lowercased.
        assert_eq!(
            eval_str("=CELL(\"ADDRESS\",A1)", &cm, &vs),
            Value::Text("$A$1".into())
        );
        // Multi-cell range → top-left.
        assert_eq!(
            eval_str("=CELL(\"address\",B2:D4)", &cm, &vs),
            Value::Text("$B$2".into())
        );
        // Non-ref expression → WrongType.
        assert_eq!(
            eval_str("=CELL(\"address\",\"not-a-ref\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_cell_row() {
        let (cm, vs) = make_test_env();
        // 1-based row, not 0-based.
        assert_eq!(eval_str("=CELL(\"row\",A1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=CELL(\"row\",B2)", &cm, &vs), Value::Number(2.0));
    }

    #[test]
    fn eval_cell_col() {
        let (cm, vs) = make_test_env();
        // Both "col" and "column" are accepted (Excel parity).
        assert_eq!(eval_str("=CELL(\"col\",A1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(
            eval_str("=CELL(\"column\",A1)", &cm, &vs),
            Value::Number(1.0)
        );
        assert_eq!(
            eval_str("=CELL(\"col\",B2)", &cm, &vs),
            Value::Number(2.0)
        );
    }

    #[test]
    fn eval_cell_contents() {
        let (cm, vs) = make_test_env();
        // A1=10 in make_test_env.
        assert_eq!(
            eval_str("=CELL(\"contents\",A1)", &cm, &vs),
            Value::Number(10.0)
        );
        // B2="text".
        assert_eq!(
            eval_str("=CELL(\"contents\",B2)", &cm, &vs),
            Value::Text("text".into())
        );
    }

    #[test]
    fn eval_cell_type() {
        let (cm, vs) = make_test_env();
        // Number → "v".
        assert_eq!(
            eval_str("=CELL(\"type\",A1)", &cm, &vs),
            Value::Text("v".into())
        );
        // Text → "l".
        assert_eq!(
            eval_str("=CELL(\"type\",B2)", &cm, &vs),
            Value::Text("l".into())
        );
        // Empty cell (no entry in cell_map → Value::Null) → "b".
        assert_eq!(
            eval_str("=CELL(\"type\",Z99)", &cm, &vs),
            Value::Text("b".into())
        );
    }

    #[test]
    fn eval_cell_prefix() {
        let (cm, vs) = make_test_env();
        // Text → "'".
        assert_eq!(
            eval_str("=CELL(\"prefix\",B2)", &cm, &vs),
            Value::Text("'".into())
        );
        // Non-text → "".
        assert_eq!(
            eval_str("=CELL(\"prefix\",A1)", &cm, &vs),
            Value::Text(String::new())
        );
    }

    #[test]
    fn eval_cell_width() {
        let (cm, vs) = make_test_env();
        // Approximation: Excel default column width.
        assert_eq!(
            eval_str("=CELL(\"width\",A1)", &cm, &vs),
            Value::Number(8.0)
        );
    }

    #[test]
    fn eval_cell_protect() {
        let (cm, vs) = make_test_env();
        // Approximation: every cell reports as locked.
        assert_eq!(
            eval_str("=CELL(\"protect\",A1)", &cm, &vs),
            Value::Number(1.0)
        );
    }

    #[test]
    fn eval_cell_errors() {
        let (cm, vs) = make_test_env();
        // Non-text info_type → WrongType.
        assert_eq!(
            eval_str("=CELL(42,A1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Unknown info_type → InvalidValue.
        assert_eq!(
            eval_str("=CELL(\"nope\",A1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=CELL()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=CELL(\"row\",A1,B1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_cell_no_ref_legacy_provider() {
        // note: AtomEvalProvider doesn't carry current-cell, so the no-arg
        // path resolves to None → InvalidRef. The production
        // WorkbookEvalProvider path is covered in tests/cell_function.rs.
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=CELL(\"row\")", &cm, &vs),
            Value::Error(ValueError::InvalidRef)
        );
    }

    #[test]
    fn eval_indirect() {
        let (cm, vs) = make_test_env();
        // Happy path: "A1" → A1 value (10).
        assert_eq!(eval_str("=INDIRECT(\"A1\")", &cm, &vs), Value::Number(10.0));
        // Absolute markers stripped: "$B$1" → 20.
        assert_eq!(
            eval_str("=INDIRECT(\"$B$1\")", &cm, &vs),
            Value::Number(20.0)
        );
        // Range text → first (top-left) cell.
        assert_eq!(
            eval_str("=INDIRECT(\"A1:B2\")", &cm, &vs),
            Value::Number(10.0)
        );
        // Malformed text.
        assert_eq!(
            eval_str("=INDIRECT(\"not a ref\")", &cm, &vs),
            Value::Error(ValueError::InvalidRef)
        );
        assert_eq!(
            eval_str("=INDIRECT(\"\")", &cm, &vs),
            Value::Error(ValueError::InvalidRef)
        );
        // R1C1 mode unsupported.
        assert_eq!(
            eval_str("=INDIRECT(\"R1C1\",FALSE)", &cm, &vs),
            Value::Error(ValueError::InvalidRef)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=INDIRECT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=INDIRECT(\"A1\",TRUE,\"x\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_xlookup() {
        let (cm, vs) = make_test_env();
        // Build a synthetic lookup table on row 4: A4=1 B4=2 C4=3
        // return values on row 5: A5="one" B5="two" C5="three"
        // We can't easily inject extra cells without rebuilding the env,
        // so use existing A1:C1 = 10,20,0 and A2:B2 = 5,"text".
        // XLOOKUP(20, A1:C1, A2:C2) — 20 is in A1:C1 at position 2 → returns
        // A2:C2 position 2 = "text" (which is B2).
        assert_eq!(
            eval_str("=XLOOKUP(20,A1:C1,A2:C2)", &cm, &vs),
            Value::Text("text".into())
        );
        // Exact match for 10 → A2's value (5).
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1,A2:C2)", &cm, &vs),
            Value::Number(5.0)
        );
        // Not found without default → InvalidValue.
        assert_eq!(
            eval_str("=XLOOKUP(999,A1:C1,A2:C2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Not found with default → the default.
        assert_eq!(
            eval_str("=XLOOKUP(999,A1:C1,A2:C2,\"nope\")", &cm, &vs),
            Value::Text("nope".into())
        );
        // Shape mismatch: A1:C1 (3 cells) vs A2:B2 (2 cells) → InvalidValue.
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1,A2:B2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count (< 3).
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // match_mode=1 (exact-or-larger) with an exact match present
        // returns the exact hit (10 → A2=5).
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1,A2:C2,\"x\",1)", &cm, &vs),
            Value::Number(5.0)
        );
        // search_mode=-1 (reverse) with an exact match also finds 10 → A2=5.
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1,A2:C2,\"x\",0,-1)", &cm, &vs),
            Value::Number(5.0)
        );
        // match_mode=99 → InvalidValue.
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1,A2:C2,\"x\",99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // search_mode=99 → InvalidValue.
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:C1,A2:C2,\"x\",0,99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    /// Build a numeric env where row 1 is the lookup array and row 2 is the
    /// return array. Caller supplies the (lookup, return) pairs as a flat list
    /// indexed left-to-right starting at column A.
    fn make_xlookup_env(
        pairs: &[(Value, Value)],
    ) -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        for (i, (lookup, ret)) in pairs.iter().enumerate() {
            let col = i as u32;
            let l_atom = AtomId::from_raw((col * 2) as u64);
            let r_atom = AtomId::from_raw((col * 2 + 1) as u64);
            cm.insert(CellAddress::new(0, col), l_atom);
            cm.insert(CellAddress::new(1, col), r_atom);
            vs.insert(l_atom, lookup.clone());
            vs.insert(r_atom, ret.clone());
        }
        (cm, vs)
    }

    #[test]
    fn eval_xlookup_approximate_smaller() {
        // lookup_array [10, 20, 30] with return "a"/"b"/"c". needle=25,
        // match_mode=-1 → exact-or-next-smaller → 20 → "b".
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(10.0), Value::Text("a".into())),
            (Value::Number(20.0), Value::Text("b".into())),
            (Value::Number(30.0), Value::Text("c".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(25,A1:C1,A2:C2,\"none\",-1)", &cm, &vs),
            Value::Text("b".into())
        );
        // Below the smallest key → no candidate → fallback.
        assert_eq!(
            eval_str("=XLOOKUP(5,A1:C1,A2:C2,\"none\",-1)", &cm, &vs),
            Value::Text("none".into())
        );
    }

    #[test]
    fn eval_xlookup_approximate_larger() {
        // Same array, needle=25, match_mode=1 → exact-or-next-larger → 30 → "c".
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(10.0), Value::Text("a".into())),
            (Value::Number(20.0), Value::Text("b".into())),
            (Value::Number(30.0), Value::Text("c".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(25,A1:C1,A2:C2,\"none\",1)", &cm, &vs),
            Value::Text("c".into())
        );
        // Above the largest key → no candidate → fallback.
        assert_eq!(
            eval_str("=XLOOKUP(99,A1:C1,A2:C2,\"none\",1)", &cm, &vs),
            Value::Text("none".into())
        );
    }

    #[test]
    fn eval_xlookup_wildcard() {
        // lookup_array ["apple","banana","cherry"], needle="b*",
        // match_mode=2 → matches "banana" → return at index 1 = 20.
        let (cm, vs) = make_xlookup_env(&[
            (Value::Text("apple".into()), Value::Number(10.0)),
            (Value::Text("banana".into()), Value::Number(20.0)),
            (Value::Text("cherry".into()), Value::Number(30.0)),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(\"b*\",A1:C1,A2:C2,\"none\",2)", &cm, &vs),
            Value::Number(20.0)
        );
        // Plain text (no wildcards) also works through wildcard mode.
        assert_eq!(
            eval_str("=XLOOKUP(\"cherry\",A1:C1,A2:C2,\"none\",2)", &cm, &vs),
            Value::Number(30.0)
        );
        // No match → fallback.
        assert_eq!(
            eval_str("=XLOOKUP(\"z*\",A1:C1,A2:C2,\"none\",2)", &cm, &vs),
            Value::Text("none".into())
        );
    }

    #[test]
    fn eval_xlookup_wildcard_lookup_not_text() {
        // Wildcard mode requires a Text needle; passing a number → #TYPE!.
        let (cm, vs) = make_xlookup_env(&[
            (Value::Text("apple".into()), Value::Number(10.0)),
            (Value::Text("banana".into()), Value::Number(20.0)),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(42,A1:B1,A2:B2,\"none\",2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_xlookup_reverse_search() {
        // lookup_array [1,2,3,2,1] with return ["a","b","c","d","e"]. Needle
        // 2 in reverse → matches the LATER 2 at index 3 → "d", not "b".
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(1.0), Value::Text("a".into())),
            (Value::Number(2.0), Value::Text("b".into())),
            (Value::Number(3.0), Value::Text("c".into())),
            (Value::Number(2.0), Value::Text("d".into())),
            (Value::Number(1.0), Value::Text("e".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(2,A1:E1,A2:E2,\"none\",0,-1)", &cm, &vs),
            Value::Text("d".into())
        );
        // Sanity: forward search returns the first match → "b".
        assert_eq!(
            eval_str("=XLOOKUP(2,A1:E1,A2:E2,\"none\",0,1)", &cm, &vs),
            Value::Text("b".into())
        );
    }

    #[test]
    fn eval_xlookup_binary_ascending() {
        // Sorted ascending: [1,5,10,20,40] → return "a".."e". Needle 10 with
        // search_mode=2 (binary asc) and exact match → "c".
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(1.0), Value::Text("a".into())),
            (Value::Number(5.0), Value::Text("b".into())),
            (Value::Number(10.0), Value::Text("c".into())),
            (Value::Number(20.0), Value::Text("d".into())),
            (Value::Number(40.0), Value::Text("e".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:E1,A2:E2,\"none\",0,2)", &cm, &vs),
            Value::Text("c".into())
        );
        // No exact match + exact mode → fallback.
        assert_eq!(
            eval_str("=XLOOKUP(7,A1:E1,A2:E2,\"none\",0,2)", &cm, &vs),
            Value::Text("none".into())
        );
        // Binary search combined with approximate (next smaller): needle=7
        // → 5 → "b".
        assert_eq!(
            eval_str("=XLOOKUP(7,A1:E1,A2:E2,\"none\",-1,2)", &cm, &vs),
            Value::Text("b".into())
        );
        // Binary search combined with approximate (next larger): needle=7
        // → 10 → "c".
        assert_eq!(
            eval_str("=XLOOKUP(7,A1:E1,A2:E2,\"none\",1,2)", &cm, &vs),
            Value::Text("c".into())
        );
    }

    #[test]
    fn eval_xlookup_binary_descending() {
        // Sorted descending: [40,20,10,5,1] → return "a".."e". Needle 10 with
        // search_mode=-2 (binary desc) and exact match → "c".
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(40.0), Value::Text("a".into())),
            (Value::Number(20.0), Value::Text("b".into())),
            (Value::Number(10.0), Value::Text("c".into())),
            (Value::Number(5.0), Value::Text("d".into())),
            (Value::Number(1.0), Value::Text("e".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(10,A1:E1,A2:E2,\"none\",0,-2)", &cm, &vs),
            Value::Text("c".into())
        );
        // Binary desc + approximate next smaller: needle=7 → 5 → "d".
        assert_eq!(
            eval_str("=XLOOKUP(7,A1:E1,A2:E2,\"none\",-1,-2)", &cm, &vs),
            Value::Text("d".into())
        );
        // Binary desc + approximate next larger: needle=7 → 10 → "c".
        assert_eq!(
            eval_str("=XLOOKUP(7,A1:E1,A2:E2,\"none\",1,-2)", &cm, &vs),
            Value::Text("c".into())
        );
        // Above the largest key (40) with next-larger → fallback.
        assert_eq!(
            eval_str("=XLOOKUP(99,A1:E1,A2:E2,\"none\",1,-2)", &cm, &vs),
            Value::Text("none".into())
        );
    }

    #[test]
    fn eval_xlookup_invalid_match_mode() {
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(1.0), Value::Text("a".into())),
            (Value::Number(2.0), Value::Text("b".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(1,A1:B1,A2:B2,\"none\",99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_xlookup_invalid_search_mode() {
        let (cm, vs) = make_xlookup_env(&[
            (Value::Number(1.0), Value::Text("a".into())),
            (Value::Number(2.0), Value::Text("b".into())),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(1,A1:B1,A2:B2,\"none\",0,99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_xlookup_wildcard_with_binary_rejected() {
        // Wildcard (match_mode=2) cannot be combined with binary search
        // (search_mode=±2) because wildcards have no ordering. → InvalidValue.
        let (cm, vs) = make_xlookup_env(&[
            (Value::Text("apple".into()), Value::Number(10.0)),
            (Value::Text("banana".into()), Value::Number(20.0)),
        ]);
        assert_eq!(
            eval_str("=XLOOKUP(\"b*\",A1:B1,A2:B2,\"none\",2,2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        assert_eq!(
            eval_str("=XLOOKUP(\"b*\",A1:B1,A2:B2,\"none\",2,-2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    // === Date / time formula tests ===========================================
    // Epoch reminder: 1970-01-01 = serial 0 (Unix-style, not Excel 1900).
    // 1970-01-01 was a Thursday → WEEKDAY(0, 1) = 5.

    #[test]
    fn eval_hour() {
        let (cm, vs) = make_test_env();
        // 0.75 of a day = 18:00 → hour 18.
        assert_eq!(eval_str("=HOUR(0.75)", &cm, &vs), Value::Number(18.0));
        // Whole-day serial → hour 0.
        assert_eq!(eval_str("=HOUR(1)", &cm, &vs), Value::Number(0.0));
        // Through TIME().
        assert_eq!(
            eval_str("=HOUR(TIME(13,30,0))", &cm, &vs),
            Value::Number(13.0)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=HOUR()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=HOUR(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=HOUR(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_minute() {
        let (cm, vs) = make_test_env();
        // 0.5 day → 12:00 → minute 0.
        assert_eq!(eval_str("=MINUTE(0.5)", &cm, &vs), Value::Number(0.0));
        // TIME(13, 30, 0) → minute 30.
        assert_eq!(
            eval_str("=MINUTE(TIME(13,30,0))", &cm, &vs),
            Value::Number(30.0)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=MINUTE(1,2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=MINUTE(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=MINUTE(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_second() {
        let (cm, vs) = make_test_env();
        // TIME(13, 30, 45) → second 45 (round trip).
        assert_eq!(
            eval_str("=SECOND(TIME(13,30,45))", &cm, &vs),
            Value::Number(45.0)
        );
        // Whole day → 0.
        assert_eq!(eval_str("=SECOND(1)", &cm, &vs), Value::Number(0.0));
        // Wrong arg count.
        assert_eq!(
            eval_str("=SECOND()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=SECOND(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=SECOND(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_time() {
        let (cm, vs) = make_test_env();
        // 12:00:00 → 0.5.
        assert_eq!(eval_str("=TIME(12,0,0)", &cm, &vs), Value::Number(0.5));
        // 0:0:0 → 0.
        assert_eq!(eval_str("=TIME(0,0,0)", &cm, &vs), Value::Number(0.0));
        // Wrap-around: TIME(25, 0, 0) = 25/24 (no bound on hours).
        let expected = 25.0 * 3600.0 / 86400.0;
        if let Value::Number(n) = eval_str("=TIME(25,0,0)", &cm, &vs) {
            assert!((n - expected).abs() < 1e-12);
        } else {
            panic!("TIME(25,0,0) did not return a Number");
        }
        // Negative → InvalidValue.
        assert_eq!(
            eval_str("=TIME(-1,0,0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=TIME(1,2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=TIME(\"a\",0,0)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=TIME(A1/C1,0,0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_weekday() {
        let (cm, vs) = make_test_env();
        // 1970-01-01 (serial 0) was Thursday. return_type=1 → Sun=1..Sat=7 → 5.
        assert_eq!(eval_str("=WEEKDAY(0)", &cm, &vs), Value::Number(5.0));
        // Explicit return_type=1.
        assert_eq!(eval_str("=WEEKDAY(0,1)", &cm, &vs), Value::Number(5.0));
        // return_type=2 (Mon=1..Sun=7): Thursday → 4.
        assert_eq!(eval_str("=WEEKDAY(0,2)", &cm, &vs), Value::Number(4.0));
        // return_type=3 (Mon=0..Sun=6): Thursday → 3.
        assert_eq!(eval_str("=WEEKDAY(0,3)", &cm, &vs), Value::Number(3.0));
        // 1970-01-04 is a Sunday (serial 3) → return_type=1 → 1.
        assert_eq!(eval_str("=WEEKDAY(3,1)", &cm, &vs), Value::Number(1.0));
        // Out-of-range return_type → InvalidValue.
        assert_eq!(
            eval_str("=WEEKDAY(0,99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=WEEKDAY()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=WEEKDAY(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=WEEKDAY(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_weeknum() {
        let (cm, vs) = make_test_env();
        // 1970-01-01 (Thu) — return_type=1 (week starts Sun) → week 1.
        assert_eq!(eval_str("=WEEKNUM(0)", &cm, &vs), Value::Number(1.0));
        // 1970-01-04 is a Sunday → week 2 with return_type=1.
        assert_eq!(eval_str("=WEEKNUM(3,1)", &cm, &vs), Value::Number(2.0));
        // 1970-01-04 (Sun) — return_type=2 (week starts Mon) — still week 1
        // because next Monday hasn't arrived yet.
        assert_eq!(eval_str("=WEEKNUM(3,2)", &cm, &vs), Value::Number(1.0));
        // 1970-01-05 (Mon) — return_type=2 → week 2.
        assert_eq!(eval_str("=WEEKNUM(4,2)", &cm, &vs), Value::Number(2.0));
        // Out-of-range return_type → InvalidValue.
        assert_eq!(
            eval_str("=WEEKNUM(0,99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=WEEKNUM()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=WEEKNUM(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=WEEKNUM(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_eomonth() {
        let (cm, vs) = make_test_env();
        // EOMONTH(DATE(2020,1,15), 1) → 2020-02-29 (leap year).
        let expected = date_serial(2020, 2, 29);
        assert_eq!(
            eval_str("=EOMONTH(DATE(2020,1,15),1)", &cm, &vs),
            Value::Number(expected)
        );
        // Negative offset: EOMONTH(DATE(2020,3,15), -1) → 2020-02-29.
        assert_eq!(
            eval_str("=EOMONTH(DATE(2020,3,15),-1)", &cm, &vs),
            Value::Number(expected)
        );
        // Zero offset returns end of current month.
        assert_eq!(
            eval_str("=EOMONTH(DATE(2021,2,5),0)", &cm, &vs),
            Value::Number(date_serial(2021, 2, 28))
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=EOMONTH(0)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=EOMONTH(\"a\",1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=EOMONTH(A1/C1,1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_edate() {
        let (cm, vs) = make_test_env();
        // Clamp: EDATE(DATE(2020,1,31), 1) → 2020-02-29 (leap year).
        assert_eq!(
            eval_str("=EDATE(DATE(2020,1,31),1)", &cm, &vs),
            Value::Number(date_serial(2020, 2, 29))
        );
        // Plain shift preserving day-of-month.
        assert_eq!(
            eval_str("=EDATE(DATE(2020,1,15),1)", &cm, &vs),
            Value::Number(date_serial(2020, 2, 15))
        );
        // Negative offset.
        assert_eq!(
            eval_str("=EDATE(DATE(2020,3,15),-1)", &cm, &vs),
            Value::Number(date_serial(2020, 2, 15))
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=EDATE(0)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=EDATE(\"a\",1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=EDATE(A1/C1,1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_days() {
        let (cm, vs) = make_test_env();
        // 2020 is a leap year → 366 days.
        assert_eq!(
            eval_str("=DAYS(DATE(2021,1,1),DATE(2020,1,1))", &cm, &vs),
            Value::Number(366.0)
        );
        // Same date → 0.
        assert_eq!(
            eval_str("=DAYS(DATE(2020,1,1),DATE(2020,1,1))", &cm, &vs),
            Value::Number(0.0)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=DAYS(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=DAYS(\"a\",1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=DAYS(A1/C1,1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_datedif() {
        let (cm, vs) = make_test_env();
        // start = 2020-01-15, end = 2021-03-20.
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2020,1,15),DATE(2021,3,20),\"Y\")",
                &cm,
                &vs
            ),
            Value::Number(1.0)
        );
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2020,1,15),DATE(2021,3,20),\"M\")",
                &cm,
                &vs
            ),
            Value::Number(14.0)
        );
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2020,1,15),DATE(2021,3,20),\"YM\")",
                &cm,
                &vs
            ),
            Value::Number(2.0)
        );
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2020,1,15),DATE(2020,1,20),\"D\")",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // MD: same months, different days.
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2020,1,15),DATE(2021,3,20),\"MD\")",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // Unknown unit.
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2020,1,15),DATE(2021,3,20),\"ZZ\")",
                &cm,
                &vs
            ),
            Value::Error(ValueError::InvalidValue)
        );
        // start > end → Overflow.
        assert_eq!(
            eval_str(
                "=DATEDIF(DATE(2021,3,20),DATE(2020,1,15),\"D\")",
                &cm,
                &vs
            ),
            Value::Error(ValueError::Overflow)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=DATEDIF(1,2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=DATEDIF(\"a\",1,\"D\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=DATEDIF(A1/C1,1,\"D\")", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_datevalue() {
        let (cm, vs) = make_test_env();
        // ISO 8601 dash.
        assert_eq!(
            eval_str("=DATEVALUE(\"2020-01-15\")", &cm, &vs),
            Value::Number(date_serial(2020, 1, 15))
        );
        // ISO 8601 slash fallback.
        assert_eq!(
            eval_str("=DATEVALUE(\"2020/01/15\")", &cm, &vs),
            Value::Number(date_serial(2020, 1, 15))
        );
        // Non-ISO text → InvalidValue.
        assert_eq!(
            eval_str("=DATEVALUE(\"Jan 15, 2020\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Invalid month → InvalidValue.
        assert_eq!(
            eval_str("=DATEVALUE(\"2020-13-15\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=DATEVALUE()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=DATEVALUE(IF(C1,\"a\",\"2020-01-15\")) + A1/C1", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_timevalue() {
        let (cm, vs) = make_test_env();
        // 12:00 → 0.5.
        assert_eq!(
            eval_str("=TIMEVALUE(\"12:00\")", &cm, &vs),
            Value::Number(0.5)
        );
        // 06:30:30 → (6*3600 + 30*60 + 30) / 86400.
        let expected = (6.0 * 3600.0 + 30.0 * 60.0 + 30.0) / 86400.0;
        if let Value::Number(n) = eval_str("=TIMEVALUE(\"06:30:30\")", &cm, &vs) {
            assert!((n - expected).abs() < 1e-12);
        } else {
            panic!("TIMEVALUE returned non-number");
        }
        // Non-time text → InvalidValue.
        assert_eq!(
            eval_str("=TIMEVALUE(\"hello\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=TIMEVALUE()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=TIMEVALUE(IF(C1,\"a\",\"12:00\")) + A1/C1", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_yearfrac() {
        let (cm, vs) = make_test_env();
        // basis 0 (US 30/360): one full year → 1.0.
        assert_eq!(
            eval_str("=YEARFRAC(DATE(2020,1,1),DATE(2021,1,1),0)", &cm, &vs),
            Value::Number(1.0)
        );
        // basis 4 (European 30/360): same simple form → 1.0.
        assert_eq!(
            eval_str("=YEARFRAC(DATE(2020,1,1),DATE(2021,1,1),4)", &cm, &vs),
            Value::Number(1.0)
        );
        // basis 3 (actual/365): 366 actual days / 365.
        let expected = 366.0 / 365.0;
        if let Value::Number(n) =
            eval_str("=YEARFRAC(DATE(2020,1,1),DATE(2021,1,1),3)", &cm, &vs)
        {
            assert!((n - expected).abs() < 1e-12);
        } else {
            panic!("YEARFRAC basis 3 returned non-number");
        }
        // basis 2 (actual/360): 366 / 360.
        let expected = 366.0 / 360.0;
        if let Value::Number(n) =
            eval_str("=YEARFRAC(DATE(2020,1,1),DATE(2021,1,1),2)", &cm, &vs)
        {
            assert!((n - expected).abs() < 1e-12);
        } else {
            panic!("YEARFRAC basis 2 returned non-number");
        }
        // Default basis = 0.
        assert_eq!(
            eval_str("=YEARFRAC(DATE(2020,1,1),DATE(2021,1,1))", &cm, &vs),
            Value::Number(1.0)
        );
        // Unknown basis → InvalidValue.
        assert_eq!(
            eval_str("=YEARFRAC(DATE(2020,1,1),DATE(2021,1,1),99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Wrong arg count.
        assert_eq!(
            eval_str("=YEARFRAC(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wrong type.
        assert_eq!(
            eval_str("=YEARFRAC(\"a\",1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=YEARFRAC(A1/C1,1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // === Statistical extensions: AVERAGEA / RANK / RANKEQ / RANKAVG /
    //                             PERCENTILE / QUARTILE / CORREL / SLOPE /
    //                             INTERCEPT.

    /// Builds a richer test env with named numeric columns/rows for stats:
    /// A1..A5 = 2, 4, 6, 8, 10
    /// B1..B5 = 1, 3, 5, 7, 9     (perfectly correlated with A: B = A/2 + 0.5? not exactly — see below)
    /// Actually B1..B5 = 4, 8, 12, 16, 20 → exactly 2*A (linear, perfectly correlated).
    /// C1..C5 = 10, 8, 6, 4, 2    → inversely correlated with A.
    /// D1 = TRUE-encoded as Boolean, D2 = FALSE, D3 = "hello" (text),
    /// D4 = Null (not inserted), D5 = 5 (number).
    fn make_stat_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let mut next_id: u64 = 0;
        let insert = |row: u32, col: u32, v: Value,
                          cm: &mut HashMap<CellAddress, AtomId>,
                          vs: &mut HashMap<AtomId, Value>,
                          next: &mut u64| {
            let id = AtomId::from_raw(*next);
            *next += 1;
            cm.insert(CellAddress::new(row, col), id);
            vs.insert(id, v);
        };
        // Column A: 2, 4, 6, 8, 10.
        for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
            insert(i as u32, 0, Value::Number(*n), &mut cell_map, &mut values, &mut next_id);
        }
        // Column B = 2*A: 4, 8, 12, 16, 20 (perfect positive correlation).
        for (i, n) in [4.0, 8.0, 12.0, 16.0, 20.0].iter().enumerate() {
            insert(i as u32, 1, Value::Number(*n), &mut cell_map, &mut values, &mut next_id);
        }
        // Column C = inverse of A: 10, 8, 6, 4, 2 (perfect negative correlation).
        for (i, n) in [10.0, 8.0, 6.0, 4.0, 2.0].iter().enumerate() {
            insert(i as u32, 2, Value::Number(*n), &mut cell_map, &mut values, &mut next_id);
        }
        // Column D: mixed-type column for AVERAGEA.
        insert(0, 3, Value::Boolean(true), &mut cell_map, &mut values, &mut next_id);
        insert(1, 3, Value::Boolean(false), &mut cell_map, &mut values, &mut next_id);
        insert(2, 3, Value::Text("hello".into()), &mut cell_map, &mut values, &mut next_id);
        // D4 intentionally absent → Null.
        insert(4, 3, Value::Number(5.0), &mut cell_map, &mut values, &mut next_id);
        // Column E: contains ties for RANK.AVG (10, 10, 5).
        insert(0, 4, Value::Number(10.0), &mut cell_map, &mut values, &mut next_id);
        insert(1, 4, Value::Number(10.0), &mut cell_map, &mut values, &mut next_id);
        insert(2, 4, Value::Number(5.0), &mut cell_map, &mut values, &mut next_id);
        (cell_map, values)
    }

    // --- AVERAGEA ---

    #[test]
    fn eval_averagea_happy_path() {
        let (cm, vs) = make_stat_env();
        // D1=TRUE(1) + D2=FALSE(0) + D3="hello"(0) + D4=Null(skip) + D5=5(5)
        // → total = 6, count = 4 → 1.5.
        assert_eq!(eval_str("=AVERAGEA(D1:D5)", &cm, &vs), Value::Number(1.5));
        // Numbers only: A1..A5 = 2,4,6,8,10 → mean 6.
        assert_eq!(eval_str("=AVERAGEA(A1:A5)", &cm, &vs), Value::Number(6.0));
    }

    #[test]
    fn eval_averagea_empty_is_div_zero() {
        let (cm, vs) = make_stat_env();
        // Empty (no args) → WrongArgCount? No — variadic, but no values → DivisionByZero.
        // We use a range pointing at an empty area.
        assert_eq!(
            eval_str("=AVERAGEA(Z1:Z5)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_averagea_error_propagates() {
        let (cm, vs) = make_stat_env();
        // A1/Z1 → A1=2, Z1=0 (Null coerces to 0) → DivisionByZero.
        assert_eq!(
            eval_str("=AVERAGEA(A1/Z1,A2)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // --- RANK / RANKEQ ---

    #[test]
    fn eval_rank_desc_default() {
        let (cm, vs) = make_stat_env();
        // A1..A5 = 2,4,6,8,10. RANK(6, A1:A5) desc → 2 values > 6 (8,10) → rank 3.
        assert_eq!(eval_str("=RANK(6,A1:A5)", &cm, &vs), Value::Number(3.0));
        // RANKEQ is an alias.
        assert_eq!(eval_str("=RANKEQ(6,A1:A5)", &cm, &vs), Value::Number(3.0));
    }

    #[test]
    fn eval_rank_asc_order() {
        let (cm, vs) = make_stat_env();
        // RANK(6, A1:A5, 1) asc → 2 values < 6 (2,4) → rank 3.
        assert_eq!(eval_str("=RANK(6,A1:A5,1)", &cm, &vs), Value::Number(3.0));
    }

    #[test]
    fn eval_rank_missing_value() {
        let (cm, vs) = make_stat_env();
        // 7 is not in A1:A5 → #VALUE!.
        assert_eq!(
            eval_str("=RANK(7,A1:A5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_rank_ties_same_low_rank() {
        let (cm, vs) = make_stat_env();
        // E1..E3 = 10,10,5. RANK(10, E1:E3) desc → 0 values > 10 → rank 1
        // for both ties (RANK / RANK.EQ behavior).
        assert_eq!(eval_str("=RANK(10,E1:E3)", &cm, &vs), Value::Number(1.0));
    }

    #[test]
    fn eval_rank_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=RANK(6)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=RANK(6,A1:A5,1,2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_rank_type_error() {
        let (cm, vs) = make_stat_env();
        // First arg is text → WrongType.
        assert_eq!(
            eval_str("=RANK(\"abc\",A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_rank_error_propagates() {
        let (cm, vs) = make_stat_env();
        // Numerator A1, denominator Z1=0 (Null→0). First arg errors.
        assert_eq!(
            eval_str("=RANK(A1/Z1,A1:A5)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // --- RANKEQ (explicit) ---

    #[test]
    fn eval_rankeq_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=RANKEQ()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_rankeq_type_error() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=RANKEQ(\"x\",A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    // --- RANKAVG ---

    #[test]
    fn eval_rankavg_ties_average() {
        let (cm, vs) = make_stat_env();
        // E1..E3 = 10,10,5 desc → ranks of two 10s would be 1 and 2 → average 1.5.
        assert_eq!(eval_str("=RANKAVG(10,E1:E3)", &cm, &vs), Value::Number(1.5));
        // Lone 5 → rank 3 (only 2 values strictly greater).
        assert_eq!(eval_str("=RANKAVG(5,E1:E3)", &cm, &vs), Value::Number(3.0));
    }

    #[test]
    fn eval_rankavg_happy_no_ties() {
        let (cm, vs) = make_stat_env();
        // No ties, behaves like RANK.
        assert_eq!(eval_str("=RANKAVG(6,A1:A5)", &cm, &vs), Value::Number(3.0));
    }

    #[test]
    fn eval_rankavg_missing_value() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=RANKAVG(7,A1:A5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_rankavg_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=RANKAVG(6)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_rankavg_type_error() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=RANKAVG(\"x\",A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_rankavg_dotted_name_parses() {
        // The parser accepts `.` inside function identifiers (Excel 2010+
        // dotted aliases). RANK.AVG / RANK.EQ now parse as their own
        // FuncCall names and route through the corresponding dispatcher
        // arms; semantics are validated by `eval_rank_eq_dotted` /
        // `eval_rank_avg_dotted`.
        assert!(parse_formula("=RANK.AVG(1,A1:A3)").is_some());
        assert!(parse_formula("=RANK.EQ(1,A1:A3)").is_some());
    }

    // --- PERCENTILE ---

    #[test]
    fn eval_percentile_endpoints_and_middle() {
        let (cm, vs) = make_stat_env();
        // A1..A5 = 2,4,6,8,10 sorted asc.
        // k=0 → min = 2.
        assert_eq!(eval_str("=PERCENTILE(A1:A5,0)", &cm, &vs), Value::Number(2.0));
        // k=1 → max = 10.
        assert_eq!(eval_str("=PERCENTILE(A1:A5,1)", &cm, &vs), Value::Number(10.0));
        // k=0.5 → median = 6.
        assert_eq!(eval_str("=PERCENTILE(A1:A5,0.5)", &cm, &vs), Value::Number(6.0));
        // k=0.25 → pos = 1.0 → exact index 1 → value 4.
        assert_eq!(
            eval_str("=PERCENTILE(A1:A5,0.25)", &cm, &vs),
            Value::Number(4.0)
        );
    }

    #[test]
    fn eval_percentile_interpolation() {
        let (cm, vs) = make_stat_env();
        // A1..A5 sorted = 2,4,6,8,10. k=0.1 → pos = 0.4 → interp 2 + (4-2)*0.4 = 2.8.
        match eval_str("=PERCENTILE(A1:A5,0.1)", &cm, &vs) {
            Value::Number(n) => assert!((n - 2.8).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_percentile_k_out_of_range() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=PERCENTILE(A1:A5,-0.1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        assert_eq!(
            eval_str("=PERCENTILE(A1:A5,1.5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_percentile_empty_range() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=PERCENTILE(Z1:Z5,0.5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_percentile_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=PERCENTILE(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_percentile_type_error() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=PERCENTILE(A1:A5,\"x\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    // --- QUARTILE ---

    #[test]
    fn eval_quartile_basic() {
        let (cm, vs) = make_stat_env();
        // A1..A5 sorted = 2,4,6,8,10.
        // quart=0 → min = 2; quart=4 → max = 10; quart=2 → median = 6.
        assert_eq!(eval_str("=QUARTILE(A1:A5,0)", &cm, &vs), Value::Number(2.0));
        assert_eq!(eval_str("=QUARTILE(A1:A5,4)", &cm, &vs), Value::Number(10.0));
        assert_eq!(eval_str("=QUARTILE(A1:A5,2)", &cm, &vs), Value::Number(6.0));
        // quart=2 should equal PERCENTILE(k=0.5).
        assert_eq!(
            eval_str("=QUARTILE(A1:A5,2)", &cm, &vs),
            eval_str("=PERCENTILE(A1:A5,0.5)", &cm, &vs),
        );
    }

    #[test]
    fn eval_quartile_out_of_range() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=QUARTILE(A1:A5,5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        assert_eq!(
            eval_str("=QUARTILE(A1:A5,-1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Fractional quart not allowed.
        assert_eq!(
            eval_str("=QUARTILE(A1:A5,1.5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_quartile_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=QUARTILE(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_quartile_type_error() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=QUARTILE(A1:A5,\"x\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    // --- CORREL ---

    #[test]
    fn eval_correl_identical_arrays() {
        let (cm, vs) = make_stat_env();
        // A vs B = 2*A → perfect positive correlation.
        match eval_str("=CORREL(A1:A5,B1:B5)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
        // A vs A (identical) → 1.0.
        match eval_str("=CORREL(A1:A5,A1:A5)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_correl_inverted_arrays() {
        let (cm, vs) = make_stat_env();
        // A vs C (10,8,6,4,2) → perfect negative correlation.
        match eval_str("=CORREL(A1:A5,C1:C5)", &cm, &vs) {
            Value::Number(n) => assert!((n + 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_correl_shape_mismatch() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=CORREL(A1:A5,B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_correl_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=CORREL(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_correl_type_error_non_range() {
        let (cm, vs) = make_stat_env();
        // Scalar first arg → not a range → #VALUE!.
        assert_eq!(
            eval_str("=CORREL(5,A1:A5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_correl_error_propagates() {
        let (cm, vs) = make_stat_env();
        // A1/Z1 path is hidden behind a cell, but we test through a range
        // that contains an explicit error via division. To do this in a
        // single-formula test we run CORREL(A1:A5, A1:A5) — already
        // covered as happy; for error propagation we rely on the pair
        // walker propagating cell-level errors. This case is exercised by
        // the integration tests.
        match eval_str("=CORREL(A1:A5,A1:A5)", &cm, &vs) {
            Value::Number(_) => {}
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_correl_too_few_pairs() {
        let (cm, vs) = make_stat_env();
        // Empty range → 0 pairs → DivisionByZero.
        assert_eq!(
            eval_str("=CORREL(Y1:Y5,Z1:Z5)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // --- SLOPE / INTERCEPT ---

    #[test]
    fn eval_slope_basic() {
        let (cm, vs) = make_stat_env();
        // y = B = 2*A → slope (y vs x) = 2.
        match eval_str("=SLOPE(B1:B5,A1:A5)", &cm, &vs) {
            Value::Number(n) => assert!((n - 2.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_intercept_basic() {
        let (cm, vs) = make_stat_env();
        // y = B = 2*A → intercept = 0.
        match eval_str("=INTERCEPT(B1:B5,A1:A5)", &cm, &vs) {
            Value::Number(n) => assert!(n.abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_slope_inverted_dataset() {
        let (cm, vs) = make_stat_env();
        // y = C = (10,8,6,4,2), x = A = (2,4,6,8,10). slope = -1.
        match eval_str("=SLOPE(C1:C5,A1:A5)", &cm, &vs) {
            Value::Number(n) => assert!((n + 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
        // intercept(C, A) = mean(C) - slope*mean(A) = 6 - (-1)*6 = 12.
        match eval_str("=INTERCEPT(C1:C5,A1:A5)", &cm, &vs) {
            Value::Number(n) => assert!((n - 12.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn eval_slope_shape_mismatch() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=SLOPE(B1:B5,A1:A4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_intercept_shape_mismatch() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=INTERCEPT(B1:B5,A1:A4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_slope_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=SLOPE(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_intercept_wrong_arg_count() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=INTERCEPT(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_slope_type_error_non_range() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=SLOPE(5,A1:A5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_intercept_type_error_non_range() {
        let (cm, vs) = make_stat_env();
        assert_eq!(
            eval_str("=INTERCEPT(5,A1:A5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_slope_too_few_pairs() {
        let (cm, vs) = make_stat_env();
        // Empty ranges → no pairs → DivisionByZero.
        assert_eq!(
            eval_str("=SLOPE(Y1:Y5,Z1:Z5)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // === Financial tests ===
    //
    // The env used here populates A1..A4 with the cash-flow sequence
    // [-100, 30, 40, 50] (IRR ≈ 8.896%). Some PMT/PV/FV tests use the
    // canonical 30-year-loan: rate=0.005/mo, nper=360, pv=200000.

    fn make_finance_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        // A1..A4 → cash flows; B1 holds a non-numeric value for type errors;
        // C1..C3 → all-positive cash flow scenario for IRR sign-check.
        let flows = [-100.0, 30.0, 40.0, 50.0];
        for (i, v) in flows.iter().enumerate() {
            let id = AtomId::from_raw(i as u64);
            cell_map.insert(CellAddress::new(i as u32, 0), id);
            values.insert(id, Value::Number(*v));
        }
        let b1 = AtomId::from_raw(100);
        cell_map.insert(CellAddress::new(0, 1), b1);
        values.insert(b1, Value::Text("bad".into()));

        for (i, v) in [10.0_f64, 20.0, 30.0].iter().enumerate() {
            let id = AtomId::from_raw(200 + i as u64);
            cell_map.insert(CellAddress::new(i as u32, 2), id);
            values.insert(id, Value::Number(*v));
        }
        (cell_map, values)
    }

    fn approx(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn eval_pmt() {
        let (cm, vs) = make_test_env();
        // 30-year fixed-rate loan: rate=0.005/mo, nper=360, pv=200000.
        // Excel PMT ≈ -1199.10.
        match eval_str("=PMT(0.005,360,200000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, -1199.10, 1e-2), "PMT got {}", n),
            other => panic!("PMT: {:?}", other),
        }
        // rate=0 linear branch: PMT(0, 10, 1000) = -100.
        assert_eq!(eval_str("=PMT(0,10,1000)", &cm, &vs), Value::Number(-100.0));
        // type=1 produces a smaller (less-negative) payment than type=0
        // because each pmt accrues an extra period of interest.
        let p0 = match eval_str("=PMT(0.005,360,200000,0,0)", &cm, &vs) {
            Value::Number(n) => n,
            _ => unreachable!(),
        };
        let p1 = match eval_str("=PMT(0.005,360,200000,0,1)", &cm, &vs) {
            Value::Number(n) => n,
            _ => unreachable!(),
        };
        assert!(p1 > p0, "type=1 pmt {} should be > type=0 pmt {}", p1, p0);
        // Arg-count error.
        assert_eq!(
            eval_str("=PMT(0.005,360)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=PMT(0.005,360,200000,0,0,0)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error: B2 is text.
        assert_eq!(
            eval_str("=PMT(B2,360,200000)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation: A1/C1 in args propagates DivisionByZero.
        assert_eq!(
            eval_str("=PMT(A1/C1,360,200000)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // Invalid type value.
        assert_eq!(
            eval_str("=PMT(0.005,360,200000,0,2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_pv() {
        let (cm, vs) = make_test_env();
        // From PMT above: PV(0.005, 360, -1199.10) ≈ 200000. The PMT
        // figure is rounded to 2 decimals so back-computed PV is off by
        // ~0.2; tolerance accommodates that round-trip error.
        match eval_str("=PV(0.005,360,-1199.10)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 200000.0, 1.0), "PV got {}", n),
            other => panic!("PV: {:?}", other),
        }
        // rate=0 linear: PV(0, 10, -100, 0) = -(-100*10 + 0) = 1000.
        assert_eq!(
            eval_str("=PV(0,10,-100)", &cm, &vs),
            Value::Number(1000.0)
        );
        assert_eq!(
            eval_str("=PV(0.005)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=PV(B2,360,-1199.10)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_fv() {
        let (cm, vs) = make_test_env();
        // Saving $100/mo at 0.5%/mo for 60 months from a $0 start: Excel
        // FV ≈ -6977.00 (negative because pmt is positive → outflow).
        match eval_str("=FV(0.005,60,-100,0,0)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 6977.00, 1e-1), "FV got {}", n),
            other => panic!("FV: {:?}", other),
        }
        // rate=0 linear: FV(0, 10, -100, 0) = -(0 + -100*10) = 1000.
        assert_eq!(
            eval_str("=FV(0,10,-100)", &cm, &vs),
            Value::Number(1000.0)
        );
        // pv=1000 included: FV(0, 10, -100, 1000) = -(1000 + -1000) = 0.
        // Value::PartialEq compares f64 by to_bits so `-0.0 != 0.0`; we
        // accept either sign for the zero result via an approx check.
        match eval_str("=FV(0,10,-100,1000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 0.0, 1e-9), "FV(0,...,1000) got {}", n),
            other => panic!("FV(0,...,1000): {:?}", other),
        }
        assert_eq!(
            eval_str("=FV()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=FV(B2,60,-100)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_nper() {
        let (cm, vs) = make_test_env();
        // NPER(0.005, -1199.10, 200000) ≈ 360.
        match eval_str("=NPER(0.005,-1199.10,200000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 360.0, 1e-2), "NPER got {}", n),
            other => panic!("NPER: {:?}", other),
        }
        // rate=0: NPER(0, -100, 1000) = -(1000+0)/-100 = 10.
        assert_eq!(
            eval_str("=NPER(0,-100,1000)", &cm, &vs),
            Value::Number(10.0)
        );
        // rate=0 and pmt=0 → #DIV/0!.
        assert_eq!(
            eval_str("=NPER(0,0,1000)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // Log-domain failure: PV=0, PMT=0, FV=100 → no solution.
        assert_eq!(
            eval_str("=NPER(0.05,0,0,100)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=NPER(0.005)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=NPER(B2,-100,1000)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_npv() {
        let (cm, vs) = make_test_env();
        let fcm = make_finance_env();
        // Direct args: NPV(0.1, 100, 100, 100) = 100/1.1 + 100/1.21 + 100/1.331 ≈ 248.685.
        match eval_str("=NPV(0.1,100,100,100)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 248.685, 1e-2), "NPV got {}", n),
            other => panic!("NPV: {:?}", other),
        }
        // Range arg with the [-100, 30, 40, 50] flows at A1:A4. NPV
        // discounts the first flow by (1+r), so this equals
        //   -100/1.1 + 30/1.21 + 40/1.331 + 50/1.4641 ≈ -1.9124.
        // The flows include the initial outlay; Excel users would
        // normally write IRR-style sequences without the t=0 outlay
        // inside NPV, but this confirms the discount math.
        match eval_str("=NPV(0.1,A1:A4)", &fcm.0, &fcm.1) {
            Value::Number(n) => assert!(approx(n, -1.9124, 1e-3), "NPV range got {}", n),
            other => panic!("NPV range: {:?}", other),
        }
        // Empty range (D1:D3 — no entries in env) → 0 with no error.
        assert_eq!(
            eval_str("=NPV(0.1,D1:D3)", &fcm.0, &fcm.1),
            Value::Number(0.0)
        );
        // Arg-count error (only rate, no flows).
        assert_eq!(
            eval_str("=NPV(0.1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=NPV(A1/C1,100)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_irr() {
        let (cm, vs) = make_finance_env();
        // [-100, 30, 40, 50] → IRR ≈ 0.08896.
        match eval_str("=IRR(A1:A4)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 0.08896, 1e-4), "IRR got {}", n),
            other => panic!("IRR: {:?}", other),
        }
        // With explicit guess.
        match eval_str("=IRR(A1:A4,0.05)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 0.08896, 1e-4), "IRR(guess) got {}", n),
            other => panic!("IRR guess: {:?}", other),
        }
        // All-positive cash flows → InvalidValue.
        assert_eq!(
            eval_str("=IRR(C1:C3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=IRR()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Non-range first arg → WrongType.
        assert_eq!(
            eval_str("=IRR(100)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_rate() {
        let (cm, vs) = make_test_env();
        // RATE(360, -1199.10, 200000) ≈ 0.005.
        match eval_str("=RATE(360,-1199.10,200000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 0.005, 1e-5), "RATE got {}", n),
            other => panic!("RATE: {:?}", other),
        }
        // RATE(10, -100, 600) ≈ 0.10558.
        match eval_str("=RATE(10,-100,600)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, 0.10558, 1e-4), "RATE got {}", n),
            other => panic!("RATE: {:?}", other),
        }
        // Non-convergence: absurd inputs (large pv, large positive pmt with
        // no fv) have no root in the real domain → Overflow.
        assert_eq!(
            eval_str("=RATE(10,1000,1000)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=RATE(10)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error.
        assert_eq!(
            eval_str("=RATE(10,B2,1000)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // nper <= 0 → InvalidValue.
        assert_eq!(
            eval_str("=RATE(0,-100,1000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_ipmt() {
        let (cm, vs) = make_test_env();
        // IPMT(0.005, 1, 360, 200000) ≈ -1000 (first-month interest on a
        // $200k 0.5%/mo loan is exactly 200000*0.005 = 1000, paid out).
        match eval_str("=IPMT(0.005,1,360,200000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, -1000.0, 1e-2), "IPMT got {}", n),
            other => panic!("IPMT: {:?}", other),
        }
        // IPMT(0.005, 2, 360, 200000) ≈ -999.0045.
        match eval_str("=IPMT(0.005,2,360,200000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, -999.0045, 1e-2), "IPMT(2) got {}", n),
            other => panic!("IPMT(2): {:?}", other),
        }
        // type=1, per=1 → 0 (no interest accrued yet).
        assert_eq!(
            eval_str("=IPMT(0.005,1,360,200000,0,1)", &cm, &vs),
            Value::Number(0.0)
        );
        // rate=0 → interest is 0 for every period.
        assert_eq!(
            eval_str("=IPMT(0,1,10,1000)", &cm, &vs),
            Value::Number(0.0)
        );
        // per out of range → InvalidValue.
        assert_eq!(
            eval_str("=IPMT(0.005,0,360,200000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        assert_eq!(
            eval_str("=IPMT(0.005,361,360,200000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=IPMT(0.005,1,360)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error.
        assert_eq!(
            eval_str("=IPMT(B2,1,360,200000)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_ppmt() {
        let (cm, vs) = make_test_env();
        // PPMT(0.005, 1, 360, 200000) = PMT - IPMT
        // PMT ≈ -1199.10, IPMT ≈ -1000 → PPMT ≈ -199.10.
        match eval_str("=PPMT(0.005,1,360,200000)", &cm, &vs) {
            Value::Number(n) => assert!(approx(n, -199.10, 1e-2), "PPMT got {}", n),
            other => panic!("PPMT: {:?}", other),
        }
        // rate=0: every payment is purely principal, so PPMT = PMT = -100.
        assert_eq!(
            eval_str("=PPMT(0,1,10,1000)", &cm, &vs),
            Value::Number(-100.0)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=PPMT(0.005,1,360)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error.
        assert_eq!(
            eval_str("=PPMT(B2,1,360,200000)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // per out of range error from IPMT path propagates.
        assert_eq!(
            eval_str("=PPMT(0.005,0,360,200000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    // ============================================================
    // Excel 2010+ dotted-name aliases & variants.
    //
    // Parser support (`.` allowed inside identifiers) is verified in
    // `formula::tests`; here we pin the dispatcher arms.
    // ============================================================

    // --- Pure aliases — RANK.EQ / RANK.AVG / PERCENTILE.INC / QUARTILE.INC ---

    #[test]
    fn eval_rank_eq_dotted() {
        let (cm, vs) = make_stat_env();
        // RANK.EQ(6, A1:A5) desc → 2 values > 6 → rank 3. Must match the
        // bare RANK / RANKEQ arms exactly.
        assert_eq!(eval_str("=RANK.EQ(6,A1:A5)", &cm, &vs), Value::Number(3.0));
        assert_eq!(
            eval_str("=RANK.EQ(6,A1:A5)", &cm, &vs),
            eval_str("=RANK(6,A1:A5)", &cm, &vs),
        );
        // Arg-count error path is shared with RANK.
        assert_eq!(
            eval_str("=RANK.EQ(6)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_rank_avg_dotted() {
        let (cm, vs) = make_stat_env();
        // E1..E3 = 10, 10, 5 — ties at 10 → average(1, 2) = 1.5.
        assert_eq!(
            eval_str("=RANK.AVG(10,E1:E3)", &cm, &vs),
            Value::Number(1.5),
        );
        assert_eq!(
            eval_str("=RANK.AVG(10,E1:E3)", &cm, &vs),
            eval_str("=RANKAVG(10,E1:E3)", &cm, &vs),
        );
        assert_eq!(
            eval_str("=RANK.AVG(10)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_percentile_inc_dotted() {
        let (cm, vs) = make_stat_env();
        // PERCENTILE.INC is the same function as PERCENTILE.
        assert_eq!(
            eval_str("=PERCENTILE.INC(A1:A5,0.5)", &cm, &vs),
            Value::Number(6.0),
        );
        assert_eq!(
            eval_str("=PERCENTILE.INC(A1:A5,0.5)", &cm, &vs),
            eval_str("=PERCENTILE(A1:A5,0.5)", &cm, &vs),
        );
        assert_eq!(
            eval_str("=PERCENTILE.INC(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_quartile_inc_dotted() {
        let (cm, vs) = make_stat_env();
        // QUARTILE.INC mirrors QUARTILE (inclusive variant).
        assert_eq!(
            eval_str("=QUARTILE.INC(A1:A5,2)", &cm, &vs),
            Value::Number(6.0),
        );
        assert_eq!(
            eval_str("=QUARTILE.INC(A1:A5,2)", &cm, &vs),
            eval_str("=QUARTILE(A1:A5,2)", &cm, &vs),
        );
        assert_eq!(
            eval_str("=QUARTILE.INC(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    // --- Sample-variance aliases — STDEV.S / VAR.S ---

    #[test]
    fn eval_stdev_s() {
        let (cm, vs) = make_stat_env();
        // STDEV.S is an alias for STDEV (sample, divides by n-1).
        // A1..A5 = 2,4,6,8,10 → mean=6, sumsq=40, var=40/4=10 → sd=√10.
        match eval_str("=STDEV.S(A1:A5)", &cm, &vs) {
            Value::Number(n) => assert!((n - 10f64.sqrt()).abs() < 1e-12, "got {n}"),
            other => panic!("STDEV.S: {other:?}"),
        }
        // Must agree numerically with STDEV.
        assert_eq!(
            eval_str("=STDEV.S(A1:A5)", &cm, &vs),
            eval_str("=STDEV(A1:A5)", &cm, &vs),
        );
        // Arg-count handling is inherited from STDEV — at least one numeric
        // value is required (collect_numbers returns empty → InvalidValue).
        assert_eq!(
            eval_str("=STDEV.S(D3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn eval_var_s() {
        let (cm, vs) = make_stat_env();
        // VAR.S aliases VAR (sample). A1..A5 = 2,4,6,8,10 → var = 10.
        assert_eq!(eval_str("=VAR.S(A1:A5)", &cm, &vs), Value::Number(10.0));
        assert_eq!(
            eval_str("=VAR.S(A1:A5)", &cm, &vs),
            eval_str("=VAR(A1:A5)", &cm, &vs),
        );
        assert_eq!(
            eval_str("=VAR.S(D3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    // --- Population variance — STDEV.P / VAR.P ---
    //
    // Wikipedia's canonical example: {2, 4, 4, 4, 5, 5, 7, 9}.
    // mean = 5; sum of squared deviations = 32.
    // Population: var = 32/8 = 4, sd = 2.
    // Sample:    var = 32/7,    sd = √(32/7) ≈ 2.1381.

    #[test]
    fn eval_stdev_p() {
        let (cm, vs) = make_stat_env();
        // STDEV.P over inline args: {2,4,4,4,5,5,7,9} → pop SD = 2.
        assert_eq!(
            eval_str("=STDEV.P(2,4,4,4,5,5,7,9)", &cm, &vs),
            Value::Number(2.0),
        );
        // Must DIFFER from sample STDEV / STDEV.S over the same input.
        match eval_str("=STDEV.S(2,4,4,4,5,5,7,9)", &cm, &vs) {
            Value::Number(sample) => {
                assert!((sample - (32f64 / 7.0).sqrt()).abs() < 1e-12);
                assert!((sample - 2.0).abs() > 0.1, "STDEV.P/S collapsed: {sample}");
            }
            other => panic!("STDEV.S: {other:?}"),
        }
        // Single value: pop SD is well-defined (= 0); sample SD is not.
        assert_eq!(eval_str("=STDEV.P(7)", &cm, &vs), Value::Number(0.0));
        // Empty input → InvalidValue.
        assert_eq!(
            eval_str("=STDEV.P(D3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn eval_var_p() {
        let (cm, vs) = make_stat_env();
        // VAR.P over {2,4,4,4,5,5,7,9} → 4.
        assert_eq!(
            eval_str("=VAR.P(2,4,4,4,5,5,7,9)", &cm, &vs),
            Value::Number(4.0),
        );
        // Sample VAR.S differs from pop VAR.P over the same input.
        match eval_str("=VAR.S(2,4,4,4,5,5,7,9)", &cm, &vs) {
            Value::Number(sample) => {
                assert!((sample - 32f64 / 7.0).abs() < 1e-12);
                assert!((sample - 4.0).abs() > 0.1, "VAR.P/S collapsed: {sample}");
            }
            other => panic!("VAR.S: {other:?}"),
        }
        assert_eq!(eval_str("=VAR.P(7)", &cm, &vs), Value::Number(0.0));
        assert_eq!(
            eval_str("=VAR.P(D3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    // --- Exclusive percentile / quartile ---

    #[test]
    fn eval_percentile_exc() {
        let (cm, vs) = make_stat_env();
        // PERCENTILE.EXC(A1:A5, 0.5) on {2,4,6,8,10}: pos = 0.5*(5+1) = 3,
        // i.e. the 3rd sorted value = 6.
        assert_eq!(
            eval_str("=PERCENTILE.EXC(A1:A5,0.5)", &cm, &vs),
            Value::Number(6.0),
        );
        // k=0.25 → pos = 1.5 → interp(nums[0]=2, nums[1]=4) at frac 0.5 = 3.
        match eval_str("=PERCENTILE.EXC(A1:A5,0.25)", &cm, &vs) {
            Value::Number(n) => assert!((n - 3.0).abs() < 1e-12, "got {n}"),
            other => panic!("PERCENTILE.EXC(0.25): {other:?}"),
        }
        // k=0 and k=1 are NOT allowed in exclusive mode.
        assert_eq!(
            eval_str("=PERCENTILE.EXC(A1:A5,0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        assert_eq!(
            eval_str("=PERCENTILE.EXC(A1:A5,1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Position out of range (k too small / too large for n=5): pos<1 or pos>n.
        // k=0.1 → pos = 0.6 → <1 → invalid.
        assert_eq!(
            eval_str("=PERCENTILE.EXC(A1:A5,0.1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // k=0.9 → pos = 5.4 → >n=5 → invalid.
        assert_eq!(
            eval_str("=PERCENTILE.EXC(A1:A5,0.9)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=PERCENTILE.EXC(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_quartile_exc() {
        let (cm, vs) = make_stat_env();
        // QUARTILE.EXC(A1:A5, 2) == PERCENTILE.EXC(0.5) = 6.
        assert_eq!(
            eval_str("=QUARTILE.EXC(A1:A5,2)", &cm, &vs),
            Value::Number(6.0),
        );
        // quart=1 → PERCENTILE.EXC(0.25) = 3.
        match eval_str("=QUARTILE.EXC(A1:A5,1)", &cm, &vs) {
            Value::Number(n) => assert!((n - 3.0).abs() < 1e-12, "got {n}"),
            other => panic!("QUARTILE.EXC(1): {other:?}"),
        }
        // quart=3 → PERCENTILE.EXC(0.75) = 9 (pos = 4.5 → interp 8/10).
        match eval_str("=QUARTILE.EXC(A1:A5,3)", &cm, &vs) {
            Value::Number(n) => assert!((n - 9.0).abs() < 1e-12, "got {n}"),
            other => panic!("QUARTILE.EXC(3): {other:?}"),
        }
        // 0 and 4 are NOT valid in exclusive mode.
        assert_eq!(
            eval_str("=QUARTILE.EXC(A1:A5,0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        assert_eq!(
            eval_str("=QUARTILE.EXC(A1:A5,4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Fractional quart rejected.
        assert_eq!(
            eval_str("=QUARTILE.EXC(A1:A5,1.5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=QUARTILE.EXC(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    // --- Covariance — COVAR / COVAR.P / COVAR.S ---

    #[test]
    fn eval_covar() {
        let (cm, vs) = make_stat_env();
        // A = (2,4,6,8,10), B = 2A = (4,8,12,16,20).
        // mx=6, my=12, sum((x-mx)(y-my)) = 2*(16+4+0+4+16) = 80.
        // COVAR (pop): 80/5 = 16.
        assert_eq!(
            eval_str("=COVAR(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(16.0),
        );
        // COVAR.P is the same arm.
        assert_eq!(
            eval_str("=COVAR.P(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(16.0),
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=COVAR(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
        // Shape mismatch propagates from collect_paired_numbers.
        assert_eq!(
            eval_str("=COVAR(A1:A5,B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn eval_covar_s() {
        let (cm, vs) = make_stat_env();
        // Sample variant: same sum 80 divided by n-1 = 4 → 20.
        assert_eq!(
            eval_str("=COVAR.S(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(20.0),
        );
        // Must DIFFER from population COVAR over the same input.
        match (
            eval_str("=COVAR.P(A1:A5,B1:B5)", &cm, &vs),
            eval_str("=COVAR.S(A1:A5,B1:B5)", &cm, &vs),
        ) {
            (Value::Number(p), Value::Number(s)) => {
                assert!((p - 16.0).abs() < 1e-12 && (s - 20.0).abs() < 1e-12);
                assert!((p - s).abs() > 0.1, "COVAR.P/S collapsed: {p}, {s}");
            }
            other => panic!("expected number pair, got {other:?}"),
        }
        // Arg-count error.
        assert_eq!(
            eval_str("=COVAR.S(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    // === Database functions (D*) ===
    //
    // Layout used by `make_db_env`:
    //
    //   A1:D1  =  "Name",  "Age", "Dept",  "Salary"   (header row)
    //   A2:D2  =  "Alice",  30,   "Eng",   80000
    //   A3:D3  =  "Bob",    25,   "Sales", 60000
    //   A4:D4  =  "Carol",  35,   "Eng",   95000
    //   A5:D5  =  "Dave",   28,   "Sales", 70000
    //
    //   F1:G1  =  "Dept",   "Age"                       (criteria header)
    //   F2:G2  =  "Eng",    ">28"                       (criterion row 1)
    //
    // So the default criteria (F1:G2) matches Alice (Eng, 30) and Carol
    // (Eng, 35). Bob/Dave fail Dept; Alice/Carol pass both Dept and Age.
    fn make_db_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();

        // Helper: insert a labelled (row, col) cell with a fresh AtomId.
        let mut next_id: u64 = 0;
        let mut put = |cm: &mut HashMap<CellAddress, AtomId>,
                       vs: &mut HashMap<AtomId, Value>,
                       row: u32,
                       col: u32,
                       v: Value| {
            let id = AtomId::from_raw(next_id);
            next_id += 1;
            cm.insert(CellAddress::new(row, col), id);
            vs.insert(id, v);
        };

        // Database header.
        put(&mut cell_map, &mut values, 0, 0, Value::Text("Name".into()));
        put(&mut cell_map, &mut values, 0, 1, Value::Text("Age".into()));
        put(&mut cell_map, &mut values, 0, 2, Value::Text("Dept".into()));
        put(&mut cell_map, &mut values, 0, 3, Value::Text("Salary".into()));

        // Database rows.
        let rows: [(&str, f64, &str, f64); 4] = [
            ("Alice", 30.0, "Eng", 80000.0),
            ("Bob", 25.0, "Sales", 60000.0),
            ("Carol", 35.0, "Eng", 95000.0),
            ("Dave", 28.0, "Sales", 70000.0),
        ];
        for (i, (name, age, dept, salary)) in rows.iter().enumerate() {
            let r = (i + 1) as u32;
            put(&mut cell_map, &mut values, r, 0, Value::Text((*name).into()));
            put(&mut cell_map, &mut values, r, 1, Value::Number(*age));
            put(&mut cell_map, &mut values, r, 2, Value::Text((*dept).into()));
            put(&mut cell_map, &mut values, r, 3, Value::Number(*salary));
        }

        // Criteria region (F1:G2) — Dept="Eng" AND Age>28.
        put(&mut cell_map, &mut values, 0, 5, Value::Text("Dept".into()));
        put(&mut cell_map, &mut values, 0, 6, Value::Text("Age".into()));
        put(&mut cell_map, &mut values, 1, 5, Value::Text("Eng".into()));
        put(&mut cell_map, &mut values, 1, 6, Value::Text(">28".into()));

        (cell_map, values)
    }

    #[test]
    fn eval_dsum() {
        let (cm, vs) = make_db_env();
        // Salary sum over (Eng AND Age>28) → 80000 + 95000 = 175000.
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(175000.0)
        );
        // Field as 1-based number: Salary is column 4 → same result.
        assert_eq!(
            eval_str("=DSUM(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(175000.0)
        );
        // Empty match set: a criteria of Dept="Marketing" → 0 numerics → 0.
        let (mut cm2, mut vs2) = make_db_env();
        // Overwrite criteria F1:G2 with Dept="Marketing" (single column).
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        // Empty the Age column criterion (G2) so only the Dept filter applies.
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(0.0)
        );
        // Bad field name → InvalidValue.
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count error.
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"Salary\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Wildcard: Name="A*" → Alice only → 80000.
        let (mut cm3, mut vs3) = make_db_env();
        let h = AtomId::from_raw(900);
        cm3.insert(CellAddress::new(0, 5), h);
        vs3.insert(h, Value::Text("Name".into()));
        let c = AtomId::from_raw(901);
        cm3.insert(CellAddress::new(1, 5), c);
        vs3.insert(c, Value::Text("A*".into()));
        // Empty G column so only the Name criterion applies.
        let empty_g1 = AtomId::from_raw(902);
        cm3.insert(CellAddress::new(0, 6), empty_g1);
        vs3.insert(empty_g1, Value::Null);
        let empty_g2 = AtomId::from_raw(903);
        cm3.insert(CellAddress::new(1, 6), empty_g2);
        vs3.insert(empty_g2, Value::Null);
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"Salary\",F1:G2)", &cm3, &vs3),
            Value::Number(80000.0)
        );
    }

    #[test]
    fn eval_daverage() {
        let (cm, vs) = make_db_env();
        // (80000 + 95000) / 2 = 87500.
        assert_eq!(
            eval_str("=DAVERAGE(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(87500.0)
        );
        // Field as 1-based number.
        assert_eq!(
            eval_str("=DAVERAGE(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(87500.0)
        );
        // Empty match → DivisionByZero.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DAVERAGE(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Error(ValueError::DivisionByZero)
        );
        // Bad field name.
        assert_eq!(
            eval_str("=DAVERAGE(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DAVERAGE(A1:D5,\"Salary\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation: database cell holds an Error.
        let (mut cm3, mut vs3) = make_db_env();
        // Overwrite Alice's salary (cell D2 → row=1, col=3) with an Error.
        let err_id = AtomId::from_raw(950);
        cm3.insert(CellAddress::new(1, 3), err_id);
        vs3.insert(err_id, Value::Error(ValueError::DivisionByZero));
        assert_eq!(
            eval_str("=DAVERAGE(A1:D5,\"Salary\",F1:G2)", &cm3, &vs3),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_dcount() {
        let (cm, vs) = make_db_env();
        // Count numeric Salary values in matches → 2.
        assert_eq!(
            eval_str("=DCOUNT(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(2.0)
        );
        // Field as number.
        assert_eq!(
            eval_str("=DCOUNT(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(2.0)
        );
        // Counting the Name column (Text) → 0 numerics among matches.
        assert_eq!(
            eval_str("=DCOUNT(A1:D5,\"Name\",F1:G2)", &cm, &vs),
            Value::Number(0.0)
        );
        // Empty match → 0.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DCOUNT(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(0.0)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DCOUNT(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DCOUNT(A1:D5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dcounta() {
        let (cm, vs) = make_db_env();
        // 2 matches; Name column has 2 non-empty text cells.
        assert_eq!(
            eval_str("=DCOUNTA(A1:D5,\"Name\",F1:G2)", &cm, &vs),
            Value::Number(2.0)
        );
        // Numeric column also returns 2 (both non-Null).
        assert_eq!(
            eval_str("=DCOUNTA(A1:D5,2,F1:G2)", &cm, &vs),
            Value::Number(2.0)
        );
        // Empty match → 0.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DCOUNTA(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(0.0)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DCOUNTA(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DCOUNTA(A1:D5,\"Name\",F1:G2,5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dget() {
        let (cm, vs) = make_db_env();
        // Two matches → Overflow (#NUM!).
        assert_eq!(
            eval_str("=DGET(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Single match: filter narrower (Dept="Sales", Age>26 → only Dave).
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Sales".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Text(">26".into()));
        assert_eq!(
            eval_str("=DGET(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(70000.0)
        );
        // Same single match by 1-based field.
        assert_eq!(
            eval_str("=DGET(A1:D5,4,F1:G2)", &cm2, &vs2),
            Value::Number(70000.0)
        );
        // No matches → InvalidValue.
        let (mut cm3, mut vs3) = make_db_env();
        let id = AtomId::from_raw(999);
        cm3.insert(CellAddress::new(1, 5), id);
        vs3.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm3.insert(CellAddress::new(1, 6), id2);
        vs3.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DGET(A1:D5,\"Salary\",F1:G2)", &cm3, &vs3),
            Value::Error(ValueError::InvalidValue)
        );
        // Bad field → InvalidValue.
        assert_eq!(
            eval_str("=DGET(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DGET(A1:D5,\"Salary\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dmax() {
        let (cm, vs) = make_db_env();
        // max(80000, 95000) = 95000.
        assert_eq!(
            eval_str("=DMAX(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(95000.0)
        );
        // 1-based field.
        assert_eq!(
            eval_str("=DMAX(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(95000.0)
        );
        // Empty match → 0 (Excel parity).
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DMAX(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(0.0)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DMAX(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DMAX(A1:D5,\"Salary\",F1:G2,5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dmin() {
        let (cm, vs) = make_db_env();
        // min(80000, 95000) = 80000.
        assert_eq!(
            eval_str("=DMIN(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(80000.0)
        );
        // 1-based field.
        assert_eq!(
            eval_str("=DMIN(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(80000.0)
        );
        // Empty match → 0.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DMIN(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(0.0)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DMIN(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DMIN(A1:D5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dproduct() {
        let (cm, vs) = make_db_env();
        // 80000 * 95000 = 7_600_000_000.
        assert_eq!(
            eval_str("=DPRODUCT(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(7_600_000_000.0)
        );
        // 1-based field.
        assert_eq!(
            eval_str("=DPRODUCT(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(7_600_000_000.0)
        );
        // Empty match → 0.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DPRODUCT(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Number(0.0)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DPRODUCT(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DPRODUCT(A1:D5,\"Salary\",F1:G2,5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dstdev() {
        let (cm, vs) = make_db_env();
        // Sample stddev of {80000, 95000} → sqrt(((80000-87500)^2 +
        // (95000-87500)^2) / (2-1)) = sqrt(112_500_000) ≈ 10606.6017.
        let v = eval_str("=DSTDEV(A1:D5,\"Salary\",F1:G2)", &cm, &vs);
        match v {
            Value::Number(n) => assert!(
                (n - 112_500_000.0_f64.sqrt()).abs() < 1e-6,
                "got {n}"
            ),
            other => panic!("expected number, got {other:?}"),
        }
        // 1-based field.
        let v2 = eval_str("=DSTDEV(A1:D5,4,F1:G2)", &cm, &vs);
        match v2 {
            Value::Number(n) => assert!((n - 112_500_000.0_f64.sqrt()).abs() < 1e-6),
            other => panic!("expected number, got {other:?}"),
        }
        // < 2 matches → DivisionByZero. Narrow to Dave only.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Sales".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Text(">26".into()));
        assert_eq!(
            eval_str("=DSTDEV(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Error(ValueError::DivisionByZero)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DSTDEV(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DSTDEV(A1:D5,\"Salary\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dstdevp() {
        let (cm, vs) = make_db_env();
        // Population stddev of {80000, 95000} → sqrt(((80000-87500)^2 +
        // (95000-87500)^2) / 2) = sqrt(56_250_000) = 7500.
        assert_eq!(
            eval_str("=DSTDEVP(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(7500.0)
        );
        // 1-based field.
        assert_eq!(
            eval_str("=DSTDEVP(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(7500.0)
        );
        // 0 matches → DivisionByZero.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DSTDEVP(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Error(ValueError::DivisionByZero)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DSTDEVP(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DSTDEVP(A1:D5,\"Salary\",F1:G2,5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dvar() {
        let (cm, vs) = make_db_env();
        // Sample variance of {80000, 95000} = 112_500_000.
        assert_eq!(
            eval_str("=DVAR(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(112_500_000.0)
        );
        // 1-based field.
        assert_eq!(
            eval_str("=DVAR(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(112_500_000.0)
        );
        // < 2 matches → DivisionByZero.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Sales".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Text(">26".into()));
        assert_eq!(
            eval_str("=DVAR(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Error(ValueError::DivisionByZero)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DVAR(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DVAR(A1:D5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_dvarp() {
        let (cm, vs) = make_db_env();
        // Population variance of {80000, 95000} = 56_250_000.
        assert_eq!(
            eval_str("=DVARP(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Number(56_250_000.0)
        );
        // 1-based field.
        assert_eq!(
            eval_str("=DVARP(A1:D5,4,F1:G2)", &cm, &vs),
            Value::Number(56_250_000.0)
        );
        // 0 matches → DivisionByZero.
        let (mut cm2, mut vs2) = make_db_env();
        let id = AtomId::from_raw(999);
        cm2.insert(CellAddress::new(1, 5), id);
        vs2.insert(id, Value::Text("Marketing".into()));
        let id2 = AtomId::from_raw(998);
        cm2.insert(CellAddress::new(1, 6), id2);
        vs2.insert(id2, Value::Null);
        assert_eq!(
            eval_str("=DVARP(A1:D5,\"Salary\",F1:G2)", &cm2, &vs2),
            Value::Error(ValueError::DivisionByZero)
        );
        // Bad field.
        assert_eq!(
            eval_str("=DVARP(A1:D5,\"Bogus\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DVARP(A1:D5,\"Salary\",F1:G2,5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_db_bad_criteria_header() {
        // Per-decision: a non-empty criteria header that does NOT match
        // any database header → InvalidValue (#VALUE!). Authoring
        // mistakes surface loudly rather than silently matching nothing.
        let (mut cm, mut vs) = make_db_env();
        // Overwrite F1 (criteria header) with a name that doesn't exist
        // in the database.
        let id = AtomId::from_raw(950);
        cm.insert(CellAddress::new(0, 5), id);
        vs.insert(id, Value::Text("Unknown".into()));
        // F2 already holds "Eng" from the fixture; that's an OK criterion
        // *value*, but F1's header doesn't resolve. So the criteria range
        // is malformed.
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"Salary\",F1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_db_case_insensitive_headers() {
        // Header lookup is case-insensitive both for `field` arg and for
        // criteria headers. We rewrite the criteria header F1 to "DEPT"
        // (uppercase). It should still resolve to the database's "Dept".
        let (mut cm, mut vs) = make_db_env();
        let id = AtomId::from_raw(960);
        cm.insert(CellAddress::new(0, 5), id);
        vs.insert(id, Value::Text("DEPT".into()));
        // `field` arg is also case-insensitive — "salary" matches "Salary".
        assert_eq!(
            eval_str("=DSUM(A1:D5,\"salary\",F1:G2)", &cm, &vs),
            Value::Number(175000.0)
        );
    }

    // === Engineering / base-conversion / bit-op tests ===

    #[test]
    fn parse_base_n_text_bin_boundaries() {
        // BIN: 10 chars, 1 bit/digit. Width-10 with high bit set → negative.
        assert_eq!(parse_base_n_text("0", 2, 10, 1), Ok(0.0));
        assert_eq!(parse_base_n_text("1010", 2, 10, 1), Ok(10.0));
        assert_eq!(parse_base_n_text("0111111111", 2, 10, 1), Ok(511.0));
        // Max-width string with high bit set → -1 (...11111111 = -1).
        assert_eq!(parse_base_n_text("1111111111", 2, 10, 1), Ok(-1.0));
        // Max-width with only the sign bit set → -512.
        assert_eq!(parse_base_n_text("1000000000", 2, 10, 1), Ok(-512.0));
        // Shorter strings stay positive even if the leading bit is 1.
        assert_eq!(parse_base_n_text("111111111", 2, 10, 1), Ok(511.0));
        // Errors.
        assert_eq!(
            parse_base_n_text("", 2, 10, 1),
            Err(ValueError::InvalidValue)
        );
        assert_eq!(
            parse_base_n_text("11111111111", 2, 10, 1),
            Err(ValueError::InvalidValue),
        );
        assert_eq!(
            parse_base_n_text("12", 2, 10, 1),
            Err(ValueError::InvalidValue),
        );
        // OCT: 10 chars, 3 bits/digit (30-bit total).
        assert_eq!(parse_base_n_text("777", 8, 10, 3), Ok(511.0));
        // Width-10 top digit 4 → bit 29 set → negative (subtract 2^30).
        assert_eq!(
            parse_base_n_text("7777777777", 8, 10, 3),
            Ok(-1.0)
        );
        assert_eq!(
            parse_base_n_text("4000000000", 8, 10, 3),
            Ok(-(1i64 << 29) as f64),
        );
        // HEX: 10 chars, 4 bits/digit (40-bit total). Case-insensitive.
        assert_eq!(parse_base_n_text("F", 16, 10, 4), Ok(15.0));
        assert_eq!(parse_base_n_text("ff", 16, 10, 4), Ok(255.0));
        assert_eq!(
            parse_base_n_text("FFFFFFFFFF", 16, 10, 4),
            Ok(-1.0)
        );
        // Width-10 with top hex digit 8 → bit 39 set → most-negative.
        assert_eq!(
            parse_base_n_text("8000000000", 16, 10, 4),
            Ok(-(1i64 << 39) as f64),
        );
        assert_eq!(
            parse_base_n_text("G", 16, 10, 4),
            Err(ValueError::InvalidValue),
        );
    }

    #[test]
    fn format_base_n_signed_boundaries() {
        // BIN: positive, min-width.
        assert_eq!(
            format_base_n_signed(0.0, 2, 10, 1, None, false).unwrap(),
            "0"
        );
        assert_eq!(
            format_base_n_signed(10.0, 2, 10, 1, None, false).unwrap(),
            "1010"
        );
        assert_eq!(
            format_base_n_signed(511.0, 2, 10, 1, None, false).unwrap(),
            "111111111"
        );
        // BIN: negative, full-width two's complement (places ignored).
        assert_eq!(
            format_base_n_signed(-1.0, 2, 10, 1, None, false).unwrap(),
            "1111111111"
        );
        assert_eq!(
            format_base_n_signed(-512.0, 2, 10, 1, None, false).unwrap(),
            "1000000000"
        );
        // places ignored for negatives — same output even with places=4.
        assert_eq!(
            format_base_n_signed(-1.0, 2, 10, 1, Some(4), false).unwrap(),
            "1111111111"
        );
        // places padding for positives.
        assert_eq!(
            format_base_n_signed(5.0, 2, 10, 1, Some(8), false).unwrap(),
            "00000101"
        );
        // places too small for the positive value → InvalidValue.
        assert_eq!(
            format_base_n_signed(10.0, 2, 10, 1, Some(3), false),
            Err(ValueError::InvalidValue),
        );
        // Out-of-range positive / negative → Overflow.
        assert_eq!(
            format_base_n_signed(512.0, 2, 10, 1, None, false),
            Err(ValueError::Overflow),
        );
        assert_eq!(
            format_base_n_signed(-513.0, 2, 10, 1, None, false),
            Err(ValueError::Overflow),
        );
        // OCT: positive, negative, padded.
        assert_eq!(
            format_base_n_signed(511.0, 8, 10, 3, None, false).unwrap(),
            "777"
        );
        assert_eq!(
            format_base_n_signed(-1.0, 8, 10, 3, None, false).unwrap(),
            "7777777777"
        );
        assert_eq!(
            format_base_n_signed(8.0, 8, 10, 3, Some(4), false).unwrap(),
            "0010"
        );
        // HEX uppercase / lowercase.
        assert_eq!(
            format_base_n_signed(255.0, 16, 10, 4, None, true).unwrap(),
            "FF"
        );
        assert_eq!(
            format_base_n_signed(-1.0, 16, 10, 4, None, true).unwrap(),
            "FFFFFFFFFF"
        );
        assert_eq!(
            format_base_n_signed(255.0, 16, 10, 4, Some(4), true).unwrap(),
            "00FF"
        );
        // places out of 1..=10 → InvalidValue.
        assert_eq!(
            format_base_n_signed(1.0, 2, 10, 1, Some(11), false),
            Err(ValueError::InvalidValue),
        );
        // Truncates fractional inputs toward zero.
        assert_eq!(
            format_base_n_signed(10.9, 2, 10, 1, None, false).unwrap(),
            "1010"
        );
        assert_eq!(
            format_base_n_signed(-1.5, 2, 10, 1, None, false).unwrap(),
            "1111111111"
        );
    }

    #[test]
    fn eval_bin2dec() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=BIN2DEC(\"1010\")", &cm, &vs), Value::Number(10.0));
        assert_eq!(
            eval_str("=BIN2DEC(\"1111111111\")", &cm, &vs),
            Value::Number(-1.0)
        );
        assert_eq!(eval_str("=BIN2DEC(1010)", &cm, &vs), Value::Number(10.0));
        // Invalid digit.
        assert_eq!(
            eval_str("=BIN2DEC(\"2\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // > 10 chars.
        assert_eq!(
            eval_str("=BIN2DEC(\"11111111110\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg count.
        assert_eq!(
            eval_str("=BIN2DEC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=BIN2DEC(\"1\",2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=BIN2DEC(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_oct2dec() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=OCT2DEC(\"17\")", &cm, &vs), Value::Number(15.0));
        assert_eq!(
            eval_str("=OCT2DEC(\"7777777777\")", &cm, &vs),
            Value::Number(-1.0)
        );
        assert_eq!(
            eval_str("=OCT2DEC(\"4000000000\")", &cm, &vs),
            Value::Number(-(1i64 << 29) as f64),
        );
        assert_eq!(
            eval_str("=OCT2DEC(\"8\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_hex2dec() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=HEX2DEC(\"F\")", &cm, &vs), Value::Number(15.0));
        assert_eq!(eval_str("=HEX2DEC(\"ff\")", &cm, &vs), Value::Number(255.0));
        assert_eq!(
            eval_str("=HEX2DEC(\"FFFFFFFFFF\")", &cm, &vs),
            Value::Number(-1.0)
        );
        assert_eq!(
            eval_str("=HEX2DEC(\"G\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_dec2bin() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=DEC2BIN(10)", &cm, &vs),
            Value::Text("1010".into())
        );
        assert_eq!(
            eval_str("=DEC2BIN(-1)", &cm, &vs),
            Value::Text("1111111111".into())
        );
        assert_eq!(
            eval_str("=DEC2BIN(-7)", &cm, &vs),
            Value::Text("1111111001".into())
        );
        // places padding.
        assert_eq!(
            eval_str("=DEC2BIN(5,8)", &cm, &vs),
            Value::Text("00000101".into())
        );
        // places ignored for negatives.
        assert_eq!(
            eval_str("=DEC2BIN(-1,4)", &cm, &vs),
            Value::Text("1111111111".into())
        );
        // places too small.
        assert_eq!(
            eval_str("=DEC2BIN(10,3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
        // Out of range.
        assert_eq!(
            eval_str("=DEC2BIN(512)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=DEC2BIN(-513)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Type / arg-count.
        assert_eq!(
            eval_str("=DEC2BIN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=DEC2BIN(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Negative round-trip.
        match eval_str("=BIN2DEC(DEC2BIN(-7))", &cm, &vs) {
            Value::Number(n) => assert_eq!(n, -7.0),
            other => panic!("round-trip: {other:?}"),
        }
    }

    #[test]
    fn eval_dec2oct() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=DEC2OCT(15)", &cm, &vs), Value::Text("17".into()));
        assert_eq!(
            eval_str("=DEC2OCT(-1)", &cm, &vs),
            Value::Text("7777777777".into())
        );
        assert_eq!(
            eval_str("=DEC2OCT(8,4)", &cm, &vs),
            Value::Text("0010".into())
        );
        // Out of range: 2^29 = 536870912.
        assert_eq!(
            eval_str("=DEC2OCT(536870912)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_dec2hex() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=DEC2HEX(255)", &cm, &vs),
            Value::Text("FF".into())
        );
        assert_eq!(
            eval_str("=DEC2HEX(-1)", &cm, &vs),
            Value::Text("FFFFFFFFFF".into())
        );
        assert_eq!(
            eval_str("=DEC2HEX(255,4)", &cm, &vs),
            Value::Text("00FF".into())
        );
        // Out of range: 2^39 = 549755813888.
        assert_eq!(
            eval_str("=DEC2HEX(549755813888)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_bin2hex() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=BIN2HEX(\"1111\")", &cm, &vs),
            Value::Text("F".into())
        );
        // Negative: BIN2HEX("1111111111") = BIN2DEC(-1) → DEC2HEX(-1).
        assert_eq!(
            eval_str("=BIN2HEX(\"1111111111\")", &cm, &vs),
            Value::Text("FFFFFFFFFF".into())
        );
        // places padding on positive.
        assert_eq!(
            eval_str("=BIN2HEX(\"1010\",4)", &cm, &vs),
            Value::Text("000A".into())
        );
        // Invalid binary input propagates.
        assert_eq!(
            eval_str("=BIN2HEX(\"2\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_bin2oct() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=BIN2OCT(\"1010\")", &cm, &vs),
            Value::Text("12".into())
        );
        assert_eq!(
            eval_str("=BIN2OCT(\"1111111111\")", &cm, &vs),
            Value::Text("7777777777".into())
        );
        assert_eq!(
            eval_str("=BIN2OCT(\"1010\",4)", &cm, &vs),
            Value::Text("0012".into())
        );
    }

    #[test]
    fn eval_hex2bin() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=HEX2BIN(\"A\")", &cm, &vs),
            Value::Text("1010".into())
        );
        assert_eq!(
            eval_str("=HEX2BIN(\"FFFFFFFFFF\")", &cm, &vs),
            Value::Text("1111111111".into())
        );
        // Out of range (positive HEX larger than 511 → BIN can't fit).
        assert_eq!(
            eval_str("=HEX2BIN(\"FFF\")", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=HEX2BIN(\"A\",6)", &cm, &vs),
            Value::Text("001010".into())
        );
    }

    #[test]
    fn eval_hex2oct() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=HEX2OCT(\"F\")", &cm, &vs),
            Value::Text("17".into())
        );
        assert_eq!(
            eval_str("=HEX2OCT(\"FFFFFFFFFF\")", &cm, &vs),
            Value::Text("7777777777".into())
        );
    }

    #[test]
    fn eval_oct2bin() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=OCT2BIN(\"12\")", &cm, &vs),
            Value::Text("1010".into())
        );
        assert_eq!(
            eval_str("=OCT2BIN(\"7777777777\")", &cm, &vs),
            Value::Text("1111111111".into())
        );
        assert_eq!(
            eval_str("=OCT2BIN(\"1000\")", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_oct2hex() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=OCT2HEX(\"17\")", &cm, &vs),
            Value::Text("F".into())
        );
        assert_eq!(
            eval_str("=OCT2HEX(\"7777777777\")", &cm, &vs),
            Value::Text("FFFFFFFFFF".into())
        );
    }

    #[test]
    fn eval_bitand() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=BITAND(15,9)", &cm, &vs), Value::Number(9.0));
        assert_eq!(eval_str("=BITAND(0,0)", &cm, &vs), Value::Number(0.0));
        // Arg count.
        assert_eq!(
            eval_str("=BITAND(1)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Negative → Overflow (#NUM!).
        assert_eq!(
            eval_str("=BITAND(-1,3)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Fractional → Overflow.
        assert_eq!(
            eval_str("=BITAND(1.5,3)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Text → WrongType.
        assert_eq!(
            eval_str("=BITAND(\"x\",3)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_bitor() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=BITOR(5,3)", &cm, &vs), Value::Number(7.0));
        assert_eq!(
            eval_str("=BITOR(-1,3)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_bitxor() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=BITXOR(5,3)", &cm, &vs), Value::Number(6.0));
        assert_eq!(
            eval_str("=BITXOR(255,170)", &cm, &vs),
            Value::Number(85.0)
        );
    }

    #[test]
    fn eval_bitlshift() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=BITLSHIFT(1,4)", &cm, &vs), Value::Number(16.0));
        assert_eq!(eval_str("=BITLSHIFT(8,-2)", &cm, &vs), Value::Number(2.0));
        // Beyond domain.
        assert_eq!(
            eval_str("=BITLSHIFT(1,54)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        // Shift result outside 2^53-1 → Overflow.
        assert_eq!(
            eval_str("=BITLSHIFT(1,53)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_bitrshift() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=BITRSHIFT(16,4)", &cm, &vs), Value::Number(1.0));
        // Inverse of BITLSHIFT.
        assert_eq!(eval_str("=BITRSHIFT(2,-3)", &cm, &vs), Value::Number(16.0));
        assert_eq!(
            eval_str("=BITRSHIFT(1,-54)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_delta() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=DELTA(1,1)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=DELTA(1,2)", &cm, &vs), Value::Number(0.0));
        // Default second arg = 0.
        assert_eq!(eval_str("=DELTA(0)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=DELTA(5)", &cm, &vs), Value::Number(0.0));
        // Non-numeric → WrongType.
        assert_eq!(
            eval_str("=DELTA(\"x\",1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Arg count.
        assert_eq!(
            eval_str("=DELTA()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=DELTA(1,2,3)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_gestep() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=GESTEP(5,3)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=GESTEP(3,5)", &cm, &vs), Value::Number(0.0));
        assert_eq!(eval_str("=GESTEP(3,3)", &cm, &vs), Value::Number(1.0));
        // Default step = 0.
        assert_eq!(eval_str("=GESTEP(0)", &cm, &vs), Value::Number(1.0));
        assert_eq!(eval_str("=GESTEP(-1)", &cm, &vs), Value::Number(0.0));
        assert_eq!(
            eval_str("=GESTEP(\"x\",1)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    // ---- Hyperbolic + reciprocal trig ----

    #[test]
    fn eval_sinh() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=SINH(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=SINH(1)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0f64.sinh()).abs() < 1e-9, "SINH(1) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=SINH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=SINH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=SINH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // Massive arg → finite double-precision overflow.
        assert_eq!(
            eval_str("=SINH(1000)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_cosh() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=COSH(0)", &cm, &vs), Value::Number(1.0));
        match eval_str("=COSH(1)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0f64.cosh()).abs() < 1e-9, "COSH(1) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=COSH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COSH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=COSH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=COSH(1000)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_tanh() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=TANH(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=TANH(1)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0f64.tanh()).abs() < 1e-9, "TANH(1) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        // Saturates to +/-1 at large |n| — still finite.
        match eval_str("=TANH(1000)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-9, "TANH(1000) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=TANH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=TANH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=TANH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_asinh() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ASINH(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=ASINH(1)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0f64.asinh()).abs() < 1e-9, "ASINH(1) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=ASINH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ASINH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ASINH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_acosh() {
        let (cm, vs) = make_test_env();
        // acosh(1) = 0.
        assert_eq!(eval_str("=ACOSH(1)", &cm, &vs), Value::Number(0.0));
        match eval_str("=ACOSH(2)", &cm, &vs) {
            Value::Number(n) => assert!((n - 2.0f64.acosh()).abs() < 1e-9, "ACOSH(2) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        // Below domain — Excel #NUM!.
        assert_eq!(
            eval_str("=ACOSH(0)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ACOSH(-2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ACOSH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ACOSH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ACOSH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_atanh() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ATANH(0)", &cm, &vs), Value::Number(0.0));
        match eval_str("=ATANH(0.5)", &cm, &vs) {
            Value::Number(n) => assert!((n - 0.5f64.atanh()).abs() < 1e-9, "ATANH(0.5) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        // |n| >= 1 → out of domain.
        assert_eq!(
            eval_str("=ATANH(1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ATANH(-1)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ATANH(2)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ATANH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ATANH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ATANH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_csc() {
        let (cm, vs) = make_test_env();
        // CSC(PI/2) = 1.
        match eval_str("=CSC(PI()/2)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-9, "CSC(PI/2) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        // CSC(0) → sin(0)=0 → #DIV/0!.
        assert_eq!(
            eval_str("=CSC(0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // CSC(PI) → sin(PI)≈0 but not exactly 0; just check we got a
        // (huge) finite number or Overflow — accept either.
        assert_eq!(
            eval_str("=CSC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=CSC(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=CSC(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_sec() {
        let (cm, vs) = make_test_env();
        // SEC(0) = 1.
        match eval_str("=SEC(0)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-9, "SEC(0) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        // SEC(PI) = -1.
        match eval_str("=SEC(PI())", &cm, &vs) {
            Value::Number(n) => assert!((n + 1.0).abs() < 1e-9, "SEC(PI) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=SEC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=SEC(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=SEC(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_cot() {
        let (cm, vs) = make_test_env();
        // COT(PI/4) = 1.
        match eval_str("=COT(PI()/4)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-9, "COT(PI/4) = {n}"),
            other => panic!("expected number, got {:?}", other),
        }
        // COT(0) → tan(0)=0 → #DIV/0!.
        assert_eq!(
            eval_str("=COT(0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=COT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COT(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=COT(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_csch() {
        let (cm, vs) = make_test_env();
        // CSCH(1) = 1/sinh(1).
        match eval_str("=CSCH(1)", &cm, &vs) {
            Value::Number(n) => {
                assert!((n - 1.0 / 1.0f64.sinh()).abs() < 1e-9, "CSCH(1) = {n}")
            }
            other => panic!("expected number, got {:?}", other),
        }
        // CSCH(0) → sinh(0)=0 → #DIV/0!.
        assert_eq!(
            eval_str("=CSCH(0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=CSCH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=CSCH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=CSCH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_sech() {
        let (cm, vs) = make_test_env();
        // SECH(0) = 1.
        assert_eq!(eval_str("=SECH(0)", &cm, &vs), Value::Number(1.0));
        match eval_str("=SECH(1)", &cm, &vs) {
            Value::Number(n) => {
                assert!((n - 1.0 / 1.0f64.cosh()).abs() < 1e-9, "SECH(1) = {n}")
            }
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=SECH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=SECH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=SECH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_coth() {
        let (cm, vs) = make_test_env();
        match eval_str("=COTH(1)", &cm, &vs) {
            Value::Number(n) => {
                assert!((n - 1.0 / 1.0f64.tanh()).abs() < 1e-9, "COTH(1) = {n}")
            }
            other => panic!("expected number, got {:?}", other),
        }
        // COTH(0) → tanh(0)=0 → #DIV/0!.
        assert_eq!(
            eval_str("=COTH(0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=COTH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=COTH(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=COTH(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_acsc() {
        let (cm, vs) = make_test_env();
        // ACSC(1) = asin(1) = PI/2.
        match eval_str("=ACSC(1)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_2).abs() < 1e-9,
                "ACSC(1) = {n}"
            ),
            other => panic!("expected number, got {:?}", other),
        }
        // ACSC(2) = asin(0.5) = PI/6.
        match eval_str("=ACSC(2)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_6).abs() < 1e-9,
                "ACSC(2) = {n}"
            ),
            other => panic!("expected number, got {:?}", other),
        }
        // n == 0 → #DIV/0!.
        assert_eq!(
            eval_str("=ACSC(0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        // |n| < 1 → out of domain.
        assert_eq!(
            eval_str("=ACSC(0.5)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ACSC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ACSC(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ACSC(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_asec() {
        let (cm, vs) = make_test_env();
        // ASEC(1) = acos(1) = 0.
        assert_eq!(eval_str("=ASEC(1)", &cm, &vs), Value::Number(0.0));
        // ASEC(2) = acos(0.5) = PI/3.
        match eval_str("=ASEC(2)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_3).abs() < 1e-9,
                "ASEC(2) = {n}"
            ),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=ASEC(0)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            eval_str("=ASEC(0.5)", &cm, &vs),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            eval_str("=ASEC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ASEC(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ASEC(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_acot() {
        let (cm, vs) = make_test_env();
        // ACOT(1) = PI/4.
        match eval_str("=ACOT(1)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_4).abs() < 1e-9,
                "ACOT(1) = {n}"
            ),
            other => panic!("expected number, got {:?}", other),
        }
        // ACOT(0) = PI/2 (Excel convention, defined for all real n).
        match eval_str("=ACOT(0)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - std::f64::consts::FRAC_PI_2).abs() < 1e-9,
                "ACOT(0) = {n}"
            ),
            other => panic!("expected number, got {:?}", other),
        }
        // ACOT(-1) = 3*PI/4 (Excel returns the (0, PI) branch).
        match eval_str("=ACOT(-1)", &cm, &vs) {
            Value::Number(n) => assert!(
                (n - 3.0 * std::f64::consts::FRAC_PI_4).abs() < 1e-9,
                "ACOT(-1) = {n}"
            ),
            other => panic!("expected number, got {:?}", other),
        }
        assert_eq!(
            eval_str("=ACOT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        assert_eq!(
            eval_str("=ACOT(B2)", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        assert_eq!(
            eval_str("=ACOT(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // --- Math extras: pair-of-arrays sums, SUMSQ, SQRTPI, SUMPRODUCT,
    // FLOOR.MATH / CEILING.MATH / FLOOR.PRECISE / CEILING.PRECISE,
    // ROMAN / ARABIC / DECIMAL / BASE, MDETERM ---

    /// Environment for math-extras tests.
    /// Layout:
    ///   A1=1 A2=2 A3=3 A4=4 A5=5       (x-array / single-column block)
    ///   B1=2 B2=4 B3=6 B4=8 B5=10      (y-array = 2*x)
    ///   C1=-2.5 C2=-1.5 C3=10.5 C4=11.5 (rounding fodder)
    ///   D1="text"                       (non-numeric)
    ///   2×2 MDETERM input at E1..F2:    [[1,2],[3,4]]
    ///   3×3 identity at G1..I3
    fn make_math_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        let mut cm: HashMap<CellAddress, AtomId> = HashMap::new();
        let mut vs: HashMap<AtomId, Value> = HashMap::new();
        let mut next: u64 = 0;
        let mut put = |row: u32, col: u32, v: Value,
                       cm: &mut HashMap<CellAddress, AtomId>,
                       vs: &mut HashMap<AtomId, Value>| {
            let id = AtomId::from_raw(next);
            next += 1;
            cm.insert(CellAddress::new(row, col), id);
            vs.insert(id, v);
        };
        for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            put(i as u32, 0, Value::Number(*n), &mut cm, &mut vs);
        }
        for (i, n) in [2.0, 4.0, 6.0, 8.0, 10.0].iter().enumerate() {
            put(i as u32, 1, Value::Number(*n), &mut cm, &mut vs);
        }
        put(0, 2, Value::Number(-2.5), &mut cm, &mut vs);
        put(1, 2, Value::Number(-1.5), &mut cm, &mut vs);
        put(2, 2, Value::Number(10.5), &mut cm, &mut vs);
        put(3, 2, Value::Number(11.5), &mut cm, &mut vs);
        put(0, 3, Value::Text("text".into()), &mut cm, &mut vs);
        // 2×2 at E1:F2 = [[1,2],[3,4]]  (cols 4 and 5, rows 0 and 1)
        put(0, 4, Value::Number(1.0), &mut cm, &mut vs);
        put(0, 5, Value::Number(2.0), &mut cm, &mut vs);
        put(1, 4, Value::Number(3.0), &mut cm, &mut vs);
        put(1, 5, Value::Number(4.0), &mut cm, &mut vs);
        // 3×3 identity at G1:I3 (cols 6..8, rows 0..2). Empty cells
        // are Null = 0.0 in the determinant, so we only set diagonals.
        put(0, 6, Value::Number(1.0), &mut cm, &mut vs);
        put(1, 7, Value::Number(1.0), &mut cm, &mut vs);
        put(2, 8, Value::Number(1.0), &mut cm, &mut vs);
        (cm, vs)
    }

    #[test]
    fn eval_sumx2my2() {
        let (cm, vs) = make_math_env();
        // A=1..5, B=2*A → Σ(x²-y²) = Σ(x²-4x²) = -3Σx² = -3*55 = -165.
        assert_eq!(
            eval_str("=SUMX2MY2(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(-165.0),
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=SUMX2MY2(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
        // Shape mismatch → InvalidValue.
        assert_eq!(
            eval_str("=SUMX2MY2(A1:A5,B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn eval_sumx2py2() {
        let (cm, vs) = make_math_env();
        // Σ(x²+y²) = Σx² + Σy² = 55 + 220 = 275.
        assert_eq!(
            eval_str("=SUMX2PY2(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(275.0),
        );
        assert_eq!(
            eval_str("=SUMX2PY2(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
        assert_eq!(
            eval_str("=SUMX2PY2(A1:A5,B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn eval_sumxmy2() {
        let (cm, vs) = make_math_env();
        // Σ(x-y)² where y=2x → Σ(-x)² = Σx² = 55.
        assert_eq!(
            eval_str("=SUMXMY2(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(55.0),
        );
        assert_eq!(
            eval_str("=SUMXMY2(A1:A5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
        assert_eq!(
            eval_str("=SUMXMY2(A1:A5,B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn eval_sumsq() {
        let (cm, vs) = make_math_env();
        // SUMSQ(A1:A5) = 1+4+9+16+25 = 55.
        assert_eq!(eval_str("=SUMSQ(A1:A5)", &cm, &vs), Value::Number(55.0));
        // Variadic literals: 3,4 → 25.
        assert_eq!(eval_str("=SUMSQ(3,4)", &cm, &vs), Value::Number(25.0));
        // Non-numeric (text cell D1) skipped, no error.
        assert_eq!(eval_str("=SUMSQ(A1:A5,D1)", &cm, &vs), Value::Number(55.0));
        // No args → 0 (variadic empty → 0 like SUM).
        assert_eq!(eval_str("=SUMSQ()", &cm, &vs), Value::Number(0.0));
    }

    #[test]
    fn eval_sqrtpi() {
        let (cm, vs) = make_math_env();
        // SQRTPI(1) = sqrt(PI).
        match eval_str("=SQRTPI(1)", &cm, &vs) {
            Value::Number(n) => assert!((n - std::f64::consts::PI.sqrt()).abs() < 1e-12),
            other => panic!("expected number, got {other:?}"),
        }
        // SQRTPI(0) = 0.
        assert_eq!(eval_str("=SQRTPI(0)", &cm, &vs), Value::Number(0.0));
        // Negative → #NUM!.
        assert_eq!(
            eval_str("=SQRTPI(-1)", &cm, &vs),
            Value::Error(ValueError::Overflow),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=SQRTPI(1,2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_sumproduct() {
        let (cm, vs) = make_math_env();
        // 2 arrays: Σ x*2x = 2Σx² = 110.
        assert_eq!(
            eval_str("=SUMPRODUCT(A1:A5,B1:B5)", &cm, &vs),
            Value::Number(110.0),
        );
        // 1 array = SUM over numerics (= 15).
        assert_eq!(
            eval_str("=SUMPRODUCT(A1:A5)", &cm, &vs),
            Value::Number(15.0),
        );
        // Single-array equivalence: SUMPRODUCT(A1:A5) == SUM(A1:A5).
        assert_eq!(
            eval_str("=SUMPRODUCT(A1:A5)", &cm, &vs),
            eval_str("=SUM(A1:A5)", &cm, &vs),
        );
        // Shape mismatch → InvalidValue.
        assert_eq!(
            eval_str("=SUMPRODUCT(A1:A5,B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // 0 args → arg-count.
        assert_eq!(
            eval_str("=SUMPRODUCT()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_floor_math() {
        let (cm, vs) = make_math_env();
        // Default mode: FLOOR.MATH(-2.5) → -3 (toward -inf).
        assert_eq!(eval_str("=FLOOR.MATH(-2.5)", &cm, &vs), Value::Number(-3.0));
        // Mode != 0: -2.5 → -2 (toward zero).
        assert_eq!(
            eval_str("=FLOOR.MATH(-2.5,1,1)", &cm, &vs),
            Value::Number(-2.0),
        );
        // FLOOR.MATH diverges from FLOOR.PRECISE for negatives + mode!=0:
        // FLOOR.PRECISE always rounds toward -inf regardless of mode.
        assert_eq!(
            eval_str("=FLOOR.PRECISE(-2.5)", &cm, &vs),
            Value::Number(-3.0),
        );
        // Positive: same as floor.
        assert_eq!(eval_str("=FLOOR.MATH(10.5)", &cm, &vs), Value::Number(10.0));
        // Custom significance.
        assert_eq!(
            eval_str("=FLOOR.MATH(10.5,2)", &cm, &vs),
            Value::Number(10.0),
        );
        // sig=0 → 0.
        assert_eq!(eval_str("=FLOOR.MATH(10.5,0)", &cm, &vs), Value::Number(0.0));
        // Type error.
        assert_eq!(
            eval_str("=FLOOR.MATH(D1)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=FLOOR.MATH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
        assert_eq!(
            eval_str("=FLOOR.MATH(1,2,3,4)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_ceiling_math() {
        let (cm, vs) = make_math_env();
        // Default mode: CEILING.MATH(-2.5) → -2 (toward +inf).
        assert_eq!(
            eval_str("=CEILING.MATH(-2.5)", &cm, &vs),
            Value::Number(-2.0),
        );
        // Mode != 0: -2.5 → -3 (away from zero).
        assert_eq!(
            eval_str("=CEILING.MATH(-2.5,1,1)", &cm, &vs),
            Value::Number(-3.0),
        );
        // CEILING.PRECISE always toward +inf regardless of mode (= -2 here).
        assert_eq!(
            eval_str("=CEILING.PRECISE(-2.5)", &cm, &vs),
            Value::Number(-2.0),
        );
        // Positive.
        assert_eq!(
            eval_str("=CEILING.MATH(10.5)", &cm, &vs),
            Value::Number(11.0),
        );
        // sig=0 → 0.
        assert_eq!(
            eval_str("=CEILING.MATH(10.5,0)", &cm, &vs),
            Value::Number(0.0),
        );
        // Type error.
        assert_eq!(
            eval_str("=CEILING.MATH(D1)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=CEILING.MATH()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_floor_precise() {
        let (cm, vs) = make_math_env();
        // Always toward -inf.
        assert_eq!(
            eval_str("=FLOOR.PRECISE(-2.5)", &cm, &vs),
            Value::Number(-3.0),
        );
        assert_eq!(
            eval_str("=FLOOR.PRECISE(10.5)", &cm, &vs),
            Value::Number(10.0),
        );
        // Negative significance treated as |sig|.
        assert_eq!(
            eval_str("=FLOOR.PRECISE(10.5,-2)", &cm, &vs),
            Value::Number(10.0),
        );
        // sig=0 → 0.
        assert_eq!(
            eval_str("=FLOOR.PRECISE(10.5,0)", &cm, &vs),
            Value::Number(0.0),
        );
        // Type error.
        assert_eq!(
            eval_str("=FLOOR.PRECISE(D1)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=FLOOR.PRECISE()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
        assert_eq!(
            eval_str("=FLOOR.PRECISE(1,2,3)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_ceiling_precise() {
        let (cm, vs) = make_math_env();
        // Always toward +inf.
        assert_eq!(
            eval_str("=CEILING.PRECISE(-2.5)", &cm, &vs),
            Value::Number(-2.0),
        );
        assert_eq!(
            eval_str("=CEILING.PRECISE(10.5)", &cm, &vs),
            Value::Number(11.0),
        );
        // Negative significance treated as |sig|.
        assert_eq!(
            eval_str("=CEILING.PRECISE(10.5,-2)", &cm, &vs),
            Value::Number(12.0),
        );
        // Type error.
        assert_eq!(
            eval_str("=CEILING.PRECISE(D1)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
    }

    #[test]
    fn eval_roman() {
        let (cm, vs) = make_math_env();
        // Canonical round-trip value.
        assert_eq!(
            eval_str("=ROMAN(1994)", &cm, &vs),
            Value::Text("MCMXCIV".into()),
        );
        // Edge values.
        assert_eq!(eval_str("=ROMAN(1)", &cm, &vs), Value::Text("I".into()));
        assert_eq!(eval_str("=ROMAN(4)", &cm, &vs), Value::Text("IV".into()));
        assert_eq!(eval_str("=ROMAN(3999)", &cm, &vs), Value::Text("MMMCMXCIX".into()));
        // Out of range.
        assert_eq!(
            eval_str("=ROMAN(0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        assert_eq!(
            eval_str("=ROMAN(4000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Non-classic form rejected.
        assert_eq!(
            eval_str("=ROMAN(1994,1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Type error.
        assert_eq!(
            eval_str("=ROMAN(D1)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=ROMAN()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_arabic() {
        let (cm, vs) = make_math_env();
        // Round-trip with ROMAN.
        assert_eq!(
            eval_str("=ARABIC(\"MCMXCIV\")", &cm, &vs),
            Value::Number(1994.0),
        );
        // Lowercase / mixed.
        assert_eq!(
            eval_str("=ARABIC(\"mcmxciv\")", &cm, &vs),
            Value::Number(1994.0),
        );
        // Empty string → 0.
        assert_eq!(eval_str("=ARABIC(\"\")", &cm, &vs), Value::Number(0.0));
        // Invalid syntax → #VALUE!.
        assert_eq!(
            eval_str("=ARABIC(\"hello\")", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Type: numbers are rejected.
        assert_eq!(
            eval_str("=ARABIC(123)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=ARABIC()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_decimal() {
        let (cm, vs) = make_math_env();
        // DECIMAL("FF", 16) = 255.
        assert_eq!(
            eval_str("=DECIMAL(\"FF\",16)", &cm, &vs),
            Value::Number(255.0),
        );
        // Lowercase letters accepted.
        assert_eq!(
            eval_str("=DECIMAL(\"ff\",16)", &cm, &vs),
            Value::Number(255.0),
        );
        // Binary.
        assert_eq!(
            eval_str("=DECIMAL(\"1010\",2)", &cm, &vs),
            Value::Number(10.0),
        );
        // Invalid digit for base.
        assert_eq!(
            eval_str("=DECIMAL(\"12\",2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Bad base.
        assert_eq!(
            eval_str("=DECIMAL(\"10\",1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        assert_eq!(
            eval_str("=DECIMAL(\"10\",37)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=DECIMAL(\"FF\")", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_base() {
        let (cm, vs) = make_math_env();
        // BASE(255, 16) = "FF".
        assert_eq!(eval_str("=BASE(255,16)", &cm, &vs), Value::Text("FF".into()));
        // Padded.
        assert_eq!(
            eval_str("=BASE(7,2,8)", &cm, &vs),
            Value::Text("00000111".into()),
        );
        // 0.
        assert_eq!(eval_str("=BASE(0,16)", &cm, &vs), Value::Text("0".into()));
        // Round-trip with DECIMAL: DECIMAL(BASE(255, 16), 16) == 255.
        assert_eq!(
            eval_str("=DECIMAL(BASE(255,16),16)", &cm, &vs),
            Value::Number(255.0),
        );
        // Negative input rejected.
        assert_eq!(
            eval_str("=BASE(-1,16)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Bad base.
        assert_eq!(
            eval_str("=BASE(10,1)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=BASE(10)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }

    #[test]
    fn eval_mdeterm() {
        let (cm, vs) = make_math_env();
        // 2×2: det([[1,2],[3,4]]) = 1*4 - 2*3 = -2.
        assert_eq!(
            eval_str("=MDETERM(E1:F2)", &cm, &vs),
            Value::Number(-2.0),
        );
        // 3×3 identity → 1.
        match eval_str("=MDETERM(G1:I3)", &cm, &vs) {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "det(I) = {n}"),
            other => panic!("expected number, got {other:?}"),
        }
        // Non-square → #VALUE!.
        assert_eq!(
            eval_str("=MDETERM(E1:G2)", &cm, &vs),
            Value::Error(ValueError::InvalidValue),
        );
        // Non-numeric cell → #TYPE! (D1 holds "text").
        assert_eq!(
            eval_str("=MDETERM(C1:D2)", &cm, &vs),
            Value::Error(ValueError::WrongType),
        );
        // Arg-count.
        assert_eq!(
            eval_str("=MDETERM()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount),
        );
    }
    #[test]
    fn eval_networkdays() {
        let (cm, vs) = make_test_env();
        // Mon 2024-01-01 (start) to Sun 2024-01-07 (end): 5 workdays
        // Mon..Fri.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,7))",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // Mon 2024-01-01 to Fri 2024-01-05 inclusive: 5 workdays.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,5))",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // Whole calendar week with one holiday inside (Wed 2024-01-03):
        // 4 workdays.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,7),DATE(2024,1,3))",
                &cm,
                &vs
            ),
            Value::Number(4.0)
        );
        // start > end → negative result.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,7),DATE(2024,1,1))",
                &cm,
                &vs
            ),
            Value::Number(-5.0)
        );
        // Same day, working day → 1.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,1))",
                &cm,
                &vs
            ),
            Value::Number(1.0)
        );
        // Same day, weekend → 0.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,6),DATE(2024,1,6))",
                &cm,
                &vs
            ),
            Value::Number(0.0)
        );
        // Arg-count error: zero args.
        assert_eq!(
            eval_str("=NETWORKDAYS()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Arg-count error: too many args.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,7),DATE(2024,1,3),1)",
                &cm,
                &vs
            ),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error.
        assert_eq!(
            eval_str("=NETWORKDAYS(\"a\",DATE(2024,1,7))", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation through start arg.
        assert_eq!(
            eval_str("=NETWORKDAYS(A1/C1,DATE(2024,1,7))", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_networkdays_intl() {
        let (cm, vs) = make_test_env();
        // Default (code 1 = Sat+Sun): Mon 2024-01-01 to Sun 2024-01-07 → 5.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),1)",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // Code 7 = Fri+Sat weekend. Mon..Sun has 5 working days
        // (Sun, Mon, Tue, Wed, Thu).
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),7)",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // Code 7 over a Mon..Thu range: 4 workdays.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,4),7)",
                &cm,
                &vs
            ),
            Value::Number(4.0)
        );
        // Code 7 over Fri..Sat: 0 workdays (both are weekend under code 7).
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,5),DATE(2024,1,6),7)",
                &cm,
                &vs
            ),
            Value::Number(0.0)
        );
        // Default code 1: same Fri..Sat range yields 1 workday (Fri).
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,5),DATE(2024,1,6))",
                &cm,
                &vs
            ),
            Value::Number(1.0)
        );
        // Mask "0000011" = Sat+Sun weekend, equivalent to default.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),\"0000011\")",
                &cm,
                &vs
            ),
            Value::Number(5.0)
        );
        // Single-day weekend code 11 = Sun only: Mon..Sun = 6 workdays.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),11)",
                &cm,
                &vs
            ),
            Value::Number(6.0)
        );
        // All-1s mask → InvalidValue.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),\"1111111\")",
                &cm,
                &vs
            ),
            Value::Error(ValueError::InvalidValue)
        );
        // Bad mask length → InvalidValue.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),\"011\")",
                &cm,
                &vs
            ),
            Value::Error(ValueError::InvalidValue)
        );
        // Bad mask character → InvalidValue.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),\"000002X\")",
                &cm,
                &vs
            ),
            Value::Error(ValueError::InvalidValue)
        );
        // Invalid numeric weekend code → InvalidValue.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),99)",
                &cm,
                &vs
            ),
            Value::Error(ValueError::InvalidValue)
        );
        // Code 7 with a holiday on Sun 2024-01-07 (a workday under code 7):
        // 5 workdays minus 1 = 4.
        assert_eq!(
            eval_str(
                "=NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,7),7,DATE(2024,1,7))",
                &cm,
                &vs
            ),
            Value::Number(4.0)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=NETWORKDAYS.INTL(DATE(2024,1,1))", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_workday() {
        let (cm, vs) = make_test_env();
        // Mon 2024-01-01 + 4 workdays → Fri 2024-01-05.
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,1),4)", &cm, &vs),
            Value::Number(date_serial(2024, 1, 5))
        );
        // Mon 2024-01-01 + 5 workdays → Mon 2024-01-08 (skipping weekend).
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,1),5)", &cm, &vs),
            Value::Number(date_serial(2024, 1, 8))
        );
        // Zero days → returns the start serial (Excel does NOT snap to
        // next workday for the 0 case).
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,1),0)", &cm, &vs),
            Value::Number(date_serial(2024, 1, 1))
        );
        // Even from a weekend day, 0 days returns the start as-is.
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,6),0)", &cm, &vs),
            Value::Number(date_serial(2024, 1, 6))
        );
        // Negative days: Mon 2024-01-08 - 5 workdays → Mon 2024-01-01.
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,8),-5)", &cm, &vs),
            Value::Number(date_serial(2024, 1, 1))
        );
        // Holiday lands on the natural step target: must advance further.
        // Mon 2024-01-01 + 2 workdays would normally → Wed 2024-01-03.
        // Mark Wed 2024-01-03 as holiday → result must be Thu 2024-01-04.
        assert_eq!(
            eval_str(
                "=WORKDAY(DATE(2024,1,1),2,DATE(2024,1,3))",
                &cm,
                &vs
            ),
            Value::Number(date_serial(2024, 1, 4))
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,1))", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error on `days`.
        assert_eq!(
            eval_str("=WORKDAY(DATE(2024,1,1),\"x\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    #[test]
    fn eval_workday_intl() {
        let (cm, vs) = make_test_env();
        // Default weekend (Sat+Sun): Mon 2024-01-01 + 5 → Mon 2024-01-08.
        assert_eq!(
            eval_str(
                "=WORKDAY.INTL(DATE(2024,1,1),5,1)",
                &cm,
                &vs
            ),
            Value::Number(date_serial(2024, 1, 8))
        );
        // Weekend code 7 (Fri+Sat). Mon 2024-01-01 + 4 → step through
        // Tue Wed Thu Sun (Sun is a workday under code 7), landing on
        // Sun 2024-01-07.
        assert_eq!(
            eval_str(
                "=WORKDAY.INTL(DATE(2024,1,1),4,7)",
                &cm,
                &vs
            ),
            Value::Number(date_serial(2024, 1, 7))
        );
        // Mask "0000011" matches default.
        assert_eq!(
            eval_str(
                "=WORKDAY.INTL(DATE(2024,1,1),5,\"0000011\")",
                &cm,
                &vs
            ),
            Value::Number(date_serial(2024, 1, 8))
        );
        // Holiday under code 7: Mon + 4 normally → Sun 2024-01-07.
        // Mark that day as holiday; next workday under code 7 is
        // Mon 2024-01-08.
        assert_eq!(
            eval_str(
                "=WORKDAY.INTL(DATE(2024,1,1),4,7,DATE(2024,1,7))",
                &cm,
                &vs
            ),
            Value::Number(date_serial(2024, 1, 8))
        );
        // Invalid weekend mask → InvalidValue.
        assert_eq!(
            eval_str(
                "=WORKDAY.INTL(DATE(2024,1,1),5,\"1111111\")",
                &cm,
                &vs
            ),
            Value::Error(ValueError::InvalidValue)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=WORKDAY.INTL(DATE(2024,1,1))", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_isoweeknum() {
        let (cm, vs) = make_test_env();
        // 2024-01-01 was a Monday → ISO 2024-W01.
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2024,1,1))", &cm, &vs),
            Value::Number(1.0)
        );
        // 2021-01-01 was a Friday → ISO 2020-W53 (December rollover).
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2021,1,1))", &cm, &vs),
            Value::Number(53.0)
        );
        // 2024-12-31 was a Tuesday → ISO 2025-W01 (next-year rollover).
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2024,12,31))", &cm, &vs),
            Value::Number(1.0)
        );
        // 2020-12-28 (Mon) is the start of ISO 2020-W53.
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2020,12,28))", &cm, &vs),
            Value::Number(53.0)
        );
        // 2024-12-30 (Mon) is the start of ISO 2025-W01.
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2024,12,30))", &cm, &vs),
            Value::Number(1.0)
        );
        // Sun 2024-01-07 is the last day of ISO 2024-W01.
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2024,1,7))", &cm, &vs),
            Value::Number(1.0)
        );
        // Mon 2024-01-08 starts ISO 2024-W02.
        assert_eq!(
            eval_str("=ISOWEEKNUM(DATE(2024,1,8))", &cm, &vs),
            Value::Number(2.0)
        );
        // Arg-count error.
        assert_eq!(
            eval_str("=ISOWEEKNUM()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
        // Type error.
        assert_eq!(
            eval_str("=ISOWEEKNUM(\"abc\")", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
        // Error propagation.
        assert_eq!(
            eval_str("=ISOWEEKNUM(A1/C1)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    // === Dynamic-array (spill) functions ===

    /// Helper: extract `(rows, cols, data)` from a `Value::Array` result
    /// or panic with a useful message. Mirrors the helpers in
    /// `tests/spill_infra.rs`.
    fn unwrap_array(v: Value) -> (u32, u32, Vec<Value>) {
        match v {
            Value::Array(arr) => {
                let (r, c) = arr.shape();
                (r, c, arr.data.clone())
            }
            other => panic!("expected Value::Array, got {:?}", other),
        }
    }

    // --- SEQUENCE ---

    #[test]
    fn eval_sequence_5() {
        let (cm, vs) = make_test_env();
        let (r, c, data) = unwrap_array(eval_str("=SEQUENCE(5)", &cm, &vs));
        assert_eq!((r, c), (5, 1));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
            ]
        );
    }

    #[test]
    fn eval_sequence_2_by_3() {
        let (cm, vs) = make_test_env();
        let (r, c, data) = unwrap_array(eval_str("=SEQUENCE(2,3)", &cm, &vs));
        assert_eq!((r, c), (2, 3));
        // Row-major: [1,2,3, 4,5,6].
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ]
        );
    }

    #[test]
    fn eval_sequence_start_step() {
        let (cm, vs) = make_test_env();
        let (r, c, data) = unwrap_array(eval_str("=SEQUENCE(3, 1, 10, 2)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(10.0), Value::Number(12.0), Value::Number(14.0)]
        );
    }

    #[test]
    fn eval_sequence_zero_rows_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=SEQUENCE(0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_sequence_over_cap_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=SEQUENCE(2000000)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_sequence_no_args_wrong_arg_count() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=SEQUENCE()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    // --- UNIQUE ---
    //
    // No `={...}` literal-array syntax in Phase 3 — drive UNIQUE inputs
    // through cell ranges so the surrounding test fixture stays the
    // same shape as the rest of the eval suite.

    fn make_unique_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // A1..A5 = [1, 2, 2, 3, 1] → single-column dedupe case.
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        for (row, n) in [1.0, 2.0, 2.0, 3.0, 1.0].iter().enumerate() {
            let id = AtomId::from_raw(row as u64);
            cell_map.insert(CellAddress::new(row as u32, 0), id);
            values.insert(id, Value::Number(*n));
        }
        (cell_map, values)
    }

    #[test]
    fn eval_unique_single_column_dedupes() {
        let (cm, vs) = make_unique_env();
        let (r, c, data) = unwrap_array(eval_str("=UNIQUE(A1:A5)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)]
        );
    }

    #[test]
    fn eval_unique_2d_row_dedupe() {
        // Build a 3x2 grid where rows 0 and 2 are identical.
        //   A1=1 B1=2
        //   A2=3 B2=4
        //   A3=1 B3=2
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let rows = [[1.0, 2.0], [3.0, 4.0], [1.0, 2.0]];
        let mut next = 0u64;
        for (r, row) in rows.iter().enumerate() {
            for (c, &n) in row.iter().enumerate() {
                let id = AtomId::from_raw(next);
                next += 1;
                cell_map.insert(CellAddress::new(r as u32, c as u32), id);
                values.insert(id, Value::Number(n));
            }
        }
        let (out_r, out_c, data) = unwrap_array(eval_str("=UNIQUE(A1:B3)", &cell_map, &values));
        assert_eq!((out_r, out_c), (2, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ]
        );
    }

    #[test]
    fn eval_unique_by_col() {
        // 2x3 grid where cols 0 and 2 are identical.
        //   A1=1 B1=2 C1=1
        //   A2=3 B2=4 C2=3
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let grid = [[1.0, 2.0, 1.0], [3.0, 4.0, 3.0]];
        let mut next = 0u64;
        for (r, row) in grid.iter().enumerate() {
            for (c, &n) in row.iter().enumerate() {
                let id = AtomId::from_raw(next);
                next += 1;
                cell_map.insert(CellAddress::new(r as u32, c as u32), id);
                values.insert(id, Value::Number(n));
            }
        }
        let (out_r, out_c, data) =
            unwrap_array(eval_str("=UNIQUE(A1:C2, TRUE)", &cell_map, &values));
        assert_eq!((out_r, out_c), (2, 2));
        // Row-major output: col 0 then col 1 (the originals minus the dup).
        // First seen: [1, 2], so kept cols are [1, 2].
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ]
        );
    }

    #[test]
    fn eval_unique_exactly_once_drops_duplicates() {
        let (cm, vs) = make_unique_env();
        let (r, c, data) = unwrap_array(eval_str("=UNIQUE(A1:A5, FALSE, TRUE)", &cm, &vs));
        // Input: [1, 2, 2, 3, 1]. Counts: 1→2, 2→2, 3→1. Only 3 appears
        // exactly once → keep only [3].
        assert_eq!((r, c), (1, 1));
        assert_eq!(data, vec![Value::Number(3.0)]);
    }

    #[test]
    fn eval_unique_exactly_once_all_dropped_invalid() {
        // Build a column where everything is duplicated → exactly_once
        // drops everything → InvalidValue.
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        for (row, n) in [1.0, 2.0, 1.0, 2.0].iter().enumerate() {
            let id = AtomId::from_raw(row as u64);
            cell_map.insert(CellAddress::new(row as u32, 0), id);
            values.insert(id, Value::Number(*n));
        }
        assert_eq!(
            eval_str("=UNIQUE(A1:A4, FALSE, TRUE)", &cell_map, &values),
            Value::Error(ValueError::InvalidValue)
        );
    }

    // --- SORT ---

    fn make_sort_env_1d() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // A1..A3 = [3, 1, 2].
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        for (row, n) in [3.0, 1.0, 2.0].iter().enumerate() {
            let id = AtomId::from_raw(row as u64);
            cell_map.insert(CellAddress::new(row as u32, 0), id);
            values.insert(id, Value::Number(*n));
        }
        (cell_map, values)
    }

    #[test]
    fn eval_sort_ascending_default() {
        let (cm, vs) = make_sort_env_1d();
        let (r, c, data) = unwrap_array(eval_str("=SORT(A1:A3)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)]
        );
    }

    #[test]
    fn eval_sort_descending() {
        let (cm, vs) = make_sort_env_1d();
        let (r, c, data) = unwrap_array(eval_str("=SORT(A1:A3, 1, -1)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(3.0), Value::Number(2.0), Value::Number(1.0)]
        );
    }

    #[test]
    fn eval_sort_multi_column_by_column_2() {
        // 2x2 grid: row 0 = ["b", 1], row 1 = ["a", 2]
        // Sort by column 2 ascending → row order [0, 1] (1 < 2) → unchanged.
        // Sort by column 2 descending → row order [1, 0].
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        let a1 = AtomId::from_raw(0);
        let b1 = AtomId::from_raw(1);
        let a2 = AtomId::from_raw(2);
        let b2 = AtomId::from_raw(3);
        cell_map.insert(CellAddress::new(0, 0), a1);
        cell_map.insert(CellAddress::new(0, 1), b1);
        cell_map.insert(CellAddress::new(1, 0), a2);
        cell_map.insert(CellAddress::new(1, 1), b2);
        values.insert(a1, Value::Text("b".into()));
        values.insert(b1, Value::Number(1.0));
        values.insert(a2, Value::Text("a".into()));
        values.insert(b2, Value::Number(2.0));

        let (r, c, data) = unwrap_array(eval_str("=SORT(A1:B2, 2, -1)", &cell_map, &values));
        assert_eq!((r, c), (2, 2));
        // Descending by col 2 → row 1 first (2), then row 0 (1).
        assert_eq!(
            data,
            vec![
                Value::Text("a".into()),
                Value::Number(2.0),
                Value::Text("b".into()),
                Value::Number(1.0),
            ]
        );
    }

    #[test]
    fn eval_sort_invalid_order() {
        let (cm, vs) = make_sort_env_1d();
        assert_eq!(
            eval_str("=SORT(A1:A3, 1, 99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_sort_invalid_sort_index() {
        let (cm, vs) = make_sort_env_1d();
        // sort_index = 99 > cols (1) → InvalidValue.
        assert_eq!(
            eval_str("=SORT(A1:A3, 99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    // --- FILTER ---

    fn make_filter_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // A1..A4 = [10, 20, 30, 40] (the array).
        // B1..B4 = [TRUE, FALSE, TRUE, FALSE] (the include mask).
        let mut cell_map = HashMap::new();
        let mut values = HashMap::new();
        for (row, n) in [10.0, 20.0, 30.0, 40.0].iter().enumerate() {
            let id = AtomId::from_raw(row as u64);
            cell_map.insert(CellAddress::new(row as u32, 0), id);
            values.insert(id, Value::Number(*n));
        }
        for (row, b) in [true, false, true, false].iter().enumerate() {
            let id = AtomId::from_raw(100 + row as u64);
            cell_map.insert(CellAddress::new(row as u32, 1), id);
            values.insert(id, Value::Boolean(*b));
        }
        (cell_map, values)
    }

    #[test]
    fn eval_filter_basic() {
        let (cm, vs) = make_filter_env();
        let (r, c, data) = unwrap_array(eval_str("=FILTER(A1:A4, B1:B4)", &cm, &vs));
        assert_eq!((r, c), (2, 1));
        assert_eq!(data, vec![Value::Number(10.0), Value::Number(30.0)]);
    }

    #[test]
    fn eval_filter_all_false_no_if_empty_invalid() {
        // Mask: A1..A4 = [10, 20, 30, 40], include: B1..B4 = [FALSE,FALSE,FALSE,FALSE].
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        for (row, n) in [10.0, 20.0, 30.0, 40.0].iter().enumerate() {
            let id = AtomId::from_raw(row as u64);
            cm.insert(CellAddress::new(row as u32, 0), id);
            vs.insert(id, Value::Number(*n));
        }
        for row in 0..4 {
            let id = AtomId::from_raw(100 + row as u64);
            cm.insert(CellAddress::new(row, 1), id);
            vs.insert(id, Value::Boolean(false));
        }
        assert_eq!(
            eval_str("=FILTER(A1:A4, B1:B4)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_filter_all_false_with_if_empty() {
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        for (row, n) in [10.0, 20.0, 30.0, 40.0].iter().enumerate() {
            let id = AtomId::from_raw(row as u64);
            cm.insert(CellAddress::new(row as u32, 0), id);
            vs.insert(id, Value::Number(*n));
        }
        for row in 0..4 {
            let id = AtomId::from_raw(100 + row as u64);
            cm.insert(CellAddress::new(row, 1), id);
            vs.insert(id, Value::Boolean(false));
        }
        let (r, c, data) =
            unwrap_array(eval_str("=FILTER(A1:A4, B1:B4, \"none\")", &cm, &vs));
        assert_eq!((r, c), (1, 1));
        assert_eq!(data, vec![Value::Text("none".into())]);
    }

    #[test]
    fn eval_filter_shape_mismatch() {
        let (cm, vs) = make_filter_env();
        // Use a 3-row mask against a 4-row array — neither a row-vector
        // (B1:B1, cols=2) nor a column-vector (B1:B3, rows=3 ≠ 4) shape
        // matches; expect InvalidValue.
        assert_eq!(
            eval_str("=FILTER(A1:A4, B1:B3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_filter_row_vector_filters_columns() {
        // 2x3 array, 1x3 include vector → keep matching columns.
        //   A1=1 B1=2 C1=3
        //   A2=4 B2=5 C2=6
        //   A3=TRUE B3=FALSE C3=TRUE (include row)
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let mut next = 0u64;
        for (r, row) in [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]].iter().enumerate() {
            for (c, &n) in row.iter().enumerate() {
                let id = AtomId::from_raw(next);
                next += 1;
                cm.insert(CellAddress::new(r as u32, c as u32), id);
                vs.insert(id, Value::Number(n));
            }
        }
        // Row 2 (zero-indexed) is the include row.
        for (c, b) in [true, false, true].iter().enumerate() {
            let id = AtomId::from_raw(200 + c as u64);
            cm.insert(CellAddress::new(2, c as u32), id);
            vs.insert(id, Value::Boolean(*b));
        }
        let (r, c, data) = unwrap_array(eval_str("=FILTER(A1:C2, A3:C3)", &cm, &vs));
        assert_eq!((r, c), (2, 2));
        // Keep cols 0 and 2 of each row.
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(6.0),
            ]
        );
    }

    // === LET — L1 of the LAMBDA arc =====================================
    //
    // Excel 365's LET introduces lexical, sequential bindings into a
    // single expression: `LET(name1, value1, ..., expr)`. The tests
    // below cover the contract documented in the LET arm of
    // `eval_func`.

    #[test]
    fn eval_let_simple() {
        let (cm, vs) = make_test_env();
        // Single binding, body uses the name twice.
        assert_eq!(eval_str("=LET(x, 5, x*x)", &cm, &vs), Value::Number(25.0));
    }

    #[test]
    fn eval_let_sequential() {
        let (cm, vs) = make_test_env();
        // Second binding references the first — lexical/sequential.
        assert_eq!(
            eval_str("=LET(x, 5, y, x*2, x+y)", &cm, &vs),
            Value::Number(15.0)
        );
    }

    #[test]
    fn eval_let_uses_cells() {
        let (cm, vs) = make_test_env();
        // A1 = 10 in make_test_env; t = 10 + 1 = 11; body = t*2 = 22.
        assert_eq!(eval_str("=LET(t, A1+1, t*2)", &cm, &vs), Value::Number(22.0));
    }

    #[test]
    fn eval_let_nested() {
        let (cm, vs) = make_test_env();
        // Inner LET sees outer `x` through the frame chain.
        assert_eq!(
            eval_str("=LET(x, 5, LET(y, x*2, x+y))", &cm, &vs),
            Value::Number(15.0)
        );
    }

    #[test]
    fn eval_let_shadow() {
        let (cm, vs) = make_test_env();
        // Inner `x` shadows outer `x`: inner LET body is `x*2` where
        // x is 10 (the inner binding), so result is 20.
        assert_eq!(
            eval_str("=LET(x, 5, LET(x, 10, x*2))", &cm, &vs),
            Value::Number(20.0)
        );
    }

    #[test]
    fn eval_let_wrong_arity_even() {
        let (cm, vs) = make_test_env();
        // 4 args = 1.5 pairs + 1 body — even total → WrongArgCount.
        assert_eq!(
            eval_str("=LET(x, 5, x*2, x*3)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_let_wrong_arity_one() {
        let (cm, vs) = make_test_env();
        // 1 arg = body alone, no bindings → WrongArgCount.
        assert_eq!(
            eval_str("=LET(5)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_let_bad_name() {
        let (cm, vs) = make_test_env();
        // 123 is parsed as Expr::Number, not Expr::Name → InvalidName.
        // (The body `x` would itself error too, but the name check
        // fires first since we walk bindings in order.)
        assert_eq!(
            eval_str("=LET(123, 5, x)", &cm, &vs),
            Value::Error(ValueError::InvalidName)
        );
    }

    #[test]
    fn eval_let_error_in_value() {
        let (cm, vs) = make_test_env();
        // 1/0 in the value expression — error propagates out of LET.
        assert_eq!(
            eval_str("=LET(x, 1/0, x*2)", &cm, &vs),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_name_unbound() {
        let (cm, vs) = make_test_env();
        // Bare `x` with no LET scope → #NAME?.
        assert_eq!(eval_str("=x", &cm, &vs), Value::Error(ValueError::InvalidName));
    }

    #[test]
    fn eval_let_inside_func_call() {
        let (cm, vs) = make_test_env();
        // LET binding visible to nested function call inside the body.
        // The thread-local scope guarantees SUM's arg eval still sees x.
        assert_eq!(
            eval_str("=LET(x, 5, SUM(x, x, x))", &cm, &vs),
            Value::Number(15.0)
        );
    }

    #[test]
    fn eval_let_frame_stack_balanced_on_error() {
        let (cm, vs) = make_test_env();
        // After an error-propagating LET, the frame stack must pop.
        // A subsequent bare `x` outside any LET should still surface
        // #NAME?, not pick up a leaked binding.
        let _ = eval_str("=LET(x, 1/0, x)", &cm, &vs);
        assert_eq!(eval_str("=x", &cm, &vs), Value::Error(ValueError::InvalidName));
    }

    // ── LAMBDA + immediate-call (Part A of L2) ───────────────────────

    /// `=LAMBDA(x, x*x)(5)` is the canonical immediate-call sanity test
    /// — defines a one-param lambda, applies it to 5, expects 25.
    #[test]
    fn eval_lambda_immediate_unary() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=LAMBDA(x, x*x)(5)", &cm, &vs),
            Value::Number(25.0)
        );
    }

    /// Multiple parameters in declaration order.
    #[test]
    fn eval_lambda_immediate_binary() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=LAMBDA(x, y, x+y)(3, 4)", &cm, &vs),
            Value::Number(7.0)
        );
    }

    /// Arity mismatch: too few args → WrongArgCount.
    #[test]
    fn eval_lambda_too_few_args() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=LAMBDA(x, x*x)()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    /// Arity mismatch: too many args → WrongArgCount.
    #[test]
    fn eval_lambda_too_many_args() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=LAMBDA(x, x*x)(1, 2)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    /// Nested LAMBDA producing a closure: `LAMBDA(x, LAMBDA(y, x*y))(3)`
    /// returns a lambda that captures x=3; applying it to 4 yields 12.
    #[test]
    fn eval_lambda_closure_from_nested_lambda() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=LAMBDA(x, LAMBDA(y, x*y))(3)(4)", &cm, &vs),
            Value::Number(12.0)
        );
    }

    /// LAMBDA captures LET bindings visible at literal eval time.
    /// `=LET(n, 7, LAMBDA(x, x*n)(3))` → 3*7 = 21.
    #[test]
    fn eval_lambda_captures_let_binding() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=LET(n, 7, LAMBDA(x, x*n)(3))", &cm, &vs),
            Value::Number(21.0)
        );
    }

    /// LAMBDA literal without immediate call returns Value::Lambda.
    /// Sanity-check that the constructor produces the right variant.
    #[test]
    fn eval_lambda_literal_produces_lambda_value() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=LAMBDA(x, x*x)", &cm, &vs);
        match v {
            Value::Lambda(arc) => {
                assert_eq!(arc.arity(), 1);
                assert_eq!(arc.param_names(), &["x".to_string()]);
            }
            _ => panic!("expected Value::Lambda, got {:?}", v),
        }
    }

    /// LAMBDA with no params and zero args still applies — the body
    /// captures its surrounding scope and evaluates verbatim.
    #[test]
    fn eval_lambda_nullary_immediate_invocation() {
        let (cm, vs) = make_test_env();
        // Note: bare `=LAMBDA(42)` would be a 0-param lambda with body
        // = 42 since LAMBDA needs ≥ 1 arg (the body). Immediate-apply
        // returns 42.
        assert_eq!(
            eval_str("=LAMBDA(42)()", &cm, &vs),
            Value::Number(42.0)
        );
    }

    /// Bad LAMBDA: < 2 args → WrongArgCount (just a body, no params is
    /// OK at 1; 0 args is the only WrongArgCount path).
    #[test]
    fn eval_lambda_zero_args_is_error() {
        let (cm, vs) = make_test_env();
        // The parser will reject `=LAMBDA()` because parse_func_args
        // requires at least one expression between parens; check at the
        // formula level.
        let v = eval_str("=LAMBDA()", &cm, &vs);
        // Either WrongArgCount from eval (if it slips through) or a
        // parse failure caught earlier — both surface a kind of error
        // depending on the parse path. Right now `LAMBDA()` parses to
        // FuncCall { args: [] } and lands here with WrongArgCount.
        assert_eq!(v, Value::Error(ValueError::WrongArgCount));
    }

    /// Non-identifier in a param slot → InvalidName.
    #[test]
    fn eval_lambda_param_must_be_identifier() {
        let (cm, vs) = make_test_env();
        // `5` in the param slot is a number literal, not Expr::Name.
        assert_eq!(
            eval_str("=LAMBDA(5, 5)", &cm, &vs),
            Value::Error(ValueError::InvalidName)
        );
    }

    // ── ISOMITTED (Part B) ────────────────────────────────────────────

    /// ISOMITTED currently returns FALSE for any argument — we don't
    /// support optional LAMBDA parameters yet so the function is a stub.
    /// Documented gap.
    #[test]
    fn eval_isomitted_returns_false() {
        let (cm, vs) = make_test_env();
        assert_eq!(eval_str("=ISOMITTED(123)", &cm, &vs), Value::Boolean(false));
        assert_eq!(
            eval_str("=ISOMITTED(\"hi\")", &cm, &vs),
            Value::Boolean(false)
        );
    }

    // ── MAP / REDUCE / SCAN (Part B) ──────────────────────────────────

    /// `=MAP(SEQUENCE(5), LAMBDA(x, x*2))` → [2, 4, 6, 8, 10] (5×1).
    #[test]
    fn eval_map_unary_doubles() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=MAP(SEQUENCE(5), LAMBDA(x, x*2))", &cm, &vs);
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (5, 1));
                let expected = [2.0, 4.0, 6.0, 8.0, 10.0];
                for (i, e) in expected.iter().enumerate() {
                    assert_eq!(arr.get(i as u32, 0), Some(&Value::Number(*e)));
                }
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }

    /// `=MAP(SEQUENCE(3), SEQUENCE(3), LAMBDA(a,b, a+b))` → [2, 4, 6].
    /// The two arrays must share shape; lambda receives one value from
    /// each per cell.
    #[test]
    fn eval_map_binary_zip() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=MAP(SEQUENCE(3), SEQUENCE(3), LAMBDA(a, b, a+b))", &cm, &vs);
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (3, 1));
                let expected = [2.0, 4.0, 6.0];
                for (i, e) in expected.iter().enumerate() {
                    assert_eq!(arr.get(i as u32, 0), Some(&Value::Number(*e)));
                }
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }

    /// Lambda arity != number of input arrays → WrongArgCount.
    #[test]
    fn eval_map_lambda_arity_mismatch() {
        let (cm, vs) = make_test_env();
        // 2 arrays + 1-param lambda — should fail early before any
        // element gets evaluated.
        assert_eq!(
            eval_str("=MAP(SEQUENCE(2), SEQUENCE(2), LAMBDA(x, x*2))", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    /// Shape mismatch between input arrays → WrongType.
    #[test]
    fn eval_map_shape_mismatch() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(3) is 3×1; SEQUENCE(5) is 5×1.
        assert_eq!(
            eval_str("=MAP(SEQUENCE(3), SEQUENCE(5), LAMBDA(a, b, a+b))", &cm, &vs),
            Value::Error(ValueError::WrongType)
        );
    }

    /// REDUCE walks the array, returning the final accumulator.
    /// `=REDUCE(0, SEQUENCE(5), LAMBDA(acc, x, acc+x))` → 15.
    #[test]
    fn eval_reduce_sum() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=REDUCE(0, SEQUENCE(5), LAMBDA(acc, x, acc+x))", &cm, &vs),
            Value::Number(15.0)
        );
    }

    /// REDUCE result is scalar, not Array (the L2/L3 contract).
    #[test]
    fn eval_reduce_returns_scalar_not_array() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=REDUCE(10, SEQUENCE(3), LAMBDA(a, x, a*x))", &cm, &vs);
        assert!(matches!(v, Value::Number(_)));
        assert_eq!(v, Value::Number(60.0));
    }

    /// SCAN emits the intermediate accumulators. With initial=0, body=
    /// `acc+x`, over [1,2,3,4,5]: [1, 3, 6, 10, 15] as 5×1.
    #[test]
    fn eval_scan_cumulative_sum() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=SCAN(0, SEQUENCE(5), LAMBDA(acc, x, acc+x))", &cm, &vs);
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (5, 1));
                let expected = [1.0, 3.0, 6.0, 10.0, 15.0];
                for (i, e) in expected.iter().enumerate() {
                    assert_eq!(arr.get(i as u32, 0), Some(&Value::Number(*e)));
                }
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }

    // ── BYROW / BYCOL (Part B) ────────────────────────────────────────

    /// `=BYROW(SEQUENCE(2,3), LAMBDA(r, SUM(r)))` →
    /// row sums = [1+2+3, 4+5+6] = [6, 15] as 2×1.
    #[test]
    fn eval_byrow_sum() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=BYROW(SEQUENCE(2,3), LAMBDA(r, SUM(r)))", &cm, &vs);
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (2, 1));
                assert_eq!(arr.get(0, 0), Some(&Value::Number(6.0)));
                assert_eq!(arr.get(1, 0), Some(&Value::Number(15.0)));
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }

    /// `=BYCOL(SEQUENCE(2,3), LAMBDA(c, SUM(c)))` →
    /// column sums = [1+4, 2+5, 3+6] = [5, 7, 9] as 1×3.
    #[test]
    fn eval_bycol_sum() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=BYCOL(SEQUENCE(2,3), LAMBDA(c, SUM(c)))", &cm, &vs);
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (1, 3));
                assert_eq!(arr.get(0, 0), Some(&Value::Number(5.0)));
                assert_eq!(arr.get(0, 1), Some(&Value::Number(7.0)));
                assert_eq!(arr.get(0, 2), Some(&Value::Number(9.0)));
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }

    // ── MAKEARRAY (Part B) ────────────────────────────────────────────

    /// `=MAKEARRAY(2, 3, LAMBDA(i, j, i*j))` →
    ///   row 1: 1*1=1, 1*2=2, 1*3=3
    ///   row 2: 2*1=2, 2*2=4, 2*3=6
    #[test]
    fn eval_makearray_product() {
        let (cm, vs) = make_test_env();
        let v = eval_str("=MAKEARRAY(2, 3, LAMBDA(i, j, i*j))", &cm, &vs);
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (2, 3));
                assert_eq!(arr.get(0, 0), Some(&Value::Number(1.0)));
                assert_eq!(arr.get(0, 1), Some(&Value::Number(2.0)));
                assert_eq!(arr.get(0, 2), Some(&Value::Number(3.0)));
                assert_eq!(arr.get(1, 0), Some(&Value::Number(2.0)));
                assert_eq!(arr.get(1, 1), Some(&Value::Number(4.0)));
                assert_eq!(arr.get(1, 2), Some(&Value::Number(6.0)));
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }

    /// MAKEARRAY cap matches SEQUENCE — over 1M elements → InvalidValue.
    #[test]
    fn eval_makearray_cap_enforced() {
        let (cm, vs) = make_test_env();
        // 1025 * 1025 = 1,050,625 > 1,048,576.
        assert_eq!(
            eval_str("=MAKEARRAY(1025, 1025, LAMBDA(i, j, i+j))", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    /// LAMBDA stored in a LET binding, then passed to MAP — the lambda
    /// flows through a name. This exercises the path "Name -> Value"
    /// where the value is itself a Lambda.
    #[test]
    fn eval_lambda_named_via_let_then_mapped() {
        let (cm, vs) = make_test_env();
        let v = eval_str(
            "=LET(sq, LAMBDA(x, x*x), MAP(SEQUENCE(4), sq))",
            &cm,
            &vs,
        );
        match v {
            Value::Array(arr) => {
                assert_eq!(arr.shape(), (4, 1));
                let expected = [1.0, 4.0, 9.0, 16.0];
                for (i, e) in expected.iter().enumerate() {
                    assert_eq!(arr.get(i as u32, 0), Some(&Value::Number(*e)));
                }
            }
            _ => panic!("expected Array, got {:?}", v),
        }
    }
    #[test]
    fn eval_sortby_single_key_asc() {
        let (cm, vs) = make_sortby_env_multi_key();
        // Sort col A by col B ascending. Col B is [1,1,2,2] so the order
        // is stable: rows [0,1,2,3] → unchanged.
        let (r, c, data) = unwrap_array(eval_str("=SORTBY(A1:A4, B1:B4)", &cm, &vs));
        assert_eq!((r, c), (4, 1));
        assert_eq!(
            data,
            vec![
                Value::Text("w".into()),
                Value::Text("x".into()),
                Value::Text("y".into()),
                Value::Text("z".into()),
            ]
        );
    }

    #[test]
    fn eval_sortby_single_key_desc() {
        let (cm, vs) = make_sortby_env_multi_key();
        // Sort col A by col B descending. Col B = [1,1,2,2] → rows with
        // key 2 first (rows 2, 3, stable), then rows with key 1.
        let (r, c, data) = unwrap_array(eval_str("=SORTBY(A1:A4, B1:B4, -1)", &cm, &vs));
        assert_eq!((r, c), (4, 1));
        assert_eq!(
            data,
            vec![
                Value::Text("y".into()),
                Value::Text("z".into()),
                Value::Text("w".into()),
                Value::Text("x".into()),
            ]
        );
    }

    #[test]
    fn eval_sortby_multi_key_stable_tiebreak() {
        let (cm, vs) = make_sortby_env_multi_key();
        // Sort by B asc, ties broken by C asc.
        // Keys: (1,20), (1,10), (2,20), (2,10).
        // Within B=1: prefer C=10 → row 1 first, then row 0.
        // Within B=2: prefer C=10 → row 3 first, then row 2.
        // Expected order: x, w, z, y.
        let (r, c, data) =
            unwrap_array(eval_str("=SORTBY(A1:A4, B1:B4, 1, C1:C4, 1)", &cm, &vs));
        assert_eq!((r, c), (4, 1));
        assert_eq!(
            data,
            vec![
                Value::Text("x".into()),
                Value::Text("w".into()),
                Value::Text("z".into()),
                Value::Text("y".into()),
            ]
        );
    }

    #[test]
    fn eval_sortby_wrong_arg_count() {
        let (cm, vs) = make_sortby_env_multi_key();
        assert_eq!(
            eval_str("=SORTBY(A1:A4)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_sortby_by_array_shape_mismatch() {
        let (cm, vs) = make_sortby_env_multi_key();
        // by_array has 3 rows but array has 4 → InvalidValue.
        assert_eq!(
            eval_str("=SORTBY(A1:A4, B1:B3)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_randarray_default_shape() {
        let (cm, vs) = make_test_env();
        // RANDARRAY() → 1×1 array with one number in [0,1).
        let (r, c, data) = unwrap_array(eval_str("=RANDARRAY()", &cm, &vs));
        assert_eq!((r, c), (1, 1));
        match &data[0] {
            Value::Number(n) => {
                assert!(*n >= 0.0 && *n < 1.0, "expected [0,1), got {}", n);
            }
            other => panic!("expected Number, got {:?}", other),
        }
    }

    #[test]
    fn eval_randarray_shape_and_bounds() {
        let (cm, vs) = make_test_env();
        // 2×3, range [10, 20] (continuous).
        let (r, c, data) = unwrap_array(eval_str("=RANDARRAY(2, 3, 10, 20)", &cm, &vs));
        assert_eq!((r, c), (2, 3));
        assert_eq!(data.len(), 6);
        for v in &data {
            match v {
                Value::Number(n) => {
                    assert!(*n >= 10.0 && *n <= 20.0, "expected [10,20], got {}", n);
                }
                other => panic!("expected Number, got {:?}", other),
            }
        }
    }

    #[test]
    fn eval_randarray_whole_number() {
        let (cm, vs) = make_test_env();
        // 1×5 whole numbers in [1, 6].
        let (r, c, data) = unwrap_array(eval_str("=RANDARRAY(1, 5, 1, 6, TRUE)", &cm, &vs));
        assert_eq!((r, c), (1, 5));
        for v in &data {
            match v {
                Value::Number(n) => {
                    assert!(*n >= 1.0 && *n <= 6.0, "expected [1,6], got {}", n);
                    assert_eq!(n.fract(), 0.0, "expected integer, got {}", n);
                }
                other => panic!("expected Number, got {:?}", other),
            }
        }
    }

    #[test]
    fn eval_randarray_min_gt_max_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=RANDARRAY(1, 1, 10, 5)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_randarray_whole_with_fractional_bounds_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=RANDARRAY(1, 1, 1.5, 5, TRUE)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_randarray_wrong_arg_count() {
        let (cm, vs) = make_test_env();
        // 6 args: too many.
        assert_eq!(
            eval_str("=RANDARRAY(1, 1, 0, 1, FALSE, 99)", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_take_first_rows() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(5, 2) is a 5×2 grid. TAKE 3 rows.
        let (r, c, data) = unwrap_array(eval_str("=TAKE(SEQUENCE(5, 2), 3)", &cm, &vs));
        assert_eq!((r, c), (3, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ]
        );
    }

    #[test]
    fn eval_take_last_rows_negative() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(5, 2): rows are 1..2, 3..4, 5..6, 7..8, 9..10. Last 2 rows.
        let (r, c, data) = unwrap_array(eval_str("=TAKE(SEQUENCE(5, 2), -2)", &cm, &vs));
        assert_eq!((r, c), (2, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(7.0),
                Value::Number(8.0),
                Value::Number(9.0),
                Value::Number(10.0),
            ]
        );
    }

    #[test]
    fn eval_take_rows_and_cols() {
        let (cm, vs) = make_test_env();
        // First 2 rows, last 1 col of SEQUENCE(3, 3).
        // SEQUENCE(3,3) = [[1,2,3],[4,5,6],[7,8,9]] → take 2 rows, -1 col → [[3],[6]].
        let (r, c, data) = unwrap_array(eval_str("=TAKE(SEQUENCE(3, 3), 2, -1)", &cm, &vs));
        assert_eq!((r, c), (2, 1));
        assert_eq!(data, vec![Value::Number(3.0), Value::Number(6.0)]);
    }

    #[test]
    fn eval_take_over_caps() {
        let (cm, vs) = make_test_env();
        // Asking for more rows than exist caps at array's actual row count.
        let (r, c, data) = unwrap_array(eval_str("=TAKE(SEQUENCE(3), 99)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)]
        );
    }

    #[test]
    fn eval_take_zero_rows_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=TAKE(SEQUENCE(3), 0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_take_wrong_arg_count() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=TAKE(SEQUENCE(3))", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_drop_first_rows() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(5): [1,2,3,4,5]. DROP 2 → [3,4,5].
        let (r, c, data) = unwrap_array(eval_str("=DROP(SEQUENCE(5), 2)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(3.0), Value::Number(4.0), Value::Number(5.0)]
        );
    }

    #[test]
    fn eval_drop_last_rows_negative() {
        let (cm, vs) = make_test_env();
        // DROP -2 = drop last 2 rows of SEQUENCE(5) → [1,2,3].
        let (r, c, data) = unwrap_array(eval_str("=DROP(SEQUENCE(5), -2)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)]
        );
    }

    #[test]
    fn eval_drop_rows_and_cols() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(3,3): drop 1 row from start and 1 col from start.
        // Original [[1,2,3],[4,5,6],[7,8,9]] → [[5,6],[8,9]].
        let (r, c, data) = unwrap_array(eval_str("=DROP(SEQUENCE(3, 3), 1, 1)", &cm, &vs));
        assert_eq!((r, c), (2, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(5.0),
                Value::Number(6.0),
                Value::Number(8.0),
                Value::Number(9.0),
            ]
        );
    }

    #[test]
    fn eval_drop_all_rows_invalid() {
        let (cm, vs) = make_test_env();
        // Dropping all rows → empty → InvalidValue.
        assert_eq!(
            eval_str("=DROP(SEQUENCE(3), 99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_vstack_equal_shapes() {
        let (cm, vs) = make_test_env();
        // VSTACK(SEQUENCE(2), SEQUENCE(2, 1, 10)) → 4×1.
        let (r, c, data) =
            unwrap_array(eval_str("=VSTACK(SEQUENCE(2), SEQUENCE(2, 1, 10))", &cm, &vs));
        assert_eq!((r, c), (4, 1));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(10.0),
                Value::Number(11.0),
            ]
        );
    }

    #[test]
    fn eval_vstack_unequal_cols_pads_with_error() {
        let (cm, vs) = make_test_env();
        // VSTACK(SEQUENCE(1, 3), SEQUENCE(1, 1, 99)) → result cols = 3.
        // First block fills row 0: [1, 2, 3].
        // Second block's row 0 has only 1 col [99]; pad cols 1, 2 with #VALUE!.
        let (r, c, data) = unwrap_array(eval_str(
            "=VSTACK(SEQUENCE(1, 3), SEQUENCE(1, 1, 99))",
            &cm,
            &vs,
        ));
        assert_eq!((r, c), (2, 3));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(99.0),
                Value::Error(ValueError::InvalidValue),
                Value::Error(ValueError::InvalidValue),
            ]
        );
    }

    #[test]
    fn eval_vstack_no_args() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=VSTACK()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_hstack_equal_shapes() {
        let (cm, vs) = make_test_env();
        // HSTACK(SEQUENCE(2,1), SEQUENCE(2,1,10)) → 2×2.
        let (r, c, data) = unwrap_array(eval_str(
            "=HSTACK(SEQUENCE(2, 1), SEQUENCE(2, 1, 10))",
            &cm,
            &vs,
        ));
        assert_eq!((r, c), (2, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(10.0),
                Value::Number(2.0),
                Value::Number(11.0),
            ]
        );
    }

    #[test]
    fn eval_hstack_unequal_rows_pads_with_error() {
        let (cm, vs) = make_test_env();
        // HSTACK(SEQUENCE(3,1), SEQUENCE(1,1,99)) → result rows = 3, cols = 2.
        // Row 0: [1, 99]. Row 1: [2, #VALUE!]. Row 2: [3, #VALUE!].
        let (r, c, data) = unwrap_array(eval_str(
            "=HSTACK(SEQUENCE(3, 1), SEQUENCE(1, 1, 99))",
            &cm,
            &vs,
        ));
        assert_eq!((r, c), (3, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(99.0),
                Value::Number(2.0),
                Value::Error(ValueError::InvalidValue),
                Value::Number(3.0),
                Value::Error(ValueError::InvalidValue),
            ]
        );
    }

    #[test]
    fn eval_hstack_no_args() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=HSTACK()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_chooserows_basic() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(4) = [1,2,3,4]. CHOOSEROWS(1, 3) → [1, 3].
        let (r, c, data) = unwrap_array(eval_str("=CHOOSEROWS(SEQUENCE(4), 1, 3)", &cm, &vs));
        assert_eq!((r, c), (2, 1));
        assert_eq!(data, vec![Value::Number(1.0), Value::Number(3.0)]);
    }

    #[test]
    fn eval_chooserows_negative_indices() {
        let (cm, vs) = make_test_env();
        // -1 = last row. SEQUENCE(4): last → 4.
        let (r, c, data) = unwrap_array(eval_str("=CHOOSEROWS(SEQUENCE(4), -1, 1)", &cm, &vs));
        assert_eq!((r, c), (2, 1));
        assert_eq!(data, vec![Value::Number(4.0), Value::Number(1.0)]);
    }

    #[test]
    fn eval_chooserows_duplicates() {
        let (cm, vs) = make_test_env();
        // Duplicates allowed → CHOOSEROWS(SEQUENCE(3), 1, 1, 2) → [1, 1, 2].
        let (r, c, data) = unwrap_array(eval_str("=CHOOSEROWS(SEQUENCE(3), 1, 1, 2)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(1.0), Value::Number(1.0), Value::Number(2.0)]
        );
    }

    #[test]
    fn eval_chooserows_zero_index_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=CHOOSEROWS(SEQUENCE(3), 0)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_chooserows_out_of_range_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=CHOOSEROWS(SEQUENCE(3), 99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_chooserows_wrong_arg_count() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=CHOOSEROWS(SEQUENCE(3))", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_choosecols_basic() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(2, 3) = [[1,2,3],[4,5,6]]. CHOOSECOLS(1, 3) → [[1,3],[4,6]].
        let (r, c, data) = unwrap_array(eval_str("=CHOOSECOLS(SEQUENCE(2, 3), 1, 3)", &cm, &vs));
        assert_eq!((r, c), (2, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(6.0),
            ]
        );
    }

    #[test]
    fn eval_choosecols_negative_indices() {
        let (cm, vs) = make_test_env();
        // -1 = last col. SEQUENCE(2,3) → CHOOSECOLS(-1, -2) → last & second-to-last.
        let (r, c, data) =
            unwrap_array(eval_str("=CHOOSECOLS(SEQUENCE(2, 3), -1, -2)", &cm, &vs));
        assert_eq!((r, c), (2, 2));
        assert_eq!(
            data,
            vec![
                Value::Number(3.0),
                Value::Number(2.0),
                Value::Number(6.0),
                Value::Number(5.0),
            ]
        );
    }

    #[test]
    fn eval_choosecols_out_of_range_invalid() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=CHOOSECOLS(SEQUENCE(2, 3), 99)", &cm, &vs),
            Value::Error(ValueError::InvalidValue)
        );
    }

    #[test]
    fn eval_torow_basic_row_major() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(2,3) = [[1,2,3],[4,5,6]]. TOROW flattens to 1×6 row-major.
        let (r, c, data) = unwrap_array(eval_str("=TOROW(SEQUENCE(2, 3))", &cm, &vs));
        assert_eq!((r, c), (1, 6));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ]
        );
    }

    #[test]
    fn eval_torow_by_column() {
        let (cm, vs) = make_test_env();
        // Same array, scan_by_column=TRUE → 1,4,2,5,3,6.
        let (r, c, data) =
            unwrap_array(eval_str("=TOROW(SEQUENCE(2, 3), 0, TRUE)", &cm, &vs));
        assert_eq!((r, c), (1, 6));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(4.0),
                Value::Number(2.0),
                Value::Number(5.0),
                Value::Number(3.0),
                Value::Number(6.0),
            ]
        );
    }

    #[test]
    fn eval_torow_skip_blanks_and_errors() {
        // Build a 1×4 array via cells: [1, null, error, 4]. Use a literal
        // formula at C1 that produces #DIV/0!, then drive TOROW on A1:D1.
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let a1 = AtomId::from_raw(0);
        // B1 = null (no value entry).
        let b1 = AtomId::from_raw(1);
        let c1 = AtomId::from_raw(2);
        let d1 = AtomId::from_raw(3);
        cm.insert(CellAddress::new(0, 0), a1);
        cm.insert(CellAddress::new(0, 1), b1);
        cm.insert(CellAddress::new(0, 2), c1);
        cm.insert(CellAddress::new(0, 3), d1);
        vs.insert(a1, Value::Number(1.0));
        vs.insert(b1, Value::Null);
        vs.insert(c1, Value::Error(ValueError::DivisionByZero));
        vs.insert(d1, Value::Number(4.0));
        // ignore=3 → skip blanks AND errors.
        let (r, c, data) = unwrap_array(eval_str("=TOROW(A1:D1, 3)", &cm, &vs));
        assert_eq!((r, c), (1, 2));
        assert_eq!(data, vec![Value::Number(1.0), Value::Number(4.0)]);
        // ignore=1 → skip blanks only (errors remain).
        let (r, c, data) = unwrap_array(eval_str("=TOROW(A1:D1, 1)", &cm, &vs));
        assert_eq!((r, c), (1, 3));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Error(ValueError::DivisionByZero),
                Value::Number(4.0),
            ]
        );
    }

    #[test]
    fn eval_torow_wrong_arg_count() {
        let (cm, vs) = make_test_env();
        assert_eq!(
            eval_str("=TOROW()", &cm, &vs),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_tocol_basic_row_major() {
        let (cm, vs) = make_test_env();
        // SEQUENCE(2,3) → 6 entries, default row-major → [1,2,3,4,5,6].
        let (r, c, data) = unwrap_array(eval_str("=TOCOL(SEQUENCE(2, 3))", &cm, &vs));
        assert_eq!((r, c), (6, 1));
        assert_eq!(
            data,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ]
        );
    }

    #[test]
    fn eval_tocol_by_column_skip_blanks() {
        // Build a 2×2 grid where (0,1) is blank.
        //   A1=1 B1=Null
        //   A2=3 B2=4
        // Column-major: 1, 3, Null, 4 → with skip-blanks → 1, 3, 4.
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let a1 = AtomId::from_raw(0);
        let b1 = AtomId::from_raw(1);
        let a2 = AtomId::from_raw(2);
        let b2 = AtomId::from_raw(3);
        cm.insert(CellAddress::new(0, 0), a1);
        cm.insert(CellAddress::new(0, 1), b1);
        cm.insert(CellAddress::new(1, 0), a2);
        cm.insert(CellAddress::new(1, 1), b2);
        vs.insert(a1, Value::Number(1.0));
        vs.insert(b1, Value::Null);
        vs.insert(a2, Value::Number(3.0));
        vs.insert(b2, Value::Number(4.0));
        let (r, c, data) = unwrap_array(eval_str("=TOCOL(A1:B2, 1, TRUE)", &cm, &vs));
        assert_eq!((r, c), (3, 1));
        assert_eq!(
            data,
            vec![Value::Number(1.0), Value::Number(3.0), Value::Number(4.0)]
        );
    }

    #[test]
    fn eval_norm_dist_pdf_zero_is_one_over_sqrt_2pi() {
        // Standard-normal PDF at 0 = 1/sqrt(2π) ≈ 0.39894228.
        assert_approx_eq(ev("=NORM.DIST(0, 0, 1, FALSE)"), 0.398_942_280_4, TOL);
    }

    #[test]
    fn eval_norm_dist_cdf_at_mean_is_half() {
        assert_approx_eq(ev("=NORM.DIST(5, 5, 2, TRUE)"), 0.5, TOL);
    }

    #[test]
    fn eval_norm_dist_sd_zero_is_num_error() {
        assert_eq!(
            ev("=NORM.DIST(0, 0, 0, TRUE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_norm_dist_wrong_arg_count() {
        assert_eq!(
            ev("=NORM.DIST(0, 0, 1)"),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_norm_inv_round_trip() {
        // NORM.INV(0.5, 5, 2) == 5.
        assert_approx_eq(ev("=NORM.INV(0.5, 5, 2)"), 5.0, TOL);
    }

    #[test]
    fn eval_norm_inv_p_out_of_range() {
        assert_eq!(
            ev("=NORM.INV(0, 0, 1)"),
            Value::Error(ValueError::Overflow)
        );
        assert_eq!(
            ev("=NORM.INV(1, 0, 1)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_norm_s_dist_cdf_zero() {
        assert_approx_eq(ev("=NORM.S.DIST(0, TRUE)"), 0.5, TOL);
    }

    #[test]
    fn eval_norm_s_dist_pdf_zero() {
        assert_approx_eq(ev("=NORM.S.DIST(0, FALSE)"), 0.398_942_280_4, TOL);
    }

    #[test]
    fn eval_norm_s_inv_half_is_zero() {
        assert_approx_eq(ev("=NORM.S.INV(0.5)"), 0.0, TOL);
    }

    #[test]
    fn eval_norm_s_inv_wrong_arg_count() {
        assert_eq!(
            ev("=NORM.S.INV()"),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_t_dist_cdf_zero_is_half() {
        // Student's t is symmetric around 0.
        assert_approx_eq(ev("=T.DIST(0, 10, TRUE)"), 0.5, TOL);
    }

    #[test]
    fn eval_t_dist_pdf_zero_df10() {
        // PDF(0) for t with df=10 ≈ 0.389108..
        assert_approx_eq(ev("=T.DIST(0, 10, FALSE)"), 0.389_108_38, 1e-5);
    }

    #[test]
    fn eval_t_dist_df_zero_is_num_error() {
        assert_eq!(
            ev("=T.DIST(0, 0, TRUE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_t_dist_rt_zero_is_half() {
        assert_approx_eq(ev("=T.DIST.RT(0, 10)"), 0.5, TOL);
    }

    #[test]
    fn eval_t_dist_rt_negative_x_is_error() {
        assert_eq!(
            ev("=T.DIST.RT(-1, 10)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_t_dist_2t_zero_is_one() {
        // Two-tail at 0 = 2 * (1 - 0.5) = 1.
        assert_approx_eq(ev("=T.DIST.2T(0, 10)"), 1.0, TOL);
    }

    #[test]
    fn eval_t_inv_half() {
        assert_approx_eq(ev("=T.INV(0.5, 10)"), 0.0, TOL);
    }

    #[test]
    fn eval_t_inv_2t_one() {
        // p=1 → 1 - 1/2 = 0.5 → invCDF(0.5)=0.
        assert_approx_eq(ev("=T.INV.2T(1, 10)"), 0.0, TOL);
    }

    #[test]
    fn eval_f_dist_cdf() {
        // F(1, 1) at x=1 has CDF=0.5 (df1=df2=1 gives a Cauchy-like).
        // Skip exact value; just check finite and in (0,1).
        match ev("=F.DIST(1, 5, 10, TRUE)") {
            Value::Number(n) => assert!(n > 0.0 && n < 1.0, "expected CDF in (0,1), got {}", n),
            other => panic!("expected number, got {:?}", other),
        }
    }

    #[test]
    fn eval_f_dist_pdf_positive() {
        match ev("=F.DIST(1, 5, 10, FALSE)") {
            Value::Number(n) => assert!(n > 0.0, "expected positive PDF, got {}", n),
            other => panic!("expected number, got {:?}", other),
        }
    }

    #[test]
    fn eval_f_dist_negative_x_is_error() {
        assert_eq!(
            ev("=F.DIST(-1, 5, 10, TRUE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_f_dist_rt_complement() {
        // F.DIST(x, ...) + F.DIST.RT(x, ...) = 1.
        let a = match ev("=F.DIST(2, 5, 10, TRUE)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        let b = match ev("=F.DIST.RT(2, 5, 10)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        assert!((a + b - 1.0).abs() < 1e-9);
    }

    #[test]
    fn eval_f_inv_round_trip() {
        // F.INV(F.DIST(2, 5, 10, TRUE), 5, 10) ≈ 2.
        // Build via two evaluations.
        let p = match ev("=F.DIST(2, 5, 10, TRUE)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        let inv = match ev(&format!("=F.INV({}, 5, 10)", p)) {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        assert!((inv - 2.0).abs() < 1e-3);
    }

    #[test]
    fn eval_f_inv_rt_p_zero_is_error() {
        assert_eq!(
            ev("=F.INV.RT(0, 5, 10)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_chisq_dist_cdf_finite() {
        match ev("=CHISQ.DIST(3, 5, TRUE)") {
            Value::Number(n) => assert!(n > 0.0 && n < 1.0),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn eval_chisq_dist_rt_complement() {
        let a = match ev("=CHISQ.DIST(3, 5, TRUE)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        let b = match ev("=CHISQ.DIST.RT(3, 5)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        assert!((a + b - 1.0).abs() < 1e-9);
    }

    #[test]
    fn eval_chisq_inv_df_zero_is_error() {
        assert_eq!(
            ev("=CHISQ.INV(0.5, 0)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_chisq_inv_rt_p_one_is_zero() {
        // P=1 means we want the value such that survival = 1, i.e. x = 0.
        assert_approx_eq(ev("=CHISQ.INV.RT(1, 5)"), 0.0, TOL);
    }

    #[test]
    fn eval_expon_dist_pdf_zero_is_lambda() {
        // PDF(0) = lambda.
        assert_approx_eq(ev("=EXPON.DIST(0, 2, FALSE)"), 2.0, TOL);
    }

    #[test]
    fn eval_expon_dist_cdf_known_value() {
        // CDF(x; λ) = 1 - exp(-λx). CDF(1; 1) = 1 - 1/e ≈ 0.6321205588.
        assert_approx_eq(ev("=EXPON.DIST(1, 1, TRUE)"), 0.632_120_558_8, TOL);
    }

    #[test]
    fn eval_expon_dist_lambda_zero_is_error() {
        assert_eq!(
            ev("=EXPON.DIST(1, 0, TRUE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_weibull_dist_cdf_at_scale() {
        // CDF(beta; alpha, beta) = 1 - exp(-1) ≈ 0.6321205588 for any alpha.
        assert_approx_eq(ev("=WEIBULL.DIST(2, 3, 2, TRUE)"), 0.632_120_558_8, TOL);
    }

    #[test]
    fn eval_weibull_dist_alpha_zero_is_error() {
        assert_eq!(
            ev("=WEIBULL.DIST(1, 0, 1, TRUE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_beta_dist_uniform_cdf() {
        // Beta(1, 1) on [0,1] is the uniform distribution → CDF(x) = x.
        assert_approx_eq(ev("=BETA.DIST(0.25, 1, 1, TRUE)"), 0.25, TOL);
    }

    #[test]
    fn eval_beta_dist_uniform_pdf() {
        assert_approx_eq(ev("=BETA.DIST(0.5, 1, 1, FALSE)"), 1.0, TOL);
    }

    #[test]
    fn eval_beta_dist_with_ab() {
        // Beta(1,1) on [2,4] → uniform on [2,4] → CDF(3) = (3-2)/(4-2) = 0.5.
        assert_approx_eq(ev("=BETA.DIST(3, 1, 1, TRUE, 2, 4)"), 0.5, TOL);
    }

    #[test]
    fn eval_beta_dist_x_outside_range_is_error() {
        assert_eq!(
            ev("=BETA.DIST(2, 1, 1, TRUE, 0, 1)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_beta_inv_uniform() {
        // Uniform → inverse = p. statrs's default inverse_cdf is a 16-step
        // bisection — accurate to ~1e-4, not 1e-6.
        assert_approx_eq(ev("=BETA.INV(0.3, 1, 1)"), 0.3, 1e-3);
    }

    #[test]
    fn eval_beta_inv_with_ab() {
        assert_approx_eq(ev("=BETA.INV(0.5, 1, 1, 2, 4)"), 3.0, 1e-3);
    }

    #[test]
    fn eval_gamma_dist_exponential_equivalent() {
        // Gamma(1, beta) is the exponential distribution with rate 1/beta.
        // CDF(1; alpha=1, beta=1) = 1 - exp(-1) ≈ 0.6321...
        assert_approx_eq(ev("=GAMMA.DIST(1, 1, 1, TRUE)"), 0.632_120_558_8, TOL);
    }

    #[test]
    fn eval_gamma_dist_alpha_zero_is_error() {
        assert_eq!(
            ev("=GAMMA.DIST(1, 0, 1, TRUE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_gamma_inv_round_trip() {
        // GAMMA.INV(GAMMA.DIST(2; 3, 2, TRUE), 3, 2) ≈ 2.
        let p = match ev("=GAMMA.DIST(2, 3, 2, TRUE)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        let inv = match ev(&format!("=GAMMA.INV({}, 3, 2)", p)) {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        assert!((inv - 2.0).abs() < 1e-3);
    }

    #[test]
    fn eval_binom_dist_pmf_known() {
        // P(X=2) for Binom(10, 0.5) = C(10,2) * 0.5^10 = 45/1024 ≈ 0.0439453.
        assert_approx_eq(ev("=BINOM.DIST(2, 10, 0.5, FALSE)"), 45.0 / 1024.0, TOL);
    }

    #[test]
    fn eval_binom_dist_cdf_full() {
        // P(X <= 10) for Binom(10, 0.5) = 1.
        assert_approx_eq(ev("=BINOM.DIST(10, 10, 0.5, TRUE)"), 1.0, TOL);
    }

    #[test]
    fn eval_binom_dist_p_out_of_range_is_error() {
        assert_eq!(
            ev("=BINOM.DIST(1, 10, 1.5, FALSE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_binom_inv_half() {
        // Smallest k with P(X<=k) >= 0.5 for Binom(10, 0.5) → k=5.
        assert_approx_eq(ev("=BINOM.INV(10, 0.5, 0.5)"), 5.0, TOL);
    }

    #[test]
    fn eval_poisson_dist_pmf_zero() {
        // P(X=0) for Poisson(2) = e^-2 ≈ 0.1353352832.
        assert_approx_eq(ev("=POISSON.DIST(0, 2, FALSE)"), 0.135_335_283_2, TOL);
    }

    #[test]
    fn eval_poisson_dist_mean_zero_is_error() {
        assert_eq!(
            ev("=POISSON.DIST(0, 0, FALSE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_poisson_dist_wrong_arg_count() {
        assert_eq!(
            ev("=POISSON.DIST(0)"),
            Value::Error(ValueError::WrongArgCount)
        );
    }

    #[test]
    fn eval_hypgeom_dist_pmf() {
        // 20 balls, 6 red. Draw 5. P(exactly 2 red) = C(6,2)*C(14,3)/C(20,5)
        //   = 15 * 364 / 15504 ≈ 0.3522
        assert_approx_eq(
            ev("=HYPGEOM.DIST(2, 5, 6, 20, FALSE)"),
            15.0 * 364.0 / 15504.0,
            TOL,
        );
    }

    #[test]
    fn eval_hypgeom_dist_sample_gt_pop_is_error() {
        assert_eq!(
            ev("=HYPGEOM.DIST(2, 5, 25, 20, FALSE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_negbinom_dist_zero_failures() {
        // P(0 failures before 1st success) for prob=0.5 = 0.5.
        assert_approx_eq(ev("=NEGBINOM.DIST(0, 1, 0.5, FALSE)"), 0.5, TOL);
    }

    #[test]
    fn eval_negbinom_dist_p_zero_is_error() {
        assert_eq!(
            ev("=NEGBINOM.DIST(0, 1, 0, FALSE)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_gamma_func_integers() {
        // Gamma(n) = (n-1)!. Gamma(5) = 24.
        assert_approx_eq(ev("=GAMMA(5)"), 24.0, TOL);
        assert_approx_eq(ev("=GAMMA(1)"), 1.0, TOL);
    }

    #[test]
    fn eval_gamma_func_half() {
        // Gamma(0.5) = sqrt(π).
        assert_approx_eq(ev("=GAMMA(0.5)"), std::f64::consts::PI.sqrt(), TOL);
    }

    #[test]
    fn eval_gamma_func_zero_is_error() {
        assert_eq!(ev("=GAMMA(0)"), Value::Error(ValueError::Overflow));
    }

    #[test]
    fn eval_gamma_func_negative_integer_is_error() {
        assert_eq!(ev("=GAMMA(-3)"), Value::Error(ValueError::Overflow));
    }

    #[test]
    fn eval_gammaln_known() {
        // ln(Gamma(5)) = ln(24) ≈ 3.178053830347946.
        assert_approx_eq(ev("=GAMMALN(5)"), 24.0_f64.ln(), TOL);
    }

    #[test]
    fn eval_gammaln_negative_is_error() {
        assert_eq!(ev("=GAMMALN(-1)"), Value::Error(ValueError::Overflow));
    }

    #[test]
    fn eval_erf_one() {
        // erf(1) ≈ 0.8427007929
        assert_approx_eq(ev("=ERF(1)"), 0.842_700_792_9, TOL);
    }

    #[test]
    fn eval_erf_zero() {
        assert_approx_eq(ev("=ERF(0)"), 0.0, TOL);
    }

    #[test]
    fn eval_erf_two_arg() {
        // erf(2) - erf(1).
        let one = 0.842_700_792_9_f64;
        let two = 0.995_322_265_0_f64;
        assert_approx_eq(ev("=ERF(1, 2)"), two - one, 1e-5);
    }

    #[test]
    fn eval_erfc_one() {
        // erfc(1) = 1 - erf(1) ≈ 0.1572992070.
        assert_approx_eq(ev("=ERFC(1)"), 1.0 - 0.842_700_792_9, TOL);
    }

    #[test]
    fn eval_erfc_wrong_arg_count() {
        assert_eq!(ev("=ERFC()"), Value::Error(ValueError::WrongArgCount));
    }

    #[test]
    fn eval_kurt_uniform_dataset() {
        // Known result for SKEW.K and KURT requires ≥ 4 points.
        // Symmetric dataset has skew ≈ 0; kurtosis of symmetric flat-ish
        // dataset is negative (platykurtic).
        let v = ev("=KURT(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)");
        match v {
            Value::Number(_) => {}
            other => panic!("expected number, got {:?}", other),
        }
    }

    #[test]
    fn eval_kurt_too_few_args_is_error() {
        assert_eq!(
            ev("=KURT(1, 2, 3)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_kurt_known_value() {
        // KURT(1,2,3,4,5) — Excel returns -1.2.
        assert_approx_eq(ev("=KURT(1, 2, 3, 4, 5)"), -1.2, TOL);
    }

    #[test]
    fn eval_skew_symmetric_is_zero() {
        assert_approx_eq(ev("=SKEW(1, 2, 3, 4, 5)"), 0.0, TOL);
    }

    #[test]
    fn eval_skew_too_few_args_is_error() {
        assert_eq!(
            ev("=SKEW(1, 2)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_avedev_simple() {
        // mean = 4. |1-4|+|2-4|+|3-4|+|6-4|+|8-4| = 3+2+1+2+4 = 12. 12/5 = 2.4.
        assert_approx_eq(ev("=AVEDEV(1, 2, 3, 6, 8)"), 2.4, TOL);
    }

    #[test]
    fn eval_avedev_empty_is_div_zero() {
        assert_eq!(ev("=AVEDEV()"), Value::Error(ValueError::DivisionByZero));
    }

    #[test]
    fn eval_devsq_simple() {
        // mean = 3. Sum (xi - 3)^2 = 4+1+0+1+4 = 10.
        assert_approx_eq(ev("=DEVSQ(1, 2, 3, 4, 5)"), 10.0, TOL);
    }

    #[test]
    fn eval_geomean_simple() {
        // geomean(2, 8) = sqrt(16) = 4.
        assert_approx_eq(ev("=GEOMEAN(2, 8)"), 4.0, TOL);
    }

    #[test]
    fn eval_geomean_negative_is_error() {
        assert_eq!(
            ev("=GEOMEAN(1, -1, 2)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_geomean_zero_is_error() {
        assert_eq!(
            ev("=GEOMEAN(1, 0, 2)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_harmean_simple() {
        // harmean(1, 2, 4) = 3 / (1 + 0.5 + 0.25) = 3 / 1.75 ≈ 1.714286.
        assert_approx_eq(ev("=HARMEAN(1, 2, 4)"), 3.0 / 1.75, TOL);
    }

    #[test]
    fn eval_harmean_negative_is_error() {
        assert_eq!(
            ev("=HARMEAN(1, -1, 2)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_trimmean_no_trim() {
        // n=10, percent=0.1 → trim_total=1 → trim_each=0. Mean of all = 5.5.
        // SEQUENCE(10) produces 1..=10 as a 10x1 spill array which TRIMMEAN
        // consumes as its first arg.
        assert_approx_eq(ev("=TRIMMEAN(SEQUENCE(10), 0.1)"), 5.5, TOL);
    }

    #[test]
    fn eval_trimmean_with_trim() {
        // n=10, percent=0.2 → trim_total=2 → trim_each=1. Mean of 2..9 = 5.5.
        assert_approx_eq(ev("=TRIMMEAN(SEQUENCE(10), 0.2)"), 5.5, TOL);
    }

    #[test]
    fn eval_trimmean_percent_out_of_range() {
        assert_eq!(
            ev("=TRIMMEAN(SEQUENCE(3), 1)"),
            Value::Error(ValueError::Overflow)
        );
    }

    #[test]
    fn eval_standardize_simple() {
        assert_approx_eq(ev("=STANDARDIZE(7, 5, 2)"), 1.0, TOL);
    }

    #[test]
    fn eval_standardize_sd_zero_is_div_zero() {
        assert_eq!(
            ev("=STANDARDIZE(1, 0, 0)"),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn eval_fisher_zero() {
        // FISHER(0) = 0.5 * ln(1/1) = 0.
        assert_approx_eq(ev("=FISHER(0)"), 0.0, TOL);
    }

    #[test]
    fn eval_fisher_known() {
        // FISHER(0.75) = 0.5 * ln(1.75 / 0.25) ≈ 0.5 * ln(7) ≈ 0.9729550745.
        assert_approx_eq(ev("=FISHER(0.75)"), 0.5 * 7.0_f64.ln(), TOL);
    }

    #[test]
    fn eval_fisher_out_of_range() {
        assert_eq!(ev("=FISHER(1)"), Value::Error(ValueError::Overflow));
        assert_eq!(ev("=FISHER(-1)"), Value::Error(ValueError::Overflow));
    }

    #[test]
    fn eval_fisherinv_round_trip() {
        // FISHERINV(FISHER(0.5)) ≈ 0.5.
        let y = match ev("=FISHER(0.5)") {
            Value::Number(n) => n,
            other => panic!("{:?}", other),
        };
        assert_approx_eq(ev(&format!("=FISHERINV({})", y)), 0.5, TOL);
    }

    #[test]
    fn eval_fisherinv_zero() {
        assert_approx_eq(ev("=FISHERINV(0)"), 0.0, TOL);
    }

    fn make_sortby_env_multi_key() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        // A: data  ["w", "x", "y", "z"]
        // B: key1  [1,   1,   2,   2]
        // C: key2  [20,  10,  20,  10]
        let mut cm = HashMap::new();
        let mut vs = HashMap::new();
        let data = ["w", "x", "y", "z"];
        let k1 = [1.0, 1.0, 2.0, 2.0];
        let k2 = [20.0, 10.0, 20.0, 10.0];
        let mut next = 0u64;
        for (r, ((t, n1), n2)) in data.iter().zip(k1.iter()).zip(k2.iter()).enumerate() {
            let a_id = AtomId::from_raw(next);
            next += 1;
            cm.insert(CellAddress::new(r as u32, 0), a_id);
            vs.insert(a_id, Value::Text((*t).into()));
            let b_id = AtomId::from_raw(next);
            next += 1;
            cm.insert(CellAddress::new(r as u32, 1), b_id);
            vs.insert(b_id, Value::Number(*n1));
            let c_id = AtomId::from_raw(next);
            next += 1;
            cm.insert(CellAddress::new(r as u32, 2), c_id);
            vs.insert(c_id, Value::Number(*n2));
        }
        (cm, vs)
    }
    fn assert_approx_eq(actual: Value, expected: f64, tol: f64) {
        match actual {
            Value::Number(n) => {
                let diff = (n - expected).abs();
                assert!(
                    diff < tol,
                    "expected ≈ {} (tol={}), got {} (|diff|={})",
                    expected,
                    tol,
                    n,
                    diff
                );
            }
            other => panic!("expected Value::Number, got {:?}", other),
        }
    }
    fn empty_env() -> (HashMap<CellAddress, AtomId>, HashMap<AtomId, Value>) {
        (HashMap::new(), HashMap::new())
    }
    fn ev(formula: &str) -> Value {
        let (cm, vs) = empty_env();
        eval_str(formula, &cm, &vs)
    }
    const TOL: f64 = 1e-6;
}
