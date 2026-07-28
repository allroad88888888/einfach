import { describe, test, expect } from '@jest/globals'
import { atom, createStore } from '../src'
import type { Atom, ReadOptions } from '../src'

/**
 * 深链迭代 store 的边界钉:对故障-重试协议的每条边逐一锁定。
 * 涉及旧实现怪癖的用例均以旧递归实现的行为为基准(parity)。
 */

function buildChain(n: number) {
  const head = atom(1)
  let prev: Atom<number> = head
  for (let i = 1; i < n; i += 1) {
    const p: Atom<number> = prev
    prev = atom((get) => get(p) + 1)
  }
  return { head, tail: prev }
}

function buildPassThrough<T>(n: number, base: Atom<T>): Atom<T> {
  let prev: Atom<T> = base
  for (let i = 0; i < n; i += 1) {
    const p: Atom<T> = prev
    prev = atom((get) => get(p) as T)
  }
  return prev
}

describe('deep chain — 边界钉', () => {
  test('B1 noWatch(options.getter)深读:值正确且不记边(头写后不被拉动)', () => {
    const store = createStore()
    const { head, tail } = buildChain(400)
    const counter = { peekerRuns: 0 }
    const peeker = atom((_get, opts: ReadOptions) => {
      counter.peekerRuns += 1
      const noWatch = opts.getter as unknown as (a: Atom<number>) => number
      return noWatch(tail) * 10
    })
    expect(store.getter(peeker)).toBe(4000)
    expect(counter.peekerRuns).toBe(1)

    store.setter(head, 11)
    expect(store.getter(tail)).toBe(410)
    // 无边:peeker 不因 head 写而重算,读到的还是缓存
    expect(counter.peekerRuns).toBe(1)
    expect(store.getter(peeker)).toBe(4000)
  })

  test('B2 故障轮批量收集:600 个未算依赖一轮收齐,fan 恰跑 2 次', () => {
    const store = createStore()
    const k = 600
    const deps: Atom<number>[] = []
    for (let i = 0; i < k; i += 1) {
      const v = i + 1
      deps.push(atom(() => v))
    }
    const counter = { fanRuns: 0 }
    const fan = atom((get) => {
      counter.fanRuns += 1
      let sum = 0
      for (const d of deps) {
        // 占位值 undefined 参与 Number 运算不抛错 → 一轮收集全部缺失
        sum += Number(get(d) ?? 0)
      }
      return sum
    })
    const tail = buildPassThrough(300, fan)
    expect(store.getter(tail)).toBe((k * (k + 1)) / 2)
    expect(counter.fanRuns).toBe(2)
  })

  test('B3 依赖抛错后的冻结语义 parity:setter 透传异常,之后读到陈旧值', () => {
    const store = createStore()
    const src = atom(0)
    const risky = atom((get) => {
      if (get(src) === 0) {
        return 'ok'
      }
      throw new Error('boom')
    })
    expect(store.getter(risky)).toBe('ok')

    // 旧实现同样:flush 中的重算异常从 setter 透传
    expect(() => store.setter(src, 1)).toThrow('boom')
    // 之后 risky 冻结在旧值(运行前清依赖 ⇒ 无表项 ⇒ 永久新鲜)
    expect(store.getter(risky)).toBe('ok')
    // 深处消费者读到的也是冻结值,不再触发异常
    const deepConsumer = buildPassThrough(300, risky)
    expect(store.getter(deepConsumer)).toBe('ok')
  })

  test('B4 同轮"故障+送达错误"跨重试轮不丢(re-record):不修会静默错值', () => {
    const store = createStore()
    const src = atom(0)
    const risky = atom((get) => {
      if (get(src) === 0) {
        return 100
      }
      throw new Error('boom')
    })
    expect(store.getter(risky)).toBe(100) // 先提交,让它带着旧状态

    const late1 = buildChain(3).tail
    const { tail: late2 } = buildChain(3)
    const state = { err: null as Error | null }
    const consumer = atom((get, opts: ReadOptions) => {
      state.err = null
      // 静默置脏 risky(writeAtomState 不 flush,避免 flush 抢先冻结它)
      const setter = opts.setter as unknown as (a: Atom<number>, v: number) => void
      setter(src, 1)
      let b: unknown
      try {
        b = get(risky)
      } catch (e) {
        state.err = e as Error
      }
      const l1 = get(late1)
      if (state.err) {
        get(late2) // 仅在收到错误的轮次才发现的新依赖 → 同轮故障+送达
        throw state.err
      }
      return `ok:${String(b)}:${l1}`
    })
    const catcher = atom((get) => {
      try {
        return String(get(consumer))
      } catch (e) {
        return `caught:${(e as Error).message}`
      }
    })
    const tail = buildPassThrough(300, catcher)
    // 无 re-record 时:重试轮 risky 已冻结为 100,消费者静默产出 ok:100:…
    expect(store.getter(tail)).toBe('caught:boom')
  })

  test('B5a 三节点环在深处抛显式 circular 错误', () => {
    const store = createStore()
    const ring: { a?: Atom<number>; b?: Atom<number>; c?: Atom<number> } = {}
    ring.a = atom((get) => get(ring.b!) + 1)
    ring.b = atom((get) => get(ring.c!) + 1)
    ring.c = atom((get) => get(ring.a!) + 1)
    const tail = buildPassThrough(300, ring.a)
    expect(() => store.getter(tail)).toThrow(/circular dependency/)
  })

  test('B5b get(self) 首算短路到 init 的旧怪癖保留(undefined+1 = NaN)', () => {
    const store = createStore()
    const selfRef: { a?: Atom<number> } = {}
    selfRef.a = atom((get) => (get(selfRef.a!) as number) + 1)
    expect(Number.isNaN(store.getter(selfRef.a))).toBe(true)
  })

  test('B6 超预算菱形:共享依赖被重复压栈无害,至多跑 2 次', () => {
    const store = createStore()
    const counter = { sharedRuns: 0 }
    const sharedBase = atom(7)
    const shared = atom((get) => {
      counter.sharedRuns += 1
      return (get(sharedBase) as number) * 2
    })
    const viaB = buildPassThrough(280, shared)
    const viaC = buildPassThrough(290, shared)
    const join = atom((get) => (get(viaB) as number) + (get(viaC) as number))
    const tail = buildPassThrough(30, join)
    expect(store.getter(tail)).toBe(28)
    expect(counter.sharedRuns).toBeLessThanOrEqual(2)
  })

  test('B7 全 undefined 值深链:占位哨兵与真 undefined 不混淆,收敛且 ≤2 次/节点', () => {
    const store = createStore()
    const runs = new Map<number, number>()
    const head = atom<undefined>(undefined)
    let prev: Atom<undefined> = head
    for (let i = 0; i < 300; i += 1) {
      const p: Atom<undefined> = prev
      const idx = i
      prev = atom((get) => {
        runs.set(idx, (runs.get(idx) ?? 0) + 1)
        return get(p) as undefined
      })
    }
    expect(store.getter(prev)).toBeUndefined()
    for (const [, c] of runs) {
      expect(c).toBeLessThanOrEqual(2)
    }
    // 二读为缓存命中
    const total = Array.from(runs.values()).reduce((a, b) => a + b, 0)
    expect(store.getter(prev)).toBeUndefined()
    expect(Array.from(runs.values()).reduce((a, b) => a + b, 0)).toBe(total)
  })

  test('B8 链中可写派生 atom:写入走自身 write fn,下游深链正确传播', () => {
    const store = createStore()
    const base = atom(1)
    const mid = atom(
      (get) => (get(base) as number) + 1,
      (_get, set, v: number) => {
        set(base, v)
      },
    )
    const { tail } = (() => {
      let prev: Atom<number> = mid
      for (let i = 0; i < 400; i += 1) {
        const p: Atom<number> = prev
        prev = atom((get) => (get(p) as number) + 1)
      }
      return { tail: prev }
    })()
    expect(store.getter(tail)).toBe(402)
    store.setter(mid as never, 10 as never)
    expect(store.getter(tail)).toBe(411)
  })

  test('B9 clear() 后深链从 init 重物化', () => {
    const store = createStore()
    const { tail } = buildChain(50_000)
    expect(store.getter(tail)).toBe(50_000)
    store.clear()
    expect(store.getter(tail)).toBe(50_000)
  })

  test('B10 双 store 共享同一批 atom 实体:深链状态互不串扰', () => {
    const s1 = createStore()
    const s2 = createStore()
    const { head, tail } = buildChain(10_000)
    expect(s1.getter(tail)).toBe(10_000)
    expect(s2.getter(tail)).toBe(10_000)

    s1.setter(head, 101)
    expect(s1.getter(tail)).toBe(10_100)
    expect(s2.getter(tail)).toBe(10_000) // s2 不受影响
  })

  test('B11 深 flush 中订阅者同步再 set:重入写在同一 flush 排水,终态一致', () => {
    const store = createStore()
    const side = atom(0)
    const { head, tail } = buildChain(50_000)
    const seen: number[] = []
    store.sub(tail, () => {
      seen.push(store.getter(tail) as number)
      if (seen.length === 1) {
        store.setter(side, 42) // 重入
      }
    })
    store.setter(head, 11)
    expect(store.getter(tail)).toBe(50_010)
    expect(store.getter(side)).toBe(42)
    expect(seen).toEqual([50_010])
  })

  test('B12 options.signal:故障轮的 controller 被 abort,提交轮的保持存活', () => {
    const store = createStore()
    const { tail: deep } = buildChain(300)
    const signals: AbortSignal[] = []
    const leaf = atom((get, opts: ReadOptions) => {
      signals.push(opts.signal)
      return (get(deep) as number) + 1
    })
    const tail = buildPassThrough(300, leaf)
    expect(store.getter(tail)).toBe(301)
    expect(signals.length).toBe(2)
    expect(signals[0].aborted).toBe(true) // 故障轮:丢弃时中止
    expect(signals[1].aborted).toBe(false) // 提交轮:存活
  })

  test('B13 peek(self) 首算抛显式 circular(记录性:旧实现为无限递归)', () => {
    const store = createStore()
    const selfPeek: { a?: Atom<number> } = {}
    selfPeek.a = atom((get) => {
      const peek = (get as unknown as { peek: (x: Atom<number>) => number }).peek
      return peek(selfPeek.a!) + 1
    })
    expect(() => store.getter(selfPeek.a!)).toThrow(/circular dependency/)
  })

  test('B15 根 read fn 异常在深读时原样向调用方传播', () => {
    const store = createStore()
    const { tail } = buildChain(300)
    const root = atom((get) => {
      get(tail)
      throw new Error('root-boom')
    })
    expect(() => store.getter(root)).toThrow('root-boom')
  })
})
