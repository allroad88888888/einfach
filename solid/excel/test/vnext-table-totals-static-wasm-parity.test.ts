/**
 * @jest-environment node
 *
 * Excel Table totals row + structured references — STATIC ⇄ WASM golden
 * parity (design-excel-table.md §5/§7, parity #32 T6). The static reference
 * backend and the real Rust engine must answer the SAME script identically:
 * same geometry after a totals toggle, the same generated `SUBTOTAL` formula
 * TEXT, the same aggregate values, and the same error code for every
 * structured-reference form — including the ones neither engine supports.
 *
 * This is what stops the static host from quietly drifting into a second
 * dialect of structured references. It is the totals-row sibling of
 * vnext-sort-static-wasm-parity.test.ts and uses the same in-process WASM
 * harness (wasm-pkg mocked onto itself with the binary pre-loaded via
 * `initSync`, a fake `self` installed before the runtime imports).
 *
 * Display formatting is deliberately NORMALIZED before comparison: how many
 * decimals a backend prints is a formatting concern owned elsewhere, so a
 * numeric result is compared rounded to 6 decimals. Error codes and text
 * results are compared verbatim — those ARE the semantics under test.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type { DisplayCell, TableTotalsFunction } from '@einfach/spreadsheet-ui-core'
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
  createWasmBackend = () =>
    adapter.createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => inProcessWorker,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })
})

// === The shared script =======================================================
//
// Both backends are driven through this one structural type, so the script
// below is literally the same code path for each engine.

interface TableBackend {
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
  createTable?: (request: {
    kind: 'create-table'
    sheetId: string
    range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }
  }) => Promise<{ applied: boolean }>
  setTableTotalsRow?: (request: {
    kind: 'set-table-totals-row'
    name: string
    enabled: boolean
  }) => Promise<{ applied: boolean; code?: string }>
  setTableTotalFunction?: (request: {
    kind: 'set-table-total-function'
    name: string
    column: string
    func: TableTotalsFunction
  }) => Promise<{ applied: boolean; code?: string }>
  listTables?: (request: { kind: 'list-tables' }) => Promise<{
    tables: Array<{ name: string; range: string; hasTotals: boolean; columns: string[] }>
  }>
}

/** Region | Q1 | Q2 | Calc over three data rows — `Calc` is a spare in-table column. */
const SEED: ReadonlyArray<readonly [number, number, string]> = [
  [0, 0, 'Region'],
  [0, 1, 'Q1'],
  [0, 2, 'Q2'],
  [0, 3, 'Calc'],
  [1, 0, 'North'],
  [1, 1, '120'],
  [1, 2, '180'],
  [2, 0, 'South'],
  [2, 1, '80'],
  [2, 2, '160'],
  [3, 0, 'East'],
  [3, 1, '200'],
  [3, 2, '100'],
]

const TABLE_RANGE = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 3 }

/** F1 — outside the Table entirely. */
const OUTSIDE_PROBE = { row: 0, col: 5 }
/** D2 — inside the Table (the `Calc` column) on the first DATA row. */
const INSIDE_PROBE = { row: 1, col: 3 }

const AGGREGATES: readonly TableTotalsFunction[] = [
  'sum',
  'average',
  'count',
  'countNums',
  'max',
  'min',
  'stdDev',
  'var',
]

/** Forms probed from OUTSIDE the Table (named references + error cases). */
const OUTSIDE_FORMULAS: readonly string[] = [
  '=SUM(Table1[Q1])',
  '=SUM(Table1[[Q1]:[Q2]])',
  '=SUM(Table1[[Q1]])',
  '=COUNT(Table1[Q1])',
  '=SUM(Table1[#Data])',
  '=SUM(Table1[#All])',
  '=SUM(Table1[#Headers])',
  '=SUM(Table1[#Totals])',
  '=SUM(Table1[@Q1])',
  '=SUM([Q1])',
  '=SUM(Table1[Bogus])',
  '=SUM(Nope[Q1])',
  '=SUM(Table1)',
  '=SUBTOTAL(109,Table1[Q1])',
  '=SUBTOTAL(9,Table1[Q1])',
  '=SUBTOTAL(1,Table1[Q1])',
  '=SUBTOTAL(2,Table1[Q1])',
  '=SUBTOTAL(3,Table1[#Data])',
  '=SUBTOTAL(4,Table1[Q1])',
  '=SUBTOTAL(5,Table1[Q1])',
  '=SUBTOTAL(6,Table1[Q1])',
  '=SUBTOTAL(12,Table1[Q1])',
]

/** Forms probed from INSIDE the Table (this-row + table-less resolution). */
const INSIDE_FORMULAS: readonly string[] = [
  '=Table1[@Q1]',
  '=Table1[@Q1]+Table1[@Q2]',
  '=SUM(Table1[#This Row])',
  '=SUM(Table1[@])',
  '=[@Q1]',
  '=[@Q1]*2',
  '=SUM([Q1])',
  '=SUM([Q1])+[@Q2]',
]

async function seed(backend: TableBackend): Promise<void> {
  let requestId = 1
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

let probeRequestId = 5000

async function readCell(
  backend: TableBackend,
  row: number,
  col: number,
): Promise<DisplayCell | undefined> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    reason: 'test',
    requestId: probeRequestId++,
    range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
  })
  return result.cells.find((c) => c.row === row && c.col === col)
}

/**
 * Comparable display: a numeric result is rounded to 6 decimals so the two
 * backends' float printing cannot cause a false mismatch. Errors and text
 * compare verbatim.
 */
function normalizeDisplay(raw: string): string {
  if (raw === '' || raw.startsWith('#')) return raw
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return String(Math.round(n * 1e6) / 1e6)
}

/** Write a formula into a probe cell, read it back, then clear the cell. */
async function probe(
  backend: TableBackend,
  at: { row: number; col: number },
  formula: string,
): Promise<string> {
  await backend.setCellInput({
    kind: 'set-cell-input',
    sheetId: SHEET,
    row: at.row,
    col: at.col,
    input: formula,
    requestId: probeRequestId++,
  })
  const cell = await readCell(backend, at.row, at.col)
  await backend.setCellInput({
    kind: 'set-cell-input',
    sheetId: SHEET,
    row: at.row,
    col: at.col,
    input: '',
    requestId: probeRequestId++,
  })
  return normalizeDisplay(cell?.displayValue ?? '')
}

interface Observation {
  readonly step: string
  readonly value: string
}

/**
 * Run the identical Table script against one backend and return every
 * observable as a flat, order-stable list. Two engines agreeing on this whole
 * list is the parity claim.
 */
async function runScript(backend: TableBackend): Promise<Observation[]> {
  const out: Observation[] = []
  const record = (step: string, value: unknown): void => {
    out.push({ step, value: String(value) })
  }

  await seed(backend)
  const created = await backend.createTable!({
    kind: 'create-table',
    sheetId: SHEET,
    range: TABLE_RANGE,
  })
  record('createTable.applied', created.applied)

  const describeTable = async (step: string): Promise<void> => {
    const listed = await backend.listTables!({ kind: 'list-tables' })
    const table = listed.tables[0]
    record(`${step}.range`, table?.range)
    record(`${step}.hasTotals`, table?.hasTotals)
    record(`${step}.columns`, table?.columns.join('|'))
  }
  await describeTable('afterCreate')

  // Structured references BEFORE a totals row exists — `[#Totals]` must be
  // `#REF!` on both engines at this point.
  for (const formula of OUTSIDE_FORMULAS) {
    record(`preTotals.outside ${formula}`, await probe(backend, OUTSIDE_PROBE, formula))
  }
  for (const formula of INSIDE_FORMULAS) {
    record(`preTotals.inside ${formula}`, await probe(backend, INSIDE_PROBE, formula))
  }

  // Enable the totals row.
  const enabled = await backend.setTableTotalsRow!({
    kind: 'set-table-totals-row',
    name: 'Table1',
    enabled: true,
  })
  record('enableTotals.applied', enabled.applied)
  await describeTable('afterEnable')

  // The seeded default: SUM in the LAST column (`Calc`), formula text included.
  const seededTotal = await readCell(backend, 4, 3)
  record('defaultTotals.formula', seededTotal?.formula ?? '')
  record('defaultTotals.display', normalizeDisplay(seededTotal?.displayValue ?? ''))

  // Every aggregate on Q1 — the generated formula text AND its value.
  for (const func of AGGREGATES) {
    const applied = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func,
    })
    record(`totalFunction.${func}.applied`, applied.applied)
    const cell = await readCell(backend, 4, 1)
    record(`totalFunction.${func}.formula`, cell?.formula ?? '')
    record(`totalFunction.${func}.display`, normalizeDisplay(cell?.displayValue ?? ''))
  }

  // The same structured references again, now that a totals row exists: the
  // `#Data` band must still EXCLUDE it and `#Totals` must resolve.
  for (const formula of OUTSIDE_FORMULAS) {
    record(`postTotals.outside ${formula}`, await probe(backend, OUTSIDE_PROBE, formula))
  }
  for (const formula of INSIDE_FORMULAS) {
    record(`postTotals.inside ${formula}`, await probe(backend, INSIDE_PROBE, formula))
  }

  // A data edit must flow into the totals aggregate.
  await backend.setTableTotalFunction!({
    kind: 'set-table-total-function',
    name: 'Table1',
    column: 'Q1',
    func: 'sum',
  })
  await backend.setCellInput({
    kind: 'set-cell-input',
    sheetId: SHEET,
    row: 1,
    col: 1,
    input: '500',
    requestId: probeRequestId++,
  })
  record('afterEdit.total', normalizeDisplay((await readCell(backend, 4, 1))?.displayValue ?? ''))

  // Clearing an aggregate empties the cell.
  await backend.setTableTotalFunction!({
    kind: 'set-table-total-function',
    name: 'Table1',
    column: 'Q1',
    func: 'none',
  })
  record('afterNone.display', (await readCell(backend, 4, 1))?.displayValue ?? '')

  // Gate parity: rejection codes for the same bad requests.
  const noSuchTable = await backend.setTableTotalsRow!({
    kind: 'set-table-totals-row',
    name: 'Nope',
    enabled: true,
  })
  record('reject.unknownTable', `${noSuchTable.applied}:${noSuchTable.code ?? ''}`)
  const badColumn = await backend.setTableTotalFunction!({
    kind: 'set-table-total-function',
    name: 'Table1',
    column: 'Nope',
    func: 'sum',
  })
  record('reject.unknownColumn', `${badColumn.applied}:${badColumn.code ?? ''}`)
  const badFunc = await backend.setTableTotalFunction!({
    kind: 'set-table-total-function',
    name: 'Table1',
    column: 'Q1',
    func: 'bogus' as TableTotalsFunction,
  })
  record('reject.badFunc', `${badFunc.applied}:${badFunc.code ?? ''}`)

  // Toggle off: cells cleared, range shrunk.
  const disabled = await backend.setTableTotalsRow!({
    kind: 'set-table-totals-row',
    name: 'Table1',
    enabled: false,
  })
  record('disableTotals.applied', disabled.applied)
  await describeTable('afterDisable')
  record('afterDisable.totalsCell', (await readCell(backend, 4, 3))?.displayValue ?? '')
  record(
    'afterDisable.#Totals',
    await probe(backend, OUTSIDE_PROBE, '=SUM(Table1[#Totals])'),
  )

  return out
}

describe('static ⇄ WASM Table totals + structured-reference parity', () => {
  test('both engines answer the identical script identically', async () => {
    const wasm = createWasmBackend!()
    await wasm.ready()
    const staticBackend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })

    const [wasmObservations, staticObservations] = [
      await runScript(wasm as unknown as TableBackend),
      await runScript(staticBackend as unknown as TableBackend),
    ]
    wasm.dispose()

    // A per-step diff so a mismatch names the offending form rather than
    // dumping two opaque arrays.
    const mismatches = wasmObservations
      .map((observation, index) => ({
        step: observation.step,
        wasm: observation.value,
        static: staticObservations[index]?.value,
      }))
      .filter((row) => row.wasm !== row.static)
    expect(mismatches).toEqual([])

    // Guard against a vacuous pass — "both engines said #ERROR! everywhere"
    // would satisfy the diff above. Pin the values that carry the feature.
    const value = (step: string): string | undefined =>
      wasmObservations.find((o) => o.step === step)?.value
    expect(value('afterEnable.range')).toBe('A1:D5')
    expect(value('afterEnable.hasTotals')).toBe('true')
    expect(value('defaultTotals.formula')).toBe('=SUBTOTAL(109,Table1[Calc])')
    expect(value('totalFunction.sum.formula')).toBe('=SUBTOTAL(109,Table1[Q1])')
    expect(value('totalFunction.sum.display')).toBe('400')
    expect(value('totalFunction.average.display')).toBe('133.333333')
    expect(value('totalFunction.max.display')).toBe('200')
    expect(value('afterEdit.total')).toBe('780') // 500 + 80 + 200
    expect(value('afterDisable.range')).toBe('A1:D4')
    // Structured references really resolved rather than erroring out.
    expect(value('preTotals.outside =SUM(Table1[Q1])')).toBe('400')
    expect(value('preTotals.inside =[@Q1]')).toBe('120')
    expect(value('preTotals.inside =Table1[@Q1]+Table1[@Q2]')).toBe('300')
    expect(value('preTotals.inside =SUM([Q1])')).toBe('400')
    // …and the totals row stays OUT of the `#Data` band once enabled.
    expect(value('postTotals.outside =SUM(Table1[Q1])')).toBe('400')
    // `#Totals` is unresolvable before the toggle and reads the live totals
    // cells after it (Q1 holds the loop's last aggregate, `var`; Calc holds
    // the seeded SUM over an empty column).
    expect(value('preTotals.outside =SUM(Table1[#Totals])')).toBe('#REF!')
    expect(value('postTotals.outside =SUM(Table1[#Totals])')).toBe('3733.333333')
  })
})
