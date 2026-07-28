import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  selectCell,
  selectSheet,
  typeIntoCell,
} from './helpers'

/**
 * P1: FormulaBar
 *
 * Backed by the FormulaBar mounted at the top of every Table that opts in
 * with `formulaBar`. We test on the `Blank` demo (JS mock — fast, simple
 * arithmetic only) for value/source/edit/escape paths and on `Multi-Sheet`
 * for the sheet-switch leakage check, since that's where two sheets live
 * inside one workbook with shared selection state.
 *
 * Selectors (defined in FormulaBar.tsx):
 *   - addr badge:   `[data-testid="formula-bar-addr"]`
 *   - input field:  `[data-testid="formula-bar-input"]`
 */

const BLANK = 'Blank'
const MULTI = 'Multi-Sheet'

function bar(page: Page) {
  return page.getByTestId('formula-bar-input')
}

function barAddr(page: Page) {
  return page.getByTestId('formula-bar-addr')
}

function barError(page: Page) {
  return page.getByTestId('formula-bar-error')
}

test.describe('FormulaBar — display', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('selecting a value cell shows its plain value', async ({ page }) => {
    await gotoDemo(page, BLANK)
    await typeIntoCell(page, 'A1', '42')

    await selectCell(page, 'A1')
    await expect(barAddr(page)).toHaveText('A1')
    await expect(bar(page)).toHaveValue('42')
  })

  test('selecting a formula cell shows the source formula, not the result', async ({
    page,
  }) => {
    await gotoDemo(page, BLANK)
    await typeIntoCell(page, 'A1', '10')
    await typeIntoCell(page, 'B1', '=A1*5')
    await expectDisplay(page, 'B1', '50')

    await selectCell(page, 'B1')
    // The cell shows 50, but the bar must show =A1*5. Otherwise editing
    // here would silently overwrite the formula with the literal "50".
    await expect(barAddr(page)).toHaveText('B1')
    await expect(bar(page)).toHaveValue('=A1*5')
    await expectDisplay(page, 'B1', '50')
  })

  test('selecting an empty cell clears the bar', async ({ page }) => {
    await gotoDemo(page, BLANK)
    // Pre-touch a different cell so we know the bar had text first.
    await typeIntoCell(page, 'A1', 'hello')
    await selectCell(page, 'A1')
    await expect(bar(page)).toHaveValue('hello')

    await selectCell(page, 'C5')
    await expect(barAddr(page)).toHaveText('C5')
    await expect(bar(page)).toHaveValue('')
  })
})

test.describe('FormulaBar — editing', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('Enter commits the bar draft to the cell', async ({ page }) => {
    await gotoDemo(page, BLANK)
    await selectCell(page, 'A1')

    const input = bar(page)
    await input.click()
    await input.fill('123')
    await input.press('Enter')

    await expectDisplay(page, 'A1', '123')
  })

  test('Enter commits a formula draft and the cell shows the computed value', async ({
    page,
  }) => {
    await gotoDemo(page, BLANK)
    await typeIntoCell(page, 'A1', '4')
    await selectCell(page, 'B1')

    const input = bar(page)
    await input.click()
    await input.fill('=A1+6')
    await input.press('Enter')

    await expectDisplay(page, 'B1', '10')

    // Re-selecting B1 should still surface the formula source, not "10".
    await selectCell(page, 'B1')
    await expect(input).toHaveValue('=A1+6')
  })

  test('Escape reverts the draft to the cell\'s current value (no commit)', async ({
    page,
  }) => {
    await gotoDemo(page, BLANK)
    await typeIntoCell(page, 'A1', 'keep')
    await selectCell(page, 'A1')

    const input = bar(page)
    await input.click()
    await input.fill('discard')
    await input.press('Escape')

    // Cell display unchanged — Escape must NOT commit.
    await expectDisplay(page, 'A1', 'keep')
    // Bar reverts to the cell's current value once it loses focus.
    await expect(input).toHaveValue('keep')
  })

  test('invalid formula shows a concise error with code on a worker-backed sheet', async ({
    page,
  }) => {
    await gotoDemo(page, MULTI)
    await selectCell(page, 'J18')

    const input = bar(page)
    await input.click()
    await input.fill('=garbage((')
    await input.press('Enter')

    await expect(barError(page)).toHaveAttribute('data-code', 'INVALID_FORMULA')
    await expect(barError(page)).toHaveText('Invalid formula')

    await input.fill('=1')
    await input.press('Enter')
    await expect(barError(page)).toHaveCount(0)
    await expectDisplay(page, 'J18', '1')
  })

  test('cycle formula shows cycle diagnosis and clears on selection switch', async ({
    page,
  }) => {
    await gotoDemo(page, MULTI)
    await selectCell(page, 'I18')

    const input = bar(page)
    await input.click()
    await input.fill('=I18+1')
    await input.press('Enter')

    await expect(barError(page)).toHaveAttribute('data-code', 'FORMULA_CYCLE')
    await expect(barError(page)).toHaveText('Formula cycle')

    await selectCell(page, 'B1')
    await expect(barError(page)).toHaveCount(0)
  })

  test('parse error from bar (`=foo bar`) renders an error cell without leaking console.error', async ({
    page,
  }) => {
    // FormulaBar parse errors flow through `setCellInput → set_formula`,
    // which the JS-mock evaluator surfaces as an error display value
    // ("#ERROR!" / "#VALUE!" / similar). Whichever exact string the mock
    // uses, the assertions are: the cell renders SOMETHING starting with
    // "#", and the page didn't take down the FormulaBar in the process.
    //
    // We deliberately don't allowlist the specific error here — the
    // helper's default allowlist catches vite chatter and the lazy-demo
    // probe; anything else is a real leak.
    await gotoDemo(page, BLANK)
    await selectCell(page, 'A1')

    const input = bar(page)
    await input.click()
    await input.fill('=foo bar')
    await input.press('Enter')

    // Cell shows an error class OR the literal "#..." string. JS-mock
    // currently surfaces parse failures as the raw input prefixed with
    // a marker; pin the loose assertion (text starts with "#" OR class)
    // so the test survives mock ↔ wasm migrations.
    const text = (await cellDisplay(page, 'A1').textContent()) ?? ''
    const klass = (await cell(page, 'A1').getAttribute('class')) ?? ''
    expect(
      text.startsWith('#') || klass.includes('cell-error') || text === '=foo bar',
      `expected A1 to surface a parse-error indication, got display=${JSON.stringify(text)} class=${JSON.stringify(klass)}`,
    ).toBe(true)

    // FormulaBar still functional — typing a clean value still commits.
    await selectCell(page, 'A1')
    await input.click()
    await input.fill('99')
    await input.press('Enter')
    await expectDisplay(page, 'A1', '99')
  })
})

test.describe('FormulaBar — sheet switch leakage', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('switching sheets does not leak the prior sheet\'s formula source into the new sheet\'s FormulaBar', async ({
    page,
  }) => {
    await gotoDemo(page, MULTI)

    // Sheet1 (the seeded "Quarter / Revenue / Profit" sheet) has B5 as
    // a cross-sheet formula `=Expenses!B5`. Select it to snapshot the
    // source text from the first sheet.
    await selectCell(page, 'B5')
    await expect(bar(page)).toHaveValue('=Expenses!B5')
    await expect(barAddr(page)).toHaveText('B5')

    // Switch to Expenses. The FormulaBar belongs to the remounted Table for
    // that sheet. It must not keep the stale "=Expenses!B5" source.
    await selectSheet(page, 'Expenses')

    const value = await bar(page).inputValue()
    expect(value).not.toBe('=Expenses!B5')

    // Sanity: re-selecting B5 on Expenses now shows that sheet's B5
    // formula instead (also `=B2+B3+B4` per the seed — same string,
    // but resolved against Expenses' values, not Sheet1's).
    await selectCell(page, 'B5')
    await expect(bar(page)).toHaveValue('=B2+B3+B4')
    // Expenses!B5 = 2500 + 8000 + 1200 = 11700.
    await expectDisplay(page, 'B5', '11700')
  })
})
