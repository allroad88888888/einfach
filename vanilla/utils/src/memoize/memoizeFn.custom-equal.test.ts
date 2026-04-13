import { describe, test, expect } from '@jest/globals'
import { memoizeFn } from './memoizeFn'

interface Param {
  a: number
  b: number
}

describe('memoize - 自定义比较函数', () => {
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

    const result1 = memoizedSumArrays(arrayA, arrayB)
    const result2 = memoizedSumArrays(arrayA, arrayB)
    const result3 = memoizedSumArrays([paramA, { a: 2, b: 3 }], arrayB)

    expect(result1).toBe(3)
    expect(result2).toBe(3)
    expect(result3).toBe(4)
    expect(callCount).toBe(2)
  })

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
    const obj2 = { user: { name: 'Alice', age: 30 } }
    const obj3 = { user: { name: 'Bob', age: 25 } }

    const result1 = memoizedDeep(obj1)
    const result2 = memoizedDeep(obj2)
    const result3 = memoizedDeep(obj3)

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

    const neverMemoized = memoizeFn(alwaysFalseFn, () => false)

    neverMemoized(5)
    neverMemoized(5)
    neverMemoized(5)

    expect(callCount).toBe(3)
  })
})
