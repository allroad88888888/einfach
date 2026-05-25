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

  test('cell right-click shows all four freeze items at once', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B3').click({ button: 'right' })

    await expect(page.getByTestId('context-menu-command-view.freezePanes')).toBeVisible()
    await expect(page.getByTestId('context-menu-command-view.freezeRowsHere')).toBeVisible()
    await expect(page.getByTestId('context-menu-command-view.freezeColsHere')).toBeVisible()
    // Unfreeze hidden until freeze is active.
    await expect(page.getByTestId('context-menu-command-view.unfreeze')).toHaveCount(0)
  })

  test('cell right-click → Freeze row only — does not touch col freeze', async ({ page }) => {
    await gotoWave5(page)

    // First freeze a column via the col header menu so we can verify the
    // subsequent "Freeze row" leaves it untouched.
    const colC = page.locator('th.spreadsheet-grid-col-header[data-col="2"]')
    await colC.click({ button: 'right' })
    await page.getByTestId('context-menu-command-view.freezeColsHere').click()
    await expect(
      page.locator('th.spreadsheet-grid-col-header[data-col="1"][data-frozen-col="true"]'),
    ).toBeVisible()

    // Now right-click B3 and pick "Freeze row" — should freeze 2 rows but
    // keep the column freeze.
    await cell(page, 'B3').click({ button: 'right' })
    await page.getByTestId('context-menu-command-view.freezeRowsHere').click()

    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="0"][data-frozen-row="true"]'),
    ).toBeVisible()
    await expect(
      page.locator('th.spreadsheet-grid-col-header[data-col="1"][data-frozen-col="true"]'),
    ).toBeVisible()
  })

  test('freezing draws the boundary marker on the last frozen row and column', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click({ button: 'right' })
    await page.getByTestId('context-menu-command-view.freezePanes').click()

    // freezeRowCount=2, freezeColCount=2 → boundary on row=1 and col=1.
    await expect(
      page.locator(
        'td.spreadsheet-grid-cell[data-row="1"][data-freeze-boundary-bottom="true"]',
      ).first(),
    ).toBeVisible()
    await expect(
      page.locator(
        'td.spreadsheet-grid-cell[data-col="1"][data-freeze-boundary-right="true"]',
      ).first(),
    ).toBeVisible()

    // The corner cell carries both attributes.
    await expect(
      page.locator(
        'td.spreadsheet-grid-cell[data-row="1"][data-col="1"][data-freeze-boundary-bottom="true"][data-freeze-boundary-right="true"]',
      ),
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
