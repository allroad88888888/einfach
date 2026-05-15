import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  guardConsoleErrors,
  selectSheet,
  typeIntoCell,
} from './helpers'

declare global {
  interface Window {
    __einfachWorkbookDebugClient?: {
      sheetList(): Promise<Array<{ idx: number; name: string }>>
      debugFormulaCacheState(sheet: number, addr: string): Promise<string>
      debugFormulaEvalCount(sheet: number): Promise<number>
      snapshotPersistenceV1(): Promise<{
        sizes?: Array<{
          sheet?: number
          rowHeights?: Array<{ rowIndex: number; heightPx: number }>
          colWidths?: Array<{ colIndex: number; widthPx: number }>
        }>
      }>
    }
  }
}

test.describe('Solid Excel vNext worker backend', () => {
  async function gotoVNextWorkerDemo(page: Page) {
    guardConsoleErrors(page)
    await page.goto('/?debug=1')
    await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
    await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
    await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
  }

  test('renders the Rust worker-backed 3-sheet dependency chain lazily through vNext', async ({
    page,
  }) => {
    await gotoVNextWorkerDemo(page)

    const visibleCells = await page.locator('[data-testid="vnext-worker-grid"] td.cell').count()
    expect(visibleCells).toBe(30)
    await expect(cell(page, 'J20')).toHaveCount(0)
    await expect(page.getByTestId('status-active-cell')).toHaveText('A1')
    await expect(page.getByTestId('status-visible-cells')).toHaveText('30 cells')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')

    await expect
      .poll(() =>
        page.evaluate(
          () => typeof window.__einfachWorkbookDebugClient?.debugFormulaCacheState === 'function',
        ),
      )
      .toBe(true)
    const beforeLazyProbe = await page.evaluate(async () => {
      const client = window.__einfachWorkbookDebugClient!
      return {
        state: await client.debugFormulaCacheState(1, 'C5'),
        evalCount: await client.debugFormulaEvalCount(1),
      }
    })
    expect(beforeLazyProbe.state).toBe('dirty')

    await typeIntoCell(page, 'B4', '20')
    await expect(cellDisplay(page, 'C2')).toHaveText('23')

    const lazyLogPromise = page.waitForEvent('console', {
      predicate: (msg) =>
        msg.type() === 'log' && msg.text().includes('[vnext-worker-lazy-demo] computed Sheet2!C5'),
    })
    await selectSheet(page, 'Sheet2')
    await expect(cellDisplay(page, 'C2')).toHaveText('22')
    await expect(cellDisplay(page, 'C5')).toHaveText('105')
    const lazyLog = await lazyLogPromise
    expect(lazyLog.text()).toContain('before=dirty')
    expect(lazyLog.text()).toContain('after=clean')
    const afterLazyProbe = await page.evaluate(async () => {
      const client = window.__einfachWorkbookDebugClient!
      return {
        state: await client.debugFormulaCacheState(1, 'C5'),
        evalCount: await client.debugFormulaEvalCount(1),
      }
    })
    expect(afterLazyProbe.state).toBe('clean')
    expect(afterLazyProbe.evalCount).toBeGreaterThan(beforeLazyProbe.evalCount)

    await selectSheet(page, 'Sheet3')
    await expect(cellDisplay(page, 'C2')).toHaveText('21')

    await expectNoConsoleErrors(page)
  })

  test('resolves data-aware ctrl arrow movement through the Rust worker backend', async ({
    page,
  }) => {
    await gotoVNextWorkerDemo(page)

    await cell(page, 'A4').click()
    await page.keyboard.press('Control+ArrowRight')

    await expect(page.getByTestId('formula-bar-addr')).toHaveText('C4')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C4')
    await expect(cell(page, 'C4')).toHaveClass(/cell-active/)
    await expect(page.getByTestId('status-visible-cells')).toHaveText('30 cells')
    await expect(cell(page, 'J20')).toHaveCount(0)
    await expectNoConsoleErrors(page)
  })

  test('reorders sheet tabs through the Rust worker backend metadata adapter', async ({ page }) => {
    await gotoVNextWorkerDemo(page)
    await expect(cellDisplay(page, 'C2')).toHaveText('13')

    const handle = page.getByTestId('sheet-tab-reorder-sheet-3')
    const firstTab = page.getByRole('tab', { name: 'Sheet1' })
    const handleBox = await handle.boundingBox()
    const firstBox = await firstTab.boundingBox()
    expect(handleBox).not.toBeNull()
    expect(firstBox).not.toBeNull()

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(firstBox!.x + 2, firstBox!.y + firstBox!.height / 2)
    await page.mouse.up()

    await expect(page.getByTestId('vnext-worker-sheet-tabs').getByRole('tab').first()).toHaveText(
      'Sheet3',
    )
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const client = window.__einfachWorkbookDebugClient!
          return (await client.sheetList()).map((sheet) => sheet.name)
        }),
      )
      .toEqual(['Sheet3', 'Sheet1', 'Sheet2'])
    await expect(firstTab).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')

    await selectSheet(page, 'Sheet3')
    await expect(cellDisplay(page, 'C2')).toHaveText('11')
    await selectSheet(page, 'Sheet2')
    await expect(cellDisplay(page, 'C2')).toHaveText('12')
    await selectSheet(page, 'Sheet1')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')
    await expect(page.getByTestId('status-visible-cells')).toHaveText('30 cells')
    await expectNoConsoleErrors(page)
  })

  test('persists row and column size metadata as Rust sparse facts', async ({ page }) => {
    await gotoVNextWorkerDemo(page)

    const colHeader = page.locator('.spreadsheet-grid-col-header[data-col="1"]')
    const rowHeader = page.locator('.spreadsheet-grid-row-header[data-row="1"]')
    const beforeCol = await colHeader.boundingBox()
    const beforeRow = await rowHeader.boundingBox()
    expect(beforeCol).not.toBeNull()
    expect(beforeRow).not.toBeNull()

    const colHandle = page.getByTestId('col-resize-1')
    const colHandleBox = await colHandle.boundingBox()
    expect(colHandleBox).not.toBeNull()
    await page.mouse.move(
      colHandleBox!.x + colHandleBox!.width / 2,
      colHandleBox!.y + colHandleBox!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      colHandleBox!.x + colHandleBox!.width / 2 + 34,
      colHandleBox!.y + colHandleBox!.height / 2,
    )
    await page.mouse.up()
    const afterCol = await colHeader.boundingBox()
    expect(afterCol).not.toBeNull()
    expect(afterCol!.width).toBeGreaterThan(beforeCol!.width + 20)

    const rowHandle = page.getByTestId('row-resize-1')
    const rowHandleBox = await rowHandle.boundingBox()
    expect(rowHandleBox).not.toBeNull()
    await page.mouse.move(
      rowHandleBox!.x + rowHandleBox!.width / 2,
      rowHandleBox!.y + rowHandleBox!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      rowHandleBox!.x + rowHandleBox!.width / 2,
      rowHandleBox!.y + rowHandleBox!.height / 2 + 14,
    )
    await page.mouse.up()
    const afterRow = await rowHeader.boundingBox()
    expect(afterRow).not.toBeNull()
    expect(afterRow!.height).toBeGreaterThan(beforeRow!.height + 8)

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const snapshot = await window.__einfachWorkbookDebugClient!.snapshotPersistenceV1()
          const sheetSizes = snapshot.sizes?.find((entry) => entry.sheet === 0)
          return {
            rows: sheetSizes?.rowHeights ?? [],
            cols: sheetSizes?.colWidths ?? [],
          }
        }),
      )
      .toEqual({
        rows: expect.arrayContaining([expect.objectContaining({ rowIndex: 1 })]),
        cols: expect.arrayContaining([expect.objectContaining({ colIndex: 1 })]),
      })

    await selectSheet(page, 'Sheet2')
    await selectSheet(page, 'Sheet1')
    await expect(page.getByTestId('status-visible-cells')).toHaveText('30 cells')
    await expect(cell(page, 'J20')).toHaveCount(0)
    await expectNoConsoleErrors(page)
  })
})
