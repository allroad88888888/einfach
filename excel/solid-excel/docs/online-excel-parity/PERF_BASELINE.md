# Functional performance baseline

Budgets and measured numbers for the **feature path** — "a user starts an
operation; how much work does the stack do before the surface can repaint".

Gate: `excel/solid-excel/test/perf-functional-budgets.test.ts`
(real WASM engine + real `worker-runtime.ts` dispatcher + real
`worker-workbook-backend` host port, all in process under jest/node).

```bash
# light tier — runs in the default sweep
npx jest excel/solid-excel/test/perf-functional-budgets.test.ts --no-coverage

# heavy tier — same assertions, bigger workbooks
EINFACH_SCALE=1 npx jest excel/solid-excel/test/perf-functional-budgets.test.ts --no-coverage
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

## 3. Table-definition undo transaction — **FINDING (RESOLVED, #26)**

### The finding, as first measured

`recordTableMutation` captured a **full-workbook sparse image before AND
after** every Table-definition change, so the registry envelope and the
cell image replay as one transaction (design #25 — half a transaction
would leave `SUBTOTAL` formulas under a table that no longer claims a
totals row). One `WORKER_TABLE_SNAPSHOT_MAX = 2000` cap counted **every
non-empty cell in the workbook**, for all six ports.

That is `O(workbook)`, not `O(change)`. Priced exactly:

| Operation | Workbook | Wall clock | `snapshotSparse` calls | Cells imaged | Ratio |
| --- | --- | --- | --- | --- | --- |
| `createTable` | 612 cells | 2.3 ms | 2 | 1 224 | 2.00× workbook |
| `renameTable` (1-token change) | 612 cells | 2.0 ms | 2 | 1 224 | 2.00× workbook |
| `createTable` | 112 cells | 0.3 ms | 2 | 224 | — |
| `createTable` | 1 812 cells | 4.2 ms | 2 | 3 624 | **16.18×** the 112-cell case |

**A 500-row × 5-column sheet — about as ordinary as a spreadsheet gets —
is 2 500 cells and was already over the cap.** The practical ceiling was
~400 rows × 5 columns; above it *every* Table definition mutation
recorded as not-undoable and Ctrl+Z silently declined.

Cost curve of one workbook-wide image (heavy tier):

| Workbook | Cells imaged | Wall clock | Rate |
| --- | --- | --- | --- |
| 2 500 | 2 500 | 3.0 ms | 1.19 µs/cell |
| 10 000 | 10 000 | 11.7 ms | 1.17 µs/cell |
| 40 000 | 40 000 | 48.1 ms | 1.20 µs/cell |

Clean linearity at **~1.18 µs/cell**: the cap bought ~4.8 ms, while 50 000
(what `MAX_SORT_SOURCE_CELLS` already uses) would cost ~118 ms — against a
sort of 25 000 cells this same gate accepts at 84 ms. So 2000 was never a
latency budget; it was an unstated memory guard on the retained history
stack, and it was ~25× more conservative than the measured cost justifies.

### The fix — image what the operation touches, not what the workbook holds

Verified against `excel/rust/excel-core/src/workbook.rs`, the six ports touch
three different cell sets, so they now declare three different scopes:

| Ports | Engine fn | Cells the engine writes | Scope | Cell image |
| --- | --- | --- | --- | --- |
| `createTable`, `deleteTable` | `define_table` / `delete_table` (§4.1) | **none** — registry map + epoch bump; delete is convert-to-range and leaves values, formulas and formats in place | `registry-only` | none at all |
| `renameTable`, `renameTableColumn` | `rename_table` / `rename_table_column` → `rewrite_table_refs_across_sheets` (§4.3) | `set_formula` on arbitrary cells on **every sheet** | `formula-rewrite` | workbook-wide sweep, **only `kind: 'formula'` cells retained** |
| `setTableTotalsRow`, `setTableTotalFunction` | `set_table_totals_row` / `set_table_total_function` (§7) | totals-row band only: `range.end.row + 1` on enable, `range.end.row` on disable / retarget, across the table's own column span | `totals-band` | 2 rows × the table's columns, anchor sheet only |

Two engine facts make the narrowing exact rather than optimistic:

- `collect_table_ref_rewrites` (`sheet.rs`) walks `formula_exprs` /
  `formula_source` **only**, so a literal can never be rewritten by a
  rename — filtering the image to formula cells drops nothing a rename
  could have changed.
- a rename rewrites **in place** (`set_formula` on a cell that already
  holds a formula); it creates and destroys nothing. So that scope needs
  no clear-then-restore at all, and dropping the workbook-wide pre-clear
  removes the only reason the literals had to be carried.

The totals band keeps clear-then-restore (an enable *adds* a cell, which
an additive `restoreSparse` cannot undo) but scoped to one bounded range.

### Cap re-derivation — memory ceiling → cell ceiling

The old number had no stated derivation. The new ones do, and they are
memory-bound, since the latency curve above shows latency is not the
binding constraint.

1. **What is resident.** `WORKER_UNDO_STACK_CAP = 100` records, each
   holding a before and an after image → worst case **200 images live at
   once**.
2. **Cost of one cell.** Measured V8 retained size of a `SparseCellWire`
   (200 000-element array, `node --expose-gc`, `heapUsed` delta):
   **120 B** for a literal cell, **192 B** for a formula cell (~40-char
   text). Rounded up to 128 B / 200 B.
3. **Budget.** 128 MiB worst-case resident for the whole table-undo image
   stack. Same order as the envelope `WORKER_STRUCTURAL_SNAPSHOT_MAX`
   already implies (100 × 2 × 2000 × 120 B ≈ 48 MB) and a small slice of a
   browser tab. Per-image budget = 128 MiB / 200 = **671 088 B**.
4. **Caps.**
   - `WORKER_TABLE_FORMULA_SNAPSHOT_MAX` = 671 088 / 200 ≈ 3 355 → **3 000**
   - `WORKER_TABLE_TOTALS_SNAPSHOT_MAX` = 671 088 / 128 ≈ 5 242 → **5 000**

The two differ only because their cells differ in cost: the formula image
is all formula cells, the totals band is mostly literals. The totals cap
is a safety net rather than a live constraint — the band is geometrically
2 rows × the table's column span, so it only binds on a table wider than
2 500 columns. `registry-only` has no cap: it stores no cells, so it can
never degrade.

Degradation contract is unchanged: over cap the mutation still executes,
the after-image is skipped, and the record is stored as *not-undoable* —
the image is never truncated.

### Measured after the fix

```
createTable   on a 612-cell workbook: snapshotSparse×0 · snapshotTables×2 · RPCs=3
deleteTable   on a 612-cell workbook: snapshotSparse×0 · snapshotTables×2 · RPCs=3
renameTable   on a 615-cell workbook holding 3 formulas: 5.6 ms ·
              snapshotSparse×2 raw sweep 1 230 cells, STORED image = 3 cells/image
setTableTotalsRow on a 2 012-cell workbook: 0.5 ms ·
              snapshotSparse×0 · snapshotRangeSparse×2 payload = 7 cells
rename image scaling: 113-cell workbook → raw sweep 226 cells (0.4 ms) ·
              1 813-cell workbook → raw sweep 3 626 cells (4.4 ms) ·
              STORED image = 1 formula cell in BOTH, and both undos applied
COST CURVE · workbook-wide rename sweep:
              2 500 cells → 5 000 swept, 0 retained, 5.7 ms (1.14 µs/cell)
             10 000 cells → 20 000 swept, 0 retained, 23.1 ms (1.15 µs/cell)
REGRESSION #26 · 500×5 sheet = 2 500 cells (over the retired 2000 cap):
              create / totals / rename undo ALL applied
```

The raw sweep for a rename is unchanged and cannot shrink — a
structured-reference rewrite can land on any sheet, so the *read* has to
be workbook-wide. What changed is what is **retained**: the stored image,
and therefore the cap and the memory, now count formulas, which is a small
constant on a data-shaped workbook.

### Budgets

| # | Budget | Kind | Measured |
| --- | --- | --- | --- |
| T1 | `createTable` / `deleteTable`: `snapshotSparse` + `snapshotRangeSparse` calls `=== 0` | work | 0 |
| T2 | `createTable` / `deleteTable`: `snapshotTables` calls `=== 2` | work | 2 |
| T3 | rename: `snapshotSparse` calls `=== 2`, raw payload `=== 2 × workbook` | work | exact |
| T4 | rename undo issues **zero** `clearRange` (in-place rewrite) | work | 0 |
| T5 | totals ports: `snapshotSparse === 0`, `snapshotRangeSparse === 2`, payload `<= 2 × 2 × table columns` | work | 7 |
| T6 | totals undo issues exactly **one** `clearRange` | work | 1 |
| T7 | rename undo applies on both a 113-cell and a 1 813-cell workbook | work | applied |
| T8 | over `WORKER_TABLE_FORMULA_SNAPSHOT_MAX`: one sweep, record not-undoable | work | 1 sweep |
| T9 | **500 × 5 (2 500 cells): create / totals / rename undo all apply** | work | applied |
| T10 | wall clock `< 3 s` | wall clock | 0.0-11 ms |

T9 is the regression gate for this defect. Verified to be a real gate:
temporarily restoring the old whole-workbook 2000-cell decision fails T9
and all six `#26 Table undo at 500 rows × 5 columns` round-trip tests in
`vnext-worker-tables-wasm.test.ts`.

---

## Gate results (2026-07-21)

```
npx tsc -p excel/solid-excel/tsconfig.json --noEmit --pretty false | grep -c 'error TS'
→ 6   (0 from this file; the 6th is an in-flight
       vnext-table-totals-static-wasm-parity.test.ts TS6133 from a
       concurrent slice. Baseline attributable here: 5)

npx jest excel/solid-excel --no-coverage --silent
→ Test Suites: 1 failed, 1 skipped, 93 passed, 94 of 95
   Tests:       1 failed, 6 skipped, 1397 passed, 1404 total
   The single failure is vnext-table-totals-static-wasm-parity.test.ts
   (hidden-row port parity), an in-flight file from a concurrent slice —
   unrelated to and unaffected by this gate.

npx jest excel/solid-excel/test/perf-functional-budgets.test.ts --no-coverage
→ 9 passed, 9 total (0.79 s)

EINFACH_SCALE=1 npx jest excel/solid-excel/test/perf-functional-budgets.test.ts --no-coverage
→ 9 passed, 9 total (1.04 s)
```

## Open items

1. ~~**F1 cap re-tuning**~~ — **CLOSED by #26.** The image is now scoped
   per operation and the two surviving caps are derived from a stated
   128 MiB memory ceiling; see § 3. What remains open is the *raw sweep*
   for a rename, which is still `O(workbook)` because a structured-ref
   rewrite can land on any sheet. Narrowing it would need the engine to
   report which cells it rewrote (an engine-side change), or the adapter to
   duplicate structured-reference parsing — deliberately not done.
2. **Filtered-sort projection path is not yet budgeted.** `readRange`
   branches to `readFilteredRange` when a filter is active; that branch has
   no gate. Same bounded-window claim, different code path.
3. **No budget on `setCellInput` recalculation fan-out.** A single edit
   feeding a long dependency chain is the other classic interactive
   latency risk; the recompute count is not yet asserted anywhere.
4. **No cross-sheet workload.** All budgets here are single-sheet. After
   #26 only the rename sweep is workbook-wide, and it retains formulas
   only — but a multi-sheet workbook still pays the read in proportion to
   sheets it does not touch. Unmeasured.
5. **CI reference numbers.** Every wall-clock figure is from one Apple M4.
   When this runs on CI, record a second column rather than loosening the
   ceilings.
