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
 * P1: Other Demo Smoke — Sales Dashboard
 *
 * Backed by `DemoSales` + `createWasmSheet`. The seed lays out 3 months of
 * sales across 3 products (rows 4-6, cols B-D), with column E for monthly
 * totals and rows 8-9 for Q1 totals + averages. KPI panel in G3:H10
 * surfaces best/worst month, top product, and month-over-month growth
 * rates (the only formulas in the demo that produce negative numbers
 * when sales dip — exercised by the propagation test).
 *
 * The button label in App.tsx is `Sales Dashboard`, not `Sales`.
 *
 * Seed addresses + expected values come from `DemoSales.tsx::seed`.
 * If that seed changes, this spec needs to follow.
 */

const DEMO = 'Sales Dashboard'

test.describe('Solid Excel — Sales demo', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
    await gotoDemo(page, DEMO)
  })

  test('monthly totals (column E) seed with SUM across products', async ({ page }) => {
    // E4 = SUM(B4,C4,D4) = 12000+8500+5200 = 25700.
    await expectDisplay(page, 'E4', '25700')

    // E5 = 15000+9200+6800 = 31000.
    await expectDisplay(page, 'E5', '31000')

    // E6 = 18000+11000+7500 = 36500.
    await expectDisplay(page, 'E6', '36500')
  })

  test('Q1 totals (row 8) sum each product across the quarter', async ({ page }) => {
    // B8 = SUM(B4,B5,B6) = 12000+15000+18000 = 45000 (Product A).
    await expectDisplay(page, 'B8', '45000')

    // C8 = SUM(C4,C5,C6) = 8500+9200+11000 = 28700 (Product B).
    await expectDisplay(page, 'C8', '28700')

    // D8 = SUM(D4,D5,D6) = 5200+6800+7500 = 19500 (Product C).
    await expectDisplay(page, 'D8', '19500')

    // E8 = SUM(E4,E5,E6) = 25700+31000+36500 = 93200 (grand total).
    await expectDisplay(page, 'E8', '93200')
  })

  test('Q1 averages (row 9) — integer + non-integer mix', async ({ page }) => {
    // B9 = AVERAGE(B4,B5,B6) = 45000/3 = 15000 (clean integer).
    await expectDisplay(page, 'B9', '15000')

    // D9 = AVERAGE(D4,D5,D6) = 19500/3 = 6500 (clean integer).
    await expectDisplay(page, 'D9', '6500')

    // C9 = 28700/3 ≈ 9566.666… — prefix-match for formatter drift.
    const c9 = await cellDisplay(page, 'C9').textContent()
    expect(c9 ?? '').toMatch(/^9566\.6/)

    // E9 = 93200/3 ≈ 31066.666…
    const e9 = await cellDisplay(page, 'E9').textContent()
    expect(e9 ?? '').toMatch(/^31066\.6/)
  })

  test('KPI panel surfaces revenue / best+worst month / top product', async ({ page }) => {
    // H4 = E8 = 93200 (total revenue ref).
    await expectDisplay(page, 'H4', '93200')

    // H5 = MAX(E4,E5,E6) = 36500 (March is best).
    await expectDisplay(page, 'H5', '36500')

    // H6 = MIN(E4,E5,E6) = 25700 (January is worst).
    await expectDisplay(page, 'H6', '25700')

    // H7 = MAX(B8,C8,D8) = 45000 (Product A leads Q1).
    await expectDisplay(page, 'H7', '45000')
  })

  test('growth-rate KPIs compute as (new-old)/old*100', async ({ page }) => {
    // H9 = (E5-E4)/E4*100 = 5300/25700*100 ≈ 20.6225… percent.
    const h9 = await cellDisplay(page, 'H9').textContent()
    expect(h9 ?? '').toMatch(/^20\.6/)

    // H10 = (E6-E5)/E5*100 = 5500/31000*100 ≈ 17.7419… percent.
    const h10 = await cellDisplay(page, 'H10').textContent()
    expect(h10 ?? '').toMatch(/^17\.7/)
  })

  test('editing B4 cascades through E4 → E8 → H4 → H5 → H9', async ({ page }) => {
    // Sanity: starting values for everything we're about to disturb.
    await expectDisplay(page, 'E4', '25700')
    await expectDisplay(page, 'E8', '93200')
    await expectDisplay(page, 'H4', '93200')
    await expectDisplay(page, 'H5', '36500')

    // Bump January Product A: 12000 → 20000 (a strong upward shock).
    await typeIntoCell(page, 'B4', '20000')

    // E4 = SUM(20000,8500,5200) = 33700 (now larger than February).
    await expectDisplay(page, 'E4', '33700')

    // E8 = SUM(E4,E5,E6) = 33700+31000+36500 = 101200.
    await expectDisplay(page, 'E8', '101200')

    // H4 = E8 = 101200 (revenue ref follows).
    await expectDisplay(page, 'H4', '101200')

    // H5 = MAX(E4,E5,E6) = max(33700, 31000, 36500) = 36500. March still
    // wins by 2800 even after the January bump — guard against an
    // accidental January-wins mis-formula.
    await expectDisplay(page, 'H5', '36500')

    // B8 = SUM(B4,B5,B6) = 20000+15000+18000 = 53000.
    await expectDisplay(page, 'B8', '53000')

    // H9 = (E5-E4)/E4*100 = (31000-33700)/33700*100 ≈ -8.0118…
    // Crucially this flips from positive to negative — pins that the
    // growth-rate formula actually re-evaluated (didn't latch the old
    // sign).
    const h9 = await cellDisplay(page, 'H9').textContent()
    expect(h9 ?? '').toMatch(/^-8\./)
  })

  test('double-clicking H10 shows the growth-rate formula source', async ({ page }) => {
    // H10 display ≈ 17.7419…; the edit input must surface the actual
    // formula so the user can adjust the percent scale or denominator.
    await cell(page, 'H10').dblclick()
    const input = cellInput(page, 'H10')
    await expect(input).toBeVisible()
    expect(await input.inputValue()).toBe('=(E6-E5)/E5*100')

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })

  test('double-clicking E4 shows =SUM(...) source', async ({ page }) => {
    // E4 is the simplest monthly-total — keeps a second source-preservation
    // test pinning the SUM path, complementing the growth-rate / formula
    // pair from H10 above.
    await cell(page, 'E4').dblclick()
    const input = cellInput(page, 'E4')
    await expect(input).toBeVisible()
    expect(await input.inputValue()).toBe('=SUM(B4,C4,D4)')

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })
})
