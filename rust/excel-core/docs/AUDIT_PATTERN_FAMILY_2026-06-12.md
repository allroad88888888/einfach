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

## A — Structural ops (Rust)

Audit date 2026-06-12. Read-only; repro pins live in
`rust/excel-core/tests/audit_structural_scaling.rs` (5 always-on tests
pinning CURRENT behavior — including the bugs — plus 3 `#[ignore]`d
timing benches). Numbers below: Apple Silicon, `cargo test --release
--test audit_structural_scaling -- --ignored --nocapture`. WASM hosts
should expect a multi-x multiplier on top. `cargo test --lib` green
(1396 tests) with the pins included.

### Findings

#### A-1 · P-A · **P1** — one `insert_row` hydrates + re-parses EVERY formula on the sheet

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

#### A-2 · P-A · **P2** — `move_sheet` parses every lazy formula on every sheet

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

#### A-3 · P-A · **P2** — clearing ONE cell is O(total formulas)

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

#### A-4 · P-D · **P1** — `clear_range` over a spill region PANICS the engine

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

#### A-5 · P-D · **P1** — structural edits do not relocate `spill_targets`

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

#### A-6 · P-C · **P1** — `remove_sheet` permanently kills ALL cross-sheet dirty/notify fanout

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

#### A-7 · P-C · **P2** — `rename_sheet` changes dependent values with zero propagation

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
| P1 | 4 | A-1 (insert_row O(all formulas)), A-4 (clear_range panic), A-5 (spill_targets not relocated), A-6 (remove_sheet kills fanout) |
| P2 | 3 | A-2 (move_sheet full parse), A-3 (1-cell clear O(sheet)), A-7 (rename_sheet silent) |
| P3 | 2 | A-8, A-9 |

Headline: one `insert_row` on a 500k-formula sheet costs **2.09 s**
native (and ~1.35 s for every one after); `clear_range` over any
dynamic-array spill **panics the engine**; removing an unrelated sheet
**permanently silences** all cross-sheet subscriber notifications.

## C — TS port (vanilla/excel-core-ts + core store)

Audit date 2026-06-12. Read-only; measurement pins live in
`vanilla/excel-core-ts/test/audit-mutation-scaling.test.ts` (loose
assertions, console timings — not perf gates). Apple Silicon, Node via
jest, `npx jest vanilla/excel-core-ts --no-coverage` green (31 suites /
1802 tests) with the pins included.

### Findings

#### C-1 · P-A · **P1** — whole-Map clone per single-cell edit

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

#### C-2 · P-A · **P1** — store flush re-derives EVERY cached formula on any write

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

#### C-5 · P-C · **P2** — `withBatch` throw path drops invalidation but keeps the mutation

- `vanilla/excel-core-ts/src/workbook.ts:554-561`: on throw, the
  outermost frame clears `pendingRecalc` WITHOUT firing it — but the
  registry mutations that already ran (`names.set`,
  `customFormulas.set/delete`, `currentLocale = ...`) are not rolled
  back. Result: registry and cached derives disagree until any
  unrelated mutation heals them.
- Pinned repro (in the audit test file): `=MYNAME` reads `#NAME?`;
  `withBatch(() => { defineName('MYNAME', 99); throw })`; post-throw
  read still `#NAME?` while the registry holds `MYNAME=99`; an
  unrelated `setCell` then flips the same cached atom to `99`.
- Fix sketch: pick one consistent semantic — either roll back the
  registry deltas on abort (true transactionality) or fire the deferred
  recalc anyway (mutation happened ⇒ invalidate). Current half-measure
  is the only P-C instance found; all five cell mutators uniformly
  route `writeSheetState` and are clean.

#### C-6 · P-D · **P2** — formula derive atoms are never torn down

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
| P1 | 2 | C-1 (clone/edit), C-2 (flush fan-out) |
| P2 | 5 | C-3, C-4, C-5, C-6, C-8 |
| P3 | 1 | C-7 |

Headline: on a 1M-cell sheet a single keystroke costs **~108 ms** of Map
clone (C-1); with 100k read formulas it additionally costs **~503 ms** of
synchronous re-evaluation (C-2). The two compose: the TS port is the
architectural reference for *laziness at build time* but has the exact
inverse problem at *mutation time*.

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
