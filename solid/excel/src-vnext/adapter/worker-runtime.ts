/// <reference lib="WebWorker" />

import init, { WasmWorkbook } from '../../wasm-pkg/einfach_wasm.js'
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
  RpcErrorWire,
  RpcResponseWire,
  SparseCellWire,
  SparseRangeWire,
  WorkbookImportStatsWire,
  WorkbookSheetMeta,
} from './worker-protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

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
}

type RequestMessage = {
  id?: number
  cmd?: string
  [key: string]: unknown
}

type ImportSession = {
  workbook: WasmWorkbookRuntime
  normalizedCount: number
  stats: WorkbookImportStatsWire
  normalizationIssues: ImportCellIssueWire[]
  finalTouches: Map<string, ImportCellWire>
}

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

let workbook: WasmWorkbookRuntime | undefined
let initPromise: Promise<void> | undefined

const subscriptionTokens = new Map<number, number[]>()
const importSessions = new Map<number, ImportSession>()
const exportSessions = new Map<number, ExportSession>()
let nextExportId = 1

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

function resetWorkbook(sheets?: string[]): WasmWorkbookRuntime {
  resetSubscriptions(workbook)
  importSessions.clear()
  exportSessions.clear()
  nextExportId = 1
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

function projectedFinalTouches(session: ImportSession, cells: ImportCellWire[]): number {
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
  if (session.normalizationIssues.length + chunk.issues.length > importLimits.issues) {
    throw Object.assign(new Error('import session exceeded issue limit'), {
      code: 'IMPORT_ISSUES_LIMIT_EXCEEDED',
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

function recordFinalTouches(session: ImportSession, cells: ImportCellWire[]) {
  for (const cell of cells) session.finalTouches.set(importCellKey(cell), cell)
}

function snapshotFinalImportTouches(session: ImportSession): SparseCellWire[] {
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

function finalImportClears(session: ImportSession): ImportCellWire[] {
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

function normalizeStructuralCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1) {
    throw Object.assign(new Error('invalid structural edit count'), {
      code: 'INVALID_STRUCTURAL_EDIT',
    })
  }
  return count
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

function toRpcError(err: unknown): RpcErrorWire {
  if (err instanceof Error) {
    return {
      code: String((err as Error & { code?: string }).code ?? 'WORKER_ERROR'),
      message: err.message,
    }
  }
  return { code: 'WORKER_ERROR', message: String(err) }
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
          postResponse(msg.id, wb.remove_sheet(Number(msg.sheet)))
          break
        case 'moveSheet':
          {
            const from = normalizeStructuralIndex(msg.from, 'source sheet index')
            const to = normalizeStructuralIndex(msg.to, 'target sheet index')
            assertSheet(wb, from)
            assertSheet(wb, to)
            postResponse(msg.id, assertMethod(wb, 'move_sheet').call(wb, from, to))
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
        case 'beginImport':
          {
            const sessionId = Number(msg.sessionId)
            assertImportSessionId(sessionId)
            if (importSessions.has(sessionId)) {
              throw Object.assign(new Error(`import session already exists: ${sessionId}`), {
                code: 'IMPORT_SESSION_EXISTS',
              })
            }
            importSessions.set(sessionId, {
              workbook: createWorkbookShell(wb),
              normalizedCount: 0,
              stats: emptyImportStats(),
              normalizationIssues: [],
              finalTouches: new Map(),
            })
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
              const stats = assertMethod(session.workbook, 'bulk_import_cells').call(
                session.workbook,
                chunk.cells,
              )
              session.stats = mergeImportStats(session.stats, stats)
              recordFinalTouches(session, chunk.cells)
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
            const changedCells = snapshotFinalImportTouches(session)
            const finalClears = finalImportClears(session)
            const finalWrites = [...changedCells.map(sparseCellToImportCell), ...finalClears]
            let stats = session.stats
            if (finalWrites.length > 0) {
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
            nextExportId = 1
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
    }
  })
}

installWorkerRuntime()
