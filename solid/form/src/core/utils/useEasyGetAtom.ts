import { selectAtom } from '@einfach/core'

import type { AtomEntity } from '@einfach/core'
import { HookOption, useAtomValue } from '@einfach/solid'
import { easyGet, easyEqual } from '@einfach/utils'
import type { NamePath } from '@einfach/utils'

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
  const selectAtomEntity = selectEasyAtom<Slice, State>(atomEntity, selectFn, equalityFn)

  return useAtomValue<Slice>(selectAtomEntity, option)
}
