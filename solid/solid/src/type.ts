import type { Store } from '@einfach/core'

export interface HookOption {
  store?: Store
}

export interface StoreContextValue {
  store: Store
}
