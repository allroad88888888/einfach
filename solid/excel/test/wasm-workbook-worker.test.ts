import { describe, expect, it, jest } from '@jest/globals'
import {
  MAX_IMPORT_CHUNK_CELLS,
  MAX_IMPORT_SESSION_NORMALIZED_CELLS,
  __resetImportLimitsForTest,
  __setImportLimitsForTest,
  mergeImportStatsIssues,
  normalizeImportCells,
} from '../src-vnext/adapter/worker-runtime'
import type {
  CellFormatJSON,
  FormatRangeSnapshot,
  FormulaMutationResultWire,
  ImportCellWire,
  WorkbookPersistenceRestoreStatsWire,
  WorkbookPersistenceSnapshotWire,
  WorkerWorkbookDebugCountersWire,
  ViewportSizeSnapshotWire,
  SparseCellWire,
  SparseRangeWire,
  WorkbookImportStatsWire,
} from '../src/wasm-workbook-proxy'
import { WasmWorkbook } from '../wasm-pkg/einfach_wasm.js'

jest.mock('../wasm-pkg/einfach_wasm.js', () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
  WasmWorkbook: jest.fn(),
}))

type MockCellState = {
  type: 'number' | 'text' | 'boolean' | 'error' | 'formula' | 'null'
  display: string
  formula: string
  isError: boolean
}

type MockFormulaFailure = {
  display: string
}

type MockWasmWorkbookOptions = {
  formulaFailuresByFormula?: Record<string, MockFormulaFailure>
  disablePersistenceV1?: boolean
  disableBulkInstallWorkbook?: boolean
  bulkImportFailureAfterApply?: string
}

// STORAGE_PRIMARY Phase 6.3 — mirrors the wasm `bulk_install_workbook`
// wire: per-sheet `[addr, value]` pairs, addr as zero-based `"R:C"`.
type MockBulkInstallSheetPayload = {
  sheet: number
  primitives: Array<[string, number | string | boolean | { error: string }]>
  formulas: Array<[string, string]>
}

type MockWasmWorkbook = {
  sheet_count: () => number
  sheet_name: (idx: number) => string
  add_sheet: (name: string) => number
  rename_sheet: (idx: number, name: string) => boolean
  remove_sheet: (idx: number) => boolean
  move_sheet: (from: number, to: number) => boolean
  snapshotCell: (
    sheet: number,
    addr: string,
  ) => {
    sheet: number
    addr: string
    display: string
    type: MockCellState['type']
    isError: boolean
    formula: string
  }
  bulk_import_cells: (cells: ImportCellWire[]) => WorkbookImportStatsWire
  bulk_install_workbook?: (payload: MockBulkInstallSheetPayload[]) => unknown
  list_non_empty_cells: () => { sheet: number; addr: string }[]
  set_cell_number: (sheet: number, addr: string, value: number) => void
  set_cell_text: (sheet: number, addr: string, value: string) => void
  set_cell_boolean: (sheet: number, addr: string, value: boolean) => void
  set_cell_error: (sheet: number, addr: string, value: string) => void
  clearCellAt: (sheet: number, addr: string) => void
  setFormulaAt: (sheet: number, addr: string, formula: string) => boolean
  insert_row: (sheet: number, at: number, count: number) => void
  delete_row: (sheet: number, at: number, count: number) => void
  insert_col: (sheet: number, at: number, count: number) => void
  delete_col: (sheet: number, at: number, count: number) => void
  snapshot_sparse: () => unknown[]
  snapshot_range_sparse: (
    sheet: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => unknown[]
  restore_sparse: (cells: unknown[]) => number
  snapshot_persistence_v1?: () => WorkbookPersistenceSnapshotWire
  restore_persistence_v1?: (
    snapshot: WorkbookPersistenceSnapshotWire,
  ) => WorkbookPersistenceRestoreStatsWire
  read_sparse_range: () => unknown[]
  clear_range: () => number
  set_format_range: (
    sheet: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    fmt: CellFormatJSON | null | undefined,
  ) => number
  snapshot_format_range: (
    sheet: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => FormatRangeSnapshot
  restore_format_snapshot: (snapshot: FormatRangeSnapshot) => number
  snapshot_viewport_sizes: (
    sheet: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => ViewportSizeSnapshotWire
  set_row_height: (sheet: number, rowIndex: number, heightPx: number) => boolean
  set_col_width: (sheet: number, colIndex: number, widthPx: number) => boolean
  debug_formula_cache_state: () => string
  debug_formula_eval_count: (sheet?: number) => number
  debug_formula_eval_count_total: () => number
  debug_formula_count: () => number
  debug_live_subscription_count: () => number
  debug_sheet_live_subscription_count: (sheet: number) => number
  debug_sheet_formula_count: (sheet: number) => number
  debug_cross_sheet_dependents_count: () => number
  subscribe_cell: (_sheetName: string, _addr: string, _callback: () => void) => number
  unsubscribe_cell: (token: number) => void
  __mockInstanceId?: number
  __mockCalls?: {
    bulkImportCells: number
    bulkImportPayloads: ImportCellWire[][]
    bulkInstallWorkbookPayloads: MockBulkInstallSheetPayload[][]
    snapshotSparse: number
    snapshotRangeSparse: SparseRangeWire[]
    restoreSparse: SparseCellWire[][]
    snapshotPersistenceV1: number
    restorePersistenceV1: WorkbookPersistenceSnapshotWire[]
    setFormatRange: Array<SparseRangeWire & { fmt: CellFormatJSON | null | undefined }>
    snapshotFormatRange: SparseRangeWire[]
    restoreFormatSnapshot: FormatRangeSnapshot[]
    snapshotViewportSizes: SparseRangeWire[]
    setRowHeights: Array<{ sheet: number; rowIndex: number; heightPx: number }>
    setColWidths: Array<{ sheet: number; colIndex: number; widthPx: number }>
    insertRows: Array<{ sheet: number; at: number; count: number }>
    deleteRows: Array<{ sheet: number; at: number; count: number }>
    insertCols: Array<{ sheet: number; at: number; count: number }>
    deleteCols: Array<{ sheet: number; at: number; count: number }>
    moveSheets: Array<{ from: number; to: number }>
    subscribeTokens: number[]
    unsubscribeTokens: number[]
  }
}

type MockWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

function toAddress(col: number, row: number) {
  let out = ''
  let x = col + 1
  while (x > 0) {
    const rem = (x - 1) % 26
    out = `${String.fromCharCode(65 + rem)}${out}`
    x = Math.floor((x - 1) / 26)
  }
  return `${out}${row + 1}`
}

function parseAddress(addr: string): { row: number; col: number } {
  const match = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!match) return { row: -1, col: -1 }
  let col = 0
  for (let i = 0; i < match[1].length; i++) col = col * 26 + (match[1].charCodeAt(i) - 64)
  return { row: Number(match[2]) - 1, col: col - 1 }
}

function makeNumberCell(index: number, sheet = 0): ImportCellWire {
  return {
    sheet,
    row: Math.floor(index / 2),
    col: index % 2,
    kind: 'number',
    value: index,
  }
}

function makeInvalidIssueCell(index: number) {
  return {
    sheet: 0,
    row: Math.floor(index / 1000),
    col: index % 1000,
    kind: 'not-a-kind',
  } as unknown
}

function makeNumberCells(count: number) {
  return Array.from({ length: count }, (_value, index) => makeNumberCell(index))
}

function createMockWasmWorkbook(options: MockWasmWorkbookOptions = {}) {
  const calls: NonNullable<MockWasmWorkbook['__mockCalls']> = {
    bulkImportCells: 0,
    bulkImportPayloads: [],
    bulkInstallWorkbookPayloads: [],
    snapshotSparse: 0,
    snapshotRangeSparse: [],
    restoreSparse: [],
    snapshotPersistenceV1: 0,
    restorePersistenceV1: [],
    setFormatRange: [],
    snapshotFormatRange: [],
    restoreFormatSnapshot: [],
    snapshotViewportSizes: [],
    setRowHeights: [],
    setColWidths: [],
    insertRows: [],
    deleteRows: [],
    insertCols: [],
    deleteCols: [],
    moveSheets: [],
    subscribeTokens: [],
    unsubscribeTokens: [],
  }
  const sheets = ['Sheet1']
  const cells = new Map<string, MockCellState>()
  let nextToken = 1
  const activeSubscriptions = new Map<number, number>()
  const restorePersistenceData: WorkbookPersistenceSnapshotWire | undefined =
    options.disablePersistenceV1
      ? undefined
      : { version: 1, sheets: [{ idx: 0, name: 'Sheet1' }], cells: [], formats: [], sizes: [] }
  const restorePersistenceDefaultReturn: WorkbookPersistenceRestoreStatsWire = {
    restored_cells: 0,
    restored_formats: 0,
    sheets: 1,
  }
  let didFailBulkImportAfterApply = false

  function key(sheet: number, addr: string) {
    return `${sheet}:${addr.toUpperCase()}`
  }

  function setPrimitive(
    sheet: number,
    addr: string,
    type: 'number' | 'text' | 'boolean' | 'error',
    value: string | number | boolean,
  ) {
    cells.set(key(sheet, addr), {
      type,
      display: type === 'boolean' ? ((value as boolean) ? 'TRUE' : 'FALSE') : String(value),
      formula: '',
      isError: type === 'error',
    })
  }

  function sparseFromState(sheet: number, addr: string, state: MockCellState) {
    const parsed = parseAddress(addr)
    if (state.type === 'formula') {
      return {
        sheet,
        addr,
        row: parsed.row,
        col: parsed.col,
        kind: 'formula',
        value: state.formula,
      }
    }
    if (state.type === 'number') {
      return {
        sheet,
        addr,
        row: parsed.row,
        col: parsed.col,
        kind: 'number',
        value: Number(state.display),
      }
    }
    if (state.type === 'boolean') {
      return {
        sheet,
        addr,
        row: parsed.row,
        col: parsed.col,
        kind: 'boolean',
        value: state.display === 'TRUE',
      }
    }
    if (state.type === 'error') {
      return { sheet, addr, row: parsed.row, col: parsed.col, kind: 'error', value: state.display }
    }
    if (state.type === 'text') {
      return { sheet, addr, row: parsed.row, col: parsed.col, kind: 'text', value: state.display }
    }
    return null
  }

  function setFromImport(cellsIn: ImportCellWire[]) {
    for (const cell of cellsIn) {
      const addr = toAddress(cell.col, cell.row)
      const mapKey = key(cell.sheet, addr)

      if (cell.kind === 'null') {
        cells.delete(mapKey)
        continue
      }

      if (cell.kind === 'formula') {
        cells.set(mapKey, {
          type: 'formula',
          display: '',
          formula: cell.value,
          isError: false,
        })
        continue
      }

      cells.set(mapKey, {
        type: cell.kind,
        display: String(cell.value),
        formula: '',
        isError: cell.kind === 'error',
      })
    }
  }

  const workbook: MockWasmWorkbook = {
    sheet_count: () => sheets.length,
    sheet_name: (idx: number) => sheets[idx] ?? '',
    add_sheet: (name: string) => {
      const idx = sheets.length
      sheets.push(name)
      return idx
    },
    rename_sheet: (idx: number, name: string) => {
      if (idx < 0 || idx >= sheets.length) return false
      sheets[idx] = name
      return true
    },
    remove_sheet: (idx: number) => {
      if (idx < 0 || idx >= sheets.length) return false
      sheets.splice(idx, 1)
      return true
    },
    move_sheet: (from: number, to: number) => {
      calls.moveSheets.push({ from, to })
      if (from < 0 || from >= sheets.length || to < 0 || to >= sheets.length) return false
      const [sheet] = sheets.splice(from, 1)
      sheets.splice(to, 0, sheet)
      return true
    },
    snapshotCell: (sheet: number, addr: string) => {
      const state = cells.get(key(sheet, addr))
      if (!state) {
        return {
          sheet,
          addr: addr.toUpperCase(),
          display: '',
          type: 'null',
          isError: false,
          formula: '',
        }
      }
      return {
        sheet,
        addr: addr.toUpperCase(),
        display: state.display,
        type: state.type,
        isError: state.isError,
        formula: state.formula,
      }
    },
    bulk_import_cells: (cellsIn: ImportCellWire[]) => {
      calls.bulkImportCells += 1
      calls.bulkImportPayloads.push(cellsIn)
      setFromImport(cellsIn)
      if (options.bulkImportFailureAfterApply && !didFailBulkImportAfterApply) {
        didFailBulkImportAfterApply = true
        throw new Error(options.bulkImportFailureAfterApply)
      }
      return {
        accepted: cellsIn.length,
        formulas: cellsIn.filter((cell) => cell.kind === 'formula').length,
        rejectedFormulas: 0,
        cleared: cellsIn.filter((cell) => cell.kind === 'null').length,
        errors: 0,
      }
    },
    // STORAGE_PRIMARY Phase 6.3 — full-sheet replace per listed sheet,
    // matching `Workbook::install_sheet_bulk` semantics. Optional like
    // the real binding (absent on pre-Phase-6.2 wasm-pkg builds).
    ...(options.disableBulkInstallWorkbook
      ? {}
      : {
          bulk_install_workbook: (payload: MockBulkInstallSheetPayload[]) => {
            calls.bulkInstallWorkbookPayloads.push(payload)
            for (const entry of payload) {
              if (entry.sheet >= sheets.length) {
                throw new Error(`bulk install rejected: sheet out of range: ${entry.sheet}`)
              }
            }
            for (const entry of payload) {
              for (const raw of [...cells.keys()]) {
                if (Number(raw.split(':')[0]) === entry.sheet) cells.delete(raw)
              }
              const fromWireAddr = (addr: string) => {
                const [row, col] = addr.split(':').map(Number)
                return toAddress(col, row)
              }
              for (const [addr, value] of entry.primitives) {
                if (typeof value === 'object' && value !== null) {
                  setPrimitive(entry.sheet, fromWireAddr(addr), 'error', value.error)
                } else if (typeof value === 'number') {
                  setPrimitive(entry.sheet, fromWireAddr(addr), 'number', value)
                } else if (typeof value === 'boolean') {
                  setPrimitive(entry.sheet, fromWireAddr(addr), 'boolean', value)
                } else {
                  setPrimitive(entry.sheet, fromWireAddr(addr), 'text', value)
                }
              }
              for (const [addr, source] of entry.formulas) {
                cells.set(key(entry.sheet, fromWireAddr(addr)), {
                  type: 'formula',
                  display: '',
                  formula: source,
                  isError: false,
                })
              }
            }
            return payload.map((entry) => ({
              sheet: entry.sheet,
              primitivesInstalled: entry.primitives.length,
              formulasInstalled: entry.formulas.length,
              crossSheetParsed: 0,
            }))
          },
        }),
    list_non_empty_cells: () =>
      [...cells.entries()].map(([raw]) => {
        const [sheet, addr] = raw.split(':')
        return { sheet: Number(sheet), addr }
      }),
    set_cell_number: (sheet: number, addr: string, value: number) =>
      setPrimitive(sheet, addr, 'number', value),
    set_cell_text: (sheet: number, addr: string, value: string) =>
      setPrimitive(sheet, addr, 'text', value),
    set_cell_boolean: (sheet: number, addr: string, value: boolean) =>
      setPrimitive(sheet, addr, 'boolean', value),
    set_cell_error: (sheet: number, addr: string, value: string) =>
      setPrimitive(sheet, addr, 'error', value),
    clearCellAt: (sheet: number, addr: string) => {
      cells.delete(key(sheet, addr))
    },
    setFormulaAt: (sheet: number, addr: string, formula: string) => {
      const failure = options.formulaFailuresByFormula?.[formula]
      if (failure) {
        cells.set(key(sheet, addr), {
          type: 'error',
          display: failure.display,
          formula: '',
          isError: true,
        })
        return false
      }
      cells.set(key(sheet, addr), {
        type: 'formula',
        display: '',
        formula,
        isError: false,
      })
      return true
    },
    insert_row: (sheet: number, at: number, count: number) => {
      calls.insertRows.push({ sheet, at, count })
    },
    delete_row: (sheet: number, at: number, count: number) => {
      calls.deleteRows.push({ sheet, at, count })
    },
    insert_col: (sheet: number, at: number, count: number) => {
      calls.insertCols.push({ sheet, at, count })
    },
    delete_col: (sheet: number, at: number, count: number) => {
      calls.deleteCols.push({ sheet, at, count })
    },
    snapshot_sparse: () => {
      calls.snapshotSparse += 1
      return [...cells.entries()]
        .map(([raw, state]) => {
          const [sheet, addr] = raw.split(':')
          return sparseFromState(Number(sheet), addr, state)
        })
        .filter((cell) => cell !== null)
    },
    snapshot_range_sparse: (sheet, startRow, startCol, endRow, endCol) => {
      calls.snapshotRangeSparse.push({ sheet, startRow, startCol, endRow, endCol })
      return [...cells.entries()]
        .map(([raw, state]) => {
          const [cellSheet, addr] = raw.split(':')
          if (Number(cellSheet) !== sheet) return null
          const parsed = parseAddress(addr)
          if (
            parsed.row < startRow ||
            parsed.row > endRow ||
            parsed.col < startCol ||
            parsed.col > endCol
          ) {
            return null
          }
          return sparseFromState(sheet, addr, state)
        })
        .filter((cell) => cell !== null)
    },
    restore_sparse: (sparseCells) => {
      const cellsIn = sparseCells as SparseCellWire[]
      calls.restoreSparse.push(cellsIn)
      for (const cell of cellsIn) {
        if (cell.kind === 'formula') {
          cells.set(key(cell.sheet, cell.addr), {
            type: 'formula',
            display: '',
            formula: String(cell.value),
            isError: false,
          })
        } else {
          setPrimitive(cell.sheet, cell.addr, cell.kind, cell.value)
        }
      }
      return cellsIn.length
    },
    ...(restorePersistenceData
      ? {
          snapshot_persistence_v1: () => {
            calls.snapshotPersistenceV1 += 1
            return restorePersistenceData
          },
          restore_persistence_v1: (snapshot: WorkbookPersistenceSnapshotWire) => {
            calls.restorePersistenceV1.push(snapshot)
            return restorePersistenceDefaultReturn
          },
        }
      : {}),
    read_sparse_range: () => [],
    clear_range: () => 0,
    set_format_range: (sheet, startRow, startCol, endRow, endCol, fmt) => {
      calls.setFormatRange.push({ sheet, startRow, startCol, endRow, endCol, fmt })
      return 1
    },
    snapshot_format_range: (sheet, startRow, startCol, endRow, endCol) => {
      calls.snapshotFormatRange.push({ sheet, startRow, startCol, endRow, endCol })
      return {
        sheet,
        startRow,
        startCol,
        endRow,
        endCol,
        cellFormats: [],
        rangeFormats: [],
      }
    },
    restore_format_snapshot: (snapshot) => {
      calls.restoreFormatSnapshot.push(snapshot)
      return 1
    },
    snapshot_viewport_sizes: (sheet, startRow, startCol, endRow, endCol) => {
      calls.snapshotViewportSizes.push({ sheet, startRow, startCol, endRow, endCol })
      return {
        sheet,
        startRow,
        startCol,
        endRow,
        endCol,
        rowHeights: [{ rowIndex: startRow, heightPx: 36 }],
        colWidths: [{ colIndex: startCol, widthPx: 128 }],
      }
    },
    set_row_height: (sheet, rowIndex, heightPx) => {
      calls.setRowHeights.push({ sheet, rowIndex, heightPx })
      return true
    },
    set_col_width: (sheet, colIndex, widthPx) => {
      calls.setColWidths.push({ sheet, colIndex, widthPx })
      return true
    },
    debug_formula_cache_state: () => 'dirty',
    debug_formula_eval_count: () => 0,
    debug_formula_eval_count_total: () => 0,
    debug_formula_count: () => [...cells.values()].filter((cell) => cell.type === 'formula').length,
    debug_live_subscription_count: () => activeSubscriptions.size,
    debug_sheet_live_subscription_count: (sheet: number) =>
      [...activeSubscriptions.values()].filter((sheetIdx) => sheetIdx === sheet).length,
    debug_sheet_formula_count: (sheet: number) =>
      [...cells.entries()].filter(([raw, cell]) => {
        const [cellSheet] = raw.split(':')
        return Number(cellSheet) === sheet && cell.type === 'formula'
      }).length,
    debug_cross_sheet_dependents_count: () => 0,
    subscribe_cell: (sheetName: string, _addr: string) => {
      const token = nextToken++
      activeSubscriptions.set(token, sheets.indexOf(sheetName))
      calls.subscribeTokens.push(token)
      return token
    },
    unsubscribe_cell: (token: number) => {
      activeSubscriptions.delete(token)
      calls.unsubscribeTokens.push(token)
    },
    __mockCalls: calls,
  }

  return { workbook, calls }
}

function requestWorkerResponse<T>(
  responses: MockWorkerResponse[],
  message: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const expectedId = message.id as number
    const start = responses.length

    function findResponse() {
      const hit = responses.slice(start).find((entry) => entry.id === expectedId) as
        | MockWorkerResponse
        | undefined
      if (!hit) return false
      if (!hit.ok) {
        const err = new Error(hit.error.message)
        ;(err as Error & { code?: string }).code = hit.error.code
        reject(err)
        return true
      }
      resolve(hit.result as T)
      return true
    }

    if (findResponse()) return

    const deadline = Date.now() + 3000
    const tick = async () => {
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for worker response id=${expectedId}`))
        return
      }
      if (findResponse()) return
      await new Promise((resolve) => setTimeout(resolve, 0))
      void tick()
    }
    void tick()
    self.dispatchEvent(new MessageEvent('message', { data: message }))
  })
}

function withMockedWorker(options: MockWasmWorkbookOptions = {}) {
  const workbooks: MockWasmWorkbook[] = []
  const responses: MockWorkerResponse[] = []
  const postMessageSpy = jest.spyOn(self, 'postMessage').mockImplementation((message) => {
    responses.push(message as MockWorkerResponse)
  })
  const constructorMock = WasmWorkbook as unknown as jest.Mock
  constructorMock.mockImplementation(() => {
    const { workbook } = createMockWasmWorkbook(options)
    workbook.__mockInstanceId = workbooks.length
    workbooks.push(workbook)
    return workbook
  })

  return {
    calls: {
      mainWorkbook: () => workbooks[0]?.__mockCalls?.bulkImportCells ?? 0,
      mainBulkImportPayloads: () => workbooks[0]?.__mockCalls?.bulkImportPayloads ?? [],
      importWorkbooks: () => workbooks.slice(1).length,
      allBulkImportCalls: () =>
        workbooks.reduce((sum, workbook) => sum + (workbook.__mockCalls?.bulkImportCells ?? 0), 0),
      importBulkImportCalls: () =>
        workbooks
          .slice(1)
          .reduce((sum, workbook) => sum + (workbook.__mockCalls?.bulkImportCells ?? 0), 0),
      importBulkInstallPayloads: () =>
        workbooks.slice(1).flatMap((workbook) => workbook.__mockCalls?.bulkInstallWorkbookPayloads ?? []),
      importBulkImportPayloads: () =>
        workbooks.slice(1).flatMap((workbook) => workbook.__mockCalls?.bulkImportPayloads ?? []),
      mainRestoreSparsePayloads: () => workbooks[0]?.__mockCalls?.restoreSparse ?? [],
      mainSnapshotSparse: () => workbooks[0]?.__mockCalls?.snapshotSparse ?? 0,
      mainSnapshotRangeSparse: () => workbooks[0]?.__mockCalls?.snapshotRangeSparse ?? [],
      importSnapshotSparse: () =>
        workbooks
          .slice(1)
          .reduce((sum, workbook) => sum + (workbook.__mockCalls?.snapshotSparse ?? 0), 0),
      importSnapshotRangeSparse: () =>
        workbooks.flatMap((workbook) =>
          workbook.__mockInstanceId === 0 ? [] : (workbook.__mockCalls?.snapshotRangeSparse ?? []),
        ),
      mainSetFormatRange: () => workbooks[0]?.__mockCalls?.setFormatRange ?? [],
      mainSnapshotFormatRange: () => workbooks[0]?.__mockCalls?.snapshotFormatRange ?? [],
      mainRestoreFormatSnapshot: () => workbooks[0]?.__mockCalls?.restoreFormatSnapshot ?? [],
      mainSnapshotViewportSizes: () => workbooks[0]?.__mockCalls?.snapshotViewportSizes ?? [],
      mainSetRowHeights: () => workbooks[0]?.__mockCalls?.setRowHeights ?? [],
      mainSetColWidths: () => workbooks[0]?.__mockCalls?.setColWidths ?? [],
      mainInsertRows: () => workbooks[0]?.__mockCalls?.insertRows ?? [],
      mainDeleteRows: () => workbooks[0]?.__mockCalls?.deleteRows ?? [],
      mainInsertCols: () => workbooks[0]?.__mockCalls?.insertCols ?? [],
      mainDeleteCols: () => workbooks[0]?.__mockCalls?.deleteCols ?? [],
      mainMoveSheets: () => workbooks[0]?.__mockCalls?.moveSheets ?? [],
      mainSnapshotPersistenceV1: () => workbooks[0]?.__mockCalls?.snapshotPersistenceV1 ?? 0,
      mainRestorePersistenceV1: () => workbooks[0]?.__mockCalls?.restorePersistenceV1 ?? [],
      mainSubscribeTokens: () => workbooks[0]?.__mockCalls?.subscribeTokens ?? [],
      mainUnsubscribeTokens: () => workbooks[0]?.__mockCalls?.unsubscribeTokens ?? [],
    },
    send: <T>(message: Record<string, unknown>) => requestWorkerResponse<T>(responses, message),
    dispose: () => {
      postMessageSpy.mockRestore()
      constructorMock.mockReset()
    },
  }
}

describe('wasm-workbook-worker import normalization', () => {
  it('filters invalid import cells into issues', () => {
    const chunk = normalizeImportCells([
      { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
      { sheet: 0, row: -1, col: 0, kind: 'text', value: 'bad row' },
      { sheet: 0, row: 1, col: 0, kind: 'number', value: Number.NaN },
      { sheet: 0, row: 2, col: 0, kind: 'unknown', value: 'bad kind' } as unknown as ImportCellWire,
      { sheet: 0, row: 3, col: 0, kind: 'null' },
    ])

    expect(chunk.cells).toEqual([
      { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
      { sheet: 0, row: 3, col: 0, kind: 'null' },
    ])
    expect(chunk.issues).toEqual([
      {
        sheet: 0,
        row: -1,
        col: 0,
        kind: 'text',
        code: 'INVALID_IMPORT_CELL_COORDINATES',
        message: 'invalid import cell coordinates',
      },
      {
        sheet: 0,
        row: 1,
        col: 0,
        kind: 'number',
        code: 'INVALID_IMPORT_CELL_VALUE',
        message: 'invalid import cell value',
      },
      {
        sheet: 0,
        row: 2,
        col: 0,
        kind: 'unknown',
        code: 'INVALID_IMPORT_CELL_KIND',
        message: 'invalid import cell kind',
      },
    ])
  })

  it('merges chunk normalization issues into commit import stats', () => {
    expect(
      mergeImportStatsIssues(
        {
          accepted: 1,
          formulas: 0,
          rejectedFormulas: 0,
          cleared: 0,
          errors: 0,
          issues: [{ code: 'RUST_IMPORT_WARNING', message: 'warning from wasm' }],
        },
        [
          {
            sheet: 0,
            row: -1,
            col: 0,
            kind: 'number',
            code: 'INVALID_IMPORT_CELL_COORDINATES',
            message: 'invalid import cell coordinates',
          },
        ],
      ),
    ).toEqual({
      accepted: 1,
      formulas: 0,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 1,
      issues: [
        { code: 'RUST_IMPORT_WARNING', message: 'warning from wasm' },
        {
          sheet: 0,
          row: -1,
          col: 0,
          kind: 'number',
          code: 'INVALID_IMPORT_CELL_COORDINATES',
          message: 'invalid import cell coordinates',
        },
      ],
    })
  })
})

describe('wasm-workbook-worker import session contract', () => {
  it('stages import chunks off main and commits only final writes', async () => {
    const harness = withMockedWorker()
    try {
      const begin = await harness.send<number>({
        id: 1,
        cmd: 'beginImport',
        sessionId: 1,
      })
      expect(begin).toBe(1)

      await harness.send<number>({
        id: 2,
        cmd: 'importChunk',
        sessionId: 1,
        cells: [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, row: 1, col: 1, kind: 'text', value: 'hello' },
        ],
      })
      await harness.send<number>({
        id: 3,
        cmd: 'importChunk',
        sessionId: 1,
        cells: [{ sheet: 0, row: 2, col: 2, kind: 'number', value: 3 }],
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: 4,
        cmd: 'commitImport',
        sessionId: 1,
      })

      expect(commit.accepted).toBe(3)
      expect(commit.formulas).toBe(0)
      expect(harness.calls.mainSnapshotSparse()).toBe(0)
      expect(harness.calls.mainWorkbook()).toBe(1)
      expect(harness.calls.mainBulkImportPayloads()).toEqual([
        [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, row: 1, col: 1, kind: 'text', value: 'hello' },
          { sheet: 0, row: 2, col: 2, kind: 'number', value: 3 },
        ],
      ])
      expect(harness.calls.importSnapshotSparse()).toBe(0)
      expect(harness.calls.importWorkbooks()).toBeGreaterThanOrEqual(1)
      expect(harness.calls.allBulkImportCalls()).toBeGreaterThan(0)
    } finally {
      harness.dispose()
    }
  })

  it('routes atomic staging through one bulk_install_workbook call on the shell at commit', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1', 'Sheet2'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 41,
      })

      await harness.send<number>({
        id: 3,
        cmd: 'importChunk',
        sessionId: 41,
        cells: [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, row: 1, col: 0, kind: 'formula', value: '=A1+1' },
          { sheet: 1, row: 0, col: 0, kind: 'text', value: 'hello' },
        ],
      })
      // No engine work until commit — atomic chunks only stage.
      expect(harness.calls.importBulkImportCalls()).toBe(0)
      expect(harness.calls.importBulkInstallPayloads()).toEqual([])

      await harness.send<number>({
        id: 4,
        cmd: 'importChunk',
        sessionId: 41,
        cells: [
          { sheet: 0, row: 2, col: 0, kind: 'error', value: '#DIV/0!' },
          { sheet: 0, row: 3, col: 0, kind: 'null' },
          // Last write wins for the A1 duplicate.
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 7 },
          // Out-of-range sheets surface as chunk-time issues and are
          // skipped at install, mirroring the legacy engine check.
          { sheet: 5, row: 0, col: 0, kind: 'number', value: 9 },
        ],
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: 5,
        cmd: 'commitImport',
        sessionId: 41,
      })

      // The shell never sees the legacy per-chunk path...
      expect(harness.calls.importBulkImportCalls()).toBe(0)
      // ...just one storage-primary install, grouped per sheet with
      // zero-based "R:C" addrs, formulas split out, nulls skipped.
      expect(harness.calls.importBulkInstallPayloads()).toEqual([
        [
          {
            sheet: 0,
            primitives: [
              ['0:0', 7],
              ['2:0', { error: '#DIV/0!' }],
            ],
            formulas: [['1:0', '=A1+1']],
          },
          {
            sheet: 1,
            primitives: [['0:0', 'hello']],
            formulas: [],
          },
        ],
      ])
      // The live workbook still receives the additive legacy replay of
      // final touches (including the clear).
      expect(harness.calls.mainBulkImportPayloads()).toEqual([
        [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 7 },
          { sheet: 0, row: 1, col: 0, kind: 'formula', value: '=A1+1' },
          { sheet: 1, row: 0, col: 0, kind: 'text', value: 'hello' },
          { sheet: 0, row: 2, col: 0, kind: 'error', value: '#DIV/0!' },
          { sheet: 0, row: 3, col: 0, kind: 'null' },
        ],
      ])
      expect(commit).toEqual({
        accepted: 6,
        formulas: 1,
        rejectedFormulas: 0,
        cleared: 1,
        errors: 1,
        issues: [
          {
            sheet: 5,
            row: 0,
            col: 0,
            kind: 'number',
            code: 'SHEET_OUT_OF_RANGE',
            message: 'cell sheet index is outside the workbook',
          },
        ],
      })
    } finally {
      harness.dispose()
    }
  })

  it('falls back to legacy bulk_import_cells staging when bulk_install_workbook is unavailable', async () => {
    const harness = withMockedWorker({ disableBulkInstallWorkbook: true })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 42,
      })
      await harness.send<number>({
        id: 3,
        cmd: 'importChunk',
        sessionId: 42,
        cells: [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, row: 1, col: 0, kind: 'formula', value: '=A1+1' },
        ],
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: 4,
        cmd: 'commitImport',
        sessionId: 42,
      })

      expect(harness.calls.importBulkInstallPayloads()).toEqual([])
      expect(harness.calls.importBulkImportPayloads()).toEqual([
        [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, row: 1, col: 0, kind: 'formula', value: '=A1+1' },
        ],
      ])
      expect(harness.calls.mainBulkImportPayloads()).toEqual([
        [
          { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, row: 1, col: 0, kind: 'formula', value: '=A1+1' },
        ],
      ])
      expect(commit.accepted).toBe(2)
      expect(commit.formulas).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  it('commits only final touched import cells from staging', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send({
        id: 2,
        cmd: 'setCell',
        sheet: 0,
        addr: 'A1',
        value: { type: 'number', value: 99 },
      })
      await harness.send({
        id: 3,
        cmd: 'beginImport',
        sessionId: 1,
      })
      expect(harness.calls.mainSnapshotSparse()).toBe(0)

      await harness.send({
        id: 4,
        cmd: 'importChunk',
        sessionId: 1,
        cells: [
          { sheet: 0, row: 1, col: 1, kind: 'text', value: 'new' },
          { sheet: 0, row: 2, col: 2, kind: 'formula', value: '=A1+1' },
        ],
      })

      await harness.send({
        id: 5,
        cmd: 'commitImport',
        sessionId: 1,
      })

      expect(harness.calls.importSnapshotSparse()).toBe(0)
      expect(harness.calls.importSnapshotRangeSparse()).toEqual([
        { sheet: 0, startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
        { sheet: 0, startRow: 2, startCol: 2, endRow: 2, endCol: 2 },
      ])
      expect(harness.calls.mainRestoreSparsePayloads()).toEqual([])
      expect(harness.calls.mainBulkImportPayloads()).toEqual([
        [
          { sheet: 0, row: 1, col: 1, kind: 'text', value: 'new' },
          { sheet: 0, row: 2, col: 2, kind: 'formula', value: '=A1+1' },
        ],
      ])

      const cells = await harness.send({
        id: 6,
        cmd: 'readCells',
        cells: [
          { sheet: 0, addr: 'A1' },
          { sheet: 0, addr: 'B2' },
          { sheet: 0, addr: 'C3' },
        ],
      })
      expect(cells).toEqual([
        {
          sheet: 0,
          addr: 'A1',
          display: '99',
          type: 'number',
          isError: false,
          formula: '',
        },
        {
          sheet: 0,
          addr: 'B2',
          display: 'new',
          type: 'text',
          isError: false,
          formula: '',
        },
        {
          sheet: 0,
          addr: 'C3',
          display: '',
          type: 'formula',
          isError: false,
          formula: '=A1+1',
        },
      ])
    } finally {
      harness.dispose()
    }
  })

  it(
    'imports direct chunks over the atomic session limit without staging or final writes',
    async () => {
      const harness = withMockedWorker()
      try {
        await harness.send({
          id: 1,
          cmd: 'initWorkbook',
          sheets: ['Sheet1'],
        })
        await harness.send<number>({
          id: 2,
          cmd: 'beginImport',
          sessionId: 31,
          mode: 'direct',
        })

        const activeCounters = await harness.send<WorkerWorkbookDebugCountersWire>({
          id: 3,
          cmd: 'debugCounters',
        })
        expect(activeCounters.importSessionCount).toBe(1)
        expect(harness.calls.importWorkbooks()).toBe(0)

        const totalCells = MAX_IMPORT_SESSION_NORMALIZED_CELLS + 1
        let nextId = 4
        for (let offset = 0; offset < totalCells; offset += MAX_IMPORT_CHUNK_CELLS) {
          const count = Math.min(MAX_IMPORT_CHUNK_CELLS, totalCells - offset)
          const cells = Array.from({ length: count }, (_value, index): ImportCellWire => {
            const cellIndex = offset + index
            if (cellIndex === totalCells - 1) {
              return {
                sheet: 0,
                row: cellIndex,
                col: 0,
                kind: 'formula',
                value: '=1+1',
              }
            }
            return {
              sheet: 0,
              row: cellIndex,
              col: 0,
              kind: 'number',
              value: cellIndex,
            }
          })
          await expect(
            harness.send<number>({
              id: nextId++,
              cmd: 'importChunk',
              sessionId: 31,
              cells,
            }),
          ).resolves.toBe(offset + count)
        }

        const payloadCountBeforeCommit = harness.calls.mainBulkImportPayloads().length
        const commit = await harness.send<WorkbookImportStatsWire>({
          id: nextId++,
          cmd: 'commitImport',
          sessionId: 31,
        })

        expect(commit.accepted).toBe(totalCells)
        expect(commit.formulas).toBe(1)
        expect(harness.calls.importWorkbooks()).toBe(0)
        expect(harness.calls.importSnapshotRangeSparse()).toEqual([])
        expect(harness.calls.mainBulkImportPayloads()).toHaveLength(payloadCountBeforeCommit)
        expect(
          harness.calls
            .mainBulkImportPayloads()
            .reduce((sum, payload) => sum + payload.length, 0),
        ).toBe(totalCells)

        await expect(
          harness.send<number>({
            id: nextId++,
            cmd: 'debugFormulaEvalCount',
            sheet: 0,
          }),
        ).resolves.toBe(0)
        const counters = await harness.send<WorkerWorkbookDebugCountersWire>({
          id: nextId++,
          cmd: 'debugCounters',
        })
        expect(counters.importSessionCount).toBe(0)
        expect(counters.formulaEvalCountTotal).toBe(0)
      } finally {
        harness.dispose()
      }
    },
    15_000,
  )

  it('reports direct failures as partial and cancel only clears the session', async () => {
    const harness = withMockedWorker({ bulkImportFailureAfterApply: 'mock write failure' })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 32,
        mode: 'direct',
      })

      await expect(
        harness.send<number>({
          id: 3,
          cmd: 'importChunk',
          sessionId: 32,
          cells: [{ sheet: 0, row: 0, col: 0, kind: 'number', value: 42 }],
        }),
      ).rejects.toMatchObject({
        code: 'DIRECT_IMPORT_PARTIAL_FAILURE',
        message: expect.stringContaining('non-atomic'),
      })
      await expect(
        harness.send<WorkerWorkbookDebugCountersWire>({
          id: 4,
          cmd: 'debugCounters',
        }),
      ).resolves.toMatchObject({ importSessionCount: 1 })

      await expect(
        harness.send<boolean>({
          id: 5,
          cmd: 'cancelImport',
          sessionId: 32,
        }),
      ).resolves.toBe(true)
      await expect(
        harness.send<WorkerWorkbookDebugCountersWire>({
          id: 6,
          cmd: 'debugCounters',
        }),
      ).resolves.toMatchObject({ importSessionCount: 0 })

      const cells = await harness.send({
        id: 7,
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'A1' }],
      })
      expect(cells).toEqual([
        {
          sheet: 0,
          addr: 'A1',
          display: '42',
          type: 'number',
          isError: false,
          formula: '',
        },
      ])
    } finally {
      harness.dispose()
    }
  })

  it('rejects oversized chunks before mutating import session state', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 1,
      })

      const oversizedChunk = makeNumberCells(MAX_IMPORT_CHUNK_CELLS + 1)
      await expect(
        harness.send<number>({
          id: 3,
          cmd: 'importChunk',
          sessionId: 1,
          cells: oversizedChunk as unknown as ImportCellWire[],
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_CHUNK_TOO_LARGE',
        message: `import chunk too large: ${oversizedChunk.length}`,
      })

      expect(harness.calls.mainBulkImportPayloads()).toEqual([])
      await expect(
        harness.send<number>({
          id: 4,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [{ sheet: 0, row: 0, col: 0, kind: 'number', value: 1 }],
        }),
      ).resolves.toBe(1)
      expect(harness.calls.importWorkbooks()).toBeGreaterThanOrEqual(1)

      const cancelled = await harness.send<boolean>({
        id: 5,
        cmd: 'cancelImport',
        sessionId: 1,
      })
      expect(cancelled).toBe(true)
      await expect(
        harness.send({
          id: 6,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [{ sheet: 0, row: 0, col: 0, kind: 'number', value: 2 }],
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_SESSION_MISSING',
      })
    } finally {
      harness.dispose()
    }
  })

  it('rejects sessions that exceed normalized count with existing partial state preserved', async () => {
    const harness = withMockedWorker()
    __setImportLimitsForTest({ normalizedCells: 5, finalTouches: 5 })
    try {
      const nearLimit = 4
      const allCells = makeNumberCells(nearLimit)
      const extra = [makeNumberCell(nearLimit + 1)]

      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 1,
      })

      let nextId = 3
      for (let offset = 0; offset < allCells.length; offset += MAX_IMPORT_CHUNK_CELLS) {
        await harness.send<number>({
          id: nextId++,
          cmd: 'importChunk',
          sessionId: 1,
          cells: allCells.slice(offset, offset + MAX_IMPORT_CHUNK_CELLS),
        })
      }

      await harness.send<number>({
        id: nextId++,
        cmd: 'importChunk',
        sessionId: 1,
        cells: extra,
      })
      await expect(
        harness.send<number>({
          id: nextId++,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [makeNumberCell(nearLimit + 1)],
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_SESSION_LIMIT_EXCEEDED',
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: nextId++,
        cmd: 'commitImport',
        sessionId: 1,
      })
      expect(commit.accepted).toBe(5)
      expect(harness.calls.mainBulkImportPayloads()).toHaveLength(1)
      expect(harness.calls.mainBulkImportPayloads()[0]).toHaveLength(5)
      expect(harness.calls.mainBulkImportPayloads()[0][4]).toMatchObject(extra[0])
    } finally {
      __resetImportLimitsForTest()
      harness.dispose()
    }
  })

  it('rejects sessions when final touch limit is exceeded while normalized count stays within bounds', async () => {
    const harness = withMockedWorker()
    __setImportLimitsForTest({
      normalizedCells: 10,
      finalTouches: 2,
      chunkCells: 10_000,
    })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 1,
      })

      await expect(
        harness.send<number>({
          id: 3,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [
            { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
            { sheet: 0, row: 0, col: 1, kind: 'number', value: 2 },
          ],
        }),
      ).resolves.toBe(2)

      await expect(
        harness.send<number>({
          id: 4,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [{ sheet: 0, row: 1, col: 0, kind: 'number', value: 3 }],
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_SESSION_LIMIT_EXCEEDED',
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: 5,
        cmd: 'commitImport',
        sessionId: 1,
      })
      expect(commit.accepted).toBe(2)
      expect(harness.calls.mainBulkImportPayloads()[0]).toHaveLength(2)
    } finally {
      __resetImportLimitsForTest()
      harness.dispose()
    }
  })

  it('rejects sessions that exceed final touch limits without applying the overflow chunk', async () => {
    const harness = withMockedWorker()
    __setImportLimitsForTest({ normalizedCells: 10, finalTouches: 2 })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 1,
      })
      await expect(
        harness.send<number>({
          id: 3,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [makeNumberCell(0), makeNumberCell(1)],
        }),
      ).resolves.toBe(2)
      await expect(
        harness.send<number>({
          id: 4,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [makeNumberCell(2)],
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_SESSION_LIMIT_EXCEEDED',
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: 5,
        cmd: 'commitImport',
        sessionId: 1,
      })
      expect(commit.accepted).toBe(2)
      expect(harness.calls.mainBulkImportPayloads()[0]).toHaveLength(2)
    } finally {
      __resetImportLimitsForTest()
      harness.dispose()
    }
  })

  it('rejects sessions that exceed issue limits without partial import writes', async () => {
    const harness = withMockedWorker()
    __setImportLimitsForTest({ issues: 3 })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<number>({
        id: 2,
        cmd: 'beginImport',
        sessionId: 1,
      })

      const firstIssues = [makeInvalidIssueCell(0), makeInvalidIssueCell(1)]
      const secondIssues = [makeInvalidIssueCell(2)]
      const overflowIssue = makeInvalidIssueCell(3)

      await harness.send<number>({
        id: 3,
        cmd: 'importChunk',
        sessionId: 1,
        cells: firstIssues as ImportCellWire[],
      })
      await harness.send<number>({
        id: 4,
        cmd: 'importChunk',
        sessionId: 1,
        cells: secondIssues as ImportCellWire[],
      })
      await expect(
        harness.send<number>({
          id: 5,
          cmd: 'importChunk',
          sessionId: 1,
          cells: [overflowIssue],
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_ISSUES_LIMIT_EXCEEDED',
      })

      const commit = await harness.send<WorkbookImportStatsWire>({
        id: 6,
        cmd: 'commitImport',
        sessionId: 1,
      })
      expect(commit.accepted).toBe(0)
      expect(commit.issues).toHaveLength(3)
      expect(harness.calls.mainBulkImportPayloads()).toEqual([])
    } finally {
      __resetImportLimitsForTest()
      harness.dispose()
    }
  })

  it('exports range TSV from sparse snapshots without reading formulas', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1', 'Sheet2'],
      })
      await harness.send({
        id: 2,
        cmd: 'setCell',
        sheet: 1,
        addr: 'A1',
        value: { type: 'number', value: 10 },
      })
      await harness.send({
        id: 3,
        cmd: 'setFormula',
        sheet: 0,
        addr: 'A1',
        formula: '=Sheet2!A1+1',
      })

      const tsv = await harness.send<string>({
        id: 4,
        cmd: 'exportRangeTsv',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      })

      expect(tsv).toBe('=Sheet2!A1+1')
    } finally {
      harness.dispose()
    }
  })

  it('streams range TSV exports in row chunks and only snapshots current chunk', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send({
        id: 2,
        cmd: 'setCell',
        sheet: 0,
        addr: 'A1',
        value: { type: 'number', value: 1 },
      })
      await harness.send({
        id: 3,
        cmd: 'setFormula',
        sheet: 0,
        addr: 'A2',
        formula: '=A1+1',
      })
      await harness.send({
        id: 4,
        cmd: 'setCell',
        sheet: 0,
        addr: 'A3',
        value: { type: 'text', value: '3' },
      })

      const begin = await harness.send<{
        sessionId: number
        totalRows: number
        rowsPerChunk: number
      }>({
        id: 5,
        cmd: 'beginExportRangeTsv',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
        rowsPerChunk: 2,
      })
      expect(begin).toEqual({
        sessionId: 1,
        totalRows: 3,
        rowsPerChunk: 2,
      })

      const chunk1 = await harness.send<{
        sessionId: number
        startRow: number
        endRow: number
        chunk: string
        done: boolean
      }>({
        id: 6,
        cmd: 'nextExportRangeTsvChunk',
        sessionId: begin.sessionId,
      })
      expect(chunk1).toEqual({
        sessionId: 1,
        startRow: 0,
        endRow: 1,
        chunk: '1\n=A1+1',
        done: false,
      })

      const chunk2 = await harness.send<{
        sessionId: number
        startRow: number
        endRow: number
        chunk: string
        done: boolean
      }>({
        id: 7,
        cmd: 'nextExportRangeTsvChunk',
        sessionId: begin.sessionId,
      })
      expect(chunk2).toEqual({
        sessionId: 1,
        startRow: 2,
        endRow: 2,
        chunk: '3',
        done: true,
      })

      expect(harness.calls.mainSnapshotRangeSparse()).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        { sheet: 0, startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
      ])
    } finally {
      harness.dispose()
    }
  })

  it('streams sparse range snapshots in row chunks and only snapshots current chunk', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send({
        id: 2,
        cmd: 'setCell',
        sheet: 0,
        addr: 'A1',
        value: { type: 'number', value: 1 },
      })
      await harness.send({
        id: 3,
        cmd: 'setFormula',
        sheet: 0,
        addr: 'A2',
        formula: '=A1+1',
      })
      await harness.send({
        id: 4,
        cmd: 'setCell',
        sheet: 0,
        addr: 'A3',
        value: { type: 'text', value: '3' },
      })

      const begin = await harness.send<{
        sessionId: number
        totalRows: number
        rowsPerChunk: number
      }>({
        id: 5,
        cmd: 'beginSnapshotRangeSparse',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
        rowsPerChunk: 2,
      })
      expect(begin).toEqual({
        sessionId: 1,
        totalRows: 3,
        rowsPerChunk: 2,
      })

      const chunk1 = await harness.send<{
        sessionId: number
        startRow: number
        endRow: number
        cells: SparseCellWire[]
        done: boolean
      }>({
        id: 6,
        cmd: 'nextSnapshotRangeSparseChunk',
        sessionId: begin.sessionId,
      })
      expect(chunk1).toEqual({
        sessionId: 1,
        startRow: 0,
        endRow: 1,
        cells: [
          { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'number', value: 1 },
          { sheet: 0, addr: 'A2', row: 1, col: 0, kind: 'formula', value: '=A1+1' },
        ],
        done: false,
      })

      const chunk2 = await harness.send<{
        sessionId: number
        startRow: number
        endRow: number
        cells: SparseCellWire[]
        done: boolean
      }>({
        id: 7,
        cmd: 'nextSnapshotRangeSparseChunk',
        sessionId: begin.sessionId,
      })
      expect(chunk2).toEqual({
        sessionId: 1,
        startRow: 2,
        endRow: 2,
        cells: [{ sheet: 0, addr: 'A3', row: 2, col: 0, kind: 'text', value: '3' }],
        done: true,
      })

      expect(harness.calls.mainSnapshotRangeSparse()).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        { sheet: 0, startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
      ])
    } finally {
      harness.dispose()
    }
  })

  it('cancels export sessions and rejects chunk reads afterward', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })

      const begin = await harness.send<{
        sessionId: number
        totalRows: number
        rowsPerChunk: number
      }>({
        id: 2,
        cmd: 'beginExportRangeTsv',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        rowsPerChunk: 0,
      })
      expect(begin.rowsPerChunk).toBe(1)

      const cancelled = await harness.send<boolean>({
        id: 3,
        cmd: 'cancelExport',
        sessionId: begin.sessionId,
      })
      expect(cancelled).toBe(true)

      await expect(
        harness.send({
          id: 4,
          cmd: 'nextExportRangeTsvChunk',
          sessionId: begin.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'EXPORT_SESSION_MISSING',
        message: `missing export session: ${begin.sessionId}`,
      })
    } finally {
      harness.dispose()
    }
  })

  it('cancels sparse snapshot sessions and rejects chunk reads afterward', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })

      const begin = await harness.send<{
        sessionId: number
        totalRows: number
        rowsPerChunk: number
      }>({
        id: 2,
        cmd: 'beginSnapshotRangeSparse',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        rowsPerChunk: 0,
      })
      expect(begin.rowsPerChunk).toBe(1)

      const cancelled = await harness.send<boolean>({
        id: 3,
        cmd: 'cancelSnapshot',
        sessionId: begin.sessionId,
      })
      expect(cancelled).toBe(true)

      await expect(
        harness.send({
          id: 4,
          cmd: 'nextSnapshotRangeSparseChunk',
          sessionId: begin.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'SNAPSHOT_SESSION_MISSING',
        message: `missing snapshot session: ${begin.sessionId}`,
      })
    } finally {
      harness.dispose()
    }
  })

  it('returns authoritative detailed formula failures and invalid-sheet errors', async () => {
    const harness = withMockedWorker({
      formulaFailuresByFormula: {
        '=garbage((': { display: '#VALUE!' },
        '=A1+1': { display: '#CYCLE!' },
      },
    })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })

      const parseFail = await harness.send<FormulaMutationResultWire>({
        id: 2,
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'A1',
        formula: '=garbage((',
      })
      expect(parseFail).toEqual({
        ok: false,
        code: 'INVALID_FORMULA',
        message: 'formula could not be parsed or installed',
        display: '#VALUE!',
      })

      const cycle = await harness.send<FormulaMutationResultWire>({
        id: 3,
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'A1',
        formula: '=A1+1',
      })
      expect(cycle).toEqual({
        ok: false,
        code: 'FORMULA_CYCLE',
        message: 'formula would create a cycle',
        display: '#CYCLE!',
      })

      await expect(
        harness.send({
          id: 4,
          cmd: 'setFormulaDetailed',
          sheet: 9,
          addr: 'A1',
          formula: '=1',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SHEET',
        message: 'invalid sheet index: 9',
      })
    } finally {
      harness.dispose()
    }
  })

  it('routes setFormatRange to the wasm workbook range-format API', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })

      const count = await harness.send<number>({
        id: 2,
        cmd: 'setFormatRange',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
        fmt: { bold: true },
      })

      expect(count).toBe(1)
      expect(harness.calls.mainSetFormatRange()).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999, fmt: { bold: true } },
      ])
    } finally {
      harness.dispose()
    }
  })

  it('routes structural row and column edits to the wasm workbook API', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1', 'Sheet2'],
      })

      await expect(
        harness.send({
          id: 2,
          cmd: 'insertRows',
          sheet: 1,
          rowIndex: 2,
          count: 3,
        }),
      ).resolves.toBe(true)
      await expect(
        harness.send({
          id: 3,
          cmd: 'deleteRows',
          sheet: 1,
          rowIndex: 4,
          count: 1,
        }),
      ).resolves.toBe(true)
      await expect(
        harness.send({
          id: 4,
          cmd: 'insertColumns',
          sheet: 0,
          colIndex: 5,
          count: 2,
        }),
      ).resolves.toBe(true)
      await expect(
        harness.send({
          id: 5,
          cmd: 'deleteColumns',
          sheet: 0,
          colIndex: 6,
          count: 1,
        }),
      ).resolves.toBe(true)

      expect(harness.calls.mainInsertRows()).toEqual([{ sheet: 1, at: 2, count: 3 }])
      expect(harness.calls.mainDeleteRows()).toEqual([{ sheet: 1, at: 4, count: 1 }])
      expect(harness.calls.mainInsertCols()).toEqual([{ sheet: 0, at: 5, count: 2 }])
      expect(harness.calls.mainDeleteCols()).toEqual([{ sheet: 0, at: 6, count: 1 }])

      await expect(
        harness.send({
          id: 6,
          cmd: 'insertRows',
          sheet: 0,
          rowIndex: 1,
          count: 0,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_STRUCTURAL_EDIT',
      })
    } finally {
      harness.dispose()
    }
  })

  it('routes sheet moves to the wasm workbook API', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1', 'Sheet2', 'Sheet3'],
      })

      await expect(
        harness.send({
          id: 2,
          cmd: 'moveSheet',
          from: 2,
          to: 0,
        }),
      ).resolves.toBe(true)
      expect(harness.calls.mainMoveSheets()).toEqual([{ from: 2, to: 0 }])

      await expect(
        harness.send({
          id: 3,
          cmd: 'sheetList',
        }),
      ).resolves.toEqual([
        { idx: 0, name: 'Sheet3' },
        { idx: 1, name: 'Sheet1' },
        { idx: 2, name: 'Sheet2' },
      ])

      await expect(
        harness.send({
          id: 4,
          cmd: 'moveSheet',
          from: 9,
          to: 0,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SHEET',
      })
    } finally {
      harness.dispose()
    }
  })

  it('routes format range snapshot/restore through the wasm workbook API', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })

      const snapshot = await harness.send<FormatRangeSnapshot>({
        id: 2,
        cmd: 'snapshotFormatRange',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      })

      expect(snapshot).toEqual({
        sheet: 0,
        startRow: 0,
        startCol: 0,
        endRow: 999,
        endCol: 999,
        cellFormats: [],
        rangeFormats: [],
      })
      expect(harness.calls.mainSnapshotFormatRange()).toEqual([
        { sheet: 0, startRow: 0, startCol: 0, endRow: 999, endCol: 999 },
      ])

      const restored = await harness.send<number>({
        id: 3,
        cmd: 'restoreFormatSnapshot',
        snapshot,
      })
      expect(restored).toBe(1)
      expect(harness.calls.mainRestoreFormatSnapshot()).toEqual([snapshot])
    } finally {
      harness.dispose()
    }
  })

  it('routes viewport size snapshot and mutations through the wasm workbook API', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })

      const snapshot = await harness.send<ViewportSizeSnapshotWire>({
        id: 2,
        cmd: 'snapshotViewportSizes',
        range: { sheet: 0, startRow: 2, startCol: 3, endRow: 8, endCol: 9 },
      })

      expect(snapshot).toEqual({
        sheet: 0,
        startRow: 2,
        startCol: 3,
        endRow: 8,
        endCol: 9,
        rowHeights: [{ rowIndex: 2, heightPx: 36 }],
        colWidths: [{ colIndex: 3, widthPx: 128 }],
      })
      expect(harness.calls.mainSnapshotViewportSizes()).toEqual([
        { sheet: 0, startRow: 2, startCol: 3, endRow: 8, endCol: 9 },
      ])

      await expect(
        harness.send({
          id: 3,
          cmd: 'setRowHeight',
          sheet: 0,
          rowIndex: 2,
          heightPx: 37.6,
        }),
      ).resolves.toBe(true)
      await expect(
        harness.send({
          id: 4,
          cmd: 'setColumnWidth',
          sheet: 0,
          colIndex: 3,
          widthPx: 127.5,
        }),
      ).resolves.toBe(true)

      expect(harness.calls.mainSetRowHeights()).toEqual([
        { sheet: 0, rowIndex: 2, heightPx: 38 },
      ])
      expect(harness.calls.mainSetColWidths()).toEqual([
        { sheet: 0, colIndex: 3, widthPx: 128 },
      ])

      await expect(
        harness.send({
          id: 5,
          cmd: 'setRowHeight',
          sheet: 0,
          rowIndex: 2,
          heightPx: 0,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_DIMENSION_SIZE',
      })
    } finally {
      harness.dispose()
    }
  })

  it('routes persistence v1 snapshot and restore through the wasm API', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      const snapshot = await harness.send<WorkbookPersistenceSnapshotWire>({
        id: 2,
        cmd: 'snapshotPersistenceV1',
      })
      expect(snapshot).toEqual({
        version: 1,
        sheets: [{ idx: 0, name: 'Sheet1' }],
        cells: [],
        formats: [],
        sizes: [],
      })
      expect(harness.calls.mainSnapshotPersistenceV1()).toBe(1)

      const restorePayload: WorkbookPersistenceSnapshotWire = {
        version: 1,
        sheets: [{ idx: 0, name: 'Sheet1' }],
        cells: [{ sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=1+1' }],
        formats: [],
        sizes: [],
      }
      const restore = await harness.send<WorkbookPersistenceRestoreStatsWire>({
        id: 3,
        cmd: 'restorePersistenceV1',
        snapshot: restorePayload,
      })
      expect(restore).toEqual({ restored_cells: 0, restored_formats: 0, sheets: 1 })
      expect(harness.calls.mainRestorePersistenceV1()).toEqual([restorePayload])
    } finally {
      harness.dispose()
    }
  })

  it('clears existing subscription tokens before restoring persistence v1', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send<boolean>({
        id: 2,
        cmd: 'subscribeCells',
        subId: 1,
        cells: [{ sheet: 0, addr: 'A1' }],
      })
      await harness.send({
        id: 3,
        cmd: 'restorePersistenceV1',
        snapshot: {
          version: 1,
          sheets: [{ idx: 0, name: 'Sheet1' }],
          cells: [{ sheet: 0, addr: 'B2', row: 1, col: 1, kind: 'formula', value: '=1+1' }],
          formats: [],
        },
      })

      expect(harness.calls.mainSubscribeTokens()).toEqual([1])
      expect(harness.calls.mainUnsubscribeTokens()).toEqual([1])

      await harness.send<boolean>({
        id: 4,
        cmd: 'unsubscribeCells',
        subId: 1,
      })
      expect(harness.calls.mainUnsubscribeTokens()).toEqual([1])
    } finally {
      harness.dispose()
    }
  })

  it('clears active import, export, and snapshot sessions after restoring persistence v1', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await harness.send({
        id: 2,
        cmd: 'beginImport',
        sessionId: 7,
      })
      await harness.send({
        id: 3,
        cmd: 'importChunk',
        sessionId: 7,
        cells: [{ sheet: 0, row: 0, col: 0, kind: 'number', value: 1 }],
      })
      const exportSession = await harness.send<{
        sessionId: number
        totalRows: number
        rowsPerChunk: number
      }>({
        id: 4,
        cmd: 'beginExportRangeTsv',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      })
      const snapshotSession = await harness.send<{
        sessionId: number
        totalRows: number
        rowsPerChunk: number
      }>({
        id: 5,
        cmd: 'beginSnapshotRangeSparse',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      })

      await harness.send({
        id: 6,
        cmd: 'restorePersistenceV1',
        snapshot: {
          version: 1,
          sheets: [{ idx: 0, name: 'Sheet1' }],
          cells: [],
          formats: [],
        },
      })

      await expect(
        harness.send({
          id: 7,
          cmd: 'commitImport',
          sessionId: 7,
        }),
      ).rejects.toMatchObject({
        code: 'IMPORT_SESSION_MISSING',
      })
      await expect(
        harness.send({
          id: 8,
          cmd: 'nextExportRangeTsvChunk',
          sessionId: exportSession.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'EXPORT_SESSION_MISSING',
      })
      await expect(
        harness.send({
          id: 9,
          cmd: 'nextSnapshotRangeSparseChunk',
          sessionId: snapshotSession.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'SNAPSHOT_SESSION_MISSING',
      })
    } finally {
      harness.dispose()
    }
  })

  it('reports workbook debug counters without reading formula cells', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1', 'Sheet2'],
      })
      await harness.send({
        id: 2,
        cmd: 'setFormula',
        sheet: 0,
        addr: 'A1',
        formula: '=1+1',
      })
      await harness.send({
        id: 3,
        cmd: 'setFormula',
        sheet: 1,
        addr: 'B2',
        formula: '=10+1',
      })
      await harness.send<boolean>({
        id: 4,
        cmd: 'subscribeCells',
        subId: 1,
        cells: [{ sheet: 0, addr: 'A1' }],
      })
      await harness.send<number>({
        id: 5,
        cmd: 'beginImport',
        sessionId: 9,
      })
      await harness.send({
        id: 6,
        cmd: 'beginExportRangeTsv',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      })
      await harness.send({
        id: 7,
        cmd: 'beginSnapshotRangeSparse',
        range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      })

      const counters = await harness.send<WorkerWorkbookDebugCountersWire>({
        id: 8,
        cmd: 'debugCounters',
      })

      expect(counters).toEqual({
        sheetCount: 2,
        crossSheetDependents: 0,
        formulaCount: 2,
        formulaEvalCountTotal: 0,
        liveSubscriptionCount: 1,
        workerSubscriptionCount: 1,
        importSessionCount: 1,
        exportSessionCount: 1,
        snapshotSessionCount: 1,
        sheets: [
          {
            idx: 0,
            name: 'Sheet1',
            formulaCount: 1,
            formulaEvalCount: 0,
            liveSubscriptionCount: 1,
          },
          {
            idx: 1,
            name: 'Sheet2',
            formulaCount: 1,
            formulaEvalCount: 0,
            liveSubscriptionCount: 0,
          },
        ],
      })
    } finally {
      harness.dispose()
    }
  })

  it('predictably errors when persistence v1 APIs are unavailable in wasm', async () => {
    const harness = withMockedWorker({ disablePersistenceV1: true })
    try {
      await harness.send({
        id: 1,
        cmd: 'initWorkbook',
        sheets: ['Sheet1'],
      })
      await expect(harness.send({ id: 2, cmd: 'snapshotPersistenceV1' })).rejects.toMatchObject({
        code: 'WASM_METHOD_UNAVAILABLE',
        message: 'WasmWorkbook.snapshot_persistence_v1 is not available',
      })

      await expect(
        harness.send({
          id: 3,
          cmd: 'restorePersistenceV1',
          snapshot: { version: 1, sheets: [{ idx: 0, name: 'Sheet1' }], cells: [], formats: [] },
        }),
      ).rejects.toMatchObject({
        code: 'WASM_METHOD_UNAVAILABLE',
        message: 'WasmWorkbook.restore_persistence_v1 is not available',
      })
    } finally {
      harness.dispose()
    }
  })
})

describe('audit D-6 · P-D · FIXED — WASM runtime sheet ops drop index-keyed sessions and subscriptions', () => {
  async function beginAllSessions(harness: ReturnType<typeof withMockedWorker>) {
    await harness.send({ id: 10, cmd: 'beginImport', sessionId: 41 })
    const exportSession = await harness.send<{ sessionId: number }>({
      id: 11,
      cmd: 'beginExportRangeTsv',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    })
    const snapshotSession = await harness.send<{ sessionId: number }>({
      id: 12,
      cmd: 'beginSnapshotRangeSparse',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    })
    await harness.send({ id: 13, cmd: 'subscribeCells', subId: 5, cells: [{ sheet: 0, addr: 'A1' }] })
    return { exportSession, snapshotSession }
  }

  async function expectSessionsGone(
    harness: ReturnType<typeof withMockedWorker>,
    sessions: { exportSession: { sessionId: number }; snapshotSession: { sessionId: number } },
  ) {
    await expect(harness.send({ id: 20, cmd: 'commitImport', sessionId: 41 })).rejects.toMatchObject(
      { code: 'IMPORT_SESSION_MISSING' },
    )
    await expect(
      harness.send({
        id: 21,
        cmd: 'nextExportRangeTsvChunk',
        sessionId: sessions.exportSession.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_SESSION_MISSING' })
    await expect(
      harness.send({
        id: 22,
        cmd: 'nextSnapshotRangeSparseChunk',
        sessionId: sessions.snapshotSession.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_SESSION_MISSING' })
  }

  it('removeSheet invalidates in-flight sessions and engine subscriptions', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({ id: 1, cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2', 'Sheet3'] })
      const sessions = await beginAllSessions(harness)
      expect(harness.calls.mainSubscribeTokens().length).toBe(1)

      await harness.send({ id: 14, cmd: 'removeSheet', sheet: 1 })

      // Sessions captured sheet INDICES; indices shifted, so later
      // chunks would have read/written the wrong sheet. They must
      // fail loudly instead.
      await expectSessionsGone(harness, sessions)
      // Engine-side subscriptions are dropped too — their dirty
      // callbacks captured the pre-removal index.
      expect(harness.calls.mainUnsubscribeTokens()).toEqual(harness.calls.mainSubscribeTokens())
    } finally {
      harness.dispose()
    }
  })

  it('moveSheet invalidates in-flight sessions and engine subscriptions', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({ id: 1, cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2', 'Sheet3'] })
      const sessions = await beginAllSessions(harness)

      await harness.send({ id: 14, cmd: 'moveSheet', from: 0, to: 2 })

      await expectSessionsGone(harness, sessions)
      expect(harness.calls.mainUnsubscribeTokens()).toEqual(harness.calls.mainSubscribeTokens())
    } finally {
      harness.dispose()
    }
  })

  it('addSheet and renameSheet keep existing indices stable and do NOT invalidate', async () => {
    const harness = withMockedWorker()
    try {
      await harness.send({ id: 1, cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2'] })
      await harness.send({ id: 10, cmd: 'beginImport', sessionId: 42 })

      await harness.send({ id: 14, cmd: 'addSheet', name: 'Sheet3' })
      await harness.send({ id: 15, cmd: 'renameSheet', sheet: 0, name: 'Renamed' })

      // addSheet appends and renameSheet changes names only — the
      // staged session's indices are still valid, so it survives.
      await expect(
        harness.send({ id: 16, cmd: 'commitImport', sessionId: 42 }),
      ).resolves.toBeDefined()
    } finally {
      harness.dispose()
    }
  })
})
