import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore } from '../src'

describe('atom复杂场景测试 - 动态依赖', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('动态依赖测试', () => {
    test('应该处理基于条件的动态依赖', () => {
      const conditionAtom = atom(true)
      const aAtom = atom(5)
      const bAtom = atom(10)

      const dynamicAtom = atom((get) => {
        const condition = get(conditionAtom)
        return condition ? get(aAtom) : get(bAtom)
      })

      expect(store.getter(dynamicAtom)).toBe(5)

      store.setter(conditionAtom, false)
      expect(store.getter(dynamicAtom)).toBe(10)

      store.setter(bAtom, 20)
      expect(store.getter(dynamicAtom)).toBe(20)

      store.setter(conditionAtom, true)
      expect(store.getter(dynamicAtom)).toBe(5)

      store.setter(aAtom, 15)
      expect(store.getter(dynamicAtom)).toBe(15)
    })
  })
})
