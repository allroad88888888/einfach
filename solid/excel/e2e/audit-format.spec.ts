import { test, expect, type Page, type Locator } from '@playwright/test'

/**
 * Audit suite for the formatting paths exposed by the Wave 5 vnext shell:
 *  - Toolbar buttons: bold / italic / underline / fill-color / text-color / number-format
 *  - Format Painter (single-click arm, double-click sticky)
 *  - Format Cells dialog (5-tab modal, Save/Cancel)
 *
 * Every test exercises one user-visible promise. The spec is intentionally
 * written against the *expected* contract so any regression in the production
 * code surfaces as a deterministic failure with a clear assertion.
 *
 * Scaffolding mirrors `vnext-wave5.spec.ts` (testid-based nav, cell selectors).
 */

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string): Locator {
  return page.locator('[data-testid="wave5-grid"]').locator(
    `td.cell[data-cell-addr="${addr}"]`,
  )
}

function cellDisplay(page: Page, addr: string): Locator {
  return cell(page, addr).locator('.cell-display')
}

const boldBtn = (page: Page) => page.getByTestId('toolbar-btn-bold')
const italicBtn = (page: Page) => page.getByTestId('toolbar-btn-italic')
const underlineBtn = (page: Page) => page.getByTestId('toolbar-btn-underline')
const hAlignBtn = (page: Page) => page.getByTestId('toolbar-btn-h-align')
const hAlignDropdown = (page: Page) => page.getByTestId('toolbar-h-align-dropdown')
const hAlignLeftOpt = (page: Page) => page.getByTestId('toolbar-h-align-left')
const hAlignCenterOpt = (page: Page) => page.getByTestId('toolbar-h-align-center')
const hAlignRightOpt = (page: Page) => page.getByTestId('toolbar-h-align-right')
const fillColorBtn = (page: Page) => page.getByTestId('toolbar-btn-fill-color')
const textColorBtn = (page: Page) => page.getByTestId('toolbar-btn-text-color')
const numberFormatBtn = (page: Page) => page.getByTestId('toolbar-btn-number-format')
const painterBtn = (page: Page) => page.getByTestId('toolbar-btn-format-painter')
const vAlignBtn = (page: Page) => page.getByTestId('toolbar-btn-v-align')
const vAlignDropdown = (page: Page) => page.getByTestId('toolbar-v-align-dropdown')
const vAlignTopOpt = (page: Page) => page.getByTestId('toolbar-v-align-top')
const vAlignMiddleOpt = (page: Page) => page.getByTestId('toolbar-v-align-middle')
const vAlignBottomOpt = (page: Page) => page.getByTestId('toolbar-v-align-bottom')
const strikethroughBtn = (page: Page) => page.getByTestId('toolbar-btn-strikethrough')
const wrapBtn = (page: Page) => page.getByTestId('toolbar-btn-wrap')
const rotationBtn = (page: Page) => page.getByTestId('toolbar-btn-rotation')

test.describe('Format audit — toolbar B/I/U', () => {
  test('bold persists across selection change and re-selection', async ({ page }) => {
    await gotoWave5(page)

    // Select B2 (numeric "180" — no preset format) and turn bold ON.
    await cell(page, 'B2').click()
    await expect(boldBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await boldBtn(page).click()
    await expect(boldBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-weight', '700')

    // Move away.
    await cell(page, 'D2').click()
    await expect(boldBtn(page)).toHaveAttribute('aria-pressed', 'false')

    // Re-select B2 — bold should still be applied + reflected in the toolbar.
    await cell(page, 'B2').click()
    await expect(boldBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-weight', '700')
  })

  test('italic toggles on then off then on', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C2').click()

    await expect(italicBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await italicBtn(page).click()
    await expect(italicBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'C2')).toHaveCSS('font-style', 'italic')

    await italicBtn(page).click()
    await expect(italicBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(cellDisplay(page, 'C2')).toHaveCSS('font-style', 'normal')

    await italicBtn(page).click()
    await expect(italicBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'C2')).toHaveCSS('font-style', 'italic')
  })

  test('underline toggles on then off then on', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    await expect(underlineBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await underlineBtn(page).click()
    await expect(underlineBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'C3')).toHaveCSS('text-decoration-line', 'underline')

    await underlineBtn(page).click()
    await expect(underlineBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(cellDisplay(page, 'C3')).not.toHaveCSS('text-decoration-line', 'underline')

    await underlineBtn(page).click()
    await expect(underlineBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'C3')).toHaveCSS('text-decoration-line', 'underline')
  })
})

test.describe('Format audit — horizontal alignment dropdown', () => {
  test('h-align dropdown 中 applies text-align: center to the active cell', async ({
    page,
  }) => {
    await gotoWave5(page)

    // Select B2 — default alignment before the toolbar is engaged.
    await cell(page, 'B2').click()
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'left')
    await expect(hAlignDropdown(page)).toBeHidden()

    // Open the dropdown and pick 中 / Center.
    await hAlignBtn(page).click()
    await expect(hAlignDropdown(page)).toBeVisible()
    await hAlignCenterOpt(page).click()
    await expect(hAlignDropdown(page)).toBeHidden()

    // The cell display now carries an inline text-align: center; the button
    // mirrors the active alignment via its data attribute.
    await expect(cellDisplay(page, 'B2')).toHaveCSS('text-align', 'center')
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'center')
  })

  test('h-align dropdown left / center / right set alignment exclusively', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'C2').click()

    await hAlignBtn(page).click()
    await hAlignRightOpt(page).click()
    await expect(cellDisplay(page, 'C2')).toHaveCSS('text-align', 'right')
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'right')

    await hAlignBtn(page).click()
    await hAlignLeftOpt(page).click()
    await expect(cellDisplay(page, 'C2')).toHaveCSS('text-align', 'left')
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'left')
  })

  test('h-align dropdown closes on Escape without applying', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await hAlignBtn(page).click()
    await expect(hAlignDropdown(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(hAlignDropdown(page)).toBeHidden()
    // No alignment change.
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'left')
  })
})

test.describe('Format audit — color buttons', () => {
  test('fill color popover applies the picked swatch to the active cell', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    // Click the toolbar fill-color button — it should open the popover, not
    // apply a color directly.
    await fillColorBtn(page).click()
    const popover = page.getByTestId('toolbar-color-popover')
    await expect(popover).toBeVisible()
    await expect(popover).toHaveAttribute('data-mode', 'fill')

    // Pick the canonical yellow swatch (#ffd966).
    await page.getByTestId('color-popover-swatch-#ffd966').click()

    // Popover closes on selection.
    await expect(popover).toBeHidden()

    // The cell display should now be tinted yellow. The format style is
    // applied as inline `background: #ffd966` on `.cell-display`, which the
    // browser computes to rgb(255, 217, 102).
    await expect(cellDisplay(page, 'B2')).toHaveCSS(
      'background-color',
      'rgb(255, 217, 102)',
    )
  })

  test('text color popover applies the picked swatch to the active cell', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B3').click()

    await textColorBtn(page).click()
    const popover = page.getByTestId('toolbar-color-popover')
    await expect(popover).toBeVisible()
    await expect(popover).toHaveAttribute('data-mode', 'text')

    // Pick a recognisable red swatch (#ff0000 → rgb(255, 0, 0)).
    await page.getByTestId('color-popover-swatch-#ff0000').click()

    await expect(popover).toBeHidden()
    await expect(cellDisplay(page, 'B3')).toHaveCSS('color', 'rgb(255, 0, 0)')
  })

  test('color popover closes on Escape and on outside click', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    // Escape closes.
    await fillColorBtn(page).click()
    await expect(page.getByTestId('toolbar-color-popover')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('toolbar-color-popover')).toBeHidden()

    // Outside click also closes — open the popover, then click on a clearly
    // out-of-popover target (the wave5 menu bar) and assert it closes.
    await fillColorBtn(page).click()
    await expect(page.getByTestId('toolbar-color-popover')).toBeVisible()
    await page.getByTestId('wave5-menu-bar').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('toolbar-color-popover')).toBeHidden()
  })
})

test.describe('Format audit — number format', () => {
  test('number-format toolbar button applies a non-General format', async ({ page }) => {
    await gotoWave5(page)
    // B2 holds a number under General formatting. Capture the rendered value
    // so the assertion does not bake in a magic seed.
    await cell(page, 'B2').click()
    const before = (await cellDisplay(page, 'B2').textContent())?.trim() ?? ''
    // Sanity: General-format should render the bare integer with no
    // grouping/decimal hints, so it must consist of digits only.
    expect(before).toMatch(/^\d+$/)

    await numberFormatBtn(page).click()

    // The toolbar should either pop a chooser dropdown OR commit the next
    // format. Either way: the cell text must visibly change (e.g. 120 →
    // 120.00) or a menu should appear so the user can pick a format.
    const maybeMenu = page.getByRole('menu')
    if (await maybeMenu.count()) {
      await expect(maybeMenu.first()).toBeVisible()
      return
    }
    // No menu — assert a visible format change.
    await expect(cellDisplay(page, 'B2')).not.toHaveText(before)
  })

  test('dropdown shows 16 rows; choosing 百分比 turns 120 into 12000%', async ({ page }) => {
    await gotoWave5(page)
    // B2 = 120 under General formatting per the Wave 5 seed.
    await cell(page, 'B2').click()
    await expect(cellDisplay(page, 'B2')).toHaveText('120')

    // Opening the toolbar number-format button must pop the catalog dropdown.
    await numberFormatBtn(page).click()
    const dropdown = page.getByTestId('number-format-dropdown')
    await expect(dropdown).toBeVisible()

    // 16 rows in the order shown in the spec image.
    const items = dropdown.locator('[data-format-id]')
    await expect(items).toHaveCount(16)

    // 万元 ships disabled — the engine has no first-class 10000-unit variant.
    await expect(page.getByTestId('number-format-item-WanYuan')).toBeDisabled()

    // Click 百分比 → format applies, dropdown closes, 120 renders as 12000%.
    await page.getByTestId('number-format-item-Percent').click()
    await expect(dropdown).toBeHidden()
    await expect(cellDisplay(page, 'B2')).toHaveText('12000%')
  })

  test('dropdown closes on Esc and click-outside without applying', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    const before = (await cellDisplay(page, 'B2').textContent())?.trim() ?? ''

    // Esc closes.
    await numberFormatBtn(page).click()
    await expect(page.getByTestId('number-format-dropdown')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('number-format-dropdown')).toBeHidden()
    expect((await cellDisplay(page, 'B2').textContent())?.trim()).toBe(before)

    // Click-outside closes. Use the sidebar which is far to the right of the
    // dropdown's horizontal band and outside the anchor button's rect.
    await numberFormatBtn(page).click()
    await expect(page.getByTestId('number-format-dropdown')).toBeVisible()
    await page.getByTestId('wave5-sidebar').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('number-format-dropdown')).toBeHidden()
  })

  test('自定义格式 row opens the Format Cells dialog on the number tab', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await numberFormatBtn(page).click()
    await expect(page.getByTestId('number-format-dropdown')).toBeVisible()

    await page.getByTestId('number-format-item-Custom').click()
    await expect(page.getByTestId('number-format-dropdown')).toBeHidden()
    await expect(page.getByTestId('wave5-format-cells')).toBeVisible()
  })
})

test.describe('Format audit — format painter', () => {
  test('single-click painter paints exactly one target then disarms', async ({ page }) => {
    await gotoWave5(page)

    // Seed: make B2 bold so the painter has a non-trivial format to copy.
    await cell(page, 'B2').click()
    await boldBtn(page).click()
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-weight', '700')

    // Arm the painter (single click).
    await painterBtn(page).click()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'armed')

    // Paint D2 — should become bold.
    await cell(page, 'D2').click()
    await expect(cellDisplay(page, 'D2')).toHaveCSS('font-weight', '700')

    // After one apply, single-click painter must return to idle.
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'idle')
  })

  test('double-click painter stays sticky across multiple targets', async ({ page }) => {
    await gotoWave5(page)

    // Seed: make B2 bold.
    await cell(page, 'B2').click()
    await boldBtn(page).click()
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-weight', '700')

    // Arm sticky (double click).
    await painterBtn(page).dblclick()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'sticky')

    await cell(page, 'D2').click()
    await expect(cellDisplay(page, 'D2')).toHaveCSS('font-weight', '700')

    // Still sticky — paint E2 too.
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'sticky')
    await cell(page, 'E2').click()
    await expect(cellDisplay(page, 'E2')).toHaveCSS('font-weight', '700')
  })

  test('Esc cancels an armed painter and does not paint the next cell click', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await boldBtn(page).click()
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-weight', '700')

    await painterBtn(page).click()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'armed')

    await page.keyboard.press('Escape')
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'idle')

    // Clicking a fresh cell after Esc must NOT paint it bold (C4 is plain text).
    await cell(page, 'C4').click()
    await expect(cellDisplay(page, 'C4')).not.toHaveCSS('font-weight', '700')
  })

  test('Esc cancels a sticky painter just like an armed one', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await boldBtn(page).click()

    await painterBtn(page).dblclick()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'sticky')

    await page.keyboard.press('Escape')
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'idle')

    await cell(page, 'D4').click()
    await expect(cellDisplay(page, 'D4')).not.toHaveCSS('font-weight', '700')
  })

  test('clicking the painter button while sticky toggles it off (no waiting)', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await boldBtn(page).click()

    await painterBtn(page).dblclick()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'sticky')

    // Re-clicking the same button must immediately cancel. We don't wait the
    // dblclick window because the toolbar's "click while non-idle" branch
    // short-circuits to exitFormatPainterAtom.
    await painterBtn(page).click()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'idle')
  })

  test('switching active sheet while armed clears the painter', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await boldBtn(page).click()

    await painterBtn(page).click()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'armed')

    // Switch to the Forecast tab. The painter state must reset because the
    // captured source cell is no longer visible.
    await page.locator('button.spreadsheet-sheet-tab[data-sheet-id="sheet-2"]').click()
    await expect(
      page.locator('button.spreadsheet-sheet-tab[data-sheet-id="sheet-2"]'),
    ).toHaveAttribute('data-active', 'true')

    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'idle')
  })

  test('grid root exposes data-format-painter-active while armed (cell cursor feedback)', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    const grid = page.getByTestId('wave5-grid')

    // Idle: no attribute at all.
    expect(await grid.getAttribute('data-format-painter-active')).toBeNull()

    await painterBtn(page).click()
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'armed')

    // The grid root now advertises armed state. CSS keys off this attribute
    // to switch the cell cursor (copy/cell), giving the user mid-drag visual
    // feedback that the next click will paint.
    await expect(grid).toHaveAttribute('data-format-painter-active', 'armed')

    await page.keyboard.press('Escape')
    await expect(painterBtn(page)).toHaveAttribute('data-format-painter-state', 'idle')
    // Back to no attribute.
    expect(await grid.getAttribute('data-format-painter-active')).toBeNull()
  })
})

test.describe('Format audit — Format Cells dialog', () => {
  async function openFormatCellsDialog(page: Page) {
    await page.getByTestId('menu-bar-button-format').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.getByTestId('menu-bar-item-format.cells').click()
    await expect(page.getByTestId('wave5-format-cells')).toBeVisible()
  }

  test('Save commits bold + number-format chosen in the dialog', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await openFormatCellsDialog(page)

    // Number tab → choose "number" category.
    await page.getByTestId('format-cells-tab-number').click()
    await page.getByTestId('format-cells-category-number').click()

    // Font tab → tick Bold.
    await page.getByTestId('format-cells-tab-font').click()
    await page.getByTestId('format-cells-bold').check()

    // Save.
    await page.getByTestId('format-cells-save').click()
    await expect(page.getByTestId('wave5-format-cells')).toBeHidden()

    // B2 should now be bold AND show a 2-decimal number formatting
    // (Wave 5 seed value is 120 — under 'number' category that becomes "120.00").
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-weight', '700')
    await expect(cellDisplay(page, 'B2')).toHaveText('120.00')
  })

  test('Cancel discards the draft without mutating the cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C2').click()
    const before = await cellDisplay(page, 'C2').textContent()

    await openFormatCellsDialog(page)
    await page.getByTestId('format-cells-tab-font').click()
    await page.getByTestId('format-cells-bold').check()
    await page.getByTestId('format-cells-cancel').click()
    await expect(page.getByTestId('wave5-format-cells')).toBeHidden()

    await expect(cellDisplay(page, 'C2')).toHaveCSS('font-weight', /^(400|normal)$/)
    expect(await cellDisplay(page, 'C2').textContent()).toBe(before)
  })
})

test.describe('Format audit — vertical alignment dropdown', () => {
  test('v-align dropdown 顶 sets the cell-display CSS to top and updates the button', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    // Default (unset) maps to 'bottom' per the backend contract.
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'bottom')
    await expect(vAlignDropdown(page)).toBeHidden()

    await vAlignBtn(page).click()
    await expect(vAlignDropdown(page)).toBeVisible()
    await vAlignTopOpt(page).click()
    await expect(vAlignDropdown(page)).toBeHidden()

    await expect(cellDisplay(page, 'B2')).toHaveCSS('vertical-align', 'top')
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'top')

    // Move away then back: vertical-align persists.
    await cell(page, 'D2').click()
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'bottom')
    await cell(page, 'B2').click()
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'top')
  })

  test('v-align dropdown 中 (middle) sets the cell-display CSS to middle', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C2').click()

    await vAlignBtn(page).click()
    await vAlignMiddleOpt(page).click()

    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'center')
    // SpreadsheetVerticalAlignment maps the middle button to 'center'. The
    // span renders `vertical-align: center` which the browser normalises to
    // `middle` in table-cell contexts.
    await expect(cellDisplay(page, 'C2')).toHaveCSS('vertical-align', 'middle')
  })

  test('v-align dropdown round-trips top -> bottom on the same cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'D2').click()

    // Top first.
    await vAlignBtn(page).click()
    await vAlignTopOpt(page).click()
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'top')
    await expect(cellDisplay(page, 'D2')).toHaveCSS('vertical-align', 'top')

    // Then bottom — button mirrors the new active value.
    await vAlignBtn(page).click()
    await vAlignBottomOpt(page).click()
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'bottom')
    await expect(cellDisplay(page, 'D2')).toHaveCSS('vertical-align', 'bottom')
  })
})

test.describe('Format audit — borders dropdown', () => {
  const bordersBtn = (page: Page) => page.getByTestId('toolbar-btn-borders')
  const bordersDropdown = (page: Page) => page.getByTestId('toolbar-borders-dropdown')

  async function selectRange(page: Page, fromAddr: string, toAddr: string) {
    const start = cell(page, fromAddr)
    const end = cell(page, toAddr)
    const sb = await start.boundingBox()
    const eb = await end.boundingBox()
    if (!sb || !eb) throw new Error('cells not visible')
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
    await page.mouse.down()
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, { steps: 4 })
    await page.mouse.up()
  }

  // Renderer order — keep in sync with `getCellBordersAttr` in
  // `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`.
  const BORDER_SIDE_ORDER: ReadonlyArray<'top' | 'right' | 'bottom' | 'left'> = [
    'top',
    'right',
    'bottom',
    'left',
  ]

  async function expectCellHasBordersAttr(
    page: Page,
    addr: string,
    expectedSides: ReadonlyArray<'top' | 'right' | 'bottom' | 'left'>,
  ) {
    // The cell <td> exposes its borders via `data-borders="<sides>"` so
    // tests can verify the toolbar's per-cell patch without round-tripping
    // through the Format Cells dialog (which shows a draft seeded blank).
    const target = cell(page, addr)
    const expected = BORDER_SIDE_ORDER.filter((side) => expectedSides.includes(side)).join(' ')
    await expect(target).toHaveAttribute('data-borders', expected)
  }

  test('all-borders preset paints every cell in the A1:B2 selection', async ({ page }) => {
    await gotoWave5(page)

    // Drag-select A1:B2 (2x2).
    await selectRange(page, 'A1', 'B2')
    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cell(page, addr)).toHaveAttribute('data-selected', 'true')
    }

    // Open the borders dropdown (it must not be visible before clicking).
    await expect(bordersDropdown(page)).toBeHidden()
    await bordersBtn(page).click()
    await expect(bordersDropdown(page)).toBeVisible()

    // "Inner border" must be enabled because A1:B2 is multi-cell.
    await expect(page.getByTestId('toolbar-borders-inner')).toBeEnabled()

    // Pick "all borders".
    await page.getByTestId('toolbar-borders-all').click()
    await expect(bordersDropdown(page)).toBeHidden()

    // Each of the four cells should now carry top/right/bottom/left borders.
    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expectCellHasBordersAttr(page, addr, ['top', 'right', 'bottom', 'left'])
    }
  })

  test('outer-border preset only paints the boundary sides of A1:B2', async ({ page }) => {
    await gotoWave5(page)

    await selectRange(page, 'A1', 'B2')
    await bordersBtn(page).click()
    await page.getByTestId('toolbar-borders-outer').click()
    await expect(bordersDropdown(page)).toBeHidden()

    // Each corner of A1:B2 gets exactly two outer sides — the sides that
    // touch the selection boundary.
    await expectCellHasBordersAttr(page, 'A1', ['top', 'left'])
    await expectCellHasBordersAttr(page, 'B1', ['top', 'right'])
    await expectCellHasBordersAttr(page, 'A2', ['bottom', 'left'])
    await expectCellHasBordersAttr(page, 'B2', ['right', 'bottom'])
  })

  test('no-border preset clears borders applied previously', async ({ page }) => {
    await gotoWave5(page)

    await selectRange(page, 'A1', 'B2')
    await bordersBtn(page).click()
    await page.getByTestId('toolbar-borders-all').click()
    await expect(bordersDropdown(page)).toBeHidden()
    await expectCellHasBordersAttr(page, 'A1', ['top', 'right', 'bottom', 'left'])

    // Re-open and pick "no border" — the data attribute should be removed.
    await bordersBtn(page).click()
    await page.getByTestId('toolbar-borders-none').click()
    await expect(bordersDropdown(page)).toBeHidden()
    await expect(cell(page, 'A1')).not.toHaveAttribute('data-borders', /./)
  })

  test('Escape closes the borders dropdown without applying a preset', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await bordersBtn(page).click()
    await expect(bordersDropdown(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(bordersDropdown(page)).toBeHidden()
  })

  test('click outside closes the borders dropdown without applying a preset', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await bordersBtn(page).click()
    await expect(bordersDropdown(page)).toBeVisible()

    // Click on the formula bar — neither the dropdown nor the borders button.
    await page.getByTestId('wave5-formula-bar').click()
    await expect(bordersDropdown(page)).toBeHidden()
  })

  test('inner-border option is disabled on a 1x1 selection', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await bordersBtn(page).click()
    await expect(bordersDropdown(page)).toBeVisible()
    await expect(page.getByTestId('toolbar-borders-inner')).toBeDisabled()

    // Close to clean up.
    await page.keyboard.press('Escape')
    await expect(bordersDropdown(page)).toBeHidden()
  })
})

test.describe('Format audit — font family + size', () => {
  const fontFamilyBtn = (page: Page) => page.getByTestId('toolbar-btn-font-family')
  const fontSizeBtn = (page: Page) => page.getByTestId('toolbar-btn-font-size')
  const fontSizeUpBtn = (page: Page) => page.getByTestId('toolbar-btn-font-size-up')

  test('font-family dropdown on B2 → click Helvetica → cell renders with that family', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await fontFamilyBtn(page).click()
    const dropdown = page.getByTestId('toolbar-font-family-dropdown')
    await expect(dropdown).toBeVisible()

    await page.getByTestId('toolbar-font-family-item-Helvetica').click()
    await expect(dropdown).toBeHidden()

    // The cell-display inline `font-family` must include Helvetica. Browsers
    // canonicalise the value but the substring stays present.
    const fontFamily = await cellDisplay(page, 'B2').evaluate((el) =>
      window.getComputedStyle(el).fontFamily,
    )
    expect(fontFamily.toLowerCase()).toContain('helvetica')
  })

  test('font-size dropdown on B2 → click 24 → cell renders 24px text', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await fontSizeBtn(page).click()
    const dropdown = page.getByTestId('toolbar-font-size-dropdown')
    await expect(dropdown).toBeVisible()

    await page.getByTestId('toolbar-font-size-item-24').click()
    await expect(dropdown).toBeHidden()

    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-size', '24px')
  })

  test('font-size-up on B2 (default 12) renders 13px', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await fontSizeUpBtn(page).click()
    await expect(cellDisplay(page, 'B2')).toHaveCSS('font-size', '13px')
  })
})

test.describe('Format audit — multi-cell range', () => {
  test('bold applied to B2:E2 selection paints all four cells', async ({ page }) => {
    await gotoWave5(page)

    // Drag-select B2:E2.
    const start = cell(page, 'B2')
    const end = cell(page, 'E2')
    const sb = await start.boundingBox()
    const eb = await end.boundingBox()
    if (!sb || !eb) throw new Error('cells not visible')
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
    await page.mouse.down()
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, { steps: 4 })
    await page.mouse.up()

    for (const addr of ['B2', 'C2', 'D2', 'E2']) {
      await expect(cell(page, addr)).toHaveAttribute('data-selected', 'true')
    }

    await boldBtn(page).click()

    for (const addr of ['B2', 'C2', 'D2', 'E2']) {
      await expect(cellDisplay(page, addr)).toHaveCSS('font-weight', '700')
    }
  })
})

test.describe('Format audit — Univer-parity shortcuts', () => {
  const percentBtn = (page: Page) => page.getByTestId('toolbar-btn-percent-format')
  const currencyBtn = (page: Page) => page.getByTestId('toolbar-btn-currency-format')

  test('% shortcut formats B2 (120) as 12000%', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expect(cellDisplay(page, 'B2')).toHaveText('120')

    await percentBtn(page).click()

    // Toolbar shortcut applies the format inline — no dropdown should open.
    await expect(page.getByTestId('number-format-dropdown')).toBeHidden()
    await expect(cellDisplay(page, 'B2')).toHaveText('12000%')
  })

  test('$ shortcut formats B2 (120) as $120.00', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expect(cellDisplay(page, 'B2')).toHaveText('120')

    await currencyBtn(page).click()

    await expect(page.getByTestId('number-format-dropdown')).toBeHidden()
    await expect(cellDisplay(page, 'B2')).toHaveText('$120.00')
  })
})

test.describe('Format audit — merge dropdown', () => {
  const mergeBtn = (page: Page) => page.getByTestId('toolbar-btn-merge')
  const mergeDropdown = (page: Page) => page.getByTestId('toolbar-merge-dropdown')
  const mergeCenterItem = (page: Page) => page.getByTestId('toolbar-merge-center')
  const acrossRowsItem = (page: Page) => page.getByTestId('toolbar-merge-across-rows')
  const acrossColsItem = (page: Page) => page.getByTestId('toolbar-merge-across-cols')
  const unmergeItem = (page: Page) => page.getByTestId('toolbar-merge-unmerge')

  async function selectRange(page: Page, fromAddr: string, toAddr: string) {
    const start = cell(page, fromAddr)
    const end = cell(page, toAddr)
    const sb = await start.boundingBox()
    const eb = await end.boundingBox()
    if (!sb || !eb) throw new Error('cells not visible')
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
    await page.mouse.down()
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, { steps: 4 })
    await page.mouse.up()
  }

  test('1x1 selection disables 合并居中 / 跨列合并 / 跨行合并 in the dropdown', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await expect(mergeDropdown(page)).toBeHidden()
    await mergeBtn(page).click()
    await expect(mergeDropdown(page)).toBeVisible()

    await expect(mergeCenterItem(page)).toBeDisabled()
    await expect(acrossRowsItem(page)).toBeDisabled()
    await expect(acrossColsItem(page)).toBeDisabled()
    // Unmerge is also disabled because A1 sits in no merged range.
    await expect(unmergeItem(page)).toBeDisabled()

    await page.keyboard.press('Escape')
    await expect(mergeDropdown(page)).toBeHidden()
  })

  test('合并居中 on A1:B2 anchors at A1 and hides B1/A2/B2', async ({ page }) => {
    await gotoWave5(page)

    await selectRange(page, 'A1', 'B2')
    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cell(page, addr)).toHaveAttribute('data-selected', 'true')
    }

    await mergeBtn(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await expect(mergeCenterItem(page)).toBeEnabled()
    await mergeCenterItem(page).click()
    await expect(mergeDropdown(page)).toBeHidden()

    // A1 is now the merge anchor and spans 2x2.
    const anchor = cell(page, 'A1')
    await expect(anchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(anchor).toHaveAttribute('rowspan', '2')
    await expect(anchor).toHaveAttribute('colspan', '2')

    // B1 / A2 / B2 are covered by the anchor's span — their TDs are no
    // longer in the DOM.
    await expect(
      page.locator('[data-testid="wave5-grid"] td[data-row="0"][data-col="1"]'),
    ).toHaveCount(0)
    await expect(
      page.locator('[data-testid="wave5-grid"] td[data-row="1"][data-col="0"]'),
    ).toHaveCount(0)
    await expect(
      page.locator('[data-testid="wave5-grid"] td[data-row="1"][data-col="1"]'),
    ).toHaveCount(0)
  })

  test('after merge: 取消合并 enables, clicking it restores all four cells', async ({
    page,
  }) => {
    await gotoWave5(page)

    await selectRange(page, 'A1', 'B2')
    await mergeBtn(page).click()
    await mergeCenterItem(page).click()
    await expect(cell(page, 'A1')).toHaveAttribute('data-merge-anchor', 'true')

    // Re-open the dropdown — unmerge must now be enabled.
    await mergeBtn(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await expect(unmergeItem(page)).toBeEnabled()
    await unmergeItem(page).click()
    await expect(mergeDropdown(page)).toBeHidden()

    // All four cells render again as their own TDs.
    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cell(page, addr)).toBeVisible()
    }
    await expect(cell(page, 'A1')).toHaveAttribute('rowspan', '1')
    await expect(cell(page, 'A1')).toHaveAttribute('colspan', '1')
  })
})

test.describe('Format audit — strikethrough toolbar', () => {
  test('strikethrough toggles text-decoration-line: line-through on B2', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await expect(strikethroughBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await strikethroughBtn(page).click()
    await expect(strikethroughBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'B2')).toHaveCSS('text-decoration-line', 'line-through')

    // Toggle off — line-through must clear.
    await strikethroughBtn(page).click()
    await expect(strikethroughBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(cellDisplay(page, 'B2')).not.toHaveCSS('text-decoration-line', 'line-through')
  })
})

test.describe('Format audit — wrap toolbar', () => {
  test('wrap toggles overflow-wrap on B2 and is pressed', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await expect(wrapBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await wrapBtn(page).click()
    await expect(wrapBtn(page)).toHaveAttribute('aria-pressed', 'true')
    // Renderer sets `white-space: normal`, `word-break: break-word`,
    // `overflow-wrap: anywhere` when wrap (or overflow === 'wrap') is
    // engaged. `overflow-wrap: anywhere` is the most distinctive marker
    // because the browser default is `normal`.
    await expect(cellDisplay(page, 'B2')).toHaveCSS('overflow-wrap', 'anywhere')
    await expect(cellDisplay(page, 'B2')).toHaveCSS('white-space', 'normal')

    await wrapBtn(page).click()
    await expect(wrapBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(cellDisplay(page, 'B2')).not.toHaveCSS('overflow-wrap', 'anywhere')
  })
})

test.describe('Format audit — rotation dropdown', () => {
  test('opening the dropdown shows the 6 preset options', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await rotationBtn(page).click()
    const dropdown = page.getByTestId('toolbar-rotation-dropdown')
    await expect(dropdown).toBeVisible()
    await expect(page.getByTestId('toolbar-rotation-0')).toBeVisible()
    await expect(page.getByTestId('toolbar-rotation-45')).toBeVisible()
    await expect(page.getByTestId('toolbar-rotation-90')).toBeVisible()
    await expect(page.getByTestId('toolbar-rotation-neg45')).toBeVisible()
    await expect(page.getByTestId('toolbar-rotation-neg90')).toBeVisible()
    await expect(page.getByTestId('toolbar-rotation-vertical')).toBeVisible()
  })

  test('picking 90° applies rotate(90deg) transform to B2', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await rotationBtn(page).click()
    await page.getByTestId('toolbar-rotation-90').click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeHidden()

    // Computed `transform` for `rotate(90deg)` is the 2D matrix
    // `matrix(0, 1, -1, 0, 0, 0)` (browsers sometimes round cos(90°) to a
    // tiny epsilon like 6.1e-17 instead of 0).
    const transform = await cellDisplay(page, 'B2').evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(transform).toMatch(/^matrix\(/)
    // Second matrix slot is sin(90°) = 1, third is -sin = -1 — invariant
    // regardless of how the engine renders cos(90°).
    expect(transform).toMatch(/matrix\([^,]+,\s*1\s*,\s*-1\s*,/)
  })

  test('picking 竖排 (vertical) sets writing-mode to vertical-rl', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await rotationBtn(page).click()
    await page.getByTestId('toolbar-rotation-vertical').click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeHidden()

    await expect(cellDisplay(page, 'B2')).toHaveCSS('writing-mode', 'vertical-rl')
  })

  test('Escape closes the rotation dropdown without applying a preset', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await rotationBtn(page).click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeHidden()
    // Transform untouched.
    const transform = await cellDisplay(page, 'B2').evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(transform === 'none' || transform === '').toBeTruthy()
  })
})
