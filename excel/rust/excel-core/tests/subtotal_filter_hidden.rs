//! Filter redo S1 — SUBTOTAL's two-layer hidden-row rule
//! (`excel/solid-excel/docs/online-excel-parity/design-filter-hidden-rows.md` §6.2-6.4).
//!
//! The host now pushes TWO independent per-sheet row sets into the engine as
//! read-only evaluation input:
//!   - `set_eval_hidden_rows`        — MANUALLY hidden rows (pre-existing port,
//!                                     semantics unchanged),
//!   - `set_eval_filter_hidden_rows` — FILTER-hidden rows (new, additive).
//!
//! Excel's rule they exist to express:
//!   - `SUBTOTAL(1-11)`   excludes filter-hidden rows, INCLUDES manually hidden,
//!   - `SUBTOTAL(101-111)` excludes BOTH.
//!
//! Covered here: the full 2×2 rule matrix, per-variant coverage across all
//! eleven function numbers, non-interference between the two sets, the split
//! invalidation epochs (a manual push must NOT dirty a 1-11 formula, a filter
//! push must dirty both layers), whole-set-replace / empty-clear / out-of-range
//! no-op for the new port, cross-sheet independence, and the scalar-argument
//! (`addr == None`) never-filtered path.
//!
//! The pre-existing single-set matrix lives in `subtotal_hidden.rs` and must
//! stay green unchanged — that file is this slice's backward-compatibility pin.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Fill A1.. down one column on `sheet_idx` (0-based row 0 = "A1").
fn load_column(wb: &mut Workbook, sheet_idx: usize, values: &[f64]) {
    for (i, v) in values.iter().enumerate() {
        wb.set_cell(sheet_idx, &format!("A{}", i + 1), Value::Number(*v));
    }
}

fn num(wb: &Workbook, sheet: &str, addr: &str) -> f64 {
    match wb.get_cell(sheet, addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {sheet}!{addr}, got {other:?}"),
    }
}

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

// ===================== the Excel rule matrix =====================

/// The core 2×2. Same data, same formulas, four hidden-set configurations:
///
/// | pushed          | SUBTOTAL(9) | SUBTOTAL(109) |
/// |-----------------|-------------|---------------|
/// | nothing         | all         | all           |
/// | filter only     | **excluded**| excluded      |
/// | manual only     | **included**| excluded      |
/// | both            | filter out  | both out      |
#[test]
fn subtotal_two_layer_rule_matrix() {
    let mut wb = Workbook::new();
    // A1..A5 = rows 0..4, values 1..5 (sum 15).
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)"));

    // --- nothing hidden ---
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);

    // --- filter-hidden ONLY: row 1 (=2) → both layers exclude it ---
    wb.set_eval_filter_hidden_rows(0, &[1]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        13.0,
        "SUBTOTAL(9) must EXCLUDE filter-hidden rows (the rule this slice adds)"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        13.0,
        "SUBTOTAL(109) must exclude filter-hidden rows"
    );

    // --- manual-hidden ONLY: row 1 (=2) → only 101-111 excludes it ---
    wb.set_eval_filter_hidden_rows(0, &[]);
    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        15.0,
        "SUBTOTAL(9) must INCLUDE manually hidden rows (Excel parity, unchanged)"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        13.0,
        "SUBTOTAL(109) must exclude manually hidden rows"
    );

    // --- BOTH, disjoint: manual {1} (=2), filter {3} (=4) ---
    wb.set_eval_filter_hidden_rows(0, &[3]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        11.0,
        "SUBTOTAL(9) drops only the filter row: 1+2+3+5"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        9.0,
        "SUBTOTAL(109) drops both: 1+3+5"
    );

    // --- BOTH, overlapping: a row in both sets is skipped once, not twice ---
    wb.set_eval_hidden_rows(0, &[1, 3]);
    wb.set_eval_filter_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 11.0, "filter {{3}} only: 1+2+3+5");
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        9.0,
        "manual {{1,3}} ∪ filter {{3}} — row 3 counted once: 1+3+5"
    );
}

/// Every function number, both layers, with a manual set and a filter set that
/// are disjoint — so a wrong-set wiring in any one accumulator branch shows up
/// as a numeric mismatch rather than an accidental pass.
#[test]
fn all_variants_apply_the_two_layer_rule() {
    let mut wb = Workbook::new();
    // A1..A6 = rows 0..5.
    let all = [5.0, 100.0, 3.0, 1.0, 8.0, 50.0];
    load_column(&mut wb, 0, &all);
    // manual = row 1 (=100); filter = row 3 (=1).
    wb.set_eval_hidden_rows(0, &[1]);
    wb.set_eval_filter_hidden_rows(0, &[3]);
    // 1-11 see everything but the filter row; 101-111 see neither.
    let plain_visible = [5.0, 100.0, 3.0, 8.0, 50.0];
    let hidden_visible = [5.0, 3.0, 8.0, 50.0];

    let mean = |xs: &[f64]| xs.iter().sum::<f64>() / xs.len() as f64;
    let var = |xs: &[f64], sample: bool| {
        let m = mean(xs);
        let denom = if sample { xs.len() - 1 } else { xs.len() } as f64;
        xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / denom
    };
    let expect = |xs: &[f64], base: u32| -> f64 {
        match base {
            1 => mean(xs),
            2 | 3 => xs.len() as f64,
            4 => xs.iter().copied().fold(f64::MIN, f64::max),
            5 => xs.iter().copied().fold(f64::MAX, f64::min),
            6 => xs.iter().product(),
            7 => var(xs, true).sqrt(),
            8 => var(xs, false).sqrt(),
            9 => xs.iter().sum(),
            10 => var(xs, true),
            11 => var(xs, false),
            _ => unreachable!(),
        }
    };

    for base in 1..=11u32 {
        assert!(wb.set_formula(0, "E1", &format!("=SUBTOTAL({base}, A1:A6)")));
        assert!(wb.set_formula(0, "E2", &format!("=SUBTOTAL({}, A1:A6)", base + 100)));
        let got_plain = num(&wb, "Sheet1", "E1");
        let got_hidden = num(&wb, "Sheet1", "E2");
        let want_plain = expect(&plain_visible, base);
        let want_hidden = expect(&hidden_visible, base);
        assert!(
            approx(got_plain, want_plain),
            "SUBTOTAL({base}) = {got_plain}, want filter-excluded-only {want_plain}"
        );
        assert!(
            approx(got_hidden, want_hidden),
            "SUBTOTAL({}) = {got_hidden}, want both-excluded {want_hidden}",
            base + 100
        );
    }
}

// ===================== the two sets are independent =====================

/// Replacing one set never perturbs the other's contribution. Drives each set
/// through push → replace → clear while the other stays pinned, asserting the
/// unaffected layer's result at every step.
#[test]
fn the_two_sets_do_not_interfere() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)"));

    // Pin filter = {0} (=1). 9 → 14; 109 → 14.
    wb.set_eval_filter_hidden_rows(0, &[0]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 14.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 14.0);

    // Churn the MANUAL set: 9 must stay 14 throughout.
    for (manual, want_109) in [
        (vec![1u32], 12.0), // drop 2 as well
        (vec![1, 2], 9.0),  // drop 2 and 3
        (vec![4], 9.0),     // full replace, not a delta: drop 5 (2+3+4)
        (vec![], 14.0),     // empty clears
    ] {
        wb.set_eval_hidden_rows(0, &manual);
        assert_eq!(
            num(&wb, "Sheet1", "C1"),
            14.0,
            "manual push {manual:?} must not change SUBTOTAL(9)"
        );
        assert_eq!(num(&wb, "Sheet1", "C2"), want_109, "manual push {manual:?}");
    }

    // Now pin manual = {4} (=5) and churn the FILTER set; 109 tracks both.
    wb.set_eval_hidden_rows(0, &[4]);
    for (filter, want_9, want_109) in [
        (vec![0u32], 14.0, 9.0), // 2+3+4+5 / 2+3+4
        (vec![0, 1], 12.0, 7.0), // 3+4+5 / 3+4
        (vec![2], 12.0, 7.0),    // full replace: 1+2+4+5 / 1+2+4
        (vec![], 15.0, 10.0),    // empty clears: all / all-but-manual
    ] {
        wb.set_eval_filter_hidden_rows(0, &filter);
        assert_eq!(num(&wb, "Sheet1", "C1"), want_9, "filter push {filter:?}");
        assert_eq!(num(&wb, "Sheet1", "C2"), want_109, "filter push {filter:?}");
    }
}

/// The new port's push contract, mirroring `subtotal_hidden.rs`'s matrix for
/// the manual port: whole-set replace (never a union with the previous push),
/// empty clears, a row outside the referenced range is inert.
#[test]
fn filter_push_is_full_replace_and_empty_clears() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);

    wb.set_eval_filter_hidden_rows(0, &[1]); // 1+3+4+5
    assert_eq!(num(&wb, "Sheet1", "C1"), 13.0);

    wb.set_eval_filter_hidden_rows(0, &[3]); // NOT a union: 1+2+3+5
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        11.0,
        "second push must fully replace the first"
    );

    wb.set_eval_filter_hidden_rows(0, &[3, 3, 3]); // idempotent / dedup
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        11.0,
        "duplicate indices are one row"
    );

    wb.set_eval_filter_hidden_rows(0, &[9]); // outside A1:A5
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        15.0,
        "a row outside the range filters nothing"
    );

    wb.set_eval_filter_hidden_rows(0, &[]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        15.0,
        "empty push must restore the unfiltered total"
    );
}

/// A filter push to a non-existent sheet index is a silent no-op — same
/// out-of-range guard as `set_eval_hidden_rows`.
#[test]
fn filter_push_to_out_of_range_sheet_is_a_no_op() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A3)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);

    wb.set_eval_filter_hidden_rows(99, &[0, 1, 2]); // no such sheet
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        6.0,
        "unrelated sheet push must not affect Sheet1"
    );
}

// ===================== split-epoch invalidation =====================

/// The acceptance criterion for splitting `hidden_epoch` in two: pushing the
/// MANUAL set must not dirty a pure 1-11 formula, even though 1-11 now reads a
/// hidden set (the filter one). A single shared epoch would re-derive every
/// 1-11 SUBTOTAL in the workbook on each manual hide/unhide.
#[test]
fn manual_push_does_not_dirty_a_1_to_11_formula() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)")); // filter edge only
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)")); // both edges

    // Materialize both (seeds the derived atoms + their epoch edges).
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
    assert_eq!(wb.debug_formula_cache_state(0, "C1"), "clean");
    assert_eq!(wb.debug_formula_cache_state(0, "C2"), "clean");

    let before = wb.debug_formula_eval_count(0);
    wb.set_eval_hidden_rows(0, &[1]); // manual hide of A2 (=2)

    assert_eq!(
        wb.debug_formula_cache_state(0, "C1"),
        "clean",
        "SUBTOTAL(9) holds no manual-hidden edge and must stay cached"
    );

    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        15.0,
        "9 still includes the manually hidden row"
    );
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0, "109 excludes it");
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before + 1,
        "only the 109 formula may re-derive after a MANUAL push"
    );
}

/// The other half of the split: a FILTER push dirties BOTH layers, because
/// both now read the filter set. Also pins the pre-probe edge placement —
/// the very first push (from an empty set) must reach formulas that have so
/// far seen no hidden rows at all.
#[test]
fn filter_push_dirties_both_layers_including_the_first_push() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
    assert_eq!(wb.debug_formula_cache_state(0, "C1"), "clean");
    assert_eq!(wb.debug_formula_cache_state(0, "C2"), "clean");

    let before = wb.debug_formula_eval_count(0);
    // FIRST filter push ever — the edge must have been registered before the
    // (empty) probe, or neither formula would ever learn about it.
    wb.set_eval_filter_hidden_rows(0, &[1]);

    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        13.0,
        "9 must pick up the first filter push"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        13.0,
        "109 must pick up the first filter push"
    );
    // Both held the filter edge, so both re-derived exactly once — the mirror
    // image of `manual_push_does_not_dirty_a_1_to_11_formula`'s `+1`.
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before + 2,
        "both layers re-derive exactly once after a filter push"
    );
}

/// A formula that references neither hidden source is untouched by either
/// push — the epochs stay scoped to SUBTOTAL's resolve path.
#[test]
fn unrelated_formulas_hold_no_hidden_edge() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]);
    assert!(wb.set_formula(0, "C1", "=SUM(A1:A3)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);
    assert_eq!(wb.debug_formula_cache_state(0, "C1"), "clean");

    wb.set_eval_filter_hidden_rows(0, &[0]);
    assert_eq!(
        wb.debug_formula_cache_state(0, "C1"),
        "clean",
        "plain SUM holds no filter edge"
    );
    wb.set_eval_hidden_rows(0, &[0]);
    assert_eq!(
        wb.debug_formula_cache_state(0, "C1"),
        "clean",
        "plain SUM holds no manual edge"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        6.0,
        "SUM never excludes hidden rows"
    );
}

// ===================== cross-sheet =====================

/// Both sets are per-sheet keyed and resolved per ARGUMENT: a cross-sheet
/// `SUBTOTAL(…, Sheet2!A1:A3)` reads Sheet2's sets, never Sheet1's — for the
/// filter set exactly as for the manual one.
#[test]
fn cross_sheet_args_read_the_referenced_sheets_filter_set() {
    let mut wb = Workbook::new();
    assert_eq!(wb.add_sheet("Sheet2"), 1);
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]);
    load_column(&mut wb, 1, &[10.0, 20.0, 30.0]);

    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A3)")); // same-sheet
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(9, Sheet2!A1:A3)")); // cross-sheet
    assert!(wb.set_formula(0, "C3", "=SUBTOTAL(109, Sheet2!A1:A3)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 60.0);
    assert_eq!(num(&wb, "Sheet1", "C3"), 60.0);

    // Filter-hide row 1 on Sheet1 ONLY.
    wb.set_eval_filter_hidden_rows(0, &[1]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        4.0,
        "same-sheet 9 drops Sheet1 row 1 (=2)"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        60.0,
        "cross-sheet 9 must be independent of Sheet1's filter set"
    );

    // Filter-hide row 1 on Sheet2 ONLY; manual-hide row 2 on Sheet2.
    wb.set_eval_filter_hidden_rows(1, &[1]);
    wb.set_eval_hidden_rows(1, &[2]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        4.0,
        "Sheet1 result unchanged by Sheet2 pushes"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        40.0,
        "cross-sheet 9 drops Sheet2's filter row (20) but keeps its manual row (30)"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C3"),
        10.0,
        "cross-sheet 109 drops both of Sheet2's rows"
    );
}

// ===================== non-row arguments =====================

/// Scalar / literal arguments yield `addr == None` from the streaming walk and
/// are therefore never filtered by either set, whatever the function number.
#[test]
fn scalar_arguments_are_never_filtered() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]);
    // Hide every row that exists, in both sets.
    wb.set_eval_filter_hidden_rows(0, &[0, 1, 2]);
    wb.set_eval_hidden_rows(0, &[0, 1, 2]);

    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, 7)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, 7)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 7.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 7.0);

    // Mixed: a fully hidden range contributes nothing, the literal still counts.
    assert!(wb.set_formula(0, "C3", "=SUBTOTAL(9, A1:A3, 7)"));
    assert_eq!(num(&wb, "Sheet1", "C3"), 7.0);
}

// ===================== multi-range args =====================

/// Per-argument resolution across a multi-range SUBTOTAL, with each set hitting
/// a different argument.
#[test]
fn both_sets_apply_across_multiple_range_args() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]); // rows 0..5
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A3, A4:A6)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A3, A4:A6)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 21.0);

    // filter row 0 (first arg), manual row 4 (second arg).
    wb.set_eval_filter_hidden_rows(0, &[0]);
    wb.set_eval_hidden_rows(0, &[4]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 20.0, "9 drops only A1: 2+3+4+5+6");
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        15.0,
        "109 drops A1 and A5: 2+3+4+6"
    );
}

// ===================== error propagation is unchanged =====================

/// The asymmetric error semantics survive the rework: SUM/AVERAGE/MAX/MIN/
/// PRODUCT propagate an error found in a VISIBLE cell, while an error parked in
/// a hidden cell is skipped by whichever layer excludes that row. COUNT/COUNTA
/// keep swallowing errors entirely.
#[test]
fn error_propagation_semantics_are_preserved() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]);
    wb.set_cell(0, "A2", Value::Number(2.0));
    assert!(wb.set_formula(0, "A4", "=1/0")); // row 3 → an error cell

    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A4)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A4)"));
    assert!(wb.set_formula(0, "C3", "=SUBTOTAL(2, A1:A4)"));

    // Visible error → both layers propagate.
    assert!(matches!(wb.get_cell("Sheet1", "C1"), Value::Error(_)));
    assert!(matches!(wb.get_cell("Sheet1", "C2"), Value::Error(_)));
    // COUNT ignores errors, as before.
    assert_eq!(num(&wb, "Sheet1", "C3"), 3.0);

    // Filter-hide the error row → both layers skip it and return numbers.
    wb.set_eval_filter_hidden_rows(0, &[3]);
    assert_eq!(
        num(&wb, "Sheet1", "C1"),
        6.0,
        "9 skips a filter-hidden error cell"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        6.0,
        "109 skips a filter-hidden error cell"
    );

    // Manual-hide it instead → 9 still sees the error, 109 does not.
    wb.set_eval_filter_hidden_rows(0, &[]);
    wb.set_eval_hidden_rows(0, &[3]);
    assert!(
        matches!(wb.get_cell("Sheet1", "C1"), Value::Error(_)),
        "9 must still propagate an error from a MANUALLY hidden row"
    );
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        6.0,
        "109 skips a manually hidden error cell"
    );
}
