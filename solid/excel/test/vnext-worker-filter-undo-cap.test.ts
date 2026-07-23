/**
 * Memory cap for the E8 whole-workbook FILTER undo snapshot
 * (`filtersSnapshot`) — WORKER path, real `createWorkerWorkbookSpreadsheetBackend`
 * + real transaction stack, focused in-memory client double.
 *
 * The filter snapshot carries every filtered sheet's `hiddenRows` array
 * (tens of thousands of ints on a heavily filtered big table). Unlike every
 * cell-image undo path it had NO byte/count cap: a `filter.set` record nulls
 * both cell images so no cell cap sees it, and on a structural record the
 * filter payload rides BESIDE a cell image the cell caps size independently.
 * `WORKER_FILTER_SNAPSHOT_MAX` bounds the summed hidden-row count per image;
 * over it the mutation still executes but its record degrades to not-undoable
 * (same contract as `WORKER_STRUCTURAL_SNAPSHOT_MAX`), never truncated.
 *
 * BOTH producers are pinned here:
 *  - `filter.set` record (cell images null) — `setFilterSortThroughWorker`,
 *  - structural side payload (filter beside a cell image) — a `deleteRows`
 *    on a sheet with an active filter, `recordStructuralMutation`.
 */

import { describe, expect, test } from '@jest/globals'
import type {
  CellRefWire,
  ColumnFilterRuleWire,
  FilterApplyResultWire,
  FilterSnapshotWire,
  SheetFilterStateWire,
  SparseCellWire,
  SparseRangeWire,
  WorkbookSheetMeta,
  WorkerWorkbookClient,
} from '../src-vnext/adapter'
import {
  WORKER_FILTER_SNAPSHOT_MAX,
  createWorkerWorkbookSpreadsheetBackend,
} from '../src-vnext/adapter'

const SHEET_ID = 'sheet-1'
const RULE: ColumnFilterRuleWire = { kind: 'equals', colIndex: 0, value: 'North' }

/**
 * Client double that returns exactly the RPC families both `filtersSnapshot`
 * producers touch. `applyFilter` commits `nextHiddenRows` VERBATIM (a real
 * engine derives it from a scan; the cap only cares about the array length,
 * so the double injects it directly instead of seeding tens of thousands of
 * rows). The cell-image RPCs return empty, keeping the structural cell image
 * trivially under `WORKER_STRUCTURAL_SNAPSHOT_MAX` so the FILTER payload is the
 * only thing that can push a structural record over a cap.
 */
type CapFakeClient = WorkerWorkbookClient & {
  setNextHiddenRows(rows: number[]): void
}

function createCapFakeClient(): CapFakeClient {
  const filtersBySheet = new Map<number, SheetFilterStateWire>()
  let nextHiddenRows: number[] = []

  function unused(name: string): never {
    throw new Error(`${name} is not used by the filter-undo-cap fake client`)
  }

  const partial: Partial<WorkerWorkbookClient> = {
    async initWorkbook(sheets = ['Sheet1']): Promise<WorkbookSheetMeta[]> {
      return sheets.map((name, idx) => ({ idx, name }))
    },
    async describeCapabilities() {
      // null → the backend treats every capability as supported, so the
      // `deleteRows` and `setFilterSort` ports are both live.
      return null
    },
    async sheetList(): Promise<WorkbookSheetMeta[]> {
      return [{ idx: 0, name: 'Sheet1' }]
    },
    async listNonEmpty(): Promise<CellRefWire[]> {
      return []
    },
    async snapshotRangeSparse(_range: SparseRangeWire): Promise<SparseCellWire[]> {
      return []
    },
    async deleteRows(): Promise<boolean> {
      return true
    },
    // Clear-then-restore replay of the (empty) structural cell image on undo.
    async clearRange(_range: SparseRangeWire): Promise<number> {
      return 0
    },
    async restoreSparse(cells: SparseCellWire[]): Promise<number> {
      return cells.length
    },
    async applyFilter(
      sheet: number,
      rules: readonly ColumnFilterRuleWire[],
    ): Promise<FilterApplyResultWire> {
      const hiddenRows = [...nextHiddenRows]
      filtersBySheet.set(sheet, { sheet, rules: rules.map((rule) => ({ ...rule })), hiddenRows })
      return { ok: true, hiddenRows, scannedRows: hiddenRows.length, predicateCells: 0 }
    },
    async clearFilter(sheet: number): Promise<FilterApplyResultWire> {
      filtersBySheet.delete(sheet)
      return { ok: true, hiddenRows: [], scannedRows: 0, predicateCells: 0 }
    },
    async snapshotFilters(): Promise<FilterSnapshotWire> {
      return {
        version: 1,
        filters: [...filtersBySheet.values()].map((entry) => ({
          sheet: entry.sheet,
          rules: entry.rules.map((rule) => ({ ...rule })),
          hiddenRows: [...entry.hiddenRows],
        })),
      }
    },
    async restoreFilters(snapshot: FilterSnapshotWire): Promise<number> {
      filtersBySheet.clear()
      for (const entry of snapshot.filters) {
        filtersBySheet.set(entry.sheet, {
          sheet: entry.sheet,
          rules: entry.rules.map((rule) => ({ ...rule })),
          hiddenRows: [...entry.hiddenRows],
        })
      }
      return snapshot.filters.length
    },
    onCellsDirty() {
      return () => {}
    },
    onCellsHydrated() {
      return () => {}
    },
    dispose() {},
  }

  const handler: ProxyHandler<Partial<WorkerWorkbookClient>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof WorkerWorkbookClient]
      if (prop === 'setNextHiddenRows') return undefined
      if (prop === 'then') return undefined
      return () => unused(prop)
    },
  }

  const client = new Proxy(partial, handler) as CapFakeClient
  return Object.assign(client, {
    setNextHiddenRows(rows: number[]) {
      nextHiddenRows = rows
    },
  })
}

function createCapBackend() {
  const client = createCapFakeClient()
  const backend = createWorkerWorkbookSpreadsheetBackend({ client, sheets: ['Sheet1'] })
  return { client, backend }
}

/** Ascending row indices 0..count-1 — a plausible heavily-filtered hidden set. */
function hiddenRange(count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => index)
}

let txSeq = 0
function undoRequest() {
  txSeq += 1
  return { kind: 'undo-transaction' as const, transactionId: `tx-${txSeq}`, requestId: txSeq }
}

describe('filter undo snapshot memory cap (WORKER_FILTER_SNAPSHOT_MAX)', () => {
  test('cap constant matches the 128 MiB / 200-image / 16 B-per-int derivation', () => {
    // 671 088 B per image / 16 B per int ≈ 41 943 → rounded down to 40 000.
    // A guard so a future edit that changes the constant re-derives it here.
    expect(WORKER_FILTER_SNAPSHOT_MAX).toBe(40000)
  })

  // ---- Path A: the `filter.set` record (both cell images null) --------------

  test('filter.set UNDER cap is recorded and undoable', async () => {
    const { client, backend } = createCapBackend()
    client.setNextHiddenRows(hiddenRange(5))

    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET_ID,
      rules: [RULE],
      recordHistory: true,
      requestId: 1,
    })
    // Recorded: the change is undoable.
    expect((ack as { historyRecorded?: boolean }).historyRecorded).toBe(true)

    const undo = await backend.undoTransaction!(undoRequest())
    expect(undo.applied).not.toBe(false)
    backend.dispose()
  })

  test('filter.set OVER cap still applies but degrades to not-undoable', async () => {
    const { client, backend } = createCapBackend()
    // One hidden row over the per-image cap.
    client.setNextHiddenRows(hiddenRange(WORKER_FILTER_SNAPSHOT_MAX + 1))

    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET_ID,
      rules: [RULE],
      recordHistory: true,
      requestId: 2,
    })
    // The filter APPLIED (hidden rows came back on the ACK) ...
    expect(ack.hiddenRowIndices).toHaveLength(WORKER_FILTER_SNAPSHOT_MAX + 1)
    // ... but the over-cap snapshot was NOT recorded — nothing to undo.
    expect((ack as { historyRecorded?: boolean }).historyRecorded).toBe(false)

    const undo = await backend.undoTransaction!(undoRequest())
    expect(undo.applied).toBe(false)
    backend.dispose()
  })

  // ---- Path B: the structural side payload (filter beside a cell image) ------

  test('structural delete on a filtered sheet UNDER cap is undoable', async () => {
    const { client, backend } = createCapBackend()
    // Arm the sheet's filter WITHOUT recording it (recordHistory omitted), so
    // `filterSortStateBySheetId` is set and the next structural op brackets the
    // engine filter with a `filtersSnapshot`.
    client.setNextHiddenRows(hiddenRange(5))
    await backend.setFilterSort!({ kind: 'set-filter-sort', sheetId: SHEET_ID, rules: [RULE] })

    await backend.deleteRows!({ kind: 'delete-rows', sheetId: SHEET_ID, rowIndex: 0, count: 1 })

    const undo = await backend.undoTransaction!(undoRequest())
    expect(undo.applied).not.toBe(false)
    backend.dispose()
  })

  test('structural delete on a filtered sheet OVER cap degrades the WHOLE record', async () => {
    const { client, backend } = createCapBackend()
    client.setNextHiddenRows(hiddenRange(WORKER_FILTER_SNAPSHOT_MAX + 1))
    await backend.setFilterSort!({ kind: 'set-filter-sort', sheetId: SHEET_ID, rules: [RULE] })

    // The delete executes (no throw) ...
    await backend.deleteRows!({ kind: 'delete-rows', sheetId: SHEET_ID, rowIndex: 0, count: 1 })

    // ... but the record degraded to not-undoable because the filter payload
    // blew the cap — the cell-image undo alone would strand the engine's
    // self-shifted filter, so the whole record is dropped, not just its filter
    // leg.
    const undo = await backend.undoTransaction!(undoRequest())
    expect(undo.applied).toBe(false)
    expect(undo.notAppliedReason).toContain(String(WORKER_FILTER_SNAPSHOT_MAX + 1))
    expect(undo.notAppliedReason).toContain('not undoable')
    backend.dispose()
  })
})
