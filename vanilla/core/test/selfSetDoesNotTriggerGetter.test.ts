import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, getDefaultStore, createStore } from '../src'

describe('atom', () => {
  let store = getDefaultStore()

  beforeEach(() => {
    store = createStore()
  })

  describe('setter 自己设置自身时不应触发 getter 重算', () => {
    test('self-set 断开依赖并在依赖变更后保持设置值', () => {
      const baseAtom = atom(0)
      const derivedAtom = atom(
        (getter) => getter(baseAtom),
        (getter, setter, value: string) => {
          setter(derivedAtom, value)
        },
      )

      expect(store.getter(derivedAtom)).toBe(0)

      store.setter(derivedAtom, 'persisted')
      store.setter(baseAtom, 123)

      expect(store.getter(derivedAtom)).toBe('persisted')
    })
  })
})
