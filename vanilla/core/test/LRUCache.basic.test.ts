import { describe, test, expect } from '@jest/globals'
import { LRUCache } from '../src/utils/LRUCache'

describe('LRUCache - 基本操作', () => {
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
