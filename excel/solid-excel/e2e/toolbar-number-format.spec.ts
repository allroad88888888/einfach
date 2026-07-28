import { test, expect, type Page } from '@playwright/test'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string) {
  return page.locator('[data-testid="wave5-grid"]').locator(`td.cell[data-cell-addr="${addr}"]`)
}

function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

function numberFormatButton(page: Page) {
  return page.getByTestId('toolbar-btn-number-format')
}

function percentShortcutButton(page: Page) {
  return page.getByTestId('toolbar-btn-percent-format')
}

function currencyShortcutButton(page: Page) {
  return page.getByTestId('toolbar-btn-currency-format')
}

function incDecimalButton(page: Page) {
  return page.getByTestId('toolbar-btn-inc-decimal')
}

function decDecimalButton(page: Page) {
  return page.getByTestId('toolbar-btn-dec-decimal')
}

function numberFormatDropdown(page: Page) {
  return page.getByTestId('number-format-dropdown')
}

function numberFormatItem(page: Page, id: string) {
  return page.getByTestId(`number-format-item-${id}`)
}

function columnHeader(page: Page, col: number) {
  return page.getByTestId('wave5-grid').locator(`th.spreadsheet-grid-col-header[data-col="${col}"]`)
}

function sortButton(page: Page) {
  return page.getByTestId('toolbar-btn-sort')
}

function sortAsc(page: Page) {
  return page.getByTestId('toolbar-sort-asc')
}

function expectLocalizedLabel(label: string | null) {
  expect(label).toBeTruthy()
  expect(label).not.toContain('toolbar.')
  expect(label).not.toContain('currencyDropdown')
}

async function expectCellText(page: Page, addr: string, expected: string) {
  await expect(cellDisplay(page, addr)).toHaveText(expected)
}

test.describe('Wave 5 — number-format toolbar', () => {
  test('number-format button is visible and labels are localized', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = numberFormatButton(page)
    await expect(button).toBeVisible()

    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')
    const text = (await button.textContent())?.trim() ?? ''

    expectLocalizedLabel(tooltip)
    expectLocalizedLabel(ariaLabel)
    expect(text).not.toBe('')
    expect(text).not.toContain('toolbar.')
    expect(text).not.toBe('toolbar.currencyDropdown')

    await button.click()
    await expect(numberFormatDropdown(page)).toBeVisible()
    await expect(numberFormatItem(page, 'Percent')).toBeVisible()
    await expect(numberFormatItem(page, 'WanYuan')).toBeDisabled()
    await expect(numberFormatDropdown(page).locator('[data-format-id]')).toHaveCount(16)
  })

  test('opening number-format dropdown and choosing Percent shows 12000%', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expectCellText(page, 'B2', '120')

    await numberFormatButton(page).click()
    await expect(numberFormatDropdown(page)).toBeVisible()

    await numberFormatItem(page, 'Percent').click()
    await expect(numberFormatDropdown(page)).toBeHidden()
    await expectCellText(page, 'B2', '12000%')
  })

  test('percent shortcut formats directly without opening dropdown', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expectCellText(page, 'B2', '120')

    await percentShortcutButton(page).click()
    await expect(numberFormatDropdown(page)).toBeHidden()
    await expectCellText(page, 'B2', '12000%')
  })

  // Regression test for the T14 defect (fixed 2026-07-19): the toolbar's
  // inline SortDropdown (and the Borders/HAlign/VAlign/Rotation/Merge
  // dropdowns) attached their document-level mousedown dismiss listener in
  // `onMount` for the toolbar's whole lifetime. After the sort dropdown had
  // been opened once, its `rootRef` pointed at a detached node, so a real
  // mousedown on a number-format item was judged "outside" and cleared the
  // shared toolbar surface between mousedown and click — the item unmounted
  // before its onClick could dispatch `toolbar.format.command`. Fixed by
  // attaching dismiss listeners only while each popup is open (the canonical
  // NumberFormatDropdown pattern). This test drives a REAL mousedown+click
  // through the dropdown after sorting — do not green it by switching to the
  // percent shortcut button.
  test('percent dropdown applies to the selected visible row after sorting', async ({ page }) => {
    await gotoWave5(page)
    await columnHeader(page, 4).click()
    await sortButton(page).click()
    await sortAsc(page).click()

    await expectCellText(page, 'A5', 'Central')
    await expectCellText(page, 'E5', '280')
    await expectCellText(page, 'A6', 'North')
    await expectCellText(page, 'E6', '300')

    await cell(page, 'E6').click()
    await numberFormatButton(page).click()
    await numberFormatItem(page, 'Percent').click()

    await expectCellText(page, 'E5', '280')
    await expectCellText(page, 'E6', '30000%')
  })

  test('currency shortcut formats directly without opening dropdown', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expectCellText(page, 'B2', '120')

    await currencyShortcutButton(page).click()
    await expect(numberFormatDropdown(page)).toBeHidden()

    const currencyText = (await cellDisplay(page, 'B2').textContent())?.trim() ?? ''
    expect(currencyText).toMatch(/^[\$¥\u00a5]120(\.00)?$/)
  })

  test('increase decimal applies 1 decimal, decrease restores integer and disable at 0', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    await expectCellText(page, 'B2', '120')

    const incButton = incDecimalButton(page)
    const decButton = decDecimalButton(page)

    await expect(decButton).toBeDisabled()
    await incButton.click()
    await expectCellText(page, 'B2', '120.0')
    await expect(decButton).toBeEnabled()

    await decButton.click()
    await expectCellText(page, 'B2', '120')
    await expect(decButton).toBeDisabled()
  })

  test('Escape and outside click close number-format dropdown without changing value', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()
    const before = (await cellDisplay(page, 'B2').textContent())?.trim() ?? ''

    await numberFormatButton(page).click()
    await expect(numberFormatDropdown(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(numberFormatDropdown(page)).toBeHidden()
    expect((await cellDisplay(page, 'B2').textContent())?.trim()).toBe(before)

    await numberFormatButton(page).click()
    await expect(numberFormatDropdown(page)).toBeVisible()
    await page.getByTestId('wave5-formula-bar').click()
    await expect(numberFormatDropdown(page)).toBeHidden()
    expect((await cellDisplay(page, 'B2').textContent())?.trim()).toBe(before)
  })
})
