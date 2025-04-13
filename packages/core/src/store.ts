import { createContinuablePromise } from './promise'
import { isContinuablePromise, isPromiseLike } from './promiseUtils'
import type { Atom, AtomState, ReadOptions, Setter, Store, WritableAtom } from './type'
import type { StatesWithPromise } from './typePromise'

let keyCount = 0
export function createStore(): Store {
  let atomStateMap = new WeakMap<Atom<unknown>, unknown>()

  let listenersMap = new WeakMap<Atom<unknown>, Set<() => void>>()
  let backDependenciesMap = new WeakMap<Atom<unknown>, Set<Atom<unknown>>>()

  /**
   * for clean backDependencies
   */
  let dependenciesMap = new WeakMap<Atom<unknown>, Map<Atom<unknown>, unknown>>()

  const pendingMap = new Map<Atom<unknown>, unknown>()

  function clearDependencies<AtomType extends Atom<unknown>>(atomEntity: AtomType) {
    const dependencies = dependenciesMap.get(atomEntity)
    dependencies?.keys().forEach((depAtomEntity) => {
      backDependenciesMap.get(depAtomEntity)?.delete(atomEntity)
    })
    dependenciesMap.delete(atomEntity)
  }

  function getAtomState<AtomType extends Atom<unknown>>(atomEntity: AtomType) {
    return atomStateMap.get(atomEntity) as AtomState<AtomType>
  }

  function readAtom<State extends Promise<unknown>>(
    this: Atom<any>,
    atomEntity: Atom<Promise<State>>,
    force?: boolean,
  ): State extends Promise<infer P> ? StatesWithPromise<P> : never
  function readAtom<State>(this: Atom<any>, atomEntity: Atom<State>, force?: boolean): State
  function readAtom<State, Entity extends Atom<State>>(
    this: Atom<any>,
    atomEntity: Entity,
  ): StatesWithPromise<State> | State {
    if (atomStateMap.has(atomEntity)) {
      const depAtomEntityMap = dependenciesMap.get(atomEntity)
      if (!depAtomEntityMap) {
        return getAtomState(atomEntity)
      }

      const hasChange = depAtomEntityMap.keys().every((tempAntity) => {
        return Object.is(getAtomState(tempAntity), depAtomEntityMap.get(tempAntity))
      })

      if (hasChange) {
        return getAtomState(atomEntity)
      }
    }

    let isSync = true

    let nextState = atomEntity.init as State
    let controller: AbortController

    const options = Object.defineProperties({} as ReadOptions, {
      signal: {
        get() {
          controller = new AbortController()
          return controller.signal
        },
      },
      setter: {
        get() {
          if (!isSync) {
            return setAtom
          }
          return writeAtomState
        },
      },
    })

    if (typeof atomEntity.read === 'function') {
      function getter<State2>(
        atom: Atom<State2>,
      ): State2 extends Promise<infer P> ? StatesWithPromise<P> : never
      function getter<State2>(atom: Atom<State2>): State2
      function getter<State2>(atom: Atom<State2>): StatesWithPromise<State2> | State2 {
        if (Object.is(atom, atomEntity)) {
          if (!atomStateMap.has(atom)) {
            return atom.init! as State2
          }
          return atomStateMap.get(atom)! as State2
        }
        if (!backDependenciesMap.has(atom)) {
          backDependenciesMap.set(atom, new Set())
        }
        backDependenciesMap.get(atom)!.add(atomEntity)
        if (!dependenciesMap.has(atomEntity)) {
          dependenciesMap.set(atomEntity, new Map())
        }
        const nextValue = readAtom.call(atomEntity, atom) as State2
        dependenciesMap.get(atomEntity)!.set(atom, nextValue)
        return nextValue
      }

      clearDependencies(atomEntity)

      nextState = atomEntity.read(getter, options)
    }

    const next = setAtomState.call(this, atomEntity, nextState, () => {
      return controller?.abort?.()
    }) as State | StatesWithPromise<State>
    isSync = false
    return next
  }

  function setAtom<State, Args extends unknown[], Result>(
    atomEntity: WritableAtom<State, Args, Result>,
    ...args: Args
  ): Result {
    pendingMap.clear()
    const next = writeAtomState(atomEntity, ...args)
    flushPending()
    return next
  }

  function writeAtomState<State, Args extends unknown[], Result>(
    atomEntity: WritableAtom<State, Args, Result>,
    ...args: Args
  ) {
    let isSync = true
    function setter<NextState, NextArgs extends unknown[], NextResult>(
      nextSetAtomEntity: WritableAtom<NextState, NextArgs, NextResult>,
      ...nextArgs: NextArgs
    ) {
      if (atomEntity === (nextSetAtomEntity as unknown as WritableAtom<State, Args, Result>)) {
        setAtomState(nextSetAtomEntity, nextArgs[0])
        return undefined as Result
      }
      const next = writeAtomState(nextSetAtomEntity, ...nextArgs)
      // 应用场景  incrementAtom return 一个setter
      if (!isSync) {
        flushPending()
      }
      return next
    }
    const result = atomEntity.write(readAtom, setter as Setter, ...args)
    isSync = false
    return result
  }

  function setAtomState<State extends Promise<any>>(
    atomEntity: Atom<State>,
    state: State,
    abortPromise?: () => void,
  ): State extends Promise<infer P> ? StatesWithPromise<P> : never
  function setAtomState<State>(
    atomEntity: Atom<State>,
    state: State,
    abortPromise?: () => void,
  ): State | StatesWithPromise<State>
  function setAtomState<State>(
    atomEntity: Atom<State>,
    state: State,
    abortPromise: () => void = () => {},
  ): State | StatesWithPromise<State> {
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(state)
    }
    let nextState: StatesWithPromise<State> | State = state

    const prevState = atomStateMap.get(atomEntity) as StatesWithPromise<State> | State

    if (isPromiseLike(nextState)) {
      nextState = createContinuablePromise(nextState, abortPromise, () => {
        publishAtom(atomEntity)
      })
      if (isContinuablePromise(prevState)) {
        prevState.CONTINUE_PROMISE?.(nextState as StatesWithPromise<State>, abortPromise)
      }
    }

    if (atomStateMap.has(atomEntity) && Object.is(prevState, nextState)) {
      return prevState
    }

    atomStateMap.set(atomEntity, nextState)
    pendingMap.set(atomEntity, prevState)

    return nextState
  }

  function dependenciesChange<Entity extends Atom<unknown>>(atomEntity: Entity) {
    let backDependencies = backDependenciesMap.get(atomEntity)
    backDependencies?.forEach((depAtomEntity) => {
      const currrnt = getAtomState(depAtomEntity)
      const nextValue = readAtom.call(atomEntity, depAtomEntity)
      if (Object.is(currrnt, nextValue)) {
        return
      }
      dependenciesChange(depAtomEntity)
    })
  }

  function flushPending() {
    while (pendingMap.size > 0) {
      const pending = Array.from(pendingMap)
      pendingMap.clear()
      const dependencies = new Set<Atom<unknown>>()
      pending.forEach(([atomEntity, prevState]) => {
        dependenciesChange(atomEntity)
        const nextState = getAtomState(atomEntity)
        if (!Object.is(nextState, prevState)) {
          publishAtom(atomEntity)
        }
      })
      dependencies.forEach((entity) => {
        publishAtom(entity)
      })
    }
  }

  function publishAtom<Entity extends Atom<unknown>>(atomEntity: Entity) {
    const listenerSet = listenersMap.get(atomEntity)
    if (listenerSet) {
      listenerSet.forEach((listener) => {
        listener()
      })
    }
    const dependencies = backDependenciesMap.get(atomEntity)
    if (!dependencies) {
      return
    }
    Array.from(dependencies).forEach((depAtomEntity) => {
      publishAtom(depAtomEntity)
    })
  }

  function subscribeAtom<Entity extends Atom<unknown>>(atomEntity: Entity, listener: () => void) {
    if (!listenersMap.has(atomEntity)) {
      listenersMap.set(atomEntity, new Set())
    }
    listenersMap.get(atomEntity)!.add(listener)

    return () => {
      listenersMap.get(atomEntity)!.delete(listener)
    }
  }
  const key = `store${++keyCount}`

  function clear() {
    atomStateMap = new WeakMap()
    listenersMap = new WeakMap()
    backDependenciesMap = new WeakMap()
    dependenciesMap = new WeakMap()
  }

  return {
    sub: subscribeAtom,
    getter: readAtom,
    setter: setAtom as Setter,
    toString: () => key,
    clear,
  }
}
