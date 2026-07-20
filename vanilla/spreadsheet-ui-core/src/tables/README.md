# spreadsheet-ui-core / tables

Excel Table (structured references, totals) — parity #32,
`solid/excel/docs/online-excel-parity/design-excel-table.md`.

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
worker adapter) is implemented in `solid/excel/src-vnext/adapter`.

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

Feature degradation: when the host backend omits these ports the Data-menu
"Create table" entry hides through the standard method-presence contract —
the TS worker runtime declares `structuredTables: false` (fail-closed) and
the static backend does not implement them, so both correctly hide the
surface (`createTableSupportedAtom` reads `false`).

## Not here yet (later slices, design §9 / §13)

- Totals-row toggle / totals-function dropdown, table rename / delete UI,
  the create-table dialog (this slice creates on the current selection with
  an engine-auto name; a name field is a later dialog slice).
- Name Manager read-only "Tables" section (design §9). Deferred:
  `allTablesAtom` + `refreshTableCatalogAtom` are exported, but wiring a
  refresh-on-open into `SpreadsheetNameManagerDialog` plus a read-only
  section and its tests is a separate slice, not a low-cost add-on here.
- SUBTOTAL hidden-row push (`setEvalHiddenRows`) — separate port family.
- Table lifecycle undo (design §11/§12 known gap: persistence and the
  snapshot primitive do not carry the table registry).
