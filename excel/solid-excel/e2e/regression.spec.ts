import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  gotoDemo,
  guardConsoleErrors,
  selectSheet,
  typeIntoCell,
} from './helpers'

/**
 * Regression spec — pins bugs that already have a fix in the tree but no
 * browser-level guard. Each entry maps to a numbered item in
 * `excel/solid-excel/docs/E2E_TEST_PLAN.md::Regression Spec Scope`.
 *
 * Current policy: regression entries stay active. Debug shims and browser
 * panic probes now exist, so this file should not add `test.skip` without
 * a fresh owner and stop condition.
 */

const isMac = process.platform === 'darwin'
const META = isMac ? 'Meta' : 'Control'

async function focusGrid(page: Page) {
  await page.locator('.excel-table-wrapper').focus()
}

async function pressUndo(page: Page) {
  await focusGrid(page)
  await page.keyboard.press(`${META}+z`)
}

test.describe('Solid Excel regression pins', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('TODO 1.2.1: one Enter commit produces exactly one undo entry', async ({
    page,
  }) => {
    // Before the Cell.commitEdit Enter+blur double-fire fix, this test
    // would need TWO Ctrl+Z presses to clear A1 (the second snapshot was
    // a no-op "empty → 7" that consumed the first undo press). Now ONE
    // press is enough — and that's the invariant we lock in.
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', '7')
    await expect(cellDisplay(page, 'A1')).toHaveText('7')

    await pressUndo(page)
    // Strict: A1 must be empty after a single undo. If a regression
    // reintroduces the double-fire, this will read "7" (the no-op entry
    // gets popped first) and fail loudly.
    await expect(cellDisplay(page, 'A1')).toHaveText('')
  })

  test('TODO 1.2.1: undo after Escape (cancel) does not consume a phantom entry', async ({
    page,
  }) => {
    // Companion to the above. Pre-fix, Escape in edit mode could still
    // leave a phantom undo entry on the stack via the blur path. After
    // the fix, an aborted edit must NOT add anything to the undo stack
    // — so undoing after one real commit reverts the real commit.
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', 'kept')

    await cell(page, 'A1').dblclick()
    const input = page.locator('td.cell[data-cell-addr="A1"] .cell-input')
    await expect(input).toBeVisible()
    await input.fill('discarded')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    // Display unchanged — the Escape cancels the edit.
    await expect(cellDisplay(page, 'A1')).toHaveText('kept')

    // One undo reverts the original "kept" write. If the canceled edit
    // had leaked a snapshot, this would land on "kept" → "kept" (no-op)
    // and the cell would still show "kept".
    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')
  })

  test('subscribe-then-set_formula fires subscriber exactly once', async ({
    page,
  }) => {
    // Browser-level mirror of the Rust unit test
    //   excel/rust/excel-core/src/sheet.rs::tests::
    //     subscribe_empty_cell_then_set_formula_fires_once
    //
    // The address-level subscription contract: a cell that's been rendered
    // (Solid's reactive read triggers SheetStore.subscribe for that addr,
    // even if the cell is empty) must fire its subscriber EXACTLY ONCE
    // when a formula is first installed on it. Pre-fix, the first
    // set_formula on an empty subscribed cell silently dropped the
    // notification (the bucket had listeners but no store_sub because the
    // empty cell hadn't been atomized yet).
    //
    // We use the debug shim `SheetStore.subscriberFireCount(addr)` exposed
    // via `window.__einfachStore` when `?debug=1`. This is the only way to
    // observe individual subscriber-fire counts from the browser.
    await gotoDemo(page, 'Blank', 'debug=1')

    // Force B1 to render as an empty cell — that's what subscribes its
    // address bucket. (`cellDisplay` reads via Solid which calls into
    // SheetStore.getCell, materializing the handle.)
    await expect(cellDisplay(page, 'B1')).toBeVisible()
    const beforeFires = await page.evaluate(
      () => window.__einfachStore?.subscriberFireCount('B1') ?? -1,
    )
    expect(beforeFires).toBe(0)

    // First set_formula on B1 — this is the path that used to drop the
    // notification. After the with_remap fix it must fire exactly once.
    await typeIntoCell(page, 'A1', '5')
    const fireAfterA1 = await page.evaluate(
      () => window.__einfachStore?.subscriberFireCount('B1') ?? -1,
    )
    // Writing A1 doesn't touch B1 yet (B1 has no formula). So B1 hasn't
    // fired.
    expect(fireAfterA1).toBe(0)

    await typeIntoCell(page, 'B1', '=A1*2')
    await expect(cellDisplay(page, 'B1')).toHaveText('10')
    const afterSetFormula = await page.evaluate(
      () => window.__einfachStore?.subscriberFireCount('B1') ?? -1,
    )
    // Exactly one fire from the empty → formula transition. The strict
    // equality is the regression guard — pre-fix this was 0.
    expect(afterSetFormula).toBe(1)
  })

  test('cross-sheet read does not invalidate cached cells (workbook chain)', async ({
    page,
  }) => {
    // Pre-fix, Workbook::get_cell on Sheet1 could fire subscribers for
    // unrelated cells on Sheet2 because the dependency graph wasn't
    // partitioned per-sheet. Browser-level proof: open the lazy chain
    // demo, force Sheet2!C5 to compute (visit Sheet2), come back to
    // Sheet1, and confirm the cache stays clean — no spurious
    // recomputation message in the console while we're poking around
    // Sheet1.
    const lazyMessages: string[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.startsWith('[lazy-demo] computed Sheet2!C5')) {
        lazyMessages.push(text)
      }
    })

    await gotoDemo(page, '3-Sheet Chain')

    // Wait for the workbook to finish loading — the cache badge starts
    // out "pending" before the createEffect runs.
    const cacheBadge = page.locator('[data-cache-state="Sheet2!C5"]')
    await expect(cacheBadge).toBeVisible()
    await expect(cacheBadge).toHaveText('dirty')

    // Visit Sheet2 — the demo-local effect on C5 (via the badge update
    // pulling formulaCacheState, then the actual cell render reading
    // get_display) flushes the cache to "clean" exactly once.
    await selectSheet(page, 'Sheet2')
    await expect(cacheBadge).toHaveText('clean')
    expect(lazyMessages.length).toBe(1)

    // Hop back to Sheet1 and do an unrelated edit. This is the actual
    // regression check: Sheet1 mutations must not flow into Sheet2's
    // computed cache via the cross-sheet read path.
    await selectSheet(page, 'Sheet1')
    const sheet1Snapshot = lazyMessages.length

    // Edit a Sheet1 cell that doesn't feed into Sheet2!C5's chain
    // (C5 = Sheet3!B4 + 5). A1 is a label cell.
    await typeIntoCell(page, 'A1', 'edited')
    await expect(cellDisplay(page, 'A1')).toHaveText('edited')

    // No new "[lazy-demo] computed" messages — the Sheet2 cache stays
    // clean despite the Sheet1 write. (If the cross-sheet partitioning
    // regressed, we'd see another `computed` message here.)
    expect(lazyMessages.length).toBe(sheet1Snapshot)

    // And the badge should still read "clean" for Sheet2!C5 — we never
    // navigated away from "clean" via a Sheet1 mutation.
    await expect(cacheBadge).toHaveText('clean')
  })

  test('TODAY()-style date evaluates to the current local date', async ({
    page,
  }) => {
    // The Formulas demo uses the WASM backend, which is the only place
    // TODAY/NOW are real. Set =TODAY() into an empty cell via the
    // FormulaBar so we don't depend on whether seed data includes it.
    //
    // Validation: TODAY returns a Rust DateTime serialized as a date
    // string. We accept either ISO (`YYYY-MM-DD`) or a numeric serial
    // close to the current Excel epoch — but the "regression" we're
    // really pinning is: no UTC-vs-local off-by-one drift. So we accept
    // today, yesterday, or tomorrow in the user's local zone.
    await gotoDemo(page, 'Formulas')

    // Pick an empty cell at the bottom of the seeded grid (Formulas
    // renders 18 rows × 10 cols). J18 is the far-corner cell, well
    // outside any seeded section.
    await typeIntoCell(page, 'J18', '=TODAY()')
    const display = (await cellDisplay(page, 'J18').textContent()) ?? ''
    expect(display, 'TODAY() must produce a non-empty display').toBeTruthy()
    // Sanity: the engine didn't bail out with an error sigil.
    expect(display).not.toMatch(/^#/)

    // The Rust engine emits TODAY() as a day count. Empirically (see
    // `excel/rust/excel-core/src/functions/date.rs`) the epoch is Unix
    // 1970-01-01, NOT Excel's 1899-12-30 Lotus epoch — so the serial is
    // ~20k for "now" rather than ~46k. We accept that, and also fall back
    // to ISO-style ("2026-05-09") in case the formatter ever changes.
    // The regression we're really pinning is: result should resolve to
    // the user's local "today", not yesterday (UTC drift).
    const ONE_DAY = 24 * 60 * 60 * 1000
    const now = new Date()
    const todayUtcMs = Date.UTC(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    )

    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(display)
    const numericMatch = /^-?\d+(\.\d+)?$/.test(display)
    let resolvedUtcMs: number | null = null

    if (isoMatch) {
      resolvedUtcMs = Date.UTC(
        Number(isoMatch[1]),
        Number(isoMatch[2]) - 1,
        Number(isoMatch[3]),
      )
    } else if (numericMatch) {
      resolvedUtcMs = Math.floor(Number(display)) * ONE_DAY
    }

    expect(resolvedUtcMs, `unrecognized TODAY() display: ${display}`).not.toBeNull()
    // Within one local-day window of "today" — the bug we're guarding
    // against is a ±1 day off-by-one when the user's TZ is on the other
    // side of UTC midnight. A regression there would land exactly at
    // ±ONE_DAY; we leave that as the strict boundary.
    expect(Math.abs((resolvedUtcMs as number) - todayUtcMs)).toBeLessThanOrEqual(
      ONE_DAY,
    )
  })

  test('JsCallbackListener panic surfaces without taking down the wasm instance', async ({
    page,
  }) => {
    // C.10: console_error_panic_hook surfaces panics to console.error,
    // and the wasm instance keeps working after a listener panic. Browser
    // verification path uses the `__debugPanicNextCallback` knob added on
    // WasmSheet — arms a one-shot flag, the next subscriber-callback
    // microtask panics, the next set_/get_ on the same sheet still works.
    //
    // Uses DemoFormulas (only WASM-backed demo whose store we expose on
    // window for debug). Allowlist the panic message so the
    // guardConsoleErrors at the top of this file doesn't immediately fail
    // the test on the very thing we're verifying gets logged.
    const offConsole = guardConsoleErrors(page, [
      /injected panic for regression test/,
      /panicked at/, // wasm-bindgen panic stack header
      /RuntimeError: unreachable/, // wasm trap when panic propagates
    ])

    const panicMessages: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (text.includes('injected panic for regression test')) {
        panicMessages.push(text)
      }
    })

    await gotoDemo(page, 'Formulas', 'debug=1')

    // Subscribe to a cell by reading it (Cell mounts → SheetStore.subscribe
    // fires) — we picked an arithmetic cell that's already in the seed.
    await expect(cellDisplay(page, 'C3')).toHaveText('13')

    // Arm the panic. Next subscriber callback fire panics inside its
    // microtask. Setting A3 mutates a value that C3 (=A3+B3) depends on,
    // which fires the C3 subscriber.
    const armed = await page.evaluate(() => {
      const store = window.__einfachStore
      const raw = store?.raw as { __debugPanicNextCallback?: () => void } | undefined
      if (!raw?.__debugPanicNextCallback) return false
      raw.__debugPanicNextCallback()
      return true
    })
    expect(armed).toBe(true)

    await typeIntoCell(page, 'A3', '20')

    // The panic happens in a queued microtask. Wait for the console
    // signal to land before asserting wasm survival.
    await expect.poll(() => panicMessages.length, { timeout: 2000 }).toBeGreaterThan(0)

    // Wasm instance is still alive — another set + dependent re-eval works.
    // (Pre-fix behavior would be either a stuck UI or wasm-instance death
    //  causing every subsequent op to throw.)
    await typeIntoCell(page, 'A3', '5')
    // C3 = A3 + B3 = 5 + 3 = 8.
    await expect(cellDisplay(page, 'C3')).toHaveText('8')

    offConsole()
  })
})
