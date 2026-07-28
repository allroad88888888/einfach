import { test, expect, type Page } from '@playwright/test'
import { cellDisplay, gotoDemo, expectNoConsoleErrors, guardConsoleErrors } from './helpers'

const IMPORT_INPUT = '[data-testid="million-import-input"]'
const IMPORT_CANCEL = '[data-testid="million-import-cancel"]'
const IMPORT_STATUS = '[data-testid="million-import-status"]'
const IMPORT_STATS = '[data-testid="million-import-stats"]'
const IMPORT_ERROR = '[data-testid="million-import-error"]'

const IMPORT_COMPLETE_TEXT = /完成|完成导入|completed|done|import complete/i
const IMPORT_CANCELLED_TEXT = /已取消|取消|cancelled|canceled|aborted/i
const IMPORT_IN_PROGRESS_TEXT = /导入|import|processing|parsing|loading/i

type DebugCounters = {
  importSessionCount?: number
}

type DebugClient = {
  debugFormulaEvalCount?: (sheetIdx: number) => Promise<number> | number
  debugFormulaCacheState?: (sheetIdx: number, addr: string) => Promise<string> | string
  debugCounters?: () => Promise<DebugCounters> | DebugCounters
  readCells?: (
    cells: Array<{ sheet: number; addr: string }>,
  ) => Promise<Array<{ display: string }>> | Array<{ display: string }>
  importChunk?: (...args: unknown[]) => Promise<unknown>
}

type WindowWithDebugClient = Window & {
  __einfachWorkbookDebugClient?: DebugClient
}

const IMPORTED_FORMULA_ADDR = 'A120'

function buildImportContent(delimiter: ',' | '\t'): string {
  return [
    ['10', 'label'].join(delimiter),
    ...Array.from({ length: 118 }, () => ''),
    '=A1+5',
  ].join('\n')
}

function buildCsvCase() {
  return {
    name: 'wave5-import-mini.csv',
    mimeType: 'text/csv',
    content: buildImportContent(','),
  }
}

function buildTsvCase() {
  return {
    name: 'wave5-import-mini.tsv',
    mimeType: 'text/tab-separated-values',
    content: buildImportContent('\t'),
  }
}

function buildLargeImportFile(rows = 40_000, cols = 3): string {
  const lines: string[] = []
  for (let r = 1; r <= rows; r += 1) {
    const row = [
      String(r),
      `row-${r}`,
      r % 17 === 0 ? `=A${r}+1` : String(r % 13),
    ]
    lines.push(cols === 1 ? row[0] : row.join('\t'))
  }
  return lines.join('\n')
}

function importStatus(page: Page) {
  return page.locator(IMPORT_STATUS)
}

function importStats(page: Page) {
  return page.locator(IMPORT_STATS)
}

function importError(page: Page) {
  return page.locator(IMPORT_ERROR)
}

function importInput(page: Page) {
  return page.locator(IMPORT_INPUT)
}

function importCancel(page: Page) {
  return page.locator(IMPORT_CANCEL)
}

async function expectImportUiReady(page: Page) {
  await expect(importInput(page), '缺失文件导入入口 [data-testid="million-import-input"]').toHaveCount(1, {
    timeout: 20_000,
  })
}

async function waitForStatusMatch(page: Page, expected: RegExp) {
  await expect(importStatus(page)).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await importStatus(page).textContent()) ?? '', {
      timeout: 90_000,
      interval: 250,
    })
    .toMatch(expected)
}

async function readDebugFormulaEvalCount(page: Page, requireEndpoint = true): Promise<number | null> {
  const result = await page.evaluate(async () => {
    const win = window as unknown as WindowWithDebugClient
    const client = win.__einfachWorkbookDebugClient
    if (!client || typeof client.debugFormulaEvalCount !== 'function') {
      return null
    }
    const evalCount = await Promise.resolve(client.debugFormulaEvalCount(0))
    if (typeof evalCount !== 'number' || Number.isNaN(evalCount)) return null
    return evalCount
  })

  if (result === null && requireEndpoint) {
    throw new Error(
      '缺少 debug 入口：当前主线未暴露 window.__einfachWorkbookDebugClient.debugFormulaEvalCount。' +
        '请在 DemoMillion 的 debug=1 下挂载该入口后再运行公式 lazy 断言。',
    )
  }

  return result
}

async function readDebugFormulaCacheState(page: Page, addr: string): Promise<string> {
  const result = await page.evaluate(async (targetAddr) => {
    const win = window as unknown as WindowWithDebugClient
    const client = win.__einfachWorkbookDebugClient
    if (!client || typeof client.debugFormulaCacheState !== 'function') {
      return null
    }
    return Promise.resolve(client.debugFormulaCacheState(0, targetAddr))
  }, addr)

  if (result === null) {
    throw new Error(
      '缺少 debug 入口：当前主线未暴露 window.__einfachWorkbookDebugClient.debugFormulaCacheState。',
    )
  }
  return result
}

async function readDebugCellDisplay(page: Page, addr: string): Promise<string> {
  const result = await page.evaluate(async (targetAddr) => {
    const win = window as unknown as WindowWithDebugClient
    const client = win.__einfachWorkbookDebugClient
    if (!client || typeof client.readCells !== 'function') {
      return null
    }
    const [cell] = await Promise.resolve(client.readCells([{ sheet: 0, addr: targetAddr }]))
    return cell?.display ?? null
  }, addr)

  if (result === null) {
    throw new Error(
      '缺少 debug 入口：当前主线未暴露 window.__einfachWorkbookDebugClient.readCells。',
    )
  }
  return result
}

async function readImportSessionCount(page: Page): Promise<number | null> {
  const result = await page.evaluate(async () => {
    const win = window as unknown as WindowWithDebugClient
    const client = win.__einfachWorkbookDebugClient
    if (!client || typeof client.debugCounters !== 'function') return null
    const counters = await Promise.resolve(client.debugCounters())
    if (!counters || typeof counters !== 'object') return null
    const raw = (counters as DebugCounters).importSessionCount
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  })
  return result
}

async function patchImportChunk(page: Page, delayMs = 25): Promise<boolean> {
  const patched = await page.evaluate(async (delay) => {
    const win = window as unknown as WindowWithDebugClient & {
      __einfachWorkbookDebugClient?: DebugClient & {
        __einfachImportChunkPatched?: boolean
        __einfachImportChunkOriginal?: DebugClient['importChunk']
      }
    }
    const client = win.__einfachWorkbookDebugClient
    if (!client || typeof client.importChunk !== 'function') {
      return false
    }
    if (client.__einfachImportChunkPatched) {
      return true
    }

    const original = client.importChunk
    if (!client.__einfachImportChunkOriginal) {
      client.__einfachImportChunkOriginal = original
    }

    client.importChunk = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return Promise.resolve(original.apply(client, args))
    }
    client.__einfachImportChunkPatched = true
    return true
  }, delayMs)

  return patched
}

async function restoreImportChunkPatch(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as WindowWithDebugClient & {
      __einfachWorkbookDebugClient?: DebugClient & {
        __einfachImportChunkPatched?: boolean
        __einfachImportChunkOriginal?: DebugClient['importChunk']
      }
    }
    const client = win.__einfachWorkbookDebugClient
    if (!client || !client.__einfachImportChunkPatched) return
    if (client.__einfachImportChunkOriginal) {
      client.importChunk = client.__einfachImportChunkOriginal
    }
    delete client.__einfachImportChunkPatched
    delete client.__einfachImportChunkOriginal
  })
}

test.describe('1M Cells file import', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
    await gotoDemo(page, '1M Cells', 'debug=1')
  })

  for (const [kind, file] of Object.entries({
    csv: buildCsvCase(),
    tsv: buildTsvCase(),
  })) {
    test(`imports small ${kind} file and keeps formula lazy until read`, async ({ page }) => {
      await expectImportUiReady(page)
      await importInput(page).setInputFiles({
        name: file.name,
        mimeType: file.mimeType,
        buffer: Buffer.from(file.content, 'utf8'),
      })

      await waitForStatusMatch(page, IMPORT_COMPLETE_TEXT)
      await expect(importStats(page)).toBeVisible()
      await expect(importError(page)).toHaveCount(0)

      await expect(cellDisplay(page, 'A1')).toHaveText('10')
      await expect(cellDisplay(page, 'B1')).toHaveText('label')

      const beforeReadEvalCount = await readDebugFormulaEvalCount(page, true)
      await expect
        .poll(() => readDebugFormulaCacheState(page, IMPORTED_FORMULA_ADDR), {
          timeout: 30_000,
          interval: 250,
        })
        .toMatch(/dirty|unknown/i)

      expect(await readDebugCellDisplay(page, IMPORTED_FORMULA_ADDR)).toBe('15')

      const afterReadEvalCount = await readDebugFormulaEvalCount(page, true)
      expect(afterReadEvalCount).toBeGreaterThan(beforeReadEvalCount ?? 0)

      await expectNoConsoleErrors(page)
    })
  }

  test('cancels a long-running import and returns to zero import sessions', async ({ page }) => {
    const delayPatched = await patchImportChunk(page, 40)
    const cancel = importCancel(page)
    const status = importStatus(page)

    try {
      await expectImportUiReady(page)
      const largeFile = {
        name: 'wave5-cancel.tsv',
        mimeType: 'text/tab-separated-values',
        buffer: Buffer.from(buildLargeImportFile(30_000), 'utf8'),
      }
      await importInput(page).setInputFiles(largeFile)

      if (delayPatched) {
        await expect
          .poll(async () => (await status.textContent()) ?? '', { timeout: 60_000, interval: 250 })
          .toMatch(IMPORT_IN_PROGRESS_TEXT)
      } else {
        // 无法打桩 importChunk 时，用较大文件作为兜底确保有足够时间点击 cancel。
        await expect
          .poll(async () => (await status.textContent()) ?? '', { timeout: 60_000, interval: 250 })
          .toMatch(IMPORT_IN_PROGRESS_TEXT)
      }

      await expect(cancel).toBeVisible({ timeout: 30_000 })
      await cancel.click()

      await expect
        .poll(async () => (await status.textContent()) ?? '')
        .toMatch(IMPORT_CANCELLED_TEXT, { timeout: 60_000 })

      const importSessionCount = await readImportSessionCount(page)
      if (importSessionCount !== null) {
        expect(importSessionCount).toBe(0)
      }

      await expectNoConsoleErrors(page)
    } finally {
      if (!page.isClosed()) {
        await restoreImportChunkPatch(page)
      }
    }
  })
})
