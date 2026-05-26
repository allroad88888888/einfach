/**
 * Wave F / track F2 — TS-backend parity probe.
 *
 * Verifies that the @einfach/excel-core-ts worker (the TypeScript port of the
 * Rust formula engine) is wired correctly through a real Web Worker thread
 * inside the vNext UI demo. This is NOT a full e2e migration — F1's fill-out
 * is still in flight and migrating every spec to `?backend=ts` is its own
 * scope. This one spec exists so we have a single source of truth that the
 * TS worker can serve a non-trivial sheet end-to-end (registry dispatch +
 * sheetAtom invalidation + projection refresh + spill projection all live).
 *
 * Demo seeding lives in `solid/excel/src-vnext/demos/VNextWorkerTsDemo.tsx`:
 *   A1..A4 = Region/North/South/East ; A5 = Total
 *   B1..B4 = Sales/10/20/30          ; B5 = =SUM(B2:B4)
 *   C2     = =UPPER(A2)              → "NORTH" (Wave C/C4 text)
 *   D2     = =IF(B2>15, "high","low") → "low"  (Wave C/C2 logical)
 */
import { test, expect, type Page } from '@playwright/test'
import {
  cell,
  cellDisplay,
  cellInput,
  expectNoConsoleErrors,
  guardConsoleErrors,
} from './helpers'

async function gotoVNextWorkerTsDemo(page: Page) {
  guardConsoleErrors(page)
  await page.goto('/')
  await page.getByTestId('nav-tab-vnext-worker-ts').click()
  await expect(page.getByTestId('vnext-worker-ts-grid')).toBeVisible({ timeout: 30_000 })
  // Wait for the seeded SUM(B2:B4) round-trip so subsequent assertions know
  // the worker has finished its initial recompute pass.
  await expect(cellDisplay(page, 'B5')).toHaveText('60', { timeout: 30_000 })
}

/**
 * The demo viewport is 6 rows tall (`viewportHeight: 144`, `rowHeight: 24`).
 * Bringing A7/A8 into the DOM requires scrolling the vNext grid's own
 * scroll viewport (`.spreadsheet-grid-scroll-viewport` — distinct from
 * the legacy `.excel-table-wrapper` covered by `helpers.scrollWrapper`).
 * SpreadsheetGrid's `handleViewportScroll` listens for native scroll
 * events and forwards them into `viewportMetricsAtom`, so a programmatic
 * scrollTop change feeds the same code path a user wheel-scroll would.
 *
 * 48px puts rows 2..7 in view — A3..A8 are then all addressable in the DOM.
 */
async function scrollToExposeBottomRows(page: Page) {
  const grid = page.getByTestId('vnext-worker-ts-grid')
  await grid.locator('.spreadsheet-grid-scroll-viewport').evaluate((el) => {
    ;(el as HTMLElement).scrollTop = 48
  })
  await expect(cell(page, 'A8')).toBeVisible({ timeout: 5_000 })
}

/**
 * Manual cell-edit helper. We can't use `helpers.typeIntoCell` because the
 * grid wrapper for this demo loses focus on `dblclick` if the wrapper has
 * scrolled — the formula-bar input is the more reliable surface for cells
 * that may be at the edge of the visible window. This shape mirrors the
 * cell-direct path used by the wasm worker spec where the cell is centrally
 * visible.
 */
async function typeFormulaAtCell(page: Page, addr: string, formula: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(formula)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

test.describe('Solid Excel vNext — TS-core worker backend (F2 parity probe)', () => {
  test('TS worker serves the seeded SUM / UPPER / IF round-trip through a real Worker', async ({
    page,
  }) => {
    await gotoVNextWorkerTsDemo(page)

    // Banner is present — confirms the URL routed to the TS demo tab.
    await expect(page.getByTestId('vnext-worker-ts-banner')).toBeVisible()

    // B5 = SUM(B2:B4) = 60 — Wave C/C1 math through real postMessage thread.
    await expect(cellDisplay(page, 'B5')).toHaveText('60')

    // C2 = UPPER("North") = "NORTH" — Wave C/C4 text registry hit.
    await expect(cellDisplay(page, 'C2')).toHaveText('NORTH')

    // D2 = IF(10 > 15, "high", "low") = "low" — Wave C/C2 logical short-circuit.
    await expect(cellDisplay(page, 'D2')).toHaveText('low')
  })

  test('live formula edit recalculates against the seeded SUM (=B5*2 → 120)', async ({ page }) => {
    await gotoVNextWorkerTsDemo(page)

    // A6 sits at row index 5 — last row in the default 6-row visible window.
    await typeFormulaAtCell(page, 'A6', '=B5*2')

    // 60 * 2 = 120 — exercises the broad sheetAtom invalidation: writing A6
    // mutates the sheet Map identity, vanilla/core marks every subscribed
    // derive dirty, and the worker projection responder re-publishes A6.
    await expect(cellDisplay(page, 'A6')).toHaveText('120')

    // B5 must stay 60 — its formula didn't change, just A6's.
    await expect(cellDisplay(page, 'B5')).toHaveText('60')
  })

  // Wave E1 ships spill projection in `worker-runtime-ts.ts`, but only along
  // the explicit-address path (`readCells` → `readCellSnapshot` → `readCellValue`
  // → `getSpillProjectedValue`). The visible-window path used by the grid
  // goes through `readSparseRange` (worker-runtime-ts.ts:434), which iterates
  // `state.workbook.store.getter(target.sheetAtom)` — i.e. ONLY cells with
  // their own input. Spill-target coords (B7, A8, B8 for `=SEQUENCE(2,2)` at A7)
  // have no input of their own and so are never published to the UI projection.
  //
  // Observed behavior with the current build:
  //   - A7 (anchor) displays "1" — top-left scalar collapse via readCellValue
  //   - B7, A8, B8 display "" — spill projection not consulted for empty cells
  //     because readSparseRange's loop is keyed on the cells Map only.
  //
  // Repro confirmed:
  //   1. Navigate to nav-tab-vnext-worker-ts
  //   2. Scroll the spreadsheet-grid-scroll-viewport down 48px (rows 2..7 visible)
  //   3. Double-click A7 and commit `=SEQUENCE(2, 2)`
  //   4. A7=1 but B7/A8/B8 stay blank
  //
  // Cross-check: `solid/excel/test/excel-core-ts-spill.test.ts` exercises the
  // *direct* `readCells` RPC and passes — the engine + spill helper are
  // correct, the gap is in the visible-window publisher only.
  //
  // Wave F2 follow-up fix: `readSparseRange` and `snapshotRangeSparse` in
  // worker-runtime-ts.ts now call `collectSpillTargets()` to emit synthetic
  // CellSnapshotWire entries for anchor-array projections inside the
  // requested bounds. So spill cells (B7, A8, B8) now show up in the UI's
  // visible-window projection alongside the anchor's collapsed top-left.
  test(
    'SEQUENCE spill projects 1,2,3,4 across A7..B8 through the worker boundary',
    async ({ page }) => {
      await gotoVNextWorkerTsDemo(page)
      await scrollToExposeBottomRows(page)

      // Anchor cell at A7 evaluates to Value::Array [[1,2],[3,4]]. The Wave
      // E1 spill projection in worker-runtime-ts.ts collapses the anchor to
      // its top-left scalar AND should publish the other three quadrant cells
      // (B7, A8, B8) by indexing into the anchor's array at read time.
      await typeFormulaAtCell(page, 'A7', '=SEQUENCE(2, 2)')

      await expect(cellDisplay(page, 'A7')).toHaveText('1')
      await expect(cellDisplay(page, 'B7')).toHaveText('2')
      await expect(cellDisplay(page, 'A8')).toHaveText('3')
      await expect(cellDisplay(page, 'B8')).toHaveText('4')
    },
  )

  // The Name Manager dialog (the only host-side surface for `defineName`)
  // only exposes `kind: 'range'` and `kind: 'value'` — there is no UI affordance
  // to register a LAMBDA from inside the running app. The TS engine *does*
  // support LAMBDA (see Wave E/E3 handoff: 16 specs in
  // `vanilla/excel-core-ts/test/lambda.test.ts`) and `excel-core-ts-custom-formulas.test.ts`
  // exercises the worker-runtime dispatch order (builtin → workbook LAMBDA →
  // host custom), but neither path is reachable from playwright today.
  //
  // Wave F follow-up: either (a) extend SpreadsheetNameManagerDialog to accept a
  // LAMBDA refersTo kind, or (b) add a `defineName` debug RPC mirroring the
  // wasm worker's debug client. Until either lands, this scenario stays as
  // a structural fixme rather than a silent drop.
  test.fixme(
    'LAMBDA registration round-trips through the TS worker (no host UI surface yet)',
    async ({ page }) => {
      await gotoVNextWorkerTsDemo(page)
    },
  )

  test('no console errors leak from the TS worker boot or formula edits', async ({ page }) => {
    await gotoVNextWorkerTsDemo(page)
    await typeFormulaAtCell(page, 'A6', '=B5*2')
    await expect(cellDisplay(page, 'A6')).toHaveText('120')
    await expectNoConsoleErrors(page)
  })
})
