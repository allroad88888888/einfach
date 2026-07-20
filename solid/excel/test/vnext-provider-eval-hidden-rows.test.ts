import { describe, expect, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import {
  hideRowsAtom,
  unhideRowsAtom,
  type SetEvalHiddenRowsRequest,
  type SpreadsheetBackend,
  type VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import { attachEvalHiddenRowsBridge } from '../src-vnext/provider/eval-hidden-rows-bridge'
import { seedReadyVisibleProjection } from './projection-test-fixture'

/**
 * Provider eval-hidden-rows bridge (parity #23). The bridge mirrors the
 * UI-core canonical hidden-row VIEW fact into the engine's SUBTOTAL 101-111
 * eval input through the optional `setEvalHiddenRows` port, then refreshes
 * the active window so the recomputed formulas reproject. It is a whole-set
 * REPLACE (idempotent), and a backend without the port degrades silently.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Recorded {
  hidden: SetEvalHiddenRowsRequest[]
  reads: number
}

function seedActiveProjection(store: Store): void {
  seedReadyVisibleProjection(store, {
    status: 'ready',
    result: {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
      requestId: 0,
      cells: [],
    },
  })
}

function makeBackend(rec: Recorded, opts: { omitPort?: boolean } = {}): SpreadsheetBackend {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request: VisibleProjectionRequest) {
      rec.reads += 1
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: request.window,
        requestId: request.requestId,
        cells: [],
      }
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
  if (!opts.omitPort) {
    backend.setEvalHiddenRows = (request) => {
      rec.hidden.push(request)
    }
  }
  return backend
}

describe('vNext Provider eval-hidden-rows bridge', () => {
  test('a hide pushes the whole hidden set and then refreshes the active window', async () => {
    const store = createStore()
    seedActiveProjection(store)
    const rec: Recorded = { hidden: [], reads: 0 }
    const detach = attachEvalHiddenRowsBridge(store, makeBackend(rec))

    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    await flush()

    expect(rec.hidden).toEqual([{ kind: 'set-eval-hidden-rows', sheetId: 'sheet-1', rows: [2] }])
    // The engine epoch bump recomputed the 101-111 formulas → the bridge
    // refetches the active window so the projection reflects the new values.
    expect(rec.reads).toBeGreaterThanOrEqual(1)
    detach()
  })

  test('successive hides push the full replacement set, and unhide clears it', async () => {
    const store = createStore()
    seedActiveProjection(store)
    const rec: Recorded = { hidden: [], reads: 0 }
    const detach = attachEvalHiddenRowsBridge(store, makeBackend(rec))

    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    await flush()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [4] })
    await flush()
    store.setter(unhideRowsAtom, { sheetId: 'sheet-1', indices: [2, 4] })
    await flush()

    expect(rec.hidden.map((request) => request.rows)).toEqual([[2], [2, 4], []])
    detach()
  })

  test('re-hiding an already-hidden row does not re-push (idempotent)', async () => {
    const store = createStore()
    seedActiveProjection(store)
    const rec: Recorded = { hidden: [], reads: 0 }
    const detach = attachEvalHiddenRowsBridge(store, makeBackend(rec))

    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    await flush()
    // The canonical set is unchanged, so the atom never fires a second time.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    await flush()

    expect(rec.hidden.map((request) => request.rows)).toEqual([[2]])
    detach()
  })

  test('a backend without the port degrades silently (no throw, no refresh)', async () => {
    const store = createStore()
    seedActiveProjection(store)
    const rec: Recorded = { hidden: [], reads: 0 }
    const detach = attachEvalHiddenRowsBridge(store, makeBackend(rec, { omitPort: true }))

    expect(() => store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })).not.toThrow()
    await flush()

    expect(rec.hidden).toEqual([])
    expect(rec.reads).toBe(0)
    detach()
  })

  test('detach stops further pushes', async () => {
    const store = createStore()
    seedActiveProjection(store)
    const rec: Recorded = { hidden: [], reads: 0 }
    const detach = attachEvalHiddenRowsBridge(store, makeBackend(rec))

    detach()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [3] })
    await flush()

    expect(rec.hidden).toEqual([])
  })
})
