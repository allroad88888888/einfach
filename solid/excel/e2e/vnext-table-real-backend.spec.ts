import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

/**
 * Excel Table structured references end to end on the vNext Worker WASM demo
 * (design-excel-table.md §11.3, parity #32) — real-backend evidence that the
 * UI-core create-table command → worker RPC → Rust engine registry →
 * structured-reference evaluation all close through the visible UI.
 *
 * Flow:
 *   1. Seed a clean Item/Qty block (header + 3 data rows) through the grid.
 *   2. Select the block with the Name Box and dispatch Data → "Create table".
 *   3. Assert the visible success witness (the menu-bar status span carries the
 *      engine-assigned canonical name `Table1`).
 *   4. Type `=SUM(Table1[Qty])` / `=MAX(Table1[Qty])` into empty cells and
 *      assert the engine computes the aggregate — proving structured-reference
 *      evaluation runs through the same backend the UI created the table on.
 *
 * WASM-only: the TS worker declares `structuredTables: false` (fail-closed), so
 * the Data-menu "Create table" entry hides on the `ts` project. The `wasm`
 * null-witness keeps the port exposed.
 */

function activeProjectIsWasm(): boolean {
  try {
    return test.info().project.name !== 'ts'
  } catch {
    return true
  }
}

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  // Cross-sheet seed settles (Sheet1!C2 = Sheet2!C2 + 1 → 13) — the demo is live.
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

/**
 * Enter a fresh Item/Qty table into the empty E/F columns through the visible
 * grid. Row 1 is the header; rows 2..4 are the data (10 / 20 / 30).
 */
async function seedTableRegion(page: Page) {
  await typeIntoCell(page, 'E1', 'Item')
  await typeIntoCell(page, 'F1', 'Qty')
  await typeIntoCell(page, 'E2', 'a')
  await typeIntoCell(page, 'F2', '10')
  await typeIntoCell(page, 'E3', 'b')
  await typeIntoCell(page, 'F3', '20')
  await typeIntoCell(page, 'E4', 'c')
  await typeIntoCell(page, 'F4', '30')
}

async function selectRange(page: Page, rangeA1: string) {
  const nameBox = page.getByTestId('name-box-input')
  await nameBox.fill(rangeA1)
  await nameBox.press('Enter')
  await expect(page.getByTestId('status-selection')).toHaveText(rangeA1)
}

test.describe('vNext Excel Table structured references — real WASM backend', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('Data > Create table then a structured-reference aggregate evaluates', async ({ page }) => {
    test.skip(
      !activeProjectIsWasm(),
      'Excel Table CRUD is WASM-only (TS worker declares structuredTables:false)',
    )
    await gotoWorkerDemo(page)
    await seedTableRegion(page)
    await selectRange(page, 'E1:F4')

    // The Data menu surfaces "Create table" only when the backend exposes the
    // createTable port (WASM null-witness keeps it exposed).
    await page.getByTestId('menu-bar-button-data').click()
    await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
    const createItem = page.getByTestId('menu-bar-item-data.createTable')
    await expect(createItem).toBeVisible()
    await createItem.click()

    // Visible success feedback: the canonical engine-assigned table name.
    await expect(page.getByTestId('menu-bar-create-table-status')).toHaveText('Table1')
    // No rejection surfaced.
    await expect(page.getByTestId('menu-bar-create-table-error')).toHaveCount(0)

    // Structured references evaluate through the engine over the Qty column.
    await typeIntoCell(page, 'H1', '=SUM(Table1[Qty])')
    await expect(cellDisplay(page, 'H1')).toHaveText('60')

    await typeIntoCell(page, 'H2', '=MAX(Table1[Qty])')
    await expect(cellDisplay(page, 'H2')).toHaveText('30')

    // A whole-column reference over the text column resolves to the E2:E4 area.
    await typeIntoCell(page, 'H3', '=COUNTA(Table1[Item])')
    await expect(cellDisplay(page, 'H3')).toHaveText('3')
  })

  test('Create table is rejected structurally when the selection overlaps an existing table', async ({
    page,
  }) => {
    test.skip(
      !activeProjectIsWasm(),
      'Excel Table CRUD is WASM-only (TS worker declares structuredTables:false)',
    )
    await gotoWorkerDemo(page)
    await seedTableRegion(page)
    await selectRange(page, 'E1:F4')

    await page.getByTestId('menu-bar-button-data').click()
    await page.getByTestId('menu-bar-item-data.createTable').click()
    await expect(page.getByTestId('menu-bar-create-table-status')).toHaveText('Table1')

    // A second table over an overlapping range is rejected before any write —
    // a structured not-applied result, surfaced as a user-readable diagnostic.
    await selectRange(page, 'E2:F4')
    await page.getByTestId('menu-bar-button-data').click()
    await page.getByTestId('menu-bar-item-data.createTable').click()
    await expect(page.getByTestId('menu-bar-create-table-error')).toHaveAttribute(
      'data-table-diagnostic-code',
      'range-overlap',
    )
    // The first table survives; column C's seeded chain is untouched.
    await expect(cellDisplay(page, 'C2')).toHaveText('13')
    // The overlap reject never assigned a second name (still Table1).
    await expect(cell(page, 'E1')).toBeVisible()
  })
})
