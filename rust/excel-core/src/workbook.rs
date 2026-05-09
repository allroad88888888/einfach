use std::collections::HashMap;

use einfach_core::Value;

use crate::cell::CellAddress;
use crate::eval::{with_cross_resolver_for_sheet, CrossSheetResolver};
use crate::sheet::Sheet;

/// A workbook is an ordered collection of named sheets. Phase 4 backend.
///
/// Cross-sheet references (`=Sheet2!A1`) resolve through a temporary
/// read-time resolver. This is still an eager-derived bridge: simple
/// cross-sheet reads work, but workbook-wide lazy formula evaluation is the
/// long-term path for chained refs, subscriptions, and cycle handling.
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
    /// resolve through this path.
    ///
    /// Implementation note: formula derived atoms cache the value computed
    /// at `set_formula` time, where no cross-sheet resolver is in scope —
    /// any `=Other!A1` therefore caches as `#REF!`. Reading through the
    /// workbook installs the resolver in TLS and force-recomputes any
    /// formula on the target sheet whose AST contains a `SheetRef`, so
    /// callers see live values. Same-sheet formulas keep their existing
    /// cached value (cheap).
    pub fn get_cell(&mut self, sheet_name: &str, addr_str: &str) -> Value {
        let idx = match self.index_of(sheet_name) {
            Some(i) => i,
            None => return Value::Null,
        };
        let addr = match CellAddress::parse(addr_str) {
            Some(a) => a,
            None => return Value::Null,
        };

        // Split self.sheets so the resolver borrows every non-target sheet
        // immutably while we refresh the target sheet's cached derived values.
        let by_name = &self.by_name;
        let (left, mid_right) = self.sheets.split_at_mut(idx);
        let (target_slice, right) = mid_right.split_at_mut(1);
        let target = &mut target_slice[0];

        let resolver = SplitWorkbookResolver {
            left,
            right,
            by_name,
            skip_idx: idx,
        };

        with_cross_resolver_for_sheet(sheet_name, &resolver, || {
            // Targeted: only refresh formulas on the dep chain of `addr`,
            // not every cross-sheet formula on the sheet. Whole-sheet sweep
            // (`recompute_cross_sheet_formulas`) is preserved on Sheet for
            // explicit "rebuild" callers but not used on the read path.
            target.recompute_cross_sheet_formulas_reachable_from(addr);
            target.peek_value(addr)
        })
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

/// Resolver used by `Workbook::get_cell` while the target sheet is held
/// mutably. Sees every sheet except the target; refs like `Sheet1!A1` on
/// Sheet1 are handled earlier by eval's current-sheet context and use the
/// normal same-sheet getter.
struct SplitWorkbookResolver<'a> {
    left: &'a [Sheet],
    right: &'a [Sheet],
    by_name: &'a HashMap<String, usize>,
    skip_idx: usize,
}

impl<'a> SplitWorkbookResolver<'a> {
    fn sheet_at(&self, idx: usize) -> Option<&Sheet> {
        if idx == self.skip_idx {
            None
        } else if idx < self.skip_idx {
            self.left.get(idx)
        } else {
            self.right.get(idx - self.skip_idx - 1)
        }
    }
}

impl<'a> CrossSheetResolver for SplitWorkbookResolver<'a> {
    fn resolve(&self, sheet: &str, addr: CellAddress) -> Value {
        let idx = match self.by_name.get(sheet) {
            Some(&i) => i,
            None => return Value::Null,
        };
        match self.sheet_at(idx) {
            // peek_value reads the cached formula value. If the referenced
            // sheet's formula also contains cross-sheet refs back to *its*
            // peers, those caches may be stale — see "已知遗留" in the
            // LAZY_FORMULA_EVAL doc; chained cross-sheet refs need the
            // lazy formula rewrite to land for full correctness.
            Some(s) => s.peek_value(addr),
            // If this happens, the caller referenced the target sheet by a
            // name that is not the current eval sheet. The lazy formula path
            // will replace this resolver bridge.
            None => Value::Null,
        }
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
        wb.sheet_mut(0).unwrap().set_formula("B1", "=Data!A1*2");

        // wb.get_cell installs the resolver in TLS and force-recomputes
        // any formula on the target sheet whose AST contains SheetRef.
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

        // Reading B1 should force exactly one derived recompute (B1 itself).
        // The whole-sheet variant would force 3.
        assert_eq!(
            after - before,
            1,
            "reading B1 must only force B1's derived; D1/E1 untouched"
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
        wb.sheet_mut(0).unwrap().set_formula("B1", "=Data!A1*2");
        wb.sheet_mut(0).unwrap().set_formula("C1", "=B1+100");

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
