use std::collections::HashMap;
use std::rc::Rc;

use einfach_core::{AtomId, Store, Value, ValueError};

use crate::cell::{CellAddress, CellReference};
use crate::eval::eval_expr;
use crate::formula::parse_formula;

mod internals;

#[cfg(test)]
mod tests;

use internals::value_to_input;

/// A spreadsheet sheet backed by an atom store.
pub struct Sheet {
    pub(crate) store: Store,
    pub(crate) cells: HashMap<CellAddress, AtomId>,
    /// Cells that have formulas (the formula atom replaces the cell atom)
    pub(crate) formula_cells: HashMap<CellAddress, AtomId>,
    /// Original formula input for cells that were last set via set_formula().
    pub(crate) formula_inputs: HashMap<CellAddress, String>,
}

impl Sheet {
    pub fn new() -> Self {
        Sheet {
            store: Store::new(),
            cells: HashMap::new(),
            formula_cells: HashMap::new(),
            formula_inputs: HashMap::new(),
        }
    }

    /// Set a cell's value by address string (e.g. "A1").
    /// Clears any existing formula on this cell.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.formula_cells.remove(&addr);
        self.formula_inputs.remove(&addr);
        let id = self.ensure_cell(addr);
        self.store.set(id, value);
    }

    /// Clear a cell back to Null, removing any formula input.
    pub fn clear_cell(&mut self, addr_str: &str) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.formula_cells.remove(&addr);
        self.formula_inputs.remove(&addr);
        let id = self.ensure_cell(addr);
        self.store.set(id, Value::Null);
    }

    /// Set a cell's formula by address string (e.g. "=A1+B1").
    /// Invalid formulas become #VALUE! cells instead of panicking.
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.formula_inputs.insert(addr, formula_str.to_string());

        let Some(expr) = parse_formula(formula_str) else {
            self.formula_cells.remove(&addr);
            let id = self.ensure_cell(addr);
            self.store.set(id, Value::Error(ValueError::InvalidValue));
            return;
        };

        self.ensure_refs(&expr);

        let cell_map: HashMap<CellAddress, AtomId> = self
            .cells
            .iter()
            .map(|(&addr, &id)| {
                let readable = self.formula_cells.get(&addr).copied().unwrap_or(id);
                (addr, readable)
            })
            .collect();

        let expr = Rc::new(expr);
        let cell_map = Rc::new(cell_map);

        let expr_clone = expr.clone();
        let cell_map_clone = cell_map.clone();

        let derived_id = self.store.create_derived(move |get| {
            let resolve_cell = |reference: &CellReference| -> Value {
                if reference.is_invalid() || reference.sheet_name.is_some() {
                    return Value::Error(ValueError::InvalidRef);
                }
                cell_map_clone
                    .get(&reference.addr)
                    .map(|id| get(*id))
                    .unwrap_or(Value::Null)
            };

            let resolve_range = |start: &CellReference, end: &CellReference| -> Vec<Value> {
                if start.is_invalid()
                    || end.is_invalid()
                    || start.sheet_name.is_some()
                    || end.sheet_name.is_some()
                {
                    return vec![Value::Error(ValueError::InvalidRef)];
                }

                let min_row = start.addr.row.min(end.addr.row);
                let max_row = start.addr.row.max(end.addr.row);
                let min_col = start.addr.col.min(end.addr.col);
                let max_col = start.addr.col.max(end.addr.col);
                let mut values = Vec::new();

                for row in min_row..=max_row {
                    for col in min_col..=max_col {
                        let addr = CellAddress::new(row, col);
                        let value = cell_map_clone
                            .get(&addr)
                            .map(|id| get(*id))
                            .unwrap_or(Value::Null);
                        values.push(value);
                    }
                }

                values
            };

            eval_expr(&expr_clone, &resolve_cell, &resolve_range)
        });

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

    /// Get the original cell input for editing.
    /// Formula cells return the stored formula string; all other cells return a display-like value.
    pub fn get_input(&self, addr_str: &str) -> String {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        if let Some(input) = self.formula_inputs.get(&addr) {
            return input.clone();
        }

        let Some(&id) = self.cells.get(&addr) else {
            return String::new();
        };

        value_to_input(&self.store.get(id))
    }

    /// Get the AtomId for a cell (creating if needed).
    pub fn cell_atom(&mut self, addr_str: &str) -> AtomId {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.readable_atom(addr)
    }

    /// Set multiple cells at once, with a single propagation pass.
    pub fn batch_set(&mut self, updates: &[(&str, Value)]) {
        let atom_values: Vec<(AtomId, Value)> = updates
            .iter()
            .map(|(addr_str, value)| {
                let addr = CellAddress::parse(addr_str).expect("invalid cell address");
                self.formula_cells.remove(&addr);
                self.formula_inputs.remove(&addr);
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

    /// Apply Excel-style raw inputs in sequence.
    pub fn batch_set_inputs(&mut self, updates: &[(&str, &str)]) {
        for (addr, input) in updates {
            self.apply_input(addr, input);
        }
    }

    pub(crate) fn apply_input(&mut self, addr_str: &str, input: &str) {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            self.clear_cell(addr_str);
        } else if trimmed.starts_with('=') {
            self.set_formula(addr_str, trimmed);
        } else if let Ok(number) = trimmed.parse::<f64>() {
            self.set_cell(addr_str, Value::Number(number));
        } else {
            self.set_cell(addr_str, Value::Text(trimmed.to_string()));
        }
    }
}

impl Default for Sheet {
    fn default() -> Self {
        Self::new()
    }
}
