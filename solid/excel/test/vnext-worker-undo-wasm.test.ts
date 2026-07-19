/**
 * @jest-environment node
 *
 * Host-orchestrated undo/redo on the WORKER path — REAL WASM engine and
 * REAL `worker-runtime.ts` dispatcher, in process (parity #15/#36,
 * CANONICAL_OWNERSHIP §4).
 *
 * Harness: the wasm-pkg module is jest-mocked onto ITSELF with the
 * binary pre-loaded through `initSync` (the async `init()` the runtime
 * awaits becomes a no-op), and a fake `self` worker context is installed
 * BEFORE `worker-runtime.ts` is imported, so its module-scope
 * `installWorkerRuntime()` binds to the in-process duplex bridge. The
 * production `WorkerWorkbookClient` + `createWorkerWorkbookSpreadsheetBackend`
 * stack then runs unchanged.
 *
 * Pins (WASM-only surfaces on top of the shared TS suite):
 *  - format undo/redo through snapshot_format_range /
 *    restore_format_snapshot (replace semantics, no layer residue),
 *  - clearRange target 'all' restoring values AND formats,
 *  - structural undo via the full-sheet non-empty before-image: `#REF!`
 *    sentinel rewrites are irreversible, only the snapshot brings the
 *    original formulas back (design point B),
 *  - threshold degradation: > WORKER_STRUCTURAL_SNAPSHOT_MAX non-empty
 *    cells → structural op executes but answers not-applied on undo,
 *  - the ui-core structure-operation dispatcher end to end: worker
 *    structuralShift ACK → hidden-rows remap + history side payload →
 *    undo replays the backend image AND the recorded view facts.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import {
  createDeleteRowsOperation,
  getHiddenRowsForSheet,
  hideRowsAtom,
  historyStackAtom,
  runStructureOperationAtom,
  runUndoHistoryAtom,
  viewportHiddenAtom,
  type CellRange,
  type DisplayCell,
} from '@einfach/spreadsheet-ui-core'

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

/** Client-side WorkerLike over the duplex bridge. */
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

let createBackendImpl:
  | ((sheets: { id: string; name: string }[]) => WorkerWorkbookSpreadsheetBackend)
  | undefined

beforeAll(async () => {
  // Worker context the wasm dispatcher installs onto — must exist BEFORE
  // worker-runtime.ts is imported (its module scope reads `self`).
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
  createBackendImpl = (sheets) =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => inProcessWorker,
      sheets,
    })
})

async function createBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createBackendImpl!([{ id: SHEET, name: 'Sheet1' }])
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

async function cellAt(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
): Promise<DisplayCell | undefined> {
  const cells = await readCells(backend, {
    rowStart: row,
    rowEnd: row,
    colStart: col,
    colEnd: col,
  })
  return cells.find((cell) => cell.row === row && cell.col === col)
}

async function displayAt(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
): Promise<string> {
  return (await cellAt(backend, row, col))?.displayValue ?? ''
}

async function setInput(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
  input: string,
) {
  return backend.setCellInput({ kind: 'set-cell-input', sheetId: SHEET, row, col, input })
}

let txCounter = 0
function undoRequest(transactionId?: string) {
  txCounter += 1
  return {
    kind: 'undo-transaction' as const,
    transactionId: transactionId ?? `wasm-tx-${txCounter}`,
    requestId: txCounter,
    revision: 0,
  }
}

function redoRequest(transactionId: string) {
  txCounter += 1
  return {
    kind: 'redo-transaction' as const,
    transactionId,
    requestId: txCounter,
    revision: 0,
  }
}

describe('worker adapter host-orchestrated undo — real WASM engine + real dispatcher', () => {
  test('value and formula edits round-trip through undo/redo', async () => {
    const backend = await createBackend()
    await setInput(backend, 0, 0, '2')
    await setInput(backend, 0, 1, '=A1*3')
    expect(await displayAt(backend, 0, 1)).toBe('6')

    await setInput(backend, 0, 1, '=A1-1')
    expect(await displayAt(backend, 0, 1)).toBe('1')

    await backend.undoTransaction!(undoRequest('wasm-formula'))
    expect(await displayAt(backend, 0, 1)).toBe('6')
    expect((await cellAt(backend, 0, 1))?.formula).toBe('=A1*3')

    await backend.redoTransaction!(redoRequest('wasm-formula'))
    expect(await displayAt(backend, 0, 1)).toBe('1')
    backend.dispose()
  })

  test('format undo/redo restores the exact before/after formats', async () => {
    const backend = await createBackend()
    await setInput(backend, 0, 0, 'x')
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      format: { bold: true },
    })
    expect((await cellAt(backend, 0, 0))?.format?.bold).toBe(true)

    await backend.undoTransaction!(undoRequest('wasm-format'))
    expect((await cellAt(backend, 0, 0))?.format?.bold).toBeUndefined()

    await backend.redoTransaction!(redoRequest('wasm-format'))
    expect((await cellAt(backend, 0, 0))?.format?.bold).toBe(true)
    backend.dispose()
  })

  test("clearRange 'all' undo restores values AND formats", async () => {
    const backend = await createBackend()
    await setInput(backend, 0, 0, '11')
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })
    await backend.clearRange!({
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      target: 'all',
    })
    const cleared = await cellAt(backend, 0, 0)
    expect(cleared?.displayValue ?? '').toBe('')
    expect(cleared?.format?.bold).toBeUndefined()

    await backend.undoTransaction!(undoRequest('wasm-clear-all'))
    const restored = await cellAt(backend, 0, 0)
    expect(restored?.displayValue).toBe('11')
    expect(restored?.format?.bold).toBe(true)

    // Redo of the clear must leave neither value nor format residue.
    await backend.redoTransaction!(redoRequest('wasm-clear-all'))
    const recleared = await cellAt(backend, 0, 0)
    expect(recleared?.displayValue ?? '').toBe('')
    expect(recleared?.format?.bold).toBeUndefined()
    backend.dispose()
  })

  test('structural undo restores #REF!-rewritten formulas from the full-sheet image', async () => {
    const backend = await createBackend()
    await setInput(backend, 0, 0, '1')
    await setInput(backend, 1, 0, '2')
    await setInput(backend, 2, 0, '3')
    await setInput(backend, 4, 0, '=A2+10')
    expect(await displayAt(backend, 4, 0)).toBe('12')

    // Delete the row A2 lives in: the reference cannot survive; shift.rs
    // rewrites it to the irreversible #REF! sentinel.
    await backend.deleteRows!({
      kind: 'delete-rows',
      sheetId: SHEET,
      rowIndex: 1,
      count: 1,
    })
    const afterDelete = await cellAt(backend, 3, 0)
    expect(afterDelete?.displayValue).toContain('#REF!')

    const undoAck = await backend.undoTransaction!(undoRequest('wasm-structural'))
    expect(undoAck.applied).not.toBe(false)
    expect(await displayAt(backend, 0, 0)).toBe('1')
    expect(await displayAt(backend, 1, 0)).toBe('2')
    expect(await displayAt(backend, 2, 0)).toBe('3')
    expect(await displayAt(backend, 4, 0)).toBe('12')
    expect((await cellAt(backend, 4, 0))?.formula).toBe('=A2+10')

    const redoAck = await backend.redoTransaction!(redoRequest('wasm-structural'))
    expect(redoAck.applied).not.toBe(false)
    expect((await cellAt(backend, 3, 0))?.displayValue).toContain('#REF!')
    backend.dispose()
  })

  test('structural op over the snapshot threshold degrades to not-undoable', async () => {
    const backend = await createBackend()
    const cells: { row: number; col: number; input: string }[] = []
    // 2001 non-empty cells — one over WORKER_STRUCTURAL_SNAPSHOT_MAX.
    for (let index = 0; index < 2001; index += 1) {
      cells.push({ row: Math.floor(index / 10), col: index % 10, input: String(index) })
    }
    await backend.importCells!({
      kind: 'import-cells',
      sheetId: SHEET,
      cells,
      range: { rowStart: 0, rowEnd: 200, colStart: 0, colEnd: 9 },
    })

    await backend.deleteRows!({
      kind: 'delete-rows',
      sheetId: SHEET,
      rowIndex: 0,
      count: 1,
    })
    // The mutation executed (row 0 gone: former row 1 values shifted up).
    expect(await displayAt(backend, 0, 0)).toBe('10')

    const ack = await backend.undoTransaction!(undoRequest('wasm-over-threshold'))
    expect(ack.applied).toBe(false)
    expect(ack.notAppliedReason).toContain('2001')
    expect(ack.notAppliedReason).toContain('not undoable')
    backend.dispose()
  })

  test('structure dispatcher e2e: structuralShift ACK, hidden side payload, undo', async () => {
    const backend = await createBackend()
    const store: Store = createStore()

    await setInput(backend, 0, 0, 'head')
    await setInput(backend, 1, 0, 'gone')
    await setInput(backend, 2, 0, 'tail')

    // Hidden rows are UI-core canonical; row 3 is hidden before the
    // structural delete and must remap to 2 when row 1 disappears.
    store.setter(hideRowsAtom, { sheetId: SHEET, indices: [3] })
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([3])
    const entriesBefore = store.getter(historyStackAtom).entries.length

    const outcome = await store.setter(runStructureOperationAtom, {
      intent: createDeleteRowsOperation({ sheetId: SHEET, rowIndex: 1, count: 1 }),
      source: backend,
      refreshProjection: async () => {},
    })
    expect(outcome).toBe('completed')
    expect(await displayAt(backend, 1, 0)).toBe('tail')
    // structuralShift ACK remapped the hidden set.
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([2])

    const stack = store.getter(historyStackAtom)
    expect(stack.entries.length).toBe(entriesBefore + 1)
    const entry = stack.entries[stack.entries.length - 1]
    expect(entry.kind).toBe('row.delete')
    expect(entry.localSidePayloads?.some((payload) => payload.applyKey === 'viewport.hidden')).toBe(
      true,
    )

    const undoOutcome = await store.setter(runUndoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(undoOutcome).toBe('completed')
    expect(await displayAt(backend, 1, 0)).toBe('gone')
    expect(await displayAt(backend, 2, 0)).toBe('tail')
    // Side payload replayed the exact recorded before-fact.
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([3])
    backend.dispose()
  })
})
