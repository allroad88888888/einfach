import { test, expect, type Locator, type Page } from '@playwright/test'
import { cellDisplay } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string): Locator {
  return page
    .locator('[data-testid="wave5-grid"]')
    .locator(`td.cell[data-cell-addr="${addr}"]`)
}

type TextStyleCase = {
  name: string
  testId: string
  tooltipKey: string
  cell: string
  styleProp: string
  styleOn: string
}

const textStyleCases: TextStyleCase[] = [
  {
    name: 'bold',
    testId: 'toolbar-btn-bold',
    tooltipKey: 'toolbar.bold.title',
    cell: 'B2',
    styleProp: 'font-weight',
    styleOn: '700',
  },
  {
    name: 'italic',
    testId: 'toolbar-btn-italic',
    tooltipKey: 'toolbar.italic.title',
    cell: 'C2',
    styleProp: 'font-style',
    styleOn: 'italic',
  },
  {
    name: 'underline',
    testId: 'toolbar-btn-underline',
    tooltipKey: 'toolbar.underline.title',
    cell: 'D2',
    styleProp: 'text-decoration-line',
    styleOn: 'underline',
  },
  {
    name: 'strikethrough',
    testId: 'toolbar-btn-strikethrough',
    tooltipKey: 'toolbar.strikethrough.title',
    cell: 'E2',
    styleProp: 'text-decoration-line',
    styleOn: 'line-through',
  },
]

function textStyleButton(page: Page, testId: string) {
  return page.getByTestId(testId)
}

test.describe('Wave 5 toolbar text style buttons', () => {
  for (const scenario of textStyleCases) {
    test(`${scenario.name} toggles aria-pressed and updates active cell style`, async ({
      page,
    }) => {
      await gotoWave5(page)
      const button = textStyleButton(page, scenario.testId)
      await cell(page, scenario.cell).click()
      await expect(button).toBeVisible()

      const ariaLabel = await button.getAttribute('aria-label')
      const dataTooltip = await button.getAttribute('data-tooltip')
      expect(ariaLabel).toBeTruthy()
      expect(dataTooltip).toBeTruthy()
      expect(ariaLabel).not.toBe(scenario.tooltipKey)
      expect(dataTooltip).not.toBe(scenario.tooltipKey)

      await expect(button).toHaveAttribute('aria-pressed', 'false')

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(cellDisplay(page, scenario.cell)).toHaveCSS(
        scenario.styleProp,
        scenario.styleOn,
      )

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'false')
      await expect(cellDisplay(page, scenario.cell)).not.toHaveCSS(
        scenario.styleProp,
        scenario.styleOn,
      )
    })
  }
})
