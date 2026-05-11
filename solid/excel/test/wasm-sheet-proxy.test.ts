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

  // === Step 2: subscribe / unsubscribe via worker push ===

  it('subscribe posts subscribe cmd; worker push fires the callback', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    let fires = 0
    const token = sheet.subscribe('A1', () => {
      fires += 1
    })
    expect(token).toBeGreaterThan(0)
    expect(fake.sent).toContainEqual({ cmd: 'subscribe', addr: 'A1' })

    // Worker pushes a change for A1 — listener must fire exactly once.
    fake._emit({
      event: 'change',
      addr: 'A1',
      display: '42',
      type: 'number',
      isError: false,
      formula: '',
    })
    expect(fires).toBe(1)
    expect(sheet.get_display('A1')).toBe('42')
  })

  it('two listeners on the same addr only result in one worker subscribe', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    let aFires = 0
    let bFires = 0
    sheet.subscribe('A1', () => {
      aFires += 1
    })
    sheet.subscribe('A1', () => {
      bFires += 1
    })

    // Only ONE subscribe message reached the worker.
    const subMsgs = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'subscribe',
    )
    expect(subMsgs).toHaveLength(1)

    fake._emit({
      event: 'change',
      addr: 'A1',
      display: '7',
      type: 'number',
      isError: false,
      formula: '',
    })
    expect(aFires).toBe(1)
    expect(bFires).toBe(1)
  })

  it('unsubscribe drops the callback; worker unsubscribe only when last listener leaves', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    let aFires = 0
    let bFires = 0
    const tokA = sheet.subscribe('A1', () => {
      aFires += 1
    })
    const tokB = sheet.subscribe('A1', () => {
      bFires += 1
    })

    sheet.unsubscribe(tokA)
    // Removing one of two listeners must NOT send an unsubscribe to the worker.
    let unsubs = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'unsubscribe',
    )
    expect(unsubs).toHaveLength(0)

    fake._emit({
      event: 'change',
      addr: 'A1',
      display: '1',
      type: 'number',
      isError: false,
      formula: '',
    })
    expect(aFires).toBe(0)
    expect(bFires).toBe(1)

    sheet.unsubscribe(tokB)
    // Last listener gone — worker is told to drop the subscription.
    unsubs = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'unsubscribe',
    )
    expect(unsubs).toEqual([{ cmd: 'unsubscribe', addr: 'A1' }])
  })

  it('optimistic set does not fire main listeners — only worker push does', () => {
    // Contract: a `set_number` posts to the worker and updates the cache,
    // but the *callback* fires only when the worker pushes back. Otherwise
    // each write would fire twice (once optimistically, once on
    // confirmation) which would double-trigger Solid signals.
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    let fires = 0
    sheet.subscribe('A1', () => {
      fires += 1
    })
    sheet.set_number('A1', 42)
    expect(fires).toBe(0)
    // Worker eventually pushes back.
    fake._emit({
      event: 'change',
      addr: 'A1',
      display: '42',
      type: 'number',
      isError: false,
      formula: '',
    })
    expect(fires).toBe(1)
  })

  it('unsubscribe with an unknown token is a no-op', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    // Should not throw, should not post anything.
    sheet.unsubscribe(9999)
    expect(fake.sent.filter((m) => (m as { cmd: string }).cmd === 'unsubscribe')).toHaveLength(0)
  })

  // === Step 3: lazy cache hydration ===

  it('first read of an untouched addr posts read_initial', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    const got = sheet.get_display('A1')
    expect(got).toBe('') // cache miss returns empty
    expect(fake.sent).toContainEqual({ cmd: 'read_initial', addr: 'A1' })
  })

  it('read_initial fires at most once per addr across multiple reads', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.get_display('A1')
    sheet.get_type('A1')
    sheet.is_error('A1')
    sheet.get_formula('A1')
    sheet.get_number('A1')
    const initials = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'read_initial',
    )
    expect(initials).toHaveLength(1)
    expect(initials[0]).toEqual({ cmd: 'read_initial', addr: 'A1' })
  })

  it('worker push after read_initial populates the cache + future reads skip the request', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.get_display('A1')
    fake._emit({
      event: 'change',
      addr: 'A1',
      display: '99',
      type: 'number',
      isError: false,
      formula: '',
    })
    expect(sheet.get_display('A1')).toBe('99')
    // Reading again must not re-issue read_initial.
    const initials = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'read_initial',
    )
    expect(initials).toHaveLength(1)
  })

  it('subscribe marks the addr hydrated (no separate read_initial)', () => {
    // Worker auto-pushes the current value when a fresh subscribe lands,
    // so the proxy must NOT ALSO send read_initial for the same addr.
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.subscribe('A1', () => {})
    sheet.get_display('A1')
    const initials = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'read_initial',
    )
    expect(initials).toHaveLength(0)
  })

  it('local write marks the addr hydrated (no read_initial after set_number)', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.set_number('A1', 42)
    sheet.get_display('A1')
    const initials = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'read_initial',
    )
    expect(initials).toHaveLength(0)
  })

  it('structural edit clears the hydration set so reads can re-hydrate', () => {
    const fake = makeFakeWorker()
    const sheet = createWorkerSheet({ workerFactory: () => fake })
    sheet.get_display('A1')
    sheet.insert_row!(0, 1)
    sheet.get_display('A1')
    // First read pre-insert + first read post-insert = two read_initials.
    const initials = fake.sent.filter(
      (m) => (m as { cmd: string }).cmd === 'read_initial',
    )
    expect(initials).toHaveLength(2)
  })
})
