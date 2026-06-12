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
