import type { AtomSetParameters, AtomSetResult, AtomState, WritableAtom } from '../core'
import type { HookOption } from './type'
import { useAtomValue } from './useAtomValue'
import { useSetAtom } from './useSetAtom'

// export interface UseAtom {
//   <State, Args extends unknown[], Result>(
//     atom: WritableAtom<State, Args, Result>, options?: HookOption):
//     [Awaited<State>, (...args: Args) => Result]
//   <AtomType extends WritableAtom<unknown, never[], unknown>>(
//     atom: AtomType, options?: HookOption
//   ): [Awaited<AtomState<AtomType>>,
//       (...args: AtomSetParameters<AtomType>) => AtomSetResult<AtomType>]

// }
export function useAtom<State, Args extends unknown[], Result>(
  atom: WritableAtom<State, Args, Result>,
  options?: HookOption,
): [Awaited<State>, (...args: Args) => Result]
export function useAtom<AtomType extends WritableAtom<unknown, never[], unknown>>(
  atom: AtomType,
  options?: HookOption,
): [Awaited<AtomState<AtomType>>, (...args: AtomSetParameters<AtomType>) => AtomSetResult<AtomType>]
export function useAtom<Entity extends WritableAtom<unknown, never[], unknown>>(
  atomEntity: Entity,
  options: HookOption = {},
): [Awaited<AtomState<Entity>>, (...args: AtomSetParameters<Entity>) => AtomSetResult<Entity>] {
  return [
    useAtomValue(atomEntity, options) as Awaited<AtomState<Entity>>,
    useSetAtom(atomEntity, options) as (
      ...args: AtomSetParameters<Entity>
    ) => AtomSetResult<Entity>,
  ]
}
