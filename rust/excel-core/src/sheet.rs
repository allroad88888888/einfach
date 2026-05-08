use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use einfach_core::{AtomId, Store, Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::eval_expr;
use crate::formula::{parse_formula, Expr};

/// Shared, mutable map of cell address → readable atom id.
/// "Readable" means the formula derived atom if the cell has a formula,
/// otherwise the primitive cell atom. Sharing via `Rc<RefCell>` lets
/// already-created derived closures see later updates (B.1 fix).
type ReadableMap = Rc<RefCell<HashMap<CellAddress, AtomId>>>;

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
}

impl Sheet {
    pub fn new() -> Self {
        Sheet {
            store: Store::new(),
            cells: HashMap::new(),
            formula_cells: HashMap::new(),
            readable: Rc::new(RefCell::new(HashMap::new())),
            formula_exprs: HashMap::new(),
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
        // Point readable at the new derived so other formulas referencing
        // this cell start reading the formula result, not the primitive.
        self.readable.borrow_mut().insert(addr, derived_id);

        // Force prior dependents (which captured prim_id in their dep graph)
        // to recompute against the new readable map. After this their dep
        // graph naturally retargets to derived_id (B.1).
        self.store.propagate_force(&[prim_id]);
        true
    }

    /// Drop any existing formula and write an error value to the cell.
    fn write_error(&mut self, addr: CellAddress, err: ValueError) {
        self.formula_cells.remove(&addr);
        self.formula_exprs.remove(&addr);
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
    pub fn batch_set(&mut self, updates: &[(&str, Value)]) {
        // Pre-ensure all cells exist before entering the batch
        let atom_values: Vec<(AtomId, Value)> = updates
            .iter()
            .map(|(addr_str, value)| {
                let addr = CellAddress::parse(addr_str).expect("invalid cell address");
                let id = self.ensure_cell(addr);
                (id, value.clone())
            })
            .collect();

        self.store.batch(|store| {
            for (id, value) in atom_values {
                store.set(id, value);
            }
        });
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
