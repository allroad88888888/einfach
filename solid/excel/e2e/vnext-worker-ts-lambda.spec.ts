/**
 * Wave F follow-up — LAMBDA registration via the Name Manager dialog.
 *
 * Pins the host-UI surface that was previously missing (see the `test.fixme`
 * in `vnext-worker-ts.spec.ts`: "LAMBDA registration round-trips through
 * the TS worker (no host UI surface yet)"). The dialog now has a kind
 * selector (`name-mgr-kind-select`) with `range` / `value` / `lambda`
 * options; choosing `lambda` reveals a `Params` input (`name-mgr-params-input`)
 * and repurposes the existing `name-refers-to` input as the body formula.
 *
 * The lambda binding flows host → backend port (`setNamedRange` with
 * `refersTo.kind === 'lambda'`) → worker RPC (`defineName`) → engine
 * (`workbook.defineName(...)`) → recalc. A subsequent `=DOUBLE(5)` in
 * the grid renders as `10`, proving the round-trip.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  cellInput,
  guardConsoleErrors,
  withEnglishLocale,
} from './helpers'

async function gotoVNextWorkerTsDemo(page: Page) {
  guardConsoleErrors(page)
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-worker-ts').click()
  await expect(page.getByTestId('vnext-worker-ts-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'B5')).toHaveText('60', { timeout: 30_000 })
}

async function typeFormulaAtCell(page: Page, addr: string, formula: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(formula)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

test.describe('Solid Excel vNext — TS worker LAMBDA registration via Name Manager', () => {
  test('define DOUBLE LAMBDA via dialog, then =DOUBLE(5) renders 10', async ({ page }) => {
    await gotoVNextWorkerTsDemo(page)

    // Open the Name Manager from the toolbar (the same button the existing
    // range/value flows use — we're only adding a new kind, not a new entry
    // point).
    await page.getByTestId('toolbar-btn-name-manager').click()
    const dialog = page.getByTestId('vnext-worker-ts-name-manager')
    await expect(dialog).toBeVisible()

    // Fill the name, then switch the kind selector to `lambda`. The
    // params row is only rendered when kind === 'lambda', so the
    // existence assertion doubles as a Show-binding check.
    await dialog.getByTestId('name-input').fill('DOUBLE')
    await dialog.getByTestId('name-mgr-kind-select').selectOption('lambda')

    const paramsInput = dialog.getByTestId('name-mgr-params-input')
    await expect(paramsInput).toBeVisible()
    await paramsInput.fill('x')

    // Reuse the existing refers-to input — under lambda kind its label
    // becomes "Body formula" but the testid stays `name-refers-to` so
    // older specs (Wave 5 range flow) keep working.
    await dialog.getByTestId('name-refers-to').fill('=x*2')

    await dialog.getByTestId('name-save-button').click()

    // Dialog auto-closes on successful save.
    await expect(dialog).toHaveCount(0)

    // Now type =DOUBLE(5) in an empty cell. The grid roundtrips through
    // the worker, which resolves DOUBLE as a LAMBDA binding and
    // returns 10. A6 is in the default visible window.
    await typeFormulaAtCell(page, 'A6', '=DOUBLE(5)')
    await expect(cellDisplay(page, 'A6')).toHaveText('10')
  })

  test('switching kind back to range hides the params input', async ({ page }) => {
    // Sanity probe — the params row's `Show` boundary is keyed on the
    // kind atom, so toggling the dropdown must update visibility on the
    // same render tick.
    await gotoVNextWorkerTsDemo(page)
    await page.getByTestId('toolbar-btn-name-manager').click()
    const dialog = page.getByTestId('vnext-worker-ts-name-manager')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('name-mgr-kind-select').selectOption('lambda')
    await expect(dialog.getByTestId('name-mgr-params-input')).toBeVisible()

    await dialog.getByTestId('name-mgr-kind-select').selectOption('range')
    await expect(dialog.getByTestId('name-mgr-params-input')).toHaveCount(0)
  })
})
