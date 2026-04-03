use std::collections::HashMap;
use std::rc::Rc;

use einfach_core::{AtomId, Store, Value};

use crate::cell::CellAddress;
use crate::eval::eval_expr;
use crate::formula::{parse_formula, Expr};

/// A spreadsheet sheet backed by an atom store.
pub struct Sheet {
    pub(crate) store: Store,
    pub(crate) cells: HashMap<CellAddress, AtomId>,
    /// Cells that have formulas (the formula atom replaces the cell atom)
    pub(crate) formula_cells: HashMap<CellAddress, AtomId>,
}

impl Sheet {
    pub fn new() -> Self {
        Sheet {
            store: Store::new(),
            cells: HashMap::new(),
            formula_cells: HashMap::new(),
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
        let id = self.ensure_cell(addr);
        self.store.set(id, value);
    }

    /// Set a cell's formula by address string (e.g. "=A1+B1").
    /// The formula is parsed and a derived atom is created.
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let expr = parse_formula(formula_str).expect("invalid formula");

        // Ensure all referenced cells exist so their atoms are in the cells map
        self.ensure_refs(&expr);

        // Snapshot the cells map for the closure
        let cell_map: HashMap<CellAddress, AtomId> = self
            .cells
            .iter()
            .map(|(&addr, &id)| {
                // For cells with formulas, use the formula atom
                let readable = self.formula_cells.get(&addr).copied().unwrap_or(id);
                (addr, readable)
            })
            .collect();

        let expr = Rc::new(expr);
        let cell_map = Rc::new(cell_map);

        let expr_clone = expr.clone();
        let cell_map_clone = cell_map.clone();

        let derived_id = self.store.create_derived(move |get| {
            eval_expr(&expr_clone, &|id| get(id), &cell_map_clone)
        });

        // Ensure the cell primitive atom exists (for later if formula is cleared)
        self.ensure_cell(addr);
        self.formula_cells.insert(addr, derived_id);
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
    fn formula_references_unset_cell() {
        let mut sheet = Sheet::new();
        // B1 not set, should be Null → coerced to 0
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_cell("C1"), Value::Number(5.0));
    }
}
