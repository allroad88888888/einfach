import { expect, type BrowserContext, type Dialog, type Page } from '@playwright/test'

/**
 * Shared e2e helpers. The smoke suite + per-feature spec files all import
 * from here so selectors stay consistent and one fix lands everywhere.
 *
 * Selector contract:
 *   - Each cell is `<td class="cell ..." data-cell-addr="A1">`
 *   - Each cell renders either `<span class="cell-display">` or
 *     `<input class="cell-input">` (mutually exclusive via `<Show>`)
 *   - Render counter probe: `<span data-render-count="N">` when page URL
 *     has `?debug=1`. See `Cell.tsx::RENDER_COUNT_DEBUG`.
 *   - Demo nav: `<button>` with the demo's display name
 *   - Sheet tabs: `<button role="tab">` inside `.sheet-tabs`
 */

// ============================================================================
// Cell selectors
// ============================================================================

/** The `<td>` element for a given address (e.g. "A1"). */
export function cell(page: Page, addr: string) {
  return page.locator(`td.cell[data-cell-addr="${addr}"]`)
}

/** The visible display span inside a cell. */
export function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

/** The active edit input inside a cell. Only present while editing. */
export function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

// ============================================================================
// Navigation
// ============================================================================

/**
 * Open a demo by name and wait for its table to render. `name` is the
 * exact English button text in App.tsx's demo nav (e.g. "Blank",
 * "Formulas", "Multi-Sheet", "3-Sheet Chain").
 *
 * The app boots with locale=zh (commit dede42a), so the demo buttons
 * render with Chinese labels by default. We append `?locale=en` to the URL
 * so the i18n module activates EN at boot (see `i18n/index.ts::readLocaleFromUrl`).
 * That keeps every legacy spec — which still matches against the English
 * literals "Blank" / "Formulas" / "1M Cells" — green without touching them.
 *
 * Pass `query` when you need debug params (e.g. `?debug=1` for the
 * render-counter probe). The query string is appended verbatim and we
 * tack `locale=en` onto it.
 */
export async function gotoDemo(page: Page, name: string, query = '') {
  await page.goto(withEnglishLocale(query))
  await page.getByRole('button', { name, exact: true }).click()
  await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })
}

/**
 * Build a URL with `locale=en` appended to the query string. Idempotent —
 * if the caller already supplied a `locale=` param we don't duplicate it.
 * Used by `gotoDemo` and by any spec-local nav helper that bypasses
 * `gotoDemo` but still needs the EN catalog.
 */
export function withEnglishLocale(query = ''): string {
  const cleaned = query.replace(/^\?/, '')
  if (/(^|&)locale=/.test(cleaned)) {
    return cleaned ? `/?${cleaned}` : '/'
  }
  const merged = cleaned ? `${cleaned}&locale=en` : 'locale=en'
  return `/?${merged}`
}

/**
 * Switch sheets within the current workbook demo (MultiSheet / 3-Sheet
 * Chain). `name` is the visible tab label.
 */
export async function selectSheet(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click()
  // Sheet swaps re-mount the Table → A1 should still resolve to the new
  // sheet's grid. Wait briefly so cellValue() reads against the right store.
  await expect(cell(page, 'A1')).toBeVisible()
}

// ============================================================================
// Cell editing
// ============================================================================

/**
 * Double-click a cell, fill the input, press Enter. Waits for the input
 * to unmount before returning so the caller can immediately assert the
 * new display value.
 */
export async function typeIntoCell(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

/**
 * Click a cell to make it the focus selection (no edit mode). Waits for
 * the .cell-selected class so the caller can immediately interact.
 */
export async function selectCell(page: Page, addr: string) {
  await cell(page, addr).click()
  await expect(cell(page, addr)).toHaveClass(/cell-selected/)
}

/**
 * Assert the cell's displayed value matches `expected`. Fails fast if
 * the cell is in edit mode (the `.cell-display` span won't be there).
 */
export async function expectDisplay(page: Page, addr: string, expected: string) {
  await expect(cellDisplay(page, addr)).toHaveText(expected)
}

// ============================================================================
// Viewport scroll (Phase 4)
// ============================================================================

/**
 * Programmatically scroll the table viewport along one axis. `axis` is
 * `'x'` (sets `scrollLeft`) or `'y'` (sets `scrollTop`); `px` is the
 * absolute pixel offset, not a delta. Targets the `.excel-table-wrapper`
 * div that owns the scroll position for both row and column virt.
 *
 * Added for the Phase-4 column-virt + 1M-cell e2e suite where tests
 * need to push the viewport past col 500 (horizontal) or row 10000
 * (vertical) and re-probe DOM / subscription state. Kept tiny on
 * purpose — anything fancier (smooth scroll, eased) belongs in the
 * caller.
 */
export async function scrollWrapper(page: Page, axis: 'x' | 'y', px: number): Promise<void> {
  await page.locator('.excel-table-wrapper').evaluate(
    (el, args) => {
      if (args.axis === 'x') {
        ;(el as HTMLElement).scrollLeft = args.px
      } else {
        ;(el as HTMLElement).scrollTop = args.px
      }
    },
    { axis, px },
  )
}

// ============================================================================
// Render-counter probe
// ============================================================================

/**
 * Read the current `data-render-count` for a cell. Requires the page to
 * have been opened with `?debug=1` (or `?debug=render`). Returns NaN if
 * the attribute is missing — callers should assert it's a number.
 */
export async function renderCount(page: Page, addr: string): Promise<number> {
  const text = await cellDisplay(page, addr).getAttribute('data-render-count')
  if (text === null) return Number.NaN
  return Number(text)
}

// ============================================================================
// Permissions / dialog handling
// ============================================================================

/**
 * Grant clipboard read + write to the browser context. Required for any
 * spec exercising Ctrl+C / Ctrl+V — the UI swallows permission errors
 * silently, so without this the tests would assert on stale state.
 */
export async function grantClipboard(context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
}

/**
 * Set up a one-shot dialog handler that accepts (or dismisses) the next
 * native prompt/confirm/alert. `text` is the value to type into a prompt
 * dialog; pass null to dismiss.
 *
 * Used by MultiSheet UI (rename uses `prompt`, delete uses `confirm`).
 */
export async function acceptDialog(page: Page, text: string | null = null) {
  page.once('dialog', async (dialog: Dialog) => {
    if (text === null) {
      await dialog.dismiss()
    } else {
      await dialog.accept(text)
    }
  })
}

/**
 * Register handlers for a sequence of native prompts/confirms/alerts.
 * First dialog consumes `responses[0]`, next consumes `responses[1]`, etc.
 * `null` or `undefined` dismisses.
 */
export function queueDialogs(page: Page, responses: Array<string | null>) {
  let i = 0
  page.on('dialog', async (dialog: Dialog) => {
    const idx = i
    i += 1
    const response = responses[idx]
    if (response === null || response === undefined) {
      await dialog.dismiss()
    } else {
      await dialog.accept(response)
    }
  })
}

// ============================================================================
// Console error guard
// ============================================================================

const DEFAULT_CONSOLE_ALLOWLIST = [
  /^\[vite\]/, // HMR / connection chatter
  /^\[lazy-demo\] /, // DemoCrossSheetChain probe
  /Download the React DevTools/, // dev tools nag
]

/**
 * Fail the test if the page emits any `console.error` not matched by the
 * allowlist. Call once at the top of a test (or once per spec via a
 * `test.beforeEach`). Returns the unsubscribe function in case a single
 * scenario needs to opt out (e.g. parse-error specs that expect the
 * UI to log).
 */
export function guardConsoleErrors(page: Page, extraAllow: RegExp[] = []): () => void {
  const allow = [...DEFAULT_CONSOLE_ALLOWLIST, ...extraAllow]
  const errors: string[] = []
  const handler = (msg: import('@playwright/test').ConsoleMessage) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (allow.some((re) => re.test(text))) return
    errors.push(text)
  }
  page.on('console', handler)

  // Fail the test on teardown if any unallowed errors leaked through.
  // Runs after the test body via Playwright's `test.afterEach`-equivalent
  // mechanism: we expose a cleanup the spec can call manually if it needs
  // earlier assertion, or rely on the implicit afterAll.
  // Simplest contract: the spec calls `await expectNoConsoleErrors(page)`
  // explicitly before its last assertion.
  ;(page as unknown as { __einfachConsoleErrors?: string[] }).__einfachConsoleErrors = errors
  return () => page.off('console', handler)
}

/**
 * Assert no unallowed console errors have accumulated since the matching
 * `guardConsoleErrors(page)` call. Convenience for the explicit-assertion
 * style the helper docs above.
 */
export async function expectNoConsoleErrors(page: Page) {
  const errors =
    (page as unknown as { __einfachConsoleErrors?: string[] }).__einfachConsoleErrors ?? []
  expect(errors, `console.error leaked: ${errors.join('\n')}`).toEqual([])
}
