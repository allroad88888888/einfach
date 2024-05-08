export function easyClone<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((value) => {
      if (typeof value !== 'object') {
        return value
      }
      return easyClone(value)
    }) as T
  }
  if (Object.prototype.toString.call(obj) === '[object Object]') {
    const newObj = {
      ...(obj as object),
    } as T
    Object.keys(obj as Record<string, unknown>).forEach((key) => {
      const value = (obj as Record<string, unknown>)[key]
      if (typeof value === 'object') {
        (obj as Record<string, unknown>)[key] = easyClone(value)
      }
    })

    return newObj as T
  }
  return obj
}
