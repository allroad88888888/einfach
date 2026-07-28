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
 * Host-orchestrated authoritative undo/redo on the worker backends
 * (phase 2/3, commit 11127bd).
 *
 * A committed cell input records a backend history entry (kind
 * `cell.set-input`, revision `rev N`), Ctrl+Z reverts the workbook fact
 * through the worker, and Ctrl+Y restores it. Runs against both real
 * worker backends via the shared demo.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

test.describe('vNext worker undo/redo real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('cell input records a backend history entry; Ctrl+Z clears it and Ctrl+Y restores it', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Seeding happens below the history system — the timeline starts empty.
    await expect(page.getByTestId('history-timeline-empty')).toBeVisible()

    await typeIntoCell(page, 'D1', 'hello')
    await expect(cellDisplay(page, 'D1')).toHaveText('hello')

    // The commit produced a backend transaction entry with a numeric revision.
    const entry = page.getByTestId('history-timeline-entry-0')
    await expect(entry).toHaveAttribute('data-kind', 'cell.set-input')
    await expect(entry).toContainText(/rev \d+/)
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('1 / 1')

    // Ctrl+Z reverts the committed input through the worker.
    await cell(page, 'D1').click()
    await page.keyboard.press('Control+z')
    await expect(cellDisplay(page, 'D1')).toHaveText('')
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('0 / 1')
    await expect(entry).toHaveAttribute('data-applied', 'false')

    // Ctrl+Y restores it.
    await page.keyboard.press('Control+y')
    await expect(cellDisplay(page, 'D1')).toHaveText('hello')
    await expect(page.getByTestId('history-timeline-cursor')).toHaveText('1 / 1')
    await expect(entry).toHaveAttribute('data-applied', 'true')
  })
})
