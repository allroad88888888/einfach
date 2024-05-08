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
    const store = createStore()
    let a = store.get(atom2)
    store.sub(atom2, () => {
      a = store.get(atom2)
    })
    store.set(atom1, {
      a: { b: 1 },
    })
    expect(a.b === 1).toBe(true)
  })
})
