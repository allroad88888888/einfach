import { test, expect, type Page } from '@playwright/test'

/**
 * Audit spec for the Wave 5 demo undo/redo system.
 *
 * These tests are intentionally written to fail against the current
 * implementation; each one names a known or suspected defect in the
 * history pipeline. They are scaffolding for the actual fix and a
 * regression net once the fix lands. NO production code is modified
 * by this commit — only the new spec is added.
 *
 * Reference scaffold: solid/excel/e2e/vnext-wave5.spec.ts
 *
 * Headline bug under test:
 *   - Click B2 → type "9" → Enter → cell shows "9".
 *   - Click history-timeline-undo → cell does NOT revert.
 *
 * Likely root cause class (kept here as a hint, not asserted):
 *   - `commitCellEdit` in solid/excel/src-vnext/grid/SpreadsheetGrid.tsx
 *     calls `backend.setCellInput` but never `pushHistoryAtom`, so the
 *     cell.input mutation never enters the history stack.
 *   - The Edit-menu and grid-keyboard handlers call `undoHistoryAtom`
 *     without dispatching `backend.undoTransaction` AND without calling
 *     `resolveHistoryAtom`, leaving `inFlight: true` indefinitely.
 *   - Even via the timeline button, the static backend has no
 *     `undoTransaction`, so the fallback only resets `inFlight` —
 *     it never reverts the projection.
 */

const isMac = process.platform === 'darwin'
const META = isMac ? 'Meta' : 'Control'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string) {
  return page.locator('[data-testid="wave5-grid"]').locator(`td.cell[data-cell-addr="${addr}"]`)
}

function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

async function commitCellValue(page: Page, addr: string, value: string) {
  const target = cell(page, addr)
  await target.click()
  await expect(target).toHaveAttribute('data-active', 'true')
  await page.keyboard.type(value)
  await expect(cellInput(page, addr)).toHaveValue(value)
  await page.keyboard.press('Enter')
  await expect(cellDisplay(page, addr)).toHaveText(value)
}

test.describe('audit: undo/redo defects on the Wave 5 demo', () => {
  test('1. timeline Undo button reverts a value edit', async ({ page }) => {
    await gotoWave5(page)

    // Seed value from the static backend (matrix row 1, col 1 = 120).
    await expect(cellDisplay(page, 'B2')).toHaveText('120')

    await commitCellValue(page, 'B2', '9')

    const undoBtn = page.getByTestId('history-timeline-undo')
    await expect(undoBtn).toBeVisible()
    // If the cell.input edit recorded a history entry, undo MUST be enabled.
    // Currently fails because commitCellEdit never pushes to the history stack.
    await expect(undoBtn).toBeEnabled()
    await undoBtn.click()

    // The original seeded value MUST come back.
    await expect(cellDisplay(page, 'B2')).toHaveText('120')
  })

  test('2. timeline Undo then Redo restores the new value', async ({ page }) => {
    await gotoWave5(page)
    await expect(cellDisplay(page, 'B3')).toHaveText('80')

    await commitCellValue(page, 'B3', '777')

    const undoBtn = page.getByTestId('history-timeline-undo')
    const redoBtn = page.getByTestId('history-timeline-redo')

    await expect(undoBtn).toBeEnabled()
    await undoBtn.click()
    await expect(cellDisplay(page, 'B3')).toHaveText('80')

    await expect(redoBtn).toBeEnabled()
    await redoBtn.click()
    await expect(cellDisplay(page, 'B3')).toHaveText('777')
  })

  test('3. Ctrl/Cmd+Z keyboard shortcut undoes a value edit', async ({ page }) => {
    await gotoWave5(page)
    await expect(cellDisplay(page, 'C2')).toHaveText('180')

    await commitCellValue(page, 'C2', '321')

    // Click out of edit mode into a grid cell so the grid wrapper holds focus.
    await cell(page, 'C2').click()
    await page.keyboard.press(`${META}+z`)

    await expect(cellDisplay(page, 'C2')).toHaveText('180')
  })

  test('4. Ctrl/Cmd+Y keyboard shortcut redoes a value edit', async ({ page }) => {
    await gotoWave5(page)
    await expect(cellDisplay(page, 'C3')).toHaveText('160')

    await commitCellValue(page, 'C3', '555')

    await cell(page, 'C3').click()
    await page.keyboard.press(`${META}+z`)
    await expect(cellDisplay(page, 'C3')).toHaveText('160')

    await cell(page, 'C3').click()
    await page.keyboard.press(`${META}+y`)
    await expect(cellDisplay(page, 'C3')).toHaveText('555')
  })

  test('5. toolbar Bold then Undo removes bold', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'D2').click()

    const boldBtn = page.getByTestId('toolbar-btn-bold')
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'false')
    await boldBtn.click()
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true')

    // The Bold toolbar action DOES push history (format.set), so the
    // timeline should show an entry and Undo should be enabled.
    const undoBtn = page.getByTestId('history-timeline-undo')
    await expect(undoBtn).toBeEnabled()
    await undoBtn.click()

    // After undo, the active cell should no longer be bold. This is the
    // user-visible contract — irrespective of whether the bug is in the
    // backend port, the timeline dispatcher, or the resolve atom.
    await cell(page, 'D2').click()
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'false')
  })

  test('6. Merge B2:C3 then Undo splits the cells back', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    const mergeBtn = page.getByTestId('toolbar-btn-merge-cells')
    await expect(mergeBtn).toBeEnabled()
    await mergeBtn.click()

    const anchor = cell(page, 'B2')
    await expect(anchor).toHaveAttribute('rowspan', '2')
    await expect(anchor).toHaveAttribute('colspan', '2')

    // History should contain a range.merge entry — toolbar mergeSelection
    // calls recordHistoryEntry({ kind: 'range.merge' }).
    await expect(page.getByTestId('history-timeline-list')).toContainText(/range\.merge/)

    const undoBtn = page.getByTestId('history-timeline-undo')
    await expect(undoBtn).toBeEnabled()
    await undoBtn.click()

    // After undo, the merge must be reversed: rowspan/colspan back to 1
    // and the previously covered cells must render as their own TDs.
    await expect(cell(page, 'B2')).toHaveAttribute('rowspan', '1')
    await expect(cell(page, 'B2')).toHaveAttribute('colspan', '1')
    await expect(cell(page, 'C2')).toBeVisible()
    await expect(cell(page, 'B3')).toBeVisible()
    await expect(cell(page, 'C3')).toBeVisible()
  })

  test('7. Delete clears values, Undo restores them', async ({ page }) => {
    await gotoWave5(page)
    await expect(cellDisplay(page, 'B2')).toHaveText('120')

    await cell(page, 'B2').click()
    await page.keyboard.press('Delete')
    await expect(cellDisplay(page, 'B2')).toHaveText('')

    // cell.clear should push a history entry; if not, this fails immediately.
    const undoBtn = page.getByTestId('history-timeline-undo')
    await expect(undoBtn).toBeEnabled()
    await undoBtn.click()

    await expect(cellDisplay(page, 'B2')).toHaveText('120')
  })

  test('8. Edit menu → Undo dispatches and reverts a value edit', async ({ page }) => {
    await gotoWave5(page)
    await expect(cellDisplay(page, 'D3')).toHaveText('240')

    await commitCellValue(page, 'D3', '42')

    // Open Edit menu and click Undo.
    await page.getByTestId('menu-bar-button-edit').click()
    const undoItem = page.getByTestId('menu-bar-item-edit.undo')
    await expect(undoItem).toBeVisible()
    await expect(undoItem).toBeEnabled()
    await undoItem.click()

    // Menu must close and the value must revert.
    await expect(cellDisplay(page, 'D3')).toHaveText('240')
  })

  test('9. history-timeline-cursor reflects "n / m" after each operation', async ({ page }) => {
    await gotoWave5(page)

    const cursor = page.getByTestId('history-timeline-cursor')
    await expect(cursor).toHaveText('0 / 0')

    // Two operations that ARE expected to record history: two toolbar
    // formatting clicks.
    await cell(page, 'E2').click()
    const boldBtn = page.getByTestId('toolbar-btn-bold')
    await boldBtn.click()
    await expect(cursor).toHaveText('1 / 1')

    await cell(page, 'F2').click()
    await boldBtn.click()
    await expect(cursor).toHaveText('2 / 2')

    // Undo once: cursor moves back, total stays.
    const undoBtn = page.getByTestId('history-timeline-undo')
    await undoBtn.click()
    await expect(cursor).toHaveText('1 / 2')

    // Redo once: cursor moves forward.
    const redoBtn = page.getByTestId('history-timeline-redo')
    await expect(redoBtn).toBeEnabled()
    await redoBtn.click()
    await expect(cursor).toHaveText('2 / 2')
  })

  test('10. history-timeline-list shows entries with correct kind labels', async ({
    page,
  }) => {
    await gotoWave5(page)

    const list = page.getByTestId('history-timeline-list')

    // 1) cell.set-input — typing a value into a cell.
    await commitCellValue(page, 'G2', 'hi')
    await expect(list).toContainText(/cell\.set-input/)

    // 2) format.set — toolbar Bold on the active cell.
    await cell(page, 'G2').click()
    await page.getByTestId('toolbar-btn-bold').click()
    await expect(list).toContainText(/format\.set/)

    // 3) range.merge — merge a 2x2 selection.
    await cell(page, 'B5').click()
    await cell(page, 'C6').click({ modifiers: ['Shift'] })
    await page.getByTestId('toolbar-btn-merge-cells').click()
    await expect(list).toContainText(/range\.merge/)
  })
})
