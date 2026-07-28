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

import { describe, expect, jest, test } from '@jest/globals'

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

    const codes = [
      '#NULL!',
      '#DIV/0!',
      '#N/A',
      '#REF!',
      '#VALUE!',
      '#NAME?',
      '#NUM!',
      '#CYCLE!',
      '#TYPE!',
      '#ARGS!',
      '#SPILL!',
      '#CALC!',
    ] as const
    for (const [i, code] of codes.entries()) {
      const name = `FAIL${i}`
      const addr = `A${i + 1}`
      await rpc({
        cmd: 'registerCustomFormula',
        name,
        source: `return ${JSON.stringify(code)}`,
      })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr, formula: `=${name}()` })
      const cell = await readCellDisplay(rpc, sheetIdx, addr)
      expect(cell.isError).toBe(true)
      expect(cell.display).toBe(code)
    }

    await rpc({
      cmd: 'registerCustomFormula',
      name: 'CIRCULARTEXT',
      source: 'return "#CIRCULAR!"',
    })
    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: sheetIdx,
      addr: 'B1',
      formula: '=CIRCULARTEXT()',
    })
    const circularText = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(circularText.isError).toBe(false)
    expect(circularText.display).toBe('#CIRCULAR!')
  })
})

describe('worker-runtime-ts custom formulas — wave 8.2 async', () => {
  test('isAsync register → #BUSY! while gated → settle updates cell + dependent + dirty', async () => {
    const dirtyEvents: Array<Array<{ sheet: number; addr: string }>> = []
    const runtime = createWorkerRuntimeTs({ postDirty: (cells) => dirtyEvents.push(cells) })
    const { rpc, sheetIdx } = await initSheet(runtime)
    // Gate the callback so the pending state is deterministically
    // observable — the pump runs right after every command, and an
    // ungated Promise.resolve settles before the next RPC lands.
    let release: (v: number) => void = () => undefined
    ;(globalThis as Record<string, unknown>).__tsAsyncSlowGate = new Promise<number>((resolve) => {
      release = resolve
    })
    try {
      await rpc({
        cmd: 'registerCustomFormula',
        name: 'SLOWTAX',
        source: 'return (await globalThis.__tsAsyncSlowGate) * Number(args[0])',
        isAsync: true,
      })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=SLOWTAX(100)' })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'C1', formula: '=B1+1' })

      const pending = await readCellDisplay(rpc, sheetIdx, 'B1')
      expect(pending.display).toBe('#BUSY!')
      expect(pending.isError).toBe(true)
      const pendingDep = await readCellDisplay(rpc, sheetIdx, 'C1')
      expect(pendingDep.display).toBe('#BUSY!')

      release(0.2)
      await runtime.asyncPumpIdle()

      const settled = await readCellDisplay(rpc, sheetIdx, 'B1')
      expect(settled.display).toBe('20')
      expect(settled.isError).toBe(false)
      const settledDep = await readCellDisplay(rpc, sheetIdx, 'C1')
      expect(settledDep.display).toBe('21')

      // Settle-driven dirty notification fired for the observer cell.
      expect(dirtyEvents.flat()).toEqual(
        expect.arrayContaining([expect.objectContaining({ sheet: sheetIdx, addr: 'B1' })]),
      )
    } finally {
      delete (globalThis as Record<string, unknown>).__tsAsyncSlowGate
    }
  })

  test('async callback throw settles as #VALUE!', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = createWorkerRuntimeTs()
      const { rpc, sheetIdx } = await initSheet(runtime)
      await rpc({
        cmd: 'registerCustomFormula',
        name: 'BOOM',
        source: 'throw new Error("boom")',
        isAsync: true,
      })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=BOOM()' })
      await runtime.asyncPumpIdle()
      const settled = await readCellDisplay(rpc, sheetIdx, 'B1')
      expect(settled.display).toBe('#VALUE!')
      expect(settled.isError).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('unregister while the promise is in flight strands the settle', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)
    let release: (v: number) => void = () => undefined
    ;(globalThis as Record<string, unknown>).__tsAsyncGate = new Promise<number>((resolve) => {
      release = resolve
    })
    try {
      await rpc({
        cmd: 'registerCustomFormula',
        name: 'GATED',
        source: 'return await globalThis.__tsAsyncGate',
        isAsync: true,
      })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=GATED()' })
      expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('#BUSY!')

      // Registry change while the promise is pending — the settle must
      // be dropped by the engine's generation guard.
      await rpc({ cmd: 'unregisterCustomFormula', name: 'GATED' })
      release(42)
      await runtime.asyncPumpIdle()

      // Re-apply to force a re-eval: the name is gone → #NAME?.
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=GATED()' })
      expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('#NAME?')
    } finally {
      delete (globalThis as Record<string, unknown>).__tsAsyncGate
    }
  })

  test('same-args calls memoize: callback executes once for two cells', async () => {
    (globalThis as Record<string, unknown>).__tsAsyncCallCount = 0
    try {
      const runtime = createWorkerRuntimeTs()
      const { rpc, sheetIdx } = await initSheet(runtime)
      await rpc({
        cmd: 'registerCustomFormula',
        name: 'COUNTED',
        source: 'globalThis.__tsAsyncCallCount += 1; return Number(args[0]) + 1',
        isAsync: true,
      })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=COUNTED(5)' })
      await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B2', formula: '=COUNTED(5)' })
      await readCellDisplay(rpc, sheetIdx, 'B1')
      await readCellDisplay(rpc, sheetIdx, 'B2')
      await runtime.asyncPumpIdle()
      expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('6')
      expect((await readCellDisplay(rpc, sheetIdx, 'B2')).display).toBe('6')
      expect((globalThis as Record<string, unknown>).__tsAsyncCallCount).toBe(1)
    } finally {
      delete (globalThis as Record<string, unknown>).__tsAsyncCallCount
    }
  })
})
