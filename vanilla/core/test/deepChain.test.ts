import { describe, test, expect } from '@jest/globals'
import { atom, createStore } from '../src'
import type { AtomEntity, Atom } from '../src'

/**
 * 深链栈安全(readAtom / dependenciesChange 迭代化)。
 *
 * 背景:纯递归实现在 Node 默认 ~1MB 调用栈下约 4000 深度抛
 * RangeError: Maximum call stack size exceeded(冷读与头写传播皆然)。
 * 迭代化后调用栈深度封顶(递归预算 256),链长只受堆内存限制。
 * 预算内(≤256)完全走原递归路径——常规 atom 图行为不变,由现有
 * 全套 jest 用例背书;本文件专测超预算的深链。
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

describe('deep chain — 迭代 readAtom / dependenciesChange', () => {
  test.each([1_000, 10_000, 100_000])('冷读 %i 深度的链返回正确值', (n) => {
    const store = createStore()
    const { tail } = buildChain(n)
    expect(store.getter(tail)).toBe(n)
  })

  test('头部写入沿 100k 链传播到尾部', () => {
    const n = 100_000
    const store = createStore()
    const { head, tail } = buildChain(n)
    expect(store.getter(tail)).toBe(n)

    store.setter(head, 11)
    expect(store.getter(tail)).toBe(n + 10)
  })

  test('直接在冷的 100k 链尾订阅(sub 挂载读)', () => {
    const n = 100_000
    const store = createStore()
    const { head, tail } = buildChain(n)

    let notified = 0
    store.sub(tail, () => {
      notified += 1
    })

    store.setter(head, 11)
    expect(notified).toBe(1)
    expect(store.getter(tail)).toBe(n + 10)
  })

  test('值不变的头部写入被剪枝,深链不通知', () => {
    const n = 10_000
    const store = createStore()
    const { head, tail } = buildChain(n)

    let notified = 0
    store.sub(tail, () => {
      notified += 1
    })

    store.setter(head, 1) // 与初值相同 — 相等短路
    expect(notified).toBe(0)
    expect(store.getter(tail)).toBe(n)
  })

  test('超预算的菱形依赖(A→[B,C],B/C 各挂深链)正确收敛', () => {
    const n = 5_000
    const store = createStore()
    const left = buildChain(n)
    const right = buildChain(n)
    const top = atom((get) => get(left.tail) + get(right.tail))

    expect(store.getter(top)).toBe(2 * n)

    store.setter(left.head, 11)
    expect(store.getter(top)).toBe(2 * n + 10)
  })

  test('深链重复冷读为缓存命中(read fn 不重跑)', () => {
    const n = 10_000
    const store = createStore()
    const counter = { tailRuns: 0 }
    const { tail: body } = buildChain(n - 1)
    const tail = atom((get) => {
      counter.tailRuns += 1
      return get(body) + 1
    })

    expect(store.getter(tail)).toBe(n)
    const runsAfterCold = counter.tailRuns
    expect(store.getter(tail)).toBe(n)
    // 完整跑完的轮数不随重复读增长(故障-重试轮不改变这一点)
    expect(counter.tailRuns).toBe(runsAfterCold)
  })

  test('写路径 self-set 语义在深链下不变', () => {
    const n = 10_000
    const store = createStore()
    const { head, tail } = buildChain(n)
    expect(store.getter(tail)).toBe(n)

    // AtomEntity(primitive)的函数式更新走 write fn 的自读
    store.setter(head as AtomEntity<number>, (cur: number) => cur + 10)
    expect(store.getter(tail)).toBe(n + 10)
  })

  test.each([255, 256, 257, 258])('预算边界 %i 深度:值正确且每个 read fn 至多跑 2 次', (n) => {
    const store = createStore()
    const counter = { runs: new Map<number, number>() }
    const head = atom(1)
    let prev: Atom<number> = head
    for (let i = 1; i < n; i += 1) {
      const p: Atom<number> = prev
      const idx = i
      prev = atom((get) => {
        counter.runs.set(idx, (counter.runs.get(idx) ?? 0) + 1)
        return get(p) + 1
      })
    }
    expect(store.getter(prev)).toBe(n)
    for (const [, runs] of counter.runs) {
      expect(runs).toBeLessThanOrEqual(2)
    }
  })
})

describe('deep chain — review 修复回归钉(2026-07-10 多agent复审)', () => {
  // F5/F17:预算内重入读(peek 自读累加器)必须命中旧实现的
  // "运行前清依赖 ⇒ 无表项 ⇒ 新鲜"怪癖,返回陈旧缓存,而非误报环。
  test('peek(self) 前值累加器与旧实现一致(不误报环)', () => {
    const store = createStore()
    const src = atom(1)
    const holder: { first: boolean } = { first: true }
    const acc: Atom<number> = atom((get) => {
      if (holder.first) {
        holder.first = false
        return get(src)
      }
      const peek = (get as unknown as { peek: (a: Atom<number>) => number }).peek
      return peek(acc) + get(src)
    })
    expect(store.getter(acc)).toBe(1)
    store.setter(src, 2)
    expect(store.getter(acc)).toBe(3)
  })

  // F10:超预算时依赖错误必须仍从消费者 getter 处抛出(read fn 可捕获),
  // 语义不得随深度翻转。
  test('IFERROR 模式:catcher 位于 256 层之下仍能捕获依赖错误', () => {
    const store = createStore()
    const boom = atom((): number => {
      throw new Error('boom')
    })
    let prev: Atom<number> = boom
    for (let i = 0; i < 40; i += 1) {
      const p: Atom<number> = prev
      prev = atom((get) => get(p) + 1)
    }
    const upper: Atom<number> = prev
    const catcher = atom((get) => {
      try {
        return get(upper) + 1
      } catch {
        return -999
      }
    })
    prev = catcher
    for (let i = 0; i < 400; i += 1) {
      const p: Atom<number> = prev
      prev = atom((get) => get(p) + 1)
    }
    expect(store.getter(prev)).toBe(-999 + 400)
  })

  // F16/F11:超预算下逐个发现依赖的合法模式(对占位值做属性访问而抛
  // TypeError)不得误报环,且必须收敛到正确值。
  test('1200 依赖扇入(对占位值抛 TypeError)在深处收敛,不误报环', () => {
    const store = createStore()
    const deps: Atom<number>[] = []
    for (let i = 0; i < 1200; i += 1) {
      const v = i + 1
      deps.push(atom(() => v))
    }
    const fan = atom((get) => {
      let sum = 0
      for (const d of deps) {
        sum += (get(d) as number).valueOf()
      }
      return sum
    })
    let prev: Atom<number> = fan
    for (let i = 0; i < 300; i += 1) {
      const p: Atom<number> = prev
      prev = atom((get) => get(p))
    }
    expect(store.getter(prev)).toBe((1200 * 1201) / 2)
  })

  // F15:故障轮快照哨兵——依赖恰好算出 undefined 不得让重访误判新鲜。
  // 触发:深帧 read fn 中途 store.setter → flush 在超预算环境深度重算 P,
  // P 的故障轮记下 undefined 依赖,该依赖真算出 undefined。
  test('依赖算出 undefined 与故障占位巧合时,提交 atom 仍会重跑(不吞更新)', () => {
    const store = createStore()
    const sw = atom(0)
    const dv = atom((): unknown => undefined)
    const probe: Atom<string> = atom((get) => {
      if (get(sw) === 0) {
        return 'A'
      }
      return get(dv) === undefined ? 'B' : 'C'
    })
    expect(store.getter(probe)).toBe('A')

    const fired = { done: false }
    const head = atom(1)
    let prev: Atom<number> = head
    for (let i = 1; i < 300; i += 1) {
      const p: Atom<number> = prev
      // 深部节点(i=20)在帧循环内、环境深度 256 处运行——它 mid-read
      // 触发的 flush 让 probe 也在超预算环境重算,get(dv) 才会故障。
      const special = i === 20
      prev = atom((get) => {
        const v = get(p)
        if (special && v !== undefined && !fired.done) {
          fired.done = true
          store.setter(sw, 1)
        }
        return v + 1
      })
    }
    expect(store.getter(prev)).toBe(300)
    expect(store.getter(probe)).toBe('B')
  })

  // F2/F3:超预算的异步 read fn 的故障轮是"僵尸轮"——其 Promise 被静默
  // 吞掉(无 unhandled rejection),迟到的 getter 不得污染已提交依赖表
  // (对未真正依赖的 atom 写入不触发重算)。
  test('异步僵尸轮:无 unhandled rejection,幽灵分支边不引发虚假重算', async () => {
    const store = createStore()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      // flag 必须是派生 atom:原始 atom 播种永不故障,只有未算好的派生
      // 依赖才让同步前缀故障、产生僵尸轮。
      const flag = atom(() => true)
      const aSrc = atom('a')
      const bSrc = atom('b')
      const runs = { count: 0 }
      const asyncLeaf: Atom<Promise<string>> = atom(async (get) => {
        runs.count += 1
        const f = get(flag) as boolean | undefined
        await Promise.resolve()
        if (f === undefined) {
          // 僵尸轮专属路径:抛错必须被丢弃轮静默吞掉(不成 unhandled)
          throw new Error('zombie-continuation')
        }
        return f ? (get(aSrc) as string) : (get(bSrc) as string)
      })
      // 幽灵边场景:僵尸轮(f===undefined)走 bSrc 分支且不抛错——这条
      // 迟到的幽灵边不得写入活表。
      const ghostRuns = { count: 0 }
      const ghostLeaf: Atom<Promise<string>> = atom(async (get) => {
        ghostRuns.count += 1
        const f = get(flag) as boolean | undefined
        await Promise.resolve()
        return f ? (get(aSrc) as string) : (get(bSrc) as string)
      })

      let prev: Atom<unknown> = asyncLeaf
      for (let i = 0; i < 300; i += 1) {
        const p: Atom<unknown> = prev
        prev = atom((get) => get(p))
      }
      const promise = store.getter(prev) as Promise<string>
      expect(await promise).toBe('a')
      expect(runs.count).toBe(2) // 僵尸轮 + 提交轮

      let ghostPrev: Atom<unknown> = ghostLeaf
      for (let i = 0; i < 300; i += 1) {
        const p: Atom<unknown> = ghostPrev
        ghostPrev = atom((get) => get(p))
      }
      const store2 = createStore()
      const ghostPromise = store2.getter(ghostPrev) as Promise<string>
      expect(await ghostPromise).toBe('a')
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      const ghostAfterCold = ghostRuns.count

      // bSrc 是幽灵分支专属依赖,真实提交值只依赖 aSrc:写它不得引发重算
      store2.setter(bSrc, 'b-new')
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      expect(ghostRuns.count).toBe(ghostAfterCold)

      // asyncLeaf 僵尸轮的 throw 必须被丢弃轮静默吞掉
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  // F6(记录性):环在任意深度抛显式错误(旧实现为栈溢出/死循环)。
  test('环抛显式 circular 错误:预算内首算环与超预算互等环', () => {
    const store = createStore()
    const pair: { a?: Atom<number>; b?: Atom<number> } = {}
    pair.a = atom((get) => get(pair.b!) + 1)
    pair.b = atom((get) => get(pair.a!) + 1)
    expect(() => store.getter(pair.a!)).toThrow(/circular dependency/)

    const store2 = createStore()
    const deep: { x?: Atom<number>; y?: Atom<number> } = {}
    deep.x = atom((get) => get(deep.y!) + 1)
    deep.y = atom((get) => get(deep.x!) + 1)
    let prev: Atom<number> = deep.x
    for (let i = 0; i < 300; i += 1) {
      const p: Atom<number> = prev
      prev = atom((get) => get(p))
    }
    expect(() => store2.getter(prev)).toThrow(/circular dependency/)
  })
})
