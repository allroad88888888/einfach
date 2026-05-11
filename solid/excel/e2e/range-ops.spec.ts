import { test, type Page } from '@playwright/test'
import {
  cellDisplay,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  selectCell,
  typeIntoCell,
} from './helpers'
import { expect } from '@playwright/test'

/**
 * P0: Range delete operations on the Blank demo (JS mock).
 *
 * Two things this suite has to pin down that smoke + selection-clipboard
 * don't already cover:
 *
 *   1. Delete and Backspace BOTH route through the same `clearCell`
 *      loop in `Table.onKeyDown` — both must clear every cell in the
 *      current rectangular selection.
 *
 *   2. The whole multi-cell clear is ONE undo entry. Table wraps the
 *      loop in `beginEdit` / `endEdit`, so a single Ctrl/Cmd+Z must
 *      restore all four cells. The Cell.tsx Enter+blur double-commit
 *      fix landed in the prerequisite commit, so we expect a single
 *      undo press to suffice — no doubled press like the smoke suite
 *      had to use.
 */

const DEMO = 'Blank'

async function focusGrid(page: Page) {
  await page.locator('.excel-table-wrapper').focus()
}

async function shiftArrow(page: Page, dir: 'Up' | 'Down' | 'Left' | 'Right') {
  await focusGrid(page)
  await page.keyboard.press(`Shift+Arrow${dir}`)
}

async function pressMeta(page: Page, key: string, shift = false) {
  await focusGrid(page)
  const isMac = process.platform === 'darwin'
  const meta = isMac ? 'Meta' : 'Control'
  const combo = shift ? `${meta}+Shift+${key}` : `${meta}+${key}`
  await page.keyboard.press(combo)
}

/**
 * Seed the four-cell block A1=1, B1=2, A2=3, B2=4 used by every test
 * in this file. Returns nothing — caller asserts straight after.
 */
async function seedBlock(page: Page) {
  await typeIntoCell(page, 'A1', '1')
  await typeIntoCell(page, 'B1', '2')
  await typeIntoCell(page, 'A2', '3')
  await typeIntoCell(page, 'B2', '4')
}

/**
 * Select A1, then Shift+Right + Shift+Down so the rectangular range
 * is A1:B2 with focus on B2. Mirrors what the user does to "drag-
 * select" a 2x2 block.
 */
async function selectA1B2Range(page: Page) {
  await selectCell(page, 'A1')
  await shiftArrow(page, 'Right')
  await shiftArrow(page, 'Down')
}

test.describe('Range delete — Delete key', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('Delete clears every cell in a 2x2 selection', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await seedBlock(page)
    await selectA1B2Range(page)

    await focusGrid(page)
    await page.keyboard.press('Delete')

    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cellDisplay(page, addr)).toHaveText('')
    }
  })

  test('a single Ctrl/Cmd+Z restores the whole 2x2 block', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await seedBlock(page)
    await selectA1B2Range(page)

    await focusGrid(page)
    await page.keyboard.press('Delete')
    // Sanity — the clear actually happened.
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    // ONE undo. The double-commit bug only affected per-Cell Enter; the
    // range-clear path goes through Table.onKeyDown, never through
    // Cell.commitEdit, so there's no ghost no-op entry to step past.
    await pressMeta(page, 'z')

    await expectDisplay(page, 'A1', '1')
    await expectDisplay(page, 'B1', '2')
    await expectDisplay(page, 'A2', '3')
    await expectDisplay(page, 'B2', '4')
  })
})

test.describe('Range delete — Backspace parity', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('Backspace clears the same range as Delete', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await seedBlock(page)
    await selectA1B2Range(page)

    await focusGrid(page)
    await page.keyboard.press('Backspace')

    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cellDisplay(page, addr)).toHaveText('')
    }
  })

  test('Backspace + single undo also restores the block', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await seedBlock(page)
    await selectA1B2Range(page)

    await focusGrid(page)
    await page.keyboard.press('Backspace')
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await pressMeta(page, 'z')

    await expectDisplay(page, 'A1', '1')
    await expectDisplay(page, 'B1', '2')
    await expectDisplay(page, 'A2', '3')
    await expectDisplay(page, 'B2', '4')
  })
})
