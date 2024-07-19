import { useLayoutEffect, useState } from 'react'
import type { AtomEntity } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'
import { isPromiseLike } from '../core/promiseUtils'
import { use } from './use'
import type { StatesWithPromise } from '../core/typePromise'

export function useAtomValue<State>(
  atom: AtomEntity<State>, { store }: HookOption = {}): State extends Promise<infer T> ? T : State {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realStore, atom])

  if (isPromiseLike(state)) {
    return use(state as StatesWithPromise<State>) as State extends Promise<infer T> ? T : State
  }

  return state as State extends Promise<infer T> ? T : State
}
