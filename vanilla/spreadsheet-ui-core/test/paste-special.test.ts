import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { Atom } from '@einfach/core'
import { copyClipboardAtom } from '../src/clipboard'
import {
  acquireHistoryProducerReservationAtom,
  historyStackAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
} from '../src/history'
import {
  PASTE_SPECIAL_ACKNOWLEDGEMENT_ERROR,
  PASTE_SPECIAL_CAPABILITY_ERROR,
  PASTE_SPECIAL_HISTORY_BUSY_ERROR,
  PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR,
  PASTE_SPECIAL_REFRESH_ERROR_PREFIX,
  PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR,
  SUPPORTED_PASTE_SPECIAL_KINDS,
  capturePasteSpecialCapabilityAtom,
  closePasteSpecialAtom,
  confirmPasteSpecialAtom,
  DEFAULT_PASTE_SPECIAL_OPTIONS,
  nextPasteSpecialRequestId,
  nextPasteSpecialSessionId,
  openPasteSpecialAtom,
  pasteSpecialBackendKindError,
  patchPasteSpecialOptionsAtom,
  pasteSpecialCanCloseAtom,
  pasteSpecialCanConfirmAtom,
  pasteSpecialCapabilityAtom,
  pasteSpecialErrorAtom,
  pasteSpecialLifecycleAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
  pasteSpecialRequestIdAtom,
  pasteSpecialSessionAtom,
  pasteSpecialSessionIdAtom,
  pasteSpecialSupportedKindsAtom,
  type PasteRangeRequest,
  type PasteRangeResult,
  type PasteSpecialControllerPort,
} from '../src/paste-special'
import { selectionAtom } from '../src/selection'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'

type Store = ReturnType<typeof createStore>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function seedPasteContext(
  store: Store,
  input: {
    sheetId?: string
    sourceSheetId?: string
    targetRow?: number
    sourceRow?: number
  } = {},
) {
  const sheetId = input.sheetId ?? 'sheet-1'
  const sourceSheetId = input.sourceSheetId ?? 'source-sheet'
  const targetRow = input.targetRow ?? 4
  const sourceRow = input.sourceRow ?? 1
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId,
    anchor: { row: targetRow, col: 2 },
    focus: { row: targetRow + 1, col: 3 },
  })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: sourceSheetId,
      range: {
        rowStart: sourceRow,
        rowEnd: sourceRow + 1,
        colStart: 0,
        colEnd: 1,
      },
    },
    includesFormulas: true,
    estimatedBytes: 64,
  })
}

function strictResult(
  request: PasteRangeRequest,
  overrides: Partial<PasteRangeResult> = {},
): PasteRangeResult {
  return {
    kind: 'paste-range',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: 7,
    affectedRange: request.target,
    ...overrides,
  }
}

function createPort(
  implementation: (request: PasteRangeRequest) => Promise<PasteRangeResult> = async (request) =>
    strictResult(request),
) {
  const pasteRange = jest.fn(implementation)
  const port: PasteSpecialControllerPort = { pasteRange }
  return { pasteRange, port }
}

function openReadySession(store: Store, port: PasteSpecialControllerPort) {
  seedPasteContext(store)
  store.setter(capturePasteSpecialCapabilityAtom, port)
  store.setter(openPasteSpecialAtom)
  const session = store.getter(pasteSpecialSessionAtom)
  if (session === null) throw new Error('expected an open Paste Special session')
  return session
}

function expectHistoryProducerLaneAvailable(store: Store): void {
  const reservation = store.setter(acquireHistoryProducerReservationAtom)
  expect(reservation).not.toBeNull()
  if (reservation !== null) {
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
  }
}

describe('paste-special Core state machine', () => {
  test('exposes capability as read-only state written only by the capture command', () => {
    const store = createStore()
    const { port } = createPort()

    expect('write' in pasteSpecialCapabilityAtom).toBe(false)
    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)

    store.setter(capturePasteSpecialCapabilityAtom, port)
    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(true)

    store.setter(capturePasteSpecialCapabilityAtom, {})
    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
  })

  test('exposes Core-owned state as read-only projections and fails closed to runtime writes', () => {
    const store = createStore()
    const protectedAtoms: readonly Atom<unknown>[] = [
      pasteSpecialOpenAtom,
      pasteSpecialOptionsAtom,
      pasteSpecialSessionAtom,
      pasteSpecialLifecycleAtom,
      pasteSpecialErrorAtom,
      pasteSpecialSessionIdAtom,
      pasteSpecialRequestIdAtom,
    ]
    const unsafeSetter = store.setter as unknown as (
      target: Atom<unknown>,
      value: unknown,
    ) => unknown

    for (const protectedAtom of protectedAtoms) {
      const before = store.getter(protectedAtom)
      expect('write' in protectedAtom).toBe(false)
      expect(() => unsafeSetter(protectedAtom, Symbol('external write'))).toThrow()
      expect(store.getter(protectedAtom)).toBe(before)
    }

    const { port } = createPort()
    const session = openReadySession(store, port)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(pasteSpecialSessionIdAtom)).toBe(session.sessionId)

    store.setter(patchPasteSpecialOptionsAtom, { kind: 'formats' })
    expect(store.getter(pasteSpecialOptionsAtom).kind).toBe('formats')
    store.setter(closePasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialSessionIdAtom)).toBe(session.sessionId + 1)
  })

  test('starts closed with Core-owned defaults', () => {
    const store = createStore()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual(DEFAULT_PASTE_SPECIAL_OPTIONS)
    expect(store.getter(pasteSpecialLifecycleAtom)).toEqual({
      status: 'closed',
      sessionId: 0,
      requestId: null,
      sheetId: null,
    })
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(false)
  })

  test('safe identities cross MAX once, descend to MIN, and never wrap', () => {
    for (const nextIdentity of [nextPasteSpecialSessionId, nextPasteSpecialRequestId]) {
      expect(nextIdentity(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
      expect(nextIdentity(Number.MAX_SAFE_INTEGER)).toBe(-1)
      expect(nextIdentity(-1)).toBe(-2)
      expect(nextIdentity(Number.MIN_SAFE_INTEGER + 1)).toBe(Number.MIN_SAFE_INTEGER)
      expect(nextIdentity(Number.MIN_SAFE_INTEGER)).toBeNull()
      expect(nextIdentity(Number.NaN)).toBeNull()
      expect(nextIdentity(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
    }
  })

  test('identity sequences are isolated per store', () => {
    const left = createStore()
    const right = createStore()
    const { port } = createPort()
    const leftSession = openReadySession(left, port)
    const rightSession = openReadySession(right, port)

    expect(leftSession.sessionId).toBe(1)
    expect(rightSession.sessionId).toBe(1)
  })

  test('open freezes target and clipboard so later context drift cannot redirect confirm', async () => {
    const store = createStore()
    const { pasteRange, port } = createPort()
    const session = openReadySession(store, port)
    const frozenTarget = session.target
    const frozenSource = session.source
    const frozenPayload = session.payload

    seedPasteContext(store, {
      sheetId: 'sheet-other',
      sourceSheetId: 'source-other',
      targetRow: 40,
      sourceRow: 30,
    })
    store.setter(patchPasteSpecialOptionsAtom, {
      kind: 'values',
      op: 'multiply',
      skipBlanks: true,
    })

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')

    const request = pasteRange.mock.calls[0]![0]
    expect(request.sheetId).toBe('sheet-1')
    expect(request.target).toEqual(frozenTarget)
    expect(request.source.sheetId).toBe(frozenSource?.sheetId)
    expect(request.source.range).toEqual(frozenSource?.range)
    expect(request.source.payload).toEqual(frozenPayload)
    expect(request.pasteKind).toBe('values')
    expect(request.op).toBe('multiply')
    expect(request.skipBlanks).toBe(true)
  })

  test('missing capability stays visibly blocked and never pretends to succeed', async () => {
    const store = createStore()
    seedPasteContext(store)
    const source: PasteSpecialControllerPort = {}
    store.setter(capturePasteSpecialCapabilityAtom, source)
    store.setter(openPasteSpecialAtom)
    const session = store.getter(pasteSpecialSessionAtom)!

    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')
    expect(store.getter(pasteSpecialErrorAtom)).toBe(PASTE_SPECIAL_CAPABILITY_ERROR)
    expect(store.getter(pasteSpecialCanConfirmAtom)).toBe(false)
    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test.each(['comments', 'column-widths'] as const)(
    'unsupported %s is disabled with an explanation and cannot reach transport',
    async (kind) => {
      const store = createStore()
      const { pasteRange, port } = createPort()
      const session = openReadySession(store, port)
      store.setter(patchPasteSpecialOptionsAtom, { kind })

      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')
      expect(store.getter(pasteSpecialErrorAtom)).toBe(PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR)
      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection: async () => {},
        }),
      ).resolves.toBe('blocked')
      expect(pasteRange).not.toHaveBeenCalled()
      expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    },
  )

  test(
    'a foreign history producer reservation blocks before ticket publication or transport',
    async () => {
    const store = createStore()
    const foreignStore = createStore()
    const { pasteRange, port } = createPort()
    const session = openReadySession(store, port)
    const sessionWitness = store.getter(pasteSpecialSessionAtom)
    const requestIdBefore = store.getter(pasteSpecialRequestIdAtom)
    const reservation = store.setter(acquireHistoryProducerReservationAtom)
    const foreignReservation = foreignStore.setter(acquireHistoryProducerReservationAtom)
    expect(reservation).not.toBeNull()
    expect(foreignReservation).not.toBeNull()

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')

    expect(store.getter(pasteSpecialSessionAtom)).toBe(sessionWitness)
    expect(store.getter(pasteSpecialSessionIdAtom)).toBe(session.sessionId)
    expect(store.getter(pasteSpecialRequestIdAtom)).toBe(requestIdBefore)
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')
    expect(store.getter(pasteSpecialErrorAtom)).toBe(PASTE_SPECIAL_HISTORY_BUSY_ERROR)
    expect(store.getter(pasteSpecialCanConfirmAtom)).toBe(true)
    expect(pasteRange).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    if (foreignReservation !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, foreignReservation)).toBe(false)
    }
    if (reservation !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
    }
    if (foreignReservation !== null) {
      expect(foreignStore.setter(releaseHistoryProducerReservationAtom, foreignReservation)).toBe(
        true,
      )
    }

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryProducerLaneAvailable(store)
  })

  test.each([
    ['sheet mismatch', { sheetId: 'sheet-other' }],
    ['request mismatch', { requestId: 999 }],
  ] as const)(
    '%s is outcome-unknown, keeps the request identity, and fails closed',
    async (...[_label, mismatch]) => {
      const store = createStore()
      const { pasteRange, port } = createPort(async (request) => strictResult(request, mismatch))
      const session = openReadySession(store, port)

      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection: async () => {},
        }),
      ).resolves.toBe('outcome-unknown')

      const requestId = pasteRange.mock.calls[0]![0].requestId
      expect(store.getter(pasteSpecialLifecycleAtom)).toEqual({
        status: 'outcome-unknown',
        sessionId: session.sessionId,
        requestId,
        sheetId: 'sheet-1',
      })
      expect(store.getter(pasteSpecialErrorAtom)).toContain(PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR)
      expect(store.getter(pasteSpecialErrorAtom)).toContain(PASTE_SPECIAL_ACKNOWLEDGEMENT_ERROR)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)

      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection: async () => {},
        }),
      ).resolves.toBe('blocked')
      expect(pasteRange).toHaveBeenCalledTimes(1)
      expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
      // Excel never traps a dialog: outcome-unknown still permits dismissal.
      expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
      store.setter(closePasteSpecialAtom)
      expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
      expectHistoryProducerLaneAvailable(store)
      store.setter(openPasteSpecialAtom)
      expect(store.getter(pasteSpecialSessionAtom)?.sessionId).not.toBe(session.sessionId)
    },
  )

  test(
    'a non-paste acknowledgement kind is outcome-unknown and never reaches history',
    async () => {
    const store = createStore()
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => ({
      ...strictResult(request),
      kind: 'other-mutation',
    }))
    const port = { pasteRange } as unknown as PasteSpecialControllerPort
    const session = openReadySession(store, port)
    const refreshProjection = jest.fn(async () => {})

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection,
      }),
    ).resolves.toBe('outcome-unknown')
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test.each([
    ['number', 17],
    ['string', 'revision-17'],
  ] as const)(
    'strict %s revision and acknowledgement range are recorded without coercion or fallback',
    async (...[_label, revision]) => {
      const store = createStore()
      const affectedRange = Object.freeze({
        rowStart: 10,
        rowEnd: 11,
        colStart: 6,
        colEnd: 7,
      })
      const { port } = createPort(async (request) =>
        strictResult(request, { revision, affectedRange }),
      )
      const session = openReadySession(store, port)

      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection: async () => {},
        }),
      ).resolves.toBe('completed')

      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
        projectionRevision: revision,
        affectedRange,
      })
      expectHistoryProducerLaneAvailable(store)
    },
  )

  test.each([
    ['missing', undefined],
    ['not-a-number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['empty-string', ''],
  ] as const)(
    'invalid %s revision fails closed and retains the producer lane',
    async (...[_label, revision]) => {
      const store = createStore()
      const pasteRange = jest.fn(async (request: PasteRangeRequest) => ({
        ...strictResult(request),
        revision,
      }))
      const port = { pasteRange } as PasteSpecialControllerPort
      const session = openReadySession(store, port)
      const refreshProjection = jest.fn(async () => {})

      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection,
        }),
      ).resolves.toBe('outcome-unknown')

      expect(pasteRange).toHaveBeenCalledTimes(1)
      expect(refreshProjection).not.toHaveBeenCalled()
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      // Excel never traps a dialog: outcome-unknown still permits dismissal.
      expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    },
  )

  test.each([
    ['missing', undefined],
    ['negative', { rowStart: -1, rowEnd: 0, colStart: 0, colEnd: 0 }],
    ['inverted', { rowStart: 2, rowEnd: 1, colStart: 0, colEnd: 0 }],
    ['fractional', { rowStart: 0.5, rowEnd: 1, colStart: 0, colEnd: 0 }],
  ] as const)(
    'invalid %s acknowledgement range fails closed instead of using the target fallback',
    async (...[_label, affectedRange]) => {
      const store = createStore()
      const pasteRange = jest.fn(async (request: PasteRangeRequest) => ({
        ...strictResult(request),
        affectedRange,
      }))
      const port = { pasteRange } as PasteSpecialControllerPort
      const session = openReadySession(store, port)
      const refreshProjection = jest.fn(async () => {})

      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection,
        }),
      ).resolves.toBe('outcome-unknown')

      expect(refreshProjection).not.toHaveBeenCalled()
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      // Excel never traps a dialog: outcome-unknown still permits dismissal.
      expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    },
  )

  test(
    'snapshots every acknowledgement getter exactly once before later values can degrade',
    async () => {
    const store = createStore()
    const reads = new Map<string, number>()
    const once = <T>(name: string, value: T): T => {
      const count = (reads.get(name) ?? 0) + 1
      reads.set(name, count)
      if (count > 1) throw new Error(`${name} was read more than once`)
      return value
    }
    const affectedRange = Object.defineProperties(Object.create(null), {
      rowStart: { enumerable: true, get: () => once('rowStart', 20) },
      rowEnd: { enumerable: true, get: () => once('rowEnd', 21) },
      colStart: { enumerable: true, get: () => once('colStart', 8) },
      colEnd: { enumerable: true, get: () => once('colEnd', 9) },
    })
    const pasteRange = jest.fn(
      async (request: PasteRangeRequest) =>
        Object.defineProperties(Object.create(null), {
          kind: { enumerable: true, get: () => once('kind', 'paste-range') },
          sheetId: { enumerable: true, get: () => once('sheetId', request.sheetId) },
          requestId: { enumerable: true, get: () => once('requestId', request.requestId) },
          revision: { enumerable: true, get: () => once('revision', 'getter-revision') },
          affectedRange: { enumerable: true, get: () => once('affectedRange', affectedRange) },
        }) as PasteRangeResult,
    )
    const port = { pasteRange } as PasteSpecialControllerPort
    const session = openReadySession(store, port)

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')

    expect(Object.fromEntries(reads)).toEqual({
      kind: 1,
      sheetId: 1,
      requestId: 1,
      revision: 1,
      affectedRange: 1,
      rowStart: 1,
      rowEnd: 1,
      colStart: 1,
      colEnd: 1,
    })
    expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
      projectionRevision: 'getter-revision',
      affectedRange: { rowStart: 20, rowEnd: 21, colStart: 8, colEnd: 9 },
    })
  })

  test.each([
    'kind',
    'sheetId',
    'requestId',
    'revision',
    'affectedRange',
    'rowStart',
    'rowEnd',
    'colStart',
    'colEnd',
  ] as const)('a throwing %s acknowledgement getter fails closed', async (throwingField) => {
    const store = createStore()
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => {
      const read = <T>(name: string, value: T): T => {
        if (name === throwingField) throw new Error(`hostile ${name} getter`)
        return value
      }
      const affectedRange = Object.defineProperties(Object.create(null), {
        rowStart: { enumerable: true, get: () => read('rowStart', 1) },
        rowEnd: { enumerable: true, get: () => read('rowEnd', 2) },
        colStart: { enumerable: true, get: () => read('colStart', 3) },
        colEnd: { enumerable: true, get: () => read('colEnd', 4) },
      })
      return Object.defineProperties(Object.create(null), {
        kind: { enumerable: true, get: () => read('kind', 'paste-range') },
        sheetId: { enumerable: true, get: () => read('sheetId', request.sheetId) },
        requestId: { enumerable: true, get: () => read('requestId', request.requestId) },
        revision: { enumerable: true, get: () => read('revision', 19) },
        affectedRange: {
          enumerable: true,
          get: () => read('affectedRange', affectedRange),
        },
      }) as PasteRangeResult
    })
    const port = { pasteRange } as PasteSpecialControllerPort
    const session = openReadySession(store, port)
    const refreshProjection = jest.fn(async () => {})

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection,
      }),
    ).resolves.toBe('outcome-unknown')

    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('outcome-unknown')
    // Excel never traps a dialog: outcome-unknown still permits dismissal.
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('a hostile acknowledgement Proxy is contained and fails closed', async () => {
    const store = createStore()
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => {
      const result = strictResult(request)
      return new Proxy(result, {
        get(target, property, receiver) {
          if (property === 'revision') throw new Error('hostile acknowledgement proxy')
          return Reflect.get(target, property, receiver)
        },
      })
    })
    const port = { pasteRange } as PasteSpecialControllerPort
    const session = openReadySession(store, port)
    const refreshProjection = jest.fn(async () => {})

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection,
      }),
    ).resolves.toBe('outcome-unknown')
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    // Excel never traps a dialog: outcome-unknown still permits dismissal.
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test(
    'a reserved history push failure retains the exact ticket and never refreshes or resends',
    async () => {
    const store = createStore()
    const { pasteRange, port } = createPort()
    const session = openReadySession(store, port)
    const refreshProjection = jest.fn(async () => {})
    const originalWrite = pushReservedHistoryAtom.write
    try {
      pushReservedHistoryAtom.write = () => false
      await expect(
        store.setter(confirmPasteSpecialAtom, {
          source: port,
          sessionId: session.sessionId,
          refreshProjection,
        }),
      ).resolves.toBe('outcome-unknown')
    } finally {
      pushReservedHistoryAtom.write = originalWrite
    }

    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('outcome-unknown')
    // Excel never traps a dialog: outcome-unknown still permits dismissal.
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection,
      }),
    ).resolves.toBe('blocked')
    expect(pasteRange).toHaveBeenCalledTimes(1)
  })

  test('transport rejection is outcome-unknown and cannot duplicate paste by retry', async () => {
    const store = createStore()
    const { pasteRange, port } = createPort(async () => {
      throw new Error('connection lost after send')
    })
    const session = openReadySession(store, port)

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('outcome-unknown')
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(pasteSpecialErrorAtom)).toContain('connection lost after send')

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    // Excel never traps a dialog: an outcome-unknown ACK still permits
    // dismissal, abandoning the retained ticket and its reservation.
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    store.setter(closePasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expectHistoryProducerLaneAvailable(store)

    store.setter(openPasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(pasteSpecialSessionAtom)?.sessionId).not.toBe(session.sessionId)
  })

  test('acknowledged refresh failure retries refresh only without duplicate paste or history', async () => {
    const store = createStore()
    const { pasteRange, port } = createPort()
    const session = openReadySession(store, port)
    const refreshProjection = jest
      .fn<(sheetId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('projection offline'))
      .mockResolvedValueOnce(undefined)

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection,
      }),
    ).resolves.toBe('error')
    expect(store.getter(pasteSpecialErrorAtom)).toBe(
      `${PASTE_SPECIAL_REFRESH_ERROR_PREFIX}projection offline`,
    )
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    // Excel never traps a dialog: a refresh failure still permits dismissal;
    // retrying instead keeps reusing the same retained ticket and session.
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(true)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId,
        refreshProjection,
      }),
    ).resolves.toBe('completed')
    expect(refreshProjection).toHaveBeenCalledTimes(2)
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expectHistoryProducerLaneAvailable(store)
  })

  test('launched pending work cannot be closed or replaced before its acknowledgement settles', async () => {
    const store = createStore()
    const transport = deferred<PasteRangeResult>()
    let sentRequest: PasteRangeRequest | null = null
    const { port } = createPort(async (request) => {
      sentRequest = request
      return transport.promise
    })
    const first = openReadySession(store, port)
    const refreshProjection = jest.fn(async () => {})
    const pending = store.setter(confirmPasteSpecialAtom, {
      source: port,
      sessionId: first.sessionId,
      refreshProjection,
    })
    await Promise.resolve()
    expect(sentRequest).not.toBeNull()
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('pending')
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(false)

    store.setter(closePasteSpecialAtom)
    store.setter(openPasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(pasteSpecialSessionAtom)?.sessionId).toBe(first.sessionId)

    transport.resolve(strictResult(sentRequest!))
    await expect(pending).resolves.toBe('completed')
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  test('real confirm gates keep close disabled through acknowledgement and refresh', async () => {
    const store = createStore()
    const transport = deferred<PasteRangeResult>()
    const refresh = deferred<void>()
    let sentRequest: PasteRangeRequest | null = null
    const { port } = createPort((request) => {
      sentRequest = request
      return transport.promise
    })
    const session = openReadySession(store, port)
    const pending = store.setter(confirmPasteSpecialAtom, {
      source: port,
      sessionId: session.sessionId,
      refreshProjection: () => refresh.promise,
    })

    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('pending')
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(false)
    store.setter(closePasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)

    await Promise.resolve()
    expect(sentRequest).not.toBeNull()
    transport.resolve(strictResult(sentRequest!))
    await Promise.resolve()

    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('local-acknowledged')
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(false)
    store.setter(closePasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)

    await Promise.resolve()
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('refreshing')
    expect(store.getter(pasteSpecialCanCloseAtom)).toBe(false)
    store.setter(closePasteSpecialAtom)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)

    refresh.resolve()
    await expect(pending).resolves.toBe('completed')
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  test('a confirm from a stale session is ignored before transport launch', async () => {
    const store = createStore()
    const { pasteRange, port } = createPort()
    const session = openReadySession(store, port)

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source: port,
        sessionId: session.sessionId + 1,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('stale')
    expect(pasteRange).not.toHaveBeenCalled()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
  })

  test(
    'authority replacement during transport capability lookup cannot publish a stale ticket',
    async () => {
    const store = createStore()
    const { port } = createPort()
    const session = openReadySession(store, port)
    const requestIdBefore = store.getter(pasteSpecialRequestIdAtom)
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => strictResult(request))
    const source = Object.defineProperty({} as PasteSpecialControllerPort, 'pasteRange', {
      get: () => {
        store.setter(closePasteSpecialAtom)
        store.setter(openPasteSpecialAtom)
        return pasteRange
      },
    })

    await expect(
      store.setter(confirmPasteSpecialAtom, {
        source,
        sessionId: session.sessionId,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('stale')

    expect(pasteRange).not.toHaveBeenCalled()
    expect(store.getter(pasteSpecialRequestIdAtom)).toBe(requestIdBefore)
    expect(store.getter(pasteSpecialSessionAtom)?.sessionId).not.toBe(session.sessionId)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryProducerLaneAvailable(store)
  })

  test('same-tick double confirm reserves one transport request', async () => {
    const store = createStore()
    const transport = deferred<PasteRangeResult>()
    let sentRequest: PasteRangeRequest | null = null
    const { pasteRange, port } = createPort(async (request) => {
      sentRequest = request
      return transport.promise
    })
    const session = openReadySession(store, port)
    const input = {
      source: port,
      sessionId: session.sessionId,
      refreshProjection: async () => {},
    }

    const first = store.setter(confirmPasteSpecialAtom, input)
    const second = store.setter(confirmPasteSpecialAtom, input)
    await expect(second).resolves.toBe('stale')
    await Promise.resolve()
    expect(pasteRange).toHaveBeenCalledTimes(1)
    transport.resolve(strictResult(sentRequest!))
    await expect(first).resolves.toBe('completed')
  })

  test('close resets options and invalidates the open session', () => {
    const store = createStore()
    const { port } = createPort()
    openReadySession(store, port)
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'formats' })
    store.setter(closePasteSpecialAtom)

    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialSessionAtom)).toBeNull()
    expect(store.getter(pasteSpecialOptionsAtom)).toEqual(DEFAULT_PASTE_SPECIAL_OPTIONS)
  })

  test('debug labels follow the spreadsheet.pasteSpecial namespace', () => {
    expect(pasteSpecialOpenAtom.debugLabel).toBe('spreadsheet.pasteSpecial.open')
    expect(pasteSpecialOptionsAtom.debugLabel).toBe('spreadsheet.pasteSpecial.options')
    expect(pasteSpecialSessionAtom.debugLabel).toBe('spreadsheet.pasteSpecial.session')
    expect(pasteSpecialLifecycleAtom.debugLabel).toBe('spreadsheet.pasteSpecial.lifecycle')
    expect(pasteSpecialErrorAtom.debugLabel).toBe('spreadsheet.pasteSpecial.error')
    expect(pasteSpecialSessionIdAtom.debugLabel).toBe('spreadsheet.pasteSpecial.sessionId')
    expect(pasteSpecialRequestIdAtom.debugLabel).toBe('spreadsheet.pasteSpecial.requestId')
    expect(openPasteSpecialAtom.debugLabel).toBe('spreadsheet.pasteSpecial.openCommand')
    expect(closePasteSpecialAtom.debugLabel).toBe('spreadsheet.pasteSpecial.closeCommand')
    expect(confirmPasteSpecialAtom.debugLabel).toBe('spreadsheet.pasteSpecial.confirm')
    expect(pasteSpecialCanCloseAtom.debugLabel).toBe('spreadsheet.pasteSpecial.canClose')
  })
})

describe('paste-special backend supported-kinds subdivision', () => {
  test('capture without a declaration keeps the legacy full-trust kind set', () => {
    const store = createStore()
    const { port } = createPort()
    store.setter(capturePasteSpecialCapabilityAtom, port)
    expect(store.getter(pasteSpecialSupportedKindsAtom)).toEqual(SUPPORTED_PASTE_SPECIAL_KINDS)
  })

  test('capture intersects a declaration with the Core-supported set', () => {
    const store = createStore()
    const { port } = createPort()
    const declaring: PasteSpecialControllerPort = {
      ...port,
      pasteRangeSupportedKinds: ['transpose', 'values', 'column-widths'],
    }
    store.setter(capturePasteSpecialCapabilityAtom, declaring)
    expect(store.getter(pasteSpecialSupportedKindsAtom)).toEqual(['values', 'transpose'])
  })

  test('open falls back to the first supported kind when the default is excluded', () => {
    const store = createStore()
    const { port } = createPort()
    const declaring: PasteSpecialControllerPort = {
      ...port,
      pasteRangeSupportedKinds: ['values', 'transpose'],
    }
    seedPasteContext(store)
    store.setter(capturePasteSpecialCapabilityAtom, declaring)
    store.setter(openPasteSpecialAtom)

    expect(store.getter(pasteSpecialOptionsAtom).kind).toBe('values')
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    expect(store.getter(pasteSpecialCanConfirmAtom)).toBe(true)
  })

  test('patching to a backend-excluded kind blocks with the structured reason', () => {
    const store = createStore()
    const { pasteRange, port } = createPort()
    const declaring: PasteSpecialControllerPort = {
      ...port,
      pasteRangeSupportedKinds: ['values', 'transpose'],
    }
    seedPasteContext(store)
    store.setter(capturePasteSpecialCapabilityAtom, declaring)
    store.setter(openPasteSpecialAtom)
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'values-and-formats' })

    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')
    expect(store.getter(pasteSpecialErrorAtom)).toBe(
      pasteSpecialBackendKindError('values-and-formats'),
    )
    expect(store.getter(pasteSpecialCanConfirmAtom)).toBe(false)

    const sessionId = store.getter(pasteSpecialSessionAtom)!.sessionId
    void store.setter(confirmPasteSpecialAtom, {
      source: declaring,
      sessionId,
      refreshProjection: async () => {},
    })
    expect(pasteRange).not.toHaveBeenCalled()
  })

  test('recapturing a full-trust backend unblocks a backend-excluded kind', () => {
    const store = createStore()
    const { port } = createPort()
    const declaring: PasteSpecialControllerPort = {
      ...port,
      pasteRangeSupportedKinds: ['values', 'transpose'],
    }
    seedPasteContext(store)
    store.setter(capturePasteSpecialCapabilityAtom, declaring)
    store.setter(openPasteSpecialAtom)
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'all' })
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')

    store.setter(capturePasteSpecialCapabilityAtom, port)
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    expect(store.getter(pasteSpecialErrorAtom)).toBe('')
  })

  test('supported-kinds atom carries the namespace debug label', () => {
    expect(pasteSpecialSupportedKindsAtom.debugLabel).toBe(
      'spreadsheet.pasteSpecial.supportedKinds',
    )
  })
})
