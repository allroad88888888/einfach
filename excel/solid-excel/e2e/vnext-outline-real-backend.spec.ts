import { expect, test, type Page } from '@playwright/test'

import { cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

/**
 * Outline grouping / collapse on the worker demos (#07, UI-core canonical).
 *
 * Runs against both real worker backends (`wasm` project → Rust workbook
 * worker, `ts` project → TS core worker) through the shared `vNext Worker`
 * demo. Visible-only evidence: the Data menu entries, the outline gutter
 * appearing once rows are grouped, the row-header sequence skipping the
 * collapsed band, and the restore on expand. Outline metadata and the
 * collapse-driven hidden rows are both UI-core canonical, so no backend
 * port is involved beyond the ordinary projection reads.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  // Seeded cross-sheet formula: proves the worker finished seeding.
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function rowHeader(page: Page, row: number) {
  return page.locator(`th.spreadsheet-grid-row-header[data-row="${row}"]`)
}

function rowHeaderLabels(page: Page) {
  return page.locator('th.spreadsheet-grid-row-header .spreadsheet-grid-header-label')
}

async function openDataMenu(page: Page) {
  await page.getByTestId('menu-bar-button-data').click()
  await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
}

test.describe('vNext outline grouping real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('group rows 2-4 via Data menu, collapse from the gutter, expand restores the band', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Baseline: no outline gutter before any grouping (layout unchanged).
    await expect(page.getByTestId('outline-row-levels')).toHaveCount(0)
    await expect(page.locator('.spreadsheet-grid-outline-row-cell')).toHaveCount(0)
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')

    // Select rows 2-4 (indices 1..3) via header click + shift-click.
    await rowHeader(page, 1).click()
    await rowHeader(page, 3).click({ modifiers: ['Shift'] })

    // Data → Group Rows.
    await openDataMenu(page)
    await page.getByTestId('menu-bar-item-data.groupRows').click()
    await expect(page.getByTestId('menu-bar-dropdown-data')).toHaveCount(0)

    // The gutter appears: level buttons plus a − toggle on summary row 5.
    await expect(page.getByTestId('outline-row-levels')).toBeVisible()
    await expect(page.getByTestId('outline-row-level-1')).toBeVisible()
    await expect(page.getByTestId('outline-row-level-2')).toBeVisible()
    const toggle = page.getByTestId('outline-row-toggle-1-3')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('data-collapsed', 'false')

    // Grouping alone hides nothing.
    await expect(rowHeaderLabels(page).nth(1)).toHaveText('2')
    const headerCountBefore = await page.locator('th.spreadsheet-grid-row-header').count()
    expect(headerCountBefore).toBeGreaterThan(0)

    // Collapse: rows 2-4 vanish, the header sequence jumps 1 → 5, the
    // toggle flips to +, and the window backfills to the same row count.
    await toggle.click()
    await expect(rowHeader(page, 1)).toHaveCount(0)
    await expect(rowHeader(page, 2)).toHaveCount(0)
    await expect(rowHeader(page, 3)).toHaveCount(0)
    await expect(rowHeaderLabels(page).first()).toHaveText('1')
    await expect(rowHeaderLabels(page).nth(1)).toHaveText('5')
    await expect(page.getByTestId('outline-row-toggle-1-3')).toHaveAttribute(
      'data-collapsed',
      'true',
    )
    await expect(page.locator('th.spreadsheet-grid-row-header')).toHaveCount(headerCountBefore)

    // One gesture = one local history entry of kind `outline`.
    await expect(page.getByTestId('history-timeline-entry-1')).toHaveAttribute(
      'data-kind',
      'outline',
    )
    await expect(page.getByTestId('history-timeline-entry-1')).toContainText('rev local')

    // Expand: the band and its data return.
    await page.getByTestId('outline-row-toggle-1-3').click()
    await expect(rowHeader(page, 1)).toBeVisible()
    await expect(rowHeaderLabels(page).nth(1)).toHaveText('2')
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(page.getByTestId('outline-row-toggle-1-3')).toHaveAttribute(
      'data-collapsed',
      'false',
    )
  })
})
