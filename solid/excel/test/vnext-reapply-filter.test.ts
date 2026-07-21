/**
 * #27 — `Data → Reapply` end to end against the REAL static backend.
 *
 * The UI-core suite (`vanilla/spreadsheet-ui-core/test/reapply-filter.test.ts`)
 * pins the command with a fake host, so it can only prove that the atom
 * re-dispatches and re-commits. What it cannot prove is the thing the user
 * actually sees: that a cell edit under an active filter leaves the PROJECTION
 * unchanged, and that Reapply is what moves it. That needs a host that really
 * scans the column, which is what this file uses.
 *
 * Both directions are asserted every time, and the counter-example comes
 * first: a row that starts matching stays hidden until Reapply, and a row that
 * stops matching stays visible until Reapply. Delete the `setViewportFilter…`
 * commit inside `reapplyFilterAtom` and the second half of each test goes red;
 * make filtering live again (re-derive the set on `bumpRevision`) and the
 * first half does.
 */

import { describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  captureFilterSortCapabilityAtom,
  closeFilterDropdownAtom,
  createVisibleProjectionRequest,
  filterSortDraftAtom,
  getFilterHiddenRowsForSheet,
  historyStackAtom,
  openFilterDropdownAtom,
  reapplyFilterAtom,
  reapplyFilterDisabledReasonAtom,
  runFilterSortMutationAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  updateFilterSortDraftAtom,
  viewportFilterHiddenAtom,
} from '@einfach/spreadsheet-ui-core'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

const SHEET = 'sheet-1'
const WINDOW = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 }

function makeBackend() {
  return createStaticSpreadsheetBackend({
    revision: 1,
    matrix: [
      ['Region', 'Q1'],
      ['North', 80],
      ['South', 80],
      ['East', 200],
      ['West', 80],
    ],
  })
}

let requestId = 100

/** The regions the projection is currently painting, in row order. */
async function visibleRegions(backend: SpreadsheetBackend): Promise<string[]> {
  requestId += 1
  const projected = await backend.readVisibleProjection(
    createVisibleProjectionRequest({ sheetId: SHEET, requestId, window: WINDOW }),
  )
  return projected.cells
    .filter((cell) => cell.col === 0)
    .sort((left, right) => left.row - right.row)
    .map((cell) => String(cell.displayValue ?? ''))
}

/**
 * Apply `Q1 = 200` through the real dropdown path, then close it. Going
 * through `runFilterSortMutationAtom` rather than seeding the atoms directly
 * is the point: Apply and Reapply must land in the SAME sink, so the test
 * would catch a Reapply that wrote its own parallel state.
 */
async function applyFilter(store: ReturnType<typeof createStore>, backend: SpreadsheetBackend) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET })
  store.setter(selectionAtom, {
    kind: 'cell',
    sheetId: SHEET,
    anchor: { row: 1, col: 1 },
    focus: { row: 1, col: 1 },
  })
  store.setter(captureFilterSortCapabilityAtom, backend)
  store.setter(openFilterDropdownAtom, { sheetId: SHEET, colIndex: 1 })
  const draftSessionId = store.getter(filterSortDraftAtom).sessionId
  store.setter(updateFilterSortDraftAtom, {
    sessionId: draftSessionId,
    patch: { conditionKind: 'equals', equalsInput: '200' },
  })
  await store.setter(runFilterSortMutationAtom, {
    source: backend,
    sessionId: draftSessionId,
    intent: { kind: 'apply-draft' },
    refreshProjection: async () => undefined,
  })
  store.setter(closeFilterDropdownAtom)
}

function hiddenRows(store: ReturnType<typeof createStore>): readonly number[] {
  return getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), SHEET)
}

async function reapply(store: ReturnType<typeof createStore>, backend: SpreadsheetBackend) {
  await store.setter(reapplyFilterAtom, {
    source: backend,
    entrypoint: 'menu-bar',
    refreshProjection: async () => undefined,
  })
}

describe('Data -> Reapply on the static backend', () => {
  it('COUNTER-EXAMPLE: a row that starts matching stays hidden until Reapply', async () => {
    const backend = makeBackend()
    const store = createStore()
    await applyFilter(store, backend)

    expect(await visibleRegions(backend)).toEqual(['Region', 'East'])
    expect(hiddenRows(store)).toEqual([1, 2, 4])

    // North becomes 200 — it now satisfies the active rule.
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row: 1,
      col: 1,
      input: '200',
    })

    // Snapshot semantics, pinned: the row does NOT appear. This is the whole
    // reason Reapply has to exist, and it is a deliberate convergence on
    // Excel, whose filter results are equally stale until reapplied.
    expect(await visibleRegions(backend)).toEqual(['Region', 'East'])
    expect(hiddenRows(store)).toEqual([1, 2, 4])

    await reapply(store, backend)

    // Only now does the view catch up.
    expect(await visibleRegions(backend)).toEqual(['Region', 'North', 'East'])
    expect(hiddenRows(store)).toEqual([2, 4])
  })

  it('COUNTER-EXAMPLE: a row that stops matching stays visible until Reapply', async () => {
    const backend = makeBackend()
    const store = createStore()
    await applyFilter(store, backend)

    expect(await visibleRegions(backend)).toEqual(['Region', 'East'])

    // East drops to 80 — it no longer satisfies the rule.
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row: 3,
      col: 1,
      input: '80',
    })

    // Still painted, with its now-stale-looking value.
    expect(await visibleRegions(backend)).toEqual(['Region', 'East'])
    expect(hiddenRows(store)).toEqual([1, 2, 4])

    await reapply(store, backend)

    // Every data row fails the rule now, so only the header survives.
    expect(await visibleRegions(backend)).toEqual(['Region'])
    expect(hiddenRows(store)).toEqual([1, 2, 3, 4])
  })

  it('keeps surviving rows at their own index — Reapply never compacts', async () => {
    const backend = makeBackend()
    const store = createStore()
    await applyFilter(store, backend)

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row: 4,
      col: 1,
      input: '200',
    })
    await reapply(store, backend)

    requestId += 1
    const projected = await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: SHEET, requestId, window: WINDOW }),
    )
    const west = projected.cells.find((cell) => cell.displayValue === 'West')
    // Source row 4 stays at row 4. Compaction would report row 2.
    expect(west?.row).toBe(4)
    expect(projected.cells.some((cell) => cell.displayValue === 'South')).toBe(false)
  })

  it('is disabled before a filter exists and after it is cleared', async () => {
    const backend = makeBackend()
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: SHEET,
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    store.setter(captureFilterSortCapabilityAtom, backend)

    expect(store.getter(reapplyFilterDisabledReasonAtom)).not.toBeNull()

    await applyFilter(store, backend)
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBeNull()
  })

  it('adds no history entry, so Ctrl+Z after a Reapply is not about the filter', async () => {
    const backend = makeBackend()
    const store = createStore()
    await applyFilter(store, backend)
    const before = store.getter(historyStackAtom).entries.length

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row: 1,
      col: 1,
      input: '200',
    })
    await reapply(store, backend)

    expect(store.getter(historyStackAtom).entries).toHaveLength(before)
  })
})
