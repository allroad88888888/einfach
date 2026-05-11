import { test, expect } from '@playwright/test'
import {
  cell,
  cellDisplay,
  cellInput,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

/**
 * P1: Other Demo Smoke — Budget
 *
 * Backed by `DemoBudget` + `createWasmSheet`. The seed builds an income /
 * expenses / net layout with summary formulas (SUM / MAX / MIN / AVERAGE
 * / division) that the JS mock can't evaluate — this spec validates the
 * WASM-migrated demo renders real numbers on first paint and updates the
 * full dependency graph when a source cell changes.
 *
 * Seed addresses + expected values come from `DemoBudget.tsx::seed`.
 * If that seed changes, this spec needs to follow.
 */

const DEMO = 'Budget'

test.describe('Solid Excel — Budget demo', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
    await gotoDemo(page, DEMO)
  })

  test('income / expense / net totals seed with computed values', async ({ page }) => {
    // Totals row B5 / C5 / D5 from SUM(B3,B4) + diff.
    await expectDisplay(page, 'B5', '10000')
    await expectDisplay(page, 'C5', '10500')
    await expectDisplay(page, 'D5', '500')

    // Total expenses row B14 / C14 / D14 from SUM(B8..B13).
    await expectDisplay(page, 'B14', '7100')
    await expectDisplay(page, 'C14', '7000')
    await expectDisplay(page, 'D14', '-100')

    // Net row B16 / C16 / D16 = income - expenses.
    await expectDisplay(page, 'B16', '2900')
    await expectDisplay(page, 'C16', '3500')
    await expectDisplay(page, 'D16', '600')
  })

  test('diff column computes =C-B for representative rows', async ({ page }) => {
    // D3 = C3-B3 = 8000-8000 = 0 (income line, exactly on budget).
    await expectDisplay(page, 'D3', '0')

    // D9 = C9-B9 = 1450-1200 = 250 (food: over budget by 250).
    await expectDisplay(page, 'D9', '250')

    // D10 = C10-B10 = 380-500 = -120 (transport: under budget).
    await expectDisplay(page, 'D10', '-120')

    // D13 = C13-B13 = 1500-2000 = -500 (savings: under target).
    await expectDisplay(page, 'D13', '-500')
  })

  test('stats block surfaces MAX / MIN / AVERAGE / saving rate', async ({ page }) => {
    // G2 = MAX(C8..C13) = max of expense actuals = 2500 (rent).
    await expectDisplay(page, 'G2', '2500')

    // G3 = MIN(C8..C13) = min of expense actuals = 320 (utilities).
    await expectDisplay(page, 'G3', '320')

    // G4 = AVERAGE(C8..C13) = 7000/6. Pin the prefix — the Rust float
    // formatter emits ~17 digits, JS emits ~16, and the trailing 7 vs 67
    // boundary isn't worth coupling to.
    const g4 = await cellDisplay(page, 'G4').textContent()
    expect(g4 ?? '').toMatch(/^1166\.6/)

    // G5 = C13/C5*100 = 1500/10500*100 ≈ 14.2857… (saving rate as percent).
    const g5 = await cellDisplay(page, 'G5').textContent()
    expect(g5 ?? '').toMatch(/^14\.28/)
  })

  test('editing C8 (Rent actual) propagates to diff + totals + stats', async ({ page }) => {
    // Sanity: starting values.
    await expectDisplay(page, 'D8', '0')
    await expectDisplay(page, 'C14', '7000')
    await expectDisplay(page, 'C16', '3500')
    await expectDisplay(page, 'G2', '2500')

    // Bump rent actual: 2500 → 3000 (overshoot by 500).
    await typeIntoCell(page, 'C8', '3000')

    // D8 = C8-B8 = 3000-2500 = 500.
    await expectDisplay(page, 'D8', '500')

    // Total expenses C14 jumps by 500: 7000 → 7500.
    await expectDisplay(page, 'C14', '7500')

    // Net C16 = C5-C14 = 10500-7500 = 3000.
    await expectDisplay(page, 'C16', '3000')

    // Max expense moves to rent: G2 = 3000.
    await expectDisplay(page, 'G2', '3000')

    // Min unaffected (still utilities at 320).
    await expectDisplay(page, 'G3', '320')

    // G4 = AVERAGE = 7500/6 = 1250 (now exactly an integer — no prefix
    // dodge needed).
    await expectDisplay(page, 'G4', '1250')
  })

  test('double-clicking D5 shows the source formula, not the result', async ({ page }) => {
    // The diff-of-totals cell. Display is 500; the edit input must show
    // `=C5-B5` so the user can adjust the formula instead of accidentally
    // overwriting it with a literal.
    await expectDisplay(page, 'D5', '500')

    await cell(page, 'D5').dblclick()
    const input = cellInput(page, 'D5')
    await expect(input).toBeVisible()
    expect(await input.inputValue()).toBe('=C5-B5')

    // Abandon so D5 stays untouched.
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expectDisplay(page, 'D5', '500')
  })

  test('double-clicking G4 shows =AVERAGE(...) source', async ({ page }) => {
    // The stats AVG cell — keeps the prefix-match assertion in the seed
    // test honest by proving the formula source itself is preserved.
    await cell(page, 'G4').dblclick()
    const input = cellInput(page, 'G4')
    await expect(input).toBeVisible()
    expect(await input.inputValue()).toBe('=AVERAGE(C8,C9,C10,C11,C12,C13)')

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })
})
