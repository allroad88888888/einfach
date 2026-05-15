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
      debugFormulaCacheState(sheet: number, addr: string): Promise<string>
      debugFormulaEvalCount(sheet: number): Promise<number>
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
    await expect(firstTab).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('status-visible-cells')).toHaveText('30 cells')
    await expectNoConsoleErrors(page)
  })
})
