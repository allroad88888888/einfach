import { useEffect, useReducer, useState } from 'react'
import type { AtomEntity, InterState, Store } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'

type ReducerState<State extends InterState = InterState> = [State, Store, AtomEntity<State>]

function valueReducer<State extends InterState = InterState>(
  prev: ReducerState<State>): ReducerState<State> {
  const [state, store, atomEntity] = prev
  const nextValue = (store as Store).get(atomEntity)
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
      return [realStore.get(atom), realStore, atom] as ReducerState<State>
    })
  useEffect(() => {
    return realStore.sub(atom, rerender)
  }, [realStore, atom])

  return state
}

export function useAtomValue<State extends InterState = InterState>(
  atom: AtomEntity<State>, { store }: HookOption = {}) {
  const pStore = useStore()
  const realStore = store || pStore

  const [state, setState] = useState(() => {
    return realStore.get(atom)
  })

  useEffect(() => {
    return realStore.sub(atom, () => {
      setState(realStore.get(atom))
    })
  }, [realStore, atom])

  return state
}
