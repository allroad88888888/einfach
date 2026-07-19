import { expect, test, type Page } from '@playwright/test'

import { cellDisplay, expectNoConsoleErrors, gotoRoot, guardConsoleErrors } from './helpers'

/**
 * Fail-closed structural capability witness (phase 2/3).
 *
 * The Insert menu's four structural entries (row above/below, column
 * left/right) are capability-gated on the live backend ports. The TS
 * worker runtime declares `structuralEdits: false` fail-closed, so the
 * entries must be hidden there; the WASM workbook worker implements the
 * ports, so the entries must be visible. `insert.sheet` is `always`
 * available on both and serves as the control that the menu rendered.
 */

const STRUCTURAL_ITEM_IDS = [
  'insert.rowAbove',
  'insert.rowBelow',
  'insert.colLeft',
  'insert.colRight',
] as const

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

test.describe('vNext Insert menu structural fail-closed evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('Insert structural entries follow the backend capability witness', async ({ page }) => {
    const backend = test.info().project.name
    expect(['wasm', 'ts']).toContain(backend)

    await gotoWorkerDemo(page)

    await page.getByTestId('menu-bar-button-insert').click()
    await expect(page.getByTestId('menu-bar-dropdown-insert')).toBeVisible()
    // Control: the always-available entry proves the dropdown rendered.
    await expect(page.getByTestId('menu-bar-item-insert.sheet')).toBeVisible()

    if (backend === 'ts') {
      // Fail-closed: the TS core withholds the structural ports → hidden.
      for (const id of STRUCTURAL_ITEM_IDS) {
        await expect(page.getByTestId(`menu-bar-item-${id}`)).toHaveCount(0)
      }
    } else {
      // The WASM workbook worker implements insertRows/insertColumns → visible.
      for (const id of STRUCTURAL_ITEM_IDS) {
        await expect(page.getByTestId(`menu-bar-item-${id}`)).toBeVisible()
      }
    }

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('menu-bar-dropdown-insert')).toHaveCount(0)
  })
})
