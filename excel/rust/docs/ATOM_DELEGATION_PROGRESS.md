# Atom-Delegation Rewrite - Progress Snapshot

> Living status for the atom-delegation rewrite. Binding invariants and phase
> gates are in
> [`ATOM_DELEGATION_REWRITE_PLAN.md`](./ATOM_DELEGATION_REWRITE_PLAN.md); the
> production paths are described in
> [`ATOM_DELEGATION_MAINLINE.md`](./ATOM_DELEGATION_MAINLINE.md).
>
> Snapshot date: 2026-07-10. P7 is complete and its local release gates have
> passed.

## Current Position

Formula state is derived through one workbook-scoped `einfach_core::Store`:

```text
cell facade -> formula-inner derived atom -> AtomFormulaProvider
            -> ReadArgs::get/depend -> shared Store dependency graph
```

This path is identical for local and qualified-sheet references. Workbook
context changes are Store roots too: topology, defined names, and the custom
function registry each publish through a version atom. There is no workbook
formula cache or address-level dependency fanout alongside Store.

| Phase | Content | State |
|---|---|---|
| P0 | Workplan, tripwire, fixtures, baselines, WASM snapshot | done |
| P1 | Faithful `excel/rust/core` Store rewrite | done |
| P2 | `AtomFamily` core primitive | done |
| P3 | Workbook-global shared Store handle | done |
| P4 | Point formulas delegated to Store | done |
| P5 | Range formulas and spill candidate discovery delegated to Store | done |
| P6 | Workbook formulas delegated to Store; all bridges deleted | done |
| P7 | Probe convergence, release gate, and performance record | done |

## P7 Exit State

### Formula Authority

- Every formula facade reads `formula_inner_of(addr)` with `ReadArgs::get`.
- `AtomFormulaProvider` resolves local and cross-sheet cells through the target
  sheet's facade in the same `ReadArgs` frame.
- Local and cross-sheet ranges use the same member-facade and geometry-root
  strategy.
- `lookup_named` and `call_custom` depend on workbook version roots before
  reading their current values.
- `WorkbookEvalProvider` remains for non-cell/top-level evaluator surfaces and
  compatibility helpers. It is not formula-cell cache or dependency authority.
- `FormulaRecord` retains expression/structural metadata plus an embedded
  static-cycle validation stamp. It contains no formula value cache or
  reactive freshness state.

### Workbook Scope

`Workbook::new` creates one Store and one `WorkbookAtomContext`. Every sheet is
attached to that context with its workbook index. Topology synchronization
publishes `(sheet name, FacadeCtx)` entries through a Store epoch, so add,
remove, rename, and move operations invalidate formulas that resolved workbook
structure.

Runtime cycle tracking is workbook-global and keyed by `(sheet index,
CellAddress)`. A recursive facade read records the Store dependency with
`ReadArgs::depend` and returns `#CYCLE!` before Store's hard computing guard is
reached.

### Ranges And Spills

There is no exact-range or address-to-formula reverse index.

- Tier A ranges of at most 256 cells read every member facade.
- Larger ranges depend on lazy `(column, row-band)`, column, or sheet geometry
  atoms, bounded by 4096 roots before moving to the next tier.
- Value enumeration remains sparse; empty Tier A cells are read only to record
  dependencies.
- Spill installation remains explicit structural work because derived reads
  are pure.
- Spill candidates are found from `Store::reverse_dependents` and mapped back
  through `formula_inner_family`.
- The anchor projection atom exposes the installed array or `#SPILL!`; the
  formula-inner remains the formula/dependency authority.

### Mutation And Bulk Install

Normal writes update storage and Store roots inside a Store batch. Materialized
dependents settle through Store propagation; never-read formulas remain lazy.
Structural edits use the same batch boundary for retargeting, slot/geometry
publication, and family cleanup, so one user mutation settles through one Store
propagation wave.

Whole-workbook storage-primary install uses one outer shared-Store batch for
all sheets. Retired atom IDs are collected during map replacement and destroyed
only after the batch flush, when old cross-sheet dependencies have detached.
This both deduplicates downstream publication and avoids destroying an atom
still referenced by another sheet during the transaction.

### Cycles And Lifecycle

- Install-time cycle checks walk retained formula AST/source content on demand.
  This covers unread formulas whose Store edges do not exist yet without
  retaining a reverse dependency graph.
- Parked hydration amortizes that walk with per-formula `cycle_checked_at`
  stamps under one formula-topology generation. An uncertified read builds a
  temporary reachable graph, runs iterative SCC validation, stamps acyclic
  entries, and drops the graph before evaluation. Formula topology mutations
  invalidate all stamps in O(1) by advancing the generation.
- Runtime cycles use the local/workbook in-flight guard described above.
- Formula/facade/range families evict their keys on clear, replacement, bulk
  install, and structural operations; sheet-owned atom counts are decremented
  with destruction.

## Removed At P6/P7

The following parallel paths are gone rather than renamed:

- `FormulaCache`
- `CrossSheetDeps` and `WorkbookRangeBridgeIndex`
- workbook dirty BFS and dependency-driven manual formula fanout
- `mark_dirty_for_addr`, `has_cross_sheet_refs`, and provider-context latches
- `force_formula_recompute` and prewarm bypasses
- retained point/range reverse dependency maps
- all `BRIDGE(delete-by: ...)` markers

`architecture_invariants` runs at `PHASE = 7`. It bans these identifiers and
common address-to-dependent collection shapes. Positive guards require the
shared workbook context, facade/formula-inner path, cross-sheet facade/range
reads, workbook version roots, scalable range roots, Store reverse-dependency
discovery, direct worker debug delegation, and the embedded static-cycle
generation/stamp wiring.

## Debug Semantics

- `debug_formula_cache_state` projects lazy/materialized Store freshness; it
  does not inspect a separate cache.
- legacy point-dependency and workbook-BFS counters remain zero for wire/test
  compatibility.
- `debug_range_dep_count` counts materialized Store geometry roots.
- formula evaluation counters increment only after a completed formula-inner
  evaluation; faulted deep-read passes do not count or invoke host callbacks.
- `content_revision` remains the coarse host signal for whole-sheet installs,
  not a formula invalidation mechanism.
- the TypeScript worker's `debugFormulaCacheState` directly delegates to
  `state.workbook.debugFormulaCacheState(...)`; it has no local read/dirty
  shadow state.

## Validation

Completed for the P7 release gate:

- full `excel/rust/core` test suite: green;
- full five-seed golden replay: green, including seed 11's spill collision;
- architecture invariants: green at P7 (`10` passed, `1` ignored);
- scale suites, including the 100,000-link chain and 200,000-cell
  storage-primary residue checks: green;
- WASM native suite: green (`31` passed, `1` ignored);
- real Chrome 149 WASM suite: green (`1` library test plus `13` browser tests)
  through the wasm-bindgen runner with a matching ChromeDriver; the direct
  `wasm-pack` command selected a stale cached 150 driver and is covered by the
  documented `excel/rust/wasm/README.md` cache-mismatch workaround;
- storage-primary install suite: green (`17` passed), including one-wave
  multi-sheet replacement and zero install-time formula parsing;
- Solid Excel Jest suite: green (`59` suites, `882` tests; `1` suite and `6`
  tests skipped), its standalone TypeScript check is green, and P7's Chain100k
  plus Tiny/Medium/Large observation runs are green.

Seed 11, operation 244 installs `=SEQUENCE(2,2)` over an occupied spill target.
The retired workbook bypass returned a raw array while the Sheet facade returned
`#SPILL!`. The unified Store path returns `#SPILL!` from both surfaces; the
fixture and focused regression now pin that one-authority result.

## P7 Record

The P7 release baseline recorded a 20,000-link chain hydration at
`10,037.259 ms`. The cold-hydration follow-up records bulk load at `36.772 ms`,
hydration at `55.701 ms`, and head write/flush at `50.301 ms`, with exactly
`19,999` static-cycle node visits instead of the baseline shape's approximate
`199,990,000`. RSS delta was `81,084,416 B` (`4,054.4 B` per materialized
formula).

The old cost came from repeating almost the whole upstream walk for each cell.
Each `HashSet::insert` pays the default keyed hash (a SipHash-family path in the
measured toolchain), probe/equality work, and occasional capacity-growth
rehashing. Geometric rehashing is amortized O(1), so these are large constant
factors on nearly 200 million visits, not the source of the quadratic shape.
The fix removes repeated walks; it does not substitute a faster hasher or retain
a side dependency graph.

The other P7 observations remain unchanged: a 20,000-way fanout flushed in
`51.450 ms`; a 200,000-cell storm took `4.830 us/edit` for mounted and
`1.160 us/edit` for parked writes. These are non-gating measurements; they
neither claim a separate cache nor relax the Store-only architecture.

## Guardrail

Do not add a Sheet or Workbook address-to-formula index to recover behavior.
Formula values, staleness, and transitive propagation must remain derivations of
atomm/Store state. A failing fence requires a workplan decision request, not a
shadow state system.
