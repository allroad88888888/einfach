import { test, expect } from '@playwright/test'
import {
  cell,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  selectCell,
  typeIntoCell,
} from './helpers'

/**
 * P1: Right-click context menu on the Blank demo.
 *
 * Covers:
 *  1. Column header → "Insert column before" shifts that column right
 *  2. Row header → "Delete row" pulls the next row up
 *  3. Cell area → "Insert row above" pushes the cell's content down
 *  4. Escape closes the menu (no `.context-menu` left in the DOM)
 *
 * The menu is portaled to `document.body`, so we never scope the menu
 * locator to the table wrapper — always look up via `page.locator`.
 */

const DEMO = 'Blank'

test.describe('ContextMenu — table operations', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('column header → Insert column before shifts B1 to C1', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'B1', 'before')
    await expectDisplay(page, 'B1', 'before')

    // Right-click the B column header (the 2nd col-header — index 1).
    const colB = page.locator('th.col-header').nth(1)
    await colB.click({ button: 'right' })

    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()
    await ctxMenu.getByRole('menuitem', { name: 'Insert column before' }).click()

    // Old B1 value is now in C1; B1 is empty.
    await expectDisplay(page, 'C1', 'before')
    await expect(cell(page, 'B1').locator('.cell-display')).toHaveText('')
  })

  test('row header → Delete row pulls A4 into A3', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A3', 'gone')
    await typeIntoCell(page, 'A4', 'survivor')

    // Right-click the row 3 number cell (tbody td.row-header nth(2) — 0-based).
    const row3 = page.locator('tbody td.row-header').nth(2)
    await row3.click({ button: 'right' })

    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()
    await ctxMenu.getByRole('menuitem', { name: 'Delete row' }).click()

    // A4's content shifts to A3; A3's old "gone" is removed.
    await expectDisplay(page, 'A3', 'survivor')
  })

  test('cell → Insert row above pushes A1 content into A2', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A1', 'pushed')
    await expectDisplay(page, 'A1', 'pushed')

    // Right-click cell A1 itself.
    await cell(page, 'A1').click({ button: 'right' })

    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()
    await ctxMenu.getByRole('menuitem', { name: 'Insert row above' }).click()

    // A1 is now empty; original content lives in A2.
    await expect(cell(page, 'A1').locator('.cell-display')).toHaveText('')
    await expectDisplay(page, 'A2', 'pushed')
  })

  test('right-clicking inside A1:B2 keeps the range active for Clear', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A1', 'a1')
    await typeIntoCell(page, 'B1', 'b1')
    await typeIntoCell(page, 'A2', 'a2')
    await typeIntoCell(page, 'B2', 'b2')

    await selectCell(page, 'A1')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')

    await cell(page, 'B1').click({ button: 'right' })
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()

    await expect(cell(page, 'B2')).toHaveClass(/cell-selected/)
    await ctxMenu.getByRole('menuitem', { name: 'Clear' }).click()

    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expectDisplay(page, addr, '')
    }
  })

  test('Escape closes the menu — no .context-menu in DOM', async ({ page }) => {
    await gotoDemo(page, DEMO)

    await cell(page, 'A1').click({ button: 'right' })
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(ctxMenu).toHaveCount(0)
  })
})
