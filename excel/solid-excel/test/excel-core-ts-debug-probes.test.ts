/**
 * Phase 1 — TS-side debug-probe parity tests.
 *
 * The Rust/WASM backend exposes two debug RPCs the e2e suite uses to
 * verify lazy evaluation:
 *   - `debugFormulaCacheState(sheet, addr)` →
 *       'dirty' | 'computing' | 'clean' | 'none' | 'invalid'
 *   - `debugFormulaEvalCount(sheet)` → number
 * The TS port wires both through `Workbook.debugFormula*` so the same
 * probe spec can run against either backend.
 *
 * ENGINE DIVERGENCE — please read before adding probe assertions.
 * The TS backend sits on core/core, which is **eager-on-mutation**:
 * any cached derive whose dep value changed re-runs synchronously
 * during the dep's setter call (`store.ts` `flushPending` →
 * `dependenciesChange`). This deviates from Rust-core, which is purely
 * lazy (a formula goes dirty on dep change and stays dirty until the
 * next read).
 *
 * Concretely this means:
 *
 *   - "Never-read" formulas behave the same on both backends: the
 *     derive isn't in core/core's cache yet, so a mutation can't
 *     auto-flush it; the probe reports `'dirty'` and `evalCount` is 0.
 *     This is the only state the bulk-import → snapshot → restore
 *     probe in `WAVE3_IMPORT_PERSISTENCE_PLAN.md` actually exercises.
 *
 *   - "Already-read" formulas behave differently: on TS-core a
 *     mutation triggers an immediate re-derive (so the probe reports
 *     `'clean'` and `evalCount` increments); on Rust-core a mutation
 *     leaves the formula `'dirty'` and `evalCount` unchanged until the
 *     next read.
 *
 * The tests below are written to reflect TS-core's actual behavior.
 * If a future refactor makes core/core lazy on mutation (e.g. by
 * skipping `flushPending` for derives with no listeners), several of
 * the "evalCount after mutate" expectations here would shift from
 * "increments immediately" to "increments only on next read."
 */
import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '@einfach/excel-core-ts'

import { createWorkerRuntimeTs } from '../src-vnext/adapter/worker-runtime-ts'

// ---------------------------------------------------------------------------
// 1. Workbook-direct contract.
// ---------------------------------------------------------------------------

describe('Workbook.debugFormulaCacheState / debugFormulaEvalCount', () => {
  test('newly-defined formula is dirty and evalCount stays at 0 until read', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1+1')
    // No read of B1 yet — the derive isn't in core/core's cache so
    // flushPending can't auto-evaluate it.
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('dirty')
    expect(wb.debugFormulaEvalCount(0)).toBe(0)
  })

  test('reading the formula flips dirty → clean and bumps evalCount', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1+1')
    const sheet = wb.sheet('s1')
    if (!sheet) throw new Error('sheet missing')
    expect(wb.store.getter(sheet.formulaCellAtom('0:1'))).toEqual({ kind: 'number', value: 11 })
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('clean')
    expect(wb.debugFormulaEvalCount(0)).toBe(1)
  })

  test('repeated reads without mutation are cache hits — evalCount stays at 1', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1+1')
    const sheet = wb.sheet('s1')
    if (!sheet) throw new Error('sheet missing')
    for (let i = 0; i < 5; i += 1) {
      wb.store.getter(sheet.formulaCellAtom('0:1'))
    }
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('clean')
    expect(wb.debugFormulaEvalCount(0)).toBe(1)
  })

  test('upstream mutation eagerly re-derives (TS-core eager-flush semantics)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1+1')
    const sheet = wb.sheet('s1')
    if (!sheet) throw new Error('sheet missing')
    expect(wb.store.getter(sheet.formulaCellAtom('0:1'))).toEqual({ kind: 'number', value: 11 })
    expect(wb.debugFormulaEvalCount(0)).toBe(1)
    // Mutate A1. core/core's flushPending re-runs B1's derive
    // SYNCHRONOUSLY during the setter — by the time setCell returns,
    // evalCount is 2 and B1 has been stamped under the new revision
    // (so the probe reports `'clean'`).
    wb.setCell('s1', 0, 0, '20')
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('clean')
    // The eager re-derive already produced the new value — the next
    // explicit read is a core/core dep-equality cache hit.
    expect(wb.store.getter(sheet.formulaCellAtom('0:1'))).toEqual({ kind: 'number', value: 21 })
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
  })

  test('cross-sheet dep: Sheet1 mutation re-derives the Sheet2 anchor', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 's2', name: 'Sheet2' },
    ])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s2', 0, 0, '=Sheet1!A1+5')
    const s2 = wb.sheet('s2')
    if (!s2) throw new Error('sheet2 missing')
    expect(wb.store.getter(s2.formulaCellAtom('0:0'))).toEqual({ kind: 'number', value: 15 })
    expect(wb.debugFormulaEvalCount(1)).toBe(1)
    // Sheet1 itself never owned a formula → counter stays at 0.
    expect(wb.debugFormulaEvalCount(0)).toBe(0)
    expect(wb.debugFormulaCacheState(1, 'A1')).toBe('clean')
    // Mutate Sheet1!A1 — Sheet2's anchor derive (cached) auto-flushes,
    // bumping Sheet2's counter. The counter belongs to the sheet that
    // OWNS the anchor formula (Sheet2), not the sheet whose data
    // changed (Sheet1).
    wb.setCell('s1', 0, 0, '100')
    expect(wb.debugFormulaEvalCount(1)).toBe(2)
    expect(wb.debugFormulaEvalCount(0)).toBe(0)
    // Sheet2!A1 is back to clean after the auto-flush.
    expect(wb.debugFormulaCacheState(1, 'A1')).toBe('clean')
  })

  test('cross-sheet, never-read: Sheet1 mutation does NOT re-derive', () => {
    // Variant of the previous test that's closer to the bulk-load
    // probe. A formula that has never been read isn't in core/core's
    // cache, so flushPending leaves it alone on upstream mutation.
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 's2', name: 'Sheet2' },
    ])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s2', 0, 0, '=Sheet1!A1+5')
    // No read of Sheet2!A1 — both counters stay at 0.
    expect(wb.debugFormulaEvalCount(0)).toBe(0)
    expect(wb.debugFormulaEvalCount(1)).toBe(0)
    expect(wb.debugFormulaCacheState(1, 'A1')).toBe('dirty')
    wb.setCell('s1', 0, 0, '100')
    // Still 0 — no derive in the cache for flushPending to wake.
    expect(wb.debugFormulaEvalCount(1)).toBe(0)
    expect(wb.debugFormulaCacheState(1, 'A1')).toBe('dirty')
  })

  test('literal-only cell reports "none" (matches Rust formula_cells.get None)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, 'hello')
    expect(wb.debugFormulaCacheState(0, 'A1')).toBe('none')
    expect(wb.debugFormulaEvalCount(0)).toBe(0)
  })

  test('empty cell reports "none"', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(wb.debugFormulaCacheState(0, 'Z9')).toBe('none')
  })

  test('blank input does NOT register as a formula cell', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '')
    expect(wb.debugFormulaCacheState(0, 'A1')).toBe('none')
  })

  test('unparseable address reports "invalid"', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(wb.debugFormulaCacheState(0, 'ZZZZ99999XXX')).toBe('invalid')
    expect(wb.debugFormulaCacheState(0, '')).toBe('invalid')
    expect(wb.debugFormulaCacheState(0, 'notAnAddr')).toBe('invalid')
  })

  test('out-of-range sheet index treated as invalid / zero', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(wb.debugFormulaCacheState(5, 'A1')).toBe('invalid')
    expect(wb.debugFormulaCacheState(-1, 'A1')).toBe('invalid')
    expect(wb.debugFormulaEvalCount(5)).toBe(0)
    expect(wb.debugFormulaEvalCount(-1)).toBe(0)
  })

  test('chained formula evaluates dependents inline within the anchor derive', () => {
    // C1 = B1+1, B1 = A1+1, A1 literal. Reading C1 produces one anchor
    // derive run; B1 is resolved by `evaluate`'s internal `resolveCell`
    // walk against the captured cells map, NOT by reading B1's atom.
    // So evalCount on Sheet1 increments by ONE per top-level read,
    // not by the depth of the dependency chain. This differs from
    // Rust, where every formula cell tracked individually contributes
    // a cache-miss bump.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1+1')
    wb.setCell('s1', 0, 2, '=B1+1')
    const sheet = wb.sheet('s1')
    if (!sheet) throw new Error('sheet missing')
    expect(wb.store.getter(sheet.formulaCellAtom('0:2'))).toEqual({ kind: 'number', value: 12 })
    expect(wb.debugFormulaEvalCount(0)).toBe(1)
    // B1 is dirty: the C1 derive never read B1's atom, only the cells
    // map directly. Its lastEvalRevision is still undefined.
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('dirty')
    expect(wb.debugFormulaCacheState(0, 'C1')).toBe('clean')
  })

  test('"computing" is observable via a custom-formula callback', () => {
    // The only host-controlled hook running during a derive is a
    // custom-formula callback. Use it to take the probe mid-eval and
    // confirm the anchor cell shows `'computing'`.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    let observed: string | undefined
    wb.registerCustomFormula('PROBE', () => {
      observed = wb.debugFormulaCacheState(0, 'A1')
      return { kind: 'number', value: 42 }
    })
    wb.setCell('s1', 0, 0, '=PROBE()')
    const sheet = wb.sheet('s1')
    if (!sheet) throw new Error('sheet missing')
    wb.store.getter(sheet.formulaCellAtom('0:0'))
    expect(observed).toBe('computing')
    // Once the derive returns, A1 is clean.
    expect(wb.debugFormulaCacheState(0, 'A1')).toBe('clean')
  })

  test('recalc dirties never-read formulas; auto-flushes cached ones', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1+1') // cached on read
    wb.setCell('s1', 0, 2, '=A1+2') // left unread
    const sheet = wb.sheet('s1')
    if (!sheet) throw new Error('sheet missing')
    // Pin B1 into the cache.
    wb.store.getter(sheet.formulaCellAtom('0:1'))
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('clean')
    expect(wb.debugFormulaCacheState(0, 'C1')).toBe('dirty')
    const evalBefore = wb.debugFormulaEvalCount(0)
    wb.recalc()
    // B1 was cached → flushPending auto-re-derives it → still clean.
    // C1 was never in the cache → recalc can't touch it → still dirty.
    expect(wb.debugFormulaCacheState(0, 'B1')).toBe('clean')
    expect(wb.debugFormulaCacheState(0, 'C1')).toBe('dirty')
    expect(wb.debugFormulaEvalCount(0)).toBe(evalBefore + 1)
  })
})

// ---------------------------------------------------------------------------
// 2. Worker RPC wiring — confirms the dispatch is correct end-to-end.
// ---------------------------------------------------------------------------

interface RpcRequest {
  id: number
  cmd: string
  [key: string]: unknown
}

function makeRpc() {
  const runtime = createWorkerRuntimeTs()
  let nextId = 1
  const rpc = async (req: Omit<RpcRequest, 'id'>) => {
    const id = nextId++
    const resp = await runtime.handle({ id, ...req } as RpcRequest)
    if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`)
    return resp.result
  }
  return { rpc, runtime }
}

describe('worker-runtime-ts: debug-probe RPC dispatch', () => {
  test('debugFormulaCacheState returns "none" for an empty sheet', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'A1' })).toBe('none')
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(0)
  })

  test('returns "invalid" for a malformed address', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'NOT_AN_ADDR' })).toBe('invalid')
  })

  test('debugFormulaCacheState delegates setFormulaDetailed state to the engine', async () => {
    // `setFormulaDetailed` reads once for cycle detection. That eager
    // atomm derive run leaves the formula clean before the host reads it.
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'B1', formula: '=A1+1' })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'B1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(1)
    await rpc({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'B1' }] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'B1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(1)
  })

  test('upstream mutation keeps an observed formula clean after eager atomm propagation', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'B1', formula: '=A1+1' })
    await rpc({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'B1' }] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'B1' })).toBe('clean')
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 99 } })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'B1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(2)
  })

  test('cross-sheet RPC dispatch reports per-sheet counters correctly', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2'] })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 1, addr: 'A1', formula: '=Sheet1!A1+5' })
    // Sheet2's anchor was evaluated (cycle check) → Sheet2's counter is 1.
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 1 })).toBe(1)
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(0)
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 100 } })
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 1 })).toBe(2)
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(0)
  })

  test('setCell (literal wire, never read) leaves evalCount at 0', async () => {
    // The bulk-load probe assertion in spirit: writing literals and
    // formulas without reading them does NOT consume any eval budget.
    // Note we use `setCell` with a text-wire formula source — that goes
    // through `setCellFromWire`, which stays text. To plant an actual
    // formula without reading it we need to use `setCell` with type
    // 'text' starting with '=' won't work (gets stored as text per the
    // P1.1 codex fix). The only paths that DO plant formulas via the
    // worker are setFormula / setFormulaDetailed, both of which read
    // for cycle detection. So the worker-side "bulk import without
    // evaluating" check defers to import sessions / `bulkApply`. Here
    // we just confirm that nothing about reading a literal triggers
    // an eval count bump.
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A2', value: { type: 'text', value: 'hi' } })
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(0)
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'A1' })).toBe('none')
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'A2' })).toBe('none')
  })

  test('debugCounters reports formulaCount and per-sheet totals', async () => {
    // Phase 3b probe: the dashboard's debugCounters payload now reports
    // real formulaCount / formulaEvalCountTotal values instead of the
    // earlier zero-stubs. Confirm the per-sheet breakdown matches the
    // workbook-direct accessors (debugFormulaCount / debugFormulaEvalCount).
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2'] })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'B1', formula: '=A1+1' })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'B2', formula: '=A1+2' })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 1, addr: 'A1', formula: '=Sheet1!A1*3' })
    const counters = (await rpc({ cmd: 'debugCounters' })) as {
      sheetCount: number
      formulaCount: number
      formulaEvalCountTotal: number
      sheets: Array<{ idx: number; formulaCount: number; formulaEvalCount: number }>
    }
    expect(counters.sheetCount).toBe(2)
    expect(counters.formulaCount).toBe(3)
    // formulaEvalCountTotal counts every derive run. setFormulaDetailed
    // reads each formula for cycle detection, AND core/core's eager
    // flush re-derives any cached formula whose dep sheetAtom identity
    // changes — so writing B2 (Sheet1) re-derives B1 too. Exact total
    // here is dominated by that flush behavior; the per-sheet aggregate
    // simply equals the sum of each sheet's counter, which is what the
    // dashboard cares about.
    expect(counters.formulaEvalCountTotal).toBe(
      counters.sheets[0].formulaEvalCount + counters.sheets[1].formulaEvalCount,
    )
    expect(counters.sheets[0].formulaCount).toBe(2)
    expect(counters.sheets[0].formulaEvalCount).toBeGreaterThanOrEqual(2)
    expect(counters.sheets[1].formulaCount).toBe(1)
    expect(counters.sheets[1].formulaEvalCount).toBe(1)
  })

  test('debugCounters formulaCount drops when a formula is cleared', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'B1', formula: '=A1+1' })
    const before = (await rpc({ cmd: 'debugCounters' })) as { formulaCount: number }
    expect(before.formulaCount).toBe(1)
    // Overwrite B1 with a literal — the cell loses its ast.
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'B1', value: { type: 'number', value: 999 } })
    const after = (await rpc({ cmd: 'debugCounters' })) as { formulaCount: number }
    expect(after.formulaCount).toBe(0)
  })
})
