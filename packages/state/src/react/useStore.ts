import { useContext } from 'react'
import type { HookOption } from './type'
import { StoreContext } from './Provider'
import { getDefaultStore } from '../core'

export function useStore({ store }: HookOption = {}) {
  const providerStore = useContext(StoreContext) || getDefaultStore()
  return store || providerStore
}
