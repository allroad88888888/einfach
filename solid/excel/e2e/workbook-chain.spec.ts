import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  selectSheet,
  typeIntoCell,
} from './helpers'

/**
 * P0: Workbook Chain And Lazy Formula
 *
 * Backed by `DemoCrossSheetChain` + `createThreeSheetChainWorkbookStore` —
 * three real WASM sheets with cross-sheet formulas. Two things this suite
 * has to prove that unit tests can't:
 *
 *   1. The cross-sheet evaluation chain renders the right number on
 *      first paint AND propagates through the whole chain when a leaf
 *      source cell changes.
 *   2. The lazy formula `Sheet2!C5` is NOT computed while the user is on
 *      Sheet1 — assertions that read the cell directly would force the
 *      computation, so we observe via the `[data-cache-state]` badge and
 *      the `[lazy-demo] computed Sheet2!C5` console log instead.
 *
 * The cache badge + console-log surfaces are the contract from
 * E2E_TEST_PLAN.md "P0.0 Demo Observability Prerequisites" and are wired
 * in `wasm-workbook-store.ts` (look for `readWithLazyProbe`).
 */

const DEMO = '3-Sheet Chain'

/** Cache state for `Sheet2!C5` — read the badge text, never the cell. */
function cacheBadge(page: Page) {
  return page.locator('[data-cache-state="Sheet2!C5"]')
}

/**
 * Capture every `[lazy-demo] computed Sheet2!C5` console message that
 * fires after this is wired up. Returns the live array — assertions
 * pull `.length` at the moment they care about.
 */
function captureLazyDemoLogs(page: Page): string[] {
  const seen: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text()
    if (text.startsWith('[lazy-demo] computed Sheet2!C5')) {
      seen.push(text)
    }
  })
  return seen
}

test.describe('Workbook chain — initial evaluation', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('initial chain evaluates Sheet1!C2 = 13', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await expectDisplay(page, 'C2', '13')
  })

  test('initial chain evaluates Sheet2!C2 = 12', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await selectSheet(page, 'Sheet2')
    await expectDisplay(page, 'C2', '12')
  })

  test('initial chain evaluates Sheet3!C2 = 11', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await selectSheet(page, 'Sheet3')
    await expectDisplay(page, 'C2', '11')
  })
})

test.describe('Workbook chain — cross-sheet propagation', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('changing Sheet1!B4 from 10 to 20 updates the whole chain', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)

    // Sanity: starting state.
    await expectDisplay(page, 'C2', '13')
    await expectDisplay(page, 'B4', '10')

    // Edit the source. B4 is a number cell, so typeIntoCell commits "20"
    // through setCellInput → setNumber.
    await typeIntoCell(page, 'B4', '20')

    // Sheet1!C2 = Sheet2!C2 + 1; Sheet2!C2 = Sheet3!C2 + 1; Sheet3!C2 =
    // Sheet1!B4 + 1. So bumping B4 by 10 bumps each downstream cell by 10
    // along the chain (23 / 22 / 21 instead of 13 / 12 / 11).
    await expectDisplay(page, 'C2', '23')
    await expectDisplay(page, 'B4', '20')

    await selectSheet(page, 'Sheet2')
    await expectDisplay(page, 'C2', '22')

    await selectSheet(page, 'Sheet3')
    await expectDisplay(page, 'C2', '21')
  })
})

test.describe('Workbook chain — lazy non-read', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('staying on Sheet1 keeps Sheet2!C5 dirty and uncomputed', async ({
    page,
  }) => {
    // Capture BEFORE navigating so we don't miss the load-time logs.
    const lazyLogs = captureLazyDemoLogs(page)

    await gotoDemo(page, DEMO)

    // Cache badge in the DemoCrossSheetChain header — reads the workbook
    // store's `formulaCacheState(1, 'C5')` directly. Anything that hits
    // the lazy probe through the store would flip this to "clean".
    await expect(cacheBadge(page)).toHaveText('dirty')

    // Critical: do NOT call `cell(page, 'C5').textContent()` here — the
    // 3-Sheet Chain uses a Table that's always rendered for the active
    // sheet, so DemoCrossSheetChain on Sheet1 has no Sheet2 grid to
    // accidentally read from. But to be safe even against future demo
    // reshapes, we don't probe C5 anywhere on this assertion path.

    // No lazy-demo console message should have fired — Sheet1 doesn't
    // depend on Sheet2!C5, and the badge read uses the debug API which
    // doesn't go through `readWithLazyProbe`.
    expect(lazyLogs).toEqual([])
  })

  test('switching to Sheet2 computes C5=105 once and flips cache to clean', async ({
    page,
  }) => {
    const lazyLogs = captureLazyDemoLogs(page)

    await gotoDemo(page, DEMO)
    await expect(cacheBadge(page)).toHaveText('dirty')
    expect(lazyLogs).toEqual([])

    // Now switch — Sheet2's Table mounts and immediately reads C5 via
    // `getCell`, which goes through `readWithLazyProbe`. That triggers
    // exactly one compute and exactly one console log.
    await selectSheet(page, 'Sheet2')
    await expectDisplay(page, 'C5', '105')

    // Wait for the badge update — DemoCrossSheetChain's effect runs in a
    // microtask after the workbook revision bumps, so we use Playwright's
    // built-in retry on toHaveText rather than a manual wait.
    await expect(cacheBadge(page)).toHaveText('clean')

    // Exactly one lazy-demo log — repeat reads while clean shouldn't
    // trigger another. A stray duplicate would mean either the cache is
    // bypassed or the probe fires on a cache hit.
    expect(lazyLogs.length).toBe(1)
    expect(lazyLogs[0]).toContain('[lazy-demo] computed Sheet2!C5')
  })

  test('reading the clean cell again does not re-fire the probe log', async ({
    page,
  }) => {
    const lazyLogs = captureLazyDemoLogs(page)

    await gotoDemo(page, DEMO)
    await selectSheet(page, 'Sheet2')

    // First read: prime the cache (one log fires).
    await expectDisplay(page, 'C5', '105')
    await expect(cacheBadge(page)).toHaveText('clean')
    expect(lazyLogs.length).toBe(1)

    // Touch the cell again via a click → selection. This re-runs Cell's
    // display reactivity but the cache hit path skips the log.
    await cell(page, 'C5').click()
    await expect(cellDisplay(page, 'C5')).toHaveText('105')

    expect(lazyLogs.length).toBe(1)
  })
})
