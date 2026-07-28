import { describe, expect, test } from '@jest/globals'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

/**
 * Excel-parity filter undo on the STATIC backend (2026-07-22). The worker
 * restores the engine's owned filter through `restoreFilters`; the static host
 * restores it from a reverse delta capturing the sheet's rules + derived hidden
 * set. Both report the same `historyRecorded` verdict so UI core pairs exactly
 * one history entry either way. These tests drive the concrete static backend's
 * transaction ports directly.
 */
const SHEET = 'sheet-1'

function seededBackend() {
  return createStaticSpreadsheetBackend({
    revision: 1,
    matrix: [
      ['Region', 'Qty'],
      ['North', '10'],
      ['South', '20'],
      ['North', '30'],
    ],
  })
}

type StaticBackend = ReturnType<typeof seededBackend>

let requestId = 1

const applyNorth = (backend: StaticBackend, recordHistory: boolean) =>
  backend.setFilterSort!({
    kind: 'set-filter-sort',
    sheetId: SHEET,
    rules: [{ kind: 'equals', colIndex: 0, value: 'North' }],
    requestId: requestId++,
    recordHistory,
  })

async function filterState(backend: StaticBackend) {
  const hidden = await backend.readSheetHiddenState!({
    kind: 'sheet-hidden-state',
    sheetId: SHEET,
  })
  return { rows: [...hidden.filterRows], ruleCount: hidden.filterRules.length }
}

const undo = (backend: StaticBackend) =>
  backend.undoTransaction!({
    kind: 'undo-transaction',
    transactionId: `tx-${requestId++}`,
    requestId: requestId++,
    revision: 1,
  })
const redo = (backend: StaticBackend) =>
  backend.redoTransaction!({
    kind: 'redo-transaction',
    transactionId: `tx-${requestId++}`,
    requestId: requestId++,
    revision: 1,
  })

describe('static backend: filter apply/clear is undoable (Excel parity)', () => {
  test('apply → undo removes the filter → redo restores it', async () => {
    const backend = seededBackend()

    const ack = await applyNorth(backend, true)
    expect((ack as { historyRecorded?: boolean }).historyRecorded).toBe(true)
    expect(await filterState(backend)).toEqual({ rows: [2], ruleCount: 1 })

    await undo(backend)
    expect(await filterState(backend)).toEqual({ rows: [], ruleCount: 0 })

    await redo(backend)
    expect(await filterState(backend)).toEqual({ rows: [2], ruleCount: 1 })
  })

  test('clear an active filter is undoable and redoable', async () => {
    const backend = seededBackend()
    await applyNorth(backend, true)

    const cleared = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [],
      requestId: requestId++,
      recordHistory: true,
    })
    expect((cleared as { historyRecorded?: boolean }).historyRecorded).toBe(true)
    expect(await filterState(backend)).toEqual({ rows: [], ruleCount: 0 })

    await undo(backend)
    expect(await filterState(backend)).toEqual({ rows: [2], ruleCount: 1 })

    await redo(backend)
    expect(await filterState(backend)).toEqual({ rows: [], ruleCount: 0 })
  })

  test('recordHistory:false and no-op apply record nothing', async () => {
    const backend = seededBackend()

    const notRecorded = await applyNorth(backend, false)
    expect((notRecorded as { historyRecorded?: boolean }).historyRecorded).toBeFalsy()
    // Nothing was recorded, so the static undo stack is empty and rejects.
    await expect(undo(backend)).rejects.toThrow()

    const backend2 = seededBackend()
    const noop = await backend2.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [],
      requestId: requestId++,
      recordHistory: true,
    })
    expect((noop as { historyRecorded?: boolean }).historyRecorded).toBeFalsy()
  })
})
