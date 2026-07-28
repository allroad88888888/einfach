/**
 * @jest-environment node
 *
 * Engine physical sort — STATIC ⇄ WASM golden parity (design-engine-sort #19,
 * §3.2 / §9.1). The static reference backend and the real Rust engine must sort
 * the SAME shuffled data into the SAME row order, cell for cell — this is what
 * locks the shared comparator (`sort-order.ts`) to the normative Rust `sort_cmp`
 * across the two backends and rules out any locale-collation drift.
 *
 * Method: one dataset with a mixed-type KEY column (numbers / text with case /
 * booleans / errors / empties) and a unique MARKER in the adjacent column. Seed
 * it into a WASM worker AND a static backend, sort both by the key column, then
 * compare the marker column read back from each. Identical marker order ⇒ the
 * two engines produced the identical permutation.
 *
 * WASM harness mirrors vnext-worker-sort-wasm.test.ts: wasm-pkg mocked onto
 * itself with the binary pre-loaded via `initSync`, a fake `self` installed
 * before the runtime imports, an in-process worker bridging client ⇄ runtime.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type * as NodeFsModule from 'node:fs'
import type * as NodePathModule from 'node:path'
import type { WorkerLike, WorkerWorkbookClient } from '../src-vnext/adapter'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter/static-backend'
import type { DisplayCell, SortDirection } from '@einfach/spreadsheet-ui-core'

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

let createClient: (() => WorkerWorkbookClient) | undefined

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
  createClient = () => adapter.createWorkerWorkbook({ workerFactory: () => inProcessWorker })
})

// === Shared mixed-type dataset ===============================================
// The key column exercises every sort class plus tie-break stability: two equal
// numbers (3), a case-equal text pair (Apple / apple), repeated errors, and
// repeated empties. Markers are unique so a permutation is fully observable.

type Key =
  | { t: 'number'; v: number }
  | { t: 'text'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'error' }
  | { t: 'empty' }

interface Row {
  key: Key
  marker: string
}

const DATASET: readonly Row[] = [
  { key: { t: 'number', v: 3 }, marker: 'm00' },
  { key: { t: 'text', v: 'banana' }, marker: 'm01' },
  { key: { t: 'empty' }, marker: 'm02' },
  { key: { t: 'number', v: -5 }, marker: 'm03' },
  { key: { t: 'boolean', v: true }, marker: 'm04' },
  { key: { t: 'text', v: 'Apple' }, marker: 'm05' },
  { key: { t: 'error' }, marker: 'm06' },
  { key: { t: 'number', v: 0 }, marker: 'm07' },
  { key: { t: 'text', v: 'apple' }, marker: 'm08' },
  { key: { t: 'boolean', v: false }, marker: 'm09' },
  { key: { t: 'number', v: 3 }, marker: 'm10' },
  { key: { t: 'text', v: 'Cherry' }, marker: 'm11' },
  { key: { t: 'empty' }, marker: 'm12' },
  { key: { t: 'error' }, marker: 'm13' },
]

const ROWS = DATASET.length
const SEED_MARKER_ORDER = DATASET.map((row) => row.marker)

const SORT_RANGE = { rowStart: 0, rowEnd: ROWS - 1, colStart: 0, colEnd: 1 }
const WASM_RANGE = { startRow: 0, startCol: 0, endRow: ROWS - 1, endCol: 1 }

async function seedWasm(client: WorkerWorkbookClient): Promise<void> {
  for (let i = 0; i < ROWS; i += 1) {
    const { key, marker } = DATASET[i]
    const addr = `A${i + 1}`
    switch (key.t) {
      case 'number':
        await client.setCell(0, addr, { type: 'number', value: key.v })
        break
      case 'text':
        await client.setCell(0, addr, { type: 'text', value: key.v })
        break
      case 'boolean':
        await client.setCell(0, addr, { type: 'boolean', value: key.v })
        break
      case 'error':
        await client.setCell(0, addr, { type: 'error', value: '#DIV/0!' })
        break
      case 'empty':
        break
    }
    await client.setCell(0, `B${i + 1}`, { type: 'text', value: marker })
  }
}

function staticSeedCells(): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let i = 0; i < ROWS; i += 1) {
    const { key, marker } = DATASET[i]
    switch (key.t) {
      case 'number':
        cells.push({ row: i, col: 0, displayValue: String(key.v), valueKind: 'number', numericValue: key.v })
        break
      case 'text':
        cells.push({ row: i, col: 0, displayValue: key.v, valueKind: 'string' })
        break
      case 'boolean':
        cells.push({ row: i, col: 0, displayValue: key.v ? 'TRUE' : 'FALSE', valueKind: 'boolean' })
        break
      case 'error':
        cells.push({ row: i, col: 0, displayValue: '#DIV/0!', valueKind: 'error' })
        break
      case 'empty':
        break
    }
    cells.push({ row: i, col: 1, displayValue: marker, valueKind: 'string' })
  }
  return cells
}

async function readWasmMarkers(client: WorkerWorkbookClient): Promise<string[]> {
  const cells = await client.readCells(
    Array.from({ length: ROWS }, (_, i) => ({ sheet: 0, addr: `B${i + 1}` })),
  )
  return cells.map((cell) => cell.display)
}

async function readStaticMarkers(
  backend: ReturnType<typeof createStaticSpreadsheetBackend>,
  sheetId: string,
): Promise<string[]> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId,
    range: SORT_RANGE,
    requestId: 1,
    reason: 'test',
  })
  const byRow = new Map<number, string>()
  for (const cell of result.cells) {
    if (cell.col === 1) byRow.set(cell.row, cell.displayValue)
  }
  return Array.from({ length: ROWS }, (_, i) => byRow.get(i) ?? '')
}

async function wasmSortedMarkers(direction: SortDirection): Promise<string[]> {
  const client = createClient!()
  await client.initWorkbook(['Sheet1'])
  await seedWasm(client)
  await client.sortRange(0, { range: WASM_RANGE, keys: [{ col: 0, direction }] })
  const markers = await readWasmMarkers(client)
  client.dispose()
  return markers
}

async function staticSortedMarkers(direction: SortDirection): Promise<string[]> {
  const backend = createStaticSpreadsheetBackend({
    sheets: ['Sheet1'],
    cells: staticSeedCells(),
  })
  const sheetId = 'sheet-1'
  const result = await backend.sortRange!({
    kind: 'sort-range',
    sheetId,
    range: SORT_RANGE,
    keys: [{ col: 0, direction }],
  })
  expect(result.applied).toBe(true)
  return readStaticMarkers(backend, sheetId)
}

describe('static ⇄ WASM physical-sort parity (mixed types, golden order)', () => {
  test('ascending: static and WASM produce the identical row permutation', async () => {
    const [staticOrder, wasmOrder] = await Promise.all([
      staticSortedMarkers('asc'),
      wasmSortedMarkers('asc'),
    ])
    // A real sort happened (not the seed order) …
    expect(staticOrder).not.toEqual(SEED_MARKER_ORDER)
    // … and both engines agree cell for cell.
    expect(staticOrder).toEqual(wasmOrder)
  })

  test('descending: static and WASM produce the identical row permutation', async () => {
    const [staticOrder, wasmOrder] = await Promise.all([
      staticSortedMarkers('desc'),
      wasmSortedMarkers('desc'),
    ])
    expect(staticOrder).not.toEqual(SEED_MARKER_ORDER)
    expect(staticOrder).toEqual(wasmOrder)
    // Empty keys sink LAST in BOTH directions (never reversed to the top).
    expect(staticOrder.slice(-2).sort()).toEqual(['m02', 'm12'])
  })
})
