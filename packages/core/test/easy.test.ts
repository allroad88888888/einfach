import { describe, test, expect } from '@jest/globals'
import { atom } from '../src/atom'
import { createStore } from '../src/store'

describe('store', () => {
  test('base', async () => {
    const atom1 = atom({
      a: 1,
    })

    let num = 0
    const atom2 = atom((getter) => {
      num += 1
      return {
        ...getter(atom1),
        num: num,
      }
    })

    const store = createStore()

    const res = store.getter(atom2)
    expect(res).toStrictEqual({ a: 1, num: 1 })
    store.setter(atom1, { a: 90 })

    expect(store.getter(atom2)).toStrictEqual({ a: 90, num: 2 })
  })
})
