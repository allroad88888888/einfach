import { test, expect, type Page } from '@playwright/test'

/**
 * P1: i18n locale switcher.
 *
 * The app boots in `en`. Clicking the `中` button in the header should
 * flip every translated surface in one tick: app title, nav labels,
 * demo headings + descriptions, and the locale toggle's own labels.
 *
 * Coverage notes
 * --------------
 * - We assert AT LEAST one well-known string per surface (title, nav,
 *   demo heading), not every key in the catalog — checking the whole
 *   catalog would just re-encode it in the test file.
 * - The `nav.*` keys are deliberately translated for ZH (空白 / 公式 / …)
 *   while EN keeps the original literals. Other e2e specs depend on the
 *   EN labels via `gotoDemo(page, 'Blank' | 'Formulas' | …)`, so this
 *   spec exits back to `en` at the end of each test (Playwright tears
 *   down the page after each, but module-level state on the dev server
 *   doesn't get reset — the *page* state does because every test does
 *   a fresh `page.goto('/')`).
 * - No persistence layer yet: reload-and-still-zh is NOT a feature we
 *   ship, so we don't test it.
 */

function localeBtn(page: Page, label: 'EN' | '中') {
  return page.getByRole('button', { name: label, exact: true })
}

function appTitle(page: Page) {
  return page.locator('.app-title')
}

function demoH3(page: Page) {
  return page.locator('.demo-header h3')
}

async function gotoApp(page: Page) {
  await page.goto('/')
  // Default-active demo is "Blank" — its h3 is the first rendered.
  await expect(demoH3(page)).toBeVisible()
}

test.describe('i18n — locale switcher', () => {
  test('boots in EN', async ({ page }) => {
    await gotoApp(page)
    await expect(appTitle(page)).toHaveText('Einfach Excel')
    await expect(demoH3(page)).toHaveText('Blank Spreadsheet')
    // The EN locale button is the active one.
    await expect(localeBtn(page, 'EN')).toHaveAttribute('aria-pressed', 'true')
    await expect(localeBtn(page, '中')).toHaveAttribute('aria-pressed', 'false')
  })

  test('clicking 中 translates app title, nav, and current demo heading', async ({
    page,
  }) => {
    await gotoApp(page)
    await localeBtn(page, '中').click()

    // App chrome.
    await expect(appTitle(page)).toHaveText('Einfach 表格')
    await expect(localeBtn(page, '中')).toHaveAttribute('aria-pressed', 'true')

    // Nav labels — sample two from different groups.
    await expect(
      page.getByRole('button', { name: '空白', exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: '公式', exact: true })
    ).toBeVisible()
    // The original EN nav button is gone.
    await expect(
      page.getByRole('button', { name: 'Blank', exact: true })
    ).toHaveCount(0)

    // The currently active demo's heading flips too.
    await expect(demoH3(page)).toHaveText('空白表格')
  })

  test('switching demo while in ZH keeps the ZH catalog active', async ({
    page,
  }) => {
    await gotoApp(page)
    await localeBtn(page, '中').click()

    // Jump to Formulas via its translated nav label.
    await page.getByRole('button', { name: '公式', exact: true }).click()
    await expect(demoH3(page)).toHaveText('公式示例')
  })

  test('switching back to EN restores English everywhere', async ({ page }) => {
    await gotoApp(page)
    await localeBtn(page, '中').click()
    await expect(appTitle(page)).toHaveText('Einfach 表格')

    await localeBtn(page, 'EN').click()
    await expect(appTitle(page)).toHaveText('Einfach Excel')
    await expect(demoH3(page)).toHaveText('Blank Spreadsheet')
    await expect(
      page.getByRole('button', { name: 'Blank', exact: true })
    ).toBeVisible()
  })

  test('clicking the already-active locale is a no-op', async ({ page }) => {
    // Hard to assert "no re-render happened" from the outside, but at
    // minimum the visible state shouldn't change.
    await gotoApp(page)
    await expect(appTitle(page)).toHaveText('Einfach Excel')
    await localeBtn(page, 'EN').click()
    await expect(appTitle(page)).toHaveText('Einfach Excel')
    await expect(demoH3(page)).toHaveText('Blank Spreadsheet')
  })
})
