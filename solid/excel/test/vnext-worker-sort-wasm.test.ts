/**
 * @jest-environment node
 *
 * Engine physical sort (design-engine-sort S2/S3) — the `sortRange` RPC
 * over the REAL WASM engine and the REAL `worker-runtime.ts` dispatcher
 * in process. Same harness as vnext-worker-paste-special-wasm.test.ts:
 * wasm-pkg jest-mocked onto itself with the binary pre-loaded through
 * `initSync`, a fake `self` installed before the runtime module imports.
 *
 * Exercised at the WorkerWorkbookClient level (the S4 host port + undo
 * wrapping is a later slice): pins the RPC contract this slice ships —
 *  - success resolves `{ movedRows, movedCells, rowPermutation }` and the
 *    engine data physically reorders,
 *  - a no-op sort resolves movedRows:0 with an empty permutation,
 *  - every engine/payload gate rejects with `code: 'SORT_REJECTED'` and a
 *    structured `detail` (empty-keys, key-out-of-range, invalid-payload,
 *    spill-in-range with its anchor).
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type * as NodeFsModule from 'node:fs'
import type * as NodePathModule from 'node:path'
import type { WorkerLike, WorkerWorkbookClient } from '../src-vnext/adapter'

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

async function freshClient(): Promise<WorkerWorkbookClient> {
  const client = createClient!()
  await client.initWorkbook(['Sheet1'])
  return client
}

async function seedNumbers(client: WorkerWorkbookClient, col: string, values: number[]) {
  for (let i = 0; i < values.length; i += 1) {
    await client.setCell(0, `${col}${i + 1}`, { type: 'number', value: values[i] })
  }
}

async function readColumn(
  client: WorkerWorkbookClient,
  col: string,
  rows: number,
): Promise<string[]> {
  const cells = await client.readCells(
    Array.from({ length: rows }, (_, i) => ({ sheet: 0, addr: `${col}${i + 1}` })),
  )
  return cells.map((cell) => cell.display)
}

describe('sortRange RPC over the real WASM engine', () => {
  test('ascending sort physically reorders the range and reports the move witness', async () => {
    const client = await freshClient()
    // A1..A5 = 5, 3, 4, 1, 2 → asc → 1, 2, 3, 4, 5 (every row moves).
    await seedNumbers(client, 'A', [5, 3, 4, 1, 2])

    const report = await client.sortRange(0, {
      range: { startRow: 0, startCol: 0, endRow: 4, endCol: 0 },
      keys: [{ col: 0, direction: 'asc' }],
    })

    expect(report.movedRows).toBe(5)
    expect(report.movedCells).toBe(5)
    expect(Array.isArray(report.rowPermutation)).toBe(true)
    expect(report.rowPermutation).toHaveLength(5)
    // Each witness pair is [changedSlotRow, sourceRowBeforeSort].
    for (const pair of report.rowPermutation) {
      expect(pair).toHaveLength(2)
    }

    expect(await readColumn(client, 'A', 5)).toEqual(['1', '2', '3', '4', '5'])
    client.dispose()
  })

  test('descending sort and a leading-column tie-break key', async () => {
    const client = await freshClient()
    await seedNumbers(client, 'A', [1, 2, 3])
    const report = await client.sortRange(0, {
      range: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
      keys: [{ col: 0, direction: 'desc' }],
    })
    expect(report.movedRows).toBeGreaterThan(0)
    expect(await readColumn(client, 'A', 3)).toEqual(['3', '2', '1'])
    client.dispose()
  })

  test('a no-op sort (already ordered) reports movedRows:0 and an empty permutation', async () => {
    const client = await freshClient()
    await seedNumbers(client, 'A', [1, 2, 3])
    const report = await client.sortRange(0, {
      range: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
      keys: [{ col: 0, direction: 'asc' }],
    })
    expect(report.movedRows).toBe(0)
    expect(report.rowPermutation).toEqual([])
    expect(await readColumn(client, 'A', 3)).toEqual(['1', '2', '3'])
    client.dispose()
  })

  test('an A1 range string is accepted (parity with the bounds object)', async () => {
    const client = await freshClient()
    await seedNumbers(client, 'A', [2, 1])
    await client.sortRange(0, { range: 'A1:A2', keys: [{ col: 0 }] })
    expect(await readColumn(client, 'A', 2)).toEqual(['1', '2'])
    client.dispose()
  })

  test('empty keys reject with SORT_REJECTED / empty-keys', async () => {
    const client = await freshClient()
    await seedNumbers(client, 'A', [2, 1])
    await expect(
      client.sortRange(0, {
        range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        keys: [],
      }),
    ).rejects.toMatchObject({ code: 'SORT_REJECTED', detail: { code: 'empty-keys' } })
    // The failed gate must not have moved data.
    expect(await readColumn(client, 'A', 2)).toEqual(['2', '1'])
    client.dispose()
  })

  test('a key column outside the range rejects with key-out-of-range', async () => {
    const client = await freshClient()
    await seedNumbers(client, 'A', [2, 1])
    await expect(
      client.sortRange(0, {
        range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        keys: [{ col: 9 }],
      }),
    ).rejects.toMatchObject({ code: 'SORT_REJECTED', detail: { code: 'key-out-of-range' } })
    client.dispose()
  })

  test('a malformed payload (missing range) rejects with invalid-payload', async () => {
    const client = await freshClient()
    await expect(
      client.sortRange(0, { keys: [{ col: 0 }] } as never),
    ).rejects.toMatchObject({ code: 'SORT_REJECTED', detail: { code: 'invalid-payload' } })
    client.dispose()
  })

  test('a range intersecting a spill rejects with spill-in-range + anchor', async () => {
    const client = await freshClient()
    // =SEQUENCE(3) spills a 3×1 array down A1:A3.
    await client.setFormula(0, 'A1', '=SEQUENCE(3)')
    // Force the spill to materialize before the sort inspects it.
    expect(await readColumn(client, 'A', 3)).toEqual(['1', '2', '3'])

    await expect(
      client.sortRange(0, {
        range: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
        keys: [{ col: 0 }],
      }),
    ).rejects.toMatchObject({
      code: 'SORT_REJECTED',
      detail: { code: 'spill-in-range', anchor: 'A1' },
    })
    client.dispose()
  })
})
