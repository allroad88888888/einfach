import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

/**
 * #27 S5a — inserting a row while a filter is ACTIVE, on the real vNext Worker
 * demo. This is the hand-found regression from the S5 flip, pinned end to end.
 *
 * Why it appeared: before the flip the projection recomputed filter visibility
 * on every revision bump, so a structural edit self-corrected. After the flip
 * the filter-hidden set is a SNAPSHOT, and nothing displaced it — so an insert
 * left every stored index pointing one row above where its row had moved to.
 * The manual hidden set already followed the shift, which is what made the
 * split visible: one set moved, its twin did not.
 *
 * The four steps below are the reported repro verbatim:
 *
 *   1. E1 'Val', E2:E5 = 10/20/30/40, with SUBTOTAL/SUM probes on row 1.
 *   2. Hide row 3 (the 20) from the row-header menu.
 *   3. Filter column E, unchecking the value 10.
 *   4. Insert a row above row 1.
 *
 * The symptom after step 4 was row headers reading 1, 3, 5, 6 — the header row
 * swallowed by the stale index and the filtered-out 10 painted again. The
 * assertions here are the corrected version of exactly those observations, so
 * a regression reproduces the original numbers rather than failing vaguely.
 *
 * WASM-only. The TS worker runtime declares `structuralEdits: false`, so the
 * `insertRows` / `deleteRows` ports are withheld on that project and step 4
 * cannot happen at all — there is nothing to displace and nothing to assert.
 * (It also declares `evalHiddenRows` / `evalFilterHiddenRows` false, so the
 * SUBTOTAL probes would not respond either.)
 */

function activeProjectIsWasm(): boolean {
  try {
    return test.info().project.name !== 'ts'
  } catch {
    return true
  }
}

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function rowHeader(page: Page, row: number) {
  return page.locator(`th.spreadsheet-grid-row-header[data-row="${row}"]`)
}

/**
 * The 0-based source rows the grid is painting, up to `maxRow` inclusive.
 *
 * Bounded on purpose: the demo viewport renders past the seeded data, and the
 * predicate scan only judges rows it reached — rows beyond the last non-empty
 * one are never filter-hidden and stay painted, which is correct and not what
 * this test is about.
 */
async function paintedRows(page: Page, maxRow: number): Promise<number[]> {
  const values = await page
    .locator('th.spreadsheet-grid-row-header')
    .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset.row)))
  return values
    .filter((row) => Number.isInteger(row) && row <= maxRow)
    .sort((left, right) => left - right)
}

async function seedRepro(page: Page) {
  await typeIntoCell(page, 'E1', 'Val')
  await typeIntoCell(page, 'E2', '10')
  await typeIntoCell(page, 'E3', '20')
  await typeIntoCell(page, 'E4', '30')
  await typeIntoCell(page, 'E5', '40')
  await typeIntoCell(page, 'G1', '=SUBTOTAL(9,E2:E5)')
  await typeIntoCell(page, 'H1', '=SUBTOTAL(109,E2:E5)')
  await typeIntoCell(page, 'I1', '=SUM(E2:E5)')
}

test.describe('vNext filter + structural shift — real worker backend (#27 S5a)', () => {
  test.beforeEach(() => {
    test.skip(
      !activeProjectIsWasm(),
      'structural edits are WASM-only (the TS worker declares structuralEdits:false)',
    )
  })

  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('inserting a row above an active filter keeps both hidden sets on their own rows', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)
    await seedRepro(page)

    await expect(cellDisplay(page, 'G1')).toHaveText('100')
    await expect(cellDisplay(page, 'H1')).toHaveText('100')
    await expect(cellDisplay(page, 'I1')).toHaveText('100')

    // Step 2 — hide source row 2 (screen row 3, the value 20).
    await rowHeader(page, 2).click({ button: 'right' })
    const hideItem = page.getByTestId('context-menu-command-row.hide')
    await expect(hideItem).toBeVisible()
    await hideItem.click()
    await expect(rowHeader(page, 2)).toHaveCount(0)

    // Step 3 — filter column E, unchecking the value 10 (source row 1).
    await page.locator('th.spreadsheet-grid-col-header[data-col="4"]').click()
    const filterButton = page.getByTestId('toolbar-btn-filter')
    await expect(filterButton).toBeEnabled()
    await filterButton.click()
    await expect(page.getByTestId('vnext-worker-filter-dropdown')).toBeVisible()
    await page.getByTestId('filter-value-10').uncheck()
    await page.getByTestId('filter-add-equals').click()
    await page.getByTestId('filter-close').click()
    await expect(page.getByTestId('vnext-worker-filter-dropdown')).toBeHidden()

    // Screen rows 1, 4, 5 — the header plus 30 and 40.
    await expect.poll(() => paintedRows(page, 4)).toEqual([0, 3, 4])
    await expect(cellDisplay(page, 'E1')).toHaveText('Val')
    await expect(cellDisplay(page, 'E4')).toHaveText('30')
    await expect(cellDisplay(page, 'E5')).toHaveText('40')
    // 1-11 drops the filtered row only; 101-111 drops the manual one too.
    await expect(cellDisplay(page, 'G1')).toHaveText('90')
    await expect(cellDisplay(page, 'H1')).toHaveText('70')
    await expect(cellDisplay(page, 'I1')).toHaveText('100')

    // Step 4 — insert one row above row 1. Everything below moves down one.
    await rowHeader(page, 0).click({ button: 'right' })
    const insertItem = page.getByTestId('context-menu-command-row.insert')
    await expect(insertItem).toBeVisible()
    await insertItem.click()

    // THE REGRESSION. Correct: screen rows 1, 2, 5, 6 — the new blank row, the
    // header that moved into row 2, then 30 and 40. The reported bug painted
    // 1, 3, 5, 6 instead: the stale filter index swallowed the header and let
    // the filtered-out 10 back onto the screen.
    await expect(rowHeader(page, 1)).toHaveCount(1)
    await expect.poll(() => paintedRows(page, 5)).toEqual([0, 1, 4, 5])
    await expect(cellDisplay(page, 'E2')).toHaveText('Val')
    await expect(cell(page, 'E3')).toHaveCount(0) // the filtered-out 10
    await expect(cell(page, 'E4')).toHaveCount(0) // the manually hidden 20
    await expect(cellDisplay(page, 'E5')).toHaveText('30')
    await expect(cellDisplay(page, 'E6')).toHaveText('40')

    // The probes moved to row 2 with everything else, and the engine's copy of
    // both sets moved with them: unshifted, these read 100 and 80.
    await expect(cellDisplay(page, 'G2')).toHaveText('90')
    await expect(cellDisplay(page, 'H2')).toHaveText('70')
    await expect(cellDisplay(page, 'I2')).toHaveText('100')

    // Undo puts every copy back — the recorded images, not an inverted shift.
    await page.getByTestId('history-timeline-undo').click()
    await expect.poll(() => paintedRows(page, 4)).toEqual([0, 3, 4])
    await expect(cellDisplay(page, 'E1')).toHaveText('Val')
    await expect(cellDisplay(page, 'E4')).toHaveText('30')
    await expect(cellDisplay(page, 'G1')).toHaveText('90')
    await expect(cellDisplay(page, 'H1')).toHaveText('70')
  })

  // The DELETE direction. Note what is NOT reachable here: §8.3 makes
  // `row.delete` skip filter-hidden rows, so a filtered row can never be
  // inside a deleted band on this path — "the deleted row is itself in the
  // set" is covered by the unit suites instead (operations.test.ts,
  // vnext-structural-remap-static.test.ts).
  test('deleting a visible row above a filter-hidden one carries the hidden index with it', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)
    await seedRepro(page)

    // Filter the 10 away, then delete the row it is on (screen row 2).
    await page.locator('th.spreadsheet-grid-col-header[data-col="4"]').click()
    await page.getByTestId('toolbar-btn-filter').click()
    await expect(page.getByTestId('vnext-worker-filter-dropdown')).toBeVisible()
    await page.getByTestId('filter-value-10').uncheck()
    await page.getByTestId('filter-add-equals').click()
    await page.getByTestId('filter-close').click()
    await expect.poll(() => paintedRows(page, 4)).toEqual([0, 2, 3, 4])

    await rowHeader(page, 0).click({ button: 'right' })
    const deleteItem = page.getByTestId('context-menu-command-row.delete')
    await expect(deleteItem).toBeVisible()
    await deleteItem.click()

    // Row 0 (the header) is gone, so every remaining row moves up one and the
    // filter-hidden index must move 1 → 0 with it. Left at 1 it would swallow
    // the 20 that just took that address and paint the 10 it was hiding.
    await expect.poll(() => paintedRows(page, 3)).toEqual([1, 2, 3])
    await expect(cell(page, 'E1')).toHaveCount(0) // the filtered-out 10
    await expect(cellDisplay(page, 'E2')).toHaveText('20')
    await expect(cellDisplay(page, 'E3')).toHaveText('30')
    await expect(cellDisplay(page, 'E4')).toHaveText('40')
  })
})
