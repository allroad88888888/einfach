import type { AtomEntity, Getter, Setter } from '../type'
import { atom, type Read } from '../atom'

export function atomWithCompare<State>(
  read: Read<State> | State,
  equal: (prev: State, next: State) => State,
) {
  return atom<State, [State], void>(
    read,
    function (this: AtomEntity<State>, getter: Getter, setter: Setter, nextState: State) {
      setter(this, equal(getter(this) as State, nextState))
    },
  )
}
