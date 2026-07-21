import { expect, test, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

/**
 * Name Manager → Tables region row actions (parity #32, design §9).
 *
 * Runs on the Wave 5 static demo, whose backend implements the full Table
 * CRUD port family. The flow is the real user path end to end:
 *   create a table → reference it from a formula → rename it inline in the
 *   Name Manager → the listing re-reads from the engine and the structured
 *   reference keeps resolving → delete it behind the inline confirmation →
 *   the listing collapses to the empty state.
 */

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function dialog(page: Page) {
  return page.getByTestId('wave5-name-manager')
}

function tableRow(page: Page, name: string) {
  return dialog(page).locator(`[data-table-name="${name}"]`)
}

async function createTable(page: Page) {
  // A1:F4 = header row + three data rows in the Wave 5 seed sheet.
  await cell(page, 'A1').click()
  await cell(page, 'F4').click({ modifiers: ['Shift'] })
  await page.getByTestId('menu-bar-button-data').click()
  await page.getByTestId('menu-bar-item-data.createTable').click()
  await expect(page.getByTestId('menu-bar-create-table-status')).toHaveAttribute(
    'data-table-name',
    'Table1',
  )
}

async function openNameManager(page: Page) {
  await page.getByTestId('toolbar-btn-name-manager').click()
  await expect(dialog(page)).toBeVisible()
}

async function closeNameManager(page: Page) {
  await dialog(page).getByTestId('name-close-button').click()
  await expect(dialog(page)).toHaveCount(0)
}

test.describe('Name Manager — Excel Table row actions', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('renames a table inline; the listing and the structured reference follow', async ({
    page,
  }) => {
    await gotoWave5(page)
    await createTable(page)

    // A live structured reference into the table's Q1 column: 120+80+200.
    await cell(page, 'H2').click()
    await page.keyboard.type('=SUM(Table1[Q1])')
    await page.keyboard.press('Enter')
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('400')

    await openNameManager(page)
    await expect(tableRow(page, 'Table1')).toBeVisible()

    await tableRow(page, 'Table1').getByTestId('name-manager-table-rename').click()
    const input = dialog(page).getByTestId('name-manager-table-rename-input')
    await expect(input).toHaveValue('Table1')
    await input.fill('Revenue')
    await dialog(page).getByTestId('name-manager-table-rename-save').click()

    // Applied → the catalog is re-read from the engine, so the row re-labels
    // and the inline editor closes.
    await expect(tableRow(page, 'Revenue')).toBeVisible()
    await expect(tableRow(page, 'Table1')).toHaveCount(0)
    await expect(dialog(page).getByTestId('name-manager-table-rename-input')).toHaveCount(0)
    await expect(dialog(page).getByTestId('name-manager-tables-error')).toHaveCount(0)

    await closeNameManager(page)
    // The engine rewrote `Table1[Q1]` → `Revenue[Q1]`, so the value survives.
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('400')
  })

  test('a conflicting rename is rejected with a diagnostic and keeps the row', async ({ page }) => {
    await gotoWave5(page)
    await createTable(page)
    await openNameManager(page)

    await tableRow(page, 'Table1').getByTestId('name-manager-table-rename').click()
    // `Q1` parses as an in-grid cell address — pre-validated in UI core.
    await dialog(page).getByTestId('name-manager-table-rename-input').fill('Q1')
    await dialog(page).getByTestId('name-manager-table-rename-save').click()

    const error = dialog(page).getByTestId('name-manager-tables-error')
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('data-table-diagnostic-code', 'name-like-cell-ref')
    // Rejected → the row keeps its name and the editor stays open with the draft.
    await expect(tableRow(page, 'Table1')).toBeVisible()
    await expect(dialog(page).getByTestId('name-manager-table-rename-input')).toHaveValue('Q1')
  })

  test('deletes a table only after the inline confirmation', async ({ page }) => {
    await gotoWave5(page)
    await createTable(page)
    await openNameManager(page)

    await tableRow(page, 'Table1').getByTestId('name-manager-table-delete').click()
    // Armed, not sent: the table is still listed.
    await expect(dialog(page).getByTestId('name-manager-table-delete-prompt')).toContainText(
      'Table1',
    )
    await expect(tableRow(page, 'Table1')).toBeVisible()

    await dialog(page).getByTestId('name-manager-table-delete-cancel').click()
    await expect(dialog(page).getByTestId('name-manager-table-delete-prompt')).toHaveCount(0)
    await expect(tableRow(page, 'Table1')).toBeVisible()

    await tableRow(page, 'Table1').getByTestId('name-manager-table-delete').click()
    await dialog(page).getByTestId('name-manager-table-delete-confirm').click()

    await expect(tableRow(page, 'Table1')).toHaveCount(0)
    await expect(dialog(page).getByTestId('name-manager-tables-empty')).toBeVisible()
  })
})
