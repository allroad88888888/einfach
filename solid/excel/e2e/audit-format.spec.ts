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
const alignLeftBtn = (page: Page) => page.getByTestId('toolbar-btn-align-left')
const alignCenterBtn = (page: Page) => page.getByTestId('toolbar-btn-align-center')
const alignRightBtn = (page: Page) => page.getByTestId('toolbar-btn-align-right')
const fillColorBtn = (page: Page) => page.getByTestId('toolbar-btn-fill-color')
const textColorBtn = (page: Page) => page.getByTestId('toolbar-btn-text-color')
const numberFormatBtn = (page: Page) => page.getByTestId('toolbar-btn-number-format')
const painterBtn = (page: Page) => page.getByTestId('toolbar-btn-format-painter')
const vAlignTopBtn = (page: Page) => page.getByTestId('toolbar-btn-vertical-align-top')
const vAlignMiddleBtn = (page: Page) => page.getByTestId('toolbar-btn-vertical-align-middle')
const vAlignBottomBtn = (page: Page) => page.getByTestId('toolbar-btn-vertical-align-bottom')

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

test.describe('Format audit — horizontal alignment', () => {
  test('center button applies text-align: center to the active cell', async ({ page }) => {
    await gotoWave5(page)

    // Select B2 — the seed value should render with the default (left)
    // alignment before the toolbar is engaged.
    await cell(page, 'B2').click()
    await expect(alignCenterBtn(page)).toHaveAttribute('aria-pressed', 'false')

    // Click 居中 / Center.
    await alignCenterBtn(page).click()

    // The cell display now carries an inline text-align: center.
    await expect(cellDisplay(page, 'B2')).toHaveCSS('text-align', 'center')
    // And the toolbar button reflects the depressed (active) state.
    await expect(alignCenterBtn(page)).toHaveAttribute('aria-pressed', 'true')
  })

  test('left / center / right buttons each set the active alignment exclusively', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'C2').click()

    await alignRightBtn(page).click()
    await expect(cellDisplay(page, 'C2')).toHaveCSS('text-align', 'right')
    await expect(alignRightBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(alignCenterBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(alignLeftBtn(page)).toHaveAttribute('aria-pressed', 'false')

    await alignLeftBtn(page).click()
    await expect(cellDisplay(page, 'C2')).toHaveCSS('text-align', 'left')
    await expect(alignLeftBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(alignRightBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(alignCenterBtn(page)).toHaveAttribute('aria-pressed', 'false')
  })
})

test.describe('Format audit — color buttons', () => {
  test('fill color paints the active cell background', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await fillColorBtn(page).click()

    // Toolbar wires fill-color to the literal "#ffd966".
    // CSS computed background-color reports as rgb(255, 217, 102).
    await expect(cellDisplay(page, 'B2')).toHaveCSS(
      'background-color',
      'rgb(255, 217, 102)',
    )
  })

  test('text color paints the active cell foreground', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B3').click()
    await textColorBtn(page).click()

    // Toolbar wires text-color to the literal "#000000" → rgb(0, 0, 0).
    await expect(cellDisplay(page, 'B3')).toHaveCSS('color', 'rgb(0, 0, 0)')
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

test.describe('Format audit — vertical alignment toolbar', () => {
  test('vertical-align top sets the cell-display CSS to top and presses the button', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await vAlignTopBtn(page).click()

    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'B2')).toHaveCSS('vertical-align', 'top')

    // Move away then back: vertical-align persists.
    await cell(page, 'D2').click()
    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await cell(page, 'B2').click()
    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'true')
  })

  test('vertical-align middle (center) sets the cell-display CSS to middle', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C2').click()

    await expect(vAlignMiddleBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await vAlignMiddleBtn(page).click()

    await expect(vAlignMiddleBtn(page)).toHaveAttribute('aria-pressed', 'true')
    // SpreadsheetVerticalAlignment maps the middle button to 'center'. The
    // span renders `vertical-align: center` (a recognised CSS keyword for
    // the rule even if the browser normalises it for table-cell contexts).
    await expect(cellDisplay(page, 'C2')).toHaveCSS('vertical-align', 'middle')
  })

  test('vertical-align bottom round-trips top → bottom on the same cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'D2').click()

    // Default state — no button pressed.
    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(vAlignMiddleBtn(page)).toHaveAttribute('aria-pressed', 'false')

    // Top first.
    await vAlignTopBtn(page).click()
    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'D2')).toHaveCSS('vertical-align', 'top')

    // Then bottom — top button releases, bottom presses.
    await vAlignBottomBtn(page).click()
    await expect(vAlignTopBtn(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(vAlignBottomBtn(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'D2')).toHaveCSS('vertical-align', 'bottom')
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
