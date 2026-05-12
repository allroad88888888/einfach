import { describe, expect, it } from '@jest/globals'
import {
  createWorkerWorkbook,
  type CellRefWire,
  type CellSnapshotWire,
  type WorkerLike,
} from '../src/wasm-workbook-proxy'

interface FakeWorker extends WorkerLike {
  sent: unknown[]
  _emit(msg: unknown): void
  _listenerCount(): number
  _terminateCount: number
}

function makeFakeWorker(): FakeWorker {
  const listeners = new Set<(e: MessageEvent) => void>()
  const sent: unknown[] = []
  const fake: FakeWorker = {
    sent,
    _terminateCount: 0,
    postMessage(msg) {
      sent.push(msg)
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    terminate() {
      fake._terminateCount += 1
      listeners.clear()
    },
    _emit(msg) {
      const ev = { data: msg } as MessageEvent
      for (const listener of listeners) listener(ev)
    },
    _listenerCount() {
      return listeners.size
    },
  }
  return fake
}

function lastSent(fake: FakeWorker) {
  return fake.sent[fake.sent.length - 1] as { id: number; cmd: string; [key: string]: unknown }
}

function ok(fake: FakeWorker, result: unknown = true) {
  fake._emit({ id: lastSent(fake).id, ok: true, result })
}

function fail(fake: FakeWorker, code: string, message: string) {
  fake._emit({ id: lastSent(fake).id, ok: false, error: { code, message } })
}

describe('wasm-workbook-proxy (Phase 5 Track A)', () => {
  it('sends request/reply commands with workbook sheet metadata', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const promise = workbook.initWorkbook(['Sheet1', 'Sheet2'])
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'initWorkbook',
      sheets: ['Sheet1', 'Sheet2'],
    })

    ok(fake, [
      { idx: 0, name: 'Sheet1' },
      { idx: 1, name: 'Sheet2' },
    ])

    await expect(promise).resolves.toEqual([
      { idx: 0, name: 'Sheet1' },
      { idx: 1, name: 'Sheet2' },
    ])
  })

  it('keeps sheet identity in setCell/readCells payloads', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const setPromise = workbook.setCell(1, 'a1', { type: 'number', value: 42 })
    expect(lastSent(fake)).toEqual({
      id: 1,
      cmd: 'setCell',
      sheet: 1,
      addr: 'A1',
      value: { type: 'number', value: 42 },
    })
    ok(fake)
    await expect(setPromise).resolves.toBe(true)

    const readPromise = workbook.readCells([
      { sheet: 0, addr: 'a1' },
      { sheet: 1, addr: 'a1' },
    ])
    expect(lastSent(fake)).toEqual({
      id: 2,
      cmd: 'readCells',
      cells: [
        { sheet: 0, addr: 'A1' },
        { sheet: 1, addr: 'A1' },
      ],
    })
    ok(fake, [
      snapshot({ sheet: 0, addr: 'A1', display: '1' }),
      snapshot({ sheet: 1, addr: 'A1', display: '42' }),
    ])
    await expect(readPromise).resolves.toEqual([
      snapshot({ sheet: 0, addr: 'A1', display: '1' }),
      snapshot({ sheet: 1, addr: 'A1', display: '42' }),
    ])
  })

  it('returns authoritative setFormula results instead of optimistic true', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const okFormula = workbook.setFormula(0, 'B1', '=A1+1')
    expect(lastSent(fake)).toMatchObject({
      id: 1,
      cmd: 'setFormula',
      sheet: 0,
      addr: 'B1',
      formula: '=A1+1',
    })
    ok(fake, true)
    await expect(okFormula).resolves.toBe(true)

    const badFormula = workbook.setFormula(0, 'C1', '=C1+1')
    ok(fake, false)
    await expect(badFormula).resolves.toBe(false)
  })

  it('rejects RPC errors with the worker error code attached', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })

    const promise = workbook.renameSheet(9, 'Missing')
    fail(fake, 'INVALID_SHEET', 'invalid sheet index: 9')

    await expect(promise).rejects.toMatchObject({
      code: 'INVALID_SHEET',
      message: 'invalid sheet index: 9',
    })
  })

  it('dispatches dirty events only to matching sheet+addr subscribers', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const sheet1A1: CellRefWire[][] = []
    const sheet2A1: CellRefWire[][] = []

    const sub1 = workbook.subscribeCells([{ sheet: 0, addr: 'a1' }], (cells) => {
      sheet1A1.push(cells)
    })
    expect(lastSent(fake)).toMatchObject({
      id: 1,
      cmd: 'subscribeCells',
      subId: 1,
      cells: [{ sheet: 0, addr: 'A1' }],
    })
    ok(fake)
    await expect(sub1).resolves.toBe(1)

    const sub2 = workbook.subscribeCells([{ sheet: 1, addr: 'a1' }], (cells) => {
      sheet2A1.push(cells)
    })
    expect(lastSent(fake)).toMatchObject({
      id: 2,
      cmd: 'subscribeCells',
      subId: 2,
      cells: [{ sheet: 1, addr: 'A1' }],
    })
    ok(fake)
    await expect(sub2).resolves.toBe(2)

    fake._emit({ event: 'cellsDirty', cells: [{ sheet: 1, addr: 'A1' }] })

    expect(sheet1A1).toEqual([])
    expect(sheet2A1).toEqual([[{ sheet: 1, addr: 'A1' }]])
  })

  it('forwards hydrated events and normalizes addresses', () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const seen: CellSnapshotWire[][] = []
    workbook.onCellsHydrated((cells) => {
      seen.push(cells)
    })

    fake._emit({
      event: 'cellsHydrated',
      cells: [snapshot({ sheet: 1, addr: 'a1', display: '9' })],
    })

    expect(seen).toEqual([[snapshot({ sheet: 1, addr: 'A1', display: '9' })]])
  })

  it('unsubscribe removes local dispatch and sends an authoritative request', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const calls: CellRefWire[][] = []

    const subIdPromise = workbook.subscribeCells([{ sheet: 0, addr: 'A1' }], (cells) => {
      calls.push(cells)
    })
    ok(fake)
    const subId = await subIdPromise

    const unsubscribe = workbook.unsubscribeCells(subId)
    expect(lastSent(fake)).toMatchObject({
      id: 2,
      cmd: 'unsubscribeCells',
      subId,
    })
    ok(fake)
    await expect(unsubscribe).resolves.toBe(true)

    fake._emit({ event: 'cellsDirty', cells: [{ sheet: 0, addr: 'A1' }] })
    expect(calls).toEqual([])
  })

  it('dispose rejects pending requests and terminates the worker', async () => {
    const fake = makeFakeWorker()
    const workbook = createWorkerWorkbook({ workerFactory: () => fake })
    const promise = workbook.sheetList()
    expect(fake._listenerCount()).toBe(1)

    workbook.dispose()

    expect(fake._terminateCount).toBe(1)
    expect(fake._listenerCount()).toBe(0)
    await expect(promise).rejects.toThrow('worker workbook disposed')
  })
})

function snapshot(input: {
  sheet: number
  addr: string
  display: string
  type?: CellSnapshotWire['type']
  isError?: boolean
  formula?: string
}): CellSnapshotWire {
  return {
    sheet: input.sheet,
    addr: input.addr.toUpperCase(),
    display: input.display,
    type: input.type ?? 'number',
    isError: input.isError ?? false,
    formula: input.formula ?? '',
  }
}
