import { test, expect } from '@playwright/test'
import { cell, cellDisplay, gotoDemo, typeIntoCell } from './helpers'

/**
 * 7C Step 4 — golden-path e2e for the worker-backed demo.
 *
 * The demo wires a `createWorkerSheet({ workerFactory: defaultWorkerFactory })`
 * proxy underneath a normal `<Table>`. Everything the user sees should
 * behave identically to the JS-mock / direct-WASM demos. The intent of this
 * spec is to prove the postMessage round-trip survives in a real browser:
 *
 *   1. seed values render after the worker boots
 *   2. typing into a cell updates its display
 *   3. a formula that touches a freshly-written cell recomputes through
 *      the worker and the new value appears
 */
test.describe('Worker-backed sheet', () => {
  test('seed values become visible after the worker hydrates', async ({ page }) => {
    await gotoDemo(page, 'Worker')
    // Headers come from `setText` — the proxy's optimistic write puts them
    // in the cache synchronously, so they're visible regardless of worker
    // timing.
    await expect(cellDisplay(page, 'A1')).toHaveText('Item')
    await expect(cellDisplay(page, 'B1')).toHaveText('Qty')

    // The formula cells start empty (optimism doesn't compute) and are
    // hydrated via worker push once it computes. Either eq:
    //   D2 = B2 * C2 = 3 * 1.5 = 4.5
    //   D6 = SUM(D2,D3,D4) = 4.5 + 3 + 20 = 27.5
    await expect(cellDisplay(page, 'D2')).toHaveText('4.5')
    await expect(cellDisplay(page, 'D6')).toHaveText('27.5')
  })

  test('typing into a primitive cell shows up immediately', async ({ page }) => {
    await gotoDemo(page, 'Worker')
    await typeIntoCell(page, 'B2', '5')
    await expect(cellDisplay(page, 'B2')).toHaveText('5')
  })

  test('writing a primitive recomputes a dependent formula via the worker', async ({ page }) => {
    await gotoDemo(page, 'Worker')
    await typeIntoCell(page, 'B2', '4')
    // D2 = B2*C2 = 4 * 1.5 = 6, sent back from the worker via change push.
    await expect(cellDisplay(page, 'D2')).toHaveText('6')
    // D6 = SUM cascades — must update too.
    await expect(cellDisplay(page, 'D6')).toHaveText('29')
  })

  test('clicking a formula cell shows the formula source in the formula bar', async ({ page }) => {
    await gotoDemo(page, 'Worker')
    await cell(page, 'D2').click()
    // Formula text is recorded synchronously on the proxy's cache via
    // optimistic `set_formula`, so the formula bar shows the source even
    // before the worker computes the result.
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('=B2*C2')
  })
})
