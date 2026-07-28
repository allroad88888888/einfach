import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

async function gotoWorkerDemo(page: Page) {
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function expectSingleCellSelection(page: Page, address: string, formulaInput: string) {
  await expect(cell(page, address)).toHaveAttribute('data-selected', 'true')
  await expect(cell(page, address)).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('name-box-input')).toHaveValue(address)
  await expect(page.getByTestId('formula-bar-addr')).toHaveText(address)
  await expect(page.getByTestId('formula-bar-input')).toHaveValue(formulaInput)
  await expect(page.getByTestId('status-active-cell')).toHaveText(address)
  await expect(page.getByTestId('status-selection')).toHaveText(address)
}

test.describe('vNext sheet lifecycle real-backend evidence', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('create, switch, rename, and delete round-trip through visible controls', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    const backend = test.info().project.name
    expect(['wasm', 'ts']).toContain(backend)
    expect(new URL(page.url()).searchParams.get('backend')).toBe(backend)
    const sheet1B4 = '10'
    const sheet3B4 = '100'

    const sheetTabs = page.getByTestId('vnext-worker-sheet-tabs')
    const sheet1 = sheetTabs.getByRole('tab', { name: 'Sheet1', exact: true })
    await expect(sheetTabs.getByRole('tab')).toHaveCount(3)
    await expect(sheet1).toHaveAttribute('data-active', 'true')

    await cell(page, 'B4').click()
    await expect(cellDisplay(page, 'B4')).toHaveText(sheet1B4)
    await expectSingleCellSelection(page, 'B4', sheet1B4)

    await page.getByTestId('sheet-tab-add').click()
    await expect(sheetTabs.getByRole('tab')).toHaveCount(4)
    const sheet4 = sheetTabs.getByRole('tab', { name: 'Sheet4', exact: true })
    await expect(sheet4).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'B4')).toHaveText('')
    await expectSingleCellSelection(page, 'B4', '')

    await sheet1.click()
    await expect(sheet1).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'B4')).toHaveText(sheet1B4)
    await expectSingleCellSelection(page, 'B4', sheet1B4)

    await page.getByTestId('vnext-worker-grid').focus()
    await page.keyboard.press('Control+PageDown')
    const sheet2 = sheetTabs.getByRole('tab', { name: 'Sheet2', exact: true })
    await expect(sheet2).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'B4')).toHaveText('')
    await expectSingleCellSelection(page, 'B4', '')

    await sheet4.click()
    await expect(sheet4).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'B4')).toHaveText('')
    await expectSingleCellSelection(page, 'B4', '')

    await sheet4.dblclick()
    const renameInput = page.locator('input.spreadsheet-sheet-tab-rename')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('Report')
    await renameInput.press('Enter')

    const report = sheetTabs.getByRole('tab', { name: 'Report', exact: true })
    await expect(report).toHaveAttribute('data-active', 'true')
    await expect(sheetTabs.getByRole('tab', { name: 'Sheet4', exact: true })).toHaveCount(0)
    await expectSingleCellSelection(page, 'B4', '')

    await report.click({ button: 'right' })
    await page.getByTestId('sheet-tab-menu-delete').click()
    await expect(page.getByTestId('sheet-tab-delete-confirmation')).toBeVisible()
    await page.getByTestId('sheet-tab-delete-confirm').click()

    await expect(report).toHaveCount(0)
    await expect(sheetTabs.getByRole('tab')).toHaveCount(3)
    const sheet3 = sheetTabs.getByRole('tab', { name: 'Sheet3', exact: true })
    await expect(sheet3).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'A1')).toHaveText('Sheet3')
    await expect(cellDisplay(page, 'C2')).toHaveText('11')
    await expect(cellDisplay(page, 'B4')).toHaveText(sheet3B4)
    await expectSingleCellSelection(page, 'B4', sheet3B4)
  })
})
