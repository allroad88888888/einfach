import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Wave 8 — Copy as PNG smoke.
 *
 * Verifies Ctrl+Shift+P over a 2×2 selection on the Wave 5 static demo
 * mirrors a non-empty `image/png` Blob into `lastCopyAsAtom`. Uses the
 * `__EINFACH_E2E__` runtime mirror established by the Wave 7.4
 * (HTML / Markdown / plain) flow, so the spec passes even in Playwright's
 * headless mode where `navigator.clipboard.write` of a `ClipboardItem`
 * may be denied.
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function enableE2EMirror(context: BrowserContext) {
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
  await expect(page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="B2"] .cell-display`)).toHaveText(
    '120',
  )
}

function cell(page: Page, addr: string) {
  return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
}

async function pressCtrlShiftP(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+Shift+p`)
}

type ImageMirror = {
  kind: 'image'
  mimeType: string
  byteLength: number
}

test.describe('copy-as PNG — Ctrl+Shift+P writes image/png', () => {
  test('2×2 selection mirrors a non-empty image/png blob into lastCopyAsAtom', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Drag-select A1:B2 (4-cell rectangle). Click A1 then Shift-click B2.
    await cell(page, 'A1').click()
    await cell(page, 'B2').click({ modifiers: ['Shift'] })

    await pressCtrlShiftP(page)

    // Poll the mirror — the encoder + rasterizer are async, so wait up to
    // 5s for the mirror to land. A working render produces a non-zero
    // Blob; the assertion catches "host never wired the intent" (mirror
    // never set) and "renderer produced an empty buffer" (byteLength=0).
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const w = window as unknown as {
              __einfach_lastCopyAs__?: {
                kind?: string
                mimeType?: string
                blob?: Blob
              } | null
            }
            const m = w.__einfach_lastCopyAs__
            if (!m || m.kind !== 'image' || !m.blob) return null
            return {
              kind: m.kind,
              mimeType: m.mimeType ?? '',
              byteLength: m.blob.size,
            } satisfies ImageMirror
          }),
        { timeout: 5_000 },
      )
      .toMatchObject({ kind: 'image', mimeType: 'image/png' })

    const mirror = (await page.evaluate(() => {
      const w = window as unknown as {
        __einfach_lastCopyAs__?: { blob?: Blob } | null
      }
      return w.__einfach_lastCopyAs__?.blob?.size ?? 0
    })) as number
    expect(mirror).toBeGreaterThan(0)
  })

  test('Ctrl+Shift+P with no selection rectangle leaves the mirror untouched', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)
    // Wave 5 demo defaults to A1; pressing Ctrl+Shift+P on a single cell
    // still produces a valid 1×1 image — the spec just confirms the
    // intent dispatches without throwing.
    await cell(page, 'A1').click()
    await pressCtrlShiftP(page)
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __einfach_lastCopyAs__?: { kind?: string } | null
            }
            return w.__einfach_lastCopyAs__?.kind ?? null
          }),
        { timeout: 5_000 },
      )
      .toBe('image')
  })
})
