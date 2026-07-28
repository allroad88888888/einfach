import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  cellInput,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
} from './helpers'

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function expectCanonicalCellState(
  page: Page,
  address: string,
  formulaBarValue: string,
  mode: 'ready' | 'edit',
) {
  await expect(cell(page, address)).toHaveAttribute('data-selected', 'true')
  await expect(cell(page, address)).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('name-box-input')).toHaveValue(address)
  await expect(page.getByTestId('formula-bar-input')).toHaveValue(formulaBarValue)
  await expect(page.getByTestId('status-active-cell')).toHaveText(address)
  await expect(page.getByTestId('status-selection')).toHaveText(address)
  await expect(page.getByTestId('status-mode-badge')).toHaveAttribute('data-mode', mode)
}

test.describe('vNext direct cell editing real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('native double-click commits with Enter and cancels with Escape', async ({ page }) => {
    await gotoWorkerDemo(page)

    const backend = test.info().project.name
    expect(['wasm', 'ts']).toContain(backend)
    expect(new URL(page.url()).searchParams.get('backend')).toBe(backend)

    // Commit from a non-active cell through the native pointer/edit path.
    await cell(page, 'B4').dblclick()
    const commitEditor = cellInput(page, 'B4')
    await expect(commitEditor).toBeVisible()
    await expect(commitEditor).toHaveValue('10')
    await expectCanonicalCellState(page, 'B4', '10', 'edit')

    await commitEditor.fill('21')
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('21')
    await commitEditor.press('Enter')

    await expect(commitEditor).toHaveCount(0)
    await expect(cellDisplay(page, 'B4')).toHaveText('21')
    // Excel-style Enter commits, returns to navigation mode, and moves down.
    await expectCanonicalCellState(page, 'B5', '', 'ready')

    // A visible mouse selection reads the committed backend value back through
    // every canonical UI surface, without a debug client or direct state read.
    await cell(page, 'B4').click()
    await expectCanonicalCellState(page, 'B4', '21', 'ready')

    // Escape discards the live draft and keeps the edited cell selected.
    await cell(page, 'C4').dblclick()
    const cancelEditor = cellInput(page, 'C4')
    await expect(cancelEditor).toBeVisible()
    await expect(cancelEditor).toHaveValue('source')
    await expectCanonicalCellState(page, 'C4', 'source', 'edit')

    await cancelEditor.fill('discarded')
    await expect(page.getByTestId('formula-bar-input')).toHaveValue('discarded')
    await cancelEditor.press('Escape')

    await expect(cancelEditor).toHaveCount(0)
    await expect(cellDisplay(page, 'C4')).toHaveText('source')
    await expectCanonicalCellState(page, 'C4', 'source', 'ready')
  })
})
