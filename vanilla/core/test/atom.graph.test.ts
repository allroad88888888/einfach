import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore } from '../src'

describe('atom复杂场景测试 - 图与缓存', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('依赖网络测试', () => {
    test('应该正确处理复杂的依赖网络', () => {
      const aAtom = atom(1)
      const bAtom = atom(2)
      const cAtom = atom(3)

      const abSumAtom = atom((get) => get(aAtom) + get(bAtom))
      const bcProductAtom = atom((get) => get(bAtom) * get(cAtom))

      const complexAtom = atom((get) => {
        const abSum = get(abSumAtom)
        const bcProduct = get(bcProductAtom)
        return abSum * bcProduct - get(aAtom)
      })

      expect(store.getter(abSumAtom)).toBe(3)
      expect(store.getter(bcProductAtom)).toBe(6)
      expect(store.getter(complexAtom)).toBe(17)

      store.setter(aAtom, 4)
      expect(store.getter(abSumAtom)).toBe(6)
      expect(store.getter(bcProductAtom)).toBe(6)
      expect(store.getter(complexAtom)).toBe(32)

      store.setter(bAtom, 5)
      expect(store.getter(abSumAtom)).toBe(9)
      expect(store.getter(bcProductAtom)).toBe(15)
      expect(store.getter(complexAtom)).toBe(131)

      store.setter(cAtom, 6)
      expect(store.getter(abSumAtom)).toBe(9)
      expect(store.getter(bcProductAtom)).toBe(30)
      expect(store.getter(complexAtom)).toBe(266)
    })

    test('应该处理循环依赖而不导致无限循环', () => {
      const countAtom = atom(1)

      interface CircularNode {
        value: number
        next?: CircularNode
      }

      const nodeAtom = atom<CircularNode>({
        value: 1,
        next: undefined,
      })

      const circularAtom = atom((get) => {
        const node = get(nodeAtom)
        const count = get(countAtom)

        if (!node.next && count > 1) {
          const updatedNode = { ...node, next: node }
          return updatedNode
        }

        return node
      })

      store.setter(countAtom, 2)

      expect(() => store.getter(circularAtom)).not.toThrow()
    })
  })

  describe('高级缓存测试', () => {
    test('应该缓存计算结果直到依赖变化', () => {
      let computeCount = 0
      const countAtom = atom(1)

      const expensiveAtom = atom((get) => {
        computeCount++
        return get(countAtom) * 10
      })

      expect(store.getter(expensiveAtom)).toBe(10)
      expect(computeCount).toBe(1)

      expect(store.getter(expensiveAtom)).toBe(10)
      expect(computeCount).toBe(1)

      store.setter(countAtom, 2)
      expect(store.getter(expensiveAtom)).toBe(20)
      expect(computeCount).toBe(2)

      for (let i = 0; i < 5; i++) {
        expect(store.getter(expensiveAtom)).toBe(20)
      }
      expect(computeCount).toBe(2)
    })
  })

  describe('大型状态树测试', () => {
    test('应该高效处理大型嵌套对象状态', () => {
      const createNestedObj = (depth: number, breadth: number, value: any): any => {
        if (depth <= 0) return value

        const result: any = {}
        for (let i = 0; i < breadth; i++) {
          result[`key${i}`] = createNestedObj(depth - 1, breadth, value)
        }
        return result
      }

      const largeNestedObj = createNestedObj(3, 3, 42)
      const largeAtom = atom(largeNestedObj)

      expect(store.getter(largeAtom)).toBe(largeNestedObj)

      const updatedObj = { ...largeNestedObj }
      updatedObj.key1 = { ...updatedObj.key1 }
      updatedObj.key1.key2 = { ...updatedObj.key1.key2 }
      updatedObj.key1.key2.key0 = 99

      store.setter(largeAtom, updatedObj)
      const result = store.getter(largeAtom)
      expect(result.key1.key2.key0).toBe(99)
    })
  })
})
