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
      const { defaultWorkbookWorkerFactory } = await import(
        '/src/wasm-workbook-worker-factory.ts'
      )
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
    const { defaultWorkbookWorkerFactory } = await import(
      '/src/wasm-workbook-worker-factory.ts'
    )

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
