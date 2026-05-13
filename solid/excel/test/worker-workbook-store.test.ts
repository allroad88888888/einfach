/** @jsxImportSource solid-js */

import { describe, expect, it } from '@jest/globals'
import { createRoot } from 'solid-js'
import { createWorkerWorkbookStore } from '../src/wasm-workbook-store'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  ImportCellWire,
  SparseCellWire,
  SparseRangeWire,
  WorkerWorkbookClient,
  WorkbookImportStatsWire,
  WorkbookSheetMeta,
} from '../src/wasm-workbook-proxy'

type ClearRangeCall = {
  sheet: number
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

type FakeWorkerWorkbookClient = WorkerWorkbookClient & {
  calls: {
    initWorkbook: string[][]
    setCell: Array<{ sheet: number; addr: string; value: CellWire }>
    setFormula: Array<{ sheet: number; addr: string; formula: string }>
    clearCell: Array<{ sheet: number; addr: string }>
    clearRange: ClearRangeCall[]
    snapshotRangeSparse: ClearRangeCall[]
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
    debugFormulaCacheState: Array<{ sheet: number; addr: string }>
  }
  emitHydrated(cells: CellSnapshotWire[]): void
  setFormulaResult(sheet: number, addr: string, result: boolean): void
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

function makeFakeWorkerWorkbookClient(): FakeWorkerWorkbookClient {
  const calls: FakeWorkerWorkbookClient['calls'] = {
    initWorkbook: [],
    setCell: [],
    setFormula: [],
    clearCell: [],
    clearRange: [],
    snapshotRangeSparse: [],
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
    debugFormulaCacheState: [],
  }
  const cells = new Map<string, CellSnapshotWire>()
  const hydratedListeners = new Set<(cells: CellSnapshotWire[]) => void>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
  const formulaResults = new Map<string, boolean>()
  let nextSubId = 1
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
      return metas
    },
    async addSheet(name) {
      const idx = metas.length
      metas = [...metas, { idx, name }]
      return idx
    },
    async renameSheet(sheet, name) {
      metas = metas.map((meta) => (meta.idx === sheet ? { ...meta, name } : meta))
      return true
    },
    async removeSheet(sheet) {
      metas = metas.filter((meta) => meta.idx !== sheet)
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
    async beginImport(sessionId = 1) {
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
      return []
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
