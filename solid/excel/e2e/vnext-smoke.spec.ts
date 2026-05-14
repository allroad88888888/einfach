import { test, expect, type Page } from '@playwright/test'

test.describe('Solid Excel vNext smoke', () => {
  async function gotoVNextDemo(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'vNext', exact: true }).click()
    await expect(page.getByTestId('vnext-grid')).toBeVisible({ timeout: 30_000 })
  }

  function cell(page: Page, addr: string) {
    return page.locator(`td.cell[data-cell-addr="${addr}"]`)
  }

  function cellDisplay(page: Page, addr: string) {
    return cell(page, addr).locator('.cell-display')
  }

  function cellInput(page: Page, addr: string) {
    return cell(page, addr).locator('.cell-input')
  }

  function formulaBarInput(page: Page) {
    return page.getByTestId('formula-bar-input')
  }

  test('renders only the visible window', async ({ page }) => {
    await gotoVNextDemo(page)

    const visibleCells = await page.locator('[data-testid="vnext-grid"] td.cell').count()
    expect(visibleCells).toBeGreaterThan(0)
    expect(visibleCells).toBeLessThan(80)
    await expect(cell(page, 'A1')).toBeVisible()
    await expect(cell(page, 'J20')).toHaveCount(0)
  })

  test('click selection toggles the active state', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'B1').click()
    await expect(cell(page, 'B1')).toHaveClass(/cell-active/)
    await expect(cell(page, 'A1')).not.toHaveClass(/cell-active/)
  })

  test('double-click edit commits the cell value', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'A1').dblclick()
    const input = cellInput(page, 'A1')
    await expect(input).toBeVisible()
    await input.fill('Edited')
    await input.press('Enter')
    await expect(cellDisplay(page, 'A1')).toHaveText('Edited')
  })

  test('formula bar edits the active visible cell', async ({ page }) => {
    await gotoVNextDemo(page)

    await expect(formulaBarInput(page)).toHaveValue('Alpha')
    await formulaBarInput(page).fill('From formula bar')
    await formulaBarInput(page).press('Enter')
    await expect(cellDisplay(page, 'A1')).toHaveText('From formula bar')
  })

  test('sheet tabs keep active sheet state in vNext atoms', async ({ page }) => {
    await gotoVNextDemo(page)

    const sheet2 = page.getByRole('tab', { name: 'Sheet2' })
    await sheet2.click()
    await expect(sheet2).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('vnext-grid')).toBeVisible()
  })

  test('keyboard boundary movement updates active address without rendering offscreen cells', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'B2').click()
    await page.keyboard.press('Control+ArrowRight')
    await expect(page.getByTestId('formula-bar-addr')).toHaveText('J2')
    await expect(cell(page, 'J2')).toHaveCount(0)
  })

  test('toolbar and context menu use vNext interaction atoms', async ({ page }) => {
    await gotoVNextDemo(page)

    const bold = page.getByTestId('toolbar-btn-bold')
    await expect(bold).toBeEnabled()
    await bold.click()

    await cell(page, 'A1').click({ button: 'right' })
    const menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-menu-target-kind', 'cell')
    await page.getByTestId('context-menu-command-cell.clear').click()
    await expect(menu).toHaveCount(0)
  })
})
