/**
 * Wave D smoke — verifies the postMessage dispatch in
 * `worker-runtime-ts.ts` end-to-end without actually spawning a Worker.
 * Confirms the wire protocol is wired to `@einfach/excel-core-ts` and
 * that a SUM round-trip lights up:
 *   initWorkbook → setFormula → readCells → cell carries the sum
 */
import { describe, expect, test } from '@jest/globals'

import { createWorkerRuntimeTs } from '../src-vnext/adapter/worker-runtime-ts'

interface RpcRequest {
  id: number
  cmd: string
  [key: string]: unknown
}

function makeRpc(runtime = createWorkerRuntimeTs()) {
  let nextId = 1
  const rpc = async (req: Omit<RpcRequest, 'id'>) => {
    const id = nextId++
    const resp = await runtime.handle({ id, ...req } as RpcRequest)
    if (!resp.ok) {
      throw new Error(`${resp.error.code}: ${resp.error.message}`)
    }
    return resp.result
  }
  return { runtime, rpc }
}

describe('excel-core-ts worker runtime — SUM round-trip', () => {
  test('initWorkbook + setCell + setFormula + readCells reflects SUM(B2:B4)', async () => {
    const runtime = createWorkerRuntimeTs()
    let nextId = 1
    const rpc = async (req: Omit<RpcRequest, 'id'>) => {
      const id = nextId++
      const resp = await runtime.handle({ id, ...req } as RpcRequest)
      if (!resp.ok) {
        throw new Error(`RPC ${req.cmd} failed: ${resp.error.code} ${resp.error.message}`)
      }
      return resp.result
    }

    const sheets = (await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })) as Array<{
      idx: number
      name: string
    }>
    expect(sheets).toHaveLength(1)
    const s = sheets[0].idx

    // Seed numeric column B2:B4 then a SUM at B5.
    await rpc({ cmd: 'setCell', sheet: s, addr: 'B2', value: { type: 'number', value: 10 } })
    await rpc({ cmd: 'setCell', sheet: s, addr: 'B3', value: { type: 'number', value: 20 } })
    await rpc({ cmd: 'setCell', sheet: s, addr: 'B4', value: { type: 'number', value: 30 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: s, addr: 'B5', formula: '=SUM(B2:B4)' })

    // Read back B5; it should be the sum, not a #NAME? or stale display.
    const cells = (await rpc({
      cmd: 'readCells',
      cells: [{ sheet: s, addr: 'B5' }],
    })) as Array<{ addr: string; display: string; type: string }>
    expect(cells).toHaveLength(1)
    const b5 = cells[0]
    expect(b5.addr).toBe('B5')
    expect(b5.display).toBe('60')
    expect(b5.type).toBe('number')
  })

  test('IF + UPPER chained through evaluator', async () => {
    const runtime = createWorkerRuntimeTs()
    let nextId = 1
    const rpc = async (req: Omit<RpcRequest, 'id'>) => {
      const id = nextId++
      const resp = await runtime.handle({ id, ...req } as RpcRequest)
      if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`)
      return resp.result
    }

    const sheets = (await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })) as Array<{
      idx: number
    }>
    const s = sheets[0].idx

    await rpc({ cmd: 'setCell', sheet: s, addr: 'A1', value: { type: 'number', value: 20 } })
    await rpc({
      cmd: 'setFormulaDetailed',
      sheet: s,
      addr: 'B1',
      formula: '=IF(A1>15, UPPER("high"), "low")',
    })

    const [b1] = (await rpc({
      cmd: 'readCells',
      cells: [{ sheet: s, addr: 'B1' }],
    })) as Array<{ display: string; type: string }>
    expect(b1.display).toBe('HIGH')
    expect(b1.type).toBe('text')
  })

  test('tracks viewport row heights and column widths', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    await rpc({ cmd: 'setRowHeight', sheet: 0, rowIndex: 1, heightPx: 37.6 })
    await rpc({ cmd: 'setColumnWidth', sheet: 0, colIndex: 2, widthPx: 128.4 })

    const snapshot = await rpc({
      cmd: 'snapshotViewportSizes',
      range: { sheet: 0, startRow: 0, startCol: 2, endRow: 1, endCol: 4 },
    })
    expect(snapshot).toEqual({
      sheet: 0,
      startRow: 0,
      startCol: 2,
      endRow: 1,
      endCol: 4,
      rowHeights: [{ rowIndex: 1, heightPx: 38 }],
      colWidths: [{ colIndex: 2, widthPx: 128 }],
    })

    await expect(
      rpc({ cmd: 'setRowHeight', sheet: 0, rowIndex: 1, heightPx: 0 }),
    ).rejects.toThrow('INVALID_DIMENSION_SIZE')
  })

  test('persistence v1 snapshots and restores sparse size metadata', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1', 'Sheet2'] })
    await rpc({ cmd: 'setRowHeight', sheet: 1, rowIndex: 3, heightPx: 44 })
    await rpc({ cmd: 'setColumnWidth', sheet: 1, colIndex: 2, widthPx: 128 })

    const snapshot = (await rpc({ cmd: 'snapshotPersistenceV1' })) as {
      sizes?: Array<{
        sheet: number
        rowHeights: Array<{ rowIndex: number; heightPx: number }>
        colWidths: Array<{ colIndex: number; widthPx: number }>
      }>
    }
    expect(snapshot.sizes).toEqual([
      expect.objectContaining({
        sheet: 1,
        rowHeights: [{ rowIndex: 3, heightPx: 44 }],
        colWidths: [{ colIndex: 2, widthPx: 128 }],
      }),
    ])

    const restored = makeRpc()
    await restored.rpc({ cmd: 'restorePersistenceV1', snapshot })
    const restoredSizes = await restored.rpc({
      cmd: 'snapshotViewportSizes',
      range: { sheet: 1, startRow: 0, startCol: 0, endRow: 10, endCol: 10 },
    })
    expect(restoredSizes).toEqual({
      sheet: 1,
      startRow: 0,
      startCol: 0,
      endRow: 10,
      endCol: 10,
      rowHeights: [{ rowIndex: 3, heightPx: 44 }],
      colWidths: [{ colIndex: 2, widthPx: 128 }],
    })
  })
})
