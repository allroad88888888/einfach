import { Store, AtomEntity } from '@einfach/core'
import { useEffect } from 'react'

type Item<T extends AtomEntity<unknown>> = {
  atom: T
  store: Store
}

export function useAtomSync<T extends AtomEntity<unknown>>(fromAtom: Item<T>, syncAtom: Item<T>) {
  useEffect(() => {
    return fromAtom.store.sub(syncAtom.atom, () => {
      syncAtom.store.setter(syncAtom.atom, fromAtom.store.getter(fromAtom.atom))
    })
  }, [fromAtom, syncAtom])
}
