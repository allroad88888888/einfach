import { Store, AtomEntity } from '@einfach/core'
import { useEffect } from 'react'

type Item<T extends AtomEntity<any>> = {
  atom: T
  store: Store
}

export function useAtomSync<T extends AtomEntity<any>>(fromAtom: Item<T>, syncAtom: Item<T>) {
  useEffect(() => {
    syncAtom.store.setter(syncAtom.atom, fromAtom.store.getter(fromAtom.atom))
    return fromAtom.store.sub(syncAtom.atom, () => {
      syncAtom.store.setter(syncAtom.atom, fromAtom.store.getter(fromAtom.atom))
    })
  }, [fromAtom.atom, syncAtom.atom, fromAtom.store, syncAtom.store])
}
