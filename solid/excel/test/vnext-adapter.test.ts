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
  SparseCellWire,
  SparseRangeWire,
  WorkerWorkbookClient,
  WorkbookSheetMeta,
} from '../src-vnext/adapter'
import {
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
    exportRangeTsv: SparseRangeWire[]
    exportRangeTsvChunks: Array<SparseRangeWire & { rowsPerChunk?: number }>
    addSheet: string[]
    renameSheet: Array<{ sheet: number; name: string }>
    removeSheet: number[]
  }
  putCell(cell: CellSnapshotWire): void
  emitDirty(cells: CellRefWire[]): void
}

function createFakeWorkerWorkbookClient(): FakeWorkerWorkbookClient {
  const cells = new Map<string, CellSnapshotWire>()
  const rangeFormats: Array<SparseRangeWire & { format: CellFormatJSON }> = []
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
    exportRangeTsv: [],
    exportRangeTsvChunks: [],
    addSheet: [],
    renameSheet: [],
    removeSheet: [],
  }
  let metas: WorkbookSheetMeta[] = []

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

      const shifted = current >= (direction === 1 ? index : deleteEnd + 1)
        ? current + count * direction
        : current
      const row = axis === 'row' ? shifted : coord.row
      const col = axis === 'column' ? shifted : coord.col
      const nextSnapshot = { ...snapshot, addr: toCellAddress(row, col) }
      next.set(key(nextSnapshot.sheet, nextSnapshot.addr), nextSnapshot)
    }

    cells.clear()
    for (const [cellKey, snapshot] of next) cells.set(cellKey, snapshot)
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
      metas = metas
        .filter((meta) => meta.idx !== sheet)
        .map((meta, idx) => ({ ...meta, idx }))
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
          display: value.type === 'boolean' ? (value.value ? 'TRUE' : 'FALSE') : String(value.value),
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
      return true
    },
    async deleteRows(sheet, rowIndex, count) {
      calls.deleteRows.push({ sheet, rowIndex, count })
      shiftCells(sheet, 'row', rowIndex, count, -1)
      return true
    },
    async insertColumns(sheet, colIndex, count) {
      calls.insertColumns.push({ sheet, colIndex, count })
      shiftCells(sheet, 'column', colIndex, count, 1)
      return true
    },
    async deleteColumns(sheet, colIndex, count) {
      calls.deleteColumns.push({ sheet, colIndex, count })
      shiftCells(sheet, 'column', colIndex, count, -1)
      return true
    },
    async setFormatRange(range, fmt) {
      calls.setFormatRange.push({ ...range, fmt })
      rangeFormats.push({
        ...range,
        format: fmt ? { ...fmt, numberFormat: fmt.numberFormat ? { ...fmt.numberFormat } : undefined } : {},
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
              numberFormat: layer.format.numberFormat ? { ...layer.format.numberFormat } : undefined,
            },
          })),
      }
      return snapshot
    },
    async restoreFormatSnapshot() {
      throw new Error('not used')
    },
    async beginImport() {
      throw new Error('not used')
    },
    async importChunk() {
      throw new Error('not used')
    },
    async commitImport() {
      throw new Error('not used')
    },
    async cancelImport() {
      throw new Error('not used')
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
    dispose() {
      dirtyListeners.clear()
      hydratedListeners.clear()
    },
  }

  return client
}

describe('vnext adapter', () => {
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

  it('exports TSV through worker workbook chunk export before falling back to plain export', async () => {
    const client = createFakeWorkerWorkbookClient()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      revision: 6,
    })

    await backend.ready()
    client.exportRangeTsvChunks = async (range, rowsPerChunk) => {
      client.calls.exportRangeTsvChunks.push({ ...range, rowsPerChunk })
      return ['A\tB', 'C\tD']
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
    expect(client.calls.exportRangeTsvChunks).toEqual([
      { sheet: 0, startRow: 1, startCol: 1, endRow: 2, endCol: 2, rowsPerChunk: 2 },
    ])
    expect(client.calls.exportRangeTsv).toEqual([])
    expect(client.calls.readSparseRange).toEqual([])
    expect(client.calls.snapshotRangeSparse).toEqual([])
    expect(client.calls.snapshotFormatRange).toEqual([])

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
    client.exportRangeTsvChunks = undefined as unknown as WorkerWorkbookClient['exportRangeTsvChunks']
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
    expect(client.calls.setFormulaDetailed).toEqual([
      { sheet: 0, addr: 'C1', formula: '=A1+1' },
    ])
    expect(client.calls.clearCell).toEqual([{ sheet: 0, addr: 'A1' }])
    expect(clearResult).toEqual({
      sheetId: 'sheet-1',
      requestId: 99,
      revision: 8,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

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
    expect(result.cells).toEqual([
      { row: 0, col: 2, displayValue: 'C1', valueKind: 'string' },
    ])

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
    expect(reorder?.sheets?.map((sheet) => sheet.name)).toEqual(['Inputs', 'Calc', 'Sheet1'])

    expect((await backend.listSheets?.())?.sheets.map((sheet) => sheet.name)).toEqual([
      'Inputs',
      'Calc',
      'Sheet1',
    ])

    const remove = await backend.deleteSheet?.({ kind: 'delete-sheet', sheetId: 'sheet-2' })
    expect(client.calls.removeSheet).toEqual([1])
    expect(remove?.activeSheetId).toBe('sheet-3')
    expect(remove?.sheets).toEqual([
      { id: 'sheet-3', name: 'Calc', index: 0 },
      { id: 'sheet-1', name: 'Sheet1', index: 1 },
    ])

    backend.dispose()
  })

  it('stores worker workbook viewport size metadata in the adapter without Rust cell reads', async () => {
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
})
