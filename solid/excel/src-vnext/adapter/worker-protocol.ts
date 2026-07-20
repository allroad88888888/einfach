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
  /**
   * Optional structured, command-specific rejection detail carried past
   * the flat `code`/`message` pair. `sortRange` uses it to forward the
   * engine's `{ code, anchor?, message? }` reject payload (`SortRangeRejectWire`)
   * — the RPC `code` is `SORT_REJECTED`, `detail.code` is the engine
   * reason. Absent for every other command.
   */
  detail?: unknown
}

export type FormulaMutationResultWire = FormulaMutationResult

// === Engine physical sort (`sortRange`) wire — design-engine-sort S2/S3 ===

/**
 * One sort key. `col` is a 0-based ABSOLUTE column index that must fall
 * inside the sort range's column span. `direction` defaults to `'asc'`
 * and `caseSensitive` to `false` (Excel defaults) engine-side when
 * omitted.
 */
export interface SortKeyWire {
  col: number
  direction?: 'asc' | 'desc'
  caseSensitive?: boolean
}

/** Zero-based bounds; the object alternative to an A1 range string. */
export interface SortRangeBoundsWire {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

/**
 * `sortRange` request payload (forwarded verbatim to the engine binding).
 * `range` is an A1 string (`"A1:B9"` or `"A1"`) or a zero-based bounds
 * object; `excludedRows` are 0-based SOURCE rows the host holds in place
 * (hidden ∪ filtered-out ∪ summary), assembled by the caller.
 */
export interface SortRangePayloadWire {
  range: string | SortRangeBoundsWire
  keys: SortKeyWire[]
  excludedRows?: number[]
}

/**
 * Success witness. `rowPermutation` is `[[slotRow, sourceRow], …]` over
 * the CHANGED slots only — reserved for overlay remap / parity; v1
 * consumers may ignore it.
 */
export interface SortRangeReportWire {
  movedRows: number
  movedCells: number
  rowPermutation: Array<[number, number]>
}

/**
 * Structured reject reasons the engine returns. They ride on the
 * `SORT_REJECTED` RPC error's `detail` (see `RpcErrorWire.detail`) rather
 * than the flat `code`/`message` pair, so `anchor` survives.
 */
export type SortRangeRejectCode =
  | 'invalid-range'
  | 'empty-keys'
  | 'key-out-of-range'
  | 'spill-in-range'
  | 'invalid-payload'

export interface SortRangeRejectWire {
  code: SortRangeRejectCode
  /** Present only for `spill-in-range` — the intersecting anchor (A1). */
  anchor?: string
  message?: string
}

// === Excel Table registry wire (#32) — CRUD DTO ===

/**
 * Serialized `TableEntry` as emitted by the WASM `listTables` / `getTable`
 * bindings (`rust/wasm/src/lib.rs` `TableJSON`). `range` is an A1 string
 * (`"A1:C10"`) spanning header + data (+ totals when present); `sheetIndex`
 * is the resolved 0-based engine sheet index and `sheet` its display name.
 */
export interface TableJSONWire {
  name: string
  sheet: string
  sheetIndex: number
  range: string
  hasHeaders: boolean
  hasTotals: boolean
  columns: string[]
}

/**
 * Structured reject reasons the engine returns for a table mutation. They
 * ride on the `TABLE_REJECTED` RPC error's `detail` (see
 * `RpcErrorWire.detail`) — `detail.code` is the raw engine `TableError`
 * string, mirroring the `SORT_REJECTED` convention so the host adapter can
 * map it to a structured not-applied result instead of a bare throw.
 */
export type TableRejectCode =
  | 'too-many-tables'
  | 'invalid-name'
  | 'reserved-name'
  | 'name-like-cell-ref'
  | 'name-conflict'
  | 'range-overlap'
  | 'sheet-not-found'
  | 'not-found'
  | 'column-not-found'
  | 'duplicate-column'
  | 'invalid-column-name'
  | 'mutation-during-custom-call'
  // Totals-row gates (parity #32 T6). `invalid-totals-function` is thrown by
  // the WASM binding (not a `TableError`) but rides the same bare-string
  // path, so it recognizes here alongside the engine reasons.
  | 'totals-row-blocked'
  | 'no-totals-row'
  | 'invalid-totals-function'

export interface TableRejectWire {
  code: TableRejectCode
  message?: string
}

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

/**
 * Fail-closed capability witness — a worker runtime's own declaration of
 * which optional command families it REALLY implements. The host adapter
 * requests it right after `initWorkbook` via the `describeCapabilities`
 * command.
 *
 * Semantics:
 *  - A runtime that does not understand the command (the WASM runtime,
 *    which predates this handshake) answers `UNKNOWN_COMMAND`; the client
 *    maps that to `null` ("no claims") and the adapter keeps the legacy
 *    full-trust contract, so the WASM path is behaviorally unchanged.
 *  - A runtime that answers MUST tell the truth: any family declared
 *    `false` (or omitted — fail-closed) makes the adapter withhold the
 *    corresponding optional `SpreadsheetBackend` port, which hides the
 *    UI entry through the existing degradation contract.
 *  - Commands in a family declared `false` answer a structured
 *    `UNSUPPORTED` RPC error instead of a success-shaped fake ACK.
 */
export interface WorkerRuntimeCapabilitiesWire {
  /** insertRows / deleteRows / insertColumns / deleteColumns really shift bands. */
  structuralEdits: boolean
  /** setFormatRange really persists formats. */
  formats: boolean
  /** snapshotFormatRange / restoreFormatSnapshot are backed by real format state. */
  formatSnapshots: boolean
  /** beginExportRangeTsv / nextExportRangeTsvChunk stream real TSV chunks. */
  tsvChunkExport: boolean
  /** persistence v1 snapshots round-trip the `formats` block. */
  persistenceFormats: boolean
  /** sortRange physically reorders workbook data (engine physical sort). */
  sortRange: boolean
  /**
   * setEvalHiddenRows really pushes a hidden-row eval input the engine's
   * SUBTOTAL 101-111 variants consume (parity #23). The TS runtime has no
   * such model and declares this `false`; the WASM runtime's null witness
   * keeps the family trusted.
   */
  evalHiddenRows: boolean
  /**
   * createTable / renameTable / renameTableColumn / deleteTable /
   * listTables / getTable are backed by a real engine Table registry
   * (Excel Table CRUD — #32). The TS runtime has no Table model and
   * declares this `false`; the WASM runtime's null witness keeps the
   * family trusted.
   */
  structuredTables: boolean
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
  /**
   * Honest capability handshake. Resolves `null` when the runtime
   * predates the `describeCapabilities` command (`UNKNOWN_COMMAND`),
   * which the adapter treats as "no claims" — legacy full-trust
   * behavior, keeping the WASM path unchanged. Optional so hand-rolled
   * client doubles (tests) keep compiling; the adapter reads it with
   * `client.describeCapabilities?.()`.
   */
  describeCapabilities?(): Promise<WorkerRuntimeCapabilitiesWire | null>
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
  /**
   * Engine physical sort (design-engine-sort S2/S3). Reorders `payload.range`'s
   * data rows in place by `payload.keys`, holding `payload.excludedRows`
   * fixed. Resolves a `SortRangeReportWire` on success. Rejects with an
   * Error whose `code` is `SORT_REJECTED` and whose `detail` is a
   * `SortRangeRejectWire` for every engine/payload gate (invalid-range,
   * empty-keys, key-out-of-range, spill-in-range, invalid-payload). A
   * runtime that declares `sortRange: false` (the TS runtime, which has
   * no physical sort) rejects with `UNSUPPORTED` instead — the host
   * adapter withholds the sort port entirely through the capability
   * handshake, so a compliant caller never reaches this on that runtime.
   */
  sortRange(sheet: number, payload: SortRangePayloadWire): Promise<SortRangeReportWire>
  /**
   * Engine hidden-row eval input (parity #23). Whole-set REPLACE of the
   * hidden-row set the engine's SUBTOTAL 101-111 variants exclude for
   * `sheet` (an empty `rows` clears it). Fire-and-forget: resolves once the
   * worker ACKs so callers can order a follow-up projection read after the
   * paired engine epoch bump. A runtime that declares `evalHiddenRows:
   * false` (the TS runtime) rejects with `UNSUPPORTED`; the host adapter
   * withholds the port entirely through the capability handshake, so a
   * compliant caller never reaches this on that runtime.
   */
  setEvalHiddenRows(sheet: number, rows: readonly number[]): Promise<void>
  /**
   * Excel Table CRUD (#32, design-excel-table.md §10). Optional so
   * hand-rolled client doubles (tests) keep compiling; the WASM runtime
   * always implements them and the host adapter guards presence before
   * use. `createTable` resolves the engine-assigned canonical name;
   * rename / rename-column / delete resolve `void`. A structured engine
   * reject surfaces as an Error whose `code` is `TABLE_REJECTED` and whose
   * `detail` is a `TableRejectWire` (mirrors the `sortRange` convention).
   */
  createTable?(sheet: number, bounds: SortRangeBoundsWire, name?: string): Promise<string>
  renameTable?(name: string, newName: string): Promise<void>
  renameTableColumn?(name: string, oldColumn: string, newColumn: string): Promise<void>
  deleteTable?(name: string): Promise<void>
  listTables?(): Promise<TableJSONWire[]>
  getTable?(name: string): Promise<TableJSONWire | null>
  /**
   * Totals row (#32 T6). `setTableTotalsRow` grows / removes a totals row;
   * `setTableTotalFunction` sets one column's aggregate. Both resolve `void`;
   * a structured engine reject (`totals-row-blocked` / `no-totals-row` /
   * `invalid-totals-function` / `not-found`) surfaces as a `TABLE_REJECTED`
   * RPC error carrying a `TableRejectWire` — same convention as CRUD.
   */
  setTableTotalsRow?(name: string, enabled: boolean): Promise<void>
  setTableTotalFunction?(name: string, column: string, func: string): Promise<void>
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
  /**
   * Wave 8 — register a user-defined formula by sending the body source
   * to the worker, which `new Function('args', source)`s it and binds
   * the resulting callable to the WASM Workbook. Closure-capture hazards
   * are avoided by handing the worker a string body rather than a live
   * function (JS callbacks cannot cross `postMessage`). Wave 8.2:
   * `options.isAsync` compiles the body through the AsyncFunction
   * constructor; the worker pump settles Promise results back into the
   * engine and cells show `#BUSY!` while in flight.
   */
  registerCustomFormula(
    name: string,
    source: string,
    options?: { isAsync?: boolean },
  ): Promise<boolean>
  unregisterCustomFormula(name: string): Promise<boolean>
  /**
   * Wave F follow-up — register a workbook-level name binding inside the
   * worker engine. Currently implemented only by the TS worker runtime;
   * the WASM runtime returns an `UNSUPPORTED` error code via
   * `defineNameUnsupported` so the host adapter can fall back to a
   * cache-only registration (range / value still work via the existing
   * `setNamedRange` flow; lambda requires worker-side AST parsing).
   *
   * The binding wire shape mirrors `NameBinding` from `@einfach/excel-core-ts`
   * but keeps the lambda `body` as a **formula source string** since AST
   * objects do not survive `postMessage`. The worker parses the body into
   * an `Expr` before calling `workbook.defineName(...)`.
   */
  defineName(name: string, binding: NameBindingWire): Promise<boolean>
  undefineName(name: string): Promise<boolean>
  dispose(): void
}

/**
 * Wire-format `NameBinding`. The TS engine's in-process `NameBinding`
 * (see `vanilla/excel-core-ts/src/types.ts`) carries a parsed `Expr` for
 * lambda bodies; this wire variant carries the source string and the
 * worker runtime parses on receive.
 */
export type NameBindingWire =
  | { kind: 'range'; sheetName: string; start: string; end: string }
  | { kind: 'value'; literal: string }
  | { kind: 'lambda'; params: string[]; body: string }

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
  return Object.assign(err, {
    code: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  })
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
    async describeCapabilities() {
      try {
        return await request<WorkerRuntimeCapabilitiesWire>('describeCapabilities')
      } catch (err) {
        // Legacy runtimes (WASM) predate the handshake and answer
        // UNKNOWN_COMMAND — map to `null` ("no claims") so the adapter
        // keeps its legacy full-trust contract for them.
        if ((err as Error & { code?: string }).code === 'UNKNOWN_COMMAND') return null
        throw err
      }
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
    sortRange(sheet, payload) {
      return request<SortRangeReportWire>('sortRange', { sheet, payload })
    },
    setEvalHiddenRows(sheet, rows) {
      return request<void>('setEvalHiddenRows', { sheet, rows: [...rows] })
    },
    createTable(sheet, bounds, name) {
      return request<string>('createTable', {
        sheet,
        bounds,
        ...(name === undefined ? {} : { name }),
      })
    },
    renameTable(name, newName) {
      return request<void>('renameTable', { name, newName })
    },
    renameTableColumn(name, oldColumn, newColumn) {
      return request<void>('renameTableColumn', { name, oldColumn, newColumn })
    },
    deleteTable(name) {
      return request<void>('deleteTable', { name })
    },
    listTables() {
      return request<TableJSONWire[]>('listTables')
    },
    getTable(name) {
      return request<TableJSONWire | null>('getTable', { name })
    },
    setTableTotalsRow(name, enabled) {
      return request<void>('setTableTotalsRow', { name, enabled })
    },
    setTableTotalFunction(name, column, func) {
      return request<void>('setTableTotalFunction', { name, column, func })
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
    registerCustomFormula(name, source, options) {
      return request<boolean>('registerCustomFormula', {
        name,
        source,
        isAsync: options?.isAsync === true,
      })
    },
    unregisterCustomFormula(name) {
      return request<boolean>('unregisterCustomFormula', { name })
    },
    defineName(name, binding) {
      return request<boolean>('defineName', { name, binding })
    },
    undefineName(name) {
      return request<boolean>('undefineName', { name })
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
