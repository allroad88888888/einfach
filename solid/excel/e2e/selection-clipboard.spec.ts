import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  expectDisplay,
  gotoDemo,
  grantClipboard,
  guardConsoleErrors,
  selectCell,
  typeIntoCell,
} from './helpers'

/**
 * P0: Selection range + clipboard.
 *
 * All scenarios run on the `Blank` demo (createJSSheet — no WASM dependency).
 * Two slices:
 *
 *   1. Selection range mechanics — Shift+Arrow extends, plain Arrow collapses,
 *      Shift+Click expands, edge clamping holds. Verified via the
 *      `cell-selected` (focus) and `cell-in-range` (extra cells) classes
 *      that `Cell.tsx::classes()` emits. Focus cell wins over range tint —
 *      see the `!sel && isInRange()` branch.
 *
 *   2. Ctrl+C / Ctrl+V / Ctrl+X via real `navigator.clipboard`. Requires
 *      `grantClipboard(context)` because `Table.handleCopy/Paste` swallows
 *      permission errors silently — without permission, copy writes nothing,
 *      paste reads `''`, and assertions fail confusingly far downstream.
 *      Pasting formulas exercises the `# einfach-clipboard-origin:` marker
 *      so relative refs shift by (paste - copy origin).
 */

const DEMO = 'Blank'

/**
 * Focus the table wrapper so its onKeyDown handler runs. Click+focus is
 * the smoke suite's pattern (see `pressShortcut`), and the same race
 * applies here: arrow / shift+arrow / Ctrl+C/V/X all live on the wrapper.
 */
async function focusGrid(page: Page) {
  await page.locator('.excel-table-wrapper').focus()
}

/**
 * Press the platform-appropriate Ctrl/Cmd combo. `key` is a single char
 * or a Playwright key name; `shift` toggles the modifier.
 */
async function pressMeta(page: Page, key: string, shift = false) {
  await focusGrid(page)
  const isMac = process.platform === 'darwin'
  const meta = isMac ? 'Meta' : 'Control'
  const combo = shift ? `${meta}+Shift+${key}` : `${meta}+${key}`
  await page.keyboard.press(combo)
}

/**
 * Press `Shift+<arrow>` against the focused grid wrapper. Caller must
 * have selected a starting cell first (via `selectCell`); plain click
 * sets both anchor and focus, then Shift+Arrow extends only the focus.
 */
async function shiftArrow(page: Page, dir: 'Up' | 'Down' | 'Left' | 'Right') {
  await focusGrid(page)
  await page.keyboard.press(`Shift+Arrow${dir}`)
}

test.describe('Selection range — keyboard extension', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('Shift+ArrowRight then Shift+ArrowDown extends to a 2x2 range', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    await selectCell(page, 'A1')

    await shiftArrow(page, 'Right')
    await shiftArrow(page, 'Down')

    // Focus moved to B2 — it owns `cell-selected` exclusively (Cell.tsx
    // gives focus precedence over the range tint).
    await expect(cell(page, 'B2')).toHaveClass(/cell-selected/)

    // The other three corners get `cell-in-range` but NOT `cell-selected`.
    for (const addr of ['A1', 'B1', 'A2']) {
      await expect(cell(page, addr)).toHaveClass(/cell-in-range/)
      await expect(cell(page, addr)).not.toHaveClass(/cell-selected/)
    }
  })

  test('Shift+Click expands the range from anchor to clicked cell', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    await selectCell(page, 'A1')

    // Shift+Click goes through Cell.onClick -> onExtendSelect -> store
    // .extendSelection, which keeps the anchor and moves the focus.
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    await expect(cell(page, 'C3')).toHaveClass(/cell-selected/)
    // Spot-check the four range corners + an interior cell.
    for (const addr of ['A1', 'C1', 'A3', 'B2']) {
      await expect(cell(page, addr)).toHaveClass(/cell-in-range/)
    }
    // A4 / D3 are outside — make sure the rectangle isn't leaking.
    await expect(cell(page, 'A4')).not.toHaveClass(/cell-in-range/)
    await expect(cell(page, 'D3')).not.toHaveClass(/cell-in-range/)
  })

  test('plain ArrowRight after a range collapses back to a single cell', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    await selectCell(page, 'A1')
    await shiftArrow(page, 'Right')
    await shiftArrow(page, 'Down')
    await expect(cell(page, 'A1')).toHaveClass(/cell-in-range/)

    // Plain arrow goes through `selectCoord` which calls `setSelection`
    // (anchor === focus collapse).
    await focusGrid(page)
    await page.keyboard.press('ArrowRight')

    // Focus is now C2 (B2 + 1 col); A1 must lose the range class.
    await expect(cell(page, 'C2')).toHaveClass(/cell-selected/)
    await expect(cell(page, 'A1')).not.toHaveClass(/cell-in-range/)
    await expect(cell(page, 'B2')).not.toHaveClass(/cell-in-range/)
  })

  test('Shift+ArrowUp from row 1 clamps within the grid', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await selectCell(page, 'A1')

    // `clampCoord` in selection.ts caps row at 0 — Shift+ArrowUp should
    // be a visual no-op, with A1 still the focus and no range yet.
    await shiftArrow(page, 'Up')

    await expect(cell(page, 'A1')).toHaveClass(/cell-selected/)
    // Range is still collapsed (anchor === focus), so no other cell
    // should carry the in-range tint.
    await expect(cell(page, 'A2')).not.toHaveClass(/cell-in-range/)
  })
})

test.describe('Clipboard — copy / paste / cut', () => {
  test.beforeEach(async ({ context, page }) => {
    await grantClipboard(context)
    guardConsoleErrors(page)
  })

  test('copy A1:B2 then paste at D5 reproduces the 2x2 block', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A1', '10')
    await typeIntoCell(page, 'B1', '30')
    await typeIntoCell(page, 'A2', '20')
    await typeIntoCell(page, 'B2', '40')

    await selectCell(page, 'A1')
    await shiftArrow(page, 'Right')
    await shiftArrow(page, 'Down')
    await pressMeta(page, 'c')

    await selectCell(page, 'D5')
    await pressMeta(page, 'v')

    // Cells preserve their relative position in the source rectangle.
    await expectDisplay(page, 'D5', '10')
    await expectDisplay(page, 'E5', '30')
    await expectDisplay(page, 'D6', '20')
    await expectDisplay(page, 'E6', '40')
  })

  test('copying a formula shifts relative refs on paste', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A1', '10')
    await typeIntoCell(page, 'B1', '=A1*2')
    await expectDisplay(page, 'B1', '20')

    await selectCell(page, 'B1')
    await pressMeta(page, 'c')

    await selectCell(page, 'D5')
    await pressMeta(page, 'v')

    // The pasted source should read =C5*2 — origin shift is
    // (D5 - B1) = (col +2, row +4), so A1 -> C5.
    await cell(page, 'D5').click()
    const bar = page.getByTestId('formula-bar-input')
    await expect(bar).toHaveValue('=C5*2')
    // C5 is empty so the JS mock evaluator yields 0. We just want to
    // confirm the formula didn't carry over verbatim.
    await expectDisplay(page, 'D5', '0')
  })

  test('cut clears the source, paste lands the value, and undo restores it', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A1', '99')
    await expectDisplay(page, 'A1', '99')

    await selectCell(page, 'A1')
    await pressMeta(page, 'x')
    // After cut, A1 is cleared. The display span renders an empty string.
    await expect(cellDisplay(page, 'A1')).toHaveText('')

    await selectCell(page, 'D5')
    await pressMeta(page, 'v')
    await expectDisplay(page, 'D5', '99')

    // Undo the paste batch first, then the cut batch — cut and paste
    // each open a beginEdit/endEdit, so each is one undo step. Press
    // Z twice to walk past both.
    await pressMeta(page, 'z')
    await pressMeta(page, 'z')
    await expectDisplay(page, 'A1', '99')
  })

  test('external TSV (no origin marker) pastes literally without ref shift', async ({
    page,
  }) => {
    await gotoDemo(page, DEMO)

    // Inject an external clipboard payload as if from a foreign app.
    // No `# einfach-clipboard-origin:` header → parser falls back to
    // `originAddr === paste target`, which yields a zero shift.
    await page.evaluate(() => navigator.clipboard.writeText('5\t6\n7\t8'))

    await selectCell(page, 'A1')
    await pressMeta(page, 'v')

    await expectDisplay(page, 'A1', '5')
    await expectDisplay(page, 'B1', '6')
    await expectDisplay(page, 'A2', '7')
    await expectDisplay(page, 'B2', '8')
  })
})
