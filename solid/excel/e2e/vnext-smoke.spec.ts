import { test, expect, type Page } from '@playwright/test'
import { grantClipboard, withEnglishLocale } from './helpers'

test.describe('Solid Excel vNext smoke', () => {
  async function gotoVNextDemo(page: Page) {
    // The app boots locale=zh by default (commit dede42a); this spec pins
    // the EN status-bar strings ("Ready", "<N> cells"), so navigate with
    // `?locale=en` like every other legacy spec (see helpers.ts).
    await page.goto(withEnglishLocale())
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

  test('app boots directly into the Wave 5 demo by default', async ({ page }) => {
    // Commit dede42a flipped the default boot tab to vnext-wave5; the
    // vNext smoke demo is still reachable via the nav button.
    await page.goto('/')
    await expect(page.getByTestId('nav-tab-vnext-wave5')).toHaveClass(/tab-active/)
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  })

  test('renders only the visible window', async ({ page }) => {
    await gotoVNextDemo(page)

    const visibleCells = await page.locator('[data-testid="vnext-grid"] td.cell').count()
    expect(visibleCells).toBeGreaterThan(0)
    expect(visibleCells).toBeLessThan(80)
    await expect(cell(page, 'A1')).toBeVisible()
    await expect(cell(page, 'J20')).toHaveCount(0)
    await expect(page.getByTestId('status-active-cell')).toHaveText('A1')
    await expect(page.getByTestId('status-projection')).toHaveText('Ready')
    // Status bar mirrors the live visible window which depends on the
    // rendered scroll-viewport size (CSS `max-height: 70vh` + the browser's
    // window dimensions). The `<N> cells` shape check is enough to confirm
    // the status bar wired through to a non-empty projection.
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
  })

  test('renders projected rich cells without expanding the visible window', async ({ page }) => {
    await gotoVNextDemo(page)

    await expect(cellDisplay(page, 'E5')).toHaveText('Docs')
    await expect(cell(page, 'E5')).toHaveAttribute('data-rich-kind', 'hyperlink')
    await expect(cell(page, 'E5')).toHaveAttribute(
      'data-rich-url',
      'https://example.com/spreadsheet-docs',
    )
    await expect(cellDisplay(page, 'D6')).toHaveText('Total 109')
    await expect(cell(page, 'D6')).toHaveAttribute('data-rich-kind', 'rich-text')
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
    await expect(cell(page, 'J20')).toHaveCount(0)
  })

  test('click selection toggles the active state', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'B1').click()
    await expect(cell(page, 'B1')).toHaveClass(/cell-active/)
    await expect(cell(page, 'A1')).not.toHaveClass(/cell-active/)
  })

  test('fill handle copies a visible cell through range backend command', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'A1').click()
    const handle = page.getByTestId('fill-handle-A1')
    await expect(handle).toBeVisible()
    const handleBox = await handle.boundingBox()
    const targetBox = await cell(page, 'A3').boundingBox()
    expect(handleBox).not.toBeNull()
    expect(targetBox).not.toBeNull()

    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2)
    await page.mouse.up()

    await expect(cellDisplay(page, 'A2')).toHaveText('Alpha')
    await expect(cellDisplay(page, 'A3')).toHaveText('Alpha')
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
    await expect(cell(page, 'J20')).toHaveCount(0)
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

  test('ctrl page keys switch adjacent sheet tabs from the grid', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'A1').click()
    await page.keyboard.press('Control+PageDown')
    await expect(page.getByRole('tab', { name: 'Sheet2' })).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)

    await cell(page, 'A1').click()
    await page.keyboard.press('Control+PageDown')
    await expect(page.getByRole('tab', { name: 'Sheet3' })).toHaveAttribute('data-active', 'true')

    await cell(page, 'A1').click()
    await page.keyboard.press('Control+PageUp')
    await expect(page.getByRole('tab', { name: 'Sheet2' })).toHaveAttribute('data-active', 'true')
    await expect(cell(page, 'J20')).toHaveCount(0)
  })

  test('sheet tab add rename and delete mutate workbook metadata', async ({ page }) => {
    await gotoVNextDemo(page)

    await page.getByTestId('sheet-tab-add').click()
    const created = page.getByRole('tab', { name: 'Sheet4' })
    await expect(created).toHaveAttribute('data-active', 'true')

    await created.dblclick()
    const editor = page.getByTestId('vnext-sheet-tabs').getByRole('textbox')
    await editor.fill('Report')
    await editor.press('Enter')
    const renamed = page.getByRole('tab', { name: 'Report' })
    await expect(renamed).toHaveAttribute('data-active', 'true')

    // Sheet delete no longer uses a native window.confirm — the delete
    // command opens the in-app confirmation dialog rendered by
    // SpreadsheetSheetTabs (`sheet-tab-delete-confirmation`). CANONICAL_OWNERSHIP
    // §3 #01: sheet lifecycle stays engine-canonical, the confirm gate is
    // UI-core interaction state.
    await renamed.click({ button: 'right' })
    await page.getByTestId('sheet-tab-menu-delete').click()
    await expect(page.getByTestId('sheet-tab-delete-confirmation')).toBeVisible()
    await page.getByTestId('sheet-tab-delete-confirm').click()
    await expect(page.getByRole('tab', { name: 'Report' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Sheet3' })).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
  })

  test('sheet tab drag reorder mutates displayed workbook metadata', async ({ page }) => {
    await gotoVNextDemo(page)

    const handle = page.getByTestId('sheet-tab-reorder-sheet-3')
    const firstTab = page.getByRole('tab', { name: 'Sheet1' })
    const handleBox = await handle.boundingBox()
    const firstBox = await firstTab.boundingBox()
    expect(handleBox).not.toBeNull()
    expect(firstBox).not.toBeNull()

    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(firstBox!.x + 2, firstBox!.y + firstBox!.height / 2)
    await page.mouse.up()

    await expect(page.getByTestId('vnext-sheet-tabs').getByRole('tab').first()).toHaveText(
      'Sheet3',
    )
    await expect(firstTab).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
  })

  test('data-aware ctrl arrow movement stops at the visible data edge', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'B2').click()
    await page.keyboard.press('Control+ArrowRight')
    await expect(page.getByTestId('formula-bar-addr')).toHaveText('E2')
    await expect(page.getByTestId('status-active-cell')).toHaveText('E2')
    await expect(cell(page, 'E2')).toHaveClass(/cell-active/)
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
    await expect(cell(page, 'J20')).toHaveCount(0)
  })

  test('alt page keys move horizontally by the visible column window', async ({ page }) => {
    await gotoVNextDemo(page)

    await cell(page, 'B2').click()
    await page.keyboard.press('Alt+PageDown')
    await expect(page.getByTestId('formula-bar-addr')).toHaveText('G2')
    await expect(page.getByTestId('status-active-cell')).toHaveText('G2')
    await expect(cell(page, 'G2')).toHaveClass(/cell-active/)
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)

    await page.keyboard.press('Alt+PageUp')
    await expect(page.getByTestId('formula-bar-addr')).toHaveText('B2')
    await expect(page.getByTestId('status-active-cell')).toHaveText('B2')
    await expect(cell(page, 'B2')).toHaveClass(/cell-active/)
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
  })

  test('toolbar and context menu use vNext interaction atoms', async ({ page }) => {
    await gotoVNextDemo(page)

    const bold = page.getByTestId('toolbar-btn-bold')
    await expect(bold).toBeEnabled()
    await bold.click()
    await expect(cellDisplay(page, 'A1')).toHaveCSS('font-weight', '700')

    await cell(page, 'A1').click({ button: 'right' })
    const menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-menu-target-kind', 'cell')
    await page.getByTestId('context-menu-command-cell.clear').click()
    await expect(menu).toHaveCount(0)
    await expect(cellDisplay(page, 'A1')).toHaveText('')
  })

  test('range context menu clear preserves selection and clears the selected range', async ({
    page,
  }) => {
    await gotoVNextDemo(page)

    await cell(page, 'A1').click()
    await cell(page, 'C2').click({ modifiers: ['Shift'] })
    await expect(cell(page, 'B2')).toHaveAttribute('data-selected', 'true')

    await cell(page, 'B2').click({ button: 'right' })
    const menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-menu-target-kind', 'range')

    await page.getByTestId('context-menu-command-cell.clear').click()
    await expect(menu).toHaveCount(0)
    await expect(cellDisplay(page, 'A1')).toHaveText('')
    await expect(cellDisplay(page, 'B1')).toHaveText('')
    await expect(cellDisplay(page, 'C1')).toHaveText('')
    await expect(cellDisplay(page, 'A2')).toHaveText('')
    await expect(cellDisplay(page, 'B2')).toHaveText('')
    await expect(cellDisplay(page, 'C2')).toHaveText('')
    await expect(cellDisplay(page, 'D1')).toHaveText('Delta')
  })

  test('row and column context menu commands mutate the visible projection', async ({ page }) => {
    await gotoVNextDemo(page)

    await page.locator('.spreadsheet-grid-row-header[data-row="1"]').click({ button: 'right' })
    let menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-menu-target-kind', 'row')
    await page.getByTestId('context-menu-command-row.insert').click()
    await expect(menu).toHaveCount(0)
    await expect(cellDisplay(page, 'A2')).toHaveText('')
    await expect(cellDisplay(page, 'A3')).toHaveText('North')

    await page.locator('.spreadsheet-grid-col-header[data-col="1"]').click({ button: 'right' })
    menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-menu-target-kind', 'column')
    await page.getByTestId('context-menu-command-column.delete').click()
    await expect(menu).toHaveCount(0)
    await expect(cellDisplay(page, 'A1')).toHaveText('Alpha')
    await expect(cellDisplay(page, 'B1')).toHaveText('Gamma')
  })

  test('row and column resize update viewport size metadata', async ({ page }) => {
    await gotoVNextDemo(page)

    const colHeader = page.locator('.spreadsheet-grid-col-header[data-col="1"]')
    const rowHeader = page.locator('.spreadsheet-grid-row-header[data-row="1"]')
    const beforeCol = await colHeader.boundingBox()
    const beforeRow = await rowHeader.boundingBox()
    expect(beforeCol).not.toBeNull()
    expect(beforeRow).not.toBeNull()

    const colHandle = page.getByTestId('col-resize-1')
    const colHandleBox = await colHandle.boundingBox()
    expect(colHandleBox).not.toBeNull()
    await page.mouse.move(
      colHandleBox!.x + colHandleBox!.width / 2,
      colHandleBox!.y + colHandleBox!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      colHandleBox!.x + colHandleBox!.width / 2 + 32,
      colHandleBox!.y + colHandleBox!.height / 2,
    )
    await page.mouse.up()
    const afterCol = await colHeader.boundingBox()
    expect(afterCol).not.toBeNull()
    expect(afterCol!.width).toBeGreaterThan(beforeCol!.width + 20)

    const rowHandle = page.getByTestId('row-resize-1')
    const rowHandleBox = await rowHandle.boundingBox()
    expect(rowHandleBox).not.toBeNull()
    await page.mouse.move(
      rowHandleBox!.x + rowHandleBox!.width / 2,
      rowHandleBox!.y + rowHandleBox!.height / 2,
    )
    await page.mouse.down()
    // Drag well past any minimum row clamp; the previous 12px drag
    // bottomed out at +8px due to handle-center vs. row-bottom offset
    // (handle straddles the row boundary).
    await page.mouse.move(
      rowHandleBox!.x + rowHandleBox!.width / 2,
      rowHandleBox!.y + rowHandleBox!.height / 2 + 24,
    )
    await page.mouse.up()
    const afterRow = await rowHeader.boundingBox()
    expect(afterRow).not.toBeNull()
    expect(afterRow!.height).toBeGreaterThan(beforeRow!.height + 12)

    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
    await expect(cell(page, 'J20')).toHaveCount(0)
  })

  test('context menu copy and paste mutate through the vNext backend', async ({
    page,
    context,
  }) => {
    await grantClipboard(context)
    await gotoVNextDemo(page)

    await cell(page, 'A1').click({ button: 'right' })
    let menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('context-menu-command-clipboard.copy').click()
    await expect(menu).toHaveCount(0)

    await cell(page, 'B3').click({ button: 'right' })
    menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('context-menu-command-clipboard.paste').click()
    await expect(menu).toHaveCount(0)

    await expect(cellDisplay(page, 'B3')).toHaveText('Alpha')
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
    await expect(cell(page, 'J20')).toHaveCount(0)
  })

  test('oversized range copy uses backend TSV export without mounting offscreen cells', async ({
    page,
    context,
  }) => {
    await grantClipboard(context)
    await gotoVNextDemo(page)

    await cell(page, 'A1').click()
    await page.keyboard.press('Control+Shift+End')
    await expect(page.getByTestId('status-selection')).toHaveText('A1:CV200')

    await cell(page, 'CV200').click({ button: 'right' })
    const menu = page.getByTestId('vnext-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-menu-target-kind', 'range')

    await page.getByTestId('context-menu-command-clipboard.copy').click()
    await expect(menu).toHaveCount(0)

    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text.startsWith('# einfach-clipboard-origin: A1\nAlpha\tBeta')).toBe(true)
    expect(text.split('\n')).toHaveLength(201)
    await expect(page.getByTestId('status-visible-cells')).toHaveText(/^\d+ cells$/)
    await expect(cell(page, 'J20')).toHaveCount(0)
  })
})
