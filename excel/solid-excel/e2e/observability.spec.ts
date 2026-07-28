import { test, expect } from '@playwright/test'
import { cell, gotoDemo, scrollWrapper } from './helpers'

test.describe('Observability guardrails', () => {
  test('1M demo keeps DOM cell count viewport-sized after scroll', async ({ page }) => {
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible()

    const countCells = () => page.locator('table.excel-table tbody td.cell').count()
    const initialCellCount = await countCells()

    // 1M 网格若回退到完整渲染，会接近 1,000,000；这里要求远低于 viewport 附近的规模。
    expect(initialCellCount).toBeGreaterThan(0)
    expect(initialCellCount).toBeLessThan(2200)

    // 行方向滚动后应只加载新的 viewport 窗口。
    await scrollWrapper(page, 'y', 500 * 26)
    const afterVerticalScroll = await countCells()
    expect(afterVerticalScroll).toBeGreaterThan(0)
    expect(afterVerticalScroll).toBeLessThan(2200)

    // 列方向滚动后同理保持受控，并要求左侧可见列边界发生变化。
    await scrollWrapper(page, 'x', 702 * 100)
    const afterHorizontalScroll = await countCells()
    expect(afterHorizontalScroll).toBeGreaterThan(0)
    expect(afterHorizontalScroll).toBeLessThan(2200)
  })

  test('worker workbook import stays lazy until formula is read', async ({ page }) => {
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible()

    const result = await page.evaluate(async () => {
      const { createWorkerWorkbook } = await import('/src/wasm-workbook-proxy.ts')
      const { defaultWorkbookWorkerFactory } = await import('/src/wasm-workbook-worker-factory.ts')

      const workbook = createWorkerWorkbook({ workerFactory: defaultWorkbookWorkerFactory })
      try {
        await workbook.initWorkbook(['Sheet1'])

        const session = await workbook.beginImport()
        await workbook.importChunk(session, [{ sheet: 0, row: 0, col: 0, kind: 'number', value: 10 }])
        await workbook.importChunk(session, [
          { sheet: 0, row: 1, col: 0, kind: 'formula', value: '=A1+1' },
          { sheet: 0, row: 2, col: 0, kind: 'formula', value: '=A2+1' },
        ])
        await workbook.commitImport(session)

        const beforeReadEvalCount = await workbook.debugFormulaEvalCount(0)
        const beforeReadState = await workbook.debugFormulaCacheState(0, 'A2')
        const beforeReadCounters = await workbook.debugCounters()

        const [formulaCell] = await workbook.readCells([{ sheet: 0, addr: 'A2' }])

        const afterReadEvalCount = await workbook.debugFormulaEvalCount(0)
        const afterReadState = await workbook.debugFormulaCacheState(0, 'A2')
        const afterReadCounters = await workbook.debugCounters()

        return {
          beforeReadEvalCount,
          beforeReadState,
          beforeReadCounters,
          afterReadEvalCount,
          afterReadState,
          afterReadCounters,
          formulaCell,
        }
      } finally {
        workbook.dispose()
      }
    })

    expect(result.beforeReadEvalCount).toBe(0)
    expect(result.beforeReadState).toMatch(/dirty|unknown/i)
    expect(result.beforeReadCounters.formulaCount).toBe(2)
    expect(result.beforeReadCounters.formulaEvalCountTotal).toBe(0)
    expect(result.afterReadEvalCount).toBeGreaterThan(result.beforeReadEvalCount)
    expect(result.afterReadState).toBe('clean')
    expect(result.afterReadCounters.formulaEvalCountTotal).toBeGreaterThan(
      result.beforeReadCounters.formulaEvalCountTotal,
    )
    expect(result.formulaCell.display).toBe('11')
  })
})
