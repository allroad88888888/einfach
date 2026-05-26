import { test, expect, type Page } from '@playwright/test'

test.describe('vNext Wave 7.4 — Go To / Go To Special', () => {
  async function gotoWave5(page: Page) {
    await page.goto('/')
    await page.getByTestId('nav-tab-vnext-wave5').click()
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  }

  function cell(page: Page, addr: string) {
    return page
      .locator('[data-testid="wave5-grid"]')
      .locator(`td.cell[data-cell-addr="${addr}"]`)
  }

  test('Ctrl+G + "C5" + Enter navigates to C5', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await page.keyboard.press('ControlOrMeta+g')
    const dialog = page.getByTestId('wave5-go-to')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-active-tab', 'simple')

    const input = page.getByTestId('go-to-input')
    await input.fill('C5')
    await input.press('Enter')

    await expect(dialog).toBeHidden()
    await expect(cell(page, 'C5')).toHaveAttribute('data-active', 'true')
  })

  test('Special tab → Constants → Go selects a multi-region selection covering populated cells', async ({
    page,
  }) => {
    await gotoWave5(page)
    // Wave 5 fixture is a 9x6 populated matrix. The static backend projection
    // only materializes populated cells, so we pick the `constants` locator
    // (which matches every non-formula populated cell) and verify the dialog
    // closes and a populated cell other than the active one is selected.
    await cell(page, 'A1').click()

    await page.keyboard.press('ControlOrMeta+g')
    await expect(page.getByTestId('wave5-go-to')).toBeVisible()

    await page.getByTestId('go-to-tab-special').click()
    await expect(page.getByTestId('go-to-tab-special')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await page.getByTestId('go-to-locator-constants').click()
    await page.getByTestId('go-to-confirm-button').click()

    // Dialog closes after the multi-region commit.
    await expect(page.getByTestId('wave5-go-to')).toBeHidden({ timeout: 5_000 })

    // A populated cell other than the active one is now selected — verify
    // E4 (a number in the fixture) carries data-selected="true".
    await expect(cell(page, 'E4')).toHaveAttribute('data-selected', 'true')
  })
})
