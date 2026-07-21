import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  FILTER_SORT_CAPABILITY_ERROR,
  FILTER_SORT_DROPDOWN_OPEN_ERROR,
  FILTER_SORT_PENDING_ERROR,
  FILTER_SORT_REAPPLY_NO_RULES_ERROR,
  FILTER_SORT_TARGET_ERROR,
  captureFilterSortCapabilityAtom,
  filterSortEntrypointStateAtom,
  filterSortStateAtom,
  getFilterHiddenRowsForSheet,
  historyStackAtom,
  openFilterDropdownAtom,
  reapplyFilterAtom,
  reapplyFilterDisabledReasonAtom,
  selectionAtom,
  setFilterSortAtom,
  setViewportFilterHiddenRowsAtom,
  setWorkspaceActiveSheetAtom,
  viewportFilterHiddenAtom,
} from '../src'
import type {
  ColumnFilterRule,
  FilterSortControllerPort,
  FilterSortMutationResult,
  SetFilterSortRequest,
} from '../src'

/**
 * `Data → Reapply` (Excel Ctrl+Alt+L), the explicit recompute that snapshot
 * filter semantics requires.
 *
 * Every assertion here is DIFFERENTIAL, never tautological. The pivot is the
 * `hidden` variable on the fake host: it stands for "what the whole-column
 * scan would answer about the CURRENT data". Moving it simulates the user
 * editing a cell. The counter-example half of each test then pins that moving
 * it changes NOTHING on its own — no scan, no atom write, no repaint — which
 * is the #27 design intent (`design-filter-hidden-rows` §4.3), and only the
 * Reapply half moves the view. Both directions are asserted, so an
 * implementation that made filtering live again would fail the first half and
 * an implementation that made Reapply a no-op would fail the second.
 */

function makeStore() {
  return createStore()
}

function setActiveCell(
  store: ReturnType<typeof makeStore>,
  sheetId: string,
  row: number,
  col: number,
) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: 'cell',
    sheetId,
    anchor: { row, col },
    focus: { row, col },
  })
}

const RULES: readonly ColumnFilterRule[] = Object.freeze([
  Object.freeze({ kind: 'equals', colIndex: 0, value: 'Alpha' }) as ColumnFilterRule,
])

interface FakeHost {
  readonly port: FilterSortControllerPort
  readonly calls: SetFilterSortRequest[]
  /** The answer the whole-column scan would give for the data as it stands. */
  hidden: number[]
  /** Drop `hiddenRowIndices` from the ACK (host cannot compute visibility). */
  omitHidden: boolean
  /** Return an ACK that does not match the request. */
  mismatch: boolean
}

function makeHost(initialHidden: number[]): FakeHost {
  const host: FakeHost = {
    calls: [],
    hidden: [...initialHidden],
    omitHidden: false,
    mismatch: false,
    port: {
      async setFilterSort(request: SetFilterSortRequest): Promise<FilterSortMutationResult> {
        host.calls.push(request)
        if (host.mismatch) return { sheetId: 'other-sheet', requestId: request.requestId }
        const result: FilterSortMutationResult = {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: host.calls.length,
        }
        return host.omitHidden ? result : { ...result, hiddenRowIndices: [...host.hidden] }
      },
    },
  }
  return host
}

/**
 * Bring the store to the post-apply state the dropdown leaves behind: rules
 * committed, hidden set committed, capability witnessed, cursor on the sheet.
 * Deliberately NOT routed through `runFilterSortMutationAtom` — Reapply must
 * work off committed state alone, not off a live dropdown session.
 */
function seedAppliedFilter(
  store: ReturnType<typeof makeStore>,
  host: FakeHost,
  sheetId = 'sheet-1',
) {
  store.setter(captureFilterSortCapabilityAtom, host.port)
  setActiveCell(store, sheetId, 1, 0)
  store.setter(setFilterSortAtom, { sheetId, state: { rules: RULES } })
  store.setter(setViewportFilterHiddenRowsAtom, { sheetId, rows: [...host.hidden] })
}

function hiddenRows(store: ReturnType<typeof makeStore>, sheetId = 'sheet-1'): readonly number[] {
  return getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), sheetId)
}

const noRefresh = async () => undefined

describe('reapplyFilterDisabledReasonAtom', () => {
  test('is disabled with no active filter, and only then becomes enabled', () => {
    const store = makeStore()
    const host = makeHost([2])
    store.setter(captureFilterSortCapabilityAtom, host.port)
    setActiveCell(store, 'sheet-1', 1, 0)

    // Counter-example: capability present, cursor placed, lane free — the
    // ONLY thing missing is a filter to re-run.
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_REAPPLY_NO_RULES_ERROR)

    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBeNull()
  })

  test('an empty rule list is not an active filter', () => {
    const store = makeStore()
    const host = makeHost([])
    store.setter(captureFilterSortCapabilityAtom, host.port)
    setActiveCell(store, 'sheet-1', 1, 0)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: [] } })

    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_REAPPLY_NO_RULES_ERROR)
  })

  test('is per sheet: rules on another sheet do not enable it here', () => {
    const store = makeStore()
    const host = makeHost([2])
    store.setter(captureFilterSortCapabilityAtom, host.port)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })

    setActiveCell(store, 'sheet-2', 1, 0)
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_REAPPLY_NO_RULES_ERROR)

    setActiveCell(store, 'sheet-1', 1, 0)
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBeNull()
  })

  test('is disabled without a setFilterSort port', () => {
    const store = makeStore()
    store.setter(captureFilterSortCapabilityAtom, {})
    setActiveCell(store, 'sheet-1', 1, 0)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })

    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_CAPABILITY_ERROR)
  })

  test('is disabled with no active sheet', () => {
    const store = makeStore()
    const host = makeHost([2])
    store.setter(captureFilterSortCapabilityAtom, host.port)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })

    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_TARGET_ERROR)
  })

  test('is disabled while the column dropdown owns the lane', () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBeNull()

    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_DROPDOWN_OPEN_ERROR)
  })

  test('is disabled while a reapply is already in flight', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)

    const running = store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })
    await Promise.resolve()

    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBe(FILTER_SORT_PENDING_ERROR)
    await running
    expect(store.getter(reapplyFilterDisabledReasonAtom)).toBeNull()
  })
})

describe('reapplyFilterAtom', () => {
  test('COUNTER-EXAMPLE: data changing does not move the view; only Reapply does', async () => {
    const store = makeStore()
    // Rows 1 and 2 currently fail the rule and are withheld.
    const host = makeHost([1, 2])
    seedAppliedFilter(store, host)
    expect(hiddenRows(store)).toEqual([1, 2])

    // The user edits row 2 so it now MATCHES the rule. The host's scan would
    // answer [1] from here on. Nothing else happens.
    host.hidden = [1]

    // Design intent, pinned: the view has NOT moved. No scan was run and the
    // snapshot still withholds row 2. This half fails the moment filtering
    // becomes live again.
    expect(host.calls).toHaveLength(0)
    expect(hiddenRows(store)).toEqual([1, 2])

    // Now the escape hatch.
    const refreshed: string[] = []
    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: async (sheetId) => {
        refreshed.push(sheetId)
      },
    })

    // Exactly one scan, carrying the ALREADY COMMITTED rules verbatim...
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]).toMatchObject({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: RULES,
    })
    // ...and the view caught up: row 2 is painted again.
    expect(hiddenRows(store)).toEqual([1])
    expect(refreshed).toEqual(['sheet-1'])
  })

  test('COUNTER-EXAMPLE: a row that stops matching stays visible until Reapply', async () => {
    const store = makeStore()
    const host = makeHost([1])
    seedAppliedFilter(store, host)

    // The mirror case: the user edits row 3 so it no longer matches.
    host.hidden = [1, 3]
    expect(hiddenRows(store)).toEqual([1])
    expect(host.calls).toHaveLength(0)

    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(hiddenRows(store)).toEqual([1, 3])
  })

  test('never changes the committed rules — it only re-answers them', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)
    const before = store.getter(filterSortStateAtom)['sheet-1']

    host.hidden = [4]
    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual(before?.rules)
    expect(hiddenRows(store)).toEqual([4])
  })

  test('records NO history entry — Reapply is not an undo step', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)
    const before = store.getter(historyStackAtom)

    host.hidden = [3]
    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    // Applying a filter records nothing either; a Reapply entry would be an
    // undo step whose counterpart the stack never got.
    expect(store.getter(historyStackAtom).entries).toEqual(before.entries)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('is inert with no active filter: no scan, no state written', async () => {
    const store = makeStore()
    const host = makeHost([2])
    store.setter(captureFilterSortCapabilityAtom, host.port)
    setActiveCell(store, 'sheet-1', 1, 0)
    const entrypointBefore = store.getter(filterSortEntrypointStateAtom)

    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(host.calls).toHaveLength(0)
    // Pre-flight rejections write no shared state, so an inert Ctrl+Alt+L
    // cannot stomp the toolbar's filter/sort status.
    expect(store.getter(filterSortEntrypointStateAtom)).toEqual(entrypointBefore)
  })

  test('is inert without a setFilterSort port', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)

    await store.setter(reapplyFilterAtom, {
      source: {},
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(host.calls).toHaveLength(0)
    expect(hiddenRows(store)).toEqual([2])
  })

  test('is inert while the column dropdown owns the lane', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(host.calls).toHaveLength(0)
  })

  test('a same-tick double dispatch scans once', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host)
    const input = {
      source: host.port,
      entrypoint: 'menu-bar' as const,
      refreshProjection: noRefresh,
    }

    const first = store.setter(reapplyFilterAtom, input)
    const second = store.setter(reapplyFilterAtom, input)
    await Promise.all([first, second])

    expect(host.calls).toHaveLength(1)
  })

  test('a mismatched acknowledgement leaves the snapshot untouched', async () => {
    const store = makeStore()
    const host = makeHost([1, 2])
    seedAppliedFilter(store, host)
    host.hidden = [5]
    host.mismatch = true

    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(host.calls).toHaveLength(1)
    // Stale beats wrong: an unmatched ACK is not evidence about any sheet.
    expect(hiddenRows(store)).toEqual([1, 2])
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
  })

  test('a rejected transport leaves the snapshot untouched', async () => {
    const store = makeStore()
    const host = makeHost([1, 2])
    seedAppliedFilter(store, host)
    const failing: FilterSortControllerPort = {
      async setFilterSort() {
        throw new Error('transport down')
      },
    }

    await store.setter(reapplyFilterAtom, {
      source: failing,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(hiddenRows(store)).toEqual([1, 2])
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
  })

  test('an ACK without hiddenRowIndices clears the set, never keeps a stale one', async () => {
    const store = makeStore()
    const host = makeHost([1, 2])
    seedAppliedFilter(store, host)
    host.omitHidden = true

    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    // Same degradation as the dropdown path: "rules recorded, nothing hidden".
    expect(hiddenRows(store)).toEqual([])
  })

  test('a refresh failure is reported without losing the committed snapshot', async () => {
    const store = makeStore()
    const host = makeHost([1])
    seedAppliedFilter(store, host)
    host.hidden = [1, 3]

    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: async () => {
        throw new Error('projection down')
      },
    })

    expect(hiddenRows(store)).toEqual([1, 3])
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed')
  })

  test('only the active sheet is reapplied', async () => {
    const store = makeStore()
    const host = makeHost([2])
    seedAppliedFilter(store, host, 'sheet-1')
    store.setter(setFilterSortAtom, { sheetId: 'sheet-2', state: { rules: RULES } })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-2', rows: [7] })

    host.hidden = [4]
    await store.setter(reapplyFilterAtom, {
      source: host.port,
      entrypoint: 'menu-bar',
      refreshProjection: noRefresh,
    })

    expect(host.calls.map((call) => call.sheetId)).toEqual(['sheet-1'])
    expect(hiddenRows(store, 'sheet-1')).toEqual([4])
    expect(hiddenRows(store, 'sheet-2')).toEqual([7])
  })
})
