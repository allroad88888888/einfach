import { describe, test, expect } from '@jest/globals'
import { LRUCache } from '../src/utils/LRUCache'

describe('LRUCache', () => {
  describe('基本操作', () => {
    test('应该正确设置和获取值', () => {
      const cache = new LRUCache<string, number>()

      cache.set('a', 1)
      cache.set('b', 2)

      expect(cache.get('a')).toBe(1)
      expect(cache.get('b')).toBe(2)
      expect(cache.get('c')).toBeUndefined()
    })

    test('应该正确检查键是否存在', () => {
      const cache = new LRUCache<string, number>()

      cache.set('a', 1)

      expect(cache.has('a')).toBe(true)
      expect(cache.has('b')).toBe(false)
    })

    test('应该正确返回缓存大小', () => {
      const cache = new LRUCache<string, number>()

      expect(cache.size).toBe(0)

      cache.set('a', 1)
      expect(cache.size).toBe(1)

      cache.set('b', 2)
      expect(cache.size).toBe(2)
    })

    test('应该正确删除缓存项', () => {
      const cache = new LRUCache<string, number>()

      cache.set('a', 1)
      cache.set('b', 2)

      expect(cache.delete('a')).toBe(true)
      expect(cache.has('a')).toBe(false)
      expect(cache.size).toBe(1)

      expect(cache.delete('c')).toBe(false)
    })

    test('应该正确清空缓存', () => {
      const cache = new LRUCache<string, number>()

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      cache.clear()

      expect(cache.size).toBe(0)
      expect(cache.has('a')).toBe(false)
      expect(cache.has('b')).toBe(false)
      expect(cache.has('c')).toBe(false)
    })

    test('应该能够更新已存在的键', () => {
      const cache = new LRUCache<string, number>()

      cache.set('a', 1)
      expect(cache.get('a')).toBe(1)

      cache.set('a', 10)
      expect(cache.get('a')).toBe(10)
      expect(cache.size).toBe(1)
    })
  })

  describe('LRU 淘汰策略', () => {
    test('超过最大容量时应该删除最久未使用的项', () => {
      const cache = new LRUCache<string, number>(3)

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // 此时缓存已满，添加新项应该删除最旧的 'a'
      cache.set('d', 4)

      expect(cache.has('a')).toBe(false)
      expect(cache.has('b')).toBe(true)
      expect(cache.has('c')).toBe(true)
      expect(cache.has('d')).toBe(true)
      expect(cache.size).toBe(3)
    })

    test('get 操作应该更新访问顺序', () => {
      const cache = new LRUCache<string, number>(3)

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // 访问 'a'，使其成为最近使用的
      cache.get('a')

      // 添加新项，应该删除 'b'（最久未使用的）
      cache.set('d', 4)

      expect(cache.has('a')).toBe(true)
      expect(cache.has('b')).toBe(false)
      expect(cache.has('c')).toBe(true)
      expect(cache.has('d')).toBe(true)
    })

    test('set 已存在的键应该更新访问顺序', () => {
      const cache = new LRUCache<string, number>(3)

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // 更新 'a' 的值，使其成为最近使用的
      cache.set('a', 10)

      // 添加新项，应该删除 'b'（最久未使用的）
      cache.set('d', 4)

      expect(cache.has('a')).toBe(true)
      expect(cache.get('a')).toBe(10)
      expect(cache.has('b')).toBe(false)
      expect(cache.has('c')).toBe(true)
      expect(cache.has('d')).toBe(true)
    })

    test('多次访问应该正确更新 LRU 顺序', () => {
      const cache = new LRUCache<string, number>(3)

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // 访问顺序：a, b, c
      cache.get('a') // 现在顺序是：b, c, a
      cache.get('b') // 现在顺序是：c, a, b

      // 添加新项，应该删除 'c'
      cache.set('d', 4)

      expect(cache.has('a')).toBe(true)
      expect(cache.has('b')).toBe(true)
      expect(cache.has('c')).toBe(false)
      expect(cache.has('d')).toBe(true)
    })
  })

  describe('边界情况', () => {
    test('maxSize = 1 应该只保留最后一个项', () => {
      const cache = new LRUCache<string, number>(1)

      cache.set('a', 1)
      expect(cache.size).toBe(1)
      expect(cache.has('a')).toBe(true)

      cache.set('b', 2)
      expect(cache.size).toBe(1)
      expect(cache.has('a')).toBe(false)
      expect(cache.has('b')).toBe(true)
    })

    test('maxSize = 0 应该不保留任何项', () => {
      const cache = new LRUCache<string, number>(0)

      cache.set('a', 1)
      expect(cache.size).toBe(0)
      expect(cache.has('a')).toBe(false)
    })

    test('maxSize = Infinity 应该不限制缓存大小', () => {
      const cache = new LRUCache<string, number>()

      for (let i = 0; i < 1000; i++) {
        cache.set(`key${i}`, i)
      }

      expect(cache.size).toBe(1000)
      expect(cache.get('key0')).toBe(0)
      expect(cache.get('key999')).toBe(999)
    })

    test('get 不存在的键不应该影响 LRU 顺序', () => {
      const cache = new LRUCache<string, number>(2)

      cache.set('a', 1)
      cache.set('b', 2)

      cache.get('nonexistent')

      // 添加新项，应该删除 'a'（最旧的）
      cache.set('c', 3)

      expect(cache.has('a')).toBe(false)
      expect(cache.has('b')).toBe(true)
      expect(cache.has('c')).toBe(true)
    })
  })

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

      // 首次调用应该计算
      expect(getCached('a')).toBe('computed-a')
      expect(computeCount).toBe(1)

      // 再次调用应该使用缓存
      expect(getCached('a')).toBe('computed-a')
      expect(computeCount).toBe(1)

      // 不同的键应该重新计算
      expect(getCached('b')).toBe('computed-b')
      expect(computeCount).toBe(2)
    })

    test('应该能够限制内存使用', () => {
      const maxSize = 100
      const cache = new LRUCache<string, string>(maxSize)

      // 添加超过容量的项
      for (let i = 0; i < 200; i++) {
        cache.set(`key${i}`, `value${i}`)
      }

      // 缓存大小应该保持在最大值
      expect(cache.size).toBe(maxSize)

      // 旧的项应该被删除
      expect(cache.has('key0')).toBe(false)
      expect(cache.has('key99')).toBe(false)

      // 新的项应该存在
      expect(cache.has('key100')).toBe(true)
      expect(cache.has('key199')).toBe(true)
    })
  })
})
