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
import type {
  BackendMutationResult,
  DisplayCell,
  TableTotalsFunction,
} from '@einfach/spreadsheet-ui-core'

import type * as NodeFsModule from 'node:fs'
import type * as NodePathModule from 'node:path'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'

jest.mock('../wasm-pkg/einfach_wasm.js', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { readFileSync } = require('node:fs') as typeof NodeFsModule
  const nodePath = require('node:path') as typeof NodePathModule
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

/**
 * Every command the adapter sends the worker, in order. The #25 replay-order
 * pin reads this: the sequence of RPCs a table undo emits is the observable
 * that distinguishes registry-first from cells-first.
 */
const commandLog: string[] = []

const inProcessWorker: WorkerLike = {
  postMessage(msg: unknown) {
    const cmd = (msg as { cmd?: unknown }).cmd
    if (typeof cmd === 'string') commandLog.push(cmd)
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
  (globalThis as Record<string, unknown>).self = {
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

async function readCell(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
): Promise<DisplayCell | undefined> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    requestId: setRequestId++,
    reason: 'test',
    range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
  })
  return result.cells.find((c) => c.row === row && c.col === col)
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

describe('worker adapter Excel Table totals row — real WASM engine + real dispatcher', () => {
  test('toggle grows the range + hasTotals; a column aggregate evaluates and recomputes on edit', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    // Enable the totals row: range grows by one row, hasTotals flips.
    const toggled = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
      requestId: 60,
    })
    expect(toggled.applied).toBe(true)
    if (!toggled.applied) throw new Error('expected an applied totals toggle')
    expect(toggled.kind).toBe('table-mutation')
    expect(toggled.name).toBe('Table1')

    let listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(true)
    expect(listed.tables[0].range).toBe('A1:C5')

    // Set the Age column's totals aggregate to SUM → SUBTOTAL(109, Table1[Age]).
    const fn = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Age',
      func: 'sum',
      requestId: 61,
    })
    expect(fn.applied).toBe(true)

    // The totals cell sits at the last (5th) row, Age column (B5 = row 4, col 1).
    const total = await readCell(backend, 4, 1)
    expect(total?.displayValue).toBe('95') // 30 + 25 + 40

    // Editing a data cell recomputes the SUBTOTAL total live.
    await set(backend, 1, 1, '100') // Ann's Age 30 → 100
    const recomputed = await readCell(backend, 4, 1)
    expect(recomputed?.displayValue).toBe('165') // 100 + 25 + 40

    // Disabling shrinks the range back and clears hasTotals.
    const off = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: false,
      requestId: 62,
    })
    expect(off.applied).toBe(true)
    listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(false)
    expect(listed.tables[0].range).toBe('A1:C4')
    backend.dispose()
  })

  test('enabling the totals row is rejected structurally when the row below is occupied', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    // Occupy A5 — the row the totals row would grow into.
    await set(backend, 4, 0, 'blocker')

    const rejected = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
      requestId: 70,
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected totals toggle')
    expect(rejected.kind).toBe('table-mutation-not-applied')
    expect(rejected.code).toBe('totals-row-blocked')

    // No geometry change — the table stays A1:C4 without a totals row.
    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(false)
    expect(listed.tables[0].range).toBe('A1:C4')
    backend.dispose()
  })

  test('setTableTotalFunction rejects no-totals-row before enable and invalid-totals-function for an unknown id', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    const noRow = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Age',
      func: 'sum',
      requestId: 80,
    })
    expect(noRow.applied).toBe(false)
    if (noRow.applied) throw new Error('expected a rejected totals function')
    expect(noRow.code).toBe('no-totals-row')

    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    const badFunc = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Age',
      func: 'bogus' as unknown as TableTotalsFunction,
      requestId: 81,
    })
    expect(badFunc.applied).toBe(false)
    if (badFunc.applied) throw new Error('expected a rejected totals function')
    expect(badFunc.code).toBe('invalid-totals-function')
    backend.dispose()
  })

  test('capability: the WASM null witness exposes the totals ports', async () => {
    const backend = await createBackend()
    expect(typeof backend.setTableTotalsRow).toBe('function')
    expect(typeof backend.setTableTotalFunction).toBe('function')
    backend.dispose()
  })
})

// ===========================================================================
// Table DEFINITION undo (#25) — host-orchestrated transactions over the real
// WASM engine.
//
// The whole point of these tests is the PAIRING: a Table transaction carries
// the `snapshotTables` registry envelope AND a workbook-wide sparse cell
// image on ONE record, so the registry and the cells that encode it can never
// roll back independently. The totals-row test is the direct pin for that
// half-state (E1): `hasTotals` and the `SUBTOTAL` cell must move together.
// ===========================================================================

let undoSeq = 0
function undoRequest(): { kind: 'undo-transaction'; transactionId: string; requestId: number } {
  undoSeq += 1
  return { kind: 'undo-transaction', transactionId: `tx-${undoSeq}`, requestId: 9000 + undoSeq }
}
function redoRequest(transactionId: string): {
  kind: 'redo-transaction'
  transactionId: string
  requestId: number
} {
  undoSeq += 1
  return { kind: 'redo-transaction', transactionId, requestId: 9000 + undoSeq }
}

describe('worker adapter Excel Table definition undo — real WASM engine + real dispatcher', () => {
  test('createTable → undo drops the table and the referencing formula falls back to #NAME?', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    // A formula that only resolves while the table exists.
    await set(backend, 6, 0, '=SUM(Table1[Age])')
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('#NAME?')

    const created = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: A1_C4,
      requestId: 200,
    })
    expect(created.applied).toBe(true)
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('95')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables).toHaveLength(0)
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('#NAME?')

    // Redo brings the registry AND the resolved formula back.
    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    const relisted = await backend.listTables!({ kind: 'list-tables' })
    expect(relisted.tables.map((t) => t.name)).toEqual(['Table1'])
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('95')
    backend.dispose()
  })

  test('renameTable → undo restores both the formula TEXT and its resolution', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    await set(backend, 6, 0, '=SUM(Table1[Age])')
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('95')

    const renamed = await backend.renameTable!({
      kind: 'rename-table',
      name: 'Table1',
      newName: 'Sales',
      requestId: 210,
    })
    expect(renamed.applied).toBe(true)
    // The engine rewrote the formula TEXT — this is why the transaction needs
    // a cell image, not just the registry envelope.
    expect((await readCell(backend, 6, 0))?.formula).toBe('=SUM(Sales[Age])')

    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables.map((t) => t.name)).toEqual(['Table1'])
    const cell = await readCell(backend, 6, 0)
    expect(cell?.formula).toBe('=SUM(Table1[Age])')
    expect(cell?.displayValue).toBe('95')
    backend.dispose()
  })

  test('renameTableColumn → undo restores the column name and the referencing formula', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    await set(backend, 6, 0, '=SUM(Table1[Age])')

    await backend.renameTableColumn!({
      kind: 'rename-table-column',
      name: 'Table1',
      oldColumn: 'Age',
      newColumn: 'Years',
      requestId: 215,
    })
    expect((await readCell(backend, 6, 0))?.formula).toBe('=SUM(Table1[Years])')

    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect([...listed.tables[0].columns]).toEqual(['Name', 'Age', 'City'])
    const cell = await readCell(backend, 6, 0)
    expect(cell?.formula).toBe('=SUM(Table1[Age])')
    expect(cell?.displayValue).toBe('95')
    backend.dispose()
  })

  test('deleteTable → undo revives the registry entry and the formula evaluates again', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    await set(backend, 6, 0, '=SUM(Table1[Age])')
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('95')

    await backend.deleteTable!({ kind: 'delete-table', name: 'Table1', requestId: 220 })
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('#NAME?')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables.map((t) => t.name)).toEqual(['Table1'])
    expect(listed.tables[0].range).toBe('A1:C4')
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('95')

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('#NAME?')
    backend.dispose()
  })

  test('totals toggle → undo rolls back hasTotals AND the SUBTOTAL cell TOGETHER (E1 half-state)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    // Enable + aggregate: registry grows to A1:C5, B5 holds SUBTOTAL(109,…).
    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
      requestId: 230,
    })
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Age',
      func: 'sum',
      requestId: 231,
    })
    expect((await readCell(backend, 4, 1))?.displayValue).toBe('95')
    // The toggle itself wrote Excel's default SUM into the LAST column, so
    // C5 is non-empty too — the assertions below are not vacuous.
    expect((await readCell(backend, 4, 2))?.formula).toBe('=SUBTOTAL(109,Table1[City])')

    // Undo the aggregate, then undo the toggle.
    const aggregateUndo = await backend.undoTransaction!(undoRequest())
    expect(aggregateUndo.applied).not.toBe(false)
    expect((await readCell(backend, 4, 1))?.displayValue ?? '').toBe('')
    // The toggle itself is still applied — only the aggregate rolled back.
    let listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(true)
    expect(listed.tables[0].range).toBe('A1:C5')

    const toggleUndo = await backend.undoTransaction!(undoRequest())
    expect(toggleUndo.applied).not.toBe(false)

    // BOTH halves rolled back in the same transaction: the registry no longer
    // claims a totals row AND the default SUM cell the toggle wrote is gone.
    listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(false)
    expect(listed.tables[0].range).toBe('A1:C4')
    expect((await readCell(backend, 4, 1))?.displayValue ?? '').toBe('')
    expect((await readCell(backend, 4, 2))?.displayValue ?? '').toBe('')
    backend.dispose()
  })

  test('totals toggle-off → undo restores hasTotals AND re-installs the SUBTOTAL cell', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Age',
      func: 'sum',
    })
    expect((await readCell(backend, 4, 1))?.displayValue).toBe('95')

    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: false,
    })
    expect((await readCell(backend, 4, 1))?.displayValue ?? '').toBe('')

    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)

    const listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(true)
    expect(listed.tables[0].range).toBe('A1:C5')
    // Re-installed AND re-evaluated: `Table1[Age]` is the #Data band, which
    // excludes the totals row only because the registry went back FIRST.
    const total = await readCell(backend, 4, 1)
    expect(total?.formula).toBe('=SUBTOTAL(109,Table1[Age])')
    expect(total?.displayValue).toBe('95')
    backend.dispose()
  })

  test('undo replays the registry BEFORE the cells (#25 replay order)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    // A totals toggle is the op whose undo exercises BOTH legs (#26): it is
    // the only scope that clears before restoring, so it is the one that can
    // observe registry-before-cells across all three RPCs.
    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })

    commandLog.length = 0
    await backend.undoTransaction!(undoRequest())

    const restoreTables = commandLog.indexOf('restoreTables')
    const clearRange = commandLog.indexOf('clearRange')
    const restoreSparse = commandLog.indexOf('restoreSparse')
    expect(restoreTables).toBeGreaterThanOrEqual(0)
    expect(clearRange).toBeGreaterThanOrEqual(0)
    expect(restoreSparse).toBeGreaterThanOrEqual(0)
    expect(restoreTables).toBeLessThan(clearRange)
    expect(restoreTables).toBeLessThan(restoreSparse)
    backend.dispose()
  })

  test('#26 create / delete undo emits NO cell RPC at all (registry-only scope)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    commandLog.length = 0
    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)
    // `define_table` writes no cell input, so the transaction is pure
    // registry — a workbook-wide clear-then-restore here would be blast
    // radius for nothing.
    expect(commandLog).toContain('restoreTables')
    expect(commandLog).not.toContain('clearRange')
    expect(commandLog).not.toContain('restoreSparse')
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    backend.dispose()
  })

  test('#26 rename undo restores formula TEXT with no pre-clear (in-place rewrite)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })
    await set(backend, 6, 0, '=SUM(Table1[Age])')
    // A literal that a workbook-wide clear-then-restore would have had to
    // carry; the formula-only image must leave it strictly alone.
    await set(backend, 7, 0, 'untouched-literal')

    await backend.renameTable!({ kind: 'rename-table', name: 'Table1', newName: 'Sales' })
    expect((await readCell(backend, 6, 0))?.formula).toBe('=SUM(Sales[Age])')

    commandLog.length = 0
    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)
    expect(commandLog).toContain('restoreTables')
    expect(commandLog).toContain('restoreSparse')
    expect(commandLog).not.toContain('clearRange')

    expect((await readCell(backend, 6, 0))?.formula).toBe('=SUM(Table1[Age])')
    expect((await readCell(backend, 6, 0))?.displayValue).toBe('95')
    expect((await readCell(backend, 7, 0))?.displayValue).toBe('untouched-literal')
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].name).toBe('Table1')
    backend.dispose()
  })

  test('a structured reject records NOTHING (host/adapter stacks stay aligned)', async () => {
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    // Overlapping range → range-overlap, all-or-nothing, nothing to undo.
    const rejected = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 2 },
      requestId: 240,
    })
    expect(rejected.applied).toBe(false)

    // The top record is still the ORIGINAL create — undo removes the table.
    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    backend.dispose()
  })

  test('#26 a workbook of LITERALS over the old cap no longer degrades anything', async () => {
    const adapter = await import('../src-vnext/adapter')
    const backend = await createBackend()
    await seedTableData(backend)

    // 4000 literal cells — double the retired 2000 whole-workbook cap, and
    // over BOTH new caps. None of them can be touched by a table op, so no
    // image counts them and nothing degrades.
    const bulk = Math.max(
      adapter.WORKER_TABLE_FORMULA_SNAPSHOT_MAX,
      adapter.WORKER_TABLE_TOTALS_SNAPSHOT_MAX,
    )
    const cells: Array<{ row: number; col: number; input: string }> = []
    for (let i = 0; i <= bulk; i += 1) {
      cells.push({ row: 100 + Math.floor(i / 50), col: i % 50, input: String(i + 1) })
    }
    await backend.importCells!({ kind: 'import-cells', sheetId: SHEET, cells, requestId: 250 })

    const created = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: A1_C4,
      requestId: 251,
    })
    expect(created.applied).toBe(true)

    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    // …and the filler literals are exactly where they were.
    expect((await readCell(backend, 100, 0))?.displayValue).toBe('1')
    backend.dispose()
  })

  test('#26 over WORKER_TABLE_FORMULA_SNAPSHOT_MAX a RENAME still degrades to not-undoable', async () => {
    const adapter = await import('../src-vnext/adapter')
    const cap = adapter.WORKER_TABLE_FORMULA_SNAPSHOT_MAX
    const backend = await createBackend()
    await seedTableData(backend)
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_C4 })

    // Only FORMULA cells enter a rename image, so the cap must be crossed
    // with formulas — literals are free.
    const cells: Array<{ row: number; col: number; input: string }> = []
    for (let i = 0; i <= cap; i += 1) {
      cells.push({ row: 100 + Math.floor(i / 50), col: i % 50, input: `=${i + 1}` })
    }
    await backend.importCells!({ kind: 'import-cells', sheetId: SHEET, cells, requestId: 260 })

    const renamed = await backend.renameTable!({
      kind: 'rename-table',
      name: 'Table1',
      newName: 'Sales',
      requestId: 261,
    })
    // The mutation still RUNS — degradation never blocks the operation.
    expect(renamed.applied).toBe(true)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].name).toBe('Sales')

    const undone = await backend.undoTransaction!(undoRequest())
    expect(undone.applied).toBe(false)
    if (undone.applied !== false) throw new Error('expected a not-applied undo')
    expect(undone.notAppliedReason).toContain(String(cap))
    expect(undone.notAppliedReason).toContain('not undoable')
    // Nothing half-restored.
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].name).toBe('Sales')
    backend.dispose()
  })
})

/**
 * #26 REGRESSION — the defect the perf gate exposed, at the size that
 * exposed it.
 *
 * Under the retired whole-workbook `WORKER_TABLE_SNAPSHOT_MAX = 2000`, a
 * 500-row × 5-column table (2500 non-empty cells) put EVERY table-definition
 * op over the cap, so each one recorded as not-undoable and Ctrl+Z silently
 * did nothing — at a table size an Excel user reaches immediately. Each case
 * below drives the real engine at exactly that size and proves the undo
 * lands, plus the redo round-trip back.
 */
describe('#26 Table undo at 500 rows × 5 columns (over the retired workbook cap)', () => {
  const BIG_ROWS = 500
  const BIG_COLS = 5
  /** A1:E500 — header row + 499 data rows, 2500 non-empty cells. */
  const BIG_RANGE = { rowStart: 0, rowEnd: BIG_ROWS - 1, colStart: 0, colEnd: BIG_COLS - 1 }

  async function bigBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
    const backend = await createBackend()
    const cells: Array<{ row: number; col: number; input: string }> = []
    for (let col = 0; col < BIG_COLS; col += 1) {
      cells.push({ row: 0, col, input: `Col${col + 1}` })
    }
    for (let row = 1; row < BIG_ROWS; row += 1) {
      for (let col = 0; col < BIG_COLS; col += 1) {
        cells.push({ row, col, input: String(row * BIG_COLS + col) })
      }
    }
    expect(cells).toHaveLength(BIG_ROWS * BIG_COLS)
    await backend.importCells!({ kind: 'import-cells', sheetId: SHEET, cells })
    return backend
  }

  test('createTable undo/redo round-trips', async () => {
    const backend = await bigBackend()
    const created = await backend.createTable!({
      kind: 'create-table',
      sheetId: SHEET,
      range: BIG_RANGE,
    })
    expect(created.applied).toBe(true)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].range).toBe('A1:E500')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    // The 2500 data cells are untouched by the round trip.
    expect((await readCell(backend, 499, 4))?.displayValue).toBe(String(499 * BIG_COLS + 4))

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].range).toBe('A1:E500')
    backend.dispose()
  })

  test('totals-row toggle undo/redo round-trips (registry geometry + SUBTOTAL cell)', async () => {
    const backend = await bigBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: BIG_RANGE })

    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    let listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(true)
    expect(listed.tables[0].range).toBe('A1:E501')
    // Excel default SUM lands in the LAST column of the new totals row.
    expect((await readCell(backend, 500, 4))?.formula).toBe('=SUBTOTAL(109,Table1[Col5])')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)
    listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(false)
    expect(listed.tables[0].range).toBe('A1:E500')
    expect((await readCell(backend, 500, 4))?.displayValue ?? '').toBe('')
    // The last DATA row sits inside the mirrored band — it must survive the
    // clear-then-restore untouched.
    expect((await readCell(backend, 499, 4))?.displayValue).toBe(String(499 * BIG_COLS + 4))

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    listed = await backend.listTables!({ kind: 'list-tables' })
    expect(listed.tables[0].hasTotals).toBe(true)
    expect(listed.tables[0].range).toBe('A1:E501')
    expect((await readCell(backend, 500, 4))?.formula).toBe('=SUBTOTAL(109,Table1[Col5])')
    backend.dispose()
  })

  test('totals FUNCTION undo/redo round-trips', async () => {
    const backend = await bigBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: BIG_RANGE })
    await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })

    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Col2',
      func: 'sum' as TableTotalsFunction,
    })
    expect((await readCell(backend, 500, 1))?.formula).toBe('=SUBTOTAL(109,Table1[Col2])')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)
    expect((await readCell(backend, 500, 1))?.displayValue ?? '').toBe('')
    // Sibling totals cell written by the toggle is NOT collateral damage.
    expect((await readCell(backend, 500, 4))?.formula).toBe('=SUBTOTAL(109,Table1[Col5])')

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    expect((await readCell(backend, 500, 1))?.formula).toBe('=SUBTOTAL(109,Table1[Col2])')
    backend.dispose()
  })

  test('renameTable undo/redo round-trips the cross-sheet formula TEXT', async () => {
    const backend = await bigBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: BIG_RANGE })
    await set(backend, 600, 0, '=SUM(Table1[Col2])')
    const total = (await readCell(backend, 600, 0))?.displayValue
    expect(total).not.toBe('#NAME?')

    await backend.renameTable!({ kind: 'rename-table', name: 'Table1', newName: 'Sales' })
    expect((await readCell(backend, 600, 0))?.formula).toBe('=SUM(Sales[Col2])')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].name).toBe('Table1')
    expect((await readCell(backend, 600, 0))?.formula).toBe('=SUM(Table1[Col2])')
    expect((await readCell(backend, 600, 0))?.displayValue).toBe(total)

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].name).toBe('Sales')
    expect((await readCell(backend, 600, 0))?.formula).toBe('=SUM(Sales[Col2])')
    backend.dispose()
  })

  test('renameTableColumn undo/redo round-trips the referencing formula TEXT', async () => {
    const backend = await bigBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: BIG_RANGE })
    await set(backend, 600, 0, '=SUM(Table1[Col2])')

    await backend.renameTableColumn!({
      kind: 'rename-table-column',
      name: 'Table1',
      oldColumn: 'Col2',
      newColumn: 'Amount',
    })
    expect((await readCell(backend, 600, 0))?.formula).toBe('=SUM(Table1[Amount])')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)
    expect([...(await backend.listTables!({ kind: 'list-tables' })).tables[0].columns]).toContain(
      'Col2',
    )
    expect((await readCell(backend, 600, 0))?.formula).toBe('=SUM(Table1[Col2])')

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    expect((await readCell(backend, 600, 0))?.formula).toBe('=SUM(Table1[Amount])')
    backend.dispose()
  })

  test('deleteTable undo/redo round-trips (convert-to-range keeps the 2500 values)', async () => {
    const backend = await bigBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: BIG_RANGE })
    await set(backend, 600, 0, '=SUM(Table1[Col2])')
    const total = (await readCell(backend, 600, 0))?.displayValue

    await backend.deleteTable!({ kind: 'delete-table', name: 'Table1' })
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    expect((await readCell(backend, 600, 0))?.displayValue).toBe('#NAME?')

    const request = undoRequest()
    const undone = await backend.undoTransaction!(request)
    expect(undone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables[0].range).toBe('A1:E500')
    expect((await readCell(backend, 600, 0))?.displayValue).toBe(total)
    expect((await readCell(backend, 250, 3))?.displayValue).toBe(String(250 * BIG_COLS + 3))

    const redone = await backend.redoTransaction!(redoRequest(request.transactionId))
    expect(redone.applied).not.toBe(false)
    expect((await backend.listTables!({ kind: 'list-tables' })).tables).toHaveLength(0)
    expect((await readCell(backend, 600, 0))?.displayValue).toBe('#NAME?')
    backend.dispose()
  })
})
