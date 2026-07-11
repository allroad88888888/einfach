//! LAZY_FORMULA_INDEXING Phase 2/3 acceptance.
//!
//! Pins the new lazy-build / lazy-eval contract from
//! `rust/excel-core/docs/LAZY_FORMULA_INDEXING_PLAN.md`. Each test
//! exercises one observable behaviour:
//!
//!   1. `bulk_load + no reads` → zero formula-inner/geometry state installed.
//!   2. `bulk_load + read 5 formulas` → partial hydration; only 5 formula
//!      records and their Store edges materialize.
//!   3. `bulk_load + read every formula` → materialized state matches the eager
//!      path
//!      baseline (cross-check against a clone of the sheet that we
//!      drive eagerly via `set_formula`).
//!   4. `bulk_load + mutate primitive + read formula` → correct value
//!      without any leak.
//!   5. `bulk_load + set_cell` overwriting an unparsed formula →
//!      replacement evaluates correctly; the old source / needs_parse
//!      entries are gone.
//!   6. `bulk_load + read N` → only the read N hydrate; the rest stay
//!      deferred (measured via `debug_dep_graph_stats` formula_count
//!      and the lazy-formula counter).

use einfach_core::Value;
use einfach_excel_core::Sheet;

/// Phase 2 acceptance: `bulk_load` of N formulas registers ZERO formula-inner
/// or range geometry state. Same-sheet dependencies are owned by Store.
#[test]
fn bulk_load_installs_zero_edges_before_any_read() {
    const N: u32 = 1_000;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{}", r), Value::Number(r as f64));
            // Mix point and range formulas; geometry roots only materialize
            // when a range formula is read.
            loader.set_formula(&format!("B{}", r), &format!("=A{}+1", r));
            loader.set_formula(&format!("C{}", r), &format!("=SUM(A1:A{})", r));
        }
    });

    // Sanity: the formulas were imported (counter ticks per
    // `set_formula_lazy` success).
    assert_eq!(
        sheet.debug_imported_formula_count(),
        (2 * N) as usize,
        "imported counter must include lazy parks"
    );
    assert_eq!(
        sheet.debug_formula_count(),
        (2 * N) as usize,
        "total formula count includes lazy parks + hydrated cells"
    );
    // Hydrated formula records and Store range geometry roots are both zero.
    assert_eq!(
        sheet.debug_point_dependency_key_count(),
        0,
        "deleted point graph remains empty before any read"
    );
    assert_eq!(
        sheet.debug_range_dep_count(),
        0,
        "no range geometry roots before any read"
    );
    let stats = sheet.debug_dep_graph_stats();
    assert_eq!(stats.formula_count, 0, "hydrated formula_count is zero");
    assert_eq!(stats.total_point_dep_edges, 0);
    assert_eq!(stats.total_range_dep_entries, 0);
}

/// Phase 3 acceptance: reading 5 of N bulk-loaded formulas hydrates
/// exactly those 5 — the other formulas stay deferred. Point-cell
/// dependencies are store-owned, so hydration is measured through the
/// formula record count.
#[test]
fn bulk_load_then_read_n_hydrates_exactly_n() {
    const N: u32 = 1_000;
    const READ_COUNT: u32 = 5;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{}", r), Value::Number(r as f64));
            loader.set_formula(&format!("B{}", r), &format!("=A{}+1", r));
        }
    });
    // Read 5 formula cells. Each hydrates one formula record, no range deps.
    for r in 1..=READ_COUNT {
        let v = sheet.get_cell(&format!("B{}", r));
        assert_eq!(v, Value::Number(r as f64 + 1.0));
    }
    assert_eq!(
        sheet.debug_point_dependency_key_count() as u32,
        0,
        "deleted point-dependency index stays empty after reads"
    );
    // Hydrated formula count from the compatibility/materialization probe.
    let stats = sheet.debug_dep_graph_stats();
    assert_eq!(stats.formula_count as u32, READ_COUNT);
    // Total formulas still N: 5 hydrated + (N-5) lazy.
    assert_eq!(sheet.debug_formula_count() as u32, N);
}

/// Phase 3 parity: hydrating EVERY formula via reads must produce the
/// same formula/Store materialization shape as the eager path. We build two
/// sheets — one through `bulk_load + read-all`, one through eager
/// per-cell `set_formula` — and compare counters.
#[test]
fn full_hydration_matches_eager_path_edge_counts() {
    const N: u32 = 200;

    let mut lazy = Sheet::new();
    lazy.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{}", r), Value::Number(r as f64));
            loader.set_formula(&format!("B{}", r), &format!("=A{}*2", r));
            // Include range formulas so static range metadata and Store edge
            // hydration are compared too.
            if r % 5 == 0 {
                loader.set_formula(
                    &format!("C{}", r),
                    &format!("=SUM(A{}:A{})", r.saturating_sub(4).max(1), r),
                );
            }
        }
    });
    // Force full hydration.
    for r in 1..=N {
        let _ = lazy.get_cell(&format!("B{}", r));
        if r % 5 == 0 {
            let _ = lazy.get_cell(&format!("C{}", r));
        }
    }

    let mut eager = Sheet::new();
    for r in 1..=N {
        eager.set_cell(&format!("A{}", r), Value::Number(r as f64));
        eager.set_formula(&format!("B{}", r), &format!("=A{}*2", r));
        if r % 5 == 0 {
            eager.set_formula(
                &format!("C{}", r),
                &format!("=SUM(A{}:A{})", r.saturating_sub(4).max(1), r),
            );
        }
    }
    // Evaluate every formula so formula records and Store-backed counters are
    // comparable.
    for r in 1..=N {
        let _ = eager.get_cell(&format!("B{}", r));
        if r % 5 == 0 {
            let _ = eager.get_cell(&format!("C{}", r));
        }
    }

    assert_eq!(
        lazy.debug_formula_count(),
        eager.debug_formula_count(),
        "formula_count parity after full hydration"
    );
    assert_eq!(
        lazy.debug_point_dependency_key_count(),
        eager.debug_point_dependency_key_count(),
        "deleted point graph probe parity"
    );
    assert_eq!(
        lazy.debug_range_dep_count(),
        eager.debug_range_dep_count(),
        "range geometry root count parity"
    );
    let lazy_stats = lazy.debug_dep_graph_stats();
    let eager_stats = eager.debug_dep_graph_stats();
    assert_eq!(
        lazy_stats.total_point_dep_edges, eager_stats.total_point_dep_edges,
        "legacy point-edge probe parity"
    );
    assert_eq!(
        lazy_stats.total_range_dep_entries, eager_stats.total_range_dep_entries,
        "total range-dep entries parity"
    );
    assert_eq!(
        lazy_stats.range_formula_count, eager_stats.range_formula_count,
        "range-formula count parity"
    );
}

/// Phase 4 acceptance: a primitive write between bulk_load and the
/// first formula read produces the correct value. Mutation never
/// touched the formula (still unhydrated), so the formula evaluates
/// fresh against the post-mutation primitive on first read.
#[test]
fn bulk_load_then_mutate_primitive_then_read_formula_returns_post_mutation_value() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A1", Value::Number(10.0));
        loader.set_formula("B1", "=A1+1");
    });
    // No reads → B1 still lazy.
    assert_eq!(
        sheet.debug_point_dependency_key_count(),
        0,
        "no edges before any read"
    );
    // Mutate the primitive.
    sheet.set_cell("A1", Value::Number(99.0));
    // First read. Hydration parses and evaluates against the current A1
    // value; the point edge is tracked by the atom store.
    assert_eq!(sheet.get_cell("B1"), Value::Number(100.0));
    assert_eq!(sheet.debug_point_dependency_key_count(), 0);
}

/// Edge case from the plan: `set_cell` (or `set_formula`) overwriting
/// an unparsed bulk-loaded formula must drain BOTH `formula_source`
/// AND `needs_parse`. The replacement evaluates correctly.
#[test]
fn overwrite_unparsed_formula_with_primitive_drains_lazy_state() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A1", Value::Number(7.0));
        loader.set_formula("B1", "=A1+5"); // lazy
    });
    // Sanity: B1 source is "=A1+5".
    assert_eq!(sheet.get_formula("B1").as_deref(), Some("=A1+5"));
    // Overwrite B1 with a primitive value BEFORE any read.
    sheet.set_cell("B1", Value::Number(42.0));
    // B1 must surface as 42.0, NOT as 12 (the hydrated formula's
    // result), and `get_formula` must return None — the formula is
    // gone.
    assert_eq!(sheet.get_cell("B1"), Value::Number(42.0));
    assert!(
        sheet.get_formula("B1").is_none(),
        "formula source must be cleared after primitive overwrite"
    );
}

/// Edge case from the task spec (D1 = 4A): `set_formula` (the
/// non-bulk path) over an unparsed lazy formula replaces it eagerly
/// and the lazy state is gone.
#[test]
fn set_formula_replacing_unparsed_formula_evaluates_correctly() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A1", Value::Number(3.0));
        loader.set_formula("B1", "=A1*100"); // lazy parking
    });
    // No reads → B1 lazy. Overwrite with a new formula.
    sheet.set_formula("B1", "=A1+1");
    // The new formula was eagerly installed (D1 = 4A) and evaluates
    // to 4.
    assert_eq!(sheet.get_cell("B1"), Value::Number(4.0));
    // And the source the host sees is the new one.
    assert_eq!(sheet.get_formula("B1").as_deref(), Some("=A1+1"));
}

/// Phase 4 acceptance: changing a primitive that is referenced by
/// hydrated formulas correctly invalidates the cache and re-evals on
/// next read. Lazy formulas that point at the same primitive are
/// silently NOT invalidated (they have no record to invalidate) and
/// evaluate fresh on first read instead. Both behaviours must yield
/// the same final value.
#[test]
fn mutation_invalidates_hydrated_and_lazy_formulas_consistently() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A1", Value::Number(1.0));
        loader.set_formula("B1", "=A1+10");
        loader.set_formula("C1", "=A1+20"); // stays lazy
    });
    // Hydrate B1.
    assert_eq!(sheet.get_cell("B1"), Value::Number(11.0));
    // Now mutate A1.
    sheet.set_cell("A1", Value::Number(100.0));
    // B1 was hydrated → its cache was invalidated through the dep
    // graph; re-read returns the new value.
    assert_eq!(sheet.get_cell("B1"), Value::Number(110.0));
    // C1 was lazy. The mutation didn't walk its (non-existent) edges.
    // On first read C1 hydrates and evaluates against the NEW A1.
    assert_eq!(sheet.get_cell("C1"), Value::Number(120.0));
}

/// Spill anchor hydration: a `=SEQUENCE(...)` formula parked via
/// bulk_load and then read at the anchor address evaluates to the
/// `Value::Array`. Spill TARGET installation happens at mutation time
/// (via `recompute_array_formula`), so a lazy bulk_load + read-only
/// flow returns the raw array at the anchor and Null at the would-be
/// targets — same as today's eager path before any write.
///
/// A subsequent write (here we re-set the anchor through the eager
/// `set_formula` path) triggers spill setup, after which target reads
/// surface the spilled values. This pins the contract:
///   - lazy bulk_load + read-only → anchor returns `Value::Array`
///   - lazy bulk_load + later write → spill targets observable
#[test]
fn read_of_spill_anchor_returns_array_before_mutation() {
    use einfach_core::ArrayData;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_formula("B2", "=SEQUENCE(3, 1)");
    });
    // Reading the anchor BEFORE any mutation hydrates the formula
    // and evaluates it to the array literal. The spill targets
    // haven't been installed (that requires `&mut self`), so the
    // anchor returns the Array value.
    let v = sheet.get_cell("B2");
    match v {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (3, 1));
            assert_eq!(arr.get(0, 0).cloned(), Some(Value::Number(1.0)));
            assert_eq!(arr.get(1, 0).cloned(), Some(Value::Number(2.0)));
            assert_eq!(arr.get(2, 0).cloned(), Some(Value::Number(3.0)));
        }
        other => panic!("expected Array, got {:?}", other),
    }
    // Targets without a mutation are still empty.
    assert_eq!(sheet.get_cell("B3"), Value::Null);

    // Now trigger a write — set a primitive on a feeder that the
    // formula doesn't depend on (A1). The write goes through the
    // mutation path; `recompute_array_formulas_in` runs, hydrates
    // the dep closure (a no-op here — nothing depends on A1), but
    // crucially the SEQUENCE anchor is already hydrated and its
    // Value::Array is cached. Re-setting the formula via the eager
    // path triggers spill setup.
    sheet.set_formula("B2", "=SEQUENCE(3, 1)");
    // Now B2 anchor holds the array AND targets are spilled.
    let v2 = sheet.get_cell("B2");
    assert!(
        matches!(v2, Value::Array(_)),
        "anchor still holds the array after re-install; got {:?}",
        v2
    );
    assert_eq!(sheet.get_cell("B3"), Value::Number(2.0));
    assert_eq!(sheet.get_cell("B4"), Value::Number(3.0));
    // Suppress unused import warning.
    let _ = ArrayData::new(1, 1, vec![Value::Null]);
}

/// LAZY_FORMULA_INDEXING acceptance: a `clear_cell` on an unparsed
/// lazy formula drains the lazy state and leaves the cell empty.
#[test]
fn clear_cell_on_unparsed_formula_clears_lazy_state() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_formula("A1", "=42");
    });
    assert_eq!(sheet.debug_formula_count(), 1, "lazy formula counts");
    sheet.clear_cell("A1");
    assert_eq!(
        sheet.debug_formula_count(),
        0,
        "lazy source must be drained on clear"
    );
    assert_eq!(sheet.get_cell("A1"), Value::Null);
}

// === Codex P1/P2 regressions (2026-06-11) ===

/// Codex P1 #1: inserting a row before a bulk-loaded (lazy) formula
/// must keep the formula pointing at the original logical cell, not at
/// its own new address.
///
/// Repro: `A1 = "=A2"`, `A2 = 42`. After `insert_row(0, 1)`:
///   - `A2` holds the formula (previously at A1).
///   - `A3` holds 42 (previously at A2).
///   - The formula text MUST retarget to `=A3` before hydration; otherwise
///     hydration parses `=A2` as a self-reference and locks in `#CYCLE!`.
#[test]
fn insert_row_before_lazy_formula_preserves_reference() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A2", Value::Number(42.0));
        loader.set_formula("A1", "=A2"); // never read — stays lazy
    });
    // Insert one row at the top so A1 shifts to A2 and old A2 shifts to A3.
    sheet.insert_row(0, 1);
    // The relocated formula must observe its source cell at its NEW address.
    assert_eq!(sheet.get_cell("A2"), Value::Number(42.0));
    // And the relocated primitive is at A3.
    assert_eq!(sheet.get_cell("A3"), Value::Number(42.0));
}

/// Codex P1 #2: deleting a row whose only content is a lazy formula
/// must drop the lazy state cleanly. Otherwise the lazy formula's
/// address gets shifted through `f` into `REF_INVALID_*` sentinels and
/// `non_empty_addrs()` panics formatting the invalid address.
#[test]
fn delete_row_containing_lazy_formula_removes_it_cleanly() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|l| {
        l.set_formula("A1", "=42");
        l.set_cell("A2", Value::Number(5.0));
        l.set_formula("A3", "=A2"); // depends on the cell being deleted
    });
    // Delete row 2 (0-based row index 1) — drops the primitive A2 and the
    // dependent formula A3 should either shift to A2 or become #REF!.
    sheet.delete_row(1, 1);
    // Must not panic. A1 + (relocated formula) should be the only entries.
    let addrs = sheet.non_empty_addrs();
    assert!(
        addrs.len() <= 2,
        "expected at most A1 + relocated formula, got {:?}",
        addrs
    );
    // The lazy A1 formula stayed intact and still evaluates to 42.
    assert_eq!(sheet.get_cell("A1"), Value::Number(42.0));
}

/// Codex P1 #2 (sharper): deleting the band that contains the ONLY
/// lazy formula must clear the lazy state — no orphan
/// `formula_source` / `needs_parse` entry survives the relocate.
#[test]
fn delete_row_drops_lazy_state_for_addresses_in_deleted_band() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|l| {
        l.set_formula("B5", "=1+1"); // lazy, lives inside the deleted band
    });
    // Sanity: lazy entry exists.
    assert_eq!(sheet.debug_formula_count(), 1);
    sheet.delete_row(4, 1); // delete row 5 (0-based 4)
                            // The lazy formula at B5 must be GONE — not parked at the
                            // REF_INVALID sentinel.
    assert_eq!(sheet.debug_formula_count(), 0);
    let addrs = sheet.non_empty_addrs();
    assert!(addrs.is_empty(), "sheet must be empty, got {:?}", addrs);
}

/// Codex P1 #2 (column variant): same contract for delete_col.
#[test]
fn delete_col_drops_lazy_state_for_addresses_in_deleted_band() {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|l| {
        l.set_formula("C1", "=42"); // lazy
        l.set_cell("D1", Value::Number(7.0));
    });
    sheet.delete_col(2, 1); // delete column C
                            // C1's lazy state must be gone; D1 shifts to C1.
    let addrs = sheet.non_empty_addrs();
    assert_eq!(addrs.len(), 1);
    assert_eq!(sheet.get_cell("C1"), Value::Number(7.0));
}

/// Codex P2 #2: `BulkLoader::set_formula` returns `false` on parse
/// failure. After flush, the cell must hold `#VALUE!` AND
/// `get_formula(addr)` must return `None` — a rejected source is NOT a
/// formula.
#[test]
fn bulk_loader_set_formula_parse_failure_is_not_observable_as_formula() {
    use einfach_core::ValueError;
    let mut sheet = Sheet::new();
    let mut ok = true;
    sheet.bulk_load(|loader| {
        ok = loader.set_formula("A1", "=SUM(");
    });
    assert!(!ok, "loader must report parse failure");
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Error(ValueError::InvalidValue),
        "cell value must be #VALUE!"
    );
    assert!(
        sheet.get_formula("A1").is_none(),
        "rejected source must NOT surface as a formula"
    );
    assert!(
        !sheet.has_formula_at(einfach_excel_core::CellAddress::parse("A1").unwrap()),
        "ISFORMULA(A1) must be false"
    );
}
