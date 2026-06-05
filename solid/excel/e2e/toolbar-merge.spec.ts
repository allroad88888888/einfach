import { expect, test, type Page } from '@playwright/test'
import { cell, cellDisplay, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function mergeButton(page: Page) {
  return page.getByTestId('toolbar-btn-merge')
}

function mergeDropdown(page: Page) {
  return page.getByTestId('toolbar-merge-dropdown')
}

function mergeCenterItem(page: Page) {
  return page.getByTestId('toolbar-merge-center')
}

function acrossRowsItem(page: Page) {
  return page.getByTestId('toolbar-merge-across-rows')
}

function acrossColsItem(page: Page) {
  return page.getByTestId('toolbar-merge-across-cols')
}

function unmergeItem(page: Page) {
  return page.getByTestId('toolbar-merge-unmerge')
}

function gridCell(page: Page, row: string, col: string) {
  return page.locator(`[data-testid="wave5-grid"] td[data-row="${row}"][data-col="${col}"]`)
}

function assertNotRawLabel(label: string | null, keyCandidate: string, context: string) {
  expect(label, `${context} exists`).toBeTruthy()
  expect(label, `${context} is not raw key`).not.toBe(keyCandidate)
  expect(label, `${context} is localized text`).not.toContain('.')
}

test.describe('Wave 5 toolbar merge', () => {
  test('toolbar-btn-merge is visible, labels are localized, and stays enabled on single-cell non-merge so the dropdown explains why presets are greyed', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    const button = mergeButton(page)
    await expect(button).toBeVisible()

    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')
    assertNotRawLabel(tooltip, 'toolbar.merge.title', 'toolbar button tooltip')
    assertNotRawLabel(ariaLabel, 'toolbar.merge.title', 'toolbar aria-label')
    expect(tooltip).toBe('Merge cells')
    expect(ariaLabel).toBe('Merge cells')
    // Wave 5 keeps the button enabled so the dropdown opens and the user sees
    // why every preset is greyed out (1x1 + not-in-merge → all four presets
    // are no-ops). Per-item disable lives in `MergeDropdown`.
    await expect(button).toBeEnabled()
  })

  test('multi-cell selection enables merge and opens the dropdown', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await cell(page, 'C3').click({ modifiers: ['Shift'] })

    const button = mergeButton(page)
    await expect(button).toBeEnabled()
    await button.click()
    await expect(mergeDropdown(page)).toBeVisible()
  })

  test('merge-center: A1:B2 anchors at A1 and removes covered cells from DOM', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await cell(page, 'B2').click({ modifiers: ['Shift'] })

    await mergeButton(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await mergeCenterItem(page).click()
    await expect(mergeDropdown(page)).toBeHidden()

    const anchor = cell(page, 'A1')
    await expect(anchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(anchor).toHaveAttribute('rowspan', '2')
    await expect(anchor).toHaveAttribute('colspan', '2')
    await expect(gridCell(page, '0', '1')).toHaveCount(0)
    await expect(gridCell(page, '1', '0')).toHaveCount(0)
    await expect(gridCell(page, '1', '1')).toHaveCount(0)
    await expect(cellDisplay(page, 'A1')).toBeVisible()
  })

  test('unmerge restores a merged 2x2 range when selected from toolbar-dropdown', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await cell(page, 'B2').click({ modifiers: ['Shift'] })

    await mergeButton(page).click()
    await mergeCenterItem(page).click()
    await mergeButton(page).click()
    await expect(unmergeItem(page)).toBeEnabled()
    await unmergeItem(page).click()
    await expect(mergeDropdown(page)).toBeHidden()

    await expect(cell(page, 'A1')).toHaveAttribute('data-merge-anchor', 'false')
    await expect(cell(page, 'A1')).toHaveAttribute('rowspan', '1')
    await expect(cell(page, 'A1')).toHaveAttribute('colspan', '1')
    await expect(cell(page, 'B1')).toBeVisible()
    await expect(cell(page, 'A2')).toBeVisible()
    await expect(cell(page, 'B2')).toBeVisible()
  })

  test('across-rows creates one merged anchor per row (A1:C2)', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await cell(page, 'C2').click({ modifiers: ['Shift'] })

    await mergeButton(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await acrossRowsItem(page).click()
    await expect(mergeDropdown(page)).toBeHidden()

    const firstRowAnchor = cell(page, 'A1')
    const secondRowAnchor = cell(page, 'A2')
    await expect(firstRowAnchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(secondRowAnchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(firstRowAnchor).toHaveAttribute('rowspan', '1')
    await expect(firstRowAnchor).toHaveAttribute('colspan', '3')
    await expect(secondRowAnchor).toHaveAttribute('rowspan', '1')
    await expect(secondRowAnchor).toHaveAttribute('colspan', '3')

    await expect(gridCell(page, '0', '1')).toHaveCount(0)
    await expect(gridCell(page, '0', '2')).toHaveCount(0)
    await expect(gridCell(page, '1', '1')).toHaveCount(0)
    await expect(gridCell(page, '1', '2')).toHaveCount(0)
  })

  test('across-cols creates one merged anchor per column (A1:B3)', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await cell(page, 'B3').click({ modifiers: ['Shift'] })

    await mergeButton(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await acrossColsItem(page).click()
    await expect(mergeDropdown(page)).toBeHidden()

    const firstColAnchor = cell(page, 'A1')
    const secondColAnchor = cell(page, 'B1')
    await expect(firstColAnchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(secondColAnchor).toHaveAttribute('data-merge-anchor', 'true')
    await expect(firstColAnchor).toHaveAttribute('rowspan', '3')
    await expect(firstColAnchor).toHaveAttribute('colspan', '1')
    await expect(secondColAnchor).toHaveAttribute('rowspan', '3')
    await expect(secondColAnchor).toHaveAttribute('colspan', '1')

    await expect(gridCell(page, '1', '0')).toHaveCount(0)
    await expect(gridCell(page, '2', '0')).toHaveCount(0)
    await expect(gridCell(page, '1', '1')).toHaveCount(0)
    await expect(gridCell(page, '2', '1')).toHaveCount(0)
  })

  test('Escape and outside click close dropdown without mutating merged status', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()
    await cell(page, 'B2').click({ modifiers: ['Shift'] })

    await mergeButton(page).click()
    await mergeCenterItem(page).click()
    await expect(cell(page, 'A1')).toHaveAttribute('rowspan', '2')
    await expect(cell(page, 'A1')).toHaveAttribute('colspan', '2')

    // Escape should just close the merge dropdown.
    await mergeButton(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(mergeDropdown(page)).toBeHidden()
    await expect(cell(page, 'A1')).toHaveAttribute('rowspan', '2')
    await expect(cell(page, 'A1')).toHaveAttribute('colspan', '2')

    // Click outside the toolbar area should also close without re-applying or reverting merge.
    await mergeButton(page).click()
    await expect(mergeDropdown(page)).toBeVisible()
    await page.getByTestId('formula-bar-input').click()
    await expect(mergeDropdown(page)).toBeHidden()
    await expect(cell(page, 'A1')).toHaveAttribute('rowspan', '2')
    await expect(cell(page, 'A1')).toHaveAttribute('colspan', '2')
    await expect(gridCell(page, '1', '0')).toHaveCount(0)
    await expect(gridCell(page, '1', '1')).toHaveCount(0)
  })
})
