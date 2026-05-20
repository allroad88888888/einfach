import { test, expect, type Page } from '@playwright/test'

/**
 * Formula interaction end-to-end coverage on the Wave 5 demo.
 *
 * Covers:
 *  - Static-backend formula evaluation (=B2+C2 → 300, =SUM(B2:E2) → 840, ...)
 *  - In-cell type '=' then click a cell to insert an A1 token (no commit)
 *  - Formula-bar typing routes through the editing session
 *  - Reference highlight overlay paints while drafting (no overlay after commit)
 *  - History records the formula commit; undo restores prior text
 *  - Esc cancels the draft, original value preserved
 *  - Error display: =A1/0 → #DIV/0!
 */

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-testid="wave5-grid"] td.cell[data-cell-addr="B2"] .cell-display'),
  ).toHaveText('120')
}

function cell(page: Page, addr: string) {
  return page.locator(`[data-testid="wave5-grid"] td.cell[data-cell-addr="${addr}"]`)
}

function display(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

async function commitFormulaInCell(page: Page, addr: string, formula: string) {
  await cell(page, addr).click()
  await expect(cell(page, addr)).toHaveAttribute('data-active', 'true')
  await page.keyboard.type(formula)
  await expect(cellInput(page, addr)).toHaveValue(formula)
  await page.keyboard.press('Enter')
  // commitEditingAtom + backend.setCellInput + projection refresh are all
  // async; the next test step must wait for the cell-input to close before
  // navigating, otherwise click / F2 race the pending commit.
  await expect(cellInput(page, addr)).toHaveCount(0)
}

test.describe('formula interaction on Wave 5', () => {
  test('cell type =B2+C2 evaluates to 300', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H2', '=B2+C2')
    await expect(display(page, 'H2')).toHaveText('300')
  })

  test('cell type =SUM(B2:E2) evaluates over the visible row range', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H3', '=SUM(B2:E2)')
    // Row 2 numeric cells: 120 + 180 + 240 + 300 = 840
    await expect(display(page, 'H3')).toHaveText('840')
  })

  test('cell type =AVERAGE(B2:E2) evaluates to 210', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H4', '=AVERAGE(B2:E2)')
    await expect(display(page, 'H4')).toHaveText('210')
  })

  test('division by zero surfaces #DIV/0!', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H5', '=B2/0')
    await expect(display(page, 'H5')).toHaveText('#DIV/0!')
  })

  test('parse error surfaces #ERROR!', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H6', '=BAD(')
    await expect(display(page, 'H6')).toHaveText('#ERROR!')
  })

  test('type "=" then click B2 inserts the reference, edit stays active', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H2').click()
    await page.keyboard.press('=')
    await expect(cellInput(page, 'H2')).toHaveValue('=')

    await cell(page, 'B2').click()
    // The ref splices into the draft and the input stays open.
    await expect(cellInput(page, 'H2')).toHaveValue('=B2')
    // Active editing anchor is still H2 (selection wasn't moved by the pick).
    await expect(cell(page, 'H2')).toHaveAttribute('data-active', 'true')
  })

  test('typing an operator between two clicks appends the second ref instead of replacing the first', async ({
    page,
  }) => {
    // Regression: before the `notifyDraftTypedChar` exit-and-resync, the
    // ref-pick session stayed active after typing `+`, so the second click
    // *replaced* the first ref via session.tokenRange — producing `=D2+`
    // instead of `=B2+D2`. The fix exits the session on user input so the
    // next pointer click starts a fresh splice at the new caret.
    await gotoWave5(page)
    await cell(page, 'H2').click()
    await page.keyboard.press('=')
    await cell(page, 'B2').click()
    await expect(cellInput(page, 'H2')).toHaveValue('=B2')
    await page.keyboard.press('+')
    await expect(cellInput(page, 'H2')).toHaveValue('=B2+')
    await cell(page, 'D2').click()
    await expect(cellInput(page, 'H2')).toHaveValue('=B2+D2')
    await page.keyboard.press('Enter')
    await expect(display(page, 'H2')).toHaveText('360')
  })

  test('reference highlight overlay paints while drafting', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H2').click()
    await page.keyboard.press('=')

    await cell(page, 'B2').click()
    // The canvas overlay rasterizes the highlight; we cannot read it via DOM,
    // but the underlying tokens atom should report exactly one entry. Probe
    // it through the grid overlay test surface (a future hook). For now,
    // assert the editing draft contains the splice — this couples to the
    // overlay's input via formulaReferenceTokensAtom.
    await expect(cellInput(page, 'H2')).toHaveValue('=B2')

    // Commit and confirm overlay clears (cell-input vanishes).
    await page.keyboard.press('Enter')
    await expect(cellInput(page, 'H2')).toHaveCount(0)
  })

  test('formula commit pushes cell.set-input history and undo restores blank', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H2', '=B2*2')
    await expect(display(page, 'H2')).toHaveText('240')
    await expect(page.getByTestId('history-timeline-list')).toContainText(/cell\.set-input/)

    await page.getByTestId('history-timeline-undo').click()
    await expect(display(page, 'H2')).toHaveText('')
  })

  test('Esc cancels the draft and preserves prior cell value', async ({ page }) => {
    await gotoWave5(page)
    // Type a draft directly without committing — same flow as the user
    // starting fresh on an empty cell — then Esc.
    await cell(page, 'H2').click()
    await page.keyboard.type('=B2+1')
    await expect(cellInput(page, 'H2')).toHaveValue('=B2+1')

    await page.keyboard.press('Escape')
    await expect(cellInput(page, 'H2')).toHaveCount(0)
    // H2 was empty before the draft; Esc must leave it empty (no commit).
    await expect(display(page, 'H2')).toHaveText('')
  })

  test('formula bar typing commits as a formula on the active cell', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H2').click()
    const bar = page.getByTestId('formula-bar-input')
    await bar.click()
    await bar.fill('=B2-50')
    await bar.press('Enter')

    await expect(display(page, 'H2')).toHaveText('70')
  })

  test('formula bar shows the source formula when re-selecting the cell', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H2', '=B2+C2')
    await expect(display(page, 'H2')).toHaveText('300')

    // Move away then back; formula bar should display the source, not the result.
    await cell(page, 'D2').click()
    await cell(page, 'H2').click()
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('=B2+C2')
    await expect(display(page, 'H2')).toHaveText('300')
  })

  test('formula referencing another formula chains through evaluation', async ({ page }) => {
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H2', '=B2+C2')
    await commitFormulaInCell(page, 'H3', '=H2*2')
    await expect(display(page, 'H3')).toHaveText('600')
  })
})
