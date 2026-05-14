import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  guardConsoleErrors,
  selectSheet,
  typeIntoCell,
} from './helpers'

test.describe('Solid Excel vNext worker backend', () => {
  async function gotoVNextWorkerDemo(page: Page) {
    guardConsoleErrors(page)
    await page.goto('/')
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

    await typeIntoCell(page, 'B4', '20')
    await expect(cellDisplay(page, 'C2')).toHaveText('23')

    await selectSheet(page, 'Sheet2')
    await expect(cellDisplay(page, 'C2')).toHaveText('22')

    await selectSheet(page, 'Sheet3')
    await expect(cellDisplay(page, 'C2')).toHaveText('21')

    await expectNoConsoleErrors(page)
  })
})
