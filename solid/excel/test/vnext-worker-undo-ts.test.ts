/**
 * Host-orchestrated undo/redo on the WORKER path — TS runtime, real
 * in-process stack (parity #15/#36, CANONICAL_OWNERSHIP §4).
 *
 * The full production stack runs without a real Worker: the actual
 * `createWorkerRuntimeTs()` dispatcher behind a duplex in-process
 * bridge, the actual `WorkerWorkbookClient`, and the actual
 * `createWorkerWorkbookSpreadsheetBackend`. Pins:
 *
 *  - value / formula / clear undo+redo round trips (clear-then-restore:
 *    `restoreSparse` is ADDITIVE, so redo of a clear must not leave the
 *    restored value behind — design point A),
 *  - transactionId lazy binding + structured not-applied for unknown
 *    ids / empty stacks (design point C),
 *  - bounded stack (cap 100, oldest dropped),
 *  - UI-core history integration: runUndo/runRedo through the real
 *    backend port, witness accepted from the ACK, not-applied lands on
 *    outcome-unknown, local side payloads replay after the backend ACK,
 *  - async custom formulas: an in-flight settle does not corrupt an
 *    undone cell, and redo re-converges (Wave 8.2 interplay).
 */

import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  HISTORY_NOT_APPLIED_ERROR,
  VIEWPORT_HIDDEN_REPLAY_KEY,
  getHiddenRowsForSheet,
  hideRowsAtom,
  historyLifecycleAtom,
  historyStackAtom,
  pushHistoryAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  viewportHiddenAtom,
  type CellRange,
  type DisplayCell,
} from '@einfach/spreadsheet-ui-core'

import {
  installWorkerRuntimeTs,
  type ExcelCoreTsWorkerRuntime,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import { createWorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'

const SHEET = 'sheet-1'

/** Duplex in-process worker over the real TS runtime (failclosed-suite shape). */
function createInProcessTsWorker(): { worker: WorkerLike; runtime: ExcelCoreTsWorkerRuntime } {
  const toWorker: Array<(e: MessageEvent) => void> = []
  const toClient: Array<(e: MessageEvent) => void> = []
  const workerCtx: WorkerContext = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type, listener) {
      toWorker.push(listener)
    },
  }
  const runtime = installWorkerRuntimeTs(workerCtx)
  const worker: WorkerLike = {
    postMessage(msg: unknown) {
      for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      toClient.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = toClient.indexOf(listener)
      if (index >= 0) toClient.splice(index, 1)
    },
    terminate() {},
  }
  return { worker, runtime }
}

async function createBackend(): Promise<{
  backend: WorkerWorkbookSpreadsheetBackend
  runtime: ExcelCoreTsWorkerRuntime
}> {
  const { worker, runtime } = createInProcessTsWorker()
  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: () => worker,
    sheets: [{ id: SHEET, name: 'Sheet1' }],
  })
  await backend.ready()
  return { backend, runtime }
}

let projectionRequestId = 1

async function readCells(
  backend: WorkerWorkbookSpreadsheetBackend,
  range: CellRange,
): Promise<DisplayCell[]> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    range,
    requestId: projectionRequestId++,
    reason: 'viewport',
  })
  return result.cells
}

async function displayAt(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
): Promise<string> {
  const cells = await readCells(backend, {
    rowStart: row,
    rowEnd: row,
    colStart: col,
    colEnd: col,
  })
  return cells.find((cell) => cell.row === row && cell.col === col)?.displayValue ?? ''
}

async function setInput(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
  input: string,
) {
  return backend.setCellInput({ kind: 'set-cell-input', sheetId: SHEET, row, col, input })
}

let txCounter = 0
function undoRequest(transactionId?: string) {
  txCounter += 1
  return {
    kind: 'undo-transaction' as const,
    transactionId: transactionId ?? `test-tx-${txCounter}`,
    requestId: txCounter,
    revision: 0,
  }
}

function redoRequest(transactionId: string) {
  txCounter += 1
  return {
    kind: 'redo-transaction' as const,
    transactionId,
    requestId: txCounter,
    revision: 0,
  }
}

describe('worker adapter host-orchestrated undo — TS runtime, real in-process stack', () => {
  test('value edit round-trips: undo restores the before value, redo re-applies', async () => {
    const { backend } = await createBackend()
    await setInput(backend, 0, 0, '1')
    await setInput(backend, 0, 0, '2')
    expect(await displayAt(backend, 0, 0)).toBe('2')

    const undoAck = await backend.undoTransaction!(undoRequest('tx-value'))
    expect(undoAck.applied).not.toBe(false)
    expect(typeof undoAck.revision).toBe('number')
    expect(undoAck.affectedRange).toEqual({
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 0,
    })
    expect(await displayAt(backend, 0, 0)).toBe('1')

    const redoAck = await backend.redoTransaction!(redoRequest('tx-value'))
    expect(redoAck.applied).not.toBe(false)
    expect(redoAck.revision).not.toBe(undoAck.revision)
    expect(await displayAt(backend, 0, 0)).toBe('2')
    backend.dispose()
  })

  test('formula undo restores the source formula and it re-evaluates', async () => {
    const { backend } = await createBackend()
    await setInput(backend, 0, 0, '2')
    await setInput(backend, 0, 1, '=A1*2')
    expect(await displayAt(backend, 0, 1)).toBe('4')
    await setInput(backend, 0, 1, '=A1+1')
    expect(await displayAt(backend, 0, 1)).toBe('3')

    await backend.undoTransaction!(undoRequest('tx-formula'))
    expect(await displayAt(backend, 0, 1)).toBe('4')
    const cells = await readCells(backend, { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 })
    expect(cells[0]?.formula).toBe('=A1*2')

    // The restored formula stays live: editing its input recomputes it.
    await setInput(backend, 0, 0, '10')
    expect(await displayAt(backend, 0, 1)).toBe('20')
    backend.dispose()
  })

  test('clear-then-restore: redo of a clear leaves no residue (design point A)', async () => {
    const { backend } = await createBackend()
    await setInput(backend, 0, 0, '7')
    await backend.clearRange!({
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      target: 'values',
    })
    expect(await displayAt(backend, 0, 0)).toBe('')

    await backend.undoTransaction!(undoRequest('tx-clear'))
    expect(await displayAt(backend, 0, 0)).toBe('7')

    // restoreSparse is ADDITIVE: without the clear-first step this redo
    // would restore an EMPTY after-image on top of the live `7` and the
    // value would survive the redo.
    await backend.redoTransaction!(redoRequest('tx-clear'))
    expect(await displayAt(backend, 0, 0)).toBe('')
    backend.dispose()
  })

  test('range clear undo restores every cell in the range', async () => {
    const { backend } = await createBackend()
    await backend.importCells!({
      kind: 'import-cells',
      sheetId: SHEET,
      cells: [
        { row: 0, col: 0, input: 'a' },
        { row: 0, col: 1, input: 'b' },
        { row: 1, col: 0, input: '3' },
        { row: 1, col: 1, input: '=A2*2' },
      ],
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    await backend.clearRange!({
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      target: 'all',
    })
    expect(await readCells(backend, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })).toEqual([])

    await backend.undoTransaction!(undoRequest('tx-range-clear'))
    expect(await displayAt(backend, 0, 0)).toBe('a')
    expect(await displayAt(backend, 0, 1)).toBe('b')
    expect(await displayAt(backend, 1, 0)).toBe('3')
    expect(await displayAt(backend, 1, 1)).toBe('6')
    backend.dispose()
  })

  test('import undo round-trips through the recorded bounding range', async () => {
    const { backend } = await createBackend()
    await setInput(backend, 0, 0, 'keep')
    // No explicit range: the adapter derives the bounding box from the
    // concrete cell list instead of degrading to not-undoable.
    await backend.importCells!({
      kind: 'import-cells',
      sheetId: SHEET,
      cells: [
        { row: 0, col: 0, input: 'overwritten' },
        { row: 2, col: 2, input: '42' },
      ],
    })
    expect(await displayAt(backend, 0, 0)).toBe('overwritten')

    await backend.undoTransaction!(undoRequest('tx-import'))
    expect(await displayAt(backend, 0, 0)).toBe('keep')
    expect(await displayAt(backend, 2, 2)).toBe('')

    await backend.redoTransaction!(redoRequest('tx-import'))
    expect(await displayAt(backend, 0, 0)).toBe('overwritten')
    expect(await displayAt(backend, 2, 2)).toBe('42')
    backend.dispose()
  })

  test('unknown transactionId and empty stacks answer structured not-applied', async () => {
    const { backend } = await createBackend()

    // Empty undo stack.
    const empty = await backend.undoTransaction!(undoRequest('tx-none'))
    expect(empty.applied).toBe(false)
    expect(empty.notAppliedReason).toContain('no recorded backend transaction')

    await setInput(backend, 0, 0, '1')
    await backend.undoTransaction!(undoRequest('tx-bound'))

    // The undone record is bound to 'tx-bound'; redo under a different id
    // must refuse instead of replaying someone else's transaction.
    const mismatch = await backend.redoTransaction!(redoRequest('tx-other'))
    expect(mismatch.applied).toBe(false)
    expect(mismatch.notAppliedReason).toContain('unknown transactionId')

    // The correct id still replays.
    const redoAck = await backend.redoTransaction!(redoRequest('tx-bound'))
    expect(redoAck.applied).not.toBe(false)
    expect(await displayAt(backend, 0, 0)).toBe('1')
    backend.dispose()
  })

  test('a new mutation truncates the redo tail', async () => {
    const { backend } = await createBackend()
    await setInput(backend, 0, 0, '1')
    await setInput(backend, 0, 0, '2')
    await backend.undoTransaction!(undoRequest('tx-a'))
    expect(await displayAt(backend, 0, 0)).toBe('1')

    await setInput(backend, 0, 0, '9')
    const stale = await backend.redoTransaction!(redoRequest('tx-a'))
    expect(stale.applied).toBe(false)
    backend.dispose()
  })

  test('stack is bounded at 100 records; the oldest drops', async () => {
    const { backend } = await createBackend()
    for (let index = 0; index <= 101; index += 1) {
      await setInput(backend, 0, 0, String(index))
    }
    // 102 mutations recorded, cap 100 → the two oldest records (inputs
    // '' → '0' and '0' → '1') were evicted. 100 undos walk back to the
    // oldest surviving before-image ('1'), the 101st answers not-applied.
    for (let index = 0; index < 100; index += 1) {
      const ack = await backend.undoTransaction!(undoRequest())
      expect(ack.applied).not.toBe(false)
    }
    expect(await displayAt(backend, 0, 0)).toBe('1')
    const exhausted = await backend.undoTransaction!(undoRequest())
    expect(exhausted.applied).toBe(false)
    backend.dispose()
  })

  test('UI-core history: undo/redo complete and commit the ACK witness', async () => {
    const { backend } = await createBackend()
    const store = createStore()

    await setInput(backend, 0, 0, 'before')
    const mutation = await setInput(backend, 0, 0, 'after')
    expect(
      store.setter(pushHistoryAtom, {
        transactionId: 'ui-tx-1',
        kind: 'cell.set-input',
        sheetId: SHEET,
        projectionRevision: mutation.revision as number,
        affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    ).toBe(true)

    const undoOutcome = await store.setter(runUndoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(undoOutcome).toBe('completed')
    expect(await displayAt(backend, 0, 0)).toBe('before')
    expect(store.getter(historyStackAtom).cursor).toBe(0)

    const redoOutcome = await store.setter(runRedoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(redoOutcome).toBe('completed')
    expect(await displayAt(backend, 0, 0)).toBe('after')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    backend.dispose()
  })

  test('UI-core history: not-applied lands on outcome-unknown, cursor keeps', async () => {
    const { backend } = await createBackend()
    const store = createStore()

    await setInput(backend, 0, 0, 'x')
    // Entry recorded for a transaction the adapter no longer holds: bind
    // the adapter record to a different id first.
    await backend.undoTransaction!(undoRequest('someone-else'))
    await backend.redoTransaction!(redoRequest('someone-else'))

    store.setter(pushHistoryAtom, {
      transactionId: 'ui-tx-unknown',
      kind: 'cell.set-input',
      sheetId: SHEET,
      projectionRevision: 5,
    })
    const outcome = await store.setter(runUndoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(outcome).toBe('outcome-unknown')
    const lifecycle = store.getter(historyLifecycleAtom)
    expect(lifecycle.status).toBe('outcome-unknown')
    expect(lifecycle.error).toContain(HISTORY_NOT_APPLIED_ERROR)
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    backend.dispose()
  })

  test('local side payloads replay after the backend undo ACK (hidden rows)', async () => {
    const { backend } = await createBackend()
    const store = createStore()

    await setInput(backend, 0, 0, 'v1')
    const mutation = await setInput(backend, 0, 0, 'v2')

    // Simulate the recorded view-fact displacement: hidden rows changed
    // from [2] (before) to [] (after) across the backend transaction.
    store.setter(hideRowsAtom, { sheetId: SHEET, indices: [2] })
    store.setter(pushHistoryAtom, {
      transactionId: 'ui-tx-side',
      kind: 'cell.set-input',
      sheetId: SHEET,
      projectionRevision: mutation.revision as number,
      localSidePayloads: [
        {
          applyKey: VIEWPORT_HIDDEN_REPLAY_KEY,
          sheetId: SHEET,
          before: { rows: [2], cols: [] },
          after: { rows: [], cols: [] },
        },
      ],
    })
    // Live state matches the "after" side.
    store.setter(hideRowsAtom, { sheetId: SHEET, indices: [] })
    const hiddenNow = getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)
    expect(hiddenNow).toEqual([2])

    const outcome = await store.setter(runUndoHistoryAtom, {
      source: backend,
      refreshProjection: async () => {},
    })
    expect(outcome).toBe('completed')
    expect(await displayAt(backend, 0, 0)).toBe('v1')
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([2])
    backend.dispose()
  })

  test('async custom formula: stale settle skips undone cell; redo re-converges', async () => {
    const { backend, runtime } = await createBackend()
    type Latch = { promise: Promise<void>; resolve: () => void }
    const makeLatch = (): Latch => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, resolve: release }
    }
    const latch = makeLatch()
    ;(globalThis as Record<string, unknown>).__einfachUndoTestLatch = latch.promise

    await backend.registerCustomFormula!(
      'SLOWX10',
      'await globalThis.__einfachUndoTestLatch; return args[0] * 10',
      { isAsync: true },
    )
    await setInput(backend, 0, 0, '5')
    // Record: B1 goes from empty to the async formula. Reading it kicks
    // off the async call which now hangs on the latch.
    await setInput(backend, 0, 1, '=SLOWX10(A1)')
    expect(await displayAt(backend, 0, 1)).toBe('#BUSY!')

    // Undo while the settle is in flight: B1 returns to empty.
    await backend.undoTransaction!(undoRequest('tx-async'))
    expect(await displayAt(backend, 0, 1)).toBe('')

    // The stale settle lands afterwards and must not resurrect a value
    // in the undone cell.
    latch.resolve()
    await runtime.asyncPumpIdle()
    expect(await displayAt(backend, 0, 1)).toBe('')

    // Redo restores the formula source; evaluation converges (memoized
    // or re-invoked — either way the settled value appears).
    await backend.redoTransaction!(redoRequest('tx-async'))
    const settle = async () => {
      await runtime.asyncPumpIdle()
      return displayAt(backend, 0, 1)
    }
    let display = await settle()
    for (let attempt = 0; attempt < 10 && display === '#BUSY!'; attempt += 1) {
      display = await settle()
    }
    expect(display).toBe('50')
    delete (globalThis as Record<string, unknown>).__einfachUndoTestLatch
    backend.dispose()
  })
})
