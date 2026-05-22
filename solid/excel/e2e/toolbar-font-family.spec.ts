import { test, expect, type Page } from '@playwright/test'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string) {
  return page.locator('[data-testid="wave5-grid"]').locator(
    `td.cell[data-cell-addr="${addr}"]`,
  )
}

function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

function fontFamilyButton(page: Page) {
  return page.getByTestId('toolbar-btn-font-family')
}

function fontFamilyDropdown(page: Page) {
  return page.getByTestId('toolbar-font-family-dropdown')
}

function fontFamilyOptionHelvetica(page: Page) {
  return page.getByTestId('toolbar-font-family-item-Helvetica')
}

async function readCellFontFamily(page: Page, addr: string) {
  return cellDisplay(page, addr).evaluate((el) => getComputedStyle(el).fontFamily)
}

test.describe('Wave 5 toolbar — font family', () => {
  test('font-family button is visible, has localized tooltip/aria labels, and opens dropdown', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = fontFamilyButton(page)
    await expect(button).toBeVisible()
    const ariaLabel = (await button.getAttribute('aria-label')) ?? ''
    const tooltip = (await button.getAttribute('data-tooltip')) ?? ''

    expect(ariaLabel).toBeTruthy()
    expect(tooltip).toBeTruthy()
    expect(ariaLabel).not.toContain('toolbar.')
    expect(tooltip).not.toContain('toolbar.')
    expect(ariaLabel).not.toBe('toolbar.fontFamily.title')
    expect(tooltip).not.toBe('toolbar.fontFamily.title')

    await button.click()
    await expect(fontFamilyDropdown(page)).toBeVisible()
  })

  test('selecting Helvetica closes dropdown, updates cell font-family, and updates button text', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = fontFamilyButton(page)
    const dropdown = fontFamilyDropdown(page)
    const initialButtonText = (await button.textContent()) ?? ''

    await button.click()
    await expect(dropdown).toBeVisible()
    await fontFamilyOptionHelvetica(page).click()

    await expect(dropdown).toBeHidden()
    await expect(button).toHaveText('Helvetica')
    await expect(button).not.toHaveText(initialButtonText)

    const fontFamily = (await readCellFontFamily(page, 'B2')).toLowerCase()
    expect(fontFamily).toContain('helvetica')
  })

  test('Escape closes font-family dropdown without changing selected cell font-family', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const before = await readCellFontFamily(page, 'B2')
    await fontFamilyButton(page).click()
    await expect(fontFamilyDropdown(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(fontFamilyDropdown(page)).toBeHidden()

    const after = await readCellFontFamily(page, 'B2')
    expect(after).toBe(before)
  })

  test('outside click closes font-family dropdown without changing selected cell font-family', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const before = await readCellFontFamily(page, 'B2')
    await fontFamilyButton(page).click()
    await expect(fontFamilyDropdown(page)).toBeVisible()

    await page.getByTestId('wave5-formula-bar').click()
    await expect(fontFamilyDropdown(page)).toBeHidden()

    const after = await readCellFontFamily(page, 'B2')
    expect(after).toBe(before)
  })
})
