import { describe, test, expect } from '@jest/globals'
import { LRUCache } from '../src/utils/LRUCache'

describe('LRUCache - 淘汰策略', () => {
  test('超过最大容量时应该删除最久未使用的项', () => {
    const cache = new LRUCache<string, number>(3)

    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
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
    cache.get('a')
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
    cache.set('a', 10)
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
    cache.get('a')
    cache.get('b')
    cache.set('d', 4)

    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(false)
    expect(cache.has('d')).toBe(true)
  })
})
