import { useCallback } from 'react'
import type { AtomSetParameters, AtomSetResult, WritableAtom } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'

export interface SetAtomMethod {
  <State, Args extends unknown[], Result>(
    atom: WritableAtom<State, Args, Result>,
    options?: HookOption,
  ): (...args: Args) => Result
  <AtomType extends WritableAtom<unknown, never[], unknown>>(
    atom: AtomType,
    options?: HookOption,
  ): (...args: AtomSetParameters<AtomType>) => AtomSetResult<AtomType>
}

export function useSetAtom<State, Args extends unknown[], Result>(
  atom: WritableAtom<State, Args, Result>,
  options?: HookOption,
): (...args: Args) => Result
export function useSetAtom<AtomType extends WritableAtom<unknown, never[], unknown>>(
  atom: AtomType,
  options?: HookOption,
): (...args: AtomSetParameters<AtomType>) => AtomSetResult<AtomType>
export function useSetAtom<Entity extends WritableAtom<unknown, never[], unknown>>(
  atomEntity: Entity,
  option: HookOption = {},
) {
  const store = useStore(option)
  return useCallback(
    function (...args: AtomSetParameters<Entity>) {
      return store.setter(atomEntity, ...args)
    },
    [atomEntity, store],
  )!
}
