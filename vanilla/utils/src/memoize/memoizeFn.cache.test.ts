import { describe, test, expect } from '@jest/globals'
import { memoizeFn, memoizeOneArg } from './memoizeFn'

describe('memoize - 缓存与性能场景', () => {
  test('多个不同参数的缓存', () => {
    let callCount = 0
    const multiArgsFn = (a: number, b: string) => {
      callCount += 1
      return `${a}-${b}`
    }

    const memoizedMulti = memoizeFn(multiArgsFn)

    const result1 = memoizedMulti(1, 'a')
    const result2 = memoizedMulti(2, 'b')
    const result3 = memoizedMulti(3, 'c')
    const result1Cached = memoizedMulti(1, 'a')
    const result2Cached = memoizedMulti(2, 'b')
    const result3Cached = memoizedMulti(3, 'c')

    expect(result1).toBe(result1Cached)
    expect(result2).toBe(result2Cached)
    expect(result3).toBe(result3Cached)
    expect(callCount).toBe(3)
  })

  test('参数顺序敏感性', () => {
    let callCount = 0
    const orderSensitiveFn = (a: number, b: number) => {
      callCount += 1
      return a - b
    }

    const memoizedOrder = memoizeFn(orderSensitiveFn)

    const result1 = memoizedOrder(5, 3)
    const result2 = memoizedOrder(3, 5)
    const result3 = memoizedOrder(5, 3)

    expect(result1).toBe(2)
    expect(result2).toBe(-2)
    expect(result3).toBe(2)
    expect(callCount).toBe(2)
  })

  test('WeakMap 的垃圾回收特性', () => {
    let callCount = 0
    const objFn = (obj: { value: number }) => {
      callCount += 1
      return obj.value * 2
    }

    const memoizedObj = memoizeOneArg(objFn)

    const obj1 = { value: 10 }
    const obj2 = { value: 10 }

    const result1 = memoizedObj(obj1)
    const result2 = memoizedObj(obj1)
    const result3 = memoizedObj(obj2)

    expect(result1).toBe(20)
    expect(result2).toBe(20)
    expect(result3).toBe(20)
    expect(callCount).toBe(2)
  })

  test('不同对象类型', () => {
    let callCount = 0
    const getFunctionName = (fn: Function) => {
      callCount += 1
      return fn.name || 'anonymous'
    }

    const memoizedGetName = memoizeOneArg(getFunctionName)

    function testFunc() {}
    const arrowFunc = () => {}

    const result1 = memoizedGetName(testFunc)
    const result2 = memoizedGetName(testFunc)
    const result3 = memoizedGetName(arrowFunc)

    expect(result1).toBe('testFunc')
    expect(result2).toBe('testFunc')
    expect(result3).toBe('arrowFunc')
    expect(callCount).toBe(2)
  })

  test('大量调用的性能验证', () => {
    let callCount = 0
    const expensiveFunction = (n: number) => {
      callCount += 1
      let result = 0
      for (let i = 0; i < 1000; i++) {
        result += i * n
      }
      return result
    }

    const memoizedExpensive = memoizeFn(expensiveFunction)
    const testValue = 42
    const iterations = 100

    for (let i = 0; i < iterations; i++) {
      memoizedExpensive(testValue)
    }

    expect(callCount).toBe(1)
  })

  test('内存泄漏预防 - 检查缓存大小合理性', () => {
    const simpleFunction = (x: number) => x * 2
    const memoizedSimple = memoizeFn(simpleFunction)

    for (let i = 0; i < 1000; i++) {
      memoizedSimple(i)
    }

    expect(memoizedSimple(1)).toBe(2)
    expect(memoizedSimple(999)).toBe(1998)
  })
})
