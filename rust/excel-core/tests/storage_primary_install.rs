//! STORAGE_PRIMARY Phase 6.1 acceptance (`docs/STORAGE_PRIMARY_PLAN.md`).
//!
//! Pins the storage-primary bulk install contract:
//!
//!   1. `install_sheet_bulk` produces the same readable state as the
//!      legacy `bulk_load` loader path.
//!   2. Install does ZERO dep-graph work — edges and hydrated formula
//!      records stay at 0 until first read.
//!   3. Reads hydrate lazily and exactly per-cell (Phase 2+3 machinery).
//!   4. Install is a full-sheet REPLACE: previous primitives, hydrated
//!      formulas, and lazy parking are gone.
//!   5. Cross-sheet formulas installed via the new path still notify
//!      subscribers on source mutation (the `!`-prefilter edge scan).
//!   6. Same-sheet formulas never pay the cross-sheet parse
//!      (`cross_sheet_parsed == 0`).
//!   7. The UI edit path (`Workbook::set_formula`) stays eager after an
//!      install (D1 = 4A unchanged).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use einfach_core::Value;
use einfach_excel_core::{CellAddress, InstallError, Workbook};

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).expect("test address must parse")
}

/// Shared workload: `N` primitives in column A, `N` point-ref formulas
/// in column B, plus a handful of range formulas in column C.
fn workload(n: u32) -> (HashMap<CellAddress, Value>, HashMap<CellAddress, String>) {
    let mut primitives = HashMap::new();
    let mut formulas = HashMap::new();
    for r in 1..=n {
        primitives.insert(addr(&format!("A{r}")), Value::Number(r as f64));
        formulas.insert(addr(&format!("B{r}")), format!("=A{r}*2"));
    }
    for r in 1..=n.min(5) {
        formulas.insert(addr(&format!("C{r}")), format!("=SUM(A1:A{r})"));
    }
    (primitives, formulas)
}

#[test]
fn install_then_read_matches_old_path() {
    const N: u32 = 50;
    let (primitives, formulas) = workload(N);

    // Old path: WorkbookLoader per-cell API.
    let mut old = Workbook::new();
    old.bulk_load(|loader| {
        for (a, v) in &primitives {
            loader.set_cell(0, &a.to_string_repr(), v.clone());
        }
        for (a, src) in &formulas {
            assert!(loader.set_formula(0, &a.to_string_repr(), src));
        }
    });

    // New path: storage-primary install.
    let mut new = Workbook::new();
    let stats = new
        .install_sheet_bulk(0, primitives.clone(), formulas.clone())
        .expect("install must succeed");
    assert_eq!(stats.primitives_installed, primitives.len());
    assert_eq!(stats.formulas_installed, formulas.len());

    // Every address reads identically through the workbook eval path.
    let all_addrs: Vec<CellAddress> = primitives.keys().chain(formulas.keys()).copied().collect();
    for a in all_addrs {
        let repr = a.to_string_repr();
        assert_eq!(
            new.get_cell("Sheet1", &repr),
            old.get_cell("Sheet1", &repr),
            "value mismatch at {repr}"
        );
    }
}

#[test]
fn install_does_zero_dep_work() {
    const N: u32 = 100;
    let (primitives, formulas) = workload(N);
    let formula_total = formulas.len();

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, formulas)
        .expect("install must succeed");

    let sheet = wb.sheet(0).expect("sheet 0 exists");
    let stats = sheet.debug_dep_graph_stats();
    assert_eq!(stats.formula_count, 0, "no formula hydrated before read");
    assert_eq!(stats.total_point_dep_edges, 0, "no point edges installed");
    assert_eq!(stats.total_range_dep_entries, 0, "no range edges installed");
    assert_eq!(
        sheet.debug_cell_dependents_key_count(),
        0,
        "cell_dependents must be empty"
    );
    // The formulas ARE there — just lazily parked.
    assert_eq!(sheet.debug_formula_count(), formula_total);
    assert_eq!(sheet.debug_imported_formula_count(), formula_total);
}

#[test]
fn install_then_read_hydrates_lazily() {
    const N: u32 = 100;
    let mut primitives = HashMap::new();
    let mut formulas = HashMap::new();
    for r in 1..=N {
        primitives.insert(addr(&format!("A{r}")), Value::Number(r as f64));
        formulas.insert(addr(&format!("B{r}")), format!("=A{r}+1"));
    }

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, formulas)
        .expect("install must succeed");

    // Read 3 of 100 formulas.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
    assert_eq!(wb.get_cell("Sheet1", "B50"), Value::Number(51.0));
    assert_eq!(wb.get_cell("Sheet1", "B100"), Value::Number(101.0));

    let stats = wb.sheet(0).expect("sheet 0 exists").debug_dep_graph_stats();
    assert_eq!(stats.formula_count, 3, "exactly the 3 read formulas hydrate");
    assert_eq!(
        stats.total_point_dep_edges, 3,
        "one point edge per hydrated =A{{r}}+1 formula"
    );
}

#[test]
fn install_replaces_previous_content() {
    let mut wb = Workbook::new();

    // Previous world: loader-path content, partially hydrated by reads.
    wb.bulk_load(|loader| {
        loader.set_cell(0, "A1", Value::Number(7.0));
        loader.set_cell(0, "X9", Value::Text("stale".into()));
        loader.set_formula(0, "B1", "=A1*10");
        loader.set_formula(0, "B2", "=SUM(A1:A5)");
    });
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(70.0)); // hydrates B1
    assert!(wb.sheet(0).unwrap().debug_dep_graph_stats().formula_count >= 1);
    let rev_before = wb.content_revision();

    // Replace with a brand-new world.
    let mut primitives = HashMap::new();
    primitives.insert(addr("A1"), Value::Number(100.0));
    let mut formulas = HashMap::new();
    formulas.insert(addr("D1"), "=A1+1".to_string());
    wb.install_sheet_bulk(0, primitives, formulas)
        .expect("install must succeed");

    // OD1: revision bumped so projections know the world changed.
    assert_eq!(wb.content_revision(), rev_before + 1);

    // Old state fully gone.
    assert_eq!(wb.get_cell("Sheet1", "X9"), Value::Null, "old primitive gone");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Null, "old hydrated formula gone");
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Null, "old lazy formula gone");
    assert_eq!(wb.sheet(0).unwrap().get_formula("B1"), None);

    // New state reads correctly.
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(100.0));
    assert_eq!(wb.get_cell("Sheet1", "D1"), Value::Number(101.0));

    // Post-read hydration reflects ONLY the new content.
    let stats = wb.sheet(0).unwrap().debug_dep_graph_stats();
    assert_eq!(stats.formula_count, 1);
    assert_eq!(wb.sheet(0).unwrap().debug_formula_count(), 1);
}

#[test]
fn install_cross_sheet_formula_notifies() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");

    // Sheet2!A1 source value through the new path too.
    let mut s2_primitives = HashMap::new();
    s2_primitives.insert(addr("A1"), Value::Number(1.0));
    let mut s1_formulas = HashMap::new();
    s1_formulas.insert(addr("B1"), "=Sheet2!A1+1".to_string());

    let stats = wb
        .install_workbook_bulk(vec![
            (0, HashMap::new(), s1_formulas),
            (s2, s2_primitives, HashMap::new()),
        ])
        .expect("install must succeed");
    assert_eq!(stats.len(), 2);
    assert_eq!(
        stats[0].cross_sheet_parsed, 1,
        "the `!` prefilter must route =Sheet2!A1+1 through the parse"
    );

    // Subscribe BEFORE any read — the formula is still unhydrated; the
    // notification must come from the prefilter-installed edge.
    let counter = Rc::new(RefCell::new(0usize));
    let counter_clone = counter.clone();
    let _sub = wb.sheet_mut(0).unwrap().subscribe_cell("B1", move || {
        *counter_clone.borrow_mut() += 1;
    });

    wb.set_cell(s2, "A1", Value::Number(5.0));
    assert_eq!(
        *counter.borrow(),
        1,
        "cross-sheet subscriber must fire when the source mutates"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));
}

#[test]
fn install_same_sheet_formulas_skip_parse() {
    const N: u32 = 100;
    let mut primitives = HashMap::new();
    let mut formulas = HashMap::new();
    for r in 1..=N {
        primitives.insert(addr(&format!("A{r}")), Value::Number(r as f64));
        formulas.insert(addr(&format!("B{r}")), format!("=A{r}+1"));
    }

    let mut wb = Workbook::new();
    let stats = wb
        .install_sheet_bulk(0, primitives, formulas)
        .expect("install must succeed");
    assert_eq!(stats.formulas_installed, N as usize);
    assert_eq!(
        stats.cross_sheet_parsed, 0,
        "same-sheet formulas must never pay the cross-sheet parse"
    );
}

#[test]
fn mutation_after_install_works() {
    const N: u32 = 10;
    let (primitives, formulas) = workload(N);

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, formulas)
        .expect("install must succeed");

    // UI edit path stays eager (D1 = 4A): set_formula parses + installs
    // the record at write time, no read required.
    assert!(wb.set_formula(0, "Z1", "=A1+A2"));
    let stats = wb.sheet(0).unwrap().debug_dep_graph_stats();
    assert_eq!(
        stats.formula_count, 1,
        "UI-path formula must hydrate eagerly at write time"
    );
    assert_eq!(wb.get_cell("Sheet1", "Z1"), Value::Number(3.0));

    // Primitive mutation invalidates the bulk-installed formula.
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));
    wb.set_cell(0, "A1", Value::Number(10.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(20.0));
}

#[test]
fn install_rejects_out_of_range_sheet() {
    let mut wb = Workbook::new();
    let err = wb
        .install_sheet_bulk(7, HashMap::new(), HashMap::new())
        .expect_err("sheet 7 does not exist");
    assert_eq!(err, InstallError::SheetOutOfRange(7));

    // Workbook-level variant validates up front — all-or-nothing.
    let mut a1_prims = HashMap::new();
    a1_prims.insert(addr("A1"), Value::Number(1.0));
    let rev_before = wb.content_revision();
    let err = wb
        .install_workbook_bulk(vec![(0, a1_prims, HashMap::new()), (9, HashMap::new(), HashMap::new())])
        .expect_err("sheet 9 does not exist");
    assert_eq!(err, InstallError::SheetOutOfRange(9));
    assert_eq!(wb.content_revision(), rev_before, "no partial install");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Null, "no partial install");
}
