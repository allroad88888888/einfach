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

import type {
  ColumnFilterRule,
  DisplayCell,
  TableTotalsFunction,
} from '@einfach/spreadsheet-ui-core'
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
  hideRows?: (request: {
    kind: 'hide-rows'
    sheetId: string
    rowIndices: number[]
    requestId?: number
  }) => Promise<unknown>
  unhideRows?: (request: {
    kind: 'unhide-rows'
    sheetId: string
    rowIndices: number[]
    requestId?: number
  }) => Promise<unknown>
  setEvalHiddenRows?: (request: {
    kind: 'set-eval-hidden-rows'
    sheetId: string
    rows: readonly number[]
  }) => Promise<void> | void
  setFilterSort?: (request: {
    kind: 'set-filter-sort'
    sheetId: string
    rules: readonly ColumnFilterRule[]
    requestId?: number
  }) => Promise<unknown>
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

/**
 * Structured-reference forms NEITHER engine resolves — combined qualifiers
 * (`[[#Data],[Col]]`) and cross-sheet Table refs. They are kept OUT of the
 * strict diff above because the two hosts reject them on different axes, and
 * that boundary is asserted explicitly in its own test below rather than
 * silently averaged away.
 */
const UNSUPPORTED_FORMULAS: readonly string[] = [
  '=SUM(Table1[[#Data],[Q1]])',
  '=SUM(Table1[[#Headers],[Q1]])',
  '=SUM(Sheet1!Table1[Q1])',
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
  try {
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: SHEET,
      row: at.row,
      col: at.col,
      input: formula,
      requestId: probeRequestId++,
    })
  } catch (e) {
    return `THROW:${(e as Error).message}`
  }
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

// === Script 2: SUBTOTAL hidden-row semantics ================================
//
// The first script never hides a row, so it cannot see the hidden-row half of
// SUBTOTAL. This one drives the SAME host-level hidden declaration into both
// engines and compares 1-11 against 101-111 at every phase.
//
// Host contract under test (design-excel-table §6.1): the engine models NO
// hidden state and never infers a row's source — `setEvalHiddenRows` is a
// whole-set REPLACE evaluation input the HOST pushes. The manual hide lane
// (`hideRows`, a VIEW fact) and the eval lane are therefore both driven here,
// exactly as the app drives them (UI-core hide command → `hideRows` on static;
// the hidden-row engine feed → `setEvalHiddenRows`, the port the worker exposes
// and the one UI core's hide command now pushes since the sink-down, E7).
//
// Filter visibility is deliberately included: per design §6.1 the MVP push
// source is `viewportHiddenAtom` (MANUAL rows only) and filter-hidden rows
// join the same set only after the #29 filter-canonical flip. So a filter must
// move NEITHER engine's SUBTOTAL — and that agreement is what is asserted.

const SUBTOTAL_PROBES: readonly string[] = [
  '=SUBTOTAL(9,Table1[Q1])',
  '=SUBTOTAL(109,Table1[Q1])',
  '=SUBTOTAL(1,Table1[Q1])',
  '=SUBTOTAL(101,Table1[Q1])',
  '=SUBTOTAL(2,Table1[Q1])',
  '=SUBTOTAL(102,Table1[Q1])',
  '=SUBTOTAL(3,Table1[Q1])',
  '=SUBTOTAL(103,Table1[Q1])',
  '=SUBTOTAL(4,Table1[Q1])',
  '=SUBTOTAL(104,Table1[Q1])',
  '=SUBTOTAL(5,Table1[Q1])',
  '=SUBTOTAL(105,Table1[Q1])',
  '=SUBTOTAL(6,Table1[Q1])',
  '=SUBTOTAL(106,Table1[Q1])',
  // The same aggregate over a plain A1 range — hidden-row exclusion must not
  // depend on the reference being structured.
  '=SUBTOTAL(9,B2:B4)',
  '=SUBTOTAL(109,B2:B4)',
]

/**
 * Declare exactly `rows` hidden on the sheet, through BOTH host lanes, with
 * whole-set REPLACE semantics (an empty array clears). A backend that omits a
 * lane simply skips it — and the recorded port availability makes that visible
 * rather than silent.
 */
async function declareHiddenRows(backend: TableBackend, rows: readonly number[]): Promise<void> {
  if (backend.hideRows && backend.unhideRows) {
    // REPLACE, not merge: clear the data band first, then hide the target set.
    await backend.unhideRows({
      kind: 'unhide-rows',
      sheetId: SHEET,
      rowIndices: [1, 2, 3],
      requestId: probeRequestId++,
    })
    if (rows.length > 0) {
      await backend.hideRows({
        kind: 'hide-rows',
        sheetId: SHEET,
        rowIndices: [...rows],
        requestId: probeRequestId++,
      })
    }
  }
  await backend.setEvalHiddenRows?.({
    kind: 'set-eval-hidden-rows',
    sheetId: SHEET,
    rows: [...rows],
  })
}

async function runHiddenScript(backend: TableBackend): Promise<Observation[]> {
  const out: Observation[] = []
  const record = (step: string, value: unknown): void => {
    out.push({ step, value: String(value) })
  }

  await seed(backend)
  await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: TABLE_RANGE })
  await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })
  await backend.setTableTotalFunction!({
    kind: 'set-table-total-function',
    name: 'Table1',
    column: 'Q1',
    func: 'sum',
  })

  // The eval lane is itself a parity observable: `setEvalHiddenRows` is the
  // ONLY hidden lane the WASM backend offers (the engine models no hidden
  // state, so that backend exposes no `hideRows`), so a backend missing it is
  // deaf to the documented host push no matter what its own hide ports do.
  record('port.setEvalHiddenRows', typeof backend.setEvalHiddenRows === 'function')
  record('port.setFilterSort', typeof backend.setFilterSort === 'function')

  const probeAll = async (phase: string): Promise<void> => {
    for (const formula of SUBTOTAL_PROBES) {
      record(`${phase} ${formula}`, await probe(backend, OUTSIDE_PROBE, formula))
    }
    // The Table's own generated totals cell IS a `SUBTOTAL(109,…)`, so it must
    // track the 101-111 column above.
    record(
      `${phase} totalsCell`,
      normalizeDisplay((await readCell(backend, 4, 1))?.displayValue ?? ''),
    )
  }

  // Q1 = 120 / 80 / 200 over source rows 1 / 2 / 3.
  await probeAll('baseline')

  // Manually hide South (source row 2, Q1 = 80): 101-111 drops it, 1-11 keeps it.
  await declareHiddenRows(backend, [2])
  await probeAll('manualHidden')

  // Two hidden rows, to catch an "only the first hidden row is excluded" bug.
  await declareHiddenRows(backend, [1, 3])
  await probeAll('manualHiddenPair')

  // Whole-set REPLACE must fully restore the baseline.
  await declareHiddenRows(backend, [])
  await probeAll('afterUnhide')

  // The eval lane ALONE — no `hideRows` call at all. This is exactly the
  // hidden-row engine feed (`setEvalHiddenRows`) UI core's hide command pushes,
  // and the only lane the WASM backend has. A backend that infers exclusion
  // solely from its own hide-port state reads the unhidden baseline here
  // instead of excluding, which is the
  // divergence this phase exists to catch.
  await backend.setEvalHiddenRows?.({
    kind: 'set-eval-hidden-rows',
    sheetId: SHEET,
    rows: [2],
  })
  await probeAll('evalLaneOnly')
  await declareHiddenRows(backend, [])

  // Filter-hidden rows: keep only North, which filters OUT source rows 2 and 3.
  // Since #27 S4 both adapters derive that set when the rules are applied and
  // hand it to their engine as a SECOND, independent eval input, so BOTH
  // SUBTOTAL bands drop those rows (`design-filter-hidden-rows` §2/§6.3).
  await backend.setFilterSort?.({
    kind: 'set-filter-sort',
    sheetId: SHEET,
    rules: [{ kind: 'equals', colIndex: 0, value: 'North' }],
    requestId: probeRequestId++,
  })
  await probeAll('filterHidden')

  // Both layers at once — the sharpest statement of the rule the two separate
  // sets exist for: North (row 1) is manually hidden while rows 2 and 3 are
  // filter-hidden, so 1-11 sees ONLY North and 101-111 sees nothing at all.
  await declareHiddenRows(backend, [1])
  await probeAll('filterPlusManualHidden')
  await declareHiddenRows(backend, [])

  await backend.setFilterSort?.({
    kind: 'set-filter-sort',
    sheetId: SHEET,
    rules: [],
    requestId: probeRequestId++,
  })
  await probeAll('afterFilterClear')

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

  /**
   * KNOWN DIVERGENCE (design-excel-table §11.2 `known-divergence`), pinned so
   * it cannot drift unnoticed. Both engines refuse combined qualifiers and
   * cross-sheet Table refs, but on DIFFERENT axes:
   *
   *  - WASM refuses at WRITE time — the engine grammar defers these forms, so
   *    the parser rejects the input and `setCellInput` throws.
   *  - The static host accepts the write and surfaces `#ERROR!` at EVAL time
   *    (its tokenizer treats an unresolvable `Table[...]` as a hard failure,
   *    deliberately never faking a value).
   *
   * Neither host invents a value, so no wrong number can reach a user, and
   * closing the gap is a WRITE-path change (static would have to reject the
   * input), not an evaluator change — see the TODO in `static-backend.ts`.
   */
  test('unsupported structured-reference forms: refused by both, on different axes', async () => {
    const wasm = createWasmBackend!()
    await wasm.ready()
    const staticBackend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })

    for (const backend of [wasm, staticBackend] as unknown as TableBackend[]) {
      await seed(backend)
      await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: TABLE_RANGE })
    }

    for (const formula of UNSUPPORTED_FORMULAS) {
      const asTable = staticBackend as unknown as TableBackend
      const wasmAnswer = await probe(wasm as unknown as TableBackend, OUTSIDE_PROBE, formula)
      const staticAnswer = await probe(asTable, OUTSIDE_PROBE, formula)
      // Neither engine ever returns a number for these.
      expect(wasmAnswer).toBe('THROW:formula could not be parsed or installed')
      expect(staticAnswer).toBe('#ERROR!')
    }
    wasm.dispose()
  })

  test('both engines answer the identical hidden-row script identically', async () => {
    const wasm = createWasmBackend!()
    await wasm.ready()
    const staticBackend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
    })

    const wasmObservations = await runHiddenScript(wasm as unknown as TableBackend)
    const staticObservations = await runHiddenScript(staticBackend as unknown as TableBackend)
    wasm.dispose()

    const mismatches = wasmObservations
      .map((observation, index) => ({
        step: observation.step,
        wasm: observation.value,
        static: staticObservations[index]?.value,
      }))
      .filter((row) => row.wasm !== row.static)
    expect(mismatches).toEqual([])

    // Anti-vacuity: pin the values that carry the hidden-row semantics, so a
    // future "neither engine excludes anything" regression cannot pass.
    const value = (step: string): string | undefined =>
      wasmObservations.find((o) => o.step === step)?.value

    // The documented eval lane must exist on BOTH engines — its absence on the
    // static host is precisely the divergence this script was added to catch.
    expect(value('port.setEvalHiddenRows')).toBe('true')

    // The view lane is asymmetric BY DESIGN and is therefore asserted per
    // backend rather than diffed: the engine models no hidden state at all
    // (design §2.2), so the WASM backend exposes no `hideRows` — hidden rows
    // reach it only as the pushed eval input. The static backend doubles as
    // its own view host, so it does own that port.
    expect(typeof (wasm as unknown as TableBackend).hideRows).toBe('undefined')
    expect(typeof (staticBackend as unknown as TableBackend).hideRows).toBe('function')

    // Baseline: nothing hidden, so 9 and 109 agree. Q1 = 120 + 80 + 200.
    expect(value('baseline =SUBTOTAL(9,Table1[Q1])')).toBe('400')
    expect(value('baseline =SUBTOTAL(109,Table1[Q1])')).toBe('400')
    expect(value('baseline totalsCell')).toBe('400')

    // South (80) hidden: 1-11 unchanged, 101-111 drops it. This inequality IS
    // the feature — if these two ever match again the exclusion has regressed.
    expect(value('manualHidden =SUBTOTAL(9,Table1[Q1])')).toBe('400')
    expect(value('manualHidden =SUBTOTAL(109,Table1[Q1])')).toBe('320')
    expect(value('manualHidden totalsCell')).toBe('320')
    expect(value('manualHidden =SUBTOTAL(1,Table1[Q1])')).toBe('133.333333')
    expect(value('manualHidden =SUBTOTAL(101,Table1[Q1])')).toBe('160') // (120+200)/2
    expect(value('manualHidden =SUBTOTAL(2,Table1[Q1])')).toBe('3')
    expect(value('manualHidden =SUBTOTAL(102,Table1[Q1])')).toBe('2')
    expect(value('manualHidden =SUBTOTAL(5,Table1[Q1])')).toBe('80')
    expect(value('manualHidden =SUBTOTAL(105,Table1[Q1])')).toBe('120')
    // A plain A1 range excludes the same rows as the structured form.
    expect(value('manualHidden =SUBTOTAL(9,B2:B4)')).toBe('400')
    expect(value('manualHidden =SUBTOTAL(109,B2:B4)')).toBe('320')

    // Both ends of the data band hidden, only South (80) left.
    expect(value('manualHiddenPair =SUBTOTAL(109,Table1[Q1])')).toBe('80')
    expect(value('manualHiddenPair =SUBTOTAL(9,Table1[Q1])')).toBe('400')

    // Whole-set REPLACE with an empty set restores the baseline exactly.
    expect(value('afterUnhide =SUBTOTAL(109,Table1[Q1])')).toBe('400')
    expect(value('afterUnhide totalsCell')).toBe('400')

    // The pushed eval input alone is sufficient on BOTH hosts — no `hideRows`
    // involved. This is the assertion the static backend failed before it
    // implemented `setEvalHiddenRows`.
    expect(value('evalLaneOnly =SUBTOTAL(109,Table1[Q1])')).toBe('320')
    expect(value('evalLaneOnly =SUBTOTAL(9,Table1[Q1])')).toBe('400')
    expect(value('evalLaneOnly totalsCell')).toBe('320')

    // MIGRATED (#27 S4). These three lines previously read '400' / '400' —
    // they pinned an active filter moving NEITHER band, which is the engine
    // not knowing a filter existed and therefore summing rows the user had
    // filtered away. Excel excludes filter-hidden rows from both bands, so the
    // old numbers pinned a divergence, not a contract.
    //
    // Only North (Q1 = 120) survives `= 'North'`; rows 2 (80) and 3 (200) are
    // filter-hidden. BOTH bands drop them, which is why these two agree.
    expect(value('filterHidden =SUBTOTAL(9,Table1[Q1])')).toBe('120')
    expect(value('filterHidden =SUBTOTAL(109,Table1[Q1])')).toBe('120')
    // …and unlike the manual set, a filter-hidden row is invisible to 1-11
    // through a plain A1 range too, not just through the structured form.
    expect(value('filterHidden =SUBTOTAL(9,B2:B4)')).toBe('120')

    // The two-layer rule end to end: manual hiding North on TOP of the filter
    // leaves 1-11 with North only (manual rows still count) while 101-111 has
    // nothing left. If these two ever agree again, the sets have been merged.
    expect(value('filterPlusManualHidden =SUBTOTAL(9,Table1[Q1])')).toBe('120')
    expect(value('filterPlusManualHidden =SUBTOTAL(109,Table1[Q1])')).toBe('0')

    // Clearing the rules clears the derived set on both hosts — no staleness.
    expect(value('afterFilterClear =SUBTOTAL(9,Table1[Q1])')).toBe('400')
    expect(value('afterFilterClear =SUBTOTAL(109,Table1[Q1])')).toBe('400')
  })
})
