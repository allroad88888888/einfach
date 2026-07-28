/**
 * Parity #11 — Paste Special on the WORKER path, TS runtime, real
 * in-process stack: the actual `createWorkerRuntimeTs()` dispatcher
 * behind a duplex bridge, the actual `WorkerWorkbookClient`, and the
 * actual `createWorkerWorkbookSpreadsheetBackend`.
 *
 * The static backend is the reference implementation. Every semantic
 * case here seeds BOTH backends with the same import stream, sends the
 * same `PasteRangeRequest`, and asserts the worker projection equals
 * the static projection — the parity lock the shared
 * `paste-range-plan.ts` helpers exist for.
 *
 * TS-runtime-only pins on top of parity:
 *  - `pasteRangeSupportedKinds` subdivides to the value-leg kinds
 *    (runtime declares `formats: false` / `formatSnapshots: false`),
 *  - a format-leg request that arrives anyway rejects fail-closed with
 *    `PASTE_RANGE_FORMATS_UNSUPPORTED` before any write,
 *  - exact ACK shape for the UI-core strict acknowledgement chain,
 *  - host-orchestrated undo/redo round trip of one paste transaction.
 */

import { describe, expect, test } from '@jest/globals'
import {
  SUPPORTED_PASTE_SPECIAL_KINDS,
  type CellRange,
  type DisplayCell,
  type PasteRangeRequest,
  type PasteSpecialKind,
  type PasteSpecialOp,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

import {
  installWorkerRuntimeTs,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import {
  createStaticSpreadsheetBackend,
  createWorkerWorkbookSpreadsheetBackend,
  PASTE_RANGE_FORMATS_UNSUPPORTED,
} from '../src-vnext/adapter'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'

const SHEET = 'sheet-1'

function createInProcessTsWorker(): WorkerLike {
  const toWorker: Array<(e: MessageEvent) => void> = []
  const toClient: Array<(e: MessageEvent) => void> = []
  const workerCtx: WorkerContext = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type, listener) {
      toWorker.push(listener)
    },
  }
  installWorkerRuntimeTs(workerCtx)
  return {
    postMessage(msg: unknown) {
      for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      toClient.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = toClient.indexOf(listener)
      if (index >= 0) toClient.splice(index, 1)
    },
    terminate() {},
  }
}

async function createWorkerBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: () => createInProcessTsWorker(),
    sheets: [{ id: SHEET, name: 'Sheet1' }],
  })
  await backend.ready()
  return backend
}

type Seed = { row: number; col: number; input: string }

async function seedBackend(backend: SpreadsheetBackend, cells: Seed[]): Promise<void> {
  if (cells.length === 0) return
  await backend.importCells!({
    kind: 'import-cells',
    sheetId: SHEET,
    cells,
  })
}

let projectionRequestId = 1

async function readGrid(
  backend: SpreadsheetBackend,
  range: CellRange,
): Promise<Map<string, { display: string; formula?: string }>> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    range,
    requestId: projectionRequestId++,
    reason: 'viewport',
  } as never)
  const grid = new Map<string, { display: string; formula?: string }>()
  for (const cell of result.cells as DisplayCell[]) {
    if (cell.displayValue === '' && !cell.formula) continue
    grid.set(`${cell.row}:${cell.col}`, {
      display: cell.displayValue,
      ...(cell.formula ? { formula: cell.formula } : {}),
    })
  }
  return grid
}

function pasteRequest(overrides: Partial<PasteRangeRequest> = {}): PasteRangeRequest {
  return {
    kind: 'paste-range',
    sheetId: SHEET,
    target: { rowStart: 4, rowEnd: 5, colStart: 0, colEnd: 1 },
    source: {
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    },
    pasteKind: 'values',
    op: 'none',
    transpose: false,
    skipBlanks: false,
    requestId: 77,
    ...overrides,
  }
}

const OBSERVED: CellRange = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }

/** Seed static + worker identically, run the same request, assert equality. */
async function expectParity(
  seeds: Seed[],
  request: PasteRangeRequest,
): Promise<{ worker: WorkerWorkbookSpreadsheetBackend }> {
  const staticBackend = createStaticSpreadsheetBackend({ revision: 1 })
  const worker = await createWorkerBackend()
  await seedBackend(staticBackend, seeds)
  await seedBackend(worker, seeds)

  const staticAck = await staticBackend.pasteRange!(request)
  const workerAck = await worker.pasteRange!(request)
  expect(workerAck.kind).toBe('paste-range')
  expect(workerAck.sheetId).toBe(staticAck.sheetId)
  expect(workerAck.requestId).toBe(staticAck.requestId)
  expect(workerAck.affectedRange).toEqual(staticAck.affectedRange)

  const staticGrid = await readGrid(staticBackend, OBSERVED)
  const workerGrid = await readGrid(worker, OBSERVED)
  expect(workerGrid).toEqual(staticGrid)
  return { worker }
}

describe('worker pasteRange — parity with the static reference (TS runtime)', () => {
  test('values / op none: numbers, text, verbatim formulas, blank overwrites', async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: '5' },
        { row: 0, col: 1, input: 'hello' },
        { row: 1, col: 0, input: '=A1*2' },
        // (1,1) intentionally blank — a blank source overwrites the target.
        { row: 4, col: 0, input: '999' },
        { row: 5, col: 1, input: 'stale' },
      ],
      pasteRequest(),
    )
    // Formula pastes VERBATIM (no ref translation on Paste Special).
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('5:0')).toEqual({ display: '10', formula: '=A1*2' })
    expect(grid.get('5:1')).toBeUndefined()
    worker.dispose()
  })

  const ops: PasteSpecialOp[] = ['add', 'subtract', 'multiply', 'divide']
  for (const op of ops) {
    test(`values / op ${op}: numeric coercion table matches static`, async () => {
      const { worker } = await expectParity(
        [
          { row: 0, col: 0, input: '6' },
          { row: 0, col: 1, input: '0' },
          { row: 1, col: 0, input: 'text-source' },
          { row: 1, col: 1, input: '#REF!' },
          // Targets: number, number (divide-by-zero source), text, number.
          { row: 4, col: 0, input: '10' },
          { row: 4, col: 1, input: '3' },
          { row: 5, col: 0, input: '42' },
          { row: 5, col: 1, input: '7' },
        ],
        pasteRequest({ op }),
      )
      worker.dispose()
    })
  }

  test('op add against a blank target treats the target as 0', async () => {
    const { worker } = await expectParity(
      [{ row: 0, col: 0, input: '6' }],
      pasteRequest({
        op: 'add',
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 0 },
      }),
    )
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({ display: '6' })
    worker.dispose()
  })

  test('transpose kind writes the source shape rows-for-columns', async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: 'a' },
        { row: 0, col: 1, input: 'b' },
        { row: 1, col: 0, input: 'c' },
        { row: 1, col: 1, input: 'd' },
        { row: 0, col: 2, input: 'e' },
      ],
      pasteRequest({
        pasteKind: 'transpose',
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 0 },
      }),
    )
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({ display: 'a' })
    expect(grid.get('4:1')).toEqual({ display: 'c' })
    expect(grid.get('6:0')).toEqual({ display: 'e' })
    worker.dispose()
  })

  test('values + transpose flag matches static', async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: '1' },
        { row: 1, col: 0, input: '2' },
        { row: 0, col: 1, input: '3' },
      ],
      pasteRequest({ transpose: true }),
    )
    worker.dispose()
  })

  test('skipBlanks leaves the target untouched under blank source cells', async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: 'x' },
        // (0,1), (1,0), (1,1) blank.
        { row: 4, col: 1, input: 'keep-me' },
        { row: 5, col: 0, input: '11' },
      ],
      pasteRequest({ skipBlanks: true }),
    )
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:1')).toEqual({ display: 'keep-me' })
    expect(grid.get('5:0')).toEqual({ display: '11' })
    worker.dispose()
  })
})

describe('worker pasteRange — TS runtime capability subdivision (fail-closed)', () => {
  test('pasteRangeSupportedKinds declares only the value-leg kinds', async () => {
    const worker = await createWorkerBackend()
    expect(worker.pasteRangeSupportedKinds).toEqual(['values', 'transpose'])
    expect(SUPPORTED_PASTE_SPECIAL_KINDS).toEqual(
      expect.arrayContaining(worker.pasteRangeSupportedKinds as PasteSpecialKind[]),
    )
    worker.dispose()
  })

  const formatKinds: PasteSpecialKind[] = ['formats', 'values-and-formats', 'all']
  for (const kind of formatKinds) {
    test(`format-leg kind "${kind}" rejects structurally and writes nothing`, async () => {
      const worker = await createWorkerBackend()
      await seedBackend(worker, [
        { row: 0, col: 0, input: 'src' },
        { row: 4, col: 0, input: 'before' },
      ])
      const beforeGrid = await readGrid(worker, OBSERVED)

      await expect(worker.pasteRange!(pasteRequest({ pasteKind: kind }))).rejects.toMatchObject({
        code: PASTE_RANGE_FORMATS_UNSUPPORTED,
      })
      expect(await readGrid(worker, OBSERVED)).toEqual(beforeGrid)
      worker.dispose()
    })
  }
})

describe('worker pasteRange — exact ACK and undo/redo integration', () => {
  test('ACK echoes kind/sheetId/requestId with numeric revision and clamped range', async () => {
    const worker = await createWorkerBackend()
    await seedBackend(worker, [
      { row: 0, col: 0, input: '1' },
      { row: 1, col: 1, input: '2' },
    ])
    const ack = await worker.pasteRange!(
      pasteRequest({ target: { rowStart: 4, rowEnd: 9, colStart: 0, colEnd: 9 }, requestId: 41 }),
    )
    expect(ack).toEqual({
      kind: 'paste-range',
      sheetId: SHEET,
      requestId: 41,
      revision: expect.any(Number),
      // Target clamps to the 2x2 source shape regardless of selection size.
      affectedRange: { rowStart: 4, rowEnd: 5, colStart: 0, colEnd: 1 },
    })
    worker.dispose()
  })

  test('one paste is ONE transaction: undo restores overwritten and cleared, redo replays', async () => {
    const worker = await createWorkerBackend()
    await seedBackend(worker, [
      { row: 0, col: 0, input: 'new-a' },
      // (0,1) blank — overwrites (4,1) with blank on paste.
      { row: 4, col: 0, input: 'old-a' },
      { row: 4, col: 1, input: 'old-b' },
    ])
    const request = pasteRequest({
      source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 } },
      target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 1 },
    })
    await worker.pasteRange!(request)
    let grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({ display: 'new-a' })
    expect(grid.get('4:1')).toBeUndefined()

    const undoAck = await worker.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'tx-paste',
      requestId: 1,
      revision: 0,
    })
    expect(undoAck.applied).not.toBe(false)
    expect(undoAck.affectedRange).toEqual({ rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 1 })
    grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({ display: 'old-a' })
    expect(grid.get('4:1')).toEqual({ display: 'old-b' })

    const redoAck = await worker.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'tx-paste',
      requestId: 2,
      revision: 0,
    })
    expect(redoAck.applied).not.toBe(false)
    grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({ display: 'new-a' })
    expect(grid.get('4:1')).toBeUndefined()
    worker.dispose()
  })

  test('undo of an arithmetic paste restores the pre-op target values', async () => {
    const worker = await createWorkerBackend()
    await seedBackend(worker, [
      { row: 0, col: 0, input: '5' },
      { row: 4, col: 0, input: '10' },
    ])
    await worker.pasteRange!(
      pasteRequest({
        op: 'add',
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 0 },
      }),
    )
    expect((await readGrid(worker, OBSERVED)).get('4:0')).toEqual({ display: '15' })

    await worker.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'tx-op',
      requestId: 3,
      revision: 0,
    })
    expect((await readGrid(worker, OBSERVED)).get('4:0')).toEqual({ display: '10' })
    worker.dispose()
  })
})
