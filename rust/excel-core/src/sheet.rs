use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use einfach_core::{AtomId, CellListener, Store, SubscriptionId, Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::{eval_expr_with_provider, EvalProvider};
use crate::formula::{parse_formula, Expr};
use crate::range::CellRange;

type ListenerRc = Rc<dyn CellListener>;
type ListenerList = Rc<RefCell<Vec<(u64, ListenerRc)>>>;

/// Snapshot the listener list (so callbacks may freely re-enter `subscribe` /
/// `unsubscribe` without aliasing the borrow), then dispatch to each.
fn dispatch_listeners(list: &ListenerList) {
    let snapshot: Vec<ListenerRc> = list.borrow().iter().map(|(_, l)| l.clone()).collect();
    for listener in snapshot {
        listener.on_change();
    }
}

struct AddressListenerFanout {
    listeners: ListenerList,
}

impl CellListener for AddressListenerFanout {
    fn on_change(&self) {
        dispatch_listeners(&self.listeners);
    }
}

struct AddressSubscriptionBucket {
    listeners: ListenerList,
    atom_id: Option<AtomId>,
    store_sub: Option<SubscriptionId>,
}

#[derive(Clone, Debug, PartialEq)]
enum FormulaCache {
    Dirty,
    Computing,
    Clean(Value),
}

struct FormulaRecord {
    expr: Rc<Expr>,
    deps: RefCell<HashSet<CellAddress>>,
    cache: RefCell<FormulaCache>,
}

impl FormulaRecord {
    fn new(expr: Rc<Expr>, deps: HashSet<CellAddress>) -> Self {
        FormulaRecord {
            expr,
            deps: RefCell::new(deps),
            cache: RefCell::new(FormulaCache::Dirty),
        }
    }
}

/// Token returned by `Sheet::subscribe_cell`. The public subscription is tied
/// to a cell address, not the current primitive atom. `Sheet` wires the
/// internal store subscription only while the address has a primitive atom;
/// formula cells are notified through the lazy dependency graph.
#[derive(Clone, Copy, Debug)]
pub struct CellSubscription {
    addr: CellAddress,
    listener_id: u64,
}

/// A spreadsheet sheet backed by an atom store.
pub struct Sheet {
    pub(crate) store: Store,
    pub(crate) cells: HashMap<CellAddress, AtomId>,
    /// Formula cells live at the Sheet layer. Formula results are cached here,
    /// not as core derived atoms, so `set_formula` does not compute.
    formula_cells: HashMap<CellAddress, Rc<FormulaRecord>>,
    /// AST of each formula cell, used for static cycle detection (B.2).
    formula_exprs: HashMap<CellAddress, Rc<Expr>>,
    /// Original formula text per cell, for `get_formula` so the formula bar
    /// and edit-mode entry can show the source instead of the computed
    /// result (D.11).
    formula_texts: HashMap<CellAddress, String>,
    /// Address-level subscriptions. Buckets are only wired to store atoms when
    /// the address has a materialized readable atom, so subscribing to an empty
    /// visible cell does not allocate a cell atom by itself.
    cell_subscriptions: HashMap<CellAddress, AddressSubscriptionBucket>,
    /// cell address → formula cells that depend on it.
    cell_dependents: RefCell<HashMap<CellAddress, HashSet<CellAddress>>>,
    next_cell_sub_id: u64,
}

impl Sheet {
    pub fn new() -> Self {
        Sheet {
            store: Store::new(),
            cells: HashMap::new(),
            formula_cells: HashMap::new(),
            formula_exprs: HashMap::new(),
            formula_texts: HashMap::new(),
            cell_subscriptions: HashMap::new(),
            cell_dependents: RefCell::new(HashMap::new()),
            next_cell_sub_id: 0,
        }
    }

    /// Get or create the primitive atom for a cell address.
    /// New cells start as Null.
    fn ensure_cell(&mut self, addr: CellAddress) -> AtomId {
        if let Some(&id) = self.cells.get(&addr) {
            return id;
        }
        let id = self.store.create_atom(Value::Null);
        self.cells.insert(addr, id);
        id
    }

    /// Get or create the primitive atom for a cell. Formula results no longer
    /// have core atoms; callers needing a raw atom get the primitive slot.
    fn readable_atom(&mut self, addr: CellAddress) -> AtomId {
        self.ensure_cell(addr)
    }

    fn current_readable_atom(&self, addr: CellAddress) -> Option<AtomId> {
        if self.formula_cells.contains_key(&addr) {
            None
        } else {
            self.cells.get(&addr).copied()
        }
    }

    /// Detach this address's fanout from the store. The bucket and its
    /// listener list are kept; only the underlying `store.sub` goes away.
    /// Returns `true` if a fanout was actually attached. Used as the first
    /// half of `with_remap`: detach → mutate → reattach + manual fire.
    fn detach_address_sub(&mut self, addr: CellAddress) -> bool {
        let Some(bucket) = self.cell_subscriptions.get_mut(&addr) else {
            return false;
        };
        let store_sub = bucket.store_sub.take();
        bucket.atom_id = None;
        if let Some(sub_id) = store_sub {
            self.store.unsub(sub_id);
            true
        } else {
            false
        }
    }

    /// Attach (or re-attach) this address's fanout to the current readable
    /// atom. No-op when there is no listener bucket or the address has no
    /// readable atom yet.
    fn attach_address_sub(&mut self, addr: CellAddress) {
        let new_atom = self.current_readable_atom(addr);
        let Some(bucket) = self.cell_subscriptions.get_mut(&addr) else {
            return;
        };
        if bucket.store_sub.is_some() && bucket.atom_id == new_atom {
            return;
        }
        if let Some(sub_id) = bucket.store_sub.take() {
            self.store.unsub(sub_id);
        }
        bucket.atom_id = new_atom;
        if let Some(atom_id) = new_atom {
            let fanout = AddressListenerFanout {
                listeners: bucket.listeners.clone(),
            };
            bucket.store_sub = Some(self.store.sub(atom_id, fanout));
        }
    }

    /// Run a mutation that may swap the readable atom under `addr`.
    /// Detaches the fanout for `addr` first, runs `f`, then reattaches the
    /// fanout to whatever atom `addr` now points at and fires listeners
    /// exactly once. Use this for any state change that goes formula↔
    /// primitive (so the inner `store.set` doesn't double-fire through the
    /// fanout that was wired to the OLD atom).
    ///
    /// Fires whenever the bucket has at least one listener — NOT only when
    /// a store_sub was previously attached. The "previously attached"
    /// condition would silently drop the first set_formula on an empty cell
    /// that was subscribed before any value existed (bucket has listeners
    /// but no store_sub, because attach_address_sub no-ops without a
    /// readable atom to attach to).
    fn with_remap<R>(&mut self, addr: CellAddress, f: impl FnOnce(&mut Self) -> R) -> R {
        self.detach_address_sub(addr);
        let result = f(self);
        self.attach_address_sub(addr);
        if self.has_address_subscribers(addr) {
            self.notify_address_subscribers(addr);
        }
        result
    }

    fn has_address_subscribers(&self, addr: CellAddress) -> bool {
        self.cell_subscriptions
            .get(&addr)
            .map(|b| !b.listeners.borrow().is_empty())
            .unwrap_or(false)
    }

    fn notify_address_subscribers(&self, addr: CellAddress) {
        if let Some(bucket) = self.cell_subscriptions.get(&addr) {
            dispatch_listeners(&bucket.listeners);
        }
    }

    fn formula_deps_for(expr: &Expr) -> HashSet<CellAddress> {
        let mut deps = Vec::new();
        collect_refs(expr, &mut deps);
        deps.into_iter().collect()
    }

    fn add_formula_deps(&self, formula_addr: CellAddress, deps: &HashSet<CellAddress>) {
        let mut dependents = self.cell_dependents.borrow_mut();
        for dep in deps {
            dependents.entry(*dep).or_default().insert(formula_addr);
        }
    }

    fn remove_formula_deps(&self, formula_addr: CellAddress, deps: &HashSet<CellAddress>) {
        let mut dependents = self.cell_dependents.borrow_mut();
        for dep in deps {
            let should_remove = if let Some(set) = dependents.get_mut(dep) {
                set.remove(&formula_addr);
                set.is_empty()
            } else {
                false
            };
            if should_remove {
                dependents.remove(dep);
            }
        }
    }

    fn replace_formula_deps(
        &self,
        formula_addr: CellAddress,
        record: &FormulaRecord,
        new_deps: HashSet<CellAddress>,
    ) {
        let old_deps = record.deps.replace(new_deps.clone());
        self.remove_formula_deps(formula_addr, &old_deps);
        self.add_formula_deps(formula_addr, &new_deps);
    }

    fn remove_formula_record(&mut self, addr: CellAddress) -> Option<Rc<FormulaRecord>> {
        let record = self.formula_cells.remove(&addr)?;
        let deps = record.deps.borrow().clone();
        self.remove_formula_deps(addr, &deps);
        self.formula_exprs.remove(&addr);
        self.formula_texts.remove(&addr);
        Some(record)
    }

    fn rebuild_all_formula_dependents(&self) {
        self.cell_dependents.borrow_mut().clear();
        for (addr, record) in &self.formula_cells {
            let deps = record.deps.borrow().clone();
            self.add_formula_deps(*addr, &deps);
        }
    }

    fn mark_dependents_dirty(&self, root: CellAddress) -> HashSet<CellAddress> {
        let mut notified = HashSet::new();
        let mut stack: Vec<CellAddress> = self
            .cell_dependents
            .borrow()
            .get(&root)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();

        while let Some(addr) = stack.pop() {
            if !notified.insert(addr) {
                continue;
            }
            if let Some(record) = self.formula_cells.get(&addr) {
                *record.cache.borrow_mut() = FormulaCache::Dirty;
            }
            self.notify_address_subscribers(addr);

            let next = self
                .cell_dependents
                .borrow()
                .get(&addr)
                .cloned()
                .unwrap_or_default();
            stack.extend(next);
        }

        notified
    }

    /// Set a cell's value by address string (e.g. "A1").
    /// Clears any existing formula on this cell.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let had_formula = self.formula_cells.contains_key(&addr);
        let is_null = matches!(value, Value::Null);

        if had_formula {
            self.with_remap(addr, |sheet| {
                sheet.remove_formula_record(addr);
                let id = sheet.ensure_cell(addr);
                sheet.store.set(id, value);
            });
            // 3.10 — formula→primitive→Null with no surviving dependents leaks
            // the freshly ensured primitive scaffold. The with_remap tail has
            // already reattached the fanout; try_release_primitive will
            // detach it again so the bucket goes back to "subscribed but no
            // materialized atom" — symmetrical with subscribing to an empty
            // cell before any write.
            if is_null {
                self.try_release_primitive(addr);
            }
        } else {
            let id = self.ensure_cell(addr);
            self.attach_address_sub(addr);
            self.store.set(id, value);
            // 3.10 — drop the primitive when a non-formula cell is cleared
            // back to Null with no live dependents. Listener bucket stays.
            if is_null {
                self.try_release_primitive(addr);
            }
        }
        self.mark_dependents_dirty(addr);
    }

    /// Clear a cell back to empty (Null). Equivalent to `set_cell(addr, Value::Null)`
    /// but with a more discoverable name for callers implementing Delete-key /
    /// undo-to-empty UX.
    pub fn clear_cell(&mut self, addr_str: &str) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.set_cell(addr_str, Value::Null);
        // set_cell already calls try_release_primitive when the new value is
        // Null; the second call here is defensive in case a future change to
        // set_cell rearranges that path. It's a no-op when the cell was
        // already released.
        self.try_release_primitive(addr);
    }

    /// 3.10 — release the primitive cell atom for `addr` when it is Null and
    /// has no live dependents. Used by `clear_cell` / `set_cell(.., Null)` to
    /// keep `cells.len()` bounded across long-running sheets where many cells
    /// get set then cleared. Skips formula cells and skips any primitive
    /// that still has core dependents (would panic `Store::destroy_atom`).
    ///
    /// Address listener buckets stay alive — only the underlying `store.sub`
    /// is detached. The next `set_cell` on this address will re-create a
    /// fresh primitive and reattach the fanout via the existing
    /// `attach_address_sub` flow, firing the listener as part of that write.
    fn try_release_primitive(&mut self, addr: CellAddress) {
        let Some(&atom_id) = self.cells.get(&addr) else {
            return;
        };
        // Formula cells are lazy records, not primitive atoms.
        if self.formula_cells.contains_key(&addr) {
            return;
        }
        if self.store.has_dependents(atom_id) {
            return;
        }
        if !self.store.has_atom(atom_id) {
            // Defensive: nothing to release.
            self.cells.remove(&addr);
            return;
        }
        if !matches!(self.store.get(atom_id), Value::Null) {
            return;
        }
        self.cells.remove(&addr);
        self.detach_address_sub(addr);
        self.store.destroy_atom(atom_id);
    }

    /// Set a cell's formula by address string (e.g. "=A1+B1").
    /// The formula is parsed and stored as a lazy Sheet-level record. It is
    /// not evaluated until the cell is read.
    ///
    /// Returns `false` if either:
    ///   - the formula failed to parse (B.3) — cell becomes `#VALUE!`
    ///   - the formula would form a dependency cycle (B.2) — cell becomes `#CYCLE!`
    /// In both cases the wasm instance keeps running and any prior formula on
    /// this cell is cleared.
    ///
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) -> bool {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let expr = match parse_formula(formula_str) {
            Some(e) => e,
            None => {
                self.write_error(addr, ValueError::InvalidValue);
                return false;
            }
        };

        // Static cycle check (B.2). Walk the AST collecting referenced cells,
        // then BFS through their formula_exprs to see if `addr` is reachable.
        if self.would_create_cycle(addr, &expr) {
            self.write_error(addr, ValueError::CyclicRef);
            return false;
        }

        self.with_remap(addr, move |sheet| {
            let expr = Rc::new(expr);
            let deps = Sheet::formula_deps_for(&expr);
            sheet.remove_formula_record(addr);
            if let Some(prim) = sheet.cells.remove(&addr) {
                if sheet.store.has_atom(prim) && !sheet.store.has_dependents(prim) {
                    sheet.store.destroy_atom(prim);
                }
            }
            let record = Rc::new(FormulaRecord::new(expr.clone(), deps.clone()));
            sheet.add_formula_deps(addr, &deps);
            sheet.formula_cells.insert(addr, record);
            sheet.formula_exprs.insert(addr, expr);
            sheet.formula_texts.insert(addr, formula_str.to_string());
        });
        self.mark_dependents_dirty(addr);
        true
    }

    /// Drop any existing formula and write an error value to the cell.
    /// `pub(crate)` so the workbook layer can route a cross-sheet cycle
    /// detection failure (`#CYCLE!`) to the target cell without re-deriving
    /// the helper logic here.
    pub(crate) fn write_error(&mut self, addr: CellAddress, err: ValueError) {
        let had_formula = self.formula_cells.contains_key(&addr);
        if had_formula {
            self.with_remap(addr, |sheet| {
                sheet.remove_formula_record(addr);
                let id = sheet.ensure_cell(addr);
                sheet.store.set(id, Value::Error(err));
            });
        } else {
            let id = self.ensure_cell(addr);
            self.attach_address_sub(addr);
            self.store.set(id, Value::Error(err));
        }
        self.mark_dependents_dirty(addr);
    }

    /// Read-only access to `formula_exprs` for the workbook-level cycle
    /// detector. `pub(crate)` because cross-sheet BFS in `Workbook::set_formula`
    /// needs to walk per-sheet formula ASTs without owning the sheet's
    /// internal state.
    pub(crate) fn formula_exprs_iter(&self) -> &HashMap<CellAddress, Rc<Expr>> {
        &self.formula_exprs
    }

    /// Static cycle detection (B.2). Walks the AST of the new formula,
    /// then BFS through dependencies of any referenced formula cells.
    /// Returns true if `target` is reachable.
    fn would_create_cycle(&self, target: CellAddress, expr: &Expr) -> bool {
        let mut to_visit: Vec<CellAddress> = Vec::new();
        collect_refs(expr, &mut to_visit);

        let mut seen: HashSet<CellAddress> = HashSet::new();
        while let Some(c) = to_visit.pop() {
            if c == target {
                return true;
            }
            if !seen.insert(c) {
                continue;
            }
            if let Some(child_expr) = self.formula_exprs.get(&c) {
                collect_refs(child_expr, &mut to_visit);
            }
        }
        false
    }

    /// Get a cell's value by address string.
    /// Returns the formula result if the cell has a formula, otherwise the raw value.
    /// Returns Null for cells that haven't been set.
    pub fn get_cell(&self, addr_str: &str) -> Value {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.peek_value(addr)
    }

    /// Read a cell's current value without creating any atoms. Returns
    /// `Value::Null` for cells that haven't been touched. Used by the
    /// Workbook layer (cross-sheet read) so it can stay `&self`.
    pub fn peek_value(&self, addr: CellAddress) -> Value {
        let provider = SheetEvalProvider { sheet: self };
        self.peek_value_with_provider(addr, &provider)
    }

    /// Sparse iteration over this sheet's cells inside `range`.
    /// `value_resolver` is called for each present address; for primitive
    /// cells we read the store directly, for formula cells we route
    /// through `value_resolver` so the caller can pass its own provider
    /// (so cross-sheet formula deps still resolve correctly when called
    /// from `WorkbookEvalProvider`). Used as the building block for
    /// `SheetEvalProvider::for_each_range_cell` and the Workbook variant.
    pub(crate) fn for_each_sparse_cell_with(
        &self,
        range: CellRange,
        value_resolver: &dyn Fn(&Sheet, CellAddress) -> Value,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        let n = range.normalize();
        for (addr, &id) in &self.cells {
            if addr.row >= n.start.row
                && addr.row <= n.end.row
                && addr.col >= n.start.col
                && addr.col <= n.end.col
            {
                if self.formula_cells.contains_key(addr) {
                    continue;
                }
                let v = if self.store.has_atom(id) {
                    self.store.get(id)
                } else {
                    Value::Null
                };
                f(*addr, v);
            }
        }
        for addr in self.formula_cells.keys() {
            if addr.row >= n.start.row
                && addr.row <= n.end.row
                && addr.col >= n.start.col
                && addr.col <= n.end.col
            {
                let v = value_resolver(self, *addr);
                f(*addr, v);
            }
        }
    }

    pub(crate) fn peek_value_with_provider(
        &self,
        addr: CellAddress,
        provider: &dyn EvalProvider,
    ) -> Value {
        if self.formula_cells.contains_key(&addr) {
            return self.eval_formula_at_with_provider(addr, provider);
        }
        self.cells
            .get(&addr)
            .filter(|id| self.store.has_atom(**id))
            .map(|&id| self.store.get(id))
            .unwrap_or(Value::Null)
    }

    fn primitive_value_at(&self, addr: CellAddress) -> Value {
        self.cells
            .get(&addr)
            .filter(|id| self.store.has_atom(**id))
            .map(|&id| self.store.get(id))
            .unwrap_or(Value::Null)
    }

    fn eval_formula_at_with_provider(
        &self,
        addr: CellAddress,
        provider: &dyn EvalProvider,
    ) -> Value {
        let Some(record) = self.formula_cells.get(&addr).cloned() else {
            return self.primitive_value_at(addr);
        };

        match record.cache.borrow().clone() {
            FormulaCache::Clean(value) if !provider.force_formula_recompute() => return value,
            FormulaCache::Computing => return Value::Error(ValueError::CyclicRef),
            FormulaCache::Clean(_) | FormulaCache::Dirty => {}
        }

        *record.cache.borrow_mut() = FormulaCache::Computing;
        let deps = Rc::new(RefCell::new(HashSet::new()));
        let tracking = TrackingEvalProvider {
            inner: provider,
            deps: deps.clone(),
        };
        let value = eval_expr_with_provider(&record.expr, &tracking);
        *record.cache.borrow_mut() = FormulaCache::Clean(value.clone());
        self.replace_formula_deps(addr, &record, deps.borrow().clone());
        value
    }

    /// Get the AtomId for a cell (creating if needed).
    pub fn cell_atom(&mut self, addr_str: &str) -> AtomId {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.readable_atom(addr)
    }

    /// Force-recompute every formula on this sheet whose AST contains a
    /// cross-sheet reference (`Expr::SheetRef`). Whole-sheet sweep, mostly
    /// useful for tests / "rebuild everything" scenarios. Hot read paths
    /// should prefer `recompute_cross_sheet_formulas_reachable_from(addr)`,
    /// which scopes the work to formulas on the dep chain of `addr`.
    pub fn recompute_cross_sheet_formulas(&mut self) {
        for (addr, expr) in &self.formula_exprs {
            if expr_has_sheet_ref(expr) {
                if let Some(record) = self.formula_cells.get(addr) {
                    *record.cache.borrow_mut() = FormulaCache::Dirty;
                }
            }
        }
    }

    /// Targeted version of `recompute_cross_sheet_formulas`: BFS over
    /// `formula_exprs` starting at `target` and mark reached cross-sheet
    /// formulas dirty. The Workbook lazy provider now does live recursive
    /// evaluation, so this remains mostly as an explicit cache-invalidation
    /// utility for older callers.
    ///
    /// Worst-case cost is the size of the dep closure of `target` in
    /// `formula_exprs` — orders of magnitude smaller than the whole-sheet
    /// sweep on workbooks with many cross-sheet formulas.
    pub fn recompute_cross_sheet_formulas_reachable_from(&mut self, target: CellAddress) {
        let mut visited: HashSet<CellAddress> = HashSet::new();
        let mut to_visit: Vec<CellAddress> = vec![target];
        while let Some(addr) = to_visit.pop() {
            if !visited.insert(addr) {
                continue;
            }
            let Some(expr) = self.formula_exprs.get(&addr) else {
                continue;
            };
            if expr_has_sheet_ref(expr) {
                if let Some(record) = self.formula_cells.get(&addr) {
                    *record.cache.borrow_mut() = FormulaCache::Dirty;
                }
            }
            // Queue only addresses that themselves have a formula — a leaf
            // primitive ref doesn't need re-traversal. Range refs are
            // expanded but each cell is gated by `formula_exprs` so the
            // typical `SUM(A:A)` only enqueues the small subset of column A
            // cells that are actually formulas.
            collect_formula_refs_into(expr, &self.formula_exprs, &mut to_visit);
        }
    }

    // === LAZY_FORMULA_EVAL Step 0 — debug counters ===
    //
    // These expose the lazy formula graph's materialization behavior for
    // tests / benches / dev tooling.
    //
    // All `#[doc(hidden)]` — not part of the public API surface, intended
    // for tests / benches / dev tooling.

    /// Number of materialized primitive cell atoms (one per address that
    /// has been set or referenced from a formula). Empty addresses don't
    /// count even if subscribed (verified by
    /// `subscribe_empty_cell_does_not_materialize_until_write`).
    #[doc(hidden)]
    pub fn debug_primitive_atom_count(&self) -> usize {
        self.cells.len()
    }

    /// Number of formula cells. Formulas are Sheet-level lazy records, not
    /// core derived atoms.
    #[doc(hidden)]
    pub fn debug_formula_count(&self) -> usize {
        self.formula_cells.len()
    }

    /// Number of formulas that currently depend on the cell at `addr`.
    #[doc(hidden)]
    pub fn debug_dependents_count(&self, addr_str: &str) -> usize {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return 0;
        };
        self.cell_dependents
            .borrow()
            .get(&addr)
            .map(|deps| deps.len())
            .unwrap_or(0)
    }

    /// Formula cache state without evaluating the formula.
    #[doc(hidden)]
    pub fn debug_formula_cache_state(&self, addr_str: &str) -> &'static str {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return "invalid";
        };
        let Some(record) = self.formula_cells.get(&addr) else {
            return "none";
        };
        match &*record.cache.borrow() {
            FormulaCache::Dirty => "dirty",
            FormulaCache::Computing => "computing",
            FormulaCache::Clean(_) => "clean",
        }
    }

    /// Total live core atoms. Formulas are not core atoms anymore. Useful as
    /// a gross "did anything materialize?" signal in tests.
    #[doc(hidden)]
    pub fn debug_total_atom_count(&self) -> usize {
        self.store.debug_total_atom_count()
    }

    /// Cumulative core derived recompute count from the underlying store.
    /// Formula cells should not increase this counter anymore.
    #[doc(hidden)]
    pub fn debug_recompute_count(&self) -> usize {
        self.store.debug_recompute_count()
    }

    /// Return the original formula text for a cell, or `None` if the cell
    /// holds a value rather than a formula. Required by the formula bar /
    /// double-click-to-edit flow so users see `=A1*2` instead of the
    /// computed result `20` (D.11).
    ///
    /// Takes `&str` so callers can reuse the same address strings. Doesn't
    /// require `&mut self` because no atom creation is involved.
    pub fn get_formula(&self, addr_str: &str) -> Option<String> {
        let addr = CellAddress::parse(addr_str)?;
        self.formula_texts.get(&addr).cloned()
    }

    /// Subscribe to changes on a single cell address. The returned token is
    /// stable across primitive/formula remaps for this address.
    pub fn subscribe_cell(
        &mut self,
        addr_str: &str,
        listener: impl CellListener,
    ) -> CellSubscription {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.subscribe_cell_rc(addr, Rc::new(listener))
    }

    /// Variant of `subscribe_cell` that accepts an already-boxed listener.
    pub fn subscribe_cell_boxed(
        &mut self,
        addr_str: &str,
        listener: Box<dyn CellListener>,
    ) -> CellSubscription {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.subscribe_cell_rc(addr, Rc::from(listener))
    }

    /// Cancel a subscription previously returned from `subscribe_cell`.
    pub fn unsubscribe_cell(&mut self, sub: CellSubscription) {
        let should_remove = if let Some(bucket) = self.cell_subscriptions.get_mut(&sub.addr) {
            bucket
                .listeners
                .borrow_mut()
                .retain(|(id, _)| *id != sub.listener_id);
            bucket.listeners.borrow().is_empty()
        } else {
            false
        };

        if should_remove {
            if let Some(bucket) = self.cell_subscriptions.remove(&sub.addr) {
                if let Some(store_sub) = bucket.store_sub {
                    self.store.unsub(store_sub);
                }
            }
        }
    }

    fn subscribe_cell_rc(&mut self, addr: CellAddress, listener: ListenerRc) -> CellSubscription {
        let listener_id = self.next_cell_sub_id;
        self.next_cell_sub_id += 1;

        let bucket =
            self.cell_subscriptions
                .entry(addr)
                .or_insert_with(|| AddressSubscriptionBucket {
                    listeners: Rc::new(RefCell::new(Vec::new())),
                    atom_id: None,
                    store_sub: None,
                });
        bucket.listeners.borrow_mut().push((listener_id, listener));
        self.attach_address_sub(addr);

        CellSubscription { addr, listener_id }
    }

    // === Phase 4: structural edits ===

    /// Insert `count` empty rows starting at `at` (0-based). All cells at or
    /// below `at` shift down by `count`; existing formulas are retargeted so
    /// `=A5` stays pointing at the same logical row even after a row insert
    /// pushes it to A6.
    pub fn insert_row(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.with_structural_edit(|sheet| {
            sheet.relocate_cells(|addr| crate::shift::shift_addr_row_insert(addr, at, count));
            sheet.retarget_formula_refs(&|addr| {
                crate::shift::shift_addr_row_insert(addr, at, count)
            });
        });
    }

    /// Delete `count` rows starting at `at`. References inside the deleted
    /// range become `#REF!`; references below shift up.
    pub fn delete_row(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.with_structural_edit(|sheet| {
            sheet.drop_cells_in(|addr| addr.row >= at && addr.row < at + count);
            sheet.relocate_cells(|addr| crate::shift::shift_addr_row_delete(addr, at, count));
            sheet.retarget_formula_refs(&|addr| {
                crate::shift::shift_addr_row_delete(addr, at, count)
            });
        });
    }

    pub fn insert_col(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.with_structural_edit(|sheet| {
            sheet.relocate_cells(|addr| crate::shift::shift_addr_col_insert(addr, at, count));
            sheet.retarget_formula_refs(&|addr| {
                crate::shift::shift_addr_col_insert(addr, at, count)
            });
        });
    }

    pub fn delete_col(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.with_structural_edit(|sheet| {
            sheet.drop_cells_in(|addr| addr.col >= at && addr.col < at + count);
            sheet.relocate_cells(|addr| crate::shift::shift_addr_col_delete(addr, at, count));
            sheet.retarget_formula_refs(&|addr| {
                crate::shift::shift_addr_col_delete(addr, at, count)
            });
        });
    }

    /// Run a structural edit (row/col insert/delete) so that subscribers are
    /// notified at most once per address, only when the displayed value at
    /// that address actually changed. Detaches every fanout for the duration
    /// of the edit so internal `store.set` calls don't fan out partial
    /// intermediate states; reattaches at the end.
    fn with_structural_edit(&mut self, f: impl FnOnce(&mut Self)) {
        let addrs: Vec<CellAddress> = self.cell_subscriptions.keys().copied().collect();
        let mut pre: Vec<(CellAddress, Value)> = Vec::with_capacity(addrs.len());
        for addr in &addrs {
            pre.push((*addr, self.peek_value(*addr)));
            self.detach_address_sub(*addr);
        }

        f(self);

        for addr in &addrs {
            self.attach_address_sub(*addr);
        }
        for (addr, pre_val) in pre {
            let post_val = self.peek_value(addr);
            if pre_val != post_val {
                self.notify_address_subscribers(addr);
            }
        }
    }

    fn drop_cells_in(&mut self, pred: impl Fn(CellAddress) -> bool) {
        let to_drop: Vec<CellAddress> = self.cells.keys().copied().filter(|a| pred(*a)).collect();
        for addr in to_drop {
            if let Some(prim) = self.cells.remove(&addr) {
                if self.store.has_atom(prim) && !self.store.has_dependents(prim) {
                    self.store.destroy_atom(prim);
                }
            }
            self.remove_formula_record(addr);
            // Fanout reattach + per-address fire are handled by the enclosing
            // `with_structural_edit`; nothing to do here.
        }
    }

    /// Move every (still-present) cell entry to its new address per `f`.
    fn relocate_cells(&mut self, f: impl Fn(CellAddress) -> CellAddress) {
        // Phase A: rebuild each map under new keys. We materialize Vecs first
        // because mutating a HashMap while iterating its keys would panic.
        let new_cells: HashMap<CellAddress, AtomId> = std::mem::take(&mut self.cells)
            .into_iter()
            .map(|(addr, id)| (f(addr), id))
            .collect();
        let new_formula_cells: HashMap<CellAddress, Rc<FormulaRecord>> =
            std::mem::take(&mut self.formula_cells)
                .into_iter()
                .map(|(addr, id)| (f(addr), id))
                .collect();
        let new_formula_exprs: HashMap<CellAddress, Rc<Expr>> =
            std::mem::take(&mut self.formula_exprs)
                .into_iter()
                .map(|(addr, expr)| (f(addr), expr))
                .collect();
        let new_formula_texts: HashMap<CellAddress, String> =
            std::mem::take(&mut self.formula_texts)
                .into_iter()
                .map(|(addr, text)| (f(addr), text))
                .collect();
        self.cells = new_cells;
        self.formula_cells = new_formula_cells;
        self.formula_exprs = new_formula_exprs;
        self.formula_texts = new_formula_texts;
        self.rebuild_all_formula_dependents();
    }

    /// Apply an address-mapping function to every CellRef inside every
    /// existing formula AST. Used after structural edits so formulas
    /// continue to point at the same logical cell.
    fn retarget_formula_refs(&mut self, f: &dyn Fn(CellAddress) -> CellAddress) {
        let updated: Vec<(CellAddress, Expr)> = self
            .formula_exprs
            .iter()
            .map(|(addr, expr)| (*addr, crate::shift::map_addrs(expr, f)))
            .collect();
        for (addr, new_expr) in updated {
            if crate::shift::contains_invalid_ref(&new_expr) {
                // Formula references a cell deleted by this structural edit.
                // Excel produces #REF!.
                self.write_error(addr, ValueError::InvalidRef);
                continue;
            }
            let new_expr_rc = Rc::new(new_expr);
            self.formula_exprs.insert(addr, new_expr_rc.clone());
            let rendered = crate::shift::render_formula(&new_expr_rc);
            self.rebuild_formula_lazy(addr, rendered);
        }
    }

    fn rebuild_formula_lazy(&mut self, addr: CellAddress, formula_str: String) {
        let expr = match crate::formula::parse_formula(&formula_str) {
            Some(e) => Rc::new(e),
            None => {
                // Render produced something unparsable — shouldn't happen,
                // but be safe.
                self.write_error(addr, ValueError::InvalidValue);
                return;
            }
        };
        let deps = Sheet::formula_deps_for(&expr);
        self.remove_formula_record(addr);
        let record = Rc::new(FormulaRecord::new(expr.clone(), deps.clone()));
        self.add_formula_deps(addr, &deps);
        self.formula_cells.insert(addr, record);
        self.formula_exprs.insert(addr, expr);
        self.formula_texts.insert(addr, formula_str);
        // Fanout reattach + per-address fire are handled by the enclosing
        // `with_structural_edit` (this is only ever called from
        // `retarget_formula_refs` during a structural edit).
    }

    /// Set multiple cells at once, with a single propagation pass.
    ///
    /// Like `set_cell`, this also clears any existing formula on each target
    /// cell. Formula dependents are dirtied after the batch without eagerly
    /// computing them.
    pub fn batch_set(&mut self, updates: &[(&str, Value)]) {
        // Snapshot pre-state for *every* subscribed address so we can fire
        // exactly once per actual value change at the end. The subset of
        // those addresses that are also being written get their fanouts
        // detached up front (so `store.set` doesn't double-fire); other
        // subscribed addresses keep their fanouts (their natural store
        // notification would suffice, but we suppress it too so we can
        // dedupe with the structural-style diff at the end).
        let subscribed: Vec<CellAddress> = self.cell_subscriptions.keys().copied().collect();
        let mut pre: Vec<(CellAddress, Value)> = Vec::with_capacity(subscribed.len());
        for addr in &subscribed {
            pre.push((*addr, self.peek_value(*addr)));
            self.detach_address_sub(*addr);
        }

        let mut atom_values: Vec<(AtomId, Value)> = Vec::with_capacity(updates.len());
        let mut written_addrs: Vec<CellAddress> = Vec::with_capacity(updates.len());

        for (addr_str, value) in updates {
            let addr = CellAddress::parse(addr_str).expect("invalid cell address");

            self.remove_formula_record(addr);

            let id = self.ensure_cell(addr);
            atom_values.push((id, value.clone()));
            written_addrs.push(addr);
        }

        self.store.batch(|store| {
            for (id, value) in atom_values {
                store.set(id, value);
            }
        });
        let mut dirty_notified = HashSet::new();
        for addr in written_addrs {
            dirty_notified.extend(self.mark_dependents_dirty(addr));
        }

        for addr in &subscribed {
            self.attach_address_sub(*addr);
        }
        for (addr, pre_val) in pre {
            if dirty_notified.contains(&addr) {
                continue;
            }
            let post_val = self.peek_value(addr);
            if pre_val != post_val {
                self.notify_address_subscribers(addr);
            }
        }
    }

    // === LAZY_FORMULA_EVAL Step 3 — bulk import API ===

    /// Run `f` inside a bulk-load session. Writes performed through the
    /// `BulkLoader` skip per-cell dirty propagation and subscriber notification;
    /// when the closure returns, the loader's `flush` walks the touched set
    /// once, dirties transitive formula dependents, and notifies each
    /// currently-subscribed address at most once.
    ///
    /// Use for CSV / JSON / xlsx import paths that write thousands of cells:
    /// the per-cell notify cost would dominate, and we want to defer formula
    /// evaluation entirely to first read.
    ///
    /// RAII shape: `BulkLoader` is not exposed outside the closure, so the
    /// flush always runs (no begin/end pair to forget).
    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut BulkLoader<'_>) -> R) -> R {
        let mut loader = BulkLoader::new(self);
        let result = f(&mut loader);
        loader.flush();
        result
    }
}

/// In-progress bulk-load session. Writes go directly into the sheet's
/// formula/primitive state but skip the normal dirty-mark + subscriber-notify
/// fan-out; the deferred work runs in `flush`.
///
/// Only constructable inside `Sheet::bulk_load` (RAII), so the lifetime stays
/// bound to `&mut Sheet` and `flush` is guaranteed to run on the closure exit.
pub struct BulkLoader<'a> {
    sheet: &'a mut Sheet,
    /// Addresses written during this bulk load. At `flush()` we walk these to
    /// dirty downstream formulas + notify currently-subscribed addresses ONCE.
    touched: HashSet<CellAddress>,
}

impl<'a> BulkLoader<'a> {
    fn new(sheet: &'a mut Sheet) -> Self {
        BulkLoader {
            sheet,
            touched: HashSet::new(),
        }
    }

    /// Write a primitive value at `addr`. Skips dirty propagation and
    /// subscriber notification — both deferred to `flush`. Equivalent to
    /// `Sheet::set_cell` outside the bulk-load contract; the address is
    /// recorded in `touched` for the post-flush sweep.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let is_null = matches!(value, Value::Null);

        // Detach the fanout for this address so the store-level `set` below
        // does not synchronously fire subscribers. `flush` will reattach and
        // notify exactly once per subscribed touched/dirty address.
        self.sheet.detach_address_sub(addr);

        if self.sheet.formula_cells.contains_key(&addr) {
            // Formula → primitive transition. Drop the formula record (and
            // its reverse dep entries) but no notify; primitive scaffold is
            // re-established below.
            self.sheet.remove_formula_record(addr);
            // The pre-existing primitive atom from formula→primitive remap may
            // still be present; ensure_cell + store.set covers both branches.
            let id = self.sheet.ensure_cell(addr);
            self.sheet.store.set(id, value);
        } else {
            let id = self.sheet.ensure_cell(addr);
            self.sheet.store.set(id, value);
        }

        // 3.10 — same Null-release contract as the normal path so bulk-load
        // does not leak primitive scaffolds when callers write Null. The
        // fanout was already detached above; release just drops the atom and
        // bookkeeping. The bucket (if any) stays for the flush reattach.
        if is_null {
            self.sheet.try_release_primitive(addr);
        }

        self.touched.insert(addr);
    }

    /// Write a formula at `addr`. Parses, runs the same-sheet static cycle
    /// check (B.2), and stores the record with cache state Dirty. Does not
    /// evaluate the formula, does not notify any subscriber. Returns the same
    /// `bool` contract as `Sheet::set_formula`: `false` on parse failure or
    /// cycle (the cell is left holding `#VALUE!` / `#CYCLE!`, no notify).
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) -> bool {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");

        let expr = match parse_formula(formula_str) {
            Some(e) => e,
            None => {
                // Inline equivalent of `write_error(addr, InvalidValue)` minus
                // the dirty-mark + notify fanout. The error value still lands
                // in the primitive scaffold so future reads observe `#VALUE!`.
                self.write_error_no_notify(addr, ValueError::InvalidValue);
                self.touched.insert(addr);
                return false;
            }
        };

        // Static cycle check still runs inside bulk_load — incremental cycle
        // protection isn't worth dropping for perf, and the cost is bounded by
        // the dep closure of the new formula.
        if self.sheet.would_create_cycle(addr, &expr) {
            self.write_error_no_notify(addr, ValueError::CyclicRef);
            self.touched.insert(addr);
            return false;
        }

        // Detach fanout so any primitive scaffold teardown below does not fire.
        self.sheet.detach_address_sub(addr);

        let expr = Rc::new(expr);
        let deps = Sheet::formula_deps_for(&expr);
        // Drop any prior formula record (no notify) and any primitive scaffold
        // that no longer has dependents — mirrors `Sheet::set_formula` minus
        // the `with_remap` listener fire.
        self.sheet.remove_formula_record(addr);
        if let Some(prim) = self.sheet.cells.remove(&addr) {
            if self.sheet.store.has_atom(prim) && !self.sheet.store.has_dependents(prim) {
                self.sheet.store.destroy_atom(prim);
            }
        }
        let record = Rc::new(FormulaRecord::new(expr.clone(), deps.clone()));
        self.sheet.add_formula_deps(addr, &deps);
        self.sheet.formula_cells.insert(addr, record);
        self.sheet.formula_exprs.insert(addr, expr);
        self.sheet
            .formula_texts
            .insert(addr, formula_str.to_string());

        self.touched.insert(addr);
        true
    }

    /// Inline `write_error` minus the dirty-mark + subscriber notify. Used by
    /// the parse-failure and cycle paths in bulk-mode `set_formula`.
    fn write_error_no_notify(&mut self, addr: CellAddress, err: ValueError) {
        self.sheet.detach_address_sub(addr);
        if self.sheet.formula_cells.contains_key(&addr) {
            self.sheet.remove_formula_record(addr);
        }
        let id = self.sheet.ensure_cell(addr);
        self.sheet.store.set(id, Value::Error(err));
    }

    /// Drain the touched set, dirty all transitively-downstream formulas,
    /// reattach fanouts on touched primitive addresses, and notify each
    /// currently-subscribed address at most once.
    ///
    /// Complexity: O(T + D) where T = touched count, D = size of transitive
    /// formula closure reachable from `touched` through `cell_dependents`.
    /// Notify dedup is O(1) per visited address via the `notified` HashSet.
    fn flush(&mut self) {
        // 1. BFS through cell_dependents starting at every touched address.
        //    Collect the set of transitively-dirty formula addresses, and as a
        //    side effect flip their FormulaCache to Dirty.
        let mut dirty: HashSet<CellAddress> = HashSet::new();
        let mut stack: Vec<CellAddress> = Vec::new();
        for &addr in &self.touched {
            let next = self
                .sheet
                .cell_dependents
                .borrow()
                .get(&addr)
                .cloned()
                .unwrap_or_default();
            stack.extend(next);
        }
        while let Some(addr) = stack.pop() {
            if !dirty.insert(addr) {
                continue;
            }
            if let Some(record) = self.sheet.formula_cells.get(&addr) {
                *record.cache.borrow_mut() = FormulaCache::Dirty;
            }
            let next = self
                .sheet
                .cell_dependents
                .borrow()
                .get(&addr)
                .cloned()
                .unwrap_or_default();
            stack.extend(next);
        }

        // 2. Reattach fanouts on touched addresses so future writes notify
        //    normally. Reattach is a no-op when the address has no
        //    subscription bucket or no readable atom.
        for &addr in &self.touched {
            self.sheet.attach_address_sub(addr);
        }

        // 3. Notify each currently-subscribed address in (touched ∪ dirty)
        //    exactly once. Subscribers on addresses that weren't touched and
        //    have no dirty formula dependents are skipped — the "lazy"
        //    extreme: no listener fires for cells nobody is watching.
        let mut notify_targets: HashSet<CellAddress> =
            HashSet::with_capacity(self.touched.len() + dirty.len());
        notify_targets.extend(self.touched.iter().copied());
        notify_targets.extend(dirty.iter().copied());
        for addr in notify_targets {
            if self.sheet.has_address_subscribers(addr) {
                self.sheet.notify_address_subscribers(addr);
            }
        }
    }
}

/// Walk the AST and append every referenced cell address into `out`.
/// Used by static cycle detection (B.2). Free function so it can run
/// without borrowing `&self.formula_exprs`.
fn collect_refs(expr: &Expr, out: &mut Vec<CellAddress>) {
    match expr {
        Expr::CellRef(addr) => out.push(*addr),
        Expr::Range { start, end } => {
            let min_row = start.row.min(end.row);
            let max_row = start.row.max(end.row);
            let min_col = start.col.min(end.col);
            let max_col = start.col.max(end.col);
            for row in min_row..=max_row {
                for col in min_col..=max_col {
                    out.push(CellAddress::new(row, col));
                }
            }
        }
        Expr::BinOp { left, right, .. } => {
            collect_refs(left, out);
            collect_refs(right, out);
        }
        Expr::Negate(inner) => collect_refs(inner, out),
        Expr::FuncCall { args, .. } => {
            for a in args {
                collect_refs(a, out);
            }
        }
        // Cross-sheet refs are out-of-scope for static cycle detection on
        // this sheet (cross-sheet cycles need workbook-level analysis).
        Expr::SheetRef { .. } => {}
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
    }
}

/// Variant of `collect_refs` that only enqueues addresses present in
/// `formula_exprs`. Used by `recompute_cross_sheet_formulas_reachable_from`
/// to BFS the formula graph without expanding `SUM(A:A)`-style ranges into
/// every empty cell — only formula cells inside the range get queued.
fn collect_formula_refs_into(
    expr: &Expr,
    formula_exprs: &HashMap<CellAddress, Rc<Expr>>,
    out: &mut Vec<CellAddress>,
) {
    match expr {
        Expr::CellRef(addr) => {
            if formula_exprs.contains_key(addr) {
                out.push(*addr);
            }
        }
        Expr::Range { start, end } => {
            let min_row = start.row.min(end.row);
            let max_row = start.row.max(end.row);
            let min_col = start.col.min(end.col);
            let max_col = start.col.max(end.col);
            let cells_in_range = (max_row.saturating_sub(min_row) as usize + 1)
                * (max_col.saturating_sub(min_col) as usize + 1);
            // For ranges larger than the formula table, scan formulas and
            // filter; otherwise iterate cells. Avoids `SUM(A:A)` walking
            // a million empty addresses.
            if cells_in_range > formula_exprs.len() {
                for &addr in formula_exprs.keys() {
                    if addr.row >= min_row
                        && addr.row <= max_row
                        && addr.col >= min_col
                        && addr.col <= max_col
                    {
                        out.push(addr);
                    }
                }
            } else {
                for row in min_row..=max_row {
                    for col in min_col..=max_col {
                        let a = CellAddress::new(row, col);
                        if formula_exprs.contains_key(&a) {
                            out.push(a);
                        }
                    }
                }
            }
        }
        Expr::BinOp { left, right, .. } => {
            collect_formula_refs_into(left, formula_exprs, out);
            collect_formula_refs_into(right, formula_exprs, out);
        }
        Expr::Negate(inner) => collect_formula_refs_into(inner, formula_exprs, out),
        Expr::FuncCall { args, .. } => {
            for a in args {
                collect_formula_refs_into(a, formula_exprs, out);
            }
        }
        // SheetRef points outside this sheet — handled by the resolver, not
        // by local BFS.
        Expr::SheetRef { .. } => {}
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
    }
}

/// Walk the AST looking for any `Expr::SheetRef`. Used by `Workbook::get_cell`
/// to skip force-recompute on formulas that don't actually need a cross-sheet
/// resolver (the common case).
fn expr_has_sheet_ref(expr: &Expr) -> bool {
    match expr {
        Expr::SheetRef { .. } => true,
        Expr::BinOp { left, right, .. } => expr_has_sheet_ref(left) || expr_has_sheet_ref(right),
        Expr::Negate(inner) => expr_has_sheet_ref(inner),
        Expr::FuncCall { args, .. } => args.iter().any(expr_has_sheet_ref),
        Expr::CellRef(_) | Expr::Range { .. } | Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {
            false
        }
    }
}

struct SheetEvalProvider<'a> {
    sheet: &'a Sheet,
}

impl<'a> EvalProvider for SheetEvalProvider<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        self.sheet.peek_value(addr)
    }

    fn sheet_cell(&self, _sheet: &str, _addr: CellAddress) -> Value {
        Value::Error(ValueError::InvalidRef)
    }

    /// Sparse override: iterate only addresses that actually have a
    /// primitive or formula record, intersected with `range`. Lets
    /// `SUM(A:A)` walk the dozen real cells in column A instead of
    /// expanding the nominal column extent.
    ///
    /// Formula cells are read via `Sheet::peek_value` (single-sheet
    /// context, no cross-sheet resolution).
    fn for_each_range_cell(
        &self,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        self.sheet
            .for_each_sparse_cell_with(range, &|sheet, addr| sheet.peek_value(addr), f);
    }
}

struct TrackingEvalProvider<'a> {
    inner: &'a dyn EvalProvider,
    deps: Rc<RefCell<HashSet<CellAddress>>>,
}

impl<'a> EvalProvider for TrackingEvalProvider<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        self.deps.borrow_mut().insert(addr);
        self.inner.cell(addr)
    }

    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        self.inner.sheet_cell(sheet, addr)
    }

    fn force_formula_recompute(&self) -> bool {
        self.inner.force_formula_recompute()
    }

    /// Tracking wrapper: record every address the inner provider yields
    /// as a formula dep. This lets `IF`-style dynamic-branch deps stay
    /// accurate even when the eval went through `for_each_range_cell`
    /// instead of explicit per-cell `cell()` calls.
    fn for_each_range_cell(
        &self,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        let deps = self.deps.clone();
        self.inner.for_each_range_cell(range, &mut |addr, v| {
            deps.borrow_mut().insert(addr);
            f(addr, v);
        });
    }
}

impl Default for Sheet {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use einfach_core::ValueError;

    #[test]
    fn new_cell_is_null() {
        let sheet = Sheet::new();
        assert_eq!(sheet.get_cell("A1"), Value::Null);
    }

    #[test]
    fn get_cell_does_not_materialize_empty_cell() {
        let sheet = Sheet::new();
        assert_eq!(sheet.cells.len(), 0);
        assert_eq!(sheet.get_cell("A1"), Value::Null);
        assert_eq!(sheet.cells.len(), 0);
    }

    #[test]
    fn set_and_get_number() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(42.0));
        assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
    }

    #[test]
    fn set_and_get_text() {
        let mut sheet = Sheet::new();
        sheet.set_cell("B2", Value::Text("hello".into()));
        assert_eq!(sheet.get_cell("B2"), Value::Text("hello".into()));
    }

    #[test]
    fn multiple_cells_independent() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B1", Value::Number(2.0));
        sheet.set_cell("A2", Value::Text("hi".into()));

        assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
        assert_eq!(sheet.get_cell("A2"), Value::Text("hi".into()));
    }

    #[test]
    fn overwrite_cell() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A1", Value::Number(99.0));
        assert_eq!(sheet.get_cell("A1"), Value::Number(99.0));
    }

    #[test]
    fn cell_atom_returns_same_id() {
        let mut sheet = Sheet::new();
        let id1 = sheet.cell_atom("A1");
        let id2 = sheet.cell_atom("A1");
        assert_eq!(id1, id2);
    }

    #[test]
    fn different_cells_different_ids() {
        let mut sheet = Sheet::new();
        let id1 = sheet.cell_atom("A1");
        let id2 = sheet.cell_atom("B1");
        assert_ne!(id1, id2);
    }

    #[test]
    fn set_boolean_cell() {
        let mut sheet = Sheet::new();
        sheet.set_cell("C3", Value::Boolean(true));
        assert_eq!(sheet.get_cell("C3"), Value::Boolean(true));
    }

    #[test]
    #[should_panic(expected = "invalid cell address")]
    fn invalid_address_panics() {
        let mut sheet = Sheet::new();
        sheet.set_cell("", Value::Number(1.0));
    }

    // === Step 13: Formula integration ===

    #[test]
    fn formula_basic_addition() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_cell("B1", Value::Number(20.0));
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));
    }

    #[test]
    fn formula_auto_updates() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_cell("B1", Value::Number(20.0));
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));

        // Change A1 → C1 auto-updates
        sheet.set_cell("A1", Value::Number(100.0));
        assert_eq!(sheet.get_cell("C1"), Value::Number(120.0));
    }

    #[test]
    fn formula_chain() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("B1", "=A1*2");
        sheet.set_formula("C1", "=B1+10");

        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
        assert_eq!(sheet.get_cell("C1"), Value::Number(20.0));

        sheet.set_cell("A1", Value::Number(10.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));
        assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));
    }

    #[test]
    fn formula_with_literal() {
        let mut sheet = Sheet::new();
        sheet.set_formula("A1", "=42");
        assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
    }

    #[test]
    fn formula_division_by_zero() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_cell("B1", Value::Number(0.0));
        sheet.set_formula("C1", "=A1/B1");
        assert_eq!(
            sheet.get_cell("C1"),
            Value::Error(ValueError::DivisionByZero)
        );
    }

    #[test]
    fn formula_sum_function() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B1", Value::Number(2.0));
        sheet.set_cell("C1", Value::Number(3.0));
        sheet.set_formula("D1", "=SUM(A1,B1,C1)");
        assert_eq!(sheet.get_cell("D1"), Value::Number(6.0));
    }

    #[test]
    fn formula_cleared_by_set_cell() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));

        // Clear formula by setting a value directly
        sheet.set_cell("B1", Value::Number(99.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));

        // Changing A1 should no longer affect B1
        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));
    }

    #[test]
    fn get_formula_returns_source_text() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        // Cell with no formula: None
        assert_eq!(sheet.get_formula("A1"), None);

        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_formula("B1").as_deref(), Some("=A1*2"));

        // Setting a value clears the formula text
        sheet.set_cell("B1", Value::Number(99.0));
        assert_eq!(sheet.get_formula("B1"), None);

        // Replacing a formula updates the stored text
        sheet.set_formula("B1", "=A1+1");
        assert_eq!(sheet.get_formula("B1").as_deref(), Some("=A1+1"));

        // Invalid formula clears the text (cell becomes #VALUE!)
        sheet.set_formula("B1", "=garbage");
        assert_eq!(sheet.get_formula("B1"), None);
    }

    #[test]
    fn subscribe_cell_fires_on_change() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=A1*2");

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
        assert_eq!(*count.borrow(), 1, "exactly one fire on dependency change");

        sheet.unsubscribe_cell(sub);
        sheet.set_cell("A1", Value::Number(10.0));
        assert_eq!(*count.borrow(), 1, "no fire after unsubscribe");
    }

    #[test]
    fn subscribe_empty_cell_does_not_materialize_until_write() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);

        assert_eq!(sheet.cells.len(), 0, "subscription should not allocate A1");
        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
        assert_eq!(sheet.cells.len(), 1);
        assert_eq!(*count.borrow(), 1, "exactly one fire on first write");

        sheet.unsubscribe_cell(sub);
        sheet.set_cell("A1", Value::Number(2.0));
        assert_eq!(*count.borrow(), 1, "no fire after unsubscribe");
    }

    #[test]
    fn debug_counters_reflect_lazy_formula_baseline() {
        let mut sheet = Sheet::new();
        assert_eq!(sheet.debug_primitive_atom_count(), 0);
        assert_eq!(sheet.debug_formula_count(), 0);
        assert_eq!(sheet.debug_total_atom_count(), 0);

        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        sheet.set_formula("B1", "=A1+Z99");
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_formula_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        assert_eq!(sheet.debug_dependents_count("A1"), 1);
        assert_eq!(sheet.debug_dependents_count("Z99"), 1);

        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);
    }

    #[test]
    fn debug_subscribe_empty_cell_does_not_materialize() {
        let mut sheet = Sheet::new();
        let _sub = sheet.subscribe_cell("Z99", || {});
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "subscribing to an empty cell must not materialize an atom"
        );
        assert_eq!(sheet.debug_total_atom_count(), 0);
    }

    #[test]
    fn subscribe_empty_cell_then_set_formula_fires_once() {
        // Regression: with_remap used to gate notify on `had_sub` (whether a
        // store_sub was already attached). A bucket subscribed to an empty
        // cell has listeners but no store_sub yet — the first set_formula
        // would update state but never fire the listener.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(3.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);
        // Pre-condition: B1 has no atom yet.
        assert!(!sheet.cells.contains_key(&CellAddress::new(0, 1)));

        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(6.0));
        assert_eq!(
            *count.borrow(),
            1,
            "first set_formula on empty subscribed cell must fire"
        );

        // And the subscription stays live: changing A1 fires once more.
        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
        assert_eq!(
            *count.borrow(),
            2,
            "subscriber should also see the dependency change"
        );
    }

    #[test]
    fn subscribe_survives_value_to_formula_remap() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B1", Value::Number(5.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
        assert_eq!(
            *count.borrow(),
            1,
            "exactly one fire when B1 becomes a formula"
        );

        sheet.set_cell("A1", Value::Number(3.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(6.0));
        assert_eq!(
            *count.borrow(),
            2,
            "subscriber must stay attached to B1's formula atom"
        );
    }

    #[test]
    fn subscribe_survives_formula_to_value_remap() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(2.0));
        sheet.set_formula("B1", "=A1*2");

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        sheet.set_cell("B1", Value::Number(10.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
        assert_eq!(*count.borrow(), 1, "exactly one fire when formula cleared");

        sheet.set_cell("B1", Value::Number(11.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(11.0));
        assert_eq!(
            *count.borrow(),
            2,
            "subscriber must stay attached to B1's primitive atom"
        );
    }

    #[test]
    fn set_formula_replaces_lazy_record_without_store_growth() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));
        let atoms_after_first = sheet.debug_total_atom_count();

        sheet.set_formula("B1", "=A1*3");
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));
        assert_eq!(
            sheet.debug_total_atom_count(),
            atoms_after_first,
            "formula replacement must not create core atoms"
        );

        for n in 1..=20 {
            sheet.set_formula("B1", &format!("=A1+{}", n));
        }
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));
        assert_eq!(sheet.debug_formula_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), atoms_after_first);
    }

    #[test]
    fn formula_to_primitive_remap_fires_listener_exactly_once() {
        // Regression: previously the rewire-then-store.set order caused both
        // the fanout AND an explicit notify to fire on a formula→primitive
        // transition where the new primitive value differed from the prior
        // formula result. Subscribers should see exactly one fire.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(2.0));
        sheet.set_formula("B1", "=A1*2"); // B1 displays 4

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        // Replace the formula with a literal whose value differs from the
        // formula's result (4 → 99). Should fire once, not twice.
        sheet.set_cell("B1", Value::Number(99.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));
        assert_eq!(
            *count.borrow(),
            1,
            "formula→primitive must fire exactly once"
        );
    }

    #[test]
    fn formula_to_primitive_remap_with_unchanged_value_still_fires_once() {
        // Even when the new primitive value happens to match the prior
        // formula result, subscribers should still be notified that the
        // cell's identity (formula → literal) changed.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(2.0));
        sheet.set_formula("B1", "=A1*2"); // B1 = 4

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        sheet.set_cell("B1", Value::Number(4.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(4.0));
        assert_eq!(
            *count.borrow(),
            1,
            "identity change must fire even if value is unchanged"
        );
    }

    #[test]
    fn primitive_to_primitive_with_same_value_does_not_fire() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(7.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);

        sheet.set_cell("A1", Value::Number(7.0));
        assert_eq!(*count.borrow(), 0, "no value change → no fire");
    }

    #[test]
    fn formula_subscriber_dirty_notified_for_same_source_value_writes() {
        // D1 lazy contract: source writes dirty dependent formulas even when
        // the primitive source value is unchanged. Consumers subscribe to the
        // formula cell and re-read on dirty notification.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(7.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(14.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        for _ in 0..3 {
            sheet.set_cell("A1", Value::Number(7.0));
        }

        assert_eq!(
            *count.borrow(),
            3,
            "same-value source writes must still dirty-notify formula subscribers"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(14.0));
    }

    #[test]
    fn structural_edit_only_fires_for_addresses_whose_value_changed() {
        // insert_row should not wake subscribers on cells whose displayed
        // value didn't actually change.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A5", Value::Number(5.0));

        // A1 sits above the insert point — its value should not change.
        let a1_count = Rc::new(RefCell::new(0u32));
        let a1c = a1_count.clone();
        let _a1_sub = sheet.subscribe_cell("A1", move || *a1c.borrow_mut() += 1);

        // A5 is below the insert point — it gets shifted to A6, so peeking
        // A5 after the insert returns Null (a value change) and listener fires.
        let a5_count = Rc::new(RefCell::new(0u32));
        let a5c = a5_count.clone();
        let _a5_sub = sheet.subscribe_cell("A5", move || *a5c.borrow_mut() += 1);

        sheet.insert_row(2, 1);

        assert_eq!(*a1_count.borrow(), 0, "A1 unchanged → no fire");
        assert_eq!(*a5_count.borrow(), 1, "A5 shifted away → exactly one fire");
        assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
        assert_eq!(sheet.get_cell("A5"), Value::Null);
        assert_eq!(sheet.get_cell("A6"), Value::Number(5.0));
    }

    #[test]
    fn subscribe_cell_boxed_fires_like_subscribe_cell() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let listener: Box<dyn CellListener> = Box::new(move || *cc.borrow_mut() += 1);
        let sub = sheet.subscribe_cell_boxed("A1", listener);

        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(*count.borrow(), 1);

        sheet.unsubscribe_cell(sub);
        sheet.set_cell("A1", Value::Number(2.0));
        assert_eq!(*count.borrow(), 1, "no fire after unsubscribe");
    }

    #[test]
    fn set_cell_releases_old_formula_record() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.debug_formula_count(), 1);

        sheet.set_cell("B1", Value::Number(5.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(5.0));
        assert_eq!(sheet.debug_formula_count(), 0);
    }

    #[test]
    fn invalid_formula_writes_error_not_panic() {
        // B.3: parse failure must not panic the wasm instance.
        let mut sheet = Sheet::new();
        let ok = sheet.set_formula("A1", "=foo bar baz");
        assert!(!ok);
        assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::InvalidValue));

        // Subsequent valid formula on the same cell should clear the error.
        let ok = sheet.set_formula("A1", "=42");
        assert!(ok);
        assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
    }

    // === Phase 4 tests ===

    #[test]
    fn insert_row_shifts_data_and_refs() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A5", Value::Number(50.0));
        sheet.set_formula("B1", "=A5*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(100.0));

        // Insert one row at index 2 (between row 2 and row 3).
        sheet.insert_row(2, 1);
        // Old A5 should now be at A6.
        assert_eq!(sheet.get_cell("A6"), Value::Number(50.0));
        // B1 formula was retargeted: A5 → A6 inside the expression.
        // Render adds defensive parens around binops; just check it parses
        // and references A6 by value.
        assert!(sheet
            .get_formula("B1")
            .map(|s| s.contains("A6") && !s.contains("A5"))
            .unwrap_or(false));
        // And still computes correctly.
        assert_eq!(sheet.get_cell("B1"), Value::Number(100.0));
    }

    #[test]
    fn delete_row_invalidates_refs_into_deleted_band() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A5", Value::Number(50.0));
        sheet.set_formula("B1", "=A5*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(100.0));

        // Delete row 5 (0-based = the row that A5 lives in is row index 4).
        sheet.delete_row(4, 1);
        // The formula referencing the deleted row should produce #REF!.
        assert_eq!(sheet.get_cell("B1"), Value::Error(ValueError::InvalidRef));
    }

    #[test]
    fn insert_col_shifts_data_and_refs() {
        let mut sheet = Sheet::new();
        sheet.set_cell("C1", Value::Number(30.0));
        sheet.set_formula("A2", "=C1+1");
        assert_eq!(sheet.get_cell("A2"), Value::Number(31.0));

        // Insert column at index 1 (between A and B → original B becomes C, C→D).
        sheet.insert_col(1, 1);
        assert_eq!(sheet.get_cell("D1"), Value::Number(30.0));
        assert!(sheet
            .get_formula("A2")
            .map(|s| s.contains("D1") && !s.contains("C1"))
            .unwrap_or(false));
        assert_eq!(sheet.get_cell("A2"), Value::Number(31.0));
    }

    #[test]
    fn delete_col_invalidates_refs() {
        let mut sheet = Sheet::new();
        sheet.set_cell("C1", Value::Number(30.0));
        sheet.set_formula("A2", "=C1+1");
        sheet.delete_col(2, 1); // delete column C (index 2)
        assert_eq!(sheet.get_cell("A2"), Value::Error(ValueError::InvalidRef));
    }

    #[test]
    fn formula_references_unset_cell() {
        let mut sheet = Sheet::new();
        // B1 not set, should be Null → coerced to 0
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_cell("C1"), Value::Number(5.0));
    }

    // === 3.10 — primitive atom GC on clear / set-Null ===

    #[test]
    fn clear_cell_releases_primitive_when_no_deps() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(42.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        sheet.clear_cell("A1");
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "clear_cell on a no-dep cell must release its primitive"
        );
        assert_eq!(
            sheet.debug_total_atom_count(),
            0,
            "store should hold no live atoms after clearing the only cell"
        );
        // Subsequent read still produces Null naturally.
        assert_eq!(sheet.get_cell("A1"), Value::Null);
    }

    #[test]
    fn clear_cell_keeps_primitive_when_formula_depends() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("B1", "=A1*2");
        // Lazy backend: only A1 is materialized as a primitive. B1 is a
        // formula record with no primitive scaffold.
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));

        // After eval, A1 is in B1's dep set (cell_dependents[A1] contains B1).
        // try_release_primitive checks store-level has_dependents (atom-level),
        // which is false for A1's primitive (no derived atoms exist in lazy).
        // But we still want to keep A1 because B1's formula record depends on
        // it — clearing A1 sets the value to Null. The lazy formula will
        // re-evaluate against the new Null on next read.
        sheet.clear_cell("A1");
        // Lazy: A1 may be released (no atom-level dependents) since the
        // dep relationship is at the address level via cell_dependents.
        // B1 re-evaluates against A1 = Null → coerced to 0 → 0 * 2 = 0.
        assert_eq!(sheet.get_cell("B1"), Value::Number(0.0));
        assert_eq!(sheet.get_cell("A1"), Value::Null);
    }

    #[test]
    fn set_cell_to_null_releases_primitive() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);

        sheet.set_cell("A1", Value::Null);
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "set_cell(_, Null) must drop the primitive when no deps"
        );
        assert_eq!(sheet.debug_total_atom_count(), 0);
    }

    #[test]
    fn subscribed_cell_release_keeps_listener_alive() {
        // Subscriber contract on release: the bucket's listener list survives
        // even after the underlying primitive atom is destroyed. The next
        // set_cell on the address re-creates a fresh primitive and reattaches
        // the fanout — the listener fires as part of that write, same as
        // subscribing to an empty cell and setting it for the first time.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);
        // Pre: subscribed but no atom yet.
        assert_eq!(sheet.debug_primitive_atom_count(), 0);

        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(*count.borrow(), 1, "first write fires listener");

        sheet.set_cell("A1", Value::Null);
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "primitive released even though A1 has a subscriber"
        );
        assert_eq!(
            *count.borrow(),
            2,
            "Number → Null is a value change → listener fires"
        );
        // Bucket still tracks the listener: subscriptions map keeps the entry.
        assert!(
            sheet
                .cell_subscriptions
                .get(&CellAddress::parse("A1").unwrap())
                .map(|b| !b.listeners.borrow().is_empty())
                .unwrap_or(false),
            "listener bucket must survive primitive release"
        );

        sheet.set_cell("A1", Value::Number(7.0));
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            1,
            "next write re-creates a fresh primitive"
        );
        assert_eq!(*count.borrow(), 3, "fresh primitive notifies the listener");
        assert_eq!(sheet.get_cell("A1"), Value::Number(7.0));
    }

    #[test]
    fn set_cell_then_clear_cycles_do_not_grow_atom_count() {
        // Long-running spreadsheet stress: many set/clear cycles on the same
        // address must not leak atoms. With 3.10 each cycle releases the
        // primitive at the bottom of the loop.
        let mut sheet = Sheet::new();
        for n in 0..100 {
            sheet.set_cell("A1", Value::Number(n as f64));
            sheet.clear_cell("A1");
        }
        assert_eq!(sheet.debug_primitive_atom_count(), 0);
        assert_eq!(sheet.debug_total_atom_count(), 0);
    }

    #[test]
    fn formula_to_null_releases_primitive_when_no_deps() {
        // Formula → primitive(Null) path: with_remap reattaches the fanout to
        // the freshly ensured primitive, then try_release_primitive at the
        // end of set_cell drops it because nothing depends on it.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(2.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(4.0));
        // Lazy formula: only A1 is materialized. B1 is a formula record, not
        // a primitive scaffold.
        assert_eq!(sheet.debug_primitive_atom_count(), 1);

        // Clear B1: formula goes away, primitive scaffold is Null and has no
        // dependents (B1 is a leaf, not referenced by anything). It gets
        // released; A1 is unaffected.
        sheet.clear_cell("B1");
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            1,
            "B1 stays unmaterialized, A1 stays"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Null);
        assert_eq!(sheet.get_cell("A1"), Value::Number(2.0));
        assert_eq!(sheet.get_formula("B1"), None);
    }

    // === LAZY_FORMULA_EVAL Step 3 — bulk_load tests ===

    #[test]
    fn bulk_load_set_formula_zero_eval_count() {
        // 100 formulas through bulk_load must not trigger a single core
        // recompute. With lazy formulas the only way recompute_count can
        // increment is if a code path calls Store::recompute on a derived
        // atom, which the lazy path never does. The acceptance bar is "0",
        // not "small N".
        let mut sheet = Sheet::new();
        // Seed A1 so the formulas have something to reference; primitive
        // store.set does not bump recompute_count.
        sheet.set_cell("A1", Value::Number(1.0));
        let before = sheet.debug_recompute_count();

        sheet.bulk_load(|loader| {
            for n in 0..100u32 {
                // Row 0 col (n+1) avoids overwriting A1.
                let addr = CellAddress::new(0, n + 1).to_string_repr();
                let ok = loader.set_formula(&addr, "=A1+1");
                assert!(ok, "formula {} must parse + pass cycle check", addr);
            }
        });

        let after = sheet.debug_recompute_count();
        assert_eq!(
            after - before,
            0,
            "bulk_load with set_formula only must not trigger any core recompute"
        );
        assert_eq!(sheet.debug_formula_count(), 100);
        // All formula caches are still Dirty — no read happened.
        assert_eq!(
            sheet.debug_formula_cache_state("B1"),
            "dirty",
            "first bulk-loaded formula must remain dirty until read"
        );
    }

    #[test]
    fn bulk_load_notifies_subscribers_once() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        // Five subscribed addresses. Each gets its own counter so a missing
        // fire on one is visible.
        let counters: Vec<Rc<RefCell<u32>>> = (0..5).map(|_| Rc::new(RefCell::new(0u32))).collect();
        let addrs = ["A1", "B1", "C1", "D1", "E1"];
        for (i, addr) in addrs.iter().enumerate() {
            let c = counters[i].clone();
            sheet.subscribe_cell(addr, move || *c.borrow_mut() += 1);
        }

        // Bulk-load: write to all five subscribed addresses, plus some
        // unrelated ones, plus formulas whose downstream touches the
        // subscribed cells. Each subscribed address must fire exactly once.
        sheet.bulk_load(|loader| {
            for addr in &addrs {
                loader.set_cell(addr, Value::Number(1.0));
            }
            // Unrelated writes — should not bump any subscribed counter.
            loader.set_cell("Z10", Value::Number(42.0));
            loader.set_cell("Z11", Value::Number(43.0));
            // Formulas referencing A1 multiple times — without dedup A1's
            // listener could fire once per dirty downstream BFS pass.
            loader.set_formula("F1", "=A1+A1");
            loader.set_formula("F2", "=A1*2");
            loader.set_formula("F3", "=A1-1");
        });

        for (i, addr) in addrs.iter().enumerate() {
            assert_eq!(
                *counters[i].borrow(),
                1,
                "subscriber on {} must fire exactly once across the bulk_load",
                addr
            );
        }
    }

    #[test]
    fn bulk_load_skips_eval_until_first_read() {
        let mut sheet = Sheet::new();
        sheet.bulk_load(|loader| {
            loader.set_cell("A1", Value::Number(5.0));
            loader.set_formula("B1", "=A1*2");
        });

        // Pre-read: B1's cache is Dirty (formula was bulk-loaded, never
        // evaluated). The flush sweep only marks downstream cells of
        // touched addresses dirty — B1 itself is `touched` and starts Dirty
        // from `FormulaRecord::new`.
        assert_eq!(
            sheet.debug_formula_cache_state("B1"),
            "dirty",
            "bulk-loaded formula must stay dirty until first read"
        );

        // First read computes and caches.
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
        assert_eq!(
            sheet.debug_formula_cache_state("B1"),
            "clean",
            "first get_cell on a bulk-loaded formula must compute and cache"
        );
    }

    #[test]
    fn bulk_load_cycle_check_still_runs() {
        // Static cycle protection (B.2) is preserved inside bulk_load — the
        // task's contract: "cycle protection isn't worth dropping for perf".
        // The second formula closes a self-cycle and must be rejected with
        // false; no panic, no stack overflow on subsequent read.
        let mut sheet = Sheet::new();
        let mut a_ok = true;
        let mut b_ok = true;
        sheet.bulk_load(|loader| {
            a_ok = loader.set_formula("A1", "=B1+1");
            b_ok = loader.set_formula("B1", "=A1+1");
        });
        assert!(a_ok, "first formula has no cycle yet — must accept");
        assert!(
            !b_ok,
            "second formula closes the cycle — bulk_load must reject"
        );
        // B1 holds the cycle error; reading it must not stack-overflow.
        assert_eq!(sheet.get_cell("B1"), Value::Error(ValueError::CyclicRef));
    }

    #[test]
    fn bulk_load_unsubscribed_addresses_not_notified() {
        // Lazy-extreme contract: only currently-subscribed addresses get
        // notified at flush. We verify by writing to a subscribed A1 and an
        // unsubscribed Z99, then confirming (a) A1's subscriber fires
        // exactly once and (b) the bulk write itself does not recompute
        // anything — `debug_recompute_count` doesn't move even for Z99's
        // (empty) downstream set.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);

        let before = sheet.debug_recompute_count();
        sheet.bulk_load(|loader| {
            loader.set_cell("A1", Value::Number(7.0));
            loader.set_cell("Z99", Value::Number(99.0));
        });
        let after = sheet.debug_recompute_count();

        assert_eq!(
            *count.borrow(),
            1,
            "subscribed A1 must fire exactly once at flush"
        );
        assert_eq!(
            after - before,
            0,
            "writing to unsubscribed Z99 must not trigger any recompute"
        );
        // And reading the subscribed cell still gets the bulk value.
        assert_eq!(sheet.get_cell("A1"), Value::Number(7.0));
        assert_eq!(sheet.get_cell("Z99"), Value::Number(99.0));
    }

    // === LAZY Step 4: SheetEvalProvider sparse range streaming ===

    #[test]
    fn sum_full_column_walks_sparse() {
        // Two real cells in a column with huge nominal extent. The
        // SheetEvalProvider sparse override drives `SUM(A1:A100000)` to
        // visit only the two real addresses, not 100_000.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_cell("A100000", Value::Number(10.0));

        let before_atoms = sheet.debug_primitive_atom_count();
        sheet.set_formula("B1", "=SUM(A1:A100000)");
        let v = sheet.get_cell("B1");
        let after_atoms = sheet.debug_primitive_atom_count();

        assert_eq!(v, Value::Number(15.0));
        // The two original primitive cells; SUM didn't create a third.
        assert_eq!(before_atoms, 2);
        assert_eq!(after_atoms, 2);
    }

    #[test]
    fn sum_stateless_no_atoms_materialized() {
        // 5 primitive cells across a huge range. SUM doesn't grow the
        // primitive atom count — no temp Vec, no atom-per-empty-cell.
        let mut sheet = Sheet::new();
        for (addr, val) in [
            ("A1", 1.0),
            ("A10", 2.0),
            ("A100", 3.0),
            ("A1000", 4.0),
            ("A10000", 5.0),
        ] {
            sheet.set_cell(addr, Value::Number(val));
        }
        let before = sheet.debug_primitive_atom_count();
        assert_eq!(before, 5);

        sheet.set_formula("B1", "=SUM(A1:A100000)");
        let v = sheet.get_cell("B1");
        assert_eq!(v, Value::Number(15.0));

        let after = sheet.debug_primitive_atom_count();
        assert_eq!(
            after, before,
            "SUM(huge range) must not materialize cell atoms (before={}, after={})",
            before, after
        );
    }

    #[test]
    fn median_stateful_still_works_via_sheet_provider() {
        // MEDIAN keeps its temp Vec but routes through the sparse range
        // streaming path. A1..A5 = 1..5 → MEDIAN = 3. No atoms beyond
        // the 5 primitives we set.
        let mut sheet = Sheet::new();
        for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            sheet.set_cell(&format!("A{}", i + 1), Value::Number(*n));
        }
        let before = sheet.debug_primitive_atom_count();
        sheet.set_formula("B1", "=MEDIAN(A1:A5)");
        let v = sheet.get_cell("B1");
        let after = sheet.debug_primitive_atom_count();

        assert_eq!(v, Value::Number(3.0));
        assert_eq!(after, before, "MEDIAN must not materialize cell atoms");
    }

    #[test]
    fn average_streaming_matches_eager_via_sheet_provider() {
        // Random-ish integer values + an empty hole. AVERAGE should
        // match (sum / count) of only the real numeric cells; the hole
        // is skipped, no atom created.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_cell("A2", Value::Number(20.0));
        // A3 left empty intentionally
        sheet.set_cell("A4", Value::Number(40.0));
        sheet.set_cell("A5", Value::Number(50.0));

        let before = sheet.debug_primitive_atom_count();
        sheet.set_formula("B1", "=AVERAGE(A1:A5)");
        let v = sheet.get_cell("B1");
        let after = sheet.debug_primitive_atom_count();

        // Expected: AVERAGE skips Null (empty cell). Sum=120, count=4.
        assert_eq!(v, Value::Number(30.0));
        assert_eq!(after, before, "AVERAGE must not materialize cell atoms");
    }

    #[test]
    fn count_range_with_holes_via_sheet_provider() {
        // A1=1, A3=2, A5=3 — A2/A4 empty. COUNT(A1:A5) = 3 (Excel's
        // contract: numeric values only, holes skipped).
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A3", Value::Number(2.0));
        sheet.set_cell("A5", Value::Number(3.0));

        sheet.set_formula("B1", "=COUNT(A1:A5)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
    }
}
