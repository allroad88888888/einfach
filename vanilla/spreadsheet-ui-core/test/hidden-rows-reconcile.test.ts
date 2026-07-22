import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  applyViewportHiddenStructuralShiftAtom,
  getHiddenRowsForSheet,
  hideRowsAtom,
  sheetHiddenRowsAtom,
  unhideRowsAtom,
  viewportHiddenAtom,
  type SetEvalHiddenRowsRequest,
  type SheetHiddenStateRequest,
  type SheetHiddenStateResult,
  type ViewportHiddenPersistencePort,
} from '../src'

// The engine OWNS manually hidden rows since the sink-down
// (design-engine-hidden-rows §4.2/§4.3). A backend that exposes the engine feed
// (`setEvalHiddenRows`, a whole-set replace — the port the worker actually
// offers for manual rows) plus the read-back (`readSheetHiddenState`) turns the
// row commands optimistic-then-reconciled: the projection is written
// synchronously for an instant repaint, then UNCONDITIONALLY overwritten with
// the engine's authoritative set. These tests pin the two acceptance
// disciplines with counter-examples, not tautologies.

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function flushMicrotasks(times = 8): Promise<void> {
  let chain = Promise.resolve()
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined)
  return chain
}

/**
 * Worker-shaped engine port double: records the whole-set `setEvalHiddenRows`
 * feed and answers `readSheetHiddenState` from a controllable per-call queue so
 * tests can drive reconcile timing and out-of-order ACKs.
 */
function createEnginePort() {
  const evalPushes: number[][] = []
  const readbacks: Array<{
    request: SheetHiddenStateRequest
    resolveManual: (rows: number[]) => void
  }> = []
  let immediateManual: ((sheetId: string) => number[]) | null = null

  const port: ViewportHiddenPersistencePort = {
    async setEvalHiddenRows(request: SetEvalHiddenRowsRequest) {
      evalPushes.push([...request.rows])
    },
    async readSheetHiddenState(request): Promise<SheetHiddenStateResult> {
      if (immediateManual) {
        return {
          kind: 'sheet-hidden-state',
          sheetId: request.sheetId,
          requestId: request.requestId,
          manualRows: immediateManual(request.sheetId),
          filterRows: [],
          filterRules: [],
        }
      }
      const gate = deferred<number[]>()
      readbacks.push({ request, resolveManual: gate.resolve })
      const manualRows = await gate.promise
      return {
        kind: 'sheet-hidden-state',
        sheetId: request.sheetId,
        requestId: request.requestId,
        manualRows,
        filterRows: [],
        filterRules: [],
      }
    },
  }

  return {
    port,
    evalPushes,
    readbacks,
    answerImmediately(fn: (sheetId: string) => number[]) {
      immediateManual = fn
    },
  }
}

describe('manual hidden-row reconcile (design-engine-hidden-rows §4.3)', () => {
  test('commits optimistically then reconciles from the engine ACK', async () => {
    const store = createStore()
    const engine = createEnginePort()
    // The engine's authoritative answer DIFFERS from the optimistic value
    // (say a paired rule also hid row 7): the ACK must win.
    engine.answerImmediately(() => [2, 7])

    expect(store.setter(hideRowsAtom, { sheetId: 'A', indices: [2], source: engine.port })).toBe(
      'committed',
    )
    // Optimistic: the grid sees [2] THIS tick, before any await — instant repaint.
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2])
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), 'A')).toEqual([2])

    await flushMicrotasks()
    // The WHOLE optimistic set reached the engine through setEvalHiddenRows.
    expect(engine.evalPushes).toEqual([[2]])
    // Reconciled: the engine's authoritative set replaced the optimistic one.
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2, 7])
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), 'A')).toEqual([2, 7])
  })

  test('reconcile OVERWRITES unconditionally, even when the engine agrees', async () => {
    const store = createStore()
    const engine = createEnginePort()
    // The engine returns exactly the optimistic set. Discipline 1 forbids a
    // "value is equal, skip the write" shortcut — the overwrite must still fire,
    // or a bounded optimistic window could decay into a permanent silent
    // divergence (design §4.3 / §9.3).
    engine.answerImmediately(() => [2])

    let writes = 0
    const unsubscribe = store.sub(sheetHiddenRowsAtom, () => {
      writes += 1
    })
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [2], source: engine.port })
    expect(writes).toBe(1) // the optimistic write
    await flushMicrotasks()
    // The reconcile wrote AGAIN despite the value being identical. A skip-if-equal
    // guard would have left this at 1 — this is the counter-example that rules it out.
    expect(writes).toBe(2)
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2])
    unsubscribe()
  })

  test('discards an out-of-order STALE ACK; the newest hide wins', async () => {
    const store = createStore()
    const engine = createEnginePort()

    store.setter(hideRowsAtom, { sheetId: 'A', indices: [2], source: engine.port }) // generation 1
    // generation 2 → optimistic [2, 7]
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [7], source: engine.port })
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2, 7])

    // Let both reconciles reach their readback await.
    await flushMicrotasks()
    expect(engine.readbacks).toHaveLength(2)

    // Resolve the NEWEST (gen 2) first with its authoritative answer …
    engine.readbacks[1].resolveManual([2, 7])
    await flushMicrotasks()
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2, 7])

    // … then the STALE gen-1 ACK arrives out of order. Without the generation
    // guard it would flash the view back to [2]; it must be discarded instead.
    engine.readbacks[0].resolveManual([2])
    await flushMicrotasks()
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2, 7])
  })

  test('a structural shift before the ACK invalidates the in-flight reconcile', async () => {
    const store = createStore()
    const engine = createEnginePort()

    // generation 1, optimistic [5]
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [5], source: engine.port })
    await flushMicrotasks()
    expect(engine.readbacks).toHaveLength(1)

    // Insert a row at the top before the ACK lands: the projection shifts 5 → 6,
    // and the engine self-displaces its owned set the same way, so a stale ACK
    // still carrying the pre-shift [5] must not clobber the shifted [6].
    store.setter(applyViewportHiddenStructuralShiftAtom, {
      sheetId: 'A',
      shift: { axis: 'row', kind: 'insert', index: 0, count: 1 },
    })
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([6])

    engine.readbacks[0].resolveManual([5]) // pre-shift answer — now stale
    await flushMicrotasks()
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([6])
  })

  test('unhide feeds the engine the reduced whole-set and reconciles to it', async () => {
    const store = createStore()
    const engine = createEnginePort()
    engine.answerImmediately((sheetId) => (sheetId === 'A' ? [3] : []))

    store.setter(hideRowsAtom, { sheetId: 'A', indices: [3, 8], source: engine.port })
    await flushMicrotasks()
    // The engine reports only [3] survived (row 8 was already unhidden elsewhere).
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([3])

    engine.answerImmediately(() => [])
    store.setter(unhideRowsAtom, { sheetId: 'A', indices: [3], source: engine.port })
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([])
    await flushMicrotasks()
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([])
    // The last feed carried the reduced whole set (empty), not a delta.
    expect(engine.evalPushes[engine.evalPushes.length - 1]).toEqual([])
  })

  test('a backend with only hideRows (no engine feed) degrades to a delta mirror', async () => {
    const store = createStore()
    const hideRows: number[][] = []
    const port: ViewportHiddenPersistencePort = {
      async hideRows(request) {
        hideRows.push([...request.rowIndices])
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }
    let writes = 0
    const unsubscribe = store.sub(sheetHiddenRowsAtom, () => {
      writes += 1
    })
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [2], source: port })
    await flushMicrotasks()
    // No engine feed → exactly one (optimistic) write and a mirrored delta.
    expect(writes).toBe(1)
    expect(hideRows).toEqual([[2]])
    expect(store.getter(sheetHiddenRowsAtom)['A']).toEqual([2])
    unsubscribe()
  })
})
