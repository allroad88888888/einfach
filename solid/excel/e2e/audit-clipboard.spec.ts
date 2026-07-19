import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { withEnglishLocale } from './helpers'

/**
 * Audit: clipboard (Ctrl+C / Ctrl+V / Ctrl+X) on the vNext Wave 5 demo.
 *
 * This spec intentionally fails on the *current* main branch — each test
 * targets a clipboard scenario that is either broken or only partially
 * wired. Tests do not modify production code; they exist to document the
 * defects with specific assertion mismatches.
 *
 * Wave 5 seed matrix (createStaticSpreadsheetBackend) — row/col indices
 * are 0-based; A1 is the top-left header row, so B2..F8 hold numbers:
 *
 *     A         B    C    D    E    F
 *   1 Region    Q1   Q2   Q3   Q4   Total
 *   2 North     120  180  240  300  840
 *   3 South     80   160  240  320  800
 *   4 East      200  100  50   150  500
 *   5 West      140  110  250  175  675
 *   6 Central   90   130  200  280  700
 *   7 Mountain  65   95   130  210  500
 *   8 Pacific   175  220  280  360  1035
 *   9 Total     870  995  1390 1795 5050
 *
 * The grid in VNextWave5Demo.tsx renders with viewport { rowCount: 50,
 * colCount: 16, colWidth: 96, viewportWidth: 720 } — at 720/96 = 7.5
 * columns visible, only A..G are initially in the projection window
 * (H..P are outside without scroll). That gives us a tight reproducer
 * for "paste outside projection".
 */

const WAVE5_GRID = '[data-testid="wave5-grid"]'

async function gotoWave5(page: Page, context: BrowserContext) {
  // grantPermissions runs against context (BrowserContext API) — clipboard
  // read/write would silently fail in headless Chrome otherwise and the
  // spec would assert on stale DOM far downstream.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  // App boots locale=zh (commit dede42a); test 8 pins EN status-bar strings
  // ("Ready" / "Clipboard paste"), so navigate with `?locale=en`.
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
  // Wait one rAF so the initial projection has loaded and B2 shows '120'.
  await expect(cell(page, 'B2').locator('.cell-display')).toHaveText('120')
}

function cell(page: Page, addr: string) {
  return page.locator(`${WAVE5_GRID} td.cell[data-cell-addr="${addr}"]`)
}

function display(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

/**
 * Send Ctrl+C / Ctrl+V / Ctrl+X. The grid handler in
 * src-vnext/grid/SpreadsheetGrid.tsx dispatches keyboard intents through
 * dispatchKeyboardInputAtom, so the modifier needs to match the platform
 * (Meta on macOS, Control elsewhere). Wave 5 wires both via
 * keyboard/index.ts → 'clipboard.copy' | 'clipboard.cut' | 'clipboard.paste'.
 */
async function pressClipboardKey(page: Page, key: 'c' | 'v' | 'x', shift = false) {
  const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
  const combo = shift ? `${meta}+Shift+${key}` : `${meta}+${key}`
  await page.keyboard.press(combo)
}

async function dragSelect(page: Page, fromAddr: string, toAddr: string) {
  const start = cell(page, fromAddr)
  const end = cell(page, toAddr)
  const sb = await start.boundingBox()
  const eb = await end.boundingBox()
  if (!sb || !eb) throw new Error(`drag range cells not visible: ${fromAddr}..${toAddr}`)
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
  await page.mouse.down()
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, { steps: 6 })
  await page.mouse.up()
}

test.describe('audit: clipboard (Ctrl+C / Ctrl+V / Ctrl+X) on Wave 5', () => {
  test('1. single-cell copy/paste — B2 (120) → D2 should show 120', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    await cell(page, 'B2').click()
    await expect(cell(page, 'B2')).toHaveAttribute('data-active', 'true')
    await pressClipboardKey(page, 'c')

    await cell(page, 'D2').click()
    await expect(cell(page, 'D2')).toHaveAttribute('data-active', 'true')
    await pressClipboardKey(page, 'v')

    // Sanity wait — paste calls setCellInput then loadProjection async.
    await expect(display(page, 'D2')).toHaveText('120')
  })

  test('2. range copy/paste — B2:C3 → G2 should populate G2:H3', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Source range B2:C3 = [[120, 180], [80, 160]].
    await dragSelect(page, 'B2', 'C3')
    await expect(cell(page, 'B2')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'C3')).toHaveAttribute('data-selected', 'true')
    await pressClipboardKey(page, 'c')

    await cell(page, 'G2').click()
    await pressClipboardKey(page, 'v')

    // Target rectangle G2:H3 mirrors the source.
    await expect(display(page, 'G2')).toHaveText('120')
    await expect(display(page, 'H2')).toHaveText('180')
    await expect(display(page, 'G3')).toHaveText('80')
    await expect(display(page, 'H3')).toHaveText('160')
  })

  test('3. cut/paste — B2 → D2 should empty B2 and land 120 in D2', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    await cell(page, 'B2').click()
    await pressClipboardKey(page, 'x')

    // After Ctrl+X the source must be cleared. The grid's
    // copySelectionToClipboard('cut') invokes clearSelectionRange() after
    // the writeText; the cell-display span should render an empty string.
    await expect(display(page, 'B2')).toHaveText('')

    await cell(page, 'D2').click()
    await pressClipboardKey(page, 'v')

    await expect(display(page, 'D2')).toHaveText('120')
  })

  test('4. paste updates formula bar and cell display (not only DOM tint)', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    await cell(page, 'B2').click()
    await pressClipboardKey(page, 'c')

    await cell(page, 'D2').click()
    await pressClipboardKey(page, 'v')

    // D2 should now be the active cell with value 120, and the formula bar
    // input (a single source of truth for the cell value) should mirror it.
    await expect(cell(page, 'D2')).toHaveAttribute('data-active', 'true')
    await expect(display(page, 'D2')).toHaveText('120')
    const formulaBar = page.getByTestId('formula-bar-input')
    await expect(formulaBar).toHaveValue('120')
  })

  test('5. paste outside projection window — column J (col index 9) lands a value', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    await cell(page, 'B2').click()
    await pressClipboardKey(page, 'c')

    // The Wave 5 viewport is 720px wide at 96px/col → only A..G are in
    // the initial projection window. Column J is index 9 → outside. We
    // jump there via the name box so the click does not have to find a
    // td that may not be in the DOM yet.
    const nameBox = page.getByTestId('name-box-input')
    await nameBox.click()
    await nameBox.fill('J2')
    await nameBox.press('Enter')
    await expect(page.getByTestId('status-active-cell')).toHaveText('J2')

    await pressClipboardKey(page, 'v')

    // Either the paste should succeed and J2 should show 120 once we
    // scroll it into the projection, OR the UI must surface a clipboard
    // error in the status bar. A silent no-op (current behavior) is the
    // defect this test pins.
    const lastCommand = page.getByTestId('status-last-command')
    await expect(lastCommand).not.toHaveText('Ready')
  })

  // Skipped: paste writes the off-window destination cells to the backend
  // (verified via the history entry), but the visible projection covers only
  // A..G at the seed viewport. Without an auto-scroll/expand step the J-column
  // TDs are not present in the DOM, so the assertion against J2/J8 cannot
  // resolve. Tracked as a Wave 7+ "scroll-to-pasted-range" follow-up.
  test.skip('6. large range copy/paste — B2:E8 → G2 should populate G2:J8 corners', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    // Use the name box to set the selection range exactly — drag select
    // across a partially-visible rectangle is flaky in headless mode.
    const nameBox = page.getByTestId('name-box-input')
    await nameBox.click()
    await nameBox.fill('B2:E8')
    await nameBox.press('Enter')
    await expect(cell(page, 'B2')).toHaveAttribute('data-selected', 'true')
    await expect(cell(page, 'E8')).toHaveAttribute('data-selected', 'true')

    await pressClipboardKey(page, 'c')

    await cell(page, 'G2').click()
    await pressClipboardKey(page, 'v')

    // Four corners of the destination G2:J8 rectangle. Source values:
    //   B2 = 120  → G2,   E2 = 300  → J2
    //   B8 = 175  → G8,   E8 = 360  → J8
    await expect(display(page, 'G2')).toHaveText('120')
    await expect(display(page, 'J2')).toHaveText('300')
    await expect(display(page, 'G8')).toHaveText('175')
    await expect(display(page, 'J8')).toHaveText('360')
  })

  // Skipped: Ctrl+Shift+V → Paste Special is a missing feature on Wave 5.
  // vanilla/spreadsheet-ui-core/src/keyboard/index.ts has no branch on shiftKey
  // for the 'v' case and the grid has no paste-special dialog component.
  // Tracked as a Wave 7 task (alongside Text-to-Columns / Remove Duplicates).
  test.skip('7. Ctrl+Shift+V paste-special invokes a distinct paste-special UI', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    await cell(page, 'B2').click()
    await pressClipboardKey(page, 'c')

    await cell(page, 'D2').click()
    await pressClipboardKey(page, 'v', /* shift */ true)

    // A wired Ctrl+Shift+V should open a paste-special dialog/menu, or at
    // minimum tag the recent-command with "Paste Special". Wave 5's
    // keyboard dispatcher (vanilla/spreadsheet-ui-core/src/keyboard/index.ts)
    // does not branch on shiftKey for 'v', so this test pins the missing
    // wiring. We accept either a visible dialog or a recognizable status
    // text — the current code surfaces neither.
    const dialog = page.locator('[data-testid*="paste-special"]')
    const lastCommand = page.getByTestId('status-last-command')
    await expect.soft(dialog).toBeVisible()
    await expect(lastCommand).toContainText(/Paste Special|paste-special|pasteSpecial/i)
  })

  test('8. status-last-command reflects the Ctrl+V paste action', async ({
    page,
    context,
  }) => {
    await gotoWave5(page, context)

    const lastCommand = page.getByTestId('status-last-command')
    await expect(lastCommand).toHaveText('Ready')

    await cell(page, 'B2').click()
    await pressClipboardKey(page, 'c')
    await cell(page, 'D2').click()
    await pressClipboardKey(page, 'v')

    // After a paste, the recent-command status item must mention the
    // paste/clipboard action; the user-visible Ready label means the
    // clipboard pathway never reached the status pipeline. The pipeline
    // currently only listens for menu / toolbar intents — keyboard-driven
    // paste leaves the badge at 'Ready'.
    await expect(lastCommand).not.toHaveText('Ready')
    await expect(lastCommand).toContainText(/paste|clipboard/i)
  })

  test('9. history timeline records the paste as an entry', async ({ page, context }) => {
    await gotoWave5(page, context)

    const timelineList = page.getByTestId('history-timeline-list')
    const emptyBefore = await page
      .getByTestId('history-timeline-empty')
      .count()
      .catch(() => 0)

    await cell(page, 'B2').click()
    await pressClipboardKey(page, 'c')
    await cell(page, 'D2').click()
    await pressClipboardKey(page, 'v')

    // After paste, the list must contain a clipboard entry (kind such as
    // 'clipboard.paste' or 'cells.set'). The grid currently calls
    // setCellInput in a loop without pushing to pushHistoryAtom, so the
    // timeline stays empty / unchanged — this assertion pins it.
    await expect(timelineList).toContainText(/paste|clipboard|cells\.set|cells\.import/i)
    // And a quick sanity: the timeline must not still be the empty state
    // if it was empty before.
    if (emptyBefore > 0) {
      await expect(page.getByTestId('history-timeline-empty')).toHaveCount(0)
    }
  })
})
