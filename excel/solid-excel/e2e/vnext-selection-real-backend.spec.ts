import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

test.describe('vNext multi-selection real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('modifier-click appends a non-contiguous region and plain click clears to one', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    const backend = test.info().project.name
    expect(['wasm', 'ts']).toContain(backend)
    expect(new URL(page.url()).searchParams.get('backend')).toBe(backend)

    await cell(page, 'B4').click()
    await expect(cell(page, 'B4')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'B4')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('name-box-input')).toHaveValue('B4')
    await expect(page.getByTestId('status-selection')).toHaveText('B4')
    await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('1')

    const additiveModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await cell(page, 'C2').click({ modifiers: [additiveModifier] })

    // Both disjoint regions remain selected, while the newly appended region
    // becomes the single primary/active cell exposed by the product UI.
    await expect(cell(page, 'B4')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C2')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'B3')).toHaveAttribute('data-selected', 'false')
    await expect(cell(page, 'B4')).toHaveAttribute('data-active', 'false')
    await expect(cell(page, 'C2')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('name-box-input')).toHaveValue('C2')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C2')
    await expect(page.getByTestId('status-selection')).toHaveText('C2')
    await expect(page.getByTestId('status-aggregate-sum-value')).toHaveText('23')
    await expect(page.getByTestId('status-aggregate-average-value')).toHaveText('11.5')
    await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('2')

    // A modifier-free click replaces the multi-region state with one cell.
    await cell(page, 'B4').click()
    await expect(cell(page, 'B4')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'B4')).toHaveAttribute('data-active', 'true')
    await expect(cell(page, 'C2')).toHaveAttribute('data-selected', 'false')
    await expect(cell(page, 'C2')).toHaveAttribute('data-active', 'false')
    await expect(page.getByTestId('name-box-input')).toHaveValue('B4')
    await expect(page.getByTestId('status-active-cell')).toHaveText('B4')
    await expect(page.getByTestId('status-selection')).toHaveText('B4')
    await expect(page.getByTestId('status-aggregate-sum-value')).toHaveText('10')
    await expect(page.getByTestId('status-aggregate-average-value')).toHaveText('10')
    await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('1')
  })
})
