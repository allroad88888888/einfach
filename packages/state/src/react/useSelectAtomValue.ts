import { atom, type AtomEntity } from '../core'
import { useAtomValue } from './useAtomValue'
import type { HookOption } from './type'
import type { NamePath } from 'einfach-utils'
import { easyGet, useInit } from 'einfach-utils'

export function selectAtom<T, State>(
  atomEntity: AtomEntity<State>,
  selectFn: ((prev: State) => T) | NamePath,
) {
  return atom((get) => {
    const info = get(atomEntity)
    if (typeof selectFn === 'function') {
      return selectFn(info)
    }
    return easyGet(info, selectFn)
  }) as AtomEntity<T>
}

export function useSelectAtomValue<T, State>(
  atomEntity: AtomEntity<State>,
  selectFn: (prev: State) => T,
  option?: HookOption
): T
export function useSelectAtomValue<T, State>(
  atomEntity: AtomEntity<State>,
  selectFn: ((prev: State) => T) | NamePath,
  option?: HookOption
): T

export function useSelectAtomValue<T, State>(
  atomEntity: AtomEntity<State>,
  selectFn: ((prev: State) => T) | NamePath,
  option: HookOption = {},
) {
  const selectAtomEntity = useInit(() => {
    return selectAtom<T, State>(atomEntity, selectFn)
  }, [atomEntity, selectFn])

  return useAtomValue<T>(selectAtomEntity, option)
}
