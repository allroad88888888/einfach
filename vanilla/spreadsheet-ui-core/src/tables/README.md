# spreadsheet-ui-core / tables

Excel Table (structured references, totals) — parity #32,
`solid/excel/docs/online-excel-parity/design-excel-table.md`.

Canonical ownership: the **engine registry is the single source of truth**
for a table's geometry and columns (CANONICAL_OWNERSHIP §3 #32). UI core
holds no second copy — it re-reads through the `listTables` / `getTable`
backend ports and treats every descriptor as a read-only view fact.

## Contents (adapter bridge — first slice)

This module currently ships **types only**: the framework-neutral
`SpreadsheetTableDescriptor` plus the request / result / structured-reject
shapes for the six table CRUD backend ports
(`createTable` / `renameTable` / `renameTableColumn` / `deleteTable` /
`listTables` / `getTable`). The wire pipeline (worker protocol + both
runtimes + worker adapter) is implemented in `solid/excel/src-vnext/adapter`.

Feature degradation: when the host backend omits these ports the UI Table
entries hide through the standard method-presence contract — the TS worker
runtime declares `structuredTables: false` (fail-closed) and the static
backend does not implement them, so both correctly hide the surface.

## Not here yet (later bridge slices, design §9 / §13 T7)

- `tableCatalogAtom` (source, bounded cache cap 256) and the derived /
  command atoms.
- The Data-menu "convert to table", totals-row toggle, and Name Manager
  read-only listing.
- SUBTOTAL hidden-row push (`setEvalHiddenRows`) — separate port family.
- Table lifecycle undo (design §11/§12 known gap: persistence and the
  snapshot primitive do not carry the table registry).
