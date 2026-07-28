import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  retryAutoFillRefreshAtom,
  runAutoFillAtom,
  setFillSeriesLocaleAtom,
  type AutoFillControllerPort,
  type FillSeriesRequest,
  type RunAutoFillCommandInput,
  type RunAutoFillDoubleClickInput,
  type RunAutoFillIntentInput,
} from '../src/auto-fill'
import type {
  AutoFillMutationResult,
  BackendMutationResult,
  DisplayCell,
  FillRangeRequest,
  RangeProjectionResult,
  ResolveDataEdgeRequest,
} from '../src/backend/types'
import {
  acquireHistoryProducerReservationAtom,
  historyStackAtom,
  pushHistoryAtom,
  releaseHistoryProducerReservationAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  type HistoryMutationResult,
  type HistoryRedoRequest,
  type HistoryUndoRequest,
} from '../src/history'
import { setSelectionAtom } from '../src/selection'
import type { CellRange } from '../src/shared'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'

const SHEET_ID = 'sheet-1'
const SOURCE: CellRange = {
  rowStart: 0,
  rowEnd: 0,
  colStart: 0,
  colEnd: 0,
}
const TARGET: CellRange = {
  rowStart: 0,
  rowEnd: 2,
  colStart: 0,
  colEnd: 0,
}
const WRITE_RANGE: CellRange = {
  rowStart: 1,
  rowEnd: 2,
  colStart: 0,
  colEnd: 0,
}

if (false) {
  const structuralShift = {
    axis: 'row',
    kind: 'insert',
    index: 1,
    count: 1,
  } as const
  const noOp = {
    sheetId: SHEET_ID,
    applied: false,
    historyTransactionCount: 0,
    historyDisposition: 'none',
    // @ts-expect-error Compact no-op ACKs can never describe an index-space shift.
    structuralShift,
  } satisfies AutoFillMutationResult
  const applied = {
    sheetId: SHEET_ID,
    revision: 2,
    affectedRange: WRITE_RANGE,
    applied: true,
    historyTransactionCount: 1,
    historyDisposition: 'undoable',
    // @ts-expect-error Compact applied ACKs can never describe an index-space shift.
    structuralShift,
  } satisfies AutoFillMutationResult
  void noOp
  void applied
}

type TestStore = ReturnType<typeof createStore>

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve()
  }
}

function historyAcknowledgement(
  request: HistoryUndoRequest | HistoryRedoRequest,
  revision: number,
): HistoryMutationResult {
  return {
    transactionId: request.transactionId,
    requestId: request.requestId,
    revision,
  }
}

function pushHistorySeed(store: TestStore, transactionId: string, revision: number): void {
  expect(
    store.setter(pushHistoryAtom, {
      transactionId,
      kind: 'range.fill',
      sheetId: SHEET_ID,
      projectionRevision: revision,
      affectedRange: { ...WRITE_RANGE },
    }),
  ).toBe(true)
}

function expectHistoryLaneAvailable(store: TestStore): void {
  const reservation = store.setter(acquireHistoryProducerReservationAtom)
  expect(reservation).not.toBeNull()
  if (reservation === null) throw new Error('expected the shared history producer lane')
  expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
}

function selectRange(store: TestStore, range: Readonly<CellRange>): void {
  const single = range.rowStart === range.rowEnd && range.colStart === range.colEnd
  store.setter(setSelectionAtom, {
    kind: single ? 'cell' : 'range',
    sheetId: SHEET_ID,
    anchor: { row: range.rowStart, col: range.colStart },
    focus: { row: range.rowEnd, col: range.colEnd },
  })
}

function prepareStore(): TestStore {
  const store = createStore()
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET_ID })
  selectRange(store, SOURCE)
  return store
}

function projection(
  cells: DisplayCell[] = [
    {
      row: SOURCE.rowStart,
      col: SOURCE.colStart,
      displayValue: 'seed',
      valueKind: 'string',
    },
  ],
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: SHEET_ID,
    range: { ...SOURCE },
    requestId: 1,
    revision: 1,
    cells,
  }
}

function compactAcknowledgement(
  revision = 2,
  historyDisposition: 'undoable' | 'not-undoable' = 'undoable',
): AutoFillMutationResult {
  return {
    sheetId: SHEET_ID,
    revision,
    affectedRange: { ...WRITE_RANGE },
    applied: true,
    historyTransactionCount: 1,
    historyDisposition,
  }
}

function compactAcknowledgementFor(
  affectedRange: Readonly<CellRange>,
  revision = 2,
): AutoFillMutationResult {
  return {
    sheetId: SHEET_ID,
    revision,
    affectedRange: { ...affectedRange },
    applied: true,
    historyTransactionCount: 1,
    historyDisposition: 'undoable',
  }
}

function rawAppliedCompactAcknowledgement(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sheetId: SHEET_ID,
    revision: 2,
    affectedRange: { ...WRITE_RANGE },
    applied: true,
    historyTransactionCount: 1,
    historyDisposition: 'undoable',
    ...overrides,
  }
}

function compactAcknowledgementWithThrowingGetter(): unknown {
  return Object.defineProperty(rawAppliedCompactAcknowledgement(), 'historyTransactionCount', {
    get() {
      throw new Error('malicious historyTransactionCount getter')
    },
  })
}

function compactAcknowledgementWithThrowingProxy(): unknown {
  return new Proxy(rawAppliedCompactAcknowledgement(), {
    get(target, property, receiver) {
      if (property === 'affectedRange') {
        throw new Error('malicious affectedRange proxy')
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

const INVALID_COMPACT_ACKNOWLEDGEMENTS: ReadonlyArray<{
  readonly label: string
  readonly acknowledgement: unknown
}> = [
  {
    label: 'null acknowledgement',
    acknowledgement: null,
  },
  {
    label: 'undefined acknowledgement',
    acknowledgement: undefined,
  },
  {
    label: 'string acknowledgement',
    acknowledgement: 'applied',
  },
  {
    label: 'number acknowledgement',
    acknowledgement: 1,
  },
  {
    label: 'boolean acknowledgement',
    acknowledgement: true,
  },
  {
    label: 'array acknowledgement',
    acknowledgement: [],
  },
  {
    label: 'empty-object acknowledgement',
    acknowledgement: {},
  },
  {
    label: 'missing historyTransactionCount',
    acknowledgement: {
      sheetId: SHEET_ID,
      revision: 2,
      affectedRange: { ...WRITE_RANGE },
      applied: true,
      historyDisposition: 'undoable',
    },
  },
  {
    label: 'missing historyDisposition',
    acknowledgement: {
      sheetId: SHEET_ID,
      revision: 2,
      affectedRange: { ...WRITE_RANGE },
      applied: true,
      historyTransactionCount: 1,
    },
  },
  {
    label: 'NaN historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({
      historyTransactionCount: Number.NaN,
    }),
  },
  {
    label: 'positive-infinite historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({
      historyTransactionCount: Number.POSITIVE_INFINITY,
    }),
  },
  {
    label: 'negative-infinite historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({
      historyTransactionCount: Number.NEGATIVE_INFINITY,
    }),
  },
  {
    label: 'fractional historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({ historyTransactionCount: 0.5 }),
  },
  {
    label: 'negative historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({ historyTransactionCount: -1 }),
  },
  {
    label: 'historyTransactionCount above the compact maximum',
    acknowledgement: rawAppliedCompactAcknowledgement({ historyTransactionCount: 2 }),
  },
  {
    label: 'unsafe-integer historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({
      historyTransactionCount: Number.MAX_SAFE_INTEGER + 1,
    }),
  },
  {
    label: 'string historyTransactionCount',
    acknowledgement: rawAppliedCompactAcknowledgement({ historyTransactionCount: '1' }),
  },
  {
    label: 'unknown historyDisposition',
    acknowledgement: rawAppliedCompactAcknowledgement({
      historyDisposition: 'maybe-undoable',
    }),
  },
  {
    label: 'throwing historyTransactionCount getter',
    acknowledgement: compactAcknowledgementWithThrowingGetter(),
  },
  {
    label: 'throwing affectedRange proxy',
    acknowledgement: compactAcknowledgementWithThrowingProxy(),
  },
  {
    label: 'applied witness with a structural shift',
    acknowledgement: rawAppliedCompactAcknowledgement({
      structuralShift: {
        axis: 'row',
        kind: 'insert',
        index: 1,
        count: 1,
      },
    }),
  },
  {
    label: 'no-op witness with a structural shift',
    acknowledgement: {
      sheetId: SHEET_ID,
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
      structuralShift: {
        axis: 'column',
        kind: 'delete',
        index: 1,
        count: 1,
      },
    },
  },
  {
    label: 'no-op witness with a NaN revision',
    acknowledgement: {
      sheetId: SHEET_ID,
      revision: Number.NaN,
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
    },
  },
  {
    label: 'no-op witness with an empty revision',
    acknowledgement: {
      sheetId: SHEET_ID,
      revision: '',
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
    },
  },
  {
    label: 'no-op witness with an object revision',
    acknowledgement: {
      sheetId: SHEET_ID,
      revision: {},
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
    },
  },
  {
    label: 'no-op applied flag with an undoable transaction',
    acknowledgement: rawAppliedCompactAcknowledgement({ applied: false }),
  },
  {
    label: 'no-op witness with an affectedRange',
    acknowledgement: rawAppliedCompactAcknowledgement({
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
    }),
  },
  {
    label: 'applied flag with a no-history witness',
    acknowledgement: rawAppliedCompactAcknowledgement({
      historyTransactionCount: 0,
      historyDisposition: 'none',
    }),
  },
  {
    label: 'applied witness without an affectedRange',
    acknowledgement: {
      sheetId: SHEET_ID,
      revision: 2,
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    },
  },
  {
    label: 'applied transaction with none disposition',
    acknowledgement: rawAppliedCompactAcknowledgement({ historyDisposition: 'none' }),
  },
  {
    label: 'no-op transaction with undoable disposition',
    acknowledgement: {
      sheetId: SHEET_ID,
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'undoable',
    },
  },
  {
    label: 'applied witness without a revision',
    acknowledgement: {
      sheetId: SHEET_ID,
      affectedRange: { ...WRITE_RANGE },
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    },
  },
  {
    label: 'applied witness with a negative revision',
    acknowledgement: rawAppliedCompactAcknowledgement({ revision: -1 }),
  },
  {
    label: 'applied witness with a fractional revision',
    acknowledgement: rawAppliedCompactAcknowledgement({ revision: 1.5 }),
  },
  {
    label: 'applied witness with a NaN revision',
    acknowledgement: rawAppliedCompactAcknowledgement({ revision: Number.NaN }),
  },
  {
    label: 'applied witness with an empty revision',
    acknowledgement: rawAppliedCompactAcknowledgement({ revision: '' }),
  },
  {
    label: 'applied witness for another sheet',
    acknowledgement: rawAppliedCompactAcknowledgement({ sheetId: 'sheet-2' }),
  },
  {
    label: 'applied witness without a sheet',
    acknowledgement: {
      revision: 2,
      affectedRange: { ...WRITE_RANGE },
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    },
  },
  {
    label: 'applied witness with a mismatched affectedRange',
    acknowledgement: rawAppliedCompactAcknowledgement({
      affectedRange: { ...WRITE_RANGE, rowStart: WRITE_RANGE.rowStart + 1 },
    }),
  },
  {
    label: 'applied witness with a null affectedRange',
    acknowledgement: rawAppliedCompactAcknowledgement({ affectedRange: null }),
  },
  {
    label: 'applied witness with a primitive affectedRange',
    acknowledgement: rawAppliedCompactAcknowledgement({ affectedRange: 'A2:A3' }),
  },
]

function seriesProjection(): RangeProjectionResult {
  return projection([
    {
      row: SOURCE.rowStart,
      col: SOURCE.colStart,
      displayValue: 'Item1',
      valueKind: 'string',
    },
  ])
}

function exactCellAcknowledgement(row: number, col: number, revision = 2): BackendMutationResult {
  return {
    sheetId: SHEET_ID,
    revision,
    affectedRange: {
      rowStart: row,
      rowEnd: row,
      colStart: col,
      colEnd: col,
    },
  }
}

function exactAcknowledgementWithThrowingGetter(): BackendMutationResult {
  return Object.defineProperty({}, 'sheetId', {
    get() {
      throw new Error('malicious exact-ack sheetId getter')
    },
  }) as BackendMutationResult
}

function exactAcknowledgementWithSingleReadRange(
  affectedRange: Readonly<CellRange>,
  revision = 2,
): {
  readonly acknowledgement: BackendMutationResult
  readonly coordinateReads: Record<keyof CellRange, number>
} {
  const coordinateReads: Record<keyof CellRange, number> = {
    rowStart: 0,
    rowEnd: 0,
    colStart: 0,
    colEnd: 0,
  }
  const range = new Proxy(
    { ...affectedRange },
    {
      get(target, property, receiver) {
        if (
          property === 'rowStart' ||
          property === 'rowEnd' ||
          property === 'colStart' ||
          property === 'colEnd'
        ) {
          coordinateReads[property] += 1
          if (coordinateReads[property] > 1) {
            throw new Error(`malicious exact-ack ${property} second read`)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    },
  )
  return {
    acknowledgement: {
      sheetId: SHEET_ID,
      revision,
      affectedRange: range,
    },
    coordinateReads,
  }
}

function fillInput(
  source: AutoFillControllerPort,
  refreshProjection: (sheetId: string) => Promise<void>,
  targetRange: Readonly<CellRange> = TARGET,
): RunAutoFillIntentInput {
  return {
    entrypoint: 'fill-handle',
    source,
    refreshProjection,
    intent: {
      sheetId: SHEET_ID,
      sourceRange: { ...SOURCE },
      targetRange: { ...targetRange },
      direction: 'down',
      copyOnly: true,
    },
  }
}

function fillSeriesInput(
  source: AutoFillControllerPort,
  refreshProjection: (sheetId: string) => Promise<void>,
): RunAutoFillIntentInput {
  const input = fillInput(source, refreshProjection)
  return {
    ...input,
    intent: {
      ...input.intent,
      copyOnly: false,
    },
  }
}

function fillCommandInput(
  source: AutoFillControllerPort,
  refreshProjection: (sheetId: string) => Promise<void>,
  selectionRange: Readonly<CellRange>,
  direction: RunAutoFillCommandInput['direction'],
): RunAutoFillCommandInput {
  return {
    entrypoint: 'fill-command',
    source,
    refreshProjection,
    sheetId: SHEET_ID,
    selectionRange: { ...selectionRange },
    direction,
  }
}

function doubleClickInput(
  source: AutoFillControllerPort,
  refreshProjection: (sheetId: string) => Promise<void>,
  sourceRange: Readonly<CellRange>,
  bounds: RunAutoFillDoubleClickInput['bounds'] = { rowCount: 20, colCount: 10 },
): RunAutoFillDoubleClickInput {
  return {
    entrypoint: 'double-click',
    source,
    refreshProjection,
    sheetId: SHEET_ID,
    sourceRange: { ...sourceRange },
    bounds: { ...bounds },
  }
}

function exactRangeProjection(
  range: Readonly<CellRange>,
  cells: readonly DisplayCell[],
  requestId = 41,
  revision: number | string = 7,
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: SHEET_ID,
    range: { ...range },
    requestId,
    revision,
    cells: [...cells],
  }
}

function nonBlankGuideProjection(
  range: Readonly<CellRange>,
  requestId = 41,
  revision: number | string = 7,
): RangeProjectionResult {
  return exactRangeProjection(
    range,
    [
      {
        row: range.rowStart,
        col: range.colStart,
        displayValue: 'guide-start',
        valueKind: 'string',
      },
      {
        row: range.rowEnd,
        col: range.colStart,
        displayValue: 'guide-next',
        valueKind: 'string',
      },
    ],
    requestId,
    revision,
  )
}

function unusedSetCellInput(): Promise<BackendMutationResult> {
  throw new Error('unexpected setCellInput fallback')
}

describe('auto-fill shared command', () => {
  const normalizedCommandSelection: CellRange = {
    rowStart: 2,
    rowEnd: 4,
    colStart: 3,
    colEnd: 5,
  }
  const reversedCommandSelection: CellRange = {
    rowStart: 4,
    rowEnd: 2,
    colStart: 5,
    colEnd: 3,
  }

  test('passes the detector locale through the named-list execution witness', async () => {
    const store = prepareStore()
    store.setter(setFillSeriesLocaleAtom, {
      locale: 'tr',
      weekdayNames: [],
      monthNames: [],
      customLists: { turkish: ['I', 'İ', 'K'] },
    })
    const requests: FillSeriesRequest[] = []
    const source: AutoFillControllerPort = {
      readRangeProjection: async () =>
        projection([
          {
            row: SOURCE.rowStart,
            col: SOURCE.colStart,
            displayValue: 'ı',
            valueKind: 'string',
          },
        ]),
      fillSeries: async (request) => {
        requests.push(request)
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillSeriesInput(source, async () => {}),
      ),
    ).resolves.toMatchObject({ status: 'completed', path: 'fill-series' })
    expect(requests).toHaveLength(1)
    expect(requests[0].list).toEqual({
      listName: 'turkish',
      values: ['I', 'İ', 'K'],
      locale: 'tr',
    })
  })

  test.each([
    {
      direction: 'down' as const,
      sourceRange: { rowStart: 2, rowEnd: 2, colStart: 3, colEnd: 5 },
      affectedRange: { rowStart: 3, rowEnd: 4, colStart: 3, colEnd: 5 },
    },
    {
      direction: 'up' as const,
      sourceRange: { rowStart: 4, rowEnd: 4, colStart: 3, colEnd: 5 },
      affectedRange: { rowStart: 2, rowEnd: 3, colStart: 3, colEnd: 5 },
    },
    {
      direction: 'right' as const,
      sourceRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
      affectedRange: { rowStart: 2, rowEnd: 4, colStart: 4, colEnd: 5 },
    },
    {
      direction: 'left' as const,
      sourceRange: { rowStart: 2, rowEnd: 4, colStart: 5, colEnd: 5 },
      affectedRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 4 },
    },
  ])(
    'fill-command $direction maps the normalized selection edge and records one history entry',
    async ({ direction, sourceRange, affectedRange }) => {
      const store = prepareStore()
      selectRange(store, reversedCommandSelection)
      let fillRequest: FillRangeRequest | null = null
      let reads = 0
      let refreshes = 0
      const source: AutoFillControllerPort = {
        readRangeProjection: async () => {
          reads += 1
          throw new Error('fill-command copy path must not read')
        },
        fillRange: async (request) => {
          fillRequest = request
          return compactAcknowledgementFor(affectedRange)
        },
        setCellInput: unusedSetCellInput,
      }

      await expect(
        store.setter(
          runAutoFillAtom,
          fillCommandInput(
            source,
            async () => {
              refreshes += 1
            },
            reversedCommandSelection,
            direction,
          ),
        ),
      ).resolves.toEqual({
        status: 'completed',
        path: 'fill-range',
        affectedRange,
        historyEntries: 1,
      })
      expect(fillRequest).toEqual({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        sourceRange,
        targetRange: normalizedCommandSelection,
        direction,
      })
      expect({ reads, refreshes }).toEqual({ reads: 0, refreshes: 1 })
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
        kind: 'range.fill',
        sheetId: SHEET_ID,
        affectedRange,
      })
      expectHistoryLaneAvailable(store)
    },
  )

  test.each([
    {
      direction: 'down' as const,
      selectionRange: { rowStart: 2, rowEnd: 2, colStart: 3, colEnd: 5 },
    },
    {
      direction: 'up' as const,
      selectionRange: { rowStart: 2, rowEnd: 2, colStart: 3, colEnd: 5 },
    },
    {
      direction: 'right' as const,
      selectionRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
    },
    {
      direction: 'left' as const,
      selectionRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
    },
  ])(
    'fill-command $direction is a no-op when the selection has no writable axis extension',
    async ({ direction, selectionRange }) => {
      const store = prepareStore()
      selectRange(store, selectionRange)
      let reads = 0
      let mutations = 0
      let refreshes = 0
      const source: AutoFillControllerPort = {
        readRangeProjection: async () => {
          reads += 1
          return null
        },
        fillRange: async () => {
          mutations += 1
          return compactAcknowledgement()
        },
        setCellInput: unusedSetCellInput,
      }

      await expect(
        store.setter(
          runAutoFillAtom,
          fillCommandInput(
            source,
            async () => {
              refreshes += 1
            },
            selectionRange,
            direction,
          ),
        ),
      ).resolves.toEqual({ status: 'no-op', reason: 'no-write-range' })
      expect({ reads, mutations, refreshes }).toEqual({ reads: 0, mutations: 0, refreshes: 0 })
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expectHistoryLaneAvailable(store)
    },
  )

  test.each(['selection', 'active sheet'] as const)(
    'fill-command %s drift after an awaited read produces zero writes',
    async (authorityKind) => {
      const store = prepareStore()
      selectRange(store, normalizedCommandSelection)
      const pendingProjection = deferred<RangeProjectionResult | null>()
      let requestedRange: Readonly<CellRange> | null = null
      let writes = 0
      let refreshes = 0
      const source: AutoFillControllerPort = {
        readRangeProjection: async (_sheetId, range) => {
          requestedRange = { ...range }
          return pendingProjection.promise
        },
        setCellInput: async (request) => {
          writes += 1
          return exactCellAcknowledgement(request.row, request.col)
        },
      }
      const operation = store.setter(
        runAutoFillAtom,
        fillCommandInput(
          source,
          async () => {
            refreshes += 1
          },
          normalizedCommandSelection,
          'down',
        ),
      )

      await flushMicrotasks()
      expect(requestedRange).toEqual({
        rowStart: 2,
        rowEnd: 2,
        colStart: 3,
        colEnd: 5,
      })
      if (authorityKind === 'selection') {
        selectRange(store, {
          rowStart: 8,
          rowEnd: 8,
          colStart: 8,
          colEnd: 8,
        })
      } else {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
      }
      pendingProjection.resolve(
        exactRangeProjection(
          {
            rowStart: 2,
            rowEnd: 2,
            colStart: 3,
            colEnd: 5,
          },
          [],
        ),
      )

      await expect(operation).resolves.toEqual({ status: 'stale' })
      expect({ writes, refreshes }).toEqual({ writes: 0, refreshes: 0 })
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expectHistoryLaneAvailable(store)
    },
  )

  const doubleClickSource: CellRange = {
    rowStart: 1,
    rowEnd: 2,
    colStart: 2,
    colEnd: 3,
  }

  test('double-click prefers a valid left guide and records exactly one history entry', async () => {
    const store = prepareStore()
    selectRange(store, doubleClickSource)
    const reads: CellRange[] = []
    let edgeRequest: ResolveDataEdgeRequest | null = null
    let fillRequest: FillRangeRequest | null = null
    let refreshes = 0
    const affectedRange: CellRange = {
      rowStart: 3,
      rowEnd: 6,
      colStart: 2,
      colEnd: 3,
    }
    const source: AutoFillControllerPort = {
      readRangeProjection: async (_sheetId, range) => {
        reads.push({ ...range })
        return nonBlankGuideProjection(range)
      },
      resolveDataEdge: async (request) => {
        edgeRequest = request
        return {
          sheetId: SHEET_ID,
          requestId: request.requestId,
          revision: request.revision,
          target: { row: 6, col: request.from.col },
        }
      },
      fillRange: async (request) => {
        fillRequest = request
        return compactAcknowledgementFor(affectedRange, 8)
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        doubleClickInput(
          source,
          async () => {
            refreshes += 1
          },
          doubleClickSource,
        ),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'fill-range',
      affectedRange,
      historyEntries: 1,
    })
    expect(reads).toEqual([{ rowStart: 2, rowEnd: 3, colStart: 1, colEnd: 1 }])
    expect(edgeRequest).toEqual({
      kind: 'resolve-data-edge',
      sheetId: SHEET_ID,
      from: { row: 2, col: 1 },
      direction: 'down',
      bounds: { rowCount: 20, colCount: 10 },
      requestId: 41,
      revision: 7,
    })
    expect(fillRequest).toEqual({
      kind: 'fill-range',
      sheetId: SHEET_ID,
      sourceRange: doubleClickSource,
      targetRange: {
        rowStart: 1,
        rowEnd: 6,
        colStart: 2,
        colEnd: 3,
      },
      direction: 'down',
      requestId: 41,
      revision: 7,
    })
    expect(refreshes).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)
  })

  test('double-click rejects conflicting guide and series revisions before either mutation path', async () => {
    const store = prepareStore()
    const sourceRange: CellRange = {
      rowStart: 1,
      rowEnd: 1,
      colStart: 2,
      colEnd: 2,
    }
    selectRange(store, sourceRange)
    let reads = 0
    let edgeResolutions = 0
    let seriesMutations = 0
    let rangeMutations = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async (_sheetId, range) => {
        reads += 1
        if (reads === 1) return nonBlankGuideProjection(range, 41, 7)
        return exactRangeProjection(
          range,
          [
            {
              row: sourceRange.rowStart,
              col: sourceRange.colStart,
              displayValue: 'Item1',
              valueKind: 'string',
            },
          ],
          42,
          8,
        )
      },
      resolveDataEdge: async (request) => {
        edgeResolutions += 1
        return {
          sheetId: SHEET_ID,
          requestId: request.requestId,
          revision: request.revision,
          target: { row: 6, col: request.from.col },
        }
      },
      fillSeries: async () => {
        seriesMutations += 1
        throw new Error('conflicting revisions must not reach fillSeries')
      },
      fillRange: async () => {
        rangeMutations += 1
        throw new Error('conflicting revisions must not reach fillRange')
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        doubleClickInput(
          source,
          async () => {
            refreshes += 1
          },
          sourceRange,
        ),
      ),
    ).resolves.toEqual({ status: 'stale' })
    expect({ reads, edgeResolutions, seriesMutations, rangeMutations, refreshes }).toEqual({
      reads: 2,
      edgeResolutions: 1,
      seriesMutations: 0,
      rangeMutations: 0,
      refreshes: 0,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('double-click falls back to the right guide when the left guide is not exact', async () => {
    const store = prepareStore()
    selectRange(store, doubleClickSource)
    const reads: CellRange[] = []
    let edgeRequest: ResolveDataEdgeRequest | null = null
    let fills = 0
    const affectedRange: CellRange = {
      rowStart: 3,
      rowEnd: 5,
      colStart: 2,
      colEnd: 3,
    }
    const source: AutoFillControllerPort = {
      readRangeProjection: async (_sheetId, range) => {
        reads.push({ ...range })
        return reads.length === 1 ? null : nonBlankGuideProjection(range, 52, 'guide-r2')
      },
      resolveDataEdge: async (request) => {
        edgeRequest = request
        return {
          sheetId: SHEET_ID,
          requestId: request.requestId,
          revision: request.revision,
          target: { row: 5, col: request.from.col },
        }
      },
      fillRange: async () => {
        fills += 1
        return compactAcknowledgementFor(affectedRange)
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        doubleClickInput(source, async () => {}, doubleClickSource),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'fill-range',
      affectedRange,
      historyEntries: 1,
    })
    expect(reads).toEqual([
      { rowStart: 2, rowEnd: 3, colStart: 1, colEnd: 1 },
      { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 4 },
    ])
    expect(edgeRequest).toMatchObject({
      from: { row: 2, col: 4 },
      requestId: 52,
      revision: 'guide-r2',
    })
    expect(fills).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)
  })

  test('double-click with no valid guide is a no-op without edge resolution or mutation', async () => {
    const store = prepareStore()
    selectRange(store, doubleClickSource)
    let reads = 0
    let edgeResolutions = 0
    let fills = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => {
        reads += 1
        return null
      },
      resolveDataEdge: async () => {
        edgeResolutions += 1
        throw new Error('no guide must not resolve an edge')
      },
      fillRange: async () => {
        fills += 1
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        doubleClickInput(source, async () => {}, doubleClickSource),
      ),
    ).resolves.toEqual({ status: 'no-op', reason: 'no-guide' })
    expect({ reads, edgeResolutions, fills }).toEqual({ reads: 2, edgeResolutions: 0, fills: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test.each([
    { label: 'missing', revision: undefined },
    { label: 'empty string', revision: '' },
    { label: 'negative integer', revision: -1 },
    { label: 'fractional number', revision: 1.5 },
    { label: 'unsafe integer', revision: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    'double-click treats a guide with $label revision as no guide and performs no effects',
    async ({ revision }) => {
      const store = prepareStore()
      selectRange(store, doubleClickSource)
      let reads = 0
      let edgeResolutions = 0
      let mutations = 0
      let refreshes = 0
      const source: AutoFillControllerPort = {
        readRangeProjection: async (_sheetId, range) => {
          reads += 1
          return {
            ...nonBlankGuideProjection(range),
            revision,
          } as RangeProjectionResult
        },
        resolveDataEdge: async () => {
          edgeResolutions += 1
          throw new Error('an invalid guide witness must not resolve an edge')
        },
        fillRange: async () => {
          mutations += 1
          return compactAcknowledgement()
        },
        setCellInput: async () => {
          mutations += 1
          return exactCellAcknowledgement(3, 2)
        },
      }

      await expect(
        store.setter(
          runAutoFillAtom,
          doubleClickInput(
            source,
            async () => {
              refreshes += 1
            },
            doubleClickSource,
          ),
        ),
      ).resolves.toEqual({ status: 'no-op', reason: 'no-guide' })
      expect({ reads, edgeResolutions, mutations, refreshes }).toEqual({
        reads: 2,
        edgeResolutions: 0,
        mutations: 0,
        refreshes: 0,
      })
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expectHistoryLaneAvailable(store)
    },
  )

  test('double-click at the bottom sheet boundary is a no-op without backend work', async () => {
    const store = prepareStore()
    const boundarySource: CellRange = {
      rowStart: 18,
      rowEnd: 19,
      colStart: 2,
      colEnd: 3,
    }
    selectRange(store, boundarySource)
    let backendCalls = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => {
        backendCalls += 1
        return null
      },
      resolveDataEdge: async () => {
        backendCalls += 1
        throw new Error('boundary must not resolve an edge')
      },
      fillRange: async () => {
        backendCalls += 1
        return compactAcknowledgement()
      },
      setCellInput: async () => {
        backendCalls += 1
        return exactCellAcknowledgement(19, 2)
      },
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        doubleClickInput(source, async () => {}, boundarySource, {
          rowCount: 20,
          colCount: 10,
        }),
      ),
    ).resolves.toEqual({ status: 'no-op', reason: 'sheet-boundary' })
    expect(backendCalls).toBe(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('an exact non-series projection carries its witness into the compact fillRange fallback', async () => {
    const store = prepareStore()
    let reads = 0
    let seriesMutations = 0
    let fillRequest: FillRangeRequest | null = null
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => {
        reads += 1
        return projection()
      },
      fillSeries: async () => {
        seriesMutations += 1
        throw new Error('a non-series projection must not reach fillSeries')
      },
      fillRange: async (request) => {
        fillRequest = request
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillSeriesInput(source, async () => {}),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'fill-range',
      affectedRange: WRITE_RANGE,
      historyEntries: 1,
    })
    expect({ reads, seriesMutations }).toEqual({ reads: 1, seriesMutations: 0 })
    expect(fillRequest).toEqual({
      kind: 'fill-range',
      sheetId: SHEET_ID,
      sourceRange: SOURCE,
      targetRange: TARGET,
      direction: 'down',
      requestId: 1,
      revision: 1,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)
  })

  test.each([
    { label: 'missing', revision: undefined },
    { label: 'empty string', revision: '' },
    { label: 'negative integer', revision: -1 },
    { label: 'fractional number', revision: 1.5 },
    { label: 'unsafe integer', revision: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'NaN', revision: Number.NaN },
  ])(
    'series projection with a $label revision bypasses fillSeries and safely falls back to fillRange',
    async ({ revision }) => {
      const store = prepareStore()
      let reads = 0
      let seriesMutations = 0
      let rangeMutations = 0
      let refreshes = 0
      let fillRequest: FillRangeRequest | null = null
      const source: AutoFillControllerPort = {
        readRangeProjection: async () => {
          reads += 1
          return { ...seriesProjection(), revision }
        },
        fillSeries: async () => {
          seriesMutations += 1
          throw new Error('invalid projection revision must not reach fillSeries')
        },
        fillRange: async (request) => {
          rangeMutations += 1
          fillRequest = request
          return compactAcknowledgement()
        },
        setCellInput: unusedSetCellInput,
      }

      await expect(
        store.setter(
          runAutoFillAtom,
          fillSeriesInput(source, async () => {
            refreshes += 1
          }),
        ),
      ).resolves.toEqual({
        status: 'completed',
        path: 'fill-range',
        affectedRange: WRITE_RANGE,
        historyEntries: 1,
      })
      expect({ reads, seriesMutations, rangeMutations, refreshes }).toEqual({
        reads: 1,
        seriesMutations: 0,
        rangeMutations: 1,
        refreshes: 1,
      })
      expect(fillRequest).toEqual({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        sourceRange: SOURCE,
        targetRange: TARGET,
        direction: 'down',
      })
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expectHistoryLaneAvailable(store)
    },
  )

  test.each([
    {
      label: 'wrong requestId',
      requestId: 99,
      revision: 7 as number | string | undefined,
    },
    {
      label: 'wrong revision',
      requestId: 41,
      revision: 8 as number | string | undefined,
    },
  ])('double-click rejects a data-edge ACK with $label', async ({ requestId, revision }) => {
    const store = prepareStore()
    selectRange(store, doubleClickSource)
    let fills = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async (_sheetId, range) => nonBlankGuideProjection(range),
      resolveDataEdge: async (request) => ({
        sheetId: SHEET_ID,
        requestId,
        revision,
        target: { row: 6, col: request.from.col },
      }),
      fillRange: async () => {
        fills += 1
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        doubleClickInput(
          source,
          async () => {
            refreshes += 1
          },
          doubleClickSource,
        ),
      ),
    ).resolves.toEqual({ status: 'failed', phase: 'data-edge' })
    expect({ fills, refreshes }).toEqual({ fills: 0, refreshes: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('a legacy-only compact ACK has no fallback and permanently quarantines mutation and history', async () => {
    const store = prepareStore()
    let mutations = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      fillRange: async () => {
        mutations += 1
        return {
          sheetId: SHEET_ID,
          revision: 2,
          affectedRange: { ...WRITE_RANGE },
          applied: true,
          historyRecorded: true,
        } as unknown as AutoFillMutationResult
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}),
      ),
    ).resolves.toEqual({
      status: 'outcome-unknown',
      path: 'fill-range',
      reason: 'invalid-acknowledgement',
    })
    expect(mutations).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(
      store.setter(pushHistoryAtom, {
        transactionId: 'tx-interloper',
        kind: 'range.fill',
        sheetId: SHEET_ID,
        projectionRevision: 2,
      }),
    ).toBe(false)

    await expect(
      store.setter(retryAutoFillRefreshAtom, {
        refreshProjection: async () => {
          refreshes += 1
        },
      }),
    ).resolves.toEqual({
      status: 'outcome-unknown',
      path: 'fill-range',
      reason: 'invalid-acknowledgement',
    })
    expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 1 })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    const recoveredUnknown = await store.setter(
      runAutoFillAtom,
      fillInput(source, async () => {
        refreshes += 1
      }),
    )
    expect(recoveredUnknown).toEqual({
      status: 'outcome-unknown',
      path: 'fill-range',
      reason: 'invalid-acknowledgement',
    })
    expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 2 })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  for (const path of ['fill-range', 'fill-series'] as const) {
    test.each(INVALID_COMPACT_ACKNOWLEDGEMENTS)(
      `${path} quarantines $label and refresh-only recovery never resends the mutation`,
      async ({ acknowledgement }) => {
        const store = prepareStore()
        let mutations = 0
        let refreshes = 0
        const mutate = async (): Promise<AutoFillMutationResult> => {
          mutations += 1
          return acknowledgement as AutoFillMutationResult
        }
        const source: AutoFillControllerPort =
          path === 'fill-series'
            ? {
                readRangeProjection: async () => seriesProjection(),
                fillSeries: mutate,
                setCellInput: unusedSetCellInput,
              }
            : {
                readRangeProjection: async () => projection(),
                fillRange: mutate,
                setCellInput: unusedSetCellInput,
              }
        const input =
          path === 'fill-series'
            ? fillSeriesInput(source, async () => {
                refreshes += 1
              })
            : fillInput(source, async () => {
                refreshes += 1
              })

        await expect(store.setter(runAutoFillAtom, input)).resolves.toEqual({
          status: 'outcome-unknown',
          path,
          reason: 'invalid-acknowledgement',
        })
        expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 0 })
        expect(store.getter(historyStackAtom).entries).toHaveLength(0)
        expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

        await expect(
          store.setter(retryAutoFillRefreshAtom, {
            refreshProjection: async () => {
              refreshes += 1
            },
          }),
        ).resolves.toEqual({
          status: 'outcome-unknown',
          path,
          reason: 'invalid-acknowledgement',
        })
        expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 1 })
        expect(store.getter(historyStackAtom).entries).toHaveLength(0)
        expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
      },
    )
  }

  test('failed reconciliation retains the gate until explicit refresh-only recovery succeeds', async () => {
    const store = prepareStore()
    let mutations = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      fillRange: async () => {
        mutations += 1
        return compactAcknowledgement(mutations + 1)
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {
          throw new Error('projection unavailable')
        }),
      ),
    ).resolves.toEqual({ status: 'refresh-failed', path: 'fill-range' })
    expect(mutations).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await expect(
      store.setter(retryAutoFillRefreshAtom, {
        refreshProjection: async () => {
          throw new Error('still unavailable')
        },
      }),
    ).resolves.toEqual({ status: 'refresh-failed', path: 'fill-range' })
    expect(mutations).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await expect(
      store.setter(retryAutoFillRefreshAtom, {
        refreshProjection: async () => {},
      }),
    ).resolves.toEqual({
      status: 'completed',
      path: 'fill-range',
      affectedRange: WRITE_RANGE,
      historyEntries: 1,
    })
    expect(mutations).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}),
      ),
    ).resolves.toMatchObject({ status: 'completed', path: 'fill-range' })
    expect(mutations).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
  })

  test.each([
    {
      label: 'an out-of-range source cell',
      cells: [{ row: 99, col: 0, displayValue: 'bad' }],
    },
    {
      label: 'duplicate source coordinates',
      cells: [
        { row: 0, col: 0, displayValue: 'first' },
        { row: 0, col: 0, displayValue: 'second' },
      ],
    },
  ])('rejects $label before fallback mutation', async ({ cells }) => {
    const store = prepareStore()
    let writes = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(cells),
      setCellInput: async () => {
        writes += 1
        return exactCellAcknowledgement(1, 0)
      },
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {
          refreshes += 1
        }),
      ),
    ).resolves.toEqual({ status: 'failed', phase: 'read' })
    expect({ writes, refreshes }).toEqual({ writes: 0, refreshes: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('initial selection mismatch performs no backend work and releases the reservation', async () => {
    const store = prepareStore()
    selectRange(store, {
      rowStart: 5,
      rowEnd: 5,
      colStart: 0,
      colEnd: 0,
    })
    let reads = 0
    let mutations = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => {
        reads += 1
        return projection()
      },
      fillRange: async () => {
        mutations += 1
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}),
      ),
    ).resolves.toEqual({ status: 'blocked', reason: 'selection-mismatch' })
    expect({ reads, mutations }).toEqual({ reads: 0, mutations: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('initial active-sheet mismatch performs no backend work and releases the reservation', async () => {
    const store = prepareStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    let reads = 0
    let mutations = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => {
        reads += 1
        return projection()
      },
      fillRange: async () => {
        mutations += 1
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}),
      ),
    ).resolves.toEqual({ status: 'blocked', reason: 'active-sheet-mismatch' })
    expect({ reads, mutations }).toEqual({ reads: 0, mutations: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  test('strict backend no-op releases the reservation without refreshing or recording history', async () => {
    const store = prepareStore()
    let mutations = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      fillRange: async () => {
        mutations += 1
        return {
          sheetId: SHEET_ID,
          applied: false,
          historyTransactionCount: 0,
          historyDisposition: 'none',
        }
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {
          refreshes += 1
        }),
      ),
    ).resolves.toEqual({ status: 'no-op', reason: 'backend-no-op' })
    expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryLaneAvailable(store)
  })

  for (const path of ['fill-range', 'fill-series'] as const) {
    test(`${path} not-undoable compact ACK still pushes exactly one ordinary positional entry`, async () => {
      const store = prepareStore()
      let mutations = 0
      let refreshes = 0
      const mutate = async (): Promise<AutoFillMutationResult> => {
        mutations += 1
        return compactAcknowledgement(2, 'not-undoable')
      }
      const source: AutoFillControllerPort =
        path === 'fill-series'
          ? {
              readRangeProjection: async () => seriesProjection(),
              fillSeries: mutate,
              setCellInput: unusedSetCellInput,
            }
          : {
              readRangeProjection: async () => projection(),
              fillRange: mutate,
              setCellInput: unusedSetCellInput,
            }
      const input =
        path === 'fill-series'
          ? fillSeriesInput(source, async () => {
              refreshes += 1
            })
          : fillInput(source, async () => {
              refreshes += 1
            })

      await expect(store.setter(runAutoFillAtom, input)).resolves.toEqual({
        status: 'completed',
        path,
        affectedRange: WRITE_RANGE,
        historyEntries: 1,
      })
      expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 1 })
      const entries = store.getter(historyStackAtom).entries
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'range.fill',
        sheetId: SHEET_ID,
        projectionRevision: 2,
        affectedRange: WRITE_RANGE,
      })
      expectHistoryLaneAvailable(store)
    })
  }

  test('history-first same-tick ownership blocks auto-fill before backend reads or writes', async () => {
    const store = prepareStore()
    pushHistorySeed(store, 'tx-history-first', 1)
    const acknowledgement = deferred<HistoryMutationResult>()
    let historyRequest: HistoryUndoRequest | null = null
    const historyOperation = store.setter(runUndoHistoryAtom, {
      source: {
        undoTransaction(request) {
          historyRequest = request
          return acknowledgement.promise
        },
      },
      refreshProjection: async () => {},
    })

    let reads = 0
    let writes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => {
        reads += 1
        return projection()
      },
      setCellInput: async (request) => {
        writes += 1
        return exactCellAcknowledgement(request.row, request.col)
      },
    }
    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}),
      ),
    ).resolves.toEqual({ status: 'blocked', reason: 'busy' })
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 })

    await Promise.resolve()
    if (historyRequest === null) throw new Error('expected the history transport request')
    acknowledgement.resolve(historyAcknowledgement(historyRequest, 2))
    await expect(historyOperation).resolves.toBe('completed')
    expectHistoryLaneAvailable(store)
  })

  test('auto-fill-first same-tick ownership blocks ordinary history plus undo and redo', async () => {
    const store = prepareStore()
    pushHistorySeed(store, 'tx-1', 1)
    pushHistorySeed(store, 'tx-2', 2)
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: {
          async undoTransaction(request) {
            return historyAcknowledgement(request, 3)
          },
        },
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    expect(store.getter(historyStackAtom).cursor).toBe(1)

    const acknowledgement = deferred<AutoFillMutationResult>()
    let mutations = 0
    const autoFillOperation = store.setter(
      runAutoFillAtom,
      fillInput(
        {
          readRangeProjection: async () => projection(),
          fillRange: async () => {
            mutations += 1
            return acknowledgement.promise
          },
          setCellInput: unusedSetCellInput,
        },
        async () => {},
      ),
    )

    expect(
      store.setter(pushHistoryAtom, {
        transactionId: 'tx-interloper',
        kind: 'range.fill',
        sheetId: SHEET_ID,
        projectionRevision: 4,
      }),
    ).toBe(false)
    let historyTransports = 0
    const blockedHistorySource = {
      async undoTransaction(request: HistoryUndoRequest) {
        historyTransports += 1
        return historyAcknowledgement(request, 4)
      },
      async redoTransaction(request: HistoryRedoRequest) {
        historyTransports += 1
        return historyAcknowledgement(request, 4)
      },
    }
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: blockedHistorySource,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')
    await expect(
      store.setter(runRedoHistoryAtom, {
        source: blockedHistorySource,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')
    expect(historyTransports).toBe(0)
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.transactionId)).toEqual([
      'tx-1',
      'tx-2',
    ])

    await Promise.resolve()
    expect(mutations).toBe(1)
    acknowledgement.resolve(compactAcknowledgement(4))
    await expect(autoFillOperation).resolves.toMatchObject({
      status: 'completed',
      path: 'fill-range',
      historyEntries: 1,
    })
    expectHistoryLaneAvailable(store)
  })

  test('known success keeps the reservation through projection refresh and releases afterward', async () => {
    const store = prepareStore()
    const refresh = deferred<void>()
    let refreshes = 0
    const operation = store.setter(
      runAutoFillAtom,
      fillInput(
        {
          readRangeProjection: async () => projection(),
          fillRange: async () => compactAcknowledgement(),
          setCellInput: unusedSetCellInput,
        },
        async () => {
          refreshes += 1
          return refresh.promise
        },
      ),
    )

    await flushMicrotasks()
    expect(refreshes).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(
      store.setter(pushHistoryAtom, {
        transactionId: 'tx-during-refresh',
        kind: 'range.fill',
        sheetId: SHEET_ID,
        projectionRevision: 3,
      }),
    ).toBe(false)

    refresh.resolve(undefined)
    await expect(operation).resolves.toMatchObject({
      status: 'completed',
      path: 'fill-range',
      historyEntries: 1,
    })
    expectHistoryLaneAvailable(store)
  })

  test('known compact ACK survives authority drift, refreshes once, and releases the ticket', async () => {
    const store = prepareStore()
    let mutations = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      fillRange: async () => {
        mutations += 1
        selectRange(store, {
          rowStart: 5,
          rowEnd: 5,
          colStart: 0,
          colEnd: 0,
        })
        return compactAcknowledgement()
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {
          refreshes += 1
        }),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'fill-range',
      affectedRange: WRITE_RANGE,
      historyEntries: 1,
      committedStale: true,
    })
    expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 1 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)

    selectRange(store, SOURCE)
    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}, SOURCE),
      ),
    ).resolves.toEqual({ status: 'no-op', reason: 'no-write-range' })
    expect(mutations).toBe(1)
    expectHistoryLaneAvailable(store)
  })

  test('import fallback records exactly one reserved history entry for one backend mutation', async () => {
    const store = prepareStore()
    let imports = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      importCells: async () => {
        imports += 1
        return {
          sheetId: SHEET_ID,
          revision: 2,
          affectedRange: { ...WRITE_RANGE },
        }
      },
      setCellInput: unusedSetCellInput,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {
          refreshes += 1
        }),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'import-cells',
      affectedRange: WRITE_RANGE,
      historyEntries: 1,
    })
    expect({ imports, refreshes }).toEqual({ imports: 1, refreshes: 1 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries[0]?.kind).toBe('range.fill')
    expectHistoryLaneAvailable(store)
  })

  for (const path of ['import-cells', 'set-cell-input'] as const) {
    test(`${path} catches a throwing exact ACK and permanently quarantines the lane`, async () => {
      const store = prepareStore()
      let mutations = 0
      let refreshes = 0
      const mutate = async (): Promise<BackendMutationResult> => {
        mutations += 1
        return exactAcknowledgementWithThrowingGetter()
      }
      let source: AutoFillControllerPort
      if (path === 'import-cells') {
        source = {
          readRangeProjection: async () => projection(),
          importCells: mutate,
          setCellInput: unusedSetCellInput,
        }
      } else {
        source = {
          readRangeProjection: async () => projection(),
          setCellInput: mutate,
        }
      }

      await expect(
        store.setter(
          runAutoFillAtom,
          fillInput(source, async () => {
            refreshes += 1
          }),
        ),
      ).resolves.toEqual({
        status: 'outcome-unknown',
        path,
        reason: 'invalid-acknowledgement',
      })
      expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 0 })
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      await expect(
        store.setter(retryAutoFillRefreshAtom, {
          refreshProjection: async () => {
            refreshes += 1
          },
        }),
      ).resolves.toEqual({
        status: 'outcome-unknown',
        path,
        reason: 'invalid-acknowledgement',
      })
      expect({ mutations, refreshes }).toEqual({ mutations: 1, refreshes: 1 })
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    })

    test(`${path} never rereads an exact ACK range after sanitizing it`, async () => {
      const store = prepareStore()
      let mutations = 0
      let refreshes = 0
      const coordinateReadSets: Array<Record<keyof CellRange, number>> = []
      let source: AutoFillControllerPort
      if (path === 'import-cells') {
        source = {
          readRangeProjection: async () => projection(),
          importCells: async () => {
            mutations += 1
            const exact = exactAcknowledgementWithSingleReadRange(WRITE_RANGE)
            coordinateReadSets.push(exact.coordinateReads)
            return exact.acknowledgement
          },
          setCellInput: unusedSetCellInput,
        }
      } else {
        source = {
          readRangeProjection: async () => projection(),
          setCellInput: async (request) => {
            mutations += 1
            const exact = exactAcknowledgementWithSingleReadRange(
              {
                rowStart: request.row,
                rowEnd: request.row,
                colStart: request.col,
                colEnd: request.col,
              },
              mutations + 1,
            )
            coordinateReadSets.push(exact.coordinateReads)
            return exact.acknowledgement
          },
        }
      }

      await expect(
        store.setter(
          runAutoFillAtom,
          fillInput(source, async () => {
            refreshes += 1
          }),
        ),
      ).resolves.toEqual({
        status: 'completed',
        path,
        affectedRange: WRITE_RANGE,
        historyEntries: path === 'import-cells' ? 1 : 2,
      })
      expect({ mutations, refreshes }).toEqual({
        mutations: path === 'import-cells' ? 1 : 2,
        refreshes: 1,
      })
      expect(coordinateReadSets).toHaveLength(path === 'import-cells' ? 1 : 2)
      for (const coordinateReads of coordinateReadSets) {
        expect(coordinateReads).toEqual({
          rowStart: 1,
          rowEnd: 1,
          colStart: 1,
          colEnd: 1,
        })
      }
      expect(store.getter(historyStackAtom).entries).toHaveLength(path === 'import-cells' ? 1 : 2)
      expectHistoryLaneAvailable(store)
    })
  }

  test('per-cell fallback records one reserved history entry for every acknowledged write', async () => {
    const store = prepareStore()
    let writes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      setCellInput: async (request) => {
        writes += 1
        return exactCellAcknowledgement(request.row, request.col, writes + 1)
      },
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'set-cell-input',
      affectedRange: WRITE_RANGE,
      historyEntries: 2,
    })
    const entries = store.getter(historyStackAtom).entries
    expect(writes).toBe(2)
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.kind)).toEqual(['cell.set-input', 'cell.set-input'])
    expect(entries.map((entry) => entry.affectedRange)).toEqual([
      { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 0 },
    ])
    expectHistoryLaneAvailable(store)
  })

  test('partial per-cell fallback is committed-stale, refreshed once, and does not leave the gate busy', async () => {
    const store = prepareStore()
    let writes = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      setCellInput: async (request) => {
        writes += 1
        selectRange(store, {
          rowStart: 6,
          rowEnd: 6,
          colStart: 0,
          colEnd: 0,
        })
        return exactCellAcknowledgement(request.row, request.col)
      },
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {
          refreshes += 1
        }),
      ),
    ).resolves.toEqual({
      status: 'completed',
      path: 'set-cell-input',
      affectedRange: {
        rowStart: 1,
        rowEnd: 1,
        colStart: 0,
        colEnd: 0,
      },
      historyEntries: 1,
      committedStale: true,
    })
    expect({ writes, refreshes }).toEqual({ writes: 1, refreshes: 1 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryLaneAvailable(store)

    selectRange(store, SOURCE)
    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(source, async () => {}, SOURCE),
      ),
    ).resolves.toEqual({ status: 'no-op', reason: 'no-write-range' })
    expect(writes).toBe(1)
    expectHistoryLaneAvailable(store)
  })

  test('an ambiguous per-cell write keeps prior entries, stops later writes, and quarantines the lane', async () => {
    const store = prepareStore()
    let writes = 0
    let refreshes = 0
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      setCellInput: async (request) => {
        writes += 1
        if (writes === 2) throw new Error('connection lost after dispatch')
        return exactCellAcknowledgement(request.row, request.col, writes + 1)
      },
    }
    const threeCellTarget: CellRange = {
      rowStart: 0,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    }

    await expect(
      store.setter(
        runAutoFillAtom,
        fillInput(
          source,
          async () => {
            refreshes += 1
          },
          threeCellTarget,
        ),
      ),
    ).resolves.toEqual({
      status: 'outcome-unknown',
      path: 'set-cell-input',
      reason: 'transport-rejected',
    })
    expect({ writes, refreshes }).toEqual({ writes: 2, refreshes: 0 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries[0]?.affectedRange).toEqual({
      rowStart: 1,
      rowEnd: 1,
      colStart: 0,
      colEnd: 0,
    })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await expect(
      store.setter(retryAutoFillRefreshAtom, {
        refreshProjection: async () => {
          refreshes += 1
        },
      }),
    ).resolves.toEqual({
      status: 'outcome-unknown',
      path: 'set-cell-input',
      reason: 'transport-rejected',
    })
    expect({ writes, refreshes }).toEqual({ writes: 2, refreshes: 1 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('same-tick duplicate is blocked before a second transport can launch', async () => {
    const store = prepareStore()
    let mutations = 0
    let release!: (result: AutoFillMutationResult) => void
    const pendingAcknowledgement = new Promise<AutoFillMutationResult>((resolve) => {
      release = resolve
    })
    const source: AutoFillControllerPort = {
      readRangeProjection: async () => projection(),
      fillRange: async () => {
        mutations += 1
        return pendingAcknowledgement
      },
      setCellInput: unusedSetCellInput,
    }
    const input = fillInput(source, async () => {})

    const first = store.setter(runAutoFillAtom, input)
    const duplicate = store.setter(runAutoFillAtom, input)
    await expect(duplicate).resolves.toEqual({ status: 'blocked', reason: 'busy' })
    await Promise.resolve()
    expect(mutations).toBe(1)

    release(compactAcknowledgement())
    await expect(first).resolves.toMatchObject({
      status: 'completed',
      path: 'fill-range',
    })
    expect(mutations).toBe(1)
    expectHistoryLaneAvailable(store)
  })
})
