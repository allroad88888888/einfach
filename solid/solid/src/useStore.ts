import { Store } from '@einfach/core'
import { defaultStore, useStoreContext } from './Provider'
import { HookOption } from './type'

/**
 * 获取 store 实例的 hook
 * @param options 可选配置，可以指定使用的 store
 * @returns store 实例
 */
export function useStore(options: HookOption = {}): Store {
  const { store: optionStore } = options
  const { store: contextStore } = useStoreContext()
  return optionStore || contextStore || defaultStore
}
