function equal(prev: unknown, cur: unknown) {
  if (typeof prev === 'object') {
    return Object.is(prev, cur)
  }
  return prev === cur
}

export function easyEqual(prev: unknown, cur: unknown): boolean {
  if (!prev || !cur) {
    return equal(prev, cur)
  }
  if (Array.isArray(prev) && Array.isArray(cur)) {
    if (prev.length !== cur.length) {
      return false
    }
    const res = prev.findIndex((obj, index) => {
      return !equal(obj, cur[index])
    })
    return res === -1
  }
  if (typeof prev === 'object' && typeof cur === 'object') {
    const prevKeys = Object.keys(prev)
    const curKeys = Object.keys(cur)
    if (prevKeys.length !== curKeys.length) {
      return false
    }
    const res = prevKeys.find((key) => {
      return !equal((prev as Record<string, unknown>)[key], (cur as Record<string, unknown>)[key])
    })
    return !res
  }

  return equal(prev, cur)
}
