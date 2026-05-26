/**
 * Wave E / E4 — custom formulas end-to-end through the TS worker runtime.
 *
 * Drives `createWorkerRuntimeTs()` directly (no Worker, no postMessage —
 * we call `runtime.handle(...)` with the same RPC envelopes the host
 * would post). Each test pins one rule from
 * `vanilla/spreadsheet-ui-core/src/custom-formulas/README.md` against
 * the runtime's `registerCustomFormula` / `unregisterCustomFormula`
 * dispatch + the engine's `'call'` arm fallthrough to host customs.
 *
 * Coverage:
 *   - Scalar arg round-trip — `=MYTAX(100)` returns `"20"`.
 *   - Unregister — after `unregisterCustomFormula`, the same formula
 *     re-evaluates as `#NAME?`.
 *   - Range arg marshalling — `=SUMSQ2(A1:A3)` receives a 2-D JS array
 *     (`Value[][]` unwrapped to a `(number|string|...)[][]` shape) and
 *     returns the sum of squares.
 *   - Re-registration — registering the same name twice replaces the
 *     callable.
 *   - Error return — a custom that throws surfaces as `#VALUE!` with the
 *     thrown message attached.
 *   - Builtin shadowing — registering a custom with a builtin name does
 *     NOT override the builtin (dispatch order: built-in → LAMBDA →
 *     custom → `#NAME?`).
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkerRuntimeTs } from '../src-vnext/adapter/worker-runtime-ts'

interface RpcRequest {
  id: number
  cmd: string
  [key: string]: unknown
}

function makeRpc(runtime: ReturnType<typeof createWorkerRuntimeTs>) {
  let nextId = 1
  return async (req: Omit<RpcRequest, 'id'>): Promise<unknown> => {
    const id = nextId++
    const resp = await runtime.handle({ id, ...req } as RpcRequest)
    if (!resp.ok) {
      throw new Error(`RPC ${req.cmd} failed: ${resp.error.code} ${resp.error.message}`)
    }
    return resp.result
  }
}

async function initSheet(runtime: ReturnType<typeof createWorkerRuntimeTs>) {
  const rpc = makeRpc(runtime)
  const sheets = (await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })) as Array<{
    idx: number
  }>
  return { rpc, sheetIdx: sheets[0].idx }
}

async function readCellDisplay(
  rpc: (req: Omit<RpcRequest, 'id'>) => Promise<unknown>,
  sheetIdx: number,
  addr: string,
): Promise<{ display: string; type: string; isError: boolean }> {
  const cells = (await rpc({
    cmd: 'readCells',
    cells: [{ sheet: sheetIdx, addr }],
  })) as Array<{ addr: string; display: string; type: string; isError: boolean }>
  expect(cells).toHaveLength(1)
  return { display: cells[0].display, type: cells[0].type, isError: cells[0].isError }
}

describe('worker-runtime-ts custom formulas — registration + dispatch', () => {
  test('registerCustomFormula + scalar arg: =MYTAX(100) returns 20', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    const registered = await rpc({
      cmd: 'registerCustomFormula',
      name: 'MYTAX',
      source: 'return Number(args[0]) * 0.2',
    })
    expect(registered).toBe(true)

    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=MYTAX(100)' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.display).toBe('20')
    expect(b1.type).toBe('number')
    expect(b1.isError).toBe(false)
  })

  test('unregisterCustomFormula — same formula re-evaluates as #NAME?', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'MYTAX',
      source: 'return Number(args[0]) * 0.2',
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=MYTAX(50)' })
    let b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.display).toBe('10')

    // Unregister — engine should now resolve =MYTAX(...) to #NAME?.
    const removed = await rpc({ cmd: 'unregisterCustomFormula', name: 'MYTAX' })
    expect(removed).toBe(true)

    // Force a re-eval by re-applying the formula (cell value is cached
    // until the cell mutates again; we set the same source to make the
    // sheetAtom transition).
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=MYTAX(50)' })
    b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(true)
    expect(b1.display).toBe('#NAME?')
  })

  test('range arg: =SUMSQ2(A1:A3) — host callback receives 2-D JS array, returns sum of squares = 14', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    // Seed A1=1, A2=2, A3=3 — sum of squares = 1+4+9 = 14.
    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A1', value: { type: 'number', value: 1 } })
    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A2', value: { type: 'number', value: 2 } })
    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A3', value: { type: 'number', value: 3 } })

    // Register a custom that flattens any range-shaped arg and sums squares.
    // args[0] arrives as either a JS scalar (single-cell) or a 2-D JS array
    // (range) per the unwrapForCustom contract in worker-runtime-ts.
    await rpc({
      cmd: 'registerCustomFormula',
      name: 'SUMSQ2',
      source:
        'const xs = Array.isArray(args[0]) ? args[0].flat() : [args[0]]; ' +
        'return xs.reduce((s, v) => s + Number(v) * Number(v), 0)',
    })

    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: sheetIdx,
      addr: 'B1',
      formula: '=SUMSQ2(A1:A3)',
    })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(false)
    expect(b1.type).toBe('number')
    expect(b1.display).toBe('14')
  })

  test('re-register replaces the prior callable (last-write-wins by uppercase name)', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'MULT',
      source: 'return Number(args[0]) * 2',
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=MULT(10)' })
    expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('20')

    // Replace MULT with a *3 implementation; the registry slot is keyed
    // by uppercase name so the second registration silently shadows the
    // first.
    await rpc({
      cmd: 'registerCustomFormula',
      name: 'MULT',
      source: 'return Number(args[0]) * 3',
    })
    // Re-apply the formula to force a fresh eval.
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=MULT(10)' })
    expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('30')
  })

  test('custom that throws surfaces as #VALUE!', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'BOOMER',
      source: 'throw new Error("custom-formula-boom")',
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=BOOMER(1)' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(true)
    expect(b1.display).toBe('#VALUE!')
  })

  test('case-insensitive name resolution: =mytax(5) hits the MYTAX registration', async () => {
    // The engine uppercases the dispatched call name; the registry also
    // stores by uppercase key, so a formula written in lowercase should
    // still route correctly. This pins the contract between the engine
    // dispatcher and the worker runtime's Map keying.
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'MYTAX',
      source: 'return Number(args[0]) * 0.1',
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=mytax(50)' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(false)
    expect(b1.display).toBe('5')
  })

  test('builtin name shadows: a custom registered as SUM does NOT override the engine SUM', async () => {
    // The engine dispatch order is built-in → LAMBDA → custom → #NAME?.
    // A host that smuggles a custom named SUM past the spreadsheet-ui-core
    // validator should still see the built-in win.
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A2', value: { type: 'number', value: 20 } })

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'SUM',
      source: 'return 999',
    })

    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: sheetIdx,
      addr: 'B1',
      formula: '=SUM(A1:A2)',
    })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.display).toBe('30')
  })

  test('custom returning a string maps to text cell type', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'GREET',
      source: 'return "hello " + args[0]',
    })
    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: sheetIdx,
      addr: 'B1',
      formula: '=GREET("world")',
    })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.display).toBe('hello world')
    expect(b1.type).toBe('text')
  })

  test('custom returning an Excel error literal becomes that error', async () => {
    // The wrapCustomResult helper maps known error-token strings to
    // `{kind:'error'}` values — a custom-formula author can opt into
    // surfacing a specific error code by returning the canonical string.
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'FAILNA',
      source: 'return "#N/A"',
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=FAILNA()' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(true)
    expect(b1.display).toBe('#N/A')
  })
})
