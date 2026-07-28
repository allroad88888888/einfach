import { createStore, type Store } from '@einfach/core'
import { describe, expect, it } from '@jest/globals'
import {
  beginProjectionAtom,
  projectionSnapshotAtom,
  resolveProjectionAtom,
  type RangeProjectionRequest,
  type SpreadsheetBackend,
  type VisibleProjectionRequest,
  type VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection } from '../src-vnext/provider/projection-refresh'

const WINDOW = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 } as const

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function resultFor(
  request: VisibleProjectionRequest,
  displayValue: string,
): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision,
    window: request.window,
    cells: [{ row: request.window.rowStart, col: request.window.colStart, displayValue }],
  }
}

function seedReadyProjection(store: Store, displayValue = 'seed'): void {
  const begin = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: 'sheet-1',
    window: WINDOW,
    reason: 'test',
  })
  if (begin.status !== 'started' || begin.request.kind !== 'visible-window') {
    throw new Error(`Expected a started visible request, received ${begin.status}.`)
  }
  const outcome = store.setter(resolveProjectionAtom, {
    request: begin.request,
    result: resultFor(begin.request, displayValue),
  })
  if (outcome.status !== 'accepted') throw new Error('Failed to seed projection state.')
}

function createControlledBackend() {
  const gates: Array<Deferred<VisibleProjectionResult>> = []
  const requests: VisibleProjectionRequest[] = []
  let concurrency = 0
  let maxConcurrency = 0

  const backend: SpreadsheetBackend = {
    readVisibleProjection(request) {
      const gate = deferred<VisibleProjectionResult>()
      requests.push(request)
      gates.push(gate)
      concurrency += 1
      maxConcurrency = Math.max(maxConcurrency, concurrency)
      return gate.promise.then(
        (result) => {
          concurrency -= 1
          return result
        },
        (error) => {
          concurrency -= 1
          throw error
        },
      )
    },
    async readRangeProjection(request: RangeProjectionRequest) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        cells: [],
      }
    },
    async setCellInput(request) {
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }

  return {
    backend,
    gates,
    requests,
    get maxConcurrency() {
      return maxConcurrency
    },
  }
}

async function waitForRequestCount(
  controlled: ReturnType<typeof createControlledBackend>,
  expected: number,
): Promise<void> {
  for (let index = 0; index < 20 && controlled.requests.length < expected; index += 1) {
    await Promise.resolve()
  }
  expect(controlled.requests).toHaveLength(expected)
}

describe('visible projection refresh transport', () => {
  it('runs A then latest C with one transport and never dispatches replaced B', async () => {
    const store = createStore()
    seedReadyProjection(store)
    const controlled = createControlledBackend()

    const activeRun = refreshVisibleProjection(store, controlled.backend, 'sheet-1', 'toolbar')
    expect(controlled.requests).toHaveLength(1)
    const activeRequest = controlled.requests[0]!

    const queuedB = refreshVisibleProjection(store, controlled.backend, 'sheet-1', 'toolbar')
    const queuedC = refreshVisibleProjection(store, controlled.backend, 'sheet-1', 'toolbar')
    await Promise.all([queuedB, queuedC])
    expect(controlled.requests).toHaveLength(1)

    const latestSnapshot = store.getter(projectionSnapshotAtom)
    expect(latestSnapshot).toMatchObject({ status: 'loading', request: { requestId: 4 } })
    if (latestSnapshot.request?.kind !== 'visible-window') {
      throw new Error('Expected the latest visible request.')
    }
    const latestRequest = latestSnapshot.request

    controlled.gates[0]!.resolve(resultFor(activeRequest, 'old A'))
    await waitForRequestCount(controlled, 2)
    expect(controlled.requests[1]).toBe(latestRequest)
    expect(controlled.requests.map((request) => request.requestId)).toEqual([
      activeRequest.requestId,
      latestRequest.requestId,
    ])
    expect(controlled.maxConcurrency).toBe(1)
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: latestRequest,
      result: { cells: [{ displayValue: 'seed' }] },
    })

    controlled.gates[1]!.resolve(resultFor(latestRequest, 'latest C'))
    await activeRun
    expect(controlled.maxConcurrency).toBe(1)
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'ready',
      request: latestRequest,
      result: { cells: [{ displayValue: 'latest C' }] },
      error: undefined,
    })
  })

  it('supersedes an older failure, rejects the terminal failure, and permits retry', async () => {
    const store = createStore()
    seedReadyProjection(store)
    const controlled = createControlledBackend()

    const batch = refreshVisibleProjection(store, controlled.backend, 'sheet-1', 'toolbar')
    const supersedingCaller = refreshVisibleProjection(
      store,
      controlled.backend,
      'sheet-1',
      'toolbar',
    )
    await supersedingCaller

    const oldError = new Error('old A failed')
    controlled.gates[0]!.reject(oldError)
    await waitForRequestCount(controlled, 2)
    const successor = controlled.requests[1]!
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'loading',
      request: successor,
      error: undefined,
    })
    controlled.gates[1]!.resolve(resultFor(successor, 'successor ready'))
    await expect(batch).resolves.toBeUndefined()

    const terminalError = new Error('final request failed')
    const terminalRun = refreshVisibleProjection(store, controlled.backend, 'sheet-1', 'toolbar')
    await waitForRequestCount(controlled, 3)
    const terminalAssertion = expect(terminalRun).rejects.toBe(terminalError)
    controlled.gates[2]!.reject(terminalError)
    await terminalAssertion
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'error',
      request: controlled.requests[2],
      result: { cells: [{ displayValue: 'successor ready' }] },
      error: { code: 'BACKEND_ERROR', message: 'final request failed' },
    })

    const retryRun = refreshVisibleProjection(store, controlled.backend, 'sheet-1', 'toolbar')
    await waitForRequestCount(controlled, 4)
    const retry = controlled.requests[3]!
    controlled.gates[3]!.resolve(resultFor(retry, 'retry ready'))
    await expect(retryRun).resolves.toBeUndefined()
    expect(controlled.maxConcurrency).toBe(1)
    expect(store.getter(projectionSnapshotAtom)).toMatchObject({
      status: 'ready',
      request: retry,
      result: { cells: [{ displayValue: 'retry ready' }] },
      error: undefined,
    })
  })
})
