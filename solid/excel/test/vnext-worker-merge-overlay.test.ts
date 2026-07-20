/**
 * Parity #04 — merge/unmerge on the WORKER path as an adapter
 * host-overlay (CANONICAL_OWNERSHIP "adapter overlay": contract shape
 * stays backend canonical, facts live in the adapter's main-thread Map;
 * neither engine models merges and the overlay is the sanctioned final
 * form).
 *
 * Two harnesses:
 *
 *  1. The real in-process TS worker runtime (`installWorkerRuntimeTs`
 *     behind a duplex bridge — the undo-ts suite shape) pins the
 *     projection overlay (mergedSpan / mergeAnchor), the exact ACK the
 *     UI-core toolbar strict validator requires, unmerge, undo/redo
 *     round trips through the host-orchestrated transaction log,
 *     UI-core history integration, the filter × merge composition rule
 *     (merge metadata is dropped while filter/sort is active — static
 *     backend parity), and the D-4 sheet-id-reuse hygiene line.
 *
 *  2. A full-trust client double (no `describeCapabilities` → legacy
 *     full trust, so the structural ports are exposed) pins the W3
 *     structural remap: insert/delete rows/columns shift, shrink, or
 *     remove overlay ranges with Excel semantics and undo restores the
 *     pre-shift merge set from the record's side payload.
 */

import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  historyStackAtom,
  pushHistoryAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  type CellRange,
  type DisplayCell,
} from '@einfach/spreadsheet-ui-core'

import { installWorkerRuntimeTs, type WorkerContext } from '../src-vnext/adapter/worker-runtime-ts'
import { createWorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type {
  FormatRangeSnapshot,
  SparseRangeWire,
  WorkerWorkbookClient,
} from '../src-vnext/adapter/worker-protocol'

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

async function createTsBackend(
  sheets: Array<{ id: string; name: string }> = [{ id: SHEET, name: 'Sheet1' }],
): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: () => createInProcessTsWorker(),
    sheets,
  })
  await backend.ready()
  return backend
}

let projectionRequestId = 1

async function readCells(
  backend: WorkerWorkbookSpreadsheetBackend,
  range: CellRange,
  sheetId = SHEET,
): Promise<DisplayCell[]> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId,
    range,
    requestId: projectionRequestId++,
    reason: 'viewport',
  })
  return result.cells
}

const WINDOW: CellRange = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 }

function cellAt(cells: DisplayCell[], row: number, col: number): DisplayCell | undefined {
  return cells.find((cell) => cell.row === row && cell.col === col)
}

function mergeMetadata(cells: DisplayCell[]): DisplayCell[] {
  return cells.filter((cell) => cell.mergedSpan || cell.mergeAnchor)
}

async function setInput(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
  input: string,
) {
  return backend.setCellInput({ kind: 'set-cell-input', sheetId: SHEET, row, col, input })
}

/** B2:C3 in zero-based coordinates. */
const B2_C3: CellRange = { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 }

let txCounter = 0
function undoRequest(transactionId: string) {
  txCounter += 1
  return {
    kind: 'undo-transaction' as const,
    transactionId,
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

describe('worker adapter merge overlay — real in-process TS runtime', () => {
  test('merge projects mergedSpan / mergeAnchor onto the window; exact ACK shape', async () => {
    const backend = await createTsBackend()
    await setInput(backend, 1, 1, 'title')

    const ack = await backend.mergeRange!({
      kind: 'merge-range',
      sheetId: SHEET,
      requestId: 71,
      range: B2_C3,
    })
    // Exact ACK chain: the UI-core toolbar strict validator requires
    // kind + requestId + affectedRange echo + a projection revision to
    // walk local-ack → refresh → ready.
    expect(ack).toEqual({
      kind: 'merge-range',
      sheetId: SHEET,
      requestId: 71,
      revision: expect.any(Number),
      affectedRange: { ...B2_C3 },
    })

    const cells = await readCells(backend, WINDOW)
    const anchor = cellAt(cells, 1, 1)
    expect(anchor?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    expect(anchor?.mergeAnchor).toBeUndefined()
    expect(anchor?.displayValue).toBe('title')
    // Covered coordinates materialize (blank where no cell existed) and
    // point back at the anchor.
    for (const [row, col] of [
      [1, 2],
      [2, 1],
      [2, 2],
    ] as const) {
      const covered = cellAt(cells, row, col)
      expect(covered?.mergeAnchor).toEqual({ row: 1, col: 1 })
      expect(covered?.mergedSpan).toBeUndefined()
    }
    backend.dispose()
  })

  test('intersecting merge replaces the old one; unmerge clears; 1x1 adds nothing', async () => {
    const backend = await createTsBackend()
    await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })

    // C3:D4 intersects B2:C3 → the old merge is dropped, the new added.
    await backend.mergeRange!({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 2, rowEnd: 3, colStart: 2, colEnd: 3 },
    })
    let cells = await readCells(backend, WINDOW)
    expect(cellAt(cells, 1, 1)?.mergedSpan).toBeUndefined()
    expect(cellAt(cells, 2, 2)?.mergedSpan).toEqual({ rows: 2, cols: 2 })

    // A 1x1 "merge" removes intersecting merges but never records one.
    await backend.mergeRange!({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 },
    })
    cells = await readCells(backend, WINDOW)
    expect(mergeMetadata(cells)).toEqual([])

    // Fresh merge, then unmerge through an intersecting range.
    await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })
    const unmergeAck = await backend.unmergeRange!({
      kind: 'unmerge-range',
      sheetId: SHEET,
      requestId: 72,
      range: { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 },
    })
    expect(unmergeAck).toEqual({
      kind: 'unmerge-range',
      sheetId: SHEET,
      requestId: 72,
      revision: expect.any(Number),
      affectedRange: { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 },
    })
    cells = await readCells(backend, WINDOW)
    expect(mergeMetadata(cells)).toEqual([])
    backend.dispose()
  })

  test('merge and unmerge round-trip through undoTransaction / redoTransaction', async () => {
    const backend = await createTsBackend()
    await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })

    const undoAck = await backend.undoTransaction!(undoRequest('tx-merge'))
    expect(undoAck.applied).not.toBe(false)
    expect(undoAck.affectedRange).toEqual({ ...B2_C3 })
    expect(mergeMetadata(await readCells(backend, WINDOW))).toEqual([])

    const redoAck = await backend.redoTransaction!(redoRequest('tx-merge'))
    expect(redoAck.applied).not.toBe(false)
    expect(redoAck.revision).not.toBe(undoAck.revision)
    let cells = await readCells(backend, WINDOW)
    expect(cellAt(cells, 1, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })

    // Unmerge, then undo restores the merge from the before-image.
    await backend.unmergeRange!({ kind: 'unmerge-range', sheetId: SHEET, range: B2_C3 })
    expect(mergeMetadata(await readCells(backend, WINDOW))).toEqual([])
    await backend.undoTransaction!(undoRequest('tx-unmerge'))
    cells = await readCells(backend, WINDOW)
    expect(cellAt(cells, 1, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    await backend.redoTransaction!(redoRequest('tx-unmerge'))
    expect(mergeMetadata(await readCells(backend, WINDOW))).toEqual([])
    backend.dispose()
  })

  test('UI-core history: range.merge entries undo/redo through the backend port', async () => {
    const backend = await createTsBackend()
    const store = createStore()

    const ack = await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })
    expect(
      store.setter(pushHistoryAtom, {
        transactionId: 'ui-tx-merge',
        kind: 'range.merge',
        sheetId: SHEET,
        projectionRevision: ack.revision as number,
        affectedRange: { ...B2_C3 },
      }),
    ).toBe(true)

    const undoOutcome = await store.setter(runUndoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(undoOutcome).toBe('completed')
    expect(mergeMetadata(await readCells(backend, WINDOW))).toEqual([])
    expect(store.getter(historyStackAtom).cursor).toBe(0)

    const redoOutcome = await store.setter(runRedoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(redoOutcome).toBe('completed')
    const cells = await readCells(backend, WINDOW)
    expect(cellAt(cells, 1, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    backend.dispose()
  })

  test('filter active drops merge metadata from the projection; clearing restores it', async () => {
    const backend = await createTsBackend()
    // Header + data column the filter predicates on.
    await setInput(backend, 0, 0, 'H')
    await setInput(backend, 1, 0, 'keep')
    await setInput(backend, 2, 0, 'drop')
    await setInput(backend, 3, 0, 'keep')
    await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })

    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'equals', colIndex: 0, value: 'keep' }],
    })
    const filtered = await readCells(backend, WINDOW)
    // The permuted display rows really apply (source row 3 renders at
    // display row 2) and NO cell carries merge metadata — merge
    // coordinates are source facts, the filtered row space is permuted,
    // so the overlay is disabled exactly like the static backend.
    expect(cellAt(filtered, 2, 0)?.displayValue).toBe('keep')
    expect(mergeMetadata(filtered)).toEqual([])

    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [],
    })
    const restored = await readCells(backend, WINDOW)
    expect(cellAt(restored, 1, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    backend.dispose()
  })

  test('deleteSheet drops the overlay; a reused sheet id starts clean (audit D-4)', async () => {
    const backend = await createTsBackend([
      { id: 'sheet-1', name: 'Sheet1' },
      { id: 'sheet-2', name: 'Sheet2' },
    ])
    await backend.mergeRange!({ kind: 'merge-range', sheetId: 'sheet-2', range: B2_C3 })
    expect(mergeMetadata(await readCells(backend, WINDOW, 'sheet-2')).length).toBeGreaterThan(0)

    await backend.deleteSheet!({ kind: 'delete-sheet', sheetId: 'sheet-2' })
    // The next added sheet re-issues the positional id 'sheet-2'; it
    // must not inherit the dead sheet's merges.
    await backend.addSheet!({ kind: 'add-sheet', name: 'Fresh' })
    expect(backend.sheets().map((sheet) => sheet.id)).toContain('sheet-2')
    expect(mergeMetadata(await readCells(backend, WINDOW, 'sheet-2'))).toEqual([])
    backend.dispose()
  })
})

/**
 * Minimal full-trust client double: no `describeCapabilities` → the
 * adapter keeps the legacy full-trust contract (the WASM shape), so the
 * structural ports are exposed and the merge overlay remap is
 * observable without a real engine. Every touched method answers the
 * honest empty/accepted shape.
 */
function createFullTrustClientDouble(): WorkerWorkbookClient {
  const emptySnapshot = (range: SparseRangeWire): FormatRangeSnapshot => ({
    sheet: range.sheet,
    startRow: range.startRow,
    startCol: range.startCol,
    endRow: range.endRow,
    endCol: range.endCol,
    cellFormats: [],
    rangeFormats: [],
  })
  const double = {
    async initWorkbook(sheets?: string[]) {
      return (sheets ?? ['Sheet1']).map((name, idx) => ({ idx, name }))
    },
    onCellsDirty() {
      return () => {}
    },
    async listNonEmpty() {
      return []
    },
    async snapshotRangeSparse() {
      return []
    },
    async readSparseRange() {
      return []
    },
    async snapshotFormatRange(range: SparseRangeWire) {
      return emptySnapshot(range)
    },
    async clearRange() {
      return 0
    },
    async restoreSparse() {
      return 0
    },
    async insertRows() {
      return true
    },
    async deleteRows() {
      return true
    },
    async insertColumns() {
      return true
    },
    async deleteColumns() {
      return true
    },
    dispose() {},
  }
  return double as unknown as WorkerWorkbookClient
}

async function createStructuralBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createWorkerWorkbookSpreadsheetBackend({
    client: createFullTrustClientDouble(),
    sheets: [{ id: SHEET, name: 'Sheet1' }],
  })
  await backend.ready()
  return backend
}

describe('worker adapter merge overlay — W3 structural remap (full-trust client)', () => {
  test('insertRows shifts the merge whole; undo restores it; redo re-shifts', async () => {
    const backend = await createStructuralBackend()
    await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })

    const ack = await backend.insertRows!({
      kind: 'insert-rows',
      sheetId: SHEET,
      rowIndex: 0,
      count: 2,
    })
    expect(ack.structuralShift).toEqual({ axis: 'row', kind: 'insert', index: 0, count: 2 })
    let cells = await readCells(backend, { rowStart: 0, rowEnd: 7, colStart: 0, colEnd: 5 })
    expect(cellAt(cells, 1, 1)?.mergedSpan).toBeUndefined()
    expect(cellAt(cells, 3, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    expect(cellAt(cells, 4, 2)?.mergeAnchor).toEqual({ row: 3, col: 1 })

    // Undo the structural record: the engine images replay (no-ops on
    // the double) AND the merge side payload restores the pre-shift set.
    await backend.undoTransaction!(undoRequest('tx-insert'))
    cells = await readCells(backend, { rowStart: 0, rowEnd: 7, colStart: 0, colEnd: 5 })
    expect(cellAt(cells, 1, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    expect(cellAt(cells, 3, 1)?.mergedSpan).toBeUndefined()

    await backend.redoTransaction!(redoRequest('tx-insert'))
    cells = await readCells(backend, { rowStart: 0, rowEnd: 7, colStart: 0, colEnd: 5 })
    expect(cellAt(cells, 3, 1)?.mergedSpan).toEqual({ rows: 2, cols: 2 })
    backend.dispose()
  })

  test('deleteColumns shrinks an overlapping merge; a covering delete removes it', async () => {
    const backend = await createStructuralBackend()
    await backend.mergeRange!({ kind: 'merge-range', sheetId: SHEET, range: B2_C3 })

    // Deleting column B (index 1) shrinks B2:C3 to the surviving column.
    await backend.deleteColumns!({ kind: 'delete-columns', sheetId: SHEET, colIndex: 1, count: 1 })
    let cells = await readCells(backend, WINDOW)
    expect(cellAt(cells, 1, 1)?.mergedSpan).toEqual({ rows: 2, cols: 1 })
    expect(cellAt(cells, 2, 1)?.mergeAnchor).toEqual({ row: 1, col: 1 })

    // Deleting the rows that cover the whole merge removes it.
    await backend.deleteRows!({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 0, count: 4 })
    cells = await readCells(backend, WINDOW)
    expect(mergeMetadata(cells)).toEqual([])
    backend.dispose()
  })

  test('a merge shrunk to a single cell stops being a merge (Excel 1x1 rule)', async () => {
    const backend = await createStructuralBackend()
    // Horizontal 1x2 merge on row 2: B2:C2.
    await backend.mergeRange!({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 2 },
    })
    await backend.deleteColumns!({ kind: 'delete-columns', sheetId: SHEET, colIndex: 2, count: 1 })
    expect(mergeMetadata(await readCells(backend, WINDOW))).toEqual([])
    backend.dispose()
  })
})
