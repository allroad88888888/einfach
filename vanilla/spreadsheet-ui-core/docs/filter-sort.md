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

**The host adapter, once, when the rules are applied.** Not during projection.

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

> **Known gap: there is no Reapply entrypoint yet.** The design allocated
> `reapplyFilterAtom` + a `Data → Reapply` menu item + `Ctrl+Alt+L` to slice S7;
> none of the three landed. Verified 2026-07-21: no `reapplyFilterAtom` export, no
> menu entry, no keybinding. The only way to recompute today is to re-open the
> column dropdown and re-confirm the rules, which re-sends `setFilterSort`. This is
> the largest open item from #27.

Structural changes are handled by shifting, not rescanning: insert/delete rows
remap the filter set through `remapIndexSetAfterStructuralShift`, at three
layers — `applyViewportFilterHiddenStructuralShiftAtom` in UI core (row axis
only; a filter set is a row set, so column shifts are a no-op for it), each
adapter's local snapshot, and the engine copy. Missing any one layer leaves the
set pointing at a *different real row*, which shows up as "the header is
swallowed and a filtered-out value reappears".

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
   appear or disappear; see the snapshot section above (and the missing-Reapply
   gap).
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

The engine holds **two** per-sheet hidden row sets, pushed over two independent
ports, so `SUBTOTAL` can express both bands:

| band                | excludes                              |
| ------------------- | ------------------------------------- |
| `SUBTOTAL(1-11)`    | filter-hidden rows                    |
| `SUBTOTAL(101-111)` | manually hidden ∪ filter-hidden rows   |

- Manual set: `setEvalHiddenRows` (pre-existing, unchanged by #27).
- Filter set: `setEvalFilterHiddenRows` (added by #27; WASM `js_name`
  `setEvalFilterHiddenRows`, whole-set replace, empty clears, never throws).

Both are additive: the WASM API signature snapshot gains a line and INV-4's
delete/modify hard-failure never fires. Rust keeps two invalidation epochs
(`manual_hidden_epoch` / `filter_hidden_epoch`) so that pushing a manual hide does
not dirty every `SUBTOTAL(1-11)` in the workbook.

The push is **not** routed through `eval-hidden-rows-bridge.ts`. Each adapter
pushes the filter set from inside its own `setFilterSort`, before the ACK
(`worker-workbook-backend` over the port; `static-backend` straight into its
evaluator input). Adding a bridge lane would create a second writer for the same
fact, one tick later than the adapter's. Do not "fix" this without first adding a
`SpreadsheetBackend.setEvalFilterHiddenRows` port and removing both internal
pushes.

**Three-tier degradation, all silent and none dishonest:**

1. Both ports present (WASM worker + current wasm-pkg) → full two-band semantics.
2. `setEvalHiddenRows` only (older wasm-pkg) → the filter set never reaches the
   engine; both bands fall back to pre-#27 behaviour. The view still hides the
   rows correctly, so the result is *conservative*, never wrong.
3. Neither (TS worker) → pre-#27 behaviour, matching the existing
   `evalHiddenRows: false` degradation shape.

Note that export filtering (TSV / image) deliberately does **not** use this
mechanism: the hidden set is applied at the main-thread adapter boundary and never
crosses `postMessage`, so it works identically on the WASM worker, the TS worker's
single-shot fallback, and the static backend, with no capability gate and no
wasm-pkg version skew.

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

- **No `Data → Reapply` entrypoint.** See the snapshot section. Largest open item.
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
- **Persistence.** Excel stores autoFilter state in the file format. Whether the
  filter-hidden set (or the rules) should be persisted is out of scope.

---

## Test surface

- `test/filter-sort.test.ts` — rules, dropdown lifecycle, capability degradation,
  ACK matching.
- `test/effective-hidden.test.ts` — the two sets, the union, whole-set replace,
  per-sheet isolation, structural shift.
- `test/physical-sort.test.ts` — `buildSortExcludedRows` unions both sets.
- `test/mutation-gateway.test.ts` — identity addressing, protection gate intact.
- `test/remove-duplicates.test.ts`, `test/text-to-columns.test.ts` — hidden rows
  never reach `removeRows` / are skipped by the dense scan.
- `test/copy-as.test.ts`, `test/copy-as-image.test.ts`, `test/operations.test.ts`
  — visible-only export and delete planning.
- Host side: `solid/excel/test/vnext-filter-hidden-rows.test.ts`,
  `vnext-filter-hidden-export.test.ts`, `vnext-worker-filter-sort.test.tsx`,
  `vnext-worker-filter-subtotal-wasm.test.ts` (real Rust engine, both bands),
  `vnext-structural-remap-static.test.ts`.
- e2e: `vnext-filter-sort-real-backend.spec.ts`,
  `vnext-filter-structural-shift-real-backend.spec.ts`,
  `toolbar-filter-sort.spec.ts`.
</content>
</invoke>
