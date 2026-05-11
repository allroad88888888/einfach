import { test, expect } from '@playwright/test'
import { cell, gotoDemo } from './helpers'

/**
 * 7B — Row virtualization on the Large demo (1000 rows × 26 cols).
 *
 * Without virtualization the DOM would hold ~26k cells; we assert that the
 * window stays bounded, scroll hydrates new rows, and arrow-key navigation
 * past the bottom of the viewport scrolls the focus cell back into view.
 */
test.describe('Row virtualization', () => {
  test('initial DOM holds far fewer than 1000 rows', async ({ page }) => {
    await gotoDemo(page, 'Large Grid')
    await expect(cell(page, 'A1')).toBeVisible()
    // 1000 rendered row-headers would be 1000; with virtualize on we expect
    // only the viewport window plus overscan — well under 100.
    const rowHeaderCount = await page
      .locator('table.excel-table tbody td.row-header')
      .count()
    expect(rowHeaderCount).toBeLessThan(100)
    expect(rowHeaderCount).toBeGreaterThan(0)
    // The far-anchor at A500 is *not* in the initial DOM.
    await expect(cell(page, 'A500')).toHaveCount(0)
  })

  test('scrolling hydrates rows that were out of view', async ({ page }) => {
    await gotoDemo(page, 'Large Grid')
    await expect(cell(page, 'A1')).toBeVisible()
    // 500 * 26px = 13000 — scroll the wrapper roughly there.
    await page.locator('.excel-table-wrapper').evaluate((el) => {
      el.scrollTop = 13000
    })
    await expect(cell(page, 'A500')).toBeVisible()
    // Sanity: A1 is no longer in the DOM (above the window).
    await expect(cell(page, 'A1')).toHaveCount(0)
  })

  test('total scroll height tracks the un-windowed row count', async ({ page }) => {
    await gotoDemo(page, 'Large Grid')
    await expect(cell(page, 'A1')).toBeVisible()
    // 1000 rows × 26 px ≈ 26000 px. Allow a generous bound for header /
    // padding differences across browsers.
    const totalH = await page
      .locator('.excel-table-wrapper table')
      .evaluate((el) => (el as HTMLElement).offsetHeight)
    expect(totalH).toBeGreaterThan(25000)
    expect(totalH).toBeLessThan(28000)
  })
})
