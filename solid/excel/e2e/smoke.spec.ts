import { test, expect, type Page } from '@playwright/test'
import { withEnglishLocale } from './helpers'

/**
 * Smoke suite for the Solid Excel demo.
 *
 * Each test starts on the "Blank" demo tab — a clean grid backed by the JS
 * mock sheet (createJSSheet). The mock supports basic arithmetic + cell refs,
 * which is all we need for the flows here. Heavier formulas (SUM/IF/etc.)
 * still go through the WASM backend and aren't covered by this smoke suite.
 */

/** Cell <td> for a given address (e.g. "A1"). */
function cell(page: Page, addr: string) {
  return page.locator(`td.cell[data-cell-addr="${addr}"]`)
}

/** The cell-display <span> inside a cell — what the user actually sees. */
function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

/** The active edit input inside a cell. Only present while editing. */
function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

async function gotoBlank(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByRole('button', { name: 'Blank' }).click()
  // The blank table renders A1..J20; wait for it before each test acts.
  await expect(cell(page, 'A1')).toBeVisible()
}

/**
 * Type into a cell by double-clicking it, entering text, and pressing Enter.
 * Mirrors how a user commits a value in the UI.
 */
async function typeIntoCell(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

test.describe('Solid Excel smoke', () => {
  test('cell edit + commit shows the typed value', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '42')
    await expect(cellDisplay(page, 'A1')).toHaveText('42')
  })

  test('formula commit evaluates and displays the result', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '42')
    await typeIntoCell(page, 'B1', '=A1+1')
    await expect(cellDisplay(page, 'B1')).toHaveText('43')
  })

  test('dependency propagation updates downstream cells', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '42')
    await typeIntoCell(page, 'B1', '=A1+1')
    await expect(cellDisplay(page, 'B1')).toHaveText('43')

    // Change A1; B1 must recompute without an extra hint.
    await typeIntoCell(page, 'A1', '100')
    await expect(cellDisplay(page, 'A1')).toHaveText('100')
    await expect(cellDisplay(page, 'B1')).toHaveText('101')
  })

  async function pressShortcut(
    page: Page,
    opts: { shift?: boolean; key?: 'z' | 'y' } = {},
  ) {
    const { shift = false, key = 'z' } = opts
    await page.locator('.excel-table-wrapper').focus()
    const isMac = process.platform === 'darwin'
    const meta = isMac ? 'Meta' : 'Control'
    const combo = shift ? `${meta}+Shift+${key}` : `${meta}+${key}`
    await page.keyboard.press(combo)
  }

  test('Ctrl/Cmd+Z undoes the last commit', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '7')
    await expect(cellDisplay(page, 'A1')).toHaveText('7')

    await pressShortcut(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')
  })

  test('Ctrl/Cmd+Shift+Z redoes after undo', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '7')

    await pressShortcut(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await pressShortcut(page, { shift: true })
    await expect(cellDisplay(page, 'A1')).toHaveText('7')
  })

  test('FormulaBar shows formula source for a formula cell', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '42')
    await typeIntoCell(page, 'B1', '=A1+1')

    // Select B1 — FormulaBar should show "=A1+1", not "43".
    await cell(page, 'B1').click()
    const bar = page.getByTestId('formula-bar-input')
    await expect(bar).toHaveValue('=A1+1')
    await expect(page.getByTestId('formula-bar-addr')).toHaveText('B1')

    // Sanity: the cell itself still shows the result.
    await expect(cellDisplay(page, 'B1')).toHaveText('43')
  })

  test('keyboard navigation moves selection (Arrow + Tab + Shift+Tab)', async ({
    page,
  }) => {
    await gotoBlank(page)
    await cell(page, 'A1').click()
    await expect(cell(page, 'A1')).toHaveClass(/cell-selected/)

    // Arrow / Tab navigation is handled on the table wrapper; focus it so the
    // keydown handler runs.
    await page.locator('.excel-table-wrapper').focus()

    await page.keyboard.press('ArrowRight')
    await expect(cell(page, 'B1')).toHaveClass(/cell-selected/)
    await expect(cell(page, 'A1')).not.toHaveClass(/cell-selected/)

    await page.keyboard.press('Tab')
    await expect(cell(page, 'C1')).toHaveClass(/cell-selected/)

    await page.keyboard.press('Shift+Tab')
    await expect(cell(page, 'B1')).toHaveClass(/cell-selected/)
  })
})
