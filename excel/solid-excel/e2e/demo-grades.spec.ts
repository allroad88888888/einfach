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
 * P1: Other Demo Smoke — Grades
 *
 * Backed by `DemoGrades` + `createWasmSheet`. The seed lays out 8 students
 * across columns A-D (name + 3 subject scores), with E/F/G holding the
 * per-row AVERAGE / MAX / MIN. Class-level stats live in rows 11-14
 * (Class Avg / Highest / Lowest / Count).
 *
 * The button label in App.tsx is `Grade Calc`, not `Grades` — that's the
 * value gotoDemo needs.
 *
 * Seed addresses + expected values come from `DemoGrades.tsx::seed`.
 * If that seed changes, this spec needs to follow.
 */

const DEMO = 'Grade Calc'

test.describe('Solid Excel — Grades demo', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
    await gotoDemo(page, DEMO)
  })

  test('per-student AVERAGE / MAX / MIN seed with computed values', async ({ page }) => {
    // Charlie (row 4): 95, 92, 98. AVG = 285/3 = 95 (exactly integer).
    await expectDisplay(page, 'E4', '95')
    await expectDisplay(page, 'F4', '98')
    await expectDisplay(page, 'G4', '92')

    // Diana (row 5): 63, 70, 68. AVG = 201/3 = 67 (exactly integer).
    await expectDisplay(page, 'E5', '67')
    await expectDisplay(page, 'F5', '70')
    await expectDisplay(page, 'G5', '63')

    // Eve (row 6): 88, 91, 85. AVG = 264/3 = 88 (exactly integer).
    await expectDisplay(page, 'E6', '88')
    await expectDisplay(page, 'F6', '91')
    await expectDisplay(page, 'G6', '85')
  })

  test('non-integer averages render with float formatting', async ({ page }) => {
    // Alice (row 2): 92, 88, 95. AVG = 275/3 ≈ 91.666… — prefix-match so
    // the test doesn't break on Rust/JS formatter trailing-digit drift.
    const e2 = await cellDisplay(page, 'E2').textContent()
    expect(e2 ?? '').toMatch(/^91\.6/)

    // Frank (row 7): 45, 52, 48. AVG = 145/3 ≈ 48.333… (the lowest-AVG
    // student — useful for the propagation test below).
    const e7 = await cellDisplay(page, 'E7').textContent()
    expect(e7 ?? '').toMatch(/^48\.3/)
    await expectDisplay(page, 'F7', '52')
    await expectDisplay(page, 'G7', '45')
  })

  test('class stats row 11-14 (Class Avg / Highest / Lowest / Count)', async ({ page }) => {
    // Class Avg row 11: each subject's AVERAGE over all 8 students.
    //   B11 = (92+78+95+63+88+45+100+72)/8 = 633/8 = 79.125 (terminates).
    //   C11 = (88+85+92+70+91+52+97+68)/8 = 643/8 = 80.375 (terminates).
    //   D11 = (95+72+98+68+85+48+99+75)/8 = 640/8 = 80     (integer).
    await expectDisplay(page, 'B11', '79.125')
    await expectDisplay(page, 'C11', '80.375')
    await expectDisplay(page, 'D11', '80')

    // Highest row 12: MAX per subject. Grace has 100 / 97 / 99.
    await expectDisplay(page, 'B12', '100')
    await expectDisplay(page, 'C12', '97')
    await expectDisplay(page, 'D12', '99')

    // Lowest row 13: MIN per subject. Frank pulls them all down.
    await expectDisplay(page, 'B13', '45')
    await expectDisplay(page, 'C13', '52')
    await expectDisplay(page, 'D13', '48')

    // Count row 14: COUNT of numeric scores in column B = 8 students.
    await expectDisplay(page, 'B14', '8')
  })

  test('changing Frank math score updates row + class stats', async ({ page }) => {
    // Sanity: starting state.
    await expectDisplay(page, 'F7', '52')
    await expectDisplay(page, 'G7', '45')
    await expectDisplay(page, 'B13', '45') // Frank is the lowest math.

    // Frank's math (B7): 45 → 90. Pulls him out of bottom-Math.
    await typeIntoCell(page, 'B7', '90')

    // Per-row stats: E7 ≈ (90+52+48)/3 = 63.333…, F7 jumps to 90, G7 → 48.
    const e7 = await cellDisplay(page, 'E7').textContent()
    expect(e7 ?? '').toMatch(/^63\.3/)
    await expectDisplay(page, 'F7', '90')
    await expectDisplay(page, 'G7', '48')

    // Class avg B11 = (92+78+95+63+88+90+100+72)/8 = 678/8 = 84.75.
    await expectDisplay(page, 'B11', '84.75')

    // Class min B13 = MIN now finds Diana's 63 instead of Frank's 45.
    await expectDisplay(page, 'B13', '63')

    // Class max B12 unchanged (Grace still at 100).
    await expectDisplay(page, 'B12', '100')

    // Count still 8 — value change doesn't add/remove rows.
    await expectDisplay(page, 'B14', '8')
  })

  test('double-clicking a per-student AVERAGE shows =AVERAGE(...) source', async ({ page }) => {
    // E2 is Alice's average. Display ≈ 91.666…, edit input must show the
    // formula so a follow-up edit doesn't clobber the seed reference.
    await cell(page, 'E2').dblclick()
    const input = cellInput(page, 'E2')
    await expect(input).toBeVisible()
    expect(await input.inputValue()).toBe('=AVERAGE(B2,C2,D2)')

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })

  test('double-clicking class Count shows =COUNT(...) source', async ({ page }) => {
    // B14 = =COUNT(B2..B9). Display is 8; source must be the formula.
    await cell(page, 'B14').dblclick()
    const input = cellInput(page, 'B14')
    await expect(input).toBeVisible()
    expect(await input.inputValue()).toBe('=COUNT(B2,B3,B4,B5,B6,B7,B8,B9)')

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })
})
