import type { Atom, AtomState, AtomEntity } from './../core'
import { atom } from './../core'

type IdObj = {
  id: string
}

const cacheObjMap = new Map<string, IdObj>()
function createObjByString(id: string): IdObj {
  if (cacheObjMap.has(id)) {
    cacheObjMap.set(id, {
      id,
    })
  }
  return cacheObjMap.get(id)!
}

const cacheStoreAtom = atom(() => {
  return {}
})

export function createAtomFamily<State>({
  debuggerKey,
  defaultValue,
}: {
  debuggerKey: string
  defaultValue?: State
}): (key: string) => AtomEntity<State>

export function createAtomFamily<AtomType extends Atom<any>>({
  debuggerKey,
  createAtom,
}: {
  debuggerKey: string
  createAtom?: (key: string, initState?: AtomState<AtomType>) => AtomType
}): (key: string, initState?: AtomState<AtomType>) => AtomType
export function createAtomFamily<AtomType extends Atom<any>>({
  debuggerKey,
  defaultValue,
  createAtom,
}: {
  debuggerKey: string
  createAtom?: (key: string, initState?: AtomState<AtomType>) => AtomType
  defaultValue?: AtomState<AtomType>
}) {
  const cache = new WeakMap()

  return (key: string, initState?: AtomState<AtomType>) => {
    const idObj = createObjByString(key)

    function create() {
      if (createAtom) {
        const newAtom = createAtom(key, initState)
        newAtom.debugLabel = `${debuggerKey}||${key}||${newAtom.debugLabel}`
        return newAtom
      }

      const newAtom = atom(defaultValue)
      newAtom.debugLabel = `${debuggerKey}||${key}||${newAtom.debugLabel}`
      return newAtom
    }

    return atom((getter) => {
      const storeKey = getter(cacheStoreAtom)
      if (!cache.has(storeKey)) {
        cache.set(storeKey, new WeakMap<IdObj, AtomType>())
      }
      const localCache = cache.get(storeKey)!
      if (!localCache.has(idObj)) {
        localCache.set(idObj, create())
      }
      return getter(localCache.get(idObj)!)
    })
  }
}
