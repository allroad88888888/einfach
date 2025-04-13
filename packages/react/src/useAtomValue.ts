import type { ReducerWithoutAction } from 'react'
import { useCallback, useDebugValue, useEffect, useReducer, useSyncExternalStore } from 'react'
import type { Atom, AtomState, Store } from '@einfach/core'
import type { HookOption } from './type'
import { useStore } from './useStore'
import { isPromiseLike } from '@einfach/core'
import { use } from './use'
import type { StatesWithPromise } from '@einfach/core'

export function useAtomValue17<State>(
  atom: Atom<State>,
  options?: HookOption,
): State extends Promise<infer T> ? T : State
export function useAtomValue17<AtomType extends Atom<unknown>>(
  atom: AtomType,
  options?: HookOption,
): AtomState<AtomType>
export function useAtomValue17<State>(atom: Atom<State>, options: HookOption = {}) {
  const store = useStore(options)
  type ReducerState = [State, Store, Atom<State>]
  const [[valueFromReducer, storeFromReducer, atomFromReducer], rerender] = useReducer<
    ReducerWithoutAction<ReducerState>,
    undefined
  >(
    function (prev: ReducerState) {
      const nextValue = store.getter(atom)
      if (Object.is(nextValue, prev[0]) && store === prev[1] && atom === prev[2]) {
        return prev as ReducerState
      }
      return [nextValue, store, atom] as ReducerState
    },
    undefined,
    function () {
      return [store.getter(atom), store, atom] as ReducerState
    },
  )
  let value: State = valueFromReducer
  if (storeFromReducer !== store || atomFromReducer !== atom) {
    value = store.getter(atom) as State
    rerender()
  }
  useEffect(() => {
    const unSub = store.sub(atom, () => {
      rerender()
    })
    // 点睛之笔
    rerender()
    return unSub
  }, [store, atom])

  useDebugValue(value)
  if (isPromiseLike(value)) {
    return use(value as StatesWithPromise<State>)
  }
  return value
}

export function useAtomValueWith18<State>(
  atom: Atom<State>,
  options?: HookOption,
): State extends Promise<infer T> ? T : State
export function useAtomValueWith18<AtomType extends Atom<unknown>>(
  atom: AtomType,
  options?: HookOption,
): AtomState<AtomType>
export function useAtomValueWith18<State>(atom: Atom<State>, options: HookOption = {}) {
  const store = useStore(options)

  const sub = useCallback(
    (callBack: () => void) => {
      return store.sub(atom, callBack)
    },
    [atom, store],
  )

  const getSnapshot = useCallback(() => {
    return store.getter(atom)
  }, [atom, store])

  const value = useSyncExternalStore(sub, getSnapshot)
  useDebugValue(value)

  if (isPromiseLike(value)) {
    return use(value as StatesWithPromise<State>)
  }
  return value
}

// @ts-ignore
export const useAtomValue = useSyncExternalStore ? useAtomValueWith18 : useAtomValue17
