/// <reference lib="WebWorker" />

import init, { WasmWorkbook } from '../../wasm-pkg/einfach_wasm.js'
import { createAsyncCustomPump, type AsyncCustomRequest } from './async-custom-pump'
import { sparseRangeToTSV } from './range-tsv'
import type {
  CellFormatJSON,
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  FormatRangeSnapshot,
  FormulaMutationResultWire,
  ImportCellIssueWire,
  ImportCellWire,
  WorkbookPersistenceRestoreStatsWire,
  WorkbookPersistenceSnapshotWire,
  WorkerWorkbookDebugCountersWire,
  ViewportSizeSnapshotWire,
  RpcErrorWire,
  RpcResponseWire,
  SortRangeRejectWire,
  SortRangeReportWire,
  SparseCellWire,
  ColumnFilterRuleWire,
  FilterApplyResultWire,
  SheetFilterStateWire,
  HiddenRowsSnapshotWire,
  FilterSnapshotWire,
  TableJSONWire,
  TableRegistrySnapshotWire,
  TableRejectCode,
  SparseRangeWire,
  WorkbookImportStatsWire,
  WorkbookSheetMeta,
} from './worker-protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

/**
 * STORAGE_PRIMARY Phase 6.3 — wire shape consumed by the wasm
 * `bulk_install_workbook` entry (Phase 6.2). One entry per sheet;
 * `primitives` / `formulas` are `[addr, value]` pairs and addr strings
 * use the zero-based `"R:C"` encoding the binding accepts. Error cells
 * ride as `{ error }` objects (no `kind` discriminator on this wire).
 *
 * The engine treats every listed sheet as a FULL-SHEET REPLACE
 * (`Workbook::install_sheet_bulk` tears down previous content first),
 * so this payload is only safe against a fresh workbook — the atomic
 * import shell created at `beginImport`.
 */
type BulkInstallPrimitiveWire = number | string | boolean | { error: string }

type SheetBulkInstallWire = {
  sheet: number
  primitives: Array<[string, BulkInstallPrimitiveWire]>
  formulas: Array<[string, string]>
}

type WasmWorkbookRuntime = {
  sheet_count(): number
  sheet_name(idx: number): string
  add_sheet(name: string): number
  rename_sheet(idx: number, name: string): boolean
  remove_sheet(idx: number): boolean
  move_sheet(from: number, to: number): boolean
  set_cell_number(sheetIdx: number, addr: string, value: number): void
  set_cell_text(sheetIdx: number, addr: string, value: string): void
  set_cell_boolean(sheetIdx: number, addr: string, value: boolean): void
  set_cell_error(sheetIdx: number, addr: string, value: string): void
  clearCellAt(sheetIdx: number, addr: string): void
  setFormulaAt(sheetIdx: number, addr: string, formula: string): boolean
  insert_row(sheetIdx: number, at: number, count: number): void
  delete_row(sheetIdx: number, at: number, count: number): void
  insert_col(sheetIdx: number, at: number, count: number): void
  delete_col(sheetIdx: number, at: number, count: number): void
  subscribe_cell?: (sheetName: string, addr: string, callback: () => void) => number
  unsubscribe_cell?: (token: number) => void
  get_display(sheetIdx: number, addr: string): string
  get_number(sheetIdx: number, addr: string): number
  get_type(sheetIdx: number, addr: string): string
  is_error(sheetIdx: number, addr: string): boolean
  get_formula(sheetIdx: number, addr: string): string
  snapshotCell(sheetIdx: number, addr: string): CellSnapshotWire
  bulk_import_cells(cells: ImportCellWire[]): WorkbookImportStatsWire
  /**
   * STORAGE_PRIMARY Phase 6.2/6.3 — storage-primary bulk install.
   * Optional because test mocks and pre-Phase-6.2 wasm-pkg builds do
   * not expose it; the atomic commit path falls back to the legacy
   * `bulk_import_cells` when missing.
   */
  bulk_install_workbook?: (payload: SheetBulkInstallWire[]) => unknown
  list_non_empty_cells?: () => CellRefWire[]
  snapshot_sparse?: () => SparseCellWire[]
  snapshot_range_sparse?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => SparseCellWire[]
  restore_sparse?: (cells: SparseCellWire[]) => number
  read_sparse_range?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => CellSnapshotWire[]
  clear_range?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => number
  set_format_range?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    fmt: CellFormatJSON | null | undefined,
  ) => number
  snapshot_format_range?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => FormatRangeSnapshot
  restore_format_snapshot?: (snapshot: FormatRangeSnapshot) => number
  snapshot_viewport_sizes?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => ViewportSizeSnapshotWire
  set_row_height?: (sheetIdx: number, rowIndex: number, heightPx: number) => boolean
  set_col_width?: (sheetIdx: number, colIndex: number, widthPx: number) => boolean
  /**
   * Engine hidden-row eval input (parity #23). Whole-set REPLACE of the
   * hidden-row set the SUBTOTAL 101-111 variants exclude for `sheetIdx`
   * (an empty array clears it); the paired engine epoch bump re-derives
   * only the 101-111 formulas that consumed it. Optional so pre-#23
   * wasm-pkg builds and test mocks keep compiling; `assertMethod` guards
   * the call at dispatch time.
   */
  setEvalHiddenRows?: (sheetIdx: number, rows: Uint32Array | number[]) => void
  /**
   * Engine FILTER-hidden row eval input (`design-filter-hidden-rows` §6.5).
   * Whole-set REPLACE of the rows an active filter hides on `sheetIdx` (an
   * empty array clears it). Consumed by BOTH SUBTOTAL bands, unlike its
   * manual twin above. Optional so a wasm-pkg predating the export and test
   * mocks keep compiling — the dispatcher answers a structured `UNSUPPORTED`
   * when it is absent instead of throwing, which is what makes the design's
   * tier-2 degradation ("filter applies to the view, the engine never hears
   * about it") silent rather than a broken filter.
   */
  setEvalFilterHiddenRows?: (sheetIdx: number, rows: Uint32Array | number[]) => void
  /**
   * Engine physical sort (design-engine-sort S2). Reorders the range's
   * data rows in place and returns EITHER the success report
   * `{ ok: true, movedRows, movedCells, rowPermutation }` OR a structured
   * reject `{ ok: false, code, anchor?, message? }` — both in the Ok arm;
   * only a catastrophic report-serialization failure throws. Optional so
   * pre-S2 wasm-pkg builds and test mocks keep compiling; `assertMethod`
   * guards the call at dispatch time.
   */
  sortRange?: (sheetIdx: number, payload: unknown) => unknown
  /**
   * Excel Table CRUD (#32). `createTable` returns the engine-assigned
   * canonical name; rename / rename-column / delete return `void`.
   * Structured engine rejections THROW a `TableError` string
   * (`"range-overlap"`, `"name-conflict"`, …) — the dispatcher maps the
   * known set to a `TABLE_REJECTED` RPC error. Optional so pre-#32
   * wasm-pkg builds and test mocks keep compiling; `assertMethod` guards
   * the call at dispatch time.
   */
  createTable?: (
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    name?: string,
  ) => string
  renameTable?: (name: string, newName: string) => void
  renameTableColumn?: (name: string, oldColumn: string, newColumn: string) => void
  deleteTable?: (name: string) => void
  listTables?: () => TableJSONWire[]
  getTable?: (name: string) => TableJSONWire | null
  /**
   * Totals row (#32 T6). Both THROW a `TableError` string on a structured
   * reject; `setTableTotalFunction` additionally throws
   * `"invalid-totals-function"` for an unrecognized aggregate id. Optional so
   * pre-T6 wasm-pkg builds keep compiling; `assertMethod` guards the call.
   */
  setTableTotalsRow?: (name: string, enabled: boolean) => void
  setTableTotalFunction?: (name: string, column: string, func: string) => void
  /**
   * Table registry snapshot / restore (#25). `snapshotTables` is a pure read;
   * `restoreTables` REPLACES the registry wholesale and returns the resulting
   * Table count, THROWING a bare string (`"unsupported-snapshot-version"`,
   * `"malformed-snapshot"`, or a `TableError` id) for a payload it refuses —
   * all-or-nothing, so a refusal leaves the live registry untouched. Optional
   * so pre-#25 wasm-pkg builds and test mocks keep compiling; `assertMethod`
   * guards the call at dispatch time.
   */
  snapshotTables?: () => TableRegistrySnapshotWire
  restoreTables?: (snapshot: TableRegistrySnapshotWire) => number
  /**
   * Engine-owned hidden rows + filter (design-engine-hidden-rows E2/E3). The
   * three filter commands return the `{ ok, … }` union in their resolved value
   * (a structured refusal is NEVER a throw — `sortRange` convention); only a
   * serialization failure throws. `getFilter` is a whole-sheet read;
   * `snapshot*`/`restore*` are the whole-workbook undo primitives. Optional so
   * a wasm-pkg predating the exports and test mocks keep compiling —
   * `assertMethod` guards the call at dispatch time.
   */
  applyFilter?: (sheetIdx: number, payload: { rules: ColumnFilterRuleWire[] }) => FilterApplyResultWire
  reapplyFilter?: (sheetIdx: number) => FilterApplyResultWire
  clearFilter?: (sheetIdx: number) => FilterApplyResultWire
  getFilter?: (sheetIdx: number) => SheetFilterStateWire
  hideRows?: (sheetIdx: number, rows: Uint32Array | number[]) => boolean
  unhideRows?: (sheetIdx: number, rows: Uint32Array | number[]) => boolean
  listHiddenRows?: (sheetIdx: number) => number[]
  snapshotHidden?: () => HiddenRowsSnapshotWire
  restoreHidden?: (snapshot: HiddenRowsSnapshotWire) => number
  snapshotFilters?: () => FilterSnapshotWire
  restoreFilters?: (snapshot: FilterSnapshotWire) => number
  snapshot_persistence_v1?: () => WorkbookPersistenceSnapshotWire
  restore_persistence_v1?: (
    snapshot: WorkbookPersistenceSnapshotWire,
  ) => WorkbookPersistenceRestoreStatsWire
  debug_formula_cache_state?: (sheetIdx: number, addr: string) => string
  debug_formula_eval_count?: (sheetIdx: number) => number
  debug_formula_eval_count_total?: () => number
  debug_formula_count?: () => number
  debug_live_subscription_count?: () => number
  debug_sheet_live_subscription_count?: (sheetIdx: number) => number
  debug_sheet_formula_count?: (sheetIdx: number) => number
  debug_cross_sheet_dependents_count?: () => number
  /**
   * Wave 8 — register a synchronous JS callback as a user-defined
   * formula. The Rust side calls back into JS with a plain `Array` of
   * arg values and expects a `number | string | boolean | null |
   * undefined` return. Optional because the WASM crate may not have
   * landed the bridge yet; the worker runtime stubs gracefully when
   * missing.
   *
   * Method names match agent A's `wasm-bindgen` `js_name` exports:
   * `registerCustomFormula` / `unregisterCustomFormula`. Register
   * returns `void`; unregister returns `true` iff an entry was removed.
   */
  registerCustomFormula?: (
    name: string,
    fn: (args: Array<number | string | boolean | null>) => unknown,
  ) => void
  unregisterCustomFormula?: (name: string) => boolean
  /**
   * Wave 8.2 — async custom formulas. Registration is name-only (the
   * callback stays in this worker's map and never crosses into wasm);
   * the engine memoizes per (name, args), holds cells at #BUSY!, and
   * queues requests that the pump drains after every command. Optional:
   * pre-8.2 wasm-pkg builds and test mocks may not expose them — async
   * registration then degrades to a sync registration of a callback
   * that returns #VALUE! never (we simply refuse, see
   * registerCustomFormulaInWorker).
   */
  registerCustomFormulaAsync?: (name: string) => void
  drainAsyncCustomRequests?: () => AsyncCustomRequest[]
  resolveAsyncCustomCall?: (callId: number, value: unknown) => boolean
}

type RequestMessage = {
  id?: number
  cmd?: string
  [key: string]: unknown
}

type ImportSessionMode = 'atomic' | 'direct'

type AtomicImportSession = {
  mode: 'atomic'
  workbook: WasmWorkbookRuntime
  normalizedCount: number
  stats: WorkbookImportStatsWire
  normalizationIssues: ImportCellIssueWire[]
  finalTouches: Map<string, ImportCellWire>
}

type DirectImportSession = {
  mode: 'direct'
  workbook: WasmWorkbookRuntime
  normalizedCount: number
  stats: WorkbookImportStatsWire
  normalizationIssues: ImportCellIssueWire[]
}

type ImportSession = AtomicImportSession | DirectImportSession

type NormalizedImportChunk = {
  cells: ImportCellWire[]
  issues: ImportCellIssueWire[]
}

type ExportSession = {
  range: SparseRangeWire
  rowsPerChunk: number
  totalRows: number
  nextRow: number
}

type SnapshotSession = {
  range: SparseRangeWire
  rowsPerChunk: number
  totalRows: number
  nextRow: number
}

let workbook: WasmWorkbookRuntime | undefined
let initPromise: Promise<void> | undefined

const subscriptionTokens = new Map<number, number[]>()
const importSessions = new Map<number, ImportSession>()
const exportSessions = new Map<number, ExportSession>()
const snapshotSessions = new Map<number, SnapshotSession>()

/**
 * Wave 8 — compiled custom formulas live in the worker thread. The
 * source string travels across `postMessage` (closures cannot) and is
 * `new Function('args', source)`-d here. The compiled callable is then
 * handed to the WASM Workbook via `register_custom_formula` when that
 * bridge is available; if the bridge is missing we still remember the
 * compiled fn so a re-registration cycle is a clean replace.
 */
type CustomFormulaCallable = (
  args: Array<number | string | boolean | null>,
) => unknown
const customFormulas = new Map<string, { fn: CustomFormulaCallable; isAsync: boolean }>()

/**
 * Wave 8.2 — async custom-formula pump over the WASM engine. Drains the
 * engine's pending-call queue after every command, invokes the local
 * compiled callback, awaits it, and settles via resolveAsyncCustomCall.
 * Settle writes propagate through the Store, so subscribed cells emit
 * dirty events through the normal subscribe_cell → postDirty path — no
 * extra wire event. Engine identity (`currentEngine`) drops in-flight
 * settles across initWorkbook/reset.
 */
const asyncCustomPump = createAsyncCustomPump<WasmWorkbookRuntime>({
  currentEngine: () => workbook,
  drain: (engine) => engine.drainAsyncCustomRequests?.() ?? [],
  resolve: (engine, callId, value) => {
    const settled = engine.resolveAsyncCustomCall?.(callId, value) ?? false
    // A settle lands OUTSIDE any command frame, so the host has no
    // response to piggyback a refresh on. Cell subscriptions cover
    // precisely-subscribed cells; this coarse ping (no addresses — the
    // wasm drain does not expose observer cells) tells the backend to
    // refetch the visible projection.
    if (settled) postDirty([])
    return settled
  },
  lookup: (name) => {
    const entry = customFormulas.get(name)
    return entry?.isAsync ? entry.fn : undefined
  },
})
let nextExportId = 1
let nextSnapshotId = 1

const DEFAULT_EXPORT_ROWS_PER_CHUNK = 2048
const MIN_EXPORT_ROWS_PER_CHUNK = 1
const MAX_EXPORT_ROWS_PER_CHUNK = 10_000
export const MAX_IMPORT_CHUNK_CELLS = 10_000
export const MAX_IMPORT_SESSION_NORMALIZED_CELLS = 200_000
export const MAX_IMPORT_SESSION_FINAL_TOUCHES = 200_000
export const MAX_IMPORT_SESSION_ISSUES = 25_000

type ImportLimits = {
  chunkCells: number
  normalizedCells: number
  finalTouches: number
  issues: number
}

const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  chunkCells: MAX_IMPORT_CHUNK_CELLS,
  normalizedCells: MAX_IMPORT_SESSION_NORMALIZED_CELLS,
  finalTouches: MAX_IMPORT_SESSION_FINAL_TOUCHES,
  issues: MAX_IMPORT_SESSION_ISSUES,
}

let importLimits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS }

export function __setImportLimitsForTest(limits: Partial<ImportLimits>) {
  importLimits = { ...DEFAULT_IMPORT_LIMITS, ...limits }
}

export function __resetImportLimitsForTest() {
  importLimits = { ...DEFAULT_IMPORT_LIMITS }
}

async function ensureInit() {
  if (!initPromise)
    initPromise = (async () => {
      await init()
    })()
  await initPromise
}

async function ensureWorkbook(): Promise<WasmWorkbookRuntime> {
  await ensureInit()
  if (!workbook) workbook = new WasmWorkbook() as unknown as WasmWorkbookRuntime
  return workbook
}

function normalizeAddr(addr: unknown): string {
  return String(addr ?? '').toUpperCase()
}

function sheetList(wb: WasmWorkbookRuntime): WorkbookSheetMeta[] {
  const out: WorkbookSheetMeta[] = []
  for (let idx = 0; idx < wb.sheet_count(); idx++) {
    out.push({ idx, name: wb.sheet_name(idx) })
  }
  return out
}

function debugCounters(wb: WasmWorkbookRuntime): WorkerWorkbookDebugCountersWire {
  const sheets = []
  for (let idx = 0; idx < wb.sheet_count(); idx++) {
    sheets.push({
      idx,
      name: wb.sheet_name(idx),
      formulaCount: wb.debug_sheet_formula_count?.(idx) ?? 0,
      formulaEvalCount: wb.debug_formula_eval_count?.(idx) ?? 0,
      liveSubscriptionCount: wb.debug_sheet_live_subscription_count?.(idx) ?? 0,
    })
  }
  return {
    sheetCount: wb.sheet_count(),
    crossSheetDependents: wb.debug_cross_sheet_dependents_count?.() ?? 0,
    formulaCount:
      wb.debug_formula_count?.() ?? sheets.reduce((sum, sheet) => sum + sheet.formulaCount, 0),
    formulaEvalCountTotal:
      wb.debug_formula_eval_count_total?.() ??
      sheets.reduce((sum, sheet) => sum + sheet.formulaEvalCount, 0),
    liveSubscriptionCount: wb.debug_live_subscription_count?.() ?? 0,
    workerSubscriptionCount: subscriptionTokens.size,
    importSessionCount: importSessions.size,
    exportSessionCount: exportSessions.size,
    snapshotSessionCount: snapshotSessions.size,
    sheets,
  }
}

function resetSubscriptions(wb?: WasmWorkbookRuntime) {
  if (wb?.unsubscribe_cell) {
    for (const tokens of subscriptionTokens.values()) {
      for (const token of tokens) wb.unsubscribe_cell(token)
    }
  }
  subscriptionTokens.clear()
}

/**
 * Audit D-6: import/export/snapshot sessions and live cell
 * subscriptions all hold SHEET INDICES captured at begin/subscribe
 * time. `removeSheet` / `moveSheet` shift those indices, so a
 * surviving session would read or write the WRONG sheet in later
 * chunks and a surviving subscription would post dirty events with a
 * stale index. Drop them: the next session RPC fails loudly with
 * IMPORT_SESSION_MISSING / EXPORT_SESSION_MISSING /
 * SNAPSHOT_SESSION_MISSING and hosts re-subscribe against the new
 * layout. The id counters keep counting up so a stale id can never
 * collide with a new session. `addSheet` (appends) and `renameSheet`
 * (names only) keep existing indices stable and deliberately do NOT
 * invalidate.
 */
function invalidateSheetIndexedState(wb: WasmWorkbookRuntime) {
  resetSubscriptions(wb)
  importSessions.clear()
  exportSessions.clear()
  snapshotSessions.clear()
}

function resetWorkbook(sheets?: string[]): WasmWorkbookRuntime {
  resetSubscriptions(workbook)
  importSessions.clear()
  exportSessions.clear()
  snapshotSessions.clear()
  customFormulas.clear()
  nextExportId = 1
  nextSnapshotId = 1
  const wb = new WasmWorkbook() as unknown as WasmWorkbookRuntime
  if (sheets && sheets.length > 0) {
    wb.rename_sheet(0, sheets[0])
    for (const name of sheets.slice(1)) wb.add_sheet(name)
  }
  workbook = wb
  return wb
}

function createWorkbookShell(source: WasmWorkbookRuntime): WasmWorkbookRuntime {
  const wb = new WasmWorkbook() as unknown as WasmWorkbookRuntime
  if (source.sheet_count() > 0) {
    wb.rename_sheet(0, source.sheet_name(0))
    for (let idx = 1; idx < source.sheet_count(); idx++) wb.add_sheet(source.sheet_name(idx))
  }
  return wb
}

function snapshotCell(wb: WasmWorkbookRuntime, ref: CellRefWire): CellSnapshotWire {
  const addr = normalizeAddr(ref.addr)
  const sheet = ref.sheet
  return normalizeSnapshot(assertMethod(wb, 'snapshotCell').call(wb, sheet, addr))
}

function normalizeRefWire(ref: CellRefWire): CellRefWire {
  return {
    sheet: Number(ref.sheet),
    addr: normalizeAddr(ref.addr),
  }
}

function normalizeSnapshot(cell: CellSnapshotWire): CellSnapshotWire {
  return {
    ...cell,
    addr: normalizeAddr(cell.addr),
  }
}

function normalizeSparseCell(cell: SparseCellWire): SparseCellWire {
  return {
    ...cell,
    addr: normalizeAddr(cell.addr),
  } as SparseCellWire
}

function postResponse(id: number, result: unknown) {
  const msg: RpcResponseWire = { id, ok: true, result }
  ctx.postMessage(msg)
}

function postError(id: number, error: RpcErrorWire) {
  const msg: RpcResponseWire = { id, ok: false, error }
  ctx.postMessage(msg)
}

function postDirty(cells: CellRefWire[]) {
  ctx.postMessage({
    event: 'cellsDirty',
    cells: cells.map((cell) => ({ ...cell, addr: cell.addr.toUpperCase() })),
  })
}

function postHydrated(cells: CellSnapshotWire[], subId?: number) {
  ctx.postMessage({ event: 'cellsHydrated', cells, subId })
}

function assertSheet(wb: WasmWorkbookRuntime, sheet: number) {
  if (!Number.isInteger(sheet) || sheet < 0 || sheet >= wb.sheet_count()) {
    throw Object.assign(new Error(`invalid sheet index: ${sheet}`), {
      code: 'INVALID_SHEET',
    })
  }
}

function assertFormulaSource(formula: unknown): string {
  if (typeof formula !== 'string') {
    throw Object.assign(new Error('formula must be a string'), {
      code: 'INVALID_FORMULA',
    })
  }
  return formula
}

function formulaFailureFromSnapshot(cell: CellSnapshotWire): FormulaMutationResultWire {
  const display = cell.display.toUpperCase()
  if (display.includes('CYCLE')) {
    return {
      ok: false,
      code: 'FORMULA_CYCLE',
      message: 'formula would create a cycle',
      display: cell.display,
    }
  }
  if (cell.isError) {
    return {
      ok: false,
      code: 'INVALID_FORMULA',
      message: 'formula could not be parsed or installed',
      display: cell.display,
    }
  }
  return {
    ok: false,
    code: 'FORMULA_REJECTED',
    message: 'formula was rejected',
    display: cell.display,
  }
}

function setFormulaDetailed(
  wb: WasmWorkbookRuntime,
  sheet: number,
  addr: string,
  formula: unknown,
): FormulaMutationResultWire {
  assertSheet(wb, sheet)
  const source = assertFormulaSource(formula)
  const ok = assertMethod(wb, 'setFormulaAt').call(wb, sheet, addr, source)
  if (ok) return { ok: true }
  return formulaFailureFromSnapshot(snapshotCell(wb, { sheet, addr }))
}

function setCell(wb: WasmWorkbookRuntime, sheet: number, addr: string, value: CellWire) {
  assertSheet(wb, sheet)
  switch (value.type) {
    case 'number':
      assertMethod(wb, 'set_cell_number').call(wb, sheet, addr, value.value)
      return true
    case 'text':
      assertMethod(wb, 'set_cell_text').call(wb, sheet, addr, value.value)
      return true
    case 'boolean':
      assertMethod(wb, 'set_cell_boolean').call(wb, sheet, addr, value.value)
      return true
    case 'error':
      assertMethod(wb, 'set_cell_error').call(wb, sheet, addr, value.value)
      return true
    case 'null':
      assertMethod(wb, 'clearCellAt').call(wb, sheet, addr)
      return true
    default:
      throw Object.assign(new Error('unsupported cell wire value'), {
        code: 'INVALID_CELL_VALUE',
      })
  }
}

function assertImportSessionId(sessionId: number) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw Object.assign(new Error(`invalid import session: ${sessionId}`), {
      code: 'INVALID_IMPORT_SESSION',
    })
  }
}

function assertExportSessionId(sessionId: number) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw Object.assign(new Error(`invalid export session: ${sessionId}`), {
      code: 'INVALID_EXPORT_SESSION',
    })
  }
}

function assertSnapshotSessionId(sessionId: number) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw Object.assign(new Error(`invalid snapshot session: ${sessionId}`), {
      code: 'INVALID_SNAPSHOT_SESSION',
    })
  }
}

function normalizeImportSessionMode(mode: unknown, atomic: unknown): ImportSessionMode {
  if (mode === undefined || mode === null) return atomic === false ? 'direct' : 'atomic'
  if (mode === 'atomic') return 'atomic'
  if (mode === 'direct' || mode === 'non-atomic' || mode === 'nonAtomic') return 'direct'
  throw Object.assign(new Error(`invalid import mode: ${String(mode)}`), {
    code: 'INVALID_IMPORT_MODE',
  })
}

function clampRowsPerChunk(
  rowsPerChunk: unknown,
  fallback = DEFAULT_EXPORT_ROWS_PER_CHUNK,
): number {
  const normalized = Math.floor(Number(rowsPerChunk))
  if (!Number.isFinite(normalized)) return fallback
  if (normalized < MIN_EXPORT_ROWS_PER_CHUNK) return MIN_EXPORT_ROWS_PER_CHUNK
  if (normalized > MAX_EXPORT_ROWS_PER_CHUNK) return MAX_EXPORT_ROWS_PER_CHUNK
  return normalized
}

function rangeTotalRows(range: SparseRangeWire): number {
  return Math.max(0, range.endRow - range.startRow + 1)
}

function importCellIssue(
  cell: Partial<ImportCellWire>,
  code: string,
  message: string,
): ImportCellIssueWire {
  const sheet = Number(cell.sheet)
  const row = Number(cell.row)
  const col = Number(cell.col)
  return {
    ...(Number.isFinite(sheet) ? { sheet } : {}),
    ...(Number.isFinite(row) ? { row } : {}),
    ...(Number.isFinite(col) ? { col } : {}),
    ...(typeof cell.kind === 'string' ? { kind: cell.kind } : {}),
    code,
    message,
  }
}

function importCellInput(cell: unknown): Partial<ImportCellWire> {
  return cell && typeof cell === 'object' ? (cell as Partial<ImportCellWire>) : {}
}

function normalizeImportCell(cell: unknown): ImportCellWire | ImportCellIssueWire {
  const input = importCellInput(cell)
  const sheet = Number(input.sheet)
  const row = Number(input.row)
  const col = Number(input.col)
  if (
    !Number.isInteger(sheet) ||
    sheet < 0 ||
    !Number.isInteger(row) ||
    row < 0 ||
    !Number.isInteger(col) ||
    col < 0
  ) {
    return importCellIssue(
      input,
      'INVALID_IMPORT_CELL_COORDINATES',
      'invalid import cell coordinates',
    )
  }

  switch (input.kind) {
    case 'number':
      if (typeof input.value !== 'number' || !Number.isFinite(input.value)) break
      return { sheet, row, col, kind: 'number', value: input.value }
    case 'text':
      if (typeof input.value !== 'string') break
      return { sheet, row, col, kind: 'text', value: input.value }
    case 'boolean':
      if (typeof input.value !== 'boolean') break
      return { sheet, row, col, kind: 'boolean', value: input.value }
    case 'error':
      if (typeof input.value !== 'string') break
      return { sheet, row, col, kind: 'error', value: input.value }
    case 'formula':
      if (typeof input.value !== 'string') break
      return { sheet, row, col, kind: 'formula', value: input.value }
    case 'null':
      return { sheet, row, col, kind: 'null' }
    default:
      return importCellIssue(input, 'INVALID_IMPORT_CELL_KIND', 'invalid import cell kind')
  }

  return importCellIssue(input, 'INVALID_IMPORT_CELL_VALUE', 'invalid import cell value')
}

export function normalizeImportCells(cells: unknown[]): NormalizedImportChunk {
  const session: NormalizedImportChunk = { cells: [], issues: [] }
  for (const cell of cells) {
    const normalized = normalizeImportCell(cell)
    if ('message' in normalized) session.issues.push(normalized)
    else session.cells.push(normalized)
  }
  return session
}

function ensureImportChunkSize(cells: unknown[]) {
  if (cells.length > importLimits.chunkCells) {
    throw Object.assign(new Error(`import chunk too large: ${cells.length}`), {
      code: 'IMPORT_CHUNK_TOO_LARGE',
    })
  }
}

function projectedFinalTouches(session: AtomicImportSession, cells: ImportCellWire[]): number {
  if (cells.length === 0) return session.finalTouches.size
  const next = session.finalTouches.size
  const uniqueNewTouches = new Set<string>()
  for (const cell of cells) {
    uniqueNewTouches.add(importCellKey(cell))
  }
  let projected = next
  for (const key of uniqueNewTouches) {
    if (!session.finalTouches.has(key)) projected += 1
  }
  return projected
}

function ensureImportSessionLimits(session: ImportSession, chunk: NormalizedImportChunk) {
  if (session.normalizationIssues.length + chunk.issues.length > importLimits.issues) {
    throw Object.assign(new Error('import session exceeded issue limit'), {
      code: 'IMPORT_ISSUES_LIMIT_EXCEEDED',
    })
  }
  if (session.mode === 'direct') return

  if (session.normalizedCount + chunk.cells.length > importLimits.normalizedCells) {
    throw Object.assign(new Error('import session exceeded normalized cell limit'), {
      code: 'IMPORT_SESSION_LIMIT_EXCEEDED',
    })
  }
  const nextFinalTouches = projectedFinalTouches(session, chunk.cells)
  if (nextFinalTouches > importLimits.finalTouches) {
    throw Object.assign(new Error('import session exceeded final touch limit'), {
      code: 'IMPORT_SESSION_LIMIT_EXCEEDED',
    })
  }
}

export function mergeImportStatsIssues(
  stats: WorkbookImportStatsWire,
  issues: ImportCellIssueWire[],
): WorkbookImportStatsWire {
  const mergedIssues = [...(stats.issues ?? []), ...issues]
  return mergedIssues.length > 0
    ? { ...stats, errors: stats.errors + issues.length, issues: mergedIssues }
    : stats
}

function emptyImportStats(): WorkbookImportStatsWire {
  return {
    accepted: 0,
    formulas: 0,
    rejectedFormulas: 0,
    cleared: 0,
    errors: 0,
  }
}

export function mergeImportStats(
  a: WorkbookImportStatsWire,
  b: WorkbookImportStatsWire,
): WorkbookImportStatsWire {
  const issues = [...(a.issues ?? []), ...(b.issues ?? [])]
  return {
    accepted: a.accepted + b.accepted,
    formulas: a.formulas + b.formulas,
    rejectedFormulas: a.rejectedFormulas + b.rejectedFormulas,
    cleared: a.cleared + b.cleared,
    errors: a.errors + b.errors,
    ...(issues.length > 0 ? { issues } : {}),
  }
}

function importCellKey(cell: Pick<ImportCellWire, 'sheet' | 'row' | 'col'>): string {
  return `${cell.sheet}:${cell.row}:${cell.col}`
}

function recordFinalTouches(session: AtomicImportSession, cells: ImportCellWire[]) {
  for (const cell of cells) session.finalTouches.set(importCellKey(cell), cell)
}

function snapshotFinalImportTouches(session: AtomicImportSession): SparseCellWire[] {
  const snapshotRangeSparse = assertMethod(session.workbook, 'snapshot_range_sparse')
  const out: SparseCellWire[] = []
  for (const cell of session.finalTouches.values()) {
    if (cell.kind === 'null') continue
    if (cell.sheet >= session.workbook.sheet_count()) continue
    out.push(
      ...snapshotRangeSparse
        .call(session.workbook, cell.sheet, cell.row, cell.col, cell.row, cell.col)
        .map(normalizeSparseCell),
    )
  }
  return out
}

function finalImportClears(session: AtomicImportSession): ImportCellWire[] {
  return [...session.finalTouches.values()].filter(
    (cell) => cell.kind === 'null' && cell.sheet < session.workbook.sheet_count(),
  )
}

function sparseCellToImportCell(cell: SparseCellWire): ImportCellWire {
  switch (cell.kind) {
    case 'number':
      return { sheet: cell.sheet, row: cell.row, col: cell.col, kind: 'number', value: cell.value }
    case 'text':
      return { sheet: cell.sheet, row: cell.row, col: cell.col, kind: 'text', value: cell.value }
    case 'boolean':
      return {
        sheet: cell.sheet,
        row: cell.row,
        col: cell.col,
        kind: 'boolean',
        value: cell.value,
      }
    case 'error':
      return { sheet: cell.sheet, row: cell.row, col: cell.col, kind: 'error', value: cell.value }
    case 'formula':
      return { sheet: cell.sheet, row: cell.row, col: cell.col, kind: 'formula', value: cell.value }
  }
}

function mergeFinalCommitStats(
  sessionStats: WorkbookImportStatsWire,
  finalStats: WorkbookImportStatsWire,
): WorkbookImportStatsWire {
  const issues = [...(sessionStats.issues ?? []), ...(finalStats.issues ?? [])]
  const rejectedFormulas = sessionStats.rejectedFormulas + finalStats.rejectedFormulas
  return {
    ...sessionStats,
    accepted: Math.max(0, sessionStats.accepted - finalStats.rejectedFormulas),
    rejectedFormulas,
    errors: sessionStats.errors + finalStats.errors,
    ...(issues.length > 0 ? { issues } : {}),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function directImportPartialFailure(err: unknown) {
  const reason = errorMessage(err)
  const prefix = 'direct import failed; import is non-atomic and may contain partial writes'
  return Object.assign(
    new Error(`${prefix}: ${reason}`),
    { code: 'DIRECT_IMPORT_PARTIAL_FAILURE' },
  )
}

// TODO(6.4): direct sessions write ADDITIVELY into the live workbook —
// the storage-primary `bulk_install_workbook` is a full-sheet replace,
// so this path stays on the legacy `bulk_import_cells` until the engine
// grows an additive storage-primary entry.
function importCellsIntoDirectSession(
  session: DirectImportSession,
  cells: ImportCellWire[],
): WorkbookImportStatsWire {
  const bulkImportCells = assertMethod(session.workbook, 'bulk_import_cells')
  try {
    return bulkImportCells.call(session.workbook, cells)
  } catch (err) {
    throw directImportPartialFailure(err)
  }
}

/**
 * STORAGE_PRIMARY Phase 6.3 — chunk-time stats for atomic sessions.
 *
 * Atomic chunks no longer touch the shell engine per chunk (the staged
 * cells install in ONE `bulk_install_workbook` call at commit), so the
 * per-chunk stats the legacy shell `bulk_import_cells` used to return
 * are synthesized here with the same counting rules:
 *
 * - sheet out of range  → `errors` + a `SHEET_OUT_OF_RANGE` issue
 *   (mirrors the engine's per-cell check; the cells stay recorded in
 *   `finalTouches` and are skipped again at install/snapshot, exactly
 *   like the legacy flow).
 * - `null`              → `accepted` + `cleared`.
 * - `formula`           → `formulas` + optimistic `accepted`. The
 *   storage-primary install parks formula text without parsing;
 *   rejections surface when commit replays the staged cells onto the
 *   live workbook through the legacy `bulk_import_cells`, and
 *   `mergeFinalCommitStats` reconciles `accepted` / `rejectedFormulas`
 *   from that replay — same net stats as the legacy chunk-time
 *   rejection.
 * - everything else     → `accepted` (values are already validated by
 *   `normalizeImportCells`).
 */
function stageAtomicChunkStats(
  session: AtomicImportSession,
  cells: ImportCellWire[],
): WorkbookImportStatsWire {
  const stats = emptyImportStats()
  const sheetCount = session.workbook.sheet_count()
  const issues: ImportCellIssueWire[] = []
  for (const cell of cells) {
    if (cell.sheet >= sheetCount) {
      stats.errors += 1
      issues.push(
        importCellIssue(cell, 'SHEET_OUT_OF_RANGE', 'cell sheet index is outside the workbook'),
      )
      continue
    }
    if (cell.kind === 'null') {
      stats.accepted += 1
      stats.cleared += 1
      continue
    }
    if (cell.kind === 'formula') stats.formulas += 1
    stats.accepted += 1
  }
  return issues.length > 0 ? { ...stats, issues } : stats
}

/**
 * Group staged import cells into the per-sheet `bulk_install_workbook`
 * payload. Mirrors `snapshotFinalImportTouches` / `finalImportClears`
 * filtering: out-of-range sheets are skipped (the binding rejects the
 * whole payload otherwise), and `null` kinds are skipped because the
 * shell starts empty — there is nothing to clear there; the clears
 * still replay onto the live workbook via `finalImportClears`.
 */
function buildBulkInstallPayload(
  cells: Iterable<ImportCellWire>,
  sheetCount: number,
): SheetBulkInstallWire[] {
  const bySheet = new Map<number, SheetBulkInstallWire>()
  for (const cell of cells) {
    if (cell.sheet >= sheetCount) continue
    if (cell.kind === 'null') continue
    let entry = bySheet.get(cell.sheet)
    if (!entry) {
      entry = { sheet: cell.sheet, primitives: [], formulas: [] }
      bySheet.set(cell.sheet, entry)
    }
    const addr = `${cell.row}:${cell.col}`
    if (cell.kind === 'formula') entry.formulas.push([addr, cell.value])
    else if (cell.kind === 'error') entry.primitives.push([addr, { error: cell.value }])
    else entry.primitives.push([addr, cell.value])
  }
  return [...bySheet.values()]
}

/**
 * STORAGE_PRIMARY Phase 6.3 — install the atomic session's staged cells
 * into its shell workbook in one storage-primary call.
 *
 * The shell is a FRESH workbook created at `beginImport`
 * (`createWorkbookShell`), so the engine's full-sheet-replace semantics
 * equal a plain fresh install here: one map swap per sheet instead of
 * per-cell loader calls. `finalTouches` is already deduped
 * last-write-wins, so the single install lands the same end state the
 * legacy per-chunk `bulk_import_cells` sequence produced.
 *
 * Falls back to the legacy path when the binding is unavailable (test
 * mocks, pre-Phase-6.2 wasm-pkg builds).
 */
function installAtomicStagingIntoShell(session: AtomicImportSession) {
  if (session.finalTouches.size === 0) return
  const shell = session.workbook
  const bulkInstallWorkbook = shell.bulk_install_workbook
  if (typeof bulkInstallWorkbook === 'function') {
    const payload = buildBulkInstallPayload(session.finalTouches.values(), shell.sheet_count())
    if (payload.length > 0) bulkInstallWorkbook.call(shell, payload)
    return
  }
  assertMethod(shell, 'bulk_import_cells').call(shell, [...session.finalTouches.values()])
}

function normalizeSparseRange(range: unknown): SparseRangeWire {
  const input = (range ?? {}) as Partial<SparseRangeWire>
  const out: SparseRangeWire = {
    sheet: Number(input.sheet),
    startRow: Number(input.startRow),
    startCol: Number(input.startCol),
    endRow: Number(input.endRow),
    endCol: Number(input.endCol),
  }
  if (
    !Number.isInteger(out.sheet) ||
    out.sheet < 0 ||
    !Number.isInteger(out.startRow) ||
    out.startRow < 0 ||
    !Number.isInteger(out.startCol) ||
    out.startCol < 0 ||
    !Number.isInteger(out.endRow) ||
    out.endRow < 0 ||
    !Number.isInteger(out.endCol) ||
    out.endCol < 0
  ) {
    throw Object.assign(new Error('invalid sparse range'), {
      code: 'INVALID_SPARSE_RANGE',
    })
  }
  return out
}

function normalizeStructuralIndex(value: unknown, name: string): number {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0) {
    throw Object.assign(new Error(`invalid ${name}`), {
      code: 'INVALID_STRUCTURAL_EDIT',
    })
  }
  return index
}

/**
 * Sanitize a whole-set row list (`hideRows` / `unhideRows`), dropping
 * non-integers and negatives — the same defensive coercion the eval-input
 * pushes apply.
 */
function sanitizeRowList(value: unknown): number[] {
  const raw = Array.isArray(value) ? (value as unknown[]) : []
  const rows: number[] = []
  for (const entry of raw) {
    const index = Number(entry)
    if (Number.isInteger(index) && index >= 0) rows.push(index)
  }
  return rows
}

function normalizeStructuralCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1) {
    throw Object.assign(new Error('invalid structural edit count'), {
      code: 'INVALID_STRUCTURAL_EDIT',
    })
  }
  return count
}

function normalizeDimensionPx(value: unknown, name: string): number {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) {
    throw Object.assign(new Error(`invalid ${name}`), {
      code: 'INVALID_DIMENSION_SIZE',
    })
  }
  return Math.max(1, Math.round(size))
}

function assertMethod<T extends keyof WasmWorkbookRuntime>(
  wb: WasmWorkbookRuntime,
  method: T,
): NonNullable<WasmWorkbookRuntime[T]> {
  const value = wb[method]
  if (typeof value !== 'function') {
    throw Object.assign(new Error(`WasmWorkbook.${String(method)} is not available`), {
      code: 'WASM_METHOD_UNAVAILABLE',
    })
  }
  return value as NonNullable<WasmWorkbookRuntime[T]>
}

function subscribeCells(wb: WasmWorkbookRuntime, subId: number, cells: CellRefWire[]) {
  if (!wb.subscribe_cell) {
    throw Object.assign(new Error('WasmWorkbook.subscribe_cell is not available'), {
      code: 'SUBSCRIBE_UNAVAILABLE',
    })
  }
  const tokens: number[] = []
  for (const ref of cells) {
    assertSheet(wb, ref.sheet)
    const sheetName = wb.sheet_name(ref.sheet)
    const addr = normalizeAddr(ref.addr)
    const token = wb.subscribe_cell(sheetName, addr, () => postDirty([{ sheet: ref.sheet, addr }]))
    tokens.push(token)
  }
  subscriptionTokens.set(subId, tokens)
  postHydrated(
    cells.map((cell) => snapshotCell(wb, cell)),
    subId,
  )
}

function unsubscribeCells(wb: WasmWorkbookRuntime, subId: number) {
  const tokens = subscriptionTokens.get(subId) ?? []
  if (wb.unsubscribe_cell) {
    for (const token of tokens) wb.unsubscribe_cell(token)
  }
  subscriptionTokens.delete(subId)
}

const CUSTOM_FORMULA_NAME_REGEX = /^[A-Z][A-Z0-9_.]*$/

function assertCustomFormulaName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw Object.assign(new Error('custom formula name must be a non-empty string'), {
      code: 'INVALID_CUSTOM_FORMULA_NAME',
    })
  }
  if (!CUSTOM_FORMULA_NAME_REGEX.test(name)) {
    throw Object.assign(new Error(`invalid custom formula name: ${name}`), {
      code: 'INVALID_CUSTOM_FORMULA_NAME',
    })
  }
  return name
}

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {
  /* async constructor probe */
}).constructor as new (arg: string, body: string) => CustomFormulaCallable

function compileCustomFormula(
  name: string,
  source: unknown,
  isAsync: boolean,
): CustomFormulaCallable {
  if (typeof source !== 'string') {
    throw Object.assign(new Error(`custom formula ${name}: source must be a string`), {
      code: 'INVALID_CUSTOM_FORMULA_SOURCE',
    })
  }
  try {
    // SECURITY: `new Function` runs in the worker's global scope, NOT
    // the surrounding lexical scope. That sandboxes the body away from
    // *this module's* closure variables, but it does NOT sandbox it
    // away from worker-global authority — the compiled function has
    // full access to `self`, `postMessage`, `fetch`, `indexedDB`, any
    // imported scripts, the WASM workbook handle, etc. This is
    // therefore ONLY safe for HOST-TRUSTED source (developer code
    // shipped with the app, configuration loaded from a trusted
    // backend). Untrusted user-input source MUST go through a separate
    // iframe-sandbox + structured-clone IPC boundary instead. See
    // `rust/excel-core/src/CUSTOM_FORMULAS.md` § "Security model" for
    // the full trust contract. Async bodies compile through the
    // AsyncFunction constructor (same trust model) so they can `await`.
    const fn = isAsync
      ? new AsyncFunctionCtor('args', source)
      : (new Function('args', source) as CustomFormulaCallable)
    return fn
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw Object.assign(
      new Error(`custom formula ${name}: failed to compile source — ${reason}`),
      { code: 'INVALID_CUSTOM_FORMULA_SOURCE' },
    )
  }
}

function registerCustomFormulaInWorker(
  wb: WasmWorkbookRuntime,
  name: string,
  source: unknown,
  isAsync: boolean,
): boolean {
  const validatedName = assertCustomFormulaName(name)
  const fn = compileCustomFormula(validatedName, source, isAsync)
  if (isAsync && !wb.registerCustomFormulaAsync) {
    // Engine bridge predates async support. Refuse loudly instead of
    // silently registering a sync callback that returns a Promise
    // (which the engine would marshal to #TYPE! per cell).
    throw Object.assign(
      new Error(`custom formula ${validatedName}: async registration requires a newer wasm build`),
      { code: 'ASYNC_CUSTOM_FORMULA_UNSUPPORTED' },
    )
  }
  customFormulas.set(validatedName, { fn, isAsync })
  if (isAsync) {
    wb.registerCustomFormulaAsync!(validatedName)
    return true
  }
  if (wb.registerCustomFormula) {
    wb.registerCustomFormula(validatedName, fn)
    return true
  }
  // Bridge not yet available — remember the source so a later
  // unregister/re-register works, and signal back `false` so the
  // adapter can flag this state if it cares. We do NOT throw because
  // an absent bridge is the expected condition before agent A lands
  // the WASM side.
  return false
}

function unregisterCustomFormulaInWorker(
  wb: WasmWorkbookRuntime,
  name: unknown,
): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  const hadLocal = customFormulas.delete(name)
  if (wb.unregisterCustomFormula) {
    return wb.unregisterCustomFormula(name)
  }
  return hadLocal
}

function exportRangeTsv(wb: WasmWorkbookRuntime, range: SparseRangeWire): string {
  assertSheet(wb, range.sheet)
  const snapshotRangeSparse = assertMethod(wb, 'snapshot_range_sparse')
  const cells = snapshotRangeSparse
    .call(wb, range.sheet, range.startRow, range.startCol, range.endRow, range.endCol)
    .map(normalizeSparseCell)
  return sparseRangeToTSV(cells, range)
}

function exportRangeTsvChunk(
  wb: WasmWorkbookRuntime,
  session: ExportSession,
): { startRow: number; endRow: number; chunk: string; done: boolean } {
  const range = session.range
  if (session.totalRows === 0 || session.nextRow > range.endRow) {
    return {
      startRow: range.startRow,
      endRow: range.startRow - 1,
      chunk: '',
      done: true,
    }
  }

  const startRow = session.nextRow
  const endRow = Math.min(range.endRow, startRow + session.rowsPerChunk - 1)
  const snapshotRangeSparse = assertMethod(wb, 'snapshot_range_sparse')
  const chunkCells = snapshotRangeSparse
    .call(wb, range.sheet, startRow, range.startCol, endRow, range.endCol)
    .map(normalizeSparseCell)
  session.nextRow = endRow + 1

  return {
    startRow,
    endRow,
    chunk: sparseRangeToTSV(chunkCells, {
      startRow,
      startCol: range.startCol,
      endRow,
      endCol: range.endCol,
    }),
    done: session.nextRow > range.endRow,
  }
}

function snapshotRangeSparseChunk(
  wb: WasmWorkbookRuntime,
  session: SnapshotSession,
): { startRow: number; endRow: number; cells: SparseCellWire[]; done: boolean } {
  const range = session.range
  if (session.totalRows === 0 || session.nextRow > range.endRow) {
    return {
      startRow: range.startRow,
      endRow: range.startRow - 1,
      cells: [],
      done: true,
    }
  }

  const startRow = session.nextRow
  const endRow = Math.min(range.endRow, startRow + session.rowsPerChunk - 1)
  const snapshotRangeSparse = assertMethod(wb, 'snapshot_range_sparse')
  const cells = snapshotRangeSparse
    .call(wb, range.sheet, startRow, range.startCol, endRow, range.endCol)
    .map(normalizeSparseCell)
  session.nextRow = endRow + 1

  return {
    startRow,
    endRow,
    cells,
    done: session.nextRow > range.endRow,
  }
}

function toRpcError(err: unknown): RpcErrorWire {
  if (err instanceof Error) {
    return {
      code: String((err as Error & { code?: string }).code ?? 'WORKER_ERROR'),
      message: err.message,
    }
  }
  return { code: 'WORKER_ERROR', message: String(err) }
}

// Excel Table CRUD (#32). The WASM `create_table` / `rename_table` / …
// bindings map every `TableError` to `JsValue::from_str(<code>)`, which
// wasm-bindgen throws as a bare JS string. Recognize the known set and
// surface it as a structured `TABLE_REJECTED` RPC error (detail.code =
// the engine reason) so the host adapter converts it into a not-applied
// result instead of a generic WORKER_ERROR — mirrors `SORT_REJECTED`.
const TABLE_REJECTION_CODES = new Set<TableRejectCode>([
  'too-many-tables',
  'invalid-name',
  'reserved-name',
  'name-like-cell-ref',
  'name-conflict',
  'range-overlap',
  'sheet-not-found',
  'not-found',
  'column-not-found',
  'duplicate-column',
  'invalid-column-name',
  'mutation-during-custom-call',
  'totals-row-blocked',
  'no-totals-row',
  'invalid-totals-function',
  // #25 `restoreTables` envelope gates — same bare-string throw shape.
  'unsupported-snapshot-version',
  'malformed-snapshot',
])

function tableRejectionCode(err: unknown): TableRejectCode | null {
  const message = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  return TABLE_REJECTION_CODES.has(message as TableRejectCode) ? (message as TableRejectCode) : null
}

/**
 * Run a table binding and post its response, converting a recognized
 * `TableError` throw into a structured `TABLE_REJECTED` error. Non-table
 * throws (invalid sheet, missing method, serialize failure) rethrow to
 * the outer dispatcher, which posts a single generic error — no
 * double-post because this path posted nothing.
 */
function dispatchTable(id: number, run: () => unknown): void {
  let result: unknown
  try {
    result = run()
  } catch (err) {
    const code = tableRejectionCode(err)
    if (code === null) throw err
    postError(id, { code: 'TABLE_REJECTED', message: code, detail: { code } })
    return
  }
  postResponse(id, result)
}

let workerRuntimeInstalled = false

export function installWorkerRuntime() {
  if (workerRuntimeInstalled) return
  workerRuntimeInstalled = true

  ctx.addEventListener('message', async (e: MessageEvent) => {
    const msg = e.data as RequestMessage
    if (typeof msg.id !== 'number') return

    try {
      await ensureInit()
      let wb = await ensureWorkbook()
      switch (msg.cmd) {
        case 'initWorkbook':
          wb = resetWorkbook(Array.isArray(msg.sheets) ? msg.sheets.map(String) : undefined)
          postResponse(msg.id, sheetList(wb))
          break
        case 'sheetList':
          postResponse(msg.id, sheetList(wb))
          break
        case 'addSheet':
          postResponse(msg.id, wb.add_sheet(String(msg.name ?? 'Sheet')))
          break
        case 'renameSheet':
          postResponse(msg.id, wb.rename_sheet(Number(msg.sheet), String(msg.name ?? '')))
          break
        case 'removeSheet':
          {
            const removed = wb.remove_sheet(Number(msg.sheet))
            // Audit D-6: sheet indices shifted — sessions/subscriptions
            // keyed by index must not survive.
            if (removed) invalidateSheetIndexedState(wb)
            postResponse(msg.id, removed)
          }
          break
        case 'moveSheet':
          {
            const from = normalizeStructuralIndex(msg.from, 'source sheet index')
            const to = normalizeStructuralIndex(msg.to, 'target sheet index')
            assertSheet(wb, from)
            assertSheet(wb, to)
            const moved = assertMethod(wb, 'move_sheet').call(wb, from, to)
            // Audit D-6: same index-shift invalidation as removeSheet.
            if (from !== to) invalidateSheetIndexedState(wb)
            postResponse(msg.id, moved)
          }
          break
        case 'setCell':
          postResponse(
            msg.id,
            setCell(wb, Number(msg.sheet), normalizeAddr(msg.addr), msg.value as CellWire),
          )
          break
        case 'setFormula':
          assertSheet(wb, Number(msg.sheet))
          postResponse(
            msg.id,
            assertMethod(wb, 'setFormulaAt').call(
              wb,
              Number(msg.sheet),
              normalizeAddr(msg.addr),
              assertFormulaSource(msg.formula),
            ),
          )
          break
        case 'setFormulaDetailed':
          postResponse(
            msg.id,
            setFormulaDetailed(wb, Number(msg.sheet), normalizeAddr(msg.addr), msg.formula),
          )
          break
        case 'clearCell':
          assertSheet(wb, Number(msg.sheet))
          assertMethod(wb, 'clearCellAt').call(wb, Number(msg.sheet), normalizeAddr(msg.addr))
          postResponse(msg.id, true)
          break
        case 'clearRange':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const clearRange = assertMethod(wb, 'clear_range')
            postResponse(
              msg.id,
              clearRange.call(
                wb,
                range.sheet,
                range.startRow,
                range.startCol,
                range.endRow,
                range.endCol,
              ),
            )
          }
          break
        case 'insertRows':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const rowIndex = normalizeStructuralIndex(msg.rowIndex, 'row index')
            const count = normalizeStructuralCount(msg.count)
            assertSheet(wb, sheet)
            assertMethod(wb, 'insert_row').call(wb, sheet, rowIndex, count)
            postResponse(msg.id, true)
          }
          break
        case 'deleteRows':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const rowIndex = normalizeStructuralIndex(msg.rowIndex, 'row index')
            const count = normalizeStructuralCount(msg.count)
            assertSheet(wb, sheet)
            assertMethod(wb, 'delete_row').call(wb, sheet, rowIndex, count)
            postResponse(msg.id, true)
          }
          break
        case 'insertColumns':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const colIndex = normalizeStructuralIndex(msg.colIndex, 'column index')
            const count = normalizeStructuralCount(msg.count)
            assertSheet(wb, sheet)
            assertMethod(wb, 'insert_col').call(wb, sheet, colIndex, count)
            postResponse(msg.id, true)
          }
          break
        case 'deleteColumns':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const colIndex = normalizeStructuralIndex(msg.colIndex, 'column index')
            const count = normalizeStructuralCount(msg.count)
            assertSheet(wb, sheet)
            assertMethod(wb, 'delete_col').call(wb, sheet, colIndex, count)
            postResponse(msg.id, true)
          }
          break
        case 'sortRange':
          {
            const sheet = Number(msg.sheet)
            assertSheet(wb, sheet)
            const sortRange = assertMethod(wb, 'sortRange')
            // Payload ({ range, keys, excludedRows }) is the engine's
            // authority — forward it verbatim. The binding returns the
            // success report or a structured reject, both in its Ok arm;
            // only a catastrophic serialization failure throws (caught by
            // the outer try → toRpcError).
            const outcome = sortRange.call(wb, sheet, msg.payload) as
              | ({ ok?: true } & SortRangeReportWire)
              | ({ ok: false } & SortRangeRejectWire)
            if (outcome && (outcome as { ok?: unknown }).ok === false) {
              const reject = outcome as SortRangeRejectWire
              // Fail-closed: a structured engine reject surfaces as an RPC
              // error so the host's recordCellMutation wrapper (S4)
              // short-circuits before recording undo or bumping revision.
              // anchor/message ride on `detail` (SortRangeRejectWire).
              postError(msg.id, {
                code: 'SORT_REJECTED',
                message: reject.message ?? reject.code,
                detail: {
                  code: reject.code,
                  ...(reject.anchor === undefined ? {} : { anchor: reject.anchor }),
                  ...(reject.message === undefined ? {} : { message: reject.message }),
                },
              })
            } else {
              const report = outcome as SortRangeReportWire
              postResponse(msg.id, {
                movedRows: report.movedRows,
                movedCells: report.movedCells,
                rowPermutation: report.rowPermutation,
              })
            }
          }
          break
        case 'setEvalHiddenRows':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            // NOTE: no `assertSheet` — the engine treats an out-of-range
            // sheet as a silent no-op (workbook.rs `set_eval_hidden_rows`),
            // and this fire-and-forget eval-input push mirrors that tolerant
            // whole-set-replace contract rather than throwing.
            // Whole-set replace: coerce to a sanitized u32 list (drop
            // non-integers / negatives). The engine models no hidden state
            // — it consumes this purely as eval input and the paired epoch
            // bump re-derives only the 101-111 SUBTOTAL formulas.
            const rawRows = Array.isArray(msg.rows) ? (msg.rows as unknown[]) : []
            const rows: number[] = []
            for (const value of rawRows) {
              const index = Number(value)
              if (Number.isInteger(index) && index >= 0) rows.push(index)
            }
            assertMethod(wb, 'setEvalHiddenRows').call(wb, sheet, rows)
            postResponse(msg.id, true)
          }
          break
        case 'setEvalFilterHiddenRows':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            // Same tolerant whole-set-replace contract as its manual twin:
            // no `assertSheet` (the engine no-ops an unknown sheet index),
            // and the row list is re-sanitized defensively.
            const rawRows = Array.isArray(msg.rows) ? (msg.rows as unknown[]) : []
            const rows: number[] = []
            for (const value of rawRows) {
              const index = Number(value)
              if (Number.isInteger(index) && index >= 0) rows.push(index)
            }
            // NOT `assertMethod`: a wasm-pkg built before the export exists
            // must degrade, not fail the filter that triggered this push. An
            // explicit UNSUPPORTED is the honest answer — never a fake ACK,
            // and the host adapter stops pushing after seeing it.
            const push = wb.setEvalFilterHiddenRows
            if (typeof push !== 'function') {
              postError(msg.id, {
                code: 'UNSUPPORTED',
                message:
                  'WasmWorkbook.setEvalFilterHiddenRows is not available in this wasm build',
              })
              break
            }
            push.call(wb, sheet, rows)
            postResponse(msg.id, true)
          }
          break
        case 'createTable':
          {
            const sheet = Number(msg.sheet)
            assertSheet(wb, sheet)
            const bounds = (msg.bounds ?? {}) as {
              startRow: number
              startCol: number
              endRow: number
              endCol: number
            }
            const createTable = assertMethod(wb, 'createTable')
            const name = typeof msg.name === 'string' ? msg.name : undefined
            dispatchTable(msg.id, () =>
              createTable.call(
                wb,
                sheet,
                Number(bounds.startRow),
                Number(bounds.startCol),
                Number(bounds.endRow),
                Number(bounds.endCol),
                name,
              ),
            )
          }
          break
        case 'renameTable':
          {
            const renameTable = assertMethod(wb, 'renameTable')
            dispatchTable(msg.id, () => {
              renameTable.call(wb, String(msg.name), String(msg.newName))
              return true
            })
          }
          break
        case 'renameTableColumn':
          {
            const renameTableColumn = assertMethod(wb, 'renameTableColumn')
            dispatchTable(msg.id, () => {
              renameTableColumn.call(
                wb,
                String(msg.name),
                String(msg.oldColumn),
                String(msg.newColumn),
              )
              return true
            })
          }
          break
        case 'deleteTable':
          {
            const deleteTable = assertMethod(wb, 'deleteTable')
            dispatchTable(msg.id, () => {
              deleteTable.call(wb, String(msg.name))
              return true
            })
          }
          break
        case 'listTables':
          {
            const listTables = assertMethod(wb, 'listTables')
            dispatchTable(msg.id, () => listTables.call(wb))
          }
          break
        case 'getTable':
          {
            const getTable = assertMethod(wb, 'getTable')
            dispatchTable(msg.id, () => getTable.call(wb, String(msg.name)))
          }
          break
        case 'setTableTotalsRow':
          {
            const setTableTotalsRow = assertMethod(wb, 'setTableTotalsRow')
            dispatchTable(msg.id, () => {
              setTableTotalsRow.call(wb, String(msg.name), Boolean(msg.enabled))
              return true
            })
          }
          break
        case 'setTableTotalFunction':
          {
            const setTableTotalFunction = assertMethod(wb, 'setTableTotalFunction')
            dispatchTable(msg.id, () => {
              setTableTotalFunction.call(
                wb,
                String(msg.name),
                String(msg.column),
                String(msg.func),
              )
              return true
            })
          }
          break
        case 'snapshotTables':
          {
            const snapshotTables = assertMethod(wb, 'snapshotTables')
            dispatchTable(msg.id, () => snapshotTables.call(wb))
          }
          break
        case 'restoreTables':
          {
            // REPLACE semantics + all-or-nothing validation live in the
            // engine; the dispatcher only maps a refusal onto the shared
            // `TABLE_REJECTED` error so the host sees a structured reason
            // instead of a generic WORKER_ERROR.
            const restoreTables = assertMethod(wb, 'restoreTables')
            const snapshot = msg.snapshot as TableRegistrySnapshotWire
            dispatchTable(msg.id, () => restoreTables.call(wb, snapshot))
          }
          break
        // --- Engine-owned hidden rows + filter (E5) --------------------------
        //
        // The three filter commands forward the engine's `{ ok, … }` union
        // VERBATIM: a structured refusal (`source-too-large`, `invalid-sheet`)
        // rides in the resolved value, exactly as the wasm binding returns it,
        // so the host adapter discriminates on `ok` and never sees a throw for
        // a refusal. Only a serialization failure throws → outer toRpcError.
        case 'applyFilter':
          {
            const sheet = Number(msg.sheet)
            const applyFilter = assertMethod(wb, 'applyFilter')
            const rules = (Array.isArray(msg.rules) ? msg.rules : []) as ColumnFilterRuleWire[]
            postResponse(msg.id, applyFilter.call(wb, sheet, { rules }) as FilterApplyResultWire)
          }
          break
        case 'reapplyFilter':
          {
            const sheet = Number(msg.sheet)
            const reapplyFilter = assertMethod(wb, 'reapplyFilter')
            postResponse(msg.id, reapplyFilter.call(wb, sheet) as FilterApplyResultWire)
          }
          break
        case 'clearFilter':
          {
            const sheet = Number(msg.sheet)
            const clearFilter = assertMethod(wb, 'clearFilter')
            postResponse(msg.id, clearFilter.call(wb, sheet) as FilterApplyResultWire)
          }
          break
        case 'getFilter':
          {
            const sheet = Number(msg.sheet)
            const getFilter = assertMethod(wb, 'getFilter')
            postResponse(msg.id, getFilter.call(wb, sheet) as SheetFilterStateWire)
          }
          break
        case 'hideRows':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const rows = sanitizeRowList(msg.rows)
            postResponse(msg.id, assertMethod(wb, 'hideRows').call(wb, sheet, rows) as boolean)
          }
          break
        case 'unhideRows':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const rows = sanitizeRowList(msg.rows)
            postResponse(msg.id, assertMethod(wb, 'unhideRows').call(wb, sheet, rows) as boolean)
          }
          break
        case 'listHiddenRows':
          {
            const sheet = Number(msg.sheet)
            const listHiddenRows = assertMethod(wb, 'listHiddenRows')
            postResponse(msg.id, listHiddenRows.call(wb, sheet) as number[])
          }
          break
        case 'snapshotHidden':
          {
            const snapshotHidden = assertMethod(wb, 'snapshotHidden')
            postResponse(msg.id, snapshotHidden.call(wb) as HiddenRowsSnapshotWire)
          }
          break
        case 'restoreHidden':
          {
            const restoreHidden = assertMethod(wb, 'restoreHidden')
            const snapshot = msg.snapshot as HiddenRowsSnapshotWire
            postResponse(msg.id, restoreHidden.call(wb, snapshot) as number)
          }
          break
        case 'snapshotFilters':
          {
            const snapshotFilters = assertMethod(wb, 'snapshotFilters')
            postResponse(msg.id, snapshotFilters.call(wb) as FilterSnapshotWire)
          }
          break
        case 'restoreFilters':
          {
            const restoreFilters = assertMethod(wb, 'restoreFilters')
            const snapshot = msg.snapshot as FilterSnapshotWire
            postResponse(msg.id, restoreFilters.call(wb, snapshot) as number)
          }
          break
        case 'setFormatRange':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const setFormatRange = assertMethod(wb, 'set_format_range')
            postResponse(
              msg.id,
              setFormatRange.call(
                wb,
                range.sheet,
                range.startRow,
                range.startCol,
                range.endRow,
                range.endCol,
                msg.fmt as CellFormatJSON | null | undefined,
              ),
            )
          }
          break
        case 'snapshotFormatRange':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const snapshotFormatRange = assertMethod(wb, 'snapshot_format_range')
            postResponse(
              msg.id,
              snapshotFormatRange.call(
                wb,
                range.sheet,
                range.startRow,
                range.startCol,
                range.endRow,
                range.endCol,
              ),
            )
          }
          break
        case 'restoreFormatSnapshot':
          {
            const restoreFormatSnapshot = assertMethod(wb, 'restore_format_snapshot')
            postResponse(
              msg.id,
              restoreFormatSnapshot.call(wb, msg.snapshot as FormatRangeSnapshot),
            )
          }
          break
        case 'snapshotViewportSizes':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const snapshotViewportSizes = assertMethod(wb, 'snapshot_viewport_sizes')
            postResponse(
              msg.id,
              snapshotViewportSizes.call(
                wb,
                range.sheet,
                range.startRow,
                range.startCol,
                range.endRow,
                range.endCol,
              ),
            )
          }
          break
        case 'setRowHeight':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const rowIndex = normalizeStructuralIndex(msg.rowIndex, 'row index')
            const heightPx = normalizeDimensionPx(msg.heightPx, 'row height')
            assertSheet(wb, sheet)
            postResponse(
              msg.id,
              assertMethod(wb, 'set_row_height').call(wb, sheet, rowIndex, heightPx),
            )
          }
          break
        case 'setColumnWidth':
          {
            const sheet = normalizeStructuralIndex(msg.sheet, 'sheet index')
            const colIndex = normalizeStructuralIndex(msg.colIndex, 'column index')
            const widthPx = normalizeDimensionPx(msg.widthPx, 'column width')
            assertSheet(wb, sheet)
            postResponse(
              msg.id,
              assertMethod(wb, 'set_col_width').call(wb, sheet, colIndex, widthPx),
            )
          }
          break
        case 'beginImport':
          {
            const sessionId = Number(msg.sessionId)
            assertImportSessionId(sessionId)
            if (importSessions.has(sessionId)) {
              throw Object.assign(new Error(`import session already exists: ${sessionId}`), {
                code: 'IMPORT_SESSION_EXISTS',
              })
            }
            const mode = normalizeImportSessionMode(msg.mode, msg.atomic)
            const baseSession = {
              normalizedCount: 0,
              stats: emptyImportStats(),
              normalizationIssues: [],
            }
            importSessions.set(
              sessionId,
              mode === 'direct'
                ? {
                    ...baseSession,
                    mode,
                    workbook: wb,
                  }
                : {
                    ...baseSession,
                    mode,
                    workbook: createWorkbookShell(wb),
                    finalTouches: new Map(),
                  },
            )
            postResponse(msg.id, sessionId)
          }
          break
        case 'beginExportRangeTsv':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const rowsPerChunk = clampRowsPerChunk(msg.rowsPerChunk)
            const sessionId = nextExportId++
            exportSessions.set(sessionId, {
              range,
              rowsPerChunk,
              totalRows: rangeTotalRows(range),
              nextRow: range.startRow,
            })
            postResponse(msg.id, {
              sessionId,
              totalRows: rangeTotalRows(range),
              rowsPerChunk,
            })
          }
          break
        case 'beginSnapshotRangeSparse':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const rowsPerChunk = clampRowsPerChunk(msg.rowsPerChunk)
            const sessionId = nextSnapshotId++
            snapshotSessions.set(sessionId, {
              range,
              rowsPerChunk,
              totalRows: rangeTotalRows(range),
              nextRow: range.startRow,
            })
            postResponse(msg.id, {
              sessionId,
              totalRows: rangeTotalRows(range),
              rowsPerChunk,
            })
          }
          break
        case 'importChunk':
          {
            const sessionId = Number(msg.sessionId)
            assertImportSessionId(sessionId)
            const session = importSessions.get(sessionId)
            if (!session) {
              throw Object.assign(new Error(`missing import session: ${sessionId}`), {
                code: 'IMPORT_SESSION_MISSING',
              })
            }
            const rawCells = Array.isArray(msg.cells) ? msg.cells : []
            ensureImportChunkSize(rawCells)
            const chunk = normalizeImportCells(rawCells as ImportCellWire[])
            ensureImportSessionLimits(session, chunk)
            if (chunk.cells.length > 0) {
              // STORAGE_PRIMARY Phase 6.3: atomic chunks only stage —
              // the shell install happens once at commit through
              // `bulk_install_workbook`. Direct chunks keep writing
              // additively into the live workbook via the legacy path.
              const stats =
                session.mode === 'atomic'
                  ? stageAtomicChunkStats(session, chunk.cells)
                  : importCellsIntoDirectSession(session, chunk.cells)
              session.stats = mergeImportStats(session.stats, stats)
              if (session.mode === 'atomic') recordFinalTouches(session, chunk.cells)
              session.normalizedCount += chunk.cells.length
            }
            session.normalizationIssues.push(...chunk.issues)
            postResponse(msg.id, session.normalizedCount)
          }
          break
        case 'nextExportRangeTsvChunk':
          {
            const sessionId = Number(msg.sessionId)
            assertExportSessionId(sessionId)
            const session = exportSessions.get(sessionId)
            if (!session) {
              throw Object.assign(new Error(`missing export session: ${sessionId}`), {
                code: 'EXPORT_SESSION_MISSING',
              })
            }
            const chunk = exportRangeTsvChunk(wb, session)
            if (chunk.done) exportSessions.delete(sessionId)
            postResponse(msg.id, {
              sessionId,
              ...chunk,
            })
          }
          break
        case 'nextSnapshotRangeSparseChunk':
          {
            const sessionId = Number(msg.sessionId)
            assertSnapshotSessionId(sessionId)
            const session = snapshotSessions.get(sessionId)
            if (!session) {
              throw Object.assign(new Error(`missing snapshot session: ${sessionId}`), {
                code: 'SNAPSHOT_SESSION_MISSING',
              })
            }
            const chunk = snapshotRangeSparseChunk(wb, session)
            if (chunk.done) snapshotSessions.delete(sessionId)
            postResponse(msg.id, {
              sessionId,
              ...chunk,
            })
          }
          break
        case 'commitImport':
          {
            const sessionId = Number(msg.sessionId)
            assertImportSessionId(sessionId)
            const session = importSessions.get(sessionId)
            if (!session) {
              throw Object.assign(new Error(`missing import session: ${sessionId}`), {
                code: 'IMPORT_SESSION_MISSING',
              })
            }
            if (session.mode === 'direct') {
              importSessions.delete(sessionId)
              postResponse(
                msg.id,
                mergeImportStatsIssues(session.stats, session.normalizationIssues),
              )
              break
            }
            // STORAGE_PRIMARY Phase 6.3: the staged cells land in the
            // fresh shell in ONE storage-primary install, then the
            // snapshot below reads the final cell states back (lazy
            // formulas serialize their source without evaluating).
            installAtomicStagingIntoShell(session)
            const changedCells = snapshotFinalImportTouches(session)
            const finalClears = finalImportClears(session)
            const finalWrites = [...changedCells.map(sparseCellToImportCell), ...finalClears]
            let stats = session.stats
            if (finalWrites.length > 0) {
              // TODO(6.4): the replay onto the LIVE workbook is additive
              // (it may hold content outside the imported range), so it
              // stays on the legacy `bulk_import_cells` — full-sheet
              // replace would tear down unrelated cells.
              const finalStats = assertMethod(wb, 'bulk_import_cells').call(wb, finalWrites)
              stats = mergeFinalCommitStats(stats, finalStats)
            }

            importSessions.delete(sessionId)
            postResponse(msg.id, mergeImportStatsIssues(stats, session.normalizationIssues))
          }
          break
        case 'cancelExport':
          {
            const sessionId = Number(msg.sessionId)
            assertExportSessionId(sessionId)
            const existed = exportSessions.delete(sessionId)
            postResponse(msg.id, existed)
          }
          break
        case 'cancelSnapshot':
          {
            const sessionId = Number(msg.sessionId)
            assertSnapshotSessionId(sessionId)
            const existed = snapshotSessions.delete(sessionId)
            postResponse(msg.id, existed)
          }
          break
        case 'cancelImport':
          {
            const sessionId = Number(msg.sessionId)
            assertImportSessionId(sessionId)
            const existed = importSessions.delete(sessionId)
            postResponse(msg.id, existed)
          }
          break
        case 'readCells':
          postResponse(
            msg.id,
            Array.isArray(msg.cells)
              ? msg.cells.map((cell) => snapshotCell(wb, cell as CellRefWire))
              : [],
          )
          break
        case 'listNonEmpty':
          {
            const listNonEmpty = assertMethod(wb, 'list_non_empty_cells')
            postResponse(msg.id, listNonEmpty.call(wb).map(normalizeRefWire))
          }
          break
        case 'snapshotSparse':
          {
            const snapshotSparse = assertMethod(wb, 'snapshot_sparse')
            postResponse(msg.id, snapshotSparse.call(wb).map(normalizeSparseCell))
          }
          break
        case 'snapshotRangeSparse':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const snapshotRangeSparse = assertMethod(wb, 'snapshot_range_sparse')
            postResponse(
              msg.id,
              snapshotRangeSparse
                .call(wb, range.sheet, range.startRow, range.startCol, range.endRow, range.endCol)
                .map(normalizeSparseCell),
            )
          }
          break
        case 'snapshotPersistenceV1':
          {
            const snapshotPersistenceV1 = assertMethod(wb, 'snapshot_persistence_v1')
            postResponse(msg.id, snapshotPersistenceV1.call(wb))
          }
          break
        case 'restorePersistenceV1':
          {
            const restorePersistenceV1 = assertMethod(wb, 'restore_persistence_v1')
            const stats = restorePersistenceV1.call(
              wb,
              msg.snapshot as WorkbookPersistenceSnapshotWire,
            )
            resetSubscriptions(wb)
            importSessions.clear()
            exportSessions.clear()
            snapshotSessions.clear()
            nextExportId = 1
            nextSnapshotId = 1
            postResponse(msg.id, stats)
          }
          break
        case 'exportRangeTsv':
          {
            const range = normalizeSparseRange(msg.range)
            postResponse(msg.id, exportRangeTsv(wb, range))
          }
          break
        case 'restoreSparse':
          {
            const restoreSparse = assertMethod(wb, 'restore_sparse')
            const cells = Array.isArray(msg.cells)
              ? (msg.cells as SparseCellWire[]).map(normalizeSparseCell)
              : []
            postResponse(msg.id, restoreSparse.call(wb, cells))
          }
          break
        case 'readSparseRange':
          {
            const range = normalizeSparseRange(msg.range)
            assertSheet(wb, range.sheet)
            const readSparseRange = assertMethod(wb, 'read_sparse_range')
            postResponse(
              msg.id,
              readSparseRange
                .call(wb, range.sheet, range.startRow, range.startCol, range.endRow, range.endCol)
                .map(normalizeSnapshot),
            )
          }
          break
        case 'debugFormulaCacheState':
          assertSheet(wb, Number(msg.sheet))
          postResponse(
            msg.id,
            wb.debug_formula_cache_state
              ? wb.debug_formula_cache_state(Number(msg.sheet), normalizeAddr(msg.addr))
              : 'unknown',
          )
          break
        case 'debugFormulaEvalCount':
          assertSheet(wb, Number(msg.sheet))
          postResponse(
            msg.id,
            wb.debug_formula_eval_count ? wb.debug_formula_eval_count(Number(msg.sheet)) : 0,
          )
          break
        case 'subscribeCells':
          subscribeCells(
            wb,
            Number(msg.subId),
            Array.isArray(msg.cells) ? (msg.cells as CellRefWire[]) : [],
          )
          postResponse(msg.id, true)
          break
        case 'unsubscribeCells':
          unsubscribeCells(wb, Number(msg.subId))
          postResponse(msg.id, true)
          break
        case 'registerCustomFormula':
          postResponse(
            msg.id,
            registerCustomFormulaInWorker(wb, msg.name as string, msg.source, msg.isAsync === true),
          )
          break
        case 'unregisterCustomFormula':
          postResponse(msg.id, unregisterCustomFormulaInWorker(wb, msg.name))
          break
        case 'defineName':
        case 'undefineName':
          // The WASM engine (`rust/excel-core`) does not implement
          // LAMBDA name bindings. Range / value bindings are tracked
          // host-side by `worker-workbook-backend.ts` directly; the
          // worker only sees `defineName` when a host wants the engine
          // to learn about a LAMBDA. We refuse with a structured error
          // so the adapter can fall back gracefully.
          throw Object.assign(
            new Error('LAMBDA name bindings are not supported by the WASM runtime — use the TS backend (?backend=ts).'),
            { code: 'NAME_BINDING_UNSUPPORTED' },
          )
        case 'debugCounters':
          postResponse(msg.id, debugCounters(wb))
          break
        default:
          throw Object.assign(new Error(`unknown command: ${String(msg.cmd)}`), {
            code: 'UNKNOWN_COMMAND',
          })
      }
    } catch (err) {
      postError(msg.id, toRpcError(err))
    } finally {
      // Wave 8.2: any command can surface new async custom-formula
      // requests (reads evaluate formulas lazily; settles cascade).
      // Fire-and-forget — an empty drain is near-free, and settles
      // notify the host through the normal subscription dirty path.
      asyncCustomPump.pump()
    }
  })
}

installWorkerRuntime()
