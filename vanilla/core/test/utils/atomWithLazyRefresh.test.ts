import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore } from '../../src'
import { atomWithLazyRefresh } from '../../src/utils/atomWithLazyRefresh'
import { uninitialized } from '../../src/utils/const'

describe('atomWithLazyRefresh', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('应该创建一个只读的懒刷新 atom', () => {
    let computeCount = 0
    const lazyAtom = atomWithLazyRefresh(() => {
      computeCount++
      return 'lazy value'
    })

    // 初始未初始化
    expect(store.getter(lazyAtom)).toBe(uninitialized)

    // 刷新后才计算
    store.setter(lazyAtom)
    expect(store.getter(lazyAtom)).toBe('lazy value')
    expect(computeCount).toBe(1)

    // 再次获取不重复计算
    expect(store.getter(lazyAtom)).toBe('lazy value')
    expect(computeCount).toBe(1)
  })

  test('应该支持可写的懒刷新 atom', () => {
    let computeCount = 0
    let lastWrite: any = null
    const lazyAtom = atomWithLazyRefresh(
      () => {
        computeCount++
        return 'lazy value'
      },
      (_get: any, _set: any, value: string) => {
        lastWrite = value
        return value
      },
    )

    // 初始未初始化
    expect(store.getter(lazyAtom)).toBe(uninitialized)

    // 写入并刷新
    store.setter(lazyAtom, 'new value')
    expect(store.getter(lazyAtom)).toBe('lazy value')
    expect(computeCount).toBe(1)
    expect(lastWrite).toBe('new value')
  })

  test('懒刷新 atom 支持依赖其他 atom', () => {
    const countAtom = atom(0)
    let computeCount = 0
    const lazyAtom = atomWithLazyRefresh((get: any) => {
      computeCount++
      return get(countAtom) + 1
    })

    // 初始未初始化
    expect(store.getter(lazyAtom)).toBe(uninitialized)

    // 刷新后才计算
    store.setter(lazyAtom)
    expect(store.getter(lazyAtom)).toBe(1)
    expect(computeCount).toBe(1)

    // 依赖变化不会自动刷新
    store.setter(countAtom, 5)
    expect(store.getter(lazyAtom)).toBe(1)
    expect(computeCount).toBe(1)

    // 需要手动刷新
    store.setter(lazyAtom)
    expect(store.getter(lazyAtom)).toBe(6)
    expect(computeCount).toBe(2)
  })

  test('懒刷新 atom 未刷新时返回 uninitialized', () => {
    const lazyAtom = atomWithLazyRefresh(() => 'value')
    expect(store.getter(lazyAtom)).toBe(uninitialized)
  })

  test('懒刷新 atom 刷新多次会多次计算', () => {
    let computeCount = 0
    const lazyAtom = atomWithLazyRefresh(() => {
      computeCount++
      return 'lazy value'
    })
    expect(store.getter(lazyAtom)).toBe(uninitialized)
    store.setter(lazyAtom)
    expect(store.getter(lazyAtom)).toBe('lazy value')
    expect(computeCount).toBe(1)
    store.setter(lazyAtom)
    expect(store.getter(lazyAtom)).toBe('lazy value')
    expect(computeCount).toBe(2)
  })
})
