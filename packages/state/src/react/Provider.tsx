import type { ReactNode } from 'react'
import { createContext } from 'react'
import type { Store } from '../core/type'

export const StoreContext = createContext<Store>(null as unknown as Store)

export function Provider({ store, children }: { store: Store; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
