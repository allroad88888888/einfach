import { useCallback, useDebugValue, useEffect, useState, useSyncExternalStore } from 'react'
import type { Atom, AtomState } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'
import { isPromiseLike } from '../core/promiseUtils'
import { use } from './use'
import type { StatesWithPromise } from '../core/typePromise'

export function useAtomValue<State>(
  atom: Atom<State>,
  options?: HookOption,
): State extends Promise<infer T> ? T : State
export function useAtomValue<AtomType extends Atom<unknown>>(
  atom: AtomType,
  options?: HookOption,
): AtomState<AtomType>
export function useAtomValue<State>(atom: Atom<State>, options: HookOption = {}) {
  const realStore = useStore(options)
  const [state, setState] = useState(() => {
    return realStore.getter(atom)
  })
  useEffect(() => {
    // init useEffect 过程中值可能变了
    if (realStore.getter(atom) !== state) {
      setState(realStore.getter(atom))
    }
    return realStore.sub(atom, () => {
      if (setState) {
        setState(realStore.getter(atom))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realStore, atom])
  useDebugValue(state)
  if (isPromiseLike(state)) {
    return use(state as StatesWithPromise<State>)
  }
  return state
}

export function useAtomValueWith18<State>(atom: Atom<State>, options: HookOption = {}) {
  const realStore = useStore(options)

  const sub = useCallback(
    (callBack: () => void) => {
      return realStore.sub(atom, callBack)
    },
    [atom, realStore],
  )

  const getSnapshot = useCallback(() => {
    return realStore.getter(atom)
  }, [atom, realStore])

  const value = useSyncExternalStore(sub, getSnapshot)
  useDebugValue(value)

  if (isPromiseLike(value)) {
    return use(value as StatesWithPromise<State>)
  }
  return value
}
