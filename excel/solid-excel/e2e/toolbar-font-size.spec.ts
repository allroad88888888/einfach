import { test, expect, type Page, type Locator } from '@playwright/test'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string): Locator {
  return page.locator('[data-testid="wave5-grid"]').locator(
    `td.cell[data-cell-addr="${addr}"]`,
  )
}

function cellDisplay(page: Page, addr: string): Locator {
  return cell(page, addr).locator('.cell-display')
}

function fontSizeButton(page: Page) {
  return page.getByTestId('toolbar-btn-font-size')
}

function fontSizeUpButton(page: Page) {
  return page.getByTestId('toolbar-btn-font-size-up')
}

function fontSizeDownButton(page: Page) {
  return page.getByTestId('toolbar-btn-font-size-down')
}

function fontSizeDropdown(page: Page) {
  return page.getByTestId('toolbar-font-size-dropdown')
}

function fontSizeItem(page: Page, size: number | string): Locator {
  return page.getByTestId(`toolbar-font-size-item-${size}`)
}

function assertLocalizedLabel(label: string | null) {
  expect(label).toBeTruthy()
  expect(label).not.toBe('toolbar.fontSize')
  expect(label).not.toBe('toolbar.fontSize.title')
  expect(label).not.toContain('toolbar.')
}

test.describe('Wave 5 — Font Size toolbar', () => {
  test('font-size button is visible and uses translated button labels', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    const btn = fontSizeButton(page)
    await expect(btn).toBeVisible()
    const tooltip = await btn.getAttribute('data-tooltip')
    const ariaLabel = await btn.getAttribute('aria-label')
    assertLocalizedLabel(tooltip)
    assertLocalizedLabel(ariaLabel)

    await btn.click()
    await expect(fontSizeDropdown(page)).toBeVisible()
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  test('choosing 24px from dropdown applies size and closes dropdown', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await fontSizeButton(page).click()
    await expect(fontSizeDropdown(page)).toBeVisible()
    await fontSizeItem(page, 24).click()

    await expect(fontSizeDropdown(page)).toBeHidden()
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-size', '24px')
    await expect(fontSizeButton(page)).toHaveText('24')
  })

  test('font-size increase and decrease buttons adjust size by one', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    await expect(fontSizeButton(page)).toHaveText('12')
    await fontSizeUpButton(page).click()
    await expect(cellDisplay(page, 'C3')).toHaveCSS('font-size', '13px')
    await expect(fontSizeButton(page)).toHaveText('13')

    await fontSizeDownButton(page).click()
    await expect(cellDisplay(page, 'C3')).toHaveCSS('font-size', '12px')
    await expect(fontSizeButton(page)).toHaveText('12')
  })

  test('escape and outside click close font-size dropdown without changing font-size', async ({
    page,
  }) => {
    await gotoWave5(page)
    const target = 'D4'
    await cell(page, target).click()

    const baseButtonText = (await fontSizeButton(page).textContent())?.trim() ?? ''
    const baseFont = await cellDisplay(page, target).evaluate((el) =>
      getComputedStyle(el).fontSize,
    )
    await fontSizeButton(page).click()
    await expect(fontSizeDropdown(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(fontSizeDropdown(page)).toBeHidden()
    await expect(cellDisplay(page, target)).toHaveCSS('font-size', baseFont)
    await expect(fontSizeButton(page)).toHaveText(baseButtonText)

    await fontSizeButton(page).click()
    await expect(fontSizeDropdown(page)).toBeVisible()
    await page.getByTestId('wave5-formula-bar').click()
    await expect(fontSizeDropdown(page)).toBeHidden()
    await expect(cellDisplay(page, target)).toHaveCSS('font-size', baseFont)
    await expect(fontSizeButton(page)).toHaveText(baseButtonText)
  })
})
