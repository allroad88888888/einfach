import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { Store } from '@einfach/core'
import type {
  DisplayCell,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../src/backend/types'
import { historyStackAtom } from '../src/history'
import { selectionAtom } from '../src/selection'
import {
  setWorkspaceActiveSheetAtom,
  workspaceActiveSheetAuthorityWitnessAtom,
} from '../src/workspace'
import {
  closeRemoveDuplicatesAtom,
  dispatchRemoveDuplicatesIntentAtom,
  findDuplicateRows,
  nextRemoveDuplicatesMutationRequestId,
  nextRemoveDuplicatesReadRequestId,
  nextRemoveDuplicatesSessionId,
  openRemoveDuplicatesFromSelectionAtom,
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
  removeDuplicatesRangeAtom,
  removeDuplicatesScanInputCellsAtom,
  removeDuplicatesSessionAtom,
  removeDuplicatesSessionIdAtom,
  retryRemoveDuplicatesReadAtom,
  runRemoveDuplicatesConfirmAtom,
  type RemoveDuplicatesControllerPort,
  type RemoveDuplicatesRange,
  type RemoveRowsExactRequest,
  type RemoveRowsExactResult,
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

  test('filter/sort projection: duplicateRows carries originalRow, not visual row', () => {
    // Simulates a sorted projection where visual rows 1..3 map to
    // source rows 42, 7, 19. Two cells share the same value, so the
    // SECOND-seen visual row is a duplicate — but the reported index
    // must be its `originalRow` so backend.removeRows deletes the
    // right source row.
    const c = (row: number, col: number, value: string, originalRow: number): DisplayCell => ({
      row,
      col,
      displayValue: value,
      valueKind: 'string',
      originalRow,
    })
    const cells: DisplayCell[] = [
      c(0, 0, 'header', 0),
      c(1, 0, 'shared', 42),
      c(2, 0, 'unique', 7),
      c(3, 0, 'shared', 19),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 0),
      keyColumns: new Set([0]),
    })
    // Visual row 3 is the duplicate; its source row is 19, NOT 3.
    expect(result.duplicateRows).toEqual([19])
  })

  test('projection bug: cells in same visual row report different originalRow → warn once, keep first', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cells: DisplayCell[] = [
        { row: 1, col: 0, displayValue: 'a', valueKind: 'string', originalRow: 10 },
        // bug: same visual row, conflicting source row
        { row: 1, col: 1, displayValue: 'x', valueKind: 'string', originalRow: 99 },
        { row: 2, col: 0, displayValue: 'a', valueKind: 'string', originalRow: 11 },
        { row: 2, col: 1, displayValue: 'x', valueKind: 'string', originalRow: 11 },
      ]
      const result = findDuplicateRows({
        cells,
        range: range(1, 0, 2, 1),
        keyColumns: new Set([0, 1]),
        excludeHeader: false,
      })
      // visual row 2 dupes visual row 1 → reports source row 11.
      expect(result.duplicateRows).toEqual([11])
      // and warned, but didn't throw.
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
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
  revision = 2,
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
      name: 'conflicting originalRow values for one visual row',
      cells: [
        { ...cell(1, 0, 'North'), originalRow: 10 },
        { ...cell(1, 1, '100'), originalRow: 11 },
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

  test('same-tick confirm is single-flight, freezes the full target, records once, refreshes, then closes', async () => {
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
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('refreshing')
    refresh.resolve()
    await expect(first).resolves.toBe('completed')
    expect(mutationCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
  })

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
  })
})
