import type { AtomEntity } from '../core'
import { atom, type Read } from '../core'

export function atomWithCompare<State>(
    read: Read<State> | State,
    equal: (prev: State, next: State) => State,
) {
    return atom<State, [State], void>(read, function (this: AtomEntity<State>, getter, setter, nextState) {
        setter(this, equal(getter(this) as State, nextState))
    })
}
