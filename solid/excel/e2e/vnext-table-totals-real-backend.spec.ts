import { expect, test, type Page } from '@playwright/test'

import {
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

/**
 * Excel Table totals row end to end on the vNext Worker WASM demo
 * (design-excel-table.md §7, parity #32 T6) — real-backend evidence that the
 * UI-core toggle command → worker RPC → Rust engine → SUBTOTAL write all close
 * through the visible UI.
 *
 * Flow:
 *   1. Seed an Item/Qty block (header + 3 data rows) and create a table over it.
 *   2. Data → "Toggle totals row": the engine grows the table by one row and
 *      writes `=SUBTOTAL(109, Table1[Qty])` in the last column.
 *   3. Assert the visible success badge (`data-has-totals="true"`) and that the
 *      totals cell (F5) shows the SUM of the Qty column.
 *   4. Edit a Qty value and assert the SUBTOTAL total recomputes live.
 *
 * WASM-only: the TS worker declares `structuredTables: false` (fail-closed), so
 * the Data-menu totals entry hides on the `ts` project.
 */

function activeProjectIsWasm(): boolean {
  try {
    return test.info().project.name !== 'ts'
  } catch {
    return true
  }
}

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function seedTableRegion(page: Page) {
  await typeIntoCell(page, 'E1', 'Item')
  await typeIntoCell(page, 'F1', 'Qty')
  await typeIntoCell(page, 'E2', 'a')
  await typeIntoCell(page, 'F2', '10')
  await typeIntoCell(page, 'E3', 'b')
  await typeIntoCell(page, 'F3', '20')
  await typeIntoCell(page, 'E4', 'c')
  await typeIntoCell(page, 'F4', '30')
}

async function selectRange(page: Page, rangeA1: string) {
  const nameBox = page.getByTestId('name-box-input')
  await nameBox.fill(rangeA1)
  await nameBox.press('Enter')
  await expect(page.getByTestId('status-selection')).toHaveText(rangeA1)
}

test.describe('vNext Excel Table totals row — real WASM backend', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('Data > Toggle totals row writes a SUBTOTAL total that recomputes on edit', async ({
    page,
  }) => {
    test.skip(
      !activeProjectIsWasm(),
      'Excel Table totals are WASM-only (TS worker declares structuredTables:false)',
    )
    await gotoWorkerDemo(page)
    await seedTableRegion(page)
    await selectRange(page, 'E1:F4')

    // Create the table over the selection.
    await page.getByTestId('menu-bar-button-data').click()
    await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
    await page.getByTestId('menu-bar-item-data.createTable').click()
    await expect(page.getByTestId('menu-bar-create-table-status')).toHaveText('Table1')

    // Put the active cell inside the table, then toggle the totals row on.
    await selectRange(page, 'E2')
    await page.getByTestId('menu-bar-button-data').click()
    const totalsItem = page.getByTestId('menu-bar-item-data.toggleTotals')
    await expect(totalsItem).toBeVisible()
    await totalsItem.click()

    // Visible success badge: the toggled table now has a totals row.
    await expect(page.getByTestId('menu-bar-toggle-totals-status')).toHaveAttribute(
      'data-has-totals',
      'true',
    )
    await expect(page.getByTestId('menu-bar-create-table-error')).toHaveCount(0)

    // The engine grew the table by one row and wrote a default SUBTOTAL(109)
    // SUM in the last (Qty) column → F5 = 10 + 20 + 30.
    await expect(cellDisplay(page, 'F5')).toHaveText('60')

    // Editing a Qty data cell recomputes the SUBTOTAL total live.
    await typeIntoCell(page, 'F2', '100')
    await expect(cellDisplay(page, 'F5')).toHaveText('150') // 100 + 20 + 30
  })
})
