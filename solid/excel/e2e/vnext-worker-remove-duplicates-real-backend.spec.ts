import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

async function selectRange(page: Page, anchor: string, focus: string) {
  await cell(page, anchor).click()
  await cell(page, focus).click({ modifiers: ['Shift'] })
}

async function gotoWasmWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page, 'backend=wasm&locale=en')
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function gotoTsWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page, 'backend=ts&locale=en')
  await page.getByRole('button', { name: 'Worker (TS core)', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-ts-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'B5')).toHaveText('60', { timeout: 30_000 })
}

test.describe('vNext Remove Duplicates real-worker capability', () => {
  test('WASM removes duplicate rows through the visible Data menu and exact ACK bridge', async ({
    page,
  }) => {
    await gotoWasmWorkerDemo(page)

    await typeIntoCell(page, 'D1', 'Key')
    await typeIntoCell(page, 'E1', 'Value')
    await typeIntoCell(page, 'D2', 'duplicate')
    await typeIntoCell(page, 'E2', '1')
    await typeIntoCell(page, 'D3', 'duplicate')
    await typeIntoCell(page, 'E3', '1')
    await typeIntoCell(page, 'D4', 'tail')
    await typeIntoCell(page, 'E4', '2')
    await selectRange(page, 'D1', 'E4')

    await page.getByTestId('menu-bar-button-data').click()
    const menuItem = page.getByTestId('menu-bar-item-data.removeDuplicates')
    await expect(menuItem).toBeVisible()
    await expect(menuItem).toBeEnabled()
    await menuItem.click()

    const dialog = page.getByTestId('vnext-worker-remove-duplicates')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('remove-duplicates-preview')).toContainText('1')
    await expect(page.getByTestId('remove-duplicates-confirm-button')).toBeEnabled()
    await page.getByTestId('remove-duplicates-confirm-button').click()

    await expect(dialog).toHaveCount(0)
    await expect(cellDisplay(page, 'D2')).toHaveText('duplicate')
    await expect(cellDisplay(page, 'E2')).toHaveText('1')
    await expect(cellDisplay(page, 'D3')).toHaveText('tail')
    await expect(cellDisplay(page, 'E3')).toHaveText('2')
    await expect(cellDisplay(page, 'D4')).toHaveText('')
    await expect(cellDisplay(page, 'E4')).toHaveText('')
    await expectNoConsoleErrors(page)
  })

  test('TS worker does not advertise Remove Duplicates while deleteRows is a no-op', async ({
    page,
  }) => {
    await gotoTsWorkerDemo(page)

    await page.getByTestId('menu-bar-button-data').click()
    await expect(page.getByTestId('menu-bar-item-data.removeDuplicates')).toHaveCount(0)
    await expect(page.getByTestId('vnext-worker-ts-remove-duplicates')).toHaveCount(0)
    await expectNoConsoleErrors(page)
  })
})
