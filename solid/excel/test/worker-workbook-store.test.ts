/** @jsxImportSource solid-js */

import { describe, expect, it } from '@jest/globals'
import { createRoot } from 'solid-js'
import { createWorkerWorkbookStore } from '../src/wasm-workbook-store'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  ImportCellWire,
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
    readCells: CellRefWire[][]
    subscribeCells: CellRefWire[][]
    unsubscribeCells: number[]
    snapshotSparse: number
  }
  emitHydrated(cells: CellSnapshotWire[]): void
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
    readCells: [],
    subscribeCells: [],
    unsubscribeCells: [],
    snapshotSparse: 0,
  }
  const cells = new Map<string, CellSnapshotWire>()
  const hydratedListeners = new Set<(cells: CellSnapshotWire[]) => void>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
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
    async clearCell(sheet, addr) {
      calls.clearCell.push({ sheet, addr: addr.toUpperCase() })
      cells.delete(key(sheet, addr))
      return true
    },
    async clearRange(range) {
      calls.clearRange.push({ ...range })
      return 1
    },
    async beginImport(sessionId = 1) {
      return sessionId
    },
    async importChunk(_sessionId: number, _cells: ImportCellWire[]) {
      return 0
    },
    async commitImport(_sessionId: number): Promise<WorkbookImportStatsWire> {
      return { accepted: 0, formulas: 0, rejectedFormulas: 0, cleared: 0, errors: 0 }
    },
    async cancelImport(_sessionId: number) {
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
      return []
    },
    async debugFormulaCacheState() {
      return 'dirty'
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
      store.clearSelectionRange()

      expect(client.calls.clearRange).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])
      expect(client.calls.clearCell).toEqual([])

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
})
