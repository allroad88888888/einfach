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
 * `Data → Reapply` (Excel `Ctrl+Alt+L`) on the real WASM worker (#27).
 *
 * Filter visibility is a SNAPSHOT taken when the rules are applied: editing a
 * cell does not move its row in or out of view. That is deliberate convergence
 * on Excel — Excel ships Reapply for exactly this reason — but it leaves the
 * user stuck unless the recompute has an entrypoint. These specs pin both
 * halves of that contract against the engine that actually runs the predicate.
 *
 * Every case asserts the counter-example FIRST: after the edit and before
 * Reapply, the view is unchanged. An implementation that made filtering live
 * again would fail there; one where Reapply is a no-op would fail after.
 *
 * Seeded sheet1 column A: A1 'Sheet1' (header row), A2 'cell1', A4 'cell4';
 * row 4 also holds B4=10, C4='source'.
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

function reapplyItem(page: Page) {
  return page.getByTestId('menu-bar-item-data.reapply')
}

async function openDataMenu(page: Page) {
  await page.getByTestId('menu-bar-button-data').click()
  await expect(reapplyItem(page)).toBeVisible()
}

async function applyEqualsFilterOnColumnA(page: Page, value: string) {
  await page.locator('th.spreadsheet-grid-col-header[data-col="0"]').click()
  const filterButton = page.getByTestId('toolbar-btn-filter')
  await expect(filterButton).toBeEnabled()
  await filterButton.click()
  await expect(filterDropdown(page)).toBeVisible()
  await page.getByTestId('filter-condition-kind').selectOption('equals')
  await page.getByTestId('filter-equals-input').fill(value)
  await page.getByTestId('filter-add-equals').click()
  await page.getByTestId('filter-close').click()
  await expect(filterDropdown(page)).toBeHidden()
}

async function editCell(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const editor = cellInput(page, addr)
  await expect(editor).toBeVisible()
  await editor.fill(value)
  await editor.press('Enter')
  await expect(editor).toHaveCount(0)
}

test.describe('vNext Data -> Reapply real-backend evidence', () => {
  // Reapply re-dispatches `setFilterSort`, which is engine-owned since E5. The
  // TS worker declares `engineHiddenState:false` and the adapter withholds the
  // port, so filter and its Reapply entry are both fail-closed there (§10.3).
  // These tests run on the WASM project only.
  test.beforeEach(() => {
    test.skip(
      !activeProjectIsWasm(),
      'filter/Reapply are engine-owned since E5 — the TS worker fail-closes them',
    )
  })

  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('Reapply is disabled until a filter exists, then enabled', async ({ page }) => {
    await gotoWorkerDemo(page)

    // Visible but inert: nothing to re-run yet. It does not HIDE, because the
    // entry appearing and vanishing as the user filters would read as a bug.
    await openDataMenu(page)
    await expect(reapplyItem(page)).toBeDisabled()
    await page.keyboard.press('Escape')

    await applyEqualsFilterOnColumnA(page, 'cell4')

    await openDataMenu(page)
    await expect(reapplyItem(page)).toBeEnabled()
    await page.keyboard.press('Escape')
  })

  test('an edit does not move the row until Reapply, which then hides it', async ({ page }) => {
    await gotoWorkerDemo(page)

    await applyEqualsFilterOnColumnA(page, 'cell4')
    // Row 4 matches and survives; rows 2 and 3 are withheld.
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await expect(cell(page, 'A2')).toHaveCount(0)
    await expect(cell(page, 'A3')).toHaveCount(0)

    // Break the match on the only surviving row.
    await editCell(page, 'A4', 'no-longer-matching')

    // COUNTER-EXAMPLE: the snapshot has not moved. Row 4 is still painted even
    // though it now fails the active rule, and rows 2 and 3 are still gone.
    // This is what makes Reapply necessary rather than cosmetic.
    await expect(cellDisplay(page, 'A4')).toHaveText('no-longer-matching')
    await expect(cell(page, 'A2')).toHaveCount(0)
    await expect(cell(page, 'A3')).toHaveCount(0)

    await openDataMenu(page)
    await reapplyItem(page).click()

    // Now the engine re-scans and row 4 goes too — no row matches any more.
    await expect(cell(page, 'A4')).toHaveCount(0)
    await expect(cell(page, 'A2')).toHaveCount(0)
  })

  test('Ctrl+Alt+L reapplies and leaves still-matching rows at their own index', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Make row 2 match as well, so Reapply has a survivor to keep.
    await editCell(page, 'A2', 'cell4')
    await applyEqualsFilterOnColumnA(page, 'cell4')
    await expect(cellDisplay(page, 'A2')).toHaveText('cell4')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await expect(cell(page, 'A3')).toHaveCount(0)

    // Break the match on row 2 only.
    await editCell(page, 'A2', 'dropped')

    // COUNTER-EXAMPLE again: still on screen.
    await expect(cellDisplay(page, 'A2')).toHaveText('dropped')

    await page.getByTestId('vnext-worker-grid').click()
    await page.keyboard.press('Control+Alt+KeyL')

    // Row 2 leaves; row 4 stays AT ROW 4. Compaction would have moved it up.
    await expect(cell(page, 'A2')).toHaveCount(0)
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await expect(cellDisplay(page, 'B4')).toHaveText('10')
    // Excel's row-number skip survives the recompute: 1, then 4.
    await expect(page.locator('th.spreadsheet-grid-row-header[data-row="1"]')).toHaveCount(0)
    await expect(page.locator('th.spreadsheet-grid-row-header[data-row="3"]')).toHaveCount(1)
  })
})
