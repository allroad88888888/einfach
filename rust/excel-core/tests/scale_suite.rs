//! Always-on large-N scale suite — S1–S11 of
//! `docs/SCALE_TEST_SUITE_PLAN.md` (Rust side).
//!
//! Design contract (see the plan's "Design principles"):
//!   - ALWAYS-ON: no `#[ignore]` on the main shapes; the whole file must
//!     stay well under the debug-profile time budget. Heavy 500k/1M
//!     twins of two representative shapes are `#[ignore]`d at the
//!     bottom.
//!   - COUNTERS, NOT CLOCKS: complexity is asserted via the
//!     `#[doc(hidden)] debug_*` probes (eval counts, dirty-BFS visits,
//!     dep-graph stats, map sizes) — zero wall-clock assertions.
//!   - CLOSED FORM: every shape's correctness check is an arithmetic
//!     identity (stated in each test's doc comment), not
//!     sampled-and-hoped.
//!   - DETERMINISTIC: randomized placement uses the seeded LCG below.
//!
//! A failure in this file is a P1 by definition: it means an O(N)
//! regression or a stale-cache bug re-entered the engine.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use einfach_core::{Value, ValueError};
use einfach_excel_core::{CellAddress, Sheet, Workbook};

fn addr(s: &str) -> CellAddress {
    CellAddress::parse(s).expect("test address must parse")
}

fn num(v: f64) -> Value {
    Value::Number(v)
}

/// Deterministic 64-bit LCG (Knuth MMIX constants). Top 31 bits only —
/// the low bits of an LCG are weak.
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

/// Closed form Σ 1..=n.
fn sum_1_to(n: u64) -> f64 {
    (n * (n + 1) / 2) as f64
}

// =====================================================================
// S1 — Chain: A1 = 1, A_i = A_{i-1} + 1.
//
// Identities:
//   - tail == N (closed form).
//   - hydration sweep evals each formula EXACTLY once: eval delta ==
//     N - 1, never O(N²) (each read must reuse its upstream's cache).
//   - after editing the head to 1 + Δ, a full re-read sweep re-evals
//     exactly N - 1 formulas again ("chain length, not 2×") and the
//     tail reads N + Δ.
//   - the SECOND read after the edit re-evals NOTHING (clean cache).
// =====================================================================

fn s1_chain_body(n: u32) {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A1", num(1.0));
        for r in 2..=n {
            loader.set_formula(&format!("A{r}"), &format!("=A{}+1", r - 1));
        }
    });
    assert_eq!(
        sheet.debug_formula_eval_count(),
        0,
        "bulk_load must not eval anything"
    );

    // Hydration sweep head→tail: every read's upstream is already
    // clean, so each formula evaluates exactly once.
    for r in 2..=n {
        let _ = sheet.get_cell(&format!("A{r}"));
    }
    assert_eq!(
        sheet.debug_formula_eval_count(),
        (n - 1) as usize,
        "each chain formula must evaluate exactly once during hydration"
    );
    // Closed form; this read is a pure cache hit.
    assert_eq!(sheet.get_cell(&format!("A{n}")), num(n as f64));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        (n - 1) as usize,
        "clean tail read must not re-eval"
    );

    // Edit the head: Δ = +10. The dirty BFS must visit the whole chain
    // exactly once (every formula transitively depends on A1).
    let visits_before = sheet.debug_dirty_visit_count();
    sheet.set_cell("A1", num(11.0));
    assert_eq!(
        sheet.debug_dirty_visit_count() - visits_before,
        (n - 1) as u64,
        "head edit must dirty each chain formula exactly once"
    );

    // Re-read sweep: re-eval count == chain length, not 2×.
    let evals_before = sheet.debug_formula_eval_count();
    for r in 2..=n {
        let _ = sheet.get_cell(&format!("A{r}"));
    }
    assert_eq!(
        sheet.debug_formula_eval_count() - evals_before,
        (n - 1) as usize,
        "post-edit sweep must re-eval each formula exactly once"
    );
    assert_eq!(
        sheet.get_cell(&format!("A{n}")),
        num((n + 10) as f64),
        "tail == N + Δ after head edit"
    );

    // SECOND read after the edit: the cache is clean, zero re-evals.
    let evals_clean = sheet.debug_formula_eval_count();
    for r in (2..=n).step_by((n as usize / 64).max(1)) {
        let _ = sheet.get_cell(&format!("A{r}"));
    }
    let _ = sheet.get_cell(&format!("A{n}"));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        evals_clean,
        "second read after edit must re-eval nothing"
    );
}

#[test]
fn s1_chain_evals_linear_and_caches_clean() {
    s1_chain_body(20_000);
}

// =====================================================================
// S2 — Fanout: A1 = 1, B_i = A1 * 2 for i in 1..=N.
//
// Identities:
//   - every B_i == 2 (then == 10 after the head edit: 2 × 5).
//   - editing A1 dirties exactly N formulas (dirty-BFS visit delta ==
//     N, dirty-state count == N).
//   - a write to an UNRELATED cell does zero dirty work (visit delta
//     == 0) and triggers zero re-evals on subsequent reads.
// =====================================================================

#[test]
fn s2_fanout_dirty_work_equals_fanout() {
    const N: u32 = 20_000;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        loader.set_cell("A1", num(1.0));
        for r in 1..=N {
            loader.set_formula(&format!("B{r}"), "=A1*2");
        }
    });

    // Hydrate all N (each evals exactly once).
    for r in 1..=N {
        assert_eq!(sheet.get_cell(&format!("B{r}")), num(2.0));
    }
    assert_eq!(sheet.debug_formula_eval_count(), N as usize);
    assert_eq!(sheet.debug_dirty_count(), 0, "all clean after hydration");

    // Head edit: bump/dirty count == N exactly.
    let visits_before = sheet.debug_dirty_visit_count();
    sheet.set_cell("A1", num(5.0));
    assert_eq!(
        sheet.debug_dirty_visit_count() - visits_before,
        N as u64,
        "head edit must visit each dependent exactly once"
    );
    assert_eq!(
        sheet.debug_dirty_count(),
        N as usize,
        "all N formulas dirty after head edit"
    );

    // Re-read: exactly N re-evals, values follow the head.
    let evals_before = sheet.debug_formula_eval_count();
    for r in 1..=N {
        assert_eq!(sheet.get_cell(&format!("B{r}")), num(10.0));
    }
    assert_eq!(sheet.debug_formula_eval_count() - evals_before, N as usize);
    assert_eq!(sheet.debug_dirty_count(), 0);

    // Unrelated write: ZERO dirty work, ZERO re-evals.
    let visits_before = sheet.debug_dirty_visit_count();
    sheet.set_cell("Z1", num(99.0));
    assert_eq!(
        sheet.debug_dirty_visit_count() - visits_before,
        0,
        "unrelated write must do zero dirty work"
    );
    assert_eq!(sheet.debug_dirty_count(), 0);
    let evals_before = sheet.debug_formula_eval_count();
    for r in (1..=N).step_by(977) {
        assert_eq!(sheet.get_cell(&format!("B{r}")), num(10.0));
    }
    assert_eq!(
        sheet.debug_formula_eval_count(),
        evals_before,
        "reads after an unrelated write must be cache hits"
    );
}

// =====================================================================
// S3 — Fan-in: whole-column SUM(A:A) over N sparse cells.
//
// Identities:
//   - SUM(A:A) == N(N+1)/2 with A_r = r (closed form), via exactly ONE
//     formula eval.
//   - the sparse range iterator touches exactly N cells — O(existing),
//     never O(1,048,576).
//   - editing one source cell re-evals exactly 1 formula and dirties
//     exactly 1 dependent; new sum == old − r + v (closed form).
// =====================================================================

#[test]
fn s3_fan_in_whole_column_sum_is_sparse_and_single_eval() {
    const N: u32 = 100_000;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{r}"), num(r as f64));
        }
        loader.set_formula("B1", "=SUM(A:A)");
    });

    assert_eq!(sheet.get_cell("B1"), num(sum_1_to(N as u64)));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        1,
        "exactly one formula eval for the whole-column sum"
    );
    // Sparse iteration touches O(existing): N cells, not the 1M-row
    // column space.
    assert_eq!(
        sheet.debug_range_visit_count("A1:A1048576"),
        N as usize,
        "sparse column scan must touch exactly the existing cells"
    );

    // One source edit: A500 := 500 + 1_000_000.
    let visits_before = sheet.debug_dirty_visit_count();
    sheet.set_cell("A500", num(1_000_500.0));
    assert_eq!(
        sheet.debug_dirty_visit_count() - visits_before,
        1,
        "single-cell edit must dirty exactly the one range dependent"
    );
    let evals_before = sheet.debug_formula_eval_count();
    assert_eq!(
        sheet.get_cell("B1"),
        num(sum_1_to(N as u64) + 1_000_000.0),
        "sum must shift by exactly the edit delta"
    );
    assert_eq!(
        sheet.debug_formula_eval_count() - evals_before,
        1,
        "exactly 1 formula re-evals after a single cell edit"
    );
}

// =====================================================================
// S4 — Criteria aggregates over a whole column at scale.
//
// With A_r = r for r in 1..=N and threshold K:
//   - COUNTIF(A:A, ">K")  == N − K
//   - SUMIF(A:A, ">K")    == Σ(K+1 ..= N) == Σ1..N − Σ1..K
//   - COUNTIF(A:A, "=X")  == 1 for any X in 1..=N
// =====================================================================

#[test]
fn s4_criteria_aggregates_closed_forms() {
    const N: u32 = 50_000;
    const K: u32 = 40_000;
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{r}"), num(r as f64));
        }
        loader.set_formula("C1", &format!("=COUNTIF(A:A,\">{K}\")"));
        loader.set_formula("C2", &format!("=SUMIF(A:A,\">{K}\")"));
        loader.set_formula("C3", "=COUNTIF(A:A,\"=12345\")");
    });

    assert_eq!(sheet.get_cell("C1"), num((N - K) as f64));
    assert_eq!(
        sheet.get_cell("C2"),
        num(sum_1_to(N as u64) - sum_1_to(K as u64))
    );
    assert_eq!(sheet.get_cell("C3"), num(1.0));
    assert_eq!(
        sheet.debug_formula_eval_count(),
        3,
        "three aggregate evals, nothing else"
    );
}

// =====================================================================
// S5 — Spill: =SEQUENCE(N) anchored at A1.
//
// Identities (with N-row single-column SEQUENCE):
//   - cell at row r holds r (anchor row 1, targets rows 2..=N).
//   - spill bookkeeping is exact: 1 anchor, N − 1 targets.
//   - insert_row above the anchor shifts the whole spill: row r + 1
//     holds r afterwards, bookkeeping unchanged in SIZE.
//   - clearing the anchor returns EVERY map (spill bookkeeping, cells,
//     store atoms, formula records) to its pre-spill baseline.
// =====================================================================

#[test]
fn s5_spill_shifts_and_tears_down_to_baseline() {
    const N: u32 = 10_000;
    let mut sheet = Sheet::new();

    // Pre-spill baselines (empty sheet — but assert by equality, not 0,
    // so the pin survives future baseline changes).
    let base_cells = sheet.debug_primitive_atom_count();
    let base_atoms = sheet.debug_total_atom_count();
    let base_materialized = sheet.debug_materialized_cell_atom_count();
    let base_formulas = sheet.debug_formula_count();
    let base_anchors = sheet.debug_spill_anchor_count();
    let base_targets = sheet.debug_spill_target_count();

    assert!(sheet.set_formula("A1", &format!("=SEQUENCE({N})")));
    assert_eq!(sheet.debug_spill_anchor_count(), base_anchors + 1);
    assert_eq!(
        sheet.debug_spill_target_count(),
        base_targets + (N - 1) as usize,
        "exactly N − 1 spill targets installed"
    );
    // Sampled targets: row r holds r.
    assert_eq!(sheet.get_cell("A2"), num(2.0));
    assert_eq!(sheet.get_cell(&format!("A{}", N / 2)), num((N / 2) as f64));
    assert_eq!(sheet.get_cell(&format!("A{N}")), num(N as f64));

    // Structural shift: insert a row above the anchor.
    sheet.insert_row(0, 1);
    assert_eq!(sheet.get_cell("A1"), Value::Null, "new blank row");
    assert_eq!(
        sheet.get_formula("A2").as_deref(),
        Some(format!("=SEQUENCE({N})").as_str()),
        "anchor formula relocated"
    );
    assert_eq!(sheet.get_cell(&format!("A{}", N / 2 + 1)), num((N / 2) as f64));
    assert_eq!(sheet.get_cell(&format!("A{}", N + 1)), num(N as f64));
    assert_eq!(sheet.debug_spill_anchor_count(), base_anchors + 1);
    assert_eq!(
        sheet.debug_spill_target_count(),
        base_targets + (N - 1) as usize,
        "shift must not grow or shrink the spill bookkeeping"
    );

    // Teardown: clearing the anchor returns every map to baseline.
    sheet.clear_cell("A2");
    assert_eq!(sheet.debug_spill_anchor_count(), base_anchors);
    assert_eq!(sheet.debug_spill_target_count(), base_targets);
    assert_eq!(sheet.debug_formula_count(), base_formulas);
    assert_eq!(
        sheet.debug_primitive_atom_count(),
        base_cells,
        "no residual cell slots after anchor clear"
    );
    assert_eq!(
        sheet.debug_materialized_cell_atom_count(),
        base_materialized
    );
    assert_eq!(
        sheet.debug_total_atom_count(),
        base_atoms,
        "no leaked store atoms after anchor clear"
    );
    assert_eq!(sheet.get_cell(&format!("A{}", N / 2 + 1)), Value::Null);
}

// =====================================================================
// S6 — Cross-sheet chain: 10 sheets, N rows. Sheet1!A_r = r;
// S_k!A_r = S_{k-1}!A_r + 1 for k = 1..=9 (S0 ≡ Sheet1).
//
// Identities:
//   - tail sheet S9!A_r == r + 9, so SUM(A1:A_N) on S9 ==
//     N(N+1)/2 + 9N (closed form).
//   - editing Sheet1!A1 by Δ propagates: tail A1 == 1 + Δ + 9, sum
//     shifts by exactly Δ.
//   - A-6 at scale: removing an UNRELATED sheet keeps the chain's
//     subscriber fanout alive — the next source edit still fires.
// =====================================================================

#[test]
fn s6_cross_sheet_chain_closed_form_and_a6_at_scale() {
    const N: u32 = 4_000;
    const HOPS: usize = 9; // sheets S1..=S9 on top of Sheet1

    let mut wb = Workbook::new();
    for k in 1..=HOPS {
        wb.add_sheet(&format!("S{k}"));
    }
    let scratch = wb.add_sheet("Scratch");

    wb.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(0, &format!("A{r}"), num(r as f64));
        }
        for k in 1..=HOPS {
            let prev = if k == 1 {
                "Sheet1".to_string()
            } else {
                format!("S{}", k - 1)
            };
            for r in 1..=N {
                assert!(loader.set_formula(
                    k,
                    &format!("A{r}"),
                    &format!("={prev}!A{r}+1")
                ));
            }
        }
        assert!(loader.set_formula(HOPS, "C1", &format!("=SUM(A1:A{N})")));
    });

    // Tail closed form — forces the whole 9 × N chain.
    let tail_sum = sum_1_to(N as u64) + (HOPS as f64) * (N as f64);
    assert_eq!(wb.get_cell("S9", "C1"), num(tail_sum));
    assert_eq!(wb.get_cell("S9", &format!("A{N}")), num((N + 9) as f64));

    // Source edit propagates through all hops: Δ = +10.
    wb.set_cell(0, "A1", num(11.0));
    assert_eq!(wb.get_cell("S9", "A1"), num(20.0), "1 + 10 + 9 hops");
    assert_eq!(
        wb.get_cell("S9", "C1"),
        num(tail_sum + 10.0),
        "tail sum shifts by exactly the edit delta"
    );

    // A-6 at scale: subscriber on the tail of the chain survives the
    // removal of an UNRELATED sheet.
    let fires = Rc::new(RefCell::new(0u32));
    let ff = fires.clone();
    let _sub = wb
        .sheet_mut(HOPS)
        .unwrap()
        .subscribe_cell("A2", move || *ff.borrow_mut() += 1);

    assert!(wb.remove_sheet(scratch).is_some());

    wb.set_cell(0, "A2", num(102.0));
    assert!(
        *fires.borrow() >= 1,
        "A-6 at scale: chain subscriber must still fire after removing \
         an unrelated sheet"
    );
    assert_eq!(
        wb.get_cell("S9", "A2"),
        num(111.0),
        "102 + 9 hops after the post-removal edit"
    );
}

// =====================================================================
// S7 — Structural edits at scale preserve the lazy contract.
//
// (a) insert_row on N parked formulas: the dep graph stays COMPLETELY
//     empty (formula_count == 0, zero edges) — the W2.1 textual
//     retarget generalized to 100k. Sampled reads then match the
//     shifted closed form B_{r+1} == 2r.
// (b) delete_row of a band: laziness preserved, survivors follow the
//     shifted closed form, and formulas referencing the deleted band
//     surface #REF!.
// =====================================================================

fn s7a_insert_row_body(n: u32) {
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=n {
            loader.set_cell(&format!("A{r}"), num(r as f64));
            loader.set_formula(&format!("B{r}"), &format!("=A{r}*2"));
        }
    });
    assert_eq!(sheet.debug_dep_graph_stats().formula_count, 0);

    sheet.insert_row(0, 1);

    // THE pin: the edit must not hydrate anything.
    let stats = sheet.debug_dep_graph_stats();
    assert_eq!(
        stats.formula_count, 0,
        "insert_row on parked formulas must hydrate nothing"
    );
    assert_eq!(stats.total_point_dep_edges, 0);
    assert_eq!(sheet.debug_cell_dependents_key_count(), 0);
    assert_eq!(
        sheet.debug_formula_count(),
        n as usize,
        "all N formulas still present (parked)"
    );

    // Shifted closed form: old row r lives at r + 1 → B_{r+1} == 2r.
    for r in [1u32, 2, n / 2, n - 1, n] {
        assert_eq!(
            sheet.get_cell(&format!("B{}", r + 1)),
            num(2.0 * r as f64),
            "shifted closed form at source row {r}"
        );
    }
}

#[test]
fn s7a_insert_row_on_100k_parked_formulas_stays_lazy() {
    s7a_insert_row_body(100_000);
}

#[test]
fn s7b_delete_band_keeps_laziness_and_refs_band_correctly() {
    const N: u32 = 50_000;
    const BAND: u32 = 10; // delete rows 1..=10
    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{r}"), num(r as f64));
            loader.set_formula(&format!("B{r}"), &format!("=A{r}+1"));
        }
        // Probe formulas OUTSIDE the band that reference INTO the band:
        // D_{N+j} = A_j for j in 1..=BAND. After the delete their refs
        // are gone → #REF!.
        for j in 1..=BAND {
            loader.set_formula(&format!("D{}", N + j), &format!("=A{j}*1"));
        }
    });
    assert_eq!(sheet.debug_dep_graph_stats().formula_count, 0);

    sheet.delete_row(0, BAND);

    // Laziness preserved through the delete.
    assert_eq!(
        sheet.debug_dep_graph_stats().formula_count,
        0,
        "delete_row on parked formulas must hydrate nothing"
    );
    assert_eq!(sheet.debug_cell_dependents_key_count(), 0);
    // Band rows (formula + primitive pairs) are gone from the count,
    // and the #REF! probes converted to plain error CELLS (engine
    // contract pinned in tests/lazy_structural_retarget.rs: a parked
    // formula whose ref dies is no longer a formula).
    assert_eq!(
        sheet.debug_formula_count(),
        (N - BAND) as usize,
        "N − BAND surviving B formulas; band formulas and #REF! probes \
         drop out of the formula tables"
    );

    // Shifted closed form: old row r (r > BAND) now lives at r − BAND
    // and still computes (old A_r) + 1 == r + 1.
    for r in [BAND + 1, N / 2, N] {
        assert_eq!(
            sheet.get_cell(&format!("B{}", r - BAND)),
            num((r + 1) as f64),
            "survivor closed form at old row {r}"
        );
    }

    // #REF! band: the probe formulas referenced deleted rows.
    for j in [1u32, BAND / 2, BAND] {
        assert_eq!(
            sheet.get_cell(&format!("D{}", N + j - BAND)),
            Value::Error(ValueError::InvalidRef),
            "probe {j} must surface #REF! after its source row was deleted"
        );
    }
}

// =====================================================================
// S8 — Churn/leak: N × (create → overwrite → clear) must return every
// parallel table to its pre-churn baseline.
//
// Identity: for every probe P, P(after churn) == P(before churn).
// Two churn flavors:
//   - lazy: bulk_load-parked formulas (exercises formula_source /
//     needs_parse drain on overwrite + clear),
//   - eager: live `set_formula` (exercises FormulaRecord, dep-map and
//     store-atom churn).
// =====================================================================

/// Snapshot of every bookkeeping table the churn could leak into.
#[derive(Debug, PartialEq, Eq)]
struct SheetProbes {
    cells: usize,
    materialized_atoms: usize,
    store_atoms: usize,
    formulas: usize,
    dirty: usize,
    dep_keys: usize,
    a1_dependents: usize,
    range_deps: usize,
    spill_anchors: usize,
    spill_targets: usize,
    live_subs: usize,
}

fn probes(sheet: &Sheet) -> SheetProbes {
    SheetProbes {
        cells: sheet.debug_primitive_atom_count(),
        materialized_atoms: sheet.debug_materialized_cell_atom_count(),
        store_atoms: sheet.debug_total_atom_count(),
        formulas: sheet.debug_formula_count(),
        dirty: sheet.debug_dirty_count(),
        dep_keys: sheet.debug_cell_dependents_key_count(),
        a1_dependents: sheet.debug_dependents_count("A1"),
        range_deps: sheet.debug_range_dep_count(),
        spill_anchors: sheet.debug_spill_anchor_count(),
        spill_targets: sheet.debug_spill_target_count(),
        live_subs: sheet.debug_live_subscription_count(),
    }
}

#[test]
fn s8_churn_returns_every_table_to_baseline() {
    const N_LAZY: u32 = 50_000;
    const N_EAGER: u32 = 2_000;

    // Base content so the baseline is non-trivial.
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", num(1.0));
    assert!(sheet.set_formula("B1", "=A1+1"));
    assert_eq!(sheet.get_cell("B1"), num(2.0));

    let baseline = probes(&sheet);

    // Lazy churn: park → overwrite with primitive → clear.
    sheet.bulk_load(|loader| {
        for r in 1..=N_LAZY {
            loader.set_formula(&format!("D{r}"), &format!("=A1+{r}"));
        }
    });
    for r in 1..=N_LAZY {
        sheet.set_cell(&format!("D{r}"), num(r as f64));
    }
    for r in 1..=N_LAZY {
        sheet.clear_cell(&format!("D{r}"));
    }

    // Eager churn: live formula → overwrite with primitive → clear.
    for r in 1..=N_EAGER {
        assert!(sheet.set_formula(&format!("E{r}"), &format!("=A1*{r}")));
    }
    for r in 1..=N_EAGER {
        sheet.set_cell(&format!("E{r}"), num(r as f64));
    }
    for r in 1..=N_EAGER {
        sheet.clear_cell(&format!("E{r}"));
    }

    assert_eq!(
        probes(&sheet),
        baseline,
        "every bookkeeping table must return to its pre-churn baseline"
    );
    // Base content unaffected by the storm.
    assert_eq!(sheet.get_cell("B1"), num(2.0));
}

// =====================================================================
// S9 — Install/restore roundtrip: 200k cells installed over EXISTING
// different content via the storage-primary path.
//
// Identities:
//   - zero residue: sampled old addresses are Null, old formulas gone.
//   - the restore leaves the dep graph at 0 (lazy) and ZERO store
//     atoms (AUDIT B-2).
//   - new content closed forms: B_r == 2r per cell, SUM(A:A) ==
//     N(N+1)/2 over all 100k primitives.
// =====================================================================

#[test]
fn s9_install_200k_over_existing_content_leaves_no_residue() {
    const N: u32 = 100_000; // 100k primitives + 100k formulas = 200k cells

    let mut wb = Workbook::new();

    // Old world (different addresses), partially hydrated by reads.
    let mut old_prims = HashMap::new();
    let mut old_formulas = HashMap::new();
    for r in 1..=5_000u32 {
        old_prims.insert(addr(&format!("X{r}")), num(r as f64));
    }
    for r in 1..=2_000u32 {
        old_formulas.insert(addr(&format!("Y{r}")), format!("=X{r}*3"));
    }
    wb.install_sheet_bulk(0, old_prims, old_formulas)
        .expect("old install must succeed");
    assert_eq!(wb.get_cell("Sheet1", "Y7"), num(21.0)); // hydrate some
    assert_eq!(wb.get_cell("Sheet1", "X9"), num(9.0));
    assert!(wb.sheet(0).unwrap().debug_dep_graph_stats().formula_count >= 1);

    // New world: 200k cells.
    let mut prims = HashMap::new();
    let mut formulas = HashMap::new();
    for r in 1..=N {
        prims.insert(addr(&format!("A{r}")), num(r as f64));
        formulas.insert(addr(&format!("B{r}")), format!("=A{r}*2"));
    }
    let stats = wb
        .install_sheet_bulk(0, prims, formulas)
        .expect("install must succeed");
    assert_eq!(stats.primitives_installed, N as usize);
    assert_eq!(stats.formulas_installed, N as usize);

    // Zero residue from the previous world.
    for old in ["X9", "X5000", "Y7", "Y2000"] {
        assert_eq!(
            wb.get_cell("Sheet1", old),
            Value::Null,
            "old address {old} must be empty after the restore"
        );
    }
    assert_eq!(wb.sheet(0).unwrap().get_formula("Y7"), None);

    // Lazy + atom-free restore (B-2 at 200k).
    let sheet = wb.sheet(0).unwrap();
    let dep = sheet.debug_dep_graph_stats();
    assert_eq!(dep.formula_count, 0, "restore must hydrate nothing");
    assert_eq!(dep.total_point_dep_edges, 0);
    assert_eq!(dep.total_range_dep_entries, 0);
    assert_eq!(sheet.debug_formula_count(), N as usize);
    assert_eq!(
        sheet.debug_total_atom_count(),
        0,
        "B-2: zero store atoms after a 200k install"
    );
    assert_eq!(sheet.debug_materialized_cell_atom_count(), 0);

    // Closed-form reads of the new world.
    for r in [1u32, N / 2, N] {
        assert_eq!(wb.get_cell("Sheet1", &format!("B{r}")), num(2.0 * r as f64));
    }
    assert!(wb.set_formula(0, "C1", "=SUM(A:A)"));
    assert_eq!(
        wb.get_cell("Sheet1", "C1"),
        num(sum_1_to(N as u64)),
        "whole-column sum over the restored world (closed form)"
    );
}

// =====================================================================
// S10 — Boundary: refs at XFD1048576, whole-row at max width, grid-cap
// rejections, structural edits at row 0 / max row. No panics; the
// pinned errors are the ones the engine produces today.
//
// Grid-cap identities:
//   - SEQUENCE(1, 16385): spill would cross col XFD → #SPILL!.
//   - SEQUENCE(2, 16384) anchored at C1: crosses col XFD → #SPILL!.
//   - SEQUENCE(1048577): exceeds the dynamic-array cell cap → #VALUE!.
//   - SEQUENCE(3) at A1048575: spills past row 1048576 → #SPILL!.
// =====================================================================

#[test]
fn s10_boundary_corner_refs_and_grid_caps() {
    // Corner cell: write, read, formula ref.
    let mut sheet = Sheet::new();
    sheet.set_cell("XFD1048576", num(7.0));
    assert_eq!(sheet.get_cell("XFD1048576"), num(7.0));
    assert!(sheet.set_formula("A1", "=XFD1048576*2"));
    assert_eq!(sheet.get_cell("A1"), num(14.0));

    // Whole-row read at max width on the LAST row: sparse, closed form,
    // bounded work (2 visits — only the existing cells).
    sheet.set_cell("A1048576", num(5.0));
    assert!(sheet.set_formula("B1", "=SUM(1048576:1048576)"));
    assert_eq!(sheet.get_cell("B1"), num(12.0), "5 + 7 across the max row");
    assert_eq!(
        sheet.debug_range_visit_count("A1048576:XFD1048576"),
        2,
        "full-width row scan must touch only the 2 existing cells"
    );

    // Grid-cap rejections (no panic, exact error):
    let mut s = Sheet::new();
    assert!(s.set_formula("A1", "=SEQUENCE(1,16385)"));
    assert_eq!(
        s.get_cell("A1"),
        Value::Error(ValueError::Spill),
        "16385-wide spill must reject with #SPILL!"
    );
    assert!(s.set_formula("C1", "=SEQUENCE(2,16384)"));
    assert_eq!(
        s.get_cell("C1"),
        Value::Error(ValueError::Spill),
        "spill anchored at C1 crossing col XFD must reject with #SPILL!"
    );
    assert!(s.set_formula("E1", "=SEQUENCE(1048577)"));
    assert_eq!(
        s.get_cell("E1"),
        Value::Error(ValueError::InvalidValue),
        "array above the 1,048,576-cell cap must reject with #VALUE!"
    );
    assert!(s.set_formula("A1048575", "=SEQUENCE(3)"));
    assert_eq!(
        s.get_cell("A1048575"),
        Value::Error(ValueError::Spill),
        "spill past the last row must reject with #SPILL!"
    );

    // Structural edits at the sheet edges: no panic, exact relocation.
    // (Engine contract today: addresses are u32-sparse; an insert at
    // row 0 pushes corner content past the Excel grid rather than
    // erroring — pinned as-is.)
    let mut s_ins = Sheet::new();
    s_ins.set_cell("XFD1048576", num(9.0));
    s_ins.insert_row(0, 1);
    assert_eq!(s_ins.get_cell("XFD1048576"), Value::Null);
    assert_eq!(s_ins.non_empty_addrs(), vec!["XFD1048577".to_string()]);

    let mut s_del = Sheet::new();
    s_del.set_cell("XFD1048576", num(9.0));
    s_del.set_cell("A1", num(1.0));
    s_del.delete_row(1048575, 1); // delete the max row
    assert_eq!(
        s_del.non_empty_addrs(),
        vec!["A1".to_string()],
        "deleting the max row must remove exactly its content"
    );

    let mut s_col = Sheet::new();
    s_col.set_cell("A1", num(1.0));
    s_col.set_cell("XFD1", num(3.0));
    s_col.delete_col(16383, 1); // delete col XFD
    assert_eq!(s_col.non_empty_addrs(), vec!["A1".to_string()]);
    s_col.insert_row(1048575, 2); // insert at the max row: no panic
    assert_eq!(s_col.get_cell("A1"), num(1.0));

    // Point refs BEYOND the Excel grid (XFE1, A1048577) parse and read
    // as empty cells today — pinned: no panic, Null semantics.
    let mut s_beyond = Sheet::new();
    assert!(s_beyond.set_formula("A1", "=XFE1+1"));
    assert_eq!(s_beyond.get_cell("A1"), num(1.0));
    assert!(s_beyond.set_formula("A2", "=A1048577+1"));
    assert_eq!(s_beyond.get_cell("A2"), num(1.0));
}

// =====================================================================
// S11 — Mutation storm: 10k single-cell edits against a 200k-cell
// sheet (100k primitives + 100k formulas, 10k of them hydrated).
//
// Identities:
//   - every edited source row r has EXACTLY one dependent (B_r), and
//     only hydrated dependents have edges — so total dirty-BFS visits
//     across the storm == (number of edits in the hydrated region)
//     exactly, and edits in the parked region do ZERO dirty work.
//     Work is bounded by Σ dependents, never O(edits × sheet size).
//   - final state is closed-form: B_r == (last value written to A_r)
//     + 1 for every edited row; the verification sweep re-evals
//     exactly one formula per DISTINCT edited row.
// =====================================================================

#[test]
fn s11_mutation_storm_dirty_work_bounded_by_fanout() {
    const N: u32 = 100_000; // primitives; same number of formulas
    const HYDRATED: u32 = 10_000;
    const STORM_EDITS: u32 = 10_000; // into the hydrated region
    const PARKED_EDITS: u32 = 2_000; // into the parked region

    let mut sheet = Sheet::new();
    sheet.bulk_load(|loader| {
        for r in 1..=N {
            loader.set_cell(&format!("A{r}"), num(r as f64));
            loader.set_formula(&format!("B{r}"), &format!("=A{r}+1"));
        }
    });

    // Hydrate the first 10k formulas (each has exactly one point dep).
    for r in 1..=HYDRATED {
        assert_eq!(sheet.get_cell(&format!("B{r}")), num((r + 1) as f64));
    }
    assert_eq!(
        sheet.debug_dep_graph_stats().formula_count,
        HYDRATED as u64
    );

    // Storm. Rows are LCG-chosen (deterministic); values are unique and
    // strictly increasing so every write is a real change (the store
    // dedups same-value writes).
    let mut lcg = Lcg::new(0x5EED_CAFE);
    let mut finals: HashMap<u32, f64> = HashMap::new();
    let visits_before = sheet.debug_dirty_visit_count();
    for i in 0..STORM_EDITS {
        let r = 1 + (lcg.next() % HYDRATED as u64) as u32;
        let v = 1_000_000.0 + i as f64;
        sheet.set_cell(&format!("A{r}"), num(v));
        finals.insert(r, v);
    }
    assert_eq!(
        sheet.debug_dirty_visit_count() - visits_before,
        STORM_EDITS as u64,
        "total dirty-BFS visits must equal Σ dependents (1 per edit), \
         independent of sheet size"
    );

    // Edits into the parked region: those dependents have NO edges yet,
    // so the storm does zero dirty work there.
    let mut parked_finals: HashMap<u32, f64> = HashMap::new();
    let visits_before = sheet.debug_dirty_visit_count();
    for i in 0..PARKED_EDITS {
        let r = 50_001 + (lcg.next() % 10_000) as u32;
        let v = 2_000_000.0 + i as f64;
        sheet.set_cell(&format!("A{r}"), num(v));
        parked_finals.insert(r, v);
    }
    assert_eq!(
        sheet.debug_dirty_visit_count() - visits_before,
        0,
        "edits to sources of parked formulas must do zero dirty work"
    );

    // Final closed-form state; the sweep re-evals exactly one formula
    // per distinct edited row (hydrated re-eval or first hydration).
    let evals_before = sheet.debug_formula_eval_count();
    for (&r, &v) in finals.iter().chain(parked_finals.iter()) {
        assert_eq!(
            sheet.get_cell(&format!("B{r}")),
            num(v + 1.0),
            "B{r} must reflect the LAST write to A{r}"
        );
    }
    assert_eq!(
        sheet.debug_formula_eval_count() - evals_before,
        finals.len() + parked_finals.len(),
        "verification sweep must eval exactly once per distinct edited row"
    );

    // Untouched rows still read their original closed form, cache-clean.
    let evals_before = sheet.debug_formula_eval_count();
    for r in [20_001u32, 30_000] {
        assert_eq!(sheet.get_cell(&format!("B{r}")), num((r + 1) as f64));
    }
    assert_eq!(
        sheet.debug_formula_eval_count() - evals_before,
        2,
        "two parked hydrations, nothing else"
    );
}

// =====================================================================
// Heavy twins — wall-clock-scale variants of two representative shapes,
// kept out of the always-on budget. Run with:
//   cargo test --test scale_suite -- --ignored
// =====================================================================

#[test]
#[ignore]
fn heavy_s1_chain_500k() {
    s1_chain_body(500_000);
}

#[test]
#[ignore]
fn heavy_s7a_insert_row_on_500k_parked_formulas() {
    s7a_insert_row_body(500_000);
}
