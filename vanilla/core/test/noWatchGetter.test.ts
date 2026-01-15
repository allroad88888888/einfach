import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, getDefaultStore, createStore } from '../src'

describe('atom', () => {
  let store = getDefaultStore()

  beforeEach(() => {
    store = createStore()
  })

  describe('nowatchGetter', () => {
    test('监听atom的变化', () => {
      const aAtom = atom(0)
      const bAtom = atom((getter) => {
        return getter(aAtom) + 1
      })
      store.setter(aAtom, 10)
      expect(store.getter(bAtom)).toBe(11)
    })
    test('不监听atom的变化', () => {
      const aAtom = atom(0)

      const bAtom = atom((getter, { getter: noWatchGetter }) => {
        return noWatchGetter(aAtom) + 1
      })
      expect(store.getter(bAtom)).toBe(1)
      store.setter(aAtom, 10)
      expect(store.getter(bAtom)).toBe(1)
    })

    test('不监听atom的变化-再嵌套一层', () => {
      const aAtom = atom(0)

      const bAtom = atom((getter) => {
        return getter(aAtom) + 1
      })
      const cAtom = atom((getter, { getter: noWatchGetter }) => {
        return noWatchGetter(bAtom) + 1
      })
      expect(store.getter(cAtom)).toBe(2)
      store.setter(aAtom, 10)
      expect(store.getter(cAtom)).toBe(2)
    })
    test('不监听atom的变化-再嵌套一层-再设置一次', () => {
      const aAtom = atom(0)
      const aaAtom = atom(3)

      const bAtom = atom((getter) => {
        console.log(`render more`)
        getter(aaAtom)
        return getter(aAtom) + 1
      })
      const cAtom = atom((getter, { getter: noWatchGetter }) => {
        return noWatchGetter(bAtom) + 1
      })
      expect(store.getter(cAtom)).toBe(2)
      store.setter(aAtom, 10)
      store.setter(aaAtom, 10)
      expect(store.getter(cAtom)).toBe(2)
    })
  })
})
