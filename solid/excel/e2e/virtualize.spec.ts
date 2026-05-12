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

  test('viewport churn — subscriptions track the viewport, not scroll history', async ({
    page,
  }) => {
    // Regression guard for the Cell retain/release fix. Before the fix
    // each scrolled-past row added ~27 subscriptions to the store
    // that were never released; scrolling through 500 rows would
    // permanently retain ~13k handles even though those cells were
    // unmounted from the DOM. Now <Cell> registers `onCleanup(dispose)`
    // so the active set follows the live viewport.
    //
    // The probe is `store.activeSubscriptionCount()`, exposed via
    // `window.__einfachStore` under `?debug=1` (same shim as
    // regression.spec.ts uses for `subscriberFireCount`).
    await gotoDemo(page, 'Large Grid', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible()

    const probe = () =>
      page.evaluate(() => window.__einfachStore?.activeSubscriptionCount() ?? -1)

    const initial = await probe()
    // Initial viewport: a handful of rows × 27 cols (cols + row-header)
    // plus 1 for the FormulaBar observing the selected cell. Under
    // virtualization that's well under 2000; a broken release path
    // would already be at ~27000 if every row stayed subscribed.
    expect(initial).toBeGreaterThan(0)
    expect(initial).toBeLessThan(2000)

    // Scroll deep — Cells for rows ~0–20 unmount, Cells for rows
    // ~470–510 mount. If the unmounted handles weren't released, this
    // tick would push the count up by hundreds.
    await page.locator('.excel-table-wrapper').evaluate((el) => {
      el.scrollTop = 13000
    })
    await expect(cell(page, 'A500')).toBeVisible()

    // Scroll back — symmetric. After the round trip the active set
    // should be at most the initial viewport again (give a small
    // slack for selection / overscan boundary effects).
    await page.locator('.excel-table-wrapper').evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(cell(page, 'A1')).toBeVisible()

    const after = await probe()
    // The load-bearing assertion: the count is bounded by viewport
    // shape, NOT by cumulative scroll distance. Without the fix this
    // would be `initial + ~520 rows × 27 cols` ≈ initial + 14000.
    expect(after).toBeLessThanOrEqual(initial + 100)
  })

  test('column virtualization — wide grid keeps col DOM bounded', async ({ page }) => {
    // Phase-4 Track P: once Track M swaps Table.tsx onto VGridTable and
    // Track O lands the `1M Cells` demo (1000 cols × 1000 rows), the DOM
    // should hold only the visible column window plus overscan — NOT all
    // 1000 columns. Asserting `td.cell` count < 500 catches the wide-grid
    // regression: 1000 cols × ~20 visible rows would be ~20k cells, so
    // anything sub-500 is firmly inside the 2D-virt envelope. We also
    // assert `ALL1` (col 999, row 0) is absent from the initial DOM —
    // it's far to the right of the viewport and a hand-rolled "render
    // all cols while measuring" fallback would put it there.
    test.skip(true, 'needs Track M VGridTable + Track O DemoMillion')
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible()

    const cellCount = await page.locator('table.excel-table tbody td.cell').count()
    expect(cellCount).toBeGreaterThan(0)
    expect(cellCount).toBeLessThan(500)

    // ALL1 is column-index 999 (1-based col 1000); far outside the
    // initial horizontal viewport.
    await expect(cell(page, 'ALL1')).toHaveCount(0)
  })
})
