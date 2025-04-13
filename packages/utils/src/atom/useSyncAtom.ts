import { type Atom, type Store } from '@einfach/core'
import { useInit } from '../hooks'
import { useEffect } from 'react'

const cache = new WeakMap<Store, WeakMap<Atom<unknown>, () => void>>()

export function syncAtom<T extends Atom<unknown>>(atomEntity: T, store: Store, syncStore: Store) {
  if (!cache.has(syncStore)) {
    cache.set(syncStore, new WeakMap())
  }
  if (!cache.get(syncStore)?.has(atomEntity)) {
    function sub() {
      const syncVal = store.getter(atomEntity) as T
      syncStore.setter(atomEntity as any, syncVal)
    }
    sub()
    const cancel = store.sub(atomEntity, sub)
    cache.get(syncStore)?.set(atomEntity, cancel)
  }
  return [atomEntity, cache.get(syncStore)?.get(atomEntity)] as [T, () => void]
}

export function useSyncAtom<T extends Atom<unknown>>(
  atomEntity: T,
  store: Store,
  syncStore: Store,
) {
  const [newAtom, cancel] = useInit(() => {
    return syncAtom(atomEntity, store, syncStore)
  })

  useEffect(() => {
    return cancel
  }, [cancel])

  return newAtom
}
