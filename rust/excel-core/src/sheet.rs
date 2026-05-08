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

/// Token returned by `Sheet::subscribe_cell`. Bundles the SubscriptionId
/// with the AtomId at the moment of subscription so `unsubscribe_cell`
/// can find the listener entry even if the cell's readable atom has since
/// been remapped (e.g. set_formula replaced the derived).
#[derive(Clone, Copy, Debug)]
pub struct CellSubscription {
    sub_id: SubscriptionId,
    #[allow(dead_code)]
    atom_id: AtomId,
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

    /// Set a cell's value by address string (e.g. "A1").
    /// Clears any existing formula on this cell.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        // Remove formula if present
        self.formula_cells.remove(&addr);
        self.formula_exprs.remove(&addr);
        self.formula_texts.remove(&addr);
        let id = self.ensure_cell(addr);
        // Restore readable to primitive atom (B.1 — must reflect this change
        // immediately so other derived closures stop reading the old formula).
        self.readable.borrow_mut().insert(addr, id);
        self.store.set(id, value);
    }

    /// Set a cell's formula by address string (e.g. "=A1+B1").
    /// The formula is parsed and a derived atom is created.
    ///
    /// Returns `false` if either:
    ///   - the formula failed to parse (B.3) — cell becomes `#VALUE!`
    ///   - the formula would form a dependency cycle (B.2) — cell becomes `#CYCLE!`
    /// In both cases the wasm instance keeps running and any prior formula on
    /// this cell is cleared.
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

        // Capture the primitive atom id before we redirect `readable`. Other
        // already-existing derived atoms might still depend on it (they were
        // tracked against this id when they last computed). After the redirect
        // we force-propagate from this id so they re-evaluate against the new
        // readable map and switch their dependency to the new derived.
        let prim_id = self.ensure_cell(addr);

        // Capture any prior formula derived on this cell so we can destroy it
        // after the new derived has taken over and any dependents have been
        // retargeted (B.4).
        let old_derived = self.formula_cells.get(&addr).copied();

        let expr = Rc::new(expr);
        let readable = self.readable.clone();
        let expr_for_closure = expr.clone();

        let derived_id = self.store.create_derived(move |get| {
            // Borrow the current readable map (B.1: not a snapshot — picks up
            // any later set_formula / set_cell that retargets a cell).
            let map = readable.borrow();
            eval_expr(&expr_for_closure, &|id| get(id), &*map)
        });

        self.formula_cells.insert(addr, derived_id);
        self.formula_exprs.insert(addr, expr);
        self.formula_texts
            .insert(addr, formula_str.to_string());
        // Point readable at the new derived so other formulas referencing
        // this cell start reading the formula result, not the primitive.
        self.readable.borrow_mut().insert(addr, derived_id);

        // Force prior dependents (which captured prim_id or the old derived's
        // id in their dep graph) to recompute against the new readable map.
        // After this their dep graph naturally retargets to derived_id (B.1).
        let mut roots = vec![prim_id];
        if let Some(old) = old_derived {
            roots.push(old);
        }
        self.store.propagate_force(&roots);

        // Destroy the old derived atom (B.4 — without this, repeated
        // set_formula on the same cell leaks atoms forever in the store).
        // Skip if some dependent still wired to it (defensive; shouldn't
        // happen after the propagate_force above).
        if let Some(old) = old_derived {
            if self.store.has_atom(old) && !self.store.has_dependents(old) {
                self.store.destroy_atom(old);
            }
        }
        true
    }

    /// Drop any existing formula and write an error value to the cell.
    fn write_error(&mut self, addr: CellAddress, err: ValueError) {
        self.formula_cells.remove(&addr);
        self.formula_exprs.remove(&addr);
        self.formula_texts.remove(&addr);
        let id = self.ensure_cell(addr);
        self.readable.borrow_mut().insert(addr, id);
        self.store.set(id, Value::Error(err));
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
    pub fn get_cell(&mut self, addr_str: &str) -> Value {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let id = self.readable_atom(addr);
        self.store.get(id)
    }

    /// Get the AtomId for a cell (creating if needed).
    pub fn cell_atom(&mut self, addr_str: &str) -> AtomId {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.readable_atom(addr)
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

    /// Subscribe to changes on a single cell. Returns a token that bundles the
    /// underlying SubscriptionId with the AtomId being subscribed to, so
    /// `unsubscribe_cell` knows where to remove from even if the cell's
    /// readable atom has since been redirected.
    pub fn subscribe_cell(
        &mut self,
        addr_str: &str,
        listener: impl CellListener,
    ) -> CellSubscription {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let atom_id = self.readable_atom(addr);
        let sub_id = self.store.sub(atom_id, listener);
        CellSubscription { sub_id, atom_id }
    }

    /// Variant of `subscribe_cell` that accepts an already-boxed listener.
    pub fn subscribe_cell_boxed(
        &mut self,
        addr_str: &str,
        listener: Box<dyn CellListener>,
    ) -> CellSubscription {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let atom_id = self.readable_atom(addr);
        let sub_id = self.store.sub_boxed(atom_id, listener);
        CellSubscription { sub_id, atom_id }
    }

    /// Cancel a subscription previously returned from `subscribe_cell`.
    pub fn unsubscribe_cell(&mut self, sub: CellSubscription) {
        self.store.unsub(sub.sub_id);
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
            Expr::Number(_) | Expr::Text(_) => {}
        }
    }

    /// Set multiple cells at once, with a single propagation pass.
    ///
    /// Like `set_cell`, this also clears any existing formula on each target
    /// cell — formula derived atoms are destroyed and `readable` is restored
    /// to the primitive atom (B.12). Without this, batched writes would read
    /// the stale formula result on subsequent `get_cell` calls.
    pub fn batch_set(&mut self, updates: &[(&str, Value)]) {
        // For each target: clear formula bookkeeping, ensure primitive atom,
        // remember the (atom_id, value) pair, and the old derived (if any) to
        // destroy after propagation completes.
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

        // Destroy orphaned derived atoms after propagation. Skip any that
        // still have dependents (shouldn't happen after the batch above
        // retargets them via readable map, but be defensive — leaking a few
        // atoms is better than panicking the wasm instance).
        for old in old_deriveds {
            if self.store.has_atom(old) && !self.store.has_dependents(old) {
                self.store.destroy_atom(old);
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
        Expr::Number(_) | Expr::Text(_) => {}
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
        let mut sheet = Sheet::new();
        assert_eq!(sheet.get_cell("A1"), Value::Null);
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
        assert!(*count.borrow() >= 1, "subscriber must fire on dependency change");

        sheet.unsubscribe_cell(sub);
        let prev = *count.borrow();
        sheet.set_cell("A1", Value::Number(10.0));
        assert_eq!(*count.borrow(), prev, "no fire after unsubscribe");
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
        assert!(!sheet.store.has_atom(first_derived), "old derived must be destroyed");
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));

        // Many replacements in a row should not grow the store.
        for n in 1..=20 {
            sheet.set_formula("B1", &format!("=A1+{}", n));
        }
        // Final formula = A1 + 20 = 30.
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));
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

    #[test]
    fn formula_references_unset_cell() {
        let mut sheet = Sheet::new();
        // B1 not set, should be Null → coerced to 0
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_cell("C1"), Value::Number(5.0));
    }
}
