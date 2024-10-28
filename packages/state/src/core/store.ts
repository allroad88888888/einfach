import { createContinuablePromise } from './promise'
import { isContinuablePromise, isPromiseLike } from './promiseUtils'
import type { Atom, ReadOptions, Setter, Store, WritableAtom } from './type'
import type { StatesWithPromise } from './typePromise'

let keyCount = 0
export function createStore(): Store {
  const atomStateMap = new WeakMap<Atom<unknown>, unknown>()

  const listenersMap = new WeakMap<Atom<unknown>, Set<() => void>>()
  const backDependenciesMap = new WeakMap<Atom<unknown>, Set<Atom<unknown>>>()
  /**
   * for clean backDependencies
   */
  const dependenciesMap = new WeakMap<Atom<unknown>, Set<Atom<unknown>>>()

  function clearDependencies<AtomType extends Atom<unknown>>(atomEntity: AtomType) {
    const dependencies = Array.from(dependenciesMap.get(atomEntity) || [])
    dependencies.forEach((depAtomEntity) => {
      backDependenciesMap.get(depAtomEntity)?.delete(atomEntity)
    })
    dependenciesMap.delete(atomEntity)
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
    force: boolean = false,
  ): StatesWithPromise<State> | State {
    if (force === false && atomStateMap.has(atomEntity)) {
      return atomStateMap.get(atomEntity) as State
    }

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
          return setAtom
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

    return setAtomState.call(this, atomEntity, nextState, () => {
      return controller?.abort?.()
    }) as State | StatesWithPromise<State>
  }

  function setAtom<State, Args extends unknown[], Result>(
    this: Atom<unknown>,
    atomEntity: WritableAtom<State, Args, Result>,
    ...arg: Args[]
  ): Result {
    if (Object.is(this, atomEntity)) {
      setAtomState(atomEntity, arg[0] as unknown as State)
      return undefined as Result
    }
    return atomEntity.write(readAtom, setAtom.bind(atomEntity) as Setter, ...(arg as Args))
  }

  function setAtomState<State extends Promise<any>>(
    this: any,
    atomEntity: Atom<State>,
    state: State,
    abortPromise?: () => void,
  ): State extends Promise<infer P> ? StatesWithPromise<P> : never
  function setAtomState<State>(
    this: any,
    atomEntity: Atom<State>,
    state: State,
    abortPromise?: () => void,
  ): State | StatesWithPromise<State>
  function setAtomState<State>(
    this: any,
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
        triggerSubScriptionAndDependency.call(atomEntity, atomEntity)
      })
      if (isContinuablePromise(prevState)) {
        prevState.CONTINUE_PROMISE?.(nextState as StatesWithPromise<State>, abortPromise)
      }
    }
    if (Object.is(prevState, nextState)) {
      return prevState
    }

    atomStateMap.set(atomEntity, nextState)
    triggerSubScriptionAndDependency.call(this, atomEntity)
    return nextState
  }

  function triggerSubScriptionAndDependency<Entity extends Atom<unknown>>(
    this: Entity,
    atomEntity: Entity,
  ) {
    /**
     * 触发订阅atom状态的方法
     */
    publishAtom(atomEntity)
    // 直接用set 跟clean BackDependencies 冲突，这里进入死循环
    const backEntitySet = Array.from(backDependenciesMap.get(atomEntity)! || [])
    backEntitySet.forEach((backEntity) => {
      if (this === backEntity) {
        return
      }
      readAtom.call(atomEntity, backEntity, true)
    })
  }

  function publishAtom<Entity extends Atom<unknown>>(atomEntity: Entity) {
    const listenerSet = listenersMap.get(atomEntity)
    if (listenerSet) {
      listenerSet.forEach((listener) => {
        listener()
      })
    }
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

  return {
    sub: subscribeAtom,
    getter: readAtom,
    setter: setAtom as Setter,
    toString: () => key,
  }
}
