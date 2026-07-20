import { expect, test, type Page } from '@playwright/test'

import {
  cell,
  cellDisplay,
  expectNoConsoleErrors,
  gotoRoot,
  guardConsoleErrors,
  typeIntoCell,
} from './helpers'

/**
 * Engine physical sort (`sortRange`, design-engine-sort.md slice S7) on the
 * worker demos — real-backend evidence.
 *
 * The toolbar Sort button dispatches ONE physical-sort command
 * (`runPhysicalSortAtom`). The capability split is transparent to the UI:
 *
 *   - WASM worker  → exposes the `sortRange` port → the Rust engine PHYSICALLY
 *     reorders the workbook rows (a backend data mutation, host-orchestrated
 *     undo, `kind: 'range.sort'` history entry).
 *   - TS worker    → declares `sortRange: false` (fail-closed) → the command
 *     delegates to the display-permutation fallback (a pure VIEW fact — the
 *     engine data never moves and NO `range.sort` history entry is recorded).
 *
 * PHYSICAL vs DISPLAY-PERMUTATION discriminator
 * ---------------------------------------------
 * Note that "an adjacent column moves with the sorted rows" does NOT by itself
 * prove a physical sort: the display permutation reorders whole VISIBLE rows
 * too, so column A appears reordered under both paths. The airtight, code-
 * backed distinguisher is the HISTORY channel:
 *
 *   - Physical (`runPhysicalSortAtom` → engine): pushes a `range.sort` entry
 *     into the host history with a numeric backend revision, and undo/redo
 *     move the actual engine data (`recordCellMutation({ kind: 'range.sort' })`
 *     in `worker-workbook-backend.ts`).
 *   - Display fallback (`runFilterSortEntrypointAtom`): pushes NO history
 *     entry at all — it is a view directive, not a data mutation.
 *
 * So the presence/absence of a `range.sort` history entry (plus, on WASM, that
 * undo physically restores the data and heals the cross-sheet chain) is the
 * criterion this suite pins. Column-A lockstep movement is kept only as
 * supporting visual evidence of a whole-row move.
 *
 * Clean sort column
 * -----------------
 * The seeded Sheet1 carries a three-hop cross-sheet chain
 * (Sheet1!C2 → Sheet2!C2 → Sheet3!C2 → Sheet1!B4). A physical row move that
 * relocates B4 correctly propagates `#TYPE!`/`#VALUE!` into the far reference
 * (see `rust/excel-core/tests/sort_cross_sheet.rs` — correct propagation, not a
 * bug). To keep assertions clean this suite sorts by a fresh, dependency-free
 * column E (E2..E4, entered out of order 3/1/2 through the real UI) and asserts
 * only on column E (the sort key) and the seed column A (lockstep witness) —
 * never on column C.
 */

async function gotoWorkerDemo(page: Page) {
  guardConsoleErrors(page)
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

function activeProjectIsWasm(): boolean {
  try {
    return test.info().project.name !== 'ts'
  } catch {
    return true
  }
}

/**
 * Enter the out-of-order key column through the visible UI. Row 1 (E1) is the
 * header row and stays outside the sort range (design: the data region starts
 * at row 1 / 0-based). E2=3, E3=1, E4=2 gives an ascending sort real work.
 */
async function seedCleanSortColumn(page: Page) {
  await typeIntoCell(page, 'E2', '3')
  await typeIntoCell(page, 'E3', '1')
  await typeIntoCell(page, 'E4', '2')
  await expect(cellDisplay(page, 'E2')).toHaveText('3')
  await expect(cellDisplay(page, 'E3')).toHaveText('1')
  await expect(cellDisplay(page, 'E4')).toHaveText('2')
}

/**
 * Click a vnext-grid cell and wait for it to become the active cell. The
 * shared `selectCell` helper waits for the legacy grid's `.cell-selected`
 * class; the vnext grid marks the active cell with `data-active="true"`.
 */
async function selectGridCell(page: Page, addr: string) {
  await cell(page, addr).click()
  await expect(cell(page, addr)).toHaveAttribute('data-active', 'true')
}

async function sortAscendingFromColumnE(page: Page) {
  // The active cell drives both the sort KEY (its column → E) and the data
  // region's bottom edge (its row → 4). Selecting E4 keeps E the key and pulls
  // the seed rows 2..4 into the region.
  await selectGridCell(page, 'E4')

  const sortButton = page.getByTestId('toolbar-btn-sort')
  await expect(sortButton).toBeEnabled()
  // The demo boots the zh catalog (gotoRoot does not force locale=en), so the
  // toolbar Sort button carries aria-label 排序.
  await expect(sortButton).toHaveAttribute('aria-label', '排序')
  await sortButton.click()

  await expect(page.getByTestId('toolbar-sort-dropdown')).toBeVisible()
  await page.getByTestId('toolbar-sort-asc').click()
}

const sortHistoryEntry = (page: Page) =>
  page.locator('.history-timeline-entry[data-kind="range.sort"]')

test.describe('vNext engine physical sort real-backend evidence', () => {
  test.afterEach(async ({ page }) => {
    await expectNoConsoleErrors(page)
  })

  test('WASM worker physically reorders the data region, records range.sort, and undo/redo move real data', async ({
    page,
  }) => {
    test.skip(!activeProjectIsWasm(), 'physical engine sort is the WASM backend contract')
    await gotoWorkerDemo(page)
    await seedCleanSortColumn(page)

    // Baseline adjacent seed column A: A2 cell1, A3 blank, A4 cell4.
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')

    await sortAscendingFromColumnE(page)

    // PHYSICAL result — column E ascends 1/2/3 in place, and the whole rows
    // moved: seed column A followed its rows (blank row floated to A2, cell4 to
    // A3, cell1 to A4).
    await expect(cellDisplay(page, 'E2')).toHaveText('1')
    await expect(cellDisplay(page, 'E3')).toHaveText('2')
    await expect(cellDisplay(page, 'E4')).toHaveText('3')
    await expect(cellDisplay(page, 'A2')).toHaveText('')
    await expect(cellDisplay(page, 'A3')).toHaveText('cell4')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell1')

    // DISCRIMINATOR: a physical sort is a backend data mutation → exactly one
    // `range.sort` history entry with a numeric backend revision. (The display
    // fallback would record none — see the TS test.)
    await expect(sortHistoryEntry(page)).toHaveCount(1)
    await expect(sortHistoryEntry(page)).toContainText(/rev \d+/)

    // Undo the sort (most-recent entry) → the engine restores the pre-sort
    // order, and the cross-sheet chain that broke during the physical move
    // heals back to 13. This is data, not a view directive.
    await page.getByTestId('history-timeline-undo').click()
    await expect(cellDisplay(page, 'E2')).toHaveText('3')
    await expect(cellDisplay(page, 'E3')).toHaveText('1')
    await expect(cellDisplay(page, 'E4')).toHaveText('2')
    await expect(cellDisplay(page, 'A2')).toHaveText('cell1')
    await expect(cellDisplay(page, 'A4')).toHaveText('cell4')
    await expect(cellDisplay(page, 'C2')).toHaveText('13')
    await expect(sortHistoryEntry(page)).toHaveAttribute('data-applied', 'false')

    // Redo re-applies the physical sort.
    await page.getByTestId('history-timeline-redo').click()
    await expect(cellDisplay(page, 'E2')).toHaveText('1')
    await expect(cellDisplay(page, 'E3')).toHaveText('2')
    await expect(cellDisplay(page, 'E4')).toHaveText('3')
    await expect(sortHistoryEntry(page)).toHaveAttribute('data-applied', 'true')
  })

  test('TS worker fail-closes to the display permutation — the view reorders with NO range.sort data mutation', async ({
    page,
  }) => {
    test.skip(activeProjectIsWasm(), 'TS worker declares sortRange:false → display fallback path')
    await gotoWorkerDemo(page)
    await seedCleanSortColumn(page)

    await sortAscendingFromColumnE(page)

    // The sort entry is usable and the view reorders (display layer): column E
    // shows ascending in the visible window, same visual outcome as physical.
    await expect(cellDisplay(page, 'E2')).toHaveText('1')
    await expect(cellDisplay(page, 'E3')).toHaveText('2')
    await expect(cellDisplay(page, 'E4')).toHaveText('3')

    // DISCRIMINATOR: no `sortRange` port → the command fail-closes to the
    // display permutation, a pure VIEW fact. It records NO `range.sort` history
    // entry (the only entries are the three seed cell edits). Per design the TS
    // path is a development fallback, so no physical/undo assertions are made.
    await expect(sortHistoryEntry(page)).toHaveCount(0)
    await expect(page.locator('.history-timeline-entry[data-kind="cell.set-input"]')).toHaveCount(3)
  })
})
