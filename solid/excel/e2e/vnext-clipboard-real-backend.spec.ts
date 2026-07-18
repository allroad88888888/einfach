import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  grantClipboard,
  guardConsoleErrors,
} from './helpers'

async function gotoWorkerDemo(page: Page) {
  await gotoRoot(page, 'locale=en')
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function pressClipboardShortcut(page: Page, key: 'c' | 'v' | 'x') {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+${key}`)
}

function expectRealBackend(page: Page) {
  const backend = test.info().project.name
  expect(['wasm', 'ts']).toContain(backend)
  expect(new URL(page.url()).searchParams.get('backend')).toBe(backend)
}

test.describe('vNext clipboard real-backend evidence', () => {
  test.beforeEach(async ({ context, page }) => {
    await grantClipboard(context)
    guardConsoleErrors(page)
  })

  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('copy/paste preserves the source and exposes the populated target state', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)
    expectRealBackend(page)

    await cell(page, 'B4').click()
    await expect(cellDisplay(page, 'B4')).toHaveText('10')
    await pressClipboardShortcut(page, 'c')
    await expect(page.getByTestId('status-last-command')).toHaveText('Clipboard copy')

    await cell(page, 'D4').click()
    await pressClipboardShortcut(page, 'v')

    await expect(cellDisplay(page, 'B4')).toHaveText('10')
    await expect(cellDisplay(page, 'D4')).toHaveText('10')
    await expect(cell(page, 'D4')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'D4')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('name-box-input')).toHaveValue('D4')
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('10')
    await expect(page.getByTestId('status-active-cell')).toHaveText('D4')
    await expect(page.getByTestId('status-selection')).toHaveText('D4')
    await expect(page.getByTestId('status-last-command')).toHaveText('Clipboard paste')
    await expect(page.getByTestId('status-aggregate-sum-value')).toHaveText('10')
    await expect(page.getByTestId('status-aggregate-average-value')).toHaveText('10')
    await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('1')
  })

  test('cut/paste clears the source and exposes the moved target state', async ({ page }) => {
    await gotoWorkerDemo(page)
    expectRealBackend(page)

    await cell(page, 'C4').click()
    await expect(cellDisplay(page, 'C4')).toHaveText('source')
    await pressClipboardShortcut(page, 'x')

    await expect(cell(page, 'C4')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C4')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C4')
    await expect(page.getByTestId('status-selection')).toHaveText('C4')
    await expect(page.getByTestId('status-last-command')).toHaveText('Clipboard cut')

    await cell(page, 'E4').click()
    await pressClipboardShortcut(page, 'v')

    await expect(cellDisplay(page, 'C4')).toHaveText('')
    await expect(cellDisplay(page, 'E4')).toHaveText('source')
    await expect(cell(page, 'C4')).toHaveAttribute('data-selected', 'false')
    await expect(cell(page, 'E4')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'E4')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('name-box-input')).toHaveValue('E4')
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('source')
    await expect(page.getByTestId('status-active-cell')).toHaveText('E4')
    await expect(page.getByTestId('status-selection')).toHaveText('E4')
    await expect(page.getByTestId('status-last-command')).toHaveText('Clipboard paste')
    await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('1')
  })
})
