# Key-granular invalidation — RFC (audit C-1 / C-2 / C-6)

Status: **implemented** (Wave 2 / W2.2, 2026-06-12).
Findings: `rust/excel-core/docs/AUDIT_PATTERN_FAMILY_2026-06-12.md` § C.
Measurement pins: `vanilla/excel-core-ts/test/audit-mutation-scaling.test.ts`.

## Problem

The TS engine conflated two things in `sheetAtom`'s Map identity:

1. **storage** — the cell map every read walks, and
2. **the change signal** — a fresh `new Map(prev)` per write was the only
   way to tell vanilla/core "something changed", which made EVERY cached
   formula derive a back-dependency of the whole sheet.

Consequences, measured (Apple Silicon, jest):

- **C-1**: `applyCell`'s `new Map(prev)` made one keystroke cost
  **107 ms @ 1M cells** (perfectly linear in TOTAL sheet size).
- **C-2**: `store.ts` `flushPending → dependenciesChange(sheetAtom)`
  re-evaluated EVERY cached formula derive on any write —
  **503 ms / 100 000 re-evals @ 100k read formulas** for one unrelated
  `setCell`. C-1 + C-2 compose to ~610 ms/keystroke.
- **C-6**: `formulaAtomCache` + the store's `backDependenciesMap` never
  evicted — formulas overwritten by literals left a permanent ~40×
  per-edit drag (16–17 ms vs 0.4 ms baseline @ 10k orphans).

## Design chosen

**Option (i)** — the workbook drives invalidation itself from a
dependency index; **vanilla/core is untouched** (no new API, no behavior
change for `react/form`, `solid/*`, grid-table consumers).

This is the same conceptual model the Rust engine landed in
`STORAGE_PRIMARY_PLAN.md` / `LAZY_FORMULA_INDEXING_PLAN.md`:

- storage is primary (one live map per sheet),
- per-cell reverse-dep indexes (`cell_dependents` / `range_dependents`
  mirrors) are built **lazily as formulas evaluate**, and
- a mutation dirties **O(dependents-of-written-keys)** via BFS, not
  O(cached formulas).

### C-2 — per-formula epoch atoms + workbook dep graph

Each cached formula atom's derive no longer does `get(sheetAtom)`.
Instead:

- `formulaCellAtom(key)` lazily creates a **pair**: a tiny primitive
  `epochAtom` (number) and the derive, whose ONLY reactive dep is
  `get(epochAtom)`. Cells are read from the sheet's live map via
  closure — no dep registration, so a sheet write wakes nothing
  by itself.
- The workbook owns a `DepGraph` (`src/deps.ts`):
  - `cellDependents: Map<sheetId, Map<CellKey, Set<fid>>>` — point refs
    (mirror of Rust `cell_dependents`),
  - `rangeDependents: Map<sheetId, RangeIndex>` — column-bucketed range
    index with a wide-range fallback list (mirror of Rust
    `RangeDependentIndex`; col buckets + `wide` set for ranges spanning
    > 128 columns), so sparse whole-column aggregates (`=SUM(A:A)`)
    are indexed by column, not per-key,
  - `broadDependents: Set<fid>` — formulas whose refs cannot be
    statically bounded: `INDIRECT` / `OFFSET` / `dynamicRange`
    endpoints, plus volatile functions (`NOW`, `TODAY`, `RAND`,
    `RANDBETWEEN`, `RANDARRAY`). These re-derive on every value write —
    exactly the engine's previous (and Excel's volatile) behavior.
  - `fid = sheetId + '' + key` (workbook-global, so cross-sheet
    edges live in the same graph).
- Deps are extracted **statically from the AST** (`collectStaticDeps`),
  resolving `NameExpr` / named-LAMBDA calls through the names registry
  (so `=SUM(MYRANGE)` registers a range dep on the bound range; this is
  the TS twin of the Rust B-4 fix). Extraction is installed (replace
  semantics) whenever a formula is evaluated:
  - the anchor derive run, and
  - every formula cell the trampoline visits transitively
    (`EvalContext.onFormulaEvaluated`, fired at trampoline cache-fill
    and in `resolveCell`) — the TS twin of Rust's hydrate-on-read
    cascade. This is what makes never-host-read formulas correct BFS
    conduits (`C=…B…`, `B=…A1…`: C's first eval visits B and installs
    B's edges, so a later `A1` write reaches C).
  - Re-installation is skipped when the AST object identity and the
    names-registry revision are unchanged — O(1) per repeat visit.
- On a value-affecting write, the workbook runs a **dirty BFS** from
  the written keys (dependents-of each key via point + range indexes,
  transitively through dependent formulas' own cells; `broadDependents`
  seeded once), then bumps the epoch atom of every dirty formula that
  has a cached atom. vanilla/core's normal flush then re-derives
  exactly those — listeners on formula atoms keep firing exactly as
  before. Re-eval count == true dependent count (pinned).
- Eager-at-mutation semantics are preserved (dependents re-derive
  synchronously inside the mutator, probe auto-recovers to `'clean'`),
  so the pinned TS-vs-Rust probe divergence notes in
  `solid/excel/test/excel-core-ts-debug-probes.test.ts` stay accurate.
- The probe's clean/dirty check no longer compares a global revision
  stamp (a non-dependent formula keeps its valid cache and stays
  `'clean'` after an unrelated write — same observable result as
  before, where it was re-derived to clean; never-evaluated formulas
  still report `'dirty'`).

**Registry-driven invalidation stays explicit and broad** (C-3
adjacent, unchanged by design): `defineName` / `undefineName` /
`registerCustomFormula` / `unregisterCustomFormula` / `setLocale` /
`recalc()` invalidate ALL cached formulas (bump every cached epoch
atom) and bump the names revision so the next eval of every formula
re-extracts deps against the new registry. `withBatch` coalescing and
the C-5 rollback contract are untouched.

### C-1 — mutate-in-place storage + per-sheet revision atom

With key-granular signals, the whole-Map clone no longer carries any
information. Chosen storage shape (over row-band shards — simpler, and
nothing needs band granularity once the change signal is decoupled):

- Each sheet owns ONE live `Map<CellKey, Cell>` for its whole lifetime;
  `sheetAtom` holds that same map forever (reads via
  `store.getter(sheetAtom)` are unchanged). Mutators write into it
  in place — O(changed cells) per edit, zero clones.
- A new per-sheet **`revisionAtom: AtomEntity<number>`** (additive on
  `WorkbookSheet`) bumps once per mutation batch (and once per
  registry-driven recalc pass). It is the subscription point for
  "this sheet changed" consumers (the old `sub(sheetAtom)` signal).

#### Consumer-of-identity audit

Every consumer of the old "fresh Map identity per write" signal, and
what it gets now:

| consumer | old signal | new signal |
|---|---|---|
| formula derives (`get(sheetAtom)` in `sheet.ts`) | new Map identity per write → flush re-derived all | per-formula `epochAtom` bump, only for true dependents |
| cross-sheet derives (`crossSheetCells(name, get)` registering a dep on the foreign `sheetAtom`) | foreign Map identity | cross-sheet edges in the workbook `DepGraph` (resolver no longer registers a core dep; `get` param kept for API compat) |
| `recalculateAllSheets` / `recalc()` clone-to-invalidate idiom (`workbook.ts`) | `new Map(prev)` per sheet | explicit bump of every cached epoch atom + `revisionAtom` bump per sheet |
| `wb.store.sub(sheet.sheetAtom, …)` (engine tests `workbook.test.ts` / `locale.test.ts` batch-coalescing pins) | publish on identity change | `wb.store.sub(sheet.revisionAtom, …)` — same fire counts (tests updated) |
| worker runtime projections (`worker-runtime-ts.ts` `snapshotRangeSparse` / `readSparseRange` / `collectSpillTargets` / `readCellValue`) | none — they `store.getter(sheetAtom)` per call (identity-insensitive) and re-read live state per chunk | unchanged; refresh signal stays the RPC-level `isMutatingCommand` dirty event |
| `rebuildPreservingCells` (`worker-runtime-ts.ts:1683`) snapshot of the previous workbook's maps | live map reference of a discarded workbook | unchanged (the old workbook is never mutated again) |
| debug `cellsProvider` (probe support) | `store.getter` content read | unchanged |
| `applyCell` exported helper | returned a fresh Map for `setter(sheetAtom, …)` | kept as an immutable utility for external callers, no longer used internally; doc updated (writing a foreign map into `sheetAtom` was never a supported invalidation path post-change) |
| persistence (`snapshotPersistenceV1` / sessions) | per-chunk live reads | unchanged (sessions never captured a map identity) |

`Object.freeze` in the store's dev path freezes the Map object, not its
internal entries — in-place `Map.set/delete` is unaffected.

### C-6 — eviction on overwrite / clear

The dep graph gives the bookkeeping point. When a write removes a
formula (formula → literal, formula → blank, cleared):

- the formula's installed edges are uninstalled from the graph
  (point + range + broad — same shape as Rust
  `remove_formula_record`),
- its cached atom (if any) gets one final epoch bump — the derive
  re-runs, returns the literal/blank, publishes to listeners — and is
  then **evicted**: `formulaAtomCache` / epoch atom / eval-stamp
  entries are deleted. Since the atom's only core dep was its own
  (now-dropped) epoch atom, all store-side state lives in WeakMaps
  keyed by the dropped objects and is GC-reclaimable — no
  `store.evict()` core API needed.
- Formula → formula overwrite uninstalls the stale edges; the new
  AST's edges install lazily on the next eval (written keys always
  bump their own cached atom, so a cached formula re-installs
  immediately).

Caveat (documented contract): a host subscription taken on a formula
atom whose cell is later overwritten to a NON-formula receives the
final literal publish and is then orphaned; re-subscribe via
`formulaCellAtom(key)` after such an overwrite. No production code
subscribes per-cell today (the TS worker runtime's `subscribeCells`
is an ack-only stub).

## What stays the same

- `vanilla/core` — zero changes.
- Public engine API — `setCell` / `setCellValue` / `clearCell` /
  `bulkApply` / `setFormat` / `recalc` / names / custom formulas /
  `withBatch` signatures and semantics; `SheetState` stays
  `ReadonlyMap<CellKey, Cell>`.
- `bulkApply` remains one storage pass; the dirty BFS short-circuits
  when the dep graph is empty, so fresh bulk import pays ~nothing
  (Mega 1M bulkWrite pinned unchanged).
- F9 / registry invalidation breadth, spill projection (anchor-derived,
  no engine spill atoms), cross-sheet formula values, `withBatch`
  abort rollback — all pinned by the existing suites.
- `setFormat` / format-only clears do not dirty formulas (formulas
  cannot read formats in this engine); they bump `revisionAtom` only.

## Results (measured, Apple Silicon, jest — see audit doc § C for pins)

| pin | before | after |
|---|---|---|
| one `setCell` @ 1M cells (C-1) | 107.6 ms | **< 0.1 ms** (pinned < 2 ms) |
| one unrelated `setCell` @ 100k cached formulas (C-2) | 503 ms / 100 000 re-evals | **< 1 ms / 0 re-evals** (pinned < 10 ms; re-evals == dependent count) |
| `setCell` after 10k formulas overwritten to literals (C-6) | 16–17 ms (~40× baseline) | **≈ baseline** (orphan walk gone + atoms evicted) |
| Mega 1M `bulkApply` | ~506–785 ms | unchanged |
