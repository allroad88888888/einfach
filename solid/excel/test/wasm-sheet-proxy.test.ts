import { describe, it, expect } from '@jest/globals'
import { createWorkerSheet, type WorkerLike } from '../src/wasm-sheet-proxy'

/**
 * Step 1 tests cover the proxy ↔ worker wire protocol without spinning up a
 * real Worker (jsdom can't load a `type: 'module'` worker). A fake worker
 * records postMessage payloads and exposes `_emit` to simulate the worker
 * side pushing 'change' events back.
 */

interface FakeWorker extends WorkerLike {
  sent: unknown[]
  /** Drop a message onto the main side's listeners — simulates worker push. */
  _emit(msg: unknown): void
}

function makeFakeWorker(): FakeWorker {
  const listeners = new Set<(e: MessageEvent) => void>()
  const sent: unknown[] = []
  return {
    sent,
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
      listeners.clear()
    },
    _emit(msg) {
      const ev = { data: msg } as MessageEvent
      for (const l of listeners) l(ev)
    },
  }
}

describe('wasm-sheet-proxy (7C Step 1)', () => {
  it('optimistic write-through: set_number → get_display matches same tick', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 42)
    expect(sheet.get_display('A1')).toBe('42')
    expect(sheet.get_type('A1')).toBe('number')
    expect(sheet.get_number('A1')).toBe(42)
    // The write was posted to the worker.
    expect(fake.sent).toContainEqual({ cmd: 'set_number', addr: 'A1', value: 42 })
  })

  it('set_text optimism preserves text', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_text('B2', 'hello')
    expect(sheet.get_display('B2')).toBe('hello')
    expect(sheet.get_type('B2')).toBe('text')
    expect(fake.sent).toContainEqual({ cmd: 'set_text', addr: 'B2', value: 'hello' })
  })

  it('set_boolean optimism renders TRUE / FALSE', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_boolean!('C3', true)
    expect(sheet.get_display('C3')).toBe('TRUE')
    expect(sheet.get_type('C3')).toBe('boolean')
    sheet.set_boolean!('C4', false)
    expect(sheet.get_display('C4')).toBe('FALSE')
  })

  it('set_formula records formula source; display stays empty until worker push', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 5)
    const ok = sheet.set_formula('B1', '=A1*2')
    expect(ok).toBe(true)
    expect(sheet.get_formula('B1')).toBe('=A1*2')
    // No computation on main — display empty until 'change' arrives.
    expect(sheet.get_display('B1')).toBe('')
    expect(fake.sent).toContainEqual({ cmd: 'set_formula', addr: 'B1', formula: '=A1*2' })
  })

  it('worker push (change event) updates the cache and fixes formula display', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 5)
    sheet.set_formula('B1', '=A1*2')
    // Worker computes and pushes back the real result.
    fake._emit({
      event: 'change',
      addr: 'B1',
      display: '10',
      type: 'number',
      isError: false,
      formula: '=A1*2',
    })
    expect(sheet.get_display('B1')).toBe('10')
    expect(sheet.get_type('B1')).toBe('number')
    expect(sheet.get_number('B1')).toBe(10)
    // Formula source survives.
    expect(sheet.get_formula('B1')).toBe('=A1*2')
  })

  it('worker push for an error cell sets is_error', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_formula('A1', '=1/0')
    fake._emit({
      event: 'change',
      addr: 'A1',
      display: '#DIV/0!',
      type: 'error',
      isError: true,
      formula: '=1/0',
    })
    expect(sheet.is_error('A1')).toBe(true)
    expect(sheet.get_display('A1')).toBe('#DIV/0!')
    expect(sheet.get_type('A1')).toBe('error')
  })

  it('clear_cell drops the cell from the cache', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 42)
    sheet.clear_cell('A1')
    expect(sheet.get_display('A1')).toBe('')
    expect(sheet.get_type('A1')).toBe('null')
    expect(fake.sent).toContainEqual({ cmd: 'clear_cell', addr: 'A1' })
  })

  it('structural edit invalidates the whole cache', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 1)
    sheet.set_number('A2', 2)
    sheet.insert_row!(0, 1)
    // Cache cleared — reads return empty until Step 2 hydration.
    expect(sheet.get_display('A1')).toBe('')
    expect(sheet.get_display('A2')).toBe('')
    expect(fake.sent).toContainEqual({ cmd: 'insert_row', at: 0, count: 1 })
  })

  it('get_display on an unknown address returns empty without crashing', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    expect(sheet.get_display('Z99')).toBe('')
    expect(sheet.get_type('Z99')).toBe('null')
    expect(sheet.is_error('Z99')).toBe(false)
  })

  it('non_empty_addrs returns the touched addresses (best-effort from cache)', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 1)
    sheet.set_text('B2', 'hi')
    sheet.set_formula('C3', '=A1+1')
    const got = sheet.non_empty_addrs!().sort()
    expect(got).toEqual(['A1', 'B2', 'C3'])
  })

  it('address is normalized to upper case for cache lookups', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('a1', 7)
    expect(sheet.get_display('A1')).toBe('7')
    expect(sheet.get_display('a1')).toBe('7')
  })
})
