import { test, expect, type Locator, type Page } from '@playwright/test'

type Locale = 'en' | 'zh'
type MoreFormatKind = 'currency' | 'date-time' | 'number'

const RAW_I18N_KEY_RE =
  /\b(?:toolbar|numberFormatDropdown|numberFormatDialog|formatCells)\.[A-Za-z0-9_.-]+/

const MORE_FORMAT_LABELS: Record<Locale, Record<MoreFormatKind, RegExp>> = {
  en: {
    currency: /More currency formats(?:\.\.\.|…)?/,
    'date-time': /More date (?:&|and) time formats(?:\.\.\.|…)?/,
    number: /More number formats(?:\.\.\.|…)?/,
  },
  zh: {
    currency: /更多货币格式(?:\.\.\.|…)?/,
    'date-time': /更多日期(?:与|和)时间格式(?:\.\.\.|…)?/,
    number: /更多数字格式(?:\.\.\.|…)?/,
  },
}

const MORE_FORMAT_TEST_IDS: Record<MoreFormatKind, string> = {
  currency: 'number-format-custom-currency',
  'date-time': 'number-format-custom-dateTime',
  number: 'number-format-custom-number',
}

const MIN_DIALOG_OPTIONS: Record<MoreFormatKind, number> = {
  currency: 40,
  'date-time': 14,
  number: 20,
}

async function gotoWave5(page: Page, locale: Locale = 'en') {
  await page.goto(`/?locale=${locale}`)
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function cell(page: Page, addr: string) {
  return page.locator('[data-testid="wave5-grid"]').locator(`td.cell[data-cell-addr="${addr}"]`)
}

function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

function numberFormatButton(page: Page) {
  return page.getByTestId('toolbar-btn-number-format')
}

function numberFormatDropdown(page: Page) {
  return page.getByTestId('number-format-dropdown')
}

function numberFormatItem(page: Page, id: string) {
  return page.getByTestId(`number-format-item-${id}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function firstVisible(candidates: Locator[]): Promise<Locator> {
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) continue
    const first = candidate.first()
    if (await first.isVisible().catch(() => false)) return first
  }
  return candidates[0].first()
}

async function fillFirstVisible(candidates: Locator[], value: string): Promise<boolean> {
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) continue
    const first = candidate.first()
    if (!(await first.isVisible().catch(() => false))) continue
    await first.fill(value)
    return true
  }
  return false
}

async function clickFirstVisible(candidates: Locator[]): Promise<boolean> {
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) continue
    const first = candidate.first()
    if (!(await first.isVisible().catch(() => false))) continue
    await first.click()
    return true
  }
  return false
}

async function activate(locator: Locator) {
  await locator.evaluate((el) => {
    ;(el as HTMLElement).click()
  })
}

async function typeIntoCell(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

async function expectNoRawI18nKeys(locator: Locator) {
  const text = (await locator.innerText()).trim()
  expect(text).not.toMatch(RAW_I18N_KEY_RE)
}

async function moreFormatItem(
  page: Page,
  kind: MoreFormatKind,
  locale: Locale,
): Promise<Locator> {
  const label = MORE_FORMAT_LABELS[locale][kind]
  return firstVisible([
    page.getByTestId(MORE_FORMAT_TEST_IDS[kind]),
    page.getByTestId(`number-format-more-${kind}`),
    page.getByRole('menuitem', { name: label }),
    page.getByRole('button', { name: label }),
  ])
}

async function openCustomFormatsSubmenu(page: Page, locale: Locale) {
  await numberFormatButton(page).click()
  const dropdown = numberFormatDropdown(page)
  await expect(dropdown).toBeVisible()
  await expectNoRawI18nKeys(dropdown)

  const custom = numberFormatItem(page, 'Custom')
  await expect(custom).toBeVisible()
  await expect(custom).toContainText(locale === 'zh' ? /自定义格式/ : /Custom format/)
  await custom.hover()

  for (const kind of ['currency', 'date-time', 'number'] as const) {
    const item = await moreFormatItem(page, kind, locale)
    await expect(item).toBeVisible()
    await expect(item).toContainText(MORE_FORMAT_LABELS[locale][kind])
  }
}

async function openMoreFormatDialog(
  page: Page,
  kind: MoreFormatKind,
  locale: Locale = 'en',
): Promise<Locator> {
  await openCustomFormatsSubmenu(page, locale)
  const item = await moreFormatItem(page, kind, locale)
  await activate(item)

  const dialog = page.getByRole('dialog').first()
  await expect(dialog).toBeVisible()
  await expectDialogTitleHasLocalizedText(dialog)
  await expectDialogHasManyOptions(dialog, kind)
  return dialog
}

async function expectDialogHasManyOptions(dialog: Locator, kind: MoreFormatKind) {
  const options = dialog.locator('[data-testid^="number-format-dialog-option-"]')
  await expect(options.nth(MIN_DIALOG_OPTIONS[kind] - 1)).toBeVisible()
  expect(await options.count()).toBeGreaterThanOrEqual(MIN_DIALOG_OPTIONS[kind])
}

async function expectDialogTitleHasLocalizedText(dialog: Locator) {
  const title = await firstVisible([
    dialog.locator('.number-format-dialog-title'),
    dialog.locator('#number-format-dialog-title'),
    dialog.locator('.format-cells-title'),
    dialog.locator('[data-testid="format-cells-title"]'),
    dialog.locator('[data-testid$="-dialog-title"]'),
    dialog.locator('[data-testid$="-title"]'),
  ])
  let text = ''
  if ((await title.count()) > 0 && (await title.isVisible().catch(() => false))) {
    text = (await title.textContent())?.trim() ?? ''
  }
  if (!text) {
    text = (await dialog.getAttribute('aria-label'))?.trim() ?? ''
  }
  expect(text).not.toBe('')
  expect(text).not.toMatch(RAW_I18N_KEY_RE)
}

async function clickCategoryIfPresent(dialog: Locator, category: string) {
  await clickFirstVisible([
    dialog.getByTestId(`format-cells-category-${category}`),
    dialog.getByRole('radio', { name: new RegExp(category, 'i') }),
  ])
}

async function setCurrencySymbol(dialog: Locator, symbol: string) {
  const filled = await fillFirstVisible(
    [
      dialog.getByTestId('format-cells-currency-symbol'),
      dialog.getByTestId('format-cells-symbol'),
      dialog.getByLabel(/Symbol|符号/),
    ],
    symbol,
  )
  if (filled) return

  await clickFirstVisible([
    dialog.getByTestId('number-format-dialog-option-usd'),
    dialog.getByRole('option', { name: new RegExp(`^${escapeRegExp(symbol)}$`) }),
    dialog.getByRole('button', { name: new RegExp(`^${escapeRegExp(symbol)}$`) }),
  ])
}

async function setDecimalPlacesIfPresent(dialog: Locator, digits: string) {
  await fillFirstVisible(
    [
      dialog.getByTestId('number-format-dialog-decimals'),
      dialog.getByTestId('format-cells-currency-decimals'),
      dialog.getByTestId('format-cells-number-decimals'),
      dialog.getByLabel(/Decimal places|小数位数/),
    ],
    digits,
  )
}

async function setDatePattern(dialog: Locator, pattern: string) {
  const filled = await fillFirstVisible(
    [
      dialog.getByTestId('format-cells-date-pattern'),
      dialog.getByTestId('format-cells-date-time-pattern'),
      dialog.getByTestId('format-cells-pattern'),
      dialog.getByLabel(/Pattern|模式/),
    ],
    pattern,
  )
  if (filled) return

  const exact = new RegExp(`^${escapeRegExp(pattern)}$`)
  const option = await firstVisible([
    dialog.getByTestId('number-format-dialog-option-date-iso'),
    dialog.getByRole('option', { name: exact }),
    dialog.getByRole('button', { name: exact }),
    dialog.getByRole('menuitem', { name: exact }),
  ])
  await expect(option).toBeVisible()
  await option.click()
}

async function setNumberPattern(dialog: Locator, pattern: string) {
  const filled = await fillFirstVisible(
    [
      dialog.getByTestId('format-cells-number-pattern'),
      dialog.getByTestId('format-cells-custom-pattern'),
      dialog.getByTestId('format-cells-pattern'),
      dialog.getByLabel(/Pattern|模式/),
    ],
    pattern,
  )
  if (filled) return

  const exact = new RegExp(`^${escapeRegExp(pattern)}$`)
  const option = await firstVisible([
    dialog.getByTestId('number-format-dialog-option-thousands-decimal'),
    dialog.getByRole('option', { name: exact }),
    dialog.getByRole('button', { name: exact }),
    dialog.getByRole('menuitem', { name: exact }),
  ])
  await expect(option).toBeVisible()
  await option.click()
}

async function saveDialog(dialog: Locator) {
  const save = await firstVisible([
    dialog.getByTestId('number-format-dialog-save'),
    dialog.getByTestId('format-cells-save'),
    dialog.getByRole('button', { name: /^(OK|确定)$/ }),
  ])
  await save.click()
  await expect(dialog).toBeHidden()
}

test.describe('Wave 5 — more number formats', () => {
  test('custom-format submenu and dialog title are localized in English and Chinese', async ({
    page,
  }) => {
    for (const locale of ['en', 'zh'] as const) {
      await gotoWave5(page, locale)
      await cell(page, 'B2').click()
      await openCustomFormatsSubmenu(page, locale)

      const currencyItem = await moreFormatItem(page, 'currency', locale)
      await activate(currencyItem)
      const dialog = page.getByRole('dialog').first()
      await expect(dialog).toBeVisible()
      await expectDialogTitleHasLocalizedText(dialog)
      await expectDialogHasManyOptions(dialog, 'currency')
      await expectNoRawI18nKeys(dialog)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
  })

  test('more currency formats applies dollars with 2 decimals to the active cell', async ({
    page,
  }) => {
    await gotoWave5(page, 'en')
    await cell(page, 'B2').click()
    await expect(cellDisplay(page, 'B2')).toHaveText('120')

    const dialog = await openMoreFormatDialog(page, 'currency')
    await clickCategoryIfPresent(dialog, 'currency')
    await setCurrencySymbol(dialog, '$')
    await setDecimalPlacesIfPresent(dialog, '2')
    await saveDialog(dialog)

    await expect(cellDisplay(page, 'B2')).toHaveText(/^\$120\.00$/)
  })

  test('more date and time formats applies yyyy-MM-dd to a date serial', async ({ page }) => {
    await gotoWave5(page, 'en')
    await typeIntoCell(page, 'B2', '45432')
    await cell(page, 'B2').click()
    await expect(cellDisplay(page, 'B2')).toHaveText('45432')

    const dialog = await openMoreFormatDialog(page, 'date-time')
    await clickCategoryIfPresent(dialog, 'date')
    await setDatePattern(dialog, 'yyyy-MM-dd')
    await saveDialog(dialog)

    await expect(cellDisplay(page, 'B2')).toHaveText('2024-05-20')
  })

  test('more number formats applies #,##0.00 to the active cell', async ({ page }) => {
    await gotoWave5(page, 'en')
    await typeIntoCell(page, 'B2', '1234.56')
    await cell(page, 'B2').click()
    await expect(cellDisplay(page, 'B2')).toHaveText('1234.56')

    const dialog = await openMoreFormatDialog(page, 'number')
    await setNumberPattern(dialog, '#,##0.00')
    await saveDialog(dialog)

    await expect(cellDisplay(page, 'B2')).toHaveText('1,234.56')
  })
})
