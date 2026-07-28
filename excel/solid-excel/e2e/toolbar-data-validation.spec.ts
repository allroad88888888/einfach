import { expect, test, type Locator, type Page } from '@playwright/test'
import { cell, cellInput, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function dataValidationButton(page: Page) {
  return page.getByTestId('toolbar-btn-data-validation')
}

function dataValidationDialog(page: Page) {
  return page.getByTestId('wave5-data-validation')
}

async function enterDrafting(page: Page, addr: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  return input
}

function assertLocalizedLabel(label: string | null, rawKey: string, field: string) {
  expect(label, `${field} exists`).toBeTruthy()
  expect(label, `${field} is not raw key`).not.toBe(rawKey)
  expect(label, `${field} has no translation-token style`).not.toContain('.')
}

function validationKind(page: Page) {
  return dataValidationDialog(page).getByTestId('validation-kind-select')
}

function validationListValues(page: Page) {
  return dataValidationDialog(page).getByTestId('validation-list-values')
}

function validationSave(page: Page): Locator {
  return dataValidationDialog(page).getByTestId('validation-save-button')
}

function validationCancel(page: Page): Locator {
  return dataValidationDialog(page).getByTestId('validation-cancel-button')
}

test.describe('Wave 5 toolbar — data validation', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-btn-data-validation is visible, enabled, and not raw key', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    const button = dataValidationButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()

    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')
    assertLocalizedLabel(tooltip, 'toolbar.dataValidation.title', 'data-validation toolbar tooltip')
    assertLocalizedLabel(ariaLabel, 'toolbar.dataValidation.title', 'data-validation toolbar aria-label')
  })

  test('toolbar-btn-data-validation opens dialog and can create a list validation rule', async ({ page }) => {
    await gotoWave5(page)
    const target = 'C3'
    await cell(page, target).click()

    await dataValidationButton(page).click()
    const dialog = dataValidationDialog(page)
    await expect(dialog).toBeVisible()

    await expect(dialog.getByTestId('validation-range')).toBeVisible()
    await expect(validationKind(page)).toBeVisible()

    const listInput = validationListValues(page)
    await expect(listInput).toBeVisible()

    const beforeCode = (await cell(page, target).getAttribute('data-validation-code'))?.trim()
    await listInput.fill('North,South')
    await validationSave(page).click()

    await expect(dialog).toBeHidden()
    await expect(cell(page, target)).toHaveAttribute('data-validation-code', /validation\.list/)
    const afterCode = (await cell(page, target).getAttribute('data-validation-code'))?.trim()
    expect(afterCode).not.toBe(beforeCode)
  })

  test('data-validation dialog exposes initial controls and cancel path', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    await dataValidationButton(page).click()
    const dialog = dataValidationDialog(page)
    await expect(dialog).toBeVisible()

    await expect(dialog.getByTestId('validation-range')).toBeVisible()
    await expect(validationKind(page)).toBeVisible()

    await expect(validationListValues(page)).toBeVisible()
    await validationCancel(page).click()
    await expect(dialog).toBeHidden()
  })

  test('data-validation button is disabled while drafting, and should recover after commit', async ({
    page,
  }) => {
    await gotoWave5(page)
    const target = 'A1'
    const input = await enterDrafting(page, target)

    const button = dataValidationButton(page)
    await expect(button).toBeDisabled()

    await page.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(button).toBeEnabled()

  })
})
