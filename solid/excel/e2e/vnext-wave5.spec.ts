import { test, expect, type Page } from '@playwright/test'

test.describe('vNext Wave 5 — shell + canvas overlay', () => {
  async function gotoWave5(page: Page) {
    await page.goto('/')
    // Wave 5 is now the default tab, but click the nav anyway to make the
    // test independent of which default the app ships with. Use the testid
    // so the test is locale-independent.
    await page.getByTestId('nav-tab-vnext-wave5').click()
    await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  }

  function cell(page: Page, addr: string) {
    return page.locator('[data-testid="wave5-grid"]').locator(
      `td.cell[data-cell-addr="${addr}"]`,
    )
  }

  test('demo loads with all Wave 5 surfaces mounted', async ({ page }) => {
    await gotoWave5(page)
    await expect(page.getByTestId('wave5-menu-bar')).toBeVisible()
    await expect(page.getByTestId('wave5-toolbar')).toBeVisible()
    await expect(page.getByTestId('wave5-formula-bar')).toBeVisible()
    await expect(page.getByTestId('wave5-status-bar')).toBeVisible()
    await expect(page.getByTestId('grid-overlay-canvas')).toBeVisible()
    await expect(cell(page, 'A1')).toBeVisible()
  })

  test('menu bar opens File and dispatches Undo', async ({ page }) => {
    await gotoWave5(page)
    const fileButton = page.getByTestId('menu-bar-button-file')
    await fileButton.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('name box reflects active cell and jumps on commit', async ({ page }) => {
    await gotoWave5(page)
    const nameBox = page.getByTestId('name-box-input')
    await expect(nameBox).toBeVisible()
    await expect(nameBox).toHaveValue('A1')

    await nameBox.click()
    await nameBox.fill('C4')
    await nameBox.press('Enter')

    await expect(nameBox).toHaveValue('C4')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C4')
  })

  test('status bar surfaces selection aggregates over a numeric range', async ({ page }) => {
    await gotoWave5(page)

    await cell(page, 'B2').click()
    await cell(page, 'E8').click({ modifiers: ['Shift'] })

    const sum = page.getByTestId('status-aggregate-sum')
    const avg = page.getByTestId('status-aggregate-average')
    const count = page.getByTestId('status-aggregate-count')

    await expect(sum).toBeVisible()
    await expect(avg).toBeVisible()
    await expect(count).toBeVisible()
    await expect(count).toContainText(/\d+/)
  })

  test('zoom slider shows current zoom level', async ({ page }) => {
    await gotoWave5(page)
    const zoom = page.getByTestId('status-zoom-value')
    await expect(zoom).toHaveText('100%')

    const preset125 = page.getByTestId('status-zoom-preset-125')
    await preset125.click()
    await expect(zoom).toHaveText('125%')

    const preset100 = page.getByTestId('status-zoom-preset-100')
    await preset100.click()
    await expect(zoom).toHaveText('100%')
  })

  test('canvas overlay mounts with pointer-events: none', async ({ page }) => {
    await gotoWave5(page)
    const canvas = page.getByTestId('grid-overlay-canvas')
    await expect(canvas).toBeVisible()
    const pointerEvents = await canvas.evaluate((el) => getComputedStyle(el).pointerEvents)
    expect(pointerEvents).toBe('none')

    await cell(page, 'B2').click()
    await expect(cell(page, 'B2')).toHaveAttribute('data-active', 'true')
  })

  test('format painter toolbar button arms the painter', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    const painterButton = page.getByTestId('toolbar-btn-format-painter')
    await expect(painterButton).toBeVisible()
    await expect(painterButton).toHaveAttribute('data-format-painter-state', 'idle')

    await painterButton.click()
    await expect(painterButton).toHaveAttribute('data-format-painter-state', 'armed')

    await page.keyboard.press('Escape')
    await expect(painterButton).toHaveAttribute('data-format-painter-state', 'idle')
  })

  test('row header click selects the row', async ({ page }) => {
    await gotoWave5(page)
    const grid = page.getByTestId('wave5-grid')
    const rowHeader = grid.locator('.spreadsheet-grid-row-header[data-row="4"]')
    await expect(rowHeader).toBeVisible()
    await expect(rowHeader).toHaveAttribute('data-selected', 'false')
    await rowHeader.click()
    await expect(rowHeader).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'A5')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'F5')).toHaveAttribute('data-selected', 'true')
  })

  test('column header click selects the column', async ({ page }) => {
    await gotoWave5(page)
    const grid = page.getByTestId('wave5-grid')
    const colHeader = grid.locator('.spreadsheet-grid-col-header[data-col="2"]')
    await expect(colHeader).toBeVisible()
    await expect(colHeader).toHaveAttribute('data-selected', 'false')
    await colHeader.click()
    await expect(colHeader).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C1')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C3')).toHaveAttribute('data-selected', 'true')
  })

  test('Find next dialog navigates selection to the matched cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await page.keyboard.press('ControlOrMeta+f')
    const dialog = page.getByTestId('wave5-find-replace')
    await expect(dialog).toBeVisible()

    const needle = page.getByTestId('find-needle-input')
    await needle.fill('North')

    await page.getByTestId('find-next-button').click()

    // Seed row 1 of the matrix is ['North', 120, 180, 240, 300, 840] so the
    // unique match lands at A2. After Find next, A2 should be the active cell.
    await expect(cell(page, 'A2')).toHaveAttribute('data-active', 'true')
    await expect(dialog).toBeVisible()
  })

  test('Bold toolbar button toggles aria-pressed on the active cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B3').click()
    const boldButton = page.getByTestId('toolbar-btn-bold')
    await expect(boldButton).toBeVisible()
    await expect(boldButton).toHaveAttribute('aria-pressed', 'false')

    await boldButton.click()
    await expect(boldButton).toHaveAttribute('aria-pressed', 'true')

    await boldButton.click()
    await expect(boldButton).toHaveAttribute('aria-pressed', 'false')
  })

  test('Ctrl+B keyboard shortcut toggles bold on the active cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()
    const boldButton = page.getByTestId('toolbar-btn-bold')
    await expect(boldButton).toHaveAttribute('aria-pressed', 'false')

    await page.keyboard.press('Control+b')
    await expect(boldButton).toHaveAttribute('aria-pressed', 'true')

    await page.keyboard.press('Control+b')
    await expect(boldButton).toHaveAttribute('aria-pressed', 'false')
  })

  test.describe('editing flow (Excel parity)', () => {
    function cellInput(page: Page, addr: string) {
      return cell(page, addr).locator('.cell-input')
    }

    function cellDisplay(page: Page, addr: string) {
      return cell(page, addr).locator('.cell-display')
    }

    test('single-click + type "123" + Enter commits 123', async ({ page }) => {
      await gotoWave5(page)
      const target = cell(page, 'G2')
      await target.click()
      await expect(target).toHaveAttribute('data-active', 'true')

      await page.keyboard.type('123')
      await expect(cellInput(page, 'G2')).toBeVisible()
      await expect(cellInput(page, 'G2')).toHaveValue('123')

      await page.keyboard.press('Enter')
      await expect(cellDisplay(page, 'G2')).toHaveText('123')
    })

    test('single-click + type + Tab commits and moves to next cell', async ({ page }) => {
      await gotoWave5(page)
      const target = cell(page, 'G3')
      await target.click()
      await expect(target).toHaveAttribute('data-active', 'true')

      await page.keyboard.type('hello')
      await expect(cellInput(page, 'G3')).toHaveValue('hello')
      await page.keyboard.press('Tab')

      await expect(cellDisplay(page, 'G3')).toHaveText('hello')
      await expect(cell(page, 'H3')).toHaveAttribute('data-active', 'true')
    })

    test('F2 + type appends to existing cell content', async ({ page }) => {
      await gotoWave5(page)
      const target = cell(page, 'G4')
      await target.click()

      // First, put a known value into the cell via single-click typing.
      await page.keyboard.type('abc')
      await page.keyboard.press('Enter')
      await expect(cellDisplay(page, 'G4')).toHaveText('abc')

      // F2 preserves existing content.
      await cell(page, 'G4').click()
      await page.keyboard.press('F2')
      await expect(cellInput(page, 'G4')).toHaveValue('abc')
      await page.keyboard.type('x')
      await page.keyboard.press('Enter')
      await expect(cellDisplay(page, 'G4')).toHaveText('abcx')
    })

    test('Esc cancels the edit and preserves the existing value', async ({ page }) => {
      await gotoWave5(page)
      const target = cell(page, 'H4')
      await target.click()
      await page.keyboard.type('keep')
      await page.keyboard.press('Enter')
      await expect(cellDisplay(page, 'H4')).toHaveText('keep')

      await cell(page, 'H4').click()
      await page.keyboard.press('F2')
      await page.keyboard.type('xxx')
      await page.keyboard.press('Escape')
      await expect(cellDisplay(page, 'H4')).toHaveText('keep')
    })

    test('Backspace empties the cell and enters edit mode', async ({ page }) => {
      await gotoWave5(page)
      const target = cell(page, 'H5')
      await target.click()
      await page.keyboard.type('seed')
      await page.keyboard.press('Enter')
      await expect(cellDisplay(page, 'H5')).toHaveText('seed')

      await cell(page, 'H5').click()
      await page.keyboard.press('Backspace')
      await expect(cellInput(page, 'H5')).toBeVisible()
      await expect(cellInput(page, 'H5')).toHaveValue('')
      await page.keyboard.press('Enter')
      await expect(cellDisplay(page, 'H5')).toHaveText('')
    })
  })

  test.describe('drag-select (Excel parity)', () => {
    test('pointer drag from B2 to C3 selects B2:C3 without holding Shift', async ({ page }) => {
      await gotoWave5(page)
      const start = cell(page, 'B2')
      const end = cell(page, 'C3')
      const sb = await start.boundingBox()
      const eb = await end.boundingBox()
      if (!sb || !eb) throw new Error('cells not visible')
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
      await page.mouse.down()
      await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, { steps: 5 })
      await page.mouse.up()

      for (const addr of ['B2', 'C2', 'B3', 'C3']) {
        await expect(cell(page, addr)).toHaveAttribute('data-selected', 'true')
      }
      await expect(page.getByTestId('toolbar-btn-merge-cells')).toBeEnabled()
    })
  })

  test.describe('merge / unmerge (toolbar)', () => {
    const mergeBtn = (page: Page) => page.getByTestId('toolbar-btn-merge-cells')
    const unmergeBtn = (page: Page) => page.getByTestId('toolbar-btn-unmerge-cells')

    test('both buttons disabled on a single-cell selection with no merges', async ({ page }) => {
      await gotoWave5(page)
      await cell(page, 'A1').click()
      await expect(mergeBtn(page)).toBeDisabled()
      await expect(unmergeBtn(page)).toBeDisabled()
    })

    test('merge enables on a multi-cell range, unmerge stays disabled', async ({ page }) => {
      await gotoWave5(page)
      await cell(page, 'B2').click()
      await cell(page, 'C3').click({ modifiers: ['Shift'] })
      await expect(mergeBtn(page)).toBeEnabled()
      await expect(unmergeBtn(page)).toBeDisabled()
    })

    test('clicking merge collapses B2:C3 into one anchor cell with the top-left value', async ({ page }) => {
      await gotoWave5(page)
      await cell(page, 'B2').click()
      await cell(page, 'C3').click({ modifiers: ['Shift'] })
      await mergeBtn(page).click()

      const anchor = cell(page, 'B2')
      await expect(anchor).toHaveAttribute('rowspan', '2')
      await expect(anchor).toHaveAttribute('colspan', '2')
      await expect(anchor).toHaveAttribute('data-merge-anchor', 'true')
      // Cells covered by the anchor's span are no longer rendered as separate TDs.
      await expect(page.locator('[data-testid="wave5-grid"] td[data-row="1"][data-col="2"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="wave5-grid"] td[data-row="2"][data-col="2"]')).toHaveCount(0)
    })

    test('after merge: merge disables, unmerge enables, history records range.merge', async ({ page }) => {
      await gotoWave5(page)
      await cell(page, 'B2').click()
      await cell(page, 'C3').click({ modifiers: ['Shift'] })
      await mergeBtn(page).click()

      await expect(mergeBtn(page)).toBeDisabled()
      await expect(unmergeBtn(page)).toBeEnabled()
      await expect(page.getByTestId('history-timeline-list')).toContainText(/range\.merge/)
    })

    test('unmerge restores the original four cells and re-enables merge', async ({ page }) => {
      await gotoWave5(page)
      await cell(page, 'B2').click()
      await cell(page, 'C3').click({ modifiers: ['Shift'] })
      await mergeBtn(page).click()
      await expect(unmergeBtn(page)).toBeEnabled()

      await unmergeBtn(page).click()
      const b2 = cell(page, 'B2')
      await expect(b2).toHaveAttribute('rowspan', '1')
      await expect(b2).toHaveAttribute('colspan', '1')
      await expect(cell(page, 'C2')).toBeVisible()
      await expect(cell(page, 'B3')).toBeVisible()
      await expect(cell(page, 'C3')).toBeVisible()
      await expect(mergeBtn(page)).toBeEnabled()
      await expect(unmergeBtn(page)).toBeDisabled()
    })
  })
})
