/** @jsxImportSource solid-js */
import { getDefaultStore, Store } from '@einfach/core'
import { createContext, mergeProps, useContext } from 'solid-js'
import { JSX } from 'solid-js/jsx-runtime'
import { StoreContextValue } from './type'

export const defaultStore = getDefaultStore()

// 创建 store context
export const StoreContext = createContext<StoreContextValue>(
  undefined as unknown as StoreContextValue,
)

export interface ProviderProps {
  store?: Store
  children: JSX.Element
}

/**
 * Einfach Provider 组件
 * 提供自定义 store 的能力
 */
export function Provider(props: ProviderProps) {
  const merged = mergeProps(props, { store: props.store || defaultStore })
  return (
    <StoreContext.Provider value={{ store: merged.store }}>{props.children}</StoreContext.Provider>
  )
}

/**
 * 使用当前 store 的 hook
 */
export function useStoreContext(): StoreContextValue {
  // 这里一定要这么写 不能直接返回 useContext(StoreContext)
  const context = useContext(StoreContext)
  return context
}
