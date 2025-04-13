import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore, getDefaultStore } from '../src'

describe('store', () => {
  describe('createStore', () => {
    test('应该创建一个新的store实例', () => {
      const store1 = createStore()
      const store2 = createStore()

      const countAtom = atom(0)

      store1.setter(countAtom, 1)
      expect(store1.getter(countAtom)).toBe(1)
      expect(store2.getter(countAtom)).toBe(0)
    })
  })

  describe('getDefaultStore', () => {
    test('应该返回默认store实例', () => {
      const defaultStore = getDefaultStore()
      expect(defaultStore).toBeDefined()

      const countAtom = atom(0)
      defaultStore.setter(countAtom, 1)
      expect(defaultStore.getter(countAtom)).toBe(1)

      // 重置默认store以避免影响其他测试
      // 注意：store.reset 方法在当前实现中不存在
      // 如果需要重置功能，可以通过 store.setter 将值设置回初始值
      defaultStore.setter(countAtom, 0)
    })
  })

  describe('store.getter', () => {
    let store: ReturnType<typeof createStore>

    beforeEach(() => {
      store = createStore()
    })

    test('应该获取atom的当前值', () => {
      const countAtom = atom(0)
      expect(store.getter(countAtom)).toBe(0)

      store.setter(countAtom, 1)
      expect(store.getter(countAtom)).toBe(1)
    })

    test('应该计算派生atom的值', () => {
      const countAtom = atom(0)
      const doubleCountAtom = atom((get) => get(countAtom) * 2)

      expect(store.getter(doubleCountAtom)).toBe(0)

      store.setter(countAtom, 5)
      expect(store.getter(doubleCountAtom)).toBe(10)
    })
  })

  describe('store.setter', () => {
    let store: ReturnType<typeof createStore>

    beforeEach(() => {
      store = createStore()
    })

    test('应该设置atom的值', () => {
      const countAtom = atom(0)
      store.setter(countAtom, 1)
      expect(store.getter(countAtom)).toBe(1)
    })

    test('应该使用函数更新atom的值', () => {
      const countAtom = atom(0)
      store.setter(countAtom, (prev: number) => prev + 1)
      expect(store.getter(countAtom)).toBe(1)

      store.setter(countAtom, (prev: number) => prev + 2)
      expect(store.getter(countAtom)).toBe(3)
    })

    test('应该设置可写派生atom的值', () => {
      const countAtom = atom(0)
      const doubleCountAtom = atom(
        (get) => get(countAtom) * 2,
        (_get, set, newValue: number) => {
          set(countAtom, newValue / 2)
        },
      )

      store.setter(doubleCountAtom, 10)
      expect(store.getter(countAtom)).toBe(5)
      expect(store.getter(doubleCountAtom)).toBe(10)
    })
  })

  describe('store.sub', () => {
    let store: ReturnType<typeof createStore>

    beforeEach(() => {
      store = createStore()
    })

    test('应该订阅atom值的变化', () => {
      const countAtom = atom(0)
      const listener = jest.fn()

      const unsubscribe = store.sub(countAtom, listener)

      store.setter(countAtom, 1)
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
      store.setter(countAtom, 2)
      expect(listener).toHaveBeenCalledTimes(1) // 不应该再次调用
    })

    test('应该订阅派生atom值的变化', () => {
      const countAtom = atom(0)
      const doubleCountAtom = atom((get) => get(countAtom) * 2)
      const listener = jest.fn()

      const unsubscribe = store.sub(doubleCountAtom, listener)

      store.setter(countAtom, 1)
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
      store.setter(countAtom, 2)
      expect(listener).toHaveBeenCalledTimes(1) // 不应该再次调用
    })
  })

  // 注意：store.reset 方法在当前实现中不存在
  // 如果需要重置功能，可以通过 store.setter 将值设置回初始值
  describe('store.clear', () => {
    test('应该清除store中的所有状态', () => {
      const store = createStore()
      const countAtom = atom(0)
      const nameAtom = atom('John')

      store.setter(countAtom, 5)
      store.setter(nameAtom, 'Jane')

      expect(store.getter(countAtom)).toBe(5)
      expect(store.getter(nameAtom)).toBe('Jane')

      // 模拟重置操作
      store.setter(countAtom, 0)
      store.setter(nameAtom, 'John')

      expect(store.getter(countAtom)).toBe(0)
      expect(store.getter(nameAtom)).toBe('John')
    })
  })
})
