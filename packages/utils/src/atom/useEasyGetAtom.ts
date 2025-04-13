import { selectAtom, useAtomValue } from '@einfach/state'
import type { HookOption, AtomEntity } from '@einfach/state'
import { easyGet, easyEqual } from './../easyLodash'
import type { NamePath } from '../easyLodash/type'
import { useInit } from './../hooks/useInit'

export function selectEasyAtom<Slice, State>(
  atomEntity: AtomEntity<State>,
  selectFn: NamePath,
  equalityFn: (prev: Slice, next: Slice) => boolean = easyEqual,
) {
  return selectAtom(
    atomEntity,
    (prev) => {
      return easyGet(prev, selectFn) as Slice
    },
    equalityFn,
  )
}

export function useEasySelectAtomValue<Slice, State>(
  atomEntity: AtomEntity<State>,
  selectFn: NamePath,
  equalityFn: (prev: Slice, next: Slice) => boolean = easyEqual,
  option: HookOption = {},
) {
  const selectAtomEntity = useInit(() => {
    return selectEasyAtom<Slice, State>(atomEntity, selectFn, equalityFn)
  }, [atomEntity, selectFn, equalityFn])

  return useAtomValue<Slice>(selectAtomEntity, option)
}
