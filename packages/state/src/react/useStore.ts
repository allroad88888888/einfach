import { useContext } from 'react'
import type { HookOption } from './type'
import { StoreContext } from './Provider'

export function useStore({ store }: HookOption = {}) {
  const providerStore = useContext(StoreContext)
  return store || providerStore
}
