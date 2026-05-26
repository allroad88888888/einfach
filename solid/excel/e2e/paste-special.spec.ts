import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Wave 7.3 — Paste Special smoke.
 *
 * Verifies:
 *   1. Ctrl+Alt+V (or Cmd+Alt+V on darwin) opens the Paste Special dialog.
 *   2. Choosing "Values only" and clicking the confirm button closes the
 *      dialog without errors.
 *
 * The static Wave 5 backend implements `pasteRange` so the menu entry is
 * visible and the keyboard shortcut routes through `openPasteSpecialAtom`.
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function gotoWave5(page: Page, context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
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

async function pressCtrlAltV(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+Alt+v`)
}

async function pressCtrlC(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+c`)
}

test.describe('paste-special — Ctrl+Alt+V opens dialog and confirm closes it', () => {
  test('Ctrl+Alt+V opens the dialog, choosing "values" + Paste closes it', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Establish a clipboard payload first so the dialog has a source to
    // paste from. The static backend's copy path seeds the clipboard
    // state; without it the confirm handler would close-on-warn.
    await cell(page, 'B2').click()
    await pressCtrlC(page)

    // Move selection to a fresh target so the paste lands somewhere
    // observable (not strictly required for the smoke).
    await cell(page, 'B10').click()

    // Trigger the Paste Special dialog via the Ctrl+Alt+V intent.
    await pressCtrlAltV(page)

    const dialog = page.getByTestId('wave5-paste-special')
    await expect(dialog).toBeVisible()

    // Pick "Values only" then confirm.
    await page.getByTestId('paste-special-kind-values').click()
    await page.getByTestId('paste-special-confirm-button').click()

    // Dialog should disappear on confirm.
    await expect(dialog).toHaveCount(0)
  })
})
