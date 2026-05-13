import { describe, expect, it, jest } from '@jest/globals'
import { mergeImportStatsIssues, normalizeImportCells } from '../src/wasm-workbook-worker'
import type { ImportCellWire, WorkbookImportStatsWire } from '../src/wasm-workbook-proxy'
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

type MockWasmWorkbook = {
  sheet_count: () => number
  sheet_name: (idx: number) => string
  add_sheet: (name: string) => number
  rename_sheet: (idx: number, name: string) => boolean
  remove_sheet: (idx: number) => boolean
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
  list_non_empty_cells: () => { sheet: number; addr: string }[]
  set_cell_number: (...args: unknown[]) => void
  set_cell_text: (...args: unknown[]) => void
  set_cell_boolean: (...args: unknown[]) => void
  set_cell_error: (...args: unknown[]) => void
  clearCellAt: (...args: unknown[]) => void
  setFormulaAt: (...args: unknown[]) => boolean
  snapshot_sparse: () => unknown[]
  snapshot_range_sparse: () => unknown[]
  restore_sparse: (cells: unknown[]) => number
  read_sparse_range: () => unknown[]
  clear_range: () => number
  debug_formula_cache_state: () => string
  debug_formula_eval_count: () => number
  subscribe_cell: () => number
  unsubscribe_cell: () => void
  __mockInstanceId?: number
  __mockCalls?: {
    bulkImportCells: number
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

function createMockWasmWorkbook() {
  const calls = { bulkImportCells: 0 }
  const sheets = ['Sheet1']
  const cells = new Map<string, MockCellState>()

  function key(sheet: number, addr: string) {
    return `${sheet}:${addr.toUpperCase()}`
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
      setFromImport(cellsIn)
      return {
        accepted: cellsIn.length,
        formulas: cellsIn.filter((cell) => cell.kind === 'formula').length,
        rejectedFormulas: 0,
        cleared: cellsIn.filter((cell) => cell.kind === 'null').length,
        errors: 0,
      }
    },
    list_non_empty_cells: () =>
      [...cells.entries()].map(([raw]) => {
        const [sheet, addr] = raw.split(':')
        return { sheet: Number(sheet), addr }
      }),
    set_cell_number: () => undefined,
    set_cell_text: () => undefined,
    set_cell_boolean: () => undefined,
    set_cell_error: () => undefined,
    clearCellAt: () => undefined,
    setFormulaAt: () => true,
    snapshot_sparse: () => [],
    snapshot_range_sparse: () => [],
    restore_sparse: () => 0,
    read_sparse_range: () => [],
    clear_range: () => 0,
    debug_formula_cache_state: () => 'dirty',
    debug_formula_eval_count: () => 0,
    subscribe_cell: () => 1,
    unsubscribe_cell: () => undefined,
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

function withMockedWorker() {
  const workbooks: MockWasmWorkbook[] = []
  const responses: MockWorkerResponse[] = []
  const postMessageSpy = jest.spyOn(self, 'postMessage').mockImplementation((message) => {
    responses.push(message as MockWorkerResponse)
  })
  const constructorMock = WasmWorkbook as unknown as jest.Mock
  constructorMock.mockImplementation(() => {
    const { workbook } = createMockWasmWorkbook()
    workbook.__mockInstanceId = workbooks.length
    workbooks.push(workbook)
    return workbook
  })

  return {
    calls: {
      mainWorkbook: () => workbooks[0]?.__mockCalls?.bulkImportCells ?? 0,
      importWorkbooks: () => workbooks.slice(1).length,
      allBulkImportCalls: () =>
        workbooks.reduce((sum, workbook) => sum + (workbook.__mockCalls?.bulkImportCells ?? 0), 0),
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
  it('should not commit import chunks as one giant bulk_import_cells payload', async () => {
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
      expect(harness.calls.mainWorkbook()).toBe(0)
      expect(harness.calls.importWorkbooks()).toBeGreaterThanOrEqual(1)
      expect(harness.calls.allBulkImportCalls()).toBeGreaterThan(0)
    } finally {
      harness.dispose()
    }
  })
})
