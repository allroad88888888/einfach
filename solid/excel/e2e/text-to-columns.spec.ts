import { test, expect, type Page } from '@playwright/test'

/**
 * Wave 7.1 — Text to Columns smoke.
 *
 * 1. Select a single source column.
 * 2. Open the dialog via a custom-event hook on `window` (the Wave 5
 *    demo omits the menubar; the menu-bar dispatch path is unit-tested
 *    elsewhere). Using a window event instead of a hidden DOM button
 *    avoids leaking a focusable / pointer-intercepting element into
 *    production.
 * 3. Pick delimited + comma, advance through the wizard, finish.
 * 4. Verify the resulting cells in the grid.
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  // Wait for the initial projection so cells are readable.
  await expect(
    page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="B2"] .cell-display`),
  ).toHaveText('120')
}

function cell(page: Page, addr: string) {
  return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
}

test.describe('text-to-columns — delimited comma split', () => {
  test('selecting a column, splitting on comma, finishing rewrites the cells', async ({
    page,
  }) => {
    await gotoWave5(page)

    // Seed a single comma-delimited cell in column G (row 2..3) — the
    // wave5 demo does not have CSV-like seed values out of the box, so
    // we type the values ourselves.
    await cell(page, 'G2').click()
    await page.keyboard.type('apple,banana,cherry')
    await page.keyboard.press('Enter')
    await page.keyboard.type('date,elder,fig')
    await page.keyboard.press('Enter')

    // Reselect the source column.
    await cell(page, 'G2').click()
    await cell(page, 'G3').click({ modifiers: ['Shift'] })

    // Open the dialog via the custom-event hook.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('spreadsheet:open-text-to-columns'))
    })
    const dialog = page.getByTestId('wave5-text-to-columns')
    await expect(dialog).toBeVisible()

    // Step 1 -> Step 2 (delimited is default).
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-2-delimited')).toBeVisible()

    // Switch from tab default to comma.
    await page.getByTestId('ttc-delim-tab').click()
    await page.getByTestId('ttc-delim-comma').click()

    // Step 2 -> Step 3.
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-3')).toBeVisible()

    // Finish.
    await page.getByTestId('ttc-finish-button').click()
    await expect(dialog).toHaveCount(0)

    // Verify the split landed in columns G, H, I across rows 2 and 3.
    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('apple')
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('banana')
    await expect(cell(page, 'I2').locator('.cell-display')).toHaveText('cherry')
    await expect(cell(page, 'G3').locator('.cell-display')).toHaveText('date')
    await expect(cell(page, 'H3').locator('.cell-display')).toHaveText('elder')
    await expect(cell(page, 'I3').locator('.cell-display')).toHaveText('fig')
  })
})
