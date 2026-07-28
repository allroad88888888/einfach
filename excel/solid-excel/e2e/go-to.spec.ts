import { test, expect, type Locator, type Page } from '@playwright/test'

const WAVE5_GRID = '[data-testid="wave5-grid"]'

test.describe('vNext Wave 7.4 — Go To / Go To Special', () => {
  async function gotoWave5(page: Page) {
    await page.goto('/?locale=en')
    await page.getByTestId('nav-tab-vnext-wave5').click()
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
    // Wait for the initial projection so the first read of a cell display
    // returns the seeded value (matches paste-special / text-to-columns).
    await expect(
      page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="B2"] .cell-display`),
    ).toHaveText('120')
  }

  function cell(page: Page, addr: string) {
    return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
  }

  async function openGoTo(page: Page): Promise<Locator> {
    await page.keyboard.press('ControlOrMeta+g')
    const dialog = page.getByTestId('wave5-go-to')
    await expect(dialog).toBeVisible()
    return dialog
  }

  async function registerNamedRange(
    page: Page,
    nameValue: string,
    refersToValue: string,
  ): Promise<void> {
    // Drive the toolbar's Name Manager button — the only UI path the
    // Wave 5 demo exposes to mutate the registry (no menubar).
    await page.getByTestId('toolbar-btn-name-manager').click()
    const dialog = page.getByTestId('wave5-name-manager')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('name-input').fill(nameValue)
    await dialog.getByTestId('name-refers-to').fill(refersToValue)
    await dialog.getByTestId('name-save-button').click()
    await expect(dialog).toHaveCount(0)
  }

  test('Ctrl+G + "C5" + Enter navigates to C5', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    const dialog = await openGoTo(page)
    await expect(dialog).toHaveAttribute('data-active-tab', 'simple')

    const input = page.getByTestId('go-to-input')
    await input.fill('C5')
    await input.press('Enter')

    await expect(dialog).toBeHidden()
    await expect(cell(page, 'C5')).toHaveAttribute('data-active', 'true')
  })

  test('Special tab → Constants → Go selects a multi-region selection covering populated cells', async ({
    page,
  }) => {
    await gotoWave5(page)
    // Wave 5 fixture is a 9x6 populated matrix. The static backend projection
    // only materializes populated cells, so we pick the `constants` locator
    // (which matches every non-formula populated cell) and verify the dialog
    // closes and a populated cell other than the active one is selected.
    await cell(page, 'A1').click()

    await openGoTo(page)

    await page.getByTestId('go-to-tab-special').click()
    await expect(page.getByTestId('go-to-tab-special')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await page.getByTestId('go-to-locator-constants').click()
    await page.getByTestId('go-to-confirm-button').click()

    // Dialog closes after the multi-region commit.
    await expect(page.getByTestId('wave5-go-to')).toBeHidden({ timeout: 5_000 })

    // A populated cell other than the active one is now selected — verify
    // E4 (a number in the fixture) carries data-selected="true".
    await expect(cell(page, 'E4')).toHaveAttribute('data-selected', 'true')
  })

  // ── B4 expansion ────────────────────────────────────────────────────────

  test('B4 #1 — Ctrl+G basic navigation: "F8" → name box reflects F8 + selection on F8', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await openGoTo(page)
    const input = page.getByTestId('go-to-input')
    await input.fill('F8')
    await input.press('Enter')

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()
    await expect(cell(page, 'F8')).toHaveAttribute('data-active', 'true')
    // Name box is part of the formula bar — verify it shows the new address.
    const nameBox = page.getByTestId('name-box-input')
    await expect(nameBox).toHaveValue('F8')
  })

  test('B4 #2 — R1C1 absolute: "R5C3" navigates to C5', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await openGoTo(page)
    const input = page.getByTestId('go-to-input')
    await input.fill('R5C3')
    await input.press('Enter')

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()
    await expect(cell(page, 'C5')).toHaveAttribute('data-active', 'true')
  })

  test('B4 #3 — R1C1 relative (MED #5 fix): from B2, "R[2]C[1]" lands on C4', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expect(cell(page, 'B2')).toHaveAttribute('data-active', 'true')

    await openGoTo(page)
    const input = page.getByTestId('go-to-input')
    await input.fill('R[2]C[1]')
    await input.press('Enter')

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()
    // Anchor B2 = (row 1, col 1) + (2, 1) = (row 3, col 2) = C4.
    await expect(cell(page, 'C4')).toHaveAttribute('data-active', 'true')
  })

  test('B4 #4 — named range navigation: MyRange = A1:C5 selects the range', async ({
    page,
  }) => {
    await gotoWave5(page)
    await registerNamedRange(page, 'MyRange', 'sheet-1!A1:C5')

    await cell(page, 'D6').click()

    await openGoTo(page)
    const input = page.getByTestId('go-to-input')
    await input.fill('MyRange')
    await input.press('Enter')

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()
    // Spot-check the rectangle: corners + an interior cell.
    await expect(cell(page, 'A1')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C1')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'A5')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C5')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'B3')).toHaveAttribute('data-selected', 'true')
    // Outside the rect — must stay unselected.
    await expect(cell(page, 'D5')).toHaveAttribute('data-selected', 'false')
  })

  test('B4 #6 — last cell finds the bottom-right populated coord (F9)', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await openGoTo(page)
    await page.getByTestId('go-to-tab-special').click()
    await page.getByTestId('go-to-locator-last-cell').click()
    await page.getByTestId('go-to-confirm-button').click()

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()
    // Wave 5 fixture is populated through row 8, col 5 → F9.
    await expect(cell(page, 'F9')).toHaveAttribute('data-active', 'true')
  })

  test('B4 #7 — current region: inside contiguous block selects A1:F9', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    await openGoTo(page)
    await page.getByTestId('go-to-tab-special').click()
    await page.getByTestId('go-to-locator-current-region').click()
    await page.getByTestId('go-to-confirm-button').click()

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()
    // Corners + interior should all be data-selected.
    await expect(cell(page, 'A1')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'F1')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'A9')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'F9')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C5')).toHaveAttribute('data-selected', 'true')
  })

  test('B4 #8 — dependency-graph locators (precedents/dependents) are disabled', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await openGoTo(page)
    await page.getByTestId('go-to-tab-special').click()

    const precedents = page.getByTestId('go-to-locator-precedents')
    const dependents = page.getByTestId('go-to-locator-dependents')
    await expect(precedents).toBeDisabled()
    await expect(dependents).toBeDisabled()

    // The `title` carrying the i18n explanation lives on the wrapping label
    // (`<label class="gt-radio gt-radio-disabled" title="…">`); read it via
    // the radio's nearest label ancestor.
    const tip = await precedents.evaluate((el) => {
      const label = el.closest('label')
      return label?.getAttribute('title') ?? null
    })
    expect(tip).toBeTruthy()
    expect(tip).toContain('dependency-graph')
  })

  test('B4 #9 — R1C1 invalid format ("RC[abc]") surfaces an error message', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await openGoTo(page)
    const input = page.getByTestId('go-to-input')
    await input.fill('RC[abc]')
    await input.press('Enter')

    // Dialog stays open, error text appears.
    await expect(page.getByTestId('wave5-go-to')).toBeVisible()
    const error = page.getByTestId('go-to-error-text')
    await expect(error).toBeVisible()
    // i18n key `goTo.error.invalidAddress` renders `"{input}" is not a valid…`.
    await expect(error).toContainText('is not a valid cell address')
    await expect(error).toContainText('RC[abc]')
  })

  // TODO(B4-#10 region-cap banner): the current dialog calls
  // `confirmGoToAtom` (which sets `goToOpenAtom=false`, unmounting the
  // dialog) AFTER `setTruncatedLimit`. The banner only renders while
  // `isOpen()` is true, so it is unobservable from the e2e harness as-is.
  // Either the dialog needs a "stay open on truncation" branch or the
  // banner needs to move outside the modal. Re-instate the test once
  // that design point is settled. Unit coverage in
  // `excel/spreadsheet-ui-core/test/go-to/locator-engine.test.ts`
  // already pins the `truncated: true` flag on the scan result.

  test('B4 #11 — row differences scoped to selection rect, not the used range', async ({
    page,
  }) => {
    await gotoWave5(page)
    // Select B2:D5.
    await cell(page, 'B2').click()
    await cell(page, 'D5').click({ modifiers: ['Shift'] })

    await openGoTo(page)
    await page.getByTestId('go-to-tab-special').click()
    await page.getByTestId('go-to-locator-row-differences').click()
    await page.getByTestId('go-to-confirm-button').click()

    await expect(page.getByTestId('wave5-go-to')).toBeHidden()

    // Within B2:D5 — anchor column = B, compare cols C and D against B.
    // Every C and D cell differs from its B-row anchor in the fixture.
    await expect(cell(page, 'C2')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'D2')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C5')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'D5')).toHaveAttribute('data-selected', 'true')

    // Outside the rect MUST NOT be selected — the regression this guards
    // is "row-differences ignored the selection and scanned the used range".
    await expect(cell(page, 'E2')).toHaveAttribute('data-selected', 'false')
    await expect(cell(page, 'C6')).toHaveAttribute('data-selected', 'false')
    await expect(cell(page, 'A2')).toHaveAttribute('data-selected', 'false')
  })

  // TODO(B4-#5 sparse 3x3 blanks fix): the Wave 5 demo's viewport is fixed at
  // 50×16, so we cannot scope a blanks locator to a tightly-bounded 3×3
  // region from the test harness without restructuring the demo. The
  // unit-level coverage in `excel/spreadsheet-ui-core/test/go-to/locator-
  // engine.test.ts` already pins the sparse-fix semantics. Re-instate this
  // e2e once a per-test viewport hook lands.
})
