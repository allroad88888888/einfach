/**
 * @jest-environment node
 *
 * SUBTOTAL hidden-row eval input (parity #23) — the `setEvalHiddenRows` RPC
 * over the REAL WASM engine and the REAL `worker-runtime.ts` dispatcher in
 * process. Same harness as vnext-worker-sort-wasm.test.ts: wasm-pkg
 * jest-mocked onto itself with the binary pre-loaded through `initSync`, a
 * fake `self` installed before the runtime module imports.
 *
 * Pins the eval-input contract this slice ships:
 *  - a whole-set hidden push makes SUBTOTAL 109 drop the referenced rows
 *    while SUBTOTAL 9 stays unchanged,
 *  - an empty push clears the set and 109 recovers,
 *  - re-pushing (idempotent whole-set replace) lands the newest set,
 *  - an out-of-range sheet index is a silent no-op (does not throw).
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type { WorkerLike, WorkerWorkbookClient } from '../src-vnext/adapter'

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

async function readDisplay(client: WorkerWorkbookClient, addr: string): Promise<string> {
  const [cell] = await client.readCells([{ sheet: 0, addr }])
  return cell.display
}

/** A1..A5 = 10/20/30/40/50; B1 = SUBTOTAL(109,…) (exclude-hidden), B2 = SUBTOTAL(9,…). */
async function seedSubtotalSheet(client: WorkerWorkbookClient) {
  await seedNumbers(client, 'A', [10, 20, 30, 40, 50])
  await client.setFormula(0, 'B1', '=SUBTOTAL(109,A1:A5)')
  await client.setFormula(0, 'B2', '=SUBTOTAL(9,A1:A5)')
}

describe('setEvalHiddenRows RPC over the real WASM engine', () => {
  test('a hidden push excludes rows from SUBTOTAL 109 but not SUBTOTAL 9', async () => {
    const client = await freshClient()
    await seedSubtotalSheet(client)

    // Baseline: nothing hidden — both variants sum the whole column.
    expect(await readDisplay(client, 'B1')).toBe('150')
    expect(await readDisplay(client, 'B2')).toBe('150')

    // Hide 0-based rows 1 and 3 (A2 = 20, A4 = 40).
    await client.setEvalHiddenRows(0, [1, 3])
    expect(await readDisplay(client, 'B1')).toBe('90') // 150 - 20 - 40
    expect(await readDisplay(client, 'B2')).toBe('150') // 9 includes hidden

    // Clearing the set restores 109.
    await client.setEvalHiddenRows(0, [])
    expect(await readDisplay(client, 'B1')).toBe('150')
    expect(await readDisplay(client, 'B2')).toBe('150')

    client.dispose()
  })

  test('a re-push replaces the whole set (idempotent whole-set semantics)', async () => {
    const client = await freshClient()
    await seedSubtotalSheet(client)

    await client.setEvalHiddenRows(0, [0])
    expect(await readDisplay(client, 'B1')).toBe('140') // exclude A1 = 10

    // Whole-set replace: the previous [0] is dropped, only [4] remains.
    await client.setEvalHiddenRows(0, [4])
    expect(await readDisplay(client, 'B1')).toBe('100') // exclude A5 = 50 only

    // Re-pushing the same set is a safe no-op on the value.
    await client.setEvalHiddenRows(0, [4])
    expect(await readDisplay(client, 'B1')).toBe('100')

    client.dispose()
  })

  test('an out-of-range sheet index is a silent no-op', async () => {
    const client = await freshClient()
    await seedSubtotalSheet(client)

    // Resolves without throwing (the engine no-ops an unknown sheet index).
    await client.setEvalHiddenRows(99, [0, 1, 2])
    // The real sheet is untouched.
    expect(await readDisplay(client, 'B1')).toBe('150')

    client.dispose()
  })
})
