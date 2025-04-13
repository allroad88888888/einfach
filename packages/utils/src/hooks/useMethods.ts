import { useRef } from 'react'

/**
 *
 * 来自 Mingyi
 * @param methods
 * @returns
 */
export const useMethods = <T extends Record<string, (...arg: any[]) => unknown>>(methods: T) => {
  const { current } = useRef({
    init: false,
    refMethods: methods,
    methods: undefined as T | undefined,
  })
  if (current.init === false) {
    current.init = true
    const func = Object.create(null)

    Object.keys(methods).forEach((key) => {
      func[key] = (...args: any[]) => methods[key].call(current.refMethods, ...args)
    })
    current.methods = func
  }

  return current.methods as T
}
