import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore } from '../src'

describe('atom复杂场景测试 - 订阅通知', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('复杂订阅场景', () => {
    test('应该只在值真正改变时通知订阅者', () => {
      const dataAtom = atom({ count: 0, text: 'hello' })
      const listener = jest.fn()

      store.sub(dataAtom, listener)

      store.setter(dataAtom, { count: 0, text: 'hello' })
      expect(listener).toHaveBeenCalledTimes(1)

      const sameObj = { count: 0, text: 'hello' }
      store.setter(dataAtom, sameObj)
      store.setter(dataAtom, sameObj)
      expect(listener).toHaveBeenCalledTimes(2)

      store.setter(dataAtom, { count: 1, text: 'hello' })
      expect(listener).toHaveBeenCalledTimes(3)
    })

    test('间接依赖更新时的选择性通知', () => {
      const aAtom = atom({ value: 1 })
      const bAtom = atom({ value: 2 })

      const derivedAAtom = atom((get) => {
        const a = get(aAtom)
        return { result: a.value * 2 }
      })

      const derivedABAtom = atom((get) => {
        const a = get(aAtom)
        const b = get(bAtom)
        return { result: a.value + b.value }
      })

      const listenerA = jest.fn()
      const listenerAB = jest.fn()

      store.sub(derivedAAtom, listenerA)
      store.sub(derivedABAtom, listenerAB)

      store.setter(aAtom, { value: 3 })
      expect(listenerA).toHaveBeenCalledTimes(1)
      expect(listenerAB).toHaveBeenCalledTimes(1)

      store.setter(bAtom, { value: 4 })
      expect(listenerA).toHaveBeenCalledTimes(1)
      expect(listenerAB).toHaveBeenCalledTimes(2)
    })
  })
})
