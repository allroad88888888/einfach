import { createContext, useContext, useRef } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

// 缓存条目：[参数数组, 结果]
type CacheEntry = [unknown[], unknown]

// 内部缓存类型：WeakMap<函数引用, 缓存条目数组>
type CacheStore = WeakMap<AnyFn, CacheEntry[]>

export type CacheProviderType = {
    cacheStore: CacheStore
   
}

export const ProviderCacheContext = createContext<CacheProviderType>(
    undefined as unknown as CacheProviderType,
)

/**
 * 比较两个参数数组是否相等
 */
function argsEqual(args1: unknown[], args2: unknown[]): boolean {
    if (args1.length !== args2.length) return false
    for (let i = 0; i < args1.length; i++) {
        if (args1[i] !== args2[i]) return false
    }
    return true
}

/**
 * 返回缓存包装的函数，调用时自动缓存结果
 * @example
 * const getValueAtom = useCache(getValueAtomById)
 * const value = useAtomValue(getValueAtom(id), { store })
 *
 * // 支持多参数
 * const createAtom = useCache(createAtomByIdAndType)
 * const atom = createAtom(id, type, options)
 */
export function useCache<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
    isArgsEqual: (args1: unknown[], args2: unknown[]) => boolean = argsEqual,
): (...args: TArgs) => TResult {
    const { cacheStore } = useContext(ProviderCacheContext)

    if (!cacheStore.has(fn)) {
        cacheStore.set(fn, [])
    }
    const entries = cacheStore.get(fn)!

    return (...args: TArgs): TResult => {
        // 查找已缓存的条目
        for (const [cachedArgs, cachedResult] of entries) {
            if (isArgsEqual(args, cachedArgs)) {
                return cachedResult as TResult
            }
        }
        // 未找到，执行函数并缓存
        const result = fn(...args)
        entries.push([args, result])
        return result
    }
}

export function useCreateCache() {
    // WeakMap<函数引用, 缓存条目数组>
    // 函数被 GC 时，对应的缓存自动清理
    const cacheStoreRef = useRef<CacheStore>(new WeakMap())
    return {
        cacheStore: cacheStoreRef.current,
    } as CacheProviderType
}
