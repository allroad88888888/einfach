/**
 * #27 S4 — the pure derivation both adapters share
 * (`src-vnext/adapter/filter-hidden-rows.ts`), plus the tier-3 capability
 * witness. The tier-2 (old wasm-pkg) degradation is pinned end-to-end in
 * vnext-worker-filter-sort.test.tsx, where the client double lives.
 *
 * The derivation is deliberately the COMPLEMENT of the visibility permutation
 * rather than a second predicate pass: "hidden" means "scanned but not
 * displayed", which is unfalsifiable by construction and cannot drift from
 * what the projection shows. These tests pin the two things that reading is
 * sensitive to — the sparse-array holes and the scan extent — because getting
 * either wrong silently UNDER-reports hidden rows, and an under-reported set
 * makes SUBTOTAL quietly include a filtered-away row.
 */

import { describe, expect, it } from '@jest/globals'

import { buildFilterSortDisplayRows } from '@einfach/spreadsheet-ui-core'
import type { FilterSortState } from '@einfach/spreadsheet-ui-core'
import { filterHiddenRowsFromDisplayRows } from '../src-vnext/adapter/filter-hidden-rows'

describe('filterHiddenRowsFromDisplayRows', () => {
  it('reports the scanned rows the permutation does not display', () => {
    // Header 0 passes through; source rows 1 and 4 matched and compacted into
    // display slots 1 and 2; rows 2, 3, 5 were judged and dropped.
    const displayRows: number[] = []
    displayRows[0] = 0
    displayRows[1] = 1
    displayRows[2] = 4
    expect(filterHiddenRowsFromDisplayRows(displayRows, 6)).toEqual([2, 3, 5])
  })

  it('never reports a row the scan did not reach', () => {
    const displayRows: number[] = []
    displayRows[0] = 0
    displayRows[1] = 1
    // Extent is 3 rows, so row 3 and beyond were never judged by the
    // predicate and must not be declared hidden — the engine would exclude
    // rows the user never filtered.
    expect(filterHiddenRowsFromDisplayRows(displayRows, 3)).toEqual([2])
  })

  it('COUNTER-EXAMPLE: using the array length as the extent under-reports', () => {
    // The trap this helper's `scannedRowCount` parameter exists to avoid. The
    // permutation is COMPACTED, so its length is `matches + headers`, not the
    // scanned extent: rows filtered off the END leave no slot at all.
    const displayRows: number[] = []
    displayRows[0] = 0
    displayRows[1] = 1 // only source row 1 matched; rows 2..5 were dropped

    // The naive reading — extent = displayRows.length = 2 — finds nothing.
    expect(filterHiddenRowsFromDisplayRows(displayRows, displayRows.length)).toEqual([])
    // The correct extent finds every dropped row.
    expect(filterHiddenRowsFromDisplayRows(displayRows, 6)).toEqual([2, 3, 4, 5])
  })

  it('treats holes as hidden, not as row 0 (sparse-array trap)', () => {
    // `[...displayRows]` would yield `undefined` for holes and a naive
    // `Number(undefined)` coercion would fold them onto row 0, marking the
    // header hidden and every real dropped row visible.
    const displayRows: number[] = []
    displayRows[0] = 0
    displayRows[3] = 3
    expect(filterHiddenRowsFromDisplayRows(displayRows, 4)).toEqual([1, 2])
  })

  it('reports nothing when no filter is active, and tolerates an empty sheet', () => {
    expect(filterHiddenRowsFromDisplayRows(null, 10)).toEqual([])
    expect(filterHiddenRowsFromDisplayRows(undefined, 10)).toEqual([])
    expect(filterHiddenRowsFromDisplayRows([], 0)).toEqual([])
    // A header-only sheet: nothing was ever a data row.
    expect(filterHiddenRowsFromDisplayRows([0], 1)).toEqual([])
  })

  it('agrees with the shared permutation builder, including the summary row', () => {
    // Round-trip against the real builder rather than a hand-written array, so
    // the header pass-through and the summary-row pinning cannot drift.
    const values: Record<string, string> = {
      '0:0': 'Region',
      '1:0': 'North',
      '2:0': 'South',
      '3:0': 'North',
      '4:0': 'Total',
    }
    const state: FilterSortState = { rules: [{ kind: 'equals', colIndex: 0, value: 'North' }] }
    const displayRows = buildFilterSortDisplayRows(
      state,
      { headerRow: 0, startRow: 1, endRow: 5 },
      (row, col) => values[`${row}:${col}`] ?? '',
    )

    // Header (0) and the summary row (4) are pinned visible by the builder, so
    // only the genuinely unmatched data row is hidden.
    expect(filterHiddenRowsFromDisplayRows(displayRows, 5)).toEqual([2])
  })
})

describe('tier-3 degradation: the TS runtime (design §6.5)', () => {
  it('declares the family false so the adapter never sends the RPC', async () => {
    const { TS_WORKER_RUNTIME_CAPABILITIES } = await import(
      '../src-vnext/adapter/worker-runtime-ts'
    )
    // Fail-closed, never a fake ACK: the adapter reads this witness and skips
    // the push entirely, so the TS host keeps today's SUBTOTAL behaviour
    // instead of the adapter believing a push landed. The refusal side of the
    // same contract is pinned in vnext-worker-ts-failclosed.test.ts.
    expect(TS_WORKER_RUNTIME_CAPABILITIES.evalFilterHiddenRows).toBe(false)
    expect(Object.isFrozen(TS_WORKER_RUNTIME_CAPABILITIES)).toBe(true)
  })
})
