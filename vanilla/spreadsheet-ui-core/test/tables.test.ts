import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  MAX_TABLE_CATALOG_ENTRIES,
  TABLE_CAPABILITY_ERROR,
  TABLE_INVALID_SELECTION_ERROR,
  TABLE_NO_TABLE_AT_SELECTION_ERROR,
  TABLE_REJECTION_MESSAGES,
  TABLE_TOTALS_CAPABILITY_ERROR,
  allTablesAtom,
  captureTableCapabilityAtom,
  clearTableDiagnosticAtom,
  createTableSupportedAtom,
  findTableForCell,
  isValidCreateTableRange,
  lastCreatedTableNameAtom,
  lastToggledTableTotalsAtom,
  refreshTableCatalogAtom,
  runCreateTableAtom,
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
  ListTablesResult,
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
