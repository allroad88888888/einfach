import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

/**
 * Parity #04 — merge/unmerge on the worker path (adapter host-overlay,
 * CANONICAL_OWNERSHIP "adapter overlay").
 *
 * The worker adapter now implements the `mergeRange` / `unmergeRange`
 * ports as a main-thread overlay (session-only, no engine model), so
 * the toolbar merge dropdown unlocks on the worker demos. Runs against
 * BOTH real worker backends via the shared demo — the `wasm` / `ts`
 * Playwright projects thread `?backend=` through `gotoRoot`.
 *
 * Seeded Sheet1 facts used below: B2 'result', C2 '=Sheet2!C2+1' → 13.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function gridCell(page: Page, row: string, col: string) {
  return page.locator(
    `[data-testid="vnext-worker-grid"] td[data-row="${row}"][data-col="${col}"]`,
  )
}

test.describe('vNext worker merge real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('B2:C3 merges to a spanning anchor and Ctrl+Z splits it back apart', async ({ page }) => {
    await gotoWorkerDemo(page)

    // Select B2:C3 and merge through the toolbar dropdown — the anchor
    // button is enabled now that the worker backend exposes the port.
    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })
    const mergeButton = page.getByTestId('toolbar-btn-merge')
    await expect(mergeButton).toBeEnabled()
    await mergeButton.click()
    await expect(page.getByTestId('toolbar-merge-dropdown')).toBeVisible()
    await page.getByTestId('toolbar-merge-center').click()
    await expect(page.getByTestId('toolbar-merge-dropdown')).toBeHidden()

    // The anchor spans 2x2, keeps its seeded value, and the covered
    // cells leave the DOM (rows 1-2 / cols 1-2 zero-based).
    const anchor = cell(page, 'B2')
    await expect(anchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(anchor).toHaveAttribute('rowspan', '2')
    await expect(anchor).toHaveAttribute('colspan', '2')
    await expect(cellDisplay(page, 'B2')).toHaveText('result')
    await expect(gridCell(page, '1', '2')).toHaveCount(0)
    await expect(gridCell(page, '2', '1')).toHaveCount(0)
    await expect(gridCell(page, '2', '2')).toHaveCount(0)

    // One user action, one history entry.
    const entry = page.getByTestId('history-timeline-entry-0')
    await expect(entry).toHaveAttribute('data-kind', 'range.merge')
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('1 / 1')

    // Ctrl+Z replays the merge record through the worker adapter's
    // host-orchestrated transaction log: the region splits apart and the
    // covered formula cell resurfaces with its live value. Click the
    // anchor first so keyboard focus returns from the toolbar to the
    // grid (undo-real-backend spec convention).
    await cell(page, 'B2').click()
    await page.keyboard.press('Control+z')
    await expect(cell(page, 'B2')).toHaveAttribute('data-merge-anchor', 'false')
    await expect(cell(page, 'B2')).toHaveAttribute('rowspan', '1')
    await expect(cell(page, 'B2')).toHaveAttribute('colspan', '1')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')
    await expect(gridCell(page, '2', '1')).toHaveCount(1)
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('0 / 1')

    // Ctrl+Y restores the merge.
    await page.keyboard.press('Control+y')
    await expect(cell(page, 'B2')).toHaveAttribute('data-merge-anchor', 'true')
    await expect(cell(page, 'B2')).toHaveAttribute('rowspan', '2')
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('1 / 1')
  })
})
