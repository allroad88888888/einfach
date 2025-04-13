import type { AtomEntity, Getter, Read, Setter, WritableAtom } from './type'

let keyCount = 0

type Value<State> = State | ((prev: State) => State)

export function atom<State>(read: Read<State>): AtomEntity<State>
export function atom<State>(read: State): AtomEntity<State>
export function atom<State, Args extends unknown[], Result>(
  read: Read<State> | State,
  write: (getter: Getter, setter: Setter, ...args: Args) => Result,
): WritableAtom<State, Args, Result>

export function atom<State, Args extends unknown[], Result>(
  read: Read<State> | State,
  write?: (getter: Getter, setter: Setter, ...args: Args) => Result,
): WritableAtom<State, Args, Result> {
  const key = `atom${++keyCount}`
  const entity = {
    toString: function () {
      return key
    },
  } as WritableAtom<State, Args, Result>
  if (typeof read === 'function') {
    entity.read = read as Read<State>
  } else {
    entity.init = read as State
    entity.write = function (getter: Getter, setter: Setter, arg: Value<State>) {
      return setter(
        entity as unknown as WritableAtom<State, [Value<State>], Result>,
        typeof arg === 'function' ? (arg as (prev: State) => State)(getter(entity) as State) : arg,
      )
    } as unknown as (getter: Getter, setter: Setter, ...args: Args) => Result
  }
  if (write) {
    entity.write = write
  }
  entity.debugLabel = key

  return entity
}
