import { atom } from '@einfach/core'
import type { Atom } from '@einfach/core'
import type { CellRange } from '../shared'
import type {
  CreateTableResult,
  ListTablesResult,
  SpreadsheetTableDescriptor,
  TableMutationRejectionCode,
  TablesControllerPort,
} from './types'

// ===========================================================================
// Excel Table UI-core command layer (design-excel-table.md §9 / §13 T7,
// parity #32)
//
// The engine registry is the single source of truth for a table's geometry
// (CANONICAL_OWNERSHIP §3 #32). These atoms hold only a bounded read-through
// cache of the last `listTables` projection plus the create-table command,
// its capability witness, and a user-readable diagnostic. No per-cell /
// per-table atom family; table geometry is never stored twice.
// ===========================================================================

/** Bounded catalog cap — mirrors the engine's per-workbook table limit. */
export const MAX_TABLE_CATALOG_ENTRIES = 256

export const TABLE_INVALID_SELECTION_ERROR =
  'Create table needs a selection with a header row and at least one data row.'

export const TABLE_CAPABILITY_ERROR =
  'Tables are unavailable because this workbook does not provide createTable.'

/** Structured-reject code → user-readable prompt (design §4/§10). */
export const TABLE_REJECTION_MESSAGES: Readonly<Record<TableMutationRejectionCode, string>> =
  Object.freeze({
    'too-many-tables':
      'Create table failed: this workbook already has the maximum number of tables.',
    'invalid-name': 'Create table failed: the table name is invalid.',
    'reserved-name': 'Create table failed: that name is reserved by a built-in function.',
    'name-like-cell-ref':
      'Create table failed: the name looks like a cell reference. Choose another name.',
    'name-conflict': 'Create table failed: that name is already in use.',
    'range-overlap': 'Create table failed: the selection overlaps an existing table.',
    'sheet-not-found': 'Create table failed: the target sheet could not be found.',
    'not-found': 'Table operation failed: the table could not be found.',
    'column-not-found': 'Table operation failed: the column could not be found.',
    'duplicate-column': 'Table operation failed: that column name is already in use.',
    'invalid-column-name': 'Table operation failed: the column name is invalid.',
    'mutation-during-custom-call':
      'Table operation failed: a custom formula is still running. Try again.',
    'invalid-payload': 'Table operation failed: the request was malformed.',
  })

export type TableDiagnosticCode =
  | TableMutationRejectionCode
  | 'invalid-selection'
  | 'capability'
  | 'outcome-unknown'

export interface TableDiagnostic {
  readonly code: TableDiagnosticCode
  readonly message: string
}

export function tableRejectionMessage(code: TableMutationRejectionCode, fallback?: string): string {
  return TABLE_REJECTION_MESSAGES[code] ?? fallback ?? 'Table operation failed.'
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown table transport failure.'
  }
}

function nextRequestId(sequence: number): number {
  return Number.isSafeInteger(sequence) && sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : 1
}

function normalizeRange(range: CellRange): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

/**
 * MVP create-table gate (design §3/§4.1): the selection must be a
 * well-formed rectangle with a header row AND at least one data row
 * (`rowEnd > rowStart`), so `#Data` structured references resolve to a
 * non-empty region. A single cell / single row is rejected — the engine
 * models no auto-expand in this slice.
 */
export function isValidCreateTableRange(range: CellRange): boolean {
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.colEnd >= range.colStart &&
    range.rowEnd >= range.rowStart + 1
  )
}

function readCreateTablePort(source: TablesControllerPort): TablesControllerPort['createTable'] {
  try {
    const port = source?.createTable
    return typeof port === 'function' ? port : undefined
  } catch {
    return undefined
  }
}

function readListTablesPort(source: TablesControllerPort): TablesControllerPort['listTables'] {
  try {
    const port = source?.listTables
    return typeof port === 'function' ? port : undefined
  } catch {
    return undefined
  }
}

// --- catalog (source, bounded cache) ---------------------------------------

const EMPTY_TABLE_CATALOG: readonly SpreadsheetTableDescriptor[] = Object.freeze([])

const tableCatalogBackingAtom = atom<readonly SpreadsheetTableDescriptor[]>(EMPTY_TABLE_CATALOG)
tableCatalogBackingAtom.debugLabel = 'spreadsheet.tables.catalogBacking'

/**
 * Read-only projection of the last `listTables` result — every table in the
 * workbook, in engine order, capped at {@link MAX_TABLE_CATALOG_ENTRIES}.
 */
export const allTablesAtom: Atom<readonly SpreadsheetTableDescriptor[]> = atom((get) =>
  get(tableCatalogBackingAtom),
)
allTablesAtom.debugLabel = 'spreadsheet.tables.all'

/**
 * Read-only selector projection: `get(tablesForSheetAtom)(sheetId)` returns
 * the tables anchored to `sheetId`. Recomputed only when the catalog changes;
 * no per-sheet atom family.
 */
export const tablesForSheetAtom: Atom<
  (sheetId: string) => readonly SpreadsheetTableDescriptor[]
> = atom((get) => {
  const catalog = get(tableCatalogBackingAtom)
  return (sheetId: string): readonly SpreadsheetTableDescriptor[] =>
    catalog.filter((table) => table.sheetId === sheetId)
})
tablesForSheetAtom.debugLabel = 'spreadsheet.tables.forSheet'

// --- capability witness -----------------------------------------------------

const createTableCapabilityBackingAtom = atom<boolean>(false)
createTableCapabilityBackingAtom.debugLabel = 'spreadsheet.tables.createCapabilityBacking'

/** Read-only witness of the `createTable` port (captured on dispatch / capture). */
export const createTableSupportedAtom: Atom<boolean> = atom((get) =>
  get(createTableCapabilityBackingAtom),
)
createTableSupportedAtom.debugLabel = 'spreadsheet.tables.createSupported'

/** Captures the `createTable` capability witness without dispatching. */
export const captureTableCapabilityAtom = atom(null, (_get, set, source: TablesControllerPort) => {
  set(createTableCapabilityBackingAtom, readCreateTablePort(source) !== undefined)
})
captureTableCapabilityAtom.debugLabel = 'spreadsheet.tables.captureCapability'

// --- diagnostic + last-applied witness -------------------------------------

const tableDiagnosticBackingAtom = atom<TableDiagnostic | null>(null)
tableDiagnosticBackingAtom.debugLabel = 'spreadsheet.tables.diagnosticBacking'

/** Read-only last table-command rejection, user-readable. Cleared on the next dispatch. */
export const tableDiagnosticAtom: Atom<TableDiagnostic | null> = atom((get) =>
  get(tableDiagnosticBackingAtom),
)
tableDiagnosticAtom.debugLabel = 'spreadsheet.tables.diagnostic'

export const clearTableDiagnosticAtom = atom(null, (_get, set) => {
  set(tableDiagnosticBackingAtom, null)
})
clearTableDiagnosticAtom.debugLabel = 'spreadsheet.tables.clearDiagnostic'

const lastCreatedTableNameBackingAtom = atom<string | null>(null)
lastCreatedTableNameBackingAtom.debugLabel = 'spreadsheet.tables.lastCreatedNameBacking'

/** Read-only canonical name of the most recently created table (visible success witness). */
export const lastCreatedTableNameAtom: Atom<string | null> = atom((get) =>
  get(lastCreatedTableNameBackingAtom),
)
lastCreatedTableNameAtom.debugLabel = 'spreadsheet.tables.lastCreatedName'

// --- request-id sequence + single-lane guard -------------------------------

const tableRequestIdBackingAtom = atom<number>(0)
tableRequestIdBackingAtom.debugLabel = 'spreadsheet.tables.requestIdBacking'

const activeCreateTableAtom = atom<boolean>(false)
activeCreateTableAtom.debugLabel = 'spreadsheet.tables.activeCreate'

// --- refresh catalog command ------------------------------------------------

/**
 * Re-read the canonical table registry through `listTables` and replace the
 * bounded cache. A host without the port collapses the cache to empty; a
 * transport failure keeps the last known catalog.
 */
export const refreshTableCatalogAtom = atom(
  null,
  async (_get, set, source: TablesControllerPort): Promise<void> => {
    const list = readListTablesPort(source)
    if (list === undefined) {
      set(tableCatalogBackingAtom, EMPTY_TABLE_CATALOG)
      return
    }
    let result: ListTablesResult
    try {
      result = await list.call(source, { kind: 'list-tables' })
    } catch {
      // Leave the last known catalog untouched on a transport failure.
      return
    }
    const tables = Array.isArray(result?.tables) ? result.tables : []
    set(
      tableCatalogBackingAtom,
      Object.freeze(tables.slice(0, MAX_TABLE_CATALOG_ENTRIES)),
    )
  },
)
refreshTableCatalogAtom.debugLabel = 'spreadsheet.tables.refreshCatalog'

// --- create table command ---------------------------------------------------

export interface RunCreateTableInput {
  readonly source: TablesControllerPort
  readonly sheetId: string
  readonly range: CellRange
  /** Optional explicit name; omit to let the engine auto-generate `Table1..N`. */
  readonly name?: string
  /** Optional post-apply projection refresh (structured refs recompute on read). */
  readonly refreshProjection?: (sheetId: string) => Promise<unknown> | unknown
}

/**
 * Create an Excel Table over the current selection. Capability-gated: when
 * the host omits `createTable` the command surfaces a capability diagnostic
 * and never touches the engine. An invalid selection is rejected locally.
 * On an applied result the bounded catalog is refreshed from the engine
 * (canonical) and the last-created name is published; a structured reject
 * (name-conflict / range-overlap / too-many-tables / …) maps to a
 * user-readable diagnostic without a thrown promise.
 */
export const runCreateTableAtom = atom(
  null,
  async (get, set, input: RunCreateTableInput): Promise<void> => {
    if (get(activeCreateTableAtom)) return

    const create = readCreateTablePort(input.source)
    set(createTableCapabilityBackingAtom, create !== undefined)
    if (create === undefined) {
      set(
        tableDiagnosticBackingAtom,
        Object.freeze({ code: 'capability', message: TABLE_CAPABILITY_ERROR }),
      )
      return
    }

    const range = input.range === undefined ? null : normalizeRange(input.range)
    if (!input.sheetId || range === null || !isValidCreateTableRange(range)) {
      set(
        tableDiagnosticBackingAtom,
        Object.freeze({ code: 'invalid-selection', message: TABLE_INVALID_SELECTION_ERROR }),
      )
      return
    }

    const requestId = nextRequestId(get(tableRequestIdBackingAtom))
    set(tableRequestIdBackingAtom, requestId)
    set(activeCreateTableAtom, true)
    set(tableDiagnosticBackingAtom, null)

    const name =
      typeof input.name === 'string' && input.name.trim().length > 0
        ? input.name.trim()
        : undefined

    let result: CreateTableResult
    try {
      result = await create.call(input.source, {
        kind: 'create-table',
        sheetId: input.sheetId,
        range,
        ...(name === undefined ? {} : { name }),
        requestId,
      })
    } catch (error) {
      set(activeCreateTableAtom, false)
      set(
        tableDiagnosticBackingAtom,
        Object.freeze({
          code: 'outcome-unknown',
          message: `Create table result is unknown: ${errorMessage(error)}`,
        }),
      )
      return
    }

    // Structured rejection (a gated request resolves, it does NOT reject the
    // promise): nothing was written, no catalog change.
    if (!result || result.applied === false) {
      const code: TableMutationRejectionCode = result ? result.code : 'invalid-payload'
      set(activeCreateTableAtom, false)
      set(
        tableDiagnosticBackingAtom,
        Object.freeze({ code, message: tableRejectionMessage(code, result?.message) }),
      )
      return
    }

    // Applied — refresh the bounded cache from the canonical engine registry.
    set(lastCreatedTableNameBackingAtom, result.name)
    await set(refreshTableCatalogAtom, input.source)
    if (typeof input.refreshProjection === 'function') {
      try {
        await input.refreshProjection(input.sheetId)
      } catch {
        // Projection refresh failure is non-fatal; the table exists.
      }
    }
    set(activeCreateTableAtom, false)
    set(tableDiagnosticBackingAtom, null)
  },
)
runCreateTableAtom.debugLabel = 'spreadsheet.tables.runCreate'
