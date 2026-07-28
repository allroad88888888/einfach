import type { CellRange, SheetRef } from '../shared'

/**
 * A single Excel Table as reported by the engine registry (#32,
 * `design-excel-table.md` §4/§10). Framework-neutral projection of the
 * engine `TableEntry` — the backend maps the engine's `TableJSON`
 * (which carries a 0-based `sheetIndex` + sheet name) onto the UI-core
 * stable `sheetId` before handing it to the UI layer.
 *
 * This is a READ-ONLY view fact: the engine registry is canonical
 * (CANONICAL_OWNERSHIP §3 #32). UI core never stores a second copy of
 * a table's geometry — it re-reads through `listTables` / `getTable`.
 */
export interface SpreadsheetTableDescriptor {
  /** Canonical (display-cased) table name; workbook-unique. */
  name: string
  /** UI-core stable sheet id the table is anchored to. */
  sheetId: string
  /** Engine sheet display name (informational; identity is `sheetId`). */
  sheetName: string
  /** 0-based engine sheet index the descriptor resolved from. */
  sheetIndex: number
  /** A1 range spanning header + data (+ totals row when present), e.g. `"A1:C10"`. */
  range: string
  /** MVP tables always carry a header row; kept explicit for round-trip fidelity. */
  hasHeaders: boolean
  /** Whether the table currently has a totals row. */
  hasTotals: boolean
  /** Column display names in column order (case-insensitive match, display case kept). */
  columns: readonly string[]
}

/**
 * Structured rejection reasons a table mutation surfaces BEFORE writing
 * anything. The first entries mirror the engine `TableError` variants
 * (forwarded verbatim as the wire `detail.code`); `invalid-payload` is
 * the adapter's own fallback for a malformed or unrecognized reject.
 */
export type TableMutationRejectionCode =
  | 'too-many-tables'
  | 'invalid-name'
  | 'reserved-name'
  | 'name-like-cell-ref'
  | 'name-conflict'
  | 'range-overlap'
  | 'sheet-not-found'
  | 'not-found'
  | 'column-not-found'
  | 'duplicate-column'
  | 'invalid-column-name'
  | 'mutation-during-custom-call'
  // Totals-row mutation gates (design-excel-table.md §7, parity #32 T6):
  // toggling on when the row below the table is occupied
  // (`totals-row-blocked`); setting a totals function before the row is
  // enabled (`no-totals-row`); an unrecognized aggregate id
  // (`invalid-totals-function`).
  | 'totals-row-blocked'
  | 'no-totals-row'
  | 'invalid-totals-function'
  | 'invalid-payload'

/**
 * Contract-level evidence that a table mutation was rejected before
 * application — nothing was written, no undo entry recorded, and
 * `revision` is the current (un-bumped) witness. Shared by every table
 * mutation port (create / rename / rename-column / delete). A generic
 * promise rejection is deliberately NOT equivalent to this result.
 */
export interface TableMutationRejectedResult {
  kind: 'table-mutation-not-applied'
  applied: false
  code: TableMutationRejectionCode
  message?: string
  requestId?: number
  revision?: number | string
}

/**
 * Applied witness for rename / rename-column / delete. `name` is the
 * canonical name after the mutation.
 */
export interface TableMutationAppliedResult {
  kind: 'table-mutation'
  applied: true
  name: string
  requestId?: number
  revision?: number | string
}

export type TableMutationResult = TableMutationAppliedResult | TableMutationRejectedResult

/** Applied witness for `createTable` — carries the canonical name the engine assigned. */
export interface CreateTableAppliedResult {
  kind: 'create-table'
  applied: true
  /**
   * Canonical (display-cased) name the engine assigned — auto-generated
   * when the request omitted one.
   */
  name: string
  requestId?: number
  revision?: number | string
}

export type CreateTableResult = CreateTableAppliedResult | TableMutationRejectedResult

export interface CreateTableRequest extends SheetRef {
  kind: 'create-table'
  /** Selection range spanning header + data rows; MVP requires a header row. */
  range: CellRange
  /** Explicit table name; omit to let the engine auto-generate `Table1..N`. */
  name?: string
  requestId?: number
  revision?: number | string
}

export interface RenameTableRequest {
  kind: 'rename-table'
  name: string
  newName: string
  requestId?: number
  revision?: number | string
}

export interface RenameTableColumnRequest {
  kind: 'rename-table-column'
  name: string
  oldColumn: string
  newColumn: string
  requestId?: number
  revision?: number | string
}

export interface DeleteTableRequest {
  kind: 'delete-table'
  name: string
  requestId?: number
  revision?: number | string
}

/**
 * Totals-row aggregate ids (design-excel-table.md §7). camelCase to match
 * the engine / WASM `setTableTotalFunction` contract. `'none'` clears the
 * cell; every other id writes `=SUBTOTAL(1xx, Table[Col])` with the 101-111
 * hidden-excluding code so a totals aggregate skips manually hidden rows.
 */
export type TableTotalsFunction =
  | 'none'
  | 'average'
  | 'count'
  | 'countNums'
  | 'max'
  | 'min'
  | 'sum'
  | 'stdDev'
  | 'var'

/**
 * Toggle a Table's totals row (parity #32 T6). `enabled: true` grows the
 * Table by one row and writes a default `=SUBTOTAL(109, …)` SUM in the last
 * column — unless the row below is occupied (`totals-row-blocked`).
 * `enabled: false` clears the totals cells and shrinks the Table. Idempotent
 * per state. Resolves the shared applied-or-structured-reject convention.
 */
export interface SetTableTotalsRowRequest {
  kind: 'set-table-totals-row'
  name: string
  enabled: boolean
  requestId?: number
  revision?: number | string
}

/**
 * Set one totals-row column's aggregate (parity #32 T6). Requires the totals
 * row to be enabled first (`no-totals-row` otherwise); an unrecognized `func`
 * rejects with `invalid-totals-function`.
 */
export interface SetTableTotalFunctionRequest {
  kind: 'set-table-total-function'
  name: string
  column: string
  func: TableTotalsFunction
  requestId?: number
  revision?: number | string
}

export interface ListTablesRequest {
  kind: 'list-tables'
  requestId?: number
  revision?: number | string
}

export interface ListTablesResult {
  requestId?: number
  revision?: number | string
  tables: SpreadsheetTableDescriptor[]
}

export interface GetTableRequest {
  kind: 'get-table'
  name: string
  requestId?: number
  revision?: number | string
}

export interface GetTableResult {
  requestId?: number
  revision?: number | string
  table: SpreadsheetTableDescriptor | null
}

/**
 * Structural subset of `SpreadsheetBackend` the UI-core table commands
 * consume. Declared here (rather than importing `SpreadsheetBackend`) to
 * keep the tables module free of a back-edge into `backend/types` — the
 * host passes its full backend, which satisfies this shape by structural
 * typing. Every port is optional: a host whose engine has no table model
 * omits them and the commands degrade (capability atom reads `false`).
 */
export interface TablesControllerPort {
  createTable?(request: CreateTableRequest): Promise<CreateTableResult>
  renameTable?(request: RenameTableRequest): Promise<TableMutationResult>
  renameTableColumn?(request: RenameTableColumnRequest): Promise<TableMutationResult>
  deleteTable?(request: DeleteTableRequest): Promise<TableMutationResult>
  listTables?(request: ListTablesRequest): Promise<ListTablesResult>
  getTable?(request: GetTableRequest): Promise<GetTableResult>
  setTableTotalsRow?(request: SetTableTotalsRowRequest): Promise<TableMutationResult>
  setTableTotalFunction?(request: SetTableTotalFunctionRequest): Promise<TableMutationResult>
}
