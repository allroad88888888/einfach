import { expect, test, type Locator, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function nameManagerButton(page: Page) {
  return page.getByTestId('toolbar-btn-name-manager')
}

function nameManagerDialog(page: Page) {
  return page.getByTestId('wave5-name-manager')
}

function dialogField(dialog: Locator, testId: string) {
  return dialog.getByTestId(testId)
}

function assertLocalizedLabel(label: string | null, rawKey: string, field: string) {
  expect(label, `${field} exists`).toBeTruthy()
  expect(label, `${field} is not a raw key`).not.toBe(rawKey)
  expect(label, `${field} does not look like an i18n token`).not.toContain('.')
}

test.describe('Wave 5 toolbar — Name Manager', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-btn-name-manager is visible, enabled, and localized', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = nameManagerButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()

    assertLocalizedLabel(
      await button.getAttribute('data-tooltip'),
      'toolbar.nameManager.title',
      'toolbar-btn-name-manager data-tooltip',
    )
    assertLocalizedLabel(
      await button.getAttribute('aria-label'),
      'toolbar.nameManager.title',
      'toolbar-btn-name-manager aria-label',
    )
  })

  test('toolbar-btn-name-manager opens the dialog and exposes the editor controls', async ({
    page,
  }) => {
    await gotoWave5(page)
    await nameManagerButton(page).click()

    const dialog = nameManagerDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-label', 'Name Manager')
    await expect(dialogField(dialog, 'name-input')).toBeVisible()
    await expect(dialogField(dialog, 'name-input')).toHaveValue('')
    await expect(dialogField(dialog, 'name-scope-select')).toBeVisible()
    await expect(dialogField(dialog, 'name-scope-select')).toHaveValue('workbook')
    await expect(dialogField(dialog, 'name-refers-to')).toBeVisible()
    await expect(dialogField(dialog, 'name-refers-to')).toHaveValue('')
    await expect(dialogField(dialog, 'name-list')).toBeVisible()
    await expect(dialogField(dialog, 'name-save-button')).toBeVisible()
    await expect(dialogField(dialog, 'name-delete-button')).toBeDisabled()
    await expect(dialogField(dialog, 'name-close-button')).toBeVisible()
    await expect(dialogField(dialog, 'dialog-close-x')).toBeVisible()
  })

  test('Escape closes the dialog', async ({ page }) => {
    await gotoWave5(page)
    await nameManagerButton(page).click()

    const dialog = nameManagerDialog(page)
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('save persists a name, closes the dialog, and reopening starts a clean draft', async ({
    page,
  }) => {
    await gotoWave5(page)
    await nameManagerButton(page).click()

    const dialog = nameManagerDialog(page)
    await expect(dialog).toBeVisible()

    await dialogField(dialog, 'name-input').fill('PlaywrightWave5Name')
    await dialogField(dialog, 'name-refers-to').fill('sheet-1!A1:B2')
    await dialogField(dialog, 'name-scope-select').selectOption('sheet-2')

    await dialogField(dialog, 'name-save-button').click()
    await expect(dialog).toHaveCount(0)

    await nameManagerButton(page).click()
    await expect(dialog).toBeVisible()
    await expect(dialogField(dialog, 'name-list')).toContainText('PlaywrightWave5Name')
    await expect(dialogField(dialog, 'name-input')).toHaveValue('')
    await expect(dialogField(dialog, 'name-refers-to')).toHaveValue('')
    await expect(dialogField(dialog, 'name-scope-select')).toHaveValue('workbook')
  })

  test('close button closes the dialog and resets an unsaved draft form', async ({ page }) => {
    await gotoWave5(page)
    await nameManagerButton(page).click()

    const dialog = nameManagerDialog(page)
    await expect(dialog).toBeVisible()

    await dialogField(dialog, 'name-input').fill('UnsavedWave5Name')
    await dialogField(dialog, 'name-refers-to').fill('sheet-1!A1:B2')
    await dialogField(dialog, 'name-scope-select').selectOption('sheet-2')

    await dialogField(dialog, 'name-close-button').click()
    await expect(dialog).toHaveCount(0)

    await nameManagerButton(page).click()
    await expect(dialog).toBeVisible()
    await expect(dialogField(dialog, 'name-input')).toHaveValue('')
    await expect(dialogField(dialog, 'name-refers-to')).toHaveValue('')
    await expect(dialogField(dialog, 'name-scope-select')).toHaveValue('workbook')
  })
})
