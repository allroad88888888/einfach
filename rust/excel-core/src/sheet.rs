use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use einfach_core::{AtomId, CellListener, Store, SubscriptionId, Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::eval_expr;
use crate::formula::{parse_formula, Expr};

/// Shared, mutable map of cell address → readable atom id.
/// "Readable" means the formula derived atom if the cell has a formula,
/// otherwise the primitive cell atom. Sharing via `Rc<RefCell>` lets
/// already-created derived closures see later updates (B.1 fix).
type ReadableMap = Rc<RefCell<HashMap<CellAddress, AtomId>>>;

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

/// Token returned by `Sheet::subscribe_cell`. The public subscription is tied
/// to a cell address, not the current readable atom. `Sheet` rewires the
/// internal store subscription whenever the address switches between primitive
/// and formula atoms.
#[derive(Clone, Copy, Debug)]
pub struct CellSubscription {
    addr: CellAddress,
    listener_id: u64,
}

/// A spreadsheet sheet backed by an atom store.
pub struct Sheet {
    pub(crate) store: Store,
    pub(crate) cells: HashMap<CellAddress, AtomId>,
    /// Cells that have formulas (the formula atom replaces the cell atom)
    pub(crate) formula_cells: HashMap<CellAddress, AtomId>,
    /// Live cell → readable-atom map shared with every derived closure.
    /// Updated whenever a cell's primitive or formula atom changes (B.1).
    readable: ReadableMap,
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
    next_cell_sub_id: u64,
}

impl Sheet {
    pub fn new() -> Self {
        Sheet {
            store: Store::new(),
            cells: HashMap::new(),
            formula_cells: HashMap::new(),
            readable: Rc::new(RefCell::new(HashMap::new())),
            formula_exprs: HashMap::new(),
            formula_texts: HashMap::new(),
            cell_subscriptions: HashMap::new(),
            next_cell_sub_id: 0,
        }
    }

    /// Get or create the primitive atom for a cell address.
    /// New cells start as Null. Also seeds `readable` if not already mapped.
    fn ensure_cell(&mut self, addr: CellAddress) -> AtomId {
        if let Some(&id) = self.cells.get(&addr) {
            return id;
        }
        let id = self.store.create_atom(Value::Null);
        self.cells.insert(addr, id);
        // Only seed readable if no formula has claimed this address.
        let mut r = self.readable.borrow_mut();
        r.entry(addr).or_insert(id);
        id
    }

    /// Get the readable atom for a cell: formula atom if exists, otherwise primitive atom.
    fn readable_atom(&mut self, addr: CellAddress) -> AtomId {
        if let Some(&id) = self.formula_cells.get(&addr) {
            return id;
        }
        self.ensure_cell(addr)
    }

    fn current_readable_atom(&self, addr: CellAddress) -> Option<AtomId> {
        self.readable.borrow().get(&addr).copied()
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

    /// Set a cell's value by address string (e.g. "A1").
    /// Clears any existing formula on this cell.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let had_formula = self.formula_cells.contains_key(&addr);

        if had_formula {
            // Formula → primitive: detach fanout, swap, reattach + fire once.
            self.with_remap(addr, |sheet| {
                let old_derived = sheet.formula_cells.remove(&addr);
                sheet.formula_exprs.remove(&addr);
                sheet.formula_texts.remove(&addr);
                let id = sheet.ensure_cell(addr);
                // B.1 — readable must point at the primitive immediately so
                // other derived closures stop reading the old formula.
                sheet.readable.borrow_mut().insert(addr, id);
                sheet.store.set(id, value);
                if let Some(old) = old_derived {
                    sheet.store.propagate_force(&[old]);
                    if sheet.store.has_atom(old) && !sheet.store.has_dependents(old) {
                        sheet.store.destroy_atom(old);
                    }
                }
            });
        } else {
            // Primitive → primitive: no remap. Let the fanout fire naturally
            // on the value diff inside `store.set`.
            let id = self.ensure_cell(addr);
            self.readable.borrow_mut().insert(addr, id);
            self.attach_address_sub(addr);
            self.store.set(id, value);
        }
    }

    /// Clear a cell back to empty (Null). Equivalent to `set_cell(addr, Value::Null)`
    /// but with a more discoverable name for callers implementing Delete-key /
    /// undo-to-empty UX.
    pub fn clear_cell(&mut self, addr_str: &str) {
        self.set_cell(addr_str, Value::Null);
    }

    /// Set a cell's formula by address string (e.g. "=A1+B1").
    /// The formula is parsed and a derived atom is created.
    ///
    /// Returns `false` if either:
    ///   - the formula failed to parse (B.3) — cell becomes `#VALUE!`
    ///   - the formula would form a dependency cycle (B.2) — cell becomes `#CYCLE!`
    /// In both cases the wasm instance keeps running and any prior formula on
    /// this cell is cleared.
    ///
    /// **EAGER (vs LAZY_FORMULA_EVAL.md)**: this path still pre-creates atoms
    /// for every referenced cell (`ensure_refs`) and runs the formula closure
    /// once at create-time (inside `Store::create_derived`). The lazy plan
    /// (Step 2) replaces both: refs are tracked in `cell_dependents`/
    /// `range_dependents` without materializing atoms, and computation is
    /// deferred until `get_cell` reads the formula. Until that lands,
    /// importing N formulas costs N evals + N×deps cell atoms.
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

        self.ensure_refs(&expr);

        // set_formula always swaps to a freshly-created derived atom, so we
        // always go through `with_remap` — the inner mutation is suppressed
        // from firing this cell's fanout, then we fire exactly once.
        self.with_remap(addr, move |sheet| {
            // Primitive atom id — needed for propagate_force below so that
            // dependents that captured this id recompute against the new
            // readable map and naturally retarget to the new derived (B.1).
            let prim_id = sheet.ensure_cell(addr);
            let old_derived = sheet.formula_cells.get(&addr).copied();

            let expr = Rc::new(expr);
            let readable = sheet.readable.clone();
            let expr_for_closure = expr.clone();
            let derived_id = sheet.store.create_derived(move |get| {
                let map = readable.borrow();
                eval_expr(&expr_for_closure, get, &*map)
            });

            sheet.formula_cells.insert(addr, derived_id);
            sheet.formula_exprs.insert(addr, expr);
            sheet.formula_texts.insert(addr, formula_str.to_string());
            sheet.readable.borrow_mut().insert(addr, derived_id);

            let mut roots = vec![prim_id];
            if let Some(old) = old_derived {
                roots.push(old);
            }
            sheet.store.propagate_force(&roots);

            // Destroy the old derived atom (B.4 — without this, repeated
            // set_formula on the same cell leaks atoms forever in the store).
            if let Some(old) = old_derived {
                if sheet.store.has_atom(old) && !sheet.store.has_dependents(old) {
                    sheet.store.destroy_atom(old);
                }
            }
        });
        true
    }

    /// Drop any existing formula and write an error value to the cell.
    fn write_error(&mut self, addr: CellAddress, err: ValueError) {
        let had_formula = self.formula_cells.contains_key(&addr);
        if had_formula {
            self.with_remap(addr, |sheet| {
                let old_derived = sheet.formula_cells.remove(&addr);
                sheet.formula_exprs.remove(&addr);
                sheet.formula_texts.remove(&addr);
                let id = sheet.ensure_cell(addr);
                sheet.readable.borrow_mut().insert(addr, id);
                sheet.store.set(id, Value::Error(err));
                if let Some(old) = old_derived {
                    sheet.store.propagate_force(&[old]);
                    if sheet.store.has_atom(old) && !sheet.store.has_dependents(old) {
                        sheet.store.destroy_atom(old);
                    }
                }
            });
        } else {
            let id = self.ensure_cell(addr);
            self.readable.borrow_mut().insert(addr, id);
            self.attach_address_sub(addr);
            self.store.set(id, Value::Error(err));
        }
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
        let id = match self.current_readable_atom(addr) {
            Some(id) => id,
            None => return Value::Null,
        };
        if !self.store.has_atom(id) {
            return Value::Null;
        }
        self.store.get(id)
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
        let mut roots: Vec<AtomId> = Vec::new();
        for (addr, expr) in &self.formula_exprs {
            if expr_has_sheet_ref(expr) {
                if let Some(&id) = self.formula_cells.get(addr) {
                    roots.push(id);
                }
            }
        }
        if !roots.is_empty() {
            // Silent because Workbook::get_cell is a read path: it refreshes
            // cached derived values against the live TLS resolver without
            // turning the read itself into a subscriber event.
            self.store.force_recompute_derived_silent(&roots);
        }
    }

    /// Targeted version of `recompute_cross_sheet_formulas`: BFS over
    /// `formula_exprs` starting at `target`, collect every formula reached
    /// whose AST contains a `SheetRef`, then `force_recompute_derived_silent`
    /// the union. `Store::recompute_derived_tree` then handles the
    /// topological cascade to dependents (including non-cross-sheet formulas
    /// like `=B1*2` whose `B1` is a cross-sheet formula).
    ///
    /// Worst-case cost is the size of the dep closure of `target` in
    /// `formula_exprs` — orders of magnitude smaller than the whole-sheet
    /// sweep on workbooks with many cross-sheet formulas. For a sheet with
    /// 1k cross-sheet formulas where `target` only depends on 3 of them,
    /// this does 3 force-recomputes instead of 1k.
    pub fn recompute_cross_sheet_formulas_reachable_from(&mut self, target: CellAddress) {
        let mut visited: HashSet<CellAddress> = HashSet::new();
        let mut to_visit: Vec<CellAddress> = vec![target];
        let mut roots: Vec<AtomId> = Vec::new();

        while let Some(addr) = to_visit.pop() {
            if !visited.insert(addr) {
                continue;
            }
            let Some(expr) = self.formula_exprs.get(&addr) else {
                continue;
            };
            if expr_has_sheet_ref(expr) {
                if let Some(&id) = self.formula_cells.get(&addr) {
                    roots.push(id);
                }
            }
            // Queue only addresses that themselves have a formula — a leaf
            // primitive ref doesn't need re-traversal. Range refs are
            // expanded but each cell is gated by `formula_exprs` so the
            // typical `SUM(A:A)` only enqueues the small subset of column A
            // cells that are actually formulas.
            collect_formula_refs_into(expr, &self.formula_exprs, &mut to_visit);
        }

        if !roots.is_empty() {
            self.store.force_recompute_derived_silent(&roots);
        }
    }

    // === LAZY_FORMULA_EVAL Step 0 — debug counters ===
    //
    // These exist so future lazy-formula work has measurable gating points
    // (e.g. "100k set_formula calls produce 0 evals", "subscribe to empty
    // cell creates 0 atoms"). They reflect the *current* eager state today;
    // when Step 2 lands the same APIs report against the new graph.
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

    /// Number of formula cells. With the eager backend this also equals the
    /// number of derived atoms in the store; under lazy this would diverge
    /// (formulas exist as records, derived atoms vanish).
    #[doc(hidden)]
    pub fn debug_formula_count(&self) -> usize {
        self.formula_cells.len()
    }

    /// Number of *atom* dependents on the cell at `addr`. Today this only
    /// covers cells whose primitive/derived atom has tracked back_deps —
    /// cells referenced by a formula via `ensure_refs`. Under lazy this
    /// will switch to counting `cell_dependents[addr]` directly.
    #[doc(hidden)]
    pub fn debug_dependents_count(&self, addr_str: &str) -> usize {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return 0;
        };
        let Some(&id) = self.cells.get(&addr) else {
            return 0;
        };
        self.store.debug_dependent_count(id)
    }

    /// Total live atoms (primitive + derived). Useful as a gross "did
    /// anything materialize?" signal in tests.
    #[doc(hidden)]
    pub fn debug_total_atom_count(&self) -> usize {
        self.store.debug_total_atom_count()
    }

    /// Cumulative recompute count from the underlying store. Tests use
    /// deltas across `Workbook::get_cell` to assert
    /// "single-cell read only forced N derived recomputes".
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
    /// of the edit so internal `store.set` / `propagate_force` calls don't
    /// fan out partial intermediate states; reattaches at the end.
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
            if let Some(derived) = self.formula_cells.remove(&addr) {
                if self.store.has_atom(derived) && !self.store.has_dependents(derived) {
                    self.store.destroy_atom(derived);
                }
            }
            self.formula_exprs.remove(&addr);
            self.formula_texts.remove(&addr);
            self.readable.borrow_mut().remove(&addr);
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
        let new_formula_cells: HashMap<CellAddress, AtomId> =
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
        let new_readable: HashMap<CellAddress, AtomId> = self
            .readable
            .borrow()
            .iter()
            .map(|(addr, id)| (f(*addr), *id))
            .collect();

        self.cells = new_cells;
        self.formula_cells = new_formula_cells;
        self.formula_exprs = new_formula_exprs;
        self.formula_texts = new_formula_texts;
        *self.readable.borrow_mut() = new_readable;
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
            self.rebuild_formula_derived(addr, rendered);
        }
    }

    fn rebuild_formula_derived(&mut self, addr: CellAddress, formula_str: String) {
        let expr = match crate::formula::parse_formula(&formula_str) {
            Some(e) => Rc::new(e),
            None => {
                // Render produced something unparsable — shouldn't happen,
                // but be safe.
                self.write_error(addr, ValueError::InvalidValue);
                return;
            }
        };
        self.formula_exprs.insert(addr, expr.clone());
        self.formula_texts.insert(addr, formula_str);

        // Destroy old derived if present.
        let old_derived = self.formula_cells.remove(&addr);

        let prim_id = self.ensure_cell(addr);
        let readable = self.readable.clone();
        let expr_for_closure = expr.clone();

        let derived_id = self.store.create_derived(move |get| {
            let map = readable.borrow();
            eval_expr(&expr_for_closure, get, &*map)
        });

        self.formula_cells.insert(addr, derived_id);
        self.readable.borrow_mut().insert(addr, derived_id);
        // Fanout reattach + per-address fire are handled by the enclosing
        // `with_structural_edit` (this is only ever called from
        // `retarget_formula_refs` during a structural edit).
        let mut roots = vec![prim_id];
        if let Some(old) = old_derived {
            roots.push(old);
        }
        self.store.propagate_force(&roots);
        if let Some(old) = old_derived {
            if self.store.has_atom(old) && !self.store.has_dependents(old) {
                self.store.destroy_atom(old);
            }
        }
    }

    /// Walk AST and ensure all referenced cells exist.
    fn ensure_refs(&mut self, expr: &Expr) {
        match expr {
            Expr::CellRef(addr) => {
                self.ensure_cell(*addr);
            }
            Expr::Range { start, end } => {
                let min_row = start.row.min(end.row);
                let max_row = start.row.max(end.row);
                let min_col = start.col.min(end.col);
                let max_col = start.col.max(end.col);
                for row in min_row..=max_row {
                    for col in min_col..=max_col {
                        self.ensure_cell(CellAddress::new(row, col));
                    }
                }
            }
            Expr::BinOp { left, right, .. } => {
                self.ensure_refs(left);
                self.ensure_refs(right);
            }
            Expr::Negate(inner) => self.ensure_refs(inner),
            Expr::FuncCall { args, .. } => {
                for arg in args {
                    self.ensure_refs(arg);
                }
            }
            // Cross-sheet refs are resolved by the workbook layer; the
            // current sheet doesn't pre-create cells for them.
            Expr::SheetRef { .. } => {}
            Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
        }
    }

    /// Set multiple cells at once, with a single propagation pass.
    ///
    /// Like `set_cell`, this also clears any existing formula on each target
    /// cell — formula derived atoms are destroyed and `readable` is restored
    /// to the primitive atom (B.12). Without this, batched writes would read
    /// the stale formula result on subsequent `get_cell` calls.
    ///
    /// Subscribers fire at most once per affected address: addresses being
    /// written go through the same detach-mutate-reattach dance as `set_cell`,
    /// and other subscribed addresses fire only if `propagate_force` causes
    /// their displayed value to actually change.
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
        let mut old_deriveds: Vec<AtomId> = Vec::new();

        for (addr_str, value) in updates {
            let addr = CellAddress::parse(addr_str).expect("invalid cell address");

            if let Some(old_derived) = self.formula_cells.remove(&addr) {
                old_deriveds.push(old_derived);
            }
            self.formula_exprs.remove(&addr);
            self.formula_texts.remove(&addr);

            let id = self.ensure_cell(addr);
            // Restore readable to primitive in case it pointed at a formula.
            self.readable.borrow_mut().insert(addr, id);
            atom_values.push((id, value.clone()));
        }

        self.store.batch(|store| {
            for (id, value) in atom_values {
                store.set(id, value);
            }
        });
        if !old_deriveds.is_empty() {
            self.store.propagate_force(&old_deriveds);
        }

        for old in old_deriveds {
            if self.store.has_atom(old) && !self.store.has_dependents(old) {
                self.store.destroy_atom(old);
            }
        }

        for addr in &subscribed {
            self.attach_address_sub(*addr);
        }
        for (addr, pre_val) in pre {
            let post_val = self.peek_value(addr);
            if pre_val != post_val {
                self.notify_address_subscribers(addr);
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
    fn debug_counters_reflect_eager_baseline() {
        // These assertions document the *current* eager backend's behavior.
        // When LAZY_FORMULA_EVAL Step 2 lands, the formula-import case
        // should change: dep cells no longer materialize, derived atom
        // count drops to 0. Update this test then — the divergence is the
        // signal that Step 2 actually delivered.
        let mut sheet = Sheet::new();
        assert_eq!(sheet.debug_primitive_atom_count(), 0);
        assert_eq!(sheet.debug_formula_count(), 0);
        assert_eq!(sheet.debug_total_atom_count(), 0);

        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        // EAGER: =A1+Z99 materializes (a) Z99 (ensure_refs on missing
        // CellRef), (b) B1's own primitive (set_formula keeps a primitive
        // for propagate_force after a later set_cell rewrite). A1 already
        // existed. So primitives go 1 → 3, derived count goes 0 → 1,
        // total atoms 1 → 4.
        sheet.set_formula("B1", "=A1+Z99");
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            3,
            "A1 (existing) + Z99 (ensure_refs) + B1 primitive (set_formula scaffold)"
        );
        assert_eq!(sheet.debug_formula_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 4, "3 primitive + 1 derived");

        // EAGER: A1 has B1's derived as a dependent.
        assert_eq!(sheet.debug_dependents_count("A1"), 1);
        // Z99 also got tracked (it was read in the initial eager eval).
        assert_eq!(sheet.debug_dependents_count("Z99"), 1);
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
    fn set_formula_releases_old_derived() {
        // B.4: re-setting a formula on the same cell should not leak the
        // previous derived atom in the store.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        let first_derived = *sheet.formula_cells.get(&CellAddress::new(0, 1)).unwrap();
        assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));

        // Replace the formula. Old derived should be destroyed.
        sheet.set_formula("B1", "=A1*3");
        let second_derived = *sheet.formula_cells.get(&CellAddress::new(0, 1)).unwrap();
        assert_ne!(first_derived, second_derived);
        assert!(
            !sheet.store.has_atom(first_derived),
            "old derived must be destroyed"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));

        // Many replacements in a row should not grow the store.
        for n in 1..=20 {
            sheet.set_formula("B1", &format!("=A1+{}", n));
        }
        // Final formula = A1 + 20 = 30.
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));
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
    fn set_cell_releases_old_derived() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        let old_derived = *sheet.formula_cells.get(&CellAddress::new(0, 1)).unwrap();

        sheet.set_cell("B1", Value::Number(5.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(5.0));
        assert!(
            !sheet.store.has_atom(old_derived),
            "old formula derived must be destroyed after set_cell"
        );
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
}
