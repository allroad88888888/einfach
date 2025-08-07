import { atom } from '../atom'
import type { AtomEntity } from '../type'

export interface CreateAtomFamilyOptions<Key, State> {
  debuggerKey: string
  createAtom?: (key: Key, initState?: State) => AtomEntity<State>
}

export interface AtomFamilyAtom<State> extends AtomEntity<State> {
  delete: () => void
}
export interface GetAtomById<Key, State> {
  <CurState extends State = State>(key: Key, initState?: State): AtomEntity<CurState>
  remove: (key: Key) => void
  clear: () => void
  get: GetAtomById<Key, State>
  has: (key: Key) => boolean
}

export function createAtomFamilyStore() {
  const cacheIdObjMap = new Map<string, symbol>()
  function getIdObj(key: string) {
    if (!cacheIdObjMap.has(key)) {
      cacheIdObjMap.set(key, Symbol(key))
    }
    return cacheIdObjMap.get(key)!
  }
  const types = new Set(['number', 'string', 'boolean', 'undefined'])

  function getWeakKey(key: string): symbol
  function getWeakKey(key: number): symbol
  function getWeakKey(key: boolean): symbol
  function getWeakKey(key: undefined): symbol
  function getWeakKey(key: symbol): symbol
  function getWeakKey<T extends object>(key: T): T
  function getWeakKey(key: any) {
    if (types.has(typeof key)) {
      return getIdObj(key as string)
    }
    return key
  }

  function createAtomFamily<State, Key = string>({
    debuggerKey,
    createAtom,
  }: CreateAtomFamilyOptions<Key, State>) {
    let cacheAtomWeakMap = new WeakMap<WeakKey, AtomEntity<State>>()

    function getAtomById<CurState extends State = State>(key: Key, initState?: CurState) {
      const cacheKey = getWeakKey(key as string)

      if (!cacheAtomWeakMap.has(cacheKey as WeakKey)) {
        let newAtom: AtomEntity<State>
        if (createAtom) {
          if (arguments.length === 1) {
            newAtom = createAtom(key)
          } else {
            newAtom = createAtom(key, initState)
          }
        } else {
          newAtom = atom(initState) as AtomEntity<State>
        }
        cacheAtomWeakMap.set(cacheKey as WeakKey, newAtom as AtomEntity<State>)
        if (process.env.NODE_ENV !== 'production') {
          newAtom.debugLabel = `${debuggerKey}
          ||${cacheKey?.toString()}||${newAtom.debugLabel}`
        }
      }
      return cacheAtomWeakMap.get(cacheKey as WeakKey)! as AtomEntity<CurState>
    }
    getAtomById.remove = (key: Key) => {
      const cacheKey = getWeakKey(key as string)
      cacheAtomWeakMap.delete(cacheKey)
    }
    getAtomById.clear = () => {
      cacheAtomWeakMap = new WeakMap()
      cacheIdObjMap.clear()
    }
    getAtomById.has = (key: Key) => {
      const cacheKey = getWeakKey(key as string)
      return cacheAtomWeakMap.has(cacheKey)
    }

    getAtomById.get = getAtomById
    getAtomById.cacheAtomMap = cacheAtomWeakMap
    return getAtomById as GetAtomById<Key, State>
  }
  return {
    createAtomFamily,
    clear: () => {
      cacheIdObjMap.clear()
    },
  }
}
