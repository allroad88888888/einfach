import { expect, test, type Page } from '@playwright/test'
import { cell, cellDisplay, guardConsoleErrors, withEnglishLocale } from './helpers'

/**
 * COMPREHENSIVE toolbar coverage — gap-filling.
 *
 * Many toolbar groups already have dedicated spec files. To avoid duplicate
 * coverage, each describe block below either:
 *   (a) tests features that no existing spec exercises, or
 *   (b) is a small TODO-style placeholder that documents where coverage
 *       already lives (kept here as a navigation aid; runs nothing).
 *
 * Existing per-group specs (do not duplicate):
 *   - toolbar-history.spec.ts            history undo/redo + button-driven format toggle replay
 *   - toolbar-format-painter.spec.ts     idle/armed/sticky transitions, Escape, single + sticky paint
 *   - toolbar-clear-format.spec.ts       clear formats removes bold/fill/text-color
 *   - toolbar-comment.spec.ts            opens thread on active cell, drafting disables button
 *   - toolbar-font-family.spec.ts        dropdown opens, picks Helvetica, Escape closes
 *   - toolbar-font-size.spec.ts          default 12, up/down arrows, preset 24 via dropdown
 *   - toolbar-text-style.spec.ts         bold/italic/underline/strikethrough click toggles
 *   - toolbar-colors.spec.ts             font color + fill color popovers, swatch + Escape
 *   - toolbar-borders.spec.ts            all / outer / inner / none presets + multi/single rules
 *   - toolbar-alignment.spec.ts          h-align center/right, v-align top/middle, wrap, rotation 90 + vertical
 *   - toolbar-merge.spec.ts              merge-center / across-rows / across-cols / unmerge
 *   - toolbar-conditional-format.spec.ts opens conditional format dialog, save, Escape, X close
 *   - toolbar-data-validation.spec.ts    opens dialog, list rule, cancel path, drafting disables
 *   - toolbar-name-manager.spec.ts       opens, save persists, close resets unsaved draft
 *   - toolbar-find-replace.spec.ts       toolbar opens dialog, find-next, close button
 *   - toolbar-filter-sort.spec.ts        filter + sort dropdowns + sort asc/desc
 *   - toolbar-number-format.spec.ts      number format dropdown + percent + currency + inc/dec
 *   - toolbar-more-number-formats.spec.ts extended catalog dialogs (currency / date / number)
 *
 * What THIS spec adds:
 *   - print-preview overlay open/close (no existing spec)
 *   - keyboard shortcuts Ctrl+I / Ctrl+U / Ctrl+Z / Ctrl+Y mirror their buttons
 *   - border presets top / right / bottom / left (only all/outer/inner/none in toolbar-borders)
 *   - rotation presets 0, 45, -45, -90 (only 90 + vertical in toolbar-alignment)
 *   - h-align left (only center/right in toolbar-alignment)
 *   - v-align bottom (only top/middle in toolbar-alignment)
 *   - one-shot top-level "every toolbar button is visible" sanity check
 */

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

async function selectRange(page: Page, fromAddr: string, toAddr: string) {
  const start = cell(page, fromAddr)
  const end = cell(page, toAddr)
  const startBox = await start.boundingBox()
  const endBox = await end.boundingBox()
  if (!startBox || !endBox) throw new Error('cells not visible for range drag')
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, { steps: 4 })
  await page.mouse.up()
}

test.describe('toolbar — sanity', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('every documented toolbar button mounts and is visible', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const buttonTestIds = [
      'toolbar-btn-undo',
      'toolbar-btn-redo',
      'toolbar-btn-format-painter',
      'toolbar-btn-clear-format',
      'toolbar-btn-print-preview',
      'toolbar-btn-comment',
      'toolbar-btn-font-family',
      'toolbar-btn-font-size',
      'toolbar-btn-font-size-up',
      'toolbar-btn-font-size-down',
      'toolbar-btn-bold',
      'toolbar-btn-italic',
      'toolbar-btn-underline',
      'toolbar-btn-strikethrough',
      'toolbar-btn-fill-color',
      'toolbar-btn-text-color',
      'toolbar-btn-borders',
      'toolbar-btn-h-align',
      'toolbar-btn-v-align',
      'toolbar-btn-wrap',
      'toolbar-btn-rotation',
      'toolbar-btn-merge',
      'toolbar-btn-find-replace',
      'toolbar-btn-conditional-format',
      'toolbar-btn-data-validation',
      'toolbar-btn-filter',
      'toolbar-btn-sort',
      'toolbar-btn-name-manager',
      'toolbar-btn-number-format',
      'toolbar-btn-percent-format',
      'toolbar-btn-currency-format',
      'toolbar-btn-inc-decimal',
      'toolbar-btn-dec-decimal',
    ]

    for (const id of buttonTestIds) {
      await expect(page.getByTestId(id), `${id} should be visible`).toBeVisible()
    }
  })
})

test.describe('toolbar — print preview', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('clicking toolbar-btn-print-preview opens the wave5 overlay', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    const overlay = page.getByTestId('wave5-print-preview')
    await expect(overlay).toHaveCount(0)

    await page.getByTestId('toolbar-btn-print-preview').click()

    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute('role', 'dialog')
    await expect(overlay).toHaveAttribute('aria-label', 'Print preview')
  })

  test('Escape closes the print preview overlay', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await page.getByTestId('toolbar-btn-print-preview').click()
    const overlay = page.getByTestId('wave5-print-preview')
    await expect(overlay).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
  })

  test('print preview Close preview button dismisses the overlay', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await page.getByTestId('toolbar-btn-print-preview').click()
    const overlay = page.getByTestId('wave5-print-preview')
    await expect(overlay).toBeVisible()

    await overlay.getByTestId('print-close-button').click()
    await expect(overlay).toHaveCount(0)
  })

  test('print preview surfaces orientation and scale text', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await page.getByTestId('toolbar-btn-print-preview').click()
    const overlay = page.getByTestId('wave5-print-preview')
    await expect(overlay).toBeVisible()

    const orientation = (await overlay.getByTestId('print-orientation-text').textContent())?.trim()
    expect(orientation === 'portrait' || orientation === 'landscape').toBe(true)

    const scale = (await overlay.getByTestId('print-scale-text').textContent())?.trim() ?? ''
    expect(scale).toBeTruthy()
  })
})

test.describe('toolbar — keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('Ctrl+I mirrors italic button toggle on active cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    const italicButton = page.getByTestId('toolbar-btn-italic')
    await expect(italicButton).toHaveAttribute('aria-pressed', 'false')

    await page.keyboard.press('Control+i')
    await expect(italicButton).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'C3')).toHaveCSS('font-style', 'italic')

    await page.keyboard.press('Control+i')
    await expect(italicButton).toHaveAttribute('aria-pressed', 'false')
  })

  test('Ctrl+U mirrors underline button toggle on active cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'D3').click()

    const underlineButton = page.getByTestId('toolbar-btn-underline')
    await expect(underlineButton).toHaveAttribute('aria-pressed', 'false')

    await page.keyboard.press('Control+u')
    await expect(underlineButton).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, 'D3')).toHaveCSS('text-decoration-line', 'underline')

    await page.keyboard.press('Control+u')
    await expect(underlineButton).toHaveAttribute('aria-pressed', 'false')
  })

  test('Ctrl+Z drives the undo button after a format change', async ({ page }) => {
    await gotoWave5(page)
    const target = 'B2'
    await cell(page, target).click()

    const display = cellDisplay(page, target)
    const baseWeight = await display.evaluate((el) => getComputedStyle(el).fontWeight)
    const undoButton = page.getByTestId('toolbar-btn-undo')

    await expect(undoButton).toBeDisabled()
    await page.getByTestId('toolbar-btn-bold').click()
    await expect(display).not.toHaveCSS('font-weight', baseWeight)
    await expect(undoButton).toBeEnabled()

    await page.keyboard.press('Control+z')
    await expect(display).toHaveCSS('font-weight', baseWeight)
  })

  test('Ctrl+Y drives the redo button after an undo', async ({ page }) => {
    await gotoWave5(page)
    const target = 'B2'
    await cell(page, target).click()

    const display = cellDisplay(page, target)
    const baseWeight = await display.evaluate((el) => getComputedStyle(el).fontWeight)
    const redoButton = page.getByTestId('toolbar-btn-redo')

    await page.getByTestId('toolbar-btn-bold').click()
    await expect(display).not.toHaveCSS('font-weight', baseWeight)

    await page.keyboard.press('Control+z')
    await expect(display).toHaveCSS('font-weight', baseWeight)
    await expect(redoButton).toBeEnabled()

    await page.keyboard.press('Control+y')
    await expect(display).not.toHaveCSS('font-weight', baseWeight)
  })
})

test.describe('toolbar — h-align (left preset)', () => {
  // center + right covered in toolbar-alignment.spec.ts
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-h-align-left resets text-align back to left after center', async ({ page }) => {
    await gotoWave5(page)
    const target = 'C2'
    await cell(page, target).click()

    const button = page.getByTestId('toolbar-btn-h-align')
    const dropdown = page.getByTestId('toolbar-h-align-dropdown')

    await button.click()
    await expect(dropdown).toBeVisible()
    await page.getByTestId('toolbar-h-align-center').click()
    await expect(button).toHaveAttribute('data-active-align', 'center')
    await expect(cellDisplay(page, target)).toHaveCSS('text-align', 'center')

    await button.click()
    await expect(dropdown).toBeVisible()
    await page.getByTestId('toolbar-h-align-left').click()
    await expect(dropdown).toBeHidden()
    await expect(button).toHaveAttribute('data-active-align', 'left')
    await expect(cellDisplay(page, target)).toHaveCSS('text-align', 'left')
  })
})

test.describe('toolbar — v-align (bottom preset)', () => {
  // top + middle covered in toolbar-alignment.spec.ts
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-v-align-bottom updates --cell-vertical-align to bottom', async ({ page }) => {
    await gotoWave5(page)
    const target = 'D2'
    await cell(page, target).click()

    const button = page.getByTestId('toolbar-btn-v-align')
    await button.click()
    await expect(page.getByTestId('toolbar-v-align-dropdown')).toBeVisible()
    await page.getByTestId('toolbar-v-align-bottom').click()
    await expect(page.getByTestId('toolbar-v-align-dropdown')).toBeHidden()

    await expect(button).toHaveAttribute('data-active-vertical-align', 'bottom')
    const style = await cellDisplay(page, target).evaluate((el) => ({
      cellVerticalAlign: el.style.getPropertyValue('--cell-vertical-align'),
      marginTop: el.style.marginTop,
      marginBottom: el.style.marginBottom,
    }))
    expect(style.cellVerticalAlign).toBe('bottom')
    expect(style.marginTop).toBe('auto')
    expect(style.marginBottom).toBe('0px')
  })
})

test.describe('toolbar — border side presets', () => {
  // all / outer / inner / none covered in toolbar-borders.spec.ts
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  async function pickBorderPreset(page: Page, preset: 'top' | 'right' | 'bottom' | 'left') {
    await page.getByTestId('toolbar-btn-borders').click()
    await expect(page.getByTestId('toolbar-borders-dropdown')).toBeVisible()
    await page.getByTestId(`toolbar-borders-${preset}`).click()
    await expect(page.getByTestId('toolbar-borders-dropdown')).toBeHidden()
  }

  test('top preset only paints the top edge of the range', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await pickBorderPreset(page, 'top')

    await expect(cell(page, 'A1')).toHaveAttribute('data-borders', 'top')
    await expect(cell(page, 'B1')).toHaveAttribute('data-borders', 'top')
    await expect(cell(page, 'A2')).not.toHaveAttribute('data-borders', /./)
    await expect(cell(page, 'B2')).not.toHaveAttribute('data-borders', /./)
  })

  test('bottom preset only paints the bottom edge of the range', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await pickBorderPreset(page, 'bottom')

    await expect(cell(page, 'A2')).toHaveAttribute('data-borders', 'bottom')
    await expect(cell(page, 'B2')).toHaveAttribute('data-borders', 'bottom')
    await expect(cell(page, 'A1')).not.toHaveAttribute('data-borders', /./)
    await expect(cell(page, 'B1')).not.toHaveAttribute('data-borders', /./)
  })

  test('left preset only paints the left edge of the range', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await pickBorderPreset(page, 'left')

    await expect(cell(page, 'A1')).toHaveAttribute('data-borders', 'left')
    await expect(cell(page, 'A2')).toHaveAttribute('data-borders', 'left')
    await expect(cell(page, 'B1')).not.toHaveAttribute('data-borders', /./)
    await expect(cell(page, 'B2')).not.toHaveAttribute('data-borders', /./)
  })

  test('right preset only paints the right edge of the range', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await pickBorderPreset(page, 'right')

    await expect(cell(page, 'B1')).toHaveAttribute('data-borders', 'right')
    await expect(cell(page, 'B2')).toHaveAttribute('data-borders', 'right')
    await expect(cell(page, 'A1')).not.toHaveAttribute('data-borders', /./)
    await expect(cell(page, 'A2')).not.toHaveAttribute('data-borders', /./)
  })
})

test.describe('toolbar — rotation extended presets', () => {
  // 90 + vertical covered in toolbar-alignment.spec.ts
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  async function pickRotation(
    page: Page,
    suffix: '0' | '45' | '90' | 'neg45' | 'neg90' | 'vertical',
  ) {
    await page.getByTestId('toolbar-btn-rotation').click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeVisible()
    await page.getByTestId(`toolbar-rotation-${suffix}`).click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeHidden()
  }

  test('rotation 45 emits a non-identity transform on the cell', async ({ page }) => {
    await gotoWave5(page)
    const target = 'E2'
    await cell(page, target).click()
    await pickRotation(page, '45')

    const transform = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(transform).toMatch(/^matrix\(/)
    expect(transform).not.toBe('none')
  })

  test('rotation -45 emits a non-identity transform on the cell', async ({ page }) => {
    await gotoWave5(page)
    const target = 'E3'
    await cell(page, target).click()
    await pickRotation(page, 'neg45')

    const transform = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(transform).toMatch(/^matrix\(/)
    expect(transform).not.toBe('none')
  })

  test('rotation -90 emits a rotated transform on the cell', async ({ page }) => {
    await gotoWave5(page)
    const target = 'E4'
    await cell(page, target).click()
    await pickRotation(page, 'neg90')

    const transform = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(transform).toMatch(/^matrix\(/)
    // -90 → matrix(..., -1, 1, ...).
    expect(transform).toMatch(/,\s*-1(\.0+)?\s*,\s*1(\.0+)?\s*,/)
  })

  test('rotation 0 clears prior rotation back to identity / none', async ({ page }) => {
    await gotoWave5(page)
    const target = 'E5'
    await cell(page, target).click()

    await pickRotation(page, '90')
    const rotated = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(rotated).toMatch(/^matrix\(/)
    expect(rotated).not.toBe('none')

    await pickRotation(page, '0')
    const reset = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )
    // 0° collapses to 'none' or identity matrix.
    expect(reset === 'none' || reset === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true)
  })

  test('outside click closes rotation dropdown without applying', async ({ page }) => {
    await gotoWave5(page)
    const target = 'E6'
    await cell(page, target).click()
    const before = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )

    await page.getByTestId('toolbar-btn-rotation').click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeVisible()
    await page.getByTestId('wave5-formula-bar').click()
    await expect(page.getByTestId('toolbar-rotation-dropdown')).toBeHidden()

    const after = await cellDisplay(page, target).evaluate(
      (el) => getComputedStyle(el).transform,
    )
    expect(after).toBe(before)
  })
})

test.describe('toolbar — group coverage map (TODOs)', () => {
  // These placeholders document where each toolbar group is already covered.
  // They are .skip so the suite stays green but the cross-reference is in the
  // test report.

  test.skip('history — see toolbar-history.spec.ts', () => {})
  test.skip('format painter — see toolbar-format-painter.spec.ts', () => {})
  test.skip('clear formats — see toolbar-clear-format.spec.ts', () => {})
  test.skip('comments — see toolbar-comment.spec.ts', () => {})
  test.skip('font family — see toolbar-font-family.spec.ts', () => {})
  test.skip('font size — see toolbar-font-size.spec.ts', () => {})
  test.skip('text styles bold/italic/underline/strikethrough — see toolbar-text-style.spec.ts', () => {})
  test.skip('font + fill color popovers — see toolbar-colors.spec.ts', () => {})
  test.skip('borders all/outer/inner/none — see toolbar-borders.spec.ts', () => {})
  test.skip('alignment h-center/right + v-top/middle + wrap + rotation 90/vertical — see toolbar-alignment.spec.ts', () => {})
  test.skip('merge cells (center/across-rows/across-cols/unmerge) — see toolbar-merge.spec.ts', () => {})
  test.skip('conditional format dialog — see toolbar-conditional-format.spec.ts', () => {})
  test.skip('data validation dialog — see toolbar-data-validation.spec.ts', () => {})
  test.skip('name manager dialog — see toolbar-name-manager.spec.ts', () => {})
  test.skip('find / replace — see toolbar-find-replace.spec.ts', () => {})
  test.skip('filter + sort — see toolbar-filter-sort.spec.ts', () => {})
  test.skip('number format basics + inc/dec decimal — see toolbar-number-format.spec.ts', () => {})
  test.skip('extended number format catalogs — see toolbar-more-number-formats.spec.ts', () => {})
  test.skip('Ctrl+B bold shortcut — see vnext-wave5.spec.ts ("Ctrl+B keyboard shortcut")', () => {})
})
