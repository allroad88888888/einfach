# Plan — Lazy Formula Indexing (Option E)

Status: **2026-06-11 LANDED**. Phases 1, 2+3, 4 (implicit), 5 complete.
Codex review caught 2 P1 + 2 P2 correctness regressions (`7d0e380`).
Cap removed entirely. Mega bulkWrite 428s → 11.4s (38×). Ultra (5M
cells, single call) works at 2.9 GB peak RSS.

Original RFC preserved below for historical reference. Closure summary:

- Phase 1 (instrument): `ffe4feb` + `5744175` + `54d42cd` + `5766333`
- Phase 2+3 (lazy bulk_load + hydrate): `40bc473`
- Codex review fixups: `7d0e380`
- Phase 5 (cap removal): `8a2f7f3` + `d0eb0da` + `3948b27`

Trace + measurements: `MEGA_TRACE_2026-06-11.md`, `CAP_REMOVAL_2026-06-11.md`.

## Why this exists

The Rust `excel-core` documents itself as "purely lazy — a formula goes dirty on
dep change and stays dirty until the next read" (`workbook.ts:320` comment in
the TS port; mirrored in `rust/excel-core/src/sheet.rs:2397` / `:3638`).

But the **build phase** is not lazy. `Workbook::bulk_load` →
`Sheet::bulk_load` eagerly:

- parses every formula AST,
- extracts each formula's point + range deps,
- registers them in `cell_dependents` (`HashMap<addr, HashSet<addr>>`),
- registers them in `range_dependents`,
- materialises `FormulaRecord` per cell.

At Mega tier (500k formulas), this eager build is the dominant cost:
**TS bulkWrite = 908 ms, WASM = 428 s, 470× slower.** Codex's 2026-06-11
review attributed the gap to "eager Rust formula/dependency installation",
not host chunking, not the 750k cap. The cap is a symptom (the allocator
panics at ~1M formula installs because the dep graph alone exhausts
4 GB linear memory) — the disease is doing the work at all.

einfach is an **atom-based, lazy state library**. Doing eager dep-graph
construction at import time is a design regression: it makes the engine
pay for graphs the host may never read. The TS port doesn't have this
regression — its dep graph is implicit in the atom subscription web,
which only materialises on `get`.

Goal: bring the Rust engine back into alignment with einfach's lazy
contract by **deferring dep-graph construction to first read**.

## The contract change

**Today (eager build, lazy eval)**:

```
bulk_load:
  for each formula:
    parse AST
    extract deps -> cell_dependents / range_dependents
    materialise FormulaRecord
read:
  if dirty -> evaluate using cached AST + deps
  cache result
```

**Target (lazy build, lazy eval)**:

```
bulk_load:
  for each formula:
    store source text only (Rc<str> indexed by addr)
    mark addr as "needs_parse"

read:
  if addr in needs_parse:
    parse AST
    extract deps -> cell_dependents / range_dependents
    materialise FormulaRecord
    remove from needs_parse
  if dirty -> evaluate using cached AST + deps
  cache result
```

The "needs_parse" set is the only new state. Everything downstream
(dirty propagation, F9 recalc, spill, cycle detection) already runs on
parsed-formula state, so once a formula leaves `needs_parse` it rejoins
the existing machinery untouched.

## What changes vs what stays

| Surface | Before | After |
|---|---|---|
| `Sheet::bulk_load` | parses + indexes | stores source text + sets `needs_parse` flag |
| `Sheet::get_cell_value` (formula path) | reads cached value or re-evals on dirty | if `needs_parse`, parses + indexes first; then existing path |
| `Sheet::set_cell_input` | unchanged for primitives; for formulas: parse + index | unchanged for primitives; for formulas: same as `bulk_load` (lazy) |
| `Sheet::mutate_address` (dirty propagation) | walks `cell_dependents` + `range_dependents` | unchanged. Unparsed formulas have no entries to walk → no work done. They evaluate fresh on first read regardless. |
| `would_create_cycle` | walks dep graph | unchanged. Cycle detection only fires when set_cell_input writes a formula — that path can still trigger parse-on-write if we want cycle errors at write time (vs first-read time). **Decision pending.** |
| `cell_dependents` / `range_dependents` | filled at bulk_load | filled lazily on first read of each formula |
| `FormulaRecord` | per formula at bulk_load | per formula on first read |
| `restore_sparse` / `restore_persistence_v1` | calls `bulk_load` | calls lazy `bulk_load` |
| `MAX_BULK_IMPORT_CELLS_PER_CALL = 750_000` | hard reject above cap | likely removable after Phase 4 measurement |

## Phases (each lands as 1-2 commits, validated against existing tests)

### Phase 1 — RFC + instrumentation (no behavior change)

- Land this doc.
- Add sub-phase timers to `bulk_import_cells_instrumented`:
  `parse_ms`, `dep_extract_ms`, `dep_register_ms`, `formula_record_ms`,
  separately from existing `flush_ms`. Today everything collapses into
  `flush_ms`.
- Add an edge-counting probe: total point-dep edges, total range-dep
  entries, max/avg fanout, range-formula count. Exposed via
  `debug_dep_graph_stats()` on `WasmWorkbook`.
- Re-run the Mega bench with the new traces to confirm codex's
  attribution: "eager dependency install dominates".

Acceptance: traces + a one-page measurement summary committed under
`rust/excel-core/docs/MEGA_TRACE_2026-06-XX.md`. No correctness change.

### Phase 2 — Source-only storage at `bulk_load`

- Add `formula_source: RowMajorMap<Rc<str>>` to `Sheet`.
- Add `needs_parse: HashSet<CellAddress>` to `Sheet`.
- Modify `Sheet::bulk_load`:
  - Primitives: write to `cells` map as today.
  - Formulas: write source to `formula_source`, insert addr into
    `needs_parse`. DO NOT parse, DO NOT register deps, DO NOT build
    `FormulaRecord`.
- The `formula_cells` / `cell_dependents` / `range_dependents` maps
  stay untouched at this point.
- **Reads still work** because the existing read path will land in
  Phase 3.

Acceptance: existing 1396 cargo lib tests pass. New behavior gate:
all formula cells imported via `bulk_load` are in `needs_parse` after
import. Edge counts (Phase 1 probe) report 0 immediately after a fresh
`bulk_load`.

### Phase 3 — Lazy hydration on read

- New helper `Sheet::hydrate_formula(addr)`:
  - If `addr` in `needs_parse`: take source from `formula_source`,
    parse AST, extract deps, register in `cell_dependents` +
    `range_dependents`, materialise `FormulaRecord`, remove from
    `needs_parse`.
  - Idempotent: no-op if already hydrated.
- Modify every read entry point (`get_cell_value`, `evaluate_cell`,
  spill anchor reads, sparse aggregation iterators) to call
  `hydrate_formula(addr)` before touching `formula_cells[addr]` or
  walking the dep graph for `addr`.
- Sparse aggregation (`SUM(A:A)`) iterating a column: hydrate each
  formula cell it encounters. This means range-aggregate over a
  column of formulas DOES hydrate them — that's correct semantically.

Acceptance: existing 1396 cargo lib tests still pass. After
`bulk_load + read of 10 formula cells`, exactly 10 entries are in
`cell_dependents` / `range_dependents`. The rest stay deferred.

### Phase 4 — Mutation semantics

- `mutate_address(addr)` already walks `cell_dependents` + `range_dependents`
  for dirty propagation. Unparsed formulas are not in those maps → they're
  silently not invalidated, which is **correct** (they have no cached
  value to invalidate; on first read they parse + evaluate fresh).
- `set_cell_input(addr, formula)`: today this parses + cycle-checks before
  install. Two options:
  - **4A**: keep parse-on-write for `set_cell_input`. Cycle errors fire at
    write time, matching today's UX. Only `bulk_load` is lazy.
  - **4B**: lazy for `set_cell_input` too. Cycle errors fire on first read.
    Different UX from today.

Recommend **4A** for the first cut (smaller behavior change). 4B can come
later if needed.

Acceptance: existing mutation + cycle tests pass. Add a test:
`bulk_load + mutate primitive + read formula` produces the correct value
without ever populating cell_dependents for un-read formulas.

### Phase 5 — Cap measurement + removal

- Re-run Mega + Ultra tier bench. With lazy bulk_load, allocator pressure
  during import is just text storage — should comfortably handle 1M+
  formulas without panic.
- Remove `MAX_BULK_IMPORT_CELLS_PER_CALL` cap at all 4 entry points if
  Ultra (1M formula) bulk_load completes < 5 GB peak RSS.
- Keep a soft warning at, say, 5M (or some new measured ceiling) since
  text storage itself still scales.

Acceptance: Ultra tier bench completes on WASM (today it panics). Cap
removed. Per-call limit either gone or moved to a new evidence-backed
number.

### Phase 6 — Validation

- Full Rust integration suite: 1396 + 15 integration suites green.
- Full TS jest sweep: 1791 + 3681 monorepo green.
- e2e double-backend: 478 / 0 / 37 still.
- Perf SLOs:
  - Chain100k bulkWrite: WASM ≤ 1 s (today 501 ms ✓ already).
  - Mega (1M) bulkWrite: WASM ≤ **5 s** (today 428 s — 80× target).
  - Mega readBack: WASM within 1.5× of today (60 s today, target ≤ 90 s).
    Reads now pay hydration cost; this is the tradeoff.
  - Mega recalc: WASM within 1.1× of today (61 s today, target ≤ 67 s).
- Cross-backend parity: TS port behavior should be matched by Rust — verify
  via the dual-backend e2e suite.

### Phase 7 — Documentation + cleanup

- Update `SESSION_HANDOFF` and `ARCHITECTURE.md` notes.
- Remove obsolete eager-build commentary.
- Add `docs/LAZY_FORMULA_INDEXING_RESULT.md` with before/after numbers.

## Risks + open questions

1. **Spill anchors**. A formula that returns `Value::Array` spills into
   target cells. Spill resolution requires evaluating the anchor. With
   lazy hydration, reading a spill target hydrates the anchor (transitively).
   Need to verify: if a user reads `B5` and `B5` is a spill target of
   `B4 = SEQUENCE(...)`, does `read(B5)` trigger `hydrate(B4)`?
   The existing spill index should make this natural; pin with a test.

2. **Cycle detection at first read**. If 4A (parse-on-write for set_cell_input),
   `bulk_load`-imported cycles don't fire until first read. A cycle in
   imported data surfaces as `#CIRCULAR!` on the first read of any cycle
   member, not at import. Probably acceptable; matches TS port behavior.

3. **Named ranges / defined names**. If a defined name points at a formula
   cell, accessing the name in another formula must trigger hydration.
   `resolveName` callback needs hydration awareness.

4. **F9 recalc semantics**. `recalc()` bumps every sheet's atom. With lazy
   hydration, F9 would re-evaluate hydrated formulas only. Unhydrated
   formulas stay deferred until read. **Decision**: matches lazy
   contract; correct behavior.

5. **Custom formulas / LAMBDA**. Workbook-level LAMBDA / custom formula
   registration triggers `recalculateAllSheets()` today. With lazy
   hydration, the registration just invalidates hydrated formulas;
   unhydrated formulas pick up the new registry on first read. Correct.

6. **Cross-sheet refs**. A formula on sheet A referencing sheet B's
   formula. First-read of A hydrates A; evaluating A requires reading
   B's cell, which hydrates B. Recursive but bounded. Stack-overflow
   risk if dependency chain is deep — but the existing iterative
   prewarm + trampoline already handles deep chains, so should be fine.

7. **Serialization (snapshotPersistenceV1)**. The snapshot format
   captures cell input strings, not parsed AST. With lazy build, this
   is unchanged — snapshot is the source-text view, which is also the
   lazy-build view.

8. **Concurrent reads** (irrelevant today since WASM is single-threaded,
   but worth noting): if WASM ever goes multi-threaded, two readers
   racing to hydrate the same formula need a guard. Today: not a
   concern.

## Open decisions before Phase 2

- **D1**: 4A (eager parse on `set_cell_input`) or 4B (lazy everywhere)?
  Recommend 4A.
- **D2**: Where to store `formula_source`? Co-located with `cells` in
  `RowMajorMap` or its own map? Recommend separate map for cache
  locality (cells map stays hot for read-path).
- **D3**: `needs_parse` representation. `HashSet<CellAddress>` works.
  Alternative: a bit per cell in a dense bitmap (one bit per address)
  cuts overhead. Probably not worth it at this scale — start with
  HashSet, optimise if Phase 1 traces flag it.

## Phase dispatch summary (for the agent fleet)

| Phase | Scope | Risk | Agent budget |
|---|---|---|---|
| 1 | RFC + instrumentation | Low | 1 agent, ~30 min |
| 2 | Source-only `bulk_load` | Medium | 1 agent, ~1 h |
| 3 | Lazy `hydrate_formula` + read-path wiring | High | 1 agent, ~1.5 h, with codex review |
| 4 | Mutation semantics + tests | Medium | 1 agent, ~45 min |
| 5 | Cap removal + bench | Low-Medium | 1 agent, ~45 min |
| 6 | Full validation sweep | Low | architect-direct |
| 7 | Docs + cleanup | Low | architect-direct |

Phases 2/3 are the heart. Phase 3 must be reviewed by codex before merge.

## What success looks like

- Mega (1M) bulkWrite on WASM drops from **428 s → < 5 s** (target 80× win).
- `MAX_BULK_IMPORT_CELLS_PER_CALL` cap removed or raised to ≥ 5M.
- Engine self-consistent: lazy build matches lazy eval. No more philosophical
  drift between "we're a lazy atom library" and "we eagerly build the dep
  graph at import".
- All existing tests still pass; new tests pin the deferred-hydration
  contract.
