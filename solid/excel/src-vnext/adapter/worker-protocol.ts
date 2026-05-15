import type { SpreadsheetCellFormat } from '@einfach/spreadsheet-ui-core'

export type CellFormatJSON = SpreadsheetCellFormat

export interface CellFormatSnapshot {
  addr: string
  format: CellFormatJSON
}

export interface RangeFormatLayerSnapshot {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
  format: CellFormatJSON
}

export interface FormatRangeSnapshot {
  sheet?: number
  startRow: number
  startCol: number
  endRow: number
  endCol: number
  cellFormats: CellFormatSnapshot[]
  rangeFormats: RangeFormatLayerSnapshot[]
}

export type FormulaMutationErrorCode = 'INVALID_FORMULA' | 'FORMULA_CYCLE' | 'FORMULA_REJECTED'

export type FormulaMutationResult =
  | { ok: true }
  | { ok: false; code: FormulaMutationErrorCode; message: string; display?: string }

type CellType = 'number' | 'text' | 'boolean' | 'error' | 'null'
const DEFAULT_EXPORT_ROWS_PER_CHUNK = 2048
const MIN_EXPORT_ROWS_PER_CHUNK = 1
const MAX_EXPORT_ROWS_PER_CHUNK = 10_000

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

export interface ImportCellIssueWire {
  sheet?: number
  row?: number
  col?: number
  kind?: string
  code: string
  message: string
}

export interface WorkbookImportStatsWire {
  accepted: number
  formulas: number
  rejectedFormulas: number
  cleared: number
  errors: number
  issues?: ImportCellIssueWire[]
}

export type ImportSessionModeWire = 'atomic' | 'direct'

export interface BeginImportOptionsWire {
  mode?: ImportSessionModeWire
  atomic?: boolean
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

export interface SparseRangeSnapshotSessionWire {
  sessionId: number
  totalRows: number
  rowsPerChunk: number
}

export interface SparseRangeSnapshotChunkWire {
  sessionId: number
  startRow: number
  endRow: number
  cells: SparseCellWire[]
  done: boolean
}

export interface ExportRangeTsvSessionWire {
  sessionId: number
  totalRows: number
  rowsPerChunk: number
}

export interface ExportRangeTsvChunkWire {
  sessionId: number
  startRow: number
  endRow: number
  chunk: string
  done: boolean
}

export type ExportRangeTsvChunkConsumerWire = (
  chunk: ExportRangeTsvChunkWire,
) => void | Promise<void>

export interface ViewportRowHeightWire {
  rowIndex: number
  heightPx: number
}

export interface ViewportColumnWidthWire {
  colIndex: number
  widthPx: number
}

export interface ViewportSizeSnapshotWire extends SparseRangeWire {
  rowHeights: ViewportRowHeightWire[]
  colWidths: ViewportColumnWidthWire[]
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

export type FormulaMutationResultWire = FormulaMutationResult

export interface WorkbookPersistenceSheetWire {
  idx: number
  name: string
  rowCount?: number
  colCount?: number
}

export interface WorkbookPersistenceSnapshotWire {
  version: 1
  sheets: WorkbookPersistenceSheetWire[]
  cells: SparseCellWire[]
  formats?: FormatRangeSnapshot[]
  sizes?: ViewportSizeSnapshotWire[]
}

export interface WorkbookPersistenceRestoreStatsWire {
  restored_cells: number
  restored_formats: number
  sheets: number
}

export interface WorkerWorkbookSheetDebugCountersWire {
  idx: number
  name: string
  formulaCount: number
  formulaEvalCount: number
  liveSubscriptionCount: number
}

export interface WorkerWorkbookDebugCountersWire {
  sheetCount: number
  crossSheetDependents: number
  formulaCount: number
  formulaEvalCountTotal: number
  liveSubscriptionCount: number
  workerSubscriptionCount: number
  importSessionCount: number
  exportSessionCount: number
  snapshotSessionCount: number
  sheets: WorkerWorkbookSheetDebugCountersWire[]
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
  moveSheet(from: number, to: number): Promise<boolean>
  setCell(sheet: number, addr: string, value: CellWire): Promise<boolean>
  setFormula(sheet: number, addr: string, formula: string): Promise<boolean>
  setFormulaDetailed(
    sheet: number,
    addr: string,
    formula: string,
  ): Promise<FormulaMutationResultWire>
  clearCell(sheet: number, addr: string): Promise<boolean>
  clearRange(range: SparseRangeWire): Promise<number>
  insertRows(sheet: number, rowIndex: number, count: number): Promise<boolean>
  deleteRows(sheet: number, rowIndex: number, count: number): Promise<boolean>
  insertColumns(sheet: number, colIndex: number, count: number): Promise<boolean>
  deleteColumns(sheet: number, colIndex: number, count: number): Promise<boolean>
  setFormatRange(range: SparseRangeWire, fmt: CellFormatJSON | null | undefined): Promise<number>
  snapshotFormatRange(range: SparseRangeWire): Promise<FormatRangeSnapshot>
  restoreFormatSnapshot(snapshot: FormatRangeSnapshot): Promise<number>
  beginImport(
    sessionIdOrOptions?: number | BeginImportOptionsWire,
    options?: BeginImportOptionsWire,
  ): Promise<number>
  importChunk(sessionId: number, cells: ImportCellWire[]): Promise<number>
  commitImport(sessionId: number): Promise<WorkbookImportStatsWire>
  cancelImport(sessionId: number): Promise<boolean>
  readCells(cells: CellRefWire[]): Promise<CellSnapshotWire[]>
  listNonEmpty(): Promise<CellRefWire[]>
  snapshotSparse(): Promise<SparseCellWire[]>
  snapshotRangeSparse(range: SparseRangeWire): Promise<SparseCellWire[]>
  beginSnapshotRangeSparse(
    range: SparseRangeWire,
    rowsPerChunk?: number,
  ): Promise<SparseRangeSnapshotSessionWire>
  nextSnapshotRangeSparseChunk(sessionId: number): Promise<SparseRangeSnapshotChunkWire>
  cancelSnapshot(sessionId: number): Promise<boolean>
  snapshotRangeSparseChunks(
    range: SparseRangeWire,
    rowsPerChunk?: number,
  ): Promise<SparseCellWire[][]>
  snapshotViewportSizes(range: SparseRangeWire): Promise<ViewportSizeSnapshotWire>
  setRowHeight(sheet: number, rowIndex: number, heightPx: number): Promise<boolean>
  setColumnWidth(sheet: number, colIndex: number, widthPx: number): Promise<boolean>
  snapshotPersistenceV1(): Promise<WorkbookPersistenceSnapshotWire>
  restorePersistenceV1(
    snapshot: WorkbookPersistenceSnapshotWire,
  ): Promise<WorkbookPersistenceRestoreStatsWire>
  exportRangeTsv(range: SparseRangeWire): Promise<string>
  beginExportRangeTsv(
    range: SparseRangeWire,
    rowsPerChunk?: number,
  ): Promise<ExportRangeTsvSessionWire>
  nextExportRangeTsvChunk(sessionId: number): Promise<ExportRangeTsvChunkWire>
  cancelExport(sessionId: number): Promise<boolean>
  consumeExportRangeTsvChunks?(
    range: SparseRangeWire,
    onChunk: ExportRangeTsvChunkConsumerWire,
    rowsPerChunk?: number,
  ): Promise<void>
  exportRangeTsvChunks(range: SparseRangeWire, rowsPerChunk?: number): Promise<string[]>
  restoreSparse(cells: SparseCellWire[]): Promise<number>
  readSparseRange(range: SparseRangeWire): Promise<CellSnapshotWire[]>
  debugFormulaCacheState(sheet: number, addr: string): Promise<string>
  debugFormulaEvalCount(sheet: number): Promise<number>
  debugCounters(): Promise<WorkerWorkbookDebugCountersWire>
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

  function clampRowsPerChunk(rowsPerChunk: number | undefined): number {
    const normalized = Math.floor(Number(rowsPerChunk))
    if (!Number.isFinite(normalized) || normalized < MIN_EXPORT_ROWS_PER_CHUNK)
      return MIN_EXPORT_ROWS_PER_CHUNK
    if (normalized > MAX_EXPORT_ROWS_PER_CHUNK) return MAX_EXPORT_ROWS_PER_CHUNK
    return normalized
  }

  async function consumeExportRangeTsvChunks(
    range: SparseRangeWire,
    onChunk: ExportRangeTsvChunkConsumerWire,
    rowsPerChunk = DEFAULT_EXPORT_ROWS_PER_CHUNK,
  ): Promise<void> {
    const session = await request<ExportRangeTsvSessionWire>('beginExportRangeTsv', {
      range,
      rowsPerChunk: clampRowsPerChunk(rowsPerChunk),
    })
    let done = false
    try {
      while (true) {
        const chunk = await request<ExportRangeTsvChunkWire>('nextExportRangeTsvChunk', {
          sessionId: session.sessionId,
        })
        await onChunk(chunk)
        if (chunk.done) break
      }
      done = true
    } finally {
      if (!done)
        await request<boolean>('cancelExport', { sessionId: session.sessionId }).catch(() => {})
    }
  }

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
    moveSheet(from, to) {
      return request<boolean>('moveSheet', { from, to })
    },
    setCell(sheet, addr, value) {
      return request<boolean>('setCell', { sheet, addr: addr.toUpperCase(), value })
    },
    setFormula(sheet, addr, formula) {
      return request<boolean>('setFormula', { sheet, addr: addr.toUpperCase(), formula })
    },
    setFormulaDetailed(sheet, addr, formula) {
      return request<FormulaMutationResultWire>('setFormulaDetailed', {
        sheet,
        addr: addr.toUpperCase(),
        formula,
      })
    },
    clearCell(sheet, addr) {
      return request<boolean>('clearCell', { sheet, addr: addr.toUpperCase() })
    },
    clearRange(range) {
      return request<number>('clearRange', { range })
    },
    insertRows(sheet, rowIndex, count) {
      return request<boolean>('insertRows', { sheet, rowIndex, count })
    },
    deleteRows(sheet, rowIndex, count) {
      return request<boolean>('deleteRows', { sheet, rowIndex, count })
    },
    insertColumns(sheet, colIndex, count) {
      return request<boolean>('insertColumns', { sheet, colIndex, count })
    },
    deleteColumns(sheet, colIndex, count) {
      return request<boolean>('deleteColumns', { sheet, colIndex, count })
    },
    setFormatRange(range, fmt) {
      return request<number>('setFormatRange', { range, fmt })
    },
    snapshotFormatRange(range) {
      return request<FormatRangeSnapshot>('snapshotFormatRange', { range })
    },
    restoreFormatSnapshot(snapshot) {
      return request<number>('restoreFormatSnapshot', { snapshot })
    },
    beginImport(sessionIdOrOptions, options) {
      const sessionId =
        typeof sessionIdOrOptions === 'number' ? sessionIdOrOptions : nextImportId++
      const importOptions =
        typeof sessionIdOrOptions === 'number' ? options : sessionIdOrOptions
      return request<number>('beginImport', { sessionId, ...(importOptions ?? {}) })
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
    snapshotRangeSparse(range) {
      return request<SparseCellWire[]>('snapshotRangeSparse', { range })
    },
    beginSnapshotRangeSparse(range, rowsPerChunk = DEFAULT_EXPORT_ROWS_PER_CHUNK) {
      return request<SparseRangeSnapshotSessionWire>('beginSnapshotRangeSparse', {
        range,
        rowsPerChunk: clampRowsPerChunk(rowsPerChunk),
      })
    },
    nextSnapshotRangeSparseChunk(sessionId) {
      return request<SparseRangeSnapshotChunkWire>('nextSnapshotRangeSparseChunk', { sessionId })
    },
    cancelSnapshot(sessionId) {
      return request<boolean>('cancelSnapshot', { sessionId })
    },
    async snapshotRangeSparseChunks(range, rowsPerChunk = DEFAULT_EXPORT_ROWS_PER_CHUNK) {
      const session = await request<SparseRangeSnapshotSessionWire>('beginSnapshotRangeSparse', {
        range,
        rowsPerChunk: clampRowsPerChunk(rowsPerChunk),
      })
      const chunks: SparseCellWire[][] = []
      let done = false
      try {
        while (true) {
          const chunk = await request<SparseRangeSnapshotChunkWire>(
            'nextSnapshotRangeSparseChunk',
            { sessionId: session.sessionId },
          )
          chunks.push(chunk.cells)
          if (chunk.done) break
        }
        done = true
        return chunks
      } finally {
        if (!done)
          await request<boolean>('cancelSnapshot', { sessionId: session.sessionId }).catch(
            () => {},
          )
      }
    },
    snapshotViewportSizes(range) {
      return request<ViewportSizeSnapshotWire>('snapshotViewportSizes', { range })
    },
    setRowHeight(sheet, rowIndex, heightPx) {
      return request<boolean>('setRowHeight', { sheet, rowIndex, heightPx })
    },
    setColumnWidth(sheet, colIndex, widthPx) {
      return request<boolean>('setColumnWidth', { sheet, colIndex, widthPx })
    },
    snapshotPersistenceV1() {
      return request<WorkbookPersistenceSnapshotWire>('snapshotPersistenceV1')
    },
    restorePersistenceV1(snapshot) {
      return request<WorkbookPersistenceRestoreStatsWire>('restorePersistenceV1', { snapshot })
    },
    exportRangeTsv(range) {
      return request<string>('exportRangeTsv', { range })
    },
    beginExportRangeTsv(range, rowsPerChunk = DEFAULT_EXPORT_ROWS_PER_CHUNK) {
      return request<ExportRangeTsvSessionWire>('beginExportRangeTsv', {
        range,
        rowsPerChunk: clampRowsPerChunk(rowsPerChunk),
      })
    },
    nextExportRangeTsvChunk(sessionId) {
      return request<ExportRangeTsvChunkWire>('nextExportRangeTsvChunk', { sessionId })
    },
    cancelExport(sessionId) {
      return request<boolean>('cancelExport', { sessionId })
    },
    consumeExportRangeTsvChunks,
    async exportRangeTsvChunks(range, rowsPerChunk = DEFAULT_EXPORT_ROWS_PER_CHUNK) {
      const chunks: string[] = []
      await consumeExportRangeTsvChunks(
        range,
        (chunk) => {
          chunks.push(chunk.chunk)
        },
        rowsPerChunk,
      )
      return chunks
    },
    restoreSparse(cells) {
      return request<number>('restoreSparse', { cells })
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
    debugCounters() {
      return request<WorkerWorkbookDebugCountersWire>('debugCounters')
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
