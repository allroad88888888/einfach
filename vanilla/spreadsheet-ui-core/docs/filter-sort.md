# filter-sort

Filter and sort feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Expose column-header filter dropdowns and multi-key sort controls as atoms and
commands. The UI core owns active filter rules and sort directives per sheet.
The backend owns row ordering and row visibility; `readVisibleProjection` results
reflect the derived virtual row index space after filtering and sorting are applied.

---

## Scope

- Declare `filterSortStateAtom` per active sheet storing the current rule list and
  sort directives.
- Declare `filterDropdownOpenAtom` tracking which column header dropdown is open.
- Declare `setFilterSortAtom` command forwarding a `SetFilterSortRequest` to the backend.
- Declare `clearFilterSortAtom` resetting all rules and directives for the sheet.
- Filter variants: text-equals, text-contains, numeric range (min/max bounds),
  list (explicit set of allowed values).
- Sort: one or more `SortDirective` items, each naming a column and direction
  (`'asc'` or `'desc'`). First directive is the primary key; subsequent entries
  are secondary keys applied in order.
- Filter and sort state is per-sheet; switching sheets resets both.

**Out of scope**

- Cross-sheet sort (sorting one sheet by values in another).
- Table objects or named range objects wrapping filter/sort.
- Formula-driven filter (`FILTER`, `SORT` worksheet functions).
- Server-side persistent filter/sort saved inside the workbook file format.

---

## State (UI core)

**`filterSortStateAtom`** — `atom<FilterSortState>`
Active rules and directives for the current sheet. Resets on sheet switch or
`clearFilterSortAtom`.

```ts
filterSortStateAtom.debugLabel = 'spreadsheet.filterSort.state'
```

**`filterDropdownOpenAtom`** — `atom<number | null>`
Column index of the open filter dropdown; `null` when none is open.

```ts
filterDropdownOpenAtom.debugLabel = 'spreadsheet.filterSort.dropdownOpen'
```

**`setFilterSortAtom`** — command. Validates rules and directives, dispatches to
backend, writes normalised state on success, closes any open dropdown.

```ts
setFilterSortAtom.debugLabel = 'spreadsheet.filterSort.set'
```

**`clearFilterSortAtom`** — command. Sends empty rules/directives, resets atom state,
closes any open dropdown.

```ts
clearFilterSortAtom.debugLabel = 'spreadsheet.filterSort.clear'
```

**`toggleFilterDropdownAtom`** — command. Opens the dropdown for a column; closes
it if already open. Replaces any other open dropdown.

```ts
toggleFilterDropdownAtom.debugLabel = 'spreadsheet.filterSort.toggleDropdown'
```

Scale bound: rule list bounded by column count (one rule per column). Sort
directive list capped at a small constant (e.g. 8 keys). No per-cell, per-row,
or per-column atoms.

---

## Types

```ts
export type ColumnFilterRule =
  | { kind: 'equals';   colIndex: number; value: string;            caseSensitive?: boolean }
  | { kind: 'contains'; colIndex: number; value: string;            caseSensitive?: boolean }
  | { kind: 'range';    colIndex: number; min?: number; max?: number }
  | { kind: 'list';     colIndex: number; values: readonly string[] }

export type SortDirection = 'asc' | 'desc'

export interface SortDirective {
  colIndex: number
  direction: SortDirection
}

export interface FilterSortState {
  rules: readonly ColumnFilterRule[]
  directives: readonly SortDirective[]
}

export interface SetFilterSortRequest extends SheetRef {
  kind: 'set-filter-sort'
  rules: readonly ColumnFilterRule[]
  directives: readonly SortDirective[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
```

---

## Backend port

One optional method added to `SpreadsheetBackend`:

```ts
setFilterSort?(request: SetFilterSortRequest): Promise<BackendMutationResult>
```

**Optional.** When absent the UI core treats filter/sort as unavailable;
`setFilterSortAtom` is a no-op and the framework binding layer should hide the
controls.

**Contract:**

- The backend applies rules and directives before serving the next
  `readVisibleProjection` result.
- `DisplayCell.row` is the **displayed** virtual row index within the
  post-filter/post-sort sequence, not the physical workbook row.
- Backends must populate `originalRow?: number` on `DisplayCell` when filter or
  sort is active. This carries the physical (zero-based) workbook row, enabling
  round-trips for edit commands (`setCellInput`, `clearRange`, etc.).
- When no filter or sort is active, `originalRow` may be omitted; consumers fall
  back to `DisplayCell.row`.
- `BackendMutationResult.revision` must advance so that the visible-window
  projection is re-requested automatically.

---

## Integration points

- **Projection** — filtered rows are absent from the visible window; the window
  covers only the virtual range of rows that pass active rules.
- **Viewport** — visible row count differs from physical row count when a filter
  is active; scroll metrics recalculate against the virtual row count. See
  viewport planning doc.
- **Selection** — range selection over filter-hidden rows is discontiguous.
  Arrow nav skips hidden rows via `resolveDataEdge`. See selection planning doc.
- **Clipboard** — `exportRangeTsv` receives a virtual range; the backend maps to
  physical rows, so filtered rows are excluded naturally. See clipboard planning
  doc.
- **Keyboard** — Ctrl+A selects the visible (non-filtered) range only. See
  keyboard planning doc.
- **Operations** — insert/delete row commands near filter boundaries use
  `originalRow`, not virtual display coordinates. See operations planning doc.
- **Hidden rows** — filter-hidden rows and explicitly hidden rows are separate
  mechanisms; the backend composes both before returning the virtual index space.
  Reference the hidden rows planning doc for the hidden-row state contract.

---

## Risks & open questions

- **Stable sort across revisions.** The backend must document whether its sort is
  stable; the UI core cannot enforce it. Unstable sort causes visible row flicker
  between projection refreshes triggered by unrelated edits.

- **Edits inside a filtered view.** Command layer must use `originalRow` for
  physical coordinates. Absence of `originalRow` when filter/sort is active will
  silently target the wrong physical row; warn in debug builds.

- **Undo restoring prior order.** Each `setFilterSort` call should produce a
  `HistoryEntry`. The backend must represent a filter/sort transition as an
  invertible operation in its transaction log. See history planning doc.

- **Interaction with hidden rows.** When both filter and explicit hidden-row state
  are active, the composed `originalRow` mapping must be defined jointly with the
  hidden rows feature to avoid ambiguity.

- **Perf of large filter sets.** `ListFilterRule.values` is unbounded in the
  type; define a cap (e.g. 10 000 items) and reject oversized rules in
  `setFilterSortAtom` before sending to the backend.

- **Dropdown state on sheet switch.** `filterDropdownOpenAtom` must close and
  `filterSortStateAtom` must reset when the active sheet changes. Verify that the
  reset order (close dropdown first, then reset state) avoids a transient render
  with stale column indices.

---

## Test surface

All tests live in `test/filter-sort.test.ts`.

- `filterSortStateAtom` initialises to empty rules and directives.
- `setFilterSortAtom` is a no-op when the backend omits `setFilterSort`.
- `setFilterSortAtom` writes normalised state after a successful mutation result.
- `clearFilterSortAtom` resets rules, directives, and open dropdown.
- `toggleFilterDropdownAtom` opens a closed dropdown, closes an open one, and
  replaces an open dropdown when a different column is toggled.
- `setFilterSortAtom` closes the open dropdown on success.
- Duplicate column indices in sort directives are rejected before dispatch.
- `NumericRangeFilterRule` with `min > max` is rejected before dispatch.
- `ListFilterRule` exceeding the max-values cap is rejected before dispatch.
- `DisplayCell.originalRow` is preferred over `row` for edit round-trips when
  filter/sort is active (verified via a mock projection result).
