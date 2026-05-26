import { test, expect, type Page } from '@playwright/test'

/**
 * Wave 7.1 — Text to Columns smoke + Wave 7/8 regression coverage.
 *
 * Existing tests:
 *   1. 3-step delimited wizard end-to-end (canonical pattern below).
 *
 * Wave 7/8 added tests (this spec):
 *   - text qualifier semantics (P1 #1)
 *   - doubled-quote escape
 *   - date format disabled with tooltip (P2 #4)
 *   - empty delimiter Next disabled (P3 #6)
 *   - fixed-width mode end-to-end
 *   - preview token cap (P2 #5)
 *
 * Pattern: the Wave 5 demo omits the menubar; the production code path is
 * exercised via the menu-bar dispatch unit test. Here we use a window
 * CustomEvent (`spreadsheet:open-text-to-columns`) that the demo wires to
 * its `triggerTextToColumnsForSelection` helper.
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function gotoWave5(page: Page) {
  await page.goto('/?locale=en')
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

async function seedCellValue(page: Page, addr: string, value: string) {
  await cell(page, addr).click()
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

async function openTextToColumnsForSelection(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('spreadsheet:open-text-to-columns'))
  })
  const dialog = page.getByTestId('wave5-text-to-columns')
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('text-to-columns — delimited comma split', () => {
  test('selecting a column, splitting on comma, finishing rewrites the cells', async ({
    page,
  }) => {
    await gotoWave5(page)

    // Seed a single comma-delimited cell in column G (row 2..3).
    await cell(page, 'G2').click()
    await page.keyboard.type('apple,banana,cherry')
    await page.keyboard.press('Enter')
    await page.keyboard.type('date,elder,fig')
    await page.keyboard.press('Enter')

    // Reselect the source column.
    await cell(page, 'G2').click()
    await cell(page, 'G3').click({ modifiers: ['Shift'] })

    const dialog = await openTextToColumnsForSelection(page)

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

test.describe('text-to-columns — text qualifier semantics (P1 #1)', () => {
  test('qualifier groups inner-quote contents into one token, not three', async ({
    page,
  }) => {
    await gotoWave5(page)

    // `foo"bar",x` — with `"` as the qualifier the leading bare `foo"`
    // should NOT start an open-quote run; the parser must treat the inner
    // `"`s as ordinary characters because they don't bracket a token.
    // Expected: TWO output cells (`foo"bar"`, `x`), NOT three pieces
    // from a greedy quote toggle.
    await seedCellValue(page, 'G2', 'foo"bar",x')

    await cell(page, 'G2').click()
    const dialog = await openTextToColumnsForSelection(page)

    // Step 1 -> Step 2.
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-2-delimited')).toBeVisible()

    // Switch from tab default to comma + verify qualifier is `"` (default).
    await page.getByTestId('ttc-delim-tab').click()
    await page.getByTestId('ttc-delim-comma').click()
    await expect(page.getByTestId('ttc-qualifier')).toHaveValue('"')

    // Step 2 -> Step 3, finish.
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-3')).toBeVisible()
    await page.getByTestId('ttc-finish-button').click()
    await expect(dialog).toHaveCount(0)

    // TWO cells: `foo"bar"` and `x`.
    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('foo"bar"')
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('x')
  })
})

test.describe('text-to-columns — doubled-quote escape', () => {
  test('a quoted token containing "" emits one literal inner quote', async ({ page }) => {
    await gotoWave5(page)

    // `"foo""bar",x` — qualifier `"` opens at the first `"`, the doubled
    // `""` is the standard CSV escape for a literal `"`, and the closing
    // `"` ends the token before the comma. Expected cells:
    //   G2 = `foo"bar`
    //   H2 = `x`
    await seedCellValue(page, 'G2', '"foo""bar",x')

    await cell(page, 'G2').click()
    const dialog = await openTextToColumnsForSelection(page)

    await page.getByTestId('ttc-next-button').click()
    await page.getByTestId('ttc-delim-tab').click()
    await page.getByTestId('ttc-delim-comma').click()
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-3')).toBeVisible()
    await page.getByTestId('ttc-finish-button').click()
    await expect(dialog).toHaveCount(0)

    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('foo"bar')
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('x')
  })
})

test.describe('text-to-columns — date format disabled with tooltip (P2 #4)', () => {
  test('Step 3 Date <option> is disabled and carries the i18n tooltip', async ({ page }) => {
    await gotoWave5(page)
    await seedCellValue(page, 'G2', 'alpha,beta,gamma')

    await cell(page, 'G2').click()
    const dialog = await openTextToColumnsForSelection(page)

    await page.getByTestId('ttc-next-button').click()
    await page.getByTestId('ttc-delim-tab').click()
    await page.getByTestId('ttc-delim-comma').click()
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-3')).toBeVisible()

    // Date option on the first output column should be disabled.
    const dateOption = page.getByTestId('ttc-format-0-date')
    // <option disabled> renders the boolean attribute; assert presence.
    const disabled = await dateOption.getAttribute('disabled')
    expect(disabled).not.toBeNull()
    const title = await dateOption.getAttribute('title')
    expect(title).toBeTruthy()
    // Match the i18n value (English locale).
    expect(title).toContain('Date format is not yet supported')

    // Clean up so we don't leak a step-3 wizard into other tests.
    await page.getByTestId('ttc-cancel-button').click()
    await expect(dialog).toHaveCount(0)
  })
})

test.describe('text-to-columns — empty delimiter Next disabled (P3 #6)', () => {
  test('unchecking every delimiter disables Next and surfaces the hint', async ({
    page,
  }) => {
    await gotoWave5(page)
    await seedCellValue(page, 'G2', 'one,two,three')

    await cell(page, 'G2').click()
    await openTextToColumnsForSelection(page)

    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-2-delimited')).toBeVisible()

    // Tab is checked by default in DEFAULT_DELIMITED_CONFIG — uncheck it.
    const tab = page.getByTestId('ttc-delim-tab')
    await expect(tab).toBeChecked()
    await tab.click()
    await expect(tab).not.toBeChecked()

    // Next is now disabled, hint matches the i18n key.
    const next = page.getByTestId('ttc-next-button')
    await expect(next).toBeDisabled()
    const hint = page.getByTestId('ttc-next-disabled-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toHaveText('Pick at least one delimiter to continue.')
  })
})

test.describe('text-to-columns — fixed-width mode', () => {
  test('fixed-width with breakpoints 3,7 splits at those character offsets', async ({
    page,
  }) => {
    await gotoWave5(page)
    // 12 chars: "abcDEFGhijkl" — breakpoints at 3 and 7 give
    //   col 0: "abc"   (chars 0..2)
    //   col 1: "DEFG"  (chars 3..6)
    //   col 2: "hijkl" (chars 7..11)
    await seedCellValue(page, 'G2', 'abcDEFGhijkl')

    await cell(page, 'G2').click()
    const dialog = await openTextToColumnsForSelection(page)

    // Step 1 — pick fixed width.
    await page.getByTestId('ttc-mode-fixed').click()
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-2-fixed')).toBeVisible()

    // Step 2 — enter breakpoints.
    await page.getByTestId('ttc-breakpoints').fill('3,7')

    // Preview row 1 should now show 3 tokens.
    await expect(page.getByTestId('ttc-preview-cell-1-0')).toHaveText('abc')
    await expect(page.getByTestId('ttc-preview-cell-1-1')).toHaveText('DEFG')
    await expect(page.getByTestId('ttc-preview-cell-1-2')).toHaveText('hijkl')

    // Advance + finish.
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-3')).toBeVisible()
    await page.getByTestId('ttc-finish-button').click()
    await expect(dialog).toHaveCount(0)

    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('abc')
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('DEFG')
    await expect(cell(page, 'I2').locator('.cell-display')).toHaveText('hijkl')
  })
})

test.describe('text-to-columns — preview token cap (P2 #5 regression)', () => {
  test('a 600-token row clamps at 500 tokens with a `…` truncation marker', async ({
    page,
  }) => {
    await gotoWave5(page)
    // Build "a,a,a,..." with 600 `a`s separated by 599 commas.
    const tokens600 = Array.from({ length: 600 }, () => 'a').join(',')

    // Type the long string into G2. Use input.fill on the cell-input so
    // we don't time-out keystroke-by-keystroke.
    await cell(page, 'G2').dblclick()
    const input = cell(page, 'G2').locator('.cell-input')
    await expect(input).toBeVisible()
    await input.fill(tokens600)
    await input.press('Enter')

    await cell(page, 'G2').click()
    const dialog = await openTextToColumnsForSelection(page)

    await page.getByTestId('ttc-next-button').click()
    await page.getByTestId('ttc-delim-tab').click()
    await page.getByTestId('ttc-delim-comma').click()

    // Preview row 1 should contain at most 500 cells, and the last one
    // is the truncation marker `…`.
    const previewRow = page.locator('[data-testid="ttc-preview-row-1"] td')
    await expect.poll(async () => previewRow.count()).toBeLessThanOrEqual(500)
    const count = await previewRow.count()
    // The 500th cell (index 499) is the truncation marker.
    await expect(previewRow.nth(count - 1)).toHaveText('…')

    // Dialog stays responsive — Next still advances.
    await page.getByTestId('ttc-next-button').click()
    await expect(page.getByTestId('ttc-step-3')).toBeVisible()
    await page.getByTestId('ttc-cancel-button').click()
    await expect(dialog).toHaveCount(0)
  })
})

// TODO(B3-#6 capability gating menu hidden): no demo currently renders
// `SpreadsheetMenuBar`, so we cannot drive a "Data → Text to Columns"
// dropdown to assert it is hidden. Once a menubar-backed demo lands,
// re-instate this with a fixture backend that omits `importCellChunks`.
