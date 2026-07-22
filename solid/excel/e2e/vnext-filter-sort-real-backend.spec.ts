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
 * projections, phase 2/3), under Excel HIDDEN-ROW semantics (#27 S5).
 *
 * The toolbar filter button is enabled on both worker backends. Applying an
 * equals rule HIDES the non-matching rows — it no longer compresses the
 * survivors into consecutive slots — so a matching row keeps its own address
 * and the row header skips. Hidden rows are unmounted, not blanked, which is
 * why absence is asserted with `toHaveCount(0)` rather than an empty string.
 * Clearing the rule restores them. Seeded sheet1 column A: A1 'Sheet1' (header
 * row), A2 'cell1', A4 'cell4'; row 4 also holds B4=10, C4='source'.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function activeProjectIsWasm(): boolean {
  try {
    return test.info().project.name !== 'ts'
  } catch {
    return true
  }
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
  // Since E5 the filter predicate is engine-owned (design-engine-hidden-rows):
  // the WASM worker runs it, but the TS worker declares `engineHiddenState:false`
  // and the adapter WITHHOLDS `setFilterSort` (fail-closed, §10.3). So these
  // apply-a-filter tests only run on the WASM project; the `ts` project asserts
  // the withheld entry below instead.
  test.beforeEach(() => {
    test.skip(
      !activeProjectIsWasm(),
      'filter predicate is engine-owned since E5 — the TS worker fail-closes filter',
    )
  })

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

    // The matching row STAYS at A4. Under the retired compaction it moved up
    // into A2, which is the single most visible difference of this flip.
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await expect(cellDisplay(page, 'B4')).toHaveText('10')
    await expect(cellDisplay(page, 'C4')).toHaveText('source')
    // Non-matching rows are unmounted, not blanked.
    await expect(cell(page, 'A2')).toHaveCount(0)
    await expect(cell(page, 'A3')).toHaveCount(0)
    // Excel's row-number skip: the header goes 1, 4 with nothing between.
    await expect(page.locator('th.spreadsheet-grid-row-header[data-row="1"]')).toHaveCount(0)
    await expect(page.locator('th.spreadsheet-grid-row-header[data-row="3"]')).toHaveCount(1)

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

  test('an edit under an active filter writes the row the user sees', async ({ page }) => {
    await gotoWorkerDemo(page)

    await applyEqualsFilterOnColumnA(page, 'cell4')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await page.getByTestId('filter-close').click()
    await expect(filterDropdown(page)).toBeHidden()

    // What used to need a gateway remap (edit display row 2 -> write source
    // row 4) is now a plain write: D4 on screen is D4 in the engine.
    await cell(page, 'D4').dblclick()
    const editor = cellInput(page, 'D4')
    await expect(editor).toBeVisible()
    await editor.fill('via-filter')
    await editor.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect(cellDisplay(page, 'D4')).toHaveText('via-filter')

    // Clear the filter through the column chevron.
    await page.getByTestId('filter-chevron-0').click()
    await expect(filterDropdown(page)).toBeVisible()
    await page.getByTestId('filter-clear-filter').click()
    await page.getByTestId('filter-close').click()

    // The value stayed where it was written; the rows that come back are
    // untouched.
    await expect(cellDisplay(page, 'D4')).toHaveText('via-filter')
    await expect(cellDisplay(page, 'D2')).toHaveText('')
  })

  // The manual-hide defect from the design's §9.3 smoke, pinned end to end:
  // a manually hidden row must keep meaning the SAME row when a filter is
  // applied on top of it. Before the flip, compaction silently re-pointed the
  // stored row number and the wrong row reappeared.
  test('a manually hidden row does not change what it refers to when a filter changes', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')

    // Manually hide source row 3 (0-based row 2) through the row header menu.
    await page.locator('th.spreadsheet-grid-row-header[data-row="2"]').click({ button: 'right' })
    const hideItem = page.getByTestId('context-menu-command-row.hide')
    await expect(hideItem).toBeVisible()
    await hideItem.click()
    await expect(page.locator('th.spreadsheet-grid-row-header[data-row="2"]')).toHaveCount(0)
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')

    // Now filter to 'cell4'. Row 1 goes away because the filter hid it; row 2
    // stays away because the USER hid it; row 3 survives both.
    await applyEqualsFilterOnColumnA(page, 'cell4')
    await expect(cell(page, 'A2')).toHaveCount(0)
    await expect(cell(page, 'A3')).toHaveCount(0)
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')

    // Clearing the filter must NOT unhide the manually hidden row: the two sets
    // are independent, and a filter change never rewrites the manual one.
    await page.getByTestId('filter-clear-filter').click()
    await page.getByTestId('filter-close').click()
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(page.locator('th.spreadsheet-grid-row-header[data-row="2"]')).toHaveCount(0)
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
  })
})

test.describe('vNext filter fail-closed on the TS worker (E5)', () => {
  test.beforeEach(() => {
    test.skip(activeProjectIsWasm(), 'this contract is specific to the TS worker backend')
  })

  test('the filter entry is withheld because the predicate is engine-owned', async ({ page }) => {
    guardConsoleErrors(page)
    await gotoRoot(page)
    await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
    await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
    await page.locator('th.spreadsheet-grid-col-header[data-col="0"]').click()

    // The TS core has no engine predicate (design §5.2), so the adapter withholds
    // `setFilterSort` and the toolbar filter button is disabled — never a fake
    // scan the TS worker cannot run. (The button's tooltip is the standard
    // "Filter and sort are unavailable because this workbook does not provide
    // setFilterSort." degradation message.)
    await expect(page.getByTestId('toolbar-btn-filter')).toBeDisabled()

    await expectNoConsoleErrors(page)
  })
})
