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

  test('dragging across cells inside a ref-pick session inserts an A1:B2 range', async ({
    page,
  }) => {
    // Excel parity: after typing `=SUM(`, dragging from B2 to E2 should
    // splice `B2:E2` into the draft. Implemented by the grid's
    // `startFormulaReferenceDragPick` window-pointermove handler, which
    // keeps re-calling pickFormulaReferenceAtom with the latest focus
    // until pointerup.
    await gotoWave5(page)
    await cell(page, 'I3').click()
    await page.keyboard.type('=SUM(')
    await expect(cellInput(page, 'I3')).toHaveValue('=SUM(')

    await cell(page, 'B2').dragTo(cell(page, 'E2'))
    await expect(cellInput(page, 'I3')).toHaveValue('=SUM(B2:E2')

    await page.keyboard.type(')')
    await page.keyboard.press('Enter')
    await expect(display(page, 'I3')).toHaveText('840')
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

  test('autocomplete dropdown opens on partial function name and Tab accepts', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'H6').click()
    await page.keyboard.type('=SU')

    // Dropdown lists SUM (exact-prefix match wins) and SUMIF.
    const dropdown = page.getByTestId('formula-autocomplete-list')
    await expect(dropdown).toBeVisible()
    const sumRow = page.getByTestId('formula-autocomplete-row-SUM')
    await expect(sumRow).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('formula-autocomplete-row-SUMIF')).toBeVisible()

    // Tab accepts the highlighted suggestion → `=SUM(` with caret inside.
    await page.keyboard.press('Tab')
    await expect(cellInput(page, 'H6')).toHaveValue('=SUM(')
    await expect(page.getByTestId('formula-autocomplete-signature')).toBeVisible()
  })

  test('ArrowDown moves the autocomplete cursor to the next match', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H7').click()
    await page.keyboard.type('=SU')
    await expect(page.getByTestId('formula-autocomplete-row-SUM')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('formula-autocomplete-row-SUMIF')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByTestId('formula-autocomplete-row-SUM')).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  test('signature tooltip highlights the active arg as commas advance the caret', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'H8').click()
    await page.keyboard.type('=IF(1')

    const sig = page.getByTestId('formula-autocomplete-signature')
    await expect(sig).toContainText('IF(logical_test, value_if_true, [value_if_false])')

    // After the first comma the active arg shifts to value_if_true.
    await page.keyboard.press(',')
    await expect(sig.locator('.spreadsheet-formula-autocomplete-signature-arg-active')).toHaveText(
      'value_if_true',
    )

    // Second comma → value_if_false becomes active.
    await page.keyboard.type('2,')
    await expect(sig.locator('.spreadsheet-formula-autocomplete-signature-arg-active')).toHaveText(
      '[value_if_false]',
    )
  })

  test('mouse-click on an autocomplete row accepts that suggestion', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H6').click()
    await page.keyboard.type('=SU')
    await expect(page.getByTestId('formula-autocomplete-row-SUMIF')).toBeVisible()

    // Click SUMIF directly (not via ArrowDown + Tab) — pointerdown path.
    await page.getByTestId('formula-autocomplete-row-SUMIF').click()
    await expect(cellInput(page, 'H6')).toHaveValue('=SUMIF(')
  })

  test('Esc closes the autocomplete popup but keeps editing active', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H6').click()
    await page.keyboard.type('=S')
    await expect(page.getByTestId('formula-autocomplete-list')).toBeVisible()

    // First Esc: dismiss popup. Editing input must stay so the user can
    // continue typing.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('formula-autocomplete-list')).toHaveCount(0)
    await expect(cellInput(page, 'H6')).toHaveValue('=S')

    // Typing another char moves the caret → popup re-opens automatically
    // (dismissal is keyed to the dismissed-at caret position).
    await page.keyboard.type('U')
    await expect(page.getByTestId('formula-autocomplete-list')).toBeVisible()

    // Second Esc with the popup re-opened: dismisses again. A subsequent
    // Esc (popup already closed) cancels editing entirely.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('formula-autocomplete-list')).toHaveCount(0)
    await expect(cellInput(page, 'H6')).toHaveValue('=SU')
    await page.keyboard.press('Escape')
    await expect(cellInput(page, 'H6')).toHaveCount(0)
  })

  test('autocomplete in the formula bar accepts without losing focus to the cell input', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'H6').click()
    const bar = page.getByTestId('formula-bar-input')
    await bar.click()
    await page.keyboard.type('=SU')
    await expect(page.getByTestId('formula-autocomplete-list')).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(bar).toHaveValue('=SUM(')
    // Focus must stay on the formula bar — the in-cell editor mounts as a
    // side effect of editing being active, but its autofocus is suppressed
    // when the session was opened from 'formula-bar'.
    await expect(bar).toBeFocused()
  })

  test('caret-only ArrowLeft inside an existing formula surfaces the signature', async ({
    page,
  }) => {
    // Regression for the missing onKeyUp wiring: onSelect doesn't fire
    // when ArrowLeft/Right/Home/End only move the caret (no text
    // selected), so the signature atom never recomputed.
    await gotoWave5(page)
    await commitFormulaInCell(page, 'H6', '=SUM(B2:E2)')
    await cell(page, 'H6').click()
    await page.keyboard.press('F2')

    // F2 opens caret at end (index 11), outside the close paren — no signature.
    await expect(page.getByTestId('formula-autocomplete-signature')).toHaveCount(0)

    // ArrowLeft moves caret to 10, between `2` and `)` — inside the SUM call.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('formula-autocomplete-signature')).toContainText(
      'SUM(number1, [number2, ...])',
    )
  })

  test('Backspace from =SU back to =S re-opens the suggestion list', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H7').click()
    await page.keyboard.type('=SU')
    await expect(page.getByTestId('formula-autocomplete-row-SUMIF')).toBeVisible()

    await page.keyboard.press('Backspace')
    await expect(cellInput(page, 'H7')).toHaveValue('=S')
    // After Backspace, fragment shrinks → ABS now matches the broader "S".
    await expect(page.getByTestId('formula-autocomplete-row-ABS')).toBeVisible()
  })

  test('extended evaluator: IF / SUMIF / COUNTIF / ABS / ROUND / CONCAT', async ({ page }) => {
    await gotoWave5(page)

    // IF: B2 (120) > 100 → "high", else "low". Truthy path.
    await commitFormulaInCell(page, 'H2', '=IF(B2>100, 999, 0)')
    await expect(display(page, 'H2')).toHaveText('999')

    // IF with literal text branches.
    await commitFormulaInCell(page, 'H3', '=IF(B2<100, "low", "high")')
    await expect(display(page, 'H3')).toHaveText('high')

    // ABS over a cell value.
    await commitFormulaInCell(page, 'H4', '=ABS(0-B2)')
    await expect(display(page, 'H4')).toHaveText('120')

    // ROUND to 0 digits.
    await commitFormulaInCell(page, 'H5', '=ROUND(B2/7, 2)')
    await expect(display(page, 'H5')).toHaveText('17.14')

    // COUNTIF over a numeric range with a >100 criterion.
    await commitFormulaInCell(page, 'H6', '=COUNTIF(B2:E2, ">100")')
    // Row 2: 120, 180, 240, 300 — all > 100 → count = 4.
    await expect(display(page, 'H6')).toHaveText('4')

    // SUMIF: sum row-2 cells >= 200.
    await commitFormulaInCell(page, 'H7', '=SUMIF(B2:E2, ">=200")')
    // 240 + 300 = 540.
    await expect(display(page, 'H7')).toHaveText('540')

    // CONCAT — text + ref + literal.
    await commitFormulaInCell(page, 'H8', '=CONCAT("Q1=", B2)')
    await expect(display(page, 'H8')).toHaveText('Q1=120')
  })

  test('extended evaluator (2nd wave): TRUE/FALSE/AND/OR/NOT/LEN/LOWER/UPPER/TRIM/SQRT/MOD', async ({
    page,
  }) => {
    await gotoWave5(page)

    await commitFormulaInCell(page, 'H2', '=TRUE+TRUE')
    await expect(display(page, 'H2')).toHaveText('2')

    await commitFormulaInCell(page, 'H3', '=AND(B2>0, B2<1000)')
    await expect(display(page, 'H3')).toHaveText('1')

    await commitFormulaInCell(page, 'H4', '=OR(B2<0, B2>100)')
    await expect(display(page, 'H4')).toHaveText('1')

    await commitFormulaInCell(page, 'H5', '=NOT(B2>1000)')
    await expect(display(page, 'H5')).toHaveText('1')

    await commitFormulaInCell(page, 'H6', '=LEN("hello")')
    await expect(display(page, 'H6')).toHaveText('5')

    await commitFormulaInCell(page, 'H7', '=UPPER("hello")')
    await expect(display(page, 'H7')).toHaveText('HELLO')

    await commitFormulaInCell(page, 'H8', '=TRIM("  a   b  ")')
    await expect(display(page, 'H8')).toHaveText('a b')

    await commitFormulaInCell(page, 'H9', '=SQRT(16)')
    await expect(display(page, 'H9')).toHaveText('4')

    await commitFormulaInCell(page, 'I2', '=MOD(10, 3)')
    await expect(display(page, 'I2')).toHaveText('1')
  })

  test('full SUM via autocomplete + drag pick evaluates the range', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'H9').click()
    await page.keyboard.type('=SU')
    await page.keyboard.press('Tab')
    await expect(cellInput(page, 'H9')).toHaveValue('=SUM(')

    await cell(page, 'B2').dragTo(cell(page, 'E2'))
    await expect(cellInput(page, 'H9')).toHaveValue('=SUM(B2:E2')
    await page.keyboard.type(')')
    await page.keyboard.press('Enter')
    await expect(display(page, 'H9')).toHaveText('840')
  })
})
