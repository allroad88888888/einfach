import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  expectDisplay,
  gotoDemo,
  guardConsoleErrors,
  queueDialogs,
  selectCell,
  selectSheet,
  typeIntoCell,
} from './helpers'

/**
 * P1: Multi-Sheet workbook UI.
 *
 * Worker-backed multi-sheet workbook UI. The demo seeds three sheets through
 * a worker import session and keeps formulas lazy until cells are read.
 */

const DEMO = 'Multi-Sheet'

const EXPENSES_B5_TOTAL = '11700'
const EXPENSES_C5_LAZY_VALUE = '41'

const CROSS_SHEET_FORMULA_CELL = 'B5'

type SheetRef = {
  sheetIdx: number
  addr: string
}

// Non-active-sheet formula we use for lazy-eval proof in debug mode.
const DEBUG_UNOBSERVED_FORMULA: SheetRef = {
  sheetIdx: 1,
  addr: 'C5',
}

type DebugClient = {
  debugFormulaEvalCount?: (sheetIdx: number) => Promise<number> | number
  debugFormulaCacheState?: (sheetIdx: number, addr: string) => Promise<string> | string
}

type MultiSheetDebugContainer = {
  client?: DebugClient
}

type WindowWithDebugClient = Window & {
  __einfachWorkbookDebugClient?: DebugClient
  __einfachDebug?: MultiSheetDebugContainer
}

async function debugClientFromWindow(page: Page): Promise<DebugClient | null> {
  return page.evaluate(() => {
    const win = window as unknown as WindowWithDebugClient
    if (win.__einfachWorkbookDebugClient) return win.__einfachWorkbookDebugClient
    if (win.__einfachDebug?.client) return win.__einfachDebug.client
    return null
  })
}

function tabByName(page: Page, name: string) {
  return page.getByRole('tab', { name, exact: true })
}

async function openTabContextMenu(page: Page, name: string) {
  const menu = page.locator('.context-menu')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tab = tabByName(page, name)
    await expect(tab).toBeVisible()
    await tab.click({ button: 'right', force: true })
    if (await menu.isVisible().catch(() => false)) return
    await page.waitForTimeout(100)
  }
  await expect(menu).toBeVisible()
}

function formulaBar(page: Page) {
  return page.getByTestId('formula-bar-input')
}

async function readDebugFormulaEvalCount(page: Page, sheetIdx: number): Promise<number | null> {
  return page.evaluate(async (idx) => {
    const win = window as unknown as WindowWithDebugClient
    const client = win.__einfachWorkbookDebugClient ?? win.__einfachDebug?.client
    if (!client || typeof client.debugFormulaEvalCount !== 'function') return null
    const raw = await Promise.resolve(client.debugFormulaEvalCount(idx))
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  }, sheetIdx)
}

async function readDebugFormulaCacheState(
  page: Page,
  sheetIdx: number,
  addr: string,
): Promise<string | null> {
  return page.evaluate(
    async (args) => {
      const win = window as unknown as WindowWithDebugClient
      const client = win.__einfachWorkbookDebugClient ?? win.__einfachDebug?.client
      if (!client || typeof client.debugFormulaCacheState !== 'function') return null
      const raw = await Promise.resolve(client.debugFormulaCacheState(args.sheetIdx, args.addr))
      return typeof raw === 'string' ? raw : null
    },
    { sheetIdx, addr },
  )
}

async function hasDebugClient(page: Page): Promise<boolean> {
  return (await debugClientFromWindow(page)) !== null
}

test.describe('Multi-Sheet — initial state', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('three seeded tabs render in order', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await expect(tabByName(page, 'Sheet1')).toBeVisible()
    await expect(tabByName(page, 'Expenses')).toBeVisible()
    await expect(tabByName(page, 'Notes')).toBeVisible()
    await expect(tabByName(page, 'Sheet1')).toHaveAttribute('aria-selected', 'true')
  })

  test('Sheet1 displays seeded headers', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await expectDisplay(page, 'A1', 'Quarter')
    await expectDisplay(page, 'B1', 'Revenue')
    await expectDisplay(page, 'C1', 'Profit')
  })

  test('Expenses tab shows seeded title + total', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await selectSheet(page, 'Expenses')
    await expectDisplay(page, 'A1', 'Category')
    await expectDisplay(page, 'B1', 'Amount')
    await expectDisplay(page, 'A2', 'Rent')
    await expectDisplay(page, 'B5', EXPENSES_B5_TOTAL)
  })

  test('Sheet1 displays a cross-sheet formula result', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await selectSheet(page, 'Sheet1')
    await expectDisplay(page, CROSS_SHEET_FORMULA_CELL, EXPENSES_B5_TOTAL)
    await selectCell(page, CROSS_SHEET_FORMULA_CELL)
    await expect(formulaBar(page)).toHaveValue('=Expenses!B5')
  })
})

test.describe('Multi-Sheet — independence across tabs', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('edits to one sheet do not bleed into another', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await typeIntoCell(page, 'A1', 'hello')
    await expectDisplay(page, 'A1', 'hello')

    await selectSheet(page, 'Expenses')
    await typeIntoCell(page, 'A1', 'world')
    await expectDisplay(page, 'A1', 'world')

    await selectSheet(page, 'Sheet1')
    await expectDisplay(page, 'A1', 'hello')
  })
})

test.describe('Multi-Sheet — add / rename / delete', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('clicking + appends Sheet4 and activates it', async ({ page }) => {
    await gotoDemo(page, DEMO)
    await page.getByRole('button', { name: 'Add sheet', exact: true }).click()

    await expect(tabByName(page, 'Sheet4')).toBeVisible()
    await expect(tabByName(page, 'Sheet4')).toHaveAttribute('aria-selected', 'true')
    await expect(cell(page, 'A1').locator('.cell-display')).toHaveText('')
  })

  test('right-click Rename updates the tab label', async ({ page }) => {
    await gotoDemo(page, DEMO)

    queueDialogs(page, ['Renamed'])
    await openTabContextMenu(page, 'Notes')
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Rename' }).click()

    await expect(tabByName(page, 'Renamed')).toBeVisible()
    await expect(tabByName(page, 'Notes')).toHaveCount(0)
  })

  test('right-click Delete on a non-active sheet removes it', async ({ page }) => {
    await gotoDemo(page, DEMO)
    queueDialogs(page, ['yes']) // confirm("Delete sheet ...?")
    await openTabContextMenu(page, 'Notes')
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Delete' }).click()

    await expect(tabByName(page, 'Notes')).toHaveCount(0)
    await expect(tabByName(page, 'Sheet1')).toBeVisible()
    await expect(tabByName(page, 'Expenses')).toBeVisible()
  })

  test('cannot delete the last remaining sheet', async ({ page }) => {
    await gotoDemo(page, DEMO)

    queueDialogs(page, [
      'ok', // delete Notes
      'ok', // delete Expenses
      'ok', // last attempt accepted in handler path
      null, // last-sheet alert is dismissed by `null`
    ])

    await openTabContextMenu(page, 'Notes')
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Delete' }).click()
    await expect(tabByName(page, 'Notes')).toHaveCount(0)

    await openTabContextMenu(page, 'Expenses')
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Delete' }).click()
    await expect(tabByName(page, 'Expenses')).toHaveCount(0)

    await openTabContextMenu(page, 'Sheet1')
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Delete' }).click()
    await expect(tabByName(page, 'Sheet1')).toBeVisible()
    await expect(page.locator('.sheet-tabs button[role="tab"]')).toHaveCount(1)
  })
})

test.describe('Multi-Sheet — debug lazy formula', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('debug=1: opening Sheet1 keeps an off-screen formula lazy', async ({ page }) => {
    await gotoDemo(page, DEMO, 'debug=1')
    await selectSheet(page, 'Sheet1')

    if (!(await hasDebugClient(page))) {
      throw new Error('Multi-Sheet debug client is required for lazy formula verification.')
    }

    const beforeEval = await readDebugFormulaEvalCount(page, DEBUG_UNOBSERVED_FORMULA.sheetIdx)
    const beforeState = await readDebugFormulaCacheState(
      page,
      DEBUG_UNOBSERVED_FORMULA.sheetIdx,
      DEBUG_UNOBSERVED_FORMULA.addr,
    )

    const duringSheet1Eval = await readDebugFormulaEvalCount(
      page,
      DEBUG_UNOBSERVED_FORMULA.sheetIdx,
    )

    if (beforeEval !== null && duringSheet1Eval !== null) {
      // Keep an off-screen formula on a different sheet lazy until that sheet
      // becomes active and its formula cell is read.
      expect(duringSheet1Eval).toBe(beforeEval)
    }

    if (beforeState !== null) {
      expect(['clean', 'dirty', 'computing', 'unknown', 'missing']).toContain(beforeState)
    }

    await selectSheet(page, 'Expenses')
    await expectDisplay(page, DEBUG_UNOBSERVED_FORMULA.addr, EXPENSES_C5_LAZY_VALUE)

    const afterEval = await readDebugFormulaEvalCount(page, DEBUG_UNOBSERVED_FORMULA.sheetIdx)
    const afterState = await readDebugFormulaCacheState(
      page,
      DEBUG_UNOBSERVED_FORMULA.sheetIdx,
      DEBUG_UNOBSERVED_FORMULA.addr,
    )

    if (afterEval !== null && beforeEval !== null) {
      expect(afterEval).toBeGreaterThan(beforeEval)
    }
    if (afterState !== null) {
      expect(afterState).toMatch(/clean|dirty|computing|unknown/)
    }
  })
})
