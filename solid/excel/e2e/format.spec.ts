import { test, expect, type Page } from '@playwright/test'
import { withEnglishLocale } from './helpers'

/**
 * Phase 6 — format toolbar e2e.
 *
 * Targets the Blank demo (JS mock sheet). Format support on the mock matches
 * the WASM backend's shape (set_format / get_format / formatted_display) so
 * percent / bold / undo all behave identically. The toolbar lives above the
 * grid; buttons mutate the format of every cell in the current selection.
 */

function cell(page: Page, addr: string) {
  return page.locator(`td.cell[data-cell-addr="${addr}"]`)
}

function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

async function gotoBlank(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByRole('button', { name: 'Blank' }).click()
  await expect(cell(page, 'A1')).toBeVisible()
  // Format toolbar opt-in is wired on DemoBlank via `toolbar` prop.
  await expect(page.locator('.format-toolbar')).toBeVisible()
}

async function gotoBlankDebug(page: Page) {
  await page.goto(withEnglishLocale('debug=1'))
  await page.getByRole('button', { name: 'Blank' }).click()
  await expect(cell(page, 'A1')).toBeVisible()
  await expect(page.locator('.format-toolbar')).toBeVisible()
}

async function typeIntoCell(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

test.describe('Format toolbar', () => {
  test('bold button toggles font-weight on the selection', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', 'hi')
    // Selecting A1 — re-click after the commit so focus moves there.
    await cell(page, 'A1').click()

    await page.getByRole('button', { name: 'Bold' }).click()

    // The <td> picks up an inline `font-weight: 700` once bold applies.
    await expect(cell(page, 'A1')).toHaveAttribute('style', /font-weight:\s*700/)
  })

  test('percent format renders 0.5 as "50%"', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '0.5')
    await cell(page, 'A1').click()

    // Plain General format → "0.5".
    await expect(cellDisplay(page, 'A1')).toHaveText('0.5')

    // Switch to Percent via the Format dropdown.
    await page.getByLabel('Number format').selectOption('percent-0')

    await expect(cellDisplay(page, 'A1')).toHaveText('50%')
  })

  test('undo restores the previous format', async ({ page }) => {
    await gotoBlank(page)
    await typeIntoCell(page, 'A1', '0.5')
    await cell(page, 'A1').click()

    await page.getByLabel('Number format').selectOption('percent-0')
    await expect(cellDisplay(page, 'A1')).toHaveText('50%')

    // Focus the wrapper so the global keydown handler picks up Ctrl/Cmd+Z.
    await page.locator('.excel-table-wrapper').click()
    const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
    await page.keyboard.press(undoKey)

    await expect(cellDisplay(page, 'A1')).toHaveText('0.5')
  })

  test('large selection formatting does not materialize the address grid', async ({ page }) => {
    await gotoBlankDebug(page)

    const setup = await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          selectionAddrs: () => string[][]
          raw: {
            set_format_range?: (...args: Array<unknown>) => unknown
            set_format?: (...args: Array<unknown>) => unknown
            get_format?: (...args: Array<unknown>) => unknown
          }
          formatSelection: (
            patch: (current: Record<string, unknown>) => Record<string, unknown>,
          ) => boolean
          setSelectionAnchor: (coord: { row: number; col: number }) => void
          extendSelection: (coord: { row: number; col: number }) => void
        }
        __formatSelectionCalls?: number
        __setFormatRangeCalls?: Array<Array<unknown>>
      }
      const store = win.__einfachStore
      if (!store) return { hasStore: false }
      const originalFormatSelection = store.formatSelection.bind(store)
      win.__formatSelectionCalls = 0
      store.selectionAddrs = () => {
        throw new Error('selectionAddrs must not run for large formatting')
      }
      store.raw.set_format = () => {
        throw new Error('set_format must not run for range-native formatting')
      }
      store.raw.get_format = () => {
        throw new Error('get_format must not run for range-native formatting')
      }
      const calls: Array<Array<unknown>> = []
      store.raw.set_format_range = (...args: Array<unknown>) => {
        calls.push(args)
      }
      store.formatSelection = (patch) => {
        win.__formatSelectionCalls = (win.__formatSelectionCalls ?? 0) + 1
        return originalFormatSelection(patch)
      }
      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })

      const ok = store.formatSelection((current) => ({ ...current, bold: true }))
      win.__setFormatRangeCalls = calls
      return { hasStore: true, ok }
    })
    expect(setup.hasStore).toBe(true)
    expect(setup.ok).toBe(true)

    const calls = await page.evaluate(() => {
      const win = window as unknown as {
        __setFormatRangeCalls?: Array<Array<unknown>>
      }
      return win.__setFormatRangeCalls
    })
    expect(calls).toEqual([[0, 0, 999, 999, { bold: true }]])

    await expect
      .poll(() =>
        page.evaluate(() => {
          const win = window as unknown as { __formatSelectionCalls?: number }
          return win.__formatSelectionCalls ?? 0
        }),
      )
      .toBe(1)
  })

  test('large formatting returns false when range-native set_format_range API is unavailable', async ({
    page,
  }) => {
    await gotoBlankDebug(page)

    const setup = await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          selectionAddrs: () => string[][]
          raw: {
            set_format_range?: (...args: Array<unknown>) => unknown
            set_format?: (...args: Array<unknown>) => unknown
            get_format?: (...args: Array<unknown>) => unknown
          }
          formatSelection: (
            patch: (current: Record<string, unknown>) => Record<string, unknown>,
          ) => boolean
          setSelectionAnchor: (coord: { row: number; col: number }) => void
          extendSelection: (coord: { row: number; col: number }) => void
        }
        __formatSelectionResult?: boolean
        __formatSelectionCalls?: number
      }
      const store = win.__einfachStore
      if (!store) return { hasStore: false }
      ;(store.raw as { set_format_range?: (...args: Array<unknown>) => unknown }).set_format_range =
        undefined

      let setFormatCalls = 0
      let getFormatCalls = 0
      if (store.raw.set_format) {
        store.raw.set_format = () => {
          setFormatCalls += 1
        }
      }
      if (store.raw.get_format) {
        store.raw.get_format = () => {
          getFormatCalls += 1
          return {}
        }
      }

      store.selectionAddrs = () => {
        throw new Error('selectionAddrs must not run for oversized formatting')
      }
      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      const ok = store.formatSelection((current) => ({ ...current, bold: true }))
      return {
        hasStore: true,
        ok,
        setFormatCalls,
        getFormatCalls,
      }
    })

    expect(setup.hasStore).toBe(true)
    expect(setup.ok).toBe(false)
    expect(setup.setFormatCalls).toBe(0)
    expect(setup.getFormatCalls).toBe(0)
  })
})
