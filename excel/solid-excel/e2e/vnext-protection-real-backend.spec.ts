import { expect, test, type Page } from '@playwright/test'

import { cell, cellDisplay, cellInput, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

/**
 * Sheet protection on the worker demos (UI-core canonical, phase 2/3).
 *
 * Format menu → Protect sheet blocks the cell editor (double-click and
 * type-to-edit both refuse to open it); Format menu → Unprotect sheet
 * restores editing. Runs against both real worker backends — the worker
 * runtimes expose no protection port, so this proves the local canonical
 * path works everywhere.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function clickFormatMenuItem(page: Page, itemId: string) {
  await page.getByTestId('menu-bar-button-format').click()
  await expect(page.getByTestId('menu-bar-dropdown-format')).toBeVisible()
  await page.getByTestId(`menu-bar-item-${itemId}`).click()
  await expect(page.getByTestId('menu-bar-dropdown-format')).toHaveCount(0)
}

test.describe('vNext sheet protection real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('protect sheet blocks the editor; unprotect restores editing', async ({ page }) => {
    await gotoWorkerDemo(page)

    // Baseline: B4 is editable before protection.
    await cell(page, 'B4').dblclick()
    const baselineEditor = cellInput(page, 'B4')
    await expect(baselineEditor).toBeVisible()
    await expect(baselineEditor).toHaveValue('10')
    await baselineEditor.press('Escape')
    await expect(baselineEditor).toHaveCount(0)

    // Protect the sheet from the Format menu.
    await clickFormatMenuItem(page, 'format.protectSheet')

    // Double-click on a locked cell no longer opens the editor.
    await cell(page, 'B4').dblclick()
    await expect(cell(page, 'B4')).toHaveAttribute('data-active', 'true')
    await expect(cellInput(page, 'B4')).toHaveCount(0)

    // Type-to-edit is blocked too: the display value stays untouched.
    await page.keyboard.press('x')
    await expect(cellInput(page, 'B4')).toHaveCount(0)
    await expect(cellDisplay(page, 'B4')).toHaveText('10')

    // Unprotect from the Format menu → editing works again.
    await clickFormatMenuItem(page, 'format.unprotectSheet')

    await cell(page, 'B4').dblclick()
    const editor = cellInput(page, 'B4')
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue('10')
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(cellDisplay(page, 'B4')).toHaveText('10')
  })
})
