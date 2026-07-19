import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  cellInput,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
} from './helpers'

/**
 * Filter on the worker demos (worker adapter serves filter/sort
 * projections, phase 2/3).
 *
 * The toolbar filter button is enabled on both worker backends. Applying
 * an equals rule compresses the visible rows to the matching source rows,
 * clearing the rule restores them, and editing a display row while the
 * filter is active writes through the W2 mutation gateway to the source
 * row. Seeded sheet1 column A: A1 'Sheet1' (header row), A2 'cell1',
 * A4 'cell4'; row 4 also holds B4=10, C4='source'.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function filterDropdown(page: Page) {
  return page.getByTestId('vnext-worker-filter-dropdown')
}

async function applyEqualsFilterOnColumnA(page: Page, value: string) {
  await page.locator('th.spreadsheet-grid-col-header[data-col="0"]').click()
  const filterButton = page.getByTestId('toolbar-btn-filter')
  await expect(filterButton).toBeEnabled()
  await filterButton.click()
  await expect(filterDropdown(page)).toBeVisible()
  // The condition section boots on "none"; pick equals to mount its input.
  await page.getByTestId('filter-condition-kind').selectOption('equals')
  await page.getByTestId('filter-equals-input').fill(value)
  await page.getByTestId('filter-add-equals').click()
}

test.describe('vNext filter real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('equals rule hides non-matching rows and clearing the rule restores them', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Baseline seeded values on source rows 2 and 4.
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')

    await applyEqualsFilterOnColumnA(page, 'cell4')

    // Display compresses: the first data row now shows source row 4.
    await expect(cellDisplay(page, 'A2')).toHaveText('cell4')
    await expect(cellDisplay(page, 'B2')).toHaveText('10')
    await expect(cellDisplay(page, 'C2')).toHaveText('source')
    // The next display row is blank — 'cell1' is filtered out entirely.
    await expect(cellDisplay(page, 'A3')).toHaveText('')

    // The filtered column carries its chevron affordance.
    await expect(page.getByTestId('filter-chevron-0')).toBeVisible()

    // Clearing the rule restores the source layout.
    await page.getByTestId('filter-clear-filter').click()
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')

    await page.getByTestId('filter-close').click()
    await expect(filterDropdown(page)).toBeHidden()
  })

  test('editing a display row under an active filter writes to the source row', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    await applyEqualsFilterOnColumnA(page, 'cell4')
    await expect(cellDisplay(page, 'A2')).toHaveText('cell4')
    await page.getByTestId('filter-close').click()
    await expect(filterDropdown(page)).toBeHidden()

    // Display row 2 is source row 4 → the edit must land on D4.
    await cell(page, 'D2').dblclick()
    const editor = cellInput(page, 'D2')
    await expect(editor).toBeVisible()
    await editor.fill('via-filter')
    await editor.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect(cellDisplay(page, 'D2')).toHaveText('via-filter')

    // Clear the filter through the column chevron.
    await page.getByTestId('filter-chevron-0').click()
    await expect(filterDropdown(page)).toBeVisible()
    await page.getByTestId('filter-clear-filter').click()
    await page.getByTestId('filter-close').click()

    // The value lives on the source row, not the display row.
    await expect(cellDisplay(page, 'D4')).toHaveText('via-filter')
    await expect(cellDisplay(page, 'D2')).toHaveText('')
  })
})
