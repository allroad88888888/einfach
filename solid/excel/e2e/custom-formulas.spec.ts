import { expect, test, type Page } from '@playwright/test'
import { gotoRoot } from './helpers'

/**
 * Wave 8.1 — Custom formulas e2e.
 *
 * Verifies the registered-formula round-trip through the Rust worker
 * backend:
 *
 *   1. The four sample formulas seeded by `VNextWorkerDemo`
 *      (`MYTAX`, `GREET`, `CELSIUS`, `SUMSQ2`) are advertised in a
 *      banner so the demo is self-documenting.
 *   2. Each formula resolves through the engine when typed into a cell —
 *      scalar args, cell references, string args, and 2-D range args
 *      (`SUMSQ2(A1:A3)` exercises the array-marshaling path that the
 *      MED #6 fix re-enabled).
 *   3. Engine name lookup is case-insensitive (`=mytax(50)` resolves the
 *      same registry slot as `=MYTAX(50)`) — the LOW #14 fix.
 *   4. Unknown names surface as `#NAME?`, and built-ins (`SUM`) are not
 *      shadowed by the custom registry.
 *   5. Capability gating: on the static Wave 5 backend (which has no
 *      `registerCustomFormula` port) the registry stays inert, so
 *      `=MYTAX(100)` resolves as an unknown name and the cell shows
 *      `#NAME?`.
 *
 * Custom formulas only exercise the WORKER backend. The static demo's
 * `registerCustomFormula` is omitted by design, and the static
 * formula evaluator has no awareness of the registry atom — so the
 * capability-gating test on Wave 5 demonstrates the degraded-feature
 * shape every optional backend port follows.
 */

const WORKER_GRID = '[data-testid="vnext-worker-grid"]'
const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function gotoWorker(page: Page) {
  // gotoRoot preserves the active project's `?backend=` selector so a
  // `--project=ts` run lands on the TS-backed vNext Worker demo
  // instead of silently falling back to WASM.
  await gotoRoot(page)
  await page.getByTestId('nav-tab-vnext-worker').click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  // Wait for the seeded projection to land — C2 is `=Sheet2!C2+1` and
  // the demo seeds Sheet3!B4=100 → Sheet2!C2 = 12 → Sheet1!C2 = 13.
  await expect(workerCellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function gotoWave5(page: Page) {
  // Wave 5 demo is a static-backend host and does not consult
  // `?backend=`, but `gotoRoot` is still the consistent choice so
  // the URL shape stays uniform.
  await gotoRoot(page)
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function workerCell(page: Page, addr: string) {
  return page.locator(`${WORKER_GRID} td.cell[data-cell-addr="${addr}"]`)
}

function workerCellDisplay(page: Page, addr: string) {
  return workerCell(page, addr).locator('.cell-display')
}

function workerCellInput(page: Page, addr: string) {
  return workerCell(page, addr).locator('.cell-input')
}

function wave5Cell(page: Page, addr: string) {
  return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
}

function wave5CellDisplay(page: Page, addr: string) {
  return wave5Cell(page, addr).locator('.cell-display')
}

function wave5CellInput(page: Page, addr: string) {
  return wave5Cell(page, addr).locator('.cell-input')
}

/**
 * Open `addr` for editing, replace its content, commit with Enter. Worker
 * round-trip is async — the input may stay mounted briefly while the
 * setter / projection round-trip resolves, so we wait for it to unmount
 * before returning so the caller can immediately assert the display.
 */
async function typeIntoWorkerCell(page: Page, addr: string, value: string) {
  await workerCell(page, addr).dblclick()
  const input = workerCellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

async function typeIntoWave5Cell(page: Page, addr: string, value: string) {
  await wave5Cell(page, addr).dblclick()
  const input = wave5CellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

test.describe('custom formulas — registration banner', () => {
  test('banner advertises the four seeded formulas', async ({ page }) => {
    await gotoWorker(page)
    const banner = page.getByTestId('custom-formulas-banner')
    await expect(banner).toBeVisible()
    // All four names must be visible to a user reading the banner so the
    // demo is self-documenting. Tests against the rendered text (not the
    // HTML) so a stray attribute / hidden span doesn't false-match.
    const text = await banner.innerText()
    expect(text).toContain('MYTAX')
    expect(text).toContain('GREET')
    expect(text).toContain('CELSIUS')
    expect(text).toContain('SUMSQ2')
  })
})

test.describe('custom formulas — round-trip through the worker engine', () => {
  test('MYTAX(100) resolves to 20 via a scalar number arg', async ({ page }) => {
    await gotoWorker(page)
    // B6 is empty in the seeded sheet and inside the 5x6 visible viewport.
    await typeIntoWorkerCell(page, 'B6', '=MYTAX(100)')
    await expect(workerCellDisplay(page, 'B6')).toHaveText('20')
  })

  test('MYTAX(B4) resolves through a cell reference (B4=10 → 2)', async ({ page }) => {
    await gotoWorker(page)
    // Demo seeds B4=10. =MYTAX(B4) → 10 * 0.2 = 2.
    await typeIntoWorkerCell(page, 'C6', '=MYTAX(B4)')
    await expect(workerCellDisplay(page, 'C6')).toHaveText('2')
  })

  test('GREET("World") resolves to a string return value', async ({ page }) => {
    await gotoWorker(page)
    await typeIntoWorkerCell(page, 'D6', '=GREET("World")')
    await expect(workerCellDisplay(page, 'D6')).toHaveText('Hello, World')
  })

  test('CELSIUS(212) returns the boiling point of water', async ({ page }) => {
    await gotoWorker(page)
    // (212 - 32) * 5 / 9 = 100 exactly. If float formatting drifts (101.0
    // vs 100), narrow the regex — for now we expect an integer-clean 100.
    await typeIntoWorkerCell(page, 'E6', '=CELSIUS(212)')
    await expect(workerCellDisplay(page, 'E6')).toHaveText('100')
  })

  test('SUMSQ2(B2:B4) marshals a 2-D range arg (MED #6 regression)', async ({ page }) => {
    await gotoWorker(page)
    // Replace B2/B3/B4 with numeric 1, 2, 3 so SUMSQ2(B2:B4) = 1+4+9 = 14.
    // (The seeded values at those cells are text / unrelated.) Typing each
    // value commits a number to the worker before we ask for the sum.
    await typeIntoWorkerCell(page, 'B2', '1')
    await typeIntoWorkerCell(page, 'B3', '2')
    await typeIntoWorkerCell(page, 'B4', '3')
    await typeIntoWorkerCell(page, 'C6', '=SUMSQ2(B2:B4)')
    await expect(workerCellDisplay(page, 'C6')).toHaveText('14')
  })
})

test.describe('custom formulas — engine lookup semantics', () => {
  test('case-insensitive lookup: =mytax(50) resolves like =MYTAX(50)', async ({ page }) => {
    await gotoWorker(page)
    // LOW #14 fix: lowercase invocation must hit the same registry slot
    // as the uppercase canonical form. 50 * 0.2 = 10.
    await typeIntoWorkerCell(page, 'D6', '=mytax(50)')
    await expect(workerCellDisplay(page, 'D6')).toHaveText('10')
  })

  test('unknown name surfaces as #NAME?', async ({ page }) => {
    await gotoWorker(page)
    await typeIntoWorkerCell(page, 'E6', '=UNKNOWN_FN(5)')
    // Engine error tokens are rendered verbatim. Accept "#NAME?" or the
    // localized "#NAME?" — Excel emits the bang variant; matching the
    // bare token keeps the spec robust across locale toggles.
    await expect(workerCellDisplay(page, 'E6')).toHaveText(/#NAME\?/)
  })

  test('built-in SUM is not shadowed by the custom registry', async ({ page }) => {
    await gotoWorker(page)
    // The custom registry intentionally cannot register names that shadow
    // engine built-ins. =SUM(1,2,3) must still resolve to 6.
    await typeIntoWorkerCell(page, 'B6', '=SUM(1,2,3)')
    await expect(workerCellDisplay(page, 'B6')).toHaveText('6')
  })
})

test.describe('custom formulas — capability gating', () => {
  test('static Wave 5 backend resolves =MYTAX(100) to an error (no worker)', async ({ page }) => {
    await gotoWave5(page)
    // The Wave 5 demo populates `registerCustomFormulaAtom` with MYTAX /
    // GREET / CELSIUS in its onMount block, but the static backend omits
    // the `registerCustomFormula` port — so the host effect skips the
    // worker-side install (there is no worker), and the static formula
    // evaluator has no awareness of the registry atom. The static
    // evaluator surfaces unknown function names as the generic `#ERROR!`
    // token (its #NAME? path is reserved for parser-level breakage); the
    // user-visible outcome is the same: the formula fails to compute.
    await typeIntoWave5Cell(page, 'A10', '=MYTAX(100)')
    await expect(wave5CellDisplay(page, 'A10')).toHaveText(/#(NAME\?|ERROR!)/)
  })
})

test.describe('custom formulas — coverage notes', () => {
  // Re-entrancy guard (HIGH #1 regression): the demo seeds four safe sources
  // (`MYTAX`, `GREET`, `CELSIUS`, `SUMSQ2`). Exercising the worker-side
  // guard requires dispatching a registration with a malicious source like
  // `'workbook.deleteAllSheets(); return 0'`, which in turn needs a host
  // hook that accepts free-form source strings from e2e walks. Unit
  // coverage lives in `rust/excel-core/tests/` (re-entrancy + memory
  // limits) and `vanilla/spreadsheet-ui-core/test/custom-formulas.test.ts`
  // (host-side registry semantics).
  test.fixme('re-entrancy guard rejects malicious sources', async () => {
    // TODO: needs a host hook to register arbitrary sources from a walk.
    // Unit coverage: `rust/excel-core/tests/custom_formulas.rs`.
  })
})
