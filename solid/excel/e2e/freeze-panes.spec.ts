import { expect, test, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

test.describe('Wave 5 — Freeze rows/cols via context menu', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('right-click a row header → "Freeze N rows above" pins those rows on scroll', async ({
    page,
  }) => {
    await gotoWave5(page)

    // Right-click row 3's header (rowIndex=2 because data-row uses 0-based).
    const row3Header = page.locator('th.spreadsheet-grid-row-header[data-row="2"]')
    await row3Header.click({ button: 'right' })

    const freezeItem = page.getByTestId('context-menu-command-view.freezeRowsHere')
    await expect(freezeItem).toBeVisible()
    await freezeItem.click()

    // After freezing, rows 0..1 should carry data-frozen-row="true".
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="0"][data-frozen-row="true"]'),
    ).toBeVisible()
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="1"][data-frozen-row="true"]'),
    ).toBeVisible()
    // Row 2 (the clicked one) is the first scrollable row, NOT frozen.
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="2"][data-frozen-row]'),
    ).toHaveCount(0)

    // Cells in the frozen rows should be marked too.
    await expect(page.locator('td.spreadsheet-grid-cell[data-row="0"][data-frozen-row="true"]').first()).toBeVisible()
  })

  test('right-click a column header → "Freeze N cols to left" pins those cols', async ({
    page,
  }) => {
    await gotoWave5(page)

    // Column B is at data-col="1"; right-click it to freeze column 0 only.
    const colB = page.locator('th.spreadsheet-grid-col-header[data-col="1"]')
    await colB.click({ button: 'right' })

    const freezeItem = page.getByTestId('context-menu-command-view.freezeColsHere')
    await expect(freezeItem).toBeVisible()
    await freezeItem.click()

    await expect(
      page.locator('th.spreadsheet-grid-col-header[data-col="0"][data-frozen-col="true"]'),
    ).toBeVisible()
    await expect(
      page.locator('th.spreadsheet-grid-col-header[data-col="1"][data-frozen-col]'),
    ).toHaveCount(0)
  })

  test('right-click a cell → "Freeze panes" pins both above and left', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B3').click({ button: 'right' })

    const freezeItem = page.getByTestId('context-menu-command-view.freezePanes')
    await expect(freezeItem).toBeVisible()
    await freezeItem.click()

    // B3 → row=2 col=1 → freeze rows 0..1, cols 0..0.
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="0"][data-frozen-row="true"]'),
    ).toBeVisible()
    await expect(
      page.locator('th.spreadsheet-grid-col-header[data-col="0"][data-frozen-col="true"]'),
    ).toBeVisible()
  })

  test('Unfreeze clears both axes', async ({ page }) => {
    await gotoWave5(page)

    // Freeze first.
    const row3Header = page.locator('th.spreadsheet-grid-row-header[data-row="2"]')
    await row3Header.click({ button: 'right' })
    await page.getByTestId('context-menu-command-view.freezeRowsHere').click()
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="0"][data-frozen-row="true"]'),
    ).toBeVisible()

    // Now unfreeze via row header right-click.
    await row3Header.click({ button: 'right' })
    const unfreeze = page.getByTestId('context-menu-command-view.unfreeze')
    await expect(unfreeze).toBeVisible()
    await unfreeze.click()

    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-frozen-row="true"]'),
    ).toHaveCount(0)
  })
})
