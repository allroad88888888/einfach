/**
 * @jest-environment node
 *
 * Filter predicate + hidden-row withholding — STATIC ⇄ WASM golden parity
 * (design-engine-hidden-rows.md §5.2, slice E6). The static reference backend
 * and the real Rust engine must hide the SAME source rows for the SAME filter
 * rules, cell for cell — this is what locks the two engines' filter predicates
 * together and rules out a silent, rule-shape-dependent drift between the TS
 * `filter-predicate.ts` and the Rust port E3 landed.
 *
 * Method (the sibling of vnext-sort-static-wasm-parity.test.ts): seed ONE mixed
 * dataset with a unique MARKER column into a WASM worker AND a static backend,
 * apply the identical filter rule set to both, then read the marker column back
 * through each backend's `readRangeProjection`. A filter-hidden row is WITHHELD
 * (no cell reaches the projection), so the set of markers that survive IS the
 * set of rows the predicate kept — and identical survivors ⇒ the two engines
 * judged every row identically. `SUBTOTAL(9/109)` over the data column is read
 * alongside so the SAME derived set is proven to feed evaluation, not just
 * rendering.
 *
 * The corpus deliberately covers the cases §5.2 names: all four rule kinds,
 * `caseSensitive` on/off for `equals`/`contains`, `range` against a non-numeric
 * cell (→ excluded) and a blank cell (`numericValue('')` is 0, not null), the
 * `list` EXACT-string match that does NOT case-fold (an intentional divergence
 * from `equals`), rule combination (AND), and the summary-row pin
 * (`isFilterSortSummaryRow`). Every seeded value renders identically on both
 * engines (plain integers / plain text), so a mismatch here is a PREDICATE
 * divergence, never a value-getter (`formatEvalResult` vs `value_to_display`)
 * one — that fork is E3's concern and is measured there.
 *
 * WASM harness mirrors vnext-table-totals-static-wasm-parity.test.ts: wasm-pkg
 * mocked onto itself with the binary pre-loaded via `initSync`, a fake `self`
 * installed before the runtime imports, an in-process worker bridging client ⇄
 * runtime.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type { ColumnFilterRule, DisplayCell } from '@einfach/spreadsheet-ui-core'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter/static-backend'

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
const MARKER_COL = 2

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

let createWasmBackend: (() => WorkerWorkbookSpreadsheetBackend) | undefined

beforeAll(async () => {
  (globalThis as Record<string, unknown>).self = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: string, listener: Listener) {
      toWorker.push(listener)
    },
  }
  await import('../src-vnext/adapter/worker-runtime')
  const adapter = await import('../src-vnext/adapter')
  createWasmBackend = () =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => inProcessWorker,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })
})

// === Shared structural type both backends are driven through ==================

interface FilterBackend {
  setCellInput(request: {
    kind: 'set-cell-input'
    sheetId: string
    row: number
    col: number
    input: string
    requestId?: number
  }): Promise<unknown>
  readRangeProjection(request: {
    kind: 'range'
    sheetId: string
    reason: string
    requestId: number
    range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }
  }): Promise<{ cells: DisplayCell[] }>
  setFilterSort?: (request: {
    kind: 'set-filter-sort'
    sheetId: string
    rules: readonly ColumnFilterRule[]
    requestId?: number
  }) => Promise<unknown>
}

let requestId = 1

async function seedCells(
  backend: FilterBackend,
  cells: ReadonlyArray<readonly [number, number, string]>,
): Promise<void> {
  for (const [row, col, input] of cells) {
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

async function applyFilter(backend: FilterBackend, rules: readonly ColumnFilterRule[]): Promise<void> {
  await backend.setFilterSort!({
    kind: 'set-filter-sort',
    sheetId: SHEET,
    rules,
    requestId: requestId++,
  })
}

/** Rows >= 1 whose marker cell survived the filter, as stable `row:marker` keys. */
async function readSurvivors(backend: FilterBackend, maxRow: number): Promise<string> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    reason: 'test',
    requestId: requestId++,
    range: { rowStart: 0, rowEnd: maxRow, colStart: 0, colEnd: 5 },
  })
  return result.cells
    .filter((cell) => cell.col === MARKER_COL && cell.row >= 1)
    .map((cell) => `${cell.row}:${cell.displayValue}`)
    .sort()
    .join(',')
}

/** A `SUBTOTAL` cell in the header row (always visible) that reads the data column. */
async function readSubtotal(backend: FilterBackend, col: number): Promise<string> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    reason: 'test',
    requestId: requestId++,
    range: { rowStart: 0, rowEnd: 0, colStart: col, colEnd: col },
  })
  return result.cells.find((cell) => cell.row === 0 && cell.col === col)?.displayValue ?? ''
}

interface Observation {
  readonly step: string
  readonly value: string
}

// === The shared dataset ======================================================
//
//   A (col 0)       B (col 1)   C (col 2, marker)
//   Region          Score       Marker            ← header (row 0, always kept)
//   North           120         m1
//   South           80          m2
//   north           200         m3   ← lowercase, distinguishes equals vs list
//   North           abc         m4   ← non-numeric B, a range rule excludes it
//   (blank)         (blank)     m5   ← blank B is numericValue 0, not null
//   NORTH           50          m6   ← uppercase
//   West            160         m7
//
// Two SUBTOTAL probes sit at E1 / F1 (row 0, always visible) so the derived
// hidden set is observed feeding evaluation, not only rendering.

const SEED: ReadonlyArray<readonly [number, number, string]> = [
  [0, 0, 'Region'],
  [0, 1, 'Score'],
  [0, 2, 'Marker'],
  [0, 4, '=SUBTOTAL(9,B2:B8)'],
  [0, 5, '=SUBTOTAL(109,B2:B8)'],
  [1, 0, 'North'],
  [1, 1, '120'],
  [1, 2, 'm1'],
  [2, 0, 'South'],
  [2, 1, '80'],
  [2, 2, 'm2'],
  [3, 0, 'north'],
  [3, 1, '200'],
  [3, 2, 'm3'],
  [4, 0, 'North'],
  [4, 1, 'abc'],
  [4, 2, 'm4'],
  [5, 2, 'm5'],
  [6, 0, 'NORTH'],
  [6, 1, '50'],
  [6, 2, 'm6'],
  [7, 0, 'West'],
  [7, 1, '160'],
  [7, 2, 'm7'],
]

const MAX_ROW = 7

/** Named rule sets. Each is applied to a freshly seeded sheet phase and diffed. */
const PHASES: ReadonlyArray<readonly [string, readonly ColumnFilterRule[]]> = [
  ['baseline', []],
  ['equals north (ci)', [{ kind: 'equals', colIndex: 0, value: 'north' }]],
  ['equals north (cs)', [{ kind: 'equals', colIndex: 0, value: 'north', caseSensitive: true }]],
  ['contains or (ci)', [{ kind: 'contains', colIndex: 0, value: 'or' }]],
  ['contains OR (cs)', [{ kind: 'contains', colIndex: 0, value: 'OR', caseSensitive: true }]],
  ['list [North]', [{ kind: 'list', colIndex: 0, values: ['North'] }]],
  ['list [North,NORTH]', [{ kind: 'list', colIndex: 0, values: ['North', 'NORTH'] }]],
  ['range B >=100', [{ kind: 'range', colIndex: 1, min: 100 }]],
  ['range B 0..100', [{ kind: 'range', colIndex: 1, min: 0, max: 100 }]],
  [
    'AND north & B>=100',
    [
      { kind: 'equals', colIndex: 0, value: 'north' },
      { kind: 'range', colIndex: 1, min: 100 },
    ],
  ],
  ['cleared', []],
]

async function runScript(backend: FilterBackend): Promise<Observation[]> {
  const out: Observation[] = []
  const record = (step: string, value: string): void => {
    out.push({ step, value })
  }

  await seedCells(backend, SEED)
  record('port.setFilterSort', String(typeof backend.setFilterSort === 'function'))

  for (const [name, rules] of PHASES) {
    await applyFilter(backend, rules)
    record(`${name} survivors`, await readSurvivors(backend, MAX_ROW))
    record(`${name} SUBTOTAL(9)`, await readSubtotal(backend, 4))
    record(`${name} SUBTOTAL(109)`, await readSubtotal(backend, 5))
  }

  return out
}

// === Summary-row pin =========================================================
//
//   A            C (marker)
//   Region       Marker          ← header (row 0)
//   North        m1
//   South        m2
//   Total        sum             ← summary row (col 0 == 'Total', row 3 > 1)
//
// `isFilterSortSummaryRow` pins the last row visible regardless of the rules, a
// product heuristic E3 ported into Rust. A filter that hides every DATA row must
// still leave the header and the Total row on BOTH engines.

const SUMMARY_SEED: ReadonlyArray<readonly [number, number, string]> = [
  [0, 0, 'Region'],
  [0, 2, 'Marker'],
  [1, 0, 'North'],
  [1, 2, 'm1'],
  [2, 0, 'South'],
  [2, 2, 'm2'],
  [3, 0, 'Total'],
  [3, 2, 'sum'],
]

async function runSummaryScript(backend: FilterBackend): Promise<string> {
  await seedCells(backend, SUMMARY_SEED)
  // `= 'Nope'` matches no data row, so only the header and the pinned Total
  // survive if the summary heuristic fires on both engines.
  await applyFilter(backend, [{ kind: 'equals', colIndex: 0, value: 'Nope' }])
  return readSurvivors(backend, 3)
}

describe('static ⇄ WASM filter predicate + withholding parity', () => {
  test('both engines hide the identical rows for every rule shape', async () => {
    const wasm = createWasmBackend!()
    await wasm.ready()
    const staticBackend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })

    const wasmObservations = await runScript(wasm as unknown as FilterBackend)
    const staticObservations = await runScript(staticBackend as unknown as FilterBackend)
    wasm.dispose()

    // A per-step diff so a mismatch names the offending rule rather than dumping
    // two opaque arrays. If a value-getter drift ever appears it lands HERE, on a
    // SUBTOTAL step, and names the exact number each engine produced.
    const mismatches = wasmObservations
      .map((observation, index) => ({
        step: observation.step,
        wasm: observation.value,
        static: staticObservations[index]?.value,
      }))
      .filter((row) => row.wasm !== row.static)
    expect(mismatches).toEqual([])

    // Anti-vacuity: pin the survivors that carry each rule kind, so a future
    // "both engines hide nothing" (or "hide everything") regression cannot pass.
    const value = (step: string): string | undefined =>
      wasmObservations.find((o) => o.step === step)?.value

    expect(value('port.setFilterSort')).toBe('true')
    expect(value('baseline survivors')).toBe('1:m1,2:m2,3:m3,4:m4,5:m5,6:m6,7:m7')
    expect(value('baseline SUBTOTAL(9)')).toBe('610') // 120+80+200+50+160
    // equals folds case by default; the same rule with caseSensitive keeps only
    // the exact-case row — the two must differ or case-folding has regressed.
    expect(value('equals north (ci) survivors')).toBe('1:m1,3:m3,4:m4,6:m6')
    expect(value('equals north (cs) survivors')).toBe('3:m3')
    // contains honours caseSensitive on the same axis.
    expect(value('contains or (ci) survivors')).toBe('1:m1,3:m3,4:m4,6:m6')
    expect(value('contains OR (cs) survivors')).toBe('6:m6')
    // `list` compares EXACT strings and does NOT fold case (the deliberate
    // divergence from `equals`): only the two exact-'North' rows, never 'north'
    // or 'NORTH'.
    expect(value('list [North] survivors')).toBe('1:m1,4:m4')
    expect(value('list [North,NORTH] survivors')).toBe('1:m1,4:m4,6:m6')
    // range excludes a non-numeric cell (m4 = 'abc') and treats a blank as 0
    // (m5 inside 0..100, outside >=100).
    expect(value('range B >=100 survivors')).toBe('1:m1,3:m3,7:m7')
    expect(value('range B 0..100 survivors')).toBe('2:m2,5:m5,6:m6')
    // AND intersects both predicates per row.
    expect(value('AND north & B>=100 survivors')).toBe('1:m1,3:m3')
    // Clearing restores every row and the full SUBTOTAL.
    expect(value('cleared survivors')).toBe('1:m1,2:m2,3:m3,4:m4,5:m5,6:m6,7:m7')
    expect(value('cleared SUBTOTAL(9)')).toBe('610')

    // The derived set feeds evaluation identically: SUBTOTAL(9) and (109) both
    // drop the filter-hidden rows on both engines. equals-north keeps 120+200+50.
    expect(value('equals north (ci) SUBTOTAL(9)')).toBe('370')
    expect(value('equals north (ci) SUBTOTAL(109)')).toBe('370')
  })

  test('both engines pin the summary row visible under a match-nothing filter', async () => {
    const wasm = createWasmBackend!()
    await wasm.ready()
    const staticBackend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })

    const wasmSurvivors = await runSummaryScript(wasm as unknown as FilterBackend)
    const staticSurvivors = await runSummaryScript(staticBackend as unknown as FilterBackend)
    wasm.dispose()

    expect(staticSurvivors).toBe(wasmSurvivors)
    // Every data row is hidden; only the pinned Total row (row 3) survives.
    expect(wasmSurvivors).toBe('3:sum')
  })
})
