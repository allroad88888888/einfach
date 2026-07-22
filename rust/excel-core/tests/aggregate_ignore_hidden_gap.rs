//! #32 §6.3 — AGGREGATE ignore-hidden option bits: PENDING-DECISION gap pin.
//!
//! STATUS: RED counter-example, intentionally `#[ignore]`d. It documents a real
//! semantic gap — AGGREGATE parses its `options` ignore-hidden bit but never
//! applies it (`eval.rs` `fn_aggregate` routes function_num 1-11 through
//! `SubtotalHiddenPolicy::IncludeAll`) — WITHOUT committing to a fix, because
//! the Excel semantics for WHICH hidden set that bit governs are contradictory
//! across sources and unresolved.
//!
//! WHY NOT FIXED HERE
//! ------------------
//! Microsoft's official AGGREGATE doc lists option 5 = "Ignore hidden rows" but
//! never says whether "hidden" means filter-hidden, manually-hidden, or both,
//! and never states whether either set is excluded UNCONDITIONALLY (the way
//! SUBTOTAL excludes filter-hidden regardless of function number). Respected
//! third-party references directly contradict each other (re-verified
//! 2026-07-22):
//!   - ExcelJet + MyOnlineTrainingHub: AGGREGATE ALWAYS excludes MANUALLY
//!     hidden rows; an option is needed to ALSO exclude FILTER-hidden rows.
//!   - BetterSolutions: AGGREGATE ALWAYS excludes FILTER-hidden rows; an option
//!     is needed to ALSO exclude MANUALLY hidden rows.
//!   - Microsoft-literal reading: option 4 = "ignore nothing" excludes NEITHER;
//!     only options 1/3/5/7 exclude "hidden rows" as one undifferentiated set.
//! These readings diverge on options 0/2/4/6 (ignore-hidden bit CLEAR). The
//! design doc `solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md`
//! (V5) already flagged this undecided; independent re-verification confirms the
//! contradiction stands with Microsoft silent, so no semantic is implemented by
//! fiat. Un-`#[ignore]` and un-block this test only once an owner adjudicates
//! the options-0/2/4/6 behaviour.
//!
//! WHAT THIS TEST PINS (the AGREED subset)
//! ---------------------------------------
//! ALL THREE interpretations agree that when the ignore-hidden bit is SET
//! (options 1/3/5/7) BOTH the filter-hidden AND the manually-hidden set are
//! excluded. The engine today excludes NEITHER (`IncludeAll`), so this asserts
//! the one number every reading agrees on and is currently RED on the VALUE
//! (not a panic/error): got the full sum, wanted the visible-only sum.
//!
//! The CONTESTED case (options 0/2/4/6, ignore-hidden bit CLEAR) is deliberately
//! NOT asserted here — filter-only vs manual-only vs neither is exactly what the
//! sources disagree on and what an owner must decide before any fix. When the
//! fix lands it should reuse the E3 seam (`SubtotalHiddenPolicy` +
//! `set_eval_hidden_rows` / `set_eval_filter_hidden_rows`), not a new mechanism.

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

/// AGGREGATE(9, opt, A1:A6) with opt ∈ {1,3,5,7} (ignore-hidden bit SET) must
/// drop BOTH the manually hidden row and the filter-hidden row under every
/// surviving Excel interpretation. The engine parses the bit but applies
/// `SubtotalHiddenPolicy::IncludeAll`, so it returns the full sum instead —
/// red on the value, proving the gap without fixing it.
#[test]
#[ignore = "PENDING DECISION: AGGREGATE ignore-hidden semantics contradictory across sources (#32 §6.3); red on purpose, proves the gap without a fix. Run with `--ignored`."]
fn aggregate_ignore_hidden_bit_excludes_both_sets_but_engine_ignores_it() {
    let mut wb = Workbook::new();
    // A1..A6 = rows 0..5, values 1..6 (no error values — this isolates the
    // ignore-hidden gap from the separate ignore-errors option). Full sum = 21.
    load_col(&mut wb, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);

    // Manually hide row 1 (A2 = 2) and filter-hide row 3 (A4 = 4).
    wb.set_eval_hidden_rows(0, &[1]);
    wb.set_eval_filter_hidden_rows(0, &[3]);

    // Visible-only sum every interpretation agrees on for the bit-set options:
    // 1 + 3 + 5 + 6 = 15.
    const VISIBLE_SUM: f64 = 15.0;
    for opt in [1, 3, 5, 7] {
        assert!(wb.set_formula(0, "C1", &format!("=AGGREGATE(9, {opt}, A1:A6)")));
        let got = num(&wb, "C1");
        assert_eq!(
            got, VISIBLE_SUM,
            "AGGREGATE(9, {opt}, A1:A6): with the ignore-hidden bit set every \
             Excel reading drops the manual-hidden A2 and the filter-hidden A4 \
             -> {VISIBLE_SUM}; engine returned {got} (bug: the options \
             ignore-hidden bit is parsed but never applied)"
        );
    }
}
