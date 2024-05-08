import { atom, type AtomEntity } from '../core'
import { useAtomValue } from './useAtomValue'
import type { HookOption } from './type'
import { useInit } from 'einfach-utils'

export function selectAtom<T, State>(atomEntity: AtomEntity<State>,
  selectFn: ((prev: State) => T)) {
  return atom((get) => {
    const info = get(atomEntity)
    return selectFn(info)
  })
}

export function useSelectAtomValue<T, State>(
  atomEntity: AtomEntity<State>,
  selectFn: ((prev: State) => T), option: HookOption = {}) {
  const selectAtomEntity = useInit(() => {
    return selectAtom(atomEntity, selectFn)
  }, [atomEntity, selectFn])

  return useAtomValue(selectAtomEntity, option) as T
}
