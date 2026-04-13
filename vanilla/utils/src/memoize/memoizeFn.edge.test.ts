import { describe, test, expect } from '@jest/globals'
import { memoizeFn } from './memoizeFn'

describe('memoize - 边界情况', () => {
  test('无参数函数的记忆化', () => {
    let callCount = 0
    const noArgsFunction = () => {
      callCount += 1
      return Math.random()
    }

    const memoizedNoArgs = memoizeFn(noArgsFunction)
    const result1 = memoizedNoArgs()
    const result2 = memoizedNoArgs()

    expect(result1).toBe(result2)
    expect(callCount).toBe(1)
  })

  test('undefined 和 null 参数', () => {
    let callCount = 0
    const fnWithNullish = (a: any, b: any) => {
      callCount += 1
      return `${a}-${b}`
    }

    const memoizedFn = memoizeFn(fnWithNullish)

    const result1 = memoizedFn(null, null)
    const result2 = memoizedFn(null, null)
    const result3 = memoizedFn(undefined, undefined)
    const result4 = memoizedFn(undefined, undefined)

    expect(result1).toBe(result2)
    expect(result3).toBe(result4)
    expect(result1).not.toBe(result3)
    expect(callCount).toBe(2)
  })

  test('不同数据类型参数', () => {
    let callCount = 0
    const mixedTypesFn = (str: string, num: number, bool: boolean, obj: object) => {
      callCount += 1
      return { str, num, bool, obj }
    }

    const memoizedMixed = memoizeFn(mixedTypesFn)
    const obj = { test: true }

    const result1 = memoizedMixed('test', 123, true, obj)
    const result2 = memoizedMixed('test', 123, true, obj)
    const result3 = memoizedMixed('test', 123, false, obj)

    expect(result1).toBe(result2)
    expect(result1).not.toBe(result3)
    expect(callCount).toBe(2)
  })
})
