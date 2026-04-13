use einfach_core::{AtomId, Value};

use crate::cell::CellAddress;
use crate::formula::Expr;

use super::Sheet;

impl Sheet {
    /// Get or create the primitive atom for a cell address.
    /// New cells start as Null.
    pub(super) fn ensure_cell(&mut self, addr: CellAddress) -> AtomId {
        if let Some(&id) = self.cells.get(&addr) {
            return id;
        }
        let id = self.store.create_atom(Value::Null);
        self.cells.insert(addr, id);
        id
    }

    /// Get the readable atom for a cell: formula atom if exists, otherwise primitive atom.
    pub(super) fn readable_atom(&mut self, addr: CellAddress) -> AtomId {
        if let Some(&id) = self.formula_cells.get(&addr) {
            return id;
        }
        self.ensure_cell(addr)
    }

    /// Walk AST and ensure all referenced cells exist.
    pub(super) fn ensure_refs(&mut self, expr: &Expr) {
        match expr {
            Expr::CellRef(reference) => {
                if !reference.is_invalid() && reference.sheet_name.is_none() {
                    self.ensure_cell(reference.addr);
                }
            }
            Expr::Range { start, end } => {
                if start.is_invalid()
                    || end.is_invalid()
                    || start.sheet_name.is_some()
                    || end.sheet_name.is_some()
                {
                    return;
                }
                let min_row = start.addr.row.min(end.addr.row);
                let max_row = start.addr.row.max(end.addr.row);
                let min_col = start.addr.col.min(end.addr.col);
                let max_col = start.addr.col.max(end.addr.col);
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
            Expr::Number(_) | Expr::Text(_) | Expr::Boolean(_) | Expr::Error(_) => {}
        }
    }
}

pub(super) fn value_to_input(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Value::Text(s) => s.clone(),
        Value::Boolean(true) => "TRUE".into(),
        Value::Boolean(false) => "FALSE".into(),
        Value::Null => String::new(),
        Value::Error(e) => format!("{}", e),
    }
}
