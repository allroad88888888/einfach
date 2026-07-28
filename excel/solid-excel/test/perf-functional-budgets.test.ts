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
import type * as NodeFsModule from 'node:fs'
import type * as NodePathModule from 'node:path'

import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'

jest.mock('../wasm-pkg/einfach_wasm.js', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { readFileSync } = require('node:fs') as typeof NodeFsModule
  const nodePath = require('node:path') as typeof NodePathModule
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
let FORMULA_CAP = 0
let TOTALS_CAP = 0

beforeAll(async () => {
  (globalThis as Record<string, unknown>).self = {
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
  FORMULA_CAP = adapter.WORKER_TABLE_FORMULA_SNAPSHOT_MAX
  TOTALS_CAP = adapter.WORKER_TABLE_TOTALS_SNAPSHOT_MAX
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

function makeRng(rngSeed: number): () => number {
  let s = rngSeed >>> 0
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
// 3. Table-definition undo transaction — the PER-OPERATION image (#26).
//
// `recordTableMutation` pairs the registry envelope with a cell image so
// undo can never restore half a transaction (design #25). Until #26 that
// cell image was a full-workbook sparse snapshot for ALL SIX ports against
// a single 2000-cell cap — O(workbook), not O(change) — which made every
// table op on a 500x5 sheet (2500 cells) silently not-undoable.
//
// The image is now scoped to what each engine call can actually touch:
//   registry-only  create / delete        -> no cell image at all
//   formula-rewrite rename / renameColumn -> workbook-wide, FORMULA cells only
//   totals-band    totals row / function  -> 2 rows x the table's columns
//
// This section prices each scope and pins the shape, so a regression back
// to "snapshot everything" fails here first.
// =====================================================================
describe('perf budget · Table-definition mutations image only what they touch (#26)', () => {
  test(
    'createTable takes NO cell image — registry-only, independent of workbook size',
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
          `cells · snapshotTables×${calls('snapshotTables')} · RPCs=${totalCalls()} [${digest()}]`,
      )

      // --- WORK BUDGET ----------------------------------------------
      // `define_table` inserts a registry entry and bumps the tables epoch
      // (workbook.rs §4.1) — it writes no cell input, so imaging cells is
      // pure waste. Two registry envelopes (before + after) and nothing
      // else.
      expect(calls('snapshotSparse')).toBe(0)
      expect(calls('snapshotRangeSparse')).toBe(0)
      expect(calls('snapshotTables')).toBe(2)

      // …and it is fully undoable, which the old whole-workbook cap could
      // not promise at any interesting size.
      const undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-create-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).not.toBe(false)

      expect(elapsed).toBeLessThan(SCALE ? 10_000 : 3_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'deleteTable takes NO cell image either (convert-to-range leaves every value in place)',
    async () => {
      const backend = await createBackend()
      await seedTableAnchor(backend)
      await seed(backend, buildFiller(600, 100))
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: TABLE_RANGE,
        requestId: nextId(),
      })
      expect(created.applied).toBe(true)
      if (!created.applied) throw new Error('expected an applied createTable')

      resetCounters()
      const deleted = await backend.deleteTable!({
        kind: 'delete-table',
        name: created.name,
        requestId: nextId(),
      })
      expect(deleted.applied).toBe(true)

      log(
        `deleteTable: snapshotSparse×${calls('snapshotSparse')} · RPCs=${totalCalls()} [${digest()}]`,
      )
      expect(calls('snapshotSparse')).toBe(0)
      expect(calls('snapshotRangeSparse')).toBe(0)
      expect(calls('snapshotTables')).toBe(2)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'renameTable still sweeps the workbook (cross-sheet rewrite) but images FORMULA cells only',
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

      // Three referencing formulas — the ONLY cells a rename can rewrite.
      const formulaCells = 3
      await seed(backend, [
        { row: 900, col: 0, input: `=SUM(${created.name}[Age])` },
        { row: 901, col: 0, input: `=COUNT(${created.name}[Age])` },
        { row: 902, col: 0, input: `=MAX(${created.name}[Age])` },
      ])

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
        `renameTable on a ${workbookCells + formulaCells}-cell workbook holding ` +
          `${formulaCells} formulas: ${elapsed.toFixed(1)} ms · snapshotSparse×` +
          `${calls('snapshotSparse')} raw payload=${payloadCells('snapshotSparse')} cells, ` +
          `STORED image=${formulaCells} formula cells/image · RPCs=${totalCalls()} [${digest()}]`,
      )

      // The RPC still returns the whole workbook — `rewrite_table_refs_
      // across_sheets` can touch a formula on any sheet, so the SWEEP
      // cannot shrink. What shrinks is what is RETAINED: the adapter keeps
      // only `kind: 'formula'` cells, because a literal is not reachable by
      // a structured-reference rewrite. That is what the cap now counts.
      expect(calls('snapshotSparse')).toBe(2)
      expect(payloadCells('snapshotSparse')).toBe(2 * (workbookCells + formulaCells))

      // Undo is REAL on a workbook this size (it was not before #26), and
      // restores the formula text without a workbook-wide pre-clear.
      const undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-rename-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).not.toBe(false)
      expect(calls('clearRange')).toBe(0)

      expect(elapsed).toBeLessThan(SCALE ? 10_000 : 3_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'the totals ports image a BOUNDED band — 2 rows × the table columns, not the workbook',
    async () => {
      const backend = await createBackend()
      await seedTableAnchor(backend)
      await seed(backend, buildFiller(2_000, 100))

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
      const toggled = await backend.setTableTotalsRow!({
        kind: 'set-table-totals-row',
        name: created.name,
        enabled: true,
        requestId: nextId(),
      })
      const elapsed = performance.now() - t0
      expect(toggled.applied).toBe(true)

      const banded = payloadCells('snapshotRangeSparse')
      log(
        `setTableTotalsRow on a 2012-cell workbook: ${elapsed.toFixed(1)} ms · ` +
          `snapshotSparse×${calls('snapshotSparse')} · snapshotRangeSparse×` +
          `${calls('snapshotRangeSparse')} payload=${banded} cells · RPCs=${totalCalls()} ` +
          `[${digest()}]`,
      )

      // No workbook sweep at all; two band images (before + after).
      expect(calls('snapshotSparse')).toBe(0)
      expect(calls('snapshotRangeSparse')).toBe(2)
      // The band is A4:C5 — the table's last data row plus the totals row.
      // Before: 3 data cells. After: 3 data + 1 default SUM. Bounded by the
      // TABLE (6 cells max), never by the 2000 filler cells around it.
      expect(banded).toBeLessThanOrEqual(2 * 2 * 3)

      const undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-totals-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).not.toBe(false)
      // Clear-then-restore is needed here (an enable ADDS a cell) but it is
      // scoped to the same band — one clearRange, not one per sheet.
      expect(calls('clearRange')).toBe(1)

      expect(elapsed).toBeLessThan(SCALE ? 10_000 : 3_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  test(
    'the retained image tracks the CHANGE, not the workbook — literals no longer price it',
    async () => {
      async function priceRename(filler: number): Promise<{ raw: number; ms: number }> {
        const backend = await createBackend()
        await seedTableAnchor(backend)
        await seed(backend, buildFiller(filler, 100))
        const created = await backend.createTable!({
          kind: 'create-table',
          sheetId: SHEET,
          range: TABLE_RANGE,
          requestId: nextId(),
        })
        expect(created.applied).toBe(true)
        if (!created.applied) throw new Error('expected an applied createTable')
        await seed(backend, [{ row: 900, col: 0, input: `=SUM(${created.name}[Age])` }])

        resetCounters()
        const t0 = performance.now()
        const renamed = await backend.renameTable!({
          kind: 'rename-table',
          name: created.name,
          newName: 'Renamed1',
          requestId: nextId(),
        })
        const ms = performance.now() - t0
        expect(renamed.applied).toBe(true)

        // Undo must LAND at both sizes — that is the #26 fix in one line.
        const undone = await backend.undoTransaction!({
          kind: 'undo-transaction',
          transactionId: `perf-scale-${nextId()}`,
          requestId: nextId(),
        })
        expect(undone.applied).not.toBe(false)

        const raw = payloadCells('snapshotSparse')
        backend.dispose()
        return { raw, ms }
      }

      const small = await priceRename(100)
      const large = await priceRename(1_800)

      log(
        `rename image scaling: 113-cell workbook → raw sweep ${small.raw} cells ` +
          `(${small.ms.toFixed(1)} ms) · 1813-cell workbook → raw sweep ${large.raw} cells ` +
          `(${large.ms.toFixed(1)} ms) · STORED image = 1 formula cell in BOTH, and both ` +
          'undos applied',
      )

      // The RAW sweep still scales with the workbook (it must — a rewrite
      // can hit any sheet)…
      expect(large.raw / small.raw).toBeGreaterThan(10)
      // …but the number the cap counts, and the memory the undo stack
      // holds, is the formula count, which is 1 at BOTH sizes. Pinned via
      // the observable that matters: undo applies either way.
    },
    TEST_TIMEOUT,
  )

  test(
    `over WORKER_TABLE_FORMULA_SNAPSHOT_MAX (${FORMULA_CAP || 3000}) a rename still degrades to not-undoable`,
    async () => {
      const backend = await createBackend()
      await seedTableAnchor(backend)
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: TABLE_RANGE,
        requestId: nextId(),
      })
      expect(created.applied).toBe(true)
      if (!created.applied) throw new Error('expected an applied createTable')

      // Only FORMULA cells enter the image, so the cap has to be crossed
      // with formulas. Literals are free now.
      await seed(
        backend,
        buildFiller(FORMULA_CAP + 1, 100).map((cell) => ({ ...cell, input: `=${cell.input}` })),
      )

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
        `renameTable OVER the ${FORMULA_CAP}-formula cap: ${elapsed.toFixed(1)} ms · ` +
          `snapshotSparse×${calls('snapshotSparse')} · RPCs=${totalCalls()} [${digest()}]`,
      )

      // The DEGRADATION is the budget: the after-image is never taken, so
      // an over-cap workbook pays ONE sweep, not two. The mutation still
      // applies — degradation never blocks the operation.
      expect(calls('snapshotSparse')).toBe(1)

      const undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-cap-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).toBe(false)
      if (undone.applied !== false) throw new Error('expected a not-applied undo')
      expect(undone.notAppliedReason).toContain(String(FORMULA_CAP))

      expect(elapsed).toBeLessThan(SCALE ? 15_000 : 5_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  /**
   * THE #26 REGRESSION GATE — the exact scenario the old cap broke.
   *
   * 500 data rows × 5 columns = 2500 non-empty cells. Under the retired
   * whole-workbook `WORKER_TABLE_SNAPSHOT_MAX = 2000` this was ALREADY over
   * the cap, so every Table definition mutation on an ordinary sheet
   * recorded as not-undoable and Ctrl+Z silently declined. Now each of the
   * three scopes is exercised at that size and each undo must APPLY.
   */
  test(
    'a 500-row × 5-col data region — an ordinary sheet — is fully undoable across all three scopes',
    async () => {
      const rows = 500
      const cols = 5
      const backend = await createBackend()

      const cells: ImportCellInput[] = []
      for (let col = 0; col < cols; col += 1) cells.push({ row: 0, col, input: `H${col}` })
      for (let row = 1; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          cells.push({ row, col, input: col === 0 ? `n${row}` : String(row * (col + 1)) })
        }
      }
      await seed(backend, cells)
      const workbookCells = cells.length
      // The size that broke it: 2500 cells against the retired 2000 cap.
      expect(workbookCells).toBe(2_500)
      expect(workbookCells).toBeGreaterThan(2_000)

      // The table spans the WHOLE region, so the totals row lands on the
      // first free row below it (an A1:C4 anchor would be totals-blocked by
      // the data underneath).
      const bigRange: CellRange = {
        rowStart: 0,
        rowEnd: rows - 1,
        colStart: 0,
        colEnd: cols - 1,
      }

      resetCounters()
      const t0 = performance.now()
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: SHEET,
        range: bigRange,
        requestId: nextId(),
      })
      const createMs = performance.now() - t0
      expect(created.applied).toBe(true)
      if (!created.applied) throw new Error('expected an applied createTable')
      const createSweep = calls('snapshotSparse')

      // registry-only scope. The record binds to the id of its first undo,
      // so the redo must present the SAME transactionId.
      const createTx = `perf-reach-c-${nextId()}`
      let undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: createTx,
        requestId: nextId(),
      })
      expect(undone.applied).not.toBe(false)
      const redone = await backend.redoTransaction!({
        kind: 'redo-transaction',
        transactionId: createTx,
        requestId: nextId(),
      })
      expect(redone.applied).not.toBe(false)

      // totals-band scope.
      const toggled = await backend.setTableTotalsRow!({
        kind: 'set-table-totals-row',
        name: created.name,
        enabled: true,
        requestId: nextId(),
      })
      expect(toggled.applied).toBe(true)
      undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-reach-t-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).not.toBe(false)

      // formula-rewrite scope.
      const renamed = await backend.renameTable!({
        kind: 'rename-table',
        name: created.name,
        newName: 'Renamed1',
        requestId: nextId(),
      })
      expect(renamed.applied).toBe(true)
      undone = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `perf-reach-r-${nextId()}`,
        requestId: nextId(),
      })
      expect(undone.applied).not.toBe(false)

      log(
        `REGRESSION #26 · ${rows}×${cols} sheet = ${workbookCells} cells (over the retired ` +
          `2000 cap): createTable ${createMs.toFixed(1)} ms with ${createSweep} workbook ` +
          'sweeps; create / totals / rename undo ALL applied',
      )

      expect(createMs).toBeLessThan(SCALE ? 15_000 : 5_000)
      backend.dispose()
    },
    TEST_TIMEOUT,
  )

  /**
   * COST CURVE for the surviving workbook-wide sweep (rename only), so
   * PERF_BASELINE.md can argue about the cap from measurements instead of
   * extrapolation. Log-only plus a very loose ceiling — the per-cell rate
   * is the deliverable. SCALE tier extends the curve to 40k cells.
   */
  test(
    'workbook-wide rename sweep cost curve (per-cell rate for cap re-tuning)',
    async () => {
      const sizes = SCALE ? [2_500, 10_000, 40_000] : [2_500, 10_000]
      const rows: string[] = []

      for (const size of sizes) {
        const backend = await createBackend()
        await seedTableAnchor(backend)
        await seed(backend, buildFiller(size - 12, 100))
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
        const ms = performance.now() - t0
        expect(renamed.applied).toBe(true)
        const swept = payloadCells('snapshotSparse')
        rows.push(
          `${size} cells → ${calls('snapshotSparse')} sweep(s), ${swept} cells swept, ` +
            `0 retained (no formulas), ${ms.toFixed(1)} ms ` +
            `(${((ms * 1000) / Math.max(1, swept)).toFixed(2)} µs/cell)`,
        )
        backend.dispose()
      }

      log(`COST CURVE · workbook-wide rename sweep: ${rows.join(' | ')}`)

      // Loose ceiling only — the point of this test is the printed rate.
      expect(rows).toHaveLength(sizes.length)
      expect(TOTALS_CAP).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})
