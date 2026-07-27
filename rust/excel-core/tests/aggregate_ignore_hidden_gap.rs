//! #32 §6.3 — AGGREGATE ignore-hidden option bit: RESOLVED by real Excel.
//!
//! STATUS: GREEN. This was previously an `#[ignore]`d red gap-pin because the
//! third-party literature disagreed on WHICH hidden set AGGREGATE's
//! ignore-hidden bit governs. That question is now settled by direct
//! measurement on real Excel (dataset 1/2/4/8/16/32, sum 63; one manually
//! hidden row and one filter-hidden row, visible sum 43):
//!   - options 0/2/4/6 (ignore-hidden bit CLEAR) -> 63 (BOTH hidden sets kept,
//!     even the filter-hidden row counts);
//!   - options 1/3/5/7 (ignore-hidden bit SET)   -> 43 (BOTH hidden sets
//!     dropped).
//! So the bit is a UNIFIED manual+filter switch — there is NO "filter always
//! excluded" tier the way SUBTOTAL(1-11) has one. AGGREGATE therefore picks
//! only between `SubtotalHiddenPolicy::IncludeAll` (bit clear) and
//! `SubtotalHiddenPolicy::ExcludeFilterAndManual` (bit set); it never uses the
//! `ExcludeFilter` filter-only tier.
//!
//! WHAT THIS TEST PINS
//! -------------------
//! When the ignore-hidden bit is SET (options 1/3/5/7) BOTH the filter-hidden
//! AND the manually-hidden set are excluded. Before the #32 §6.3 fix the engine
//! excluded NEITHER (hard-coded `IncludeAll` for 1-11), so this test asserted
//! the visible-only sum and was RED ON THE VALUE (full sum vs visible sum). The
//! fix in `eval.rs` `fn_aggregate` maps `options & 1` onto the policy, so this
//! is now green. The full-matrix counter-example (bit-clear keeps hidden,
//! bit-set drops it, across every option 0..=7 and both hidden-injection
//! channels) lives in the dedicated matrix test below.

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn load_col(wb: &mut Workbook, values: &[f64]) {
    for (i, v) in values.iter().enumerate() {
        wb.set_cell(0, &format!("A{}", i + 1), Value::Number(*v));
    }
}

fn num(wb: &Workbook, addr: &str) -> f64 {
    match wb.get_cell("Sheet1", addr) {
        Value::Number(n) => n,
        other => panic!("expected number at {addr}, got {other:?}"),
    }
}

/// AGGREGATE(9, opt, A1:A6) with opt ∈ {1,3,5,7} (ignore-hidden bit SET) drops
/// BOTH the manually hidden row and the filter-hidden row. Pre-fix the engine
/// applied `SubtotalHiddenPolicy::IncludeAll` and returned the full sum; the
/// #32 §6.3 fix routes `options & 1` to `ExcludeFilterAndManual`.
#[test]
fn aggregate_ignore_hidden_bit_excludes_both_sets() {
    let mut wb = Workbook::new();
    // A1..A6 = rows 0..5, values 1..6 (no error values — this isolates the
    // ignore-hidden bit from the separate ignore-errors option). Full sum = 21.
    load_col(&mut wb, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);

    // Manually hide row 1 (A2 = 2) and filter-hide row 3 (A4 = 4) — two
    // DIFFERENT injection channels, matching the real-Excel measurement.
    wb.set_eval_hidden_rows(0, &[1]);
    wb.set_eval_filter_hidden_rows(0, &[3]);

    // Visible-only sum with the bit set: 1 + 3 + 5 + 6 = 15.
    const VISIBLE_SUM: f64 = 15.0;
    for opt in [1, 3, 5, 7] {
        assert!(wb.set_formula(0, "C1", &format!("=AGGREGATE(9, {opt}, A1:A6)")));
        let got = num(&wb, "C1");
        assert_eq!(
            got, VISIBLE_SUM,
            "AGGREGATE(9, {opt}, A1:A6): ignore-hidden bit set drops the \
             manual-hidden A2 and the filter-hidden A4 -> {VISIBLE_SUM}; \
             got {got}"
        );
    }
}

/// Full 0..=7 option matrix on the REAL-EXCEL dataset (1/2/4/8/16/32, sum 63;
/// value 4 manually hidden, value 16 filter-hidden, visible sum 43). This is
/// the counter-example that pins the whole bit semantics on the VALUE:
///   - bit CLEAR (0/2/4/6) -> 63: BOTH hidden sets kept (filter-hidden 16 still
///     counts). The pre-fix engine also returned 63 here, so these options are
///     unchanged and NON-discriminating on their own.
///   - bit SET   (1/3/5/7) -> 43: BOTH hidden sets dropped. The pre-fix engine
///     hard-coded `IncludeAll` and returned 63 (the full sum) for these too —
///     so 1/3/5/7 are the load-bearing red-then-green cases: red returned 63,
///     the fix returns 43.
/// The two hidden rows are injected through DIFFERENT channels
/// (`set_eval_hidden_rows` = manual, `set_eval_filter_hidden_rows` = filter),
/// proving the bit is a unified manual+filter switch, not a filter-only one.
#[test]
fn aggregate_ignore_hidden_bit_full_option_matrix() {
    let mut wb = Workbook::new();
    // rows 0..5 = A1..A6 = 1, 2, 4, 8, 16, 32.
    load_col(&mut wb, &[1.0, 2.0, 4.0, 8.0, 16.0, 32.0]);

    // Manual hide the value-4 row (row 2 = A3); filter-hide the value-16 row
    // (row 4 = A5) — two distinct injection channels.
    wb.set_eval_hidden_rows(0, &[2]);
    wb.set_eval_filter_hidden_rows(0, &[4]);

    const FULL_SUM: f64 = 63.0; // 1+2+4+8+16+32
    const VISIBLE_SUM: f64 = 43.0; // 63 - 4 (manual) - 16 (filter)
                                   // Guard the counter-example: the two sums MUST differ or the assertions
                                   // below could not tell IncludeAll from ExcludeFilterAndManual.
    assert_ne!(FULL_SUM, VISIBLE_SUM);

    // Bit CLEAR: keep everything (even the filter-hidden 16) -> 63.
    for opt in [0, 2, 4, 6] {
        assert!(wb.set_formula(0, "C1", &format!("=AGGREGATE(9, {opt}, A1:A6)")));
        let got = num(&wb, "C1");
        assert_eq!(
            got, FULL_SUM,
            "AGGREGATE(9, {opt}, A1:A6): ignore-hidden bit CLEAR keeps BOTH \
             hidden rows -> {FULL_SUM}; got {got}"
        );
    }

    // Bit SET: drop both hidden rows -> 43. Pre-fix this returned 63 (RED).
    for opt in [1, 3, 5, 7] {
        assert!(wb.set_formula(0, "C1", &format!("=AGGREGATE(9, {opt}, A1:A6)")));
        let got = num(&wb, "C1");
        assert_eq!(
            got, VISIBLE_SUM,
            "AGGREGATE(9, {opt}, A1:A6): ignore-hidden bit SET drops the \
             manual-hidden value 4 AND the filter-hidden value 16 -> \
             {VISIBLE_SUM}; got {got} (pre-fix IncludeAll returned {FULL_SUM})"
        );
    }
}
