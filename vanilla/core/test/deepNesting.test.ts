import { describe, test, expect } from '@jest/globals'
import { atom, createStore } from '../src'
import type { Atom, Getter } from '../src'

/** getter.peek 运行时存在但 Getter 类型上未声明（历史遗留），测试里显式断言 */
type GetterWithPeek = Getter & { peek: Getter }

const DEPTH = 10000

function buildChain(depth: number) {
  const base = atom(0)
  let current: Atom<number> = base
  for (let i = 0; i < depth; i += 1) {
    const prev = current
    current = atom((get) => get(prev) + 1)
  }
  return { base, top: current }
}

describe('深层嵌套依赖链不爆栈', () => {
  test(`冷读取 ${DEPTH} 层派生 atom`, () => {
    const store = createStore()
    const { top } = buildChain(DEPTH)
    expect(store.getter(top)).toBe(DEPTH)
  })

  test(`set 后沿 ${DEPTH} 层链传播并通知订阅`, () => {
    const store = createStore()
    const { base, top } = buildChain(DEPTH)
    let notified = 0
    store.sub(top, () => {
      notified += 1
    })
    store.setter(base, 5)
    expect(store.getter(top)).toBe(DEPTH + 5)
    expect(notified).toBe(1)
  })

  test('深链中间值未变化时传播停止，不触发顶层订阅', () => {
    const store = createStore()
    const base = atom(10)
    // clamp 层：base 变化但输出被钳制不变
    const clamped = atom((get) => Math.min(get(base), 10))
    let current: Atom<number> = clamped
    for (let i = 0; i < DEPTH; i += 1) {
      const prev = current
      current = atom((get) => get(prev) + 1)
    }
    let notified = 0
    store.sub(current, () => {
      notified += 1
    })
    store.setter(base, 20)
    store.setter(base, 30)
    expect(notified).toBe(0)
    expect(store.getter(current)).toBe(10 + DEPTH)
  })

  test('菱形依赖：深链汇聚后只算出一致结果', () => {
    const store = createStore()
    const base = atom(1)
    let left: Atom<number> = base
    let right: Atom<number> = base
    for (let i = 0; i < DEPTH; i += 1) {
      const prevLeft = left
      left = atom((get) => get(prevLeft) + 1)
      const prevRight = right
      right = atom((get) => get(prevRight) * 1)
    }
    const leftEntity = left
    const rightEntity = right
    const merged = atom((get) => get(leftEntity) + get(rightEntity))
    expect(store.getter(merged)).toBe(DEPTH + 1 + 1)
    store.setter(base, 2)
    expect(store.getter(merged)).toBe(DEPTH + 2 + 2)
  })

  test('深链中的依赖抛错：错误抛给调用方，可被父级 read 捕获', () => {
    const store = createStore()
    const { top } = buildChain(DEPTH)
    const throwing = atom((get) => {
      get(top)
      throw new Error('boom')
    })
    const catching = atom((get) => {
      try {
        return get(throwing)
      } catch {
        return -1
      }
    })
    expect(() => store.getter(throwing)).toThrow('boom')
    expect(store.getter(catching)).toBe(-1)
  })

  test.each([249, 250, 251, 500])('递归/迭代切换临界深度 %i', (depth) => {
    const store = createStore()
    const { base, top } = buildChain(depth)
    expect(store.getter(top)).toBe(depth)
    store.setter(base, 1)
    expect(store.getter(top)).toBe(depth + 1)
  })

  test('read 内 try/catch 包住 get：深链下仍返回真实值而不是 fallback', () => {
    const store = createStore()
    const base = atom(0)
    let current: Atom<number> = base
    for (let i = 0; i < 400; i += 1) {
      const prev = current
      current = atom((get) => {
        try {
          return get(prev) + 1
        } catch {
          return -100000
        }
      })
    }
    expect(store.getter(current)).toBe(400)
  })

  test('async read 在深链中挂起：不泄漏内部信号，promise 正常 resolve', async () => {
    const store = createStore()
    const base = atom(0)
    let syncCurrent: Atom<number> = base
    for (let i = 0; i < 100; i += 1) {
      const prev = syncCurrent
      syncCurrent = atom((get) => get(prev) + 1)
    }
    const syncTop = syncCurrent
    const asyncAtom = atom(async (get) => get(syncTop) + 1)
    // 上方叠 300 层透传 atom，让 asyncAtom 处于深链挂起区内被计算
    let current: Atom<unknown> = asyncAtom
    for (let i = 0; i < 300; i += 1) {
      const prev = current
      current = atom((get) => get(prev))
    }
    await expect(store.getter(current as Atom<Promise<number>>)).resolves.toBe(101)
  })

  test('options.getter（不追踪依赖）深链不爆栈', () => {
    const store = createStore()
    const base = atom(0)
    let current: Atom<number> = base
    for (let i = 0; i < DEPTH; i += 1) {
      const prev = current
      current = atom((_get, { getter }) => getter(prev) + 1)
    }
    expect(store.getter(current)).toBe(DEPTH)
  })

  test('订阅上游的 listener 里读下游：读到收敛后的新值', () => {
    const store = createStore()
    const base = atom(0)
    const a = atom((get) => get(base) + 1)
    const b = atom((get) => get(a) + 1)
    const c = atom((get) => get(b) + 1)
    expect(store.getter(c)).toBe(3)
    const seen: number[] = []
    store.sub(base, () => {
      seen.push(store.getter(c))
    })
    store.setter(base, 10)
    expect(seen).toEqual([13])
  })

  test('深链底部抛错：错误穿过挂起区传到深处的 catch 层', () => {
    const store = createStore()
    const bad = atom((): number => {
      throw new Error('deep boom')
    })
    let current: Atom<number> = bad
    for (let i = 0; i < 200; i += 1) {
      const prev = current
      current = atom((get) => get(prev) + 1)
    }
    const beforeCatcher = current
    const catcher = atom((get) => {
      try {
        return get(beforeCatcher)
      } catch {
        return -1
      }
    })
    // 上方再叠 200 层，保证 catcher 在挂起区内执行
    current = catcher
    for (let i = 0; i < 200; i += 1) {
      const prev = current
      current = atom((get) => get(prev))
    }
    expect(store.getter(current)).toBe(-1)
    expect(() => store.getter(bad)).toThrow('deep boom')
  })

  test('getter.peek 深链不爆栈', () => {
    const store = createStore()
    const base = atom(0)
    let current: Atom<number> = base
    for (let i = 0; i < DEPTH; i += 1) {
      const prev = current
      current = atom((get) => (get as GetterWithPeek).peek(prev) + 1)
    }
    expect(store.getter(current)).toBe(DEPTH)
  })

  test('挂起区内父级捕获依赖错误并用 setter 修复后重读：拿到新值而不是缓存的旧错误', () => {
    const store = createStore()
    const flag = atom(false)
    const dep = atom((get) => {
      if (!get(flag)) {
        throw new Error('not ready')
      }
      return 42
    })
    const parent = atom((get, { setter }) => {
      try {
        return get(dep)
      } catch {
        setter(flag, true)
        return get(dep)
      }
    })
    // 上方叠 300 层透传，保证 parent 在挂起区内执行
    let current: Atom<number> = parent
    for (let i = 0; i < 300; i += 1) {
      const prev = current
      current = atom((get) => get(prev))
    }
    expect(store.getter(current)).toBe(42)
    expect(store.getter(flag)).toBe(true)
  })

  test('listener 重入写入其它 atom：嵌套 flush 正常收敛并通知', () => {
    const store = createStore()
    const base = atom(0)
    const doubled = atom((get) => get(base) * 2)
    const mirror = atom(0)
    store.sub(doubled, () => {
      store.setter(mirror, store.getter(doubled))
    })
    const seen: number[] = []
    store.sub(mirror, () => {
      seen.push(store.getter(mirror))
    })
    store.setter(base, 3)
    expect(store.getter(mirror)).toBe(6)
    expect(seen).toEqual([6])
  })

  test('深链中的 async atom：set 上游后重新传播并 resolve 新值', async () => {
    const store = createStore()
    const base = atom(0)
    let syncCurrent: Atom<number> = base
    for (let i = 0; i < 100; i += 1) {
      const prev = syncCurrent
      syncCurrent = atom((get) => get(prev) + 1)
    }
    const syncTop = syncCurrent
    const asyncAtom = atom(async (get) => get(syncTop) + 1)
    let current: Atom<unknown> = asyncAtom
    for (let i = 0; i < 300; i += 1) {
      const prev = current
      current = atom((get) => get(prev))
    }
    const top = current as Atom<Promise<number>>
    await expect(store.getter(top)).resolves.toBe(101)
    // set 后深链传播不爆栈；下游 promise 引用按 ContinuablePromise 语义保持不变，
    // 新值通过 asyncAtom 的新 promise 验证
    store.setter(base, 10)
    await expect(store.getter(asyncAtom)).resolves.toBe(111)
  })

  test('循环依赖：报明确错误而不是爆栈', () => {
    const store = createStore()
    const aRef: { current: Atom<number> | null } = { current: null }
    const b = atom((get) => get(aRef.current!) + 1)
    const a = atom((get) => get(b) + 1)
    aRef.current = a
    expect(() => store.getter(a)).toThrow(/circular/i)
  })
})
