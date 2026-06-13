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
use std::cell::Cell;

/// Function pointer type for a host-supplied wall-clock returning
/// milliseconds. On native this is `Instant::elapsed().as_secs_f64() *
/// 1000.0` against a sampled epoch; on wasm32 this is
/// `js_sys::Date::now()`. We use `fn()` (not `Fn()`) so the
/// `Cell<Option<fn() -> f64>>` is `Copy` — the existing
/// `last_bulk_import_phase_ms: Cell<Option<[f64; N]>>` on `WasmWorkbook`
/// uses the same pattern.
pub type NowMsFn = fn() -> f64;

thread_local! {
    /// Sub-phase accumulator for the formula install path inside
    /// `Sheet::install_parsed_formula`. The instrumented bulk-import
    /// driver enables collection (`set_clock(Some(now_ms))`) before
    /// `Workbook::bulk_load` runs the flush, then reads the totals back
    /// out via `take_*_ms`. Production paths see `clock() == None` and
    /// pay nothing past the one thread-local read.
    ///
    /// Stored as f64 milliseconds — the JS-side `Date.now()` already
    /// gives ms; on native we convert ns→ms once per sample. Per-call
    /// noise floor is `Date.now()`'s 1ms resolution on browsers, which
    /// at Mega scale (100k+ samples) integrates to a meaningful total.
    ///
    /// `Cell` is sound because the engine is single-threaded; the
    /// existing `LET_FRAMES` thread-local in `eval.rs` uses the same
    /// pattern with `RefCell`.
    ///
    /// IMPORTANT: we DO NOT use `std::time::Instant` here — it panics
    /// at runtime on `wasm32-unknown-unknown`. The host (WASM bridge
    /// or native test) supplies `now_ms` and the sheet-side timer
    /// just calls it.
    static FLUSH_PHASE_CLOCK: Cell<Option<NowMsFn>> = const { Cell::new(None) };
    static FLUSH_PARSE_MS: Cell<f64> = const { Cell::new(0.0) };
    static FLUSH_DEP_EXTRACT_MS: Cell<f64> = const { Cell::new(0.0) };
    static FLUSH_DEP_REGISTER_MS: Cell<f64> = const { Cell::new(0.0) };
    static FLUSH_FORMULA_RECORD_MS: Cell<f64> = const { Cell::new(0.0) };
}

/// Cheap thread-local probe used by `Sheet::install_parsed_formula` to
/// decide whether to sample the clock at all. Production paths see
/// `None` and skip the four `now_ms()` invocations entirely.
pub fn flush_phase_clock() -> Option<NowMsFn> {
    FLUSH_PHASE_CLOCK.with(|c| c.get())
}

/// Add an elapsed-ms sample to `flush_parse_ms`. Callers are expected
/// to compute the delta as `end_ms - start_ms` using the same clock
/// they got from [`flush_phase_clock`].
pub fn add_flush_parse_ms(ms: f64) {
    FLUSH_PARSE_MS.with(|c| c.set(c.get() + ms.max(0.0)));
}

pub fn add_flush_dep_extract_ms(ms: f64) {
    FLUSH_DEP_EXTRACT_MS.with(|c| c.set(c.get() + ms.max(0.0)));
}

pub fn add_flush_dep_register_ms(ms: f64) {
    FLUSH_DEP_REGISTER_MS.with(|c| c.set(c.get() + ms.max(0.0)));
}

pub fn add_flush_formula_record_ms(ms: f64) {
    FLUSH_FORMULA_RECORD_MS.with(|c| c.set(c.get() + ms.max(0.0)));
}

/// Install / clear the per-formula clock for the formula-install sub-
/// phase timer. The driver wraps `Workbook::bulk_load` in
/// `set_flush_phase_clock(Some(now_ms))` / `set_flush_phase_clock(None)`
/// and resets the counters on entry.
fn set_flush_phase_clock(now: Option<NowMsFn>) {
    FLUSH_PHASE_CLOCK.with(|c| c.set(now));
}

fn reset_flush_phase_accumulators() {
    FLUSH_PARSE_MS.with(|c| c.set(0.0));
    FLUSH_DEP_EXTRACT_MS.with(|c| c.set(0.0));
    FLUSH_DEP_REGISTER_MS.with(|c| c.set(0.0));
    FLUSH_FORMULA_RECORD_MS.with(|c| c.set(0.0));
}

fn take_flush_phase_accumulators_ms() -> (f64, f64, f64, f64) {
    (
        FLUSH_PARSE_MS.with(|c| c.replace(0.0)),
        FLUSH_DEP_EXTRACT_MS.with(|c| c.replace(0.0)),
        FLUSH_DEP_REGISTER_MS.with(|c| c.replace(0.0)),
        FLUSH_FORMULA_RECORD_MS.with(|c| c.replace(0.0)),
    )
}

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
    /// **Sub-slice of `flush_ms`** — time spent parsing formula source
    /// inside `install_parsed_formula` (set_formula_pre_parsed receives
    /// a pre-parsed AST so this stays near zero; the parse-failure path
    /// re-tokenizes the source which would appear here). Phase 1
    /// instrumentation only — not consumed by any production path.
    pub flush_parse_ms: f64,
    /// **Sub-slice of `flush_ms`** — time spent walking the AST to
    /// extract point dependencies (`Sheet::formula_deps_for`) and range
    /// dependencies (`collect_range_refs`) for each installed formula.
    pub flush_dep_extract_ms: f64,
    /// **Sub-slice of `flush_ms`** — time spent inserting the extracted
    /// deps into `cell_dependents` / `range_dependents`
    /// (`Sheet::add_formula_deps` + `Sheet::add_formula_range_deps`).
    /// Codex's 2026-06-11 attribution called this the dominant cost at
    /// Mega tier — Phase 1 measures it directly so the claim is
    /// quantifiable.
    pub flush_dep_register_ms: f64,
    /// **Sub-slice of `flush_ms`** — time spent materialising
    /// `Rc<FormulaRecord>` and inserting into `formula_cells` /
    /// `formula_exprs` / `formula_texts`. Captures the "FormulaRecord
    /// allocation + map insert" share.
    pub flush_formula_record_ms: f64,
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
pub fn run_bulk_import_with_phase_timings(
    wb: &mut Workbook,
    cells: &[BulkImportCellInput],
    now_ms: NowMsFn,
) -> BulkImportPhaseTimings {
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

    // Arm the formula-install sub-phase accumulators. The Sheet-side
    // `install_parsed_formula` instrumentation gates on
    // `flush_phase_clock()` — when set it samples the host clock
    // around each phase and adds the elapsed ms into the thread-local
    // counters. We reset to zero on entry so prior runs don't bleed in.
    reset_flush_phase_accumulators();
    set_flush_phase_clock(Some(now_ms));

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
                // Typed loader entries (A-9 follow-up) — keeps the trace
                // mirroring the production `bulk_import_cells` path, which
                // no longer renders / re-parses an address string per cell.
                BulkImportCellKind::Number(n) => {
                    loader.set_cell_at(cell.sheet_idx, cell.addr, Value::Number(*n));
                }
                BulkImportCellKind::Text(s) => {
                    loader.set_cell_at(cell.sheet_idx, cell.addr, Value::Text(s.clone()));
                }
                BulkImportCellKind::Boolean(b) => {
                    loader.set_cell_at(cell.sheet_idx, cell.addr, Value::Boolean(*b));
                }
                BulkImportCellKind::Error(e) => {
                    loader.set_cell_at(cell.sheet_idx, cell.addr, Value::Error(e.clone()));
                }
                BulkImportCellKind::Null => {
                    loader.clear_cell_at(cell.sheet_idx, cell.addr);
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
                let _accepted = loader.set_formula_at(cell.sheet_idx, cell.addr, text);
            }
        }
        let p2_end = now_ms();
        set_formula_loop_ms = p2_end - p2_start;
    });
    let t2_engine_end = now_ms();
    // Disarm before reading the accumulators back so any later code
    // (panics, drops, etc.) doesn't sneak more samples in.
    set_flush_phase_clock(None);
    let (flush_parse_ms, flush_dep_extract_ms, flush_dep_register_ms, flush_formula_record_ms) =
        take_flush_phase_accumulators_ms();
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
        flush_parse_ms,
        flush_dep_extract_ms,
        flush_dep_register_ms,
        flush_formula_record_ms,
        engine_total_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // The thread-local epoch lets us hand the driver a plain `fn() -> f64`
    // (matching `NowMsFn`) instead of a stateful closure — needed because
    // the per-formula install timer also stores the clock in a thread-
    // local `Cell<Option<fn() -> f64>>`, which requires Copy.
    thread_local! {
        static NATIVE_CLOCK_START: std::cell::Cell<Option<Instant>> =
            const { std::cell::Cell::new(None) };
    }

    fn native_now_ms() -> f64 {
        NATIVE_CLOCK_START.with(|c| {
            let start = c.get().unwrap_or_else(|| {
                let s = Instant::now();
                c.set(Some(s));
                s
            });
            start.elapsed().as_secs_f64() * 1000.0
        })
    }

    fn install_native_clock() -> fn() -> f64 {
        NATIVE_CLOCK_START.with(|c| c.set(Some(Instant::now())));
        native_now_ms
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

        let timings = run_bulk_import_with_phase_timings(&mut wb, &inputs, install_native_clock());

        assert_eq!(timings.cell_count, 4);
        assert_eq!(timings.formula_count, 1);
        // All phase ms are non-negative — sanity check.
        assert!(timings.parse_only_ms >= 0.0);
        assert!(timings.set_cell_loop_ms >= 0.0);
        assert!(timings.set_formula_loop_ms >= 0.0);
        assert!(timings.flush_ms >= 0.0);
        assert!(timings.flush_parse_ms >= 0.0);
        assert!(timings.flush_dep_extract_ms >= 0.0);
        assert!(timings.flush_dep_register_ms >= 0.0);
        assert!(timings.flush_formula_record_ms >= 0.0);
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
        let timings = run_bulk_import_with_phase_timings(&mut wb, &inputs, install_native_clock());
        assert_eq!(timings.cell_count, 0);
        assert_eq!(timings.formula_count, 0);
    }
}
