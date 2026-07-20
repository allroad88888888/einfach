//! #32 Excel Table — T4: SUBTOTAL 101-111 hidden-row semantics
//! (design doc `design-excel-table.md` §6, CANONICAL_OWNERSHIP §7-1).
//!
//! The host pushes a per-sheet hidden-row set into the engine as read-only
//! evaluation input via `Workbook::set_eval_hidden_rows`; SUBTOTAL function
//! numbers 101-111 exclude those rows while 1-11 keep their existing
//! "aggregate everything" semantics. The engine never models hidden state or
//! infers the source (manual vs filter) — it only reads the set. Covered:
//!   - 109 excludes hidden rows, 9 does not (the divergence),
//!   - every 1xx variant (101-111) excludes hidden, its 1-11 twin does not,
//!   - hidden rows are 0-based row indices matching `CellAddress::row`,
//!   - a hidden push precisely re-derives ONLY the 101-111 formulas that read
//!     it (1-11 hold no `hidden_epoch` edge; eval-count + cache-state probes),
//!   - full-replace push semantics and clearing,
//!   - cross-sheet independence: a cross-sheet 109 reads the REFERENCED
//!     sheet's set, and per-sheet pushes don't leak across sheets,
//!   - multi-range args, and out-of-range / no-op safety.

use einfach_core::Value;
use einfach_excel_core::Workbook;

/// Fill A1.. down one column on `sheet_idx` with the given numbers (0-based
/// row 0 = "A1"). Returns the workbook for chaining in the callers.
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

// ===================== the core divergence =====================

/// SUBTOTAL(109, …) excludes host-pushed hidden rows; SUBTOTAL(9, …) keeps
/// its current "include everything" semantics. Same data, same hidden set,
/// different results — the §6.3 conformance seam made concrete.
#[test]
fn subtotal_109_excludes_hidden_rows_while_9_includes_them() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]); // A1..A5 = rows 0..4
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)"));

    // No hidden rows yet: both are the full sum.
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);

    // Hide rows 1 and 3 (0-based) → A2 (=2) and A4 (=4).
    wb.set_eval_hidden_rows(0, &[1, 3]);

    // 9 unaffected; 109 drops the hidden rows: 1 + 3 + 5 = 9.
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0, "SUBTOTAL(9) must ignore hidden");
    assert_eq!(num(&wb, "Sheet1", "C2"), 9.0, "SUBTOTAL(109) must exclude hidden");
    assert_ne!(
        num(&wb, "Sheet1", "C1"),
        num(&wb, "Sheet1", "C2"),
        "9 and 109 must diverge under the same hidden set"
    );
}

// ===================== every 1xx variant =====================

/// All eleven function numbers 101-111 exclude the hidden rows, and each of
/// their 1-11 twins keeps aggregating every row. Data and hidden set chosen so
/// every function's visible-only value differs from its all-rows value.
#[test]
fn all_subtotal_variants_101_to_111_exclude_hidden() {
    let mut wb = Workbook::new();
    // A1..A6 = rows 0..5.
    let all = [5.0, 100.0, 3.0, 1.0, 8.0, 50.0];
    load_column(&mut wb, 0, &all);
    // Hide rows 1 (=100) and 3 (=1) → visible = {5, 3, 8, 50}.
    wb.set_eval_hidden_rows(0, &[1, 3]);
    let visible = [5.0, 3.0, 8.0, 50.0];

    let mean = |xs: &[f64]| xs.iter().sum::<f64>() / xs.len() as f64;
    let var = |xs: &[f64], sample: bool| {
        let m = mean(xs);
        let denom = if sample { xs.len() - 1 } else { xs.len() } as f64;
        xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / denom
    };

    // (function_num, expected over visible-only, expected over all rows)
    let cases: [(u32, f64, f64); 11] = [
        (1, mean(&visible), mean(&all)),                       // AVERAGE
        (2, visible.len() as f64, all.len() as f64),           // COUNT
        (3, visible.len() as f64, all.len() as f64),           // COUNTA
        (4, 50.0, 100.0),                                      // MAX
        (5, 3.0, 1.0),                                         // MIN
        (6, visible.iter().product(), all.iter().product()),   // PRODUCT
        (7, var(&visible, true).sqrt(), var(&all, true).sqrt()), // STDEV
        (8, var(&visible, false).sqrt(), var(&all, false).sqrt()), // STDEVP
        (9, visible.iter().sum(), all.iter().sum()),           // SUM
        (10, var(&visible, true), var(&all, true)),            // VAR
        (11, var(&visible, false), var(&all, false)),          // VARP
    ];

    for (base, want_visible, want_all) in cases {
        let hidden_fn = base + 100;
        assert!(wb.set_formula(0, "E1", &format!("=SUBTOTAL({hidden_fn}, A1:A6)")));
        assert!(wb.set_formula(0, "E2", &format!("=SUBTOTAL({base}, A1:A6)")));
        let got_hidden = num(&wb, "Sheet1", "E1");
        let got_plain = num(&wb, "Sheet1", "E2");
        assert!(
            approx(got_hidden, want_visible),
            "SUBTOTAL({hidden_fn}) = {got_hidden}, want visible-only {want_visible}"
        );
        assert!(
            approx(got_plain, want_all),
            "SUBTOTAL({base}) = {got_plain}, want all-rows {want_all}"
        );
        assert!(
            !approx(got_hidden, got_plain),
            "SUBTOTAL({hidden_fn}) must diverge from SUBTOTAL({base})"
        );
    }
}

// ===================== precise invalidation =====================

/// A hidden-set push re-derives ONLY the formulas that read hidden rows: the
/// 109 formula (holds the `hidden_epoch` edge) re-computes; the 9 formula
/// (never calls `hidden_rows`) is never invalidated. Proven by the sheet's
/// formula-eval counter advancing by exactly one, and by the 9 formula's
/// cache staying clean across the push.
#[test]
fn hidden_change_precisely_reinvalidates_109_not_9() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)")); // no hidden edge
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, A1:A5)")); // hidden edge

    // Materialize both (first read seeds the derived atoms + edges).
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 15.0);
    assert_eq!(wb.debug_formula_cache_state(0, "C1"), "clean");
    assert_eq!(wb.debug_formula_cache_state(0, "C2"), "clean");

    let before = wb.debug_formula_eval_count(0);
    wb.set_eval_hidden_rows(0, &[1]); // hide A2 (=2)

    // The 9 formula holds no hidden edge → it is never invalidated.
    assert_eq!(
        wb.debug_formula_cache_state(0, "C1"),
        "clean",
        "SUBTOTAL(9) must not be invalidated by a hidden push"
    );

    // Read both. C1 stays cached (0 evals); C2 re-derives exactly once.
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 13.0); // 1+3+4+5
    assert_eq!(
        wb.debug_formula_eval_count(0),
        before + 1,
        "only the 109 formula may re-derive after a hidden push"
    );
}

// ===================== full-replace + clear =====================

/// Pushes are whole-set replacements (design §6.1), not deltas: a second push
/// supersedes the first, and an empty push restores the unfiltered total.
#[test]
fn hidden_push_is_full_replace_and_empty_clears() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(109, A1:A5)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0);

    // Hide row 1 (=2): 1+3+4+5 = 13.
    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 13.0);

    // Replace with {row 3 (=4)} — NOT a union: 1+2+3+5 = 11.
    wb.set_eval_hidden_rows(0, &[3]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 11.0, "second push must fully replace the first");

    // Empty push clears the set → full total again.
    wb.set_eval_hidden_rows(0, &[]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0, "empty push must restore the unfiltered total");
}

// ===================== cross-sheet independence =====================

/// A cross-sheet SUBTOTAL(109, Sheet2!…) reads SHEET2's hidden set, not the
/// current sheet's; per-sheet pushes never leak across sheets.
#[test]
fn cross_sheet_subtotal_uses_referenced_sheet_hidden_set() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    assert_eq!(s2, 1);
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]); // Sheet1 A1..A3 = rows 0..2
    load_column(&mut wb, 1, &[10.0, 20.0, 30.0]); // Sheet2 A1..A3

    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(109, A1:A3)")); // same-sheet
    assert!(wb.set_formula(0, "C2", "=SUBTOTAL(109, Sheet2!A1:A3)")); // cross-sheet

    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);
    assert_eq!(num(&wb, "Sheet1", "C2"), 60.0);

    // Hide row 1 on Sheet1 ONLY.
    wb.set_eval_hidden_rows(0, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 4.0, "same-sheet 109 drops Sheet1 row 1 (=2)");
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        60.0,
        "cross-sheet 109 must be independent of Sheet1's hidden set"
    );

    // Now hide row 1 on Sheet2 ONLY.
    wb.set_eval_hidden_rows(1, &[1]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 4.0, "Sheet1 result unchanged by a Sheet2 push");
    assert_eq!(
        num(&wb, "Sheet1", "C2"),
        40.0,
        "cross-sheet 109 must read Sheet2's hidden set (drops 20)"
    );
}

// ===================== multi-range args =====================

/// Hidden filtering applies per argument across a multi-range SUBTOTAL, using
/// each cell's own row against the (same-sheet) hidden set.
#[test]
fn hidden_filter_applies_across_multiple_range_args() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]); // rows 0..5
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(109, A1:A3, A4:A6)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 21.0);

    // Hide row 0 (A1=1, first arg) and row 4 (A5=5, second arg).
    wb.set_eval_hidden_rows(0, &[0, 4]);
    assert_eq!(num(&wb, "Sheet1", "C1"), 15.0); // 2+3+4+6
}

// ===================== safety / no-op =====================

/// A push to an out-of-range sheet index is a silent no-op (no panic, no
/// effect on existing formulas).
#[test]
fn push_to_out_of_range_sheet_is_a_no_op() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]);
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(109, A1:A3)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);

    wb.set_eval_hidden_rows(99, &[0, 1, 2]); // no such sheet
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0, "unrelated sheet push must not affect Sheet1");
}

/// A hidden row that falls outside the SUBTOTAL's referenced range simply
/// never matches, so the result is unchanged.
#[test]
fn hidden_row_outside_the_referenced_range_has_no_effect() {
    let mut wb = Workbook::new();
    load_column(&mut wb, 0, &[1.0, 2.0, 3.0]); // A1:A3, rows 0..2
    assert!(wb.set_formula(0, "C1", "=SUBTOTAL(109, A1:A3)"));
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);

    wb.set_eval_hidden_rows(0, &[9]); // row 9 not in A1:A3
    assert_eq!(num(&wb, "Sheet1", "C1"), 6.0);
}
