import { describe, test, expect } from '@jest/globals'
import { atom, createStore } from '../src'
import type { Atom, AtomEntity } from '../src'

/**
 * 深链迭代 store 的性能钉。
 *
 * 原则:闭式计数(read fn 完整执行次数)做硬断言——它们在任何机器上
 * 都确定;墙钟只做宽松天花板 / 比例护栏,用来抓复杂度级别的回归
 * (线性 → 二次方),不抓常数噪声。
 */

function buildCountedChain(n: number) {
  const runs = new Map<number, number>()
  const head = atom(1)
  let prev: Atom<number> = head
  for (let i = 1; i < n; i += 1) {
    const p: Atom<number> = prev
    const idx = i
    prev = atom((get) => {
      runs.set(idx, (runs.get(idx) ?? 0) + 1)
      return get(p) + 1
    })
  }
  const totalRuns = () => {
    let sum = 0
    for (const [, c] of runs) {
      sum += c
    }
    return sum
  }
  return { head, tail: prev, runs, totalRuns }
}

describe('deep chain — 性能钉(闭式计数 + 宽松墙钟)', () => {
  test('P1 冷读近线性:100k 墙钟受 20k 比例约束,且每节点 read fn ≤2 次', () => {
    const store20 = createStore()
    const c20 = buildCountedChain(20_000)
    const t20start = performance.now()
    expect(store20.getter(c20.tail)).toBe(20_000)
    const t20 = performance.now() - t20start

    const store100 = createStore()
    const c100 = buildCountedChain(100_000)
    const t100start = performance.now()
    expect(store100.getter(c100.tail)).toBe(100_000)
    const t100 = performance.now() - t100start

    // 线性:约 5×;二次方:约 25× 起。10× + 1s 常数余量,两侧都稳。
    expect(t100).toBeLessThan(t20 * 10 + 1_000)
    for (const [, c] of c100.runs) {
      expect(c).toBeLessThanOrEqual(2)
    }
    // 故障-重试的总代价上界:2N(深链每节点至多故障一轮+提交一轮)
    expect(c100.totalRuns()).toBeLessThanOrEqual(2 * 100_000)
  })

  test('P2 头写传播恰好一遍:100k 链每个节点 delta == 1', () => {
    const store = createStore()
    const { head, tail, runs } = buildCountedChain(100_000)
    expect(store.getter(tail)).toBe(100_000)
    const before = new Map(runs)

    store.setter(head, 11)

    expect(store.getter(tail)).toBe(100_010)
    for (const [idx, c] of runs) {
      expect(c - (before.get(idx) ?? 0)).toBe(1)
    }
  })

  test('P3 缓存命中零重算:全链逐节点再读,新增运行数 == 0', () => {
    const store = createStore()
    const n = 10_000
    const nodes: Atom<number>[] = []
    const runs = new Map<number, number>()
    const head = atom(1)
    let prev: Atom<number> = head
    nodes.push(head)
    for (let i = 1; i < n; i += 1) {
      const p: Atom<number> = prev
      const idx = i
      prev = atom((get) => {
        runs.set(idx, (runs.get(idx) ?? 0) + 1)
        return get(p) + 1
      })
      nodes.push(prev)
    }
    expect(store.getter(prev)).toBe(n)
    let coldTotal = 0
    for (const [, c] of runs) {
      coldTotal += c
    }

    const sweepStart = performance.now()
    for (const node of nodes) {
      store.getter(node)
    }
    const sweepMs = performance.now() - sweepStart

    let afterTotal = 0
    for (const [, c] of runs) {
      afterTotal += c
    }
    expect(afterTotal).toBe(coldTotal)
    expect(sweepMs).toBeLessThan(3_000)
  })

  test('P4 万级扇入:冷读恰 1 次;单依赖写 → 恰 +1;其余依赖零打扰', () => {
    const store = createStore()
    const k = 10_000
    const deps: AtomEntity<number>[] = []
    for (let i = 0; i < k; i += 1) {
      deps.push(atom(i))
    }
    const counter = { fanRuns: 0 }
    const fan = atom((get) => {
      counter.fanRuns += 1
      let sum = 0
      for (const d of deps) {
        sum += get(d) as number
      }
      return sum
    })

    const coldStart = performance.now()
    expect(store.getter(fan)).toBe((k * (k - 1)) / 2)
    const coldMs = performance.now() - coldStart
    expect(counter.fanRuns).toBe(1)
    expect(coldMs).toBeLessThan(3_000)

    // 单依赖写:fan 恰好重算一次
    store.setter(deps[5_000], 1_000_000)
    expect(counter.fanRuns).toBe(2)
    expect(store.getter(fan)).toBe((k * (k - 1)) / 2 - 5_000 + 1_000_000)
    expect(counter.fanRuns).toBe(2)

    // 等值写:相等短路,零重算
    store.setter(deps[5_000], 1_000_000)
    expect(counter.fanRuns).toBe(2)
  })

  test('P5 等值头写的剪枝规模化:100k 链只有直接依赖者跑一次校验', () => {
    const store = createStore()
    const { head, tail, runs, totalRuns } = buildCountedChain(100_000)
    expect(store.getter(tail)).toBe(100_000)
    const coldTotal = totalRuns()

    const t0 = performance.now()
    store.setter(head, 1) // 与现值相同 — setAtomState 相等短路,pending 都不进
    const equalWriteMs = performance.now() - t0

    expect(totalRuns()).toBe(coldTotal)
    expect(runs.get(1)).toBe(1)
    // 200ms 在全量并行 npm test 下稳定超标(实测 229-332ms,单独跑仅个位数 ms);
    // 剪枝正确性由上面两条闭式计数钉住,墙钟只兜 O(n) 级崩坏,放宽到 1s。
    expect(equalWriteMs).toBeLessThan(1_000)

    // 真变更后再等值写:进 pending → 直接依赖者恰好复核一次即剪枝
    store.setter(head, 11)
    const afterRealWrite = totalRuns()
    const head2 = { fired: 0 }
    store.sub(tail, () => {
      head2.fired += 1
    })
    store.setter(head, 11) // 再写同值:短路,零传播
    expect(totalRuns()).toBe(afterRealWrite)
    expect(head2.fired).toBe(0)
  })
})
