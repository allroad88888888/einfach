import type { AtomEntity, Getter, Read, Setter, Write } from './type'

let keyCount = 0
export function atom<State>(
  read: Read<State> | State, write?: Write) {
  const key = `atom${++keyCount}`
  const entity: AtomEntity<State> = {
    toString: function () {
      return key
    },
  } as AtomEntity<State>
  if (typeof read === 'function') {
    entity.read = read as Read<State>
  }
  else {
    // entity._init = read
    entity.read = read
    entity.write = function (get: Getter, set: Setter, arg) {
      return set(entity, typeof arg === 'function' ? arg(get(this)) : arg)
    }
  }
  if (write) {
    entity.write = write
  }
  entity.debugLabel = key

  return entity
}
