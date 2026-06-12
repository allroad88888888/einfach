# Pattern-family audit — 2026-06-12

Cross-engine audit for the four mutation-path anti-patterns surfaced by the
lazy-formula-indexing and storage-primary arcs
(`LAZY_FORMULA_INDEXING_PLAN.md`, `STORAGE_PRIMARY_PLAN.md`):

- **P-A** eager fan-out on write — mutation cost proportional to TOTAL sheet
  size, not change size.
- **P-B** per-item ceremony in bulk paths.
- **P-C** bypassed propagation — a mutation entry missing invalidation that
  sibling entries fire.
- **P-D** incomplete teardown — replace/delete/clear missing a parallel
  state table.

Sections are appended per territory as audits land.

## Triage — fix waves (architect, 2026-06-12)

Totals: **9 P1 / 15 P2 / 13 P3** across A (Rust structural), B (Rust
restore/recalc/atoms), C (TS port), D (UI core + adapters).

### Wave 1 — correctness (wrong values / panics; ship first)

| # | Findings | Area | Fix shape |
|---|---|---|---|
| W1.1 | **A-4 + A-5** (panic: clear_range over spill; spill_targets not relocated by structural edits) — **FIXED** `1414f1b` | Rust sheet.rs spill | `BulkLoader::set_cell` / `set_formula` / `set_formula_lazy` now carry the single-cell spill guards (target write skipped/rejected, anchor write tears down) and `flush` runs `recompute_array_formulas_in(dirty)`; structural ops tear every spill down pre-shift and re-derive surviving anchors post-retarget (teardown+re-derive, not key remapping). Matrix in `tests/spill_structural.rs`. |
| W1.2 | **A-6 + A-7** (remove_sheet wipes cross-sheet graph permanently; rename_sheet changes values with no notify) — **FIXED** `08c1d86` | Rust workbook.rs | `remove_sheet` rebuilds via existing `rebuild_cross_sheet_deps` instead of wipe; `rename_sheet` fires the same rebuild + dirty fanout `install_sheet_bulk` now uses. |
| W1.3 | **B-4** (named refs invisible to cross-sheet edge walkers → confirmed stale value) — **FIXED** `08c1d86` | Rust eval/workbook walkers | `collect_cross_sheet_refs` + latch walker resolve `Expr::Name` through `by_name` (incl. LAMBDA bodies). |
| W1.4 | **C-5** (withBatch throw: registry mutated but invalidation dropped) — **FIXED** `a62927d` | TS workbook.ts | On outermost-throw either roll back registry or fire the pending recalc; pick rollback (matches abort intent already documented). Small. |

### Wave 2 — catastrophic scaling (the P-A/P-B P1s)

| # | Findings | Area | Fix shape |
|---|---|---|---|
| W2.1 | **A-1** (+ satellites A-2, A-3, A-9) insert_row = full hydrate + re-render + re-parse; 500k → 2.09 s and sheet turns eager forever — **FIXED** `0ca3a16` | Rust structural | Lazy retarget landed as sketched (option (a), textual rewrite at edit time): parked SOURCE TEXT shifted via token-level ref rewrite (`shift::rewrite_parked_source`, no parse, no hydration); hydrated entries install the `map_addrs` AST directly (render→re-parse killed) and skip reinstall when unchanged. 500k insert_row 2.09 s → **127 ms**, dep graph stays empty. `rebuild_cross_sheet_deps` gained the `!`-prefilter; `clear_range` dedups per visited address. Details + bench tables in § A-1/A-2/A-3. |
| W2.2 | **C-1 + C-2** (+ C-6) TS port: whole-Map clone per edit (107 ms @1M) + flush re-evals every cached formula (503 ms @100k) + atom cache never evicts — **FIXED** `d98409c` (RFC `49d6f86`) | TS excel-core-ts (vanilla/core untouched) | Key-granular invalidation landed per `vanilla/excel-core-ts/docs/KEY_GRANULAR_INVALIDATION.md`: per-formula epoch atoms + workbook DepGraph (lazy hydrate-on-read dep install, TS mirror of `cell_dependents`/`range_dependents`), in-place storage + per-sheet `revisionAtom`, eviction on overwrite. setCell @1M: 107 ms → ~0.005 ms; @100k cached formulas: 503 ms/100k re-evals → ~0.005 ms/0 re-evals (re-evals == true dependents, pinned); C-6 drag gone. 1811 engine + 3720 monorepo tests, e2e `--project=ts` 480/0/37 green. |
| W2.3 | **B-1** restores ride legacy per-cell loader (eager parse, no prefilter, double parse) | Rust wasm lib.rs | Route `restore_sparse` / `restore_persistence_v1` through `install_workbook_bulk` (they are fresh-shell semantics → full replace is correct). Mechanical; mirrors 6.3. |
| W2.4 | **D-1 + C-4** clearRange dense coordinate loop (column delete ≈ 1M engine calls); no bulkClear primitive | engine + both runtimes | Add engine `clear_range` sparse primitive (iterate EXISTING cells in range, not coordinates); runtimes call it once. |

### Wave 3 — P2 hygiene (batchable, after waves 1-2)

- **D-4 + D-5** adapter teardown leaks (deleteSheet overlays; readFormulaCells / snapshotSessions / importSessions on sheet ops) — one agent, worker adapters.
- **B-2** atom-per-primitive-cell (23% of install) — lazy/coarse atomization, perf project.
- **D-7 + D-8** filter/sort viewport full-scan + O(sheet) range reads.
- **D-2** static-backend deep-clone history (demo/test surface only).
- **C-3 / C-8 / D-10 / D-12** — docs/notes or small fixes.

P3s tracked in section bodies; revisit after Wave 3.

### Ordering rationale

Wave 1 items are silent-wrong-value or abort-class bugs reachable from
normal UI gestures (delete over a spill, removing/renaming a sheet, a
LAMBDA touching another sheet). Wave 2 items are the performance promise
of the whole arc — without W2.1/W2.2 the lazy-import win evaporates on
the first structural edit (Rust) and large workbooks stay un-editable
(TS). Wave 3 is debt that doesn't bite until specific features are hot.

## A — Structural ops (Rust)

Audit date 2026-06-12. Read-only; repro pins live in
`rust/excel-core/tests/audit_structural_scaling.rs` (5 always-on tests
pinning CURRENT behavior — including the bugs — plus 3 `#[ignore]`d
timing benches). Numbers below: Apple Silicon, `cargo test --release
--test audit_structural_scaling -- --ignored --nocapture`. WASM hosts
should expect a multi-x multiplier on top. `cargo test --lib` green
(1396 tests) with the pins included.

### Findings

#### A-1 · P-A · **P1** — one `insert_row` hydrates + re-parses EVERY formula on the sheet — **FIXED**

- **FIXED** (W2.1, `0ca3a16`): the fix sketch's FIRST option (textual
  rewrite at edit time) landed, plus the full hydrated-path cleanup:
  - LAZY: `Sheet::retarget_parked_sources` rewrites A1-style tokens in
    parked source text via `shift::rewrite_parked_source` — a one-pass
    byte scanner mirroring `parse_formula`'s tokenization (string
    literals, function names incl. `LOG10(`/`A1(...)`, sheet names,
    sheet-qualified refs all skipped; whole-row/whole-col pinned-axis
    rules replicated; allocation only when a token actually shifts).
    Refs into a deleted band → `write_error(#REF!)`, with a parse
    check so unparseable parked garbage keeps its `#VALUE!` fate.
    Pinned by a corpus test asserting
    `parse(rewrite(src)) == map_addrs(parse(src))` per edit kind
    (`src/shift.rs` tests) — this is what makes option (a) provable;
    option (b) (deferred shift transforms) stays a follow-up if the
    O(lazy) string pass ever dominates a profile.
  - HYDRATED: `retarget_formula_refs` installs the `map_addrs` result
    directly (render→re-parse killed; render kept only for
    `formula_texts` of changed formulas) and skips reinstall when the
    mapped AST is unchanged — keeping the cached value unless a range
    dep can see the shifted region (`ShiftEdit::touches_range`,
    covers unbounded `A:A`) or an eval-tracked dep moved (OFFSET-
    style), which flip the cache Dirty.
  - Indexes: `relocate_cells` no longer rebuilds; ONE
    `rebuild_all_formula_dependents` at the end of the hydrated
    retarget (O(hydrated) — ~0 under the lazy contract; both key and
    value sides shift, so an in-place key patch would be the same
    full remap), then a cache-only dirty BFS from every value-changed
    cell so AST-unchanged dependents re-evaluate.
  - The 7d0e380 self-cycle pin holds (text rewritten in the same
    shift as the key relocate); W1.1 spill teardown/rederive order
    preserved. New engine-level matrix in
    `tests/lazy_structural_retarget.rs`; A-1/B-3 pins flipped.
  - **codex P1 follow-up (post-`0ca3a16`)**: AST-unchanged formulas
    dirtied via `tracked_moved`/`range_touched` were NOT added to the
    silent-BFS root set, so their AST-unchanged dependents kept stale
    caches (`B1=SUM(A:A)`, `C1=B1*10`, delete a row inside A's data →
    B1 recomputes but C1 serves the old product). Fix in
    `retarget_formula_refs`: such a formula joins `value_changed` iff
    its cache was `Clean(_)` before the flip — an already-Dirty
    formula's clean dependents are impossible (evaluating a dependent
    re-cleans its inputs; whatever dirtied the formula dirtied its
    dependents), so never-read formulas add no BFS roots and the
    500k bench stays ~127–131 ms. Pinned by three tests in
    `tests/lazy_structural_retarget.rs` (delete_row, insert_row, and
    a transitive B1→C1→D1 chain).
- Measured post-fix (same bench, Apple Silicon release; sheet stays
  LAZY so the second insert rides the same textual path):

  | formulas | first insert (was) | first insert (now) | second insert (now) |
  |---|---|---|---|
  | 1k | 4.7–6.0 ms | 0.89 ms | 0.58 ms |
  | 10k | 32 ms | 4.0 ms | 3.6 ms |
  | 100k | 335–375 ms | 26.8 ms | 22.8 ms |
  | 500k | **2.09 s** | **127 ms** | 115 ms |

  `debug_cell_dependents_key_count` stays 0 across both edits (bench
  now asserts it). 16× at Mega tier, and the lazy import win is no
  longer repaid on the first edit.
- `sheet.rs:3654/3672/3688/3704` — all four structural ops
  (`insert_row` / `delete_row` / `insert_col` / `delete_col`) start
  with `hydrate_all_lazy_formulas()` (`:3724`), parse + dep-install for
  every parked formula (the 7d0e380 codex fix for the self-cycle bug).
  Then `relocate_cells` (`:3809`) rebuilds all six per-cell maps AND
  calls `rebuild_all_formula_dependents` (`:1243`, full dep-graph clear
  + re-add). Then `retarget_formula_refs` (`:3896`) walks EVERY
  `formula_exprs` entry, AST-clones it via `map_addrs`, renders it back
  to a string, and `rebuild_formula_lazy` (`:3922`) **re-parses the
  string it just rendered** and re-installs deps — even for formulas
  the shift left untouched.
- Measured, one `insert_row(0,1)` on a lazy-bulk-loaded sheet:

  | formulas | first insert | second insert (already hydrated) |
  |---|---|---|
  | 1k | 4.7–6.0 ms | 2.4–3.2 ms |
  | 10k | 32 ms | 16–17 ms |
  | 100k | 335–375 ms | 222–230 ms |
  | 500k | **2.09 s** | **1.35 s** |

  Perfectly linear in TOTAL formula count. At Mega tier (500k) the
  import win the lazy arc bought (428 s → 0.6 s) is repaid on the FIRST
  row insert — and the sheet is left fully hydrated/eager forever
  after, so the lazy contract is permanently destroyed by one
  structural edit. Pinned structurally (no timing) by
  `audit_insert_row_hydrates_every_lazy_formula`:
  `cell_dependents` goes 0 → N keys on one insert.
- Fix sketch: don't hydrate. Relocate the parked `formula_source` text
  keys (already done) and retarget lazily — either rewrite parked
  source text only for formulas whose refs cross the edit boundary
  (cheap textual A1-ref scan, no full parse), or park a per-sheet
  pending shift transform that `hydrate_formula` applies at first read.
  For already-hydrated formulas: install the `map_addrs` result
  directly (kill the render→re-parse round trip, P-B) and skip the
  rebuild entirely when the mapped AST is unchanged; make
  `relocate_cells` patch dep-index keys instead of
  `rebuild_all_formula_dependents`.

#### A-2 · P-A · **P2** — `move_sheet` parses every lazy formula on every sheet — **FIXED**

- **FIXED** (W2.1, `0ca3a16`): `rebuild_cross_sheet_deps` gained the
  exact `!`-prefilter from `install_sheet_bulk_inner` — parked sources
  without `!` skip the parse. Bypassed when the B-4
  `named_values_cross_sheet` latch is armed (parked `=READDATA()`
  carries an edge with no `!`); the W1.2/W1.3 cross-sheet propagation
  tests stay green. Measured `move_sheet(0,1)` with zero cross-sheet
  formulas: 1k → 36 µs (was 0.95 ms), 10k → 0.21 ms (was 4.7 ms),
  100k → **3.3 ms** (was 25.7 ms). The "key CrossSheetDeps by stable
  sheet id, making move_sheet O(1)" upgrade remains open.
- `workbook.rs:830` `move_sheet` → `rebuild_cross_sheet_deps`
  (`:792`) → `for_each_lazy_formula` + `parse_formula` per parked
  entry (`:813-819`), across ALL sheets — with **no `!`-prefilter**,
  even though `install_sheet_bulk_inner` (`:1690-1696`) already ships
  exactly that prefilter for the identical job.
- Measured, one `move_sheet(0,1)` with zero cross-sheet formulas:
  1k → 0.95 ms, 10k → 4.7 ms, 100k → 25.7 ms (linear; ~130 ms native /
  est. ≥0.5 s wasm at Mega tier, per sheet-tab drag).
- Fix sketch: copy the `!`-prefilter into `rebuild_cross_sheet_deps`
  (one-line scan, skips ~100% of typical sheets). Better: key
  `CrossSheetDeps` by sheet name or a stable sheet id instead of
  position index, making `move_sheet` O(1) with no rebuild at all.

#### A-3 · P-A · **P2** — clearing ONE cell is O(total formulas) — **FIXED**

- **FIXED** (W2.1, `0ca3a16`): landed as sketched —
  `for_each_non_empty_in_range` dedups per visited address (two map
  probes per cell actually inside the range) instead of materializing
  the global formula-key `HashSet`. A-9 folded in:
  `BulkLoader::set_cell_at` typed entry, so `Sheet::clear_range` no
  longer round-trips every address through strings. Measured
  `clear_range(B1:B1)`: 100k → 8 µs (was 3.6 ms), 500k → **11 µs**
  (was 22.8 ms) — now range-proportional. `Workbook::clear_range`
  shares the fixed scan (its loader path still carries the string
  addresses; dwarfed by the scan fix, tracked under A-9's remainder).
- `sheet.rs:3348-3355` — `for_each_non_empty_in_range` builds its
  `formula_keys` dedup `HashSet` from **all** `formula_cells` +
  `formula_source` keys, regardless of how small the requested range
  is. Both `Sheet::clear_range` (`:3367`) and `Workbook::clear_range`
  (`workbook.rs:1233`) pay it, as does every other caller of the
  range scan.
- Measured, `clear_range(B1:B1)` (one cell): 1k → 135 µs, 10k →
  523 µs, 100k → 3.6 ms, 500k → **22.8 ms** — linear in sheet size for
  a single-cell clear.
- Fix sketch: dedup per-visited-address instead of globally — for each
  `cells.range_iter` hit, check `formula_cells.contains_key` +
  `formula_source.contains_key` (two map probes per visited cell,
  range-proportional) rather than materializing the global key set.

#### A-4 · P-D · **P1** — `clear_range` over a spill region PANICS the engine — **FIXED**

- **FIXED** (W1.1, `1414f1b`): the fix sketch landed as written —
  `BulkLoader::set_cell` skips non-anchor spill-target writes (array
  stays intact, single-cell `set_cell` parity) and tears the spill down
  on anchor writes; `BulkLoader::set_formula` / `set_formula_lazy`
  reject target writes with `false` and tear down on anchor writes
  (covers the `set_formula_pre_parsed` workbook route and the
  parse-failure `write_error_no_notify` path); `flush` now ends with
  `recompute_array_formulas_in(&dirty)` so bulk dependency writes
  re-flow downstream dynamic arrays (`dirty` only holds registered
  formula addrs, so the lazy bulk-import zero-parse contract is
  untouched). Pin flipped to
  `audit_clear_range_over_spill_region_clears_cleanly`; full semantics
  matrix in `tests/spill_structural.rs`.
- `sheet.rs:4055-4096` — `BulkLoader::set_cell` has zero spill
  awareness: no `spilled_into_anchor` rejection, no
  `clear_spill_at_address` teardown (both of which the sibling
  `try_set_cell` path fires, `:2188/:2194`). `clear_range` routes every
  cleared address through it (`:3371`). On a spill TARGET,
  `ensure_cell` returns the existing read-only derived atom and
  `store.set` panics (`core/src/store.rs:315 "cannot set a read-only
  derived atom"`). `BulkLoader::flush` (`:4346`) also never runs
  `recompute_array_formulas_in`, so bulk paths do no spill maintenance
  at all.
- Pinned by `audit_clear_range_over_spill_region_panics`:
  `A1 = =SEQUENCE(3)`, then `clear_range(A1:A3)` → panic. User-visible:
  select-and-Delete over any dynamic array aborts the WASM instance.
- Fix sketch: in `BulkLoader::set_cell` / `set_formula_lazy`, mirror
  the eager path's two checks (tear down the spill when the address is
  an anchor; skip-or-collect-error when it is a non-anchor target), and
  run `recompute_array_formulas_in(dirty)` at the end of `flush`.

#### A-5 · P-D · **P1** — structural edits do not relocate `spill_targets` — **FIXED**

- **FIXED** (W1.1, `1414f1b`): the fix sketch's SECOND option landed —
  all four structural ops (`insert_row` / `delete_row` / `insert_col` /
  `delete_col`) call `teardown_all_spills()` right after
  `hydrate_all_lazy_formulas` (snapshots anchor addresses, clears every
  derived target atom) and `rederive_spill_anchors()` after
  `retarget_formula_refs` (runs `recompute_array_formula` at each
  shifted anchor; anchors in the deleted band map to the `REF_INVALID`
  sentinel and are skipped). Spills always re-flow contiguously from
  the shifted anchor — Excel's recompute-after-structural-edit
  contract. O(active spills) extra per edit, negligible next to the
  A-1 hydrate+retarget cost (benches unchanged). Pin flipped to
  `audit_insert_row_relocates_spill_targets`; insert/delete row/col
  matrix in `tests/spill_structural.rs`.
- `sheet.rs:3809-3891` — `relocate_cells` moves `cells`,
  `formula_cells/exprs/texts`, `formula_source`, `needs_parse`,
  `formats`, `range_formats`… but NOT `spill_targets`, whose values are
  target **addresses**. After `insert_row(0,1)` above a `=SEQUENCE(3)`
  spill (now at A2:A4): (a) writing the real bottom target A4 misses
  the `spilled_into_anchor` guard and **panics** in `store.set`
  (read-only derived atom); (b) overwriting the new anchor A2 — a legal
  array-replace — is wrongly rejected `SpillCellWrite { anchor: A2 }`
  because the stale list still names A2 a target.
- Pinned by `audit_insert_row_does_not_relocate_spill_targets`.
- Fix sketch: shift `spill_targets` values through the same `f(addr)`
  inside `relocate_cells` (drop entries mapped to the `REF_INVALID`
  sentinel), or simpler: tear down all spills before the edit and let
  `recompute_array_formulas_in` re-install them inside
  `with_structural_edit`.

#### A-6 · P-C · **P1** — `remove_sheet` permanently kills ALL cross-sheet dirty/notify fanout — **FIXED**

- **FIXED** (W1.2, `08c1d86`): `remove_sheet`
  now calls `rebuild_cross_sheet_deps()` after the removal + name-lookup
  rebuild (the fix sketch's first option), and additionally dirties +
  notifies every surviving formula that REFERENCED the removed sheet
  (their value becomes `#REF!`-class), with chained dependents reached
  through the shared `run_cross_sheet_dirty_bfs`. Pin flipped; matrix
  in `tests/cross_sheet_propagation.rs`. O(formulas + lazy parse) per
  removal accepted for a rare structural op (inherits A-2's missing
  `!`-prefilter, tracked there).
- `workbook.rs:1521-1538` — `remove_sheet` replaces the whole
  `CrossSheetDeps` with an empty graph. The comment claims "the next
  workbook-routed `set_formula` call will repopulate edges from the
  live formulas", but `set_formula` only adds edges for the formula
  being set (`:996`) and `rebuild_cross_sheet_deps` is only ever called
  by `move_sheet` (`:846`). Removing an UNRELATED sheet therefore
  silently severs every existing cross-sheet formula's dirty + notify
  fanout; reads stay correct only via the `has_any_cross_sheet_edges`
  force-recompute latch, so a reactive host shows stale values until
  some unrelated event repaints.
- Pinned by `audit_remove_unrelated_sheet_kills_cross_sheet_notify`:
  subscriber on `Sheet1!B1 = =Data!A1*2` fires before, never after,
  removing a third `Scratch` sheet, while `get_cell` still reads 4.
- Fix sketch: call `rebuild_cross_sheet_deps()` at the end of
  `remove_sheet` (the rebuild already exists and handles index remap) —
  O(all formulas) is acceptable for sheet removal, though it inherits
  A-2's missing `!`-prefilter; or rewrite `(idx, addr)` keys in place.

#### A-7 · P-C · **P2** — `rename_sheet` changes dependent values with zero propagation — **FIXED**

- **FIXED** (W1.2, `08c1d86`): the "alternative minimal fix"
  landed — names stay stale in ASTs/texts (Excel-style reference
  rewrite remains a follow-up), but `rename_sheet` now rebuilds the
  cross-sheet graph against the new name → index map and dirties +
  notifies BOTH groups whose resolution changed: formulas referencing
  the old name (now broken) and formulas referencing the new name
  (previously dangling, now live). Pin flipped; matrix in
  `tests/cross_sheet_propagation.rs`.
- `workbook.rs:768-783` — `rename_sheet` updates `names` / `by_name`
  and stops. Formula ASTs/texts store sheet NAMES (`Expr::SheetRef {
  sheet, .. }`), so `=Data!A1*2` keeps saying `Data` after the rename:
  the dependent's value silently changes (10 → unresolved) with no
  dirty-mark and no subscriber fire; and if a NEW sheet later takes the
  old name, every stale formula silently rebinds to it. Excel rewrites
  references on rename.
- Pinned by `audit_rename_sheet_dependents_not_retargeted_or_notified`.
- Fix sketch: walk `cross_sheet.formula_refs` (already a forward index,
  O(cross-sheet formulas) not O(all formulas)) and rewrite
  `SheetRef`/`SheetRange` names in AST + `formula_texts` (+ parked
  `formula_source` via a text rewrite), then mark-dirty + fire each
  rewritten formula. Alternative minimal fix: keep names stale but at
  least dirty + notify the formulas that referenced the renamed sheet.

#### A-8 · P-A · **P3** — `spilled_into_anchor` linear scans on every single-cell write

- `sheet.rs:1602-1618` — every `try_set_cell` / `try_set_formula`
  (`:2188/:2331`) scans ALL spill target lists; on a hit it
  reverse-scans the ENTIRE `cells` map to find the anchor address.
  Harmless with a handful of small spills (the Phase 1 assumption,
  documented), but one `=SEQUENCE(100000)` makes every keystroke
  O(100k) compares, and any write inside it O(total cells). Theoretical
  until large spills are common; no repro pinned.
- Fix sketch: maintain the reverse index `target_addr → anchor_addr`
  alongside `spill_targets` (same insert/remove sites).

#### A-9 · P-B · **P3** — `clear_range` round-trips every address through strings

- `sheet.rs:3369-3373` / `workbook.rs:1238-1244` — the sparse scan
  yields typed `CellAddress`es, which are `to_string()`-ed only to be
  re-`parse`d inside `BulkLoader::set_cell` / `loader.clear_cell`. One
  alloc + parse per cleared cell in a bulk path. Dwarfed by A-3 on the
  same call; fold the fix together (add a typed-address loader entry
  point).

### Cleared paths

- **Single-cell mutators** (`Sheet::try_set_cell` `:2186`,
  `try_set_formula` `:2325`, `write_error`, `clear_cell`): work is
  change-proportional — `mark_dependents_dirty` BFS over actual
  dependents, eager array recompute gated by `expr_may_produce_array`
  + prior-anchor check. No P-A (modulo A-8's scan). Spill teardown on
  overwrite is present and ordered correctly.
- **`remove_formula_record`** (`:1113`): post-codex it drains all seven
  tables (`formula_source`, `needs_parse`, `formula_cells`, point deps,
  range deps, `formula_exprs`, `formula_texts`). No P-D found.
- **`drop_cells_in`** (`:3758`): post-codex it unions all three key
  spaces (primitives, hydrated, lazy) before dropping; formats swept in
  the same pass. Clean.
- **`bulk_install_storage`** (`:1348-1438`): teardown covers cells,
  all five formula tables, both dep indexes, `spill_targets` (targets
  destroyed before anchors), and detach/reattach+notify of every
  subscription. The only deliberate survivors are style state
  (`formats` / `range_formats` / row heights / conditional rules) —
  a content-vs-style contract choice, not a leak. Clean for P-D.
- **`BulkLoader::flush`** (`:4346`): O(touched + dirty closure) with
  scratch-amortized candidate buffers; notify deduped per address.
  Clean for P-A/P-B (its gap is spill maintenance — see A-4).
- **`batch_set` / `with_structural_edit` subscriber diffing**
  (`:3956` / `:3737`): pre/post snapshots are O(subscription count)
  (bounded by viewport), not sheet size. The per-address `peek_value`
  can evaluate a formula chain, but only for subscribed addresses.
- **`shift.rs`** (whole file): pure per-AST transforms; no whole-sheet
  iteration lives here. The render path allocates per node
  (`format!`), but the real cost is the caller applying it to every
  formula (A-1), not the helpers.
- **Sort / fill / copy-range engine paths**: none exist in
  `excel-core` (no `fn sort` / `fn fill` / `copy_range`); `shift_refs`
  is a helper for host-side paste, and `undo.rs` is a passive snapshot
  stack whose replay goes through the audited mutators. Nothing to
  audit.

### Severity tally

| severity | count | findings |
|---|---|---|
| P1 | 4 | A-1 (insert_row O(all formulas)) **FIXED**, A-4 (clear_range panic) **FIXED**, A-5 (spill_targets not relocated) **FIXED**, A-6 (remove_sheet kills fanout) **FIXED** |
| P2 | 3 | A-2 (move_sheet full parse) **FIXED**, A-3 (1-cell clear O(sheet)) **FIXED**, A-7 (rename_sheet silent) **FIXED** |
| P3 | 2 | A-8 (open), A-9 (folded into A-3's fix — typed loader entry landed; the workbook loader's string addresses remain) |

Headline (all resolved as of W2.1 `0ca3a16`): one `insert_row` on a
500k-formula sheet WAS **2.09 s** native and left the sheet eager
forever — now **127 ms** with the dep graph untouched; `clear_range`
over a spill no longer panics (W1.1); removing an unrelated sheet no
longer silences cross-sheet notify (W1.2). Section A's only open item
is A-8 (spilled_into_anchor linear scan, theoretical until large
spills are common).

## C — TS port (vanilla/excel-core-ts + core store)

Audit date 2026-06-12. Read-only at audit time; measurement pins live
in `vanilla/excel-core-ts/test/audit-mutation-scaling.test.ts`
(console timings; after the W2.2 fix the C-1/C-2/C-6 pins were flipped
to assert the fixed behavior with generous 50-1000× margins). Apple
Silicon, Node via jest, `npx jest vanilla/excel-core-ts --no-coverage`
green (31 suites / 1811 tests) with the pins included.

### Findings

#### C-1 · P-A · **P1** — whole-Map clone per single-cell edit — **FIXED**

- **FIXED** (W2.2, `d98409c`): storage-primary mutate-in-place — each
  sheet owns ONE live Map for its lifetime (`sheet.ts` `liveCells`);
  mutators write into it directly and `postWrite`
  (`src/propagation.ts`) propagates. The change signal moved off the
  Map identity onto (a) per-formula epoch atoms (C-2) and (b) a new
  per-sheet `revisionAtom` bumped once per mutation batch (the
  subscription point the clone identity used to be). Re-measured with
  the flipped pin: median `setCell` = **~0.005–0.013 ms at 10k / 100k /
  1M cells** (was 0.45 / 4.9 / **107.6 ms** — linear); bulk import
  unchanged (1M `bulkApply` ≈ 570–715 ms, consistent with the 785 ms
  reference). Every consumer of the old identity signal is accounted
  for in the RFC's consumer-of-identity table
  (`vanilla/excel-core-ts/docs/KEY_GRANULAR_INVALIDATION.md`).
- `vanilla/excel-core-ts/src/sheet.ts:272` — `applyCell` does
  `new Map(prev)` unconditionally; every single-cell mutator routes
  through it (`workbook.ts:387` setCell, `:410` setCellValue, `:453`
  clearCell) and `setFormat` clones inline (`workbook.ts:486`).
- Measured (median of 5 edits after bulk-load):

  | sheet size | bulkApply load | one `setCell` |
  |---|---|---|
  | 10k cells | 3.4 ms | **0.45 ms** |
  | 100k cells | 39 ms | **4.9 ms** |
  | 1M cells | 506 ms | **107.6 ms** |

  Perfectly linear in TOTAL sheet size — the exact mirror of the Rust
  eager-build regression. One keystroke on a 1M-cell sheet costs ~14% of
  a full 1M bulk import.
- Fix sketch: keep the atom contract (new identity per write) but stop
  paying O(N) for it — wrap the store value as `{ rev, cells }` where
  `cells` is shared and `rev` bumps, or adopt a persistent/chunked map
  (row-block pages, clone only the touched page).

#### C-2 · P-A · **P1** — store flush re-derives EVERY cached formula on any write — **FIXED**

- **FIXED** (W2.2, `d98409c`): the fix sketch's second option landed —
  sub-key dependency granularity, vanilla/core untouched. Formula
  derives no longer `get(sheetAtom)`; each cached formula's only core
  dep is a per-key epoch atom. The workbook owns a `DepGraph`
  (`src/deps.ts`): point index + column-bucketed range index (mirrors
  Rust `cell_dependents` / `RangeDependentIndex` incl. the wide-range
  fallback) + a broad set for INDIRECT/OFFSET/dynamic-range/volatile
  formulas. Deps install lazily as the evaluator visits formulas
  (`EvalContext.onFormulaEvaluated`, anchors AND transitive trampoline
  visits — the hydrate-on-read mirror), resolving names through the
  registry (B-4 twin). `postWrite` BFSes dependents-of-written-keys and
  bumps exactly those epochs (eager re-derive preserved → probe
  semantics unchanged). Flipped pins: one unrelated `setCell` @100k
  cached formulas = **~0.005 ms / 0 re-evals** (was **503 ms /
  100 000**); a new pin asserts re-eval count == TRUE dependent count
  (100 of 10 000 cached). Registry-driven invalidation (defineName etc.)
  stays explicitly broad by contract (C-3). NOTE: the first setter after
  a host-read burst additionally drains core's pending-read bookkeeping
  once (~1 ms/1k reads, amortized O(1) per read; pre-existing core
  behavior, logged separately by the pin).
- `vanilla/core/src/store.ts:222-239` (`dependenciesChange`) +
  `:241-253` (`flushPending`): a sheetAtom bump walks
  `backDependenciesMap.get(sheetAtom)` — i.e. every formula derive ever
  read — and calls `readAtom` on each, which is a FULL formula
  re-evaluation (the dep is the whole-Map identity, so the `noChange`
  short-circuit at `store.ts:53` never helps). This is the known
  "eager re-derive at mutation" engine difference documented at
  `workbook.ts:313-340`; now quantified:

  | formulas previously read | one unrelated `setCell` | re-evals fired |
  |---|---|---|
  | 1k | 5.3 ms | 1,000 |
  | 10k | 43 ms | 10,000 |
  | 100k | **503 ms** | 100,000 |

  Re-eval count equals cached-formula count exactly (verified via
  `debugFormulaEvalCount`). 100k read formulas ⇒ every keystroke costs
  half a second, synchronously, inside `store.setter`.
- Fix sketch: mark-dirty-only propagation (invalidate the cached dep
  snapshot, recompute on next read — what the Rust engine already does),
  or sub-key dependency granularity so a cell edit only dirties true
  dependents.

#### C-3 · P-A · **P2** — name/custom-formula/locale registration outside `withBatch` clones every sheet

- `vanilla/excel-core-ts/src/workbook.ts:342-349`
  (`recalculateAllSheets`) called by `defineName` (`:525`),
  `undefineName` (`:529`), `registerCustomFormula` (`:534`),
  `unregisterCustomFormula` (`:538`), `setLocale` (`:514`), `recalc`
  (`:508`) — each clones EVERY sheet's full Map and triggers the C-2
  flush per sheet.
- Measured on 3 sheets × 100k cells: one `defineName` = **15–21 ms**;
  50 names inside `withBatch` = **15–21 ms** (coalesces correctly); 50
  names outside = **797–813 ms** (~50×). `setLocale` = 14–18 ms,
  `recalc()` = 15–17 ms at this size (scales with C-1).
- Fix sketch: auto-batch registrations within a microtask, and/or
  invalidate only formulas that reference names (needs a lazy
  name→dependents index, same shape as the Rust cross-sheet edge fix).

#### C-4 · P-B · **P2** — per-cell `clearCell` loops in worker bulk paths

- `solid/excel/src-vnext/adapter/worker-runtime-ts.ts` `clearRange`
  (~line 693) and the `importCells` clears loop (~line 805) call
  `workbook.clearCell` once per cell; each call is a full Map clone
  (C-1) plus a full flush (C-2).
- Measured: 100 `clearCell` calls on a 100k-cell sheet = **513–525 ms
  total (5.1–5.3 ms/cell)**. A 100×100 `clearRange` at this sheet size
  extrapolates to ~51 s.
- Fix sketch: add a `bulkClear(sheetId, keys|range)` to the workbook
  (one clone, N deletes, ONE atom write) and route both worker paths
  through it — exactly what `bulkApply` already does for writes. Note
  the `importCells` comment ("no batch primitive exists") names the gap.

#### C-5 · P-C · **P2** — `withBatch` throw path drops invalidation but keeps the mutation — **FIXED** (`a62927d`)

- WAS: `vanilla/excel-core-ts/src/workbook.ts` `withBatch` catch: on
  throw, the outermost frame cleared `pendingRecalc` WITHOUT firing it —
  but the registry mutations that already ran (`names.set`,
  `customFormulas.set/delete`, `currentLocale = ...`) were not rolled
  back. Result: registry and cached derives disagreed until any
  unrelated mutation healed them.
- Pinned repro (was, in the audit test file): `=MYNAME` reads `#NAME?`;
  `withBatch(() => { defineName('MYNAME', 99); throw })`; post-throw
  read still `#NAME?` while the registry holds `MYNAME=99`; an
  unrelated `setCell` then flips the same cached atom to `99`.
- FIX (W1.4, commit `a62927d`): rollback — the outermost `withBatch`
  entry snapshots `names` / `customFormulas` (shallow `new Map`, small
  bounded registries) plus `currentLocale`; the outermost throw restores
  all three before clearing `pendingRecalc` and re-throwing. Nested
  batches snapshot only at depth 0→1, so an inner throw that unwinds
  through the outer frame aborts the WHOLE batch. Success path
  unchanged. Sweep confirmed `setLocale` is the only other
  `requestRecalc`-deferred mutator, hence locale joins the snapshot set;
  all five cell mutators uniformly route `writeSheetState` and stay
  outside batch semantics. Behavioral tests in
  `vanilla/excel-core-ts/test/workbook.test.ts` (withBatch describe);
  the audit pin now asserts the consistent post-fix behavior.

#### C-6 · P-D · **P2** — formula derive atoms are never torn down — **FIXED**

- **FIXED** (W2.2, `d98409c`): `postWrite` step 1/5 — when a write
  removes a formula (formula → literal/blank/deleted, detected by AST
  identity change), the DepGraph edges are uninstalled
  (`remove_formula_record` twin) and, after one final epoch bump
  publishes the literal to listeners, the derive + epoch atoms are
  evicted from the sheet caches (`_internal.evict`). No core
  `store.evict` needed: the atom's only dep was its own dropped epoch
  atom, so all store-side state sits in WeakMaps keyed by the dropped
  objects and is GC-reclaimable. Flipped pin: after 10k formulas are
  read then overwritten to literals, median `setCell` = **~0.002 ms ≈
  never-formula baseline** (was 16–17 ms vs 0.4 ms, ~40× permanent
  drag), and `formulaCellAtom(key)` provably returns a fresh atom.
- **codex P1 follow-up** (post-`d98409c`, two findings, both fixed):
  (1) eviction orphaned atoms a host already held — later writes to the
  same address no longer bumped them (`=1` → `2` → `3` kept reading
  `2`). Fix: `_internal.evict` retains the EPOCH atom in the key→epoch
  map (only the heavy derive + probe stamps drop); `formulaCellAtom`
  reuses a surviving epoch so old and fresh derives share the bump
  target, and `cachedFormulaKeys()` (registry recalc breadth) iterates
  epoch keys. The former RFC caveat ("re-subscribe after overwrite") is
  REMOVED — held atoms stay wired. C-6 pin re-verified ≈ baseline
  (epochs are bumped per-key; unrelated writes never touch them).
  (2) formulas whose value was cached by trampoline CYCLE detection
  (`#CIRCULAR!` stamped from a child's `refLookup`) were popped via the
  cache-hit branch and never reached `onFormulaEvaluated`, so cycle
  members had no reverse edges — breaking `A1=B1, B1=A1` never
  re-derived the held member. Fix: the cache-hit pop fires the hook for
  AST-bearing cells (O(1) repeats via `isCurrent`). Pins:
  `vanilla/excel-core-ts/test/key-granular-regressions.test.ts`
  (held-atom overwrite chain, mutual/3-cell/self/range-aggregate
  cycles).
- `vanilla/excel-core-ts/src/sheet.ts:137` `formulaAtomCache` and
  `:153` `lastEvalRevision` grow monotonically and have no eviction;
  `vanilla/core` has no per-atom destroy/evict API (only whole-store
  `clear()`), so once a formula cell is read, its derive atom sits in
  `backDependenciesMap.get(sheetAtom)` FOREVER — even after the cell is
  deleted or overwritten by a literal. Every later write re-walks and
  re-derives all of them (compounds C-2), and the atoms + revision
  stamps are unreclaimable memory.
- Measured: 10k formulas read then overwritten to plain literals →
  median `setCell` stays at **16–17 ms vs 0.4 ms** for a never-formula
  sheet of identical size (**~40× permanent overhead**; the orphaned
  derives now compute nothing, the cost is pure walk + blank re-derive).
- Fix sketch: when a derive observes its cell no longer has an AST,
  evict it — `formulaAtomCache.delete(key)`, `lastEvalRevision.delete`,
  and a new `store.evict(atom)` in vanilla/core that runs
  `clearDependencies` + drops `atomStateMap`/`listenersMap` entries.

#### C-7 · P-D · **P3** — `store.clear()` misses `pendingMap`

- `vanilla/core/src/store.ts:277-282`: `clear()` replaces the four
  WeakMaps but `pendingMap` (`:23`, a regular `Map`) is untouched. A
  `clear()` issued while entries are pending leaks stale atoms into the
  next `flushPending`, which will run `dependenciesChange`/`publishAtom`
  against the fresh (empty) state. Low severity — requires clear()
  mid-mutation — but it is the same "parallel table missed by teardown"
  shape codex flagged in Rust.
- Fix sketch: `pendingMap.clear()` inside `clear()`.

#### C-8 · wire-type caveat · **P2 (parked, re-verified unchanged)**

- `solid/excel/src-vnext/adapter/worker-runtime-ts.ts` `importCells`
  (~line 716) routes text wires through `bulkApply` input strings →
  `parseLiteral` re-classifies: text `'00123'` becomes
  `{kind:'number', value:123}` (leading zeros lost). `setCellValue`
  (`workbook.ts:406`) preserves typed values but the bulk fast path
  does not use it (documented as intentional at ~line 723). Pinned in
  the audit test. Status unchanged from the handoff; fix would be a
  typed-value variant of `bulkApply` (`BulkCellInput | {value: Value}`).

### Cleared paths

- **`bulkApply`** (`workbook.ts:471-482`): genuinely storage-primary —
  one clone, N inline sets, ONE atom write, one flush. No P-B. (1M-cell
  load = 506 ms, consistent with the 785 ms reference.)
- **Spill teardown**: N/A by design in the TS port — no per-target spill
  atoms exist; spill targets are resolved at read time by anchor
  projection in `worker-runtime-ts.ts` (bounded up-left anchor scan,
  ~line 267). The Rust spill-target P-D class has no TS counterpart.
- **Cell-mutator propagation**: `setCell` / `setCellValue` / `clearCell`
  / `bulkApply` / `setFormat` all route `writeSheetState`
  (`workbook.ts:313`) — revision bump + atom set, uniform invalidation.
  No P-C among them.
- **`withBatch` success path**: covers all four registration mutators +
  `setLocale`; measured 50-op coalescing works (~50× saving).
- **No quadratic flush recursion**: formula derives have no
  inter-formula back-deps (evaluation walks the snapshot Map directly),
  so `dependenciesChange` recursion stays one level deep.

### Severity tally

| severity | count | findings |
|---|---|---|
| P1 | 2 | C-1 (clone/edit) **FIXED**, C-2 (flush fan-out) **FIXED** |
| P2 | 5 | C-3 (open, deliberate-broad documented), C-4 (open), C-5 **FIXED**, C-6 **FIXED**, C-8 (parked) |
| P3 | 1 | C-7 (open) |

Headline (P1s + C-6 resolved as of W2.2 `d98409c`): a keystroke on a
1M-cell sheet WAS **~108 ms** of Map clone (C-1) plus, with 100k read
formulas, **~503 ms** of synchronous re-evaluation (C-2), composing to
~610 ms — now **~0.005 ms with zero spurious re-derives** (re-eval
count == true dependent count, pinned), and overwritten formulas no
longer leave drag (C-6). The TS port now matches the Rust engine at
mutation time too: storage primary, per-cell reverse deps hydrated on
read, dirty O(dependents). Remaining open items: C-3 (registry breadth,
documented contract), C-4 (worker bulk-clear primitive — each per-cell
clear is now cheap, but the loop shape remains), C-7, C-8.

## D — UI core + worker adapters

Audit date 2026-06-12. Read-only; measurement/repro pins live in
`solid/excel/test/audit-adapter-scaling.test.ts` (loose assertions,
console timings — not perf gates; bug pins assert CURRENT buggy behavior
and say so inline). `npx jest vanilla/spreadsheet-ui-core solid/excel
--no-coverage` green with the pins included (111 suites / 1636 tests).

Territory: `vanilla/spreadsheet-ui-core/src` (atoms, ports) and
`solid/excel/src-vnext/adapter` (static backend, worker backends, TS/WASM
worker runtimes, protocol client).

### Findings

#### D-1 · P-A · **P1** — TS worker runtime `clearRange` iterates the dense rectangle

- `solid/excel/src-vnext/adapter/worker-runtime-ts.ts:692-704` — nested
  `for row / for col` over the FULL request rectangle, one
  `workbook.clearCell` engine call per coordinate, regardless of whether
  a cell exists. Returns `cleared === area` on an empty sheet.
- Reachable at catastrophic scale: a column-header selection produces
  `rowEnd = EXCEL_MAX_ROWS - 1 = 1_048_575`
  (`vanilla/spreadsheet-ui-core/src/selection/index.ts:140-146`), and
  `worker-workbook-backend.ts:1179-1206 clearRange` forwards the range
  verbatim. Delete on a selected column under the TS backend ⇒ ~1M engine
  calls; each `clearCell` also pays the C-1 whole-Map clone, so cost is
  O(area × existing cells).
- Measured: 200×50 empty-sheet clear = 10 000 engine calls, **11.4 ms**
  ⇒ ≳1.2 s minimum for one column on an EMPTY sheet, far worse populated.
- Fix sketch: walk the sheet's sparse cell map filtered by bounds (the
  exact pattern `snapshotRangeSparse` uses three functions up), one
  read-invalidation at the end. WASM runtime is immune — it delegates to
  the engine's `clear_range`.

#### D-2 · P-A · **P2** — static backend deep-clones the whole workbook per undoable mutation

- `solid/excel/src-vnext/adapter/static-backend.ts:274-333` —
  `beginUndoableMutation` → `takeStateSnapshot` clones every cell of
  EVERY sheet (plus all format/merge/dimension tables). Callers include
  per-keystroke `setCellInput` (:1720) and per-drag-step
  `setRowHeight`/`setColumnWidth` (:2171, :2185).
- Measured: 20 single-cell edits — **0.5 ms** on a 50-cell book vs
  **57.3 ms** on a 20k-cell book (**108×**, ≈2.9 ms/keystroke at 20k
  cells; extrapolates to ~145 ms/keystroke at 1M cells).
- `STATIC_BACKEND_UNDO_CAP = 200` (:272) ⇒ steady-state memory is
  200 × workbook. Side note: UI-core history cap is 100
  (`history/index.ts:6`) — the backend retains 100 snapshots the UI can
  never undo into.
- Fix sketch: inverse deltas per mutation kind (the history entry kinds
  already enumerate them) or copy-on-write per-sheet maps.

#### D-3 · P-A · **P2** — static backend `applyValidationRule` materializes blank cells across the whole rule range

- `static-backend.ts:870-889` — dense `for row / for col` with
  `upsertBlankCell` per coordinate. A full-column rule (1_048_576 rows
  via the same selection bounds as D-1) creates ~1M cell entries; every
  later snapshot/undo-clone (D-2) then pays for them forever.
- The worker backend already has the correct shape: store rule layers,
  overlay lazily inside the requested window only
  (`worker-workbook-backend.ts:362-410`).
- Fix sketch: port the layer representation back into the static state.

#### D-4 · P-D · **P2** — worker backend `deleteSheet` leaves per-sheet host overlays; sheet ids are reused

- `worker-workbook-backend.ts:1463-1488` — `deleteSheet` removes the
  worker sheet + refreshes the lookup but never touches
  `validationRulesBySheetId`, `conditionalFormatRulesBySheetId`,
  `filterSortBySheetId` (:775-777) or sheet-scoped `namedRanges`.
- Not just a leak: `syncSheetLookup` (:203-232) re-issues
  `sheet-${idx+1}` ids, so the next added sheet REUSES the deleted id and
  inherits its validation/conditional-format/filter state. Pinned:
  delete `sheet-2` → add sheet → new `sheet-2` projects the dead sheet's
  validation overlay (audit test D-4).
- Static backend counterpart is almost complete (`static-backend.ts:
  2474-2507` clears seven tables) but misses `filterSortBySheetId`.
- Fix sketch: a `dropSheetState(sheetId)` helper called from deleteSheet
  in both backends; prune sheet-scoped named ranges like the static
  backend does.

#### D-5 · P-D · **P2** — TS runtime sheet lifecycle leaves sheet-INDEX-keyed state behind

- `worker-runtime-ts.ts:1292-1338` — `addSheet` / `renameSheet` /
  `removeSheet` / `moveSheet` rebuild the workbook but never touch:
  - `readFormulaCells` (:147, keys `${sheetIdx}:r:c`) — after
    removeSheet/moveSheet shifts indices, `debugFormulaCacheState`
    reports **'clean' for a never-read formula** on the sheet that
    shifted into the stale slot (pinned, audit test D-5); entries for
    removed sheets also accumulate forever.
  - `snapshotSessions` (:132) — in-flight chunked snapshots keep reading
    the shifted index ⇒ wrong sheet's rows in later chunks.
  - `importSessions` (:130) — staged `ImportCellWire.sheet` indices land
    on the wrong sheet if a sheet op happens between begin and commit.
- Contrast: `initWorkbook` (:1275-1288) and `restorePersistenceV1`
  (:1561-1594) reset all of these (restore misses `nextImportSessionId`
  — cosmetic only).
- Fix sketch: clear all three tables (or reindex `readFormulaCells`) in
  `rebuildPreservingCells`; reject commits whose session predates a
  structural sheet op (sessions already carry ids — add a workbook
  generation counter).

#### D-6 · P-D · **P3** — WASM runtime sheet ops vs sessions/subscriptions

- `worker-runtime.ts:1164-1180` — addSheet/renameSheet/removeSheet/
  moveSheet don't invalidate `importSessions`/`exportSessions`/
  `snapshotSessions` (:211-213, all sheet-idx-keyed) nor
  `subscriptionTokens` (:210; the dirty callback captures `ref.sheet` at
  :963, so post-removal dirty events report the OLD index).
  Same family as D-5; P3 because `subscribeCells` has no production
  consumer yet and sessions are short-lived.

#### D-7 · P-A · **P2** — filter/sort active ⇒ every viewport refresh reads the whole sheet

- `worker-workbook-backend.ts:878-887` — when `filterSortHasEffect`,
  `readRange` widens EVERY visible-window read to rows
  `0..1_048_575` (`EXCEL_MAX_SHEET_ROW`, :141) for BOTH
  `readSparseRange` and `snapshotFormatRange`, then
  `buildFilterSortDisplayRows` (:305-323) scans all returned cells and
  rebuilds the full row permutation — per scroll tick, per edit refresh.
  Pinned: plain read endRow=20 vs filter-active endRow=**1 048 575**
  (audit test D-7).
- Reading wide once per MUTATION is legitimate (rows must reposition into
  the window); doing it per READ is the P-A part.
- Fix sketch: cache `displayRows` keyed by (sheetId, revision,
  filterSort state); reads then fetch only the source rows that project
  into the window.

#### D-8 · P-A · **P2** — TS runtime range readers walk the entire sheet map per projection read

- `worker-runtime-ts.ts:600-631` (`snapshotRangeSparse`) and `:633-674`
  (`readSparseRange`) iterate ALL cells of the sheet and filter by
  bounds; `collectSpillTargets` (:547-598) is a second full pass. Every
  visible-window read is O(total cells), not O(window) — and D-7 composes
  on top of it for the TS backend. WASM delegates to engine-side range
  queries (`worker-runtime.ts:1579-1640`).
- Fix sketch: row-bucketed index on the TS side, or push range queries
  into `@einfach/excel-core-ts` (it owns the map already).

#### D-9 · P-A · **P3** — `invalidateReadOnMutation` scans the whole host-read set per write

- `worker-runtime-ts.ts:417-428` — every single-cell write iterates ALL
  `readFormulaCells` entries (all sheets) doing string `startsWith`.
  O(host-read formulas) per keystroke. Fix: `Map<sheetIdx, Set>` so the
  per-sheet wipe is one `Map.delete`.

#### D-10 · P-B · **P2** — `removeRows` loops one `deleteRows` RPC per row

- `worker-workbook-backend.ts:1246-1343` — N duplicate rows ⇒ N
  descending single-row `deleteRows` RPCs, each a full worker round-trip
  + engine band-shift; partial-failure is handled but non-atomic.
  Already documented in-code (TODO einfach-excel-core#batch-delete-rows,
  :1220-1245) — recorded here so the batch primitive lands with the
  engine arc.

#### D-11 · P-A · **P3** — conditional-format overlay re-sorts the rule list per cell

- `worker-workbook-backend.ts:429-443` — `getConditionalFormatForCell`
  does `[...rules].sort(...)` and it's invoked per projected cell from
  `applyConditionalFormatOverlay` (:445-462). O(window × rules·log rules)
  per read. Fix: hoist the sort (and range pre-filter) out of the cell
  loop.

#### D-12 · correctness note · **P3** — replace-all only mutates the current 500-match page

- `solid/excel/src-vnext/find-replace/SpreadsheetFindReplaceDialog.tsx:
  186-211` — `handleReplaceAll` sends `cursor.pageMatches` (capped at
  `MAX_FIND_PAGE = 500`) in ONE `replaceMatches` call (good — no P-B),
  but silently leaves matches 501..totalCount untouched even though
  `totalCount` is displayed to the user. Needs a loop-until-empty or an
  explicit "replaced 500 of N" surface. Off-family but adjacent.

#### D-13 · P-A · **P3** — TS runtime rebuilds the whole workbook per sheet op

- `worker-runtime-ts.ts:1670-1714` — `rebuildPreservingCells` re-seeds a
  fresh workbook and `bulkApply`s every surviving sheet's cells on every
  addSheet/renameSheet/removeSheet/moveSheet. Documented in-code as a
  TS-core limitation (no live structural mutations yet); recorded so the
  engine gap is tracked. Adding an empty sheet to a 1M-cell book costs a
  full reload.

### Cleared paths (checked, no finding)

- **Bulk import**: chunked + batched end to end — backend streams
  ≤10k-cell chunks (`worker-workbook-backend.ts:983-1019`); TS runtime
  buffers chunks and lands ONE `bulkApply` per sheet at commit
  (`worker-runtime-ts.ts:1394-1422`); WASM atomic sessions stage into one
  `bulk_install_workbook` (`worker-runtime.ts:869-879`). One dirty event
  per commit, not per chunk (`isMutatingCommand` includes `commitImport`,
  excludes `importChunk`).
- **Paste / fill / clear / format / text-to-columns / remove-duplicates
  dialogs**: each apply path is a single backend port call
  (`pasteRange` / `fillRange` / `clearRange` / `setFormatRange` /
  `importCellChunks` / `removeRows`) — no per-cell RPC loops in UI core
  or the Solid layer (modulo D-10 inside the backend).
- **UI-core history**: entries are small descriptors
  (kind + range + revision, `history/types.ts:20-26`), cap 100, no state
  copies. The state-copy problem is the static BACKEND's stack (D-2).
- **Find-replace atoms**: page capped at 500 (`find-replace/index.ts:7`,
  `:60`); replace-all batches through one `replaceMatches` (D-12 caveat).
- **Atom hygiene**: no per-cell/per-row atom families anywhere in
  `spreadsheet-ui-core`; the only Map-valued source atom is the
  custom-formula registry (host-bounded).
- **Worker resets**: WASM `initWorkbook` (`worker-runtime.ts:325-340`)
  and `restorePersistenceV1` (:1598-1612) clear subscriptions + all three
  session tables (+ customFormulas where the engine instance is
  replaced); TS `initWorkbook`/`restorePersistenceV1` reset every
  RuntimeState field except the cosmetic `nextImportSessionId` in
  restore. The teardown gaps are the sheet-LIFECYCLE paths (D-5/D-6),
  not the reset paths.
- **Protocol client**: `dispose` rejects pending, clears subscriber +
  listener tables, terminates (`worker-protocol.ts:686-696`); dirty
  fan-in is O(listeners + subscribers), all bounded.

Headline: one P1 (a column-clear on the TS backend dense-loops ~1M engine
calls), and the same teardown bug shipped twice (D-4/D-5: per-sheet state
keyed by reused ids / shifting indices outliving the sheet). The
adapters' bulk-import spine — the part the Rust arcs already disciplined —
is clean; the fan-out lives in the overlay/undo/clear edges the engine
never sees.

Severity count: **P1 ×1** (D-1) · **P2 ×6** (D-2, D-3, D-4, D-5, D-7,
D-8) · **P3 ×6** (D-6, D-9, D-10*, D-11, D-12, D-13) — *D-10 is P2 impact
but already tracked in-code; counted at P3 to avoid double-reporting.

## B — Restore / recalc / atoms (Rust)

Audit date 2026-06-12. Read-only; repros + benches live in
`rust/excel-core/tests/audit_restore_atoms_scaling.rs` (5 always-on
tests, timings printed with `--nocapture`; one pin holds a CONFIRMED
stale-value bug, B-4). Numbers: Apple Silicon, `cargo test --release`.
`cargo test --lib` green (1396) with the pins included.

### Findings

#### B-1 · P-B · **P1** — restores still ride the legacy per-cell loader

- `restore_sparse` / `restore_persistence_v1` route through
  `Workbook::bulk_load` + per-cell `WorkbookLoader` calls
  (`rust/wasm/src/lib.rs:3450` `restore_sparse_cells`), NOT the Phase 6
  `install_workbook_bulk`. Per formula the workbook loader pays the
  full pre-6.1 ceremony: eager `parse_formula` for EVERY formula — no
  `!`-prefilter (`workbook.rs:1876`); cross-sheet cycle BFS (`:1901`);
  per-cell edge teardown + reinstall (`:1924-1928`); a `WorkbookOp`
  carrying two `String` allocs (`:1931-1938`). The parsed AST is then
  **discarded** at flush (`sheet.rs:4142` `set_formula_pre_parsed`
  drops `_expr`, parks text), so hydration parses a SECOND time on
  first read. Plus a per-cell addr round-trip:
  `CellAddress → to_string_repr()` (`lib.rs:3458`) immediately
  re-parsed by the loader (`workbook.rs:1869`).
- The comments at `lib.rs:3003-3005` / `:3287-3290` claim the path
  "routes through the Phase 2/3 lazy bulk_load" — true only of the
  sheet layer; the workbook loader above it is still eager. Same
  "philosophical drift, one layer up" the storage-primary RFC killed
  for imports, surviving in the restore entries.
- Measured (`audit_restore_legacy_loader_vs_storage_primary_install`,
  50k primitives + 50k formulas, native release):

  | path | total | per cell |
  |---|---|---|
  | `install_workbook_bulk` | 25.0 ms | 0.25 µs |
  | legacy loader (restore shape) | 89.8 ms | 0.90 µs |

  3.6× native; the 6.x bench history puts the wasm32 multiplier far
  higher (4835 → 323 ms at 500k = 15×). A 1M-cell
  `restore_persistence_v1` today costs multi-second wasm time that
  `bulk_install_workbook` does in ~0.6 s.
- Fix sketch: group `payload.cells` per sheet into primitives/formulas
  maps and call `install_workbook_bulk`. `restore_persistence_v1`
  already builds a fresh `Workbook`, so full-sheet-replace semantics
  fit exactly. For `restore_sparse` (additive contract — see B-7)
  either keep the loader or build the additive install variant Phase
  6.4 deferred.

#### B-2 · P-A drift · **P2** — eager atom-per-primitive-cell

- Every primitive install allocates a core atom: `sheet.rs:1408`
  `store.create_atom(value)` + `cells.insert(addr, id)`; the value
  lives behind `Store::values: HashMap<AtomId, Value>`
  (`rust/core/src/store.rs:43`, `:194-198`). Reads pay a double lookup
  (addr → AtomId → value). The TS port keeps ONE sheetAtom per sheet;
  per-cell granularity only for lazily-created formula atoms.
- Actual consumers of per-primitive atoms: subscription fanout
  (buckets already wire lazily, only for subscribed addresses,
  `sheet.rs:683-686`) and spill-target derived atoms (need the anchor
  as an atom). For the overwhelming majority of cells the atom is pure
  indirection — nothing reads it except through the sheet maps.
- Measured (`audit_primitive_install_atom_alloc_share`, 200k
  primitives, native release): plain `HashMap<CellAddress, Value>`
  build 0.47 ms · `store.create_atom` loop alone 7.8 ms ·
  `install_sheet_bulk` full 34.5 ms. Atom alloc alone ≈ 23% of
  install; on that ratio ~130 ms of the 578 ms/1M install bench is
  atom allocation.
- Fix sketch: store `Value` directly in the sheet
  (`RowMajorMap<Value>`); allocate the atom lazily on first
  subscribe / spill-anchor registration — the same allocate-on-demand
  contract the subscription buckets already follow. Wide but
  mechanical (`ensure_cell` / `readable_atom` call sites).

#### B-3 · P-A · corroborates **A-1** — structural edit hydrates all parked formulas

Independently reproduced before section A landed; kept as a second pin
at a different N. `audit_structural_edit_hydrates_every_parked_formula`:
`insert_row(0,1)` on a 50k-parked-formula sheet = 180 ms
(3.6 µs/formula), `cell_dependents` keys 0 → 50k. Numbers are
consistent with A-1's 100k/500k curve. See A-1 for the full analysis
and fix sketch; no separate severity counted here.

#### B-4 · P-C · **P1** — named-LAMBDA cross-sheet refs bypass propagation (CONFIRMED stale value) — **FIXED**

- **FIXED** (W1.3, `08c1d86`), in BOTH halves:
  - Precise edges (beyond the cheapest sketch):
    `collect_cross_sheet_refs` now resolves `Expr::Name` and
    `Expr::FuncCall` targets through `named_values` and walks
    `Value::Lambda` bodies + captured bindings recursively, guarded by
    a visited-name set so mutually-recursive named lambdas terminate.
    `=READDATA()` registers a real `CrossSheetDeps` edge → dirty +
    notify fanout works.
  - Latch (the sketch itself): `define_name_value` walks the stored
    value with `expr_has_sheet_ref` (lambda body + captures) and arms
    a workbook-level one-way `named_values_cross_sheet` latch OR'd
    into `has_any_cross_sheet_edges`, covering raw-`Sheet::set_formula`
    installs the per-sheet latch cannot see.
  - Follow-through: `define_name_value` / `undefine_name` also run
    `rebuild_cross_sheet_deps` (TS-port parity — defineName recalcs
    all sheets), so formulas installed BEFORE the name was defined, or
    against a since-replaced binding, get correct edges too; and
    `install_sheet_bulk`'s `!`-prefilter is bypassed when the latch is
    armed so parked `=READDATA()` sources still contribute edges.
  - Pin `audit_named_lambda_cross_sheet_freshness` flipped to the
    fresh value; matrix in `tests/cross_sheet_propagation.rs`.
- A cell calling a named LAMBDA whose body reads another sheet is
  invisible to every cross-sheet tracking mechanism:
  `expr_has_sheet_ref` → `Expr::Name(_) => false` (`sheet.rs:4949`,
  and the `=FN()` call site parses with no `SheetRef` node, so the
  sheet latch never arms); `collect_cross_sheet_refs_into` →
  `Expr::Name(_) => {}` (`workbook.rs:2237`, no `CrossSheetDeps`
  edge); `define_name` (`workbook.rs:529`) stores the `Value::Lambda`
  without scanning its body.
- First eval resolves correctly through the provider and caches
  `Clean`; a later write to the referenced cell finds no edge, no
  latch, `force_formula_recompute() == false` → the cell serves the
  **stale** cached value indefinitely.
- CONFIRMED by `audit_named_lambda_cross_sheet_freshness` (assertion
  pins the bug): `READDATA = LAMBDA(Data!A1)`, `B1 = =READDATA()`
  reads 1.0; after `Data!A1 ← 2.0` via workbook-routed `set_cell`,
  B1 still reads **1.0**.
- Fix sketch (cheapest): in `define_name_value`, walk a stored
  `Value::Lambda` body with `expr_has_sheet_ref`; on hit arm a
  workbook-level one-way "named values hold cross-sheet refs" latch
  OR'd into `has_any_cross_sheet_edges` — O(1) per define, matches the
  existing latch philosophy. Precise per-cell edges are the bigger
  follow-up.

#### B-5 · P-B · **P3** — legacy flush notify is O(touched), not O(touched ∩ subscribed)

- `BulkLoader::flush` (`sheet.rs:4532-4551`): `attach_address_sub` per
  touched address, then `notify_targets = touched ∪ dirty` hash-set
  build + `has_address_subscribers` check per entry. A 1M-cell restore
  with zero subscribers performs ~3M hash ops to conclude nobody is
  watching. The "no listener fires for unwatched cells" contract holds
  semantically; the cost shape doesn't. Same shape one layer up: the
  workbook flush BFS seeds queue+visited with the ENTIRE touched set
  (`workbook.rs:2039-2044`) even with zero cross-sheet edges.
- Contrast `bulk_install_storage` (`sheet.rs:1357`, `:1430-1435`):
  iterates only `cell_subscriptions` keys — O(subscribed). Honors the
  lazy extreme in cost as well as semantics.
- Fix sketch: subsumed by B-1 (route restores through install). If the
  legacy loader stays for additive merges: early-out the BFS seeding
  when `cross_sheet` is empty and skip the notify-set build when
  `cell_subscriptions` is empty.

#### B-6 · P-A · **P3** — custom-formula / defined-name registry changes walk all hydrated formulas

- `invalidate_all_formulas_for_custom_function_change`
  (`workbook.rs:647-655`) and `invalidate_formulas_using_name`
  (`workbook.rs:676+`) walk every sheet's hydrated formula table,
  mark-dirty + fire-subscribers per address. The vnext provider diffs
  the registry and forwards each add/replace/remove separately, so K
  registrations cost K × O(F_hydrated).
- Mitigations already in place: parked formulas are correctly skipped
  (no stale cache to invalidate — fresh import makes this near-free),
  and the O(F) sledgehammer is documented in-code with the per-name
  reverse-index upgrade path. Watch-list only.

#### B-7 · P-D · **P3** — `restore_sparse` is additive with no teardown

- `restore_sparse` (`rust/wasm/src/lib.rs:3002`) applies records onto
  the LIVE workbook: no cell teardown, no subscription reset.
  `snapshot_sparse` walks only non-empty cells (`lib.rs:3391`) and
  never emits `"null"` records, so snapshot → restore onto a workbook
  that gained cells since the snapshot does NOT reproduce snapshot
  state (cells deleted-since-snapshot survive).
  `restore_persistence_v1` does it right — fresh `Workbook`,
  `subscriptions.clear()` + token reset (`lib.rs:3338-3353`).
- Fix sketch: document the additive contract in the `restore_sparse`
  docstring, or give it the fresh-shell semantics of
  `restore_persistence_v1`. Decide before B-1's reroute (full-replace
  install would silently change current additive behavior).

#### B-8 · P-B · **P3** — `readCells` does one wasm-boundary crossing per cell

- Worker RPC `readCells`
  (`solid/excel/src-vnext/adapter/worker-runtime.ts:1559-1565`) maps
  per-cell `snapshotCell` → one wasm-bindgen call + per-cell JS object.
  `subscribeCells` (`:952`) similarly loops `wb.subscribe_cell` per
  cell. Range-shaped reads are properly batched (one
  `serde_wasm_bindgen::to_value` per `read_sparse_range` /
  `snapshot_range_sparse` call) — but arbitrary-cell-list reads have
  no batch endpoint. Bounded by viewport/subscription size (~10³) in
  practice. Fix sketch: a `read_cells(JsValue) -> JsValue` batch
  export mirroring the sparse-range shape.

### Cleared paths

- **recalc / F9**: no recompute-everything API exists in `excel-core`
  or `rust/wasm` (only "recalc" hit is the `INFO("recalc")` literal,
  `eval.rs:15454`). Recompute scope is per-read via
  `force_formula_recompute` gated on `has_any_cross_sheet_edges`.
  Nothing eager to audit. CLEAR.
- **cross-sheet latch vs lazy formulas**: `install_sheet_bulk`'s
  `!`-prefilter arms the sheet latch when edges exist
  (`workbook.rs:1706-1711`); hydration arms it via
  `note_cross_sheet_if_any` (`sheet.rs:1235`); a parked formula has no
  cache to go stale (first read evaluates fresh). CLEAR — except the
  `Expr::Name` hole, which is B-4.
- **snapshot paths don't evaluate or hydrate parked formulas**: pinned
  by `audit_snapshot_does_not_hydrate_parked_formulas` — walking all
  parked cells through the `sparse_cell_from_sheet_no_eval` shape
  (`get_formula` text-only + `peek_value` for primitives) leaves eval
  count and dep-graph keys at 0. Confirms + CLEARS the 6.3 report.
- **format/size facts serialization is O(facts)**:
  `snapshot_format_range` (`sheet.rs:3509`) iterates the sparse
  `formats` map + `range_formats` layers; sizes iterate sparse
  `BTreeMap`s. No per-cell expansion. CLEAR.
- **`bulk_install_workbook` wire + notify**: ONE
  `serde_wasm_bindgen::from_value` per call (`lib.rs:2694`); notify is
  O(subscribed) + one cross-sheet fanout O(edges), deduped across
  multi-sheet installs (`workbook.rs:1735-1763`). CLEAR.
- **`bulk_install_storage` teardown** (`sheet.rs:1348-1438`): spill
  targets, primitive atoms, hydrated records, dep indexes, lazy
  parking, and outgoing cross-sheet edges (`workbook.rs:1672`) all
  torn down; subscription buckets deliberately survive and notify
  once. No missing parallel table found. CLEAR (P-D).

### Severity tally

**P1 ×2** (B-1, B-4) · **P2 ×1** (B-2) · **P3 ×4** (B-5, B-6, B-7,
B-8) — B-3 corroborates A-1, not double-counted.
