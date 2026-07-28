import { expect, test, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  guardConsoleErrors,
  withEnglishLocale,
} from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function painterButton(page: Page) {
  return page.getByTestId('toolbar-btn-format-painter')
}

function boldButton(page: Page) {
  return page.getByTestId('toolbar-btn-bold')
}

function expectLocalizedLabel(actual: string | null, raw: string, name: string) {
  expect(actual, `${name} exists`).toBeTruthy()
  expect(actual, `${name} is not raw key`).not.toBe(raw)
  expect(actual, `${name} is not path-like`).not.toContain('toolbar.')
}

test.describe('Wave 5 toolbar format painter', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('format painter button is visible, enabled, and localised', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = painterButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute('data-format-painter-state', 'idle')
    await expect(button).toHaveAttribute('aria-pressed', 'false')

    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')

    expectLocalizedLabel(tooltip, 'toolbar.painter.title', 'format painter tooltip')
    expectLocalizedLabel(ariaLabel, 'toolbar.painter', 'format painter aria-label')
  })

  test('single-click painter copies format once and returns to idle', async ({ page }) => {
    await gotoWave5(page)
    const source = 'B2'
    const target = 'C2'
    const skipTarget = 'D2'

    await cell(page, source).click()
    await boldButton(page).click()
    await expect(cellDisplay(page, source)).toHaveCSS('font-weight', '700')

    const painter = painterButton(page)
    await painter.click()
    await expect(painter).toHaveAttribute('data-format-painter-state', 'armed')
    await expect(painter).toHaveAttribute('aria-pressed', 'true')

    await cell(page, target).click()
    await expect(cellDisplay(page, target)).toHaveCSS('font-weight', '700')
    await expect(painter).toHaveAttribute('data-format-painter-state', 'idle')
    await expect(painter).toHaveAttribute('aria-pressed', 'false')

    await cell(page, skipTarget).click()
    await expect(cellDisplay(page, skipTarget)).not.toHaveCSS('font-weight', '700')
  })

  test('single-click painter restores a formatted target from an unformatted source', async ({
    page,
  }) => {
    await gotoWave5(page)
    const target = 'B2'
    const unformattedSource = 'C2'

    await cell(page, unformattedSource).click()
    await expect(cellDisplay(page, unformattedSource)).not.toHaveCSS('font-weight', '700')

    await cell(page, target).click()
    await boldButton(page).click()
    await expect(cellDisplay(page, target)).toHaveCSS('font-weight', '700')

    await cell(page, unformattedSource).click()
    const painter = painterButton(page)
    await painter.click()
    await expect(painter).toHaveAttribute('data-format-painter-state', 'armed')
    await expect(painter).toHaveAttribute('aria-pressed', 'true')

    await cell(page, target).click()
    await expect(cellDisplay(page, target)).not.toHaveCSS('font-weight', '700')
    await expect(painter).toHaveAttribute('data-format-painter-state', 'idle')
    await expect(painter).toHaveAttribute('aria-pressed', 'false')
    await expectNoConsoleErrors(page)
  })

  test('Escape closes an armed painter before any target is painted', async ({ page }) => {
    await gotoWave5(page)
    const source = 'B2'
    const untouchedTarget = 'D2'

    await cell(page, source).click()
    await boldButton(page).click()
    await expect(cellDisplay(page, source)).toHaveCSS('font-weight', '700')

    const painter = painterButton(page)
    await painter.click()
    await expect(painter).toHaveAttribute('data-format-painter-state', 'armed')

    await page.keyboard.press('Escape')
    await expect(painter).toHaveAttribute('data-format-painter-state', 'idle')
    await expect(painter).toHaveAttribute('aria-pressed', 'false')

    await cell(page, untouchedTarget).click()
    await expect(cellDisplay(page, untouchedTarget)).not.toHaveCSS('font-weight', '700')
  })

  test('double-click painter enters sticky mode and applies to two cells, then exits with Escape', async ({
    page,
  }) => {
    await gotoWave5(page)
    const source = 'B2'
    const firstTarget = 'D2'
    const secondTarget = 'E2'
    const skipTarget = 'F2'

    await cell(page, source).click()
    await boldButton(page).click()
    await expect(cellDisplay(page, source)).toHaveCSS('font-weight', '700')

    const painter = painterButton(page)
    await painter.dblclick()
    await expect(painter).toHaveAttribute('data-format-painter-state', 'sticky')
    await expect(painter).toHaveAttribute('aria-pressed', 'true')

    const tooltip = await painter.getAttribute('data-tooltip')
    const ariaLabel = await painter.getAttribute('aria-label')
    expectLocalizedLabel(tooltip, 'toolbar.painter.title.sticky', 'format painter tooltip')
    expectLocalizedLabel(ariaLabel, 'toolbar.painter', 'format painter aria-label')

    await cell(page, firstTarget).click()
    await expect(cellDisplay(page, firstTarget)).toHaveCSS('font-weight', '700')
    await expect(painter).toHaveAttribute('data-format-painter-state', 'sticky')

    await cell(page, secondTarget).click()
    await expect(cellDisplay(page, secondTarget)).toHaveCSS('font-weight', '700')
    await expect(painter).toHaveAttribute('data-format-painter-state', 'sticky')

    await page.keyboard.press('Escape')
    await expect(painter).toHaveAttribute('data-format-painter-state', 'idle')
    await expect(painter).toHaveAttribute('aria-pressed', 'false')

    await cell(page, skipTarget).click()
    await expect(cellDisplay(page, skipTarget)).not.toHaveCSS('font-weight', '700')
  })

  test('re-clicking a sticky painter toggles it off without painting further', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await boldButton(page).click()

    const painter = painterButton(page)
    await painter.dblclick()
    await expect(painter).toHaveAttribute('data-format-painter-state', 'sticky')

    await painter.click()
    await expect(painter).toHaveAttribute('data-format-painter-state', 'idle')
  })
})
