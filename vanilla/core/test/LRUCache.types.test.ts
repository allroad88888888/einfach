import { describe, test, expect } from '@jest/globals'
import { LRUCache } from '../src/utils/LRUCache'

describe('LRUCache - 类型与使用场景', () => {
  describe('不同类型的键和值', () => {
    test('应该支持数字键', () => {
      const cache = new LRUCache<number, string>(3)

      cache.set(1, 'one')
      cache.set(2, 'two')

      expect(cache.get(1)).toBe('one')
      expect(cache.get(2)).toBe('two')
    })

    test('应该支持对象值', () => {
      const cache = new LRUCache<string, { value: number }>(3)

      const obj1 = { value: 1 }
      const obj2 = { value: 2 }

      cache.set('a', obj1)
      cache.set('b', obj2)

      expect(cache.get('a')).toBe(obj1)
      expect(cache.get('b')).toBe(obj2)
      expect(cache.get('a')?.value).toBe(1)
    })

    test('应该能够存储 null 和 undefined 值', () => {
      const cache = new LRUCache<string, any>(5)

      cache.set('null', null)
      cache.set('zero', 0)
      cache.set('false', false)
      cache.set('empty', '')

      expect(cache.has('null')).toBe(true)
      expect(cache.get('null')).toBeNull()
      expect(cache.has('zero')).toBe(true)
      expect(cache.get('zero')).toBe(0)
      expect(cache.has('false')).toBe(true)
      expect(cache.get('false')).toBe(false)
      expect(cache.has('empty')).toBe(true)
      expect(cache.get('empty')).toBe('')
    })
  })

  describe('实际使用场景', () => {
    test('应该能够作为缓存使用', () => {
      const cache = new LRUCache<string, string>(100)
      let computeCount = 0

      function expensiveCompute(key: string): string {
        computeCount++
        return `computed-${key}`
      }

      function getCached(key: string): string {
        let value = cache.get(key)
        if (!value) {
          value = expensiveCompute(key)
          cache.set(key, value)
        }
        return value
      }

      expect(getCached('a')).toBe('computed-a')
      expect(computeCount).toBe(1)
      expect(getCached('a')).toBe('computed-a')
      expect(computeCount).toBe(1)
      expect(getCached('b')).toBe('computed-b')
      expect(computeCount).toBe(2)
    })

    test('应该能够限制内存使用', () => {
      const maxSize = 100
      const cache = new LRUCache<string, string>(maxSize)

      for (let i = 0; i < 200; i++) {
        cache.set(`key${i}`, `value${i}`)
      }

      expect(cache.size).toBe(maxSize)
      expect(cache.has('key0')).toBe(false)
      expect(cache.has('key99')).toBe(false)
      expect(cache.has('key100')).toBe(true)
      expect(cache.has('key199')).toBe(true)
    })
  })
})
