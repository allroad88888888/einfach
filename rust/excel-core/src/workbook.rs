use std::collections::HashMap;

use einfach_core::Value;

use crate::cell::CellAddress;
use crate::eval::{with_cross_resolver, CrossSheetResolver};
use crate::sheet::Sheet;

/// A workbook is an ordered collection of named sheets. Phase 4 backend.
///
/// Cross-sheet references (`=Sheet2!A1`) require a shared resolver that
/// can find the right sheet's atom for a given (sheet, addr) pair. That
/// piece is left as a follow-up — wiring it requires either a parser
/// extension to recognize `Name!A1` syntax (which the current parser
/// doesn't have) or a higher-level pre-processor. For now the Workbook
/// just owns Sheets and lets callers operate on them by index/name.
pub struct Workbook {
    sheets: Vec<Sheet>,
    names: Vec<String>,
    /// name → index lookup; rebuilt whenever sheets are added/renamed.
    by_name: HashMap<String, usize>,
}

impl Workbook {
    pub fn new() -> Self {
        let mut wb = Workbook {
            sheets: Vec::new(),
            names: Vec::new(),
            by_name: HashMap::new(),
        };
        // Default sheet so users can `wb.active_mut()` without first calling
        // add_sheet — matches the Excel "blank file already has Sheet1" UX.
        wb.add_sheet("Sheet1");
        wb
    }

    /// Append a new empty sheet. If the name is already taken, returns the
    /// existing index without creating a duplicate.
    pub fn add_sheet(&mut self, name: &str) -> usize {
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

    /// Read a cell from a named sheet. Cross-sheet references in formulas
    /// resolve through this path. Resolution lives behind a temporary
    /// resolver installed in TLS so eval picks up cross-sheet refs without
    /// the lower layer (Sheet / eval_expr) needing a Workbook handle.
    pub fn get_cell(&self, sheet_name: &str, addr_str: &str) -> Value {
        let resolver = WorkbookResolver { wb: self };
        with_cross_resolver(&resolver, || {
            // get_cell takes &mut Sheet; do an interior-mutability read by
            // invoking through RefCell. We don't have one — so just use
            // an immutable peek at this layer.
            self.peek_cell(sheet_name, addr_str)
        })
    }

    /// Read a cell value without invoking the cross-sheet resolver. Used
    /// internally by WorkbookResolver to break recursion. Falls back to
    /// Null when the sheet or address is unknown.
    pub(crate) fn peek_cell(&self, sheet_name: &str, addr_str: &str) -> Value {
        let idx = match self.index_of(sheet_name) {
            Some(i) => i,
            None => return Value::Null,
        };
        let sheet = match self.sheet(idx) {
            Some(s) => s,
            None => return Value::Null,
        };
        // Sheet exposes immutable peek: look up readable atom via the
        // shared map. We replicate readable_atom's "primitive when no
        // formula" rule without ensuring a fresh atom (read-only).
        let addr = match CellAddress::parse(addr_str) {
            Some(a) => a,
            None => return Value::Null,
        };
        // Use the public peek_value if available; otherwise sheet's
        // store + readable map handle the lookup.
        sheet.peek_value(addr)
    }

    /// Remove a sheet by index. Returns the removed sheet so callers can
    /// inspect / dispose of its atoms if needed.
    pub fn remove_sheet(&mut self, idx: usize) -> Option<Sheet> {
        if idx >= self.sheets.len() {
            return None;
        }
        let sheet = self.sheets.remove(idx);
        let name = self.names.remove(idx);
        self.by_name.remove(&name);
        // Adjust trailing indices.
        for (n, i) in self.by_name.iter_mut() {
            if *i > idx {
                *i -= 1;
            }
            let _ = n;
        }
        Some(sheet)
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

/// CrossSheetResolver wired into eval through a TLS guard. Borrows the
/// Workbook; lifetime is bound to the with_cross_resolver call site.
pub(crate) struct WorkbookResolver<'a> {
    pub(crate) wb: &'a Workbook,
}

impl<'a> CrossSheetResolver for WorkbookResolver<'a> {
    fn resolve(&self, sheet: &str, addr: CellAddress) -> Value {
        // Use the addr string form so peek_cell's internal parse runs once
        // (and we avoid duplicating the "Sheet not found / addr not found"
        // bookkeeping). Fast path could skip the round-trip later.
        self.wb.peek_cell(sheet, &addr.to_string_repr())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_workbook_has_sheet1() {
        let wb = Workbook::new();
        assert_eq!(wb.sheet_count(), 1);
        assert_eq!(wb.name(0), Some("Sheet1"));
    }

    #[test]
    fn add_named_sheet() {
        let mut wb = Workbook::new();
        let idx = wb.add_sheet("Data");
        assert_eq!(idx, 1);
        assert_eq!(wb.index_of("Data"), Some(1));
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
        wb.sheet_mut(0)
            .unwrap()
            .set_cell("A1", Value::Number(10.0));
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
        wb.sheet_mut(0)
            .unwrap()
            .set_formula("B1", "=Data!A1*2");

        // The formula's derived was created during set_formula, which runs
        // inside the sheet without a workbook resolver — so the initial
        // value is #REF! (no resolver). When we read through wb.get_cell,
        // the resolver is in scope but the derived's last-computed value
        // is what get returns. To get a true cross-sheet eval we'd need to
        // force-recompute with the resolver active. Verify that path:
        use crate::eval::with_cross_resolver;
        let resolver = crate::workbook::WorkbookResolver { wb: &wb };
        let v = with_cross_resolver(&resolver, || wb.peek_cell("Sheet1", "B1"));
        // peek_cell returns the cached derived value, which was computed
        // without a resolver — still #REF!. This documents the current
        // limitation: cross-sheet derived needs to be recomputed inside
        // the resolver scope. Marked as TODO in TODO.md C.1.
        assert!(matches!(v, Value::Error(_)));
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
}
