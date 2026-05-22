import { test, expect, type Page } from '@playwright/test'
import { cell, cellDisplay, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function toolbarButton(page: Page, testId: string) {
  return page.getByTestId(testId)
}

async function expectToolbarLabel(
  button: ReturnType<Page['getByTestId']>,
  expected: string,
) {
  const tooltip = await button.getAttribute('data-tooltip')
  const ariaLabel = await button.getAttribute('aria-label')

  expect(tooltip).toBe(expected)
  expect(ariaLabel).toBe(expected)
  expect(tooltip).not.toContain('toolbar.')
  expect(ariaLabel).not.toContain('toolbar.')
}

test.describe('Wave 5 toolbar history buttons', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('undo and redo start disabled and use English labels', async ({ page }) => {
    await gotoWave5(page)

    const undoButton = toolbarButton(page, 'toolbar-btn-undo')
    const redoButton = toolbarButton(page, 'toolbar-btn-redo')

    await expect(undoButton).toBeDisabled()
    await expect(redoButton).toBeDisabled()
    await expectToolbarLabel(undoButton, 'Undo (Ctrl+Z)')
    await expectToolbarLabel(redoButton, 'Redo (Ctrl+Y)')
  })

  test('format changes enable undo, and undo/redo replay the cell format', async ({
    page,
  }) => {
    await gotoWave5(page)

    const target = 'B2'
    const display = cellDisplay(page, target)
    const boldButton = toolbarButton(page, 'toolbar-btn-bold')
    const undoButton = toolbarButton(page, 'toolbar-btn-undo')
    const redoButton = toolbarButton(page, 'toolbar-btn-redo')

    await cell(page, target).click()
    const initialFontWeight = await display.evaluate((el) => getComputedStyle(el).fontWeight)

    await expect(undoButton).toBeDisabled()
    await expect(redoButton).toBeDisabled()

    await boldButton.click()
    await expect(display).not.toHaveCSS('font-weight', initialFontWeight)
    await expect(undoButton).toBeEnabled()

    await undoButton.click()
    await expect(display).toHaveCSS('font-weight', initialFontWeight)
    await expect(redoButton).toBeEnabled()

    await redoButton.click()
    await expect(display).not.toHaveCSS('font-weight', initialFontWeight)
  })
})
