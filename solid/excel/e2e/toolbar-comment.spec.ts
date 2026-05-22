import { test, expect, type Page } from '@playwright/test'
import { guardConsoleErrors, cell } from './helpers'

async function gotoWave5(page: Page) {
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

async function enterDrafting(page: Page, addr: string) {
  await cell(page, addr).dblclick()
  const input = cell(page, addr).locator('.cell-input')
  await expect(input).toBeVisible()
  return input
}

function commentButton(page: Page) {
  return page.getByTestId('toolbar-btn-comment')
}

function commentThread(page: Page) {
  return page.getByTestId('wave5-comment-thread')
}

function statusActiveCell(page: Page) {
  return page.getByTestId('status-active-cell')
}

test.describe('Toolbar — Comment button', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
  })

  test('comment button is visible, enabled, and has translated labels', async ({ page }) => {
    await gotoWave5(page)
    await cell(page, 'C3').click()

    const button = commentButton(page)
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()

    const tooltip = await button.getAttribute('data-tooltip')
    const ariaLabel = await button.getAttribute('aria-label')

    expect(tooltip).toBeTruthy()
    expect(ariaLabel).toBeTruthy()
    expect(tooltip).not.toBe('toolbar.comment.title')
    expect(tooltip).not.toBe('toolbar.comment')
    expect(ariaLabel).not.toBe('toolbar.comment.title')
    expect(ariaLabel).not.toBe('toolbar.comment')
    expect(tooltip).not.toMatch(/\b[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+\b/i)
    expect(ariaLabel).not.toMatch(/\b[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+\b/i)
  })

  test('clicking comment opens a wave5 comment thread anchored to active cell', async ({ page }) => {
    await gotoWave5(page)
    const target = 'D4'
    const targetCell = cell(page, target)
    await targetCell.click()
    await expect(targetCell).toHaveAttribute('data-active', 'true')

    const activeAddr = (await statusActiveCell(page).textContent())?.trim()
    await expect(statusActiveCell(page)).toHaveText(target)

    const button = commentButton(page)
    await expect(button).toBeEnabled()
    await button.click()

    const thread = commentThread(page)
    await expect(thread).toBeVisible()

    const threadCell = thread.getByTestId('comment-thread-cell')
    await expect(threadCell).toBeVisible()
    const threadCellText = (await threadCell.textContent())?.trim() ?? ''
    expect(threadCellText).toContain(activeAddr ?? '')
    expect(threadCellText).toContain('sheet-1')
  })

  test('comment thread supports typing and can be closed', async ({ page }) => {
    await gotoWave5(page)
    const target = 'E5'
    await cell(page, target).click()

    const button = commentButton(page)
    await button.click()

    const thread = commentThread(page)
    await expect(thread).toBeVisible()

    const textarea = thread.getByTestId('comment-thread-textarea')
    await expect(textarea).toBeVisible()
    const draft = 'Playwright comment draft'
    await textarea.fill(draft)
    await expect(textarea).toHaveValue(draft)

    const closeButton = thread.getByTestId('comment-close-button')
    await expect(closeButton).toBeVisible()
    await closeButton.click()
    await expect(thread).toHaveCount(0)
  })

  test('comment button is disabled while cell is drafting', async ({ page }) => {
    await gotoWave5(page)
    const target = 'A1'
    const editingInput = await enterDrafting(page, target)

    const button = commentButton(page)
    await expect(button).toBeDisabled()

    await page.keyboard.press('Escape')
    await expect(editingInput).toHaveCount(0)
    await expect(button).toBeEnabled()
  })
})
