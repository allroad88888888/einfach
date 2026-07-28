import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function expectCanonicalA4Selection(page: Page) {
  await expect(page.getByTestId('name-box-input')).toHaveValue('A4')
  await expect(page.getByTestId('status-active-cell')).toHaveText('A4')
  await expect(page.getByTestId('status-selection')).toHaveText('A4')
  await expect(page.getByTestId('status-mode-badge')).toHaveAttribute('data-mode', 'ready')
  await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('1')
  await expect(cell(page, 'A4')).toHaveAttribute('data-active', 'true')
  await expect(cell(page, 'A4')).toHaveAttribute('data-selected', 'true')
  await expect(cell(page, 'B4')).toHaveAttribute('data-selected', 'false')
}

test.describe('vNext Text to Columns real-backend parity', () => {
  test('splits one selected text column and preserves canonical selection/status', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Seed through the visible Grid editor; no debug client or direct state write
    // participates in this real-backend evidence.
    await cell(page, 'A4').dblclick()
    const sourceInput = cell(page, 'A4').locator('.cell-input')
    await expect(sourceInput).toBeVisible()
    await sourceInput.fill('north,south')
    await sourceInput.press('Enter')
    await expect(sourceInput).toHaveCount(0)
    await expect(cellDisplay(page, 'A4')).toHaveText('north,south')
    await expect(cellDisplay(page, 'B4')).toHaveText('10')

    await cell(page, 'A4').click()
    await expectCanonicalA4Selection(page)

    const dataMenu = page.getByTestId('menu-bar-button-data')
    const textToColumnsItem = page.getByTestId('menu-bar-item-data.textToColumns')
    const dialog = page.getByTestId('vnext-worker-text-to-columns')

    await dataMenu.click()
    await expect(textToColumnsItem).toBeVisible()
    await expect(textToColumnsItem).toBeEnabled()
    await textToColumnsItem.click()

    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-step', 'step-1')
    await expect(dialog).toHaveAttribute('data-lifecycle', 'editing')
    await page.getByTestId('ttc-next-button').click()

    await expect(dialog).toHaveAttribute('data-step', 'step-2-delimited')
    await page.getByTestId('ttc-delim-tab').uncheck()
    await page.getByTestId('ttc-delim-comma').check()
    await expect(page.getByTestId('ttc-preview-cell-3-0')).toHaveText('north')
    await expect(page.getByTestId('ttc-preview-cell-3-1')).toHaveText('south')
    await page.getByTestId('ttc-next-button').click()

    await expect(dialog).toHaveAttribute('data-step', 'step-3')
    await expect(dialog).toHaveAttribute('data-lifecycle', 'editing')
    await expect(page.getByTestId('ttc-finish-button')).toBeEnabled()
    await page.getByTestId('ttc-finish-button').click()

    // Closing is the user-visible completion signal after import ACK and
    // projection refresh; the cells below are rendered from that projection.
    await expect(dialog).toHaveCount(0)
    await expect(cellDisplay(page, 'A4')).toHaveText('north')
    await expect(cellDisplay(page, 'B4')).toHaveText('south')
    await expectCanonicalA4Selection(page)
    await expectNoConsoleErrors(page)
  })
})
