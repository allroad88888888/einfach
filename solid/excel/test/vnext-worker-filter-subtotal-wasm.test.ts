/**
 * @jest-environment node
 *
 * #27 S4 — an ACTIVE FILTER reaches the engine, over the REAL Rust engine and
 * the REAL `worker-runtime.ts` dispatcher in process (same harness as
 * vnext-worker-subtotal-hidden-wasm.test.ts: wasm-pkg jest-mocked onto itself
 * with the binary pre-loaded through `initSync`, a fake `self` installed
 * before the runtime module imports).
 *
 * What the slice actually changes: `setFilterSort` now derives the
 * filter-hidden SOURCE rows from the predicate scan it already runs and pushes
 * them through `setEvalFilterHiddenRows`. Before that push existed the engine
 * had no idea a filter was on, so `SUBTOTAL(1-11)` aggregated rows the user
 * had filtered away — a divergence from Excel
 * (`design-filter-hidden-rows` §2), which is why the assertions below are a
 * BUG FIX rather than a new capability.
 *
 * These tests are deliberately differential, not tautological:
 *  - every aggregate is pinned BEFORE the filter too, and the pre-filter value
 *    is exactly what the unfixed path answers afterwards, so an implementation
 *    that pushed nothing fails on the post-filter numbers;
 *  - a plain `SUM` over the identical range is pinned as an unmoved control,
 *    proving no data was touched and only the SUBTOTAL lane responded;
 *  - the manual lane is driven at the same time to pin the two-layer rule
 *    (1-11 keeps manually hidden rows, 101-111 drops them).
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import { createStore } from '@einfach/core'
import type { DisplayCell } from '@einfach/spreadsheet-ui-core'
import {
  createInsertRowsOperation,
  getFilterHiddenRowsForSheet,
  getHiddenRowsForSheet,
  hideRowsAtom,
  runStructureOperationAtom,
  runUndoHistoryAtom,
  setViewportFilterHiddenRowsAtom,
  viewportFilterHiddenAtom,
  viewportHiddenAtom,
} from '@einfach/spreadsheet-ui-core'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'

jest.mock('../wasm-pkg/einfach_wasm.js', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const nodePath = require('node:path') as typeof import('node:path')
  const real = jest.requireActual('../wasm-pkg/einfach_wasm.js') as {
    initSync: (input: { module: ArrayBufferLike }) => unknown
    WasmWorkbook: unknown
  }
  const bytes = readFileSync(nodePath.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm_bg.wasm'))
  real.initSync({
    module: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  return {
    __esModule: true,
    default: async () => undefined,
    WasmWorkbook: real.WasmWorkbook,
  }
})

const SHEET = 'sheet-1'

type Listener = (e: MessageEvent) => void
const toWorker: Listener[] = []
const toClient: Listener[] = []

const inProcessWorker: WorkerLike = {
  postMessage(msg: unknown) {
    for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
  },
  addEventListener(_type: 'message', listener: Listener) {
    toClient.push(listener)
  },
  removeEventListener(_type: 'message', listener: Listener) {
    const index = toClient.indexOf(listener)
    if (index >= 0) toClient.splice(index, 1)
  },
  terminate() {},
}

let createBackend: (() => WorkerWorkbookSpreadsheetBackend) | undefined

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).self = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: string, listener: Listener) {
      toWorker.push(listener)
    },
  }
  await import('../src-vnext/adapter/worker-runtime')
  const adapter = await import('../src-vnext/adapter')
  createBackend = () =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => inProcessWorker,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })
})

let requestId = 1

/**
 * Region | Q1 over three data rows, plus three probes on ROW 0.
 *
 * The probes live on the header row on purpose: row 0 is a pass-through in the
 * filter permutation, so they stay readable while the compression semantics
 * are still in place (that retires in S5, not here).
 *
 *   A1 Region  B1 Q1   D1 =SUBTOTAL(9,…)  E1 =SUBTOTAL(109,…)  F1 =SUM(…)
 *   A2 North   B2 10
 *   A3 South   B3 20
 *   A4 North   B4 30
 */
const SEED: ReadonlyArray<readonly [number, number, string]> = [
  [0, 0, 'Region'],
  [0, 1, 'Q1'],
  [1, 0, 'North'],
  [1, 1, '10'],
  [2, 0, 'South'],
  [2, 1, '20'],
  [3, 0, 'North'],
  [3, 1, '30'],
  [0, 3, '=SUBTOTAL(9,B2:B4)'],
  [0, 4, '=SUBTOTAL(109,B2:B4)'],
  [0, 5, '=SUM(B2:B4)'],
]

async function seed(backend: WorkerWorkbookSpreadsheetBackend): Promise<void> {
  for (const [row, col, input] of SEED) {
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row,
      col,
      input,
      requestId: requestId++,
    })
  }
}

async function readRow0(
  backend: WorkerWorkbookSpreadsheetBackend,
): Promise<{ subtotal9: string; subtotal109: string; sum: string }> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    reason: 'test',
    requestId: requestId++,
    range: { rowStart: 0, rowEnd: 0, colStart: 3, colEnd: 5 },
  })
  const at = (col: number): string =>
    result.cells.find((cell: DisplayCell) => cell.row === 0 && cell.col === col)?.displayValue ?? ''
  return { subtotal9: at(3), subtotal109: at(4), sum: at(5) }
}

function filterToNorth(backend: WorkerWorkbookSpreadsheetBackend) {
  return backend.setFilterSort!({
    kind: 'set-filter-sort',
    sheetId: SHEET,
    rules: [{ kind: 'equals', colIndex: 0, value: 'North' }],
    requestId: requestId++,
  })
}

describe('worker adapter: an active filter reaches the engine (#27 S4)', () => {
  test('both SUBTOTAL bands drop filtered-out rows; SUM is the unmoved control', async () => {
    const backend = createBackend!()
    await backend.ready()
    await seed(backend)

    // Unfiltered baseline. These ARE the numbers the unfixed path keeps
    // answering after the filter is applied, so the post-filter assertions
    // below cannot pass without the push.
    expect(await readRow0(backend)).toEqual({
      subtotal9: '60',
      subtotal109: '60',
      sum: '60',
    })

    await filterToNorth(backend)

    // South (source row 2, Q1 = 20) is filtered out. BOTH bands drop it —
    // 1-11 excluding filter-hidden rows is the Excel rule the second eval
    // input exists to express.
    const filtered = await readRow0(backend)
    expect(filtered.subtotal9).toBe('40')
    expect(filtered.subtotal109).toBe('40')
    // Control: SUM is not a SUBTOTAL, so it must be completely unaffected.
    // A different number here would mean the filter moved DATA, which it must
    // never do (filter is visibility, sorting is the physical mutation).
    expect(filtered.sum).toBe('60')

    // Clearing restores everything — whole-set replace, empty clears.
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [],
      requestId: requestId++,
    })
    expect(await readRow0(backend)).toEqual({
      subtotal9: '60',
      subtotal109: '60',
      sum: '60',
    })

    backend.dispose()
  })

  test('manual and filter hiding stay independent (the two-layer rule)', async () => {
    const backend = createBackend!()
    await backend.ready()
    await seed(backend)

    await filterToNorth(backend)
    // …and manually hide North's first row (source row 1, Q1 = 10) through
    // the OTHER eval input, exactly as the host's hidden-rows bridge does.
    await backend.setEvalHiddenRows!({
      kind: 'set-eval-hidden-rows',
      sheetId: SHEET,
      rows: [1],
    })

    const both = await readRow0(backend)
    // 1-11: filter row gone (South, 20), manual row STILL counted (North, 10).
    expect(both.subtotal9).toBe('40')
    // 101-111: both gone, only the second North (30) survives.
    expect(both.subtotal109).toBe('30')
    // The inequality IS the feature. One merged set could not produce it.
    expect(both.subtotal9).not.toBe(both.subtotal109)

    // Releasing only the manual set leaves the filter set in place — the two
    // are independently addressable, neither push clobbers the other.
    await backend.setEvalHiddenRows!({
      kind: 'set-eval-hidden-rows',
      sheetId: SHEET,
      rows: [],
    })
    const filterOnly = await readRow0(backend)
    expect(filterOnly.subtotal9).toBe('40')
    expect(filterOnly.subtotal109).toBe('40')

    backend.dispose()
  })

  /**
   * The manual-hide defect found by hand in a UI smoke after S4, reproduced
   * exactly as the design records it (§9.3) — no automated test caught it.
   *
   * Repro: E1='Val', E2..E5 = 10/20/30/40, three probes on row 0; manually hide
   * SOURCE row 3 (value 20); then filter E1:E5 unchecking the value 10.
   *
   * What it did BEFORE the flip: the visible values became 20 and 40. The
   * manually hidden row came BACK and a row nobody had hidden (30) vanished,
   * because the manual set stored a bare row number captured in selection
   * coordinates. At capture time display order == source order so it read 3
   * either way; compaction then silently re-pointed that same 3 at a different
   * row for the Grid while the engine kept reading it as source row 3. The
   * giveaway was `SUBTOTAL(109,…)` answering 70 while the values on screen
   * summed to 60 — a function that claims to count only visible rows reporting
   * a number the screen cannot produce.
   *
   * Identity mapping does not fix that bug so much as make it unstateable, so
   * this test asserts the invariant rather than the symptom: a bare row number
   * means the same row to the view and to the engine, whatever the filter does.
   */
  test('a manual hide keeps pointing at the same row when a filter is applied', async () => {
    const backend = createBackend!()
    await backend.ready()

    // Column E (col 4) as in the smoke; probes on row 0 alongside.
    for (const [row, col, input] of [
      [0, 4, 'Val'],
      [1, 4, '10'],
      [2, 4, '20'],
      [3, 4, '30'],
      [4, 4, '40'],
      [0, 6, '=SUBTOTAL(9,E2:E5)'],
      [0, 7, '=SUBTOTAL(109,E2:E5)'],
      [0, 8, '=SUM(E2:E5)'],
    ] as ReadonlyArray<readonly [number, number, string]>) {
      await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: SHEET,
        row,
        col,
        input,
        requestId: requestId++,
      })
    }

    const probes = async (): Promise<{ s9: string; s109: string; sum: string }> => {
      const result = await backend.readRangeProjection({
        kind: 'range',
        sheetId: SHEET,
        reason: 'test',
        requestId: requestId++,
        range: { rowStart: 0, rowEnd: 0, colStart: 6, colEnd: 8 },
      })
      const at = (col: number): string =>
        result.cells.find((cell: DisplayCell) => cell.row === 0 && cell.col === col)
          ?.displayValue ?? ''
      return { s9: at(6), s109: at(7), sum: at(8) }
    }

    expect(await probes()).toEqual({ s9: '100', s109: '100', sum: '100' })

    // Step 2 of the repro: manually hide SOURCE row 2 (0-based) — the value 20.
    const manualHidden = [2]
    await backend.setEvalHiddenRows!({
      kind: 'set-eval-hidden-rows',
      sheetId: SHEET,
      rows: manualHidden,
    })
    expect(await probes()).toEqual({ s9: '100', s109: '80', sum: '100' })

    // Step 3: filter column E to drop the value 10 (source row 1).
    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 4, min: 20 }],
      requestId: requestId++,
    })
    expect(ack.hiddenRowIndices).toEqual([1])

    // The acceptance numbers from the design, all three at once.
    const after = await probes()
    expect(after).toEqual({ s9: '90', s109: '70', sum: '100' })

    // And the row identity claim itself. The projection withholds only the
    // FILTER-hidden row; the Grid additionally withholds the manual one, so
    // the union is what the user sees.
    const window = await backend.readRangeProjection({
      kind: 'range',
      sheetId: SHEET,
      reason: 'test',
      requestId: requestId++,
      range: { rowStart: 0, rowEnd: 4, colStart: 4, colEnd: 4 },
    })
    expect(window.cells.some((cell: DisplayCell) => cell.row === 1)).toBe(false)
    const visible = window.cells
      .filter((cell: DisplayCell) => !manualHidden.includes(cell.row) && cell.row > 0)
      .sort((left: DisplayCell, right: DisplayCell) => left.row - right.row)
    // Rows 3 and 4 (0-based) survive => header rows 1, 4, 5 on screen, and the
    // values are 30 and 40. Before the flip this read 20 and 40.
    expect(visible.map((cell: DisplayCell) => [cell.row, cell.displayValue])).toEqual([
      [3, '30'],
      [4, '40'],
    ])

    // The self-contradiction that exposed the defect, asserted as an identity:
    // SUBTOTAL(109) must equal the sum of what is actually on screen.
    const onScreenSum = visible.reduce(
      (total: number, cell: DisplayCell) => total + Number(cell.displayValue),
      0,
    )
    expect(onScreenSum).toBe(70)
    expect(Number(after.s109)).toBe(onScreenSum)

    backend.dispose()
  })

  /**
   * #27 S5a — inserting a row while a filter is ACTIVE.
   *
   * Continues the repro above with its fourth step: right-click row 1 → Insert
   * Row. Everything below moves down one, and BOTH hidden sets have to move
   * with it. The manual set already did (UI core remaps it off the
   * `structuralShift` ACK and the host bridge re-pushes it); the filter set did
   * not, in any of its three copies — UI core's canonical set, the adapter's
   * projection snapshot, and the engine's `eval_filter_hidden_rows`.
   *
   * DIFFERENTIAL, not tautological. Every post-insert number below is one the
   * unshifted path cannot produce, and the pre-insert values are pinned first:
   *
   *   fixed    SUBTOTAL(9) = 90   SUBTOTAL(109) = 70   projection hides row 2
   *   unfixed  SUBTOTAL(9) = 100  SUBTOTAL(109) = 80   projection hides row 1
   *
   * The unfixed column is exactly the reported symptom: stale index 1 points at
   * the header row after the shift, so 'Val' is swallowed and the filtered-out
   * 10 comes back.
   */
  test('S5a: an insert above an active filter moves the filter set, not just the manual one', async () => {
    const backend = createBackend!()
    await backend.ready()
    const store = createStore()

    for (const [row, col, input] of [
      [0, 4, 'Val'],
      [1, 4, '10'],
      [2, 4, '20'],
      [3, 4, '30'],
      [4, 4, '40'],
      [0, 6, '=SUBTOTAL(9,E2:E5)'],
      [0, 7, '=SUBTOTAL(109,E2:E5)'],
      [0, 8, '=SUM(E2:E5)'],
    ] as ReadonlyArray<readonly [number, number, string]>) {
      await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: SHEET,
        row,
        col,
        input,
        requestId: requestId++,
      })
    }

    const probes = async (probeRow: number): Promise<{ s9: string; s109: string; sum: string }> => {
      const result = await backend.readRangeProjection({
        kind: 'range',
        sheetId: SHEET,
        reason: 'test',
        requestId: requestId++,
        range: { rowStart: probeRow, rowEnd: probeRow, colStart: 6, colEnd: 8 },
      })
      const at = (col: number): string =>
        result.cells.find((cell: DisplayCell) => cell.row === probeRow && cell.col === col)
          ?.displayValue ?? ''
      return { s9: at(6), s109: at(7), sum: at(8) }
    }

    /** Stand-in for the provider's `eval-hidden-rows-bridge`: mirror manual → engine. */
    const pushManualToEngine = async () => {
      await backend.setEvalHiddenRows!({
        kind: 'set-eval-hidden-rows',
        sheetId: SHEET,
        rows: getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET),
      })
    }
    const filterRows = () =>
      getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), SHEET)
    /** Source rows the projection actually emits in column E. */
    const projectedColumnE = async (rowEnd: number) => {
      const window = await backend.readRangeProjection({
        kind: 'range',
        sheetId: SHEET,
        reason: 'test',
        requestId: requestId++,
        range: { rowStart: 0, rowEnd, colStart: 4, colEnd: 4 },
      })
      return window.cells
        .filter((cell: DisplayCell) => cell.col === 4)
        .sort((left: DisplayCell, right: DisplayCell) => left.row - right.row)
        .map((cell: DisplayCell) => [cell.row, cell.displayValue] as const)
    }

    // Steps 2-3 of the repro: manually hide source row 2 (the 20), then filter
    // the 10 away. Both sets are driven through UI core, which is canonical.
    store.setter(hideRowsAtom, { sheetId: SHEET, indices: [2] })
    await pushManualToEngine()
    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 4, min: 20 }],
      requestId: requestId++,
    })
    expect(ack.hiddenRowIndices).toEqual([1])
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: SHEET, rows: ack.hiddenRowIndices! })

    // Baseline. Rows 1, 4, 5 on screen (1-based); 30 and 40 visible.
    expect(await probes(0)).toEqual({ s9: '90', s109: '70', sum: '100' })
    expect(await projectedColumnE(4)).toEqual([
      [0, 'Val'],
      [2, '20'],
      [3, '30'],
      [4, '40'],
    ])

    // Step 4: insert one row at the very top, through the real dispatcher.
    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createInsertRowsOperation({ sheetId: SHEET, rowIndex: 0, count: 1 }),
        source: backend,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    await pushManualToEngine()

    // Both UI-core sets moved by exactly one, in lockstep.
    expect(filterRows()).toEqual([2])
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([3])

    // The engine copy moved with them: 90 / 70 are unreachable from a set
    // still holding index 1 (that answers 100 / 80).
    expect(await probes(1)).toEqual({ s9: '90', s109: '70', sum: '100' })

    // The adapter's projection snapshot moved too: the header survives at its
    // new row 1 and the filtered-out 10 stays withheld. This is the assertion
    // the reported symptom fails — unfixed, row 1 is missing and row 2 is back.
    expect(await projectedColumnE(5)).toEqual([
      [1, 'Val'],
      [3, '20'],
      [4, '30'],
      [5, '40'],
    ])

    // Undo restores every copy from the recorded images — a shift inverse
    // would not be enough, which is why they are recorded at all.
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: backend,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    await pushManualToEngine()

    expect(filterRows()).toEqual([1])
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([2])
    expect(await probes(0)).toEqual({ s9: '90', s109: '70', sum: '100' })
    expect(await projectedColumnE(4)).toEqual([
      [0, 'Val'],
      [2, '20'],
      [3, '30'],
      [4, '40'],
    ])

    backend.dispose()
  })

  test('a re-applied filter replaces the previous set rather than accumulating', async () => {
    const backend = createBackend!()
    await backend.ready()
    await seed(backend)

    await filterToNorth(backend)
    expect((await readRow0(backend)).subtotal9).toBe('40')

    // Swap the rule to keep South only: rows 1 and 3 (10 + 30) are now hidden
    // and row 2 (20) is back. Under merge-instead-of-replace semantics every
    // data row would be hidden and this would read 0.
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'equals', colIndex: 0, value: 'South' }],
      requestId: requestId++,
    })
    const south = await readRow0(backend)
    expect(south.subtotal9).toBe('20')
    expect(south.subtotal109).toBe('20')
    expect(south.sum).toBe('60')

    backend.dispose()
  })
})
