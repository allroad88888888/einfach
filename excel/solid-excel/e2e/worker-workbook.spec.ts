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
    expect(result.stats).toMatchObject({
      accepted: 2,
      formulas: 1,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 0,
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

  test('commits sparse import without preheating untouched formulas', async ({ page }) => {
    const result = await runWorkerWorkbookImportTouchedCellsScenario(page)

    expect(result.stats).toMatchObject({
      accepted: 1,
      formulas: 0,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 0,
    })

    expect(result.preImportEvalCount).toBe(result.beforeReadEvalCount)
    expect(result.preFormulaState).toBe('dirty')
    expect(result.beforeReadFormulaState).toBe('dirty')
    expect(result.afterReadFormulaState).toBe('clean')

    expect(result.preNonEmpty).toEqual(expect.arrayContaining([{ sheet: 0, addr: 'A1' }, { sheet: 0, addr: 'B1' }]))
    expect(result.preNonEmpty).toHaveLength(2)
    expect(result.finalNonEmpty).toEqual(
      expect.arrayContaining([
        { sheet: 0, addr: 'A1' },
        { sheet: 0, addr: 'B1' },
        { sheet: 0, addr: 'C1' },
      ]),
    )
    expect(result.finalNonEmpty).toHaveLength(3)

    expect(result.touched.addr).toBe('C1')
    expect(result.touched.display).toBe('77')
    expect(result.untouchedNumber.display).toBe('20')
    expect(result.untouchedFormula.formula).toBe('=A1+1')
    expect(result.untouchedFormula.display).toBe('21')
    expect(result.afterReadFormulaState).toBe('clean')
    expect(result.afterReadEvalCount).toBeGreaterThan(result.beforeReadEvalCount)

    await expectNoConsoleErrors(page)
  })

  test('imports a formula that depends on an existing workbook cell', async ({ page }) => {
    const result = await runWorkerWorkbookImportFormulaAgainstExistingCellScenario(page)

    expect(result.stats).toMatchObject({
      accepted: 1,
      formulas: 1,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 0,
    })
    expect(result.beforeReadEvalCount).toBe(0)
    expect(result.beforeReadFormulaState).toBe('dirty')
    expect(result.formula.display).toBe('42')
    expect(result.formula.formula).toBe('=Sheet2!A1+1')
    expect(result.source.display).toBe('41')
    expect(result.afterReadFormulaState).toBe('clean')
    expect(result.afterReadEvalCount).toBe(1)

    await expectNoConsoleErrors(page)
  })

  test('reports final workbook formula rejection after shell-staged import', async ({ page }) => {
    const result = await runWorkerWorkbookImportFinalRejectionScenario(page)

    expect(result.stats).toMatchObject({
      accepted: 0,
      formulas: 1,
      rejectedFormulas: 1,
      cleared: 0,
      errors: 0,
    })
    expect(result.stats.issues ?? []).toEqual([
      expect.objectContaining({
        sheet: 0,
        row: 0,
        col: 0,
        kind: 'formula',
        code: 'FORMULA_REJECTED',
      }),
    ])
    expect(result.cell.type).toBe('error')
    expect(result.cell.isError).toBe(true)
    expect(result.cell.display.toUpperCase()).toContain('CYCLE')

    await expectNoConsoleErrors(page)
  })

  test('respects import null final-write order', async ({ page }) => {
    const result = await runWorkerWorkbookImportNullClearScenario(page)

    expect(result.stats.accepted).toBe(5)
    expect(result.stats.formulas).toBe(0)
    expect(result.setThenNull.type).toBe('null')
    expect(result.setThenNull.display).toBe('')
    expect(result.nullThenSet.type).toBe('number')
    expect(result.nullThenSet.display).toBe('12')
    expect(result.nonEmpty).toEqual([{ sheet: 0, addr: 'B1' }])

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

  test('round-trips persistence v1 snapshot through worker import without preheating formulas', async ({
    page,
  }) => {
    const result = await runWorkerWorkbookPersistenceSnapshotScenario(page)

    expect(result.importStateBeforeSnapshot).toBe('dirty')
    expect(result.importEvalCountBeforeSnapshot).toBe(0)
    expect(result.afterSnapshotState).toBe('dirty')
    expect(result.afterSnapshotEvalCount).toBe(0)
    expect(result.restoredBeforeReadState).toBe('dirty')
    expect(result.restoredBeforeReadEvalCount).toBe(0)
    expect(result.restoredFormula.display).toBe('42')
    expect(result.restoredAfterReadState).toBe('clean')
    expect(result.restoredAfterReadEvalCount).toBeGreaterThan(result.restoredBeforeReadEvalCount)

    await expectNoConsoleErrors(page)
  })

  test('returns import session limit error for oversized import chunk', async ({ page }) => {
    const result = await runWorkerWorkbookImportTooLargeChunkScenario(page)

    expect(result.errorCode).toBe('IMPORT_CHUNK_TOO_LARGE')
    expect(result.cancelled).toBe(true)

    await expectNoConsoleErrors(page)
  })

  test('exports range tsv with formula source and without evaluating formulas', async ({ page }) => {
    const result = await runWorkerWorkbookExportRangeTsvScenario(page)

    expect(result.tsv).toBe('=Sheet2!A1+1')
    expect(result.beforeEvalCount).toBe(0)
    expect(result.beforeCacheState).toBe('dirty')
    expect(result.beforeEvalCount).toBe(result.afterEvalCount)
    expect(result.beforeCacheState).toBe(result.afterCacheState)
    expect(result.sparseSnapshot).toEqual([
      { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      { sheet: 1, addr: 'A1', row: 0, col: 0, kind: 'number', value: 10 },
    ])

    await expectNoConsoleErrors(page)
  })

  test('exports range tsv chunks without evaluating formulas', async ({ page }) => {
    const result = await runWorkerWorkbookExportRangeTsvChunksScenario(page)

    expect(result.chunks).toEqual(['=Sheet2!A1+1\n', 'tail'])
    expect(result.body).toBe('=Sheet2!A1+1\n\ntail')
    expect(result.beforeEvalCount).toBe(0)
    expect(result.beforeCacheState).toBe('dirty')
    expect(result.beforeEvalCount).toBe(result.afterEvalCount)
    expect(result.beforeCacheState).toBe(result.afterCacheState)

    await expectNoConsoleErrors(page)
  })

  test('clears a large sparse range through the worker without expanding cells on main', async ({
    page,
  }) => {
    const result = await runWorkerWorkbookClearRangeScenario(page)

    expect(result.beforeClear.display).toBe('42')
    expect(result.beforeClearState).toBe('clean')
    expect(result.cleared).toBe(1)
    // Sheet1!A1 was already observed (readCells above), so the Store
    // propagation eagerly re-derives it during clearRange — the engine
    // pins this in `clear_range_scans_sparse_and_rederives_cross_sheet_dependents`
    // (excel/rust/excel-core/src/workbook.rs): state 'clean' + one extra eval.
    // Laziness for never-read formulas is still pinned by the store-undo
    // scenario below (restoreSparse leaves 'dirty', evalCount 0).
    expect(result.afterClearState).toBe('clean')
    expect(result.afterNonEmpty).toEqual([
      { sheet: 0, addr: 'A1' },
      { sheet: 1, addr: 'K11' },
    ])
    expect(result.afterRead.display).toBe('1')
    expect(result.afterReadState).toBe('clean')

    await expectNoConsoleErrors(page)
  })

  test('worker store undo restores a large sparse clear without preheating formulas', async ({
    page,
  }) => {
    const result = await runWorkerWorkbookStoreLargeClearUndoScenario(page)

    expect(result.beforeState).toBe('dirty')
    expect(result.beforeEvalCount).toBe(0)
    expect(result.cleared).toBe(true)
    expect(result.afterClearNonEmpty).toEqual([])
    expect(result.canUndoAfterClear).toBe(true)

    expect(result.afterUndoNonEmpty).toEqual(
      expect.arrayContaining([
        { sheet: 0, addr: 'A1' },
        { sheet: 0, addr: 'A2' },
        { sheet: 0, addr: 'B2' },
      ]),
    )
    expect(result.afterUndoNonEmpty).toHaveLength(3)
    expect(result.afterUndoState).toBe('dirty')
    expect(result.afterUndoEvalCount).toBe(0)
    expect(result.afterUndoSparse).toEqual(
      expect.arrayContaining([
        { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'number', value: 10 },
        { sheet: 0, addr: 'A2', row: 1, col: 0, kind: 'text', value: 'hello' },
        { sheet: 0, addr: 'B2', row: 1, col: 1, kind: 'formula', value: '=A1+1' },
      ]),
    )
    expect(result.finalRead.display).toBe('11')
    expect(result.afterFinalReadState).toBe('clean')
    expect(result.afterFinalReadEvalCount).toBe(1)

    const firstSnapshot = result.calls.indexOf('snapshotRangeSparse')
    const firstClear = result.calls.indexOf('clearRange')
    expect(firstSnapshot).toBeGreaterThanOrEqual(0)
    expect(firstClear).toBe(firstSnapshot + 1)
    expect(result.calls).toContain('restoreSparse')
    expect(result.calls).not.toContain('readSparseRange')

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

async function runWorkerWorkbookImportTouchedCellsScenario(page: Page): Promise<{
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
    issues?: ImportIssue[]
  }
  preImportEvalCount: number
  preFormulaState: string
  beforeReadEvalCount: number
  beforeReadFormulaState: string
  afterReadEvalCount: number
  afterReadFormulaState: string
  touched: Snapshot
  untouchedNumber: Snapshot
  untouchedFormula: Snapshot
  preNonEmpty: DirtyRef[]
  finalNonEmpty: DirtyRef[]
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1'])

      await workbook.setCell(0, 'A1', { type: 'number', value: 10 })
      await workbook.setFormula(0, 'B1', '=A1+1')

      const preImportEvalCount = await workbook.debugFormulaEvalCount(0)
      const preFormulaState = await workbook.debugFormulaCacheState(0, 'B1')
      const preNonEmpty = await workbook.listNonEmpty()

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [{ sheet: 0, row: 0, col: 2, kind: 'number', value: 77 }])
      await workbook.setCell(0, 'A1', { type: 'number', value: 20 })
      const stats = await workbook.commitImport(session)

      const beforeReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const beforeReadFormulaState = await workbook.debugFormulaCacheState(0, 'B1')
      const [touched, untouchedNumber, untouchedFormula] = await workbook.readCells([
        { sheet: 0, addr: 'C1' },
        { sheet: 0, addr: 'A1' },
        { sheet: 0, addr: 'B1' },
      ])
      const afterReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterReadFormulaState = await workbook.debugFormulaCacheState(0, 'B1')
      const finalNonEmpty = await workbook.listNonEmpty()

      return {
        stats,
        preImportEvalCount,
        preFormulaState,
        beforeReadEvalCount,
        beforeReadFormulaState,
        afterReadEvalCount,
        afterReadFormulaState,
        touched,
        untouchedNumber,
        untouchedFormula,
        preNonEmpty,
        finalNonEmpty,
      }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookImportFormulaAgainstExistingCellScenario(page: Page): Promise<{
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
    issues?: ImportIssue[]
  }
  beforeReadEvalCount: number
  beforeReadFormulaState: string
  afterReadEvalCount: number
  afterReadFormulaState: string
  formula: Snapshot
  source: Snapshot
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])
      await workbook.setCell(1, 'A1', { type: 'number', value: 41 })

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      ])
      const stats = await workbook.commitImport(session)

      const beforeReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const beforeReadFormulaState = await workbook.debugFormulaCacheState(0, 'A1')
      const [formula, source] = await workbook.readCells([
        { sheet: 0, addr: 'A1' },
        { sheet: 1, addr: 'A1' },
      ])
      const afterReadEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterReadFormulaState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        stats,
        beforeReadEvalCount,
        beforeReadFormulaState,
        afterReadEvalCount,
        afterReadFormulaState,
        formula,
        source,
      }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookImportFinalRejectionScenario(page: Page): Promise<{
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
    issues?: ImportIssue[]
  }
  cell: Snapshot
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])
      await workbook.setFormula(1, 'A1', '=Sheet1!A1+1')

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      ])
      const stats = await workbook.commitImport(session)
      const [cell] = await workbook.readCells([{ sheet: 0, addr: 'A1' }])

      return { stats, cell }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookImportNullClearScenario(page: Page): Promise<{
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
    issues?: ImportIssue[]
  }
  setThenNull: Snapshot
  nullThenSet: Snapshot
  nonEmpty: DirtyRef[]
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1'])

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [
        { sheet: 0, row: 0, col: 0, kind: 'number', value: 11 },
        { sheet: 0, row: 0, col: 1, kind: 'number', value: 22 },
      ])
      await workbook.importChunk(session, [
        { sheet: 0, row: 0, col: 0, kind: 'null' },
        { sheet: 0, row: 0, col: 1, kind: 'null' },
      ])
      await workbook.importChunk(session, [{ sheet: 0, row: 0, col: 1, kind: 'number', value: 12 }])
      const stats = await workbook.commitImport(session)

      const [setThenNull, nullThenSet] = await workbook.readCells([
        { sheet: 0, addr: 'A1' },
        { sheet: 0, addr: 'B1' },
      ])
      const nonEmpty = await workbook.listNonEmpty()

      return {
        stats,
        setThenNull,
        nullThenSet,
        nonEmpty,
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

async function runWorkerWorkbookPersistenceSnapshotScenario(page: Page): Promise<{
  importStateBeforeSnapshot: string
  importEvalCountBeforeSnapshot: number
  afterSnapshotState: string
  afterSnapshotEvalCount: number
  restoredBeforeReadState: string
  restoredBeforeReadEvalCount: number
  restoredFormula: Snapshot
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

      const importStateBeforeSnapshot = await sourceWorkbook.debugFormulaCacheState(0, 'A1')
      const importEvalCountBeforeSnapshot = await sourceWorkbook.debugFormulaEvalCount(0)

      const snapshot = await sourceWorkbook.snapshotPersistenceV1()
      const afterSnapshotState = await sourceWorkbook.debugFormulaCacheState(0, 'A1')
      const afterSnapshotEvalCount = await sourceWorkbook.debugFormulaEvalCount(0)

      await restoredWorkbook.initWorkbook(['Sheet1', 'Sheet2'])
      await restoredWorkbook.restorePersistenceV1(snapshot)

      const restoredBeforeReadState = await restoredWorkbook.debugFormulaCacheState(0, 'A1')
      const restoredBeforeReadEvalCount = await restoredWorkbook.debugFormulaEvalCount(0)
      const [restoredFormula] = await restoredWorkbook.readCells([{ sheet: 0, addr: 'A1' }])
      const restoredAfterReadState = await restoredWorkbook.debugFormulaCacheState(0, 'A1')
      const restoredAfterReadEvalCount = await restoredWorkbook.debugFormulaEvalCount(0)

      return {
        importStateBeforeSnapshot,
        importEvalCountBeforeSnapshot,
        afterSnapshotState,
        afterSnapshotEvalCount,
        restoredBeforeReadState,
        restoredBeforeReadEvalCount,
        restoredFormula,
        restoredAfterReadState,
        restoredAfterReadEvalCount,
      }
    } finally {
      sourceWorkbook.dispose()
      restoredWorkbook.dispose()
    }
  })
}

async function runWorkerWorkbookImportTooLargeChunkScenario(page: Page): Promise<{
  errorCode: string
  cancelled: boolean
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    try {
      await workbook.initWorkbook(['Sheet1'])

      const session = await workbook.beginImport()
      const oversizedChunk = Array.from({ length: 10_001 }, (_, row) => ({
        sheet: 0,
        row,
        col: 0,
        kind: 'number' as const,
        value: row,
      }))

      let errorCode = 'NO_ERROR'
      try {
        await workbook.importChunk(session, oversizedChunk)
      } catch (error: unknown) {
        errorCode =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'UNKNOWN'
      }

      const cancelled = await workbook.cancelImport(session)

      return { errorCode, cancelled }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookExportRangeTsvScenario(page: Page): Promise<{
  tsv: string
  beforeEvalCount: number
  beforeCacheState: string
  afterEvalCount: number
  afterCacheState: string
  sparseSnapshot: SparseCell[]
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })

    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [
        { sheet: 1, row: 0, col: 0, kind: 'number', value: 10 },
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      ])
      await workbook.commitImport(session)

      const beforeEvalCount = await workbook.debugFormulaEvalCount(0)
      const beforeCacheState = await workbook.debugFormulaCacheState(0, 'A1')
      const sparseSnapshot = await workbook.snapshotSparse()
      const tsv = await workbook.exportRangeTsv({
        sheet: 0,
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
      })
      const afterEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterCacheState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        tsv,
        beforeEvalCount,
        beforeCacheState,
        afterEvalCount,
        afterCacheState,
        sparseSnapshot,
      }
    } finally {
      workbook.dispose()
    }
  })
}

async function runWorkerWorkbookExportRangeTsvChunksScenario(page: Page): Promise<{
  chunks: string[]
  body: string
  beforeEvalCount: number
  beforeCacheState: string
  afterEvalCount: number
  afterCacheState: string
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })

    try {
      await workbook.initWorkbook(['Sheet1', 'Sheet2'])

      const session = await workbook.beginImport()
      await workbook.importChunk(session, [
        { sheet: 1, row: 0, col: 0, kind: 'number', value: 10 },
        { sheet: 0, row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
        { sheet: 0, row: 2, col: 0, kind: 'text', value: 'tail' },
      ])
      await workbook.commitImport(session)

      const beforeEvalCount = await workbook.debugFormulaEvalCount(0)
      const beforeCacheState = await workbook.debugFormulaCacheState(0, 'A1')
      const chunks = await workbook.exportRangeTsvChunks(
        {
          sheet: 0,
          startRow: 0,
          startCol: 0,
          endRow: 2,
          endCol: 0,
        },
        2,
      )
      const afterEvalCount = await workbook.debugFormulaEvalCount(0)
      const afterCacheState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        chunks,
        body: chunks.join('\n'),
        beforeEvalCount,
        beforeCacheState,
        afterEvalCount,
        afterCacheState,
      }
    } finally {
      workbook.dispose()
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

async function runWorkerWorkbookStoreLargeClearUndoScenario(page: Page): Promise<{
  calls: string[]
  beforeState: string
  beforeEvalCount: number
  cleared: boolean
  afterClearNonEmpty: DirtyRef[]
  canUndoAfterClear: boolean
  afterUndoNonEmpty: DirtyRef[]
  afterUndoState: string
  afterUndoEvalCount: number
  afterUndoSparse: SparseCell[]
  finalRead: Snapshot
  afterFinalReadState: string
  afterFinalReadEvalCount: number
}> {
  return page.evaluate(async () => {
    const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
    const { createWorkerWorkbookStore } = await import('/src/wasm-workbook-store.ts')
    const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

    const client = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
    const calls: string[] = []
    const instrumentedClient = new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof prop !== 'string' || typeof value !== 'function') return value
        return (...args: unknown[]) => {
          calls.push(prop)
          return value.apply(target, args)
        }
      },
    })

    const workbook = await createWorkerWorkbookStore({
      client: instrumentedClient,
      async afterInit(worker) {
        await worker.setCell(0, 'A1', { type: 'number', value: 10 })
        await worker.setCell(0, 'A2', { type: 'text', value: 'hello' })
        await worker.setFormula(0, 'B2', '=A1+1')
      },
    })

    async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
      const timeoutMs = 3_000
      const started = performance.now()
      while (true) {
        const value = await read()
        if (ok(value)) return value
        if (performance.now() - started > timeoutMs) {
          throw new Error('timed out waiting for worker store sparse undo')
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    try {
      const store = workbook.activeStore()
      const beforeState = await instrumentedClient.debugFormulaCacheState(0, 'B2')
      const beforeEvalCount = await instrumentedClient.debugFormulaEvalCount(0)

      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      const cleared = await store.clearSelectionRangeAsync()
      const afterClearNonEmpty = await instrumentedClient.listNonEmpty()
      const canUndoAfterClear = store.canUndo()

      store.undo()
      const afterUndoNonEmpty = await waitFor(
        () => instrumentedClient.listNonEmpty(),
        (refs) =>
          refs.some((ref) => ref.sheet === 0 && ref.addr === 'A1') &&
          refs.some((ref) => ref.sheet === 0 && ref.addr === 'A2') &&
          refs.some((ref) => ref.sheet === 0 && ref.addr === 'B2'),
      )
      const afterUndoState = await instrumentedClient.debugFormulaCacheState(0, 'B2')
      const afterUndoEvalCount = await instrumentedClient.debugFormulaEvalCount(0)
      const afterUndoSparse = await instrumentedClient.snapshotRangeSparse({
        sheet: 0,
        startRow: 0,
        startCol: 0,
        endRow: 1,
        endCol: 1,
      })
      const [finalRead] = await instrumentedClient.readCells([{ sheet: 0, addr: 'B2' }])
      const afterFinalReadState = await instrumentedClient.debugFormulaCacheState(0, 'B2')
      const afterFinalReadEvalCount = await instrumentedClient.debugFormulaEvalCount(0)

      return {
        calls,
        beforeState,
        beforeEvalCount,
        cleared,
        afterClearNonEmpty,
        canUndoAfterClear,
        afterUndoNonEmpty,
        afterUndoState,
        afterUndoEvalCount,
        afterUndoSparse,
        finalRead,
        afterFinalReadState,
        afterFinalReadEvalCount,
      }
    } finally {
      workbook.dispose()
    }
  })
}
