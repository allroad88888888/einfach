use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::rc::{Rc, Weak};

use std::sync::Arc;

use einfach_core::{
    ArrayData, AtomFamily, AtomId, CellListener, ReadArgs, Store, SubscriptionId, Value, ValueError,
};

use crate::cell::CellAddress;
use crate::eval::{eval_expr_with_provider, CustomFunctionRegistry, EvalProvider};
use crate::format::{apply_rules, CellFormat, ConditionalRule};
use crate::formula::{parse_formula, Expr, RangeBounds};
use crate::range::CellRange;

const EXCEL_MAX_ROWS: u32 = 1_048_576;
const EXCEL_MAX_COLS: u32 = 16_384;
const RANGE_TIER_A_CELL_LIMIT: u64 = 256;
const RANGE_BAND_ROWS: u32 = 256;
const RANGE_BAND_DEP_LIMIT: u64 = 4_096;
const RANGE_COLUMN_DEP_LIMIT: u64 = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RangeBandKey {
    col: u32,
    row_band: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RangeColumnKey {
    col: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RangeGeometryBounds {
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
}

fn clamp_range_axis_end(value: u32, max_len: u32) -> u32 {
    if value == u32::MAX {
        max_len - 1
    } else {
        value.min(max_len - 1)
    }
}

fn range_geometry_bounds(range: CellRange) -> RangeGeometryBounds {
    let n = range.normalize();
    RangeGeometryBounds {
        start_row: n.start.row.min(EXCEL_MAX_ROWS - 1),
        end_row: clamp_range_axis_end(n.end.row, EXCEL_MAX_ROWS),
        start_col: n.start.col.min(EXCEL_MAX_COLS - 1),
        end_col: clamp_range_axis_end(n.end.col, EXCEL_MAX_COLS),
    }
}

fn inclusive_span_u64(start: u32, end: u32) -> u64 {
    if end < start {
        0
    } else {
        u64::from(end - start) + 1
    }
}

fn range_cell_count_u64(range: CellRange) -> u64 {
    let bounds = range_geometry_bounds(range);
    let rows = inclusive_span_u64(bounds.start_row, bounds.end_row);
    let cols = inclusive_span_u64(bounds.start_col, bounds.end_col);
    rows.saturating_mul(cols)
}

fn range_row_band(row: u32) -> u32 {
    row / RANGE_BAND_ROWS
}

fn range_band_count_u64(range: CellRange) -> u64 {
    let bounds = range_geometry_bounds(range);
    let cols = inclusive_span_u64(bounds.start_col, bounds.end_col);
    let start_band = range_row_band(bounds.start_row);
    let end_band = range_row_band(bounds.end_row);
    let bands = inclusive_span_u64(start_band, end_band);
    cols.saturating_mul(bands)
}

fn range_band_key_for_addr(addr: CellAddress) -> RangeBandKey {
    RangeBandKey {
        col: addr.col,
        row_band: range_row_band(addr.row),
    }
}

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

    /// Build from unsorted `(addr, V)` pairs in one pass (AUDIT B-2):
    /// sort row-major, then bulk-build the nested BTreeMaps via
    /// `FromIterator` — std's sorted bulk construction packs nodes
    /// linearly instead of paying a random-order tree insert per cell.
    /// At bulk-install scale (1M cells from a HashMap payload) this
    /// beats N individual `insert` calls by a wide margin. Duplicate
    /// addresses resolve last-wins (install payloads are HashMap-backed,
    /// so duplicates cannot occur in practice).
    pub(crate) fn from_unsorted_pairs(mut pairs: Vec<(CellAddress, V)>) -> Self {
        pairs.sort_unstable_by(|(a, _), (b, _)| (a.row, a.col).cmp(&(b.row, b.col)));
        let mut by_row: BTreeMap<u32, BTreeMap<u32, V>> = BTreeMap::new();
        let mut len = 0usize;
        let mut iter = pairs.into_iter().peekable();
        while let Some((first_addr, first_value)) = iter.next() {
            let row = first_addr.row;
            let mut cols: Vec<(u32, V)> = vec![(first_addr.col, first_value)];
            while let Some((next_addr, _)) = iter.peek() {
                if next_addr.row != row {
                    break;
                }
                let (next_addr, next_value) = iter.next().expect("peeked entry present");
                cols.push((next_addr.col, next_value));
            }
            // Sorted input → `FromIterator` takes the bulk-build path.
            let row_map: BTreeMap<u32, V> = cols.into_iter().collect();
            len += row_map.len();
            by_row.insert(row, row_map);
        }
        RowMajorMap { by_row, len }
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

/// Old storage atoms retired by a full-sheet replacement. Cleanup runs only
/// after the enclosing Store batch flushes, when cross-sheet dependents have
/// detached from the previous graph.
pub(crate) struct BulkInstallCleanup {
    retired_atom_ids: Vec<AtomId>,
}

/// Aggregate dep-graph statistics produced by
/// `Sheet::debug_dep_graph_stats` (Phase 1 of the lazy-formula-indexing
/// arc). One per sheet; the workbook-level probe in `WasmWorkbook`
/// sums these across all sheets and computes derived metrics
/// (avg_fanout) on the JS side.
///
/// All counters are `u64` so summing across sheets in the workbook
/// probe can't overflow even at multi-million formula scale.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DepGraphStats {
    /// Number of formula records in this sheet (`formula_cells.len()`).
    pub formula_count: u64,
    /// Legacy point-dep edge count. Same-sheet point edges are now owned
    /// by the atom store, so this stays zero after the P4c flip.
    pub total_point_dep_edges: u64,
    /// Number of materialized Tier-B range geometry roots. These are Store
    /// primitives (band, column, or sheet epochs), never formula fanout edges.
    pub total_range_dep_entries: u64,
    /// Legacy same-sheet point fanout. Store-owned point edges are not
    /// counted by this sheet-level probe.
    pub max_fanout: u32,
    /// Number of hydrated formula records whose static range metadata is
    /// non-empty. This is parser/structure metadata, not reactive fanout.
    pub range_formula_count: u64,
}

pub(crate) struct FormulaRecord {
    expr: Rc<Expr>,
    /// Formula-topology generation in which static analysis proved this
    /// address is not a member of a same-sheet dependency cycle. This is a
    /// validation certificate only: Store edges remain the sole reactive
    /// dependency graph and the stamp never participates in recomputation.
    cycle_checked_at: Cell<u64>,
    /// Static point-cell references (`Expr::CellRef`, plus bounded range
    /// cells expanded by `collect_refs`). Kept on the record for structural
    /// retargeting and debug probes; reactive same-sheet invalidation is
    /// owned by the atom store.
    deps: RefCell<HashSet<CellAddress>>,
    /// Static `Expr::Range` metadata used by structural retargeting and cycle
    /// checks. Same-sheet invalidation is owned exclusively by Store edges.
    static_ranges: RefCell<HashSet<CellRange>>,
}

impl FormulaRecord {
    fn new(expr: Rc<Expr>, deps: HashSet<CellAddress>, static_ranges: HashSet<CellRange>) -> Self {
        FormulaRecord {
            expr,
            cycle_checked_at: Cell::new(0),
            deps: RefCell::new(deps),
            static_ranges: RefCell::new(static_ranges),
        }
    }
}

/// Raw bulk-loaded formula source plus its static-cycle validation stamp.
/// Keeping the stamp on the already-retained parked entry avoids introducing
/// a second address-keyed cache or dependency graph.
#[derive(Clone)]
pub(crate) struct ParkedFormula {
    source: Rc<str>,
    cycle_checked_at: Cell<u64>,
}

impl ParkedFormula {
    fn new(source: impl Into<Rc<str>>) -> Self {
        Self {
            source: source.into(),
            cycle_checked_at: Cell::new(0),
        }
    }
}

struct StaticCycleNode {
    addr: CellAddress,
    expr: Rc<Expr>,
    edges: Vec<usize>,
}

#[derive(Clone, Copy)]
struct StaticCycleCheckOutcome {
    closes_cycle: bool,
    target_certified: bool,
}

fn normalize_formula_cell_result(value: Value) -> Value {
    match value {
        Value::Lambda(_) => Value::Error(ValueError::Calc),
        other => other,
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
/// to a cell address; internally it is wired to the stable per-address facade
/// atom so formula/literal swaps do not require listener remapping.
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
    /// Wave 8 re-entrancy guard: the workbook attempted to mutate while
    /// a host custom-formula JS callback was executing. The mutation is
    /// rejected so the transitional workbook-evaluation state stays sound (see
    /// `Workbook::is_inside_custom_call` and
    /// `CUSTOM_FORMULAS.md` § "No mutations during callback").
    MutationDuringCustomCall,
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
            SheetError::MutationDuringCustomCall => write!(
                f,
                "workbook mutations are forbidden while a custom-formula callback is executing"
            ),
        }
    }
}

impl std::error::Error for SheetError {}

/// Storage slot for a primitive cell (AUDIT B-2 — lazy atomization).
///
/// Bulk installs park raw `Value`s (`Plain`); a core store atom is only
/// allocated when something actually needs atom semantics — a subscription
/// fanout attach, a spill anchor/target install, or any mutation path that
/// routes through `ensure_cell`. Mirrors the lazy-formula split one layer
/// down: the storage map is the source of truth, the atom is a demand-
/// created projection. Invariants:
///
///   - `Plain` slots are never `Value::Null` (Null means "absent"; the
///     install path skips Nulls and every write path promotes first).
///   - An address with a live subscription fanout is never `Plain`
///     (`attach_address_sub` promotes before wiring the store sub).
///   - Spill anchors and spill targets are always `Atom` (anchors via
///     `ensure_cell`, targets hold derived atoms).
#[derive(Debug)]
pub(crate) enum CellSlot {
    /// Raw stored value — no core atom allocated yet.
    Plain(Value),
    /// Materialized core atom (primitive or spill-target derived).
    Atom(AtomId),
}

impl CellSlot {
    /// The materialized atom id, if any. `Plain` slots have none.
    fn atom_id(&self) -> Option<AtomId> {
        match self {
            CellSlot::Atom(id) => Some(*id),
            CellSlot::Plain(_) => None,
        }
    }
}

/// Shared interior cell/formula storage (P4a of the atom-delegation
/// rewrite — see `rust/docs/ATOM_DELEGATION_REWRITE_PLAN.md`). Holds the
/// per-sheet state that formula read-closures will later (P4c) need to
/// reach from inside the store via a `Weak<SheetInterior>` capture, so
/// it lives behind an `Rc` on [`Sheet`] instead of as direct fields.
///
/// BORROW RULE (D7 corollary): no borrow of any field here may be held
/// across a `store.*` call, an `owned_*` wrapper, subscriber/listener
/// dispatch, or any `Sheet` method that might re-borrow the same field.
/// Pattern: borrow → copy out (clone the `Value` / copy the `AtomId` /
/// collect into a `Vec`) → release the guard → act.
pub(crate) struct SheetInterior {
    /// Primitive cell slots keyed by `(row, col)`. Backed by a row-major
    /// `RowMajorMap` so range reads (e.g. viewport, `SUM(A1:A100)`) scan
    /// O(cells_in_range) rather than the full non-empty set — the Phase 2
    /// Track F target from `PHASE2_PARALLEL.md`. API surface still mimics
    /// `HashMap` (`get`/`insert`/`remove`/`contains_key`/`len`/`keys`).
    ///
    /// AUDIT B-2: slots are either `Plain(Value)` (lazily atomized — the
    /// bulk-install fast path) or `Atom(AtomId)` (materialized). See
    /// [`CellSlot`] for the invariants.
    pub(crate) cells: RefCell<RowMajorMap<CellSlot>>,
    /// Formula structural records live at the Sheet layer. Hydrated same-sheet
    /// formula results are derived and cached by Store formula-inner atoms.
    /// Same row-major shape as `cells` keeps range scans over mixed
    /// primitive/formula cells O(matches).
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: `RefCell` so `hydrate_formula(&self)`
    /// can install a freshly-parsed record without taking `&mut self`.
    /// Read paths consult the map via short `borrow()` snapshots that
    /// clone `Rc<FormulaRecord>` and release the borrow before any
    /// recursive eval (which might re-enter through another read /
    /// hydration). Iteration patterns snapshot keys first to avoid
    /// holding the borrow across a possible `borrow_mut`.
    pub(crate) formula_cells: RefCell<RowMajorMap<Rc<FormulaRecord>>>,
    /// AST of each formula cell, used for static cycle detection (B.2).
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: `RefCell` so the hydrator can
    /// insert during a `&self` read. Same recursion-safety pattern as
    /// `formula_cells`.
    pub(crate) formula_exprs: RefCell<HashMap<CellAddress, Rc<Expr>>>,
    /// Original formula text per cell, for `get_formula` so the formula bar
    /// and edit-mode entry can show the source instead of the computed
    /// result (D.11).
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: `RefCell` for the same hydrator-
    /// from-`&self` reason.
    pub(crate) formula_texts: RefCell<HashMap<CellAddress, String>>,
    /// Lazy-load source storage (Phase 2 of LAZY_FORMULA_INDEXING). Holds
    /// the raw formula text for cells that came in via `bulk_load` and
    /// have NOT yet been parsed / indexed. Mirrors `formula_cells` in
    /// row-major shape so range scans still cost O(cells_in_range), but
    /// each entry is raw source plus one static-validation generation stamp:
    /// no AST, reference set, `FormulaRecord`, or formula-inner derived atom.
    /// Entries are drained
    /// into `formula_cells` / `formula_exprs` / `formula_texts` by
    /// `hydrate_formula` once a read first touches them.
    ///
    /// Co-existence rule: `formula_source.contains_key(addr)` ↔
    /// `needs_parse.contains(addr)`. While the addr is unhydrated:
    ///   - `formula_cells` does NOT have an entry
    ///   - `formula_exprs` does NOT have an entry
    ///   - `formula_texts` does NOT have an entry
    ///   - same-sheet Store edges are absent until the facade/formula-inner
    ///     path materializes; Tier-B geometry roots stay unmaterialized
    /// Hydration moves the source out of `formula_source` and into the
    /// eager state atomically (single-threaded — no races).
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: wrapped in `RefCell` so the
    /// hydrator (which runs from `&self` contexts) can both read the
    /// source and remove the entry after install.
    pub(crate) formula_source: RefCell<RowMajorMap<ParkedFormula>>,
    /// Lazy-load index of unparsed formulas. `RefCell` because read-only
    /// entry points (`peek_value_with_provider`, sparse-iter resolvers,
    /// cycle checks) need to drain entries as part of hydration without
    /// taking `&mut self`.
    ///
    /// Invariant: a single address appears in `needs_parse` iff it also
    /// appears as a key in `formula_source`. Hydration removes from both
    /// in lockstep.
    pub(crate) needs_parse: RefCell<HashSet<CellAddress>>,
}

/// A spreadsheet sheet backed by an atom store.
pub struct Sheet {
    pub(crate) store: Store,
    /// Number of store atoms THIS sheet created and still owns. With the
    /// P3 workbook-global shared store, `store.debug_total_atom_count()`
    /// counts every sheet's atoms; per-sheet probes and fences need the
    /// sheet-local number, maintained by the `owned_*` lifecycle wrappers
    /// (the only places this sheet creates or destroys atoms).
    /// Behind `Rc<Cell<_>>` so the P4c facade-creation context (`FacadeCtx`)
    /// can share the counter into `'static` inner-atom closures that mint
    /// dependent-cell facades on demand.
    atoms_owned: Rc<Cell<usize>>,
    /// Shared cell/formula storage — see [`SheetInterior`] for the field
    /// docs and the P4a borrow rule.
    pub(crate) interior: Rc<SheetInterior>,
    /// P4b/P4c: per-address slot-epoch primitives. A cell's epoch atom is bumped
    /// whenever its inner atom identity changes (literal↔formula overwrite,
    /// clear). The facade derives off this so a swap re-runs the facade read
    /// without re-keying any subscription. Created lazily on first use and
    /// wired by the current read/write paths.
    /// Behind `Rc<RefCell<_>>` so `FacadeCtx` can share it into `'static`
    /// closures (see `cell_facade_family`).
    slot_epoch_family: Rc<RefCell<AtomFamily<CellAddress>>>,
    /// P4b: per-address facade derived atoms — the stable subscription anchor
    /// that replaces `AddressSubscriptionBucket` remapping. A facade reads its
    /// slot-epoch then the current inner atom for the address. Behind
    /// `Rc<RefCell<_>>` so the P4c `AtomEvalProvider` can capture a clone and
    /// resolve referenced cells' facades under `&self`. Created lazily.
    /// Wired by read paths and address subscriptions.
    cell_facade_family: Rc<RefCell<AtomFamily<CellAddress>>>,
    /// P4c: per-address formula-INNER derived atoms. Keyed by the anchor
    /// address of a formula cell; each runs the cell's `Expr` through an
    /// `AtomFormulaProvider`, resolving every referenced cell REACTIVELY via
    /// that cell's facade (`FacadeCtx::get_or_create_facade`). The facade for a
    /// formula address delegates to this inner atom, so a subscription anchored
    /// on the facade re-notifies when any read cell's value changes — no
    /// address-level point edge. Created lazily on first read of a formula cell.
    /// Behind `Rc<RefCell<_>>` so `FacadeCtx` shares it into `'static` closures.
    formula_inner_family: Rc<RefCell<AtomFamily<CellAddress>>>,
    /// P5 Tier-B range geometry versions. Large range formulas depend on these
    /// Store roots by geometry; the atoms never name dependent formulas.
    range_band_epoch_family: Rc<RefCell<AtomFamily<RangeBandKey>>>,
    range_column_epoch_family: Rc<RefCell<AtomFamily<RangeColumnKey>>>,
    range_sheet_epoch_family: Rc<RefCell<AtomFamily<()>>>,
    /// P4c: the shared set of addresses whose formula-inner atom is currently
    /// mid-evaluation (on the read stack). The runtime cycle guard (codex F1):
    /// before an `AtomFormulaProvider` calls `args.get` on a referenced cell's
    /// facade, it checks membership here; a hit means the reference closes a
    /// cycle, so it returns a sticky `#CYCLE!` and records the reverse edge via
    /// `ReadArgs::depend` (so a later edit that dissolves the cycle still
    /// re-invalidates). Each inner read_fn inserts its own address on entry and
    /// removes it on exit through an `InFlightGuard` RAII marker. Shared behind
    /// `Rc<RefCell<_>>` so every inner closure and `FacadeCtx` clone see one set.
    in_flight: Rc<RefCell<HashSet<CellAddress>>>,
    /// Optional workbook scope. Standalone sheets leave this empty; workbook
    /// sheets point weakly at the shared topology/name/custom-function roots.
    workbook_context: Rc<RefCell<Option<Weak<WorkbookAtomContext>>>>,
    workbook_sheet_index: Rc<Cell<Option<usize>>>,
    /// Address-level subscriptions. Buckets are only wired to store atoms when
    /// the address has a materialized readable atom, so subscribing to an empty
    /// visible cell does not allocate a cell atom by itself.
    cell_subscriptions: HashMap<CellAddress, AddressSubscriptionBucket>,
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
    /// Cumulative count of completed formula-inner evaluations. Read-only
    /// debug counter used by the Phase 1 scale tests to assert laziness —
    /// `bulk_load` of N formulas
    /// must keep this at 0 until the first `get_cell`. `Cell` so the counter
    /// can be bumped from `&self` (eval runs through the immutable reader).
    formula_eval_count: Rc<Cell<usize>>,
    /// Cumulative count of formulas inserted via `BulkLoader::set_formula`.
    /// Bumped once per successful entry inside `bulk_load`; the plain
    /// `Sheet::set_formula` path does NOT bump this. Used by the scale
    /// suite to verify "imported" vs "live-edited" formula provenance.
    imported_formula_count: Cell<usize>,
    /// Cumulative number of formula-inner addresses discovered through Store
    /// reverse dependencies while mutation code prepares spill/subscriber
    /// maintenance. This remains a complexity probe; it is not a dirty graph.
    reverse_dep_visit_count: Cell<u64>,

    /// Monotonic generation of same-sheet formula AST/source topology. A
    /// formula-content mutation bumps this value, invalidating every embedded
    /// static-cycle certificate in O(1). Hydration itself preserves topology
    /// and therefore transfers the current certificate without a bump.
    formula_topology_epoch: Cell<u64>,
    /// Deterministic complexity probe: number of formula ASTs expanded by the
    /// install-time static cycle analyzer. It excludes Store evaluation.
    static_cycle_node_visit_count: Cell<u64>,

    /// AUDIT B-5 — counts `has_address_subscribers` probes performed by
    /// `BulkLoader::flush`'s notify tail (one per entry of
    /// touched ∪ dirty). With zero address subscriptions the tail
    /// early-outs and this stays untouched — pinned by the scale suite
    /// so a 1M-cell restore never pays millions of hash probes to
    /// conclude nobody is watching.
    bulk_notify_probe_count: Cell<u64>,

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
    /// AUDIT A-8 — reverse spill index: target address →
    /// `(anchor_atom, anchor_address)`. Maintained in lockstep with
    /// `spill_targets` (`register_spill` inserts, `clear_spill` removes,
    /// `bulk_install_storage` teardown clears) so the per-write spill
    /// guards (`spilled_into_anchor`, `is_target_occupied`) are O(1) map
    /// probes instead of a scan over every target list plus a reverse
    /// scan of `cells` — one `=SEQUENCE(100000)` must not make every
    /// keystroke O(100k).
    spill_target_anchor: HashMap<CellAddress, (AtomId, CellAddress)>,
    /// A-8 follow-up (2026-06-13 P3) — anchor atom → anchor address.
    /// Maintained at exactly the same lockstep sites as
    /// `spill_target_anchor` (`register_spill` inserts, `clear_spill`
    /// removes, `bulk_install_storage` teardown clears) so
    /// `anchor_address_for` — called once per active spill by
    /// `teardown_all_spills` on EVERY structural edit — is one map
    /// probe instead of a reverse scan over all of `cells` per anchor.
    /// `spill_target_anchor` alone can't serve this lookup: anchors
    /// with zero targets (1×1 / empty arrays) have no entry there.
    spill_anchor_addr: HashMap<AtomId, CellAddress>,
}

/// Shared facade/formula-inner context: the minimal handles needed to mint and
/// resolve per-address Store atoms without holding `&Sheet`.
///
/// Every field is an owned `Store` clone or `Rc` clone, so a `FacadeCtx` is
/// cheap to `clone()` and satisfies the `'static` bound required to move it
/// into a store `read_fn` closure. That is the unblock for the formula-inner
/// path: the inner read closure captures a `FacadeCtx` clone and calls
/// [`FacadeCtx::get_or_create_facade`] to reactively resolve any OTHER cell a
/// formula references, under a bare `&self` sheet method.
///
/// It maintains `atoms_owned` through the same [`FacadeCtx::owned_create_atom`]
/// / [`FacadeCtx::owned_create_derived_ctx`] doors the sheet uses, so the
/// per-sheet atom count stays exact regardless of which path minted the atom.
#[derive(Clone)]
pub(crate) struct FacadeCtx {
    store: Store,
    atoms_owned: Rc<Cell<usize>>,
    interior: Rc<SheetInterior>,
    slot_epoch_family: Rc<RefCell<AtomFamily<CellAddress>>>,
    cell_facade_family: Rc<RefCell<AtomFamily<CellAddress>>>,
    /// P4c: shared per-address formula-inner atom family — see the field of
    /// the same name on [`Sheet`]. The facade for a formula address delegates
    /// to `formula_inner_of(addr)`.
    formula_inner_family: Rc<RefCell<AtomFamily<CellAddress>>>,
    /// P5 Tier-B geometry atom families — see [`Sheet`].
    range_band_epoch_family: Rc<RefCell<AtomFamily<RangeBandKey>>>,
    range_column_epoch_family: Rc<RefCell<AtomFamily<RangeColumnKey>>>,
    range_sheet_epoch_family: Rc<RefCell<AtomFamily<()>>>,
    /// P4c: shared mid-evaluation address set for the runtime cycle guard
    /// (codex F1) — see the field of the same name on [`Sheet`].
    in_flight: Rc<RefCell<HashSet<CellAddress>>>,
    workbook_context: Rc<RefCell<Option<Weak<WorkbookAtomContext>>>>,
    workbook_sheet_index: Rc<Cell<Option<usize>>>,
    formula_eval_count: Rc<Cell<usize>>,
}

struct WorkbookAtomTopology {
    sheets: Vec<(String, FacadeCtx)>,
    by_name: HashMap<String, usize>,
}

/// Workbook-scoped inputs consumed by formula-inner atoms. The three version
/// atoms are ordinary Store primitives: formulas depend on them only when they
/// read topology, names, or custom functions. Cell/range dependencies still
/// point directly at target facades in the same shared Store.
pub(crate) struct WorkbookAtomContext {
    store: Store,
    topology: RefCell<WorkbookAtomTopology>,
    topology_epoch: RefCell<Option<AtomId>>,
    topology_revision: Cell<u64>,
    names: RefCell<HashMap<String, Value>>,
    names_epoch: RefCell<Option<AtomId>>,
    names_revision: Cell<u64>,
    custom_functions: RefCell<Option<Arc<dyn CustomFunctionRegistry>>>,
    custom_epoch: RefCell<Option<AtomId>>,
    custom_revision: Cell<u64>,
    custom_call_depth: Rc<Cell<usize>>,
    in_flight: Rc<RefCell<HashSet<(usize, CellAddress)>>>,
}

impl WorkbookAtomContext {
    pub(crate) fn new(store: Store, custom_call_depth: Rc<Cell<usize>>) -> Rc<Self> {
        Rc::new(Self {
            store,
            topology: RefCell::new(WorkbookAtomTopology {
                sheets: Vec::new(),
                by_name: HashMap::new(),
            }),
            topology_epoch: RefCell::new(None),
            topology_revision: Cell::new(0),
            names: RefCell::new(HashMap::new()),
            names_epoch: RefCell::new(None),
            names_revision: Cell::new(0),
            custom_functions: RefCell::new(None),
            custom_epoch: RefCell::new(None),
            custom_revision: Cell::new(0),
            custom_call_depth,
            in_flight: Rc::new(RefCell::new(HashSet::new())),
        })
    }

    fn epoch_atom(&self, slot: &RefCell<Option<AtomId>>, revision: u64) -> AtomId {
        if let Some(id) = *slot.borrow() {
            return id;
        }
        let id = self.store.create_atom(Value::Number(revision as f64));
        *slot.borrow_mut() = Some(id);
        id
    }

    fn depend_topology(&self, args: &ReadArgs) {
        let id = self.epoch_atom(&self.topology_epoch, self.topology_revision.get());
        let _ = args.get(id);
    }

    fn depend_names(&self, args: &ReadArgs) {
        let id = self.epoch_atom(&self.names_epoch, self.names_revision.get());
        let _ = args.get(id);
    }

    fn depend_custom(&self, args: &ReadArgs) {
        let id = self.epoch_atom(&self.custom_epoch, self.custom_revision.get());
        let _ = args.get(id);
    }

    fn bump_epoch(&self, slot: &RefCell<Option<AtomId>>, revision: &Cell<u64>) {
        let next = revision.get().wrapping_add(1);
        revision.set(next);
        let id = *slot.borrow();
        if let Some(id) = id {
            self.store.set(id, Value::Number(next as f64));
        }
    }

    pub(crate) fn sync_topology(&self, sheets: Vec<(String, FacadeCtx)>) {
        let by_name = sheets
            .iter()
            .enumerate()
            .map(|(idx, (name, _))| (name.clone(), idx))
            .collect();
        *self.topology.borrow_mut() = WorkbookAtomTopology { sheets, by_name };
        self.bump_epoch(&self.topology_epoch, &self.topology_revision);
    }

    pub(crate) fn sync_names(&self, names: HashMap<String, Value>) {
        *self.names.borrow_mut() = names;
        self.bump_epoch(&self.names_epoch, &self.names_revision);
    }

    pub(crate) fn set_custom_functions(
        &self,
        registry: Option<Arc<dyn CustomFunctionRegistry>>,
        invalidate: bool,
    ) {
        *self.custom_functions.borrow_mut() = registry;
        if invalidate {
            self.bump_epoch(&self.custom_epoch, &self.custom_revision);
        }
    }

    fn resolve_sheet(&self, name: &str, args: &ReadArgs) -> Option<(usize, FacadeCtx)> {
        self.depend_topology(args);
        let topology = self.topology.borrow();
        let idx = topology.by_name.get(name).copied()?;
        Some((idx, topology.sheets.get(idx)?.1.clone()))
    }

    fn sheet_count(&self, args: &ReadArgs) -> usize {
        self.depend_topology(args);
        self.topology.borrow().sheets.len()
    }

    fn lookup_named(&self, name: &str, args: &ReadArgs) -> Option<Value> {
        self.depend_names(args);
        self.names.borrow().get(&name.to_ascii_uppercase()).cloned()
    }

    fn call_custom(&self, name: &str, values: &[Value], args: &ReadArgs) -> Option<Value> {
        self.depend_custom(args);
        let registry = self.custom_functions.borrow().clone()?;
        if args.is_faulted() {
            return Some(Value::Null);
        }
        let _scope = crate::workbook::CustomCallScope::enter(&self.custom_call_depth);
        registry.lookup(name, values)
    }
}

impl FacadeCtx {
    fn workbook_scope(&self) -> Option<(Rc<WorkbookAtomContext>, usize)> {
        let context = self
            .workbook_context
            .borrow()
            .as_ref()
            .and_then(Weak::upgrade)?;
        Some((context, self.workbook_sheet_index.get()?))
    }

    fn is_in_flight(&self, addr: CellAddress) -> bool {
        if let Some((context, sheet_idx)) = self.workbook_scope() {
            return context.in_flight.borrow().contains(&(sheet_idx, addr));
        }
        self.in_flight.borrow().contains(&addr)
    }

    /// `owned_create_atom` mirror — keeps `atoms_owned` exact from within a
    /// `'static` closure that has no `&Sheet`.
    fn owned_create_atom(&self, value: Value) -> AtomId {
        self.atoms_owned.set(self.atoms_owned.get() + 1);
        self.store.create_atom(value)
    }

    /// `owned_create_derived_ctx` mirror (lazy — computes nothing until first
    /// read, INV-7).
    fn owned_create_derived_ctx(&self, read_fn: impl Fn(&ReadArgs) -> Value + 'static) -> AtomId {
        self.atoms_owned.set(self.atoms_owned.get() + 1);
        self.store.create_derived_ctx(read_fn)
    }

    /// The lazy slot-epoch primitive for an address (one per address). Bumped
    /// whenever the inner atom identity changes so the facade re-derives off a
    /// swap. Created on demand.
    fn epoch_of(&self, addr: CellAddress) -> AtomId {
        self.slot_epoch_family
            .borrow_mut()
            .get_or_create(addr, || self.owned_create_atom(Value::Null))
    }

    /// Idempotent per-address facade derived atom — see [`Sheet::facade_of`]
    /// for the contract. Returns the cached facade if one exists, else lazily
    /// creates the slot-epoch primitive and the facade derived atom.
    ///
    /// BORROW RULE (D7): every family guard and the `interior.cells` borrow
    /// inside the read closure is released (inner id copied / plain value
    /// cloned) before any `store.*` call. The read closure captures only owned
    /// values / `Rc` clones — never `&self` — so it satisfies the `'static`
    /// bound and can resolve the inner atom on demand.
    fn get_or_create_facade(&self, addr: CellAddress) -> AtomId {
        enum InnerSlot {
            Atom(AtomId),
            Plain(Value),
            Absent,
        }
        // Fast path: already built. Bind so the `borrow()` guard drops here.
        let existing = self.cell_facade_family.borrow().get(&addr);
        if let Some(id) = existing {
            return id;
        }
        let epoch_id = self.epoch_of(addr);
        // Facade derived atom. Capture by value / `Rc` clone so the closure
        // resolves the current inner atom without borrowing the sheet.
        let interior = Rc::clone(&self.interior);
        let store = self.store.clone();
        let ctx = self.clone();
        self.cell_facade_family
            .borrow_mut()
            .get_or_create(addr, || {
                self.owned_create_derived_ctx(move |args| {
                    // Tracked: an epoch bump (inner-atom identity change) re-runs us.
                    let _ = args.get(epoch_id);
                    // Every formula delegates to its formula-inner atom. Workbook
                    // scope, when present, is consumed by that atom's provider;
                    // there is no eager/cached cross-sheet side path.
                    if ctx.formula_expr_for(addr).is_some() {
                        let inner = ctx.formula_inner_of(addr);
                        let formula_value = args.get(inner);

                        // Array formulas mirror their current spill outcome in
                        // the anchor atom. Depend on that Store atom as a
                        // structural projection: it holds either the installed
                        // Array or #SPILL!, while the formula-inner above
                        // remains the formula value/dependency authority.
                        let spill_anchor = {
                            let cells = interior.cells.borrow();
                            match cells.get(&addr) {
                                Some(CellSlot::Atom(id)) => Some(*id),
                                Some(CellSlot::Plain(_)) | None => None,
                            }
                        };
                        return match spill_anchor {
                            Some(id) if store.has_atom(id) => args.get(id),
                            _ => formula_value,
                        };
                    }
                    // Snapshot the current inner under a short borrow, then release.
                    let inner = {
                        let cells = interior.cells.borrow();
                        match cells.get(&addr) {
                            Some(CellSlot::Atom(id)) => InnerSlot::Atom(*id),
                            Some(CellSlot::Plain(v)) => InnerSlot::Plain(v.clone()),
                            None => InnerSlot::Absent,
                        }
                    };
                    match inner {
                        // Guard the defensive "atom destroyed under the slot" case
                        // (mirrors `cell_value_at`): `args.get` panics on a missing
                        // dep atom, so probe existence first.
                        InnerSlot::Atom(id) if store.has_atom(id) => args.get(id),
                        InnerSlot::Atom(_) => Value::Null,
                        InnerSlot::Plain(v) => v,
                        InnerSlot::Absent => Value::Null,
                    }
                })
            })
    }

    /// Resolve `addr`'s formula AST without a `&Sheet`. Prefers the hydrated
    /// `formula_exprs` entry; falls back to parsing `formula_source` on
    /// demand, because `hydrate_formula` DRAINS `formula_source` into
    /// `formula_exprs` — so a hydrated formula lives only in the former and an
    /// unhydrated one only in the latter (codex F2). A parse failure maps to
    /// the same `Expr::Error(InvalidValue)` sentinel the eager hydrator
    /// installs, so a malformed formula reads as `#VALUE!` rather than trapping
    /// the reader.
    fn formula_expr_for(&self, addr: CellAddress) -> Option<Rc<Expr>> {
        if let Some(expr) = self.interior.formula_exprs.borrow().get(&addr) {
            return Some(Rc::clone(expr));
        }
        let source = self.interior.formula_source.borrow().get(&addr).cloned()?;
        let expr =
            parse_formula(source.source.as_ref()).unwrap_or(Expr::Error(ValueError::InvalidValue));
        Some(Rc::new(expr))
    }

    /// The per-address formula-inner derived atom (lazy, one per formula
    /// address). Its read closure re-evaluates the formula under an on-stack
    /// [`AtomFormulaProvider`], re-recording its dependency edges on every run
    /// (vanilla `dependenciesChange` parity). It depends only on the cells the
    /// formula actually reads — no address→formula index.
    fn formula_inner_of(&self, addr: CellAddress) -> AtomId {
        let existing = self.formula_inner_family.borrow().get(&addr);
        if let Some(id) = existing {
            return id;
        }
        let ctx = self.clone();
        self.formula_inner_family
            .borrow_mut()
            .get_or_create(addr, move || {
                let ctx_read = ctx.clone();
                ctx.owned_create_derived_ctx(move |args| ctx_read.eval_formula_inner(addr, args))
            })
    }

    fn range_band_epoch_of(&self, key: RangeBandKey) -> AtomId {
        self.range_band_epoch_family
            .borrow_mut()
            .get_or_create(key, || self.owned_create_atom(Value::Null))
    }

    fn range_column_epoch_of(&self, key: RangeColumnKey) -> AtomId {
        self.range_column_epoch_family
            .borrow_mut()
            .get_or_create(key, || self.owned_create_atom(Value::Null))
    }

    fn range_sheet_epoch(&self) -> AtomId {
        self.range_sheet_epoch_family
            .borrow_mut()
            .get_or_create((), || self.owned_create_atom(Value::Null))
    }

    fn depend_range_geometry_epochs(&self, range: CellRange, args: &ReadArgs) {
        let range = range.normalize();
        if range_cell_count_u64(range) <= RANGE_TIER_A_CELL_LIMIT {
            return;
        }

        let bounds = range_geometry_bounds(range);

        if range_band_count_u64(range) <= RANGE_BAND_DEP_LIMIT {
            let start_band = range_row_band(bounds.start_row);
            let end_band = range_row_band(bounds.end_row);
            for col in bounds.start_col..=bounds.end_col {
                for row_band in start_band..=end_band {
                    args.depend(self.range_band_epoch_of(RangeBandKey { col, row_band }));
                }
            }
            return;
        }

        let cols = inclusive_span_u64(bounds.start_col, bounds.end_col);
        if cols <= RANGE_COLUMN_DEP_LIMIT {
            for col in bounds.start_col..=bounds.end_col {
                args.depend(self.range_column_epoch_of(RangeColumnKey { col }));
            }
            return;
        }

        args.depend(self.range_sheet_epoch());
    }

    /// Formula-inner read body: evaluate `addr`'s formula under an on-stack
    /// [`AtomFormulaProvider`] whose ref/range lookups resolve through the
    /// facade family, so every cell the formula reads becomes a store
    /// dependency edge on THIS inner atom. The runtime cycle guard (codex F1)
    /// is armed by pushing `addr` onto the shared `in_flight` set via
    /// [`InFlightGuard`] for the duration of the eval.
    fn eval_formula_inner(&self, addr: CellAddress, args: &ReadArgs) -> Value {
        let expr = match self.formula_expr_for(addr) {
            Some(expr) => expr,
            // No AST resolvable (address is no longer a formula) — behave like
            // an empty cell rather than trapping the reader.
            None => return Value::Null,
        };
        let _guard = InFlightGuard::enter(self, addr);
        let provider = AtomFormulaProvider {
            args,
            ctx: self.clone(),
            current_cell: Cell::new(Some(addr)),
        };
        let value = normalize_formula_cell_result(eval_expr_with_provider(&expr, &provider));
        self.formula_eval_count
            .set(self.formula_eval_count.get() + 1);
        value
    }

    /// Row-major snapshot of the addresses inside `range` carrying a primitive
    /// or formula value — the `&Sheet`-free twin of
    /// [`Sheet::for_each_sparse_cell_with`]'s address collection. All `interior`
    /// borrows drop before returning, so the caller can read facades
    /// reactively without holding a borrow across a `store` read (D7).
    /// Tier-A ranges track every member facade; larger ranges track geometry
    /// epochs and use this sparse snapshot only for current values.
    fn range_member_addrs(&self, range: CellRange) -> Vec<CellAddress> {
        // Primitives first (skipping formula-shadowed addresses), matching
        // `for_each_sparse_cell_with`'s emission order.
        let primitive_addrs: Vec<CellAddress> = {
            let cells = self.interior.cells.borrow();
            cells
                .range_iter(range)
                .map(|(addr, _)| addr)
                .filter(|addr| {
                    !self.interior.formula_cells.borrow().contains_key(addr)
                        && !self.interior.formula_source.borrow().contains_key(addr)
                })
                .collect()
        };
        let mut out: Vec<CellAddress> = primitive_addrs
            .into_iter()
            .filter(|addr| self.primitive_slot_has_visible_value(*addr))
            .collect();
        // Then the row-major union of hydrated formula cells + unhydrated
        // formula source (a formula is in exactly one of the two).
        let cells = self.interior.formula_cells.borrow();
        let source = self.interior.formula_source.borrow();
        let mut a = cells.range_iter(range).map(|(addr, _)| addr).peekable();
        let mut b = source.range_iter(range).map(|(addr, _)| addr).peekable();
        loop {
            match (a.peek().copied(), b.peek().copied()) {
                (None, None) => break,
                (Some(x), None) => {
                    out.push(x);
                    a.next();
                }
                (None, Some(y)) => {
                    out.push(y);
                    b.next();
                }
                (Some(x), Some(y)) => {
                    let (xk, yk) = ((x.row, x.col), (y.row, y.col));
                    if xk == yk {
                        out.push(x);
                        a.next();
                        b.next();
                    } else if xk < yk {
                        out.push(x);
                        a.next();
                    } else {
                        out.push(y);
                        b.next();
                    }
                }
            }
        }
        out
    }

    /// Primitive Null atoms may remain alive as Store dependency anchors after
    /// a clear. They are internal state, not sparse worksheet members.
    fn primitive_slot_has_visible_value(&self, addr: CellAddress) -> bool {
        let probe: Result<Value, AtomId> = {
            let cells = self.interior.cells.borrow();
            match cells.get(&addr) {
                Some(CellSlot::Plain(value)) => Ok(value.clone()),
                Some(CellSlot::Atom(id)) => Err(*id),
                None => return false,
            }
        };
        let value = match probe {
            Ok(value) => value,
            Err(id) if self.store.has_atom(id) => self.store.get(id),
            Err(_) => Value::Null,
        };
        !matches!(value, Value::Null)
    }
}

/// RAII marker for the runtime cycle guard (codex F1). While a formula-inner
/// read_fn is executing, its address sits in the shared `in_flight` set; a
/// referenced cell that is already in-flight is a runtime cycle and reads back
/// `#CYCLE!` (see [`AtomFormulaProvider::read_facade`]). The guard removes the
/// address on drop — but ONLY if it was the one that inserted it, so a
/// re-entrant read of the same address (which cannot happen under the store's
/// computing-guard, but is cheap to be correct about) never clears a peer's
/// membership.
enum InFlightSet {
    Local(Rc<RefCell<HashSet<CellAddress>>>),
    Workbook(Rc<WorkbookAtomContext>, usize),
}

struct InFlightGuard {
    set: InFlightSet,
    addr: CellAddress,
    inserted: bool,
}

impl InFlightGuard {
    fn enter(ctx: &FacadeCtx, addr: CellAddress) -> Self {
        let (set, inserted) = if let Some((context, sheet_idx)) = ctx.workbook_scope() {
            let inserted = context.in_flight.borrow_mut().insert((sheet_idx, addr));
            (InFlightSet::Workbook(context, sheet_idx), inserted)
        } else {
            let set = Rc::clone(&ctx.in_flight);
            let inserted = set.borrow_mut().insert(addr);
            (InFlightSet::Local(set), inserted)
        };
        InFlightGuard {
            set,
            addr,
            inserted,
        }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if self.inserted {
            match &self.set {
                InFlightSet::Local(set) => {
                    set.borrow_mut().remove(&self.addr);
                }
                InFlightSet::Workbook(context, sheet_idx) => {
                    context
                        .in_flight
                        .borrow_mut()
                        .remove(&(*sheet_idx, self.addr));
                }
            }
        }
    }
}

/// On-stack [`EvalProvider`] for a formula-inner read_fn (P4c). Every cell /
/// range lookup resolves through the facade family and is issued as a tracked
/// `ReadArgs::get`, so the enclosing formula-inner atom's dependency edges are
/// exactly the cells the formula reads — the store's `dependenciesMap` is the
/// single response graph (INV-2), no address→formula index. Mirrors
/// [`SheetEvalProvider`]'s method bodies, but reads go through `read_facade`
/// instead of `Sheet::peek_value_with_provider`.
///
/// Lifetimes: `'a` is the borrow of the live [`ReadArgs`] handed to the
/// read_fn; `'r` is that `ReadArgs`'s own store-inner borrow.
struct AtomFormulaProvider<'a, 'r> {
    args: &'a ReadArgs<'r>,
    ctx: FacadeCtx,
    /// Cell currently being evaluated (for no-arg `ROW()` / `COLUMN()`), seeded
    /// to the formula's own address and moved by `set_current_cell` under the
    /// eval's save/restore guard.
    current_cell: Cell<Option<CellAddress>>,
}

impl<'a, 'r> AtomFormulaProvider<'a, 'r> {
    /// Read a referenced cell through its facade as a tracked store dependency,
    /// arming the runtime cycle guard (codex F1): if `addr` is already
    /// mid-evaluation (present in the shared `in_flight` set), reading its
    /// facade would trip the store's computing-panic, so instead record the
    /// re-invalidating edge without reading (`ReadArgs::depend`) and surface a
    /// sticky `#CYCLE!`. A later edit that breaks the cycle bumps the depended
    /// atom's generation and re-derives this reader (see the `depend` primitive
    /// tests).
    fn read_facade_from(&self, ctx: &FacadeCtx, addr: CellAddress) -> Value {
        let facade = ctx.get_or_create_facade(addr);
        if ctx.is_in_flight(addr) {
            self.args.depend(facade);
            return Value::Error(ValueError::CyclicRef);
        }
        self.args.get(facade)
    }

    fn read_facade(&self, addr: CellAddress) -> Value {
        self.read_facade_from(&self.ctx, addr)
    }

    fn workbook_context(&self) -> Option<Rc<WorkbookAtomContext>> {
        self.ctx.workbook_scope().map(|(context, _)| context)
    }

    fn resolve_sheet(&self, name: &str) -> Option<(usize, FacadeCtx)> {
        self.workbook_context()?.resolve_sheet(name, self.args)
    }

    fn for_each_range_in(
        &self,
        ctx: &FacadeCtx,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        ctx.depend_range_geometry_epochs(range, self.args);
        let member_addrs = ctx.range_member_addrs(range);
        if range_cell_count_u64(range) <= RANGE_TIER_A_CELL_LIMIT {
            let members: HashSet<CellAddress> = member_addrs.iter().copied().collect();
            for addr in range.normalize().iter() {
                if !members.contains(&addr) {
                    let _ = self.read_facade_from(ctx, addr);
                }
            }
        }
        for addr in member_addrs {
            let value = collapse_array_for_eval(self.read_facade_from(ctx, addr));
            f(addr, value);
        }
    }

    fn formula_text_in(ctx: &FacadeCtx, addr: CellAddress) -> Option<String> {
        if let Some(text) = ctx.interior.formula_texts.borrow().get(&addr) {
            return Some(text.clone());
        }
        ctx.interior
            .formula_source
            .borrow()
            .get(&addr)
            .map(|source| source.source.as_ref().to_string())
    }
}

impl<'a, 'r> EvalProvider for AtomFormulaProvider<'a, 'r> {
    fn cell(&self, addr: CellAddress) -> Value {
        collapse_array_for_eval(self.read_facade(addr))
    }

    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some((_, ctx)) = self.resolve_sheet(sheet) else {
            return Value::Error(ValueError::InvalidRef);
        };
        collapse_array_for_eval(self.read_facade_from(&ctx, addr))
    }

    fn raw_cell(&self, addr: CellAddress) -> Value {
        self.read_facade(addr)
    }

    fn raw_sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some((_, ctx)) = self.resolve_sheet(sheet) else {
            return Value::Error(ValueError::InvalidRef);
        };
        self.read_facade_from(&ctx, addr)
    }

    /// Store-shaped range read: Tier A per-member facades for small ranges and
    /// Tier B geometry epoch atoms for larger ranges. The evaluator callback
    /// remains sparse: empty cells are only read for dependency edges and are
    /// not emitted.
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
        self.for_each_range_in(&self.ctx, range, f);
    }

    fn for_each_sheet_range_cell(
        &self,
        sheet: &str,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        let Some((_, ctx)) = self.resolve_sheet(sheet) else {
            f(
                range.normalize().start,
                Value::Error(ValueError::InvalidRef),
            );
            return;
        };
        self.for_each_range_in(&ctx, range, f);
    }

    fn current_cell(&self) -> Option<CellAddress> {
        self.current_cell.get()
    }

    fn set_current_cell(&self, addr: Option<CellAddress>) {
        self.current_cell.set(addr);
    }

    fn cell_has_formula(&self, addr: CellAddress) -> bool {
        self.ctx.interior.formula_cells.borrow().contains_key(&addr)
            || self.ctx.interior.needs_parse.borrow().contains(&addr)
    }

    fn sheet_cell_has_formula(&self, sheet: &str, addr: CellAddress) -> bool {
        let Some((_, ctx)) = self.resolve_sheet(sheet) else {
            return false;
        };
        ctx.interior.formula_cells.borrow().contains_key(&addr)
            || ctx.interior.needs_parse.borrow().contains(&addr)
    }

    fn lookup_named(&self, name: &str) -> Option<Value> {
        self.workbook_context()?.lookup_named(name, self.args)
    }

    fn current_sheet_index(&self) -> Option<usize> {
        let (context, sheet_idx) = self.ctx.workbook_scope()?;
        context.depend_topology(self.args);
        Some(sheet_idx)
    }

    fn sheet_index_of(&self, name: &str) -> Option<usize> {
        self.resolve_sheet(name).map(|(idx, _)| idx)
    }

    fn sheet_count(&self) -> usize {
        self.workbook_context()
            .map(|context| context.sheet_count(self.args))
            .unwrap_or(1)
    }

    fn cell_formula_text(&self, addr: CellAddress) -> Option<String> {
        Self::formula_text_in(&self.ctx, addr)
    }

    fn sheet_cell_formula_text(&self, sheet: &str, addr: CellAddress) -> Option<String> {
        let (_, ctx) = self.resolve_sheet(sheet)?;
        Self::formula_text_in(&ctx, addr)
    }

    fn call_custom(&self, name: &str, values: &[Value]) -> Option<Value> {
        self.workbook_context()?
            .call_custom(name, values, self.args)
    }
}

impl Sheet {
    pub fn new() -> Self {
        Self::with_store(Store::new())
    }

    /// Construct a sheet bound to a SHARED store (P3 of the atom-delegation
    /// rewrite): `Workbook` hands every sheet a clone of its single store so
    /// cross-sheet dependencies are ordinary in-store edges (P6).
    /// `Store` is a cheap Rc handle — cloning shares state, exactly like
    /// passing the vanilla store object around. Standalone sheets
    /// (`Sheet::new`) keep a private store.
    pub fn with_store(store: Store) -> Self {
        Sheet {
            store,
            atoms_owned: Rc::new(Cell::new(0)),
            interior: Rc::new(SheetInterior {
                cells: RefCell::new(RowMajorMap::new()),
                formula_cells: RefCell::new(RowMajorMap::new()),
                formula_exprs: RefCell::new(HashMap::new()),
                formula_texts: RefCell::new(HashMap::new()),
                formula_source: RefCell::new(RowMajorMap::new()),
                needs_parse: RefCell::new(HashSet::new()),
            }),
            slot_epoch_family: Rc::new(RefCell::new(AtomFamily::new())),
            cell_facade_family: Rc::new(RefCell::new(AtomFamily::new())),
            formula_inner_family: Rc::new(RefCell::new(AtomFamily::new())),
            range_band_epoch_family: Rc::new(RefCell::new(AtomFamily::new())),
            range_column_epoch_family: Rc::new(RefCell::new(AtomFamily::new())),
            range_sheet_epoch_family: Rc::new(RefCell::new(AtomFamily::new())),
            in_flight: Rc::new(RefCell::new(HashSet::new())),
            workbook_context: Rc::new(RefCell::new(None)),
            workbook_sheet_index: Rc::new(Cell::new(None)),
            cell_subscriptions: HashMap::new(),
            next_cell_sub_id: 0,
            formats: HashMap::new(),
            range_formats: Vec::new(),
            conditional_rules: Vec::new(),
            row_heights: BTreeMap::new(),
            col_widths: BTreeMap::new(),
            formula_eval_count: Rc::new(Cell::new(0)),
            imported_formula_count: Cell::new(0),
            reverse_dep_visit_count: Cell::new(0),
            formula_topology_epoch: Cell::new(1),
            static_cycle_node_visit_count: Cell::new(0),
            spill_targets: HashMap::new(),
            spill_target_anchor: HashMap::new(),
            spill_anchor_addr: HashMap::new(),
            bulk_notify_probe_count: Cell::new(0),
        }
    }

    pub(crate) fn attach_workbook_context(
        &self,
        context: &Rc<WorkbookAtomContext>,
        sheet_index: usize,
    ) {
        *self.workbook_context.borrow_mut() = Some(Rc::downgrade(context));
        self.workbook_sheet_index.set(Some(sheet_index));
    }

    pub(crate) fn detach_workbook_context(&self) {
        *self.workbook_context.borrow_mut() = None;
        self.workbook_sheet_index.set(None);
        let ids: Vec<AtomId> = self
            .formula_inner_family
            .borrow()
            .iter()
            .map(|(_, id)| id)
            .collect();
        for id in ids {
            if self.store.has_atom(id) {
                self.store.invalidate(id);
            }
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
    ///
    /// AUDIT B-2: this is the single atomization point. A `Plain` slot
    /// (lazily-installed bulk value) is promoted here — the parked value
    /// moves into a freshly-created store atom, preserving the value
    /// exactly so the downstream `store.set` equality dedup behaves as if
    /// the atom had existed all along.
    /// The ONLY create/destroy doors to the store for this sheet — they keep
    /// `atoms_owned` exact so per-sheet probes survive the P3 shared store.
    pub(crate) fn owned_create_atom(&self, value: Value) -> AtomId {
        self.atoms_owned.set(self.atoms_owned.get() + 1);
        self.store.create_atom(value)
    }

    pub(crate) fn owned_create_derived(
        &self,
        read_fn: impl Fn(&dyn Fn(AtomId) -> Value) -> Value + 'static,
    ) -> AtomId {
        self.atoms_owned.set(self.atoms_owned.get() + 1);
        self.store.create_derived(read_fn)
    }

    pub(crate) fn owned_destroy_atom(&self, id: AtomId) {
        if self.store.has_atom(id) {
            self.store.destroy_atom(id);
            self.atoms_owned.set(self.atoms_owned.get() - 1);
        }
    }

    fn evict_owned_family_key<K>(&self, family: &Rc<RefCell<AtomFamily<K>>>, key: &K) -> bool
    where
        K: Eq + Hash + Clone,
    {
        if !family.borrow_mut().evict(&self.store, key) {
            return false;
        }
        self.atoms_owned.set(
            self.atoms_owned
                .get()
                .checked_sub(1)
                .expect("sheet family eviction underflow"),
        );
        true
    }

    /// Release Store dependency roots after their last formula-inner reader
    /// disappears. Evicting a formula facade can unmount its own inner, so
    /// continue iteratively through that inner's Store-recorded dependencies.
    /// AtomFamily refuses every node that still has a dependent/subscriber;
    /// this method never reconstructs or owns a parallel dependency graph.
    fn try_evict_formula_dependency_atoms(&self, roots: impl IntoIterator<Item = AtomId>) {
        let mut pending: HashSet<AtomId> = roots.into_iter().collect();
        while !pending.is_empty() {
            let before = self.atoms_owned.get();
            let current: Vec<AtomId> = pending.drain().collect();

            for id in current {
                let cell_addr = { self.cell_facade_family.borrow().key_of(id).copied() };
                if let Some(addr) = cell_addr {
                    if self.evict_owned_family_key(&self.cell_facade_family, &addr) {
                        self.evict_owned_family_key(&self.slot_epoch_family, &addr);

                        let inner_id = { self.formula_inner_family.borrow().get(&addr) };
                        if let Some(inner_id) = inner_id {
                            let dependencies = self.store.direct_dependencies(inner_id);
                            if self.evict_owned_family_key(&self.formula_inner_family, &addr) {
                                pending.extend(dependencies);
                            }
                        }
                    } else {
                        // Another candidate in this pass may still own the
                        // final Store edge. Retry after that candidate peels.
                        pending.insert(id);
                    }
                    continue;
                }

                let band_key = { self.range_band_epoch_family.borrow().key_of(id).copied() };
                if let Some(key) = band_key {
                    if !self.evict_owned_family_key(&self.range_band_epoch_family, &key) {
                        pending.insert(id);
                    }
                    continue;
                }

                let column_key = { self.range_column_epoch_family.borrow().key_of(id).copied() };
                if let Some(key) = column_key {
                    if !self.evict_owned_family_key(&self.range_column_epoch_family, &key) {
                        pending.insert(id);
                    }
                    continue;
                }

                if self.range_sheet_epoch_family.borrow().key_of(id).is_some()
                    && !self.evict_owned_family_key(&self.range_sheet_epoch_family, &())
                {
                    pending.insert(id);
                }
            }

            // No Store node was released, so every remaining candidate is
            // still externally live and another pass cannot make progress.
            if self.atoms_owned.get() == before {
                return;
            }
        }
    }

    /// Reclaim the atomm nodes that existed solely to evaluate a formula that
    /// no longer owns `addr`. The direct dependency snapshot comes from Store;
    /// no sheet-local dependency graph is reconstructed here.
    fn cleanup_obsolete_formula_atoms_at(&self, addr: CellAddress) {
        if self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.formula_source.borrow().contains_key(&addr)
        {
            return;
        }

        let inner_id = { self.formula_inner_family.borrow().get(&addr) };
        let dependencies = inner_id
            .map(|id| self.store.direct_dependencies(id))
            .unwrap_or_default();

        // A leaf formula facade can go first, severing its edge to the inner.
        // A facade still read by another formula/subscriber stays; the write's
        // epoch bump has already retargeted it away from the obsolete inner.
        self.evict_owned_family_key(&self.cell_facade_family, &addr);
        if inner_id.is_some() {
            self.evict_owned_family_key(&self.formula_inner_family, &addr);
        }

        if self.formula_inner_family.borrow().get(&addr).is_none() {
            self.try_evict_formula_dependency_atoms(dependencies);
        }
        self.evict_owned_family_key(&self.slot_epoch_family, &addr);
    }

    /// Structural edits can leave old address keys behind after storage has
    /// moved. Peel obsolete formula components until no further Store-safe
    /// family eviction is possible (chains may require more than one pass).
    fn prune_obsolete_formula_atoms(&self) {
        loop {
            let keys: Vec<CellAddress> = self
                .formula_inner_family
                .borrow()
                .iter()
                .map(|(addr, _)| *addr)
                .filter(|addr| {
                    !self.interior.formula_cells.borrow().contains_key(addr)
                        && !self.interior.formula_source.borrow().contains_key(addr)
                })
                .collect();
            if keys.is_empty() {
                return;
            }
            let before = self.atoms_owned.get();
            for addr in keys {
                self.cleanup_obsolete_formula_atoms_at(addr);
            }
            if self.atoms_owned.get() == before {
                return;
            }
        }
    }

    /// Full-sheet replacement temporarily has no live sheet content, so every
    /// removable family node is old-world state. Fixed-point peeling follows
    /// Store's actual edges and preserves any facade still read externally.
    fn prune_all_family_atoms(&self) {
        loop {
            let before = self.atoms_owned.get();

            let facade_keys: Vec<CellAddress> = self
                .cell_facade_family
                .borrow()
                .iter()
                .map(|(key, _)| *key)
                .collect();
            for key in facade_keys {
                self.evict_owned_family_key(&self.cell_facade_family, &key);
            }

            let inner_keys: Vec<CellAddress> = self
                .formula_inner_family
                .borrow()
                .iter()
                .map(|(key, _)| *key)
                .collect();
            for key in inner_keys {
                self.evict_owned_family_key(&self.formula_inner_family, &key);
            }

            let epoch_keys: Vec<CellAddress> = self
                .slot_epoch_family
                .borrow()
                .iter()
                .map(|(key, _)| *key)
                .collect();
            for key in epoch_keys {
                self.evict_owned_family_key(&self.slot_epoch_family, &key);
            }

            let band_keys: Vec<RangeBandKey> = self
                .range_band_epoch_family
                .borrow()
                .iter()
                .map(|(key, _)| *key)
                .collect();
            for key in band_keys {
                self.evict_owned_family_key(&self.range_band_epoch_family, &key);
            }

            let column_keys: Vec<RangeColumnKey> = self
                .range_column_epoch_family
                .borrow()
                .iter()
                .map(|(key, _)| *key)
                .collect();
            for key in column_keys {
                self.evict_owned_family_key(&self.range_column_epoch_family, &key);
            }

            self.evict_owned_family_key(&self.range_sheet_epoch_family, &());

            if self.atoms_owned.get() == before {
                return;
            }
        }
    }

    fn destroy_retired_atoms(&self, ids: Vec<AtomId>) {
        let mut pending: HashSet<AtomId> = ids.into_iter().collect();
        loop {
            let before = pending.len();
            pending.retain(|id| {
                if !self.store.has_atom(*id) {
                    return false;
                }
                if self.store.has_dependents(*id) || self.store.has_subscribers(*id) {
                    return true;
                }
                self.owned_destroy_atom(*id);
                false
            });
            if pending.is_empty() || pending.len() == before {
                break;
            }
        }
        debug_assert!(
            pending.is_empty(),
            "full sheet replacement retained {} old cell atom(s)",
            pending.len()
        );
    }

    /// The per-address facade derived atom: the stable subscription anchor
    /// for all address listeners. Idempotent: returns the cached facade if one
    /// exists, else lazily creates the slot-epoch primitive and the facade
    /// derived atom.
    ///
    /// The facade reads its slot-epoch (tracked — a `literal↔formula` overwrite
    /// or clear that bumps the epoch re-runs the facade WITHOUT re-keying any
    /// subscription) then the CURRENT inner atom for the address. Only the
    /// BORROW RULE (D7): every family guard and the `interior.cells` borrow
    /// inside the read closure is released (inner id copied / plain value
    /// cloned) before any `store.*` call. The read closure captures only owned
    /// values / `Rc` clones — never `self` — so it satisfies the `'static`
    /// bound and can resolve the inner atom on demand under `&self`.
    ///
    /// This is a thin wrapper over [`FacadeCtx::get_or_create_facade`]: the
    /// facade logic lives on the `'static`-capturable [`FacadeCtx`] so the
    /// forthcoming inner formula read closure can resolve referenced cells'
    /// facades on demand without an `&Sheet`.
    fn facade_of(&self, addr: CellAddress) -> AtomId {
        self.facade_ctx().get_or_create_facade(addr)
    }

    /// Build a [`FacadeCtx`] snapshot of this sheet's shared handles. Cheap —
    /// clones a `Store` handle and four `Rc`s. The returned ctx is `'static`
    /// and `Clone`, so it can be moved into store `read_fn` closures.
    pub(crate) fn facade_ctx(&self) -> FacadeCtx {
        FacadeCtx {
            store: self.store.clone(),
            atoms_owned: Rc::clone(&self.atoms_owned),
            interior: Rc::clone(&self.interior),
            slot_epoch_family: Rc::clone(&self.slot_epoch_family),
            cell_facade_family: Rc::clone(&self.cell_facade_family),
            formula_inner_family: Rc::clone(&self.formula_inner_family),
            range_band_epoch_family: Rc::clone(&self.range_band_epoch_family),
            range_column_epoch_family: Rc::clone(&self.range_column_epoch_family),
            range_sheet_epoch_family: Rc::clone(&self.range_sheet_epoch_family),
            in_flight: Rc::clone(&self.in_flight),
            workbook_context: Rc::clone(&self.workbook_context),
            workbook_sheet_index: Rc::clone(&self.workbook_sheet_index),
            formula_eval_count: Rc::clone(&self.formula_eval_count),
        }
    }

    /// P4c write口 helper — bump this address's slot-epoch primitive so a
    /// materialized facade re-derives after an inner-atom IDENTITY change
    /// (formula↔literal, Plain/Absent→Atom, slot removal Atom→None). A
    /// same-id literal value update needs NO bump: the facade re-runs off its
    /// native `args.get(inner)` edge when `store.set(inner, ..)` flushes.
    ///
    /// NON-CREATING (INV-7): if no epoch atom exists for `addr`, no facade was
    /// ever materialized here, so there is nothing to notify — early return.
    /// The value is a MONOTONE counter (never re-set to an equal value) so the
    /// store's equal-value short-circuit can't swallow the bump and an ABA
    /// within one batch still forces re-derivation.
    ///
    fn bump_facade_epoch(&self, addr: CellAddress) {
        let Some(epoch_id) = self.slot_epoch_family.borrow().get(&addr) else {
            return;
        };
        let next = match self.store.get(epoch_id) {
            Value::Number(n) => Value::Number(n + 1.0),
            _ => Value::Number(1.0),
        };
        self.store.set(epoch_id, next);
    }

    fn bump_existing_epoch(&self, id: AtomId) {
        let next = match self.store.get(id) {
            Value::Number(n) => Value::Number(n + 1.0),
            _ => Value::Number(1.0),
        };
        self.store.set(id, next);
    }

    fn bump_range_geometry_epochs_touching(&self, addr: CellAddress) {
        let band_key = range_band_key_for_addr(addr);
        let band_id = { self.range_band_epoch_family.borrow().get(&band_key) };
        if let Some(id) = band_id {
            self.bump_existing_epoch(id);
        }

        let column_key = RangeColumnKey { col: addr.col };
        let column_id = { self.range_column_epoch_family.borrow().get(&column_key) };
        if let Some(id) = column_id {
            self.bump_existing_epoch(id);
        }

        let sheet_id = { self.range_sheet_epoch_family.borrow().get(&()) };
        if let Some(id) = sheet_id {
            self.bump_existing_epoch(id);
        }
    }

    fn bump_range_membership_epochs_touching(&self, addr: CellAddress) {
        self.bump_range_geometry_epochs_touching(addr);
    }

    /// Sparse range membership matches `range_member_addrs`: a non-Null
    /// primitive value or formula/source record exists at the address. A Null
    /// primitive atom retained by Store dependents remains an internal anchor,
    /// not a worksheet member.
    fn range_member_present(&self, addr: CellAddress) -> bool {
        self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.formula_source.borrow().contains_key(&addr)
            || self.primitive_slot_has_visible_value(addr)
    }

    fn bump_range_epochs_if_membership_changed(&self, addr: CellAddress, pre_member: bool) {
        if pre_member != self.range_member_present(addr) {
            self.bump_range_membership_epochs_touching(addr)
        }
    }

    /// P4c write口 helper — force this address's formula-inner atom to
    /// re-resolve its AST on the next read. Needed for a formula-CONTENT edit
    /// whose upstream deps are unchanged (`=B1`→`=C1`): the inner atom's
    /// recorded deps ({B1}) are still fresh, so without this it returns the
    /// CACHED old-AST value. Because `Store::invalidate` only marks the atom
    /// stale WITHOUT propagating, this MUST be paired with `bump_facade_epoch`
    /// to drive the facade to re-read the now-stale inner.
    ///
    /// NON-CREATING: a no-op when no inner atom exists (literal→formula and
    /// absent→formula create the inner lazily on the facade's re-derive, so
    /// there is nothing to invalidate here).
    fn invalidate_formula_inner(&self, addr: CellAddress) {
        if let Some(inner) = self.formula_inner_family.borrow().get(&addr) {
            self.store.invalidate(inner);
        }
    }

    /// The materialized primitive atom currently parked at `addr`, iff the slot
    /// holds one (`CellSlot::Atom`). `None` for a `Plain` slot, a formula cell,
    /// or an absent cell. The write口 samples this before and after a mutation
    /// to detect the inner-atom identity transitions that require a facade
    /// epoch bump.
    fn slot_atom_id(&self, addr: CellAddress) -> Option<AtomId> {
        match self.interior.cells.borrow().get(&addr) {
            Some(CellSlot::Atom(id)) => Some(*id),
            _ => None,
        }
    }

    fn ensure_cell(&mut self, addr: CellAddress) -> AtomId {
        // P4a borrow rule: take the parked value (or bail on Atom) under a
        // short `cells` borrow, release the guard, THEN call into the
        // store — atom creation must never run under a live borrow.
        let parked: Option<Value> = {
            let mut cells = self.interior.cells.borrow_mut();
            match cells.get(&addr) {
                Some(CellSlot::Atom(id)) => return *id,
                Some(CellSlot::Plain(_)) => {
                    let Some(CellSlot::Plain(value)) = cells.remove(&addr) else {
                        unreachable!("slot vanished between get and remove");
                    };
                    Some(value)
                }
                None => None,
            }
        };
        let id = match parked {
            Some(value) => self.owned_create_atom(value),
            None => self.owned_create_atom(Value::Null),
        };
        self.interior
            .cells
            .borrow_mut()
            .insert(addr, CellSlot::Atom(id));
        id
    }

    /// Read the value behind the cell slot at `addr`, if a slot exists.
    /// `Plain` slots return the parked value; `Atom` slots read the store
    /// (Null if the atom was destroyed out from under the slot —
    /// defensive, mirrors the old `has_atom`-guarded reads).
    ///
    /// P4a borrow rule: the slot is snapshotted under a short `cells`
    /// borrow (value cloned / atom id copied) and the guard released
    /// BEFORE the store read.
    fn cell_value_at(&self, addr: CellAddress) -> Option<Value> {
        let probe: Result<Value, AtomId> = {
            let cells = self.interior.cells.borrow();
            match cells.get(&addr)? {
                CellSlot::Plain(value) => Ok(value.clone()),
                CellSlot::Atom(id) => Err(*id),
            }
        };
        Some(match probe {
            Ok(value) => value,
            Err(id) => {
                if self.store.has_atom(id) {
                    self.store.get(id)
                } else {
                    Value::Null
                }
            }
        })
    }

    fn primitive_slot_has_visible_value(&self, addr: CellAddress) -> bool {
        matches!(
            self.cell_value_at(addr),
            Some(value) if !matches!(value, Value::Null)
        )
    }

    /// Remove the slot at `addr`; if it held a materialized atom with no
    /// live dependents, destroy the atom. `Plain` slots are simply
    /// dropped. Returns whether a slot was present.
    fn drop_cell_slot(&mut self, addr: CellAddress) -> bool {
        let removed = self.interior.cells.borrow_mut().remove(&addr);
        let Some(slot) = removed else {
            return false;
        };
        if let CellSlot::Atom(id) = slot {
            if self.store.has_atom(id) && !self.store.has_dependents(id) {
                self.owned_destroy_atom(id);
            }
        }
        true
    }

    /// Get or create the primitive atom for a cell. Formula results no longer
    /// have core atoms; callers needing a raw atom get the primitive slot.
    fn readable_atom(&mut self, addr: CellAddress) -> AtomId {
        self.ensure_cell(addr)
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

    /// Attach (or re-attach) this address's fanout to the stable facade atom.
    /// The facade itself is lazy, but subscribing to an address is the point at
    /// which the stable anchor is intentionally materialized.
    fn attach_address_sub(&mut self, addr: CellAddress) {
        if !self.cell_subscriptions.contains_key(&addr) {
            return;
        }
        let new_atom = Some(self.facade_of(addr));
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

    /// Stable facades make address remapping unnecessary; callers keep this
    /// wrapper while older mutation code is being simplified.
    fn with_remap<R>(&mut self, _addr: CellAddress, f: impl FnOnce(&mut Self) -> R) -> R {
        f(self)
    }

    fn store_batch<R>(&mut self, f: impl FnOnce(&mut Self) -> R) -> R {
        let store = self.store.clone();
        let mut result = None;
        store.batch(|_| {
            result = Some(f(self));
        });
        result.expect("store batch closure did not run")
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

    fn materialize_formula_inner(&self, addr: CellAddress) {
        self.facade_ctx().formula_inner_of(addr);
    }

    fn invalidate_formula_value(&self, addr: CellAddress) {
        self.invalidate_formula_inner(addr);
        self.bump_facade_epoch(addr);
    }

    fn formula_has_spill_anchor(&self, addr: CellAddress) -> bool {
        self.interior
            .cells
            .borrow()
            .get(&addr)
            .and_then(|slot| slot.atom_id())
            .is_some_and(|id| self.spill_targets.contains_key(&id))
    }

    fn formula_needs_spill_maintenance(&self, addr: CellAddress) -> bool {
        self.formula_has_spill_anchor(addr)
            || self
                .interior
                .formula_cells
                .borrow()
                .get(&addr)
                .is_some_and(|record| expr_may_produce_array(&record.expr))
    }

    fn store_root_atoms_for_addr_into(&self, addr: CellAddress, out: &mut Vec<AtomId>) {
        if let Some(id) = self.slot_atom_id(addr) {
            if self.store.has_atom(id) {
                out.push(id);
            }
        }

        let epoch_id = { self.slot_epoch_family.borrow().get(&addr) };
        if let Some(id) = epoch_id {
            if self.store.has_atom(id) {
                out.push(id);
            }
        }

        let facade_id = { self.cell_facade_family.borrow().get(&addr) };
        if let Some(id) = facade_id {
            if self.store.has_atom(id) {
                out.push(id);
            }
        }

        self.store_root_range_geometry_atoms_for_addr_into(addr, out);
    }

    pub(crate) fn store_root_atoms_for_addr(&self, addr: CellAddress) -> Vec<AtomId> {
        let mut roots = Vec::new();
        self.store_root_atoms_for_addr_into(addr, &mut roots);
        roots
    }

    pub(crate) fn array_formula_addrs_for_store_atoms(
        &self,
        atom_ids: &[AtomId],
    ) -> HashSet<CellAddress> {
        let formula_inner_family = self.formula_inner_family.borrow();
        atom_ids
            .iter()
            .filter_map(|id| formula_inner_family.key_of(*id).copied())
            .filter(|addr| self.formula_needs_spill_maintenance(*addr))
            .collect()
    }

    fn store_root_range_geometry_atoms_for_addr_into(
        &self,
        addr: CellAddress,
        out: &mut Vec<AtomId>,
    ) {
        let band_key = range_band_key_for_addr(addr);
        let band_id = { self.range_band_epoch_family.borrow().get(&band_key) };
        if let Some(id) = band_id {
            if self.store.has_atom(id) {
                out.push(id);
            }
        }

        let column_key = RangeColumnKey { col: addr.col };
        let column_id = { self.range_column_epoch_family.borrow().get(&column_key) };
        if let Some(id) = column_id {
            if self.store.has_atom(id) {
                out.push(id);
            }
        }

        let sheet_id = { self.range_sheet_epoch_family.borrow().get(&()) };
        if let Some(id) = sheet_id {
            if self.store.has_atom(id) {
                out.push(id);
            }
        }
    }

    fn store_dependent_formula_addrs_from_atoms(
        &self,
        root_atoms: &[AtomId],
    ) -> HashSet<CellAddress> {
        if root_atoms.is_empty() {
            return HashSet::new();
        }
        let dependent_atoms = self.store.reverse_dependents(root_atoms);
        {
            let formula_inner_family = self.formula_inner_family.borrow();
            dependent_atoms
                .into_iter()
                .filter_map(|id| formula_inner_family.key_of(id).copied())
                .collect()
        }
    }

    fn store_dependent_formula_addrs_from_addrs<I>(&self, addrs: I) -> HashSet<CellAddress>
    where
        I: IntoIterator<Item = CellAddress>,
    {
        let mut roots = Vec::new();
        for addr in addrs {
            self.store_root_atoms_for_addr_into(addr, &mut roots);
        }
        let formulas = self.store_dependent_formula_addrs_from_atoms(&roots);
        self.reverse_dep_visit_count.set(
            self.reverse_dep_visit_count
                .get()
                .saturating_add(formulas.len() as u64),
        );
        formulas
    }

    fn store_dependent_array_formula_addrs_from_addrs<I>(&self, addrs: I) -> HashSet<CellAddress>
    where
        I: IntoIterator<Item = CellAddress>,
    {
        self.store_dependent_formula_addrs_from_addrs(addrs)
            .into_iter()
            .filter(|addr| self.formula_needs_spill_maintenance(*addr))
            .collect()
    }

    fn bump_formula_topology_epoch(&self) {
        if let Some(next) = self.formula_topology_epoch.get().checked_add(1) {
            self.formula_topology_epoch.set(next);
            return;
        }

        // Practically unreachable, but avoid accepting ancient certificates
        // after u64 wraparound.
        {
            let records = self.interior.formula_cells.borrow();
            for (_, record) in records.iter() {
                record.cycle_checked_at.set(0);
            }
        }
        {
            let sources = self.interior.formula_source.borrow();
            for (_, source) in sources.iter() {
                source.cycle_checked_at.set(0);
            }
        }
        self.formula_topology_epoch.set(1);
    }

    fn formula_cycle_is_checked(&self, addr: CellAddress, epoch: u64) -> bool {
        if let Some(record) = self.interior.formula_cells.borrow().get(&addr) {
            return record.cycle_checked_at.get() == epoch;
        }
        self.interior
            .formula_source
            .borrow()
            .get(&addr)
            .is_some_and(|source| source.cycle_checked_at.get() == epoch)
    }

    fn mark_formula_cycle_checked(&self, addr: CellAddress, epoch: u64) {
        if let Some(record) = self.interior.formula_cells.borrow().get(&addr) {
            record.cycle_checked_at.set(epoch);
            return;
        }
        if let Some(source) = self.interior.formula_source.borrow().get(&addr) {
            source.cycle_checked_at.set(epoch);
        }
    }

    fn remove_formula_record(&mut self, addr: CellAddress) -> Option<Rc<FormulaRecord>> {
        // LAZY_FORMULA_INDEXING Phase 3: drain lazy state FIRST so an
        // "unhydrated only" addr still gets cleaned up even when there
        // is no eager `FormulaRecord` to remove. This matters when
        // `try_set_formula` calls `remove_formula_record` against a
        // bulk-loaded but not-yet-read formula — without the early
        // drain the new install would race the old lazy entry on the
        // first read.
        let parked = self.interior.formula_source.borrow_mut().remove(&addr);
        self.interior.needs_parse.borrow_mut().remove(&addr);
        let record = self.interior.formula_cells.borrow_mut().remove(&addr);
        if record.is_some() {
            self.interior.formula_exprs.borrow_mut().remove(&addr);
            self.interior.formula_texts.borrow_mut().remove(&addr);
            self.invalidate_formula_inner(addr);
        }
        if parked.is_some() || record.is_some() {
            self.bump_formula_topology_epoch();
        }
        record
    }

    /// LAZY_FORMULA_INDEXING Phase 3: idempotent lazy parse+install.
    ///
    /// If `addr` is not in `needs_parse`, returns immediately (already
    /// hydrated or never lazy). Otherwise pulls the source text out of
    /// `formula_source`, parses it, runs the same-sheet static cycle
    /// check (B.2), then installs static metadata and materializes the
    /// Store-backed formula-inner via the same shape as
    /// `BulkLoader::install_parsed_formula`.
    ///
    /// Takes `&self` (not `&mut self`) so read-path callers can hydrate
    /// without holding a unique borrow of the sheet. All mutable state
    /// goes through the per-field `RefCell`s (`formula_cells`,
    /// `formula_exprs`, `formula_texts`, `needs_parse`)
    /// or interior-mutable fields
    /// (`imported_formula_count` is bumped at park time, not here).
    ///
    /// Cost-amortisation note: this method is called once per cell per
    /// lifetime — the `needs_parse.contains(&addr)` check is a cheap
    /// `HashSet` lookup that hits ~all reads in the steady state. For
    /// the typical workload (rendering a 50×27 viewport over a
    /// million-formula sheet) only ~1350 cells go through the parse
    /// branch.
    fn hydrate_formula(&self, addr: CellAddress) {
        // Fast path: not lazy. One hashset lookup, no allocations.
        // Done under a short borrow so concurrent `&self` callers don't
        // race against a `borrow_mut` from the parse path below.
        if !self.interior.needs_parse.borrow().contains(&addr) {
            return;
        }

        // Drain the source. Removing from `formula_source` AND
        // `needs_parse` in lockstep keeps the
        // `formula_source ↔ needs_parse` invariant tight. Done under
        // exclusive borrows that are released before the parse so the
        // parse path can re-enter sheet-level `RefCell`s freely.
        let parked = {
            let mut needs = self.interior.needs_parse.borrow_mut();
            if !needs.remove(&addr) {
                return;
            }
            let src = self.interior.formula_source.borrow_mut().remove(&addr);
            match src {
                Some(s) => s,
                None => return,
            }
        };

        // Parse the source. On failure write `#VALUE!` via the
        // `&self`-friendly path. There is no parsed reference metadata;
        // synthesize a minimal literal-error record and formula-inner so
        // same-sheet reads still flow through Store.
        let source = parked.source;
        let checked_at = parked.cycle_checked_at.get();
        let expr_owned = match parse_formula(source.as_ref()) {
            Some(e) => e,
            None => {
                let err_expr = Rc::new(Expr::Error(ValueError::InvalidValue));
                let record = Rc::new(FormulaRecord::new(
                    err_expr.clone(),
                    HashSet::new(),
                    HashSet::new(),
                ));
                record
                    .cycle_checked_at
                    .set(self.formula_topology_epoch.get());
                self.interior
                    .formula_cells
                    .borrow_mut()
                    .insert(addr, record);
                self.interior
                    .formula_exprs
                    .borrow_mut()
                    .insert(addr, err_expr);
                self.interior
                    .formula_texts
                    .borrow_mut()
                    .insert(addr, source.as_ref().to_string());
                self.materialize_formula_inner(addr);
                self.invalidate_formula_value(addr);
                return;
            }
        };

        let expr_rc = Rc::new(expr_owned);

        // Cycle check (B.2). Parked formulas may reuse certificates created
        // by an earlier hydration in the same immutable formula topology.
        let cycle_check = self.closes_parked_local_cycle(addr, expr_rc.clone(), checked_at);
        if cycle_check.closes_cycle {
            let err_expr = Rc::new(Expr::Error(ValueError::CyclicRef));
            let record = Rc::new(FormulaRecord::new(
                err_expr.clone(),
                HashSet::new(),
                HashSet::new(),
            ));
            record
                .cycle_checked_at
                .set(self.formula_topology_epoch.get());
            self.interior
                .formula_cells
                .borrow_mut()
                .insert(addr, record);
            self.interior
                .formula_exprs
                .borrow_mut()
                .insert(addr, err_expr);
            self.interior
                .formula_texts
                .borrow_mut()
                .insert(addr, source.as_ref().to_string());
            self.materialize_formula_inner(addr);
            self.invalidate_formula_value(addr);
            return;
        }

        // Install static references and the FormulaRecord, then materialize
        // the formula-inner. This mirrors `BulkLoader::install_parsed_formula`
        // through `&self`-only paths.
        let deps = Sheet::formula_deps_for(&expr_rc);
        let static_ranges = collect_range_refs(&expr_rc);
        let record = Rc::new(FormulaRecord::new(expr_rc.clone(), deps, static_ranges));
        if cycle_check.target_certified {
            record
                .cycle_checked_at
                .set(self.formula_topology_epoch.get());
        }
        self.interior
            .formula_cells
            .borrow_mut()
            .insert(addr, record);
        self.interior
            .formula_exprs
            .borrow_mut()
            .insert(addr, expr_rc.clone());
        self.interior
            .formula_texts
            .borrow_mut()
            .insert(addr, source.as_ref().to_string());
        self.materialize_formula_inner(addr);
    }

    /// Pre-grow the formula-installation HashMaps to fit a hinted batch
    /// size. Called by `Workbook::bulk_load` flush after the loader's
    /// queue size is known, before the per-sheet replay drives 10k+
    /// `set_formula` calls.
    ///
    /// HashMap rehashing is O(n) at each capacity doubling — at 100k
    /// entries that's ~17 rehashes inside the `Sheet::bulk_load` hot
    /// loop, each copying every existing entry to a fresh backing
    /// allocation. On wasm32 those rehashes dominated the constant-
    /// factor in the chain workload because each backing-vec growth
    /// goes through linear-memory page allocation.
    ///
    /// `hint` is the additional batch size; the call expands enough
    /// headroom on top of whatever's already populated so a second
    /// batch lands without re-rehashing. `RowMajorMap` (which backs
    /// `formula_cells` and `cells`) is BTreeMap-based and gets no
    /// benefit from `reserve`; only the HashMap-backed indexes are
    /// warmed here.
    pub(crate) fn reserve_for_bulk_install(&mut self, hint: usize) {
        if hint == 0 {
            return;
        }
        self.interior.formula_exprs.borrow_mut().reserve(hint);
        self.interior.formula_texts.borrow_mut().reserve(hint);
    }

    /// STORAGE_PRIMARY Phase 6.1: full-sheet replace via direct map
    /// installs — "the storage IS the API". No per-cell parse, no dep
    /// extraction, no cycle check, no ops queue. Returns
    /// `(primitives_installed, formulas_installed)`.
    ///
    /// Semantics (per `docs/STORAGE_PRIMARY_PLAN.md` § "The right
    /// architecture"):
    ///
    ///   - Previous sheet content is fully torn down first (this is a
    ///     REPLACE, not a merge): primitive atoms are destroyed, every
    ///     hydrated-formula structure (`formula_cells` /
    ///     `formula_exprs` / `formula_texts`) is
    ///     cleared wholesale, lazy parking
    ///     (`formula_source` / `needs_parse`) is dropped, and spill
    ///     bookkeeping is reset. Wholesale clears — not per-record
    ///     edge removal — because the entire index family is being
    ///     rebuilt from scratch (lazily, on first read).
    ///   - Primitives: one `Store::create_atom` + `RowMajorMap::insert`
    ///     per cell. A true O(1) map swap is impossible here because
    ///     primitive values live behind atoms in `self.store`
    ///     (`cells` maps addr → `AtomId`, not addr → `Value`), so this
    ///     is O(n) iterate-insert — but each insert is a plain storage
    ///     write (~atom alloc + BTreeMap insert), with zero parse / dep
    ///     / notify work. `Value::Null` entries are skipped (Null means
    ///     "absent" — matches `set_cell`'s release contract).
    ///   - Formulas: parked as raw source text in `formula_source` with
    ///     every addr in `needs_parse` — exactly the Phase 2+3 lazy
    ///     state. `hydrate_formula` does parse / cycle-check / dep
    ///     install on first read, unchanged. NOTE: unlike
    ///     `BulkLoader::set_formula`, the source is NOT parse-validated
    ///     here (validation would defeat the storage-primary contract);
    ///     unparseable text surfaces `#VALUE!` at first read via the
    ///     hydrator's parse-failure arm, and `get_formula` /
    ///     `ISFORMULA` will see it as a live formula until then.
    ///   - An address present in BOTH maps resolves formula-wins
    ///     (mirrors the loader path, where a formula install drops the
    ///     primitive scaffold).
    ///   - Existing subscription buckets survive: their fanouts are
    ///     detached during the swap, reattached after, and every
    ///     subscribed address is notified once (the whole world
    ///     changed).
    ///
    pub(crate) fn bulk_install_storage(
        &mut self,
        primitives: HashMap<CellAddress, Value>,
        formulas: HashMap<CellAddress, String>,
    ) -> (usize, usize, BulkInstallCleanup) {
        self.bump_formula_topology_epoch();
        // --- Teardown of previous content ---------------------------------
        // Detach every subscription fanout first so atom destruction below
        // cannot fire through a stale store sub. Buckets (and their
        // listeners) stay; we reattach + notify at the end.
        let sub_addrs: Vec<CellAddress> = self.cell_subscriptions.keys().copied().collect();
        for addr in &sub_addrs {
            self.detach_address_sub(*addr);
        }

        // Retire every old cell atom as one graph. Spill targets are included
        // in `cells`; fixed-point destruction below naturally removes those
        // derived targets before their anchors.
        self.spill_targets.clear();
        self.spill_target_anchor.clear();
        self.spill_anchor_addr.clear();
        let drained = self.interior.cells.borrow_mut().drain_into_vec();
        let retired_atom_ids: Vec<AtomId> = drained
            .into_iter()
            .filter_map(|(_, slot)| slot.atom_id())
            .collect();

        // Hydrated formula state — wholesale clears (full replace).
        *self.interior.formula_cells.borrow_mut() = RowMajorMap::new();
        self.interior.formula_exprs.borrow_mut().clear();
        self.interior.formula_texts.borrow_mut().clear();
        // Lazy parking from any previous bulk load.
        *self.interior.formula_source.borrow_mut() = RowMajorMap::new();
        self.interior.needs_parse.borrow_mut().clear();

        // With storage empty, peel every old-world AtomFamily component that
        // Store proves is unobserved. A facade retained by an external Store
        // reader stays alive and is retargeted to the new storage below.
        self.prune_all_family_atoms();

        // --- Primitive install ---------------------------------------------
        // AUDIT B-2 (FIXED): park raw values as `CellSlot::Plain` — zero
        // store-atom allocations. The atom materializes lazily at the
        // first `ensure_cell` (write / spill anchor) or subscription
        // attach for that address; pure reads serve the parked value
        // directly via `slot_value`, skipping the old addr → AtomId →
        // Value double lookup. The map itself is bulk-built from sorted
        // pairs (`from_unsorted_pairs`) instead of paying a random-order
        // BTreeMap insert per cell.
        let mut prim_pairs: Vec<(CellAddress, CellSlot)> = Vec::with_capacity(primitives.len());
        for (addr, value) in primitives {
            if matches!(value, Value::Null) {
                continue;
            }
            // Formula wins when the same addr appears in both maps.
            if formulas.contains_key(&addr) {
                continue;
            }
            prim_pairs.push((addr, CellSlot::Plain(value)));
        }
        let primitives_installed = prim_pairs.len();
        *self.interior.cells.borrow_mut() = RowMajorMap::from_unsorted_pairs(prim_pairs);

        // --- Formula parking (lazy — Phase 2+3 machinery) ------------------
        let formulas_installed = formulas.len();
        let mut needs: HashSet<CellAddress> = HashSet::with_capacity(formulas_installed);
        let mut formula_pairs: Vec<(CellAddress, ParkedFormula)> =
            Vec::with_capacity(formulas_installed);
        for (addr, text) in formulas {
            needs.insert(addr);
            formula_pairs.push((addr, ParkedFormula::new(text)));
        }
        *self.interior.formula_source.borrow_mut() =
            RowMajorMap::from_unsorted_pairs(formula_pairs);
        *self.interior.needs_parse.borrow_mut() = needs;
        self.imported_formula_count
            .set(self.imported_formula_count.get() + formulas_installed);

        // Only externally-observed family nodes can have survived the old-world
        // prune. Retarget those through their existing Store epochs now that
        // final storage is installed; untouched payload remains fully lazy.
        let surviving_inner_addrs: Vec<CellAddress> = self
            .formula_inner_family
            .borrow()
            .iter()
            .map(|(addr, _)| *addr)
            .collect();
        let surviving_epoch_addrs: Vec<CellAddress> = self
            .slot_epoch_family
            .borrow()
            .iter()
            .map(|(addr, _)| *addr)
            .collect();
        self.store_batch(|sheet| {
            for addr in surviving_inner_addrs {
                sheet.invalidate_formula_inner(addr);
            }
            for addr in surviving_epoch_addrs {
                sheet.bump_facade_epoch(addr);
            }
        });
        self.prune_all_family_atoms();

        // --- Reattach + notify subscribers ---------------------------------
        // Every subscribed address is notified exactly once: a full-sheet
        // replace means any watched cell may have changed. Bounded by the
        // (small) subscription count, not by payload size.
        for addr in sub_addrs {
            self.attach_address_sub(addr);
            if self.has_address_subscribers(addr) {
                self.notify_address_subscribers(addr);
            }
        }

        (
            primitives_installed,
            formulas_installed,
            BulkInstallCleanup { retired_atom_ids },
        )
    }

    /// Finish a full-sheet replacement after the enclosing Store transaction
    /// has published and refreshed every dependent formula.
    pub(crate) fn finish_bulk_install(&self, cleanup: BulkInstallCleanup) {
        self.prune_all_family_atoms();
        self.destroy_retired_atoms(cleanup.retired_atom_ids);
        self.prune_all_family_atoms();
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
        match self.cell_value_at(addr)? {
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

    /// Public accessor for `spilled_into_anchor`. Returns the anchor
    /// address of the spill range that covers `addr`, or `None` if
    /// `addr` is not a spilled (non-anchor) cell. Used by JS UI hosts
    /// to draw the spill outline relative to the anchor even when the
    /// anchor cell falls outside the visible window.
    pub fn spill_anchor_for(&self, addr: CellAddress) -> Option<CellAddress> {
        self.spilled_into_anchor(addr)
    }

    /// If `addr` is part of an active spill range whose anchor lives
    /// elsewhere, return the anchor's address. Returns None when `addr`
    /// is either the anchor itself, a plain cell, or empty.
    ///
    /// Implementation (AUDIT A-8): one probe of the reverse index
    /// `spill_target_anchor`. This sits on EVERY single-cell write path
    /// (`try_set_cell` / `try_set_formula` / the BulkLoader spill
    /// guards), so it must not scale with spill size — the previous
    /// Phase 1 shape scanned all target lists and then reverse-scanned
    /// `cells` for the anchor.
    fn spilled_into_anchor(&self, addr: CellAddress) -> Option<CellAddress> {
        self.spill_target_anchor
            .get(&addr)
            .map(|&(_, anchor_addr)| anchor_addr)
    }

    /// Look up the anchor address for a given anchor atom. Used by
    /// `teardown_all_spills` (AUDIT A-5) to snapshot anchor addresses
    /// before a structural shift. One probe of `spill_anchor_addr`
    /// (A-8 follow-up) — the previous shape reverse-scanned `cells`,
    /// O(active spills × cells) per structural op.
    fn anchor_address_for(&self, anchor_atom: AtomId) -> Option<CellAddress> {
        self.spill_anchor_addr.get(&anchor_atom).copied()
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
            self.spill_anchor_addr.insert(anchor_atom, anchor_addr);
            return Ok(());
        }
        let end_row = anchor_addr
            .row
            .checked_add(rows - 1)
            .ok_or(ValueError::Spill)?;
        let end_col = anchor_addr
            .col
            .checked_add(cols - 1)
            .ok_or(ValueError::Spill)?;
        if end_row >= EXCEL_MAX_ROWS || end_col >= EXCEL_MAX_COLS {
            return Err(ValueError::Spill);
        }

        // First pass: collision detection. We compute every target
        // (skipping (0, 0) which is the anchor) and ensure no obstruction.
        let mut targets: Vec<CellAddress> =
            Vec::with_capacity((rows as usize) * (cols as usize) - 1);
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
                let derived =
                    self.owned_create_derived(move |get| match get(anchor_atom_for_read) {
                        Value::Array(inner) => {
                            inner.get(row_off, col_off).cloned().unwrap_or(Value::Null)
                        }
                        // Anchor switched off Array (e.g. became #SPILL! after
                        // a later remap that hasn't yet cleared us). Return
                        // Null defensively — the parent re-spill will
                        // re-install a fresh derived atom anyway.
                        _ => Value::Null,
                    });

                // If there was a stale primitive at this address (e.g.
                // empty `Value::Null` placeholder created by a previous
                // subscribe), remove it first so we don't leak an atom.
                let pre_range_member = self.range_member_present(target);
                self.drop_cell_slot(target);
                self.interior
                    .cells
                    .borrow_mut()
                    .insert(target, CellSlot::Atom(derived));
                self.attach_address_sub(target);
                self.bump_facade_epoch(target);
                self.bump_range_epochs_if_membership_changed(target, pre_range_member);
            }
        }

        // Keep the reverse index in lockstep (AUDIT A-8).
        for &target in &targets {
            self.spill_target_anchor
                .insert(target, (anchor_atom, anchor_addr));
        }
        self.spill_targets.insert(anchor_atom, targets);
        self.spill_anchor_addr.insert(anchor_atom, anchor_addr);
        Ok(())
    }

    /// Detect whether `target` is currently occupied for spill purposes.
    /// `our_anchor_atom` is the anchor we're spilling FROM — entries in
    /// `spill_targets[our_anchor_atom]` should NOT be considered
    /// collisions (we're re-spilling into our own previous range).
    fn is_target_occupied(&self, target: CellAddress, our_anchor_atom: AtomId) -> bool {
        // (a) Formula cell at target — always blocks. Unhydrated lazy
        // formulas count too: a same-cell collision with a deferred
        // formula must surface as #SPILL!, not pass through.
        if self.interior.formula_cells.borrow().contains_key(&target)
            || self.interior.needs_parse.borrow().contains(&target)
        {
            return true;
        }
        // (b) Primitive slot holding a non-Null value. `Plain` slots are
        // covered too (AUDIT B-2): a bulk-installed value blocks the
        // spill exactly like its materialized-atom equivalent would.
        if let Some(v) = self.cell_value_at(target) {
            if !matches!(v, Value::Null) {
                // (c) Spilled cell? One probe of the reverse index
                // (AUDIT A-8). Our OWN previous target is not a
                // collision (we're re-spilling — caller tears the old
                // spill down before register_spill, so this branch is
                // defensive); any OTHER anchor's target is.
                if let Some(&(anchor_atom, _)) = self.spill_target_anchor.get(&target) {
                    return anchor_atom != our_anchor_atom;
                }
                // Plain non-Null primitive — collision.
                return true;
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
        self.spill_anchor_addr.remove(&anchor_atom);
        for target in targets {
            // Drop the reverse-index entry (AUDIT A-8) — but only when
            // it still points at THIS anchor: a degenerate re-register
            // may have flipped the target to another anchor without
            // this anchor's list being pruned first.
            if self
                .spill_target_anchor
                .get(&target)
                .is_some_and(|&(a, _)| a == anchor_atom)
            {
                self.spill_target_anchor.remove(&target);
            }
            // Detach the address subscription bucket from the soon-dead
            // atom; reattach after removal so listeners refresh.
            self.detach_address_sub(target);
            // Spilled cells are read-only derived atoms with (typically)
            // no further atom-level dependents. Formula cells that
            // referenced this address read through facade atoms, so destroy
            // is safe. If something did register
            // a downstream derived atom (no API for that today),
            // `drop_cell_slot` leaks the spilled derived atom rather than
            // panic — acknowledged as a Phase 1 limitation.
            let pre_range_member = self.range_member_present(target);
            self.drop_cell_slot(target);
            self.attach_address_sub(target);
            self.bump_facade_epoch(target);
            self.bump_range_epochs_if_membership_changed(target, pre_range_member);
        }
    }

    /// Locate the anchor atom for `addr` (if any) and clear its spill.
    /// Used when overwriting the anchor cell — the new write replaces
    /// the array, so the old spill must go away. No-op when `addr` is
    /// not a spill anchor.
    fn clear_spill_at_address(&mut self, addr: CellAddress) {
        // `Plain` slots can never be spill anchors — nothing to clear.
        let atom_id = self
            .interior
            .cells
            .borrow()
            .get(&addr)
            .and_then(|slot| slot.atom_id());
        let Some(atom_id) = atom_id else {
            return;
        };
        if self.spill_targets.contains_key(&atom_id) {
            self.clear_spill(atom_id);
        }
    }

    /// Install (or refresh) a primitive anchor atom holding `arr` at
    /// `addr` for a formula whose latest result was `Value::Array(arr)`.
    /// The formula record at `addr` is preserved — only the primitive
    /// atom in `interior.cells[addr]` is created / updated to mirror the
    /// formula's array result, so spilled derived atoms have a
    /// dependency-tracked source to read.
    ///
    /// On spill collision the caller replaces the anchor projection with
    /// `Value::Error(Spill)`. The formula facade reads formula-inner first,
    /// then this anchor atom, so Store propagation surfaces `#SPILL!` without
    /// making the compatibility cache authoritative for same-sheet formulas.
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

    /// Store-backed spill projection refresh for a single formula cell.
    /// Reads the already-invalidated formula-inner value, then:
    ///   - if the new result is `Value::Array` → install / refresh the
    ///     spill anchor and derived targets via `install_formula_spill`.
    ///     On collision, the anchor Store atom becomes
    ///     `Value::Error(Spill)` so the formula facade surfaces `#SPILL!`.
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
            .interior
            .cells
            .borrow()
            .get(&addr)
            .and_then(|slot| slot.atom_id())
            .filter(|id| self.spill_targets.contains_key(id));

        // LAZY_FORMULA_INDEXING Phase 3: hydrate before consulting
        // `formula_cells` so unhydrated array-producing formulas get
        // their spill installed by this eager pass.
        self.hydrate_formula(addr);
        let Some(record) = self.interior.formula_cells.borrow().get(&addr).cloned() else {
            // Not a formula cell — nothing to recompute.
            return;
        };

        // Gate the eager re-eval: only formulas that *might* produce a
        // `Value::Array` get this treatment. Scalar-only formulas stay
        // fully lazy (preserves the compatibility lazy-eval/debug counters).
        if prev_anchor_atom.is_none() && !expr_may_produce_array(&record.expr) {
            return;
        }

        // The mutation that selected this formula already invalidated its
        // Store dependency chain. Read that one authoritative derived value;
        // do not create a second invalidation/evaluation path for spill
        // projection.
        let value = {
            let inner = self.facade_ctx().formula_inner_of(addr);
            self.store.get(inner)
        };

        match value {
            Value::Array(arr) => {
                // Tear down any previous spill at this address before
                // re-installing (handles shape changes).
                self.clear_spill_at_address(addr);
                match self.install_formula_spill(addr, arr) {
                    Ok(()) => {}
                    Err(ValueError::Spill) => {
                        // Replace the anchor projection with #SPILL!. The
                        // facade already depends on formula-inner and will now
                        // also observe this Store atom.
                        // P4a borrow rule: copy the atom id out before the
                        // `store.set` (which dispatches listeners).
                        let atom_id = self
                            .interior
                            .cells
                            .borrow()
                            .get(&addr)
                            .and_then(|slot| slot.atom_id());
                        if let Some(atom_id) = atom_id {
                            self.store.set(atom_id, Value::Error(ValueError::Spill));
                        }
                        self.bump_facade_epoch(addr);
                    }
                    Err(other) => {
                        // P4a borrow rule: copy the atom id out before the
                        // `store.set` (which dispatches listeners).
                        let atom_id = self
                            .interior
                            .cells
                            .borrow()
                            .get(&addr)
                            .and_then(|slot| slot.atom_id());
                        if let Some(atom_id) = atom_id {
                            self.store.set(atom_id, Value::Error(other.clone()));
                        }
                        self.bump_facade_epoch(addr);
                    }
                }
            }
            _ => {
                // Formula no longer produces an array — tear down any
                // prior spill. If the cells[addr] primitive atom was the
                // spill anchor, drop it so future reads resolve directly
                // through formula-inner again.
                if prev_anchor_atom.is_some() {
                    self.clear_spill_at_address(addr);
                    self.drop_cell_slot(addr);
                    self.attach_address_sub(addr);
                    self.bump_facade_epoch(addr);
                }
            }
        }
    }

    /// Re-project formulas selected through Store reverse dependencies that
    /// produce, or previously produced, a `Value::Array`. This maintains
    /// spill geometry synchronously because the `&self` read path cannot
    /// mutate it. Formula values still come exclusively from formula-inner;
    /// this method owns no result cache or invalidation graph.
    pub(crate) fn recompute_array_formulas_in(&mut self, addrs: &HashSet<CellAddress>) {
        // Collect addresses to process — clone the addresses to avoid
        // borrowing self while we mutate.
        //
        // LAZY_FORMULA_INDEXING Phase 3: hydrate each candidate before
        // taking the filter; an unhydrated formula at `a` would slip
        // past the `formula_cells.contains_key(a)` test and the
        // downstream array-recompute would miss it. Hydration is
        // idempotent — already-hydrated addrs cost a single
        // `needs_parse.contains` lookup.
        let candidates: Vec<CellAddress> = addrs
            .iter()
            .copied()
            .filter(|a| {
                self.hydrate_formula(*a);
                self.interior.formula_cells.borrow().contains_key(a)
            })
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
    pub fn set_array(&mut self, addr_str: &str, arr: Arc<ArrayData>) -> Result<(), SheetError> {
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        // Reject writes into another anchor's spill range — same
        // contract as `try_set_cell`. The user must clear that anchor
        // first.
        if let Some(anchor) = self.spilled_into_anchor(addr) {
            return Err(SheetError::SpillCellWrite { anchor });
        }
        let pre_range_member = self.range_member_present(addr);
        let had_formula = self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.needs_parse.borrow().contains(&addr);
        let array_formulas_to_reproject =
            self.store_dependent_array_formula_addrs_from_addrs(std::iter::once(addr));

        self.store_batch(|sheet| {
            // Tear down any spill the current cell already owns; we're
            // replacing it.
            sheet.clear_spill_at_address(addr);

            // Drop any prior formula at the anchor — an array write is a
            // primitive-style mutation that replaces formula state.
            //
            // LAZY_FORMULA_INDEXING Phase 3: an unhydrated formula still
            // owns the address. Drain the source / needs_parse entries
            // explicitly; the `formula_cells` map has no record to
            // `remove_formula_record` for an unhydrated addr.
            if had_formula {
                sheet.with_remap(addr, |sheet| {
                    sheet.remove_formula_record(addr);
                    sheet.interior.formula_source.borrow_mut().remove(&addr);
                    sheet.interior.needs_parse.borrow_mut().remove(&addr);
                    let _ = sheet.ensure_cell(addr);
                });
            }

            let anchor_atom = sheet.ensure_cell(addr);
            sheet.attach_address_sub(addr);

            // Write the array to the anchor.
            sheet.store.set(anchor_atom, Value::Array(arr.clone()));

            // Try to install spill targets. On collision, overwrite the
            // anchor with `#SPILL!` so the user sees the error at the
            // anchor cell (Excel parity).
            match sheet.register_spill(addr, anchor_atom, &arr) {
                Ok(()) => {}
                Err(ValueError::Spill) => {
                    sheet
                        .store
                        .set(anchor_atom, Value::Error(ValueError::Spill));
                }
                Err(other) => {
                    // register_spill currently only returns Spill, but
                    // future variants would surface here defensively.
                    sheet.store.set(anchor_atom, Value::Error(other));
                }
            }
            sheet.bump_range_epochs_if_membership_changed(addr, pre_range_member);
            // P4c: drive any materialized facade at the anchor to re-read the new
            // array (identity/value change on the anchor's inner atom). Spill
            // TARGET epoch wiring is deferred to P5. Inert until the read口 flip.
            sheet.bump_facade_epoch(addr);
        });
        if had_formula {
            self.cleanup_obsolete_formula_atoms_at(addr);
        }
        self.recompute_array_formulas_in(&array_formulas_to_reproject);
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
        let pre_range_member = self.range_member_present(addr);
        // LAZY_FORMULA_INDEXING Phase 3: include unhydrated lazy
        // formulas. `remove_formula_record` already drains the lazy
        // entries defensively.
        let had_formula = self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.needs_parse.borrow().contains(&addr);
        let is_null = matches!(value, Value::Null);
        // P4c: sample the inner-atom identity BEFORE the write so we can bump
        // the facade epoch only on an identity transition (see below).
        let pre_atom = self.slot_atom_id(addr);
        let same_display_value = if had_formula {
            // Formula replacement only needs the old displayed value for a
            // direct listener's same-value notification. Avoid hydrating an
            // otherwise cold formula solely for this comparison.
            self.has_address_subscribers(addr) && self.peek_value(addr) == value
        } else {
            self.cell_value_at(addr).unwrap_or(Value::Null) == value
        };
        let dependent_formulas =
            self.store_dependent_formula_addrs_from_addrs(std::iter::once(addr));
        let array_formulas_to_reproject: HashSet<CellAddress> = dependent_formulas
            .iter()
            .copied()
            .filter(|formula_addr| self.formula_needs_spill_maintenance(*formula_addr))
            .collect();

        self.store_batch(|sheet| {
            // If this address was itself a spill anchor, the new write
            // replaces the array — tear the spill down first so we don't
            // strand the derived atoms at the old targets.
            sheet.clear_spill_at_address(addr);

            if had_formula {
                sheet.with_remap(addr, |sheet| {
                    sheet.remove_formula_record(addr);
                    sheet.interior.formula_source.borrow_mut().remove(&addr);
                    sheet.interior.needs_parse.borrow_mut().remove(&addr);
                    let id = sheet.ensure_cell(addr);
                    sheet.store.set(id, value);
                });
            } else {
                let id = sheet.ensure_cell(addr);
                sheet.attach_address_sub(addr);
                sheet.store.set(id, value);
            }
            // P4c: a same-id literal value update propagates via the facade's
            // native `args.get(inner)` edge (the `store.set(id, ..)` above is
            // part of this write batch) — no bump. Bump only on an identity
            // transition: a formula→literal replacement (`had_formula`) or a
            // Plain/Absent→Atom / Atom→None slot change (`pre_atom !=
            // post_atom`, the latter when `try_release_primitive` tore the slot
            // down).
            let post_atom = sheet.slot_atom_id(addr);
            if had_formula || pre_atom != post_atom {
                sheet.invalidate_formula_inner(addr);
                sheet.bump_facade_epoch(addr);
            }
            sheet.bump_range_epochs_if_membership_changed(addr, pre_range_member);
        });
        // Run primitive release after the write batch has settled. A subscribed
        // address has a stable facade edge to the primitive during the batch;
        // the release helper retargets that facade to Absent before destroying
        // the old backing atom.
        if is_null {
            self.try_release_primitive(addr);
        }
        if had_formula {
            self.cleanup_obsolete_formula_atoms_at(addr);
        }
        // Eager spill maintenance for downstream array formulas.
        self.recompute_array_formulas_in(&array_formulas_to_reproject);

        if !had_formula && same_display_value {
            for formula_addr in dependent_formulas {
                if formula_addr != addr && self.has_address_subscribers(formula_addr) {
                    self.notify_address_subscribers(formula_addr);
                }
            }
        }

        if had_formula && same_display_value && self.has_address_subscribers(addr) {
            self.notify_address_subscribers(addr);
        }
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
    /// has no direct dependents other than the address's stable facade. Used
    /// by `clear_cell` / `set_cell(.., Null)` to keep `cells.len()` bounded
    /// across long-running sheets where many cells get set then cleared.
    ///
    /// When a facade exists, removing the slot and bumping its epoch first
    /// makes Store re-derive it as Absent. That atomically severs the old
    /// primitive edge while preserving facade identity and address listeners.
    fn try_release_primitive(&mut self, addr: CellAddress) {
        // P4a borrow rule: classify the slot under a short borrow
        // (`Ok(atom_id)` for materialized slots, `Err(plain_is_null)`
        // for parked plain values), then act with the guard released —
        // the release paths below re-borrow `cells` mutably and call
        // into the store.
        let probe: Result<AtomId, bool> = {
            let cells = self.interior.cells.borrow();
            match cells.get(&addr) {
                None => return,
                Some(CellSlot::Plain(value)) => Err(matches!(value, Value::Null)),
                Some(CellSlot::Atom(id)) => Ok(*id),
            }
        };
        // Formula cells are lazy records, not primitive atoms.
        // LAZY_FORMULA_INDEXING Phase 3: also skip when an unhydrated
        // formula is parked at `addr` — the eventual hydration will
        // reuse the primitive slot if it needs one.
        if self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.needs_parse.borrow().contains(&addr)
        {
            return;
        }
        let atom_id = match probe {
            // AUDIT B-2: `Plain` slots hold non-Null values by invariant
            // (every Null-writing path promotes via `ensure_cell` first);
            // a Null that slips through is released without ever having
            // had an atom.
            Err(plain_is_null) => {
                if plain_is_null {
                    self.interior.cells.borrow_mut().remove(&addr);
                    self.detach_address_sub(addr);
                }
                return;
            }
            Ok(id) => id,
        };
        if !self.store.has_atom(atom_id) {
            // Defensive: nothing to release.
            self.interior.cells.borrow_mut().remove(&addr);
            return;
        }
        if !matches!(self.store.get(atom_id), Value::Null) {
            return;
        }

        let facade_id = self.cell_facade_family.borrow().get(&addr);
        if self
            .store
            .direct_dependents(atom_id)
            .into_iter()
            .any(|dependent| Some(dependent) != facade_id)
        {
            return;
        }

        self.interior.cells.borrow_mut().remove(&addr);
        if facade_id.is_some() {
            self.bump_facade_epoch(addr);
        }

        // A facade-only edge must be gone after the epoch re-derivation. Keep
        // the slot intact in the defensive case where a re-entrant listener
        // installed a new direct dependent while the facade was settling.
        if self.store.has_dependents(atom_id) {
            self.interior
                .cells
                .borrow_mut()
                .insert(addr, CellSlot::Atom(atom_id));
            self.bump_facade_epoch(addr);
            return;
        }
        self.owned_destroy_atom(atom_id);
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
        let pre_range_member = self.range_member_present(addr);

        let expr = match parse_formula(formula_str) {
            Some(e) => e,
            None => {
                self.write_error(addr, ValueError::InvalidValue);
                return Ok(false);
            }
        };

        // Static cycle check (B.2). Walk referenced formula AST/source content
        // on demand to see if `addr` is reachable; no reverse graph is kept.
        if self.closes_local_cycle(addr, &expr) {
            self.write_error(addr, ValueError::CyclicRef);
            return Ok(false);
        }
        let array_formulas_to_reproject =
            self.store_dependent_array_formula_addrs_from_addrs(std::iter::once(addr));

        self.store_batch(|sheet| {
            // Replacing the cell at this address: tear down any spill the
            // previous content (if it was an anchor) installed.
            sheet.clear_spill_at_address(addr);

            sheet.with_remap(addr, move |sheet| {
                let expr = Rc::new(expr);
                let deps = Sheet::formula_deps_for(&expr);
                let static_ranges = collect_range_refs(&expr);
                sheet.remove_formula_record(addr);
                sheet.drop_cell_slot(addr);
                sheet.bump_formula_topology_epoch();
                let record = Rc::new(FormulaRecord::new(expr.clone(), deps, static_ranges));
                sheet
                    .interior
                    .formula_cells
                    .borrow_mut()
                    .insert(addr, record);
                sheet
                    .interior
                    .formula_exprs
                    .borrow_mut()
                    .insert(addr, expr.clone());
                sheet
                    .interior
                    .formula_texts
                    .borrow_mut()
                    .insert(addr, formula_str.to_string());
                sheet.materialize_formula_inner(addr);
            });
            // P4c: force the facade to re-derive off the NEW formula. A
            // formula-content edit (`=B1`→`=C1`) whose upstream deps are unchanged
            // leaves the inner atom's recorded edges fresh, so it would return the
            // cached old-AST value — `invalidate_formula_inner` marks it stale and
            // the epoch bump drives the facade to re-read (and thus re-run) it.
            // literal→formula / absent→formula create the inner lazily on that
            // re-derive; `invalidate_formula_inner` is a no-op there. Inert until
            // the read口 flip.
            sheet.invalidate_formula_inner(addr);
            sheet.bump_facade_epoch(addr);
            sheet.bump_range_epochs_if_membership_changed(addr, pre_range_member);
        });
        // Eager spill maintenance: re-evaluate the just-installed
        // formula (and any downstream array formulas) and install /
        // tear down spill state. The lazy `peek_value` read path can't
        // mutate the sheet, so the spill install has to happen here.
        self.recompute_array_formula(addr);
        self.recompute_array_formulas_in(&array_formulas_to_reproject);
        Ok(true)
    }

    /// Drop any existing formula and write an error value to the cell.
    /// `pub(crate)` so the workbook layer can route a cross-sheet cycle
    /// detection failure (`#CYCLE!`) to the target cell without re-deriving
    /// the helper logic here.
    pub(crate) fn write_error(&mut self, addr: CellAddress, err: ValueError) {
        let pre_range_member = self.range_member_present(addr);
        // LAZY_FORMULA_INDEXING Phase 3: unhydrated formulas count as
        // "had a formula" for the remap-vs-direct teardown decision.
        let had_formula = self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.needs_parse.borrow().contains(&addr);
        // P4c: sample inner-atom identity BEFORE the write, mirroring
        // try_set_cell — bump the facade only on an identity transition.
        let pre_atom = self.slot_atom_id(addr);
        let array_formulas_to_reproject =
            self.store_dependent_array_formula_addrs_from_addrs(std::iter::once(addr));
        self.store_batch(|sheet| {
            sheet.clear_spill_at_address(addr);
            if had_formula {
                sheet.with_remap(addr, |sheet| {
                    sheet.remove_formula_record(addr);
                    let id = sheet.ensure_cell(addr);
                    sheet.store.set(id, Value::Error(err.clone()));
                });
            } else {
                let id = sheet.ensure_cell(addr);
                sheet.attach_address_sub(addr);
                sheet.store.set(id, Value::Error(err));
            }
            sheet.bump_range_epochs_if_membership_changed(addr, pre_range_member);
            // P4c: after write_error the cell is no longer a formula — the facade
            // re-derives `is_formula=false` and reads the literal error. Bump on a
            // formula→error replacement (`had_formula`) or a slot identity change
            // (`pre_atom != post_atom`).
            let post_atom = sheet.slot_atom_id(addr);
            if had_formula || pre_atom != post_atom {
                sheet.invalidate_formula_inner(addr);
                sheet.bump_facade_epoch(addr);
            }
        });
        if had_formula {
            self.cleanup_obsolete_formula_atoms_at(addr);
        }
        self.recompute_array_formulas_in(&array_formulas_to_reproject);
    }

    pub(crate) fn cycle_expr_for(&self, addr: CellAddress) -> Option<Rc<Expr>> {
        if let Some(expr) = self.interior.formula_exprs.borrow().get(&addr).cloned() {
            return Some(expr);
        }
        let source = self.interior.formula_source.borrow().get(&addr).cloned()?;
        parse_formula(source.source.as_ref()).map(Rc::new)
    }

    pub(crate) fn formula_addrs_in_range(&self, range: CellRange) -> HashSet<CellAddress> {
        let range = range.normalize();
        let formula_exprs = self.interior.formula_exprs.borrow();
        let formula_source = self.interior.formula_source.borrow();
        formula_exprs
            .keys()
            .copied()
            .chain(formula_source.keys())
            .filter(|addr| range.contains(*addr))
            .collect()
    }

    /// Append formula addresses referenced by `expr` for the install-time
    /// cycle walk. Ranges enqueue only formula cells, because literals cannot
    /// continue a dependency path. Large and unbounded ranges scan the sparse
    /// formula tables instead of expanding the coordinate space.
    ///
    /// This is an on-demand AST/source walk, not a retained dependency index.
    /// Store edges remain the runtime dependency truth; source inspection is
    /// required here because a never-read formula intentionally has no Store
    /// edges yet.
    fn collect_cycle_refs(
        &self,
        expr: &Expr,
        target: CellAddress,
        out: &mut Vec<CellAddress>,
        detect_unbounded_target: bool,
    ) -> bool {
        match expr {
            Expr::CellRef(addr) => {
                if *addr == target {
                    return true;
                }
                out.push(*addr);
            }
            Expr::Range { start, end, .. } => {
                let range = CellRange::new(*start, *end).normalize();
                let is_unbounded = range.end.row == u32::MAX || range.end.col == u32::MAX;
                if range.contains(target) && (detect_unbounded_target || !is_unbounded) {
                    return true;
                }

                let formula_exprs = self.interior.formula_exprs.borrow();
                let formula_source = self.interior.formula_source.borrow();
                let formula_count = formula_exprs.len().saturating_add(formula_source.len());
                let bounds = range_geometry_bounds(range);
                let cell_count = range_cell_count_u64(range);

                if cell_count <= formula_count as u64 {
                    for row in bounds.start_row..=bounds.end_row {
                        for col in bounds.start_col..=bounds.end_col {
                            let addr = CellAddress::new(row, col);
                            if formula_exprs.contains_key(&addr)
                                || formula_source.contains_key(&addr)
                            {
                                out.push(addr);
                            }
                        }
                    }
                } else {
                    out.extend(
                        formula_exprs
                            .keys()
                            .copied()
                            .chain(formula_source.keys())
                            .filter(|addr| range.contains(*addr)),
                    );
                }
            }
            Expr::BinOp { left, right, .. } => {
                if self.collect_cycle_refs(left, target, out, detect_unbounded_target) {
                    return true;
                }
                if self.collect_cycle_refs(right, target, out, detect_unbounded_target) {
                    return true;
                }
            }
            Expr::Negate(inner) | Expr::SpillRef(inner) => {
                if self.collect_cycle_refs(inner, target, out, detect_unbounded_target) {
                    return true;
                }
            }
            Expr::FuncCall { args, .. } | Expr::MultiArea(args) => {
                for arg in args {
                    if self.collect_cycle_refs(arg, target, out, detect_unbounded_target) {
                        return true;
                    }
                }
            }
            Expr::DynamicRange { start, end } => {
                if self.collect_cycle_refs(start, target, out, detect_unbounded_target) {
                    return true;
                }
                if self.collect_cycle_refs(end, target, out, detect_unbounded_target) {
                    return true;
                }
            }
            Expr::Call(callee, args) => {
                if self.collect_cycle_refs(callee, target, out, detect_unbounded_target) {
                    return true;
                }
                for arg in args {
                    if self.collect_cycle_refs(arg, target, out, detect_unbounded_target) {
                        return true;
                    }
                }
            }
            Expr::SheetRef { .. }
            | Expr::SheetRange { .. }
            | Expr::Number(_)
            | Expr::Text(_)
            | Expr::Bool(_)
            | Expr::Error(_)
            | Expr::Name(_)
            | Expr::ArrayLit { .. } => {}
        }
        false
    }

    /// Static cycle detection (B.2). Returns true iff installing `expr` at
    /// `target` would close a same-sheet dep cycle.
    fn closes_local_cycle(&self, target: CellAddress, expr: &Expr) -> bool {
        let mut stack: Vec<CellAddress> = Vec::new();
        // Keep the established direct whole-row/whole-column self-reference
        // behavior: install the formula and let runtime evaluation surface the
        // cycle. Once the walk follows another formula, an unbounded range
        // containing `target` is a real install-time back-edge.
        if self.collect_cycle_refs(expr, target, &mut stack, false) {
            return true;
        }
        let mut seen: HashSet<CellAddress> = HashSet::new();
        while let Some(addr) = stack.pop() {
            if !seen.insert(addr) {
                continue;
            }
            if let Some(next) = self.cycle_expr_for(addr) {
                if self.collect_cycle_refs(&next, target, &mut stack, true) {
                    return true;
                }
            }
        }
        false
    }

    fn has_direct_unbounded_target_ref(expr: &Expr, target: CellAddress) -> bool {
        match expr {
            Expr::Range { start, end, .. } => {
                let range = CellRange::new(*start, *end).normalize();
                (range.end.row == u32::MAX || range.end.col == u32::MAX) && range.contains(target)
            }
            Expr::BinOp { left, right, .. } => {
                Self::has_direct_unbounded_target_ref(left, target)
                    || Self::has_direct_unbounded_target_ref(right, target)
            }
            Expr::Negate(inner) | Expr::SpillRef(inner) => {
                Self::has_direct_unbounded_target_ref(inner, target)
            }
            Expr::FuncCall { args, .. } | Expr::MultiArea(args) => args
                .iter()
                .any(|arg| Self::has_direct_unbounded_target_ref(arg, target)),
            Expr::DynamicRange { start, end } => {
                Self::has_direct_unbounded_target_ref(start, target)
                    || Self::has_direct_unbounded_target_ref(end, target)
            }
            Expr::Call(callee, args) => {
                Self::has_direct_unbounded_target_ref(callee, target)
                    || args
                        .iter()
                        .any(|arg| Self::has_direct_unbounded_target_ref(arg, target))
            }
            Expr::CellRef(_)
            | Expr::SheetRef { .. }
            | Expr::SheetRange { .. }
            | Expr::Number(_)
            | Expr::Text(_)
            | Expr::Bool(_)
            | Expr::Error(_)
            | Expr::Name(_)
            | Expr::ArrayLit { .. } => false,
        }
    }

    /// Static cycle check for a formula that was already present in parked
    /// source topology. The temporary reachable graph lets one cold read
    /// certify every reachable non-cyclic formula in O(V+E), while embedded
    /// generation stamps make later reads cut at those formulas. No graph or
    /// edge list survives this call.
    fn closes_parked_local_cycle(
        &self,
        target: CellAddress,
        expr: Rc<Expr>,
        target_checked_at: u64,
    ) -> StaticCycleCheckOutcome {
        let epoch = self.formula_topology_epoch.get();
        if target_checked_at == epoch {
            return StaticCycleCheckOutcome {
                closes_cycle: false,
                target_certified: true,
            };
        }

        let suppress_target_certificate =
            Self::has_direct_unbounded_target_ref(expr.as_ref(), target);
        let mut nodes = vec![StaticCycleNode {
            addr: target,
            expr,
            edges: Vec::new(),
        }];
        let mut node_index: HashMap<CellAddress, usize> = HashMap::new();
        node_index.insert(target, 0);

        let mut cursor = 0;
        while cursor < nodes.len() {
            self.static_cycle_node_visit_count
                .set(self.static_cycle_node_visit_count.get().saturating_add(1));
            let node_expr = Rc::clone(&nodes[cursor].expr);
            let mut refs = Vec::new();
            if self.collect_cycle_refs(node_expr.as_ref(), target, &mut refs, cursor != 0) {
                return StaticCycleCheckOutcome {
                    closes_cycle: true,
                    target_certified: false,
                };
            }

            for addr in refs {
                // The root's direct whole-row/whole-column self-reference is
                // intentionally runtime-checked. Its parked entry was drained
                // before this call, but keep this guard for defensive parity.
                if addr == target {
                    if cursor == 0 && suppress_target_certificate {
                        continue;
                    }
                    return StaticCycleCheckOutcome {
                        closes_cycle: true,
                        target_certified: false,
                    };
                }
                if self.formula_cycle_is_checked(addr, epoch) {
                    continue;
                }
                let Some(next_expr) = self.cycle_expr_for(addr) else {
                    continue;
                };
                let next_index = if let Some(index) = node_index.get(&addr).copied() {
                    index
                } else {
                    let index = nodes.len();
                    node_index.insert(addr, index);
                    nodes.push(StaticCycleNode {
                        addr,
                        expr: next_expr,
                        edges: Vec::new(),
                    });
                    index
                };
                nodes[cursor].edges.push(next_index);
            }
            cursor += 1;
        }

        // Iterative Kosaraju keeps deep spreadsheet chains off the Rust call
        // stack. Both adjacency directions are temporary and released before
        // hydration continues into Store evaluation.
        let mut reverse = vec![Vec::new(); nodes.len()];
        for (from, node) in nodes.iter().enumerate() {
            for &to in &node.edges {
                reverse[to].push(from);
            }
        }

        let mut visited = vec![false; nodes.len()];
        let mut finish_order = Vec::with_capacity(nodes.len());
        for start in 0..nodes.len() {
            if visited[start] {
                continue;
            }
            visited[start] = true;
            let mut stack = vec![(start, 0usize)];
            while let Some(&(node, next_edge)) = stack.last() {
                if next_edge < nodes[node].edges.len() {
                    let next = nodes[node].edges[next_edge];
                    let last = stack.len() - 1;
                    stack[last].1 += 1;
                    if !visited[next] {
                        visited[next] = true;
                        stack.push((next, 0));
                    }
                } else {
                    stack.pop();
                    finish_order.push(node);
                }
            }
        }

        let mut assigned = vec![false; nodes.len()];
        let mut cyclic = vec![false; nodes.len()];
        for &start in finish_order.iter().rev() {
            if assigned[start] {
                continue;
            }
            assigned[start] = true;
            let mut members = Vec::new();
            let mut stack = vec![start];
            while let Some(node) = stack.pop() {
                members.push(node);
                for &next in &reverse[node] {
                    if !assigned[next] {
                        assigned[next] = true;
                        stack.push(next);
                    }
                }
            }
            let is_cycle = members.len() > 1
                || nodes[members[0]]
                    .edges
                    .iter()
                    .any(|&next| next == members[0]);
            if is_cycle {
                for member in members {
                    cyclic[member] = true;
                }
            }
        }

        if cyclic[0] {
            return StaticCycleCheckOutcome {
                closes_cycle: true,
                target_certified: false,
            };
        }
        for index in 1..nodes.len() {
            if !cyclic[index] {
                self.mark_formula_cycle_checked(nodes[index].addr, epoch);
            }
        }
        StaticCycleCheckOutcome {
            closes_cycle: false,
            target_certified: !suppress_target_certificate,
        }
    }

    /// Get a cell's value by address string.
    /// Returns the formula result if the cell has a formula, otherwise the raw value.
    /// Returns Null for cells that haven't been set.
    pub fn get_cell(&self, addr_str: &str) -> Value {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let value = self.peek_value(addr);
        // A bare Store read intentionally parks newly-computed derived states
        // in pending. Public engine reads are transaction boundaries: settle
        // those states now so an unrelated later write does not inherit work
        // proportional to every formula read since the previous mutation.
        self.store.settle_pending_reads();
        value
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
        // LAZY_FORMULA_INDEXING Phase 3: snapshot the formula address
        // sets up front. Both `formula_cells` and `formula_source` may
        // grow during iteration (hydration moves entries from the
        // latter to the former), and the `BTreeMap::range` iterators
        // hold a borrow that conflicts with the `borrow_mut` inside
        // hydration. Collecting addresses first releases the borrows
        // and gives us a stable iteration set.
        let formula_addrs: Vec<CellAddress> = {
            let cells = self.interior.formula_cells.borrow();
            let source = self.interior.formula_source.borrow();
            // Row-major union: each map yields ascending order; merge
            // so duplicates collapse and the final list is ascending
            // too (matches the pre-lazy contract that callers rely on
            // for deterministic snapshots).
            let mut out: Vec<CellAddress> = Vec::with_capacity(cells.len() + source.len());
            let mut a = cells.range_iter(range).map(|(addr, _)| addr).peekable();
            let mut b = source.range_iter(range).map(|(addr, _)| addr).peekable();
            loop {
                match (a.peek().copied(), b.peek().copied()) {
                    (None, None) => break,
                    (Some(x), None) => {
                        out.push(x);
                        a.next();
                    }
                    (None, Some(y)) => {
                        out.push(y);
                        b.next();
                    }
                    (Some(x), Some(y)) => {
                        let xk = (x.row, x.col);
                        let yk = (y.row, y.col);
                        if xk == yk {
                            // Co-existence invariant says this should
                            // never happen, but guard defensively so
                            // duplicate emit can't break callers that
                            // assume distinct addresses.
                            out.push(x);
                            a.next();
                            b.next();
                        } else if xk < yk {
                            out.push(x);
                            a.next();
                        } else {
                            out.push(y);
                            b.next();
                        }
                    }
                }
            }
            out
        };

        // P4a borrow rule: snapshot the primitive addresses in range so no
        // `cells` borrow is held across `cell_value_at` (store read) or the
        // caller's `f`. Membership can't change during the loop (`&self`),
        // so the per-iteration formula-map checks below observe the same
        // set the live iteration did.
        let prim_addrs: Vec<CellAddress> = self
            .interior
            .cells
            .borrow()
            .range_iter(range)
            .map(|(addr, _)| addr)
            .collect();
        for addr in prim_addrs {
            // Skip primitives that have been upgraded to formulas — the
            // formula pass below will emit the formula value at this addr.
            // Address-equality check stays O(1) (BTreeMap point lookup).
            // Both hydrated and lazy formulas count.
            if self.interior.formula_cells.borrow().contains_key(&addr)
                || self.interior.formula_source.borrow().contains_key(&addr)
            {
                continue;
            }
            let Some(value) = self.cell_value_at(addr) else {
                continue;
            };
            if matches!(value, Value::Null) {
                continue;
            }
            f(addr, value);
        }
        for addr in formula_addrs {
            let v = value_resolver(self, addr);
            f(addr, v);
        }
    }

    pub(crate) fn peek_value_with_provider(
        &self,
        addr: CellAddress,
        _provider: &dyn EvalProvider,
    ) -> Value {
        // LAZY_FORMULA_INDEXING Phase 3: hydrate before the
        // `formula_cells` / `cells` branch decision so an unhydrated
        // formula at `addr` doesn't fall through to
        // `primitive_value_at` (which would return whatever stale
        // primitive scaffold the bulk-load left behind). Hydration is
        // idempotent and `&self`-only via internal `RefCell`s.
        self.hydrate_formula(addr);
        let formula = self.interior.formula_cells.borrow().get(&addr).cloned();
        if formula.is_some() {
            let facade = self.facade_of(addr);
            return self.store.get(facade);
        }
        self.cell_value_at(addr).unwrap_or(Value::Null)
    }

    /// Get the AtomId for a cell (creating if needed).
    pub fn cell_atom(&mut self, addr_str: &str) -> AtomId {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.readable_atom(addr)
    }

    // === LAZY_FORMULA_EVAL Step 0 — debug counters ===
    //
    // These expose lazy formula and Store materialization behavior for
    // tests / benches / dev tooling.
    //
    // All `#[doc(hidden)]` — not part of the public API surface, intended
    // for tests / benches / dev tooling.

    /// Number of non-empty primitive cell slots — parked plain values
    /// (AUDIT B-2 lazy atomization) plus materialized atoms. One per
    /// address that has been set or referenced from a formula. Empty
    /// addresses don't count even if subscribed (verified by
    /// `subscribe_empty_cell_does_not_materialize_until_write`). For the
    /// materialized-atom subset only, see
    /// `debug_materialized_cell_atom_count`.
    #[doc(hidden)]
    pub fn debug_primitive_atom_count(&self) -> usize {
        self.interior.cells.borrow().len()
    }

    /// Number of primitive cell slots that hold a real store atom
    /// (`CellSlot::Atom`). AUDIT B-2 pin: a primitives-only bulk install
    /// leaves this at 0 — atoms allocate on first subscribe / write /
    /// spill registration, never eagerly.
    #[doc(hidden)]
    pub fn debug_materialized_cell_atom_count(&self) -> usize {
        self.interior
            .cells
            .borrow()
            .iter()
            .filter(|(_, slot)| matches!(slot, CellSlot::Atom(_)))
            .count()
    }

    /// Number of logical formula cells. Hydrated same-sheet formulas own a
    /// core formula-inner derived atom; this counter measures formula
    /// addresses rather than atom count.
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: counts hydrated formulas (in
    /// `formula_cells`) plus parked lazy formulas (in `formula_source`).
    /// The scale suite relies on this returning N immediately after
    /// `bulk_load` of N formulas, even if no reads have hydrated yet.
    #[doc(hidden)]
    pub fn debug_formula_count(&self) -> usize {
        self.interior.formula_cells.borrow().len() + self.interior.formula_source.borrow().len()
    }

    /// Number of formulas that currently depend on the cell at `addr`.
    #[doc(hidden)]
    pub fn debug_dependents_count(&self, addr_str: &str) -> usize {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return 0;
        };
        let mut roots = Vec::new();
        self.store_root_atoms_for_addr_into(addr, &mut roots);
        self.store_dependent_formula_addrs_from_atoms(&roots).len()
    }

    /// Formula-inner Store state without evaluating the formula. Parked or
    /// not-yet-materialized formulas report `dirty`; a settled derived atom
    /// reports `clean`.
    #[doc(hidden)]
    pub fn debug_formula_cache_state(&self, addr_str: &str) -> &'static str {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return "invalid";
        };
        // LAZY_FORMULA_INDEXING Phase 3: report unhydrated formulas
        // as "dirty" — they have no FormulaRecord yet, but
        // semantically they would compute fresh on the next read
        // (matches the pre-lazy contract: every just-imported
        // formula starts dirty).
        if self.interior.needs_parse.borrow().contains(&addr) {
            return "dirty";
        }
        if !self.interior.formula_cells.borrow().contains_key(&addr) {
            return "none";
        }
        let Some(inner) = self.formula_inner_family.borrow().get(&addr) else {
            return "dirty";
        };
        if self.store.debug_atom_is_fresh(inner) {
            "clean"
        } else {
            "dirty"
        }
    }

    /// Total live sheet-owned core atoms, including primitive slots, facade /
    /// epoch atoms, range geometry epochs, and formula-inner derived atoms.
    /// Useful as a gross "did anything materialize?" signal in tests.
    #[doc(hidden)]
    pub fn debug_total_atom_count(&self) -> usize {
        // Sheet-local count (P3): with the workbook-shared store,
        // store.debug_total_atom_count() would sum every sheet.
        self.atoms_owned.get()
    }

    /// Cumulative core derived recompute count from the underlying store.
    /// Formula-inner and facade recomputes are part of the atomm path and are
    /// reflected here, including workbook-scoped reads in the shared Store.
    #[doc(hidden)]
    pub fn debug_recompute_count(&self) -> usize {
        self.store.debug_recompute_count()
    }

    /// Total formula evaluations performed since the sheet was created.
    /// Bumped once per completed formula-inner evaluation; settled Store reads
    /// are free. Used by the Phase 1 scale suite to assert
    /// `bulk_load` does no eager eval and viewport reads only evaluate
    /// visible formulas.
    #[doc(hidden)]
    pub fn debug_formula_eval_count(&self) -> usize {
        self.formula_eval_count.get()
    }

    /// Number of formula records without a settled formula-inner Store value,
    /// plus parked formulas awaiting hydration.
    #[doc(hidden)]
    pub fn debug_dirty_count(&self) -> usize {
        // LAZY_FORMULA_INDEXING Phase 3: also count unhydrated lazy
        // formulas — they're semantically Dirty (will compute on
        // first read). Counting just the hydrated cells would let the
        // scale suite's "N dirty after bulk_load" assertion drop to
        // zero after lazy bulk_load even though every cell is still
        // "pending compute".
        let hydrated_addrs: Vec<CellAddress> =
            self.interior.formula_cells.borrow().keys().collect();
        let family = self.formula_inner_family.borrow();
        let hydrated_dirty = hydrated_addrs
            .into_iter()
            .filter(|addr| {
                family
                    .get(addr)
                    .is_none_or(|id| !self.store.debug_atom_is_fresh(id))
            })
            .count();
        hydrated_dirty + self.interior.needs_parse.borrow().len()
    }

    /// Number of formulas registered via `bulk_load` (cumulative since the
    /// sheet was created). The plain `Sheet::set_formula` path does NOT
    /// increment this. Used by the scale suite to verify the import path
    /// is exercised and to distinguish bulk-loaded from live-edited formulas.
    #[doc(hidden)]
    pub fn debug_imported_formula_count(&self) -> usize {
        self.imported_formula_count.get()
    }

    /// Cumulative Store reverse-dependency formula visits since the sheet was
    /// created. Scale-suite complexity probe: the total eager spill work of a
    /// workload is `delta(this)` and must be bounded by formulas reachable
    /// from the changed cell/facade/geometry roots.
    #[doc(hidden)]
    pub fn debug_reverse_dep_visit_count(&self) -> u64 {
        self.reverse_dep_visit_count.get()
    }

    /// Cumulative number of formula AST nodes expanded by parked-formula
    /// static cycle validation. A topology certificate hit adds zero.
    #[doc(hidden)]
    pub fn debug_static_cycle_node_visit_count(&self) -> u64 {
        self.static_cycle_node_visit_count.get()
    }

    /// Number of active spill anchors (entries in the `spill_targets`
    /// bookkeeping map). Scale-suite leak probe: clearing an anchor must
    /// return this to its pre-spill baseline.
    #[doc(hidden)]
    pub fn debug_spill_anchor_count(&self) -> usize {
        self.spill_targets.len()
    }

    /// Total number of installed spill TARGET cells across all anchors
    /// (sum of `spill_targets` value lengths; excludes the anchors
    /// themselves). Scale-suite leak probe companion to
    /// `debug_spill_anchor_count`.
    #[doc(hidden)]
    pub fn debug_spill_target_count(&self) -> usize {
        self.spill_targets.values().map(|t| t.len()).sum()
    }

    /// Size of the AUDIT A-8 reverse spill index (`target address →
    /// anchor`). Scale-suite invariant probe: must equal
    /// `debug_spill_target_count()` at all times — install, re-spill,
    /// teardown — or the O(1) write guards are consulting a stale map.
    #[doc(hidden)]
    pub fn debug_spill_reverse_index_len(&self) -> usize {
        self.spill_target_anchor.len()
    }

    /// Size of the anchor-address index (`anchor atom → anchor addr`,
    /// A-8 follow-up). Scale-suite invariant probe: must equal
    /// `debug_spill_anchor_count()` at all times — install, re-spill,
    /// structural shift, teardown — or `teardown_all_spills` is reading
    /// stale anchor addresses.
    #[doc(hidden)]
    pub fn debug_spill_anchor_index_len(&self) -> usize {
        self.spill_anchor_addr.len()
    }

    /// Cumulative `has_address_subscribers` probes performed by
    /// `BulkLoader::flush`'s notify tail (AUDIT B-5). Stays flat across
    /// a bulk load when the sheet has zero address subscriptions.
    #[doc(hidden)]
    pub fn debug_bulk_notify_probe_count(&self) -> u64 {
        self.bulk_notify_probe_count.get()
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

    /// Number of materialized Store geometry roots used by large range
    /// formulas. Small ranges depend on member facades directly and therefore
    /// contribute zero here.
    #[doc(hidden)]
    pub fn debug_range_dep_count(&self) -> usize {
        self.range_band_epoch_family.borrow().len()
            + self.range_column_epoch_family.borrow().len()
            + self.range_sheet_epoch_family.borrow().len()
    }

    /// Number of already-materialized Store geometry roots touched by an
    /// address (row band, column, and/or sheet-wide root). This is a
    /// non-creating lookup.
    #[doc(hidden)]
    pub fn debug_range_dep_candidates(&self, addr_str: &str) -> usize {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return 0;
        };
        let mut roots = Vec::new();
        self.store_root_range_geometry_atoms_for_addr_into(addr, &mut roots);
        roots.len()
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

    /// Compatibility stats probe. Reports hydrated formula/static-range
    /// metadata and Store geometry-root counts so bench/trace tooling can
    /// quantify materialization. Legacy point-fanout fields stay zero.
    ///
    /// Costs O(hydrated formula count), suitable only for diagnostics.
    #[doc(hidden)]
    pub fn debug_dep_graph_stats(&self) -> DepGraphStats {
        let total_range_entries = self.debug_range_dep_count() as u64;
        // Count hydrated formula records with static range metadata. This is
        // structural information, not reactive fanout.
        //
        // LAZY_FORMULA_INDEXING Phase 3: unhydrated formulas are not counted
        // here because their static metadata has not been installed yet.
        let range_formula_count = self
            .interior
            .formula_cells
            .borrow()
            .values()
            .filter(|record| !record.static_ranges.borrow().is_empty())
            .count() as u64;

        DepGraphStats {
            // `formula_count` reflects HYDRATED formulas only so the
            // stats probe surfaces how much formula state is materialized.
            // The total formula count (hydrated +
            // lazy) is exposed via `debug_formula_count`.
            formula_count: self.interior.formula_cells.borrow().len() as u64,
            total_point_dep_edges: 0,
            total_range_dep_entries: total_range_entries,
            max_fanout: 0,
            range_formula_count,
        }
    }

    /// Number of addresses in the deleted point-dependency index. Kept
    /// as a compatibility probe for older scale tests; always zero now
    /// that same-sheet point formulas delegate through atom edges.
    #[doc(hidden)]
    pub fn debug_point_dependency_key_count(&self) -> usize {
        0
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
        // LAZY_FORMULA_INDEXING Phase 3: hydrated formulas live in
        // `formula_texts`, lazy ones live in `formula_source`. Check
        // both so the formula bar shows the source even before first
        // read.
        if let Some(t) = self.interior.formula_texts.borrow().get(&addr) {
            return Some(t.clone());
        }
        self.interior
            .formula_source
            .borrow()
            .get(&addr)
            .map(|s| s.source.as_ref().to_string())
    }

    /// Is there a formula at `addr`? Used by `ISFORMULA(reference)` via
    /// the `EvalProvider::cell_has_formula` hook.
    pub fn has_formula_at(&self, addr: CellAddress) -> bool {
        // LAZY_FORMULA_INDEXING Phase 3: lazy formulas are still
        // formulas — ISFORMULA must observe them.
        self.interior.formula_cells.borrow().contains_key(&addr)
            || self.interior.needs_parse.borrow().contains(&addr)
    }

    /// Source formula text at `addr`, if any. Used by
    /// `FORMULATEXT(reference)` via the `EvalProvider::cell_formula_text`
    /// hook. Returns a clone of the stored source (leading `=`
    /// included) — the cost is bounded by the formula length, so cloning
    /// per call is acceptable for the formula-bar / `FORMULATEXT` use
    /// case.
    pub fn formula_text_at(&self, addr: CellAddress) -> Option<String> {
        if let Some(t) = self.interior.formula_texts.borrow().get(&addr) {
            return Some(t.clone());
        }
        self.interior
            .formula_source
            .borrow()
            .get(&addr)
            .map(|s| s.source.as_ref().to_string())
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
        // LAZY_FORMULA_INDEXING Phase 3: snapshot addresses up front so
        // the inner closure can hydrate / mutate without conflicting
        // borrows. Iteration covers hydrated formulas AND lazy parked
        // formulas — both are "non-empty" from the snapshot caller's
        // POV.
        let formula_addrs: Vec<CellAddress> = {
            let cells = self.interior.formula_cells.borrow();
            let source = self.interior.formula_source.borrow();
            let mut out: Vec<CellAddress> = Vec::with_capacity(cells.len() + source.len());
            out.extend(cells.iter().map(|(a, _)| a));
            for (a, _) in source.iter() {
                if !cells.contains_key(&a) {
                    out.push(a);
                }
            }
            out
        };
        for addr in formula_addrs {
            f(addr);
        }
        // Snapshot the formula key set once so the inner closure cost
        // doesn't pay a per-cell `RefCell::borrow`.
        let formula_keys: HashSet<CellAddress> = {
            let cells = self.interior.formula_cells.borrow();
            let source = self.interior.formula_source.borrow();
            cells.keys().chain(source.keys()).collect()
        };
        // P4a borrow rule: snapshot the primitive keys so no `cells`
        // borrow is held across the caller's `f` (row-major order kept).
        let prim_addrs: Vec<CellAddress> = self.interior.cells.borrow().keys().collect();
        for addr in prim_addrs {
            if formula_keys.contains(&addr) || !self.primitive_slot_has_visible_value(addr) {
                continue;
            }
            f(addr);
        }
    }

    /// Iterate every non-empty address inside `range` without reading cell
    /// values. Formula entries are reported by address only, so this does
    /// not evaluate or materialize Store-derived formula values.
    pub fn for_each_non_empty_in_range(&self, range: CellRange, mut f: impl FnMut(CellAddress)) {
        // LAZY_FORMULA_INDEXING Phase 3: same snapshot pattern as
        // `for_each_non_empty`.
        let formula_addrs: Vec<CellAddress> = {
            let cells = self.interior.formula_cells.borrow();
            let source = self.interior.formula_source.borrow();
            let mut out: Vec<CellAddress> = Vec::new();
            out.extend(cells.range_iter(range).map(|(a, _)| a));
            for (a, _) in source.range_iter(range) {
                if !cells.contains_key(&a) {
                    out.push(a);
                }
            }
            out
        };
        for addr in formula_addrs {
            f(addr);
        }
        // AUDIT A-3: dedup per visited address (two map probes per cell
        // actually inside the range) instead of materializing a HashSet
        // over the ENTIRE sheet's formula key space — the global
        // snapshot made a one-cell `clear_range` O(total formulas).
        // Borrows are taken per iteration so `f` stays free to re-enter
        // sheet state, matching the old snapshot pattern's guarantees.
        // P4a borrow rule: the in-range primitive keys are snapshotted
        // first so no `cells` borrow is held across `f`.
        let prim_addrs: Vec<CellAddress> = self
            .interior
            .cells
            .borrow()
            .range_iter(range)
            .map(|(addr, _)| addr)
            .collect();
        for addr in prim_addrs {
            if self.interior.formula_cells.borrow().contains_key(&addr)
                || self.interior.formula_source.borrow().contains_key(&addr)
                || !self.primitive_slot_has_visible_value(addr)
            {
                continue;
            }
            f(addr);
        }
    }

    /// Clear every non-empty address inside `range` without materializing
    /// holes. Uses bulk-load so Store publication and subscriber notification
    /// are coalesced once after the sparse scan.
    pub fn clear_range(&mut self, range: CellRange) -> usize {
        let mut addrs = Vec::new();
        self.for_each_non_empty_in_range(range, |addr| addrs.push(addr));
        let cleared = addrs.len();
        self.bulk_load(|loader| {
            for addr in addrs {
                // AUDIT A-9 (folded into A-3): typed-address entry —
                // no to_string→re-parse round trip per cleared cell.
                loader.set_cell_at(addr, Value::Null);
            }
        });
        cleared
    }

    /// Collect every non-empty address as an `"A1"`-style string. Cheap
    /// convenience wrapper around `for_each_non_empty` for wasm exposure.
    pub fn non_empty_addrs(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(
            self.interior.formula_cells.borrow().len()
                + self.interior.formula_source.borrow().len()
                + self.interior.cells.borrow().len(),
        );
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
    /// Format changes do not publish formula Store roots, but they DO fire the
    /// address listener so views can re-style without recomputing the value.
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

        self.formats.retain(|addr, _| !normalized.contains(*addr));
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
        self.formats.retain(|addr, _| !normalized.contains(*addr));
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
        self.apply_structural_shift(crate::shift::ShiftEdit::RowInsert { at, count });
    }

    /// Delete `count` rows starting at `at`. References inside the deleted
    /// range become `#REF!`; references below shift up.
    pub fn delete_row(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.apply_structural_shift(crate::shift::ShiftEdit::RowDelete { at, count });
    }

    pub fn insert_col(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.apply_structural_shift(crate::shift::ShiftEdit::ColInsert { at, count });
    }

    pub fn delete_col(&mut self, at: u32, count: u32) {
        if count == 0 {
            return;
        }
        self.apply_structural_shift(crate::shift::ShiftEdit::ColDelete { at, count });
    }

    /// Shared body of the four structural ops.
    ///
    /// AUDIT A-1: structural edits no longer hydrate the sheet. The old
    /// shape (`hydrate_all_lazy_formulas` first, so the AST retarget
    /// covers parked formulas — the 7d0e380 self-cycle fix) made one
    /// `insert_row` O(total formulas × parse) and left a lazy sheet
    /// permanently eager. Now:
    ///
    ///   - HYDRATED formulas: `retarget_formula_refs` maps the AST and
    ///     installs the mapped result DIRECTLY (no render→re-parse) —
    ///     and skips reinstall entirely when the shift didn't touch the
    ///     formula's refs.
    ///   - LAZY (parked) formulas: `retarget_parked_sources` rewrites
    ///     reference tokens in the parked SOURCE TEXT
    ///     (`shift::rewrite_parked_source`, pure string work — no
    ///     parse, no dep install), preserving the 7d0e380 invariant
    ///     that the text always references post-shift addresses before
    ///     hydration can run (`A1="=A2"` + insert_row(0,1) ⇒ text
    ///     `=A3` at the relocated A2 — no self-cycle).
    ///
    /// W1.1 (A-5) is preserved: spills are torn down before the shift
    /// and surviving anchors re-derived after both retargets.
    fn apply_structural_shift(&mut self, edit: crate::shift::ShiftEdit) {
        self.with_structural_edit(|sheet| {
            // AUDIT A-5: tear every spill down BEFORE the shift,
            // re-derive surviving anchors after the retarget. Anchors
            // inside a deleted band map to the REF_INVALID sentinel and
            // are skipped by `rederive_spill_anchors`.
            let spill_anchors = sheet.teardown_all_spills();
            match edit {
                crate::shift::ShiftEdit::RowDelete { at, count } => {
                    sheet.drop_cells_in(|addr| addr.row >= at && addr.row < at + count);
                }
                crate::shift::ShiftEdit::ColDelete { at, count } => {
                    sheet.drop_cells_in(|addr| addr.col >= at && addr.col < at + count);
                }
                _ => {}
            }
            sheet.relocate_cells(|addr| edit.apply(addr));
            sheet.retarget_formula_refs(edit);
            sheet.retarget_parked_sources(edit);
            match edit {
                crate::shift::ShiftEdit::RowInsert { at, count } => {
                    Self::shift_dimension_insert(&mut sheet.row_heights, at, count);
                }
                crate::shift::ShiftEdit::RowDelete { at, count } => {
                    Self::shift_dimension_delete(&mut sheet.row_heights, at, count);
                }
                crate::shift::ShiftEdit::ColInsert { at, count } => {
                    Self::shift_dimension_insert(&mut sheet.col_widths, at, count);
                }
                crate::shift::ShiftEdit::ColDelete { at, count } => {
                    Self::shift_dimension_delete(&mut sheet.col_widths, at, count);
                }
            }
            sheet
                .rederive_spill_anchors(spill_anchors.into_iter().map(|a| edit.apply(a)).collect());
            sheet.prune_obsolete_formula_atoms();
        });
    }

    /// AUDIT A-5 — snapshot and tear down every active spill ahead of a
    /// structural shift. `spill_targets` stores target *addresses* keyed
    /// by anchor *atom id*; neither survives `relocate_cells` coherently
    /// (the audit's stale-bookkeeping panic). Instead of remapping keys,
    /// the chosen design tears everything down pre-shift and re-derives
    /// surviving anchors post-shift (`rederive_spill_anchors`), so spills
    /// always re-flow contiguously from the (possibly shifted) anchor —
    /// Excel's recompute-after-structural-edit contract.
    ///
    /// Returns the pre-shift anchor addresses. `clear_spill` removes the
    /// derived target atoms; each anchor's primitive (holding the
    /// `Value::Array`) stays in `cells` and is shifted by
    /// `relocate_cells` like any other primitive.
    fn teardown_all_spills(&mut self) -> Vec<CellAddress> {
        let anchor_atoms: Vec<AtomId> = self.spill_targets.keys().copied().collect();
        let mut anchors = Vec::with_capacity(anchor_atoms.len());
        for anchor_atom in anchor_atoms {
            if let Some(addr) = self.anchor_address_for(anchor_atom) {
                anchors.push(addr);
            }
            self.clear_spill(anchor_atom);
        }
        anchors
    }

    /// AUDIT A-5 — re-run the eager array-formula maintenance at each
    /// (already shifted) anchor address after a structural edit.
    /// Addresses mapped into the deleted band carry the `REF_INVALID`
    /// sentinel and are skipped; anchors whose formula record was
    /// dropped by `drop_cells_in` are no-ops inside
    /// `recompute_array_formula`.
    fn rederive_spill_anchors(&mut self, shifted_anchors: Vec<CellAddress>) {
        for addr in shifted_anchors {
            if addr.row == crate::shift::REF_INVALID_ROW
                || addr.col == crate::shift::REF_INVALID_COL
            {
                continue;
            }
            self.recompute_array_formula(addr);
        }
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

        // A structural shift rewrites many cell, epoch, and formula atoms.
        // Keep those writes in one Store transaction so dependents observe
        // only the final topology and propagation walks the atomm graph once.
        self.bump_formula_topology_epoch();
        let store = self.store.clone();
        store.batch(|_| f(self));

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
        // Codex P1 #2 fix: collect EVERY address in the deleted band
        // across the four cell/formula maps — primitive cells, hydrated
        // formula records, AND lazy parked formulas
        // (`formula_source` / `needs_parse`). The pre-fix version only
        // walked `interior.cells.keys()`, so lazy-only entries inside the
        // band survived `drop_cells_in` and were later relocated through
        // `f(addr)` into `REF_INVALID_*` sentinels, where they panic
        // `non_empty_addrs()` (cell.rs:58 add overflow on `row + 1`).
        let mut to_drop: HashSet<CellAddress> = HashSet::new();
        to_drop.extend(self.interior.cells.borrow().keys().filter(|a| pred(*a)));
        // `HashMap::keys` yields `&CellAddress`; `RowMajorMap::keys` yields
        // owned `CellAddress`. Normalise both with copied().
        to_drop.extend(
            self.interior
                .formula_cells
                .borrow()
                .keys()
                .filter(|a| pred(*a)),
        );
        to_drop.extend(
            self.interior
                .formula_source
                .borrow()
                .keys()
                .filter(|a| pred(*a)),
        );
        for addr in to_drop {
            self.drop_cell_slot(addr);
            // `remove_formula_record` already drains `formula_source` +
            // `needs_parse` first (LAZY_FORMULA_INDEXING Phase 3) so a
            // lazy-only entry is cleaned up even though no eager record
            // exists for it.
            self.remove_formula_record(addr);
            self.invalidate_formula_inner(addr);
            self.bump_facade_epoch(addr);
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
        // `drain_into_vec` empties `interior.cells` / `interior.formula_cells`
        // and hands back row-major (addr, value) pairs we reinsert under the
        // shifted addresses. P4a borrow rule: each drain lands in an owned
        // `Vec` in its own statement, so no `interior` borrow is held
        // across the rebuild loops.
        let mut changed_addrs: HashSet<CellAddress> = HashSet::new();
        let mut new_cells: RowMajorMap<CellSlot> = RowMajorMap::new();
        let drained_cells = self.interior.cells.borrow_mut().drain_into_vec();
        for (addr, slot) in drained_cells {
            let next = f(addr);
            if next != addr {
                changed_addrs.insert(addr);
                changed_addrs.insert(next);
            }
            new_cells.insert(next, slot);
        }
        let mut new_formula_cells: RowMajorMap<Rc<FormulaRecord>> = RowMajorMap::new();
        let drained_formula_cells = self.interior.formula_cells.borrow_mut().drain_into_vec();
        for (addr, record) in drained_formula_cells {
            let next = f(addr);
            if next != addr {
                changed_addrs.insert(addr);
                changed_addrs.insert(next);
            }
            new_formula_cells.insert(next, record);
        }
        let new_formula_exprs: HashMap<CellAddress, Rc<Expr>> =
            std::mem::take(&mut *self.interior.formula_exprs.borrow_mut())
                .into_iter()
                .map(|(addr, expr)| {
                    let next = f(addr);
                    if next != addr {
                        changed_addrs.insert(addr);
                        changed_addrs.insert(next);
                    }
                    (next, expr)
                })
                .collect();
        let new_formula_texts: HashMap<CellAddress, String> =
            std::mem::take(&mut *self.interior.formula_texts.borrow_mut())
                .into_iter()
                .map(|(addr, text)| {
                    let next = f(addr);
                    if next != addr {
                        changed_addrs.insert(addr);
                        changed_addrs.insert(next);
                    }
                    (next, text)
                })
                .collect();
        // LAZY_FORMULA_INDEXING Phase 3: relocate parked lazy formula
        // entries too. `formula_source` is keyed by addr; `needs_parse`
        // is a set of addrs. Both get the same shift.
        let mut new_formula_source: RowMajorMap<ParkedFormula> = RowMajorMap::new();
        let drained_formula_source = self.interior.formula_source.borrow_mut().drain_into_vec();
        for (addr, src) in drained_formula_source {
            let next = f(addr);
            if next != addr {
                changed_addrs.insert(addr);
                changed_addrs.insert(next);
            }
            new_formula_source.insert(next, src);
        }
        let new_needs_parse: HashSet<CellAddress> =
            std::mem::take(&mut *self.interior.needs_parse.borrow_mut())
                .into_iter()
                .map(|addr| {
                    let next = f(addr);
                    if next != addr {
                        changed_addrs.insert(addr);
                        changed_addrs.insert(next);
                    }
                    next
                })
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
        *self.interior.cells.borrow_mut() = new_cells;
        *self.interior.formula_cells.borrow_mut() = new_formula_cells;
        *self.interior.formula_exprs.borrow_mut() = new_formula_exprs;
        *self.interior.formula_texts.borrow_mut() = new_formula_texts;
        *self.interior.formula_source.borrow_mut() = new_formula_source;
        *self.interior.needs_parse.borrow_mut() = new_needs_parse;
        self.formats = new_formats;
        self.range_formats = new_range_formats;
        for addr in changed_addrs {
            self.invalidate_formula_inner(addr);
            self.bump_facade_epoch(addr);
        }
        // Formula dependency edges need no address-index rebuild. Retargeting
        // below invalidates affected formula-inner/facade atoms; their next
        // Store read records the remapped dependencies.
    }

    /// Apply a structural edit to every HYDRATED formula AST. Used after
    /// structural edits so formulas continue to point at the same
    /// logical cell.
    ///
    /// The mapped AST is installed directly, without a render/re-parse round
    /// trip. Formulas whose AST is unchanged retain their structural record
    /// and settled Store-derived value when that is provably safe:
    ///
    ///   - mapped AST == old AST means every STATIC ref points at a
    ///     cell strictly below the edit boundary, i.e. a cell that did
    ///     not move — the derived value remains fresh…
    ///   - …unless a static range can see the shifted region
    ///     (`ShiftEdit::touches_range`: unbounded `A:A` under a row
    ///     edit, etc.) or expanded static point metadata moved/died. In that
    ///     case formula-inner and facade are invalidated.
    ///
    /// Reactive edges are never rebuilt here. They are owned by Store and are
    /// re-recorded when an invalidated formula-inner next derives its value.
    fn retarget_formula_refs(&mut self, edit: crate::shift::ShiftEdit) {
        let f = |addr: CellAddress| edit.apply(addr);
        let snapshot: Vec<(CellAddress, Rc<Expr>)> = self
            .interior
            .formula_exprs
            .borrow()
            .iter()
            .map(|(addr, expr)| (*addr, expr.clone()))
            .collect();
        for (addr, old_expr) in snapshot {
            let new_expr = crate::shift::map_addrs(&old_expr, &f);
            if crate::shift::contains_invalid_ref(&new_expr) {
                // Formula references a cell deleted by this structural edit.
                // Excel produces #REF!.
                self.write_error(addr, ValueError::InvalidRef);
                continue;
            }
            if new_expr == *old_expr {
                // Shift didn't touch any static ref. Keep the record, but
                // invalidate the Store-derived value when the edit can still
                // change observed values (see doc comment).
                let record = self.interior.formula_cells.borrow().get(&addr).cloned();
                if let Some(record) = record {
                    let static_ref_moved = record.deps.borrow().iter().any(|d| f(*d) != *d);
                    let range_touched = record
                        .static_ranges
                        .borrow()
                        .iter()
                        .any(|r| edit.touches_range(r));
                    if static_ref_moved {
                        // Keep static structural metadata aligned. Deleted
                        // addresses map to the sentinel and are dropped.
                        let remapped: HashSet<CellAddress> = record
                            .deps
                            .borrow()
                            .iter()
                            .map(|d| f(*d))
                            .filter(|d| {
                                d.row != crate::shift::REF_INVALID_ROW
                                    && d.col != crate::shift::REF_INVALID_COL
                            })
                            .collect();
                        *record.deps.borrow_mut() = remapped;
                    }
                    if static_ref_moved || range_touched {
                        // The value may change even though the AST did not.
                        // Store publication from the formula facade wakes its
                        // recorded dependents; the next read refreshes edges.
                        self.invalidate_formula_value(addr);
                    }
                }
                continue;
            }
            // Refs crossed the boundary: install the mapped AST directly and
            // invalidate formula-inner. Render (no re-parse!) only to keep
            // `formula_texts` / `get_formula` truthful.
            let new_expr_rc = Rc::new(new_expr);
            let deps = Sheet::formula_deps_for(&new_expr_rc);
            let static_ranges = collect_range_refs(&new_expr_rc);
            let record = Rc::new(FormulaRecord::new(new_expr_rc.clone(), deps, static_ranges));
            self.interior
                .formula_cells
                .borrow_mut()
                .insert(addr, record);
            self.interior
                .formula_exprs
                .borrow_mut()
                .insert(addr, new_expr_rc.clone());
            self.interior
                .formula_texts
                .borrow_mut()
                .insert(addr, crate::shift::render_formula(&new_expr_rc));
            self.materialize_formula_inner(addr);
            self.invalidate_formula_value(addr);
        }
    }

    /// AUDIT A-1 (lazy half): retarget every PARKED formula by rewriting
    /// reference tokens in its source text — no parse, no hydration, no
    /// dependency work. Runs after `retarget_formula_refs`; `write_error` for
    /// dead refs invalidates the corresponding Store facade normally.
    ///
    /// Cross-sheet scope mirrors the hydrated path exactly: sheet-
    /// qualified refs in this sheet's sources are not shifted, and
    /// other sheets' parked formulas referencing this sheet are not
    /// rewritten (`map_addrs` has never retargeted either).
    fn retarget_parked_sources(&mut self, edit: crate::shift::ShiftEdit) {
        let mut rewrites: Vec<(CellAddress, String)> = Vec::new();
        let mut dead: Vec<CellAddress> = Vec::new();
        {
            let source = self.interior.formula_source.borrow();
            for (addr, src) in source.iter() {
                match crate::shift::rewrite_parked_source(src.source.as_ref(), edit) {
                    crate::shift::SourceRewrite::Unchanged => {}
                    crate::shift::SourceRewrite::Rewritten(s) => rewrites.push((addr, s)),
                    crate::shift::SourceRewrite::DeadRef => dead.push(addr),
                }
            }
        }
        {
            let mut source = self.interior.formula_source.borrow_mut();
            for (addr, s) in rewrites {
                source.insert(addr, ParkedFormula::new(s));
            }
        }
        for addr in dead {
            // Parity guard for unparseable parked sources (possible via
            // `bulk_install_storage`): the hydrated path would surface
            // `#VALUE!` at first read and never see a ref to kill — so
            // a "dead ref" inside garbage stays parked untouched.
            let parses = {
                let source = self.interior.formula_source.borrow();
                source
                    .get(&addr)
                    .map(|src| crate::formula::parse_formula(src.source.as_ref()).is_some())
                    .unwrap_or(false)
            };
            if !parses {
                continue;
            }
            // Mirror the hydrated retarget: the whole formula becomes a
            // #REF! error cell. `write_error` drains the parked state
            // (`remove_formula_record` clears `formula_source` /
            // `needs_parse` first) and invalidates Store dependents through
            // the cell facade.
            self.write_error(addr, ValueError::InvalidRef);
        }
    }

    /// Set multiple cells at once, with a single propagation pass.
    ///
    /// Like `set_cell`, this also clears any existing formula on each target
    /// cell. Store publication is coalesced for the batch without eagerly
    /// computing formula values.
    pub fn batch_set(&mut self, updates: &[(&str, Value)]) {
        let parsed_updates: Vec<(CellAddress, Value)> = updates
            .iter()
            .map(|(addr_str, value)| {
                (
                    CellAddress::parse(addr_str).expect("invalid cell address"),
                    value.clone(),
                )
            })
            .collect();
        let written_addrs: Vec<CellAddress> =
            parsed_updates.iter().map(|(addr, _)| *addr).collect();
        let array_formulas_to_reproject =
            self.store_dependent_array_formula_addrs_from_addrs(written_addrs.iter().copied());

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

        let mut atom_values: Vec<(AtomId, Value)> = Vec::with_capacity(parsed_updates.len());
        let mut pre_range_members: Vec<(CellAddress, bool)> =
            Vec::with_capacity(parsed_updates.len());
        let mut obsolete_formula_addrs = HashSet::new();
        let mut null_addrs = HashSet::new();

        for (addr, value) in parsed_updates {
            let pre_range_member = self.range_member_present(addr);
            pre_range_members.push((addr, pre_range_member));

            if self.interior.formula_cells.borrow().contains_key(&addr)
                || self.interior.needs_parse.borrow().contains(&addr)
            {
                obsolete_formula_addrs.insert(addr);
            }
            self.remove_formula_record(addr);

            let id = self.ensure_cell(addr);
            if matches!(value, Value::Null) {
                null_addrs.insert(addr);
            }
            atom_values.push((id, value));
        }

        self.store_batch(|sheet| {
            for (id, value) in atom_values {
                sheet.store.set(id, value);
            }
            for addr in &written_addrs {
                sheet.invalidate_formula_inner(*addr);
                sheet.bump_facade_epoch(*addr);
            }
            for (addr, pre_range_member) in pre_range_members {
                sheet.bump_range_epochs_if_membership_changed(addr, pre_range_member);
            }
        });
        for addr in null_addrs {
            self.try_release_primitive(addr);
        }
        for addr in obsolete_formula_addrs {
            self.cleanup_obsolete_formula_atoms_at(addr);
        }
        self.recompute_array_formulas_in(&array_formulas_to_reproject);

        for addr in &subscribed {
            self.attach_address_sub(*addr);
        }
        for (addr, pre_val) in pre {
            let post_val = self.peek_value(addr);
            if pre_val != post_val {
                self.notify_address_subscribers(addr);
            }
        }
    }

    // === LAZY_FORMULA_EVAL Step 3 — bulk import API ===

    /// Run `f` inside a Store batch. Writes performed through the `BulkLoader`
    /// update source atoms immediately, while derived propagation is coalesced
    /// until every write in the closure has landed. The loader then restores
    /// direct address subscriptions and publishes each changed address once.
    ///
    /// Use for CSV / JSON / xlsx import paths that write thousands of cells:
    /// the per-cell notify cost would dominate. Already-materialized formulas
    /// rederive once at batch flush; formulas never read remain unmaterialized.
    ///
    /// RAII shape: `BulkLoader` is not exposed outside the closure, so the
    /// flush always runs (no begin/end pair to forget).
    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut BulkLoader<'_>) -> R) -> R {
        let store = self.store.clone();
        let mut loader = BulkLoader::new(self);
        let mut result = None;
        store.batch(|_| {
            result = Some(f(&mut loader));
        });
        loader.flush();
        result.expect("bulk-load closure did not run")
    }
}

/// In-progress bulk-load session. Writes go directly into the sheet's
/// formula/primitive state while direct address subscriptions are detached;
/// the surrounding Store batch coalesces derived propagation and `flush`
/// restores those subscriptions.
///
/// Only constructable inside `Sheet::bulk_load` (RAII), so the lifetime stays
/// bound to `&mut Sheet` and `flush` is guaranteed to run on the closure exit.
pub struct BulkLoader<'a> {
    sheet: &'a mut Sheet,
    /// Addresses written during this bulk load. At `flush()` we notify each
    /// directly subscribed address whose projected value changed once.
    touched: HashSet<CellAddress>,
    /// Addresses whose sparse range membership changed during the bulk load.
    /// Flush bumps already-materialized range-version atoms for these roots.
    range_membership_changed: HashSet<CellAddress>,
    /// Formula addresses replaced by a primitive/error during this session.
    /// Flush reclaims their now-unreferenced Store-backed family nodes after
    /// the batched epoch changes have settled.
    obsolete_formula_addrs: HashSet<CellAddress>,
}

impl<'a> BulkLoader<'a> {
    fn new(sheet: &'a mut Sheet) -> Self {
        BulkLoader {
            sheet,
            touched: HashSet::new(),
            range_membership_changed: HashSet::new(),
            obsolete_formula_addrs: HashSet::new(),
        }
    }

    /// Write a primitive value at `addr`. Defers Store publication and direct
    /// subscriber notification to `flush`. Equivalent to
    /// `Sheet::set_cell` outside the bulk-load contract; the address is
    /// recorded in `touched` for the post-flush sweep.
    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.set_cell_at(addr, value);
    }

    /// Typed-address variant of [`Self::set_cell`] (AUDIT A-9): bulk
    /// callers that already hold a `CellAddress` (e.g. `clear_range`'s
    /// sparse scan) skip the string render + re-parse per cell.
    pub fn set_cell_at(&mut self, addr: CellAddress, value: Value) {
        let is_null = matches!(value, Value::Null);

        // AUDIT A-4 — spill parity with the single-cell mutators
        // (`Sheet::set_cell` / `try_set_cell`): a write to a non-anchor
        // spill TARGET is skipped (the array stays intact; Excel treats
        // Delete over the ghost cells of a dynamic array as a no-op),
        // and a write to a spill ANCHOR tears the spill down before
        // proceeding. Without the guard, `ensure_cell` below returns
        // the read-only derived spill-target atom and `store.set`
        // panics.
        if self.sheet.spilled_into_anchor(addr).is_some() {
            return;
        }
        let pre_range_member = self.sheet.range_member_present(addr);
        self.sheet.clear_spill_at_address(addr);

        // Detach the fanout for this address so the store-level `set` below
        // does not synchronously fire subscribers. `flush` will reattach and
        // notify exactly once per subscribed touched address.
        self.sheet.detach_address_sub(addr);

        // LAZY_FORMULA_INDEXING Phase 3: lazy and hydrated formulas
        // both transition to primitive here. `remove_formula_record`
        // is a no-op on lazies (no record) — drain `formula_source` /
        // `needs_parse` explicitly so the address stops looking like a
        // formula to any later check.
        let had_formula = self
            .sheet
            .interior
            .formula_cells
            .borrow()
            .contains_key(&addr)
            || self.sheet.interior.needs_parse.borrow().contains(&addr);
        if had_formula {
            self.obsolete_formula_addrs.insert(addr);
            // Formula → primitive transition. Drop the structural formula
            // record, but do not notify yet; primitive scaffold is
            // re-established below.
            self.sheet.remove_formula_record(addr);
            self.sheet
                .interior
                .formula_source
                .borrow_mut()
                .remove(&addr);
            self.sheet.interior.needs_parse.borrow_mut().remove(&addr);
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
        if pre_range_member != self.sheet.range_member_present(addr) {
            self.range_membership_changed.insert(addr);
        }
    }

    /// Write a formula at `addr`. Parses, runs the same-sheet static cycle
    /// check (B.2), and installs structural metadata for lazy Store derivation.
    /// Does not evaluate the formula or notify any subscriber. Returns the same
    /// `bool` contract as `Sheet::set_formula`: `false` on parse failure or
    /// cycle (the cell is left holding `#VALUE!` / `#CYCLE!`, no notify).
    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) -> bool {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.set_formula_at(addr, formula_str)
    }

    /// Typed-address variant of [`Self::set_formula`] (A-9 follow-up):
    /// the `Workbook::bulk_load` replay and any bulk caller that already
    /// holds a `CellAddress` skip the string render + re-parse per cell.
    pub fn set_formula_at(&mut self, addr: CellAddress, formula_str: &str) -> bool {
        // AUDIT A-4 — spill parity with `Sheet::try_set_formula`
        // (`:2331/:2336`): reject writes on a non-anchor spill target
        // (array stays intact), tear down the spill when overwriting
        // the anchor. Runs BEFORE the parse check so the
        // `write_error_no_notify` parse-failure path below can never
        // `store.set` a read-only derived spill-target atom.
        if self.sheet.spilled_into_anchor(addr).is_some() {
            return false;
        }
        self.sheet.clear_spill_at_address(addr);
        // Codex P2 #2 fix: validate parseability up front. If the source
        // does not parse, materialise `#VALUE!` immediately (matching
        // legacy eager behavior) and return `false` — DO NOT park
        // unparseable text into `formula_source`, otherwise
        // `get_formula(addr)` / `ISFORMULA(addr)` would surface the
        // rejected source as a live formula even though its value is
        // `#VALUE!`.
        if crate::formula::parse_formula(formula_str).is_none() {
            self.write_error_no_notify(addr, ValueError::InvalidValue);
            self.touched.insert(addr);
            return false;
        }
        // LAZY_FORMULA_INDEXING Phase 2: defer parse / dep extract /
        // dep register / FormulaRecord materialization. Store the source
        // text and mark `addr` as `needs_parse`; the actual install
        // happens lazily at first read (Phase 3) or eagerly in
        // `hydrate_all_after_load` at `flush` end while Phase 3 lands.
        self.set_formula_lazy(addr, formula_str.to_string())
    }

    /// Variant of `set_formula` that takes a pre-parsed `Expr` plus an
    /// owned source `String`. The `Workbook::bulk_load` flush uses this
    /// to avoid re-parsing the formula the workbook loader already
    /// parsed for its own cross-sheet cycle pre-check.
    ///
    /// Same return contract: `true` on success, `false` (with `#CYCLE!`
    /// written) on same-sheet cycle. `expr` is trusted to be the parse
    /// of `formula_text`; the caller keeps them in sync.
    ///
    /// LAZY_FORMULA_INDEXING Phase 2: the pre-parsed AST is discarded
    /// at this entry point. Only the source string is stored; the
    /// hydrator re-parses on first read. The pre-parse the workbook
    /// loader did is still needed for the cross-sheet cycle check it
    /// ran at queue time, but the AST does not need to survive into the
    /// sheet because the hydrator owns its own parse. Cost of the
    /// re-parse is amortised by the per-call hydration trigger; reads
    /// that never touch the cell never pay it.
    pub(crate) fn set_formula_pre_parsed(
        &mut self,
        addr: CellAddress,
        _expr: Expr,
        formula_text: String,
    ) -> bool {
        self.set_formula_lazy(addr, formula_text)
    }

    /// LAZY_FORMULA_INDEXING Phase 2 core: park `formula_text` in
    /// `Sheet::formula_source` and add `addr` to `Sheet::needs_parse`.
    /// Skips dep extract, dep register, and `FormulaRecord`
    /// materialisation. Touched is still recorded so the existing
    /// structural/subscriber maintenance in `flush()` runs.
    ///
    /// Returns `true` unconditionally — the cycle check is deferred
    /// to first read (matches the TS port's "lazy build, lazy eval"
    /// contract). The cycle-on-write semantics of `set_formula`
    /// outside the bulk-load contract are preserved by D1=4A
    /// (`Sheet::set_formula` keeps its eager parse).
    fn set_formula_lazy(&mut self, addr: CellAddress, formula_text: String) -> bool {
        // AUDIT A-4 — same spill guard as `set_formula`, repeated here
        // so the `set_formula_pre_parsed` entry point (used by
        // `Workbook::bulk_load`) is covered too. `clear_spill_at_address`
        // is idempotent, so the double call on the `set_formula` route
        // is harmless.
        if self.sheet.spilled_into_anchor(addr).is_some() {
            return false;
        }
        let pre_range_member = self.sheet.range_member_present(addr);
        self.sheet.clear_spill_at_address(addr);

        // Detach fanout so any prior-formula / primitive-scaffold
        // teardown below does not double-fire through the listener.
        self.sheet.detach_address_sub(addr);

        // If the address previously had an eagerly-installed formula
        // record (rare for bulk_load but possible in mixed-mode
        // workloads — see `bulk_load_skips_eval_until_first_read`), tear
        // it down so the lazy path is the sole source of truth for this
        // address.
        self.sheet.remove_formula_record(addr);

        // Drop any prior primitive scaffold (no notify); mirrors the
        // primitive→formula transition cleanup in
        // `install_parsed_formula`.
        self.sheet.drop_cell_slot(addr);
        self.sheet.bump_formula_topology_epoch();

        let parsed_for_inner = parse_formula(&formula_text);

        // Park the source text. `Rc<str>` keeps the per-formula heap
        // footprint to one allocation; the hydrator clones the `Rc`
        // (cheap) when it reads back.
        self.sheet
            .interior
            .formula_source
            .borrow_mut()
            .insert(addr, ParkedFormula::new(formula_text));
        self.sheet.interior.needs_parse.borrow_mut().insert(addr);
        if parsed_for_inner.is_some() {
            self.sheet.materialize_formula_inner(addr);
        }
        self.sheet.invalidate_formula_inner(addr);
        self.sheet.bump_facade_epoch(addr);

        // Bump imported-formula counter so the scale suite's
        // `debug_imported_formula_count` reads as N after a 100k import
        // even when no formula has been hydrated. Counts every
        // successful lazy-park (matches the pre-lazy contract: the
        // counter was bumped once per `install_parsed_formula` success;
        // here we count once per `set_formula_lazy` success).
        self.sheet
            .imported_formula_count
            .set(self.sheet.imported_formula_count.get() + 1);

        self.touched.insert(addr);
        if pre_range_member != self.sheet.range_member_present(addr) {
            self.range_membership_changed.insert(addr);
        }
        true
    }

    /// Shared core for `set_formula` / `set_formula_pre_parsed`. Runs
    /// the same-sheet cycle check, installs static metadata, and materializes
    /// the Store-backed formula-inner.
    /// Returns `true` on success; `false` (with `#CYCLE!` written) if
    /// the formula would close a same-sheet cycle. Consumes
    /// `formula_text` to land directly in `formula_texts` without a
    /// trailing `String::clone`.
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: the active bulk_load path is
    /// `set_formula_lazy`. This eager method is preserved for any
    /// future arc that needs a "force-eager" mode or for parity
    /// regression tests; `#[allow(dead_code)]` keeps the build clean
    /// while the code stays available to call.
    #[allow(dead_code)]
    fn install_parsed_formula(
        &mut self,
        addr: CellAddress,
        expr: Expr,
        formula_text: String,
    ) -> bool {
        // Static cycle check still runs inside bulk_load — incremental cycle
        // protection isn't worth dropping for perf, and the cost is bounded by
        // the static reference closure of the new formula.
        if self.sheet.closes_local_cycle(addr, &expr) {
            self.write_error_no_notify(addr, ValueError::CyclicRef);
            self.touched.insert(addr);
            return false;
        }
        let pre_range_member = self.sheet.range_member_present(addr);

        // Detach fanout so any primitive scaffold teardown below does not fire.
        self.sheet.detach_address_sub(addr);

        let expr = Rc::new(expr);
        // Phase 1 instrumentation (bulk_import_trace): retain the public
        // dep_extract / dep_register / formula_record timing fields. P5 has
        // no separate dependency registration, so dep_register is expected
        // to stay near zero. Sample the host clock at the 4
        // sub-phase boundaries (4 calls per formula install) only on
        // the instrumented path; production is zero-cost (one thread-
        // local read + branch). Native uses an `Instant` epoch wrapped
        // in a `fn() -> f64`; wasm32 uses `js_sys::Date::now` —
        // `std::time::Instant` is not available on
        // `wasm32-unknown-unknown`. We do NOT sample around the cheap
        // intervening work (`remove_formula_record` / primitive
        // scaffold teardown); that overhead lives in `flush_ms`
        // minus the sub-phase sum and is interpretable from the
        // existing `engine_total - set_cell - set_formula` residual.
        let clock = crate::bulk_import_trace::flush_phase_clock();
        let t_dep_extract_start = clock.map(|f| f());
        let deps = Sheet::formula_deps_for(&expr);
        let static_ranges = collect_range_refs(&expr);
        // Drop any prior formula record (no notify) and any primitive scaffold
        // that no longer has dependents — mirrors `Sheet::set_formula` minus
        // the `with_remap` listener fire.
        self.sheet.remove_formula_record(addr);
        self.sheet.drop_cell_slot(addr);
        self.sheet.bump_formula_topology_epoch();
        // Move the extracted structural metadata into the `FormulaRecord`.
        let t_dep_register_start = clock.map(|f| f());
        let t_formula_record_start = clock.map(|f| f());
        let record = Rc::new(FormulaRecord::new(expr.clone(), deps, static_ranges));
        self.sheet
            .interior
            .formula_cells
            .borrow_mut()
            .insert(addr, record);
        self.sheet
            .interior
            .formula_exprs
            .borrow_mut()
            .insert(addr, expr.clone());
        // Consume the owned `formula_text` directly — the caller's
        // string allocation lands in `formula_texts` without a
        // `String::clone`.
        self.sheet
            .interior
            .formula_texts
            .borrow_mut()
            .insert(addr, formula_text);
        self.sheet.materialize_formula_inner(addr);
        self.sheet.invalidate_formula_inner(addr);
        self.sheet.bump_facade_epoch(addr);
        if let Some(now_ms) = clock {
            let t_end = now_ms();
            let t0 = t_dep_extract_start.expect("paired with clock");
            let t1 = t_dep_register_start.expect("paired with clock");
            let t2 = t_formula_record_start.expect("paired with clock");
            // The compatibility dep_extract bucket also folds the cheap
            // `remove_formula_record` + primitive scaffold cleanup into
            // its slot — those two HashMap removes are O(1) and at Mega
            // scale stay in single-digit % of total, so attributing
            // them into that bucket (rather than carving a separate
            // sub-phase) keeps the timer count to 4 per formula.
            crate::bulk_import_trace::add_flush_dep_extract_ms(t1 - t0);
            crate::bulk_import_trace::add_flush_dep_register_ms(t2 - t1);
            crate::bulk_import_trace::add_flush_formula_record_ms(t_end - t2);
        }

        // B1 — bump the imported-formula counter for successfully installed
        // bulk-load entries. Parse failure / cycle paths return earlier and
        // do not insert a formula record, so they intentionally don't bump.
        self.sheet
            .imported_formula_count
            .set(self.sheet.imported_formula_count.get() + 1);

        self.touched.insert(addr);
        if pre_range_member != self.sheet.range_member_present(addr) {
            self.range_membership_changed.insert(addr);
        }
        true
    }

    /// Inline `write_error` minus immediate Store publication and subscriber
    /// notification. Used by the parse-failure and cycle paths in bulk-mode
    /// `set_formula`.
    ///
    /// LAZY_FORMULA_INDEXING Phase 3: parse-failure / cycle now
    /// surface at first read via `hydrate_formula`'s own write_error
    /// shape. Kept for the eager `install_parsed_formula` callers that
    /// the same arc may reactivate.
    #[allow(dead_code)]
    fn write_error_no_notify(&mut self, addr: CellAddress, err: ValueError) {
        let pre_range_member = self.sheet.range_member_present(addr);
        let had_formula = self
            .sheet
            .interior
            .formula_cells
            .borrow()
            .contains_key(&addr)
            || self.sheet.interior.needs_parse.borrow().contains(&addr);
        if had_formula {
            self.obsolete_formula_addrs.insert(addr);
        }
        self.sheet.detach_address_sub(addr);
        if had_formula {
            self.sheet.remove_formula_record(addr);
        }
        // Drop any lazy parking too.
        self.sheet
            .interior
            .formula_source
            .borrow_mut()
            .remove(&addr);
        self.sheet.interior.needs_parse.borrow_mut().remove(&addr);
        let id = self.sheet.ensure_cell(addr);
        self.sheet.store.set(id, Value::Error(err));
        self.sheet.invalidate_formula_inner(addr);
        self.sheet.bump_facade_epoch(addr);
        if pre_range_member != self.sheet.range_member_present(addr) {
            self.range_membership_changed.insert(addr);
        }
    }

    /// Drain the touched set, invalidate touched facades plus Store geometry
    /// roots, reattach fanouts on touched primitive addresses, and notify each
    /// directly touched subscribed address at most once.
    ///
    /// Same-sheet formulas are invalidated by Store edges from the touched
    /// facade/inner/geometry atoms. Store reverse reachability is used only to
    /// find dynamic arrays that need eager spill maintenance.
    fn flush(&mut self) {
        let touched: Vec<CellAddress> = self.touched.iter().copied().collect();
        let range_membership_changed: Vec<CellAddress> =
            self.range_membership_changed.iter().copied().collect();
        let array_formulas_to_reproject = self
            .sheet
            .store_dependent_array_formula_addrs_from_addrs(touched.iter().copied());
        self.sheet.store_batch(|sheet| {
            for &addr in &touched {
                sheet.invalidate_formula_inner(addr);
                sheet.bump_facade_epoch(addr);
            }
            for addr in range_membership_changed.iter().copied() {
                sheet.bump_range_membership_epochs_touching(addr);
            }
        });
        for addr in self.obsolete_formula_addrs.drain() {
            self.sheet.cleanup_obsolete_formula_atoms_at(addr);
        }

        // Eager spill maintenance follows the Store's reverse dependency
        // graph. Lazy-parked formulas have no live edges until first read, so
        // fresh bulk imports still do zero formula evaluation here.
        self.sheet
            .recompute_array_formulas_in(&array_formulas_to_reproject);

        // AUDIT B-5 — with zero address subscriptions the reattach loop
        // and the touched notify loop below are pure
        // overhead: a 1M-cell restore would pay ~3M hash ops to conclude
        // nobody is watching. `attach_address_sub` is a no-op without a
        // bucket and the notify loop cannot fire, so early-out keeps the
        // legacy loader's notify tail O(0) on the unsubscribed path
        // (pinned by `debug_bulk_notify_probe_count` in the scale suite).
        if self.sheet.cell_subscriptions.is_empty() {
            return;
        }

        // Reattach fanouts on touched addresses so future writes notify
        // normally. Reattach is a no-op when the address has no
        // subscription bucket or no readable atom.
        for &addr in &touched {
            self.sheet.attach_address_sub(addr);
        }

        // Downstream formula subscribers stayed attached and are notified by
        // Store propagation. Only directly touched fanouts were detached.
        self.sheet
            .bulk_notify_probe_count
            .set(self.sheet.bulk_notify_probe_count.get() + touched.len() as u64);
        for addr in touched {
            if self.sheet.has_address_subscribers(addr) {
                self.sheet.notify_address_subscribers(addr);
            }
        }
    }
}

/// Walk the AST and collect every `Expr::Range` as a typed `CellRange`,
/// without expanding it to individual cells. Mirror of `collect_refs`
/// that handles only ranges. Used by `set_formula` / `BulkLoader` to retain
/// range identity for static cycle checks and structural retargeting without
/// expanding large ranges into individual cells.
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
            // axis. Formula evaluation maps that geometry to lazy Store
            // band/column/sheet roots without expanding the coordinate space.
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
        | Expr::Error(_)
        | Expr::Name(_) => {}
        Expr::SpillRef(anchor) => collect_range_refs_into(anchor, out),
        Expr::DynamicRange { start, end } => {
            collect_range_refs_into(start, out);
            collect_range_refs_into(end, out);
        }
        // Immediate-call form — descend into callee + args so ranges
        // hidden inside the lambda body or arg list still register.
        Expr::Call(callee, args) => {
            collect_range_refs_into(callee, out);
            for a in args {
                collect_range_refs_into(a, out);
            }
        }
        // Constant-array literal: parser rejects any range / cell ref
        // inside, so there are no dependencies to register.
        Expr::ArrayLit { .. } => {}
        // Multi-area: every part is a reference; descend into each so
        // ranges inside the union register as deps.
        Expr::MultiArea(parts) => {
            for p in parts {
                collect_range_refs_into(p, out);
            }
        }
    }
}

/// Walk the AST and append every referenced cell address into `out`.
/// Used by static cycle detection (B.2). Free function so it can run
/// without borrowing `&self.interior.formula_exprs`.
///
/// Whole-column / whole-row ranges (`A:A`, `1:1`) are NOT expanded into
/// individual cells here — that would push the entire coordinate space
/// (`u32::MAX` rows or cols) into the dep vec. Track G's contract: the
/// unbounded range remains typed in `static_ranges`; cycle detection walks
/// materialized formulas within it, while runtime invalidation is owned by
/// Store geometry roots.
fn collect_refs(expr: &Expr, out: &mut Vec<CellAddress>) {
    match expr {
        Expr::CellRef(addr) => out.push(*addr),
        Expr::Range {
            start,
            end,
            unbounded,
        } => {
            // Skip expansion for unbounded ranges — the row/col bound would
            // be u32::MAX. `collect_range_refs` retains the typed range.
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
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => {}
        // LET-bound names don't reference cells.
        Expr::Name(_) => {}
        Expr::SpillRef(anchor) => collect_refs(anchor, out),
        Expr::DynamicRange { start, end } => {
            collect_refs(start, out);
            collect_refs(end, out);
        }
        // Immediate-call form — descend into callee + args.
        Expr::Call(callee, args) => {
            collect_refs(callee, out);
            for a in args {
                collect_refs(a, out);
            }
        }
        // Constant-array literal carries no cell references.
        Expr::ArrayLit { .. } => {}
        // Multi-area: descend into every inner ref so static cycle
        // detection sees every cell mentioned in the union.
        Expr::MultiArea(parts) => {
            for p in parts {
                collect_refs(p, out);
            }
        }
    }
}

/// Conservative static check: does this AST contain a call to a
/// function that can produce a `Value::Array`? Used to gate the eager
/// spill re-eval — formulas that can't produce arrays stay fully lazy
/// and preserve the compatibility dirty-count / eval-count debug counters.
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
                    | "TEXTSPLIT"
                    | "LINEST"
                    | "LOGEST"
                    | "TREND"
                    | "GROWTH"
                    | "MMULT"
                    | "MINVERSE"
                    | "MUNIT"
                    | "TRANSPOSE"
                    | "FREQUENCY"
                    | "MODE.MULT"
                    | "EXPAND"
            ) {
                return true;
            }
            args.iter().any(expr_may_produce_array)
        }
        Expr::BinOp { left, right, .. } => {
            // A binop now broadcasts when either operand is a multi-cell
            // range or array literal (eval.rs § `broadcast_binop`). Range
            // operands always produce multi-cell at the binop boundary,
            // so flag the binop as array-producing whenever an operand
            // is a `Range` / `SheetRange` — the broadcast path on the
            // eval side handles the single-cell range collapse so we
            // only over-flag, never under-flag.
            let operand_is_range =
                |e: &Expr| matches!(e, Expr::Range { .. } | Expr::SheetRange { .. });
            operand_is_range(left)
                || operand_is_range(right)
                || expr_may_produce_array(left)
                || expr_may_produce_array(right)
        }
        Expr::Negate(inner) => expr_may_produce_array(inner),
        // An immediate-call could be `MAP(...)(...)` chained, but even a
        // bare `LAMBDA(x, MAP(...))(arg)` returns an array. Descend the
        // callee + args conservatively.
        Expr::Call(callee, args) => {
            expr_may_produce_array(callee) || args.iter().any(expr_may_produce_array)
        }
        // Constant-array literal evaluates directly to `Value::Array`,
        // so a top-level `={1,2,3}` must take the eager spill re-eval
        // path just like a SEQUENCE / UNIQUE call would.
        Expr::ArrayLit { .. } => true,
        Expr::SpillRef(_) | Expr::DynamicRange { .. } => true,
        // Multi-area evaluates to `#VALUE!` (error scalar) anywhere
        // other than as an `AREAS` argument — it never produces a
        // spillable `Value::Array`.
        Expr::MultiArea(_) => false,
        _ => false,
    }
}

struct SheetEvalProvider<'a> {
    sheet: &'a Sheet,
    /// Cell currently being evaluated. Updated through `set_current_cell`
    /// (save/restore guard pattern) so no-arg `ROW()` / `COLUMN()` calls can
    /// read the formula's own row/column.
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

    fn raw_cell(&self, addr: CellAddress) -> Value {
        self.sheet.peek_value_with_provider(addr, self)
    }

    fn raw_sheet_cell(&self, _sheet: &str, _addr: CellAddress) -> Value {
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

    fn cell_has_formula(&self, addr: CellAddress) -> bool {
        self.sheet.has_formula_at(addr)
    }

    /// FORMULATEXT hook — consult the sheet's `formula_texts` map and
    /// return a clone of the stored source. A primitive cell has no
    /// entry → `None` → the FORMULATEXT arm surfaces `#N/A`.
    fn cell_formula_text(&self, addr: CellAddress) -> Option<String> {
        // LAZY_FORMULA_INDEXING Phase 3: prefer hydrated source, fall
        // back to lazy `formula_source`.
        if let Some(t) = self.sheet.interior.formula_texts.borrow().get(&addr) {
            return Some(t.clone());
        }
        self.sheet
            .interior
            .formula_source
            .borrow()
            .get(&addr)
            .map(|s| s.source.as_ref().to_string())
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
        assert_eq!(sheet.interior.cells.borrow().len(), 0);
        assert_eq!(sheet.get_cell("A1"), Value::Null);
        assert_eq!(sheet.interior.cells.borrow().len(), 0);
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

    // === P4c: write口 → facade re-derivation (Commit A) ===
    //
    // These pin the write口 helpers wired this phase (`bump_facade_epoch`,
    // `invalidate_formula_inner`) against a MANUALLY materialized facade —
    // the read entry points don't consult the facade yet (that flip is
    // Commit B), so in production the facade families stay empty and these
    // helpers are inert. We materialize a facade by hand via `facade_of`,
    // subscribe on it, drive a REAL write口, and assert the facade re-derives
    // to the correct VALUE and the subscriber fired. We assert `>= 1`
    // notifications, never an exact count: over-bumping is safe by design
    // (the facade re-derives to the same value and change-pruning suppresses a
    // spurious notify), so an exact count would be a brittle over-specification.

    #[test]
    fn facade_redrives_on_formula_content_edit() {
        // The load-bearing case for `invalidate_formula_inner` + bump: a
        // formula-content edit (`=B1`→`=C1`) whose upstream deps are unchanged.
        // Without the invalidate the inner atom's recorded edge ({B1}) is still
        // fresh and the facade would read the CACHED old-AST value (5), never
        // re-resolving to `=C1` (9).
        let mut sheet = Sheet::new();
        sheet.set_cell("B1", Value::Number(5.0));
        sheet.set_cell("C1", Value::Number(9.0));
        sheet.set_formula("A1", "=B1");

        let addr = CellAddress::parse("A1").unwrap();
        let facade = sheet.facade_of(addr);
        let hits = Rc::new(Cell::new(0u32));
        let hits_l = hits.clone();
        sheet
            .store
            .sub(facade, move || hits_l.set(hits_l.get() + 1));

        assert_eq!(sheet.store.get(facade), Value::Number(5.0));

        sheet.set_formula("A1", "=C1");
        sheet.store.flush();

        assert_eq!(sheet.store.get(facade), Value::Number(9.0));
        assert!(hits.get() >= 1, "subscriber fired on content edit");
    }

    #[test]
    fn facade_redrives_on_formula_upstream_change() {
        // The NATIVE-edge path: an upstream write bumps the dep atom's
        // generation, so the formula inner re-derives off its own recorded
        // edge and the facade re-derives off `args.get(inner)` — no epoch bump
        // needed (and none fires, because the inner-atom identity is unchanged).
        let mut sheet = Sheet::new();
        sheet.set_cell("B1", Value::Number(5.0));
        sheet.set_formula("A1", "=B1+1");

        let addr = CellAddress::parse("A1").unwrap();
        let facade = sheet.facade_of(addr);
        let hits = Rc::new(Cell::new(0u32));
        let hits_l = hits.clone();
        sheet
            .store
            .sub(facade, move || hits_l.set(hits_l.get() + 1));

        assert_eq!(sheet.store.get(facade), Value::Number(6.0));

        sheet.set_cell("B1", Value::Number(10.0));
        sheet.store.flush();

        assert_eq!(sheet.store.get(facade), Value::Number(11.0));
        assert!(hits.get() >= 1, "subscriber fired on upstream change");
    }

    #[test]
    fn facade_redrives_on_literal_update() {
        // A same-id literal update propagates via the facade's native
        // `args.get(inner)` edge — `try_set_cell` reuses the Atom slot's id, so
        // `store.set(id, ..)` alone re-derives the facade with no epoch bump.
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));

        let addr = CellAddress::parse("A1").unwrap();
        let facade = sheet.facade_of(addr);
        let hits = Rc::new(Cell::new(0u32));
        let hits_l = hits.clone();
        sheet
            .store
            .sub(facade, move || hits_l.set(hits_l.get() + 1));

        assert_eq!(sheet.store.get(facade), Value::Number(1.0));

        sheet.set_cell("A1", Value::Number(2.0));
        sheet.store.flush();

        assert_eq!(sheet.store.get(facade), Value::Number(2.0));
        assert!(hits.get() >= 1, "subscriber fired on literal update");
    }

    #[test]
    fn facade_redrives_on_formula_to_literal_replacement() {
        // Identity transition: replacing a formula with a literal swaps the
        // facade's inner atom (formula-inner → primitive), so the epoch bump
        // (via `had_formula`) is what drives the re-derive.
        let mut sheet = Sheet::new();
        sheet.set_cell("B1", Value::Number(7.0));
        sheet.set_formula("A1", "=B1");

        let addr = CellAddress::parse("A1").unwrap();
        let facade = sheet.facade_of(addr);
        let hits = Rc::new(Cell::new(0u32));
        let hits_l = hits.clone();
        sheet
            .store
            .sub(facade, move || hits_l.set(hits_l.get() + 1));

        assert_eq!(sheet.store.get(facade), Value::Number(7.0));

        sheet.set_cell("A1", Value::Number(42.0));
        sheet.store.flush();

        assert_eq!(sheet.store.get(facade), Value::Number(42.0));
        assert!(hits.get() >= 1, "subscriber fired on formula→literal");
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
    fn formula_error_recovers_through_store_derivation() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(0.0));
        sheet.set_formula("B1", "=1/A1");

        assert_eq!(
            sheet.get_cell("B1"),
            Value::Error(ValueError::DivisionByZero)
        );
        let evals_before = sheet.debug_formula_eval_count();

        sheet.set_cell("A1", Value::Number(2.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(0.5));
        assert_eq!(sheet.debug_formula_eval_count(), evals_before + 1);

        assert_eq!(sheet.get_cell("B1"), Value::Number(0.5));
        assert_eq!(sheet.debug_formula_eval_count(), evals_before + 1);
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
    fn subscribe_range_formula_fires_once_on_member_change() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A2", Value::Number(2.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(7.0));
        assert_eq!(
            *count.borrow(),
            1,
            "range formula subscriber fires exactly once"
        );
    }

    #[test]
    fn subscribe_range_formula_fires_once_on_new_member_change() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let _sub = sheet.subscribe_cell("B1", move || *cc.borrow_mut() += 1);

        sheet.set_cell("A2", Value::Number(2.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(
            *count.borrow(),
            1,
            "range formula subscriber fires exactly once when membership grows"
        );
    }

    #[test]
    fn small_range_formula_does_not_materialize_geometry_root() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");

        assert_eq!(
            sheet.debug_range_dep_count(),
            0,
            "small range geometry stays lazy until the formula is read"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(
            sheet.debug_range_dep_count(),
            0,
            "Tier-A ranges depend on member facades instead of a geometry root"
        );

        sheet.set_cell("A2", Value::Number(2.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
    }

    #[test]
    fn small_range_formula_records_store_edge_on_empty_member_facade() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");

        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));

        let a2 = CellAddress::parse("A2").unwrap();
        let a2_facade = sheet
            .cell_facade_family
            .borrow()
            .get(&a2)
            .expect("Tier-A range read materializes empty member facade");
        assert_eq!(
            sheet.store.debug_dependent_count(a2_facade),
            1,
            "formula-inner must depend on the empty member facade through Store"
        );

        let evals_before = sheet.debug_formula_eval_count();
        let visits_before = sheet.debug_reverse_dep_visit_count();
        sheet.set_cell("A2", Value::Number(2.0));

        assert_eq!(
            sheet.debug_reverse_dep_visit_count() - visits_before,
            1,
            "Store reverse reachability should find exactly this formula"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(sheet.debug_formula_eval_count(), evals_before + 1);
    }

    #[test]
    fn large_range_formula_records_store_edge_on_band_epoch() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A300)");

        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));

        let band_key = RangeBandKey {
            col: 0,
            row_band: 1,
        };
        let band_epoch = sheet
            .range_band_epoch_family
            .borrow()
            .get(&band_key)
            .expect("large range read materializes the touched row-band epoch");
        assert_eq!(
            sheet.store.debug_dependent_count(band_epoch),
            1,
            "formula-inner must depend on the range band epoch through Store"
        );

        let a300 = CellAddress::parse("A300").unwrap();
        assert!(
            sheet.cell_facade_family.borrow().get(&a300).is_none(),
            "Tier-B range read should not materialize every empty member facade"
        );

        let evals_before = sheet.debug_formula_eval_count();
        let visits_before = sheet.debug_reverse_dep_visit_count();
        sheet.set_cell("A300", Value::Number(2.0));

        assert_eq!(
            sheet.debug_reverse_dep_visit_count() - visits_before,
            1,
            "the band root should reach exactly this formula through Store"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(sheet.debug_formula_eval_count(), evals_before + 1);
    }

    #[test]
    fn range_formula_membership_change_uses_store_edges() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));

        let evals_before = sheet.debug_formula_eval_count();
        let visits_before = sheet.debug_reverse_dep_visit_count();

        sheet.set_cell("A2", Value::Number(2.0));

        assert_eq!(
            sheet.debug_reverse_dep_visit_count() - visits_before,
            1,
            "Store reverse reachability should find the affected formula once"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            evals_before + 1,
            "Store-tracked range inputs should drive one formula-inner recompute"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            evals_before + 1,
            "post-write read should hit the clean Store-derived value"
        );
    }

    #[test]
    fn batch_range_formula_membership_change_uses_store_edges() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));

        let evals_before = sheet.debug_formula_eval_count();
        let visits_before = sheet.debug_reverse_dep_visit_count();

        sheet.batch_set(&[("A2", Value::Number(2.0))]);

        assert_eq!(
            sheet.debug_reverse_dep_visit_count() - visits_before,
            1,
            "batch membership changes should discover one Store dependent"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(sheet.debug_formula_eval_count(), evals_before + 1);
    }

    #[test]
    fn bulk_range_formula_membership_change_uses_store_edges() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=SUM(A1:A2)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));

        let evals_before = sheet.debug_formula_eval_count();
        let visits_before = sheet.debug_reverse_dep_visit_count();

        sheet.bulk_load(|bulk| {
            bulk.set_cell("A2", Value::Number(2.0));
        });

        assert_eq!(
            sheet.debug_reverse_dep_visit_count() - visits_before,
            1,
            "bulk membership changes should discover one Store dependent"
        );
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(sheet.debug_formula_eval_count(), evals_before + 1);
    }

    #[test]
    fn subscribe_empty_cell_does_not_materialize_until_write() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let mut sheet = Sheet::new();
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        let sub = sheet.subscribe_cell("A1", move || *cc.borrow_mut() += 1);

        assert_eq!(
            sheet.interior.cells.borrow().len(),
            0,
            "subscription should not allocate A1"
        );
        sheet.set_cell("A1", Value::Number(1.0));
        assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
        assert_eq!(sheet.interior.cells.borrow().len(), 1);
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
        assert_eq!(sheet.debug_total_atom_count(), 2);

        assert_eq!(sheet.debug_dependents_count("A1"), 0);
        assert_eq!(sheet.debug_dependents_count("Z99"), 0);

        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(sheet.debug_primitive_atom_count(), 1);
        assert_eq!(sheet.debug_total_atom_count(), 8);

        let b1 = CellAddress::parse("B1").unwrap();
        for addr_str in ["A1", "Z99"] {
            let addr = CellAddress::parse(addr_str).unwrap();
            let mut roots = Vec::new();
            sheet.store_root_atoms_for_addr_into(addr, &mut roots);
            assert!(
                sheet
                    .store_dependent_formula_addrs_from_atoms(&roots)
                    .contains(&b1),
                "{addr_str} should have a Store edge into B1 after formula read"
            );
        }
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
        assert_eq!(
            sheet.debug_total_atom_count(),
            2,
            "subscribing anchors the empty cell with a facade plus slot epoch"
        );
    }

    // === B1 — counter additions ===

    #[test]
    fn debug_formula_eval_count_bumps_on_miss_not_on_hit() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=A1");
        // No read yet — counter must be zero.
        assert_eq!(sheet.debug_formula_eval_count(), 0);

        // First read: cold formula-inner → exactly one eval.
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        assert_eq!(sheet.debug_formula_eval_count(), 1);

        // Second read: settled Store-derived value → no additional eval.
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

        // Writing a dep now propagates through the Store-derived formula inner;
        // the formula cache is already refreshed by the atomm path.
        sheet.set_cell("A1", Value::Number(5.0));
        assert_eq!(sheet.debug_dirty_count(), 0);
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
    fn debug_range_dep_count_counts_materialized_geometry_roots() {
        let mut sheet = Sheet::new();
        assert_eq!(sheet.debug_range_dep_count(), 0);

        sheet.set_formula("C1", "=SUM(A1:A300)");
        assert_eq!(sheet.debug_range_dep_count(), 0, "roots are read-lazy");
        assert_eq!(sheet.get_cell("C1"), Value::Number(0.0));
        assert_eq!(sheet.debug_range_dep_count(), 2);

        sheet.set_formula("C2", "=AVERAGE(A1:A300)");
        assert_eq!(
            sheet.get_cell("C2"),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_eq!(
            sheet.debug_range_dep_count(),
            2,
            "consumers share the same two band roots"
        );

        sheet.set_formula("C3", "=SUM(B1:B5)");
        assert_eq!(sheet.get_cell("C3"), Value::Number(0.0));
        assert_eq!(
            sheet.debug_range_dep_count(),
            2,
            "Tier-A ranges use facades and add no geometry root"
        );
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
        assert!(!sheet
            .interior
            .cells
            .borrow()
            .contains_key(&CellAddress::new(0, 1)));

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
    fn structural_edit_batches_store_propagation() {
        const ROW_COUNT: u32 = 120;

        let mut sheet = Sheet::new();
        for row in 1..=ROW_COUNT {
            sheet.set_cell(&format!("A{row}"), Value::Number(row as f64));
            assert!(sheet.set_formula(&format!("B{row}"), &format!("=A{row}+1")));
            assert_eq!(
                sheet.get_cell(&format!("B{row}")),
                Value::Number(row as f64 + 1.0)
            );
        }

        let before = sheet.store.debug_flush_visit_count();
        sheet.delete_row(0, 1);
        let visits = sheet.store.debug_flush_visit_count() - before;

        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
        assert_eq!(
            sheet.get_cell(&format!("B{}", ROW_COUNT - 1)),
            Value::Number(ROW_COUNT as f64 + 1.0)
        );
        assert!(
            visits <= ROW_COUNT as usize * 20,
            "one structural transaction must not repeatedly walk the formula graph: {visits} visits"
        );
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

        // After eval, B1's formula-inner atom depends on A1's facade.
        // Clearing A1 sets the value to Null, and B1 re-evaluates against
        // that new value on the next read.
        sheet.clear_cell("A1");
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
        // while the stable facade retargets from the primitive to Absent.
        // Clearing publishes Null through that facade, and the next write
        // reuses the same stable subscription anchor.
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
            "subscribed facade must not keep a Null primitive slot alive"
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
            "next write reuses the subscribed primitive path"
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
        assert_eq!(
            sheet.debug_total_atom_count(),
            1,
            "only A1's live primitive may remain after the leaf formula clears"
        );
    }

    #[test]
    fn clearing_leaf_formula_unmounts_unobserved_upstream_formula_chain() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        assert!(sheet.set_formula("B1", "=A1+1"));
        assert!(sheet.set_formula("C1", "=B1+1"));
        assert_eq!(sheet.get_cell("C1"), Value::Number(3.0));

        sheet.clear_cell("C1");

        assert_eq!(sheet.debug_formula_count(), 1, "B1 remains a live formula");
        assert_eq!(
            sheet.debug_total_atom_count(),
            1,
            "the cold B1 chain must unmount back to A1's primitive"
        );
        assert_eq!(
            sheet.get_cell("B1"),
            Value::Number(2.0),
            "reading B1 must lazily remount the same Store-derived formula"
        );
    }

    #[test]
    fn clearing_formula_diamond_retries_shared_upstream_eviction() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        assert!(sheet.set_formula("A2", "=A1+1"));
        assert!(sheet.set_formula("B1", "=A2+1"));
        assert!(sheet.set_formula("C1", "=A2+2"));
        assert!(sheet.set_formula("D1", "=B1+C1"));
        assert_eq!(sheet.get_cell("D1"), Value::Number(7.0));

        sheet.clear_cell("D1");

        assert_eq!(sheet.debug_formula_count(), 3);
        assert_eq!(
            sheet.debug_total_atom_count(),
            1,
            "the shared A2 chain must be retried after both branches unmount"
        );
        assert_eq!(sheet.get_cell("A2"), Value::Number(2.0));
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
        // Compatibility cache probes stay Dirty until a formula is materialized.
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

        // Pre-read: B1 is still parked and the compatibility probe reports
        // Dirty. No formula-inner exists until the first read.
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
        // LAZY_FORMULA_INDEXING Phase 3 contract change: bulk_load no
        // longer eagerly parses formulas — cycles installed via
        // bulk_load surface at first read (matching the TS port).
        // `set_formula` inside bulk_load now returns `true`
        // unconditionally; the cycle becomes a `#CIRCULAR!` on the
        // first read of any cycle member.
        let mut sheet = Sheet::new();
        let mut a_ok = true;
        let mut b_ok = true;
        sheet.bulk_load(|loader| {
            a_ok = loader.set_formula("A1", "=B1+1");
            b_ok = loader.set_formula("B1", "=A1+1");
        });
        assert!(a_ok, "lazy bulk_load always returns true (cycle deferred)");
        assert!(b_ok, "lazy bulk_load always returns true (cycle deferred)");
        // B1 holds the cycle error; reading it must not stack-overflow.
        // Hydration parses both formulas — A1's hydration installs
        // edges, then B1's cycle check sees the edge from A1 (which
        // depends on B1) and surfaces the cycle.
        let b1 = sheet.get_cell("B1");
        assert!(
            matches!(b1, Value::Error(ValueError::CyclicRef)),
            "B1 read must surface the cycle once hydrated; got {:?}",
            b1
        );
    }

    #[test]
    fn parked_cycle_certificate_is_invalidated_by_topology_change() {
        let mut sheet = Sheet::new();
        sheet.bulk_load(|loader| {
            loader.set_formula("A2", "=A3");
            loader.set_cell("A3", Value::Number(1.0));
        });

        assert_eq!(sheet.get_cell("A2"), Value::Number(1.0));
        let a2 = CellAddress::parse("A2").unwrap();
        let certified_epoch = sheet
            .interior
            .formula_cells
            .borrow()
            .get(&a2)
            .unwrap()
            .cycle_checked_at
            .get();
        assert_eq!(certified_epoch, sheet.formula_topology_epoch.get());

        // This is the pruning counterexample: A2 was valid while A3 was a
        // literal, then A3 changes to point back to A2. The mutation must make
        // A2's old certificate unusable before A3's first hydration.
        sheet.bulk_load(|loader| {
            loader.set_formula("A3", "=A2");
        });
        assert_ne!(certified_epoch, sheet.formula_topology_epoch.get());
        assert_eq!(sheet.get_cell("A3"), Value::Error(ValueError::CyclicRef));

        let a3 = CellAddress::parse("A3").unwrap();
        let expr = sheet
            .interior
            .formula_exprs
            .borrow()
            .get(&a3)
            .cloned()
            .unwrap();
        assert!(matches!(expr.as_ref(), Expr::Error(ValueError::CyclicRef)));
    }

    #[test]
    fn tail_first_chain_static_cycle_walk_is_linear() {
        const N: u32 = 512;
        let mut sheet = Sheet::new();
        sheet.bulk_load(|loader| {
            loader.set_cell("A1", Value::Number(1.0));
            for row in 2..=N {
                loader.set_formula(&format!("A{row}"), &format!("=A{}+1", row - 1));
            }
        });

        let before = sheet.debug_static_cycle_node_visit_count();
        assert_eq!(sheet.get_cell(&format!("A{N}")), Value::Number(N as f64));
        assert_eq!(
            sheet.debug_static_cycle_node_visit_count() - before,
            (N - 1) as u64,
            "one temporary reachable-graph pass must certify the whole chain"
        );

        let after_tail = sheet.debug_static_cycle_node_visit_count();
        for row in 2..=N {
            let _ = sheet.get_cell(&format!("A{row}"));
        }
        assert_eq!(
            sheet.debug_static_cycle_node_visit_count(),
            after_tail,
            "later hydrations must reuse same-topology certificates"
        );
    }

    /// The local cycle check must consult range expressions, not just point
    /// refs. After `=SUM(A1:A100)` evaluates with empty A2..A100, only A1 is
    /// read dynamically, but the static range expression still covers A50.
    #[test]
    fn range_cycle_detected_after_sparse_eval() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        assert!(sheet.set_formula("B1", "=SUM(A1:A100)"));
        // Read forces eval, but static cycle detection still sees the range.
        assert_eq!(sheet.get_cell("B1"), Value::Number(1.0));
        // A50 is inside A1:A100 and is empty — register a back-edge to B1.
        // This forms a cycle through the range dep.
        let ok = sheet.set_formula("A50", "=B1");
        assert!(!ok, "set_formula should reject the range-mediated cycle");
    }

    #[test]
    fn direct_unbounded_self_reference_keeps_legacy_ref_behavior() {
        let mut sheet = Sheet::new();

        assert!(sheet.set_formula("D35", "=SUM(D:D)"));
        assert_eq!(sheet.get_formula("D35").as_deref(), Some("=SUM(D:D)"));
        assert_eq!(sheet.get_cell("D35"), Value::Error(ValueError::CyclicRef));
    }

    #[test]
    fn unbounded_range_cycle_is_rejected_before_store_edges_exist() {
        let mut sheet = Sheet::new();
        assert!(sheet.set_formula("C3", "=SUM(B:B)"));

        // C3 has never been read, so its formula-inner has no committed Store
        // edges. The install-time source walk must still see that B:B contains
        // B26 and reject B26 -> C3 -> B:B -> B26.
        assert!(!sheet.set_formula("B26", "=SUM(A1:C10)"));
        assert_eq!(sheet.get_formula("B26"), None);
        assert_eq!(sheet.get_cell("B26"), Value::Error(ValueError::CyclicRef));
    }

    #[test]
    fn unbounded_range_cycle_follows_formula_cells_inside_the_range() {
        let mut sheet = Sheet::new();
        assert!(sheet.set_formula("B5", "=A1"));
        assert!(sheet.set_formula("C1", "=SUM(B:B)"));

        // A1 -> C1 -> B:B -> B5 -> A1. Walking only direct refs or checking
        // whether B:B contains A1 would miss the formula hop through B5.
        assert!(!sheet.set_formula("A1", "=C1"));
        assert_eq!(sheet.get_formula("A1"), None);
        assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::CyclicRef));
    }

    #[test]
    fn chain_bulk_install_is_linear() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        let n: u32 = 10_000;
        let start = std::time::Instant::now();
        sheet.bulk_load(|loader| {
            for i in 2..=n {
                let addr = format!("A{i}");
                let src = format!("=A{}+1", i - 1);
                let ok = loader.set_formula(&addr, &src);
                assert!(ok, "chain formula must not be rejected at {}", addr);
            }
        });
        let dur = start.elapsed();
        eprintln!("chain_bulk_install_is_linear: 10k installs in {:?}", dur);
        assert!(
            dur.as_millis() < 500,
            "chain install took {:?} — possible O(n²) regression",
            dur
        );
    }

    /// `#[ignore]`d scaling trace — print install wall time at 1k / 10k /
    /// 100k chain depths so we can eyeball the step ratio and chase any
    /// residual super-linearity that the 10k assertion above can't surface.
    ///
    /// Run with:
    ///   `cargo test --release chain_install_scaling_trace -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn chain_install_scaling_trace() {
        for &n in &[1_000usize, 10_000, 100_000] {
            let mut sheet = Sheet::new();
            sheet.set_cell("A1", Value::Number(1.0));
            let start = std::time::Instant::now();
            sheet.bulk_load(|loader| {
                for i in 2..=n {
                    let addr = format!("A{i}");
                    let src = format!("=A{}+1", i - 1);
                    let ok = loader.set_formula(&addr, &src);
                    assert!(ok, "chain formula must not be rejected at {}", addr);
                }
            });
            eprintln!("Chain{}: {:?}", n, start.elapsed());
        }
    }

    /// Per-phase decomposition of `Sheet::bulk_load` at chain depths.
    /// Times: parse, dependency extraction, local cycle check,
    /// range registration, formula_cells/exprs/texts inserts, and flush.
    #[test]
    #[ignore]
    fn chain_install_scaling_trace_phases() {
        use std::time::{Duration, Instant};
        for &n in &[1_000usize, 10_000, 100_000] {
            let mut sheet = Sheet::new();
            sheet.set_cell("A1", Value::Number(1.0));
            let formulas: Vec<(CellAddress, String)> = (2..=n)
                .map(|i| {
                    (
                        CellAddress::parse(&format!("A{i}")).unwrap(),
                        format!("=A{}+1", i - 1),
                    )
                })
                .collect();

            let mut t_parse = Duration::ZERO;
            let mut t_collect = Duration::ZERO;
            let mut t_cycle = Duration::ZERO;
            let mut t_add_deps = Duration::ZERO;
            let mut t_inserts = Duration::ZERO;
            let mut t_other = Duration::ZERO;

            let total = Instant::now();
            sheet.bulk_load(|loader| {
                for (addr, src) in &formulas {
                    let t0 = Instant::now();
                    let expr = parse_formula(src).expect("parse ok");
                    t_parse += t0.elapsed();

                    let t1 = Instant::now();
                    if loader.sheet.closes_local_cycle(*addr, &expr) {
                        panic!("unexpected cycle");
                    }
                    t_cycle += t1.elapsed();

                    let t2 = Instant::now();
                    loader.sheet.detach_address_sub(*addr);
                    let expr = Rc::new(expr);
                    let deps = Sheet::formula_deps_for(&expr);
                    let static_ranges = collect_range_refs(&expr);
                    t_collect += t2.elapsed();

                    let t3 = Instant::now();
                    loader.sheet.remove_formula_record(*addr);
                    loader.sheet.drop_cell_slot(*addr);
                    t_other += t3.elapsed();

                    let t4 = Instant::now();
                    let record = Rc::new(FormulaRecord::new(expr.clone(), deps, static_ranges));
                    t_add_deps += t4.elapsed();

                    let t5 = Instant::now();
                    loader
                        .sheet
                        .interior
                        .formula_cells
                        .borrow_mut()
                        .insert(*addr, record);
                    loader
                        .sheet
                        .interior
                        .formula_exprs
                        .borrow_mut()
                        .insert(*addr, expr.clone());
                    loader
                        .sheet
                        .interior
                        .formula_texts
                        .borrow_mut()
                        .insert(*addr, src.clone());
                    loader.sheet.materialize_formula_inner(*addr);
                    loader.sheet.invalidate_formula_inner(*addr);
                    loader.sheet.bump_facade_epoch(*addr);
                    loader
                        .sheet
                        .imported_formula_count
                        .set(loader.sheet.imported_formula_count.get() + 1);
                    loader.touched.insert(*addr);
                    t_inserts += t5.elapsed();
                }
            });
            let tt = total.elapsed();
            eprintln!(
                "Chain{} phases: parse={:?} cycle={:?} collect={:?} other={:?} add_deps={:?} inserts={:?} total(incl_flush)={:?}",
                n, t_parse, t_cycle, t_collect, t_other, t_add_deps, t_inserts, tt,
            );
        }
    }

    /// Mirror of the WASM `bulk_import_cells` shape: drive every formula
    /// through `Workbook::bulk_load` (not `Sheet::bulk_load` directly).
    /// The WASM bench reports super-linear scaling on this exact path,
    /// so we trace it natively to see if the gap is wasm32-specific or
    /// algorithmic.
    #[test]
    #[ignore]
    fn chain_install_scaling_trace_workbook() {
        use crate::workbook::Workbook;
        for &n in &[1_000usize, 10_000, 100_000] {
            let mut wb = Workbook::new();
            wb.set_cell(0, "A1", Value::Number(1.0));
            // Time the queue-only portion (parse + cycle check + enqueue)
            // vs the flush portion (sheet-level bulk_load replay).
            let queue_start = std::time::Instant::now();
            let mut formulas: Vec<(String, String)> = Vec::with_capacity(n);
            for i in 2..=n {
                formulas.push((format!("A{i}"), format!("=A{}+1", i - 1)));
            }
            let prep = queue_start.elapsed();
            let total_start = std::time::Instant::now();
            wb.bulk_load(|loader| {
                for (addr, src) in &formulas {
                    let ok = loader.set_formula(0, addr, src);
                    assert!(ok, "chain formula must not be rejected at {}", addr);
                }
            });
            eprintln!(
                "WorkbookChain{}: prep={:?} bulk_load={:?}",
                n,
                prep,
                total_start.elapsed()
            );
        }
    }

    #[test]
    fn bulk_load_unsubscribed_addresses_not_notified() {
        // Lazy-extreme contract: only currently-subscribed addresses get
        // notified at flush. We verify by writing to a subscribed A1 and an
        // unsubscribed Z99, then confirming (a) A1's subscriber fires
        // exactly once and (b) the only recompute is the subscribed A1 facade,
        // not the unsubscribed Z99 write.
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
            1,
            "only the subscribed A1 facade should recompute at flush"
        );
        // And reading the subscribed cell still gets the bulk value.
        assert_eq!(sheet.get_cell("A1"), Value::Number(7.0));
        assert_eq!(sheet.get_cell("Z99"), Value::Number(99.0));
    }

    /// Stripe pattern with many overlapping Tier-A ranges. It verifies that
    /// bulk-loaded formulas materialize member-facade dependencies and Store
    /// re-derives exactly the windows affected by a later source write.
    ///
    /// 200 stripes (B_i = SUM(A_i:A_{i+9})) over 200 A-column seeds.
    /// Bulk-load the whole sheet in one shot, then flip one A cell and
    /// re-read the downstream B values. Every B whose window contains
    /// the mutated cell must re-evaluate to the new value, exactly
    /// matching the formulas' Store-recorded dependencies.
    #[test]
    fn bulk_load_stripe_ranges_recompute_through_store() {
        let mut sheet = Sheet::new();
        const N: u32 = 200;
        const WINDOW: u32 = 10;
        sheet.bulk_load(|loader| {
            for row in 0..N {
                loader.set_cell(&format!("A{}", row + 1), Value::Number(1.0));
            }
            for i in 0..N {
                let lo = i + 1;
                let hi = (i + WINDOW).min(N);
                let formula = format!("=SUM(A{}:A{})", lo, hi);
                loader.set_formula(&format!("B{}", i + 1), &formula);
            }
        });

        // Each B_i sums its window of 10 cells (or fewer at the tail),
        // so the initial result is `min(WINDOW, N - i)`.
        for i in 0..N {
            let expected = (WINDOW.min(N - i)) as f64;
            assert_eq!(
                sheet.get_cell(&format!("B{}", i + 1)),
                Value::Number(expected),
                "initial sum for stripe row {}",
                i
            );
        }

        // Mutate one mid-window A cell and verify every stripe whose
        // window contains it re-evaluates.
        let mutated_row: u32 = 50;
        sheet.set_cell(&format!("A{}", mutated_row + 1), Value::Number(11.0));
        for i in 0..N {
            let lo = i;
            let hi = (i + WINDOW - 1).min(N - 1);
            // Window covers row indices [lo, hi]. A_{mutated_row+1} is
            // at row index `mutated_row`.
            let in_window = mutated_row >= lo && mutated_row <= hi;
            let base = (hi - lo + 1) as f64; // sum of the other 1's
            let expected = if in_window { base + 10.0 } else { base };
            assert_eq!(
                sheet.get_cell(&format!("B{}", i + 1)),
                Value::Number(expected),
                "post-mutate sum for stripe row {} (in_window={})",
                i,
                in_window
            );
        }
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
    fn non_empty_enumeration_hides_cleared_atom_retained_by_formula_dependency() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_formula("B1", "=A1+1");
        assert_eq!(sheet.get_cell("B1"), Value::Number(2.0));

        sheet.clear_cell("A1");

        let mut all = sheet.non_empty_addrs();
        all.sort();
        assert_eq!(all, vec!["B1"]);

        let range = CellRange::new(CellAddress::new(0, 0), CellAddress::new(0, 0));
        let mut in_range = Vec::new();
        sheet.for_each_non_empty_in_range(range, |addr| in_range.push(addr.to_string()));
        assert!(in_range.is_empty());
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
        assert_eq!(sheet.debug_formula_cache_state("D1"), "clean");
        assert_eq!(sheet.get_cell("D1"), Value::Number(1.0));
    }

    // === Phase 1 Track A — P0 bug: range dep survives sparse eval ===
    //
    // The sparse value iterator only visits non-empty addresses. The Store
    // dependency layer must still represent empty range members: Tier A via
    // member facades and Tier B via geometry roots. Otherwise writing A50
    // after the first read would leave B1 stale.
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

    /// A 5000-row, one-column range maps to 20 lazy row-band roots. Writes
    /// touch one root in O(1), and the Store owns the root-to-formula edge.
    #[test]
    fn large_range_uses_band_geometry_roots() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        sheet.set_cell("A5000", Value::Number(2.0));
        sheet.set_formula("B1", "=SUM(A1:A5000)");
        assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));

        sheet.set_cell("A2500", Value::Number(10.0));
        assert_eq!(sheet.get_cell("B1"), Value::Number(13.0));

        assert_eq!(sheet.debug_range_dep_count(), 20);
        assert_eq!(sheet.debug_range_dep_candidates("A2500"), 1);
        assert_eq!(sheet.debug_range_dep_candidates("Z1"), 0);
    }

    /// Tier-A ranges install direct member-facade edges. No sheet-local
    /// address-to-formula range index is involved.
    #[test]
    fn small_range_reverse_edges_are_store_facades() {
        let mut sheet = Sheet::new();
        const N: u32 = 1000;
        for i in 0..N {
            let formula = format!("=SUM(A{}:A{})", i + 1, i + 3);
            let target = format!("C{}", i + 1);
            sheet.set_formula(&target, &formula);
            let _ = sheet.get_cell(&target);
        }

        assert_eq!(sheet.debug_range_dep_count(), 0);
        assert_eq!(sheet.debug_range_dep_candidates("A501"), 0);
        assert_eq!(sheet.debug_dependents_count("A501"), 3);
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

    /// Linear formula chain `A1 = 1; A2 = =A1+1; ... A1000 = =A999+1`.
    ///
    /// The formula-inner read path must resolve a 1000-deep chain without
    /// recursive Rust calls proportional to the chain length. Native stacks
    /// can hide that bug; WASM stacks cannot.
    #[test]
    fn chain_1000_native_read_does_not_panic() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        for i in 2..=1000 {
            let addr = format!("A{i}");
            let src = format!("=A{}+1", i - 1);
            assert!(
                sheet.set_formula(&addr, &src),
                "set_formula failed for {addr}"
            );
        }
        let v = sheet.get_cell("A1000");
        assert_eq!(v, Value::Number(1000.0));
    }

    /// Same chain shape, but at a depth that would also overflow even a
    /// release-mode native stack with recursive formula-cell evaluation.
    #[test]
    fn chain_10000_native_read_does_not_panic() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        for i in 2..=10_000 {
            let addr = format!("A{i}");
            let src = format!("=A{}+1", i - 1);
            assert!(
                sheet.set_formula(&addr, &src),
                "set_formula failed for {addr}"
            );
        }
        let v = sheet.get_cell("A10000");
        assert_eq!(v, Value::Number(10_000.0));
    }

    /// Regression for chain warmup and short-circuit interaction: static
    /// dependency discovery must not evaluate the untaken branch of
    /// `=IF(TRUE,0,B1)`. Only A1 should evaluate.
    #[test]
    fn if_true_does_not_prewarm_unused_branch() {
        let mut sheet = Sheet::new();
        sheet.set_formula("B1", "=1+1");
        sheet.set_formula("A1", "=IF(TRUE,0,B1)");
        assert_eq!(sheet.get_cell("A1"), Value::Number(0.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            1,
            "prewarm should not have evaluated B1 — IF(TRUE,...) skips it"
        );
    }

    /// Mirror of `if_true_does_not_prewarm_unused_branch` for the
    /// false branch path. `=IF(FALSE, B1, 0)` selects the else branch; B1
    /// must not be pre-warmed (it's on the never-taken then-branch).
    #[test]
    fn if_false_does_not_prewarm_unused_branch() {
        let mut sheet = Sheet::new();
        sheet.set_formula("B1", "=1+1");
        sheet.set_formula("A1", "=IF(FALSE,B1,0)");
        assert_eq!(sheet.get_cell("A1"), Value::Number(0.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            1,
            "prewarm should not have evaluated B1 — IF(FALSE,...) skips the then-branch"
        );
    }

    /// IFS — variadic short-circuit. Only the first matching (cond, val)
    /// pair runs at eval time. Prewarm must not greedily evaluate any
    /// of the (cond_i, val_i) pairs beyond the first condition.
    #[test]
    fn ifs_does_not_prewarm_unused_branches() {
        let mut sheet = Sheet::new();
        sheet.set_formula("B1", "=1+1");
        sheet.set_formula("C1", "=2+2");
        sheet.set_formula("D1", "=3+3");
        // First condition is TRUE → only `0` is taken.
        sheet.set_formula("A1", "=IFS(TRUE,0,FALSE,B1,FALSE,C1)");
        assert_eq!(sheet.get_cell("A1"), Value::Number(0.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            1,
            "prewarm should not have evaluated B1/C1 — IFS short-circuits on the first true cond"
        );
        assert!(matches!(sheet.get_cell("D1"), Value::Number(_)));
    }

    /// IFERROR's second arg is only evaluated when the first errors. With
    /// a non-error primary, prewarm must skip the fallback expression.
    #[test]
    fn iferror_does_not_prewarm_fallback() {
        let mut sheet = Sheet::new();
        sheet.set_formula("B1", "=1+1");
        sheet.set_formula("A1", "=IFERROR(0,B1)");
        assert_eq!(sheet.get_cell("A1"), Value::Number(0.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            1,
            "prewarm should not have evaluated B1 — IFERROR fallback only runs on error"
        );
    }

    /// SWITCH: only the matching case (or default) runs. Prewarm must
    /// not greedily evaluate any of the non-leading value expressions.
    /// First (case, value) pair always evaluates the case at eval time,
    /// but the value cells should not be prewarmed.
    #[test]
    fn switch_does_not_prewarm_unused_branches() {
        let mut sheet = Sheet::new();
        sheet.set_formula("B1", "=1+1");
        sheet.set_formula("C1", "=2+2");
        // SWITCH(1, 1, 0, 2, B1, C1) — first case matches → value is 0.
        // B1 (val for case 2) and C1 (default) must not be pre-warmed.
        sheet.set_formula("A1", "=SWITCH(1,1,0,2,B1,C1)");
        assert_eq!(sheet.get_cell("A1"), Value::Number(0.0));
        assert_eq!(
            sheet.debug_formula_eval_count(),
            1,
            "prewarm should not have evaluated B1/C1 — SWITCH only runs the matched value / default"
        );
    }

    /// Re-read after a chain is fully populated: the second read should hit
    /// the Clean cache (no re-eval) and complete in trivial time. Also
    /// pins that the prewarm's early-out for Clean cells works correctly.
    #[test]
    fn chain_1000_native_re_read_uses_cache() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Number(1.0));
        for i in 2..=1000 {
            let addr = format!("A{i}");
            let src = format!("=A{}+1", i - 1);
            assert!(sheet.set_formula(&addr, &src));
        }
        assert_eq!(sheet.get_cell("A1000"), Value::Number(1000.0));
        let count_before = sheet.debug_formula_eval_count();
        // Second read hits the clean Store-derived tail. Counter must not
        // advance.
        assert_eq!(sheet.get_cell("A1000"), Value::Number(1000.0));
        assert_eq!(sheet.debug_formula_eval_count(), count_before);
    }

    // P4c facade/formula-inner path (white-box). These pin that same-sheet
    // formula values and re-derivation flow through Store derived-atom edges
    // (`readAtom` + `dependenciesChange` parity), with no address-level
    // dependency graph.

    /// The facade for a formula cell delegates to its formula-inner atom,
    /// which evaluates the AST via `AtomFormulaProvider` and reads referenced
    /// cells' facades. First read of `A2 = A1 + 5` resolves to 15 purely
    /// through store edges.
    #[test]
    fn facade_reads_formula_via_inner_atom() {
        let mut sheet = Sheet::new();
        // Materialize A1 so this white-box case can mutate its primitive atom
        // directly through Store.
        let a1_inner = sheet.cell_atom("A1");
        sheet.store.set(a1_inner, Value::Number(10.0));
        assert!(sheet.set_formula("A2", "=A1+5"));

        let a2 = CellAddress::parse("A2").unwrap();
        let facade_a2 = sheet.facade_of(a2);
        assert_eq!(sheet.store.get(facade_a2), Value::Number(15.0));
    }

    /// Editing an upstream cell's inner atom re-derives the dependent
    /// formula's facade purely through store dependency edges (vanilla
    /// `dependenciesChange` parity) — no parallel graph, no epoch bump. The
    /// live chain is `a1_inner → facade(A1) → formula_inner(A2) → facade(A2)`.
    #[test]
    fn facade_rederives_on_upstream_store_write() {
        let mut sheet = Sheet::new();
        let a1_inner = sheet.cell_atom("A1");
        sheet.store.set(a1_inner, Value::Number(10.0));
        assert!(sheet.set_formula("A2", "=A1+5"));

        let a2 = CellAddress::parse("A2").unwrap();
        let facade_a2 = sheet.facade_of(a2);
        assert_eq!(sheet.store.get(facade_a2), Value::Number(15.0));

        // Bump the upstream atom's generation; the dependent facade re-derives
        // on the next read with no address-level bookkeeping.
        sheet.store.set(a1_inner, Value::Number(20.0));
        assert_eq!(sheet.store.get(facade_a2), Value::Number(25.0));
    }

    /// F1 runtime cycle guard: a self-referential formula installed PAST the
    /// load-time static cycle check — here via the lazy `formula_source` /
    /// `needs_parse` path that the static local cycle gate never
    /// sees — must resolve to a sticky `#CYCLE!` through `InFlightGuard` /
    /// `in_flight` re-entry detection, not unbounded recursion. The self-read
    /// records a reverse edge via `ReadArgs::depend` (tolerates the computing
    /// peer) so dissolving the cycle later re-invalidates the reader.
    #[test]
    fn facade_runtime_cycle_returns_sticky_cycle() {
        let sheet = Sheet::new();
        let a1 = CellAddress::parse("A1").unwrap();
        // Install `A1 = A1 + 1` directly as a lazy formula, bypassing the
        // load-time static cycle rejection that `set_formula` would apply.
        sheet
            .interior
            .formula_source
            .borrow_mut()
            .insert(a1, ParkedFormula::new("=A1+1"));
        sheet.interior.needs_parse.borrow_mut().insert(a1);

        let facade_a1 = sheet.facade_of(a1);
        assert_eq!(
            sheet.store.get(facade_a1),
            Value::Error(ValueError::CyclicRef)
        );
    }
}
