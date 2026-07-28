import { expect, test, type Page } from '@playwright/test'

import {
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

/**
 * SUBTOTAL hidden-row exclusion end to end on the vNext Worker WASM demo
 * (parity #23) — real-backend evidence that hiding a data row pushes the
 * hidden set into the engine so the 101-111 SUBTOTAL variants drop it, while
 * the 1-11 variants stay unchanged.
 *
 * The demo viewport only renders ~6 rows, so the whole fixture lives in rows
 * 1-6: the data column F1:F3 (10 / 20 / 30), a gap row 4, and the two SUBTOTAL
 * probes in rows 5/6 that the hide never touches.
 *
 * Flow:
 *   1. Seed F1:F3 (10 / 20 / 30) plus `=SUBTOTAL(109, F1:F3)` (F5) and
 *      `=SUBTOTAL(9, F1:F3)` (F6). Baseline: both read 60.
 *   2. Hide row 2 (F2 = 20) via the row-header context menu. The provider
 *      mirrors the UI-core canonical hidden set into the engine.
 *   3. Assert the 109 SUBTOTAL drops to 40 (excludes the hidden row) while the
 *      9 SUBTOTAL stays 60 (includes it).
 *   4. Undo to restore the hidden state and assert the 109 SUBTOTAL recovers.
 *
 * WASM-only: the TS worker declares `evalHiddenRows: false` (fail-closed), so
 * the `setEvalHiddenRows` port is withheld on the `ts` project and SUBTOTAL
 * 101-111 does not exclude there. The `wasm` null-witness keeps it exposed.
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
  // Cross-sheet seed settles (Sheet1!C2 = Sheet2!C2 + 1 → 13) — the demo is live.
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function rowHeader(page: Page, row: number) {
  return page.locator(`th.spreadsheet-grid-row-header[data-row="${row}"]`)
}

/** Enter the F1:F3 data column and the two SUBTOTAL probes in rows 5/6. */
async function seedSubtotalRegion(page: Page) {
  await typeIntoCell(page, 'F1', '10')
  await typeIntoCell(page, 'F2', '20')
  await typeIntoCell(page, 'F3', '30')
  await typeIntoCell(page, 'F5', '=SUBTOTAL(109,F1:F3)')
  await typeIntoCell(page, 'F6', '=SUBTOTAL(9,F1:F3)')
}

test.describe('vNext SUBTOTAL hidden-row exclusion — real WASM backend', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('hiding a data row excludes it from SUBTOTAL 109 but not SUBTOTAL 9', async ({ page }) => {
    test.skip(
      !activeProjectIsWasm(),
      'SUBTOTAL 101-111 hidden exclusion is WASM-only (TS worker declares evalHiddenRows:false)',
    )
    await gotoWorkerDemo(page)
    await seedSubtotalRegion(page)

    // Baseline: nothing hidden, both variants sum the full column.
    await expect(cellDisplay(page, 'F5')).toHaveText('60')
    await expect(cellDisplay(page, 'F6')).toHaveText('60')

    // Hide row 2 (F2 = 20) via the row-header context menu (data-row is 0-based).
    await rowHeader(page, 1).click({ button: 'right' })
    const hideItem = page.getByTestId('context-menu-command-row.hide')
    await expect(hideItem).toBeVisible()
    await hideItem.click()

    // The hidden row unmounts, and the engine excludes it from 109 only.
    await expect(cellDisplay(page, 'F2')).toHaveCount(0)
    await expect(cellDisplay(page, 'F5')).toHaveText('40')
    await expect(cellDisplay(page, 'F6')).toHaveText('60')

    // Undo restores the hidden state; the engine re-includes the row in 109.
    await page.getByTestId('history-timeline-undo').click()
    await expect(cellDisplay(page, 'F2')).toHaveText('20')
    await expect(cellDisplay(page, 'F5')).toHaveText('60')
    await expect(cellDisplay(page, 'F6')).toHaveText('60')
  })
})
