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

  /**
   * Replace flow — these tests are the first end-to-end coverage for
   * `replace-tab`, `replace-button`, and `replace-all-button`. The static
   * Wave 5 backend ships a `replaceMatches` implementation that re-routes
   * each match through `updateCell`, so a single replace and a replace-all
   * both produce visible cell-display changes the test can assert on.
   */
  test('replace-tab reveals the replacement input and replace buttons', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await findReplaceButton(page).click()
    const dialog = findReplaceDialog(page)
    await expect(dialog).toBeVisible()

    // Find tab is active by default — replace-only controls are display:none.
    await expect(dialog.getByTestId('find-replacement-input')).toBeHidden()
    await expect(dialog.getByTestId('replace-button')).toBeHidden()
    await expect(dialog.getByTestId('replace-all-button')).toBeHidden()

    await dialog.getByTestId('replace-tab').click()
    await expect(dialog).toHaveAttribute('data-active-tab', 'replace')
    await expect(dialog.getByTestId('find-replacement-input')).toBeVisible()
    await expect(dialog.getByTestId('replace-button')).toBeVisible()
    await expect(dialog.getByTestId('replace-all-button')).toBeVisible()
  })

  test('replace-button rewrites the current match in place', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await findReplaceButton(page).click()
    const dialog = findReplaceDialog(page)
    await expect(dialog).toBeVisible()

    // Step 1: find "North" — cursor lands on A2 (matches the seeded matrix).
    await findNeedleInput(page).fill('North')
    await findNextButton(page).click()
    await expect(cell(page, 'A2')).toHaveAttribute('data-active', 'true')

    // Step 2: switch to replace tab + replace the active match only.
    await dialog.getByTestId('replace-tab').click()
    await dialog.getByTestId('find-replacement-input').fill('Northern')
    await dialog.getByTestId('replace-button').click()

    // Step 3: A2 now reads "Northern"; the dialog stays open and reruns its
    // search internally — status text re-renders without throwing.
    await expect(cell(page, 'A2').locator('.cell-display')).toHaveText('Northern')
    await expect(dialog).toBeVisible()
  })

  test('replace-all-button rewrites every match across the seeded sheet', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await findReplaceButton(page).click()
    const dialog = findReplaceDialog(page)
    await expect(dialog).toBeVisible()

    // Wave 5 seed has "500" in F4 (East total) and F7 (Mountain total) — both
    // come from the matrix and have no per-cell overrides. Replace-all should
    // rewrite both in one backend call.
    await findNeedleInput(page).fill('500')
    await findNextButton(page).click()
    // searchRange sorts by (row,col), so the first match focuses F4 (row 3 col 5).
    // Waiting here guarantees pageMatches is populated before we click
    // replace-all — without it, the async runSearch() may not have settled,
    // and the replace-all handler short-circuits on an empty pageMatches list.
    await expect(cell(page, 'F4')).toHaveAttribute('data-active', 'true')

    await dialog.getByTestId('replace-tab').click()
    await dialog.getByTestId('find-replacement-input').fill('999')
    await dialog.getByTestId('replace-all-button').click()

    await expect(cell(page, 'F4').locator('.cell-display')).toHaveText('999')
    await expect(cell(page, 'F7').locator('.cell-display')).toHaveText('999')
  })
})
