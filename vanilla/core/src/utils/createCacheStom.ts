import { atom } from '../atom'
import type { Atom, AtomEntity, WritableAtom } from '../type'
import { LRUCache } from './LRUCache'

export interface CreateCacheStomOptions<
  Args extends unknown[],
  AtomEntity extends Atom<unknown> | WritableAtom<unknown, any, any>,
  CacheKey = string,
> {
  createAtom: (...args: Args) => AtomEntity
  /**
   * 自定义缓存键生成函数
   * @param args - 传入的参数
   * @returns 缓存键，可以是任何类型（string, number, object, Symbol 等）
   * @default JSON.stringify (返回 string)
   */
  getCacheKey?: (...args: Args) => CacheKey
  debuggerKey: string
  /**
   * 最大缓存数量，超过后使用 LRU 策略自动清理最久未使用的项
   * @default Infinity (无限制)
   */
  maxSize?: number
}

export function createCacheStom<
  Args extends unknown[],
  AtomEntity extends Atom<unknown> | WritableAtom<unknown, any, any>,
  CacheKey = string,
>(options: CreateCacheStomOptions<Args, AtomEntity, CacheKey>): (...args: Args) => AtomEntity {
  const getCacheKey = (options?.getCacheKey ?? ((...args: Args) => JSON.stringify(args))) as (
    ...args: Args
  ) => CacheKey
  const cache = new LRUCache<CacheKey, AtomEntity>(options.maxSize)

  return (...args: Args) => {
    const cacheKey = getCacheKey(...args)
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, options.createAtom(...args))
    }
    const newAtom = cache.get(cacheKey)!

    if (process.env.NODE_ENV === 'development') {
      newAtom.debugLabel = `${options?.debuggerKey}-${JSON.stringify(cacheKey)}`
    }
    return newAtom as AtomEntity
  }
}

/**
 * 创建一个基于单个 id 字符串参数的缓存 atom 函数
 *
 * @param createAtom - 创建 atom 的函数，接收一个 id 参数
 * @param debuggerKey - 调试标签
 * @param maxSize - 最大缓存数量（可选）
 * @returns 缓存包装后的函数
 *
 * @example
 * ```ts
 * // 使用 createAtom
 * const getUserAtom = createCacheStomById({
 *   createAtom: (id) => atom({ id, data: null }),
 *   debuggerKey: 'user',
 *   maxSize: 1000
 * })
 *
 * // 使用 defaultState
 * const getCountAtom = createCacheStomById({
 *   defaultState: 0,
 *   debuggerKey: 'count',
 *   maxSize: 1000
 * })
 *
 * const userAtom = getUserAtom('user123')
 * ```
 */
export function createCacheStomById<T>(options: {
  defaultState: T
  debuggerKey: string
  maxSize?: number
}): (id: string) => AtomEntity<T>
export function createCacheStomById<AtomEntity extends Atom<unknown>>(options: {
  createAtom: (id: string) => AtomEntity
  debuggerKey: string
  maxSize?: number
}): (id: string) => AtomEntity
export function createCacheStomById<T, AtomEntity extends Atom<unknown>>({
  createAtom,
  defaultState,
  debuggerKey,
  maxSize,
}: {
  createAtom?: (id: string) => AtomEntity
  defaultState?: T
  debuggerKey: string
  maxSize?: number
}) {
  const atomCreator = createAtom || ((id: string) => atom(defaultState) as unknown as AtomEntity)

  return createCacheStom<[id: string], AtomEntity, string>({
    createAtom: atomCreator,
    getCacheKey: (id: string) => id,
    debuggerKey,
    maxSize,
  })
}
