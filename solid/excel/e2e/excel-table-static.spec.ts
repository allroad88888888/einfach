import { test, expect, type Page } from '@playwright/test'

/**
 * Static Wave 5 demo — Excel Table create flow (parity #32,
 * design-excel-table.md §9). The Wave 5 demo runs on the static backend,
 * which now implements the Table CRUD ports, so:
 *   - Data → Create table appears (capability witness true),
 *   - creating over the selection publishes the engine-assigned name in the
 *     menu status row (visible success witness),
 *   - a structured reference `=SUM(Table1[Q1])` resolves through the static
 *     evaluator to the real column sum.
 */
test.describe('vNext Wave 5 — static Excel Table create', () => {
  async function gotoWave5(page: Page) {
    await page.goto('/')
    await page.getByTestId('nav-tab-vnext-wave5').click()
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  }

  function cell(page: Page, addr: string) {
    return page
      .locator('[data-testid="wave5-grid"]')
      .locator(`td.cell[data-cell-addr="${addr}"]`)
  }

  async function selectHeaderPlusData(page: Page) {
    // A1:F4 = header row (Region, Q1..Total) + three data rows (North/South/East).
    await cell(page, 'A1').click()
    await cell(page, 'F4').click({ modifiers: ['Shift'] })
  }

  async function createTableFromMenu(page: Page) {
    await page.getByTestId('menu-bar-button-data').click()
    await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
    const item = page.getByTestId('menu-bar-item-data.createTable')
    await expect(item).toBeVisible()
    await item.click()
  }

  test('Data menu exposes Create table on the static backend', async ({ page }) => {
    await gotoWave5(page)
    await page.getByTestId('menu-bar-button-data').click()
    await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
    // Capability-gated entry: present because static implements createTable.
    await expect(page.getByTestId('menu-bar-item-data.createTable')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('create over the selection publishes the engine-assigned table name', async ({ page }) => {
    await gotoWave5(page)
    await selectHeaderPlusData(page)
    await createTableFromMenu(page)

    const status = page.getByTestId('menu-bar-create-table-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveAttribute('data-table-name', 'Table1')
    // No rejection diagnostic on a valid selection.
    await expect(page.getByTestId('menu-bar-create-table-error')).toHaveCount(0)
  })

  test('a structured reference resolves to the column sum after create', async ({ page }) => {
    await gotoWave5(page)
    await selectHeaderPlusData(page)
    await createTableFromMenu(page)
    await expect(page.getByTestId('menu-bar-create-table-status')).toHaveAttribute(
      'data-table-name',
      'Table1',
    )

    // Type a structured-reference aggregation into an empty cell (H2).
    const target = cell(page, 'H2')
    await target.click()
    await page.keyboard.type('=SUM(Table1[Q1])')
    await page.keyboard.press('Enter')

    // Q1 data rows: 120 + 80 + 200 = 400.
    await expect(target.locator('.cell-display')).toHaveText('400')
  })

  test('an invalid selection surfaces a structured diagnostic, not a table', async ({ page }) => {
    await gotoWave5(page)
    // Single cell: no data row → create-table is rejected locally (invalid-selection).
    await cell(page, 'A1').click()
    await createTableFromMenu(page)

    const error = page.getByTestId('menu-bar-create-table-error')
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('data-table-diagnostic-code', 'invalid-selection')
    await expect(page.getByTestId('menu-bar-create-table-status')).toHaveCount(0)
  })
})
