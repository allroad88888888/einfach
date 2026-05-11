import { test, expect } from '@playwright/test'
import {
  cellDisplay,
  gotoDemo,
  guardConsoleErrors,
  renderCount,
  typeIntoCell,
} from './helpers'

/**
 * Render-counter spec — proves the address-level subscription
 * architecture only re-runs Cells whose display value actually changed.
 *
 * Observation channel: the `data-render-count` attribute on each
 * `.cell-display` span (Cell.tsx::renderCountAttr, gated on `?debug=1`).
 * The accessor reads `cellValue()` for its tracking dep, so Solid re-runs
 * it whenever the cell's display would update — but NOT on unrelated
 * writes elsewhere on the sheet.
 *
 * All assertions are strict `expect(...).toBe(N)`. The fine-grained
 * architecture's whole point is exact subscription counts; `>=` would
 * silently mask a "global re-render" regression.
 *
 * The `?debug=1` query param is required. Without it, `renderCount`
 * returns NaN and every assertion fails confusingly. The first test
 * pins this — if it fails on a fresh checkout, fix the URL plumbing
 * first.
 */

test.describe('Solid Excel render counter (precise subscriptions)', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('debug probe is on: renderCount returns a real number', async ({ page }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    const initial = await renderCount(page, 'A1')
    // Strict: must be a number, not NaN. NaN means ?debug=1 didn't reach
    // the page (the most common cause of every other assertion in this
    // file silently passing or failing weirdly).
    expect(Number.isNaN(initial)).toBe(false)
    expect(typeof initial).toBe('number')
  })

  test('writing A1 does NOT re-render an unrelated B1', async ({ page }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await expect(cellDisplay(page, 'B1')).toBeVisible()
    const beforeB1 = await renderCount(page, 'B1')

    await typeIntoCell(page, 'A1', '1')
    await typeIntoCell(page, 'A1', '2')
    await expect(cellDisplay(page, 'A1')).toHaveText('2')

    const afterB1 = await renderCount(page, 'B1')
    // Strict equality — independence is the architectural guarantee.
    expect(afterB1).toBe(beforeB1)
  })

  test('a single dependency triggers exactly one downstream display update', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'A1', '5')
    await typeIntoCell(page, 'B1', '=A1*2')
    await expect(cellDisplay(page, 'B1')).toHaveText('10')

    const beforeB1 = await renderCount(page, 'B1')
    await typeIntoCell(page, 'A1', '3')
    await expect(cellDisplay(page, 'B1')).toHaveText('6')

    const afterB1 = await renderCount(page, 'B1')
    // Exactly one re-run. Two would mean a duplicate fire (e.g. the
    // address-level fanout double-notifying); zero would mean B1 lost
    // its subscription.
    expect(afterB1 - beforeB1).toBe(1)
  })

  test('three independent writes trigger exactly three downstream updates', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'B1', '=A1+A2+A3')
    await expect(cellDisplay(page, 'B1')).toHaveText('0')

    const beforeB1 = await renderCount(page, 'B1')
    await typeIntoCell(page, 'A1', '1')
    await typeIntoCell(page, 'A2', '2')
    await typeIntoCell(page, 'A3', '3')
    await expect(cellDisplay(page, 'B1')).toHaveText('6')

    const afterB1 = await renderCount(page, 'B1')
    // Three sequential writes → three distinct B1 display values
    // (1, 3, 6). No batching collapses, no duplicate fires.
    expect(afterB1 - beforeB1).toBe(3)
  })

  test('writing the same value twice does NOT fire a downstream update', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'A1', '5')
    await typeIntoCell(page, 'B1', '=A1*2')
    await expect(cellDisplay(page, 'B1')).toHaveText('10')

    const beforeB1 = await renderCount(page, 'B1')

    // Same value again — JS-mock fires only on display diff, so B1's
    // display "10" doesn't change → no notification → no Solid re-run.
    await typeIntoCell(page, 'A1', '5')
    const afterB1 = await renderCount(page, 'B1')

    expect(afterB1).toBe(beforeB1)
  })

  test('writing A2 only updates cells that read A2', async ({ page }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'A1', '0')
    await typeIntoCell(page, 'A2', '0')
    await typeIntoCell(page, 'B1', '=A1*2') // depends on A1, NOT A2
    await typeIntoCell(page, 'C1', '=A2*2') // depends on A2, NOT A1
    await expect(cellDisplay(page, 'B1')).toHaveText('0')
    await expect(cellDisplay(page, 'C1')).toHaveText('0')

    const beforeB1 = await renderCount(page, 'B1')
    const beforeC1 = await renderCount(page, 'C1')

    await typeIntoCell(page, 'A2', '10')
    await expect(cellDisplay(page, 'C1')).toHaveText('20')

    const afterB1 = await renderCount(page, 'B1')
    const afterC1 = await renderCount(page, 'C1')

    // C1 picks up exactly one re-run; B1 doesn't move at all.
    expect(afterC1 - beforeC1).toBe(1)
    expect(afterB1).toBe(beforeB1)
  })
})
