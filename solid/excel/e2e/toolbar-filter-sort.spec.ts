import { expect, test, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function filterButton(page: Page) {
  return page.getByTestId('toolbar-btn-filter')
}

function filterDropdown(page: Page) {
  return page.getByTestId('wave5-filter-dropdown')
}

function filterEqualsInput(page: Page) {
  return page.getByTestId('filter-equals-input')
}

function filterAddEquals(page: Page) {
  return page.getByTestId('filter-add-equals')
}

function filterRules(page: Page) {
  return filterDropdown(page).locator('.filter-rule')
}

function filterChevron(page: Page, col: number) {
  return page.getByTestId(`filter-chevron-${col}`)
}

function columnHeader(page: Page, col: number) {
  return page.locator(`.spreadsheet-grid-col-header[data-col="${col}"]`)
}

function sortButton(page: Page) {
  return page.getByTestId('toolbar-btn-sort')
}

function sortDropdown(page: Page) {
  return page.getByTestId('toolbar-sort-dropdown')
}

function sortAsc(page: Page) {
  return page.getByTestId('toolbar-sort-asc')
}

function sortDesc(page: Page) {
  return page.getByTestId('toolbar-sort-desc')
}

function assertLocalizedLabel(label: string | null, key: string, field: string) {
  expect(label, `${field} exists`).toBeTruthy()
  expect(label, `${field} should not be raw key`).not.toBe(key)
  expect(label, `${field} should not contain i18n dot-notation`).not.toContain('.')
}

async function readColumnTexts(page: Page, col: string, fromRow: number, toRow: number) {
  const values: string[] = []
  for (let row = fromRow; row <= toRow; row += 1) {
    const addr = `${col}${row}`
    const value = (await cell(page, addr).locator('.cell-display').textContent())?.trim()
    values.push(value ?? '')
  }
  return values
}

test.describe('Wave 5 toolbar — filter and sort', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-btn-filter is visible, localized, and conditionally opens filter dropdown', async ({
    page,
  }) => {
    await gotoWave5(page)
    await columnHeader(page, 1).click()
    await expect(columnHeader(page, 1)).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'B2')).toHaveAttribute('data-selected', 'true')

    const button = filterButton(page)
    await expect(button).toBeVisible()
    assertLocalizedLabel(
      await button.getAttribute('data-tooltip'),
      'toolbar.filter.title',
      'filter tooltip',
    )
    assertLocalizedLabel(
      await button.getAttribute('aria-label'),
      'toolbar.filter.title',
      'filter aria-label',
    )

    if (await button.isDisabled()) {
      test.info().annotations.push({
        type: 'note',
        description:
          'Filter toolbar button is disabled in Wave 5. Current cause: backend setFilterSort contract is missing from static demo backend.',
      })
      return
    }

    await expect(button).toBeEnabled()

    await button.click()
    await expect(filterDropdown(page)).toBeVisible()

    const equalsValue = '120'
    // The condition inputs are gated behind the condition-kind select now
    // (SpreadsheetFilterDropdown renders `filter-equals-input` only when
    // the draft kind is 'equals'; the default draft kind is 'none').
    await page.getByTestId('filter-condition-kind').selectOption('equals')
    await filterEqualsInput(page).fill(equalsValue)
    await filterAddEquals(page).click()

    // OK applies AND closes the dropdown (Excel parity). The filter is active —
    // the column carries its chevron and the grid reflects the rule.
    await expect(filterDropdown(page)).toBeHidden()
    await expect(filterChevron(page, 1)).toBeVisible()
    await expect(cell(page, 'A2').locator('.cell-display')).toHaveText('North')
    await expect(cell(page, 'B2').locator('.cell-display')).toHaveText('120')
    // #27 S5: non-matching rows are HIDDEN — unmounted, not blanked — so the
    // assertion is absence of the element, not an empty string.
    await expect(cell(page, 'A3')).toHaveCount(0)

    // Reopen via the column chevron to confirm the rule was committed (this is
    // the equivalent of the old in-dropdown rule assertion, now that OK closes).
    await filterChevron(page, 1).click()
    await expect(filterDropdown(page)).toBeVisible()
    await expect(filterRules(page)).toContainText(`= ${equalsValue}`)
  })

  test('filter dropdown applies value-list and condition filters, then clears them', async ({
    page,
  }) => {
    await gotoWave5(page)
    await columnHeader(page, 0).click()
    await filterButton(page).click()
    await expect(filterDropdown(page)).toBeVisible()
    await expect(page.getByTestId('filter-value-South')).toBeVisible()

    await page.getByTestId('filter-value-South').click()
    await page.getByTestId('filter-add-equals').click()
    // South (row 3) is hidden; East does NOT slide up into its place — it keeps
    // A4, which is the whole difference between hiding and compacting. OK applies
    // AND closes the dropdown (Excel parity).
    await expect(filterDropdown(page)).toBeHidden()
    await expect(cell(page, 'A2').locator('.cell-display')).toHaveText('North')
    await expect(cell(page, 'A3')).toHaveCount(0)
    await expect(cell(page, 'A4').locator('.cell-display')).toHaveText('East')

    // Reopen via the column chevron (OK closed the dropdown) to clear the rule.
    // clear-filter keeps the dropdown open, so the next rule is added in the
    // same session.
    await filterChevron(page, 0).click()
    await expect(filterDropdown(page)).toBeVisible()
    await page.getByTestId('filter-clear-filter').click()
    await expect(cell(page, 'A3').locator('.cell-display')).toHaveText('South')

    await page.getByTestId('filter-condition-kind').selectOption('contains')
    await page.getByTestId('filter-contains-input').fill('st')
    await page.getByTestId('filter-add-equals').click()
    // 'st' matches East and West only, and both stay on their own rows.
    await expect(cell(page, 'A2')).toHaveCount(0)
    await expect(cell(page, 'A3')).toHaveCount(0)
    await expect(cell(page, 'A4').locator('.cell-display')).toHaveText('East')
    await expect(cell(page, 'A5').locator('.cell-display')).toHaveText('West')
  })

  test('toolbar-btn-sort is visible, labeled, and opens dropdown', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = sortButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    assertLocalizedLabel(await button.getAttribute('data-tooltip'), 'toolbar.sort.title', 'sort tooltip')
    assertLocalizedLabel(await button.getAttribute('aria-label'), 'toolbar.sort.title', 'sort aria-label')

    await button.click()
    await expect(sortDropdown(page)).toBeVisible()
  })

  test('sort-asc / sort-desc actions close dropdown and reorder visible rows', async ({
    page,
  }) => {
    // The static Wave 5 backend now exposes the `sortRange` port, so the toolbar
    // sort PHYSICALLY reorders engine data (design-engine-sort #29) instead of
    // the old display permutation. The seeded "Total" row sits inside the sorted
    // data region and — unlike a real Excel Table total — is NOT auto-excluded
    // (summary-row exclusion is a documented v1 UI-core gap, design §6.1), so it
    // sorts with the data. That is the physical-vs-display discriminator here:
    // descending, Total's 870 is the max and moves to the TOP, whereas the old
    // display permutation pinned it at the bottom.
    await gotoWave5(page)
    await columnHeader(page, 1).click()
    await expect(columnHeader(page, 1)).toHaveAttribute('data-selected', 'true')

    await sortButton(page).click()
    await expect(sortDropdown(page)).toBeVisible()
    await sortAsc(page).click()
    await expect(sortDropdown(page)).toBeHidden()

    const afterAsc = await readColumnTexts(page, 'A', 2, 8)
    expect(afterAsc).toEqual(['Mountain', 'South', 'Central', 'North', 'West', 'Pacific', 'East'])

    await sortButton(page).click()
    await expect(sortDropdown(page)).toBeVisible()
    await sortDesc(page).click()
    await expect(sortDropdown(page)).toBeHidden()

    // Physical sort: Total (870) is the descending max and rides to the top.
    const afterDesc = await readColumnTexts(page, 'A', 2, 8)
    expect(afterDesc).toEqual(['Total', 'East', 'Pacific', 'West', 'North', 'Central', 'South'])

    await columnHeader(page, 2).click()
    await expect(columnHeader(page, 2)).toHaveAttribute('data-selected', 'true')
    await sortButton(page).click()
    await expect(sortDropdown(page)).toBeVisible()
    await sortAsc(page).click()

    const afterSwitchColumnAsc = await readColumnTexts(page, 'A', 2, 8)
    expect(afterSwitchColumnAsc).toEqual([
      'Mountain',
      'East',
      'West',
      'Central',
      'South',
      'North',
      'Pacific',
    ])
  })

  test('sort dropdown closes via Escape and outside click', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await sortButton(page).click()
    await expect(sortDropdown(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sortDropdown(page)).toBeHidden()

    await sortButton(page).click()
    await expect(sortDropdown(page)).toBeVisible()
    await page.getByTestId('wave5-formula-bar').click()
    await expect(sortDropdown(page)).toBeHidden()
  })
})
