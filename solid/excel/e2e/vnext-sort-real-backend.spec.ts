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
 * (`runPhysicalSortAtom`). Physical reorder is the ONLY sort mechanism since
 * task #24 retired the display permutation, so the capability split is now a
 * presence/absence split:
 *
 *   - WASM worker  → exposes the `sortRange` port → the Rust engine PHYSICALLY
 *     reorders the workbook rows (a backend data mutation, host-orchestrated
 *     undo, `kind: 'range.sort'` history entry).
 *   - TS worker    → declares `sortRange: false` (fail-closed) → there is NO
 *     sort at all: the toolbar Sort button, the Data → Sort menu entries, and
 *     the filter-dropdown sort section are all withheld.
 *
 * PHYSICAL-SORT discriminator
 * ---------------------------
 * Note that "an adjacent column moves with the sorted rows" does NOT by itself
 * prove a physical sort. The airtight, code-backed distinguisher is the HISTORY
 * channel: `runPhysicalSortAtom` → engine pushes a `range.sort` entry into the
 * host history with a numeric backend revision, and undo/redo move the actual
 * engine data (`recordCellMutation({ kind: 'range.sort' })` in
 * `worker-workbook-backend.ts`).
 *
 * So the presence of a `range.sort` history entry (plus, on WASM, that undo
 * physically restores the data and heals the cross-sheet chain) is the
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

const workerFilterDropdown = (page: Page) => page.getByTestId('vnext-worker-filter-dropdown')

/**
 * Seed a clean filter+sort scenario on Sheet1 (design-engine-sort S6, #29):
 *   - column A made contiguous A2..A5 so the down-edge from A1 spans the full
 *     data region regardless of the active cell / filter compression;
 *   - column D = filter key ('keep' except D3='drop', a MIDDLE data row);
 *   - column E = sort key (3/1/2/4 out of order).
 */
async function seedFilterSortScenario(page: Page) {
  await typeIntoCell(page, 'A3', 'r3')
  await typeIntoCell(page, 'A5', 'r5')
  await typeIntoCell(page, 'D2', 'keep')
  await typeIntoCell(page, 'D3', 'drop')
  await typeIntoCell(page, 'D4', 'keep')
  await typeIntoCell(page, 'D5', 'keep')
  await typeIntoCell(page, 'E2', '3')
  await typeIntoCell(page, 'E3', '1')
  await typeIntoCell(page, 'E4', '2')
  await typeIntoCell(page, 'E5', '4')
}

async function applyEqualsFilterOnColumn(page: Page, col: number, value: string) {
  await page.locator(`th.spreadsheet-grid-col-header[data-col="${col}"]`).click()
  const filterButton = page.getByTestId('toolbar-btn-filter')
  await expect(filterButton).toBeEnabled()
  await filterButton.click()
  await expect(workerFilterDropdown(page)).toBeVisible()
  await page.getByTestId('filter-condition-kind').selectOption('equals')
  await page.getByTestId('filter-equals-input').fill(value)
  await page.getByTestId('filter-add-equals').click()
}

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
    // `range.sort` history entry with a numeric backend revision.
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

  test('WASM worker: a filter-active toolbar sort reorders the visible rows and leaves the filtered row in place', async ({
    page,
  }) => {
    test.skip(!activeProjectIsWasm(), 'physical engine sort is the WASM backend contract')
    await gotoWorkerDemo(page)
    await seedFilterSortScenario(page)

    // Filter column D to 'keep' → the MIDDLE data row (D3='drop') is HIDDEN
    // (#27 S5), so the rows below it keep their own numbers instead of sliding
    // up. Close the dropdown to free the toolbar sort lane.
    await applyEqualsFilterOnColumn(page, 3, 'keep')
    await page.getByTestId('filter-close').click()
    await expect(workerFilterDropdown(page)).toBeHidden()

    // Row 3 is unmounted; the survivors stay at rows 2, 4, 5 in source order.
    await expect(cellDisplay(page, 'E2')).toHaveText('3')
    await expect(cell(page, 'E3')).toHaveCount(0)
    await expect(cellDisplay(page, 'E4')).toHaveText('2')
    await expect(cellDisplay(page, 'E5')).toHaveText('4')

    // Sort ascending by column E. The sheet has an active filter and still
    // sorts PHYSICALLY, with the filtered-out row carried in excludedRows
    // (design-engine-sort S6 / #29).
    await selectGridCell(page, 'E2')
    const sortButton = page.getByTestId('toolbar-btn-sort')
    await expect(sortButton).toBeEnabled()
    await sortButton.click()
    await expect(page.getByTestId('toolbar-sort-dropdown')).toBeVisible()
    await page.getByTestId('toolbar-sort-asc').click()

    // The visible rows reorder ascending AMONG THEMSELVES, each landing on one
    // of the rows they already occupied (2, 4, 5); the hidden row 3 is passed
    // over rather than written through, which is what excludedRows buys.
    await expect(cellDisplay(page, 'E2')).toHaveText('2')
    await expect(cell(page, 'E3')).toHaveCount(0)
    await expect(cellDisplay(page, 'E4')).toHaveText('3')
    await expect(cellDisplay(page, 'E5')).toHaveText('4')
    // DISCRIMINATOR: a physical sort records exactly one range.sort entry.
    await expect(sortHistoryEntry(page)).toHaveCount(1)

    // Clear the filter through the column-D chevron. The filtered row stayed at
    // its source position (E3=1, D3='drop') — it was excluded from the sort,
    // not merely undrawn — and E now reads 2, 1, 3, 4 down source rows 2..5.
    await page.getByTestId('filter-chevron-3').click()
    await expect(workerFilterDropdown(page)).toBeVisible()
    await page.getByTestId('filter-clear-filter').click()
    await page.getByTestId('filter-close').click()
    await expect(workerFilterDropdown(page)).toBeHidden()

    await expect(cellDisplay(page, 'E2')).toHaveText('2')
    await expect(cellDisplay(page, 'E3')).toHaveText('1')
    await expect(cellDisplay(page, 'E4')).toHaveText('3')
    await expect(cellDisplay(page, 'E5')).toHaveText('4')
    await expect(cellDisplay(page, 'D3')).toHaveText('drop')
  })

  test('WASM worker: the filter dropdown sort dispatches a physical engine sort and closes the menu', async ({
    page,
  }) => {
    test.skip(!activeProjectIsWasm(), 'physical engine sort is the WASM backend contract')
    await gotoWorkerDemo(page)
    // Contiguous column A so the dropdown's data-region resolution (which
    // carries no bottom-row hint) spans source rows 2..5.
    await typeIntoCell(page, 'A3', 'r3')
    await typeIntoCell(page, 'A5', 'r5')
    await seedCleanSortColumn(page)
    await typeIntoCell(page, 'E5', '4')

    // Open the dropdown on column E via the toolbar filter button (no
    // pre-existing rule needed — it opens on the active column), then sort.
    await selectGridCell(page, 'E2')
    const filterButton = page.getByTestId('toolbar-btn-filter')
    await expect(filterButton).toBeEnabled()
    await filterButton.click()
    await expect(workerFilterDropdown(page)).toBeVisible()

    await page.getByTestId('filter-sort-asc').click()

    // Excel closes the AutoFilter menu on sort; the engine physically reorders
    // and records one range.sort history entry.
    await expect(workerFilterDropdown(page)).toBeHidden()
    await expect(cellDisplay(page, 'E2')).toHaveText('1')
    await expect(cellDisplay(page, 'E3')).toHaveText('2')
    await expect(cellDisplay(page, 'E4')).toHaveText('3')
    await expect(cellDisplay(page, 'E5')).toHaveText('4')
    await expect(sortHistoryEntry(page)).toHaveCount(1)
  })

  test('TS worker fail-closes: every sort entrypoint is withheld and no data moves', async ({
    page,
  }) => {
    test.skip(activeProjectIsWasm(), 'TS worker declares sortRange:false → sort is unavailable')
    await gotoWorkerDemo(page)
    await seedCleanSortColumn(page)
    await selectGridCell(page, 'E4')

    // #24: the display permutation is retired, so a host that cannot physically
    // reorder data has NO sort at all. The toolbar Sort button is gone...
    await expect(page.getByTestId('toolbar-btn-sort')).toHaveCount(0)

    // ...and so are both Data menu sort entries.
    await page.getByTestId('menu-bar-button-data').click()
    await expect(page.getByTestId('menu-bar-item-data.sortAsc')).toHaveCount(0)
    await expect(page.getByTestId('menu-bar-item-data.sortDesc')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Since E5 the FILTER button is withheld too: the predicate is engine-owned
    // (design-engine-hidden-rows §5.2) and the TS worker has no engine, so
    // `engineHiddenState:false` fail-closes filter just like `sortRange:false`
    // fail-closes sort. Before E5 this test asserted the filter button ENABLED
    // (filter was a TS-worker view fact); that premise no longer holds.
    await expect(page.getByTestId('toolbar-btn-filter')).toBeDisabled()

    // The seeded data is untouched and no sort history entry exists at all.
    await expect(cellDisplay(page, 'E2')).toHaveText('3')
    await expect(cellDisplay(page, 'E3')).toHaveText('1')
    await expect(cellDisplay(page, 'E4')).toHaveText('2')
    await expect(sortHistoryEntry(page)).toHaveCount(0)
    await expect(page.locator('.history-timeline-entry[data-kind="cell.set-input"]')).toHaveCount(3)
  })
})
