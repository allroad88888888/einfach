import { describe, expect, jest, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import type { BackendMutationResult, DisplayCell } from '../src/backend/types'
import { resolveContentMutationAtom } from '../src/editing'
import { historyStackAtom } from '../src/history'
import type { CellRange } from '../src/shared'
import {
  DEFAULT_PROTECTION_UNLOCK_STATE,
  DEFAULT_SHEET_PROTECTION,
  MAX_UNLOCKED_RANGES,
  activeCellLockedAtom,
  addUnlockedRangeAtom,
  clearSheetProtectionAtom,
  closeProtectionUnlockAtom,
  getSheetProtection,
  hydrateSheetProtectionAtom,
  isCoordUnlocked,
  isRangeFullyUnlocked,
  isRangePartiallyUnlocked,
  openProtectionUnlockAtom,
  protectSheetAtom,
  protectionUnlockPasswordAtom,
  protectionUnlockPhaseAtom,
  protectionUnlockStateAtom,
  rangesIntersect,
  removeUnlockedRangeAtom,
  selectionLockedAtom,
  setProtectionUnlockPasswordAtom,
  setSheetProtectionAtom,
  sheetProtectionAtom,
  sheetProtectionDiagnosticAtom,
  submitProtectionUnlockAtom,
  unprotectSheetAtom,
  type ReadSheetProtectionRequest,
  type ReadSheetProtectionResult,
  type SetRangeLockRequest,
  type SetSheetProtectionRequest,
  type SheetProtectionPersistencePort,
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

function mutationResult(sheetId: string): BackendMutationResult {
  return { sheetId, revision: 1 }
}

interface RecordingPort extends SheetProtectionPersistencePort {
  readonly sheetProtectionRequests: SetSheetProtectionRequest[]
  readonly rangeLockRequests: SetRangeLockRequest[]
}

function createRecordingPort(
  options: { withSetRangeLock?: boolean; withSetSheetProtection?: boolean } = {},
): RecordingPort {
  const sheetProtectionRequests: SetSheetProtectionRequest[] = []
  const rangeLockRequests: SetRangeLockRequest[] = []
  const port: RecordingPort = { sheetProtectionRequests, rangeLockRequests }
  if (options.withSetSheetProtection !== false) {
    port.setSheetProtection = async (request) => {
      sheetProtectionRequests.push(request)
      return mutationResult(request.sheetId)
    }
  }
  if (options.withSetRangeLock !== false) {
    port.setRangeLock = async (request) => {
      rangeLockRequests.push(request)
      return mutationResult(request.sheetId)
    }
  }
  return port
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
  test('keeps the online Excel defaults and rejects more than 256 ranges as invalid', () => {
    expect(MAX_UNLOCKED_RANGES).toBe(256)
    expect(DEFAULT_SHEET_PROTECTION).toEqual({ mode: 'open', unlockedRanges: [] })

    const store = createStore()
    const ranges = Array.from({ length: MAX_UNLOCKED_RANGES }, (_, row) => ({
      rowStart: row,
      rowEnd: row,
      colStart: 0,
      colEnd: 0,
    }))
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-1',
        state: { mode: 'protected', unlockedRanges: ranges },
      }),
    ).toBe('committed')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toHaveLength(
      MAX_UNLOCKED_RANGES,
    )

    expect(
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
    ).toBe('invalid')
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

  test('stores and clears sheet entries through commands with outcome semantics', () => {
    const store = createStore()
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-A',
        state: { mode: 'protected', unlockedRanges: [TARGET_RANGE] },
      }),
    ).toBe('committed')
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-A',
        state: { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
      }),
    ).toBe('unchanged')
    expect(getSheetProtection(store.getter(sheetProtectionAtom), 'sheet-A').mode).toBe('protected')

    expect(store.setter(clearSheetProtectionAtom, 'sheet-A')).toBe('committed')
    expect(store.setter(clearSheetProtectionAtom, 'sheet-A')).toBe('unchanged')
    expect(store.getter(sheetProtectionAtom)['sheet-A']).toBeUndefined()
    expect(getSheetProtection(store.getter(sheetProtectionAtom), 'sheet-A')).toBe(
      DEFAULT_SHEET_PROTECTION,
    )
  })

  test('rejects malformed inputs without touching canonical state', () => {
    const store = createStore()
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: '',
        state: { mode: 'protected', unlockedRanges: [] },
      }),
    ).toBe('invalid')
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-1',
        state: {
          mode: 'protected',
          unlockedRanges: [{ rowStart: 2, rowEnd: 1, colStart: 0, colEnd: 0 }],
        },
      }),
    ).toBe('invalid')
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-1',
        state: { mode: 'locked', unlockedRanges: [] } as unknown as SheetProtectionState,
      }),
    ).toBe('invalid')
    expect(store.setter(clearSheetProtectionAtom, '')).toBe('invalid')
    expect(store.getter(sheetProtectionAtom)).toEqual({})
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

describe('protect / unprotect commands', () => {
  test('protectSheet preserves existing unlocked ranges and reports unchanged repeats', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'open', unlockedRanges: [TARGET_RANGE] },
    })

    expect(store.setter(protectSheetAtom, { sheetId: 'sheet-1' })).toBe('committed')
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
    expect(store.setter(protectSheetAtom, { sheetId: 'sheet-1' })).toBe('unchanged')
  })

  test('protectSheet can replace unlocked ranges and validates the replacement', () => {
    const store = createStore()
    expect(
      store.setter(protectSheetAtom, { sheetId: 'sheet-1', unlockedRanges: [TARGET_RANGE] }),
    ).toBe('committed')
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })

    expect(
      store.setter(protectSheetAtom, {
        sheetId: 'sheet-1',
        unlockedRanges: [{ rowStart: -1, rowEnd: 0, colStart: 0, colEnd: 0 }],
      }),
    ).toBe('invalid')
    expect(store.setter(protectSheetAtom, { sheetId: '' })).toBe('invalid')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([TARGET_RANGE])
  })

  test('unprotectSheet opens the sheet, preserves ranges, and is unchanged when open', () => {
    const store = createStore()
    expect(store.setter(unprotectSheetAtom, { sheetId: 'sheet-1' })).toBe('unchanged')

    store.setter(protectSheetAtom, { sheetId: 'sheet-1', unlockedRanges: [TARGET_RANGE] })
    expect(store.setter(unprotectSheetAtom, { sheetId: 'sheet-1' })).toBe('committed')
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'open',
      unlockedRanges: [TARGET_RANGE],
    })
    expect(store.setter(unprotectSheetAtom, { sheetId: 'sheet-1' })).toBe('unchanged')

    // Re-protect restores enforcement with the preserved allow-edit ranges.
    expect(store.setter(protectSheetAtom, { sheetId: 'sheet-1' })).toBe('committed')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('protected')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([TARGET_RANGE])
  })
})

describe('unlocked-range commands', () => {
  test('adds and removes unlocked ranges with outcome semantics', () => {
    const store = createStore()
    store.setter(protectSheetAtom, { sheetId: 'sheet-1' })

    expect(store.setter(addUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })).toBe(
      'committed',
    )
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([TARGET_RANGE])
    // Already editable — including any sub-range of an existing entry.
    expect(store.setter(addUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })).toBe(
      'unchanged',
    )
    expect(
      store.setter(addUnlockedRangeAtom, {
        sheetId: 'sheet-1',
        range: { rowStart: 3, rowEnd: 3, colStart: 4, colEnd: 4 },
      }),
    ).toBe('unchanged')

    expect(
      store.setter(removeUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE }),
    ).toBe('committed')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
    expect(
      store.setter(removeUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE }),
    ).toBe('unchanged')
  })

  test('add reports unchanged on an open sheet and invalid at the range cap', () => {
    const store = createStore()
    // Open sheets are fully editable — nothing to unlock.
    expect(store.setter(addUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })).toBe(
      'unchanged',
    )

    const ranges = Array.from({ length: MAX_UNLOCKED_RANGES }, (_, row) => ({
      rowStart: row,
      rowEnd: row,
      colStart: 0,
      colEnd: 0,
    }))
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-cap',
      state: { mode: 'protected', unlockedRanges: ranges },
    })
    expect(
      store.setter(addUnlockedRangeAtom, {
        sheetId: 'sheet-cap',
        range: {
          rowStart: MAX_UNLOCKED_RANGES,
          rowEnd: MAX_UNLOCKED_RANGES,
          colStart: 0,
          colEnd: 0,
        },
      }),
    ).toBe('invalid')
    expect(store.getter(sheetProtectionAtom)['sheet-cap'].unlockedRanges).toHaveLength(
      MAX_UNLOCKED_RANGES,
    )
  })

  test('rejects malformed ranges before touching state', () => {
    const store = createStore()
    store.setter(protectSheetAtom, { sheetId: 'sheet-1' })
    for (const range of [
      { rowStart: -1, rowEnd: 1, colStart: 0, colEnd: 1 },
      { rowStart: 0.5, rowEnd: 1, colStart: 0, colEnd: 1 },
      { rowStart: 2, rowEnd: 1, colStart: 0, colEnd: 1 },
      { rowStart: 0, rowEnd: 1, colStart: 2, colEnd: 1 },
    ]) {
      expect(store.setter(addUnlockedRangeAtom, { sheetId: 'sheet-1', range })).toBe('invalid')
      expect(store.setter(removeUnlockedRangeAtom, { sheetId: 'sheet-1', range })).toBe('invalid')
    }
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
  })
})

describe('protection never records undo history', () => {
  test('protect, unlock, and clear commands leave the history stack empty', () => {
    const store = createStore()
    store.setter(protectSheetAtom, { sheetId: 'sheet-1' })
    store.setter(addUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })
    store.setter(removeUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })
    store.setter(unprotectSheetAtom, { sheetId: 'sheet-1' })
    store.setter(clearSheetProtectionAtom, 'sheet-1')
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })
    store.setter(submitProtectionUnlockAtom)

    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })
})

describe('persistence mirror (fire-and-forget)', () => {
  test('full-state commands mirror the committed snapshot via setSheetProtection', async () => {
    const store = createStore()
    const port = createRecordingPort()

    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [TARGET_RANGE] },
      source: port,
    })
    store.setter(unprotectSheetAtom, { sheetId: 'sheet-1', source: port })
    store.setter(clearSheetProtectionAtom, { sheetId: 'sheet-1', source: port })
    await flushAsyncWork()

    expect(port.sheetProtectionRequests).toEqual([
      {
        kind: 'set-sheet-protection',
        sheetId: 'sheet-1',
        mode: 'protected',
        unlockedRanges: [TARGET_RANGE],
      },
      {
        kind: 'set-sheet-protection',
        sheetId: 'sheet-1',
        mode: 'open',
        unlockedRanges: [TARGET_RANGE],
      },
      { kind: 'set-sheet-protection', sheetId: 'sheet-1', mode: 'open', unlockedRanges: [] },
    ])
    expect(port.rangeLockRequests).toHaveLength(0)
  })

  test('range commands prefer setRangeLock and fall back to setSheetProtection', async () => {
    const store = createStore()
    const withRangeLock = createRecordingPort()
    store.setter(protectSheetAtom, { sheetId: 'sheet-1', source: withRangeLock })
    store.setter(addUnlockedRangeAtom, {
      sheetId: 'sheet-1',
      range: TARGET_RANGE,
      source: withRangeLock,
    })
    store.setter(removeUnlockedRangeAtom, {
      sheetId: 'sheet-1',
      range: TARGET_RANGE,
      source: withRangeLock,
    })
    await flushAsyncWork()
    expect(withRangeLock.rangeLockRequests).toEqual([
      { kind: 'set-range-lock', sheetId: 'sheet-1', range: TARGET_RANGE, locked: false },
      { kind: 'set-range-lock', sheetId: 'sheet-1', range: TARGET_RANGE, locked: true },
    ])
    // protectSheet is a full-state mirror; the range deltas are not.
    expect(withRangeLock.sheetProtectionRequests).toHaveLength(1)

    const fallbackOnly = createRecordingPort({ withSetRangeLock: false })
    store.setter(protectSheetAtom, { sheetId: 'sheet-2', source: fallbackOnly })
    store.setter(addUnlockedRangeAtom, {
      sheetId: 'sheet-2',
      range: TARGET_RANGE,
      source: fallbackOnly,
    })
    await flushAsyncWork()
    expect(fallbackOnly.rangeLockRequests).toHaveLength(0)
    expect(fallbackOnly.sheetProtectionRequests[1]).toEqual({
      kind: 'set-sheet-protection',
      sheetId: 'sheet-2',
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
  })

  test('a mirror failure records a diagnostic and never rolls back local state', async () => {
    const store = createStore()
    const failing: SheetProtectionPersistencePort = {
      setSheetProtection: async () => {
        throw new Error('Transport lost')
      },
    }

    expect(
      store.setter(protectSheetAtom, { sheetId: 'sheet-1', source: failing }),
    ).toBe('committed')
    await flushAsyncWork()

    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('protected')
    expect(store.getter(sheetProtectionDiagnosticAtom)).toEqual({
      kind: 'persist-failed',
      sheetId: 'sheet-1',
      message: 'Transport lost',
    })
  })

  test('commands commit without any port and record no diagnostic', () => {
    const store = createStore()
    expect(store.setter(protectSheetAtom, { sheetId: 'sheet-1' })).toBe('committed')
    expect(
      store.setter(addUnlockedRangeAtom, { sheetId: 'sheet-1', range: TARGET_RANGE }),
    ).toBe('committed')
    expect(store.getter(sheetProtectionDiagnosticAtom)).toBeNull()
  })

  test('unchanged and invalid outcomes never reach the mirror', async () => {
    const store = createStore()
    const port = createRecordingPort()
    store.setter(protectSheetAtom, { sheetId: 'sheet-1' })

    expect(store.setter(protectSheetAtom, { sheetId: 'sheet-1', source: port })).toBe('unchanged')
    expect(
      store.setter(addUnlockedRangeAtom, {
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 0, colStart: 0, colEnd: 0 },
        source: port,
      }),
    ).toBe('invalid')
    await flushAsyncWork()

    expect(port.sheetProtectionRequests).toHaveLength(0)
    expect(port.rangeLockRequests).toHaveLength(0)
  })
})

describe('one-shot hydration seed', () => {
  function readPort(
    protection: SheetProtectionState,
    requests: ReadSheetProtectionRequest[] = [],
  ): SheetProtectionPersistencePort {
    return {
      readSheetProtection: async (request) => {
        requests.push(request)
        return {
          kind: 'read-sheet-protection',
          requestId: request.requestId,
          sheetId: request.sheetId,
          revision: 1,
          protection,
        }
      },
    }
  }

  test('hydrates a sheet once and skips afterwards', async () => {
    const store = createStore()
    const requests: ReadSheetProtectionRequest[] = []
    const source = readPort({ mode: 'protected', unlockedRanges: [TARGET_RANGE] }, requests)

    const hydrate = () => store.setter(hydrateSheetProtectionAtom, { sheetId: 'sheet-1', source })
    await expect(hydrate()).resolves.toBe('hydrated')
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
    await expect(hydrate()).resolves.toBe('skipped')
    expect(requests).toHaveLength(1)
  })

  test('reports unsupported without a read port and never manufactures state', async () => {
    const store = createStore()
    await expect(
      store.setter(hydrateSheetProtectionAtom, { sheetId: 'sheet-1', source: {} }),
    ).resolves.toBe('unsupported')
    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(store.getter(sheetProtectionDiagnosticAtom)).toBeNull()
  })

  test('a local command claims the sheet; the seed is skipped even mid-flight', async () => {
    const store = createStore()
    const read = deferred<ReadSheetProtectionResult>()
    const source: SheetProtectionPersistencePort = {
      readSheetProtection: () => read.promise,
    }

    const hydration = store.setter(hydrateSheetProtectionAtom, { sheetId: 'sheet-1', source })
    store.setter(protectSheetAtom, { sheetId: 'sheet-1', unlockedRanges: [TARGET_RANGE] })
    read.resolve({
      kind: 'read-sheet-protection',
      requestId: 1,
      sheetId: 'sheet-1',
      revision: 9,
      protection: { mode: 'open', unlockedRanges: [] },
    })
    await expect(hydration).resolves.toBe('skipped')

    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
  })

  test('a locally owned sheet is never re-read', async () => {
    const store = createStore()
    const requests: ReadSheetProtectionRequest[] = []
    const source = readPort({ mode: 'open', unlockedRanges: [] }, requests)
    store.setter(protectSheetAtom, { sheetId: 'sheet-1' })

    const hydrate = () => store.setter(hydrateSheetProtectionAtom, { sheetId: 'sheet-1', source })
    await expect(hydrate()).resolves.toBe('skipped')
    expect(requests).toHaveLength(0)
    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('protected')
  })

  const HYDRATE_TABLE = [
    ['mismatched sheetId', { sheetId: 'other-sheet' }],
    ['invalid mode', { protection: { mode: 'locked', unlockedRanges: [] } }],
    [
      'over-cap ranges',
      {
        protection: {
          mode: 'protected',
          unlockedRanges: Array.from({ length: MAX_UNLOCKED_RANGES + 1 }, (_, row) => ({
            rowStart: row,
            rowEnd: row,
            colStart: 0,
            colEnd: 0,
          })),
        },
      },
    ],
  ] as const
  test.each(HYDRATE_TABLE)('rejects an invalid payload (%s) with a diagnostic', async (...args: (typeof HYDRATE_TABLE)[number]) => {
    const [_label, overrides] = args
    const store = createStore()
    const source: SheetProtectionPersistencePort = {
      readSheetProtection: async (request) =>
        ({
          kind: 'read-sheet-protection',
          requestId: request.requestId,
          sheetId: request.sheetId,
          revision: 1,
          protection: { mode: 'open', unlockedRanges: [] },
          ...overrides,
        }) as ReadSheetProtectionResult,
    }
    const hydrate = () => store.setter(hydrateSheetProtectionAtom, { sheetId: 'sheet-1', source })
    await expect(hydrate()).resolves.toBe('error')
    expect(store.getter(sheetProtectionAtom)).toEqual({})
    expect(store.getter(sheetProtectionDiagnosticAtom)).toMatchObject({
      kind: 'hydrate-failed',
      sheetId: 'sheet-1',
    })
  })

  test('a read failure reports error and leaves the sheet unclaimed for a retry', async () => {
    const store = createStore()
    let calls = 0
    const source: SheetProtectionPersistencePort = {
      readSheetProtection: async (request) => {
        calls += 1
        if (calls === 1) throw new Error('Worker restarting')
        return {
          kind: 'read-sheet-protection',
          requestId: request.requestId,
          sheetId: request.sheetId,
          revision: 1,
          protection: { mode: 'protected', unlockedRanges: [] },
        }
      },
    }

    const hydrate = () => store.setter(hydrateSheetProtectionAtom, { sheetId: 'sheet-1', source })
    await expect(hydrate()).resolves.toBe('error')
    expect(store.getter(sheetProtectionDiagnosticAtom)).toEqual({
      kind: 'hydrate-failed',
      sheetId: 'sheet-1',
      message: 'Worker restarting',
    })
    await expect(hydrate()).resolves.toBe('hydrated')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('protected')
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
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'closed',
      isOpen: false,
      target: null,
      error: null,
    })
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

  test('keeps dialog sessions isolated between stores', () => {
    const first = createStore()
    const second = createStore()
    openLockedRange(first)
    openLockedRange(second)
    first.setter(setProtectionUnlockPasswordAtom, 'first')

    first.setter(submitProtectionUnlockAtom)
    expect(first.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(second.getter(protectionUnlockStateAtom).phase).toBe('editing')
    expect(second.getter(protectionUnlockPasswordAtom)).toBe('')
  })
})

describe('unlock local commit', () => {
  test('confirms synchronously without a verifier, unlocks the range, and closes', () => {
    const store = createStore()
    openLockedRange(store)
    expect(store.getter(selectionLockedAtom)).toBeDefined()

    store.setter(submitProtectionUnlockAtom)

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [TARGET_RANGE],
    })
    expect(isRangeFullyUnlocked(store.getter(sheetProtectionAtom), 'sheet-1', TARGET_RANGE)).toBe(
      true,
    )
  })

  test('mirrors the committed unlock through setRangeLock fire-and-forget', async () => {
    const store = createStore()
    const port = createRecordingPort()
    openLockedRange(store)

    store.setter(submitProtectionUnlockAtom, { source: port })
    await flushAsyncWork()

    expect(port.rangeLockRequests).toEqual([
      { kind: 'set-range-lock', sheetId: 'sheet-1', range: TARGET_RANGE, locked: false },
    ])
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
  })

  test('an already-editable target closes without growing the range list', () => {
    const store = createStore()
    store.setter(protectSheetAtom, { sheetId: 'sheet-1', unlockedRanges: [TARGET_RANGE] })
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })

    store.setter(submitProtectionUnlockAtom)

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([TARGET_RANGE])
  })

  test('a cap violation keeps the dialog editing with an error', () => {
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
    store.setter(openProtectionUnlockAtom, {
      sheetId: 'sheet-1',
      range: { rowStart: MAX_UNLOCKED_RANGES, rowEnd: MAX_UNLOCKED_RANGES, colStart: 0, colEnd: 0 },
    })

    store.setter(submitProtectionUnlockAtom)

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: `Cannot unlock more than ${MAX_UNLOCKED_RANGES} ranges on one sheet.`,
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toHaveLength(
      MAX_UNLOCKED_RANGES,
    )
  })

  test('rejects a target without a range before committing anything', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1' })

    store.setter(submitProtectionUnlockAtom)

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Select a range to unlock.',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
  })
})

describe('unlock verification session', () => {
  test('a passing verifier receives the typed password and commits the unlock', async () => {
    const store = createStore()
    openLockedRange(store)
    store.setter(setProtectionUnlockPasswordAtom, 'workbook-password')
    const verifySheetProtection = jest.fn<VerifySheetProtectionPort>(async () => ({ ok: true }))

    store.setter(submitProtectionUnlockAtom, { verifySheetProtection })
    expect(store.getter(protectionUnlockPhaseAtom)).toBe('verifying')
    expect(store.getter(protectionUnlockStateAtom).pending).toBe(true)
    await flushAsyncWork()

    expect(verifySheetProtection).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      range: TARGET_RANGE,
      password: 'workbook-password',
    })
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(isRangeFullyUnlocked(store.getter(sheetProtectionAtom), 'sheet-1', TARGET_RANGE)).toBe(
      true,
    )
  })

  test('verification rejection remains Editing and never commits', async () => {
    const store = createStore()
    openLockedRange(store)
    const verifySheetProtection: VerifySheetProtectionPort = async () => ({
      ok: false,
      message: 'Incorrect password',
    })

    store.setter(submitProtectionUnlockAtom, { verifySheetProtection })
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Incorrect password',
    })
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
  })

  test('verifier Promise rejection and timeout are retryable Editing failures', async () => {
    const rejectedStore = createStore()
    openLockedRange(rejectedStore)
    rejectedStore.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: async () => {
        throw new Error('Verifier unavailable')
      },
    })
    await flushAsyncWork()
    expect(rejectedStore.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Verifier unavailable',
    })

    const timeoutStore = createStore()
    openLockedRange(timeoutStore)
    const verification = deferred<{ ok: boolean }>()
    timeoutStore.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: () => verification.promise,
      verifyTimeoutMs: 5,
    })
    await wait(15)
    expect(timeoutStore.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Password verification timed out. Try again.',
    })
    expect(timeoutStore.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
  })

  test('deduplicates repeated submit while verification is pending (single flight)', async () => {
    const store = createStore()
    openLockedRange(store)
    const verification = deferred<{ ok: boolean }>()
    const verifySheetProtection = jest.fn(() => verification.promise)
    const input = { verifySheetProtection }

    store.setter(submitProtectionUnlockAtom, input)
    store.setter(submitProtectionUnlockAtom, input)
    expect(verifySheetProtection).toHaveBeenCalledTimes(1)

    verification.resolve({ ok: true })
    await flushAsyncWork()
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([TARGET_RANGE])
  })

  test('a late verification after close never commits against the stale target', async () => {
    const store = createStore()
    openLockedRange(store, 'sheet-old')
    const verification = deferred<{ ok: boolean }>()
    store.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: () => verification.promise,
    })
    store.setter(closeProtectionUnlockAtom)
    openLockedRange(store, 'sheet-new')

    verification.resolve({ ok: true })
    await flushAsyncWork()

    expect(store.getter(sheetProtectionAtom)['sheet-old'].unlockedRanges).toEqual([])
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      target: { sheetId: 'sheet-new' },
      error: null,
    })
  })

  test('a late verification failure after reopen never leaks into the new session', async () => {
    const store = createStore()
    openLockedRange(store, 'sheet-old')
    const verification = deferred<{ ok: boolean }>()
    store.setter(submitProtectionUnlockAtom, {
      verifySheetProtection: () => verification.promise,
    })
    openLockedRange(store, 'sheet-new')

    verification.reject(new Error('stale failure'))
    await flushAsyncWork()

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      target: { sheetId: 'sheet-new' },
      error: null,
    })
  })
})

describe('W2 gateway enforcement without protection ports (worker-parity contract)', () => {
  // Mirrors the worker backends: content transports exist, protection
  // ports do not. Protection must be fully enforceable locally.
  function createPortlessBackendProbe() {
    return {
      readVisibleProjection: jest.fn(),
      readRangeProjection: jest.fn(),
      setCellInput: jest.fn(),
      clearRange: jest.fn(),
      fillRange: jest.fn(),
      pasteRange: jest.fn(),
      // No setSheetProtection / setRangeLock / readSheetProtection.
    }
  }

  test('a protected sheet blocks edit, paste, fill, and clear before any transport', () => {
    const store = createStore()
    const backend = createPortlessBackendProbe()
    expect(
      store.setter(setSheetProtectionAtom, {
        sheetId: 'sheet-1',
        state: { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
      }),
    ).toBe('committed')

    const lockedCell = { row: 10, col: 10 }
    const lockedRange = { rowStart: 9, rowEnd: 11, colStart: 9, colEnd: 11 }
    const resolutions = [
      store.setter(resolveContentMutationAtom, {
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        cell: lockedCell,
      }),
      store.setter(resolveContentMutationAtom, {
        kind: 'paste-range',
        sheetId: 'sheet-1',
        range: lockedRange,
      }),
      store.setter(resolveContentMutationAtom, {
        kind: 'fill-range',
        sheetId: 'sheet-1',
        range: lockedRange,
      }),
      store.setter(resolveContentMutationAtom, {
        kind: 'clear-range',
        sheetId: 'sheet-1',
        range: lockedRange,
      }),
    ]

    for (const resolution of resolutions) {
      expect(resolution.status).toBe('blocked')
      expect(resolution).toMatchObject({ reason: 'locked' })
    }
    // Zero transport: neither the mutation ports nor any protection port ran.
    for (const transport of Object.values(backend)) {
      expect(transport).not.toHaveBeenCalled()
    }
  })

  test('cells inside unlockedRanges stay editable on the same protected sheet', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [copyRange(TARGET_RANGE)] },
    })

    const cellResolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      cell: { row: TARGET_RANGE.rowStart, col: TARGET_RANGE.colStart },
    })
    const rangeResolution = store.setter(resolveContentMutationAtom, {
      kind: 'paste-range',
      sheetId: 'sheet-1',
      range: copyRange(TARGET_RANGE),
    })

    expect(cellResolution).toMatchObject({
      status: 'allowed',
      cell: { row: TARGET_RANGE.rowStart, col: TARGET_RANGE.colStart },
    })
    expect(rangeResolution).toMatchObject({ status: 'allowed' })
  })

  test('the dialog unlock flow flips a locked target to editable with zero transport', () => {
    const store = createStore()
    const backend = createPortlessBackendProbe()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    const blocked = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      cell: { row: TARGET_RANGE.rowStart, col: TARGET_RANGE.colStart },
    })
    expect(blocked.status).toBe('blocked')

    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1', range: TARGET_RANGE })
    store.setter(submitProtectionUnlockAtom, { source: {} })

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    const allowed = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      cell: { row: TARGET_RANGE.rowStart, col: TARGET_RANGE.colStart },
    })
    expect(allowed.status).toBe('allowed')
    for (const transport of Object.values(backend)) {
      expect(transport).not.toHaveBeenCalled()
    }
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
