# filter-sort

Owns column-level filter rules and sort directives per sheet.

## State Decision Template

- Source atoms:
  - `filterSortStateAtom`: map of sheetId → `FilterSortState` (rules + directives). Initial `{}`.
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

## Engine physical sort (design-engine-sort S5)

The toolbar / menu sort entrypoints dispatch ONE command, `runPhysicalSortAtom`, which routes by capability:

- **Source atoms:**
  - `sortRangeCapabilityBackingAtom` (`spreadsheet.sort.capabilityBacking`) — `sortRange` port witness, captured on dispatch.
  - `physicalSortDiagnosticBackingAtom` (`spreadsheet.sort.diagnosticBacking`) — last structured rejection, user-readable.
- **Derived atoms:**
  - `sortRangeSupportedAtom` (`spreadsheet.sort.supported`) — read-only capability projection.
  - `physicalSortDiagnosticAtom` (`spreadsheet.sort.diagnostic`) — read-only diagnostic projection (host may render a toast).
- **Commands:**
  - `runPhysicalSortAtom` (`spreadsheet.sort.runPhysical`) — physical when the host exposes `sortRange`, a valid region is
    resolved, the key column sits inside it, and no active column filter stands in the way; otherwise delegates to
    `runFilterSortEntrypointAtom` (display permutation fallback). Reuses the single `activeFilterSort*` lane and the
    entrypoint status vocabulary. Pushes ONE `range.sort` history entry only when `movedRows > 0` (a no-op is not an undo
    step, design §7); structured rejections set the diagnostic and record nothing.
  - `captureSortRangeCapabilityAtom` (`spreadsheet.sort.captureCapability`) — capture the witness without dispatching.
  - `clearPhysicalSortDiagnosticAtom` (`spreadsheet.sort.clearDiagnostic`).
- Excluded-rows payload: `buildSortExcludedRows` clips `viewportHiddenAtom` (hidden rows, flip step 2) to the sort range.
  Filtered-out rows depend on flip step 3 — an active-filter sheet routes to the display fallback instead; summary-row
  pinning needs cell reads UI core does not own (known v1 gap, design §6.1).
- Backend reads: `sortRange?` on `SpreadsheetBackend` (optional; absence keeps the display permutation available so the
  entry is not hidden).
- Tests: `test/physical-sort.test.ts`.
