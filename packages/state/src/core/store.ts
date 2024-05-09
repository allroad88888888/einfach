import type { AtomEntity, InterState, Store } from './type'

let keyCount = 0
export function createStore(): Store {
  const atomStateMap = new WeakMap<AtomEntity<any>, unknown>()

  const listenersMap = new WeakMap<AtomEntity<any>, Set<() => void>>()

  const backDependenciesMap = new WeakMap<AtomEntity<any>, Set<AtomEntity<any>>>()

  function readAtom<State extends InterState = InterState>(atomEntity: AtomEntity<State>): State {
    const atomState = atomStateMap.get(atomEntity) as State
    if (atomState) {
      return atomState
    }
    if (Object.prototype.hasOwnProperty.call(atomEntity, 'init')) {
      return atomEntity.init!
    }

    function getter<T extends InterState = InterState>(atom: AtomEntity<T>) {
      if (!backDependenciesMap.has(atom)) {
        backDependenciesMap.set(atom, new Set())
      }
      (backDependenciesMap.get(atom)!).add(atomEntity)

      return readAtom(atom)
    }

    return atomEntity.read(getter)
  }

  function setAtom<State extends InterState = InterState>(
    atomEntity: AtomEntity<State>, ...arg: unknown[]) {
    return atomEntity.write(readAtom, setAtomState, ...arg)
  }
  function setAtomState<State extends InterState = InterState>(
    atomEntity: AtomEntity<State>, state: State) {
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(state)
    }

    atomStateMap.set(atomEntity, state)
    publishAtom(atomEntity)
    backDependenciesMap.get(atomEntity)?.forEach((backEntity) => {
      publishAtom(backEntity)
    })
  }

  function publishAtom<State extends InterState = InterState>(atomEntity: AtomEntity<State>) {
    const listenerSet = listenersMap.get(atomEntity)
    if (listenerSet) {
      listenerSet.forEach((listener) => {
        listener()
      })
    }
  }

  function subscribeAtom<State extends InterState = InterState>(
    atomEntity: AtomEntity<State>, listener: () => void) {
    if (!listenersMap.has(atomEntity)) {
      listenersMap.set(atomEntity, new Set())
    }
    (listenersMap.get(atomEntity)!).add(listener)

    return () => {
      (listenersMap.get(atomEntity)!).delete(listener)
    }
  }
  const key = `store${++keyCount}`
  return {
    sub: subscribeAtom, getter: readAtom, setter: setAtom, toString: () => key,
  }
}
