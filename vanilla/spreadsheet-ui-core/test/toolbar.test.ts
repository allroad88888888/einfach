import { createStore } from '@einfach/core'
import { describe, expect, jest, test } from '@jest/globals'
import {
  closeToolbarSurfaceAtom,
  dispatchToolbarFormatCommandAtom,
  openToolbarDropdownAtom,
  openToolbarPaletteAtom,
  nextToolbarMutationIdentity,
  planToolbarMutationIdentities,
  resetToolbarMutationAtom,
  retryToolbarMutationAtom,
  retryToolbarMutationRefreshAtom,
  runToolbarMutationAtom,
  toolbarActiveSurfaceAtom,
  toolbarCommandAvailabilityAtom,
  toolbarIntentAtom,
  toolbarMutationLifecycleAtom,
  clearToolbarIntentAtom,
} from '../src/toolbar'
import { toolbarUiStateAtom as packageToolbarUiStateAtom } from '../src'
import type {
  MergeRangeRequest,
  SetFormatRangeRequest,
  ToolbarActiveSurface,
  ToolbarDropdownKind,
  ToolbarMutationControllerPort,
  ToolbarBackendMutationResult,
  UnmergeRangeRequest,
} from '../src'
import { historyStackAtom } from '../src/history'
import { selectAllAtom, selectCellAtom, selectRowsAtom } from '../src/selection'
import { startEditingAtom } from '../src/editing'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const TOOLBAR_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof packageToolbarUiStateAtom>,
  AtomHasPublicWrite<typeof toolbarActiveSurfaceAtom>,
  AtomHasPublicWrite<typeof toolbarIntentAtom>,
  AtomHasPublicWrite<typeof toolbarMutationLifecycleAtom>,
] = [false, false, false, false]

const MALFORMED_TOOLBAR_ACK_CASES: ReadonlyArray<
  readonly [string, (request: SetFormatRangeRequest) => unknown]
> = [
  ['null result', () => null],
  ['primitive result', () => 17],
  ['array result', () => []],
  [
    'wrong sheetId',
    (request) => ({ ...strictFormatAcknowledgement(request, 21), sheetId: 'other-sheet' }),
  ],
  [
    'missing requestId',
    (request) => ({
      kind: request.kind,
      sheetId: request.sheetId,
      affectedRange: { ...request.range },
      revision: 21,
    }),
  ],
  [
    'wrong requestId',
    (request) => ({
      ...strictFormatAcknowledgement(request, 21),
      requestId: (request.requestId ?? 0) + 1,
    }),
  ],
  [
    'unsafe requestId',
    (request) => ({
      ...strictFormatAcknowledgement(request, 21),
      requestId: Number.MAX_SAFE_INTEGER + 1,
    }),
  ],
  [
    'missing affectedRange',
    (request) => ({
      kind: request.kind,
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 21,
    }),
  ],
  [
    'wrong affectedRange',
    (request) => ({
      ...strictFormatAcknowledgement(request, 21),
      affectedRange: { ...request.range, colEnd: request.range.colEnd + 1 },
    }),
  ],
  [
    'missing revision',
    (request) => ({
      kind: request.kind,
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: { ...request.range },
    }),
  ],
  ['empty revision', (request) => ({ ...strictFormatAcknowledgement(request, 21), revision: '' })],
  [
    'non-finite revision',
    (request) => ({ ...strictFormatAcknowledgement(request, 21), revision: Number.NaN }),
  ],
  [
    'missing kind',
    (request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: { ...request.range },
      revision: 21,
    }),
  ],
  [
    'wrong kind',
    (request) => ({ ...strictFormatAcknowledgement(request, 21), kind: 'merge-range' }),
  ],
]

describe('toolbar core', () => {
  test('exports read-only Core toolbar state while typed commands own every surface transition', () => {
    const store = createStore()

    expect(TOOLBAR_PUBLIC_STATE_IS_READ_ONLY).toEqual([false, false, false, false])
    expect(packageToolbarUiStateAtom.debugLabel).toBe('spreadsheet.toolbar.ui')
    expect(packageToolbarUiStateAtom).not.toHaveProperty('write')
    expect(toolbarActiveSurfaceAtom).not.toHaveProperty('write')
    expect(toolbarIntentAtom).not.toHaveProperty('write')
    expect(toolbarMutationLifecycleAtom).not.toHaveProperty('write')
    expect(openToolbarDropdownAtom).toHaveProperty('write')
    expect(openToolbarPaletteAtom).toHaveProperty('write')
    expect(closeToolbarSurfaceAtom).toHaveProperty('write')
    expect(Object.isFrozen(store.getter(packageToolbarUiStateAtom))).toBe(true)

    const opened = store.setter(openToolbarPaletteAtom, { palette: 'fill-color' })
    expect(store.getter(packageToolbarUiStateAtom)).toEqual({ activeSurface: opened })
    expect(Object.isFrozen(store.getter(packageToolbarUiStateAtom))).toBe(true)
    expect(Object.isFrozen(store.getter(packageToolbarUiStateAtom).activeSurface)).toBe(true)
    expect(Reflect.set(store.getter(packageToolbarUiStateAtom), 'activeSurface', null)).toBe(false)
    expect(
      Reflect.set(
        store.getter(packageToolbarUiStateAtom).activeSurface as ToolbarActiveSurface,
        'id',
        'text-color',
      ),
    ).toBe(false)
    expect(store.getter(packageToolbarUiStateAtom).activeSurface).toEqual({
      kind: 'palette',
      id: 'fill-color',
    })

    const intent = store.getter(toolbarIntentAtom)
    expect(intent).not.toBeNull()
    expect(Object.isFrozen(intent)).toBe(true)
    if (intent?.type === 'toolbar.surface.open') {
      expect(Object.isFrozen(intent.surface)).toBe(true)
      expect(Reflect.set(intent.surface, 'id', 'text-color')).toBe(false)
    }
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.open',
      source: 'toolbar',
      surface: { kind: 'palette', id: 'fill-color' },
    })

    store.setter(closeToolbarSurfaceAtom)
    expect(store.getter(packageToolbarUiStateAtom).activeSurface).toBeNull()
  })

  test.each([
    ['zero', 0, 1],
    ['positive boundary', Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
    ['positive rollover', Number.MAX_SAFE_INTEGER, -1],
    ['negative lane', -1, -2],
    ['negative boundary', Number.MIN_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER],
    ['negative exhaustion', Number.MIN_SAFE_INTEGER, null],
    ['positive unsafe', Number.MAX_SAFE_INTEGER + 1, null],
    ['negative unsafe', Number.MIN_SAFE_INTEGER - 1, null],
    ['fractional', 1.5, null],
    ['positive infinity', Number.POSITIVE_INFINITY, null],
    ['negative infinity', Number.NEGATIVE_INFINITY, null],
    ['NaN', Number.NaN, null],
  ] as const)('allocates safe mutation identities at the %s case', (_case, input, expected) => {
    expect(nextToolbarMutationIdentity(input)).toBe(expected)
  })

  test('plans all session and request ids atomically and fails closed on exhaustion', () => {
    expect(planToolbarMutationIdentities(0, Number.MAX_SAFE_INTEGER, 3)).toEqual({
      sessionId: 1,
      requestIds: [-1, -2, -3],
      requestSequence: -3,
    })
    expect(planToolbarMutationIdentities(0, Number.MIN_SAFE_INTEGER + 1, 2)).toBeNull()
    expect(planToolbarMutationIdentities(Number.MIN_SAFE_INTEGER, 0, 1)).toBeNull()
    expect(planToolbarMutationIdentities(0, 0, 0)).toBeNull()
  })

  test('tracks the active dropdown and palette surface', () => {
    const store = createStore()

    const dropdowns: readonly ToolbarDropdownKind[] = [
      'alignment',
      'vertical-alignment',
      'number-format',
      'border',
      'merge',
      'font-family',
      'font-size',
      'rotation',
      'sort',
    ]
    for (const dropdown of dropdowns) {
      store.setter(openToolbarDropdownAtom, { dropdown })
      expect(store.getter(toolbarActiveSurfaceAtom)).toEqual({
        kind: 'dropdown',
        id: dropdown,
      })
    }
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual({
      kind: 'dropdown',
      id: 'sort',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.open',
      source: 'toolbar',
      surface: {
        kind: 'dropdown',
        id: 'sort',
      },
    })

    store.setter(openToolbarPaletteAtom, { palette: 'text-color' })
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual({
      kind: 'palette',
      id: 'text-color',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.open',
      source: 'toolbar',
      surface: {
        kind: 'palette',
        id: 'text-color',
      },
    })

    store.setter(closeToolbarSurfaceAtom)
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual(null)
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.close',
      source: 'toolbar',
    })
  })

  test('derives command availability from selection kind and editing mode', () => {
    const store = createStore()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 1, col: 1 },
    })

    const cellAvailability = store.getter(toolbarCommandAvailabilityAtom)
    expect(Object.isFrozen(cellAvailability)).toBe(true)
    expect(Reflect.set(cellAvailability, 'bold', false)).toBe(false)
    expect(store.getter(toolbarCommandAvailabilityAtom).bold).toBe(true)
    expect(cellAvailability).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      editingMode: 'idle',
      bold: true,
      italic: true,
      textColor: true,
      fillColor: true,
      numberFormat: true,
      alignment: true,
    })

    store.setter(selectRowsAtom, {
      sheetId: 'Sheet1',
      rowAnchor: 2,
      rowFocus: 4,
    })
    expect(store.getter(toolbarCommandAvailabilityAtom)).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'row',
      editingMode: 'idle',
      bold: true,
      italic: true,
      textColor: true,
      fillColor: true,
      numberFormat: false,
      alignment: true,
    })

    store.setter(selectAllAtom)
    expect(store.getter(toolbarCommandAvailabilityAtom)).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'all',
      editingMode: 'idle',
      bold: false,
      italic: false,
      textColor: false,
      fillColor: false,
      numberFormat: false,
      alignment: false,
    })

    store.setter(startEditingAtom, {
      sheetId: 'Sheet1',
      cell: { row: 1, col: 1 },
      draft: 'abc',
      source: 'cell',
    })
    expect(store.getter(toolbarCommandAvailabilityAtom)).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'all',
      editingMode: 'drafting',
      bold: false,
      italic: false,
      textColor: false,
      fillColor: false,
      numberFormat: false,
      alignment: false,
    })
  })

  test('dispatches a format command intent for backend adapters', () => {
    const store = createStore()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 3, col: 2 },
    })

    const intent = store.setter(dispatchToolbarFormatCommandAtom, {
      command: 'text-color',
      value: '#ff0000',
    })

    expect(intent).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      command: 'text-color',
      value: '#ff0000',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual(intent)
  })

  test('clears the last toolbar intent after dispatch', () => {
    const store = createStore()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 0, col: 0 },
    })
    store.setter(dispatchToolbarFormatCommandAtom, {
      command: 'bold',
    })

    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      command: 'bold',
      value: null,
    })

    store.setter(clearToolbarIntentAtom)
    expect(store.getter(toolbarIntentAtom)).toEqual(null)
  })

  test('blocks an unsupported batch before any backend mutation is called', async () => {
    const store = createStore()
    const mergeRange = jest.fn(async () => ({ sheetId: 'Sheet1', revision: 1 }))
    const refreshProjection = jest.fn(async () => undefined)

    const outcome = await store.setter(runToolbarMutationAtom, {
      source: { mergeRange },
      sheetId: 'Sheet1',
      operation: 'border-batch',
      affectedRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      steps: [
        {
          kind: 'set-format-range',
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { bold: true },
        },
      ],
      refreshProjection,
    })

    expect(outcome).toBe('blocked')
    expect(mergeRange).not.toHaveBeenCalled()
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'blocked',
      acknowledgedCount: 0,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('rejects an operation and step mismatch before dispatching any backend method', async () => {
    const store = createStore()
    const setFormatRange = jest.fn(async (request: SetFormatRangeRequest) =>
      strictFormatAcknowledgement(request, 1),
    )
    const mergeRange = jest.fn(async (request: MergeRangeRequest) =>
      strictRangeAcknowledgement(request, 1),
    )

    const outcome = await store.setter(runToolbarMutationAtom, {
      source: { setFormatRange, mergeRange },
      sheetId: 'Sheet1',
      operation: 'merge',
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      steps: [
        {
          kind: 'set-format-range',
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
          format: { bold: true },
        },
      ],
      refreshProjection: async () => undefined,
    })

    expect(outcome).toBe('blocked')
    expect(setFormatRange).not.toHaveBeenCalled()
    expect(mergeRange).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('records history exactly once only after a strict acknowledgement and refresh', async () => {
    const store = createStore()
    const setFormatRange = jest.fn(async (request: SetFormatRangeRequest) =>
      strictFormatAcknowledgement(request, 8),
    )
    const refreshProjection = jest.fn(async () => undefined)

    const outcome = await store.setter(runToolbarMutationAtom, {
      source: { setFormatRange },
      sheetId: 'Sheet1',
      operation: 'format',
      affectedRange: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
      steps: [
        {
          kind: 'set-format-range',
          range: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
          format: { bold: true },
        },
      ],
      refreshProjection,
    })

    expect(outcome).toBe('completed')
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'ready',
      acknowledgedRevision: 8,
      acknowledgedCount: 1,
      totalCount: 1,
    })
    expect(store.getter(historyStackAtom)).toMatchObject({
      cursor: 1,
      entries: [
        expect.objectContaining({
          kind: 'format.set',
          sheetId: 'Sheet1',
          projectionRevision: 8,
          affectedRange: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
        }),
      ],
    })
    expect(await store.setter(retryToolbarMutationAtom)).toBe('blocked')
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test('derives merge and unmerge history kinds from the validated Core operation', async () => {
    const store = createStore()
    const mergeRange = jest.fn(async (request: MergeRangeRequest) =>
      strictRangeAcknowledgement(request, 9),
    )
    const unmergeRange = jest.fn(async (request: UnmergeRangeRequest) =>
      strictRangeAcknowledgement(request, 10),
    )
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const refreshProjection = jest.fn(async () => undefined)

    await expect(
      store.setter(runToolbarMutationAtom, {
        source: { mergeRange },
        sheetId: 'Sheet1',
        operation: 'merge',
        affectedRange: range,
        steps: [{ kind: 'merge-range', range }],
        refreshProjection,
      }),
    ).resolves.toBe('completed')
    await expect(
      store.setter(runToolbarMutationAtom, {
        source: { unmergeRange },
        sheetId: 'Sheet1',
        operation: 'unmerge',
        affectedRange: range,
        steps: [{ kind: 'unmerge-range', range }],
        refreshProjection,
      }),
    ).resolves.toBe('completed')

    expect(store.getter(historyStackAtom).entries.map((entry) => entry.kind)).toEqual([
      'range.merge',
      'range.unmerge',
    ])
    expect(mergeRange).toHaveBeenCalledTimes(1)
    expect(unmergeRange).toHaveBeenCalledTimes(1)
    expect(refreshProjection).toHaveBeenCalledTimes(2)
  })

  test('treats every dispatched transport rejection as outcome unknown and never resends it', async () => {
    const store = createStore()
    const requests: SetFormatRangeRequest[] = []
    const transport = jest.fn(async (request: SetFormatRangeRequest) => {
      requests.push(request)
      throw new Error('transport rejected after dispatch')
    })
    const source: ToolbarMutationControllerPort = { setFormatRange: transport }
    const refreshProjection = jest.fn(async () => undefined)

    expect(
      await store.setter(runToolbarMutationAtom, {
        source,
        sheetId: 'Sheet1',
        operation: 'format',
        affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        steps: [
          {
            kind: 'set-format-range',
            range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
            format: { italic: true },
          },
        ],
        refreshProjection,
      }),
    ).toBe('outcome-unknown')

    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      acknowledgedCount: 0,
      canRetryRefresh: true,
    })
    expect(store.setter(resetToolbarMutationAtom)).toBe(false)
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      canRetryRefresh: true,
    })
    expect(await store.setter(retryToolbarMutationAtom)).toBe('blocked')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen(requests[0].range)).toBe(true)
    expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('outcome-unknown')
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      canRetryRefresh: false,
      error: 'Projection refreshed, but the toolbar mutation outcome remains unknown.',
    })
    expect(store.setter(resetToolbarMutationAtom)).toBe(false)
    expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('blocked')

    const confirmedTransport = jest.fn(async (request: SetFormatRangeRequest) =>
      strictFormatAcknowledgement(request, 2),
    )
    await expect(
      store.setter(runToolbarMutationAtom, {
        source: { setFormatRange: confirmedTransport },
        sheetId: 'Sheet1',
        operation: 'format',
        affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        steps: [
          {
            kind: 'set-format-range',
            range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
            format: { italic: false },
          },
        ],
        refreshProjection,
      }),
    ).resolves.toBe('completed')
    expect(confirmedTransport).toHaveBeenCalledTimes(1)
  })

  test('holds one raw transport lane through every step and blocks every concurrent entrypoint', async () => {
    const store = createStore()
    const first = createDeferred<ToolbarBackendMutationResult>()
    const second = createDeferred<ToolbarBackendMutationResult>()
    const requests: SetFormatRangeRequest[] = []
    const setFormatRange = jest.fn((request: SetFormatRangeRequest) => {
      requests.push(request)
      if (requests.length === 1) return first.promise
      if (requests.length === 2) return second.promise
      return Promise.resolve(strictFormatAcknowledgement(request, 30 + requests.length))
    })
    const refreshProjection = jest.fn(async () => undefined)
    const input = {
      source: { setFormatRange },
      sheetId: 'Sheet1',
      operation: 'border-batch' as const,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      steps: [
        {
          kind: 'set-format-range' as const,
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { borders: { right: { style: 'thin' as const } } },
        },
        {
          kind: 'set-format-range' as const,
          range: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
          format: { borders: { left: { style: 'thin' as const } } },
        },
      ],
      refreshProjection,
    }

    const running = store.setter(runToolbarMutationAtom, input)
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(await store.setter(runToolbarMutationAtom, input)).toBe('blocked')
    expect(await store.setter(retryToolbarMutationAtom)).toBe('blocked')
    expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('blocked')

    first.resolve(strictFormatAcknowledgement(requests[0], 31))
    await flushMicrotasks()
    expect(setFormatRange).toHaveBeenCalledTimes(2)
    expect(await store.setter(runToolbarMutationAtom, input)).toBe('blocked')

    second.resolve(strictFormatAcknowledgement(requests[1], 32))
    await expect(running).resolves.toBe('completed')
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)

    await expect(store.setter(runToolbarMutationAtom, input)).resolves.toBe('completed')
    expect(setFormatRange).toHaveBeenCalledTimes(4)
    expect(refreshProjection).toHaveBeenCalledTimes(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
  })

  test('ignores a late strict ACK after reset and opens no replacement lane until it settles', async () => {
    const store = createStore()
    const late = createDeferred<ToolbarBackendMutationResult>()
    const requests: SetFormatRangeRequest[] = []
    const setFormatRange = jest.fn((request: SetFormatRangeRequest) => {
      requests.push(request)
      if (requests.length === 1) return late.promise
      return Promise.resolve(strictFormatAcknowledgement(request, 42))
    })
    const refreshProjection = jest.fn(async () => undefined)
    const input = {
      source: { setFormatRange },
      sheetId: 'Sheet1',
      operation: 'format' as const,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      steps: [
        {
          kind: 'set-format-range' as const,
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { bold: true },
        },
      ],
      refreshProjection,
    }

    const running = store.setter(runToolbarMutationAtom, input)
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(store.setter(resetToolbarMutationAtom)).toBe(true)
    expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('ready')
    expect(await store.setter(runToolbarMutationAtom, input)).toBe('blocked')

    late.resolve(strictFormatAcknowledgement(requests[0], 41))
    await expect(running).resolves.toBe('stale')
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('ready')

    await expect(store.setter(runToolbarMutationAtom, input)).resolves.toBe('completed')
    expect(setFormatRange).toHaveBeenCalledTimes(2)
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test('keeps a partially acknowledged border batch outcome unknown and reconciles without resend', async () => {
    const store = createStore()
    let callCount = 0
    const setFormatRange = jest.fn(async (request: SetFormatRangeRequest) => {
      callCount += 1
      if (callCount === 2) throw new Error('connection lost after first ACK')
      return strictFormatAcknowledgement(request, 10)
    })
    const refreshProjection = jest.fn(async () => undefined)

    const outcome = await store.setter(runToolbarMutationAtom, {
      source: { setFormatRange },
      sheetId: 'Sheet1',
      operation: 'border-batch',
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      steps: [
        {
          kind: 'set-format-range',
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          format: { borders: { right: { style: 'thin' } } },
        },
        {
          kind: 'set-format-range',
          range: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
          format: { borders: { left: { style: 'thin' } } },
        },
      ],
      refreshProjection,
    })

    expect(outcome).toBe('outcome-unknown')
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      acknowledgedRevision: 10,
      acknowledgedCount: 1,
      totalCount: 2,
      canRetryRefresh: true,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(await store.setter(retryToolbarMutationAtom)).toBe('blocked')
    expect(setFormatRange).toHaveBeenCalledTimes(2)

    expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('outcome-unknown')
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(setFormatRange).toHaveBeenCalledTimes(2)
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      canRetryRefresh: false,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('treats a mismatched ACK as outcome unknown and allows refresh-only reconciliation', async () => {
    const store = createStore()
    const setFormatRange = jest.fn(async (request: SetFormatRangeRequest) => ({
      ...strictFormatAcknowledgement(request, 11),
      requestId: (request.requestId ?? 0) + 1,
    }))
    const refreshProjection = jest.fn(async () => undefined)

    expect(
      await store.setter(runToolbarMutationAtom, {
        source: { setFormatRange },
        sheetId: 'Sheet1',
        operation: 'format',
        affectedRange: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
        steps: [
          {
            kind: 'set-format-range',
            range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
            format: { underline: true },
          },
        ],
        refreshProjection,
      }),
    ).toBe('outcome-unknown')
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      acknowledgedCount: 0,
      canRetryRefresh: true,
    })
    expect(await store.setter(retryToolbarMutationAtom)).toBe('blocked')
    expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('outcome-unknown')
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test.each(MALFORMED_TOOLBAR_ACK_CASES)(
    'fails the strict ACK contract for %s and permits refresh-only recovery',
    async (_case, createResult) => {
      const store = createStore()
      const setFormatRange = jest.fn(
        async (request: SetFormatRangeRequest) =>
          createResult(request) as ToolbarBackendMutationResult,
      )
      const refreshProjection = jest.fn(async () => undefined)

      expect(
        await store.setter(runToolbarMutationAtom, {
          source: { setFormatRange },
          sheetId: 'Sheet1',
          operation: 'format',
          affectedRange: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
          steps: [
            {
              kind: 'set-format-range',
              range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
              format: { italic: true },
            },
          ],
          refreshProjection,
        }),
      ).toBe('outcome-unknown')
      expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
        status: 'outcome-unknown',
        acknowledgedRevision: null,
        acknowledgedCount: 0,
        canRetryRefresh: true,
      })
      expect(await store.setter(retryToolbarMutationAtom)).toBe('blocked')
      expect(setFormatRange).toHaveBeenCalledTimes(1)
      expect(refreshProjection).not.toHaveBeenCalled()
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)

      expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('outcome-unknown')
      expect(setFormatRange).toHaveBeenCalledTimes(1)
      expect(refreshProjection).toHaveBeenCalledTimes(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
        status: 'outcome-unknown',
        canRetryRefresh: false,
      })
    },
  )

  test('retries only refresh after ACK without duplicating mutation or history', async () => {
    const store = createStore()
    const setFormatRange = jest.fn(async (request: SetFormatRangeRequest) =>
      strictFormatAcknowledgement(request, 12),
    )
    let refreshAttempt = 0
    const refreshProjection = jest.fn(async () => {
      refreshAttempt += 1
      if (refreshAttempt === 1) throw new Error('projection unavailable')
    })

    expect(
      await store.setter(runToolbarMutationAtom, {
        source: { setFormatRange },
        sheetId: 'Sheet1',
        operation: 'format',
        affectedRange: { rowStart: 3, rowEnd: 3, colStart: 3, colEnd: 3 },
        steps: [
          {
            kind: 'set-format-range',
            range: { rowStart: 3, rowEnd: 3, colStart: 3, colEnd: 3 },
            format: { wrap: true },
          },
        ],
        refreshProjection,
      }),
    ).toBe('refresh-failed')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(resetToolbarMutationAtom)).toBe(false)
    expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
      status: 'refresh-failed',
      canRetryRefresh: true,
    })

    expect(await store.setter(retryToolbarMutationRefreshAtom)).toBe('completed')
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(refreshProjection).toHaveBeenCalledTimes(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('ready')
  })
})

function strictFormatAcknowledgement(
  request: SetFormatRangeRequest,
  revision: number | string,
): ToolbarBackendMutationResult {
  return {
    kind: request.kind,
    sheetId: request.sheetId,
    requestId: request.requestId,
    affectedRange: { ...request.range },
    revision,
  }
}

function strictRangeAcknowledgement(
  request: MergeRangeRequest | UnmergeRangeRequest,
  revision: number | string,
): ToolbarBackendMutationResult {
  return {
    kind: request.kind,
    sheetId: request.sheetId,
    requestId: request.requestId,
    affectedRange: { ...request.range },
    revision,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
