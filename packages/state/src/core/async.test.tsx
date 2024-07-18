import { describe, test, expect } from '@jest/globals'
import { atom } from './atom'
import { createStore } from './store'

describe('async', () => {
  test('base', async () => {
    let runNum = 0
    const atom1 = atom(async function () {
      runNum += 1
      return 100
    })
    const store = createStore()

    let render = 0
    store.sub(atom1, function () {
      render += 1
    })
    const state2 = store.getter(atom1)
    await state2
    expect(state2.value).toBe(100)
    expect(runNum).toBe(1)
    expect(render).toBe(1)
  })

  test('more', async () => {
    const atom1 = atom(1)
    let render = 0
    const atom2 = atom((getter, { signal }) => {
      return new Promise((rev) => {
        const val = getter(atom1)
        const t = setTimeout(() => {
          render += 1
          rev(val)
        }, 1000)
        signal.addEventListener('abort', () => {
          clearTimeout(t)
        })
      })
    })
    const store = createStore()

    const t = store.getter(atom2)
    store.setter(atom1, 3)

    await new Promise((rev) => {
      setTimeout(() => {
        rev(true)
      }, 3000)
    })
    expect(render).toBe(1)
    expect(store.getter(atom2).value).toBe(3)
    expect(t.value).toBe(3)
  })
})
