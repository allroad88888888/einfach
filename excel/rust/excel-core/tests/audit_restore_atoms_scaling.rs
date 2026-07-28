//! AUDIT 2026-06-12 — pattern-family repros (restore / recalc / atom layer).
//!
//! Read-only audit artifacts: these tests pin the CURRENT behavior of the
//! paths flagged in `docs/AUDIT_PATTERN_FAMILY_2026-06-12.md` § B. They are
//! repros and micro-benches, NOT acceptance tests for fixes — when a finding
//! is fixed, update the pinned assertion alongside the fix.
//!
//! Timing notes: benches run in whatever profile `cargo test` uses (debug by
//! default). Absolute numbers are only meaningful relative to each other
//! within one run; assertions on time use generous ratios to stay
//! deterministic across machines.

use std::collections::HashMap;
use std::time::Instant;

use einfach_core::{Store, Value};
use einfach_excel_core::{CellAddress, Workbook};

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).expect("test address must parse")
}

/// Build the same workload twice: as (primitives, formulas) maps for the
/// storage-primary install path, and as a flat op list shaped like
/// `restore_sparse_cells` (excel/rust/wasm/src/lib.rs) feeds the legacy
/// `WorkbookLoader`.
fn workload(n: u32) -> (HashMap<CellAddress, Value>, HashMap<CellAddress, String>) {
    let mut primitives = HashMap::new();
    let mut formulas = HashMap::new();
    for r in 1..=n {
        primitives.insert(addr(&format!("A{r}")), Value::Number(r as f64));
        formulas.insert(addr(&format!("B{r}")), format!("=A{r}*2"));
    }
    (primitives, formulas)
}

/// FINDING B-1 (P-B): `restore_sparse` / `restore_persistence_v1` route
/// through `Workbook::bulk_load` + per-cell `WorkbookLoader::set_formula`,
/// which parses EVERY formula eagerly (workbook.rs `WorkbookLoader::
/// set_formula` — parse + cross-sheet cycle BFS + edge teardown/install +
/// per-op String×2 alloc), then DISCARDS the AST at flush
/// (`set_formula_pre_parsed` parks source text only) so hydration parses a
/// second time on first read. `install_workbook_bulk` (Phase 6.1) skips all
/// of it. This bench measures the same payload through both paths.
#[test]
fn audit_restore_legacy_loader_vs_storage_primary_install() {
    const N: u32 = 50_000;
    let (primitives, formulas) = workload(N);

    // --- Path A: storage-primary install (what bulk imports use) ---
    let mut wb_install = Workbook::new();
    let t0 = Instant::now();
    wb_install
        .install_workbook_bulk(vec![(0, primitives.clone(), formulas.clone())])
        .expect("install");
    let install_elapsed = t0.elapsed();

    // --- Path B: legacy loader, shaped exactly like restore_sparse_cells
    // (per-cell addr String round-trip included — restore_sparse_cells
    // calls `CellAddress::new(..).to_string_repr()` and the loader parses
    // it straight back). ---
    let mut wb_restore = Workbook::new();
    let t1 = Instant::now();
    wb_restore.bulk_load(|loader| {
        for (a, v) in &primitives {
            loader.set_cell(0, &a.to_string_repr(), v.clone());
        }
        for (a, src) in &formulas {
            loader.set_formula(0, &a.to_string_repr(), src);
        }
    });
    let restore_elapsed = t1.elapsed();

    // Same readable state either way.
    assert_eq!(wb_install.get_cell("Sheet1", "B7"), Value::Number(14.0));
    assert_eq!(wb_restore.get_cell("Sheet1", "B7"), Value::Number(14.0));

    let per_cell_install = install_elapsed.as_secs_f64() * 1e6 / (2.0 * N as f64);
    let per_cell_restore = restore_elapsed.as_secs_f64() * 1e6 / (2.0 * N as f64);
    println!(
        "AUDIT B-1: N={N} primitives + {N} formulas\n\
         install_workbook_bulk : {install_elapsed:?} ({per_cell_install:.2} us/cell)\n\
         legacy loader (restore shape): {restore_elapsed:?} ({per_cell_restore:.2} us/cell)\n\
         ratio: {:.1}x",
        restore_elapsed.as_secs_f64() / install_elapsed.as_secs_f64()
    );

    // The legacy path does strictly more per-cell work (parse, BFS, op
    // allocs); generous bound so the assertion never flakes.
    assert!(
        restore_elapsed.as_secs_f64() > install_elapsed.as_secs_f64() * 1.3,
        "expected legacy restore path to be measurably slower than install \
         (restore {restore_elapsed:?} vs install {install_elapsed:?}); if this \
         fails the restore path may have been migrated — update the audit doc"
    );
}

/// FINDING B-2 (P-A drift) — FIXED (lazy primitive-cell atomization).
/// `bulk_install_storage` now parks primitives as `CellSlot::Plain(Value)`
/// in the sheet's row-major map; NO core atom is allocated at install.
/// Atoms materialize on first subscribe / write / spill registration via
/// `ensure_cell`. The bench below keeps the original three-way comparison
/// (the `create_atom` loop is now the cost the install path AVOIDS) and
/// pins the zero-atom contract.
#[test]
fn audit_primitive_install_atom_alloc_share() {
    const N: u32 = 200_000;
    let (primitives, _) = workload(N);

    // Baseline 1: plain HashMap<CellAddress, Value> build (the "TS port
    // sheetAtom holds one Map" shape).
    let t0 = Instant::now();
    let plain: HashMap<CellAddress, Value> = primitives.clone();
    let plain_elapsed = t0.elapsed();
    assert_eq!(plain.len(), N as usize);

    // Baseline 2: the store half alone — N create_atom calls.
    let mut store = Store::new();
    let t1 = Instant::now();
    let mut last = None;
    for v in primitives.values() {
        last = Some(store.create_atom(v.clone()));
    }
    let atom_elapsed = t1.elapsed();
    assert!(last.is_some());

    // Full path: install_sheet_bulk with zero formulas (teardown is empty,
    // so this is the per-primitive atom-alloc + BTreeMap-insert loop).
    let mut wb = Workbook::new();
    let t2 = Instant::now();
    wb.install_workbook_bulk(vec![(0, primitives, HashMap::new())])
        .expect("install");
    let install_elapsed = t2.elapsed();
    assert_eq!(
        wb.sheet(0).unwrap().debug_primitive_atom_count(),
        N as usize
    );
    // B-2 FIXED pin: zero store atoms after a primitives-only install.
    assert_eq!(
        wb.sheet(0).unwrap().debug_total_atom_count(),
        0,
        "B-2 FIXED: install must not allocate any core atom"
    );

    println!(
        "AUDIT B-2 (FIXED): N={N} primitives\n\
         plain HashMap clone        : {plain_elapsed:?}\n\
         store.create_atom loop     : {atom_elapsed:?}\n\
         install_sheet_bulk (full)  : {install_elapsed:?}\n\
         atom-layer share of install: {:.0}%",
        100.0 * atom_elapsed.as_secs_f64() / install_elapsed.as_secs_f64()
    );
}

/// FINDING B-3 (P-A, corroborates A-1) — FIXED (W2.1). Structural edits
/// no longer call `hydrate_all_lazy_formulas()`: parked formulas are
/// retargeted by token-level source-text rewrite
/// (`shift::rewrite_parked_source`), hydrated ones by direct AST
/// install. The dep graph stays empty across the edit.
#[test]
fn audit_structural_edit_hydrates_every_parked_formula() {
    const N: u32 = 50_000;
    let (primitives, formulas) = workload(N);

    let mut wb = Workbook::new();
    wb.install_workbook_bulk(vec![(0, primitives, formulas)])
        .expect("install");

    // Everything is parked: zero dep-graph keys before the edit.
    assert_eq!(
        wb.sheet(0).unwrap().debug_point_dependency_key_count(),
        0,
        "install must leave formulas parked (lazy contract)"
    );

    let t0 = Instant::now();
    wb.sheet_mut(0).unwrap().insert_row(0, 1);
    let edit_elapsed = t0.elapsed();

    // B-3 / A-1 — FIXED (W2.1): the edit leaves the dep graph EMPTY.
    let dep_keys = wb.sheet(0).unwrap().debug_point_dependency_key_count();
    assert_eq!(
        dep_keys, 0,
        "A-1 FIXED: insert_row must leave every parked formula lazy \
         (got {dep_keys} dep keys)"
    );

    println!(
        "AUDIT B-3 (FIXED): insert_row(0,1) on {N}-formula parked sheet stayed \
         lazy: {edit_elapsed:?} ({:.2} us/formula), dep keys still {dep_keys}",
        edit_elapsed.as_secs_f64() * 1e6 / N as f64
    );
}

/// FINDING B-4 (P-C) — FIXED (W1.3). `collect_cross_sheet_refs` now
/// resolves `Expr::Name` / `Expr::FuncCall` targets through the
/// defined-name registry and walks LAMBDA bodies (with a visited-name
/// set guarding name cycles), so `=READDATA()` registers a real edge
/// into `Data!A1`; `define_name` additionally arms a workbook-level
/// latch for raw-sheet-path installs. Pin flipped to the FRESH value;
/// the wider matrix (notify, nesting, cycles, bulk install) lives in
/// tests/cross_sheet_propagation.rs.
#[test]
fn audit_named_lambda_cross_sheet_freshness() {
    let mut wb = Workbook::new();
    wb.add_sheet("Data");
    wb.set_cell(1, "A1", Value::Number(1.0));
    wb.define_name("READDATA", "=LAMBDA(Data!A1)")
        .expect("define named lambda");
    assert!(wb.set_formula(0, "B1", "=READDATA()"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(1.0));

    // Mutate the upstream cell through the workbook-routed path (the path
    // that DOES run cross-sheet dirty fanout for registered edges).
    wb.set_cell(1, "A1", Value::Number(2.0));
    let after = wb.get_cell("Sheet1", "B1");
    println!(
        "AUDIT B-4: =READDATA() (named lambda reading Data!A1) after upstream \
         write 1.0 -> 2.0 reads as {after:?} (fresh is Number(2.0))"
    );
    assert_eq!(
        after,
        Value::Number(2.0),
        "B-4 FIXED: the named-lambda cross-sheet read must serve the fresh \
         upstream value"
    );
}

/// CLEARED-PATH CHECK (suspect 6): snapshot paths never hydrate parked
/// formulas. `snapshot_sparse` reads `get_formula` (text-only) and
/// `peek_value` for primitives; a parked sheet stays parked.
#[test]
fn audit_snapshot_does_not_hydrate_parked_formulas() {
    const N: u32 = 5_000;
    let (primitives, formulas) = workload(N);
    let mut wb = Workbook::new();
    wb.install_workbook_bulk(vec![(0, primitives, formulas)])
        .expect("install");

    let sheet = wb.sheet(0).unwrap();
    assert_eq!(sheet.debug_point_dependency_key_count(), 0);
    let evals_before = sheet.debug_formula_eval_count();

    // Mirror what wasm `sparse_cell_from_sheet_no_eval` does per cell.
    let mut formula_count = 0usize;
    sheet.for_each_non_empty(|a| {
        let a_str = a.to_string();
        if sheet.get_formula(&a_str).is_some() {
            formula_count += 1;
        } else {
            let _ = sheet.peek_value(a);
        }
    });
    assert_eq!(formula_count, N as usize);
    assert_eq!(
        sheet.debug_formula_eval_count(),
        evals_before,
        "snapshot walk must not evaluate formulas"
    );
    assert_eq!(
        sheet.debug_point_dependency_key_count(),
        0,
        "snapshot walk must not hydrate parked formulas"
    );
}
