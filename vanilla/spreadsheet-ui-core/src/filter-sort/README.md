# filter-sort

Owns column-level filter VISIBILITY rules per sheet, plus the physical-sort command.

Sort is NOT state here. The display-permutation sort (`SortDirective`) was retired with parity #29 / task #24:
sorting is a physical engine DATA mutation dispatched through `runPhysicalSortAtom` → the host `sortRange` port,
so nothing about "which column is sorted" survives in UI-core view state.

## State Decision Template

- Source atoms:
  - `filterSortStateAtom`: map of sheetId → `FilterSortState` (filter `rules` only). Initial `{}`.
  - `filterDropdownAtom`: tracks which column header dropdown is open. Initial `{ status: 'closed' }`.
- Derived atoms: none in the first wave.
- Commands:
  - `setFilterSortAtom`: validates and stores per-sheet filter/sort state. Truncates oversized list rules.
  - `clearFilterSortAtom`: removes the sheet entry and closes any open dropdown.
  - `openFilterDropdownAtom`: opens the dropdown for a column on a sheet.
  - `closeFilterDropdownAtom`: closes the dropdown.
- Scale bound: one `FilterSortState` entry per active sheet. List rule values capped at `MAX_FILTER_LIST_VALUES` (10 000).
- Backend reads: `setFilterSort?` on `SpreadsheetBackend` (optional; UI core treats as unavailable when absent).
- Per-cell/per-row/per-col atom risk: none — no per-cell state created here.
- Tests: `test/filter-sort.test.ts`.

## Engine physical sort (design-engine-sort S5 / S6 / §10)

The toolbar / menu / filter-dropdown sort entrypoints dispatch ONE command, `runPhysicalSortAtom`. It is the ONLY
sort mechanism — there is no display-permutation fallback:

- **Source atoms:**
  - `sortRangeCapabilityBackingAtom` (`spreadsheet.sort.capabilityBacking`) — `sortRange` port witness, captured on dispatch.
  - `physicalSortDiagnosticBackingAtom` (`spreadsheet.sort.diagnosticBacking`) — last structured rejection, user-readable.
- **Derived atoms:**
  - `sortRangeSupportedAtom` (`spreadsheet.sort.supported`) — read-only capability projection.
  - `physicalSortDiagnosticAtom` (`spreadsheet.sort.diagnostic`) — read-only diagnostic projection (host may render a toast).
- **Commands:**
  - `runPhysicalSortAtom` (`spreadsheet.sort.runPhysical`) — reorders engine data whenever the host exposes `sortRange`,
    a valid region is resolved, and the key column sits inside it. Filter-active sheets sort physically too (the
    filtered-out rows ride in `excludedRows`). Anything else is a FAIL-CLOSED rejection: no port → `'unsupported'`
    diagnostic (`PHYSICAL_SORT_CAPABILITY_ERROR`), no region → `'invalid-range'`, key outside → `'key-out-of-range'`.
    Reuses the single `activeFilterSort*` lane (so a filter mutation and a sort never overlap) and the entrypoint status
    vocabulary. Pushes ONE `range.sort` history entry only when `movedRows > 0` (a no-op is not an undo step, design §7);
    structured rejections set the diagnostic and record nothing.
  - `captureSortRangeCapabilityAtom` (`spreadsheet.sort.captureCapability`) — capture the witness without dispatching.
  - `clearPhysicalSortDiagnosticAtom` (`spreadsheet.sort.clearDiagnostic`).
- Excluded-rows payload: `buildSortExcludedRows` unions `viewportHiddenAtom` (manually hidden rows) with the
  filter-hidden rows derived from the consumed visible projection, both clipped to the sort range. Summary-row
  pinning needs cell reads UI core does not own (known v1 gap, design §6.1).
- Backend reads: `sortRange?` on `SpreadsheetBackend` (optional). ABSENCE MEANS NO SORT: hosts gate their sort
  entrypoints on `sortRangeSupportedAtom` (toolbar button + filter-dropdown sort section) and on the `'sortRange'`
  menu capability key (Data → Sort asc/desc), so the fail-closed TS worker shows no sort affordance at all.
- Tests: `test/physical-sort.test.ts`.
