import { test, expect, type Page } from '@playwright/test'
import { cellDisplay, gotoDemo, guardConsoleErrors, selectCell } from './helpers'

const DEMO = 'Formulas'

function formulaBar(page: Page) {
  return page.getByTestId('formula-bar-input')
}

async function writeFormula(page: Page, addr: string, formula: string) {
  await selectCell(page, addr)
  const bar = formulaBar(page)
  await bar.click()
  await bar.fill(formula)
  await bar.press('Enter')
}

function parseDateLikeValue(text: string): number | null {
  const trimmed = text.trim()
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Math.floor(Number(trimmed))
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (!iso) {
    return null
  }
  return Math.floor(
    Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) / 86_400_000,
  )
}

function localTodaySerial(): number {
  const now = new Date()
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000)
}

test.describe('Formula functions', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('TEXT returns formatted number text', async ({ page }) => {
    await gotoDemo(page, DEMO)

    await writeFormula(page, 'J18', '=TEXT(1234.5,"0.00")')
    await expect(cellDisplay(page, 'J18')).toHaveText('1234.50')

    await writeFormula(page, 'I18', '=TEXT(7,"000")')
    await expect(cellDisplay(page, 'I18')).toHaveText('007')
  })

  test('TODAY returns a non-error and sane local date serial', async ({ page }) => {
    await gotoDemo(page, DEMO)

    await writeFormula(page, 'H18', '=TODAY()')
    const display = (await cellDisplay(page, 'H18').textContent()) ?? ''

    expect(display, 'TODAY() should not be empty').toBeTruthy()
    expect(display).not.toMatch(/^#/)

    const serial = parseDateLikeValue(display)
    expect(serial).not.toBeNull()

    const toleranceWindow = 86_400_000
    const todaySerial = localTodaySerial()
    const resolvedMs = serial as number * 86_400_000
    expect(Math.abs(resolvedMs - todaySerial * 86_400_000)).toBeLessThanOrEqual(
      toleranceWindow,
    )
  })

  test('NOW returns a number on the current day window', async ({ page }) => {
    await gotoDemo(page, DEMO)
    const todaySerial = localTodaySerial()

    await writeFormula(page, 'G18', '=NOW()')
    const display = (await cellDisplay(page, 'G18').textContent()) ?? ''

    expect(display, 'NOW() should display a value').toBeTruthy()
    const value = Number(display)
    expect(Number.isFinite(value)).toBe(true)
    expect(display).not.toMatch(/^#/)

    expect(value).toBeGreaterThanOrEqual(todaySerial)
    expect(value).toBeLessThan(todaySerial + 1)
  })
})
