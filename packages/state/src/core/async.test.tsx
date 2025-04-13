import { describe, test, expect } from '@jest/globals'
import { atom } from './atom'
import { createStore } from './store'

describe('async', () => {
  test('type', async () => {
    const atom1 = atom<any>(async function () {
      return 100
    })
    const store = createStore()

    const state2 = store.getter(atom1)

    expect(state2.a).toBe(undefined)
  })
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
    expect(render).toBe(0)
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

    const t2 = store.getter(atom2)

    await new Promise((rev) => {
      setTimeout(() => {
        rev(true)
      }, 3000)
    })
    expect(render).toBe(1)
    expect(t2.value).toBe(3)
    expect(t.value).toBe(3)
  })

  test('more antd more', async () => {
    const atom1 = atom({
      a: 1,
      b: 2,
    })

    let render2 = 0

    const atom2 = atom((getter) => {
      render2 += 1
      return getter(atom1).b
    })

    let render = 0
    const atom3 = atom((getter) => {
      render += 1
      return getter(atom2)
    })

    const store = createStore()

    store.getter(atom3)
    expect(render).toBe(1)
    expect(render2).toBe(1)
    store.setter(atom1, (state) => {
      return {
        ...state,
        b: 3,
      }
    })
    const val3 = store.getter(atom3)
    expect(val3).toBe(3)
    expect(render).toBe(2)
    expect(render2).toBe(2)
  })

  test('more and more and more', async () => {
    const atom1 = atom({
      a: 1,
      b: 2,
    })
    let render = 0
    const atom2 = atom((getter) => {
      const atom1Val = getter(atom1)
      if (atom1Val.a === 1) {
        return new Promise(() => {})
      }
      render += 1
      return Promise.resolve(atom1Val.a)
    })
    const store = createStore()
    const c = store.getter(atom2)
    expect(c.status === 'pending').toBe(true)
    expect(render).toBe(0)

    store.setter(atom1, (val) => {
      return {
        ...val,
        a: 2,
      }
    })

    await store.getter(atom2)

    expect(c.value).toBe(2)
  })
})
