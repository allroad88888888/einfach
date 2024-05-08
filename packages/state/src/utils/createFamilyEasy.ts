import type { InterState } from '../core'
import { atom, type AtomEntity } from '../core'

export interface CreateAtomFamilyOptions<State extends InterState = InterState, Key = string> {
  debuggerKey: string
  createAtom?: (key: Key, initState?: State) => AtomEntity<State>
}

export interface AtomFamilyAtom<State extends InterState = InterState> extends AtomEntity<State> {
  delete: () => void
}
export interface GetAtomById<State extends InterState = InterState, Key = string> {
  <CurState extends State = State>(key: Key, initState?: State): AtomEntity<CurState>
  remove: (key: Key) => void
  clear: () => void
  get: GetAtomById<State, Key>
  has: (key: Key) => boolean
}

export function createAtomFamily<State extends InterState = InterState, Key = string>(
  { debuggerKey, createAtom }: CreateAtomFamilyOptions<State, Key>) {
  const atomMap = new Map<Key, AtomEntity<State>>()
  function getAtomById<CurState extends State = State>(
    key: Key, initState?: CurState) {
    if (!atomMap.has(key)) {
      let newAtom: AtomEntity<State>
      if (createAtom) {
        newAtom = createAtom(key, initState)
      }
      else {
        newAtom = atom(initState) as AtomEntity<State>
      }
      atomMap.set(key, newAtom as AtomEntity<State>)
      if (process.env.NODE_ENV !== 'production') {
        newAtom.debugLabel = `${debuggerKey}||${(key)?.toString()}`
      }
    }
    return atomMap.get(key)! as AtomEntity<CurState>
  }
  getAtomById.remove = (key: Key) => {
    atomMap.delete(key)
  }
  getAtomById.clear = () => {
    atomMap.clear()
  }
  getAtomById.has = (key: Key) => {
    return atomMap.has(key)
  }
  getAtomById.atomMap = atomMap
  getAtomById.get = getAtomById
  return getAtomById as GetAtomById<State, Key>
}
