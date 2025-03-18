import { createContinuablePromise } from './promise'
import { isContinuablePromise, isPromiseLike } from './promiseUtils'
import type { Atom, AtomState, ReadOptions, Setter, Store, WritableAtom } from './type'
import type { StatesWithPromise } from './typePromise'

let keyCount = 0
export function createStore(): Store {
  let atomStateMap = new WeakMap<Atom<unknown>, unknown>()

  let listenersMap = new WeakMap<Atom<unknown>, Set<() => void>>()
  let backDependenciesMap = new WeakMap<Atom<unknown>, Set<Atom<unknown>>>()

  const updatesSet = new Set<Atom<unknown>>()
  /**
   * for clean backDependencies
   */
  let dependenciesMap = new WeakMap<Atom<unknown>, Set<Atom<unknown>>>()

  const pendingMap = new Map<Atom<unknown>, unknown>()

  function clearDependencies<AtomType extends Atom<unknown>>(atomEntity: AtomType) {
    const dependencies = Array.from(dependenciesMap.get(atomEntity) || [])
    dependencies.forEach((depAtomEntity) => {
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
    if (!updatesSet.has(atomEntity) && atomStateMap.has(atomEntity)) {
      const depAtomEntityList = dependenciesMap.get(atomEntity)
      if (!depAtomEntityList) {
        return getAtomState(atomEntity)
      }
      const hasChange = Array.from(depAtomEntityList)?.every((depAtomEntity) => {
        // if (updatesSet.has(depAtomEntity)) {
        //   return false
        // }
        return getAtomState(depAtomEntity) === readAtom.call(depAtomEntity, depAtomEntity)
      })
      if (hasChange) {
        return getAtomState(atomEntity)
      }
    }

    updatesSet.delete(atomEntity)
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
          dependenciesMap.set(atomEntity, new Set())
        }
        dependenciesMap.get(atomEntity)!.add(atom)

        return readAtom.call(atomEntity, atom) as State2
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
    abortPromise: () => void = () => { },
  ): State | StatesWithPromise<State> {
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(state)
    }
    let nextState: StatesWithPromise<State> | State = state

    const prevState = atomStateMap.get(atomEntity) as StatesWithPromise<State> | State

    if (isPromiseLike(nextState)) {
      nextState = createContinuablePromise(nextState, abortPromise, () => {
        // triggerSubScriptionAndDependency.call(atomEntity, atomEntity)
        publishAtom(atomEntity)
      })
      if (isContinuablePromise(prevState)) {
        prevState.CONTINUE_PROMISE?.(nextState as StatesWithPromise<State>, abortPromise)
      }
    }
    if (Object.is(prevState, nextState)) {
      return prevState
    }

    if (atomStateMap.has(atomEntity)) {
      function addDependenciesToUpdateSet<AtomType extends Atom<unknown>>(updateEntity: AtomType) {
        backDependenciesMap.get(updateEntity)?.forEach((depAtomEntity) => {
          updatesSet.add(depAtomEntity)
        })
      }
      addDependenciesToUpdateSet(atomEntity)
    }

    atomStateMap.set(atomEntity, nextState)

    pendingMap.set(atomEntity, prevState)
    return nextState
  }


  function flushPending() {
    const addDependenciesToSet = <AtomType extends Atom<unknown>>(
      atomEntity: AtomType,
      dependencies: Set<Atom<unknown>>,
    ) => {
      dependencies.add(atomEntity)
      backDependenciesMap.get(atomEntity)?.forEach((entity) => {
        addDependenciesToSet(entity as Atom<unknown>, dependencies)
      })
    }

    while (pendingMap.size > 0) {
      const pending = Array.from(pendingMap)
      pendingMap.clear()

      const dependencies = new Set<Atom<unknown>>()

      pending.forEach(([atomEntity, prevState]) => {
        const nextState = getAtomState(atomEntity)
        if (!Object.is(nextState, prevState)) {
          addDependenciesToSet(atomEntity, dependencies)
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
