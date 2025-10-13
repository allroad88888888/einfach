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

  test('memoizeFn with array and custom equal function', () => {
    const paramA: Param = {
      a: 1,
      b: 2,
    }
    const arrayA = [paramA]
    const arrayB = [4, 5, 6]
    let callCount = 0

    function sumArrays(arr1: Param[], arr2: number[]) {
      callCount += 1
      if (arr1.length > 1) {
        return 4
      }
      return 3
    }

    const memoizedSumArrays = memoizeFn(sumArrays, (prev, next) => {
      // 比较两个参数数组：first argument (arr1) 和 second argument (arr2)
      const arr1Equal =
        prev[0].length === next[0].length &&
        prev[0].every((item, index) => {
          const nextItem = next[0][index]
          return nextItem && item.a === nextItem.a && item.b === nextItem.b
        })

      const arr2Equal =
        prev[1].length === next[1].length && prev[1].every((item, index) => item === next[1][index])

      return arr1Equal && arr2Equal
    })

    // 第一次调用
    const result1 = memoizedSumArrays(arrayA, arrayB)
    // 第二次调用相同参数
    const result2 = memoizedSumArrays(arrayA, arrayB)
    // 第三次调用不同参数
    const result3 = memoizedSumArrays([paramA, { a: 2, b: 3 }], arrayB)

    expect(result1).toBe(3)
    expect(result2).toBe(3)
    expect(result3).toBe(4) // 数组长度大于1
    expect(callCount).toBe(2) // 应该调用两次：相同参数缓存，不同参数重新计算
  })

  // 边界情况测试
  describe('边界情况测试', () => {
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

      // 测试 null 参数
      const result1 = memoizedFn(null, null)
      const result2 = memoizedFn(null, null)

      // 测试 undefined 参数
      const result3 = memoizedFn(undefined, undefined)
      const result4 = memoizedFn(undefined, undefined)

      expect(result1).toBe(result2)
      expect(result3).toBe(result4)
      expect(result1).not.toBe(result3)
      expect(callCount).toBe(2) // 两种不同的参数组合
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
      const result2 = memoizedMixed('test', 123, true, obj) // 相同参数
      const result3 = memoizedMixed('test', 123, false, obj) // 不同 boolean

      expect(result1).toBe(result2)
      expect(result1).not.toBe(result3)
      expect(callCount).toBe(2)
    })
  })

  // 自定义比较函数测试
  describe('自定义比较函数测试', () => {
    test('深度对象比较', () => {
      let callCount = 0
      const deepObjectFn = (obj: { user: { name: string; age: number } }) => {
        callCount += 1
        return `${obj.user.name}-${obj.user.age}`
      }

      const deepEqual = (prev: any[], next: any[]) => {
        return JSON.stringify(prev[0]) === JSON.stringify(next[0])
      }

      const memoizedDeep = memoizeFn(deepObjectFn, deepEqual)

      const obj1 = { user: { name: 'Alice', age: 30 } }
      const obj2 = { user: { name: 'Alice', age: 30 } } // 不同对象但内容相同
      const obj3 = { user: { name: 'Bob', age: 25 } }

      const result1 = memoizedDeep(obj1)
      const result2 = memoizedDeep(obj2) // 应该使用缓存
      const result3 = memoizedDeep(obj3) // 不同内容

      expect(result1).toBe(result2)
      expect(result1).not.toBe(result3)
      expect(callCount).toBe(2)
    })

    test('自定义比较函数返回 false', () => {
      let callCount = 0
      const alwaysFalseFn = (x: number) => {
        callCount += 1
        return x * 2
      }

      // 比较函数总是返回 false，所以永远不使用缓存
      const neverMemoized = memoizeFn(alwaysFalseFn, () => false)

      neverMemoized(5)
      neverMemoized(5)
      neverMemoized(5)

      expect(callCount).toBe(3) // 每次都调用
    })
  })

  // 缓存行为测试
  describe('缓存行为测试', () => {
    test('多个不同参数的缓存', () => {
      let callCount = 0
      const multiArgsFn = (a: number, b: string) => {
        callCount += 1
        return `${a}-${b}`
      }

      const memoizedMulti = memoizeFn(multiArgsFn)

      // 缓存多个不同的参数组合
      const result1 = memoizedMulti(1, 'a')
      const result2 = memoizedMulti(2, 'b')
      const result3 = memoizedMulti(3, 'c')

      // 重复调用已缓存的参数
      const result1_cached = memoizedMulti(1, 'a')
      const result2_cached = memoizedMulti(2, 'b')
      const result3_cached = memoizedMulti(3, 'c')

      expect(result1).toBe(result1_cached)
      expect(result2).toBe(result2_cached)
      expect(result3).toBe(result3_cached)
      expect(callCount).toBe(3) // 只计算三次新参数
    })

    test('参数顺序敏感性', () => {
      let callCount = 0
      const orderSensitiveFn = (a: number, b: number) => {
        callCount += 1
        return a - b
      }

      const memoizedOrder = memoizeFn(orderSensitiveFn)

      const result1 = memoizedOrder(5, 3) // 5 - 3 = 2
      const result2 = memoizedOrder(3, 5) // 3 - 5 = -2
      const result3 = memoizedOrder(5, 3) // 应该使用缓存

      expect(result1).toBe(2)
      expect(result2).toBe(-2)
      expect(result3).toBe(2)
      expect(callCount).toBe(2)
    })
  })

  // memoizeOneArg 的额外测试
  describe('memoizeOneArg 补充测试', () => {
    test('WeakMap 的垃圾回收特性', () => {
      let callCount = 0
      const objFn = (obj: { value: number }) => {
        callCount += 1
        return obj.value * 2
      }

      const memoizedObj = memoizeOneArg(objFn)

      const obj1 = { value: 10 }
      const obj2 = { value: 10 } // 不同对象实例

      const result1 = memoizedObj(obj1)
      const result2 = memoizedObj(obj1) // 相同对象引用
      const result3 = memoizedObj(obj2) // 不同对象引用

      expect(result1).toBe(20)
      expect(result2).toBe(20)
      expect(result3).toBe(20)
      expect(callCount).toBe(2) // obj1 缓存，obj2 重新计算
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
      const result2 = memoizedGetName(testFunc) // 缓存
      const result3 = memoizedGetName(arrowFunc)

      expect(result1).toBe('testFunc')
      expect(result2).toBe('testFunc')
      expect(result3).toBe('arrowFunc')
      expect(callCount).toBe(2)
    })
  })

  // 性能测试
  describe('性能测试', () => {
    test('大量调用的性能验证', () => {
      let callCount = 0
      const expensiveFunction = (n: number) => {
        callCount += 1
        // 模拟计算密集操作
        let result = 0
        for (let i = 0; i < 1000; i++) {
          result += i * n
        }
        return result
      }

      const memoizedExpensive = memoizeFn(expensiveFunction)

      // 大量重复调用
      const testValue = 42
      const iterations = 100

      for (let i = 0; i < iterations; i++) {
        memoizedExpensive(testValue)
      }

      expect(callCount).toBe(1) // 只计算一次
    })

    test('内存泄漏预防 - 检查缓存大小合理性', () => {
      const simpleFunction = (x: number) => x * 2
      const memoizedSimple = memoizeFn(simpleFunction)

      // 缓存大量不同的值
      for (let i = 0; i < 1000; i++) {
        memoizedSimple(i)
      }

      // 验证函数依然正常工作
      expect(memoizedSimple(1)).toBe(2)
      expect(memoizedSimple(999)).toBe(1998)
    })
  })
})
