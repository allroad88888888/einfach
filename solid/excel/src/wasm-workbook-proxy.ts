import type { CellValue } from './types'

type CellType = CellValue['type']

export interface WorkerLike {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  terminate(): void
}

export interface WorkerWorkbookOptions {
  workerFactory: () => WorkerLike
}

export type CellWire =
  | { type: 'number'; value: number }
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'error'; value: string }
  | { type: 'null' }

// Zero-based import coordinates: `{ row: 0, col: 0 }` means A1.
export type ImportCellWire =
  | { sheet: number; row: number; col: number; kind: 'number'; value: number }
  | { sheet: number; row: number; col: number; kind: 'text'; value: string }
  | { sheet: number; row: number; col: number; kind: 'boolean'; value: boolean }
  | { sheet: number; row: number; col: number; kind: 'error'; value: string }
  | { sheet: number; row: number; col: number; kind: 'formula'; value: string }
  | { sheet: number; row: number; col: number; kind: 'null' }

export interface WorkbookImportStatsWire {
  accepted: number
  formulas: number
  rejectedFormulas: number
  cleared: number
  errors: number
}

export type SparseCellWire =
  | { sheet: number; addr: string; row: number; col: number; kind: 'number'; value: number }
  | { sheet: number; addr: string; row: number; col: number; kind: 'text'; value: string }
  | { sheet: number; addr: string; row: number; col: number; kind: 'boolean'; value: boolean }
  | { sheet: number; addr: string; row: number; col: number; kind: 'error'; value: string }
  | { sheet: number; addr: string; row: number; col: number; kind: 'formula'; value: string }

export interface SparseRangeWire {
  sheet: number
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

export interface CellRefWire {
  sheet: number
  addr: string
}

export interface CellSnapshotWire extends CellRefWire {
  display: string
  type: CellType
  isError: boolean
  formula: string
}

export interface WorkbookSheetMeta {
  idx: number
  name: string
}

export interface RpcErrorWire {
  code: string
  message: string
}

export type RpcResponseWire =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: RpcErrorWire }

export type RpcEventWire =
  | { event: 'cellsDirty'; cells: CellRefWire[] }
  | { event: 'cellsHydrated'; cells: CellSnapshotWire[]; subId?: number }

export interface WorkerWorkbookClient {
  initWorkbook(sheets?: string[]): Promise<WorkbookSheetMeta[]>
  sheetList(): Promise<WorkbookSheetMeta[]>
  addSheet(name: string): Promise<number>
  renameSheet(sheet: number, name: string): Promise<boolean>
  removeSheet(sheet: number): Promise<boolean>
  setCell(sheet: number, addr: string, value: CellWire): Promise<boolean>
  setFormula(sheet: number, addr: string, formula: string): Promise<boolean>
  clearCell(sheet: number, addr: string): Promise<boolean>
  clearRange(range: SparseRangeWire): Promise<number>
  beginImport(sessionId?: number): Promise<number>
  importChunk(sessionId: number, cells: ImportCellWire[]): Promise<number>
  commitImport(sessionId: number): Promise<WorkbookImportStatsWire>
  cancelImport(sessionId: number): Promise<boolean>
  readCells(cells: CellRefWire[]): Promise<CellSnapshotWire[]>
  listNonEmpty(): Promise<CellRefWire[]>
  snapshotSparse(): Promise<SparseCellWire[]>
  readSparseRange(range: SparseRangeWire): Promise<CellSnapshotWire[]>
  debugFormulaCacheState(sheet: number, addr: string): Promise<string>
  debugFormulaEvalCount(sheet: number): Promise<number>
  subscribeCells(cells: CellRefWire[], callback: (cells: CellRefWire[]) => void): Promise<number>
  unsubscribeCells(subId: number): Promise<boolean>
  onCellsDirty(callback: (cells: CellRefWire[]) => void): () => void
  onCellsHydrated(callback: (cells: CellSnapshotWire[]) => void): () => void
  dispose(): void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

type Subscriber = {
  keys: Set<string>
  callback: (cells: CellRefWire[]) => void
}

function normalizeRef(ref: CellRefWire): CellRefWire {
  return {
    sheet: ref.sheet,
    addr: ref.addr.toUpperCase(),
  }
}

function cellKey(ref: CellRefWire): string {
  return `${ref.sheet}:${ref.addr.toUpperCase()}`
}

function toError(error: RpcErrorWire): Error {
  const err = new Error(error.message)
  return Object.assign(err, { code: error.code })
}

export function createWorkerWorkbook(opts: WorkerWorkbookOptions): WorkerWorkbookClient {
  const worker = opts.workerFactory()
  let nextId = 1
  let nextSubId = 1
  let nextImportId = 1
  let disposed = false
  const pending = new Map<number, PendingRequest>()
  const subscribers = new Map<number, Subscriber>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
  const hydratedListeners = new Set<(cells: CellSnapshotWire[]) => void>()

  function request<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (disposed) return Promise.reject(new Error('worker workbook disposed'))
    const id = nextId++
    worker.postMessage({ id, cmd, ...payload })
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
    })
  }

  function handleResponse(msg: RpcResponseWire): boolean {
    const entry = pending.get(msg.id)
    if (!entry) return true
    pending.delete(msg.id)
    if (msg.ok) {
      entry.resolve(msg.result)
    } else {
      entry.reject(toError(msg.error))
    }
    return true
  }

  function handleDirty(cells: CellRefWire[]) {
    const normalized = cells.map(normalizeRef)
    for (const listener of dirtyListeners) listener(normalized)
    for (const sub of subscribers.values()) {
      const matches = normalized.filter((cell) => sub.keys.has(cellKey(cell)))
      if (matches.length > 0) sub.callback(matches)
    }
  }

  function handleHydrated(cells: CellSnapshotWire[]) {
    const normalized = cells.map((cell) => ({
      ...cell,
      addr: cell.addr.toUpperCase(),
    }))
    for (const listener of hydratedListeners) listener(normalized)
  }

  const onWorkerMessage = (e: MessageEvent) => {
    const msg = (e.data ?? {}) as Partial<RpcResponseWire & RpcEventWire>
    if (typeof msg.id === 'number' && typeof msg.ok === 'boolean') {
      handleResponse(msg as RpcResponseWire)
      return
    }
    if (msg.event === 'cellsDirty') {
      handleDirty(Array.isArray(msg.cells) ? msg.cells : [])
      return
    }
    if (msg.event === 'cellsHydrated') {
      handleHydrated(Array.isArray(msg.cells) ? (msg.cells as CellSnapshotWire[]) : [])
    }
  }

  worker.addEventListener('message', onWorkerMessage)

  return {
    initWorkbook(sheets) {
      return request<WorkbookSheetMeta[]>('initWorkbook', { sheets })
    },
    sheetList() {
      return request<WorkbookSheetMeta[]>('sheetList')
    },
    addSheet(name) {
      return request<number>('addSheet', { name })
    },
    renameSheet(sheet, name) {
      return request<boolean>('renameSheet', { sheet, name })
    },
    removeSheet(sheet) {
      return request<boolean>('removeSheet', { sheet })
    },
    setCell(sheet, addr, value) {
      return request<boolean>('setCell', { sheet, addr: addr.toUpperCase(), value })
    },
    setFormula(sheet, addr, formula) {
      return request<boolean>('setFormula', { sheet, addr: addr.toUpperCase(), formula })
    },
    clearCell(sheet, addr) {
      return request<boolean>('clearCell', { sheet, addr: addr.toUpperCase() })
    },
    clearRange(range) {
      return request<number>('clearRange', { range })
    },
    beginImport(sessionId = nextImportId++) {
      return request<number>('beginImport', { sessionId })
    },
    importChunk(sessionId, cells) {
      return request<number>('importChunk', { sessionId, cells })
    },
    commitImport(sessionId) {
      return request<WorkbookImportStatsWire>('commitImport', { sessionId })
    },
    cancelImport(sessionId) {
      return request<boolean>('cancelImport', { sessionId })
    },
    readCells(cells) {
      return request<CellSnapshotWire[]>('readCells', { cells: cells.map(normalizeRef) })
    },
    listNonEmpty() {
      return request<CellRefWire[]>('listNonEmpty')
    },
    snapshotSparse() {
      return request<SparseCellWire[]>('snapshotSparse')
    },
    readSparseRange(range) {
      return request<CellSnapshotWire[]>('readSparseRange', { range })
    },
    debugFormulaCacheState(sheet, addr) {
      return request<string>('debugFormulaCacheState', { sheet, addr: addr.toUpperCase() })
    },
    debugFormulaEvalCount(sheet) {
      return request<number>('debugFormulaEvalCount', { sheet })
    },
    async subscribeCells(cells, callback) {
      const subId = nextSubId++
      const normalized = cells.map(normalizeRef)
      subscribers.set(subId, {
        keys: new Set(normalized.map(cellKey)),
        callback,
      })
      try {
        await request<boolean>('subscribeCells', { subId, cells: normalized })
        return subId
      } catch (err) {
        subscribers.delete(subId)
        throw err
      }
    },
    async unsubscribeCells(subId) {
      subscribers.delete(subId)
      return request<boolean>('unsubscribeCells', { subId })
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
      if (disposed) return
      disposed = true
      worker.removeEventListener('message', onWorkerMessage)
      for (const entry of pending.values()) entry.reject(new Error('worker workbook disposed'))
      pending.clear()
      subscribers.clear()
      dirtyListeners.clear()
      hydratedListeners.clear()
      worker.terminate()
    },
  }
}
