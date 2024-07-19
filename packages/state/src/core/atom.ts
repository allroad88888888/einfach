import type { AtomEntity, Getter, Read, Setter, WritableAtom, WritableItem, Write } from './type'
import { ReturnState } from './typePromise'

let keyCount = 0

export function atom<State>(read: Read<State> | State): AtomEntity<State>
export function atom<State, Args extends unknown[], Result>(
  read: Read<State> | State,
  write: Write<State, Args, Result>
): WritableItem<State>
export function atom<
  State,
  Args extends unknown[] = [State | ((prev: ReturnState<State>) => State)],
  Result = void>
  (
    read: Read<State> | State,
    write?: Write<State, Args, Result>
  ) {
  const key = `atom${++keyCount}`
  const entity = {
    toString: function () {
      return key
    },
  } as WritableAtom<State, Args, Result>
  if (typeof read === 'function') {
    entity.read = read as Read<State>
  }
  else {
    // entity._init = read
    entity.read = read;
    (entity as unknown as AtomEntity<State>).write = (get: Getter, set: Setter, arg) => {
      return set(entity as unknown as AtomEntity<State>,
        typeof arg === 'function' ?
          (arg as (prev: ReturnState<State>) => State)(get(entity as unknown as AtomEntity<State>)) :
          arg)
    }
  }
  if (write) {
    entity.write = write
  }
  entity.debugLabel = key

  return entity
}
