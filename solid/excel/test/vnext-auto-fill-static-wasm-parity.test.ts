/**
 * @jest-environment node
 *
 * Engine-owned auto-fill — STATIC ⇄ WASM golden parity. The repo's rule (see
 * `vnext-sort-static-wasm-parity.test.ts`, `vnext-filter-static-wasm-parity.test.ts`,
 * `vnext-table-totals-static-wasm-parity.test.ts`) is that a second implementation of
 * engine logic is only allowed when pinned by a static⇄WASM golden parity test. Auto-fill
 * now has two independent implementations — `rust/excel-core/src/auto_fill.rs` (reached via
 * `rust/wasm`'s `apply_auto_fill` and `worker-workbook-backend.ts`) and the parallel TS
 * planner in `static-backend.ts` (`preflightFillRange` / `preflightFillSeries`) — and this
 * file is that pin.
 *
 * Method: seed IDENTICAL workbooks into a WASM worker AND a static backend, run the
 * IDENTICAL `fillRange` / `fillSeries` request against both (both implement the same
 * `SpreadsheetBackend` port, so the request objects are literally shared), then compare
 * the resulting cell values, formats, and ACK shape.
 *
 * The ten scenarios mirror the golden cases already proven (independently) against each
 * engine — several are lifted verbatim from `rust/excel-core/src/auto_fill.rs`'s own unit
 * tests (`running_total_batch_cycle_lands_while_sibling_column_still_computes`,
 * `calendar_day_series_crosses_excel_1900_leap_bug_in_both_directions`,
 * `calendar_series_ignores_number_format_and_operates_on_the_raw_serial`,
 * `text_number_and_named_lists_extend_and_wrap`,
 * `validate_geometry_rejects_a_target_range_over_the_cell_budget`) so the exact numbers are
 * traceable to the canonical Rust behaviour instead of hand-invented.
 *
 * Scenario 7 used to document a real divergence — static's tokenizer could not parse the
 * `#REF!` literal that `shiftFormulaRefs` substitutes into a copied formula, so it read
 * `#ERROR!` where WASM read `#REF!`. `static-formula-eval.ts` now has a bare-error-literal
 * grammar rule, so both engines agree and the scenario asserts one value on both sides.
 *
 * WASM harness mirrors vnext-sort-static-wasm-parity.test.ts: wasm-pkg mocked onto itself
 * with the binary pre-loaded via `initSync`, a fake `self` installed before the runtime
 * imports, an in-process worker bridging client ⇄ runtime.
 */

import { beforeAll, describe, expect, jest, test } from '@jest/globals'

import type {
  AutoFillMutationResult,
  CellRange,
  DisplayCell,
  FillRangeRequest,
  FillSeriesRequest,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
} from '@einfach/spreadsheet-ui-core'
import type * as NodeFsModule from 'node:fs'
import type * as NodePathModule from 'node:path'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter/static-backend'

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

// === Shared harness ==========================================================

let requestId = 1

function newStaticBackend(): SpreadsheetBackend {
  return createStaticSpreadsheetBackend({
    revision: 1,
    sheets: [{ id: SHEET, name: 'Sheet1' }],
  })
}

async function newWasmBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createWasmBackend!()
  await backend.ready()
  return backend
}

async function seedCells(
  backend: SpreadsheetBackend,
  seed: ReadonlyArray<readonly [number, number, string]>,
): Promise<void> {
  for (const [row, col, input] of seed) {
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

async function setFormat(
  backend: SpreadsheetBackend,
  range: CellRange,
  format: SpreadsheetCellFormat,
): Promise<void> {
  await backend.setFormatRange!({
    kind: 'set-format-range',
    sheetId: SHEET,
    range,
    format,
    requestId: requestId++,
  })
}

async function readCells(backend: SpreadsheetBackend, range: CellRange): Promise<DisplayCell[]> {
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    range,
    requestId: requestId++,
    reason: 'test',
  })
  return result.cells
}

function cellAt(cells: readonly DisplayCell[], row: number, col: number): DisplayCell | undefined {
  return cells.find((cell) => cell.row === row && cell.col === col)
}

/** Narrows an `AutoFillMutationResult` to its `applied: true` arm, asserting as it goes. */
function assertApplied(
  result: AutoFillMutationResult,
): asserts result is Extract<AutoFillMutationResult, { applied: true }> {
  expect(result.applied).toBe(true)
  expect(result.historyTransactionCount).toBe(1)
}

function expectSameNumber(actual: number | undefined, expected: number, eps = 1e-9): void {
  expect(typeof actual).toBe('number')
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(eps)
}

/**
 * Strips `undefined` / `false` / `'default'` leaves (recursively) so a
 * format comparison isn't tripped up by a projection-verbosity difference
 * that is orthogonal to auto-fill: the WASM adapter's `DisplayCell.format`
 * echoes a fully-expanded object (explicit `bold: false`, `align: 'default'`,
 * every `numberFormat` sub-field present-but-`undefined`, …) while the static
 * backend echoes only the fields actually set. Both conventions describe the
 * exact same effective format; this normalizes them to the same shape before
 * `toEqual` so the assertion tests auto-fill's format COPY, not the two
 * backends' unrelated format-projection verbosity convention.
 */
function normalizeFormat(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFormat)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || entry === false || entry === 'default') continue
      const normalized = normalizeFormat(entry)
      if (
        normalized &&
        typeof normalized === 'object' &&
        !Array.isArray(normalized) &&
        Object.keys(normalized).length === 0
      ) {
        continue
      }
      out[key] = normalized
    }
    // Normalize numberFormat.kind: B 链 (SALVAGE_PLAN_REVISIONS §二) 将
    // WASM 规范名统一为 "number"，static 后端仍回显 "decimal"。两者语义等价，
    // 此处统一为规范名 "number" 以消除 parity 假阳性。
    if (out.numberFormat && typeof out.numberFormat === 'object') {
      const nf = out.numberFormat as Record<string, unknown>
      if (nf.kind === 'decimal') nf.kind = 'number'
    }
    return out
  }
  return value
}

const BUILTIN_WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

describe('static ⇄ WASM auto-fill golden parity', () => {
  test('both backends expose native fillRange / fillSeries ports', async () => {
    const staticBackend = newStaticBackend()
    const wasmBackend = await newWasmBackend()
    expect(typeof staticBackend.fillRange).toBe('function')
    expect(typeof staticBackend.fillSeries).toBe('function')
    expect(typeof wasmBackend.fillRange).toBe('function')
    expect(typeof wasmBackend.fillSeries).toBe('function')
    wasmBackend.dispose()
  })

  test('1. numeric uniform-step fill down (1,3 -> extend 6 cells)', async () => {
    const seed = [
      [0, 0, '1'],
      [1, 0, '3'],
    ] as const
    const request: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 7, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'integer-step',
      step: 2,
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillSeries!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillSeries!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)
    expect(staticResult.affectedRange).toEqual(wasmResult.affectedRange)
    expect(staticResult.affectedRange).toEqual({ rowStart: 2, rowEnd: 7, colStart: 0, colEnd: 0 })

    const staticCells = await readCells(staticBackend, request.targetRange)
    const wasmCells = await readCells(wasmBackend, request.targetRange)
    const expected = [1, 3, 5, 7, 9, 11, 13, 15]
    for (let row = 0; row <= 7; row += 1) {
      expectSameNumber(cellAt(staticCells, row, 0)?.numericValue, expected[row])
      expectSameNumber(cellAt(wasmCells, row, 0)?.numericValue, expected[row])
    }

    wasmBackend.dispose()
  })

  test('2. least-squares linear trend (1, 2, 4 -> extend 2 cells)', async () => {
    const seed = [
      [0, 0, '1'],
      [1, 0, '2'],
      [2, 0, '4'],
    ] as const
    const request: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'linear-trend',
      step: 1.5,
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillSeries!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillSeries!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)
    expect(staticResult.affectedRange).toEqual(wasmResult.affectedRange)
    expect(staticResult.affectedRange).toEqual({ rowStart: 3, rowEnd: 4, colStart: 0, colEnd: 0 })

    // Reference computed with the SAME least-squares formula `linear_trend`
    // (auto_fill.rs) implements: mean_x = (n-1)/2, mean_y = mean(values),
    // slope = Σ(cx·(y-mean_y)) / Σ(cx²), intercept = mean_y - slope·mean_x.
    const values = [1, 2, 4]
    const meanX = (values.length - 1) / 2
    const meanY = values.reduce((a, b) => a + b, 0) / values.length
    let numerator = 0
    let denominator = 0
    values.forEach((value, index) => {
      const centeredX = index - meanX
      numerator += centeredX * (value - meanY)
      denominator += centeredX * centeredX
    })
    const slope = numerator / denominator
    const intercept = meanY - slope * meanX

    const staticCells = await readCells(staticBackend, request.targetRange)
    const wasmCells = await readCells(wasmBackend, request.targetRange)
    // Only rows 3-4 were WRITTEN by the fill (the affected range asserted
    // above) — rows 0-2 are the untouched source cells and still hold their
    // original raw values (1, 2, 4), not the fitted trend line.
    for (let row = 3; row <= 4; row += 1) {
      const expected = intercept + slope * row
      expectSameNumber(cellAt(staticCells, row, 0)?.numericValue, expected)
      expectSameNumber(cellAt(wasmCells, row, 0)?.numericValue, expected)
    }
    // Anti-vacuity: this is NOT the naive last-delta step (2, which would give
    // A4=6, A5=8) — least squares must win, matching auto_fill.rs's own test.
    expectSameNumber(cellAt(wasmCells, 3, 0)?.numericValue, 5 + 1 / 3)
    expectSameNumber(cellAt(wasmCells, 4, 0)?.numericValue, 6 + 5 / 6)

    wasmBackend.dispose()
  })

  test('3. date-day series crosses the 1900-02-28/03-01 boundary (date formatted)', async () => {
    // Verbatim scenario from auto_fill.rs's
    // `calendar_day_series_crosses_excel_1900_leap_bug_in_both_directions`:
    // serial 60 is Excel's fictitious 1900-02-29; 59 -> 60 -> 61 must walk
    // through it as plain consecutive integers in BOTH directions.
    const seed = [
      [0, 0, '59'], // A1
      [1, 0, '60'], // A2
      [1, 1, '60'], // B2
      [2, 1, '61'], // B3
    ] as const
    const dateFormat: SpreadsheetCellFormat = {
      numberFormat: { kind: 'date', pattern: 'yyyy-mm-dd' },
    }
    const downRequest: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'date-day',
      step: 1,
    }
    const upRequest: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 1, colEnd: 1 },
      direction: 'up',
      series: 'date-day',
      step: 1,
    }

    async function run(backend: SpreadsheetBackend): Promise<void> {
      await seedCells(backend, seed)
      await setFormat(backend, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }, dateFormat)
      await setFormat(backend, { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 }, dateFormat)
      const downResult = await backend.fillSeries!(downRequest)
      const upResult = await backend.fillSeries!(upRequest)
      assertApplied(downResult)
      assertApplied(upResult)
    }

    const staticBackend = newStaticBackend()
    await run(staticBackend)
    const wasmBackend = await newWasmBackend()
    await run(wasmBackend)

    const staticCells = await readCells(staticBackend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 1,
    })
    const wasmCells = await readCells(wasmBackend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 1,
    })

    // A3 (crossing forward through the fictitious leap day) and B1 (crossing
    // backward through it) both land on the correct consecutive serial.
    expectSameNumber(cellAt(staticCells, 2, 0)?.numericValue, 61)
    expectSameNumber(cellAt(wasmCells, 2, 0)?.numericValue, 61)
    expectSameNumber(cellAt(staticCells, 0, 1)?.numericValue, 59)
    expectSameNumber(cellAt(wasmCells, 0, 1)?.numericValue, 59)

    // Format propagation: the generated cells copy their (wrapped) source's
    // effective date format on both engines. Normalized (see
    // `normalizeFormat`) because the WASM projection echoes a
    // fully-expanded format object while static echoes a sparse one — an
    // unrelated verbosity convention, not a fact difference.
    expect(normalizeFormat(cellAt(staticCells, 2, 0)?.format)).toEqual(normalizeFormat(dateFormat))
    expect(normalizeFormat(cellAt(wasmCells, 2, 0)?.format)).toEqual(normalizeFormat(dateFormat))
    expect(normalizeFormat(cellAt(staticCells, 0, 1)?.format)).toEqual(normalizeFormat(dateFormat))
    expect(normalizeFormat(cellAt(wasmCells, 0, 1)?.format)).toEqual(normalizeFormat(dateFormat))

    wasmBackend.dispose()
  })

  test('4. date-day series on UNFORMATTED serial numbers (plain arithmetic)', async () => {
    // Verbatim scenario from auto_fill.rs's
    // `calendar_series_ignores_number_format_and_operates_on_the_raw_serial`:
    // date-kind detection must NOT be gated on the source cell having an
    // effective date format — plain General-formatted serials still extend.
    const seed = [
      [0, 0, '45292'],
      [1, 0, '45293'],
    ] as const
    const request: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'date-day',
      step: 1,
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillSeries!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillSeries!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)

    const staticCells = await readCells(staticBackend, request.targetRange)
    const wasmCells = await readCells(wasmBackend, request.targetRange)
    expectSameNumber(cellAt(staticCells, 2, 0)?.numericValue, 45294)
    expectSameNumber(cellAt(wasmCells, 2, 0)?.numericValue, 45294)
    expectSameNumber(cellAt(staticCells, 3, 0)?.numericValue, 45295)
    expectSameNumber(cellAt(wasmCells, 3, 0)?.numericValue, 45295)
    // Not retroactively stamped as dates: no format was set anywhere, so the
    // generated cells stay formatless on both engines.
    expect(cellAt(staticCells, 3, 0)?.format).toBeUndefined()
    expect(cellAt(wasmCells, 3, 0)?.format).toBeUndefined()

    wasmBackend.dispose()
  })

  test('5. text-number pattern (Item009 -> Item010, Item011, Item012)', async () => {
    const seed = [
      [0, 0, 'Item009'],
      [1, 0, 'Item010'],
    ] as const
    const request: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'text-number',
      step: 1,
      textPattern: { prefix: 'Item', suffix: '', width: 3 },
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillSeries!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillSeries!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)

    const staticCells = await readCells(staticBackend, request.targetRange)
    const wasmCells = await readCells(wasmBackend, request.targetRange)
    expect(cellAt(staticCells, 2, 0)?.displayValue).toBe('Item011')
    expect(cellAt(wasmCells, 2, 0)?.displayValue).toBe('Item011')
    expect(cellAt(staticCells, 3, 0)?.displayValue).toBe('Item012')
    expect(cellAt(wasmCells, 3, 0)?.displayValue).toBe('Item012')

    wasmBackend.dispose()
  })

  test('6. weekday-name list cycles forward and wraps past Sunday', async () => {
    const seed = [[0, 0, 'Sun']] as const
    const request: FillSeriesRequest = {
      kind: 'fill-series',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'weekday-name',
      step: 1,
      list: { listName: 'builtin-weekday-short', values: BUILTIN_WEEKDAY_SHORT, locale: 'en' },
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillSeries!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillSeries!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)

    const staticCells = await readCells(staticBackend, request.targetRange)
    const wasmCells = await readCells(wasmBackend, request.targetRange)
    // Sun is list index 6; +1 wraps to Mon (index 0), +2 lands on Tue.
    expect(cellAt(staticCells, 1, 0)?.displayValue).toBe('Mon')
    expect(cellAt(wasmCells, 1, 0)?.displayValue).toBe('Mon')
    expect(cellAt(staticCells, 2, 0)?.displayValue).toBe('Tue')
    expect(cellAt(wasmCells, 2, 0)?.displayValue).toBe('Tue')

    wasmBackend.dispose()
  })

  test('7. fillRange formula relative-shift substitutes #REF! when it exits the grid', async () => {
    // Both engines re-render the shifted formula as "=(#REF!+$C$1)" and both
    // now parse the bare error literal: the Rust parser has always had the
    // error-literal grammar rule (`formula.rs`: `("#REF!", InvalidRef)`), and
    // the static tokenizer gained one too (static-formula-eval.ts), closing
    // the divergence this scenario used to document.
    const seed = [[0, 1, '=A1+$C$1']] as const // B1
    const request: FillRangeRequest = {
      kind: 'fill-range',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      direction: 'left',
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillRange!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillRange!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)
    expect(staticResult.affectedRange).toEqual(wasmResult.affectedRange)

    const staticCells = await readCells(staticBackend, {
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 1,
    })
    const wasmCells = await readCells(wasmBackend, {
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 1,
    })

    expect(cellAt(wasmCells, 0, 0)?.displayValue).toBe('#REF!')
    expect(cellAt(staticCells, 0, 0)?.displayValue).toBe('#REF!')

    wasmBackend.dispose()
  })

  test('8. cycle-landing: running-total fillRange lands with #CYCLE! cells', async () => {
    // Verbatim scenario from auto_fill.rs's
    // `running_total_batch_cycle_lands_while_sibling_column_still_computes`:
    // C1/D1 mutually reference each other's fill target via absolute refs
    // (a relative running total can never close a cycle by itself — a fixed
    // per-row shift only walks further from the source). Filling both down
    // one row closes a batch-only cycle between C2 and D2, which propagates
    // back to C1/D1; sibling column E (unrelated, `=A1*2`) is filled in the
    // very same batch and must compute normally throughout.
    const seed = [
      [0, 0, '1'], // A1
      [1, 0, '2'], // A2
      [0, 2, '=$D$2+$A$1'], // C1
      [0, 3, '=$C$2+$A$2'], // D1
      [0, 4, '=A1*2'], // E1
    ] as const
    const request: FillRangeRequest = {
      kind: 'fill-range',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 2, colEnd: 4 },
      targetRange: { rowStart: 0, rowEnd: 1, colStart: 2, colEnd: 4 },
      direction: 'down',
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    const staticResult = await staticBackend.fillRange!(request)

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    const wasmResult = await wasmBackend.fillRange!(request)

    assertApplied(staticResult)
    assertApplied(wasmResult)
    expect(staticResult.affectedRange).toEqual(wasmResult.affectedRange)
    expect(staticResult.affectedRange).toEqual({ rowStart: 1, rowEnd: 1, colStart: 2, colEnd: 4 })

    const readRange = { rowStart: 0, rowEnd: 1, colStart: 2, colEnd: 4 }
    const staticCells = await readCells(staticBackend, readRange)
    const wasmCells = await readCells(wasmBackend, readRange)

    for (const [row, col] of [
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
    ]) {
      expect(cellAt(staticCells, row, col)?.displayValue).toBe('#CYCLE!')
      expect(cellAt(wasmCells, row, col)?.displayValue).toBe('#CYCLE!')
    }
    // The sibling column, filled in the same batch, is unaffected.
    expectSameNumber(cellAt(staticCells, 0, 4)?.numericValue, 2)
    expectSameNumber(cellAt(wasmCells, 0, 4)?.numericValue, 2)
    expectSameNumber(cellAt(staticCells, 1, 4)?.numericValue, 4)
    expectSameNumber(cellAt(wasmCells, 1, 4)?.numericValue, 4)

    wasmBackend.dispose()
  })

  test('9. over-cap rejection: both backends reject before mutating anything', async () => {
    // Verbatim numbers from auto_fill.rs's
    // `validate_geometry_rejects_a_target_range_over_the_cell_budget` /
    // `apply_auto_fill_engine_call_rejects_a_request_over_the_cell_budget`:
    // 2 columns x 1,048,576 rows = 2,097,152 cells, exactly double the
    // MAX_AUTO_FILL_CELLS budget (1,048,576). Both TS adapters mirror the
    // same cap client-side (`assertAutoFillWithinCellBudget` in
    // static-backend.ts, `validateAutoFillGeometry` in
    // worker-workbook-backend.ts) and reject BEFORE any RPC / mutation, so
    // both `fillRange` calls reject the returned promise identically — no
    // structured `applied: false` ACK is reachable here on either backend
    // because the request never gets far enough to build one.
    const seed = [
      [0, 0, '1'], // A1
      [0, 1, '2'], // B1
    ] as const
    const request: FillRangeRequest = {
      kind: 'fill-range',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 1_048_575, colStart: 0, colEnd: 1 },
      direction: 'down',
    }

    const staticBackend = newStaticBackend()
    await seedCells(staticBackend, seed)
    await expect(staticBackend.fillRange!(request)).rejects.toThrow()

    const wasmBackend = await newWasmBackend()
    await seedCells(wasmBackend, seed)
    await expect(wasmBackend.fillRange!(request)).rejects.toThrow()

    // Workbook unchanged on both: the seed values are intact and nothing
    // below them was ever written.
    const spotCheck = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 1 }
    const staticCells = await readCells(staticBackend, spotCheck)
    const wasmCells = await readCells(wasmBackend, spotCheck)
    expect(cellAt(staticCells, 0, 0)?.displayValue).toBe('1')
    expect(cellAt(wasmCells, 0, 0)?.displayValue).toBe('1')
    expect(cellAt(staticCells, 0, 1)?.displayValue).toBe('2')
    expect(cellAt(wasmCells, 0, 1)?.displayValue).toBe('2')
    expect(cellAt(staticCells, 1, 0)).toBeUndefined()
    expect(cellAt(wasmCells, 1, 0)).toBeUndefined()

    wasmBackend.dispose()
  })

  test('10. copy-fill propagates the source cell format to every target', async () => {
    const seed = [[0, 0, '42']] as const // A1
    // `kind: 'decimal'` (not the newer `'number'` alias) deliberately: the
    // WASM wire's `NumberFormat` deserializer (rust/wasm/src/lib.rs) only
    // recognizes the string `"decimal"`, not `"number"` — an existing,
    // auto-fill-independent gap (a `setFormatRange({kind:'number'})` call
    // silently loses its number format against the real WASM backend even
    // with no fill involved; verified by probing `setFormatRange` + a
    // plain read-back with no `fillRange` in between). Using the working
    // alias here keeps this test about auto-fill's format COPY behaviour
    // rather than accidentally re-discovering that unrelated bug.
    const format: SpreadsheetCellFormat = {
      bold: true,
      numberFormat: { kind: 'decimal', digits: 2, thousands: false },
    }
    const request: FillRangeRequest = {
      kind: 'fill-range',
      sheetId: SHEET,
      requestId: requestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 3 },
      direction: 'right',
    }

    async function run(backend: SpreadsheetBackend): Promise<AutoFillMutationResult> {
      await seedCells(backend, seed)
      await setFormat(backend, { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }, format)
      return backend.fillRange!(request)
    }

    const staticBackend = newStaticBackend()
    const staticResult = await run(staticBackend)
    const wasmBackend = await newWasmBackend()
    const wasmResult = await run(wasmBackend)

    assertApplied(staticResult)
    assertApplied(wasmResult)
    expect(staticResult.affectedRange).toEqual(wasmResult.affectedRange)
    expect(staticResult.affectedRange).toEqual({ rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 3 })

    const staticCells = await readCells(staticBackend, request.targetRange)
    const wasmCells = await readCells(wasmBackend, request.targetRange)
    for (const col of [1, 2, 3]) {
      expect(cellAt(staticCells, 0, col)?.displayValue).toBe('42.00')
      expect(cellAt(wasmCells, 0, col)?.displayValue).toBe('42.00')
      expect(normalizeFormat(cellAt(staticCells, 0, col)?.format)).toEqual(normalizeFormat(format))
      expect(normalizeFormat(cellAt(wasmCells, 0, col)?.format)).toEqual(normalizeFormat(format))
    }

    wasmBackend.dispose()
  })
})
