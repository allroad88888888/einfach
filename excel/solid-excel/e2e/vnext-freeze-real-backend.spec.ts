import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

/**
 * Freeze panes on the worker demos (UI-core canonical, phase 2/3).
 *
 * Runs against both real worker backends (`wasm` project → Rust workbook
 * worker, `ts` project → TS core worker) through the shared `vNext Worker`
 * demo. Visible-only: menu items, the SVG freeze boundary, frozen header
 * markers, and the history timeline text are the asserted facts.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  // Seeded cross-sheet formula: proves the worker finished seeding.
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function openViewMenu(page: Page) {
  await page.getByTestId('menu-bar-button-view').click()
  await expect(page.getByTestId('menu-bar-dropdown-view')).toBeVisible()
}

test.describe('vNext freeze panes real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('view menu freeze draws the split lines and undo removes them (local history entry)', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // No freeze at boot.
    await expect(page.getByTestId('freeze-boundary')).toHaveCount(0)
    await expect(page.getByTestId('history-timeline-empty')).toBeVisible()

    // Freeze at B3 → rows 0..1 and col 0 frozen (freeze uses the active cell).
    await cell(page, 'B3').click()
    await expect(cell(page, 'B3')).toHaveAttribute('data-active', 'true')
    await openViewMenu(page)
    await page.getByTestId('menu-bar-item-view.freeze').click()
    await expect(page.getByTestId('menu-bar-dropdown-view')).toHaveCount(0)

    // Visible split lines: one horizontal + one vertical boundary line.
    await expect(page.getByTestId('freeze-boundary')).toBeVisible()
    await expect(page.getByTestId('freeze-boundary-horizontal')).toHaveCount(1)
    await expect(page.getByTestId('freeze-boundary-vertical')).toHaveCount(1)

    // Frozen band markers on the headers: rows 1-2 frozen, row 3 not.
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="0"][data-frozen-row="true"]'),
    ).toBeVisible()
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="1"][data-frozen-row="true"]'),
    ).toBeVisible()
    await expect(
      page.locator('th.spreadsheet-grid-row-header[data-row="2"][data-frozen-row]'),
    ).toHaveCount(0)
    await expect(
      page.locator('th.spreadsheet-grid-col-header[data-col="0"][data-frozen-col="true"]'),
    ).toBeVisible()

    // Freeze is UI-core canonical → the history entry is a local entry.
    await expect(page.getByTestId('history-timeline-entry-0')).toHaveAttribute(
      'data-kind',
      'viewport.freeze',
    )
    await expect(page.getByTestId('history-timeline-entry-0')).toContainText('rev local')
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('1 / 1')

    // Undo removes the freeze again.
    await page.getByTestId('history-timeline-undo').click()
    await expect(page.getByTestId('freeze-boundary')).toHaveCount(0)
    await expect(page.locator('th.spreadsheet-grid-row-header[data-frozen-row]')).toHaveCount(0)
    await expect(page.locator('th.spreadsheet-grid-col-header[data-frozen-col]')).toHaveCount(0)
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('0 / 1')
  })

  test('view menu unfreeze clears an active freeze', async ({ page }) => {
    await gotoWorkerDemo(page)

    await cell(page, 'B3').click()
    await openViewMenu(page)
    await page.getByTestId('menu-bar-item-view.freeze').click()
    await expect(page.getByTestId('freeze-boundary')).toBeVisible()

    await openViewMenu(page)
    await page.getByTestId('menu-bar-item-view.unfreeze').click()
    await expect(page.getByTestId('freeze-boundary')).toHaveCount(0)

    // Both commands are local history entries.
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('2 / 2')
    await expect(page.getByTestId('history-timeline-entry-1')).toHaveAttribute(
      'data-kind',
      'viewport.freeze',
    )
    await expect(page.getByTestId('history-timeline-entry-1')).toContainText('rev local')
  })
})
