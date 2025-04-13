import type { Atom, AtomEntity, AtomState } from './type'
import { atom } from './atom'

export function selectAtom<Slice, AtomType extends Atom<unknown>>(
  atomEntity: AtomType,
  selectFn: (current: AtomState<AtomType>, prev?: Slice) => Slice,
  equalityFn?: (prev: Slice, next: Slice) => boolean,
): AtomEntity<Slice>
export function selectAtom<Slice, State>(
  atomEntity: AtomEntity<State>,
  selectFn: (current: State, prev?: Slice) => Slice,
  equalityFn?: (prev: Slice, next: Slice) => boolean,
): State extends Promise<any> ? never : AtomEntity<Slice>
export function selectAtom<Slice, State>(
  atomEntity: AtomEntity<State>,
  selectFn: (current: State, prev?: Slice) => Slice,
  equalityFn: (prev: Slice, next: Slice) => boolean = Object.is,
) {
  const Empty = Symbol('empty')
  const derivedAtom = atom<Slice | symbol>((getter) => {
    const info = getter(atomEntity) as State
    const prev = getter(derivedAtom) as Slice
    const next = selectFn(info, prev)
    if (prev !== Empty && equalityFn(prev, next)) {
      return prev
    }
    return next
  })
  derivedAtom.init = Empty as Slice

  return derivedAtom as AtomEntity<Slice>
}
