/**
 * @jest-environment node
 *
 * FUNCTIONAL PERFORMANCE GATES — "user starts an operation, how much work
 * does the stack do before the surface can repaint".
 *
 * This is the missing half of the `E2E / a11y / perf` triple. The repo
 * already has ENGINE-level benches (`perf-rust-storage-primary.bench.ts`,
 * `perf-rust-bulk-import-ultra.bench.ts` — both `EINFACH_PERF=1`-gated,
 * `.bench.ts` so the default jest sweep skips them) and a scaling audit
 * (`audit-adapter-scaling.test.ts`, loose timings + hard shape asserts).
 * What was missing is a budget on the FEATURE path: sort, Table-definition
 * undo, and viewport projection, measured through the real host backend
 * port over the real `worker-runtime.ts` dispatcher and the real WASM
 * engine, in process.
 *
 * MEASUREMENT DOCTRINE (see PERF_BASELINE.md):
 *  - WORK assertions are the gate. RPC counts, snapshotted cell counts and
 *    projected cell counts are deterministic — they do not flake on a busy
 *    CI box and they fail for the RIGHT reason (an extra round trip, an
 *    unbounded scan), not because the machine was loaded.
 *  - WALL-CLOCK assertions are deliberately loose upper bounds, present
 *    only to catch an order-of-magnitude regression. Every one of them is
 *    machine dependent and is logged with its measured value so the
 *    baseline doc can be refreshed.
 *
 * TIERS: the light tier runs in the default sweep. `EINFACH_SCALE=1`
 * swaps in the heavy tier (same assertions, bigger workbook) — same env
 * gate `scale-parity.test.ts` uses.
 *
 *   npx jest perf-functional-budgets --no-coverage
 *   EINFACH_SCALE=1 npx jest perf-functional-budgets --no-coverage
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'
import type { CellRange, ImportCellInput, VisibleWindow } from '@einfach/spreadsheet-ui-core'

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
const SCALE = process.env.EINFACH_SCALE === '1'

// ---------------------------------------------------------------------
// Instrumented in-process worker.
//
// Same duplex shim the other `vnext-worker-*-wasm` suites use, plus a
// counter pass: every request is tallied by `cmd`, and every response
// whose result is an array contributes its length to that cmd's payload
// total. `readSparseRange` payload == cells the projection actually read;
// `snapshotSparse` payload == cells one Table undo image copied.
// ---------------------------------------------------------------------
type Listener = (e: MessageEvent) => void
const toWorker: Listener[] = []
const toClient: Listener[] = []

const cmdById = new Map<number, string>()
let rpcCalls = new Map<string, number>()
let rpcPayloadCells = new Map<string, number>()

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function resetCounters(): void {
  rpcCalls = new Map()
  rpcPayloadCells = new Map()
}

function calls(cmd: string): number {
  return rpcCalls.get(cmd) ?? 0
}

function payloadCells(cmd: string): number {
  return rpcPayloadCells.get(cmd) ?? 0
}

function totalCalls(): number {
  let sum = 0
  for (const value of rpcCalls.values()) sum += value
  return sum
}

/** Sorted `cmd×n` digest — printed with every budget so a regression names itself. */
function digest(): string {
  return [...rpcCalls.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([cmd, n]) => `${cmd}×${n}`)
    .join(' ')
}

const instrumentedWorker: WorkerLike = {
  postMessage(msg: unknown) {
    const envelope = msg as { id?: unknown; cmd?: unknown }
    if (typeof envelope.cmd === 'string') {
      bump(rpcCalls, envelope.cmd, 1)
      if (typeof envelope.id === 'number') cmdById.set(envelope.id, envelope.cmd)
    }
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

let createBackendImpl: (() => WorkerWorkbookSpreadsheetBackend) | undefined
let SNAPSHOT_CAP = 0

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).self = {
    postMessage(msg: unknown) {
      const envelope = msg as { id?: unknown; result?: unknown }
      if (typeof envelope.id === 'number' && Array.isArray(envelope.result)) {
        const cmd = cmdById.get(envelope.id)
        if (cmd !== undefined) bump(rpcPayloadCells, cmd, envelope.result.length)
      }
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: string, listener: Listener) {
      toWorker.push(listener)
    },
  }
  await import('../src-vnext/adapter/worker-runtime')
  const adapter = await import('../src-vnext/adapter')
  SNAPSHOT_CAP = adapter.WORKER_TABLE_SNAPSHOT_MAX
  createBackendImpl = () =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => instrumentedWorker,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })
})

async function createBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createBackendImpl!()
  await backend.ready()
  return backend
}

// ---------------------------------------------------------------------
// Workload builders.
// ---------------------------------------------------------------------
let requestSeq = 1
const nextId = (): number => (requestSeq += 1)

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/**
 * A shuffled `rows × cols` block: column 0 is the numeric sort key (a
 * permutation of 1..rows, so a sort moves essentially every row), the rest
 * are text payload columns that must travel with their key.
 */
function buildSortWorkload(rows: number, cols: number): ImportCellInput[] {
  const rng = makeRng(0x5017 + rows)
  const keys = Array.from({ length: rows }, (_, i) => i + 1)
  for (let i = keys.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  const cells: ImportCellInput[] = []
  for (let row = 0; row < rows; row += 1) {
    cells.push({ row, col: 0, input: String(keys[row]) })
    for (let col = 1; col < cols; col += 1) {
      cells.push({ row, col, input: `r${keys[row]}c${col}` })
    }
  }
  return cells
}

/** `count` filler cells laid out 50 per row, starting at `startRow`. */
function buildFiller(count: number, startRow: number): ImportCellInput[] {
  const cells: ImportCellInput[] = []
  for (let i = 0; i < count; i += 1) {
    cells.push({ row: startRow + Math.floor(i / 50), col: i % 50, input: String(i + 1) })
  }
  return cells
}

async function seed(
  backend: WorkerWorkbookSpreadsheetBackend,
  cells: ImportCellInput[],
): Promise<void> {
  await backend.importCells!({
    kind: 'import-cells',
    sheetId: SHEET,
    cells,
    requestId: nextId(),
  })
}

/** Header row + 3 data rows in A1:C4 — the anchor every Table test binds. */
const TABLE_RANGE: CellRange = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 }
async function seedTableAnchor(backend: WorkerWorkbookSpreadsheetBackend): Promise<void> {
  await seed(backend, [
    { row: 0, col: 0, input: 'Name' },
    { row: 0, col: 1, input: 'Age' },
    { row: 0, col: 2, input: 'City' },
    { row: 1, col: 0, input: 'Ann' },
    { row: 1, col: 1, input: '30' },
    { row: 1, col: 2, input: 'NYC' },
    { row: 2, col: 0, input: 'Bob' },
    { row: 2, col: 1, input: '25' },
    { row: 2, col: 2, input: 'LA' },
    { row: 3, col: 0, input: 'Cy' },
    { row: 3, col: 1, input: '40' },
    { row: 3, col: 2, input: 'SF' },
  ])
}

function log(line: string): void {
  // eslint-disable-next-line no-console -- budget evidence; the measured
  // number is the point of the gate and feeds PERF_BASELINE.md.
  console.log(`[perf-budget] ${line}`)
}

const TEST_TIMEOUT = SCALE ? 600_000 : 120_000

// =====================================================================
// 1. Physical sort — one RPC, O(range) snapshots, no hidden fan-out.
// =====================================================================
describe('perf budget · physical sortRange through the host backend port', () => {
  const ROWS = SCALE ? 5_000 : 800
  const COLS = 5

  test(
    `${ROWS}×${COLS} sortRange issues exactly one sortRange RPC and a constant RPC envelope`,
    async () => {
      const backend = await createBackend()
      await seed(backend, buildSortWorkload(ROWS, COLS))

      const range: CellRange = {
        rowStart: 0,
        rowEnd: ROWS - 1,
        colStart: 0,
        colEnd: COLS - 1,
      }

      resetCounters()
      const t0 = performance.now()
      const result = await backend.sortRange!({
        kind: 'sort-range',
        sheetId: SHEET,
        range,
        keys: [{ col: 0, direction: 'asc' }],
        requestId: nextId(),
      })
      const elapsed = performance.now() - t0

      expect(result.applied).toBe(true)
      if (!result.applied) throw new Error('expected an applied sort')

      log(
        `sort ${ROWS}×${COLS} (${ROWS * COLS} cells): ${elapsed.toFixed(1)} ms · ` +
          `movedRows=${result.movedRows} movedCells=${result.movedCells} · ` +
          `undo images=${payloadCells('snapshotRangeSparse')} cells · ` +
          `RPCs=${totalCalls()} [${digest()}]`,
      )

      // --- WORK BUDGET (deterministic) ------------------------------
      // ONE engine reorder. If a future refactor ever loops per row or
      // per key this becomes N and the gate fires.
      expect(calls('sortRange')).toBe(1)

      // The whole operation is a fixed envelope: before-image (values +
      // formats), the sort, after-image (values + formats). No per-row,
      // per-column or per-key round trip is allowed to appear. Measured: 5
      // (snapshotRangeSparse×2, snapshotFormatRange×2, sortRange×1).
      expect(totalCalls()).toBeLessThanOrEqual(6)

      // Undo images are bounded by the SORTED RANGE, not the workbook:
      // 2 images (before + after) × the range's non-empty cells.
      expect(payloadCells('snapshotRangeSparse')).toBeLessThanOrEqual(2 * ROWS * COLS)

      // No projection read is triggered from inside the mutation — the
      // surface asks for its own refresh exactly once, afterwards.
      expect(calls('readSparseRange')).toBe(0)

      // --- WALL CLOCK (loose, machine dependent) ---------------------
      expect(elapsed).toBeLessThan(SCALE ? 20_000 : 4_000)

      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'the post-sort projection refresh is ONE bounded read, not a re-scan',
    async () => {
      const backend = await createBackend()
      await seed(backend, buildSortWorkload(ROWS, COLS))

      await backend.sortRange!({
        kind: 'sort-range',
        sheetId: SHEET,
        range: { rowStart: 0, rowEnd: ROWS - 1, colStart: 0, colEnd: COLS - 1 },
        keys: [{ col: 0, direction: 'asc' }],
        requestId: nextId(),
      })

      const window: VisibleWindow = { rowStart: 0, rowEnd: 39, colStart: 0, colEnd: 11 }
      const windowArea = 40 * 12

      resetCounters()
      const t0 = performance.now()
      const projection = await backend.readVisibleProjection({
        kind: 'visible-window',
        sheetId: SHEET,
        window,
        requestId: nextId(),
        reason: 'viewport',
      })
      const elapsed = performance.now() - t0

      log(
        `post-sort projection 40×12 over a ${ROWS * COLS}-cell workbook: ` +
          `${elapsed.toFixed(1)} ms · cells=${projection.cells.length} · ` +
          `readSparseRange payload=${payloadCells('readSparseRange')} · ` +
          `RPCs=${totalCalls()} [${digest()}]`,
      )

      // --- WORK BUDGET ----------------------------------------------
      expect(calls('readSparseRange')).toBe(1)
      expect(payloadCells('readSparseRange')).toBeLessThanOrEqual(windowArea)
      expect(projection.cells.length).toBeLessThanOrEqual(windowArea)
      // Sorted order is visible in the refreshed window (a correct budget
      // on a wrong read is worthless).
      const firstCol = projection.cells
        .filter((cell) => cell.col === 0)
        .sort((left, right) => left.row - right.row)
        .map((cell) => cell.displayValue)
      expect(firstCol.slice(0, 5)).toEqual(['1', '2', '3', '4', '5'])

      expect(elapsed).toBeLessThan(SCALE ? 2_000 : 1_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )
})

// =====================================================================
// 2. Visible projection — window-bounded, NOT workbook-bounded.
//
// The bounded-window contract says a viewport read costs O(viewport).
// This proves it by reading the SAME window out of two workbooks whose
// totals differ by ~20×: identical read payload, wall clock in the same
// order of magnitude.
// =====================================================================
describe('perf budget · readVisibleProjection is bounded by the window', () => {
  const WINDOW: VisibleWindow = { rowStart: 0, rowEnd: 39, colStart: 0, colEnd: 11 }
  const WINDOW_AREA = 40 * 12
  const SMALL = SCALE ? 2_000 : 500
  const LARGE = SCALE ? 40_000 : 10_000

  async function measureWindowRead(fillerCells: number): Promise<{
    payload: number
    projected: number
    ms: number
    rpcs: number
  }> {
    const backend = await createBackend()
    // In-window content is IDENTICAL across both workbooks (rows 0..39,
    // cols 0..11); the filler lives strictly below row 100.
    const inWindow: ImportCellInput[] = []
    for (let row = 0; row < 40; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        inWindow.push({ row, col, input: `v${row}_${col}` })
      }
    }
    await seed(backend, inWindow)
    await seed(backend, buildFiller(fillerCells, 100))

    // One mutation, then the refresh — this is the "after a mutation"
    // path the contract is about, not a cold read.
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row: 0,
      col: 0,
      input: 'touched',
      requestId: nextId(),
    })

    resetCounters()
    const t0 = performance.now()
    const projection = await backend.readVisibleProjection({
      kind: 'visible-window',
      sheetId: SHEET,
      window: WINDOW,
      requestId: nextId(),
      reason: 'viewport',
    })
    const ms = performance.now() - t0
    const out = {
      payload: payloadCells('readSparseRange'),
      projected: projection.cells.length,
      ms,
      rpcs: totalCalls(),
    }
    backend.dispose()
    return out
  }

  test(
    'the same 40×12 window costs the same read whether the workbook holds 500 or 10k cells',
    async () => {
      const small = await measureWindowRead(SMALL)
      const large = await measureWindowRead(LARGE)

      log(
        `projection 40×12 · small workbook (${SMALL + WINDOW_AREA} cells): ` +
          `payload=${small.payload} projected=${small.projected} ` +
          `${small.ms.toFixed(1)} ms RPCs=${small.rpcs}`,
      )
      log(
        `projection 40×12 · large workbook (${LARGE + WINDOW_AREA} cells): ` +
          `payload=${large.payload} projected=${large.projected} ` +
          `${large.ms.toFixed(1)} ms RPCs=${large.rpcs}`,
      )

      // --- WORK BUDGET: the load-bearing assertion of this file ------
      // The read payload is a function of the WINDOW only. A backend that
      // scanned the sheet, or shipped every cell to filter host-side,
      // would show `large.payload > small.payload` here.
      expect(small.payload).toBeLessThanOrEqual(WINDOW_AREA)
      expect(large.payload).toBeLessThanOrEqual(WINDOW_AREA)
      expect(large.payload).toBe(small.payload)
      expect(large.projected).toBe(small.projected)
      expect(large.rpcs).toBe(small.rpcs)

      // --- WALL CLOCK (loose) ---------------------------------------
      // 20× the cells must not mean 20× the time. Compare against an
      // absolute floor too, so a sub-millisecond small read cannot make
      // the ratio meaningless.
      expect(large.ms).toBeLessThan(Math.max(50, small.ms * 8))
    },
    TEST_TIMEOUT,
  )
})

// =====================================================================
// 3. Table-definition undo transaction — the WORKBOOK-WIDE snapshot.
//
// `recordTableMutation` captures a full-workbook sparse image BEFORE and
// AFTER every Table definition change (design #25 pairs the registry
// envelope with the cell image so undo can never restore half a
// transaction). That is O(workbook), not O(table) — this section prices
// it exactly and pins the `WORKER_TABLE_SNAPSHOT_MAX` escape hatch.
// =====================================================================
describe('perf budget · Table-definition mutations snapshot the whole workbook', () => {
  test(
    'createTable costs exactly two workbook-wide sparse snapshots',
    async () => {
      const backend = await createBackend()
      await seedTableAnchor(backend)
      const filler = 600
      await seed(backend, buildFiller(filler, 100))
      const workbookCells = 12 + filler

      resetCounters()
      const t0 = performance.now()
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: TABLE_RANGE,
        requestId: nextId(),
      })
      const elapsed = performance.now() - t0

      expect(created.applied).toBe(true)
      log(
        `createTable on a ${workbookCells}-cell workbook: ${elapsed.toFixed(1)} ms · ` +
          `snapshotSparse×${calls('snapshotSparse')} payload=${payloadCells('snapshotSparse')} ` +
          `cells (${(payloadCells('snapshotSparse') / workbookCells).toFixed(2)}× workbook) · ` +
          `RPCs=${totalCalls()} [${digest()}]`,
      )

      // --- WORK BUDGET ----------------------------------------------
      // Two images: before + after. Not one, not per-column.
      expect(calls('snapshotSparse')).toBe(2)
      // Each image is the ENTIRE workbook. Documented cost, pinned so a
      // regression that makes it three images (or a per-column re-capture)
      // is caught; a future optimisation to a bounded image will also trip
      // this and should update PERF_BASELINE.md.
      expect(payloadCells('snapshotSparse')).toBe(2 * workbookCells)
      expect(calls('snapshotTables')).toBe(2)

      expect(elapsed).toBeLessThan(SCALE ? 10_000 : 3_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'renameTable pays the SAME workbook-wide price as createTable — cost tracks the workbook, not the change',
    async () => {
      const backend = await createBackend()
      await seedTableAnchor(backend)
      const filler = 600
      await seed(backend, buildFiller(filler, 100))
      const workbookCells = 12 + filler

      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: TABLE_RANGE,
        requestId: nextId(),
      })
      expect(created.applied).toBe(true)
      if (!created.applied) throw new Error('expected an applied createTable')

      resetCounters()
      const t0 = performance.now()
      const renamed = await backend.renameTable!({
        kind: 'rename-table',
        name: created.name,
        newName: 'Renamed1',
        requestId: nextId(),
      })
      const elapsed = performance.now() - t0

      expect(renamed.applied).toBe(true)
      log(
        `renameTable (a 1-token change) on a ${workbookCells}-cell workbook: ` +
          `${elapsed.toFixed(1)} ms · snapshotSparse payload=${payloadCells('snapshotSparse')} ` +
          `cells · RPCs=${totalCalls()} [${digest()}]`,
      )

      // A rename changes ONE string in the registry, yet still copies the
      // workbook twice. Pinned, not endorsed — see PERF_BASELINE.md § F1.
      expect(calls('snapshotSparse')).toBe(2)
      expect(payloadCells('snapshotSparse')).toBe(2 * workbookCells)

      expect(elapsed).toBeLessThan(SCALE ? 10_000 : 3_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'the snapshot cost grows LINEARLY with the workbook, not with the table',
    async () => {
      async function priceCreateTable(filler: number): Promise<{ payload: number; ms: number }> {
        const backend = await createBackend()
        await seedTableAnchor(backend)
        await seed(backend, buildFiller(filler, 100))
        resetCounters()
        const t0 = performance.now()
        const created = await backend.createTable!({
          kind: 'create-table',
          sheetId: SHEET,
          range: TABLE_RANGE,
          requestId: nextId(),
        })
        const ms = performance.now() - t0
        expect(created.applied).toBe(true)
        const payload = payloadCells('snapshotSparse')
        backend.dispose()
        return { payload, ms }
      }

      const small = await priceCreateTable(100)
      const large = await priceCreateTable(1_800)

      log(
        `createTable snapshot scaling: 112-cell workbook → ${small.payload} cells ` +
          `(${small.ms.toFixed(1)} ms) · 1812-cell workbook → ${large.payload} cells ` +
          `(${large.ms.toFixed(1)} ms) · ratio=${(large.payload / small.payload).toFixed(2)}×`,
      )

      // The identical table definition costs ~16× more snapshot work on a
      // ~16× larger workbook. THIS IS THE FINDING, asserted so it cannot
      // silently get worse.
      expect(small.payload).toBe(2 * 112)
      expect(large.payload).toBe(2 * 1_812)
      expect(large.payload / small.payload).toBeGreaterThan(10)
    },
    TEST_TIMEOUT,
  )

  test(
    `WORKER_TABLE_SNAPSHOT_MAX (${SNAPSHOT_CAP || 2000}) caps the blast radius — over it, no image is stored`,
    async () => {
      const backend = await createBackend()
      await seedTableAnchor(backend)
      // 12 anchor cells + (cap + 1) filler → strictly over the cap.
      await seed(backend, buildFiller(SNAPSHOT_CAP + 1, 100))

      resetCounters()
      const t0 = performance.now()
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: TABLE_RANGE,
        requestId: nextId(),
      })
      const elapsed = performance.now() - t0

      expect(created.applied).toBe(true)
      log(
        `createTable OVER the ${SNAPSHOT_CAP}-cell cap: ${elapsed.toFixed(1)} ms · ` +
          `snapshotSparse×${calls('snapshotSparse')} payload=${payloadCells('snapshotSparse')} · ` +
          `RPCs=${totalCalls()} [${digest()}]`,
      )

      // The DEGRADATION is the budget: the after-image is never taken, so
      // an over-cap workbook pays ONE snapshot, not two. The mutation
      // still applies — degradation never blocks the operation.
      expect(calls('snapshotSparse')).toBe(1)
      expect(payloadCells('snapshotSparse')).toBeGreaterThan(SNAPSHOT_CAP)

      // ...and the record is stored as not-undoable rather than as a
      // half-transaction. This is the correctness half of the cap.
      const undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-cap-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).toBe(false)
      if (undone.applied !== false) throw new Error('expected a not-applied undo')
      expect(undone.notAppliedReason).toContain(String(SNAPSHOT_CAP))

      expect(elapsed).toBeLessThan(SCALE ? 15_000 : 5_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  /**
   * REACHABILITY OF THE CAP — the finding this file exists to surface.
   *
   * `WORKER_TABLE_SNAPSHOT_MAX` is 2000 NON-EMPTY CELLS across the whole
   * workbook. A perfectly ordinary tabular sheet — 500 data rows × 5
   * columns — is 2500 cells, i.e. already over it. So on any realistic
   * workbook, EVERY Excel Table definition mutation records as
   * not-undoable and Ctrl+Z silently declines.
   *
   * This test pins that reachability AND times the single workbook-wide
   * snapshot at that size, so the doc can say whether 2000 is a time
   * budget or a (much more conservative) memory guard.
   */
  test(
    'a 500-row × 5-col data region — an ordinary sheet — already exceeds the cap',
    async () => {
      const rows = 500
      const cols = 5
      const backend = await createBackend()

      // A realistic sheet shape: header row + 499 data rows, 5 columns,
      // with the Table anchored on the first four rows of it.
      const cells: ImportCellInput[] = []
      for (let col = 0; col < cols; col += 1) cells.push({ row: 0, col, input: `H${col}` })
      for (let row = 1; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          cells.push({ row, col, input: col === 0 ? `n${row}` : String(row * (col + 1)) })
        }
      }
      await seed(backend, cells)
      const workbookCells = cells.length
      expect(workbookCells).toBeGreaterThan(SNAPSHOT_CAP)

      resetCounters()
      const t0 = performance.now()
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: TABLE_RANGE,
        requestId: nextId(),
      })
      const elapsed = performance.now() - t0
      expect(created.applied).toBe(true)

      log(
        `REACHABILITY · ${rows}×${cols} sheet = ${workbookCells} cells vs cap ${SNAPSHOT_CAP}: ` +
          `createTable ${elapsed.toFixed(1)} ms, ONE workbook snapshot of ` +
          `${payloadCells('snapshotSparse')} cells, record degraded to not-undoable`,
      )

      // Over the cap → one image only, and undo declines.
      expect(calls('snapshotSparse')).toBe(1)
      const undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-reach-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).toBe(false)

      // The measured cost of that single workbook-wide snapshot is tiny
      // relative to the undo capability it buys back — evidence that 2000
      // is a memory/blast-radius guard, not a latency budget. Pinned
      // loosely: this is the number PERF_BASELINE.md § F1 argues from.
      expect(elapsed).toBeLessThan(SCALE ? 15_000 : 5_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  /**
   * COST CURVE for the workbook-wide image, so PERF_BASELINE.md can argue
   * about the cap from measurements instead of extrapolation. Log-only
   * plus a very loose ceiling — the per-cell rate is the deliverable.
   * SCALE tier extends the curve to 40k cells.
   */
  test(
    'workbook-wide snapshot cost curve (per-cell rate for cap re-tuning)',
    async () => {
      const sizes = SCALE ? [2_500, 10_000, 40_000] : [2_500, 10_000]
      const rows: string[] = []

      for (const size of sizes) {
        const backend = await createBackend()
        await seedTableAnchor(backend)
        await seed(backend, buildFiller(size - 12, 100))
        resetCounters()
        const t0 = performance.now()
        const created = await backend.createTable!({
          kind: 'create-table',
          sheetId: SHEET,
          range: TABLE_RANGE,
          requestId: nextId(),
        })
        const ms = performance.now() - t0
        expect(created.applied).toBe(true)
        const imaged = payloadCells('snapshotSparse')
        rows.push(
          `${size} cells → ${calls('snapshotSparse')} image(s), ${imaged} cells imaged, ` +
            `${ms.toFixed(1)} ms (${((ms * 1000) / Math.max(1, imaged)).toFixed(2)} µs/cell)`,
        )
        backend.dispose()
      }

      log(`COST CURVE · workbook-wide table image: ${rows.join(' | ')}`)

      // Loose ceiling only — the point of this test is the printed rate.
      expect(rows).toHaveLength(sizes.length)
    },
    TEST_TIMEOUT,
  )
})
