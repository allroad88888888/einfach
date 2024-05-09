import { describe, test, expect } from '@jest/globals'
import { atom } from './atom'
import { createStore } from './store'

describe('store', () => {
  test('store-sub', () => {
    const atom1 = atom({ a: { b: 123 } })
    const atom2 = atom((get) => {
      const state1 = get(atom1)
      return state1.a
    })

    const atom3 = atom((get) => {
      const state2 = get(atom2)
      return state2.b + 123
    })

    const store = createStore()
    let state2 = store.getter(atom2)
    let state3 = store.getter(atom3)

    store.sub(atom2, () => {
      state2 = store.getter(atom2)
    })

    store.sub(atom3, () => {
      state3 = store.getter(atom3)
    })
    store.setter(atom1, {
      a: { b: 1 },
    })
    expect(state2.b === 1).toBe(true)
    expect(state3 === 124).toBe(true)
  })
})
