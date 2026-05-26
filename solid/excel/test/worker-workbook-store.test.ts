/** @jsxImportSource solid-js */

import { describe, expect, it } from '@jest/globals'
import { createRoot } from 'solid-js'
import { sparseRangeToTSV } from '../src/range-tsv'
import type { CellFormatJSON, FormatRangeSnapshot } from '../src/types'
import { createWorkerWorkbookStore } from '../src/wasm-workbook-store'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  BeginImportOptionsWire,
  ImportCellWire,
  SparseCellWire,
  SparseRangeWire,
  WorkerWorkbookClient,
  WorkbookImportStatsWire,
  WorkerWorkbookDebugCountersWire,
  WorkbookPersistenceRestoreStatsWire,
  WorkbookPersistenceSnapshotWire,
  WorkbookSheetMeta,
} from '../src/wasm-workbook-proxy'

type ClearRangeCall = {
  sheet: number
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

type FormatRangeCall = ClearRangeCall & {
  fmt: CellFormatJSON | null | undefined
}

type FakeWorkerWorkbookClient = WorkerWorkbookClient & {
  calls: {
    initWorkbook: string[][]
    setCell: Array<{ sheet: number; addr: string; value: CellWire }>
    setFormula: Array<{ sheet: number; addr: string; formula: string }>
    setFormulaDetailed: Array<{ sheet: number; addr: string; formula: string }>
    addSheet: string[]
    renameSheet: Array<{ sheet: number; name: string }>
    removeSheet: number[]
    moveSheet: Array<{ from: number; to: number }>
    sheetList: WorkbookSheetMeta[][]
    clearCell: Array<{ sheet: number; addr: string }>
    clearRange: ClearRangeCall[]
    insertRows: Array<{ sheet: number; rowIndex: number; count: number }>
    deleteRows: Array<{ sheet: number; rowIndex: number; count: number }>
    insertColumns: Array<{ sheet: number; colIndex: number; count: number }>
    deleteColumns: Array<{ sheet: number; colIndex: number; count: number }>
    setFormatRange: FormatRangeCall[]
    snapshotFormatRange: ClearRangeCall[]
    restoreFormatSnapshot: FormatRangeSnapshot[]
    snapshotViewportSizes: ClearRangeCall[]
    setRowHeight: Array<{ sheet: number; rowIndex: number; heightPx: number }>
    setColumnWidth: Array<{ sheet: number; colIndex: number; widthPx: number }>
    snapshotRangeSparse: ClearRangeCall[]
    snapshotRangeSparseChunks: Array<ClearRangeCall & { rowsPerChunk?: number }>
    exportRangeTsv: ClearRangeCall[]
    exportRangeTsvChunks: Array<ClearRangeCall & { rowsPerChunk?: number }>
    restoreSparse: SparseCellWire[][]
    readSparseRange: ClearRangeCall[]
    readCells: CellRefWire[][]
    subscribeCells: CellRefWire[][]
    unsubscribeCells: number[]
    beginImport: number[]
    importChunk: Array<{ sessionId: number; cells: ImportCellWire[] }>
    commitImport: number[]
    cancelImport: number[]
    snapshotSparse: number
    snapshotPersistenceV1: number
    restorePersistenceV1: WorkbookPersistenceSnapshotWire[]
    debugFormulaCacheState: Array<{ sheet: number; addr: string }>
    debugCounters: number
  }
  emitHydrated(cells: CellSnapshotWire[]): void
  setFormulaResult(sheet: number, addr: string, result: boolean): void
  behavior?: {
    failAddSheet?: (name: string) => boolean
    failRenameSheet?: (sheet: number, name: string) => boolean
    failRemoveSheet?: (sheet: number) => boolean
    failSheetList?: () => boolean
  }
}

function parseCellAddress(addr: string): { row: number; col: number } {
  const m = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!m) {
    return { row: -1, col: -1 }
  }
  let col = 0
  for (let i = 0; i < m[1].length; i++) {
    col = col * 26 + (m[1].charCodeAt(i) - 64)
  }
  return {
    row: Number(m[2]) - 1,
    col: col - 1,
  }
}

function inRange(
  addr: string,
  range: {
    sheet: number
    startRow: number
    startCol: number
    endRow: number
    endCol: number
  },
) {
  if (range.sheet < 0) return false
  const parsed = parseCellAddress(addr)
  if (parsed.row < 0 || parsed.col < 0) return false
  return (
    parsed.row >= range.startRow &&
    parsed.row <= range.endRow &&
    parsed.col >= range.startCol &&
    parsed.col <= range.endCol
  )
}

function emptySnapshot(ref: CellRefWire): CellSnapshotWire {
  return {
    sheet: ref.sheet,
    addr: ref.addr.toUpperCase(),
    display: '',
    type: 'null',
    isError: false,
    formula: '',
  }
}

function makeFakeWorkerWorkbookClient(
  behavior: FakeWorkerWorkbookClient['behavior'] = {},
): FakeWorkerWorkbookClient {
  const calls: FakeWorkerWorkbookClient['calls'] = {
    initWorkbook: [],
    setCell: [],
    setFormula: [],
    setFormulaDetailed: [],
    addSheet: [],
    renameSheet: [],
    removeSheet: [],
    moveSheet: [],
    sheetList: [],
    clearCell: [],
    clearRange: [],
    insertRows: [],
    deleteRows: [],
    insertColumns: [],
    deleteColumns: [],
    setFormatRange: [],
    snapshotFormatRange: [],
    restoreFormatSnapshot: [],
    snapshotViewportSizes: [],
    setRowHeight: [],
    setColumnWidth: [],
    snapshotRangeSparse: [],
    snapshotRangeSparseChunks: [],
    exportRangeTsv: [],
    exportRangeTsvChunks: [],
    restoreSparse: [],
    readSparseRange: [],
    readCells: [],
    subscribeCells: [],
    unsubscribeCells: [],
    beginImport: [],
    importChunk: [],
    commitImport: [],
    cancelImport: [],
    snapshotSparse: 0,
    snapshotPersistenceV1: 0,
    restorePersistenceV1: [],
    debugFormulaCacheState: [],
    debugCounters: 0,
  }
  const cells = new Map<string, CellSnapshotWire>()
  const hydratedListeners = new Set<(cells: CellSnapshotWire[]) => void>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
  const formulaResults = new Map<string, boolean>()
  let nextSubId = 1
  let nextExportId = 1
  let nextSnapshotId = 1
  let metas: WorkbookSheetMeta[] = []

  function key(sheet: number, addr: string) {
    return `${sheet}:${addr.toUpperCase()}`
  }

  function storeCell(sheet: number, addr: string, value: CellWire) {
    const ref = { sheet, addr: addr.toUpperCase() }
    if (value.type === 'null') {
      cells.delete(key(sheet, addr))
      return
    }
    cells.set(key(sheet, addr), {
      ...ref,
      display: value.type === 'boolean' ? (value.value ? 'TRUE' : 'FALSE') : String(value.value),
      type: value.type,
      isError: value.type === 'error',
      formula: '',
    })
  }

  return {
    calls,
    emitHydrated(cells) {
      for (const listener of hydratedListeners) listener(cells)
    },
    setFormulaResult(sheet, addr, result) {
      formulaResults.set(key(sheet, addr), result)
    },
    async initWorkbook(sheets = ['Sheet1']) {
      calls.initWorkbook.push([...sheets])
      metas = sheets.map((name, idx) => ({ idx, name }))
      return metas
    },
    async sheetList() {
      calls.sheetList.push([...metas])
      if (behavior?.failSheetList?.()) {
        throw new Error('sheetList failed')
      }
      return metas
    },
    async addSheet(name) {
      calls.addSheet.push(name)
      if (behavior?.failAddSheet?.(name)) {
        throw new Error('addSheet failed')
      }
      const idx = metas.length
      metas = [...metas, { idx, name }]
      return idx
    },
    async renameSheet(sheet, name) {
      calls.renameSheet.push({ sheet, name })
      if (behavior?.failRenameSheet?.(sheet, name)) {
        return false
      }
      metas = metas.map((meta) => (meta.idx === sheet ? { ...meta, name } : meta))
      return true
    },
    async removeSheet(sheet) {
      calls.removeSheet.push(sheet)
      if (behavior?.failRemoveSheet?.(sheet)) {
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
      const [meta] = metas.splice(from, 1)
      metas.splice(to, 0, meta)
      metas = metas.map((item, idx) => ({ ...item, idx }))
      return true
    },
    async setCell(sheet, addr, value) {
      calls.setCell.push({ sheet, addr: addr.toUpperCase(), value })
      storeCell(sheet, addr, value)
      return true
    },
    async setFormula(sheet, addr, formula) {
      calls.setFormula.push({ sheet, addr: addr.toUpperCase(), formula })
      const ok = formulaResults.get(key(sheet, addr)) ?? true
      if (!ok) return false
      cells.set(key(sheet, addr), {
        sheet,
        addr: addr.toUpperCase(),
        display: '',
        type: 'null',
        isError: false,
        formula,
      })
      return true
    },
    async setFormulaDetailed(sheet, addr, formula) {
      calls.setFormulaDetailed.push({ sheet, addr: addr.toUpperCase(), formula })
      const ok = await this.setFormula(sheet, addr, formula)
      return ok
        ? { ok: true }
        : { ok: false, code: 'FORMULA_REJECTED', message: 'formula was rejected' }
    },
    async clearCell(sheet, addr) {
      calls.clearCell.push({ sheet, addr: addr.toUpperCase() })
      cells.delete(key(sheet, addr))
      return true
    },
    async clearRange(range) {
      calls.clearRange.push({ ...range })
      for (const [itemKey] of [...cells.entries()]) {
        const [sheetStr, addr] = itemKey.split(':')
        if (Number(sheetStr) !== range.sheet) continue
        if (inRange(addr, range)) cells.delete(itemKey)
      }
      return 1
    },
    async insertRows(sheet, rowIndex, count) {
      calls.insertRows.push({ sheet, rowIndex, count })
      return true
    },
    async deleteRows(sheet, rowIndex, count) {
      calls.deleteRows.push({ sheet, rowIndex, count })
      return true
    },
    async insertColumns(sheet, colIndex, count) {
      calls.insertColumns.push({ sheet, colIndex, count })
      return true
    },
    async deleteColumns(sheet, colIndex, count) {
      calls.deleteColumns.push({ sheet, colIndex, count })
      return true
    },
    async setFormatRange(range, fmt) {
      calls.setFormatRange.push({ ...range, fmt })
      return 1
    },
    async snapshotFormatRange(range) {
      calls.snapshotFormatRange.push({ ...range })
      return {
        sheet: range.sheet,
        startRow: range.startRow,
        startCol: range.startCol,
        endRow: range.endRow,
        endCol: range.endCol,
        cellFormats: [],
        rangeFormats: [],
      }
    },
    async restoreFormatSnapshot(snapshot) {
      calls.restoreFormatSnapshot.push(snapshot)
      return 1
    },
    async snapshotViewportSizes(range) {
      calls.snapshotViewportSizes.push({
        sheet: range.sheet,
        startRow: range.startRow,
        startCol: range.startCol,
        endRow: range.endRow,
        endCol: range.endCol,
      })
      return {
        ...range,
        rowHeights: [],
        colWidths: [],
      }
    },
    async setRowHeight(sheet, rowIndex, heightPx) {
      calls.setRowHeight.push({ sheet, rowIndex, heightPx })
      return true
    },
    async setColumnWidth(sheet, colIndex, widthPx) {
      calls.setColumnWidth.push({ sheet, colIndex, widthPx })
      return true
    },
    async snapshotRangeSparse(_range: SparseRangeWire) {
      calls.snapshotRangeSparse.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
      })
      const out: SparseCellWire[] = []
      for (const [, snapshot] of cells.entries()) {
        if (snapshot.sheet !== _range.sheet) continue
        if (!inRange(snapshot.addr, _range)) continue
        const parsed = parseCellAddress(snapshot.addr)
        if (snapshot.formula !== '') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'formula',
            value: snapshot.formula,
          })
        } else if (snapshot.type === 'number') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'number',
            value: Number(snapshot.display),
          })
        } else if (snapshot.type === 'text') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'text',
            value: snapshot.display,
          })
        } else if (snapshot.type === 'boolean') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'boolean',
            value: snapshot.display === 'TRUE',
          })
        } else if (snapshot.type === 'error') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'error',
            value: snapshot.display,
          })
        }
      }
      return out
    },
    async beginSnapshotRangeSparse(_range: SparseRangeWire, rowsPerChunk = 2048) {
      calls.snapshotRangeSparseChunks.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
        rowsPerChunk,
      })
      return {
        sessionId: nextSnapshotId++,
        totalRows: _range.endRow - _range.startRow + 1,
        rowsPerChunk,
      }
    },
    async nextSnapshotRangeSparseChunk(sessionId: number) {
      return {
        sessionId,
        startRow: 0,
        endRow: 0,
        cells: [],
        done: true,
      }
    },
    async cancelSnapshot() {
      return true
    },
    async snapshotRangeSparseChunks(_range: SparseRangeWire, rowsPerChunk = 2048) {
      calls.snapshotRangeSparseChunks.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
        rowsPerChunk,
      })
      const chunks: SparseCellWire[][] = []
      const step = Math.max(1, Math.floor(rowsPerChunk))
      for (let row = _range.startRow; row <= _range.endRow; row += step) {
        const endRow = Math.min(_range.endRow, row + step - 1)
        chunks.push(
          await this.snapshotRangeSparse({
            ..._range,
            startRow: row,
            endRow,
          }),
        )
      }
      return chunks
    },
    async exportRangeTsv(_range: SparseRangeWire) {
      calls.exportRangeTsv.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
      })
      const out: SparseCellWire[] = []
      for (const [, snapshot] of cells.entries()) {
        if (snapshot.sheet !== _range.sheet) continue
        if (!inRange(snapshot.addr, _range)) continue
        const parsed = parseCellAddress(snapshot.addr)
        if (snapshot.formula !== '') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'formula',
            value: snapshot.formula,
          })
        } else if (snapshot.type === 'number') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'number',
            value: Number(snapshot.display),
          })
        } else if (snapshot.type === 'text') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'text',
            value: snapshot.display,
          })
        } else if (snapshot.type === 'boolean') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'boolean',
            value: snapshot.display === 'TRUE',
          })
        } else if (snapshot.type === 'error') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'error',
            value: snapshot.display,
          })
        }
      }
      return sparseRangeToTSV(out, _range)
    },
    async beginExportRangeTsv(_range: SparseRangeWire, rowsPerChunk = 2048) {
      calls.exportRangeTsvChunks.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
        rowsPerChunk,
      })
      return {
        sessionId: nextExportId++,
        totalRows: _range.endRow - _range.startRow + 1,
        rowsPerChunk,
      }
    },
    async nextExportRangeTsvChunk(sessionId: number) {
      return {
        sessionId,
        startRow: 0,
        endRow: 0,
        chunk: '',
        done: true,
      }
    },
    async cancelExport() {
      return true
    },
    async exportRangeTsvChunks(_range: SparseRangeWire, rowsPerChunk = 2048) {
      calls.exportRangeTsvChunks.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
        rowsPerChunk,
      })
      const chunks: string[] = []
      const step = Math.max(1, Math.floor(rowsPerChunk))
      for (let row = _range.startRow; row <= _range.endRow; row += step) {
        const endRow = Math.min(_range.endRow, row + step - 1)
        const out: SparseCellWire[] = []
        for (const [, snapshot] of cells.entries()) {
          if (snapshot.sheet !== _range.sheet) continue
          if (!inRange(snapshot.addr, { ..._range, startRow: row, endRow })) continue
          const parsed = parseCellAddress(snapshot.addr)
          if (snapshot.formula !== '') {
            out.push({
              sheet: snapshot.sheet,
              addr: snapshot.addr,
              row: parsed.row,
              col: parsed.col,
              kind: 'formula',
              value: snapshot.formula,
            })
          } else if (snapshot.type === 'number') {
            out.push({
              sheet: snapshot.sheet,
              addr: snapshot.addr,
              row: parsed.row,
              col: parsed.col,
              kind: 'number',
              value: Number(snapshot.display),
            })
          } else if (snapshot.type === 'text') {
            out.push({
              sheet: snapshot.sheet,
              addr: snapshot.addr,
              row: parsed.row,
              col: parsed.col,
              kind: 'text',
              value: snapshot.display,
            })
          } else if (snapshot.type === 'boolean') {
            out.push({
              sheet: snapshot.sheet,
              addr: snapshot.addr,
              row: parsed.row,
              col: parsed.col,
              kind: 'boolean',
              value: snapshot.display === 'TRUE',
            })
          } else if (snapshot.type === 'error') {
            out.push({
              sheet: snapshot.sheet,
              addr: snapshot.addr,
              row: parsed.row,
              col: parsed.col,
              kind: 'error',
              value: snapshot.display,
            })
          }
        }
        chunks.push(
          sparseRangeToTSV(out, {
            startRow: row,
            startCol: _range.startCol,
            endRow,
            endCol: _range.endCol,
          }),
        )
      }
      return chunks
    },
    async restoreSparse(sparseCells) {
      calls.restoreSparse.push(
        sparseCells.map((cell) => ({ ...cell, addr: cell.addr.toUpperCase() })),
      )
      for (const cell of sparseCells) {
        if (cell.kind === 'formula') {
          cells.set(key(cell.sheet, cell.addr), {
            sheet: cell.sheet,
            addr: cell.addr.toUpperCase(),
            display: '',
            type: 'null',
            isError: false,
            formula: cell.value,
          })
        } else {
          storeCell(cell.sheet, cell.addr, { type: cell.kind, value: cell.value } as CellWire)
        }
      }
      return sparseCells.length
    },
    async beginImport(sessionIdOrOptions?: number | BeginImportOptionsWire) {
      const sessionId = typeof sessionIdOrOptions === 'number' ? sessionIdOrOptions : 1
      calls.beginImport.push(sessionId)
      return sessionId
    },
    async importChunk(sessionId: number, importCells: ImportCellWire[]) {
      calls.importChunk.push({ sessionId, cells: importCells })
      for (const cell of importCells) {
        const addr = `${String.fromCharCode(65 + cell.col)}${cell.row + 1}`
        if (cell.kind === 'formula') {
          await this.setFormula(cell.sheet, addr, cell.value)
        } else if (cell.kind === 'null') {
          await this.clearCell(cell.sheet, addr)
        } else {
          await this.setCell(cell.sheet, addr, { type: cell.kind, value: cell.value } as CellWire)
        }
      }
      return importCells.length
    },
    async commitImport(sessionId: number): Promise<WorkbookImportStatsWire> {
      calls.commitImport.push(sessionId)
      return { accepted: 0, formulas: 0, rejectedFormulas: 0, cleared: 0, errors: 0 }
    },
    async cancelImport(sessionId: number) {
      calls.cancelImport.push(sessionId)
      return true
    },
    async readCells(refs) {
      calls.readCells.push(refs.map((ref) => ({ ...ref, addr: ref.addr.toUpperCase() })))
      return refs.map((ref) => cells.get(key(ref.sheet, ref.addr)) ?? emptySnapshot(ref))
    },
    async listNonEmpty() {
      return [...cells.values()].map((cell) => ({ sheet: cell.sheet, addr: cell.addr }))
    },
    async snapshotSparse() {
      calls.snapshotSparse += 1
      const out: SparseCellWire[] = []
      for (const [, snapshot] of cells.entries()) {
        const parsed = parseCellAddress(snapshot.addr)
        if (snapshot.formula !== '') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'formula',
            value: snapshot.formula,
          })
        } else if (snapshot.type === 'number') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'number',
            value: Number(snapshot.display),
          })
        } else if (snapshot.type === 'text') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'text',
            value: snapshot.display,
          })
        } else if (snapshot.type === 'boolean') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'boolean',
            value: snapshot.display === 'TRUE',
          })
        } else if (snapshot.type === 'error') {
          out.push({
            sheet: snapshot.sheet,
            addr: snapshot.addr,
            row: parsed.row,
            col: parsed.col,
            kind: 'error',
            value: snapshot.display,
          })
        }
      }
      return out
    },
    async snapshotPersistenceV1() {
      calls.snapshotPersistenceV1 += 1
      const sparseCells = await this.snapshotSparse()
      return {
        version: 1,
        sheets: metas,
        cells: sparseCells,
        formats: [],
        sizes: [],
      }
    },
    async restorePersistenceV1(snapshot: WorkbookPersistenceSnapshotWire) {
      calls.restorePersistenceV1.push(snapshot)
      metas = snapshot.sheets.map((sheet) => ({ idx: sheet.idx, name: sheet.name }))
      cells.clear()
      await this.restoreSparse(snapshot.cells)
      return {
        restored_cells: snapshot.cells.length,
        restored_formats: snapshot.formats?.length ?? 0,
        sheets: snapshot.sheets.length,
      } satisfies WorkbookPersistenceRestoreStatsWire
    },
    async readSparseRange(_range: SparseRangeWire) {
      calls.readSparseRange.push({
        sheet: _range.sheet,
        startRow: _range.startRow,
        startCol: _range.startCol,
        endRow: _range.endRow,
        endCol: _range.endCol,
      })
      const out: CellSnapshotWire[] = []
      for (const [, snapshot] of cells.entries()) {
        if (snapshot.sheet !== _range.sheet) continue
        if (!inRange(snapshot.addr, _range)) continue
        out.push(snapshot)
      }
      return out
    },
    async debugFormulaCacheState(sheet, addr) {
      calls.debugFormulaCacheState.push({ sheet, addr: addr.toUpperCase() })
      return 'dirty'
    },
    async debugFormulaEvalCount() {
      return 0
    },
    async debugCounters() {
      calls.debugCounters += 1
      return {
        sheetCount: metas.length,
        crossSheetDependents: 0,
        formulaCount: [...cells.values()].filter((cell) => cell.formula !== '').length,
        formulaEvalCountTotal: 0,
        liveSubscriptionCount: calls.subscribeCells.length - calls.unsubscribeCells.length,
        workerSubscriptionCount: calls.subscribeCells.length - calls.unsubscribeCells.length,
        importSessionCount: 0,
        exportSessionCount: 0,
        snapshotSessionCount: 0,
        sheets: metas.map((meta) => ({
          idx: meta.idx,
          name: meta.name,
          formulaCount: [...cells.values()].filter(
            (cell) => cell.sheet === meta.idx && cell.formula !== '',
          ).length,
          formulaEvalCount: 0,
          liveSubscriptionCount: 0,
        })),
      } satisfies WorkerWorkbookDebugCountersWire
    },
    async subscribeCells(refs) {
      calls.subscribeCells.push(refs.map((ref) => ({ ...ref, addr: ref.addr.toUpperCase() })))
      return nextSubId++
    },
    async unsubscribeCells(subId) {
      calls.unsubscribeCells.push(subId)
      return true
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
    dispose() {
      dirtyListeners.clear()
      hydratedListeners.clear()
    },
  }
}

function withRoot<T>(fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      Promise.resolve(fn()).then(resolve, reject).finally(dispose)
    })
  })
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < 20; i++) {
    try {
      assertion()
      return
    } catch (err) {
      lastErr = err
      await Promise.resolve()
    }
  }
  throw lastErr
}

describe('createWorkerWorkbookStore', () => {
  it('initializes a single Sheet1 worker workbook by default', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })

      expect(client.calls.initWorkbook).toEqual([['Sheet1']])
      expect(workbook.sheets()).toEqual([{ idx: 0, name: 'Sheet1' }])

      workbook.dispose()
    })
  })

  it('adds a sheet with default naming and refreshes metadata', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({
        client,
        sheets: ['Sheet1', 'Expenses', 'Notes'],
      })

      const idx = await workbook.addSheet()

      expect(idx).toBe(3)
      expect(client.calls.addSheet).toEqual(['Sheet4'])
      expect(client.calls.sheetList).toHaveLength(1)
      expect(workbook.sheets()).toEqual([
        { idx: 0, name: 'Sheet1' },
        { idx: 1, name: 'Expenses' },
        { idx: 2, name: 'Notes' },
        { idx: 3, name: 'Sheet4' },
      ])
      expect(workbook.indexOf('Sheet4')).toBe(3)

      workbook.dispose()
    })
  })

  it('renameSheet refreshes metadata and does not optimistic update on duplicate or failed RPC', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({
        client,
        sheets: ['Sheet1', 'Data'],
      })

      const duplicate = await workbook.renameSheet(0, 'Data')
      expect(duplicate).toBe(false)
      expect(client.calls.renameSheet).toEqual([])
      expect(client.calls.sheetList).toEqual([])
      expect(workbook.sheets()[0].name).toBe('Sheet1')
      expect(workbook.indexOf('Sheet1')).toBe(0)

      const failingClient = makeFakeWorkerWorkbookClient({
        failRenameSheet: () => true,
      })
      const failingWorkbook = await createWorkerWorkbookStore({
        client: failingClient,
        sheets: ['Sheet1', 'Data'],
      })
      const failed = await failingWorkbook.renameSheet(0, 'Summary')

      expect(failed).toBe(false)
      expect(failingClient.calls.renameSheet).toEqual([{ sheet: 0, name: 'Summary' }])
      expect(failingClient.calls.sheetList).toEqual([])
      expect(failingWorkbook.sheets()).toEqual([
        { idx: 0, name: 'Sheet1' },
        { idx: 1, name: 'Data' },
      ])

      const succeeded = await workbook.renameSheet(1, 'Summary')
      expect(succeeded).toBe(true)
      expect(workbook.sheets()[1].name).toBe('Summary')
      expect(workbook.indexOf('Summary')).toBe(1)
      expect(client.calls.renameSheet).toEqual([{ sheet: 1, name: 'Summary' }])
      expect(client.calls.sheetList).toHaveLength(1)

      workbook.dispose()
      failingWorkbook.dispose()
    })
  })

  it('removeSheet rebuilds adapters, adjusts activeIdx, and disposes stale subscriptions', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({
        client,
        sheets: ['Sheet1', 'A', 'B'],
      })
      workbook.setActiveIdx(2)
      const before = workbook.sheetAt(1)!
      const observed = before.observeCell('A1')

      expect(workbook.sheets().map((sheet) => sheet.name)).toEqual(['Sheet1', 'A', 'B'])
      expect(client.calls.subscribeCells).toEqual([[{ sheet: 1, addr: 'A1' }]])
      expect(workbook.activeIdx()).toBe(2)

      const removed = await workbook.removeSheet(0)
      expect(removed).toBe(true)
      expect(workbook.sheets().map((sheet) => sheet.name)).toEqual(['A', 'B'])
      expect(workbook.activeIdx()).toBe(1)
      expect(workbook.sheetAt(1)).not.toBe(before)

      await waitFor(() => {
        expect(client.calls.unsubscribeCells).toHaveLength(1)
      })

      observed.dispose()
      workbook.dispose()
    })
  })

  it('prevents deleting the last sheet and keeps metadata unchanged', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })

      const removed = await workbook.removeSheet(0)
      expect(removed).toBe(false)
      expect(client.calls.removeSheet).toEqual([])
      expect(workbook.sheets()).toEqual([{ idx: 0, name: 'Sheet1' }])

      workbook.dispose()
    })
  })

  it('keeps sheet metadata when addSheet fails before or after RPC commit', async () => {
    await withRoot(async () => {
      const failingAdd = makeFakeWorkerWorkbookClient({
        failAddSheet: () => true,
      })
      const failAddResult = await createWorkerWorkbookStore({ client: failingAdd })
      expect(await failAddResult.addSheet()).toBe(-1)
      expect(failingAdd.calls.addSheet).toEqual(['Sheet2'])
      expect(failingAdd.calls.sheetList).toEqual([])
      expect(failAddResult.sheets()).toEqual([{ idx: 0, name: 'Sheet1' }])
      failAddResult.dispose()

      const failingAfterRpc = makeFakeWorkerWorkbookClient({
        failSheetList: () => true,
      })
      const failAfterResult = await createWorkerWorkbookStore({
        client: failingAfterRpc,
      })
      expect(await failAfterResult.addSheet()).toBe(-1)
      expect(failingAfterRpc.calls.addSheet).toEqual(['Sheet2'])
      expect(failingAfterRpc.calls.sheetList).toHaveLength(1)
      expect(failAfterResult.sheets()).toEqual([{ idx: 0, name: 'Sheet1' }])
      failAfterResult.dispose()
    })
  })

  it('routes large clears through worker clearRange without expanding cells', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      await store.clearSelectionRangeAsync()

      expect(client.calls.snapshotRangeSparse).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])
      expect(client.calls.clearRange).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])
      expect(client.calls.clearCell).toEqual([])

      workbook.dispose()
    })
  })

  it('routes structural edits through worker workbook RPCs', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      store.insertRow(2, 3)
      store.deleteRow(4, 1)
      store.insertCol(5, 2)
      store.deleteCol(6, 1)

      await waitFor(() => {
        expect(client.calls.insertRows).toEqual([{ sheet: 0, rowIndex: 2, count: 3 }])
        expect(client.calls.deleteRows).toEqual([{ sheet: 0, rowIndex: 4, count: 1 }])
        expect(client.calls.insertColumns).toEqual([{ sheet: 0, colIndex: 5, count: 2 }])
        expect(client.calls.deleteColumns).toEqual([{ sheet: 0, colIndex: 6, count: 1 }])
      })

      workbook.dispose()
    })
  })

  it('routes large selection formats through worker setFormatRange without expanding cells', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      expect(store.formatSelection((current) => ({ ...current, bold: true }))).toBe(true)
      await waitFor(() => {
        expect(store.canUndo()).toBe(true)
      })

      expect(client.calls.snapshotFormatRange).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])
      expect(client.calls.setFormatRange).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999, fmt: { bold: true } },
      ])
      store.undo()
      await waitFor(() => {
        expect(client.calls.restoreFormatSnapshot).toHaveLength(1)
      })

      workbook.dispose()
    })
  })

  it('routes large selection copy through worker chunked range TSV export', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      store.raw.set_number('A1', 1)
      store.raw.set_formula('A2', '=A1+1')
      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 10_000, col: 0 })

      const text = await store.copySelectionTextAsync()

      expect(text?.startsWith('# einfach-clipboard-origin: A1\n1\n=A1+1\n')).toBe(true)
      expect(client.calls.exportRangeTsvChunks).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 10_000, endCol: 0, rowsPerChunk: 2048 },
      ])
      expect(client.calls.exportRangeTsv).toEqual([])
      expect(client.calls.readCells).toEqual([])
      expect(client.calls.snapshotRangeSparse).toEqual([])

      workbook.dispose()
    })
  })

  it('uses backend sparse-range snapshot for large selection clear and restores values + formulas', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      store.setNumber('A1', 10)
      store.setText('A2', 'hello')
      store.setFormula('B2', '=A1+1')
      client.emitHydrated([
        {
          sheet: 0,
          addr: 'B2',
          display: '11',
          type: 'number',
          isError: false,
          formula: '=A1+1',
        },
      ])

      expect(store.getFormula('B2')).toBe('=A1+1')

      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      await store.clearSelectionRangeAsync()

      expect(client.calls.snapshotRangeSparse).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])
      expect(client.calls.clearRange).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])
      expect(client.calls.readSparseRange).toEqual([])
      expect(store.canUndo()).toBe(true)

      await waitFor(() => {
        expect(store.getCell('A1').type).toBe('null')
        expect(store.getCell('A2').type).toBe('null')
        expect(store.getFormula('B2')).toBe('')
      })

      store.undo()
      expect(client.calls.restoreSparse).toHaveLength(1)

      await waitFor(() => {
        expect(store.getCell('A1').display).toBe('10')
        expect(store.getCell('A2').display).toBe('hello')
        expect(store.getFormula('B2')).toBe('=A1+1')
      })
      expect(store.canRedo()).toBe(true)

      workbook.dispose()
    })
  })

  it('does not expose cache-derived non_empty_addrs as worker authority', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      expect(store.raw.non_empty_addrs).toBeUndefined()

      workbook.dispose()
    })
  })

  it('does not hydrate formula results for unobserved raw seed formulas', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })

      workbook.activeStore().raw.set_formula('B2', '=A1+1')
      await Promise.resolve()

      expect(client.calls.setFormula).toEqual([{ sheet: 0, addr: 'B2', formula: '=A1+1' }])
      expect(client.calls.readCells).toEqual([])

      workbook.dispose()
    })
  })

  it('can seed the worker workbook through afterInit before stores mount', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({
        client,
        async afterInit(worker) {
          const session = await worker.beginImport()
          await worker.importChunk(session, [
            { sheet: 0, row: 0, col: 0, kind: 'number', value: 41 },
            { sheet: 0, row: 1, col: 1, kind: 'formula', value: '=A1+1' },
          ])
          await worker.commitImport(session)
        },
      })

      expect(client.calls.beginImport).toEqual([1])
      expect(client.calls.importChunk).toHaveLength(1)
      expect(client.calls.commitImport).toEqual([1])
      expect(client.calls.readCells).toEqual([])

      workbook.dispose()
    })
  })

  it('hydrates subscribed cells through worker workbook pushes', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()
      const observed = store.observeCell('A1')

      expect(observed.value().display).toBe('')
      client.emitHydrated([
        {
          sheet: 0,
          addr: 'A1',
          display: '7',
          type: 'number',
          isError: false,
          formula: '',
        },
      ])

      expect(client.calls.subscribeCells).toEqual([[{ sheet: 0, addr: 'A1' }]])
      expect(observed.value().display).toBe('7')

      observed.dispose()
      workbook.dispose()
    })
  })

  it('rolls back optimistic formula projection when the worker rejects it', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      store.raw.set_number('A1', 7)
      const observed = store.observeCell('A1')
      expect(observed.value().display).toBe('7')

      client.setFormulaResult(0, 'A1', false)
      expect(store.raw.set_formula('A1', '=A1+1')).toBe(true)
      expect(client.calls.setFormula).toEqual([{ sheet: 0, addr: 'A1', formula: '=A1+1' }])
      expect(store.getFormula('A1')).toBe('=A1+1')

      await waitFor(() => {
        expect(observed.value().display).toBe('7')
        expect(store.getFormula('A1')).toBe('')
      })

      expect(client.calls.readCells).toContainEqual([{ sheet: 0, addr: 'A1' }])

      observed.dispose()
      workbook.dispose()
    })
  })

  it('surfaces detailed formula rejection without creating an undo entry', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      client.setFormulaResult(0, 'A1', false)
      const result = await store.setFormulaDetailedAsync('A1', '=A1+1')

      expect(client.calls.setFormulaDetailed).toEqual([
        { sheet: 0, addr: 'A1', formula: '=A1+1' },
      ])
      expect(result).toEqual({ ok: false, code: 'FORMULA_REJECTED', message: 'formula was rejected' })
      await waitFor(() => {
        expect(store.getFormula('A1')).toBe('')
      })
      expect(store.canUndo()).toBe(false)

      workbook.dispose()
    })
  })

  it('pushes undo state for successful setFormulaDetailedAsync', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      const result = await store.setFormulaDetailedAsync('A1', '=1')

      expect(result).toEqual({ ok: true })
      await waitFor(() => {
        expect(store.canUndo()).toBe(true)
      })
      expect(store.getFormula('A1')).toBe('=1')

      store.undo()
      expect(store.getFormula('A1')).toBe('')

      workbook.dispose()
    })
  })

  it('surfaces authoritative formula rejection through setFormulaAsync without an undo entry', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      client.setFormulaResult(0, 'A1', false)
      const result = store.setFormulaAsync('A1', '=A1+1')

      expect(store.getFormula('A1')).toBe('=A1+1')
      await expect(result).resolves.toBe(false)
      await waitFor(() => {
        expect(store.getFormula('A1')).toBe('')
      })
      expect(store.canUndo()).toBe(false)

      workbook.dispose()
    })
  })

  it('routes setCellInputAsync formula rejection through the authoritative worker command', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      client.setFormulaResult(0, 'A1', false)
      await expect(store.setCellInputAsync('A1', '=A1+1')).resolves.toBe(false)

      expect(client.calls.setFormula).toEqual([{ sheet: 0, addr: 'A1', formula: '=A1+1' }])
      await waitFor(() => {
        expect(store.getFormula('A1')).toBe('')
      })
      expect(store.canUndo()).toBe(false)

      workbook.dispose()
    })
  })

  it('pastes formula cells through the authoritative async formula path and keeps undo coherent', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()

      const data = {
        originAddr: 'B1',
        cells: [['=A1+1', '7']],
      }

      await Promise.resolve(store.paste('D5', data))

      expect(client.calls.setFormula).toEqual([{ sheet: 0, addr: 'D5', formula: '=C5+1' }])
      expect(store.getFormula('D5')).toBe('=C5+1')
      expect(store.getCell('E5').display).toBe('7')
      expect(store.canUndo()).toBe(true)

      store.undo()
      expect(store.getFormula('D5')).toBe('')
      expect(store.getCell('D5').type).toBe('null')
      expect(store.getCell('E5').type).toBe('null')

      workbook.dispose()
    })
  })

  it('returns unknown immediately for formula cache state then updates from worker probe', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      let resolveProbe: (value: string) => void
      const pendingProbe = new Promise<string>((resolve) => {
        resolveProbe = resolve
      })
      client.debugFormulaCacheState = async (sheet, addr) => {
        client.calls.debugFormulaCacheState.push({ sheet, addr: addr.toUpperCase() })
        return pendingProbe
      }

      const workbook = await createWorkerWorkbookStore({ client })
      expect(workbook.formulaCacheState(0, 'a1')).toBe('unknown')
      expect(workbook.formulaCacheState(0, 'a1')).toBe('unknown')
      expect(client.calls.debugFormulaCacheState).toEqual([{ sheet: 0, addr: 'A1' }])

      resolveProbe!('clean')
      await waitFor(() => {
        expect(workbook.formulaCacheState(0, 'a1')).toBe('clean')
      })
      expect(client.calls.debugFormulaCacheState).toHaveLength(1)

      workbook.dispose()
    })
  })

  it('ignores stale subscription hydration after a newer optimistic write', async () => {
    await withRoot(async () => {
      const client = makeFakeWorkerWorkbookClient()
      const workbook = await createWorkerWorkbookStore({ client })
      const store = workbook.activeStore()
      const observed = store.observeCell('A1')

      store.raw.set_number('A1', 9)
      expect(observed.value().display).toBe('9')

      client.emitHydrated([
        {
          sheet: 0,
          addr: 'A1',
          display: '1',
          type: 'number',
          isError: false,
          formula: '',
        },
      ])

      expect(observed.value().display).toBe('9')

      observed.dispose()
      workbook.dispose()
    })
  })
})
