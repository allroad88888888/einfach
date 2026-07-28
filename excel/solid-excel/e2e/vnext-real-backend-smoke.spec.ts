import { expect, test, type BrowserContext, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  grantClipboard,
  guardConsoleErrors,
  selectSheet,
} from './helpers'

type DebugCell = {
  display: string
  formula: string
}

type DebugClient = {
  sheetList(): Promise<Array<{ idx: number; name: string }>>
  readCells(cells: Array<{ sheet: number; addr: string }>): Promise<DebugCell[]>
}

type CopyAsResult = {
  html: string
  markdown: string
  plainText: string
}

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page, 'debug=1')
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (
            window as unknown as {
              __einfachWorkbookDebugClient?: DebugClient
            }
          ).__einfachWorkbookDebugClient?.sheetList === 'function',
      ),
    )
    .toBe(true)
}

async function readSheetNames(page: Page) {
  return page.evaluate(async () => {
    const client = (window as unknown as { __einfachWorkbookDebugClient: DebugClient })
      .__einfachWorkbookDebugClient
    return (await client.sheetList()).map((sheet) => sheet.name)
  })
}

async function readCells(page: Page, addresses: string[]) {
  return page.evaluate(async (addrs) => {
    const client = (window as unknown as { __einfachWorkbookDebugClient: DebugClient })
      .__einfachWorkbookDebugClient
    const cells = await client.readCells(addrs.map((addr) => ({ sheet: 0, addr })))
    return cells.map(({ display, formula }) => ({ display, formula }))
  }, addresses)
}

async function enableCopyAsProbe(context: BrowserContext) {
  await grantClipboard(context)
  await context.addInitScript(() => {
    ;(window as unknown as { __EINFACH_E2E__: boolean }).__EINFACH_E2E__ = true
  })
}

test.describe('vNext real-backend parity smoke', () => {
  test('sheet add, rename, and delete round-trip through the worker metadata backend', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    const sheetTabs = page.getByTestId('vnext-worker-sheet-tabs')
    await expect(sheetTabs.getByRole('tab')).toHaveCount(3)

    await page.getByTestId('sheet-tab-add').click()
    await expect(sheetTabs.getByRole('tab')).toHaveCount(4)
    await expect.poll(() => readSheetNames(page)).toHaveLength(4)

    const addedName = (await readSheetNames(page))[3]
    const addedTab = sheetTabs.getByRole('tab', { name: addedName, exact: true })
    await expect(addedTab).toHaveAttribute('data-active', 'true')

    await addedTab.dblclick()
    const renameInput = page.locator('input.spreadsheet-sheet-tab-rename')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('Report')
    await renameInput.press('Enter')
    await expect(sheetTabs.getByRole('tab', { name: 'Report', exact: true })).toBeVisible()
    await expect.poll(() => readSheetNames(page)).toContain('Report')

    await sheetTabs.getByRole('tab', { name: 'Report', exact: true }).click({ button: 'right' })
    await page.getByTestId('sheet-tab-menu-delete').click()
    await expect(page.getByTestId('sheet-tab-delete-confirmation')).toBeVisible()
    await page.getByTestId('sheet-tab-delete-confirm').click()

    await expect(sheetTabs.getByRole('tab')).toHaveCount(3)
    await expect.poll(() => readSheetNames(page)).not.toContain('Report')
    await expectNoConsoleErrors(page)
  })

  test('sheet reorder round-trips through the worker metadata backend and refreshed projection', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    const sheetTabs = page.getByTestId('vnext-worker-sheet-tabs')
    const handle = page.getByTestId('sheet-tab-reorder-sheet-3')
    const sheet1Tab = sheetTabs.getByRole('tab', { name: 'Sheet1', exact: true })
    const handleBox = await handle.boundingBox()
    const sheet1Box = await sheet1Tab.boundingBox()
    expect(handleBox).not.toBeNull()
    expect(sheet1Box).not.toBeNull()

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(sheet1Box!.x + 2, sheet1Box!.y + sheet1Box!.height / 2)
    await page.mouse.up()

    await expect(sheetTabs.getByRole('tab').first()).toHaveText('Sheet3')
    await expect.poll(() => readSheetNames(page)).toEqual(['Sheet3', 'Sheet1', 'Sheet2'])

    // Reorder keeps the same active sheet and refreshes its projection against
    // the backend's new positional indices instead of painting reordered metadata only.
    await expect(sheet1Tab).toHaveAttribute('data-active', 'true')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')
    await selectSheet(page, 'Sheet3')
    await expect(cellDisplay(page, 'C2')).toHaveText('11')
    await selectSheet(page, 'Sheet2')
    await expect(cellDisplay(page, 'C2')).toHaveText('12')
    await selectSheet(page, 'Sheet1')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')
    await expectNoConsoleErrors(page)
  })

  test('name-box selection updates the canonical worker-backed address', async ({ page }) => {
    await gotoWorkerDemo(page)

    const nameBox = page.getByTestId('name-box-input')
    await expect(nameBox).toHaveValue('A1')
    await nameBox.fill('C4')
    await nameBox.press('Enter')
    await expect(nameBox).toHaveValue('C4')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C4')
    await expectNoConsoleErrors(page)
  })

  test('Copy As reads the live worker selection and writes all browser clipboard flavours', async ({
    page,
    context,
  }) => {
    await enableCopyAsProbe(context)
    await gotoWorkerDemo(page)

    await cell(page, 'B4').click()
    await cell(page, 'C4').click({ modifiers: ['Shift'] })
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+Shift+c`)

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __einfach_lastCopyAs__?: CopyAsResult })
              .__einfach_lastCopyAs__ ?? null,
        ),
      )
      .not.toBeNull()

    const result = await page.evaluate(async () => ({
      copyAs: (window as unknown as { __einfach_lastCopyAs__: CopyAsResult })
        .__einfach_lastCopyAs__,
      clipboardText: await navigator.clipboard.readText(),
    }))
    expect(result.copyAs.plainText).toBe('10\tsource')
    expect(result.copyAs.markdown).toContain('| 10 | source |')
    expect(result.copyAs.html).toContain('<table')
    expect(result.copyAs.html).toContain('source')
    expect(result.clipboardText).toBe(result.copyAs.plainText)
    await expectNoConsoleErrors(page)
  })

  test('status-bar aggregates are computed from the live worker-backed selection', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    await expect
      .poll(() => readCells(page, ['B4', 'C4']))
      .toEqual([
        { display: '10', formula: '' },
        { display: 'source', formula: '' },
      ])
    await cell(page, 'B4').click()
    await cell(page, 'C4').click({ modifiers: ['Shift'] })

    await expect(page.getByTestId('status-aggregate-sum-value')).toHaveText('10')
    await expect(page.getByTestId('status-aggregate-average-value')).toHaveText('10')
    await expect(page.getByTestId('status-aggregate-count-value')).toHaveText('2')
    await expect(page.getByTestId('status-aggregates')).toHaveAttribute('data-truncated', 'false')
    await expectNoConsoleErrors(page)
  })

  test('native double-click opens worker-backed cell editing for commit and cancel', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    // Start on a non-active cell so this exercises the native selection +
    // double-click chain, rather than only the already-active-cell shortcut.
    await cell(page, 'B4').dblclick()
    const commitInput = cell(page, 'B4').locator('.cell-input')
    await expect(commitInput).toBeVisible()
    await expect(commitInput).toHaveValue('10')
    await commitInput.fill('21')
    await commitInput.press('Enter')

    await expect(commitInput).toHaveCount(0)
    await expect.poll(() => readCells(page, ['B4'])).toEqual([{ display: '21', formula: '' }])
    await expect(cellDisplay(page, 'B4')).toHaveText('21')

    // Enter moves the active address away from C4; double-click C4 therefore
    // covers the same native inactive-target path before Escape cancels it.
    await cell(page, 'C4').dblclick()
    const cancelInput = cell(page, 'C4').locator('.cell-input')
    await expect(cancelInput).toBeVisible()
    await expect(cancelInput).toHaveValue('source')
    await cancelInput.fill('discarded')
    await cancelInput.press('Escape')

    await expect(cancelInput).toHaveCount(0)
    await expect.poll(() => readCells(page, ['C4'])).toEqual([{ display: 'source', formula: '' }])
    await expect(cellDisplay(page, 'C4')).toHaveText('source')
    await expectNoConsoleErrors(page)
  })

  test('Go To and Text to Columns round-trip through the visible real-worker UI', async ({
    page,
  }) => {
    await gotoWorkerDemo(page)

    const goToDialog = page.getByTestId('vnext-worker-go-to')
    const editMenu = page.getByTestId('menu-bar-button-edit')
    const goToMenuItem = page.getByTestId('menu-bar-item-edit.goTo')

    await expect(page.getByTestId('vnext-worker-menu-bar')).toBeVisible()
    await editMenu.click()
    await expect(goToMenuItem).toBeVisible()
    await expect(goToMenuItem).toBeEnabled()
    await goToMenuItem.click()
    await expect(goToDialog).toBeVisible()

    await page.getByTestId('go-to-cancel-button').click()
    await expect(goToDialog).toHaveCount(0)
    await expect(page.getByTestId('name-box-input')).toHaveValue('A1')

    await editMenu.click()
    await goToMenuItem.click()
    await expect(goToDialog).toBeVisible()
    await page.getByTestId('go-to-input').fill('C4')
    await page.getByTestId('go-to-input').press('Enter')

    await expect(goToDialog).toHaveCount(0)
    await expect(page.getByTestId('name-box-input')).toHaveValue('C4')
    await expect(page.getByTestId('status-active-cell')).toHaveText('C4')
    await expect(cell(page, 'C4')).toHaveAttribute('data-active', 'true')
    await expect(cell(page, 'C4')).toHaveAttribute('data-selected', 'true')

    // Seed the safe single-column source through the real Grid editing path.
    // The debug client below remains read-only evidence throughout this test.
    await cell(page, 'A4').dblclick()
    const sourceInput = cell(page, 'A4').locator('.cell-input')
    await expect(sourceInput).toBeVisible()
    await sourceInput.fill('left,right')
    await sourceInput.press('Enter')
    await expect(sourceInput).toHaveCount(0)
    await expect
      .poll(() => readCells(page, ['A4', 'B4']))
      .toEqual([
        { display: 'left,right', formula: '' },
        { display: '10', formula: '' },
      ])
    await expect(cellDisplay(page, 'A4')).toHaveText('left,right')
    await expect(cellDisplay(page, 'B4')).toHaveText('10')

    await cell(page, 'A4').click()
    const dataMenu = page.getByTestId('menu-bar-button-data')
    const textToColumnsMenuItem = page.getByTestId('menu-bar-item-data.textToColumns')
    const textToColumnsDialog = page.getByTestId('vnext-worker-text-to-columns')

    await dataMenu.click()
    await expect(textToColumnsMenuItem).toBeVisible()
    await expect(textToColumnsMenuItem).toBeEnabled()
    await textToColumnsMenuItem.click()
    await expect(textToColumnsDialog).toBeVisible()

    await page.getByTestId('ttc-cancel-button').click()
    await expect(textToColumnsDialog).toHaveCount(0)
    await expect
      .poll(() => readCells(page, ['A4', 'B4']))
      .toEqual([
        { display: 'left,right', formula: '' },
        { display: '10', formula: '' },
      ])

    await dataMenu.click()
    await expect(textToColumnsMenuItem).toBeVisible()
    await textToColumnsMenuItem.click()
    await expect(textToColumnsDialog).toBeVisible()
    await page.getByTestId('ttc-next-button').click()
    await expect(textToColumnsDialog).toHaveAttribute('data-step', 'step-2-delimited')
    await page.getByTestId('ttc-delim-tab').uncheck()
    await page.getByTestId('ttc-delim-comma').check()
    await expect(page.getByTestId('ttc-preview')).toContainText('left')
    await expect(page.getByTestId('ttc-preview')).toContainText('right')
    await page.getByTestId('ttc-next-button').click()
    await expect(textToColumnsDialog).toHaveAttribute('data-step', 'step-3')
    await expect(page.getByTestId('ttc-finish-button')).toBeEnabled()
    await page.getByTestId('ttc-finish-button').click()

    // The dialog closes only after the import ACK and visible-projection refresh.
    await expect(textToColumnsDialog).toHaveCount(0)
    await expect
      .poll(() => readCells(page, ['A4', 'B4']))
      .toEqual([
        { display: 'left', formula: '' },
        { display: 'right', formula: '' },
      ])
    await expect(cellDisplay(page, 'A4')).toHaveText('left')
    await expect(cellDisplay(page, 'B4')).toHaveText('right')
    await expectNoConsoleErrors(page)
  })
})
