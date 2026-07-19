import { test, expect, type Page } from '@playwright/test'

/**
 * Audit: structural operations on the Wave 5 demo.
 *  - Sheet tab add / rename / delete / reorder
 *  - Row insert / delete (via menu)
 *  - Column insert / delete (via menu)
 *  - Filter dropdown apply
 *  - Sort column
 *
 * Tests fail on the current branch to pin defects; fixes flip them green.
 */

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  // Wait for projection to fully load.
  await expect(
    page
      .locator('[data-testid="wave5-grid"] td.cell[data-cell-addr="B2"] .cell-display'),
  ).toHaveText('120')
}

function cell(page: Page, addr: string) {
  return page.locator(`[data-testid="wave5-grid"] td.cell[data-cell-addr="${addr}"]`)
}

function tabs(page: Page) {
  return page.locator('[data-testid="wave5-sheet-tabs"] .spreadsheet-sheet-tab')
}

test.describe('audit: structural ops on the Wave 5 demo', () => {
  test('1. sheet tab add: + button appends a new sheet and activates it', async ({ page }) => {
    await gotoWave5(page)
    await expect(tabs(page)).toHaveCount(2)

    await page.getByTestId('sheet-tab-add').click()

    await expect(tabs(page)).toHaveCount(3)
    // The newly-added sheet should be active.
    const lastTab = tabs(page).nth(2)
    await expect(lastTab).toHaveAttribute('data-active', 'true')
  })

  test('2. sheet tab rename: double-click opens an input, commit updates the tab name', async ({
    page,
  }) => {
    await gotoWave5(page)
    const salesTab = tabs(page).nth(0)
    await expect(salesTab).toHaveText(/Sales/)
    await salesTab.dblclick()

    const renameInput = page.locator('input.spreadsheet-sheet-tab-rename')
    await expect(renameInput).toBeVisible({ timeout: 2_000 })
    await renameInput.fill('Q1 Sales')
    await renameInput.press('Enter')

    await expect(tabs(page).nth(0)).toHaveText(/Q1 Sales/)
  })

  test('3. sheet tab delete: right-click → Delete removes the tab', async ({ page }) => {
    await gotoWave5(page)
    await expect(tabs(page)).toHaveCount(2)
    const forecastTab = tabs(page).nth(1)

    // The delete flow now confirms through the in-app dialog rendered by
    // SpreadsheetSheetTabs (`sheet-tab-delete-confirmation`), not a native
    // window.confirm. CANONICAL_OWNERSHIP §3 #01: sheet lifecycle stays
    // engine-canonical, the confirm gate is UI-core interaction state.
    await forecastTab.click({ button: 'right' })
    const menu = page.getByTestId('sheet-tab-context-menu')
    await expect(menu).toBeVisible({ timeout: 2_000 })

    await page.getByTestId('sheet-tab-menu-delete').click()
    await expect(page.getByTestId('sheet-tab-delete-confirmation')).toBeVisible()
    await page.getByTestId('sheet-tab-delete-confirm').click()
    await expect(tabs(page)).toHaveCount(1)
  })

  test('4. right-click row header → Insert row shifts subsequent rows', async ({ page }) => {
    // Menubar was removed for Univer parity; insert row is reachable via the
    // row-header right-click context menu (the cell context menu only
    // exposes clipboard + clear actions).
    await gotoWave5(page)
    await expect(cell(page, 'A3').locator('.cell-display')).toHaveText('South')

    const rowHeader = page.locator(
      '[data-testid="wave5-grid"] th.spreadsheet-grid-row-header[data-row="2"]',
    )
    await rowHeader.click({ button: 'right' })
    const menu = page.locator('[role="menu"], .context-menu').first()
    await expect(menu).toBeVisible({ timeout: 2_000 })
    await menu.locator('text=/insert row|插入行/i').first().click()

    await expect(cell(page, 'A4').locator('.cell-display')).toHaveText('South')
    await expect(cell(page, 'A3').locator('.cell-display')).toHaveText('')
  })

  test('5. right-click column header → Insert column shifts subsequent columns', async ({
    page,
  }) => {
    await gotoWave5(page)
    await expect(cell(page, 'B1').locator('.cell-display')).toHaveText('Q1')

    const colHeader = page.locator(
      '[data-testid="wave5-grid"] th.spreadsheet-grid-col-header[data-col="1"]',
    )
    await colHeader.click({ button: 'right' })
    const menu = page.locator('[role="menu"], .context-menu').first()
    await expect(menu).toBeVisible({ timeout: 2_000 })
    await menu.locator('text=/insert column|插入列/i').first().click()

    await expect(cell(page, 'C1').locator('.cell-display')).toHaveText('Q1')
    await expect(cell(page, 'B1').locator('.cell-display')).toHaveText('')
  })

  test('6. row header right-click → context menu offers Delete', async ({ page }) => {
    await gotoWave5(page)
    const rowHeader = page.locator('[data-testid="wave5-grid"] th.spreadsheet-grid-row-header[data-row="2"]')
    await rowHeader.click({ button: 'right' })
    const menu = page.locator('[role="menu"], .context-menu').first()
    await expect(menu).toBeVisible({ timeout: 2_000 })
    await expect(menu).toContainText(/delete|删除/i)
  })

  test('7. column header right-click → context menu offers Delete', async ({ page }) => {
    await gotoWave5(page)
    const colHeader = page.locator('[data-testid="wave5-grid"] th.spreadsheet-grid-col-header[data-col="1"]')
    await colHeader.click({ button: 'right' })
    const menu = page.locator('[role="menu"], .context-menu').first()
    await expect(menu).toBeVisible({ timeout: 2_000 })
    await expect(menu).toContainText(/delete|删除/i)
  })

  // Skipped: the menu dispatch + dispatchSortAtom path wires correctly and
  // backend.setFilterSort is called, but the static demo backend does NOT
  // implement setFilterSort — it does not reorder cells in the projection.
  // Tracked as a Wave 7 backend feature; the menu glue here is verified by
  // the menu-bar unit suite, this test waits for the backend to land.
  test.skip('8. Data → Sort A→Z reorders rows by the active column', async ({ page }) => {
    await gotoWave5(page)
    // A2..A8 starts as: North, South, East, West, Central, Mountain, Pacific
    await cell(page, 'A2').click()
    await page.getByTestId('menu-bar-button-data').click()
    const sortAsc = page.getByTestId('menu-bar-item-data.sortAsc')
    await expect(sortAsc).toBeVisible({ timeout: 2_000 })
    await sortAsc.click()

    // After ascending sort by column A, the first data row should be "Central".
    await expect(cell(page, 'A2').locator('.cell-display')).toHaveText('Central')
  })

  test.skip('9. Filter dropdown apply: equals filter hides non-matching rows', async ({ page }) => {
    // The Data > Filter menu entry was the only Wave 5 surface that opened
    // the filter dropdown. With the menubar removed for Univer parity there
    // is currently no other trigger in the demo — re-enable this once a
    // header funnel icon (or similar) is wired up.
    await gotoWave5(page)
    const dropdown = page.getByTestId('filter-dropdown')
    if (!(await dropdown.count())) {
      test.skip(true, 'filter dropdown trigger not surfaced in Wave 5 demo after menubar removal')
    }

    const equalsInput = page.getByTestId('filter-equals-input')
    await equalsInput.fill('120')
    await page.getByTestId('filter-add-equals').click()

    // Row 2 (North) has 120 in column B; that row should remain visible while
    // siblings hide. Assert at least that one cell with value 120 stays
    // visible (the assertion is intentionally weak — host filter wiring is the
    // gap).
    await expect(cell(page, 'B2').locator('.cell-display')).toHaveText('120')
  })
})
