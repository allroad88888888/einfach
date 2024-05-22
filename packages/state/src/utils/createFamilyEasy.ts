import type { InterState } from '../core'
import { atom, type AtomEntity } from '../core'

export interface CreateAtomFamilyOptions<Key extends (WeakKey | string) = WeakKey, State extends InterState = InterState,> {
  debuggerKey: string
  createAtom?: (key: Key, initState?: State) => AtomEntity<State>
}

export interface AtomFamilyAtom<State extends InterState = InterState> extends AtomEntity<State> {
  delete: () => void
}
export interface GetAtomById<Key extends (WeakKey | string) = WeakKey, State extends InterState = InterState> {
  <CurState extends State = State>(key: Key, initState?: State): AtomEntity<CurState>
  remove: (key: Key) => void
  clear: () => void
  get: GetAtomById<Key, State>
  has: (key: Key) => boolean
}


export function createAtomFamily<Key extends (WeakKey | string) = WeakKey, State extends InterState = InterState,>(
  { debuggerKey, createAtom }: CreateAtomFamilyOptions<Key, State>) {

  let atomMap: WeakMap<WeakKey, AtomEntity<State>>

  function getAtomById<CurState extends State = State>(
    key: Key, initState?: CurState) {
    if (!atomMap) {
      if (typeof key === 'string') {
        atomMap = new Map<Key, AtomEntity<State>>() as WeakMap<WeakKey, AtomEntity<State>>
      } else {
        atomMap = new WeakMap()
      }
    }
    if (!atomMap.has(key as WeakKey)) {
      let newAtom: AtomEntity<State>
      if (createAtom) {
        newAtom = createAtom(key, initState)
      }
      else {
        newAtom = atom(initState) as AtomEntity<State>
      }
      atomMap.set(key as WeakKey, newAtom as AtomEntity<State>)
      if (process.env.NODE_ENV !== 'production') {
        newAtom.debugLabel = `${debuggerKey}||${(key)?.toString()}`
      }
    }
    return atomMap.get(key as WeakKey)! as AtomEntity<CurState>
  }
  getAtomById.remove = (key: Key) => {
    atomMap.delete(key as WeakKey)
  }
  getAtomById.clear = () => {
    if ('clear' in atomMap) {
      (atomMap as unknown as Map<string, AtomEntity<State>>).clear()
    } else {
      atomMap = new WeakMap()
    }

  }
  getAtomById.has = (key: Key) => {
    return atomMap.has(key as WeakKey)
  }

  getAtomById.get = getAtomById
  return getAtomById as GetAtomById<Key, State>
}
