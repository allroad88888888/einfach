export function memoWeak<T extends (...args: any) => any>(
  fn: T,
  buildKey: (...args: Parameters<T>) => WeakKey,
) {
  const cache = new WeakMap<WeakKey, ReturnType<T>>()
  return (...params: Parameters<T>) => {
    const key = buildKey(...params)
    if (!cache.has(key)) {
      cache.set(key, fn(...params))
    }
    return cache.get(key)!
  }
}

const cacheObjMap = new Map<string, { id: string }>()
export function createObjByString(id: string) {
  if (cacheObjMap.has(id)) {
    cacheObjMap.set(id, {
      id,
    })
  }
  return cacheObjMap.get(id)!
}
