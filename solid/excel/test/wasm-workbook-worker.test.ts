import { describe, expect, it, jest } from '@jest/globals'
import { mergeImportStatsIssues, normalizeImportCells } from '../src/wasm-workbook-worker'
import type {
  ImportCellWire,
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
  set_cell_number: (sheet: number, addr: string, value: number) => void
  set_cell_text: (sheet: number, addr: string, value: string) => void
  set_cell_boolean: (sheet: number, addr: string, value: boolean) => void
  set_cell_error: (sheet: number, addr: string, value: string) => void
  clearCellAt: (sheet: number, addr: string) => void
  setFormulaAt: (sheet: number, addr: string, formula: string) => boolean
  snapshot_sparse: () => unknown[]
  snapshot_range_sparse: (
    sheet: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => unknown[]
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
    snapshotSparse: number
    snapshotRangeSparse: SparseRangeWire[]
    restoreSparse: SparseCellWire[][]
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

function createMockWasmWorkbook() {
  const calls: NonNullable<MockWasmWorkbook['__mockCalls']> = {
    bulkImportCells: 0,
    snapshotSparse: 0,
    snapshotRangeSparse: [],
    restoreSparse: [],
  }
  const sheets = ['Sheet1']
  const cells = new Map<string, MockCellState>()

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
      return { sheet, addr, row: parsed.row, col: parsed.col, kind: 'formula', value: state.formula }
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
      cells.set(key(sheet, addr), {
        type: 'formula',
        display: '',
        formula,
        isError: false,
      })
      return true
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
      mainRestoreSparsePayloads: () => workbooks[0]?.__mockCalls?.restoreSparse ?? [],
      mainSnapshotSparse: () => workbooks[0]?.__mockCalls?.snapshotSparse ?? 0,
      importSnapshotSparse: () =>
        workbooks
          .slice(1)
          .reduce((sum, workbook) => sum + (workbook.__mockCalls?.snapshotSparse ?? 0), 0),
      importSnapshotRangeSparse: () =>
        workbooks.flatMap((workbook) =>
          workbook.__mockInstanceId === 0 ? [] : (workbook.__mockCalls?.snapshotRangeSparse ?? []),
        ),
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
      expect(harness.calls.importSnapshotSparse()).toBe(0)
      expect(harness.calls.importWorkbooks()).toBeGreaterThanOrEqual(1)
      expect(harness.calls.allBulkImportCalls()).toBeGreaterThan(0)
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
      expect(harness.calls.mainSnapshotSparse()).toBe(1)

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
      expect(harness.calls.mainRestoreSparsePayloads()).toEqual([
        [
          { sheet: 0, addr: 'B2', row: 1, col: 1, kind: 'text', value: 'new' },
          { sheet: 0, addr: 'C3', row: 2, col: 2, kind: 'formula', value: '=A1+1' },
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
})
