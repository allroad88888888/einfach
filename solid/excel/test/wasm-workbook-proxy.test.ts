import { describe, expect, it } from '@jest/globals'
import {
  createWorkerWorkbook,
  type CellRefWire,
  type CellSnapshotWire,
  type WorkbookPersistenceRestoreStatsWire,
  type WorkbookPersistenceSnapshotWire,
  type SparseCellWire,
  type ImportCellIssueWire,
  type ImportCellWire,
  type WorkerLike,
} from '../src/wasm-workbook-proxy'

interface FakeWorker extends WorkerLike {
  sent: unknown[]
  _emit(msg: unknown): void
  _listenerCount(): number
  _terminateCount: number
}

function makeFakeWorker(): FakeWorker {
  const listeners = new Set<(e: MessageEvent) => void>()
  const sent: unknown[] = []
  const fake: FakeWorker = {
    sent,
    _terminateCount: 0,
    postMessage(msg) {
      sent.push(msg)
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    terminate() {
      fake._terminateCount += 1
      listeners.clear()
    },
    _emit(msg) {
      const ev = { data: msg } as MessageEvent
      for (const listener of listeners) listener(ev)
    },
    _listenerCount() {
      return listeners.size
    },
  }
  return fake
}

function lastSent(fake: FakeWorker) {
  return fake.sent[fake.sent.length - 1] as { id: number; cmd: string; [key: string]: unknown }
}

function ok(fake: FakeWorker, result: unknown = true) {
  fake._emit({ id: lastSent(fake).id, ok: true, result })
}

function fail(fake: FakeWorker, code: string, message: string) {
  fake._emit({ id: lastSent(fake).id, ok: false, error: { code, message } })
}

describe('wasm-workbook-proxy (Phase 5 Track A)', () => {
  it('sends request/reply commands with workbook sheet metadata', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const promise = workbook.initWorkbook(['Sheet1', 'Sheet2'])
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'initWorkbook',
      sheets: ['Sheet1', 'Sheet2'],
    })

    ok(fake, [
      { idx: 0, name: 'Sheet1' },
      { idx: 1, name: 'Sheet2' },
    ])

    await expect(promise).resolves.toEqual([
      { idx: 0, name: 'Sheet1' },
      { idx: 1, name: 'Sheet2' },
    ])
  })

  it('sends sheet move commands with source and target indexes', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const move = workbook.moveSheet(2, 0)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'moveSheet',
      from: 2,
      to: 0,
    })

    ok(fake, true)
    await expect(move).resolves.toBe(true)
  })

  it('keeps sheet identity in setCell/readCells payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const setPromise = workbook.setCell(1, 'a1', { type: 'number', value: 42 })
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'setCell',
      sheet: 1,
      addr: 'A1',
      value: { type: 'number', value: 42 },
    })
    ok(fake)
    await expect(setPromise).resolves.toBe(true)

    const readPromise = workbook.readCells([
      { sheet: 0, addr: 'a1' },
      { sheet: 1, addr: 'a1' },
    ])
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'readCells',
      cells: [
        { sheet: 0, addr: 'A1' },
        { sheet: 1, addr: 'A1' },
      ],
    })
    ok(fake, [
      snapshot({ sheet: 0, addr: 'A1', display: '1' }),
      snapshot({ sheet: 1, addr: 'A1', display: '42' }),
    ])
    await expect(readPromise).resolves.toEqual([
      snapshot({ sheet: 0, addr: 'A1', display: '1' }),
      snapshot({ sheet: 1, addr: 'A1', display: '42' }),
    ])
  })

  it('returns authoritative setFormula results instead of optimistic true', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const okFormula = workbook.setFormula(0, 'B1', '=A1+1')
    expect(lastSent(fake)).toMatchObject({
      id: 1,
      cmd: 'setFormula',
      sheet: 0,
      addr: 'B1',
      formula: '=A1+1',
    })
    ok(fake, true)
    await expect(okFormula).resolves.toBe(true)

    const badFormula = workbook.setFormula(0, 'C1', '=C1+1')
    ok(fake, false)
    await expect(badFormula).resolves.toBe(false)

    const detailedFormula = workbook.setFormulaDetailed(0, 'D1', '=D1+1')
    expect(lastSent(fake)).toMatchObject({
      id: 3,
      cmd: 'setFormulaDetailed',
      sheet: 0,
      addr: 'D1',
      formula: '=D1+1',
    })
    ok(fake, {
      ok: false,
      code: 'FORMULA_CYCLE',
      message: 'formula would create a cycle',
      display: '#CYCLE!',
    })
    await expect(detailedFormula).resolves.toEqual({
      ok: false,
      code: 'FORMULA_CYCLE',
      message: 'formula would create a cycle',
      display: '#CYCLE!',
    })

    const parseFail = workbook.setFormulaDetailed(0, 'E1', '=garbage((')
    expect(lastSent(fake)).toMatchObject({
      id: 4,
      cmd: 'setFormulaDetailed',
      sheet: 0,
      addr: 'E1',
      formula: '=garbage((',
    })
    ok(fake, {
      ok: false,
      code: 'INVALID_FORMULA',
      message: 'formula could not be parsed or installed',
      display: '#VALUE!',
    })
    await expect(parseFail).resolves.toEqual({
      ok: false,
      code: 'INVALID_FORMULA',
      message: 'formula could not be parsed or installed',
      display: '#VALUE!',
    })
  })

  it('sends chunked import sessions and debug cache probes', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const cells: ImportCellWire[] = [
      { sheet: 1, row: 0, col: 0, kind: 'number', value: 41 },
      { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
    ]

    const begin = workbook.beginImport()
    expect(lastSent(fake)).toEqual({ id: 1, cmd: 'beginImport', sessionId: 1 })
    ok(fake, 1)
    await expect(begin).resolves.toBe(1)

    const chunk = workbook.importChunk(1, cells)
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'importChunk',
      sessionId: 1,
      cells,
    })
    ok(fake, 2)
    await expect(chunk).resolves.toBe(2)

    const commit = workbook.commitImport(1)
    expect(lastSent(fake)).toEqual({ id: 3, cmd: 'commitImport', sessionId: 1 })
    const issues: ImportCellIssueWire[] = [
      {
        sheet: 0,
        row: -1,
        col: 0,
        kind: 'number',
        code: 'INVALID_IMPORT_CELL_COORDINATES',
        message: 'invalid import cell coordinates',
      },
    ]
    ok(fake, {
      accepted: 2,
      formulas: 1,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 0,
      issues,
    })
    await expect(commit).resolves.toEqual({
      accepted: 2,
      formulas: 1,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 0,
      issues,
    })

    const debug = workbook.debugFormulaCacheState(0, 'a1')
    expect(lastSent(fake)).toEqual({
      id: 4,
      cmd: 'debugFormulaCacheState',
      sheet: 0,
      addr: 'A1',
    })
    ok(fake, 'dirty')
    await expect(debug).resolves.toBe('dirty')

    const evalCount = workbook.debugFormulaEvalCount(0)
    expect(lastSent(fake)).toEqual({
      id: 5,
      cmd: 'debugFormulaEvalCount',
      sheet: 0,
    })
    ok(fake, 0)
    await expect(evalCount).resolves.toBe(0)

    const counters = workbook.debugCounters()
    expect(lastSent(fake)).toEqual({ id: 6, cmd: 'debugCounters' })
    ok(fake, {
      sheetCount: 1,
      crossSheetDependents: 0,
      formulaCount: 1,
      formulaEvalCountTotal: 0,
      liveSubscriptionCount: 0,
      workerSubscriptionCount: 0,
      importSessionCount: 0,
      exportSessionCount: 0,
      snapshotSessionCount: 0,
      sheets: [
        {
          idx: 0,
          name: 'Sheet1',
          formulaCount: 1,
          formulaEvalCount: 0,
          liveSubscriptionCount: 0,
        },
      ],
    })
    await expect(counters).resolves.toEqual({
      sheetCount: 1,
      crossSheetDependents: 0,
      formulaCount: 1,
      formulaEvalCountTotal: 0,
      liveSubscriptionCount: 0,
      workerSubscriptionCount: 0,
      importSessionCount: 0,
      exportSessionCount: 0,
      snapshotSessionCount: 0,
      sheets: [
        {
          idx: 0,
          name: 'Sheet1',
          formulaCount: 1,
          formulaEvalCount: 0,
          liveSubscriptionCount: 0,
        },
      ],
    })

    const list = workbook.listNonEmpty()
    expect(lastSent(fake)).toEqual({ id: 7, cmd: 'listNonEmpty' })
    ok(fake, [{ sheet: 0, addr: 'A1' }])
    await expect(list).resolves.toEqual([{ sheet: 0, addr: 'A1' }])

    const sparse = workbook.snapshotSparse()
    expect(lastSent(fake)).toEqual({ id: 8, cmd: 'snapshotSparse' })
    ok(fake, [{ sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' }])
    await expect(sparse).resolves.toEqual([
      { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
    ])

    const range = workbook.readSparseRange({
      sheet: 0,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    })
    expect(lastSent(fake)).toEqual({
      id: 9,
      cmd: 'readSparseRange',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    })
    ok(fake, [snapshot({ sheet: 0, addr: 'A1', display: '42' })])
    await expect(range).resolves.toEqual([snapshot({ sheet: 0, addr: 'A1', display: '42' })])

    const clear = workbook.clearRange({
      sheet: 1,
      startRow: 0,
      startCol: 0,
      endRow: 999_999,
      endCol: 999_999,
    })
    expect(lastSent(fake)).toEqual({
      id: 10,
      cmd: 'clearRange',
      range: { sheet: 1, startRow: 0, startCol: 0, endRow: 999_999, endCol: 999_999 },
    })
    ok(fake, 1)
    await expect(clear).resolves.toBe(1)

    const format = workbook.setFormatRange(
      {
        sheet: 1,
        startRow: 0,
        startCol: 0,
        endRow: 999_999,
        endCol: 999_999,
      },
      { bold: true },
    )
    expect(lastSent(fake)).toEqual({
      id: 11,
      cmd: 'setFormatRange',
      range: { sheet: 1, startRow: 0, startCol: 0, endRow: 999_999, endCol: 999_999 },
      fmt: { bold: true },
    })
    ok(fake, 1)
    await expect(format).resolves.toBe(1)

    const cancel = workbook.cancelImport(99)
    expect(lastSent(fake)).toEqual({ id: 12, cmd: 'cancelImport', sessionId: 99 })
    ok(fake, false)
    await expect(cancel).resolves.toBe(false)
  })

  it('sends direct import session mode when requested', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const begin = workbook.beginImport({ mode: 'direct' })
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'beginImport',
      sessionId: 1,
      mode: 'direct',
    })
    ok(fake, 1)
    await expect(begin).resolves.toBe(1)

    const explicit = workbook.beginImport(12, { atomic: false })
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'beginImport',
      sessionId: 12,
      atomic: false,
    })
    ok(fake, 12)
    await expect(explicit).resolves.toBe(12)
  })

  it('surfaces import limit errors and keeps the request channel usable', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const begin = workbook.beginImport(12)
    expect(lastSent(fake)).toEqual({ id: 1, cmd: 'beginImport', sessionId: 12 })
    ok(fake, 12)
    await expect(begin).resolves.toBe(12)

    const oversizedCells = Array.from({ length: 10_001 }, (_, row) => ({
      sheet: 0,
      row,
      col: 0,
      kind: 'number' as const,
      value: row,
    }))
    const oversizeChunk = workbook.importChunk(12, oversizedCells as ImportCellWire[])
    expect(lastSent(fake)).toMatchObject({
      id: 2,
      cmd: 'importChunk',
      sessionId: 12,
      cells: oversizedCells,
    })
    fail(fake, 'IMPORT_CHUNK_TOO_LARGE', 'import chunk too large: 10001')
    await expect(oversizeChunk).rejects.toMatchObject({
      code: 'IMPORT_CHUNK_TOO_LARGE',
      message: 'import chunk too large: 10001',
    })

    const cancel = workbook.cancelImport(12)
    expect(lastSent(fake)).toMatchObject({ id: 3, cmd: 'cancelImport', sessionId: 12 })
    ok(fake, true)
    await expect(cancel).resolves.toBe(true)
  })

  it('rejects RPC errors with the worker error code attached', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const promise = workbook.renameSheet(9, 'Missing')
    fail(fake, 'INVALID_SHEET', 'invalid sheet index: 9')

    await expect(promise).rejects.toMatchObject({
      code: 'INVALID_SHEET',
      message: 'invalid sheet index: 9',
    })

    const sparse = workbook.snapshotSparse()
    fail(fake, 'WASM_METHOD_UNAVAILABLE', 'WasmWorkbook.snapshot_sparse is not available')
    await expect(sparse).rejects.toMatchObject({
      code: 'WASM_METHOD_UNAVAILABLE',
      message: 'WasmWorkbook.snapshot_sparse is not available',
    })

    const persistenceSnapshot = workbook.snapshotPersistenceV1()
    fail(
      fake,
      'WASM_METHOD_UNAVAILABLE',
      'WasmWorkbook.snapshot_persistence_v1 is not available',
    )
    await expect(persistenceSnapshot).rejects.toMatchObject({
      code: 'WASM_METHOD_UNAVAILABLE',
      message: 'WasmWorkbook.snapshot_persistence_v1 is not available',
    })

    const persistenceRestore = workbook.restorePersistenceV1({
      version: 1,
      sheets: [{ idx: 0, name: 'Sheet1' }],
      cells: [],
      formats: [],
    })
    fail(fake, 'WASM_METHOD_UNAVAILABLE', 'WasmWorkbook.restore_persistence_v1 is not available')
    await expect(persistenceRestore).rejects.toMatchObject({
      code: 'WASM_METHOD_UNAVAILABLE',
      message: 'WasmWorkbook.restore_persistence_v1 is not available',
    })

    const formula = workbook.setFormula(9, 'A1', '=1')
    fail(fake, 'INVALID_SHEET', 'invalid sheet index: 9')
    await expect(formula).rejects.toMatchObject({
      code: 'INVALID_SHEET',
      message: 'invalid sheet index: 9',
    })

    const detailed = workbook.setFormulaDetailed(9, 'A1', '=1')
    fail(fake, 'INVALID_SHEET', 'invalid sheet index: 9')
    await expect(detailed).rejects.toMatchObject({
      code: 'INVALID_SHEET',
      message: 'invalid sheet index: 9',
    })
  })

  it('sends sparse range snapshot/restore commands with expected payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const rangeSnapshot = workbook.snapshotRangeSparse({
      sheet: 0,
      startRow: 5,
      startCol: 6,
      endRow: 10,
      endCol: 11,
    })
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'snapshotRangeSparse',
      range: { sheet: 0, startRow: 5, startCol: 6, endRow: 10, endCol: 11 },
    })
    const snapshotCells: SparseCellWire[] = [
      {
        sheet: 0,
        addr: 'B2',
        row: 1,
        col: 1,
        kind: 'number',
        value: 2,
      },
      {
        sheet: 0,
        addr: 'C3',
        row: 2,
        col: 2,
        kind: 'text',
        value: 'restored',
      },
    ]
    ok(fake, snapshotCells)
    await expect(rangeSnapshot).resolves.toEqual(snapshotCells)

    const restoreCount = workbook.restoreSparse(snapshotCells)
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'restoreSparse',
      cells: snapshotCells,
    })
    ok(fake, 2)
    await expect(restoreCount).resolves.toBe(2)
  })

  it('sends workbook structural edit commands with zero-based indexes', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const insertRows = workbook.insertRows(1, 2, 3)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'insertRows',
      sheet: 1,
      rowIndex: 2,
      count: 3,
    })
    ok(fake, true)
    await expect(insertRows).resolves.toBe(true)

    const deleteRows = workbook.deleteRows(1, 4, 1)
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'deleteRows',
      sheet: 1,
      rowIndex: 4,
      count: 1,
    })
    ok(fake, true)
    await expect(deleteRows).resolves.toBe(true)

    const insertColumns = workbook.insertColumns(0, 5, 2)
    expect(lastSent(fake)).toEqual({
      id: 3,
      cmd: 'insertColumns',
      sheet: 0,
      colIndex: 5,
      count: 2,
    })
    ok(fake, true)
    await expect(insertColumns).resolves.toBe(true)

    const deleteColumns = workbook.deleteColumns(0, 6, 1)
    expect(lastSent(fake)).toEqual({
      id: 4,
      cmd: 'deleteColumns',
      sheet: 0,
      colIndex: 6,
      count: 1,
    })
    ok(fake, true)
    await expect(deleteColumns).resolves.toBe(true)
  })

  it('sends persistence snapshot/restore commands with expected payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const snapshot = workbook.snapshotPersistenceV1()
    expect(lastSent(fake)).toEqual({ id: 1, cmd: 'snapshotPersistenceV1' })
    const snapshotPayload: WorkbookPersistenceSnapshotWire = {
      version: 1,
      sheets: [{ idx: 0, name: 'Sheet1' }],
      cells: [
        {
          sheet: 0,
          addr: 'A1',
          row: 0,
          col: 0,
          kind: 'formula',
          value: '=1+1',
        },
      ],
      formats: [],
      sizes: [],
    }
    ok(fake, snapshotPayload)
    await expect(snapshot).resolves.toEqual(snapshotPayload)

    const restore = workbook.restorePersistenceV1(snapshotPayload)
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'restorePersistenceV1',
      snapshot: snapshotPayload,
    })
    const restoreStats: WorkbookPersistenceRestoreStatsWire = {
      restored_cells: 1,
      restored_formats: 0,
      sheets: 1,
    }
    ok(fake, restoreStats)
    await expect(restore).resolves.toEqual(restoreStats)
  })

  it('sends format range snapshot/restore commands with expected payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const range = { sheet: 0, startRow: 5, startCol: 6, endRow: 10, endCol: 11 }

    const snapshotPromise = workbook.snapshotFormatRange(range)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'snapshotFormatRange',
      range,
    })
    const snapshot = {
      ...range,
      cellFormats: [{ addr: 'G6', format: { italic: true } }],
      rangeFormats: [
        { startRow: 0, startCol: 0, endRow: 1, endCol: 1, format: { bold: true } },
      ],
    }
    ok(fake, snapshot)
    await expect(snapshotPromise).resolves.toEqual(snapshot)

    const restorePromise = workbook.restoreFormatSnapshot(snapshot)
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'restoreFormatSnapshot',
      snapshot,
    })
    ok(fake, 1)
    await expect(restorePromise).resolves.toBe(1)
  })

  it('sends viewport size snapshot and mutation commands with expected payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const range = { sheet: 0, startRow: 2, startCol: 3, endRow: 8, endCol: 9 }

    const snapshotPromise = workbook.snapshotViewportSizes(range)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'snapshotViewportSizes',
      range,
    })
    const snapshot = {
      ...range,
      rowHeights: [{ rowIndex: 4, heightPx: 36 }],
      colWidths: [{ colIndex: 5, widthPx: 128 }],
    }
    ok(fake, snapshot)
    await expect(snapshotPromise).resolves.toEqual(snapshot)

    const rowPromise = workbook.setRowHeight(0, 4, 36)
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'setRowHeight',
      sheet: 0,
      rowIndex: 4,
      heightPx: 36,
    })
    ok(fake, true)
    await expect(rowPromise).resolves.toBe(true)

    const colPromise = workbook.setColumnWidth(0, 5, 128)
    expect(lastSent(fake)).toEqual({
      id: 3,
      cmd: 'setColumnWidth',
      sheet: 0,
      colIndex: 5,
      widthPx: 128,
    })
    ok(fake, true)
    await expect(colPromise).resolves.toBe(true)
  })

  it('sends range TSV export commands with expected payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const exportText = workbook.exportRangeTsv({
      sheet: 0,
      startRow: 1,
      startCol: 2,
      endRow: 3,
      endCol: 4,
    })
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'exportRangeTsv',
      range: { sheet: 0, startRow: 1, startCol: 2, endRow: 3, endCol: 4 },
    })
    ok(fake, '=Sheet2!A1+1')
    await expect(exportText).resolves.toBe('=Sheet2!A1+1')
  })

  it('sends chunked TSV export session commands and aggregates chunks', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const range = {
      sheet: 0,
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 1,
    }

    const beginPromise = workbook.beginExportRangeTsv(range, 2)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'beginExportRangeTsv',
      range,
      rowsPerChunk: 2,
    })
    ok(fake, { sessionId: 7, totalRows: 4, rowsPerChunk: 2 })
    await expect(beginPromise).resolves.toEqual({
      sessionId: 7,
      totalRows: 4,
      rowsPerChunk: 2,
    })

    const next1 = workbook.nextExportRangeTsvChunk(7)
    expect(lastSent(fake)).toEqual({ id: 2, cmd: 'nextExportRangeTsvChunk', sessionId: 7 })
    ok(fake, { sessionId: 7, startRow: 0, endRow: 1, chunk: '1\t2', done: false })
    await expect(next1).resolves.toEqual({
      sessionId: 7,
      startRow: 0,
      endRow: 1,
      chunk: '1\t2',
      done: false,
    })

    const cancel = workbook.cancelExport(7)
    expect(lastSent(fake)).toMatchObject({ id: 3, cmd: 'cancelExport', sessionId: 7 })
    ok(fake, true)
    await expect(cancel).resolves.toBe(true)
  })

  it('aggregates chunked TSV exports with clamped row chunk sizes', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const range = {
      sheet: 0,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    }

    const chunksPromise = workbook.exportRangeTsvChunks(range, 0)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'beginExportRangeTsv',
      range,
      rowsPerChunk: 1,
    })
    ok(fake, { sessionId: 9, totalRows: 1, rowsPerChunk: 1 })
    await Promise.resolve()

    ok(fake, { sessionId: 9, startRow: 0, endRow: 0, chunk: '=Sheet2!A1+1', done: true })

    await expect(chunksPromise).resolves.toEqual(['=Sheet2!A1+1'])
    expect(fake.sent).toEqual([
      { id: 1, cmd: 'beginExportRangeTsv', range, rowsPerChunk: 1 },
      { id: 2, cmd: 'nextExportRangeTsvChunk', sessionId: 9 },
    ])
  })

  it('sends chunked sparse range snapshot session commands and aggregates chunks', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const range = {
      sheet: 0,
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
    }

    const beginPromise = workbook.beginSnapshotRangeSparse(range, 2)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'beginSnapshotRangeSparse',
      range,
      rowsPerChunk: 2,
    })
    ok(fake, { sessionId: 11, totalRows: 3, rowsPerChunk: 2 })
    await expect(beginPromise).resolves.toEqual({
      sessionId: 11,
      totalRows: 3,
      rowsPerChunk: 2,
    })

    const snapshotCell: SparseCellWire = {
      sheet: 0,
      addr: 'A1',
      row: 0,
      col: 0,
      kind: 'number',
      value: 1,
    }
    const nextPromise = workbook.nextSnapshotRangeSparseChunk(11)
    expect(lastSent(fake)).toEqual({ id: 2, cmd: 'nextSnapshotRangeSparseChunk', sessionId: 11 })
    ok(fake, {
      sessionId: 11,
      startRow: 0,
      endRow: 1,
      cells: [snapshotCell],
      done: false,
    })
    await expect(nextPromise).resolves.toEqual({
      sessionId: 11,
      startRow: 0,
      endRow: 1,
      cells: [snapshotCell],
      done: false,
    })

    const cancel = workbook.cancelSnapshot(11)
    expect(lastSent(fake)).toEqual({ id: 3, cmd: 'cancelSnapshot', sessionId: 11 })
    ok(fake, true)
    await expect(cancel).resolves.toBe(true)
  })

  it('aggregates chunked sparse snapshots with clamped row chunk sizes', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const range = {
      sheet: 0,
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 0,
    }
    const snapshotCell: SparseCellWire = {
      sheet: 0,
      addr: 'A1',
      row: 0,
      col: 0,
      kind: 'formula',
      value: '=Sheet2!A1+1',
    }

    const chunksPromise = workbook.snapshotRangeSparseChunks(range, 0)
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'beginSnapshotRangeSparse',
      range,
      rowsPerChunk: 1,
    })
    ok(fake, { sessionId: 12, totalRows: 2, rowsPerChunk: 1 })
    await Promise.resolve()

    ok(fake, {
      sessionId: 12,
      startRow: 0,
      endRow: 0,
      cells: [snapshotCell],
      done: false,
    })
    await Promise.resolve()

    ok(fake, {
      sessionId: 12,
      startRow: 1,
      endRow: 1,
      cells: [],
      done: true,
    })

    await expect(chunksPromise).resolves.toEqual([[snapshotCell], []])
    expect(fake.sent).toEqual([
      { id: 1, cmd: 'beginSnapshotRangeSparse', range, rowsPerChunk: 1 },
      { id: 2, cmd: 'nextSnapshotRangeSparseChunk', sessionId: 12 },
      { id: 3, cmd: 'nextSnapshotRangeSparseChunk', sessionId: 12 },
    ])
  })

  it('dispatches dirty events only to matching sheet+addr subscribers', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const sheet1A1: CellRefWire[][] = []
    const sheet2A1: CellRefWire[][] = []

    const sub1 = workbook.subscribeCells([{ sheet: 0, addr: 'a1' }], (cells) => {
      sheet1A1.push(cells)
    })
    expect(lastSent(fake)).toMatchObject({
      id: 1,
      cmd: 'subscribeCells',
      subId: 1,
      cells: [{ sheet: 0, addr: 'A1' }],
    })
    ok(fake)
    await expect(sub1).resolves.toBe(1)

    const sub2 = workbook.subscribeCells([{ sheet: 1, addr: 'a1' }], (cells) => {
      sheet2A1.push(cells)
    })
    expect(lastSent(fake)).toMatchObject({
      id: 2,
      cmd: 'subscribeCells',
      subId: 2,
      cells: [{ sheet: 1, addr: 'A1' }],
    })
    ok(fake)
    await expect(sub2).resolves.toBe(2)

    fake._emit({ event: 'cellsDirty', cells: [{ sheet: 1, addr: 'A1' }] })

    expect(sheet1A1).toEqual([])
    expect(sheet2A1).toEqual([[{ sheet: 1, addr: 'A1' }]])
  })

  it('forwards hydrated events and normalizes addresses', () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const seen: CellSnapshotWire[][] = []
    workbook.onCellsHydrated((cells) => {
      seen.push(cells)
    })

    fake._emit({
      event: 'cellsHydrated',
      cells: [snapshot({ sheet: 1, addr: 'a1', display: '9' })],
    })

    expect(seen).toEqual([[snapshot({ sheet: 1, addr: 'A1', display: '9' })]])
  })

  it('unsubscribe removes local dispatch and sends an authoritative request', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const calls: CellRefWire[][] = []

    const subIdPromise = workbook.subscribeCells([{ sheet: 0, addr: 'A1' }], (cells) => {
      calls.push(cells)
    })
    ok(fake)
    const subId = await subIdPromise

    const unsubscribe = workbook.unsubscribeCells(subId)
    expect(lastSent(fake)).toMatchObject({
      id: 2,
      cmd: 'unsubscribeCells',
      subId,
    })
    ok(fake)
    await expect(unsubscribe).resolves.toBe(true)

    fake._emit({ event: 'cellsDirty', cells: [{ sheet: 0, addr: 'A1' }] })
    expect(calls).toEqual([])
  })

  it('dispose rejects pending requests and terminates the worker', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const promise = workbook.sheetList()
    expect(fake._listenerCount()).toBe(1)

    workbook.dispose()

    expect(fake._terminateCount).toBe(1)
    expect(fake._listenerCount()).toBe(0)
    await expect(promise).rejects.toThrow('worker workbook disposed')
  })
})

function snapshot(input: {
  sheet: number
  addr: string
  display: string
  type?: CellSnapshotWire['type']
  isError?: boolean
  formula?: string
}): CellSnapshotWire {
  return {
    sheet: input.sheet,
    addr: input.addr.toUpperCase(),
    display: input.display,
    type: input.type ?? 'number',
    isError: input.isError ?? false,
    formula: input.formula ?? '',
  }
}
