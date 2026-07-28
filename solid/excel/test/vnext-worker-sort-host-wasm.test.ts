/**
 * @jest-environment node
 *
 * Engine physical sort THROUGH the host backend port (design-engine-sort
 * S4) — REAL WASM engine + REAL `worker-runtime.ts` dispatcher, in
 * process (same harness as vnext-worker-undo-wasm.test.ts). The bare RPC
 * contract is pinned by vnext-worker-sort-wasm.test.ts; this suite pins
 * the S4 host layer the adapter adds on top of it:
 *  - the `sortRange` port physically reorders data and returns the exact
 *    applied ACK (movedRows / movedCells / affectedRange / rowPermutation),
 *  - ONE host-orchestrated undo transaction round-trips (undo restores the
 *    original order AND the payload column, redo re-applies the sort),
 *  - the fail-closed source-size cap rejects a too-large range with NO
 *    RPC, NO undo record, NO revision bump,
 *  - a SORT_REJECTED engine gate (empty-keys, spill-in-range) short-
 *    circuits to a structured not-applied result WITHOUT recording undo or
 *    bumping the revision,
 *  - the adapter merge authority gate rejects a sort intersecting a merge,
 *  - capability gating: the port stays a function on the WASM (null
 *    witness / full-trust) runtime.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'
import type { BackendMutationResult, CellRange, DisplayCell } from '@einfach/spreadsheet-ui-core'

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

let projectionRequestId = 1

async function readCells(
  backend: WorkerWorkbookSpreadsheetBackend,
  range: CellRange,
): Promise<DisplayCell[]> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    range,
    requestId: projectionRequestId++,
    reason: 'viewport',
  })
  return result.cells
}

async function readCol(
  backend: WorkerWorkbookSpreadsheetBackend,
  col: number,
  rows: number,
): Promise<string[]> {
  const cells = await readCells(backend, {
    rowStart: 0,
    rowEnd: rows - 1,
    colStart: col,
    colEnd: col,
  })
  const byRow = new Map<number, string>()
  for (const cell of cells) if (cell.col === col) byRow.set(cell.row, cell.displayValue)
  return Array.from({ length: rows }, (_, row) => byRow.get(row) ?? '')
}

async function disp(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
): Promise<string> {
  return (await readCol(backend, col, row + 1))[row]
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

let txCounter = 0
function undoRequest(transactionId?: string) {
  txCounter += 1
  return {
    kind: 'undo-transaction' as const,
    transactionId: transactionId ?? `sort-tx-${txCounter}`,
    requestId: txCounter,
    revision: 0,
  }
}

function redoRequest(transactionId: string) {
  txCounter += 1
  return { kind: 'redo-transaction' as const, transactionId, requestId: txCounter, revision: 0 }
}

describe('worker adapter engine physical sort port — real WASM engine + real dispatcher', () => {
  test('sortRange physically reorders data and returns the exact applied ACK', async () => {
    const backend = await createBackend()
    // A1..A5 = 5, 3, 4, 1, 2 → asc → 1, 2, 3, 4, 5 (every row moves).
    await set(backend, 0, 0, '5')
    await set(backend, 1, 0, '3')
    await set(backend, 2, 0, '4')
    await set(backend, 3, 0, '1')
    await set(backend, 4, 0, '2')

    const result = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
      keys: [{ col: 0, direction: 'asc' }],
      requestId: 77,
    })

    expect(result.applied).toBe(true)
    if (!result.applied) throw new Error('expected an applied sort result')
    expect(result.kind).toBe('sort-range')
    expect(result.movedRows).toBe(5)
    expect(result.movedCells).toBe(5)
    expect(result.affectedRange).toEqual({ rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 })
    expect(result.rowPermutation).toHaveLength(5)
    expect(result.requestId).toBe(77)

    expect(await readCol(backend, 0, 5)).toEqual(['1', '2', '3', '4', '5'])
    backend.dispose()
  })

  test('one undo transaction round-trips a physical sort (payload column travels with its row)', async () => {
    const backend = await createBackend()
    // Column 0 is the sort key; column 1 is a payload that must move with
    // its row so undo/redo proves whole-row coherence, not just the key.
    await set(backend, 0, 0, '3')
    await set(backend, 0, 1, 'c')
    await set(backend, 1, 0, '1')
    await set(backend, 1, 1, 'a')
    await set(backend, 2, 0, '2')
    await set(backend, 2, 1, 'b')

    const result = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
      keys: [{ col: 0, direction: 'asc' }],
    })
    expect(result.applied).toBe(true)
    expect(await readCol(backend, 0, 3)).toEqual(['1', '2', '3'])
    expect(await readCol(backend, 1, 3)).toEqual(['a', 'b', 'c'])

    const undoAck = await backend.undoTransaction!(undoRequest('sort-roundtrip'))
    expect(undoAck.applied).not.toBe(false)
    expect(await readCol(backend, 0, 3)).toEqual(['3', '1', '2'])
    expect(await readCol(backend, 1, 3)).toEqual(['c', 'a', 'b'])

    const redoAck = await backend.redoTransaction!(redoRequest('sort-roundtrip'))
    expect(redoAck.applied).not.toBe(false)
    expect(await readCol(backend, 0, 3)).toEqual(['1', '2', '3'])
    expect(await readCol(backend, 1, 3)).toEqual(['a', 'b', 'c'])
    backend.dispose()
  })

  test('a no-op sort (already ordered) resolves applied with movedRows:0 and an empty permutation', async () => {
    const backend = await createBackend()
    await set(backend, 0, 0, '1')
    await set(backend, 1, 0, '2')
    await set(backend, 2, 0, '3')

    const result = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      keys: [{ col: 0, direction: 'asc' }],
    })
    expect(result.applied).toBe(true)
    if (!result.applied) throw new Error('expected an applied sort result')
    expect(result.movedRows).toBe(0)
    expect(result.rowPermutation).toEqual([])
    expect(await readCol(backend, 0, 3)).toEqual(['1', '2', '3'])

    // No undo record was pushed for the no-op: a single undo pops the LAST
    // set edit (row 2 → '') directly, with no identity sort record in
    // between that would skew the host↔UI-core stack alignment (design §7).
    const undoAck = await backend.undoTransaction!(undoRequest('noop-last-set'))
    expect(undoAck.applied).not.toBe(false)
    expect(await disp(backend, 2, 0)).toBe('')
    expect(await disp(backend, 1, 0)).toBe('2')
    backend.dispose()
  })

  test('the source-size cap rejects a too-large range with no RPC, no undo record, no revision bump', async () => {
    const backend = await createBackend()
    const seedAck = await set(backend, 0, 0, 'seed')

    const rejected = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      // area = 50000 rows × 2 cols = 100000 > MAX_SORT_SOURCE_CELLS (50000)
      range: { rowStart: 0, rowEnd: 49999, colStart: 0, colEnd: 1 },
      keys: [{ col: 0 }],
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected sort result')
    expect(rejected.code).toBe('source-too-large')
    // No revision bump: the reject echoes the same witness the seed produced.
    expect(rejected.revision).toBe(seedAck.revision)

    // No sort record was pushed: the single undo pops the SEED edit itself.
    const undoAck = await backend.undoTransaction!(undoRequest('cap-seed'))
    expect(undoAck.applied).not.toBe(false)
    expect(await disp(backend, 0, 0)).toBe('')
    backend.dispose()
  })

  test('a SORT_REJECTED engine gate (empty-keys) short-circuits without recording undo or bumping', async () => {
    const backend = await createBackend()
    await set(backend, 0, 0, '2')
    const seedAck = await set(backend, 1, 0, '1')

    const rejected = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      keys: [], // empty-keys → engine SORT_REJECTED, not a thrown promise
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected sort result')
    expect(rejected.code).toBe('empty-keys')
    expect(rejected.revision).toBe(seedAck.revision) // no bump
    expect(await readCol(backend, 0, 2)).toEqual(['2', '1']) // data untouched

    // No sort record: the one undo pops the last SEED edit (A2), proving
    // the failed gate left the transaction stack aligned.
    const undoAck = await backend.undoTransaction!(undoRequest('reject-seed'))
    expect(undoAck.applied).not.toBe(false)
    expect(await disp(backend, 1, 0)).toBe('')
    expect(await disp(backend, 0, 0)).toBe('2')
    backend.dispose()
  })

  test('a spill intersection rejects with spill-in-range and forwards the anchor', async () => {
    const backend = await createBackend()
    await set(backend, 0, 0, '=SEQUENCE(3)')
    expect(await disp(backend, 0, 0)).toBe('1') // materialize the spill first

    const rejected = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      keys: [{ col: 0 }],
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected sort result')
    expect(rejected.code).toBe('spill-in-range')
    expect(rejected.anchor).toBe('A1')
    backend.dispose()
  })

  test('the adapter merge authority gate rejects a sort intersecting a merged range (no RPC)', async () => {
    const backend = await createBackend()
    await set(backend, 0, 0, '2')
    await set(backend, 1, 0, '1')
    await backend.mergeRange!({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    const rejected = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      keys: [{ col: 0 }],
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected sort result')
    expect(rejected.code).toBe('merge-in-range')
    expect(await readCol(backend, 0, 2)).toEqual(['2', '1']) // untouched
    backend.dispose()
  })

  test('capability: the WASM null witness keeps the sortRange port exposed', async () => {
    const backend = await createBackend()
    expect(typeof backend.sortRange).toBe('function')
    backend.dispose()
  })
})
