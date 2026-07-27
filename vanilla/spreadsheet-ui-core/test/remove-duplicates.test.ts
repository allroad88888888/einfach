import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { Store } from '@einfach/core'
import type {
  DisplayCell,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../src/backend/types'
import { contentMutationLastBlockAtom } from '../src/editing/mutation-gateway'
import {
  acquireHistoryProducerReservationAtom,
  historyStackAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
  type HistoryProducerReservation,
} from '../src/history'
import { setSheetProtectionAtom } from '../src/protection'
import { selectionAtom } from '../src/selection'
import type { CellRange } from '../src/shared'
import {
  getFilterHiddenRowsForSheet,
  setViewportFilterHiddenRowsAtom,
  viewportFilterHiddenAtom,
} from '../src/viewport/effective-hidden'
import {
  applyViewportFreezeStructuralShiftAtom,
  setFreezeConfigAtom,
  viewportFreezeAtom,
} from '../src/viewport/freeze'
import { hideRowsAtom, viewportHiddenAtom } from '../src/viewport/hidden'
import {
  setWorkspaceActiveSheetAtom,
  workspaceActiveSheetAuthorityWitnessAtom,
} from '../src/workspace'
import {
  closeRemoveDuplicatesAtom,
  DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS,
  dispatchRemoveDuplicatesIntentAtom,
  findDuplicateRows,
  nextRemoveDuplicatesMutationRequestId,
  nextRemoveDuplicatesReadRequestId,
  nextRemoveDuplicatesSessionId,
  openRemoveDuplicatesFromSelectionAtom,
  REMOVE_DUPLICATES_HISTORY_BUSY_ERROR,
  removeDuplicatesCanCloseAtom,
  removeDuplicatesCanConfirmAtom,
  removeDuplicatesComparisonAtom,
  removeDuplicatesErrorAtom,
  removeDuplicatesExcludeHeaderAtom,
  removeDuplicatesKeyColumnsAtom,
  removeDuplicatesLifecycleAtom,
  removeDuplicatesMutationRequestIdAtom,
  removeDuplicatesMutationTargetAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesPreviewAtom,
  removeDuplicatesReadRequestIdAtom,
  removeDuplicatesSessionAtom,
  removeDuplicatesSessionIdAtom,
  retryRemoveDuplicatesReadAtom,
  runRemoveDuplicatesConfirmAtom,
  type OpenRemoveDuplicatesInput,
  type RemoveDuplicatesControllerPort,
  type RemoveDuplicatesRange,
  type RemoveRowsExactRequest,
  type RemoveRowsExactResult,
  type RunRemoveDuplicatesConfirmInput,
} from '../src/remove-duplicates'

function cell(
  row: number,
  col: number,
  value: string,
  kind: DisplayCell['valueKind'] = 'string',
): DisplayCell {
  return { row, col, displayValue: value, valueKind: kind }
}

function range(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): RemoveDuplicatesRange {
  return { startRow, startCol, endRow, endCol }
}

describe('findDuplicateRows', () => {
  test('3 unique rows produce 0 duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'header-a'),
      cell(0, 1, 'header-b'),
      cell(1, 0, 'apple'),
      cell(1, 1, '1'),
      cell(2, 0, 'banana'),
      cell(2, 1, '2'),
      cell(3, 0, 'cherry'),
      cell(3, 1, '3'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 1),
      keyColumns: new Set([0, 1]),
    })
    expect(result.duplicateRows).toEqual([])
    expect(result.scannedRows).toBe(3)
    expect(result.uniqueRows).toBe(3)
    expect(result.headerRow).toBe(0)
  })

  test('3 identical rows mark rows 2 and 3 (header excluded)', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'h'),
      cell(1, 0, 'x'),
      cell(2, 0, 'x'),
      cell(3, 0, 'x'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 0),
      keyColumns: new Set([0]),
    })
    expect(result.duplicateRows).toEqual([2, 3])
    expect(result.scannedRows).toBe(3)
    expect(result.uniqueRows).toBe(1)
  })

  test('multi-column key: same in col A but different in col B is NOT a duplicate', () => {
    const cells: DisplayCell[] = [
      cell(1, 0, 'foo'),
      cell(1, 1, 'one'),
      cell(2, 0, 'foo'),
      cell(2, 1, 'two'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 1),
      keyColumns: new Set([0, 1]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([])
  })

  test('multi-column key: same in selected cols but different in unselected col IS a duplicate', () => {
    const cells: DisplayCell[] = [
      cell(1, 0, 'foo'),
      cell(1, 1, 'differs-A'),
      cell(1, 2, 'shared'),
      cell(2, 0, 'foo'),
      cell(2, 1, 'differs-B'),
      cell(2, 2, 'shared'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 2),
      keyColumns: new Set([0, 2]), // col 1 (the differing one) is unchecked
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([2])
  })

  test('excludeHeader=true: header row 0 always survives even when it duplicates a data row', () => {
    const cells: DisplayCell[] = [cell(0, 0, 'same'), cell(1, 0, 'same'), cell(2, 0, 'same')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: true,
    })
    expect(result.duplicateRows).toEqual([2])
    expect(result.headerRow).toBe(0)
  })

  test('excludeHeader=false: header is treated as a data row', () => {
    const cells: DisplayCell[] = [cell(0, 0, 'same'), cell(1, 0, 'same'), cell(2, 0, 'same')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([1, 2])
    expect(result.headerRow).toBeNull()
    expect(result.scannedRows).toBe(3)
  })

  test('comparison=exact: "foo" vs "Foo" are NOT duplicates', () => {
    const cells: DisplayCell[] = [cell(0, 0, 'foo'), cell(1, 0, 'Foo')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'exact',
    })
    expect(result.duplicateRows).toEqual([])
  })

  test('comparison=caseInsensitive: "foo" vs "Foo" ARE duplicates', () => {
    const cells: DisplayCell[] = [cell(0, 0, 'foo'), cell(1, 0, 'Foo')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'caseInsensitive',
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('comparison=trim: " x" vs "x " ARE duplicates', () => {
    const cells: DisplayCell[] = [cell(0, 0, ' x'), cell(1, 0, 'x ')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'trim',
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('comparison=trimAndIgnoreCase: " Foo " vs "foo" ARE duplicates', () => {
    const cells: DisplayCell[] = [cell(0, 0, ' Foo '), cell(1, 0, 'foo')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'trimAndIgnoreCase',
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('two rows that are blank in every key column ARE duplicates of each other', () => {
    const cells: DisplayCell[] = [
      // header
      cell(0, 0, 'A'),
      cell(0, 1, 'B'),
      // rows 1 and 2 have nothing in col 0 or 1
      cell(1, 2, 'side-data-1'),
      cell(2, 2, 'side-data-2'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 2, 1),
      keyColumns: new Set([0, 1]),
    })
    expect(result.duplicateRows).toEqual([2])
    expect(result.scannedRows).toBe(2)
    expect(result.uniqueRows).toBe(1)
  })

  test('sparse projection: missing cells default to blank for tuple purposes', () => {
    const cells: DisplayCell[] = [
      // header
      cell(0, 0, 'h0'),
      cell(0, 1, 'h1'),
      // row 1: only col 0 present
      cell(1, 0, 'shared'),
      // row 2: only col 0 present, same value
      cell(2, 0, 'shared'),
      // row 3: col 0 same, col 1 differs (now present)
      cell(3, 0, 'shared'),
      cell(3, 1, 'diff'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 1),
      keyColumns: new Set([0, 1]),
    })
    // rows 1 and 2 share (shared, ''); row 3 is (shared, diff) — unique.
    expect(result.duplicateRows).toEqual([2])
  })

  test('key column outside [startCol..endCol] is reported in ignoredColumns', () => {
    const cells: DisplayCell[] = [cell(1, 0, 'a'), cell(2, 0, 'a')]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 0),
      // col 5 is outside the range — should land in ignoredColumns.
      keyColumns: new Set([0, 5]),
      excludeHeader: false,
    })
    expect(result.ignoredColumns).toEqual([5])
    expect(result.duplicateRows).toEqual([2])
  })

  test('empty range (startRow > endRow) returns scannedRows=0 with no throw', () => {
    const result = findDuplicateRows({
      cells: [],
      range: range(5, 0, 4, 0),
      keyColumns: new Set([0]),
    })
    expect(result.scannedRows).toBe(0)
    expect(result.duplicateRows).toEqual([])
    expect(result.uniqueRows).toBe(0)
    expect(result.headerRow).toBeNull()
  })

  test('single row (after header exclusion) yields zero duplicates', () => {
    const cells: DisplayCell[] = [cell(0, 0, 'header'), cell(1, 0, 'only-data')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
    })
    expect(result.scannedRows).toBe(1)
    expect(result.duplicateRows).toEqual([])
  })

  test('empty keyColumns returns noKeyColumns:true without throwing', () => {
    const result = findDuplicateRows({
      cells: [],
      range: range(0, 0, 1, 0),
      keyColumns: new Set<number>(),
    })
    expect(result.noKeyColumns).toBe(true)
    expect(result.duplicateRows).toEqual([])
    expect(result.scannedRows).toBe(0)
    expect(result.uniqueRows).toBe(0)
  })

  test('keyColumns entirely out of range returns noKeyColumns:true and reports ignoredColumns', () => {
    const result = findDuplicateRows({
      cells: [cell(1, 0, 'a'), cell(2, 0, 'a')],
      range: range(1, 0, 2, 0),
      // all key columns sit outside [0..0]
      keyColumns: new Set([5, 7]),
      excludeHeader: false,
    })
    expect(result.noKeyColumns).toBe(true)
    expect(result.ignoredColumns).toEqual([5, 7])
    expect(result.duplicateRows).toEqual([])
  })

  test('tuple key: identical cell containing U+001F across both rows IS a duplicate', () => {
    const cells: DisplayCell[] = [cell(0, 0, 'a\x1Fb'), cell(1, 0, 'a\x1Fb')]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('tuple key: row with single-cell "a\\x1Fb" is NOT a duplicate of row with two cells ["a","b"]', () => {
    // This was the regression in the U+001F-separator scheme: the
    // single-column row produced "a\x1Fb" and the two-column row also
    // produced "a\x1Fb", spuriously colliding. Length-prefixing makes
    // these distinguishable ("3:a\x1Fb" vs "1:a|1:b").
    const cells: DisplayCell[] = [
      // row 0: single key column 0, value contains U+001F
      cell(0, 0, 'a\x1Fb'),
      // row 1: two key columns, 'a' and 'b'
      cell(1, 0, 'a'),
      cell(1, 1, 'b'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 1),
      keyColumns: new Set([0, 1]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([])
  })

  test('tuple key: newlines, null bytes, and surrogate-pair emoji do not produce false collisions', () => {
    const cells: DisplayCell[] = [
      // row 0: ['a\nb', 'c']
      cell(0, 0, 'a\nb'),
      cell(0, 1, 'c'),
      // row 1: ['a', 'b\nc']  — same chars merged differently
      cell(1, 0, 'a'),
      cell(1, 1, 'b\nc'),
      // row 2: ['a\0b', '']
      cell(2, 0, 'a\x00b'),
      // row 3: ['a', '\0b']   — same chars but split
      cell(3, 0, 'a'),
      cell(3, 1, '\x00b'),
      // row 4 & 5: identical emoji surrogate pair → duplicate of each other.
      cell(4, 0, 'x'),
      cell(4, 1, '😀'),
      cell(5, 0, 'x'),
      cell(5, 1, '😀'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 5, 1),
      keyColumns: new Set([0, 1]),
      excludeHeader: false,
    })
    // Only row 5 collides with row 4.
    expect(result.duplicateRows).toEqual([5])
  })

  test('filter-active projection: duplicateRows carries the source row it scanned', () => {
    // A filter hid rows 1 and 2, so they contribute no cell and never reach
    // the scan. What survives keeps its own index (#27 — hidden, not
    // compacted), so the duplicate index IS the source row backend.removeRows
    // must delete. Under the retired compaction the same projection would
    // have reported visual row 2 for a source row 3.
    const cells: DisplayCell[] = [
      cell(0, 0, 'header'),
      cell(3, 0, 'shared'),
      cell(4, 0, 'unique'),
      cell(5, 0, 'shared'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 5, 0),
      keyColumns: new Set([0]),
      hiddenRows: [1, 2],
    })
    expect(result.duplicateRows).toEqual([5])
    // The hidden rows were skipped outright, not scanned as all-blank tuples.
    expect(result.scannedRows).toBe(3)
  })

  test('blank-kind cell normalises to empty string regardless of displayValue', () => {
    const cells: DisplayCell[] = [cell(1, 0, '', 'blank'), cell(2, 0, 'leftover-text', 'blank')]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([2])
  })
})

const SHEET_ID = 'sheet-1'
const SELECTION_RANGE = {
  rowStart: 0,
  rowEnd: 4,
  colStart: 0,
  colEnd: 1,
} as const

const SESSION_CELLS: DisplayCell[] = [
  cell(0, 0, 'Region'),
  cell(0, 1, 'Score'),
  cell(1, 0, 'North'),
  cell(1, 1, '100'),
  cell(2, 0, 'South'),
  cell(2, 1, '200'),
  cell(3, 0, 'North'),
  cell(3, 1, '300'),
  cell(4, 0, 'East'),
  cell(4, 1, '400'),
]

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (reason: unknown) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function seedSelection(store: Store, sheetId = SHEET_ID): void {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId,
    anchor: { row: SELECTION_RANGE.rowStart, col: SELECTION_RANGE.colStart },
    focus: { row: SELECTION_RANGE.rowEnd, col: SELECTION_RANGE.colEnd },
  })
}

function rangeAcknowledgement(
  request: RangeProjectionRequest,
  cells: readonly DisplayCell[] = SESSION_CELLS,
  revision: number | string = 1,
): RangeProjectionResult {
  return {
    kind: 'range',
    requestId: request.requestId,
    sheetId: request.sheetId,
    range: request.range,
    revision,
    cells: Array.from(cells),
  }
}

function mutationAcknowledgement(
  request: RemoveRowsExactRequest,
  revision: number | string = 2,
): RemoveRowsExactResult {
  return {
    requestId: request.requestId,
    sheetId: request.sheetId,
    targetRange: request.targetRange,
    removedRowIndices: Array.from(request.rows),
    removedRows: request.rows.length,
    affectedRange:
      request.rows.length === 0
        ? null
        : {
            startRow: request.rows[0],
            endRow: request.targetRange.rowEnd,
            startCol: request.targetRange.colStart,
            endCol: request.targetRange.colEnd,
          },
    revision,
  }
}

async function hydrate(store: Store, source: RemoveDuplicatesControllerPort): Promise<number> {
  seedSelection(store)
  await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
    'editing',
  )
  const session = store.getter(removeDuplicatesSessionAtom)
  expect(session).not.toBeNull()
  return session!.sessionId
}

function selectRegionColumnOnly(store: Store): void {
  expect(
    store.setter(dispatchRemoveDuplicatesIntentAtom, {
      kind: 'toggle-key-column',
      column: 1,
    }),
  ).toBe(true)
  expect(store.getter(removeDuplicatesPreviewAtom)?.duplicateRows).toEqual([3])
}

function expectHistoryLaneAvailable(store: Store): void {
  const reservation = store.setter(acquireHistoryProducerReservationAtom)
  expect(reservation).not.toBeNull()
  if (reservation === null) throw new Error('expected history producer reservation')
  expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
}

describe('remove-duplicates Core lifecycle', () => {
  test('initial state is closed and public projections have no preview', () => {
    const store = createStore()
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expect(store.getter(removeDuplicatesPreviewAtom)).toBeNull()
    expect(store.getter(removeDuplicatesCanConfirmAtom)).toBe(false)
  })

  test('source-only open publishes a read ticket before transport and accepts an exact empty projection', async () => {
    const store = createStore()
    seedSelection(store)
    const read = deferred<RangeProjectionResult>()
    let captured: RangeProjectionRequest | undefined
    const source: RemoveDuplicatesControllerPort = {
      readRangeProjection(request) {
        captured = request
        return read.promise
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }

    const opening = store.setter(openRemoveDuplicatesFromSelectionAtom, { source })
    expect(store.getter(removeDuplicatesLifecycleAtom)).toMatchObject({
      status: 'read-pending',
      sessionId: 1,
      readRequestId: 1,
      sheetId: SHEET_ID,
    })
    expect(captured).toBeUndefined()
    await Promise.resolve()
    expect(captured).toBeDefined()
    read.resolve(rangeAcknowledgement(captured!, []))
    await expect(opening).resolves.toBe('editing')

    const session = store.getter(removeDuplicatesSessionAtom)!
    expect(session.cells).toEqual([])
    expect(Object.isFrozen(session)).toBe(true)
    expect(Object.isFrozen(session.range)).toBe(true)
    expect(Object.isFrozen(session.cells)).toBe(true)
    const columns = store.getter(removeDuplicatesKeyColumnsAtom)
    expect(Array.from(columns)).toEqual([0, 1])
    expect(Object.isFrozen(columns)).toBe(true)
    expect((columns as unknown as { add?: unknown }).add).toBeUndefined()
  })

  test(
    'captures read input and source ports exactly once, preserving receiver and frozen request',
    async () => {
    const store = createStore()
    seedSelection(store)
    const reads = new Map<string, number>()
    const count: (key: string) => void = (key) => reads.set(key, (reads.get(key) ?? 0) + 1)
    const source: RemoveDuplicatesControllerPort = {} as RemoveDuplicatesControllerPort
    const execute: NonNullable<RemoveDuplicatesControllerPort['readRangeProjection']> = function (
      this: RemoveDuplicatesControllerPort,
      request,
    ) {
      expect(this).toBe(source)
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.range)).toBe(true)
      expect(request).toMatchObject({
        kind: 'range',
        sheetId: SHEET_ID,
        range: SELECTION_RANGE,
        reason: 'selection',
      })
      return Promise.resolve(rangeAcknowledgement(request))
    }
    Object.defineProperties(source, {
      readRangeProjection: {
        get() {
          count('source.readRangeProjection')
          return execute
        },
      },
      removeRowsExact: {
        get() {
          count('source.removeRowsExact')
          return undefined
        },
      },
    })
    const input = Object.defineProperties(
      {},
      {
        source: {
          get() {
            count('input.source')
            return source
          },
        },
        sheetId: {
          get() {
            count('input.sheetId')
            return SHEET_ID
          },
        },
        timeoutMs: {
          get() {
            count('input.timeoutMs')
            return 1234
          },
        },
      },
    ) as OpenRemoveDuplicatesInput

    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, input)).resolves.toBe(
      'editing',
    )

    for (const key of [
      'input.source',
      'input.sheetId',
      'input.timeoutMs',
      'source.readRangeProjection',
      'source.removeRowsExact',
    ]) {
      expect(reads.get(key)).toBe(1)
    }
  })

  test.each(['source', 'sheetId', 'timeoutMs', 'readRangeProjection', 'removeRowsExact'] as const)(
    'a throwing read capture getter for %s fails closed before transport',
    async (field) => {
      const store = createStore()
      seedSelection(store)
      const transport = jest.fn(async (request: RangeProjectionRequest) =>
        rangeAcknowledgement(request),
      )
      const source = new Proxy<RemoveDuplicatesControllerPort>(
        { readRangeProjection: transport },
        {
          get(target, property, receiver) {
            if (property === field) throw new Error(`hostile ${field} getter`)
            return Reflect.get(target, property, receiver)
          },
        },
      )
      const input = new Proxy<OpenRemoveDuplicatesInput>(
        { source, sheetId: SHEET_ID, timeoutMs: 25 },
        {
          get(target, property, receiver) {
            if (property === field) throw new Error(`hostile ${field} getter`)
            return Reflect.get(target, property, receiver)
          },
        },
      )

      await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, input)).resolves.toBe(
        'failed',
      )

      expect(transport).not.toHaveBeenCalled()
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
      expect(store.getter(removeDuplicatesReadRequestIdAtom)).toBe(0)
    },
  )

  test(
    'read input getter re-entry gives the published inner owner precedence without outer clobber',
    async () => {
    const store = createStore()
    seedSelection(store)
    const innerTransport = jest.fn(async (request: RangeProjectionRequest) =>
      rangeAcknowledgement(request),
    )
    const outerTransport = jest.fn(async (request: RangeProjectionRequest) =>
      rangeAcknowledgement(request),
    )
    const innerSource: RemoveDuplicatesControllerPort = {
      readRangeProjection: innerTransport,
    }
    const outerSource: RemoveDuplicatesControllerPort = {
      readRangeProjection: outerTransport,
    }
    let innerOpening: Promise<unknown> | undefined
    let sourceReads = 0
    const outerInput = Object.defineProperties(
      {},
      {
        source: {
          get() {
            sourceReads += 1
            innerOpening = store.setter(openRemoveDuplicatesFromSelectionAtom, {
              source: innerSource,
            })
            return outerSource
          },
        },
      },
    ) as OpenRemoveDuplicatesInput

    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, outerInput)).resolves.toBe(
      'blocked',
    )
    expect(innerOpening).toBeDefined()
    await expect(innerOpening!).resolves.toBe('editing')

    expect(sourceReads).toBe(1)
    expect(innerTransport).toHaveBeenCalledTimes(1)
    expect(outerTransport).not.toHaveBeenCalled()
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
    expect(store.getter(removeDuplicatesErrorAtom)).toBe('')
  })

  test('read timeout clears its ticket and ignores a late exact acknowledgement', async () => {
    jest.useFakeTimers()
    try {
      const store = createStore()
      seedSelection(store)
      const read = deferred<RangeProjectionResult>()
      let request!: RangeProjectionRequest
      const opening = store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: {
          readRangeProjection(nextRequest) {
            request = nextRequest
            return read.promise
          },
        },
        timeoutMs: 25,
      })
      await Promise.resolve()
      expect(request).toBeDefined()

      jest.advanceTimersByTime(25)
      await expect(opening).resolves.toBe('failed')
      const lifecycleAfterTimeout = store.getter(removeDuplicatesLifecycleAtom)
      const errorAfterTimeout = store.getter(removeDuplicatesErrorAtom)
      expect(lifecycleAfterTimeout.status).toBe('read-failed')
      expect(errorAfterTimeout).toContain('timed out')

      read.resolve(rangeAcknowledgement(request))
      await Promise.resolve()
      await Promise.resolve()

      expect(store.getter(removeDuplicatesLifecycleAtom)).toBe(lifecycleAfterTimeout)
      expect(store.getter(removeDuplicatesErrorAtom)).toBe(errorAfterTimeout)
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  test('accepts a matching optional legacy sheet witness without using it as authority', async () => {
    const store = createStore()
    seedSelection(store)
    let captured: RangeProjectionRequest | undefined
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        captured = request
        return rangeAcknowledgement(request)
      },
    }

    await expect(
      store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source,
        sheetId: SHEET_ID,
      }),
    ).resolves.toBe('editing')

    expect(captured?.sheetId).toBe(SHEET_ID)
    expect(store.getter(removeDuplicatesSessionAtom)?.sheetId).toBe(SHEET_ID)
  })

  test('accepts an exact sparse projection without requiring rectangular cell coverage', async () => {
    const store = createStore()
    seedSelection(store)
    const sparseCells = [cell(0, 0, 'Region'), cell(1, 0, 'North'), cell(3, 1, '300')]

    await expect(
      store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: {
          async readRangeProjection(request) {
            return rangeAcknowledgement(request, sparseCells)
          },
        },
      }),
    ).resolves.toBe('editing')

    expect(store.getter(removeDuplicatesSessionAtom)?.cells).toEqual(sparseCells)
  })

  test(
    'snapshots a hostile stateful projection graph exactly ' +
      'once and stores only detached functional fields',
    async () => {
    const store = createStore()
    seedSelection(store)
    const reads = new Map<string, number>()
    const tracked = <Value extends object>(value: Value, prefix: string): Value =>
      new Proxy(value, {
        get(target, property, receiver) {
          if (typeof property === 'string' && property !== 'then') {
            if (property === 'formula') {
              throw new Error('non-functional cell fields must not be read')
            }
            const key = `${prefix}.${property}`
            const count = (reads.get(key) ?? 0) + 1
            reads.set(key, count)
            if (count > 1) throw new Error(`${key} was read more than once`)
          }
          return Reflect.get(target, property, receiver)
        },
      })
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        const cells = tracked(
          [
            tracked(
              {
                row: 0,
                col: 0,
                displayValue: 'Region',
                valueKind: 'string' as const,
                formula: '=SHOULD_NOT_BE_READ()',
              },
              'cell[0]',
            ),
            tracked(
              {
                row: 1,
                col: 0,
                displayValue: 'North',
                valueKind: undefined,
              },
              'cell[1]',
            ),
          ],
          'cells',
        )
        return tracked(
          {
            kind: 'range' as const,
            requestId: request.requestId,
            sheetId: request.sheetId,
            range: tracked({ ...request.range }, 'range'),
            revision: 'opaque-r1',
            truncated: false,
            cells,
          },
          'acknowledgement',
        )
      },
    }

    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
      'editing',
    )

    const session = store.getter(removeDuplicatesSessionAtom)
    expect(session).not.toBeNull()
    expect(session?.projectionRevision).toBe('opaque-r1')
    expect(session?.cells).toEqual([
      { row: 0, col: 0, displayValue: 'Region', valueKind: 'string' },
      { row: 1, col: 0, displayValue: 'North' },
    ])
    expect(Object.isFrozen(session?.cells)).toBe(true)
    expect(Object.isFrozen(session?.cells[0])).toBe(true)
    expect('formula' in session!.cells[0]).toBe(false)
    expect(store.getter(removeDuplicatesPreviewAtom)).not.toBeNull()

    for (const field of [
      'kind',
      'requestId',
      'sheetId',
      'range',
      'revision',
      'truncated',
      'cells',
    ]) {
      expect(reads.get(`acknowledgement.${field}`)).toBe(1)
    }
    for (const field of ['rowStart', 'rowEnd', 'colStart', 'colEnd']) {
      expect(reads.get(`range.${field}`)).toBe(1)
    }
    expect(reads.get('cells.length')).toBe(1)
    for (const index of [0, 1]) {
      expect(reads.get(`cells.${index}`)).toBe(1)
      for (const field of ['row', 'col', 'displayValue', 'valueKind']) {
        expect(reads.get(`cell[${index}].${field}`)).toBe(1)
      }
    }
    expect(reads.get('cell[0].formula')).toBeUndefined()
  })

  test(
    'snapshots the first value from a stateful acknowledgement accessor exactly once',
    async () => {
    const store = createStore()
    seedSelection(store)
    let revisionReads = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return {
          ...rangeAcknowledgement(request, []),
          get revision() {
            revisionReads += 1
            return revisionReads === 1 ? 'first-revision' : 'changed-revision'
          },
        }
      },
    }

    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
      'editing',
    )

    expect(revisionReads).toBe(1)
    expect(store.getter(removeDuplicatesSessionAtom)?.projectionRevision).toBe('first-revision')
  })

  test(
    'a hostile read acknowledgement getter cannot clobber a replacement read owner',
    async () => {
    const store = createStore()
    seedSelection(store)
    const replacementTransport = jest.fn(async (request: RangeProjectionRequest) =>
      rangeAcknowledgement(request, [], 'replacement-revision'),
    )
    let replacementOpening: Promise<unknown> | undefined
    let revisionReads = 0
    const firstSource: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return {
          ...rangeAcknowledgement(request, []),
          get revision() {
            revisionReads += 1
            expect(store.setter(closeRemoveDuplicatesAtom)).toBe(true)
            replacementOpening = store.setter(openRemoveDuplicatesFromSelectionAtom, {
              source: { readRangeProjection: replacementTransport },
            })
            return 'superseded-revision'
          },
        }
      },
    }

    await expect(
      store.setter(openRemoveDuplicatesFromSelectionAtom, { source: firstSource }),
    ).resolves.toBe('stale')
    expect(replacementOpening).toBeDefined()
    await expect(replacementOpening!).resolves.toBe('editing')

    expect(revisionReads).toBe(1)
    expect(replacementTransport).toHaveBeenCalledTimes(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
    expect(store.getter(removeDuplicatesSessionAtom)?.projectionRevision).toBe(
      'replacement-revision',
    )
    expect(store.getter(removeDuplicatesErrorAtom)).toBe('')
  })

  test.each(['optional-sheet-witness', 'selection-sheet', 'workspace-sheet'] as const)(
    'rejects mismatched %s authority before launching a read transport',
    async (mismatch) => {
      const store = createStore()
      seedSelection(store)
      if (mismatch === 'selection-sheet') {
        store.setter(selectionAtom, {
          kind: 'range',
          sheetId: 'sheet-2',
          anchor: { row: SELECTION_RANGE.rowStart, col: SELECTION_RANGE.colStart },
          focus: { row: SELECTION_RANGE.rowEnd, col: SELECTION_RANGE.colEnd },
        })
      }
      if (mismatch === 'workspace-sheet') {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
      }
      const readRangeProjection = jest.fn(async (request: RangeProjectionRequest) =>
        rangeAcknowledgement(request),
      )
      const source = { readRangeProjection }
      const input =
        mismatch === 'optional-sheet-witness' ? { source, sheetId: 'sheet-2' } : { source }

      await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, input)).resolves.toBe(
        'failed',
      )

      expect(readRangeProjection).not.toHaveBeenCalled()
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
    },
  )

  test.each([
    {
      name: 'duplicate visual coordinate',
      cells: [...SESSION_CELLS, cell(1, 0, 'duplicate-coordinate')],
    },
    {
      name: 'row outside the requested range',
      cells: [cell(SELECTION_RANGE.rowEnd + 1, 0, 'outside')],
    },
    {
      name: 'column outside the requested range',
      cells: [cell(0, SELECTION_RANGE.colEnd + 1, 'outside')],
    },
    {
      name: 'unsupported valueKind',
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'invalid-kind',
          valueKind: 'date',
        } as unknown as DisplayCell,
      ],
    },
  ])('rejects a malformed projection with $name', async ({ cells }) => {
    const store = createStore()
    seedSelection(store)

    await expect(
      store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: {
          async readRangeProjection(request) {
            return rangeAcknowledgement(request, cells)
          },
        },
      }),
    ).resolves.toBe('failed')

    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
    expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
  })

  test('structural failure wins over a simultaneous request identity mismatch', async () => {
    const store = createStore()
    seedSelection(store)

    await expect(
      store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: {
          async readRangeProjection(request) {
            return {
              ...rangeAcknowledgement(request, [cell(0, 0, 'first'), cell(0, 0, 'duplicate')]),
              requestId: request.requestId + 1,
            }
          },
        },
      }),
    ).resolves.toBe('failed')

    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
    expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
  })

  test.each([
    {
      name: 'request identity',
      change: (result: RangeProjectionResult): RangeProjectionResult => ({
        ...result,
        requestId: result.requestId + 1,
      }),
    },
    {
      name: 'sheet identity',
      change: (result: RangeProjectionResult): RangeProjectionResult => ({
        ...result,
        sheetId: 'sheet-2',
      }),
    },
    {
      name: 'exact range',
      change: (result: RangeProjectionResult): RangeProjectionResult => ({
        ...result,
        range: { ...result.range, rowStart: result.range.rowStart + 1 },
      }),
    },
  ])('classifies a valid $name mismatch as stale', async ({ change }) => {
    const store = createStore()
    seedSelection(store)

    await expect(
      store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: {
          async readRangeProjection(request) {
            return change(rangeAcknowledgement(request))
          },
        },
      }),
    ).resolves.toBe('stale')

    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-stale')
    expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
  })

  test.each(['top-level revision', 'range rowStart', 'cells length', 'cell displayValue'] as const)(
    'a throwing caller-owned %s getter fails closed without leaking the exception',
    async (throwAt) => {
      const store = createStore()
      seedSelection(store)
      const throwOn = <Value extends object>(value: Value, propertyToThrow: PropertyKey): Value =>
        new Proxy(value, {
          get(target, property, receiver) {
            if (property === propertyToThrow) throw new Error(`hostile ${String(property)} getter`)
            return Reflect.get(target, property, receiver)
          },
        })
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          const rangeValue =
            throwAt === 'range rowStart'
              ? throwOn({ ...request.range }, 'rowStart')
              : { ...request.range }
          const cellValue =
            throwAt === 'cell displayValue'
              ? throwOn(cell(0, 0, 'Region'), 'displayValue')
              : cell(0, 0, 'Region')
          const cellsValue =
            throwAt === 'cells length' ? throwOn([cellValue], 'length') : [cellValue]
          const result = {
            kind: 'range' as const,
            requestId: request.requestId,
            sheetId: request.sheetId,
            range: rangeValue,
            revision: 1,
            truncated: false,
            cells: cellsValue,
          }
          return (
            throwAt === 'top-level revision' ? throwOn(result, 'revision') : result
          ) as RangeProjectionResult
        },
      }

      await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
        'failed',
      )
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
      expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
      expect(store.getter(removeDuplicatesErrorAtom)).toBe(
        'Remove Duplicates could not load a complete projection for the selected range.',
      )
    },
  )

  test('selection drift makes a late exact read stale and close invalidates late responses', async () => {
    const store = createStore()
    seedSelection(store)
    const firstRead = deferred<RangeProjectionResult>()
    let firstRequest!: RangeProjectionRequest
    const firstSource: RemoveDuplicatesControllerPort = {
      readRangeProjection(request) {
        firstRequest = request
        return firstRead.promise
      },
    }
    const firstOpen = store.setter(openRemoveDuplicatesFromSelectionAtom, {
      source: firstSource,
    })
    await Promise.resolve()
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: SHEET_ID,
      anchor: { row: 1, col: 0 },
      focus: { row: 4, col: 1 },
    })
    firstRead.resolve(rangeAcknowledgement(firstRequest))
    await expect(firstOpen).resolves.toBe('stale')
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-stale')

    seedSelection(store)
    const lateRead = deferred<RangeProjectionResult>()
    let lateRequest!: RangeProjectionRequest
    const lateOpen = store.setter(retryRemoveDuplicatesReadAtom, {
      source: {
        readRangeProjection(request) {
          lateRequest = request
          return lateRead.promise
        },
      },
    })
    await Promise.resolve()
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(true)
    lateRead.resolve(rangeAcknowledgement(lateRequest))
    await expect(lateOpen).resolves.toBe('stale')
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
  })

  test.each(['selection-range', 'workspace-sheet'] as const)(
    'transport rejection after %s authority drift is stale, not failed',
    async (drift) => {
      const store = createStore()
      seedSelection(store)
      const read = deferred<RangeProjectionResult>()
      const opening = store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: {
          readRangeProjection() {
            return read.promise
          },
        },
      })
      await Promise.resolve()

      if (drift === 'selection-range') {
        store.setter(selectionAtom, {
          kind: 'range',
          sheetId: SHEET_ID,
          anchor: { row: 1, col: 0 },
          focus: { row: 4, col: 1 },
        })
      } else {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
      }
      read.reject(new Error('transport disconnected'))

      await expect(opening).resolves.toBe('stale')
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-stale')
      expect(store.getter(removeDuplicatesErrorAtom)).toBe(
        'The selected range changed while Remove Duplicates was loading. Retry from the current selection.',
      )
    },
  )

  test('truncated source-only read fails; source-only retry allocates fresh identities', async () => {
    const store = createStore()
    seedSelection(store)
    let attempts = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        attempts += 1
        return {
          ...rangeAcknowledgement(request),
          truncated: attempts === 1,
        }
      },
    }
    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
      'failed',
    )
    const firstSessionId = store.getter(removeDuplicatesSessionIdAtom)
    const firstReadId = store.getter(removeDuplicatesReadRequestIdAtom)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
    expect(store.getter(removeDuplicatesErrorAtom)).not.toBe('')

    await expect(store.setter(retryRemoveDuplicatesReadAtom, { source })).resolves.toBe('editing')
    expect(store.getter(removeDuplicatesSessionIdAtom)).toBe(firstSessionId + 1)
    expect(store.getter(removeDuplicatesReadRequestIdAtom)).toBe(firstReadId + 1)
    expect(attempts).toBe(2)
  })

  test.each([null, 0, 'false', Object.freeze({})])(
    'non-boolean truncated=%p is malformed and fails the read',
    async (truncated) => {
      const store = createStore()
      seedSelection(store)
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return {
            ...rangeAcknowledgement(request),
            truncated,
          } as unknown as RangeProjectionResult
        },
      }

      await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
        'failed',
      )
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
    },
  )

  test('identity helpers cross MAX_SAFE once, descend, and exhaust without reuse', () => {
    for (const next of [
      nextRemoveDuplicatesSessionId,
      nextRemoveDuplicatesReadRequestId,
      nextRemoveDuplicatesMutationRequestId,
    ]) {
      expect(next(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
      expect(next(Number.MAX_SAFE_INTEGER)).toBe(-1)
      expect(next(-1)).toBe(-2)
      expect(next(Number.MIN_SAFE_INTEGER)).toBeNull()
      expect(next(Number.NaN)).toBeNull()
    }
  })

  test('session and request sequences are isolated per store', async () => {
    const left = createStore()
    const right = createStore()
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
    }
    await hydrate(left, source)
    await hydrate(right, source)
    expect(left.getter(removeDuplicatesSessionIdAtom)).toBe(1)
    expect(right.getter(removeDuplicatesSessionIdAtom)).toBe(1)
    expect(left.getter(removeDuplicatesReadRequestIdAtom)).toBe(1)
    expect(right.getter(removeDuplicatesReadRequestIdAtom)).toBe(1)
  })

  test('typed intents own form changes and runtime projections remain immutable', async () => {
    const store = createStore()
    await hydrate(store, {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
    })
    expect(
      store.setter(dispatchRemoveDuplicatesIntentAtom, {
        kind: 'set-comparison',
        comparison: 'trimAndIgnoreCase',
      }),
    ).toBe(true)
    expect(
      store.setter(dispatchRemoveDuplicatesIntentAtom, {
        kind: 'set-exclude-header',
        excludeHeader: false,
      }),
    ).toBe(true)
    expect(store.getter(removeDuplicatesComparisonAtom)).toBe('trimAndIgnoreCase')
    expect(store.getter(removeDuplicatesExcludeHeaderAtom)).toBe(false)
    const preview = store.getter(removeDuplicatesPreviewAtom)!
    expect(Object.isFrozen(preview)).toBe(true)
    expect(Object.isFrozen(preview.duplicateRows)).toBe(true)
  })

  test('workspace A→B→A after hydration revokes the session before confirm transport', async () => {
    const store = createStore()
    const removeRowsExact = jest.fn(async (request: RemoveRowsExactRequest) =>
      mutationAcknowledgement(request),
    )
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      removeRowsExact,
    }
    const sessionId = await hydrate(store, source)
    const session = store.getter(removeDuplicatesSessionAtom)!
    expect(session.workspaceActiveSheetWitness).toBe(
      store.getter(workspaceActiveSheetAuthorityWitnessAtom),
    )
    selectRegionColumnOnly(store)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET_ID })

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('stale')

    expect(removeRowsExact).not.toHaveBeenCalled()
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-stale')
  })

  test(
    'captures confirm input and mutation port exactly once, preserving receiver and frozen request',
    async () => {
    const store = createStore()
    const hydrationSource: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, hydrationSource)
    selectRegionColumnOnly(store)
    const reads = new Map<string, number>()
    const count: (key: string) => void = (key) => reads.set(key, (reads.get(key) ?? 0) + 1)
    const source: RemoveDuplicatesControllerPort = {} as RemoveDuplicatesControllerPort
    const execute: NonNullable<RemoveDuplicatesControllerPort['removeRowsExact']> = function (
      this: RemoveDuplicatesControllerPort,
      request,
    ) {
      expect(this).toBe(source)
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.targetRange)).toBe(true)
      expect(Object.isFrozen(request.rows)).toBe(true)
      expect(request).toMatchObject({
        kind: 'remove-rows',
        sheetId: SHEET_ID,
        targetRange: SELECTION_RANGE,
        rows: [3],
        revision: 1,
      })
      return Promise.resolve(mutationAcknowledgement(request))
    }
    Object.defineProperties(source, {
      readRangeProjection: {
        get() {
          count('source.readRangeProjection')
          throw new Error('confirm must not observe the read port')
        },
      },
      removeRowsExact: {
        get() {
          count('source.removeRowsExact')
          return execute
        },
      },
    })
    const refreshProjection = function (this: undefined, sheetId: string): Promise<void> {
      expect(this).toBeUndefined()
      expect(sheetId).toBe(SHEET_ID)
      return Promise.resolve()
    }
    const input = Object.defineProperties(
      {},
      {
        source: {
          get() {
            count('input.source')
            return source
          },
        },
        sessionId: {
          get() {
            count('input.sessionId')
            return sessionId
          },
        },
        refreshProjection: {
          get() {
            count('input.refreshProjection')
            return refreshProjection
          },
        },
        timeoutMs: {
          get() {
            count('input.timeoutMs')
            return 1234
          },
        },
      },
    ) as RunRemoveDuplicatesConfirmInput

    await expect(store.setter(runRemoveDuplicatesConfirmAtom, input)).resolves.toBe('completed')

    for (const key of [
      'input.source',
      'input.sessionId',
      'input.refreshProjection',
      'input.timeoutMs',
      'source.removeRowsExact',
    ]) {
      expect(reads.get(key)).toBe(1)
    }
    expect(reads.get('source.readRangeProjection')).toBeUndefined()
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)
  })

  test.each(['source', 'sessionId', 'refreshProjection', 'timeoutMs', 'removeRowsExact'] as const)(
    'a throwing confirm capture getter for %s blocks before reservation or transport',
    async (field) => {
      const store = createStore()
      const hydrationSource: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request)
        },
        async removeRowsExact(request) {
          return mutationAcknowledgement(request)
        },
      }
      const sessionId = await hydrate(store, hydrationSource)
      selectRegionColumnOnly(store)
      const transport = jest.fn(async (request: RemoveRowsExactRequest) =>
        mutationAcknowledgement(request),
      )
      const source = new Proxy<RemoveDuplicatesControllerPort>(
        { removeRowsExact: transport },
        {
          get(target, property, receiver) {
            if (property === field) throw new Error(`hostile ${field} getter`)
            return Reflect.get(target, property, receiver)
          },
        },
      )
      const input = new Proxy<RunRemoveDuplicatesConfirmInput>(
        {
          source,
          sessionId,
          refreshProjection: async () => undefined,
          timeoutMs: 25,
        },
        {
          get(target, property, receiver) {
            if (property === field) throw new Error(`hostile ${field} getter`)
            return Reflect.get(target, property, receiver)
          },
        },
      )

      await expect(store.setter(runRemoveDuplicatesConfirmAtom, input)).resolves.toBe('blocked')

      expect(transport).not.toHaveBeenCalled()
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
      expect(store.getter(removeDuplicatesMutationTargetAtom)).toBeNull()
      expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(0)
      expectHistoryLaneAvailable(store)
    },
  )

  test(
    'confirm input getter re-entry lets one owner reserve and send without outer clobber',
    async () => {
    const store = createStore()
    const hydrationSource: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, hydrationSource)
    selectRegionColumnOnly(store)
    const innerTransport = jest.fn(async (request: RemoveRowsExactRequest) =>
      mutationAcknowledgement(request),
    )
    const outerTransport = jest.fn(async (request: RemoveRowsExactRequest) =>
      mutationAcknowledgement(request),
    )
    const innerRefresh = jest.fn(async () => undefined)
    const outerRefresh = jest.fn(async () => undefined)
    const innerSource: RemoveDuplicatesControllerPort = { removeRowsExact: innerTransport }
    const outerSource: RemoveDuplicatesControllerPort = { removeRowsExact: outerTransport }
    let innerConfirmation: Promise<unknown> | undefined
    let sourceReads = 0
    const outerInput: RunRemoveDuplicatesConfirmInput = {
      get source() {
        sourceReads += 1
        innerConfirmation = store.setter(runRemoveDuplicatesConfirmAtom, {
          source: innerSource,
          sessionId,
          refreshProjection: innerRefresh,
        })
        return outerSource
      },
      sessionId,
      refreshProjection: outerRefresh,
    }

    await expect(store.setter(runRemoveDuplicatesConfirmAtom, outerInput)).resolves.toBe('stale')
    expect(innerConfirmation).toBeDefined()
    await expect(innerConfirmation!).resolves.toBe('completed')

    expect(sourceReads).toBe(1)
    expect(innerTransport).toHaveBeenCalledTimes(1)
    expect(innerRefresh).toHaveBeenCalledTimes(1)
    expect(outerTransport).not.toHaveBeenCalled()
    expect(outerRefresh).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expect(store.getter(removeDuplicatesErrorAtom)).toBe('')
    expectHistoryLaneAvailable(store)
  })

  test('a foreign history producer blocks before ticket publication or transport', async () => {
    const store = createStore()
    const removeRowsExact = jest.fn(async (request: RemoveRowsExactRequest) =>
      mutationAcknowledgement(request),
    )
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      removeRowsExact,
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const externalReservation = store.setter(acquireHistoryProducerReservationAtom)
    if (externalReservation === null) throw new Error('expected external reservation')

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('blocked')

    expect(removeRowsExact).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(removeDuplicatesMutationTargetAtom)).toBeNull()
    expect(store.getter(removeDuplicatesErrorAtom)).toBe(REMOVE_DUPLICATES_HISTORY_BUSY_ERROR)
    expect(store.setter(releaseHistoryProducerReservationAtom, externalReservation)).toBe(true)
  })

  test(
    'authority drift after ticket publication releases before transport and leaves no ticket',
    async () => {
    const store = createStore()
    const removeRowsExact = jest.fn(async (request: RemoveRowsExactRequest) =>
      mutationAcknowledgement(request),
    )
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      removeRowsExact,
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)

    const outcome = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: async () => undefined,
    })
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('mutation-pending')
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: SHEET_ID,
      anchor: { row: 9, col: 9 },
      focus: { row: 9, col: 9 },
    })

    await expect(outcome).resolves.toBe('stale')
    expect(removeRowsExact).not.toHaveBeenCalled()
    expect(store.getter(removeDuplicatesMutationTargetAtom)).toBeNull()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('pre-transport authority drift retains the ticket when exact release fails', async () => {
    const store = createStore()
    const removeRowsExact = jest.fn(async (request: RemoveRowsExactRequest) =>
      mutationAcknowledgement(request),
    )
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      removeRowsExact,
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const releaseHistoryReservationWrite = releaseHistoryProducerReservationAtom.write
    releaseHistoryProducerReservationAtom.write = () => false
    try {
      const outcome = store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => undefined,
      })
      store.setter(selectionAtom, {
        kind: 'cell',
        sheetId: SHEET_ID,
        anchor: { row: 9, col: 9 },
        focus: { row: 9, col: 9 },
      })
      await expect(outcome).resolves.toBe('outcome-unknown')
    } finally {
      releaseHistoryProducerReservationAtom.write = releaseHistoryReservationWrite
    }

    expect(removeRowsExact).not.toHaveBeenCalled()
    expect(store.getter(removeDuplicatesMutationTargetAtom)).not.toBeNull()
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test.each([
    {
      protection: 'fully locked',
      unlockedRanges: [] as CellRange[],
    },
    {
      protection: 'partially unlocked',
      unlockedRanges: [{ rowStart: 3, rowEnd: 3, colStart: 0, colEnd: 1 }],
    },
  ])(
    'a $protection target is gateway-blocked with zero producer-side effects',
    async ({ unlockedRanges }) => {
      const store = createStore()
      const removeRowsExact = jest.fn(async (request: RemoveRowsExactRequest) =>
        mutationAcknowledgement(request),
      )
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request)
        },
        removeRowsExact,
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)
      store.setter(setSheetProtectionAtom, {
        sheetId: SHEET_ID,
        state: { mode: 'protected', unlockedRanges },
      })
      const requestSequenceBefore = store.getter(removeDuplicatesMutationRequestIdAtom)
      const freezeBefore = store.getter(viewportFreezeAtom)
      const hiddenBefore = store.getter(viewportHiddenAtom)
      const filterHiddenBefore = store.getter(viewportFilterHiddenAtom)

      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('blocked')

      expect(removeRowsExact).not.toHaveBeenCalled()
      expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(requestSequenceBefore)
      expect(store.getter(removeDuplicatesMutationTargetAtom)).toBeNull()
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.getter(viewportFreezeAtom)).toEqual(freezeBefore)
      expect(store.getter(viewportHiddenAtom)).toEqual(hiddenBefore)
      expect(store.getter(viewportFilterHiddenAtom)).toEqual(filterHiddenBefore)
      expect(store.getter(contentMutationLastBlockAtom)).toMatchObject({
        status: 'blocked',
        kind: 'remove-rows',
        sheetId: SHEET_ID,
        reason: 'locked',
        diagnostic: {
          code: 'MUTATION_BLOCKED_LOCKED',
          range: SELECTION_RANGE,
        },
      })
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
      expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
      expect(store.getter(removeDuplicatesCanConfirmAtom)).toBe(true)
      expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(true)
      expectHistoryLaneAvailable(store)
    },
  )

  test.each([
    {
      protection: 'fully unlocked protected',
      mode: 'protected' as const,
      unlockedRanges: [SELECTION_RANGE],
    },
    {
      protection: 'open',
      mode: 'open' as const,
      unlockedRanges: [] as CellRange[],
    },
  ])(
    'a $protection sheet passes the remove-rows gateway and commits once',
    async ({ mode, unlockedRanges }) => {
      const store = createStore()
      const removeRowsExact = jest.fn(async (request: RemoveRowsExactRequest) =>
        mutationAcknowledgement(request),
      )
      const refreshProjection = jest.fn(async () => undefined)
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request)
        },
        removeRowsExact,
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)
      store.setter(setSheetProtectionAtom, {
        sheetId: SHEET_ID,
        state: { mode, unlockedRanges },
      })

      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection,
        }),
      ).resolves.toBe('completed')

      expect(removeRowsExact).toHaveBeenCalledTimes(1)
      expect(removeRowsExact.mock.calls[0]?.[0]).toMatchObject({
        kind: 'remove-rows',
        sheetId: SHEET_ID,
        targetRange: SELECTION_RANGE,
        rows: [3],
      })
      expect(refreshProjection).toHaveBeenCalledTimes(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(1)
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
      expectHistoryLaneAvailable(store)
    },
  )

  test(
    'same-tick confirm is single-flight, freezes the full target, records once, ' +
      'refreshes, then closes',
    async () => {
    const store = createStore()
    const mutation = deferred<RemoveRowsExactResult>()
    const refresh = deferred<void>()
    let mutationCalls = 0
    let request: RemoveRowsExactRequest | undefined
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(readRequest) {
        return rangeAcknowledgement(readRequest)
      },
      removeRowsExact(nextRequest) {
        mutationCalls += 1
        request = nextRequest
        return mutation.promise
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)

    const first = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: () => refresh.promise,
    })
    const second = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: () => refresh.promise,
    })
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('mutation-pending')
    expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(false)
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(second).resolves.toBe('stale')
    await Promise.resolve()
    expect(mutationCalls).toBe(1)
    expect(request).toBeDefined()
    expect(request!.rows).toEqual([3])
    expect(request!.targetRange).toEqual(SELECTION_RANGE)
    expect(request!.revision).toBe(1)
    const target = store.getter(removeDuplicatesMutationTargetAtom)!
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target.targetRange)).toBe(true)
    expect(Object.isFrozen(target.removedRowIndices)).toBe(true)
    expect(target.targetKey).toBe(JSON.stringify([SHEET_ID, 0, 4, 0, 1, 'number', 1, [3]]))

    mutation.resolve(mutationAcknowledgement(request!))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('refreshing')
    refresh.resolve()
    await expect(first).resolves.toBe('completed')
    expect(mutationCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expectHistoryLaneAvailable(store)
  })

  test.each([
    { requestRevision: 1, acknowledgementRevision: 2 },
    { requestRevision: 'opaque-r1', acknowledgementRevision: 'opaque-r2' },
  ])(
    'accepts $requestRevision → $acknowledgementRevision and records exactly one descriptor',
    async ({ requestRevision, acknowledgementRevision }) => {
      const store = createStore()
      let mutationCalls = 0
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request, SESSION_CELLS, requestRevision)
        },
        async removeRowsExact(request) {
          mutationCalls += 1
          return mutationAcknowledgement(request, acknowledgementRevision)
        },
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)

      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('completed')

      expect(mutationCalls).toBe(1)
      expect(store.getter(historyStackAtom).entries).toEqual([
        expect.objectContaining({
          kind: 'row.delete',
          sheetId: SHEET_ID,
          projectionRevision: acknowledgementRevision,
          affectedRange: { rowStart: 3, rowEnd: 4, colStart: 0, colEnd: 1 },
        }),
      ])
      expectHistoryLaneAvailable(store)
    },
  )

  test.each(['mismatch', 'revision-echo', 'reject'] as const)(
    '%s mutation outcome stays unknown with no history, close, or resend',
    async (mode) => {
      const store = createStore()
      let calls = 0
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request)
        },
        async removeRowsExact(request) {
          calls += 1
          if (mode === 'reject') throw new Error('transport disconnected')
          if (mode === 'revision-echo') {
            return mutationAcknowledgement(request, request.revision as number)
          }
          return { ...mutationAcknowledgement(request), requestId: request.requestId + 1 }
        },
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)
      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => {},
        }),
      ).resolves.toBe('outcome-unknown')
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(false)
      expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => {},
        }),
      ).resolves.toBe('outcome-unknown')
      expect(calls).toBe(1)
    },
  )

  test('a strict acknowledgement is snapshotted with every field read once', async () => {
    const store = createStore()
    const reads = new Map<string, number>()
    const tracked = <Value extends object>(value: Value, prefix: string): Value =>
      new Proxy(value, {
        get(target, property, receiver) {
          if (typeof property === 'string' && property !== 'then') {
            const key = `${prefix}.${property}`
            reads.set(key, (reads.get(key) ?? 0) + 1)
          }
          return Reflect.get(target, property, receiver)
        },
      })
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        const acknowledgement = mutationAcknowledgement(request, 'opaque-r2')
        return tracked(
          {
            ...acknowledgement,
            targetRange: tracked({ ...acknowledgement.targetRange }, 'targetRange'),
            removedRowIndices: tracked([...acknowledgement.removedRowIndices], 'removedRowIndices'),
            affectedRange: tracked({ ...acknowledgement.affectedRange! }, 'affectedRange'),
          },
          'acknowledgement',
        )
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')

    for (const field of [
      'requestId',
      'sheetId',
      'targetRange',
      'removedRowIndices',
      'removedRows',
      'affectedRange',
      'revision',
      'historyRecorded',
    ]) {
      expect(reads.get(`acknowledgement.${field}`)).toBe(1)
    }
    for (const field of ['rowStart', 'rowEnd', 'colStart', 'colEnd']) {
      expect(reads.get(`targetRange.${field}`)).toBe(1)
    }
    expect(reads.get('removedRowIndices.length')).toBe(1)
    expect(reads.get('removedRowIndices.0')).toBe(1)
    for (const field of ['startRow', 'endRow', 'startCol', 'endCol']) {
      expect(reads.get(`affectedRange.${field}`)).toBe(1)
    }
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test.each([
    { verdict: 'omitted', historyRecorded: undefined, expectedHistoryEntries: 1 },
    { verdict: 'true', historyRecorded: true, expectedHistoryEntries: 1 },
    { verdict: 'false', historyRecorded: false, expectedHistoryEntries: 0 },
  ] as const)(
    'historyRecorded=$verdict commits with $expectedHistoryEntries shared history entries',
    async ({ verdict, historyRecorded, expectedHistoryEntries }) => {
      const store = createStore()
      let refreshCalls = 0
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request)
        },
        async removeRowsExact(request) {
          const acknowledgement = mutationAcknowledgement(request)
          return verdict === 'omitted' ? acknowledgement : { ...acknowledgement, historyRecorded }
        },
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)

      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => {
            refreshCalls += 1
          },
        }),
      ).resolves.toBe('completed')

      expect(refreshCalls).toBe(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(expectedHistoryEntries)
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
      expectHistoryLaneAvailable(store)
    },
  )

  test.each([
    { verdict: 'null', value: null },
    { verdict: 'zero', value: 0 },
    { verdict: 'string', value: 'true' },
    { verdict: 'object', value: Object.freeze({}) },
  ])(
    'historyRecorded=$verdict is outcome-unknown and retains the exact lane',
    async ({ value }) => {
      const store = createStore()
      let mutationCalls = 0
      let refreshCalls = 0
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(request) {
          return rangeAcknowledgement(request)
        },
        async removeRowsExact(request) {
          mutationCalls += 1
          return {
            ...mutationAcknowledgement(request),
            historyRecorded: value,
          } as unknown as RemoveRowsExactResult
        },
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)

      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => {
            refreshCalls += 1
          },
        }),
      ).resolves.toBe('outcome-unknown')

      expect(mutationCalls).toBe(1)
      expect(refreshCalls).toBe(0)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
      expect(store.getter(removeDuplicatesMutationTargetAtom)).not.toBeNull()
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    },
  )

  test(
    'a hostile mutation acknowledgement getter cannot ' +
      'reconcile against same-range replacement authority',
    async () => {
    const store = createStore()
    let revisionReads = 0
    let refreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return {
          ...mutationAcknowledgement(request),
          get revision() {
            revisionReads += 1
            store.setter(selectionAtom, {
              kind: 'range',
              sheetId: SHEET_ID,
              anchor: { row: SELECTION_RANGE.rowEnd, col: SELECTION_RANGE.colEnd },
              focus: { row: SELECTION_RANGE.rowStart, col: SELECTION_RANGE.colStart },
            })
            return 2
          },
        }
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {
          refreshCalls += 1
        },
      }),
    ).resolves.toBe('outcome-unknown')

    expect(revisionReads).toBe(1)
    expect(refreshCalls).toBe(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(removeDuplicatesMutationTargetAtom)).not.toBeNull()
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test(
    'mutation timeout retains its immutable ticket and ignores a late exact acknowledgement',
    async () => {
    jest.useFakeTimers()
    try {
      const store = createStore()
      const mutation = deferred<RemoveRowsExactResult>()
      let request!: RemoveRowsExactRequest
      let mutationCalls = 0
      let refreshCalls = 0
      const source: RemoveDuplicatesControllerPort = {
        async readRangeProjection(readRequest) {
          return rangeAcknowledgement(readRequest)
        },
        removeRowsExact(nextRequest) {
          request = nextRequest
          mutationCalls += 1
          return mutation.promise
        },
      }
      const sessionId = await hydrate(store, source)
      selectRegionColumnOnly(store)
      const input = {
        source,
        sessionId,
        refreshProjection: async () => {
          refreshCalls += 1
        },
      }

      const outcome = store.setter(runRemoveDuplicatesConfirmAtom, input)
      await Promise.resolve()
      expect(mutationCalls).toBe(1)
      expect(request).toBeDefined()
      jest.advanceTimersByTime(DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS)
      await expect(outcome).resolves.toBe('outcome-unknown')
      const lifecycleAfterTimeout = store.getter(removeDuplicatesLifecycleAtom)
      const errorAfterTimeout = store.getter(removeDuplicatesErrorAtom)
      const targetAfterTimeout = store.getter(removeDuplicatesMutationTargetAtom)
      expect(lifecycleAfterTimeout.status).toBe('outcome-unknown')
      expect(errorAfterTimeout).toContain('timed out')
      expect(targetAfterTimeout).not.toBeNull()
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(refreshCalls).toBe(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      mutation.resolve(mutationAcknowledgement(request))
      await Promise.resolve()
      await Promise.resolve()

      expect(store.getter(removeDuplicatesLifecycleAtom)).toBe(lifecycleAfterTimeout)
      expect(store.getter(removeDuplicatesErrorAtom)).toBe(errorAfterTimeout)
      expect(store.getter(removeDuplicatesMutationTargetAtom)).toBe(targetAfterTimeout)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(refreshCalls).toBe(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
      await expect(store.setter(runRemoveDuplicatesConfirmAtom, input)).resolves.toBe(
        'outcome-unknown',
      )
      expect(mutationCalls).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test(
    'an acknowledged mutation retains its ticket and reservation when history push fails',
    async () => {
    const store = createStore()
    let mutationCalls = 0
    let refreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const input = {
      source,
      sessionId,
      refreshProjection: async () => {
        refreshCalls += 1
      },
    }
    const pushReservedHistoryWrite = pushReservedHistoryAtom.write
    pushReservedHistoryAtom.write = () => false
    try {
      await expect(store.setter(runRemoveDuplicatesConfirmAtom, input)).resolves.toBe(
        'outcome-unknown',
      )
    } finally {
      pushReservedHistoryAtom.write = pushReservedHistoryWrite
    }

    expect(mutationCalls).toBe(1)
    expect(refreshCalls).toBe(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(store.setter(runRemoveDuplicatesConfirmAtom, input)).resolves.toBe(
      'outcome-unknown',
    )
    expect(mutationCalls).toBe(1)
  })

  test('a stale release cannot clear a replacement history reservation', async () => {
    const store = createStore()
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    let replacementReservation: HistoryProducerReservation | null = null
    const pushReservedHistoryWrite = pushReservedHistoryAtom.write
    pushReservedHistoryAtom.write = (get, set, input) => {
      const recorded = pushReservedHistoryWrite(get, set, input)
      if (!recorded) return false
      expect(set(releaseHistoryProducerReservationAtom, input.reservation)).toBe(true)
      replacementReservation = set(acquireHistoryProducerReservationAtom)
      expect(replacementReservation).not.toBeNull()
      return true
    }
    try {
      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('outcome-unknown')
    } finally {
      pushReservedHistoryAtom.write = pushReservedHistoryWrite
    }

    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    if (replacementReservation === null) throw new Error('expected replacement reservation')
    expect(store.setter(releaseHistoryProducerReservationAtom, replacementReservation)).toBe(true)
  })

  test(
    'authority drift after acknowledgement but before history push retains the ticket ' +
      'and reservation',
    async () => {
    const store = createStore()
    let mutationCalls = 0
    let refreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const applyFreezeShiftWrite = applyViewportFreezeStructuralShiftAtom.write
    let drifted = false
    applyViewportFreezeStructuralShiftAtom.write = (get, set, input) => {
      const result = applyFreezeShiftWrite(get, set, input)
      if (!drifted) {
        drifted = true
        set(selectionAtom, {
          kind: 'cell',
          sheetId: SHEET_ID,
          anchor: { row: 9, col: 9 },
          focus: { row: 9, col: 9 },
        })
      }
      return result
    }
    try {
      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => {
            refreshCalls += 1
          },
        }),
      ).resolves.toBe('outcome-unknown')
    } finally {
      applyViewportFreezeStructuralShiftAtom.write = applyFreezeShiftWrite
    }

    expect(drifted).toBe(true)
    expect(mutationCalls).toBe(1)
    expect(refreshCalls).toBe(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
    expect(store.getter(removeDuplicatesMutationTargetAtom)).not.toBeNull()
    expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(false)
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('selection drift after transport launch makes even an exact acknowledgement outcome-unknown', async () => {
    const store = createStore()
    const mutation = deferred<RemoveRowsExactResult>()
    let request!: RemoveRowsExactRequest
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(readRequest) {
        return rangeAcknowledgement(readRequest)
      },
      removeRowsExact(nextRequest) {
        request = nextRequest
        return mutation.promise
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const result = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: async () => {},
    })
    await Promise.resolve()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: SHEET_ID,
      anchor: { row: 9, col: 9 },
      focus: { row: 9, col: 9 },
    })
    mutation.resolve(mutationAcknowledgement(request))
    await expect(result).resolves.toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test(
    'authority drift while the initial refresh settles retains the acknowledged ticket ' +
      'and reservation',
    async () => {
    const store = createStore()
    const refresh = deferred<void>()
    const refreshStarted = deferred<void>()
    let mutationCalls = 0
    let refreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const result = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: async () => {
        refreshCalls += 1
        refreshStarted.resolve()
        return refresh.promise
      },
    })
    await refreshStarted.promise
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: SHEET_ID,
      anchor: { row: 9, col: 9 },
      focus: { row: 9, col: 9 },
    })
    refresh.resolve()

    await expect(result).resolves.toBe('outcome-unknown')
    expect(mutationCalls).toBe(1)
    expect(refreshCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
    expect(store.getter(removeDuplicatesMutationTargetAtom)).not.toBeNull()
    expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(false)
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('workspace A→B→A after transport launch makes an exact acknowledgement outcome-unknown', async () => {
    const store = createStore()
    const mutation = deferred<RemoveRowsExactResult>()
    let request!: RemoveRowsExactRequest
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(readRequest) {
        return rangeAcknowledgement(readRequest)
      },
      removeRowsExact(nextRequest) {
        request = nextRequest
        return mutation.promise
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    const result = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: async () => {},
    })
    await Promise.resolve()
    expect(request).toBeDefined()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET_ID })
    mutation.resolve(mutationAcknowledgement(request))

    await expect(result).resolves.toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('refresh failure retries refresh only and never duplicates mutation/history', async () => {
    const store = createStore()
    let mutationCalls = 0
    let refreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {
          refreshCalls += 1
          throw new Error('refresh offline')
        },
      }),
    ).resolves.toBe('refresh-failed')
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('refresh-failed')
    expect(store.getter(removeDuplicatesCanConfirmAtom)).toBe(true)
    expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(false)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {
          refreshCalls += 1
        },
      }),
    ).resolves.toBe('completed')
    expect(mutationCalls).toBe(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expectHistoryLaneAvailable(store)
  })

  test(
    'refresh retry snapshots only retry fields and ignores source or mutation getters',
    async () => {
    const store = createStore()
    let mutationCalls = 0
    let initialRefreshCalls = 0
    let retryRefreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {
          initialRefreshCalls += 1
          throw new Error('refresh offline')
        },
      }),
    ).resolves.toBe('refresh-failed')

    let inputSourceReads = 0
    let mutationPortReads = 0
    let sessionIdReads = 0
    let refreshReads = 0
    let timeoutReads = 0
    const hostileRetrySource = Object.defineProperties(
      {},
      {
        removeRowsExact: {
          get() {
            mutationPortReads += 1
            throw new Error('retry must not observe the mutation port')
          },
        },
      },
    ) as RemoveDuplicatesControllerPort
    const retryInput = Object.defineProperties(
      {},
      {
        source: {
          get() {
            inputSourceReads += 1
            return hostileRetrySource
          },
        },
        sessionId: {
          get() {
            sessionIdReads += 1
            return sessionId
          },
        },
        refreshProjection: {
          get() {
            refreshReads += 1
            return async () => {
              retryRefreshCalls += 1
            }
          },
        },
        timeoutMs: {
          get() {
            timeoutReads += 1
            return 1234
          },
        },
      },
    ) as RunRemoveDuplicatesConfirmInput

    await expect(store.setter(runRemoveDuplicatesConfirmAtom, retryInput)).resolves.toBe(
      'completed',
    )

    expect(inputSourceReads).toBe(0)
    expect(mutationPortReads).toBe(0)
    expect(sessionIdReads).toBe(1)
    expect(refreshReads).toBe(1)
    expect(timeoutReads).toBe(1)
    expect(mutationCalls).toBe(1)
    expect(initialRefreshCalls).toBe(1)
    expect(retryRefreshCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expectHistoryLaneAvailable(store)
  })

  test('retry refresh getter re-entry gives the inner refresh-only owner precedence', async () => {
    const store = createStore()
    const innerRefresh = deferred<void>()
    const innerRefreshStarted = deferred<void>()
    let mutationCalls = 0
    let initialRefreshCalls = 0
    let innerRefreshCalls = 0
    let outerRefreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {
          initialRefreshCalls += 1
          throw new Error('refresh offline')
        },
      }),
    ).resolves.toBe('refresh-failed')

    let inputSourceReads = 0
    let refreshGetterReads = 0
    let innerRetry: Promise<unknown> | undefined
    const outerInput = Object.defineProperties(
      {},
      {
        source: {
          get() {
            inputSourceReads += 1
            throw new Error('retry must not observe source')
          },
        },
        sessionId: {
          get() {
            return sessionId
          },
        },
        refreshProjection: {
          get() {
            refreshGetterReads += 1
            innerRetry = store.setter(runRemoveDuplicatesConfirmAtom, {
              source,
              sessionId,
              refreshProjection: async () => {
                innerRefreshCalls += 1
                innerRefreshStarted.resolve()
                return innerRefresh.promise
              },
              timeoutMs: 1234,
            })
            return async () => {
              outerRefreshCalls += 1
            }
          },
        },
        timeoutMs: {
          get() {
            return 1234
          },
        },
      },
    ) as RunRemoveDuplicatesConfirmInput

    await expect(store.setter(runRemoveDuplicatesConfirmAtom, outerInput)).resolves.toBe('stale')
    expect(innerRetry).toBeDefined()
    await innerRefreshStarted.promise
    expect(inputSourceReads).toBe(0)
    expect(refreshGetterReads).toBe(1)
    expect(outerRefreshCalls).toBe(0)
    expect(mutationCalls).toBe(1)

    innerRefresh.resolve()
    await expect(innerRetry!).resolves.toBe('completed')

    expect(initialRefreshCalls).toBe(1)
    expect(innerRefreshCalls).toBe(1)
    expect(outerRefreshCalls).toBe(0)
    expect(mutationCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
    expectHistoryLaneAvailable(store)
  })

  test(
    'release precedes the last active-ticket clear so a clear subscriber can open a replacement',
    async () => {
    const store = createStore()
    let mutationCalls = 0
    let replacementReadCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const replacementSource: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        replacementReadCalls += 1
        return rangeAcknowledgement(request, SESSION_CELLS, 7)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)

    let sawOwnedTarget = false
    let laneWasAvailableAtClear = false
    let replacementOpening: Promise<unknown> | undefined
    const unsubscribe = store.sub(removeDuplicatesMutationTargetAtom, () => {
      const target = store.getter(removeDuplicatesMutationTargetAtom)
      if (target !== null) {
        sawOwnedTarget = true
        return
      }
      if (
        !sawOwnedTarget ||
        replacementOpening !== undefined ||
        store.getter(removeDuplicatesLifecycleAtom).status !== 'closed'
      ) {
        return
      }
      const reservation = store.setter(acquireHistoryProducerReservationAtom)
      laneWasAvailableAtClear = reservation !== null
      if (reservation === null) throw new Error('history lane must be released before active clear')
      expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
      replacementOpening = store.setter(openRemoveDuplicatesFromSelectionAtom, {
        source: replacementSource,
      })
    })

    try {
      await expect(
        store.setter(runRemoveDuplicatesConfirmAtom, {
          source,
          sessionId,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('completed')
      expect(replacementOpening).toBeDefined()
      await expect(replacementOpening!).resolves.toBe('editing')
    } finally {
      unsubscribe()
    }

    expect(sawOwnedTarget).toBe(true)
    expect(laneWasAvailableAtClear).toBe(true)
    expect(mutationCalls).toBe(1)
    expect(replacementReadCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesLifecycleAtom)).toMatchObject({
      status: 'editing',
      sheetId: SHEET_ID,
    })
    expect(store.getter(removeDuplicatesSessionAtom)?.projectionRevision).toBe(7)
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
    expect(store.getter(removeDuplicatesErrorAtom)).toBe('')
    expectHistoryLaneAvailable(store)
  })

  const authorityDriftRetryTestName =
    'authority drift while a refresh retry settles never ' +
    'resends or releases the acknowledged mutation'
  test(authorityDriftRetryTestName, async () => {
    const store = createStore()
    const retryRefresh = deferred<void>()
    const retryRefreshStarted = deferred<void>()
    let mutationCalls = 0
    let refreshCalls = 0
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)
    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {
          refreshCalls += 1
          throw new Error('refresh offline')
        },
      }),
    ).resolves.toBe('refresh-failed')

    const retryResult = store.setter(runRemoveDuplicatesConfirmAtom, {
      source,
      sessionId,
      refreshProjection: async () => {
        refreshCalls += 1
        retryRefreshStarted.resolve()
        return retryRefresh.promise
      },
    })
    await retryRefreshStarted.promise
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: SHEET_ID,
      anchor: { row: 9, col: 9 },
      focus: { row: 9, col: 9 },
    })
    retryRefresh.resolve()

    await expect(retryResult).resolves.toBe('outcome-unknown')
    expect(mutationCalls).toBe(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesMutationRequestIdAtom)).toBe(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
    expect(store.getter(removeDuplicatesMutationTargetAtom)).not.toBeNull()
    expect(store.getter(removeDuplicatesCanCloseAtom)).toBe(false)
    expect(store.setter(closeRemoveDuplicatesAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })
})

describe('remove-duplicates structural remap of local view facts', () => {
  test('multi-band exact removal remaps freeze/hidden per band and records side payloads', async () => {
    const store = createStore()
    // Duplicates land in two bands: contiguous rows [2, 3] and row [5].
    const cells: DisplayCell[] = [
      cell(0, 0, 'Key'),
      cell(1, 0, 'x'),
      cell(2, 0, 'x'),
      cell(3, 0, 'x'),
      cell(4, 0, 'y'),
      cell(5, 0, 'y'),
      cell(6, 0, 'z'),
    ]
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET_ID })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: SHEET_ID,
      anchor: { row: 0, col: 0 },
      focus: { row: 6, col: 0 },
    })
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request, cells)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
      'editing',
    )
    const sessionId = store.getter(removeDuplicatesSessionAtom)!.sessionId
    expect(store.getter(removeDuplicatesPreviewAtom)?.duplicateRows).toEqual([2, 3, 5])

    store.setter(setFreezeConfigAtom, { sheetId: SHEET_ID, rows: 5, cols: 1 })
    store.setter(hideRowsAtom, { sheetId: SHEET_ID, indices: [1, 3, 6] })
    const entriesBefore = store.getter(historyStackAtom).entries.length

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')

    // Bands apply bottom-up: (5,1) leaves the frozen [0..4] band alone and
    // shifts hidden 6 → 5; (2,2) then shrinks the freeze band by 2 and
    // drops hidden 3 while shifting the earlier 5 → 3.
    expect(store.getter(viewportFreezeAtom).rowsBySheet[SHEET_ID]).toBe(3)
    expect(store.getter(viewportHiddenAtom).rowsBySheet[SHEET_ID]).toEqual([1, 3])

    const entries = store.getter(historyStackAtom).entries
    expect(entries).toHaveLength(entriesBefore + 1)
    const entry = entries[entries.length - 1]!
    expect(entry.kind).toBe('row.delete')
    expect(entry.localReplay).toBeUndefined()
    expect(entry.localSidePayloads).toHaveLength(2)
    expect(entry.localSidePayloads?.[0]).toMatchObject({
      applyKey: 'viewport.freeze',
      sheetId: SHEET_ID,
      before: { rows: 5, cols: 1 },
      after: { rows: 3, cols: 1 },
    })
    expect(entry.localSidePayloads?.[1]).toMatchObject({
      applyKey: 'viewport.hidden',
      sheetId: SHEET_ID,
      before: { rows: [1, 3, 6], cols: [] },
      after: { rows: [1, 3], cols: [] },
    })
  })

  test('S5a: the exact-removal bands displace the FILTER-hidden set the same way', async () => {
    // Same fixture as the manual-set test above, with the filter set seeded to
    // the identical indices — the two sets must land on the same answer,
    // because "which rows moved" is a property of the shift, not of why a row
    // was hidden.
    //
    // The bands differ from that test on purpose: filter-hidden rows are
    // skipped by the §8.1 scan, so seeding [1, 3, 6] leaves only rows 2/4/5 in
    // play and row 5 is the single duplicate → one band (5, 1). That is also
    // why no filter-hidden row can ever fall INSIDE a band on this path — a
    // skipped row is never reported as a duplicate. The drop case is covered
    // on the structure-operation path (operations.test.ts) instead.
    const store = createStore()
    const cells: DisplayCell[] = [
      cell(0, 0, 'Key'),
      cell(1, 0, 'x'),
      cell(2, 0, 'x'),
      cell(3, 0, 'x'),
      cell(4, 0, 'y'),
      cell(5, 0, 'y'),
      cell(6, 0, 'z'),
    ]
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET_ID })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: SHEET_ID,
      anchor: { row: 0, col: 0 },
      focus: { row: 6, col: 0 },
    })
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request, cells)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    await expect(store.setter(openRemoveDuplicatesFromSelectionAtom, { source })).resolves.toBe(
      'editing',
    )
    const sessionId = store.getter(removeDuplicatesSessionAtom)!.sessionId

    store.setter(hideRowsAtom, { sheetId: SHEET_ID, indices: [1, 3, 6] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: SHEET_ID, rows: [1, 3, 6] })
    // Another sheet's filter set must be untouched by sheet-1 bands.
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'other-sheet', rows: [1, 3, 6] })

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')

    const filterState = store.getter(viewportFilterHiddenAtom)
    const filterAfter = getFilterHiddenRowsForSheet(filterState, SHEET_ID)
    expect(filterAfter).toEqual([1, 3, 5])
    expect(filterAfter).toEqual(store.getter(viewportHiddenAtom).rowsBySheet[SHEET_ID])
    expect(
      getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'other-sheet'),
    ).toEqual([1, 3, 6])

    // Since E8 the FILTER-hidden set carries NO history side payload — the
    // engine owns the filter and restores it from its own snapshot on undo,
    // after which the provider re-hydrates this cache from the engine. The
    // forward shift above still keeps the render cache live this same tick.
    const entry = store.getter(historyStackAtom).entries.at(-1)!
    const filterPayload = entry.localSidePayloads?.find(
      (payload) => payload.applyKey === 'viewport.filterHidden',
    )
    expect(filterPayload).toBeUndefined()
  })

  test('a removal that displaces no local view facts records no side payloads', async () => {
    const store = createStore()
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    const sessionId = await hydrate(store, source)
    selectRegionColumnOnly(store)

    await expect(
      store.setter(runRemoveDuplicatesConfirmAtom, {
        source,
        sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')

    const entries = store.getter(historyStackAtom).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.localSidePayloads).toBeUndefined()
    expect(store.getter(viewportFreezeAtom).rowsBySheet[SHEET_ID]).toBeUndefined()
    expect(store.getter(viewportHiddenAtom).rowsBySheet[SHEET_ID]).toBeUndefined()
  })
})

// Slice S3 hardening (design-filter-hidden-rows.md §8.1 / §11).
//
// The scan walks `[startRow..endRow]` densely while the projection is sparse,
// so "row absent from the projection" and "row present and blank" are
// indistinguishable at that layer. Once filter-hidden rows stop being
// projected (S5), every hidden row would materialise as an all-blank tuple,
// duplicate its hidden peers, and be handed to `removeRows` — silent data
// loss. `hiddenRows` closes that hole ahead of the flip.
describe('remove-duplicates × hidden rows (§8.1 data-safety hardening)', () => {
  // Rows 0 (header) and 1, 4 are projected; rows 2, 3, 5 contribute no
  // cells — exactly what a filter-hidden row looks like post-S5.
  const SPARSE_CELLS: DisplayCell[] = [cell(0, 0, 'header'), cell(1, 0, 'a'), cell(4, 0, 'b')]

  test('counter-example: unprojected rows become all-blank duplicates without the guard', () => {
    // The hazard itself, pinned so the guard below is provably load-bearing.
    const result = findDuplicateRows({
      cells: SPARSE_CELLS,
      range: range(0, 0, 5, 0),
      keyColumns: new Set([0]),
    })
    expect(result.duplicateRows).toEqual([3, 5])
    expect(result.scannedRows).toBe(5)
  })

  test('hidden rows are never reported as duplicates', () => {
    const result = findDuplicateRows({
      cells: SPARSE_CELLS,
      range: range(0, 0, 5, 0),
      keyColumns: new Set([0]),
      hiddenRows: [2, 3, 5],
    })
    expect(result.duplicateRows).toEqual([])
    expect(result.scannedRows).toBe(2)
    expect(result.uniqueRows).toBe(2)
  })

  test('a hidden row never becomes the first-seen occupant of a tuple', () => {
    // Even if a hidden row somehow carries cells, it must not shadow a
    // visible row: the visible row owns the tuple and survives.
    const result = findDuplicateRows({
      cells: [cell(1, 0, 'x'), cell(2, 0, 'x')],
      range: range(1, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      hiddenRows: [1],
    })
    expect(result.duplicateRows).toEqual([])
    expect(result.scannedRows).toBe(1)
  })

  test('hidden rows in the header slot or outside the range are inert', () => {
    const result = findDuplicateRows({
      cells: SPARSE_CELLS,
      range: range(0, 0, 5, 0),
      keyColumns: new Set([0]),
      hiddenRows: new Set([0, 99]),
    })
    // Row 0 is already excluded as the header; 99 is out of range.
    expect(result.duplicateRows).toEqual([3, 5])
    expect(result.scannedRows).toBe(5)
  })

  test('omitting hiddenRows preserves the pre-hardening scan exactly', () => {
    const withUndefined = findDuplicateRows({
      cells: SESSION_CELLS,
      range: range(0, 0, 4, 1),
      keyColumns: new Set([0]),
    })
    const withEmpty = findDuplicateRows({
      cells: SESSION_CELLS,
      range: range(0, 0, 4, 1),
      keyColumns: new Set([0]),
      hiddenRows: [],
    })
    expect(withUndefined).toEqual(withEmpty)
    expect(withUndefined.duplicateRows).toEqual([3])
  })

  test('preview atom excludes filter-hidden rows from the scan', async () => {
    const store = createStore()
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    await hydrate(store, source)
    // Row 3 ('North') duplicates row 1 on column 0 while both are visible.
    store.setter(dispatchRemoveDuplicatesIntentAtom, { kind: 'toggle-key-column', column: 1 })
    expect(store.getter(removeDuplicatesPreviewAtom)?.duplicateRows).toEqual([3])

    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: SHEET_ID, rows: [3] })
    const preview = store.getter(removeDuplicatesPreviewAtom)!
    expect(preview.duplicateRows).toEqual([])
    expect(preview.scannedRows).toBe(3)
  })

  test('manually hidden rows still take part — Excel dedupes the whole selection', () => {
    // Excel's Remove Duplicates operates on the entire selection, hidden
    // rows included; manual hides are a pure view fact and the projection
    // still carries their real values. Only filter-hidden rows (which stop
    // being projected at all) are excluded.
    const store = createStore()
    const source: RemoveDuplicatesControllerPort = {
      async readRangeProjection(request) {
        return rangeAcknowledgement(request)
      },
      async removeRowsExact(request) {
        return mutationAcknowledgement(request)
      },
    }
    return hydrate(store, source).then(() => {
      store.setter(dispatchRemoveDuplicatesIntentAtom, { kind: 'toggle-key-column', column: 1 })
      store.setter(hideRowsAtom, { sheetId: SHEET_ID, indices: [3] })
      const preview = store.getter(removeDuplicatesPreviewAtom)!
      expect(preview.duplicateRows).toEqual([3])
      expect(preview.scannedRows).toBe(4)
    })
  })
})
