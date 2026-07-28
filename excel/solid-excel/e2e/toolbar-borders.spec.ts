import { expect, test, type Page } from '@playwright/test'
import { cell, guardConsoleErrors, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function bordersButton(page: Page) {
  return page.getByTestId('toolbar-btn-borders')
}

function bordersDropdown(page: Page) {
  return page.getByTestId('toolbar-borders-dropdown')
}

function bordersOption(page: Page, preset: 'all' | 'outer' | 'inner' | 'none') {
  return page.getByTestId(`toolbar-borders-${preset}`)
}

async function selectRange(page: Page, fromAddr: string, toAddr: string) {
  const start = cell(page, fromAddr)
  const end = cell(page, toAddr)
  const startBox = await start.boundingBox()
  const endBox = await end.boundingBox()
  if (!startBox || !endBox) throw new Error('cells not visible')

  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, {
    steps: 4,
  })
  await page.mouse.up()
}

async function readBordersAttr(page: Page, addr: string) {
  return cell(page, addr).getAttribute('data-borders')
}

async function readBordersMap(page: Page, addrs: string[]) {
  const entries = await Promise.all(
    addrs.map(async (addr) => [addr, await readBordersAttr(page, addr)] as const),
  )
  return Object.fromEntries(entries) as Record<string, string | null>
}

function assertLocalizedLabel(label: string | null, key: string, field: string) {
  expect(label, `${field} is present`).toBeTruthy()
  expect(label, `${field} is not the raw i18n key`).not.toBe(key)
  expect(label, `${field} is not a raw i18n path`).not.toContain('toolbar.')
}

async function expectNoBordersAttr(page: Page, addr: string) {
  await expect(cell(page, addr)).not.toHaveAttribute('data-borders', /./)
}

test.describe('Wave 5 toolbar - borders', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('toolbar-borders button is visible, localized, and opens the dropdown', async ({
    page,
  }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    const button = bordersButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()

    assertLocalizedLabel(
      await button.getAttribute('aria-label'),
      'toolbar.borders.title',
      'borders aria-label',
    )
    assertLocalizedLabel(
      await button.getAttribute('data-tooltip'),
      'toolbar.borders.title',
      'borders tooltip',
    )

    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(bordersDropdown(page)).toBeVisible()
  })

  test('single-cell selection keeps toolbar-borders-inner disabled', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'A1').click()

    await bordersButton(page).click()
    await expect(bordersDropdown(page)).toBeVisible()
    await expect(bordersOption(page, 'inner')).toBeDisabled()
  })

  test('all preset paints every cell in the A1:B2 selection', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cell(page, addr)).toHaveAttribute('data-selected', 'true')
    }

    await bordersButton(page).click()
    await expect(bordersDropdown(page)).toBeVisible()
    await bordersOption(page, 'all').click()
    await expect(bordersDropdown(page)).toBeHidden()

    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expect(cell(page, addr)).toHaveAttribute('data-borders', 'top right bottom left')
    }
  })

  test('outer preset paints only boundary sides of the A1:B2 selection', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await bordersButton(page).click()
    await bordersOption(page, 'outer').click()
    await expect(bordersDropdown(page)).toBeHidden()

    await expect(cell(page, 'A1')).toHaveAttribute('data-borders', 'top left')
    await expect(cell(page, 'B1')).toHaveAttribute('data-borders', 'top right')
    await expect(cell(page, 'A2')).toHaveAttribute('data-borders', 'bottom left')
    await expect(cell(page, 'B2')).toHaveAttribute('data-borders', 'right bottom')
  })

  test('none preset clears borders previously applied to the A1:B2 selection', async ({
    page,
  }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await bordersButton(page).click()
    await bordersOption(page, 'all').click()
    await expect(bordersDropdown(page)).toBeHidden()
    await expect(cell(page, 'A1')).toHaveAttribute('data-borders', 'top right bottom left')

    await bordersButton(page).click()
    await bordersOption(page, 'none').click()
    await expect(bordersDropdown(page)).toBeHidden()

    for (const addr of ['A1', 'B1', 'A2', 'B2']) {
      await expectNoBordersAttr(page, addr)
    }
  })

  test('Escape closes the borders dropdown without changing borders', async ({ page }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await bordersButton(page).click()
    await bordersOption(page, 'all').click()
    await expect(bordersDropdown(page)).toBeHidden()

    const before = await readBordersMap(page, ['A1', 'B1', 'A2', 'B2'])

    await bordersButton(page).click()
    await expect(bordersDropdown(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(bordersDropdown(page)).toBeHidden()

    const after = await readBordersMap(page, ['A1', 'B1', 'A2', 'B2'])
    expect(after).toEqual(before)
  })

  test('outside click closes the borders dropdown without changing borders', async ({
    page,
  }) => {
    await gotoWave5(page)
    await selectRange(page, 'A1', 'B2')

    await bordersButton(page).click()
    await bordersOption(page, 'outer').click()
    await expect(bordersDropdown(page)).toBeHidden()

    const before = await readBordersMap(page, ['A1', 'B1', 'A2', 'B2'])

    await bordersButton(page).click()
    await expect(bordersDropdown(page)).toBeVisible()
    await page.getByTestId('wave5-formula-bar').click()
    await expect(bordersDropdown(page)).toBeHidden()

    const after = await readBordersMap(page, ['A1', 'B1', 'A2', 'B2'])
    expect(after).toEqual(before)
  })
})
