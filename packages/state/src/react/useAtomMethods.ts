import { useRef } from 'react'
import type { Getter, Setter } from '../core/type'
import { useStore } from './useStore'
import type { HookOption } from './type'

type Tail<T> = T extends (get: Getter, set: Setter, ...rest: infer P) => infer R
  ? (...args: P) => R
  : never
type TailActions<T> = { [key in keyof T]: Tail<T[key]> }

/**
 * 声明多个方法，可以获取atom数据的
 * @param methods
 * @param scope
 * @returns
 */
export const useAtomMethods = <
  T extends Record<string, (get: Getter, set: Setter, ...arg: any[]) => unknown>,
>(
  methods: T,
  options: HookOption = {},
) => {
  const store = useStore(options)

  const { current } = useRef<{
    init: boolean
    refMethods: T
    methods?: TailActions<T>
  }>({
    init: false,
    refMethods: methods,
    methods: undefined,
  })
  current.refMethods = methods
  if (current.init === false) {
    current.init = true
    const func = Object.create(null)

    Object.keys(methods).forEach((key) => {
      func[key] = (...args: any[]) =>
        methods[key].call(current.refMethods, store.getter, store.setter, ...args)
    })
    current.methods = func
  }

  return current.methods!
}
