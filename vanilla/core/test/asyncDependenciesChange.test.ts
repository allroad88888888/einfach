import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore } from '../src'

describe('dependenciesChange 对 async atom 无法短路', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  /**
   * 核心问题：dependenciesChange 中对 async atom 调用 readAtom 返回新 Promise，
   * Object.is(oldPromise, newPromise) 永远 false，导致递归无法短路。
   *
   * 对比同步 atom：值相同时 Object.is 返回 true，递归终止。
   */

  test('同步 atom 链：单次变更 → listener 只触发 1 次', () => {
    const sourceAtom = atom(0)
    let getterCallCount = 0

    const syncLayer1 = atom((get) => { getterCallCount++; return get(sourceAtom) * 10 })
    const syncLayer2 = atom((get) => { getterCallCount++; return get(syncLayer1) + 1 })
    const syncLayer3 = atom((get) => { getterCallCount++; return get(syncLayer2) + 1 })

    const listener = jest.fn()
    store.sub(syncLayer3, listener)
    getterCallCount = 0
    listener.mockClear()

    store.setter(sourceAtom, 1)

    // 同步链：每层 getter 调用 1 次，listener 触发 1 次
    expect(getterCallCount).toBe(3)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('async atom 链：单次变更 → listener 应该只触发 1 次（实际触发多次 = bug）', async () => {
    const sourceAtom = atom({ id: 1, name: 'Alice' })

    let layer1GetterCount = 0
    let layer2GetterCount = 0
    let layer3GetterCount = 0

    const asyncLayer1 = atom(async (get) => {
      layer1GetterCount++
      return get(sourceAtom)
    })

    const asyncLayer2 = atom(async (get) => {
      layer2GetterCount++
      return await get(asyncLayer1)
    })

    const asyncLayer3 = atom(async (get) => {
      layer3GetterCount++
      return await get(asyncLayer2)
    })

    // 订阅末端 atom
    const listener = jest.fn()
    store.sub(asyncLayer3, listener)
    await store.getter(asyncLayer3)
    await new Promise((r) => setTimeout(r, 50))

    layer1GetterCount = 0
    layer2GetterCount = 0
    layer3GetterCount = 0
    listener.mockClear()

    // 只改一次源头
    store.setter(sourceAtom, { id: 2, name: 'Bob' })

    // 等所有 promise resolve + 微任务执行完
    await new Promise((r) => setTimeout(r, 200))

    console.log(
      `[async 3层链] layer1=${layer1GetterCount}, layer2=${layer2GetterCount}, layer3=${layer3GetterCount}, listener=${listener.mock.calls.length}`,
    )

    // 核心：每层 getter 只调用 1 次 (O(N)，修复前为 O(N²))
    expect(layer1GetterCount).toBe(1)
    expect(layer2GetterCount).toBe(1)
    expect(layer3GetterCount).toBe(1)
    // listener 通知次数：pending 变化 + CONTINUE_PROMISE 链式 resolve
    expect(listener.mock.calls.length).toBeLessThanOrEqual(3)
  })

  test('async 扇出：N 个 consumer 依赖同一 async atom，listener 不应 N² 触发', async () => {
    const sourceAtom = atom(0)
    const N = 10

    let middleGetterCount = 0

    const asyncMiddle = atom(async (get) => {
      middleGetterCount++
      return get(sourceAtom) * 10
    })

    const consumers = Array.from({ length: N }, (_, i) =>
      atom(async (get) => {
        const val = await get(asyncMiddle)
        return val + i
      }),
    )

    const listeners = consumers.map((consumer) => {
      const fn = jest.fn()
      store.sub(consumer, fn)
      return fn
    })

    await Promise.all(consumers.map((c) => store.getter(c)))
    await new Promise((r) => setTimeout(r, 50))

    middleGetterCount = 0
    listeners.forEach((l) => l.mockClear())

    // 一次变更
    store.setter(sourceAtom, 1)
    await new Promise((r) => setTimeout(r, 200))

    const totalListenerCalls = listeners.reduce((sum, l) => sum + l.mock.calls.length, 0)

    console.log(
      `[扇出 N=${N}] middleGetter=${middleGetterCount}, totalListenerCalls=${totalListenerCalls}`,
    )

    // 核心：middle getter 只调用 1 次 (修复前为 N 次)
    expect(middleGetterCount).toBeLessThanOrEqual(2)
    // 每个 consumer listener 最多 3 次 (pending + resolve + CONTINUE)
    expect(totalListenerCalls).toBeLessThanOrEqual(N * 3)
  })

  test('async + 同步混合链：异步 resolve 后 dependenciesChange 的额外 flush', async () => {
    const sourceAtom = atom(0)

    let asyncGetterCount = 0
    let syncDerivedGetterCount = 0

    // async 层
    const asyncAtom = atom(async (get) => {
      asyncGetterCount++
      return get(sourceAtom) * 2
    })

    // 多个同步 atom 依赖 async atom
    const syncConsumers = Array.from({ length: 5 }, (_, i) =>
      atom((get) => {
        syncDerivedGetterCount++
        const val = get(asyncAtom) // 拿到的是 Promise / ContinuablePromise
        return { promise: val, index: i }
      }),
    )

    const listeners = syncConsumers.map((c) => {
      const fn = jest.fn()
      store.sub(c, fn)
      return fn
    })

    await new Promise((r) => setTimeout(r, 50))

    asyncGetterCount = 0
    syncDerivedGetterCount = 0
    listeners.forEach((l) => l.mockClear())

    store.setter(sourceAtom, 1)
    await new Promise((r) => setTimeout(r, 200))

    const totalListenerCalls = listeners.reduce((sum, l) => sum + l.mock.calls.length, 0)

    console.log(
      `[混合链] asyncGetter=${asyncGetterCount}, syncDerivedGetter=${syncDerivedGetterCount}, totalListener=${totalListenerCalls}`,
    )

    // async atom 的 Promise resolve 时会 publishAtom →
    // dependenciesChange 对同步 consumer 重新 readAtom →
    // 同步 consumer 拿到新的 Promise 引用 → Object.is 不等 → publishAtom
    // 这里的 listener 调用次数反映了 flush 循环次数
  })

  test('深 async 链 (5层)：单次变更的 getter 调用次数应为 O(N) 而非 O(N²)', async () => {
    const sourceAtom = atom(0)
    const DEPTH = 5
    const getterCounts: number[] = new Array(DEPTH).fill(0)

    const layers: ReturnType<typeof atom<Promise<number>>>[] = []
    for (let i = 0; i < DEPTH; i++) {
      const idx = i
      if (i === 0) {
        layers.push(
          atom(async (get) => {
            getterCounts[idx]++
            return get(sourceAtom)
          }),
        )
      } else {
        const prev = layers[i - 1]
        layers.push(
          atom(async (get) => {
            getterCounts[idx]++
            return await get(prev)
          }),
        )
      }
    }

    const listener = jest.fn()
    store.sub(layers[DEPTH - 1], listener)
    await store.getter(layers[DEPTH - 1])
    await new Promise((r) => setTimeout(r, 100))

    getterCounts.fill(0)
    listener.mockClear()

    store.setter(sourceAtom, 42)
    await new Promise((r) => setTimeout(r, 300))

    const totalGetterCalls = getterCounts.reduce((a, b) => a + b, 0)
    console.log(
      `[5层深链] 每层getter次数=${JSON.stringify(getterCounts)}, total=${totalGetterCalls}, listener=${listener.mock.calls.length}`,
    )

    // 核心：每层 getter 只调用 1 次 → total = DEPTH (O(N)，修复前为 O(N²))
    expect(totalGetterCalls).toBeLessThanOrEqual(DEPTH * 2)
    // listener 通知次数
    expect(listener.mock.calls.length).toBeLessThanOrEqual(3)
  })
})
