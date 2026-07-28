# Plan — Storage-primary bulk_import (Phase 6 proper)

Status: **2026-06-11 LANDED** (6.1–6.3 + codex fixup; 6.4 partially —
see below). Original RFC preserved below for reference.

## Closure summary

| Phase | Commit | Outcome |
|---|---|---|
| 6.1 engine entry | `3c0574a` | `install_sheet_bulk` / `install_workbook_bulk` / `content_revision()`; full-sheet-replace semantics; `!`-prefilter keeps cross-sheet edges correct while same-sheet formulas skip parse entirely |
| 6.2 wire + binding | `5d0ad42` | `bulk_install_workbook(payload)`; per-sheet [addr, value] / [addr, source] pair arrays deserialized straight into engine maps |
| bench | `c814b62` | 500k: 4835→323ms (15×). 1M: 8652→771ms (11.2×). **WASM bulkWrite at TS parity** (TS=785ms) |
| 6.3 worker routing | `812fdad` | Atomic import sessions (file import, million-demo) stage into a fresh shell, ONE `bulk_install_workbook` at commit. Direct-mode chunks + live-workbook replay stay on legacy additive `bulk_import_cells` (TODO(6.4) markers) |
| codex review fixup | `db6ba64` | P2: install now fires cross-sheet dirty fanout — O(cross-sheet formula edges), dependents on other sheets dirty + notify once (multi-sheet install dedups). Post-fix bench 578ms |

**Phase 6.4 status**: legacy `bulk_import_cells` is retained, deliberately —
it is the additive-merge path (paste-TSV into existing content, direct-mode
chunks). It is no longer on any hot path; fresh imports route storage-primary.
Full retirement would require an additive variant of install; not worth it
until a workload shows the additive path hot again.

**Phase 6.5 status**: superseded — the `!`-prefilter in 6.1 achieves the goal
(no parse for same-sheet formulas at install) without moving cross-sheet edge
install to hydrate; `rebuild_cross_sheet_deps` + `for_each_lazy_formula`
(from 7d0e380) cover move_sheet correctness.

Final numbers: cargo 1740, wasm 30, jest 3695, playwright wasm 480/0/37.

## The architectural mistake

The TS port matches einfach's atom model: `sheetAtom` holds
`Map<CellKey, Cell>` as the source of truth; `formulaCellAtom(key)` is a
derived atom that reads the map and computes. Bulk import is ONE setter
call that hands the atom a pre-built Map — no per-cell function calls,
no intermediate ops queue.

The Rust port does the opposite. `WorkbookLoader::set_formula` is the
"API of record" for installing formulas; bulk import iterates and
calls it 500k times. Each call:

1. parses the formula source → AST (~5-10 Box allocs)
2. cycle-checks via cross-sheet BFS
3. removes old cross-sheet edges + installs new ones (per edge)
4. allocates a SetFormula op (`String addr_str` + `String source` + `Rc<Expr>`)
5. pushes onto `ops_by_sheet[sheet_idx]: Vec<WorkbookOp>`
6. inserts `(sheet, addr)` into a touched HashSet

Then flush iterates ops_by_sheet and calls Sheet::set_formula_pre_parsed,
which (after Phase 2+3) just stores source text into `formula_source` +
inserts the addr into `needs_parse`.

So the engine does **per-cell heavy work just to populate a HashMap that
the lazy refactor already proved doesn't need to be populated eagerly**.
The 6.1 µs/formula cost is all ceremony.

Phase 2+3 made Sheet::set_formula lazy. **WorkbookLoader::set_formula is
still eager.** Same philosophical drift, one layer up.

## The right architecture

Storage is primary; the API is secondary. Concretely:

### Sheet owns the HashMaps directly

```rust
struct Sheet {
    cells:           RefCell<HashMap<CellKey, Value>>,     // primitives
    formula_source:  RefCell<HashMap<CellKey, Rc<str>>>,   // raw formula text
    needs_parse:     RefCell<HashSet<CellKey>>,            // unhydrated
    formula_cells:   RefCell<HashMap<CellKey, FormulaRecord>>,  // lazy hydrated
    cell_dependents: RefCell<HashMap<CellAddress, HashSet<CellAddress>>>,  // built lazily
    range_dependents:RefCell<RangeDependentIndex>,         // built lazily
    // ... existing per-cell cache state ...
}
```

(The fields are mostly already there from Phase 2+3. The change is that
the storage IS the API, not behind a layer.)

### bulk_import engine entry

```rust
pub fn install_sheet_bulk(
    &mut self,
    sheet_idx: usize,
    primitives: HashMap<CellKey, Value>,
    formulas:   HashMap<CellKey, Rc<str>>,
) {
    let sheet = &mut self.sheets[sheet_idx];
    let needs_parse: HashSet<CellKey> = formulas.keys().copied().collect();
    *sheet.cells.borrow_mut()          = primitives;
    *sheet.formula_source.borrow_mut() = formulas;
    *sheet.needs_parse.borrow_mut()    = needs_parse;
    // Existing per-cell caches stay empty until first read.
}
```

No loop. No parse. No cross-sheet edge install. No ops queue. Just three
HashMap swaps. O(1) per swap; the per-cell cost was paid by serde at the
wasm-bindgen boundary.

### Wire format → engine HashMap directly

Currently: JS Array<ImportCellWire> → serde → Rust `Vec<ImportCellWire>`
→ for-loop calls WorkbookLoader::set_formula → eventually lands in
Sheet's HashMaps.

Replace: JS sends a per-sheet structure that serde can deserialize
directly into the two HashMaps:

```ts
type BulkImportPayload = {
  sheets: Array<{
    sheet_idx: number,
    primitives: Array<[CellKey, PrimitiveWire]>,  // already (key, value) pairs
    formulas:   Array<[CellKey, string]>,          // (key, source_text) pairs
  }>
}
```

serde_wasm_bindgen deserializes the inner arrays of pairs straight into
`HashMap<CellKey, _>` (serde's `seq → HashMap` impl handles this). Then
the engine `install_sheet_bulk` swaps them in. The 500k for-loop in
WorkbookLoader is eliminated.

### Cross-sheet edges become lazy too

Today the WorkbookLoader parses each formula partly to extract
cross-sheet refs for `cross_sheet` graph install. After this refactor,
cross-sheet edges are installed by `hydrate_formula` on first read,
same way `cell_dependents` / `range_dependents` already are.

This means cross-sheet cycle detection during bulk_load goes away —
matches Phase 2+3's same-sheet cycle deferral. Codex already accepted
that semantic shift; same justification applies here.

### UI edit path stays eager

`Workbook::set_cell_input(sheet, addr, text)` (the UI edit entry) still
parses + cycle-checks + installs eagerly. Single-cell writes are cheap;
no point deferring. Same D1 = 4A decision from the Phase 2+3 plan.

## What goes away

- `WorkbookLoader::set_formula` per-cell parse (line 1571)
- `WorkbookLoader::set_formula` cross_sheet_cycle BFS per formula (line 1596)
- `WorkbookLoader::set_formula` cross_sheet edge install (lines 1619-1623)
- `WorkbookOp::SetFormula` op type (the op was a workaround for the
  per-call structure; with bulk install, no ops queue)
- `ops_by_sheet: HashMap<sheet_idx, Vec<WorkbookOp>>` map (or at least
  the SetFormula path; SetCell / Clear / etc. may keep an ops-style API
  for UI single-cell mutations, but bulk import skips it entirely)
- The `set_formula_pre_parsed` Sheet method (added in Phase 2+3 to let
  the loader hand a pre-parsed Expr to the sheet — moot when the loader
  doesn't parse)

## What stays

- Phase 2+3's lazy hydration on read — unchanged.
- Phase 5's removed cap — unchanged.
- UI edit path via `set_cell_input` / `set_formula` (Workbook-level
  single-cell mutators) — unchanged.
- Cross-sheet cycle detection at first read (gets it from hydrate's
  cycle path).
- Spill, named ranges, recalc, F9 — all unchanged.

## Why this works architecturally

einfach is built on atoms. Atoms are slots; updates happen via setter.
The TS port treats `sheetAtom` as exactly that — one slot holding the
whole map, with derived atoms over it.

The Rust port doesn't have JS atoms but the design intent is the same:
the Sheet's HashMaps ARE the slots. Bulk_load should just replace the
slot contents. The WorkbookLoader's per-cell API is a ceremonial wrapper
that made sense when the engine was eager (because you needed per-cell
hooks for "parse, then install dep, then queue notify"). With lazy
hydration, that ceremony is dead weight.

The TS port's read path is the same — `formulaCellAtom(key)` parses +
evaluates lazily on first get. Our Rust hydrate_formula does the same.
The architectures are now structurally identical at the conceptual
level; we're just removing the leftover scaffolding on the Rust side.

## Expected win

Today, `set_formula_loop_ms` = 3179ms = 77.2% of WASM Mega bulkWrite (4.1s
inside the wasm trace, 7.2s wall including JS-side prep). After this
refactor:

- `set_formula_loop_ms` collapses to ~0 (the loop is gone).
- `flush_ms` collapses further (no SetFormula ops to replay).
- `deserialize_ms` (10%) stays — but may go up slightly because the wire
  format changed.
- Per-cell cost drops from 7.2 µs to ~1-2 µs (essentially the serde +
  HashMap insert hash cost).

Estimated Mega bulkWrite: **7.2 s → ~1.5-2 s.** TS gap (currently 9.2×)
collapses to **~2-3×**, potentially under 2× at the Ultra (5M) tier
where Rust's HashMap edges out V8's Map.

## Phases (each lands as 1-2 commits, validated against existing tests)

### Phase 6.1 — engine entry that takes a pre-built map

- Add `Workbook::install_sheet_bulk(sheet_idx, primitives, formulas)`
  that swaps the two HashMaps into the sheet (per the design above).
- Keep `bulk_import_cells` working — for now, the old path still
  iterates and calls the loader. We're just adding the new direct entry.
- Pin with a Rust test: build a HashMap manually, call `install_sheet_bulk`,
  read back, confirm same values as old path.

### Phase 6.2 — wire format

- Add a new wire shape `WorkbookBulkPayload` (per-sheet primitive +
  formula pair arrays). serde deserializes the pair arrays directly
  into HashMaps.
- Add `wasm` binding `bulk_install_workbook(payload: JsValue)` that
  deserializes into the new shape, then calls `install_sheet_bulk` per
  sheet.

### Phase 6.3 — route the worker through the new path

- `worker-runtime.ts` (WASM) builds the new wire shape from its current
  ImportCellWire arrays. Calls `bulk_install_workbook` instead of
  `bulk_import_cells`.
- `worker-runtime-ts.ts` (TS) stays unchanged — its bulkApply already
  matches this model.

### Phase 6.4 — measure + retire old path

- Re-run Mega bench. Confirm WASM bulkWrite drops to target.
- Confirm Ultra tier (5M cells) gets even bigger relative win.
- If validated: deprecate the old `bulk_import_cells` path (mark as
  legacy, host migrates over). Eventually remove.

### Phase 6.5 — cross-sheet edge lazy install

- Strip the eager cross-sheet edge install from WorkbookLoader.
- `hydrate_formula` extracts cross-sheet refs from parsed AST and
  adds them to `cross_sheet` graph there.
- Mirror Phase 2+3's edge-walk in `rebuild_cross_sheet_deps` for
  not-yet-hydrated formulas (we already wrote `for_each_lazy_formula`).

### Phase 6.6 — docs + closure

- Update SESSION_HANDOFF, PLAN doc, and the perf reports.
- Codex review of the architectural shift before final merge.

## Risks

1. **Wire format churn**. Host adapters need to migrate. Solid host has
   a single worker-runtime; small change. Any external consumers of
   `bulk_import_cells` need migration paths.

2. **Cross-sheet cycle detection moves to first read**. Same as Phase 2+3.
   Already accepted.

3. **HashMap memory peak at deserialize**. Today the engine holds the
   Vec<ImportCellWire> THEN copies into HashMaps. After: just the
   HashMaps. Peak memory should drop, not rise.

4. **Test impact**. Tests that exercise WorkbookLoader directly
   (`wb.bulk_load(|loader| loader.set_formula(...))`) stay valid for
   the UI-edit-like path. Bulk import tests get migrated to the new
   entry.

5. **set_cell / clear_cell ops**. Today they queue through `ops_by_sheet`
   for the same reasons. Decision pending: keep them as ops (UI single-
   cell writes are infrequent so the queue overhead is fine), or migrate
   them to direct map mutation too. Lean: keep them as ops for the UI
   path; bulk path uses install_sheet_bulk only.

## Open decisions before Phase 6.1

- **OD1**: where does `install_sheet_bulk` invalidate cached state?
  Likely needs to bump the workbook revision counter + clear hydrated
  caches for the affected sheet. Sketch: yes, both, mirroring what
  Sheet::bulk_load did pre-Phase 2.

- **OD2**: should `install_sheet_bulk` accept a Workbook-level payload
  (all sheets at once) or per-sheet? Per-sheet is simpler; whole-
  workbook is one call. Recommend whole-workbook to match the JS
  side's typical "load this entire workbook" call shape.

## What success looks like

- Mega (1M) bulkWrite WASM ≤ 2 s (target; today 7.2 s).
- Ultra (5M) bulkWrite WASM ≤ 12 s (today 54.6 s).
- WorkbookLoader::set_formula no longer the hot path; the per-cell loop
  is gone from the bulk path.
- Engine self-consistent: storage IS the API; bulk = swap maps; UI =
  mutate one entry. Same as the TS port. The Rust engine's
  philosophy matches einfach's atom model.
