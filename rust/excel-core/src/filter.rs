//! Engine-owned column filter — E3 of
//! `solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md`.
//!
//! This module is the Rust half of a CROSS-LANGUAGE PORT, not a fresh
//! design. Every function here has a named TypeScript original in
//! `vanilla/spreadsheet-ui-core/src/backend/projection-helpers.ts`, and the
//! contract of this slice is that the two agree on every input the product
//! can produce. Where the original does something surprising it is copied
//! surprise and all; the divergences worth naming are called out inline:
//!
//!   - [`js_numeric_value`] reproduces JavaScript's `Number(string)`, which
//!     is NOT `str::parse::<f64>()`. `Number("")` is `0`, not an error;
//!     `Number("0x10")` is 16; `Number(" 12 ")` is 12; `Number("Infinity")`
//!     is infinite and therefore rejected by the `Number.isFinite` guard,
//!     while Rust's parser would happily accept `"inf"` and `"NaN"`.
//!   - [`ColumnFilterRule::List`] compares the RAW string, while `Equals`
//!     case-folds by default. That inconsistency is real product behaviour
//!     (`projection-helpers.ts:96-97` vs `:110`); "fixing" it here would be
//!     a silent behaviour change, so it is preserved verbatim.
//!   - [`js_trim`] is JavaScript's whitespace set, which differs from
//!     `char::is_whitespace` at exactly two code points (U+0085 and
//!     U+FEFF).
//!
//! The value the predicate compares against is [`crate::value_to_display`],
//! which is the same function the wasm `readSparseRange` boundary uses to
//! build the `display` string the TypeScript predicate reads TODAY. That is
//! what makes the port behaviour-preserving on the worker path: same bytes
//! in, same predicate, same answer.

use std::collections::BTreeSet;

/// One column filter condition, the Rust twin of the TypeScript wire type
/// `ColumnFilterRule` (`vanilla/spreadsheet-ui-core/src/filter-sort/types.ts:12-16`).
///
/// Four kinds, no more: the union is closed on the TypeScript side and the
/// dropdown UI can only build these. `case_sensitive` collapses the wire's
/// optional `caseSensitive?: boolean` — absent and `false` behave
/// identically there (`caseSensitive ? value : value.toLocaleLowerCase()`),
/// so a plain `bool` loses nothing.
#[derive(Clone, Debug, PartialEq)]
pub enum ColumnFilterRule {
    /// Whole-value equality, case-folded unless `case_sensitive`.
    Equals {
        col_index: u32,
        value: String,
        case_sensitive: bool,
    },
    /// Substring containment, case-folded unless `case_sensitive`.
    Contains {
        col_index: u32,
        value: String,
        case_sensitive: bool,
    },
    /// Inclusive numeric band. A non-numeric cell never matches. Either
    /// bound may be absent, which makes that side unbounded.
    Range {
        col_index: u32,
        min: Option<f64>,
        max: Option<f64>,
    },
    /// Membership in an explicit value list. RAW string comparison — see
    /// the module note about the deliberate inconsistency with `Equals`.
    List { col_index: u32, values: Vec<String> },
}

impl ColumnFilterRule {
    /// The 0-based column this rule reads.
    pub fn col_index(&self) -> u32 {
        match self {
            ColumnFilterRule::Equals { col_index, .. }
            | ColumnFilterRule::Contains { col_index, .. }
            | ColumnFilterRule::Range { col_index, .. }
            | ColumnFilterRule::List { col_index, .. } => *col_index,
        }
    }
}

/// JavaScript's `WhiteSpace ∪ LineTerminator` production, which is what
/// `String.prototype.trim` and `Number(string)` both strip.
///
/// It is NOT `char::is_whitespace` (the Unicode `White_Space` property).
/// The two differ at exactly two code points:
///
///   - U+0085 NEXT LINE — `White_Space`, but NOT JavaScript whitespace.
///   - U+FEFF ZERO WIDTH NO-BREAK SPACE — JavaScript whitespace (it is
///     `<ZWNBSP>` in the spec), but NOT `White_Space`.
///
/// Both matter here: a BOM-prefixed `"\u{feff}Total"` label is a summary
/// row in the product today, and a NEL-prefixed `"\u{85}12"` is NOT the
/// number 12 today. Spelling the set out is how the port keeps both.
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// JavaScript's `Number(string)` composed with `Number.isFinite`, i.e. the
/// TypeScript `numericValue` helper (`projection-helpers.ts:82-85`):
///
/// ```ts
/// export function numericValue(text: string): number | null {
///   const value = Number(text)
///   return Number.isFinite(value) ? value : null
/// }
/// ```
///
/// `str::parse::<f64>()` is NOT a substitute, and the differences are not
/// academic — the first one fires on every empty cell in a filtered column:
///
/// | input        | `Number(x)` | `x.parse::<f64>()` |
/// |--------------|-------------|--------------------|
/// | `""`         | `0`         | `Err`              |
/// | `"  12  "`   | `12`        | `Err`              |
/// | `"0x10"`     | `16`        | `Err`              |
/// | `"0b101"`    | `5`         | `Err`              |
/// | `"Infinity"` | `∞` → `None`| `Err`              |
/// | `"inf"`      | `NaN` → `None` | `Ok(∞)`         |
/// | `"NaN"`      | `NaN` → `None` | `Ok(NaN)`       |
/// | `"1_000"`    | `NaN` → `None` | `Err`           |
///
/// The empty-string row is the one with product consequences: a `range`
/// rule whose band contains zero MATCHES every blank cell in the column
/// today. That is the behaviour being preserved, not endorsed.
///
/// Strategy: validate the JavaScript `StringNumericLiteral` grammar by
/// hand, then delegate the actual decimal-to-binary rounding to Rust's
/// `f64` parser, which is correctly rounded exactly like the JavaScript
/// one. Validation is what keeps `"inf"` / `"NaN"` / `"1_000"` out.
pub fn js_numeric_value(text: &str) -> Option<f64> {
    let value = js_number(text)?;
    if value.is_finite() {
        Some(value)
    } else {
        None
    }
}

/// `Number(string)` proper. `None` stands for `NaN` (the caller cannot
/// tell the difference, since `Number.isFinite(NaN)` is false anyway, but
/// keeping the split makes the grammar readable).
fn js_number(text: &str) -> Option<f64> {
    let s = js_trim(text);
    // `Number("")` and `Number("   ")` are +0, not NaN. This is the row of
    // the table above that actually changes what users see.
    if s.is_empty() {
        return Some(0.0);
    }

    if let Some(rest) = strip_radix_prefix(s, 'x', 'X') {
        return parse_radix(rest, 16);
    }
    if let Some(rest) = strip_radix_prefix(s, 'o', 'O') {
        return parse_radix(rest, 8);
    }
    if let Some(rest) = strip_radix_prefix(s, 'b', 'B') {
        return parse_radix(rest, 2);
    }

    let (negative, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };

    // `Infinity` is spelled exactly that way — case-sensitively, and only
    // that word. `inf`, `INFINITY` and `NaN` are all plain NaN in JS.
    if body == "Infinity" {
        return Some(if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    if !is_js_decimal_literal(body) {
        return None;
    }
    let parsed: f64 = body.parse().ok()?;
    Some(if negative { -parsed } else { parsed })
}

fn strip_radix_prefix<'a>(s: &'a str, lower: char, upper: char) -> Option<&'a str> {
    let rest = s.strip_prefix('0')?;
    let mut chars = rest.chars();
    let marker = chars.next()?;
    if marker == lower || marker == upper {
        Some(chars.as_str())
    } else {
        None
    }
}

/// `NonDecimalIntegerLiteral`. No sign is permitted (`Number("-0x10")` is
/// NaN), and at least one digit is required (`Number("0x")` is NaN).
/// Accumulating in `f64` matches the spec's "mathematical value, then
/// rounded" only up to 2^53; beyond that the last ulp can differ. Cells
/// whose DISPLAY string is a >53-bit hex literal are not a shape this
/// product produces, and the alternative — arbitrary-precision integer
/// parsing — would be a lot of machinery for that.
fn parse_radix(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let mut acc = 0f64;
    for c in digits.chars() {
        let d = c.to_digit(radix)?;
        acc = acc * f64::from(radix) + f64::from(d);
    }
    Some(acc)
}

/// The unsigned `StrUnsignedDecimalLiteral` grammar minus `Infinity`:
/// `digits[.digits][e[±]digits]`, `.digits[e[±]digits]`, or
/// `digits.[e[±]digits]`. At least one mantissa digit; a bare `"."`,
/// a dangling `"1e"` and an underscore-separated `"1_000"` are all NaN.
fn is_js_decimal_literal(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut i = 0;
    let mut mantissa_digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        mantissa_digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            mantissa_digits += 1;
        }
    }
    if mantissa_digits == 0 {
        return false;
    }
    if i == bytes.len() {
        return true;
    }
    if bytes[i] != b'e' && bytes[i] != b'E' {
        return false;
    }
    i += 1;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let exponent_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    i > exponent_start && i == bytes.len()
}

/// `normalizeFilterText` (`projection-helpers.ts:87-89`).
///
/// JavaScript's `toLocaleLowerCase()` with no locale argument uses the
/// host default locale; `str::to_lowercase` is the locale-INDEPENDENT
/// Unicode default casing. They agree on everything the default (root /
/// en) locale does, including the two cases people expect to differ:
/// final sigma (`"ΟΔΟΣ"` → `"οδος"`) and dotted capital I (`"İ"` →
/// `"i\u{307}"`). They would diverge under a Turkish host locale, which
/// is a pre-existing property of the TypeScript side, not something this
/// port introduces — see the commit message for the measured corpus.
fn normalize_filter_text(value: &str, case_sensitive: bool) -> std::borrow::Cow<'_, str> {
    if case_sensitive {
        std::borrow::Cow::Borrowed(value)
    } else {
        std::borrow::Cow::Owned(value.to_lowercase())
    }
}

/// `filterRuleMatchesValue` (`projection-helpers.ts:91-112`), verbatim.
pub fn filter_rule_matches_value(rule: &ColumnFilterRule, value: &str) -> bool {
    match rule {
        ColumnFilterRule::Equals {
            value: needle,
            case_sensitive,
            ..
        } => {
            normalize_filter_text(value, *case_sensitive)
                == normalize_filter_text(needle, *case_sensitive)
        }
        ColumnFilterRule::Contains {
            value: needle,
            case_sensitive,
            ..
        } => normalize_filter_text(value, *case_sensitive)
            .contains(normalize_filter_text(needle, *case_sensitive).as_ref()),
        ColumnFilterRule::Range { min, max, .. } => {
            let Some(numeric) = js_numeric_value(value) else {
                return false;
            };
            if let Some(min) = min {
                if numeric < *min {
                    return false;
                }
            }
            if let Some(max) = max {
                if numeric > *max {
                    return false;
                }
            }
            true
        }
        // RAW comparison, deliberately NOT case-folded — see the module
        // note. `Equals` and `List` disagree about case in the product
        // today and the golden parity corpus pins that disagreement.
        ColumnFilterRule::List { values, .. } => values.iter().any(|candidate| candidate == value),
    }
}

/// `isFilterSortSummaryRow` (`projection-helpers.ts:340-346`).
///
/// A PRODUCT HEURISTIC, not filter semantics: the last scanned row is
/// pinned permanently visible when its column-0 label trims and lower-cases
/// to `total` or `summary`. `row > 1` keeps a two-row sheet's only data row
/// from being mistaken for a summary. `label` is the column-0 display
/// string of `row`, which is why column 0 is always in the predicate
/// column set even when no rule reads it.
pub fn is_filter_sort_summary_row(label: &str, row: u32) -> bool {
    let label = js_trim(label).to_lowercase();
    row > 1 && (label == "total" || label == "summary")
}

/// `rowMatchesFilterSortRules` (`projection-helpers.ts:348-358`): every
/// rule must pass (AND). An empty rule list matches everything, which is
/// why "no rules" and "nothing hidden" are the same state.
pub fn row_matches_rules(rules: &[ColumnFilterRule], read_value: impl Fn(u32) -> String) -> bool {
    rules
        .iter()
        .all(|rule| filter_rule_matches_value(rule, &read_value(rule.col_index())))
}

/// The engine's stored per-sheet AutoFilter: the RULES plus the row set
/// they DERIVED when they were last applied.
///
/// Keeping the derived set next to the rules rather than recomputing it on
/// demand is the whole point of the snapshot semantics (#27): filter
/// visibility is taken once, when the rules are applied, and does not
/// follow later cell edits. A getter that re-ran the predicate would be
/// live by construction; a stored set cannot be.
///
/// The design sketch also carried an `autoFilter` `range`. It is omitted:
/// nothing in the product produces one (the wire request is `{ rules }`
/// and nothing else), the scan extent is derived exactly the way the host
/// derives it today, and an unused field would still have to be given
/// persistence and displacement semantics. See the commit message.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SheetAutoFilter {
    rules: Vec<ColumnFilterRule>,
    hidden: BTreeSet<u32>,
}

impl SheetAutoFilter {
    pub(crate) fn new(rules: Vec<ColumnFilterRule>, hidden: BTreeSet<u32>) -> Self {
        SheetAutoFilter { rules, hidden }
    }

    /// The committed rules.
    pub fn rules(&self) -> &[ColumnFilterRule] {
        &self.rules
    }

    /// The rows those rules hid, ascending.
    pub fn hidden_rows(&self) -> Vec<u32> {
        self.hidden.iter().copied().collect()
    }

    pub(crate) fn hidden_set(&self) -> &BTreeSet<u32> {
        &self.hidden
    }

    pub(crate) fn set_hidden(&mut self, hidden: BTreeSet<u32>) {
        self.hidden = hidden;
    }

    pub(crate) fn hidden_set_mut(&mut self) -> &mut BTreeSet<u32> {
        &mut self.hidden
    }
}

/// Outcome of a completed [`crate::Workbook::apply_filter`] /
/// `reapply_filter` / `clear_filter`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FilterApplyReport {
    /// The rows the committed rules hid, ascending. Empty when no rule is
    /// active — which is the same statement as "the rules hid nothing",
    /// exactly as the TypeScript `hiddenRowIndices` contract says.
    pub hidden_rows: Vec<u32>,
    /// Rows the predicate scan covered, i.e. `max_non_empty_row + 1`. Rows
    /// at or beyond it were never judged and are never reported hidden.
    pub scanned_rows: u32,
    /// `scanned_rows * predicate_columns` — the number the budget gate
    /// below measures.
    pub predicate_cells: u32,
}

/// Rejections from the filter entry points. Structured rather than
/// stringly, and surfaced to JS through the `{ ok: false, code, message }`
/// convention `sortRange` established (`rust/wasm/src/lib.rs`
/// § "Engine physical sort wire").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterError {
    /// `sheet_index` is not a sheet.
    InvalidSheet,
    /// A custom-formula callback tried to mutate the workbook it is being
    /// evaluated inside. Mirrors `TableError::MutationDuringCustomCall`.
    MutationDuringCustomCall,
    /// The predicate scan would exceed [`MAX_FILTER_PREDICATE_CELLS`].
    /// NOTHING is mutated: the filter does not activate, no rules are
    /// stored, and the previous visibility stands. Truncating instead
    /// would silently show a wrong answer.
    SourceTooLarge {
        rows: u32,
        columns: u32,
        predicate_cells: u32,
    },
}

/// Predicate-scan budget, sunk from the host adapter
/// (`solid/excel/src-vnext/adapter/worker-workbook-backend.ts:211`
/// `MAX_FILTER_SORT_PREDICATE_CELLS`, whose rejection code is
/// `FILTER_SORT_SOURCE_TOO_LARGE`). Same 50k budget as
/// `DEFAULT_MAX_PROJECTION_CELLS` and
/// `STATUS_BAR_AGGREGATE_MEMBERSHIP_CHECKS_MAX` in ui-core.
///
/// The measured quantity is `scanned_rows * predicate_columns`, where the
/// predicate columns are column 0 (the summary-row probe) plus every
/// distinct rule column — the host's arithmetic, transcribed. Crossing it
/// is a rejection, strictly greater than, so exactly 50 000 is allowed.
pub const MAX_FILTER_PREDICATE_CELLS: u32 = 50_000;

/// The distinct columns one scan has to read: column 0 for the
/// summary-row probe, plus every rule's column. Twin of the adapter's
/// `filterSortPredicateColumns`.
pub(crate) fn predicate_columns(rules: &[ColumnFilterRule]) -> BTreeSet<u32> {
    let mut cols = BTreeSet::new();
    cols.insert(0);
    for rule in rules {
        cols.insert(rule.col_index());
    }
    cols
}

/// The visibility answer for one scanned extent, given a value reader.
///
/// This is `buildFilterSortDisplayRows` (`projection-helpers.ts:373-410`)
/// composed with `filterHiddenRowsFromDisplayRows`
/// (`solid/excel/src-vnext/adapter/filter-hidden-rows.ts:36-56`) — the two
/// halves both adapters already run back to back — collapsed into the one
/// projection they actually want. The intermediate sparse `display ->
/// source` permutation is dropped because it is provably irrelevant to the
/// composition: it is only ever consumed as a SET, its header slot is
/// index 0 while data compaction starts at index 1, and the summary slot
/// `max_row` can never be overwritten by compaction (at most `max_row - 1`
/// data rows compete for slots `1..=max_row - 1`).
///
/// Layout is the host's, fixed: header row 0, data rows `1..=max_row`,
/// summary row (if any) at `max_row`.
pub(crate) fn hidden_rows_for_scan(
    rules: &[ColumnFilterRule],
    scanned_rows: u32,
    read_value: impl Fn(u32, u32) -> String,
) -> BTreeSet<u32> {
    // No rules is not "hide nothing after a scan" — it is "no scan
    // happened", which `buildFilterSortDisplayRows` signals by returning
    // `null` before it looks at anything.
    if rules.is_empty() || scanned_rows == 0 {
        return BTreeSet::new();
    }
    let max_row = scanned_rows - 1;
    // A single-row extent is the header alone; there is nothing to judge.
    if max_row < 1 {
        return BTreeSet::new();
    }

    let has_summary = is_filter_sort_summary_row(&read_value(max_row, 0), max_row);
    let last_data_row = if has_summary { max_row - 1 } else { max_row };

    let mut hidden = BTreeSet::new();
    for row in 1..=last_data_row {
        if !row_matches_rules(rules, |col| read_value(row, col)) {
            hidden.insert(row);
        }
    }
    hidden
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_matches_javascript_on_the_shapes_rust_would_disagree_about() {
        // Every row here was produced by running `Number(x)` in node; see
        // the commit message for the full 7 700-case corpus run.
        assert_eq!(js_numeric_value(""), Some(0.0));
        assert_eq!(js_numeric_value("   "), Some(0.0));
        assert_eq!(js_numeric_value("\u{a0}"), Some(0.0));
        assert_eq!(js_numeric_value("\u{feff}"), Some(0.0));
        // U+0085 is Unicode White_Space but NOT JavaScript whitespace.
        assert_eq!(js_numeric_value("\u{85}"), None);
        assert_eq!(js_numeric_value(" 12 "), Some(12.0));
        assert_eq!(js_numeric_value("0x10"), Some(16.0));
        assert_eq!(js_numeric_value("0b101"), Some(5.0));
        assert_eq!(js_numeric_value("0o17"), Some(15.0));
        assert_eq!(
            js_numeric_value("-0x10"),
            None,
            "a sign voids the radix form"
        );
        assert_eq!(js_numeric_value("0x"), None);
        assert_eq!(js_numeric_value(".5"), Some(0.5));
        assert_eq!(js_numeric_value("5."), Some(5.0));
        assert_eq!(js_numeric_value("."), None);
        assert_eq!(js_numeric_value("+5"), Some(5.0));
        assert_eq!(js_numeric_value("1e3"), Some(1000.0));
        assert_eq!(js_numeric_value("1e-3"), Some(0.001));
        assert_eq!(js_numeric_value("1e"), None);
        assert_eq!(js_numeric_value("1e999"), None, "overflows to Infinity");
        assert_eq!(js_numeric_value("Infinity"), None);
        assert_eq!(js_numeric_value("-Infinity"), None);
        // Rust's own parser accepts all four of these; JavaScript does not.
        assert_eq!(js_numeric_value("inf"), None);
        assert_eq!(js_numeric_value("infinity"), None);
        assert_eq!(js_numeric_value("NaN"), None);
        assert_eq!(js_numeric_value("1_000"), None);
        assert_eq!(js_numeric_value("1,000"), None);
    }

    #[test]
    fn js_trim_uses_the_javascript_whitespace_set() {
        assert_eq!(js_trim("\u{feff} total \u{feff}"), "total");
        assert_eq!(js_trim("\u{85}total"), "\u{85}total");
        assert!(is_filter_sort_summary_row("\u{feff}Total ", 5));
        assert!(!is_filter_sort_summary_row("\u{85}Total", 5));
    }

    #[test]
    fn list_does_not_case_fold_but_equals_does() {
        let list = ColumnFilterRule::List {
            col_index: 0,
            values: vec!["abc".into()],
        };
        let equals = ColumnFilterRule::Equals {
            col_index: 0,
            value: "abc".into(),
            case_sensitive: false,
        };
        assert!(!filter_rule_matches_value(&list, "ABC"));
        assert!(filter_rule_matches_value(&equals, "ABC"));
    }

    #[test]
    fn a_blank_cell_is_zero_for_a_range_rule() {
        // The empty-string consequence spelled out: a band containing 0
        // keeps every blank row visible, a band excluding 0 hides them.
        let containing_zero = ColumnFilterRule::Range {
            col_index: 0,
            min: Some(-1.0),
            max: Some(1.0),
        };
        let excluding_zero = ColumnFilterRule::Range {
            col_index: 0,
            min: Some(1.0),
            max: None,
        };
        assert!(filter_rule_matches_value(&containing_zero, ""));
        assert!(!filter_rule_matches_value(&excluding_zero, ""));
    }

    #[test]
    fn the_summary_row_needs_row_index_above_one() {
        assert!(!is_filter_sort_summary_row("Total", 0));
        assert!(!is_filter_sort_summary_row("Total", 1));
        assert!(is_filter_sort_summary_row("Total", 2));
        assert!(!is_filter_sort_summary_row("Subtotal", 2));
    }
}
