import { describe, test, expect } from '@jest/globals'
import { debouncePromise, eatPromise } from './eatPromise'

describe('promise', () => {
  test('debouncePromise', async () => {
    let num = 0
    function p1(): Promise<number> {
      return new Promise((rev) => {
        setTimeout(() => {
          num += 1
          rev(num)
        }, 300)
      })
    }
    const p2 = debouncePromise(p1, 300)
    for (let i = 0, j = 100; i < j; i++) {
      p2()
    }

    expect(p2()).resolves.toBe(1)
  })

  test('leapPromise', () => {
    let num = 0
    function p1(): Promise<number> {
      return new Promise((rev) => {
        setTimeout(() => {
          num += 1
          rev(num)
        }, 300)
      })
    }
    const p2 = eatPromise(p1)

    for (let i = 0, j = 100; i < j; i++) {
      expect(p2()).rejects.toBe('cancel')
    }

    expect(p2()).resolves.toBe(101)
  })
})
