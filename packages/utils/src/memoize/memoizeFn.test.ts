import { describe, test, expect } from '@jest/globals'
import { memoizeFn, memoizeOneArg } from './memoizeFn'

interface Param {
  a: number
  b: number
}

describe('memoize', () => {
  test('memoizeFn', () => {
    const paramA: Param = {
      a: 1,
      b: 2,
    }
    let a = 0
    function demo(param: Param, param1: Param) {
      a += 1
      return param.a + param1.b
    }

    const memoizeDemo = memoizeFn(demo)
    memoizeDemo(paramA, paramA)
    memoizeDemo(paramA, paramA)

    expect(a === 1).toBe(true)
  })
  test('memoizeOneArg', () => {
    const paramA: Param = {
      a: 1,
      b: 2,
    }
    let a = 0
    function demo(param: Param) {
      a += 1
      return param.a + param.b
    }

    const memoizeDemo = memoizeOneArg(demo)
    memoizeDemo(paramA)
    memoizeDemo(paramA)

    expect(a === 1).toBe(true)
  })
})
