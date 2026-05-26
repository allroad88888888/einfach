import { test, expect, type Page } from '@playwright/test'

/**
 * Wave 7.5 — Remove Duplicates smoke.
 *
 * 1. Type a 6-row header + data block into columns A..C (the Wave 5 demo
 *    does not have a CSV-like seed for this case, so we synthesise one).
 * 2. Select the full range.
 * 3. Open the dialog by dispatching `spreadsheet:open-remove-duplicates`
 *    (the Wave 5 demo intentionally omits the menubar; the listener is
 *    wired in `VNextWave5Demo.tsx` symmetric to text-to-columns).
 * 4. Assert dialog opens with all columns checked + the preview reports
 *    "2 of 5" (header excluded + two duplicates of earlier rows).
 * 5. Click Remove. Verify the duplicate rows are gone via cell text.
 *
 * Also: deselect column A's checkbox and verify the preview drops to "1
 * of 5" (only one row matches when the differentiating column is
 * excluded from the tuple key).
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
})
