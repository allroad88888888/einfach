# remove-duplicates

Owns the Data → Remove Duplicates dialog. The user picks a range, the
dialog lists the columns in that range as checkboxes (all checked by
default), and OK scans the selection: rows that match any earlier row
across every checked column are reported to the host, which dispatches
`backend.removeRows`.

UI core stays pure — it computes the row indices to drop and surfaces
them through the preview atom. The Solid layer is responsible for the
actual `removeRows` round-trip and undo bookkeeping.

## State Decision Template

- **Source atoms:**
  - `removeDuplicatesOpenAtom` — boolean, dialog visibility.
  - `removeDuplicatesRangeAtom` — `RemoveDuplicatesRange | null`. Set
    by the open command; null when closed.
  - `removeDuplicatesKeyColumnsAtom` — `ReadonlySet<number>` of
    sheet-absolute column indices currently checked. The open command
    seeds this with every column in the range; an empty set is a valid
    transient state (preview reports `noKeyColumns: true`).
  - `removeDuplicatesComparisonAtom` — `'exact' | 'caseInsensitive' |
    'trim' | 'trimAndIgnoreCase'`. Defaults to `'exact'`. Survives
    dialog close (last-used wins per session, matching Excel).
  - `removeDuplicatesExcludeHeaderAtom` — boolean, defaults `true`.
    Header row is always reported back via `result.headerRow` so the
    host can label / preserve it.
  - `removeDuplicatesScanInputCellsAtom` — `ReadonlyArray<DisplayCell>`.
    The Solid layer pushes the projection cells in here on open; kept
    in an atom (rather than a Solid signal) so the 1.9.12 Provider
    remount hazard does not strand it.

- **Derived atoms:**
  - `removeDuplicatesPreviewAtom` — `RemoveDuplicatesScanResult | null`.
    Null when the dialog is closed OR no range is set. When the key set
    is empty post-deselect, returns a synthetic result with
    `noKeyColumns: true` instead of throwing — the dialog uses that
    flag to disable OK. When the set has at least one in-range column,
    delegates to the pure `findDuplicateRows` function.

- **Commands (write atoms, all `null` state, `void` return):**
  - `openRemoveDuplicatesAtom(range, cells)` — seeds range + cells,
    defaults key columns to every column in the range, flips open.
    Does NOT reset `comparison` / `excludeHeader` (session-sticky).
  - `closeRemoveDuplicatesAtom()` — closes + clears range, cells, and
    key columns. Leaves comparison / excludeHeader at their current
    values.
  - `toggleKeyColumnAtom(col)` — flips a single column's membership.
    Immutable rewrite so subscribers see a fresh Set reference.
  - `selectAllKeyColumnsAtom()` — checks every column in the active
    range. No-op when no range is set.
  - `deselectAllKeyColumnsAtom()` — empties the key set. Preview will
    report `noKeyColumns: true`.

## Algorithm contract (pure)

`findDuplicateRows(input): RemoveDuplicatesScanResult` lives in
`./algorithm.ts`. It is framework-agnostic and safe to call from any
host without the atom infrastructure.

Behaviour:

1. `keyColumns` is partitioned into in-range vs out-of-range columns
   up-front. Out-of-range columns are surfaced in
   `result.ignoredColumns` (sorted ascending). An empty effective key
   set returns a synthetic zero-result with `noKeyColumns: true` —
   the algorithm never throws on input shape.
2. In-range key columns are visited in ascending sheet-column order so
   tuple keys are stable across callers passing different Set
   insertion orders.
3. Rows are scanned top-to-bottom in `[startRow .. endRow]`. When
   `excludeHeader` is true, `startRow` is skipped and reported via
   `result.headerRow`.
4. Each row's tuple is the per-column normalised display values fed
   through a length-prefix encoding (`${len}:${value}` joined with
   `|`). Length-prefixing avoids the collision class where a separator
   character appears inside a cell value (e.g. binary paste, CSV with
   embedded control chars). Missing cells and cells with `valueKind
   === 'blank'` both contribute the empty string — two all-blank rows
   ARE duplicates of each other.
5. First occurrence wins; later rows with the same tuple land in
   `duplicateRows` (sorted ascending). When the projection carries
   `DisplayCell.originalRow` (filter/sort active), the source-row
   index is reported there so callers can hand the result straight to
   `backend.removeRows` without remapping.

Empty range (`startRow > endRow` or `startCol > endCol`) returns zero
scanned rows and never throws.

## Contract for the Solid layer (agent B/C)

- The dialog reads `removeDuplicatesPreviewAtom` for live preview.
  When it returns `null`, the dialog should render its empty state.
  When it returns a result with `noKeyColumns: true`, the OK button
  must be disabled.
- Before invoking OK, the Solid layer **must** ensure the preview has
  at least one in-range key column. The atom layer will not call
  `findDuplicateRows` with an empty set, but if the host calls the
  pure function directly it is responsible for the same guard.
- The host adapter is responsible for:
  - Pushing the `DisplayCell[]` projection for the range into
    `removeDuplicatesScanInputCellsAtom` whenever the cells change
    while the dialog is open. The atom layer does not re-fetch.
  - Calling `backend.removeRows` (or the equivalent transactional
    helper) with `preview.duplicateRows` once the user confirms.
  - Calling `closeRemoveDuplicatesAtom` after the backend round-trip
    finishes (success or failure) so the dialog state is always
    cleared.

## Comparison policy notes

- `caseInsensitive` and `trimAndIgnoreCase` use `String#toLowerCase()`
  — Latin-only is fine, full Unicode case-folding is out of scope.
  Excel itself uses code-page-aware folding which depends on the
  workbook locale; matching that exactly is deferred.
- Numeric cells are compared by their `displayValue` (the projection's
  formatted string). Two cells that hold `1` and `1.0` will therefore
  be duplicates when the format renders both as `1`, and distinct when
  the format renders one as `1.00`. This matches Excel's "compare what
  the user sees" behaviour and intentionally avoids reaching into
  numeric-value semantics from UI core.
- NaN / Infinity follow the same rule — they are whatever the
  projection chose to render them as. UI core does not special-case
  them.

## Capability gating

The Data menu entry should set `isAvailable: 'capability'` with
`capabilityKey: 'removeRows'`; the host resolves the key to
`backend.removeRows != null`. When the backend omits `removeRows`, the
menu entry hides entirely (same pattern as Paste Special and Text to
Columns).

## Scale

The algorithm holds two maps in memory:

- `byRow`: at most one entry per scanned row, each with at most
  `keyColumns.size` entries. O(cells visited) memory.
- `seen`: one entry per unique tuple, capped at scanned-row count.

For 100k rows × 20 columns this is well under 10 MB worst case, so no
bounded cache cap is required at this layer. The dialog should still
warn (UI-level) before scanning very large ranges.

## Tests

`test/remove-duplicates.test.ts` covers:

- 3 unique vs 3 identical rows.
- Multi-column key with selected / unselected differentiating columns.
- `excludeHeader` true / false.
- All four `comparison` modes.
- Blank rows treated as duplicates of each other.
- Sparse projection (missing cells) defaults to blank.
- Out-of-range key columns reported in `ignoredColumns`.
- Empty range + single row no-ops.
- Empty key set returns `noKeyColumns: true` (pure function and atom
  preview share the same shape — neither throws).
- Embedded control chars (U+001F, newlines, null bytes, surrogate
  pairs) do not produce spurious cross-row collisions.
- Filter/sort projection: `DisplayCell.originalRow` surfaces in
  `duplicateRows`.
- `openRemoveDuplicatesAtom` seeds range + cells + defaults key
  columns; `toggleKeyColumnAtom` flips membership;
  `deselectAllKeyColumnsAtom` makes preview report `noKeyColumns`.
