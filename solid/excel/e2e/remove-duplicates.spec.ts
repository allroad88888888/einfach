import { test, expect, type Page } from '@playwright/test'

/**
 * Wave 7.5 — Remove Duplicates e2e.
 *
 * The Wave 5 demo omits the menubar (Univer parity), so we open the dialog
 * by dispatching the `spreadsheet:open-remove-duplicates` window event the
 * demo's helper listens for. The helper mirrors the menubar dispatcher's
 * two-write transaction (sheetId capture + open + cells), so all the
 * confirm-time safety checks behave identically to the production flow.
 *
 * Coverage:
 *   1. Full-row duplicate detection + removal (existing).
 *   2. Deselecting a differentiating column updates the preview (existing).
 *   3. caseInsensitive comparison finds dups across case.
 *   4. noDuplicates preview message + Remove button disabled.
 *   5. Deselect-all → noKeyColumns preview + Remove disabled.
 *   6. Sheet-id race fix (HIGH #1): switching sheets mid-dialog still
 *      deletes from the original sheet, not the active one.
 *   7. Undo restores deleted rows.
 *   8. Trim comparison treats leading/trailing whitespace as equal.
 *
 * Capability gating (backend without `removeRows` → menu entry hidden) is
 * covered by `solid/excel/test/vnext-menu-bar.test.tsx`. The Wave 5 demo
 * does not render the menubar so the corresponding e2e assertion would
 * have no DOM to query.
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="B2"] .cell-display`),
  ).toHaveText('120')
}

function cell(page: Page, addr: string) {
  return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
}

async function typeRow(page: Page, addr: string, values: string[]) {
  await cell(page, addr).click()
  for (let i = 0; i < values.length; i += 1) {
    await page.keyboard.type(values[i])
    if (i < values.length - 1) {
      await page.keyboard.press('Tab')
    } else {
      await page.keyboard.press('Enter')
    }
  }
}

async function selectRange(page: Page, anchor: string, focus: string) {
  await cell(page, anchor).click()
  await cell(page, focus).click({ modifiers: ['Shift'] })
}

async function openDialog(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('spreadsheet:open-remove-duplicates'))
  })
  await expect(page.getByTestId('wave5-remove-duplicates')).toBeVisible()
}

function pressUndo(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  return page.keyboard.press(`${meta}+z`)
}

test.describe('remove-duplicates — Data > Remove Duplicates smoke', () => {
  test('opening the dialog, confirming removes the duplicate rows', async ({ page }) => {
    await gotoWave5(page)

    // Seed an isolated 6-row table in columns G..I — well away from the
    // Wave 5 sales-data seed so we don't interfere with it.
    //   row 1 : header
    //   row 2 : Alice, NY, 100
    //   row 3 : Bob,   LA, 200
    //   row 4 : Alice, NY, 100   <-- duplicate of row 2 (full match)
    //   row 5 : Carol, SF, 300
    //   row 6 : Bob,   LA, 200   <-- duplicate of row 3 (full match)
    await typeRow(page, 'G1', ['name', 'city', 'amount'])
    await typeRow(page, 'G2', ['Alice', 'NY', '100'])
    await typeRow(page, 'G3', ['Bob', 'LA', '200'])
    await typeRow(page, 'G4', ['Alice', 'NY', '100'])
    await typeRow(page, 'G5', ['Carol', 'SF', '300'])
    await typeRow(page, 'G6', ['Bob', 'LA', '200'])

    await selectRange(page, 'G1', 'I6')

    await openDialog(page)

    // All three columns should be checked by default.
    const colCheckboxes = [
      page.getByTestId('remove-duplicates-column-6'),
      page.getByTestId('remove-duplicates-column-7'),
      page.getByTestId('remove-duplicates-column-8'),
    ]
    for (const checkbox of colCheckboxes) {
      await expect(checkbox).toBeChecked()
    }

    // Preview should report 2 duplicate rows out of 5 scanned (header
    // excluded). Match loosely so wording can shift inside the same key.
    const preview = page.getByTestId('remove-duplicates-preview')
    await expect(preview).toContainText('2')
    await expect(preview).toContainText('5')

    await page.getByTestId('remove-duplicates-confirm-button').click()

    // Dialog closes.
    await expect(page.getByTestId('wave5-remove-duplicates')).toHaveCount(0)

    // After removal the unique rows shift up. The deterministic property
    // we can assert without depending on the exact post-shift addressing
    // is: G..I rows 2 + 3 + 4 are now {Alice/NY/100}, {Bob/LA/200},
    // {Carol/SF/300} (each appearing exactly once), and rows 5/6 are
    // empty.
    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('Alice')
    await expect(cell(page, 'H2').locator('.cell-display')).toHaveText('NY')
    await expect(cell(page, 'I2').locator('.cell-display')).toHaveText('100')
    await expect(cell(page, 'G3').locator('.cell-display')).toHaveText('Bob')
    await expect(cell(page, 'H3').locator('.cell-display')).toHaveText('LA')
    await expect(cell(page, 'I3').locator('.cell-display')).toHaveText('200')
    await expect(cell(page, 'G4').locator('.cell-display')).toHaveText('Carol')
    await expect(cell(page, 'H4').locator('.cell-display')).toHaveText('SF')
    await expect(cell(page, 'I4').locator('.cell-display')).toHaveText('300')
    // Rows 5 / 6 should be empty for these columns.
    for (const addr of ['G5', 'H5', 'I5', 'G6', 'H6', 'I6']) {
      await expect(cell(page, addr).locator('.cell-display')).toHaveText('')
    }
  })

  test('deselecting a differentiating column updates the preview count', async ({ page }) => {
    await gotoWave5(page)

    // Seed: column G differentiates rows 2 & 4 (Alice vs Alicia); columns
    // H + I match. So with all 3 columns selected, no duplicates. With G
    // deselected, the (H,I) tuple of (NY,100) appears twice -> 1 dup.
    await typeRow(page, 'G1', ['name', 'city', 'amount'])
    await typeRow(page, 'G2', ['Alice', 'NY', '100'])
    await typeRow(page, 'G3', ['Bob', 'LA', '200'])
    await typeRow(page, 'G4', ['Alicia', 'NY', '100'])
    await typeRow(page, 'G5', ['Carol', 'SF', '300'])

    await selectRange(page, 'G1', 'I5')

    await openDialog(page)

    // With all three columns selected, no two rows match fully -> the
    // confirm button should be disabled (preview reports 0 duplicates).
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeDisabled()

    // Deselect column G; now (H,I) collision finds 1 duplicate.
    await page.getByTestId('remove-duplicates-column-6').click()

    const preview = page.getByTestId('remove-duplicates-preview')
    await expect(preview).toContainText('1')
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeEnabled()
  })

  test('caseInsensitive comparison finds duplicates across case', async ({ page }) => {
    await gotoWave5(page)

    // Three rows differ only in case for the key column. With exact match
    // (default) → no duplicates. With caseInsensitive → 2 duplicates.
    await typeRow(page, 'G1', ['name'])
    await typeRow(page, 'G2', ['Foo'])
    await typeRow(page, 'G3', ['foo'])
    await typeRow(page, 'G4', ['FOO'])

    await selectRange(page, 'G1', 'G4')

    await openDialog(page)

    // Default = exact → no duplicates → Remove disabled.
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeDisabled()

    // Switch to caseInsensitive.
    await page.getByTestId('remove-duplicates-comparison-caseInsensitive').click()

    const preview = page.getByTestId('remove-duplicates-preview')
    // 2 dups of 3 scanned.
    await expect(preview).toContainText('2')
    await expect(preview).toContainText('3')
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeEnabled()
  })

  test('noDuplicates preview surfaces the friendly empty-state message', async ({ page }) => {
    await gotoWave5(page)

    // Three rows with unique values. No duplicates possible.
    await typeRow(page, 'G1', ['name'])
    await typeRow(page, 'G2', ['Alice'])
    await typeRow(page, 'G3', ['Bob'])
    await typeRow(page, 'G4', ['Carol'])

    await selectRange(page, 'G1', 'G4')

    await openDialog(page)

    // Preview reads the noDuplicates string (en locale: "No duplicates
    // found — nothing to remove"). Match a stable substring so a future
    // copy tweak doesn't break the assertion.
    const preview = page.getByTestId('remove-duplicates-preview')
    await expect(preview).toContainText('No duplicates found')
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeDisabled()
  })

  test('deselect-all surfaces the noKeyColumns message + disables Remove', async ({ page }) => {
    await gotoWave5(page)

    // Two duplicate rows so the "with key columns selected" state has
    // something to report. We then deselect everything to force the
    // noKeyColumns branch.
    await typeRow(page, 'G1', ['name', 'city'])
    await typeRow(page, 'G2', ['Alice', 'NY'])
    await typeRow(page, 'G3', ['Alice', 'NY'])

    await selectRange(page, 'G1', 'H3')

    await openDialog(page)

    // Sanity: with all columns selected the duplicate is found.
    const preview = page.getByTestId('remove-duplicates-preview')
    await expect(preview).toContainText('1')

    // Deselect all → preview must read "Select at least one column..."
    // and the Remove button must be disabled.
    await page.getByTestId('remove-duplicates-deselect-all').click()
    await expect(preview).toContainText('Select at least one column')
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeDisabled()
  })

  test('sheet-id race fix: confirming after sheet switch deletes from the original sheet', async ({
    page,
  }) => {
    await gotoWave5(page)

    // Seed on the active sheet (Sales / sheet-1): a 4-row table with one
    // duplicate so we can verify the row count drops by 1.
    await typeRow(page, 'G1', ['name'])
    await typeRow(page, 'G2', ['Alice'])
    await typeRow(page, 'G3', ['Bob'])
    await typeRow(page, 'G4', ['Alice'])

    await selectRange(page, 'G1', 'G4')

    await openDialog(page)

    // Sanity: 1 duplicate of 3.
    const preview = page.getByTestId('remove-duplicates-preview')
    await expect(preview).toContainText('1')

    // Switch to the Forecast tab (sheet-2) while the dialog stays open.
    // The dialog's reset-on-open is store-side so it doesn't re-fire on
    // unrelated mutations (Solid 1.9.12 hazard, see CLAUDE.md). The
    // dialog must STILL be open after the click.
    await page
      .locator('[data-testid="wave5-sheet-tabs"] button.spreadsheet-sheet-tab[data-sheet-id="sheet-2"]')
      .click()
    await expect(page.getByTestId('wave5-remove-duplicates')).toBeVisible()

    // Confirm. Sheet-id race fix means the deletion targets sheet-1
    // (where the dialog opened), not sheet-2 (active now).
    await page.getByTestId('remove-duplicates-confirm-button').click()
    await expect(page.getByTestId('wave5-remove-duplicates')).toHaveCount(0)

    // Switch back to Sales and confirm the duplicate is gone. The
    // surviving rows are: Alice, Bob (the second Alice was the dup).
    await page
      .locator('[data-testid="wave5-sheet-tabs"] button.spreadsheet-sheet-tab[data-sheet-id="sheet-1"]')
      .click()

    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('Alice')
    await expect(cell(page, 'G3').locator('.cell-display')).toHaveText('Bob')
    // Row 4 used to be the duplicate "Alice" — it now shifts up and the
    // bottom row clears.
    await expect(cell(page, 'G4').locator('.cell-display')).toHaveText('')
  })

  test('undo restores rows deleted by Remove Duplicates', async ({ page }) => {
    await gotoWave5(page)

    // Five rows with two duplicates. After removal: 3 unique survive.
    // After undo: all 5 must reappear.
    await typeRow(page, 'G1', ['name'])
    await typeRow(page, 'G2', ['Alice'])
    await typeRow(page, 'G3', ['Bob'])
    await typeRow(page, 'G4', ['Alice'])
    await typeRow(page, 'G5', ['Carol'])
    await typeRow(page, 'G6', ['Bob'])

    await selectRange(page, 'G1', 'G6')

    await openDialog(page)

    await page.getByTestId('remove-duplicates-confirm-button').click()
    await expect(page.getByTestId('wave5-remove-duplicates')).toHaveCount(0)

    // After removal: 3 unique survive in rows 2..4; rows 5/6 empty.
    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('Alice')
    await expect(cell(page, 'G3').locator('.cell-display')).toHaveText('Bob')
    await expect(cell(page, 'G4').locator('.cell-display')).toHaveText('Carol')
    await expect(cell(page, 'G5').locator('.cell-display')).toHaveText('')
    await expect(cell(page, 'G6').locator('.cell-display')).toHaveText('')

    // Focus the grid wrapper so the Ctrl+Z handler fires.
    await page.locator(`${WAVE5_GRID}`).click()
    // Click a safe spot inside the grid (G1 header). The shortcut is
    // dispatched from the grid wrapper's onKeyDown.
    await cell(page, 'G1').click()
    await pressUndo(page)

    // All 5 original data rows must reappear in their original order.
    await expect(cell(page, 'G2').locator('.cell-display')).toHaveText('Alice')
    await expect(cell(page, 'G3').locator('.cell-display')).toHaveText('Bob')
    await expect(cell(page, 'G4').locator('.cell-display')).toHaveText('Alice')
    await expect(cell(page, 'G5').locator('.cell-display')).toHaveText('Carol')
    await expect(cell(page, 'G6').locator('.cell-display')).toHaveText('Bob')
  })

  test('trim comparison treats leading/trailing whitespace as equal', async ({ page }) => {
    await gotoWave5(page)

    // " foo" (leading space) and "foo " (trailing space) should be
    // considered the same under trim comparison. Under exact match the
    // two are distinct → 0 duplicates.
    await typeRow(page, 'G1', ['name'])
    await typeRow(page, 'G2', [' foo'])
    await typeRow(page, 'G3', ['foo '])
    await typeRow(page, 'G4', ['bar'])

    await selectRange(page, 'G1', 'G4')

    await openDialog(page)

    // Default exact → no duplicates.
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeDisabled()

    // Switch to trim → ' foo' and 'foo ' collapse → 1 duplicate.
    await page.getByTestId('remove-duplicates-comparison-trim').click()

    const preview = page.getByTestId('remove-duplicates-preview')
    await expect(preview).toContainText('1')
    await expect(preview).toContainText('3')
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeEnabled()
  })
})
