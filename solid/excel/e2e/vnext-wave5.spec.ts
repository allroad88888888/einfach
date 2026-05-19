import { test, expect, type Page } from '@playwright/test'

test.describe('vNext Wave 5 — shell + canvas overlay', () => {
  async function gotoWave5(page: Page) {
    await page.goto('/')
    // Wave 5 is now the default tab, but click the nav anyway to make the
    // test independent of which default the app ships with. Use the testid
    // so the test is locale-independent.
    await page.getByTestId('nav-tab-vnext-wave5').click()
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  }

  function cell(page: Page, addr: string) {
    return page.locator('[data-testid="wave5-grid"]').locator(
      `td.cell[data-cell-addr="${addr}"]`,
    )
  }

  test('demo loads with all Wave 5 surfaces mounted', async ({ page }) => {
    await gotoWave5(page)
    await expect(page.getByTestId('wave5-menu-bar')).toBeVisible()
    await expect(page.getByTestId('wave5-toolbar')).toBeVisible()
    await expect(page.getByTestId('wave5-formula-bar')).toBeVisible()
    await expect(page.getByTestId('wave5-status-bar')).toBeVisible()
    await expect(page.getByTestId('grid-overlay-canvas')).toBeVisible()
    await expect(cell(page, 'A1')).toBeVisible()
  })

  test('menu bar opens File and dispatches Undo', async ({ page }) => {
    await gotoWave5(page)
    const fileButton = page.getByTestId('wave5-menu-bar').getByRole('button', { name: /^File/ })
    await fileButton.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('name box reflects active cell and jumps on commit', async ({ page }) => {
    await gotoWave5(page)
    const nameBox = page.getByTestId('name-box-input')
    await expect(nameBox).toBeVisible()
    await expect(nameBox).toHaveValue('A1')

    await nameBox.click()
    await nameBox.fill('C4')
    await nameBox.press('Enter')

    await expect(nameBox).toHaveValue('C4')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C4')
  })

  test('status bar surfaces selection aggregates over a numeric range', async ({ page }) => {
    await gotoWave5(page)

    await cell(page, 'B2').click()
    await cell(page, 'E8').click({ modifiers: ['Shift'] })

    const sum = page.getByTestId('status-aggregate-sum')
    const avg = page.getByTestId('status-aggregate-average')
    const count = page.getByTestId('status-aggregate-count')

    await expect(sum).toBeVisible()
    await expect(avg).toBeVisible()
    await expect(count).toBeVisible()
    await expect(count).toContainText(/\d+/)
  })

  test('zoom slider shows current zoom level', async ({ page }) => {
    await gotoWave5(page)
    const zoom = page.getByTestId('status-zoom-value')
    await expect(zoom).toHaveText('100%')

    const preset125 = page.getByTestId('status-zoom-preset-125')
    await preset125.click()
    await expect(zoom).toHaveText('125%')

    const preset100 = page.getByTestId('status-zoom-preset-100')
    await preset100.click()
    await expect(zoom).toHaveText('100%')
  })

  test('canvas overlay mounts with pointer-events: none', async ({ page }) => {
    await gotoWave5(page)
    const canvas = page.getByTestId('grid-overlay-canvas')
    await expect(canvas).toBeVisible()
    const pointerEvents = await canvas.evaluate((el) => getComputedStyle(el).pointerEvents)
    expect(pointerEvents).toBe('none')

    await cell(page, 'B2').click()
    await expect(cell(page, 'B2')).toHaveAttribute('data-active', 'true')
  })

  test('format painter toolbar button arms the painter', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    const painterButton = page.getByTestId('toolbar-btn-format-painter')
    await expect(painterButton).toBeVisible()
    await expect(painterButton).toHaveAttribute('data-format-painter-state', 'idle')

    await painterButton.click()
    await expect(painterButton).toHaveAttribute('data-format-painter-state', 'armed')

    await page.keyboard.press('Escape')
    await expect(painterButton).toHaveAttribute('data-format-painter-state', 'idle')
  })
})
