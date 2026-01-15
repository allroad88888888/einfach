/**
 * LRU (Least Recently Used) 缓存实现
 * 当缓存达到最大容量时，自动删除最久未使用的项
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>
  private maxSize: number

  constructor(maxSize: number = Infinity) {
    this.cache = new Map()
    this.maxSize = maxSize
  }

  /**
   * 获取缓存值
   * @param key 缓存键
   * @returns 缓存值，不存在返回 undefined
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // 重新插入到末尾，标记为最近使用
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  /**
   * 设置缓存值
   * @param key 缓存键
   * @param value 缓存值
   */
  set(key: K, value: V): void {
    // 如果 key 已存在，先删除（保证插入到末尾）
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // 插入到末尾
    this.cache.set(key, value)

    // 超过最大容量，删除最旧的（第一个）
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
  }

  /**
   * 检查缓存中是否存在指定键
   * @param key 缓存键
   * @returns 是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key)
  }

  /**
   * 获取当前缓存大小
   * @returns 缓存项数量
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 删除指定缓存项
   * @param key 缓存键
   * @returns 是否删除成功
   */
  delete(key: K): boolean {
    return this.cache.delete(key)
  }
}
