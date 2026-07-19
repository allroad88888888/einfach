/**
 * @jest-environment node
 *
 * Parity #11 — Paste Special format leg on the WORKER path, REAL WASM
 * engine and REAL `worker-runtime.ts` dispatcher in process (same
 * harness as vnext-worker-undo-wasm.test.ts: wasm-pkg jest-mocked onto
 * itself with the binary pre-loaded through `initSync`, fake `self`
 * installed before the runtime module is imported).
 *
 * The WASM runtime predates the capability handshake (full trust), so
 * the adapter offers every Core-supported kind. Pins:
 *  - `pasteRangeSupportedKinds` = full Core set,
 *  - 'formats' copies the source effective format and leaves values,
 *  - 'values-and-formats' applies both legs (static parity on formats),
 *  - skipBlanks carries the target's own per-cell format through the
 *    rectangle restore,
 *  - undo/redo round-trips a format paste (values AND formats).
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'
import {
  SUPPORTED_PASTE_SPECIAL_KINDS,
  type CellRange,
  type DisplayCell,
  type PasteRangeRequest,
  type SpreadsheetBackend,
  type SpreadsheetCellFormat,
} from '@einfach/spreadsheet-ui-core'

import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

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

async function createWorkerBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createBackendImpl!()
  await backend.ready()
  return backend
}

type Seed = { row: number; col: number; input: string }
type FormatSeed = { range: CellRange; format: SpreadsheetCellFormat }

async function seedBackend(
  backend: SpreadsheetBackend,
  cells: Seed[],
  formats: FormatSeed[] = [],
): Promise<void> {
  if (cells.length > 0) {
    await backend.importCells!({ kind: 'import-cells', sheetId: SHEET, cells })
  }
  for (const entry of formats) {
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET,
      range: entry.range,
      format: entry.format,
    })
  }
}

let projectionRequestId = 1

type GridCell = { display: string; format?: Record<string, unknown> }

/**
 * Cross-backend format comparison: the WASM engine materializes default
 * fields (`align: 'default'`, `italic: false`, general numberFormat)
 * that the static backend keeps sparse. Parity is over SIGNIFICANT
 * format facts, not the serialization shape.
 */
function significantFormat(
  format: SpreadsheetCellFormat | undefined,
): Record<string, unknown> | undefined {
  if (!format) return undefined
  const raw = format as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (raw.bold === true) out.bold = true
  if (raw.italic === true) out.italic = true
  if (raw.underline === true) out.underline = true
  if (typeof raw.bgColor === 'string' && raw.bgColor) out.bgColor = raw.bgColor
  if (typeof raw.fgColor === 'string' && raw.fgColor) out.fgColor = raw.fgColor
  if (typeof raw.align === 'string' && raw.align !== 'default') out.align = raw.align
  const numberFormat = raw.numberFormat as { kind?: string } | undefined
  if (numberFormat?.kind && numberFormat.kind !== 'general') out.numberFormat = numberFormat
  return Object.keys(out).length > 0 ? out : undefined
}

async function readGrid(
  backend: SpreadsheetBackend,
  range: CellRange,
): Promise<Map<string, GridCell>> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    range,
    requestId: projectionRequestId++,
    reason: 'viewport',
  } as never)
  const grid = new Map<string, GridCell>()
  for (const cell of result.cells as DisplayCell[]) {
    const format = significantFormat(cell.format)
    if (cell.displayValue === '' && !cell.formula && !format) continue
    grid.set(`${cell.row}:${cell.col}`, {
      display: cell.displayValue,
      ...(format ? { format } : {}),
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
    pasteKind: 'values-and-formats',
    op: 'none',
    transpose: false,
    skipBlanks: false,
    requestId: 91,
    ...overrides,
  }
}

const OBSERVED: CellRange = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }

async function expectParity(
  seeds: Seed[],
  formats: FormatSeed[],
  request: PasteRangeRequest,
): Promise<{ worker: WorkerWorkbookSpreadsheetBackend }> {
  const staticBackend = createStaticSpreadsheetBackend({ revision: 1 })
  const worker = await createWorkerBackend()
  await seedBackend(staticBackend, seeds, formats)
  await seedBackend(worker, seeds, formats)

  const staticAck = await staticBackend.pasteRange!(request)
  const workerAck = await worker.pasteRange!(request)
  expect(workerAck.kind).toBe('paste-range')
  expect(workerAck.affectedRange).toEqual(staticAck.affectedRange)

  const staticGrid = await readGrid(staticBackend, OBSERVED)
  const workerGrid = await readGrid(worker, OBSERVED)
  expect(workerGrid).toEqual(staticGrid)
  return { worker }
}

describe('worker pasteRange — WASM runtime format leg', () => {
  test('full-trust runtime offers every Core-supported kind', async () => {
    const worker = await createWorkerBackend()
    expect(worker.pasteRangeSupportedKinds).toEqual(SUPPORTED_PASTE_SPECIAL_KINDS)
    worker.dispose()
  })

  test("'formats' copies the source format and leaves target values (parity)", async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: 'styled' },
        { row: 4, col: 0, input: 'kept-value' },
      ],
      [
        {
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { bold: true, bgColor: '#ff0000' },
        },
      ],
      pasteRequest({
        pasteKind: 'formats',
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 0 },
      }),
    )
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')?.display).toBe('kept-value')
    expect(grid.get('4:0')?.format).toMatchObject({ bold: true, bgColor: '#ff0000' })
    worker.dispose()
  })

  test("'values-and-formats' applies both legs; target RANGE layers survive", async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: 'a' },
        { row: 0, col: 1, input: 'b' },
        { row: 4, col: 1, input: 'old' },
      ],
      [
        {
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { italic: true },
        },
        // Pre-existing target format at (4,1) seeded as a RANGE layer.
        // Reference semantics: paste replaces only PER-CELL overrides —
        // a format-less source deletes the override and the target falls
        // back to its own range layer, which therefore survives on both
        // backends.
        {
          range: { rowStart: 4, rowEnd: 4, colStart: 1, colEnd: 1 },
          format: { bold: true },
        },
      ],
      pasteRequest({
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({
      display: 'a',
      format: expect.objectContaining({ italic: true }),
    })
    expect(grid.get('4:1')).toEqual({
      display: 'b',
      format: expect.objectContaining({ bold: true }),
    })
    worker.dispose()
  })

  test('skipBlanks keeps the target per-cell format under a blank source cell', async () => {
    const { worker } = await expectParity(
      [
        { row: 0, col: 0, input: 'x' },
        // (0,1) blank source.
        { row: 4, col: 1, input: 'keep' },
      ],
      [
        {
          range: { rowStart: 4, rowEnd: 4, colStart: 1, colEnd: 1 },
          format: { bold: true },
        },
      ],
      pasteRequest({
        skipBlanks: true,
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )
    const grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:1')).toEqual({
      display: 'keep',
      format: expect.objectContaining({ bold: true }),
    })
    worker.dispose()
  })

  test('undo/redo round-trips a values-and-formats paste (values AND formats)', async () => {
    const worker = await createWorkerBackend()
    await seedBackend(
      worker,
      [
        { row: 0, col: 0, input: 'new' },
        { row: 4, col: 0, input: 'old' },
      ],
      [
        {
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { bold: true },
        },
      ],
    )
    await worker.pasteRange!(
      pasteRequest({
        source: { sheetId: SHEET, range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } },
        target: { rowStart: 4, rowEnd: 4, colStart: 0, colEnd: 0 },
      }),
    )
    let grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({
      display: 'new',
      format: expect.objectContaining({ bold: true }),
    })

    const undoAck = await worker.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'tx-wasm-paste',
      requestId: 1,
      revision: 0,
    })
    expect(undoAck.applied).not.toBe(false)
    grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({ display: 'old' })

    const redoAck = await worker.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'tx-wasm-paste',
      requestId: 2,
      revision: 0,
    })
    expect(redoAck.applied).not.toBe(false)
    grid = await readGrid(worker, OBSERVED)
    expect(grid.get('4:0')).toEqual({
      display: 'new',
      format: expect.objectContaining({ bold: true }),
    })
    worker.dispose()
  })
})
