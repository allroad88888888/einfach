use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use einfach_core::{Store, Value, ValueError};

use crate::cell::CellAddress;
use crate::eval::{
    eval_expr_with_provider, is_builtin_function_name, CustomFunctionRegistry, EvalProvider,
    ExcelLambda, ResolvedTable,
};
use crate::filter::{ColumnFilterRule, FilterApplyReport, FilterError};
use crate::formula::{parse_formula, Expr, RangeBounds, TableArea};
use crate::range::CellRange;
use crate::sheet::{
    BulkInstallCleanup, PendingAsyncCustomCall, ProjectedTable, Sheet, SheetError,
    WorkbookAtomContext,
};

type FormulaOverlay<'a> = HashMap<(usize, CellAddress), Option<&'a Expr>>;

/// One entry in `Workbook::named_values`. Stores the user-supplied
/// canonical-case name alongside the cached `Value` so the registry can
/// report names back to UIs with the casing the user typed, while
/// `define_name` / `undefine_name` / lookup still operate
/// case-insensitively (key is the uppercased form).
///
/// Reserves room for a future `source: Option<String>` field carrying the
/// original formula text — useful when a host wants to round-trip the
/// definition through `serialize → restore`. Not added in this commit
/// because none of the W3 callers need it yet.
#[derive(Clone, Debug)]
struct NamedEntry {
    /// The name as the user originally typed it (e.g. `"Tax_Rate"`),
    /// preserved across read-back so the registry doesn't force-uppercase.
    canonical_name: String,
    /// The materialized value. For LAMBDA-defining formulas this is
    /// `Value::Lambda`; for `=42`-style formulas this is `Value::Number`,
    /// etc.
    value: Value,
}

/// Errors raised by the defined-name registry. Distinct from
/// `SheetError` because the failure modes (parse / eval / reserved name
/// collision) are orthogonal to per-cell write protections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkbookError {
    /// The proposed name collides with a built-in function name (`SUM`,
    /// `IF`, `LAMBDA`, etc.). Excel rejects this with `#NAME?` at
    /// definition time and we mirror the rejection so callers know the
    /// registration would never be reachable (the dispatch table beats
    /// the registry anyway). Comparison is case-insensitive via
    /// `is_builtin_function_name`.
    ReservedName,
    /// The proposed name violates the identifier grammar:
    /// `[A-Za-z_][A-Za-z0-9_]*`, length 1..=255. We deliberately do not
    /// accept dotted names here — Excel's dotted syntax (`T.DIST`) is
    /// reserved for built-ins, and the parser would route `=foo.bar` as
    /// a tokenization error anyway.
    InvalidName,
    /// The formula text supplied to `define_name(name, formula)` failed
    /// to parse (must start with `=` and be a valid expression).
    ParseFailed,
    /// The formula parsed but evaluation surfaced an error (e.g. the
    /// definition references an unbound name, or hits a #DIV/0! during
    /// reduction). The wrapped `ValueError` is the eval-time error so
    /// callers can show the same cell-style code the user would see if
    /// they typed the formula into a cell.
    EvalFailed(ValueError),
    /// Wave 8 re-entrancy guard: the caller tried to mutate the workbook
    /// while a host custom-formula JS callback was executing. A custom call is
    /// part of a Store-derived formula read, so mutating the same workbook
    /// before that read settles would violate the evaluator's purity and
    /// re-enter Store propagation. Reject the mutation and let the host defer
    /// it until after the callback returns.
    /// See `CUSTOM_FORMULAS.md` § "No mutations during callback".
    MutationDuringCustomCall,
    /// The proposed defined-name collides (case-insensitively) with an
    /// existing Excel Table name. Table names and defined names share one
    /// workbook namespace (Excel parity — see the design doc's #32 §4.2),
    /// so `define_name`/`define_name_value` reject a name already claimed
    /// by a Table. The mirror rejection (a Table refusing an existing
    /// defined name) lives on `TableError::NameConflict`.
    NameConflict,
}

impl std::fmt::Display for WorkbookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkbookError::ReservedName => {
                write!(f, "name collides with a built-in function name")
            }
            WorkbookError::InvalidName => write!(
                f,
                "name must match [A-Za-z_][A-Za-z0-9_]* and be 1..=255 chars"
            ),
            WorkbookError::ParseFailed => write!(f, "formula text failed to parse"),
            WorkbookError::EvalFailed(e) => write!(f, "formula evaluation surfaced {}", e),
            WorkbookError::MutationDuringCustomCall => write!(
                f,
                "workbook mutations are forbidden while a custom-formula callback is executing"
            ),
            WorkbookError::NameConflict => {
                write!(f, "name collides with an existing Excel Table name")
            }
        }
    }
}

impl std::error::Error for WorkbookError {}

/// Maximum number of Excel Tables registered in one workbook. A bounded,
/// engine-enforced cap (design doc #32 §4.1) — `define_table` rejects the
/// 257th table with `TableError::TooManyTables`. Mirrors the UI-core
/// `tableCatalogAtom` cache cap so the two layers agree on the ceiling.
const MAX_TABLES: usize = 256;

/// Excel's grid bounds (0-based): 16384 columns (`A`..`XFD` → 0..=16383)
/// and 1048576 rows (1..=1048576 → 0..=1048575). Used by the Table
/// name guard: a name is only "cell-reference-like" (and thus rejected)
/// when it parses to an address INSIDE this grid. `CellAddress::parse`
/// itself is unbounded, so `"Table1"` parses to column `TABLE` (far past
/// `XFD`) and is correctly NOT treated as a cell reference — otherwise the
/// default auto-generated `Table1`..`TableN` names would be unusable.
const GRID_MAX_COL: u32 = 16_383;
const GRID_MAX_ROW: u32 = 1_048_575;

/// One Excel Table registered in a workbook (design doc #32 §4.1). The
/// registry is workbook-level (name uniqueness is a workbook-scoped,
/// cross-sheet concern in Excel); each entry is anchored to a sheet by
/// NAME so `move_sheet` is naturally immune and `rename_sheet` /
/// `remove_sheet` maintain the anchor (§4.4).
///
/// Fields are private; read them through the accessors so the invariant
/// "`columns.len() == range.cols()` and `range` is normalized" stays
/// owned by this module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableEntry {
    /// Name as the user typed it (display casing). The registry key is the
    /// uppercased form, mirroring `NamedEntry::canonical_name`.
    canonical_name: String,
    /// The sheet this Table lives on, by name (the stable anchor — see
    /// the struct doc and §4.4).
    sheet_name: String,
    /// Normalized rectangle covering the header row + data rows (+ totals
    /// row when `has_totals`). Structural edits follow this per §4.3.
    range: CellRange,
    /// MVP invariant: always `true` (a Table's first row is its header).
    /// Kept as a field so the totals/header machinery in later slices has
    /// a real flag to read rather than a hard-coded assumption.
    has_headers: bool,
    /// Whether a totals row is currently shown. T1 stores the flag as a
    /// placeholder (default `false`); the toggle logic that grows the
    /// range and writes `SUBTOTAL` formulas is T5 (§7) and does not land
    /// here.
    has_totals: bool,
    /// Column display names, left→right (index 0 == `range.start.col`).
    /// Matching is case-insensitive but the display casing is preserved.
    columns: Vec<String>,
}

impl TableEntry {
    /// Rebuild an entry from its wire form. The ONLY way to construct a
    /// `TableEntry` outside this module, and it exists for exactly one
    /// caller shape: a host that holds a previously-taken
    /// [`TableRegistrySnapshot`] in serialized form (the wasm
    /// `snapshotTables` / `restoreTables` pair) and needs to rehydrate it.
    ///
    /// Deliberately does NOT validate — the invariants (`columns.len() ==
    /// range.cols()`, name shape, name mutex, no same-sheet overlap) are
    /// enforced as a whole-registry batch by
    /// [`Workbook::restore_tables`], which is the only consumer of the
    /// entries this builds. Building one by hand and never restoring it is
    /// inert.
    pub fn from_parts(
        canonical_name: impl Into<String>,
        sheet_name: impl Into<String>,
        range: CellRange,
        has_headers: bool,
        has_totals: bool,
        columns: Vec<String>,
    ) -> Self {
        TableEntry {
            canonical_name: canonical_name.into(),
            sheet_name: sheet_name.into(),
            range: range.normalize(),
            has_headers,
            has_totals,
            columns,
        }
    }

    /// The Table name in the casing the user supplied.
    pub fn name(&self) -> &str {
        &self.canonical_name
    }

    /// Name of the sheet this Table is anchored to.
    pub fn sheet_name(&self) -> &str {
        &self.sheet_name
    }

    /// The normalized rectangle the Table currently occupies.
    pub fn range(&self) -> CellRange {
        self.range
    }

    /// MVP: always `true`.
    pub fn has_headers(&self) -> bool {
        self.has_headers
    }

    /// Whether a totals row is currently shown (T1: always `false`).
    pub fn has_totals(&self) -> bool {
        self.has_totals
    }

    /// Column display names, left→right.
    pub fn columns(&self) -> &[String] {
        &self.columns
    }

    /// Snapshot this entry as an eval-time `ResolvedTable` anchored at the
    /// given 0-based sheet index (design doc #32 §5.3).
    pub(crate) fn to_resolved(&self, sheet_index: usize) -> crate::eval::ResolvedTable {
        crate::eval::ResolvedTable {
            sheet_name: self.sheet_name.clone(),
            sheet_index,
            range: self.range,
            has_headers: self.has_headers,
            has_totals: self.has_totals,
            columns: self.columns.clone(),
        }
    }
}

/// A whole-registry snapshot of a workbook's Excel Tables — the undo
/// primitive for Table *definition* changes (design doc #32 §11/§12, and
/// CANONICAL_OWNERSHIP §4-3 "注册态重放").
///
/// **REPLACE semantics, deliberately.** [`Workbook::restore_tables`] swaps
/// the entire registry for the snapshot's contents; it is not an additive
/// merge like the sparse-cell primitive (`snapshot_sparse` /
/// `restore_sparse`). Three reasons:
///
/// 1. The registry is tiny and hard-capped at [`MAX_TABLES`] (256), so a
///    full copy costs nothing next to the cell grid that forced ADDITIVE
///    semantics on the sparse primitive.
/// 2. ADDITIVE cannot express deletion. A Table definition change is just
///    as often "this table stopped existing" (`delete_table`, a structural
///    delete that swallowed the header row) as "this table appeared", and
///    an additive restore would silently resurrect nothing while leaving
///    the created table behind — the classic half-undo.
/// 3. Whole-registry equality makes the round-trip assertion exact:
///    `snapshot → mutate → restore` must leave the registry *identical*,
///    columns/range/has_totals included. With REPLACE that is one
///    comparison; with ADDITIVE it is an unbounded diff argument.
///
/// A host undo transaction records `snapshot_tables()` as the before-image,
/// applies the mutation, and calls `restore_tables(before)` to undo. Redo is
/// symmetric with the after-image. The snapshot holds no sheet indices —
/// entries anchor by sheet NAME, exactly like the live registry — so it
/// survives `move_sheet` and sheet-index churn between capture and restore.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TableRegistrySnapshot {
    /// Entries in the registry's stable order (alphabetical by uppercased
    /// name), so two snapshots of equal registries compare equal.
    entries: Vec<TableEntry>,
}

impl TableRegistrySnapshot {
    /// Build a snapshot from entries a host previously serialized. Order is
    /// irrelevant — [`Workbook::restore_tables`] re-keys into the registry's
    /// `BTreeMap`, which imposes the canonical order.
    pub fn from_entries(entries: Vec<TableEntry>) -> Self {
        TableRegistrySnapshot { entries }
    }

    /// The captured entries, for serialization by a host (wasm DTO).
    pub fn entries(&self) -> &[TableEntry] {
        &self.entries
    }

    /// Number of Tables captured.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the snapshot captured an empty registry. Restoring an empty
    /// snapshot CLEARS the registry (that is the whole point of REPLACE) —
    /// it is not a no-op.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// One sheet's manually hidden rows inside a [`HiddenRowsSnapshot`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SheetHiddenRows {
    /// 0-based sheet index at capture time.
    pub sheet_index: usize,
    /// 0-based hidden row indices, ascending and deduplicated.
    pub rows: Vec<u32>,
}

/// Undo / persistence primitive for the engine-owned MANUALLY hidden rows
/// (E2 of `design-engine-hidden-rows.md` §6.2). Shaped after
/// [`TableRegistrySnapshot`]: pure read on capture, whole-workbook REPLACE on
/// restore, so it can express "these rows stopped being hidden" — an additive
/// merge cannot, and unhide is at least as common as hide.
///
/// Unlike the Table registry, entries key by sheet INDEX rather than sheet
/// NAME. Tables need name anchoring because the registry is a workbook-level
/// namespace that must survive `move_sheet` between capture and restore;
/// hidden rows are per-`Sheet` dimension metadata that RIDES a `move_sheet`
/// automatically, and every other per-sheet persistence payload in the
/// codebase (formats, row heights, column widths) is already index-keyed.
/// Entries pointing past the end of the sheet vector are dropped silently on
/// restore rather than failing the transaction, matching how the size and
/// format snapshots degrade.
///
/// Sheets with nothing hidden are omitted, so a workbook with no hidden rows
/// snapshots to an empty vector — which is what lets the persistence-v1 wire
/// field stay `skip_serializing_if = "Vec::is_empty"` and keep byte-identical
/// output for payloads that predate it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HiddenRowsSnapshot {
    sheets: Vec<SheetHiddenRows>,
}

impl HiddenRowsSnapshot {
    /// Build a snapshot from entries a host previously serialized. Order is
    /// irrelevant; [`Workbook::restore_hidden`] applies them by index.
    pub fn from_sheets(sheets: Vec<SheetHiddenRows>) -> Self {
        HiddenRowsSnapshot { sheets }
    }

    /// The captured per-sheet entries, for serialization by a host (wasm DTO).
    pub fn sheets(&self) -> &[SheetHiddenRows] {
        &self.sheets
    }

    /// Number of sheets with at least one hidden row.
    pub fn len(&self) -> usize {
        self.sheets.len()
    }

    /// Whether nothing was hidden anywhere. Restoring an empty snapshot
    /// CLEARS every sheet — it is not a no-op.
    pub fn is_empty(&self) -> bool {
        self.sheets.is_empty()
    }
}

/// One sheet's filter state inside a [`FilterSnapshot`] — the committed
/// rules AND the rows they hid.
///
/// Both halves, deliberately. Restoring rules alone would force a
/// re-derivation against whatever the cells say at restore time, which is
/// live evaluation wearing an undo costume; #27's snapshot semantics
/// requires that an undo puts back the rows that WERE hidden.
#[derive(Clone, Debug, PartialEq)]
pub struct SheetFilterState {
    /// 0-based sheet index at capture time.
    pub sheet_index: usize,
    /// The committed rules.
    pub rules: Vec<ColumnFilterRule>,
    /// The rows those rules hid, ascending and deduplicated.
    pub hidden_rows: Vec<u32>,
}

/// Undo / persistence primitive for the engine-owned filter state (E3 of
/// `design-engine-hidden-rows.md` §6.2). Shaped after
/// [`HiddenRowsSnapshot`], which is itself shaped after
/// [`TableRegistrySnapshot`]: pure read on capture, whole-workbook REPLACE
/// on restore.
///
/// Sheets with no filter are omitted, so an unfiltered workbook snapshots
/// to an empty vector — which is what lets the persistence-v1 wire field
/// stay `skip_serializing_if = "Vec::is_empty"` and keep byte-identical
/// output for payloads that predate it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FilterSnapshot {
    sheets: Vec<SheetFilterState>,
}

impl FilterSnapshot {
    /// Build a snapshot from entries a host previously serialized. Order is
    /// irrelevant; [`Workbook::restore_filters`] applies them by index.
    pub fn from_sheets(sheets: Vec<SheetFilterState>) -> Self {
        FilterSnapshot { sheets }
    }

    /// The captured per-sheet entries, for serialization by a host.
    pub fn sheets(&self) -> &[SheetFilterState] {
        &self.sheets
    }

    pub(crate) fn into_sheets(self) -> Vec<SheetFilterState> {
        self.sheets
    }

    /// Number of sheets with a filter.
    pub fn len(&self) -> usize {
        self.sheets.len()
    }

    /// Whether no sheet had a filter. Restoring an empty snapshot CLEARS
    /// every sheet's filter — it is not a no-op.
    pub fn is_empty(&self) -> bool {
        self.sheets.is_empty()
    }
}

/// Rejections from [`Workbook::restore_hidden`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HiddenRowsError {
    /// A custom-formula callback tried to mutate the workbook it is being
    /// evaluated inside. Mirrors [`TableError::MutationDuringCustomCall`] and
    /// the cell mutators' re-entrancy guard.
    MutationDuringCustomCall,
}

/// Failure modes for the workbook Table registry (design doc #32 §4.1).
/// Distinct from `WorkbookError` (defined-name registry) and `SheetError`
/// (per-cell writes) because Table lifecycle failures are a separate axis.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TableError {
    /// The workbook already holds `MAX_TABLES` (256) tables.
    TooManyTables,
    /// The proposed name violates the identifier grammar (same rule as
    /// `WorkbookError::InvalidName`: `[A-Za-z_][A-Za-z0-9_]*`, 1..=255).
    InvalidName,
    /// The proposed name collides (case-insensitively) with a built-in
    /// function name (`SUM`, `IF`, …).
    ReservedName,
    /// The proposed name parses as an in-grid A1 cell reference (`AB12`).
    /// Such names are unreachable as bare Table references — the parser's
    /// cell-ref branch claims them first — so they are refused at
    /// definition time (§4.2 cond. 3). Grid-bounded on purpose: `Table1`
    /// (column `TABLE`, far past `XFD`) is NOT cell-reference-like and is
    /// allowed.
    NameLikeCellRef,
    /// The proposed name collides (case-insensitively) with another Table
    /// or with a defined name — the two share one workbook namespace.
    NameConflict,
    /// The proposed range overlaps an existing Table on the same sheet.
    RangeOverlap,
    /// `define_table` was given a sheet index outside the workbook.
    SheetNotFound,
    /// No Table is registered under the supplied name (rename/delete/get).
    NotFound,
    /// `rename_table_column` was given an `old_column` that no column of the
    /// Table matches (case-insensitively).
    ColumnNotFound,
    /// `rename_table_column`'s `new_column` collides (case-insensitively)
    /// with a DIFFERENT existing column of the same Table.
    DuplicateColumn,
    /// `rename_table_column`'s `new_column` is empty (would render an
    /// unparseable `Table[]` reference — the empty-column form is deferred,
    /// design §3.2).
    InvalidColumnName,
    /// `set_table_totals_row(name, true)` found the row immediately below the
    /// Table (within its column span) already occupied by a non-empty cell.
    /// The engine refuses to silently push existing content down (design
    /// doc #32 §7 — "被占则显式拒绝，不做隐式插行"); the host surfaces this
    /// so the user can clear the row first. Named `TotalsRowBlocked` per the
    /// design doc.
    TotalsRowBlocked,
    /// `set_table_total_function` was called on a Table whose totals row is
    /// not currently shown (`has_totals == false`). Enable it first via
    /// `set_table_totals_row(name, true)`.
    NoTotalsRow,
    /// A host custom-formula JS callback tried to mutate the Table
    /// registry mid-evaluation. Mirrors every other workbook mutation
    /// entry point's re-entrancy guard.
    MutationDuringCustomCall,
    /// [`Workbook::restore_tables`] was handed an entry whose shape is
    /// internally inconsistent — `columns.len()` disagrees with the
    /// range's column count. Snapshots the engine produced always agree;
    /// this fires only on a host-corrupted or hand-built payload, and the
    /// registry is left untouched (restore validates before it swaps).
    MalformedSnapshot,
}

impl std::fmt::Display for TableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TableError::TooManyTables => {
                write!(f, "workbook already holds the maximum of {MAX_TABLES} tables")
            }
            TableError::InvalidName => write!(
                f,
                "table name must match [A-Za-z_][A-Za-z0-9_]* and be 1..=255 chars"
            ),
            TableError::ReservedName => {
                write!(f, "table name collides with a built-in function name")
            }
            TableError::NameLikeCellRef => {
                write!(f, "table name parses as a cell reference")
            }
            TableError::NameConflict => {
                write!(f, "table name collides with an existing table or defined name")
            }
            TableError::RangeOverlap => {
                write!(f, "table range overlaps an existing table on the same sheet")
            }
            TableError::SheetNotFound => write!(f, "sheet index is outside the workbook"),
            TableError::NotFound => write!(f, "no table registered under that name"),
            TableError::ColumnNotFound => {
                write!(f, "no column of that table matches the supplied name")
            }
            TableError::DuplicateColumn => {
                write!(f, "the new column name collides with another column of the table")
            }
            TableError::InvalidColumnName => write!(f, "column name must not be empty"),
            TableError::TotalsRowBlocked => {
                write!(f, "the row below the table is occupied; clear it before adding a totals row")
            }
            TableError::NoTotalsRow => {
                write!(f, "the table has no totals row; enable it first")
            }
            TableError::MutationDuringCustomCall => write!(
                f,
                "table registry mutations are forbidden while a custom-formula callback is executing"
            ),
            TableError::MalformedSnapshot => write!(
                f,
                "table snapshot entry is malformed: column count does not match the range width"
            ),
        }
    }
}

impl std::error::Error for TableError {}

/// Per-column aggregation for a Table totals-row cell (design doc #32 §7 /
/// I5). Each variant (except `None`) maps to a SUBTOTAL function number in
/// the **101-111** band so the generated totals formula excludes host-pushed
/// hidden rows exactly like every other 101-111 call (T4 / §6) — a filtered
/// or manually-hidden data row drops out of the total, matching Excel's
/// totals-row behaviour. `None` means "no aggregate": the totals cell is
/// cleared.
///
/// The nine choices mirror the UI dropdown vocabulary (§9). Note the
/// deliberate split between `Count` (COUNTA — counts non-empty cells,
/// SUBTOTAL 103) and `CountNums` (COUNT — counts numbers only, SUBTOTAL
/// 102), matching Excel's "Count" vs "Count Numbers" menu entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TotalsFunction {
    /// Clear the totals cell (no aggregate).
    None,
    /// AVERAGE → SUBTOTAL 101.
    Average,
    /// COUNTA (non-empty) → SUBTOTAL 103.
    Count,
    /// COUNT (numbers only) → SUBTOTAL 102.
    CountNums,
    /// MAX → SUBTOTAL 104.
    Max,
    /// MIN → SUBTOTAL 105.
    Min,
    /// SUM → SUBTOTAL 109 (the default applied to the last column when the
    /// totals row is first turned on — Excel parity).
    Sum,
    /// STDEV (sample) → SUBTOTAL 107.
    StdDev,
    /// VAR (sample) → SUBTOTAL 110.
    Var,
}

impl TotalsFunction {
    /// The SUBTOTAL function number this aggregate generates, or `None` for
    /// [`TotalsFunction::None`] (which clears the cell instead of writing a
    /// formula). Always in the 101-111 hidden-excluding band (§7).
    pub fn subtotal_code(self) -> Option<u32> {
        match self {
            TotalsFunction::None => Option::None,
            TotalsFunction::Average => Some(101),
            TotalsFunction::CountNums => Some(102),
            TotalsFunction::Count => Some(103),
            TotalsFunction::Max => Some(104),
            TotalsFunction::Min => Some(105),
            TotalsFunction::StdDev => Some(107),
            TotalsFunction::Sum => Some(109),
            TotalsFunction::Var => Some(110),
        }
    }

    /// Stable lower-camel id used across the WASM / adapter / UI boundary
    /// (matches the design §9 dropdown vocabulary). Companion to
    /// [`TotalsFunction::from_id`].
    pub fn id(self) -> &'static str {
        match self {
            TotalsFunction::None => "none",
            TotalsFunction::Average => "average",
            TotalsFunction::Count => "count",
            TotalsFunction::CountNums => "countNums",
            TotalsFunction::Max => "max",
            TotalsFunction::Min => "min",
            TotalsFunction::Sum => "sum",
            TotalsFunction::StdDev => "stdDev",
            TotalsFunction::Var => "var",
        }
    }

    /// Parse a [`TotalsFunction::id`] string back into the enum. Returns
    /// `None` for an unknown id so the WASM boundary can reject it. The
    /// match is case-sensitive on the canonical camelCase ids.
    pub fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "none" => TotalsFunction::None,
            "average" => TotalsFunction::Average,
            "count" => TotalsFunction::Count,
            "countNums" => TotalsFunction::CountNums,
            "max" => TotalsFunction::Max,
            "min" => TotalsFunction::Min,
            "sum" => TotalsFunction::Sum,
            "stdDev" => TotalsFunction::StdDev,
            "var" => TotalsFunction::Var,
            _ => return Option::None,
        })
    }
}

/// A workbook is an ordered collection of named sheets. Every formula derives
/// through facade/formula-inner atoms in the workbook's shared Store.
pub struct Workbook {
    /// P3 (atom-delegation rewrite): the ONE store shared by every sheet in
    /// this workbook. `Store` is a cheap Rc handle; each sheet holds a
    /// clone. Cross-sheet dependencies become ordinary in-store edges (P6).
    store: Store,
    atom_context: Rc<WorkbookAtomContext>,
    sheets: Vec<Sheet>,
    names: Vec<String>,
    /// name -> index lookup; rebuilt whenever sheets are added/renamed.
    by_name: HashMap<String, usize>,
    /// Number of candidate formula ASTs inspected by install-time workbook
    /// cycle checks. Runtime dependency ownership remains in Store.
    cycle_ast_walk_count: Cell<usize>,
    /// Workbook-level defined names. Keyed by the uppercased form of the
    /// name so lookup is case-insensitive (Excel parity — `=Tax_Rate` and
    /// `=TAX_RATE` resolve to the same entry); the entry's
    /// `canonical_name` field preserves the original casing for UIs.
    ///
    /// Holds arbitrary `Value`s (not just lambdas) so a user can register
    /// `define_name("answer", "=42")` and reference it from any cell.
    /// The dominant use case is LAMBDAs registered as named functions —
    /// `define_name("SQUARE", "=LAMBDA(x, x*x)")` makes `=SQUARE(5)` work
    /// just like a built-in.
    ///
    /// `BTreeMap` rather than `HashMap` so the registry has a stable
    /// iteration order (alphabetical by uppercased name) — useful for
    /// snapshot diffs and serialization. The map is unbounded in this
    /// initial cut; the W2 ROADMAP caps the parallel UI-side named-range
    /// list at 500, and the workbook-core layer can enforce a similar
    /// cap once a host needs it.
    named_values: BTreeMap<String, NamedEntry>,
    /// Host-supplied custom-formula registry (Wave 8). When `Some`, formula
    /// dispatch consults this AFTER built-ins and after defined-name LAMBDAs
    /// (see precedence note on `eval_named_call`). When `None`, unknown
    /// function names surface `#NAME?` exactly as before.
    ///
    /// The trait object owns the JS callback map in the wasm context;
    /// native tests can plug in their own implementation. Kept in an
    /// `Arc` so the per-eval `WorkbookEvalProvider` can clone the handle
    /// cheaply without taking a `&self` borrow on the workbook.
    custom_functions: Option<Arc<dyn CustomFunctionRegistry>>,
    /// Wave 8 re-entrancy guard. Counts the active "inside a host
    /// custom-formula callback" frames (a counter rather than a bool so
    /// nested custom calls — `=A(B())` where `A` and `B` are both customs
    /// — increment/decrement cleanly via RAII). When non-zero, every
    /// public mutation entry point on `Workbook` (`set_cell`,
    /// `clear_cell`, `set_formula`, `define_name`, `undefine_name`,
    /// `set_custom_function_registry`, `add_sheet`, `rename_sheet`,
    /// `remove_sheet`, `bulk_load`, `try_set_*`) is a guarded no-op /
    /// rejection.
    ///
    /// Mutating during a callback would change dependencies while a Store
    /// derivation is active. Rejecting the mutation keeps that derivation
    /// transactional. The contract is documented in `CUSTOM_FORMULAS.md`.
    ///
    /// `Cell<usize>` (not `RefCell<...>`) because mutation is a single
    /// load + store, no aliasing concerns. The guard is `pub(crate)` so
    /// the `WorkbookEvalProvider::call_custom` adapter can bump/decrement
    /// it via the RAII guard in `CustomCallScope`.
    pub(crate) custom_call_depth: Rc<Cell<usize>>,
    /// STORAGE_PRIMARY Phase 6.1 (OD1): monotonically-increasing content
    /// revision. Bumped once per `install_sheet_bulk` (so once per sheet
    /// inside `install_workbook_bulk`) — a bulk install replaces a whole
    /// sheet's content without per-cell notifications, so hosts /
    /// projection layers compare this counter to know "the world
    /// changed, re-read everything". Single-cell mutators do NOT bump it
    /// (they have precise per-cell subscriber fanout already).
    content_revision: u64,
    /// Excel Table registry (design doc #32 §4.1). Keyed by the uppercased
    /// Table name so lookup and the shared name-uniqueness check are
    /// case-insensitive; `TableEntry::canonical_name` keeps the display
    /// casing. `BTreeMap` (not `HashMap`) for a stable, alphabetical
    /// iteration order in `list_tables` — the same rationale as
    /// `named_values`. Bounded to `MAX_TABLES` by `define_table`.
    tables: BTreeMap<String, TableEntry>,
    /// Monotonic counter bumped on every Table registry mutation
    /// (create/rename/delete/structural-follow/sheet-hook) — the observable
    /// witness that a broadcast happened (tests assert it advances). The
    /// REACTIVE half of the broadcast (design doc #32 §8) is the shared
    /// `tables_epoch` Store atom in `WorkbookAtomContext`, which a
    /// structured-reference formula reads through `depend_tables`; see
    /// `bump_tables_epoch`.
    tables_epoch: u64,
}

/// STORAGE_PRIMARY Phase 6.1: result stats from one
/// [`Workbook::install_sheet_bulk`] call.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BulkInstallStats {
    /// Primitive values installed (excludes `Value::Null` entries and
    /// addresses shadowed by a formula in the same payload).
    pub primitives_installed: usize,
    /// Formula sources parked lazily (`formula_source` + `needs_parse`).
    pub formulas_installed: usize,
    /// Install-time formula parses. Retained as a compatibility metric and
    /// always zero: formulas are parked and first evaluated by Store.
    pub cross_sheet_parsed: usize,
}

/// STORAGE_PRIMARY Phase 6.1: rejection reasons for
/// [`Workbook::install_sheet_bulk`] / [`Workbook::install_workbook_bulk`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallError {
    /// The payload referenced a sheet index outside the workbook.
    SheetOutOfRange(usize),
    /// Bulk install attempted from inside a custom-formula callback
    /// (Wave 8 re-entrancy guard — same contract as every other
    /// workbook mutation entry point).
    MutationDuringCustomCall,
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::SheetOutOfRange(idx) => {
                write!(f, "sheet index {idx} is outside the workbook")
            }
            InstallError::MutationDuringCustomCall => {
                write!(
                    f,
                    "bulk install is not allowed inside a custom-formula callback"
                )
            }
        }
    }
}

impl std::error::Error for InstallError {}

/// RAII scope guard that increments `Workbook::custom_call_depth` on
/// construction and decrements on drop. Used by
/// `WorkbookEvalProvider::call_custom` to bracket the JS callback
/// invocation so re-entrant mutation calls (via the WASM bridge) can
/// detect they are inside a callback frame.
///
/// **Why a struct rather than inline `+= 1 / -= 1`**: the JS callback can
/// throw or short-circuit via wasm-bindgen's exception path; the scope
/// guard's `Drop` impl ensures the depth counter is restored regardless
/// of how control leaves the call.
pub(crate) struct CustomCallScope<'a> {
    counter: &'a Cell<usize>,
}

impl<'a> CustomCallScope<'a> {
    pub(crate) fn enter(counter: &'a Cell<usize>) -> Self {
        counter.set(counter.get() + 1);
        CustomCallScope { counter }
    }
}

impl Drop for CustomCallScope<'_> {
    fn drop(&mut self) {
        // Saturating sub guards against an underflow in case the counter
        // somehow goes out of sync (it shouldn't — every enter pairs with
        // a drop). Leaving the counter at 0 on drop means subsequent
        // mutations after callback exit work as normal.
        let prev = self.counter.get();
        self.counter.set(prev.saturating_sub(1));
    }
}

impl Workbook {
    pub fn new() -> Self {
        let store = Store::new();
        let custom_call_depth = Rc::new(Cell::new(0));
        let atom_context = WorkbookAtomContext::new(store.clone(), Rc::clone(&custom_call_depth));
        let mut wb = Workbook {
            store,
            atom_context,
            sheets: Vec::new(),
            names: Vec::new(),
            by_name: HashMap::new(),
            cycle_ast_walk_count: Cell::new(0),
            named_values: BTreeMap::new(),
            custom_functions: None,
            custom_call_depth,
            content_revision: 0,
            tables: BTreeMap::new(),
            tables_epoch: 0,
        };
        // Default sheet so users can `wb.active_mut()` without first calling
        // add_sheet — matches the Excel "blank file already has Sheet1" UX.
        wb.add_sheet("Sheet1");
        wb
    }

    fn sync_atom_topology(&self) {
        let sheets = self
            .sheets
            .iter()
            .enumerate()
            .map(|(idx, sheet)| {
                sheet.attach_workbook_context(&self.atom_context, idx);
                (self.names[idx].clone(), sheet.facade_ctx())
            })
            .collect();
        self.atom_context.sync_topology(sheets);
    }

    fn sync_atom_names(&self) {
        let names = self
            .named_values
            .iter()
            .map(|(key, entry)| (key.clone(), entry.value.clone()))
            .collect();
        self.atom_context.sync_names(names);
    }

    /// Push the current Table registry into the atom context so the
    /// formula-inner provider can resolve structured references (design doc
    /// #32 §5.3). Called from `bump_tables_epoch`, i.e. after every registry
    /// mutation.
    fn sync_atom_tables(&self) {
        let tables = self
            .tables
            .iter()
            .map(|(key, entry)| {
                (
                    key.clone(),
                    ProjectedTable {
                        sheet_name: entry.sheet_name.clone(),
                        range: entry.range,
                        has_headers: entry.has_headers,
                        has_totals: entry.has_totals,
                        columns: entry.columns.clone(),
                    },
                )
            })
            .collect();
        self.atom_context.sync_tables(tables);
    }

    // === Workbook-level defined-name registry ===
    //
    // Two-tier API:
    //   - `define_name(name, formula)` parses + evaluates a `=`-prefixed
    //     formula, then stores the resulting Value under `name`. This is
    //     the "register a LAMBDA as a named function" entry point and is
    //     the path the WASM binding exposes.
    //   - `define_name_value(name, value)` skips parse/eval and stores a
    //     value directly. Used by tests and by hosts that have a Value in
    //     hand (e.g. round-tripping from a serialization layer).
    //
    // Both validate through the same registry path and publish the
    // name-version Store root after the mutation lands.

    /// Parse and evaluate `formula` (must start with `=`), then register
    /// the result under `name`. The dominant use case is registering a
    /// LAMBDA as a callable named function: after
    /// `wb.define_name("SQUARE", "=LAMBDA(x, x*x)")`, the cell formula
    /// `=SQUARE(5)` resolves through the registry's lambda and returns
    /// `25`.
    ///
    /// Evaluation runs in the workbook context (so the definition can
    /// reference cells, other named values, and built-in functions) on
    /// `Sheet1` (sheet index 0) as the "current" sheet for any bare
    /// cell-ref inside the definition. Hosts that need a different
    /// evaluation sheet can build the `Value` themselves and call
    /// `define_name_value` directly.
    ///
    /// Returns `WorkbookError::ParseFailed` for bad formula text,
    /// `WorkbookError::EvalFailed(e)` if evaluation surfaces an error
    /// (the registry is left unchanged in that case), and the same
    /// validation errors as `define_name_value` otherwise.
    pub fn define_name(&mut self, name: &str, formula: &str) -> Result<(), WorkbookError> {
        if self.is_inside_custom_call() {
            return Err(WorkbookError::MutationDuringCustomCall);
        }
        let expr = parse_formula(formula).ok_or(WorkbookError::ParseFailed)?;

        // Evaluate against a workbook provider rooted on sheet 0. Sheet
        // index 0 is guaranteed to exist (constructor seeds Sheet1) so
        // we don't need to guard the index here.
        let provider = WorkbookEvalProvider {
            wb: self,
            current: Cell::new(0),
            current_cell: Cell::new(None),
        };
        let value = eval_expr_with_provider(&expr, &provider);
        // Drop the provider's borrow before mutating self.
        drop(provider);
        if let Value::Error(e) = value {
            return Err(WorkbookError::EvalFailed(e));
        }
        self.define_name_value(name, value)
    }

    /// Register a pre-built `Value` under `name`. Mostly used by tests
    /// and by hosts that already hold a constructed `Value` (e.g. after
    /// deserialization). Production callers usually want `define_name`,
    /// which handles the parse+eval round-trip.
    ///
    /// Validation:
    ///   - `name` must match `[A-Za-z_][A-Za-z0-9_]*`, length 1..=255.
    ///   - The uppercased name must not collide with a built-in function
    ///     name (`SUM`, `IF`, etc.).
    ///
    /// On success, the workbook name-version atom changes. Formulas that read
    /// the registry are invalidated by their recorded Store dependency.
    pub fn define_name_value(&mut self, name: &str, value: Value) -> Result<(), WorkbookError> {
        if self.is_inside_custom_call() {
            return Err(WorkbookError::MutationDuringCustomCall);
        }
        Self::validate_name(name)?;
        let key = name.to_ascii_uppercase();
        if is_builtin_function_name(&key) {
            return Err(WorkbookError::ReservedName);
        }
        // Shared namespace with the Table registry (design doc #32 §4.2,
        // reverse direction): a defined name may not shadow an existing
        // Table name. The forward direction — a Table refusing an existing
        // defined name — is enforced in `validate_table_name`.
        if self.tables.contains_key(&key) {
            return Err(WorkbookError::NameConflict);
        }
        self.named_values.insert(
            key,
            NamedEntry {
                canonical_name: name.to_string(),
                value,
            },
        );
        self.sync_atom_names();
        Ok(())
    }

    /// Remove a previously-registered name. Idempotent — a no-op when
    /// no entry exists for `name`. Returns `true` if an entry was
    /// removed, `false` otherwise. Publishes the workbook name-version root
    /// the same way `define_name` does, so formulas that recorded that Store
    /// dependency re-evaluate and now surface `#NAME?`.
    pub fn undefine_name(&mut self, name: &str) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard
        }
        let key = name.to_ascii_uppercase();
        let removed = self.named_values.remove(&key).is_some();
        if removed {
            self.sync_atom_names();
        }
        removed
    }

    /// Case-insensitive lookup. Returns a clone of the registered
    /// value, or `None` if no entry exists. Top-level evaluator surfaces use
    /// this directly; formula-inner atoms read the synchronized registry
    /// through `WorkbookAtomContext` so the name-version Store edge is
    /// recorded in their active `ReadArgs` frame.
    pub fn get_named(&self, name: &str) -> Option<Value> {
        let key = name.to_ascii_uppercase();
        self.named_values.get(&key).map(|e| e.value.clone())
    }

    /// Iterator over registered names in canonical (user-typed) casing,
    /// sorted alphabetically by their uppercased key. Companion API for
    /// hosts that want to display the registry — the underlying value
    /// is intentionally not exposed here (callers go through
    /// `get_named` if they need it) so a future host that needs only
    /// the names doesn't end up cloning every Lambda.
    pub fn named_names(&self) -> impl Iterator<Item = &str> {
        self.named_values
            .values()
            .map(|e| e.canonical_name.as_str())
    }

    /// Install (or replace) the host's custom-formula registry. Passing
    /// `None` detaches the previous registry — subsequent unknown
    /// function calls fall straight through to `#NAME?` again.
    ///
    /// Wave 8 entry point: the wasm bridge wraps a `js_sys::Function` map in a
    /// `CustomFunctionRegistry` and installs it here. This synchronizes the
    /// registry handle without publishing the custom-registry version root;
    /// hosts that mutate or replace a live registry call
    /// `invalidate_all_formulas_for_custom_function_change` after the change.
    pub fn set_custom_function_registry(
        &mut self,
        registry: Option<Arc<dyn CustomFunctionRegistry>>,
    ) {
        if self.is_inside_custom_call() {
            // Re-entrancy guard. Swapping the registry mid-callback is
            // the worst possible time to do it (the running callback's
            // closure environment becomes orphaned). Drop the request;
            // hosts that need this should defer it past the read.
            return;
        }
        self.custom_functions = registry;
        self.atom_context
            .set_custom_functions(self.custom_functions.clone(), false);
    }

    /// Clone of the currently-installed custom-formula registry handle,
    /// if any. Returns the `Arc<dyn ...>` so the caller can stash it for
    /// later (e.g. the per-eval provider snapshots the Arc up-front so
    /// it survives concurrent re-installs).
    pub fn custom_function_registry(&self) -> Option<Arc<dyn CustomFunctionRegistry>> {
        self.custom_functions.clone()
    }

    /// True iff a host custom-formula JS callback is currently executing
    /// through either formula-inner or top-level evaluation. Public so the
    /// WASM bridge can short-circuit re-entrant
    /// mutation calls with a meaningful error rather than the opaque
    /// `wasm-bindgen` "recursive use of an object" panic.
    ///
    /// See `CUSTOM_FORMULAS.md` § "No mutations during callback" for the
    /// contract.
    pub fn is_inside_custom_call(&self) -> bool {
        self.custom_call_depth.get() > 0
    }

    /// Handle to the re-entrancy depth counter. `pub(crate)` because the
    /// evaluator adapters construct a `CustomCallScope` from this; external
    /// callers should use `is_inside_custom_call` to query.
    pub(crate) fn custom_call_depth_cell(&self) -> &Cell<usize> {
        &self.custom_call_depth
    }

    /// Publish a custom-registry change through its Store version root.
    /// Materialized formulas that called into the registry re-derive through
    /// their recorded Store edge; unread formulas remain lazy. The root is
    /// intentionally coarse and does not retain an address-to-formula or
    /// per-function reverse index.
    pub fn invalidate_all_formulas_for_custom_function_change(&self) {
        self.atom_context
            .set_custom_functions(self.custom_functions.clone(), true);
    }

    /// Drain the queue of async custom-formula calls that evaluation has
    /// requested since the last drain. The host runs each callback on its
    /// own event loop and reports outcomes via `resolve_async_custom_call`.
    /// Call after mutation entry points return — never from inside a
    /// custom-formula callback (returns empty there, matching the other
    /// entry-point guards).
    pub fn take_pending_async_custom_calls(&mut self) -> Vec<PendingAsyncCustomCall> {
        if self.is_inside_custom_call() {
            return Vec::new();
        }
        self.atom_context.take_pending_async_custom_calls()
    }

    /// Diagnostics: number of memoized async custom-formula (name, args)
    /// entries currently cached. Exposed for cap/sweep tests and host
    /// debug probes.
    pub fn async_custom_entry_count(&self) -> usize {
        self.atom_context.async_custom_entry_count()
    }

    /// Settle an async custom-formula call: write `value` into the per-call
    /// result atom and let Store propagation recompute the observers.
    /// Returns `Ok(false)` when the call_id is unknown or stale (the
    /// registry changed while the Promise was in flight) — the value is
    /// dropped. Rejected inside a custom-formula callback like every other
    /// mutation entry point.
    pub fn resolve_async_custom_call(
        &mut self,
        call_id: u64,
        value: Value,
    ) -> Result<bool, WorkbookError> {
        if self.is_inside_custom_call() {
            return Err(WorkbookError::MutationDuringCustomCall);
        }
        Ok(self.atom_context.resolve_async_custom_call(call_id, value))
    }

    fn validate_name(name: &str) -> Result<(), WorkbookError> {
        if name.is_empty() || name.len() > 255 {
            return Err(WorkbookError::InvalidName);
        }
        let mut bytes = name.bytes();
        let first = bytes.next().unwrap();
        let first_ok = first.is_ascii_alphabetic() || first == b'_';
        if !first_ok {
            return Err(WorkbookError::InvalidName);
        }
        for b in bytes {
            let ok = b.is_ascii_alphanumeric() || b == b'_';
            if !ok {
                return Err(WorkbookError::InvalidName);
            }
        }
        Ok(())
    }

    /// Append a new empty sheet. If the name is already taken, returns the
    /// existing index without creating a duplicate.
    pub fn add_sheet(&mut self, name: &str) -> usize {
        if self.is_inside_custom_call() {
            // Re-entrancy guard. Return the existing index if the name
            // happens to exist (idempotent — matches the dup-name branch
            // below) or 0 (Sheet1, always exists) so the caller gets a
            // valid-shaped result. This is the infallible signature; a
            // host that needs the rejection should query
            // `is_inside_custom_call` before calling.
            return self.by_name.get(name).copied().unwrap_or(0);
        }
        if let Some(&idx) = self.by_name.get(name) {
            return idx;
        }
        let idx = self.sheets.len();
        // P3: every sheet shares the workbook's single store, so cross-sheet
        // dependencies can live as ordinary in-store edges (P6).
        self.sheets.push(Sheet::with_store(self.store.clone()));
        self.names.push(name.to_string());
        self.by_name.insert(name.to_string(), idx);
        self.sync_atom_topology();
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
    ///
    /// Formula ASTs store sheet names, so changing topology invalidates the
    /// shared topology atom read by qualified references.
    pub fn rename_sheet(&mut self, idx: usize, new_name: &str) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard
        }
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
        // Table anchor maintenance (design doc #32 §4.4): entries are
        // anchored by sheet NAME, so re-point every Table on the renamed
        // sheet. Bump the epoch only if at least one Table moved.
        let mut table_moved = false;
        for entry in self.tables.values_mut() {
            if entry.sheet_name == old {
                entry.sheet_name = new_name.to_string();
                table_moved = true;
            }
        }
        if table_moved {
            self.bump_tables_epoch();
        }
        self.sync_atom_topology();
        true
    }

    fn rebuild_name_lookup(&mut self) {
        self.by_name.clear();
        for (idx, name) in self.names.iter().enumerate() {
            self.by_name.insert(name.clone(), idx);
        }
    }

    /// Move a sheet from `from` to its final index `to`.
    ///
    /// Formula ASTs store sheet names, so reordering updates the shared
    /// topology atom after the vectors and lookup are rebuilt.
    pub fn move_sheet(&mut self, from: usize, to: usize) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard
        }
        if from >= self.sheets.len() || to >= self.sheets.len() {
            return false;
        }
        if from == to {
            return true;
        }

        let sheet = self.sheets.remove(from);
        let name = self.names.remove(from);
        self.sheets.insert(to, sheet);
        self.names.insert(to, name);
        // The index-keyed hidden-row side stores must ride the same rotation
        // the sheet vector just underwent (see `remove_sheet`).
        self.atom_context.remap_hidden_rows_after_sheet_move(from, to);
        self.rebuild_name_lookup();
        self.sync_atom_topology();
        self.republish_hidden_all(); // see `remove_sheet`
        true
    }

    /// Read a cell from a named sheet. Cross-sheet references in formulas
    /// resolve through this path.
    ///
    /// Every formula reads through its Store facade. Workbook-scoped refs are
    /// resolved by the formula-inner atom against the shared atom context.
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
            current_cell: Cell::new(None),
        };
        let value = self.sheets[idx].peek_value_with_provider(addr, &provider);
        // Match Sheet::get_cell's public read boundary. All workbook sheets
        // share this Store, so one flush settles same- and cross-sheet reads.
        self.store.settle_pending_reads();
        value
    }

    /// Sparse read over one sheet range in workbook context.
    ///
    /// Only non-empty primitive/formula cells inside `range` are visited.
    /// Formula cells resolve through their Store facades, so cross-sheet
    /// references behave the same as `Workbook::get_cell`.
    pub fn for_each_sparse_range_cell(
        &self,
        sheet_idx: usize,
        range: CellRange,
        mut f: impl FnMut(CellAddress, Value),
    ) {
        let Some(sheet) = self.sheets.get(sheet_idx) else {
            return;
        };
        let provider = WorkbookEvalProvider {
            wb: self,
            current: Cell::new(sheet_idx),
            current_cell: Cell::new(None),
        };
        sheet.for_each_sparse_cell_with(
            range,
            &|sheet, addr| sheet.peek_value_with_provider(addr, &provider),
            &mut f,
        );
    }

    #[doc(hidden)]
    pub fn debug_formula_cache_state(&self, sheet_idx: usize, addr_str: &str) -> &'static str {
        self.sheets
            .get(sheet_idx)
            .map(|sheet| sheet.debug_formula_cache_state(addr_str))
            .unwrap_or("missing-sheet")
    }

    /// Live sheet-owned core atoms. Exposed at the workbook level so the E3
    /// suite can assert the negative that matters: a whole `apply_filter`
    /// materializes NO atom, which is how "the derived filter set is not a
    /// derived atom, and the scan registers no dependency edge" is checked
    /// directly rather than inferred.
    #[doc(hidden)]
    pub fn debug_total_atom_count(&self, sheet_idx: usize) -> usize {
        self.sheets
            .get(sheet_idx)
            .map(Sheet::debug_total_atom_count)
            .unwrap_or(0)
    }

    #[doc(hidden)]
    pub fn debug_formula_eval_count(&self, sheet_idx: usize) -> usize {
        self.sheets
            .get(sheet_idx)
            .map(|sheet| sheet.debug_formula_eval_count())
            .unwrap_or(0)
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
    /// **Complexity**: walks formula sources on demand on each call. Worst
    /// case visits every formula reachable from `addr`'s tentative dep set,
    /// across all sheets — at most O(F + R) where F is the total number of
    /// formula cells visited and R is the size of the reachable refs (each
    /// `Range` scans only stored formula cells inside it to avoid `SUM(A:A)`
    /// blowup).
    /// In practice this is bounded by the size of the cross-sheet dep
    /// closure of `addr`, which is small for typical workbooks.
    pub fn set_formula(&mut self, sheet_idx: usize, addr_str: &str, formula_text: &str) -> bool {
        if self.is_inside_custom_call() {
            return false; // re-entrancy guard; see `set_cell` for rationale
        }
        if sheet_idx >= self.sheets.len() {
            return false;
        }
        let addr = match CellAddress::parse(addr_str) {
            Some(a) => a,
            None => return false,
        };

        let array_dependents = self.cross_sheet_array_dependents_for_addr(sheet_idx, addr);

        // Parse first so the workbook-wide static cycle walk can inspect the
        // candidate. The sheet remains the canonical parse-error write path.
        let expr = match parse_formula(formula_text) {
            Some(e) => e,
            None => {
                self.sheets[sheet_idx].set_formula(addr_str, formula_text);
                self.recompute_array_formula_groups(array_dependents);
                return false;
            }
        };

        if self.closes_workbook_cycle(sheet_idx, addr, &expr) {
            self.sheets[sheet_idx].write_error(addr, ValueError::CyclicRef);
            self.recompute_array_formula_groups(array_dependents);
            return false;
        }

        let ok = self.sheets[sheet_idx].set_formula(addr_str, formula_text);
        self.recompute_array_formula_groups(array_dependents);
        ok
    }

    /// Workbook-routed cell write. The target sheet's source atom belongs to
    /// the workbook-scoped Store, so materialized same- and cross-sheet
    /// formulas rederive through their normal dynamic dependencies.
    pub fn set_cell(&mut self, sheet_idx: usize, addr_str: &str, value: Value) {
        if self.is_inside_custom_call() {
            // Re-entrancy guard (Wave 8). A custom-formula JS callback
            // attempted to write through the workbook while the engine
            // was still inside its eval frame. Swallow the mutation
            // silently — the infallible `set_cell` signature can't
            // return an error. Hosts that need the rejection should use
            // `try_set_cell`, which surfaces it via `SheetError`.
            return;
        }
        if sheet_idx >= self.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        let array_dependents = self.cross_sheet_array_dependents_for_addr(sheet_idx, addr);
        self.sheets[sheet_idx].set_cell(addr_str, value);
        self.recompute_array_formula_groups(array_dependents);
    }

    /// Workbook-routed cell clear. Equivalent to `set_cell(idx, addr,
    /// Value::Null)` and provided separately for Delete-key UX.
    pub fn clear_cell(&mut self, sheet_idx: usize, addr_str: &str) {
        if self.is_inside_custom_call() {
            return; // re-entrancy guard; see `set_cell` for rationale
        }
        if sheet_idx >= self.sheets.len() {
            return;
        }
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        let array_dependents = self.cross_sheet_array_dependents_for_addr(sheet_idx, addr);
        self.sheets[sheet_idx].clear_cell(addr_str);
        self.recompute_array_formula_groups(array_dependents);
    }

    /// Fallible variant of `set_cell`. Mirrors `Sheet::try_set_cell`.
    /// returns `Err(SpillCellWrite { anchor })` when the target address
    /// is a non-anchor target of an active spill range. Successful writes
    /// propagate through the same workbook Store as `set_cell`.
    ///
    /// Used by the WASM boundary so JS-side hosts can surface a
    /// "cannot edit spill range" toast instead of silently swallowing
    /// the rejection.
    pub fn try_set_cell(
        &mut self,
        sheet_idx: usize,
        addr_str: &str,
        value: Value,
    ) -> Result<(), SheetError> {
        if self.is_inside_custom_call() {
            return Err(SheetError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(SheetError::InvalidAddress);
        }
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        let array_dependents = self.cross_sheet_array_dependents_for_addr(sheet_idx, addr);
        self.sheets[sheet_idx].try_set_cell(addr_str, value)?;
        self.recompute_array_formula_groups(array_dependents);
        Ok(())
    }

    /// Fallible variant of `clear_cell`. Mirrors `Sheet::try_clear_cell`.
    /// Returns `Err(SpillCellWrite { anchor })` when the target is
    /// inside an active spill range and `clear` was attempted on a
    /// non-anchor target.
    pub fn try_clear_cell(&mut self, sheet_idx: usize, addr_str: &str) -> Result<(), SheetError> {
        if self.is_inside_custom_call() {
            return Err(SheetError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(SheetError::InvalidAddress);
        }
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        let array_dependents = self.cross_sheet_array_dependents_for_addr(sheet_idx, addr);
        self.sheets[sheet_idx].try_clear_cell(addr_str)?;
        self.recompute_array_formula_groups(array_dependents);
        Ok(())
    }

    /// Fallible variant of `set_formula`. Mirrors `Sheet::try_set_formula`
    /// and routes through workbook-wide cycle validation. Returns:
    ///   - `Ok(true)`  — formula parsed and installed.
    ///   - `Ok(false)` — formula parse failed (`#VALUE!`) or cycle (`#CYCLE!`).
    ///   - `Err(SpillCellWrite { anchor })` — target inside a spill range.
    ///   - `Err(InvalidAddress)` — address parse or out-of-range sheet index.
    pub fn try_set_formula(
        &mut self,
        sheet_idx: usize,
        addr_str: &str,
        formula_text: &str,
    ) -> Result<bool, SheetError> {
        if self.is_inside_custom_call() {
            return Err(SheetError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(SheetError::InvalidAddress);
        }
        let addr = CellAddress::parse(addr_str).ok_or(SheetError::InvalidAddress)?;
        // Reject up-front so a spill target cannot be replaced accidentally.
        if self.sheets[sheet_idx].is_spilled(addr) {
            // Re-derive anchor through the sheet-level fallible path so the
            // error carries the same anchor the per-sheet write would have
            // reported.
            return match self.sheets[sheet_idx].try_set_formula(addr_str, formula_text) {
                Err(err) => Err(err),
                // is_spilled() said yes but try_set_formula returned Ok — race
                // against a teardown elsewhere. Treat as a no-op success so
                // the user's keystroke is not lost on the rare race.
                Ok(ok) => Ok(ok),
            };
        }
        // Standard path: delegate to the existing infallible-on-spill
        // workbook variant; the sheet rejection turns into `Ok(false)` per
        // the legacy contract, which is fine since we've already proven the
        // address is not spilled.
        Ok(self.set_formula(sheet_idx, addr_str, formula_text))
    }

    /// Look up the spill anchor for a non-anchor spilled cell on the
    /// given sheet. Returns `None` for plain cells, anchor cells, or
    /// out-of-range sheet indexes. Used by the JS UI to draw the
    /// spill outline around the anchor's bounding rectangle even when
    /// the anchor itself is outside the visible window.
    pub fn spill_anchor(&self, sheet_idx: usize, addr_str: &str) -> Option<CellAddress> {
        let sheet = self.sheets.get(sheet_idx)?;
        let addr = CellAddress::parse(addr_str)?;
        sheet.spill_anchor_for(addr)
    }

    fn cross_sheet_array_dependents_for_addr(
        &self,
        source_sheet: usize,
        addr: CellAddress,
    ) -> Vec<(usize, HashSet<CellAddress>)> {
        let roots = self.sheets[source_sheet].store_root_atoms_for_addr(addr);
        let dependent_atoms = self.store.reverse_dependents(&roots);
        self.sheets
            .iter()
            .enumerate()
            .filter(|(sheet_idx, _)| *sheet_idx != source_sheet)
            .filter_map(|(sheet_idx, sheet)| {
                let addrs = sheet.array_formula_addrs_for_store_atoms(&dependent_atoms);
                (!addrs.is_empty()).then_some((sheet_idx, addrs))
            })
            .collect()
    }

    fn recompute_array_formula_groups(&mut self, groups: Vec<(usize, HashSet<CellAddress>)>) {
        for (sheet_idx, addrs) in groups {
            if let Some(sheet) = self.sheets.get_mut(sheet_idx) {
                sheet.recompute_array_formulas_in(&addrs);
            }
        }
    }

    /// Clear every non-empty cell inside a range without materializing
    /// every address in that range. The metadata scan is sparse and does
    /// not evaluate formulas; `bulk_load` coalesces all Store propagation.
    pub fn clear_range(&mut self, sheet_idx: usize, range: CellRange) -> usize {
        let Some(sheet) = self.sheets.get(sheet_idx) else {
            return 0;
        };
        let mut addrs: Vec<CellAddress> = Vec::new();
        sheet.for_each_non_empty_in_range(range, |addr| {
            addrs.push(addr);
        });
        let count = addrs.len();
        self.bulk_load(|loader| {
            for addr in addrs {
                // Typed entry (AUDIT A-9): no `to_string` → re-parse
                // round trip per cleared cell.
                loader.clear_cell_at(sheet_idx, addr);
            }
        });
        count
    }

    /// Install-time cycle check across workbook formulas. Formula sources are
    /// inspected on demand because an unread lazy formula intentionally has no
    /// Store dependency edges yet. Runtime ownership and invalidation remain in
    /// the shared Store; this walk retains no second dependency graph.
    fn closes_workbook_cycle(&self, target_idx: usize, target: CellAddress, expr: &Expr) -> bool {
        self.closes_workbook_cycle_with_overlay(target_idx, target, expr, &FormulaOverlay::new())
    }

    fn closes_workbook_cycle_with_overlay(
        &self,
        target_idx: usize,
        target: CellAddress,
        expr: &Expr,
        overlay: &FormulaOverlay<'_>,
    ) -> bool {
        let mut visited: HashSet<(usize, CellAddress)> = HashSet::new();
        let mut to_visit: Vec<(usize, CellAddress)> = Vec::new();
        self.cycle_ast_walk_count
            .set(self.cycle_ast_walk_count.get() + 1);
        let mut visiting_names = HashSet::new();
        if self.collect_workbook_cycle_refs(
            expr,
            target_idx,
            (target_idx, target),
            &mut to_visit,
            &mut visiting_names,
            false,
            overlay,
        ) {
            return true;
        }

        while let Some((idx, addr)) = to_visit.pop() {
            if idx == target_idx && addr == target {
                return true;
            }
            if !visited.insert((idx, addr)) {
                continue;
            }
            let mut visiting_names = HashSet::new();
            if let Some(next) = overlay.get(&(idx, addr)) {
                let Some(next) = *next else {
                    continue;
                };
                if self.collect_workbook_cycle_refs(
                    next,
                    idx,
                    (target_idx, target),
                    &mut to_visit,
                    &mut visiting_names,
                    true,
                    overlay,
                ) {
                    return true;
                }
            } else {
                let Some(next) = self
                    .sheets
                    .get(idx)
                    .and_then(|sheet| sheet.cycle_expr_for(addr))
                else {
                    continue;
                };
                if self.collect_workbook_cycle_refs(
                    &next,
                    idx,
                    (target_idx, target),
                    &mut to_visit,
                    &mut visiting_names,
                    true,
                    overlay,
                ) {
                    return true;
                }
            }
        }
        false
    }

    fn collect_workbook_cycle_refs(
        &self,
        expr: &Expr,
        current_idx: usize,
        target: (usize, CellAddress),
        out: &mut Vec<(usize, CellAddress)>,
        visiting_names: &mut HashSet<String>,
        detect_unbounded_target: bool,
        overlay: &FormulaOverlay<'_>,
    ) -> bool {
        match expr {
            Expr::CellRef(addr, _) => {
                if (current_idx, *addr) == target {
                    return true;
                }
                out.push((current_idx, *addr));
            }
            Expr::Range {
                start,
                end,
                unbounded,
                ..
            } => {
                if self.collect_cycle_range_refs(
                    current_idx,
                    CellRange::new(*start, *end),
                    *unbounded,
                    target,
                    out,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
            }
            Expr::SheetRef { sheet, addr, .. } => {
                if let Some(&sheet_idx) = self.by_name.get(sheet) {
                    if (sheet_idx, *addr) == target {
                        return true;
                    }
                    out.push((sheet_idx, *addr));
                }
            }
            Expr::SheetRange {
                sheet,
                start,
                end,
                unbounded,
                ..
            } => {
                if let Some(&sheet_idx) = self.by_name.get(sheet) {
                    if self.collect_cycle_range_refs(
                        sheet_idx,
                        CellRange::new(*start, *end),
                        *unbounded,
                        target,
                        out,
                        detect_unbounded_target,
                        overlay,
                    ) {
                        return true;
                    }
                }
            }
            Expr::BinOp { left, right, .. } => {
                if self.collect_workbook_cycle_refs(
                    left,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) || self.collect_workbook_cycle_refs(
                    right,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
            }
            Expr::Negate(inner) | Expr::SpillRef(inner) => {
                if self.collect_workbook_cycle_refs(
                    inner,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
            }
            Expr::FuncCall { name, args } => {
                if self.collect_named_cycle_refs(
                    name,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
                for arg in args {
                    if self.collect_workbook_cycle_refs(
                        arg,
                        current_idx,
                        target,
                        out,
                        visiting_names,
                        detect_unbounded_target,
                        overlay,
                    ) {
                        return true;
                    }
                }
            }
            Expr::DynamicRange { start, end } => {
                if self.collect_workbook_cycle_refs(
                    start,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) || self.collect_workbook_cycle_refs(
                    end,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
            }
            Expr::Name(name) => {
                if self.collect_named_cycle_refs(
                    name,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
            }
            Expr::Call(callee, args) => {
                if self.collect_workbook_cycle_refs(
                    callee,
                    current_idx,
                    target,
                    out,
                    visiting_names,
                    detect_unbounded_target,
                    overlay,
                ) {
                    return true;
                }
                for arg in args {
                    if self.collect_workbook_cycle_refs(
                        arg,
                        current_idx,
                        target,
                        out,
                        visiting_names,
                        detect_unbounded_target,
                        overlay,
                    ) {
                        return true;
                    }
                }
            }
            Expr::ArrayLit { data, .. } | Expr::MultiArea(data) => {
                for item in data {
                    if self.collect_workbook_cycle_refs(
                        item,
                        current_idx,
                        target,
                        out,
                        visiting_names,
                        detect_unbounded_target,
                        overlay,
                    ) {
                        return true;
                    }
                }
            }
            Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => {}
            // Structured (Table) reference: no static A1 ref to follow for
            // cross-sheet cycle detection (design doc §5.2). It resolves
            // dynamically; a Table-mediated cycle surfaces at eval time as
            // `#CYCLE!` via the runtime in-flight guard (§5.3 point 5).
            Expr::TableRef { .. } => {}
        }
        false
    }

    fn collect_cycle_range_refs(
        &self,
        sheet_idx: usize,
        range: CellRange,
        unbounded: RangeBounds,
        target: (usize, CellAddress),
        out: &mut Vec<(usize, CellAddress)>,
        detect_unbounded_target: bool,
        overlay: &FormulaOverlay<'_>,
    ) -> bool {
        let range = range.normalize();
        if sheet_idx == target.0
            && range.contains(target.1)
            && (detect_unbounded_target || unbounded == RangeBounds::None)
        {
            return true;
        }
        if let Some(sheet) = self.sheets.get(sheet_idx) {
            let mut formula_addrs = sheet.formula_addrs_in_range(range);
            for ((overlay_sheet_idx, addr), expr) in overlay {
                if *overlay_sheet_idx != sheet_idx || !range.contains(*addr) {
                    continue;
                }
                if expr.is_some() {
                    formula_addrs.insert(*addr);
                } else {
                    formula_addrs.remove(addr);
                }
            }
            out.extend(formula_addrs.into_iter().map(|addr| (sheet_idx, addr)));
        }
        false
    }

    fn collect_named_cycle_refs(
        &self,
        name: &str,
        current_idx: usize,
        target: (usize, CellAddress),
        out: &mut Vec<(usize, CellAddress)>,
        visiting_names: &mut HashSet<String>,
        detect_unbounded_target: bool,
        overlay: &FormulaOverlay<'_>,
    ) -> bool {
        let key = name.to_ascii_uppercase();
        if !visiting_names.insert(key.clone()) {
            return false;
        }
        let result = self.named_values.get(&key).is_some_and(|entry| {
            self.collect_value_cycle_refs(
                &entry.value,
                current_idx,
                target,
                out,
                visiting_names,
                detect_unbounded_target,
                overlay,
            )
        });
        visiting_names.remove(&key);
        result
    }

    fn collect_value_cycle_refs(
        &self,
        value: &Value,
        current_idx: usize,
        target: (usize, CellAddress),
        out: &mut Vec<(usize, CellAddress)>,
        visiting_names: &mut HashSet<String>,
        detect_unbounded_target: bool,
        overlay: &FormulaOverlay<'_>,
    ) -> bool {
        let Value::Lambda(lambda) = value else {
            return false;
        };
        let Some(lambda) = lambda.as_any().downcast_ref::<ExcelLambda>() else {
            return false;
        };
        if self.collect_workbook_cycle_refs(
            &lambda.body,
            current_idx,
            target,
            out,
            visiting_names,
            detect_unbounded_target,
            overlay,
        ) {
            return true;
        }
        lambda.captured.iter().any(|(_, captured)| {
            self.collect_value_cycle_refs(
                captured,
                current_idx,
                target,
                out,
                visiting_names,
                detect_unbounded_target,
                overlay,
            )
        })
    }

    /// Remove a sheet by index. Returns the removed sheet so callers can
    /// inspect / dispose of its atoms if needed.
    ///
    /// Updating the topology root invalidates every derived formula that
    /// resolved a sheet name through the shared Store.
    pub fn remove_sheet(&mut self, idx: usize) -> Option<Sheet> {
        if self.is_inside_custom_call() {
            return None; // re-entrancy guard
        }
        if idx >= self.sheets.len() {
            return None;
        }
        let sheet = self.sheets.remove(idx);
        sheet.detach_workbook_context();
        let name = self.names.remove(idx);
        self.by_name.remove(&name);
        // Table anchor maintenance (design doc #32 §4.4): drop every Table
        // anchored to the removed sheet. Formulas on OTHER sheets that
        // referenced those Tables surface `#NAME?` at eval time (T3);
        // recovering the Tables on a deleteSheet-undo is a host-replay
        // concern (§12), out of this slice.
        let before = self.tables.len();
        self.tables.retain(|_, t| t.sheet_name != name);
        if self.tables.len() != before {
            self.bump_tables_epoch();
        }
        // Hidden-row maintenance: the Table registry above is keyed by NAME and
        // so is immune to the index shift, but the two hidden-row side stores
        // are keyed by sheet INDEX and must be shifted down explicitly, or
        // SUBTOTAL 1-11 / 101-111 start filtering against another sheet's rows.
        self.atom_context.remap_hidden_rows_after_sheet_remove(idx);
        self.rebuild_name_lookup();
        self.sync_atom_topology();
        // The MANUAL half is engine-owned since E2 and rides the `Sheet` that
        // just moved, so re-assert the mirror from the owning side (and drop
        // the now-out-of-range top key). No-ops when the remap above already
        // produced the same answer, which it should.
        self.republish_hidden_all();
        Some(sheet)
    }

    /// Retained for host compatibility. Cross-sheet dependencies now live in
    /// Store and no workbook-owned reverse-edge table exists.
    #[doc(hidden)]
    pub fn debug_cross_sheet_reverse_edge_count(&self) -> usize {
        0
    }

    /// Debug-only: number of candidate ASTs checked for cycles.
    #[doc(hidden)]
    pub fn debug_cycle_ast_walk_count(&self) -> usize {
        self.cycle_ast_walk_count.get()
    }

    /// Retained for host compatibility. Store propagation has no loader BFS.
    #[doc(hidden)]
    pub fn debug_loader_bfs_seed_count(&self) -> usize {
        0
    }

    /// STORAGE_PRIMARY Phase 6.1: read the content revision counter
    /// (OD1). Bumped once per `install_sheet_bulk`; hosts compare
    /// successive values to detect whole-sheet replaces that bypass
    /// per-cell subscriber fanout.
    pub fn content_revision(&self) -> u64 {
        self.content_revision
    }

    /// Storage-primary bulk install: swap pre-built maps directly into the
    /// sheet. Formula parsing and dependency discovery stay lazy; when read,
    /// each formula derives through its formula-inner atom in the shared Store.
    pub fn install_sheet_bulk(
        &mut self,
        sheet_idx: usize,
        primitives: HashMap<CellAddress, Value>,
        formulas: HashMap<CellAddress, String>,
    ) -> Result<BulkInstallStats, InstallError> {
        let store = self.store.clone();
        let mut result = None;
        store.batch(|_| {
            result = Some(self.install_sheet_bulk_inner(sheet_idx, primitives, formulas));
        });
        let (stats, cleanup) = result.expect("sheet install batch closure did not run")?;
        self.sheets[sheet_idx].finish_bulk_install(cleanup);
        Ok(stats)
    }

    /// Body shared by the single-sheet and whole-workbook install APIs.
    fn install_sheet_bulk_inner(
        &mut self,
        sheet_idx: usize,
        primitives: HashMap<CellAddress, Value>,
        formulas: HashMap<CellAddress, String>,
    ) -> Result<(BulkInstallStats, BulkInstallCleanup), InstallError> {
        if self.is_inside_custom_call() {
            return Err(InstallError::MutationDuringCustomCall);
        }
        if sheet_idx >= self.sheets.len() {
            return Err(InstallError::SheetOutOfRange(sheet_idx));
        }

        let (primitives_installed, formulas_installed, cleanup) =
            self.sheets[sheet_idx].bulk_install_storage(primitives, formulas);

        // OD1: bump the revision so subscribers / projections know the
        // world changed without per-cell notifications.
        self.content_revision += 1;

        Ok((
            BulkInstallStats {
                primitives_installed,
                formulas_installed,
                cross_sheet_parsed: 0,
            },
            cleanup,
        ))
    }

    /// Whole-workbook variant of [`Self::install_sheet_bulk`] (OD2):
    /// one call installs every sheet's pre-built maps. Sheet indexes
    /// are validated up front so the call is all-or-nothing — no
    /// partial install when a later entry is out of range. The
    /// per-SHEET loop here is fine (sheet counts are small); the
    /// per-CELL loop is what the storage-primary refactor kills.
    pub fn install_workbook_bulk(
        &mut self,
        payload: Vec<(
            usize,
            HashMap<CellAddress, Value>,
            HashMap<CellAddress, String>,
        )>,
    ) -> Result<Vec<BulkInstallStats>, InstallError> {
        if self.is_inside_custom_call() {
            return Err(InstallError::MutationDuringCustomCall);
        }
        for (sheet_idx, _, _) in &payload {
            if *sheet_idx >= self.sheets.len() {
                return Err(InstallError::SheetOutOfRange(*sheet_idx));
            }
        }
        let store = self.store.clone();
        let mut result = None;
        store.batch(|_| {
            result = Some(
                payload
                    .into_iter()
                    .map(|(sheet_idx, primitives, formulas)| {
                        self.install_sheet_bulk_inner(sheet_idx, primitives, formulas)
                            .map(|(stats, cleanup)| (sheet_idx, stats, cleanup))
                    })
                    .collect::<Result<Vec<_>, InstallError>>(),
            );
        });
        let installed = result.expect("workbook install batch closure did not run")?;
        let mut stats = Vec::with_capacity(installed.len());
        for (sheet_idx, sheet_stats, cleanup) in installed {
            self.sheets[sheet_idx].finish_bulk_install(cleanup);
            stats.push(sheet_stats);
        }
        Ok(stats)
    }

    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut WorkbookLoader<'_>) -> R) -> R {
        // Re-entrancy guard for Wave 8 custom-formula callbacks. We can't
        // refuse cleanly without breaking the signature, so we still let
        // the loader run — but we plumb the guard through to
        // `WorkbookLoader` so each buffered write checks the depth at
        // entry-into-this-API time (NOT at flush time, which always runs
        // in a clean frame). Practically: a custom callback that calls
        // `wb.bulk_load(|l| { l.set_cell(...); })` finds the loader's
        // `set_cell` calls becoming no-ops via the same guard the direct
        // `Workbook::set_cell` honors.
        let mut loader = WorkbookLoader::new(self);
        let result = f(&mut loader);
        loader.flush();
        result
    }

    // ===================================================================
    // Excel Table registry (design doc #32 T1: §4.1 / §4.2 / §4.3 / §4.4 /
    // §8 broadcast seam). Pure registry data + CRUD + name mutex +
    // structural follow. Structured-reference PARSING (T2) and EVALUATION
    // (T3/T4) are out of this slice — nothing here touches formula.rs /
    // eval.rs / sheet.rs internals.
    // ===================================================================

    /// Register a new Excel Table (design doc #32 §4.1).
    ///
    /// - `name`: `Some(n)` uses `n` (validated below); `None` auto-generates
    ///   the first free `Table1`, `Table2`, … .
    /// - `sheet_index`: the anchoring sheet; `TableError::SheetNotFound`
    ///   when out of range.
    /// - `range`: normalized here; row 0 of the range is the header row.
    ///   Rejected with `TableError::RangeOverlap` if it intersects an
    ///   existing Table on the same sheet.
    /// - `has_headers`: MVP callers pass `true` (the flag is stored as-is
    ///   so later slices can relax it).
    ///
    /// Column names are read from the header row's cells; blank or
    /// duplicate headers are disambiguated to `Column1`, `Column2`, ….
    /// Returns the final (canonical-cased) Table name on success.
    ///
    /// Only registry metadata is created — cell values, formulas, and
    /// formats are untouched (a Table is a *view* over existing cells).
    pub fn define_table(
        &mut self,
        name: Option<&str>,
        sheet_index: usize,
        range: CellRange,
        has_headers: bool,
    ) -> Result<String, TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        if sheet_index >= self.sheets.len() {
            return Err(TableError::SheetNotFound);
        }
        let range = range.normalize();
        let sheet_name = self.names[sheet_index].clone();

        // Overlap check against existing tables on the SAME sheet.
        if self
            .tables
            .values()
            .any(|t| t.sheet_name == sheet_name && ranges_overlap(t.range, range))
        {
            return Err(TableError::RangeOverlap);
        }

        // Cap check happens before name resolution so a rejected 257th
        // table never perturbs the auto-name counter.
        if self.tables.len() >= MAX_TABLES {
            return Err(TableError::TooManyTables);
        }

        let canonical_name = match name {
            Some(n) => {
                self.validate_table_name(n, None)?;
                n.to_string()
            }
            None => self.next_auto_table_name(),
        };
        let key = canonical_name.to_ascii_uppercase();

        let columns = self.derive_column_names(&sheet_name, range);

        self.tables.insert(
            key,
            TableEntry {
                canonical_name: canonical_name.clone(),
                sheet_name,
                range,
                has_headers,
                has_totals: false,
                columns,
            },
        );
        self.bump_tables_epoch();
        Ok(canonical_name)
    }

    /// Remove a Table's registry entry ("convert to range" — design doc
    /// §4.1). Cell values, formulas, and formats are left in place; only
    /// the Table semantics are dropped. `TableError::NotFound` when the
    /// name is unknown.
    pub fn delete_table(&mut self, name: &str) -> Result<(), TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        let key = name.to_ascii_uppercase();
        if self.tables.remove(&key).is_none() {
            return Err(TableError::NotFound);
        }
        self.bump_tables_epoch();
        Ok(())
    }

    /// Rename a Table (design doc §4.1 / §4.3). Re-validates `new_name`
    /// against the full name mutex (grammar / built-in / cell-ref-form /
    /// conflict), excluding the Table's own current key so a case-only
    /// rename works, then rewrites the TEXT of every formula that references
    /// the old name (`OldName[…]` → `NewName[…]`) across all sheets.
    pub fn rename_table(&mut self, name: &str, new_name: &str) -> Result<(), TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        let old_key = name.to_ascii_uppercase();
        if !self.tables.contains_key(&old_key) {
            return Err(TableError::NotFound);
        }
        self.validate_table_name(new_name, Some(&old_key))?;
        let new_key = new_name.to_ascii_uppercase();
        // Remove-then-reinsert (the key changes unless it's a case-only
        // rename, which `validate_table_name`'s self-exclusion permits).
        let mut entry = self.tables.remove(&old_key).expect("existence checked above");
        entry.canonical_name = new_name.to_string();
        self.tables.insert(new_key, entry);
        // Sync the projection to the new name BEFORE rewriting referencing
        // formulas so their re-install resolves the renamed Table.
        self.sync_atom_tables();
        let spec = crate::shift::TableRefEditSpec::RenameTable {
            from: old_key,
            to: new_name.to_string(),
        };
        self.rewrite_table_refs_across_sheets(&spec, None);
        self.bump_tables_epoch();
        Ok(())
    }

    /// Rename one column of a Table (design doc §4.1 / §4.3; the engine half
    /// of the I3 header-edit → column-rename story). Updates the registry
    /// column name — the source of truth for `Table[Col]` resolution — and
    /// rewrites the TEXT of every referencing formula (`Table[Old]` →
    /// `Table[New]`, plus table-less `[Old]` inside the Table's own cells).
    ///
    /// The visible HEADER CELL text is left untouched: the canonical trigger
    /// (§I3) is a header-cell edit, which already carries the new text, and
    /// resolution reads the registry, not the header cell. A direct call
    /// (e.g. a Name Manager rename) thus lags the header display until the
    /// host writes it — a documented MVP boundary.
    pub fn rename_table_column(
        &mut self,
        table_name: &str,
        old_column: &str,
        new_column: &str,
    ) -> Result<(), TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        if new_column.trim().is_empty() {
            return Err(TableError::InvalidColumnName);
        }
        let key = table_name.to_ascii_uppercase();
        let Some(entry) = self.tables.get(&key) else {
            return Err(TableError::NotFound);
        };
        let col_idx = entry
            .columns
            .iter()
            .position(|c| c.eq_ignore_ascii_case(old_column))
            .ok_or(TableError::ColumnNotFound)?;
        // Collision with a DIFFERENT column is rejected; a case-only rename
        // of the same column is allowed.
        if entry
            .columns
            .iter()
            .enumerate()
            .any(|(i, c)| i != col_idx && c.eq_ignore_ascii_case(new_column))
        {
            return Err(TableError::DuplicateColumn);
        }
        let anchor_sheet = entry.sheet_name.clone();
        let table_range = entry.range;
        self.tables
            .get_mut(&key)
            .expect("existence checked above")
            .columns[col_idx] = new_column.to_string();
        self.sync_atom_tables();
        let spec = crate::shift::TableRefEditSpec::RenameColumn {
            table_upper: key,
            from: old_column.to_string(),
            to: new_column.to_string(),
        };
        self.rewrite_table_refs_across_sheets(&spec, Some((&anchor_sheet, table_range)));
        self.bump_tables_epoch();
        Ok(())
    }

    /// Rewrite structured-reference formula text across every sheet per
    /// `spec` (design doc §4.3). `anchor` is `Some((sheet_name, range))` for
    /// a column rename, so table-less `[Col]` references inside the Table's
    /// own cells on its anchor sheet are rewritten too; `None` for a table
    /// rename (bare references carry no table name and never match).
    ///
    /// Collect (immutable sheet reads) then apply (`set_formula`) in two
    /// passes: the borrow checker forbids holding a sheet borrow across the
    /// mutable re-install, and the apply pass reuses the proven formula-edit
    /// path (parking, cycle check, subscriber notification).
    fn rewrite_table_refs_across_sheets(
        &mut self,
        spec: &crate::shift::TableRefEditSpec,
        anchor: Option<(&str, CellRange)>,
    ) {
        let mut rewrites: Vec<(usize, CellAddress, String)> = Vec::new();
        for idx in 0..self.sheets.len() {
            let bare_range = match anchor {
                Some((sheet_name, range)) if self.names[idx].as_str() == sheet_name => Some(range),
                _ => None,
            };
            let bare_for = |addr: CellAddress| bare_range.is_some_and(|r| r.contains(addr));
            for (addr, text) in self.sheets[idx].collect_table_ref_rewrites(spec, &bare_for) {
                rewrites.push((idx, addr, text));
            }
        }
        for (idx, addr, text) in rewrites {
            let a1 = addr.to_string_repr();
            self.set_formula(idx, &a1, &text);
        }
    }

    /// Case-insensitive Table lookup. `None` when no Table is registered
    /// under `name`.
    pub fn get_table(&self, name: &str) -> Option<&TableEntry> {
        self.tables.get(&name.to_ascii_uppercase())
    }

    /// Every registered Table, in stable (alphabetical-by-uppercased-name)
    /// order.
    pub fn list_tables(&self) -> Vec<&TableEntry> {
        self.tables.values().collect()
    }

    /// Number of registered Tables. Companion to the `MAX_TABLES` cap.
    pub fn table_count(&self) -> usize {
        self.tables.len()
    }

    // --- Registry snapshot / restore (design doc #32 §11/§12) ------------
    //
    // The undo primitive for Table DEFINITION changes. Everything a Table
    // op writes into CELLS (the totals row's `SUBTOTAL` formulas, the cell
    // moves a structural edit performs) is already covered by the host's
    // sparse-cell and format snapshots; what had no before-image until now
    // is the registry itself — name, sheet anchor, range, header/totals
    // flags, column names. These two calls close that gap, and the host
    // pairs them with the existing cell primitives inside one undo
    // transaction.

    /// Capture the entire Table registry (see [`TableRegistrySnapshot`] for
    /// why this is REPLACE rather than additive). Pure read — no epoch bump,
    /// no reactive traffic.
    pub fn snapshot_tables(&self) -> TableRegistrySnapshot {
        TableRegistrySnapshot {
            entries: self.tables.values().cloned().collect(),
        }
    }

    /// Replace the entire Table registry with `snapshot`, returning the
    /// number of Tables now registered.
    ///
    /// **All-or-nothing.** Every entry is validated before anything is
    /// swapped, so a rejected restore leaves the live registry byte-for-byte
    /// unchanged (mirroring `restore_persistence_v1`'s reject-without-
    /// mutating discipline). Validation re-asserts the invariants
    /// `define_table` enforces, because a snapshot is host-held data that
    /// may have been serialized, stored, and replayed against a workbook
    /// that has moved on since capture:
    ///
    /// - cap — more than [`MAX_TABLES`] entries → [`TableError::TooManyTables`];
    /// - name shape — [`TableError::InvalidName`] / [`ReservedName`] /
    ///   [`NameLikeCellRef`](TableError::NameLikeCellRef);
    /// - name mutex — duplicates within the snapshot, or a collision with a
    ///   defined name that exists NOW, → [`TableError::NameConflict`]
    ///   (the shared workbook namespace of §4.2 survives restore);
    /// - geometry — two entries overlapping on one sheet →
    ///   [`TableError::RangeOverlap`]; `columns.len()` disagreeing with the
    ///   range width → [`TableError::MalformedSnapshot`].
    ///
    /// Entries anchored to a sheet that no longer exists are **kept, not
    /// dropped**: the registry anchors by name and the eval-side resolver
    /// already degrades a missing anchor to `#NAME?` (never a panic), so a
    /// host replaying "undo deleteSheet" can restore the registry in either
    /// order and the references light up once the sheet is back. Silently
    /// discarding them would make the primitive lossy and the undo
    /// one-directional.
    ///
    /// On a change, bumps the tables epoch — which republishes the Table
    /// projection to the formula-inner provider AND wakes every formula
    /// holding a `depend_tables` edge, so `=SUM(Table1[Qty])` re-derives
    /// against the restored geometry. A restore that reproduces the current
    /// registry exactly is detected and skips the bump, so undoing a
    /// non-Table edit inside a transaction that snapshots tables anyway
    /// costs no spurious recompute.
    pub fn restore_tables(
        &mut self,
        snapshot: TableRegistrySnapshot,
    ) -> Result<usize, TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        if snapshot.entries.len() > MAX_TABLES {
            return Err(TableError::TooManyTables);
        }

        // Phase 1 — validate into a candidate map. Nothing on `self` is
        // touched until every entry has passed.
        let mut next: BTreeMap<String, TableEntry> = BTreeMap::new();
        for entry in snapshot.entries {
            let name = entry.canonical_name.as_str();
            if Self::validate_name(name).is_err() {
                return Err(TableError::InvalidName);
            }
            let key = name.to_ascii_uppercase();
            if is_builtin_function_name(&key) {
                return Err(TableError::ReservedName);
            }
            if name_is_cell_ref_like(name) {
                return Err(TableError::NameLikeCellRef);
            }
            // Shared namespace, evaluated against the CURRENT defined
            // names — a name that became a defined name after the snapshot
            // was taken must not be re-claimed behind its back.
            if self.named_values.contains_key(&key) {
                return Err(TableError::NameConflict);
            }
            if next.contains_key(&key) {
                return Err(TableError::NameConflict);
            }

            let range = entry.range.normalize();
            if entry.columns.len() as u32 != range.cols() {
                return Err(TableError::MalformedSnapshot);
            }
            if next
                .values()
                .any(|t| t.sheet_name == entry.sheet_name && ranges_overlap(t.range, range))
            {
                return Err(TableError::RangeOverlap);
            }

            next.insert(
                key,
                TableEntry {
                    canonical_name: entry.canonical_name,
                    sheet_name: entry.sheet_name,
                    range,
                    has_headers: entry.has_headers,
                    has_totals: entry.has_totals,
                    columns: entry.columns,
                },
            );
        }

        // Phase 2 — swap, and broadcast only if the registry really moved.
        let count = next.len();
        if next == self.tables {
            return Ok(count);
        }
        self.tables = next;
        self.bump_tables_epoch();
        Ok(count)
    }

    // --- Totals row (design doc #32 §7 / I5) ----------------------------
    //
    // The totals row is a Table-internal behaviour, NOT a sheet structural
    // op: toggling it grows/shrinks the Table's own range by one row and
    // writes/clears `=SUBTOTAL(1xx, Table[Col])` formulas through the normal
    // `set_formula` / `clear_cell` paths, so the totals cells participate in
    // the recompute graph and the host's cell-level undo snapshots with no
    // second source of truth (the cell formula *is* the fact — §7).

    /// Toggle a Table's totals row (design doc #32 §7).
    ///
    /// `enabled == true`: the row immediately below the Table (within its
    /// column span) must be entirely empty; if occupied the call fails with
    /// [`TableError::TotalsRowBlocked`] and nothing changes — the engine
    /// never silently pushes existing content down. On success the Table's
    /// `range` grows one row, `has_totals` becomes true, and the **last
    /// column** gets a default `=SUBTOTAL(109, Table[Col])` (SUM) — Excel's
    /// default. Every other totals cell is left blank; a host sets those via
    /// [`Workbook::set_table_total_function`].
    ///
    /// `enabled == false`: every totals-row cell in the Table's column span
    /// is cleared (including any the user hand-edited), the `range` shrinks
    /// one row, and `has_totals` becomes false.
    ///
    /// Idempotent: enabling an already-totalled Table (or disabling one
    /// without a totals row) is a successful no-op. `TableError::NotFound`
    /// for an unknown name; guarded against re-entrant custom-formula calls.
    pub fn set_table_totals_row(&mut self, name: &str, enabled: bool) -> Result<(), TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        let key = name.to_ascii_uppercase();
        let Some(entry) = self.tables.get(&key) else {
            return Err(TableError::NotFound);
        };
        if entry.has_totals == enabled {
            return Ok(()); // idempotent no-op
        }
        let sheet_name = entry.sheet_name.clone();
        let range = entry.range.normalize();
        let sheet_index = match self.index_of(&sheet_name) {
            Some(i) => i,
            // A Table anchored to a missing sheet shouldn't happen (the
            // sheet-lifecycle hooks keep the anchor valid), but fail closed
            // rather than panic.
            None => return Err(TableError::NotFound),
        };

        if enabled {
            let totals_row = range.end.row + 1;
            // Occupancy guard: the row below the Table, across its columns.
            if self.range_has_content(
                sheet_index,
                CellRange::new(
                    CellAddress::new(totals_row, range.start.col),
                    CellAddress::new(totals_row, range.end.col),
                ),
            ) {
                return Err(TableError::TotalsRowBlocked);
            }
            // Grow the range + flip the flag, then publish the new geometry
            // BEFORE writing the SUBTOTAL formula so its `Table[Col]` (= the
            // #Data band, which now correctly EXCLUDES the totals row)
            // resolves against current geometry on first evaluation.
            let (canonical, last_col_name, last_col_idx) = {
                let e = self.tables.get_mut(&key).expect("existence checked above");
                e.range = CellRange::new(
                    e.range.start,
                    CellAddress::new(totals_row, range.end.col),
                );
                e.has_totals = true;
                let last_idx = e.columns.len().saturating_sub(1);
                (
                    e.canonical_name.clone(),
                    e.columns.last().cloned(),
                    last_idx,
                )
            };
            self.bump_tables_epoch();
            // Excel default: SUM (109) in the LAST column only.
            if let Some(col_name) = last_col_name {
                let addr = CellAddress::new(totals_row, range.start.col + last_col_idx as u32);
                let text = totals_subtotal_formula(&canonical, &col_name, 109);
                self.set_formula(sheet_index, &addr.to_string_repr(), &text);
            }
        } else {
            // Toggle off: clear the totals-row cells (current last row of the
            // range), then shrink and flip the flag.
            let totals_row = range.end.row;
            for i in 0..range.cols() {
                let addr = CellAddress::new(totals_row, range.start.col + i);
                self.clear_cell(sheet_index, &addr.to_string_repr());
            }
            {
                let e = self.tables.get_mut(&key).expect("existence checked above");
                let new_end_row = e.range.end.row.saturating_sub(1);
                e.range = CellRange::new(
                    e.range.start,
                    CellAddress::new(new_end_row, e.range.end.col),
                );
                e.has_totals = false;
            }
            self.bump_tables_epoch();
        }
        Ok(())
    }

    /// Set (or clear) the aggregate function of one totals-row column
    /// (design doc #32 §7). The Table must already have a totals row
    /// ([`TableError::NoTotalsRow`] otherwise). `func == TotalsFunction::None`
    /// clears the cell; any other variant writes `=SUBTOTAL(1xx, Table[Col])`
    /// with the 101-111 hidden-excluding code (§6 / §7). The written formula
    /// is the single source of truth — the registry stores no per-column
    /// selection, so a UI reconstructs the dropdown state by reading the
    /// cell's formula back.
    ///
    /// `TableError::NotFound` for an unknown Table, `ColumnNotFound` for an
    /// unknown column; guarded against re-entrant custom-formula calls.
    pub fn set_table_total_function(
        &mut self,
        name: &str,
        column: &str,
        func: TotalsFunction,
    ) -> Result<(), TableError> {
        if self.is_inside_custom_call() {
            return Err(TableError::MutationDuringCustomCall);
        }
        let key = name.to_ascii_uppercase();
        let Some(entry) = self.tables.get(&key) else {
            return Err(TableError::NotFound);
        };
        if !entry.has_totals {
            return Err(TableError::NoTotalsRow);
        }
        let col_idx = entry
            .columns
            .iter()
            .position(|c| c.eq_ignore_ascii_case(column))
            .ok_or(TableError::ColumnNotFound)?;
        let range = entry.range.normalize();
        let sheet_name = entry.sheet_name.clone();
        let canonical = entry.canonical_name.clone();
        // Use the registry's canonical column casing in the generated
        // formula (not the caller's), so re-reads are stable and the rename
        // walker matches it.
        let col_name = entry.columns[col_idx].clone();
        let sheet_index = match self.index_of(&sheet_name) {
            Some(i) => i,
            None => return Err(TableError::NotFound),
        };
        let totals_row = range.end.row;
        let addr = CellAddress::new(totals_row, range.start.col + col_idx as u32);
        match func.subtotal_code() {
            None => self.clear_cell(sheet_index, &addr.to_string_repr()),
            Some(code) => {
                let text = totals_subtotal_formula(&canonical, &col_name, code);
                self.set_formula(sheet_index, &addr.to_string_repr(), &text);
            }
        }
        Ok(())
    }

    /// True iff any cell inside `range` on `sheet_index` holds a non-empty
    /// primitive or a formula. Used by the totals-row occupancy guard.
    fn range_has_content(&self, sheet_index: usize, range: CellRange) -> bool {
        let Some(sheet) = self.sheets.get(sheet_index) else {
            return false;
        };
        let mut occupied = false;
        sheet.for_each_non_empty_in_range(range, |_| {
            occupied = true;
        });
        occupied
    }

    // === Engine-owned MANUAL hidden rows ================================
    //
    // E2 of `solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md`.
    //
    // Storage moved from "host-pushed evaluation input the engine keeps in a
    // side map" to "a `Sheet` field the engine owns", with
    // `WorkbookAtomContext::eval_hidden_rows` demoted to a read-only
    // evaluation MIRROR that exactly one private publisher writes
    // (`republish_hidden`). The mirror stays because the reason it existed
    // has not gone away: a cross-sheet `SUBTOTAL` resolves from inside the
    // formula-inner provider, which holds no `&Workbook` and so cannot reach
    // any `Sheet`.
    //
    // The host is still the WRITER in this slice — `set_eval_hidden_rows`
    // keeps its exact signature (INV-4 fingerprints parameters, so changing
    // one is a removal) and is simply re-pointed at the owned state. Nothing
    // observable changes: push the same rows, evaluate the same numbers. The
    // engine does not yet decide anything for itself; it has become the
    // authoritative STORE, not yet the authoritative SOURCE.
    //
    // Filter-hidden rows are NOT owned yet (E3). They keep their own store,
    // their own epoch, and their own host port.

    /// Push the host's per-sheet MANUALLY-hidden row set as SUBTOTAL 101-111
    /// evaluation input (design doc #32 §6, CANONICAL_OWNERSHIP §7-1).
    ///
    /// Signature and contract are verbatim what they have always been —
    /// full-replace (`rows` becomes the complete manual hidden set for
    /// `sheet_index`; an empty slice clears it), out-of-range sheet index is
    /// a silent no-op, and a call from inside a custom-formula callback is
    /// refused by the re-entrancy guard. What changed underneath is the
    /// destination: the rows now land in `Sheet::hidden_rows`, and the
    /// evaluation mirror is refreshed from there by `republish_hidden`.
    ///
    /// One consequence is visible only through a recomputation counter: a
    /// byte-identical re-push no longer bumps `manual_hidden_epoch`, because
    /// the de-duplication ledger the host bridge used to keep now lives in
    /// `publish_eval_hidden_rows`. Values are unaffected — a skipped bump
    /// only skips re-deriving formulas that would have produced the same
    /// answer.
    pub fn set_eval_hidden_rows(&mut self, sheet_index: usize, rows: &[u32]) {
        if self.is_inside_custom_call() {
            return;
        }
        let Some(sheet) = self.sheets.get_mut(sheet_index) else {
            return;
        };
        sheet.replace_hidden_rows(rows.iter().copied().collect());
        self.republish_hidden(sheet_index);
    }

    /// Mark `rows` (0-based) hidden on `sheet_index`, additively. Returns
    /// whether anything changed; `false` covers an out-of-range sheet, an
    /// empty request, rows that were already hidden, and a call refused by
    /// the custom-call re-entrancy guard.
    pub fn hide_rows(&mut self, sheet_index: usize, rows: &[u32]) -> bool {
        self.mutate_hidden_rows(sheet_index, |sheet| sheet.hide_rows(rows))
    }

    /// Un-hide `rows` (0-based) on `sheet_index`. Rows that were not hidden
    /// are ignored. Returns whether anything changed.
    pub fn unhide_rows(&mut self, sheet_index: usize, rows: &[u32]) -> bool {
        self.mutate_hidden_rows(sheet_index, |sheet| sheet.unhide_rows(rows))
    }

    /// The manually hidden rows on `sheet_index`, ascending. Empty for an
    /// out-of-range sheet — a missing sheet hides nothing, which is the same
    /// "no filtering" signal an absent mirror entry carries.
    pub fn list_hidden_rows(&self, sheet_index: usize) -> Vec<u32> {
        self.sheets
            .get(sheet_index)
            .map(Sheet::hidden_rows)
            .unwrap_or_default()
    }

    /// Shared body of `hide_rows` / `unhide_rows`: guard, mutate the owned
    /// set, republish only if it moved.
    fn mutate_hidden_rows(
        &mut self,
        sheet_index: usize,
        mutate: impl FnOnce(&mut Sheet) -> bool,
    ) -> bool {
        if self.is_inside_custom_call() {
            return false;
        }
        let Some(sheet) = self.sheets.get_mut(sheet_index) else {
            return false;
        };
        if !mutate(sheet) {
            return false;
        }
        self.republish_hidden(sheet_index);
        true
    }

    /// Copy one sheet's owned hidden sets into the evaluation mirrors. THE
    /// only writer of either mirror (design §2.1). Manual at E2, filter as
    /// well since E3.
    ///
    /// Call sites are finite and enumerable: the two host push ports,
    /// `hide_rows` / `unhide_rows`, `apply_filter` / `reapply_filter` /
    /// `clear_filter`, the structural-shift wrappers, `restore_hidden` /
    /// `restore_filters`, and the sheet-lifecycle reconciliation in
    /// `republish_hidden_all`. Cheap and idempotent — both publishers
    /// compare before they write, so republishing unchanged sets costs two
    /// set comparisons and fires no epoch.
    ///
    /// The two halves are judged INDEPENDENTLY (§3), which is what keeps the
    /// #27 two-epoch split worth having: a manual hide must not dirty the
    /// `SUBTOTAL(1-11)` formulas that hold only the filter edge, and vice
    /// versa.
    fn republish_hidden(&self, sheet_index: usize) {
        let Some(sheet) = self.sheets.get(sheet_index) else {
            return;
        };
        let manual: HashSet<u32> = sheet.hidden_row_set().iter().copied().collect();
        self.atom_context
            .publish_eval_hidden_rows(sheet_index, manual);
        let filtered: HashSet<u32> = sheet
            .filter_hidden_set()
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default();
        self.atom_context
            .publish_eval_filter_hidden_rows(sheet_index, filtered);
    }

    /// Reconcile the whole mirror against the sheet vector. Used after a
    /// topology change (`remove_sheet` / `move_sheet`), where the mirror has
    /// just been re-keyed to follow the same rotation the sheet vector
    /// underwent: this re-asserts the outcome from the owning side rather
    /// than trusting two independent index remaps to agree forever, and drops
    /// any entry left keyed past the end of the vector.
    ///
    /// Costs nothing when they already agree — every comparison short-
    /// circuits and no epoch fires.
    fn republish_hidden_all(&self) {
        self.atom_context
            .drop_eval_hidden_rows_above(self.sheets.len());
        self.atom_context
            .drop_eval_filter_hidden_rows_above(self.sheets.len());
        for sheet_index in 0..self.sheets.len() {
            self.republish_hidden(sheet_index);
        }
    }

    /// Capture every sheet's manually hidden rows (see [`HiddenRowsSnapshot`]
    /// for why this is REPLACE rather than additive). Pure read — no epoch
    /// bump, no reactive traffic. Sheets with nothing hidden are omitted.
    ///
    /// A host undo transaction records `snapshot_hidden()` as the
    /// before-image, applies the mutation, and calls `restore_hidden(before)`
    /// to undo — the same shape `snapshot_tables` / `restore_tables` already
    /// document.
    pub fn snapshot_hidden(&self) -> HiddenRowsSnapshot {
        HiddenRowsSnapshot::from_sheets(
            self.sheets
                .iter()
                .enumerate()
                .filter(|(_, sheet)| !sheet.hidden_row_set().is_empty())
                .map(|(sheet_index, sheet)| SheetHiddenRows {
                    sheet_index,
                    rows: sheet.hidden_rows(),
                })
                .collect(),
        )
    }

    /// Replace every sheet's manually hidden rows with `snapshot`, returning
    /// the number of sheets that ended up with at least one hidden row.
    ///
    /// REPLACE across the WHOLE workbook: a sheet the snapshot does not
    /// mention is cleared, not left alone. That is what makes an undo of
    /// "hide rows on a previously-unhidden sheet" symmetric.
    ///
    /// Entries whose `sheet_index` is past the end of the sheet vector are
    /// dropped silently — the snapshot may have been captured against a wider
    /// workbook, and refusing the whole transaction over a sheet that no
    /// longer exists would make the primitive one-directional. (The Table
    /// registry keeps such entries instead, because it anchors by NAME and a
    /// deleted sheet can come back under the same name; an index cannot be
    /// resurrected meaningfully.)
    ///
    /// Epochs fire per sheet and only where the set actually moved, so a
    /// restore that reproduces the current state costs no recompute — which
    /// matters because a host that snapshots hidden state in every undo
    /// transaction will restore identical state most of the time.
    pub fn restore_hidden(
        &mut self,
        snapshot: HiddenRowsSnapshot,
    ) -> Result<u32, HiddenRowsError> {
        if self.is_inside_custom_call() {
            return Err(HiddenRowsError::MutationDuringCustomCall);
        }
        let sheet_count = self.sheets.len();
        let mut wanted: Vec<BTreeSet<u32>> = vec![BTreeSet::new(); sheet_count];
        for entry in snapshot.sheets() {
            if entry.sheet_index >= sheet_count {
                continue; // captured against a wider workbook
            }
            wanted[entry.sheet_index].extend(entry.rows.iter().copied());
        }
        let mut restored = 0u32;
        for (sheet_index, rows) in wanted.into_iter().enumerate() {
            if !rows.is_empty() {
                restored += 1;
            }
            if self.sheets[sheet_index].replace_hidden_rows(rows) {
                self.republish_hidden(sheet_index);
            }
        }
        Ok(restored)
    }

    /// Push the host's per-sheet FILTER-hidden row set as read-only evaluation
    /// input (`design-filter-hidden-rows` §6.2). Additive twin of
    /// `set_eval_hidden_rows` — that port and its whole chain are untouched.
    ///
    /// Excel's rule this exists to express: `SUBTOTAL(1-11)` excludes
    /// filter-hidden rows but INCLUDES manually hidden ones, while
    /// `SUBTOTAL(101-111)` excludes both. Only two independently addressable
    /// sets can carry that distinction.
    ///
    /// Signature and contract are verbatim what they have always been (INV-4
    /// fingerprints parameters, so changing one counts as a removal):
    /// full-replace, empty slice clears, per-sheet keyed, out-of-range sheet
    /// is a silent no-op, refused during a host custom-formula callback. What
    /// changed underneath at E3 is the destination — the rows now land in the
    /// owned `Sheet::filter`, and the evaluation mirror is refreshed from
    /// there by `republish_hidden`.
    ///
    /// The rows arrive WITHOUT rules, because that is what this port has
    /// always carried: the host computed the answer with its own predicate
    /// and is handing over the result. Any rules already committed by
    /// `apply_filter` are left alone. The paired `filter_hidden_epoch` bump
    /// re-derives BOTH SUBTOTAL layers (both read this set) without touching
    /// the manual epoch.
    ///
    /// One consequence is visible only through a recomputation counter: a
    /// byte-identical re-push no longer bumps `filter_hidden_epoch`, because
    /// the de-duplication moved into `publish_eval_filter_hidden_rows` (§3).
    /// Values are unaffected — a skipped bump only skips re-deriving formulas
    /// that would have produced the same answer. The manual half took the
    /// same change at E2.
    pub fn set_eval_filter_hidden_rows(&mut self, sheet_index: usize, rows: &[u32]) {
        if self.is_inside_custom_call() {
            return;
        }
        let Some(sheet) = self.sheets.get_mut(sheet_index) else {
            return;
        };
        sheet.replace_filter_hidden_rows(rows.iter().copied().collect());
        self.republish_hidden(sheet_index);
    }

    // === Engine-owned FILTER (E3) =======================================
    //
    // E3 of `solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md`.
    //
    // The engine now owns the RULES and evaluates the PREDICATE itself,
    // instead of receiving a row set the host derived. Same staging as E2:
    // the host is still the writer in this slice (it keeps calling
    // `set_eval_filter_hidden_rows` above), so the product's behaviour is
    // unchanged. The engine has become the authoritative STORE for filter
    // state; it does not become the authoritative SOURCE until the host
    // switches to calling `apply_filter`.
    //
    // THE ONE INVARIANT THIS SECTION EXISTS TO PROTECT: predicate evaluation
    // is IMPERATIVE and happens at exactly three entry points. It is not a
    // derived atom, and design §2.2 gives three reasons in descending
    // severity:
    //
    //   1. A derived atom would close a REAL dependency cycle. `SUBTOTAL`
    //      reads the filter set; a derived filter set would read the
    //      predicate column's cells; put a `SUBTOTAL` in a predicate column
    //      and the graph has a loop. The compute-then-commit shape below
    //      dodges it the same way both host adapters do — the scan sees the
    //      PREVIOUS filter set, never the one it is producing.
    //   2. It would make filtering LIVE, and Excel's is not (#27: the
    //      pre-#27 implementation recomputed on every revision bump, which
    //      made our filter *more live than Excel's* — a divergence, not a
    //      feature). `Data -> Reapply` is the sanctioned refresh path.
    //   3. Cost: a whole-column rescan on every cell write.
    //
    // Structurally, not by convention: nothing outside these three entry
    // points can write the derived set, and none of them registers a
    // dependency edge, because the scan reads through the eager
    // `for_each_sparse_range_cell` path rather than a tracked one.

    /// Apply `rules` to `sheet_index`: run the predicate ONCE, commit both
    /// the rules and the rows they hid, and republish the evaluation mirror.
    ///
    /// An empty `rules` slice is the same statement as `clear_filter`.
    ///
    /// Rejections mutate NOTHING (see [`FilterError`]) — in particular an
    /// over-budget source leaves the previous visibility standing rather
    /// than truncating the scan and showing a confidently wrong answer,
    /// which is the host adapter's existing `FILTER_SORT_SOURCE_TOO_LARGE`
    /// behaviour.
    pub fn apply_filter(
        &mut self,
        sheet_index: usize,
        rules: &[ColumnFilterRule],
    ) -> Result<FilterApplyReport, FilterError> {
        self.run_filter(sheet_index, rules.to_vec())
    }

    /// `Data -> Reapply` (Excel `Ctrl+Alt+L`): re-run the ALREADY COMMITTED
    /// rules against current cell values.
    ///
    /// This carries no rules of its own, and that is the point — reapply can
    /// never change WHAT is filtered, only WHICH rows currently satisfy it.
    /// It is also the only supported way to refresh visibility after an
    /// edit, which is what makes the snapshot semantics livable.
    ///
    /// A sheet with no committed filter reapplies to nothing.
    pub fn reapply_filter(&mut self, sheet_index: usize) -> Result<FilterApplyReport, FilterError> {
        let rules = self
            .sheets
            .get(sheet_index)
            .ok_or(FilterError::InvalidSheet)?
            .filter()
            .map(|filter| filter.rules().to_vec())
            .unwrap_or_default();
        self.run_filter(sheet_index, rules)
    }

    /// Drop `sheet_index`'s filter: rules and derived rows both. Cheap and
    /// scan-free — there is nothing to evaluate.
    pub fn clear_filter(&mut self, sheet_index: usize) -> Result<FilterApplyReport, FilterError> {
        if self.is_inside_custom_call() {
            return Err(FilterError::MutationDuringCustomCall);
        }
        let sheet = self
            .sheets
            .get_mut(sheet_index)
            .ok_or(FilterError::InvalidSheet)?;
        if sheet.clear_filter() {
            self.republish_hidden(sheet_index);
        }
        Ok(FilterApplyReport::default())
    }

    /// The committed filter rules on `sheet_index`, or empty.
    pub fn filter_rules(&self, sheet_index: usize) -> Vec<ColumnFilterRule> {
        self.sheets
            .get(sheet_index)
            .and_then(Sheet::filter)
            .map(|filter| filter.rules().to_vec())
            .unwrap_or_default()
    }

    /// The rows `sheet_index`'s filter currently hides, ascending.
    pub fn filter_hidden_rows(&self, sheet_index: usize) -> Vec<u32> {
        self.sheets
            .get(sheet_index)
            .map(Sheet::filter_hidden_rows)
            .unwrap_or_default()
    }

    /// Shared body of `apply_filter` / `reapply_filter`: guard, scan behind
    /// `&self`, THEN commit.
    ///
    /// The two-phase split is not stylistic. The scan has to read cell
    /// values, which needs `&self` for the eager evaluation provider, while
    /// committing needs `&mut self`; doing them in one pass is not
    /// expressible. It also happens to be exactly the ordering that keeps
    /// the derivation non-circular — a `SUBTOTAL` sitting in a predicate
    /// column resolves against the PREVIOUS filter set, because the new one
    /// does not exist yet. Both host adapters take the same care today
    /// ("Deliberately the PREVIOUS filter set … which keeps the derivation
    /// non-circular on both hosts").
    fn run_filter(
        &mut self,
        sheet_index: usize,
        rules: Vec<ColumnFilterRule>,
    ) -> Result<FilterApplyReport, FilterError> {
        if self.is_inside_custom_call() {
            return Err(FilterError::MutationDuringCustomCall);
        }
        if sheet_index >= self.sheets.len() {
            return Err(FilterError::InvalidSheet);
        }

        // Phase 1 — scan, behind `&self`, into locals. Nothing is committed
        // yet, so a rejection below leaves the workbook untouched.
        let (hidden, scanned_rows, predicate_cells) = self.scan_filter(sheet_index, &rules)?;

        // Phase 2 — commit, then republish the mirror from the owning side.
        let report = FilterApplyReport {
            hidden_rows: hidden.iter().copied().collect(),
            scanned_rows,
            predicate_cells,
        };
        if self.sheets[sheet_index].commit_filter(rules, hidden) {
            self.republish_hidden(sheet_index);
        }
        Ok(report)
    }

    /// ONE predicate scan. `&self` throughout, and deliberately so: every
    /// cell read goes through `for_each_sparse_range_cell`, the same eager
    /// path `readSparseRange` uses at the wasm boundary, which registers no
    /// Store dependency edge. A tracked read here would wire the predicate
    /// columns into the reactive graph and bring liveness back through the
    /// back door — see the section header.
    ///
    /// Extent, columns and budget are the host adapter's arithmetic,
    /// transcribed so the answer cannot move:
    ///
    ///   - extent = `max_non_empty_row + 1` over the WHOLE sheet, from the
    ///     same `for_each_non_empty` walk `listNonEmpty` exposes — not the
    ///     predicate columns' own extent;
    ///   - columns = column 0 (summary-row probe) plus each rule's column;
    ///   - budget = `rows * columns` against [`MAX_FILTER_PREDICATE_CELLS`].
    fn scan_filter(
        &self,
        sheet_index: usize,
        rules: &[ColumnFilterRule],
    ) -> Result<(BTreeSet<u32>, u32, u32), FilterError> {
        let sheet = self.sheets.get(sheet_index).ok_or(FilterError::InvalidSheet)?;

        // No rules means NO SCAN AT ALL — checked before the extent probe
        // and before the budget, which is not merely an optimisation. The
        // host short-circuits in exactly this order (`if
        // (!filterSortHasEffect(next)) { … return }` sits above the
        // `listNonEmpty` extent probe in `setFilterSort`), so budgeting an
        // empty rule set here would make CLEARING a filter fail on any
        // sheet too large to scan — a workbook could get permanently stuck
        // filtered. Applying no rules is a pure state change.
        if rules.is_empty() {
            return Ok((BTreeSet::new(), 0, 0));
        }

        let cols = crate::filter::predicate_columns(rules);

        let mut max_row: Option<u32> = None;
        sheet.for_each_non_empty(|addr| {
            max_row = Some(match max_row {
                Some(current) if current >= addr.row => current,
                _ => addr.row,
            });
        });
        let scanned_rows = max_row.map(|row| row + 1).unwrap_or(0);

        let predicate_cells = scanned_rows.saturating_mul(cols.len() as u32);
        if predicate_cells > crate::filter::MAX_FILTER_PREDICATE_CELLS {
            return Err(FilterError::SourceTooLarge {
                rows: scanned_rows,
                columns: cols.len() as u32,
                predicate_cells,
            });
        }
        if scanned_rows == 0 {
            return Ok((BTreeSet::new(), scanned_rows, predicate_cells));
        }

        sheet.note_filter_scan();
        let last_row = scanned_rows - 1;
        let mut values: HashMap<(u32, u32), String> = HashMap::new();
        for &col in &cols {
            let range = CellRange::new(
                CellAddress::new(0, col),
                CellAddress::new(last_row, col),
            );
            self.for_each_sparse_range_cell(sheet_index, range, |addr, value| {
                values.insert((addr.row, addr.col), crate::value_to_display(&value));
            });
        }
        // A read boundary, exactly like `get_cell`'s: settle the derived
        // states the scan parked so an unrelated later write does not
        // inherit bookkeeping proportional to the whole scan.
        self.store.settle_pending_reads();

        // Absent cell == empty string, matching `values.get(...) ?? ''` on
        // the host side. Sparse iteration only visits non-empty cells, so
        // this is where blank rows acquire the `""` that `Number("")` then
        // turns into 0 for a `range` rule.
        let hidden = crate::filter::hidden_rows_for_scan(rules, scanned_rows, |row, col| {
            values.get(&(row, col)).cloned().unwrap_or_default()
        });
        Ok((hidden, scanned_rows, predicate_cells))
    }

    /// Cumulative predicate scans on `sheet_index` — the observable that
    /// proves visibility is a snapshot: cell writes, structural edits and
    /// epoch bumps must all leave it alone.
    #[doc(hidden)]
    pub fn debug_filter_scan_count(&self, sheet_index: usize) -> u64 {
        self.sheets
            .get(sheet_index)
            .map(Sheet::debug_filter_scan_count)
            .unwrap_or(0)
    }

    /// Capture every sheet's filter state (rules AND the rows they hid) as
    /// an undo / persistence before-image. Twin of [`Self::snapshot_hidden`]
    /// down to the sheet-INDEX keying; sheets with no filter are omitted.
    ///
    /// Both halves are captured because they are not redundant: restoring
    /// rules alone would force a re-derivation against whatever the cells
    /// say NOW, which is precisely the liveness snapshot semantics forbids.
    /// An undo has to restore the rows that WERE hidden.
    pub fn snapshot_filters(&self) -> FilterSnapshot {
        FilterSnapshot::from_sheets(
            self.sheets
                .iter()
                .enumerate()
                .filter_map(|(sheet_index, sheet)| {
                    sheet.filter().map(|filter| SheetFilterState {
                        sheet_index,
                        rules: filter.rules().to_vec(),
                        hidden_rows: filter.hidden_rows(),
                    })
                })
                .collect(),
        )
    }

    /// Replace every sheet's filter state with `snapshot`, returning how
    /// many sheets ended up with a filter.
    ///
    /// Whole-workbook REPLACE, exactly like [`Self::restore_hidden`]: a
    /// sheet the snapshot does not mention has its filter CLEARED, not left
    /// alone, which is what makes undoing "filter a previously-unfiltered
    /// sheet" symmetric. Entries past the end of the sheet vector are
    /// dropped silently. Restores nothing reactive where the derived set did
    /// not move.
    ///
    /// Scan-free by construction — it installs a remembered answer rather
    /// than recomputing one.
    pub fn restore_filters(&mut self, snapshot: FilterSnapshot) -> Result<u32, FilterError> {
        if self.is_inside_custom_call() {
            return Err(FilterError::MutationDuringCustomCall);
        }
        let sheet_count = self.sheets.len();
        let mut wanted: Vec<Option<SheetFilterState>> = (0..sheet_count).map(|_| None).collect();
        for entry in snapshot.into_sheets() {
            if entry.sheet_index >= sheet_count {
                continue; // captured against a wider workbook
            }
            let index = entry.sheet_index;
            wanted[index] = Some(entry);
        }
        let mut restored = 0u32;
        for (sheet_index, entry) in wanted.into_iter().enumerate() {
            let (rules, hidden) = match entry {
                Some(entry) => {
                    restored += 1;
                    (entry.rules, entry.hidden_rows.into_iter().collect())
                }
                None => (Vec::new(), BTreeSet::new()),
            };
            if self.sheets[sheet_index].commit_filter(rules, hidden) {
                self.republish_hidden(sheet_index);
            }
        }
        Ok(restored)
    }

    /// Current value of the Table invalidation broadcast counter (design
    /// doc §8 seam). Bumped by every registry mutation. T3 additionally
    /// pushes each bump into the per-sheet `tables_epoch` Store atom so
    /// structured-reference formulas re-derive; T1 exposes the counter so
    /// callers/tests can observe that a mutation broadcast happened.
    pub fn tables_epoch(&self) -> u64 {
        self.tables_epoch
    }

    // --- Structural-follow wrappers (design doc §4.3) --------------------
    //
    // These delegate to the existing per-sheet structural ops (which do the
    // full cell/formula/spill/format/dimension retarget) and then remap
    // every Table anchored to that sheet. The wasm binding still calls
    // `Sheet::insert_row` directly today; rewiring it to route through
    // these wrappers is T6 (§10) — deliberately NOT done here so T1 leaves
    // the wasm export surface untouched.

    /// Insert `count` rows at `at` on `sheet_index`, then follow Tables.
    pub fn insert_rows(&mut self, sheet_index: usize, at: u32, count: u32) {
        self.apply_structural_shift_with_table_follow(
            sheet_index,
            crate::shift::ShiftEdit::RowInsert { at, count },
        );
    }

    /// Delete `count` rows at `at` on `sheet_index`, then follow Tables.
    pub fn delete_rows(&mut self, sheet_index: usize, at: u32, count: u32) {
        self.apply_structural_shift_with_table_follow(
            sheet_index,
            crate::shift::ShiftEdit::RowDelete { at, count },
        );
    }

    /// Insert `count` columns at `at` on `sheet_index`, then follow Tables.
    pub fn insert_columns(&mut self, sheet_index: usize, at: u32, count: u32) {
        self.apply_structural_shift_with_table_follow(
            sheet_index,
            crate::shift::ShiftEdit::ColInsert { at, count },
        );
    }

    /// Delete `count` columns at `at` on `sheet_index`, then follow Tables.
    pub fn delete_columns(&mut self, sheet_index: usize, at: u32, count: u32) {
        self.apply_structural_shift_with_table_follow(
            sheet_index,
            crate::shift::ShiftEdit::ColDelete { at, count },
        );
    }

    fn apply_structural_shift_with_table_follow(
        &mut self,
        sheet_index: usize,
        edit: crate::shift::ShiftEdit,
    ) {
        if self.is_inside_custom_call() {
            return; // re-entrancy guard, mirrors the cell mutators
        }
        if sheet_index >= self.sheets.len() {
            return;
        }
        // Delegate to the existing sheet-level structural op — same path
        // the wasm binding uses today, so cells/formulas/spills/formats
        // all follow exactly as before.
        match edit {
            crate::shift::ShiftEdit::RowInsert { at, count } => {
                self.sheets[sheet_index].insert_row(at, count)
            }
            crate::shift::ShiftEdit::RowDelete { at, count } => {
                self.sheets[sheet_index].delete_row(at, count)
            }
            crate::shift::ShiftEdit::ColInsert { at, count } => {
                self.sheets[sheet_index].insert_col(at, count)
            }
            crate::shift::ShiftEdit::ColDelete { at, count } => {
                self.sheets[sheet_index].delete_col(at, count)
            }
        }
        self.remap_tables_after_shift(sheet_index, edit);
        // Hidden-row eval inputs are row-indexed too, so a row edit must
        // displace the numbers inside each set exactly as it displaced the
        // cells. Column edits displace nothing in a row set. See
        // `WorkbookAtomContext::shift_hidden_rows_after_row_edit` for why this
        // cannot double-shift against the host's own re-push.
        match edit {
            crate::shift::ShiftEdit::RowInsert { at, count } => {
                self.atom_context
                    .shift_hidden_rows_after_row_edit(sheet_index, at, count, true);
                // `Sheet::apply_structural_shift` already displaced the OWNED
                // set through the same `shift_hidden_row` arithmetic, so this
                // republish normally finds the mirror already correct and
                // fires nothing. It is here so the owning side has the last
                // word: the mirror is a projection, never an independent
                // maintainer of the fact.
                self.republish_hidden(sheet_index);
            }
            crate::shift::ShiftEdit::RowDelete { at, count } => {
                self.atom_context
                    .shift_hidden_rows_after_row_edit(sheet_index, at, count, false);
                self.republish_hidden(sheet_index);
            }
            crate::shift::ShiftEdit::ColInsert { .. } | crate::shift::ShiftEdit::ColDelete { .. } => {}
        }
    }

    /// Follow every Table anchored to `sheet_index` through a structural
    /// `edit` (design doc §4.3 matrix). Reuses `ShiftEdit`'s coordinate
    /// math for the shift/grow cases and clamps the delete cases so a
    /// partially-covered Table shrinks (rather than surfacing a `#REF!`
    /// corner as A1 range-formats do). Deletes that swallow the header row
    /// (rows) or every column (cols) drop the Table. Bumps the epoch iff a
    /// Table actually changed.
    ///
    /// `pub(crate)`: the public entry points are the structural wrappers
    /// above. `ShiftEdit` is deliberately not re-exported (T1 leaves the
    /// `shift` surface unchanged), so external callers reach this only
    /// through the wrappers.
    pub(crate) fn remap_tables_after_shift(
        &mut self,
        sheet_index: usize,
        edit: crate::shift::ShiftEdit,
    ) {
        let Some(sheet_name) = self.names.get(sheet_index).cloned() else {
            return;
        };
        let keys: Vec<String> = self
            .tables
            .iter()
            .filter(|(_, t)| t.sheet_name == sheet_name)
            .map(|(k, _)| k.clone())
            .collect();

        let mut changed = false;
        for key in keys {
            let (range, columns) = {
                let entry = self.tables.get(&key).expect("key just collected");
                (entry.range, entry.columns.clone())
            };
            match remap_table_geometry(range, &columns, edit) {
                TableRemap::Keep => {}
                TableRemap::Resize { range, columns } => {
                    let e = self.tables.get_mut(&key).expect("key just collected");
                    e.range = range;
                    e.columns = columns;
                    changed = true;
                }
                TableRemap::Delete => {
                    self.tables.remove(&key);
                    changed = true;
                }
            }
        }
        if changed {
            self.bump_tables_epoch();
        }
    }

    // --- internal helpers ----------------------------------------------

    /// Bump the Table invalidation broadcast counter (design doc §8) and
    /// publish the change reactively. Two effects, in order:
    ///   1. `sync_atom_tables` refreshes the formula-inner provider's Table
    ///      projection so structured references resolve against current
    ///      geometry.
    ///   2. `atom_context.bump_tables_epoch` `store.set(+1)`s the shared
    ///      `tables_epoch` atom, waking exactly the formulas that resolved a
    ///      Table (they hold a `depend_tables` edge) — cross-sheet included,
    ///      since the whole workbook shares one Store.
    fn bump_tables_epoch(&mut self) {
        self.tables_epoch = self.tables_epoch.wrapping_add(1);
        self.sync_atom_tables();
        self.atom_context.bump_tables_epoch();
    }

    /// Full Table name mutex (design doc §4.2). `exclude_key` is the
    /// uppercased key of the Table being renamed (so a case-only rename
    /// doesn't collide with itself); `None` for a fresh `define_table`.
    fn validate_table_name(&self, name: &str, exclude_key: Option<&str>) -> Result<(), TableError> {
        if Self::validate_name(name).is_err() {
            return Err(TableError::InvalidName);
        }
        let key = name.to_ascii_uppercase();
        if is_builtin_function_name(&key) {
            return Err(TableError::ReservedName);
        }
        if name_is_cell_ref_like(name) {
            return Err(TableError::NameLikeCellRef);
        }
        // Shared namespace: reject collisions with other Tables …
        let collides_table = match exclude_key {
            Some(self_key) => key != self_key && self.tables.contains_key(&key),
            None => self.tables.contains_key(&key),
        };
        if collides_table {
            return Err(TableError::NameConflict);
        }
        // … and with defined names (forward direction of §4.2's mutex).
        if self.named_values.contains_key(&key) {
            return Err(TableError::NameConflict);
        }
        Ok(())
    }

    /// First free `Table1`, `Table2`, … not already used by a Table or a
    /// defined name (shared namespace). `TableN` is never cell-ref-like
    /// (column `TABLE` is past `XFD`) nor a built-in, so those checks are
    /// unnecessary here.
    fn next_auto_table_name(&self) -> String {
        let mut n: usize = 1;
        loop {
            let candidate = format!("Table{n}");
            let key = candidate.to_ascii_uppercase();
            if !self.tables.contains_key(&key) && !self.named_values.contains_key(&key) {
                return candidate;
            }
            n += 1;
        }
    }

    /// Read the header row's cell text into column names, disambiguating
    /// blanks/duplicates to `Column1`, `Column2`, … (design doc §4.1). Runs
    /// before the registry mutation so it only needs `&self`.
    fn derive_column_names(&self, sheet_name: &str, range: CellRange) -> Vec<String> {
        let width = range.cols();
        let header_row = range.start.row;
        let mut names: Vec<String> = Vec::with_capacity(width as usize);
        let mut used: HashSet<String> = HashSet::new();
        for i in 0..width {
            let addr = CellAddress::new(header_row, range.start.col + i);
            let raw = self.header_text(sheet_name, addr);
            let trimmed = raw.trim();
            let name = if trimmed.is_empty() || used.contains(&trimmed.to_ascii_uppercase()) {
                next_auto_column_name(&used)
            } else {
                trimmed.to_string()
            };
            used.insert(name.to_ascii_uppercase());
            names.push(name);
        }
        names
    }

    /// Best-effort display text of a header cell, for column naming. Reads
    /// through the normal evaluation path (header cells are usually plain
    /// text/number literals). Non-scalar/error values yield an empty
    /// string so the caller auto-names that column.
    fn header_text(&self, sheet_name: &str, addr: CellAddress) -> String {
        match self.get_cell(sheet_name, &addr.to_string_repr()) {
            Value::Text(s) => s,
            Value::Number(n) => format!("{n}"),
            Value::Boolean(b) => {
                if b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
            _ => String::new(),
        }
    }
}

/// Outcome of following one Table through a structural edit.
enum TableRemap {
    /// The edit didn't touch this Table.
    Keep,
    /// New geometry (and possibly a new column list after an in-table
    /// column insert/delete).
    Resize { range: CellRange, columns: Vec<String> },
    /// The edit destroyed the Table (header row deleted / all columns
    /// deleted). The registry entry is dropped.
    Delete,
}

/// Build the canonical `=SUBTOTAL(code, Table[Col])` text for a totals-row
/// cell (design doc #32 §7). The formula is assembled as an `Expr` and run
/// through the shared `render_formula`, so the emitted text is guaranteed to
/// re-parse (the T2 round-trip invariant) AND the resulting cell carries a
/// real `Expr::TableRef` node — which is exactly what the table/column rename
/// walkers (§4.3) rewrite, so totals formulas follow renames for free.
fn totals_subtotal_formula(table: &str, column: &str, code: u32) -> String {
    let expr = Expr::FuncCall {
        name: "SUBTOTAL".to_string(),
        args: vec![
            Expr::Number(code as f64),
            Expr::TableRef {
                table: Some(table.to_string()),
                area: TableArea::Data,
                columns: Some((column.to_string(), column.to_string())),
            },
        ],
    };
    crate::shift::render_formula(&expr)
}

/// Do two normalized ranges intersect? (Inclusive rectangles.)
fn ranges_overlap(a: CellRange, b: CellRange) -> bool {
    let a = a.normalize();
    let b = b.normalize();
    a.start.row <= b.end.row
        && b.start.row <= a.end.row
        && a.start.col <= b.end.col
        && b.start.col <= a.end.col
}

/// Is `name` an in-grid A1 cell reference (`AB12`)? Grid-bounded so
/// out-of-grid pseudo-refs like `Table1` (column `TABLE` past `XFD`) are
/// NOT treated as cell references. See `GRID_MAX_COL` / `GRID_MAX_ROW`.
fn name_is_cell_ref_like(name: &str) -> bool {
    match CellAddress::parse(name) {
        Some(addr) => addr.col <= GRID_MAX_COL && addr.row <= GRID_MAX_ROW,
        None => false,
    }
}

/// Next `ColumnN` not already present in `used` (uppercased keys), for
/// blank/duplicate header disambiguation and in-table column inserts.
fn next_auto_column_name(used: &HashSet<String>) -> String {
    let mut n: usize = 1;
    loop {
        let candidate = format!("Column{n}");
        if !used.contains(&candidate.to_ascii_uppercase()) {
            return candidate;
        }
        n += 1;
    }
}

/// Shrink the closed interval `[lo, hi]` by the deletion of `[d0, d1]`
/// (all on one axis). Returns `None` when `[lo, hi]` is fully inside the
/// deleted band (nothing survives). Otherwise returns the reindexed
/// `(new_lo, new_hi)`:
///   - band entirely below (`hi < d0`): unchanged;
///   - band entirely above (`lo > d1`): both shift up by the band width;
///   - partial overlap: the surviving cells close the gap.
fn shrink_interval(lo: u32, hi: u32, d0: u32, d1: u32) -> Option<(u32, u32)> {
    if d0 <= lo && hi <= d1 {
        return None;
    }
    let count = d1 - d0 + 1;
    let new_lo = if lo < d0 {
        lo
    } else if lo > d1 {
        lo - count
    } else {
        d0
    };
    let ov_lo = d0.max(lo);
    let ov_hi = d1.min(hi);
    let deleted = if ov_hi >= ov_lo { ov_hi - ov_lo + 1 } else { 0 };
    let len = (hi - lo + 1) - deleted;
    Some((new_lo, new_lo + len - 1))
}

/// Core of the design doc §4.3 follow matrix for a single Table. Pure: it
/// takes the current geometry and returns the outcome, so it's unit-tested
/// directly and reused by `Workbook::remap_tables_after_shift`.
fn remap_table_geometry(
    range: CellRange,
    columns: &[String],
    edit: crate::shift::ShiftEdit,
) -> TableRemap {
    use crate::shift::ShiftEdit;
    let range = range.normalize();
    let (s_r, e_r) = (range.start.row, range.end.row);
    let (s_c, e_c) = (range.start.col, range.end.col);

    match edit {
        ShiftEdit::RowInsert { at, count } => {
            let ns_r = if s_r >= at { s_r + count } else { s_r };
            let ne_r = if e_r >= at { e_r + count } else { e_r };
            if ns_r == s_r && ne_r == e_r {
                return TableRemap::Keep;
            }
            TableRemap::Resize {
                range: CellRange::new(
                    CellAddress::new(ns_r, s_c),
                    CellAddress::new(ne_r, e_c),
                ),
                columns: columns.to_vec(),
            }
        }
        ShiftEdit::ColInsert { at, count } => {
            let ns_c = if s_c >= at { s_c + count } else { s_c };
            let ne_c = if e_c >= at { e_c + count } else { e_c };
            let mut cols = columns.to_vec();
            // Widening (insert strictly inside the column span): splice in
            // `count` auto-named columns at the insertion index.
            if s_c < at && at <= e_c {
                let idx = (at - s_c) as usize;
                let mut used: HashSet<String> =
                    cols.iter().map(|c| c.to_ascii_uppercase()).collect();
                for offset in 0..count as usize {
                    let name = next_auto_column_name(&used);
                    used.insert(name.to_ascii_uppercase());
                    cols.insert(idx + offset, name);
                }
            }
            if ns_c == s_c && ne_c == e_c && cols.len() == columns.len() {
                return TableRemap::Keep;
            }
            TableRemap::Resize {
                range: CellRange::new(
                    CellAddress::new(s_r, ns_c),
                    CellAddress::new(e_r, ne_c),
                ),
                columns: cols,
            }
        }
        ShiftEdit::RowDelete { at, count } => {
            let d0 = at;
            let d1 = at + count - 1;
            // Header row (row 0 of the range) swallowed → drop the Table.
            if d0 <= s_r && s_r <= d1 {
                return TableRemap::Delete;
            }
            match shrink_interval(s_r, e_r, d0, d1) {
                None => TableRemap::Delete, // unreachable (header survives)
                Some((ns_r, ne_r)) => {
                    if ns_r == s_r && ne_r == e_r {
                        return TableRemap::Keep;
                    }
                    TableRemap::Resize {
                        range: CellRange::new(
                            CellAddress::new(ns_r, s_c),
                            CellAddress::new(ne_r, e_c),
                        ),
                        columns: columns.to_vec(),
                    }
                }
            }
        }
        ShiftEdit::ColDelete { at, count } => {
            let d0 = at;
            let d1 = at + count - 1;
            match shrink_interval(s_c, e_c, d0, d1) {
                None => TableRemap::Delete, // every column deleted
                Some((ns_c, ne_c)) => {
                    // Drop the column names covered by the deleted band.
                    let mut cols = columns.to_vec();
                    let ov_lo = d0.max(s_c);
                    let ov_hi = d1.min(e_c);
                    if ov_hi >= ov_lo {
                        let del_start = (ov_lo - s_c) as usize;
                        let del_end = (ov_hi - s_c) as usize;
                        cols.drain(del_start..=del_end);
                    }
                    if ns_c == s_c && ne_c == e_c && cols.len() == columns.len() {
                        return TableRemap::Keep;
                    }
                    TableRemap::Resize {
                        range: CellRange::new(
                            CellAddress::new(s_r, ns_c),
                            CellAddress::new(e_r, ne_c),
                        ),
                        columns: cols,
                    }
                }
            }
        }
    }
}

/// Buffered op recorded by `WorkbookLoader`. Replayed at `flush` time
/// inside `Sheet::bulk_load`. The owning sheet is the HashMap key in
/// `ops_by_sheet`, so individual variants don't repeat `sheet_idx`.
enum WorkbookOp {
    /// Typed address (A-9 follow-up, 2026-06-13 P3): producers parse or
    /// construct the `CellAddress` exactly once at the public boundary;
    /// replay routes `BulkLoader::set_cell_at`. Carrying a `String`
    /// here meant one alloc + one re-parse per op in bulk paths whose
    /// producers already hold a typed address (`restore_sparse`).
    SetCell { addr: CellAddress, value: Value },
    /// `expr` is `Some` when the workbook-side parse succeeded — the
    /// sheet-side flush installs directly without re-parsing. `None`
    /// covers the parse-failure path: the sheet's `set_formula` sees a
    /// malformed string, writes `#VALUE!`, and never touches the AST.
    /// Eliminating the double-parse was the dominant constant-factor
    /// win for the wasm32 Chain100k bulkWrite tier — `parse_formula`
    /// allocates a `Vec<char>` per source character plus boxed nodes
    /// for every binop / cellref, and was running twice per formula
    /// (workbook + sheet) before this variant. The address is typed
    /// for the same reason as `SetCell`.
    SetFormula {
        addr: CellAddress,
        source: String,
        expr: Option<Expr>,
    },
    /// Typed address — no `String` round-trip (AUDIT A-9). The clear
    /// path's producers (`Workbook::clear_range`'s sparse scan, the
    /// public `clear_cell` after its own parse) always hold a
    /// `CellAddress` already, and the sheet-side replay has a typed
    /// entry (`BulkLoader::set_cell_at`), so carrying a string here
    /// meant one alloc + two parses per cleared cell in a bulk path.
    ClearCell { addr: CellAddress },
}

/// In-progress workbook bulk-load session. Buffers operations until
/// `flush` runs at the end of `Workbook::bulk_load`. Inside the closure
/// callers see synchronous returns from `set_formula` (parse / cycle
/// outcome decided here at queue time). Store propagation is consolidated by
/// each sheet's batch replay.
pub struct WorkbookLoader<'a> {
    wb: &'a mut Workbook,
    /// Per-sheet ordered op queues so the replay inside each sheet's
    /// `Sheet::bulk_load` preserves the caller's order.
    ops_by_sheet: HashMap<usize, Vec<WorkbookOp>>,
}

impl<'a> WorkbookLoader<'a> {
    fn new(wb: &'a mut Workbook) -> Self {
        WorkbookLoader {
            wb,
            ops_by_sheet: HashMap::new(),
        }
    }

    /// Queue a primitive write at `(sheet_idx, addr)`. Parses the address once
    /// here; the buffered op carries it typed.
    pub fn set_cell(&mut self, sheet_idx: usize, addr_str: &str, value: Value) {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.set_cell_at(sheet_idx, addr, value);
    }

    /// Typed-address twin of `set_cell` (A-9 follow-up). Bulk producers
    /// that already hold a `CellAddress` — the wasm `restore_sparse` /
    /// `bulk_import_cells` decoders — skip the `to_string_repr` →
    /// re-parse round trip entirely.
    pub fn set_cell_at(&mut self, sheet_idx: usize, addr: CellAddress, value: Value) {
        if self.wb.is_inside_custom_call() {
            return; // re-entrancy guard (Wave 8)
        }
        if sheet_idx >= self.wb.sheets.len() {
            return;
        }
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::SetCell { addr, value });
    }

    /// Queue a formula write at `(sheet_idx, addr)`. Returns `false` if
    /// either the text fails to parse or the workbook static cycle check
    /// rejects it. Pending formulas in the same batch are additionally covered
    /// by the Store's runtime in-flight cycle guard.
    pub fn set_formula(&mut self, sheet_idx: usize, addr_str: &str, source: &str) -> bool {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return false;
        };
        self.set_formula_at(sheet_idx, addr, source)
    }

    /// Typed-address twin of `set_formula` (A-9 follow-up) — same
    /// contract, same queue path, no address re-parse.
    pub fn set_formula_at(&mut self, sheet_idx: usize, addr: CellAddress, source: &str) -> bool {
        if self.wb.is_inside_custom_call() {
            return false; // re-entrancy guard (Wave 8)
        }
        if sheet_idx >= self.wb.sheets.len() {
            return false;
        }

        // Parse failure still records a SetFormula op so the sheet flush writes
        // `#VALUE!` through the normal formula API.
        let Some(expr) = parse_formula(source) else {
            self.ops_by_sheet
                .entry(sheet_idx)
                .or_default()
                .push(WorkbookOp::SetFormula {
                    addr,
                    source: source.to_string(),
                    expr: None,
                });
            return false;
        };

        if self.wb.closes_workbook_cycle(sheet_idx, addr, &expr) {
            self.ops_by_sheet
                .entry(sheet_idx)
                .or_default()
                .push(WorkbookOp::SetCell {
                    addr,
                    value: Value::Error(ValueError::CyclicRef),
                });
            return false;
        }
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::SetFormula {
                addr,
                source: source.to_string(),
                expr: Some(expr),
            });

        true
    }

    /// Queue a clear (=write to Null) at `(sheet_idx, addr)`.
    pub fn clear_cell(&mut self, sheet_idx: usize, addr_str: &str) {
        let Some(addr) = CellAddress::parse(addr_str) else {
            return;
        };
        self.clear_cell_at(sheet_idx, addr);
    }

    /// Typed-address twin of `clear_cell` (AUDIT A-9). Bulk callers that
    /// already hold a `CellAddress` — `Workbook::clear_range`'s sparse
    /// scan — skip the `to_string` → re-parse round trip entirely.
    pub fn clear_cell_at(&mut self, sheet_idx: usize, addr: CellAddress) {
        if self.wb.is_inside_custom_call() {
            return; // re-entrancy guard (Wave 8)
        }
        if sheet_idx >= self.wb.sheets.len() {
            return;
        }
        self.ops_by_sheet
            .entry(sheet_idx)
            .or_default()
            .push(WorkbookOp::ClearCell { addr });
    }

    /// Replay queued ops sheet-by-sheet inside each sheet's Store batch.
    fn flush(self) {
        let WorkbookLoader { wb, ops_by_sheet } = self;

        for (sheet_idx, ops) in ops_by_sheet {
            let Some(sheet) = wb.sheets.get_mut(sheet_idx) else {
                continue;
            };
            // Pre-grow the per-sheet formula HashMaps to the known
            // batch size. Saves ~log2(N) rehashes during the replay
            // loop below (each rehash is O(current entries), so they
            // amortize to ~2× the final size in wasted copies on a
            // cold start).
            sheet.reserve_for_bulk_install(ops.len());
            sheet.bulk_load(|loader| {
                for op in ops {
                    match op {
                        WorkbookOp::SetCell { addr, value } => {
                            loader.set_cell_at(addr, value);
                        }
                        WorkbookOp::SetFormula { addr, source, expr } => {
                            // Hand the pre-parsed AST through when we
                            // have one — skips the sheet-loader's
                            // re-parse (the same AST was just produced
                            // by the workbook-side cycle check).
                            //
                            // `expr=None` is the parse-failure path:
                            // the source was unparseable on the
                            // workbook side too, so route through the
                            // string form and let the sheet writer
                            // produce `#VALUE!` via its own parse-fail
                            // arm (consistency: same `#VALUE!` error
                            // payload either way).
                            //
                            // Cross-sheet cycle was already handled by
                            // the `set_formula` queue path inserting a
                            // follow-up `SetCell` to override with
                            // `Value::Error(CyclicRef)`.
                            match expr {
                                Some(expr) => {
                                    // Move `source` so the sheet loader
                                    // stores the original allocation
                                    // instead of cloning.
                                    loader.set_formula_pre_parsed(addr, expr, source);
                                }
                                None => {
                                    loader.set_formula_at(addr, &source);
                                }
                            }
                        }
                        WorkbookOp::ClearCell { addr } => {
                            loader.set_cell_at(addr, Value::Null);
                        }
                    }
                }
            });
        }
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

struct WorkbookEvalProvider<'a> {
    wb: &'a Workbook,
    current: Cell<usize>,
    /// Cell currently being evaluated. Mirrors `SheetEvalProvider`; evaluator
    /// save/restore calls keep no-arg `ROW()` / `COLUMN()` anchored to the
    /// current expression when this compatibility provider is used.
    current_cell: Cell<Option<CellAddress>>,
}

impl<'a> WorkbookEvalProvider<'a> {
    fn with_current<T>(&self, idx: usize, f: impl FnOnce() -> T) -> T {
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
        crate::sheet::collapse_array_for_eval(
            self.wb.sheets[idx].peek_value_with_provider(addr, self),
        )
    }

    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return Value::Error(ValueError::InvalidRef);
        };
        self.with_current(idx, || {
            crate::sheet::collapse_array_for_eval(
                self.wb.sheets[idx].peek_value_with_provider(addr, self),
            )
        })
    }

    fn raw_cell(&self, addr: CellAddress) -> Value {
        let idx = self.current.get();
        self.wb.sheets[idx].peek_value_with_provider(addr, self)
    }

    fn raw_sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return Value::Error(ValueError::InvalidRef);
        };
        self.with_current(idx, || {
            self.wb.sheets[idx].peek_value_with_provider(addr, self)
        })
    }

    /// Sparse override for the workbook context. Routes the formula-cell
    /// read through `peek_value_with_provider` so cross-sheet references
    /// inside formulas in the iterated range can still resolve through
    /// the workbook chain (the single-sheet `peek_value` would return
    /// `#REF!` for `Sheet2!A1`).
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value)) {
        let idx = self.current.get();
        let sheet = &self.wb.sheets[idx];
        sheet.for_each_sparse_cell_with(
            range,
            &|sheet, addr| {
                crate::sheet::collapse_array_for_eval(sheet.peek_value_with_provider(addr, self))
            },
            f,
        );
    }

    fn for_each_sheet_range_cell(
        &self,
        sheet: &str,
        range: CellRange,
        f: &mut dyn FnMut(CellAddress, Value),
    ) {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            f(
                range.normalize().start,
                Value::Error(ValueError::InvalidRef),
            );
            return;
        };
        self.with_current(idx, || {
            let target_sheet = &self.wb.sheets[idx];
            target_sheet.for_each_sparse_cell_with(
                range,
                &|sheet, addr| {
                    crate::sheet::collapse_array_for_eval(
                        sheet.peek_value_with_provider(addr, self),
                    )
                },
                f,
            );
        });
    }

    fn current_cell(&self) -> Option<CellAddress> {
        self.current_cell.get()
    }

    fn set_current_cell(&self, addr: Option<CellAddress>) {
        self.current_cell.set(addr);
    }

    fn col_width(&self, col: u32) -> Option<u32> {
        // The currently-evaluating sheet's explicit width for `col`, if any —
        // consumed by `CELL("width")` on the eager workbook eval path
        // (`get_cell`, `define_name`). Cross-sheet `CELL("width", Other!A1)`
        // collapses to this sheet, matching the content-touching info_types.
        self.wb.sheets[self.current.get()].col_width(col)
    }

    fn lookup_named(&self, name: &str) -> Option<Value> {
        // Delegate to the workbook's case-insensitive registry. Returns
        // a clone of the stored value (cheap for `Value::Lambda`, which
        // wraps an `Arc<dyn LambdaValue>`; constant-time for scalars).
        self.wb.get_named(name)
    }

    fn lookup_table(&self, name: Option<&str>) -> Option<ResolvedTable> {
        // Eager workbook provider (get_cell of a non-formula cell,
        // define_name evaluation): read the registry directly (design doc
        // #32 §5.3). The live formula-inner path goes through
        // `AtomFormulaProvider::lookup_table` instead.
        match name {
            Some(n) => {
                let entry = self.wb.tables.get(&n.to_ascii_uppercase())?;
                let sheet_index = self.wb.by_name.get(&entry.sheet_name).copied()?;
                Some(entry.to_resolved(sheet_index))
            }
            None => {
                let addr = self.current_cell.get()?;
                let sheet_index = self.current.get();
                let sheet_name = self.wb.names.get(sheet_index)?;
                self.wb
                    .tables
                    .values()
                    .find(|t| &t.sheet_name == sheet_name && t.range.contains(addr))
                    .map(|t| t.to_resolved(sheet_index))
            }
        }
    }

    fn cell_has_formula(&self, addr: CellAddress) -> bool {
        let idx = self.current.get();
        self.wb
            .sheets
            .get(idx)
            .map(|s| s.has_formula_at(addr))
            .unwrap_or(false)
    }

    fn sheet_cell_has_formula(&self, sheet: &str, addr: CellAddress) -> bool {
        let Some(idx) = self.wb.by_name.get(sheet).copied() else {
            return false;
        };
        self.wb
            .sheets
            .get(idx)
            .map(|s| s.has_formula_at(addr))
            .unwrap_or(false)
    }

    /// FORMULATEXT hook for the workbook context. Looks up the source
    /// formula in the *current* sheet's text store. Returns `None` when
    /// the cell holds a primitive — the FORMULATEXT arm then surfaces
    /// `#N/A`.
    fn cell_formula_text(&self, addr: CellAddress) -> Option<String> {
        let idx = self.current.get();
        let sheet = self.wb.sheets.get(idx)?;
        sheet.formula_text_at(addr)
    }

    /// Cross-sheet variant: resolve the sheet by name first.
    fn sheet_cell_formula_text(&self, sheet: &str, addr: CellAddress) -> Option<String> {
        let idx = self.wb.by_name.get(sheet).copied()?;
        let target = self.wb.sheets.get(idx)?;
        target.formula_text_at(addr)
    }

    fn current_sheet_index(&self) -> Option<usize> {
        Some(self.current.get())
    }

    fn sheet_index_of(&self, name: &str) -> Option<usize> {
        self.wb.by_name.get(name).copied()
    }

    fn hidden_rows(&self, sheet_index: Option<usize>) -> Option<Rc<HashSet<u32>>> {
        // Eager provider (define_name / non-formula get_cell eval): read the
        // host-pushed hidden set untracked (this path holds no reactive edge,
        // design doc #32 §6.2). The live formula-inner path is
        // `AtomFormulaProvider::hidden_rows`.
        self.wb.atom_context.hidden_rows_untracked(sheet_index?)
    }

    fn filter_hidden_rows(&self, sheet_index: Option<usize>) -> Option<Rc<HashSet<u32>>> {
        // Untracked twin of `hidden_rows` against the filter side store
        // (`design-filter-hidden-rows` §6.2).
        self.wb
            .atom_context
            .filter_hidden_rows_untracked(sheet_index?)
    }

    fn sheet_count(&self) -> usize {
        self.wb.sheets.len()
    }

    /// Wave 8 host custom-formula dispatch. Consult the workbook's
    /// registry handle if one was installed via
    /// `Workbook::set_custom_function_registry`; otherwise the
    /// `EvalProvider` default `None` keeps the legacy `#NAME?`
    /// fallthrough.
    ///
    /// Brackets the JS callback in a `CustomCallScope` so the workbook's
    /// re-entrancy depth counter ticks for the duration. Any mutation
    /// the callback attempts via `wb.set_cell(...)` / `wb.set_formula
    /// (...)` / etc. is rejected via the per-entry-point
    /// `is_inside_custom_call` guard. The scope's `Drop` impl is
    /// exception-safe (matches the wasm-bindgen `throw_str` path).
    fn call_custom(&self, name: &str, args: &[Value]) -> Option<Value> {
        let registry = self.wb.custom_functions.as_ref()?;
        if registry.is_async(name) {
            // Eager, non-reactive path (define_name evaluation): there is
            // no ReadArgs to hang a pending-result dependency on, so an
            // async call can never settle into this frame. Surface #BUSY!
            // directly; async names in defined-name formulas are
            // unsupported (see CUSTOM_FORMULAS.md).
            return Some(Value::Error(ValueError::Busy));
        }
        let _scope = CustomCallScope::enter(self.wb.custom_call_depth_cell());
        registry.lookup(name, args)
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

    /// `WorkbookEvalProvider::current_cell()` round-trips whatever
    /// `set_current_cell` was last called with. The `Sheet` eval loop drives
    /// this via a save/restore guard around each formula's eval call so
    /// `ROW()` / `COLUMN()` can read the formula's own address.
    #[test]
    fn workbook_provider_current_cell_round_trip() {
        let wb = Workbook::new();
        let provider = WorkbookEvalProvider {
            wb: &wb,
            current: Cell::new(0),
            current_cell: Cell::new(None),
        };
        assert_eq!(provider.current_cell(), None);
        let addr = CellAddress::new(2, 1); // B3 in 0-indexed (row=2, col=1)
        provider.set_current_cell(Some(addr));
        assert_eq!(provider.current_cell(), Some(addr));
        provider.set_current_cell(None);
        assert_eq!(provider.current_cell(), None);
    }

    #[test]
    fn add_named_sheet() {
        let mut wb = Workbook::new();
        let idx = wb.add_sheet("Data");
        assert_eq!(idx, 1);
        assert_eq!(wb.index_of("Data"), Some(1));
    }

    #[test]
    fn sparse_range_read_uses_workbook_provider_for_formulas() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        wb.set_cell(data_idx, "A1", Value::Number(41.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1+1"));

        let mut got = Vec::new();
        wb.for_each_sparse_range_cell(
            0,
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(0, 2)),
            |addr, value| got.push((addr.to_string(), value)),
        );

        assert_eq!(got, vec![("B1".to_string(), Value::Number(42.0))]);
    }

    #[test]
    fn clear_range_scans_sparse_and_rederives_cross_sheet_dependents() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        wb.set_cell(data_idx, "A1", Value::Number(41.0));
        wb.set_cell(data_idx, "C3", Value::Number(99.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1+1"));

        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(42.0));
        assert_eq!(wb.debug_formula_cache_state(0, "B1"), "clean");
        let before = wb.debug_formula_eval_count(0);

        let cleared = wb.clear_range(
            data_idx,
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(1, 1)),
        );

        assert_eq!(cleared, 1);
        assert_eq!(wb.debug_formula_cache_state(0, "B1"), "clean");
        assert_eq!(wb.debug_formula_eval_count(0), before + 1);
        assert_eq!(wb.sheet(data_idx).unwrap().non_empty_addrs(), vec!["C3"]);
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));
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
        // Sheet1!B1 = =Data!A1 * 2. Both sheets share one workbook Store,
        // so the formula-inner atom reads Data!A1 through its target facade.
        assert!(wb.set_formula(0, "B1", "=Data!A1*2"));

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
    fn workbook_get_cell_materializes_only_target_atom_chain() {
        // Build a sheet with two independent cross-sheet formula chains:
        //   B1 = =Data!A1 * 2   (chain A — what we'll read)
        //   D1 = =Data!A1 + 1   (chain B — must NOT be touched by reading B1)
        //   E1 = =Data!A1 + 5   (chain B continued)
        // Reading B1 should materialize only its Store dependency chain.
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

        assert_eq!(
            after - before,
            3,
            "reading B1 should materialize formula-inner, facade, and source facade atoms"
        );
        assert_eq!(wb.debug_formula_eval_count(0), 1);
        assert_eq!(wb.debug_formula_cache_state(0, "B1"), "clean");
        assert_eq!(wb.debug_formula_cache_state(0, "D1"), "dirty");
        assert_eq!(wb.debug_formula_cache_state(0, "E1"), "dirty");
    }

    #[test]
    fn workbook_get_cell_walks_local_dep_chain_to_cross_sheet() {
        // C1 = =B1 + 100  (no SheetRef directly)
        // B1 = =Data!A1 * 2  (cross-sheet)
        // Reading C1 materializes its local B1 dependency, whose formula-inner
        // atom then reads Data!A1 from the same workbook Store.
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(3.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
        assert!(wb.set_formula(0, "C1", "=B1+100"));

        // Initial read: B1 should resolve to 6, C1 to 106.
        assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(106.0));

        // Mutating Data!A1 synchronously rederives the materialized chain.
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(4.0));
        assert_eq!(wb.get_cell("Sheet1", "C1"), Value::Number(108.0));
    }

    #[test]
    fn workbook_get_cell_no_cross_sheet_chain_uses_store_recompute_path() {
        // Reading a same-sheet-only formula through the workbook should stay
        // on the atomm facade/formula-inner path. The first read therefore
        // records Store recomputes (facade/inner/source facade) without a
        // workbook-provider override.
        let mut wb = Workbook::new();
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(7.0));
        wb.sheet_mut(0).unwrap().set_formula("B1", "=A1*2");

        let before = wb.sheet(0).unwrap().debug_recompute_count();
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
        let after = wb.sheet(0).unwrap().debug_recompute_count();
        assert_eq!(
            after - before,
            3,
            "same-sheet workbook read must stay on the atomm Store path"
        );
    }

    #[test]
    fn same_sheet_formula_unaffected_by_workbook_get() {
        // Same-sheet formulas use the same facade/formula-inner Store path.
        let mut wb = Workbook::new();
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(3.0));
        wb.sheet_mut(0).unwrap().set_formula("B1", "=A1*4");
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
    }

    /// Steady-state reads through `wb.get_cell` reuse fresh derived atoms.
    /// With no upstream mutation, the second read of A100 evaluates no formulas.
    #[test]
    fn chain_read_uses_cache_when_unchanged() {
        let mut wb = Workbook::new();
        // Build A1=1, A2=A1+1, ..., A100=A99+1 on Sheet1 (single sheet).
        wb.sheet_mut(0).unwrap().set_cell("A1", Value::Number(1.0));
        for i in 2..=100 {
            let addr = format!("A{i}");
            let src = format!("=A{}+1", i - 1);
            assert!(
                wb.set_formula(0, &addr, &src),
                "set_formula failed for {addr}={src}"
            );
        }
        // First read forces full chain eval.
        let v1 = wb.get_cell("Sheet1", "A100");
        let count1 = wb.debug_formula_eval_count(0);
        // Second read with no mutation MUST hit cache on every formula.
        let v2 = wb.get_cell("Sheet1", "A100");
        let count2 = wb.debug_formula_eval_count(0);
        assert_eq!(v1, v2);
        assert_eq!(v2, Value::Number(100.0), "A100 should be A1 + 99 = 100");
        assert_eq!(
            count2, count1,
            "steadyState read must not re-eval (cache miss bug); first={count1} second={count2}"
        );
    }

    /// Formulas installed through `sheet_mut` still use the workbook Store
    /// context, so cross-sheet dependencies are captured by normal atom reads.
    #[test]
    fn raw_path_cross_sheet_formula_uses_shared_store() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.sheet_mut(0).unwrap().set_formula("B1", "=Data!A1*2"));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(7.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
    }

    /// Removing and recreating a referenced sheet updates the workbook
    /// topology root, forcing dependent formula atoms to resolve the name again.
    #[test]
    fn remove_sheet_then_recompute_stays_correct() {
        let mut wb = Workbook::new();
        // Sheet1 hosts B1 = =Data!A1*2; Data is a second sheet.
        wb.add_sheet("Data"); // idx 1
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(0, "B1", "=Data!A1*2"));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));

        wb.remove_sheet(1);

        // A new Data sheet with the same name is resolved through the updated
        // topology version rather than any retained sheet index.
        wb.add_sheet("Data");
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(3.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));

        // Mutate the new source. Must propagate.
        wb.sheet_by_name_mut("Data")
            .unwrap()
            .set_cell("A1", Value::Number(11.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(22.0));
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

    #[test]
    fn move_sheet_updates_order_and_name_lookup() {
        let mut wb = Workbook::new();
        wb.add_sheet("B");
        wb.add_sheet("C");

        assert!(wb.move_sheet(2, 0));

        assert_eq!(wb.sheet_count(), 3);
        assert_eq!(wb.name(0), Some("C"));
        assert_eq!(wb.name(1), Some("Sheet1"));
        assert_eq!(wb.name(2), Some("B"));
        assert_eq!(wb.index_of("C"), Some(0));
        assert_eq!(wb.index_of("Sheet1"), Some(1));
        assert_eq!(wb.index_of("B"), Some(2));
        assert!(!wb.move_sheet(3, 0));
        assert!(!wb.move_sheet(0, 3));
    }

    #[test]
    fn move_sheet_preserves_cross_sheet_chain_store_propagation() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");

        wb.set_cell(0, "B4", Value::Number(10.0));
        assert!(wb.set_formula(2, "C2", "=Sheet1!B4+1"));
        assert!(wb.set_formula(1, "C2", "=Sheet3!C2+1"));
        assert!(wb.set_formula(0, "C2", "=Sheet2!C2+1"));

        assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(13.0));
        assert!(wb.move_sheet(2, 0));

        assert_eq!(wb.name(0), Some("Sheet3"));
        assert_eq!(wb.name(1), Some("Sheet1"));
        assert_eq!(wb.name(2), Some("Sheet2"));
        assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(13.0));

        let sheet1 = wb.index_of("Sheet1").unwrap();
        let sheet2 = wb.index_of("Sheet2").unwrap();
        let sheet3 = wb.index_of("Sheet3").unwrap();
        assert_eq!(sheet1, 1);
        assert_eq!(sheet2, 2);
        assert_eq!(sheet3, 0);

        assert_eq!(wb.debug_formula_cache_state(sheet1, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(sheet2, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(sheet3, "C2"), "clean");
        let sheet1_evals = wb.debug_formula_eval_count(sheet1);
        let sheet2_evals = wb.debug_formula_eval_count(sheet2);
        let sheet3_evals = wb.debug_formula_eval_count(sheet3);

        wb.set_cell(sheet1, "B4", Value::Number(20.0));

        assert_eq!(wb.debug_formula_cache_state(sheet3, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(sheet2, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(sheet1, "C2"), "clean");
        assert_eq!(wb.debug_formula_eval_count(sheet1), sheet1_evals + 1);
        assert_eq!(wb.debug_formula_eval_count(sheet2), sheet2_evals + 1);
        assert_eq!(wb.debug_formula_eval_count(sheet3), sheet3_evals + 1);
        assert_eq!(wb.get_cell("Sheet1", "C2"), Value::Number(23.0));
    }

    #[test]
    fn move_sheet_retargets_cross_sheet_range_store_path() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        wb.set_cell(1, "A1", Value::Number(1.0));
        wb.set_cell(1, "A2", Value::Number(2.0));
        assert!(wb.set_formula(0, "B1", "=SUM(Data!A1:A2)"));

        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(3.0));
        assert!(wb.move_sheet(1, 0));

        let data = wb.index_of("Data").unwrap();
        let sheet1 = wb.index_of("Sheet1").unwrap();
        let before = wb.debug_formula_eval_count(sheet1);
        wb.set_cell(data, "A1", Value::Number(10.0));

        assert_eq!(wb.debug_formula_cache_state(sheet1, "B1"), "clean");
        assert_eq!(wb.debug_formula_eval_count(sheet1), before + 1);
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(12.0));
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
    fn workbook_debug_formula_eval_count_stays_zero_until_read() {
        let mut wb = Workbook::new();
        let data = wb.add_sheet("Data");
        wb.set_cell(data, "A1", Value::Number(41.0));
        assert!(wb.set_formula(0, "A1", "=Data!A1+1"));

        assert_eq!(wb.debug_formula_eval_count(0), 0);
        assert_eq!(wb.debug_formula_cache_state(0, "A1"), "dirty");

        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(42.0));
        assert_eq!(wb.debug_formula_eval_count(0), 1);
        assert_eq!(wb.debug_formula_cache_state(0, "A1"), "clean");
    }

    #[test]
    fn cross_sheet_runtime_guard_returns_cycle_when_static_bypassed() {
        // Build a cycle by going through Sheet::set_formula directly, which
        // does NOT have workbook-level cycle detection. Then read through
        // Workbook::get_cell. The workbook-scoped in-flight guard shared by
        // formula-inner atom reads must terminate recursive re-entry.
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

    // === Workbook-scoped Store propagation acceptance ===

    /// A workbook-routed source write publishes a changed materialized
    /// cross-sheet formula through the shared Store dependency graph.
    #[test]
    fn cross_sheet_write_fires_dependent_subscriber() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        // Subscribe AFTER the formula is installed so we measure only
        // fanout from the upcoming write.
        let changes = Rc::new(RefCell::new(0u32));
        let changes_clone = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *changes_clone.borrow_mut() += 1;
        });

        wb.set_cell(data_idx, "A1", Value::Number(7.0));

        assert!(
            *changes.borrow() >= 1,
            "subscriber on Sheet1!B1 must fire when Data!A1 is written via wb.set_cell; got {}",
            *changes.borrow()
        );
        assert_eq!(
            wb.get_cell("Sheet1", "B1"),
            Value::Number(14.0),
            "formula must observe the new cross-sheet value on subsequent read"
        );
    }

    /// `sheet_mut` writes participate in cross-sheet propagation because every
    /// attached sheet shares the workbook-scoped Store context.
    #[test]
    fn raw_sheet_write_uses_shared_store_cross_sheet_subscriber() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        let changes = Rc::new(RefCell::new(0u32));
        let changes_clone = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *changes_clone.borrow_mut() += 1;
        });

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(7.0));

        assert_eq!(
            *changes.borrow(),
            1,
            "shared Store propagation should publish the changed formula once"
        );
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(14.0));
    }

    /// Chained cross-sheet propagation: `Sheet1!D = =Sheet2!C`,
    /// `Sheet2!C = =Sheet3!A`. A write to `Sheet3!A` must rederive both
    /// materialized downstream formula atoms.
    #[test]
    fn cross_sheet_chain_fires_transitive_subscribers() {
        let mut wb = Workbook::new();
        let s2 = wb.add_sheet("Sheet2");
        let s3 = wb.add_sheet("Sheet3");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(s3).unwrap().set_cell("A1", Value::Number(1.0));
        assert!(wb.set_formula(s2, "C1", "=Sheet3!A1"));
        assert!(wb.set_formula(s1, "D1", "=Sheet2!C1"));

        let s1_changes = Rc::new(RefCell::new(0u32));
        let s2_changes = Rc::new(RefCell::new(0u32));
        {
            let s1c = s1_changes.clone();
            wb.sheet_mut(s1).unwrap().subscribe_cell("D1", move || {
                *s1c.borrow_mut() += 1;
            });
            let s2c = s2_changes.clone();
            wb.sheet_mut(s2).unwrap().subscribe_cell("C1", move || {
                *s2c.borrow_mut() += 1;
            });
        }

        wb.set_cell(s3, "A1", Value::Number(99.0));

        assert!(
            *s2_changes.borrow() >= 1,
            "transitive subscriber on Sheet2!C1 must fire when Sheet3!A1 is written"
        );
        assert!(
            *s1_changes.borrow() >= 1,
            "transitive subscriber on Sheet1!D1 must fire through Sheet2!C1"
        );
        assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(99.0));
    }

    /// Clearing a cross-sheet source publishes the same Store update as writing
    /// `Value::Null`, so materialized downstream formulas rederive.
    #[test]
    fn cross_sheet_clear_fires_dependent_subscriber() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(5.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *cc.borrow_mut() += 1;
        });

        wb.clear_cell(data_idx, "A1");
        assert!(*changes.borrow() >= 1);
    }

    /// Replacing a formula updates its dynamic Store dependencies, so writes to
    /// the old source no longer publish the formula while the new source does.
    #[test]
    fn cross_sheet_formula_replacement_drops_stale_store_dependency() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let extra_idx = wb.add_sheet("Extra");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(1.0));
        wb.sheet_mut(extra_idx)
            .unwrap()
            .set_cell("A1", Value::Number(100.0));
        assert!(wb.set_formula(s1, "B1", "=Data!A1*2"));

        // Replace with a formula that references Extra instead.
        assert!(wb.set_formula(s1, "B1", "=Extra!A1*2"));

        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *cc.borrow_mut() += 1;
        });
        // Writing the OLD source must NOT fire the subscriber.
        wb.set_cell(data_idx, "A1", Value::Number(7.0));
        assert_eq!(
            *changes.borrow(),
            0,
            "the old source must no longer be a Store dependency"
        );
        // Writing the NEW source must fire it.
        wb.set_cell(extra_idx, "A1", Value::Number(8.0));
        assert!(*changes.borrow() >= 1);
    }

    #[test]
    fn cross_sheet_range_formula_replacement_drops_stale_store_dependency() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(1.0));
        assert!(wb.set_formula(s1, "D1", "=SUM(Data!A1:A10)"));
        assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(1.0));

        assert!(wb.set_formula(s1, "D1", "=1"));
        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("D1", move || {
            *cc.borrow_mut() += 1;
        });

        wb.set_cell(data_idx, "A5", Value::Number(10.0));
        assert_eq!(
            *changes.borrow(),
            0,
            "the replaced range must no longer be a Store dependency"
        );
        assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(1.0));
    }

    #[test]
    fn cross_sheet_range_write_fires_same_addr_dependents_on_multiple_sheets() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let other_idx = wb.add_sheet("Other");
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(wb.set_formula(s1, "D1", "=SUM(Data!A1:A10)"));
        assert!(wb.set_formula(other_idx, "D1", "=SUM(Data!A1:A10)"));

        let s1_changes = Rc::new(RefCell::new(0u32));
        let other_changes = Rc::new(RefCell::new(0u32));
        {
            let c = s1_changes.clone();
            wb.sheet_mut(s1)
                .unwrap()
                .subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }
        {
            let c = other_changes.clone();
            wb.sheet_mut(other_idx)
                .unwrap()
                .subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }

        wb.set_cell(data_idx, "A5", Value::Number(10.0));

        assert!(*s1_changes.borrow() >= 1, "Sheet1!D1 must fire for Data!A5");
        assert!(
            *other_changes.borrow() >= 1,
            "Other!D1 must also fire for Data!A5 despite sharing the same address"
        );
    }

    #[test]
    fn cross_sheet_range_replacement_preserves_other_sheet_same_addr_edge() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let other_idx = wb.add_sheet("Other");
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(wb.set_formula(s1, "D1", "=SUM(Data!A1:A10)"));
        assert!(wb.set_formula(other_idx, "D1", "=SUM(Data!A1:A10)"));
        assert!(wb.set_formula(s1, "D1", "=1"));

        let other_changes = Rc::new(RefCell::new(0u32));
        {
            let c = other_changes.clone();
            wb.sheet_mut(other_idx)
                .unwrap()
                .subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }

        wb.set_cell(data_idx, "A5", Value::Number(10.0));

        assert!(
            *other_changes.borrow() >= 1,
            "removing Sheet1!D1 must not remove Other!D1's same-address range edge"
        );
    }

    #[test]
    fn cross_sheet_range_cycle_is_rejected_when_source_range_contains_target_reader() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();

        assert!(wb.set_formula(data_idx, "A2", "=Sheet1!D1"));
        assert!(
            !wb.set_formula(s1, "D1", "=SUM(Data!A1:A3)"),
            "candidate range should see Data!A2's formula edge back to Sheet1!D1"
        );
        assert_eq!(
            wb.get_cell("Sheet1", "D1"),
            Value::Error(ValueError::CyclicRef)
        );
    }

    /// Workbook-level `bulk_load` coalesces Store propagation and fires each
    /// cross-sheet subscriber at most once at flush time.
    #[test]
    fn bulk_load_dedups_cross_sheet_subscriber_fanout() {
        let mut wb = Workbook::new();
        let data_idx = wb.add_sheet("Data");
        let s1 = wb.index_of("Sheet1").unwrap();
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A1", Value::Number(1.0));
        wb.sheet_mut(data_idx)
            .unwrap()
            .set_cell("A2", Value::Number(2.0));
        // Formula depends on both sources, but one Store batch should publish
        // the derived formula only once.
        assert!(wb.set_formula(s1, "B1", "=Data!A1+Data!A2"));

        let changes = Rc::new(RefCell::new(0u32));
        let cc = changes.clone();
        wb.sheet_mut(s1).unwrap().subscribe_cell("B1", move || {
            *cc.borrow_mut() += 1;
        });

        wb.bulk_load(|loader| {
            loader.set_cell(data_idx, "A1", Value::Number(10.0));
            loader.set_cell(data_idx, "A2", Value::Number(20.0));
        });

        // Two writes to the same target → ONE subscriber fire.
        assert_eq!(
            *changes.borrow(),
            1,
            "bulk_load must dedup cross-sheet subscriber fanout"
        );
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(30.0));
    }

    /// Cycle detection walks current formula sources on demand and retains no
    /// workbook dependency index. The debug counter records one candidate
    /// cycle-check invocation per `set_formula` call.
    #[test]
    fn cross_sheet_cycle_walks_sources_on_demand_without_retained_graph() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();

        // Install a non-cycle cross-sheet pair that the next check traverses:
        //   `Sheet1!A1 = =Sheet2!B1`
        //   `Sheet2!B1 = =Sheet1!D1`
        assert!(wb.set_formula(s1, "A1", "=Sheet2!B1"));
        assert!(wb.set_formula(s2, "B1", "=Sheet1!D1"));

        let before = wb.debug_cycle_ast_walk_count();

        // The traversal reaches Sheet2!B1 and Sheet1!D1, but never the
        // candidate Sheet1!C1, so this is not a cycle.
        assert!(
            wb.set_formula(s1, "C1", "=Sheet2!B1"),
            "re-reader of an existing cross-sheet source is not a cycle"
        );

        let after = wb.debug_cycle_ast_walk_count();
        let delta = after - before;
        assert_eq!(
            delta, 1,
            "each set_formula should record one on-demand cycle check; got {delta}"
        );

        // Sanity: the chain still evaluates correctly.
        assert!(matches!(
            wb.get_cell("Sheet1", "C1"),
            Value::Number(_) | Value::Null
        ));
    }

    /// Static cycle detection follows both same-sheet and cross-sheet hops by
    /// walking each reachable formula source on demand.
    ///
    /// Setup:
    ///   - `Sheet1!A1 = =Sheet2!B1` — cross-sheet edge.
    ///   - `Sheet2!B1 = =C1` — same-sheet edge.
    ///   - `Sheet2!C1 = =Sheet1!A1` — closing cross-sheet edge.
    #[test]
    fn static_cycle_check_follows_same_sheet_hop() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet2");
        let s1 = wb.index_of("Sheet1").unwrap();
        let s2 = wb.index_of("Sheet2").unwrap();

        assert!(wb.set_formula(s1, "A1", "=Sheet2!B1"));

        wb.sheet_mut(s2).unwrap().set_formula("B1", "=C1");

        assert!(
            !wb.set_formula(s2, "C1", "=Sheet1!A1"),
            "the on-demand source walk must detect the same-sheet hop"
        );
        assert_eq!(
            wb.get_cell("Sheet2", "C1"),
            Value::Error(ValueError::CyclicRef)
        );
    }

    // === Wave 8 codex-review fix #1: re-entrancy guard ===
    //
    // A host custom-formula callback MUST NOT mutate the workbook during
    // its execution. These tests pin the rejection behavior across the
    // mutation entry points, plus prove the cache state remains sound
    // (no silently-lost dirty marks).

    /// A custom callback that tries to call `wb.set_cell` is reflected
    /// back the guard as a silent no-op (the infallible signature can't
    /// return an error). The mutation is dropped; the cache state for
    /// the cell whose formula triggered the callback is `Clean(value)`
    /// of the original value.
    #[test]
    fn custom_callback_set_cell_is_rejected_and_cache_stays_clean() {
        use std::sync::Mutex;

        /// Registry that calls back into the workbook from inside its
        /// `lookup`. We can't pass a `&mut Workbook` directly through
        /// the immutable `EvalProvider` trait, so the test relies on
        /// the same wasm-bridge shape: the registry holds a callback
        /// closure that the test installs via a wrapper struct holding
        /// `*mut Workbook` (the test only dereferences inside the
        /// callback, AFTER the read borrow has been released by the
        /// `EvalProvider` chain — which is what would happen in the
        /// real WASM bridge).
        struct AttackRegistry {
            wb_ptr: Mutex<*mut Workbook>,
            invoked: Mutex<usize>,
        }
        // SAFETY: tests are single-threaded; the Mutex satisfies the
        // trait bounds without allowing real cross-thread sharing.
        unsafe impl Send for AttackRegistry {}
        unsafe impl Sync for AttackRegistry {}
        impl std::fmt::Debug for AttackRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "AttackRegistry")
            }
        }
        impl CustomFunctionRegistry for AttackRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                *self.invoked.lock().unwrap() += 1;
                // Try to mutate the workbook from inside the callback.
                // SAFETY: see test setup — the pointer is valid for the
                // duration of the eval frame because the test holds the
                // `Workbook` by value and never moves it during read.
                let wb_ptr = *self.wb_ptr.lock().unwrap();
                // The guard MUST cause this to be a no-op.
                unsafe {
                    (*wb_ptr).set_cell(0, "Z99", Value::Number(999.0));
                }
                Some(Value::Number(42.0))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(AttackRegistry {
            wb_ptr: Mutex::new(&mut wb as *mut Workbook),
            invoked: Mutex::new(0),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        // Re-pin the pointer post-install (the Arc swap might not have
        // moved `wb`, but be defensive — the test asserts the address
        // is current).
        *registry.wb_ptr.lock().unwrap() = &mut wb as *mut Workbook;
        assert!(wb.set_formula(0, "A1", "=MYBAD()"));

        // Read the formula. The callback runs, attempts to write Z99,
        // and gets silently rejected by the guard.
        let v = wb.get_cell("Sheet1", "A1");
        assert_eq!(v, Value::Number(42.0));
        // The callback may run more than once during install +
        // first-read (set_formula performs a workbook-aware recompute
        // pass when the formula references workbook-scope things). The
        // important guarantee is that EVERY invocation hit the guard
        // and was rejected.
        assert!(
            *registry.invoked.lock().unwrap() >= 1,
            "callback must have fired at least once"
        );

        // The attempted mutation MUST NOT have landed. Z99 stays empty.
        let z99 = wb.get_cell("Sheet1", "Z99");
        assert_eq!(z99, Value::Null);

        // After the callback returns, the guard depth is back to 0 so
        // normal mutations work again.
        assert!(!wb.is_inside_custom_call());
        wb.set_cell(0, "B1", Value::Number(7.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(7.0));
    }

    /// The `try_*` family surfaces `Err(MutationDuringCustomCall)` so a
    /// host can debug the rejection rather than silently losing the
    /// write. We exercise this by calling `try_set_cell` directly from
    /// inside the callback through the same `*mut Workbook` trick.
    #[test]
    fn custom_callback_try_set_cell_returns_mutation_error() {
        use std::sync::Mutex;

        struct ProbeRegistry {
            wb_ptr: Mutex<*mut Workbook>,
            last_err: Mutex<Option<SheetError>>,
        }
        unsafe impl Send for ProbeRegistry {}
        unsafe impl Sync for ProbeRegistry {}
        impl std::fmt::Debug for ProbeRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "ProbeRegistry")
            }
        }
        impl CustomFunctionRegistry for ProbeRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                let wb_ptr = *self.wb_ptr.lock().unwrap();
                let result = unsafe { (*wb_ptr).try_set_cell(0, "C1", Value::Number(1.0)) };
                if let Err(e) = result {
                    *self.last_err.lock().unwrap() = Some(e);
                }
                Some(Value::Number(0.0))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(ProbeRegistry {
            wb_ptr: Mutex::new(&mut wb as *mut Workbook),
            last_err: Mutex::new(None),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        *registry.wb_ptr.lock().unwrap() = &mut wb as *mut Workbook;
        assert!(wb.set_formula(0, "A1", "=PROBE()"));

        let _ = wb.get_cell("Sheet1", "A1");

        let err = registry.last_err.lock().unwrap().clone();
        assert_eq!(err, Some(SheetError::MutationDuringCustomCall));
    }

    /// The depth counter is exception-safe: even when the callback
    /// panics / aborts the eval, the `Drop` impl on `CustomCallScope`
    /// decrements the counter so subsequent reads work normally.
    /// (Tested by registering a callback that returns `#VALUE!` — the
    /// engine treats this as a successful dispatch and bookkeeping
    /// runs identically to the normal-return path. A real Rust panic
    /// from inside the callback is unsafe in a `#[test]` outside of
    /// `panic = "abort"`, so the panic path is covered by the wasm
    /// `throw_str` path which exercises the same Drop semantics on
    /// the JS-throw side.)
    #[test]
    fn custom_call_depth_resets_after_callback() {
        use std::sync::Mutex;

        struct ErrorRegistry {
            invoked: Mutex<usize>,
        }
        impl std::fmt::Debug for ErrorRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "ErrorRegistry")
            }
        }
        impl CustomFunctionRegistry for ErrorRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                *self.invoked.lock().unwrap() += 1;
                Some(Value::Error(ValueError::InvalidValue))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(ErrorRegistry {
            invoked: Mutex::new(0),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        assert!(wb.set_formula(0, "A1", "=BAD()"));

        // Three reads — each spins up a fresh CustomCallScope and tears
        // it down. The depth counter must be 0 at every observation.
        for _ in 0..3 {
            assert!(!wb.is_inside_custom_call());
            let v = wb.get_cell("Sheet1", "A1");
            assert!(matches!(v, Value::Error(_)));
            assert!(!wb.is_inside_custom_call());
        }

        // Subsequent normal mutations work, confirming the counter
        // didn't drift.
        wb.set_cell(0, "D1", Value::Number(42.0));
        assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(42.0));
    }

    /// Shared registry for the async custom-formula tests: `SLOW` is
    /// async; `SYNCFN` is a normal sync function; everything else is
    /// unregistered. `lookups` counts sync dispatches — it must stay 0
    /// for async names (the engine never routes them through `lookup`).
    #[derive(Default)]
    struct AsyncTestRegistry {
        lookups: std::sync::Mutex<usize>,
    }
    impl std::fmt::Debug for AsyncTestRegistry {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "AsyncTestRegistry")
        }
    }
    impl CustomFunctionRegistry for AsyncTestRegistry {
        fn lookup(&self, name: &str, _args: &[Value]) -> Option<Value> {
            *self.lookups.lock().unwrap() += 1;
            if name.eq_ignore_ascii_case("SYNCFN") {
                Some(Value::Number(7.0))
            } else {
                None
            }
        }
        fn is_async(&self, name: &str) -> bool {
            name.eq_ignore_ascii_case("SLOW")
        }
    }

    #[test]
    fn async_custom_busy_then_settles_and_propagates() {
        let mut wb = Workbook::new();
        let registry = Arc::new(AsyncTestRegistry::default());
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        assert!(wb.set_formula(0, "A1", "=SLOW(1)"));
        assert!(wb.set_formula(0, "B1", "=A1+1"));

        // Pending: the cell and its dependent both show #BUSY! via the
        // normal error short-circuit.
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Error(ValueError::Busy));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Error(ValueError::Busy));

        let calls = wb.take_pending_async_custom_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "SLOW");
        assert_eq!(calls[0].args, vec![Value::Number(1.0)]);

        assert!(wb
            .resolve_async_custom_call(calls[0].call_id, Value::Number(10.0))
            .unwrap());
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(10.0));
        assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(11.0));

        // Async dispatch never consulted `lookup`, and the settled result
        // is memoized — re-reads enqueue nothing.
        assert_eq!(*registry.lookups.lock().unwrap(), 0);
        assert!(wb.take_pending_async_custom_calls().is_empty());
    }

    #[test]
    fn async_custom_same_args_dedupe_to_one_call() {
        let mut wb = Workbook::new();
        wb.set_custom_function_registry(Some(
            Arc::new(AsyncTestRegistry::default()) as Arc<dyn CustomFunctionRegistry>
        ));
        assert!(wb.set_formula(0, "A1", "=SLOW(2)"));
        assert!(wb.set_formula(0, "A2", "=SLOW(2)"));
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Error(ValueError::Busy));
        assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Error(ValueError::Busy));

        let calls = wb.take_pending_async_custom_calls();
        assert_eq!(calls.len(), 1, "same (name, args) must enqueue once");

        assert!(wb
            .resolve_async_custom_call(calls[0].call_id, Value::Text("done".into()))
            .unwrap());
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Text("done".into()));
        assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Text("done".into()));
    }

    #[test]
    fn async_custom_registry_change_discards_stale_settle_and_rearms() {
        let mut wb = Workbook::new();
        wb.set_custom_function_registry(Some(
            Arc::new(AsyncTestRegistry::default()) as Arc<dyn CustomFunctionRegistry>
        ));
        assert!(wb.set_formula(0, "A1", "=SLOW(3)"));
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Error(ValueError::Busy));
        let calls = wb.take_pending_async_custom_calls();
        assert_eq!(calls.len(), 1);
        let stale_id = calls[0].call_id;

        // Registry changes while the promise is in flight.
        wb.invalidate_all_formulas_for_custom_function_change();

        // The stale settle is dropped…
        assert!(!wb
            .resolve_async_custom_call(stale_id, Value::Number(5.0))
            .unwrap());
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Error(ValueError::Busy));

        // …and the re-read re-armed the call under a fresh id.
        let calls = wb.take_pending_async_custom_calls();
        assert_eq!(calls.len(), 1);
        assert_ne!(calls[0].call_id, stale_id);
        assert!(wb
            .resolve_async_custom_call(calls[0].call_id, Value::Number(6.0))
            .unwrap());
        assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(6.0));
    }

    #[test]
    fn async_custom_arg_error_short_circuits_without_enqueue() {
        let mut wb = Workbook::new();
        wb.set_custom_function_registry(Some(
            Arc::new(AsyncTestRegistry::default()) as Arc<dyn CustomFunctionRegistry>
        ));
        assert!(wb.set_formula(0, "A1", "=SLOW(1/0)"));
        assert_eq!(
            wb.get_cell("Sheet1", "A1"),
            Value::Error(ValueError::DivisionByZero)
        );
        assert!(wb.take_pending_async_custom_calls().is_empty());
        assert_eq!(wb.async_custom_entry_count(), 0);
    }

    /// take/resolve are mutation entry points and follow the same
    /// in-callback rejection contract as every other one.
    #[test]
    fn async_custom_take_and_resolve_rejected_inside_callback() {
        use std::sync::Mutex;

        struct ReentrantRegistry {
            wb_ptr: Mutex<*mut Workbook>,
            observed: Mutex<Option<(usize, Result<bool, WorkbookError>)>>,
        }
        unsafe impl Send for ReentrantRegistry {}
        unsafe impl Sync for ReentrantRegistry {}
        impl std::fmt::Debug for ReentrantRegistry {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "ReentrantRegistry")
            }
        }
        impl CustomFunctionRegistry for ReentrantRegistry {
            fn lookup(&self, _name: &str, _args: &[Value]) -> Option<Value> {
                let wb_ptr = *self.wb_ptr.lock().unwrap();
                let (taken, resolved) = unsafe {
                    (
                        (*wb_ptr).take_pending_async_custom_calls().len(),
                        (*wb_ptr).resolve_async_custom_call(1, Value::Number(1.0)),
                    )
                };
                *self.observed.lock().unwrap() = Some((taken, resolved));
                Some(Value::Number(0.0))
            }
        }

        let mut wb = Workbook::new();
        let registry = Arc::new(ReentrantRegistry {
            wb_ptr: Mutex::new(&mut wb as *mut Workbook),
            observed: Mutex::new(None),
        });
        wb.set_custom_function_registry(Some(registry.clone() as Arc<dyn CustomFunctionRegistry>));
        *registry.wb_ptr.lock().unwrap() = &mut wb as *mut Workbook;
        assert!(wb.set_formula(0, "A1", "=REENTER()"));
        let _ = wb.get_cell("Sheet1", "A1");

        let observed = registry.observed.lock().unwrap().clone();
        let (taken, resolved) = observed.expect("callback must have run");
        assert_eq!(taken, 0, "take inside callback must return empty");
        assert_eq!(
            resolved,
            Err(WorkbookError::MutationDuringCustomCall),
            "resolve inside callback must be rejected"
        );
    }

    #[test]
    fn async_custom_cap_sweep_evicts_unobserved_entries() {
        use crate::sheet::ASYNC_CUSTOM_RESULT_CACHE_CAP;

        let mut wb = Workbook::new();
        wb.set_custom_function_registry(Some(
            Arc::new(AsyncTestRegistry::default()) as Arc<dyn CustomFunctionRegistry>
        ));
        let over_cap = ASYNC_CUSTOM_RESULT_CACHE_CAP + 88;
        for i in 0..over_cap {
            let addr = format!("A{}", i + 1);
            assert!(wb.set_formula(0, &addr, &format!("=SLOW({i})")));
            let _ = wb.get_cell("Sheet1", &addr);
        }
        assert_eq!(wb.async_custom_entry_count(), over_cap);

        // Overwrite every formula so no formula-inner depends on the
        // result atoms any more, then drain — the sweep runs first.
        for i in 0..over_cap {
            wb.set_cell(0, &format!("A{}", i + 1), Value::Number(0.0));
        }
        let _ = wb.take_pending_async_custom_calls();
        assert!(
            wb.async_custom_entry_count() <= ASYNC_CUSTOM_RESULT_CACHE_CAP,
            "sweep must bring unobserved entries back under the cap (got {})",
            wb.async_custom_entry_count()
        );
    }
}
