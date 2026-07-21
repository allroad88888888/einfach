# Functional performance baseline

Budgets and measured numbers for the **feature path** — "a user starts an
operation; how much work does the stack do before the surface can repaint".

Gate: `solid/excel/test/perf-functional-budgets.test.ts`
(real WASM engine + real `worker-runtime.ts` dispatcher + real
`worker-workbook-backend` host port, all in process under jest/node).

```bash
# light tier — runs in the default sweep
npx jest solid/excel/test/perf-functional-budgets.test.ts --no-coverage

# heavy tier — same assertions, bigger workbooks
EINFACH_SCALE=1 npx jest solid/excel/test/perf-functional-budgets.test.ts --no-coverage
```

## Why this file exists

The repo already had **engine**-level benches
(`perf-rust-storage-primary.bench.ts`, `perf-rust-bulk-import-ultra.bench.ts`,
`perf-ts-vs-wasm.bench.ts` — all `EINFACH_PERF=1`-gated and named `.bench.ts`
so the default jest sweep never picks them up) plus a scaling audit
(`audit-adapter-scaling.test.ts` — loose timings, hard shape assertions).

What it did not have is a budget on the layer the user actually feels: the
host backend port. `README.md` recorded performance as
`PENDING_ROOT_VERIFICATION`; this gate is the verification.

### Conventions inherited from the existing benches

| Convention | Source | Reused here |
| --- | --- | --- |
| `@jest-environment node` + `jest.mock('../wasm-pkg/einfach_wasm.js')` with `initSync` on the raw `.wasm` bytes | `vnext-worker-sort-host-wasm.test.ts`, `vnext-worker-tables-wasm.test.ts` | yes, verbatim |
| Duplex in-process `WorkerLike` shim + a `self` shim so `worker-runtime.ts` runs unmodified | same | yes, plus RPC counters |
| `performance.now()` deltas, `console.log` with an `eslint-disable-next-line no-console` justification | `audit-adapter-scaling.test.ts`, all benches | yes |
| Loose wall-clock assertions so the suite stays green on any hardware | `audit-adapter-scaling.test.ts` header | yes |
| Env-gated heavy tier | `scale-parity.test.ts` (`EINFACH_SCALE`) | yes — `EINFACH_SCALE=1` |
| Deterministic LCG (`s*1664525+1013904223`) for shuffles | `perf-rust-storage-primary.bench.ts` | yes |

Deliberate divergence: this file is `.test.ts`, not `.bench.ts`, because
the light tier is a **gate** and must run unattended in the default sweep.
The `.bench.ts` + `EINFACH_PERF=1` combination stays reserved for the
long-running engine benches.

## Measurement doctrine

**Work assertions are the gate. Wall clock is a smoke alarm.**

- **Work assertions** — RPC counts, snapshotted cell counts, projected
  cell counts. Deterministic, machine independent, and they fail for the
  right reason: an extra round trip, a per-row loop, an unbounded scan.
  Every hard `expect(...).toBe(...)` in the suite is one of these.
- **Wall-clock assertions** — order-of-magnitude ceilings only, sized
  30-50× above the measured value. They exist to catch a catastrophic
  regression (a sort that starts recomputing the whole workbook), never
  to police a 20% drift. Every one logs its measured value so this doc
  can be refreshed rather than the budget quietly loosened.

## Machine

| | |
| --- | --- |
| CPU | Apple M4 (10 cores) |
| RAM | 16 GB |
| OS | macOS 26.5.2 |
| Node | v24.14.0 |
| Date | 2026-07-21 |
| Commit | branch `claude/rust-core-state-plan-Auzcj` |

All wall-clock numbers below are from this machine. Treat them as the
reference point, not as a portable budget.

---

## 1. Physical sort (`sortRange` host port)

Workload: `rows × 5` block, column 0 a shuffled permutation of `1..rows`
(so a sort moves essentially every row), columns 1-4 text payload that
must travel with the key.

| Tier | Rows × cols | Cells | Wall clock | movedRows | movedCells | RPCs | Undo image cells |
| --- | --- | --- | --- | --- | --- | --- | --- |
| light (default) | 800 × 5 | 4 000 | **16.8 ms** | 800 | 4 000 | 5 | 8 000 |
| heavy (`EINFACH_SCALE=1`) | 5 000 × 5 | 25 000 | **84.0 ms** | 4 999 | 24 995 | 5 | 50 000 |

RPC envelope (identical at both tiers, i.e. **constant in the range
size**): `snapshotRangeSparse×2 snapshotFormatRange×2 sortRange×1`.

### Budgets

| # | Budget | Kind | Measured |
| --- | --- | --- | --- |
| S1 | `sortRange` RPC count `=== 1` | work | 1 |
| S2 | total RPCs `<= 6` | work | 5 |
| S3 | undo images `<= 2 × range area` | work | exactly 2× (before + after) |
| S4 | `readSparseRange` during the mutation `=== 0` | work | 0 |
| S5 | wall clock `< 4 s` (light) / `< 20 s` (heavy) | wall clock | 16.8 ms / 84.0 ms |

S1 and S4 are the two that matter. S1 catches any refactor that starts
looping per row or per sort key. S4 pins that the mutation triggers **no**
projection read from inside itself — the surface refreshes exactly once,
afterwards, which is the "one RPC, one projection refresh" contract.

### Post-sort projection refresh

| Tier | Workbook | Wall clock | Projected cells | `readSparseRange` payload | RPCs |
| --- | --- | --- | --- | --- | --- |
| light | 4 000 cells | 1.2 ms | 200 | 200 | 2 |
| heavy | 25 000 cells | 1.3 ms | 200 | 200 | 2 |

One `readSparseRange`, one `snapshotFormatRange`. Payload is 200 because
the sort workload is 5 columns wide inside a 40×12 window — the read is
window ∩ existing, exactly as the bounded-window contract requires.

---

## 2. Visible projection is window-bounded

The load-bearing experiment: the **same** 40×12 window (480 cells,
identically populated) is read out of two workbooks whose totals differ by
~20×. The filler lives strictly below row 100, outside the window.

| Tier | Small workbook | Large workbook | Payload (small) | Payload (large) | ms (small) | ms (large) |
| --- | --- | --- | --- | --- | --- | --- |
| light | 980 cells | 10 480 cells | 480 | **480** | 1.5 | 0.9 |
| heavy | 2 480 cells | 40 480 cells | 480 | **480** | 0.9 | 0.9 |

### Budgets

| # | Budget | Kind | Measured |
| --- | --- | --- | --- |
| P1 | payload `<= window area (480)` | work | 480 |
| P2 | `large.payload === small.payload` | work | equal |
| P3 | `large.projected === small.projected` | work | equal |
| P4 | `large.rpcs === small.rpcs` | work | equal (2) |
| P5 | `large.ms < max(50 ms, small.ms × 8)` | wall clock | 0.9 ms vs 1.5 ms |

**Result: the bounded-window contract holds.** A 20× (light) / 16× (heavy)
larger workbook costs the projection exactly zero extra cells, zero extra
RPCs, and no measurable extra time. There is no host-side scan-then-filter
anywhere on this path.

P2 is what a regression would break: a backend that shipped the sheet to
the host to filter would show `large.payload > small.payload` immediately.

---

## 3. Table-definition undo transaction — **FINDING**

`recordTableMutation` (`worker-workbook-backend.ts:1627`) captures a
**full-workbook sparse image before AND after** every Table-definition
change, so the registry envelope and the cell image replay as one
transaction (design #25 — half a transaction would leave `SUBTOTAL`
formulas under a table that no longer claims a totals row).

That is `O(workbook)`, not `O(table)`. Priced exactly:

| Operation | Workbook | Wall clock | `snapshotSparse` calls | Cells imaged | Ratio |
| --- | --- | --- | --- | --- | --- |
| `createTable` | 612 cells | 2.3 ms | 2 | 1 224 | 2.00× workbook |
| `renameTable` (1-token change) | 612 cells | 2.0 ms | 2 | 1 224 | 2.00× workbook |
| `createTable` | 112 cells | 0.3 ms | 2 | 224 | — |
| `createTable` | 1 812 cells | 4.2 ms | 2 | 3 624 | **16.18×** the 112-cell case |

Full RPC envelope: `snapshotSparse×2 snapshotTables×2 <mutation>×1`.

### Budgets

| # | Budget | Kind | Measured |
| --- | --- | --- | --- |
| T1 | `snapshotSparse` calls `=== 2` (before + after) | work | 2 |
| T2 | imaged cells `=== 2 × workbook non-empty cells` | work | exact |
| T3 | `snapshotTables` calls `=== 2` | work | 2 |
| T4 | rename pays the identical price to create | work | identical |
| T5 | image-cell ratio grows `> 10×` for a ~16× workbook | work | 16.18× |
| T6 | wall clock `< 3 s` | wall clock | 2.0-4.2 ms |

T2 and T4 are pinned **as documentation, not as endorsement**. A future
optimisation to a bounded image will trip them; that is intended — update
this table when it does.

### F1 — the cap is reachable by an ordinary sheet

`WORKER_TABLE_SNAPSHOT_MAX = 2000` (`worker-workbook-backend.ts:284`)
counts **non-empty cells across the entire workbook**. Over it, the
after-image is never taken, one snapshot is paid instead of two, and the
record is stored as *not-undoable* — the mutation still applies, but
Ctrl+Z silently declines.

Measured reachability:

```
REACHABILITY · 500×5 sheet = 2500 cells vs cap 2000:
  createTable 2.9 ms, ONE workbook snapshot of 2500 cells,
  record degraded to not-undoable
```

**A 500-row × 5-column sheet — about as ordinary as a spreadsheet gets —
is already over the cap.** The practical ceiling is ~400 rows × 5 columns.
On anything larger, *every* Excel Table definition mutation (create,
rename, rename-column, delete, totals toggle) is non-undoable.

### Is 2000 the right number? The cost curve says no.

Measured cost of one workbook-wide sparse image (heavy tier):

| Workbook | Images taken | Cells imaged | Wall clock | Rate |
| --- | --- | --- | --- | --- |
| 2 500 | 1 (degraded) | 2 500 | 3.0 ms | 1.19 µs/cell |
| 10 000 | 1 (degraded) | 10 000 | 11.7 ms | 1.17 µs/cell |
| 40 000 | 1 (degraded) | 40 000 | 48.1 ms | 1.20 µs/cell |

Clean linearity at **~1.18 µs/cell**. Extrapolating on that rate:

- at the current cap (2 000): ~2.4 ms per image, **~4.8 ms** for both;
- at 50 000 (the value `MAX_SORT_SOURCE_CELLS` already uses for sort):
  ~59 ms per image, **~118 ms** for the pair.

For comparison, this same gate accepts an 84 ms sort of 25 000 cells as a
normal interactive operation. So the cap is roughly **25× more
conservative than the measured cost justifies**, and it buys that
conservatism by removing undo from Table operations on essentially every
real workbook.

**Suspected reason it is set this way:** 2000 reads like a memory /
blast-radius guard on the retained history stack (two images per record ×
100 history entries), not a latency budget — the latency numbers above
would not have motivated it. If that is the intent, the right fix is
probably a *byte* budget over the whole history stack rather than a
per-transaction cell count, or an image scoped to the sheets a table
actually touches instead of the whole workbook.

**This slice measures only.** No product code was changed. Raising the cap
or narrowing the image is a separate change against
`solid/excel/src-vnext/adapter/worker-workbook-backend.ts` and needs its
own review — the memory ceiling has to be re-derived before the number
moves.

---

## Gate results (2026-07-21)

```
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false | grep -c 'error TS'
→ 6   (0 from this file; the 6th is an in-flight
       vnext-table-totals-static-wasm-parity.test.ts TS6133 from a
       concurrent slice. Baseline attributable here: 5)

npx jest solid/excel --no-coverage --silent
→ Test Suites: 1 failed, 1 skipped, 93 passed, 94 of 95
   Tests:       1 failed, 6 skipped, 1397 passed, 1404 total
   The single failure is vnext-table-totals-static-wasm-parity.test.ts
   (hidden-row port parity), an in-flight file from a concurrent slice —
   unrelated to and unaffected by this gate.

npx jest solid/excel/test/perf-functional-budgets.test.ts --no-coverage
→ 9 passed, 9 total (0.79 s)

EINFACH_SCALE=1 npx jest solid/excel/test/perf-functional-budgets.test.ts --no-coverage
→ 9 passed, 9 total (1.04 s)
```

## Open items

1. **F1 cap re-tuning** — decide whether `WORKER_TABLE_SNAPSHOT_MAX` moves
   (to ~50 000, matching `MAX_SORT_SOURCE_CELLS`) or whether the image
   narrows to the touched sheets. Needs a memory ceiling for the retained
   history stack first. Product-code change, out of scope here.
2. **Filtered-sort projection path is not yet budgeted.** `readRange`
   branches to `readFilteredRange` when a filter is active; that branch has
   no gate. Same bounded-window claim, different code path.
3. **No budget on `setCellInput` recalculation fan-out.** A single edit
   feeding a long dependency chain is the other classic interactive
   latency risk; the recompute count is not yet asserted anywhere.
4. **No cross-sheet workload.** All budgets here are single-sheet. The
   Table image is workbook-wide, so a multi-sheet workbook makes F1 worse
   in exact proportion to the sheets it does not touch — unmeasured.
5. **CI reference numbers.** Every wall-clock figure is from one Apple M4.
   When this runs on CI, record a second column rather than loosening the
   ceilings.
