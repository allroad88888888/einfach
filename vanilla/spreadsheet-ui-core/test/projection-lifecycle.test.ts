import { createStore, type Store } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  beginProjectionAtom,
  issueProjectionRequestIdAtom,
  nextProjectionRequestId,
  projectionRequestIdAtom,
  projectionSnapshotAtom,
  rejectProjectionAtom,
  resetProjectionAtom,
  resolveProjectionAtom,
  type RangeProjectionRequest,
  type VisibleProjectionRequest,
} from '../src'

const VISIBLE_WINDOW = { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 } as const

function beginVisible(
  store: Store,
  options: { revision?: number | string; retainResult?: boolean } = {},
): VisibleProjectionRequest {
  const outcome = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: 'sheet-1',
    window: VISIBLE_WINDOW,
    reason: 'test',
    ...options,
  })
  if (outcome.status !== 'started' || outcome.request.kind !== 'visible-window') {
    throw new Error(`Expected a visible projection request, received ${outcome.status}.`)
  }
  return outcome.request
}

function beginRange(store: Store): RangeProjectionRequest {
  const outcome = store.setter(beginProjectionAtom, {
    kind: 'range',
    sheetId: 'sheet-1',
    range: { rowStart: 4, rowEnd: 5, colStart: 6, colEnd: 7 },
    reason: 'test',
  })
  if (outcome.status !== 'started' || outcome.request.kind !== 'range') {
    throw new Error(`Expected a range projection request, received ${outcome.status}.`)
  }
  return outcome.request
}

describe('projection lifecycle', () => {
  test('publishes read-only product state with independent stores', () => {
    const firstStore = createStore()
    const secondStore = createStore()

    expect('write' in projectionSnapshotAtom).toBe(false)
    expect('write' in projectionRequestIdAtom).toBe(false)
    expect(firstStore.getter(projectionRequestIdAtom)).toBe(0)
    expect(secondStore.getter(projectionRequestIdAtom)).toBe(0)

    expect(firstStore.setter(issueProjectionRequestIdAtom)).toBe(1)
    expect(firstStore.getter(projectionRequestIdAtom)).toBe(1)
    expect(secondStore.getter(projectionRequestIdAtom)).toBe(0)

    const firstRequest = beginVisible(firstStore)
    expect(firstRequest.requestId).toBe(2)
    expect(firstStore.getter(projectionSnapshotAtom).status).toBe('loading')
    expect(secondStore.getter(projectionSnapshotAtom).status).toBe('idle')

    const writeReadOnlyAtom = firstStore.setter as unknown as (
      atom: unknown,
      value: unknown,
    ) => unknown
    expect(() => writeReadOnlyAtom(projectionSnapshotAtom, { status: 'idle' })).toThrow(TypeError)
  })

  test('allocates every safe request id once and reports exhaustion', () => {
    expect(nextProjectionRequestId(0)).toBe(1)
    expect(nextProjectionRequestId(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(nextProjectionRequestId(Number.MAX_SAFE_INTEGER)).toBe(-1)
    expect(nextProjectionRequestId(-1)).toBe(-2)
    expect(nextProjectionRequestId(Number.MIN_SAFE_INTEGER + 1)).toBe(Number.MIN_SAFE_INTEGER)
    expect(nextProjectionRequestId(Number.MIN_SAFE_INTEGER)).toBeNull()
    expect(nextProjectionRequestId(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
  })

  test('does not reserve a lane or request id for invalid windows', () => {
    const store = createStore()

    expect(
      store.setter(beginProjectionAtom, {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: -1, colStart: 0, colEnd: -1 },
        reason: 'test',
      }),
    ).toMatchObject({ status: 'invalid', error: { code: 'EMPTY_RANGE' } })
    expect(
      store.setter(beginProjectionAtom, {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window: { rowStart: -1, rowEnd: 0, colStart: 0, colEnd: 0 },
        reason: 'test',
      }),
    ).toMatchObject({ status: 'invalid', error: { code: 'INVALID_RANGE' } })
    expect(
      store.setter(beginProjectionAtom, {
        kind: 'range',
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 10 },
        reason: 'test',
        maxCells: 100,
      }),
    ).toMatchObject({ status: 'invalid', error: { code: 'RANGE_TOO_LARGE' } })

    expect(store.getter(projectionRequestIdAtom)).toBe(0)
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')
    expect(beginVisible(store).requestId).toBe(1)
  })

  test('accepts a backend-established revision and freezes the published snapshot', () => {
    const store = createStore()
    const request = beginVisible(store)
    const result = {
      kind: 'visible-window' as const,
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 'rev-current',
      window: { ...request.window },
      cells: [
        {
          row: 1,
          col: 1,
          displayValue: 'before',
          format: { bold: true },
        },
      ],
    }

    expect(store.setter(resolveProjectionAtom, { request, result })).toMatchObject({
      status: 'accepted',
      result: { revision: 'rev-current' },
    })
    result.cells[0]!.displayValue = 'after'

    const snapshot = store.getter(projectionSnapshotAtom)
    expect(snapshot.status).toBe('ready')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.request)).toBe(true)
    if (snapshot.request?.kind !== 'visible-window') throw new Error('Expected visible request.')
    expect(Object.isFrozen(snapshot.request.window)).toBe(true)
    expect(snapshot.result?.kind).toBe('visible-window')
    if (snapshot.result?.kind !== 'visible-window') throw new Error('Expected visible result.')
    expect(snapshot.result.revision).toBe('rev-current')
    expect(snapshot.result.cells[0]?.displayValue).toBe('before')
    expect(Object.isFrozen(snapshot.result)).toBe(true)
    expect(Object.isFrozen(snapshot.result.cells)).toBe(true)
    expect(Object.isFrozen(snapshot.result.cells[0])).toBe(true)
    expect(Object.isFrozen(snapshot.result.cells[0]?.format)).toBe(true)
  })

  test('ends an active visible request with an error when its result does not correlate', () => {
    const store = createStore()
    const seedRequest = beginVisible(store)
    store.setter(resolveProjectionAtom, {
      request: seedRequest,
      result: {
        kind: 'visible-window',
        sheetId: seedRequest.sheetId,
        requestId: seedRequest.requestId,
        revision: 'rev-seed',
        window: seedRequest.window,
        cells: [{ row: 0, col: 0, displayValue: 'retained' }],
      },
    })
    const mismatchedRequest = beginVisible(store, {
      revision: 'rev-a',
      retainResult: true,
    })

    const wrongTicket = {
      ...mismatchedRequest,
      requestId: mismatchedRequest.requestId + 100,
    }
    expect(
      store.setter(resolveProjectionAtom, {
        request: wrongTicket,
        result: {
          kind: 'visible-window',
          sheetId: wrongTicket.sheetId,
          requestId: wrongTicket.requestId,
          revision: wrongTicket.revision,
          window: wrongTicket.window,
          cells: [],
        },
      }),
    ).toEqual({ status: 'ignored', reason: 'stale' })
    expect(store.getter(projectionSnapshotAtom).status).toBe('loading')

    expect(
      store.setter(resolveProjectionAtom, {
        request: mismatchedRequest,
        result: {
          kind: 'visible-window',
          sheetId: mismatchedRequest.sheetId,
          requestId: mismatchedRequest.requestId,
          revision: 'rev-b',
          window: mismatchedRequest.window,
          cells: [],
        },
      }),
    ).toEqual({ status: 'ignored', reason: 'mismatch' })
    const mismatchSnapshot = store.getter(projectionSnapshotAtom)
    expect(mismatchSnapshot.status).toBe('error')
    expect(mismatchSnapshot.request).toBe(mismatchedRequest)
    expect(mismatchSnapshot.result?.cells[0]?.displayValue).toBe('retained')
    expect(mismatchSnapshot.error).toMatchObject({
      code: 'PROJECTION_RESULT_MISMATCH',
      message: 'Projection result did not match the active request.',
    })
    expect(Object.isFrozen(mismatchSnapshot.error)).toBe(true)
    expect(store.getter(projectionRequestIdAtom)).toBe(2)

    const nextRequest = beginVisible(store, { revision: 'rev-a', retainResult: true })
    expect(nextRequest.requestId).toBe(3)
    expect(
      store.setter(resolveProjectionAtom, {
        request: nextRequest,
        result: {
          kind: 'visible-window',
          sheetId: nextRequest.sheetId,
          requestId: nextRequest.requestId,
          revision: 'rev-a',
          window: nextRequest.window,
          cells: [],
        },
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(store.getter(projectionSnapshotAtom).status).toBe('ready')
  })

  test('keeps the active range lane until request id and target match', () => {
    const store = createStore()
    const request = beginRange(store)
    const result = {
      kind: 'range' as const,
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 'rev-range',
      range: request.range,
      cells: [],
    }

    expect(
      store.setter(resolveProjectionAtom, {
        request: { ...request, requestId: request.requestId + 1 },
        result: { ...result, requestId: request.requestId + 1 },
      }),
    ).toEqual({ status: 'ignored', reason: 'stale' })
    expect(
      store.setter(resolveProjectionAtom, {
        request: { ...request, range: { ...request.range, colEnd: request.range.colEnd + 1 } },
        result: { ...result, range: { ...result.range, colEnd: result.range.colEnd + 1 } },
      }),
    ).toEqual({ status: 'ignored', reason: 'stale' })
    expect(
      store.setter(beginProjectionAtom, {
        kind: 'range',
        sheetId: request.sheetId,
        range: request.range,
        reason: request.reason,
      }),
    ).toEqual({ status: 'busy' })
    expect(store.setter(resolveProjectionAtom, { request, result })).toMatchObject({
      status: 'accepted',
      result: { revision: 'rev-range' },
    })
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')
  })

  test('releases an exact active range lane after a mismatched result without display writes', () => {
    const store = createStore()
    const request = beginRange(store)

    expect(
      store.setter(resolveProjectionAtom, {
        request,
        result: {
          kind: 'range',
          sheetId: request.sheetId,
          requestId: request.requestId,
          range: { ...request.range, colEnd: request.range.colEnd + 1 },
          cells: [],
        },
      }),
    ).toEqual({ status: 'ignored', reason: 'mismatch' })
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')
    expect(beginRange(store).requestId).toBe(2)
  })

  test('reset clears old display state while a later begin can claim the successor slot', () => {
    const store = createStore()
    const request = beginVisible(store)

    store.setter(resetProjectionAtom)
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')
    const queued = store.setter(beginProjectionAtom, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: VISIBLE_WINDOW,
      reason: 'test',
    })
    expect(queued).toMatchObject({ status: 'queued', request: { requestId: 2 } })
    if (queued.status !== 'queued') throw new Error('Expected a queued request.')
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: queued.request,
      result: undefined,
    })

    expect(
      store.setter(resolveProjectionAtom, {
        request,
        result: {
          kind: 'visible-window',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'rev-after-reset',
          window: request.window,
          cells: [],
        },
      }),
    ).toMatchObject({ status: 'accepted', nextRequest: queued.request })
    expect(store.getter(projectionSnapshotAtom).request).toBe(queued.request)

    expect(
      store.setter(resolveProjectionAtom, {
        request: queued.request,
        result: {
          kind: 'visible-window',
          sheetId: queued.request.sheetId,
          requestId: queued.request.requestId,
          revision: 'rev-successor',
          window: queued.request.window,
          cells: [],
        },
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(store.getter(projectionSnapshotAtom).status).toBe('ready')
  })

  test('coalesces A to B to C as latest-only and never publishes the older settlement', () => {
    const store = createStore()
    const seed = beginVisible(store)
    store.setter(resolveProjectionAtom, {
      request: seed,
      result: {
        kind: 'visible-window',
        sheetId: seed.sheetId,
        requestId: seed.requestId,
        window: seed.window,
        cells: [{ row: 0, col: 0, displayValue: 'seed' }],
      },
    })

    const active = beginVisible(store, { retainResult: true })
    const queuedB = store.setter(beginProjectionAtom, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: { rowStart: 10, rowEnd: 12, colStart: 0, colEnd: 2 },
      reason: 'test',
      retainResult: true,
    })
    const queuedC = store.setter(beginProjectionAtom, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: { rowStart: 20, rowEnd: 22, colStart: 0, colEnd: 2 },
      reason: 'test',
      retainResult: false,
    })
    expect(queuedB).toMatchObject({ status: 'queued', request: { requestId: 3 } })
    expect(queuedC).toMatchObject({ status: 'queued', request: { requestId: 4 } })
    if (queuedB.status !== 'queued' || queuedC.status !== 'queued') {
      throw new Error('Expected queued visible requests.')
    }
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: queuedC.request,
      result: undefined,
    })

    expect(
      store.setter(resolveProjectionAtom, {
        request: queuedB.request,
        result: {
          kind: 'visible-window',
          sheetId: queuedB.request.sheetId,
          requestId: queuedB.request.requestId,
          window: queuedB.request.window,
          cells: [],
        },
      }),
    ).toEqual({ status: 'ignored', reason: 'stale' })

    const activeResult = {
      kind: 'visible-window' as const,
      sheetId: active.sheetId,
      requestId: active.requestId,
      window: active.window,
      cells: [{ row: 0, col: 0, displayValue: 'old-A' }],
    }
    expect(store.setter(resolveProjectionAtom, { request: active, result: activeResult })).toEqual({
      status: 'accepted',
      result: activeResult,
      nextRequest: queuedC.request,
    })
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: queuedC.request,
      result: undefined,
      error: undefined,
    })
    expect(
      store.setter(rejectProjectionAtom, {
        request: active,
        error: new Error('late A failure'),
      }),
    ).toEqual({ status: 'ignored', reason: 'stale' })
    expect(store.setter(resolveProjectionAtom, { request: active, result: activeResult })).toEqual({
      status: 'ignored',
      reason: 'stale',
    })

    const finalResult = {
      kind: 'visible-window' as const,
      sheetId: queuedC.request.sheetId,
      requestId: queuedC.request.requestId,
      window: queuedC.request.window,
      cells: [{ row: 20, col: 0, displayValue: 'latest-C' }],
    }
    expect(
      store.setter(resolveProjectionAtom, { request: queuedC.request, result: finalResult }),
    ).toMatchObject({ status: 'accepted' })
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'ready',
      request: queuedC.request,
      result: finalResult,
      error: undefined,
    })
    expect(beginVisible(store).requestId).toBe(5)
  })

  test('promotes a queued visible request after an exact active mismatch', () => {
    const store = createStore()
    const active = beginVisible(store, { revision: 'rev-a' })
    const queued = store.setter(beginProjectionAtom, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: VISIBLE_WINDOW,
      revision: 'rev-b',
      reason: 'test',
      retainResult: true,
    })
    if (queued.status !== 'queued') throw new Error('Expected a queued request.')

    expect(
      store.setter(resolveProjectionAtom, {
        request: active,
        result: {
          kind: 'visible-window',
          sheetId: active.sheetId,
          requestId: active.requestId,
          revision: 'wrong-revision',
          window: active.window,
          cells: [],
        },
      }),
    ).toEqual({ status: 'ignored', reason: 'mismatch', nextRequest: queued.request })
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: queued.request,
      error: undefined,
    })

    expect(
      store.setter(resolveProjectionAtom, {
        request: queued.request,
        result: {
          kind: 'visible-window',
          sheetId: queued.request.sheetId,
          requestId: queued.request.requestId,
          revision: queued.request.revision,
          window: queued.request.window,
          cells: [],
        },
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(store.getter(projectionSnapshotAtom).status).toBe('ready')
  })

  test('reset prevents queued work and its predecessor from reviving cleared display state', () => {
    const store = createStore()
    const active = beginVisible(store)
    const queued = store.setter(beginProjectionAtom, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: VISIBLE_WINDOW,
      reason: 'test',
      retainResult: true,
    })
    if (queued.status !== 'queued') throw new Error('Expected a queued request.')

    store.setter(resetProjectionAtom)
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')
    expect(
      store.setter(resolveProjectionAtom, {
        request: active,
        result: {
          kind: 'visible-window',
          sheetId: active.sheetId,
          requestId: active.requestId,
          window: active.window,
          cells: [{ row: 0, col: 0, displayValue: 'old active' }],
        },
      }),
    ).toMatchObject({ status: 'accepted', nextRequest: queued.request })
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')

    expect(
      store.setter(resolveProjectionAtom, {
        request: queued.request,
        result: {
          kind: 'visible-window',
          sheetId: queued.request.sheetId,
          requestId: queued.request.requestId,
          window: queued.request.window,
          cells: [{ row: 0, col: 0, displayValue: 'queued after reset' }],
        },
      }),
    ).toEqual({ status: 'ignored', reason: 'stale' })
    expect(store.getter(projectionSnapshotAtom).status).toBe('idle')
    expect(beginVisible(store).requestId).toBe(3)
  })

  test('maps a rejected refresh to a bounded frozen product error', () => {
    const store = createStore()
    const firstRequest = beginVisible(store)
    store.setter(resolveProjectionAtom, {
      request: firstRequest,
      result: {
        kind: 'visible-window',
        sheetId: firstRequest.sheetId,
        requestId: firstRequest.requestId,
        window: firstRequest.window,
        cells: [{ row: 0, col: 0, displayValue: 'retained' }],
      },
    })

    const refreshRequest = beginVisible(store, { retainResult: true })
    const outcome = store.setter(rejectProjectionAtom, {
      request: refreshRequest,
      error: {
        code: 'E'.repeat(900),
        message: 'M'.repeat(900),
        hint: 'H'.repeat(900),
        severity: 'error',
        source: 'transport',
      },
    })

    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('Expected rejected outcome.')
    expect(outcome.error.code).toHaveLength(512)
    expect(outcome.error.message).toHaveLength(512)
    expect(outcome.error.hint).toHaveLength(512)
    expect(Object.isFrozen(outcome.error)).toBe(true)

    const snapshot = store.getter(projectionSnapshotAtom)
    expect(snapshot.status).toBe('error')
    expect(snapshot.request).toBe(refreshRequest)
    expect(snapshot.result?.kind).toBe('visible-window')
    expect(snapshot.result?.cells[0]?.displayValue).toBe('retained')
    expect(snapshot.error).toBe(outcome.error)

    const retry = beginVisible(store, { retainResult: true })
    expect(retry.requestId).toBe(3)
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: retry,
      result: snapshot.result,
      error: undefined,
    })
    expect(
      store.setter(resolveProjectionAtom, {
        request: retry,
        result: {
          kind: 'visible-window',
          sheetId: retry.sheetId,
          requestId: retry.requestId,
          window: retry.window,
          cells: [{ row: 0, col: 0, displayValue: 'retried' }],
        },
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'ready',
      request: retry,
      result: { cells: [{ displayValue: 'retried' }] },
      error: undefined,
    })
  })
})
