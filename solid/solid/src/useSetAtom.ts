import { AtomSetParameters, AtomSetResult, WritableAtom } from '@einfach/core'
import { HookOption } from './type'
import { useStore } from './useStore'

/**
 * 使用 atom 设置器的 hook，只写
 * @param atom 可写的 Atom 实例
 * @param options 可选配置
 * @returns 设置 atom 值的函数
 */
export function useSetAtom<
  AtomType extends WritableAtom<unknown, any, unknown>
>(atom: AtomType, options: HookOption = {}): (...args: AtomSetParameters<AtomType>) => AtomSetResult<AtomType> {
  const store = useStore(options)

  return (...args: AtomSetParameters<AtomType>) => {
    return store.setter(atom, ...args) as AtomSetResult<AtomType>
  }
}

