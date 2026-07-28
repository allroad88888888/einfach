import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  MAX_TABLE_CATALOG_ENTRIES,
  TABLE_CAPABILITY_ERROR,
  TABLE_COLUMN_NAME_UNCHANGED_ERROR,
  TABLE_DELETE_CAPABILITY_ERROR,
  TABLE_DELETE_REJECTION_MESSAGES,
  TABLE_INVALID_NAME_ERROR,
  TABLE_INVALID_SELECTION_ERROR,
  TABLE_MISSING_TARGET_ERROR,
  TABLE_NAME_LIKE_CELL_REF_ERROR,
  TABLE_NAME_MAX_LENGTH,
  TABLE_NAME_UNCHANGED_ERROR,
  TABLE_NO_TABLE_AT_SELECTION_ERROR,
  TABLE_REJECTION_MESSAGES,
  TABLE_RENAME_CAPABILITY_ERROR,
  TABLE_RENAME_COLUMN_CAPABILITY_ERROR,
  TABLE_RENAME_REJECTION_MESSAGES,
  TABLE_TOTALS_CAPABILITY_ERROR,
  allTablesAtom,
  captureTableCapabilityAtom,
  clearTableDiagnosticAtom,
  createTableSupportedAtom,
  deleteTableSupportedAtom,
  findTableForCell,
  isCellRefLikeTableName,
  isValidCreateTableRange,
  isValidTableName,
  lastCreatedTableNameAtom,
  lastDeletedTableNameAtom,
  lastRenamedTableAtom,
  lastToggledTableTotalsAtom,
  refreshTableCatalogAtom,
  renameTableColumnSupportedAtom,
  renameTableSupportedAtom,
  historyStackAtom,
  runCreateTableAtom,
  runDeleteTableAtom,
  runRenameTableAtom,
  runRenameTableColumnAtom,
  runSetTableTotalFunctionAtom,
  runToggleTableTotalsAtom,
  runToggleTableTotalsAtSelectionAtom,
  tableDiagnosticAtom,
  tableRejectionMessage,
  tablesForSheetAtom,
  toggleTableTotalsSupportedAtom,
} from '../src'
import type {
  CreateTableRequest,
  CreateTableResult,
  DeleteTableRequest,
  ListTablesResult,
  RenameTableColumnRequest,
  RenameTableRequest,
  SetTableTotalFunctionRequest,
  SetTableTotalsRowRequest,
  SpreadsheetTableDescriptor,
  TableMutationRejectionCode,
  TableMutationResult,
  TablesControllerPort,
} from '../src'

function makeStore() {
  return createStore()
}

const A1_C4 = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 }

function descriptor(
  name: string,
  sheetId: string,
  range = 'A1:C4',
  columns: readonly string[] = ['Name', 'Age', 'City'],
): SpreadsheetTableDescriptor {
  return {
    name,
    sheetId,
    sheetName: sheetId,
    sheetIndex: 0,
    range,
    hasHeaders: true,
    hasTotals: false,
    columns,
  }
}

interface SourceOptions {
  result?: (request: CreateTableRequest) => CreateTableResult
  throwOnCreate?: unknown
  withoutCreate?: boolean
  withoutList?: boolean
  tables?: () => readonly SpreadsheetTableDescriptor[]
}

function makeSource(options: SourceOptions = {}) {
  const createRequests: CreateTableRequest[] = []
  let listCalls = 0
  const source: TablesControllerPort = {}
  if (!options.withoutCreate) {
    source.createTable = async (request): Promise<CreateTableResult> => {
      createRequests.push(request)
      if (options.throwOnCreate !== undefined) throw options.throwOnCreate
      if (options.result) return options.result(request)
      return {
        kind: 'create-table',
        applied: true,
        name: request.name ?? 'Table1',
        requestId: request.requestId,
        revision: 1,
      }
    }
  }
  if (!options.withoutList) {
    source.listTables = async (): Promise<ListTablesResult> => {
      listCalls += 1
      return { tables: [...(options.tables?.() ?? [])] }
    }
  }
  return {
    source,
    createRequests,
    get listCalls() {
      return listCalls
    },
  }
}

describe('tables — range validation', () => {
  test('rejects a single cell / single row and accepts header + data', () => {
    expect(isValidCreateTableRange({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })).toBe(false)
    expect(isValidCreateTableRange({ rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 3 })).toBe(false)
    expect(isValidCreateTableRange(A1_C4)).toBe(true)
    expect(isValidCreateTableRange({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 })).toBe(true)
    expect(isValidCreateTableRange({ rowStart: -1, rowEnd: 3, colStart: 0, colEnd: 2 })).toBe(false)
  })
})

describe('tables — capability', () => {
  test('captureTableCapabilityAtom reflects createTable port presence', () => {
    const store = makeStore()
    expect(store.getter(createTableSupportedAtom)).toBe(false)

    store.setter(captureTableCapabilityAtom, makeSource().source)
    expect(store.getter(createTableSupportedAtom)).toBe(true)

    store.setter(captureTableCapabilityAtom, makeSource({ withoutCreate: true }).source)
    expect(store.getter(createTableSupportedAtom)).toBe(false)
  })

  test('runCreateTableAtom with no createTable port surfaces a capability diagnostic', async () => {
    const store = makeStore()
    const { source, createRequests } = makeSource({ withoutCreate: true })

    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })

    expect(createRequests).toHaveLength(0)
    expect(store.getter(createTableSupportedAtom)).toBe(false)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'capability',
      message: TABLE_CAPABILITY_ERROR,
    })
  })
})

describe('tables — runCreateTableAtom applied', () => {
  test('dispatches a create-table request and refreshes the catalog on apply', async () => {
    const store = makeStore()
    const created = descriptor('Table1', 'sheet-1')
    const harness = makeSource({ tables: () => [created] })
    const { source, createRequests } = harness

    let refreshedSheet: string | null = null
    await store.setter(runCreateTableAtom, {
      source,
      sheetId: 'sheet-1',
      range: A1_C4,
      refreshProjection: (sheetId: string) => {
        refreshedSheet = sheetId
      },
    })

    expect(createRequests).toHaveLength(1)
    expect(createRequests[0]).toMatchObject({
      kind: 'create-table',
      sheetId: 'sheet-1',
      range: A1_C4,
    })
    // No explicit name → engine auto-generates, so the request omits `name`.
    expect(createRequests[0].name).toBeUndefined()
    expect(harness.listCalls).toBe(1)
    expect(store.getter(allTablesAtom)).toEqual([created])
    expect(store.getter(lastCreatedTableNameAtom)).toBe('Table1')
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
    expect(refreshedSheet).toBe('sheet-1')
  })

  test('forwards an explicit trimmed name', async () => {
    const store = makeStore()
    const { source, createRequests } = makeSource({
      tables: () => [descriptor('Sales', 'sheet-1')],
    })

    await store.setter(runCreateTableAtom, {
      source,
      sheetId: 'sheet-1',
      range: A1_C4,
      name: '  Sales  ',
    })

    expect(createRequests[0].name).toBe('Sales')
    expect(store.getter(lastCreatedTableNameAtom)).toBe('Sales')
  })
})

describe('tables — runCreateTableAtom rejected / invalid', () => {
  test('an invalid selection is rejected locally without a backend call', async () => {
    const store = makeStore()
    const { source, createRequests } = makeSource()

    await store.setter(runCreateTableAtom, {
      source,
      sheetId: 'sheet-1',
      range: { rowStart: 2, rowEnd: 2, colStart: 1, colEnd: 1 },
    })

    expect(createRequests).toHaveLength(0)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'invalid-selection',
      message: TABLE_INVALID_SELECTION_ERROR,
    })
  })

  test('a structured reject maps its code to a diagnostic (no catalog change)', async () => {
    const store = makeStore()
    const rejectionCode: TableMutationRejectionCode = 'range-overlap'
    const { source } = makeSource({
      result: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: rejectionCode,
        requestId: request.requestId,
        revision: 7,
      }),
    })

    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })

    expect(store.getter(allTablesAtom)).toEqual([])
    expect(store.getter(lastCreatedTableNameAtom)).toBeNull()
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: rejectionCode,
      message: TABLE_REJECTION_MESSAGES[rejectionCode],
    })
  })

  test('a thrown backend promise becomes an outcome-unknown diagnostic', async () => {
    const store = makeStore()
    const { source } = makeSource({ throwOnCreate: new Error('worker died') })

    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })

    const diagnostic = store.getter(tableDiagnosticAtom)
    expect(diagnostic?.code).toBe('outcome-unknown')
    expect(diagnostic?.message).toContain('worker died')
  })

  test('clearTableDiagnosticAtom resets the diagnostic', async () => {
    const store = makeStore()
    const { source } = makeSource({ withoutCreate: true })
    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })
    expect(store.getter(tableDiagnosticAtom)).not.toBeNull()

    store.setter(clearTableDiagnosticAtom)
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })
})

describe('tables — catalog projections', () => {
  test('tablesForSheetAtom groups the catalog by sheetId', async () => {
    const store = makeStore()
    const t1 = descriptor('Table1', 'sheet-1')
    const t2 = descriptor('Table2', 'sheet-2', 'A1:B5', ['X', 'Y'])
    const { source } = makeSource({ tables: () => [t1, t2] })

    await store.setter(refreshTableCatalogAtom, source)

    expect(store.getter(allTablesAtom)).toEqual([t1, t2])
    expect(store.getter(tablesForSheetAtom)('sheet-1')).toEqual([t1])
    expect(store.getter(tablesForSheetAtom)('sheet-2')).toEqual([t2])
    expect(store.getter(tablesForSheetAtom)('sheet-3')).toEqual([])
  })

  test('refresh with no listTables port collapses the catalog to empty', async () => {
    const store = makeStore()
    const seeded = makeSource({ tables: () => [descriptor('Table1', 'sheet-1')] })
    await store.setter(refreshTableCatalogAtom, seeded.source)
    expect(store.getter(allTablesAtom)).toHaveLength(1)

    await store.setter(refreshTableCatalogAtom, makeSource({ withoutList: true }).source)
    expect(store.getter(allTablesAtom)).toEqual([])
  })

  test('the catalog is bounded to MAX_TABLE_CATALOG_ENTRIES', async () => {
    const store = makeStore()
    const many = Array.from({ length: MAX_TABLE_CATALOG_ENTRIES + 20 }, (_, i) =>
      descriptor(`Table${i}`, 'sheet-1'),
    )
    const { source } = makeSource({ tables: () => many })

    await store.setter(refreshTableCatalogAtom, source)

    expect(store.getter(allTablesAtom)).toHaveLength(MAX_TABLE_CATALOG_ENTRIES)
  })
})

describe('tables — message helper', () => {
  test('tableRejectionMessage falls back for an unknown code', () => {
    expect(tableRejectionMessage('name-conflict')).toBe(TABLE_REJECTION_MESSAGES['name-conflict'])
    expect(tableRejectionMessage('name-conflict', 'custom')).toBe(
      TABLE_REJECTION_MESSAGES['name-conflict'],
    )
  })
})

// --- totals row (parity #32 T6) ---------------------------------------------

interface TotalsSourceOptions {
  totalsResult?: (request: SetTableTotalsRowRequest) => TableMutationResult
  functionResult?: (request: SetTableTotalFunctionRequest) => TableMutationResult
  withoutTotals?: boolean
  withoutFunction?: boolean
  tables?: () => readonly SpreadsheetTableDescriptor[]
}

function makeTotalsSource(options: TotalsSourceOptions = {}) {
  const totalsRequests: SetTableTotalsRowRequest[] = []
  const functionRequests: SetTableTotalFunctionRequest[] = []
  const source: TablesControllerPort = {}
  if (!options.withoutTotals) {
    source.setTableTotalsRow = async (request): Promise<TableMutationResult> => {
      totalsRequests.push(request)
      if (options.totalsResult) return options.totalsResult(request)
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: 2,
      }
    }
  }
  if (!options.withoutFunction) {
    source.setTableTotalFunction = async (request): Promise<TableMutationResult> => {
      functionRequests.push(request)
      if (options.functionResult) return options.functionResult(request)
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: 2,
      }
    }
  }
  source.listTables = async (): Promise<ListTablesResult> => ({
    tables: [...(options.tables?.() ?? [])],
  })
  return { source, totalsRequests, functionRequests }
}

describe('tables — totals capability', () => {
  test('captureTableCapabilityAtom reflects setTableTotalsRow port presence', () => {
    const store = makeStore()
    expect(store.getter(toggleTableTotalsSupportedAtom)).toBe(false)

    store.setter(captureTableCapabilityAtom, makeTotalsSource().source)
    expect(store.getter(toggleTableTotalsSupportedAtom)).toBe(true)

    store.setter(captureTableCapabilityAtom, makeTotalsSource({ withoutTotals: true }).source)
    expect(store.getter(toggleTableTotalsSupportedAtom)).toBe(false)
  })

  test('runToggleTableTotalsAtom with no port surfaces a capability diagnostic', async () => {
    const store = makeStore()
    const { source, totalsRequests } = makeTotalsSource({ withoutTotals: true })

    await store.setter(runToggleTableTotalsAtom, { source, name: 'Table1', enabled: true })

    expect(totalsRequests).toHaveLength(0)
    expect(store.getter(toggleTableTotalsSupportedAtom)).toBe(false)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'capability',
      message: TABLE_TOTALS_CAPABILITY_ERROR,
    })
  })
})

describe('tables — runToggleTableTotalsAtom', () => {
  test('applied dispatches, refreshes hasTotals, and publishes the witness', async () => {
    const store = makeStore()
    let hasTotals = false
    const harness = makeTotalsSource({
      totalsResult: (request) => {
        hasTotals = request.enabled
        return {
          kind: 'table-mutation',
          applied: true,
          name: request.name,
          requestId: request.requestId,
          revision: 2,
        }
      },
      tables: () => [{ ...descriptor('Table1', 'sheet-1', 'A1:C5'), hasTotals }],
    })

    let refreshedSheet: string | undefined
    await store.setter(runToggleTableTotalsAtom, {
      source: harness.source,
      name: 'Table1',
      enabled: true,
      sheetId: 'sheet-1',
      refreshProjection: (sheetId?: string) => {
        refreshedSheet = sheetId
      },
    })

    expect(harness.totalsRequests).toHaveLength(1)
    expect(harness.totalsRequests[0]).toMatchObject({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    expect(store.getter(allTablesAtom)[0]?.hasTotals).toBe(true)
    expect(store.getter(lastToggledTableTotalsAtom)).toEqual({ name: 'Table1', hasTotals: true })
    expect(refreshedSheet).toBe('sheet-1')
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })

  test('a totals-row-blocked reject maps to a diagnostic (no catalog change)', async () => {
    const store = makeStore()
    const { source, totalsRequests } = makeTotalsSource({
      totalsResult: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: 'totals-row-blocked',
        requestId: request.requestId,
        revision: 3,
      }),
      tables: () => [descriptor('Table1', 'sheet-1')],
    })

    await store.setter(runToggleTableTotalsAtom, { source, name: 'Table1', enabled: true })

    expect(totalsRequests).toHaveLength(1)
    // A structured reject never refreshes the catalog — it stays empty.
    expect(store.getter(allTablesAtom)).toEqual([])
    expect(store.getter(lastToggledTableTotalsAtom)).toBeNull()
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'totals-row-blocked',
      message: TABLE_REJECTION_MESSAGES['totals-row-blocked'],
    })
  })

  test('a thrown backend promise becomes an outcome-unknown diagnostic', async () => {
    const store = makeStore()
    const source: TablesControllerPort = {
      setTableTotalsRow: async () => {
        throw new Error('worker died')
      },
    }

    await store.setter(runToggleTableTotalsAtom, { source, name: 'Table1', enabled: true })

    const diagnostic = store.getter(tableDiagnosticAtom)
    expect(diagnostic?.code).toBe('outcome-unknown')
    expect(diagnostic?.message).toContain('worker died')
  })
})

describe('tables — runToggleTableTotalsAtSelectionAtom', () => {
  test('resolves the table at the active cell and flips its totals row', async () => {
    const store = makeStore()
    const harness = makeTotalsSource({ tables: () => [descriptor('Table1', 'sheet-1', 'A1:C5')] })

    await store.setter(runToggleTableTotalsAtSelectionAtom, {
      source: harness.source,
      sheetId: 'sheet-1',
      cell: { row: 2, col: 1 },
    })

    expect(harness.totalsRequests).toHaveLength(1)
    // The seeded descriptor has hasTotals:false → the toggle requests enable.
    expect(harness.totalsRequests[0]).toMatchObject({ name: 'Table1', enabled: true })
  })

  test('surfaces no-table-at-selection when the active cell is outside every table', async () => {
    const store = makeStore()
    const harness = makeTotalsSource({ tables: () => [descriptor('Table1', 'sheet-1', 'A1:C5')] })

    await store.setter(runToggleTableTotalsAtSelectionAtom, {
      source: harness.source,
      sheetId: 'sheet-1',
      cell: { row: 20, col: 20 },
    })

    expect(harness.totalsRequests).toHaveLength(0)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'no-table-at-selection',
      message: TABLE_NO_TABLE_AT_SELECTION_ERROR,
    })
  })
})

describe('tables — findTableForCell', () => {
  test('returns the table whose A1 range contains the coord', () => {
    const t1 = descriptor('Table1', 'sheet-1', 'A1:C5')
    const t2: SpreadsheetTableDescriptor = {
      ...descriptor('Table2', 'sheet-1', 'E1:F4'),
      columns: ['X', 'Y'],
    }
    expect(findTableForCell([t1, t2], { row: 2, col: 1 })?.name).toBe('Table1')
    expect(findTableForCell([t1, t2], { row: 0, col: 4 })?.name).toBe('Table2')
    expect(findTableForCell([t1, t2], { row: 10, col: 10 })).toBeUndefined()
  })
})

describe('tables — runSetTableTotalFunctionAtom', () => {
  test('dispatches the aggregate on apply and maps a no-totals-row reject', async () => {
    const store = makeStore()
    const harness = makeTotalsSource({ tables: () => [descriptor('Table1', 'sheet-1')] })

    await store.setter(runSetTableTotalFunctionAtom, {
      source: harness.source,
      name: 'Table1',
      column: 'Age',
      func: 'average',
    })
    expect(harness.functionRequests).toHaveLength(1)
    expect(harness.functionRequests[0]).toMatchObject({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Age',
      func: 'average',
    })
    expect(store.getter(tableDiagnosticAtom)).toBeNull()

    const rejectHarness = makeTotalsSource({
      functionResult: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: 'no-totals-row',
        requestId: request.requestId,
        revision: 3,
      }),
    })
    await store.setter(runSetTableTotalFunctionAtom, {
      source: rejectHarness.source,
      name: 'Table1',
      column: 'Age',
      func: 'sum',
    })
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'no-totals-row',
      message: TABLE_REJECTION_MESSAGES['no-totals-row'],
    })
  })
})

// --- rename / delete (design §9, parity #32 T7) -----------------------------

interface LifecycleSourceOptions {
  renameResult?: (request: RenameTableRequest) => TableMutationResult
  renameColumnResult?: (request: RenameTableColumnRequest) => TableMutationResult
  deleteResult?: (request: DeleteTableRequest) => TableMutationResult
  throwOnRename?: unknown
  throwOnDelete?: unknown
  withoutRename?: boolean
  withoutRenameColumn?: boolean
  withoutDelete?: boolean
  tables?: () => readonly SpreadsheetTableDescriptor[]
}

function makeLifecycleSource(options: LifecycleSourceOptions = {}) {
  const renameRequests: RenameTableRequest[] = []
  const renameColumnRequests: RenameTableColumnRequest[] = []
  const deleteRequests: DeleteTableRequest[] = []
  let listCalls = 0
  const source: TablesControllerPort = {}
  if (!options.withoutRename) {
    source.renameTable = async (request): Promise<TableMutationResult> => {
      renameRequests.push(request)
      if (options.throwOnRename !== undefined) throw options.throwOnRename
      if (options.renameResult) return options.renameResult(request)
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.newName,
        requestId: request.requestId,
        revision: 3,
      }
    }
  }
  if (!options.withoutRenameColumn) {
    source.renameTableColumn = async (request): Promise<TableMutationResult> => {
      renameColumnRequests.push(request)
      if (options.renameColumnResult) return options.renameColumnResult(request)
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: 3,
      }
    }
  }
  if (!options.withoutDelete) {
    source.deleteTable = async (request): Promise<TableMutationResult> => {
      deleteRequests.push(request)
      if (options.throwOnDelete !== undefined) throw options.throwOnDelete
      if (options.deleteResult) return options.deleteResult(request)
      return {
        kind: 'table-mutation',
        applied: true,
        name: request.name,
        requestId: request.requestId,
        revision: 3,
      }
    }
  }
  source.listTables = async (): Promise<ListTablesResult> => {
    listCalls += 1
    return { tables: [...(options.tables?.() ?? [])] }
  }
  return {
    source,
    renameRequests,
    renameColumnRequests,
    deleteRequests,
    get listCalls() {
      return listCalls
    },
  }
}

describe('tables — name pre-validation helpers', () => {
  test('isValidTableName mirrors the engine name shape', () => {
    expect(isValidTableName('Sales')).toBe(true)
    expect(isValidTableName('_Sales_2024')).toBe(true)
    expect(isValidTableName('  Sales  ')).toBe(true)
    expect(isValidTableName('')).toBe(false)
    expect(isValidTableName('   ')).toBe(false)
    expect(isValidTableName('2Sales')).toBe(false)
    expect(isValidTableName('Sales Table')).toBe(false)
    expect(isValidTableName('Sales-2024')).toBe(false)
    expect(isValidTableName('a'.repeat(TABLE_NAME_MAX_LENGTH))).toBe(true)
    expect(isValidTableName('a'.repeat(TABLE_NAME_MAX_LENGTH + 1))).toBe(false)
  })

  test('isCellRefLikeTableName flags in-grid A1 addresses only', () => {
    expect(isCellRefLikeTableName('Q1')).toBe(true)
    expect(isCellRefLikeTableName('AB12')).toBe(true)
    // `Table1`'s column label overflows the grid — legal, exactly as in the
    // engine's `name_is_cell_ref_like`.
    expect(isCellRefLikeTableName('Table1')).toBe(false)
    expect(isCellRefLikeTableName('Sales')).toBe(false)
  })
})

describe('tables — runRenameTableAtom', () => {
  test('captureTableCapabilityAtom reflects rename / delete port presence', () => {
    const store = makeStore()
    expect(store.getter(renameTableSupportedAtom)).toBe(false)
    expect(store.getter(deleteTableSupportedAtom)).toBe(false)
    expect(store.getter(renameTableColumnSupportedAtom)).toBe(false)

    store.setter(captureTableCapabilityAtom, makeLifecycleSource().source)
    expect(store.getter(renameTableSupportedAtom)).toBe(true)
    expect(store.getter(deleteTableSupportedAtom)).toBe(true)
    expect(store.getter(renameTableColumnSupportedAtom)).toBe(true)

    store.setter(
      captureTableCapabilityAtom,
      makeLifecycleSource({ withoutRename: true, withoutDelete: true, withoutRenameColumn: true })
        .source,
    )
    expect(store.getter(renameTableSupportedAtom)).toBe(false)
    expect(store.getter(deleteTableSupportedAtom)).toBe(false)
    expect(store.getter(renameTableColumnSupportedAtom)).toBe(false)
  })

  test('no renameTable port surfaces a capability diagnostic and sends nothing', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ withoutRename: true })

    await store.setter(runRenameTableAtom, {
      source: harness.source,
      name: 'Table1',
      newName: 'Sales',
    })

    expect(harness.renameRequests).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
    expect(store.getter(renameTableSupportedAtom)).toBe(false)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'capability',
      message: TABLE_RENAME_CAPABILITY_ERROR,
    })
  })

  test('dispatches a rename and refreshes the catalog on apply', async () => {
    const store = makeStore()
    const renamed = descriptor('Sales', 'sheet-1')
    const harness = makeLifecycleSource({ tables: () => [renamed] })

    let refreshedSheet: string | undefined | null = null
    await store.setter(runRenameTableAtom, {
      source: harness.source,
      name: '  Table1  ',
      newName: '  Sales  ',
      sheetId: 'sheet-1',
      refreshProjection: (sheetId?: string) => {
        refreshedSheet = sheetId
      },
    })

    expect(harness.renameRequests).toHaveLength(1)
    expect(harness.renameRequests[0]).toMatchObject({
      kind: 'rename-table',
      name: 'Table1',
      newName: 'Sales',
    })
    expect(harness.renameRequests[0].requestId).toBeGreaterThan(0)
    expect(harness.listCalls).toBe(1)
    expect(store.getter(allTablesAtom)).toEqual([renamed])
    expect(store.getter(lastRenamedTableAtom)).toEqual({ from: 'Table1', to: 'Sales' })
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
    expect(refreshedSheet).toBe('sheet-1')
  })

  test.each([
    ['an empty new name', '', 'invalid-name', TABLE_INVALID_NAME_ERROR],
    ['a malformed new name', '2 Sales!', 'invalid-name', TABLE_INVALID_NAME_ERROR],
    ['a cell-ref-like new name', 'Q1', 'name-like-cell-ref', TABLE_NAME_LIKE_CELL_REF_ERROR],
    ['an unchanged name', 'Table1', 'name-unchanged', TABLE_NAME_UNCHANGED_ERROR],
  ])('rejects %s locally with zero transport', async (_label, newName, code, message) => {
    const store = makeStore()
    const harness = makeLifecycleSource()

    await store.setter(runRenameTableAtom, {
      source: harness.source,
      name: 'Table1',
      newName,
    })

    expect(harness.renameRequests).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
    expect(store.getter(tableDiagnosticAtom)).toEqual({ code, message })
  })

  test('rejects an empty target table locally', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource()

    await store.setter(runRenameTableAtom, { source: harness.source, name: '  ', newName: 'Sales' })

    expect(harness.renameRequests).toHaveLength(0)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'invalid-payload',
      message: TABLE_MISSING_TARGET_ERROR,
    })
  })

  test('a case-only rename still reaches the engine', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ tables: () => [descriptor('TABLE1', 'sheet-1')] })

    await store.setter(runRenameTableAtom, {
      source: harness.source,
      name: 'Table1',
      newName: 'TABLE1',
    })

    expect(harness.renameRequests).toHaveLength(1)
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })

  test('a structured reject maps its code to a rename-flavored diagnostic', async () => {
    const store = makeStore()
    const rejectionCode: TableMutationRejectionCode = 'name-conflict'
    const harness = makeLifecycleSource({
      tables: () => [descriptor('Table1', 'sheet-1')],
      renameResult: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: rejectionCode,
        requestId: request.requestId,
        revision: 9,
      }),
    })

    await store.setter(runRenameTableAtom, {
      source: harness.source,
      name: 'Table1',
      newName: 'Sales',
    })

    // Nothing applied → no catalog refresh, no rename witness.
    expect(harness.listCalls).toBe(0)
    expect(store.getter(lastRenamedTableAtom)).toBeNull()
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: rejectionCode,
      message: TABLE_RENAME_REJECTION_MESSAGES[rejectionCode],
    })
  })

  test('a thrown backend promise becomes an outcome-unknown diagnostic', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ throwOnRename: new Error('worker died') })

    await store.setter(runRenameTableAtom, {
      source: harness.source,
      name: 'Table1',
      newName: 'Sales',
    })

    const diagnostic = store.getter(tableDiagnosticAtom)
    expect(diagnostic?.code).toBe('outcome-unknown')
    expect(diagnostic?.message).toContain('worker died')
  })
})

describe('tables — runDeleteTableAtom', () => {
  test('no deleteTable port surfaces a capability diagnostic and sends nothing', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ withoutDelete: true })

    await store.setter(runDeleteTableAtom, { source: harness.source, name: 'Table1' })

    expect(harness.deleteRequests).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
    expect(store.getter(deleteTableSupportedAtom)).toBe(false)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'capability',
      message: TABLE_DELETE_CAPABILITY_ERROR,
    })
  })

  test('dispatches a delete and refreshes the catalog on apply', async () => {
    const store = makeStore()
    const survivor = descriptor('Costs', 'sheet-2')
    let remaining: readonly SpreadsheetTableDescriptor[] = [
      descriptor('Table1', 'sheet-1'),
      survivor,
    ]
    const harness = makeLifecycleSource({
      tables: () => remaining,
      deleteResult: (request) => {
        remaining = remaining.filter((table) => table.name !== request.name)
        return {
          kind: 'table-mutation',
          applied: true,
          name: request.name,
          requestId: request.requestId,
          revision: 4,
        }
      },
    })

    await store.setter(runDeleteTableAtom, {
      source: harness.source,
      name: 'Table1',
      sheetId: 'sheet-1',
    })

    expect(harness.deleteRequests).toHaveLength(1)
    expect(harness.deleteRequests[0]).toMatchObject({ kind: 'delete-table', name: 'Table1' })
    expect(harness.listCalls).toBe(1)
    expect(store.getter(allTablesAtom)).toEqual([survivor])
    expect(store.getter(lastDeletedTableNameAtom)).toBe('Table1')
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })

  test('rejects an empty target locally with zero transport', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource()

    await store.setter(runDeleteTableAtom, { source: harness.source, name: '   ' })

    expect(harness.deleteRequests).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'invalid-payload',
      message: TABLE_MISSING_TARGET_ERROR,
    })
  })

  test('a structured reject maps its code to a delete-flavored diagnostic', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({
      tables: () => [descriptor('Table1', 'sheet-1')],
      deleteResult: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: 'not-found',
        requestId: request.requestId,
        revision: 4,
      }),
    })

    await store.setter(runDeleteTableAtom, { source: harness.source, name: 'Ghost' })

    expect(harness.listCalls).toBe(0)
    expect(store.getter(lastDeletedTableNameAtom)).toBeNull()
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'not-found',
      message: TABLE_DELETE_REJECTION_MESSAGES['not-found'],
    })
  })

  test('a thrown backend promise becomes an outcome-unknown diagnostic', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ throwOnDelete: 'transport gone' })

    await store.setter(runDeleteTableAtom, { source: harness.source, name: 'Table1' })

    const diagnostic = store.getter(tableDiagnosticAtom)
    expect(diagnostic?.code).toBe('outcome-unknown')
    expect(diagnostic?.message).toContain('transport gone')
  })
})

describe('tables — runRenameTableColumnAtom', () => {
  test('no renameTableColumn port surfaces a capability diagnostic', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ withoutRenameColumn: true })

    await store.setter(runRenameTableColumnAtom, {
      source: harness.source,
      name: 'Table1',
      oldColumn: 'Q1',
      newColumn: 'Quarter 1',
    })

    expect(harness.renameColumnRequests).toHaveLength(0)
    expect(store.getter(renameTableColumnSupportedAtom)).toBe(false)
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'capability',
      message: TABLE_RENAME_COLUMN_CAPABILITY_ERROR,
    })
  })

  test('forwards a trimmed column rename and refreshes the catalog', async () => {
    const store = makeStore()
    const renamed = descriptor('Table1', 'sheet-1', 'A1:C4', ['Name', 'Quarter 1', 'City'])
    const harness = makeLifecycleSource({ tables: () => [renamed] })

    await store.setter(runRenameTableColumnAtom, {
      source: harness.source,
      name: 'Table1',
      oldColumn: ' Q1 ',
      newColumn: ' Quarter 1 ',
    })

    expect(harness.renameColumnRequests[0]).toMatchObject({
      kind: 'rename-table-column',
      name: 'Table1',
      oldColumn: 'Q1',
      newColumn: 'Quarter 1',
    })
    expect(store.getter(allTablesAtom)).toEqual([renamed])
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })

  test('rejects an unchanged / empty column locally with zero transport', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource()

    await store.setter(runRenameTableColumnAtom, {
      source: harness.source,
      name: 'Table1',
      oldColumn: 'Q1',
      newColumn: 'Q1',
    })
    expect(store.getter(tableDiagnosticAtom)).toEqual({
      code: 'name-unchanged',
      message: TABLE_COLUMN_NAME_UNCHANGED_ERROR,
    })

    await store.setter(runRenameTableColumnAtom, {
      source: harness.source,
      name: 'Table1',
      oldColumn: 'Q1',
      newColumn: '  ',
    })
    expect(store.getter(tableDiagnosticAtom)?.code).toBe('invalid-column-name')

    expect(harness.renameColumnRequests).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
  })

  test('a free-text column name is NOT held to the table-name shape', async () => {
    const store = makeStore()
    const harness = makeLifecycleSource({ tables: () => [descriptor('Table1', 'sheet-1')] })

    await store.setter(runRenameTableColumnAtom, {
      source: harness.source,
      name: 'Table1',
      oldColumn: 'Q1',
      newColumn: 'Q1 2024 (net)',
    })

    expect(harness.renameColumnRequests).toHaveLength(1)
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })
})

// The adapter records ONE transaction per applied table definition change and
// the two stacks align positionally, so a mutation that records on one side
// only offsets every later undo by one. These pin the 1:1 invariant.
describe('tables — history pairing', () => {
  test('an applied create pushes exactly one history entry', async () => {
    const store = makeStore()
    const { source } = makeSource()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)

    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })

    const { entries } = store.getter(historyStackAtom)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('table.define')
    expect(entries[0]?.sheetId).toBe('sheet-1')
    expect(store.getter(tableDiagnosticAtom)).toBeNull()
  })

  test('a structurally rejected create pushes no history entry', async () => {
    const store = makeStore()
    const { source } = makeSource({
      result: () => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: 'name-conflict',
      }),
    })

    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })

    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(tableDiagnosticAtom)?.code).toBe('name-conflict')
  })

  test('an applied result with no revision cannot pair, so it reports outcome-unknown', async () => {
    const store = makeStore()
    const { source } = makeSource({
      result: (request) => ({
        kind: 'create-table',
        applied: true,
        name: request.name ?? 'Table1',
        requestId: request.requestId,
      }),
    })

    await store.setter(runCreateTableAtom, { source, sheetId: 'sheet-1', range: A1_C4 })

    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(tableDiagnosticAtom)?.code).toBe('outcome-unknown')
  })
})
