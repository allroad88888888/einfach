export function memoizeFn<T extends (...args: any) => any>(
  fn: T,
  equal?: (prev: Parameters<T>, cur: Parameters<T>) => boolean,
): T {
  const cacheMap = new Map<Parameters<T>, ReturnType<T>>()
  return ((...param: Parameters<T>) => {
    let has = false

    const iterator1 = cacheMap.keys()
    let next = iterator1.next()
    while (has === false && !next.done) {
      const key = next.value as Parameters<T>
      if (equal) {
        has = equal(key, param)
      } else {
        has = key.every((temp, index) => {
          return temp === param[index]
        })
      }

      if (has) {
        break
      }
      next = iterator1.next()
    }

    if (!has) {
      cacheMap.set(param, fn(...param))
      return cacheMap.get(param)!
    }
    return cacheMap.get(next.value!)!
  }) as T
}

export function memoizeOneArg<Arg extends WeakKey, Res = unknown>(
  fn: (param: Arg) => Res,
): (param: Arg) => Res {
  const cacheMap = new WeakMap<Arg, Res>()
  return (param: Arg) => {
    if (!cacheMap.has(param)) {
      cacheMap.set(param, fn(param))
    }
    return cacheMap.get(param)!
  }
}
