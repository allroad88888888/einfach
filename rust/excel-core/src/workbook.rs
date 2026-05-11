use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use einfach_core::{Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::EvalProvider;
use crate::formula::{parse_formula, Expr};
use crate::sheet::Sheet;

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
        };
        self.sheets[idx].peek_value_with_provider(addr, &provider)
    }

    #[doc(hidden)]
    pub fn debug_formula_cache_state(&self, sheet_idx: usize, addr_str: &str) -> &'static str {
        self.sheets
            .get(sheet_idx)
            .map(|sheet| sheet.debug_formula_cache_state(addr_str))
            .unwrap_or("missing-sheet")
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
        if sheet_idx >= self.sheets.len() {
            return false;
        }
        let addr = match CellAddress::parse(addr_str) {
            Some(a) => a,
            None => return false,
        };

        // Try parse first. On parse failure delegate to sheet.set_formula —
        // it has the canonical "write #VALUE! and clean up" path.
        let expr = match parse_formula(formula_text) {
            Some(e) => e,
            None => {
                // sheet.set_formula will hit the same branch and write #VALUE!.
                // Returns false; our return contract matches.
                self.sheets[sheet_idx].set_formula(addr_str, formula_text);
                return false;
            }
        };

        // Cross-sheet cycle pre-check: would installing `expr` at
        // (sheet_idx, addr) make `(sheet_idx, addr)` reachable from itself
        // through any combination of same-sheet and SheetRef edges?
        if self.cross_sheet_cycle(sheet_idx, addr, &expr) {
            self.sheets[sheet_idx].write_error(addr, ValueError::CyclicRef);
            return false;
        }

        // Delegate to per-sheet set_formula. It still runs `would_create_cycle`
        // for same-sheet cycles — that path was already correct and we don't
        // duplicate the check here.
        self.sheets[sheet_idx].set_formula(addr_str, formula_text)
    }

    /// BFS the workbook-wide dep graph starting from the references of `expr`
    /// (treated as if it were already installed at `(target_idx, target)`).
    /// Returns true iff `(target_idx, target)` is reachable.
    ///
    /// Edges from any visited `(idx, addr)`:
    ///   - same-sheet `CellRef` / `Range` → `(idx, ref_addr)`
    ///   - `SheetRef { sheet, addr }` → `(other_idx, addr)` if the sheet name
    ///     resolves; otherwise dropped
    ///
    /// Range expansion is gated by `formula_exprs` membership on each sheet
    /// (mirrors `collect_formula_refs_into` in sheet.rs) so `SUM(A:A)` doesn't
    /// enqueue a million empty addresses.
    fn cross_sheet_cycle(&self, target_idx: usize, target: CellAddress, expr: &Expr) -> bool {
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut to_visit: Vec<(usize, CellAddress)> = Vec::new();
        // Seed with refs of the candidate expression.
        collect_workbook_refs(expr, target_idx, &self.by_name, &mut to_visit);

        while let Some((idx, addr)) = to_visit.pop() {
            if idx == target_idx && addr == target {
                return true;
            }
            if !visited.insert((idx, addr)) {
                continue;
            }
            // Walk the formula at this node, if any.
            let Some(sheet) = self.sheets.get(idx) else {
                continue;
            };
            let exprs = sheet.formula_exprs_iter();
            let Some(child_expr) = exprs.get(&addr) else {
                continue;
            };
            collect_workbook_refs(child_expr, idx, &self.by_name, &mut to_visit);
        }
        false
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

/// Walk an AST and append every (sheet_idx, addr) it directly references
/// onto `out`. `current_idx` is the sheet the AST lives on (used for
/// `CellRef` / `Range`). `SheetRef` arms resolve their sheet name through
/// `by_name`; unknown sheet names are dropped (eval-time will return
/// `#REF!`, which doesn't form a cycle).
///
/// Used only by `Workbook::cross_sheet_cycle` — kept free so it doesn't
/// borrow `self`. Range expansion is naive (every cell in the rectangle)
/// because the sheet-side BFS gates on `formula_exprs` membership next, so
/// large empty ranges only cost `Vec` pushes here, not unbounded recursion.
fn collect_workbook_refs(
    expr: &Expr,
    current_idx: usize,
    by_name: &HashMap<String, usize>,
    out: &mut Vec<(usize, CellAddress)>,
) {
    match expr {
        Expr::CellRef(addr) => out.push((current_idx, *addr)),
        Expr::Range { start, end } => {
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
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
    }
}

struct WorkbookEvalProvider<'a> {
    wb: &'a Workbook,
    current: Cell<usize>,
}

impl<'a> WorkbookEvalProvider<'a> {
    fn with_current(&self, idx: usize, f: impl FnOnce() -> Value) -> Value {
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
        self.wb.sheets[idx].peek_value_with_provider(addr, self)
    }

    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return Value::Null;
        };
        self.with_current(idx, || self.wb.sheets[idx].peek_value_with_provider(addr, self))
    }

    fn force_formula_recompute(&self) -> bool {
        true
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
}
