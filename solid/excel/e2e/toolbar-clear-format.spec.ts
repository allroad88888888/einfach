import { expect, test, type Page } from '@playwright/test'
import { cell, cellDisplay, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function clearFormatButton(page: Page) {
  return page.getByTestId('toolbar-btn-clear-format')
}

function boldButton(page: Page) {
  return page.getByTestId('toolbar-btn-bold')
}

function fillColorButton(page: Page) {
  return page.getByTestId('toolbar-btn-fill-color')
}

function textColorButton(page: Page) {
  return page.getByTestId('toolbar-btn-text-color')
}

async function readDisplayFormat(page: Page, addr: string) {
  const display = cellDisplay(page, addr)
  const gridCell = cell(page, addr)
  const displayStyle = await display.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      fontWeight: style.fontWeight,
      color: style.color,
    }
  })
  const gridStyle = await gridCell.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      backgroundColor: style.backgroundColor,
    }
  })

  return {
    ...displayStyle,
    backgroundColor: gridStyle.backgroundColor,
  }
}

async function pickSwatch(page: Page, colorHex: string) {
  const popover = page.getByTestId('toolbar-color-popover')
  await expect(popover).toBeVisible()
  await page.getByTestId(`color-popover-swatch-${colorHex}`).click()
  await expect(popover).toBeHidden()
}

test.describe('Toolbar — Clear format', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('clear-format labels are in plain EN, not raw i18n keys', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    const button = clearFormatButton(page)
    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')

    expect(tooltip).toBe('Clear formatting')
    expect(ariaLabel).toBe('Clear formatting')
    expect(tooltip).not.toContain('.')
    expect(ariaLabel).not.toContain('.')
  })

  test('clear-format starts disabled and becomes enabled after formatting changes', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = clearFormatButton(page)
    const bold = boldButton(page)
    await expect(button).toBeDisabled()

    await bold.click()
    await expect(button).toBeEnabled()

    await bold.click()
    await expect(button).toBeDisabled()
  })

  test('clear-format removes bold/fill/text color and disables itself again', async ({
    page,
  }) => {
    await gotoWave5(page)
    const target = 'B2'
    await cell(page, target).click()
    const button = clearFormatButton(page)

    const before = await readDisplayFormat(page, target)
    await expect(button).toBeDisabled()

    await boldButton(page).click()
    await fillColorButton(page).click()
    await pickSwatch(page, '#ffd966')
    await textColorButton(page).click()
    await pickSwatch(page, '#ff0000')

    const withFormat = await readDisplayFormat(page, target)
    expect(withFormat.fontWeight).not.toBe(before.fontWeight)
    expect(withFormat.backgroundColor).not.toBe(before.backgroundColor)
    expect(withFormat.color).not.toBe(before.color)
    await expect(button).toBeEnabled()

    await button.click()
    await expect(button).toBeDisabled()

    const after = await readDisplayFormat(page, target)
    expect(after.fontWeight).toBe(before.fontWeight)
    expect(after.backgroundColor).toBe(before.backgroundColor)
    expect(after.color).toBe(before.color)
  })
})
