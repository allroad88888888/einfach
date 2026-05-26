import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Wave 7.4 — Copy as HTML / Markdown smoke.
 *
 * Verifies:
 *   1. Selecting a 2x2 region and pressing Ctrl+Shift+C triggers the
 *      multi-MIME copy path (html + markdown + plain text). Host mirrors
 *      `lastCopyAsAtom` onto `window.__einfach_lastCopyAs__` whenever the
 *      `__EINFACH_E2E__` flag is set (flag is flipped via Playwright's
 *      `addInitScript` below) — the mirror is REQUIRED, not optional, so
 *      a missing one fails the spec rather than silently green-passing.
 *   2. Ctrl+C (without shift) still goes through the OLD copy path —
 *      `clipboard.copy`, not `clipboard.copyAs`. Guards against a keyboard
 *      regression where the new shortcut would eat the legacy chord.
 *
 * The static Wave 5 backend implements `readRangeProjection` so the encoders
 * can read displayValue/mergedSpan from the visible projection and produce
 * all three flavours in a single pass.
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function enableE2EMirror(context: BrowserContext) {
  // Runs before any script on the page — flips the runtime mirror flag
  // `dispatchCopyAs` checks before writing to `window.__einfach_lastCopyAs__`.
  await context.addInitScript(() => {
    ;(window as unknown as { __EINFACH_E2E__: boolean }).__EINFACH_E2E__ = true
  })
}

async function gotoWave5(page: Page, context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await enableE2EMirror(context)
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  // Wait one rAF so the initial projection has loaded.
  await expect(page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="B2"] .cell-display`)).toHaveText(
    '120',
  )
}

function cell(page: Page, addr: string) {
  return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
}

async function pressCtrlShiftC(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+Shift+c`)
}

async function pressCtrlC(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+c`)
}

type CopyAsResult = {
  html: string
  plainText: string
  markdown: string
}

/**
 * Read the e2e mirror that the host writes when the multi-MIME copy
 * succeeds. Returns `null` if the mirror hasn't been written yet — the
 * spec treats that as a failure (the runtime flag is enabled above, so
 * any successful copy-as MUST populate the mirror).
 */
async function readCopyAsMirror(page: Page): Promise<CopyAsResult | null> {
  return await page.evaluate(() => {
    const win = window as unknown as { __einfach_lastCopyAs__?: CopyAsResult | null }
    return win.__einfach_lastCopyAs__ ?? null
  })
}

test.describe('copy-as — Ctrl+Shift+C writes HTML + Markdown + Plain text', () => {
  test('selecting a 2x2 region and pressing Ctrl+Shift+C emits all three flavours', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Select a 2x2 region (B2:C3) on the seeded Wave 5 demo grid. The
    // demo seeds B2=120 plus neighbours, so all four cells have content.
    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    await pressCtrlShiftC(page)

    // Poll the mirror — copy-as is async (backend projection round-trip
    // plus the ClipboardItem write). The `__EINFACH_E2E__` runtime flag
    // is set before any script runs, so the mirror MUST be populated
    // after a successful copy.
    await expect.poll(() => readCopyAsMirror(page), { timeout: 5_000 }).not.toBeNull()

    const mirror = await readCopyAsMirror(page)
    expect(mirror).not.toBeNull()
    // All three MIME flavours must be present and well-formed.
    expect(mirror!.html).toContain('<table')
    expect(mirror!.html.length).toBeGreaterThan(0)
    expect(mirror!.plainText).toContain('\t')
    expect(mirror!.plainText).toContain('\n')
    expect(mirror!.markdown).toContain('|')
    expect(mirror!.markdown).toContain('---')
  })

  test('Ctrl+C (no shift) still routes through the legacy copy path', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Snapshot the mirror state up front so we can detect that Ctrl+C did
    // NOT populate it (i.e. the legacy path was used, not copy-as).
    const before = await readCopyAsMirror(page)

    await cell(page, 'B2').click()
    await pressCtrlC(page)

    await page.waitForTimeout(150)

    const after = await readCopyAsMirror(page)

    // The mirror should be unchanged after a plain Ctrl+C (Ctrl+C goes
    // through the legacy clipboard.copy path; only Ctrl+Shift+C populates
    // the copy-as mirror).
    expect(after).toEqual(before)

    // And the clipboard should have whatever the legacy copy path writes
    // for a single cell — at minimum, non-empty text.
    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text.length).toBeGreaterThan(0)
  })
})
