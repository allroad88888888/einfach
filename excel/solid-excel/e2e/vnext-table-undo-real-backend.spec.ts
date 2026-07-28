import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * Excel Table DEFINITION undo end to end on the vNext Worker WASM demo
 * (design-excel-table.md §11/§12, parity #25) — real-backend evidence that a
 * Ctrl+Z after a table-definition change replays the engine registry AND the
 * cells that encode it as ONE transaction.
 *
 * Flow:
 *   1. Seed an Item/Qty block and create a table over it, plus a formula that
 *      only resolves while the table exists.
 *   2. Ctrl+Z → the table is gone and the structured-reference formula falls
 *      back to `#NAME?`.
 *   3. Re-create, toggle the totals row on, Ctrl+Z → the totals row AND the
 *      `SUBTOTAL` cell the toggle wrote disappear together (the half-state
 *      this transaction exists to prevent).
 *
 * WASM-only: the TS worker declares `structuredTables: false` (fail-closed),
 * so the Data-menu table entries hide on the `ts` project.
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

async function createTableOverSelection(page: Page) {
  await page.getByTestId('menu-bar-button-data').click()
  await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
  await page.getByTestId('menu-bar-item-data.createTable').click()
  await expect(page.getByTestId('menu-bar-create-table-status')).toHaveText('Table1')
}

/** Click into the grid so the wrapper holds focus, then fire the shortcut. */
async function undo(page: Page) {
  await cell(page, 'A1').click()
  await page.keyboard.press(`${META}+z`)
}

test.describe('vNext Excel Table definition undo — real WASM backend', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('Ctrl+Z after create table drops the table and the structured formula falls back', async ({
    page,
  }) => {
    test.skip(
      !activeProjectIsWasm(),
      'Excel Tables are WASM-only (TS worker declares structuredTables:false)',
    )
    await gotoWorkerDemo(page)
    await seedTableRegion(page)
    // A structured reference that only resolves while Table1 exists.
    await typeIntoCell(page, 'H1', '=SUM(Table1[Qty])')
    await expect(cellDisplay(page, 'H1')).toHaveText('#NAME?')

    await selectRange(page, 'E1:F4')
    await createTableOverSelection(page)
    await expect(cellDisplay(page, 'H1')).toHaveText('60')

    await undo(page)

    // The registry entry is gone AND the formula re-derived against it.
    await expect(cellDisplay(page, 'H1')).toHaveText('#NAME?')
  })

  test('Ctrl+Z after toggling the totals row removes the row AND its SUBTOTAL cell', async ({
    page,
  }) => {
    test.skip(
      !activeProjectIsWasm(),
      'Excel Tables are WASM-only (TS worker declares structuredTables:false)',
    )
    await gotoWorkerDemo(page)
    await seedTableRegion(page)
    await selectRange(page, 'E1:F4')
    await createTableOverSelection(page)

    await selectRange(page, 'E2')
    await page.getByTestId('menu-bar-button-data').click()
    const totalsItem = page.getByTestId('menu-bar-item-data.toggleTotals')
    await expect(totalsItem).toBeVisible()
    await totalsItem.click()
    await expect(page.getByTestId('menu-bar-toggle-totals-status')).toHaveAttribute(
      'data-has-totals',
      'true',
    )
    await expect(cellDisplay(page, 'F5')).toHaveText('60')

    await undo(page)

    // Registry geometry and the written SUBTOTAL cell roll back TOGETHER —
    // never a totals cell left under a table that no longer has a totals row.
    await expect(cellDisplay(page, 'F5')).toHaveText('')
  })
})
