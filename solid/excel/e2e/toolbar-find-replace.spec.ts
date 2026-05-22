import { expect, test, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function findReplaceButton(page: Page) {
  return page.getByTestId('toolbar-btn-find-replace')
}

function findReplaceDialog(page: Page) {
  return page.getByTestId('wave5-find-replace')
}

function findNeedleInput(page: Page) {
  return page.getByTestId('find-needle-input')
}

function findNextButton(page: Page) {
  return page.getByTestId('find-next-button')
}

function findCloseButton(page: Page) {
  return page.getByTestId('find-close-button')
}

function assertLocalizedLabel(label: string | null, context: string) {
  expect(label, `${context} exists`).toBeTruthy()
  expect(label, `${context} is not the raw i18n key`).not.toBe(
    'toolbar.findReplace.title',
  )
  expect(label, `${context} does not leak the i18n namespace`).not.toContain(
    'toolbar.',
  )
}

test.describe('Wave 5 toolbar — Find/Replace', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar button is visible, enabled, and labeled with localized text', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    const button = findReplaceButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    assertLocalizedLabel(
      await button.getAttribute('data-tooltip'),
      'toolbar-btn-find-replace data-tooltip',
    )
    assertLocalizedLabel(
      await button.getAttribute('aria-label'),
      'toolbar-btn-find-replace aria-label',
    )
  })

  test('clicking the toolbar button opens the Wave 5 find-replace dialog', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    const button = findReplaceButton(page)
    await expect(button).toBeEnabled()
    await button.click()

    await expect(findReplaceDialog(page)).toBeVisible()
  })

  test('find-next jumps to the North match and keeps the dialog open', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    const button = findReplaceButton(page)
    await expect(button).toBeEnabled()
    await button.click()

    const dialog = findReplaceDialog(page)
    await expect(dialog).toBeVisible()

    await findNeedleInput(page).fill('North')
    await findNextButton(page).click()

    await expect(dialog).toBeVisible()
    await expect(cell(page, 'A2')).toHaveAttribute('data-active', 'true')
  })

  test('close button dismisses the dialog', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    const button = findReplaceButton(page)
    await expect(button).toBeEnabled()
    await button.click()

    const dialog = findReplaceDialog(page)
    await expect(dialog).toBeVisible()

    await findCloseButton(page).click()
    await expect(dialog).toHaveCount(0)
  })
})
