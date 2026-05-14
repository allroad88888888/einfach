import { describe, expect, it } from '@jest/globals'
import {
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  SparseRangeWire,
  WorkerWorkbookClient,
  WorkbookSheetMeta,
} from '../src/wasm-workbook-proxy'
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
    setCell: Array<{ sheet: number; addr: string; value: CellWire }>
    setFormulaDetailed: Array<{ sheet: number; addr: string; formula: string }>
    clearCell: Array<{ sheet: number; addr: string }>
    clearRange: SparseRangeWire[]
  }
  putCell(cell: CellSnapshotWire): void
  emitDirty(cells: CellRefWire[]): void
}

function createFakeWorkerWorkbookClient(): FakeWorkerWorkbookClient {
  const cells = new Map<string, CellSnapshotWire>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
  const hydratedListeners = new Set<(cells: CellSnapshotWire[]) => void>()
  const calls: FakeWorkerWorkbookClient['calls'] = {
    initWorkbook: [],
    readSparseRange: [],
    setCell: [],
    setFormulaDetailed: [],
    clearCell: [],
    clearRange: [],
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

  function putCell(cell: CellSnapshotWire) {
    cells.set(key(cell.sheet, cell.addr), {
      ...cell,
      addr: cell.addr.toUpperCase(),
    })
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
    async addSheet() {
      throw new Error('not used')
    },
    async renameSheet() {
      throw new Error('not used')
    },
    async removeSheet() {
      throw new Error('not used')
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
    async setFormatRange() {
      throw new Error('not used')
    },
    async snapshotFormatRange() {
      throw new Error('not used')
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
    async snapshotRangeSparse() {
      throw new Error('not used')
    },
    async snapshotPersistenceV1() {
      throw new Error('not used')
    },
    async restorePersistenceV1() {
      throw new Error('not used')
    },
    async exportRangeTsv() {
      throw new Error('not used')
    },
    async beginExportRangeTsv() {
      throw new Error('not used')
    },
    async nextExportRangeTsvChunk() {
      throw new Error('not used')
    },
    async cancelExport() {
      throw new Error('not used')
    },
    async exportRangeTsvChunks() {
      throw new Error('not used')
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
