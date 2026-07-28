import { describe, expect, test } from '@jest/globals'
import type { Store } from '@einfach/core'
import { createStore } from '@einfach/core'
import {
  beginProjectionAtom,
  buildSortExcludedRows,
  filterSortStateAtom,
  getFilterHiddenRowsForSheet,
  pushHistoryAtom,
  reconcileFilterSortRulesFromEngineAtom,
  setViewportFilterHiddenRowsAtom,
  viewportFilterHiddenAtom,
  type CellRange,
} from '@einfach/spreadsheet-ui-core'

import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'
import { dispatchRedo, dispatchUndo } from '../src-vnext/provider/history-dispatch'
import { runVisibleProjectionTransport } from '../src-vnext/provider/projection-refresh'

/**
 * Cross-sheet filter undo/redo (bug 2026-07-22). The provider's post-undo
 * filter-cache reconcile (`history-dispatch.ts`) used to read the ACTIVE
 * projection sheet, not the sheet the undone/redone entry belongs to. So a
 * filter applied on sheet A, then Ctrl+Z while VIEWING sheet B, cleared A's
 * ENGINE filter (the whole-workbook REPLACE flips exactly the entry's sheet)
 * but left A's UI-core render caches pinned to a ghost filter that never
 * re-synced — `buildSortExcludedRows(A)` kept pinning rows the engine no longer
 * filters, and switching back to A still painted the stale set.
 *
 * These drive the REAL provider dispatchers against the concrete static
 * two-sheet backend (its `undoTransaction`/`redoTransaction` reverse the filter
 * delta and its `readSheetHiddenState` reports the restored authoritative set,
 * exactly like the worker's `restoreFilters` + `readSheetHiddenStateThroughWorker`).
 */
const SHEET_A = 'sheet-1'
const SHEET_B = 'sheet-2'
const NORTH_RULE = { kind: 'equals', colIndex: 0, value: 'North' } as const
// Covers source rows 0..3; the 'South' row (source row 2) is the one the North
// filter hides.
const SORT_RANGE: CellRange = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 }

function twoSheetBackend() {
  return createStaticSpreadsheetBackend({
    revision: 1,
    sheets: ['Sheet1', 'Sheet2'],
    matrix: [
      ['Region', 'Qty'],
      ['North', '10'],
      ['South', '20'],
      ['North', '30'],
    ],
  })
}

type StaticBackend = ReturnType<typeof twoSheetBackend>

let requestSeq = 1

/** Establish the active visible projection on `sheetId`, the real begin→resolve lane. */
async function activateSheet(store: Store, backend: StaticBackend, sheetId: string): Promise<void> {
  const begin = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId,
    window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 },
    reason: 'test',
    retainResult: true,
  })
  if (begin.status !== 'started' || begin.request.kind !== 'visible-window') {
    throw new Error(`activate ${sheetId} failed: ${begin.status}`)
  }
  await runVisibleProjectionTransport(store, backend, begin.request)
}

async function engineFilterRows(backend: StaticBackend, sheetId: string): Promise<number[]> {
  const state = await backend.readSheetHiddenState!({ kind: 'sheet-hidden-state', sheetId })
  return [...state.filterRows]
}

function uiFilterRows(store: Store, sheetId: string): number[] {
  return getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), sheetId)
}

/**
 * Apply the North filter on `sheetId` through the backend (records the undoable
 * transaction + hides the engine row), then mirror the apply-time reconcile the
 * provider performs while that sheet is active: seed the UI-core render caches
 * and push the paired `filter.set` history entry.
 */
async function applyFilterAndRecord(
  store: Store,
  backend: StaticBackend,
  sheetId: string,
): Promise<void> {
  const ack = await backend.setFilterSort!({
    kind: 'set-filter-sort',
    sheetId,
    rules: [NORTH_RULE],
    requestId: requestSeq++,
    recordHistory: true,
  })
  expect((ack as { historyRecorded?: boolean }).historyRecorded).toBe(true)

  const applied = await backend.readSheetHiddenState!({ kind: 'sheet-hidden-state', sheetId })
  store.setter(setViewportFilterHiddenRowsAtom, { sheetId, rows: [...applied.filterRows] })
  store.setter(reconcileFilterSortRulesFromEngineAtom, { sheetId, rules: [...applied.filterRules] })
  store.setter(pushHistoryAtom, {
    transactionId: `tx-filter-${sheetId}-${requestSeq++}`,
    kind: 'filter.set',
    sheetId,
    projectionRevision: applied.revision ?? 1,
  })
}

describe('cross-sheet filter undo/redo reconciles the entry sheet, not the active sheet', () => {
  test('UNDO of an off-screen sheet filter clears that sheet ghost cache', async () => {
    const backend = twoSheetBackend()
    const store = createStore()

    await activateSheet(store, backend, SHEET_A)
    await applyFilterAndRecord(store, backend, SHEET_A)

    // Precondition: A carries an active filter (engine + UI-core caches agree).
    expect(await engineFilterRows(backend, SHEET_A)).toEqual([2])
    expect(uiFilterRows(store, SHEET_A)).toEqual([2])
    expect(buildSortExcludedRows(store.getter, SHEET_A, SORT_RANGE)).toEqual([2])

    // Switch the view to B, THEN Ctrl+Z.
    await activateSheet(store, backend, SHEET_B)
    expect(await dispatchUndo(store, backend)).toBe(true)

    // The engine cleared A's filter (whole-workbook REPLACE flipped A).
    expect(await engineFilterRows(backend, SHEET_A)).toEqual([])

    // A's UI-core caches must follow the engine even though B is active.
    // Pre-fix the reconcile read the ACTIVE sheet (B) and left A pinned to [2].
    expect(uiFilterRows(store, SHEET_A)).toEqual([])
    expect(store.getter(filterSortStateAtom)[SHEET_A]).toBeUndefined()
    expect(buildSortExcludedRows(store.getter, SHEET_A, SORT_RANGE)).toEqual([])
  })

  test('REDO of a filter cleared by undo restores the off-screen sheet cache', async () => {
    const backend = twoSheetBackend()
    const store = createStore()

    await activateSheet(store, backend, SHEET_A)
    await applyFilterAndRecord(store, backend, SHEET_A)

    // Undo while A is still active — both pre- and post-fix clear A correctly
    // here (the active sheet IS the entry sheet), so the redo assertion below
    // is the only thing under test.
    expect(await dispatchUndo(store, backend)).toBe(true)
    expect(await engineFilterRows(backend, SHEET_A)).toEqual([])
    expect(uiFilterRows(store, SHEET_A)).toEqual([])

    // Switch the view to B, THEN Ctrl+Y.
    await activateSheet(store, backend, SHEET_B)
    expect(await dispatchRedo(store, backend)).toBe(true)

    // The engine re-applied A's filter.
    expect(await engineFilterRows(backend, SHEET_A)).toEqual([2])

    // A's UI-core caches must follow even though B is active. Pre-fix the
    // reconcile read B and left A ghost-ABSENT at [].
    expect(uiFilterRows(store, SHEET_A)).toEqual([2])
    expect(store.getter(filterSortStateAtom)[SHEET_A]?.rules).toHaveLength(1)
    expect(buildSortExcludedRows(store.getter, SHEET_A, SORT_RANGE)).toEqual([2])
  })
})
