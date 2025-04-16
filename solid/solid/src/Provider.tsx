/** @jsxImportSource solid-js */
import { getDefaultStore, Store } from '@einfach/core'
import { createContext, useContext } from 'solid-js'
import { JSX } from 'solid-js/jsx-runtime'
import { StoreContextValue } from './type'

export const defaultStore = getDefaultStore()

// 创建 store context
export const StoreContext = createContext<StoreContextValue>({ store: defaultStore })

export interface ProviderProps {
  store?: Store
  children: JSX.Element
}

/**
 * Einfach Provider 组件
 * 提供自定义 store 的能力
 */
export function Provider(props: ProviderProps) {
  const { store = defaultStore, children } = props
  return <StoreContext.Provider value={{ store }}>{children}</StoreContext.Provider>
}

/**
 * 使用当前 store 的 hook
 */
export function useStoreContext(): StoreContextValue {
  return useContext(StoreContext)
}
