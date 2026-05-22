import { expect, test, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function conditionalFormatButton(page: Page) {
  return page.getByTestId('toolbar-btn-conditional-format')
}

function conditionalFormatDialog(page: Page) {
  return page.getByTestId('wave5-conditional-format')
}

function assertLocalizedLabel(label: string | null, rawKey: string, field: string) {
  expect(label, `${field} exists`).toBeTruthy()
  expect(label, `${field} is not raw key`).not.toBe(rawKey)
  expect(label, `${field} has no translation token punctuation`).not.toContain('.')
}

test.describe('Wave 5 toolbar — conditional formatting', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-btn-conditional-format is visible, enabled, and not raw keys', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    const button = conditionalFormatButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()

    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')
    assertLocalizedLabel(tooltip, 'toolbar.condFmt.title', 'toolbar-btn-conditional-format data-tooltip')
    assertLocalizedLabel(ariaLabel, 'toolbar.condFmt.title', 'toolbar-btn-conditional-format aria-label')

    await button.click()
    await expect(conditionalFormatDialog(page)).toBeVisible()
  })

  test('conditional-format dialog opens and basic controls exist', async ({ page }) => {
    await gotoWave5(page)
    const target = 'C3'
    await cell(page, target).click()
    await conditionalFormatButton(page).click()

    const dialog = conditionalFormatDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('cf-rule-kind-select')).toBeVisible()
    await expect(dialog.getByTestId('cf-rule-list')).toBeVisible()
    await expect(dialog.getByTestId('cf-save-button')).toBeVisible()
    await expect(dialog.getByTestId('cf-cancel-button')).toBeVisible()
    await expect(dialog.getByTestId('cf-remove-button')).toBeVisible()
    await expect(dialog.getByTestId('dialog-close-x')).toBeVisible()

    await dialog.getByTestId('cf-save-button').click()
    await expect(dialog).toBeHidden()
    await expect(cell(page, target)).toHaveAttribute('data-has-conditional-format', 'true')
  })

  test('conditional-format dialog closes with Escape and header close X', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()
    const button = conditionalFormatButton(page)

    await button.click()
    const dialog = conditionalFormatDialog(page)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await button.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('dialog-close-x')).toBeVisible()
    await dialog.getByTestId('dialog-close-x').click()
    await expect(dialog).toBeHidden()
  })
})
