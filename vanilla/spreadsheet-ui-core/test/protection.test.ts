import { describe, expect, jest, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import type { BackendMutationResult, DisplayCell } from '../src/backend/types'
import type { CellRange } from '../src/shared'
import {
  DEFAULT_PROTECTION_UNLOCK_STATE,
  DEFAULT_SHEET_PROTECTION,
  DEFAULT_SHEET_PROTECTION_LOAD_STATE,
  MAX_UNLOCKED_RANGES,
  activeCellLockedAtom,
  applyWorkbookRestoredProtectionAtom,
  clearSheetProtectionAtom,
  closeProtectionUnlockAtom,
  getSheetProtection,
  isCoordUnlocked,
  isRangeFullyUnlocked,
  isRangePartiallyUnlocked,
  loadSheetProtectionAtom,
  openProtectionUnlockAtom,
  protectionUnlockMutationBlockedAtom,
  protectionUnlockPasswordAtom,
  protectionUnlockPhaseAtom,
  protectionUnlockRecoveryRequiredAtom,
  protectionUnlockStateAtom,
  rangesIntersect,
  refreshProtectionUnlockAtom,
  selectionLockedAtom,
  setProtectionUnlockPasswordAtom,
  setSheetProtectionAtom,
  sheetProtectionAtom,
  sheetProtectionLoadStateAtom,
  submitProtectionUnlockAtom,
  type CorrelatedSetRangeLockRequest,
  type ReadSheetProtectionPort,
  type ReadSheetProtectionRequest,
  type ReadSheetProtectionResult,
  type SetRangeLockConfirmedNotAppliedError,
  type SetRangeLockAcknowledgedResult,
  type SetRangeLockPort,
  type SetRangeLockRequest,
  type SetRangeLockResult,
  type SheetProtectionState,
  type VerifySheetProtectionPort,
} from '../src/protection'
import { selectionAtom } from '../src/selection'

const TARGET_RANGE: CellRange = {
  rowStart: 2,
  rowEnd: 4,
  colStart: 3,
  colEnd: 5,
}

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushAsyncWork(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index++) {
    await Promise.resolve()
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function copyRange(range: Readonly<CellRange>): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function acknowledged(
  request: CorrelatedSetRangeLockRequest,
  revision: ReadSheetProtectionResult['revision'] = 2,
): SetRangeLockAcknowledgedResult {
  return {
    kind: 'set-range-lock',
    outcome: 'acknowledged',
    requestId: request.requestId,
    sheetId: request.sheetId,
    affectedRange: copyRange(request.range),
    revision,
  }
}

function confirmedNotApplied(request: CorrelatedSetRangeLockRequest): SetRangeLockResult {
  return {
    kind: 'set-range-lock',
    outcome: 'confirmed-not-applied',
    code: 'PERMISSION_DENIED',
    message: 'You cannot edit this protected range.',
    requestId: request.requestId,
    sheetId: request.sheetId,
    affectedRange: copyRange(request.range),
  }
}

function canonicalResult(
  request: ReadSheetProtectionRequest,
  protection: SheetProtectionState,
  revision: ReadSheetProtectionResult['revision'] = 2,
): ReadSheetProtectionResult {
  return {
    kind: 'read-sheet-protection',
    requestId: request.requestId,
    sheetId: request.sheetId,
    revision,
    protection,
  }
}

function unlockedCanonicalRead(): ReadSheetProtectionPort {
  return async (request) =>
    canonicalResult(request, {
      mode: 'protected',
      unlockedRanges: [copyRange(TARGET_RANGE)],
    })
}

function openLockedRange(
  store: Store,
  sheetId = 'sheet-1',
  range: Readonly<CellRange> = TARGET_RANGE,
): void {
  store.setter(setSheetProtectionAtom, {
    sheetId,
    state: { mode: 'protected', unlockedRanges: [] },
  })
  store.setter(openProtectionUnlockAtom, { sheetId, range })
}

describe('canonical protection state', () => {
  test('keeps the online Excel defaults and explicitly rejects more than 256 ranges', () => {
    expect(MAX_UNLOCKED_RANGES).toBe(256)
    expect(DEFAULT_SHEET_PROTECTION).toEqual({ mode: 'open', unlockedRanges: [] })

    const store = createStore()
    const ranges = Array.from({ length: MAX_UNLOCKED_RANGES }, (_, row) => ({
      rowStart: row,
      rowEnd: row,
      colStart: 0,
      colEnd: 0,
    }))
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: ranges },
    })

    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toHaveLength(
      MAX_UNLOCKED_RANGES,
    )

    expect(() =>
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-1',
        state: {
          mode: 'protected',
          unlockedRanges: [
            ...ranges,
            {
              rowStart: MAX_UNLOCKED_RANGES,
              rowEnd: MAX_UNLOCKED_RANGES,
              colStart: 0,
              colEnd: 0,
            },
          ],
        },
      }),
    ).toThrow(`Sheet protection cannot contain more than ${MAX_UNLOCKED_RANGES} unlocked ranges.`)
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toHaveLength(
      MAX_UNLOCKED_RANGES,
    )
  })

  test('publishes ordinary immutable snapshots and does not retain caller arrays', () => {
    const store = createStore()
    const range = copyRange(TARGET_RANGE)
    const ranges = [range]
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: ranges },
    })
    ranges.push({ rowStart: 20, rowEnd: 20, colStart: 20, colEnd: 20 })
    range.rowStart = 99

    const canonical = store.getter(sheetProtectionAtom)
    expect(canonical['sheet-1'].unlockedRanges).toEqual([TARGET_RANGE])
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical['sheet-1'])).toBe(true)
    expect(Object.isFrozen(canonical['sheet-1'].unlockedRanges)).toBe(true)
    expect(Object.isFrozen(canonical['sheet-1'].unlockedRanges[0])).toBe(true)
  })

  test('stores and clears sheet entries through commands', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-A',
      state: { mode: 'protected', unlockedRanges: [TARGET_RANGE] },
    })
    expect(getSheetProtection(store.getter(sheetProtectionAtom), 'sheet-A').mode).toBe('protected')

    store.setter(clearSheetProtectionAtom, 'sheet-A')
    expect(store.getter(sheetProtectionAtom)['sheet-A']).toBeUndefined()
    expect(getSheetProtection(store.getter(sheetProtectionAtom), 'sheet-A')).toBe(
      DEFAULT_SHEET_PROTECTION,
    )
  })

  test.each(['__proto__', 'constructor', 'toString'])(
    'treats the legal sheet id %s as an own map key',
    (sheetId) => {
      const store = createStore()
      const state: SheetProtectionState = {
        mode: 'protected',
        unlockedRanges: [copyRange(TARGET_RANGE)],
      }

      expect(getSheetProtection(store.getter(sheetProtectionAtom), sheetId)).toBe(
        DEFAULT_SHEET_PROTECTION,
      )

      store.setter(setSheetProtectionAtom, { sheetId, state })
      const protectionBySheet = store.getter(sheetProtectionAtom)
      expect(Object.prototype.hasOwnProperty.call(protectionBySheet, sheetId)).toBe(true)
      expect(getSheetProtection(protectionBySheet, sheetId)).toEqual(state)

      store.setter(clearSheetProtectionAtom, sheetId)
      const cleared = store.getter(sheetProtectionAtom)
      expect(Object.prototype.hasOwnProperty.call(cleared, sheetId)).toBe(false)
      expect(getSheetProtection(cleared, sheetId)).toBe(DEFAULT_SHEET_PROTECTION)
    },
  )

  test('canonical state is isolated between Einfach stores', () => {
    const first = createStore()
    const second = createStore()
    first.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    expect(first.getter(sheetProtectionAtom)['sheet-1']?.mode).toBe('protected')
    expect(second.getter(sheetProtectionAtom)).toEqual({})
  })
})

describe('canonical protection load lifecycle', () => {
  test('starts idle and does not present the open fallback as loaded backend state', () => {
    const store = createStore()

    expect(store.getter(sheetProtectionLoadStateAtom)).toBe(DEFAULT_SHEET_PROTECTION_LOAD_STATE)
    expect(Object.isFrozen(store.getter(sheetProtectionLoadStateAtom))).toBe(true)
    expect(getSheetProtection(store.getter(sheetProtectionAtom), 'not-loaded')).toBe(
      DEFAULT_SHEET_PROTECTION,
    )
    expect(store.getter(sheetProtectionLoadStateAtom).phase).not.toBe('ready')
  })

  test('loads one exact read result into frozen canonical and readiness snapshots', async () => {
    const store = createStore()
    const response = deferred<ReadSheetProtectionResult>()
    const readSheetProtection = jest.fn<ReadSheetProtectionPort>((request) => {
      expect(Object.isFrozen(request)).toBe(true)
      return response.promise
    })
    const setRangeLock = jest.fn<SetRangeLockPort>()

    store.setter(loadSheetProtectionAtom, {
      sheetId: 'sheet-1',
      readSheetProtection,
    })

    const request = readSheetProtection.mock.calls[0][0]
    expect(request).toEqual({
      kind: 'read-sheet-protection',
      sheetId: 'sheet-1',
      requestId: 1,
    })
    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'loading',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: null,
      pending: true,
      error: null,
    })
    expect(setRangeLock).not.toHaveBeenCalled()

    response.resolve(
      canonicalResult(
        request,
        { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
        'sheet-1-revision-4',
      ),
    )
    await flushAsyncWork()

    const load = store.getter(sheetProtectionLoadStateAtom)
    const canonical = store.getter(sheetProtectionAtom)['sheet-1']
    expect(load).toEqual({
      phase: 'ready',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 'sheet-1-revision-4',
      pending: false,
      error: null,
    })
    expect(canonical).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
    expect(Object.isFrozen(load)).toBe(true)
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical.unlockedRanges)).toBe(true)
    expect(Object.isFrozen(canonical.unlockedRanges[0])).toBe(true)
  })

  test.each(['success', 'error'] as const)(
    'ignores a late sheet A %s after sheet B becomes the load target',
    async (lateOutcome) => {
      const store = createStore()
      const sheetA = deferred<ReadSheetProtectionResult>()
      const sheetB = deferred<ReadSheetProtectionResult>()
      const requests: ReadSheetProtectionRequest[] = []
      const readSheetProtection: ReadSheetProtectionPort = (request) => {
        requests.push(request)
        return request.sheetId === 'sheet-A' ? sheetA.promise : sheetB.promise
      }
      const oldSheetA: SheetProtectionState = {
        mode: 'protected',
        unlockedRanges: [],
      }
      store.setter(setSheetProtectionAtom, { sheetId: 'sheet-A', state: oldSheetA })

      store.setter(loadSheetProtectionAtom, { sheetId: 'sheet-A', readSheetProtection })
      store.setter(loadSheetProtectionAtom, { sheetId: 'sheet-B', readSheetProtection })
      expect(requests.map(({ sheetId, requestId }) => ({ sheetId, requestId }))).toEqual([
        { sheetId: 'sheet-A', requestId: 1 },
        { sheetId: 'sheet-B', requestId: 2 },
      ])

      if (lateOutcome === 'success') {
        sheetA.resolve(
          canonicalResult(requests[0], { mode: 'open', unlockedRanges: [] }, 'stale-A'),
        )
      } else {
        sheetA.reject(new Error('stale A failed'))
      }
      await flushAsyncWork()

      expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
        phase: 'loading',
        sheetId: 'sheet-B',
        requestId: 2,
        pending: true,
        error: null,
      })
      expect(store.getter(sheetProtectionAtom)['sheet-A']).toEqual(oldSheetA)

      sheetB.resolve(
        canonicalResult(
          requests[1],
          { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
          'current-B',
        ),
      )
      await flushAsyncWork()

      expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
        phase: 'ready',
        sheetId: 'sheet-B',
        requestId: 2,
        revision: 'current-B',
        pending: false,
        error: null,
      })
      expect(store.getter(sheetProtectionAtom)['sheet-B']).toEqual({
        mode: 'protected',
        unlockedRanges: [TARGET_RANGE],
      })
    },
  )

  test('reports a missing read capability without manufacturing canonical open state', () => {
    const store = createStore()

    store.setter(loadSheetProtectionAtom, { sheetId: 'sheet-unsupported' })

    expect(store.getter(sheetProtectionLoadStateAtom)).toEqual({
      phase: 'unsupported',
      sheetId: 'sheet-unsupported',
      requestId: null,
      revision: null,
      pending: false,
      error: 'Protection status loading is unavailable.',
    })
    expect(
      Object.prototype.hasOwnProperty.call(store.getter(sheetProtectionAtom), 'sheet-unsupported'),
    ).toBe(false)
    expect(store.getter(sheetProtectionLoadStateAtom).phase).not.toBe('ready')
  })

  test('reports read failure and retains the previous canonical sheet snapshot', async () => {
    const store = createStore()
    const oldCanonical: SheetProtectionState = {
      mode: 'protected',
      unlockedRanges: [copyRange(TARGET_RANGE)],
    }
    store.setter(setSheetProtectionAtom, { sheetId: 'sheet-1', state: oldCanonical })

    store.setter(loadSheetProtectionAtom, {
      sheetId: 'sheet-1',
      readSheetProtection: async () => {
        throw new Error('Workbook read failed')
      },
    })
    await flushAsyncWork()

    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'error',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: null,
      pending: false,
      error: 'Workbook read failed',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual(oldCanonical)
  })

  test.each([
    [
      'requestId',
      (request: ReadSheetProtectionRequest) => ({
        ...canonicalResult(request, { mode: 'open', unlockedRanges: [] }),
        requestId: request.requestId + 1,
      }),
    ],
    [
      'sheetId',
      (request: ReadSheetProtectionRequest) => ({
        ...canonicalResult(request, { mode: 'open', unlockedRanges: [] }),
        sheetId: 'another-sheet',
      }),
    ],
    [
      'revision',
      (request: ReadSheetProtectionRequest) => ({
        ...canonicalResult(request, { mode: 'open', unlockedRanges: [] }),
        revision: '   ',
      }),
    ],
  ] as const)(
    'rejects a response with mismatched %s and retains old canonical',
    async (_, make) => {
      const store = createStore()
      const oldCanonical: SheetProtectionState = {
        mode: 'protected',
        unlockedRanges: [],
      }
      store.setter(setSheetProtectionAtom, { sheetId: 'sheet-1', state: oldCanonical })
      store.setter(loadSheetProtectionAtom, {
        sheetId: 'sheet-1',
        readSheetProtection: async (request) => make(request) as ReadSheetProtectionResult,
      })
      await flushAsyncWork()

      expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
        phase: 'error',
        sheetId: 'sheet-1',
        pending: false,
        error: 'Protection status response did not match the request.',
      })
      expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual(oldCanonical)
    },
  )

  test('rejects more than 256 backend ranges and retains old canonical', async () => {
    const store = createStore()
    const oldCanonical: SheetProtectionState = {
      mode: 'protected',
      unlockedRanges: [copyRange(TARGET_RANGE)],
    }
    const tooManyRanges = Array.from({ length: MAX_UNLOCKED_RANGES + 1 }, (_, row) => ({
      rowStart: row,
      rowEnd: row,
      colStart: 0,
      colEnd: 0,
    }))
    store.setter(setSheetProtectionAtom, { sheetId: 'sheet-1', state: oldCanonical })

    store.setter(loadSheetProtectionAtom, {
      sheetId: 'sheet-1',
      readSheetProtection: async (request) =>
        canonicalResult(request, { mode: 'protected', unlockedRanges: tooManyRanges }),
    })
    await flushAsyncWork()

    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'error',
      sheetId: 'sheet-1',
      pending: false,
      error: 'Protection status response did not match the request.',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual(oldCanonical)
  })

  test.each(['__proto__', 'constructor', 'toString'])(
    'loads the legal sheet id %s as an own canonical map key',
    async (sheetId) => {
      const store = createStore()
      store.setter(loadSheetProtectionAtom, {
        sheetId,
        readSheetProtection: async (request) =>
          canonicalResult(request, {
            mode: 'protected',
            unlockedRanges: [copyRange(TARGET_RANGE)],
          }),
      })
      await flushAsyncWork()

      const canonical = store.getter(sheetProtectionAtom)
      expect(Object.prototype.hasOwnProperty.call(canonical, sheetId)).toBe(true)
      expect(canonical[sheetId]).toEqual({
        mode: 'protected',
        unlockedRanges: [TARGET_RANGE],
      })
      expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
        phase: 'ready',
        sheetId,
      })
    },
  )
})

describe('workbook restore protection refresh', () => {
  test('clears every cached sheet and reloads the restored current sheet exactly once', async () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-current',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-current',
      state: { mode: 'protected', unlockedRanges: [] },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-stale',
      state: { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
    })
    const readSheetProtection = jest.fn<ReadSheetProtectionPort>(async (request) =>
      canonicalResult(
        request,
        { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
        'restored-revision',
      ),
    )

    store.setter(applyWorkbookRestoredProtectionAtom, {
      restored: {
        kind: 'workbook-restored',
        sheetIds: ['sheet-current', 'sheet-restored'],
      },
      readSheetProtection,
    })

    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
    expect(readSheetProtection.mock.calls[0][0]).toEqual({
      kind: 'read-sheet-protection',
      sheetId: 'sheet-current',
      requestId: 1,
    })
    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'loading',
      sheetId: 'sheet-current',
      requestId: 1,
      pending: true,
    })

    await flushAsyncWork()

    expect(store.getter(sheetProtectionAtom)).toEqual({
      'sheet-current': {
        mode: 'protected',
        unlockedRanges: [TARGET_RANGE],
      },
    })
    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'ready',
      sheetId: 'sheet-current',
      revision: 'restored-revision',
      pending: false,
    })
  })

  test('leaves the load idle when restore removes the selected sheet and ignores the old read', async () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-removed',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-removed',
      state: { mode: 'protected', unlockedRanges: [] },
    })
    const staleRead = deferred<ReadSheetProtectionResult>()
    const requests: ReadSheetProtectionRequest[] = []
    const readSheetProtection: ReadSheetProtectionPort = (request) => {
      requests.push(request)
      return staleRead.promise
    }
    store.setter(loadSheetProtectionAtom, {
      sheetId: 'sheet-removed',
      readSheetProtection,
    })

    store.setter(applyWorkbookRestoredProtectionAtom, {
      restored: { kind: 'workbook-restored', sheetIds: ['sheet-survivor'] },
      readSheetProtection,
    })

    expect(requests).toHaveLength(1)
    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(store.getter(sheetProtectionLoadStateAtom)).toEqual({
      phase: 'idle',
      sheetId: null,
      requestId: null,
      revision: null,
      pending: false,
      error: null,
    })

    staleRead.resolve(
      canonicalResult(
        requests[0],
        { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
        'stale-revision',
      ),
    )
    await flushAsyncWork()

    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(store.getter(sheetProtectionLoadStateAtom).phase).toBe('idle')
  })

  test('uses the existing unsupported state when the restored current sheet has no read port', () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-current',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-current',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    store.setter(applyWorkbookRestoredProtectionAtom, {
      restored: { kind: 'workbook-restored', sheetIds: ['sheet-current'] },
    })

    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(store.getter(sheetProtectionLoadStateAtom)).toEqual({
      phase: 'unsupported',
      sheetId: 'sheet-current',
      requestId: null,
      revision: null,
      pending: false,
      error: 'Protection status loading is unavailable.',
    })
  })

  test('keeps only the newest rapid-restore read result', async () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-current',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    const reads = [deferred<ReadSheetProtectionResult>(), deferred<ReadSheetProtectionResult>()]
    const requests: ReadSheetProtectionRequest[] = []
    const readSheetProtection: ReadSheetProtectionPort = (request) => {
      const response = reads[requests.length]
      requests.push(request)
      return response.promise
    }

    store.setter(applyWorkbookRestoredProtectionAtom, {
      restored: { kind: 'workbook-restored', sheetIds: ['sheet-current'] },
      readSheetProtection,
    })
    store.setter(applyWorkbookRestoredProtectionAtom, {
      restored: { kind: 'workbook-restored', sheetIds: ['sheet-current'] },
      readSheetProtection,
    })

    expect(requests.map(({ requestId }) => requestId)).toEqual([1, 2])
    reads[1].resolve(
      canonicalResult(
        requests[1],
        { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
        'newest-revision',
      ),
    )
    await flushAsyncWork()
    reads[0].resolve(
      canonicalResult(requests[0], { mode: 'open', unlockedRanges: [] }, 'stale-revision'),
    )
    await flushAsyncWork()

    expect(store.getter(sheetProtectionAtom)['sheet-current']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'ready',
      requestId: 2,
      revision: 'newest-revision',
      pending: false,
    })
  })

  test('reports the new read error after clearing restored protection state', async () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-current',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-current',
      state: { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
    })

    store.setter(applyWorkbookRestoredProtectionAtom, {
      restored: { kind: 'workbook-restored', sheetIds: ['sheet-current'] },
      readSheetProtection: async () => {
        throw new Error('Restored workbook protection read failed')
      },
    })
    await flushAsyncWork()

    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(store.getter(sheetProtectionLoadStateAtom)).toMatchObject({
      phase: 'error',
      sheetId: 'sheet-current',
      requestId: 1,
      revision: null,
      pending: false,
      error: 'Restored workbook protection read failed',
    })
  })
})

describe('protection range helpers and derived locks', () => {
  const protectedState = {
    'sheet-1': {
      mode: 'protected' as const,
      unlockedRanges: [{ rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }],
    },
  }

  test('detects intersections and cell lock state', () => {
    expect(rangesIntersect(TARGET_RANGE, { rowStart: 4, rowEnd: 6, colStart: 5, colEnd: 7 })).toBe(
      true,
    )
    expect(rangesIntersect(TARGET_RANGE, { rowStart: 5, rowEnd: 6, colStart: 3, colEnd: 5 })).toBe(
      false,
    )
    expect(isCoordUnlocked(protectedState, 'sheet-1', { row: 2, col: 2 })).toBe(true)
    expect(isCoordUnlocked(protectedState, 'sheet-1', { row: 8, col: 8 })).toBe(false)
    expect(isCoordUnlocked({}, 'unknown', { row: 8, col: 8 })).toBe(true)
  })

  test('distinguishes fully unlocked, partially unlocked, and locked ranges', () => {
    expect(
      isRangeFullyUnlocked(protectedState, 'sheet-1', {
        rowStart: 1,
        rowEnd: 3,
        colStart: 1,
        colEnd: 3,
      }),
    ).toBe(true)
    expect(
      isRangePartiallyUnlocked(protectedState, 'sheet-1', {
        rowStart: 3,
        rowEnd: 6,
        colStart: 0,
        colEnd: 4,
      }),
    ).toBe(true)
    expect(
      isRangeFullyUnlocked(protectedState, 'sheet-1', {
        rowStart: 7,
        rowEnd: 8,
        colStart: 7,
        colEnd: 8,
      }),
    ).toBe(false)
  })

  test('recognizes complete and incomplete coverage for a large range', () => {
    const state = {
      'sheet-1': {
        mode: 'protected' as const,
        unlockedRanges: [{ rowStart: 0, rowEnd: 500, colStart: 0, colEnd: 500 }],
      },
    }
    expect(
      isRangeFullyUnlocked(state, 'sheet-1', {
        rowStart: 0,
        rowEnd: 100,
        colStart: 0,
        colEnd: 100,
      }),
    ).toBe(true)
    expect(
      isRangeFullyUnlocked(
        {
          'sheet-1': {
            mode: 'protected',
            unlockedRanges: [{ rowStart: 0, rowEnd: 50, colStart: 0, colEnd: 100 }],
          },
        },
        'sheet-1',
        { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 100 },
      ),
    ).toBe(false)
  })

  test('merges multiple rectangles that jointly cover more than 10,000 cells', () => {
    const target = { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 100 }
    const state = {
      'sheet-1': {
        mode: 'protected' as const,
        unlockedRanges: [
          { rowStart: 0, rowEnd: 49, colStart: 0, colEnd: 49 },
          { rowStart: 0, rowEnd: 49, colStart: 50, colEnd: 100 },
          { rowStart: 50, rowEnd: 100, colStart: 0, colEnd: 49 },
          { rowStart: 50, rowEnd: 100, colStart: 50, colEnd: 100 },
        ],
      },
    }

    expect(isRangeFullyUnlocked(state, 'sheet-1', target)).toBe(true)
    expect(isRangePartiallyUnlocked(state, 'sheet-1', target)).toBe(false)
  })

  test('detects partial coverage when only the far end of a large range is unlocked', () => {
    const target = { rowStart: 0, rowEnd: 200, colStart: 0, colEnd: 100 }
    const state = {
      'sheet-1': {
        mode: 'protected' as const,
        unlockedRanges: [{ rowStart: 200, rowEnd: 200, colStart: 100, colEnd: 100 }],
      },
    }

    expect(isRangeFullyUnlocked(state, 'sheet-1', target)).toBe(false)
    expect(isRangePartiallyUnlocked(state, 'sheet-1', target)).toBe(true)
  })

  test('covers a range ending at MAX_SAFE_INTEGER without creating an unsafe boundary', () => {
    const lastRow = Number.MAX_SAFE_INTEGER
    const target = { rowStart: 0, rowEnd: lastRow, colStart: 0, colEnd: 0 }
    const state = {
      'sheet-1': {
        mode: 'protected' as const,
        unlockedRanges: [
          { rowStart: 0, rowEnd: lastRow - 1, colStart: 0, colEnd: 0 },
          { rowStart: lastRow, rowEnd: lastRow, colStart: 0, colEnd: 0 },
        ],
      },
    }

    expect(isRangeFullyUnlocked(state, 'sheet-1', target)).toBe(true)
    expect(isRangePartiallyUnlocked(state, 'sheet-1', target)).toBe(false)
  })

  test('derives active-cell and selection locks from canonical state', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: protectedState['sheet-1'],
    })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 8, col: 8 },
      focus: { row: 8, col: 8 },
    })
    expect(store.getter(activeCellLockedAtom)).toBe(true)
    expect(store.getter(selectionLockedAtom)).toBe('locked')

    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 3, col: 0 },
      focus: { row: 6, col: 4 },
    })
    expect(store.getter(selectionLockedAtom)).toBe('partial')

    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
    })
    expect(store.getter(activeCellLockedAtom)).toBe(false)
    expect(store.getter(selectionLockedAtom)).toBe('open')
  })
})

describe('unlock dialog state commands', () => {
  test('starts closed, opens in Editing, tracks password, and closes', () => {
    const store = createStore()
    expect(store.getter(protectionUnlockStateAtom)).toEqual(DEFAULT_PROTECTION_UNLOCK_STATE)
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('')

    openLockedRange(store)
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      isOpen: true,
      pending: false,
      error: null,
    })
    store.setter(setProtectionUnlockPasswordAtom, 'password')
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('password')

    store.setter(closeProtectionUnlockAtom)
    expect(store.getter(protectionUnlockStateAtom)).toEqual(DEFAULT_PROTECTION_UNLOCK_STATE)
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('')
  })

  test('clears the password for every new dialog session and target', () => {
    const store = createStore()
    store.setter(setProtectionUnlockPasswordAtom, 'ignored-while-closed')
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })
    store.setter(setProtectionUnlockPasswordAtom, 'sheet-one-secret')
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-2', range: TARGET_RANGE })
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('')

    store.setter(setProtectionUnlockPasswordAtom, 'sheet-two-secret')
    store.setter(closeProtectionUnlockAtom)
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('')
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-3', range: TARGET_RANGE })
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('')
  })

  test('publishes frozen lifecycle and target snapshots', () => {
    const store = createStore()
    const callerRange = copyRange(TARGET_RANGE)
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1', range: callerRange })
    callerRange.rowStart = 99

    const state = store.getter(protectionUnlockStateAtom)
    expect(state.target?.range).toEqual(TARGET_RANGE)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.target)).toBe(true)
    expect(Object.isFrozen(state.target?.range)).toBe(true)
  })

  test('keeps form and request identity isolated between stores', async () => {
    const first = createStore()
    const second = createStore()
    openLockedRange(first)
    openLockedRange(second)
    first.setter(setProtectionUnlockPasswordAtom, 'first')

    const requests: CorrelatedSetRangeLockRequest[] = []
    const setRangeLock: SetRangeLockPort = async (request) => {
      requests.push(request)
      return acknowledged(request)
    }
    first.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    second.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()

    expect(requests.map((request) => request.requestId)).toEqual([1, 1])
    expect(first.getter(protectionUnlockPasswordAtom)).toBe('')
    expect(second.getter(protectionUnlockPasswordAtom)).toBe('')
  })
})

describe('unlock capability and verification gates', () => {
  test('requires set and canonical read before verifier or mutation runs', () => {
    const store = createStore()
    openLockedRange(store)
    const verifySheetProtection = jest.fn(async () => ({ ok: true }))
    const setRangeLock = jest.fn<SetRangeLockPort>()

    store.setter(submitProtectionUnlockAtom, {
      verifySheetProtection,
      setRangeLock,
    })

    expect(verifySheetProtection).not.toHaveBeenCalled()
    expect(setRangeLock).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      pending: false,
      error: 'Protection editing and status refresh are unavailable.',
    })
  })

  test('rejects a target without a range before invoking any port', () => {
    const store = createStore()
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1' })
    const setRangeLock = jest.fn<SetRangeLockPort>()
    const readSheetProtection = jest.fn<ReadSheetProtectionPort>()
    store.setter(submitProtectionUnlockAtom, { setRangeLock, readSheetProtection })

    expect(setRangeLock).not.toHaveBeenCalled()
    expect(readSheetProtection).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom).error).toBe('Select a range to unlock.')
  })

  test.each([
    ['negative coordinate', { rowStart: -1, rowEnd: 1, colStart: 0, colEnd: 1 }],
    ['fractional coordinate', { rowStart: 0.5, rowEnd: 1, colStart: 0, colEnd: 1 }],
    [
      'unsafe coordinate',
      { rowStart: 0, rowEnd: Number.MAX_SAFE_INTEGER + 1, colStart: 0, colEnd: 1 },
    ],
    ['reversed rows', { rowStart: 2, rowEnd: 1, colStart: 0, colEnd: 1 }],
    ['reversed columns', { rowStart: 0, rowEnd: 1, colStart: 2, colEnd: 1 }],
  ])('rejects an ordinary invalid range (%s) before invoking any port', (_label, range) => {
    const store = createStore()
    openLockedRange(store, 'sheet-1', range)
    const verifySheetProtection = jest.fn<VerifySheetProtectionPort>()
    const setRangeLock = jest.fn<SetRangeLockPort>()
    const readSheetProtection = jest.fn<ReadSheetProtectionPort>()

    store.setter(submitProtectionUnlockAtom, {
      verifySheetProtection,
      setRangeLock,
      readSheetProtection,
    })

    expect(verifySheetProtection).not.toHaveBeenCalled()
    expect(setRangeLock).not.toHaveBeenCalled()
    expect(readSheetProtection).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Select a valid range to unlock.',
    })
  })

  test('verification rejection remains Editing and never mutates', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn<SetRangeLockPort>()
    const verifySheetProtection: VerifySheetProtectionPort = async () => ({
      ok: false,
      message: 'Incorrect password',
    })
    store.setter(submitProtectionUnlockAtom, {
      verifySheetProtection,
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    expect(store.getter(protectionUnlockPhaseAtom)).toBe('verifying')
    await flushAsyncWork()

    expect(setRangeLock).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Incorrect password',
    })
    expect(store.getter(protectionUnlockMutationBlockedAtom)).toBe(false)
  })

  test('verifier Promise rejection and timeout are retryable Editing failures', async () => {
    const rejectedStore = createStore()
    openLockedRange(rejectedStore)
    rejectedStore.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: async () => {
        throw new Error('Verifier unavailable')
      },
      setRangeLock: async (request) => acknowledged(request),
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()
    expect(rejectedStore.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Verifier unavailable',
    })

    const timeoutStore = createStore()
    openLockedRange(timeoutStore)
    const verification = deferred<{ ok: boolean }>()
    const setRangeLock = jest.fn<SetRangeLockPort>()
    timeoutStore.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: () => verification.promise,
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
      verifyTimeoutMs: 5,
    })
    await wait(15)
    expect(setRangeLock).not.toHaveBeenCalled()
    expect(timeoutStore.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Password verification timed out. Try again.',
    })
  })

  test('deduplicates repeated submit while verification is pending', async () => {
    const store = createStore()
    openLockedRange(store)
    const verification = deferred<{ ok: boolean }>()
    const verifySheetProtection = jest.fn(() => verification.promise)
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request),
    )
    const input = {
      verifySheetProtection,
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    }
    store.setter(submitProtectionUnlockAtom, input)
    store.setter(submitProtectionUnlockAtom, input)
    expect(verifySheetProtection).toHaveBeenCalledTimes(1)
    expect(setRangeLock).not.toHaveBeenCalled()

    verification.resolve({ ok: true })
    await flushAsyncWork()
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
  })

  test('closing and reopening while verifying prevents the stale mutation', async () => {
    const store = createStore()
    openLockedRange(store, 'sheet-old')
    const verification = deferred<{ ok: boolean }>()
    const setRangeLock = jest.fn<SetRangeLockPort>()
    store.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: () => verification.promise,
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    store.setter(closeProtectionUnlockAtom)
    openLockedRange(store, 'sheet-new')
    verification.resolve({ ok: true })
    await flushAsyncWork()

    expect(setRangeLock).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      target: { sheetId: 'sheet-new' },
    })
  })
})

describe('mutation result classification', () => {
  test('a generic backend result without a strict ACK requires recovery', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn(
      async (request: SetRangeLockRequest): Promise<BackendMutationResult> => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 2,
        affectedRange: copyRange(request.range),
      }),
    )
    const readSheetProtection = jest.fn(unlockedCanonicalRead())

    store.setter(submitProtectionUnlockAtom, { setRangeLock, readSheetProtection })
    await flushAsyncWork()

    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      error: 'The protection response did not match the request. Refresh before retrying.',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [],
    })
  })

  test('a generic synchronous backend throw requires recovery and is never replayed', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn((_request: CorrelatedSetRangeLockRequest) => {
      throw new Error('Backend unavailable before dispatch')
    })
    const input = {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    }
    store.setter(submitProtectionUnlockAtom, input)
    await flushAsyncWork()

    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      error: 'The protection change outcome is unknown. Refresh before retrying.',
    })
    expect(store.getter(protectionUnlockMutationBlockedAtom)).toBe(true)

    store.setter(submitProtectionUnlockAtom, input)
    await flushAsyncWork()
    expect(setRangeLock).toHaveBeenCalledTimes(1)
  })

  test('an exactly correlated synchronous confirmed-not-applied error remains Editing', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock: SetRangeLockPort = (request) => {
      const error: SetRangeLockConfirmedNotAppliedError = Object.assign(
        new Error('Permission denied before applying the change'),
        {
          kind: 'set-range-lock-error' as const,
          outcome: 'confirmed-not-applied' as const,
          code: 'PERMISSION_DENIED' as const,
          requestId: request.requestId,
          sheetId: request.sheetId,
          affectedRange: copyRange(request.range),
        },
      )
      throw error
    }
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Permission denied before applying the change',
    })
    expect(store.getter(protectionUnlockRecoveryRequiredAtom)).toBe(false)
  })

  test('typed PermissionDenied Promise rejection remains Editing', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock: SetRangeLockPort = async (request) => {
      const error: SetRangeLockConfirmedNotAppliedError = Object.assign(
        new Error('Permission denied'),
        {
          kind: 'set-range-lock-error' as const,
          outcome: 'confirmed-not-applied' as const,
          code: 'PERMISSION_DENIED' as const,
          requestId: request.requestId,
          sheetId: request.sheetId,
          affectedRange: copyRange(request.range),
        },
      )
      throw error
    }
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Permission denied',
    })
    expect(store.getter(protectionUnlockRecoveryRequiredAtom)).toBe(false)
  })

  test('confirmed-not-applied result remains Editing', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      confirmedNotApplied(request),
    )
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()

    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'You cannot edit this protected range.',
    })
  })

  test('generic Promise rejection requires recovery and blocks mutation replay', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn(async () => {
      throw new Error('Connection lost after dispatch')
    })
    const input = {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    }
    store.setter(submitProtectionUnlockAtom, input)
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required')
    expect(store.getter(protectionUnlockRecoveryRequiredAtom)).toBe(true)
    store.setter(submitProtectionUnlockAtom, input)
    await flushAsyncWork()
    expect(setRangeLock).toHaveBeenCalledTimes(1)
  })

  test('explicit outcome-unknown requires recovery', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock: SetRangeLockPort = async (request) => ({
      kind: 'set-range-lock',
      outcome: 'outcome-unknown',
      message: 'Server is reconciling the change.',
      requestId: request.requestId,
      sheetId: request.sheetId,
      affectedRange: copyRange(request.range),
    })
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      error: 'Server is reconciling the change.',
    })
  })

  test.each([
    [
      'missing affectedRange',
      (request: CorrelatedSetRangeLockRequest) => ({
        kind: 'set-range-lock',
        outcome: 'acknowledged',
        requestId: request.requestId,
        sheetId: request.sheetId,
      }),
    ],
    [
      'wrong requestId',
      (request: CorrelatedSetRangeLockRequest) => ({
        ...acknowledged(request),
        requestId: request.requestId + 1,
      }),
    ],
    [
      'wrong sheetId',
      (request: CorrelatedSetRangeLockRequest) => ({
        ...acknowledged(request),
        sheetId: 'another-sheet',
      }),
    ],
    [
      'wrong affectedRange',
      (request: CorrelatedSetRangeLockRequest) => ({
        ...acknowledged(request),
        affectedRange: { ...copyRange(request.range), rowEnd: request.range.rowEnd + 1 },
      }),
    ],
  ])('plain malformed ACK (%s) requires recovery', async (_label, makeResult) => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock: SetRangeLockPort = async (request) =>
      makeResult(request) as SetRangeLockResult
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: unlockedCanonicalRead(),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required')
    expect(store.getter(protectionUnlockStateAtom).error).toContain('did not match')
  })

  test.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '   '])(
    'an acknowledged result with invalid revision (%p) requires recovery',
    async (revision) => {
      const store = createStore()
      openLockedRange(store)
      const readSheetProtection = jest.fn<ReadSheetProtectionPort>()
      store.setter(submitProtectionUnlockAtom, {
        setRangeLock: async (request) =>
          ({ ...acknowledged(request), revision }) as SetRangeLockResult,
        readSheetProtection,
      })
      await flushAsyncWork()

      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'recovery-required',
        error: 'The protection response did not include a valid canonical revision.',
      })
      expect(readSheetProtection).not.toHaveBeenCalled()
    },
  )
})

describe('strict ACK and canonical refresh', () => {
  test('strict ACK enters CanonicalRefreshing, updates Core canonical state, then closes', async () => {
    const store = createStore()
    openLockedRange(store)
    const canonicalRead = deferred<ReadSheetProtectionResult>()
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request),
    )
    const readSheetProtection = jest.fn((request: ReadSheetProtectionRequest) => {
      expect(request.kind).toBe('read-sheet-protection')
      return canonicalRead.promise
    })
    store.setter(submitProtectionUnlockAtom, { setRangeLock, readSheetProtection })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockPhaseAtom)).toBe('canonical-refreshing')
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
    const mutationRequest = setRangeLock.mock.calls[0][0]
    const readRequest = readSheetProtection.mock.calls[0][0]
    expect(readRequest.requestId).toBe(mutationRequest.requestId)

    canonicalRead.resolve(
      canonicalResult(readRequest, {
        mode: 'protected',
        unlockedRanges: [TARGET_RANGE],
      }),
    )
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
    expect(store.getter(selectionLockedAtom)).toBe('open')
  })

  test('canonical open sheet closes the dialog', async () => {
    const store = createStore()
    openLockedRange(store)
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock: async (request) => acknowledged(request),
      readSheetProtection: async (request) =>
        canonicalResult(request, { mode: 'open', unlockedRanges: [] }),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('open')
  })

  test('a large target closes when multiple canonical ranges jointly cover it', async () => {
    const largeRange: CellRange = {
      rowStart: 0,
      rowEnd: 100,
      colStart: 0,
      colEnd: 100,
    }
    const store = createStore()
    openLockedRange(store, 'sheet-large', largeRange)
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock: async (request) => acknowledged(request),
      readSheetProtection: async (request) =>
        canonicalResult(request, {
          mode: 'protected',
          unlockedRanges: [
            { ...largeRange, rowEnd: 49 },
            { ...largeRange, rowStart: 50 },
          ],
        }),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(isRangeFullyUnlocked(store.getter(sheetProtectionAtom), 'sheet-large', largeRange)).toBe(
      true,
    )
  })

  test('canonical still-locked state returns to retryable Editing', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request),
    )
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: async (request) =>
        canonicalResult(request, { mode: 'protected', unlockedRanges: [] }),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'The range is still locked. Try again.',
    })
    expect(store.getter(protectionUnlockMutationBlockedAtom)).toBe(false)
    expect(setRangeLock).toHaveBeenCalledTimes(1)
  })

  test('canonical refresh rejection enters RecoveryRequired', async () => {
    const store = createStore()
    openLockedRange(store)
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock: async (request) => acknowledged(request),
      readSheetProtection: async () => {
        throw new Error('Read failed')
      },
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      error: 'Read failed',
    })
  })

  test('malformed canonical response enters RecoveryRequired', async () => {
    const store = createStore()
    openLockedRange(store)
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock: async (request) => acknowledged(request),
      readSheetProtection: async (request) =>
        ({
          ...canonicalResult(request, { mode: 'open', unlockedRanges: [] }),
          sheetId: 'wrong-sheet',
        }) as ReadSheetProtectionResult,
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required')
    expect(store.getter(protectionUnlockStateAtom).error).toContain('did not match')
  })

  test('canonical response over the unlocked-range cap requires recovery without truncation', async () => {
    const target = {
      rowStart: MAX_UNLOCKED_RANGES,
      rowEnd: MAX_UNLOCKED_RANGES,
      colStart: 0,
      colEnd: 0,
    }
    const store = createStore()
    openLockedRange(store, 'sheet-cap', target)
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request),
    )
    const unlockedRanges = Array.from({ length: MAX_UNLOCKED_RANGES + 1 }, (_, row) => ({
      rowStart: row,
      rowEnd: row,
      colStart: 0,
      colEnd: 0,
    }))
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: async (request) =>
        canonicalResult(request, { mode: 'protected', unlockedRanges }),
    })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      error: 'Protection status response did not match the request.',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-cap']).toEqual({
      mode: 'protected',
      unlockedRanges: [],
    })
    expect(setRangeLock).toHaveBeenCalledTimes(1)
  })

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '   '])(
    'rejects an invalid canonical revision (%p)',
    async (revision) => {
      const store = createStore()
      openLockedRange(store)
      store.setter(submitProtectionUnlockAtom, {
        setRangeLock: async (request) => acknowledged(request),
        readSheetProtection: async (request) =>
          ({
            ...canonicalResult(request, { mode: 'open', unlockedRanges: [] }),
            revision,
          }) as ReadSheetProtectionResult,
      })
      await flushAsyncWork()

      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'recovery-required',
        error: 'Protection status response did not match the request.',
      })
    },
  )

  test('canonical refresh requires the exact acknowledged revision', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request, 'revision-2'),
    )
    const staleRead = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonicalResult(
        request,
        { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
        'revision-1',
      ),
    )
    store.setter(submitProtectionUnlockAtom, { setRangeLock, readSheetProtection: staleRead })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      error: 'Protection status response did not match the request.',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [],
    })

    const matchingRead = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonicalResult(
        request,
        { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
        'revision-2',
      ),
    )
    store.setter(refreshProtectionUnlockAtom, { readSheetProtection: matchingRead })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(staleRead).toHaveBeenCalledTimes(1)
    expect(matchingRead).toHaveBeenCalledTimes(1)
  })

  test('refresh recovery retries read only and never resends setRangeLock', async () => {
    const store = createStore()
    openLockedRange(store)
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request),
    )
    const failedRead = jest.fn(async () => {
      throw new Error('Temporary read failure')
    })
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: failedRead,
    })
    await flushAsyncWork()
    expect(store.getter(protectionUnlockPhaseAtom)).toBe('recovery-required')

    const recoveryRead = jest.fn(unlockedCanonicalRead())
    store.setter(refreshProtectionUnlockAtom, { readSheetProtection: recoveryRead })
    await flushAsyncWork()

    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(failedRead).toHaveBeenCalledTimes(1)
    expect(recoveryRead).toHaveBeenCalledTimes(1)
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(protectionUnlockRecoveryRequiredAtom)).toBe(false)
  })

  test('mutation timeout ignores late ACK until a canonical-only recovery refresh', async () => {
    const store = createStore()
    openLockedRange(store)
    const mutation = deferred<SetRangeLockResult>()
    let mutationRequest: CorrelatedSetRangeLockRequest | undefined
    const setRangeLock = jest.fn((request: CorrelatedSetRangeLockRequest) => {
      mutationRequest = request
      return mutation.promise
    })
    const automaticRead = jest.fn<ReadSheetProtectionPort>()
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock,
      readSheetProtection: automaticRead,
      mutationTimeoutMs: 5,
    })
    await wait(15)
    expect(store.getter(protectionUnlockPhaseAtom)).toBe('recovery-required')

    mutation.resolve(acknowledged(mutationRequest!))
    await flushAsyncWork()
    expect(store.getter(protectionUnlockPhaseAtom)).toBe('recovery-required')
    expect(automaticRead).not.toHaveBeenCalled()

    const recoveryRead = jest.fn(unlockedCanonicalRead())
    store.setter(refreshProtectionUnlockAtom, { readSheetProtection: recoveryRead })
    await flushAsyncWork()
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(recoveryRead).toHaveBeenCalledTimes(1)
    expect(store.getter(protectionUnlockPhaseAtom)).toBe('closed')
  })

  test('a stale canonical read cannot overwrite state after close and attempted A-to-B retarget', async () => {
    const store = createStore()
    openLockedRange(store, 'sheet-a')
    store.setter(setProtectionUnlockPasswordAtom, 'sheet-a-secret')
    const canonicalRead = deferred<ReadSheetProtectionResult>()
    const setRangeLock = jest.fn(async (request: CorrelatedSetRangeLockRequest) =>
      acknowledged(request),
    )
    const readSheetProtection = jest.fn(
      (_request: ReadSheetProtectionRequest) => canonicalRead.promise,
    )
    store.setter(submitProtectionUnlockAtom, { setRangeLock, readSheetProtection })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockPhaseAtom)).toBe('canonical-refreshing')
    const readRequest = readSheetProtection.mock.calls[0][0]
    store.setter(closeProtectionUnlockAtom)
    openLockedRange(store, 'sheet-b')

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      target: { sheetId: 'sheet-a' },
    })
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('')

    canonicalRead.resolve(
      canonicalResult(readRequest, {
        mode: 'protected',
        unlockedRanges: [TARGET_RANGE],
      }),
    )
    await flushAsyncWork()

    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
    expect(store.getter(sheetProtectionAtom)['sheet-a']).toEqual({
      mode: 'protected',
      unlockedRanges: [],
    })
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      target: { sheetId: 'sheet-a' },
    })

    const recoveryRead = jest.fn(unlockedCanonicalRead())
    store.setter(refreshProtectionUnlockAtom, { readSheetProtection: recoveryRead })
    await flushAsyncWork()

    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(recoveryRead).toHaveBeenCalledTimes(1)
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    openLockedRange(store, 'sheet-b')
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      target: { sheetId: 'sheet-b' },
    })
  })

  test('unresolved mutation for A keeps recovery bound to A instead of masquerading as B', async () => {
    const store = createStore()
    openLockedRange(store, 'sheet-old')
    const mutation = deferred<SetRangeLockResult>()
    let request!: CorrelatedSetRangeLockRequest
    store.setter(submitProtectionUnlockAtom, {
      setRangeLock: (input) => {
        request = input
        return mutation.promise
      },
      readSheetProtection: async (input) =>
        canonicalResult(input, { mode: 'open', unlockedRanges: [] }),
    })
    store.setter(closeProtectionUnlockAtom)
    openLockedRange(store, 'sheet-new')

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      target: { sheetId: 'sheet-old' },
    })

    mutation.resolve(acknowledged(request))
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      target: { sheetId: 'sheet-old' },
    })
    expect(store.getter(sheetProtectionAtom)['sheet-old']).toEqual({
      mode: 'protected',
      unlockedRanges: [],
    })
  })
})

describe('backend display contract', () => {
  test('retains the optional DisplayCell.locked projection field', () => {
    const locked: DisplayCell = { row: 0, col: 0, displayValue: '', locked: true }
    const unspecified: DisplayCell = { row: 0, col: 0, displayValue: '' }
    expect(locked.locked).toBe(true)
    expect(unspecified.locked).toBeUndefined()
  })
})
