/// <reference lib="WebWorker" />

import init, { WasmWorkbook } from '../wasm-pkg/einfach_wasm.js'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  ImportCellWire,
  RpcErrorWire,
  RpcResponseWire,
  SparseCellWire,
  SparseRangeWire,
  WorkbookImportStatsWire,
  WorkbookSheetMeta,
} from './wasm-workbook-proxy'

const ctx = self as unknown as DedicatedWorkerGlobalScope

type WasmWorkbookRuntime = {
  sheet_count(): number
  sheet_name(idx: number): string
  add_sheet(name: string): number
  rename_sheet(idx: number, name: string): boolean
  remove_sheet(idx: number): boolean
  set_cell_number(sheetIdx: number, addr: string, value: number): void
  set_cell_text(sheetIdx: number, addr: string, value: string): void
  set_cell_boolean(sheetIdx: number, addr: string, value: boolean): void
  set_cell_error(sheetIdx: number, addr: string, value: string): void
  clearCellAt(sheetIdx: number, addr: string): void
  setFormulaAt(sheetIdx: number, addr: string, formula: string): boolean
  subscribe_cell?: (sheetName: string, addr: string, callback: () => void) => number
  unsubscribe_cell?: (token: number) => void
  get_display(sheetIdx: number, addr: string): string
  get_number(sheetIdx: number, addr: string): number
  get_type(sheetIdx: number, addr: string): string
  is_error(sheetIdx: number, addr: string): boolean
  get_formula(sheetIdx: number, addr: string): string
  bulk_import_cells(cells: ImportCellWire[]): WorkbookImportStatsWire
  list_non_empty_cells?: () => CellRefWire[]
  snapshot_sparse?: () => SparseCellWire[]
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
  debug_formula_cache_state?: (sheetIdx: number, addr: string) => string
  debug_cross_sheet_dependents_count?: () => number
}

type RequestMessage = {
  id?: number
  cmd?: string
  [key: string]: unknown
}

let workbook: WasmWorkbookRuntime | undefined
let initPromise: Promise<void> | undefined

const subscriptionTokens = new Map<number, number[]>()
const importSessions = new Map<number, ImportCellWire[]>()

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
  const wb = new WasmWorkbook() as unknown as WasmWorkbookRuntime
  if (sheets && sheets.length > 0) {
    wb.rename_sheet(0, sheets[0])
    for (const name of sheets.slice(1)) wb.add_sheet(name)
  }
  workbook = wb
  return wb
}

function snapshotCell(wb: WasmWorkbookRuntime, ref: CellRefWire): CellSnapshotWire {
  const addr = normalizeAddr(ref.addr)
  const sheet = ref.sheet
  return {
    sheet,
    addr,
    display: wb.get_display(sheet, addr),
    type: wb.get_type(sheet, addr) as CellSnapshotWire['type'],
    isError: wb.is_error(sheet, addr),
    formula: wb.get_formula(sheet, addr),
  }
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

function normalizeImportCell(cell: ImportCellWire): ImportCellWire {
  const sheet = Number(cell.sheet)
  const row = Number(cell.row)
  const col = Number(cell.col)
  if (
    !Number.isInteger(sheet) ||
    sheet < 0 ||
    !Number.isInteger(row) ||
    row < 0 ||
    !Number.isInteger(col) ||
    col < 0
  ) {
    throw Object.assign(new Error('invalid import cell coordinates'), {
      code: 'INVALID_IMPORT_CELL',
    })
  }

  switch (cell.kind) {
    case 'number':
      if (typeof cell.value !== 'number') break
      return { sheet, row, col, kind: 'number', value: cell.value }
    case 'text':
      if (typeof cell.value !== 'string') break
      return { sheet, row, col, kind: 'text', value: cell.value }
    case 'boolean':
      if (typeof cell.value !== 'boolean') break
      return { sheet, row, col, kind: 'boolean', value: cell.value }
    case 'error':
      if (typeof cell.value !== 'string') break
      return { sheet, row, col, kind: 'error', value: cell.value }
    case 'formula':
      if (typeof cell.value !== 'string') break
      return { sheet, row, col, kind: 'formula', value: cell.value }
    case 'null':
      return { sheet, row, col, kind: 'null' }
    default:
      break
  }

  throw Object.assign(new Error('invalid import cell value'), {
    code: 'INVALID_IMPORT_CELL',
  })
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

function toRpcError(err: unknown): RpcErrorWire {
  if (err instanceof Error) {
    return {
      code: String((err as Error & { code?: string }).code ?? 'WORKER_ERROR'),
      message: err.message,
    }
  }
  return { code: 'WORKER_ERROR', message: String(err) }
}

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
            String(msg.formula ?? ''),
          ),
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
      case 'beginImport':
        {
          const sessionId = Number(msg.sessionId)
          assertImportSessionId(sessionId)
          if (importSessions.has(sessionId)) {
            throw Object.assign(new Error(`import session already exists: ${sessionId}`), {
              code: 'IMPORT_SESSION_EXISTS',
            })
          }
          importSessions.set(sessionId, [])
          postResponse(msg.id, sessionId)
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
          const cells = Array.isArray(msg.cells)
            ? (msg.cells as ImportCellWire[]).map(normalizeImportCell)
            : []
          session.push(...cells)
          postResponse(msg.id, session.length)
        }
        break
      case 'commitImport':
        {
          const sessionId = Number(msg.sessionId)
          assertImportSessionId(sessionId)
          const cells = importSessions.get(sessionId)
          if (!cells) {
            throw Object.assign(new Error(`missing import session: ${sessionId}`), {
              code: 'IMPORT_SESSION_MISSING',
            })
          }
          importSessions.delete(sessionId)
          postResponse(msg.id, assertMethod(wb, 'bulk_import_cells').call(wb, cells))
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
        postResponse(msg.id, {
          sheetCount: wb.sheet_count(),
          crossSheetDependents: wb.debug_cross_sheet_dependents_count?.() ?? 0,
        })
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
