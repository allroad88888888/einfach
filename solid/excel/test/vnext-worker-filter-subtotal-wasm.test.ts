/**
 * @jest-environment node
 *
 * #27 S4 — an ACTIVE FILTER reaches the engine, over the REAL Rust engine and
 * the REAL `worker-runtime.ts` dispatcher in process (same harness as
 * vnext-worker-subtotal-hidden-wasm.test.ts: wasm-pkg jest-mocked onto itself
 * with the binary pre-loaded through `initSync`, a fake `self` installed
 * before the runtime module imports).
 *
 * What the slice actually changes: `setFilterSort` now derives the
 * filter-hidden SOURCE rows from the predicate scan it already runs and pushes
 * them through `setEvalFilterHiddenRows`. Before that push existed the engine
 * had no idea a filter was on, so `SUBTOTAL(1-11)` aggregated rows the user
 * had filtered away — a divergence from Excel
 * (`design-filter-hidden-rows` §2), which is why the assertions below are a
 * BUG FIX rather than a new capability.
 *
 * These tests are deliberately differential, not tautological:
 *  - every aggregate is pinned BEFORE the filter too, and the pre-filter value
 *    is exactly what the unfixed path answers afterwards, so an implementation
 *    that pushed nothing fails on the post-filter numbers;
 *  - a plain `SUM` over the identical range is pinned as an unmoved control,
 *    proving no data was touched and only the SUBTOTAL lane responded;
 *  - the manual lane is driven at the same time to pin the two-layer rule
 *    (1-11 keeps manually hidden rows, 101-111 drops them).
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type { DisplayCell } from '@einfach/spreadsheet-ui-core'
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

let createBackend: (() => WorkerWorkbookSpreadsheetBackend) | undefined

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
  createBackend = () =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => inProcessWorker,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })
})

let requestId = 1

/**
 * Region | Q1 over three data rows, plus three probes on ROW 0.
 *
 * The probes live on the header row on purpose: row 0 is a pass-through in the
 * filter permutation, so they stay readable while the compression semantics
 * are still in place (that retires in S5, not here).
 *
 *   A1 Region  B1 Q1   D1 =SUBTOTAL(9,…)  E1 =SUBTOTAL(109,…)  F1 =SUM(…)
 *   A2 North   B2 10
 *   A3 South   B3 20
 *   A4 North   B4 30
 */
const SEED: ReadonlyArray<readonly [number, number, string]> = [
  [0, 0, 'Region'],
  [0, 1, 'Q1'],
  [1, 0, 'North'],
  [1, 1, '10'],
  [2, 0, 'South'],
  [2, 1, '20'],
  [3, 0, 'North'],
  [3, 1, '30'],
  [0, 3, '=SUBTOTAL(9,B2:B4)'],
  [0, 4, '=SUBTOTAL(109,B2:B4)'],
  [0, 5, '=SUM(B2:B4)'],
]

async function seed(backend: WorkerWorkbookSpreadsheetBackend): Promise<void> {
  for (const [row, col, input] of SEED) {
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row,
      col,
      input,
      requestId: requestId++,
    })
  }
}

async function readRow0(
  backend: WorkerWorkbookSpreadsheetBackend,
): Promise<{ subtotal9: string; subtotal109: string; sum: string }> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    reason: 'test',
    requestId: requestId++,
    range: { rowStart: 0, rowEnd: 0, colStart: 3, colEnd: 5 },
  })
  const at = (col: number): string =>
    result.cells.find((cell: DisplayCell) => cell.row === 0 && cell.col === col)?.displayValue ?? ''
  return { subtotal9: at(3), subtotal109: at(4), sum: at(5) }
}

function filterToNorth(backend: WorkerWorkbookSpreadsheetBackend) {
  return backend.setFilterSort!({
    kind: 'set-filter-sort',
    sheetId: SHEET,
    rules: [{ kind: 'equals', colIndex: 0, value: 'North' }],
    requestId: requestId++,
  })
}

describe('worker adapter: an active filter reaches the engine (#27 S4)', () => {
  test('both SUBTOTAL bands drop filtered-out rows; SUM is the unmoved control', async () => {
    const backend = createBackend!()
    await backend.ready()
    await seed(backend)

    // Unfiltered baseline. These ARE the numbers the unfixed path keeps
    // answering after the filter is applied, so the post-filter assertions
    // below cannot pass without the push.
    expect(await readRow0(backend)).toEqual({
      subtotal9: '60',
      subtotal109: '60',
      sum: '60',
    })

    await filterToNorth(backend)

    // South (source row 2, Q1 = 20) is filtered out. BOTH bands drop it —
    // 1-11 excluding filter-hidden rows is the Excel rule the second eval
    // input exists to express.
    const filtered = await readRow0(backend)
    expect(filtered.subtotal9).toBe('40')
    expect(filtered.subtotal109).toBe('40')
    // Control: SUM is not a SUBTOTAL, so it must be completely unaffected.
    // A different number here would mean the filter moved DATA, which it must
    // never do (filter is visibility, sorting is the physical mutation).
    expect(filtered.sum).toBe('60')

    // Clearing restores everything — whole-set replace, empty clears.
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [],
      requestId: requestId++,
    })
    expect(await readRow0(backend)).toEqual({
      subtotal9: '60',
      subtotal109: '60',
      sum: '60',
    })

    backend.dispose()
  })

  test('manual and filter hiding stay independent (the two-layer rule)', async () => {
    const backend = createBackend!()
    await backend.ready()
    await seed(backend)

    await filterToNorth(backend)
    // …and manually hide North's first row (source row 1, Q1 = 10) through
    // the OTHER eval input, exactly as the host's hidden-rows bridge does.
    await backend.setEvalHiddenRows!({
      kind: 'set-eval-hidden-rows',
      sheetId: SHEET,
      rows: [1],
    })

    const both = await readRow0(backend)
    // 1-11: filter row gone (South, 20), manual row STILL counted (North, 10).
    expect(both.subtotal9).toBe('40')
    // 101-111: both gone, only the second North (30) survives.
    expect(both.subtotal109).toBe('30')
    // The inequality IS the feature. One merged set could not produce it.
    expect(both.subtotal9).not.toBe(both.subtotal109)

    // Releasing only the manual set leaves the filter set in place — the two
    // are independently addressable, neither push clobbers the other.
    await backend.setEvalHiddenRows!({
      kind: 'set-eval-hidden-rows',
      sheetId: SHEET,
      rows: [],
    })
    const filterOnly = await readRow0(backend)
    expect(filterOnly.subtotal9).toBe('40')
    expect(filterOnly.subtotal109).toBe('40')

    backend.dispose()
  })

  test('a re-applied filter replaces the previous set rather than accumulating', async () => {
    const backend = createBackend!()
    await backend.ready()
    await seed(backend)

    await filterToNorth(backend)
    expect((await readRow0(backend)).subtotal9).toBe('40')

    // Swap the rule to keep South only: rows 1 and 3 (10 + 30) are now hidden
    // and row 2 (20) is back. Under merge-instead-of-replace semantics every
    // data row would be hidden and this would read 0.
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'equals', colIndex: 0, value: 'South' }],
      requestId: requestId++,
    })
    const south = await readRow0(backend)
    expect(south.subtotal9).toBe('20')
    expect(south.subtotal109).toBe('20')
    expect(south.sum).toBe('60')

    backend.dispose()
  })
})
