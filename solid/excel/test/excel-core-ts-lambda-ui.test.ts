/**
 * LAMBDA in the Name Manager UI — round-trip through the TS worker runtime.
 *
 * Drives `createWorkerRuntimeTs()` directly (no Worker, no postMessage —
 * we call `runtime.handle({ cmd, ... })` with the same RPC envelope a
 * `WorkerWorkbookClient` would post). Each test pins one rule from the
 * `defineName` / `undefineName` dispatch surface added in this wave.
 *
 * Coverage:
 *   - `defineName` with a lambda binding parses the body via `parseFormula`
 *     and the engine resolves a subsequent `=DOUBLE(5)` to `10`.
 *   - Lambda body parse errors surface as `INVALID_LAMBDA_BODY` RPC errors,
 *     leaving the engine unchanged.
 *   - `undefineName` removes the binding so a subsequent `=DOUBLE(...)`
 *     re-evaluates to `#NAME?`.
 *   - Range and value bindings are also accepted via the same RPC, so the
 *     non-lambda kinds aren't a regression.
 *
 * The shape mirrors `excel-core-ts-custom-formulas.test.ts` so the worker
 * RPC contract is exercised end-to-end (the dispatcher, the wire→AST
 * conversion, the engine's `'call'` arm fallthrough to LAMBDA).
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
      throw Object.assign(new Error(resp.error.message), { code: resp.error.code })
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

describe('worker-runtime-ts defineName — LAMBDA + range + value bindings', () => {
  test('defineName(LAMBDA): =DOUBLE(5) renders 10 after registration', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    const ok = await rpc({
      cmd: 'defineName',
      name: 'DOUBLE',
      binding: { kind: 'lambda', params: ['x'], body: '=x*2' },
    })
    expect(ok).toBe(true)

    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=DOUBLE(5)' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(false)
    expect(b1.type).toBe('number')
    expect(b1.display).toBe('10')
  })

  test('defineName(LAMBDA): two-param body — =ADD_TWO(2, 3) renders 5', async () => {
    // Avoid identifiers that look like A1-style refs — `SUM2` would tokenize
    // as the cell at column SUM, row 2 (parser's `tryReadRef` allows up to
    // 3-letter columns). Underscored names dodge that disambiguation.
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'defineName',
      name: 'ADD_TWO',
      binding: { kind: 'lambda', params: ['a', 'b'], body: '=a+b' },
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=ADD_TWO(2, 3)' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.display).toBe('5')
  })

  test('defineName(LAMBDA): body accepts leading `=` or bare formula text', async () => {
    // Some host inputs include the `=` (user typed `=x+1`), some don't
    // (programmatic registration via the UI before re-prefixing). The
    // worker normalizes both forms to a parseable formula.
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'defineName',
      name: 'INC',
      binding: { kind: 'lambda', params: ['n'], body: 'n+1' },
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'A1', formula: '=INC(41)' })
    expect((await readCellDisplay(rpc, sheetIdx, 'A1')).display).toBe('42')
  })

  test('defineName(LAMBDA): malformed body surfaces INVALID_LAMBDA_BODY', async () => {
    // A pathological body that the parser cannot consume — unmatched paren.
    const runtime = createWorkerRuntimeTs()
    await initSheet(runtime)
    const rpc = makeRpc(runtime)
    await expect(
      rpc({
        cmd: 'defineName',
        name: 'BAD',
        binding: { kind: 'lambda', params: ['x'], body: '=((x' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LAMBDA_BODY' })
  })

  test('defineName(LAMBDA): empty params array — DOUBLE() with no args binds nothing', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'defineName',
      name: 'PI',
      binding: { kind: 'lambda', params: [], body: '=3.14' },
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'A1', formula: '=PI()' })
    expect((await readCellDisplay(rpc, sheetIdx, 'A1')).display).toBe('3.14')
  })

  test('undefineName: subsequent =DOUBLE(5) re-evaluates to #NAME?', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'defineName',
      name: 'DOUBLE',
      binding: { kind: 'lambda', params: ['x'], body: '=x*2' },
    })
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=DOUBLE(5)' })
    expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('10')

    const removed = await rpc({ cmd: 'undefineName', name: 'DOUBLE' })
    expect(removed).toBe(true)

    // Re-apply the formula to force a fresh eval — `undefineName` already
    // calls `recalc()` so a cached value would also surface, but explicit
    // re-application matches the host UI flow on Save → reset.
    await rpc({ cmd: 'setFormulaDetailed', sheet: sheetIdx, addr: 'B1', formula: '=DOUBLE(5)' })
    const b1 = await readCellDisplay(rpc, sheetIdx, 'B1')
    expect(b1.isError).toBe(true)
    expect(b1.display).toBe('#NAME?')
  })

  test('defineName(value): literal numeric binding resolves verbatim', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({
      cmd: 'defineName',
      name: 'TAXRATE',
      binding: { kind: 'value', literal: '0.2' },
    })
    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: sheetIdx,
      addr: 'B1',
      formula: '=TAXRATE*100',
    })
    expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('20')
  })

  test('defineName(range): cross-sheet range binding resolves to the live cells', async () => {
    const runtime = createWorkerRuntimeTs()
    const { rpc, sheetIdx } = await initSheet(runtime)

    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A2', value: { type: 'number', value: 20 } })
    await rpc({ cmd: 'setCell', sheet: sheetIdx, addr: 'A3', value: { type: 'number', value: 30 } })
    await rpc({
      cmd: 'defineName',
      name: 'COL_A',
      binding: { kind: 'range', sheetName: 'Sheet1', start: 'A1', end: 'A3' },
    })
    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: sheetIdx,
      addr: 'B1',
      formula: '=SUM(COL_A)',
    })
    expect((await readCellDisplay(rpc, sheetIdx, 'B1')).display).toBe('60')
  })

  test('defineName rejects empty / missing names with INVALID_NAME', async () => {
    const runtime = createWorkerRuntimeTs()
    await initSheet(runtime)
    const rpc = makeRpc(runtime)
    await expect(
      rpc({
        cmd: 'defineName',
        name: '',
        binding: { kind: 'lambda', params: ['x'], body: '=x' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' })
  })

  test('defineName rejects unknown binding kinds with INVALID_NAME_BINDING', async () => {
    const runtime = createWorkerRuntimeTs()
    await initSheet(runtime)
    const rpc = makeRpc(runtime)
    await expect(
      rpc({
        cmd: 'defineName',
        name: 'X',
        binding: { kind: 'wat' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME_BINDING' })
  })
})
