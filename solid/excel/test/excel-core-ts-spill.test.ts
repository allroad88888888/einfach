/**
 * Wave E / E1 — spill projection smoke.
 * Verifies that an anchor formula returning a Value::Array
 * (`=SEQUENCE(3,2)`) projects its scalar into the empty cells around it
 * when the worker runtime is asked for those cells. The anchor itself
 * collapses to its top-left scalar at the read boundary (matches the
 * WASM core's convention so UI projection stays one-scalar-per-cell).
 */
import { describe, expect, test } from '@jest/globals'

import { createWorkerRuntimeTs } from '../src-vnext/adapter/worker-runtime-ts'

describe('excel-core-ts worker runtime — spill projection', () => {
  test('=SEQUENCE(3,2) at A1 projects 1,2,3,4,5,6 across A1:B3', async () => {
    const runtime = createWorkerRuntimeTs()
    let nextId = 1
    const rpc = async (req: Record<string, unknown>) => {
      const id = nextId++
      const resp = await runtime.handle({ id, ...req } as never)
      if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`)
      return resp.result
    }

    const sheets = (await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })) as Array<{
      idx: number
    }>
    const s = sheets[0].idx

    await rpc({ cmd: 'setFormulaDetailed', sheet: s, addr: 'A1', formula: '=SEQUENCE(3, 2)' })

    // Read the 6 cells the spill region covers.
    const cells = (await rpc({
      cmd: 'readCells',
      cells: [
        { sheet: s, addr: 'A1' },
        { sheet: s, addr: 'B1' },
        { sheet: s, addr: 'A2' },
        { sheet: s, addr: 'B2' },
        { sheet: s, addr: 'A3' },
        { sheet: s, addr: 'B3' },
      ],
    })) as Array<{ addr: string; display: string }>

    // SEQUENCE(3, 2) fills row-major starting at 1, step 1:
    // [[1,2],[3,4],[5,6]]
    expect(cells.map((c) => c.display)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  test('cell outside the spill region is still blank', async () => {
    const runtime = createWorkerRuntimeTs()
    let nextId = 1
    const rpc = async (req: Record<string, unknown>) => {
      const id = nextId++
      const resp = await runtime.handle({ id, ...req } as never)
      if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`)
      return resp.result
    }

    const sheets = (await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })) as Array<{
      idx: number
    }>
    const s = sheets[0].idx

    await rpc({ cmd: 'setFormulaDetailed', sheet: s, addr: 'A1', formula: '=SEQUENCE(2, 2)' })

    // C3 is outside the 2x2 region — must stay blank.
    const [c3] = (await rpc({
      cmd: 'readCells',
      cells: [{ sheet: s, addr: 'C3' }],
    })) as Array<{ display: string; type: string }>
    expect(c3.display).toBe('')
    expect(c3.type).toBe('null')
  })

  test('TRANSPOSE spills column → row across two cells', async () => {
    const runtime = createWorkerRuntimeTs()
    let nextId = 1
    const rpc = async (req: Record<string, unknown>) => {
      const id = nextId++
      const resp = await runtime.handle({ id, ...req } as never)
      if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`)
      return resp.result
    }

    const sheets = (await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })) as Array<{
      idx: number
    }>
    const s = sheets[0].idx

    await rpc({ cmd: 'setCell', sheet: s, addr: 'A1', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setCell', sheet: s, addr: 'A2', value: { type: 'number', value: 20 } })
    await rpc({ cmd: 'setCell', sheet: s, addr: 'A3', value: { type: 'number', value: 30 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: s, addr: 'C1', formula: '=TRANSPOSE(A1:A3)' })

    const cells = (await rpc({
      cmd: 'readCells',
      cells: [
        { sheet: s, addr: 'C1' },
        { sheet: s, addr: 'D1' },
        { sheet: s, addr: 'E1' },
      ],
    })) as Array<{ display: string }>
    expect(cells.map((c) => c.display)).toEqual(['10', '20', '30'])
  })
})
