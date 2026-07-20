/**
 * @jest-environment node
 *
 * Excel Table CRUD THROUGH the host backend port (design-excel-table.md
 * §10, parity #32) — REAL WASM engine + REAL `worker-runtime.ts`
 * dispatcher, in process (same harness as vnext-worker-sort-host-wasm).
 * This is the adapter-bridge FIRST slice: the six CRUD ports over the
 * worker RPC pipeline. UI commands / menus are a later slice.
 *
 * Pins:
 *  - createTable resolves an applied result carrying the engine-assigned
 *    canonical name; listTables / getTable reflect it (range, columns,
 *    sheetId mapped from the engine sheetIndex),
 *  - rename + rename-column rewrite the registry (listTables reflects),
 *  - delete removes the entry,
 *  - name-conflict and range-overlap surface as STRUCTURED not-applied
 *    results (never a thrown promise) with no registry change,
 *  - a structural insert shifts the table range (engine remap; projection
 *    fact via listTables),
 *  - capability: the WASM null witness keeps all six ports exposed.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'
import type { BackendMutationResult } from '@einfach/spreadsheet-ui-core'

import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'

jest.mock('../wasm-pkg/einfach_wasm.js', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const nodePath = require('node:path') as typeof import('node:path')
  const real = jest.requireActual('../wasm-pkg/einfach_wasm.js') as {
    initSync: (input: { module: ArrayBufferLike }) => unknown
    WasmWorkbook: unknown
  }
  const bytes = readFileSync(nodePath.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm_bg.wasm'))
  real.initSync({
    module: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  return {
    __esModule: true,
    default: async () => undefined,
    WasmWorkbook: real.WasmWorkbook,
  }
})

const SHEET = 'sheet-1'

type Listener = (e: MessageEvent) => void
const toWorker: Listener[] = []
const toClient: Listener[] = []

const inProcessWorker: WorkerLike = {
  postMessage(msg: unknown) {
    for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
  },
  addEventListener(_type: 'message', listener: Listener) {
    toClient.push(listener)
  },
  removeEventListener(_type: 'message', listener: Listener) {
    const index = toClient.indexOf(listener)
    if (index >= 0) toClient.splice(index, 1)
  },
  terminate() {},
}

let createBackendImpl: (() => WorkerWorkbookSpreadsheetBackend) | undefined

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).self = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: string, listener: Listener) {
      toWorker.push(listener)
    },
  }
  await import('../src-vnext/adapter/worker-runtime')
  const adapter = await import('../src-vnext/adapter')
  createBackendImpl = () =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => inProcessWorker,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })
})

async function createBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createBackendImpl!()
  await backend.ready()
  return backend
}

let setRequestId = 1000
async function set(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
  input: string,
): Promise<BackendMutationResult> {
  return backend.setCellInput({
    kind: 'set-cell-input',
    sheetId: SHEET,
    row,
    col,
    input,
    requestId: setRequestId++,
  })
}

/** Seed a header row (Name/Age/City) + 3 data rows so columns are deterministic. */
async function seedTableData(backend: WorkerWorkbookSpreadsheetBackend): Promise<void> {
  await set(backend, 0, 0, 'Name')
  await set(backend, 0, 1, 'Age')
  await set(backend, 0, 2, 'City')
  await set(backend, 1, 0, 'Ann')
  await set(backend, 1, 1, '30')
  await set(backend, 1, 2, 'NYC')
  await set(backend, 2, 0, 'Bob')
  await set(backend, 2, 1, '25')
  await set(backend, 2, 2, 'LA')
  await set(backend, 3, 0, 'Cy')
  await set(backend, 3, 1, '40')
  await set(backend, 3, 2, 'SF')
}

const A1_C4 = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 }

describe('worker adapter Excel Table CRUD port — real WASM engine + real dispatcher', () => {
  test('createTable applies, and listTables / getTable reflect it (range, columns, sheetId)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)

    const created = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: A1_C4,
      requestId: 5,
    })
    expect(created.applied).toBe(true)
    if (!created.applied) throw new Error('expected an applied createTable result')
    expect(created.kind).toBe('create-table')
    expect(created.name).toBe('Table1') // engine auto-name
    expect(created.requestId).toBe(5)

    const listed = await backend.listTables!({ kind: 'list-tables', requestId: 6 })
    expect(listed.tables).toHaveLength(1)
    const descriptor = listed.tables[0]
    expect(descriptor.name).toBe('Table1')
    expect(descriptor.sheetId).toBe(SHEET)
    expect(descriptor.sheetIndex).toBe(0)
    expect(descriptor.range).toBe('A1:C4')
    expect(descriptor.hasHeaders).toBe(true)
    expect(descriptor.hasTotals).toBe(false)
    expect([...descriptor.columns]).toEqual(['Name', 'Age', 'City'])

    const got = await backend.getTable!({ kind: 'get-table', name: 'table1', requestId: 7 })
    expect(got.table?.name).toBe('Table1')
    expect(got.table?.range).toBe('A1:C4')

    const missing = await backend.getTable!({ kind: 'get-table', name: 'Nope' })
    expect(missing.table).toBeNull()
    backend.dispose()
  })

  test('renameTable and renameTableColumn rewrite the registry', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    const renamed = await backend.renameTable!({
      kind: 'rename-table',
      name: 'Table1',
      newName: 'Sales',
      requestId: 11,
    })
    expect(renamed.applied).toBe(true)
    if (!renamed.applied) throw new Error('expected an applied rename')
    expect(renamed.kind).toBe('table-mutation')
    expect(renamed.name).toBe('Sales')

    let listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables.map((t) => t.name)).toEqual(['Sales'])

    const renamedCol = await backend.renameTableColumn!({
      kind: 'rename-table-column',
      name: 'Sales',
      oldColumn: 'Name',
      newColumn: 'Employee',
      requestId: 12,
    })
    expect(renamedCol.applied).toBe(true)

    listed = await backend.listTables!({ kind: 'list-tables' })
    expect([...listed.tables[0].columns]).toEqual(['Employee', 'Age', 'City'])
    backend.dispose()
  })

  test('deleteTable removes the registry entry (values untouched is engine-tested)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    const deleted = await backend.deleteTable!({
      kind: 'delete-table',
      name: 'Table1',
      requestId: 20,
    })
    expect(deleted.applied).toBe(true)

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables).toHaveLength(0)
    backend.dispose()
  })

  test('a duplicate name rejects with a structured name-conflict result (no throw, no registry change)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: A1_C4,
      name: 'Sales',
    })

    // A non-overlapping second range but the SAME explicit name.
    await set(backend, 0, 4, 'H')
    const rejected = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 3, colStart: 4, colEnd: 5 },
      name: 'Sales',
      requestId: 31,
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected createTable result')
    expect(rejected.kind).toBe('table-mutation-not-applied')
    expect(rejected.code).toBe('name-conflict')

    // The registry still holds exactly the first table.
    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables.map((t) => t.name)).toEqual(['Sales'])
    backend.dispose()
  })

  test('an overlapping range rejects with a structured range-overlap result', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    const rejected = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 2 },
      name: 'Other',
      requestId: 41,
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected createTable result')
    expect(rejected.code).toBe('range-overlap')

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables).toHaveLength(1)
    backend.dispose()
  })

  test('a structural insert above the table shifts its range (engine remap)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    await backend.insertRows!({
      kind: 'insert-rows',
      sheetId: SHEET,
      rowIndex: 0,
      count: 1,
      requestId: 51,
    })

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].range).toBe('A2:C5')
    backend.dispose()
  })

  test('capability: the WASM null witness keeps all six Table CRUD ports exposed', async () => {
    const backend = await createBackend()
    expect(typeof backend.createTable).toBe('function')
    expect(typeof backend.renameTable).toBe('function')
    expect(typeof backend.renameTableColumn).toBe('function')
    expect(typeof backend.deleteTable).toBe('function')
    expect(typeof backend.listTables).toBe('function')
    expect(typeof backend.getTable).toBe('function')
    backend.dispose()
  })
})
