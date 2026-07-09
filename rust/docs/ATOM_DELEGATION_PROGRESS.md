# Atom-Delegation Rewrite — Progress Snapshot

> Living status doc for the atom-delegation rewrite arc. Constitution/plan lives in
> [`ATOM_DELEGATION_REWRITE_PLAN.md`](./ATOM_DELEGATION_REWRITE_PLAN.md) (the WORKPLAN).
> Current main-line read/write logic (as it stands mid-flip) lives in
> [`ATOM_DELEGATION_MAINLINE.md`](./ATOM_DELEGATION_MAINLINE.md).
>
> Snapshot date: 2026-07-09 · Branch: `claude/rust-core-state-plan-Auzcj`
> HEAD: `4eca1a3` · Tripwire `PHASE = 1` · **Not pushed. CI untouched. No amends.**

## Where we are

The arc rebuilds the Rust engine so that "what changed → recompute what" is decided
**only** by the `rust/core` Store dependency graph (INV-2), deleting excel-core's
~1600-line parallel address-level dependency graph (`cell_dependents` /
`RangeDependentIndex` / `CrossSheetDeps`). Formula cells become derived atoms read
through a per-cell facade `AtomFamily`.

| Phase | Content | State |
|---|---|---|
| P0 | WORKPLAN + tripwire + golden fixtures + baselines + WASM snapshot | ✅ done |
| P1 | `rust/core` Store faithful rewrite (gen snapshots D1, NeedsDep scratch-commit D2, settled-memo, reentrant publish) + vanilla twin tests | ✅ done |
| P2 | `AtomFamily` core primitive (`rust/core/src/family.rs`) | ✅ done |
| P3 | Workbook-global single store (`Rc<RefCell<Store>>` handles, D7) | ✅ done |
| **P4** | **Point deps → pure atoms; delete `cell_dependents` + point BFS** | 🔶 **in progress** |
| P5 | Two-tier ranges (Tier A per-member / Tier B band version atoms) | ⬜ pending |
| P6 | Cross-sheet via shared store + total parallel-mechanism deletion | ⬜ pending |
| P7 | Probe convergence, release gate, perf measurement, final handoff | ⬜ pending |

## P4 sub-structure (where the flip actually is)

P4 was split into three sub-steps to keep each commit reviewable:

- **P4a** — plumbing: extract `Rc<SheetInterior>`, zero semantics. ✅ `611b380`
- **P4b** — scaffolding: `slot_epoch` + facade `AtomFamily` fields. ✅ `2bed148`
- **P4c** — the flip itself, split into two commits:
  - **Commit A** (inert write口 half) — ✅ `4eca1a3` (**current HEAD**). Wires the
    single write口 to `bump_facade_epoch` / `invalidate_formula_inner`. Inert because
    the facade families are still empty pre-flip (the hooks early-return).
  - **Commit B** (the coupled read口 flip) — ⬜ **NOT YET DONE**. This is the
    destructive, atomic commit that must be done **inline**. See "Next step" below.

Commit chain for P4c (newest → oldest):
`4eca1a3` (Commit A) → `0f18676` (additive facade/inner read path + `depend` primitive)
→ `76c113e` (codex D3 disposition F1–F6) → `7d36337` (scaffold lazy facade doors)
→ `2bed148` (P4b scaffolding) → `611b380` (P4a plumbing).

## Facade machinery status (built, mostly inert)

All live in `rust/excel-core/src/sheet.rs` §960–1330. Everything on the formula-INNER
path is still `#[allow(dead_code)]` — built and compiling, but not reached until the
flip. The Commit-A write口 hooks ARE reached, but no-op while families are empty.

| Item | Loc | State |
|---|---|---|
| `FacadeCtx` (7 shared handles, `Clone`, `'static`) | @972 | live struct |
| `owned_create_atom` / `owned_create_derived_ctx` (lazy) | @990 / @997 | **live** |
| `epoch_of` (lazy slot-epoch primitive) | @1008 | **live** |
| `get_or_create_facade` (routing gate @1053–1058) | @1023 | **live** (reached by Commit-A) |
| `formula_expr_for` / `formula_inner_of` | @1090 / @1105 | dead_code (inner path) |
| `eval_formula_inner` (InFlightGuard + AtomFormulaProvider) | @1126 | dead_code |
| `range_member_addrs` (Tier A member collection) | @1150 | dead_code |
| `InFlightGuard` (RAII cycle guard) | @1210 | dead_code |
| `AtomFormulaProvider` + `read_facade` (F1 cycle guard @1266) | @1247 | dead_code |
| `bump_facade_epoch` (NON-creating; monotone) | @1605 | live, inert (empty family) |
| `invalidate_formula_inner` | @1627 | live, inert |
| `slot_atom_id` (F4 pre/post identity sampling) | @1638 | live |

## Verification baselines (honest numbers to hold)

Recorded at P0 exit (WORKPLAN §8), reconciled against in-session re-measure:

- rust/core: **65** passed / 0 ignored
- rust/excel-core `--lib`: WORKPLAN records **1404**; in-session forced-recompile
  measured **1411**. Treat **1411** as the live floor — never regress below it.
  (The 1404 in the plan is stale; do not "reconcile down" to it.)
- rust/excel-core integration: ~**1825** passed / 12 ignored across 65 binaries
- rust/wasm native: **31** passed / 1 ignored (browser: 13 wasm-pack tests, separate)
- golden replay: **5 seeds × 2000 ops**, all green (only sanctioned deviation:
  once-read eager re-derive)

Verify Rust by FORCING recompile (`touch rust/excel-core/src/*.rs`) and asserting the
cargo **exit code** via zsh `${pipestatus[1]}` / `$?` — never grep pass-counts off a
possibly-incremental build (P3 lesson: stale artifacts reported "all green" while a
file didn't recompile).

## Next step — P4c Commit B (the flip)

One atomic commit, done inline, folding in codex fixes F1–F6. The full item list is
the CLEARED DECISION_REQUEST in WORKPLAN §9 (§251–295). Headline moves:

1. Re-route `peek_value_with_provider` @3523 formula branch to
   `get_or_create_facade(addr)` for **same-sheet** formulas; cross-sheet stays on the
   surviving eager `eval_formula_at_with_provider` / FormulaCache path (P6 deletes it).
2. Write sites (`try_set_formula` @3174, `hydrate_formula` @1944, BulkLoader flush)
   build inner derived atoms, gated to exclude cross-sheet.
3. Subscriptions fan out on the facade (`attach_address_sub → facade_of(addr)`;
   `with_remap` → no-op shell).
4. **Delete** (satisfy tripwire `PHASE ≥ 4`): `cell_dependents` field,
   `add_formula_deps` / `remove_formula_deps` / `replace_formula_deps`, the point half
   of `dependents_of_into_with_scratch` @2280, `mark_dependents_dirty` @2330,
   `mark_dependents_dirty_silent_batch` @5079, and the same-sheet FormulaCache read
   path (`compute_formula_at` / `eval_formula_at_with_provider` / `prewarm_formula_chain`).
5. Range propagation → a **differently-named** epoch-bridge fn (keep `range_dependents`;
   per F3 seed direct range-dependents with `store.invalidate(inner)` + `bump_facade_epoch`).
6. Rewrite `would_create_cycle` @3346 body to a `formula_source` AST BFS walk — **keep
   the name** through P4/P5 (F2).
7. BRIDGE markers in full parser-valid form: `BRIDGE(delete-by: P5-exit)` at
   `range_dependents`, `BRIDGE(delete-by: P6-exit)` at `CrossSheetDeps` (F6).
8. Remove `#[allow(dead_code)]` from the facade machinery; F4 bump on every inner-slot
   identity transition; F5 only complete read_fn increments counters + no host
   custom-formula callback on a faulted pass; wire fence batch #1 counters.
9. Set tripwire `PHASE` 1 → 4 in the **same** commit.

### P4 exit gates (all must hold)

Tripwire `PHASE = 4` green · cargo test all crates green (rust/core 65, excel-core
`--lib` ≥ 1411 + integration 1825 + wasm native 31) · golden replay 5 seeds green ·
e2e dual-project Δ=0 · playwright MCP UI walkthrough · codex peer review of the flip diff.

## Guardrails (binding, from WORKPLAN §6)

Escalation rule: a perf/scale/counter wall that pure atom delegation can't satisfy →
the ONLY legal moves are (a) stop + file a DECISION_REQUEST, (b) codex review,
(c) owner approval of a counter re-derivation or explicit INV amendment. Introducing
any address→formula index, cache, or shortcut structure without an INV amendment is a
**P0 defect even if all tests pass**. Never push mid-arc; never touch `.github/workflows`;
never `git commit --amend`; never `--no-verify`.
