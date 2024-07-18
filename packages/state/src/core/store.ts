// import type { StatesWithPromise } from './promise'
// import { createContinuablePromise } from './promise'
// import { isPromiseLike } from './promiseUtils'
import { createContinuablePromise } from './promise'
import { isContinuablePromise, isPromiseLike } from './promiseUtils'
import type { AtomEntity, Read, Store } from './type'
import type { ReturnState, StatesWithPromise } from './typePromise'

let keyCount = 0
export function createStore(): Store {
  let atomStateMap = new WeakMap<AtomEntity<any>, unknown>()

  const listenersMap = new WeakMap<AtomEntity<any>, Set<(state: any) => void>>()

  const backDependenciesMap = new WeakMap<AtomEntity<any>, Set<AtomEntity<any>>>()

  function readAtom<State>(this: any,
    atomEntity: AtomEntity<State>,
    force: boolean = false,
  ): ReturnState<State> {
    if (atomStateMap.has(atomEntity)) {
      if (!(typeof atomEntity.read === 'function') || force !== true) {
        return atomStateMap.get(atomEntity) as ReturnState<State>
      }
    }
    let res = atomEntity.read as State
    const controller = new AbortController()
    if (typeof atomEntity.read === 'function') {
      function getter<T>(atom: AtomEntity<T>) {
        if (!backDependenciesMap.has(atom)) {
          backDependenciesMap.set(atom, new Set())
        }
        backDependenciesMap.get(atom)!.add(atomEntity)

        return readAtom.call(atomEntity, atom) as ReturnState<T>
      }

      res = (atomEntity.read as Read<State>)(getter, controller)
    }

    return setAtomState.call(this, atomEntity, res, () => {
      controller.abort()
    }) as ReturnState<State>

    // return res as ReturnState<State>
  }

  function setAtom<State>(
    atomEntity: AtomEntity<State>,
    state: State | ((prev: ReturnState<State>) => State)) {
    let nextState = state
    if (typeof state === 'function') {
      nextState = (state as (prev: ReturnState<State>) => State)(readAtom(atomEntity))
    }
    return atomEntity.write(readAtom, setAtomState, nextState)
  }
  function setAtomState<State>(this: any,
    atomEntity: AtomEntity<State>, state: State, abortPromise: () => void = () => { }) {
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(state)
    }

    let newState = state as ReturnState<State>

    if (isPromiseLike(state)) {
      newState = createContinuablePromise(
        state as Promise<State>,
        abortPromise,
        () => {
          // pubAndPubGetterAtom(atomEntity)
        },
      ) as ReturnState<State>

      if (atomStateMap.has(atomEntity)) {
        const prevState = atomStateMap.get(atomEntity)
        if (prevState && isContinuablePromise(prevState)) {
          prevState.CONTINUE_PROMISE?.(newState as StatesWithPromise<State>, abortPromise)
        }
      }

      // const state = atomStateMap.get(atomEntity) as ReturnState<State>
      // if (force === true && isContinuablePromise(state) && state.status === 'pending') {
      //   state.CONTINUE_PROMISE()
      // }
    }

    atomStateMap.set(atomEntity, newState)
    /**
     * 触发订阅atom状态的方法
     */
    publishAtom(atomEntity, newState)

    /**
     * 触发衍生态的atom订阅方法
     */
    const backEntitySet = backDependenciesMap.get(atomEntity)! || []
    backEntitySet.forEach((backEntity) => {
      if (this === backEntity) {
        return
      }
      readAtom(backEntity, true)
    })
    return newState
  }

  function publishAtom<State>(atomEntity: AtomEntity<State>, state: ReturnState<State>) {
    const listenerSet = listenersMap.get(atomEntity)
    if (listenerSet) {
      listenerSet.forEach((listener) => {
        listener(state as State)
      })
    }
  }

  function subscribeAtom<State>(
    atomEntity: AtomEntity<State>, listener: (state: ReturnState<State>) => void) {
    if (!listenersMap.has(atomEntity)) {
      listenersMap.set(atomEntity, new Set())
    }
    (listenersMap.get(atomEntity)!).add(listener)

    return () => {
      (listenersMap.get(atomEntity)!).delete(listener)
    }
  }

  function resetAtom<State>(atomEntity?: AtomEntity<State>) {
    if (atomEntity) {
      atomStateMap.delete(atomEntity)
    }
    else {
      atomStateMap = new WeakMap()
    }
  }

  const key = `store${++keyCount}`
  return {
    sub: subscribeAtom,
    getter: readAtom,
    setter: setAtom,
    toString: () => key,
    debugLabel: key,
    resetAtom,
  }
}
