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
fn install_dirties_and_notifies_cross_sheet_dependents() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    let s3 = wb.add_sheet("Sheet3");
    wb.set_cell(s2, "A1", Value::Number(1.0));
    assert!(wb.set_formula(0, "B1", "=Sheet2!A1+1"));
    // Chained cross-sheet dependent: Sheet3!C1 → Sheet1!B1 → Sheet2!A1.
    assert!(wb.set_formula(s3, "C1", "=Sheet1!B1*10"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0)); // hydrated + cached
    assert_eq!(wb.get_cell("Sheet3", "C1"), Value::Number(20.0));

    let direct = Rc::new(RefCell::new(0usize));
    let direct_clone = direct.clone();
    let _sub_direct = wb.sheet_mut(0).unwrap().subscribe_cell("B1", move || {
        *direct_clone.borrow_mut() += 1;
    });
    let chained = Rc::new(RefCell::new(0usize));
    let chained_clone = chained.clone();
    let _sub_chained = wb.sheet_mut(s3).unwrap().subscribe_cell("C1", move || {
        *chained_clone.borrow_mut() += 1;
    });

    // Replace Sheet2 entirely via the storage-primary path.
    let mut prims = HashMap::new();
    prims.insert(addr("A1"), Value::Number(10.0));
    wb.install_sheet_bulk(s2, prims, HashMap::new())
        .expect("install must succeed");

    assert_eq!(
        *direct.borrow(),
        1,
        "cross-sheet subscriber must fire exactly once on install"
    );
    assert_eq!(
        *chained.borrow(),
        1,
        "chained cross-sheet subscriber must fire exactly once on install"
    );
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Number(11.0),
        "dependent must recompute"
    );
    assert_eq!(
        wb.get_cell("Sheet3", "C1"),
        Value::Number(110.0),
        "chained dependent must recompute"
    );
}

#[test]
fn install_removing_referenced_cell_matches_set_cell_null() {
    // Control: what does writing Null to the source produce?
    let mut control = Workbook::new();
    let c2 = control.add_sheet("Sheet2");
    control.set_cell(c2, "A1", Value::Number(1.0));
    assert!(control.set_formula(0, "B1", "=Sheet2!A1+1"));
    assert_eq!(control.get_cell("Sheet1", "B1"), Value::Number(2.0));
    control.set_cell(c2, "A1", Value::Null);
    let expected = control.get_cell("Sheet1", "B1");

    // Install path: the replaced sheet simply omits A1.
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    wb.set_cell(s2, "A1", Value::Number(1.0));
    assert!(wb.set_formula(0, "B1", "=Sheet2!A1+1"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(2.0));

    let counter = Rc::new(RefCell::new(0usize));
    let counter_clone = counter.clone();
    let _sub = wb.sheet_mut(0).unwrap().subscribe_cell("B1", move || {
        *counter_clone.borrow_mut() += 1;
    });

    wb.install_sheet_bulk(s2, HashMap::new(), HashMap::new())
        .expect("install must succeed");

    assert_eq!(
        *counter.borrow(),
        1,
        "subscriber must fire when source vanishes"
    );
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        expected,
        "removed source must read like a set_cell-to-Null write"
    );
}

#[test]
fn install_notifies_lazy_unhydrated_cross_sheet_dependent() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    wb.set_cell(s2, "A1", Value::Number(1.0));

    // The dependent itself arrives via install — lazy, never read, so it
    // has no cached value to dirty. Its subscriber must still fire.
    let mut s1_formulas = HashMap::new();
    s1_formulas.insert(addr("B1"), "=Sheet2!A1+1".to_string());
    wb.install_sheet_bulk(0, HashMap::new(), s1_formulas)
        .expect("install must succeed");

    let counter = Rc::new(RefCell::new(0usize));
    let counter_clone = counter.clone();
    let _sub = wb.sheet_mut(0).unwrap().subscribe_cell("B1", move || {
        *counter_clone.borrow_mut() += 1;
    });

    let mut prims = HashMap::new();
    prims.insert(addr("A1"), Value::Number(41.0));
    wb.install_sheet_bulk(s2, prims, HashMap::new())
        .expect("install must succeed");

    assert_eq!(
        *counter.borrow(),
        1,
        "lazy dependent's subscriber must fire on install"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(42.0));
}

#[test]
fn workbook_bulk_install_notifies_multi_sheet_dependent_once() {
    let mut wb = Workbook::new();
    let s2 = wb.add_sheet("Sheet2");
    let s3 = wb.add_sheet("Sheet3");
    wb.set_cell(s2, "A1", Value::Number(1.0));
    wb.set_cell(s3, "A1", Value::Number(2.0));
    assert!(wb.set_formula(0, "B1", "=Sheet2!A1+Sheet3!A1"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(3.0));

    let counter = Rc::new(RefCell::new(0usize));
    let counter_clone = counter.clone();
    let _sub = wb.sheet_mut(0).unwrap().subscribe_cell("B1", move || {
        *counter_clone.borrow_mut() += 1;
    });

    // Replace BOTH referenced sheets in one workbook-level install. The
    // dependent references both, but its subscriber must fire ONCE.
    let mut s2_prims = HashMap::new();
    s2_prims.insert(addr("A1"), Value::Number(10.0));
    let mut s3_prims = HashMap::new();
    s3_prims.insert(addr("A1"), Value::Number(20.0));
    wb.install_workbook_bulk(vec![
        (s2, s2_prims, HashMap::new()),
        (s3, s3_prims, HashMap::new()),
    ])
    .expect("install must succeed");

    assert_eq!(
        *counter.borrow(),
        1,
        "dependent referencing two replaced sheets must notify once, not twice"
    );
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(30.0));
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

// === AUDIT B-2 (lazy primitive-cell atomization) acceptance pins ===
//
// `bulk_install_storage` parks primitives as `CellSlot::Plain(Value)` —
// no core store atom per cell. Atoms materialize on first subscribe /
// write / spill registration through `ensure_cell`. These pins guard the
// "atoms allocate on demand, behavior identical" contract.

/// Pin 1: a primitives-only install at the audit's 200k tier allocates
/// ZERO store atoms — the storage map is the only per-cell cost. Reads
/// serve parked values directly.
#[test]
fn install_primitives_allocates_zero_atoms_at_200k() {
    const N: u32 = 200_000;
    let mut primitives = HashMap::new();
    for r in 1..=N {
        primitives.insert(addr(&format!("A{r}")), Value::Number(r as f64));
    }

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, HashMap::new())
        .expect("install must succeed");

    let sheet = wb.sheet(0).expect("sheet 0 exists");
    assert_eq!(
        sheet.debug_primitive_atom_count(),
        N as usize,
        "every primitive must be present as a slot"
    );
    assert_eq!(
        sheet.debug_materialized_cell_atom_count(),
        0,
        "B-2 pin: install must not materialize any cell atom"
    );
    assert_eq!(
        sheet.debug_total_atom_count(),
        0,
        "B-2 pin: the core store must hold zero atoms after install"
    );

    // Reads serve the parked values without materializing.
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "A200000"), Value::Number(200000.0));
    assert_eq!(wb.sheet(0).unwrap().debug_total_atom_count(), 0);
}

/// Pin 2a: subscribe-after-install still fires on write — and only for
/// the watched cell (lazy extreme: unwatched writes fire nothing).
#[test]
fn subscribe_after_install_fires_on_write() {
    let mut primitives = HashMap::new();
    primitives.insert(addr("A1"), Value::Number(1.0));
    primitives.insert(addr("A2"), Value::Number(2.0));

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, HashMap::new())
        .expect("install must succeed");

    let counter = Rc::new(RefCell::new(0usize));
    let counter_clone = counter.clone();
    let _sub = wb.sheet_mut(0).unwrap().subscribe_cell("A1", move || {
        *counter_clone.borrow_mut() += 1;
    });
    // Subscribing promotes the parked slot so the fanout has an atom to
    // attach to — bounded by subscription count, not sheet size.
    assert_eq!(
        wb.sheet(0).unwrap().debug_materialized_cell_atom_count(),
        1,
        "exactly the subscribed address materializes"
    );

    wb.set_cell(0, "A1", Value::Number(10.0));
    assert_eq!(*counter.borrow(), 1, "watched write must fire once");

    // Same-value write dedups exactly like the eager-atom path did.
    wb.set_cell(0, "A1", Value::Number(10.0));
    assert_eq!(*counter.borrow(), 1, "same-value write must not fire");

    // Unwatched cell write fires nothing for A1's listener.
    wb.set_cell(0, "A2", Value::Number(20.0));
    assert_eq!(*counter.borrow(), 1, "unwatched write must not fire");
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(10.0));
}

/// Pin 2b: a formula installed AFTER a lazy primitive install still
/// tracks its dependency — writing the parked source cell dirties and
/// re-evaluates the derived read.
#[test]
fn derive_read_after_install_tracks_parked_primitive() {
    let mut primitives = HashMap::new();
    primitives.insert(addr("A1"), Value::Number(3.0));

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, HashMap::new())
        .expect("install must succeed");

    assert!(wb.set_formula(0, "B1", "=A1*2"));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(6.0));

    // Write through the workbook path: the parked A1 promotes, the
    // dependent formula goes dirty, the next read is fresh.
    wb.set_cell(0, "A1", Value::Number(5.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(10.0));
}

/// Pin 3: structural edits relocate parked plain values alongside
/// materialized atoms (the `relocate_cells` value-map shift).
#[test]
fn structural_edit_relocates_parked_primitives() {
    let mut primitives = HashMap::new();
    primitives.insert(addr("A1"), Value::Number(1.0));
    primitives.insert(addr("A5"), Value::Number(5.0));

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, HashMap::new())
        .expect("install must succeed");
    assert_eq!(wb.sheet(0).unwrap().debug_total_atom_count(), 0);

    wb.sheet_mut(0).unwrap().insert_row(0, 1);

    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Null);
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(1.0));
    assert_eq!(wb.get_cell("Sheet1", "A6"), Value::Number(5.0));
    assert_eq!(
        wb.sheet(0).unwrap().debug_total_atom_count(),
        0,
        "a structural edit must not materialize parked primitives"
    );
}

/// Pin 4: a spill landing where a parked primitive lives still collides
/// (#SPILL!), exactly like the eager-atom behavior.
#[test]
fn spill_collision_with_parked_primitive() {
    let mut primitives = HashMap::new();
    primitives.insert(addr("A1"), Value::Number(1.0));
    primitives.insert(addr("A2"), Value::Number(2.0));
    primitives.insert(addr("B2"), Value::Number(99.0)); // obstruction

    let mut wb = Workbook::new();
    wb.install_sheet_bulk(0, primitives, HashMap::new())
        .expect("install must succeed");

    // B1 spills down 2 cells; B2 is occupied by a parked value.
    assert!(wb.set_formula(0, "B1", "=SEQUENCE(2)"));
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Error(einfach_core::ValueError::Spill),
        "parked plain value must block the spill"
    );
    assert_eq!(wb.get_cell("Sheet1", "B2"), Value::Number(99.0));
}
