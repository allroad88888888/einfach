import { AtomEntity } from '@einfach/core'
import { HookOption } from './type'
import { useAtomValue } from './useAtomValue'
import { useSetAtom } from './useSetAtom'

/**
 * 使用 atom 的 hook，可读可写
 * @param atom Atom 实例
 * @param options 可选配置
 * @returns 包含值和设置器的对象
 */
export function useAtom<Value>(
  atom: AtomEntity<Value>,
  options: HookOption = {}
) {
  const rawValue = useAtomValue<Value>(atom, options)
  const setValue = useSetAtom(atom, options)

  return {
    rawValue,
    setValue,
  }
}
