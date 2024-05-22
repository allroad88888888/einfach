import { useLayoutEffect, useReducer, useState } from 'react'
import type { AtomEntity, InterState, Store } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'

type ReducerState<State extends InterState = InterState> = [State, Store, AtomEntity<State>]

function valueReducer<State extends InterState = InterState>(
  prev: ReducerState<State>): ReducerState<State> {
  const [state, store, atomEntity] = prev
  const nextValue = (store as Store).getter(atomEntity)
  if (Object.is(state, nextValue)) {
    return prev
  }
  return [nextValue, store, atomEntity]
}

export function useAtomValueByReducer<State extends InterState = InterState>(
  atom: AtomEntity<State>, { store }: HookOption = {}) {
  const pStore = useStore()
  const realStore = store || pStore
  const [[state], rerender] = useReducer
    <(prevState: ReducerState<State>) => ReducerState<State>, undefined>
    (valueReducer, undefined, function () {
      return [realStore.getter(atom), realStore, atom] as ReducerState<State>
    })
  useLayoutEffect(() => {
    return realStore.sub(atom, rerender)
  }, [realStore, atom])

  return state
}

export function useAtomValue<State extends InterState = InterState>(
  atom: AtomEntity<State>, { store }: HookOption = {}) {
  const realStore = useStore({ store })

  const [state, setState] = useState(() => {
    return realStore.getter(atom)
  })

  useLayoutEffect(() => {
    // init useLayoutEffect有个过程 过程中值可能变了
    if (realStore.getter(atom) !== state) {
      setState(realStore.getter(atom))
    }
    return realStore.sub(atom, () => {
      setState(realStore.getter(atom))
    })
  }, [realStore, atom])

  return state
}
