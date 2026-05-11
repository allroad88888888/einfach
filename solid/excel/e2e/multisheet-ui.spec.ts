import { test, expect, type Dialog, type Page } from '@playwright/test'
import {
  cell,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  selectSheet,
  typeIntoCell,
} from './helpers'

/**
 * P1: Multi-Sheet workbook UI.
 *
 * Backed by `MultiSheet.tsx` + `createWorkbookStore` — a JS-only mock
 * (no WASM). Three seeded sheets at startup: Sheet1 (Quarter / Revenue
 * / Profit), Expenses (Category / Amount), Notes (free-form text).
 *
 * The SheetTabs component uses native `prompt`/`confirm` dialogs for
 * rename and delete (deliberate — keeps the menu PR small, see the
 * comment at the top of `SheetTabs.tsx`). The `+` button does NOT
 * prompt — it calls `addSheet()` with no name and the store auto-picks
 * "Sheet{N}" via `pickDefaultName()`. With three seeded sheets the
 * first auto-add becomes "Sheet4".
 *
 * Two-step rename/delete flow (see `SheetTabs.onContextMenu`):
 *   1. action prompt — user types "rename" or "delete" or cancels
 *   2a. rename → second prompt for the new name
 *   2b. delete → confirm("Delete sheet ...?")
 *
 * Each native dialog needs its own `page.once('dialog', ...)` handler
 * registered BEFORE the trigger fires. We don't reuse the helpers'
 * `acceptDialog` for these chained prompts because the chain needs
 * different responses per step (action verb vs. new name vs. confirm).
 */

const DEMO = 'Multi-Sheet'

/**
 * Stack a series of dialog responses. Each entry handles one prompt
 * (or confirm/alert) in arrival order. `text` is the value typed into
 * a prompt; `null` dismisses; for confirm dialogs use any non-null
 * string (the value is ignored — only accept vs. dismiss matters).
 *
 * IMPORTANT: register BEFORE triggering the action that opens the
 * first dialog. Native prompts block the page until handled, so a
 * late handler will hang the test.
 */
function queueDialogs(page: Page, responses: Array<string | null>) {
  let i = 0
  page.on('dialog', async (dialog: Dialog) => {
    const idx = i
    i += 1
    const response = responses[idx]
    if (response === null || response === undefined) {
      await dialog.dismiss()
    } else {
      await dialog.accept(response)
    }
  })
}

/** Right-click a sheet tab by its visible name. */
function tabByName(page: Page, name: string) {
  return page.getByRole('tab', { name, exact: true })
}

test.describe('Multi-Sheet — initial state', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('three seeded tabs render in order', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await expect(tabByName(page, 'Sheet1')).toBeVisible()
    await expect(tabByName(page, 'Expenses')).toBeVisible()
    await expect(tabByName(page, 'Notes')).toBeVisible()
    // Sheet1 starts active per `setActiveIdxRaw(0)` in createWorkbookStore.
    await expect(tabByName(page, 'Sheet1')).toHaveAttribute('aria-selected', 'true')
  })

  test('Sheet1 displays its seeded headers', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await expectDisplay(page, 'A1', 'Quarter')
    await expectDisplay(page, 'B1', 'Revenue')
    await expectDisplay(page, 'C1', 'Profit')
  })

  test('Expenses tab swaps the grid to its seed', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await selectSheet(page, 'Expenses')
    await expectDisplay(page, 'A1', 'Category')
    await expectDisplay(page, 'B1', 'Amount')
    await expectDisplay(page, 'A2', 'Rent')
    // Total = 2500 + 8000 + 1200 = 11700, computed by the JS mock.
    await expectDisplay(page, 'B5', '11700')
  })
})

test.describe('Multi-Sheet — independence across tabs', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('edits to one sheet do not bleed into another', async ({ page }) => {
    await gotoDemo(page, DEMO)
    // Sheet1!A1 starts as "Quarter" — overwrite to "hello".
    await typeIntoCell(page, 'A1', 'hello')
    await expectDisplay(page, 'A1', 'hello')

    // Switch to Expenses, overwrite its A1 to "world".
    await selectSheet(page, 'Expenses')
    await typeIntoCell(page, 'A1', 'world')
    await expectDisplay(page, 'A1', 'world')

    // Back to Sheet1 — must still show "hello", not "world" or seed.
    await selectSheet(page, 'Sheet1')
    await expectDisplay(page, 'A1', 'hello')
  })
})

test.describe('Multi-Sheet — add / rename / delete', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('clicking + appends Sheet4 and activates it', async ({ page }) => {
    await gotoDemo(page, DEMO)
    // Three seeded sheets → next auto-name is Sheet4 per pickDefaultName().
    await page.getByRole('button', { name: 'Add sheet', exact: true }).click()

    await expect(tabByName(page, 'Sheet4')).toBeVisible()
    await expect(tabByName(page, 'Sheet4')).toHaveAttribute('aria-selected', 'true')
    // Newly created sheet is empty — A1 has no display text.
    await expect(cell(page, 'A1').locator('.cell-display')).toHaveText('')
  })

  test('right-click → "rename" updates the tab label', async ({ page }) => {
    await gotoDemo(page, DEMO)

    // Two prompts back-to-back: action verb, then new name.
    queueDialogs(page, ['rename', 'Renamed'])
    await tabByName(page, 'Notes').click({ button: 'right' })

    await expect(tabByName(page, 'Renamed')).toBeVisible()
    await expect(tabByName(page, 'Notes')).toHaveCount(0)
  })

  test('right-click → "delete" on a non-active sheet drops the count', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    // Sheet1 is active by default; deleting Notes (non-active) tests the
    // "non-active removal doesn't shift active" branch.
    queueDialogs(page, ['delete', 'yes'])
    await tabByName(page, 'Notes').click({ button: 'right' })

    await expect(tabByName(page, 'Notes')).toHaveCount(0)
    // Sheet1 + Expenses still visible.
    await expect(tabByName(page, 'Sheet1')).toBeVisible()
    await expect(tabByName(page, 'Expenses')).toBeVisible()
  })

  test('cannot delete the last remaining sheet', async ({ page }) => {
    await gotoDemo(page, DEMO)

    // Delete Notes, then Expenses — leaves only Sheet1. The third delete
    // should be refused by the workbook store (`removeSheet` returns
    // false when entries.length <= 1) and surface as a window.alert.
    queueDialogs(page, [
      'delete', 'ok',          // delete Notes
      'delete', 'ok',          // delete Expenses
      'delete', 'ok', 'dismiss-alert', // attempted delete + alert
    ])
    await tabByName(page, 'Notes').click({ button: 'right' })
    await expect(tabByName(page, 'Notes')).toHaveCount(0)

    await tabByName(page, 'Expenses').click({ button: 'right' })
    await expect(tabByName(page, 'Expenses')).toHaveCount(0)

    // Last delete attempt — Sheet1 must remain.
    await tabByName(page, 'Sheet1').click({ button: 'right' })
    await expect(tabByName(page, 'Sheet1')).toBeVisible()
    // Exactly one tab left in the bar.
    await expect(page.locator('.sheet-tabs button[role="tab"]')).toHaveCount(1)
  })
})
