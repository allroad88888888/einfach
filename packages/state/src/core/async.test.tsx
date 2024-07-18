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
})
