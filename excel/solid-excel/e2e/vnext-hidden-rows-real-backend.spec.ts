import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

/**
 * Hidden rows on the worker demos (UI-core canonical, phase 2/3).
 *
 * Right-clicking a row header offers "Hide row"; the hidden row vanishes
 * from the visible window (the header sequence skips its number and the
 * window backfills with the next row), and undo restores both the row and
 * its data. Runs against both real worker backends via the shared demo.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function rowHeader(page: Page, row: number) {
  return page.locator(`th.spreadsheet-grid-row-header[data-row="${row}"]`)
}

function rowHeaderLabels(page: Page) {
  return page.locator('th.spreadsheet-grid-row-header .spreadsheet-grid-header-label')
}

test.describe('vNext hidden rows real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('row header context menu hides row 2, headers skip its number, undo restores the data', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Baseline: row 2 holds seeded data and the window renders 20 rows.
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(rowHeaderLabels(page).first()).toHaveText('1')
    await expect(rowHeaderLabels(page).nth(1)).toHaveText('2')

    const headerCountBefore = await page.locator('th.spreadsheet-grid-row-header').count()
    expect(headerCountBefore).toBeGreaterThan(0)

    // Hide row 2 via the row-header context menu.
    await rowHeader(page, 1).click({ button: 'right' })
    const hideItem = page.getByTestId('context-menu-command-row.hide')
    await expect(hideItem).toBeVisible()
    await hideItem.click()

    // The row disappears: header "2" gone, sequence skips to 3, A2 unmounts.
    await expect(rowHeader(page, 1)).toHaveCount(0)
    await expect(rowHeaderLabels(page).first()).toHaveText('1')
    await expect(rowHeaderLabels(page).nth(1)).toHaveText('3')
    await expect(cell(page, 'A2')).toHaveCount(0)

    // The visible window backfills: the same number of rows stays rendered.
    await expect(page.locator('th.spreadsheet-grid-row-header')).toHaveCount(headerCountBefore)

    // Hidden state is UI-core canonical → local history entry.
    await expect(page.getByTestId('history-timeline-entry-0')).toHaveAttribute(
      'data-kind',
      'viewport.hidden',
    )
    await expect(page.getByTestId('history-timeline-entry-0')).toContainText('rev local')

    // Undo restores the row and its data.
    await page.getByTestId('history-timeline-undo').click()
    await expect(rowHeader(page, 1)).toBeVisible()
    await expect(rowHeaderLabels(page).nth(1)).toHaveText('2')
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(cellDisplay(page, 'B2')).toHaveText('result')
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('0 / 1')
  })
})
