import { useRef } from 'react'

export function useInit<Res>(fn: () => Res, deps?: unknown[]) {
  const { current } = useRef<{
    init: boolean
    deps?: unknown[]
    res?: Res
  }>({
    init: false,
    deps,
  })

  if (current.init === false) {
    current.init = true
    current.res = fn()
  }
  if (deps && deps.length > 0) {
    const isEqual = current.deps?.every((val, index) => {
      return Object.is(val, deps[index])
    })
    if (!isEqual) {
      current.deps = deps
      current.res = fn()
    }
  }

  return current.res!
}
