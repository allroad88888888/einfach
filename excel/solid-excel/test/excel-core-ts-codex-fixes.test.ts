/**
 * Regression tests for the 5 codex findings on the TS-core port:
 *
 *   P1.1  text wire round-trip must NOT re-parse the value as a formula /
 *         number / boolean / error.
 *   P1.2  a formula that evaluates to an Excel error (#N/A, #DIV/0!, ...)
 *         is a valid mutation — `setFormulaDetailed` must return ok=true.
 *   P2.1  rangeLookup over `A:A` / `A:XFD` must bound materialization.
 *   P2.2  spill targets must appear in `readSparseRange` (projection),
 *         not just in single-cell reads — but NOT in `snapshotRangeSparse`
 *         (undo/persistence snapshots feed `restoreSparse`, which would
 *         materialize the projections as literal cells; WASM no_eval
 *         parity).
 *   P2.3  moveSheet must keep contents attached to the renamed sheet name,
 *         not zip positionally against the new order.
 */
import { describe, expect, test } from '@jest/globals'

import { createWorkerRuntimeTs } from '../src-vnext/adapter/worker-runtime-ts'

interface Rpc {
  (req: Record<string, unknown>): Promise<unknown>
}

function makeRpc(): { rpc: Rpc; runtime: ReturnType<typeof createWorkerRuntimeTs> } {
  const runtime = createWorkerRuntimeTs()
  let nextId = 1
  const rpc: Rpc = async (req) => {
    const id = nextId++
    const resp = await runtime.handle({ id, ...req } as never)
    if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`)
    return resp.result
  }
  return { rpc, runtime }
}

describe('codex review fixes', () => {
  describe('P1.1 — text wire is stored verbatim', () => {
    test('"00123" keeps leading zero', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'text', value: '00123' } })
      const [a1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'A1' }],
      })) as Array<{ display: string; type: string }>
      expect(a1.display).toBe('00123')
      expect(a1.type).toBe('text')
    })

    test('"=A1" stays a string, NOT a formula', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setCell', sheet: 0, addr: 'B1', value: { type: 'text', value: '=A1' } })
      const [b1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'B1' }],
      })) as Array<{ display: string; type: string; formula: string }>
      expect(b1.display).toBe('=A1')
      expect(b1.type).toBe('text')
      expect(b1.formula).toBe('')
    })

    test('"TRUE" wired as text stays a string, NOT a boolean', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setCell', sheet: 0, addr: 'C1', value: { type: 'text', value: 'TRUE' } })
      const [c1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'C1' }],
      })) as Array<{ display: string; type: string }>
      expect(c1.display).toBe('TRUE')
      expect(c1.type).toBe('text')
    })

    test('"#N/A" wired as text stays a string, NOT an error', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setCell', sheet: 0, addr: 'D1', value: { type: 'text', value: '#N/A' } })
      const [d1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'D1' }],
      })) as Array<{ display: string; type: string; isError: boolean }>
      expect(d1.display).toBe('#N/A')
      expect(d1.type).toBe('text')
      expect(d1.isError).toBe(false)
    })
  })

  describe('P1.2 — formulas that evaluate to errors are accepted', () => {
    test('=1/0 → ok:true, displays #DIV/0!', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      const result = (await rpc({
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'A1',
        formula: '=1/0',
      })) as { ok: boolean }
      expect(result.ok).toBe(true)
      const [a1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'A1' }],
      })) as Array<{ display: string; isError: boolean }>
      expect(a1.display).toBe('#DIV/0!')
      expect(a1.isError).toBe(true)
    })

    test('=NA() → ok:true, displays #N/A', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'text', value: 'lookup miss' } })
      // VLOOKUP a value that doesn't exist returns #N/A — must still be
      // an accepted formula mutation.
      const result = (await rpc({
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'B1',
        formula: '=VLOOKUP("missing", A1:A1, 1, FALSE)',
      })) as { ok: boolean }
      expect(result.ok).toBe(true)
      const [b1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'B1' }],
      })) as Array<{ display: string }>
      expect(b1.display).toBe('#N/A')
    })

    test('cycle still rejected with FORMULA_CYCLE', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A1', formula: '=B1+1' })
      const result = (await rpc({
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'B1',
        formula: '=A1+1',
      })) as { ok: boolean; code?: string }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('FORMULA_CYCLE')
    })
  })

  describe('P2.1 — whole-column range is bounded', () => {
    test('=SUM(A:A) does not hang; aggregates sparsely', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A1', formula: '10' })
      await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A2', formula: '20' })
      const before = Date.now()
      await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'B1', formula: '=SUM(A:A)' })
      const [b1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: 'B1' }],
      })) as Array<{ display: string; isError: boolean }>
      const elapsed = Date.now() - before
      expect(elapsed).toBeLessThan(1000)
      expect(b1.isError).toBe(false)
      expect(b1.display).toBe('30')
    })
  })

  describe('P2.2 — spill targets appear in readSparseRange, never in snapshots', () => {
    test('=SEQUENCE(2,2) at A1 — projection returns 4 cells (anchor + 3 spill targets)', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'A1',
        formula: '=SEQUENCE(2, 2)',
      })
      // Hydrate the anchor so the lazy spill enumeration sees it as clean.
      await rpc({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'A1' }] })
      const projected = (await rpc({
        cmd: 'readSparseRange',
        range: { sheet: 0, startRow: 0, endRow: 4, startCol: 0, endCol: 4 },
      })) as Array<{ addr: string }>
      // Anchor A1 (formula), B1/A2/B2 (projected scalars).
      expect(projected.map((c) => c.addr).sort()).toEqual(['A1', 'A2', 'B1', 'B2'])
    })

    test('=SEQUENCE(2,2) at A1 — snapshot returns ONLY the anchor formula', async () => {
      const { rpc } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      await rpc({
        cmd: 'setFormulaDetailed',
        sheet: 0,
        addr: 'A1',
        formula: '=SEQUENCE(2, 2)',
      })
      await rpc({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'A1' }] })
      // Undo/persistence snapshots must NOT serialize spill projections as
      // literal records: restoreSparse would materialize them as real cells
      // that shadow the spill and go stale on the next anchor edit.
      const sparse = (await rpc({
        cmd: 'snapshotRangeSparse',
        range: { sheet: 0, startRow: 0, endRow: 4, startCol: 0, endCol: 4 },
      })) as Array<{ addr: string; kind: string; value: unknown }>
      expect(sparse).toHaveLength(1)
      expect(sparse[0].addr).toBe('A1')
      expect(sparse[0].kind).toBe('formula')
      expect(sparse[0].value).toBe('=SEQUENCE(2, 2)')
    })
  })

  describe('P2.3 — moveSheet keeps contents attached to the renamed name', () => {
    test('moving Sheet1 after Sheet2 keeps each name with its cells', async () => {
      const { rpc, runtime } = makeRpc()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2'] })
      await rpc({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'text', value: 'from-sheet1' } })
      await rpc({ cmd: 'setCell', sheet: 1, addr: 'A1', value: { type: 'text', value: 'from-sheet2' } })

      // Move Sheet1 to position 1 (after Sheet2).
      await rpc({ cmd: 'moveSheet', from: 0, to: 1 })

      // After the move, the sheet now at index 0 is Sheet2, and at index 1
      // is Sheet1. Each must still carry its OWN A1 content.
      const sheets = runtime.state().sheets
      const sheet2 = sheets.find((s) => s.name === 'Sheet2')
      const sheet1 = sheets.find((s) => s.name === 'Sheet1')
      expect(sheet2).toBeDefined()
      expect(sheet1).toBeDefined()

      const [s2a1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: sheet2!.idx, addr: 'A1' }],
      })) as Array<{ display: string }>
      const [s1a1] = (await rpc({
        cmd: 'readCells',
        cells: [{ sheet: sheet1!.idx, addr: 'A1' }],
      })) as Array<{ display: string }>

      expect(s2a1.display).toBe('from-sheet2')
      expect(s1a1.display).toBe('from-sheet1')
    })
  })
})
