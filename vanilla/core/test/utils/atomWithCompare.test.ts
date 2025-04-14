import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atomWithCompare, createStore } from '../../src'

describe('atomWithCompare', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('应该创建一个带有自定义比较函数的atom', () => {
    const countAtom = atomWithCompare(0, (prev, next) => {
      // 只有当差值大于5时才认为值发生了变化
      return Math.abs(prev - next) <= 5 ? prev : next
    })

    expect(store.getter(countAtom)).toBe(0)

    store.setter(countAtom, 3)
    expect(store.getter(countAtom)).toBe(0) // 差值小于等于5，不更新

    store.setter(countAtom, 6)
    expect(store.getter(countAtom)).toBe(6) // 差值大于5，更新
  })

  test('应该在值变化不满足比较条件时不触发更新', () => {
    const listener = jest.fn()

    // 注意：在当前实现中，atomWithCompare 的比较函数可能与测试预期不同
    // 实际上，当前实现中的比较函数返回的是应该使用的值，而不是布尔值
    const countAtom = atomWithCompare(0, (prev, next) => {
      // 只有当差值大于5时才认为值发生了变化
      return Math.abs(prev - next) <= 5 ? prev : next
    })

    store.sub(countAtom, listener)

    // 差值小于等于5，应该使用原值，但仍然会触发订阅者
    store.setter(countAtom, 3)
    // 值没有变化 不会通知更新者
    expect(listener).toHaveBeenCalledTimes(0)
    listener.mockClear()

    // 差值大于5，应该触发更新
    store.setter(countAtom, 9)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('应该支持对象类型的atom', () => {
    const userAtom = atomWithCompare({ name: 'John', age: 30 }, (prev, next) => {
      // 只有当name变化时才认为值发生了变化
      return prev.name === next.name ? prev : next
    })

    const listener = jest.fn()
    store.sub(userAtom, listener)

    // 只更新age，应该使用原值
    store.setter(userAtom, { name: 'John', age: 31 })
    // 在值没有变化 不会通知更新者
    expect(listener).toHaveBeenCalledTimes(0)
    listener.mockClear()
    expect(store.getter(userAtom)).toEqual({ name: 'John', age: 30 }) // 值不应该更新

    // 更新name，应该触发更新
    store.setter(userAtom, { name: 'Jane', age: 31 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getter(userAtom)).toEqual({ name: 'Jane', age: 31 }) // 值应该更新
  })
})
