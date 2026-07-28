# spreadsheet-ui-core / tables

Excel Table (structured references, totals) — parity #32,
`excel/solid-excel/docs/online-excel-parity/design-excel-table.md`.

Canonical ownership: the **engine registry is the single source of truth**
for a table's geometry and columns (CANONICAL_OWNERSHIP §3 #32). UI core
holds no second copy — it re-reads through the `listTables` / `getTable`
backend ports and treats every descriptor as a read-only view fact.

## Contents (adapter bridge — second slice)

`types.ts` — framework-neutral `SpreadsheetTableDescriptor` plus the
request / result / structured-reject shapes for the six table CRUD backend
ports (`createTable` / `renameTable` / `renameTableColumn` / `deleteTable` /
`listTables` / `getTable`), and the `TablesControllerPort` structural subset
the commands consume. The wire pipeline (worker protocol + both runtimes +
worker adapter) is implemented in `excel/solid-excel/src-vnext/adapter`.

`commands.ts` — the create-table command layer:

- **source** — `tableCatalogBackingAtom`, a bounded read-through cache of
  the last `listTables` result (cap `MAX_TABLE_CATALOG_ENTRIES` = 256,
  aligned with the engine). UI core stores no second copy of geometry; the
  engine registry stays canonical (CANONICAL_OWNERSHIP §3 #32).
- **derived** — `allTablesAtom` (every table), `tablesForSheetAtom` (a
  selector `(sheetId) => descriptors`), `createTableSupportedAtom`
  (`createTable` port presence), `tableDiagnosticAtom`,
  `lastCreatedTableNameAtom`.
- **command** — `captureTableCapabilityAtom`, `refreshTableCatalogAtom`,
  `runCreateTableAtom` (capability split + structured-reject mapping +
  local invalid-selection gate + catalog refresh on apply),
  `clearTableDiagnosticAtom`.

Totals row (parity #32 T6) — `setTableTotalsRow` / `setTableTotalFunction`
backend ports gated by the same `structuredTables` witness:

- **derived** — `toggleTableTotalsSupportedAtom` (`setTableTotalsRow` port
  presence, gates the Data-menu totals entry), `lastToggledTableTotalsAtom`
  (`{ name, hasTotals }` visible-badge witness).
- **command** — `runToggleTableTotalsAtom` (`{ source, name, enabled }`:
  capability split + dispatch + catalog refresh on apply with the grown
  range + `hasTotals` + structured-reject mapping for `totals-row-blocked` /
  `no-totals-row` / `invalid-totals-function`),
  `runToggleTableTotalsAtSelectionAtom` (resolves the table under the active
  cell via `findTableForCell`, else a `no-table-at-selection` diagnostic),
  `runSetTableTotalFunctionAtom` (per-column aggregate).
- **helper** — `findTableForCell(tables, coord)` (framework-neutral A1-range
  containment used by the totals UI entry).

Rename / delete (design §9, parity #32 T7) — definition-level lifecycle on
the `renameTable` / `renameTableColumn` / `deleteTable` ports:

- **derived** — `renameTableSupportedAtom`, `renameTableColumnSupportedAtom`,
  `deleteTableSupportedAtom` (port-presence witnesses that gate the Name
  Manager row affordances), `lastRenamedTableAtom` (`{ from, to }` applied
  witness), `lastDeletedTableNameAtom`.
- **command** — `runRenameTableAtom` (`{ source, name, newName }`),
  `runRenameTableColumnAtom` (`{ source, name, oldColumn, newColumn }`),
  `runDeleteTableAtom` (`{ source, name }`). Each one: capability split by
  port presence, single-flight lane, structured-reject → readable diagnostic
  (rename/delete-flavored copy via `TABLE_RENAME_REJECTION_MESSAGES` /
  `TABLE_DELETE_REJECTION_MESSAGES`, falling back to the shared
  create-flavored map), throw → `outcome-unknown`, and a catalog refresh
  from the canonical registry on apply.
- **local pre-validation (zero transport)** — `isValidTableName` mirrors the
  engine's `[A-Za-z_][A-Za-z0-9_]*` / 1..255 name shape and
  `isCellRefLikeTableName` mirrors `name_is_cell_ref_like`, so an empty,
  malformed, cell-ref-like, or unchanged (`name-unchanged`) new name is
  rejected before a worker round-trip. The engine stays canonical and
  re-asserts every rule; the local gate only saves the trip. Column display
  names are free text and are NOT held to the table-name shape.

Feature degradation: when the host backend omits these ports the Data-menu
"Create table" entry hides through the standard method-presence contract —
the TS worker runtime declares `structuredTables: false` (fail-closed) and
the static backend does not implement them, so both correctly hide the
surface (`createTableSupportedAtom` reads `false`).

## Not here yet (later slices, design §9 / §13)

- Table rename / delete UI, the create-table dialog (this slice creates on
  the current selection with an engine-auto name; a name field is a later
  dialog slice). The totals-function dropdown is backed by
  `runSetTableTotalFunctionAtom` but has no dedicated UI surface yet — the
  Data-menu entry toggles the row only (default SUM aggregate).
- Name Manager read-only "Tables" section (design §9). Deferred:
  `allTablesAtom` + `refreshTableCatalogAtom` are exported, but wiring a
  refresh-on-open into `SpreadsheetNameManagerDialog` plus a read-only
  section and its tests is a separate slice, not a low-cost add-on here.
- SUBTOTAL hidden-row push (`setEvalHiddenRows`) — separate port family.
- Table lifecycle undo (design §11/§12 known gap: persistence and the
  snapshot primitive do not carry the table registry).
