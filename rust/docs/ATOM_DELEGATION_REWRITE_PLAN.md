# Atom-Delegation Rewrite — WORKPLAN & Constitution

> **Current phase: P7 complete.**
>
> P4 moved point formulas to facade/formula-inner derived atoms. P5 replaced
> retained range fanout with bounded Store geometry roots. P6 moved local and
> cross-sheet formula reads onto the same workbook-scoped Store graph and
> deleted all bridge/cache/BFS paths. Install-time cycles validate formula
> AST/source content on demand (required for unread formulas); parked hydration
> amortizes that work with generation-stamped temporary SCC proofs. Runtime
> cycles use a workbook-global `(sheet, address)` in-flight guard before `args.get`.
> Topology, names, and custom-function registry changes are Store version roots.
> `architecture_invariants.rs` is at `PHASE = 7` and includes positive Store and
> static-cycle wiring checks, retired-name bans, and a worker-debug delegation
> tripwire.
>
> Seed 11's spill oracle is resolved: Sheet and Workbook both expose `#SPILL!`
> from the same facade projection. The historical raw-array result was a removed
> `force_formula_recompute` bypass, not a second formula result to preserve.
>
> Successor agents: read this file FIRST, then the latest `SESSION_HANDOFF_*.md`,
> then run the quick-verify block (§8). `rust/excel-core/tests/architecture_invariants.rs`
> enforces §2 mechanically — if it fails, you are off the main direction. Stop and read §6.

## 1. North star (owner's ruling — NOT open for re-litigation)

The einfach state mechanism is the owner's hand-written `vanilla/core` store
(pull-validate + dep-value-snapshot invalidation + pendingMap/flushPending
change-pruned re-derive). The Rust side was always meant to be a faithful copy
of THIS mechanism. It drifted: `rust/core` became eager-push + topo-sort;
`rust/excel-core` bypassed the store's derived mechanism entirely and grew
~1,600 lines of parallel address-level dep graph.

The fixed direction:

1. **`rust/core` Store = function-per-function port of `vanilla/core/src/store.ts`.**
   Iterative implementations of the recursive semantics are allowed (work
   stacks, NeedsDep faulting, settled-memo); semantic deviation is not.
2. **`rust/excel-core` = pure atom delegation.** Formula cells are derived
   atoms; every reactive edge lives in the Store; per-cell atoms come from a
   lazy `AtomFamily` (create-on-use — the owner's getAtomFamily pattern).
   The parallel graph machinery is deleted, not wrapped.
3. The historical "pure delegation failed at scale" evidence (TS C-1/C-2)
   was an artifact of the one-big-sheetAtom design mistake, not of atom
   delegation. Per-cell family + laziness is the corrective. **Empirically
   confirmed** (`vanilla/core/test/atom-family-spike.test.ts`, on the real
   vanilla/core store, 2026-07-08): C-1 — family single-cell write is flat
   1.2→1.8 µs at 10k→1M cells vs sheetAtom's O(N) 394 µs→118 ms (~65,000× at
   1M); C-2 — one unrelated write re-evaluates exactly 1 derive (84.7 µs) vs
   exactly 100,000 (297.5 ms) with 100k mounted derives (count-asserted).
   Corollaries that shape this arc: recursion blows the JS stack at
   ≈2,750–3,500 chain links on BOTH read and write paths (the iterative
   store / NeedsDep requirement is load-bearing, not optional); memory is
   ~350 B per materialized atom (laziness + eviction mandatory — 1M-cell
   import + 50×27 window read materializes exactly 1,350 atoms).
4. **No perf red line for this arc.** Correct mechanism first; measure after
   and record the numbers here (§7). Perf walls do NOT authorize architecture
   deviations (§6).
5. TS engine (`vanilla/excel-core-ts`) is NOT the architectural reference —
   it drifted too (own DepGraph + epoch atoms). Parity with it is at
   observable-behavior level only. A follow-up arc will bring it back to
   pure family delegation.

Full approved plan: `/Users/dol/.claude/plans/federated-mapping-crab.md`
(owner-approved 2026-07-07).

## 2. Invariants (the constitution)

| ID | Invariant |
|---|---|
| INV-1 | `rust/core/src/store.rs` is function-per-function isomorphic to `vanilla/core/src/store.ts` (`read_atom`↔`readAtom`, `set_atom`, `write_atom_state`, `set_atom_state`, `dependencies_change`, `flush_pending`, `publish_atom`, `subscribe_atom`, `clear_dependencies`, `clear`). Permitted mechanical deviations ONLY: iterative work stacks, NeedsDep scratch-commit, settled-memo, ownership plumbing, no async values. Everything else carries `// DIVERGENCE(store.ts): <reason>` and a row in §5. |
| INV-2 | The only edges that decide *what recomputes when something changes* are the Store's dependency maps. In `rust/excel-core`, no map keyed by cell address whose values name dependent formula cells may exist. Allowlist: range-family-internal geometric coverage (addr → range key / band atom only), spill `claims` (addr → anchor ownership, not a dep), `cell_subscriptions`, `formula_source`/`needs_parse` (parse laziness, not deps). |
| INV-3 | Bulk import materializes 0 atoms and evaluates 0 formulas, at any size. |
| INV-4 | `WasmSheet`/`WasmWorkbook` exported names + signatures frozen (additive debug probes allowed). `worker-protocol.ts` wire shapes frozen. |
| INV-5 | Every landed commit is green on its tier fences. Fence-expectation edits land in the same commit as the semantic change, with closed-form justification in the commit message and a row in §4. |
| INV-6 | `eval.rs` / `formula.rs` / `format.rs` / `undo.rs` / `csv.rs`: resolver-interface seam changes only. |
| INV-7 | Laziness contract: never-read formulas are never materialized or evaluated by writes. Once-read formulas re-derive eagerly on upstream change, with change pruning (owner-approved semantic shift, converges with vanilla/TS semantics). |
| INV-8 | No permanent dual path. Transitional code carries `// BRIDGE(delete-by: P<n>-exit)`; zero BRIDGE markers may survive P6 exit. |

## 3. Phases & exit gates

| Phase | Content | Exit gate (all must hold) |
|---|---|---|
| **P0** | WORKPLAN (this file); tripwire test; golden fixtures + replay; baselines; WASM signature snapshot | all tiers green · tripwire green (baseline mode) · fixtures committed · codex review of INV list |
| P1 | Store rewrite (4 mechanisms: generation snapshots D1, NeedsDep scratch-commit D2, settled-memo, reentrancy-safe publish) + vanilla twin tests + BRIDGE shims | twin suite green · excel-core green with ≤ single-digit documented expectation edits · full matrix green |
| P2 | `AtomFamily` core primitive | all green, zero changes outside rust/core |
| P3 | Workbook-global single store (`Rc<RefCell<Store>>` handles, D7) | observably inert: zero assertion changes |
| P4 | Point deps → pure atoms (cellAtomFamily, facade/inner, formula derived atoms); delete `cell_dependents` + point BFS; temp epoch BRIDGE for ranges/cross-sheet | re-derived fence batch 1 (S1/S2/S11, probes, wasm native) · tripwire forbids point-graph names · e2e dual Δ=0 · playwright MCP UI smoke |
| P5 | Two-tier ranges (Tier A per-member ≤~64–256 cells; Tier B band version atoms) + delete `RangeDependentIndex` (D4 codex-first) | fence batch 2 (S3/S4/S7/S12) · tripwire forbids range-index names · `debug_range_dep_count` re-pointed (wire name kept) |
| P6 | Cross-sheet via shared Store facades/formula-inner atoms; topology/name/custom version roots; install-time on-demand AST cycle walk + runtime workbook in-flight guard; delete `CrossSheetDeps`/latch/`force_formula_recompute`/prewarm/all BRIDGEs/P1 shims | fence batch 3 (S6, cross_sheet*, workbook inline pins dispositioned in §4) · `chain_100000` native + browser fences · tripwire final mode |
| P7 | Probe convergence flip (D6), BACKEND_PARITY §debug rewrite, full release gate, perf measurement (§7), final handoff | dual e2e re-audit Δ=0 · §7 numbers recorded · D1–D7 closed |

## 4. Counter / fence re-derivation ledger

Rules: (a) keep the closed-form identity, restate under the new cost model;
(b) each rewritten assertion cites its derivation in a doc comment;
(c) rows here are approved by the owner BEFORE the code lands — counters are
re-derived by decision, never "adjusted until green"; (d) never widen an
equality to an inequality without owner approval.

Counter fate (agreed in the approved plan):

| Old | Fate |
|---|---|
| `debug_formula_eval_count` | keep — bumps only on COMPLETED formula read_fn runs |
| `debug_range_visit_count` | keep (eval.rs sparse iterator untouched) |
| `debug_materialized_cell_atom_count` | keep — == cellAtomFamily len |
| `debug_total_atom_count`, spill counters, `Store::debug_recompute_count` | keep |
| `debug_dirty_visit_count` | dies with `mark_dependents_dirty` → `Store::debug_flush_visit_count` (one bump per back-dep re-read attempt in `dependencies_change`) |
| `debug_dirty_count` | → `debug_unmaterialized_formula_atom_count` |
| `debug_dep_graph_stats` / `debug_cell_dependents_key_count` | → `Store::debug_dependency_edge_count` + family lenses |
| `debug_range_dep_count` | → range family len (wire name preserved) |

Per-shape rows (S1–S12, probes, wasm native, workbook inline pins) are added
here at P4/P5/P6, one table per batch, before the corresponding code lands.

P1 note for future closed forms: `debug_flush_visit_count` identities carry a
second-round revalidation term — flushPending drains the re-derived atoms in
round 2 and each walk revalidates (then prunes) its dependents. A hydrated
N-chain head edit is therefore visits == 2N−1 (N re-derives + N−1 pruned
revalidations), evals == N. Pinned by
`chain_100k_head_write_flush_is_iterative_and_linear`.

### P4 batch #1 — point-dep flip (owner sign-off required BEFORE code)

Semantic basis (owner-approved in the plan): once-read (materialized)
formulas re-derive EAGERLY during the write's flush; never-read formulas
have no atom and stay lazy ('dirty'). Work moves write-ward; totals conserve.

| Fence | Old pin | New pin | Why |
|---|---|---|---|
| S1 chain (hydration) | evals == N−1 on first read sweep | unchanged | hydration/parse laziness untouched |
| S1 chain (head edit) | dirty_visit delta == N−1 at set; re-read evals == N−1 | eval delta == N−1 **during set_cell** (flush re-derive); post-edit read sweep == 0 evals; flush_visit delta == 2(N−1)−1 (re-derive + pruned revalidation rounds) | dirty flags → eager re-derive |
| S1 second sweep | 0 evals | unchanged | cache |
| S2 fanout (head edit) | dirty visits == N; re-read evals == N | eval delta == N during set; reads after == 0; unrelated write == 0 (flush_visit == 0) | same conservation |
| S2 `debug_dirty_count` | == N post-edit | REPLACED by `debug_unmaterialized_formula_atom_count` where the pin's intent is laziness; == 0 where intent was "pending work" (none remains after eager flush) | counter dies with dirty flags |
| S11 storm (materialized region) | total dirty visits == STORM_EDITS; sweep evals == distinct rows | recompute delta == STORM_EDITS at set-time (fanout 1 per edit); verification sweep == 0 evals for materialized rows + 1 per parked row (first materialization) | eager work bounded by Σ materialized dependents |
| S11 parked edits | 0 dirty visits, 0 atoms | unchanged (0 recomputes, 0 atoms — family laziness) | INV-3/INV-7 |
| probes `debug_formula_cache_state` (once-read, upstream write) | 'dirty' until re-read | 'clean' immediately after set (eager re-derive) — CONVERGES with TS-core semantics; never-read stays 'dirty' | the approved semantic shift |
| `debug_formula_eval_count` | bump on read | bump at set-time for materialized dependents; still exactly one per formula per change | counter meaning unchanged (completed evals), timing moves |
| wasm native once-read fences (~8-12) | 'dirty' after mutate | 'clean' after mutate | same |
| golden replay | values only | UNTOUCHED (must stay green) | oracle |

_(S3/S4/S12 rows land with P5 batch #2; S6/cross-sheet with P6 batch #3.)_

### P5-P7 implementation and fence disposition (recorded 2026-07-10)

This table records the landed mechanism and observed closed forms. It does not
amend INV-1..INV-8 or authorize a parallel fallback.

| Fence | P7 pin | Derivation / disposition |
|---|---|---|
| S3/S4 range reads | Tier A reads each member facade; Tier B depends on bounded band/column/sheet roots | Store edges replace exact-range/address-to-formula fanout; sparse value enumeration is unchanged |
| range mutation | one Store batch; a materialized formula settles once even when reached by cell and geometry roots | settled-memo/equality pruning deduplicates roots in the same write sequence |
| S6 cross-sheet point/range | target sheet facade/root is read with the formula-inner's live `ReadArgs` | local and qualified refs are ordinary edges in the workbook Store |
| topology/name/custom changes | dependent formula-inner atoms read version roots and re-derive through Store | mutable workbook context is reactive input, not cache state |
| cross-sheet subscriber | exactly one publication when the displayed facade value changes | stable facade subscription + Store equality pruning; no workbook fanout |
| workbook bulk install | one outer Store batch for all sheets; retired atoms destroyed after flush; compatibility `cross_sheet_parsed == 0` | one propagation wave; cleanup waits until old cross-sheet edges detach; every formula source remains lazy regardless of `!`, names, or custom registry |
| structural edits | storage retargeting, slot/geometry publication, and family cleanup share one Store batch | a coherent mutation settles one Store propagation wave; no address-level dirty traversal is reintroduced |
| legacy workbook BFS probes | `0` | compatibility lens only; no retained workbook traversal exists |
| `chain_100000` native | green | hybrid NeedsDep read + iterative dependency propagation remains stack-safe |
| worker formula debug | direct `state.workbook.debugFormulaCacheState(...)` delegation | no worker-local read/dirty shadow state remains |
| golden replay | all five 2,000-operation seeds green | seed 11 uses the one-authority `#SPILL!` oracle; focused collision regression pins it |
| S1 cold hydration (parked chain, any first-read order) | `static_cycle_node_visits == N−1` across the full hydration sweep (closed form, asserted in `s1_chain_body`); hydration wall time joins head-write O(N) — release `10,037 ms → 55.7 ms` at N=20,000 (§7) | cold-hydration follow-up (§9 DECISION_REQUEST, CLEARED 2026-07-10): `closes_parked_local_cycle` certificates every proven-acyclic node of the walked cone via one iterative-SCC pass, so each formula AST is visited exactly once per formula-topology generation; later checks cut at the certified frontier (soundness: any cycle through a certified node contradicts that node's certificate) |
| `debug_static_cycle_node_visit_count` (new probe) | bumps once per node processed by the parked static cycle walk | additive `#[doc(hidden)]` diagnostic (INV-4 allows); certificate invalidation on topology mutation pinned by `parked_cycle_certificate_is_invalidated_by_topology_change`; hydration-time rejection semantics (`#CYCLE!` literal) unchanged — this row records a cost-model restatement, not a semantic shift |

## 5. Divergence ledger (store.ts → store.rs)

| # | store.ts behavior | Rust treatment | Why |
|---|---|---|---|
| DV-1 | Promise/continuable-promise machinery (`isPromiseLike` branches of setAtom/setAtomState/dependenciesChange, AbortController options) | structurally-marked no-ops with `// DIVERGENCE` comments | no async `Value` in the engine |
| DV-2 | `Object.is` reference snapshots | per-atom generation counters (gen equal ⟹ Object.is passes; ABA ⟹ one spurious re-derive absorbed by equality pruning) | Rust has no stable reference identity for cloned Values; generations are the honest translation (D1) |
| DV-3 | recursive readAtom / dependenciesChange | HYBRID (refined at P1): nested reads recurse natively up to `READ_RECURSION_BUDGET = 256` (vanilla-verbatim, correctly-typed getter returns for all hand-written atom graphs), past the budget the tracked getter FAULTS — records the needed dep, returns a `Value::Null` placeholder, the frame loop computes deps bottom-up iteratively and re-runs the read fn; scratch discarded on fault (committed deps intact, avoiding the store.ts:47-51 unconditional-fresh trap). Deep-chain read-fn contract: past-budget read fns must tolerate Null from the tracked getter (their output is discarded); the engine evaluator does naturally. `dependencies_change` is a plain explicit-stack DFS. | 1 MB WASM stack has no unwinding (catch_unwind unavailable), so the TS throw-NeedsDep sentinel cannot port directly; the hybrid keeps twin/UI fidelity AND stack safety (D2) |
| DV-4 | O(deps) snapshot validation per pending root | settled-memo (`write_seq`/`settled_at`) skip | pure memoization of a deterministic check; twin `settled_memo_bulk_write_into_shared_dependent` pins evals==1 / visits==N |
| DV-5 | `clear()` — vanilla atoms are external objects that survive clear and re-materialize from init | Rust atom definitions live in the store; clear() kills held AtomIds. C-7 protective intent (no ghost flushes) kept + twinned | no WeakMap/GC in Rust |
| DV-6 | implicit write-fn batching only | public `batch()` kept (explicit form of the same mechanics, engine uses it); write-side cycle guard panics (vanilla would infinite-loop); store-level cross-atom READ cycle panics (vanilla would stack-overflow; engine detects at evaluator level) | defensive hardening, observability unchanged for legal programs |
| DV-7 | `setter(atom, prev => next)` function-update sugar; `getDefaultStore`; `storeAtom` self-reference | not ported (JS-surface conveniences; `Value` carries no closures) | twins adapt call sites |

Additions require owner approval (§6).

## 6. Escalation rule (verbatim, binding)

If a phase hits a perf/scale/counter wall that pure atom delegation appears
unable to satisfy, the ONLY legal moves are:
(a) stop and file a DECISION_REQUEST in §9,
(b) codex peer review of the options,
(c) owner approval of either a counter re-derivation or an explicit INV amendment.
Introducing any address→formula index, cache, or shortcut structure without an
INV amendment is a P0 defect **even if all tests pass**.

Pre-approved mechanism-pure fallback ladders (using these does NOT require a
DECISION_REQUEST, only a note here):
- Range invalidation: band granularity → per-column version atoms → whole-sheet
  version atom. NEVER a side dependents index.
- settled-memo doubts: batch-size-gated vanilla-faithful quadratic validation.
- Spill reactor troubles: keep today's eager engine-side spill maintenance
  (public setters only), side indexes still collapse to `claims`.
- Cycle registry troubles: eager-install store-BFS rejection + sticky `#CYCLE!`
  flag cleared on epoch bump.
- Memory: aggressive facade eviction (family API, not engine graph).

## 7. Perf record (P7, 2026-07-10)

These are observation-only release measurements. They do not form a performance
red line and do not authorize a cache, an address-to-formula index, or any other
parallel formula state. Native timings are release binaries; RSS is process RSS
from `ps`, so it is a coarse allocation signal rather than a heap census.

| Native probe | Result |
|---|---|
| S1, 20,000-link chain (P7 exit baseline) | bulk load `35.871 ms`; hydration `10,037.259 ms`; head write/flush `55.766 ms`; `19,999` materialized formulas; `60,000` Store atoms; RSS delta `81,428,480 B` (`4,071.6 B` per materialized formula) |
| S1 cold-hydration follow-up | bulk load `36.772 ms`; hydration `55.701 ms`; head write/flush `50.301 ms`; exactly `19,999` static-cycle node visits; `19,999` materialized formulas; `60,000` Store atoms; RSS delta `81,084,416 B` (`4,054.4 B` per materialized formula) |
| S2, 20,000-way fanout | head write/flush `51.450 ms`; `20,000` Store reverse-dependency visits and `20,000` synchronous evaluations; `60,003` Store atoms |
| S11, 200,000 cells | `10,000` mounted edits in `48.300 ms` (`4.830 us/edit`); `2,000` parked edits in `2.320 ms` (`1.160 us/edit`); `10,000` materialized formulas and `240,000` Store atoms |

The baseline's ascending first-read order repeated each formula's full upstream
content walk, approximately `N(N-1)/2 = 199,990,000` formula-node visits. Each
visit included a `HashSet::insert`: the standard keyed hash path (a
SipHash-family implementation in the measured toolchain), table probing and
equality checks, plus occasional capacity-growth rehashing of existing entries.
Geometric rehashing is amortized O(1); it amplified the constant cost but did
not create the O(N^2) traversal shape.

The follow-up keeps a validation-generation stamp in each existing parked or
hydrated formula record. The first uncertified parked read builds a temporary
reachable formula graph, validates it with an iterative SCC pass, stamps the
acyclic records, and drops all temporary address/edge tables. Formula topology
mutation advances one generation and invalidates all old proofs in O(1).
Neither the stamps nor the temporary graph participate in value evaluation,
freshness, invalidation, or propagation; those remain atomm/Store derivations.

The `4,071.6 B` figure is an RSS delta divided by formula cells, not per-atom
heap overhead: S1 materializes multiple Store atoms and process allocator pages
per formula cell. It is recorded to track the materialized-cell cost requested
by the plan, not to claim the `~350 B` JavaScript atom-family microbenchmark is
a directly comparable Rust process measurement.

| Browser/WASM observation | Current P7 | Historical report marker | Comparison |
|---|---:|---:|---|
| Chain100k bulk install | `275.475 ms` | `275 ms` | essentially unchanged |
| Chain100k first tail read | `767.973 ms` | `82.9 ms` | slower; cold materialization completed `199,870` formula evaluations |
| Chain100k head mutation | `501.831 ms` | `136 ms` | slower; exactly `99,999` Store-derived evaluations, steady reread `0.0325 ms` and `0` evaluations |
| Medium bulk import | `20.322 ms` | `70.0 ms` | about `3.4x` faster |
| Large bulk import | `196.758 ms` | `707 ms` | about `3.6x` faster |
| Medium readback / recalc | `1,494.715 / 670.503 ms` | `553 / 440 ms` | slower (`~2.7x / ~1.5x`) |
| Large readback / recalc | `37,537.973 / 7,425.637 ms` | `7,621 / 5,476 ms` | slower (`~4.9x / ~1.4x`) |

The comparison uses a historical report generated in a different process/date;
it is directional only. Native cold-chain hydration is addressed by the
follow-up above; large browser readback remains a performance target while
retaining the Store-only formula authority. The current bulk-import improvement
and parked-edit laziness are evidence that no eager formula materialization was
introduced.

## 8. Quick-verify block

```bash
cd /Volumes/work/self/einfach
# tier greens (baseline counts recorded at P0 exit — see below)
cd rust/core && cargo test
cd ../excel-core && cargo test --lib
cargo test --tests
cargo test --test golden_replay -- --nocapture
cargo test --manifest-path ../wasm/Cargo.toml
# browser gate; see rust/wasm/README.md if wasm-pack has a stale ChromeDriver cache
wasm-pack test --headless --chrome ../wasm
cd ../.. && npx jest solid/excel --no-coverage
# tripwire
cd rust/excel-core && cargo test --test architecture_invariants
```

Baseline counts (P0, recorded 2026-07-07 at commit 208688d):
- rust/core: 65 passed / 0 ignored
- rust/excel-core `--lib`: 1404 passed / 3 ignored
- rust/excel-core integration (incl. new golden_replay + architecture_invariants): ~1825 passed / 12 ignored total across 65 test binaries, 0 failed
- rust/wasm native: 31 passed / 1 ignored (browser: 13 wasm-pack tests, run separately)
- full repo jest: 195 suites / 3795 tests passed (1 suite / 6 tests skipped)
- golden fixtures: 5 seeds × 2000 ops; per-seed survivors ≈ 59–90 formulas,
  46–83 error values, 8–18 spill arrays, 1–17 #CYCLE! sites

P7 final validation (2026-07-10): the full `rust/core`, `rust/excel-core`
library and integration suites, native WASM suite, architecture invariants, and
Solid Excel Jest suite all pass. All five golden seeds are green; architecture
invariants are `10/10` plus one generator ignored at `PHASE = 7`; S1/S2/S11
release probes, Chain100k, and the Tiny/Medium/Large WASM observations pass;
Solid Excel TypeScript no-emit is green. The Chrome 149 browser gate passes
with `1` library test plus `13` browser tests when the wasm-bindgen runner uses
a matching ChromeDriver. In this environment `wasm-pack` selected a stale
ChromeDriver 150 cache, so the equivalent runner invocation was used with the
cached ChromeDriver 149.0.7827.55; this is the documented cache-mismatch
workaround in `rust/wasm/README.md`.

## 9. Decision log

| ID | Decision | Status |
|---|---|---|
| D1 | Snapshot = generation counters; `Value::Array`/`Lambda` equality via `Rc::ptr_eq` fast path + `PartialEq` | **CLOSED** (P1 codex review: no holes) |
| D2 | NeedsDep scratch-commit + 256-deep recursion-budget hybrid (DV-3); counters bump on completed runs only | **CLOSED** (P1 codex review: no holes; unwind guards added per review) |
| D3 | Cycle semantics: install-time AST/source validation (parked hydration amortized by generation-stamped temporary SCC proofs) + runtime local/workbook in-flight guard that records a Store dep and returns `#CYCLE!` | **CLOSED** (P4 review F1/F2; P6 cross-sheet implementation; P7 cold-hydration follow-up) |
| D4 | Range tiers: Tier A per-member (256), Tier B band then column then sheet version atoms | **CLOSED** (P5 implementation; retained range fanout deleted) |
| D5 | Per-shape counter re-derivation tables (§4) | **CLOSED** (all fence batches landed with closed-form assertions) |
| D6 | worker-runtime-ts `'dirty'` override: delete after convergence (both engines assert `'clean'`) | **CLOSED** (P7: direct workbook debug delegation; tripwire bans shadow state) |
| D7 | Store ownership: shared `Store` handle; borrow windows never span eval re-entry | **CLOSED** (P3 ownership + P6 workbook context) |

_(DECISION_REQUESTs, if any, appended below.)_

### DECISION_REQUEST — P7 cold-chain hydration follow-up (filed 2026-07-10, GATE: codex + owner)

**Status:** CLEARED-TO-PROCEED (2026-07-10). Review identified the release
baseline's repeated static AST/source cycle walk as the quadratic cost, not
atomm/Store propagation. The owner required formula value, freshness, and
propagation to remain atomm-state derivations and then approved implementation.

The selected mechanism embeds only a static validation-generation stamp in the
existing formula record. An uncertified parked read constructs and discards a
temporary reachable graph after iterative SCC validation; any formula-topology
mutation invalidates prior stamps by incrementing one generation. The temporary
graph and stamps are never read by formula evaluation or Store propagation, so
this introduces no retained address-to-formula index and needs no INV amendment.

Focused cycle counterexamples, the exact-linear 20,000-link visit assertion,
the release observation, and architecture guards all pass. The measured cold
hydration changed from `10,037.259 ms` to `55.701 ms`, with `19,999` static
visits instead of the baseline shape's approximate `199,990,000`.

### DECISION_REQUEST — P4c point-dep flip (filed 2026-07-08, GATE: D3 codex + owner)

**Status:** CLEARED-TO-PROCEED (2026-07-08). Both gate conditions met: owner
approved fence batch #1 (§4 table, "批准,照表执行") AND the D3 codex review
completed with **no P0** — see "P4c codex review disposition" below, which
concludes "the flip proceeds autonomously with all six fixes folded in" (F1–F6).
The flip DELETES the point index and moves point propagation onto pure store
delegation; no INV amendment, no new parallel structure. Fence
batch #1 (§4 table) already owner-approved 2026-07-08 ("批准,照表执行"); this
request pins the *mechanism* the fence table measures, and satisfies D3
("环两层语义" codex review at P4). No INV amendment and no new parallel
structure is proposed — the flip DELETES the point index and moves point
propagation onto pure store delegation. Filed to honor the escalation rule's
"real decision point → codex → owner" ladder before writing code, not because
a wall was hit.

**What flips (one commit):**

1. **Formula cells become inner derived atoms.** `try_set_formula` builds the
   inner via `owned_create_derived_ctx` (LAZY door); read_fn holds `Rc<Expr>`
   and evals through an `AtomEvalProvider` whose *point* ref lookups resolve
   `facade_of(dep_addr)` and call `args.get(facade)` — a tracked store edge.
   The inner atom id goes into the cell slot (`CellSlot::Atom`), so `facade_of`
   routes reads to it. `formula_cells`/`formula_source`/`needs_parse` stay
   (content + parse laziness, not a dependency index — INV-2 whitelist).

2. **Point propagation moves to the store.** A write does `store.set(inner
   primitive)` then `store.flush()` inside the existing `store.batch`. The
   primitive's back-deps are the facades that read it; their back-deps are the
   dependent formula inner atoms — `dependencies_change`/`flush_pending` re-derive
   them eagerly during `set_cell` (fence S1: eval Δ = N−1 moves read→write, read
   sweep = 0). No BFS, no dirty marking.

3. **Deletions (satisfy tripwire PHASE≥4):** `cell_dependents` field +
   `add_formula_deps`/`remove_formula_deps`/`replace_formula_deps` point-index
   maintenance + the point half of `dependents_of_into_with_scratch`; the entire
   `mark_dependents_dirty` point-BFS; the `FormulaCache` read path
   (`compute_formula_at`/`eval_formula_at_with_provider`/`prewarm_formula_chain`) —
   its role (deep-chain safety) is subsumed by the store's DV-3 hybrid iterative
   read (256 native budget + NeedsDep faulting); `chain_10000` native/browser
   must stay green through store read at P4 (formal chain-fence bookkeeping
   transition + `chain_100000` are P6).

4. **Subscriptions attach to the facade** (`attach_address_sub` →
   `facade_of(addr)` instead of `current_readable_atom`). The facade never
   re-keys across literal↔formula swaps, so `with_remap`'s sub detach/reattach
   dance becomes a no-op (kept as a shell until P6). Facade equality-pruning
   reproduces "notify at most once, only when the displayed value changed" for
   free.

5. **would_create_cycle point half → on-demand AST walk over `formula_source`**
   (REVISED per codex F2 — NOT `store.reverse_reachable`). `reverse_reachable`
   only sees COMMITTED store edges, so an *unread* formula dep (`B1=A1` never
   read, then `A1=B1`) has no back-edge yet and the check would allow the cycle.
   The point-cycle check instead BFS-walks the retained `formula_source` ASTs
   (INV-2 whitelist: content, not a dependency index), which are present the
   instant a formula is installed regardless of read state — strictly more
   faithful than the old installed-dep static checker AND than `reverse_reachable`.
   Keeps Ok(false)+`#CYCLE!` literal semantics and `chain_bulk_install_is_linear`
   linear (walk visits each reachable formula's source once). Range half stays on
   `range_dependents` BFS via bridge until P6.

**Bridges retained (temporary, BRIDGE-tagged, delete-by P6/P5):**

- **Range deps → epoch bridge.** Formula read_fns resolve *ranges*
  non-reactively (enumerate backing store; storage is authoritative) — no store
  edge on range members at P4. `range_dependents` index still drives range-
  dependent re-derive: the write path finds range-dependents and bumps their
  slot_epoch (facade re-derive). Two-tier member/band replacement is P5.
- **Cross-sheet → `CrossSheetDeps` bridge** unchanged until P6 (single global
  store already lands the topology; edge-through-facade cross-sheet is P6).

**Cycle semantics under eager flush (the D3 review target):** with formula
cells as derived atoms, a runtime cycle (`A1=NOT(B1), B1=A1`) is caught by the
store's `computing` guard on the cross-atom dep read. The guard must record the
edge at current generation into scratch (else a broken cycle never re-invalidates
its observers) and the evaluator maps it to `#CYCLE!`. Open sub-question for
codex: whether the store `computing`-guard PANIC contract (a dep read of a
computing atom panics as a hard cross-atom cycle) is compatible with returning a
sticky `#CYCLE!` value, or whether the evaluator's Computing guard must
intercept strictly before any `args.get` on an in-progress peer — and whether a
cycle-component registry (plan §engine/cycles.rs) is required at P4 or can defer
to P6 with a flush debug-ceiling tripwire as the interim guard.

**Verification at P4 exit (unchanged from §4 owner-approved table):** rust/core
65; excel-core `--lib` 1404 + integration 1825 + wasm native 31; golden replay 5
seeds green (only sanctioned deviation: once-read eager); tripwire PHASE=4 bans
`cell_dependents`/`mark_dependents_dirty`; jest solid/excel; e2e Δ=0; playwright
MCP UI walkthrough.

### P3 codex review disposition (2026-07-08)

codex caught a P1: `Store` referenced but not imported in workbook.rs — my
own earlier "all green" runs were **stale incremental-build artifacts**
(cargo had not recompiled workbook.rs; grep-filtered output hid the truth).
Fixed the import; verification rule hardened: phase-gate runs use forced
recompilation (`touch` the edited roots) and assert on cargo's EXIT CODE,
never on grep counts alone. remove_sheet atom retention under the shared
store documented as intentional (caller-inspectable contract; cleanup moves
to family lifecycle at P6).

### P1 codex review disposition (2026-07-08)

codex review of the store rewrite returned 4 findings (all P2), all fixed in
the P1 commit: unwind-safety guards restored as RAII (ComputingGuard /
SettingGuard / BatchGuard / ReadDepthGuard — a panicking read fn, write fn,
or batch body no longer poisons store state; twinned by
`batch_panic_does_not_leak_depth`, `read_fn_panic_does_not_poison_computing_state`,
`write_fn_panic_does_not_poison_setting_guard`); large fan-in dep recording
made linear (Scratch dep_index HashMap + set-backed commit diff + set-backed
needed dedup; fenced by `large_fan_in_recompute_is_linear`). D1 (generation
snapshots) and D2 (hybrid NeedsDep protocol) reviewed with no holes found —
both CLOSED.

### P0 codex review disposition (2026-07-08)

codex review of the P0 artifacts returned 2 findings, both addressed in the
P0 commit: [P2] WASM signature extractor missed multi-line signatures /
`js_name` attributes / impl owner → rewritten to full-fidelity
`owner :: attrs :: signature` capture; [P3] BRIDGE markers were only counted
at P6 → now format-validated at every phase and phase-expiry-checked.

### P4c codex review disposition (2026-07-08)

codex D3 review of the point-dep flip returned **no P0** ("no smuggled
point-dependency structure found; the flip deletes the point index and moves
propagation onto pure store delegation") + four P1 + two P2. Every finding has an
IN-DELEGATION resolution — no INV amendment, no new parallel address→formula
index required. Dispositions:

- **F1 [P1] Runtime cycles hit the store panic before a sticky `#CYCLE!`.**
  `read_dep` PANICS on reading a `computing` (in-progress) atom, so `A1=NOT(B1),
  B1=A1` would panic before any `#CYCLE!` edge is recorded and the cycle could
  never dissolve on edit. **Fix:** the evaluator's Computing guard intercepts on
  the ADDRESS strictly BEFORE any `args.get` of an in-progress peer (the flip's
  two-layer intent, now made load-bearing): the provider tracks the in-flight
  address set; a point ref to an address already on the eval stack returns
  `#CYCLE!` directly and records the edge into scratch at current gen (so a later
  edit re-invalidates observers). No `args.get` on a computing peer is ever
  issued → the store panic contract is never reached. Cycle-component registry
  stays a P6 item behind the flush debug-ceiling tripwire; the guard makes the
  value sticky and stable without it.

- **F2 [P1] `reverse_reachable` is incomplete for unread formula edges.** An
  unread `B1=A1` has no committed store back-edge, so an install-time check over
  store edges would allow `A1=B1`. **Fix (spec item 5 revised above):** the
  point-cycle check BFS-walks the retained `formula_source` ASTs, present at
  install regardless of read state — strictly more faithful than both the old
  static checker and `reverse_reachable`. codex explicitly pre-blessed "a
  non-propagation cycle registry / static cycle path for unread formulas."

- **F3 [P1] Range/cross-sheet epoch bridge must invalidate the formula INNER,
  not just the facade.** `B1=SUM(A1:A10)` cached, then `A5=10`: bumping only the
  B1 facade epoch re-runs the facade but `args.get(B1_inner)` returns the stale
  cached inner value. **Fix:** the bridge write path calls
  `store.invalidate(inner)` (drops the inner's memoized state) in addition to
  bumping the slot epoch, so the inner re-evals on next pull. Applies to both the
  `range_dependents` and `CrossSheetDeps` bridges.

- **F4 [P1] Empty-cell point refs silently fail unless every inner-slot identity
  transition bumps the facade epoch.** `A1=B1+1` read while B1 empty, then
  `B1=41` creates a primitive; without an epoch bump the new primitive has no
  back-dep to A1's facade. **Fix:** bump slot_epoch on EVERY inner-slot identity
  transition — empty→primitive (`ensure_cell`), primitive→formula, formula→
  primitive, formula→empty (`drop_cell_slot` / inner swaps). Enforced at the
  single write口 so no path can skip it.

- **F5 [P2] Deep-chain stack safety plausible; effective budget ~128 formula
  links** (facade+inner ≈2 frames/edge vs the 256 native budget). Stack-safe IFF
  Null placeholders are tolerated and faulted passes have NO observable effects.
  **Fix:** only a COMPLETE read_fn run increments eval/recompute counters, and
  host custom-formula callbacks MUST NOT run on a faulted pass (guard the
  provider so a NeedsDep fault short-circuits before any callback). `chain_10000`
  stays green through the store read; `chain_100000` + formal chain bookkeeping
  are P6.

- **F6 [P2] Retained range/cross-sheet indices need explicit BRIDGE markers** so
  the tripwire distinguishes an approved temporary bridge from permanent parallel
  state. **Fix:** annotate `BRIDGE(delete-by: P5)` at `range_dependents` sites
  and `BRIDGE(delete-by: P6)` at `CrossSheetDeps` sites; tripwire counts them.

None of the four P1s is a wall requiring counter re-derivation or an INV
amendment, and codex found no P0 — so per the escalation ladder the flip proceeds
autonomously with all six fixes folded in.

### DECISION_REQUEST — golden seed 11 spill projection (filed 2026-07-10, GATE: owner)

**Status:** RESOLVED (2026-07-10). The owner's one-authority direction selects
option 1; the fixture and focused regression now require `#SPILL!`.

**Observed:** `golden_replay_all_seeds` differs only at seed 11, operation 244.
The operation installs `=SEQUENCE(2,2)` where a spill target is occupied. The
unified implementation returns `#SPILL!`.

**Cause:** the pre-P6 workbook path used `force_formula_recompute` whenever a
cross-sheet edge existed. That bypass returned formula cache contents before
the Sheet facade's spill projection, so `Workbook::get_cell` exposed the raw
array while `Sheet::get_cell` exposed `#SPILL!` for the same cell. The shared
facade/formula-inner Store path removes that dual state and both surfaces now
return `#SPILL!`. The focused
`sequence_spill_collision_surfaces_spill_error` regression pins this behavior.

**Resolution:**

1. Seed 11's oracle is updated to `#SPILL!`, preserving INV-2/INV-8 and one
   formula authority.
2. The historical raw-array Workbook result is rejected. Preserving it would
   require an explicit public semantic exception; restoring the retired
   bypass/cache remains unacceptable.

All five golden seeds now pass the unskipped replay gate.
