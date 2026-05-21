use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use std::sync::Arc;

use einfach_core::{ArrayData, AtomId, CellListener, Store, SubscriptionId, Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::{eval_expr_with_provider, EvalProvider};
use crate::format::{apply_rules, CellFormat, ConditionalRule};
use crate::formula::{parse_formula, Expr, RangeBounds};
use crate::range::CellRange;

/// Row-major sparse map over `(row, col) → V`. Wraps a
/// `BTreeMap<row, BTreeMap<col, V>>` so range scans cost
/// O(visited cells) instead of O(total entries). Drop-in replacement
/// for the `HashMap<CellAddress, V>` API the rest of `sheet.rs`
/// already speaks (`get`, `insert`, `remove`, `contains_key`, `len`,
/// `keys`, iteration as `(&CellAddress, &V)`), plus a `range_iter`
/// helper used by `for_each_sparse_cell_with` for O(range) viewport
/// reads (Phase 2 Track F target).
///
/// Stop condition (PHASE2_PARALLEL.md § Stop Conditions): if the
/// BTreeMap-of-BTreeMap overhead at 1M sparse cells exceeds the
/// HashMap version by >2×, pivot to a flat
/// `BTreeMap<(u32, u32), V>` keyed by `(row, col)`. Range scans
/// still work via `cells.range((min_row, 0)..=(max_row, u32::MAX))`
/// plus a per-row filter. We start with the nested shape because it
/// keeps the row-major iter trivial; we have not had to pivot.
pub(crate) struct RowMajorMap<V> {
    by_row: BTreeMap<u32, BTreeMap<u32, V>>,
    len: usize,
}

impl<V> RowMajorMap<V> {
    pub(crate) fn new() -> Self {
        RowMajorMap {
            by_row: BTreeMap::new(),
            len: 0,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[allow(dead_code)]
    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(crate) fn get(&self, addr: &CellAddress) -> Option<&V> {
        self.by_row
            .get(&addr.row)
            .and_then(|row| row.get(&addr.col))
    }

    pub(crate) fn contains_key(&self, addr: &CellAddress) -> bool {
        self.by_row
            .get(&addr.row)
            .map(|row| row.contains_key(&addr.col))
            .unwrap_or(false)
    }

    pub(crate) fn insert(&mut self, addr: CellAddress, value: V) -> Option<V> {
        let row = self.by_row.entry(addr.row).or_default();
        let prev = row.insert(addr.col, value);
        if prev.is_none() {
            self.len += 1;
        }
        prev
    }

    pub(crate) fn remove(&mut self, addr: &CellAddress) -> Option<V> {
        let row = self.by_row.get_mut(&addr.row)?;
        let removed = row.remove(&addr.col);
        if removed.is_some() {
            self.len -= 1;
            if row.is_empty() {
                self.by_row.remove(&addr.row);
            }
        }
        removed
    }

    /// Iterate every `(CellAddress, &V)` in row-major ascending order
    /// (ascending row, then ascending col within each row). Matches
    /// the deterministic order callers rely on for snapshots / undo.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (CellAddress, &V)> + '_ {
        self.by_row.iter().flat_map(|(&row, cols)| {
            cols.iter()
                .map(move |(&col, value)| (CellAddress::new(row, col), value))
        })
    }

    /// Iterate every present `(CellAddress, &V)` inside `range` —
    /// the O(cells_in_range) scan that motivates this whole type.
    /// Visits rows in ascending order, columns ascending within each
    /// row, matching the dense `CellRange::iter()` order so swapping
    /// from a dense walk to this one keeps deterministic output
    /// (e.g. for hash-ordered aggregates / formula dep tracking).
    pub(crate) fn range_iter(
        &self,
        range: CellRange,
    ) -> impl Iterator<Item = (CellAddress, &V)> + '_ {
        let n = range.normalize();
        let (r0, r1) = (n.start.row, n.end.row);
        let (c0, c1) = (n.start.col, n.end.col);
        self.by_row.range(r0..=r1).flat_map(move |(&row, cols)| {
            cols.range(c0..=c1)
                .map(move |(&col, value)| (CellAddress::new(row, col), value))
        })
    }

    /// Row-major key iterator (`HashMap::keys` analog). Returned
    /// keys are reconstructed `CellAddress`es; safe to `.copied()` /
    /// `.collect()` since `CellAddress: Copy`.
    pub(crate) fn keys(&self) -> impl Iterator<Item = CellAddress> + '_ {
        self.by_row
            .iter()
            .flat_map(|(&row, cols)| cols.keys().map(move |&col| CellAddress::new(row, col)))
    }

    /// Row-major value iterator (`HashMap::values` analog). Same
    /// ordering as `iter` minus the address — useful for "count
    /// matching" scans like `debug_dirty_count` that don't care
    /// where each entry lives.
    pub(crate) fn values(&self) -> impl Iterator<Item = &V> + '_ {
        self.by_row.values().flat_map(|cols| cols.values())
    }

    /// Drain into a row-major `(CellAddress, V)` iterator. Used by
    /// the structural-edit `relocate_cells` path that needs to
    /// rebuild the index under new keys.
    pub(crate) fn drain_into_vec(&mut self) -> Vec<(CellAddress, V)> {
        let mut out = Vec::with_capacity(self.len);
        let by_row = std::mem::take(&mut self.by_row);
        self.len = 0;
        for (row, cols) in by_row {
            for (col, value) in cols {
                out.push((CellAddress::new(row, col), value));
            }
        }
        out
    }
}

impl<V> Default for RowMajorMap<V> {
    fn default() -> Self {
        Self::new()
    }
}

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

#[derive(Clone, Debug, PartialEq)]
enum FormulaCache {
    Dirty,
    Computing,
    Clean(Value),
}

struct FormulaRecord {
    expr: Rc<Expr>,
    /// Point-cell dependencies (`Expr::CellRef`, plus bounded range cells
    /// expanded by `collect_refs`). Narrowed by eval-time tracking —
    /// branch-skipped `IF` arms drop out of this set, which is the intended
    /// behavior. Durable range identity lives in `range_deps` so sparse
    /// iteration cannot collapse a range to "visited cells only".
    deps: RefCell<HashSet<CellAddress>>,
    /// Range dependencies (`Expr::Range`), stored as ranges rather than
    /// expanded cells. Populated at `set_formula` time from
    /// `collect_range_refs` and preserved across eval — sparse iteration
    /// during eval must not narrow these to the visited subset, otherwise
    /// writing a previously-empty cell inside the range fails to dirty
    /// the formula (the P0 bug from `PHASE1_PARALLEL.md` § Track A).
    range_deps: RefCell<HashSet<CellRange>>,
    cache: RefCell<FormulaCache>,
}

impl FormulaRecord {
    fn new(expr: Rc<Expr>, deps: HashSet<CellAddress>, range_deps: HashSet<CellRange>) -> Self {
        FormulaRecord {
            expr,
            deps: RefCell::new(deps),
            range_deps: RefCell::new(range_deps),
            cache: RefCell::new(FormulaCache::Dirty),
        }
    }
}

#[derive(Clone, Debug)]
struct RangeFormat {
    range: CellRange,
    fmt: CellFormat,
}

#[derive(Clone, Debug)]
pub struct RangeFormatSnapshotLayer {
    pub range: CellRange,
    pub fmt: CellFormat,
}

#[derive(Clone, Debug)]
pub struct FormatRangeSnapshot {
    pub range: CellRange,
    pub cell_formats: Vec<(CellAddress, CellFormat)>,
    pub range_formats: Vec<RangeFormatSnapshotLayer>,
}

/// Token returned by `Sheet::subscribe_cell`. The public subscription is tied
/// to a cell address, not the current primitive atom. `Sheet` wires the
/// internal store subscription only while the address has a primitive atom;
/// formula cells are notified through the lazy dependency graph.
#[derive(Clone, Copy, Debug)]
pub struct CellSubscription {
    addr: CellAddress,
    listener_id: u64,
}

/// Errors returned by the `try_*` write APIs on `Sheet`. The plain
/// `set_cell` / `set_formula` family stays infallible (silently no-ops
/// on rejection) for backwards compatibility with existing callers; the
/// `try_*` family surfaces the same outcome as a `Result` so dynamic-
/// array hosts can report the failure to the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetError {
    /// The target address is part of an active spill range whose anchor
    /// lives elsewhere. The user must either clear the anchor or shrink
    /// the spill range before writing here. `anchor` is the address that
    /// currently owns the spill, so the UI can highlight or jump to it.
    SpillCellWrite { anchor: CellAddress },
    /// The supplied address string failed to parse as `A1`-style. Mirrors
    /// the panic that the infallible variants raise; surfaced as an error
    /// in the `try_*` variants so worker hosts don't crash on bad input.
    InvalidAddress,
}

impl std::fmt::Display for SheetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SheetError::SpillCellWrite { anchor } => write!(
                f,
                "cannot write to cell inside spill range anchored at {}",
                anchor
            ),
            SheetError::InvalidAddress => write!(f, "invalid cell address"),
        }
    }
}

impl std::error::Error for SheetError {}

/// Ranges spanning more than this many rows or columns skip the
/// per-row / per-col bucket registration and live in `wide_ranges` instead,
/// which gets a linear scan on lookup. Phase 2 Track E tuning knob — chosen
/// so that 100k narrow ranges (under a few thousand rows tall) stay in the
/// fast index but a small handful of "whole sheet" / "whole column 1M" deps
/// don't blow up registration time / memory.
const WIDE_RANGE_BUCKET_THRESHOLD: u32 = 4096;

/// Reverse index from `CellRange` to the formula cells that depend on that
/// exact range. Phase 1 stored only the `formulas: HashMap<CellRange, ...>`
/// lookup half, which made `Sheet::dependents_of(addr)` an O(range_count)
/// linear scan per cell write. Phase 2 Track E adds row + col bucket halves
/// plus a wide-range fallback so candidate-range lookup by address is
/// O(matches + wide_count) instead.
///
/// Invariant: a range `r` is present in EITHER `wide_ranges` OR in every
/// row in `start.row..=end.row` of `row_buckets` AND every col in
/// `start.col..=end.col` of `col_buckets`. The choice is decided once at
/// insert time by comparing `r.rows()` / `r.cols()` to
/// `WIDE_RANGE_BUCKET_THRESHOLD`. `formulas` is the source of truth for
/// "does this range still have a dependent" — buckets are kept in sync
/// with `formulas.contains_key(r)`.
#[derive(Default)]
pub(crate) struct RangeDependentIndex {
    /// `CellRange` → formula cells that depend on it. Mirror of the old
    /// `range_dependents` map; queried by `dependents_of` once candidate
    /// ranges have been narrowed by the buckets, and by
    /// `debug_range_dep_count` for the unchanged Phase 1 counter contract.
    formulas: HashMap<CellRange, HashSet<CellAddress>>,
    /// For each row r, the set of *narrow* ranges where
    /// `normalized.start.row <= r <= normalized.end.row`. Lookup intersects
    /// this with `col_buckets[addr.col]` to find candidate ranges.
    row_buckets: HashMap<u32, HashSet<CellRange>>,
    /// Same shape as `row_buckets` but keyed by column.
    col_buckets: HashMap<u32, HashSet<CellRange>>,
    /// Ranges wider than `WIDE_RANGE_BUCKET_THRESHOLD` in rows OR cols.
    /// Always linearly scanned on lookup — registering them in every row /
    /// col bucket they span would dominate insert cost. Expected to stay
    /// small (handful of "whole sheet" deps).
    wide_ranges: HashSet<CellRange>,
}

impl RangeDependentIndex {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Whether a range should live in the wide-range fallback bucket.
    /// Computed from the normalized range so a transposed `(B2:A1)` decides
    /// the same way as `(A1:B2)`. Wide on EITHER axis is enough — a
    /// 1-row 1M-col range is just as bucket-hostile as a 1M-row 1-col one.
    fn is_wide(range: &CellRange) -> bool {
        let n = range.normalize();
        let rows = n.end.row.saturating_sub(n.start.row).saturating_add(1);
        let cols = n.end.col.saturating_sub(n.start.col).saturating_add(1);
        rows > WIDE_RANGE_BUCKET_THRESHOLD || cols > WIDE_RANGE_BUCKET_THRESHOLD
    }

    /// Register `range` in the bucket index. No-op if `range` is already
    /// indexed — caller (`add_formula`) gates this on a fresh `formulas`
    /// entry to avoid redundant per-row work on repeat dependents.
    fn register_range(&mut self, range: CellRange) {
        if Self::is_wide(&range) {
            self.wide_ranges.insert(range);
            return;
        }
        let n = range.normalize();
        for r in n.start.row..=n.end.row {
            self.row_buckets.entry(r).or_default().insert(range);
        }
        for c in n.start.col..=n.end.col {
            self.col_buckets.entry(c).or_default().insert(range);
        }
    }

    /// Inverse of `register_range`. Called by `remove_formula` once the
    /// last formula for this range is gone. Drops emptied bucket entries
    /// so the maps stay bounded under formula churn.
    fn unregister_range(&mut self, range: CellRange) {
        if Self::is_wide(&range) {
            self.wide_ranges.remove(&range);
            return;
        }
        let n = range.normalize();
        for r in n.start.row..=n.end.row {
            if let Some(set) = self.row_buckets.get_mut(&r) {
                set.remove(&range);
                if set.is_empty() {
                    self.row_buckets.remove(&r);
                }
            }
        }
        for c in n.start.col..=n.end.col {
            if let Some(set) = self.col_buckets.get_mut(&c) {
                set.remove(&range);
                if set.is_empty() {
                    self.col_buckets.remove(&c);
                }
            }
        }
    }

    /// Insert `formula_addr` as a dependent of `range`. First-time
    /// registrations of `range` also wire it into the bucket index.
    pub(crate) fn add_formula(&mut self, range: CellRange, formula_addr: CellAddress) {
        let entry = self.formulas.entry(range).or_default();
        let was_empty = entry.is_empty();
        entry.insert(formula_addr);
        if was_empty {
            self.register_range(range);
        }
    }

    /// Remove `formula_addr` from `range`'s dependent set. Drops the
    /// `formulas` entry and unregisters the range from the bucket index
    /// when this was its last dependent — keeps `len()` and the buckets
    /// honest under formula churn.
    pub(crate) fn remove_formula(&mut self, range: CellRange, formula_addr: CellAddress) {
        let should_unregister = if let Some(set) = self.formulas.get_mut(&range) {
            set.remove(&formula_addr);
            set.is_empty()
        } else {
            false
        };
        if should_unregister {
            self.formulas.remove(&range);
            self.unregister_range(range);
        }
    }

    /// Forget everything. Used by `Sheet::rebuild_all_formula_dependents`
    /// before it walks the formula_cells map and re-adds every record.
    pub(crate) fn clear(&mut self) {
        self.formulas.clear();
        self.row_buckets.clear();
        self.col_buckets.clear();
        self.wide_ranges.clear();
    }

    /// Number of distinct `CellRange`s that currently have at least one
    /// dependent formula. Backs `Sheet::debug_range_dep_count` — the
    /// Phase 1 counter contract is unchanged.
    pub(crate) fn len(&self) -> usize {
        self.formulas.len()
    }

    /// Whether the index is empty. Convenience helper for cross-sheet
    /// dirty-fanout paths that want to short-circuit if a source sheet
    /// has no range dependents registered yet.
    #[allow(dead_code)]
    pub(crate) fn is_empty(&self) -> bool {
        self.formulas.is_empty()
    }

    /// Union of every formula dependent across every registered range that
    /// contains `addr`. Workbook-side helper that mirrors the sheet-local
    /// `Sheet::dependents_of` range half, but returns formula addresses
    /// directly so callers don't have to walk `candidates_for` +
    /// `formulas_for` themselves.
    #[allow(dead_code)]
    pub(crate) fn dependents_of(&self, addr: CellAddress) -> HashSet<CellAddress> {
        let mut out: HashSet<CellAddress> = HashSet::new();
        for range in self.candidates_for(addr) {
            if range.contains(addr) {
                if let Some(formulas) = self.formulas.get(&range) {
                    out.extend(formulas.iter().copied());
                }
            }
        }
        out
    }

    /// Candidate ranges that *might* contain `addr`, before the per-range
    /// `contains` filter. Combines:
    ///   - row_buckets[addr.row] ∩ col_buckets[addr.col] for narrow ranges
    ///   - the full `wide_ranges` set (always scanned linearly)
    ///
    /// Net cost: O(min(row_bucket_size, col_bucket_size) + wide_count).
    /// Caller filters by `range.contains(addr)` and looks each survivor
    /// up in `formulas`. Returned ranges are unique.
    pub(crate) fn candidates_for(&self, addr: CellAddress) -> Vec<CellRange> {
        let row_set = self.row_buckets.get(&addr.row);
        let col_set = self.col_buckets.get(&addr.col);

        let mut out: Vec<CellRange> = match (row_set, col_set) {
            (Some(rs), Some(cs)) => {
                // Intersect the smaller side against the larger — cuts
                // worst-case work for asymmetric narrow ranges (e.g. one
                // 6-row column-A range vs a single full-row range).
                let (small, large) = if rs.len() <= cs.len() {
                    (rs, cs)
                } else {
                    (cs, rs)
                };
                small
                    .iter()
                    .filter(|r| large.contains(*r))
                    .copied()
                    .collect()
            }
            _ => Vec::new(),
        };
        out.extend(self.wide_ranges.iter().copied());
        out
    }

    /// Lookup the formula set for a candidate range. None when the range
    /// has no dependents (should not happen for ranges returned by
    /// `candidates_for`, but the caller treats None as "skip").
    pub(crate) fn formulas_for(&self, range: &CellRange) -> Option<&HashSet<CellAddress>> {
        self.formulas.get(range)
    }
}

/// A spreadsheet sheet backed by an atom store.
pub struct Sheet {
    pub(crate) store: Store,
    /// Primitive cell atoms keyed by `(row, col)`. Backed by a row-major
    /// `RowMajorMap` so range reads (e.g. viewport, `SUM(A1:A100)`) scan
    /// O(cells_in_range) rather than the full non-empty set — the Phase 2
    /// Track F target from `PHASE2_PARALLEL.md`. API surface still mimics
    /// `HashMap` (`get`/`insert`/`remove`/`contains_key`/`len`/`keys`) so
    /// call sites elsewhere in this file stay unchanged.
    pub(crate) cells: RowMajorMap<AtomId>,
    /// Formula cells live at the Sheet layer. Formula results are cached here,
    /// not as core derived atoms, so `set_formula` does not compute. Same
    /// row-major shape as `cells` so range scans that hit a mix of primitive
    /// and formula cells stay O(matches).
    formula_cells: RowMajorMap<Rc<FormulaRecord>>,
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
    /// cell address → formula cells that depend on it.
    cell_dependents: RefCell<HashMap<CellAddress, HashSet<CellAddress>>>,
    /// `CellRange` → formula cells whose AST contains that exact range.
    /// `B1 = SUM(A1:A100)` registers `(A1:A100) → {B1}` here. Dirty
    /// propagation on a cell write `W` looks up every range that
    /// contains `W` and adds its dependents to the dirty set; that's
    /// what keeps range deps alive across sparse-eval narrowing of the
    /// point `deps` set (P0 from `PHASE1_PARALLEL.md` § Track A).
    ///
    /// Phase 2 Track E: this is now a `RangeDependentIndex` with row /
    /// col bucket halves plus a wide-range fallback, so the address →
    /// candidates lookup driving `dependents_of` is O(matches + wide)
    /// instead of O(range_count).
    range_dependents: RefCell<RangeDependentIndex>,
    next_cell_sub_id: u64,
    /// Per-cell formatting (Phase 6). Independent of the dep graph; format
    /// changes never trigger formula recompute. Entry absent → default.
    formats: HashMap<CellAddress, CellFormat>,
    /// Ordered range-format layers. Later entries win. The format lookup order
    /// is reversed so overlapping ranges resolve to the most recently added
    /// matching layer.
    range_formats: Vec<RangeFormat>,
    /// Sheet-wide conditional formatting rules. Applied in order on top of
    /// each cell's base format at display time (first match wins).
    conditional_rules: Vec<ConditionalRule>,
    /// Sparse row heights in physical pixels. Absent means the UI default.
    row_heights: BTreeMap<u32, u32>,
    /// Sparse column widths in physical pixels. Absent means the UI default.
    col_widths: BTreeMap<u32, u32>,
    /// Cumulative count of formula evaluations performed (cache-miss path in
    /// `eval_formula_at_with_provider`). Read-only debug counter used by the
    /// Phase 1 scale tests to assert laziness — `bulk_load` of N formulas
    /// must keep this at 0 until the first `get_cell`. `Cell` so the counter
    /// can be bumped from `&self` (eval runs through the immutable reader).
    formula_eval_count: Cell<usize>,
    /// Cumulative count of formulas inserted via `BulkLoader::set_formula`.
    /// Bumped once per successful entry inside `bulk_load`; the plain
    /// `Sheet::set_formula` path does NOT bump this. Used by the scale
    /// suite to verify "imported" vs "live-edited" formula provenance.
    imported_formula_count: Cell<usize>,

    // === Spill (dynamic-array) infrastructure ===
    //
    // Phase 1 wires the *plumbing* for dynamic-array spill. The atom-based
    // store already gives us correctly-derived dependent recompute and
    // subscription propagation — we don't need a parallel spill index or
    // look-aside table. Instead:
    //
    //   * The anchor cell's atom holds a `Value::Array`.
    //   * Each non-(0,0) target gets a NEW derived atom that reads the
    //     anchor and indexes into the array. We replace whatever was at
    //     that position in `Sheet::cells` with this derived atom.
    //   * On re-spill / clear, we remove those derived atoms from
    //     `Sheet::cells` and destroy them in the store. The single
    //     `spill_targets` map below records which atoms we installed so
    //     teardown is exact.
    //
    // Phase 1 limitations (documented in `register_spill` docs):
    //   - No auto-retry on conflict-resolve (clearing the obstructing
    //     cell does not retry the spill until the user re-evaluates).
    //   - No implicit array broadcast in arithmetic — Phase 3 work.
    //   - The JS / WASM boundary collapses `Value::Array` to its top-left
    //     element via `collapse_array_for_js`. JS never observes Array.
    /// Anchor atom → derived atoms we installed at the non-(0,0)
    /// spill targets. Stored by atom rather than address so the
    /// teardown path (`clear_spill`) does not need to re-resolve which
    /// addresses we wrote into — it already has the atom ids we
    /// allocated. Each target derived atom is also recorded in
    /// `Sheet::cells` under its target address so reads route through
    /// the normal cell-fetch path.
    ///
    /// `HashMap` rather than `BTreeMap` because `AtomId` deliberately
    /// does not derive `Ord` — atom-id ordering carries no semantic
    /// meaning and we never iterate this map in order.
    spill_targets: HashMap<AtomId, Vec<CellAddress>>,
}

impl Sheet {
    pub fn new() -> Self {
        Sheet {
            store: Store::new(),
            cells: RowMajorMap::new(),
            formula_cells: RowMajorMap::new(),
            formula_exprs: HashMap::new(),
            formula_texts: HashMap::new(),
            cell_subscriptions: HashMap::new(),
            cell_dependents: RefCell::new(HashMap::new()),
            range_dependents: RefCell::new(RangeDependentIndex::new()),
            next_cell_sub_id: 0,
            formats: HashMap::new(),
            range_formats: Vec::new(),
            conditional_rules: Vec::new(),
            row_heights: BTreeMap::new(),
            col_widths: BTreeMap::new(),
            formula_eval_count: Cell::new(0),
            imported_formula_count: Cell::new(0),
            spill_targets: HashMap::new(),
        }
    }

    pub fn set_row_height(&mut self, row_index: u32, height_px: u32) -> bool {
        if height_px == 0 {
            return self.clear_row_height(row_index);
        }
        self.row_heights.insert(row_index, height_px) != Some(height_px)
    }

    pub fn clear_row_height(&mut self, row_index: u32) -> bool {
        self.row_heights.remove(&row_index).is_some()
    }

    pub fn row_height(&self, row_index: u32) -> Option<u32> {
        self.row_heights.get(&row_index).copied()
    }

    pub fn row_heights_in_range(&self, start_row: u32, end_row: u32) -> Vec<(u32, u32)> {
        if end_row < start_row {
            return Vec::new();
        }
        self.row_heights
            .range(start_row..=end_row)
            .map(|(row_index, height_px)| (*row_index, *height_px))
            .collect()
    }

    pub fn all_row_heights(&self) -> Vec<(u32, u32)> {
        self.row_heights
            .iter()
            .map(|(row_index, height_px)| (*row_index, *height_px))
            .collect()
    }

    pub fn set_col_width(&mut self, col_index: u32, width_px: u32) -> bool {
        if width_px == 0 {
            return self.clear_col_width(col_index);
        }
        self.col_widths.insert(col_index, width_px) != Some(width_px)
    }

    pub fn clear_col_width(&mut self, col_index: u32) -> bool {
        self.col_widths.remove(&col_index).is_some()
    }

    pub fn col_width(&self, col_index: u32) -> Option<u32> {
        self.col_widths.get(&col_index).copied()
    }

    pub fn col_widths_in_range(&self, start_col: u32, end_col: u32) -> Vec<(u32, u32)> {
        if end_col < start_col {
            return Vec::new();
        }
        self.col_widths
            .range(start_col..=end_col)
            .map(|(col_index, width_px)| (*col_index, *width_px))
            .collect()
    }

    pub fn all_col_widths(&self) -> Vec<(u32, u32)> {
        self.col_widths
            .iter()
            .map(|(col_index, width_px)| (*col_index, *width_px))
            .collect()
    }

    fn shift_dimension_insert(dimensions: &mut BTreeMap<u32, u32>, at: u32, count: u32) {
        let mut shifted = BTreeMap::new();
        for (index, size_px) in dimensions.iter() {
            let next_index = if *index >= at {
                index.saturating_add(count)
            } else {
                *index
            };
            shifted.insert(next_index, *size_px);
        }
        *dimensions = shifted;
    }

    fn shift_dimension_delete(dimensions: &mut BTreeMap<u32, u32>, at: u32, count: u32) {
        let delete_end = at.saturating_add(count);
        let mut shifted = BTreeMap::new();
        for (index, size_px) in dimensions.iter() {
            if *index >= at && *index < delete_end {
                continue;
            }
            let next_index = if *index >= delete_end {
                index.saturating_sub(count)
            } else {
                *index
            };
            shifted.insert(next_index, *size_px);
        }
        *dimensions = shifted;
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

    /// Get or create the primitive atom for a cell. Formula results no longer
    /// have core atoms; callers needing a raw atom get the primitive slot.
    fn readable_atom(&mut self, addr: CellAddress) -> AtomId {
        self.ensure_cell(addr)
    }

    fn current_readable_atom(&self, addr: CellAddress) -> Option<AtomId> {
        if self.formula_cells.contains_key(&addr) {
            None
        } else {
            self.cells.get(&addr).copied()
        }
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

    fn formula_deps_for(expr: &Expr) -> HashSet<CellAddress> {
        let mut deps = Vec::new();
        collect_refs(expr, &mut deps);
        deps.into_iter().collect()
    }

    fn add_formula_deps(&self, formula_addr: CellAddress, deps: &HashSet<CellAddress>) {
        let mut dependents = self.cell_dependents.borrow_mut();
        for dep in deps {
            dependents.entry(*dep).or_default().insert(formula_addr);
        }
    }

    fn remove_formula_deps(&self, formula_addr: CellAddress, deps: &HashSet<CellAddress>) {
        let mut dependents = self.cell_dependents.borrow_mut();
        for dep in deps {
            let should_remove = if let Some(set) = dependents.get_mut(dep) {
                set.remove(&formula_addr);
                set.is_empty()
            } else {
                false
            };
            if should_remove {
                dependents.remove(dep);
            }
        }
    }

    /// Insert `formula_addr` as a dependent of every range in `ranges`.
    /// Companion to `add_formula_deps` for the range-typed dep index.
    /// Each `RangeDependentIndex::add_formula` call also wires the range
    /// into the row / col bucket halves (or `wide_ranges` if oversize) on
    /// its first dependent — see `RangeDependentIndex::register_range`.
    fn add_formula_range_deps(&self, formula_addr: CellAddress, ranges: &HashSet<CellRange>) {
        let mut dependents = self.range_dependents.borrow_mut();
        for r in ranges {
            dependents.add_formula(*r, formula_addr);
        }
    }

    /// Remove `formula_addr` from each range's dependent set. Mirrors
    /// `remove_formula_deps`. The bucket index entries (row / col / wide)
    /// are dropped automatically when the last dependent goes away, so the
    /// maps stay bounded under formula churn.
    fn remove_formula_range_deps(&self, formula_addr: CellAddress, ranges: &HashSet<CellRange>) {
        let mut dependents = self.range_dependents.borrow_mut();
        for r in ranges {
            dependents.remove_formula(*r, formula_addr);
        }
    }

    /// Replace this formula's point-cell `deps` with the eval-tracked set
    /// produced by `TrackingEvalProvider`. The sparse range iterator
    /// inside eval intentionally narrows this set to addresses that were
    /// actually visited — `IF`-branch selection drops the unselected
    /// arm's references, which is correct behavior.
    ///
    /// `range_deps` is deliberately untouched: those entries were
    /// captured statically from `Expr::Range` at `set_formula` time and
    /// must survive sparse-eval narrowing. Otherwise a write to a
    /// previously-empty cell inside the range would miss dirty
    /// propagation (P0 from `PHASE1_PARALLEL.md` § Track A). The
    /// Dirty propagation consults `range_dependents` in addition to
    /// `cell_dependents` on each cell write so the surviving range entries
    /// are honored.
    fn replace_formula_deps(
        &self,
        formula_addr: CellAddress,
        record: &FormulaRecord,
        new_deps: HashSet<CellAddress>,
    ) {
        let old_deps = record.deps.replace(new_deps.clone());
        self.remove_formula_deps(formula_addr, &old_deps);
        self.add_formula_deps(formula_addr, &new_deps);
        // Note: record.range_deps and self.range_dependents are
        // intentionally NOT touched here. They reflect the static
        // structure of the formula and only change when `set_formula`
        // overwrites the cell or `remove_formula_record` drops it.
    }

    fn remove_formula_record(&mut self, addr: CellAddress) -> Option<Rc<FormulaRecord>> {
        let record = self.formula_cells.remove(&addr)?;
        let deps = record.deps.borrow().clone();
        self.remove_formula_deps(addr, &deps);
        let range_deps = record.range_deps.borrow().clone();
        self.remove_formula_range_deps(addr, &range_deps);
        self.formula_exprs.remove(&addr);
        self.formula_texts.remove(&addr);
        Some(record)
    }

    fn rebuild_all_formula_dependents(&self) {
        self.cell_dependents.borrow_mut().clear();
        self.range_dependents.borrow_mut().clear();
        for (addr, record) in self.formula_cells.iter() {
            let deps = record.deps.borrow().clone();
            self.add_formula_deps(addr, &deps);
            let range_deps = record.range_deps.borrow().clone();
            self.add_formula_range_deps(addr, &range_deps);
        }
    }

    /// Collect every formula address that depends on a write to `addr`,
    /// merging point-cell dependents from `cell_dependents` with any
    /// range dependents whose range contains `addr`. Pulled into a helper
    /// so both the per-write BFS (`mark_dependents_dirty`) and the
    /// bulk-load `flush` walk use the same union.
    ///
    /// The range half walks only the bucket-narrowed candidate set from
    /// `RangeDependentIndex::candidates_for` plus the small wide-range
    /// fallback — O(matches + wide_count) per call, not the Phase 1
    /// O(range_count) scan.
    fn dependents_of(&self, addr: CellAddress) -> HashSet<CellAddress> {
        let mut out: HashSet<CellAddress> = self
            .cell_dependents
            .borrow()
            .get(&addr)
            .cloned()
            .unwrap_or_default();
        let range_dependents = self.range_dependents.borrow();
        for range in range_dependents.candidates_for(addr) {
            if range.contains(addr) {
                if let Some(formulas) = range_dependents.formulas_for(&range) {
                    out.extend(formulas.iter().copied());
                }
            }
        }
        out
    }

    /// Workbook-facing helper: flip the formula cache for `addr` to
    /// `Dirty` *without* triggering eval. Same internal operation as the
    /// dirty step inside `mark_dependents_dirty`, exposed so the
    /// workbook-level cross-sheet propagation (Phase 3 Track I) can mark
    /// a specific cross-sheet formula stale after a source-sheet write.
    ///
    /// No-op when `addr` is not a formula cell on this sheet (the cross-
    /// sheet reverse index occasionally races formula removal — a
    /// dangling `(sheet, addr)` entry pointing at a cleared cell just
    /// becomes a cheap miss instead of a panic).
    ///
    /// Intentionally does NOT walk same-sheet dependents — the Sheet's
    /// own `set_cell` path already did that. This helper is purely the
    /// "mark this one formula dirty" primitive.
    pub fn mark_dirty_for_addr(&self, addr: CellAddress) {
        if let Some(record) = self.formula_cells.get(&addr) {
            *record.cache.borrow_mut() = FormulaCache::Dirty;
        }
    }

    /// Workbook-facing helper: synchronously fire every listener in
    /// `cell_subscriptions[addr]`. Companion to `mark_dirty_for_addr` —
    /// the workbook BFS calls `mark_dirty_for_addr` followed by
    /// `fire_subscribers` so cross-sheet formula listeners see the same
    /// "value may have changed" signal that a same-sheet write would
    /// produce via `notify_address_subscribers` from `set_cell`.
    ///
    /// No-op when the address has no subscription bucket or no listeners
    /// — the bucket map is sparse (only `subscribe_cell` populates it).
    pub fn fire_subscribers(&self, addr: CellAddress) {
        if self.has_address_subscribers(addr) {
            self.notify_address_subscribers(addr);
        }
    }

    fn mark_dependents_dirty(&self, root: CellAddress) -> HashSet<CellAddress> {
        let mut notified = HashSet::new();
        let mut stack: Vec<CellAddress> = self.dependents_of(root).into_iter().collect();

        while let Some(addr) = stack.pop() {
            if !notified.insert(addr) {
                continue;
            }
            if let Some(record) = self.formula_cells.get(&addr) {
                *record.cache.borrow_mut() = FormulaCache::Dirty;
            }
            self.notify_address_subscribers(addr);

            stack.extend(self.dependents_of(addr));
        }

        notified
    }

    // === Spill (dynamic-array) infrastructure ===
    //
    // See the `spill_targets` field doc comment above for the high-level
    // design rationale. The methods below are the bookkeeping primitives
    // that every spill mutation goes through.

    /// UI helper: if `addr` is a spill *anchor*, return its array shape
    /// `(rows, cols)`. Otherwise None.
    ///
    /// Detection: walk `cells` for `addr`, fetch the underlying atom's
    /// value, and inspect for `Value::Array`. We can't index `spill_targets`
    /// by anchor address — it's keyed by anchor *atom id* — so this lookup
    /// goes through the live value. Anchors that hold `#SPILL!` (collision)
    /// have no `Array` and so return None here, matching Excel's "the
    /// anchor has no spill" semantics in the collision case.
    pub fn spill_info(&self, addr: CellAddress) -> Option<(u32, u32)> {
        let &atom_id = self.cells.get(&addr)?;
        if !self.store.has_atom(atom_id) {
            return None;
        }
        match self.store.get(atom_id) {
            Value::Array(arr) => Some(arr.shape()),
            _ => None,
        }
    }

    /// True if `addr` is a NON-anchor spilled cell. Convenience for
    /// callers that need to refuse writes or annotate the UI without
    /// resolving the anchor address.
    pub fn is_spilled(&self, addr: CellAddress) -> bool {
        self.spilled_into_anchor(addr).is_some()
    }

    /// If `addr` is part of an active spill range whose anchor lives
    /// elsewhere, return the anchor's address. Returns None when `addr`
    /// is either the anchor itself, a plain cell, or empty.
    ///
    /// Implementation: scan `spill_targets` values. For Phase 1 we keep
    /// this O(spills) — the typical workbook has a handful of active
    /// spill ranges, well below the cost of a reverse address index.
    fn spilled_into_anchor(&self, addr: CellAddress) -> Option<CellAddress> {
        for (&anchor_atom, targets) in &self.spill_targets {
            if !targets.iter().any(|t| *t == addr) {
                continue;
            }
            // Locate the anchor address by reverse-scanning `cells`.
            // The map is small (one entry per cell) but for Phase 1 we
            // accept the O(n) scan — anchor address lookups are rare
            // (only for error messages and `is_spilled`).
            for (cell_addr, &cell_atom) in self.cells.iter() {
                if cell_atom == anchor_atom {
                    return Some(cell_addr);
                }
            }
        }
        None
    }

    /// Look up the anchor address for a given anchor atom by reverse-scanning
    /// `cells`. Returns None if the anchor has been removed from `cells`
    /// (which shouldn't happen in normal flow — spill teardown clears
    /// `spill_targets` first). Currently unused — kept for symmetry with
    /// `spilled_into_anchor`, which performs the same lookup inline.
    #[allow(dead_code)]
    fn anchor_address_for(&self, anchor_atom: AtomId) -> Option<CellAddress> {
        for (cell_addr, &cell_atom) in self.cells.iter() {
            if cell_atom == anchor_atom {
                return Some(cell_addr);
            }
        }
        None
    }

    /// Install spilled derived atoms for every non-(0,0) target inside
    /// the array's bounding rectangle anchored at `anchor_addr`. The
    /// anchor's own atom is expected to already hold `Value::Array(arr)`
    /// — this method only wires up the targets.
    ///
    /// Returns `Err(ValueError::Spill)` if any target collides with an
    /// existing non-empty cell. On error NO targets are installed and the
    /// caller is responsible for routing `#SPILL!` to the anchor.
    ///
    /// Collision rule: a target cell is "occupied" if it has a primitive
    /// atom holding a non-Null value, OR it is itself a formula cell, OR
    /// it is currently a spilled cell from another anchor. A truly-empty
    /// cell (no atom or atom = Null with no formula) is fine to spill into.
    fn register_spill(
        &mut self,
        anchor_addr: CellAddress,
        anchor_atom: AtomId,
        arr: &Arc<ArrayData>,
    ) -> Result<(), ValueError> {
        let (rows, cols) = arr.shape();
        if rows == 0 || cols == 0 {
            // Empty array — nothing to spill into. Treat as success.
            self.spill_targets.insert(anchor_atom, Vec::new());
            return Ok(());
        }

        // First pass: collision detection. We compute every target
        // (skipping (0, 0) which is the anchor) and ensure no obstruction.
        let mut targets: Vec<CellAddress> = Vec::with_capacity(
            (rows as usize) * (cols as usize) - 1,
        );
        for di in 0..rows {
            for dj in 0..cols {
                if di == 0 && dj == 0 {
                    continue;
                }
                let target = CellAddress::new(anchor_addr.row + di, anchor_addr.col + dj);
                if self.is_target_occupied(target, anchor_atom) {
                    return Err(ValueError::Spill);
                }
                targets.push(target);
            }
        }

        // Second pass: install. For each target, create a derived atom
        // that reads the anchor and indexes into the array at the offset
        // implied by (di, dj). The derived atom is registered in `cells`
        // under the target address so reads go through the normal path.
        let mut idx = 0usize;
        for di in 0..rows {
            for dj in 0..cols {
                if di == 0 && dj == 0 {
                    continue;
                }
                let target = targets[idx];
                idx += 1;
                let anchor_atom_for_read = anchor_atom;
                let row_off = di;
                let col_off = dj;
                let derived = self.store.create_derived(move |get| match get(anchor_atom_for_read) {
                    Value::Array(inner) => inner
                        .get(row_off, col_off)
                        .cloned()
                        .unwrap_or(Value::Null),
                    // Anchor switched off Array (e.g. became #SPILL! after
                    // a later remap that hasn't yet cleared us). Return
                    // Null defensively — the parent re-spill will
                    // re-install a fresh derived atom anyway.
                    _ => Value::Null,
                });

                // If there was a stale primitive at this address (e.g.
                // empty `Value::Null` placeholder created by a previous
                // subscribe), remove it first so we don't leak an atom.
                if let Some(prev) = self.cells.remove(&target) {
                    if self.store.has_atom(prev) && !self.store.has_dependents(prev) {
                        self.store.destroy_atom(prev);
                    }
                }
                self.cells.insert(target, derived);
                // Re-attach subscription bucket (if any) so address-level
                // listeners see updates from the new derived atom.
                self.attach_address_sub(target);
                self.mark_dependents_dirty(target);
            }
        }

        self.spill_targets.insert(anchor_atom, targets);
        Ok(())
    }

    /// Detect whether `target` is currently occupied for spill purposes.
    /// `our_anchor_atom` is the anchor we're spilling FROM — entries in
    /// `spill_targets[our_anchor_atom]` should NOT be considered
    /// collisions (we're re-spilling into our own previous range).
    fn is_target_occupied(&self, target: CellAddress, our_anchor_atom: AtomId) -> bool {
        // (a) Formula cell at target — always blocks.
        if self.formula_cells.contains_key(&target) {
            return true;
        }
        // (b) Primitive atom holding a non-Null value.
        if let Some(&atom_id) = self.cells.get(&target) {
            if self.store.has_atom(atom_id) {
                let v = self.store.get(atom_id);
                if !matches!(v, Value::Null) {
                    // (c) Skip if this is already one of OUR own spill
                    // targets — we're re-spilling and the previous round
                    // installed this derived atom. Caller (`set_array`)
                    // tears the old spill down BEFORE calling
                    // register_spill, so in practice we never see our
                    // own targets here; the guard is defensive.
                    if let Some(targets) = self.spill_targets.get(&our_anchor_atom) {
                        if targets.iter().any(|t| *t == target) {
                            return false;
                        }
                    }
                    // Check if it's a spilled cell from ANOTHER anchor.
                    // Iterate `spill_targets` — if any OTHER anchor lists
                    // `target`, that's a cross-anchor collision.
                    for (anchor_atom, targets) in &self.spill_targets {
                        if *anchor_atom == our_anchor_atom {
                            continue;
                        }
                        if targets.iter().any(|t| *t == target) {
                            return true;
                        }
                    }
                    // Plain non-Null primitive — collision.
                    return true;
                }
            }
        }
        false
    }

    /// Inverse of `register_spill`. For each derived atom recorded under
    /// `anchor_atom`, remove it from `cells` and destroy the underlying
    /// atom. The anchor itself is NOT touched — caller decides whether
    /// to leave the anchor in place (re-spill incoming) or also clear it.
    ///
    /// Subscribers on the cleared addresses are re-fired via the
    /// remap helper so listeners observe the now-empty cell.
    fn clear_spill(&mut self, anchor_atom: AtomId) {
        let Some(targets) = self.spill_targets.remove(&anchor_atom) else {
            return;
        };
        for target in targets {
            // Detach the address subscription bucket from the soon-dead
            // atom; reattach after removal so listeners refresh.
            self.detach_address_sub(target);
            if let Some(derived_id) = self.cells.remove(&target) {
                if self.store.has_atom(derived_id) {
                    // Spilled cells are read-only derived atoms with
                    // (typically) no further atom-level dependents.
                    // Formula cells that referenced this address read
                    // via the Sheet-level peek path; the dep graph
                    // there is in `cell_dependents`, not in the store's
                    // back_deps. So destroy is safe.
                    if !self.store.has_dependents(derived_id) {
                        self.store.destroy_atom(derived_id);
                    }
                    // If something did register a downstream derived atom
                    // (no API for that today), we'd leak the spilled
                    // derived atom rather than panic — acknowledged as
                    // a Phase 1 limitation.
                }
            }
            self.attach_address_sub(target);
            self.mark_dependents_dirty(target);
        }
    }

    /// Locate the anchor atom for `addr` (if any) and clear its spill.
    /// Used when overwriting the anchor cell — the new write replaces
    /// the array, so the old spill must go away. No-op when `addr` is
    /// not a spill anchor.
    fn clear_spill_at_address(&mut self, addr: CellAddress) {
        let Some(&atom_id) = self.cells.get(&addr) else {
            return;
        };
        if self.spill_targets.contains_key(&atom_id) {
            self.clear_spill(atom_id);
        }
    }

    /// Install (or refresh) a primitive anchor atom holding `arr` at
    /// `addr` for a formula whose latest result was `Value::Array(arr)`.
    /// The formula record at `addr` is preserved — only the primitive
    /// atom in `self.cells[addr]` is created / updated to mirror the
    /// formula's array result, so spilled derived atoms have a
    /// dependency-tracked source to read.
    ///
    /// On spill collision the anchor primitive atom is set to
    /// `Value::Error(Spill)` (sheet-level read of `addr` still goes
    /// through the formula cache and surfaces the Array — but the
    /// returned `Err(Spill)` signals the caller that they should NOT
    /// trust the Array result; the eager re-eval path overwrites the
    /// formula cache with `#SPILL!` to keep Sheet-level reads honest).
    ///
    /// Returns `Ok(())` on clean install or `Err(ValueError::Spill)` on
    /// collision. Other variants propagate from `register_spill`.
    fn install_formula_spill(
        &mut self,
        addr: CellAddress,
        arr: Arc<ArrayData>,
    ) -> Result<(), ValueError> {
        // Reuse the anchor primitive atom if it already exists (re-spill
        // case — same address, shape may or may not differ). Otherwise
        // create one. The atom holds `Value::Array` so the per-target
        // derived atoms (installed below) can read it.
        let anchor_atom = self.ensure_cell(addr);
        self.attach_address_sub(addr);
        self.store.set(anchor_atom, Value::Array(arr.clone()));
        self.register_spill(addr, anchor_atom, &arr)
    }

    /// Eager re-eval + spill maintenance for a single formula cell.
    /// Forces a recompute (bypassing the cache), then:
    ///   - if the new result is `Value::Array` → install / refresh the
    ///     spill anchor and derived targets via `install_formula_spill`.
    ///     On collision, the formula cache is overwritten with
    ///     `Value::Error(Spill)` so subsequent reads at `addr` surface
    ///     `#SPILL!`.
    ///   - if the new result is not an array → tear down any existing
    ///     spill at `addr` (the formula previously produced an array).
    ///
    /// No-op for non-formula cells. Called from the mutation paths
    /// (`try_set_formula`, `try_set_cell`, `clear_cell`) so dynamic-array
    /// formulas re-spill synchronously on dependency changes — the
    /// `Sheet::get_cell` lazy eval path can't mutate, so the spill
    /// install has to happen here.
    fn recompute_array_formula(&mut self, addr: CellAddress) {
        // Snapshot whether this address previously held a spill anchor
        // (in cells[addr] → spill_targets). Used to decide whether we
        // need to tear down on a scalar result.
        let prev_anchor_atom: Option<AtomId> = self
            .cells
            .get(&addr)
            .copied()
            .filter(|id| self.spill_targets.contains_key(id));

        let Some(record) = self.formula_cells.get(&addr).cloned() else {
            // Not a formula cell — nothing to recompute.
            return;
        };

        // Gate the eager re-eval: only formulas that *might* produce a
        // `Value::Array` get this treatment. Scalar-only formulas stay
        // fully lazy (preserves the lazy-eval debug counters and the
        // existing dirty-count invariants).
        if prev_anchor_atom.is_none() && !expr_may_produce_array(&record.expr) {
            return;
        }

        // Mark dirty so eval_formula_at_with_provider re-runs (it bails
        // early on `FormulaCache::Clean`).
        *record.cache.borrow_mut() = FormulaCache::Dirty;

        // Build a borrowing provider mirroring `peek_value`. We can't
        // call `peek_value_with_provider` directly because it takes
        // `&self`; we need `&mut self` after the eval to mutate the
        // spill state. The pattern: scope the immutable borrow inside
        // a block, extract the resulting value, then take &mut self.
        let value = {
            let provider = SheetEvalProvider {
                sheet: &*self,
                current_cell: Cell::new(None),
            };
            self.eval_formula_at_with_provider(addr, &provider)
        };

        match value {
            Value::Array(arr) => {
                // Tear down any previous spill at this address before
                // re-installing (handles shape changes).
                self.clear_spill_at_address(addr);
                match self.install_formula_spill(addr, arr) {
                    Ok(()) => {}
                    Err(ValueError::Spill) => {
                        // Overwrite the formula cache with #SPILL! so
                        // Sheet-level reads surface the error. The
                        // anchor primitive atom is already set to
                        // Value::Error(Spill) by install_formula_spill's
                        // error path? No — install_formula_spill leaves
                        // the atom holding Value::Array on collision.
                        // Fix that here:
                        if let Some(&atom_id) = self.cells.get(&addr) {
                            self.store.set(atom_id, Value::Error(ValueError::Spill));
                        }
                        if let Some(record) = self.formula_cells.get(&addr) {
                            *record.cache.borrow_mut() =
                                FormulaCache::Clean(Value::Error(ValueError::Spill));
                        }
                    }
                    Err(other) => {
                        if let Some(&atom_id) = self.cells.get(&addr) {
                            self.store.set(atom_id, Value::Error(other.clone()));
                        }
                        if let Some(record) = self.formula_cells.get(&addr) {
                            *record.cache.borrow_mut() =
                                FormulaCache::Clean(Value::Error(other));
                        }
                    }
                }
                self.mark_dependents_dirty(addr);
            }
            _ => {
                // Formula no longer produces an array — tear down any
                // prior spill. If the cells[addr] primitive atom was the
                // spill anchor, drop it so future reads go cleanly
                // through the formula cache.
                if prev_anchor_atom.is_some() {
                    self.clear_spill_at_address(addr);
                    if let Some(prim) = self.cells.remove(&addr) {
                        if self.store.has_atom(prim) && !self.store.has_dependents(prim) {
                            self.store.destroy_atom(prim);
                        }
                    }
                    // Re-attach the address subscription bucket to
                    // whatever the cell is now (formula-only).
                    self.attach_address_sub(addr);
                    self.mark_dependents_dirty(addr);
                }
            }
        }
    }

    /// Walk every dirty formula reachable from `root` and re-evaluate
    /// it; for ones that produce / used to produce a `Value::Array`,
    /// (re)install or tear down the spill via
    /// `recompute_array_formula`. Called from the mutation paths after
    /// `mark_dependents_dirty` so dependency changes propagate into the
    /// spill state synchronously (the `&self` lazy-read path can't
    /// install spills).
    ///
    /// Scope: addresses in `dependents`, plus `root` itself if it has a
    /// formula record (the initial-install path also calls this to
    /// catch the just-installed formula at `root`).
    fn recompute_array_formulas_in(&mut self, addrs: &HashSet<CellAddress>) {
        // Collect addresses to process — clone the addresses to avoid
        // borrowing self while we mutate.
        let candidates: Vec<CellAddress> = addrs
            .iter()
            .copied()
            .filter(|a| self.formula_cells.contains_key(a))
            .collect();
        for a in candidates {
            self.recompute_array_formula(a);
        }
    }

    /// Write a `Value::Array` to an anchor cell and install / re-install
    /// the spill range. On spill collision, the anchor is set to
    /// `Value::Error(Spill)` and no targets are installed.
    ///
    /// This is the Phase 1 entry point used by tests to exercise the
    /// spill plumbing without a user-facing array-producing function.
    /// Phase 3 will wire the formula eval path to call this when a
    /// formula result evaluates to `Value::Array`.
    ///
    /// Returns the same `Result` shape as `register_spill` so callers
    /// can distinguish "spilled cleanly" from "collision, anchor now
    /// `#SPILL!`". Either outcome leaves the sheet in a consistent
    /// state — the anchor cell always reflects the result.
    pub fn set_array(
        &mut self,
        addr_str: &str,
        arr: Arc<ArrayData>,
    ) -> Result<(), SheetError> {
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        // Reject writes into another anchor's spill range — same
        // contract as `try_set_cell`. The user must clear that anchor
        // first.
        if let Some(anchor) = self.spilled_into_anchor(addr) {
            return Err(SheetError::SpillCellWrite { anchor });
        }

        // Tear down any spill the current cell already owns; we're
        // replacing it.
        self.clear_spill_at_address(addr);

        // Drop any prior formula at the anchor — an array write is a
        // primitive-style mutation that replaces formula state.
        let had_formula = self.formula_cells.contains_key(&addr);
        if had_formula {
            self.with_remap(addr, |sheet| {
                sheet.remove_formula_record(addr);
                let _ = sheet.ensure_cell(addr);
            });
        }

        let anchor_atom = self.ensure_cell(addr);
        self.attach_address_sub(addr);

        // Write the array to the anchor.
        self.store.set(anchor_atom, Value::Array(arr.clone()));

        // Try to install spill targets. On collision, overwrite the
        // anchor with `#SPILL!` so the user sees the error at the
        // anchor cell (Excel parity).
        match self.register_spill(addr, anchor_atom, &arr) {
            Ok(()) => {}
            Err(ValueError::Spill) => {
                self.store
                    .set(anchor_atom, Value::Error(ValueError::Spill));
            }
            Err(other) => {
                // register_spill currently only returns Spill, but
                // future variants would surface here defensively.
                self.store.set(anchor_atom, Value::Error(other));
            }
        }
        self.mark_dependents_dirty(addr);
        Ok(())
    }

    /// Set a cell's value by address string (e.g. "A1").
    /// Clears any existing formula on this cell. Silently no-ops when
    /// `addr_str` is the non-anchor target of an active spill — use
    /// `try_set_cell` for callers that need to surface that rejection.
    ///
    /// Panics on an unparseable `addr_str`. The fallible
    /// `try_set_cell` returns `Err(SheetError::InvalidAddress)` instead;
    /// the panic here preserves the historical contract.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        // Preserve legacy panic-on-bad-address contract — only the
        // spill-rejection branch is the new silent-no-op behavior.
        CellAddress::parse(addr_str).expect("invalid cell address");
        let _ = self.try_set_cell(addr_str, value);
    }

    /// Fallible variant of `set_cell`. Returns `Err(SpillCellWrite { .. })`
    /// when the address is currently a non-anchor target of an active
    /// spill range — the anchor must be cleared or shrunk before that
    /// cell can be overwritten. Returns `Err(InvalidAddress)` when the
    /// address string fails to parse (the infallible variant panics).
    pub fn try_set_cell(&mut self, addr_str: &str, value: Value) -> Result<(), SheetError> {
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        if let Some(anchor) = self.spilled_into_anchor(addr) {
            return Err(SheetError::SpillCellWrite { anchor });
        }
        // If this address was itself a spill anchor, the new write
        // replaces the array — tear the spill down first so we don't
        // strand the derived atoms at the old targets.
        self.clear_spill_at_address(addr);

        let had_formula = self.formula_cells.contains_key(&addr);
        let is_null = matches!(value, Value::Null);

        if had_formula {
            self.with_remap(addr, |sheet| {
                sheet.remove_formula_record(addr);
                let id = sheet.ensure_cell(addr);
                sheet.store.set(id, value);
            });
            // 3.10 — formula→primitive→Null with no surviving dependents leaks
            // the freshly ensured primitive scaffold. The with_remap tail has
            // already reattached the fanout; try_release_primitive will
            // detach it again so the bucket goes back to "subscribed but no
            // materialized atom" — symmetrical with subscribing to an empty
            // cell before any write.
            if is_null {
                self.try_release_primitive(addr);
            }
        } else {
            let id = self.ensure_cell(addr);
            self.attach_address_sub(addr);
            self.store.set(id, value);
            // 3.10 — drop the primitive when a non-formula cell is cleared
            // back to Null with no live dependents. Listener bucket stays.
            if is_null {
                self.try_release_primitive(addr);
            }
        }
        let dirtied = self.mark_dependents_dirty(addr);
        // Eager spill maintenance for downstream array formulas.
        self.recompute_array_formulas_in(&dirtied);
        Ok(())
    }

    /// Clear a cell back to empty (Null). Equivalent to `set_cell(addr, Value::Null)`
    /// but with a more discoverable name for callers implementing Delete-key /
    /// undo-to-empty UX. Silently no-ops on spill rejection — use
    /// `try_clear_cell` if you need the error.
    pub fn clear_cell(&mut self, addr_str: &str) {
        let _ = self.try_clear_cell(addr_str);
    }

    /// Fallible variant of `clear_cell`. Returns the same error variants
    /// as `try_set_cell` with `Value::Null`.
    pub fn try_clear_cell(&mut self, addr_str: &str) -> Result<(), SheetError> {
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        self.try_set_cell(addr_str, Value::Null)?;
        // set_cell already calls try_release_primitive when the new value is
        // Null; the second call here is defensive in case a future change to
        // set_cell rearranges that path. It's a no-op when the cell was
        // already released.
        self.try_release_primitive(addr);
        Ok(())
    }

    /// 3.10 — release the primitive cell atom for `addr` when it is Null and
    /// has no live dependents. Used by `clear_cell` / `set_cell(.., Null)` to
    /// keep `cells.len()` bounded across long-running sheets where many cells
    /// get set then cleared. Skips formula cells and skips any primitive
    /// that still has core dependents (would panic `Store::destroy_atom`).
    ///
    /// Address listener buckets stay alive — only the underlying `store.sub`
    /// is detached. The next `set_cell` on this address will re-create a
    /// fresh primitive and reattach the fanout via the existing
    /// `attach_address_sub` flow, firing the listener as part of that write.
    fn try_release_primitive(&mut self, addr: CellAddress) {
        let Some(&atom_id) = self.cells.get(&addr) else {
            return;
        };
        // Formula cells are lazy records, not primitive atoms.
        if self.formula_cells.contains_key(&addr) {
            return;
        }
        if self.store.has_dependents(atom_id) {
            return;
        }
        if !self.store.has_atom(atom_id) {
            // Defensive: nothing to release.
            self.cells.remove(&addr);
            return;
        }
        if !matches!(self.store.get(atom_id), Value::Null) {
            return;
        }
        self.cells.remove(&addr);
        self.detach_address_sub(addr);
        self.store.destroy_atom(atom_id);
    }

    /// Set a cell's formula by address string (e.g. "=A1+B1").
    /// The formula is parsed and stored as a lazy Sheet-level record. It is
    /// not evaluated until the cell is read.
    ///
    /// Returns `false` if either:
    ///   - the formula failed to parse (B.3) — cell becomes `#VALUE!`
    ///   - the formula would form a dependency cycle (B.2) — cell becomes `#CYCLE!`
    /// In both cases the wasm instance keeps running and any prior formula on
    /// this cell is cleared.
    ///
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) -> bool {
        match self.try_set_formula(addr_str, formula_str) {
            Ok(success) => success,
            // Spill rejection: matches the `false` legacy contract so existing
            // callers that ignore the spill case behave as if the write was
            // a parse / cycle failure (no value change, returns `false`).
            Err(_) => false,
        }
    }

    /// Fallible variant of `set_formula`. Returns:
    ///   - `Ok(true)` — formula parsed and installed.
    ///   - `Ok(false)` — formula failed to parse or would create a cycle.
    ///     The cell is now `#VALUE!` or `#CYCLE!` respectively (existing
    ///     behavior preserved).
    ///   - `Err(SpillCellWrite { .. })` — the address is currently a
    ///     non-anchor target of an active spill range; the formula was
    ///     NOT installed.
    ///   - `Err(InvalidAddress)` — address parse failure.
    pub fn try_set_formula(
        &mut self,
        addr_str: &str,
        formula_str: &str,
    ) -> Result<bool, SheetError> {
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        if let Some(anchor) = self.spilled_into_anchor(addr) {
            return Err(SheetError::SpillCellWrite { anchor });
        }
        // Replacing the cell at this address: tear down any spill the
        // previous content (if it was an anchor) installed.
        self.clear_spill_at_address(addr);

        let expr = match parse_formula(formula_str) {
            Some(e) => e,
            None => {
                self.write_error(addr, ValueError::InvalidValue);
                return Ok(false);
            }
        };

        // Static cycle check (B.2). Walk the AST collecting referenced cells,
        // then BFS through their formula_exprs to see if `addr` is reachable.
        if self.would_create_cycle(addr, &expr) {
            self.write_error(addr, ValueError::CyclicRef);
            return Ok(false);
        }

        self.with_remap(addr, move |sheet| {
            let expr = Rc::new(expr);
            let deps = Sheet::formula_deps_for(&expr);
            let range_deps = collect_range_refs(&expr);
            sheet.remove_formula_record(addr);
            if let Some(prim) = sheet.cells.remove(&addr) {
                if sheet.store.has_atom(prim) && !sheet.store.has_dependents(prim) {
                    sheet.store.destroy_atom(prim);
                }
            }
            let record = Rc::new(FormulaRecord::new(
                expr.clone(),
                deps.clone(),
                range_deps.clone(),
            ));
            sheet.add_formula_deps(addr, &deps);
            sheet.add_formula_range_deps(addr, &range_deps);
            sheet.formula_cells.insert(addr, record);
            sheet.formula_exprs.insert(addr, expr);
            sheet.formula_texts.insert(addr, formula_str.to_string());
        });
        let dirtied = self.mark_dependents_dirty(addr);
        // Eager spill maintenance: re-evaluate the just-installed
        // formula (and any downstream array formulas) and install /
        // tear down spill state. The lazy `peek_value` read path can't
        // mutate the sheet, so the spill install has to happen here.
        self.recompute_array_formula(addr);
        self.recompute_array_formulas_in(&dirtied);
        Ok(true)
    }

    /// Drop any existing formula and write an error value to the cell.
    /// `pub(crate)` so the workbook layer can route a cross-sheet cycle
    /// detection failure (`#CYCLE!`) to the target cell without re-deriving
    /// the helper logic here.
    pub(crate) fn write_error(&mut self, addr: CellAddress, err: ValueError) {
        let had_formula = self.formula_cells.contains_key(&addr);
        if had_formula {
            self.with_remap(addr, |sheet| {
                sheet.remove_formula_record(addr);
                let id = sheet.ensure_cell(addr);
                sheet.store.set(id, Value::Error(err));
            });
        } else {
            let id = self.ensure_cell(addr);
            self.attach_address_sub(addr);
            self.store.set(id, Value::Error(err));
        }
        self.mark_dependents_dirty(addr);
    }

    /// Read-only access to `formula_exprs` for the workbook-level cycle
    /// detector. `pub(crate)` because cross-sheet BFS in `Workbook::set_formula`
    /// needs to walk per-sheet formula ASTs without owning the sheet's
    /// internal state.
    pub(crate) fn formula_exprs_iter(&self) -> &HashMap<CellAddress, Rc<Expr>> {
        &self.formula_exprs
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
        let provider = SheetEvalProvider {
            sheet: self,
            current_cell: Cell::new(None),
        };
        self.peek_value_with_provider(addr, &provider)
    }

    /// Sparse iteration over this sheet's cells inside `range`.
    /// `value_resolver` is called for each present address; for primitive
    /// cells we read the store directly, for formula cells we route
    /// through `value_resolver` so the caller can pass its own provider
    /// (so cross-sheet formula deps still resolve correctly when called
    /// from `WorkbookEvalProvider`). Used as the building block for
    /// `SheetEvalProvider::for_each_range_cell` and the Workbook variant.
    ///
    /// Phase 2 Track F: visits O(cells_in_range) instead of
    /// O(total non-empty). Both `cells` and `formula_cells` are
    /// row-major BTreeMaps, so `range_iter` is a pair of BTreeMap
    /// `range(min..=max)` calls — no filter sweep over the whole
    /// sheet. At 1M scattered non-empty cells, a 50×27 viewport read
    /// visits at most 50 rows × 27 cols, not 1M.
    pub(crate) fn for_each_sparse_cell_with(
        &self,
        range: CellRange,
        value_resolver: &dyn Fn(&Sheet, CellAddress) -> Value,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        for (addr, &id) in self.cells.range_iter(range) {
            // Skip primitives that have been upgraded to formulas — the
            // formula pass below will emit the formula value at this addr.
            // Address-equality check stays O(1) (BTreeMap point lookup).
            if self.formula_cells.contains_key(&addr) {
                continue;
            }
            let v = if self.store.has_atom(id) {
                self.store.get(id)
            } else {
                Value::Null
            };
            f(addr, v);
        }
        for (addr, _record) in self.formula_cells.range_iter(range) {
            let v = value_resolver(self, addr);
            f(addr, v);
        }
    }

    pub(crate) fn peek_value_with_provider(
        &self,
        addr: CellAddress,
        provider: &dyn EvalProvider,
    ) -> Value {
        if self.formula_cells.contains_key(&addr) {
            return self.eval_formula_at_with_provider(addr, provider);
        }
        self.cells
            .get(&addr)
            .filter(|id| self.store.has_atom(**id))
            .map(|&id| self.store.get(id))
            .unwrap_or(Value::Null)
    }

    fn primitive_value_at(&self, addr: CellAddress) -> Value {
        self.cells
            .get(&addr)
            .filter(|id| self.store.has_atom(**id))
            .map(|&id| self.store.get(id))
            .unwrap_or(Value::Null)
    }

    fn eval_formula_at_with_provider(
        &self,
        addr: CellAddress,
        provider: &dyn EvalProvider,
    ) -> Value {
        let Some(record) = self.formula_cells.get(&addr).cloned() else {
            return self.primitive_value_at(addr);
        };

        match record.cache.borrow().clone() {
            FormulaCache::Clean(value) if !provider.force_formula_recompute() => return value,
            FormulaCache::Computing => return Value::Error(ValueError::CyclicRef),
            FormulaCache::Clean(_) | FormulaCache::Dirty => {}
        }

        *record.cache.borrow_mut() = FormulaCache::Computing;
        let deps = Rc::new(RefCell::new(HashSet::new()));
        let tracking = TrackingEvalProvider {
            inner: provider,
            deps: deps.clone(),
        };
        // B1 — bump the cache-miss eval counter exactly once per real
        // recompute. Sits before the eval call so a panic during eval still
        // shows up in the counter (matches the intent: "evaluations
        // attempted"). TODO: Agent A's refactor may relocate this when the
        // typed-dep split lands; keep it boring until then.
        self.formula_eval_count
            .set(self.formula_eval_count.get() + 1);
        // Push the formula's own address as the provider's current cell so
        // `ROW()` / `COLUMN()` no-arg calls inside the formula resolve to
        // this cell. Restore the previous value on the way out so nested
        // formula evaluation (cell A's formula references cell B's formula)
        // sees the right addr in each frame. Providers that don't track a
        // current cell ignore both calls (default no-op impls).
        let prev_current = provider.current_cell();
        provider.set_current_cell(Some(addr));
        let value = eval_expr_with_provider(&record.expr, &tracking);
        provider.set_current_cell(prev_current);
        *record.cache.borrow_mut() = FormulaCache::Clean(value.clone());
        self.replace_formula_deps(addr, &record, deps.borrow().clone());
        value
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
        for (addr, expr) in &self.formula_exprs {
            if expr_has_sheet_ref(expr) {
                if let Some(record) = self.formula_cells.get(addr) {
                    *record.cache.borrow_mut() = FormulaCache::Dirty;
                }
            }
        }
    }

    /// Targeted version of `recompute_cross_sheet_formulas`: BFS over
    /// `formula_exprs` starting at `target` and mark reached cross-sheet
    /// formulas dirty. The Workbook lazy provider now does live recursive
    /// evaluation, so this remains mostly as an explicit cache-invalidation
    /// utility for older callers.
    ///
    /// Worst-case cost is the size of the dep closure of `target` in
    /// `formula_exprs` — orders of magnitude smaller than the whole-sheet
    /// sweep on workbooks with many cross-sheet formulas.
    pub fn recompute_cross_sheet_formulas_reachable_from(&mut self, target: CellAddress) {
        let mut visited: HashSet<CellAddress> = HashSet::new();
        let mut to_visit: Vec<CellAddress> = vec![target];
        while let Some(addr) = to_visit.pop() {
            if !visited.insert(addr) {
                continue;
            }
            let Some(expr) = self.formula_exprs.get(&addr) else {
                continue;
            };
            if expr_has_sheet_ref(expr) {
                if let Some(record) = self.formula_cells.get(&addr) {
                    *record.cache.borrow_mut() = FormulaCache::Dirty;
                }
            }
            // Queue only addresses that themselves have a formula — a leaf
            // primitive ref doesn't need re-traversal. Range refs are
            // expanded but each cell is gated by `formula_exprs` so the
            // typical `SUM(A:A)` only enqueues the small subset of column A
            // cells that are actually formulas.
            collect_formula_refs_into(expr, &self.formula_exprs, &mut to_visit);
        }
    }

    // === LAZY_FORMULA_EVAL Step 0 — debug counters ===
    //
    // These expose the lazy formula graph's materialization behavior for
    // tests / benches / dev tooling.
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

    /// Number of formula cells. Formulas are Sheet-level lazy records, not
    /// core derived atoms.
    #[doc(hidden)]
    pub fn debug_formula_count(&self) -> usize {
        self.formula_cells.len()
    }

    /// Number of formulas that currently depend on the cell at `addr`.
    #[doc(hidden)]
    pub fn debug_dependents_count(&self, addr_str: &str) -> usize {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return 0;
        };
        self.cell_dependents
            .borrow()
            .get(&addr)
            .map(|deps| deps.len())
            .unwrap_or(0)
    }

    /// Formula cache state without evaluating the formula.
    #[doc(hidden)]
    pub fn debug_formula_cache_state(&self, addr_str: &str) -> &'static str {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return "invalid";
        };
        let Some(record) = self.formula_cells.get(&addr) else {
            return "none";
        };
        match &*record.cache.borrow() {
            FormulaCache::Dirty => "dirty",
            FormulaCache::Computing => "computing",
            FormulaCache::Clean(_) => "clean",
        }
    }

    /// Total live core atoms. Formulas are not core atoms anymore. Useful as
    /// a gross "did anything materialize?" signal in tests.
    #[doc(hidden)]
    pub fn debug_total_atom_count(&self) -> usize {
        self.store.debug_total_atom_count()
    }

    /// Cumulative core derived recompute count from the underlying store.
    /// Formula cells should not increase this counter anymore.
    #[doc(hidden)]
    pub fn debug_recompute_count(&self) -> usize {
        self.store.debug_recompute_count()
    }

    /// Total formula evaluations performed since the sheet was created.
    /// Bumped once per cache-miss eval inside `eval_formula_at_with_provider`;
    /// cache hits are free. Used by the Phase 1 scale suite to assert
    /// `bulk_load` does no eager eval and viewport reads only evaluate
    /// visible formulas.
    #[doc(hidden)]
    pub fn debug_formula_eval_count(&self) -> usize {
        self.formula_eval_count.get()
    }

    /// Number of formula records whose cache is currently dirty (would
    /// re-compute on next read). Walks `formula_cells` and counts entries
    /// in the `FormulaCache::Dirty` state. Used by Phase 1 tests to assert
    /// dirty-propagation correctness without forcing an eval.
    #[doc(hidden)]
    pub fn debug_dirty_count(&self) -> usize {
        self.formula_cells
            .values()
            .filter(|record| matches!(*record.cache.borrow(), FormulaCache::Dirty))
            .count()
    }

    /// Number of formulas registered via `bulk_load` (cumulative since the
    /// sheet was created). The plain `Sheet::set_formula` path does NOT
    /// increment this. Used by the scale suite to verify the import path
    /// is exercised and to distinguish bulk-loaded from live-edited formulas.
    #[doc(hidden)]
    pub fn debug_imported_formula_count(&self) -> usize {
        self.imported_formula_count.get()
    }

    /// Number of distinct `CellAddress`es with at least one live listener
    /// in `cell_subscriptions`. An address whose last listener was removed
    /// drops out of the map (`unsubscribe_cell`), so this is just the live
    /// bucket count. Used to verify subscription teardown.
    #[doc(hidden)]
    pub fn debug_live_subscription_count(&self) -> usize {
        self.cell_subscriptions
            .values()
            .filter(|bucket| !bucket.listeners.borrow().is_empty())
            .count()
    }

    /// Number of distinct `CellRange`s tracked in `range_dependents`. Each
    /// formula referencing a range (e.g. `SUM(A1:A100)`) contributes one
    /// entry to the index — independent of how many cells the range spans.
    /// A single range with N dependent formulas still counts as one.
    ///
    /// Phase 1 acceptance: registering a wide range formula adds exactly
    /// one entry here, not N (the range's cell count). The interval-index
    /// scale work in Phase 2 will keep this counter API but change the
    /// underlying storage.
    #[doc(hidden)]
    pub fn debug_range_dep_count(&self) -> usize {
        self.range_dependents.borrow().len()
    }

    /// Debug-only candidate-range probe for the Phase 2 bucket index.
    /// Returns the count of *candidate* ranges that
    /// `RangeDependentIndex::candidates_for(addr)` produces — before the
    /// final `CellRange::contains` filter. Useful for asserting that the
    /// row × col bucket intersection actually narrows the search instead
    /// of returning every registered range. Kept `#[doc(hidden)]` because
    /// it leaks an internal implementation detail of the index.
    #[doc(hidden)]
    pub fn debug_range_dep_candidates(&self, addr_str: &str) -> usize {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return 0;
        };
        self.range_dependents.borrow().candidates_for(addr).len()
    }

    /// Count how many cells the sparse range-iterator visits when scanning
    /// `range_spec` (e.g. `"A1:AA50"`). Probe-only helper used by the
    /// Phase 2 scale acceptance test `range_read_1m_sparse_visits_only_range`
    /// — counts every non-empty cell yielded by `for_each_sparse_cell_with`,
    /// independent of `cells` HashMap total size.
    ///
    /// Phase 1 implementation: linear scan of `cells` + `formula_cells`
    /// filtered by `range.contains`, so this counter == "cells in range".
    /// Phase 2 (Agent F) swaps `cells` for a row-indexed structure and the
    /// visit-count contract becomes O(cells in range), not O(total cells).
    /// Returns 0 for an unparsable `range_spec`.
    #[doc(hidden)]
    pub fn debug_range_visit_count(&self, range_spec: &str) -> usize {
        let mut parts = range_spec.split(':');
        let (Some(start_s), Some(end_s), None) = (parts.next(), parts.next(), parts.next()) else {
            return 0;
        };
        let (Some(start), Some(end)) = (CellAddress::parse(start_s), CellAddress::parse(end_s))
        else {
            return 0;
        };
        let range = CellRange::new(start, end);
        let mut visits: usize = 0;
        self.for_each_sparse_cell_with(
            range,
            &|sheet, addr| sheet.peek_value(addr),
            &mut |_addr, _v| {
                visits += 1;
            },
        );
        visits
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

    /// Iterate every address that has a primitive value or a formula. Empty
    /// addresses are skipped. Used by structural-undo to snapshot only the
    /// cells that actually need restoring (see `solid/excel/docs/STRUCTURAL_UNDO.md`).
    ///
    /// An address can appear in both `cells` and `formula_cells` during the
    /// brief Computing window when a formula write created a primitive slot
    /// that was then upgraded; the formula entry dominates, so we union the
    /// keys and skip duplicates.
    ///
    /// Both backing maps iterate row-major ascending (row, then col), so
    /// the formula keys come out row-major first, followed by the
    /// primitive-only keys row-major. Callers that need the union in
    /// global row-major order (e.g. undo snapshot) must sort the result;
    /// today's `non_empty_addrs` callers either don't care about order or
    /// re-sort explicitly (verified in the `non_empty_addrs_*` tests),
    /// so this two-pass walk preserves the prior HashMap-era contract
    /// without changing observable behavior.
    pub fn for_each_non_empty(&self, mut f: impl FnMut(CellAddress)) {
        for (addr, _) in self.formula_cells.iter() {
            f(addr);
        }
        for (addr, _) in self.cells.iter() {
            if self.formula_cells.contains_key(&addr) {
                continue;
            }
            f(addr);
        }
    }

    /// Iterate every non-empty address inside `range` without reading cell
    /// values. Formula entries are reported by address only, so this does
    /// not evaluate dirty formula caches.
    pub fn for_each_non_empty_in_range(&self, range: CellRange, mut f: impl FnMut(CellAddress)) {
        for (addr, _) in self.formula_cells.range_iter(range) {
            f(addr);
        }
        for (addr, _) in self.cells.range_iter(range) {
            if self.formula_cells.contains_key(&addr) {
                continue;
            }
            f(addr);
        }
    }

    /// Clear every non-empty address inside `range` without materializing
    /// holes. Uses bulk-load so dependent dirtying and subscriber notify are
    /// coalesced once after the sparse scan.
    pub fn clear_range(&mut self, range: CellRange) -> usize {
        let mut addrs = Vec::new();
        self.for_each_non_empty_in_range(range, |addr| addrs.push(addr));
        let cleared = addrs.len();
        self.bulk_load(|loader| {
            for addr in addrs {
                loader.set_cell(&addr.to_string(), Value::Null);
            }
        });
        cleared
    }

    /// Collect every non-empty address as an `"A1"`-style string. Cheap
    /// convenience wrapper around `for_each_non_empty` for wasm exposure.
    pub fn non_empty_addrs(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.formula_cells.len() + self.cells.len());
        self.for_each_non_empty(|addr| out.push(addr.to_string()));
        out
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

    // === Phase 6: cell formatting ===

    fn base_format_at(&self, addr: CellAddress) -> CellFormat {
        if let Some(fmt) = self.formats.get(&addr) {
            return fmt.clone();
        }
        for layer in self.range_formats.iter().rev() {
            if layer.range.contains(addr) {
                return layer.fmt.clone();
            }
        }
        CellFormat::default()
    }

    /// Set or clear the format for a cell. Passing the default `CellFormat`
    /// removes the entry, keeping the formats map sparse for empty styles.
    /// Format changes don't dirty the dep graph but DO fire the address
    /// listener so views can re-style without recomputing the value.
    pub fn set_format(&mut self, addr_str: &str, fmt: CellFormat) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        if fmt == CellFormat::default() {
            self.formats.remove(&addr);
        } else {
            self.formats.insert(addr, fmt);
        }
        if self.has_address_subscribers(addr) {
            self.notify_address_subscribers(addr);
        }
    }

    /// Set a range format as a lazy layer. Existing per-cell overrides inside
    /// the range are removed, then the range layer becomes the default for all
    /// addresses in the rectangle.
    ///
    /// Returns how many subscribed addresses were notified.
    pub fn set_format_range(&mut self, range: CellRange, fmt: CellFormat) -> usize {
        let normalized = range.normalize();

        self.formats
            .retain(|addr, _| !normalized.contains(*addr));
        self.range_formats.push(RangeFormat {
            range: normalized,
            fmt,
        });

        let mut notified = 0usize;
        for addr in self.cell_subscriptions.keys().copied() {
            if normalized.contains(addr) && self.has_address_subscribers(addr) {
                self.notify_address_subscribers(addr);
                notified += 1;
            }
        }
        notified
    }

    /// Snapshot only sparse formatting metadata needed to undo a subsequent
    /// `set_format_range` over `range`. This does not inspect values or
    /// materialize empty cells: per-cell formats are sparse, and range format
    /// layers are metadata.
    pub fn snapshot_format_range(&self, range: CellRange) -> FormatRangeSnapshot {
        let normalized = range.normalize();
        let mut cell_formats: Vec<(CellAddress, CellFormat)> = self
            .formats
            .iter()
            .filter_map(|(addr, fmt)| {
                if normalized.contains(*addr) {
                    Some((*addr, fmt.clone()))
                } else {
                    None
                }
            })
            .collect();
        cell_formats.sort_by_key(|(addr, _)| (addr.row, addr.col));

        FormatRangeSnapshot {
            range: normalized,
            cell_formats,
            range_formats: self
                .range_formats
                .iter()
                .map(|layer| RangeFormatSnapshotLayer {
                    range: layer.range,
                    fmt: layer.fmt.clone(),
                })
                .collect(),
        }
    }

    /// Restore a formatting snapshot produced by `snapshot_format_range`.
    /// Only explicit per-cell formats inside the snapshot range are replaced;
    /// explicit formats outside the range are left alone. Range-format layers
    /// are metadata-only and are restored as a whole so overlap ordering stays
    /// exact for undo/redo.
    pub fn restore_format_range_snapshot(&mut self, snapshot: FormatRangeSnapshot) -> usize {
        let normalized = snapshot.range.normalize();
        self.formats
            .retain(|addr, _| !normalized.contains(*addr));
        for (addr, fmt) in snapshot.cell_formats {
            if fmt == CellFormat::default() {
                self.formats.remove(&addr);
            } else {
                self.formats.insert(addr, fmt);
            }
        }
        self.range_formats = snapshot
            .range_formats
            .into_iter()
            .map(|layer| RangeFormat {
                range: layer.range.normalize(),
                fmt: layer.fmt,
            })
            .collect();

        let mut notified = 0usize;
        for addr in self.cell_subscriptions.keys().copied() {
            if normalized.contains(addr) && self.has_address_subscribers(addr) {
                self.notify_address_subscribers(addr);
                notified += 1;
            }
        }
        notified
    }

    /// Read the base format for a cell. Returns the default when no
    /// explicit format has been set. Does not apply conditional rules —
    /// use `effective_format` for that.
    pub fn get_format(&self, addr_str: &str) -> CellFormat {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.base_format_at(addr)
    }

    /// Compute the effective format for a cell: base format with any
    /// conditional rule overrides applied to the cell's current value.
    pub fn effective_format(&self, addr_str: &str) -> CellFormat {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let base = self.base_format_at(addr);
        if self.conditional_rules.is_empty() {
            return base;
        }
        let value = self.peek_value(addr);
        apply_rules(&base, &self.conditional_rules, &value)
    }

    /// Replace the sheet-wide conditional rule list. First match wins per
    /// cell; pass an empty Vec to clear all rules. Fires every subscribed
    /// address since the effective format of any cell may have changed.
    pub fn set_conditional_rules(&mut self, rules: Vec<ConditionalRule>) {
        self.conditional_rules = rules;
        let addrs: Vec<CellAddress> = self.cell_subscriptions.keys().copied().collect();
        for addr in addrs {
            self.notify_address_subscribers(addr);
        }
    }

    /// Read-only access to the conditional rule list.
    pub fn conditional_rules(&self) -> &[ConditionalRule] {
        &self.conditional_rules
    }

    /// Format a cell's value using its effective format. Numeric cells go
    /// through `CellFormat::format_number`; non-numeric cells fall back to
    /// the default display path (matches `value_to_display` behavior).
    pub fn formatted_display(&self, addr_str: &str) -> String {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        // Collapse spill anchor to top-left for display — UI parity with
        // the WASM boundary. The full Array is only visible to internal
        // spill bookkeeping; users see the top-left scalar at the anchor.
        let value = collapse_array_for_eval(self.peek_value(addr));
        match &value {
            Value::Number(n) => {
                let fmt = self.effective_format(addr_str);
                fmt.format_number(*n)
            }
            Value::Text(s) => s.clone(),
            Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            Value::Null => String::new(),
            Value::Error(e) => format!("{}", e),
            // Unreachable: collapsed above, but keep arm for exhaustiveness.
            Value::Array(_) => String::new(),
            // Lambda values are transient evaluator state — they don't get
            // persisted into a cell. Render an empty string defensively if
            // one ever leaks through.
            Value::Lambda(_) => String::new(),
        }
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
            Self::shift_dimension_insert(&mut sheet.row_heights, at, count);
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
            Self::shift_dimension_delete(&mut sheet.row_heights, at, count);
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
            Self::shift_dimension_insert(&mut sheet.col_widths, at, count);
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
            Self::shift_dimension_delete(&mut sheet.col_widths, at, count);
        });
    }

    /// Run a structural edit (row/col insert/delete) so that subscribers are
    /// notified at most once per address, only when the displayed value at
    /// that address actually changed. Detaches every fanout for the duration
    /// of the edit so internal `store.set` calls don't fan out partial
    /// intermediate states; reattaches at the end.
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
        let to_drop: Vec<CellAddress> = self.cells.keys().filter(|a| pred(*a)).collect();
        for addr in to_drop {
            if let Some(prim) = self.cells.remove(&addr) {
                if self.store.has_atom(prim) && !self.store.has_dependents(prim) {
                    self.store.destroy_atom(prim);
                }
            }
            self.remove_formula_record(addr);
            // Fanout reattach + per-address fire are handled by the enclosing
            // `with_structural_edit`; nothing to do here.
        }
        // Phase 6 — formats shift alongside cells. Drop formats whose
        // addresses fall inside the deleted band; survivors are relocated by
        // `relocate_cells`. Done as a separate sweep so the existing cell
        // logic stays unchanged.
        let fmt_drop: Vec<CellAddress> =
            self.formats.keys().copied().filter(|a| pred(*a)).collect();
        for addr in fmt_drop {
            self.formats.remove(&addr);
        }
    }

    /// Move every (still-present) cell entry to its new address per `f`.
    fn relocate_cells(&mut self, f: impl Fn(CellAddress) -> CellAddress) {
        // Phase A: rebuild each map under new keys. We materialize Vecs first
        // because mutating a BTreeMap while iterating its keys would panic.
        // `drain_into_vec` empties `self.cells` / `self.formula_cells` and
        // hands back row-major (addr, value) pairs we reinsert under the
        // shifted addresses.
        let mut new_cells: RowMajorMap<AtomId> = RowMajorMap::new();
        for (addr, id) in self.cells.drain_into_vec() {
            new_cells.insert(f(addr), id);
        }
        let mut new_formula_cells: RowMajorMap<Rc<FormulaRecord>> = RowMajorMap::new();
        for (addr, record) in self.formula_cells.drain_into_vec() {
            new_formula_cells.insert(f(addr), record);
        }
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
        // Phase 6 — formats follow the same shift as cells so a format set
        // on A1 survives a row insert above and re-emerges on A2. Entries
        // mapped onto the invalid sentinel (deleted band) are dropped; for
        // delete_row/delete_col `drop_cells_in` already removed them, but
        // we filter defensively here too in case `f` produces a sentinel.
        let new_formats: HashMap<CellAddress, CellFormat> = std::mem::take(&mut self.formats)
            .into_iter()
            .filter_map(|(addr, fmt)| {
                let next = f(addr);
                if next.row == crate::shift::REF_INVALID_ROW
                    || next.col == crate::shift::REF_INVALID_COL
                {
                    None
                } else {
                    Some((next, fmt))
                }
            })
            .collect();
        let new_range_formats: Vec<RangeFormat> = std::mem::take(&mut self.range_formats)
            .into_iter()
            .filter_map(|layer| {
                let start = f(layer.range.start);
                let end = f(layer.range.end);
                if start.row == crate::shift::REF_INVALID_ROW
                    || start.col == crate::shift::REF_INVALID_COL
                    || end.row == crate::shift::REF_INVALID_ROW
                    || end.col == crate::shift::REF_INVALID_COL
                {
                    None
                } else {
                    Some(RangeFormat {
                        range: CellRange::new(start, end).normalize(),
                        fmt: layer.fmt,
                    })
                }
            })
            .collect();
        self.cells = new_cells;
        self.formula_cells = new_formula_cells;
        self.formula_exprs = new_formula_exprs;
        self.formula_texts = new_formula_texts;
        self.formats = new_formats;
        self.range_formats = new_range_formats;
        self.rebuild_all_formula_dependents();
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
            self.rebuild_formula_lazy(addr, rendered);
        }
    }

    fn rebuild_formula_lazy(&mut self, addr: CellAddress, formula_str: String) {
        let expr = match crate::formula::parse_formula(&formula_str) {
            Some(e) => Rc::new(e),
            None => {
                // Render produced something unparsable — shouldn't happen,
                // but be safe.
                self.write_error(addr, ValueError::InvalidValue);
                return;
            }
        };
        let deps = Sheet::formula_deps_for(&expr);
        let range_deps = collect_range_refs(&expr);
        self.remove_formula_record(addr);
        let record = Rc::new(FormulaRecord::new(
            expr.clone(),
            deps.clone(),
            range_deps.clone(),
        ));
        self.add_formula_deps(addr, &deps);
        self.add_formula_range_deps(addr, &range_deps);
        self.formula_cells.insert(addr, record);
        self.formula_exprs.insert(addr, expr);
        self.formula_texts.insert(addr, formula_str);
        // Fanout reattach + per-address fire are handled by the enclosing
        // `with_structural_edit` (this is only ever called from
        // `retarget_formula_refs` during a structural edit).
    }

    /// Set multiple cells at once, with a single propagation pass.
    ///
    /// Like `set_cell`, this also clears any existing formula on each target
    /// cell. Formula dependents are dirtied after the batch without eagerly
    /// computing them.
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
        let mut written_addrs: Vec<CellAddress> = Vec::with_capacity(updates.len());

        for (addr_str, value) in updates {
            let addr = CellAddress::parse(addr_str).expect("invalid cell address");

            self.remove_formula_record(addr);

            let id = self.ensure_cell(addr);
            atom_values.push((id, value.clone()));
            written_addrs.push(addr);
        }

        self.store.batch(|store| {
            for (id, value) in atom_values {
                store.set(id, value);
            }
        });
        let mut dirty_notified = HashSet::new();
        for addr in written_addrs {
            dirty_notified.extend(self.mark_dependents_dirty(addr));
        }

        for addr in &subscribed {
            self.attach_address_sub(*addr);
        }
        for (addr, pre_val) in pre {
            if dirty_notified.contains(&addr) {
                continue;
            }
            let post_val = self.peek_value(addr);
            if pre_val != post_val {
                self.notify_address_subscribers(addr);
            }
        }
    }

    // === LAZY_FORMULA_EVAL Step 3 — bulk import API ===

    /// Run `f` inside a bulk-load session. Writes performed through the
    /// `BulkLoader` skip per-cell dirty propagation and subscriber notification;
    /// when the closure returns, the loader's `flush` walks the touched set
    /// once, dirties transitive formula dependents, and notifies each
    /// currently-subscribed address at most once.
    ///
    /// Use for CSV / JSON / xlsx import paths that write thousands of cells:
    /// the per-cell notify cost would dominate, and we want to defer formula
    /// evaluation entirely to first read.
    ///
    /// RAII shape: `BulkLoader` is not exposed outside the closure, so the
    /// flush always runs (no begin/end pair to forget).
    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut BulkLoader<'_>) -> R) -> R {
        let mut loader = BulkLoader::new(self);
        let result = f(&mut loader);
        loader.flush();
        result
    }
}

/// In-progress bulk-load session. Writes go directly into the sheet's
/// formula/primitive state but skip the normal dirty-mark + subscriber-notify
/// fan-out; the deferred work runs in `flush`.
///
/// Only constructable inside `Sheet::bulk_load` (RAII), so the lifetime stays
/// bound to `&mut Sheet` and `flush` is guaranteed to run on the closure exit.
pub struct BulkLoader<'a> {
    sheet: &'a mut Sheet,
    /// Addresses written during this bulk load. At `flush()` we walk these to
    /// dirty downstream formulas + notify currently-subscribed addresses ONCE.
    touched: HashSet<CellAddress>,
}

impl<'a> BulkLoader<'a> {
    fn new(sheet: &'a mut Sheet) -> Self {
        BulkLoader {
            sheet,
            touched: HashSet::new(),
        }
    }

    /// Write a primitive value at `addr`. Skips dirty propagation and
    /// subscriber notification — both deferred to `flush`. Equivalent to
    /// `Sheet::set_cell` outside the bulk-load contract; the address is
    /// recorded in `touched` for the post-flush sweep.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let is_null = matches!(value, Value::Null);

        // Detach the fanout for this address so the store-level `set` below
        // does not synchronously fire subscribers. `flush` will reattach and
        // notify exactly once per subscribed touched/dirty address.
        self.sheet.detach_address_sub(addr);

        if self.sheet.formula_cells.contains_key(&addr) {
            // Formula → primitive transition. Drop the formula record (and
            // its reverse dep entries) but no notify; primitive scaffold is
            // re-established below.
            self.sheet.remove_formula_record(addr);
            // The pre-existing primitive atom from formula→primitive remap may
            // still be present; ensure_cell + store.set covers both branches.
            let id = self.sheet.ensure_cell(addr);
            self.sheet.store.set(id, value);
        } else {
            let id = self.sheet.ensure_cell(addr);
            self.sheet.store.set(id, value);
        }

        // 3.10 — same Null-release contract as the normal path so bulk-load
        // does not leak primitive scaffolds when callers write Null. The
        // fanout was already detached above; release just drops the atom and
        // bookkeeping. The bucket (if any) stays for the flush reattach.
        if is_null {
            self.sheet.try_release_primitive(addr);
        }

        self.touched.insert(addr);
    }

    /// Write a formula at `addr`. Parses, runs the same-sheet static cycle
    /// check (B.2), and stores the record with cache state Dirty. Does not
    /// evaluate the formula, does not notify any subscriber. Returns the same
    /// `bool` contract as `Sheet::set_formula`: `false` on parse failure or
    /// cycle (the cell is left holding `#VALUE!` / `#CYCLE!`, no notify).
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) -> bool {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");

        let expr = match parse_formula(formula_str) {
            Some(e) => e,
            None => {
                // Inline equivalent of `write_error(addr, InvalidValue)` minus
                // the dirty-mark + notify fanout. The error value still lands
                // in the primitive scaffold so future reads observe `#VALUE!`.
                self.write_error_no_notify(addr, ValueError::InvalidValue);
                self.touched.insert(addr);
                return false;
            }
        };

        // Static cycle check still runs inside bulk_load — incremental cycle
        // protection isn't worth dropping for perf, and the cost is bounded by
        // the dep closure of the new formula.
        if self.sheet.would_create_cycle(addr, &expr) {
            self.write_error_no_notify(addr, ValueError::CyclicRef);
            self.touched.insert(addr);
            return false;
        }

        // Detach fanout so any primitive scaffold teardown below does not fire.
        self.sheet.detach_address_sub(addr);

        let expr = Rc::new(expr);
        let deps = Sheet::formula_deps_for(&expr);
        let range_deps = collect_range_refs(&expr);
        // Drop any prior formula record (no notify) and any primitive scaffold
        // that no longer has dependents — mirrors `Sheet::set_formula` minus
        // the `with_remap` listener fire.
        self.sheet.remove_formula_record(addr);
        if let Some(prim) = self.sheet.cells.remove(&addr) {
            if self.sheet.store.has_atom(prim) && !self.sheet.store.has_dependents(prim) {
                self.sheet.store.destroy_atom(prim);
            }
        }
        let record = Rc::new(FormulaRecord::new(
            expr.clone(),
            deps.clone(),
            range_deps.clone(),
        ));
        self.sheet.add_formula_deps(addr, &deps);
        self.sheet.add_formula_range_deps(addr, &range_deps);
        self.sheet.formula_cells.insert(addr, record);
        self.sheet.formula_exprs.insert(addr, expr);
        self.sheet
            .formula_texts
            .insert(addr, formula_str.to_string());

        // B1 — bump the imported-formula counter for successfully registered
        // bulk-load entries. Parse failure / cycle paths return earlier and
        // do not insert a formula record, so they intentionally don't bump.
        self.sheet
            .imported_formula_count
            .set(self.sheet.imported_formula_count.get() + 1);

        self.touched.insert(addr);
        true
    }

    /// Inline `write_error` minus the dirty-mark + subscriber notify. Used by
    /// the parse-failure and cycle paths in bulk-mode `set_formula`.
    fn write_error_no_notify(&mut self, addr: CellAddress, err: ValueError) {
        self.sheet.detach_address_sub(addr);
        if self.sheet.formula_cells.contains_key(&addr) {
            self.sheet.remove_formula_record(addr);
        }
        let id = self.sheet.ensure_cell(addr);
        self.sheet.store.set(id, Value::Error(err));
    }

    /// Drain the touched set, dirty all transitively-downstream formulas,
    /// reattach fanouts on touched primitive addresses, and notify each
    /// currently-subscribed address at most once.
    ///
    /// Complexity: O(T + D) where T = touched count, D = size of transitive
    /// formula closure reachable from `touched` through both
    /// `cell_dependents` and `range_dependents`. The range half is
    /// O(matches + wide_count) per address via the Phase 2 Track E
    /// bucket index, not the Phase 1 O(range_count) scan. Notify dedup
    /// is O(1) per visited address via the `notified` HashSet.
    fn flush(&mut self) {
        // 1. BFS through dependents (point + range) starting at every
        //    touched address. Collect the set of transitively-dirty
        //    formula addresses, and as a side effect flip their
        //    FormulaCache to Dirty. `dependents_of` unions
        //    `cell_dependents[addr]` with every range containing `addr`,
        //    so an empty cell inside `SUM(A1:A100)` still dirties the
        //    sum even though it was skipped by sparse eval (P0).
        let mut dirty: HashSet<CellAddress> = HashSet::new();
        let mut stack: Vec<CellAddress> = Vec::new();
        for &addr in &self.touched {
            stack.extend(self.sheet.dependents_of(addr));
        }
        while let Some(addr) = stack.pop() {
            if !dirty.insert(addr) {
                continue;
            }
            if let Some(record) = self.sheet.formula_cells.get(&addr) {
                *record.cache.borrow_mut() = FormulaCache::Dirty;
            }
            stack.extend(self.sheet.dependents_of(addr));
        }

        // 2. Reattach fanouts on touched addresses so future writes notify
        //    normally. Reattach is a no-op when the address has no
        //    subscription bucket or no readable atom.
        for &addr in &self.touched {
            self.sheet.attach_address_sub(addr);
        }

        // 3. Notify each currently-subscribed address in (touched ∪ dirty)
        //    exactly once. Subscribers on addresses that weren't touched and
        //    have no dirty formula dependents are skipped — the "lazy"
        //    extreme: no listener fires for cells nobody is watching.
        let mut notify_targets: HashSet<CellAddress> =
            HashSet::with_capacity(self.touched.len() + dirty.len());
        notify_targets.extend(self.touched.iter().copied());
        notify_targets.extend(dirty.iter().copied());
        for addr in notify_targets {
            if self.sheet.has_address_subscribers(addr) {
                self.sheet.notify_address_subscribers(addr);
            }
        }
    }
}

/// Walk the AST and collect every `Expr::Range` as a typed `CellRange`,
/// without expanding it to individual cells. Mirror of `collect_refs`
/// that handles only ranges. Used by `set_formula` / `BulkLoader` to
/// populate `FormulaRecord::range_deps` at registration time so the
/// sheet-level `range_dependents` index can be rebuilt without losing
/// range identity across sparse-eval narrowing of the point dep set.
fn collect_range_refs(expr: &Expr) -> HashSet<CellRange> {
    let mut out = HashSet::new();
    collect_range_refs_into(expr, &mut out);
    out
}

fn collect_range_refs_into(expr: &Expr, out: &mut HashSet<CellRange>) {
    match expr {
        Expr::Range { start, end, .. } => {
            // Normalize so transposed corners hash to the same entry —
            // a `SUM(A1:B2)` and `SUM(B2:A1)` share one dep entry.
            //
            // For whole-col / whole-row ranges the start/end already carry
            // the sentinel coords (0 and u32::MAX) on the unbounded axis,
            // so the resulting CellRange spans the entire sheet on that
            // axis. `RangeDependentIndex::is_wide` flags any range > 4096
            // rows or cols as wide, which routes whole-col / whole-row
            // automatically into `wide_ranges` — Track E's contract.
            out.insert(CellRange::new(*start, *end).normalize());
        }
        Expr::BinOp { left, right, .. } => {
            collect_range_refs_into(left, out);
            collect_range_refs_into(right, out);
        }
        Expr::Negate(inner) => collect_range_refs_into(inner, out),
        Expr::FuncCall { args, .. } => {
            // FuncCall covers `IF` and friends: every branch arg is
            // descended into so a range hidden inside an unselected
            // branch still registers as a range dep.
            for a in args {
                collect_range_refs_into(a, out);
            }
        }
        // CellRef goes through the point-cell `deps` path; SheetRef is
        // cross-sheet and tracked at the workbook layer; literals have
        // no deps. LET-bound names resolve at eval time against the
        // local scope, not against the cell graph.
        Expr::CellRef(_)
        | Expr::SheetRef { .. }
        | Expr::SheetRange { .. }
        | Expr::Number(_)
        | Expr::Text(_)
        | Expr::Bool(_)
        | Expr::Name(_) => {}
        // Immediate-call form — descend into callee + args so ranges
        // hidden inside the lambda body or arg list still register.
        Expr::Call(callee, args) => {
            collect_range_refs_into(callee, out);
            for a in args {
                collect_range_refs_into(a, out);
            }
        }
    }
}

/// Walk the AST and append every referenced cell address into `out`.
/// Used by static cycle detection (B.2). Free function so it can run
/// without borrowing `&self.formula_exprs`.
///
/// Whole-column / whole-row ranges (`A:A`, `1:1`) are NOT expanded into
/// individual cells here — that would push the entire coordinate space
/// (`u32::MAX` rows or cols) into the dep vec. Track G's contract: the
/// unbounded range is tracked via `range_deps` only; the BFS at the
/// call site (cycle detection, dirty propagation) consults that via the
/// range_dependents index instead of the point-cell index.
fn collect_refs(expr: &Expr, out: &mut Vec<CellAddress>) {
    match expr {
        Expr::CellRef(addr) => out.push(*addr),
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            // Skip expansion for unbounded ranges — the row/col bound would
            // be u32::MAX. Range deps are still tracked through
            // `collect_range_refs` → `RangeDependentIndex`.
            if !matches!(unbounded, RangeBounds::None) {
                return;
            }
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
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => {}
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
        // LET-bound names don't reference cells.
        Expr::Name(_) => {}
        // Immediate-call form — descend into callee + args.
        Expr::Call(callee, args) => {
            collect_refs(callee, out);
            for a in args {
                collect_refs(a, out);
            }
        }
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
        Expr::Range { start, end, .. } => {
            let min_row = start.row.min(end.row);
            let max_row = start.row.max(end.row);
            let min_col = start.col.min(end.col);
            let max_col = start.col.max(end.col);
            // For unbounded ranges (`A:A`, `1:1`) one of the dims is u32::MAX;
            // `cells_in_range` would overflow if computed as a product. The
            // existing branch already guards via `>` comparison, so we use a
            // saturating product and let the "scan formulas" branch take
            // over when the range is large.
            let cells_in_range = (max_row.saturating_sub(min_row) as usize)
                .saturating_add(1)
                .saturating_mul((max_col.saturating_sub(min_col) as usize).saturating_add(1));
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
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => {}
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {}
        // LET-bound names don't reference cells in the formula graph.
        Expr::Name(_) => {}
        // Immediate-call form — descend into callee + args.
        Expr::Call(callee, args) => {
            collect_formula_refs_into(callee, formula_exprs, out);
            for a in args {
                collect_formula_refs_into(a, formula_exprs, out);
            }
        }
    }
}

/// Walk the AST looking for any `Expr::SheetRef`. Used by `Workbook::get_cell`
/// to skip force-recompute on formulas that don't actually need a cross-sheet
/// resolver (the common case).
fn expr_has_sheet_ref(expr: &Expr) -> bool {
    match expr {
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => true,
        Expr::BinOp { left, right, .. } => expr_has_sheet_ref(left) || expr_has_sheet_ref(right),
        Expr::Negate(inner) => expr_has_sheet_ref(inner),
        Expr::FuncCall { args, .. } => args.iter().any(expr_has_sheet_ref),
        Expr::CellRef(_) | Expr::Range { .. } | Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) => {
            false
        }
        Expr::Name(_) => false,
        // Immediate-call could resolve to a LAMBDA whose body references
        // another sheet; descend conservatively.
        Expr::Call(callee, args) => {
            expr_has_sheet_ref(callee) || args.iter().any(expr_has_sheet_ref)
        }
    }
}

/// Conservative static check: does this AST contain a call to a
/// function that can produce a `Value::Array`? Used to gate the eager
/// spill re-eval — formulas that can't produce arrays stay fully lazy
/// and preserve the dirty-count / eval-count debug counters.
///
/// Currently any of SEQUENCE / UNIQUE / SORT / FILTER, or any function
/// that itself receives an array-producing call as an argument
/// (a `=SUM(SEQUENCE(5))`-shaped call needs to be detected so the array
/// produced inside collapses naturally; the outer scalar function eats
/// the array via `for_each_arg_value`, but the static check stays
/// conservative and flags any nested occurrence).
fn expr_may_produce_array(expr: &Expr) -> bool {
    match expr {
        Expr::FuncCall { name, args } => {
            // SEQUENCE / UNIQUE / SORT / FILTER are the existing dynamic-
            // array constructors; MAP / SCAN / BYROW / BYCOL / MAKEARRAY
            // are the L3 array higher-order functions added alongside
            // LAMBDA. REDUCE always returns a scalar so it's intentionally
            // omitted. ISOMITTED is a scalar predicate.
            if matches!(
                name.as_str(),
                "SEQUENCE"
                    | "UNIQUE"
                    | "SORT"
                    | "FILTER"
                    | "MAP"
                    | "SCAN"
                    | "BYROW"
                    | "BYCOL"
                    | "MAKEARRAY"
                    | "SORTBY"
                    | "RANDARRAY"
                    | "TAKE"
                    | "DROP"
                    | "VSTACK"
                    | "HSTACK"
                    | "CHOOSEROWS"
                    | "CHOOSECOLS"
                    | "TOROW"
                    | "TOCOL"
            ) {
                return true;
            }
            args.iter().any(expr_may_produce_array)
        }
        Expr::BinOp { left, right, .. } => {
            expr_may_produce_array(left) || expr_may_produce_array(right)
        }
        Expr::Negate(inner) => expr_may_produce_array(inner),
        // An immediate-call could be `MAP(...)(...)` chained, but even a
        // bare `LAMBDA(x, MAP(...))(arg)` returns an array. Descend the
        // callee + args conservatively.
        Expr::Call(callee, args) => {
            expr_may_produce_array(callee) || args.iter().any(expr_may_produce_array)
        }
        _ => false,
    }
}

struct SheetEvalProvider<'a> {
    sheet: &'a Sheet,
    /// Cell currently being evaluated. Updated by
    /// `eval_formula_at_with_provider` via `set_current_cell` (save/restore
    /// guard pattern) so `ROW()` / `COLUMN()` no-arg calls can read the
    /// formula's own row/column.
    current_cell: Cell<Option<CellAddress>>,
}

/// Collapse a `Value::Array` returned from a cell-read to its top-left
/// element so that scalar formula contexts see a scalar. Spilled cells
/// already return scalars via their derived atom; only the anchor cell
/// holds the underlying `Array`. Within formula eval we want
/// `=A1 + 1` (where A1 is a 3x1 spill anchor) to act on the top-left
/// element — Excel "implicit intersection" semantics. The `Sheet::get_cell`
/// / `peek_value` boundary intentionally still returns the raw `Array`
/// so the spill UI helpers (`spill_info`) can detect anchors.
pub(crate) fn collapse_array_for_eval(v: Value) -> Value {
    match v {
        Value::Array(arr) => arr.get(0, 0).cloned().unwrap_or(Value::Null),
        other => other,
    }
}

impl<'a> EvalProvider for SheetEvalProvider<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        collapse_array_for_eval(self.sheet.peek_value_with_provider(addr, self))
    }

    fn sheet_cell(&self, _sheet: &str, _addr: CellAddress) -> Value {
        Value::Error(ValueError::InvalidRef)
    }

    /// Sparse override: iterate only addresses that actually have a
    /// primitive or formula record, intersected with `range`. Lets
    /// `SUM(A:A)` walk the dozen real cells in column A instead of
    /// expanding the nominal column extent.
    ///
    /// Formula cells are read via `peek_value_with_provider(self)` so the
    /// current-cell guard is preserved across the sparse walk.
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
        self.sheet.for_each_sparse_cell_with(
            range,
            &|sheet, addr| collapse_array_for_eval(sheet.peek_value_with_provider(addr, self)),
            f,
        );
    }

    fn current_cell(&self) -> Option<CellAddress> {
        self.current_cell.get()
    }

    fn set_current_cell(&self, addr: Option<CellAddress>) {
        self.current_cell.set(addr);
    }
}

struct TrackingEvalProvider<'a> {
    inner: &'a dyn EvalProvider,
    deps: Rc<RefCell<HashSet<CellAddress>>>,
}

impl<'a> EvalProvider for TrackingEvalProvider<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        self.deps.borrow_mut().insert(addr);
        self.inner.cell(addr)
    }

    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        self.inner.sheet_cell(sheet, addr)
    }

    fn force_formula_recompute(&self) -> bool {
        self.inner.force_formula_recompute()
    }

    /// Tracking wrapper: record every address the inner provider yields
    /// as a formula dep. This lets `IF`-style dynamic-branch deps stay
    /// accurate even when the eval went through `for_each_range_cell`
    /// instead of explicit per-cell `cell()` calls.
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
        let deps = self.deps.clone();
        self.inner.for_each_range_cell(range, &mut |addr, v| {
            deps.borrow_mut().insert(addr);
            f(addr, v);
        });
    }

    fn for_each_sheet_range_cell(
        &self,
        sheet: &str,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        self.inner.for_each_sheet_range_cell(sheet, range, f);
    }

    fn current_cell(&self) -> Option<CellAddress> {
        self.inner.current_cell()
    }

    fn set_current_cell(&self, addr: Option<CellAddress>) {
        self.inner.set_current_cell(addr);
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

        // Unparseable formula clears the stored text (cell becomes #VALUE!).
        // After Expr::Name was added for LET support, bare identifiers like
        // `=garbage` now PARSE successfully (they evaluate to #NAME? at
        // read time, matching Excel semantics). To test the "cannot parse"
        // branch we use an unmatched paren — there's no surface syntax
        // that can rescue it.
        sheet.set_formula("B1", "=(");
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
    fn debug_counters_reflect_lazy_formula_baseline() {
        let mut sheet = Sheet::new();
        assert_eq!(sheet.debug_primitive_atom_count(), 0);
        assert_eq!(sheet.debug_formula_count(), 0);
        assert_eq!(sheet.debug_total_atom_count(), 0);

        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        sheet.set_formula("B1", "=A1+Z99");
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_formula_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        assert_eq!(sheet.debug_dependents_count("A1"), 1);
        assert_eq!(sheet.debug_dependents_count("Z99"), 1);

        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);
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

    // === B1 — counter additions ===

    #[test]
    fn debug_formula_eval_count_bumps_on_miss_not_on_hit() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=A1");
        // No read yet — counter must be zero.
        assert_eq!(sheet.debug_formula_eval_count(), 0);

        // First read: cache miss → exactly one eval.
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(sheet.debug_formula_eval_count(), 1);

        // Second read: cache hit → no additional eval.
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(sheet.debug_formula_eval_count(), 1);
    }

    #[test]
    fn debug_dirty_count_drops_after_read() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(2.0));
        sheet.set_formula("B1", "=A1");

        // Pre-read: formula is dirty.
        assert_eq!(sheet.debug_dirty_count(), 1);

        // Read clears the dirty bit.
        assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));
        assert_eq!(sheet.debug_dirty_count(), 0);

        // Writing a dep flips it back to dirty.
        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.debug_dirty_count(), 1);
    }

    #[test]
    fn debug_imported_formula_count_counts_bulk_load_only() {
        let mut sheet = Sheet::new();
        // Plain set_formula must NOT bump the imported counter.
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=A1");
        assert_eq!(sheet.debug_imported_formula_count(), 0);

        // bulk_load with 5 formulas + 5 primitives — only the formulas bump.
        sheet.bulk_load(|loader| {
            for n in 0..5u32 {
                let addr = CellAddress::new(0, n + 2).to_string_repr();
                loader.set_cell(&addr, Value::Number(n as f64));
            }
            for n in 0..5u32 {
                let addr = CellAddress::new(1, n + 2).to_string_repr();
                let ok = loader.set_formula(&addr, "=A1+1");
                assert!(ok, "bulk-load formula at {} must register", addr);
            }
        });
        assert_eq!(sheet.debug_imported_formula_count(), 5);
    }

    #[test]
    fn debug_live_subscription_count_tracks_buckets() {
        let mut sheet = Sheet::new();
        assert_eq!(sheet.debug_live_subscription_count(), 0);

        let sub_a = sheet.subscribe_cell("A1", || {});
        let _sub_b = sheet.subscribe_cell("B2", || {});
        assert_eq!(sheet.debug_live_subscription_count(), 2);

        // A second listener on A1 reuses the existing bucket — still 2.
        let _sub_a2 = sheet.subscribe_cell("A1", || {});
        assert_eq!(sheet.debug_live_subscription_count(), 2);

        // Drop one A1 listener; bucket survives (still has the second one).
        sheet.unsubscribe_cell(sub_a);
        assert_eq!(sheet.debug_live_subscription_count(), 2);
    }

    #[test]
    fn debug_range_dep_count_counts_distinct_ranges() {
        // Three formulas, two distinct ranges: A1:A10 (twice) and B1:B5
        // (once). The counter must report 2 ranges, not 3 formulas and
        // not the 15 cells the ranges nominally span.
        let mut sheet = Sheet::new();
        assert_eq!(sheet.debug_range_dep_count(), 0);

        sheet.set_formula("C1", "=SUM(A1:A10)");
        assert_eq!(sheet.debug_range_dep_count(), 1);

        sheet.set_formula("C2", "=AVERAGE(A1:A10)");
        // Same range, second consumer — index stays at 1 entry.
        assert_eq!(sheet.debug_range_dep_count(), 1);

        sheet.set_formula("C3", "=SUM(B1:B5)");
        assert_eq!(sheet.debug_range_dep_count(), 2);

        // Replacing C2's formula with a non-range one drops it from the
        // A1:A10 dependents; C1 still references that range, so the
        // index entry survives.
        sheet.set_formula("C2", "=A1+1");
        assert_eq!(sheet.debug_range_dep_count(), 2);

        // Replace C1 too — A1:A10 has no remaining dependents and the
        // index entry should be removed by remove_formula_range_deps.
        sheet.set_formula("C1", "=A1+2");
        assert_eq!(sheet.debug_range_dep_count(), 1);
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
    fn set_formula_replaces_lazy_record_without_store_growth() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));
        let atoms_after_first = sheet.debug_total_atom_count();

        sheet.set_formula("B1", "=A1*3");
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));
        assert_eq!(
            sheet.debug_total_atom_count(),
            atoms_after_first,
            "formula replacement must not create core atoms"
        );

        for n in 1..=20 {
            sheet.set_formula("B1", &format!("=A1+{}", n));
        }
        assert_eq!(sheet.get_cell("B1"), Value::Number(30.0));
        assert_eq!(sheet.debug_formula_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), atoms_after_first);
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
    fn formula_subscriber_dirty_notified_for_same_source_value_writes() {
        // D1 lazy contract: source writes dirty dependent formulas even when
        // the primitive source value is unchanged. Consumers subscribe to the
        // formula cell and re-read on dirty notification.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(7.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(14.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        for _ in 0..3 {
            sheet.set_cell("A1", Value::Number(7.0));
        }

        assert_eq!(
            *count.borrow(),
            3,
            "same-value source writes must still dirty-notify formula subscribers"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(14.0));
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
    fn set_cell_releases_old_formula_record() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.debug_formula_count(), 1);

        sheet.set_cell("B1", Value::Number(5.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(5.0));
        assert_eq!(sheet.debug_formula_count(), 0);
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
    fn row_and_col_size_facts_stay_sparse() {
        let mut sheet = Sheet::new();

        assert_eq!(sheet.row_height(1), None);
        assert_eq!(sheet.col_width(2), None);

        assert!(sheet.set_row_height(1, 27));
        assert!(sheet.set_col_width(2, 144));
        assert_eq!(sheet.row_height(1), Some(27));
        assert_eq!(sheet.col_width(2), Some(144));
        assert_eq!(sheet.row_heights_in_range(0, 10), vec![(1, 27)]);
        assert_eq!(sheet.col_widths_in_range(0, 10), vec![(2, 144)]);

        assert!(sheet.set_row_height(5, 32));
        assert!(sheet.set_col_width(7, 180));
        assert_eq!(sheet.row_heights_in_range(2, 10), vec![(5, 32)]);
        assert_eq!(sheet.col_widths_in_range(3, 10), vec![(7, 180)]);

        assert!(sheet.clear_row_height(1));
        assert!(sheet.clear_col_width(2));
        assert_eq!(sheet.all_row_heights(), vec![(5, 32)]);
        assert_eq!(sheet.all_col_widths(), vec![(7, 180)]);
    }

    #[test]
    fn row_and_col_size_facts_shift_with_structural_edits() {
        let mut sheet = Sheet::new();
        assert!(sheet.set_row_height(1, 24));
        assert!(sheet.set_row_height(4, 36));
        assert!(sheet.set_col_width(1, 120));
        assert!(sheet.set_col_width(4, 200));

        sheet.insert_row(2, 2);
        sheet.insert_col(2, 2);
        assert_eq!(sheet.all_row_heights(), vec![(1, 24), (6, 36)]);
        assert_eq!(sheet.all_col_widths(), vec![(1, 120), (6, 200)]);

        sheet.delete_row(1, 2);
        sheet.delete_col(1, 2);
        assert_eq!(sheet.all_row_heights(), vec![(4, 36)]);
        assert_eq!(sheet.all_col_widths(), vec![(4, 200)]);
    }

    #[test]
    fn formula_references_unset_cell() {
        let mut sheet = Sheet::new();
        // B1 not set, should be Null → coerced to 0
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_cell("C1"), Value::Number(5.0));
    }

    // === Phase 6 — cell format tests ===

    #[test]
    fn set_get_format_roundtrip() {
        use crate::format::{Align, NumberFormat};
        let mut sheet = Sheet::new();
        let fmt = CellFormat {
            number_format: NumberFormat::Percent { digits: 0 },
            bold: true,
            align: Align::Center,
            ..Default::default()
        };
        sheet.set_format("A1", fmt.clone());
        assert_eq!(sheet.get_format("A1"), fmt);
        // Unset cells return default.
        assert_eq!(sheet.get_format("B2"), CellFormat::default());
        // Setting default removes the entry.
        sheet.set_format("A1", CellFormat::default());
        assert_eq!(sheet.get_format("A1"), CellFormat::default());
    }

    #[test]
    fn range_format_applies_to_empty_cells() {
        use crate::format::{Align, NumberFormat};

        let mut sheet = Sheet::new();
        let fmt = CellFormat {
            number_format: NumberFormat::Decimal {
                digits: 2,
                thousands: true,
            },
            bold: true,
            align: Align::Center,
            ..Default::default()
        };
        let updated = sheet.set_format_range(
            CellRange::new(CellAddress::new(1, 1), CellAddress::new(3, 3)),
            fmt.clone(),
        );
        assert_eq!(updated, 0);
        assert_eq!(sheet.get_format("B2"), fmt);
        assert_eq!(sheet.get_format("C4"), fmt);
        assert_eq!(sheet.get_format("A1"), CellFormat::default());
    }

    #[test]
    fn range_format_is_overridden_by_cell_format() {
        use crate::format::NumberFormat;

        let mut sheet = Sheet::new();
        sheet.set_format(
            "B2",
            CellFormat {
                bold: true,
                ..Default::default()
            },
        );

        sheet.set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(4, 4)),
            CellFormat {
                italic: true,
                ..Default::default()
            },
        );
        // Existing per-cell overrides inside the range are cleared when the
        // range layer is applied.
        assert_eq!(
            sheet.get_format("B2"),
            CellFormat {
                italic: true,
                ..Default::default()
            }
        );

        sheet.set_format(
            "B2",
            CellFormat {
                number_format: NumberFormat::Percent { digits: 0 },
                ..Default::default()
            },
        );
        assert_eq!(
            sheet.get_format("B2"),
            CellFormat {
                number_format: NumberFormat::Percent { digits: 0 },
                ..Default::default()
            }
        );
    }

    #[test]
    fn range_format_does_not_change_value_density() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        let before = sheet.non_empty_addrs().len();

        let updated = sheet.set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(99_999, 99_999)),
            CellFormat {
                italic: true,
                ..Default::default()
            },
        );

        assert_eq!(sheet.non_empty_addrs().len(), before);
        assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
        assert_eq!(updated, 0);
    }

    #[test]
    fn range_format_snapshot_restore_preserves_sparse_metadata() {
        let mut sheet = Sheet::new();
        sheet.set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(2, 2)),
            CellFormat {
                italic: true,
                ..Default::default()
            },
        );
        sheet.set_format(
            "B2",
            CellFormat {
                bold: true,
                ..Default::default()
            },
        );
        sheet.set_format(
            "E5",
            CellFormat {
                font_size: Some(18),
                ..Default::default()
            },
        );

        let snapshot = sheet.snapshot_format_range(CellRange::new(
            CellAddress::new(0, 0),
            CellAddress::new(3, 3),
        ));
        sheet.set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(3, 3)),
            CellFormat {
                background: Some("#ffeeaa".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            sheet.get_format("B2"),
            CellFormat {
                background: Some("#ffeeaa".into()),
                ..Default::default()
            }
        );

        assert_eq!(sheet.restore_format_range_snapshot(snapshot), 0);
        assert_eq!(
            sheet.get_format("A1"),
            CellFormat {
                italic: true,
                ..Default::default()
            }
        );
        assert_eq!(
            sheet.get_format("B2"),
            CellFormat {
                bold: true,
                ..Default::default()
            }
        );
        assert_eq!(sheet.get_format("D4"), CellFormat::default());
        assert_eq!(
            sheet.get_format("E5"),
            CellFormat {
                font_size: Some(18),
                ..Default::default()
            }
        );
    }

    #[test]
    fn range_format_notifies_only_subscribed_addresses() {
        use std::cell::Cell;
        use std::rc::Rc;
        let mut sheet = Sheet::new();
        let a = Rc::new(Cell::new(0u32));
        let b = Rc::new(Cell::new(0u32));

        let a2 = Rc::clone(&a);
        let b2 = Rc::clone(&b);
        let _sub_a = sheet.subscribe_cell("A1", move || a2.set(a2.get() + 1));
        let _sub_b = sheet.subscribe_cell("D4", move || b2.set(b2.get() + 1));

        let range = CellRange::new(CellAddress::new(0, 0), CellAddress::new(3, 3));
        let notified = sheet.set_format_range(
            range,
            CellFormat {
                italic: true,
                ..Default::default()
            },
        );

        assert_eq!(a.get(), 1);
        assert_eq!(b.get(), 1);
        assert_eq!(notified, 2);

        let c = Rc::new(Cell::new(0u32));
        let c2 = Rc::clone(&c);
        let _sub_c = sheet.subscribe_cell("E5", move || c2.set(c2.get() + 1));
        let notified = sheet.set_format_range(
            range,
            CellFormat {
                bold: true,
                ..Default::default()
            },
        );
        assert_eq!(c.get(), 0);
        assert_eq!(notified, 2);
    }

    #[test]
    fn formatted_display_uses_number_format() {
        use crate::format::NumberFormat;
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(0.5));
        // General → "0.5".
        assert_eq!(sheet.formatted_display("A1"), "0.5");
        sheet.set_format(
            "A1",
            CellFormat {
                number_format: NumberFormat::Percent { digits: 0 },
                ..Default::default()
            },
        );
        assert_eq!(sheet.formatted_display("A1"), "50%");
    }

    #[test]
    fn effective_format_applies_conditional_rules() {
        use crate::format::{Condition, ConditionalRule, StyleOverrides};
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(150.0));
        sheet.set_conditional_rules(vec![ConditionalRule {
            condition: Condition::GreaterThan(100.0),
            overrides: StyleOverrides {
                color: Some("#ff0000".into()),
                ..Default::default()
            },
        }]);
        let eff = sheet.effective_format("A1");
        assert_eq!(eff.color, Some("#ff0000".into()));
        // Below the threshold → base format passes through.
        sheet.set_cell("A1", Value::Number(50.0));
        let eff = sheet.effective_format("A1");
        assert_eq!(eff.color, None);
    }

    #[test]
    fn format_survives_row_insert() {
        let mut sheet = Sheet::new();
        let fmt = CellFormat {
            bold: true,
            ..Default::default()
        };
        sheet.set_cell("A5", Value::Number(1.0));
        sheet.set_format("A5", fmt.clone());
        sheet.insert_row(2, 1);
        // A5 → A6.
        assert_eq!(sheet.get_format("A6"), fmt);
        assert_eq!(sheet.get_format("A5"), CellFormat::default());
    }

    #[test]
    fn format_survives_col_insert() {
        let mut sheet = Sheet::new();
        let fmt = CellFormat {
            italic: true,
            ..Default::default()
        };
        sheet.set_format("C1", fmt.clone());
        sheet.insert_col(1, 1);
        // C1 → D1.
        assert_eq!(sheet.get_format("D1"), fmt);
        assert_eq!(sheet.get_format("C1"), CellFormat::default());
    }

    #[test]
    fn format_dropped_on_row_delete() {
        let mut sheet = Sheet::new();
        let fmt = CellFormat {
            bold: true,
            ..Default::default()
        };
        sheet.set_format("A5", fmt);
        // Delete row index 4 (= row 5 in 1-based).
        sheet.delete_row(4, 1);
        assert_eq!(sheet.get_format("A5"), CellFormat::default());
        assert_eq!(sheet.get_format("A4"), CellFormat::default());
    }

    #[test]
    fn format_dropped_on_col_delete() {
        let mut sheet = Sheet::new();
        let fmt = CellFormat {
            italic: true,
            ..Default::default()
        };
        sheet.set_format("C1", fmt);
        sheet.delete_col(2, 1);
        assert_eq!(sheet.get_format("C1"), CellFormat::default());
    }

    // === 3.10 — primitive atom GC on clear / set-Null ===

    #[test]
    fn clear_cell_releases_primitive_when_no_deps() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(42.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 1);

        sheet.clear_cell("A1");
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "clear_cell on a no-dep cell must release its primitive"
        );
        assert_eq!(
            sheet.debug_total_atom_count(),
            0,
            "store should hold no live atoms after clearing the only cell"
        );
        // Subsequent read still produces Null naturally.
        assert_eq!(sheet.get_cell("A1"), Value::Null);
    }

    #[test]
    fn clear_cell_keeps_primitive_when_formula_depends() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_formula("B1", "=A1*2");
        // Lazy backend: only A1 is materialized as a primitive. B1 is a
        // formula record with no primitive scaffold.
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));

        // After eval, A1 is in B1's dep set (cell_dependents[A1] contains B1).
        // try_release_primitive checks store-level has_dependents (atom-level),
        // which is false for A1's primitive (no derived atoms exist in lazy).
        // But we still want to keep A1 because B1's formula record depends on
        // it — clearing A1 sets the value to Null. The lazy formula will
        // re-evaluate against the new Null on next read.
        sheet.clear_cell("A1");
        // Lazy: A1 may be released (no atom-level dependents) since the
        // dep relationship is at the address level via cell_dependents.
        // B1 re-evaluates against A1 = Null → coerced to 0 → 0 * 2 = 0.
        assert_eq!(sheet.get_cell("B1"), Value::Number(0.0));
        assert_eq!(sheet.get_cell("A1"), Value::Null);
    }

    #[test]
    fn set_cell_to_null_releases_primitive() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);

        sheet.set_cell("A1", Value::Null);
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "set_cell(_, Null) must drop the primitive when no deps"
        );
        assert_eq!(sheet.debug_total_atom_count(), 0);
    }

    #[test]
    fn subscribed_cell_release_keeps_listener_alive() {
        // Subscriber contract on release: the bucket's listener list survives
        // even after the underlying primitive atom is destroyed. The next
        // set_cell on the address re-creates a fresh primitive and reattaches
        // the fanout — the listener fires as part of that write, same as
        // subscribing to an empty cell and setting it for the first time.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);
        // Pre: subscribed but no atom yet.
        assert_eq!(sheet.debug_primitive_atom_count(), 0);

        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(*count.borrow(), 1, "first write fires listener");

        sheet.set_cell("A1", Value::Null);
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            0,
            "primitive released even though A1 has a subscriber"
        );
        assert_eq!(
            *count.borrow(),
            2,
            "Number → Null is a value change → listener fires"
        );
        // Bucket still tracks the listener: subscriptions map keeps the entry.
        assert!(
            sheet
                .cell_subscriptions
                .get(&CellAddress::parse("A1").unwrap())
                .map(|b| !b.listeners.borrow().is_empty())
                .unwrap_or(false),
            "listener bucket must survive primitive release"
        );

        sheet.set_cell("A1", Value::Number(7.0));
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            1,
            "next write re-creates a fresh primitive"
        );
        assert_eq!(*count.borrow(), 3, "fresh primitive notifies the listener");
        assert_eq!(sheet.get_cell("A1"), Value::Number(7.0));
    }

    #[test]
    fn set_cell_then_clear_cycles_do_not_grow_atom_count() {
        // Long-running spreadsheet stress: many set/clear cycles on the same
        // address must not leak atoms. With 3.10 each cycle releases the
        // primitive at the bottom of the loop.
        let mut sheet = Sheet::new();
        for n in 0..100 {
            sheet.set_cell("A1", Value::Number(n as f64));
            sheet.clear_cell("A1");
        }
        assert_eq!(sheet.debug_primitive_atom_count(), 0);
        assert_eq!(sheet.debug_total_atom_count(), 0);
    }

    #[test]
    fn formula_to_null_releases_primitive_when_no_deps() {
        // Formula → primitive(Null) path: with_remap reattaches the fanout to
        // the freshly ensured primitive, then try_release_primitive at the
        // end of set_cell drops it because nothing depends on it.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(2.0));
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_cell("B1"), Value::Number(4.0));
        // Lazy formula: only A1 is materialized. B1 is a formula record, not
        // a primitive scaffold.
        assert_eq!(sheet.debug_primitive_atom_count(), 1);

        // Clear B1: formula goes away, primitive scaffold is Null and has no
        // dependents (B1 is a leaf, not referenced by anything). It gets
        // released; A1 is unaffected.
        sheet.clear_cell("B1");
        assert_eq!(
            sheet.debug_primitive_atom_count(),
            1,
            "B1 stays unmaterialized, A1 stays"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Null);
        assert_eq!(sheet.get_cell("A1"), Value::Number(2.0));
        assert_eq!(sheet.get_formula("B1"), None);
    }

    // === LAZY_FORMULA_EVAL Step 3 — bulk_load tests ===

    #[test]
    fn bulk_load_set_formula_zero_eval_count() {
        // 100 formulas through bulk_load must not trigger a single core
        // recompute. With lazy formulas the only way recompute_count can
        // increment is if a code path calls Store::recompute on a derived
        // atom, which the lazy path never does. The acceptance bar is "0",
        // not "small N".
        let mut sheet = Sheet::new();
        // Seed A1 so the formulas have something to reference; primitive
        // store.set does not bump recompute_count.
        sheet.set_cell("A1", Value::Number(1.0));
        let before = sheet.debug_recompute_count();

        sheet.bulk_load(|loader| {
            for n in 0..100u32 {
                // Row 0 col (n+1) avoids overwriting A1.
                let addr = CellAddress::new(0, n + 1).to_string_repr();
                let ok = loader.set_formula(&addr, "=A1+1");
                assert!(ok, "formula {} must parse + pass cycle check", addr);
            }
        });

        let after = sheet.debug_recompute_count();
        assert_eq!(
            after - before,
            0,
            "bulk_load with set_formula only must not trigger any core recompute"
        );
        assert_eq!(sheet.debug_formula_count(), 100);
        // All formula caches are still Dirty — no read happened.
        assert_eq!(
            sheet.debug_formula_cache_state("B1"),
            "dirty",
            "first bulk-loaded formula must remain dirty until read"
        );
    }

    #[test]
    fn bulk_load_notifies_subscribers_once() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        // Five subscribed addresses. Each gets its own counter so a missing
        // fire on one is visible.
        let counters: Vec<Rc<RefCell<u32>>> = (0..5).map(|_| Rc::new(RefCell::new(0u32))).collect();
        let addrs = ["A1", "B1", "C1", "D1", "E1"];
        for (i, addr) in addrs.iter().enumerate() {
            let c = counters[i].clone();
            sheet.subscribe_cell(addr, move || *c.borrow_mut() += 1);
        }

        // Bulk-load: write to all five subscribed addresses, plus some
        // unrelated ones, plus formulas whose downstream touches the
        // subscribed cells. Each subscribed address must fire exactly once.
        sheet.bulk_load(|loader| {
            for addr in &addrs {
                loader.set_cell(addr, Value::Number(1.0));
            }
            // Unrelated writes — should not bump any subscribed counter.
            loader.set_cell("Z10", Value::Number(42.0));
            loader.set_cell("Z11", Value::Number(43.0));
            // Formulas referencing A1 multiple times — without dedup A1's
            // listener could fire once per dirty downstream BFS pass.
            loader.set_formula("F1", "=A1+A1");
            loader.set_formula("F2", "=A1*2");
            loader.set_formula("F3", "=A1-1");
        });

        for (i, addr) in addrs.iter().enumerate() {
            assert_eq!(
                *counters[i].borrow(),
                1,
                "subscriber on {} must fire exactly once across the bulk_load",
                addr
            );
        }
    }

    #[test]
    fn bulk_load_skips_eval_until_first_read() {
        let mut sheet = Sheet::new();
        sheet.bulk_load(|loader| {
            loader.set_cell("A1", Value::Number(5.0));
            loader.set_formula("B1", "=A1*2");
        });

        // Pre-read: B1's cache is Dirty (formula was bulk-loaded, never
        // evaluated). The flush sweep only marks downstream cells of
        // touched addresses dirty — B1 itself is `touched` and starts Dirty
        // from `FormulaRecord::new`.
        assert_eq!(
            sheet.debug_formula_cache_state("B1"),
            "dirty",
            "bulk-loaded formula must stay dirty until first read"
        );

        // First read computes and caches.
        assert_eq!(sheet.get_cell("B1"), Value::Number(10.0));
        assert_eq!(
            sheet.debug_formula_cache_state("B1"),
            "clean",
            "first get_cell on a bulk-loaded formula must compute and cache"
        );
    }

    #[test]
    fn bulk_load_cycle_check_still_runs() {
        // Static cycle protection (B.2) is preserved inside bulk_load — the
        // task's contract: "cycle protection isn't worth dropping for perf".
        // The second formula closes a self-cycle and must be rejected with
        // false; no panic, no stack overflow on subsequent read.
        let mut sheet = Sheet::new();
        let mut a_ok = true;
        let mut b_ok = true;
        sheet.bulk_load(|loader| {
            a_ok = loader.set_formula("A1", "=B1+1");
            b_ok = loader.set_formula("B1", "=A1+1");
        });
        assert!(a_ok, "first formula has no cycle yet — must accept");
        assert!(
            !b_ok,
            "second formula closes the cycle — bulk_load must reject"
        );
        // B1 holds the cycle error; reading it must not stack-overflow.
        assert_eq!(sheet.get_cell("B1"), Value::Error(ValueError::CyclicRef));
    }

    #[test]
    fn bulk_load_unsubscribed_addresses_not_notified() {
        // Lazy-extreme contract: only currently-subscribed addresses get
        // notified at flush. We verify by writing to a subscribed A1 and an
        // unsubscribed Z99, then confirming (a) A1's subscriber fires
        // exactly once and (b) the bulk write itself does not recompute
        // anything — `debug_recompute_count` doesn't move even for Z99's
        // (empty) downstream set.
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);

        let before = sheet.debug_recompute_count();
        sheet.bulk_load(|loader| {
            loader.set_cell("A1", Value::Number(7.0));
            loader.set_cell("Z99", Value::Number(99.0));
        });
        let after = sheet.debug_recompute_count();

        assert_eq!(
            *count.borrow(),
            1,
            "subscribed A1 must fire exactly once at flush"
        );
        assert_eq!(
            after - before,
            0,
            "writing to unsubscribed Z99 must not trigger any recompute"
        );
        // And reading the subscribed cell still gets the bulk value.
        assert_eq!(sheet.get_cell("A1"), Value::Number(7.0));
        assert_eq!(sheet.get_cell("Z99"), Value::Number(99.0));
    }

    // === LAZY Step 4: SheetEvalProvider sparse range streaming ===

    #[test]
    fn sum_full_column_walks_sparse() {
        // Two real cells in a column with huge nominal extent. The
        // SheetEvalProvider sparse override drives `SUM(A1:A100000)` to
        // visit only the two real addresses, not 100_000.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(5.0));
        sheet.set_cell("A100000", Value::Number(10.0));

        let before_atoms = sheet.debug_primitive_atom_count();
        sheet.set_formula("B1", "=SUM(A1:A100000)");
        let v = sheet.get_cell("B1");
        let after_atoms = sheet.debug_primitive_atom_count();

        assert_eq!(v, Value::Number(15.0));
        // The two original primitive cells; SUM didn't create a third.
        assert_eq!(before_atoms, 2);
        assert_eq!(after_atoms, 2);
    }

    #[test]
    fn sum_stateless_no_atoms_materialized() {
        // 5 primitive cells across a huge range. SUM doesn't grow the
        // primitive atom count — no temp Vec, no atom-per-empty-cell.
        let mut sheet = Sheet::new();
        for (addr, val) in [
            ("A1", 1.0),
            ("A10", 2.0),
            ("A100", 3.0),
            ("A1000", 4.0),
            ("A10000", 5.0),
        ] {
            sheet.set_cell(addr, Value::Number(val));
        }
        let before = sheet.debug_primitive_atom_count();
        assert_eq!(before, 5);

        sheet.set_formula("B1", "=SUM(A1:A100000)");
        let v = sheet.get_cell("B1");
        assert_eq!(v, Value::Number(15.0));

        let after = sheet.debug_primitive_atom_count();
        assert_eq!(
            after, before,
            "SUM(huge range) must not materialize cell atoms (before={}, after={})",
            before, after
        );
    }

    #[test]
    fn median_stateful_still_works_via_sheet_provider() {
        // MEDIAN keeps its temp Vec but routes through the sparse range
        // streaming path. A1..A5 = 1..5 → MEDIAN = 3. No atoms beyond
        // the 5 primitives we set.
        let mut sheet = Sheet::new();
        for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            sheet.set_cell(&format!("A{}", i + 1), Value::Number(*n));
        }
        let before = sheet.debug_primitive_atom_count();
        sheet.set_formula("B1", "=MEDIAN(A1:A5)");
        let v = sheet.get_cell("B1");
        let after = sheet.debug_primitive_atom_count();

        assert_eq!(v, Value::Number(3.0));
        assert_eq!(after, before, "MEDIAN must not materialize cell atoms");
    }

    #[test]
    fn average_streaming_matches_eager_via_sheet_provider() {
        // Random-ish integer values + an empty hole. AVERAGE should
        // match (sum / count) of only the real numeric cells; the hole
        // is skipped, no atom created.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(10.0));
        sheet.set_cell("A2", Value::Number(20.0));
        // A3 left empty intentionally
        sheet.set_cell("A4", Value::Number(40.0));
        sheet.set_cell("A5", Value::Number(50.0));

        let before = sheet.debug_primitive_atom_count();
        sheet.set_formula("B1", "=AVERAGE(A1:A5)");
        let v = sheet.get_cell("B1");
        let after = sheet.debug_primitive_atom_count();

        // Expected: AVERAGE skips Null (empty cell). Sum=120, count=4.
        assert_eq!(v, Value::Number(30.0));
        assert_eq!(after, before, "AVERAGE must not materialize cell atoms");
    }

    #[test]
    fn count_range_with_holes_via_sheet_provider() {
        // A1=1, A3=2, A5=3 — A2/A4 empty. COUNT(A1:A5) = 3 (Excel's
        // contract: numeric values only, holes skipped).
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A3", Value::Number(2.0));
        sheet.set_cell("A5", Value::Number(3.0));

        sheet.set_formula("B1", "=COUNT(A1:A5)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
    }

    #[test]
    fn non_empty_addrs_skips_empties_and_unions_kinds() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B2", Value::Text("hi".into()));
        sheet.set_formula("C3", "=A1+1");
        // D4 left untouched — must NOT appear.
        let mut got = sheet.non_empty_addrs();
        got.sort();
        assert_eq!(got, vec!["A1", "B2", "C3"]);
    }

    #[test]
    fn non_empty_addrs_dedups_primitive_under_formula() {
        // When the same address holds a formula, it must not appear twice
        // even if a stale primitive slot was created before the upgrade.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(99.0));
        sheet.set_formula("A1", "=2+2");
        let got = sheet.non_empty_addrs();
        assert_eq!(got, vec!["A1"]);
    }

    #[test]
    fn non_empty_addrs_drops_cleared() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B1", Value::Number(2.0));
        sheet.clear_cell("A1");
        let got = sheet.non_empty_addrs();
        assert_eq!(got, vec!["B1"]);
    }

    #[test]
    fn non_empty_in_range_skips_holes_and_does_not_eval_formulas() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("C3", Value::Number(3.0));
        sheet.set_formula("B2", "=A1+1");

        let range = CellRange::new(CellAddress::new(0, 0), CellAddress::new(1, 1));
        let mut got = Vec::new();
        sheet.for_each_non_empty_in_range(range, |addr| got.push(addr.to_string()));

        got.sort();
        assert_eq!(got, vec!["A1", "B2"]);
        assert_eq!(sheet.debug_formula_cache_state("B2"), "dirty");
    }

    #[test]
    fn clear_range_clears_sparse_hits_and_dirties_dependents() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("C3", Value::Number(3.0));
        sheet.set_formula("D1", "=A1+1");
        assert_eq!(sheet.get_cell("D1"), Value::Number(2.0));
        assert_eq!(sheet.debug_formula_cache_state("D1"), "clean");

        let range = CellRange::new(CellAddress::new(0, 0), CellAddress::new(1, 1));
        assert_eq!(sheet.clear_range(range), 1);

        assert_eq!(sheet.get_cell("A1"), Value::Null);
        assert_eq!(sheet.get_cell("C3"), Value::Number(3.0));
        assert_eq!(sheet.debug_formula_cache_state("D1"), "dirty");
        assert_eq!(sheet.get_cell("D1"), Value::Number(1.0));
    }

    // === Phase 1 Track A — P0 bug: range dep survives sparse eval ===
    //
    // `collect_refs` statically expands `Expr::Range` into individual cell
    // deps at `set_formula` time, so A50 is initially registered as a
    // dependent of B1. But during the first `get_cell` evaluation the
    // sparse range iterator only yields non-empty addresses, the tracked
    // dep set is built from what eval visited, and `replace_formula_deps`
    // then replaces the formula's dep set with that visited-only set —
    // discarding A50. Writing A50 later therefore doesn't dirty B1 and
    // SUM stays stale.
    //
    // The fix preserves range deps as ranges across eval (a separate
    // `range_deps` index that doesn't get rewritten by the tracked eval
    // set). Until that fix lands, this test must FAIL on the second
    // assertion (the post-write read still returns 3.0).
    #[test]
    fn range_dep_survives_sparse_eval() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A100", Value::Number(2.0));
        sheet.set_formula("B1", "=SUM(A1:A100)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        // A50 was empty during the first sparse eval. Writing it must
        // still dirty B1 — range deps mustn't be collapsed to "visited
        // cells only".
        sheet.set_cell("A50", Value::Number(10.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(13.0));
    }

    /// Phase 2 Track E: ranges wider than `WIDE_RANGE_BUCKET_THRESHOLD`
    /// (4096 rows / cols) take the `wide_ranges` fallback — they're not
    /// registered into per-row / per-col buckets (registration would
    /// dominate at 1M rows). The fallback gets a linear scan on lookup,
    /// but it stays small in practice (a handful of "whole sheet" deps).
    /// This test exercises that path: a 5000-row range still dirties its
    /// dependent on a write inside it AND `dependents_of` finds the
    /// range via `wide_ranges`, not via row_buckets.
    #[test]
    fn range_dep_wide_range_uses_wide_fallback() {
        let mut sheet = Sheet::new();
        // 5000 rows — above the 4096 threshold. Phase 1 stored it the
        // same as any other range; Phase 2 routes it into wide_ranges.
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A5000", Value::Number(2.0));
        sheet.set_formula("B1", "=SUM(A1:A5000)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));

        // A write deep inside the wide range must still dirty B1. If
        // wide_ranges weren't consulted by `dependents_of`, the row
        // bucket for row 2499 would be empty and the candidate set
        // would be empty too — B1 stays stale at 3.0.
        sheet.set_cell("A2500", Value::Number(10.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(13.0));

        // Candidate set for any address in the range should include
        // exactly the one wide range — debug_range_dep_count is 1.
        assert_eq!(sheet.debug_range_dep_count(), 1);
        assert_eq!(sheet.debug_range_dep_candidates("A2500"), 1);
        // An address outside the range still surfaces it as a candidate
        // (wide_ranges is scanned unconditionally) but the
        // `range.contains` filter in `dependents_of` rejects it.
        assert_eq!(sheet.debug_range_dep_candidates("Z1"), 1);
    }

    /// Phase 2 Track E acceptance: the candidate-range lookup driving
    /// `dependents_of` must be bucketed, not a linear scan over every
    /// registered range. Registers 1000 disjoint 3-row tall ranges in
    /// column A (one per formula cell down column C) and asserts that
    /// for an address (row r, col 0) covered by exactly 3 of them, the
    /// internal candidate set returned by `RangeDependentIndex::
    /// candidates_for` contains at most a handful of ranges — NOT all
    /// 1000. The previous Phase 1 implementation would have returned
    /// every range here.
    #[test]
    fn range_dependents_lookup_is_bucketed() {
        let mut sheet = Sheet::new();
        // 1000 ranges, each 3 rows tall, with overlapping but mostly
        // disjoint coverage. Range i covers rows [i, i+2] of column A.
        // Probe row r=500 — only ranges i ∈ {498, 499, 500} cover it.
        const N: u32 = 1000;
        for i in 0..N {
            let formula = format!("=SUM(A{}:A{})", i + 1, i + 3);
            let target = format!("C{}", i + 1);
            sheet.set_formula(&target, &formula);
        }

        // All 1000 distinct ranges registered.
        assert_eq!(sheet.debug_range_dep_count(), N as usize);

        // A501 sits in column A, row 500 (0-indexed). Three ranges
        // cover it: row 500 ∈ [498, 500], [499, 501], [500, 502].
        let candidates = sheet.debug_range_dep_candidates("A501");

        // Tight bound: at most a small constant. The previous
        // O(range_count) scan would walk all N. Using N/10 as a loose
        // upper bound that still catches regressions if a future
        // change accidentally registers ranges in every row.
        assert!(
            candidates <= (N / 10) as usize,
            "candidate set should be bucket-narrowed; got {} of {} ranges",
            candidates,
            N
        );
        assert!(
            candidates >= 3,
            "candidate set must contain the 3 covering ranges; got {}",
            candidates
        );
    }

    // === Phase 2 Track F — sparse range read visits O(matches) ===

    /// Scatter 1000 cells across 10000 rows (one cell per even-decade
    /// row), then read a 51-row band. The callback must fire only for
    /// the cells inside the band, not for the full 1000 — the whole
    /// point of switching `cells` to a row-major BTreeMap is that
    /// `for_each_sparse_cell_with` does `BTreeMap::range`, not a
    /// `filter` sweep over every non-empty entry.
    #[test]
    fn for_each_range_cell_visits_only_overlap() {
        let mut sheet = Sheet::new();

        // Seed 1000 cells at rows {1, 11, 21, ..., 9991} in column A
        // (col index 0, row index = 10*k for k in 0..1000 ⇒ row 0,
        // 10, 20, ..., 9990 in zero-based ⇒ "A1", "A11", "A21", ...,
        // "A9991" in 1-based labels). Using row stride 10 makes the
        // expected hit count for the target band exact and obvious.
        let mut seeded = Vec::with_capacity(1000);
        for k in 0..1000u32 {
            let row = k * 10; // 0-based row index
            let addr = CellAddress::new(row, 0); // column A
            sheet.set_cell(&addr.to_string_repr(), Value::Number(k as f64));
            seeded.push(addr);
        }
        assert_eq!(sheet.debug_primitive_atom_count(), 1000);

        // Target band: 1-based rows 50..=100 ⇒ 0-based rows 49..=99.
        // Seeded rows inside this band: 50, 60, 70, 80, 90 ⇒ 5 hits.
        let range = CellRange::new(CellAddress::new(49, 0), CellAddress::new(99, 0));

        let mut visited: Vec<CellAddress> = Vec::new();
        sheet.for_each_sparse_cell_with(range, &|s, addr| s.peek_value(addr), &mut |addr, _v| {
            visited.push(addr)
        });

        // Exactly the band cells, nothing else.
        let expected: Vec<CellAddress> = seeded
            .iter()
            .copied()
            .filter(|a| range.contains(*a))
            .collect();
        assert_eq!(
            visited,
            expected,
            "for_each_range_cell must visit ONLY cells inside the range \
             (got {} visits for a band overlapping {} seeded cells out of 1000 total)",
            visited.len(),
            expected.len()
        );
        assert_eq!(
            visited.len(),
            5,
            "expected 5 hits at rows 50, 60, 70, 80, 90 — got {}",
            visited.len()
        );
        // Most importantly: NOT 1000. The whole acceptance contract
        // of Track F is that range reads do not pay an O(N) cost.
        assert!(
            visited.len() < 1000,
            "range read scanned the full sheet ({} visits) — \
             RowMajorMap::range_iter not actually scoping the walk",
            visited.len()
        );
    }

    // === Phase 2 Track G — whole-col / whole-row eval ===

    /// `=SUM(A:A)` evaluates the entire column A, picking up cells
    /// regardless of how far down they sit. The sheet has 4 real cells
    /// in column A — including one in row 1,000,000 — and one cell in
    /// column B that must NOT contribute. Sum is exactly 10.
    #[test]
    fn sum_whole_col_evaluates_against_all_rows() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A2", Value::Number(2.0));
        sheet.set_cell("A3", Value::Number(3.0));
        // 1-based row 1,000,000 → 0-based 999,999. Far above the
        // bounded `A1:A1048576` extent; trivially confirms the
        // unbounded path doesn't clamp early.
        sheet.set_cell("A1000000", Value::Number(4.0));
        sheet.set_cell("B1", Value::Number(99.0)); // not in column A

        let before = sheet.debug_primitive_atom_count();
        sheet.set_formula("C1", "=SUM(A:A)");
        let v = sheet.get_cell("C1");
        let after = sheet.debug_primitive_atom_count();

        assert_eq!(v, Value::Number(10.0));
        // No atoms materialized for empty rows between A3 and A1000000.
        // before is 5 (A1, A2, A3, A1000000, B1); SUM(A:A) must not
        // grow it.
        assert_eq!(
            after, before,
            "SUM(A:A) must not materialize empty-cell atoms in the 1M-row \
             coordinate space (before={}, after={})",
            before, after
        );
    }

    /// `=SUM(1:1)` sums row 1 across columns. Same lazy contract.
    /// Important: the formula cell must NOT live in row 1 — otherwise
    /// it self-references and eval correctly returns CyclicRef.
    #[test]
    fn sum_whole_row_evaluates_across_cols() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B1", Value::Number(2.0));
        sheet.set_cell("C1", Value::Number(3.0));
        sheet.set_cell("A2", Value::Number(99.0)); // not in row 1

        let before = sheet.debug_primitive_atom_count();
        // Park the formula on row 2 (out of the SUM range) so we test
        // the row-1 sum, not the self-cycle on row 1.
        sheet.set_formula("D2", "=SUM(1:1)");
        let v = sheet.get_cell("D2");
        let after = sheet.debug_primitive_atom_count();

        assert_eq!(v, Value::Number(6.0));
        assert_eq!(after, before, "SUM(1:1) must not materialize atoms");
    }

    /// `=SUM(A:C)` covers columns A through C, every row.
    #[test]
    fn sum_multi_col_range() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("B1", Value::Number(2.0));
        sheet.set_cell("C1", Value::Number(3.0));
        sheet.set_cell("D1", Value::Number(99.0)); // not in A:C
        sheet.set_cell("A100", Value::Number(10.0));
        sheet.set_cell("C500", Value::Number(20.0));

        sheet.set_formula("E1", "=SUM(A:C)");
        assert_eq!(sheet.get_cell("E1"), Value::Number(36.0));
    }

    /// Equivalence: `=SUM(A1:A1048576)` and `=SUM(A:A)` must compute
    /// the same total over the same seeded cells, AND both must keep
    /// the primitive atom count bounded by the actual non-empty cells.
    #[test]
    fn whole_col_matches_explicit_bounded_form() {
        let mut sheet = Sheet::new();
        for (i, n) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            sheet.set_cell(&format!("A{}", (i + 1) * 100), Value::Number(*n));
        }
        let before = sheet.debug_primitive_atom_count();
        assert_eq!(before, 5);

        sheet.set_formula("B1", "=SUM(A1:A1048576)");
        let bounded = sheet.get_cell("B1");

        sheet.set_formula("C1", "=SUM(A:A)");
        let unbounded = sheet.get_cell("C1");

        let after = sheet.debug_primitive_atom_count();

        assert_eq!(bounded, Value::Number(15.0));
        assert_eq!(unbounded, Value::Number(15.0));
        assert_eq!(bounded, unbounded);
        assert_eq!(
            after, before,
            "neither =SUM(A1:A1048576) nor =SUM(A:A) should materialize \
             cell atoms outside the 5 seeded ones (before={}, after={})",
            before, after
        );
    }

    /// Writes deep inside an unbounded range still dirty the dependent
    /// formula — Track E routes wide ranges (including unbounded) to
    /// `wide_ranges`, which is linearly scanned on every write.
    #[test]
    fn whole_col_dirty_propagation() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A2", Value::Number(2.0));
        sheet.set_formula("B1", "=SUM(A:A)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));

        // Write to A1_000_000 (row 999,999, col 0). Range registration
        // sent this whole-col into wide_ranges (rows > 4096), so the
        // dirty-write path consults wide_ranges and re-evaluates B1.
        sheet.set_cell("A1000000", Value::Number(100.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(103.0));
    }
}
