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
