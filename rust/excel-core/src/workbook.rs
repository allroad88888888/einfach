use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};

use einfach_core::{Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::EvalProvider;
use crate::formula::{parse_formula, Expr, RangeBounds};
use crate::range::CellRange;
use crate::sheet::{RangeDependentIndex, Sheet};

/// One outgoing edge from a formula cell to a cross-sheet source.
///
/// `Cell` and `Range` mirror the sheet-local distinction between
/// point-cell deps (`cell_dependents`) and range deps (`range_dependents`).
/// A single formula can have multiple of each — `=Sheet2!A1 + SUM(Sheet3!B1:B10)`
/// would produce one `Cell` and one `Range` edge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CrossSheetRef {
    Cell(usize, CellAddress),
    /// Cross-sheet range edge, e.g. `SUM(Sheet2!A1:A100)`. The parser
    /// doesn't emit `SheetRef`-qualified ranges yet, but the variant is
    /// kept so `range_index_per_sheet` + the dirty-fanout path are
    /// already wired for the moment they appear (`Phase 3 Track L`'s
    /// `cross_sheet_range_dirty` test depends on this).
    #[allow(dead_code)]
    Range(usize, CellRange),
}

/// Workbook-level cross-sheet dependency graph. Tracks the reverse edges
/// that let a `Workbook::set_cell(src_sheet, src_addr, _)` find every
/// formula on every OTHER sheet that needs dirtying — the gap that Sheet-
/// local `cell_dependents` / `range_dependents` cannot close on its own.
///
/// Maintained by `Workbook::set_formula` / `Workbook::clear_cell` and
/// queried by `Workbook::set_cell` and the BFS underneath it.
#[derive(Default)]
pub(crate) struct CrossSheetDeps {
    /// REVERSE edges, point-cell variant.
    /// `(src_sheet, src_addr) → set of (formula_sheet, formula_addr)`.
    /// `=Sheet2!A1` on `Sheet1!B1` becomes
    /// `cell_dependents[(2, A1)] = {(1, B1)}`.
    pub(crate) cell_dependents:
        HashMap<(usize, CellAddress), HashSet<(usize, CellAddress)>>,

    /// REVERSE edges, range variant. One `RangeDependentIndex` per source
    /// sheet so per-write dirty fanout for that sheet runs the same
    /// row+col bucket lookup as Phase 2's sheet-local index.
    ///
    /// `SUM(Sheet2!A1:A100)` on `Sheet1!D` becomes an entry inside
    /// `range_index_per_sheet[2]`, where the index value points back at
    /// `(1, D)` as the dependent formula.
    pub(crate) range_index_per_sheet: HashMap<usize, RangeDependentIndex>,

    /// FORWARD edges. `(formula_sheet, formula_addr) → its outgoing
    /// cross-sheet refs`. Needed to undo previous edges when the formula
    /// is replaced or cleared, and (Track J's future use) to drive
    /// cross-sheet cycle detection off the same map rather than a
    /// per-call AST walk.
    pub(crate) formula_refs: HashMap<(usize, CellAddress), Vec<CrossSheetRef>>,
}

impl CrossSheetDeps {
    fn new() -> Self {
        Self::default()
    }

    /// Insert one outgoing edge under `(formula_sheet, formula_addr)` and
    /// also register the corresponding reverse edge. Used by `Workbook::
    /// set_formula` after the AST walk has produced a `Vec<CrossSheetRef>`.
    fn add_edge(
        &mut self,
        formula_sheet: usize,
        formula_addr: CellAddress,
        edge: CrossSheetRef,
    ) {
        // Reverse edge.
        match &edge {
            CrossSheetRef::Cell(src_sheet, src_addr) => {
                self.cell_dependents
                    .entry((*src_sheet, *src_addr))
                    .or_default()
                    .insert((formula_sheet, formula_addr));
            }
            CrossSheetRef::Range(src_sheet, range) => {
                self.range_index_per_sheet
                    .entry(*src_sheet)
                    .or_insert_with(RangeDependentIndex::new)
                    .add_formula(*range, formula_addr);
                // NOTE: the per-source-sheet `RangeDependentIndex` keys
                // its formula set by `CellAddress` only. The formula's
                // sheet is implicit in the formula_refs forward edge —
                // the workbook BFS pairs each addr back to its sheet by
                // looking up `formula_refs[(formula_sheet, addr)]`.
                let _ = formula_sheet;
            }
        }
        // Forward edge.
        self.formula_refs
            .entry((formula_sheet, formula_addr))
            .or_default()
            .push(edge);
    }

    /// Drop every outgoing edge previously installed under
    /// `(formula_sheet, formula_addr)` and tear down the matching reverse
    /// edges. Inverse of repeated `add_edge` calls. Idempotent — safe to
    /// call when no entry exists.
    fn remove_outgoing(&mut self, formula_sheet: usize, formula_addr: CellAddress) {
        let Some(edges) = self.formula_refs.remove(&(formula_sheet, formula_addr)) else {
            return;
        };
        for edge in edges {
            match edge {
                CrossSheetRef::Cell(src_sheet, src_addr) => {
                    let should_remove = if let Some(set) =
                        self.cell_dependents.get_mut(&(src_sheet, src_addr))
                    {
                        set.remove(&(formula_sheet, formula_addr));
                        set.is_empty()
                    } else {
                        false
                    };
                    if should_remove {
                        self.cell_dependents.remove(&(src_sheet, src_addr));
                    }
                }
                CrossSheetRef::Range(src_sheet, range) => {
                    if let Some(index) = self.range_index_per_sheet.get_mut(&src_sheet) {
                        index.remove_formula(range, formula_addr);
                        if index.is_empty() {
                            self.range_index_per_sheet.remove(&src_sheet);
                        }
                    }
                }
            }
        }
    }

    /// Total reverse-edge count across both cell and range halves. Used
    /// by the Phase 3 acceptance test to verify the cross-sheet write
    /// actually exercised the graph. Each point-cell entry contributes
    /// its dependent set size; each range entry contributes its dependent
    /// set size; ranges that contain N source cells still count as one
    /// entry per dependent (not N), preserving the sparse contract.
    #[doc(hidden)]
    pub fn debug_reverse_edge_count(&self) -> usize {
        let cell_edges: usize = self.cell_dependents.values().map(HashSet::len).sum();
        let range_edges: usize = self
            .range_index_per_sheet
            .values()
            .map(RangeDependentIndex::len)
            .sum();
        cell_edges + range_edges
    }
}

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
    /// Cross-sheet reverse dep graph (Phase 3 Track I). Maintained by the
    /// workbook-routed mutators (`set_cell`, `set_formula`, `clear_cell`,
    /// `bulk_load`). Empty for workbooks edited exclusively through the
    /// `Sheet::set_*` direct path — those writes deliberately bypass the
    /// graph so single-sheet tests stay stable.
    cross_sheet: CrossSheetDeps,
}

impl Workbook {
    pub fn new() -> Self {
        let mut wb = Workbook {
            sheets: Vec::new(),
            names: Vec::new(),
            by_name: HashMap::new(),
            cross_sheet: CrossSheetDeps::new(),
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
        // it has the canonical "write #VALUE! and clean up" path. Also
        // drop any previous cross-sheet edges this addr had: a #VALUE!
        // cell is no longer participating in cross-sheet deps.
        let expr = match parse_formula(formula_text) {
            Some(e) => e,
            None => {
                self.cross_sheet.remove_outgoing(sheet_idx, addr);
                self.sheets[sheet_idx].set_formula(addr_str, formula_text);
                // Propagate dirty: the address's previous value was
                // potentially observed by cross-sheet dependents.
                self.propagate_cross_sheet_dirty(sheet_idx, addr);
                return false;
            }
        };

        // Cross-sheet cycle pre-check: would installing `expr` at
        // (sheet_idx, addr) make `(sheet_idx, addr)` reachable from itself
        // through any combination of same-sheet and SheetRef edges?
        if self.cross_sheet_cycle(sheet_idx, addr, &expr) {
            self.cross_sheet.remove_outgoing(sheet_idx, addr);
            self.sheets[sheet_idx].write_error(addr, ValueError::CyclicRef);
            self.propagate_cross_sheet_dirty(sheet_idx, addr);
            return false;
        }

        // Compute the new outgoing edges from the parsed AST. Same-sheet
        // refs are handled inside `Sheet::set_formula` via its own
        // `cell_dependents` / `range_dependents`; this walk only emits
        // edges that cross a sheet boundary.
        let new_edges = collect_cross_sheet_refs(&expr, &self.by_name);

        // Remove the previous formula's outgoing edges before installing
        // new ones — if the previous formula referenced `Sheet2!A1` and
        // the new one doesn't, that reverse edge has to disappear.
        self.cross_sheet.remove_outgoing(sheet_idx, addr);

        // Install the new edges optimistically. If `Sheet::set_formula`
        // rejects the formula (parse-fail / same-sheet cycle that the
        // workbook-level pre-check missed), the rollback path below
        // restores the world to "no edges for this addr".
        for edge in &new_edges {
            self.cross_sheet.add_edge(sheet_idx, addr, edge.clone());
        }

        // Delegate to per-sheet set_formula. It still runs `would_create_cycle`
        // for same-sheet cycles — that path was already correct and we don't
        // duplicate the check here.
        let ok = self.sheets[sheet_idx].set_formula(addr_str, formula_text);
        if !ok {
            // Sheet-level rejection (parse-fail handled above already, so
            // this is the same-sheet cycle path). Roll back the edges we
            // just inserted to keep the graph honest.
            self.cross_sheet.remove_outgoing(sheet_idx, addr);
        }

        // Whether the formula was accepted or rejected, downstream
        // cross-sheet dependents need a dirty bump — the cell's value
        // is no longer the previous formula's cached result.
        self.propagate_cross_sheet_dirty(sheet_idx, addr);

        ok
    }

    /// Workbook-routed cell write. Mirrors `Sheet::set_cell` but also
    /// fans the dirty-mark + subscriber-fire signal out across the
    /// cross-sheet dep graph maintained in `cross_sheet`. Use this
    /// (instead of `wb.sheet_mut(idx).set_cell`) when the write should
    /// be visible to cross-sheet subscribers.
    ///
    /// The legacy `wb.sheet_mut(idx).set_cell(addr, value)` path stays
    /// valid for single-sheet tests but does NOT propagate cross-sheet
    /// dirty — that's the "raw" path the documented gap test
    /// `workbook_get_cell_refreshes_cross_sheet_cache_without_notifying`
    /// exercises and continues to assert.
    pub fn set_cell(&mut self, sheet_idx: usize, addr_str: &str, value: Value) {
        if sheet_idx >= self.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        // 1. Sheet-local write — fires Sheet-local subscribers + dirties
        //    Sheet-local dependents. If the previous content was a
        //    formula, this also drops its outgoing cross-sheet edges
        //    (which it owned before being overwritten with a primitive).
        self.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.sheets[sheet_idx].set_cell(addr_str, value);
        // 2. Cross-sheet fanout. The BFS layer dirties each target +
        //    fires its subscribers; if a target's own formula has a
        //    cross-sheet edge, the next BFS layer picks it up.
        self.propagate_cross_sheet_dirty(sheet_idx, addr);
    }

    /// Workbook-routed cell clear. Equivalent to `set_cell(idx, addr,
    /// Value::Null)` — a cleared cell is a write to Null with the same
    /// cross-sheet dirty fanout. Provided as a separate name so callers
    /// don't have to construct a `Value::Null` for Delete-key UX.
    pub fn clear_cell(&mut self, sheet_idx: usize, addr_str: &str) {
        if sheet_idx >= self.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.sheets[sheet_idx].clear_cell(addr_str);
        self.propagate_cross_sheet_dirty(sheet_idx, addr);
    }

    /// Workbook-level BFS dirty propagation across cross-sheet edges.
    ///
    /// Seed: `(src_sheet, src_addr)`. For each popped item, look up its
    /// cross-sheet dependents (cell + range halves) and for each
    /// dependent `(target_sheet, target_addr)`:
    ///   - flip its formula cache to Dirty via
    ///     `Sheet::mark_dirty_for_addr`,
    ///   - fire its subscribers via `Sheet::fire_subscribers`,
    ///   - enqueue it for the next BFS layer (chained cross-sheet
    ///     dependencies — `Sheet1!D = =Sheet2!C`, `Sheet2!C = =Sheet3!A`).
    ///
    /// Uses a `VecDeque` for FIFO order and a visited `HashSet` so loops
    /// in the graph (the workbook-level static cycle check is best-effort
    /// — runtime corruption / a sneaky test setup may still close one)
    /// terminate.
    ///
    /// Two-pass split note: both `mark_dirty_for_addr` and
    /// `fire_subscribers` take `&self`, so the BFS can use immutable
    /// borrows of `self.sheets[idx]` throughout. No `&mut self` reborrow
    /// is needed mid-iteration — the dirty-flip happens through interior
    /// mutability inside `FormulaCache::Dirty` / `AddressSubscriptionBucket`.
    fn propagate_cross_sheet_dirty(&self, src_sheet: usize, src_addr: CellAddress) {
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut queue: VecDeque<(usize, CellAddress)> = VecDeque::new();
        queue.push_back((src_sheet, src_addr));
        visited.insert((src_sheet, src_addr));

        while let Some((sheet_idx, addr)) = queue.pop_front() {
            // Collect dependents of this node from both reverse-index
            // halves. The CrossSheetDeps borrows are read-only, so we
            // can collect into a Vec then release the borrow before
            // touching the sheet (avoids any cross-borrow issues).
            let mut dependents: Vec<(usize, CellAddress)> = Vec::new();

            if let Some(set) = self.cross_sheet.cell_dependents.get(&(sheet_idx, addr)) {
                dependents.extend(set.iter().copied());
            }
            if let Some(range_idx) = self.cross_sheet.range_index_per_sheet.get(&sheet_idx) {
                // The range index is keyed by source sheet; its formula
                // set is `CellAddress`-only. The dependent's sheet is
                // recovered by looking up `formula_refs` — but we can
                // skip that by observing that every reverse range edge
                // emitted by `CrossSheetDeps::add_edge` is paired with a
                // matching forward `formula_refs` entry. To recover the
                // target sheet, scan `formula_refs` for any entry whose
                // outgoing list contains a `Range(sheet_idx, _)` that
                // covers `addr`. Cheaper alternative: iterate the formula
                // set directly and reverse-lookup the sheet via the
                // forward map.
                for target_addr in range_idx.dependents_of(addr) {
                    if let Some(target_sheet) =
                        self.find_target_sheet_for_range_dep(target_addr, sheet_idx)
                    {
                        dependents.push((target_sheet, target_addr));
                    }
                }
            }

            for (target_sheet, target_addr) in dependents {
                if !visited.insert((target_sheet, target_addr)) {
                    continue;
                }
                let Some(sheet) = self.sheets.get(target_sheet) else {
                    continue;
                };
                sheet.mark_dirty_for_addr(target_addr);
                sheet.fire_subscribers(target_addr);
                queue.push_back((target_sheet, target_addr));
            }
        }
    }

    /// Recover the formula's sheet index for a range-typed reverse edge.
    /// The per-source-sheet `RangeDependentIndex` stores only
    /// `CellAddress` in its formula set (matching the sheet-local shape);
    /// the corresponding sheet is held in `formula_refs` as the key.
    ///
    /// Walks the forward map and returns the first key whose
    /// `formula_addr == target_addr` and whose edge list contains a
    /// `Range(src_sheet, _)`. Worst case O(F) where F is the total
    /// formula_refs entries — acceptable for the dirty path, and small
    /// in practice (only formula cells live here, not data cells).
    fn find_target_sheet_for_range_dep(
        &self,
        target_addr: CellAddress,
        src_sheet: usize,
    ) -> Option<usize> {
        for ((formula_sheet, formula_addr), edges) in &self.cross_sheet.formula_refs {
            if *formula_addr != target_addr {
                continue;
            }
            for edge in edges {
                if let CrossSheetRef::Range(s, _) = edge {
                    if *s == src_sheet {
                        return Some(*formula_sheet);
                    }
                }
            }
        }
        None
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
    ///
    /// Clears the cross-sheet dep graph as a defensive measure — sheet
    /// removal shifts indices, and rewriting every `(idx, addr)` key on
    /// the fly is brittle. The next workbook-routed `set_formula` call
    /// will repopulate edges from the live formulas.
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
        // Sheet indices shifted; the cross-sheet dep graph is no longer
        // coherent. Drop it. (Phase 3 callers don't currently mix
        // `remove_sheet` with cross-sheet subscriptions; if that changes,
        // a future iteration can rewrite each `(idx, addr)` in place
        // instead of clearing.)
        self.cross_sheet = CrossSheetDeps::new();
        Some(sheet)
    }

    /// Debug-only: total cross-sheet reverse-edge count. Backs the Phase
    /// 3 acceptance assertion that workbook-routed writes actually
    /// exercise the dep graph (vs. silently no-oping the way the pre-
    /// Track-I `Sheet::set_cell`-only path did).
    #[doc(hidden)]
    pub fn debug_cross_sheet_reverse_edge_count(&self) -> usize {
        self.cross_sheet.debug_reverse_edge_count()
    }

    /// Workbook-level bulk loader (Phase 3 Track I). Collects every
    /// `set_cell` / `set_formula` / `clear_cell` invocation inside the
    /// closure, suppresses per-write fanout, then at flush time:
    ///   1. Replays each sheet's writes inside `Sheet::bulk_load` (so
    ///      same-sheet dirty + same-sheet subscriber fanout fires AT
    ///      MOST ONCE per address within that sheet's flush).
    ///   2. Applies the accumulated `CrossSheetDeps` edge updates.
    ///   3. Runs one workbook-wide cross-sheet BFS starting at the union
    ///      of touched `(sheet, addr)` pairs, and notifies each cross-
    ///      sheet subscriber AT MOST ONCE.
    ///
    /// Use this for CSV / xlsx import paths that touch many cells across
    /// many sheets and where the per-write cross-sheet fanout cost would
    /// otherwise dominate.
    ///
    /// RAII shape mirrors `Sheet::bulk_load`: the loader is not exposed
    /// outside the closure, so the flush always runs.
    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut WorkbookLoader<'_>) -> R) -> R {
        let mut loader = WorkbookLoader::new(self);
        let result = f(&mut loader);
        loader.flush();
        result
    }
}

/// Buffered op recorded by `WorkbookLoader`. Replayed at `flush` time
/// inside `Sheet::bulk_load`. The owning sheet is the HashMap key in
/// `ops_by_sheet`, so individual variants don't repeat `sheet_idx`.
enum WorkbookOp {
    SetCell {
        addr_str: String,
        value: Value,
    },
    SetFormula {
        addr_str: String,
        source: String,
    },
    ClearCell {
        addr_str: String,
    },
}

/// In-progress workbook bulk-load session. Buffers operations until
/// `flush` runs at the end of `Workbook::bulk_load`. Inside the closure
/// callers see synchronous returns from `set_formula` (parse / cycle
/// outcome decided here at queue time) but no subscriber fires and no
/// dirty fanout — all of that runs in one consolidated `flush`.
pub struct WorkbookLoader<'a> {
    wb: &'a mut Workbook,
    /// Per-sheet ordered op queues so the replay inside each sheet's
    /// `Sheet::bulk_load` preserves the caller's order.
    ops_by_sheet: HashMap<usize, Vec<WorkbookOp>>,
    /// Union of every `(sheet, addr)` that was written during the
    /// session (across all sheets). The post-flush cross-sheet BFS
    /// seeds from this set.
    touched: HashSet<(usize, CellAddress)>,
}

impl<'a> WorkbookLoader<'a> {
    fn new(wb: &'a mut Workbook) -> Self {
        WorkbookLoader {
            wb,
            ops_by_sheet: HashMap::new(),
            touched: HashSet::new(),
        }
    }

    /// Queue a primitive write at `(sheet_idx, addr)`. Visible to the
    /// post-flush workbook BFS as a touched cell.
    pub fn set_cell(&mut self, sheet_idx: usize, addr_str: &str, value: Value) {
        if sheet_idx >= self.wb.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.touched.insert((sheet_idx, addr));
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::SetCell {
                addr_str: addr_str.to_string(),
                value,
            });
    }

    /// Queue a formula write at `(sheet_idx, addr)`. Returns `false` if
    /// either the text fails to parse OR the cross-sheet static cycle
    /// check rejects it. Cross-sheet edges are installed eagerly so
    /// later ops in the same `bulk_load` see the up-to-date dep graph
    /// (e.g. for subsequent cycle checks); same-sheet wiring runs
    /// inside the per-sheet `Sheet::bulk_load` replay at flush time.
    pub fn set_formula(&mut self, sheet_idx: usize, addr_str: &str, source: &str) -> bool {
        if sheet_idx >= self.wb.sheets.len() {
            return false;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return false;
        };

        // Parse first. Parse failure still records a SetFormula op so
        // the sheet flush writes `#VALUE!` for us; cross-sheet edge
        // install is skipped on this branch.
        let Some(expr) = parse_formula(source) else {
            self.touched.insert((sheet_idx, addr));
            // Tear down any previous cross-sheet edges this addr owned
            // — a #VALUE! cell has no outgoing deps.
            self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
            self.ops_by_sheet
                .entry(sheet_idx)
                .or_default()
                .push(WorkbookOp::SetFormula {
                    addr_str: addr_str.to_string(),
                    source: source.to_string(),
                });
            return false;
        };

        // Cross-sheet static cycle check. Use the existing pre-Track-J
        // path (`collect_workbook_refs` + BFS through `formula_exprs_iter`)
        // — that map is populated only after the per-sheet flush runs,
        // so cycles introduced WITHIN the bulk_load against another
        // bulk-loaded formula slip past this check. That matches the
        // pre-Track-I `Sheet::bulk_load` behavior (its `would_create_
        // cycle` only sees already-installed formulas, not pending
        // ones); the static check still catches cycles against any
        // formula that existed before the bulk_load started.
        if self.wb.cross_sheet_cycle(sheet_idx, addr, &expr) {
            self.touched.insert((sheet_idx, addr));
            self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
            // Follow-up `SetCell` writes the `#CYCLE!` error after the
            // sheet bulk_load lands the formula (which the sheet's own
            // bulk_load may or may not have flagged as a cycle on its
            // own — workbook-level cycles can slip past the per-sheet
            // check). The final SetCell op guarantees the cell holds
            // `Value::Error(CyclicRef)` once flush completes.
            self.ops_by_sheet
                .entry(sheet_idx)
                .or_default()
                .push(WorkbookOp::SetCell {
                    addr_str: addr_str.to_string(),
                    value: Value::Error(ValueError::CyclicRef),
                });
            return false;
        }

        // Install fresh outgoing edges into CrossSheetDeps. Old edges
        // (if any) are removed first; the new edges go in eagerly so
        // subsequent `set_formula` calls in the same `bulk_load` see
        // the up-to-date forward map for their own cycle checks.
        self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
        let new_edges = collect_cross_sheet_refs(&expr, &self.wb.by_name);
        for edge in new_edges {
            self.wb.cross_sheet.add_edge(sheet_idx, addr, edge);
        }

        self.touched.insert((sheet_idx, addr));
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::SetFormula {
                addr_str: addr_str.to_string(),
                source: source.to_string(),
            });

        true
    }

    /// Queue a clear (=write to Null) at `(sheet_idx, addr)`.
    pub fn clear_cell(&mut self, sheet_idx: usize, addr_str: &str) {
        if sheet_idx >= self.wb.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.touched.insert((sheet_idx, addr));
        self.wb.cross_sheet.remove_outgoing(sheet_idx, addr);
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::ClearCell {
                addr_str: addr_str.to_string(),
            });
    }

    /// Replay queued ops sheet-by-sheet inside each sheet's
    /// `Sheet::bulk_load` (so same-sheet subscribers fire at most once
    /// per address per flush), then run one workbook-wide cross-sheet
    /// BFS that fires each cross-sheet subscriber at most once.
    fn flush(self) {
        let WorkbookLoader {
            wb,
            ops_by_sheet,
            touched,
        } = self;

        // 1. Per-sheet replay inside the existing `Sheet::bulk_load`
        //    plumbing. This handles same-sheet dirty/fire dedup.
        for (sheet_idx, ops) in ops_by_sheet {
            let Some(sheet) = wb.sheets.get_mut(sheet_idx) else {
                continue;
            };
            sheet.bulk_load(|loader| {
                for op in ops {
                    match op {
                        WorkbookOp::SetCell { addr_str, value } => {
                            loader.set_cell(&addr_str, value);
                        }
                        WorkbookOp::SetFormula {
                            addr_str,
                            source,
                        } => {
                            // Whether the workbook layer accepted or
                            // rejected the formula, hand it to the
                            // sheet's bulk loader: it writes `#VALUE!`
                            // on parse-fail, `#CYCLE!` on same-sheet
                            // cycle, and the live record otherwise.
                            // Cross-sheet cycle was already handled by
                            // the `set_formula` queue path inserting a
                            // follow-up `SetCell` to override with
                            // `Value::Error(CyclicRef)`.
                            loader.set_formula(&addr_str, &source);
                        }
                        WorkbookOp::ClearCell { addr_str } => {
                            loader.set_cell(&addr_str, Value::Null);
                        }
                    }
                }
            });
        }

        // 2. Workbook-wide cross-sheet BFS. Seed with the entire touched
        //    set so EVERY source write contributes to the dirty fanout.
        //    Within-sheet dependents already fired in step 1; this pass
        //    is strictly for cross-sheet edges.
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut queue: VecDeque<(usize, CellAddress)> = VecDeque::new();
        for entry in &touched {
            queue.push_back(*entry);
            visited.insert(*entry);
        }
        while let Some((sheet_idx, addr)) = queue.pop_front() {
            // Reverse dependents from the workbook graph (same shape
            // as `propagate_cross_sheet_dirty`'s inner loop). Visited
            // dedups so each cross-sheet subscriber fires at most once
            // across the entire bulk_load.
            let mut dependents: Vec<(usize, CellAddress)> = Vec::new();
            if let Some(set) = wb.cross_sheet.cell_dependents.get(&(sheet_idx, addr)) {
                dependents.extend(set.iter().copied());
            }
            if let Some(range_idx) = wb.cross_sheet.range_index_per_sheet.get(&sheet_idx) {
                for target_addr in range_idx.dependents_of(addr) {
                    if let Some(target_sheet) =
                        wb.find_target_sheet_for_range_dep(target_addr, sheet_idx)
                    {
                        dependents.push((target_sheet, target_addr));
                    }
                }
            }
            for (target_sheet, target_addr) in dependents {
                if !visited.insert((target_sheet, target_addr)) {
                    continue;
                }
                if let Some(sheet) = wb.sheets.get(target_sheet) {
                    sheet.mark_dirty_for_addr(target_addr);
                    sheet.fire_subscribers(target_addr);
                }
                queue.push_back((target_sheet, target_addr));
            }
        }
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

/// Walk an AST and emit every cross-sheet (NOT same-sheet) outgoing
/// edge as a `CrossSheetRef`. Used by `Workbook::set_formula` to seed
/// the reverse maps inside `CrossSheetDeps`.
///
/// Same-sheet refs (`CellRef`, `Range` with no sheet qualifier) are
/// deliberately skipped — those are owned by `Sheet::set_formula`'s
/// own `cell_dependents` / `range_dependents` insert paths and would
/// double-fire if duplicated here.
///
/// Cross-sheet ranges (`Sheet2!A1:A100`) aren't produced by the parser
/// yet, but the function is structured so the `CrossSheetRef::Range`
/// arm fires automatically once the parser grows that case — keeping
/// the data model forward-compatible for Phase 3 Track L's range
/// acceptance test (currently `#[ignore]`'d) and any later refactor.
fn collect_cross_sheet_refs(
    expr: &Expr,
    by_name: &HashMap<String, usize>,
) -> Vec<CrossSheetRef> {
    let mut out: Vec<CrossSheetRef> = Vec::new();
    collect_cross_sheet_refs_into(expr, by_name, &mut out);
    out
}

fn collect_cross_sheet_refs_into(
    expr: &Expr,
    by_name: &HashMap<String, usize>,
    out: &mut Vec<CrossSheetRef>,
) {
    match expr {
        Expr::CellRef(_) | Expr::Range { .. } => {
            // Same-sheet refs/ranges are owned by `Sheet::set_formula`.
        }
        Expr::SheetRef { sheet, addr } => {
            if let Some(&idx) = by_name.get(sheet) {
                out.push(CrossSheetRef::Cell(idx, *addr));
            }
            // Unknown sheet → dropped. Read time will surface #REF!.
        }
        Expr::BinOp { left, right, .. } => {
            collect_cross_sheet_refs_into(left, by_name, out);
            collect_cross_sheet_refs_into(right, by_name, out);
        }
        Expr::Negate(inner) => collect_cross_sheet_refs_into(inner, by_name, out),
        Expr::FuncCall { args, .. } => {
            for a in args {
                collect_cross_sheet_refs_into(a, by_name, out);
            }
        }
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
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
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            // Unbounded ranges aren't expanded — the cross-sheet cycle BFS
            // gates on `formula_exprs` membership per-sheet, and an
            // unbounded enumeration here would push the entire coordinate
            // space (u32::MAX entries). Cross-sheet cycles involving an
            // unbounded range stay detectable through the in-sheet
            // range_dependents path, which is consulted at dirty
            // propagation time.
            if !matches!(unbounded, RangeBounds::None) {
                return;
            }
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

    /// Sparse override for the workbook context. Routes the formula-cell
    /// read through `peek_value_with_provider` so cross-sheet references
    /// inside formulas in the iterated range can still resolve through
    /// the workbook chain (the single-sheet `peek_value` would return
    /// `#REF!` for `Sheet2!A1`).
    fn for_each_range_cell(
        &self,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        let idx = self.current.get();
        let sheet = &self.wb.sheets[idx];
        sheet.for_each_sparse_cell_with(
            range,
            &|sheet, addr| sheet.peek_value_with_provider(addr, self),
            f,
        );
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
