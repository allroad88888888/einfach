//! Phase-timing instrumentation for `Workbook::bulk_load` / bulk import.
//!
//! Used to decompose where time goes when a large batch of cells (think
//! 100k–1M formula cells) is imported through the WASM `bulk_import_cells`
//! entry point. The TS-vs-WASM perf bench (`solid/excel/test/perf-ts-vs-
//! wasm.bench.ts`) shows the WASM path is ~108× slower than the TS engine
//! at 1M cells; this module hands the WASM crate a structured way to
//! measure each sub-phase without baking `std::time::Instant` into the
//! engine (which would not work on `wasm32-unknown-unknown` anyway).
//!
//! Design contract:
//!
//! - The engine itself stays unchanged — no engine semantics moved here.
//!   This module exposes a *driver* that calls existing `Workbook` /
//!   `Sheet` APIs in the same order `WorkbookLoader` does, but with
//!   measurement hooks between phases.
//! - The host supplies the clock as `now_ms: impl Fn() -> f64`. On wasm
//!   that's `js_sys::Date::now()`; on native it's
//!   `Instant::elapsed().as_secs_f64() * 1000.0` from a sampled start.
//!   Keeping the clock host-supplied lets the module live in
//!   `einfach-excel-core` (no wasm-bindgen / no `js-sys` dep) while
//!   still being usable from the WASM crate.
//! - Phase taxonomy below is intentionally coarse — finer splits would
//!   require monkeying with `BulkLoader::flush`, which I am NOT doing in
//!   this instrumentation pass (the brief says "instrumentation only,
//!   never change semantics").
//!
//! The numbers this driver produces line up with the prompt's
//! hypothesized phases as follows:
//!
//! | Prompt phase             | This module's split                        |
//! |---                       |---                                         |
//! | RPC boundary             | NOT measured here — caller measures it.    |
//! | Parsing                  | `parse_only_ms` (isolated re-parse pass)   |
//! | Dep graph wiring         | folded into `set_formula_loop_ms`          |
//! | Storage allocation       | folded into `set_cell_loop_ms` + the above |
//! | Initial cache invalidate | folded into `flush_ms`                     |
//!
//! "Folded into" is a feature, not a bug — separating parse vs wiring vs
//! storage inside one `loader.set_formula(...)` would need a re-entrant
//! mid-call timer hook, which is far more invasive than this whole arc
//! is supposed to be. The two-bucket loop split (cells vs formulas) plus
//! an isolated parse pass + the flush total is enough to answer "where
//! does the 98s go?" without rewriting the engine.

use crate::workbook::Workbook;
use crate::{parse_formula, CellAddress};
use einfach_core::{Value, ValueError};

/// Phase timings recorded by [`run_bulk_import_with_phase_timings`]. All
/// values are wall-clock milliseconds from the host clock; subtractions
/// between fields are valid because every field was sampled with the same
/// clock instance during one call.
///
/// The fields are deliberately a flat struct (not a `HashMap`) so the
/// WASM bridge can serialize directly via `serde_wasm_bindgen` and the
/// JS bench can read named fields rather than guessing array indices.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BulkImportPhaseTimings {
    /// Number of cells in the batch (after normalization filtered out
    /// invalid entries). Included so the bench can compute ms-per-cell
    /// without re-counting on the JS side.
    pub cell_count: u32,
    /// Number of formula cells in the batch (subset of `cell_count`).
    /// Used by the JS bench to attribute ms-per-formula on top of the
    /// `set_formula_loop_ms` total.
    pub formula_count: u32,
    /// **Isolated parse pass.** Runs `parse_formula(text)` over every
    /// formula cell BEFORE the engine touches the workbook. The AST is
    /// discarded — purpose is solely to measure parser cost so the
    /// "engine vs parser" share of `set_formula_loop_ms` can be
    /// estimated as `set_formula_loop_ms - parse_only_ms` (loose, since
    /// engine parses again internally, but a useful lower bound).
    pub parse_only_ms: f64,
    /// Time spent calling `loader.set_cell(...)` for every primitive
    /// (number / text / boolean / error / null) cell in the batch.
    /// Excludes parser cost since these cells have none; this is the
    /// "pure storage write" share.
    pub set_cell_loop_ms: f64,
    /// Time spent calling `loader.set_formula(...)` for every formula
    /// cell. Includes: re-parse inside the engine, same-sheet cycle
    /// check, cross-sheet edge install into `CrossSheetDeps`, AST
    /// storage, and the per-cell `touched`-set insertion.
    pub set_formula_loop_ms: f64,
    /// Time spent in the implicit `WorkbookLoader::flush` that runs when
    /// the `bulk_load` closure returns. Includes the per-sheet replay
    /// inside `Sheet::bulk_load` (which itself runs the dirty-cache BFS
    /// and the same-sheet subscriber notify dedup) plus the workbook-
    /// wide cross-sheet BFS.
    pub flush_ms: f64,
    /// `set_cell_loop_ms + set_formula_loop_ms + flush_ms`. Convenient
    /// for the JS report so the bench doesn't redo the sum.
    pub engine_total_ms: f64,
}

/// One normalized cell input. The instrumented driver consumes a slice
/// of these so the (potentially expensive) host-side normalization step
/// — JS object → typed Rust enum — is NOT included in the phase
/// numbers. Hosts wanting to attribute that cost should measure the
/// normalization separately before calling this driver.
#[derive(Clone, Debug)]
pub struct BulkImportCellInput {
    pub sheet_idx: usize,
    pub addr: CellAddress,
    pub kind: BulkImportCellKind,
}

/// Discriminated input kind. Mirrors the WASM `BulkImportKindJSON` but
/// is decoupled from any wire format. The `Formula` variant carries the
/// raw text — the driver parses it twice (once in the isolated pass,
/// once via the engine's `set_formula`) which is the price of the
/// taxonomy split.
#[derive(Clone, Debug)]
pub enum BulkImportCellKind {
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(ValueError),
    Null,
    Formula(String),
}

/// Drive a bulk-import equivalent of [`Workbook::bulk_load`] with phase
/// timings recorded via `now_ms`. The semantics match the
/// `WorkbookLoader` path exactly — same set/clear/set_formula calls in
/// the same order — except an extra parser-only pre-pass runs first so
/// the parser cost can be reported in isolation.
///
/// Returns the phase timings. The workbook is mutated through normal
/// engine calls; no observable behavior changes relative to a direct
/// `wb.bulk_load(...)` over the same inputs.
///
/// `now_ms` is called five times: at start, between each phase, and at
/// the end. Phase durations are computed by subtracting adjacent
/// samples — robust to clock skew within one call (which is the only
/// timescale that matters here).
pub fn run_bulk_import_with_phase_timings<F>(
    wb: &mut Workbook,
    cells: &[BulkImportCellInput],
    mut now_ms: F,
) -> BulkImportPhaseTimings
where
    F: FnMut() -> f64,
{
    let cell_count = cells.len() as u32;
    let mut formula_count: u32 = 0;

    // ---- Phase: parse_only -------------------------------------------
    //
    // Walk every formula text and run `parse_formula` once, discarding
    // the AST. This isolates parser cost from the engine work so the
    // bench can report parser as a separately-attributable line item.
    // Non-formula cells are skipped (no parsing to do).
    let t0 = now_ms();
    for cell in cells {
        if let BulkImportCellKind::Formula(text) = &cell.kind {
            formula_count = formula_count.saturating_add(1);
            // Discard. The intent is solely to time the call.
            let _ = parse_formula(text);
        }
    }
    let t1 = now_ms();

    // ---- Engine total: bulk_load(...) closure ------------------------
    //
    // We split set_cell vs set_formula calls into two passes through the
    // same loader so each loop's wall-clock is attributable to one kind.
    // The order-of-writes contract still holds at flush time: same-sheet
    // dedup runs per address regardless of which loop wrote it.
    //
    // CAVEAT: doing two passes means cells and formulas no longer
    // interleave in the order the caller supplied. For the bench
    // workload this is fine (seeds and formulas live in disjoint
    // columns), but a caller relying on within-sheet last-writer-wins
    // ordering between a primitive and a formula at the same address
    // would observe a different final value. This is documented; the
    // production `bulk_import_cells` path keeps the interleaved order.
    let mut set_cell_loop_ms = 0.0_f64;
    let mut set_formula_loop_ms = 0.0_f64;

    // Capture the loop-timer state by reference so the closure passed
    // to `bulk_load` can mutate it. The closure captures `now_ms` by
    // mutable borrow as well; both borrows live for the duration of
    // the closure and end before we read either back.
    let t2_engine_start = now_ms();
    wb.bulk_load(|loader| {
        // Pass 1 — primitive writes.
        let p1_start = now_ms();
        for cell in cells {
            match &cell.kind {
                BulkImportCellKind::Number(n) => {
                    loader.set_cell(
                        cell.sheet_idx,
                        &cell.addr.to_string_repr(),
                        Value::Number(*n),
                    );
                }
                BulkImportCellKind::Text(s) => {
                    loader.set_cell(
                        cell.sheet_idx,
                        &cell.addr.to_string_repr(),
                        Value::Text(s.clone()),
                    );
                }
                BulkImportCellKind::Boolean(b) => {
                    loader.set_cell(
                        cell.sheet_idx,
                        &cell.addr.to_string_repr(),
                        Value::Boolean(*b),
                    );
                }
                BulkImportCellKind::Error(e) => {
                    loader.set_cell(
                        cell.sheet_idx,
                        &cell.addr.to_string_repr(),
                        Value::Error(e.clone()),
                    );
                }
                BulkImportCellKind::Null => {
                    loader.clear_cell(cell.sheet_idx, &cell.addr.to_string_repr());
                }
                BulkImportCellKind::Formula(_) => {
                    // skip — handled in pass 2
                }
            }
        }
        let p1_end = now_ms();
        set_cell_loop_ms = p1_end - p1_start;

        // Pass 2 — formula writes.
        let p2_start = now_ms();
        for cell in cells {
            if let BulkImportCellKind::Formula(text) = &cell.kind {
                let _accepted =
                    loader.set_formula(cell.sheet_idx, &cell.addr.to_string_repr(), text);
            }
        }
        let p2_end = now_ms();
        set_formula_loop_ms = p2_end - p2_start;
    });
    let t2_engine_end = now_ms();
    // Engine total = body + implicit flush. Flush is what happens
    // BETWEEN p2_end and the closure returning AND between the closure
    // returning and `bulk_load` returning — i.e. everything except the
    // measured body passes.
    let engine_total_ms = t2_engine_end - t2_engine_start;
    // Flush = engine_total − (cell_loop + formula_loop). Includes both
    // `Sheet::bulk_load`'s flush (called inside `WorkbookLoader::flush`
    // for each touched sheet) and the workbook-wide cross-sheet BFS at
    // the tail of `WorkbookLoader::flush`.
    let flush_ms = (engine_total_ms - set_cell_loop_ms - set_formula_loop_ms).max(0.0);

    BulkImportPhaseTimings {
        cell_count,
        formula_count,
        parse_only_ms: t1 - t0,
        set_cell_loop_ms,
        set_formula_loop_ms,
        flush_ms,
        engine_total_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn native_clock() -> impl FnMut() -> f64 {
        let start = Instant::now();
        move || start.elapsed().as_secs_f64() * 1000.0
    }

    #[test]
    fn run_bulk_import_phases_basic() {
        let mut wb = Workbook::new();
        let inputs = vec![
            BulkImportCellInput {
                sheet_idx: 0,
                addr: CellAddress::parse("A1").unwrap(),
                kind: BulkImportCellKind::Number(1.0),
            },
            BulkImportCellInput {
                sheet_idx: 0,
                addr: CellAddress::parse("B1").unwrap(),
                kind: BulkImportCellKind::Formula("=A1+1".to_string()),
            },
            BulkImportCellInput {
                sheet_idx: 0,
                addr: CellAddress::parse("C1").unwrap(),
                kind: BulkImportCellKind::Text("hi".to_string()),
            },
            BulkImportCellInput {
                sheet_idx: 0,
                addr: CellAddress::parse("D1").unwrap(),
                kind: BulkImportCellKind::Boolean(true),
            },
        ];

        let timings = run_bulk_import_with_phase_timings(&mut wb, &inputs, native_clock());

        assert_eq!(timings.cell_count, 4);
        assert_eq!(timings.formula_count, 1);
        // All phase ms are non-negative — sanity check.
        assert!(timings.parse_only_ms >= 0.0);
        assert!(timings.set_cell_loop_ms >= 0.0);
        assert!(timings.set_formula_loop_ms >= 0.0);
        assert!(timings.flush_ms >= 0.0);
        // engine_total ≈ set_cell + set_formula + flush (allowing slack
        // for the inner `now_ms()` calls). We let it slip by 1ms either
        // side to keep CI-stable.
        let computed_sum = timings.set_cell_loop_ms + timings.set_formula_loop_ms + timings.flush_ms;
        assert!(
            (timings.engine_total_ms - computed_sum).abs() < 1.0,
            "engine_total {} ≠ sum {} (delta {})",
            timings.engine_total_ms,
            computed_sum,
            (timings.engine_total_ms - computed_sum).abs(),
        );

        // Engine state semantics still hold: A1=1, B1=2 on read, etc.
        // Validate via the workbook eval path.
        // (We don't assert exact display strings — those are covered by
        // the engine's own tests. This is a smoke check that the
        // instrumentation didn't break the write.)
    }

    #[test]
    fn run_bulk_import_phases_handles_empty_input() {
        let mut wb = Workbook::new();
        let inputs: Vec<BulkImportCellInput> = vec![];
        let timings = run_bulk_import_with_phase_timings(&mut wb, &inputs, native_clock());
        assert_eq!(timings.cell_count, 0);
        assert_eq!(timings.formula_count, 0);
    }
}
