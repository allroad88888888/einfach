import { test, expect, type Page } from '@playwright/test'
import { expectNoConsoleErrors, guardConsoleErrors } from './helpers'

type Snapshot = {
  sheet: number
  addr: string
  display: string
  type: string
  isError: boolean
  formula: string
}

type FormulaFailureScenario = {
  baseline: Snapshot
  optimistic: Snapshot
  accepted: boolean
  hydrated: Snapshot
}

type DirtyRef = {
  sheet: number
  addr: string
}

type SparseCell = {
  sheet: number
  addr: string
  row: number
  col: number
  kind: string
  value: string | number | boolean
}

type ImportIssue = {
  sheet?: number
  row?: number
  col?: number
  kind?: string
  code: string
  message: string
}

test.describe('Worker-backed workbook RPC', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
    await page.goto('/')
  })

  test('evaluates and invalidates a 3-sheet dependency chain in the real worker', async ({
    page,
  }) => {
    const result = await runWorkerWorkbookScenario(page)

    expect(result.sheetNames).toEqual(['Sheet1', 'Sheet2', 'Sheet3'])
    expect(result.formulaAccepted).toEqual([true, true, true])
    expect(result.initial.map((cell) => cell.display)).toEqual(['13', '12', '11'])

    expect(result.dirtyEvents.flat()).toContainEqual({ sheet: 0, addr: 'C2' })
    expect(result.after.map((cell) => cell.display)).toEqual(['23', '22', '21'])

    await expectNoConsoleErrors(page)
  })

  test('returns authoritative false for a formula cycle', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
      const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')
      const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
      try {
        await workbook.initWorkbook(['Sheet1'])
        const accepted = await workbook.setFormula(0, 'A1', '=A1+1')
        const detail = await workbook.setFormulaDetailed(0, 'B1', '=B1+1')
        return { accepted, detail }
      } finally {
        workbook.dispose()
      }
    })

    expect(result.accepted).toBe(false)
    expect(result.detail).toEqual({
      ok: false,
      code: 'FORMULA_CYCLE',
      message: 'formula would create a cycle',
      display: '#CYCLE!',
    })
    await expectNoConsoleErrors(page)
  })

  test('returns authoritative false for malformed formula syntax', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
      const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')
      const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
      try {
        await workbook.initWorkbook(['Sheet1'])
        const accepted = await workbook.setFormula(0, 'A1', '=garbage((')
        const detail = await workbook.setFormulaDetailed(0, 'B1', '=garbage((')
        const [cell] = await workbook.readCells([{ sheet: 0, addr: 'A1' }])
        return { accepted, detail, cell }
      } finally {
        workbook.dispose()
      }
    })

    expect(result.accepted).toBe(false)
    expect(result.detail).toEqual({
      ok: false,
      code: 'INVALID_FORMULA',
      message: 'formula could not be parsed or installed',
      display: '#VALUE!',
    })
    expect(result.cell.isError).toBe(true)
    expect(result.cell.display).toMatch(/^#/)
    await expectNoConsoleErrors(page)
  })

  test('worker workbook store rolls back malformed formula after hydration', async ({ page }) => {
    const result = await runWorkerWorkbookStoreFormulaFailureScenario(page, {
      formula: '=garbage((',
      address: 'A1',
    })

    expect(result.baseline.display).toBe('')
    expect(result.baseline.formula).toBe('')
    expect(result.accepted).toBe(false)
    expect(result.optimistic.formula).toBe('=garbage((')
    expect(result.optimistic.isError).toBe(false)
    expect(result.hydrated.isError).toBe(true)
    expect(result.hydrated.formula).toBe('')
    expect(result.hydrated.type).toBe('error')
    expect(result.hydrated.display).toMatch(/^#/)
    await expectNoConsoleErrors(page)
  })

  test('worker workbook store rolls back circular formulas after hydration', async ({ page }) => {
    const result = await runWorkerWorkbookStoreFormulaFailureScenario(page, {
      formula: '=A1+1',
      address: 'A1',
      kind: 'cycle',
    })

    expect(result.baseline.display).toBe('')
    expect(result.baseline.formula).toBe('')
    expect(result.accepted).toBe(false)
    expect(result.optimistic.formula).toBe('=A1+1')
    expect(result.optimistic.isError).toBe(false)
    expect(result.optimistic.type).toBe('null')
    expect(result.hydrated.formula).toBe('')
    expect(result.hydrated.type).toBe('error')
    expect(result.hydrated.isError).toBe(true)
    expect(result.hydrated.display.toUpperCase()).toContain('CYCLE')
    await expectNoConsoleErrors(page)
  })

  test('commits chunked import without hydrating formulas before read', async ({ page }) => {
    const result = await runWorkerWorkbookImportScenario(page)

    expect(result.cancelled).toBe(true)
    expect(result.cancelledCell.display).toBe('')
    expect(result.stats).toEqual({
      accepted: 2,
      formulas: 1,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 0,
      issues: [],
    })
    expect(result.beforeReadEvalCount).toBe(0)
    expect(result.beforeReadState).toBe('dirty')
    expect(result.nonEmpty).toEqual([
      { sheet: 0, addr: 'A1' },
      { sheet: 1, addr: 'A1' },
    ])
    expect(result.sparseSnapshot).toEqual([
      { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      { sheet: 1, addr: 'A1', row: 0, col: 0, kind: 'number', value: 41 },
    ])
    expect(result.afterSnapshotEvalCount).toBe(0)
    expect(result.afterSnapshotState).toBe('dirty')
    expect(result.rangeRead.map((cell) => cell.display)).toEqual(['42'])
    expect(result.afterRangeReadEvalCount).toBe(1)
    expect(result.afterRangeReadState).toBe('clean')

    await expectNoConsoleErrors(page)
  })

  test('commits import issues without preheating valid formulas', async ({ page }) => {
    const result = await runWorkerWorkbookImportIssuesScenario(page)

    expect(result.chunkLength).toBe(4)
    expect(result.stats).toMatchObject({
      accepted: 2,
      formulas: 2,
      rejectedFormulas: 1,
      cleared: 0,
      errors: 3,
    })
    expect(result.stats.issues ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sheet: 99,
          row: 0,
          col: 0,
          kind: 'text',
          code: 'SHEET_OUT_OF_RANGE',
        }),
        expect.objectContaining({
          sheet: 0,
          row: 1,
          col: 1,
          kind: 'formula',
          code: 'FORMULA_REJECTED',
        }),
        expect.objectContaining({
          sheet: 0,
          row: -1,
          col: 0,
          kind: 'number',
          code: 'INVALID_IMPORT_CELL_COORDINATES',
        }),
        expect.objectContaining({
          sheet: 0,
          row: 2,
          col: 0,
          kind: 'number',
          code: 'INVALID_IMPORT_CELL_VALUE',
        }),
      ]),
    )
    expect(result.stats.issues ?? []).toHaveLength(4)

    expect(result.beforeReadEvalCount).toBe(0)
    expect(result.beforeReadState).toBe('dirty')
    expect(result.sparseSnapshot).toEqual(
      expect.arrayContaining([
        { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
        { sheet: 1, addr: 'A1', row: 0, col: 0, kind: 'number', value: 41 },
      ]),
    )
    expect(result.sparseSnapshot).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheet: 0, addr: 'A3' }),
        expect.objectContaining({ sheet: 99 }),
      ]),
    )
    expect(result.afterSnapshotEvalCount).toBe(0)
    expect(result.afterSnapshotState).toBe('dirty')
    expect(result.validFormula.display).toBe('42')
    expect(result.afterReadEvalCount).toBe(1)
    expect(result.afterReadState).toBe('clean')

    await expectNoConsoleErrors(page)
  })

  test('round-trips a sparse snapshot through worker import without preheating formulas', async ({
    page,
  }) => {
    const result = await runWorkerWorkbookSnapshotRoundTripScenario(page)

    expect(result.originalBeforeSnapshotState).toBe('dirty')
    expect(result.originalBeforeSnapshotEvalCount).toBe(0)
    expect(result.originalAfterSnapshotState).toBe('dirty')
    expect(result.originalAfterSnapshotEvalCount).toBe(0)
    expect(result.sparseSnapshot).toEqual([
      { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      { sheet: 1, addr: 'A1', row: 0, col: 0, kind: 'number', value: 41 },
    ])
    expect(result.restoredBeforeReadState).toBe('dirty')
    expect(result.restoredBeforeReadEvalCount).toBe(0)
    expect(result.restoredRead.display).toBe('42')
    expect(result.restoredAfterReadState).toBe('clean')
    expect(result.restoredAfterReadEvalCount).toBe(1)

    await expectNoConsoleErrors(page)
  })

  test('clears a large sparse range through the worker without expanding cells on main', async ({
    page,
  }) => {
    const result = await runWorkerWorkbookClearRangeScenario(page)

    expect(result.beforeClear.display).toBe('42')
    expect(result.beforeClearState).toBe('clean')
    expect(result.cleared).toBe(1)
    expect(result.afterClearState).toBe('dirty')
    expect(result.afterNonEmpty).toEqual([
      { sheet: 0, addr: 'A1' },
      { sheet: 1, addr: 'K11' },
    ])
    expect(result.afterRead.display).toBe('1')
    expect(result.afterReadState).toBe('clean')

    await expectNoConsoleErrors(page)
  })
})

async function runWorkerWorkbookScenario(page: Page): Promise<{
  sheetNames: string[]
  formulaAccepted: boolean[]
  initial: Snapshot[]
  after: Snapshot[]
  dirtyEvents: DirtyRef[][]
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    const dirtyEvents: DirtyRef[][] = []

    function waitForDirty(): Promise<void> {
      return new Promise((resolve, reject) => {
        const started = performance.now()
        const tick = () => {
          if (dirtyEvents.length > 0) {
            resolve()
            return
          }
          if (performance.now() - started > 3_000) {
            reject(new Error('timed out waiting for workbook dirty event'))
            return
          }
          setTimeout(tick, 20)
        }
        tick()
      })
    }

    try {
      const sheets = await workbook.initWorkbook(['Sheet1', 'Sheet2', 'Sheet3'])
      await workbook.setCell(0, 'B4', { type: 'number', value: 10 })

      const formulaAccepted = [
        await workbook.setFormula(2, 'C2', '=Sheet1!B4+1'),
        await workbook.setFormula(1, 'C2', '=Sheet3!C2+1'),
        await workbook.setFormula(0, 'C2', '=Sheet2!C2+1'),
      ]

      const chain = [
        { sheet: 0, addr: 'C2' },
        { sheet: 1, addr: 'C2' },
        { sheet: 2, addr: 'C2' },
      ]
      const initial = await workbook.readCells(chain)

      const subId = await workbook.subscribeCells([{ sheet: 0, addr: 'C2' }], (cells) => {
        dirtyEvents.push(cells)
      })
      await workbook.setCell(0, 'B4', { type: 'number', value: 20 })
      await waitForDirty()
      await workbook.unsubscribeCells(subId)

      const after = await workbook.readCells(chain)

      return {
        sheetNames: sheets.map((sheet) => sheet.name),
        formulaAccepted,
        initial,
        after,
        dirtyEvents,
      }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookStoreFormulaFailureScenario(
  page: Page,
  config: {
    address: string
    formula: string
    kind?: 'invalid' | 'cycle'
  },
): Promise<FormulaFailureScenario> {
  return page.evaluate(async (args) => {
    const { createWorkerWorkbookStore } = await import('/src/wasm-workbook-store.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = await createWorkerWorkbookStore({
      workerFactory: defaultWorkbookWorkerFactory,
    })

    const sheet = workbook.activeStore()
    const address = args.address.toUpperCase()
    const kind = args.kind ?? 'invalid'

    const baseline = {
      sheet: 0,
      addr: address,
      ...sheet.getCell(address),
      formula: sheet.getFormula(address),
    } as Snapshot

    const acceptedPromise = sheet.setFormulaAsync(address, args.formula)

    const optimistic = {
      sheet: 0,
      addr: address,
      ...sheet.getCell(address),
      formula: sheet.getFormula(address),
    } as Snapshot
    const accepted = await acceptedPromise

    async function waitFor(authoritative: (cell: Snapshot) => boolean): Promise<Snapshot> {
      const timeoutMs = 3_000
      const started = performance.now()
      while (true) {
        const cell = {
          sheet: 0,
          addr: address,
          ...sheet.getCell(address),
          formula: sheet.getFormula(address),
        } as Snapshot
        if (authoritative(cell)) return cell
        if (performance.now() - started > timeoutMs) {
          throw new Error('timed out waiting for worker-backed formula failure hydration')
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    const hydrated = await waitFor((cell) => {
      if (kind === 'cycle') {
        return (
          cell.formula === '' &&
          cell.isError &&
          cell.type === 'error' &&
          cell.display.toUpperCase().includes('CYCLE')
        )
      }

      return cell.formula === '' && cell.isError && cell.type === 'error'
    })

    workbook.dispose()

    return {
      baseline,
      optimistic,
      accepted,
      hydrated,
    }
  }, config)
}

async function runWorkerWorkbookImportScenario(page: Page): Promise<{
  cancelled: boolean
  cancelledCell: Snapshot
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
    issues: ImportIssue[]
  }
  beforeReadState: string
  beforeReadEvalCount: number
  nonEmpty: DirtyRef[]
  sparseSnapshot: Array<{
    sheet: number
    addr: string
    row: number
    col: number
    kind: string
    value: string | number | boolean
  }>
  afterSnapshotState: string
  afterSnapshotEvalCount: number
  rangeRead: Snapshot[]
  afterRangeReadState: string
  afterRangeReadEvalCount: number
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])

      const cancelSession = await workbook.beginImport()
      await workbook.importChunk(cancelSession, [
        { sheet: 0, row: 1, col: 1, kind: 'number', value: 99 },
      ])
      const cancelled = await workbook.cancelImport(cancelSession)
      const [cancelledCell] = await workbook.readCells([{ sheet: 0, addr: 'B2' }])

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [{ sheet: 1, row: 0, col: 0, kind: 'number', value: 41 }])
      await workbook.importChunk(session, [
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      ])
      const stats = await workbook.commitImport(session)
      const beforeReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const beforeReadState = await workbook.debugFormulaCacheState(0, 'A1')
      const nonEmpty = await workbook.listNonEmpty()
      const sparseSnapshot = await workbook.snapshotSparse()
      const afterSnapshotEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterSnapshotState = await workbook.debugFormulaCacheState(0, 'A1')
      const rangeRead = await workbook.readSparseRange({
        sheet: 0,
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
      })
      const afterRangeReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterRangeReadState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        cancelled,
        cancelledCell,
        stats,
        beforeReadEvalCount,
        beforeReadState,
        nonEmpty,
        sparseSnapshot,
        afterSnapshotEvalCount,
        afterSnapshotState,
        rangeRead,
        afterRangeReadEvalCount,
        afterRangeReadState,
      }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookImportIssuesScenario(page: Page): Promise<{
  chunkLength: number
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
    issues?: ImportIssue[]
  }
  beforeReadState: string
  beforeReadEvalCount: number
  sparseSnapshot: SparseCell[]
  afterSnapshotState: string
  afterSnapshotEvalCount: number
  validFormula: Snapshot
  afterReadState: string
  afterReadEvalCount: number
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])
      const session = await workbook.beginImport()
      const chunkLength = await workbook.importChunk(session, [
        { sheet: 1, row: 0, col: 0, kind: 'number', value: 41 },
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
        { sheet: 0, row: -1, col: 0, kind: 'number', value: 9 },
        { sheet: 99, row: 0, col: 0, kind: 'text', value: 'missing sheet' },
        { sheet: 0, row: 1, col: 1, kind: 'formula', value: '=garbage((' },
        { sheet: 0, row: 2, col: 0, kind: 'number', value: 'bad value' },
      ])
      const stats = await workbook.commitImport(session)
      const beforeReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const beforeReadState = await workbook.debugFormulaCacheState(0, 'A1')
      const sparseSnapshot = await workbook.snapshotSparse()
      const afterSnapshotEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterSnapshotState = await workbook.debugFormulaCacheState(0, 'A1')
      const [validFormula] = await workbook.readCells([{ sheet: 0, addr: 'A1' }])
      const afterReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterReadState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        chunkLength,
        stats,
        beforeReadEvalCount,
        beforeReadState,
        sparseSnapshot,
        afterSnapshotEvalCount,
        afterSnapshotState,
        validFormula,
        afterReadEvalCount,
        afterReadState,
      }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookSnapshotRoundTripScenario(page: Page): Promise<{
  originalBeforeSnapshotState: string
  originalBeforeSnapshotEvalCount: number
  originalAfterSnapshotState: string
  originalAfterSnapshotEvalCount: number
  sparseSnapshot: SparseCell[]
  restoredBeforeReadState: string
  restoredBeforeReadEvalCount: number
  restoredRead: Snapshot
  restoredAfterReadState: string
  restoredAfterReadEvalCount: number
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const sourceWorkbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    const restoredWorkbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })

    try {
      await sourceWorkbook.initWorkbook(['Sheet1', 'Sheet2'])
      const sourceSession = await sourceWorkbook.beginImport()
      await sourceWorkbook.importChunk(sourceSession, [
        { sheet: 1, row: 0, col: 0, kind: 'number', value: 41 },
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      ])
      await sourceWorkbook.commitImport(sourceSession)

      const originalBeforeSnapshotState = await sourceWorkbook.debugFormulaCacheState(0, 'A1')
      const originalBeforeSnapshotEvalCount = await sourceWorkbook.debugFormulaEvalCount(0)
      const sparseSnapshot = await sourceWorkbook.snapshotSparse()
      const originalAfterSnapshotState = await sourceWorkbook.debugFormulaCacheState(0, 'A1')
      const originalAfterSnapshotEvalCount = await sourceWorkbook.debugFormulaEvalCount(0)

      await restoredWorkbook.initWorkbook(['Sheet1', 'Sheet2'])
      const restoreSession = await restoredWorkbook.beginImport()
      const restoredImportCells = sparseSnapshot.map((cell) => {
        switch (cell.kind) {
          case 'number':
            return {
              sheet: cell.sheet,
              row: cell.row,
              col: cell.col,
              kind: 'number',
              value: cell.value,
            }
          case 'text':
            return {
              sheet: cell.sheet,
              row: cell.row,
              col: cell.col,
              kind: 'text',
              value: cell.value,
            }
          case 'boolean':
            return {
              sheet: cell.sheet,
              row: cell.row,
              col: cell.col,
              kind: 'boolean',
              value: cell.value,
            }
          case 'error':
            return {
              sheet: cell.sheet,
              row: cell.row,
              col: cell.col,
              kind: 'error',
              value: cell.value,
            }
          case 'formula':
            return {
              sheet: cell.sheet,
              row: cell.row,
              col: cell.col,
              kind: 'formula',
              value: cell.value,
            }
          default:
            return { sheet: cell.sheet, row: cell.row, col: cell.col, kind: 'null' }
        }
      })
      await restoredWorkbook.importChunk(restoreSession, restoredImportCells)
      await restoredWorkbook.commitImport(restoreSession)

      const restoredBeforeReadState = await restoredWorkbook.debugFormulaCacheState(0, 'A1')
      const restoredBeforeReadEvalCount = await restoredWorkbook.debugFormulaEvalCount(0)
      const [restoredRead] = await restoredWorkbook.readCells([{ sheet: 0, addr: 'A1' }])
      const restoredAfterReadState = await restoredWorkbook.debugFormulaCacheState(0, 'A1')
      const restoredAfterReadEvalCount = await restoredWorkbook.debugFormulaEvalCount(0)

      return {
        originalBeforeSnapshotState,
        originalBeforeSnapshotEvalCount,
        originalAfterSnapshotState,
        originalAfterSnapshotEvalCount,
        sparseSnapshot,
        restoredBeforeReadState,
        restoredBeforeReadEvalCount,
        restoredRead,
        restoredAfterReadState,
        restoredAfterReadEvalCount,
      }
    } finally {
      sourceWorkbook.dispose()
      restoredWorkbook.dispose()
    }
  })
}

async function runWorkerWorkbookClearRangeScenario(page: Page): Promise<{
  beforeClear: Snapshot
  beforeClearState: string
  cleared: number
  afterClearState: string
  afterNonEmpty: DirtyRef[]
  afterRead: Snapshot
  afterReadState: string
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])
      const session = await workbook.beginImport()
      await workbook.importChunk(session, [
        { sheet: 1, row: 0, col: 0, kind: 'number', value: 41 },
        { sheet: 1, row: 10, col: 10, kind: 'number', value: 99 },
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      ])
      await workbook.commitImport(session)

      const [beforeClear] = await workbook.readCells([{ sheet: 0, addr: 'A1' }])
      const beforeClearState = await workbook.debugFormulaCacheState(0, 'A1')
      const cleared = await workbook.clearRange({
        sheet: 1,
        startRow: 0,
        startCol: 0,
        endRow: 999_999,
        endCol: 0,
      })
      const afterClearState = await workbook.debugFormulaCacheState(0, 'A1')
      const afterNonEmpty = await workbook.listNonEmpty()
      const [afterRead] = await workbook.readCells([{ sheet: 0, addr: 'A1' }])
      const afterReadState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        beforeClear,
        beforeClearState,
        cleared,
        afterClearState,
        afterNonEmpty,
        afterRead,
        afterReadState,
      }
    } finally {
      workbook.dispose()
    }
  })
}
