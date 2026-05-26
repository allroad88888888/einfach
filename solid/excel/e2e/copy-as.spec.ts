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

  test('preserves bold + bgColor + fgColor from a pre-styled anchor cell', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // The Wave 5 demo seeds A1 with `{ bgColor: '#1e3a8a', fgColor: '#ffffff',
    // bold: true }` (the dark-blue "Region" header). The HTML encoder is
    // expected to map those into a per-cell inline style on the anchor `<td>`.
    await cell(page, 'A1').click()

    await pressCtrlShiftC(page)
    await expect.poll(() => readCopyAsMirror(page), { timeout: 5_000 }).not.toBeNull()

    const mirror = await readCopyAsMirror(page)
    expect(mirror).not.toBeNull()
    const html = mirror!.html
    expect(html).toContain('font-weight: bold')
    // Encoder writes hex values directly (the demo seeds hex, not a named
    // colour). Match the literal "#1e3a8a" so a regression that drops the
    // colour silently produces a clear diff.
    expect(html).toMatch(/background-color:\s*#1e3a8a/i)
    expect(html).toMatch(/color:\s*#ffffff/i)
    // Belt and braces: the HIGH #1 regression vector was a `; url(...)`
    // injection through the colour fields. Even on a benign cell the
    // encoder must never emit those tokens.
    expect(html).not.toContain('background-image')
    expect(html).not.toContain('url(')
  })

  test('emits GFM markdown table syntax for a 2x2 selection', async ({ page, context }) => {
    await gotoWave5(page, context)

    // Pick a region whose cells are all populated so the markdown table
    // assertion can match the exact GFM structure without empty-cell quirks.
    // B2:C3 → "120","180" over "80","160" on the seeded matrix.
    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    await pressCtrlShiftC(page)
    await expect.poll(() => readCopyAsMirror(page), { timeout: 5_000 }).not.toBeNull()

    const mirror = await readCopyAsMirror(page)
    expect(mirror).not.toBeNull()
    // GFM table: header row, separator row, then one data row. The encoder
    // uses ` | ` as the column separator and ` --- ` as the header separator.
    const lines = mirror!.markdown.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    // Header row contains the two top-row values separated by " | ".
    expect(lines[0]).toMatch(/\|\s*120\s*\|\s*180\s*\|/)
    // Separator row: " --- " per column, two columns.
    expect(lines[1]).toMatch(/\|\s*---\s*\|\s*---\s*\|/)
    // Data row contains the two bottom-row values.
    expect(lines[2]).toMatch(/\|\s*80\s*\|\s*160\s*\|/)
  })

  test('emits TSV plain text with tab between columns and \\n between rows', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    await pressCtrlShiftC(page)
    await expect.poll(() => readCopyAsMirror(page), { timeout: 5_000 }).not.toBeNull()

    const mirror = await readCopyAsMirror(page)
    expect(mirror).not.toBeNull()
    // Excel-compatible TSV: row 1 = "120\t180", row 2 = "80\t160".
    expect(mirror!.plainText).toBe('120\t180\n80\t160')
  })

  test('emits rowspan/colspan on the anchor of a merged A1:B2 region', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Merge A1:B2 via the toolbar dropdown so the projection reports a
    // `mergedSpan: { rows: 2, cols: 2 }` on the A1 anchor.
    await cell(page, 'A1').click()
    await cell(page, 'B2').click({ modifiers: ['Shift'] })
    await page.getByTestId('toolbar-btn-merge').click()
    await page.getByTestId('toolbar-merge-center').click()
    // Wait for the merge to land in the DOM (anchor gets rowspan/colspan).
    await expect(cell(page, 'A1')).toHaveAttribute('rowspan', '2')

    // Select A1:C3 (anchor + covered cells + one column / row of normal cells)
    // so the encoder has to clip the rowspan/colspan but still emit them.
    await cell(page, 'A1').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    await pressCtrlShiftC(page)
    await expect.poll(() => readCopyAsMirror(page), { timeout: 5_000 }).not.toBeNull()

    const mirror = await readCopyAsMirror(page)
    expect(mirror).not.toBeNull()
    expect(mirror!.html).toContain('rowspan="2"')
    expect(mirror!.html).toContain('colspan="2"')
  })

  test('falls back to writeText(plainText) when clipboard.write rejects', async ({
    page,
    context,
  }) => {
    await grantClipboardLocal(context)
    await enableE2EMirror(context)
    // Force `navigator.clipboard.write` (the multi-MIME path) to reject so
    // the dispatch falls through to tier 3 (`writeText`). Spy on writeText
    // so we can assert it was called with the plain-text payload.
    await context.addInitScript(() => {
      const w = window as unknown as { __einfach_writeTextCalls__?: string[] }
      w.__einfach_writeTextCalls__ = []
      const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard)
      navigator.clipboard.write = () => Promise.reject(new Error('forced-reject'))
      navigator.clipboard.writeText = (text: string) => {
        w.__einfach_writeTextCalls__!.push(text)
        return originalWriteText(text)
      }
    })
    await page.goto('/')
    await page.getByTestId('nav-tab-vnext-wave5').click()
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="B2"] .cell-display`)).toHaveText(
      '120',
    )

    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })
    await pressCtrlShiftC(page)

    // The mirror is set on a successful write at any tier — including
    // tier 3 (writeText fallback). Poll until it shows up.
    await expect.poll(() => readCopyAsMirror(page), { timeout: 5_000 }).not.toBeNull()
    const mirror = await readCopyAsMirror(page)
    expect(mirror).not.toBeNull()
    expect(mirror!.plainText).toBe('120\t180\n80\t160')

    // And `writeText` must have received that same plain-text payload —
    // proving the fallback path was actually used (rather than the multi-
    // MIME path silently succeeding via some other route).
    const writeTextCalls = await page.evaluate(() => {
      const w = window as unknown as { __einfach_writeTextCalls__?: string[] }
      return w.__einfach_writeTextCalls__ ?? []
    })
    expect(writeTextCalls.length).toBeGreaterThan(0)
    expect(writeTextCalls).toContain('120\t180\n80\t160')
  })

  // ---------------------------------------------------------------------------
  // Coverage notes — items left to dedicated unit suites
  // ---------------------------------------------------------------------------

  // Menu entry (Edit → Copy as) parity with Ctrl+Shift+C: the Wave 5 demo
  // intentionally omits the menubar (Univer parity, see VNextWave5Demo.tsx
  // comment block). The production code path is exercised via the
  // `SpreadsheetMenuBar` unit test in `test/vnext-copy-as.test.tsx` and the
  // `edit.copyAs` dispatch arm in `menu-bar/SpreadsheetMenuBar.tsx`. Adding
  // an e2e arm would require mounting the menubar inside the demo for the
  // sole benefit of one walk — tracked as TODO.
  test.fixme('menu entry triggers same flow as Ctrl+Shift+C', async () => {
    // TODO: needs SpreadsheetMenuBar mounted in the Wave 5 demo (currently
    // omitted for Univer parity). Unit coverage: `test/vnext-copy-as.test.tsx`.
  })

  // Oversize cap fallback (selection > 100k cells): the Wave 5 demo's
  // viewport is rowCount=50, colCount=16 → 800 cells max, well below
  // `MAX_COPY_AS_CELLS = 100_000`. Triggering the cap from a Playwright
  // walk requires either a programmatic selection override (not exposed
  // today) or a new demo with a 1M-row grid. Unit coverage:
  // `test/vnext-copy-as.test.tsx` ("clips and writes plain text only").
  test.fixme('oversize selection falls back to clipped plain text', async () => {
    // TODO: needs a 100k+ cell grid surface (or a `setSelection` test hook).
    // Unit coverage: `test/vnext-copy-as.test.tsx`.
  })

  // CSS injection defence: injecting a malicious `fontColor` value (e.g.
  // `'red; background-image: url("http://evil")'`) into a cell requires
  // direct backend access — the toolbar's colour picker only accepts hex
  // / named colours from the swatch. Unit coverage:
  // `vanilla/spreadsheet-ui-core/test/copy-as.test.ts` ("sanitises malicious
  // colour values"); the format-preservation test above also asserts that
  // the encoder never emits `background-image` or `url(` for benign data.
  test.fixme('CSS injection in fgColor is stripped by the whitelist', async () => {
    // TODO: needs a host-exposed format setter that accepts free-form strings.
    // Unit coverage:
    // `vanilla/spreadsheet-ui-core/test/copy-as.test.ts`.
  })
})

async function grantClipboardLocal(context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
}
