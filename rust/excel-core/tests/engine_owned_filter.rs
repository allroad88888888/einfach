//! E3 of `design-engine-hidden-rows.md` — the engine OWNS the filter RULES
//! and evaluates the PREDICATE itself.
//!
//! Before this slice the engine had no idea a filter existed. The host
//! scanned the predicate columns over RPC, ran a TypeScript predicate, and
//! pushed the resulting row set in through `set_eval_filter_hidden_rows`,
//! which the engine stored as opaque evaluation input for the two SUBTOTAL
//! layers. E3 moves the rules, the predicate and the derived set into
//! `Sheet`, keeping the host port byte-identical so the product's behaviour
//! is unchanged: the host is still the WRITER, the engine has become the
//! authoritative STORE.
//!
//! Two properties get most of the attention here, because they are the two
//! that a plausible implementation gets wrong:
//!
//!  1. **Snapshot, not live.** #27 ruled that editing a cell does NOT
//!     recompute visibility (`Data -> Reapply` is the refresh path). The
//!     engine is the layer that knows soonest when a cell changed, so it is
//!     the layer most likely to helpfully recompute. `debug_filter_scan_count`
//!     is the observable that makes "it did not recompute" checkable.
//!  2. **Imperative, not derived.** A derived atom over the predicate
//!     columns would close a real dependency cycle through `SUBTOTAL`
//!     (design §2.2). The scan therefore runs behind an eager read that
//!     registers no Store edge, and commits afterwards — so a `SUBTOTAL`
//!     sitting IN a predicate column resolves against the PREVIOUS filter
//!     set, exactly as both host adapters already arrange.
//!
//! Counterexample discipline: every case that can fail on a NUMBER rather
//! than on a missing symbol does.

use einfach_core::Value;
use einfach_excel_core::{
    filter_rule_matches_value, is_filter_sort_summary_row, js_numeric_value, ColumnFilterRule,
    FilterError, FilterSnapshot, SheetFilterState, Workbook,
};

// ===================== golden corpus vs the TypeScript original ===========

/// The corpus was produced by running the AUTHORITATIVE host predicate —
/// `solid/excel/src-vnext/adapter/filter-predicate.ts`, plus `numericValue`
/// from `spreadsheet-ui-core/src/backend/projection-helpers.ts` — under node
/// over 77 values x 100 rules. It is the answer the product gives today; the
/// Rust port has to reproduce all 7 700 of them plus 308 summary-row probes
/// and 77 `Number()` conversions.
///
/// This is the gate that catches a "tidy-up". Two behaviours in the original
/// look like bugs and are not:
///
///  - `list` compares RAW strings while `equals` case-folds by default.
///  - `range` on a non-numeric cell is `false`, and `Number("")` is `0`, so
///    a band containing zero MATCHES every blank cell.
///
/// Both are pinned below by real corpus rows, not by prose.
const CORPUS: &str = include_str!("fixtures/filter_predicate_corpus.txt");

fn unescape(field: &str) -> String {
    let mut out = String::new();
    let mut units: Vec<u16> = Vec::new();
    let mut chars = field.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            if !units.is_empty() {
                out.push_str(&String::from_utf16_lossy(&units));
                units.clear();
            }
            out.push(c);
            continue;
        }
        match chars.next().expect("dangling escape") {
            '\\' => {
                if !units.is_empty() {
                    out.push_str(&String::from_utf16_lossy(&units));
                    units.clear();
                }
                out.push('\\');
            }
            'u' => {
                let hex: String = (0..4).map(|_| chars.next().expect("short \\u")).collect();
                units.push(u16::from_str_radix(&hex, 16).expect("bad \\u"));
            }
            other => panic!("unknown escape \\{other}"),
        }
    }
    if !units.is_empty() {
        out.push_str(&String::from_utf16_lossy(&units));
    }
    out
}

fn f64_from_hex(field: &str) -> Option<f64> {
    if field == "-" {
        return None;
    }
    Some(f64::from_bits(
        u64::from_str_radix(field, 16).expect("bad f64 bits"),
    ))
}

fn assert_bits(bits: &str, values: &[String], label: &str, actual: impl Fn(&str) -> bool) {
    assert_eq!(
        bits.len(),
        values.len(),
        "{label}: corpus bit string length must match the V table"
    );
    for (bit, value) in bits.chars().zip(values.iter()) {
        let expected = bit == '1';
        assert_eq!(
            actual(value),
            expected,
            "{label} against {value:?}: the TypeScript original answers {expected}"
        );
    }
}

#[test]
fn the_rust_predicate_reproduces_the_typescript_predicate_on_the_whole_corpus() {
    let mut values: Vec<String> = Vec::new();
    let mut rule_cases = 0usize;
    let mut summary_cases = 0usize;
    let mut number_cases = 0usize;

    for line in CORPUS.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[0] {
            "V" => values.push(unescape(fields[1])),
            "E" | "C" => {
                let case_sensitive = fields[1] == "1";
                let needle = unescape(fields[2]);
                let rule = if fields[0] == "E" {
                    ColumnFilterRule::Equals {
                        col_index: 0,
                        value: needle.clone(),
                        case_sensitive,
                    }
                } else {
                    ColumnFilterRule::Contains {
                        col_index: 0,
                        value: needle.clone(),
                        case_sensitive,
                    }
                };
                assert_bits(
                    fields[3],
                    &values,
                    &format!("{} {:?} cs={}", fields[0], needle, case_sensitive),
                    |v| filter_rule_matches_value(&rule, v),
                );
                rule_cases += values.len();
            }
            "R" => {
                let rule = ColumnFilterRule::Range {
                    col_index: 0,
                    min: f64_from_hex(fields[1]),
                    max: f64_from_hex(fields[2]),
                };
                assert_bits(fields[3], &values, "range", |v| {
                    filter_rule_matches_value(&rule, v)
                });
                rule_cases += values.len();
            }
            "L" => {
                let count: usize = fields[1].parse().expect("list count");
                let listed: Vec<String> = (0..count).map(|i| unescape(fields[2 + i])).collect();
                let rule = ColumnFilterRule::List {
                    col_index: 0,
                    values: listed.clone(),
                };
                assert_bits(fields[2 + count], &values, "list", |v| {
                    filter_rule_matches_value(&rule, v)
                });
                rule_cases += values.len();
            }
            "S" => {
                let row: u32 = fields[1].parse().expect("summary row");
                assert_bits(fields[2], &values, "summary", |v| {
                    is_filter_sort_summary_row(v, row)
                });
                summary_cases += values.len();
            }
            "N" => {
                for (field, value) in fields[1].split(',').zip(values.iter()) {
                    assert_eq!(
                        js_numeric_value(value),
                        f64_from_hex(field),
                        "Number({value:?})"
                    );
                    number_cases += 1;
                }
            }
            other => panic!("unknown corpus record {other:?}"),
        }
    }

    assert_eq!(values.len(), 77, "corpus value table");
    assert_eq!(rule_cases, 7_700, "predicate cases");
    assert_eq!(summary_cases, 308, "summary-row cases");
    assert_eq!(number_cases, 77, "Number() cases");
}

// ===================== engine fixtures =====================

/// Header at row 0, four data rows, quantities in column B.
///
/// ```text
///      A          B
/// 0    Name       Qty
/// 1    apple      1
/// 2    banana     2
/// 3    avocado    3
/// 4    cherry     4
/// ```
fn produce_sheet() -> Workbook {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("Name".into()));
    wb.set_cell(0, "B1", Value::Text("Qty".into()));
    for (i, name) in ["apple", "banana", "avocado", "cherry"].iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 2), Value::Text((*name).into()));
        wb.set_cell(0, &format!("B{}", i + 2), Value::Number((i + 1) as f64));
    }
    wb
}

fn contains(col: u32, needle: &str) -> ColumnFilterRule {
    ColumnFilterRule::Contains {
        col_index: col,
        value: needle.into(),
        case_sensitive: false,
    }
}

fn num(wb: &Workbook, addr: &str) -> f64 {
    match wb.get_cell("Sheet1", addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {addr}, got {other:?}"),
    }
}

// ===================== the predicate, end to end =====================

#[test]
fn apply_filter_hides_the_rows_the_rules_reject_and_never_the_header() {
    let mut wb = produce_sheet();
    let report = wb.apply_filter(0, &[contains(0, "a")]).expect("apply");

    // apple / banana / avocado contain "a"; cherry does not. Row 0 is the
    // header and is pinned visible even though "Name" contains no "a".
    assert_eq!(report.hidden_rows, vec![4]);
    assert_eq!(report.scanned_rows, 5);
    assert_eq!(report.predicate_cells, 5, "1 predicate column x 5 rows");
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    assert_eq!(wb.filter_rules(0), vec![contains(0, "a")]);
}

#[test]
fn every_rule_must_pass_and_a_second_column_widens_the_budget() {
    let mut wb = produce_sheet();
    let report = wb
        .apply_filter(
            0,
            &[
                contains(0, "a"),
                ColumnFilterRule::Range {
                    col_index: 1,
                    min: Some(2.0),
                    max: None,
                },
            ],
        )
        .expect("apply");

    // apple(1) fails the range, cherry fails the substring; banana(2) and
    // avocado(3) pass both.
    assert_eq!(report.hidden_rows, vec![1, 4]);
    assert_eq!(
        report.predicate_cells, 10,
        "columns 0 and 1 x 5 rows — column 0 is always scanned for the summary probe"
    );
}

#[test]
fn a_trailing_total_row_is_pinned_visible_even_when_no_rule_matches_it() {
    let mut wb = produce_sheet();
    wb.set_cell(0, "A6", Value::Text("Total".into()));
    wb.set_cell(0, "B6", Value::Number(10.0));

    let report = wb.apply_filter(0, &[contains(0, "zzz")]).expect("apply");

    // Everything is rejected, yet row 5 survives: `isFilterSortSummaryRow`
    // pins the last scanned row when its column-0 label trims and
    // lower-cases to "total" or "summary". This is a product heuristic, not
    // filter semantics, and dropping it would silently filter away every
    // summary line in the product.
    assert_eq!(report.hidden_rows, vec![1, 2, 3, 4]);
    assert_eq!(report.scanned_rows, 6);
}

#[test]
fn a_blank_cell_is_zero_for_a_range_rule_end_to_end() {
    // The `Number("") === 0` consequence, reached through a real sheet
    // rather than through the predicate helper: B5 is never written, so the
    // scan reads "" for it.
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("H".into()));
    wb.set_cell(0, "B2", Value::Number(5.0));
    wb.set_cell(0, "B3", Value::Number(-5.0));
    wb.set_cell(0, "A4", Value::Text("no B here".into()));

    let hidden = wb
        .apply_filter(
            0,
            &[ColumnFilterRule::Range {
                col_index: 1,
                min: Some(-1.0),
                max: Some(1.0),
            }],
        )
        .expect("apply")
        .hidden_rows;
    assert_eq!(hidden, vec![1, 2], "the blank row 3 matches the band via 0");
}

// ===================== snapshot semantics (#27) =====================

/// **Counterexample.** Editing a cell must NOT recompute visibility.
///
/// #27 ruled this deliberately: the pre-#27 implementation recomputed the
/// permutation on every revision bump, which made our filter *more live
/// than Excel's* — a divergence, not a feature. The engine is the layer
/// that knows first when a cell changed, so it is the layer most tempted to
/// be helpful here.
///
/// Fails on a live implementation with a WRONG SET (`[1, 4]` instead of
/// `[4]`) and a WRONG COUNT (2 scans instead of 1), not with an error.
#[test]
fn editing_a_predicate_cell_does_not_recompute_visibility() {
    let mut wb = produce_sheet();
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    let scans = wb.debug_filter_scan_count(0);
    assert_eq!(scans, 1);

    // "apple" -> "plum": row 1 would no longer match the rule.
    wb.set_cell(0, "A2", Value::Text("plum".into()));

    assert_eq!(
        wb.filter_hidden_rows(0),
        vec![4],
        "visibility is a snapshot taken when the rules were applied"
    );
    assert_eq!(
        wb.debug_filter_scan_count(0),
        scans,
        "a cell write must not re-run the predicate"
    );

    // `Data -> Reapply` is the sanctioned refresh path, and it does move.
    let report = wb.reapply_filter(0).expect("reapply");
    assert_eq!(report.hidden_rows, vec![1, 4]);
    assert_eq!(wb.debug_filter_scan_count(0), scans + 1);
}

/// A structural edit DISPLACES the remembered set; it does not re-derive
/// it. Same distinction as above, on the other hot path.
#[test]
fn inserting_a_row_displaces_the_filter_set_without_re_running_the_predicate() {
    let mut wb = produce_sheet();
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    let scans = wb.debug_filter_scan_count(0);

    wb.insert_rows(0, 0, 1); // a new row 0 pushes everything down

    assert_eq!(wb.filter_hidden_rows(0), vec![5]);
    assert_eq!(
        wb.debug_filter_scan_count(0),
        scans,
        "structural edits displace, never re-derive"
    );
    assert_eq!(
        wb.filter_rules(0),
        vec![contains(0, "a")],
        "rules untouched"
    );

    // Deleting the band a hidden row sits in removes it entirely.
    wb.delete_rows(0, 5, 1);
    assert!(wb.filter_hidden_rows(0).is_empty());
    assert_eq!(wb.debug_filter_scan_count(0), scans);
}

// ===================== not a derived atom (design 2.2) =====================

/// **The gate the design names by hand**: `apply_filter` must register no
/// reactive edge.
///
/// Modelling the derived set as an atom over the predicate columns is
/// technically possible and is exactly the trap — it would make the filter
/// live and would close a real cycle through `SUBTOTAL`. The evidence that
/// it did not happen is that a whole apply on a sheet of plain values
/// materializes NO atom at all: an atom-backed derivation could not avoid
/// creating one, and neither could a tracked read of the predicate cells.
#[test]
fn apply_filter_materializes_no_atom_and_holds_no_epoch_edge() {
    let mut wb = produce_sheet();
    // Settle everything the fixture created before measuring.
    let _ = wb.get_cell("Sheet1", "A2");
    let atoms_before = wb.debug_total_atom_count(0);
    let evals_before = wb.debug_formula_eval_count(0);

    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");

    assert_eq!(
        wb.debug_total_atom_count(0),
        atoms_before,
        "the predicate scan must not materialize a single atom — an atom-backed \
         derivation, or a tracked read of the scanned cells, could not manage that"
    );
    assert_eq!(
        wb.debug_formula_eval_count(0),
        evals_before,
        "no formulas on this sheet, so nothing may re-derive"
    );

    // And the derivation holds no edge on either hidden-row epoch: bumping
    // both leaves the committed answer and the scan counter alone.
    let scans = wb.debug_filter_scan_count(0);
    wb.set_eval_hidden_rows(0, &[3]);
    let second = wb.add_sheet("Second");
    wb.set_eval_filter_hidden_rows(second, &[0]);
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    assert_eq!(
        wb.debug_filter_scan_count(0),
        scans,
        "an epoch bump must not re-run the predicate"
    );

    // Non-vacuity guard: the counter above is capable of moving. A formula
    // in a predicate column DOES materialize its facade when the scan reads
    // it — that atom belongs to the formula, not to the derivation, which is
    // exactly why the plain-value assertion is the meaningful one.
    let third = wb.add_sheet("Third");
    wb.set_cell(third, "A1", Value::Text("H".into()));
    wb.set_cell(third, "A2", Value::Number(2.0));
    assert!(wb.set_formula(third, "A3", "=1+1"));
    let atoms = wb.debug_total_atom_count(third);
    wb.apply_filter(third, &[contains(0, "2")]).expect("apply");
    assert!(
        wb.debug_total_atom_count(third) > atoms,
        "the atom counter must be able to move, or the assertion above proves nothing"
    );
}

/// **Counterexample.** A `SUBTOTAL` sitting IN a predicate column is the
/// concrete shape of design §2.2's dependency cycle. The compute-then-commit
/// split makes the scan see the PREVIOUS filter set — the same manoeuvre
/// both host adapters document ("Deliberately the PREVIOUS filter set …
/// which keeps the derivation non-circular on both hosts").
///
/// Fails on a live/derived implementation with a WRONG SET: the scan would
/// see 15 instead of 12 and hide all five data rows.
#[test]
fn a_subtotal_in_a_predicate_column_reads_the_previous_filter_set() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("H".into()));
    for row in 0..5u32 {
        wb.set_cell(0, &format!("A{}", row + 2), Value::Number((row + 1) as f64));
        assert!(wb.set_formula(0, &format!("C{}", row + 2), "=SUBTOTAL(9,A2:A6)"));
    }

    // Round one hides rows 1 and 2 (the values 1 and 2), so the column-C
    // SUBTOTAL settles at 3 + 4 + 5 = 12.
    wb.apply_filter(
        0,
        &[ColumnFilterRule::Range {
            col_index: 0,
            min: Some(3.0),
            max: None,
        }],
    )
    .expect("apply");
    assert_eq!(wb.filter_hidden_rows(0), vec![1, 2]);
    assert_eq!(num(&wb, "C2"), 12.0);

    // Round two filters on column C for the string "12". The rule set is
    // REPLACED, so once it commits nothing is hidden and every SUBTOTAL
    // goes back to 15 — but the scan that produced that answer ran against
    // round one's committed set and therefore read 12.
    let report = wb
        .apply_filter(
            0,
            &[ColumnFilterRule::Equals {
                col_index: 2,
                value: "12".into(),
                case_sensitive: false,
            }],
        )
        .expect("apply");

    assert_eq!(
        report.hidden_rows,
        Vec::<u32>::new(),
        "every row matched, because the scan saw the PREVIOUS filter set (12). \
         A commit-then-scan order reads 15 instead and hides all five data rows"
    );
    assert_eq!(
        num(&wb, "C2"),
        15.0,
        "and the committed world now says 15 — the scan is not a fixed point, by design"
    );
}

// ===================== the two SUBTOTAL layers =====================

#[test]
fn the_owned_filter_set_feeds_subtotal_1_11_and_101_111_the_way_the_push_port_did() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("H".into()));
    for row in 0..5u32 {
        wb.set_cell(0, &format!("A{}", row + 2), Value::Number((row + 1) as f64));
    }
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9,A2:A6)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109,A2:A6)"));
    assert_eq!(num(&wb, "C1"), 15.0);

    wb.hide_rows(0, &[1]); // A2 = 1, manually hidden
    wb.apply_filter(
        0,
        &[ColumnFilterRule::Range {
            col_index: 0,
            min: Some(3.0),
            max: None,
        }],
    )
    .expect("apply");
    assert_eq!(wb.filter_hidden_rows(0), vec![1, 2]);

    // 1-11 excludes filter-hidden rows only; 101-111 excludes both. Row 1
    // is in BOTH sets here, which is why the two answers differ by row 1's
    // value only through the manual half.
    assert_eq!(num(&wb, "C1"), 12.0, "15 - 1 - 2 (filter set)");
    assert_eq!(num(&wb, "C2"), 12.0, "same rows, reached through both sets");

    // Clearing the filter releases rows 1 and 2 from the filter layer; the
    // manual hide of row 1 survives, so the two layers now disagree.
    wb.clear_filter(0).expect("clear");
    assert_eq!(num(&wb, "C1"), 15.0, "1-11 ignores the manual hide");
    assert_eq!(num(&wb, "C2"), 14.0, "101-111 still excludes A2");
}

// ===================== idempotence / the section 3 epoch gate ============

/// **Counterexample.** Re-applying identical rules must re-derive nothing.
///
/// Owning the state puts `republish_hidden` on hot paths, so the
/// de-duplication ledger that used to live in the host has to exist on both
/// halves. Fails without it on a WRONG COUNT: 2 evaluations instead of 1.
#[test]
fn re_applying_identical_rules_re_derives_nothing() {
    let mut wb = produce_sheet();
    assert!(wb.set_formula(0, "D1", "=SUBTOTAL(9,B2:B5)"));
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    assert_eq!(num(&wb, "D1"), 6.0); // cherry (4) hidden

    let before = wb.debug_formula_eval_count(0);
    wb.apply_filter(0, &[contains(0, "a")]).expect("re-apply");
    assert_eq!(num(&wb, "D1"), 6.0);
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before,
        "an identical apply must not dirty the SUBTOTAL formulas"
    );

    // The guard that keeps the case above from passing vacuously.
    wb.apply_filter(0, &[contains(0, "an")]).expect("apply");
    assert_eq!(num(&wb, "D1"), 2.0, "only banana survives");
    assert!(wb.debug_formula_eval_count(0) > before);
}

/// The §3 gate, filter half: a structural edit on a sheet whose filter set
/// does not move must bump NEITHER epoch. Both SUBTOTAL layers read the
/// filter set, so an unconditional republish here would tax every row
/// insert in the workbook with a full re-derivation of every `SUBTOTAL`.
#[test]
fn inserting_a_row_below_everything_bumps_neither_epoch() {
    let mut wb = produce_sheet();
    assert!(wb.set_formula(0, "D1", "=SUBTOTAL(9,B2:B5)"));
    assert!(wb.set_formula(0, "D2", "=SUBTOTAL(109,B2:B5)"));
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    wb.hide_rows(0, &[2]);
    assert_eq!(num(&wb, "D1"), 6.0);
    assert_eq!(num(&wb, "D2"), 4.0);

    let before = wb.debug_formula_eval_count(0);
    wb.insert_rows(0, 100, 1); // far below every hidden row and every formula
    assert_eq!(num(&wb, "D1"), 6.0);
    assert_eq!(num(&wb, "D2"), 4.0);
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before,
        "neither hidden set moved, so neither epoch may fire"
    );
}

// ===================== the 50k budget =====================

#[test]
fn an_over_budget_source_is_rejected_without_mutating_anything() {
    let mut wb = produce_sheet();
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    let scans = wb.debug_filter_scan_count(0);

    // One cell far down makes the scanned extent 50 001 rows. One predicate
    // column (the rule reads column 0, which is also the summary probe), so
    // 50 001 predicate cells — one over.
    wb.set_cell(0, "A50001", Value::Text("far".into()));
    let err = wb.apply_filter(0, &[contains(0, "z")]).unwrap_err();
    assert_eq!(
        err,
        FilterError::SourceTooLarge {
            rows: 50_001,
            columns: 1,
            predicate_cells: 50_001,
        }
    );

    // Rejection means the filter did NOT activate: the previous rules and
    // the previous visibility both stand, and no scan was charged.
    assert_eq!(wb.filter_rules(0), vec![contains(0, "a")]);
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    assert_eq!(wb.debug_filter_scan_count(0), scans);
}

#[test]
fn the_budget_is_strictly_greater_than_so_exactly_50000_is_allowed() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("H".into()));
    wb.set_cell(0, "A50000", Value::Text("edge".into()));
    let report = wb.apply_filter(0, &[contains(0, "edge")]).expect("apply");
    assert_eq!(report.predicate_cells, 50_000);
    assert_eq!(report.scanned_rows, 50_000);
    // Only the last row matched; every other judged row is hidden.
    assert_eq!(report.hidden_rows.len(), 49_998);

    // A second predicate column doubles the cost and crosses the line.
    let err = wb
        .apply_filter(
            0,
            &[ColumnFilterRule::Range {
                col_index: 4,
                min: None,
                max: None,
            }],
        )
        .unwrap_err();
    assert_eq!(
        err,
        FilterError::SourceTooLarge {
            rows: 50_000,
            columns: 2,
            predicate_cells: 100_000,
        }
    );
}

// ===================== rules lifecycle =====================

#[test]
fn applying_an_empty_rule_set_is_the_same_statement_as_clearing() {
    let mut wb = produce_sheet();
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);

    let report = wb.apply_filter(0, &[]).expect("apply empty");
    assert!(report.hidden_rows.is_empty());
    assert!(wb.filter_rules(0).is_empty());
    assert!(wb.filter_hidden_rows(0).is_empty());
}

/// **A divergence caught by reading the host, not the design doc.**
///
/// `worker-workbook-backend.ts`'s `setFilterSort` short-circuits on
/// `!filterSortHasEffect(next)` ABOVE the `listNonEmpty` extent probe, so
/// clearing a filter never consults the budget. Budgeting an empty rule set
/// would make a sheet too large to scan impossible to UN-filter — the
/// workbook would be permanently stuck filtered, with no way out through
/// the UI. Ordering the short-circuit first is what keeps the exit open.
#[test]
fn clearing_a_filter_is_never_refused_for_being_too_large_to_scan() {
    let mut wb = produce_sheet();
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    // Push the extent far past the budget, the way a real large sheet does.
    wb.set_cell(0, "A80000", Value::Text("far".into()));
    assert!(
        wb.apply_filter(0, &[contains(0, "b")]).is_err(),
        "too large to APPLY"
    );

    let report = wb.apply_filter(0, &[]).expect("clearing must still work");
    assert_eq!(report.scanned_rows, 0, "nothing was scanned, truthfully");
    assert!(wb.filter_hidden_rows(0).is_empty());
    // ...and the dedicated command agrees.
    wb.apply_filter(0, &[contains(0, "a")]).unwrap_err();
    wb.clear_filter(0).expect("clear must still work");
}

#[test]
fn reapply_on_a_sheet_with_no_filter_is_a_scan_free_no_op() {
    let mut wb = produce_sheet();
    let report = wb.reapply_filter(0).expect("reapply");
    assert!(report.hidden_rows.is_empty());
    assert_eq!(
        wb.debug_filter_scan_count(0),
        0,
        "there are no rules to run, so nothing is scanned"
    );
}

#[test]
fn the_entry_points_reject_an_unknown_sheet() {
    let mut wb = produce_sheet();
    assert_eq!(
        wb.apply_filter(9, &[]).unwrap_err(),
        FilterError::InvalidSheet
    );
    assert_eq!(wb.reapply_filter(9).unwrap_err(), FilterError::InvalidSheet);
    assert_eq!(wb.clear_filter(9).unwrap_err(), FilterError::InvalidSheet);
    assert!(wb.filter_rules(9).is_empty());
    assert!(wb.filter_hidden_rows(9).is_empty());
}

// ===================== the host push port is unchanged =====================

/// `set_eval_filter_hidden_rows` keeps its exact contract while writing the
/// owned state — that is what makes E3 a zero-behaviour-change slice while
/// the host is still the writer.
#[test]
fn the_host_push_port_still_replaces_clears_and_feeds_subtotal() {
    let mut wb = Workbook::new();
    wb.set_cell(0, "A1", Value::Text("H".into()));
    for row in 0..5u32 {
        wb.set_cell(0, &format!("A{}", row + 2), Value::Number((row + 1) as f64));
    }
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9,A2:A6)"));

    wb.set_eval_filter_hidden_rows(0, &[1, 2]);
    assert_eq!(num(&wb, "C1"), 12.0);
    assert_eq!(
        wb.filter_hidden_rows(0),
        vec![1, 2],
        "landed in owned state"
    );

    // Whole-set REPLACE, not merge.
    wb.set_eval_filter_hidden_rows(0, &[4]);
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    assert_eq!(num(&wb, "C1"), 11.0);

    // Empty clears.
    wb.set_eval_filter_hidden_rows(0, &[]);
    assert!(wb.filter_hidden_rows(0).is_empty());
    assert_eq!(num(&wb, "C1"), 15.0);

    // Out of range is a silent no-op.
    wb.set_eval_filter_hidden_rows(9, &[0]);
}

/// A host push does NOT invent rules, and it does not erase the ones a
/// previous `apply_filter` committed.
#[test]
fn a_host_push_replaces_the_derived_set_and_leaves_the_rules_alone() {
    let mut wb = produce_sheet();
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    wb.set_eval_filter_hidden_rows(0, &[2, 3]);
    assert_eq!(wb.filter_hidden_rows(0), vec![2, 3]);
    assert_eq!(wb.filter_rules(0), vec![contains(0, "a")]);

    // ...so a later Reapply still has something to reapply, and re-derives
    // the rules' own answer.
    let report = wb.reapply_filter(0).expect("reapply");
    assert_eq!(report.hidden_rows, vec![4]);
}

// ===================== snapshot / restore =====================

#[test]
fn filter_snapshot_round_trips_rules_and_the_rows_they_hid() {
    let mut wb = produce_sheet();
    let second = wb.add_sheet("Second");
    wb.set_cell(second, "A1", Value::Text("H".into()));
    wb.set_cell(second, "A2", Value::Text("keep".into()));
    wb.set_cell(second, "A3", Value::Text("drop".into()));

    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    wb.apply_filter(second, &[contains(0, "keep")])
        .expect("apply");
    let before = wb.snapshot_filters();
    assert_eq!(before.len(), 2);

    wb.apply_filter(0, &[contains(0, "an")]).expect("apply");
    wb.clear_filter(second).expect("clear");
    assert_eq!(wb.filter_hidden_rows(0), vec![1, 3, 4]);

    assert_eq!(wb.restore_filters(before).expect("restore"), 2);
    assert_eq!(wb.filter_rules(0), vec![contains(0, "a")]);
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
    assert_eq!(wb.filter_hidden_rows(second), vec![2]);
    assert_eq!(
        wb.debug_filter_scan_count(0),
        2,
        "two applies ran on sheet 0; the restore installed a remembered answer without scanning"
    );
}

#[test]
fn restoring_an_empty_snapshot_clears_every_sheet_rather_than_no_opping() {
    let mut wb = produce_sheet();
    assert!(wb.set_formula(0, "D1", "=SUBTOTAL(9,B2:B5)"));
    wb.apply_filter(0, &[contains(0, "a")]).expect("apply");
    assert_eq!(num(&wb, "D1"), 6.0);

    assert_eq!(
        wb.restore_filters(FilterSnapshot::default())
            .expect("restore"),
        0
    );
    assert!(wb.filter_rules(0).is_empty());
    assert_eq!(num(&wb, "D1"), 10.0, "REPLACE semantics released every row");
}

#[test]
fn restore_drops_entries_for_sheets_that_no_longer_exist() {
    let mut wb = produce_sheet();
    let snapshot = FilterSnapshot::from_sheets(vec![
        SheetFilterState {
            sheet_index: 0,
            rules: vec![contains(0, "a")],
            hidden_rows: vec![4],
        },
        SheetFilterState {
            sheet_index: 7,
            rules: vec![contains(0, "z")],
            hidden_rows: vec![1],
        },
    ]);
    assert_eq!(wb.restore_filters(snapshot).expect("restore"), 1);
    assert_eq!(wb.filter_hidden_rows(0), vec![4]);
}

// ===================== sheet lifecycle =====================

/// The filter rides its `Sheet` through a reorder, and the index-keyed
/// evaluation mirror follows — the E0/D1 failure mode, on the filter half.
#[test]
fn a_sheet_move_carries_the_filter_and_re_keys_the_mirror() {
    let mut wb = Workbook::new();
    let second = wb.add_sheet("Second");
    for sheet in [0, second] {
        wb.set_cell(sheet, "A1", Value::Text("H".into()));
        for row in 0..3u32 {
            wb.set_cell(
                sheet,
                &format!("A{}", row + 2),
                Value::Number((row + 1) as f64),
            );
        }
    }
    assert!(wb.set_formula(second, "C1", "=SUBTOTAL(9,A2:A4)"));

    // Only sheet "Second" is filtered: rows with a value below 3 go away.
    wb.apply_filter(
        second,
        &[ColumnFilterRule::Range {
            col_index: 0,
            min: Some(3.0),
            max: None,
        }],
    )
    .expect("apply");
    assert_eq!(
        match wb.get_cell("Second", "C1") {
            Value::Number(n) => n,
            other => panic!("{other:?}"),
        },
        3.0
    );

    assert!(wb.move_sheet(second, 0));
    assert_eq!(wb.filter_hidden_rows(0), vec![1, 2], "moved to index 0");
    assert!(
        wb.filter_hidden_rows(1).is_empty(),
        "and left index 1 clean"
    );
    assert_eq!(
        match wb.get_cell("Second", "C1") {
            Value::Number(n) => n,
            other => panic!("{other:?}"),
        },
        3.0,
        "the SUBTOTAL still resolves its own sheet's set"
    );
}

#[test]
fn removing_a_sheet_drops_its_filter_and_shifts_the_rest_down() {
    let mut wb = Workbook::new();
    let second = wb.add_sheet("Second");
    wb.set_cell(second, "A1", Value::Text("H".into()));
    wb.set_cell(second, "A2", Value::Text("keep".into()));
    wb.set_cell(second, "A3", Value::Text("drop".into()));
    wb.apply_filter(second, &[contains(0, "keep")])
        .expect("apply");
    assert_eq!(wb.filter_hidden_rows(second), vec![2]);

    assert!(wb.remove_sheet(0).is_some());
    assert_eq!(wb.filter_hidden_rows(0), vec![2], "Second is now index 0");
}
