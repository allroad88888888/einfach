import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, atomWithRefresh, createStore } from '../../src'

describe('atomWithRefresh', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('应该创建一个可刷新的atom', () => {
    let computeCount = 0

    const refreshableAtom = atomWithRefresh(get => {
      computeCount++
      return 'computed value'
    })

    // 初始计算
    expect(store.getter(refreshableAtom)).toBe('computed value')
    expect(computeCount).toBe(1)

    // 再次获取，不应该重新计算
    expect(store.getter(refreshableAtom)).toBe('computed value')
    expect(computeCount).toBe(1)

    // 刷新atom，应该重新计算
    store.setter(refreshableAtom)
    expect(store.getter(refreshableAtom)).toBe('computed value')
    expect(computeCount).toBe(2)
  })

  test('值没有变化 不会通知更新者', () => {
    const refreshableAtom = atomWithRefresh(() => 'computed value')

    const listener = jest.fn()
    store.sub(refreshableAtom, listener)

    // 初始获取
    expect(store.getter(refreshableAtom)).toBe('computed value')

    // 刷新atom
    store.setter(refreshableAtom)

    // 值没有变化 不会通知更新者
    expect(listener).toHaveBeenCalledTimes(0)
  })

  test('应该支持依赖其他atom的可刷新atom', () => {
    const countAtom = atom(0)
    let computeCount = 0

    const refreshableAtom = atomWithRefresh(get => {
      computeCount++
      return get(countAtom) * 2
    })

    // 初始计算
    expect(store.getter(refreshableAtom)).toBe(0)
    expect(computeCount).toBe(1)

    // 更新依赖，应该重新计算
    store.setter(countAtom, 5)
    expect(store.getter(refreshableAtom)).toBe(10)
    expect(computeCount).toBe(2)

    // 刷新atom，应该重新计算
    store.setter(refreshableAtom)
    expect(store.getter(refreshableAtom)).toBe(10)
    expect(computeCount).toBe(3)
  })


})
