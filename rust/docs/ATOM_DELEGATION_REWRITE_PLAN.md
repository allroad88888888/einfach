# Atom-Delegation Rewrite — WORKPLAN & Constitution

> **Current phase: P4 (point-dep flip) — batch #1 fence table owner-approved 2026-07-08.**
>
> P4 executes in three sub-steps, each landing green:
> - **P4a (plumbing, zero semantics):** extract `SheetInterior` — the state a
>   formula read_fn must reach from inside the store: `cells` storage,
>   `formula_exprs`, the facade `cell_family`, BRIDGE `formula_epochs`
>   family, and the per-sheet eval counter — into an `Rc<SheetInterior>`
>   with `RefCell` fields. `Sheet { interior: Rc<SheetInterior>, store, … }`.
>   BORROW RULE (D7 corollary): no `interior` borrow may be held across any
>   `store.*` call or listener dispatch; borrow, copy out, release, then act.
>   All tests stay byte-identical.
> - **P4b (facades):** per-address facade derived atoms from `cell_family`
>   (read = getter(slot_epoch primitive) → look up inner id in interior →
>   getter(inner)); subscriptions attach to the stable facade;
>   AddressSubscriptionBucket remap machinery (`with_remap`,
>   `attach/detach_address_sub` re-pointing) collapses. Still green under
>   old expectations (facade publishes on the same observable changes).
> - **P4c (the flip):** formula cells become inner derived atoms — read_fn
>   captures `Weak<SheetInterior>` + `Rc<Expr>` + its BRIDGE epoch atom,
>   runs `eval_expr_with_provider` with an `AtomEvalProvider` whose point
>   refs resolve `family facade → args.get(...)` (edges + snapshots in the
>   store); `FormulaCache`/`compute_formula_at` read path dies;
>   `cell_dependents` + the point half of `mark_dependents_dirty` deleted;
>   `would_create_cycle` point half switches to `store.reverse_reachable`
>   (interactive installs are eager, so edges exist). Range deps (until P5):
>   writes consult the RETAINED `range_dependents` index and bump the
>   dependent formulas' epoch atoms — `BRIDGE(delete-by: P5-exit)`.
>   Cross-sheet (until P6): CrossSheetDeps dirty-BFS bumps epochs instead of
>   `mark_dirty_for_addr` — `BRIDGE(delete-by: P6-exit)`. Fence batch #1
>   lands in the same commit.
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
| P6 | Cross-sheet via shared store; delete `CrossSheetDeps`/latch/`force_formula_recompute`/`prewarm`/`would_create_cycle`(→`reverse_reachable`)/all BRIDGEs/P1 shims | fence batch 3 (S6, cross_sheet*, ~30 workbook inline pins dispositioned in §4) · `chain_100000` native + browser fences · tripwire final mode |
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

## 7. Perf record (filled at P7 — measure-after commitment)

_(empty — P0. Must contain: S1/S2/S11 write-side flush latencies, Chain100k
first/mutate/steady, bulk-import tiers, memory per materialized cell, vs the
pre-arc baselines in `solid/excel/test/perf-ts-vs-wasm-report.md`.)_

## 8. Quick-verify block

```bash
cd /Volumes/work/self/einfach
# tier greens (baseline counts recorded at P0 exit — see below)
cd rust/core && cargo test
cd ../excel-core && cargo test --lib && cargo test
cargo test --manifest-path ../wasm/Cargo.toml
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

## 9. Decision log

| ID | Decision | Status |
|---|---|---|
| D1 | Snapshot = generation counters; `Value::Array`/`Lambda` equality via `Rc::ptr_eq` fast path + `PartialEq` | **CLOSED** (P1 codex review: no holes) |
| D2 | NeedsDep scratch-commit + 256-deep recursion-budget hybrid (DV-3); counters bump on completed runs only | **CLOSED** (P1 codex review: no holes; unwind guards added per review) |
| D3 | Cycle semantics: keep two-tier (install-time reject via `store.reverse_reachable` + runtime `#CYCLE!` value); cycle-component registry with dissolve-on-edit | codex review at P4/P6 |
| D4 | Range tiers: Tier A per-member (threshold ~64–256, tune at P5), Tier B band atoms (col, row/256) | codex review before P5 code |
| D5 | Per-shape counter re-derivation tables (§4) | owner sign-off per batch |
| D6 | worker-runtime-ts `'dirty'` override: delete after convergence (both engines assert `'clean'`) | decide at P7 |
| D7 | Store ownership: `Rc<RefCell<Store>>` handle; borrow windows never span eval re-entry | codex review at P3 |

_(DECISION_REQUESTs, if any, appended below.)_

### DECISION_REQUEST — P4c point-dep flip (filed 2026-07-08, GATE: D3 codex + owner)

**Status:** OPEN. Blocks the single behavior-changing edit of P4. Fence
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
