# Phase 1 — Parallel Execution Plan

> Date: 2026-05-12
>
> Companion to `ONLINE_SPREADSHEET_PLAN.md` § Phase 1. The parent doc
> defines deliverables and acceptance criteria; this doc breaks them
> into 4 agent tracks, pins the P0 bug location, and specifies the
> sequencing required to avoid merge collisions on `sheet.rs`.

## P0 Bug — Pinned

`ONLINE_SPREADSHEET_PLAN.md` claims sparse range evaluation collapses
range deps into "only the visited addresses". The static-expansion path
in `collect_refs` (sheet.rs:1363) might suggest the bug is historical,
so the actual failing path was traced before kicking off agents:

| Step | Where | What happens |
|---|---|---|
| 1 | sheet.rs:1363 (`collect_refs`) | Static expansion of `Expr::Range` registers every cell in the rectangle as a dep. So far correct. |
| 2 | sheet.rs:419 / 427 (`set_formula` → `formula_deps_for` → `add_formula_deps`) | Initial deps land in `cell_dependents` — A50000 is included even when empty. |
| 3 | sheet.rs:584 (inside `get_cell` eval) | Evaluation builds a **fresh** tracked dep set as the eval walks references. |
| 4 | sheet.rs:1522 + 509 / 533 (sparse iter inside `for_each_range_cell`) | The sparse iterator only yields **non-empty** primitive/formula cells in the range. A50000 (empty) is not visited. |
| 5 | sheet.rs:591 → 254 (`replace_formula_deps`) | The fresh tracked set **replaces** the original static deps. A50000 is now gone from the dependents map. |
| 6 | Later: user writes `A50000` | No formula is dirtied — the dep was discarded in step 5. SUM stays stale. |

The eval-time `IF`-branch narrowing (eval.rs:481) is the same mechanism;
that one is intentional (only deps on the chosen branch are correct).
The bug is **range deps being narrowed to visited cells**.

## Fix Shape

Two compatible approaches; final choice is Agent A's call after a red
test pins the contract:

- **Range-typed deps**: store ranges as ranges (not as their expanded
  cell list) in a new `range_deps` index. Sparse iteration during eval
  does **not** rewrite this index. Dirty notification on a cell write
  consults both `cell_deps` (point) and `range_deps` (interval
  containment).
- **Static-only range deps + dynamic cell deps**: keep the per-cell
  expansion at `set_formula` time as ground truth for ranges; only
  *non-range* refs (`CellRef`, `SheetRef`) can be replaced by the
  eval-tracked set.

Phase 2 ("range dep interval index") will revisit the data structure
for scale; Phase 1's job is the correctness contract, not the index
layout. The split matches `ONLINE_SPREADSHEET_PLAN.md`'s call for
explicit `cells`, `ranges`, `sheet_cells`, `sheet_ranges` typed deps.

## Track Assignment

| Track | Owner | Files | Effort | Parallelism |
|---|---|---|---|---|
| **A** | Core lazy engine | `excel-core/src/sheet.rs`, `excel-core/src/eval.rs` | 3–5 d | sequential — owns the structural change |
| **B1** | Counters (no struct dep) | `excel-core/src/sheet.rs` (debug_* region only) + `wasm/src/lib.rs` | 1 d | parallel with A |
| **B2** | Counters (struct-dep) | same files as B1 | 0.5 d | **after** A merges |
| **C** | Scale tests | `excel-core/tests/scale.rs` (new) | 1–2 d | parallel with A — tests RED until A lands |
| **D** | Benches | `excel-core/benches/scale_bench.rs` (new) | 1 d | parallel with A |

### Track A — Range dep correctness + typed split

**First commit must be a red test** (before any production change) that
pins the P0 shape:

```rust
#[test]
fn range_dep_survives_sparse_eval() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(1.0));
    sheet.set_cell("A100", Value::Number(2.0));
    sheet.set_formula("B1", "=SUM(A1:A100)");
    assert_eq!(sheet.get_cell("B1"), Value::Number(3.0));
    // A50 is empty and was skipped by sparse iteration. Writing it
    // must still dirty B1.
    sheet.set_cell("A50", Value::Number(10.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(13.0)); // currently fails
}
```

Then:

- Introduce `FormulaRecord::range_deps: RefCell<HashSet<CellRange>>`
  alongside the existing `deps: RefCell<HashSet<CellAddress>>`.
- `set_formula` collects ranges via a new `collect_range_refs` (mirror
  of `collect_refs` but emits `CellRange` for `Expr::Range`).
- `replace_formula_deps` keeps range deps intact across eval; only
  the point-cell set is overwritten by the tracked eval set.
- Dirty propagation in `notify_dependents` (and the BFS at
  sheet.rs:1310) consults `range_dependents` (a new
  `HashMap<CellRange, HashSet<CellAddress>>` or, scaled up later, an
  interval index) when deciding which formulas a cell write touches.
- WASM-facing API is unchanged. The debug counter additions for
  range deps are B2's concern.

### Track B1 — Counters without struct dependency

Add to `Sheet`:

- `debug_formula_eval_count()` — total formula evaluations performed
  (miss = compute, hit = cache served). Two counters or one with a
  hit/miss enum.
- `debug_dirty_count()` — currently-dirty formula records.
- `debug_imported_formula_count()` — formulas registered via
  `bulk_load`.
- `debug_live_subscription_count()` — sheet-level subscription buckets
  with at least one listener.

WASM bindings (`excel/rust/wasm/src/lib.rs`) expose each as `debug_*` methods
on `WasmSheet`. No new dep-shape coupling required.

### Track B2 — Counter for range deps

Single counter: `debug_range_dep_count()` returning the size of the
range-dep index Agent A introduces. Must land after A merges so the
field exists. Single small commit.

### Track C — Scale Rust tests

New file `excel-core/tests/scale.rs`. Six cases mirroring the Phase 1
acceptance list, all using public `Sheet` API only (no internals):

1. `import_100k_formulas_zero_eval` — `bulk_load` 100 000 formulas,
   `debug_formula_eval_count()` stays at 0.
2. `viewport_read_100_reaches_only_visible` — set 1k formulas across a
   sparse grid, read 100, eval count == 100 (not 1k).
3. `empty_cell_subscribe_no_atom` — subscribe to A1 (empty), assert
   `debug_primitive_atom_count()` stays 0.
4. `range_sparse_then_write` — the P0 case. Already drafted as Agent
   A's first red test; C lifts it into the public scale suite.
5. `dirty_notify_no_eager_compute` — subscribe to a formula, mutate its
   dep, check listener fires without `get_cell` being called on the
   formula in between (use eval counter).
6. `null_write_releases_primitive_atom` — set then clear, atom count
   drops.

All six start as `#[ignore]` so CI passes pre-merge; they un-ignore
when A and B1 land. Don't touch existing test files.

### Track D — Bench smoke

New file `excel-core/benches/scale_bench.rs`. Two benches:

- `bulk_load_100k_formulas` — measure import wall time.
- `sparse_1m_grid_read_window` — 1 000 000-cell coordinate space with
  10 000 non-empty cells; read a 50-row × 27-col window and measure
  per-window latency.

Independent file, no production-code edits, no merge risk with A/B/C.

## Sequencing

```
Day 0:  A starts ─┐
        B1 starts ┼─ all four launch in parallel
        C starts ─┤
        D starts ─┘
Day 1:  D merges        (bench file, fully independent)
        B1 merges       (counter scaffold, additive)
        C tests written as #[ignore]'d
Day 2:  A's red test merges (proves P0 reproducibly)
Day 3:  A merges        (struct split + bug fix)
Day 4:  B2 merges       (range-dep counter)
        C un-ignores    (suite turns green)
```

## Merge Coordination

- **B1 must not touch `FormulaRecord` or `cell_dependents`**, only the
  `debug_*` region (currently sheet.rs:650+) and additive method blocks.
  Rebase on `main` daily; expect zero conflicts.
- **A and B1 will both edit `Sheet`**. Conflicts on the impl block
  separator lines are resolvable; force the order "A first, B1 rebases"
  only if the structural patch reorders methods.
- **C uses only public API** (`set_cell`, `set_formula`, `get_cell`,
  `bulk_load`, `subscribe`, `debug_*`). No risk against A.
- **D is in a new file**. Zero risk.

## Stop Conditions for Phase 1

Pause and re-plan if any becomes true:

- Test #4 (`range_sparse_then_write`) passes today against `main` —
  the bug is already gone and the fix scope is smaller than planned.
- The structural split forces a rewrite of `notify_dependents` BFS so
  large that B2 has nothing left to add — collapse B2 into A.
- Eval-time range tracking turns out to be the *intended* behavior of
  some other code path (e.g. a function whose semantics depend on
  non-empty membership). In that case, reframe the fix as "static range
  deps shadow dynamic narrowing, opt-out via attribute".

## Non-Goals for Phase 1

- Interval-index / spatial structures for range deps — that's Phase 2.
- Frontend changes — viewport / column virtualization is Phase 4.
- Worker authoritative RPC — Phase 5 prep.
- Cross-sheet reverse dep graph — Phase 3.
