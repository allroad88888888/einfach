import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  MAX_TABLE_CATALOG_ENTRIES,
  TABLE_CAPABILITY_ERROR,
  TABLE_INVALID_SELECTION_ERROR,
  TABLE_REJECTION_MESSAGES,
  allTablesAtom,
  captureTableCapabilityAtom,
  clearTableDiagnosticAtom,
  createTableSupportedAtom,
  isValidCreateTableRange,
  lastCreatedTableNameAtom,
  refreshTableCatalogAtom,
  runCreateTableAtom,
  tableDiagnosticAtom,
  tableRejectionMessage,
  tablesForSheetAtom,
} from '../src'
import type {
  CreateTableRequest,
  CreateTableResult,
  ListTablesResult,
  SpreadsheetTableDescriptor,
  TableMutationRejectionCode,
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
