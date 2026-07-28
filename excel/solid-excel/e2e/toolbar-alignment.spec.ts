import { expect, test, type Locator, type Page } from '@playwright/test'
import { cell, cellDisplay, withEnglishLocale } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

function hAlignBtn(page: Page) {
  return page.getByTestId('toolbar-btn-h-align')
}

function hAlignDropdown(page: Page) {
  return page.getByTestId('toolbar-h-align-dropdown')
}

function hAlignCenterItem(page: Page) {
  return page.getByTestId('toolbar-h-align-center')
}

function hAlignRightItem(page: Page) {
  return page.getByTestId('toolbar-h-align-right')
}

function vAlignBtn(page: Page) {
  return page.getByTestId('toolbar-btn-v-align')
}

function vAlignDropdown(page: Page) {
  return page.getByTestId('toolbar-v-align-dropdown')
}

function vAlignTopItem(page: Page) {
  return page.getByTestId('toolbar-v-align-top')
}

function vAlignMiddleItem(page: Page) {
  return page.getByTestId('toolbar-v-align-middle')
}

function wrapBtn(page: Page) {
  return page.getByTestId('toolbar-btn-wrap')
}

function rotationBtn(page: Page) {
  return page.getByTestId('toolbar-btn-rotation')
}

function rotationDropdown(page: Page) {
  return page.getByTestId('toolbar-rotation-dropdown')
}

function rotation90Item(page: Page) {
  return page.getByTestId('toolbar-rotation-90')
}

function rotationVerticalItem(page: Page) {
  return page.getByTestId('toolbar-rotation-vertical')
}

async function readCellWrapStyle(page: Page, addr: string) {
  return cellDisplay(page, addr).evaluate((el) => {
    const style = getComputedStyle(el)
    return { overflowWrap: style.overflowWrap, whiteSpace: style.whiteSpace }
  })
}

async function readCellRotationStyle(page: Page, addr: string) {
  return cellDisplay(page, addr).evaluate((el) => {
    const style = getComputedStyle(el)
    return { transform: style.transform, writingMode: style.writingMode }
  })
}

async function readCellVerticalAlignStyle(page: Page, addr: string) {
  return cellDisplay(page, addr).evaluate((el) => {
    const style = el.style
    return {
      cellVerticalAlign: style.getPropertyValue('--cell-vertical-align'),
      height: style.height,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
    }
  })
}

function assertNotRawLabel(
  label: string | null,
  keyCandidate: string,
  fieldName = 'label',
) {
  expect(label, `${fieldName} is visible`).toBeTruthy()
  expect(label, `${fieldName} is not raw key`).not.toBe(keyCandidate)
  expect(label, `${fieldName} is not key text`).not.toContain('toolbar.')
}

test.describe('Wave 5 toolbar alignment + wrap + rotation', () => {
  test('alignment/wrap/rotation button tooltips are localized labels', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'B2').click()

    await expect(hAlignBtn(page)).toBeVisible()
    await expect(vAlignBtn(page)).toBeVisible()
    await expect(wrapBtn(page)).toBeVisible()
    await expect(rotationBtn(page)).toBeVisible()

    assertNotRawLabel(
      await hAlignBtn(page).getAttribute('aria-label'),
      'toolbar.hAlign.title',
      'h-align aria-label',
    )
    assertNotRawLabel(
      await hAlignBtn(page).getAttribute('data-tooltip'),
      'toolbar.hAlign.title',
      'h-align tooltip',
    )
    assertNotRawLabel(
      await vAlignBtn(page).getAttribute('aria-label'),
      'toolbar.vAlign.title',
      'v-align aria-label',
    )
    assertNotRawLabel(
      await vAlignBtn(page).getAttribute('data-tooltip'),
      'toolbar.vAlign.title',
      'v-align tooltip',
    )
    assertNotRawLabel(
      await wrapBtn(page).getAttribute('aria-label'),
      'toolbar.wrap.title',
      'wrap aria-label',
    )
    assertNotRawLabel(
      await wrapBtn(page).getAttribute('data-tooltip'),
      'toolbar.wrap.title',
      'wrap tooltip',
    )
    assertNotRawLabel(
      await rotationBtn(page).getAttribute('aria-label'),
      'toolbar.rotation.title',
      'rotation aria-label',
    )
    assertNotRawLabel(
      await rotationBtn(page).getAttribute('data-tooltip'),
      'toolbar.rotation.title',
      'rotation tooltip',
    )
  })

  test('toolbar-btn-h-align sets center and right', async ({ page }) => {
    await gotoWave5(page)
    const target = 'C2'
    await cell(page, target).click()

    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'left')
    await hAlignBtn(page).click()
    await expect(hAlignDropdown(page)).toBeVisible()
    await hAlignCenterItem(page).click()
    await expect(hAlignDropdown(page)).toBeHidden()
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'center')
    await expect(cellDisplay(page, target)).toHaveCSS('text-align', 'center')

    await hAlignBtn(page).click()
    await hAlignRightItem(page).click()
    await expect(hAlignBtn(page)).toHaveAttribute('data-active-align', 'right')
    await expect(cellDisplay(page, target)).toHaveCSS('text-align', 'right')
  })

  test('toolbar-btn-v-align sets top and middle', async ({ page }) => {
    await gotoWave5(page)
    const target = 'D2'
    await cell(page, target).click()

    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'bottom')
    await vAlignBtn(page).click()
    await expect(vAlignDropdown(page)).toBeVisible()
    await vAlignTopItem(page).click()
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'top')
    expect(await readCellVerticalAlignStyle(page, target)).toMatchObject({
      cellVerticalAlign: 'top',
      height: 'auto',
      marginTop: '0px',
      marginBottom: 'auto',
    })

    await vAlignBtn(page).click()
    await vAlignMiddleItem(page).click()
    await expect(vAlignBtn(page)).toHaveAttribute('data-active-vertical-align', 'center')
    expect(await readCellVerticalAlignStyle(page, target)).toMatchObject({
      cellVerticalAlign: 'center',
      height: 'auto',
      marginTop: 'auto',
      marginBottom: 'auto',
    })
  })

  test('toolbar-btn-wrap toggles aria-pressed and overflow-wrap css', async ({ page }) => {
    await gotoWave5(page)
    const target = 'B4'
    await cell(page, target).click()
    const button = wrapBtn(page)

    await expect(button).toHaveAttribute('aria-pressed', 'false')
    const before = await readCellWrapStyle(page, target)

    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(cellDisplay(page, target)).toHaveCSS('overflow-wrap', 'anywhere')
    await expect(cellDisplay(page, target)).toHaveCSS('white-space', 'normal')

    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    const after = await readCellWrapStyle(page, target)
    expect(after).toEqual(before)
  })

  test('toolbar-btn-rotation applies 90°, vertical mode, and Escape does not apply', async ({
    page,
  }) => {
    await gotoWave5(page)
    const rotateTarget = 'E2'
    await cell(page, rotateTarget).click()
    await rotationBtn(page).click()
    await expect(rotationDropdown(page)).toBeVisible()
    await rotation90Item(page).click()
    await expect(rotationDropdown(page)).toBeHidden()

    const rotateTransform = await readCellRotationStyle(page, rotateTarget)
    expect(rotateTransform.transform).toMatch(/^matrix\(/)
    // rotate(90deg) should render matrix(..., 1, -1, ...) on supported engines.
    expect(rotateTransform.transform).toMatch(/,\s*1(\.0+)?\s*,\s*-1(\.0+)?\s*,/)

    await rotationBtn(page).click()
    await expect(rotationDropdown(page)).toBeVisible()
    await rotationVerticalItem(page).click()
    await expect(rotationDropdown(page)).toBeHidden()
    await expect(cellDisplay(page, rotateTarget)).toHaveCSS('writing-mode', 'vertical-rl')

    const escapeTarget = 'F2'
    await cell(page, escapeTarget).click()
    const before = await readCellRotationStyle(page, escapeTarget)
    await rotationBtn(page).click()
    await expect(rotationDropdown(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rotationDropdown(page)).toBeHidden()

    const after = await readCellRotationStyle(page, escapeTarget)
    expect(after).toEqual(before)
  })
})
