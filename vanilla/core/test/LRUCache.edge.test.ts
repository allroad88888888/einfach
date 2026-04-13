import { describe, test, expect } from '@jest/globals'
import { LRUCache } from '../src/utils/LRUCache'

describe('LRUCache - 边界情况', () => {
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
    cache.set('c', 3)

    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
  })
})
