import { describe, expect, it } from '@jest/globals'
import {
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import type {
  CellFormatJSON,
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  FormatRangeSnapshot,
  BeginImportOptionsWire,
  ImportCellWire,
  SparseCellWire,
  SparseRangeWire,
  WorkerLike,
  WorkerWorkbookClient,
  WorkbookImportStatsWire,
  WorkbookSheetMeta,
} from '../src-vnext/adapter'
import {
  createWorkerWorkbook,
  createStaticSpreadsheetBackend,
  createWorkerWorkbookSpreadsheetBackend,
  matrixToDisplayCells,
  matrixToVisibleProjectionResult,
  sparseCellsToDisplayCells,
  sparseCellsToRangeProjectionResult,
} from '../src-vnext/adapter'

type FakeWorkerWorkbookClient = WorkerWorkbookClient & {
  calls: {
    initWorkbook: string[][]
    readSparseRange: SparseRangeWire[]
    snapshotRangeSparse: SparseRangeWire[]
    setCell: Array<{ sheet: number; addr: string; value: CellWire }>
    setFormulaDetailed: Array<{ sheet: number; addr: string; formula: string }>
    clearCell: Array<{ sheet: number; addr: string }>
    clearRange: SparseRangeWire[]
    insertRows: Array<{ sheet: number; rowIndex: number; count: number }>
    deleteRows: Array<{ sheet: number; rowIndex: number; count: number }>
    insertColumns: Array<{ sheet: number; colIndex: number; count: number }>
    deleteColumns: Array<{ sheet: number; colIndex: number; count: number }>
    setFormatRange: Array<SparseRangeWire & { fmt: CellFormatJSON | null | undefined }>
    snapshotFormatRange: SparseRangeWire[]
    snapshotViewportSizes: SparseRangeWire[]
    setRowHeight: Array<{ sheet: number; rowIndex: number; heightPx: number }>
    setColumnWidth: Array<{ sheet: number; colIndex: number; widthPx: number }>
    beginImport: number[]
    beginImportOptions: Array<{ sessionId: number; options?: BeginImportOptionsWire }>
    importChunk: Array<{ sessionId: number; cells: ImportCellWire[] }>
    commitImport: number[]
    cancelImport: number[]
    exportRangeTsv: SparseRangeWire[]
    consumeExportRangeTsvChunks: Array<SparseRangeWire & { rowsPerChunk?: number }>
    exportRangeTsvChunks: Array<SparseRangeWire & { rowsPerChunk?: number }>
    snapshotRangeSparseChunks: Array<SparseRangeWire & { rowsPerChunk?: number }>
    addSheet: string[]
    renameSheet: Array<{ sheet: number; name: string }>
    removeSheet: number[]
    moveSheet: Array<{ from: number; to: number }>
  }
  putCell(cell: CellSnapshotWire): void
  emitDirty(cells: CellRefWire[]): void
}

type FakeProtocolWorker = WorkerLike & {
  sent: unknown[]
  emit(msg: unknown): void
}

function createFakeProtocolWorker(): FakeProtocolWorker {
  const listeners = new Set<(e: MessageEvent) => void>()
  return {
    sent: [],
    postMessage(msg) {
      this.sent.push(msg)
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    terminate() {
      listeners.clear()
    },
    emit(msg) {
      const event = { data: msg } as MessageEvent
      for (const listener of listeners) listener(event)
    },
  }
}

function lastProtocolMessage(worker: FakeProtocolWorker) {
  return worker.sent[worker.sent.length - 1] as {
    id: number
    cmd: string
    [key: string]: unknown
  }
}

function resolveProtocolMessage(worker: FakeProtocolWorker, result: unknown) {
  worker.emit({ id: lastProtocolMessage(worker).id, ok: true, result })
}

function toCellAddressForTest(row: number, col: number): string {
  let value = col + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return `${label}${row + 1}`
}

function createFakeWorkerWorkbookClient(): FakeWorkerWorkbookClient {
  const cells = new Map<string, CellSnapshotWire>()
  const rangeFormats: Array<SparseRangeWire & { format: CellFormatJSON }> = []
  const rowHeights = new Map<number, Map<number, number>>()
  const colWidths = new Map<number, Map<number, number>>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
  const hydratedListeners = new Set<(cells: CellSnapshotWire[]) => void>()
  const calls: FakeWorkerWorkbookClient['calls'] = {
    initWorkbook: [],
    readSparseRange: [],
    snapshotRangeSparse: [],
    setCell: [],
    setFormulaDetailed: [],
    clearCell: [],
    clearRange: [],
    insertRows: [],
    deleteRows: [],
    insertColumns: [],
    deleteColumns: [],
    setFormatRange: [],
    snapshotFormatRange: [],
    snapshotViewportSizes: [],
    setRowHeight: [],
    setColumnWidth: [],
    beginImport: [],
    beginImportOptions: [],
    importChunk: [],
    commitImport: [],
    cancelImport: [],
    exportRangeTsv: [],
    consumeExportRangeTsvChunks: [],
    exportRangeTsvChunks: [],
    snapshotRangeSparseChunks: [],
    addSheet: [],
    renameSheet: [],
    removeSheet: [],
    moveSheet: [],
  }
  let metas: WorkbookSheetMeta[] = []
  let nextImportId = 1

  function key(sheet: number, addr: string) {
    return `${sheet}:${addr.toUpperCase()}`
  }

  function parseCellAddress(addr: string): { row: number; col: number } {
    const match = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/)
    if (!match) return { row: -1, col: -1 }

    let col = 0
    for (let index = 0; index < match[1].length; index += 1) {
      col = col * 26 + (match[1].charCodeAt(index) - 64)
    }
    return {
      row: Number(match[2]) - 1,
      col: col - 1,
    }
  }

  function toCellAddress(row: number, col: number): string {
    let value = col + 1
    let label = ''

    while (value > 0) {
      const remainder = (value - 1) % 26
      label = String.fromCharCode(65 + remainder) + label
      value = Math.floor((value - 1) / 26)
    }

    return `${label}${row + 1}`
  }

  function insideRange(cell: CellSnapshotWire, range: SparseRangeWire) {
    const coord = parseCellAddress(cell.addr)
    return (
      cell.sheet === range.sheet &&
      coord.row >= range.startRow &&
      coord.row <= range.endRow &&
      coord.col >= range.startCol &&
      coord.col <= range.endCol
    )
  }

  function rangesIntersect(left: SparseRangeWire, right: SparseRangeWire) {
    return (
      left.sheet === right.sheet &&
      left.startRow <= right.endRow &&
      left.endRow >= right.startRow &&
      left.startCol <= right.endCol &&
      left.endCol >= right.startCol
    )
  }

  function putCell(cell: CellSnapshotWire) {
    cells.set(key(cell.sheet, cell.addr), {
      ...cell,
      addr: cell.addr.toUpperCase(),
    })
  }

  function snapshotToSparseCell(cell: CellSnapshotWire): SparseCellWire | null {
    const coord = parseCellAddress(cell.addr)
    if (coord.row < 0 || coord.col < 0) return null

    if (cell.formula) {
      return {
        sheet: cell.sheet,
        addr: cell.addr.toUpperCase(),
        row: coord.row,
        col: coord.col,
        kind: 'formula',
        value: cell.formula,
      }
    }

    switch (cell.type) {
      case 'number':
        return {
          sheet: cell.sheet,
          addr: cell.addr.toUpperCase(),
          row: coord.row,
          col: coord.col,
          kind: 'number',
          value: Number(cell.display),
        }
      case 'boolean':
        return {
          sheet: cell.sheet,
          addr: cell.addr.toUpperCase(),
          row: coord.row,
          col: coord.col,
          kind: 'boolean',
          value: cell.display === 'TRUE',
        }
      case 'error':
        return {
          sheet: cell.sheet,
          addr: cell.addr.toUpperCase(),
          row: coord.row,
          col: coord.col,
          kind: 'error',
          value: cell.display,
        }
      case 'text':
        return {
          sheet: cell.sheet,
          addr: cell.addr.toUpperCase(),
          row: coord.row,
          col: coord.col,
          kind: 'text',
          value: cell.display,
        }
      default:
        return null
    }
  }

  function shiftCells(
    sheet: number,
    axis: 'row' | 'column',
    index: number,
    count: number,
    direction: 1 | -1,
  ) {
    const next = new Map<string, CellSnapshotWire>()
    const deleteEnd = index + count - 1

    for (const snapshot of cells.values()) {
      const coord = parseCellAddress(snapshot.addr)
      if (snapshot.sheet !== sheet || coord.row < 0 || coord.col < 0) {
        next.set(key(snapshot.sheet, snapshot.addr), snapshot)
        continue
      }

      const current = axis === 'row' ? coord.row : coord.col
      if (direction === -1 && current >= index && current <= deleteEnd) {
        continue
      }

      const shifted =
        current >= (direction === 1 ? index : deleteEnd + 1) ? current + count * direction : current
      const row = axis === 'row' ? shifted : coord.row
      const col = axis === 'column' ? shifted : coord.col
      const nextSnapshot = { ...snapshot, addr: toCellAddress(row, col) }
      next.set(key(nextSnapshot.sheet, nextSnapshot.addr), nextSnapshot)
    }

    cells.clear()
    for (const [cellKey, snapshot] of next) cells.set(cellKey, snapshot)
  }

  function sizeMap(root: Map<number, Map<number, number>>, sheet: number) {
    let sizes = root.get(sheet)
    if (!sizes) {
      sizes = new Map()
      root.set(sheet, sizes)
    }
    return sizes
  }

  function shiftSizeMap(
    sizes: Map<number, number>,
    index: number,
    count: number,
    direction: 1 | -1,
  ) {
    const next = new Map<number, number>()
    const deleteEnd = index + count - 1

    for (const [sizeIndex, size] of sizes) {
      if (direction === -1 && sizeIndex >= index && sizeIndex <= deleteEnd) continue
      const shifted =
        sizeIndex >= (direction === 1 ? index : deleteEnd + 1)
          ? sizeIndex + count * direction
          : sizeIndex
      if (shifted >= 0) next.set(shifted, size)
    }

    sizes.clear()
    for (const [sizeIndex, size] of next) sizes.set(sizeIndex, size)
  }

  function remapSheetIndexAfterMove(idx: number, from: number, to: number): number {
    if (from === to) return idx
    if (idx === from) return to
    if (from < to && idx > from && idx <= to) return idx - 1
    if (to < from && idx >= to && idx < from) return idx + 1
    return idx
  }

  function moveSheetData(from: number, to: number) {
    const [meta] = metas.splice(from, 1)
    metas.splice(to, 0, meta)
    metas = metas.map((item, idx) => ({ ...item, idx }))

    const nextCells = new Map<string, CellSnapshotWire>()
    for (const snapshot of cells.values()) {
      const nextSheet = remapSheetIndexAfterMove(snapshot.sheet, from, to)
      const nextSnapshot = { ...snapshot, sheet: nextSheet }
      nextCells.set(key(nextSnapshot.sheet, nextSnapshot.addr), nextSnapshot)
    }
    cells.clear()
    for (const [cellKey, snapshot] of nextCells) cells.set(cellKey, snapshot)

    for (let index = 0; index < rangeFormats.length; index += 1) {
      const layer = rangeFormats[index]
      rangeFormats[index] = {
        ...layer,
        sheet: remapSheetIndexAfterMove(layer.sheet, from, to),
      }
    }

    for (const root of [rowHeights, colWidths]) {
      const next = new Map<number, Map<number, number>>()
      for (const [sheet, sizes] of root) {
        next.set(remapSheetIndexAfterMove(sheet, from, to), new Map(sizes))
      }
      root.clear()
      for (const [sheet, sizes] of next) root.set(sheet, sizes)
    }
  }

  const client: FakeWorkerWorkbookClient = {
    calls,
    putCell,
    emitDirty(dirtyCells) {
      for (const listener of dirtyListeners) listener(dirtyCells)
    },
    async initWorkbook(sheets = ['Sheet1']) {
      calls.initWorkbook.push([...sheets])
      metas = sheets.map((name, idx) => ({ idx, name }))
      return metas
    },
    async sheetList() {
      return metas
    },
    async addSheet(name) {
      calls.addSheet.push(name)
      const idx = metas.length
      metas = [...metas, { idx, name }]
      return idx
    },
    async renameSheet(sheet, name) {
      calls.renameSheet.push({ sheet, name })
      if (metas.some((meta) => meta.idx !== sheet && meta.name === name)) {
        return false
      }
      metas = metas.map((meta) => (meta.idx === sheet ? { ...meta, name } : meta))
      return true
    },
    async removeSheet(sheet) {
      calls.removeSheet.push(sheet)
      if (metas.length <= 1) {
        return false
      }
      metas = metas.filter((meta) => meta.idx !== sheet).map((meta, idx) => ({ ...meta, idx }))
      return true
    },
    async moveSheet(from, to) {
      calls.moveSheet.push({ from, to })
      if (from < 0 || from >= metas.length || to < 0 || to >= metas.length) {
        return false
      }
      moveSheetData(from, to)
      return true
    },
    async setCell(sheet, addr, value) {
      calls.setCell.push({ sheet, addr: addr.toUpperCase(), value })
      if (value.type === 'null') {
        cells.delete(key(sheet, addr))
      } else {
        putCell({
          sheet,
          addr,
          display:
            value.type === 'boolean' ? (value.value ? 'TRUE' : 'FALSE') : String(value.value),
          type: value.type,
          isError: value.type === 'error',
          formula: '',
        })
      }
      return true
    },
    async setFormula() {
      throw new Error('not used')
    },
    async setFormulaDetailed(sheet, addr, formula) {
      calls.setFormulaDetailed.push({ sheet, addr: addr.toUpperCase(), formula })
      putCell({
        sheet,
        addr,
        display: '',
        type: 'null',
        isError: false,
        formula,
      })
      return { ok: true }
    },
    async clearCell(sheet, addr) {
      calls.clearCell.push({ sheet, addr: addr.toUpperCase() })
      cells.delete(key(sheet, addr))
      return true
    },
    async clearRange(range) {
      calls.clearRange.push({ ...range })
      for (const [cellKey, snapshot] of [...cells.entries()]) {
        if (insideRange(snapshot, range)) cells.delete(cellKey)
      }
      return 1
    },
    async insertRows(sheet, rowIndex, count) {
      calls.insertRows.push({ sheet, rowIndex, count })
      shiftCells(sheet, 'row', rowIndex, count, 1)
      shiftSizeMap(sizeMap(rowHeights, sheet), rowIndex, count, 1)
      return true
    },
    async deleteRows(sheet, rowIndex, count) {
      calls.deleteRows.push({ sheet, rowIndex, count })
      shiftCells(sheet, 'row', rowIndex, count, -1)
      shiftSizeMap(sizeMap(rowHeights, sheet), rowIndex, count, -1)
      return true
    },
    async insertColumns(sheet, colIndex, count) {
      calls.insertColumns.push({ sheet, colIndex, count })
      shiftCells(sheet, 'column', colIndex, count, 1)
      shiftSizeMap(sizeMap(colWidths, sheet), colIndex, count, 1)
      return true
    },
    async deleteColumns(sheet, colIndex, count) {
      calls.deleteColumns.push({ sheet, colIndex, count })
      shiftCells(sheet, 'column', colIndex, count, -1)
      shiftSizeMap(sizeMap(colWidths, sheet), colIndex, count, -1)
      return true
    },
    async setFormatRange(range, fmt) {
      calls.setFormatRange.push({ ...range, fmt })
      rangeFormats.push({
        ...range,
        format: fmt
          ? { ...fmt, numberFormat: fmt.numberFormat ? { ...fmt.numberFormat } : undefined }
          : {},
      })
      return 1
    },
    async snapshotFormatRange(range) {
      calls.snapshotFormatRange.push({ ...range })
      const snapshot: FormatRangeSnapshot = {
        sheet: range.sheet,
        startRow: range.startRow,
        startCol: range.startCol,
        endRow: range.endRow,
        endCol: range.endCol,
        cellFormats: [],
        rangeFormats: rangeFormats
          .filter((layer) => rangesIntersect(layer, range))
          .map((layer) => ({
            startRow: layer.startRow,
            startCol: layer.startCol,
            endRow: layer.endRow,
            endCol: layer.endCol,
            format: {
              ...layer.format,
              numberFormat: layer.format.numberFormat
                ? { ...layer.format.numberFormat }
                : undefined,
            },
          })),
      }
      return snapshot
    },
    async restoreFormatSnapshot() {
      throw new Error('not used')
    },
    async snapshotViewportSizes(range) {
      calls.snapshotViewportSizes.push({ ...range })
      return {
        ...range,
        rowHeights: [...(rowHeights.get(range.sheet) ?? new Map()).entries()]
          .filter(([rowIndex]) => rowIndex >= range.startRow && rowIndex <= range.endRow)
          .map(([rowIndex, heightPx]) => ({ rowIndex, heightPx })),
        colWidths: [...(colWidths.get(range.sheet) ?? new Map()).entries()]
          .filter(([colIndex]) => colIndex >= range.startCol && colIndex <= range.endCol)
          .map(([colIndex, widthPx]) => ({ colIndex, widthPx })),
      }
    },
    async setRowHeight(sheet, rowIndex, heightPx) {
      calls.setRowHeight.push({ sheet, rowIndex, heightPx })
      sizeMap(rowHeights, sheet).set(rowIndex, heightPx)
      return true
    },
    async setColumnWidth(sheet, colIndex, widthPx) {
      calls.setColumnWidth.push({ sheet, colIndex, widthPx })
      sizeMap(colWidths, sheet).set(colIndex, widthPx)
      return true
    },
    async beginImport(sessionIdOrOptions, options) {
      const sessionId =
        typeof sessionIdOrOptions === 'number' ? sessionIdOrOptions : nextImportId++
      const importOptions =
        typeof sessionIdOrOptions === 'number' ? options : sessionIdOrOptions
      calls.beginImport.push(sessionId)
      calls.beginImportOptions.push({ sessionId, options: importOptions })
      return sessionId
    },
    async importChunk(sessionId, importCells) {
      calls.importChunk.push({ sessionId, cells: importCells })
      return importCells.length
    },
    async commitImport(sessionId) {
      calls.commitImport.push(sessionId)
      return {
        accepted: calls.importChunk
          .filter((chunk) => chunk.sessionId === sessionId)
          .reduce((sum, chunk) => sum + chunk.cells.length, 0),
        formulas: calls.importChunk
          .filter((chunk) => chunk.sessionId === sessionId)
          .reduce(
            (sum, chunk) => sum + chunk.cells.filter((cell) => cell.kind === 'formula').length,
            0,
          ),
        rejectedFormulas: 0,
        cleared: calls.importChunk
          .filter((chunk) => chunk.sessionId === sessionId)
          .reduce(
            (sum, chunk) => sum + chunk.cells.filter((cell) => cell.kind === 'null').length,
            0,
          ),
        errors: 0,
      } satisfies WorkbookImportStatsWire
    },
    async cancelImport(sessionId) {
      calls.cancelImport.push(sessionId)
      return true
    },
    async readCells() {
      throw new Error('not used')
    },
    async listNonEmpty() {
      throw new Error('not used')
    },
    async snapshotSparse() {
      throw new Error('not used')
    },
    async snapshotRangeSparse(range) {
      calls.snapshotRangeSparse.push({ ...range })
      return [...cells.values()]
        .filter((cell) => insideRange(cell, range))
        .map(snapshotToSparseCell)
        .filter((cell): cell is SparseCellWire => cell !== null)
    },
    async beginSnapshotRangeSparse(range, rowsPerChunk = 2048) {
      calls.snapshotRangeSparseChunks.push({ ...range, rowsPerChunk })
      return { sessionId: 1, totalRows: range.endRow - range.startRow + 1, rowsPerChunk }
    },
    async nextSnapshotRangeSparseChunk() {
      throw new Error('not used')
    },
    async cancelSnapshot() {
      throw new Error('not used')
    },
    async snapshotRangeSparseChunks(range, rowsPerChunk = 2048) {
      calls.snapshotRangeSparseChunks.push({ ...range, rowsPerChunk })
      return [await this.snapshotRangeSparse(range)]
    },
    async snapshotPersistenceV1() {
      throw new Error('not used')
    },
    async restorePersistenceV1() {
      throw new Error('not used')
    },
    async exportRangeTsv(range) {
      calls.exportRangeTsv.push({ ...range })
      return 'fallback'
    },
    async beginExportRangeTsv(range, rowsPerChunk = 2048) {
      calls.exportRangeTsvChunks.push({ ...range, rowsPerChunk })
      return { sessionId: 1, totalRows: 1, rowsPerChunk }
    },
    async nextExportRangeTsvChunk() {
      throw new Error('not used')
    },
    async cancelExport() {
      throw new Error('not used')
    },
    async consumeExportRangeTsvChunks(range, onChunk, rowsPerChunk = 2048) {
      calls.consumeExportRangeTsvChunks.push({ ...range, rowsPerChunk })
      await onChunk({
        sessionId: 1,
        startRow: range.startRow,
        endRow: range.startRow,
        chunk: 'chunk-1',
        done: false,
      })
      await onChunk({
        sessionId: 1,
        startRow: range.startRow + 1,
        endRow: range.startRow + 1,
        chunk: 'chunk-2',
        done: true,
      })
    },
    async exportRangeTsvChunks(range, rowsPerChunk = 2048) {
      calls.exportRangeTsvChunks.push({ ...range, rowsPerChunk })
      return ['chunk-1', 'chunk-2']
    },
    async restoreSparse() {
      throw new Error('not used')
    },
    async readSparseRange(range) {
      calls.readSparseRange.push({ ...range })
      return [...cells.values()].filter((cell) => insideRange(cell, range))
    },
    async debugFormulaCacheState() {
      throw new Error('not used')
    },
    async debugFormulaEvalCount() {
      throw new Error('not used')
    },
    async debugCounters() {
      throw new Error('not used')
    },
    async subscribeCells() {
      throw new Error('not used')
    },
    async unsubscribeCells() {
      throw new Error('not used')
    },
    onCellsDirty(callback) {
      dirtyListeners.add(callback)
      return () => dirtyListeners.delete(callback)
    },
    onCellsHydrated(callback) {
      hydratedListeners.add(callback)
      return () => hydratedListeners.delete(callback)
    },
    async registerCustomFormula() {
      return true
    },
    async unregisterCustomFormula() {
      return true
    },
    async defineName() {
      return true
    },
    async undefineName() {
      return true
    },
    dispose() {
      dirtyListeners.clear()
      hydratedListeners.clear()
    },
  }

  return client
}

describe('vnext adapter', () => {
  it('consumes worker protocol TSV chunks without returning an aggregate array', async () => {
    const worker = createFakeProtocolWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => worker })
    const range = { sheet: 0, startRow: 0, startCol: 0, endRow: 2, endCol: 1 }
    const chunks: string[] = []

    const consumed = workbook.consumeExportRangeTsvChunks!(
      range,
      (chunk) => {
        chunks.push(chunk.chunk)
      },
      0,
    )

    expect(lastProtocolMessage(worker)).toEqual({
      id: 1,
      cmd: 'beginExportRangeTsv',
      range,
      rowsPerChunk: 1,
    })
    resolveProtocolMessage(worker, { sessionId: 7, totalRows: 3, rowsPerChunk: 1 })
    await Promise.resolve()

    expect(lastProtocolMessage(worker)).toEqual({
      id: 2,
      cmd: 'nextExportRangeTsvChunk',
      sessionId: 7,
    })
    resolveProtocolMessage(worker, {
      sessionId: 7,
      startRow: 0,
      endRow: 0,
      chunk: 'A\tB',
      done: false,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(lastProtocolMessage(worker)).toEqual({
      id: 3,
      cmd: 'nextExportRangeTsvChunk',
      sessionId: 7,
    })
    resolveProtocolMessage(worker, {
      sessionId: 7,
      startRow: 1,
      endRow: 2,
      chunk: 'C\tD\nE\tF',
      done: true,
    })

    await expect(consumed).resolves.toBeUndefined()
    expect(chunks).toEqual(['A\tB', 'C\tD\nE\tF'])
    expect(worker.sent).toEqual([
      { id: 1, cmd: 'beginExportRangeTsv', range, rowsPerChunk: 1 },
      { id: 2, cmd: 'nextExportRangeTsvChunk', sessionId: 7 },
      { id: 3, cmd: 'nextExportRangeTsvChunk', sessionId: 7 },
    ])

    workbook.dispose()
  })

  it('converts matrix seeds into bounded visible-window results', () => {
    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 7,
      window: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    const result = matrixToVisibleProjectionResult(
      [
        ['A1', 'B1'],
        ['A2', 'B2'],
        ['A3', 'B3'],
      ],
      request,
      7,
    )

    expect(result).toEqual({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 7,
      window: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      cells: [
        { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
        { row: 0, col: 1, displayValue: 'B1', valueKind: 'string' },
        { row: 1, col: 0, displayValue: 'A2', valueKind: 'string' },
        { row: 1, col: 1, displayValue: 'B2', valueKind: 'string' },
      ],
    })
  })

  it('converts sparse cells into bounded range results', () => {
    const request = createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 2,
      revision: 8,
      reason: 'selection',
      range: { rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    const result = sparseCellsToRangeProjectionResult(
      [
        { row: 0, col: 0, displayValue: 'outside-top' },
        { row: 1, col: 0, displayValue: 'in-range-a' },
        { row: 2, col: 1, displayValue: 'in-range-b' },
        { row: 3, col: 1, displayValue: 'outside-bottom' },
      ],
      request,
      8,
    )

    expect(result.cells).toEqual([
      { row: 1, col: 0, displayValue: 'in-range-a' },
      { row: 2, col: 1, displayValue: 'in-range-b' },
    ])
    expect(result.range).toEqual(request.range)
    expect(result.requestId).toBe(2)
    expect(result.revision).toBe(8)
  })

  it('preserves projected validation and conditional format metadata in static reads', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 2,
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'late',
          valueKind: 'string',
          conditionalFormat: { bgColor: '#fde68a', bold: true },
          validation: {
            code: 'validation.regex_mismatch',
            severity: 'error',
            message: 'Value does not match pattern',
          },
        },
      ],
    })

    const result = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 18,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(result.cells).toEqual([
      {
        row: 0,
        col: 0,
        displayValue: 'late',
        valueKind: 'string',
        conditionalFormat: { bgColor: '#fde68a', bold: true },
        validation: {
          code: 'validation.regex_mismatch',
          severity: 'error',
          message: 'Value does not match pattern',
        },
      },
    ])
  })

  it('persists validation rule mutations in the static backend projection', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [['Region'], ['North']],
    })
    expect(backend.setValidationRule).toBeDefined()
    expect(backend.clearValidationRule).toBeDefined()

    const range = { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 }
    await backend.setValidationRule?.({
      kind: 'set-validation-rule',
      sheetId: 'sheet-1',
      range,
      rule: { kind: 'list', values: ['North', 'South'], dropdown: true },
      mode: 'warn',
    })

    const projected = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 22,
        reason: 'test',
        range,
      }),
    )
    expect(projected.cells[0].validation).toMatchObject({
      code: 'validation.list',
      severity: 'warning',
    })

    await backend.clearValidationRule?.({
      kind: 'clear-validation-rule',
      sheetId: 'sheet-1',
      range,
    })
    const cleared = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 23,
        reason: 'test',
        range,
      }),
    )
    expect(cleared.cells[0].validation).toBeUndefined()
  })

  it('persists conditional format rule mutations in the static backend projection', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [['Region', 'Q1'], ['North', 120]],
    })
    expect(backend.setConditionalFormatRule).toBeDefined()
    expect(backend.listConditionalFormatRules).toBeDefined()

    const range = { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 }
    await backend.setConditionalFormatRule?.({
      kind: 'set-conditional-format-rule',
      sheetId: 'sheet-1',
      scope: { range },
      rule: {
        kind: 'cell-value',
        operator: 'gt',
        value: '100',
        format: { bgColor: '#fef3c7', bold: true },
      },
    })

    const rules = await backend.listConditionalFormatRules?.({
      kind: 'list-conditional-format-rules',
      sheetId: 'sheet-1',
    })
    expect(rules?.rules).toHaveLength(1)
    expect(rules?.rules[0].id).toBeTruthy()

    const projected = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 24,
        reason: 'test',
        range,
      }),
    )
    expect(projected.cells[0].conditionalFormat).toMatchObject({
      bgColor: '#fef3c7',
      bold: true,
    })

    await backend.removeConditionalFormatRule?.({
      kind: 'remove-conditional-format-rule',
      sheetId: 'sheet-1',
      ruleId: rules!.rules[0].id,
    })
    const afterRemove = await backend.listConditionalFormatRules?.({
      kind: 'list-conditional-format-rules',
      sheetId: 'sheet-1',
    })
    expect(afterRemove?.rules).toHaveLength(0)
  })

  it('applies static backend sort directives to visible projections', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['Region', 'Q1'],
        ['North', 120],
        ['South', 80],
        ['East', 200],
        ['West', 140],
      ],
    })

    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [],
      directives: [{ colIndex: 1, direction: 'desc' }],
    })

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 25,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )

    expect(projected.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue)).toEqual([
      'Region',
      'East',
      'West',
      'North',
      'South',
    ])
    expect(projected.cells.find((cell) => cell.row === 1 && cell.col === 0)?.originalRow).toBe(3)
  })

  it('applies static backend filter rules to visible projections', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['Region', 'Q1'],
        ['North', 120],
        ['South', 80],
        ['East', 200],
      ],
    })

    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 1, value: '120' }],
      directives: [],
    })

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 26,
        window: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 },
      }),
    )

    expect(projected.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue)).toEqual([
      'Region',
      'North',
    ])
    expect(projected.cells.some((cell) => cell.displayValue === 'South')).toBe(false)
    expect(projected.cells.some((cell) => cell.displayValue === 'East')).toBe(false)
  })

  it('produces matching display rows for static and worker backends under identical filter/sort state', async () => {
    const matrix: (string | number)[][] = [
      ['Region', 'Q1'],
      ['North', 120],
      ['South', 80],
      ['East', 200],
      ['West', 140],
    ]

    const staticBackend = createStaticSpreadsheetBackend({ revision: 1, matrix })
    const client = createFakeWorkerWorkbookClient()
    const workerBackend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 1,
    })
    await workerBackend.ready()

    matrix.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        const isText = typeof value === 'string'
        client.putCell({
          sheet: 0,
          addr: toCellAddressForTest(rowIndex, colIndex),
          display: String(value),
          type: isText ? 'text' : 'number',
          isError: false,
          formula: '',
        })
      })
    })

    const filterSortRequest = {
      kind: 'set-filter-sort' as const,
      sheetId: 'sheet-1',
      rules: [{ kind: 'range' as const, colIndex: 1, min: 100 }],
      directives: [{ colIndex: 1, direction: 'desc' as const }],
    }

    await staticBackend.setFilterSort?.(filterSortRequest)
    await workerBackend.setFilterSort?.(filterSortRequest)

    const staticProjected = await staticBackend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 100,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )
    const workerProjected = await workerBackend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 101,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )

    const staticRegions = staticProjected.cells
      .filter((cell) => cell.col === 0)
      .sort((left, right) => left.row - right.row)
      .map((cell) => cell.displayValue)
    const workerRegions = workerProjected.cells
      .filter((cell) => cell.col === 0)
      .sort((left, right) => left.row - right.row)
      .map((cell) => cell.displayValue)

    expect(staticRegions).toEqual(workerRegions)
    expect(staticRegions).toEqual(['Region', 'East', 'West', 'North'])

    const staticOriginalRows = staticProjected.cells
      .filter((cell) => cell.col === 0 && cell.row > 0)
      .sort((left, right) => left.row - right.row)
      .map((cell) => cell.originalRow)
    const workerOriginalRows = workerProjected.cells
      .filter((cell) => cell.col === 0 && cell.row > 0)
      .sort((left, right) => left.row - right.row)
      .map((cell) => cell.originalRow)

    expect(staticOriginalRows).toEqual(workerOriginalRows)

    workerBackend.dispose()
  })

  it('matches static and worker filter/sort when sorted top rows are sourced from outside the viewport', async () => {
    // 10 data rows + header. Window only sees rows 0..4 (5 rows). Sort desc should
    // surface the top 4 Q1 values, which live at source rows 6/8/4/10 — most of
    // them outside the viewport. Before the worker scope fix this test would have
    // returned a different result than static because worker only saw rows 0..4.
    const matrix: (string | number)[][] = [
      ['Region', 'Q1'],
      ['R1', 30],
      ['R2', 50],
      ['R3', 20],
      ['R4', 180],
      ['R5', 40],
      ['R6', 200],
      ['R7', 10],
      ['R8', 190],
      ['R9', 60],
      ['R10', 170],
    ]

    const staticBackend = createStaticSpreadsheetBackend({ revision: 1, matrix })
    const client = createFakeWorkerWorkbookClient()
    const workerBackend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 1,
    })
    await workerBackend.ready()

    matrix.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        const isText = typeof value === 'string'
        client.putCell({
          sheet: 0,
          addr: toCellAddressForTest(rowIndex, colIndex),
          display: String(value),
          type: isText ? 'text' : 'number',
          isError: false,
          formula: '',
        })
      })
    })

    const filterSortRequest = {
      kind: 'set-filter-sort' as const,
      sheetId: 'sheet-1',
      rules: [],
      directives: [{ colIndex: 1, direction: 'desc' as const }],
    }

    await staticBackend.setFilterSort?.(filterSortRequest)
    await workerBackend.setFilterSort?.(filterSortRequest)

    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 }
    const staticProjected = await staticBackend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 100, window }),
    )
    const workerProjected = await workerBackend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 101, window }),
    )

    const collect = (cells: readonly { row: number; col: number; displayValue: string; originalRow?: number }[]) =>
      cells
        .filter((cell) => cell.col === 0)
        .sort((left, right) => left.row - right.row)
        .map((cell) => ({ row: cell.row, value: cell.displayValue, source: cell.originalRow }))

    const staticRegions = collect(staticProjected.cells)
    const workerRegions = collect(workerProjected.cells)

    expect(workerRegions).toEqual(staticRegions)
    // Top-down within the 5-row window: header, then sorted top 4 = source rows 6, 8, 4, 10
    expect(staticRegions.map((r) => r.value)).toEqual(['Region', 'R6', 'R8', 'R4', 'R10'])
    expect(staticRegions.map((r) => r.source)).toEqual([0, 6, 8, 4, 10])

    workerBackend.dispose()
  })

  it('persists named range mutations in the static backend', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1 })
    expect(backend.setNamedRange).toBeDefined()
    expect(backend.deleteNamedRange).toBeDefined()
    expect(backend.listNamedRanges).toBeDefined()

    await backend.setNamedRange?.({
      kind: 'set-named-range',
      name: 'SalesTotal',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
    })

    const listed = await backend.listNamedRanges?.({ kind: 'list-named-ranges' })
    expect(listed?.names).toEqual([
      {
        name: 'SalesTotal',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
      },
    ])

    await backend.deleteNamedRange?.({
      kind: 'delete-named-range',
      name: 'SalesTotal',
      scope: 'workbook',
    })
    const afterDelete = await backend.listNamedRanges?.({ kind: 'list-named-ranges' })
    expect(afterDelete?.names).toEqual([])
  })

  it('preserves projected rich values in static reads', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 2,
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'Fallback',
          valueKind: 'string',
          richValue: {
            kind: 'rich-text',
            runs: [
              { text: 'Rich ', format: { bold: true } },
              { text: 'value', format: { color: '#0f766e' } },
            ],
          },
        },
      ],
    })

    const result = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 19,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(result.cells).toEqual([
      {
        row: 0,
        col: 0,
        displayValue: 'Fallback',
        valueKind: 'string',
        richValue: {
          kind: 'rich-text',
          runs: [
            { text: 'Rich ', format: { bold: true } },
            { text: 'value', format: { color: '#0f766e' } },
          ],
        },
      },
    ])

    const projected = result.cells[0].richValue
    if (projected?.kind !== 'rich-text') throw new Error('expected rich-text projection')
    projected.runs[0].text = 'mutated'

    const reread = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 20,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )
    expect(reread.cells[0].richValue).toEqual({
      kind: 'rich-text',
      runs: [
        { text: 'Rich ', format: { bold: true } },
        { text: 'value', format: { color: '#0f766e' } },
      ],
    })
  })

  it('keeps setCellInput isolated to the target cell and bumps revision', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 3,
      matrix: [
        ['A1', 'B1'],
        ['A2', 'B2'],
      ],
    })

    const mutation = await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      requestId: 9,
      revision: 3,
      row: 0,
      col: 1,
      input: 'B1-updated',
    })

    expect(mutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 9,
      revision: 3,
      affectedRange: {
        rowStart: 0,
        rowEnd: 0,
        colStart: 1,
        colEnd: 1,
      },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 10,
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
        reason: 'test',
      }),
    )

    expect(result.revision).toBe(4)
    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 0, col: 1, displayValue: 'B1-updated', valueKind: 'string' },
      { row: 1, col: 0, displayValue: 'A2', valueKind: 'string' },
      { row: 1, col: 1, displayValue: 'B2', valueKind: 'string' },
    ])
  })

  it('sets rich cell values through the optional static backend port', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 7 })
    expect(backend.setCellRichValue).toBeDefined()

    const mutation = await backend.setCellRichValue?.({
      kind: 'set-cell-rich-value',
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 7,
      row: 1,
      col: 1,
      value: {
        kind: 'hyperlink',
        url: 'https://example.com/report',
        label: 'Report',
      },
    })

    expect(mutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 7,
      affectedRange: {
        rowStart: 1,
        rowEnd: 1,
        colStart: 1,
        colEnd: 1,
      },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 22,
        reason: 'test',
        range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      }),
    )

    expect(result.cells).toEqual([
      {
        row: 1,
        col: 1,
        displayValue: 'Report',
        valueKind: 'string',
        richValue: {
          kind: 'hyperlink',
          url: 'https://example.com/report',
          label: 'Report',
        },
      },
    ])
  })

  it('imports static backend cells as one mutation result', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 3,
      matrix: [['A1']],
    })

    const mutation = await backend.importCells?.({
      kind: 'import-cells',
      sheetId: 'sheet-1',
      requestId: 22,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 },
      cells: [
        { row: 1, col: 1, input: 'B2' },
        { row: 2, col: 1, input: '' },
      ],
    })

    expect(mutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 22,
      revision: 4,
      affectedRange: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 23,
        range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
        reason: 'test',
      }),
    )

    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 1, col: 1, displayValue: 'B2', valueKind: 'string' },
    ])
  })

  it('projects static backend merge metadata after merge and unmerge mutations', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['A1', 'B1', 'C1'],
        ['A2', 'B2', 'C2'],
        ['A3', 'B3', 'C3'],
      ],
    })

    const mutation = await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    expect(mutation?.affectedRange).toEqual({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })

    const merged = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 24,
        window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      }),
    )

    expect(merged.cells).toEqual(
      expect.arrayContaining([
        { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', mergedSpan: { rows: 2, cols: 2 } },
        { row: 0, col: 1, displayValue: 'B1', valueKind: 'string', mergeAnchor: { row: 0, col: 0 } },
        { row: 1, col: 0, displayValue: 'A2', valueKind: 'string', mergeAnchor: { row: 0, col: 0 } },
        { row: 1, col: 1, displayValue: 'B2', valueKind: 'string', mergeAnchor: { row: 0, col: 0 } },
      ]),
    )

    await backend.unmergeRange?.({
      kind: 'unmerge-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    const unmerged = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 25,
        window: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      }),
    )

    expect(unmerged.cells.some((cell) => cell.mergedSpan || cell.mergeAnchor)).toBe(false)
  })

  it('exports TSV from static backend with formula source and origin metadata', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 9,
      cells: [
        { row: 1, col: 1, displayValue: '42', valueKind: 'number', formula: '=A1+A2' },
        { row: 1, col: 2, displayValue: 'hello', valueKind: 'string' },
        { row: 2, col: 1, displayValue: 'TRUE', valueKind: 'boolean' },
      ],
    })

    const result = await backend.exportRangeTsv?.({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      requestId: 19,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
    })

    const expectedText = '=A1+A2\thello\nTRUE\t'
    expect(result).toEqual({
      kind: 'range-tsv',
      sheetId: 'sheet-1',
      requestId: 19,
      revision: 9,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      originAddr: 'B2',
      text: expectedText,
      estimatedBytes: Buffer.byteLength(expectedText, 'utf8'),
    })
  })

  it('fills ranges through static backend without UI-side cell expansion contracts', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 5,
      matrix: [
        ['A1', 'B1'],
        ['A2', 'B2'],
      ],
    })

    const mutation = await backend.fillRange?.({
      kind: 'fill-range',
      sheetId: 'sheet-1',
      requestId: 11,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
      direction: 'down',
    })

    expect(mutation).toMatchObject({
      sheetId: 'sheet-1',
      requestId: 11,
      revision: 6,
      affectedRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 12,
        range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
        reason: 'test',
      }),
    )

    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 0, col: 1, displayValue: 'B1', valueKind: 'string' },
      { row: 1, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 1, col: 1, displayValue: 'B1', valueKind: 'string' },
      { row: 2, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 2, col: 1, displayValue: 'B1', valueKind: 'string' },
    ])
  })

  it('resolves static data-edge movement from sparse cells without projecting full rows', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 7,
      matrix: [
        ['H1', 'H2', 'H3', null, 'H5'],
        ['R2', 12, 18, 30, 'ready'],
        ['R3', null, null, null, 'tail'],
      ],
    })

    await expect(
      backend.resolveDataEdge?.({
        kind: 'resolve-data-edge',
        sheetId: 'sheet-1',
        requestId: 13,
        from: { row: 1, col: 1 },
        direction: 'right',
        bounds: { rowCount: 20, colCount: 10 },
      }),
    ).resolves.toEqual({
      sheetId: 'sheet-1',
      requestId: 13,
      revision: 7,
      target: { row: 1, col: 4 },
    })

    await expect(
      backend.resolveDataEdge?.({
        kind: 'resolve-data-edge',
        sheetId: 'sheet-1',
        from: { row: 2, col: 1 },
        direction: 'right',
        bounds: { rowCount: 20, colCount: 10 },
      }),
    ).resolves.toMatchObject({
      target: { row: 2, col: 4 },
    })

    await expect(
      backend.resolveDataEdge?.({
        kind: 'resolve-data-edge',
        sheetId: 'sheet-1',
        from: { row: 0, col: 0 },
        direction: 'down',
        bounds: { rowCount: 20, colCount: 10 },
      }),
    ).resolves.toMatchObject({
      target: { row: 2, col: 0 },
    })
  })

  it('supports sparse seed helpers directly', () => {
    const cells = sparseCellsToDisplayCells([
      { row: 2, col: 2, displayValue: 'C3' },
      { row: 0, col: 1, displayValue: 'B1' },
    ])

    expect(cells).toEqual([
      { row: 0, col: 1, displayValue: 'B1' },
      { row: 2, col: 2, displayValue: 'C3' },
    ])

    expect(
      matrixToDisplayCells([
        [true, 0],
        [null, 'x'],
      ]),
    ).toEqual([
      { row: 0, col: 0, displayValue: 'TRUE', valueKind: 'boolean' },
      { row: 0, col: 1, displayValue: '0', valueKind: 'number' },
      { row: 1, col: 1, displayValue: 'x', valueKind: 'string' },
    ])
  })

  it('clears static backend ranges without materializing blank cells', async () => {
    const backend = createStaticSpreadsheetBackend({
      matrix: [
        ['A1', 'B1', 'C1'],
        ['A2', 'B2', 'C2'],
      ],
    })

    const mutation = await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 12,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 },
      }),
    )

    expect(mutation?.affectedRange).toEqual({
      rowStart: 0,
      rowEnd: 1,
      colStart: 0,
      colEnd: 1,
    })
    expect(result.cells).toEqual([
      { row: 0, col: 2, displayValue: 'C1', valueKind: 'string' },
      { row: 1, col: 2, displayValue: 'C2', valueKind: 'string' },
    ])
  })

  it('applies static backend row and column structural edits sparsely', async () => {
    const backend = createStaticSpreadsheetBackend({
      matrix: [
        ['A1', 'B1', 'C1'],
        ['A2', 'B2', 'C2'],
        ['A3', 'B3', 'C3'],
      ],
    })

    await backend.insertRows?.({
      kind: 'insert-rows',
      sheetId: 'sheet-1',
      rowIndex: 1,
      count: 1,
    })
    await backend.deleteColumns?.({
      kind: 'delete-columns',
      sheetId: 'sheet-1',
      colIndex: 1,
      count: 1,
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 13,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 },
      }),
    )

    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 0, col: 1, displayValue: 'C1', valueKind: 'string' },
      { row: 2, col: 0, displayValue: 'A2', valueKind: 'string' },
      { row: 2, col: 1, displayValue: 'C2', valueKind: 'string' },
      { row: 3, col: 0, displayValue: 'A3', valueKind: 'string' },
      { row: 3, col: 1, displayValue: 'C3', valueKind: 'string' },
    ])
  })

  it('tracks static backend sheet metadata mutations without cell materialization', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
      matrix: [['A1']],
    })

    expect((await backend.listSheets?.())?.sheets).toEqual([
      { id: 'sheet-1', name: 'Sheet1', index: 0 },
      { id: 'sheet-2', name: 'Sheet2', index: 1 },
    ])

    const add = await backend.addSheet?.({ kind: 'add-sheet', name: 'Data' })
    expect(add?.createdSheet).toEqual({ id: 'sheet-3', name: 'Data', index: 2 })

    const rename = await backend.renameSheet?.({
      kind: 'rename-sheet',
      sheetId: 'sheet-2',
      name: 'Inputs',
    })
    expect(rename?.sheets?.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Inputs', 'Data'])

    const reorder = await backend.reorderSheet?.({
      kind: 'reorder-sheet',
      sheetId: 'sheet-1',
      afterSheetId: 'sheet-3',
    })
    expect(reorder?.sheets?.map((sheet) => sheet.name)).toEqual(['Inputs', 'Data', 'Sheet1'])

    const remove = await backend.deleteSheet?.({
      kind: 'delete-sheet',
      sheetId: 'sheet-2',
    })
    expect(remove?.activeSheetId).toBe('sheet-3')
    expect(remove?.sheets).toEqual([
      { id: 'sheet-3', name: 'Data', index: 0 },
      { id: 'sheet-1', name: 'Sheet1', index: 1 },
    ])
  })

  it('stores static backend viewport size metadata sparsely', async () => {
    const backend = createStaticSpreadsheetBackend({
      matrix: [['A1']],
      sheets: ['Sheet1', 'Sheet2'],
    })

    const rowMutation = await backend.setRowHeight?.({
      kind: 'set-row-height',
      sheetId: 'sheet-1',
      requestId: 30,
      rowIndex: 1,
      heightPx: 36.4,
    })
    const colMutation = await backend.setColumnWidth?.({
      kind: 'set-column-width',
      sheetId: 'sheet-1',
      requestId: 31,
      colIndex: 1,
      widthPx: 128.6,
    })

    expect(rowMutation).toMatchObject({ sheetId: 'sheet-1', requestId: 30, revision: 1 })
    expect(colMutation).toMatchObject({ sheetId: 'sheet-1', requestId: 31, revision: 2 })

    const result = await backend.readViewportSizeProjection?.({
      kind: 'viewport-size',
      sheetId: 'sheet-1',
      requestId: 32,
      window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
    })

    expect(result).toEqual({
      kind: 'viewport-size',
      sheetId: 'sheet-1',
      requestId: 32,
      revision: 2,
      window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      rowHeights: [{ rowIndex: 1, heightPx: 36 }],
      colWidths: [{ colIndex: 1, widthPx: 129 }],
    })

    await expect(
      backend.readViewportSizeProjection?.({
        kind: 'viewport-size',
        sheetId: 'sheet-2',
        requestId: 33,
        window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      }),
    ).resolves.toMatchObject({
      sheetId: 'sheet-2',
      rowHeights: [],
      colWidths: [],
    })
  })

  it('projects static backend formats only inside requested windows', async () => {
    const backend = createStaticSpreadsheetBackend({
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'A1',
          valueKind: 'string',
          format: { bold: true },
        },
      ],
    })

    const mutation = await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: 14,
      range: { rowStart: 1, rowEnd: 999_999, colStart: 1, colEnd: 999_999 },
      format: { bgColor: '#ffd966' },
    })
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 15,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      }),
    )

    expect(mutation?.affectedRange).toEqual({
      rowStart: 1,
      rowEnd: 999_999,
      colStart: 1,
      colEnd: 999_999,
    })
    expect(result.cells).toEqual([
      {
        row: 0,
        col: 0,
        displayValue: 'A1',
        valueKind: 'string',
        format: { bold: true },
      },
      {
        row: 1,
        col: 1,
        displayValue: '',
        valueKind: 'blank',
        format: { bgColor: '#ffd966' },
      },
    ])
  })

  it('keeps requestId and revision aligned on visible reads', async () => {
    const backend = createStaticSpreadsheetBackend([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ])

    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 42,
      revision: 11,
      window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    const result = await backend.readVisibleProjection(request)

    expect(result).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 42,
      revision: 11,
    })
    expect(result.cells).toEqual([{ row: 0, col: 0, displayValue: 'A1', valueKind: 'string' }])
  })

  it('adapts worker workbook sparse reads into visible projections', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
      revision: 4,
    })

    await backend.ready()
    client.putCell({
      sheet: 1,
      addr: 'B2',
      display: '42',
      type: 'number',
      isError: false,
      formula: '=Sheet1!A1+1',
    })

    const result = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 12,
        window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      }),
    )

    expect(client.calls.initWorkbook).toEqual([['Sheet1', 'Sheet2']])
    expect(client.calls.readSparseRange).toEqual([
      { sheet: 1, startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
    ])
    expect(client.calls.snapshotFormatRange).toEqual([
      { sheet: 1, startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
    ])
    expect(result).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-2',
      requestId: 12,
      revision: 4,
      window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
    })
    expect(result.cells).toEqual([
      {
        row: 1,
        col: 1,
        displayValue: '42',
        valueKind: 'number',
        formula: '=Sheet1!A1+1',
      },
    ])

    backend.dispose()
  })

  it('applies worker backend toolbar overlays instead of silently no-oping', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 1,
    })
    await backend.ready()
    ;[
      ['A1', 'Region', 'text'],
      ['B1', 'Q1', 'text'],
      ['A2', 'North', 'text'],
      ['B2', '120', 'number'],
      ['A3', 'South', 'text'],
      ['B3', '80', 'number'],
      ['A4', 'East', 'text'],
      ['B4', '200', 'number'],
      ['A5', 'Total', 'text'],
      ['B5', '400', 'number'],
    ].forEach(([addr, display, type]) => {
      client.putCell({
        sheet: 0,
        addr,
        display,
        type: type as CellSnapshotWire['type'],
        isError: false,
        formula: '',
      })
    })

    await backend.setNamedRange?.({
      kind: 'set-named-range',
      name: 'Q1Sales',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:B4' },
    })
    await backend.setValidationRule?.({
      kind: 'set-validation-rule',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      rule: { kind: 'list', values: ['120'], dropdown: true },
      mode: 'warn',
    })
    await backend.setConditionalFormatRule?.({
      kind: 'set-conditional-format-rule',
      sheetId: 'sheet-1',
      scope: { range: { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 1 } },
      rule: {
        kind: 'cell-value',
        operator: 'gt',
        value: '100',
        format: { bgColor: '#fef3c7' },
      },
    })
    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [],
      directives: [{ colIndex: 1, direction: 'desc' }],
    })

    const names = await backend.listNamedRanges?.({ kind: 'list-named-ranges' })
    expect(names?.names).toEqual([
      {
        name: 'Q1Sales',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:B4' },
      },
    ])

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 13,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )

    expect(projected.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue))
      .toEqual(['Region', 'East', 'North', 'South', 'Total'])
    expect(projected.cells.find((cell) => cell.row === 2 && cell.col === 1)?.validation)
      .toMatchObject({
        code: 'validation.list',
        severity: 'warning',
      })
    expect(projected.cells.find((cell) => cell.row === 1 && cell.col === 1)?.conditionalFormat)
      .toMatchObject({
        bgColor: '#fef3c7',
      })

    backend.dispose()
  })

  it('resolves worker workbook data-edge movement through sparse snapshots only', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    await backend.ready()
    client.putCell({
      sheet: 0,
      addr: 'B2',
      display: '12',
      type: 'number',
      isError: false,
      formula: '',
    })
    client.putCell({
      sheet: 0,
      addr: 'C2',
      display: '18',
      type: 'number',
      isError: false,
      formula: '',
    })
    client.putCell({
      sheet: 0,
      addr: 'D2',
      display: '',
      type: 'null',
      isError: false,
      formula: '=B2+C2',
    })
    client.putCell({
      sheet: 0,
      addr: 'E2',
      display: 'ready',
      type: 'text',
      isError: false,
      formula: '',
    })

    const result = await backend.resolveDataEdge?.({
      kind: 'resolve-data-edge',
      sheetId: 'sheet-1',
      requestId: 18,
      from: { row: 1, col: 1 },
      direction: 'right',
      bounds: { rowCount: 20, colCount: 10 },
    })

    expect(result).toEqual({
      sheetId: 'sheet-1',
      requestId: 18,
      revision: 6,
      target: { row: 1, col: 4 },
    })
    expect(client.calls.snapshotRangeSparse).toEqual([
      { sheet: 0, startRow: 1, endRow: 1, startCol: 0, endCol: 9 },
    ])
    expect(client.calls.readSparseRange).toEqual([])
    expect(client.calls.snapshotFormatRange).toEqual([])

    backend.dispose()
  })

  it('exports TSV through worker workbook chunk consumer before falling back to plain export', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    await backend.ready()
    client.consumeExportRangeTsvChunks = async (range, onChunk, rowsPerChunk) => {
      client.calls.consumeExportRangeTsvChunks.push({ ...range, rowsPerChunk })
      await onChunk({
        sessionId: 1,
        startRow: 1,
        endRow: 1,
        chunk: 'A\tB',
        done: false,
      })
      await onChunk({
        sessionId: 1,
        startRow: 2,
        endRow: 2,
        chunk: 'C\tD',
        done: true,
      })
    }

    const result = await backend.exportRangeTsv?.({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      requestId: 20,
      revision: 11,
      rowsPerChunk: 2,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
    })

    expect(result).toEqual({
      kind: 'range-tsv',
      sheetId: 'sheet-1',
      requestId: 20,
      revision: 11,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      originAddr: 'B2',
      text: 'A\tB\nC\tD',
      estimatedBytes: 7,
    })
    expect(client.calls.consumeExportRangeTsvChunks).toEqual([
      { sheet: 0, startRow: 1, startCol: 1, endRow: 2, endCol: 2, rowsPerChunk: 2 },
    ])
    expect(client.calls.exportRangeTsvChunks).toEqual([])
    expect(client.calls.exportRangeTsv).toEqual([])
    expect(client.calls.readSparseRange).toEqual([])
    expect(client.calls.snapshotRangeSparse).toEqual([])
    expect(client.calls.snapshotFormatRange).toEqual([])

    backend.dispose()
  })

  it('streams TSV through worker workbook backend without aggregate chunk export', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })
    const chunks: string[] = []

    await backend.ready()
    client.consumeExportRangeTsvChunks = async (range, onChunk, rowsPerChunk) => {
      client.calls.consumeExportRangeTsvChunks.push({ ...range, rowsPerChunk })
      await onChunk({
        sessionId: 1,
        startRow: 1,
        endRow: 1,
        chunk: 'A\tB',
        done: false,
      })
      await onChunk({
        sessionId: 1,
        startRow: 2,
        endRow: 2,
        chunk: 'C\tD',
        done: true,
      })
    }

    const result = await backend.consumeExportRangeTsvChunks?.(
      {
        kind: 'export-range-tsv',
        sheetId: 'sheet-1',
        requestId: 20,
        revision: 11,
        rowsPerChunk: 2,
        range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      },
      (chunk) => {
        chunks.push(chunk.text)
      },
    )

    expect(result).toEqual({
      kind: 'range-tsv-chunks',
      sheetId: 'sheet-1',
      requestId: 20,
      revision: 11,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      originAddr: 'B2',
      estimatedBytes: 7,
    })
    expect(chunks).toEqual(['A\tB', 'C\tD'])
    expect(client.calls.consumeExportRangeTsvChunks).toEqual([
      { sheet: 0, startRow: 1, startCol: 1, endRow: 2, endCol: 2, rowsPerChunk: 2 },
    ])
    expect(client.calls.exportRangeTsvChunks).toEqual([])
    expect(client.calls.exportRangeTsv).toEqual([])

    backend.dispose()
  })

  it('imports worker workbook cells through chunked bulk import', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    await backend.ready()
    const result = await backend.importCells?.({
      kind: 'import-cells',
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 12,
      cellsPerChunk: 2,
      range: { rowStart: 4, rowEnd: 5, colStart: 3, colEnd: 4 },
      cells: [
        { row: 4, col: 3, input: '=A1+1' },
        { row: 4, col: 4, input: '7' },
        { row: 5, col: 3, input: '' },
      ],
    })

    expect(result).toEqual({
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 12,
      affectedRange: { rowStart: 4, rowEnd: 5, colStart: 3, colEnd: 4 },
    })
    expect(client.calls.beginImport).toEqual([1])
    expect(client.calls.beginImportOptions).toEqual([{ sessionId: 1, options: { mode: 'direct' } }])
    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [
          { sheet: 0, row: 4, col: 3, kind: 'formula', value: '=A1+1' },
          { sheet: 0, row: 4, col: 4, kind: 'number', value: 7 },
        ],
      },
      {
        sessionId: 1,
        cells: [{ sheet: 0, row: 5, col: 3, kind: 'null' }],
      },
    ])
    expect(client.calls.commitImport).toEqual([1])
    expect(client.calls.cancelImport).toEqual([])
    expect(client.calls.setCell).toEqual([])
    expect(client.calls.setFormulaDetailed).toEqual([])

    backend.dispose()
  })

  it('imports worker workbook cell chunk sources through bounded import chunks', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    async function* chunks() {
      yield [
        { row: 4, col: 3, input: '=A1+1' },
        { row: 4, col: 4, input: '7' },
        { row: 5, col: 3, input: 'text' },
      ]
      yield [{ row: 5, col: 4, input: '' }]
    }

    await backend.ready()
    const result = await backend.importCellChunks?.({
      kind: 'import-cell-chunks',
      sheetId: 'sheet-1',
      requestId: 24,
      revision: 12,
      cellsPerChunk: 2,
      range: { rowStart: 4, rowEnd: 5, colStart: 3, colEnd: 4 },
      chunks: chunks(),
    })

    expect(result).toEqual({
      sheetId: 'sheet-1',
      requestId: 24,
      revision: 12,
      affectedRange: { rowStart: 4, rowEnd: 5, colStart: 3, colEnd: 4 },
    })
    expect(client.calls.beginImport).toEqual([1])
    expect(client.calls.beginImportOptions).toEqual([{ sessionId: 1, options: { mode: 'direct' } }])
    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [
          { sheet: 0, row: 4, col: 3, kind: 'formula', value: '=A1+1' },
          { sheet: 0, row: 4, col: 4, kind: 'number', value: 7 },
        ],
      },
      {
        sessionId: 1,
        cells: [
          { sheet: 0, row: 5, col: 3, kind: 'text', value: 'text' },
          { sheet: 0, row: 5, col: 4, kind: 'null' },
        ],
      },
    ])
    expect(client.calls.commitImport).toEqual([1])
    expect(client.calls.cancelImport).toEqual([])
    expect(client.calls.setCell).toEqual([])
    expect(client.calls.setFormulaDetailed).toEqual([])

    backend.dispose()
  })

  it('cancels chunk-first worker import when the source iterator fails', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    async function* chunks() {
      yield [{ row: 4, col: 3, input: '=A1+1' }]
      throw new Error('source failed')
    }

    await backend.ready()
    await expect(
      backend.importCellChunks?.({
        kind: 'import-cell-chunks',
        sheetId: 'sheet-1',
        requestId: 25,
        cellsPerChunk: 1,
        range: { rowStart: 4, rowEnd: 4, colStart: 3, colEnd: 3 },
        chunks: chunks(),
      }),
    ).rejects.toThrow('source failed')

    expect(client.calls.beginImport).toEqual([1])
    expect(client.calls.beginImportOptions).toEqual([{ sessionId: 1, options: { mode: 'direct' } }])
    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [{ sheet: 0, row: 4, col: 3, kind: 'formula', value: '=A1+1' }],
      },
    ])
    expect(client.calls.commitImport).toEqual([])
    expect(client.calls.cancelImport).toEqual([1])
    expect(client.calls.setCell).toEqual([])
    expect(client.calls.setFormulaDetailed).toEqual([])

    backend.dispose()
  })

  it('cancels worker workbook import when a chunk fails without per-cell fallback', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    await backend.ready()
    client.importChunk = async (sessionId, importCells) => {
      client.calls.importChunk.push({ sessionId, cells: importCells })
      throw new Error('import chunk failed')
    }

    await expect(
      backend.importCells?.({
        kind: 'import-cells',
        sheetId: 'sheet-1',
        requestId: 22,
        cellsPerChunk: 2,
        range: { rowStart: 4, rowEnd: 4, colStart: 3, colEnd: 4 },
        cells: [
          { row: 4, col: 3, input: '=A1+1' },
          { row: 4, col: 4, input: '7' },
        ],
      }),
    ).rejects.toThrow('import chunk failed')

    expect(client.calls.beginImport).toEqual([1])
    expect(client.calls.beginImportOptions).toEqual([{ sessionId: 1, options: { mode: 'direct' } }])
    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [
          { sheet: 0, row: 4, col: 3, kind: 'formula', value: '=A1+1' },
          { sheet: 0, row: 4, col: 4, kind: 'number', value: 7 },
        ],
      },
    ])
    expect(client.calls.commitImport).toEqual([])
    expect(client.calls.cancelImport).toEqual([1])
    expect(client.calls.setCell).toEqual([])
    expect(client.calls.setFormulaDetailed).toEqual([])

    backend.dispose()
  })

  it('cancels worker workbook import when commit fails without per-cell fallback', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    await backend.ready()
    client.commitImport = async (sessionId) => {
      client.calls.commitImport.push(sessionId)
      throw new Error('commit import failed')
    }

    await expect(
      backend.importCells?.({
        kind: 'import-cells',
        sheetId: 'sheet-1',
        requestId: 23,
        cellsPerChunk: 2,
        range: { rowStart: 4, rowEnd: 4, colStart: 3, colEnd: 4 },
        cells: [
          { row: 4, col: 3, input: '=A1+1' },
          { row: 4, col: 4, input: '7' },
        ],
      }),
    ).rejects.toThrow('commit import failed')

    expect(client.calls.beginImport).toEqual([1])
    expect(client.calls.beginImportOptions).toEqual([{ sessionId: 1, options: { mode: 'direct' } }])
    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [
          { sheet: 0, row: 4, col: 3, kind: 'formula', value: '=A1+1' },
          { sheet: 0, row: 4, col: 4, kind: 'number', value: 7 },
        ],
      },
    ])
    expect(client.calls.commitImport).toEqual([1])
    expect(client.calls.cancelImport).toEqual([1])
    expect(client.calls.setCell).toEqual([])
    expect(client.calls.setFormulaDetailed).toEqual([])

    backend.dispose()
  })

  it('falls back to worker workbook plain export when chunk export is unavailable', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 8,
    })

    await backend.ready()
    client.consumeExportRangeTsvChunks =
      undefined as unknown as WorkerWorkbookClient['consumeExportRangeTsvChunks']
    client.exportRangeTsvChunks =
      undefined as unknown as WorkerWorkbookClient['exportRangeTsvChunks']
    client.exportRangeTsv = async (range) => {
      client.calls.exportRangeTsv.push({ ...range })
      return 'fallback-body'
    }

    const result = await backend.exportRangeTsv?.({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      requestId: 21,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    expect(result).toEqual({
      kind: 'range-tsv',
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 8,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      originAddr: 'A1',
      text: 'fallback-body',
      estimatedBytes: 13,
    })
    expect(client.calls.exportRangeTsv).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    ])
    expect(client.calls.consumeExportRangeTsvChunks).toEqual([])
    expect(client.calls.exportRangeTsvChunks).toEqual([])
    expect(client.calls.readSparseRange).toEqual([])
    expect(client.calls.snapshotRangeSparse).toEqual([])
    expect(client.calls.snapshotFormatRange).toEqual([])

    backend.dispose()
  })

  it('routes worker workbook range formats and projects formatted visible blanks', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 2,
    })

    await backend.ready()

    const mutation = await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: 16,
      range: { rowStart: 1, rowEnd: 999_999, colStart: 1, colEnd: 999_999 },
      format: { bold: true, bgColor: '#ffd966' },
    })
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 17,
        reason: 'test',
        range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      }),
    )

    expect(client.calls.setFormatRange).toEqual([
      {
        sheet: 0,
        startRow: 1,
        startCol: 1,
        endRow: 999_999,
        endCol: 999_999,
        fmt: { bold: true, bgColor: '#ffd966' },
      },
    ])
    expect(client.calls.snapshotFormatRange).toEqual([
      { sheet: 0, startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
    ])
    expect(mutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 16,
      revision: 3,
      affectedRange: {
        rowStart: 1,
        rowEnd: 999_999,
        colStart: 1,
        colEnd: 999_999,
      },
    })
    expect(result.cells).toEqual([
      {
        row: 1,
        col: 1,
        displayValue: '',
        valueKind: 'blank',
        format: { bold: true, bgColor: '#ffd966' },
      },
    ])

    backend.dispose()
  })

  it('routes worker workbook mutations through value, formula, and clear commands', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
    })

    await backend.ready()

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: '123',
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 1,
      input: ' text ',
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 2,
      input: '=A1+1',
    })
    const clearResult = await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      requestId: 99,
      revision: 8,
      row: 0,
      col: 0,
      input: '',
    })

    expect(client.calls.setCell).toEqual([
      { sheet: 0, addr: 'A1', value: { type: 'number', value: 123 } },
      { sheet: 0, addr: 'B1', value: { type: 'text', value: 'text' } },
    ])
    expect(client.calls.setFormulaDetailed).toEqual([{ sheet: 0, addr: 'C1', formula: '=A1+1' }])
    expect(client.calls.clearCell).toEqual([{ sheet: 0, addr: 'A1' }])
    expect(clearResult).toEqual({
      sheetId: 'sheet-1',
      requestId: 99,
      revision: 8,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    backend.dispose()
  })

  it('rejects worker workbook formula mutations when the runtime reports a formula error', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
    })

    await backend.ready()
    client.setFormulaDetailed = async (sheet, addr, formula) => {
      client.calls.setFormulaDetailed.push({ sheet, addr: addr.toUpperCase(), formula })
      return {
        ok: false,
        code: 'FORMULA_CYCLE',
        message: 'formula would create a cycle',
        display: '#CYCLE!',
      }
    }

    await expect(
      backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        requestId: 100,
        row: 0,
        col: 0,
        input: '=A1+1',
      }),
    ).rejects.toMatchObject({
      code: 'FORMULA_CYCLE',
      message: 'formula would create a cycle',
    })
    expect(client.calls.setFormulaDetailed).toEqual([{ sheet: 0, addr: 'A1', formula: '=A1+1' }])

    backend.dispose()
  })

  it('routes worker workbook range clear through backend clearRange', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 5,
    })

    await backend.ready()
    client.putCell({
      sheet: 0,
      addr: 'A1',
      display: 'A1',
      type: 'text',
      isError: false,
      formula: '',
    })
    client.putCell({
      sheet: 0,
      addr: 'C1',
      display: 'C1',
      type: 'text',
      isError: false,
      formula: '',
    })

    const mutation = await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      requestId: 10,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
    })
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 11,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 2 },
      }),
    )

    expect(client.calls.clearRange).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    ])
    expect(mutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 10,
      revision: 6,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
    })
    expect(result.cells).toEqual([{ row: 0, col: 2, displayValue: 'C1', valueKind: 'string' }])

    backend.dispose()
  })

  it('routes worker workbook row and column structural edits through the backend', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 10,
    })

    await backend.ready()
    client.putCell({
      sheet: 0,
      addr: 'A1',
      display: 'A1',
      type: 'text',
      isError: false,
      formula: '',
    })
    client.putCell({
      sheet: 0,
      addr: 'A2',
      display: 'A2',
      type: 'text',
      isError: false,
      formula: '',
    })
    client.putCell({
      sheet: 0,
      addr: 'C2',
      display: 'C2',
      type: 'text',
      isError: false,
      formula: '',
    })

    const rowMutation = await backend.insertRows?.({
      kind: 'insert-rows',
      sheetId: 'sheet-1',
      requestId: 20,
      rowIndex: 1,
      count: 1,
    })
    const colMutation = await backend.deleteColumns?.({
      kind: 'delete-columns',
      sheetId: 'sheet-1',
      requestId: 21,
      colIndex: 1,
      count: 1,
    })
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 22,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 },
      }),
    )

    expect(client.calls.insertRows).toEqual([{ sheet: 0, rowIndex: 1, count: 1 }])
    expect(client.calls.deleteColumns).toEqual([{ sheet: 0, colIndex: 1, count: 1 }])
    expect(rowMutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 20,
      revision: 11,
    })
    expect(colMutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 12,
    })
    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 2, col: 0, displayValue: 'A2', valueKind: 'string' },
      { row: 2, col: 1, displayValue: 'C2', valueKind: 'string' },
    ])

    backend.dispose()
  })

  it('routes worker workbook sheet add, rename, delete through metadata backend port', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
      revision: 20,
    })

    await backend.ready()
    expect((await backend.listSheets?.())?.sheets).toEqual([
      { id: 'sheet-1', name: 'Sheet1', index: 0 },
      { id: 'sheet-2', name: 'Sheet2', index: 1 },
    ])

    const add = await backend.addSheet?.({ kind: 'add-sheet', name: 'Calc' })
    expect(client.calls.addSheet).toEqual(['Calc'])
    expect(add).toMatchObject({
      sheetId: 'sheet-3',
      activeSheetId: 'sheet-3',
      revision: 21,
      createdSheet: { id: 'sheet-3', name: 'Calc', index: 2 },
    })

    const rename = await backend.renameSheet?.({
      kind: 'rename-sheet',
      sheetId: 'sheet-2',
      name: 'Inputs',
    })
    expect(client.calls.renameSheet).toEqual([{ sheet: 1, name: 'Inputs' }])
    expect(rename?.sheets?.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Inputs', 'Calc'])

    const reorder = await backend.reorderSheet?.({
      kind: 'reorder-sheet',
      sheetId: 'sheet-1',
      afterSheetId: 'sheet-3',
    })
    expect(reorder).toMatchObject({
      sheetId: 'sheet-1',
      activeSheetId: 'sheet-1',
      revision: 23,
    })
    expect(client.calls.moveSheet).toEqual([{ from: 0, to: 2 }])
    expect(reorder?.sheets).toEqual([
      { id: 'sheet-2', name: 'Inputs', index: 0 },
      { id: 'sheet-3', name: 'Calc', index: 1 },
      { id: 'sheet-1', name: 'Sheet1', index: 2 },
    ])

    expect((await backend.listSheets?.())?.sheets).toEqual([
      { id: 'sheet-2', name: 'Inputs', index: 0 },
      { id: 'sheet-3', name: 'Calc', index: 1 },
      { id: 'sheet-1', name: 'Sheet1', index: 2 },
    ])

    const remove = await backend.deleteSheet?.({ kind: 'delete-sheet', sheetId: 'sheet-2' })
    expect(client.calls.removeSheet).toEqual([0])
    expect(remove?.activeSheetId).toBe('sheet-3')
    expect(remove?.sheets).toEqual([
      { id: 'sheet-3', name: 'Calc', index: 0 },
      { id: 'sheet-1', name: 'Sheet1', index: 1 },
    ])

    backend.dispose()
  })

  it('routes worker workbook viewport size metadata through Rust sparse facts without cell reads', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 30,
    })

    await backend.ready()
    const rowMutation = await backend.setRowHeight?.({
      kind: 'set-row-height',
      sheetId: 'sheet-1',
      requestId: 40,
      rowIndex: 1,
      heightPx: 36.4,
    })
    const colMutation = await backend.setColumnWidth?.({
      kind: 'set-column-width',
      sheetId: 'sheet-1',
      requestId: 41,
      colIndex: 1,
      widthPx: 128.6,
    })
    const result = await backend.readViewportSizeProjection?.({
      kind: 'viewport-size',
      sheetId: 'sheet-1',
      requestId: 42,
      window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
    })

    expect(rowMutation).toMatchObject({ sheetId: 'sheet-1', requestId: 40, revision: 31 })
    expect(colMutation).toMatchObject({ sheetId: 'sheet-1', requestId: 41, revision: 32 })
    expect(result).toEqual({
      kind: 'viewport-size',
      sheetId: 'sheet-1',
      requestId: 42,
      revision: 32,
      window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      rowHeights: [{ rowIndex: 1, heightPx: 36 }],
      colWidths: [{ colIndex: 1, widthPx: 129 }],
    })
    expect(client.calls.setRowHeight).toEqual([{ sheet: 0, rowIndex: 1, heightPx: 36 }])
    expect(client.calls.setColumnWidth).toEqual([{ sheet: 0, colIndex: 1, widthPx: 129 }])
    expect(client.calls.snapshotViewportSizes).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
    ])
    expect(client.calls.readSparseRange).toEqual([])
    expect(client.calls.snapshotRangeSparse).toEqual([])
    expect(client.calls.snapshotFormatRange).toEqual([])

    backend.dispose()
  })

  it('bumps worker backend projection revision after dirty events and mutations', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 1,
    })

    await backend.ready()
    client.emitDirty([{ sheet: 0, addr: 'A1' }])

    const afterDirty = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: '7',
    })
    const afterMutation = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 2,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(afterDirty.revision).toBe(2)
    expect(afterMutation.revision).toBe(3)

    backend.dispose()
  })

  it('isolates static backend cell writes to the target sheet — sheet-2 write does not appear on sheet-1', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
      cells: [{ row: 0, col: 0, displayValue: 'from-seed', valueKind: 'string' }],
    })

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-2',
      row: 0,
      col: 0,
      input: 'only-on-sheet-2',
    })

    const sheet1 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 101,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )
    const sheet2 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 102,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(sheet1.cells).toEqual([
      { row: 0, col: 0, displayValue: 'from-seed', valueKind: 'string' },
    ])
    expect(sheet2.cells).toEqual([
      { row: 0, col: 0, displayValue: 'only-on-sheet-2', valueKind: 'string' },
    ])
  })

  it('isolates static backend mutations — clearRange on sheet-2 does not clear sheet-1 cells', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
    })

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'keep-me',
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-2',
      row: 0,
      col: 0,
      input: 'clear-me',
    })

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-2',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    const sheet1 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 103,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )
    const sheet2 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 104,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(sheet1.cells).toEqual([
      { row: 0, col: 0, displayValue: 'keep-me', valueKind: 'string' },
    ])
    expect(sheet2.cells).toEqual([])
  })

  it('clears only values when static backend clearRange target is values', async () => {
    const backend = createStaticSpreadsheetBackend([['A1', 'B1']])
    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      format: { bold: true },
    })

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      target: 'values',
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 200,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      }),
    )

    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: '', valueKind: 'blank', format: { bold: true } },
      { row: 0, col: 1, displayValue: '', valueKind: 'blank', format: { bold: true } },
    ])
  })

  it('clears only formats when static backend clearRange target is formats', async () => {
    const backend = createStaticSpreadsheetBackend([['A1', 'B1']])
    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      format: { bold: true },
    })

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      target: 'formats',
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 201,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      }),
    )

    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 0, col: 1, displayValue: 'B1', valueKind: 'string' },
    ])
  })

  it('clears static backend formats only inside the requested range -- surrounding layer survives outside', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })

    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      format: { bgColor: '#abcdef' },
    })

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      target: 'formats',
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 205,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      }),
    )

    // The center cell (1,1) has the format layer punched; the 8 surrounding cells keep the bg color.
    const formattedCount = result.cells.filter((cell) => cell.format?.bgColor === '#abcdef').length
    const centerCell = result.cells.find((cell) => cell.row === 1 && cell.col === 1)
    expect(formattedCount).toBe(8)
    expect(centerCell).toBeUndefined()
  })

  it('clears both values and formats when static backend clearRange target is all', async () => {
    const backend = createStaticSpreadsheetBackend([['A1', 'B1']])
    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      format: { bold: true },
    })

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      target: 'all',
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 202,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      }),
    )

    expect(result.cells).toEqual([])
  })

  it('isolates static backend cell formats across sheets -- formatting sheet-1 leaves sheet-2 unformatted', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
      cells: [
        { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: { bold: true } },
      ],
    })

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-2',
      row: 0,
      col: 0,
      input: 'on-sheet-2',
    })

    const sheet1 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 210,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )
    const sheet2 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 211,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(sheet1.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: { bold: true } },
    ])
    expect(sheet2.cells).toEqual([
      { row: 0, col: 0, displayValue: 'on-sheet-2', valueKind: 'string' },
    ])
  })

  it('isolates static backend range formats across sheets -- formatting sheet-1 leaves sheet-2 unformatted blanks', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
    })

    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
      format: { bgColor: '#ffd966' },
    })

    const sheet1 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 220,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      }),
    )
    const sheet2 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 221,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      }),
    )

    expect(sheet1.cells).toEqual([
      { row: 0, col: 0, displayValue: '', valueKind: 'blank', format: { bgColor: '#ffd966' } },
      { row: 0, col: 1, displayValue: '', valueKind: 'blank', format: { bgColor: '#ffd966' } },
      { row: 1, col: 0, displayValue: '', valueKind: 'blank', format: { bgColor: '#ffd966' } },
      { row: 1, col: 1, displayValue: '', valueKind: 'blank', format: { bgColor: '#ffd966' } },
    ])
    expect(sheet2.cells).toEqual([])
  })

  it('preserves font-family-only range formats in the static backend', async () => {
    const backend = createStaticSpreadsheetBackend([['A1']])

    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { fontFamily: 'Helvetica' },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 222,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(result.cells).toEqual([
      {
        row: 0,
        col: 0,
        displayValue: 'A1',
        valueKind: 'string',
        format: { fontFamily: 'Helvetica' },
      },
    ])
  })

  it('keeps static backend structural edits scoped to one sheet -- inserting rows on sheet-1 leaves sheet-2 formats intact', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
    })

    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })
    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-2',
      range: { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 0 },
      format: { italic: true },
    })

    await backend.insertRows?.({
      kind: 'insert-rows',
      sheetId: 'sheet-1',
      rowIndex: 0,
      count: 1,
    })

    const sheet2 = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 230,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      }),
    )

    // sheet-2 italic format at row 2 must NOT shift, because the row insert was scoped to sheet-1
    expect(sheet2.cells).toEqual([
      { row: 2, col: 0, displayValue: '', valueKind: 'blank', format: { italic: true } },
    ])
  })

  it('clears only values when worker backend clearRange target is values', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
    })
    await backend.ready()

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      target: 'values',
    })

    expect(client.calls.clearRange).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    ])
    expect(client.calls.setFormatRange).toEqual([])

    backend.dispose()
  })

  it('clears only formats when worker backend clearRange target is formats', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
    })
    await backend.ready()

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      target: 'formats',
    })

    expect(client.calls.clearRange).toEqual([])
    expect(client.calls.setFormatRange).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1, fmt: null },
    ])

    backend.dispose()
  })

  it('clears both values and formats when worker backend clearRange target is all', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
    })
    await backend.ready()

    await backend.clearRange?.({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      target: 'all',
    })

    expect(client.calls.clearRange).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    ])
    expect(client.calls.setFormatRange).toEqual([
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1, fmt: null },
    ])

    backend.dispose()
  })

  // --- Wave 7.1 Text to Columns: per-chunk preserveAsText -----------------

  it('static backend honors preserveAsText: literal text bypasses numeric and formula inference', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })

    async function* chunks() {
      yield [
        { row: 0, col: 0, input: '00123', preserveAsText: true },
        { row: 0, col: 1, input: '=A1', preserveAsText: true },
        { row: 0, col: 2, input: '42' },
      ]
    }

    await backend.importCellChunks?.({
      kind: 'import-cell-chunks',
      sheetId: 'sheet-1',
      chunks: chunks(),
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 2 },
    })

    const projection = await backend.readRangeProjection({
      kind: 'range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 2 },
      requestId: 1,
      reason: 'test',
    })

    const byCol = new Map<number, (typeof projection.cells)[number]>()
    for (const cell of projection.cells) byCol.set(cell.col, cell)

    expect(byCol.get(0)?.displayValue).toBe('00123')
    expect(byCol.get(0)?.valueKind).toBe('string')
    expect(byCol.get(0)?.formula).toBeUndefined()

    expect(byCol.get(1)?.displayValue).toBe('=A1')
    expect(byCol.get(1)?.valueKind).toBe('string')
    expect(byCol.get(1)?.formula).toBeUndefined()

    expect(byCol.get(2)?.valueKind).toBe('number')
  })

  it('static backend without preserveAsText still infers formulas and numbers', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })

    await backend.importCells?.({
      kind: 'import-cells',
      sheetId: 'sheet-1',
      cells: [
        { row: 1, col: 0, input: '=SUM(A1:B1)' },
        { row: 1, col: 1, input: '00123' },
      ],
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    const projection = await backend.readRangeProjection({
      kind: 'range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 1 },
      requestId: 1,
      reason: 'test',
    })

    const byCol = new Map<number, (typeof projection.cells)[number]>()
    for (const cell of projection.cells) byCol.set(cell.col, cell)
    expect(byCol.get(0)?.formula).toBe('=SUM(A1:B1)')
    expect(byCol.get(1)?.valueKind).toBe('number')
  })

  it('worker backend emits kind:text wire entries for preserveAsText, regardless of numeric/formula shape', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 1,
    })

    await backend.ready()
    await backend.importCellChunks?.({
      kind: 'import-cell-chunks',
      sheetId: 'sheet-1',
      cellsPerChunk: 8,
      chunks: [
        [
          { row: 0, col: 0, input: '00123', preserveAsText: true },
          { row: 0, col: 1, input: '=A1', preserveAsText: true },
          { row: 0, col: 2, input: '42' },
          { row: 0, col: 3, input: '', preserveAsText: true },
        ],
      ],
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 3 },
    })

    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [
          { sheet: 0, row: 0, col: 0, kind: 'text', value: '00123' },
          { sheet: 0, row: 0, col: 1, kind: 'text', value: '=A1' },
          { sheet: 0, row: 0, col: 2, kind: 'number', value: 42 },
          { sheet: 0, row: 0, col: 3, kind: 'null' },
        ],
      },
    ])

    backend.dispose()
  })

  it('worker backend without preserveAsText routes formulas through kind:formula', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 1,
    })

    await backend.ready()
    await backend.importCellChunks?.({
      kind: 'import-cell-chunks',
      sheetId: 'sheet-1',
      cellsPerChunk: 4,
      chunks: [[{ row: 0, col: 0, input: '=SUM(A1:B1)' }]],
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    expect(client.calls.importChunk).toEqual([
      {
        sessionId: 1,
        cells: [{ sheet: 0, row: 0, col: 0, kind: 'formula', value: '=SUM(A1:B1)' }],
      },
    ])

    backend.dispose()
  })

  it('worker backend removeRows: empty rows array is a no-op (no RPC, no revision bump)', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 7,
    })
    await backend.ready()

    const result = await backend.removeRows!({
      kind: 'remove-rows',
      sheetId: 'sheet-1',
      rows: [],
    })

    expect(result.removedRows).toBe(0)
    // Revision stays at 7 — empty input must NOT bump.
    expect(result.revision).toBe(7)
    expect(client.calls.deleteRows).toEqual([])
    expect(result.affectedRange).toBeUndefined()

    backend.dispose()
  })

  it('worker backend removeRows: deletes unique sorted rows descending and reports affectedRange', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 1,
    })
    await backend.ready()

    const result = await backend.removeRows!({
      kind: 'remove-rows',
      sheetId: 'sheet-1',
      rows: [3, 1, 1, 7], // duplicates + unsorted
    })

    expect(client.calls.deleteRows.map((c) => c.rowIndex)).toEqual([7, 3, 1])
    expect(result.removedRows).toBe(3)
    expect(result.affectedRange).toEqual({
      startRow: 1,
      endRow: 7,
      startCol: 0,
      endCol: Number.MAX_SAFE_INTEGER,
    })

    backend.dispose()
  })

  it('worker backend removeRows: mid-loop deleteRows rejection throws with partial removedRows', async () => {
    // Regression for HIGH #5 — when client.deleteRows fails partway
    // through, we must NOT silently swallow the failure. The first
    // delete IS committed; the caller receives an Error carrying the
    // partial-success count so it can record an accurate history
    // entry and surface the failure.
    const client = createFakeWorkerWorkbookClient()
    let attemptCount = 0
    const attempts: number[] = []
    const original = client.deleteRows
    client.deleteRows = async (sheet, rowIndex, count) => {
      attemptCount += 1
      attempts.push(rowIndex)
      if (attemptCount === 2) {
        throw new Error('worker rejected delete #2')
      }
      return original(sheet, rowIndex, count)
    }

    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 5,
    })
    await backend.ready()

    let thrown: (Error & { removedRows?: number; partial?: boolean }) | null = null
    try {
      await backend.removeRows!({
        kind: 'remove-rows',
        sheetId: 'sheet-1',
        rows: [2, 4, 6],
      })
    } catch (err) {
      thrown = err as Error & { removedRows?: number; partial?: boolean }
    }
    expect(thrown).not.toBeNull()
    expect(thrown?.partial).toBe(true)
    // First descending delete (row 6) succeeded; the second (row 4) threw.
    expect(thrown?.removedRows).toBe(1)
    // Both attempts went out to the client, but only the first committed
    // (the rejecting one isn't recorded by the fake).
    expect(attempts).toEqual([6, 4])
    expect(client.calls.deleteRows.map((c) => c.rowIndex)).toEqual([6])

    backend.dispose()
  })
})
