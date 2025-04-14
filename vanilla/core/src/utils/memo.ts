var cache = new WeakMap()

export function memo<Value>(create: () => Value, key: WeakKey) {
  return (cache.has(key) ? cache : cache.set(key, create())).get(key)!
}
