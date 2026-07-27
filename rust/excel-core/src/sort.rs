//! Engine physical sort (`sort_range`) — S1 slice of
//! `solid/excel/docs/online-excel-parity/design-engine-sort.md`.
//!
//! Semantics (normative, per the design adjudications):
//!
//!   - **Comparator** (`sort_cmp`, §3.2): Excel type order
//!     number < text < boolean < error < empty; empty sorts LAST in both
//!     directions; descending reverses only the non-empty comparison.
//!     Text compares case-folded by default (`case_sensitive: false`)
//!     in code-point order — deliberately NO locale collation, so the
//!     result is deterministic across static/worker/platforms.
//!   - **Slot algorithm** (§6.2): rows listed in `excluded_rows` keep
//!     their position and never participate in comparison; the remaining
//!     "visible slots" are stably permuted in place. Key values are
//!     materialized (evaluated) before any move.
//!   - **Formulas move VERBATIM** (§4): AST / parked source text is
//!     relocated without reference translation — the sort path never
//!     touches `shift.rs` and can never mint `#REF!` sentinels.
//!   - **Formats** (§5.3): per-cell formats ride along with
//!     `relocate_cells`; range-format layers are pre-processed by
//!     "materialize + cut" so no layer overlaps the sorted range when the
//!     permutation runs. Row heights do NOT move (Excel behavior).
//!   - **Spill** (§5.1): any intersection between the range and an active
//!     spill (anchor or target) is rejected up front; after that gate the
//!     permutation is identity outside the range, so no spill teardown or
//!     re-derive is needed.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use einfach_core::Value;

use crate::cell::CellAddress;
use crate::format::CellFormat;
use crate::range::CellRange;
use crate::sheet::{collapse_array_for_eval, RangeFormat, Sheet, EXCEL_MAX_COLS, EXCEL_MAX_ROWS};
use crate::workbook::Workbook;

/// Sort direction for one key. Descending reverses the comparison of the
/// non-empty classes only — empty cells sink to the end either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortDirection {
    Ascending,
    Descending,
}

/// One sort key: an absolute (0-based) column that must fall inside the
/// sorted range's column span.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SortKey {
    /// Absolute column index (0-based), inside the range's column span.
    pub col: u32,
    pub direction: SortDirection,
    /// Case-sensitive text comparison; Excel default is `false`.
    pub case_sensitive: bool,
}

/// Result witness for a completed `sort_range`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SortRangeReport {
    /// Number of visible slots whose source row changed; 0 means no-op.
    pub moved_rows: u32,
    /// Number of non-empty cells relocated by the permutation.
    pub moved_cells: u32,
    /// Permutation witness for changed slots only:
    /// `(slot row, row that occupied the slot before the sort)`.
    /// Reserved for overlay remap / parity assertions; v1 consumers may
    /// ignore it.
    pub row_permutation: Vec<(u32, u32)>,
}

/// Structured rejections. The sort never partially applies: any `Err`
/// leaves the sheet untouched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortRangeError {
    /// Range exceeds the Excel grid, or (workbook entry point) the sheet
    /// index does not exist.
    InvalidRange,
    EmptyKeys,
    /// A key column falls outside the range's column span.
    KeyOutOfRange,
    /// The range intersects an active spill (anchor or target). Aligned
    /// with Excel's "can't change part of an array" rejection.
    SpillIntersectsRange {
        anchor: CellAddress,
    },
}

// === Comparator (§3.2, normative) ===

/// Rank of the Excel type classes in ascending order. `Lambda` folds into
/// the error class (transient evaluator state; never durably in cells).
fn type_rank(v: &Value) -> u8 {
    match v {
        Value::Number(_) => 0,
        Value::Text(_) => 1,
        Value::Boolean(_) => 2,
        Value::Error(_) | Value::Lambda(_) => 3,
        Value::Null => 4,
        // Unreachable for sort keys (the spill gate rejects in-range
        // arrays and callers collapse); ranked defensively via key_scalar.
        Value::Array(_) => 0,
    }
}

/// Collapse a `Value::Array` to its top-left scalar. Sort keys can never
/// be arrays after the spill gate, but the comparator stays total anyway
/// (mirrors the WASM boundary collapse).
fn key_scalar(v: &Value) -> &Value {
    match v {
        Value::Array(arr) => arr.get(0, 0).unwrap_or(&Value::Null),
        other => other,
    }
}

/// NaN is an engineering extension (Excel has no NaN): NaNs compare equal
/// to each other and sort after every real number within the number class.
fn cmp_number(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

/// Text order: code-point order, case-folded via the std Unicode lowercase
/// mapping when `case_sensitive` is false. Deliberately no locale
/// collation (design §3.2 conformance note — determinism over ICU).
fn cmp_text(a: &str, b: &str, case_sensitive: bool) -> Ordering {
    if case_sensitive {
        a.chars().cmp(b.chars())
    } else {
        a.chars()
            .flat_map(char::to_lowercase)
            .cmp(b.chars().flat_map(char::to_lowercase))
    }
}

/// Comparison within the non-empty classes; callers have already peeled
/// the empty layer and collapsed arrays.
fn cmp_non_null(a: &Value, b: &Value, case_sensitive: bool) -> Ordering {
    let (ra, rb) = (type_rank(a), type_rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => cmp_number(*x, *y),
        (Value::Text(x), Value::Text(y)) => cmp_text(x, y, case_sensitive),
        (Value::Boolean(x), Value::Boolean(y)) => x.cmp(y),
        // Error class (incl. Lambda): errors never compare against each
        // other — stability preserves their pre-sort slot order.
        _ => Ordering::Equal,
    }
}

/// Normative ascending total order (design §3.2): number < text < boolean
/// < error < empty, with empty always last. Stable sorting on top of this
/// order gives the full sort semantics.
pub fn sort_cmp(a: &Value, b: &Value, case_sensitive: bool) -> Ordering {
    let (a, b) = (key_scalar(a), key_scalar(b));
    match (matches!(a, Value::Null), matches!(b, Value::Null)) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => cmp_non_null(a, b, case_sensitive),
    }
}

/// Directional comparator: the empty layer is direction-independent
/// (empty sorts last both ways); the direction applies only to the
/// non-empty comparison.
pub fn sort_cmp_with_direction(
    a: &Value,
    b: &Value,
    case_sensitive: bool,
    direction: SortDirection,
) -> Ordering {
    let (a, b) = (key_scalar(a), key_scalar(b));
    match (matches!(a, Value::Null), matches!(b, Value::Null)) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            let ord = cmp_non_null(a, b, case_sensitive);
            match direction {
                SortDirection::Ascending => ord,
                SortDirection::Descending => ord.reverse(),
            }
        }
    }
}

// === Rectangle helpers (format layer cut) ===

fn ranges_intersect(a: CellRange, b: CellRange) -> bool {
    let (a, b) = (a.normalize(), b.normalize());
    !(a.end.row < b.start.row
        || a.start.row > b.end.row
        || a.end.col < b.start.col
        || a.start.col > b.end.col)
}

/// Geometric subtraction `a \ b` for normalized, intersecting rectangles:
/// up to 4 disjoint pieces (top band, bottom band, left/middle,
/// right/middle) that tile `a` minus `b` exactly.
fn subtract_range(a: CellRange, b: CellRange) -> Vec<CellRange> {
    let mut out = Vec::with_capacity(4);
    if a.start.row < b.start.row {
        out.push(CellRange::new(
            CellAddress::new(a.start.row, a.start.col),
            CellAddress::new(b.start.row - 1, a.end.col),
        ));
    }
    if a.end.row > b.end.row {
        out.push(CellRange::new(
            CellAddress::new(b.end.row + 1, a.start.col),
            CellAddress::new(a.end.row, a.end.col),
        ));
    }
    let mid_r0 = a.start.row.max(b.start.row);
    let mid_r1 = a.end.row.min(b.end.row);
    if mid_r0 <= mid_r1 {
        if a.start.col < b.start.col {
            out.push(CellRange::new(
                CellAddress::new(mid_r0, a.start.col),
                CellAddress::new(mid_r1, b.start.col - 1),
            ));
        }
        if a.end.col > b.end.col {
            out.push(CellRange::new(
                CellAddress::new(mid_r0, b.end.col + 1),
                CellAddress::new(mid_r1, a.end.col),
            ));
        }
    }
    out
}

/// Intersection of two normalized, intersecting rectangles.
fn intersect_range(a: CellRange, b: CellRange) -> CellRange {
    CellRange::new(
        CellAddress::new(a.start.row.max(b.start.row), a.start.col.max(b.start.col)),
        CellAddress::new(a.end.row.min(b.end.row), a.end.col.min(b.end.col)),
    )
}

impl Sheet {
    /// §5.1 spill gate: first active spill rectangle (anchor plus targets)
    /// intersecting `range`, reported by its anchor. Deterministic: the
    /// top-left-most intersecting anchor wins (HashMap iteration order
    /// must not leak into the rejection payload).
    fn sort_spill_intersecting(&self, range: CellRange) -> Option<CellAddress> {
        let mut hit: Option<CellAddress> = None;
        for anchor in self.spill_anchor_addr.values().copied() {
            let (rows, cols) = self.spill_info(anchor).unwrap_or((1, 1));
            let rect = CellRange::new(
                anchor,
                CellAddress::new(anchor.row + rows.max(1) - 1, anchor.col + cols.max(1) - 1),
            );
            if ranges_intersect(rect, range)
                && hit.is_none_or(|h| (anchor.row, anchor.col) < (h.row, h.col))
            {
                hit = Some(anchor);
            }
        }
        hit
    }

    /// §5.3 format-layer preprocessing: materialize the effective base
    /// format of every layer-covered cell inside `range` as a per-cell
    /// entry, then geometrically cut every intersecting layer so no layer
    /// overlaps `range`. Afterwards "default = no entry" holds inside the
    /// range and `relocate_cells` moving per-cell entries is the complete,
    /// correct format semantics; all remaining layer corners live outside
    /// the range, where the sort permutation is identity.
    ///
    /// Layer Vec order is preserved (pieces replace their source layer in
    /// place), so the "later layer wins" resolution outside the range is
    /// unchanged.
    fn materialize_and_cut_format_layers(&mut self, range: CellRange) {
        let intersecting: Vec<CellRange> = self
            .range_formats
            .iter()
            .map(|layer| layer.range)
            .filter(|r| ranges_intersect(*r, range))
            .collect();
        if intersecting.is_empty() {
            return;
        }

        // 1. Materialize. `base_format_at` resolves per-cell > topmost
        //    covering layer, so visiting each covered cell once (bounded
        //    by Σ layer∩range areas, not the whole range) is exact.
        //    Cells whose effective format is default get NO entry — a
        //    later default-format layer shadowing an earlier styled one
        //    resolves to default, and absence encodes exactly that.
        let default = CellFormat::default();
        let mut seen: HashSet<CellAddress> = HashSet::new();
        for rect in &intersecting {
            for addr in intersect_range(rect.normalize(), range).iter() {
                if !seen.insert(addr) || self.formats.contains_key(&addr) {
                    continue;
                }
                let fmt = self.base_format_at(addr);
                if fmt != default {
                    self.formats.insert(addr, fmt);
                }
            }
        }

        // 2. Cut: replace each intersecting layer with ≤4 disjoint pieces
        //    that avoid `range`, preserving Vec order.
        let old_layers = std::mem::take(&mut self.range_formats);
        let mut next = Vec::with_capacity(old_layers.len());
        for layer in old_layers {
            if !ranges_intersect(layer.range, range) {
                next.push(layer);
                continue;
            }
            for piece in subtract_range(layer.range.normalize(), range) {
                next.push(RangeFormat {
                    range: piece,
                    fmt: layer.fmt.clone(),
                });
            }
        }
        self.range_formats = next;
    }

    /// Physically sort `range` by `keys`, keeping `excluded_rows` in place
    /// (design §3/§6). Rows in `excluded_rows` outside the range are
    /// ignored; duplicates are deduplicated. Keys are evaluated results
    /// (formulas sort by value), materialized before any move. Returns a
    /// no-op report (`moved_rows: 0`) without writing anything when the
    /// permutation is identity.
    pub fn sort_range(
        &mut self,
        range: CellRange,
        keys: &[SortKey],
        excluded_rows: &[u32],
    ) -> Result<SortRangeReport, SortRangeError> {
        let n = range.normalize();
        if n.end.row >= EXCEL_MAX_ROWS || n.end.col >= EXCEL_MAX_COLS {
            return Err(SortRangeError::InvalidRange);
        }
        if keys.is_empty() {
            return Err(SortRangeError::EmptyKeys);
        }
        if keys
            .iter()
            .any(|k| k.col < n.start.col || k.col > n.end.col)
        {
            return Err(SortRangeError::KeyOutOfRange);
        }
        if let Some(anchor) = self.sort_spill_intersecting(n) {
            return Err(SortRangeError::SpillIntersectsRange { anchor });
        }

        // Visible slots: the range's rows minus the (deduped, clamped)
        // excluded set, ascending.
        let excluded: HashSet<u32> = excluded_rows
            .iter()
            .copied()
            .filter(|r| *r >= n.start.row && *r <= n.end.row)
            .collect();
        let visible: Vec<u32> = (n.start.row..=n.end.row)
            .filter(|r| !excluded.contains(r))
            .collect();
        if visible.len() <= 1 {
            return Ok(SortRangeReport::default());
        }

        // Materialize every key tuple BEFORE any move — no mid-permutation
        // reads. Evaluated results: formulas sort by value (§3.1). Settle
        // pending derived reads afterwards so the relocation write does
        // not inherit per-read bookkeeping (same hygiene as `get_cell`).
        let key_values: Vec<Vec<Value>> = visible
            .iter()
            .map(|&row| {
                keys.iter()
                    .map(|k| collapse_array_for_eval(self.peek_value(CellAddress::new(row, k.col))))
                    .collect()
            })
            .collect();
        self.store.settle_pending_reads();

        // Stable permutation of visible-slot indices (§6.2). `sort_by` is
        // stable, so key-equal rows keep their pre-sort slot order.
        let mut perm: Vec<usize> = (0..visible.len()).collect();
        perm.sort_by(|&ia, &ib| {
            for (ki, key) in keys.iter().enumerate() {
                let ord = sort_cmp_with_direction(
                    &key_values[ia][ki],
                    &key_values[ib][ki],
                    key.case_sensitive,
                    key.direction,
                );
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            Ordering::Equal
        });

        // Row map for changed slots only: old row → new (slot) row.
        let mut row_map: HashMap<u32, u32> = HashMap::new();
        let mut row_permutation: Vec<(u32, u32)> = Vec::new();
        for (i, &pi) in perm.iter().enumerate() {
            let slot = visible[i];
            let source = visible[pi];
            if slot != source {
                row_map.insert(source, slot);
                row_permutation.push((slot, source));
            }
        }
        if row_map.is_empty() {
            // Identity permutation: no writes at all.
            return Ok(SortRangeReport::default());
        }

        let mut moved_cells: u32 = 0;
        self.for_each_non_empty_in_range(n, |addr| {
            if row_map.contains_key(&addr.row) {
                moved_cells += 1;
            }
        });
        let moved_rows = row_permutation.len() as u32;

        // §6.3: reuse the structural-edit machine (subscription detach,
        // one Store batch, topology epoch bump, per-address change
        // notification), but SKIP spill teardown (gate above) and both
        // `retarget_*` steps (verbatim semantics). `relocate_cells` moves
        // values, hydrated ASTs, formula texts, parked sources, and
        // per-cell formats under the row permutation; the map is a
        // bijection so the full-map rebuild cannot collide.
        let (c0, c1) = (n.start.col, n.end.col);
        self.with_structural_edit(move |sheet| {
            sheet.materialize_and_cut_format_layers(n);
            sheet.relocate_cells(|addr| {
                if addr.col >= c0 && addr.col <= c1 {
                    if let Some(&next) = row_map.get(&addr.row) {
                        return CellAddress::new(next, addr.col);
                    }
                }
                addr
            });
            sheet.prune_obsolete_formula_atoms();
        });

        Ok(SortRangeReport {
            moved_rows,
            moved_cells,
            row_permutation,
        })
    }
}

impl Workbook {
    /// Workbook entry point for the physical sort. A missing `sheet_idx`
    /// is reported as `InvalidRange` (the request addresses a range that
    /// does not exist); everything else delegates to
    /// [`Sheet::sort_range`]. Cross-sheet dependents recompute through
    /// the shared Store like any other same-sheet mutation.
    pub fn sort_range(
        &mut self,
        sheet_idx: usize,
        range: CellRange,
        keys: &[SortKey],
        excluded_rows: &[u32],
    ) -> Result<SortRangeReport, SortRangeError> {
        let Some(sheet) = self.sheet_mut(sheet_idx) else {
            return Err(SortRangeError::InvalidRange);
        };
        sheet.sort_range(range, keys, excluded_rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Arc;

    use einfach_core::{ArrayData, Value, ValueError};

    fn addr(s: &str) -> CellAddress {
        CellAddress::parse(s).unwrap()
    }

    fn range(a: &str, b: &str) -> CellRange {
        CellRange::new(addr(a), addr(b))
    }

    fn asc(col: u32) -> SortKey {
        SortKey {
            col,
            direction: SortDirection::Ascending,
            case_sensitive: false,
        }
    }

    fn desc(col: u32) -> SortKey {
        SortKey {
            col,
            direction: SortDirection::Descending,
            case_sensitive: false,
        }
    }

    fn num(n: f64) -> Value {
        Value::Number(n)
    }

    fn text(s: &str) -> Value {
        Value::Text(s.into())
    }

    /// Column-A values of `sheet` for rows 0..count as display-ish enums.
    fn col_values(sheet: &Sheet, col: &str, count: u32) -> Vec<Value> {
        (1..=count)
            .map(|r| sheet.get_cell(&format!("{col}{r}")))
            .collect()
    }

    // === Comparator: type order, empties, numbers, text, booleans,
    // errors, direction, multi-key ===

    #[test]
    fn sort_cmp_type_order_ascending() {
        let n = num(5.0);
        let t = text("a");
        let b = Value::Boolean(false);
        let e = Value::Error(ValueError::DivisionByZero);
        let empty = Value::Null;
        // number < text < boolean < error < empty, pairwise.
        let ordered = [&n, &t, &b, &e, &empty];
        for i in 0..ordered.len() {
            for j in 0..ordered.len() {
                let expect = i.cmp(&j);
                assert_eq!(
                    sort_cmp(ordered[i], ordered[j], false),
                    expect,
                    "class {i} vs {j}"
                );
            }
        }
    }

    #[test]
    fn sort_cmp_empty_last_in_both_directions() {
        let n = num(1.0);
        let empty = Value::Null;
        for dir in [SortDirection::Ascending, SortDirection::Descending] {
            assert_eq!(
                sort_cmp_with_direction(&empty, &n, false, dir),
                Ordering::Greater,
                "empty must sink for {dir:?}"
            );
            assert_eq!(
                sort_cmp_with_direction(&n, &empty, false, dir),
                Ordering::Less
            );
            assert_eq!(
                sort_cmp_with_direction(&empty, &empty, false, dir),
                Ordering::Equal
            );
        }
    }

    #[test]
    fn sort_cmp_numbers_negative_zero_serial_nan() {
        assert_eq!(sort_cmp(&num(-3.0), &num(0.0), false), Ordering::Less);
        assert_eq!(sort_cmp(&num(0.0), &num(0.5), false), Ordering::Less);
        // Date serial values are plain numbers.
        assert_eq!(
            sort_cmp(&num(45_000.0), &num(45_001.0), false),
            Ordering::Less
        );
        // NaN: equal to itself, after every real number, before text.
        assert_eq!(
            sort_cmp(&num(f64::NAN), &num(f64::NAN), false),
            Ordering::Equal
        );
        assert_eq!(
            sort_cmp(&num(f64::MAX), &num(f64::NAN), false),
            Ordering::Less
        );
        assert_eq!(sort_cmp(&num(f64::NAN), &text("a"), false), Ordering::Less);
    }

    #[test]
    fn sort_cmp_text_case_fold_default_and_case_sensitive() {
        // Default: case-insensitive code-point order.
        assert_eq!(
            sort_cmp(&text("apple"), &text("Banana"), false),
            Ordering::Less
        );
        assert_eq!(
            sort_cmp(&text("APPLE"), &text("apple"), false),
            Ordering::Equal
        );
        // Case-sensitive: plain code-point order ('B' < 'a').
        assert_eq!(
            sort_cmp(&text("Banana"), &text("apple"), true),
            Ordering::Less
        );
        assert_eq!(
            sort_cmp(&text("APPLE"), &text("apple"), true),
            Ordering::Less
        );
        // Non-ASCII fold: 'É' folds to 'é'.
        assert_eq!(sort_cmp(&text("É"), &text("é"), false), Ordering::Equal);
    }

    #[test]
    fn sort_cmp_booleans_false_before_true() {
        assert_eq!(
            sort_cmp(&Value::Boolean(false), &Value::Boolean(true), false),
            Ordering::Less
        );
        assert_eq!(
            sort_cmp(&Value::Boolean(true), &Value::Boolean(true), false),
            Ordering::Equal
        );
    }

    #[test]
    fn sort_cmp_errors_mutually_equal() {
        let e1 = Value::Error(ValueError::DivisionByZero);
        let e2 = Value::Error(ValueError::InvalidName);
        assert_eq!(sort_cmp(&e1, &e2, false), Ordering::Equal);
        assert_eq!(sort_cmp(&e2, &e1, false), Ordering::Equal);
    }

    #[test]
    fn sort_cmp_descending_reverses_non_empty_only() {
        assert_eq!(
            sort_cmp_with_direction(&num(1.0), &num(2.0), false, SortDirection::Descending),
            Ordering::Greater
        );
        assert_eq!(
            sort_cmp_with_direction(&text("a"), &num(2.0), false, SortDirection::Descending),
            Ordering::Less,
            "descending reverses type classes too (number last among non-empty)"
        );
    }

    // === Slot algorithm: basic sorts, stability, idempotence ===

    #[test]
    fn ascending_sort_moves_rows_and_reports_permutation() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(3.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_cell("A3", num(2.0));
        sheet.set_cell("B1", text("three"));
        sheet.set_cell("B2", text("one"));
        sheet.set_cell("B3", text("two"));

        let report = sheet.sort_range(range("A1", "B3"), &[asc(0)], &[]).unwrap();
        assert_eq!(report.moved_rows, 3);
        assert_eq!(report.moved_cells, 6);
        // Slot ← previous occupant: slot 0 ← row 1, slot 1 ← row 2, slot 2 ← row 0.
        assert_eq!(report.row_permutation, vec![(0, 1), (1, 2), (2, 0)]);

        assert_eq!(
            col_values(&sheet, "A", 3),
            vec![num(1.0), num(2.0), num(3.0)]
        );
        assert_eq!(
            col_values(&sheet, "B", 3),
            vec![text("one"), text("two"), text("three")]
        );
    }

    #[test]
    fn descending_sort_with_empty_rows_sinking() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(1.0));
        // A2 empty.
        sheet.set_cell("A3", num(2.0));
        sheet.set_cell("A4", num(3.0));

        sheet
            .sort_range(range("A1", "A4"), &[desc(0)], &[])
            .unwrap();
        // Descending numbers first, empty row sinks to the last slot.
        assert_eq!(
            col_values(&sheet, "A", 4),
            vec![num(3.0), num(2.0), num(1.0), Value::Null]
        );
    }

    #[test]
    fn empty_rows_sink_ascending_data_compacts() {
        let mut sheet = Sheet::new();
        // Row 2 and 4 empty; data on 1, 3, 5.
        sheet.set_cell("A1", num(30.0));
        sheet.set_cell("A3", num(10.0));
        sheet.set_cell("A5", num(20.0));

        sheet.sort_range(range("A1", "A5"), &[asc(0)], &[]).unwrap();
        assert_eq!(
            col_values(&sheet, "A", 5),
            vec![num(10.0), num(20.0), num(30.0), Value::Null, Value::Null]
        );
    }

    #[test]
    fn stable_sort_preserves_slot_order_of_equal_keys() {
        let mut sheet = Sheet::new();
        // Keys: 2, 1, 2, 1 — payload marks original order.
        for (i, (k, p)) in [(2.0, "b1"), (1.0, "b2"), (2.0, "b3"), (1.0, "b4")]
            .iter()
            .enumerate()
        {
            sheet.set_cell(&format!("A{}", i + 1), num(*k));
            sheet.set_cell(&format!("B{}", i + 1), text(p));
        }
        sheet.sort_range(range("A1", "B4"), &[asc(0)], &[]).unwrap();
        assert_eq!(
            col_values(&sheet, "B", 4),
            vec![text("b2"), text("b4"), text("b1"), text("b3")]
        );
    }

    #[test]
    fn resorting_sorted_data_is_noop_and_stable() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_cell("A3", num(1.0));
        sheet.set_cell("B1", text("x"));
        sheet.set_cell("B2", text("first"));
        sheet.set_cell("B3", text("second"));

        let first = sheet.sort_range(range("A1", "B3"), &[asc(0)], &[]).unwrap();
        assert!(first.moved_rows > 0);
        let second = sheet.sort_range(range("A1", "B3"), &[asc(0)], &[]).unwrap();
        assert_eq!(second, SortRangeReport::default());
        assert_eq!(
            col_values(&sheet, "B", 3),
            vec![text("first"), text("second"), text("x")]
        );
    }

    #[test]
    fn multi_key_secondary_direction_applied_per_key() {
        let mut sheet = Sheet::new();
        // Groups in A (asc), tiebreak B (desc).
        let rows = [(2.0, 1.0), (1.0, 5.0), (2.0, 9.0), (1.0, 7.0)];
        for (i, (a, b)) in rows.iter().enumerate() {
            sheet.set_cell(&format!("A{}", i + 1), num(*a));
            sheet.set_cell(&format!("B{}", i + 1), num(*b));
        }
        sheet
            .sort_range(range("A1", "B4"), &[asc(0), desc(1)], &[])
            .unwrap();
        assert_eq!(
            col_values(&sheet, "A", 4),
            vec![num(1.0), num(1.0), num(2.0), num(2.0)]
        );
        assert_eq!(
            col_values(&sheet, "B", 4),
            vec![num(7.0), num(5.0), num(9.0), num(1.0)]
        );
    }

    #[test]
    fn mixed_type_column_sorts_by_class() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", Value::Boolean(true));
        sheet.set_cell("A2", text("zebra"));
        sheet.set_formula("A3", "=1/0");
        sheet.set_cell("A4", num(99.0));
        // A5 empty.
        sheet.set_cell("A6", Value::Boolean(false));

        sheet.sort_range(range("A1", "A6"), &[asc(0)], &[]).unwrap();
        let got = col_values(&sheet, "A", 6);
        assert_eq!(got[0], num(99.0));
        assert_eq!(got[1], text("zebra"));
        assert_eq!(got[2], Value::Boolean(false));
        assert_eq!(got[3], Value::Boolean(true));
        assert_eq!(got[4], Value::Error(ValueError::DivisionByZero));
        assert_eq!(got[5], Value::Null);
    }

    // === Excluded rows ===

    #[test]
    fn excluded_rows_stay_in_place_and_do_not_compare() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(4.0));
        sheet.set_cell("A2", text("PINNED")); // excluded — would sort last if compared
        sheet.set_cell("A3", num(2.0));
        sheet.set_cell("A4", num(1.0));

        let report = sheet
            .sort_range(range("A1", "A4"), &[asc(0)], &[1])
            .unwrap();
        // Visible slots 0, 2, 3 with keys 4, 2, 1 → 1, 2, 4.
        assert_eq!(
            col_values(&sheet, "A", 4),
            vec![num(1.0), text("PINNED"), num(2.0), num(4.0)]
        );
        // Permutation touches visible slots only.
        assert!(report
            .row_permutation
            .iter()
            .all(|&(slot, src)| slot != 1 && src != 1));
    }

    #[test]
    fn excluded_rows_outside_range_are_ignored_and_deduped() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        let report = sheet
            .sort_range(range("A1", "A2"), &[asc(0)], &[999, 999, 7])
            .unwrap();
        assert_eq!(report.moved_rows, 2);
        assert_eq!(col_values(&sheet, "A", 2), vec![num(1.0), num(2.0)]);
    }

    #[test]
    fn excluding_every_row_is_a_noop() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        let report = sheet
            .sort_range(range("A1", "A2"), &[asc(0)], &[0, 1])
            .unwrap();
        assert_eq!(report, SortRangeReport::default());
        assert_eq!(col_values(&sheet, "A", 2), vec![num(2.0), num(1.0)]);
    }

    #[test]
    fn empty_excluded_set_reorders_whole_segment() {
        let mut sheet = Sheet::new();
        for (i, v) in [5.0, 4.0, 3.0, 2.0, 1.0].iter().enumerate() {
            sheet.set_cell(&format!("A{}", i + 1), num(*v));
        }
        sheet.sort_range(range("A1", "A5"), &[asc(0)], &[]).unwrap();
        assert_eq!(
            col_values(&sheet, "A", 5),
            vec![num(1.0), num(2.0), num(3.0), num(4.0), num(5.0)]
        );
    }

    // === Formulas: verbatim relocation, dependency recompute ===

    #[test]
    fn hydrated_formula_moves_verbatim_and_reevaluates_at_new_slot() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(3.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_cell("A3", num(2.0));
        sheet.set_formula("B1", "=A1*10");
        // Hydrate before the sort.
        assert_eq!(sheet.get_cell("B1"), num(30.0));

        sheet.sort_range(range("A1", "B3"), &[asc(0)], &[]).unwrap();
        // Row 0 (key 3) moved to slot 2. Formula text is untouched
        // (verbatim — still "=A1*10") and now reads the NEW A1.
        assert_eq!(sheet.get_formula("B3"), Some("=A1*10".to_string()));
        assert_eq!(sheet.get_cell("B3"), num(10.0));
        assert_eq!(sheet.get_formula("B1"), None);
    }

    #[test]
    fn parked_formula_source_moves_verbatim_without_hydration() {
        let mut sheet = Sheet::new();
        // Park a lazy formula in the non-key column via bulk_load.
        sheet.bulk_load(|loader| {
            loader.set_cell("A1", num(2.0));
            loader.set_cell("A2", num(1.0));
            loader.set_formula("B1", "=A2+100");
        });

        sheet.sort_range(range("A1", "B2"), &[asc(0)], &[]).unwrap();
        // Parked source rode along verbatim to row 1.
        assert_eq!(sheet.get_formula("B2"), Some("=A2+100".to_string()));
        // First read hydrates at the new location: A2 now holds 2.
        assert_eq!(sheet.get_cell("B2"), num(102.0));
    }

    #[test]
    fn outside_formula_reading_sorted_cell_recomputes() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(3.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_cell("A3", num(2.0));
        sheet.set_formula("D1", "=A1"); // outside the sorted range
        assert_eq!(sheet.get_cell("D1"), num(3.0));

        sheet.sort_range(range("A1", "A3"), &[asc(0)], &[]).unwrap();
        // Physical move: D1's reference is NOT adjusted; it reads the new
        // occupant of A1.
        assert_eq!(sheet.get_formula("D1"), Some("=A1".to_string()));
        assert_eq!(sheet.get_cell("D1"), num(1.0));
    }

    #[test]
    fn in_range_formula_keeps_pointing_at_original_address() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_formula("B1", "=A1"); // references inside the range
        assert_eq!(sheet.get_cell("B1"), num(2.0));

        sheet.sort_range(range("A1", "B2"), &[asc(0)], &[]).unwrap();
        // Formula moved to row 1; still reads A1 (verbatim, no offset
        // preservation — recorded conformance divergence from Excel).
        assert_eq!(sheet.get_formula("B2"), Some("=A1".to_string()));
        assert_eq!(sheet.get_cell("B2"), num(1.0));
    }

    // === Formats ===

    #[test]
    fn per_cell_format_moves_with_its_row() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        let bold = CellFormat {
            bold: true,
            ..CellFormat::default()
        };
        sheet.set_format("A1", bold.clone());

        sheet.sort_range(range("A1", "A2"), &[asc(0)], &[]).unwrap();
        assert_eq!(sheet.get_format("A2"), bold);
        assert_eq!(sheet.get_format("A1"), CellFormat::default());
    }

    #[test]
    fn layer_intersecting_range_is_materialized_and_cut() {
        let mut sheet = Sheet::new();
        // Data rows 0..2 in col A; keys force row 0 → slot 2.
        sheet.set_cell("A1", num(3.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_cell("A3", num(2.0));
        let red = CellFormat {
            background: Some("#ff0000".into()),
            ..CellFormat::default()
        };
        // Layer covers row 0 only (A1:B1), extending PAST the range's
        // column span into col B... no — keep it inside rows: layer A1:A1
        // is row 0 of the sorted range; plus an outside strip A5:A6.
        sheet.set_format_range(range("A1", "A1"), red.clone());
        sheet.set_format_range(range("A5", "A6"), red.clone());

        sheet.sort_range(range("A1", "A3"), &[asc(0)], &[]).unwrap();
        // Row 0's red format was materialized and moved with its row to slot 2.
        assert_eq!(sheet.get_format("A3"), red);
        // The new occupants of rows 0/1 are NOT polluted by the old layer.
        assert_eq!(sheet.get_format("A1"), CellFormat::default());
        assert_eq!(sheet.get_format("A2"), CellFormat::default());
        // Untouched layer outside the range still resolves.
        assert_eq!(sheet.get_format("A5"), red);
        assert_eq!(sheet.get_format("A6"), red);
    }

    #[test]
    fn layer_straddling_range_boundary_survives_outside() {
        let mut sheet = Sheet::new();
        // Sort range B2:C4 (rows 1..3, cols 1..2). Layer A1:D5 covers it
        // fully plus a one-cell halo on every side.
        for (i, v) in [3.0, 1.0, 2.0].iter().enumerate() {
            sheet.set_cell(&format!("B{}", i + 2), num(*v));
            sheet.set_cell(&format!("C{}", i + 2), num(*v * 10.0));
        }
        let red = CellFormat {
            background: Some("#f00".into()),
            ..CellFormat::default()
        };
        sheet.set_format_range(range("A1", "D5"), red.clone());

        sheet.sort_range(range("B2", "C4"), &[asc(1)], &[]).unwrap();
        // Inside: every cell was layer-covered → materialized red rides
        // along; all slots still show red.
        for r in 2..=4 {
            assert_eq!(sheet.get_format(&format!("B{r}")), red, "B{r}");
            assert_eq!(sheet.get_format(&format!("C{r}")), red, "C{r}");
        }
        // Outside halo (cut layer pieces): still red.
        for a in ["A1", "B1", "D1", "A3", "D3", "A5", "C5", "D5"] {
            assert_eq!(sheet.get_format(a), red, "{a}");
        }
        // Values moved: col B ascending.
        assert_eq!(sheet.get_cell("B2"), num(1.0));
        assert_eq!(sheet.get_cell("B3"), num(2.0));
        assert_eq!(sheet.get_cell("B4"), num(3.0));
        assert_eq!(sheet.get_cell("C4"), num(30.0));
    }

    #[test]
    fn default_cells_are_not_polluted_by_residual_layers() {
        let mut sheet = Sheet::new();
        // Layer covers ONLY row 1 (A2:B2) inside range A1:B3. Row 1's
        // content moves to slot 0; row 0's default content moves to
        // slot 2 — and must stay default there (no residual layer).
        sheet.set_cell("A1", num(3.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_cell("A3", num(2.0));
        let red = CellFormat {
            background: Some("#f00".into()),
            ..CellFormat::default()
        };
        sheet.set_format_range(range("A2", "B2"), red.clone());

        sheet.sort_range(range("A1", "B3"), &[asc(0)], &[]).unwrap();
        // Row 1 (key 1) → slot 0: red follows.
        assert_eq!(sheet.get_format("A1"), red);
        assert_eq!(sheet.get_format("B1"), red);
        // Row 2 (key 2) → slot 1: was default, sits where the layer used
        // to be — must NOT inherit red.
        assert_eq!(sheet.get_format("A2"), CellFormat::default());
        // Row 0 (key 3) → slot 2: default stays default.
        assert_eq!(sheet.get_format("A3"), CellFormat::default());
    }

    #[test]
    fn format_snapshot_restores_layer_geometry_exactly() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        let red = CellFormat {
            background: Some("#f00".into()),
            ..CellFormat::default()
        };
        let bold = CellFormat {
            bold: true,
            ..CellFormat::default()
        };
        sheet.set_format_range(range("A1", "B1"), red.clone());
        sheet.set_format("A2", bold.clone());

        let r = range("A1", "B2");
        let before = sheet.snapshot_format_range(r);
        sheet.sort_range(r, &[asc(0)], &[]).unwrap();
        // Sort mutated the layer set (materialize + cut).
        assert_eq!(sheet.get_format("A2"), red);
        assert_eq!(sheet.get_format("A1"), bold);

        sheet.restore_format_range_snapshot(before.clone());
        // Per-cell entries and layer geometry are back to pre-sort state.
        assert_eq!(sheet.get_format("A1"), red);
        assert_eq!(sheet.get_format("B1"), red);
        assert_eq!(sheet.get_format("A2"), bold);
        let after = sheet.snapshot_format_range(r);
        assert_eq!(after.cell_formats, before.cell_formats);
        assert_eq!(after.range_formats.len(), before.range_formats.len());
        for (x, y) in after.range_formats.iter().zip(before.range_formats.iter()) {
            assert_eq!(x.range, y.range);
            assert_eq!(x.fmt, y.fmt);
        }
    }

    // === Gates ===

    #[test]
    fn spill_anchor_inside_range_rejects() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        let arr = Arc::new(ArrayData::new(2, 1, vec![num(7.0), num(8.0)]));
        sheet.set_array("A2", arr).unwrap();

        let err = sheet
            .sort_range(range("A1", "A3"), &[asc(0)], &[])
            .unwrap_err();
        assert_eq!(
            err,
            SortRangeError::SpillIntersectsRange { anchor: addr("A2") }
        );
        // Nothing moved.
        assert_eq!(sheet.get_cell("A1"), num(2.0));
    }

    #[test]
    fn spill_target_only_intersection_rejects_with_anchor() {
        let mut sheet = Sheet::new();
        let arr = Arc::new(ArrayData::new(3, 1, vec![num(1.0), num(2.0), num(3.0)]));
        sheet.set_array("A5", arr).unwrap(); // spills A5:A7
        sheet.set_cell("A8", num(9.0));

        // Range touches only the target A7, not the anchor.
        let err = sheet
            .sort_range(range("A7", "A9"), &[asc(0)], &[])
            .unwrap_err();
        assert_eq!(
            err,
            SortRangeError::SpillIntersectsRange { anchor: addr("A5") }
        );
    }

    #[test]
    fn spill_outside_range_does_not_block_sort() {
        let mut sheet = Sheet::new();
        let arr = Arc::new(ArrayData::new(2, 1, vec![num(1.0), num(2.0)]));
        sheet.set_array("D1", arr).unwrap(); // spills D1:D2, outside cols A..B
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));

        sheet.sort_range(range("A1", "B2"), &[asc(0)], &[]).unwrap();
        assert_eq!(col_values(&sheet, "A", 2), vec![num(1.0), num(2.0)]);
        // Spill intact.
        assert_eq!(sheet.get_cell("D2"), num(2.0));
    }

    #[test]
    fn empty_keys_rejected() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(1.0));
        assert_eq!(
            sheet.sort_range(range("A1", "A2"), &[], &[]),
            Err(SortRangeError::EmptyKeys)
        );
    }

    #[test]
    fn key_outside_range_columns_rejected() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(1.0));
        assert_eq!(
            sheet.sort_range(range("A1", "B2"), &[asc(5)], &[]),
            Err(SortRangeError::KeyOutOfRange)
        );
    }

    #[test]
    fn range_past_excel_grid_rejected() {
        let mut sheet = Sheet::new();
        let bad = CellRange::new(CellAddress::new(0, 0), CellAddress::new(2_000_000, 0));
        assert_eq!(
            sheet.sort_range(bad, &[asc(0)], &[]),
            Err(SortRangeError::InvalidRange)
        );
    }

    // === No-op, row heights, outside cells, notifications ===

    #[test]
    fn noop_sort_writes_nothing_and_notifies_nobody() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(1.0));
        sheet.set_cell("A2", num(2.0));
        let fires = Rc::new(RefCell::new(0));
        for a in ["A1", "A2"] {
            let f = fires.clone();
            sheet.subscribe_cell(a, move || *f.borrow_mut() += 1);
        }

        let report = sheet.sort_range(range("A1", "A2"), &[asc(0)], &[]).unwrap();
        assert_eq!(report, SortRangeReport::default());
        assert_eq!(*fires.borrow(), 0);
    }

    #[test]
    fn row_heights_do_not_move_with_sorted_rows() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(2.0));
        sheet.set_cell("A2", num(1.0));
        sheet.set_row_height(0, 42);
        sheet.set_row_height(1, 7);

        sheet.sort_range(range("A1", "A2"), &[asc(0)], &[]).unwrap();
        // Rows swapped, heights stayed (Excel behavior).
        assert_eq!(sheet.get_cell("A1"), num(1.0));
        assert_eq!(sheet.row_height(0), Some(42));
        assert_eq!(sheet.row_height(1), Some(7));
    }

    #[test]
    fn cells_outside_range_are_untouched_and_only_changed_cells_notify() {
        let mut sheet = Sheet::new();
        // A1 keeps its value (already minimal); A2/A3 swap.
        sheet.set_cell("A1", num(1.0));
        sheet.set_cell("A2", num(3.0));
        sheet.set_cell("A3", num(2.0));
        sheet.set_cell("D1", num(99.0)); // outside

        let unchanged = Rc::new(RefCell::new(0));
        let changed = Rc::new(RefCell::new(0));
        let outside = Rc::new(RefCell::new(0));
        {
            let c = unchanged.clone();
            sheet.subscribe_cell("A1", move || *c.borrow_mut() += 1);
        }
        {
            let c = changed.clone();
            sheet.subscribe_cell("A2", move || *c.borrow_mut() += 1);
        }
        {
            let c = outside.clone();
            sheet.subscribe_cell("D1", move || *c.borrow_mut() += 1);
        }

        let report = sheet.sort_range(range("A1", "A3"), &[asc(0)], &[]).unwrap();
        assert_eq!(report.moved_rows, 2);
        assert_eq!(report.row_permutation, vec![(1, 2), (2, 1)]);
        assert_eq!(sheet.get_cell("D1"), num(99.0));
        assert_eq!(*unchanged.borrow(), 0, "value-stable slot must not fire");
        assert_eq!(*changed.borrow(), 1, "changed slot fires exactly once");
        assert_eq!(*outside.borrow(), 0, "outside the range must not fire");
    }

    #[test]
    fn moved_cells_counts_content_cells_in_moved_rows_only() {
        let mut sheet = Sheet::new();
        sheet.set_cell("A1", num(1.0)); // stays (slot 0 keeps row 0)
        sheet.set_cell("B1", text("stay"));
        sheet.set_cell("A2", num(3.0));
        sheet.set_cell("A3", num(2.0));
        sheet.set_cell("B3", text("move"));

        let report = sheet.sort_range(range("A1", "B3"), &[asc(0)], &[]).unwrap();
        // Rows 1 and 2 move; content cells there: A2, A3, B3.
        assert_eq!(report.moved_rows, 2);
        assert_eq!(report.moved_cells, 3);
    }

    // === Workbook entry point ===

    #[test]
    fn workbook_sort_range_delegates_and_validates_sheet_index() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        let s1 = wb.add_sheet("Sheet2");
        wb.set_cell(s0, "A1", num(2.0));
        wb.set_cell(s0, "A2", num(1.0));
        // Cross-sheet observer on the other sheet.
        assert!(wb.set_formula(s1, "A1", "=Sheet1!A1"));
        assert_eq!(wb.get_cell("Sheet2", "A1"), num(2.0));

        let report = wb
            .sort_range(s0, range("A1", "A2"), &[asc(0)], &[])
            .unwrap();
        assert_eq!(report.moved_rows, 2);
        assert_eq!(wb.get_cell("Sheet1", "A1"), num(1.0));
        // Cross-sheet formula recomputes through the shared store.
        assert_eq!(wb.get_cell("Sheet2", "A1"), num(1.0));

        assert_eq!(
            wb.sort_range(99, range("A1", "A2"), &[asc(0)], &[]),
            Err(SortRangeError::InvalidRange)
        );
    }

    // === Pure helper coverage ===

    #[test]
    fn subtract_range_produces_disjoint_cover() {
        let a = range("A1", "D5");
        let b = range("B2", "C4");
        let pieces = subtract_range(a, b);
        assert_eq!(pieces.len(), 4);
        let mut area = 0u32;
        for p in &pieces {
            area += p.cell_count();
            assert!(!ranges_intersect(*p, b), "piece {p:?} overlaps the hole");
            for q in &pieces {
                if p != q {
                    assert!(!ranges_intersect(*p, *q), "pieces overlap: {p:?} {q:?}");
                }
            }
        }
        assert_eq!(area, a.cell_count() - b.cell_count());
    }

    #[test]
    fn subtract_range_full_containment_removes_layer() {
        let a = range("B2", "C3");
        let b = range("A1", "D5");
        assert!(subtract_range(a, b).is_empty());
    }
}
