import { describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
  dispatchRemoveDuplicatesIntentAtom,
  historyStackAtom,
  openRemoveDuplicatesFromSelectionAtom,
  removeDuplicatesLifecycleAtom,
  removeDuplicatesPreviewAtom,
  removeDuplicatesSessionAtom,
  runRemoveDuplicatesConfirmAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  type RemoveDuplicatesControllerPort,
  type RemoveRowsExactRequest,
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
  createStaticNamedRangeCapabilityPort,
  createStaticSpreadsheetBackend,
  createWorkerNamedRangeCapabilityPort,
  createWorkerWorkbookSpreadsheetBackend,
  matrixToDisplayCells,
  matrixToVisibleProjectionResult,
  sparseCellsToDisplayCells,
  sparseCellsToRangeProjectionResult,
} from '../src-vnext/adapter'

type FakeWorkerWorkbookClient = WorkerWorkbookClient & {
  calls: {
    initWorkbook: string[][]
    listNonEmpty: number
    readCells: CellRefWire[][]
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
    listNonEmpty: 0,
    readCells: [],
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
    async sortRange() {
      throw new Error('not used')
    },
    async setEvalHiddenRows() {
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
      const sessionId = typeof sessionIdOrOptions === 'number' ? sessionIdOrOptions : nextImportId++
      const importOptions = typeof sessionIdOrOptions === 'number' ? options : sessionIdOrOptions
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
    async readCells(refs) {
      calls.readCells.push(refs.map((ref) => ({ ...ref })))
      return refs.map(
        (ref) =>
          cells.get(key(ref.sheet, ref.addr)) ?? {
            sheet: ref.sheet,
            addr: ref.addr.toUpperCase(),
            display: '',
            type: 'null' as const,
            isError: false,
            formula: '',
          },
      )
    },
    async listNonEmpty() {
      calls.listNonEmpty += 1
      return [...cells.values()].map((cell) => ({ sheet: cell.sheet, addr: cell.addr }))
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
  it('publishes named-range capability facts through explicit runtime ports', async () => {
    const staticCapabilities =
      await createStaticNamedRangeCapabilityPort().readNamedRangeCapabilities()
    const workerTsCapabilities =
      await createWorkerNamedRangeCapabilityPort('worker-ts').readNamedRangeCapabilities()
    const workerWasmCapabilities =
      await createWorkerNamedRangeCapabilityPort('worker-wasm').readNamedRangeCapabilities()

    expect(staticCapabilities).toMatchObject({
      runtime: 'static-session',
      scopes: ['workbook', 'sheet'],
      bindings: { range: true, constant: true, lambda: true },
      delete: true,
      listAuthority: 'static-session-registry',
      mutationAck: 'session-registry-accepted',
    })
    expect(workerTsCapabilities).toMatchObject({
      runtime: 'worker-ts',
      scopes: ['workbook'],
      bindings: { range: true, constant: true, lambda: true },
      delete: true,
      listAuthority: 'adapter-post-ack-overlay',
      mutationAck: 'engine-accepted',
    })
    expect(workerWasmCapabilities).toMatchObject({
      runtime: 'worker-wasm',
      scopes: [],
      bindings: { range: false, constant: false, lambda: false },
      delete: false,
      rangeSemantics: 'unsupported',
    })
  })

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
      matrix: [
        ['Region', 'Q1'],
        ['North', 120],
      ],
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

  it('physically reorders the static backend through the sortRange port (sort directives are inert)', async () => {
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

    // Physical sort (#29) is now the sole sort authority for the static backend.
    // A stray display-permutation sort directive is INERT — it must NOT reorder
    // the projection (filter visibility, tested separately, is unaffected).
    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [],
    })
    const beforeSort = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 24,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )
    expect(
      beforeSort.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue),
    ).toEqual(['Region', 'North', 'South', 'East', 'West'])
    expect(
      beforeSort.cells.find((cell) => cell.row === 1 && cell.col === 0)?.originalRow,
    ).toBeUndefined()

    // Physically sort the data region (rows 1..4, header row 0 excluded) by Q1
    // descending — this moves engine data, not a display permutation.
    const result = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 1 },
      keys: [{ col: 1, direction: 'desc' }],
      requestId: 25,
    })
    expect(result.applied).toBe(true)
    if (result.applied) {
      expect(result.movedRows).toBeGreaterThan(0)
      expect(result.affectedRange).toEqual({ rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 1 })
    }

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 26,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )
    // Data physically moved: Q1 desc → East(200), West(140), North(120), South(80).
    expect(
      projected.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue),
    ).toEqual(['Region', 'East', 'West', 'North', 'South'])
    // A physical move never stamps originalRow (that is a display-permutation fact).
    expect(
      projected.cells.find((cell) => cell.row === 1 && cell.col === 0)?.originalRow,
    ).toBeUndefined()
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
    })

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 26,
        window: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 },
      }),
    )

    expect(
      projected.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue),
    ).toEqual(['Region', 'North'])
    expect(projected.cells.some((cell) => cell.displayValue === 'South')).toBe(false)
    expect(projected.cells.some((cell) => cell.displayValue === 'East')).toBe(false)
  })

  // Companion to the case above, which passed under BOTH semantics by luck: its
  // one surviving data row sits at source row 1, and compaction also puts the
  // first survivor at display row 1. Keeping a survivor further down is what
  // actually distinguishes hiding from compacting.
  it('keeps surviving static rows at their own index instead of compacting them up', async () => {
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
      rules: [{ kind: 'equals', colIndex: 1, value: '200' }],
    })

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 27,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      }),
    )

    const east = projected.cells.find((cell) => cell.displayValue === 'East')
    // Source row 3 stays at row 3. Compaction would have reported row 1.
    expect(east?.row).toBe(3)
    expect(east?.originalRow).toBeUndefined()
    // Rows 1, 2 and 4 are withheld outright, not blanked.
    expect(projected.cells.map((cell) => cell.row).sort()).toEqual([0, 0, 3, 3])
  })

  // Blind spot: filter x merge had no static coverage at all, on either side of
  // the flip. The suppression being lifted here is silent otherwise.
  it('keeps merge metadata under an active static filter', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['Region', 'Q1'],
        ['North', 120],
        ['South', 80],
        ['East', 200],
      ],
    })
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
    })

    const before = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 28,
        window: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 },
      }),
    )
    expect(before.cells.find((cell) => cell.row === 0 && cell.col === 0)?.mergedSpan).toEqual({
      rows: 1,
      cols: 2,
    })

    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 1, value: '120' }],
    })

    const during = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 29,
        window: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 },
      }),
    )
    // Merges used to be suppressed WHOLESALE while a filter was active, because
    // a span drawn across a permuted row space was a lie. Identity mapping
    // removes the permutation, so the span survives and stays truthful.
    expect(during.cells.find((cell) => cell.row === 0 && cell.col === 0)?.mergedSpan).toEqual({
      rows: 1,
      cols: 2,
    })
  })

  it('applies worker filter visibility by withholding rows, not permuting them', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 7,
    })
    await backend.ready()

    const seedCells = [
      ['A1', 'Region', 'text'],
      ['B1', 'Q1', 'text'],
      ['A2', 'North', 'text'],
      ['B2', '120', 'number'],
      ['A3', 'South', 'text'],
      ['B3', '80', 'number'],
      ['A4', 'East', 'text'],
      ['B4', '200', 'number'],
    ]
    seedCells.forEach(([addr, display, type]) => {
      client.putCell({
        sheet: 0,
        addr,
        display,
        type: type as CellSnapshotWire['type'],
        isError: false,
        formula: '',
      })
    })

    expect(typeof backend.setFilterSort).toBe('function')
    // Filter VISIBILITY only. Sorting is never a `setFilterSort` payload any
    // more (#24 retired the display-permutation sort branch).
    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 1, value: '120' }],
      requestId: 100,
    })
    expect(ack).toMatchObject({
      sheetId: 'sheet-1',
      requestId: 100,
      revision: 8,
      // Source rows 2 and 3 (South, East) fail the rule.
      hiddenRowIndices: [2, 3],
    })
    // The predicate scan is column-bounded: one single-column read per
    // predicate column (col 0 summary probe + the filter-rule column).
    expect(client.calls.readSparseRange).toEqual([
      { sheet: 0, startRow: 0, endRow: 3, startCol: 0, endCol: 0 },
      { sheet: 0, startRow: 0, endRow: 3, startCol: 1, endCol: 1 },
    ])

    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 101,
        window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
      }),
    )

    // The window read is a plain rectangular range read again. The compacted
    // path had to fetch a bounding box cell-by-cell (`readCells`) because its
    // surviving source rows were scattered; hiding rows removes that need.
    expect(client.calls.readCells).toHaveLength(0)
    expect(projected.revision).toBe(8)
    // Filtered-out rows are withheld and survivors keep their own index. No
    // `originalRow`: display row IS source row.
    expect(
      projected.cells
        .filter((cell) => cell.col === 0)
        .map((cell) => [cell.displayValue, cell.row, cell.originalRow]),
    ).toEqual([
      ['Region', 0, undefined],
      ['North', 1, undefined],
    ])
    // Engine data untouched — no writes were issued.
    expect(client.calls.setCell).toHaveLength(0)

    backend.dispose()
  })

  it('persists named range mutations in the static backend', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1 })
    expect(backend.setNamedRange).toBeDefined()
    expect(backend.deleteNamedRange).toBeDefined()
    expect(backend.listNamedRanges).toBeDefined()

    const setResult = await backend.setNamedRange?.({
      kind: 'set-named-range',
      name: 'SalesTotal',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
      requestId: 41,
    })
    expect(setResult).toMatchObject({
      requestId: 41,
      revision: 2,
      outcome: 'w0-acknowledged',
      authority: 'static-session-registry',
    })

    const listed = await backend.listNamedRanges?.({ kind: 'list-named-ranges' })
    expect(listed).toMatchObject({
      revision: 2,
      authority: 'static-session-registry',
      definitionReadback: 'full',
    })
    expect(listed?.names).toEqual([
      {
        name: 'SalesTotal',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
      },
    ])

    const missingDelete = await backend.deleteNamedRange?.({
      kind: 'delete-named-range',
      name: 'Missing',
      scope: 'workbook',
      requestId: 42,
    })
    expect(missingDelete).toMatchObject({
      requestId: 42,
      revision: 2,
      outcome: 'confirmed-not-applied',
      authority: 'static-session-registry',
    })

    const deleteResult = await backend.deleteNamedRange?.({
      kind: 'delete-named-range',
      name: 'salestotal',
      scope: 'workbook',
      requestId: 43,
    })
    expect(deleteResult).toMatchObject({
      requestId: 43,
      revision: 3,
      outcome: 'w0-acknowledged',
      authority: 'static-session-registry',
    })
    const afterDelete = await backend.listNamedRanges?.({ kind: 'list-named-ranges' })
    expect(afterDelete?.names).toEqual([])
  })

  it('publishes worker named ranges only after an engine ACK', async () => {
    const baseClient = createFakeWorkerWorkbookClient()
    let resolveDefine!: (accepted: boolean) => void
    let signalDefineStarted!: () => void
    let binding: Parameters<WorkerWorkbookClient['defineName']>[1] | undefined
    const defineStarted = new Promise<void>((resolve) => {
      signalDefineStarted = resolve
    })
    const client: WorkerWorkbookClient = {
      ...baseClient,
      defineName(_name, nextBinding) {
        binding = nextBinding
        signalDefineStarted()
        return new Promise<boolean>((resolve) => {
          resolveDefine = resolve
        })
      },
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 7,
    })
    await backend.ready()

    const pending = backend.setNamedRange!({
      kind: 'set-named-range',
      name: 'Q1Sales',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:B4' },
      requestId: 51,
    })
    await defineStarted

    expect(binding).toEqual({
      kind: 'range',
      sheetName: 'Sheet1',
      start: 'B2',
      end: 'B4',
    })
    expect((await backend.listNamedRanges!({ kind: 'list-named-ranges' })).names).toEqual([])

    resolveDefine(true)
    await expect(pending).resolves.toMatchObject({
      requestId: 51,
      revision: 8,
      outcome: 'w0-acknowledged',
      authority: 'worker-engine-ack',
      canonical: false,
    })
    await expect(backend.listNamedRanges!({ kind: 'list-named-ranges' })).resolves.toMatchObject({
      authority: 'adapter-post-ack-overlay',
      definitionReadback: 'full',
      canonical: false,
      names: [
        {
          name: 'Q1Sales',
          scope: 'workbook',
          refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:B4' },
        },
      ],
    })

    backend.dispose()
  })

  it('does not publish worker named-range mutations rejected by the engine', async () => {
    const baseClient = createFakeWorkerWorkbookClient()
    let defineAccepted = false
    const client: WorkerWorkbookClient = {
      ...baseClient,
      async defineName() {
        return defineAccepted
      },
      async undefineName() {
        return false
      },
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 3,
    })
    await backend.ready()

    const request = {
      kind: 'set-named-range' as const,
      name: 'EngineOwned',
      scope: 'workbook' as const,
      refersTo: { kind: 'constant' as const, value: '42' },
      requestId: 61,
    }
    await expect(backend.setNamedRange!(request)).resolves.toMatchObject({
      requestId: 61,
      revision: 3,
      outcome: 'confirmed-not-applied',
      authority: 'worker-engine-ack',
    })
    expect((await backend.listNamedRanges!({ kind: 'list-named-ranges' })).names).toEqual([])

    defineAccepted = true
    await expect(backend.setNamedRange!({ ...request, requestId: 62 })).resolves.toMatchObject({
      requestId: 62,
      revision: 4,
      outcome: 'w0-acknowledged',
    })
    await expect(
      backend.deleteNamedRange!({
        kind: 'delete-named-range',
        name: 'engineowned',
        scope: 'workbook',
        requestId: 63,
      }),
    ).resolves.toMatchObject({
      requestId: 63,
      revision: 4,
      outcome: 'confirmed-not-applied',
    })
    expect((await backend.listNamedRanges!({ kind: 'list-named-ranges' })).names).toHaveLength(1)

    backend.dispose()
  })

  it('drops a late worker named-range ACK after backend disposal', async () => {
    const baseClient = createFakeWorkerWorkbookClient()
    let resolveDefine!: (accepted: boolean) => void
    let signalDefineStarted!: () => void
    const defineStarted = new Promise<void>((resolve) => {
      signalDefineStarted = resolve
    })
    const client: WorkerWorkbookClient = {
      ...baseClient,
      defineName() {
        signalDefineStarted()
        return new Promise<boolean>((resolve) => {
          resolveDefine = resolve
        })
      },
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })
    await backend.ready()

    const pending = backend.setNamedRange!({
      kind: 'set-named-range',
      name: 'LateName',
      scope: 'workbook',
      refersTo: { kind: 'constant', value: '1' },
      requestId: 71,
    })
    await defineStarted
    backend.dispose()
    resolveDefine(true)

    await expect(pending).rejects.toMatchObject({ code: 'BACKEND_DISPOSED' })
    expect((await backend.listNamedRanges!({ kind: 'list-named-ranges' })).names).toEqual([])
  })

  it('does not advertise protection ports without a real worker-engine contract', () => {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client: createFakeWorkerWorkbookClient(),
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })

    expect(backend.setSheetProtection).toBeUndefined()
    expect(backend.setRangeLock).toBeUndefined()
    expect(backend.readSheetProtection).toBeUndefined()
    backend.dispose()
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

  it('returns exact static merge acknowledgements and projects merge metadata', async () => {
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
      requestId: 23,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    expect(mutation).toEqual({
      kind: 'merge-range',
      sheetId: 'sheet-1',
      requestId: 23,
      revision: 2,
      affectedRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    const merged = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 24,
        window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      }),
    )

    expect(merged.cells).toEqual(
      expect.arrayContaining([
        {
          row: 0,
          col: 0,
          displayValue: 'A1',
          valueKind: 'string',
          mergedSpan: { rows: 2, cols: 2 },
        },
        {
          row: 0,
          col: 1,
          displayValue: 'B1',
          valueKind: 'string',
          mergeAnchor: { row: 0, col: 0 },
        },
        {
          row: 1,
          col: 0,
          displayValue: 'A2',
          valueKind: 'string',
          mergeAnchor: { row: 0, col: 0 },
        },
        {
          row: 1,
          col: 1,
          displayValue: 'B2',
          valueKind: 'string',
          mergeAnchor: { row: 0, col: 0 },
        },
      ]),
    )

    const unmergeMutation = await backend.unmergeRange?.({
      kind: 'unmerge-range',
      sheetId: 'sheet-1',
      requestId: 25,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    expect(unmergeMutation).toEqual({
      kind: 'unmerge-range',
      sheetId: 'sheet-1',
      requestId: 25,
      revision: 3,
      affectedRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    const unmerged = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 26,
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

  it('shifts repeated source formulas per target through static fill projection readback', async () => {
    const sourceFormula = '=B1+$C1+D$1+$E$1+"A1"'
    const backend = createStaticSpreadsheetBackend({
      revision: 12,
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: sourceFormula,
          valueKind: 'string',
          formula: sourceFormula,
          format: { bold: true },
        },
        {
          row: 1,
          col: 0,
          displayValue: 'plain',
          valueKind: 'string',
          format: { italic: true },
        },
      ],
    })

    await backend.fillRange?.({
      kind: 'fill-range',
      sheetId: 'sheet-1',
      requestId: 21,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 0 },
      direction: 'down',
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 22,
        range: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 0 },
        reason: 'test',
      }),
    )

    expect(
      result.cells.map((cell) => ({
        row: cell.row,
        input: cell.formula ?? cell.displayValue,
        format: cell.format,
      })),
    ).toEqual([
      { row: 0, input: sourceFormula, format: { bold: true } },
      { row: 1, input: 'plain', format: { italic: true } },
      {
        row: 2,
        input: '=B3+$C3+D$1+$E$1+"A1"',
        format: { bold: true },
      },
      { row: 3, input: 'plain', format: { italic: true } },
      {
        row: 4,
        input: '=B5+$C5+D$1+$E$1+"A1"',
        format: { bold: true },
      },
      { row: 5, input: 'plain', format: { italic: true } },
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
      hiddenRowIndices: [],
      hiddenColIndices: [],
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
      hiddenRowIndices: [],
      hiddenColIndices: [],
    })
  })

  it('stores canonical hidden indices per sheet and projects only the requested viewport window', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 10,
      matrix: [['A1']],
      sheets: ['Sheet1', 'Sheet2'],
    })

    await expect(
      backend.hideRows!({
        kind: 'hide-rows',
        sheetId: 'sheet-1',
        requestId: 40,
        revision: 10,
        rowIndices: [5, 2, 2, 0],
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 40, revision: 11 })
    await expect(
      backend.hideColumns!({
        kind: 'hide-columns',
        sheetId: 'sheet-1',
        requestId: 41,
        revision: 11,
        colIndices: [4, 1, 1],
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 41, revision: 12 })

    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        requestId: 42,
        revision: 12,
        window: { rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 2 },
      }),
    ).resolves.toEqual({
      kind: 'viewport-size',
      sheetId: 'sheet-1',
      requestId: 42,
      revision: 12,
      window: { rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 2 },
      rowHeights: [],
      colWidths: [],
      hiddenRowIndices: [2],
      hiddenColIndices: [1],
    })
    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-2',
        requestId: 43,
        window: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 10 },
      }),
    ).resolves.toMatchObject({
      sheetId: 'sheet-2',
      revision: 12,
      hiddenRowIndices: [],
      hiddenColIndices: [],
    })

    await expect(
      backend.unhideRows!({
        kind: 'unhide-rows',
        sheetId: 'sheet-1',
        requestId: 44,
        revision: 12,
        rowIndices: [5, 2, 2],
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 44, revision: 13 })
    await expect(
      backend.unhideColumns!({
        kind: 'unhide-columns',
        sheetId: 'sheet-1',
        requestId: 45,
        revision: 13,
        colIndices: [4, 1, 4],
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 45, revision: 14 })

    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 10 },
      }),
    ).resolves.toMatchObject({
      revision: 14,
      hiddenRowIndices: [0],
      hiddenColIndices: [],
    })
  })

  it('rejects an old mutation ACK revision before returning newer viewport-size facts', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 20, matrix: [['A1']] })
    const hiddenRowsAck = await backend.hideRows!({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      requestId: 46,
      revision: 20,
      rowIndices: [2],
    })
    const hiddenColumnsAck = await backend.hideColumns!({
      kind: 'hide-columns',
      sheetId: 'sheet-1',
      requestId: 47,
      revision: hiddenRowsAck.revision,
      colIndices: [3],
    })

    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        requestId: 48,
        revision: hiddenRowsAck.revision,
        window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
      }),
    ).rejects.toThrow('viewport size revision conflict')
    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        requestId: 49,
        revision: hiddenColumnsAck.revision,
        window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
      }),
    ).resolves.toMatchObject({
      requestId: 49,
      revision: hiddenColumnsAck.revision,
      hiddenRowIndices: [2],
      hiddenColIndices: [3],
    })
  })

  it('rejects malformed and stale hidden-index mutations before state, revision, or history changes', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 7, matrix: [['A1']] })

    await expect(
      backend.hideRows!({
        kind: 'hide-rows',
        sheetId: 'sheet-1',
        rowIndices: [3, -1],
        revision: 7,
      }),
    ).rejects.toThrow('indices must be non-negative safe integers')
    await expect(
      backend.hideColumns!({
        kind: 'hide-columns',
        sheetId: 'sheet-1',
        colIndices: [4],
        revision: 6,
      }),
    ).rejects.toThrow('revision conflict')
    await expect(
      backend.hideRows!({
        kind: 'hide-rows',
        sheetId: 'missing-sheet',
        rowIndices: [1],
        revision: 7,
      }),
    ).rejects.toThrow('unknown sheet')

    await expect(
      backend.unhideRows!({
        kind: 'unhide-rows',
        sheetId: 'sheet-1',
        requestId: 46,
        rowIndices: [3, 3],
        revision: 7,
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 46, revision: 7 })
    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 10 },
      }),
    ).resolves.toMatchObject({
      revision: 7,
      hiddenRowIndices: [],
      hiddenColIndices: [],
    })
    await expect(
      backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'hidden-noop' }),
    ).rejects.toThrow('nothing to undo')
  })

  it('preflights an unadvanceable hidden-index revision while preserving exact no-op acknowledgements', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 'opaque-v1', matrix: [['A1']] })

    await expect(
      backend.unhideColumns!({
        kind: 'unhide-columns',
        sheetId: 'sheet-1',
        requestId: 47,
        revision: 'opaque-v1',
        colIndices: [],
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 47, revision: 'opaque-v1' })
    await expect(
      backend.hideColumns!({
        kind: 'hide-columns',
        sheetId: 'sheet-1',
        requestId: 48,
        revision: 'opaque-v1',
        colIndices: [1],
      }),
    ).rejects.toThrow('cannot advance projection revision')
    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
      }),
    ).resolves.toMatchObject({ revision: 'opaque-v1', hiddenColIndices: [] })
    await expect(
      backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'hidden-opaque' }),
    ).rejects.toThrow('nothing to undo')
  })

  it('returns an exact static format acknowledgement and projects the requested window', async () => {
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

    expect(mutation).toEqual({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: 14,
      revision: 1,
      affectedRange: {
        rowStart: 1,
        rowEnd: 999_999,
        colStart: 1,
        colEnd: 999_999,
      },
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

  it('projects canonical raw numbers before static literal and formula display formatting', async () => {
    const backend = createStaticSpreadsheetBackend({
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: '1,234.50',
          valueKind: 'number',
          numericValue: 1_234.5,
        },
        {
          row: 0,
          col: 1,
          displayValue: '=A1*2',
          valueKind: 'string',
          numericValue: 999,
          formula: '=A1*2',
        },
        {
          row: 0,
          col: 2,
          displayValue: '1234.5',
          valueKind: 'string',
          numericValue: 999,
        },
        { row: 0, col: 3, displayValue: '7.5', valueKind: 'number' },
        {
          row: 0,
          col: 4,
          displayValue: '=CONCAT("raw"," text")',
          valueKind: 'number',
          numericValue: 999,
          formula: '=CONCAT("raw"," text")',
        },
      ],
    })
    await backend.setFormatRange?.({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      format: { numberFormat: { kind: 'custom', pattern: '#,##0.00" kg"' } },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 43,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 4 },
      }),
    )

    expect(result.cells).toEqual([
      {
        row: 0,
        col: 0,
        displayValue: '1,234.50 kg',
        valueKind: 'number',
        numericValue: 1_234.5,
        format: { numberFormat: { kind: 'custom', pattern: '#,##0.00" kg"' } },
      },
      {
        row: 0,
        col: 1,
        displayValue: '2,469.00 kg',
        valueKind: 'number',
        numericValue: 2_469,
        formula: '=A1*2',
        format: { numberFormat: { kind: 'custom', pattern: '#,##0.00" kg"' } },
      },
      { row: 0, col: 2, displayValue: '1234.5', valueKind: 'string' },
      { row: 0, col: 3, displayValue: '7.5', valueKind: 'number', numericValue: 7.5 },
      {
        row: 0,
        col: 4,
        displayValue: 'raw text',
        valueKind: 'string',
        formula: '=CONCAT("raw"," text")',
      },
    ])
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
      addr: 'A1',
      display: '1234.5',
      type: 'text',
      isError: false,
      formula: '',
    })
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
        row: 0,
        col: 0,
        displayValue: '1234.5',
        valueKind: 'string',
      },
      {
        row: 1,
        col: 1,
        displayValue: '42',
        valueKind: 'number',
        numericValue: 42,
        formula: '=Sheet1!A1+1',
      },
    ])

    backend.dispose()
  })

  it('applies custom number formats from worker format snapshots', async () => {
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
      display: '1234.5',
      type: 'number',
      isError: false,
      formula: '',
    })
    await client.setFormatRange(
      { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { numberFormat: { kind: 'custom', pattern: '#,##0.00" kg"' } },
    )

    const result = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 13,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    expect(result.cells).toEqual([
      {
        row: 0,
        col: 0,
        displayValue: '1,234.50 kg',
        valueKind: 'number',
        numericValue: 1_234.5,
        format: { numberFormat: { kind: 'custom', pattern: '#,##0.00" kg"' } },
      },
    ])

    backend.dispose()
  })

  it('returns the strict toolbar acknowledgement kind for worker number formats', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 5,
    })

    await backend.ready()
    const mutation = await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: 14,
      range: { rowStart: 3, rowEnd: 3, colStart: 1, colEnd: 1 },
      format: { numberFormat: { kind: 'decimal', digits: 2, thousands: true } },
    })

    expect(client.calls.setFormatRange).toEqual([
      {
        sheet: 0,
        startRow: 3,
        startCol: 1,
        endRow: 3,
        endCol: 1,
        fmt: { numberFormat: { kind: 'decimal', digits: 2, thousands: true } },
      },
    ])
    expect(mutation).toEqual({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: 14,
      revision: 6,
      affectedRange: { rowStart: 3, rowEnd: 3, colStart: 1, colEnd: 1 },
    })

    backend.dispose()
  })

  it('applies supported worker backend toolbar overlays instead of silently no-oping', async () => {
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

    expect(
      projected.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue),
    ).toEqual(['Region', 'North', 'South', 'East', 'Total'])
    expect(
      projected.cells.find((cell) => cell.row === 1 && cell.col === 1)?.validation,
    ).toMatchObject({
      code: 'validation.list',
      severity: 'warning',
    })
    expect(
      projected.cells.find((cell) => cell.row === 1 && cell.col === 1)?.conditionalFormat,
    ).toMatchObject({
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
      // Host-orchestrated undo: before/after images around the mutation.
      { sheet: 0, startRow: 1, startCol: 1, endRow: 999_999, endCol: 999_999 },
      { sheet: 0, startRow: 1, startCol: 1, endRow: 999_999, endCol: 999_999 },
      // Projection read.
      { sheet: 0, startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
    ])
    expect(mutation).toEqual({
      kind: 'set-format-range',
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
      // W3 structural-shift contract: the worker engine really shifted
      // index space, so the ACK declares the displacement for UI-core's
      // view-fact remap (freeze band, hidden sets) and history side
      // payloads.
      structuralShift: { axis: 'row', kind: 'insert', index: 1, count: 1 },
    })
    expect(colMutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 21,
      revision: 12,
      structuralShift: { axis: 'column', kind: 'delete', index: 1, count: 1 },
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

  it('defers reorder dirty observers until stable sheet ids use refreshed worker indices', async () => {
    const client = createFakeWorkerWorkbookClient()
    const moveSheet = client.moveSheet.bind(client)
    client.moveSheet = async (from, to) => {
      const moved = await moveSheet(from, to)
      client.emitDirty([{ sheet: to, addr: 'C2' }])
      return moved
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
        { id: 'sheet-3', name: 'Sheet3' },
      ],
      revision: 20,
    })
    await backend.ready()
    ;[13, 12, 11].forEach((value, sheet) => {
      client.putCell({
        sheet,
        addr: 'C2',
        display: String(value),
        type: 'number',
        isError: false,
        formula: '',
      })
    })

    const observerReads: Array<Promise<string | undefined>> = []
    const unsubscribe = backend.subscribeContentChanges?.(() => {
      observerReads.push(
        backend
          .readRangeProjection(
            createRangeProjectionRequest({
              sheetId: 'sheet-1',
              requestId: 91,
              reason: 'test',
              range: { rowStart: 1, rowEnd: 1, colStart: 2, colEnd: 2 },
            }),
          )
          .then((projection) => projection.cells[0]?.displayValue),
      )
    })

    const result = await backend.reorderSheet?.({
      kind: 'reorder-sheet',
      sheetId: 'sheet-3',
      beforeSheetId: 'sheet-1',
      requestId: 90,
    })

    expect(result?.sheets?.map((sheet) => sheet.id)).toEqual(['sheet-3', 'sheet-1', 'sheet-2'])
    await expect(Promise.all(observerReads)).resolves.toEqual(['13'])
    expect(client.calls.readSparseRange.at(-1)?.sheet).toBe(1)

    unsubscribe?.()
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

    expect(sheet1.cells).toEqual([{ row: 0, col: 0, displayValue: 'keep-me', valueKind: 'string' }])
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
      cells: [{ row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: { bold: true } }],
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

  it('worker backend does not advertise exact row removal unless the host opts in', () => {
    const defaultBackend = createWorkerWorkbookSpreadsheetBackend({
      client: createFakeWorkerWorkbookClient(),
      sheets: ['Sheet1'],
    })
    const disabledBackend = createWorkerWorkbookSpreadsheetBackend({
      client: createFakeWorkerWorkbookClient(),
      sheets: ['Sheet1'],
      removeRowsExactCapability: false,
    })

    expect(defaultBackend.removeRowsExact).toBeUndefined()
    expect(disabledBackend.removeRowsExact).toBeUndefined()

    defaultBackend.dispose()
    disabledBackend.dispose()
  })

  it('worker backend exact row removal returns a new-revision witness only after every band ACKs', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 7,
      removeRowsExactCapability: 'worker-engine-delete-rows',
    })
    await backend.ready()

    const result = await backend.removeRowsExact!({
      kind: 'remove-rows',
      requestId: 81,
      sheetId: 'sheet-1',
      targetRange: { rowStart: 0, rowEnd: 8, colStart: 3, colEnd: 4 },
      rows: [2, 3, 6],
      revision: 7,
    })

    expect(client.calls.deleteRows).toEqual([
      { sheet: 0, rowIndex: 6, count: 1 },
      { sheet: 0, rowIndex: 2, count: 2 },
    ])
    expect(result).toEqual({
      requestId: 81,
      sheetId: 'sheet-1',
      targetRange: { rowStart: 0, rowEnd: 8, colStart: 3, colEnd: 4 },
      removedRowIndices: [2, 3, 6],
      removedRows: 3,
      affectedRange: { startRow: 2, endRow: 8, startCol: 3, endCol: 4 },
      revision: 8,
    })

    backend.dispose()
  })

  it('worker backend exact row removal rejects partial transport without returning an exact ACK', async () => {
    const client = createFakeWorkerWorkbookClient()
    let attemptCount = 0
    const original = client.deleteRows
    client.deleteRows = async (sheet, rowIndex, count) => {
      attemptCount += 1
      if (attemptCount === 2) throw new Error('worker rejected second band')
      return original(sheet, rowIndex, count)
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 5,
      removeRowsExactCapability: 'worker-engine-delete-rows',
    })
    await backend.ready()

    await expect(
      backend.removeRowsExact!({
        kind: 'remove-rows',
        requestId: 82,
        sheetId: 'sheet-1',
        targetRange: { rowStart: 0, rowEnd: 8, colStart: 0, colEnd: 2 },
        rows: [2, 4, 6],
        revision: 5,
      }),
    ).rejects.toMatchObject({
      partial: true,
      removedRows: 1,
      revision: 6,
    })
    expect(client.calls.deleteRows).toEqual([{ sheet: 0, rowIndex: 6, count: 1 }])

    backend.dispose()
  })

  it('turns a false Worker delete ACK into Core outcome-unknown without an exact witness', async () => {
    const client = createFakeWorkerWorkbookClient()
    const values = [
      ['Region', 'Score'],
      ['North', '100'],
      ['South', '200'],
      ['North', '300'],
      ['East', '400'],
    ]
    values.forEach((row, rowIndex) => {
      row.forEach((display, colIndex) => {
        client.putCell({
          sheet: 0,
          addr: toCellAddressForTest(rowIndex, colIndex),
          display,
          type: 'text',
          isError: false,
          formula: '',
        })
      })
    })
    client.deleteRows = async (sheet, rowIndex, count) => {
      client.calls.deleteRows.push({ sheet, rowIndex, count })
      return false
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 5,
      removeRowsExactCapability: 'worker-engine-delete-rows',
    })
    await backend.ready()
    let falseAckError: unknown
    const source: RemoveDuplicatesControllerPort = {
      readRangeProjection: (request) => backend.readRangeProjection(request),
      async removeRowsExact(request) {
        try {
          return await backend.removeRowsExact!(request)
        } catch (error) {
          falseAckError = error
          throw error
        }
      },
    }

    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 4, col: 1 },
    })
    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
      'editing',
    )
    store.setter(dispatchRemoveDuplicatesIntentAtom, {
      kind: 'toggle-key-column',
      column: 1,
    })
    expect(store.getter(removeDuplicatesPreviewAtom)?.duplicateRows).toEqual([3])

    const sessionId = store.getter(removeDuplicatesSessionAtom)!.sessionId
    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('outcome-unknown')
    expect(falseAckError).toMatchObject({
      partial: true,
      removedRows: 0,
      cause: { code: 'DELETE_ROWS_NOT_ACCEPTED' },
    })
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(client.calls.deleteRows).toEqual([{ sheet: 0, rowIndex: 3, count: 1 }])

    backend.dispose()
  })

  it('worker backend exact row removal rejects a stale witness before issuing delete RPCs', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 9,
      removeRowsExactCapability: 'worker-engine-delete-rows',
    })
    await backend.ready()

    await expect(
      backend.removeRowsExact!({
        kind: 'remove-rows',
        requestId: 83,
        sheetId: 'sheet-1',
        targetRange: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
        rows: [2],
        revision: 8,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REMOVE_ROWS_EXACT_REQUEST' })
    expect(client.calls.deleteRows).toEqual([])

    backend.dispose()
  })
})

describe('static backend exact row removal', () => {
  function exactRequest(overrides: Partial<RemoveRowsExactRequest> = {}): RemoveRowsExactRequest {
    return {
      kind: 'remove-rows',
      requestId: 91,
      sheetId: 'sheet-1',
      targetRange: { rowStart: 0, rowEnd: 6, colStart: 0, colEnd: 1 },
      rows: [2, 4],
      revision: 7,
      ...overrides,
    }
  }

  async function readRows(
    backend: ReturnType<typeof createStaticSpreadsheetBackend>,
    requestId = 900,
  ) {
    return backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId,
        reason: 'test',
        range: { rowStart: 0, rowEnd: 6, colStart: 0, colEnd: 1 },
      }),
    )
  }

  function undoRequest(transactionId = 'remove-rows-exact') {
    return { kind: 'undo-transaction' as const, transactionId }
  }

  it('advertises the capability, returns an exact ACK, shifts data, and records one undo entry', async () => {
    const originalRows = ['header', 'one', 'drop-two', 'three', 'drop-four', 'five', 'six']
    const backend = createStaticSpreadsheetBackend({
      revision: 7,
      matrix: originalRows.map((value) => [value]),
    })

    expect(typeof backend.removeRowsExact).toBe('function')
    const result = await backend.removeRowsExact(exactRequest())

    expect(result).toEqual({
      requestId: 91,
      sheetId: 'sheet-1',
      targetRange: { rowStart: 0, rowEnd: 6, colStart: 0, colEnd: 1 },
      removedRowIndices: [2, 4],
      removedRows: 2,
      affectedRange: { startRow: 2, endRow: 6, startCol: 0, endCol: 1 },
      revision: 8,
    })
    expect(result.revision).not.toBe(7)

    const removed = await readRows(backend)
    expect(removed.revision).toBe(8)
    expect(removed.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue)).toEqual(
      ['header', 'one', 'three', 'five', 'six'],
    )

    await expect(backend.undoTransaction!(undoRequest())).resolves.toMatchObject({ revision: 9 })
    const restored = await readRows(backend, 901)
    expect(restored.revision).toBe(9)
    expect(
      restored.cells.filter((cell) => cell.col === 0).map((cell) => cell.displayValue),
    ).toEqual(originalRows)
    await expect(
      backend.undoTransaction!(undoRequest('remove-rows-exact-second-undo')),
    ).rejects.toThrow('nothing to undo')
  })

  it('keeps cell formats, range formats, row heights, and hidden rows aligned through remove and undo', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 20,
      cells: [
        { row: 0, col: 0, displayValue: 'header', valueKind: 'string' },
        {
          row: 1,
          col: 0,
          displayValue: 'drop',
          valueKind: 'string',
          format: { bold: true },
        },
        {
          row: 2,
          col: 0,
          displayValue: 'keep',
          valueKind: 'string',
        },
        {
          row: 2,
          col: 1,
          displayValue: 'keep-side',
          valueKind: 'string',
          format: { italic: true },
        },
        { row: 3, col: 0, displayValue: 'tail', valueKind: 'string' },
      ],
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 0 },
      format: { bgColor: '#ffd966' },
    })
    await backend.setRowHeight!({
      kind: 'set-row-height',
      sheetId: 'sheet-1',
      rowIndex: 2,
      heightPx: 37,
    })
    await backend.hideRows!({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      rowIndices: [3],
      revision: 22,
    })

    await expect(
      backend.removeRowsExact(
        exactRequest({
          requestId: 92,
          targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
          rows: [1],
          revision: 23,
        }),
      ),
    ).resolves.toMatchObject({
      requestId: 92,
      sheetId: 'sheet-1',
      removedRowIndices: [1],
      removedRows: 1,
      revision: 24,
    })

    const shifted = await readRows(backend, 902)
    expect(shifted.cells.find((cell) => cell.row === 1 && cell.col === 0)).toMatchObject({
      displayValue: 'keep',
      format: { bgColor: '#ffd966' },
    })
    expect(shifted.cells.find((cell) => cell.row === 1 && cell.col === 1)).toMatchObject({
      displayValue: 'keep-side',
      format: { italic: true },
    })
    expect(shifted.cells.find((cell) => cell.row === 2 && cell.col === 0)).toMatchObject({
      displayValue: 'tail',
      format: { bgColor: '#ffd966' },
    })
    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        requestId: 903,
        window: { rowStart: 0, rowEnd: 6, colStart: 0, colEnd: 1 },
      }),
    ).resolves.toMatchObject({
      revision: 24,
      rowHeights: [{ rowIndex: 1, heightPx: 37 }],
      hiddenRowIndices: [2],
    })

    await backend.undoTransaction!(undoRequest('remove-rows-exact-metadata'))
    const restored = await readRows(backend, 904)
    expect(restored.revision).toBe(25)
    expect(restored.cells.find((cell) => cell.row === 1 && cell.col === 0)).toMatchObject({
      displayValue: 'drop',
      format: { bold: true },
    })
    expect(restored.cells.find((cell) => cell.row === 2 && cell.col === 0)).toMatchObject({
      displayValue: 'keep',
      format: { bgColor: '#ffd966' },
    })
    expect(restored.cells.find((cell) => cell.row === 2 && cell.col === 1)).toMatchObject({
      displayValue: 'keep-side',
      format: { italic: true },
    })
    await expect(
      backend.readViewportSizeProjection!({
        kind: 'viewport-size',
        sheetId: 'sheet-1',
        requestId: 905,
        window: { rowStart: 0, rowEnd: 6, colStart: 0, colEnd: 1 },
      }),
    ).resolves.toMatchObject({
      revision: 25,
      rowHeights: [{ rowIndex: 2, heightPx: 37 }],
      hiddenRowIndices: [3],
    })
  })

  it('drops fully deleted range-format layers, shrinks boundary overlaps, and restores both on undo', async () => {
    const fullyDeletedColor = '#ff0000'
    const boundaryOverlapColor = '#0000ff'
    const backend = createStaticSpreadsheetBackend({ revision: 30, matrix: [] })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      format: { bgColor: fullyDeletedColor },
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 },
      format: { bgColor: boundaryOverlapColor },
    })

    await backend.removeRowsExact(
      exactRequest({
        requestId: 94,
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 },
        rows: [1],
        revision: 32,
      }),
    )

    const shifted = await readRows(backend, 911)
    expect(
      shifted.cells
        .filter((cell) => cell.format?.bgColor === fullyDeletedColor)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([])
    expect(
      shifted.cells
        .filter((cell) => cell.format?.bgColor === boundaryOverlapColor)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([[1, 1]])

    await backend.undoTransaction!(undoRequest('remove-rows-exact-range-formats'))
    const restored = await readRows(backend, 912)
    expect(
      restored.cells
        .filter((cell) => cell.format?.bgColor === fullyDeletedColor)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([[1, 0]])
    expect(
      restored.cells
        .filter((cell) => cell.format?.bgColor === boundaryOverlapColor)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([
      [1, 1],
      [2, 1],
    ])
  })

  it('precisely contracts a range-format layer across a multi-row deletion and undo', async () => {
    const color = '#00aa00'
    const backend = createStaticSpreadsheetBackend({ revision: 40, matrix: [] })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 0 },
      format: { bgColor: color },
    })

    await backend.deleteRows!({
      kind: 'delete-rows',
      sheetId: 'sheet-1',
      rowIndex: 1,
      count: 2,
    })
    const shifted = await readRows(backend, 913)
    expect(
      shifted.cells
        .filter((cell) => cell.format?.bgColor === color)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([[1, 0]])

    await backend.undoTransaction!(undoRequest('delete-rows-range-formats'))
    const restored = await readRows(backend, 914)
    expect(
      restored.cells
        .filter((cell) => cell.format?.bgColor === color)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([
      [2, 0],
      [3, 0],
    ])
  })

  it('precisely contracts a range-format layer across a multi-column deletion and undo', async () => {
    const color = '#aa00aa'
    const backend = createStaticSpreadsheetBackend({ revision: 50, matrix: [] })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 2, colEnd: 3 },
      format: { bgColor: color },
    })

    const readColumns = (requestId: number) =>
      backend.readRangeProjection(
        createRangeProjectionRequest({
          sheetId: 'sheet-1',
          requestId,
          reason: 'test',
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 4 },
        }),
      )
    await backend.deleteColumns!({
      kind: 'delete-columns',
      sheetId: 'sheet-1',
      colIndex: 1,
      count: 2,
    })
    const shifted = await readColumns(915)
    expect(
      shifted.cells
        .filter((cell) => cell.format?.bgColor === color)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([[0, 1]])

    await backend.undoTransaction!(undoRequest('delete-columns-range-formats'))
    const restored = await readColumns(916)
    expect(
      restored.cells
        .filter((cell) => cell.format?.bgColor === color)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([
      [0, 2],
      [0, 3],
    ])
  })

  const invalidRequests: Array<[string, (request: RemoveRowsExactRequest) => unknown]> = [
    ['wrong kind', (request) => ({ ...request, kind: 'delete-rows' })],
    ['negative requestId', (request) => ({ ...request, requestId: -1 })],
    ['unsafe requestId', (request) => ({ ...request, requestId: Number.MAX_SAFE_INTEGER + 1 })],
    [
      'fractional target range',
      (request) => ({ ...request, targetRange: { ...request.targetRange, rowStart: 0.5 } }),
    ],
    ['unordered rows', (request) => ({ ...request, rows: [4, 2] })],
    ['duplicate rows', (request) => ({ ...request, rows: [2, 2] })],
    ['out-of-range rows', (request) => ({ ...request, rows: [7] })],
    ['stale revision', (request) => ({ ...request, revision: 6 })],
    ['empty rows', (request) => ({ ...request, rows: [] })],
    ['missing revision', (request) => ({ ...request, revision: undefined })],
    ['unknown sheet identity', (request) => ({ ...request, sheetId: 'missing-sheet' })],
  ]

  it.each(invalidRequests)(
    '%s is rejected before any state, revision, or history write',
    async (_label, makeInvalid) => {
      const backend = createStaticSpreadsheetBackend({
        revision: 7,
        matrix: [['header'], ['one'], ['two'], ['three'], ['four'], ['five'], ['six']],
      })
      const before = await readRows(backend, 906)

      await expect(
        backend.removeRowsExact(makeInvalid(exactRequest()) as RemoveRowsExactRequest),
      ).rejects.toMatchObject({ code: 'INVALID_REMOVE_ROWS_EXACT_REQUEST' })

      expect(await readRows(backend, 907)).toEqual({ ...before, requestId: 907 })
      await expect(
        backend.undoTransaction!(undoRequest(`invalid-remove-rows-exact-${_label}`)),
      ).rejects.toThrow('nothing to undo')
    },
  )

  const invalidCurrentRevisions: Array<[string, string | number]> = [
    ['opaque', 'opaque-v1'],
    ['unadvanceable', 2 ** 53],
  ]

  it.each(invalidCurrentRevisions)(
    '%s current revision is rejected before any write',
    async (_label, revision) => {
      const backend = createStaticSpreadsheetBackend({ revision, matrix: [['keep'], ['drop']] })
      const before = await readRows(backend, 908)

      await expect(
        backend.removeRowsExact(
          exactRequest({
            requestId: 93,
            targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
            rows: [1],
            revision,
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REMOVE_ROWS_EXACT_REQUEST' })

      expect(await readRows(backend, 909)).toEqual({ ...before, requestId: 909 })
      await expect(
        backend.undoTransaction!(undoRequest(`invalid-remove-rows-exact-revision-${_label}`)),
      ).rejects.toThrow('nothing to undo')
    },
  )

  it('rejects legacy removeRows with an opaque revision before facts or history change', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 'opaque-v1',
      matrix: [['keep-a'], ['drop'], ['keep-b']],
    })
    const before = await readRows(backend, 917)

    await expect(
      backend.removeRows!({ kind: 'remove-rows', sheetId: 'sheet-1', rows: [1] }),
    ).rejects.toThrow('cannot advance projection revision opaque-v1')
    expect(await readRows(backend, 918)).toEqual({ ...before, requestId: 918 })
    await expect(
      backend.undoTransaction!(undoRequest('legacy-remove-rows-opaque')),
    ).rejects.toThrow('nothing to undo')
  })
})

describe('static backend undo/redo (reverse-delta history, audit D-2)', () => {
  async function readCellDisplay(
    backend: ReturnType<typeof createStaticSpreadsheetBackend>,
    sheetId: string,
    row: number,
    col: number,
  ): Promise<string | undefined> {
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId,
        requestId: 999,
        reason: 'test',
        range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
      }),
    )
    return result.cells.find((c) => c.row === row && c.col === col)?.displayValue
  }

  async function readCellFact(
    backend: ReturnType<typeof createStaticSpreadsheetBackend>,
    row = 0,
    col = 0,
  ) {
    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 998,
        reason: 'test',
        range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
      }),
    )
    return {
      displayValue: result.cells.find((cell) => cell.row === row && cell.col === col)?.displayValue,
      revision: result.revision,
    }
  }

  async function readHiddenProjection(
    backend: ReturnType<typeof createStaticSpreadsheetBackend>,
    sheetId = 'sheet-1',
  ) {
    const result = await backend.readViewportSizeProjection!({
      kind: 'viewport-size',
      sheetId,
      requestId: 997,
      window: { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 100 },
    })
    return {
      rows: result.hiddenRowIndices,
      cols: result.hiddenColIndices,
      revision: result.revision,
    }
  }

  function undoReq(id = 't-1') {
    return { kind: 'undo-transaction' as const, transactionId: id }
  }
  function redoReq(id = 't-1') {
    return { kind: 'redo-transaction' as const, transactionId: id }
  }

  it('undo restores the before-value of a single-cell edit; redo reapplies it', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['old']] })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'new',
    })
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('new')

    await backend.undoTransaction!(undoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('old')

    await backend.redoTransaction!(redoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('new')

    // Undo again — deltas must survive a full undo→redo→undo cycle.
    await backend.undoTransaction!(undoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('old')
  })

  it('undo and redo restore canonical hidden rows and columns while a no-op preserves redo', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['A1']] })
    await backend.hideRows!({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      rowIndices: [4, 2, 4],
      revision: 1,
    })
    await backend.hideColumns!({
      kind: 'hide-columns',
      sheetId: 'sheet-1',
      colIndices: [3, 1, 3],
      revision: 2,
    })
    expect(await readHiddenProjection(backend)).toEqual({
      rows: [2, 4],
      cols: [1, 3],
      revision: 3,
    })

    await backend.undoTransaction!(undoReq('hidden-cols'))
    expect(await readHiddenProjection(backend)).toEqual({ rows: [2, 4], cols: [], revision: 4 })
    await backend.undoTransaction!(undoReq('hidden-rows'))
    expect(await readHiddenProjection(backend)).toEqual({ rows: [], cols: [], revision: 5 })

    await backend.redoTransaction!(redoReq('hidden-rows'))
    expect(await readHiddenProjection(backend)).toEqual({ rows: [2, 4], cols: [], revision: 6 })
    await expect(
      backend.unhideColumns!({
        kind: 'unhide-columns',
        sheetId: 'sheet-1',
        requestId: 49,
        colIndices: [99],
        revision: 6,
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 49, revision: 6 })
    await backend.redoTransaction!(redoReq('hidden-cols'))
    expect(await readHiddenProjection(backend)).toEqual({
      rows: [2, 4],
      cols: [1, 3],
      revision: 7,
    })
  })

  it.each([
    ['opaque revision', 'opaque-v1'],
    ['2**53 revision', 2 ** 53],
    ['Number.MAX_VALUE revision', Number.MAX_VALUE],
  ] as Array<[string, string | number]>)(
    'rejects a history-producing mutation before facts or history change for %s',
    async (_label, revision) => {
      const backend = createStaticSpreadsheetBackend({ revision, matrix: [['old']] })
      const mutate = () =>
        backend.setCellInput({
          kind: 'set-cell-input',
          sheetId: 'sheet-1',
          row: 0,
          col: 0,
          input: 'new',
        })

      await expect(mutate()).rejects.toThrow('cannot advance projection revision')
      await expect(mutate()).rejects.toThrow('cannot advance projection revision')
      expect(await readCellFact(backend)).toEqual({ displayValue: 'old', revision })
      await expect(backend.undoTransaction!(undoReq())).rejects.toThrow('nothing to undo')
    },
  )

  it('keeps undo facts, revision, and history intact when its numeric witness cannot advance', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: Number.MAX_SAFE_INTEGER,
      matrix: [['old']],
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'new',
    })
    expect(await readCellFact(backend)).toEqual({
      displayValue: 'new',
      revision: 2 ** 53,
    })

    await expect(backend.undoTransaction!(undoReq())).rejects.toThrow(
      'cannot advance projection revision',
    )
    expect(await readCellFact(backend)).toEqual({
      displayValue: 'new',
      revision: 2 ** 53,
    })
    // The same revision error (rather than "nothing to undo") proves the
    // failed operation did not consume the undo entry.
    await expect(backend.undoTransaction!(undoReq())).rejects.toThrow(
      'cannot advance projection revision',
    )
  })

  it('keeps redo facts, revision, and history intact when its numeric witness cannot advance', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: Number.MAX_SAFE_INTEGER - 1,
      matrix: [['old']],
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'new',
    })
    await backend.undoTransaction!(undoReq())
    expect(await readCellFact(backend)).toEqual({
      displayValue: 'old',
      revision: 2 ** 53,
    })

    await expect(backend.redoTransaction!(redoReq())).rejects.toThrow(
      'cannot advance projection revision',
    )
    expect(await readCellFact(backend)).toEqual({
      displayValue: 'old',
      revision: 2 ** 53,
    })
    // The redo entry likewise stays available after a failed preflight.
    await expect(backend.redoTransaction!(redoReq())).rejects.toThrow(
      'cannot advance projection revision',
    )
  })

  it('does not let 200 empty imports consume history or hide the preceding edit', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['old']] })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'new',
    })

    for (let index = 0; index < 200; index += 1) {
      const result = await backend.importCells!({
        kind: 'import-cells',
        sheetId: 'sheet-1',
        cells: [],
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      })
      expect(result.revision).toBe(2)
    }

    await backend.undoTransaction!(undoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('old')
    await expect(backend.undoTransaction!(undoReq())).rejects.toThrow('nothing to undo')
  })

  it('preserves redo across same-order reorder, empty import, and rejected sheet mutations', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: ['Sheet1', 'Sheet2'],
      matrix: [['old']],
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'new',
    })
    await backend.undoTransaction!(undoReq())

    const reorderResult = await backend.reorderSheet!({
      kind: 'reorder-sheet',
      sheetId: 'sheet-1',
      beforeSheetId: 'sheet-2',
    })
    expect(reorderResult.revision).toBe(3)
    expect(reorderResult.sheets?.map((sheet) => sheet.id)).toEqual(['sheet-1', 'sheet-2'])

    await backend.importCells!({
      kind: 'import-cells',
      sheetId: 'sheet-1',
      cells: [],
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })
    await expect(
      backend.renameSheet!({ kind: 'rename-sheet', sheetId: 'sheet-1', name: '   ' }),
    ).rejects.toThrow('sheet name cannot be empty')
    await expect(backend.addSheet!({ kind: 'add-sheet', name: 'Sheet1' })).rejects.toThrow(
      'sheet name already exists',
    )
    await expect(
      backend.reorderSheet!({ kind: 'reorder-sheet', sheetId: 'missing-sheet' }),
    ).rejects.toThrow('unknown sheet')
    expect(await readCellFact(backend)).toEqual({ displayValue: 'old', revision: 3 })

    await backend.redoTransaction!(redoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('new')
  })

  it('treats a fresh same-order reorder as a no-op with no undo entry', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 7,
      sheets: ['Sheet1', 'Sheet2'],
    })

    const result = await backend.reorderSheet!({
      kind: 'reorder-sheet',
      sheetId: 'sheet-1',
      beforeSheetId: 'sheet-2',
    })

    expect(result.revision).toBe(7)
    expect(result.sheets?.map((sheet) => sheet.id)).toEqual(['sheet-1', 'sheet-2'])
    await expect(backend.undoTransaction!(undoReq())).rejects.toThrow('nothing to undo')
  })

  it('treats an empty cell-chunk stream as a no-op and preserves redo', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['old']] })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'new',
    })
    await backend.undoTransaction!(undoReq())

    const result = await backend.importCellChunks!({
      kind: 'import-cell-chunks',
      sheetId: 'sheet-1',
      chunks: [[], []],
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })
    expect(result.revision).toBe(3)

    await backend.redoTransaction!(redoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('new')
  })

  it('rolls back streamed chunks atomically when a later iterator step fails', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [['old-a', 'old-b']],
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'redo-a',
    })
    await backend.undoTransaction!(undoReq())

    async function* failingChunks() {
      yield [{ row: 0, col: 0, input: 'partial-a' }]
      yield [{ row: 0, col: 1, input: 'partial-b' }]
      throw new Error('chunk source failed')
    }

    await expect(
      backend.importCellChunks!({
        kind: 'import-cell-chunks',
        sheetId: 'sheet-1',
        chunks: failingChunks(),
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      }),
    ).rejects.toThrow('chunk source failed')

    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('old-a')
    expect(await readCellDisplay(backend, 'sheet-1', 0, 1)).toBe('old-b')
    expect((await readCellFact(backend)).revision).toBe(3)
    await expect(backend.undoTransaction!(undoReq())).rejects.toThrow('nothing to undo')

    await backend.redoTransaction!(redoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('redo-a')
    expect(await readCellDisplay(backend, 'sheet-1', 0, 1)).toBe('old-b')
  })

  it('undo restores a cell created on a previously empty coordinate (delete on undo)', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1 })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 3,
      col: 3,
      input: 'created',
    })
    await backend.undoTransaction!(undoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 3, 3)).toBeUndefined()
  })

  it('undo restores every cell removed by clearRange', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    })
    await backend.clearRange!({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBeUndefined()

    await backend.undoTransaction!(undoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('a')
    expect(await readCellDisplay(backend, 'sheet-1', 1, 1)).toBe('d')
  })

  it('undo of a structural insertRows restores the original layout (full-sheet fallback)', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [['top'], ['bottom']],
    })
    await backend.insertRows!({
      kind: 'insert-rows',
      sheetId: 'sheet-1',
      rowIndex: 1,
      count: 2,
    })
    expect(await readCellDisplay(backend, 'sheet-1', 3, 0)).toBe('bottom')

    await backend.undoTransaction!(undoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 1, 0)).toBe('bottom')
    expect(await readCellDisplay(backend, 'sheet-1', 3, 0)).toBeUndefined()

    await backend.redoTransaction!(redoReq())
    expect(await readCellDisplay(backend, 'sheet-1', 3, 0)).toBe('bottom')
  })

  it('shifts hidden indices through structural inserts, deletes, and exact row removal with undo/redo', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['A1']] })
    await backend.hideRows!({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      rowIndices: [6, 1, 3],
      revision: 1,
    })
    await backend.hideColumns!({
      kind: 'hide-columns',
      sheetId: 'sheet-1',
      colIndices: [7, 0, 4],
      revision: 2,
    })
    await backend.insertRows!({
      kind: 'insert-rows',
      sheetId: 'sheet-1',
      rowIndex: 2,
      count: 2,
    })
    await backend.insertColumns!({
      kind: 'insert-columns',
      sheetId: 'sheet-1',
      colIndex: 4,
      count: 2,
    })
    await backend.deleteRows!({
      kind: 'delete-rows',
      sheetId: 'sheet-1',
      rowIndex: 4,
      count: 3,
    })
    await backend.deleteColumns!({
      kind: 'delete-columns',
      sheetId: 'sheet-1',
      colIndex: 5,
      count: 3,
    })
    expect(await readHiddenProjection(backend)).toEqual({
      rows: [1, 5],
      cols: [0, 6],
      revision: 7,
    })

    await backend.removeRows!({
      kind: 'remove-rows',
      sheetId: 'sheet-1',
      rows: [4, 0, 4],
    })
    expect(await readHiddenProjection(backend)).toEqual({
      rows: [0, 3],
      cols: [0, 6],
      revision: 8,
    })
    await backend.undoTransaction!(undoReq('hidden-remove-rows'))
    expect(await readHiddenProjection(backend)).toEqual({
      rows: [1, 5],
      cols: [0, 6],
      revision: 9,
    })
    await backend.redoTransaction!(redoReq('hidden-remove-rows'))
    expect(await readHiddenProjection(backend)).toEqual({
      rows: [0, 3],
      cols: [0, 6],
      revision: 10,
    })
  })

  it('undo removes a format applied by setFormatRange', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['x']] })
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range,
      format: { bold: true },
    })
    const formatted = await backend.readRangeProjection(
      createRangeProjectionRequest({ sheetId: 'sheet-1', requestId: 1, reason: 'test', range }),
    )
    expect(formatted.cells[0]?.format?.bold).toBe(true)

    await backend.undoTransaction!(undoReq())
    const reverted = await backend.readRangeProjection(
      createRangeProjectionRequest({ sheetId: 'sheet-1', requestId: 2, reason: 'test', range }),
    )
    expect(reverted.cells[0]?.format?.bold).toBeUndefined()
  })

  it('undo restores validation metadata mutated in place by setValidationRule', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['v']] })
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    await backend.setValidationRule!({
      kind: 'set-validation-rule',
      sheetId: 'sheet-1',
      range,
      rule: { kind: 'list', values: ['a'], dropdown: true },
      mode: 'warn',
    })
    const withRule = await backend.readRangeProjection(
      createRangeProjectionRequest({ sheetId: 'sheet-1', requestId: 3, reason: 'test', range }),
    )
    expect(withRule.cells[0]?.validation).toBeDefined()

    await backend.undoTransaction!(undoReq())
    const reverted = await backend.readRangeProjection(
      createRangeProjectionRequest({ sheetId: 'sheet-1', requestId: 4, reason: 'test', range }),
    )
    expect(reverted.cells[0]?.validation).toBeUndefined()
  })

  it('undo of deleteSheet restores the sheet, its cells, and sheet-scoped named ranges', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: ['Sheet1', 'Sheet2'],
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-2',
      row: 0,
      col: 0,
      input: 'keep-me',
    })
    await backend.setNamedRange!({
      kind: 'set-named-range',
      name: 'OnTwo',
      scope: { sheetId: 'sheet-2' },
      refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'A1' },
    })
    await backend.deleteSheet!({ kind: 'delete-sheet', sheetId: 'sheet-2' })
    expect((await backend.listSheets!()).sheets.map((s) => s.id)).toEqual(['sheet-1'])

    await backend.undoTransaction!(undoReq())
    expect((await backend.listSheets!()).sheets.map((s) => s.id)).toEqual(['sheet-1', 'sheet-2'])
    expect(await readCellDisplay(backend, 'sheet-2', 0, 0)).toBe('keep-me')
    const names = await backend.listNamedRanges!({ kind: 'list-named-ranges' })
    expect(names.names.map((n) => n.name)).toEqual(['OnTwo'])
  })

  it('cleans hidden metadata on sheet deletion and restores it exactly through undo and redo', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: ['Sheet1', 'Sheet2'],
    })
    await backend.hideRows!({
      kind: 'hide-rows',
      sheetId: 'sheet-2',
      rowIndices: [2],
      revision: 1,
    })
    await backend.hideColumns!({
      kind: 'hide-columns',
      sheetId: 'sheet-2',
      colIndices: [3],
      revision: 2,
    })
    await backend.deleteSheet!({ kind: 'delete-sheet', sheetId: 'sheet-2' })
    expect((await backend.listSheets!()).sheets.map((sheet) => sheet.id)).toEqual(['sheet-1'])
    expect(await readHiddenProjection(backend, 'sheet-2')).toEqual({
      rows: [],
      cols: [],
      revision: 4,
    })

    await backend.undoTransaction!(undoReq('hidden-delete-sheet'))
    expect(await readHiddenProjection(backend, 'sheet-2')).toEqual({
      rows: [2],
      cols: [3],
      revision: 5,
    })
    await backend.redoTransaction!(redoReq('hidden-delete-sheet'))
    expect(await readHiddenProjection(backend, 'sheet-2')).toEqual({
      rows: [],
      cols: [],
      revision: 6,
    })

    const replacement = await backend.addSheet!({ kind: 'add-sheet', name: 'Replacement' })
    expect(replacement.createdSheet?.id).toBe('sheet-2')
    expect(await readHiddenProjection(backend, 'sheet-2')).toEqual({
      rows: [],
      cols: [],
      revision: 7,
    })
  })

  it('a new mutation clears the redo stack', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [['a']] })
    const edit = (input: string) =>
      backend.setCellInput({ kind: 'set-cell-input', sheetId: 'sheet-1', row: 0, col: 0, input })
    await edit('b')
    await backend.undoTransaction!(undoReq())
    await edit('c')
    await expect(backend.redoTransaction!(redoReq())).rejects.toThrow('nothing to redo')
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('c')
  })

  it('undo restores merge ranges removed by unmergeRange', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['m', ''],
        ['', ''],
      ],
    })
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    await backend.mergeRange!({ kind: 'merge-range', sheetId: 'sheet-1', range })
    await backend.unmergeRange!({ kind: 'unmerge-range', sheetId: 'sheet-1', range })

    await backend.undoTransaction!(undoReq())
    const projected = await backend.readRangeProjection(
      createRangeProjectionRequest({ sheetId: 'sheet-1', requestId: 5, reason: 'test', range }),
    )
    expect(projected.cells.find((c) => c.row === 0 && c.col === 0)?.mergedSpan).toEqual({
      rows: 2,
      cols: 2,
    })
  })

  it('history stays capped at 200 entries', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1 })
    for (let i = 0; i <= 205; i += 1) {
      await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        row: 0,
        col: 0,
        input: `v${i}`,
      })
    }
    for (let i = 0; i < 200; i += 1) {
      await backend.undoTransaction!(undoReq(`t-${i}`))
    }
    await expect(backend.undoTransaction!(undoReq('t-final'))).rejects.toThrow('nothing to undo')
    // The 6 oldest entries fell off the cap: v0..v5 happened-before the
    // retained window, so the floor value is v5.
    expect(await readCellDisplay(backend, 'sheet-1', 0, 0)).toBe('v5')
  })
})
