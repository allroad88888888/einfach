# Atom-Delegation Rewrite - Current Main-Line Logic

> Production behavior at P7 completion. Formula cells on every sheet derive
> through one workbook-scoped atomm/Store graph.
>
> Snapshot date: 2026-07-10. Names are authoritative; line numbers drift.

## Main Shape

```text
Workbook::get_cell
  -> Sheet::peek_value_with_provider
  -> stable address facade
  -> formula-inner derived atom
  -> AtomFormulaProvider(ReadArgs)
  -> local or target-sheet facade / workbook version root
  -> Store dependency graph
```

```text
point dependency       ReadArgs::get(referenced facade)
range dependency       member facades or band/column/sheet roots
workbook topology      topology version atom + sheet FacadeCtx lookup
defined names          names version atom + current name map
custom functions       registry version atom + guarded host call
subscriptions          stable address facade
spill candidates       Store::reverse_dependents -> formula_inner_family
```

The Store graph is the only reactive dependency graph. Formula AST/source,
static range metadata, and cycle-validation generation stamps are content used
for parsing, retargeting, cycle checks, and diagnostics; they do not drive
invalidation fanout.

## Formula Read Path

`Sheet::peek_value_with_provider` hydrates a parked formula, obtains the stable
address facade, and reads it from Store. The passed provider does not override a
formula cell's value.

The facade closure:

```text
depend on slot_epoch(addr)
if formula:
    value = args.get(formula_inner_of(addr))
    if an active spill projection atom exists:
        return args.get(spill_anchor_atom)
    return value
if primitive atom: return args.get(atom)
if plain primitive: return cloned value
return Null
```

`formula_inner_of(addr)` is a lazy derived atom. On a completed read it:

1. resolves the hydrated AST or parses parked source;
2. enters the local or workbook-global in-flight guard;
3. evaluates with `AtomFormulaProvider` and the current `ReadArgs`;
4. replaces its Store dependency set with the cells/roots actually read;
5. increments the completed formula-evaluation counter.

No `FormulaCache` is consulted before or after this path.

## Workbook Scope

`Workbook::new` creates one Store and a `WorkbookAtomContext`. Every sheet uses
that Store and is attached to the context with its current workbook index.

For a qualified point reference, `AtomFormulaProvider::sheet_cell` resolves the
target sheet from the topology root and calls `ReadArgs::get` on the target
facade. A local and cross-sheet edge are therefore the same Store mechanism.

Topology, names, and custom functions are mutable non-cell inputs. Each owns a
lazy version atom:

- add/remove/rename/move sheet publishes the topology root;
- define/undefine name publishes the names root;
- replacing the custom registry publishes the custom root.

Formula reads depend on the relevant root before consulting current data.
`WorkbookEvalProvider` remains for top-level evaluator APIs and compatibility
helpers, but it is not formula-cell state or invalidation authority.

## Range Read Path

Range evaluation is sparse for values and complete for dependencies.

For a normalized range of at most 256 cells, the provider reads every member
facade. Empty members establish edges but are not emitted to evaluator
callbacks.

Larger ranges depend on lazy geometry roots:

1. `(column, row / 256)` roots when at most 4096 bands are covered;
2. per-column roots when band mode is too wide but at most 4096 columns are
   covered;
3. one sheet root otherwise.

The provider then emits currently materialized non-Null members. Local and
cross-sheet ranges call the same `for_each_range_in` implementation with the
appropriate `FacadeCtx`. No exact-range or dependent-formula index exists.

Membership-changing writes bump already-materialized geometry roots touching
the address. Pure value changes propagate through the member facade. A Store
batch deduplicates formulas reached from more than one root.

## Write Path

Mutation paths update worksheet storage and publish Store state:

- primitive value changes publish their atom/facade;
- formula content changes invalidate formula-inner and bump slot/facade state;
- inner-slot identity changes bump `slot_epoch(addr)`;
- range membership changes bump existing geometry roots;
- topology/name/custom changes publish their workbook roots;
- structural moves update source/AST metadata and invalidate affected atoms in
  the same Store batch as slot and geometry publication.

Materialized dependents re-derive in Store's flush. Never-read formulas have no
formula-inner atom and remain lazy. There is no Sheet or Workbook dirty BFS.

## Bulk Replacement

`install_sheet_bulk` and `install_workbook_bulk` replace pre-built sparse maps
without parsing or evaluating every formula. Formula hydration and dependency
discovery remain lazy.

Whole-workbook install has two phases:

1. replace every requested sheet inside one outer shared-Store batch, collecting
   retired atom IDs;
2. after Store flush detaches old cross-sheet edges, prune family keys and
   destroy the retired atoms.

This produces one settled propagation wave across sheets and avoids destroying
an atom while another sheet still has a committed Store dependency on it.
`content_revision` is bumped as a host-facing whole-content signal; it is not a
formula cache epoch. `BulkInstallStats::cross_sheet_parsed` remains in the wire
shape for compatibility but is always zero: local and cross-sheet formula
sources are parked without install-time parsing and materialize through Store.

## Dynamic Arrays

Derived reads cannot mutate worksheet storage, so spill installation/teardown
is explicit structural maintenance. Candidate discovery still starts in Store:

1. collect touched cell/facade and existing geometry-root atoms;
2. call `Store::reverse_dependents`;
3. map derived IDs through `formula_inner_family` to formula addresses;
4. retain array-capable formulas and existing anchors;
5. install or clear spill projections.

The anchor projection atom contains the installed `Value::Array` or
`Value::Error(Spill)`. The facade depends on formula-inner first and projection
second, so `#SPILL!` is the public result while formula-inner remains dependency
authority. Workbook reads cannot bypass that projection.

## Subscriptions

Address subscriptions attach to stable facades. Primitive/formula swaps keep
the same listener identity, and Store equality pruning publishes at most once
when the displayed value changes. Full-sheet replacement may issue its explicit
coarse host notification, but cross-sheet formula propagation has no manual
dependency fanout.

## Cycles

Formula installation and hydration reject static cycles from AST/source content.
This is required for unread formulas, whose Store edges are intentionally
absent. Normal single-formula installation keeps the direct content walk.

Parked formulas amortize cold hydration with an embedded `cycle_checked_at`
stamp and a sheet formula-topology generation. The first uncertified parked
read builds a temporary forward graph for the reachable formula content, runs
an iterative SCC pass, and stamps the acyclic entries it proved. Formula
topology mutation increments the generation, invalidating every old proof in
O(1); parked-to-hydrated conversion preserves the stamp because it does not
change formula content.

The temporary address table and edges are dropped when validation returns.
They are never consulted by Store evaluation, writes, invalidation, or
propagation, and are not retained as an address-to-dependent graph.

At runtime, `AtomFormulaProvider` checks an in-flight set before reading a
facade. Workbook entries are keyed by `(sheet index, address)`. On recursion it
records the facade with `ReadArgs::depend` and returns `#CYCLE!`, preserving the
edge needed to recover after an edit without triggering Store's hard
computing-atom panic.

## Lifecycle And Debug

Formula, facade, primitive, spill, and range-root families are pruned on clear,
replacement, bulk install, sheet removal, and structural edits. Debug atom
counts are sheet-owned lenses over the shared Store.

`debug_formula_cache_state` reports parked/freshness state projected from Store;
legacy dependency/BFS counters remain zero for compatibility. The TypeScript
worker's `debugFormulaCacheState` directly calls
`state.workbook.debugFormulaCacheState(...)`; it does not keep read/dirty debug
state of its own. Architecture tests at `PHASE = 7` ban all retired bridge/cache
identifiers and the worker shadow names, while requiring shared Store wiring for
formula, range, topology, names, custom-function reads, debug delegation, and
the embedded static-cycle validation wiring described above.

The architectural rule is stronger than behavioral equivalence: formula truth,
staleness, and transitive propagation must derive from atomm/Store state. A
passing test suite does not permit a shadow dependency engine.
