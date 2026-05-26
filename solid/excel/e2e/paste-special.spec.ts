import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Wave 7.3 — Paste Special e2e.
 *
 * Coverage:
 *   1. Ctrl+Alt+V opens the Paste Special dialog; "Values only" + confirm
 *      closes it (smoke).
 *   2. Values-only paste with arithmetic add operator.
 *   3. Transpose paste (row source → column target).
 *   4. Skip-blanks keeps existing target values for blank source cells.
 *   5. Escape closes the dialog without committing.
 *   6. Confirm repaints the projection in the same test step (regression
 *      for HIGH #2 — no tab-out / reload required).
 *   7. Divide-by-zero arithmetic surfaces `#DIV/0!` at the target.
 *
 * Note on capability-gating: the Wave 5 demo's static backend implements
 * `pasteRange`, so we cannot mount it without that port from this surface.
 * The "no-op when backend.pasteRange is missing" branch is covered by the
 * unit-test suite in `solid/excel/test/vnext-grid.test.tsx` (it inspects
 * `pasteSpecialSupportedAtom` directly).
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

function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

async function pressCtrlAltV(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+Alt+v`)
}

async function pressCtrlC(page: Page) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${meta}+c`)
}

/**
 * Double-click a cell, type a value, press Enter. Mirrors the existing
 * test-to-columns spec pattern (the wave5 demo doesn't expose `typeIntoCell`
 * — we duplicate the inline form rather than reach into helpers.ts because
 * the cell selector here is grid-scoped via WAVE5_GRID).
 */
async function typeIntoCellAddr(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const input = cell(page, addr).locator('.cell-input')
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
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

  test('values-only paste with arithmetic add: 120 + 50 → 170', async ({ page, context }) => {
    await gotoWave5(page, context)

    // Seed an empty target with the value 50 in column J (well clear of
    // the wave5 sales seed). B2 already holds 120 from the seed.
    await typeIntoCellAddr(page, 'J3', '50')

    // Copy B2 → source clipboard.
    await cell(page, 'B2').click()
    await pressCtrlC(page)

    // Target J3, open the paste-special dialog.
    await cell(page, 'J3').click()
    await pressCtrlAltV(page)

    const dialog = page.getByTestId('wave5-paste-special')
    await expect(dialog).toBeVisible()

    // Values-only + op=add.
    await page.getByTestId('paste-special-kind-values').click()
    await page.getByTestId('paste-special-op-select').selectOption('add')
    await page.getByTestId('paste-special-confirm-button').click()

    await expect(dialog).toHaveCount(0)

    // HIGH #2 regression: target cell repaints IN THE SAME STEP.
    await expect(cellDisplay(page, 'J3')).toHaveText('170')
  })

  test('transpose paste: A1:C1 row → A3:A5 column', async ({ page, context }) => {
    await gotoWave5(page, context)

    // Seed a 1×3 row in J1..L1 (out of the sales seed area).
    await typeIntoCellAddr(page, 'J1', '1')
    await typeIntoCellAddr(page, 'K1', '2')
    await typeIntoCellAddr(page, 'L1', '3')

    // Select the row J1:L1 and copy.
    await cell(page, 'J1').click()
    await cell(page, 'L1').click({ modifiers: ['Shift'] })
    await pressCtrlC(page)

    // Move anchor to J3 and open paste-special.
    await cell(page, 'J3').click()
    await pressCtrlAltV(page)

    const dialog = page.getByTestId('wave5-paste-special')
    await expect(dialog).toBeVisible()

    // Pick the transpose kind (the dialog also exposes a transpose
    // checkbox; selecting the radio is the canonical path).
    await page.getByTestId('paste-special-kind-transpose').click()
    await page.getByTestId('paste-special-confirm-button').click()

    await expect(dialog).toHaveCount(0)

    // Row [1,2,3] → column J3,J4,J5.
    await expect(cellDisplay(page, 'J3')).toHaveText('1')
    await expect(cellDisplay(page, 'J4')).toHaveText('2')
    await expect(cellDisplay(page, 'J5')).toHaveText('3')
  })

  test('skip-blanks preserves the target value for a blank source cell', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Source row: J1=1, K1=(blank), L1=3. Target row gets seeded with
    // 7,8,9 first; with skip-blanks ON the middle target should stay 8.
    await typeIntoCellAddr(page, 'J1', '1')
    // K1 deliberately left blank.
    await typeIntoCellAddr(page, 'L1', '3')

    await typeIntoCellAddr(page, 'J3', '7')
    await typeIntoCellAddr(page, 'K3', '8')
    await typeIntoCellAddr(page, 'L3', '9')

    // Copy the 1×3 source.
    await cell(page, 'J1').click()
    await cell(page, 'L1').click({ modifiers: ['Shift'] })
    await pressCtrlC(page)

    // Target J3 (anchor); paste-special.
    await cell(page, 'J3').click()
    await pressCtrlAltV(page)

    const dialog = page.getByTestId('wave5-paste-special')
    await expect(dialog).toBeVisible()

    // Values-only + skip-blanks ON.
    await page.getByTestId('paste-special-kind-values').click()
    await page.getByTestId('paste-special-skip-blanks').click()
    await page.getByTestId('paste-special-confirm-button').click()

    await expect(dialog).toHaveCount(0)

    // J3 and L3 overwritten; K3 preserved.
    await expect(cellDisplay(page, 'J3')).toHaveText('1')
    await expect(cellDisplay(page, 'K3')).toHaveText('8')
    await expect(cellDisplay(page, 'L3')).toHaveText('3')
  })

  test('Escape closes the dialog without committing to the target', async ({ page, context }) => {
    await gotoWave5(page, context)

    // Seed: target J3 starts as 99. Copy B2 (120) so the dialog has a
    // payload to potentially paste from.
    await typeIntoCellAddr(page, 'J3', '99')
    await cell(page, 'B2').click()
    await pressCtrlC(page)

    await cell(page, 'J3').click()
    await pressCtrlAltV(page)

    const dialog = page.getByTestId('wave5-paste-special')
    await expect(dialog).toBeVisible()

    // Press Escape — dialog must close AND target must stay 99.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(cellDisplay(page, 'J3')).toHaveText('99')
  })

  test('divide-by-zero arithmetic surfaces #DIV/0!', async ({ page, context }) => {
    await gotoWave5(page, context)

    // Paste-special arithmetic is `target ⊕ source` (per
    // `vanilla/spreadsheet-ui-core/src/paste-special/README.md`). For
    // divide that means `target / source`, so a zero SOURCE is what
    // surfaces `#DIV/0!` at the target. Codex MED #4 brief had source
    // and target swapped — the README + static-backend agree on
    // target/source ordering.
    await typeIntoCellAddr(page, 'J1', '0')
    await typeIntoCellAddr(page, 'J3', '100')

    await cell(page, 'J1').click()
    await pressCtrlC(page)

    await cell(page, 'J3').click()
    await pressCtrlAltV(page)

    const dialog = page.getByTestId('wave5-paste-special')
    await expect(dialog).toBeVisible()

    await page.getByTestId('paste-special-kind-values').click()
    await page.getByTestId('paste-special-op-select').selectOption('divide')
    await page.getByTestId('paste-special-confirm-button').click()

    await expect(dialog).toHaveCount(0)
    await expect(cellDisplay(page, 'J3')).toHaveText('#DIV/0!')
  })
})
