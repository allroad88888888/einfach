use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;

use einfach_core::{Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::{
    eval_expr_with_provider, is_builtin_function_name, CustomFunctionRegistry, EvalProvider,
};
use crate::formula::{parse_formula, Expr, RangeBounds};
use crate::range::CellRange;
use crate::sheet::{RangeDependentIndex, Sheet, SheetError};

/// One outgoing edge from a formula cell to a cross-sheet source.
///
/// `Cell` and `Range` mirror the sheet-local distinction between
/// point-cell deps (`cell_dependents`) and range deps (`range_dependents`).
/// A single formula can have multiple of each — `=Sheet2!A1 + SUM(Sheet3!B1:B10)`
/// would produce one `Cell` and one `Range` edge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CrossSheetRef {
    Cell(usize, CellAddress),
    /// Cross-sheet range edge, e.g. `SUM(Sheet2!A1:A100)`.
    Range(usize, CellRange),
}

/// Workbook-level cross-sheet dependency graph. Tracks the reverse edges
/// that let a `Workbook::set_cell(src_sheet, src_addr, _)` find every
/// formula on every OTHER sheet that needs dirtying — the gap that Sheet-
/// local `cell_dependents` / `range_dependents` cannot close on its own.
///
/// Maintained by `Workbook::set_formula` / `Workbook::clear_cell` and
/// queried by `Workbook::set_cell` and the BFS underneath it.
#[derive(Default)]
pub(crate) struct CrossSheetDeps {
    /// REVERSE edges, point-cell variant.
    /// `(src_sheet, src_addr) → set of (formula_sheet, formula_addr)`.
    /// `=Sheet2!A1` on `Sheet1!B1` becomes
    /// `cell_dependents[(2, A1)] = {(1, B1)}`.
    pub(crate) cell_dependents: HashMap<(usize, CellAddress), HashSet<(usize, CellAddress)>>,

    /// REVERSE edges, range variant. One `RangeDependentIndex` per source
    /// sheet so per-write dirty fanout for that sheet runs the same
    /// row+col bucket lookup as Phase 2's sheet-local index.
    ///
    /// `SUM(Sheet2!A1:A100)` on `Sheet1!D` becomes an entry inside
    /// `range_index_per_sheet[2]`, where the index value points back at
    /// `(1, D)` as the dependent formula.
    pub(crate) range_index_per_sheet: HashMap<usize, RangeDependentIndex>,

    /// FORWARD edges. `(formula_sheet, formula_addr) → its outgoing
    /// cross-sheet refs`. Needed to undo previous edges when the formula
    /// is replaced or cleared, and (Track J's future use) to drive
    /// cross-sheet cycle detection off the same map rather than a
    /// per-call AST walk.
    pub(crate) formula_refs: HashMap<(usize, CellAddress), Vec<CrossSheetRef>>,
}

impl CrossSheetDeps {
    fn new() -> Self {
        Self::default()
    }

    /// Insert one outgoing edge under `(formula_sheet, formula_addr)` and
    /// also register the corresponding reverse edge. Used by `Workbook::
    /// set_formula` after the AST walk has produced a `Vec<CrossSheetRef>`.
    fn add_edge(&mut self, formula_sheet: usize, formula_addr: CellAddress, edge: CrossSheetRef) {
        // Reverse edge.
        match &edge {
            CrossSheetRef::Cell(src_sheet, src_addr) => {
                self.cell_dependents
                    .entry((*src_sheet, *src_addr))
                    .or_default()
                    .insert((formula_sheet, formula_addr));
            }
            CrossSheetRef::Range(src_sheet, range) => {
                self.range_index_per_sheet
                    .entry(*src_sheet)
                    .or_default()
                    .add_formula(*range, formula_addr);
                // NOTE: the per-source-sheet `RangeDependentIndex` keys
                // its formula set by `CellAddress` only. The formula's
                // sheet is implicit in the formula_refs forward edge —
                // the workbook BFS pairs each addr back to its sheet by
                // looking up `formula_refs[(formula_sheet, addr)]`.
                let _ = formula_sheet;
            }
        }
        // Forward edge.
        self.formula_refs
            .entry((formula_sheet, formula_addr))
            .or_default()
            .push(edge);
    }

    /// Drop every outgoing edge previously installed under
    /// `(formula_sheet, formula_addr)` and tear down the matching reverse
    /// edges. Inverse of repeated `add_edge` calls. Idempotent — safe to
    /// call when no entry exists.
    fn remove_outgoing(&mut self, formula_sheet: usize, formula_addr: CellAddress) {
        let Some(edges) = self.formula_refs.remove(&(formula_sheet, formula_addr)) else {
            return;
        };
        for edge in edges {
            match edge {
                CrossSheetRef::Cell(src_sheet, src_addr) => {
                    let should_remove =
                        if let Some(set) = self.cell_dependents.get_mut(&(src_sheet, src_addr)) {
                            set.remove(&(formula_sheet, formula_addr));
                            set.is_empty()
                        } else {
                            false
                        };
                    if should_remove {
                        self.cell_dependents.remove(&(src_sheet, src_addr));
                    }
                }
                CrossSheetRef::Range(src_sheet, range) => {
                    if self.has_remaining_range_edge(src_sheet, range, formula_addr) {
                        continue;
                    }
                    if let Some(index) = self.range_index_per_sheet.get_mut(&src_sheet) {
                        index.remove_formula(range, formula_addr);
                        if index.is_empty() {
                            self.range_index_per_sheet.remove(&src_sheet);
                        }
                    }
                }
            }
        }
    }

    /// STORAGE_PRIMARY Phase 6.1: drop EVERY outgoing edge owned by
    /// formulas living on `formula_sheet`. Used by
    /// `Workbook::install_sheet_bulk` — a full-sheet replace
    /// invalidates all of the sheet's previous formulas, so their
    /// cross-sheet edges must go before the new content's edges are
    /// installed. Incoming edges (other sheets' formulas referencing
    /// this sheet) are untouched — they remain valid.
    fn remove_all_outgoing_for_sheet(&mut self, formula_sheet: usize) {
        let addrs: Vec<CellAddress> = self
            .formula_refs
            .keys()
            .filter(|(sheet, _)| *sheet == formula_sheet)
            .map(|(_, addr)| *addr)
            .collect();
        for addr in addrs {
            self.remove_outgoing(formula_sheet, addr);
        }
    }

    fn has_remaining_range_edge(
        &self,
        src_sheet: usize,
        range: CellRange,
        formula_addr: CellAddress,
    ) -> bool {
        self.formula_refs
            .iter()
            .filter(|((_sheet, addr), _edges)| *addr == formula_addr)
            .any(|(_key, edges)| {
                edges.iter().any(|edge| {
                    matches!(
                        edge,
                        CrossSheetRef::Range(s, r) if *s == src_sheet && *r == range
                    )
                })
            })
    }

    /// Total reverse-edge count across both cell and range halves. Used
    /// by the Phase 3 acceptance test to verify the cross-sheet write
    /// actually exercised the graph. Each point-cell entry contributes
    /// its dependent set size; each range entry contributes its dependent
    /// set size; ranges that contain N source cells still count as one
    /// entry per dependent (not N), preserving the sparse contract.
    #[doc(hidden)]
    pub fn debug_reverse_edge_count(&self) -> usize {
        let cell_edges: usize = self.cell_dependents.values().map(HashSet::len).sum();
        let range_edges: usize = self
            .range_index_per_sheet
            .values()
            .map(RangeDependentIndex::len)
            .sum();
        cell_edges + range_edges
    }
}

/// One entry in `Workbook::named_values`. Stores the user-supplied
/// canonical-case name alongside the cached `Value` so the registry can
/// report names back to UIs with the casing the user typed, while
/// `define_name` / `undefine_name` / lookup still operate
/// case-insensitively (key is the uppercased form).
///
/// Reserves room for a future `source: Option<String>` field carrying the
/// original formula text — useful when a host wants to round-trip the
/// definition through `serialize → restore`. Not added in this commit
/// because none of the W3 callers need it yet.
#[derive(Clone, Debug)]
struct NamedEntry {
    /// The name as the user originally typed it (e.g. `"Tax_Rate"`),
    /// preserved across read-back so the registry doesn't force-uppercase.
    canonical_name: String,
    /// The materialized value. For LAMBDA-defining formulas this is
    /// `Value::Lambda`; for `=42`-style formulas this is `Value::Number`,
    /// etc.
    value: Value,
}

/// Errors raised by the defined-name registry. Distinct from
/// `SheetError` because the failure modes (parse / eval / reserved name
/// collision) are orthogonal to per-cell write protections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkbookError {
    /// The proposed name collides with a built-in function name (`SUM`,
    /// `IF`, `LAMBDA`, etc.). Excel rejects this with `#NAME?` at
    /// definition time and we mirror the rejection so callers know the
    /// registration would never be reachable (the dispatch table beats
    /// the registry anyway). Comparison is case-insensitive via
    /// `is_builtin_function_name`.
    ReservedName,
    /// The proposed name violates the identifier grammar:
    /// `[A-Za-z_][A-Za-z0-9_]*`, length 1..=255. We deliberately do not
    /// accept dotted names here — Excel's dotted syntax (`T.DIST`) is
    /// reserved for built-ins, and the parser would route `=foo.bar` as
    /// a tokenization error anyway.
    InvalidName,
    /// The formula text supplied to `define_name(name, formula)` failed
    /// to parse (must start with `=` and be a valid expression).
    ParseFailed,
    /// The formula parsed but evaluation surfaced an error (e.g. the
    /// definition references an unbound name, or hits a #DIV/0! during
    /// reduction). The wrapped `ValueError` is the eval-time error so
    /// callers can show the same cell-style code the user would see if
    /// they typed the formula into a cell.
    EvalFailed(ValueError),
    /// Wave 8 re-entrancy guard: the caller tried to mutate the workbook
    /// while a host custom-formula JS callback was executing. Mutations
    /// during a callback would dirty the cell whose formula triggered the
    /// callback, but the cache state machine writes `Clean(value)` on
    /// return — silently losing the dirty mark. We surface this as a
    /// rejection so hosts can debug rather than chasing stale values.
    /// See `CUSTOM_FORMULAS.md` § "No mutations during callback".
    MutationDuringCustomCall,
}

impl std::fmt::Display for WorkbookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkbookError::ReservedName => {
                write!(f, "name collides with a built-in function name")
            }
            WorkbookError::InvalidName => write!(
                f,
                "name must match [A-Za-z_][A-Za-z0-9_]* and be 1..=255 chars"
            ),
            WorkbookError::ParseFailed => write!(f, "formula text failed to parse"),
            WorkbookError::EvalFailed(e) => write!(f, "formula evaluation surfaced {}", e),
            WorkbookError::MutationDuringCustomCall => write!(
                f,
                "workbook mutations are forbidden while a custom-formula callback is executing"
            ),
        }
    }
}

impl std::error::Error for WorkbookError {}

/// A workbook is an ordered collection of named sheets. Phase 4 backend.
///
/// Cross-sheet references (`=Sheet2!A1`) resolve through a Workbook
/// `EvalProvider`. Formula nodes stay lazy: reads evaluate the reachable
/// formula chain, writes only mark local dependents dirty.
pub struct Workbook {
    sheets: Vec<Sheet>,
    names: Vec<String>,
    /// name → index lookup; rebuilt whenever sheets are added/renamed.
    by_name: HashMap<String, usize>,
    /// Cross-sheet reverse dep graph (Phase 3 Track I). Maintained by the
    /// workbook-routed mutators (`set_cell`, `set_formula`, `clear_cell`,
    /// `bulk_load`). Empty for workbooks edited exclusively through the
    /// `Sheet::set_*` direct path — those writes deliberately bypass the
    /// graph so single-sheet tests stay stable.
    cross_sheet: CrossSheetDeps,
    /// Phase 3 Track J probe counter: cumulative count of
    /// `collect_workbook_refs` AST walks initiated by this workbook's
    /// `cross_sheet_cycle`. The Track J rewrite calls
    /// `collect_workbook_refs` exactly once per `set_formula` (for the
    /// candidate seed) and pulls visited-node edges from the forward
    /// index. The pre-Track-J shape called `collect_workbook_refs` once
    /// per VISITED formula too, so a test can assert the new shape by
    /// checking the delta is 1 per `set_formula`, not N.
    ///
    /// Per-workbook (not process-global) so the assertion isn't flaky
    /// under cargo's parallel test runner.
    cycle_ast_walk_count: Cell<usize>,
    /// Workbook-level defined names. Keyed by the uppercased form of the
    /// name so lookup is case-insensitive (Excel parity — `=Tax_Rate` and
    /// `=TAX_RATE` resolve to the same entry); the entry's
    /// `canonical_name` field preserves the original casing for UIs.
    ///
    /// Holds arbitrary `Value`s (not just lambdas) so a user can register
    /// `define_name("answer", "=42")` and reference it from any cell.
    /// The dominant use case is LAMBDAs registered as named functions —
    /// `define_name("SQUARE", "=LAMBDA(x, x*x)")` makes `=SQUARE(5)` work
    /// just like a built-in.
    ///
    /// `BTreeMap` rather than `HashMap` so the registry has a stable
    /// iteration order (alphabetical by uppercased name) — useful for
    /// snapshot diffs and serialization. The map is unbounded in this
    /// initial cut; the W2 ROADMAP caps the parallel UI-side named-range
    /// list at 500, and the workbook-core layer can enforce a similar
    /// cap once a host needs it.
    named_values: BTreeMap<String, NamedEntry>,
    /// Host-supplied custom-formula registry (Wave 8). When `Some`, formula
    /// dispatch consults this AFTER built-ins and after defined-name LAMBDAs
    /// (see precedence note on `eval_named_call`). When `None`, unknown
    /// function names surface `#NAME?` exactly as before.
    ///
    /// The trait object owns the JS callback map in the wasm context;
    /// native tests can plug in their own implementation. Kept in an
    /// `Arc` so the per-eval `WorkbookEvalProvider` can clone the handle
    /// cheaply without taking a `&self` borrow on the workbook.
    custom_functions: Option<Arc<dyn CustomFunctionRegistry>>,
    /// Wave 8 re-entrancy guard. Counts the active "inside a host
    /// custom-formula callback" frames (a counter rather than a bool so
    /// nested custom calls — `=A(B())` where `A` and `B` are both customs
    /// — increment/decrement cleanly via RAII). When non-zero, every
    /// public mutation entry point on `Workbook` (`set_cell`,
    /// `clear_cell`, `set_formula`, `define_name`, `undefine_name`,
    /// `set_custom_function_registry`, `add_sheet`, `rename_sheet`,
    /// `remove_sheet`, `bulk_load`, `try_set_*`) is a guarded no-op /
    /// rejection.
    ///
    /// **Why**: a JS callback that mutates the workbook would dirty the
    /// cell currently being evaluated, but the surrounding
    /// `eval_formula_at_with_provider` writes
    /// `FormulaCache::Clean(value)` unconditionally on return — silently
    /// losing the dirty mark. Disallowing mutations during the callback
    /// keeps the cache state machine sound. The contract is documented
    /// in `CUSTOM_FORMULAS.md` § "No mutations during callback".
    ///
    /// `Cell<usize>` (not `RefCell<...>`) because mutation is a single
    /// load + store, no aliasing concerns. The guard is `pub(crate)` so
    /// the `WorkbookEvalProvider::call_custom` adapter can bump/decrement
    /// it via the RAII guard in `CustomCallScope`.
    pub(crate) custom_call_depth: Cell<usize>,
    /// STORAGE_PRIMARY Phase 6.1 (OD1): monotonically-increasing content
    /// revision. Bumped once per `install_sheet_bulk` (so once per sheet
    /// inside `install_workbook_bulk`) — a bulk install replaces a whole
    /// sheet's content without per-cell notifications, so hosts /
    /// projection layers compare this counter to know "the world
    /// changed, re-read everything". Single-cell mutators do NOT bump it
    /// (they have precise per-cell subscriber fanout already).
    content_revision: u64,
}

/// STORAGE_PRIMARY Phase 6.1: result stats from one
/// [`Workbook::install_sheet_bulk`] call.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BulkInstallStats {
    /// Primitive values installed (excludes `Value::Null` entries and
    /// addresses shadowed by a formula in the same payload).
    pub primitives_installed: usize,
    /// Formula sources parked lazily (`formula_source` + `needs_parse`).
    pub formulas_installed: usize,
    /// Formulas that went through the `!`-prefilter cross-sheet parse.
    /// 0 when every formula is same-sheet (the dominant case).
    pub cross_sheet_parsed: usize,
}

/// STORAGE_PRIMARY Phase 6.1: rejection reasons for
/// [`Workbook::install_sheet_bulk`] / [`Workbook::install_workbook_bulk`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallError {
    /// The payload referenced a sheet index outside the workbook.
    SheetOutOfRange(usize),
    /// Bulk install attempted from inside a custom-formula callback
    /// (Wave 8 re-entrancy guard — same contract as every other
    /// workbook mutation entry point).
    MutationDuringCustomCall,
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::SheetOutOfRange(idx) => {
                write!(f, "sheet index {idx} is outside the workbook")
            }
            InstallError::MutationDuringCustomCall => {
                write!(f, "bulk install is not allowed inside a custom-formula callback")
            }
        }
    }
}

impl std::error::Error for InstallError {}

/// RAII scope guard that increments `Workbook::custom_call_depth` on
/// construction and decrements on drop. Used by
/// `WorkbookEvalProvider::call_custom` to bracket the JS callback
/// invocation so re-entrant mutation calls (via the WASM bridge) can
/// detect they are inside a callback frame.
///
/// **Why a struct rather than inline `+= 1 / -= 1`**: the JS callback can
/// throw or short-circuit via wasm-bindgen's exception path; the scope
/// guard's `Drop` impl ensures the depth counter is restored regardless
/// of how control leaves the call.
pub(crate) struct CustomCallScope<'a> {
    counter: &'a Cell<usize>,
}

impl<'a> CustomCallScope<'a> {
    pub(crate) fn enter(counter: &'a Cell<usize>) -> Self {
        counter.set(counter.get() + 1);
        CustomCallScope { counter }
    }
}

impl Drop for CustomCallScope<'_> {
    fn drop(&mut self) {
        // Saturating sub guards against an underflow in case the counter
        // somehow goes out of sync (it shouldn't — every enter pairs with
        // a drop). Leaving the counter at 0 on drop means subsequent
        // mutations after callback exit work as normal.
        let prev = self.counter.get();
        self.counter.set(prev.saturating_sub(1));
    }
}

impl Workbook {
    pub fn new() -> Self {
        let mut wb = Workbook {
            sheets: Vec::new(),
            names: Vec::new(),
            by_name: HashMap::new(),
            cross_sheet: CrossSheetDeps::new(),
            cycle_ast_walk_count: Cell::new(0),
            named_values: BTreeMap::new(),
            custom_functions: None,
            custom_call_depth: Cell::new(0),
            content_revision: 0,
        };
        // Default sheet so users can `wb.active_mut()` without first calling
        // add_sheet — matches the Excel "blank file already has Sheet1" UX.
        wb.add_sheet("Sheet1");
        wb
    }

    // === Workbook-level defined-name registry ===
    //
    // Two-tier API:
    //   - `define_name(name, formula)` parses + evaluates a `=`-prefixed
    //     formula, then stores the resulting Value under `name`. This is
    //     the "register a LAMBDA as a named function" entry point and is
    //     the path the WASM binding exposes.
    //   - `define_name_value(name, value)` skips parse/eval and stores a
    //     value directly. Used by tests and by hosts that have a Value in
    //     hand (e.g. round-tripping from a serialization layer).
    //
    // Both go through `register_name` for validation + dep invalidation.

    /// Parse and evaluate `formula` (must start with `=`), then register
    /// the result under `name`. The dominant use case is registering a
    /// LAMBDA as a callable named function: after
    /// `wb.define_name("SQUARE", "=LAMBDA(x, x*x)")`, the cell formula
    /// `=SQUARE(5)` resolves through the registry's lambda and returns
    /// `25`.
    ///
    /// Evaluation runs in the workbook context (so the definition can
    /// reference cells, other named values, and built-in functions) on
    /// `Sheet1` (sheet index 0) as the "current" sheet for any bare
    /// cell-ref inside the definition. Hosts that need a different
    /// evaluation sheet can build the `Value` themselves and call
    /// `define_name_value` directly.
    ///
    /// Returns `WorkbookError::ParseFailed` for bad formula text,
    /// `WorkbookError::EvalFailed(e)` if evaluation surfaces an error
    /// (the registry is left unchanged in that case), and the same
    /// validation errors as `define_name_value` otherwise.
    pub fn define_name(&mut self, name: &str, formula: &str) -> Result<(), WorkbookError> {
        if self.is_inside_custom_call() {
            return Err(WorkbookError::MutationDuringCustomCall);
        }
        let expr = parse_formula(formula).ok_or(WorkbookError::ParseFailed)?;

        // Evaluate against a workbook provider rooted on sheet 0. Sheet
        // index 0 is guaranteed to exist (constructor seeds Sheet1) so
        // we don't need to guard the index here.
        let provider = WorkbookEvalProvider {
            wb: self,
            current: Cell::new(0),
            current_cell: Cell::new(None),
        };
        let value = eval_expr_with_provider(&expr, &provider);
        // Drop the provider's borrow before mutating self.
        drop(provider);
        if let Value::Error(e) = value {
            return Err(WorkbookError::EvalFailed(e));
        }
        self.define_name_value(name, value)
    }

    /// Register a pre-built `Value` under `name`. Mostly used by tests
    /// and by hosts that already hold a constructed `Value` (e.g. after
    /// deserialization). Production callers usually want `define_name`,
    /// which handles the parse+eval round-trip.
    ///
    /// Validation:
    ///   - `name` must match `[A-Za-z_][A-Za-z0-9_]*`, length 1..=255.
    ///   - The uppercased name must not collide with a built-in function
    ///     name (`SUM`, `IF`, etc.).
    ///
    /// On success, walks all sheets and marks every formula whose AST
    /// references `name` (as either a bare `Expr::Name` or a
    /// `Expr::FuncCall` whose target is `name`) dirty, so cached
    /// formula values re-evaluate against the updated registry on next
    /// read.
    pub fn define_name_value(&mut self, name: &str, value: Value) -> Result<(), WorkbookError> {
        if self.is_inside_custom_call() {
            return Err(WorkbookError::MutationDuringCustomCall);
        }
        Self::validate_name(name)?;
        let key = name.to_ascii_uppercase();
        if is_builtin_function_name(&key) {
            return Err(WorkbookError::ReservedName);
        }
        self.named_values.insert(
            key,
            NamedEntry {
                canonical_name: name.to_string(),
                value,
            },
        );
        self.invalidate_formulas_using_name(name);
        Ok(())
    }

    /// Remove a previously-registered name. Idempotent — a no-op when
    /// no entry exists for `name`. Returns `true` if an entry was
    /// removed, `false` otherwise. Invalidates downstream formulas the
    /// same way `define_name` does so previously-cached results that
    /// depended on the name re-evaluate (and now surface `#NAME?`).
    pub fn undefine_name(&mut self, name: &str) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard
        }
        let key = name.to_ascii_uppercase();
        let removed = self.named_values.remove(&key).is_some();
        if removed {
            self.invalidate_formulas_using_name(name);
        }
        removed
    }

    /// Case-insensitive lookup. Returns a clone of the registered
    /// value, or `None` if no entry exists. Used by the
    /// `WorkbookEvalProvider::lookup_named` impl that the formula
    /// evaluator consults for `Expr::Name` / `Expr::FuncCall`
    /// fallthrough.
    pub fn get_named(&self, name: &str) -> Option<Value> {
        let key = name.to_ascii_uppercase();
        self.named_values.get(&key).map(|e| e.value.clone())
    }

    /// Iterator over registered names in canonical (user-typed) casing,
    /// sorted alphabetically by their uppercased key. Companion API for
    /// hosts that want to display the registry — the underlying value
    /// is intentionally not exposed here (callers go through
    /// `get_named` if they need it) so a future host that needs only
    /// the names doesn't end up cloning every Lambda.
    pub fn named_names(&self) -> impl Iterator<Item = &str> {
        self.named_values
            .values()
            .map(|e| e.canonical_name.as_str())
    }

    /// Install (or replace) the host's custom-formula registry. Passing
    /// `None` detaches the previous registry — subsequent unknown
    /// function calls fall straight through to `#NAME?` again.
    ///
    /// Wave 8 entry point: the wasm bridge wraps a `js_sys::Function`
    /// hash map in a struct that impls `CustomFunctionRegistry` and
    /// installs it here. Cells whose formulas reference custom-formula
    /// names are NOT auto-invalidated by this call — the host is expected
    /// to invoke `bump_custom_function_revision` (or equivalent) when a
    /// registration change should re-fire cached cells. (Initial cut:
    /// registrations are stable per session, so no invalidation hook is
    /// wired yet.)
    pub fn set_custom_function_registry(
        &mut self,
        registry: Option<Arc<dyn CustomFunctionRegistry>>,
    ) {
        if self.is_inside_custom_call() {
            // Re-entrancy guard. Swapping the registry mid-callback is
            // the worst possible time to do it (the running callback's
            // closure environment becomes orphaned). Drop the request;
            // hosts that need this should defer it past the read.
            return;
        }
        self.custom_functions = registry;
    }

    /// Clone of the currently-installed custom-formula registry handle,
    /// if any. Returns the `Arc<dyn ...>` so the caller can stash it for
    /// later (e.g. the per-eval provider snapshots the Arc up-front so
    /// it survives concurrent re-installs).
    pub fn custom_function_registry(&self) -> Option<Arc<dyn CustomFunctionRegistry>> {
        self.custom_functions.clone()
    }

    /// True iff a host custom-formula JS callback is currently executing
    /// (i.e. the engine is inside a `WorkbookEvalProvider::call_custom`
    /// frame). Public so the WASM bridge can short-circuit re-entrant
    /// mutation calls with a meaningful error rather than the opaque
    /// `wasm-bindgen` "recursive use of an object" panic.
    ///
    /// See `CUSTOM_FORMULAS.md` § "No mutations during callback" for the
    /// contract.
    pub fn is_inside_custom_call(&self) -> bool {
        self.custom_call_depth.get() > 0
    }

    /// Handle to the re-entrancy depth counter. `pub(crate)` because the
    /// `WorkbookEvalProvider::call_custom` adapter constructs a
    /// `CustomCallScope` from this; external callers should use
    /// `is_inside_custom_call` to query.
    pub(crate) fn custom_call_depth_cell(&self) -> &Cell<usize> {
        &self.custom_call_depth
    }

    /// Force every formula in the workbook to re-evaluate the next time
    /// it is read. Companion to `set_custom_function_registry`: a host
    /// that adds / removes / replaces a custom function callback can
    /// call this to invalidate cached results that depended on
    /// `MYFUNC(...)` (which the cache marks `clean` after a successful
    /// first compute, identical to any other formula). Implementation:
    /// walks every sheet's formula table and flips the cache to dirty,
    /// then fires per-cell subscribers so reactive hosts repaint.
    ///
    /// This is intentionally a sledgehammer — the engine has no
    /// reverse-dep index keyed on custom-function name. A host that
    /// hot-swaps registrations frequently can build its own per-name
    /// invalidation index on top.
    pub fn invalidate_all_formulas_for_custom_function_change(&self) {
        for sheet in &self.sheets {
            let addrs: Vec<CellAddress> = sheet.formula_exprs_iter().keys().copied().collect();
            for addr in addrs {
                sheet.mark_dirty_for_addr(addr);
                sheet.fire_subscribers(addr);
            }
        }
    }

    fn validate_name(name: &str) -> Result<(), WorkbookError> {
        if name.is_empty() || name.len() > 255 {
            return Err(WorkbookError::InvalidName);
        }
        let mut bytes = name.bytes();
        let first = bytes.next().unwrap();
        let first_ok = first.is_ascii_alphabetic() || first == b'_';
        if !first_ok {
            return Err(WorkbookError::InvalidName);
        }
        for b in bytes {
            let ok = b.is_ascii_alphanumeric() || b == b'_';
            if !ok {
                return Err(WorkbookError::InvalidName);
            }
        }
        Ok(())
    }

    /// Walk every formula in every sheet and mark it dirty if its AST
    /// references `name` (case-insensitive). The dirty mark flips the
    /// formula's cache to `Dirty` so the next read recomputes against
    /// the up-to-date registry. Also fires any per-cell subscribers so
    /// reactive hosts (the worker backend, the Solid components) see a
    /// value-change signal without polling.
    ///
    /// **Why a global walk instead of a reverse-dep index**: cells
    /// referencing a named value aren't tracked in the cross-sheet
    /// graph (which keys on `(sheet, addr)`) or the per-sheet
    /// `cell_dependents` (which keys on `CellAddress`). Adding a third
    /// reverse index keyed on `String` would carry per-formula
    /// bookkeeping that 99% of workbooks never exercise (defined names
    /// are rare). The whole-workbook walk runs O(F) where F is the
    /// total formula count — fine for the workbooks this engine
    /// targets (low thousands of formulas). If a host registers
    /// hundreds of names and re-defines them frequently, switching to
    /// a `HashMap<String, HashSet<(sheet_idx, addr)>>` keyed on
    /// uppercased name is a straightforward future optimization.
    fn invalidate_formulas_using_name(&self, name: &str) {
        let key = name.to_ascii_uppercase();
        for sheet in &self.sheets {
            // LAZY_FORMULA_INDEXING Phase 3: snapshot the (addr, expr)
            // pairs out of the live `Ref` before iterating so the
            // closures we call below (`mark_dirty_for_addr`,
            // `fire_subscribers`) can take their own `borrow()`s on
            // `formula_cells` without a conflict.
            let entries: Vec<(CellAddress, Rc<Expr>)> = sheet
                .formula_exprs_iter()
                .iter()
                .map(|(addr, expr)| (*addr, expr.clone()))
                .collect();
            for (addr, expr) in entries {
                if formula_references_name(&expr, &key) {
                    sheet.mark_dirty_for_addr(addr);
                    sheet.fire_subscribers(addr);
                }
            }
        }
    }

    /// Append a new empty sheet. If the name is already taken, returns the
    /// existing index without creating a duplicate.
    pub fn add_sheet(&mut self, name: &str) -> usize {
        if self.is_inside_custom_call() {
            // Re-entrancy guard. Return the existing index if the name
            // happens to exist (idempotent — matches the dup-name branch
            // below) or 0 (Sheet1, always exists) so the caller gets a
            // valid-shaped result. This is the infallible signature; a
            // host that needs the rejection should query
            // `is_inside_custom_call` before calling.
            return self.by_name.get(name).copied().unwrap_or(0);
        }
        if let Some(&idx) = self.by_name.get(name) {
            return idx;
        }
        let idx = self.sheets.len();
        self.sheets.push(Sheet::new());
        self.names.push(name.to_string());
        self.by_name.insert(name.to_string(), idx);
        idx
    }

    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    pub fn name(&self, idx: usize) -> Option<&str> {
        self.names.get(idx).map(String::as_str)
    }

    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.by_name.get(name).copied()
    }

    pub fn sheet(&self, idx: usize) -> Option<&Sheet> {
        self.sheets.get(idx)
    }

    pub fn sheet_mut(&mut self, idx: usize) -> Option<&mut Sheet> {
        self.sheets.get_mut(idx)
    }

    pub fn sheet_by_name(&self, name: &str) -> Option<&Sheet> {
        self.index_of(name).and_then(|i| self.sheet(i))
    }

    pub fn sheet_by_name_mut(&mut self, name: &str) -> Option<&mut Sheet> {
        self.index_of(name).and_then(move |i| self.sheet_mut(i))
    }

    /// Rename a sheet. Fails (returns false) if the new name is taken.
    pub fn rename_sheet(&mut self, idx: usize, new_name: &str) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard
        }
        if self.by_name.contains_key(new_name) {
            return false;
        }
        if idx >= self.names.len() {
            return false;
        }
        let old = std::mem::take(&mut self.names[idx]);
        self.by_name.remove(&old);
        self.names[idx] = new_name.to_string();
        self.by_name.insert(new_name.to_string(), idx);
        true
    }

    fn rebuild_name_lookup(&mut self) {
        self.by_name.clear();
        for (idx, name) in self.names.iter().enumerate() {
            self.by_name.insert(name.clone(), idx);
        }
    }

    fn rebuild_cross_sheet_deps(&mut self) {
        let mut cross_sheet = CrossSheetDeps::new();
        for (formula_sheet, sheet) in self.sheets.iter().enumerate() {
            // Hydrated formulas: walk the cached AST.
            let exprs = sheet.formula_exprs_iter();
            for (&formula_addr, expr) in exprs.iter() {
                for edge in collect_cross_sheet_refs(expr.as_ref(), &self.by_name) {
                    cross_sheet.add_edge(formula_sheet, formula_addr, edge);
                }
            }
            // Codex P2 #1 fix: lazy (parked) formulas would otherwise
            // contribute zero edges here, so a `move_sheet` between a
            // `bulk_load` and the first read of a cross-sheet formula
            // silently drops every cross-sheet edge that formula owns.
            // Parse on-the-fly per lazy entry (cheap relative to the
            // rebuild cost itself, which only runs on sheet moves) so
            // the edge set survives the move; the hydrator on first
            // read still owns the FormulaRecord install — we only walk
            // the AST here, we do not install dep edges or transition
            // the lazy entry out of `needs_parse`.
            drop(exprs);
            sheet.for_each_lazy_formula(|formula_addr, source| {
                if let Some(expr) = parse_formula(source) {
                    for edge in collect_cross_sheet_refs(&expr, &self.by_name) {
                        cross_sheet.add_edge(formula_sheet, formula_addr, edge);
                    }
                }
            });
        }
        self.cross_sheet = cross_sheet;
    }

    /// Move a sheet from `from` to its final index `to`.
    ///
    /// Formula ASTs store sheet names, while `CrossSheetDeps` stores the
    /// current sheet indexes for dirty fanout. Reordering therefore moves the
    /// sheet/name vectors, rebuilds the name lookup, and then rebuilds the
    /// cross-sheet dependency graph from the live formula ASTs.
    pub fn move_sheet(&mut self, from: usize, to: usize) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard
        }
        if from >= self.sheets.len() || to >= self.sheets.len() {
            return false;
        }
        if from == to {
            return true;
        }

        let sheet = self.sheets.remove(from);
        let name = self.names.remove(from);
        self.sheets.insert(to, sheet);
        self.names.insert(to, name);
        self.rebuild_name_lookup();
        self.rebuild_cross_sheet_deps();
        true
    }

    /// Read a cell from a named sheet. Cross-sheet references in formulas
    /// resolve through this path.
    ///
    /// Workbook reads bypass formula cache so cross-sheet sources are always
    /// observed live. Plain `Sheet::get_cell` keeps using per-formula dirty
    /// cache for same-sheet formulas.
    pub fn get_cell(&self, sheet_name: &str, addr_str: &str) -> Value {
        let idx = match self.index_of(sheet_name) {
            Some(i) => i,
            None => return Value::Null,
        };
        let addr = match CellAddress::parse(addr_str) {
            Some(a) => a,
            None => return Value::Null,
        };

        let provider = WorkbookEvalProvider {
            wb: self,
            current: Cell::new(idx),
            current_cell: Cell::new(None),
        };
        self.sheets[idx].peek_value_with_provider(addr, &provider)
    }

    /// Sparse read over one sheet range in workbook context.
    ///
    /// Only non-empty primitive/formula cells inside `range` are visited.
    /// Formula cells are resolved through `WorkbookEvalProvider`, so
    /// cross-sheet references inside formulas behave the same as
    /// `Workbook::get_cell`.
    pub fn for_each_sparse_range_cell(
        &self,
        sheet_idx: usize,
        range: CellRange,
        mut f: impl FnMut(CellAddress, Value),
    ) {
        let Some(sheet) = self.sheets.get(sheet_idx) else {
            return;
        };
        let provider = WorkbookEvalProvider {
            wb: self,
            current: Cell::new(sheet_idx),
            current_cell: Cell::new(None),
        };
        sheet.for_each_sparse_cell_with(
            range,
            &|sheet, addr| sheet.peek_value_with_provider(addr, &provider),
            &mut f,
        );
    }

    #[doc(hidden)]
    pub fn debug_formula_cache_state(&self, sheet_idx: usize, addr_str: &str) -> &'static str {
        self.sheets
            .get(sheet_idx)
            .map(|sheet| sheet.debug_formula_cache_state(addr_str))
            .unwrap_or("missing-sheet")
    }

    #[doc(hidden)]
    pub fn debug_formula_eval_count(&self, sheet_idx: usize) -> usize {
        self.sheets
            .get(sheet_idx)
            .map(|sheet| sheet.debug_formula_eval_count())
            .unwrap_or(0)
    }

    /// Workbook-aware variant of `Sheet::set_formula`. Performs a
    /// **cross-sheet** static cycle check before installing the formula:
    /// references like `=Sheet2!A1` are followed across sheet boundaries so
    /// that pairs like `Sheet1!A1 = =Sheet2!A1` + `Sheet2!A1 = =Sheet1!A1`
    /// are caught and the second `set_formula` writes `#CYCLE!` instead of
    /// silently producing a stale value at runtime.
    ///
    /// Returns `false` if any of:
    ///   - `sheet_idx` is out of range
    ///   - the formula text fails to parse (cell becomes `#VALUE!`)
    ///   - installing the formula would close a cross-sheet cycle (cell
    ///     becomes `#CYCLE!`)
    ///   - the sheet-local same-sheet cycle check (delegated to
    ///     `Sheet::set_formula`) detects a cycle (also `#CYCLE!`)
    ///
    /// Otherwise returns `true` and the formula is live.
    ///
    /// **Complexity**: builds the dep graph on demand on each call. Worst
    /// case walks every formula reachable from `addr`'s tentative dep set,
    /// across all sheets — at most O(F + R) where F is the total number of
    /// formula cells visited and R is the size of the reachable refs (each
    /// `Range` contributes only formula cells inside it via the gated
    /// `collect_formula_refs_into`-style logic to avoid `SUM(A:A)` blowup).
    /// In practice this is bounded by the size of the cross-sheet dep
    /// closure of `addr`, which is small for typical workbooks.
    pub fn set_formula(&mut self, sheet_idx: usize, addr_str: &str, formula_text: &str) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard; see `set_cell` for rationale
        }
        if sheet_idx >= self.sheets.len() {
            return false;
        }
        let addr = match CellAddress::parse(addr_str) {
            Some(a) => a,
            None => return false,
        };

        // Try parse first. On parse failure delegate to sheet.set_formula —
        // it has the canonical "write #VALUE! and clean up" path. Also
        // drop any previous cross-sheet edges this addr had: a #VALUE!
        // cell is no longer participating in cross-sheet deps.
        let expr = match parse_formula(formula_text) {
            Some(e) => e,
            None => {
                self.cross_sheet.remove_outgoing(sheet_idx, addr);
                self.sheets[sheet_idx].set_formula(addr_str, formula_text);
                // Propagate dirty: the address's previous value was
                // potentially observed by cross-sheet dependents.
                self.propagate_cross_sheet_dirty(sheet_idx, addr);
                return false;
            }
        };

        // Cross-sheet cycle pre-check: would installing `expr` at
        // (sheet_idx, addr) make `(sheet_idx, addr)` reachable from itself
        // through any combination of same-sheet and SheetRef edges?
        if self.cross_sheet_cycle(sheet_idx, addr, &expr) {
            self.cross_sheet.remove_outgoing(sheet_idx, addr);
            self.sheets[sheet_idx].write_error(addr, ValueError::CyclicRef);
            self.propagate_cross_sheet_dirty(sheet_idx, addr);
            return false;
        }

        // Compute the new outgoing edges from the parsed AST. Same-sheet
        // refs are handled inside `Sheet::set_formula` via its own
        // `cell_dependents` / `range_dependents`; this walk only emits
        // edges that cross a sheet boundary.
        let new_edges = collect_cross_sheet_refs(&expr, &self.by_name);

        // Remove the previous formula's outgoing edges before installing
        // new ones — if the previous formula referenced `Sheet2!A1` and
        // the new one doesn't, that reverse edge has to disappear.
        self.cross_sheet.remove_outgoing(sheet_idx, addr);

        // Install the new edges optimistically. If `Sheet::set_formula`
        // rejects the formula (parse-fail / same-sheet cycle that the
        // workbook-level pre-check missed), the rollback path below
        // restores the world to "no edges for this addr".
        for edge in &new_edges {
            self.cross_sheet.add_edge(sheet_idx, addr, edge.clone());
        }

        // Delegate to per-sheet set_formula. It still runs `would_create_cycle`
        // for same-sheet cycles — that path was already correct and we don't
        // duplicate the check here.
        let ok = self.sheets[sheet_idx].set_formula(addr_str, formula_text);
        if !ok {
            // Sheet-level rejection (parse-fail handled above already, so
            // this is the same-sheet cycle path). Roll back the edges we
            // just inserted to keep the graph honest.
            self.cross_sheet.remove_outgoing(sheet_idx, addr);
        }

        // Whether the formula was accepted or rejected, downstream
        // cross-sheet dependents need a dirty bump — the cell's value
        // is no longer the previous formula's cached result.
        self.propagate_cross_sheet_dirty(sheet_idx, addr);

        // Workbook-context array recompute: `Sheet::set_formula` runs an
        // eager array-recompute pass with a sheet-only provider, which
        // doesn't see the workbook's named-value registry or cross-sheet
        // refs. If the formula relies on either (e.g.
        // `=MAP(SEQUENCE(3), inc)` where `inc` is a defined LAMBDA),
        // the sheet-local eval returns `#NAME?` and the spill isn't
        // installed. Re-run the recompute here through a workbook-aware
        // provider so the spill anchors / derived targets land correctly.
        //
        // Gated on `formula_needs_workbook_context` so the common case —
        // a plain `=A1+B1` or inline `=MAP(A1:A3, LAMBDA(...))` — skips
        // the second eval pass and stays as cheap as before this commit.
        if ok && formula_needs_workbook_context(&expr) {
            self.recompute_array_spill_with_workbook_context(sheet_idx, addr);
        }

        ok
    }

    /// Re-run the spill recompute for `(sheet_idx, addr)` through a
    /// `WorkbookEvalProvider`. The build-then-mutate split is what the
    /// borrow checker requires: the provider needs `&self`, but the
    /// install needs `&mut self.sheets[sheet_idx]`. We scope the
    /// provider inside a block, snapshot the Value the provider
    /// produced, drop the borrow, then hand the Value to a mutating
    /// install path on the sheet.
    fn recompute_array_spill_with_workbook_context(&mut self, sheet_idx: usize, addr: CellAddress) {
        // Evaluate the formula through the workbook provider so named-
        // value / cross-sheet lookups resolve. The value is returned by
        // copy so we can drop the immutable borrow before mutating.
        let value = {
            let provider = WorkbookEvalProvider {
                wb: self,
                current: Cell::new(sheet_idx),
                current_cell: Cell::new(None),
            };
            // Force a re-eval (bypass the cache) so any earlier sheet-
            // local result that surfaced #NAME? doesn't shadow the
            // correct workbook-aware Array.
            if let Some(sheet) = self.sheets.get(sheet_idx) {
                if let Some(record) = sheet.formula_exprs_iter().get(&addr).cloned() {
                    sheet.mark_dirty_for_addr(addr);
                    crate::eval::eval_expr_with_provider(record.as_ref(), &provider)
                } else {
                    return;
                }
            } else {
                return;
            }
        };
        // Mutate: install / refresh the spill from the workbook-aware
        // value. The sheet's `apply_workbook_recomputed_value` handles
        // the array-vs-scalar branch identically to
        // `recompute_array_formula`, so the spill state mirrors the
        // sheet-only path when no workbook-scope refs are involved.
        if let Some(sheet) = self.sheets.get_mut(sheet_idx) {
            sheet.apply_workbook_recomputed_value(addr, value);
        }
    }

    /// Workbook-routed cell write. Mirrors `Sheet::set_cell` but also
    /// fans the dirty-mark + subscriber-fire signal out across the
    /// cross-sheet dep graph maintained in `cross_sheet`. Use this
    /// (instead of `wb.sheet_mut(idx).set_cell`) when the write should
    /// be visible to cross-sheet subscribers.
    ///
    /// The legacy `wb.sheet_mut(idx).set_cell(addr, value)` path stays
    /// valid for single-sheet tests but does NOT propagate cross-sheet
    /// dirty — that's the "raw" path the documented gap test
    /// `workbook_get_cell_refreshes_cross_sheet_cache_without_notifying`
    /// exercises and continues to assert.
    pub fn set_cell(&mut self, sheet_idx: usize, addr_str: &str, value: Value) {
        if self.is_inside_custom_call() {
            // Re-entrancy guard (Wave 8). A custom-formula JS callback
            // attempted to write through the workbook while the engine
            // was still inside its eval frame. Swallow the mutation
            // silently — the infallible `set_cell` signature can't
            // return an error. Hosts that need the rejection should use
            // `try_set_cell`, which surfaces it via `SheetError`.
            return;
        }
        if sheet_idx >= self.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        // 1. Sheet-local write — fires Sheet-local subscribers + dirties
        //    Sheet-local dependents. If the previous content was a
        //    formula, this also drops its outgoing cross-sheet edges
        //    (which it owned before being overwritten with a primitive).
        self.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.sheets[sheet_idx].set_cell(addr_str, value);
        // 2. Cross-sheet fanout. The BFS layer dirties each target +
        //    fires its subscribers; if a target's own formula has a
        //    cross-sheet edge, the next BFS layer picks it up.
        self.propagate_cross_sheet_dirty(sheet_idx, addr);
    }

    /// Workbook-routed cell clear. Equivalent to `set_cell(idx, addr,
    /// Value::Null)` — a cleared cell is a write to Null with the same
    /// cross-sheet dirty fanout. Provided as a separate name so callers
    /// don't have to construct a `Value::Null` for Delete-key UX.
    pub fn clear_cell(&mut self, sheet_idx: usize, addr_str: &str) {
        if self.is_inside_custom_call() {
            return; // re-entrancy guard; see `set_cell` for rationale
        }
        if sheet_idx >= self.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.sheets[sheet_idx].clear_cell(addr_str);
        self.propagate_cross_sheet_dirty(sheet_idx, addr);
    }

    /// Fallible variant of `set_cell`. Mirrors `Sheet::try_set_cell` —
    /// returns `Err(SpillCellWrite { anchor })` when the target address
    /// is a non-anchor target of an active spill range. On success the
    /// cross-sheet dirty fanout runs exactly like `set_cell`.
    ///
    /// Used by the WASM boundary so JS-side hosts can surface a
    /// "cannot edit spill range" toast instead of silently swallowing
    /// the rejection.
    pub fn try_set_cell(
        &mut self,
        sheet_idx: usize,
        addr_str: &str,
        value: Value,
    ) -> Result<(), SheetError> {
        if self.is_inside_custom_call() {
            return Err(SheetError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(SheetError::InvalidAddress);
        }
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        self.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.sheets[sheet_idx].try_set_cell(addr_str, value)?;
        self.propagate_cross_sheet_dirty(sheet_idx, addr);
        Ok(())
    }

    /// Fallible variant of `clear_cell`. Mirrors `Sheet::try_clear_cell`.
    /// Returns `Err(SpillCellWrite { anchor })` when the target is
    /// inside an active spill range and `clear` was attempted on a
    /// non-anchor target.
    pub fn try_clear_cell(&mut self, sheet_idx: usize, addr_str: &str) -> Result<(), SheetError> {
        if self.is_inside_custom_call() {
            return Err(SheetError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(SheetError::InvalidAddress);
        }
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        self.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.sheets[sheet_idx].try_clear_cell(addr_str)?;
        self.propagate_cross_sheet_dirty(sheet_idx, addr);
        Ok(())
    }

    /// Fallible variant of `set_formula`. Mirrors `Sheet::try_set_formula`
    /// but routes through the workbook so cross-sheet dirty fanout still
    /// happens on success. Returns:
    ///   - `Ok(true)`  — formula parsed and installed.
    ///   - `Ok(false)` — formula parse failed (`#VALUE!`) or cycle (`#CYCLE!`).
    ///   - `Err(SpillCellWrite { anchor })` — target inside a spill range.
    ///   - `Err(InvalidAddress)` — address parse or out-of-range sheet index.
    pub fn try_set_formula(
        &mut self,
        sheet_idx: usize,
        addr_str: &str,
        formula_text: &str,
    ) -> Result<bool, SheetError> {
        if self.is_inside_custom_call() {
            return Err(SheetError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(SheetError::InvalidAddress);
        }
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        // Reject up-front so the cross-sheet graph isn't touched on rejection.
        if self.sheets[sheet_idx].is_spilled(addr) {
            // Re-derive anchor through the sheet-level fallible path so the
            // error carries the same anchor the per-sheet write would have
            // reported.
            return match self.sheets[sheet_idx].try_set_formula(addr_str, formula_text) {
                Err(err) => Err(err),
                // is_spilled() said yes but try_set_formula returned Ok — race
                // against a teardown elsewhere. Treat as a no-op success so
                // the user's keystroke is not lost on the rare race.
                Ok(ok) => Ok(ok),
            };
        }
        // Standard path: delegate to the existing infallible-on-spill
        // workbook variant; the sheet rejection turns into `Ok(false)` per
        // the legacy contract, which is fine since we've already proven the
        // address is not spilled.
        Ok(self.set_formula(sheet_idx, addr_str, formula_text))
    }

    /// Look up the spill anchor for a non-anchor spilled cell on the
    /// given sheet. Returns `None` for plain cells, anchor cells, or
    /// out-of-range sheet indexes. Used by the JS UI to draw the
    /// spill outline around the anchor's bounding rectangle even when
    /// the anchor itself is outside the visible window.
    pub fn spill_anchor(&self, sheet_idx: usize, addr_str: &str) -> Option<CellAddress> {
        let sheet = self.sheets.get(sheet_idx)?;
        let addr = CellAddress::parse(addr_str)?;
        sheet.spill_anchor_for(addr)
    }

    /// Clear every non-empty cell inside a range without materializing
    /// every address in that range. The metadata scan is sparse and does
    /// not evaluate formulas; flush still goes through `bulk_load` so
    /// same-sheet and cross-sheet dirty propagation is consolidated.
    pub fn clear_range(&mut self, sheet_idx: usize, range: CellRange) -> usize {
        let Some(sheet) = self.sheets.get(sheet_idx) else {
            return 0;
        };
        let mut addrs = Vec::new();
        sheet.for_each_non_empty_in_range(range, |addr| {
            addrs.push(addr.to_string());
        });
        let count = addrs.len();
        self.bulk_load(|loader| {
            for addr in addrs {
                loader.clear_cell(sheet_idx, &addr);
            }
        });
        count
    }

    /// Workbook-level BFS dirty propagation across cross-sheet edges.
    ///
    /// Seed: `(src_sheet, src_addr)`. For each popped item, look up its
    /// cross-sheet dependents (cell + range halves) and for each
    /// dependent `(target_sheet, target_addr)`:
    ///   - flip its formula cache to Dirty via
    ///     `Sheet::mark_dirty_for_addr`,
    ///   - fire its subscribers via `Sheet::fire_subscribers`,
    ///   - enqueue it for the next BFS layer (chained cross-sheet
    ///     dependencies — `Sheet1!D = =Sheet2!C`, `Sheet2!C = =Sheet3!A`).
    ///
    /// Uses a `VecDeque` for FIFO order and a visited `HashSet` so loops
    /// in the graph (the workbook-level static cycle check is best-effort
    /// — runtime corruption / a sneaky test setup may still close one)
    /// terminate.
    ///
    /// Two-pass split note: both `mark_dirty_for_addr` and
    /// `fire_subscribers` take `&self`, so the BFS can use immutable
    /// borrows of `self.sheets[idx]` throughout. No `&mut self` reborrow
    /// is needed mid-iteration — the dirty-flip happens through interior
    /// mutability inside `FormulaCache::Dirty` / `AddressSubscriptionBucket`.
    fn propagate_cross_sheet_dirty(&self, src_sheet: usize, src_addr: CellAddress) {
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut queue: VecDeque<(usize, CellAddress)> = VecDeque::new();
        queue.push_back((src_sheet, src_addr));
        visited.insert((src_sheet, src_addr));

        while let Some((sheet_idx, addr)) = queue.pop_front() {
            // Collect dependents of this node from both reverse-index
            // halves. The CrossSheetDeps borrows are read-only, so we
            // can collect into a Vec then release the borrow before
            // touching the sheet (avoids any cross-borrow issues).
            let mut dependents: Vec<(usize, CellAddress)> = Vec::new();

            if let Some(set) = self.cross_sheet.cell_dependents.get(&(sheet_idx, addr)) {
                dependents.extend(set.iter().copied());
            }
            if let Some(range_idx) = self.cross_sheet.range_index_per_sheet.get(&sheet_idx) {
                // The range index is keyed by source sheet and stores only
                // formula addresses. Recover every target sheet through the
                // forward `formula_refs` map so same-address formulas on
                // different sheets all receive dirty fanout.
                for target_addr in range_idx.dependents_of(addr) {
                    for target_sheet in
                        self.target_sheets_for_range_dep(target_addr, sheet_idx, addr)
                    {
                        dependents.push((target_sheet, target_addr));
                    }
                }
            }

            for (target_sheet, target_addr) in dependents {
                if !visited.insert((target_sheet, target_addr)) {
                    continue;
                }
                let Some(sheet) = self.sheets.get(target_sheet) else {
                    continue;
                };
                sheet.mark_dirty_for_addr(target_addr);
                sheet.fire_subscribers(target_addr);
                queue.push_back((target_sheet, target_addr));
            }
        }
    }

    /// Recover every formula sheet index for a range-typed reverse edge.
    /// The per-source-sheet `RangeDependentIndex` stores only
    /// `CellAddress` in its formula set (matching the sheet-local shape);
    /// the corresponding sheet is held in `formula_refs` as the key.
    ///
    /// Walks the forward map and returns every key whose
    /// `formula_addr == target_addr` and whose edge list contains a
    /// `Range(src_sheet, range)` covering `src_addr`. Worst case O(F) where
    /// F is the total formula_refs entries — acceptable for the dirty path,
    /// and small in practice (only formula cells live here, not data cells).
    fn target_sheets_for_range_dep(
        &self,
        target_addr: CellAddress,
        src_sheet: usize,
        src_addr: CellAddress,
    ) -> Vec<usize> {
        let mut out = Vec::new();
        for ((formula_sheet, formula_addr), edges) in &self.cross_sheet.formula_refs {
            if *formula_addr != target_addr {
                continue;
            }
            for edge in edges {
                if let CrossSheetRef::Range(s, range) = edge {
                    if *s == src_sheet && range.contains(src_addr) {
                        out.push(*formula_sheet);
                        break;
                    }
                }
            }
        }
        out
    }

    /// BFS the workbook-wide dep graph starting from the references of `expr`
    /// (treated as if it were already installed at `(target_idx, target)`).
    /// Returns true iff `(target_idx, target)` is reachable.
    ///
    /// **Phase 3 Track J**: visited-node edges come from
    /// `CrossSheetDeps::formula_refs` — the same forward index that
    /// `Workbook::set_formula` maintains. This avoids the per-visited-node
    /// AST walk through `collect_workbook_refs` that the pre-Track-J
    /// implementation used; instead the AST walk runs exactly once, for
    /// the CANDIDATE expression (which isn't in `formula_refs` yet because
    /// we're DECIDING whether to install it).
    ///
    /// The candidate seed still uses `collect_workbook_refs` because:
    ///   1. Its edges aren't installed yet at this point in `set_formula`.
    ///   2. We need to follow BOTH same-sheet and cross-sheet edges
    ///      *out of the candidate*. Same-sheet edges land at `(target_idx,
    ///      ref_addr)`, which lets the BFS detect cycles like
    ///      `Sheet1!A = =Sheet1!B` paired with `Sheet1!B = =Sheet1!A`
    ///      via the `formula_refs[(target_idx, ref_addr)]` lookup ONLY
    ///      if `ref_addr` itself has cross-sheet outgoing edges.
    ///
    /// `formula_refs` stores ONLY cross-sheet edges (same-sheet refs are
    /// tracked by `Sheet`'s own `cell_dependents`/`range_dependents`).
    /// Two consequences:
    ///   - Pure cross-sheet cycles (the existing 5 tests + the typical
    ///     `Sheet1!A = =Sheet2!A ↔ Sheet2!A = =Sheet1!A` shape) are caught
    ///     entirely on the index path — O(F) HashMap lookups per visited
    ///     node instead of O(AST size).
    ///   - Cycles that thread through a same-sheet hop in a *visited*
    ///     formula (e.g. `Sheet1!A = =Sheet2!B`, `Sheet2!B = =Sheet2!C`,
    ///     `Sheet2!C = =Sheet1!A`) won't be caught here because
    ///     `formula_refs[(Sheet2, B)]` is empty. Those rely on the
    ///     runtime fallback: `FormulaCache::Computing` short-circuits with
    ///     `Value::Error(ValueError::CyclicRef)`. See the
    ///     `cross_sheet_runtime_guard_returns_cycle_when_static_bypassed`
    ///     test for the contract.
    fn cross_sheet_cycle(&self, target_idx: usize, target: CellAddress, expr: &Expr) -> bool {
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut to_visit: Vec<(usize, CellAddress)> = Vec::new();
        // Seed with refs of the candidate expression. `collect_workbook_refs`
        // is retained for this candidate-only AST walk — the candidate's
        // edges aren't in `formula_refs` yet (we're deciding whether to
        // install them), so the only honest source is the parsed `expr`.
        //
        // Track J probe: bump the per-workbook counter so tests can verify
        // the AST walk runs ONCE per `cross_sheet_cycle` call (the
        // candidate), not N times (the pre-Track-J shape).
        self.cycle_ast_walk_count
            .set(self.cycle_ast_walk_count.get() + 1);
        collect_workbook_refs(expr, target_idx, &self.by_name, &mut to_visit);

        while let Some((idx, addr)) = to_visit.pop() {
            if idx == target_idx && addr == target {
                return true;
            }
            if !visited.insert((idx, addr)) {
                continue;
            }
            // Visited nodes' outgoing edges come from the forward index,
            // not a per-node AST walk. The index stores only cross-sheet
            // edges; same-sheet cycles threaded through visited nodes are
            // caught by `FormulaCache::Computing` at runtime.
            let Some(edges) = self.cross_sheet.formula_refs.get(&(idx, addr)) else {
                continue;
            };
            for edge in edges {
                match edge {
                    CrossSheetRef::Cell(src_sheet, src_addr) => {
                        to_visit.push((*src_sheet, *src_addr));
                    }
                    CrossSheetRef::Range(src_sheet, range) => {
                        // Expand a range edge to the formula cells that
                        // actually live inside the rectangle — same gating
                        // as `collect_formula_refs_into` in sheet.rs so
                        // `SUM(A:A)` doesn't enqueue u32::MAX entries.
                        let Some(sheet) = self.sheets.get(*src_sheet) else {
                            continue;
                        };
                        for cand_addr in sheet.formula_exprs_iter().keys() {
                            if range.contains(*cand_addr) {
                                to_visit.push((*src_sheet, *cand_addr));
                            }
                        }
                    }
                }
            }
        }
        false
    }

    /// Remove a sheet by index. Returns the removed sheet so callers can
    /// inspect / dispose of its atoms if needed.
    ///
    /// Clears the cross-sheet dep graph as a defensive measure — sheet
    /// removal shifts indices, and rewriting every `(idx, addr)` key on
    /// the fly is brittle. The next workbook-routed `set_formula` call
    /// will repopulate edges from the live formulas.
    pub fn remove_sheet(&mut self, idx: usize) -> Option<Sheet> {
        if self.is_inside_custom_call() {
            return None; // re-entrancy guard
        }
        if idx >= self.sheets.len() {
            return None;
        }
        let sheet = self.sheets.remove(idx);
        let name = self.names.remove(idx);
        self.by_name.remove(&name);
        self.rebuild_name_lookup();
        // Sheet indices shifted; the cross-sheet dep graph is no longer
        // coherent. Drop it. (Phase 3 callers don't currently mix
        // `remove_sheet` with cross-sheet subscriptions; if that changes,
        // a future iteration can rewrite each `(idx, addr)` in place
        // instead of clearing.)
        self.cross_sheet = CrossSheetDeps::new();
        Some(sheet)
    }

    /// Debug-only: total cross-sheet reverse-edge count. Backs the Phase
    /// 3 acceptance assertion that workbook-routed writes actually
    /// exercise the dep graph (vs. silently no-oping the way the pre-
    /// Track-I `Sheet::set_cell`-only path did).
    #[doc(hidden)]
    pub fn debug_cross_sheet_reverse_edge_count(&self) -> usize {
        self.cross_sheet.debug_reverse_edge_count()
    }

    /// Cheap "does any sheet in this workbook host a formula that
    /// references another sheet?" check. Used by
    /// `WorkbookEvalProvider::force_formula_recompute` to scope the
    /// read-time bypass: when no formula references another sheet, the
    /// bypass is unnecessary and every `wb.get_cell` read can hit
    /// `FormulaCache::Clean`. Single-sheet chains (the bench's Chain100
    /// etc.) take this fast path and only pay for full chain evaluation
    /// on the first read.
    ///
    /// Combines two signals:
    ///   1. `CrossSheetDeps::formula_refs` — registered by the workbook-
    ///      routed `Workbook::set_formula` / bulk-load paths.
    ///   2. Each sheet's `has_cross_sheet_refs` latch — set by the
    ///      per-sheet `Sheet::set_formula` flow regardless of whether
    ///      the workbook ever saw the install. This captures formulas
    ///      installed via the raw `wb.sheet_mut(idx).set_formula(...)`
    ///      bypass (which skips edge registration) and survives
    ///      `Workbook::remove_sheet` clearing `cross_sheet` — both cases
    ///      codex flagged as "force_recompute should still fire". The
    ///      latch is one-way (never cleared), so the bypass may stay
    ///      armed slightly longer than strictly necessary but never
    ///      under-fires.
    pub(crate) fn has_any_cross_sheet_edges(&self) -> bool {
        !self.cross_sheet.formula_refs.is_empty()
            || self.sheets.iter().any(|s| s.has_cross_sheet_refs())
    }

    /// Debug-only: per-workbook count of `collect_workbook_refs` AST walks
    /// performed by `cross_sheet_cycle`. Used by the Phase 3 Track J test
    /// to assert that visited-node edges come from
    /// `CrossSheetDeps::formula_refs` (one AST walk per `set_formula` —
    /// the candidate only) rather than the pre-Track-J shape (one AST
    /// walk per visited formula).
    #[doc(hidden)]
    pub fn debug_cycle_ast_walk_count(&self) -> usize {
        self.cycle_ast_walk_count.get()
    }

    /// Workbook-level bulk loader (Phase 3 Track I). Collects every
    /// `set_cell` / `set_formula` / `clear_cell` invocation inside the
    /// closure, suppresses per-write fanout, then at flush time:
    ///   1. Replays each sheet's writes inside `Sheet::bulk_load` (so
    ///      same-sheet dirty + same-sheet subscriber fanout fires AT
    ///      MOST ONCE per address within that sheet's flush).
    ///   2. Applies the accumulated `CrossSheetDeps` edge updates.
    ///   3. Runs one workbook-wide cross-sheet BFS starting at the union
    ///      of touched `(sheet, addr)` pairs, and notifies each cross-
    ///      sheet subscriber AT MOST ONCE.
    ///
    /// Use this for CSV / xlsx import paths that touch many cells across
    /// many sheets and where the per-write cross-sheet fanout cost would
    /// otherwise dominate.
    ///
    /// RAII shape mirrors `Sheet::bulk_load`: the loader is not exposed
    /// outside the closure, so the flush always runs.
    /// STORAGE_PRIMARY Phase 6.1: read the content revision counter
    /// (OD1). Bumped once per `install_sheet_bulk`; hosts compare
    /// successive values to detect whole-sheet replaces that bypass
    /// per-cell subscriber fanout.
    pub fn content_revision(&self) -> u64 {
        self.content_revision
    }

    /// Storage-primary bulk install: swap pre-built maps directly into
    /// the sheet. No per-cell calls, no parse, no dep extraction, no
    /// ops queue. Formulas hydrate lazily on first read (Phase 2+3
    /// machinery). This is a FULL-SHEET REPLACE — previous content
    /// (primitives, hydrated formulas, lazy parking, dep edges, spills,
    /// and this sheet's outgoing cross-sheet edges) is torn down first.
    ///
    /// Cross-sheet correctness without eager parse: after the swap, the
    /// formula sources are walked once with a cheap `!`-prefilter — a
    /// formula whose text contains no `!` cannot hold a cross-sheet ref
    /// (`Sheet2!A1`) and is skipped without parsing. Only the (rare)
    /// `!`-containing formulas are parsed to install their
    /// `CrossSheetDeps` edges so move_sheet / cross-sheet dirty
    /// propagation keep working before first read. False positives are
    /// acceptable: a `!` inside a string literal (e.g. `="hi!"`)
    /// triggers one wasted parse whose AST yields zero cross-sheet
    /// edges — a small perf cost, never a correctness issue. Phase 6.5
    /// moves this edge install into `hydrate_formula` entirely.
    ///
    /// Cross-sheet cycle detection for installed formulas is deferred
    /// to first read (hydration) — same semantic shift Phase 2+3 made
    /// for same-sheet cycles, accepted in the RFC.
    pub fn install_sheet_bulk(
        &mut self,
        sheet_idx: usize,
        primitives: HashMap<CellAddress, Value>,
        formulas: HashMap<CellAddress, String>,
    ) -> Result<BulkInstallStats, InstallError> {
        if self.is_inside_custom_call() {
            return Err(InstallError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(InstallError::SheetOutOfRange(sheet_idx));
        }

        // Tear down the sheet's previous outgoing cross-sheet edges —
        // every formula that owned them is about to be replaced.
        self.cross_sheet.remove_all_outgoing_for_sheet(sheet_idx);

        // The swap itself: three map installs on the sheet, no per-cell
        // ceremony (see `Sheet::bulk_install_storage` for the exact
        // cost model — primitives are O(n) plain storage writes because
        // they live behind atoms, formulas are O(n) text parks).
        let (primitives_installed, formulas_installed) =
            self.sheets[sheet_idx].bulk_install_storage(primitives, formulas);

        // `!`-prefilter cross-sheet edge scan (see method docs). Edges
        // are buffered because `for_each_lazy_formula` holds a shared
        // borrow of the sheet while `add_edge` needs `&mut
        // self.cross_sheet`.
        let mut cross_sheet_parsed: usize = 0;
        let mut edge_buf: Vec<(CellAddress, Vec<CrossSheetRef>)> = Vec::new();
        {
            let sheet = &self.sheets[sheet_idx];
            let by_name = &self.by_name;
            sheet.for_each_lazy_formula(|addr, source| {
                if !source.contains('!') {
                    // No `!` → cannot be a cross-sheet ref → skip the
                    // parse entirely. This is the overwhelmingly common
                    // same-sheet case.
                    return;
                }
                cross_sheet_parsed += 1;
                if let Some(expr) = parse_formula(source) {
                    let edges = collect_cross_sheet_refs(&expr, by_name);
                    if !edges.is_empty() {
                        edge_buf.push((addr, edges));
                    }
                }
            });
        }
        if !edge_buf.is_empty() {
            // Arm the sheet's one-way cross-sheet latch so the read-time
            // `force_formula_recompute` safety net covers these formulas
            // even before their first hydration.
            self.sheets[sheet_idx].arm_cross_sheet_latch();
        }
        for (addr, edges) in edge_buf {
            for edge in edges {
                self.cross_sheet.add_edge(sheet_idx, addr, edge);
            }
        }

        // OD1: bump the revision so subscribers / projections know the
        // world changed without per-cell notifications.
        self.content_revision += 1;

        Ok(BulkInstallStats {
            primitives_installed,
            formulas_installed,
            cross_sheet_parsed,
        })
    }

    /// Whole-workbook variant of [`Self::install_sheet_bulk`] (OD2):
    /// one call installs every sheet's pre-built maps. Sheet indexes
    /// are validated up front so the call is all-or-nothing — no
    /// partial install when a later entry is out of range. The
    /// per-SHEET loop here is fine (sheet counts are small); the
    /// per-CELL loop is what the storage-primary refactor kills.
    pub fn install_workbook_bulk(
        &mut self,
        payload: Vec<(
            usize,
            HashMap<CellAddress, Value>,
            HashMap<CellAddress, String>,
        )>,
    ) -> Result<Vec<BulkInstallStats>, InstallError> {
        if self.is_inside_custom_call() {
            return Err(InstallError::MutationDuringCustomCall);
        }
        for (sheet_idx, _, _) in &payload {
            if *sheet_idx >= self.sheets.len() {
                return Err(InstallError::SheetOutOfRange(*sheet_idx));
            }
        }
        payload
            .into_iter()
            .map(|(sheet_idx, primitives, formulas)| {
                self.install_sheet_bulk(sheet_idx, primitives, formulas)
            })
            .collect()
    }

    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut WorkbookLoader<'_>) -> R) -> R {
        // Re-entrancy guard for Wave 8 custom-formula callbacks. We can't
        // refuse cleanly without breaking the signature, so we still let
        // the loader run — but we plumb the guard through to
        // `WorkbookLoader` so each buffered write checks the depth at
        // entry-into-this-API time (NOT at flush time, which always runs
        // in a clean frame). Practically: a custom callback that calls
        // `wb.bulk_load(|l| { l.set_cell(...); })` finds the loader's
        // `set_cell` calls becoming no-ops via the same guard the direct
        // `Workbook::set_cell` honors.
        let mut loader = WorkbookLoader::new(self);
        let result = f(&mut loader);
        loader.flush();
        result
    }
}

/// Buffered op recorded by `WorkbookLoader`. Replayed at `flush` time
/// inside `Sheet::bulk_load`. The owning sheet is the HashMap key in
/// `ops_by_sheet`, so individual variants don't repeat `sheet_idx`.
enum WorkbookOp {
    SetCell {
        addr_str: String,
        value: Value,
    },
    /// `expr` is `Some` when the workbook-side parse succeeded — the
    /// sheet-side flush installs directly without re-parsing. `None`
    /// covers the parse-failure path: the sheet's `set_formula` sees a
    /// malformed string, writes `#VALUE!`, and never touches the AST.
    /// Eliminating the double-parse was the dominant constant-factor
    /// win for the wasm32 Chain100k bulkWrite tier — `parse_formula`
    /// allocates a `Vec<char>` per source character plus boxed nodes
    /// for every binop / cellref, and was running twice per formula
    /// (workbook + sheet) before this variant.
    SetFormula {
        addr_str: String,
        source: String,
        expr: Option<Expr>,
    },
    ClearCell {
        addr_str: String,
    },
}

/// In-progress workbook bulk-load session. Buffers operations until
/// `flush` runs at the end of `Workbook::bulk_load`. Inside the closure
/// callers see synchronous returns from `set_formula` (parse / cycle
/// outcome decided here at queue time) but no subscriber fires and no
/// dirty fanout — all of that runs in one consolidated `flush`.
pub struct WorkbookLoader<'a> {
    wb: &'a mut Workbook,
    /// Per-sheet ordered op queues so the replay inside each sheet's
    /// `Sheet::bulk_load` preserves the caller's order.
    ops_by_sheet: HashMap<usize, Vec<WorkbookOp>>,
    /// Union of every `(sheet, addr)` that was written during the
    /// session (across all sheets). The post-flush cross-sheet BFS
    /// seeds from this set.
    touched: HashSet<(usize, CellAddress)>,
}

impl<'a> WorkbookLoader<'a> {
    fn new(wb: &'a mut Workbook) -> Self {
        WorkbookLoader {
            wb,
            ops_by_sheet: HashMap::new(),
            touched: HashSet::new(),
        }
    }

    /// Queue a primitive write at `(sheet_idx, addr)`. Visible to the
    /// post-flush workbook BFS as a touched cell.
    pub fn set_cell(&mut self, sheet_idx: usize, addr_str: &str, value: Value) {
        if self.wb.is_inside_custom_call() {
            return; // re-entrancy guard (Wave 8)
        }
        if sheet_idx >= self.wb.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.touched.insert((sheet_idx, addr));
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::SetCell {
                addr_str: addr_str.to_string(),
                value,
            });
    }

    /// Queue a formula write at `(sheet_idx, addr)`. Returns `false` if
    /// either the text fails to parse OR the cross-sheet static cycle
    /// check rejects it. Cross-sheet edges are installed eagerly so
    /// later ops in the same `bulk_load` see the up-to-date dep graph
    /// (e.g. for subsequent cycle checks); same-sheet wiring runs
    /// inside the per-sheet `Sheet::bulk_load` replay at flush time.
    pub fn set_formula(&mut self, sheet_idx: usize, addr_str: &str, source: &str) -> bool {
        if self.wb.is_inside_custom_call() {
            return false; // re-entrancy guard (Wave 8)
        }
        if sheet_idx >= self.wb.sheets.len() {
            return false;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return false;
        };

        // Parse first. Parse failure still records a SetFormula op so
        // the sheet flush writes `#VALUE!` for us; cross-sheet edge
        // install is skipped on this branch.
        let Some(expr) = parse_formula(source) else {
            self.touched.insert((sheet_idx, addr));
            // Tear down any previous cross-sheet edges this addr owned
            // — a #VALUE! cell has no outgoing deps.
            self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
            self.ops_by_sheet
                .entry(sheet_idx)
                .or_default()
                .push(WorkbookOp::SetFormula {
                    addr_str: addr_str.to_string(),
                    source: source.to_string(),
                    expr: None,
                });
            return false;
        };

        // Cross-sheet static cycle check. Use the existing pre-Track-J
        // path (`collect_workbook_refs` + BFS through `formula_exprs_iter`)
        // — that map is populated only after the per-sheet flush runs,
        // so cycles introduced WITHIN the bulk_load against another
        // bulk-loaded formula slip past this check. That matches the
        // pre-Track-I `Sheet::bulk_load` behavior (its `would_create_
        // cycle` only sees already-installed formulas, not pending
        // ones); the static check still catches cycles against any
        // formula that existed before the bulk_load started.
        if self.wb.cross_sheet_cycle(sheet_idx, addr, &expr) {
            self.touched.insert((sheet_idx, addr));
            self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
            // Follow-up `SetCell` writes the `#CYCLE!` error after the
            // sheet bulk_load lands the formula (which the sheet's own
            // bulk_load may or may not have flagged as a cycle on its
            // own — workbook-level cycles can slip past the per-sheet
            // check). The final SetCell op guarantees the cell holds
            // `Value::Error(CyclicRef)` once flush completes.
            self.ops_by_sheet
                .entry(sheet_idx)
                .or_default()
                .push(WorkbookOp::SetCell {
                    addr_str: addr_str.to_string(),
                    value: Value::Error(ValueError::CyclicRef),
                });
            return false;
        }

        // Install fresh outgoing edges into CrossSheetDeps. Old edges
        // (if any) are removed first; the new edges go in eagerly so
        // subsequent `set_formula` calls in the same `bulk_load` see
        // the up-to-date forward map for their own cycle checks.
        self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
        let new_edges = collect_cross_sheet_refs(&expr, &self.wb.by_name);
        for edge in new_edges {
            self.wb.cross_sheet.add_edge(sheet_idx, addr, edge);
        }

        self.touched.insert((sheet_idx, addr));
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::SetFormula {
                addr_str: addr_str.to_string(),
                source: source.to_string(),
                expr: Some(expr),
            });

        true
    }

    /// Queue a clear (=write to Null) at `(sheet_idx, addr)`.
    pub fn clear_cell(&mut self, sheet_idx: usize, addr_str: &str) {
        if self.wb.is_inside_custom_call() {
            return; // re-entrancy guard (Wave 8)
        }
        if sheet_idx >= self.wb.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.touched.insert((sheet_idx, addr));
        self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::ClearCell {
                addr_str: addr_str.to_string(),
            });
    }

    /// Replay queued ops sheet-by-sheet inside each sheet's
    /// `Sheet::bulk_load` (so same-sheet subscribers fire at most once
    /// per address per flush), then run one workbook-wide cross-sheet
    /// BFS that fires each cross-sheet subscriber at most once.
    fn flush(self) {
        let WorkbookLoader {
            wb,
            ops_by_sheet,
            touched,
        } = self;

        // 1. Per-sheet replay inside the existing `Sheet::bulk_load`
        //    plumbing. This handles same-sheet dirty/fire dedup.
        for (sheet_idx, ops) in ops_by_sheet {
            let Some(sheet) = wb.sheets.get_mut(sheet_idx) else {
                continue;
            };
            // Pre-grow the per-sheet formula HashMaps to the known
            // batch size. Saves ~log2(N) rehashes during the replay
            // loop below (each rehash is O(current entries), so they
            // amortize to ~2× the final size in wasted copies on a
            // cold start).
            sheet.reserve_for_bulk_install(ops.len());
            sheet.bulk_load(|loader| {
                for op in ops {
                    match op {
                        WorkbookOp::SetCell { addr_str, value } => {
                            loader.set_cell(&addr_str, value);
                        }
                        WorkbookOp::SetFormula {
                            addr_str,
                            source,
                            expr,
                        } => {
                            // Hand the pre-parsed AST through when we
                            // have one — skips the sheet-loader's
                            // re-parse (the same AST was just produced
                            // by the workbook-side cycle check).
                            //
                            // `expr=None` is the parse-failure path:
                            // the source was unparseable on the
                            // workbook side too, so route through the
                            // string form and let the sheet writer
                            // produce `#VALUE!` via its own parse-fail
                            // arm (consistency: same `#VALUE!` error
                            // payload either way).
                            //
                            // Cross-sheet cycle was already handled by
                            // the `set_formula` queue path inserting a
                            // follow-up `SetCell` to override with
                            // `Value::Error(CyclicRef)`.
                            match expr {
                                Some(expr) => {
                                    // Move `source` so the sheet loader
                                    // stores the original allocation
                                    // instead of cloning.
                                    loader.set_formula_pre_parsed(&addr_str, expr, source);
                                }
                                None => {
                                    loader.set_formula(&addr_str, &source);
                                }
                            }
                        }
                        WorkbookOp::ClearCell { addr_str } => {
                            loader.set_cell(&addr_str, Value::Null);
                        }
                    }
                }
            });
        }

        // 2. Workbook-wide cross-sheet BFS. Seed with the entire touched
        //    set so EVERY source write contributes to the dirty fanout.
        //    Within-sheet dependents already fired in step 1; this pass
        //    is strictly for cross-sheet edges.
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut queue: VecDeque<(usize, CellAddress)> = VecDeque::new();
        for entry in &touched {
            queue.push_back(*entry);
            visited.insert(*entry);
        }
        while let Some((sheet_idx, addr)) = queue.pop_front() {
            // Reverse dependents from the workbook graph (same shape
            // as `propagate_cross_sheet_dirty`'s inner loop). Visited
            // dedups so each cross-sheet subscriber fires at most once
            // across the entire bulk_load.
            let mut dependents: Vec<(usize, CellAddress)> = Vec::new();
            if let Some(set) = wb.cross_sheet.cell_dependents.get(&(sheet_idx, addr)) {
                dependents.extend(set.iter().copied());
            }
            if let Some(range_idx) = wb.cross_sheet.range_index_per_sheet.get(&sheet_idx) {
                for target_addr in range_idx.dependents_of(addr) {
                    for target_sheet in wb.target_sheets_for_range_dep(target_addr, sheet_idx, addr)
                    {
                        dependents.push((target_sheet, target_addr));
                    }
                }
            }
            for (target_sheet, target_addr) in dependents {
                if !visited.insert((target_sheet, target_addr)) {
                    continue;
                }
                if let Some(sheet) = wb.sheets.get(target_sheet) {
                    sheet.mark_dirty_for_addr(target_addr);
                    sheet.fire_subscribers(target_addr);
                }
                queue.push_back((target_sheet, target_addr));
            }
        }
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

/// Walk an AST and emit every cross-sheet (NOT same-sheet) outgoing
/// edge as a `CrossSheetRef`. Used by `Workbook::set_formula` to seed
/// the reverse maps inside `CrossSheetDeps`.
///
/// Same-sheet refs (`CellRef`, `Range` with no sheet qualifier) are
/// deliberately skipped — those are owned by `Sheet::set_formula`'s
/// own `cell_dependents` / `range_dependents` insert paths and would
/// double-fire if duplicated here.
/// Does `expr` contain anything that requires workbook scope to
/// evaluate correctly? Two surface points qualify:
///   1. `Expr::Name(_)` — could resolve via the workbook's defined-name
///      registry (when no LET binding shadows it).
///   2. `Expr::FuncCall { name, .. }` whose `name` is not a built-in —
///      could resolve via the registry as a callable lambda.
///   3. `Expr::SheetRef` / `Expr::SheetRange` — cross-sheet refs.
///
/// Used by `Workbook::set_formula` to skip the second-pass workbook-
/// aware spill recompute when the formula is purely sheet-local +
/// uses only built-in functions (the dominant case). Without the
/// gate, every `set_formula` on an array-producing formula would eval
/// the formula twice; with it, the extra pass only fires for the
/// minority of formulas that actually depend on workbook scope.
fn formula_needs_workbook_context(expr: &Expr) -> bool {
    match expr {
        Expr::Name(_) | Expr::SheetRef { .. } | Expr::SheetRange { .. } => true,
        Expr::FuncCall { name, args } => {
            // A registered (non-builtin) name in function position is
            // the lambda-call case. Built-ins are recognized via the
            // eval crate's dispatch list so the gate stays in sync
            // with the eval loop's resolution order.
            if !is_builtin_function_name(name) {
                return true;
            }
            args.iter().any(formula_needs_workbook_context)
        }
        Expr::BinOp { left, right, .. } => {
            formula_needs_workbook_context(left) || formula_needs_workbook_context(right)
        }
        Expr::Negate(inner) => formula_needs_workbook_context(inner),
        Expr::Call(callee, args) => {
            formula_needs_workbook_context(callee)
                || args.iter().any(formula_needs_workbook_context)
        }
        Expr::SpillRef(anchor) => formula_needs_workbook_context(anchor),
        Expr::DynamicRange { start, end } => {
            formula_needs_workbook_context(start) || formula_needs_workbook_context(end)
        }
        Expr::Number(_)
        | Expr::Text(_)
        | Expr::Bool(_)
        | Expr::Error(_)
        | Expr::CellRef(_)
        | Expr::Range { .. } => false,
        Expr::ArrayLit { data, .. } => data.iter().any(formula_needs_workbook_context),
        // Multi-area: a cross-sheet ref inside the union still demands
        // workbook context. Same-sheet-only unions stay sheet-local.
        Expr::MultiArea(parts) => parts.iter().any(formula_needs_workbook_context),
    }
}

/// Recursive AST walk: does `expr` reference the defined name `key`
/// anywhere? `key` is the uppercased form; comparisons are
/// case-insensitive (Excel parity — `=Foo` and `=FOO` resolve the same
/// way). Returns `true` if the name appears as either a bare
/// `Expr::Name` or as the target of an `Expr::FuncCall` (the two
/// surface points where the eval loop consults the registry).
///
/// Used by `Workbook::invalidate_formulas_using_name` to flip cached
/// formulas dirty when the named entry is added / replaced / removed.
fn formula_references_name(expr: &Expr, key: &str) -> bool {
    match expr {
        Expr::Name(n) => n.eq_ignore_ascii_case(key),
        Expr::FuncCall { name, args } => {
            if name.eq_ignore_ascii_case(key) {
                return true;
            }
            args.iter().any(|a| formula_references_name(a, key))
        }
        Expr::BinOp { left, right, .. } => {
            formula_references_name(left, key) || formula_references_name(right, key)
        }
        Expr::Negate(inner) => formula_references_name(inner, key),
        Expr::Call(callee, args) => {
            formula_references_name(callee, key)
                || args.iter().any(|a| formula_references_name(a, key))
        }
        Expr::SpillRef(anchor) => formula_references_name(anchor, key),
        Expr::DynamicRange { start, end } => {
            formula_references_name(start, key) || formula_references_name(end, key)
        }
        Expr::Number(_)
        | Expr::Text(_)
        | Expr::Bool(_)
        | Expr::Error(_)
        | Expr::CellRef(_)
        | Expr::Range { .. }
        | Expr::SheetRef { .. }
        | Expr::SheetRange { .. } => false,
        Expr::ArrayLit { data, .. } => data.iter().any(|e| formula_references_name(e, key)),
        // Multi-area parts are themselves refs (CellRef / Range /
        // SheetRef / SheetRange), so none of them can reference a
        // defined name. Kept as an explicit `false` for clarity.
        Expr::MultiArea(_) => false,
    }
}

fn collect_cross_sheet_refs(expr: &Expr, by_name: &HashMap<String, usize>) -> Vec<CrossSheetRef> {
    let mut out: Vec<CrossSheetRef> = Vec::new();
    collect_cross_sheet_refs_into(expr, by_name, &mut out);
    out
}

fn collect_cross_sheet_refs_into(
    expr: &Expr,
    by_name: &HashMap<String, usize>,
    out: &mut Vec<CrossSheetRef>,
) {
    match expr {
        Expr::CellRef(_) | Expr::Range { .. } => {
            // Same-sheet refs/ranges are owned by `Sheet::set_formula`.
        }
        Expr::SpillRef(anchor) => collect_cross_sheet_refs_into(anchor, by_name, out),
        Expr::DynamicRange { start, end } => {
            collect_cross_sheet_refs_into(start, by_name, out);
            collect_cross_sheet_refs_into(end, by_name, out);
        }
        Expr::SheetRef { sheet, addr } => {
            if let Some(&idx) = by_name.get(sheet) {
                out.push(CrossSheetRef::Cell(idx, *addr));
            }
            // Unknown sheet → dropped. Read time will surface #REF!.
        }
        Expr::SheetRange {
            sheet, start, end, ..
        } => {
            if let Some(&idx) = by_name.get(sheet) {
                out.push(CrossSheetRef::Range(
                    idx,
                    CellRange::new(*start, *end).normalize(),
                ));
            }
            // Unknown sheet → dropped. Read time will surface #REF!.
        }
        Expr::BinOp { left, right, .. } => {
            collect_cross_sheet_refs_into(left, by_name, out);
            collect_cross_sheet_refs_into(right, by_name, out);
        }
        Expr::Negate(inner) => collect_cross_sheet_refs_into(inner, by_name, out),
        Expr::FuncCall { args, .. } => {
            for a in args {
                collect_cross_sheet_refs_into(a, by_name, out);
            }
        }
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => {}
        // LET-bound names don't reference cross-sheet cells.
        Expr::Name(_) => {}
        // Immediate-call: descend into callee + args so cross-sheet refs
        // hidden inside a LAMBDA body still register.
        Expr::Call(callee, args) => {
            collect_cross_sheet_refs_into(callee, by_name, out);
            for a in args {
                collect_cross_sheet_refs_into(a, by_name, out);
            }
        }
        // Constant-array literal can't carry a cross-sheet ref (parser
        // rejected SheetRef / SheetRange inside `{...}`).
        Expr::ArrayLit { .. } => {}
        // Multi-area: descend into every inner ref so cross-sheet refs
        // inside the union register against `by_name`.
        Expr::MultiArea(parts) => {
            for p in parts {
                collect_cross_sheet_refs_into(p, by_name, out);
            }
        }
    }
}

/// Walk an AST and append every (sheet_idx, addr) it directly references
/// onto `out`. `current_idx` is the sheet the AST lives on (used for
/// `CellRef` / `Range`). `SheetRef` arms resolve their sheet name through
/// `by_name`; unknown sheet names are dropped (eval-time will return
/// `#REF!`, which doesn't form a cycle).
///
/// **Phase 3 Track J**: used exclusively for the CANDIDATE expression
/// inside `Workbook::cross_sheet_cycle`. Visited (already-installed)
/// formulas pull their edges from `CrossSheetDeps::formula_refs` instead
/// — that's the whole point of the forward index, and avoids re-walking
/// each visited formula's AST. Kept free so it doesn't borrow `self`.
/// Range expansion is naive (every cell in the rectangle) because the
/// seed list feeds into a BFS that gates on dep-graph membership, so
/// large empty ranges only cost `Vec` pushes here, not unbounded
/// recursion.
fn collect_workbook_refs(
    expr: &Expr,
    current_idx: usize,
    by_name: &HashMap<String, usize>,
    out: &mut Vec<(usize, CellAddress)>,
) {
    match expr {
        Expr::CellRef(addr) => out.push((current_idx, *addr)),
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            // Unbounded ranges aren't expanded — the cross-sheet cycle BFS
            // gates on `formula_exprs` membership per-sheet, and an
            // unbounded enumeration here would push the entire coordinate
            // space (u32::MAX entries). Cross-sheet cycles involving an
            // unbounded range stay detectable through the in-sheet
            // range_dependents path, which is consulted at dirty
            // propagation time.
            if !matches!(unbounded, RangeBounds::None) {
                return;
            }
            let min_row = start.row.min(end.row);
            let max_row = start.row.max(end.row);
            let min_col = start.col.min(end.col);
            let max_col = start.col.max(end.col);
            for row in min_row..=max_row {
                for col in min_col..=max_col {
                    out.push((current_idx, CellAddress::new(row, col)));
                }
            }
        }
        Expr::BinOp { left, right, .. } => {
            collect_workbook_refs(left, current_idx, by_name, out);
            collect_workbook_refs(right, current_idx, by_name, out);
        }
        Expr::Negate(inner) => collect_workbook_refs(inner, current_idx, by_name, out),
        Expr::FuncCall { args, .. } => {
            for a in args {
                collect_workbook_refs(a, current_idx, by_name, out);
            }
        }
        Expr::SheetRef { sheet, addr } => {
            if let Some(&idx) = by_name.get(sheet) {
                out.push((idx, *addr));
            }
            // Unknown sheet name → dropped. Eval will surface #REF! at read
            // time; doesn't participate in cycles.
        }
        Expr::SheetRange {
            sheet,
            start,
            end,
            unbounded,
        } => {
            let Some(&idx) = by_name.get(sheet) else {
                return;
            };
            if !matches!(unbounded, RangeBounds::None) {
                return;
            }
            let min_row = start.row.min(end.row);
            let max_row = start.row.max(end.row);
            let min_col = start.col.min(end.col);
            let max_col = start.col.max(end.col);
            for row in min_row..=max_row {
                for col in min_col..=max_col {
                    out.push((idx, CellAddress::new(row, col)));
                }
            }
        }
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => {}
        // LET-bound names don't reference cells in the cross-sheet graph.
        Expr::Name(_) => {}
        Expr::SpillRef(anchor) => collect_workbook_refs(anchor, current_idx, by_name, out),
        Expr::DynamicRange { start, end } => {
            collect_workbook_refs(start, current_idx, by_name, out);
            collect_workbook_refs(end, current_idx, by_name, out);
        }
        // Immediate-call: descend into callee + args.
        Expr::Call(callee, args) => {
            collect_workbook_refs(callee, current_idx, by_name, out);
            for a in args {
                collect_workbook_refs(a, current_idx, by_name, out);
            }
        }
        // Constant-array literal carries no cell or sheet references.
        Expr::ArrayLit { .. } => {}
        // Multi-area: descend into every inner ref so workbook-level
        // BFS sees every cell mentioned in the union.
        Expr::MultiArea(parts) => {
            for p in parts {
                collect_workbook_refs(p, current_idx, by_name, out);
            }
        }
    }
}

struct WorkbookEvalProvider<'a> {
    wb: &'a Workbook,
    current: Cell<usize>,
    /// Cell currently being evaluated. Mirrors `SheetEvalProvider`: pushed
    /// by `Sheet::eval_formula_at_with_provider` via `set_current_cell` so
    /// `ROW()` / `COLUMN()` no-arg calls can return the formula's own
    /// row/column even when eval crosses sheets.
    current_cell: Cell<Option<CellAddress>>,
}

impl<'a> WorkbookEvalProvider<'a> {
    fn with_current<T>(&self, idx: usize, f: impl FnOnce() -> T) -> T {
        struct CurrentGuard<'a> {
            current: &'a Cell<usize>,
            prev: usize,
        }
        impl Drop for CurrentGuard<'_> {
            fn drop(&mut self) {
                self.current.set(self.prev);
            }
        }

        let prev = self.current.replace(idx);
        let _guard = CurrentGuard {
            current: &self.current,
            prev,
        };
        f()
    }
}

impl<'a> EvalProvider for WorkbookEvalProvider<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        let idx = self.current.get();
        crate::sheet::collapse_array_for_eval(
            self.wb.sheets[idx].peek_value_with_provider(addr, self),
        )
    }

    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return Value::Error(ValueError::InvalidRef);
        };
        self.with_current(idx, || {
            crate::sheet::collapse_array_for_eval(
                self.wb.sheets[idx].peek_value_with_provider(addr, self),
            )
        })
    }

    fn raw_cell(&self, addr: CellAddress) -> Value {
        let idx = self.current.get();
        self.wb.sheets[idx].peek_value_with_provider(addr, self)
    }

    fn raw_sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return Value::Error(ValueError::InvalidRef);
        };
        self.with_current(idx, || {
            self.wb.sheets[idx].peek_value_with_provider(addr, self)
        })
    }

    fn force_formula_recompute(&self) -> bool {
        // Safety net for the "raw" `wb.sheet_mut(idx).set_cell(...)` path,
        // which bypasses cross-sheet dirty fanout (see
        // `raw_sheet_write_does_not_fire_cross_sheet_subscriber`). When the
        // workbook has zero cross-sheet state, no formula can have a stale
        // cross-sheet cache, so the bypass is unnecessary and every
        // `wb.get_cell` read can hit `FormulaCache::Clean`. This is the
        // common case for single-sheet workbooks (the chain perf bench's
        // Chain100/1k/10k/100k all live on Sheet1 only) and turns the
        // steady-state read from O(formulas) re-evals into O(1).
        //
        // `has_any_cross_sheet_edges` ORs the registered-edge map with
        // each sheet's `has_cross_sheet_refs` latch, so the bypass also
        // stays armed when a formula is installed via the raw
        // `wb.sheet_mut(idx).set_formula(...)` path (which skips edge
        // registration) — without that OR, codex's repro
        // (`raw_path_cross_sheet_recompute_stays_correct`) leaked the
        // stale cached value.
        self.wb.has_any_cross_sheet_edges()
    }

    /// Sparse override for the workbook context. Routes the formula-cell
    /// read through `peek_value_with_provider` so cross-sheet references
    /// inside formulas in the iterated range can still resolve through
    /// the workbook chain (the single-sheet `peek_value` would return
    /// `#REF!` for `Sheet2!A1`).
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
        let idx = self.current.get();
        let sheet = &self.wb.sheets[idx];
        sheet.for_each_sparse_cell_with(
            range,
            &|sheet, addr| {
                crate::sheet::collapse_array_for_eval(sheet.peek_value_with_provider(addr, self))
            },
            f,
        );
    }

    fn for_each_sheet_range_cell(
        &self,
        sheet: &str,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            f(
                range.normalize().start,
                Value::Error(ValueError::InvalidRef),
            );
            return;
        };
        self.with_current(idx, || {
            let target_sheet = &self.wb.sheets[idx];
            target_sheet.for_each_sparse_cell_with(
                range,
                &|sheet, addr| {
                    crate::sheet::collapse_array_for_eval(
                        sheet.peek_value_with_provider(addr, self),
                    )
                },
                f,
            );
        });
    }

    fn current_cell(&self) -> Option<CellAddress> {
        self.current_cell.get()
    }

    fn set_current_cell(&self, addr: Option<CellAddress>) {
        self.current_cell.set(addr);
    }

    fn lookup_named(&self, name: &str) -> Option<Value> {
        // Delegate to the workbook's case-insensitive registry. Returns
        // a clone of the stored value (cheap for `Value::Lambda`, which
        // wraps an `Arc<dyn LambdaValue>`; constant-time for scalars).
        self.wb.get_named(name)
    }

    fn cell_has_formula(&self, addr: CellAddress) -> bool {
        let idx = self.current.get();
        self.wb
            .sheets
            .get(idx)
            .map(|s| s.has_formula_at(addr))
            .unwrap_or(false)
    }

    fn sheet_cell_has_formula(&self, sheet: &str, addr: CellAddress) -> bool {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return false;
        };
        self.wb
            .sheets
            .get(idx)
            .map(|s| s.has_formula_at(addr))
            .unwrap_or(false)
    }

    /// FORMULATEXT hook for the workbook context. Looks up the source
    /// formula in the *current* sheet's text store. Returns `None` when
    /// the cell holds a primitive — the FORMULATEXT arm then surfaces
    /// `#N/A`.
    fn cell_formula_text(&self, addr: CellAddress) -> Option<String> {
        let idx = self.current.get();
        let sheet = self.wb.sheets.get(idx)?;
        sheet.formula_text_at(addr)
    }

    /// Cross-sheet variant: resolve the sheet by name first.
    fn sheet_cell_formula_text(&self, sheet: &str, addr: CellAddress) -> Option<String> {
        let idx = self.wb.by_name.get(sheet).copied()?;
        let target = self.wb.sheets.get(idx)?;
        target.formula_text_at(addr)
    }

    fn current_sheet_index(&self) -> Option<usize> {
        Some(self.current.get())
    }

    fn sheet_index_of(&self, name: &str) -> Option<usize> {
        self.wb.by_name.get(name).copied()
    }

    fn sheet_count(&self) -> usize {
        self.wb.sheets.len()
    }

    /// Wave 8 host custom-formula dispatch. Consult the workbook's
    /// registry handle if one was installed via
    /// `Workbook::set_custom_function_registry`; otherwise the
    /// `EvalProvider` default `None` keeps the legacy `#NAME?`
    /// fallthrough.
    ///
    /// Brackets the JS callback in a `CustomCallScope` so the workbook's
    /// re-entrancy depth counter ticks for the duration. Any mutation
    /// the callback attempts via `wb.set_cell(...)` / `wb.set_formula
    /// (...)` / etc. is rejected via the per-entry-point
    /// `is_inside_custom_call` guard. The scope's `Drop` impl is
    /// exception-safe (matches the wasm-bindgen `throw_str` path).
    fn call_custom(&self, name: &str, args: &[Value]) -> Option<Value> {
        let registry = self.wb.custom_functions.as_ref()?;
        let _scope = CustomCallScope::enter(self.wb.custom_call_depth_cell());
        registry.lookup(name, args)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;
    use einfach_core::ValueError;

    #[test]
    fn default_workbook_has_sheet1() {
        let wb = Workbook::new();
        assert_eq!(wb.sheet_count(), 1);
        assert_eq!(wb.name(0), Some("Sheet1"));
    }

    /// `WorkbookEvalProvider::current_cell()` round-trips whatever
    /// `set_current_cell` was last called with. The `Sheet` eval loop drives
    /// this via a save/restore guard around each formula's eval call so
    /// `ROW()` / `COLUMN()` can read the formula's own address.
    #[test]
    fn workbook_provider_current_cell_round_trip() {
        let wb = Workbook::new();
        let provider = WorkbookEvalProvider {
            wb: &wb,
            current: Cell::new(0),
            current_cell: Cell::new(None),
        };
        assert_eq!(provider.current_cell(), None);
        let addr = CellAddress::new(2, 1); // B3 in 0-indexed (row=2, col=1)
        provider.set_current_cell(Some(addr));
        assert_eq!(provider.current_cell(), Some(addr));
        provider.set_current_cell(None);
        assert_eq!(provider.current_cell(), None);
    }

    #[test]
    fn add_named_sheet() {
        let mut wb = Workbook::new();
        let idx = wb.add_sheet("Data");
        assert_eq!(idx, 1);
        assert_eq!(wb.index_of("Data"), Some(1));
    }

    #[test]
    fn sparse_range_read_uses_workbook_provider_for_formulas() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        wb.set_cell(data_idx, "A1", Value::Number(41.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1+1"));

        let mut got = Vec::new();
        wb.for_each_sparse_range_cell(
            0,
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(0, 2)),
            |addr, value| got.push((addr.to_string(), value)),
        );

        assert_eq!(got, vec![("B1".to_string(), Value::Number(42.0))]);
    }

    #[test]
    fn clear_range_scans_sparse_and_dirties_cross_sheet_dependents() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        wb.set_cell(data_idx, "A1", Value::Number(41.0));
        wb.set_cell(data_idx, "C3", Value::Number(99.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1+1"));

        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(42.0));
        assert_eq!(wb.debug_formula_cache_state(0, "B1"), "clean");

        let cleared = wb.clear_range(
            data_idx,
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(1, 1)),
        );

        assert_eq!(cleared, 1);
        assert_eq!(wb.debug_formula_cache_state(0, "B1"), "dirty");
        assert_eq!(wb.sheet(data_idx).unwrap().non_empty_addrs(), vec!["C3"]);
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));
    }

    #[test]
    fn add_existing_returns_existing_index() {
        let mut wb = Workbook::new();
        let a = wb.add_sheet("X");
        let b = wb.add_sheet("X");
        assert_eq!(a, b);
        assert_eq!(wb.sheet_count(), 2); // Sheet1 + X
    }

    #[test]
    fn rename_updates_lookup() {
        let mut wb = Workbook::new();
        wb.add_sheet("Old");
        assert!(wb.rename_sheet(1, "New"));
        assert_eq!(wb.index_of("Old"), None);
        assert_eq!(wb.index_of("New"), Some(1));
    }

    #[test]
    fn rename_to_taken_fails() {
        let mut wb = Workbook::new();
        wb.add_sheet("A");
        wb.add_sheet("B");
        assert!(!wb.rename_sheet(2, "A"));
    }

    #[test]
    fn cross_sheet_read_resolves_through_workbook() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        // Sheet1 = wb.sheet_mut(0)
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(10.0));
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(99.0));

        // Cross-sheet read via Workbook
        assert_eq!(wb.get_cell("Data", "A1"), Value::Number(99.0));
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(10.0));
        // Unknown sheet → Null
        assert_eq!(wb.get_cell("Nope", "A1"), Value::Null);
    }

    #[test]
    fn cross_sheet_formula_evaluates() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(50.0));
        // Sheet1!B1 = =Data!A1 * 2 — formula sits on Sheet1 but reads Data.
        // Install via the workbook API so the cross-sheet edge gets
        // registered (the raw `sheet_mut().set_formula` path skips that
        // registration and relies on the read-time `force_formula_recompute`
        // safety net; canonical hosts always go through the workbook).
        assert!(wb.set_formula(0, "B1", "=Data!A1*2"));

        // wb.get_cell evaluates through WorkbookEvalProvider.
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(100.0));

        // Updating the cross-sheet source and re-reading should see the
        // new value (no manual invalidation step needed).
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(7.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
    }

    #[test]
    fn current_sheet_qualified_ref_resolves_like_same_sheet_ref() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(3.0));
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(7.0));
        wb.sheet_mut(0)
            .unwrap()
            .set_formula("B1", "=Sheet1!A1+Data!A1");

        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
    }

    #[test]
    fn current_sheet_qualified_self_ref_returns_cycle_error() {
        let mut wb = Workbook::new();
        wb.sheet_mut(0).unwrap().set_formula("A1", "=Sheet1!A1");

        assert_eq!(
            wb.get_cell("Sheet1", "A1"),
            Value::Error(ValueError::CyclicRef)
        );
    }

    #[test]
    fn workbook_get_cell_refreshes_cross_sheet_cache_without_notifying() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        wb.sheet_mut(0).unwrap().set_formula("B1", "=Data!A1*2");

        let changes = Rc::new(RefCell::new(0u32));
        let changes_clone = changes.clone();
        wb.sheet_mut(0).unwrap().subscribe_cell("B1", move || {
            *changes_clone.borrow_mut() += 1;
        });

        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
        assert_eq!(*changes.borrow(), 0);
    }

    #[test]
    fn workbook_get_cell_only_recomputes_formulas_on_target_dep_chain() {
        // Build a sheet with two independent cross-sheet formula chains:
        //   B1 = =Data!A1 * 2   (chain A — what we'll read)
        //   D1 = =Data!A1 + 1   (chain B — must NOT be touched by reading B1)
        //   E1 = =Data!A1 + 5   (chain B continued)
        // Whole-sheet sweep would refresh all three; the targeted walk
        // should only touch B1.
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(10.0));
        wb.sheet_mut(0).unwrap().set_formula("B1", "=Data!A1*2");
        wb.sheet_mut(0).unwrap().set_formula("D1", "=Data!A1+1");
        wb.sheet_mut(0).unwrap().set_formula("E1", "=Data!A1+5");

        let before = wb.sheet(0).unwrap().debug_recompute_count();
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(20.0));
        let after = wb.sheet(0).unwrap().debug_recompute_count();

        // Lazy formulas no longer use core derived recompute. Reading B1
        // should compute through Sheet formula records only.
        assert_eq!(
            after - before,
            0,
            "reading B1 must not force core derived recomputes"
        );
    }

    #[test]
    fn workbook_get_cell_walks_local_dep_chain_to_cross_sheet() {
        // C1 = =B1 + 100  (no SheetRef directly)
        // B1 = =Data!A1 * 2  (cross-sheet)
        // Reading C1 (no SheetRef on its own AST) must transitively force
        // B1 (which DOES have SheetRef) so the cross-sheet value reaches
        // C1 via dependent recomputation.
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(3.0));
        // Install via the workbook API so the cross-sheet edge gets
        // registered — `force_formula_recompute` keys off
        // `has_any_cross_sheet_edges()`.
        assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
        assert!(wb.set_formula(0, "C1", "=B1+100"));

        // Initial read: B1 should resolve to 6, C1 to 106.
        assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(106.0));

        // Mutate cross-sheet source. Re-reading C1 must follow the change
        // (proves the targeted walk reaches B1, otherwise B1 stays cached).
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(4.0));
        assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(108.0));
    }

    #[test]
    fn workbook_get_cell_no_cross_sheet_chain_does_no_recompute() {
        // Reading a primitive (or a same-sheet-only formula) should force
        // zero recomputes because no SheetRef is on the dep chain.
        let mut wb = Workbook::new();
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(7.0));
        wb.sheet_mut(0).unwrap().set_formula("B1", "=A1*2");

        let before = wb.sheet(0).unwrap().debug_recompute_count();
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
        let after = wb.sheet(0).unwrap().debug_recompute_count();
        assert_eq!(after - before, 0, "no cross-sheet on dep chain → no force");
    }

    #[test]
    fn same_sheet_formula_unaffected_by_workbook_get() {
        // Formulas without SheetRef should NOT be force-recomputed (cheap
        // path). Verify by reading a same-sheet formula through wb.get_cell.
        let mut wb = Workbook::new();
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(3.0));
        wb.sheet_mut(0).unwrap().set_formula("B1", "=A1*4");
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
    }

    /// Steady-state read through `wb.get_cell` must hit the formula cache —
    /// no upstream mutation, so the chain should not re-evaluate. This guards
    /// the chain perf bench (Chain100 / Chain1k / ... steadyState evalCount)
    /// against `WorkbookEvalProvider::force_formula_recompute` regressing to
    /// "always recompute". With the bypass scoped to cross-sheet expressions
    /// the second read of A100 on a 100-deep same-sheet chain evaluates ZERO
    /// formulas.
    #[test]
    fn chain_read_uses_cache_when_unchanged() {
        let mut wb = Workbook::new();
        // Build A1=1, A2=A1+1, ..., A100=A99+1 on Sheet1 (single sheet).
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(1.0));
        for i in 2..=100 {
            let addr = format!("A{i}");
            let src = format!("=A{}+1", i - 1);
            assert!(
                wb.set_formula(0, &addr, &src),
                "set_formula failed for {addr}={src}"
            );
        }
        // First read forces full chain eval.
        let v1 = wb.get_cell("Sheet1", "A100");
        let count1 = wb.debug_formula_eval_count(0);
        // Second read with no mutation MUST hit cache on every formula.
        let v2 = wb.get_cell("Sheet1", "A100");
        let count2 = wb.debug_formula_eval_count(0);
        assert_eq!(v1, v2);
        assert_eq!(v2, Value::Number(100.0), "A100 should be A1 + 99 = 100");
        assert_eq!(
            count2, count1,
            "steadyState read must not re-eval (cache miss bug); first={count1} second={count2}"
        );
    }

    /// Regression: codex P1 — `WorkbookEvalProvider::force_formula_recompute`
    /// must keep firing when a cross-sheet formula is installed via the
    /// raw `wb.sheet_mut(idx).set_formula(...)` path. That path bypasses
    /// `CrossSheetDeps::formula_refs` registration, so a `formula_refs`-
    /// only check leaks the stale cached value after the cross-sheet
    /// source mutates. The per-sheet `has_cross_sheet_refs` latch fixes
    /// it: the latch is set inside `Sheet::set_formula` (regardless of
    /// who called it) and OR'd into `has_any_cross_sheet_edges`.
    #[test]
    fn raw_path_cross_sheet_recompute_stays_correct() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        // Raw path — bypasses workbook-level edge registration. Formula
        // still parses as cross-sheet so the sheet-level latch fires.
        assert!(wb.sheet_mut(0).unwrap().set_formula("B1", "=Data!A1*2"));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
        // Mutate the cross-sheet source. Pre-fix: `formula_refs` is
        // empty, `force_formula_recompute` returns false, B1's cached
        // value (10) leaks through. Post-fix: the sheet-1 latch flips
        // the gate true and the cached value is rechecked.
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(7.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
    }

    /// Regression: codex P1 — `Workbook::remove_sheet` clears the
    /// cross-sheet dep graph (indices shift; rewriting every edge in
    /// place is brittle). Formulas on surviving sheets that referenced
    /// the removed sheet still exist; they now resolve to `#REF!` (or
    /// blank), but they remain cross-sheet AST shapes. Re-reading them
    /// after a source mutation must NOT trust the pre-removal cached
    /// value: the sheet-level latch on the formula's host sheet is
    /// still set, so `force_formula_recompute` keeps firing.
    #[test]
    fn remove_sheet_then_recompute_stays_correct() {
        let mut wb = Workbook::new();
        // Sheet1 hosts B1 = =Data!A1*2; Data is a second sheet.
        wb.add_sheet("Data"); // idx 1
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));

        // Drop the Data sheet. `cross_sheet` is cleared (see
        // `Workbook::remove_sheet`); the host sheet's latch survives.
        wb.remove_sheet(1);

        // Now install a NEW Data sheet at the same name. Without the
        // latch, `has_any_cross_sheet_edges()` would still return false
        // here (formula_refs is empty, nothing repopulates it until the
        // next workbook-routed set_formula on B1). The latch keeps the
        // bypass armed so the cache stays honest as the new Data!A1
        // surfaces through B1.
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(3.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));

        // Mutate the new source. Must propagate.
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(11.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(22.0));
    }

    #[test]
    fn remove_sheet_shifts_indices() {
        let mut wb = Workbook::new();
        wb.add_sheet("B"); // idx 1
        wb.add_sheet("C"); // idx 2
        wb.remove_sheet(1);
        assert_eq!(wb.sheet_count(), 2);
        assert_eq!(wb.index_of("C"), Some(1)); // C shifted down
    }

    #[test]
    fn move_sheet_updates_order_and_name_lookup() {
        let mut wb = Workbook::new();
        wb.add_sheet("B");
        wb.add_sheet("C");

        assert!(wb.move_sheet(2, 0));

        assert_eq!(wb.sheet_count(), 3);
        assert_eq!(wb.name(0), Some("C"));
        assert_eq!(wb.name(1), Some("Sheet1"));
        assert_eq!(wb.name(2), Some("B"));
        assert_eq!(wb.index_of("C"), Some(0));
        assert_eq!(wb.index_of("Sheet1"), Some(1));
        assert_eq!(wb.index_of("B"), Some(2));
        assert!(!wb.move_sheet(3, 0));
        assert!(!wb.move_sheet(0, 3));
    }

    #[test]
    fn move_sheet_preserves_cross_sheet_chain_and_dirty_fanout() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");

        wb.set_cell(0, "B4", Value::Number(10.0));
        assert!(wb.set_formula(2, "C2", "=Sheet1!B4+1"));
        assert!(wb.set_formula(1, "C2", "=Sheet3!C2+1"));
        assert!(wb.set_formula(0, "C2", "=Sheet2!C2+1"));

        assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(13.0));
        assert_eq!(wb.debug_cross_sheet_reverse_edge_count(), 3);
        assert!(wb.move_sheet(2, 0));

        assert_eq!(wb.name(0), Some("Sheet3"));
        assert_eq!(wb.name(1), Some("Sheet1"));
        assert_eq!(wb.name(2), Some("Sheet2"));
        assert_eq!(wb.debug_cross_sheet_reverse_edge_count(), 3);
        assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(13.0));

        let sheet1 = wb.index_of("Sheet1").unwrap();
        let sheet2 = wb.index_of("Sheet2").unwrap();
        let sheet3 = wb.index_of("Sheet3").unwrap();
        assert_eq!(sheet1, 1);
        assert_eq!(sheet2, 2);
        assert_eq!(sheet3, 0);

        assert_eq!(wb.debug_formula_cache_state(sheet1, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(sheet2, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(sheet3, "C2"), "clean");

        wb.set_cell(sheet1, "B4", Value::Number(20.0));

        assert_eq!(wb.debug_formula_cache_state(sheet3, "C2"), "dirty");
        assert_eq!(wb.debug_formula_cache_state(sheet2, "C2"), "dirty");
        assert_eq!(wb.debug_formula_cache_state(sheet1, "C2"), "dirty");
        assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(23.0));
    }

    #[test]
    fn move_sheet_rebuilds_cross_sheet_range_dependents() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.set_cell(1, "A1", Value::Number(1.0));
        wb.set_cell(1, "A2", Value::Number(2.0));
        assert!(wb.set_formula(0, "B1", "=SUM(Data!A1:A2)"));

        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(3.0));
        assert_eq!(wb.debug_cross_sheet_reverse_edge_count(), 1);
        assert!(wb.move_sheet(1, 0));

        let data = wb.index_of("Data").unwrap();
        let sheet1 = wb.index_of("Sheet1").unwrap();
        wb.set_cell(data, "A1", Value::Number(10.0));

        assert_eq!(wb.debug_formula_cache_state(sheet1, "B1"), "dirty");
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
    }

    // === Cross-sheet cycle detection (TODO 3.9) ===

    #[test]
    fn cross_sheet_two_way_cycle_detected() {
        // Sheet1.A1 = =Sheet2!A1
        // Sheet2.A1 = =Sheet1!A1
        // The first install is fine (Sheet2.A1 still empty). The second one
        // closes a cycle and must return false + write #CYCLE!.
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();

        assert!(wb.set_formula(s1, "A1", "=Sheet2!A1"));
        // This should detect the cycle.
        assert!(
            !wb.set_formula(s2, "A1", "=Sheet1!A1"),
            "second set_formula closes cycle, must return false"
        );

        assert_eq!(
            wb.get_cell("Sheet2", "A1"),
            Value::Error(ValueError::CyclicRef),
            "Sheet2.A1 should hold #CYCLE!"
        );
    }

    #[test]
    fn cross_sheet_three_way_cycle_detected() {
        // Sheet1.A1 = =Sheet2!A1 → Sheet2.A1 = =Sheet3!A1 → Sheet3.A1 = =Sheet1!A1
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();
        let s3 = wb.index_of("Sheet3").unwrap();

        assert!(wb.set_formula(s1, "A1", "=Sheet2!A1"));
        assert!(wb.set_formula(s2, "A1", "=Sheet3!A1"));
        // Closing edge:
        assert!(
            !wb.set_formula(s3, "A1", "=Sheet1!A1"),
            "three-way cycle must be detected on the closing edge"
        );

        assert_eq!(
            wb.get_cell("Sheet3", "A1"),
            Value::Error(ValueError::CyclicRef),
        );
    }

    #[test]
    fn cross_sheet_chain_no_cycle() {
        // Sheet1.A1 = =Sheet2!A1, Sheet2.A1 = =Sheet3!A1, Sheet3.A1 = 5
        // No cycle: every set_formula succeeds, values resolve.
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();
        let s3 = wb.index_of("Sheet3").unwrap();

        wb.sheet_mut(s3).unwrap().set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(s2, "A1", "=Sheet3!A1"));
        assert!(wb.set_formula(s1, "A1", "=Sheet2!A1"));

        assert_eq!(wb.get_cell("Sheet3", "A1"), Value::Number(5.0));
        assert_eq!(wb.get_cell("Sheet2", "A1"), Value::Number(5.0));
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(5.0));
    }

    #[test]
    fn cross_sheet_self_ref_via_sheet_name() {
        // Sheet1.A1 = =Sheet1!A1 — same as a same-sheet self-ref. Workbook
        // static check should also catch it (target_idx == sheet_idx, target
        // == addr → cycle on the seed itself).
        let mut wb = Workbook::new();
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(
            !wb.set_formula(s1, "A1", "=Sheet1!A1"),
            "self-reference via own sheet name must be detected"
        );
        assert_eq!(
            wb.get_cell("Sheet1", "A1"),
            Value::Error(ValueError::CyclicRef),
        );
    }

    #[test]
    fn workbook_set_formula_invalid_sheet_returns_false() {
        let mut wb = Workbook::new();
        assert!(!wb.set_formula(99, "A1", "=1+1"));
    }

    #[test]
    fn workbook_set_formula_parse_error_writes_value_error() {
        let mut wb = Workbook::new();
        let s1 = wb.index_of("Sheet1").unwrap();
        assert!(!wb.set_formula(s1, "A1", "=garbage(("));
        assert_eq!(
            wb.get_cell("Sheet1", "A1"),
            Value::Error(ValueError::InvalidValue),
        );
    }

    #[test]
    fn workbook_debug_formula_eval_count_stays_zero_until_read() {
        let mut wb = Workbook::new();
        let data = wb.add_sheet("Data");
        wb.set_cell(data, "A1", Value::Number(41.0));
        assert!(wb.set_formula(0, "A1", "=Data!A1+1"));

        assert_eq!(wb.debug_formula_eval_count(0), 0);
        assert_eq!(wb.debug_formula_cache_state(0, "A1"), "dirty");

        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(42.0));
        assert_eq!(wb.debug_formula_eval_count(0), 1);
        assert_eq!(wb.debug_formula_cache_state(0, "A1"), "clean");
    }

    #[test]
    fn cross_sheet_runtime_guard_returns_cycle_when_static_bypassed() {
        // Build a cycle by going through Sheet::set_formula directly, which
        // does NOT have workbook-level cycle detection. Then read through
        // Workbook::get_cell — the lazy FormulaCache::Computing state must
        // short-circuit instead of either looping or returning a stale
        // value. (Pre-lazy this required a separate TLS visited-set guard;
        // the Computing state covers it natively now.)
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        wb.sheet_mut(0).unwrap().set_formula("A1", "=Sheet2!A1");
        wb.sheet_by_name_mut("Sheet2")
            .unwrap()
            .set_formula("A1", "=Sheet1!A1");

        // Reading either side must terminate (no infinite loop) and not
        // return a stale propagated number; cycle/error/null are all
        // acceptable outcomes for this defensive scenario, the key is
        // termination + no stale numeric.
        let v = wb.get_cell("Sheet1", "A1");
        assert!(
            matches!(v, Value::Null | Value::Error(_)),
            "expected Null/Error from cycle, got {:?}",
            v
        );
    }

    #[test]
    fn workbook_set_formula_happy_path_values_propagate() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();
        let sd = wb.index_of("Data").unwrap();
        wb.sheet_mut(sd).unwrap().set_cell("A1", Value::Number(7.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*3"));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(21.0));
    }

    // === Phase 3 Track I — cross-sheet dirty propagation acceptance ===

    /// Inverse of `workbook_get_cell_refreshes_cross_sheet_cache_without_notifying`.
    ///
    /// That test exercises the RAW path (`wb.sheet_by_name_mut("Data").
    /// set_cell(...)`) which deliberately bypasses the workbook dep
    /// graph — single-sheet edits should continue to work without
    /// participating in cross-sheet fanout.
    ///
    /// THIS test exercises the workbook-routed path: `wb.set_cell(
    /// data_idx, "A1", ...)` MUST fire the subscriber on `Sheet1!B1`
    /// (where `B1 = =Data!A1*2`) because the cross-sheet dep graph
    /// records the reverse edge `(data_idx, A1) → (sheet1_idx, B1)`.
    #[test]
    fn cross_sheet_write_fires_dependent_subscriber() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        // Set the cross-sheet source via the raw path — pre-existing
        // value, not part of what we're measuring.
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        // Install the cross-sheet formula via the workbook path so the
        // CrossSheetDeps reverse edge actually lands.
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        // Sanity: the dep graph holds exactly one reverse edge —
        // `(data_idx, A1) → (s1, B1)`.
        assert_eq!(
            wb.debug_cross_sheet_reverse_edge_count(),
            1,
            "set_formula must record one cross-sheet reverse edge"
        );

        // Subscribe AFTER the formula is installed so we measure only
        // fanout from the upcoming write.
        let changes = Rc::new(RefCell::new(0u32));
        let changes_clone = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *changes_clone.borrow_mut() += 1;
        });

        // Workbook-routed write on Data!A1 — this is the path that
        // SHOULD propagate dirty + fire the cross-sheet subscriber.
        wb.set_cell(data_idx, "A1", Value::Number(7.0));

        assert!(
            *changes.borrow() >= 1,
            "subscriber on Sheet1!B1 must fire when Data!A1 is written via wb.set_cell; got {}",
            *changes.borrow()
        );
        assert_eq!(
            wb.get_cell("Sheet1", "B1"),
            Value::Number(14.0),
            "formula must observe the new cross-sheet value on subsequent read"
        );
    }

    /// Confirms the design split: `wb.sheet_mut(idx).set_cell(...)` is
    /// the "raw" path and is INTENTIONALLY excluded from cross-sheet
    /// fanout. This complements `cross_sheet_write_fires_dependent_
    /// subscriber` — if both fired, single-sheet test ergonomics would
    /// degrade (every sheet-local edit would have to consider the
    /// workbook graph).
    #[test]
    fn raw_sheet_write_does_not_fire_cross_sheet_subscriber() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        let changes = Rc::new(RefCell::new(0u32));
        let changes_clone = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *changes_clone.borrow_mut() += 1;
        });

        // RAW path — deliberately bypasses the workbook graph.
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(7.0));

        assert_eq!(
            *changes.borrow(),
            0,
            "raw Sheet::set_cell path must NOT fire cross-sheet subscribers"
        );
        // The cached formula result is stale — but the cross-sheet
        // read path (`wb.get_cell`) still refreshes it on demand via
        // `WorkbookEvalProvider::force_formula_recompute`.
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
    }

    /// Chained cross-sheet propagation: `Sheet1!D = =Sheet2!C`,
    /// `Sheet2!C = =Sheet3!A`. A write to `Sheet3!A` must dirty BOTH
    /// `Sheet2!C` and `Sheet1!D` (BFS through one cross-sheet hop).
    #[test]
    fn cross_sheet_chain_fires_transitive_subscribers() {
        let mut wb = Workbook::new();
        let s2 = wb.add_sheet("Sheet2");
        let s3 = wb.add_sheet("Sheet3");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(s3).unwrap().set_cell("A1", Value::Number(1.0));
        assert!(wb.set_formula(s2, "C1", "=Sheet3!A1"));
        assert!(wb.set_formula(s1, "D1", "=Sheet2!C1"));
        // Edges: (s3, A1) → (s2, C1) and (s2, C1) → (s1, D1) = 2 reverse edges.
        assert_eq!(wb.debug_cross_sheet_reverse_edge_count(), 2);

        let s1_changes = Rc::new(RefCell::new(0u32));
        let s2_changes = Rc::new(RefCell::new(0u32));
        {
            let s1c = s1_changes.clone();
            wb.sheet_mut(s1).unwrap().subscribe_cell("D1", move || {
                *s1c.borrow_mut() += 1;
            });
            let s2c = s2_changes.clone();
            wb.sheet_mut(s2).unwrap().subscribe_cell("C1", move || {
                *s2c.borrow_mut() += 1;
            });
        }

        wb.set_cell(s3, "A1", Value::Number(99.0));

        assert!(
            *s2_changes.borrow() >= 1,
            "transitive subscriber on Sheet2!C1 must fire when Sheet3!A1 is written"
        );
        assert!(
            *s1_changes.borrow() >= 1,
            "transitive subscriber on Sheet1!D1 must fire (BFS through Sheet2!C1)"
        );
        assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(99.0));
    }

    /// `Workbook::clear_cell` propagates dirty fanout the same way as
    /// writing `Value::Null` — a cleared cross-sheet source must dirty
    /// downstream formulas.
    #[test]
    fn cross_sheet_clear_fires_dependent_subscriber() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *cc.borrow_mut() += 1;
        });

        wb.clear_cell(data_idx, "A1");
        assert!(*changes.borrow() >= 1);
    }

    /// `Workbook::set_formula` clean-up: replacing a formula with one
    /// that has different cross-sheet refs must remove the stale
    /// reverse edges so a later write to the old source doesn't fire
    /// the (now-irrelevant) subscriber.
    #[test]
    fn cross_sheet_formula_replacement_drops_stale_reverse_edge() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let extra_idx = wb.add_sheet("Extra");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(1.0));
        wb.sheet_mut(extra_idx)
            .unwrap()
            .set_cell("A1", Value::Number(100.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));
        assert_eq!(wb.debug_cross_sheet_reverse_edge_count(), 1);

        // Replace with a formula that references Extra instead.
        assert!(wb.set_formula(s1, "B1", "=Extra!A1*2"));
        assert_eq!(
            wb.debug_cross_sheet_reverse_edge_count(),
            1,
            "still one reverse edge, but now keyed by Extra!A1"
        );

        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *cc.borrow_mut() += 1;
        });
        // Writing the OLD source must NOT fire the subscriber.
        wb.set_cell(data_idx, "A1", Value::Number(7.0));
        assert_eq!(
            *changes.borrow(),
            0,
            "stale reverse edge from previous formula was not cleaned up"
        );
        // Writing the NEW source must fire it.
        wb.set_cell(extra_idx, "A1", Value::Number(8.0));
        assert!(*changes.borrow() >= 1);
    }

    #[test]
    fn cross_sheet_range_formula_replacement_drops_stale_reverse_edge() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(1.0));
        assert!(wb.set_formula(s1, "D1", "=SUM(Data!A1:A10)"));
        assert_eq!(wb.debug_cross_sheet_reverse_edge_count(), 1);

        assert!(wb.set_formula(s1, "D1", "=1"));
        assert_eq!(
            wb.debug_cross_sheet_reverse_edge_count(),
            0,
            "replacing a cross-sheet range formula must remove its range edge"
        );
    }

    #[test]
    fn cross_sheet_range_write_fires_same_addr_dependents_on_multiple_sheets() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let other_idx = wb.add_sheet("Other");
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(wb.set_formula(s1, "D1", "=SUM(Data!A1:A10)"));
        assert!(wb.set_formula(other_idx, "D1", "=SUM(Data!A1:A10)"));

        let s1_changes = Rc::new(RefCell::new(0u32));
        let other_changes = Rc::new(RefCell::new(0u32));
        {
            let c = s1_changes.clone();
            wb.sheet_mut(s1)
                .unwrap()
                .subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }
        {
            let c = other_changes.clone();
            wb.sheet_mut(other_idx)
                .unwrap()
                .subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }

        wb.set_cell(data_idx, "A5", Value::Number(10.0));

        assert!(*s1_changes.borrow() >= 1, "Sheet1!D1 must fire for Data!A5");
        assert!(
            *other_changes.borrow() >= 1,
            "Other!D1 must also fire for Data!A5 despite sharing the same address"
        );
    }

    #[test]
    fn cross_sheet_range_replacement_preserves_other_sheet_same_addr_edge() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let other_idx = wb.add_sheet("Other");
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(wb.set_formula(s1, "D1", "=SUM(Data!A1:A10)"));
        assert!(wb.set_formula(other_idx, "D1", "=SUM(Data!A1:A10)"));
        assert!(wb.set_formula(s1, "D1", "=1"));

        let other_changes = Rc::new(RefCell::new(0u32));
        {
            let c = other_changes.clone();
            wb.sheet_mut(other_idx)
                .unwrap()
                .subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }

        wb.set_cell(data_idx, "A5", Value::Number(10.0));

        assert!(
            *other_changes.borrow() >= 1,
            "removing Sheet1!D1 must not remove Other!D1's same-address range edge"
        );
    }

    #[test]
    fn cross_sheet_range_cycle_is_rejected_when_source_range_contains_target_reader() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(wb.set_formula(data_idx, "A2", "=Sheet1!D1"));
        assert!(
            !wb.set_formula(s1, "D1", "=SUM(Data!A1:A3)"),
            "candidate range should see Data!A2's formula edge back to Sheet1!D1"
        );
        assert_eq!(
            wb.get_cell("Sheet1", "D1"),
            Value::Error(ValueError::CyclicRef)
        );
    }

    /// Workbook-level `bulk_load` collects writes and fires each cross-
    /// sheet subscriber at most once at flush time.
    #[test]
    fn bulk_load_dedups_cross_sheet_subscriber_fanout() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(1.0));
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A2", Value::Number(2.0));
        // Formula depends on BOTH Data!A1 and Data!A2 — two cross-sheet
        // cell edges feed the same target subscriber.
        assert!(wb.set_formula(s1, "B1", "=Data!A1+Data!A2"));

        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *cc.borrow_mut() += 1;
        });

        wb.bulk_load(|loader| {
            loader.set_cell(data_idx, "A1", Value::Number(10.0));
            loader.set_cell(data_idx, "A2", Value::Number(20.0));
        });

        // Two writes to the same target → ONE subscriber fire.
        assert_eq!(
            *changes.borrow(),
            1,
            "bulk_load must dedup cross-sheet subscriber fanout"
        );
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(30.0));
    }

    /// Phase 3 Track J: `cross_sheet_cycle` should expand visited-node
    /// edges through `CrossSheetDeps::formula_refs`, NOT by re-parsing
    /// each visited formula's AST. The probe is the per-workbook counter
    /// `debug_cycle_ast_walk_count`: a third `set_formula` call
    /// (`Sheet1!C = =Sheet2!B`) that visits an already-installed
    /// cross-sheet pair must bump the counter by exactly ONE (for the
    /// candidate seed AST walk), not by `N` for each visited node.
    #[test]
    fn cross_sheet_cycle_via_forward_index_no_collect_workbook_refs_on_visited() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();

        // Install a non-cycle cross-sheet pair so the forward index has
        // entries the BFS will traverse:
        //   `Sheet1!A1 = =Sheet2!B1`
        //   `Sheet2!B1 = =Sheet1!D1`
        // After this, formula_refs[(s1, A1)] = [(s2, B1)] and
        // formula_refs[(s2, B1)] = [(s1, D1)].
        assert!(wb.set_formula(s1, "A1", "=Sheet2!B1"));
        assert!(wb.set_formula(s2, "B1", "=Sheet1!D1"));

        // Baseline counter before the probed call (already 2: one bump
        // per cycle check, one per set_formula above).
        let before = wb.debug_cycle_ast_walk_count();

        // Third formula: `Sheet1!C1 = =Sheet2!B1`. The candidate seed
        // edges are `[(s2, B1)]`. From there, the BFS consults
        // `formula_refs[(s2, B1)] = [(s1, D1)]`, then
        // `formula_refs[(s1, D1)]` (empty → stop). `(s1, C1)` (the
        // target) is never reached, so this is NOT a cycle.
        // The candidate AST walk runs exactly once → counter += 1.
        assert!(
            wb.set_formula(s1, "C1", "=Sheet2!B1"),
            "re-reader of an existing cross-sheet source is not a cycle"
        );

        let after = wb.debug_cycle_ast_walk_count();
        let delta = after - before;
        assert_eq!(
            delta, 1,
            "cross_sheet_cycle must call collect_workbook_refs exactly once \
             per set_formula (for the candidate seed). Visited nodes should \
             pull their edges from formula_refs, not the AST. Got {} \
             AST walks across this set_formula call.",
            delta
        );

        // Sanity: the chain still evaluates correctly.
        assert!(matches!(
            wb.get_cell("Sheet1", "C1"),
            Value::Number(_) | Value::Null
        ));
    }

    /// Phase 3 Track J.2: cycles threaded through SAME-sheet hops via
    /// unqualified `Expr::CellRef` in visited formulas are NOT caught
    /// by the static `cross_sheet_cycle`. The forward index stores only
    /// cross-sheet (`Expr::SheetRef`) edges; unqualified same-sheet
    /// `CellRef`s are owned by `Sheet`'s own `cell_dependents` and
    /// don't surface in `formula_refs`. The BFS therefore stops at the
    /// first visited node whose only outgoing edges are same-sheet.
    ///
    /// These cases MUST be caught at runtime by `FormulaCache::Computing`
    /// — recursive eval into a cell already on the stack returns
    /// `Value::Error(ValueError::CyclicRef)` instead of looping or
    /// blowing the stack.
    ///
    /// Setup (note `=C1` not `=Sheet2!C1` — the unqualified form is what
    /// makes the cycle invisible to the static workbook check):
    ///   - `Sheet1!A1 = =Sheet2!B1` — cross-sheet edge.
    ///   - `Sheet2!B1 = =C1` (set via `Sheet::set_formula` to skip the
    ///     workbook-level seed; sheet-local check passes because C1 is
    ///     empty at install time).
    ///   - `Sheet2!C1 = =Sheet1!A1` — cross-sheet edge. The candidate
    ///     seed is `(s1, A1)`. From `formula_refs[(s1, A1)] = [(s2, B1)]`,
    ///     then `formula_refs[(s2, B1)]` is EMPTY (same-sheet refs not
    ///     indexed). Cycle missed by the static check.
    ///
    /// Read at any node of the cycle. The lazy FormulaCache::Computing
    /// state short-circuits the second re-entry; the cell value is an
    /// Error (cycle) or Null, never a stale numeric.
    #[test]
    fn runtime_cycle_returns_cycle_error_value_through_same_sheet_hop() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();

        // Install Sheet1!A1 = =Sheet2!B1 via the workbook path so the
        // forward index records the cross-sheet edge.
        assert!(wb.set_formula(s1, "A1", "=Sheet2!B1"));

        // Sheet2!B1 = =C1 (unqualified) via the sheet path — skips
        // workbook-level seeding so `formula_refs[(s2, B1)]` stays empty.
        // The sheet-local cycle check passes because C1 is empty.
        wb.sheet_mut(s2).unwrap().set_formula("B1", "=C1");

        // Sheet2!C1 = =Sheet1!A1 via the workbook path. The static
        // workbook check seeds at `(s1, A1)`, walks to `(s2, B1)`, then
        // stops (`formula_refs[(s2, B1)]` is empty — same-sheet `=C1` is
        // not indexed). So this install IS accepted.
        assert!(
            wb.set_formula(s2, "C1", "=Sheet1!A1"),
            "static check should NOT flag this — same-sheet =C1 hop in B1 \
             is invisible to formula_refs"
        );

        // Reading any node of the cycle must terminate and surface an
        // Error/Null. The runtime FormulaCache::Computing guard returns
        // `Value::Error(CyclicRef)` on the re-entry attempt.
        let va = wb.get_cell("Sheet1", "A1");
        let vb = wb.get_cell("Sheet2", "B1");
        let vc = wb.get_cell("Sheet2", "C1");
        for (label, v) in [("A1", &va), ("B1", &vb), ("C1", &vc)] {
            assert!(
                matches!(v, Value::Null | Value::Error(_)),
                "{} must surface cycle as Error/Null, got {:?}",
                label,
                v
            );
        }
    }

    // === Wave 8 codex-review fix #1: re-entrancy guard ===
    //
    // A host custom-formula callback MUST NOT mutate the workbook during
    // its execution. These tests pin the rejection behavior across the
    // mutation entry points, plus prove the cache state remains sound
    // (no silently-lost dirty marks).

    /// A custom callback that tries to call `wb.set_cell` is reflected
    /// back the guard as a silent no-op (the infallible signature can't
    /// return an error). The mutation is dropped; the cache state for
    /// the cell whose formula triggered the callback is `Clean(value)`
    /// of the original value.
    #[test]
    fn custom_callback_set_cell_is_rejected_and_cache_stays_clean() {
        use std::sync::Mutex;

        /// Registry that calls back into the workbook from inside its
        /// `lookup`. We can't pass a `&mut Workbook` directly through
        /// the immutable `EvalProvider` trait, so the test relies on
        /// the same wasm-bridge shape: the registry holds a callback
        /// closure that the test installs via a wrapper struct holding
        /// `*mut Workbook` (the test only dereferences inside the
        /// callback, AFTER the read borrow has been released by the
        /// `EvalProvider` chain — which is what would happen in the
        /// real WASM bridge).
        struct AttackRegistry {
            wb_ptr: Mutex<*mut Workbook>,
            invoked: Mutex<usize>,
        }
        // SAFETY: tests are single-threaded; the Mutex satisfies the
        // trait bounds without allowing real cross-thread sharing.
        unsafe impl Send for AttackRegistry {}
        unsafe impl Sync for AttackRegistry {}
        impl std::fmt::Debug for AttackRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "AttackRegistry")
            }
        }
        impl CustomFunctionRegistry for AttackRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                *self.invoked.lock().unwrap() += 1;
                // Try to mutate the workbook from inside the callback.
                // SAFETY: see test setup — the pointer is valid for the
                // duration of the eval frame because the test holds the
                // `Workbook` by value and never moves it during read.
                let wb_ptr = *self.wb_ptr.lock().unwrap();
                // The guard MUST cause this to be a no-op.
                unsafe {
                    (*wb_ptr).set_cell(0, "Z99", Value::Number(999.0));
                }
                Some(Value::Number(42.0))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(AttackRegistry {
            wb_ptr: Mutex::new(&mut wb as *mut Workbook),
            invoked: Mutex::new(0),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        // Re-pin the pointer post-install (the Arc swap might not have
        // moved `wb`, but be defensive — the test asserts the address
        // is current).
        *registry.wb_ptr.lock().unwrap() = &mut wb as *mut Workbook;
        assert!(wb.set_formula(0, "A1", "=MYBAD()"));

        // Read the formula. The callback runs, attempts to write Z99,
        // and gets silently rejected by the guard.
        let v = wb.get_cell("Sheet1", "A1");
        assert_eq!(v, Value::Number(42.0));
        // The callback may run more than once during install +
        // first-read (set_formula performs a workbook-aware recompute
        // pass when the formula references workbook-scope things). The
        // important guarantee is that EVERY invocation hit the guard
        // and was rejected.
        assert!(
            *registry.invoked.lock().unwrap() >= 1,
            "callback must have fired at least once"
        );

        // The attempted mutation MUST NOT have landed. Z99 stays empty.
        let z99 = wb.get_cell("Sheet1", "Z99");
        assert_eq!(z99, Value::Null);

        // After the callback returns, the guard depth is back to 0 so
        // normal mutations work again.
        assert!(!wb.is_inside_custom_call());
        wb.set_cell(0, "B1", Value::Number(7.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(7.0));
    }

    /// The `try_*` family surfaces `Err(MutationDuringCustomCall)` so a
    /// host can debug the rejection rather than silently losing the
    /// write. We exercise this by calling `try_set_cell` directly from
    /// inside the callback through the same `*mut Workbook` trick.
    #[test]
    fn custom_callback_try_set_cell_returns_mutation_error() {
        use std::sync::Mutex;

        struct ProbeRegistry {
            wb_ptr: Mutex<*mut Workbook>,
            last_err: Mutex<Option<SheetError>>,
        }
        unsafe impl Send for ProbeRegistry {}
        unsafe impl Sync for ProbeRegistry {}
        impl std::fmt::Debug for ProbeRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "ProbeRegistry")
            }
        }
        impl CustomFunctionRegistry for ProbeRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                let wb_ptr = *self.wb_ptr.lock().unwrap();
                let result = unsafe { (*wb_ptr).try_set_cell(0, "C1", Value::Number(1.0)) };
                if let Err(e) = result {
                    *self.last_err.lock().unwrap() = Some(e);
                }
                Some(Value::Number(0.0))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(ProbeRegistry {
            wb_ptr: Mutex::new(&mut wb as *mut Workbook),
            last_err: Mutex::new(None),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        *registry.wb_ptr.lock().unwrap() = &mut wb as *mut Workbook;
        assert!(wb.set_formula(0, "A1", "=PROBE()"));

        let _ = wb.get_cell("Sheet1", "A1");

        let err = registry.last_err.lock().unwrap().clone();
        assert_eq!(err, Some(SheetError::MutationDuringCustomCall));
    }

    /// The depth counter is exception-safe: even when the callback
    /// panics / aborts the eval, the `Drop` impl on `CustomCallScope`
    /// decrements the counter so subsequent reads work normally.
    /// (Tested by registering a callback that returns `#VALUE!` — the
    /// engine treats this as a successful dispatch and bookkeeping
    /// runs identically to the normal-return path. A real Rust panic
    /// from inside the callback is unsafe in a `#[test]` outside of
    /// `panic = "abort"`, so the panic path is covered by the wasm
    /// `throw_str` path which exercises the same Drop semantics on
    /// the JS-throw side.)
    #[test]
    fn custom_call_depth_resets_after_callback() {
        use std::sync::Mutex;

        struct ErrorRegistry {
            invoked: Mutex<usize>,
        }
        impl std::fmt::Debug for ErrorRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "ErrorRegistry")
            }
        }
        impl CustomFunctionRegistry for ErrorRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                *self.invoked.lock().unwrap() += 1;
                Some(Value::Error(ValueError::InvalidValue))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(ErrorRegistry {
            invoked: Mutex::new(0),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        assert!(wb.set_formula(0, "A1", "=BAD()"));

        // Three reads — each spins up a fresh CustomCallScope and tears
        // it down. The depth counter must be 0 at every observation.
        for _ in 0..3 {
            assert!(!wb.is_inside_custom_call());
            let v = wb.get_cell("Sheet1", "A1");
            assert!(matches!(v, Value::Error(_)));
            assert!(!wb.is_inside_custom_call());
        }

        // Subsequent normal mutations work, confirming the counter
        // didn't drift.
        wb.set_cell(0, "D1", Value::Number(42.0));
        assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(42.0));
    }
}
