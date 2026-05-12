# Phase 3 — Parallel Execution Plan

> Date: 2026-05-12
>
> Companion to `ONLINE_SPREADSHEET_PLAN.md` § Phase 3. Phase 2 made the
> in-sheet dep graph scale; Phase 3 lifts the same shape to the Workbook
> so cross-sheet writes dirty cross-sheet formulas without forcing reads.

## What Phase 2 Left

Workbook today implements cross-sheet **reads** via `WorkbookEvalProvider`
(workbook.rs:312) with `force_formula_recompute() == true`. That means
every `wb.get_cell(...)` re-evaluates any formula on its dep chain that
contains a `SheetRef`. It hides the staleness — but a subscriber on
`Sheet1!C1 = =Sheet2!A1` does NOT fire when `Sheet2!A1` is written,
because Sheet's local `cell_dependents` knows only same-sheet deps.

The Sheet type itself is workbook-agnostic. `Sheet::set_cell` /
`set_formula` / `clear_cell` don't know they're inside a Workbook,
so they can't notify cross-sheet dependents.

Existing test `workbook_get_cell_refreshes_cross_sheet_cache_without_notifying`
(workbook.rs:489) is the *documented* current behavior:
```
sheet.subscribe_cell("B1", ...);
wb.sheet_mut(0).set_formula("B1", "=Data!A1*2");
wb.sheet_by_name_mut("Data").set_cell("A1", ...);   // cross-sheet write
// subscriber didn't fire.
```
Phase 3's job is to make that subscriber fire.

## Architectural Decision (codex review confirmed)

**Mutations are routed through `Workbook`**. New methods:

```rust
impl Workbook {
    pub fn set_cell(&mut self, sheet_idx: usize, addr: &str, value: Value);
    pub fn set_formula(&mut self, sheet_idx: usize, addr: &str, src: &str) -> bool;
    pub fn clear_cell(&mut self, sheet_idx: usize, addr: &str);
    pub fn bulk_load<F: FnOnce(&mut WorkbookLoader)>(&mut self, f: F);
}
```

Each method calls the underlying `Sheet::set_*`, then walks the
workbook-level dep index to mark cross-sheet dependents dirty and fire
their subscribers. `Sheet::set_*` direct calls stay valid for
single-sheet tests but lose cross-sheet correctness; the workbook tests
migrate first.

The codex pick was option A from the three considered:

- **(A) ✓ Mutations through Workbook** — only option where the
  workbook dep graph is authoritative.
- **(B) ✗ Sheet callback** — self-borrow / lifetime problems, and
  formula changes need both old/new deps, not just an "addr changed"
  ping.
- **(C) ✗ Subscribe-as-graph** — subscriptions are viewport / user
  notification plumbing. Cross-sheet ranges would force subscribing to
  every cell in `Sheet2!A1:A100`, breaking the sparse contract.

Future worker RPC (Phase 5) fits A cleanly: worker owns `Workbook`, UI
sends authoritative `set_cell` / `set_formula` / `bulk_load` commands.

## Index Shape

Workbook gains:

```rust
struct CrossSheetDeps {
    /// REVERSE edges, point-cell variant.
    /// (src_sheet, src_addr) → set of (formula_sheet, formula_addr)
    cell_dependents: HashMap<(usize, CellAddress), HashSet<(usize, CellAddress)>>,

    /// REVERSE edges, range variant. Per source sheet, the same
    /// row+col+wide bucket trio as Sheet's RangeDependentIndex.
    /// Keyed by source sheet so we can run dirty_for_addr in one source.
    range_index_per_sheet: HashMap<usize, RangeDependentIndex>,

    /// FORWARD edges (for cycle detection): (formula_sheet, formula_addr) →
    /// list of (target_sheet, target_addr-or-range). Replaces the
    /// per-call AST walk in `collect_workbook_refs`.
    formula_refs: HashMap<(usize, CellAddress), Vec<CrossSheetRef>>,
}

enum CrossSheetRef {
    Cell(usize, CellAddress),
    Range(usize, CellRange),
}
```

`SUM(Sheet2!A1:A100)` registers:
- `formula_refs[(formula_sheet, formula_addr)] += CrossSheetRef::Range(Sheet2, A1:A100)`
- `range_index_per_sheet[Sheet2].add_formula(A1:A100, (formula_sheet, formula_addr))`

A `Workbook::set_cell(Sheet2, A50, _)` then:
1. Calls `Sheet2::set_cell` (the existing path — fires Sheet2's local subscribers + dirties Sheet2's local dependents).
2. Looks up `cell_dependents[(Sheet2, A50)]` ∪ `range_index_per_sheet[Sheet2].dependents_of(A50)`.
3. For each `(formula_sheet, formula_addr)` returned: mark that formula's cache dirty in its sheet AND fire `formula_sheet.cell_subscriptions[formula_addr]`.
4. BFS through any chained cross-sheet edges so transitive subscribers also fire (`Sheet1!D = =Sheet2!C` where `Sheet2!C = =Sheet3!A`, then `Sheet3!A` write must dirty `D` too).

## Tracks

| Track | Owner | Scope | Effort | Parallelism |
|---|---|---|---|---|
| **I** | Cross-sheet dep graph + workbook mutators | `workbook.rs`: `CrossSheetDeps` struct, `set_cell`/`set_formula`/`clear_cell`, `WorkbookLoader::bulk_load`, dirty-propagation BFS that fires subscribers across sheets. | 4–5 d | sequential — owns the structural change |
| **J** | Cycle detection sharing the forward index | `workbook.rs` `cross_sheet_cycle` refactor + runtime cycle fallback that consults the same `formula_refs` map I builds. Add `#CYCLE!` return for runtime path that bypasses static check. | 1–2 d | **after** I merges |
| **K** | WASM workbook API | `rust/wasm/src/lib.rs` `WasmWorkbook`: expose `set_cell` / `set_formula` / `clear_cell` / `bulk_load` / `subscribe_cell` (the per-cell subscriber that fires on cross-sheet writes). | 2 d | parallel with I (different file) |
| **L** | Cross-sheet scale tests + bench | New `tests/cross_sheet.rs` (3 acceptance cases, `#[ignore]`'d until I merges) + `benches/scale_bench.rs` extension (10k cross-sheet formulas dirty bench). | 1 d | parallel with I + K |

## File Conflict Matrix

|  | I | J | K | L |
|---|---|---|---|---|
| **I** | — | workbook.rs different regions; J depends on I | no (different crate) | no (tests + benches) |
| **J** | (above) | — | no | no |
| **K** | no | no | — | no |
| **L** | no | no | no | — |

Main coupling: J needs I's `formula_refs` to exist before it can replace
the `collect_workbook_refs` AST walk. K is fully independent in its own
crate (`rust/wasm/`).

## Sequencing

```
Day 0:  I starts ─┐
        K starts ─┤  three parallel
        L starts ─┘
Day 1:  K merges (additive WASM bindings)
        L merges (tests with #[ignore]'d cross-sheet cases)
Day 3:  I merges (workbook dep graph + mutators)
        L un-ignores (cross-sheet acceptance tests turn green)
Day 4:  J starts (cycle detection rewrite atop I's forward index)
Day 5:  J merges
```

## Track I — Cross-Sheet Dep Graph + Workbook Mutators

**Concrete deliverables:**

1. `CrossSheetDeps` struct on `Workbook`.
2. `Workbook::set_cell(sheet_idx, addr, value)`:
   - Calls `Sheet::set_cell`.
   - Looks up cross-sheet dependents from `CrossSheetDeps` and dirties
     their formula caches via `Sheet::mark_dirty_for_addr(formula_addr)`
     (new helper) + fires their `cell_subscriptions` listeners.
   - BFS one layer at a time (NOT recursion) for transitive cross-sheet
     edges. Use a `VecDeque<(sheet_idx, addr)>`.
3. `Workbook::set_formula(sheet_idx, addr, src)`:
   - Parses, collects forward refs (cell + range, per-target-sheet).
   - Removes the previous formula's edges from `CrossSheetDeps`
     (mirror of `Sheet::remove_formula_record`).
   - Adds the new formula's edges into both reverse + forward indexes.
   - Calls `Sheet::set_formula`. Order: dep update BEFORE
     `Sheet::set_formula` so a re-set on the same addr can wire up
     correctly.
4. `Workbook::clear_cell(sheet_idx, addr)`:
   - Calls `Sheet::clear_cell`.
   - Removes the cleared addr's outgoing edges from `CrossSheetDeps`
     (if it was a formula).
   - Propagates dirty to cross-sheet dependents (a cleared cell is a
     write to Null, same dirty fanout).
5. `WorkbookLoader::bulk_load`: collect touched `(sheet, addr)` and
   formula dep changes during the batch, suppress per-write fanout,
   then flush once at end: update CrossSheetDeps, run one workbook-wide
   dirty BFS, notify each subscriber at most once.

**Sheet helpers needed (additive, can land in I's first commit):**

- `Sheet::mark_dirty_for_addr(addr)` — public counterpart to the
  existing internal dirty-marking path, callable by Workbook to dirty
  a specific formula without forcing eval.
- `Sheet::fire_subscribers(addr)` — public helper to fire the
  cell_subscriptions bucket for an addr; Workbook calls it after
  cross-sheet dirty propagation.

**Acceptance test added in this track:**

- `cross_sheet_write_fires_dependent_subscriber` — the inverse of the
  current `workbook_get_cell_refreshes_cross_sheet_cache_without_notifying`.
  Subscribe on `Sheet1!B1`, set `B1 = =Sheet2!A1`, then write `Sheet2!A1`
  via `wb.set_cell(...)`. Assert subscriber count > 0.

**Files I owns:** `workbook.rs`, plus the two additive helpers in
`sheet.rs`.

**DO NOT touch:** `WasmWorkbook` (Track K), benches (Track L's lane),
new test files under `tests/` (Track L).

## Track J — Cycle Detection on the Shared Graph

**Goal:** the cross-sheet cycle BFS uses Track I's `formula_refs`
forward index, not a per-call AST walk via `collect_workbook_refs`.

Concrete work:
- Delete `collect_workbook_refs` (or downgrade to a per-test helper).
- Rewrite `Workbook::cross_sheet_cycle(target_idx, target_addr, expr)`
  to walk `formula_refs` starting from the deps of `expr`, BFS through
  edges, and return true if `target` reappears.
- Add a runtime cycle fallback that engages when an eval recursion
  exceeds a depth threshold (uses the same graph to identify the
  cycle and returns `Value::Error(ValueError::Cycle)`).

**Acceptance test added:**
- `cross_sheet_runtime_cycle_returns_cycle_value` — set up a cycle
  that the static check misses (e.g. via a formula reset that
  introduces the cycle, where dep registration races eval).

## Track K — WASM Workbook API

**Concrete deliverables on `WasmWorkbook` (rust/wasm/src/lib.rs):**

1. `set_cell_str(sheet_idx, addr, text)` / `set_cell_number(...)` /
   `set_cell_boolean(...)` mirroring Sheet's WASM exposure.
2. `set_formula(sheet_idx, addr, source) -> bool`.
3. `clear_cell(sheet_idx, addr)`.
4. `subscribe_cell(sheet_name, addr, JsFunction) -> token`. Each
   workbook keeps a map from `(sheet_idx, CellAddress)` to the
   js_sys::Function instances and fires them on cross-sheet dirty
   propagation (Track I's BFS).
5. `unsubscribe_cell(token)`.
6. `debug_cross_sheet_dependents_count()` — for tests / e2e.

**bulk_load**: skip for K's first pass — JS-side closure crossing the
WASM boundary needs a separate design (JS-managed loader vs Rust
batched call). Note it as deferred and leave a stub.

**Files K owns:** `rust/wasm/src/lib.rs` (additive).

**DO NOT touch:** any `excel-core/src/*`, frontend, docs.

## Track L — Tests + Bench

**New file `rust/excel-core/tests/cross_sheet.rs`** (separate from
`tests/scale.rs` so the file scope reads cleanly):

1. `write_propagates_to_cross_sheet_subscriber` —
   `#[ignore = "phase-3 — un-ignore after Track I merges"]`. Subscribe
   on `Sheet1!C1`, set `C1 = =Sheet2!A1`, write `Sheet2!A1` via
   `wb.set_cell(...)`, assert subscriber count == 1 and `wb.get_cell("Sheet1", "C1")` returns the new value.

2. `cross_sheet_chain_no_eager_eval` — `Sheet3!A = 1`,
   `Sheet2!B = =Sheet3!A`, `Sheet1!C = =Sheet2!B`. Subscribe on all
   three formula cells. Write `Sheet3!A = 99`. Assert ALL three
   subscribers fired AND no formula was evaluated yet (eval counter
   stays at baseline). `wb.get_cell("Sheet1", "C1")` then yields 99
   and bumps the counter by 3.

3. `cross_sheet_range_dirty` — `Sheet1!D = =SUM(Sheet2!A1:A100)`.
   Write `Sheet2!A50` (empty before). Assert `Sheet1!D`'s subscriber
   fires. (Cross-sheet equivalent of Phase 1's P0 range-dep
   correctness.)

**Bench in `benches/scale_bench.rs`** (additive):

- `bench_cross_sheet_dirty_propagation_10k` — 10 000 formulas in
  `Sheet1` each referencing a unique cell in `Sheet2`. Setup outside
  timed section. Time: one `wb.set_cell("Sheet2", "A50", ...)`. Phase
  2's bench measured same-sheet; this measures cross-sheet
  propagation.

## Phase 3 Acceptance Roll-Up

- ✅ Subscriber on cross-sheet formula fires on source write (Track L test #1).
- ✅ Cross-sheet chain stays dirty without eager eval (Track L test #2).
- ✅ Cross-sheet range dep survives sparse eval (Track L test #3).
- ✅ Cross-sheet cycle returns `#CYCLE!` without stack overflow
  (Track J test).
- ✅ Phase 1 + Phase 2 acceptance (Phase 1's 6 + Phase 2's 2) stay
  green.
- ✅ WASM bindings expose workbook mutators + cross-sheet subscribe.
- ✅ No new clippy regressions vs the Phase 2 baseline.

## Stop Conditions

- Track I's BFS hits self-borrow problems making `Workbook::set_cell`
  awkward (e.g. needing two mutable sheets simultaneously). If so,
  split the dirty-propagation phase into two passes: collect the
  `(sheet, addr)` set first (with immutable borrows), drop the borrow,
  then do mutations + listener fires in a second pass.
- Track K's subscribe-across-sheets exceeds budget because of JS
  function lifetime / dropping. Defer cross-sheet subscribe to Phase
  5 (worker push) and only ship workbook mutators + sync read in K.
- Track J's cycle rewrite breaks existing 5 cycle tests in
  `workbook.rs`. Keep `collect_workbook_refs` as a fallback path
  used only when `formula_refs` doesn't contain an entry yet (e.g.
  during the same set_formula call that's running the cycle check).

## Non-Goals for Phase 3

- UI work (column virtualization, 1M demo) — Phase 4.
- Worker authoritative RPC for fallible operations — Phase 5 prep.
- Persistence / chunked CSV import — Phase 5.
- Cross-workbook references — out of scope.
