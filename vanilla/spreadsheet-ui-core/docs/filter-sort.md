# filter-sort

Column filtering for `@einfach/spreadsheet-ui-core`.

Rewritten 2026-07-21 for #27 (filter redo). The previous version of this file
described a **display-compaction** filter (matching rows packed into consecutive
display slots, `DisplayCell.originalRow` mapping back to the workbook) and a
`SortDirective` list owned here. Neither exists any more: filtering **hides**
rows the way Excel does, and sorting is a physical engine mutation. See
`solid/excel/docs/online-excel-parity/design-filter-hidden-rows.md` for the
decision record and `../src/filter-sort/README.md` for the atom inventory.

---

## What this feature owns

**Filter visibility rules, per sheet.** Nothing else. In particular:

- **Sort is not state here.** The display-permutation sort was retired with
  parity #29 / task #24. Sorting is a physical engine data mutation dispatched
  through `runPhysicalSortAtom` → the host `sortRange` port. `SortDirective`,
  `FilterSortState.directives` and `SetFilterSortRequest.directives` were
  deleted; do not reintroduce them.
- **Row ordering is not owned here, and is not owned by the backend view layer
  either.** Row order is always source order. A filter never moves a row.

---

## The core semantic: hide, do not compact

A filter **withholds** the rows it hides. Every surviving row stays at its own
physical index, so **display row IS source row** — one coordinate system, no
translation layer.

```
source rows          filter: value >= 20        rendered
------------         -------------------        --------
0  header                                       row 1   header
1  10                 filtered out              (absent)
2  20                                           row 3   20
3  30                                           row 4   30
```

Row numbers therefore **skip** (`1, 3, 4`), exactly as they do for manually
hidden rows and exactly as they do in Excel. This is the visible product goal of
#27.

Consequences that fall out of the identity, rather than being implemented:

- Edit round-trips address rows directly. The mutation gateway's display→source
  remap half is gone (`../src/editing/README.md`).
- `DisplayCell.originalRow` is deleted. Backends must not reintroduce a per-cell
  physical-row echo.
- Status-bar aggregates count only visible cells for free: hidden rows produce no
  `DisplayCell`, and the aggregation works on cell existence rather than row
  arithmetic.
- A bare row index can no longer mean two different rows depending on whether a
  filter happens to be active. The class of bug where a manually hidden row
  "jumped" to a different row after filtering is structurally unrepresentable.

---

## Two hidden-row sets, never merged

| set                        | atom                       | origin                    | history                  |
| -------------------------- | -------------------------- | ------------------------- | ------------------------ |
| manually hidden rows/cols  | `viewportHiddenAtom`       | a user command            | own local-replay entries |
| filter-hidden rows         | `viewportFilterHiddenAtom` | derived from filter rules | none (the rules' undo is its undo) |

Both live in `../src/viewport/effective-hidden.ts` (**not** in a
`filter-sort/filter-hidden.ts` — the design doc planned that path and it was not
taken). `effectiveHiddenAtom` is the derived union.

They cannot be merged, because three rules need to tell the origins apart:

1. `SUBTOTAL(1-11)` excludes filter-hidden rows but **includes** manually hidden
   ones; `SUBTOTAL(101-111)` excludes both.
2. Copy skips filter-hidden rows but **copies** manually hidden ones.
3. `Unhide Rows` over a filtered region must not cancel the filter.

**Which set does a consumer read?**

- **Union (`effectiveHiddenAtom`)** — rendering and navigation only: the grid's
  rendered row window, and `go-to`'s `Go To Special → Visible cells only`.
- **Filter subset (`viewportFilterHiddenAtom`)** — everything that *moves data*:
  copy / Copy As / TSV + image export, delete-rows planning, the
  `remove-duplicates` and `text-to-columns` dense row scans,
  `buildSortExcludedRows`, and the SUBTOTAL push to the engine.

The rule of thumb: **anything that touches data reads the filter subset; only
navigation and painting read the union.** Reading the union in a data path
manufactures a divergence from Excel (Excel's Remove Duplicates, for instance,
operates on the whole selection *including* manually hidden rows).

---

## Who computes visibility

**The engine, once, when the rules are applied.** Not during projection. (Since the
hidden-row **sink-down** the worker adapter forwards `setFilterSort` to the engine's
`applyFilter`, which runs the predicate inside Rust; `static-backend` runs its own TS
predicate as a *second engine*. Either way it is one whole-column scan, not a
per-projection derivation, and the result rides back on the ACK — the UI-core contract
below is unchanged. See "Engine contract".)

A filter predicate needs the *whole column*; a projection is a bounded window.
So `setFilterSort` runs one whole-column predicate scan and returns the complete
filtered-out source row set on the ACK:

```ts
export interface SetFilterSortResult extends BackendMutationResult {
  /** 0-based SOURCE rows the rules filtered out, for the WHOLE scanned extent. */
  hiddenRowIndices?: readonly number[]
}

setFilterSort?(request: SetFilterSortRequest): Promise<SetFilterSortResult>
```

`runFilterSortMutationAtom` writes it into `viewportFilterHiddenAtom` in the same
tick as the rules, and only on a matched ACK. That atom is then the canonical
answer to "is this row painted?" — nothing re-derives it from the projection.

- **Absent `hiddenRowIndices`** means the host cannot compute visibility. UI core
  **clears** the set rather than keeping a stale one: after the rules change,
  yesterday's answer is not a conservative fallback, it hides the wrong rows. The
  feature degrades to "rules recorded, nothing hidden".
- **Empty array** is the distinct (and normal) statement "the rules hid nothing".

Scan budget is the pre-existing `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000`
(rows × predicate columns) with a structured `FILTER_SORT_SOURCE_TOO_LARGE`
rejection — fail-closed, never truncated. Clearing a filter carries no effect
payload and never scans, so an over-budget state is always exitable.

---

## Snapshot semantics — filtering is not live

**The filter set is a snapshot taken when the rules are applied. Editing a cell
does not move its row in or out of view.**

This is deliberate convergence on Excel, whose `Data → Reapply` (`Ctrl+Alt+L`)
command exists precisely because filter results are a snapshot. The pre-#27
implementation recomputed the permutation on every revision bump, which made our
filter *more live than Excel's* — a divergence, not a feature. Both adapters now
keep the filter-hidden set out of the `bumpRevision()` invalidation path.

### `Data → Reapply` — the recompute entrypoint

The escape hatch snapshot semantics requires. **Implemented** (#27 S7 remainder,
closing errata E8): `reapplyFilterAtom` + `reapplyFilterDisabledReasonAtom` in
`../src/filter-sort/index.ts`, the `data.reapply` menu entry, and `Ctrl+Alt+L`.

**What it does:** re-dispatches `setFilterSort` carrying the sheet's *already
committed* rules, and writes the fresh ACK through the same
`setViewportFilterHiddenRowsAtom` sink the dropdown uses. It cannot change what
is filtered — only which rows currently satisfy it.

**Truth source — the host, not a second evaluator.** Reapply reuses the
adapter's whole-column scan rather than re-deriving visibility in UI core. A
UI-core recompute would be a *second predicate evaluator* that could silently
disagree with the first; it would also be window-bounded (the resurrected
`deriveFilterHiddenRows` gap) and would sit outside the host's
`MAX_FILTER_SORT_PREDICATE_CELLS` fail-closed budget. This does not contradict
CANONICAL_OWNERSHIP #29: UI core still *owns* the fact — the host is an
executor, exactly as it is for the TSV / image export ports.

**Filters only, not sort.** Excel's Reapply covers sort as well (verified: MS
"Reapply a filter and sort, or clear a filter"; `Ctrl+Alt+L` is documented as
reapplying a column sort). Here it is *inexpressible*, not skipped — sort
stopped being view state with #24, so `FilterSortState` holds `rules` and
nothing else, and re-running a physical sort would be a data mutation behind a
visibility command.

**Not in the undo stack.** Applying a filter records no history entry, so a
Reapply entry would be an undo step with no counterpart. Microsoft documents
Excel's Reapply/undo interaction *neither way* — this is consistency with Apply,
**an unverified default rather than verified parity**.

**Disabled, not hidden**, when the host lacks `setFilterSort`, the lane is busy,
the dropdown is open, there is no active sheet, or — the common case — the sheet
has no committed rules. `reapplyFilterDisabledReasonAtom` is a pure derivation
the host reads like any other menu gate.

Structural changes are handled by shifting, not rescanning: insert/delete rows
remap the filter set through `remapIndexSetAfterStructuralShift`, at three
layers — `applyViewportFilterHiddenStructuralShiftAtom` in UI core (row axis
only; a filter set is a row set, so column shifts are a no-op for it), each
adapter's local snapshot, and the engine copy. Missing any one layer leaves the
set pointing at a *different real row*, which shows up as "the header is
swallowed and a filtered-out value reappears".

Since sink-down slice E8 this is the **forward** shift only — the same-tick render
projection. The filter set carries no UI-core undo side payload any more: a structural
undo/redo restores the engine's *owned* filter (rules + derived hidden set) from the
engine's own snapshot (`snapshotFilters` / `restoreFilters` on the worker; the
full-sheet capture on static), and the provider re-hydrates this render cache from
`readSheetHiddenState.filterRows` (`reconcileFilterHiddenFromEngine` in
`solid/excel/src-vnext/provider/history-dispatch.ts`). See
`solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md` §6.3.

---

## User-visible behaviour changes from #27

Two of these are perceptible to anyone used to the previous build and should be
called out in release notes:

1. **Row numbers skip.** The product goal. (Excel additionally tints visible row
   numbers blue; that is a pure visual cue and is not implemented.)
2. **Paste and fill write into filtered-out rows.** Excel pastes a contiguous
   block over hidden rows — its well-known data-overwrite trap, and its actual
   behaviour. The identity mapping satisfies this with zero code, so this is a
   *parity fix*: display compaction used to skip filtered rows on paste, which
   diverged from Excel. Users who relied on the old behaviour will notice.
3. **Filtering is no longer live.** Changing a cell's value does not make its row
   appear or disappear; see the snapshot section above. `Data → Reapply`
   (`Ctrl+Alt+L`) is the explicit recompute, exactly as in Excel.
4. **Merged cells inside a filtered region render again.** The blanket
   suppression of merge metadata while a filter was active is lifted — merge
   spans are expressible again under hidden semantics.
5. **`SUBTOTAL(1-11)` shrinks when a filter is active**, because it now excludes
   filtered-out rows; `(101-111)` now excludes them too, on top of manually
   hidden rows. This is a bug fix. It landed ahead of the rest (slice S4).

Explicitly **unchanged**: copy from a filtered region already skipped hidden rows
and still does; `Go To Special → Visible cells only` remains the only explicit
visible-cells path and is not implemented as a user-facing command.

---

## Engine contract

Since the **hidden-row sink-down**
(`solid/excel/docs/online-excel-parity/design-engine-hidden-rows.md`, slices E2–E8,
2026-07-22) the engine **owns** the filter — the rules, the derived hidden set, and
the predicate evaluation itself — and both per-sheet hidden row sets, so `SUBTOTAL`
can express both bands:

| band                | excludes                              |
| ------------------- | ------------------------------------- |
| `SUBTOTAL(1-11)`    | filter-hidden rows                    |
| `SUBTOTAL(101-111)` | manually hidden ∪ filter-hidden rows   |

Rust keeps two invalidation epochs (`manual_hidden_epoch` / `filter_hidden_epoch`)
so pushing a manual hide does not dirty every `SUBTOTAL(1-11)` in the workbook.

**Filter — the engine evaluates the predicate.** On the worker, `setFilterSort`
forwards its rules to the engine's `applyFilter` (WASM `js_name` `applyFilter`), which
runs the predicate ONCE inside Rust and commits the rules + derived hidden set
atomically; the hidden rows ride back in the resolved value (`sortRange` convention —
a structured `source-too-large` refusal is *returned*, never thrown). `reapplyFilter`
/ `clearFilter` are recompute and teardown. The host-side predicate scan the adapter
used to run is **gone** (E5). `static-backend` is itself a second engine (its own
`evaluateFormula`), so it legitimately keeps a TS predicate
(`src-vnext/adapter/filter-predicate.ts`, a verbatim move out of UI core in E4) pinned
to the Rust `apply_filter` result by a golden-parity test. UI core has **zero**
predicate knowledge — it keeps only the `ColumnFilterRule` wire type, still calls the
same `setFilterSort` port, and still stores the ACK's `hiddenRowIndices` into
`viewportFilterHiddenAtom`. That contract is unchanged.

**Manual hidden rows — optimistic feed.** Pushed to the engine over
`setEvalHiddenRows` (whole-set replace) from UI core's `feedAndReconcileHiddenRows`,
written optimistically then UNCONDITIONALLY reconciled against `readSheetHiddenState`
— **not** through a `hideRows` port (the worker adapter never exposed one) and **not**
through the deleted `eval-hidden-rows-bridge.ts`.

**Undo — engine snapshot.** A structural undo/redo of an active filter restores the
engine's owned filter from its own snapshot primitive (`snapshotFilters` /
`restoreFilters`, the REPLACE twin of `restoreTables`); the provider then re-hydrates
`viewportFilterHiddenAtom` from `readSheetHiddenState.filterRows`. The E7-era
`setEvalFilterHiddenRows` re-push and adapter-memory before/after array are gone;
`setEvalFilterHiddenRows` is now **unused by the adapter**, but the WASM port stays as
additive INV-4 baggage (whole-set replace, empty clears, never throws).

**Persistence.** Persistence v1 now carries the hidden rows and the autoFilter state
(`hidden` + `filters` fields, additive / back-compatible), so save/load round-trips
them — closing the xlsx parity gap.

**Degradation — TS worker (fail-closed).** The TS worker declares
`engineHiddenState: false` (plus `evalHiddenRows` / `evalFilterHiddenRows` false) and
answers UNSUPPORTED for the eleven engine-owned commands — no success-shaped fake ACK.
Filtering is withheld and the manual set never reaches the engine, so both SUBTOTAL
bands fall back to pre-sink-down behaviour. The view still hides the rows correctly, so
the result is *conservative*, never wrong.

Note that export filtering (TSV / image) deliberately does **not** cross the engine:
the hidden set is applied at the main-thread adapter boundary
(`RangeTsvExportRequest.hiddenRows` / `RangeImageExportRequest.hiddenRows`), so it
works identically on the WASM worker, the TS worker's single-shot fallback, and the
static backend, with no capability gate and no wasm-pkg version skew.

---

## Backend port contract

`setFilterSort` is **optional**. When absent, UI core treats filtering as
unavailable, `setFilterSortAtom` is a no-op, and the framework binding hides the
controls.

- Apply the rules and then answer projections that **omit** the hidden rows
  entirely — do not emit blank placeholder cells for them, and do not emit
  format-only cells for them either. Manually hidden rows are the opposite case:
  the backend does not know they exist, so their cells travel normally.
- `DisplayCell.row` is the physical (zero-based) workbook row, always.
- Return the complete `hiddenRowIndices` for the scanned extent.
- Advance `BackendMutationResult.revision` so the visible-window projection is
  re-requested.
- Do not invalidate the filter set on unrelated mutations — that is what makes a
  filter live, and Excel's is not.

Export ports take the hidden set as an optional input rather than deriving it:
`RangeTsvExportRequest.hiddenRows` and `RangeImageExportRequest.hiddenRows`
(both `ReadonlySet<number> | readonly number[]`, both ADDITIVE — omitting them
gives the unfiltered behaviour). UI core is the authority on filter visibility;
these ports are executors.

---

## Integration points

- **Projection** — filtered rows are absent from the visible window; surviving
  rows keep their physical indices. The window expands via
  `getVisibleWindowWithHidden` so the visible row count stays constant.
- **Selection** — a range over filter-hidden rows is discontiguous in what it
  paints, but contiguous in coordinates.
- **Clipboard / export** — copy, Copy As, TSV chunk export and image export all
  drop filter-hidden rows. Three knock-on rules the encoders must honour: the
  Markdown header is the first *visible* row of the rect; HTML `rowspan` is
  re-clipped to the visible row count and re-anchored; and the TSV origin marker
  is the first *actually emitted* row, because paste uses it to shift relative
  references.
- **Operations** — deleting a row span while a filter is active deletes only the
  visible rows, planned as descending maximal runs
  (`planFilterVisibleRowDeletions` → `runFilterVisibleRowDeleteAtom`). Descending
  is a hard requirement: delete the high run first and the low runs need no
  remapping. An all-hidden span dispatches **nothing** (`'no-visible-rows'`) and
  never falls back to the raw span.
- **Dense row scans** — `remove-duplicates` and `text-to-columns` walk
  `[startRow..endRow]` densely against a sparse projection, so a filter-hidden row
  looks identical to a genuinely blank row. They must be fed the filter subset as
  `hiddenRows`, or every hidden row past the first is judged a duplicate of it and
  handed to `backend.removeRows` — silent data loss. This hardening deliberately
  landed *before* the adapter flip.
- **Hidden rows** — see "Two hidden-row sets" above. No coordinate composition is
  involved; both sets are in physical row space.

---

## Risks & open questions

- **Summary-row pinning in `buildSortExcludedRows`** needs cell reads UI core does
  not own; still a known v1 gap.
- **`AGGREGATE`'s ignore-hidden option bits** (1/3/5/7) are parsed and validated
  but ignored — `run_subtotal` is hard-coded. The two-set seam #27 built is the
  base for implementing it; tracked as `eval.rs` TODO(#32 §6.3).
- **Formatting a filtered region** — whether Excel applies it to visible cells
  only is unverified. Not implemented either way.
- **Stable sort across revisions.** The backend must document whether its sort is
  stable; UI core cannot enforce it.
- **List-rule size.** `MAX_FILTER_LIST_VALUES = 10000`; oversized rules are
  truncated before dispatch.
- **Persistence.** Landed with the sink-down: persistence v1 now carries the hidden
  rows and the autoFilter rules (`hidden` + `filters` fields, additive), so save/load
  round-trips them, closing the xlsx parity gap.

---

## Test surface

- `test/filter-sort.test.ts` — rules, dropdown lifecycle, capability degradation,
  ACK matching.
- `test/reapply-filter.test.ts` — Reapply: the disabled gate, the re-dispatch,
  and the counter-example that data changing alone moves nothing.
- `test/effective-hidden.test.ts` — the two sets, the union, whole-set replace,
  per-sheet isolation, structural shift.
- `test/physical-sort.test.ts` — `buildSortExcludedRows` unions both sets.
- `test/mutation-gateway.test.ts` — identity addressing, protection gate intact.
- `test/remove-duplicates.test.ts`, `test/text-to-columns.test.ts` — hidden rows
  never reach `removeRows` / are skipped by the dense scan.
- `test/copy-as.test.ts`, `test/copy-as-image.test.ts`, `test/operations.test.ts`
  — visible-only export and delete planning.
- Host side: `solid/excel/test/vnext-reapply-filter.test.ts` (Reapply against the
  real static backend, both counter-example directions),
  `vnext-reapply-filter-keyboard.test.tsx` (`Ctrl+Alt+L` grid wiring),
  `solid/excel/test/vnext-filter-hidden-rows.test.ts`,
  `vnext-filter-hidden-export.test.ts`, `vnext-worker-filter-sort.test.tsx`,
  `vnext-worker-filter-subtotal-wasm.test.ts` (real Rust engine, both bands),
  `vnext-structural-remap-static.test.ts`.
- e2e: `vnext-filter-sort-real-backend.spec.ts`,
  `vnext-filter-structural-shift-real-backend.spec.ts`,
  `vnext-reapply-filter-real-backend.spec.ts`, `toolbar-filter-sort.spec.ts`.
</content>
</invoke>
