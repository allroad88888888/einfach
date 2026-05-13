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

type DirtyRef = {
  sheet: number
  addr: string
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
        return await workbook.setFormula(0, 'A1', '=A1+1')
      } finally {
        workbook.dispose()
      }
    })

    expect(result).toBe(false)
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
        const [cell] = await workbook.readCells([{ sheet: 0, addr: 'A1' }])
        return { accepted, cell }
      } finally {
        workbook.dispose()
      }
    })

    expect(result.accepted).toBe(false)
    expect(result.cell.isError).toBe(true)
    expect(result.cell.display).toMatch(/^#/)
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
    })
    expect(result.beforeReadState).toBe('dirty')
    expect(result.nonEmpty).toEqual([
      { sheet: 0, addr: 'A1' },
      { sheet: 1, addr: 'A1' },
    ])
    expect(result.sparseSnapshot).toEqual([
      { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'formula', value: '=Sheet2!A1+1' },
      { sheet: 1, addr: 'A1', row: 0, col: 0, kind: 'number', value: 41 },
    ])
    expect(result.afterSnapshotState).toBe('dirty')
    expect(result.rangeRead.map((cell) => cell.display)).toEqual(['42'])
    expect(result.afterRangeReadState).toBe('clean')

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

async function runWorkerWorkbookImportScenario(page: Page): Promise<{
  cancelled: boolean
  cancelledCell: Snapshot
  stats: {
    accepted: number
    formulas: number
    rejectedFormulas: number
    cleared: number
    errors: number
  }
  beforeReadState: string
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
  rangeRead: Snapshot[]
  afterRangeReadState: string
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
      const beforeReadState = await workbook.debugFormulaCacheState(0, 'A1')
      const nonEmpty = await workbook.listNonEmpty()
      const sparseSnapshot = await workbook.snapshotSparse()
      const afterSnapshotState = await workbook.debugFormulaCacheState(0, 'A1')
      const rangeRead = await workbook.readSparseRange({
        sheet: 0,
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
      })
      const afterRangeReadState = await workbook.debugFormulaCacheState(0, 'A1')

      return {
        cancelled,
        cancelledCell,
        stats,
        beforeReadState,
        nonEmpty,
        sparseSnapshot,
        afterSnapshotState,
        rangeRead,
        afterRangeReadState,
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
