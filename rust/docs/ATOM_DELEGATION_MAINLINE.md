# Atom-Delegation Rewrite — Current Main-Line Logic

> Describes the engine's read/write path **as it stands right now** (HEAD `4eca1a3`,
> P4c Commit A landed, Commit B not yet done). This is a transitional state: the old
> eager same-sheet engine is still the LIVE read path; the facade/atom-delegation
> machinery is built and wired on the write口 but INERT because the facade families
> are empty pre-flip.
>
> For the OLD (pre-arc, eager-push + topological-sort) engine see the legacy
> [`MAIN_FLOW.md`](./MAIN_FLOW.md) — that describes what the arc is replacing.
> For where we're headed see [`ATOM_DELEGATION_REWRITE_PLAN.md`](./ATOM_DELEGATION_REWRITE_PLAN.md).
> For arc status see [`ATOM_DELEGATION_PROGRESS.md`](./ATOM_DELEGATION_PROGRESS.md).
>
> Snapshot date: 2026-07-09. Line numbers are `rust/excel-core/src/sheet.rs`.

## The two engines, side by side (transitional)

Right now the code holds **both** mechanisms. This is deliberate and temporary — the
flip (Commit B) deletes the same-sheet half of the eager engine and routes reads
through the facade.

```
                      LIVE today                    Built, inert (flips in Commit B)
                      ─────────────                 ───────────────────────────────
read a cell    peek_value_with_provider @3523  →   get_or_create_facade @1023
formula eval   eval_formula_at_with_provider   →   formula_inner_of / eval_formula_inner
               compute_formula_at @3618             (@1105 / @1126)
propagation    cell_dependents + point BFS      →   store dependency graph (INV-2)
               mark_dependents_dirty @2330          via ReadArgs::get edges
invalidation   FormulaCache dirty flags         →   bump_facade_epoch + store.invalidate
subscription   attach_address_sub (Plain→Atom)  →   attach_address_sub → facade_of(addr)
```

## Read path (LIVE — eager, still the source of truth)

`peek_value_with_provider(addr, provider)` @3523:

```
hydrate_formula(addr)                       # lazy parse/install (unchanged, kept)
if formula_cells.contains_key(&addr):
    return eval_formula_at_with_provider(addr, provider)   # ← LIVE eager engine
return cell_value_at(addr).unwrap_or(Value::Null)
```

- `eval_formula_at_with_provider` @3545 → `compute_formula_at` @3618 (bumps
  `formula_eval_count` @3644) → `prewarm_formula_chain` @3677 (iterative post-order DFS).
- This same-sheet eager engine is what Commit B **bypasses for same-sheet formulas**
  (routing to `get_or_create_facade`) and P6 finally **deletes**. Cross-sheet formulas
  stay on it until P6.

## Write path (LIVE + Commit-A hooks already wired)

Single write口 discipline: the authoritative store is `RowMajorMap<CellSlot>`; all
mutation flows through a small set of write helpers.

`try_set_formula` @3174 (formula install):

```
parse → would_create_cycle @3197 (static BFS over cell_dependents+range_dependents)
with_remap { build FormulaRecord:
    add_formula_deps @3212            # point dep index  ← DELETED in Commit B
    add_formula_range_deps @3213     # range dep index  ← kept, BRIDGE(delete-by: P5-exit)
    note_cross_sheet_if_any @3215
    insert formula_cells / formula_exprs / formula_texts }
invalidate_formula_inner @3228       # ← Commit-A hook (inert: family empty)
bump_facade_epoch     @3229          # ← Commit-A hook (inert: family empty)
mark_dependents_dirty @3230          # ← LIVE point-BFS  ← DELETED in Commit B
recompute_array_formula
```

`write_error` @3244 (and the value-write path) already does F4-style pre/post identity
sampling:

```
pre  = slot_atom_id(addr) @3251
had_formula ? with_remap(write) : direct write
mark_dependents_dirty @3263          # ← LIVE  ← DELETED in Commit B
post = slot_atom_id(addr) @3270
if had_formula || pre != post: bump_facade_epoch @3271   # ← F4 partial (inert today)
```

### Why the Commit-A hooks are inert

`bump_facade_epoch` @1605 is **non-creating**: `slot_epoch_family.get(&addr)` returns
`None` (nothing has read the cell through a facade yet), so it early-returns.
`invalidate_formula_inner` @1627 likewise only acts `if let Some(inner) =
formula_inner_family.get(&addr)`. Pre-flip both families are empty ⇒ both are no-ops.
They exist now so that when Commit B starts populating the families, invalidation is
already correct — the write口 was decoupled from the read口 in a separate, safe commit.

## Facade machinery (built, `#[allow(dead_code)]` on the inner path)

The target read path, all in `sheet.rs` §960–1330:

- **`FacadeCtx`** @972 — cheap-to-clone `'static` bundle of the 7 shared handles
  (`store`, `atoms_owned`, `interior`, `slot_epoch_family`, `cell_facade_family`,
  `formula_inner_family`, `in_flight`).
- **`get_or_create_facade`** @1023 — per-address facade derived atom. Fast-path returns
  cache; else `epoch_of(addr)` then a derived atom whose read closure (routing gate
  @1053–1058) reads the slot epoch, then: if the address is a formula →
  `formula_inner_of(addr)` and return its value; else snapshot the `CellSlot` under a
  short borrow and return `Atom`/`Plain`/`Null`.
  **⚠ The gate @1053–1058 currently routes ALL formulas (incl. cross-sheet) to an inner
  atom.** A cross-sheet formula routed this way would eval to `#REF!`. Commit B must
  gate this branch on per-formula cross-sheet detection so cross-sheet stays on the
  surviving FormulaCache path. This gate must be applied at BOTH `get_or_create_facade`
  @1023 and `peek_value_with_provider` @3523.
- **`formula_inner_of`** @1105 → **`eval_formula_inner`** @1126 — the inner derived
  atom: `formula_expr_for(addr)` (prefers `formula_exprs`, else parse `formula_source`),
  `InFlightGuard::enter`, then `eval_expr_with_provider` through an `AtomFormulaProvider`.
- **`AtomFormulaProvider`** @1247 — the evaluator's ref-resolution seam. `read_facade`
  @1266 is where dependency edges are recorded through the store:
  ```
  facade = ctx.get_or_create_facade(addr)
  if in_flight.contains(&addr):            # F1 runtime cycle guard (inline, live)
      args.depend(facade); return Value::Error(CyclicRef)   # #CYCLE!, records edge
  return args.get(facade)                  # normal: read + record dep edge
  ```
  `cell` collapses arrays; `sheet_cell`/`raw_sheet_cell` return `InvalidRef` (cross-sheet
  handled elsewhere pre-P6); `for_each_range_cell` iterates `range_member_addrs`.

Everything except `owned_create_*` / `epoch_of` / `get_or_create_facade` is
`#[allow(dead_code)]` — the inner-atom path compiles but is not reached until Commit B
removes the attributes and routes `peek_value_with_provider` into it.

## Invariant being enforced (INV-2)

The single response graph is the `rust/core` Store's `dependenciesMap` /
`backDependenciesMap`. Once the flip lands, "what changed → recompute what" is decided
ONLY by store edges recorded via `ReadArgs::get` (and re-invalidation-only edges via
`ReadArgs::depend`). excel-core is forbidden a map keyed by address whose value is a
formula-cell address. Whitelisted structures: band/range family geometry, spill
`claims`, `cell_subscriptions`, `formula_source` / `needs_parse`. The executable
tripwire `tests/architecture_invariants.rs` (`PHASE`, currently 1 → flips to 4 with
Commit B) fails `cargo test` if a banned identifier reappears in the gated files.
