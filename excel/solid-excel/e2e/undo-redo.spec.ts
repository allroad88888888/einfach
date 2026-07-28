import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  cellInput,
  gotoDemo,
  guardConsoleErrors,
  selectCell,
  typeIntoCell,
} from './helpers'

/**
 * Comprehensive undo/redo coverage on the Blank demo (JS mock backend).
 *
 * These tests assume the Cell.commitEdit double-fire (TODO 1.2.1) has been
 * fixed: each Enter commit produces ONE undo entry, so a single Ctrl+Z
 * reverts the change. Per-test workarounds (the "press undo twice" pattern
 * still living in smoke.spec.ts) must NOT be replicated here.
 *
 * Coverage map vs. the E2E_TEST_PLAN.md "Existing Blank User Flows" section:
 *   - single edit → undo → redo via both Ctrl+Y and Ctrl+Shift+Z
 *   - new edit after undo clears the redo stack
 *   - float precision round-trips through the snapshot tagged union
 *   - formula source preservation (snapshot stores the formula, not the
 *     computed display)
 *   - multi-cell beginEdit/endEdit grouping (exercised via paste)
 *   - clear cell undo
 *   - long stack: 10 sequential writes → 10 undos → 10 redos
 */

const isMac = process.platform === 'darwin'
const META = isMac ? 'Meta' : 'Control'

async function focusGrid(page: Page) {
  // Shortcut handler lives on the table wrapper. Focusing it (rather than the
  // body) is required so onKeyDown actually fires.
  await page.locator('.excel-table-wrapper').focus()
}

async function pressUndo(page: Page) {
  await focusGrid(page)
  await page.keyboard.press(`${META}+z`)
}

async function pressRedoCtrlY(page: Page) {
  await focusGrid(page)
  await page.keyboard.press(`${META}+y`)
}

async function pressRedoShiftZ(page: Page) {
  await focusGrid(page)
  await page.keyboard.press(`${META}+Shift+z`)
}

test.describe('Solid Excel undo/redo (post double-commit fix)', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('single edit: one Ctrl+Z reverts, one Ctrl+Y redoes', async ({ page }) => {
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', '7')
    await expect(cellDisplay(page, 'A1')).toHaveText('7')

    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await pressRedoCtrlY(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('7')
  })

  test('Ctrl+Shift+Z is an alternate redo binding', async ({ page }) => {
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', '42')
    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await pressRedoShiftZ(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('42')
  })

  test('a new edit after undo clears the redo stack', async ({ page }) => {
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', '1')
    await typeIntoCell(page, 'A1', '2')
    await expect(cellDisplay(page, 'A1')).toHaveText('2')

    // Undo "2" → A1 reverts to "1".
    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('1')

    // Branch the timeline: write a different value. The "2" entry should be
    // unreachable after this — redo must not bring it back.
    await typeIntoCell(page, 'A1', '99')
    await expect(cellDisplay(page, 'A1')).toHaveText('99')

    await pressRedoCtrlY(page)
    // Still "99": the redo stack was cleared by the new write.
    await expect(cellDisplay(page, 'A1')).toHaveText('99')
  })

  test('float precision round-trips through the snapshot union', async ({ page }) => {
    await gotoDemo(page, 'Blank')
    // The exact bit pattern of 0.1 + 0.2 in IEEE 754. The snapshot tagged
    // union stores numbers as `value: number`, so undo+redo MUST preserve
    // every bit — no lossy display→parse round trip.
    const FLOAT = '0.30000000000000004'
    await typeIntoCell(page, 'A1', FLOAT)
    await expect(cellDisplay(page, 'A1')).toHaveText(FLOAT)

    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await pressRedoCtrlY(page)
    // Strict equality: must NOT have been munged to "0.3".
    await expect(cellDisplay(page, 'A1')).toHaveText(FLOAT)
  })

  test('undoing a literal write restores the original formula source', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', '10')
    await typeIntoCell(page, 'B1', '=A1*2')
    await expect(cellDisplay(page, 'B1')).toHaveText('20')

    // Replace the formula with a literal — losing the formula source from
    // the live cell. The undo entry's `before` snapshot should still hold
    // the formula though, so undoing brings the formula text back.
    await typeIntoCell(page, 'B1', '99')
    await expect(cellDisplay(page, 'B1')).toHaveText('99')

    await pressUndo(page)
    // Display recomputed from the formula → "20".
    await expect(cellDisplay(page, 'B1')).toHaveText('20')

    // FormulaBar must show the source ("=A1*2"), not the display ("20") and
    // not the literal we overwrote with ("99").
    await selectCell(page, 'B1')
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('=A1*2')
  })

  test('paste groups multi-cell writes into one undo entry', async ({
    page,
    context,
  }) => {
    // Clipboard permissions are required because Table.handleCopy/Paste call
    // navigator.clipboard.writeText/readText. Without permission the calls
    // throw silently and the paste never happens — test would assert against
    // unchanged cells and fail with a confusing message.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])

    await gotoDemo(page, 'Blank')

    // Seed source cells.
    await typeIntoCell(page, 'A1', '11')
    await typeIntoCell(page, 'B1', '22')

    // Select A1:B1 by clicking A1 then Shift+clicking B1.
    await cell(page, 'A1').click()
    await cell(page, 'B1').click({ modifiers: ['Shift'] })

    // Copy → paste at D5. Both D5 and E5 are written inside one
    // beginEdit/endEdit, so a single undo must restore both.
    await focusGrid(page)
    await page.keyboard.press(`${META}+c`)
    await selectCell(page, 'D5')
    await focusGrid(page)
    await page.keyboard.press(`${META}+v`)

    await expect(cellDisplay(page, 'D5')).toHaveText('11')
    await expect(cellDisplay(page, 'E5')).toHaveText('22')

    // Single undo → both pasted cells revert in lockstep.
    await pressUndo(page)
    await expect(cellDisplay(page, 'D5')).toHaveText('')
    await expect(cellDisplay(page, 'E5')).toHaveText('')
  })

  test('Delete clears the cell and undo restores it', async ({ page }) => {
    await gotoDemo(page, 'Blank')
    await typeIntoCell(page, 'A1', '42')
    await expect(cellDisplay(page, 'A1')).toHaveText('42')

    await selectCell(page, 'A1')
    await focusGrid(page)
    await page.keyboard.press('Delete')
    // Delete routes through Table.onKeyDown → store.clearCell, wrapped in a
    // beginEdit/endEdit. After it, A1 should be empty.
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('42')
  })

  test('10 sequential writes → 10 undos to empty → 10 redos to last value', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank')
    for (let i = 1; i <= 10; i++) {
      await typeIntoCell(page, 'A1', String(i))
    }
    await expect(cellDisplay(page, 'A1')).toHaveText('10')

    // 10 undos should land us back at the empty cell (the original state
    // before the first write). One undo per write — no double-commit
    // doubling.
    for (let i = 0; i < 10; i++) {
      await pressUndo(page)
    }
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    // Redo replays the writes in order; final value matches the final write.
    for (let i = 0; i < 10; i++) {
      await pressRedoCtrlY(page)
    }
    await expect(cellDisplay(page, 'A1')).toHaveText('10')
  })

  test('typing a value into an editing cell is undone in one step', async ({
    page,
  }) => {
    // Sanity: confirm there's only one undo entry per Enter even when the
    // cell was previously empty (the historic regression was that an empty
    // → empty no-op committed first).
    await gotoDemo(page, 'Blank')
    await cell(page, 'A1').dblclick()
    const input = cellInput(page, 'A1')
    await expect(input).toBeVisible()
    await input.fill('hello')
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(cellDisplay(page, 'A1')).toHaveText('hello')

    await pressUndo(page)
    await expect(cellDisplay(page, 'A1')).toHaveText('')
  })
})
